import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createService, HealthRegistry, AppError, createChaosController } from '@shopstack/telemetry';
import { silentLogger, testConfig, testMetrics, expectProblem } from '@shopstack/telemetry/testing';
import { MemoryCartRepository } from '../src/repository.js';
import { calculateTotals, emptyCart, mergeCarts, addItem } from '../src/cart.js';
import { registerRoutes } from '../src/routes.js';

const config = testConfig({
  SERVICE_NAME: 'cart-service',
  CART_DRIVER: 'memory',
  TAX_RATE_BPS: 825,
  SHIPPING_FEE_CENTS: 599,
  FREE_SHIPPING_THRESHOLD_CENTS: 7500,
});

const FIXTURES = {
  'sku-1001': { id: 'sku-1001', slug: 'atlas-anc-headphones', name: 'Atlas ANC Headphones', priceCents: 27900, currency: 'USD', stock: 42, image: '/media/atlas.svg' },
  'sku-1014': { id: 'sku-1014', slug: 'summit-insulated-bottle', name: 'Summit Bottle', priceCents: 3900, currency: 'USD', stock: 140, image: '/media/bottle.svg' },
  'sku-1008': { id: 'sku-1008', slug: 'glide-ergonomic-mouse', name: 'Glide Mouse', priceCents: 7900, currency: 'USD', stock: 4, image: '/media/mouse.svg' },
};

/** Stand-in for the real HTTP client; proves the route layer is testable in isolation. */
const fakeCatalog = {
  get: async (path) => {
    const id = decodeURIComponent(path.split('/').pop());
    if (!FIXTURES[id]) throw new AppError({ title: 'Product not found', status: 404, code: 'not-found' });
    return FIXTURES[id];
  },
};

async function buildApp({ repository } = {}) {
  const metrics = testMetrics('cart-service');
  const repo = repository ?? new MemoryCartRepository({ ttlSeconds: 60 });
  const health = new HealthRegistry();
  health.register('cart-store', () => repo.healthCheck(), { critical: true });
  const service = await createService({
    config,
    metrics,
    logger: silentLogger(),
    health,
    chaos: createChaosController({ enabled: false }),
    routes: (app) => registerRoutes({ app, repository: repo, metrics, config, catalogClient: fakeCatalog }),
  });
  service.markReady();
  return { ...service, repository: repo };
}

let ctx;
before(async () => {
  ctx = await buildApp();
});
after(async () => {
  await ctx.app.close();
});

const add = (cartId, productId, quantity = 1) =>
  ctx.app.inject({ method: 'POST', url: `/api/carts/${cartId}/items`, payload: { productId, quantity } });

describe('cart lifecycle', () => {
  test('creates a cart with an empty pricing breakdown', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/carts', payload: {} });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.match(body.cart.id, /^cart-/);
    assert.equal(body.cart.status, 'open');
    assert.deepEqual(body.cart.items, []);
    assert.equal(body.totals.totalCents, 0);
  });

  test('returns 404 for unknown carts', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/carts/cart-missing' });
    assert.equal(res.statusCode, 404);
    expectProblem(res.json(), 404);
  });

  test('adds an item and calculates tax and shipping in cents', async () => {
    const res = await add('cart-a', 'sku-1001', 1);
    assert.equal(res.statusCode, 200);
    const { cart, totals } = res.json();
    assert.equal(cart.items.length, 1);
    assert.equal(cart.items[0].unitPriceCents, 27900);
    assert.equal(totals.subtotalCents, 27900);
    assert.equal(totals.shippingCents, 0, 'free shipping above the threshold');
    assert.equal(totals.taxCents, 2302, '8.25% of 27900 rounded half-up');
    assert.equal(totals.totalCents, 30202);
    assert.equal(totals.amountToFreeShippingCents, 0);
  });

  test('charges shipping below the free-shipping threshold', async () => {
    const res = await add('cart-shipping', 'sku-1014', 1);
    const { totals } = res.json();
    assert.equal(totals.subtotalCents, 3900);
    assert.equal(totals.shippingCents, 599);
    assert.equal(totals.amountToFreeShippingCents, 3600);
    assert.equal(totals.taxCents, 322);
    assert.equal(totals.totalCents, 4821);
  });

  test('merges repeated adds of the same product into one line', async () => {
    await add('cart-merge-lines', 'sku-1014', 2);
    const res = await add('cart-merge-lines', 'sku-1014', 3);
    const { cart } = res.json();
    assert.equal(cart.items.length, 1);
    assert.equal(cart.items[0].quantity, 5);
  });

  test('rejects quantities above available stock', async () => {
    const res = await add('cart-stock', 'sku-1008', 5);
    assert.equal(res.statusCode, 409);
    const problem = res.json();
    assert.equal(problem.code, 'insufficient-stock');
    assert.match(problem.detail, /only 4 units/);
  });

  test('rejects unknown products with 404', async () => {
    const res = await add('cart-unknown', 'sku-nope', 1);
    assert.equal(res.statusCode, 404);
  });

  test('validates the request body', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/carts/cart-invalid/items',
      payload: { productId: 'sku-1001', quantity: 999 },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'validation-failed');
  });

  test('updates quantity and removes lines at zero', async () => {
    const added = await add('cart-patch', 'sku-1001', 2);
    const itemId = added.json().cart.items[0].id;

    const patched = await ctx.app.inject({ method: 'PATCH', url: `/api/carts/cart-patch/items/${itemId}`, payload: { quantity: 3 } });
    assert.equal(patched.json().cart.items[0].quantity, 3);

    const removed = await ctx.app.inject({ method: 'PATCH', url: `/api/carts/cart-patch/items/${itemId}`, payload: { quantity: 0 } });
    assert.deepEqual(removed.json().cart.items, []);
  });

  test('deletes a single line and clears the cart', async () => {
    const added = await add('cart-delete', 'sku-1001', 1);
    const itemId = added.json().cart.items[0].id;
    const deleted = await ctx.app.inject({ method: 'DELETE', url: `/api/carts/cart-delete/items/${itemId}` });
    assert.deepEqual(deleted.json().cart.items, []);

    await add('cart-delete', 'sku-1014', 1);
    const cleared = await ctx.app.inject({ method: 'DELETE', url: '/api/carts/cart-delete' });
    assert.equal(cleared.statusCode, 204);
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/api/carts/cart-delete' })).statusCode, 404);
  });

  test('merges an anonymous cart into a customer cart', async () => {
    await add('cart-target', 'sku-1001', 1);
    await add('cart-source', 'sku-1001', 2);
    await add('cart-source', 'sku-1014', 1);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/carts/cart-target/merge',
      payload: { sourceCartId: 'cart-source' },
    });
    assert.equal(res.statusCode, 200);
    const { cart } = res.json();
    assert.equal(cart.items.length, 2);
    assert.equal(cart.items.find((i) => i.productId === 'sku-1001').quantity, 3);
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/api/carts/cart-source' })).statusCode, 404);
  });
});

describe('checkout coordination', () => {
  test('locks a non-empty cart and refuses further mutations', async () => {
    await add('cart-lock', 'sku-1001', 1);
    const locked = await ctx.app.inject({ method: 'POST', url: '/internal/carts/cart-lock/lock' });
    assert.equal(locked.statusCode, 200);
    assert.equal(locked.json().cart.status, 'locked');

    const blocked = await add('cart-lock', 'sku-1014', 1);
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().code, 'cart-locked');

    const again = await ctx.app.inject({ method: 'POST', url: '/internal/carts/cart-lock/lock' });
    assert.equal(again.statusCode, 200, 'locking is idempotent for saga retries');

    const unlocked = await ctx.app.inject({ method: 'POST', url: '/internal/carts/cart-lock/unlock' });
    assert.equal(unlocked.json().cart.status, 'open');
  });

  test('refuses to lock an empty cart', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/carts', payload: {} });
    const cart = (await ctx.app.inject({ method: 'POST', url: '/api/carts', payload: {} })).json().cart;
    const res = await ctx.app.inject({ method: 'POST', url: `/internal/carts/${cart.id}/lock` });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().code, 'cart-empty');
  });

  test('rejects writes when the cart changed underneath (optimistic concurrency)', async () => {
    const repo = new MemoryCartRepository({ ttlSeconds: 60 });
    const isolated = await buildApp({ repository: repo });
    await isolated.app.inject({ method: 'POST', url: '/api/carts/cart-race/items', payload: { productId: 'sku-1001', quantity: 1 } });

    const original = repo.update.bind(repo);
    repo.update = async () => null; // simulate another writer winning the race
    const res = await isolated.app.inject({ method: 'POST', url: '/api/carts/cart-race/items', payload: { productId: 'sku-1014', quantity: 1 } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'cart-version-conflict');
    repo.update = original;
    await isolated.app.close();
  });
});

describe('pricing rules', () => {
  test('rounds tax to the nearest cent', () => {
    const cart = emptyCart('c');
    cart.items = [{ id: 'i', productId: 'p', unitPriceCents: 333, quantity: 3 }];
    const totals = calculateTotals(cart, { taxRateBps: 825, shippingFeeCents: 599, freeShippingThresholdCents: 7500 });
    assert.equal(totals.subtotalCents, 999);
    assert.equal(totals.taxCents, 82, '999 * 0.0825 = 82.4');
  });

  test('mergeCarts caps quantities per line', () => {
    const target = emptyCart('t');
    const source = emptyCart('s');
    target.items = [{ id: 'itm-p', productId: 'p', quantity: 15, unitPriceCents: 100 }];
    source.items = [{ id: 'itm-p', productId: 'p', quantity: 15, unitPriceCents: 100 }];
    assert.equal(mergeCarts(target, source).items[0].quantity, 20);
  });

  test('addItem is a pure function', () => {
    const cart = emptyCart('c');
    const product = { id: 'p', name: 'P', priceCents: 100, stock: 5 };
    const next = addItem(cart, product, 2);
    assert.equal(cart.items.length, 0);
    assert.equal(next.items.length, 1);
    assert.equal(next.version, 1);
  });
});

describe('operational endpoints', () => {
  test('reports readiness with the cart store check', async () => {
    const body = (await ctx.app.inject({ method: 'GET', url: '/readyz' })).json();
    assert.equal(body.status, 'ok');
    assert.ok(body.checks.some((c) => c.name === 'cart-store' && c.ok));
  });

  test('exposes domain metrics', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/metrics' });
    assert.match(res.body, /shopstack_carts_created_total/);
    assert.match(res.body, /shopstack_cart_items_added_total/);
  });
});
