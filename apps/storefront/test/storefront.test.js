import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createService, HealthRegistry, AppError, createChaosController } from '@shopstack/telemetry';
import { silentLogger, testConfig, testMetrics } from '@shopstack/telemetry/testing';
import { registerRoutes, tokenize } from '../src/routes.js';
import { money, esc } from '../src/ui.js';
import { productArtwork } from '../src/media.js';

const config = testConfig({ SERVICE_NAME: 'storefront', COOKIE_SECURE: false });

const PRODUCTS = [
  {
    id: 'sku-1001',
    slug: 'atlas-anc-headphones',
    name: 'Atlas ANC Headphones',
    description: 'Adaptive noise cancelling over-ears.',
    category: 'audio',
    priceCents: 27900,
    currency: 'USD',
    stock: 42,
    rating: 4.8,
    reviewCount: 1284,
    tags: ['wireless'],
    featured: true,
    inStock: true,
    image: '/media/atlas-anc-headphones.svg',
  },
  {
    id: 'sku-1008',
    slug: 'glide-ergonomic-mouse',
    name: 'Glide Ergonomic Mouse',
    description: 'Vertical grip mouse.',
    category: 'workspace',
    priceCents: 7900,
    currency: 'USD',
    stock: 0,
    rating: 4.3,
    reviewCount: 288,
    tags: ['ergonomic'],
    featured: false,
    inStock: false,
    image: '/media/glide-ergonomic-mouse.svg',
  },
];

const TOTALS = { itemCount: 1, subtotalCents: 27900, shippingCents: 0, taxCents: 2302, totalCents: 30202, currency: 'USD', freeShippingThresholdCents: 7500, amountToFreeShippingCents: 0 };

/** Fixture-driven stand-ins for the three downstream APIs. */
function makeClients({ failCatalog = false, checkoutError = null } = {}) {
  const state = { cart: null, orders: new Map(), calls: [] };

  const catalog = {
    get: async (path, opts) => {
      state.calls.push(`catalog:${path}`);
      if (failCatalog) throw new AppError({ title: 'Upstream dependency failed', status: 502, code: 'upstream-catalog-unreachable' });
      if (path === '/api/products') {
        const q = opts?.query?.q?.toLowerCase();
        const category = opts?.query?.category;
        let items = PRODUCTS;
        if (category) items = items.filter((p) => p.category === category);
        if (q) items = items.filter((p) => `${p.name} ${p.description}`.toLowerCase().includes(q));
        return { items, total: items.length, limit: 24, offset: 0, nextOffset: null };
      }
      if (path === '/api/categories') {
        return { items: [{ slug: 'audio', name: 'Audio', count: 1 }, { slug: 'workspace', name: 'Workspace', count: 1 }] };
      }
      if (path.endsWith('/related')) return { items: [PRODUCTS[1]] };
      const slug = decodeURIComponent(path.split('/').pop());
      const product = PRODUCTS.find((p) => p.slug === slug || p.id === slug);
      if (!product) throw new AppError({ title: 'Product not found', status: 404, code: 'not-found' });
      return product;
    },
  };

  const cart = {
    get: async (path) => {
      state.calls.push(`cart:GET ${path}`);
      if (!state.cart) throw new AppError({ title: 'Cart not found', status: 404, code: 'not-found' });
      return state.cart;
    },
    post: async (path, body) => {
      state.calls.push(`cart:POST ${path}`);
      if (path.endsWith('/items')) {
        if (!state.cart) {
          state.cart = { cart: { id: 'cart-1', status: 'open', currency: 'USD', items: [] }, totals: { ...TOTALS, itemCount: 0, subtotalCents: 0, taxCents: 0, totalCents: 0 } };
        }
        const product = PRODUCTS.find((p) => p.id === body.productId);
        if (!product) throw new AppError({ title: 'Product not found', status: 404, code: 'not-found' });
        if (body.quantity > product.stock) {
          throw new AppError({ title: 'Not enough stock', status: 409, code: 'insufficient-stock', detail: `only ${product.stock} units` });
        }
        const existing = state.cart.cart.items.find((i) => i.productId === body.productId);
        if (existing) existing.quantity += body.quantity;
        else
          state.cart.cart.items.push({
            id: `itm-${product.id}`,
            productId: product.id,
            slug: product.slug,
            name: product.name,
            image: product.image,
            unitPriceCents: product.priceCents,
            quantity: body.quantity,
          });
        state.cart.totals = { ...TOTALS, itemCount: state.cart.cart.items.reduce((n, i) => n + i.quantity, 0) };
        return state.cart;
      }
      return { ok: true };
    },
    patch: async () => ({ ok: true }),
    delete: async () => ({ ok: true }),
  };

  const checkout = {
    post: async (path, body) => {
      state.calls.push(`checkout:POST ${path}`);
      if (checkoutError) throw checkoutError;
      const order = {
        id: 'ord_test_1',
        status: 'confirmed',
        customer: body.customer,
        shippingAddress: body.shippingAddress,
        items: [{ productId: 'sku-1001', name: 'Atlas ANC Headphones', image: '/media/x.svg', unitPriceCents: 27900, quantity: 1, lineTotalCents: 27900 }],
        pricing: TOTALS,
        payment: { id: 'pay_1', status: 'captured', method: { type: 'card' }, provider: { last4: '4242' } },
        timeline: [{ step: 'load_cart', status: 'succeeded', at: '2026-10-27T10:00:00.000Z' }],
        createdAt: '2026-10-27T10:00:00.000Z',
      };
      state.orders.set(order.id, order);
      return order;
    },
    get: async (path) => {
      const id = decodeURIComponent(path.split('/').pop());
      const order = state.orders.get(id);
      if (!order) throw new AppError({ title: 'Order not found', status: 404, code: 'not-found' });
      return order;
    },
  };

  return { catalog, cart, checkout, state };
}

async function buildApp(clientOptions) {
  const metrics = testMetrics('storefront');
  const clients = makeClients(clientOptions);
  const health = new HealthRegistry();
  const service = await createService({
    config,
    metrics,
    logger: silentLogger(),
    health,
    chaos: createChaosController({ enabled: false }),
    security: { frameOptions: false },
    routes: (app) => registerRoutes({ app, metrics, config, catalogClient: clients.catalog, cartClient: clients.cart, checkoutClient: clients.checkout }),
  });
  service.markReady();
  return { ...service, clients };
}

let ctx;
before(async () => {
  ctx = await buildApp();
});
after(async () => {
  await ctx.app.close();
});

describe('pages', () => {
  test('renders the home page with products and a cart badge', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /Atlas ANC Headphones/);
    assert.match(res.body, /ShopStack/);
    assert.match(res.body, /data-cart-count/);
    assert.match(res.body, /v0.0.0-test/, 'footer exposes the running version for canary demos');
    assert.match(String(res.headers['set-cookie']), /ss_cart=cart-/);
  });

  test('renders a category page', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/category/audio' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Atlas ANC Headphones/);
    assert.doesNotMatch(res.body, /Glide Ergonomic Mouse/);
  });

  test('renders search results, including empty states', async () => {
    const hit = await ctx.app.inject({ method: 'GET', url: '/search?q=mouse' });
    assert.match(hit.body, /Glide Ergonomic Mouse/);

    const miss = await ctx.app.inject({ method: 'GET', url: '/search?q=zzzz' });
    assert.equal(miss.statusCode, 200);
    assert.match(miss.body, /No products matched/);
  });

  test('renders a product page with the add-to-bag form', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/product/atlas-anc-headphones' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Add to bag/);
    assert.match(res.body, /data-add-to-cart/);
  });

  test('marks sold-out products as unavailable instead of offering a dead button', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/product/glide-ergonomic-mouse' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Sold out/);
    assert.doesNotMatch(res.body, /Add to bag/);
  });

  test('renders a 404 page for unknown products', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/product/does-not-exist' });
    assert.equal(res.statusCode, 404);
    assert.match(res.body, /404/);
    assert.match(res.body, /Back to the shop/);
  });

  test('renders a styled 503 when the catalog is down', async () => {
    const broken = await buildApp({ failCatalog: true });
    const res = await broken.app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['retry-after'], '5');
    assert.match(res.body, /having a moment/);
    assert.match(res.body, /Reference:/);
    await broken.app.close();
  });
});

describe('cart flow', () => {
  test('adds an item with JavaScript (JSON) and reports the new count', async () => {
    const app = await buildApp();
    const res = await app.app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { accept: 'application/json' },
      payload: { productId: 'sku-1001', quantity: 2 },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().itemCount, 2);
    assert.match(res.json().message, /added to your bag/);
    assert.match(String(res.headers['set-cookie']), /ss_cart=/);
    await app.app.close();
  });

  test('adds an item without JavaScript (303 redirect)', async () => {
    const app = await buildApp();
    const res = await app.app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { cookie: 'ss_cart=cart-existing' },
      payload: { productId: 'sku-1001', quantity: 1, returnTo: '/product/atlas-anc-headphones' },
    });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/product/atlas-anc-headphones');
    await app.app.close();
  });

  test('ignores off-site returnTo values (open-redirect guard)', async () => {
    const app = await buildApp();
    const res = await app.app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { cookie: 'ss_cart=cart-existing' },
      payload: { productId: 'sku-1001', quantity: 1, returnTo: '//evil.example.com/phish' },
    });
    assert.equal(res.headers.location, '/cart');
    await app.app.close();
  });

  test('surfaces stock conflicts as a notice instead of a crash', async () => {
    const app = await buildApp();
    const res = await app.app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { cookie: 'ss_cart=cart-existing' },
      payload: { productId: 'sku-1001', quantity: 99 },
    });
    assert.equal(res.statusCode, 303);
    assert.match(res.headers.location, /notice=only%2042%20units/);
    await app.app.close();
  });

  test('renders an empty bag', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/cart' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Your bag is empty/);
  });
});

describe('checkout flow', () => {
  test('redirects to the bag when there is nothing to buy', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/checkout' });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/cart');
  });

  test('renders the checkout form with an idempotency key', async () => {
    const app = await buildApp();
    await app.app.inject({ method: 'POST', url: '/cart/items', headers: { cookie: 'ss_cart=cart-co' }, payload: { productId: 'sku-1001', quantity: 1 } });
    const res = await app.app.inject({ method: 'GET', url: '/checkout', headers: { cookie: 'ss_cart=cart-co' } });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /name="idempotencyKey" value="checkout-/);
    assert.match(res.body, /4242 4242 4242 4242/);
    await app.app.close();
  });

  test('places an order and redirects to the confirmation page', async () => {
    const app = await buildApp();
    await app.app.inject({ method: 'POST', url: '/cart/items', headers: { cookie: 'ss_cart=cart-co2' }, payload: { productId: 'sku-1001', quantity: 1 } });
    const res = await app.app.inject({
      method: 'POST',
      url: '/checkout',
      headers: { cookie: 'ss_cart=cart-co2' },
      payload: {
        idempotencyKey: 'checkout-abc',
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        line1: '12 Analytical Way',
        city: 'London',
        postalCode: 'EC1A',
        country: 'GB',
        cardNumber: '4242 4242 4242 4242',
      },
    });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/orders/ord_test_1?new=1');
    await app.app.close();
  });

  test('re-renders the form with a friendly message when the card is declined', async () => {
    const app = await buildApp({
      checkoutError: new AppError({ title: 'Payment declined', status: 402, code: 'payment-declined' }),
    });
    await app.app.inject({ method: 'POST', url: '/cart/items', headers: { cookie: 'ss_cart=cart-decl' }, payload: { productId: 'sku-1001', quantity: 1 } });
    const res = await app.app.inject({
      method: 'POST',
      url: '/checkout',
      headers: { cookie: 'ss_cart=cart-decl' },
      payload: { idempotencyKey: 'checkout-decl', email: 'a@b.co', name: 'A', line1: 'x street', city: 'London', postalCode: 'EC1', country: 'GB', cardNumber: '4000 0000 0000 0002' },
    });
    assert.equal(res.statusCode, 402);
    assert.match(res.body, /Your card was declined/);
    assert.match(res.body, /No money was taken/);
    await app.app.close();
  });

  test('renders the order confirmation with a timeline', async () => {
    const app = await buildApp();
    await app.app.inject({ method: 'POST', url: '/cart/items', headers: { cookie: 'ss_cart=cart-ord' }, payload: { productId: 'sku-1001', quantity: 1 } });
    await app.app.inject({
      method: 'POST',
      url: '/checkout',
      headers: { cookie: 'ss_cart=cart-ord' },
      payload: { idempotencyKey: 'checkout-ord', email: 'a@b.co', name: 'A', line1: 'x street', city: 'London', postalCode: 'EC1', country: 'GB', cardNumber: '4242424242424242' },
    });
    const res = await app.app.inject({ method: 'GET', url: '/orders/ord_test_1' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /order is confirmed/);
    assert.match(res.body, /Order journey/);
    assert.match(res.body, /Total paid/);
    await app.app.close();
  });

  test('offers the lookup form for an unknown order', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/orders/ord_unknown' });
    assert.equal(res.statusCode, 404);
    assert.match(res.body, /could not find an order/);
  });
});

describe('assets and headers', () => {
  test('serves the stylesheet and script with long-lived caching', async () => {
    const css = await ctx.app.inject({ method: 'GET', url: '/assets/app.css' });
    assert.equal(css.statusCode, 200);
    assert.match(css.headers['content-type'], /text\/css/);
    assert.match(css.headers['cache-control'], /max-age/);
    assert.match(css.body, /--accent/);

    const js = await ctx.app.inject({ method: 'GET', url: '/assets/app.js' });
    assert.match(js.headers['content-type'], /javascript/);
  });

  test('generates product artwork as SVG', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/media/atlas-anc-headphones.svg' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /image\/svg\+xml/);
    assert.match(res.body, /<svg/);
    assert.match(res.body, /AN/, 'initials are rendered into the artwork');
  });

  test('sends a strict CSP and does not block framing', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/' });
    assert.match(res.headers['content-security-policy'], /default-src 'self'/);
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(res.headers['x-frame-options'], undefined);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  test('exposes storefront metrics', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/metrics' });
    assert.match(res.body, /shopstack_storefront_page_renders_total/);
    assert.match(res.body, /shopstack_storefront_render_duration_seconds/);
  });
});

describe('helpers', () => {
  test('formats money from integer cents', () => {
    assert.equal(money(27900), '$279.00');
    assert.equal(money(0), '$0.00');
    assert.equal(money(5), '$0.05');
  });

  test('escapes untrusted values', () => {
    assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(esc('"quoted" & \'single\''), '&quot;quoted&quot; &amp; &#39;single&#39;');
  });

  test('tokenises card numbers and honours test tokens', () => {
    assert.equal(tokenize('4242 4242 4242 4242'), 'tok_visa_4242');
    assert.equal(tokenize('4000 0000 0000 0002'), 'tok_declined');
    assert.equal(tokenize('tok_fraud'), 'tok_fraud');
  });

  test('product artwork is deterministic and escaped', () => {
    const a = productArtwork({ slug: 'a', name: 'A', category: 'audio' });
    const b = productArtwork({ slug: 'a', name: 'A', category: 'audio' });
    assert.equal(a, b);
    assert.match(productArtwork({ slug: 'x', name: '<b>Hi</b>', category: 'home' }), /&lt;b&gt;Hi&lt;\/b&gt;/);
  });
});
