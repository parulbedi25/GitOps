/**
 * Payment domain.
 *
 * The service models the standard two-step card flow so that checkout can run a
 * saga around it:
 *
 *   authorize  → funds are held on the card (reversible)
 *   capture    → funds are taken (cheque, irreversible)
 *   refund     → full or partial reversal
 *
 * A real integration would delegate to Stripe/Adyen; `SimulatedProcessor` keeps
 * the demo self-contained while implementing the same state machine, the same
 * failure taxonomy, and the same idempotency contract.
 *
 * Idempotency rules (mirroring Stripe's public contract):
 *   - the `Idempotency-Key` header is mandatory for creates;
 *   - replaying the same key with the same payload returns the original payment
 *     and never double-charges;
 *   - replaying the same key with a *different* payload is a client bug → 422.
 */
import { randomUUID } from 'node:crypto';
import { AppError, conflict, notFound, unprocessable } from '@shopstack/telemetry';

export const PAYMENT_STATES = ['requires_confirmation', 'authorized', 'captured', 'declined', 'refunded', 'partially_refunded', 'voided'];

export class SimulatedProcessor {
  /**
   * @param {{failureRate?: number, declineTokens?: Record<string,string>, now?: () => Date, logger?: object}} [opts]
   */
  constructor({ failureRate = 0, declineTokens, now = () => new Date(), logger } = {}) {
    this.failureRate = failureRate;
    this.now = now;
    this.logger = logger;
    this.declineTokens = declineTokens ?? {
      tok_declined: 'insufficient_funds',
      tok_fraud: 'fraud_suspected',
      tok_expired: 'expired_card',
      tok_unsupported: 'card_not_supported',
    };
  }

  /** @returns {{ok: true, reference: string, brand: string, last4: string} | {ok: false, reason: string}} */
  authorize({ token, amountCents }) {
    if (amountCents <= 0) return { ok: false, reason: 'invalid_amount' };
    const declineReason = this.declineTokens[token];
    if (declineReason) return { ok: false, reason: declineReason };

    // Deterministic-outcome knob for game days / canary analysis.
    if (this.failureRate > 0 && Math.random() < this.failureRate) {
      return { ok: false, reason: 'processor_unavailable' };
    }

    const digits = String(token ?? '').replace(/\D/g, '');
    return {
      ok: true,
      reference: `psp_${randomUUID().slice(0, 18)}`,
      brand: detectBrand(digits),
      last4: digits.slice(-4).padStart(4, '0') || '4242',
    };
  }
}

export function detectBrand(digits) {
  if (/^4/.test(digits)) return 'visa';
  if (/^5[1-5]/.test(digits)) return 'mastercard';
  if (/^3[47]/.test(digits)) return 'amex';
  if (/^6/.test(digits)) return 'discover';
  return 'card';
}

/** Payment record factory. */
export function newPayment({ orderId, amountCents, currency, idempotencyKey, method }) {
  const now = new Date().toISOString();
  return {
    id: `pay_${randomUUID()}`,
    orderId,
    idempotencyKey,
    amountCents,
    currency,
    refundedCents: 0,
    status: 'requires_confirmation',
    method,
    provider: null,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
    timeline: [{ status: 'requires_confirmation', at: now }],
  };
}

export function transition(payment, status, patch = {}) {
  const now = new Date().toISOString();
  return {
    ...payment,
    ...patch,
    status,
    updatedAt: now,
    timeline: [...payment.timeline, { status, at: now, ...(patch.failureReason ? { reason: patch.failureReason } : {}) }],
  };
}

/** Refund guard rails: never refund more than was captured, never double-refund. */
export function assertRefundable(payment, amountCents) {
  if (!['captured', 'partially_refunded'].includes(payment.status)) {
    throw conflict('Payment not refundable', `payment is ${payment.status}`, 'payment-not-refundable');
  }
  const remaining = payment.amountCents - payment.refundedCents;
  if (amountCents > remaining) {
    throw unprocessable('Refund exceeds captured amount', `only ${remaining} cents remain refundable`, 'refund-exceeds-captured');
  }
}

export function assertCapturable(payment) {
  if (payment.status === 'captured' || payment.status === 'partially_refunded') return payment; // idempotent capture
  if (payment.status !== 'authorized') {
    throw conflict('Payment cannot be captured', `payment is ${payment.status}`, 'payment-not-capturable');
  }
  return payment;
}

export function findByIdOrThrow(repositoryResult, id) {
  if (!repositoryResult) throw notFound('Payment', id);
  return repositoryResult;
}

export class IdempotencyMismatchError extends AppError {
  constructor(detail) {
    super({ title: 'Idempotency key reuse', status: 422, code: 'idempotency-key-reuse', detail });
  }
}
