/**
 * Storefront HTTP routes — the only public entry point of the platform.
 *
 * The storefront is a **back-end for front-end**: it renders HTML on the server and
 * proxies the customer's intent to the cart, catalog and checkout APIs. It owns no
 * state, so it scales horizontally and rolls out with Argo Rollouts like any other
 * stateless service.
 *
 * Resilience rules applied here:
 *   - a slow or failing catalog never blocks the cart (independent clients);
 *   - downstream failures render a styled 503 with `Retry-After` instead of a
 *     stack trace, and are counted in metrics so the canary analysis notices;
 *   - every mutating form works without JavaScript (POST → redirect → GET).
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '@shopstack/telemetry';
import { heroArtwork, productArtwork } from './media.js';
import {
  renderCart,
  renderCatalog,
  renderCheckout,
  renderError,
  renderHome,
  renderOrder,
  renderOrderLookup,
  renderProduct,
} from './pages.js';
import { esc } from './ui.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

export async function registerRoutes({ app, metrics, config, catalogClient, cartClient, checkoutClient }) {
  // HTML forms post `application/x-www-form-urlencoded`; Fastify only parses JSON
  // out of the box. Registered here (not globally) because only the storefront
  // serves forms.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body)));
    } catch (err) {
      err.statusCode = 400;
      done(err);
    }
  });

  const assetCache = new Map();

  const pageRenders = metrics.counter('shopstack_storefront_page_renders_total', 'Server-rendered pages.', [
    'page',
    'status',
  ]);
  const renderDuration = metrics.histogram(
    'shopstack_storefront_render_duration_seconds',
    'Server-side render time per page.',
    ['page'],
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  );
  const addToCartTotal = metrics.counter('shopstack_storefront_add_to_cart_total', 'Add-to-bag actions.', ['result']);
  const checkoutStarted = metrics.counter('shopstack_storefront_checkout_started_total', 'Checkout pages served.');
  const checkoutCompleted = metrics.counter('shopstack_storefront_checkout_completed_total', 'Checkouts submitted.', [
    'result',
  ]);
  const downstreamErrors = metrics.counter(
    'shopstack_storefront_downstream_errors_total',
    'Downstream failures surfaced to the UI.',
    ['dependency'],
  );

  const view = {
    version: config.SERVICE_VERSION,
    environment: config.DEPLOYMENT_ENVIRONMENT,
  };

  /** Times the render and records the outcome. */
  async function render(page, reply, build) {
    const started = process.hrtime.bigint();
    try {
      const html = await build();
      renderDuration.labels(page).observe(Number(process.hrtime.bigint() - started) / 1e9);
      pageRenders.labels(page, 'ok').inc();
      reply.type('text/html; charset=utf-8');
      reply.header('cache-control', 'no-store');
      return html;
    } catch (err) {
      renderDuration.labels(page).observe(Number(process.hrtime.bigint() - started) / 1e9);
      pageRenders.labels(page, 'error').inc();
      throw err;
    }
  }

  // ── Cookies (no plugin: one cookie, three lines) ──────────────────────────
  function parseCookies(header = '') {
    return Object.fromEntries(
      header
        .split(';')
        .map((part) => part.trim().split('='))
        .filter(([key, value]) => key && value !== undefined)
        .map(([key, value]) => [key, decodeURIComponent(value)]),
    );
  }

  function ensureCartId(request, reply) {
    const cookies = parseCookies(request.headers.cookie);
    if (cookies.ss_cart) return cookies.ss_cart;
    const cartId = `cart-${randomUUID()}`;
    const secure = config.COOKIE_SECURE ? '; Secure' : '';
    reply.header('set-cookie', `ss_cart=${cartId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`);
    return cartId;
  }

  async function loadCart(cartId) {
    try {
      return await cartClient.get(`/api/carts/${encodeURIComponent(cartId)}`);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  // ── Static assets ─────────────────────────────────────────────────────────
  async function serveAsset(reply, filename) {
    const safeName = path.basename(filename);
    if (!assetCache.has(safeName)) {
      const body = await readFile(path.join(PUBLIC_DIR, safeName));
      assetCache.set(safeName, body);
    }
    const body = assetCache.get(safeName);
    reply.header('content-type', CONTENT_TYPES[path.extname(safeName)] ?? 'application/octet-stream');
    reply.header('cache-control', 'public, max-age=3600');
    reply.header('content-length', body.length);
    return body;
  }

  app.get('/assets/:file', async (request, reply) => serveAsset(reply, request.params.file));

  app.get('/favicon.svg', async (_request, reply) => {
    reply.header('content-type', 'image/svg+xml');
    reply.header('cache-control', 'public, max-age=86400');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#16130f"/><text x="32" y="44" font-family="Georgia, serif" font-size="34" fill="#fbf9f5" text-anchor="middle">S</text></svg>`;
  });

  app.get('/robots.txt', async (_request, reply) => {
    reply.type('text/plain');
    return 'User-agent: *\nAllow: /\nDisallow: /cart\nDisallow: /checkout\nDisallow: /orders/\n';
  });

  // ── Product artwork ───────────────────────────────────────────────────────
  app.get('/media/hero.svg', async (_request, reply) => {
    reply.header('content-type', 'image/svg+xml');
    reply.header('cache-control', 'public, max-age=86400, immutable');
    return heroArtwork();
  });

  app.get('/media/:slug.svg', async (request, reply) => {
    const slug = request.params.slug;
    reply.header('content-type', 'image/svg+xml');
    reply.header('cache-control', 'public, max-age=86400, immutable');
    try {
      const product = await catalogClient.get(`/api/products/${encodeURIComponent(slug)}`);
      return productArtwork(product);
    } catch {
      return productArtwork({ slug, name: slug.replaceAll('-', ' '), category: 'accessories' });
    }
  });

  // ── Home ──────────────────────────────────────────────────────────────────
  app.get('/', async (request, reply) => {
    const cartId = ensureCartId(request, reply);
    return render('home', reply, async () => {
      const [catalog, cart] = await Promise.all([
        catalogClient.get('/api/products', { query: { limit: 24, sort: 'rating' } }),
        loadCart(cartId).catch(() => null),
      ]);
      return renderHome({
        ...view,
        products: catalog.items,
        featured: catalog.items.filter((p) => p.featured),
        cartCount: cart?.totals?.itemCount ?? 0,
      });
    });
  });

  // ── Search & categories ───────────────────────────────────────────────────
  app.get('/search', async (request, reply) => {
    const cartId = ensureCartId(request, reply);
    const q = (request.query.q ?? '').slice(0, 120);
    return render('search', reply, async () => {
      const [catalog, categories, cart] = await Promise.all([
        catalogClient.get('/api/products', { query: { q, limit: 48 } }),
        catalogClient.get('/api/categories'),
        loadCart(cartId).catch(() => null),
      ]);
      return renderCatalog({
        ...view,
        heading: q ? `Results for “${esc(q)}”` : 'Everything we make',
        subheading: 'Search',
        products: catalog.items,
        categories: categories.items,
        query: q,
        offset: 0,
        limit: 48,
        total: catalog.total,
        cartCount: cart?.totals?.itemCount ?? 0,
      });
    });
  });

  app.get('/category/:slug', async (request, reply) => {
    const cartId = ensureCartId(request, reply);
    const slug = request.params.slug;
    const offset = Number.parseInt(request.query.offset ?? '0', 10) || 0;
    return render('category', reply, async () => {
      const [catalog, categories, cart] = await Promise.all([
        catalogClient.get('/api/products', { query: { category: slug, limit: 24, offset } }),
        catalogClient.get('/api/categories'),
        loadCart(cartId).catch(() => null),
      ]);
      const category = categories.items.find((c) => c.slug === slug);
      return renderCatalog({
        ...view,
        heading: category?.name ?? slug,
        subheading: 'Collection',
        products: catalog.items,
        categories: categories.items,
        activeCategory: slug,
        offset,
        limit: 24,
        total: catalog.total,
        cartCount: cart?.totals?.itemCount ?? 0,
      });
    });
  });

  // ── Product detail ────────────────────────────────────────────────────────
  app.get('/product/:slug', async (request, reply) => {
    const cartId = ensureCartId(request, reply);
    return render('product', reply, async () => {
      const [product, cart] = await Promise.all([
        catalogClient.get(`/api/products/${encodeURIComponent(request.params.slug)}`),
        loadCart(cartId).catch(() => null),
      ]).catch((err) => {
        if (err.status === 404) throw err;
        downstreamErrors.labels('catalog').inc();
        throw err;
      });
      const related = await catalogClient
        .get(`/api/products/${encodeURIComponent(product.id)}/related`, { query: { limit: 4 } })
        .catch(() => ({ items: [] }));
      return renderProduct({ ...view, product, related: related.items, cartCount: cart?.totals?.itemCount ?? 0 });
    });
  });

  // ── Cart ──────────────────────────────────────────────────────────────────
  app.get('/cart', async (request, reply) => {
    const cartId = ensureCartId(request, reply);
    return render('cart', reply, async () => {
      const cart = await loadCart(cartId);
      if (!cart) {
        return renderCart({ ...view, cart: null, totals: null, cartCount: 0, notice: request.query.notice });
      }
      return renderCart({
        ...view,
        cart: cart.cart,
        totals: cart.totals,
        cartCount: cart.totals.itemCount,
        notice: request.query.notice,
      });
    });
  });

  app.post('/cart/items', async (request, reply) => {
    const cartId = ensureCartId(request, reply);
    const wantsJson = (request.headers.accept ?? '').includes('application/json');
    const body = request.body ?? {};
    const productId = body.productId;
    const quantity = Number.parseInt(body.quantity ?? '1', 10) || 1;

    try {
      const result = await cartClient.post(`/api/carts/${encodeURIComponent(cartId)}/items`, { productId, quantity });
      addToCartTotal.labels('success').inc();
      if (wantsJson) {
        return reply.code(200).send({
          itemCount: result.totals.itemCount,
          message: `${result.cart.items.at(-1)?.name ?? 'Item'} added to your bag`,
        });
      }
      return reply.redirect(body.returnTo ? safeReturnTo(body.returnTo) : '/cart', 303);
    } catch (err) {
      addToCartTotal.labels('failure').inc();
      if (err.status && err.status < 500) {
        if (wantsJson) return reply.code(err.status).type('application/problem+json').send(err.toProblem(request.id));
        return reply.redirect(`/cart?notice=${encodeURIComponent(err.detail ?? err.title)}`, 303);
      }
      downstreamErrors.labels('cart').inc();
      throw err;
    }
  });

  app.post('/cart/items/:itemId', async (request, reply) => {
    const cartId = ensureCartId(request, reply);
    const quantity = Number.parseInt(request.body?.quantity ?? '1', 10);
    await cartClient.patch(
      `/api/carts/${encodeURIComponent(cartId)}/items/${encodeURIComponent(request.params.itemId)}`,
      {
        quantity: Number.isFinite(quantity) ? quantity : 1,
      },
    );
    return reply.redirect('/cart', 303);
  });

  app.post('/cart/items/:itemId/remove', async (request, reply) => {
    const cartId = ensureCartId(request, reply);
    await cartClient.delete(
      `/api/carts/${encodeURIComponent(cartId)}/items/${encodeURIComponent(request.params.itemId)}`,
    );
    return reply.redirect('/cart', 303);
  });

  // ── Checkout ──────────────────────────────────────────────────────────────
  app.get('/checkout', async (request, reply) => {
    const cartId = ensureCartId(request, reply);
    checkoutStarted.inc();
    return render('checkout', reply, async () => {
      const cart = await loadCart(cartId);
      if (!cart || cart.cart.items.length === 0) return reply.redirect('/cart', 303);
      return renderCheckout({
        ...view,
        cart: cart.cart,
        totals: cart.totals,
        idempotencyKey: `checkout-${randomUUID()}`,
        customer: {},
      });
    });
  });

  app.post('/checkout', async (request, reply) => {
    const cartId = ensureCartId(request, reply);
    const form = request.body ?? {};
    const idempotencyKey = String(form.idempotencyKey || `checkout-${randomUUID()}`);
    const cart = await loadCart(cartId);
    if (!cart || cart.cart.items.length === 0) return reply.redirect('/cart', 303);

    try {
      const order = await checkoutClient.post(
        '/api/checkout',
        {
          cartId,
          customer: { email: form.email, name: form.name },
          shippingAddress: {
            line1: form.line1,
            line2: form.line2 || undefined,
            city: form.city,
            state: form.state || undefined,
            postalCode: form.postalCode,
            country: form.country,
          },
          paymentMethod: { type: 'card', token: tokenize(form.cardNumber) },
        },
        { idempotencyKey },
      );
      checkoutCompleted.labels('success').inc();
      return reply.redirect(`/orders/${order.id}?new=1`, 303);
    } catch (err) {
      checkoutCompleted.labels('failure').inc();
      request.log.warn({ err, code: err.code }, 'checkout failed');
      const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 503;
      return reply
        .code(status)
        .type('text/html; charset=utf-8')
        .send(
          await renderCheckout({
            ...view,
            cart: cart.cart,
            totals: cart.totals,
            idempotencyKey,
            customer: { email: form.email, name: form.name },
            error: {
              title: err.code === 'payment-declined' ? 'Your card was declined' : 'We could not complete your order',
              message:
                err.code === 'payment-declined'
                  ? 'No money was taken and your bag is untouched. Try another card or use the test card 4242 4242 4242 4242.'
                  : `${err.detail ?? err.title}. Nothing was charged. Please try again.`,
            },
          }),
        );
    }
  });

  // ── Orders ────────────────────────────────────────────────────────────────
  app.get('/orders/lookup', async (request, reply) => {
    const orderId = request.query.orderId?.trim();
    if (orderId) return reply.redirect(`/orders/${encodeURIComponent(orderId)}`, 302);
    return render('order-lookup', reply, async () => renderOrderLookup({ ...view, orderId: '' }));
  });

  app.get('/orders/:orderId', async (request, reply) => {
    return render('order', reply, async () => {
      try {
        const order = await checkoutClient.get(`/api/orders/${encodeURIComponent(request.params.orderId)}`);
        return renderOrder({ ...view, order });
      } catch (err) {
        if (err.status === 404) {
          return reply
            .code(404)
            .type('text/html; charset=utf-8')
            .send(
              renderOrderLookup({
                ...view,
                orderId: request.params.orderId,
                error: 'We could not find an order with that number.',
              }),
            );
        }
        throw err;
      }
    });
  });

  // ── Error handling for HTML routes ────────────────────────────────────────
  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof AppError ? error.status : (error.statusCode ?? 500);
    request.log.error({ err: error, code: error.code }, 'storefront request failed');
    const dependency = /-(catalog|cart|checkout|payments)/.exec(error.code ?? '')?.[1];
    if (dependency) downstreamErrors.labels(dependency).inc();

    const html = renderError({
      ...view,
      status: status >= 500 ? 503 : status,
      title: status >= 500 ? 'The shop is having a moment' : (error.title ?? 'Not found'),
      message:
        status >= 500
          ? 'We could not reach one of our services. Your bag is safe — please try again in a few seconds.'
          : (error.detail ?? error.title),
      traceId: request.id,
    });

    reply.code(status >= 500 ? 503 : status).type('text/html; charset=utf-8');
    if (status >= 500) reply.header('retry-after', '5');
    return html;
  });

  // Security headers: strict CSP (no inline script/style), but frame-able so the
  // storefront can be embedded in the platform's preview iframe.
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header(
      'content-security-policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'",
    );
    return payload;
  });
}

/** Only ever redirect to a local path — prevents open-redirect abuse. */
function safeReturnTo(value) {
  const candidate = String(value);
  return candidate.startsWith('/') && !candidate.startsWith('//') ? candidate : '/cart';
}

/**
 * Card tokenisation stand-in. In production this is Stripe Elements / Adyen
 * Drop-in running in an iframe; here we map test numbers to processor tokens.
 * The PAN is never logged and never leaves this function except as a token.
 */
export function tokenize(cardNumber) {
  const digits = String(cardNumber ?? '').replace(/\D/g, '');
  if (String(cardNumber).startsWith('tok_')) return String(cardNumber);
  if (digits.endsWith('0002')) return 'tok_declined';
  if (digits.endsWith('0003')) return 'tok_fraud';
  return `tok_visa_${digits.slice(-4) || '4242'}`;
}
