import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createService, HealthRegistry, createChaosController } from '@shopstack/telemetry';
import { silentLogger, testConfig, testMetrics, expectProblem } from '@shopstack/telemetry/testing';
import { MemoryPaymentRepository } from '../src/repository.js';
import { SimulatedProcessor } from '../src/payments.js';
import { registerRoutes } from '../src/routes.js';
import { rawBodyPlugin } from '../src/raw-body.js';

const SECRET = 'test-webhook-secret-value';
const config = testConfig({ SERVICE_NAME: 'payments-service', PSP_WEBHOOK_SECRET: SECRET, PSP_FAILURE_RATE: 0 });

async function buildApp(overrides = {}) {
  const cfg = { ...config, ...overrides };
  const metrics = testMetrics('payments-service');
  const repository = new MemoryPaymentRepository();
  const processor = new SimulatedProcessor({ failureRate: cfg.PSP_FAILURE_RATE ?? 0 });
  const health = new HealthRegistry();
  health.register('payment-store', () => repository.healthCheck());
  const service = await createService({
    config: cfg,
    metrics,
    logger: silentLogger(),
    health,
    chaos: createChaosController({ enabled: false }),
    plugins: [rawBodyPlugin],
    routes: (app) => registerRoutes({ app, repository, metrics, config: cfg, processor }),
  });
  service.markReady();
  return { ...service, repository, processor };
}

let ctx;
let counter = 0;
const nextKey = () => `idem-key-${++counter}-abcdefgh`;

function paymentPayload(overrides = {}) {
  return {
    orderId: 'order-1001',
    amountCents: 27900,
    currency: 'USD',
    paymentMethod: { type: 'card', token: 'tok_visa_4242' },
    ...overrides,
  };
}

const createPayment = (app, payload = paymentPayload(), key = nextKey()) =>
  app.app.inject({ method: 'POST', url: '/api/payments', headers: { 'idempotency-key': key }, payload });

before(async () => {
  ctx = await buildApp();
});
after(async () => {
  await ctx.app.close();
});

describe('POST /api/payments', () => {
  test('authorises a card payment', async () => {
    const res = await createPayment(ctx);
    assert.equal(res.statusCode, 201);
    const payment = res.json();
    assert.equal(payment.status, 'authorized');
    assert.match(payment.id, /^pay_/);
    assert.equal(payment.amountCents, 27900);
    assert.equal(payment.provider.brand, 'visa');
    assert.equal(payment.provider.last4, '4242');
    assert.deepEqual(payment.timeline.map((t) => t.status), ['requires_confirmation', 'authorized']);
  });

  test('never persists or echoes the raw payment token', async () => {
    const res = await createPayment(ctx, paymentPayload({ orderId: 'order-token' }));
    const serialized = JSON.stringify(res.json());
    assert.ok(!serialized.includes('tok_visa_4242'), 'token must not be stored');
    assert.match(res.json().method.tokenFingerprint, /^[a-f0-9]{12}$/);
  });

  test('requires an Idempotency-Key header', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/payments', payload: paymentPayload() });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'validation-failed');
  });

  test('rejects amounts below the processor minimum', async () => {
    const res = await createPayment(ctx, paymentPayload({ amountCents: 10 }));
    assert.equal(res.statusCode, 400);
  });

  test('declines known test tokens with 402 and a reason', async () => {
    const res = await createPayment(ctx, paymentPayload({ orderId: 'order-declined', paymentMethod: { type: 'card', token: 'tok_declined' } }));
    assert.equal(res.statusCode, 402);
    const problem = res.json();
    assert.equal(problem.code, 'payment-declined');
    assert.equal(problem.reason, 'insufficient_funds');
    assert.match(problem.paymentId, /^pay_/);

    const stored = await ctx.repository.findById(problem.paymentId);
    assert.equal(stored.status, 'declined');
    assert.equal(stored.failureReason, 'insufficient_funds');
  });

  test('returns the original payment when the same key is replayed', async () => {
    const key = nextKey();
    const first = await createPayment(ctx, paymentPayload({ orderId: 'order-replay' }), key);
    const second = await createPayment(ctx, paymentPayload({ orderId: 'order-replay' }), key);
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 200);
    assert.equal(second.headers['idempotent-replay'], 'true');
    assert.equal(second.json().id, first.json().id);
  });

  test('rejects key reuse with a different payload', async () => {
    const key = nextKey();
    await createPayment(ctx, paymentPayload({ orderId: 'order-a', amountCents: 1000 }), key);
    const res = await createPayment(ctx, paymentPayload({ orderId: 'order-b', amountCents: 2000 }), key);
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().code, 'idempotency-key-reuse');
  });
});

describe('capture, void and refund', () => {
  const authorised = async (orderId) => (await createPayment(ctx, paymentPayload({ orderId }))).json();

  test('captures an authorised payment exactly once', async () => {
    const payment = await authorised('order-capture');
    const captured = await ctx.app.inject({ method: 'POST', url: `/api/payments/${payment.id}/capture` });
    assert.equal(captured.statusCode, 200);
    assert.equal(captured.json().status, 'captured');

    const again = await ctx.app.inject({ method: 'POST', url: `/api/payments/${payment.id}/capture` });
    assert.equal(again.json().status, 'captured', 'capture is idempotent for retries');
  });

  test('refuses to capture a declined payment', async () => {
    const declined = await createPayment(ctx, paymentPayload({ orderId: 'order-decl', paymentMethod: { type: 'card', token: 'tok_declined' } }));
    const res = await ctx.app.inject({ method: 'POST', url: `/api/payments/${declined.json().paymentId}/capture` });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'payment-not-capturable');
  });

  test('supports partial and full refunds', async () => {
    const payment = await authorised('order-refund');
    await ctx.app.inject({ method: 'POST', url: `/api/payments/${payment.id}/capture` });

    const partial = await ctx.app.inject({
      method: 'POST',
      url: `/api/payments/${payment.id}/refund`,
      payload: { amountCents: 7900 },
    });
    assert.equal(partial.json().status, 'partially_refunded');
    assert.equal(partial.json().refundedCents, 7900);

    const over = await ctx.app.inject({
      method: 'POST',
      url: `/api/payments/${payment.id}/refund`,
      payload: { amountCents: 999999 },
    });
    assert.equal(over.statusCode, 422);
    assert.equal(over.json().code, 'refund-exceeds-captured');

    const rest = await ctx.app.inject({ method: 'POST', url: `/api/payments/${payment.id}/refund` });
    assert.equal(rest.json().status, 'refunded');
    assert.equal(rest.json().refundedCents, 27900);
  });

  test('refuses to refund an uncaptured payment', async () => {
    const payment = await authorised('order-refund-unauth');
    const res = await ctx.app.inject({ method: 'POST', url: `/api/payments/${payment.id}/refund` });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'payment-not-refundable');
  });

  test('voids an authorisation', async () => {
    const payment = await authorised('order-void');
    const res = await ctx.app.inject({ method: 'POST', url: `/api/payments/${payment.id}/void` });
    assert.equal(res.json().status, 'voided');
  });

  test('returns 404 for unknown payments', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/payments/pay_missing' });
    assert.equal(res.statusCode, 404);
    expectProblem(res.json(), 404);
  });
});

describe('PSP webhooks', () => {
  const sign = (body, { timestamp = Math.floor(Date.now() / 1000), secret = SECRET } = {}) => {
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return { 'x-psp-signature': `sha256=${signature}`, 'x-psp-timestamp': String(timestamp) };
  };

  test('accepts a correctly signed event and applies it', async () => {
    const payment = (await createPayment(ctx, paymentPayload({ orderId: 'order-webhook' }))).json();
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'payment.captured',
      data: { paymentId: payment.id },
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/psp',
      headers: { 'content-type': 'application/json', ...sign(body) },
      payload: body,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'captured');
    assert.equal((await ctx.repository.findById(payment.id)).status, 'captured');
  });

  test('rejects a tampered payload', async () => {
    const body = JSON.stringify({ id: 'evt_2', type: 'payment.captured', data: { paymentId: 'pay_x' } });
    const headers = sign(body);
    const tampered = body.replace('pay_x', 'pay_y');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/psp',
      headers: { 'content-type': 'application/json', ...headers },
      payload: tampered,
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'webhook-signature-invalid');
  });

  test('rejects replayed events outside the tolerance window', async () => {
    const body = JSON.stringify({ id: 'evt_3', type: 'payment.captured', data: { paymentId: 'pay_x' } });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/psp',
      headers: { 'content-type': 'application/json', ...sign(body, { timestamp: 1_600_000_000 }) },
      payload: body,
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'webhook-timestamp-invalid');
  });

  test('rejects unsigned events', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/psp',
      headers: { 'content-type': 'application/json' },
      payload: { id: 'evt_4', type: 'payment.captured', data: { paymentId: 'pay_x' } },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'webhook-signature-missing');
  });

  test('acknowledges events for unknown payments without retrying forever', async () => {
    const body = JSON.stringify({ id: 'evt_5', type: 'payment.captured', data: { paymentId: 'pay_ghost' } });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/psp',
      headers: { 'content-type': 'application/json', ...sign(body) },
      payload: body,
    });
    assert.equal(res.statusCode, 202);
    assert.equal(res.json().ignored, true);
  });

  test('returns 503 when no webhook secret is configured (secure default)', async () => {
    const isolated = await buildApp({ PSP_WEBHOOK_SECRET: undefined });
    const body = JSON.stringify({ id: 'evt_6', type: 'payment.captured', data: { paymentId: 'pay_x' } });
    const res = await isolated.app.inject({
      method: 'POST',
      url: '/webhooks/psp',
      headers: { 'content-type': 'application/json', ...sign(body) },
      payload: body,
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, 'webhooks-disabled');
    await isolated.app.close();
  });
});

describe('operational endpoints', () => {
  test('exposes payment metrics', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/metrics' });
    assert.match(res.body, /shopstack_payments_total/);
    assert.match(res.body, /shopstack_payment_amount_cents/);
    assert.match(res.body, /shopstack_payment_declines_total/);
  });

  test('reports aggregate stats for the demo dashboard', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/internal/stats' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().total > 0);
  });

  test('allows tuning the processor failure rate outside prod', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/internal/processor/failure-rate', payload: { failureRate: 0.5 } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().failureRate, 0.5);
    await ctx.app.inject({ method: 'POST', url: '/internal/processor/failure-rate', payload: { failureRate: 0 } });

    const prodCtx = await buildApp({ DEPLOYMENT_ENVIRONMENT: 'prod' });
    const forbidden = await prodCtx.app.inject({ method: 'POST', url: '/internal/processor/failure-rate', payload: { failureRate: 1 } });
    assert.equal(forbidden.statusCode, 403);
    await prodCtx.app.close();
  });

  test('rejects malformed JSON with 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/payments',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'malformed-key-1' },
      payload: '{"orderId": ',
    });
    assert.equal(res.statusCode, 400);
  });
});
