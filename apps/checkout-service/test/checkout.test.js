import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createService, HealthRegistry, AppError, createChaosController } from '@shopstack/telemetry';
import { silentLogger, testConfig, testMetrics, expectProblem } from '@shopstack/telemetry/testing';
import { MemoryOrderRepository } from '../src/repository.js';
import { CheckoutService } from '../src/checkout.js';
import { registerRoutes } from '../src/routes.js';

const config = testConfig({ SERVICE_NAME: 'checkout-service', STEP_TIMEOUT_MS: 2000 });

/**
 * A tiny in-process simulation of the three downstream services.
 * `failures` lets a test make any step fail with a realistic AppError, which is
 * how we exercise every compensation path deterministically.
 */
class FakeWorld {
  constructor({ failAt = null, paymentDeclined = false, cartStatus = 'open', items, totals } = {}) {
    this.calls = [];
    this.failAt = failAt;
    this.paymentDeclined = paymentDeclined;
    this.cartStatus = cartStatus;
    this.items = items ?? [
      {
        id: 'itm-sku-1001',
        productId: 'sku-1001',
        slug: 'atlas-anc-headphones',
        name: 'Atlas ANC Headphones',
        image: '/media/atlas.svg',
        unitPriceCents: 27900,
        quantity: 1,
      },
      {
        id: 'itm-sku-1014',
        productId: 'sku-1014',
        slug: 'summit-insulated-bottle',
        name: 'Summit Bottle',
        image: '/media/bottle.svg',
        unitPriceCents: 3900,
        quantity: 2,
      },
    ];
    this.totals = totals ?? {
      itemCount: 3,
      subtotalCents: 35700,
      shippingCents: 0,
      taxCents: 2945,
      totalCents: 38645,
      currency: 'USD',
    };
    this.stock = new Map([
      ['sku-1001', 42],
      ['sku-1014', 140],
    ]);
    this.paymentRecords = new Map();
    this.locked = false;
    this.cartCleared = false;
  }

  #record(step) {
    this.calls.push(step);
    if (this.failAt === step) {
      throw new AppError({
        title: `Injected failure at ${step}`,
        status: 502,
        code: `upstream-${step}-failure`,
        retryable: true,
      });
    }
  }

  cart = {
    get: async (path) => {
      this.#record('cart.get');
      assert.match(path, /^\/internal\/carts\//);
      return {
        cart: {
          id: 'cart-1',
          status: this.cartStatus,
          items: this.items,
          currency: 'USD',
        },
        totals: this.totals,
      };
    },
    post: async (path) => {
      if (path.endsWith('/lock')) {
        this.#record('cart.lock');
        this.locked = true;
        return { cart: { status: 'locked' } };
      }
      if (path.endsWith('/unlock')) {
        this.#record('cart.unlock');
        this.locked = false;
        return { cart: { status: 'open' } };
      }
      if (path.endsWith('/clear')) {
        this.#record('cart.clear');
        this.cartCleared = true;
        return { cart: { items: [] } };
      }
      throw new Error(`unexpected cart call ${path}`);
    },
  };

  catalog = {
    post: async (path) => {
      if (path === '/internal/stock/reservations') {
        this.#record('catalog.reserve');
        for (const item of this.items) {
          if ((this.stock.get(item.productId) ?? 0) < item.quantity) {
            throw new AppError({ title: 'Insufficient stock', status: 409, code: 'out-of-stock' });
          }
        }
        for (const item of this.items) this.stock.set(item.productId, this.stock.get(item.productId) - item.quantity);
        return { id: 'res-order-1', status: 'pending' };
      }
      if (path.endsWith('/release')) {
        this.#record('catalog.release');
        for (const item of this.items)
          this.stock.set(item.productId, (this.stock.get(item.productId) ?? 0) + item.quantity);
        return { status: 'released' };
      }
      if (path.endsWith('/commit')) {
        this.#record('catalog.commit');
        return { status: 'committed' };
      }
      throw new Error(`unexpected catalog call ${path}`);
    },
  };

  payments = {
    post: async (path, body) => {
      if (path === '/api/payments') {
        this.#record('payments.create');
        if (this.paymentDeclined) {
          throw new AppError({
            title: 'Payment declined',
            status: 402,
            code: 'payment-declined',
            detail: 'insufficient_funds',
          });
        }
        const payment = {
          id: `pay_${this.paymentRecords.size + 1}`,
          status: 'authorized',
          method: body.paymentMethod,
          provider: { brand: 'visa', last4: '4242' },
        };
        this.paymentRecords.set(payment.id, payment);
        return payment;
      }
      if (path.endsWith('/capture')) {
        this.#record('payments.capture');
        const id = path.split('/')[3];
        const payment = this.paymentRecords.get(id);
        payment.status = 'captured';
        return payment;
      }
      if (path.endsWith('/refund')) {
        this.#record('payments.refund');
        return { status: 'refunded' };
      }
      if (path.endsWith('/void')) {
        this.#record('payments.void');
        return { status: 'voided' };
      }
      throw new Error(`unexpected payments call ${path}`);
    },
  };

  countCalls(step) {
    return this.calls.filter((c) => c === step).length;
  }
}

async function buildApp(worldOptions = {}) {
  const metrics = testMetrics('checkout-service');
  const repository = new MemoryOrderRepository();
  const world = new FakeWorld(worldOptions);
  const service = new CheckoutService({
    repository,
    cartClient: world.cart,
    catalogClient: world.catalog,
    paymentsClient: world.payments,
    metrics,
    logger: silentLogger(),
  });
  const health = new HealthRegistry();
  health.register('order-store', () => repository.healthCheck());
  const app = await createService({
    config,
    metrics,
    logger: silentLogger(),
    health,
    chaos: createChaosController({ enabled: false }),
    routes: (fastify) => registerRoutes({ app: fastify, service, config }),
  });
  app.markReady();
  return { ...app, service, repository, world };
}

const payload = (overrides = {}) => ({
  cartId: 'cart-1',
  customer: { email: 'ada@example.com', name: 'Ada Lovelace' },
  shippingAddress: { line1: '12 Analytical Way', city: 'London', postalCode: 'EC1A', country: 'GB' },
  paymentMethod: { type: 'card', token: 'tok_visa_4242' },
  ...overrides,
});

let counter = 0;
const key = () => `checkout-key-${++counter}-xyz`;

describe('POST /api/checkout — happy path', () => {
  test('places an order, captures payment and clears the cart', async () => {
    const ctx = await buildApp();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'idempotency-key': key() },
      payload: payload(),
    });

    assert.equal(res.statusCode, 201);
    const order = res.json();
    assert.equal(order.status, 'confirmed');
    assert.equal(order.pricing.totalCents, 38645);
    assert.equal(order.items.length, 2);
    assert.equal(order.payment.status, 'captured');
    assert.equal(order.sagaId.startsWith('saga_'), true);

    const steps = order.timeline.filter((t) => t.status === 'succeeded').map((t) => t.step);
    assert.deepEqual(steps, [
      'load_cart',
      'lock_cart',
      'reserve_stock',
      'authorize_payment',
      'capture_payment',
      'commit_stock',
      'persist_order',
    ]);
    assert.equal(ctx.world.cartCleared, true);
    assert.equal(ctx.world.stock.get('sku-1001'), 41);
    await ctx.app.close();
  });

  test('never trusts a client-supplied amount', async () => {
    const ctx = await buildApp();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'idempotency-key': key() },
      // The client tries to pay 1 cent. Unknown fields are stripped by the schema
      // and the total is recomputed from the cart service, so it has no effect.
      payload: { ...payload(), totalCents: 1 },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().pricing.totalCents, 38645);
    await ctx.app.close();
  });

  test('returns the same order for a replayed idempotency key', async () => {
    const ctx = await buildApp();
    const idempotencyKey = key();
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'idempotency-key': idempotencyKey },
      payload: payload(),
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'idempotency-key': idempotencyKey },
      payload: payload(),
    });

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().id, first.json().id);
    assert.equal(ctx.world.countCalls('payments.create'), 1, 'the customer must only be charged once');
    await ctx.app.close();
  });

  test('coalesces concurrent replays into a single saga', async () => {
    const ctx = await buildApp();
    const idempotencyKey = key();
    const results = await Promise.all([
      ctx.app.inject({
        method: 'POST',
        url: '/api/checkout',
        headers: { 'idempotency-key': idempotencyKey },
        payload: payload(),
      }),
      ctx.app.inject({
        method: 'POST',
        url: '/api/checkout',
        headers: { 'idempotency-key': idempotencyKey },
        payload: payload(),
      }),
    ]);
    const ids = new Set(results.map((r) => r.json().id));
    assert.equal(ids.size, 1);
    assert.equal(ctx.world.countCalls('payments.create'), 1);
    await ctx.app.close();
  });

  test('requires an Idempotency-Key', async () => {
    const ctx = await buildApp();
    const res = await ctx.app.inject({ method: 'POST', url: '/api/checkout', payload: payload() });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'validation-failed');
    await ctx.app.close();
  });

  test('validates the shipping address and email', async () => {
    const ctx = await buildApp();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'idempotency-key': key() },
      payload: payload({ customer: { email: 'not-an-email', name: 'X' } }),
    });
    assert.equal(res.statusCode, 400);
    await ctx.app.close();
  });
});

describe('compensation', () => {
  test('a declined payment releases stock and unlocks the cart', async () => {
    const ctx = await buildApp({ paymentDeclined: true });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'idempotency-key': key() },
      payload: payload(),
    });

    assert.equal(res.statusCode, 402);
    const problem = expectProblem(res.json(), 402);
    assert.equal(problem.code, 'payment-declined');

    assert.ok(ctx.world.calls.includes('catalog.release'), 'stock reservation must be released');
    assert.ok(ctx.world.calls.includes('cart.unlock'), 'cart must be unlocked');
    assert.equal(ctx.world.countCalls('payments.void'), 0, 'nothing to void when authorisation never happened');
    assert.equal(ctx.world.stock.get('sku-1001'), 42, 'reserved stock must be returned');
    assert.equal(ctx.world.locked, false, 'cart must be unlocked so the customer can retry');
    assert.equal(ctx.world.cartCleared, false);
    await ctx.app.close();
  });

  test('a capture failure refunds the authorisation and releases stock', async () => {
    const ctx = await buildApp({ failAt: 'payments.capture' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'idempotency-key': key() },
      payload: payload(),
    });

    assert.equal(res.statusCode, 502);
    assert.equal(ctx.world.countCalls('payments.void'), 1, 'the authorisation hold is released');
    assert.equal(ctx.world.countCalls('payments.refund'), 0, 'nothing was captured, so no refund is needed');
    assert.equal(ctx.world.countCalls('catalog.release'), 1);
    assert.equal(ctx.world.countCalls('cart.unlock'), 1);
    assert.equal(ctx.world.stock.get('sku-1014'), 140);
    await ctx.app.close();
  });

  test('a stock failure only unlocks the cart', async () => {
    const ctx = await buildApp({ failAt: 'catalog.reserve' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'idempotency-key': key() },
      payload: payload(),
    });

    assert.equal(res.statusCode, 502);
    assert.equal(ctx.world.countCalls('cart.unlock'), 1);
    assert.equal(ctx.world.countCalls('payments.create'), 0, 'never charge for unreserved stock');
    assert.equal(ctx.world.countCalls('catalog.release'), 0);
    await ctx.app.close();
  });

  test('a failed attempt is stored for support but does not burn the idempotency key', async () => {
    const ctx = await buildApp({ failAt: 'catalog.reserve' });
    const idempotencyKey = key();
    const failed = await ctx.app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'idempotency-key': idempotencyKey },
      payload: payload(),
    });
    assert.equal(failed.statusCode, 502);

    const attempts = (
      await ctx.app.inject({ method: 'GET', url: '/api/orders?customerEmail=ada@example.com&limit=10' })
    ).json();
    assert.equal(attempts.total, 1);
    assert.equal(attempts.items[0].status, 'failed');
    assert.ok(attempts.items[0].failure.code);

    ctx.world.failAt = null;
    const retry = await ctx.app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'idempotency-key': idempotencyKey },
      payload: payload(),
    });
    assert.equal(retry.statusCode, 201, 'the customer must be able to retry after a failure');
    await ctx.app.close();
  });

  test('rejects an empty cart before touching stock or payments', async () => {
    const ctx = await buildApp({ items: [] });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'idempotency-key': key() },
      payload: payload(),
    });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().code, 'cart-empty');
    assert.equal(ctx.world.countCalls('payments.create'), 0);
    await ctx.app.close();
  });

  test('refuses a cart that another checkout already locked', async () => {
    const ctx = await buildApp({ cartStatus: 'locked' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'idempotency-key': key() },
      payload: payload(),
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'cart-locked');
    await ctx.app.close();
  });
});

describe('orders API', () => {
  test('fetches an order by id and 404s for unknown ids', async () => {
    const ctx = await buildApp();
    const created = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/checkout',
        headers: { 'idempotency-key': key() },
        payload: payload(),
      })
    ).json();

    const fetched = await ctx.app.inject({ method: 'GET', url: `/api/orders/${created.id}` });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.json().id, created.id);

    const missing = await ctx.app.inject({ method: 'GET', url: '/api/orders/ord_missing' });
    assert.equal(missing.statusCode, 404);
    await ctx.app.close();
  });

  test('lists orders by customer email', async () => {
    const ctx = await buildApp();
    await ctx.app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'idempotency-key': key() },
      payload: payload(),
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'idempotency-key': key() },
      payload: payload({ customer: { email: 'grace@example.com', name: 'Grace Hopper' } }),
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/api/orders?customerEmail=GRACE@example.com' });
    assert.equal(res.json().total, 1);
    assert.equal(res.json().items[0].customer.email, 'grace@example.com');
    await ctx.app.close();
  });

  test('reports revenue stats for dashboards', async () => {
    const ctx = await buildApp();
    await ctx.app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'idempotency-key': key() },
      payload: payload(),
    });
    const stats = (await ctx.app.inject({ method: 'GET', url: '/internal/orders/stats' })).json();
    assert.equal(stats.byStatus.confirmed, 1);
    assert.equal(stats.revenueCents, 38645);
    assert.equal(stats.itemsSold, 3);
    await ctx.app.close();
  });

  test('cancels an order: refunds the payment and returns the stock', async () => {
    const ctx = await buildApp();
    const order = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/checkout',
        headers: { 'idempotency-key': key() },
        payload: payload(),
      })
    ).json();
    assert.equal(ctx.world.stock.get('sku-1001'), 41);

    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/cancel`,
      payload: { reason: 'changed_mind' },
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().status, 'cancelled');
    assert.equal(cancelled.json().payment.status, 'refunded');
    assert.equal(ctx.world.stock.get('sku-1001'), 42);
    assert.equal(cancelled.json().cancellation.reason, 'changed_mind');

    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/cancel`,
      payload: { reason: 'changed_mind' },
    });
    assert.equal(again.json().status, 'cancelled', 'cancellation is idempotent');
    assert.equal(ctx.world.countCalls('payments.refund'), 1, 'must not refund twice');
    await ctx.app.close();
  });

  test('exposes saga metrics', async () => {
    const ctx = await buildApp();
    await ctx.app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'idempotency-key': key() },
      payload: payload(),
    });
    const metricsText = (await ctx.app.inject({ method: 'GET', url: '/metrics' })).body;
    assert.match(metricsText, /shopstack_checkout_saga_duration_seconds/);
    assert.match(metricsText, /shopstack_checkout_step_duration_seconds/);
    assert.match(metricsText, /shopstack_orders_total\{.*status="confirmed"/);
    await ctx.app.close();
  });
});
