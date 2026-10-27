/**
 * Order persistence.
 *
 * Orders are the system of record for revenue: durable, auditable, and keyed by a
 * UNIQUE idempotency key so that two racing pods cannot both create an order for
 * the same checkout attempt.
 */
export class MemoryOrderRepository {
  constructor() {
    this.orders = new Map();
    this.idempotency = new Map();
  }

  async insert(order) {
    if (order.idempotencyKey) {
      const existingId = this.idempotency.get(order.idempotencyKey);
      if (existingId) return this.orders.get(existingId);
      this.idempotency.set(order.idempotencyKey, order.id);
    }
    this.orders.set(order.id, order);
    return order;
  }

  async save(order) {
    this.orders.set(order.id, order);
    return order;
  }

  async findById(orderId) {
    return this.orders.get(orderId) ?? null;
  }

  async findByIdempotencyKey(key) {
    const id = this.idempotency.get(key);
    return id ? this.orders.get(id) : null;
  }

  async list({ customerEmail, limit = 20, offset = 0 } = {}) {
    let items = [...this.orders.values()];
    if (customerEmail) items = items.filter((o) => o.customer?.email?.toLowerCase() === customerEmail.toLowerCase());
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items: items.slice(offset, offset + limit), total: items.length };
  }

  async stats() {
    const all = [...this.orders.values()];
    const confirmed = all.filter((o) => o.status === 'confirmed');
    const revenueCents = confirmed.reduce((sum, o) => sum + (o.pricing?.totalCents ?? 0), 0);
    return {
      total: all.length,
      byStatus: all.reduce((acc, o) => ({ ...acc, [o.status]: (acc[o.status] ?? 0) + 1 }), {}),
      revenueCents,
      averageOrderValueCents: confirmed.length ? Math.round(revenueCents / confirmed.length) : 0,
      itemsSold: confirmed.reduce((sum, o) => sum + o.items.reduce((n, i) => n + i.quantity, 0), 0),
    };
  }

  async healthCheck() {
    return { ok: true, detail: `in-memory order store with ${this.orders.size} orders` };
  }

  async close() {}
}

export class PostgresOrderRepository {
  static async create({ connectionString, logger, pool }) {
    const pg = await import('pg');
    const Pool = pool ?? new pg.default.Pool({ connectionString, max: 10, application_name: 'checkout-service' });
    const repo = new PostgresOrderRepository(Pool, logger);
    await repo.init();
    return repo;
  }

  constructor(pool, logger) {
    this.pool = pool;
    this.logger = logger;
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id              TEXT PRIMARY KEY,
        saga_id         TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        cart_id         TEXT NOT NULL,
        customer        JSONB NOT NULL,
        shipping_address JSONB NOT NULL,
        items           JSONB NOT NULL DEFAULT '[]'::jsonb,
        pricing         JSONB NOT NULL DEFAULT '{}'::jsonb,
        status          TEXT NOT NULL,
        payment         JSONB,
        reservation_id  TEXT,
        timeline        JSONB NOT NULL DEFAULT '[]'::jsonb,
        cancellation    JSONB,
        failure         JSONB,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders ((customer->>'email'));
      CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);
    `);
  }

  #toRecord(row) {
    return {
      id: row.id,
      sagaId: row.saga_id,
      idempotencyKey: row.idempotency_key,
      cartId: row.cart_id,
      customer: row.customer,
      shippingAddress: row.shipping_address,
      items: row.items,
      pricing: row.pricing,
      status: row.status,
      payment: row.payment,
      reservationId: row.reservation_id,
      timeline: row.timeline,
      cancellation: row.cancellation,
      failure: row.failure,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async insert(order) {
    const { rows } = await this.pool.query(
      `INSERT INTO orders (id, saga_id, idempotency_key, cart_id, customer, shipping_address, items, pricing, status, payment, reservation_id, timeline, failure)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        order.id,
        order.sagaId,
        order.idempotencyKey,
        order.cartId,
        order.customer,
        order.shippingAddress,
        JSON.stringify(order.items),
        order.pricing,
        order.status,
        order.payment,
        order.reservationId,
        JSON.stringify(order.timeline),
        order.failure ?? null,
      ],
    );
    if (rows[0]) return this.#toRecord(rows[0]);

    // Lost the race against another pod: return the winner's order.
    const existing = await this.findByIdempotencyKey(order.idempotencyKey);
    if (existing) return existing;
    throw new Error(`failed to persist order ${order.id}`);
  }

  async save(order) {
    const { rows } = await this.pool.query(
      `UPDATE orders
          SET status = $2, payment = $3, timeline = $4, cancellation = $5, failure = $6, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [order.id, order.status, order.payment, JSON.stringify(order.timeline), order.cancellation ?? null, order.failure ?? null],
    );
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async findById(orderId) {
    const { rows } = await this.pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async findByIdempotencyKey(key) {
    const { rows } = await this.pool.query('SELECT * FROM orders WHERE idempotency_key = $1', [key]);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async list({ customerEmail, limit = 20, offset = 0 } = {}) {
    const where = customerEmail ? `WHERE lower(customer->>'email') = lower($3)` : '';
    const params = customerEmail ? [limit, offset, customerEmail] : [limit, offset];
    const [rows, count] = await Promise.all([
      this.pool.query(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`, params),
      this.pool.query(`SELECT count(*)::int AS total FROM orders ${customerEmail ? `WHERE lower(customer->>'email') = lower($1)` : ''}`, customerEmail ? [customerEmail] : []),
    ]);
    return { items: rows.rows.map((row) => this.#toRecord(row)), total: count.rows[0].total };
  }

  async stats() {
    const { rows } = await this.pool.query(
      `SELECT status, count(*)::int AS count,
              COALESCE(sum((pricing->>'totalCents')::int), 0)::int AS revenue,
              COALESCE(sum(jsonb_array_length(items)), 0)::int AS lines
         FROM orders GROUP BY status`,
    );
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.count]));
    const confirmed = rows.find((r) => r.status === 'confirmed');
    const revenueCents = confirmed?.revenue ?? 0;
    return {
      total: rows.reduce((sum, r) => sum + r.count, 0),
      byStatus,
      revenueCents,
      averageOrderValueCents: confirmed?.count ? Math.round(revenueCents / confirmed.count) : 0,
      itemsSold: confirmed?.lines ?? 0,
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

export async function createOrderRepository({ driver, connectionString, logger }) {
  if (driver === 'postgres') return PostgresOrderRepository.create({ connectionString, logger });
  return new MemoryOrderRepository();
}
