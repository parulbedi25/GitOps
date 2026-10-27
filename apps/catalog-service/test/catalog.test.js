import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createService, HealthRegistry, createChaosController } from '@shopstack/telemetry';
import { silentLogger, testConfig, testMetrics, expectProblem } from '@shopstack/telemetry/testing';
import { MemoryCatalogRepository } from '../src/catalog.js';
import { TtlCache } from '../src/cache.js';
import { registerRoutes } from '../src/routes.js';
import { categories, products } from '../src/data/products.js';

const config = testConfig({
  SERVICE_NAME: 'catalog-service',
  DB_DRIVER: 'memory',
  CACHE_TTL_MS: 5000,
  METRICS_REFRESH_MS: 60_000,
  LOW_STOCK_THRESHOLD: 5,
});

async function buildApp({ repository, cache } = {}) {
  const metrics = testMetrics('catalog-service');
  const repo = repository ?? new MemoryCatalogRepository({ products, categories });
  const ttlCache = cache ?? new TtlCache({ ttlMs: config.CACHE_TTL_MS });
  const health = new HealthRegistry();
  health.register('catalog-store', () => repo.healthCheck(), { critical: true });
  const service = await createService({
    config,
    metrics,
    logger: silentLogger(),
    health,
    chaos: createChaosController({ enabled: false }),
    routes: (app) => registerRoutes({ app, repository: repo, metrics, cache: ttlCache, config }),
  });
  service.markReady();
  return { ...service, repository: repo, cache: ttlCache };
}

let ctx;
before(async () => {
  ctx = await buildApp();
});
after(async () => {
  await ctx.app.close();
});

const reserve = (payload) => ctx.app.inject({ method: 'POST', url: '/internal/stock/reservations', payload });

describe('catalogue reads', () => {
  test('lists a page of products with a pagination envelope', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/products' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.items.length, 12);
    assert.equal(body.total, 26);
    assert.equal(body.limit, 12);
    assert.equal(body.offset, 0);
    assert.equal(body.nextOffset, 12);
    assert.ok(body.items.every((item) => Number.isInteger(item.priceCents)));
  });

  test('filters by category', async () => {
    const body = (await ctx.app.inject({ url: '/api/products?category=workspace&limit=24' })).json();
    assert.ok(body.items.length >= 4);
    assert.ok(body.items.every((item) => item.category === 'workspace'));
  });

  test('searches name, description and tags', async () => {
    const byName = (await ctx.app.inject({ url: '/api/products?q=headphones' })).json();
    assert.equal(byName.items[0].id, 'sku-1001');

    const byTag = (await ctx.app.inject({ url: '/api/products?q=merino' })).json();
    assert.ok(byTag.items.some((item) => item.tags.includes('merino')));
  });

  test('paginates without overlap and ends with nextOffset=null', async () => {
    const first = (await ctx.app.inject({ url: '/api/products?limit=10&offset=0' })).json();
    const second = (await ctx.app.inject({ url: '/api/products?limit=10&offset=10' })).json();
    const last = (await ctx.app.inject({ url: '/api/products?limit=10&offset=20' })).json();

    assert.equal(first.nextOffset, 10);
    assert.equal(last.nextOffset, null);
    const ids = new Set([...first.items, ...second.items, ...last.items].map((item) => item.id));
    assert.equal(ids.size, 26, 'every product appears exactly once');
  });

  test('sorts by price ascending', async () => {
    const body = (await ctx.app.inject({ url: '/api/products?sort=price_asc&limit=26' })).json();
    const prices = body.items.map((item) => item.priceCents);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  });

  test('hides out-of-stock products when asked', async () => {
    const body = (await ctx.app.inject({ url: '/api/products?inStock=true&limit=48' })).json();
    assert.ok(body.items.length > 0);
    assert.ok(body.items.every((item) => item.stock > 0));
    assert.ok(!body.items.some((item) => item.id === 'sku-1002'), 'sku-1002 is sold out');
  });

  test('returns a product by id and by slug', async () => {
    const byId = await ctx.app.inject({ url: '/api/products/sku-1001' });
    const bySlug = await ctx.app.inject({ url: '/api/products/atlas-anc-headphones' });
    assert.equal(byId.statusCode, 200);
    assert.equal(bySlug.statusCode, 200);
    assert.equal(byId.json().name, 'Atlas ANC Headphones');
    assert.equal(bySlug.json().id, byId.json().id);
    assert.equal(byId.json().image, '/media/atlas-anc-headphones.svg');
    assert.equal(byId.json().inStock, true);
    assert.equal(byId.json().lowStock, false);
  });

  test('flags low stock on the public product', async () => {
    const body = (await ctx.app.inject({ url: '/api/products/sku-1008' })).json();
    assert.equal(body.stock, 4);
    assert.equal(body.lowStock, true);
  });

  test('returns a 404 problem document for an unknown product', async () => {
    const res = await ctx.app.inject({ url: '/api/products/sku-9999' });
    assert.equal(res.statusCode, 404);
    assert.match(res.headers['content-type'], /application\/problem\+json/);
    const problem = expectProblem(res.json(), 404);
    assert.equal(problem.code, 'product-not-found');
  });

  test('suggests related products from the same category', async () => {
    const res = await ctx.app.inject({ url: '/api/products/sku-1001/related?limit=2' });
    assert.equal(res.statusCode, 200);
    const { items } = res.json();
    assert.ok(items.length > 0 && items.length <= 2);
    assert.ok(items.every((item) => item.category === 'audio' && item.id !== 'sku-1001'));
  });

  test('lists categories with live product counts', async () => {
    const { items } = (await ctx.app.inject({ url: '/api/categories' })).json();
    assert.equal(items.length, 8);
    assert.equal(items.reduce((sum, item) => sum + item.count, 0), 26);
    assert.ok(items.every((item) => item.slug && item.name && Number.isInteger(item.count)));
  });

  test('serves repeated identical queries from the cache', async () => {
    const isolated = await buildApp();
    await isolated.app.inject({ url: '/api/products?category=audio' });
    await isolated.app.inject({ url: '/api/products?category=audio' });
    const stats = isolated.cache.stats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
    await isolated.app.close();
  });

  test('rejects an out-of-range limit with a validation problem', async () => {
    const res = await ctx.app.inject({ url: '/api/products?limit=500' });
    assert.equal(res.statusCode, 400);
    const problem = expectProblem(res.json(), 400);
    assert.equal(problem.code, 'validation-failed');
  });
});

describe('stock reservations', () => {
  test('reserves stock atomically and reports the remaining quantity', async () => {
    const before = (await ctx.app.inject({ url: '/api/products/sku-1001' })).json().stock;
    const res = await reserve({ orderId: 'order-happy', items: [{ productId: 'sku-1001', quantity: 2 }] });
    assert.equal(res.statusCode, 201);

    const reservation = res.json();
    assert.equal(reservation.id, 'res-order-happy');
    assert.equal(reservation.status, 'pending');
    assert.equal(reservation.orderId, 'order-happy');

    const after = (await ctx.app.inject({ url: '/api/products/sku-1001' })).json().stock;
    assert.equal(after, before - 2);
  });

  test('rejects the whole basket when one line is short, leaving stock untouched', async () => {
    const stockBefore = (await ctx.app.inject({ url: '/api/products/sku-1008' })).json().stock;
    const otherBefore = (await ctx.app.inject({ url: '/api/products/sku-1001' })).json().stock;
    const res = await reserve({
      orderId: 'order-short',
      items: [
        { productId: 'sku-1001', quantity: 1 },
        { productId: 'sku-1008', quantity: stockBefore + 10 },
      ],
    });

    assert.equal(res.statusCode, 409);
    const problem = expectProblem(res.json(), 409);
    assert.equal(problem.code, 'out-of-stock');
    assert.equal(problem.errors[0].productId, 'sku-1008');
    assert.equal(problem.errors[0].available, stockBefore);

    const untouched = (await ctx.app.inject({ url: '/api/products/sku-1001' })).json().stock;
    assert.equal(untouched, otherBefore, 'the first line must not have been decremented');
  });

  test('is idempotent on orderId, so a saga retry cannot double-decrement', async () => {
    const first = await reserve({ orderId: 'order-retry', items: [{ productId: 'sku-1014', quantity: 3 }] });
    const second = await reserve({ orderId: 'order-retry', items: [{ productId: 'sku-1014', quantity: 3 }] });

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.equal(second.json().id, first.json().id);
    const stock = (await ctx.app.inject({ url: '/api/products/sku-1014' })).json().stock;
    assert.equal(stock, 137, '140 - 3, not 140 - 6');
  });

  test('commits a reservation after payment capture', async () => {
    const { id } = (await reserve({ orderId: 'order-commit', items: [{ productId: 'sku-1019', quantity: 1 }] })).json();
    const res = await ctx.app.inject({ method: 'POST', url: `/internal/stock/reservations/${id}/commit` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'committed');
  });

  test('releases stock when payment fails and reports the released state', async () => {
    const before = (await ctx.app.inject({ url: '/api/products/sku-1020' })).json().stock;
    const { id } = (await reserve({ orderId: 'order-release', items: [{ productId: 'sku-1020', quantity: 2 }] })).json();
    const released = await ctx.app.inject({ method: 'POST', url: `/internal/stock/reservations/${id}/release` });

    assert.equal(released.statusCode, 200);
    assert.equal(released.json().status, 'released');
    const after = (await ctx.app.inject({ url: '/api/products/sku-1020' })).json().stock;
    assert.equal(after, before);
  });

  test('refuses to reuse an order id whose stock was already released', async () => {
    const { id } = (await reserve({ orderId: 'order-reuse', items: [{ productId: 'sku-1021', quantity: 1 }] })).json();
    await ctx.app.inject({ method: 'POST', url: `/internal/stock/reservations/${id}/release` });

    const res = await reserve({ orderId: 'order-reuse', items: [{ productId: 'sku-1021', quantity: 1 }] });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'reservation-released');
  });

  test('returns 404 for an unknown reservation', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/internal/stock/reservations/res-missing/commit' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, 'reservation-not-found');
  });

  test('validates the reservation payload', async () => {
    const res = await reserve({ orderId: 'order-invalid', items: [{ productId: 'sku-1001', quantity: 0 }] });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'validation-failed');
  });

  test('exposes an operator view of available stock', async () => {
    const body = (await ctx.app.inject({ url: '/internal/stock/sku-1001' })).json();
    assert.equal(body.productId, 'sku-1001');
    assert.ok(body.available > 0);
    assert.equal(body.reserved, false);
  });
});

describe('runtime surface', () => {
  test('reports readiness with the catalog store check', async () => {
    const body = (await ctx.app.inject({ url: '/readyz' })).json();
    assert.equal(body.status, 'ok');
    assert.equal(body.ready, true);
    assert.ok(body.checks.some((check) => check.name === 'catalog-store' && check.ok));
  });

  test('answers liveness and startup probes', async () => {
    assert.equal((await ctx.app.inject({ url: '/healthz' })).statusCode, 200);
    assert.equal((await ctx.app.inject({ url: '/startupz' })).statusCode, 200);
    assert.equal((await ctx.app.inject({ url: '/livez' })).statusCode, 200);
  });

  test('exposes domain metrics for inventory and reservations', async () => {
    const res = await ctx.app.inject({ url: '/metrics' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /shopstack_catalog_reservations_total/);
    assert.match(res.body, /shopstack_catalog_stock_units/);
    assert.match(res.body, /shopstack_catalog_out_of_stock_products/);
    assert.match(res.body, /shopstack_http_requests_total/);
  });

  test('reports aggregate inventory statistics', async () => {
    const body = (await ctx.app.inject({ url: '/internal/stats' })).json();
    assert.equal(body.products, 26);
    assert.equal(body.categories, 8);
    assert.ok(body.totalUnits > 0);
    assert.equal(typeof body.lowStock, 'number');
    assert.ok(body.cache.entries >= 0);
  });
});
