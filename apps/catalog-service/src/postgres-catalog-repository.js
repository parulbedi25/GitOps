/**
 * Postgres-backed catalog repository.
 *
 * Enabled by setting `DATABASE_URL` + `DB_DRIVER=postgres` (see gitops values).
 * Selected in production so inventory survives pod restarts and canary rollouts —
 * an in-memory store would lose stock reservations every time Argo Rollouts
 * replaced a ReplicaSet.
 *
 * Concurrency notes:
 *  - reservations lock product rows with `SELECT … FOR UPDATE` in a deterministic
 *    (id-sorted) order to avoid deadlocks between concurrent baskets;
 *  - lock acquisition happens inside a single transaction, so a partial basket
 *    can never decrement stock;
 *  - `order_id` is UNIQUE, which makes saga retries idempotent at the database
 *    level rather than in application memory.
 */
import pg from 'pg';
import { InsufficientStockError, RESERVATION_TTL_MS } from './catalog.js';
import { notFound } from '@shopstack/telemetry';

const { Pool } = pg;

const SORT_SQL = {
  relevance: 'featured DESC, rating DESC, name ASC',
  price_asc: 'price_cents ASC',
  price_desc: 'price_cents DESC',
  rating: 'rating DESC, review_count DESC',
  newest: 'created_at DESC, id DESC',
};

const toProduct = (row) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  description: row.description,
  category: row.category,
  priceCents: row.price_cents,
  currency: row.currency,
  stock: row.stock,
  rating: Number(row.rating),
  reviewCount: row.review_count,
  tags: row.tags ?? [],
  featured: row.featured,
});

export class PostgresCatalogRepository {
  static async create({ connectionString, logger, pool }) {
    const repo = new PostgresCatalogRepository(pool ?? new Pool({
      connectionString,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 3_000,
      application_name: 'catalog-service',
    }), logger);
    await repo.pool.query('SELECT 1');
    return repo;
  }

  constructor(pool, logger) {
    this.pool = pool;
    this.logger = logger;
  }

  async list({ category, q, limit = 12, offset = 0, sort = 'relevance', inStockOnly = false } = {}) {
    const where = [];
    const values = [];
    if (category) {
      values.push(category);
      where.push(`category = $${values.length}`);
    }
    if (inStockOnly) where.push('stock > 0');
    if (q) {
      values.push(`%${q}%`);
      where.push(`(name ILIKE $${values.length} OR description ILIKE $${values.length} OR array_to_string(tags, ' ') ILIKE $${values.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = SORT_SQL[sort] ?? SORT_SQL.relevance;

    const [rows, count] = await Promise.all([
      this.pool.query(
        `SELECT * FROM products ${whereSql} ORDER BY ${orderSql} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset],
      ),
      this.pool.query(`SELECT count(*)::int AS total FROM products ${whereSql}`, values),
    ]);

    return { items: rows.rows.map(toProduct), total: count.rows[0].total, limit, offset };
  }

  async get(idOrSlug) {
    const { rows } = await this.pool.query('SELECT * FROM products WHERE id = $1 OR slug = $1 LIMIT 1', [idOrSlug]);
    return rows[0] ? toProduct(rows[0]) : null;
  }

  async related(product, limit = 4) {
    const { rows } = await this.pool.query(
      'SELECT * FROM products WHERE category = $1 AND id <> $2 ORDER BY rating DESC LIMIT $3',
      [product.category, product.id, limit],
    );
    return rows.rows.map(toProduct);
  }

  async categories() {
    const { rows } = await this.pool.query(
      `SELECT c.slug, c.name, count(p.id)::int AS count
         FROM categories c LEFT JOIN products p ON p.category = c.slug
        GROUP BY c.slug, c.name ORDER BY c.name`,
    );
    return rows;
  }

  /** Releases reservations whose TTL elapsed, returning stock to the shelf. */
  async #releaseExpired(client) {
    await client.query(
      `UPDATE products p
          SET stock = p.stock + i.quantity, updated_at = now()
         FROM stock_reservation_items i
         JOIN stock_reservations r ON r.id = i.reservation_id
        WHERE i.product_id = p.id AND r.status = 'pending' AND r.expires_at < now()`,
    );
    await client.query(`UPDATE stock_reservations SET status = 'released' WHERE status = 'pending' AND expires_at < now()`);
  }

  async reserve({ orderId, items, ttlMs = RESERVATION_TTL_MS }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#releaseExpired(client);

      const replay = await client.query('SELECT * FROM stock_reservations WHERE order_id = $1', [orderId]);
      if (replay.rows[0]) {
        await client.query('COMMIT');
        return this.#withItems(replay.rows[0], client);
      }

      const quantities = new Map();
      for (const line of items) {
        quantities.set(line.productId, (quantities.get(line.productId) ?? 0) + line.quantity);
      }
      const ids = [...quantities.keys()].sort();

      const { rows } = await client.query(
        'SELECT id, stock FROM products WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE',
        [ids],
      );
      const available = new Map(rows.map((r) => [r.id, r.stock]));
      const shortages = ids
        .map((id) => ({ productId: id, requested: quantities.get(id), available: available.get(id) ?? 0 }))
        .filter((line) => line.available < line.requested);

      if (shortages.length > 0) {
        await client.query('ROLLBACK');
        throw new InsufficientStockError(shortages);
      }

      const reservationId = `res-${orderId}`;
      const reservation = await client.query(
        `INSERT INTO stock_reservations (id, order_id, status, expires_at)
         VALUES ($1, $2, 'pending', now() + ($3 || ' milliseconds')::interval)
         RETURNING *`,
        [reservationId, orderId, String(ttlMs)],
      );

      for (const id of ids) {
        await client.query('UPDATE products SET stock = stock - $2, updated_at = now() WHERE id = $1', [id, quantities.get(id)]);
        await client.query(
          'INSERT INTO stock_reservation_items (reservation_id, product_id, quantity) VALUES ($1, $2, $3)',
          [reservationId, id, quantities.get(id)],
        );
      }

      await client.query('COMMIT');
      return this.#withItems(reservation.rows[0], client);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async #withItems(row, client = this.pool) {
    const { rows } = await client.query('SELECT product_id, quantity FROM stock_reservation_items WHERE reservation_id = $1', [row.id]);
    return {
      id: row.id,
      orderId: row.order_id,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      expiresAt: new Date(row.expires_at).getTime(),
      items: rows.map((r) => ({ productId: r.product_id, quantity: r.quantity })),
    };
  }

  async commit(reservationId) {
    const { rows } = await this.pool.query(
      `UPDATE stock_reservations SET status = 'committed' WHERE id = $1 AND status = 'pending' RETURNING *`,
      [reservationId],
    );
    if (!rows[0]) {
      const existing = await this.pool.query('SELECT * FROM stock_reservations WHERE id = $1', [reservationId]);
      if (!existing.rows[0]) throw notFound('Reservation', reservationId);
      return { id: reservationId, status: existing.rows[0].status };
    }
    return { id: reservationId, status: 'committed' };
  }

  async release(reservationId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE stock_reservations SET status = 'released' WHERE id = $1 AND status = 'pending' RETURNING *`,
        [reservationId],
      );
      if (rows[0]) {
        await client.query(
          `UPDATE products p SET stock = p.stock + i.quantity, updated_at = now()
             FROM stock_reservation_items i
            WHERE i.reservation_id = $1 AND i.product_id = p.id`,
          [reservationId],
        );
      } else {
        const existing = await client.query('SELECT status FROM stock_reservations WHERE id = $1', [reservationId]);
        if (!existing.rows[0]) {
          await client.query('ROLLBACK');
          throw notFound('Reservation', reservationId);
        }
      }
      await client.query('COMMIT');
      return { id: reservationId, status: rows[0] ? 'released' : 'unchanged' };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async stats() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#releaseExpired(client);
      const { rows } = await client.query(
        `SELECT count(*)::int AS products,
                count(*) FILTER (WHERE stock > 0 AND stock <= 5)::int AS low_stock,
                count(*) FILTER (WHERE stock = 0)::int AS out_of_stock,
                COALESCE(sum(stock), 0)::int AS total_units
           FROM products`,
      );
      const reservations = await client.query(
        `SELECT count(*)::int AS pending FROM stock_reservations WHERE status = 'pending'`,
      );
      const categories = await client.query('SELECT count(*)::int AS total FROM categories');
      await client.query('COMMIT');
      return {
        products: rows[0].products,
        categories: categories.rows[0].total,
        totalUnits: rows[0].total_units,
        lowStock: rows[0].low_stock,
        outOfStock: rows[0].out_of_stock,
        pendingReservations: reservations.rows[0].pending,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async healthCheck() {
    const started = Date.now();
    await this.pool.query('SELECT 1');
    return { ok: true, detail: `postgres reachable in ${Date.now() - started}ms` };
  }

  async close() {
    await this.pool.end();
  }
}
