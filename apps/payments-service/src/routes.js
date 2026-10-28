/**
 * Payments HTTP API.
 *
 * Card data never reaches this service: the storefront tokenises through the PSP
 * and sends an opaque `token`. Nothing here logs, stores or echoes a PAN/CVV, and
 * the logger redacts `card`/`token` fields defensively.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, conflict, notFound, unprocessable } from '@shopstack/telemetry';
import { assertCapturable, assertRefundable, newPayment, transition } from './payments.js';

const paymentSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    orderId: { type: 'string' },
    amountCents: { type: 'integer' },
    currency: { type: 'string' },
    refundedCents: { type: 'integer' },
    status: { type: 'string' },
    method: { type: 'object', additionalProperties: true },
    provider: { type: 'object', additionalProperties: true, nullable: true },
    failureReason: { type: 'string', nullable: true },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    timeline: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
};

const MIN_AMOUNT_CENTS = 50;
const MAX_AMOUNT_CENTS = 5_000_000;
const WEBHOOK_TOLERANCE_SECONDS = 300;

export async function registerRoutes({ app, repository, metrics, config, processor }) {
  const paymentsTotal = metrics.counter('shopstack_payments_total', 'Payment intents by terminal state.', [
    'status',
    'reason',
  ]);
  const amountHistogram = metrics.histogram(
    'shopstack_payment_amount_cents',
    'Authorised payment amounts in cents.',
    [],
    [500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 500000],
  );
  const processingDuration = metrics.histogram(
    'shopstack_payment_processing_duration_seconds',
    'Time spent talking to the payment processor.',
    ['outcome'],
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  );
  const idempotentReplays = metrics.counter(
    'shopstack_payment_idempotent_replays_total',
    'Create calls served from the idempotency store.',
  );
  const webhookEvents = metrics.counter('shopstack_payment_webhook_events_total', 'PSP webhook deliveries.', [
    'type',
    'result',
  ]);
  const declinedTotal = metrics.counter('shopstack_payment_declines_total', 'Declined payments by reason.', ['reason']);

  async function findOr404(id) {
    const payment = await repository.findById(id);
    if (!payment) throw notFound('Payment', id);
    return payment;
  }

  function verifyWebhookSignature(request) {
    if (!config.PSP_WEBHOOK_SECRET) {
      throw new AppError({
        title: 'Webhooks disabled',
        status: 503,
        code: 'webhooks-disabled',
        detail: 'PSP_WEBHOOK_SECRET is not configured',
      });
    }
    const signature = request.headers['x-psp-signature'];
    const timestamp = request.headers['x-psp-timestamp'];
    if (!signature || !timestamp) {
      throw new AppError({ title: 'Missing signature', status: 401, code: 'webhook-signature-missing' });
    }
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_SECONDS) {
      throw new AppError({
        title: 'Stale webhook',
        status: 401,
        code: 'webhook-timestamp-invalid',
        detail: 'replay window exceeded',
      });
    }
    const payload = `${timestamp}.${request.rawBody?.toString('utf8') ?? JSON.stringify(request.body)}`;
    const expected = createHmac('sha256', config.PSP_WEBHOOK_SECRET).update(payload).digest('hex');
    const provided = String(signature).replace(/^sha256=/, '');
    const isValid =
      provided.length === expected.length &&
      timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
    if (!isValid) {
      throw new AppError({ title: 'Invalid signature', status: 401, code: 'webhook-signature-invalid' });
    }
  }

  // ── Create / authorise ────────────────────────────────────────────────────
  app.post(
    '/api/payments',
    {
      schema: {
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: { 'idempotency-key': { type: 'string', minLength: 8, maxLength: 128 } },
        },
        body: {
          type: 'object',
          required: ['orderId', 'amountCents', 'currency', 'paymentMethod'],
          additionalProperties: false,
          properties: {
            orderId: { type: 'string', minLength: 3, maxLength: 80 },
            amountCents: { type: 'integer', minimum: MIN_AMOUNT_CENTS, maximum: MAX_AMOUNT_CENTS },
            currency: { type: 'string', enum: ['USD', 'EUR', 'GBP', 'INR'] },
            customerEmail: { type: 'string', format: 'email', maxLength: 200 },
            paymentMethod: {
              type: 'object',
              required: ['type', 'token'],
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: ['card', 'wallet', 'netbanking'] },
                token: { type: 'string', minLength: 4, maxLength: 200 },
              },
            },
          },
        },
        response: { 201: paymentSchema, 200: paymentSchema, 402: { type: 'object', additionalProperties: true } },
      },
    },
    async (request, reply) => {
      const idempotencyKey = request.headers['idempotency-key'];
      // `customerEmail` is accepted but not persisted: PII stays in the order record.
      const { orderId, amountCents, currency, paymentMethod } = request.body;

      const replayed = await repository.findByIdempotencyKey(idempotencyKey);
      if (replayed) {
        if (replayed.orderId !== orderId || replayed.amountCents !== amountCents) {
          throw unprocessable(
            'Idempotency key reuse',
            'this key was already used with a different order or amount',
            'idempotency-key-reuse',
          );
        }
        idempotentReplays.inc();
        paymentsTotal.labels(replayed.status, replayed.failureReason ?? 'none').inc();
        return reply.code(200).header('idempotent-replay', 'true').send(replayed);
      }

      let payment = newPayment({
        orderId,
        amountCents,
        currency,
        idempotencyKey,
        method: { type: paymentMethod.type, tokenFingerprint: fingerprint(paymentMethod.token) },
      });
      payment = await repository.insert(payment);

      const started = process.hrtime.bigint();
      const result = processor.authorize({ token: paymentMethod.token, amountCents, currency });
      const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
      processingDuration.labels(result.ok ? 'authorized' : 'declined').observe(elapsed);

      if (!result.ok) {
        const declined = transition(payment, 'declined', {
          failureReason: result.reason,
          provider: { name: 'shopstack-psp-sim', reference: `decline_${result.reason}` },
        });
        await repository.save(declined);
        paymentsTotal.labels('declined', result.reason).inc();
        declinedTotal.labels(result.reason).inc();
        request.log.info({ paymentId: declined.id, reason: result.reason }, 'payment declined');
        return reply.code(402).type('application/problem+json').send({
          type: 'https://errors.shopstack.dev/payment-declined',
          title: 'Payment declined',
          status: 402,
          code: 'payment-declined',
          detail: result.reason,
          reason: result.reason,
          paymentId: declined.id,
          traceId: request.id,
        });
      }

      const authorized = transition(payment, 'authorized', {
        provider: { name: 'shopstack-psp-sim', reference: result.reference, brand: result.brand, last4: result.last4 },
      });
      await repository.save(authorized);
      paymentsTotal.labels('authorized', 'none').inc();
      amountHistogram.observe(amountCents);
      request.log.info({ paymentId: authorized.id, orderId }, 'payment authorized');
      return reply.code(201).send(authorized);
    },
  );

  app.get('/api/payments/:id', { schema: { response: { 200: paymentSchema } } }, async (request) =>
    findOr404(request.params.id),
  );

  app.get(
    '/api/payments',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { orderId: { type: 'string', minLength: 1, maxLength: 80 } },
        },
      },
    },
    async (request) => {
      if (!request.query.orderId) return { items: [] };
      return { items: await repository.findByOrderId(request.query.orderId) };
    },
  );

  app.post('/api/payments/:id/capture', { schema: { response: { 200: paymentSchema } } }, async (request) => {
    const payment = await findOr404(request.params.id);
    const capturable = assertCapturable(payment);
    if (capturable.status !== 'authorized') return capturable; // idempotent replay
    const captured = transition(payment, 'captured');
    await repository.save(captured);
    paymentsTotal.labels('captured', 'none').inc();
    return captured;
  });

  app.post(
    '/api/payments/:id/refund',
    {
      schema: {
        body: {
          // Refunds may omit the body entirely (full refund), so null is valid.
          type: ['object', 'null'],
          additionalProperties: false,
          properties: { amountCents: { type: 'integer', minimum: 1, maximum: MAX_AMOUNT_CENTS } },
        },
        response: { 200: paymentSchema },
      },
    },
    async (request) => {
      const payment = await findOr404(request.params.id);
      const amountCents = request.body?.amountCents ?? payment.amountCents - payment.refundedCents;
      assertRefundable(payment, amountCents);
      const refundedCents = payment.refundedCents + amountCents;
      const status = refundedCents >= payment.amountCents ? 'refunded' : 'partially_refunded';
      const updated = transition(payment, status, { refundedCents });
      await repository.save(updated);
      paymentsTotal.labels(status, 'none').inc();
      return updated;
    },
  );

  app.post('/api/payments/:id/void', async (request) => {
    const payment = await findOr404(request.params.id);
    if (payment.status === 'voided') return payment;
    if (payment.status !== 'authorized') {
      throw conflict('Payment cannot be voided', `payment is ${payment.status}`, 'payment-not-voidable');
    }
    const voided = transition(payment, 'voided');
    await repository.save(voided);
    return voided;
  });

  // ── PSP webhook ───────────────────────────────────────────────────────────
  app.post('/webhooks/psp', async (request, reply) => {
    try {
      verifyWebhookSignature(request);
    } catch (err) {
      webhookEvents.labels(request.body?.type ?? 'unknown', 'rejected').inc();
      throw err;
    }

    const { id: eventId, type, data } = request.body ?? {};
    if (!eventId || !type || !data?.paymentId) {
      webhookEvents.labels(type ?? 'unknown', 'invalid').inc();
      throw unprocessable('Malformed webhook', 'eventId, type and data.paymentId are required', 'webhook-malformed');
    }

    const payment = await repository.findById(data.paymentId);
    if (!payment) {
      // Acknowledge unknown payments: the PSP must not retry forever because of
      // a payment created in another region or already purged.
      webhookEvents.labels(type, 'ignored').inc();
      return reply.code(202).send({ received: true, ignored: true });
    }

    let updated = payment;
    if (type === 'payment.disputed') {
      updated = transition(payment, payment.status, { failureReason: 'disputed' });
    } else if (type === 'payment.captured' && payment.status === 'authorized') {
      updated = transition(payment, 'captured');
    } else if (type === 'payment.refunded') {
      const refundedCents = Math.min(payment.amountCents, data.refundedCents ?? payment.amountCents);
      updated = transition(payment, refundedCents >= payment.amountCents ? 'refunded' : 'partially_refunded', {
        refundedCents,
      });
    }
    await repository.save(updated);
    webhookEvents.labels(type, 'processed').inc();
    return reply.code(200).send({ received: true, status: updated.status });
  });

  app.get('/internal/stats', async () => repository.stats());

  /** Deterministic processor configuration for demos (never enabled in prod). */
  app.post('/internal/processor/failure-rate', async (request) => {
    if (config.DEPLOYMENT_ENVIRONMENT === 'prod') {
      throw new AppError({
        title: 'Forbidden',
        status: 403,
        code: 'forbidden',
        detail: 'cannot change processor behaviour in prod',
      });
    }
    const rate = Number(request.body?.failureRate ?? 0);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1)
      throw unprocessable('Invalid failure rate', 'must be between 0 and 1');
    processor.failureRate = rate;
    request.log.warn({ failureRate: rate }, 'payment processor failure rate changed');
    return { failureRate: processor.failureRate };
  });
}

/** Never persist a token: keep only a short, non-reversible fingerprint for support. */
function fingerprint(token) {
  return createHmac('sha256', 'shopstack-fingerprint').update(String(token)).digest('hex').slice(0, 12);
}
