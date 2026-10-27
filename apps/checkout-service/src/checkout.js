/**
 * Checkout saga.
 *
 * Placing an order touches three services and five stateful resources. There is
 * no distributed transaction available, so we use a **saga with compensations**:
 * every step that changes state registers the action that undoes it, and if a
 * later step fails the compensations run in reverse order.
 *
 *   1. load cart            (read)        — no compensation
 *   2. lock cart            (cart)        → unlock
 *   3. reserve stock        (catalog)     → release reservation
 *   4. authorise payment    (payments)    → void authorisation
 *   5. capture payment      (payments)    → refund
 *   6. persist order        (postgres)    — terminal step
 *
 * The two properties that make this safe in production:
 *
 *  - **Idempotency keyed by the client.** A retried request (double-clicked "Pay",
 *    a load balancer timeout, an Argo Rollouts retry) returns the original order
 *    instead of charging the customer twice. Concurrent replays are coalesced
 *    in-process and enforced by a UNIQUE constraint in the database.
 *  - **Compensation is idempotent too.** Releasing stock twice, voiding twice or
 *    refunding twice is a no-op, so a retry of the compensation loop is safe.
 */
import { randomUUID } from 'node:crypto';
import { AppError, conflict, notFound, unprocessable } from '@shopstack/telemetry';

export const ORDER_STATUS = { CONFIRMED: 'confirmed', CANCELLED: 'cancelled', FAILED: 'failed' };

export class CheckoutService {
  constructor({ repository, cartClient, catalogClient, paymentsClient, metrics, logger, clock = () => new Date(), idFactory = () => `ord_${randomUUID()}` }) {
    this.repository = repository;
    this.cart = cartClient;
    this.catalog = catalogClient;
    this.payments = paymentsClient;
    this.metrics = metrics;
    this.logger = logger;
    this.clock = clock;
    this.idFactory = idFactory;
    this.inFlight = new Map();

    this.ordersTotal = metrics.counter('shopstack_orders_total', 'Orders by terminal status.', ['status']);
    this.sagaDuration = metrics.histogram(
      'shopstack_checkout_saga_duration_seconds',
      'End-to-end checkout saga duration.',
      ['outcome'],
      [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    );
    this.stepDuration = metrics.histogram(
      'shopstack_checkout_step_duration_seconds',
      'Duration of each saga step.',
      ['step', 'outcome'],
      [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    );
    this.compensations = metrics.counter('shopstack_saga_compensations_total', 'Compensations executed by step.', ['step', 'result']);
    this.inflightGauge = metrics.gauge('shopstack_checkout_inflight', 'Checkout sagas currently in flight (saturation signal).');
    this.orderValue = metrics.histogram(
      'shopstack_order_value_cents',
      'Order value of confirmed orders.',
      [],
      [1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000],
    );
  }

  /** Wraps a step with timing, logging and failure classification. */
  async #step(order, name, fn, { critical = true } = {}) {
    const started = process.hrtime.bigint();
    try {
      const result = await fn();
      this.stepDuration.labels(name, 'success').observe(Number(process.hrtime.bigint() - started) / 1e9);
      order.timeline.push({ step: name, status: 'succeeded', at: this.clock().toISOString() });
      return result;
    } catch (err) {
      this.stepDuration.labels(name, 'failure').observe(Number(process.hrtime.bigint() - started) / 1e9);
      order.timeline.push({
        step: name,
        status: 'failed',
        at: this.clock().toISOString(),
        detail: err.code ?? err.name,
      });
      if (critical) this.logger.warn({ err, step: name, orderId: order.id }, 'checkout step failed');
      throw err;
    }
  }

  /**
   * @param {object} input
   * @param {string} input.idempotencyKey
   * @param {string} input.cartId
   * @param {{email: string, name: string}} input.customer
   * @param {object} input.shippingAddress
   * @param {{type: string, token: string}} input.paymentMethod
   */
  async checkout({ idempotencyKey, cartId, customer, shippingAddress, paymentMethod, traceId }) {
    const replay = await this.repository.findByIdempotencyKey(idempotencyKey);
    if (replay) return { order: replay, replayed: true };

    // Coalesce concurrent replays of the same key inside this pod. The database
    // UNIQUE constraint catches the multi-pod case.
    if (this.inFlight.has(idempotencyKey)) return this.inFlight.get(idempotencyKey);

    const promise = this.#run({ idempotencyKey, cartId, customer, shippingAddress, paymentMethod, traceId }).finally(() =>
      this.inFlight.delete(idempotencyKey),
    );
    this.inFlight.set(idempotencyKey, promise);
    return promise;
  }

  async #run(input) {
    const sagaId = `saga_${randomUUID()}`;
    const { traceId } = input;
    const orderId = this.idFactory();
    const startedAt = process.hrtime.bigint();
    const order = {
      id: orderId,
      sagaId,
      idempotencyKey: input.idempotencyKey,
      cartId: input.cartId,
      customer: input.customer,
      shippingAddress: input.shippingAddress,
      items: [],
      pricing: null,
      status: 'processing',
      payment: null,
      reservationId: null,
      timeline: [],
      createdAt: this.clock().toISOString(),
      updatedAt: this.clock().toISOString(),
    };

    /** @type {Array<{step: string, run: () => Promise<unknown>}>} */
    const compensations = [];
    this.inflightGauge.inc();
    const inFlightTokens = { released: false };
    const releaseToken = () => {
      if (!inFlightTokens.released) {
        inFlightTokens.released = true;
        this.inflightGauge.dec();
      }
    };

    try {
      // 1 ── read the authoritative cart snapshot
      const snapshot = await this.#step(order, 'load_cart', () => this.cart.get(`/internal/carts/${encodeURIComponent(input.cartId)}`));
      if (!snapshot?.cart?.items?.length) {
        throw unprocessable('Cart is empty', 'add at least one item before checking out', 'cart-empty');
      }
      if (snapshot.cart.status === 'locked') {
        throw conflict('Cart is being checked out', 'another checkout is already in progress for this cart', 'cart-locked');
      }

      order.items = snapshot.cart.items.map((item) => ({
        productId: item.productId,
        slug: item.slug,
        name: item.name,
        image: item.image,
        unitPriceCents: item.unitPriceCents,
        quantity: item.quantity,
        lineTotalCents: item.unitPriceCents * item.quantity,
      }));
      order.pricing = snapshot.totals;
      // Trust the server-computed total, never a client-supplied amount.
      const amountCents = snapshot.totals.totalCents;

      // 2 ── lock the cart so it cannot change while we charge
      await this.#step(order, 'lock_cart', () => this.cart.post(`/internal/carts/${encodeURIComponent(input.cartId)}/lock`));
      compensations.push({ step: 'lock_cart', run: () => this.cart.post(`/internal/carts/${encodeURIComponent(input.cartId)}/unlock`) });

      // 3 ── reserve inventory
      const reservation = await this.#step(order, 'reserve_stock', () =>
        this.catalog.post('/internal/stock/reservations', {
          orderId,
          items: order.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        }),
      );
      order.reservationId = reservation.id;
      compensations.push({ step: 'reserve_stock', run: () => this.catalog.post(`/internal/stock/reservations/${reservation.id}/release`) });

      // 4 ── authorise the card (idempotent on the order id)
      const payment = await this.#step(order, 'authorize_payment', () =>
        this.payments.post(
          '/api/payments',
          {
            orderId,
            amountCents,
            currency: snapshot.totals.currency,
            customerEmail: input.customer.email,
            paymentMethod: input.paymentMethod,
          },
          { idempotencyKey: `pay-${orderId}` },
        ),
      );
      order.payment = { id: payment.id, status: payment.status, method: payment.method, provider: payment.provider };
      compensations.push({
        step: 'authorize_payment',
        // Void releases a hold. If the authorisation was in fact captured (for
        // example our capture timed out but the PSP processed it), void returns
        // 409 and the correct compensation is a refund — otherwise the customer
        // pays for an order that never existed.
        run: async () => {
          try {
            await this.payments.post(`/api/payments/${payment.id}/void`);
          } catch (voidError) {
            this.logger.warn({ err: voidError, paymentId: payment.id }, 'void failed; falling back to refund');
            await this.payments.post(`/api/payments/${payment.id}/refund`);
          }
        },
      });

      // 5 ── capture the funds
      const captured = await this.#step(order, 'capture_payment', () =>
        this.payments.post(`/api/payments/${payment.id}/capture`),
      );
      order.payment.status = captured.status;
      compensations.push({ step: 'capture_payment', run: () => this.payments.post(`/api/payments/${payment.id}/refund`) });

      // 6 ── commit the reservation, persist and release the cart
      await this.#step(order, 'commit_stock', () => this.catalog.post(`/internal/stock/reservations/${reservation.id}/commit`), {
        critical: false,
      });

      order.status = ORDER_STATUS.CONFIRMED;
      order.updatedAt = this.clock().toISOString();
      order.timeline.push({ step: 'persist_order', status: 'succeeded', at: this.clock().toISOString() });
      const saved = await this.repository.insert(order);

      // Post-commit cleanup is best effort: the order is already paid for, so a
      // failure here must never turn a successful checkout into an error.
      try {
        await this.cart.post(`/internal/carts/${encodeURIComponent(input.cartId)}/clear`);
      } catch (err) {
        this.logger.warn({ err, orderId }, 'failed to clear cart after checkout');
      }

      this.ordersTotal.labels(ORDER_STATUS.CONFIRMED).inc();
      this.orderValue.observe(amountCents);
      this.sagaDuration.labels('success').observe(Number(process.hrtime.bigint() - startedAt) / 1e9);
      this.logger.info({ orderId, sagaId, amountCents, traceId }, 'order confirmed');
      return { order: saved, replayed: false };
    } catch (err) {
      const compensated = await this.#compensate(compensations, order, sagaId);
      this.ordersTotal.labels(ORDER_STATUS.FAILED).inc();
      this.sagaDuration.labels('failure').observe(Number(process.hrtime.bigint() - startedAt) / 1e9);

      // Persist a failed attempt for support/debugging, without binding the
      // idempotency key so that the customer can retry.
      order.status = ORDER_STATUS.FAILED;
      order.idempotencyKey = null;
      order.failure = { code: err.code ?? 'internal-error', message: err.message, compensatedSteps: compensated };
      order.updatedAt = this.clock().toISOString();
      await this.repository.insert(order).catch((persistError) => {
        this.logger.error({ err: persistError, orderId }, 'failed to persist failed order attempt');
      });

      this.logger.error({ err, orderId, sagaId, traceId, compensated }, 'checkout failed');
      if (err instanceof AppError) {
        err.detail = err.detail ?? `checkout failed at a downstream step (order ${orderId})`;
        err.orderId = orderId;
        throw err;
      }
      throw new AppError({
        title: 'Checkout failed',
        status: 502,
        code: 'checkout-failed',
        detail: `could not complete the order (orderId ${orderId})`,
        cause: err,
      });
    } finally {
      releaseToken();
    }
  }

  /** Runs compensations in reverse order; never throws. */
  async #compensate(compensations, order, sagaId) {
    const completed = [];
    for (const compensation of [...compensations].reverse()) {
      try {
        await compensation.run();
        completed.push(compensation.step);
        this.compensations.labels(compensation.step, 'success').inc();
        order.timeline.push({ step: `compensate_${compensation.step}`, status: 'succeeded', at: this.clock().toISOString() });
      } catch (err) {
        this.compensations.labels(compensation.step, 'failure').inc();
        // A failed compensation means money or stock is stuck: this is exactly
        // the alert that pages the on-call engineer (see ShopStackSagaCompensationFailing).
        this.logger.error({ err, step: compensation.step, sagaId }, 'compensation failed — manual reconciliation required');
        order.timeline.push({ step: `compensate_${compensation.step}`, status: 'failed', at: this.clock().toISOString() });
      }
    }
    return completed;
  }

  async getOrder(orderId) {
    const order = await this.repository.findById(orderId);
    if (!order) throw notFound('Order', orderId);
    return order;
  }

  async listOrders({ customerEmail, limit = 20, offset = 0 }) {
    const result = await this.repository.list({ customerEmail, limit, offset });
    return { items: result.items, total: result.total, limit, offset };
  }

  /**
   * Customer-initiated cancellation: refund what was captured and return the
   * stock. Idempotent, so a retried cancel cannot refund twice.
   */
  async cancelOrder(orderId, reason = 'customer_request') {
    const order = await this.getOrder(orderId);
    if (order.status === ORDER_STATUS.CANCELLED) return order;
    if (order.status !== ORDER_STATUS.CONFIRMED) {
      throw conflict('Order cannot be cancelled', `order is ${order.status}`, 'order-not-cancellable');
    }

    const steps = [];
    if (order.payment?.id) {
      await this.#guarded('refund_payment', () => this.payments.post(`/api/payments/${order.payment.id}/refund`), steps);
      order.payment.status = 'refunded';
    }
    if (order.reservationId) {
      await this.#guarded('release_stock', () => this.catalog.post(`/internal/stock/reservations/${order.reservationId}/release`), steps);
    }

    order.status = ORDER_STATUS.CANCELLED;
    order.cancellation = { reason, at: this.clock().toISOString(), steps };
    order.updatedAt = this.clock().toISOString();
    order.timeline.push({ step: 'cancel_order', status: 'succeeded', at: order.cancellation.at, detail: reason });
    await this.repository.save(order);
    this.ordersTotal.labels(ORDER_STATUS.CANCELLED).inc();
    return order;
  }

  async #guarded(step, fn, sink) {
    try {
      await fn();
      sink.push({ step, status: 'succeeded' });
    } catch (err) {
      this.logger.error({ err, step }, 'cancellation step failed');
      sink.push({ step, status: 'failed', detail: err.code ?? err.message });
    }
  }
}
