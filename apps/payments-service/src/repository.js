/**
 * Payment persistence.
 *
 * Postgres in every real environment: a payment record is financial data and must
 * be durable, auditable and backed up before the pod that created it is gone.
 * The in-memory driver exists so the demo cluster and unit tests run with zero
 * infrastructure — it is never enabled by the prod values file.
 */
import { IdempotencyMismatchError } from './payments.js';

export class MemoryPaymentRepository {
  constructor({ now = () => new Date() } = {}) {
    this.payments = new Map();
    this.byIdempotencyKey = new Map();
    this.now = now;
  }

  async findById(id) {
    return this.payments.get(id) ?? null;
  }

  async findByIdempotencyKey(key) {
    const id = this.byIdempotencyKey.get(key);
    return id ? this.payments.get(id) : null;
  }

  async findByOrderId(orderId) {
    return [...this.payments.values()].filter((p) => p.orderId === orderId);
  }

  async insert(payment) {
    const existing = this.byIdempotencyKey.get(payment.idempotencyKey);
    if (existing) {
      const stored = this.payments.get(existing);
      if (stored.amountCents !== payment.amountCents || stored.orderId !== payment.orderId) {
        throw new IdempotencyMismatchError(
          `key ${payment.idempotencyKey} was already used for ${stored.orderId} / ${stored.amountCents} cents`,
        );
      }
      return stored;
    }
    this.payments.set(payment.id, payment);
    this.byIdempotencyKey.set(payment.idempotencyKey, payment.id);
    return payment;
  }

  async save(payment) {
    this.payments.set(payment.id, payment);
    this.byIdempotencyKey.set(payment.idempotencyKey, payment.id);
    return payment;
  }

  async stats() {
    const all = [...this.payments.values()];
    const byStatus = all.reduce((acc, p) => ({ ...acc, [p.status]: (acc[p.status] ?? 0) + 1 }), {});
    const captured = all.filter((p) => ['captured', 'partially_refunded', 'refunded'].includes(p.status));
    return {
      total: all.length,
      byStatus,
      capturedAmountCents: captured.reduce((sum, p) => sum + p.amountCents - p.refundedCents, 0),
      refundedAmountCents: all.reduce((sum, p) => sum + p.refundedCents, 0),
    };
  }

  async healthCheck() {
    return { ok: true, detail: `in-memory payment store with ${this.payments.size} payments` };
  }

  async close() {}
}

export class PostgresPaymentRepository {
  static async create({ connectionString, logger, pool }) {
    const pg = await import('pg');
    const Pool = pool ?? new pg.default.Pool({ connectionString, max: 10, application_name: 'payments-service' });
    const repo = new PostgresPaymentRepository(Pool, logger);
    await repo.init();
    return repo;
  }

  constructor(pool, logger) {
    this.pool = pool;
    this.logger = logger;
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id              TEXT PRIMARY KEY,
        order_id        TEXT NOT NULL,
        idempotency_key TEXT UNIQUE NOT NULL,
        amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
        currency        CHAR(3) NOT NULL,
        status          TEXT NOT NULL,
        method          JSONB NOT NULL DEFAULT '{}'::jsonb,
        provider        JSONB,
        refunded_cents  INTEGER NOT NULL DEFAULT 0,
        failure_reason  TEXT,
        timeline        JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS payments_order_idx ON payments (order_id);
    `);
  }

  #toRecord(row) {
    return {
      id: row.id,
      orderId: row.order_id,
      idempotencyKey: row.idempotency_key,
      amountCents: row.amount_cents,
      currency: row.currency,
      status: row.status,
      method: row.method,
      provider: row.provider,
      refundedCents: row.refunded_cents,
      failureReason: row.failure_reason,
      timeline: row.timeline,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async findById(id) {
    const { rows } = await this.pool.query('SELECT * FROM payments WHERE id = $1', [id]);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async findByIdempotencyKey(key) {
    const { rows } = await this.pool.query('SELECT * FROM payments WHERE idempotency_key = $1', [key]);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async findByOrderId(orderId) {
    const { rows } = await this.pool.query('SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC', [
      orderId,
    ]);
    return rows.map((row) => this.#toRecord(row));
  }

  async insert(payment) {
    const { rows } = await this.pool.query(
      `INSERT INTO payments (id, order_id, idempotency_key, amount_cents, currency, status, method, provider, timeline)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        payment.id,
        payment.orderId,
        payment.idempotencyKey,
        payment.amountCents,
        payment.currency,
        payment.status,
        payment.method,
        payment.provider,
        JSON.stringify(payment.timeline),
      ],
    );
    if (rows[0]) return this.#toRecord(rows[0]);

    const existing = await this.findByIdempotencyKey(payment.idempotencyKey);
    if (existing.amountCents !== payment.amountCents || existing.orderId !== payment.orderId) {
      throw new IdempotencyMismatchError(
        `key ${payment.idempotencyKey} was already used for ${existing.orderId} / ${existing.amountCents} cents`,
      );
    }
    return existing;
  }

  async save(payment) {
    const { rows } = await this.pool.query(
      `UPDATE payments
          SET status = $2, provider = $3, refunded_cents = $4, failure_reason = $5, timeline = $6, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        payment.id,
        payment.status,
        payment.provider,
        payment.refundedCents,
        payment.failureReason,
        JSON.stringify(payment.timeline),
      ],
    );
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async stats() {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS total,
              COALESCE(sum(CASE WHEN status IN ('captured','partially_refunded','refunded') THEN amount_cents - refunded_cents ELSE 0 END), 0)::int AS captured,
              COALESCE(sum(refunded_cents), 0)::int AS refunded
         FROM payments`,
    );
    const statuses = await this.pool.query('SELECT status, count(*)::int AS count FROM payments GROUP BY status');
    return {
      total: rows[0].total,
      capturedAmountCents: rows[0].captured,
      refundedAmountCents: rows[0].refunded,
      byStatus: Object.fromEntries(statuses.rows.map((r) => [r.status, r.count])),
    };
  }

  async healthCheck() {
    await this.pool.query('SELECT 1');
    return { ok: true, detail: 'postgres reachable' };
  }

  async close() {
    await this.pool.end();
  }
}

export async function createPaymentRepository({ driver, connectionString, logger }) {
  if (driver === 'postgres') return PostgresPaymentRepository.create({ connectionString, logger });
  return new MemoryPaymentRepository();
}
