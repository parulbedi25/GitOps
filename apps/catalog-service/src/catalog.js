/**
 * Catalog domain: product queries and the inventory reservation protocol.
 *
 * The reservation protocol is the part that matters for correctness. Checkout
 * runs a saga across catalog (reserve stock), payments (authorise) and itself
 * (persist the order). Any step can fail, so reservations must be:
 *
 *   - idempotent on `orderId` — saga retries must not double-decrement stock;
 *   - expirable/compensatable — a failed payment releases the hold;
 *   - atomic per order — either every line is reserved or none is.
 *
 * All three guarantees live in the repository implementations (memory + Postgres)
 * so the HTTP layer stays thin and both storages behave identically.
 */
import { AppError, conflict, notFound } from '@shopstack/telemetry';

export class InsufficientStockError extends AppError {
  constructor(details) {
    super({
      title: 'Insufficient stock',
      status: 409,
      code: 'out-of-stock',
      detail: details,
    });
  }
}

export const RESERVATION_TTL_MS = 15 * 60 * 1000;

const SORTERS = {
  relevance: null,
  price_asc: (a, b) => a.priceCents - b.priceCents,
  price_desc: (a, b) => b.priceCents - a.priceCents,
  rating: (a, b) => b.rating - a.rating,
  newest: (a, b) => b.id.localeCompare(a.id),
};

/** In-memory implementation used by dev, tests and the reference demo cluster. */
export class MemoryCatalogRepository {
  constructor({ products, categories, reservationTtlMs = RESERVATION_TTL_MS, now = () => Date.now() }) {
    this.products = products.map((p) => ({ ...p }));
    // Named `categoryList`, not `categories`: an instance field would shadow the
    // `categories()` method on the prototype and every call would throw.
    this.categoryList = categories;
    this.reservations = new Map();
    this.reservationTtlMs = reservationTtlMs;
    this.now = now;
  }

  async list({ category, q, limit = 12, offset = 0, sort = 'relevance', inStockOnly = false } = {}) {
    let items = this.products;
    if (category) items = items.filter((p) => p.category === category);
    if (inStockOnly) items = items.filter((p) => p.stock > 0);
    if (q) {
      const needle = q.toLowerCase();
      items = items.filter((p) =>
        [p.name, p.description, ...(p.tags ?? [])].some((field) => field.toLowerCase().includes(needle)),
      );
    }
    const total = items.length;
    const sorter = SORTERS[sort] ?? null;
    const ordered = sorter ? [...items].sort(sorter) : items;
    return { items: ordered.slice(offset, offset + limit), total, limit, offset };
  }

  async get(idOrSlug) {
    return this.products.find((p) => p.id === idOrSlug || p.slug === idOrSlug) ?? null;
  }

  async related(product, limit = 4) {
    return this.products
      .filter((p) => p.category === product.category && p.id !== product.id)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, limit);
  }

  async categories() {
    return this.categoryList.map((c) => ({
      ...c,
      count: this.products.filter((p) => p.category === c.slug).length,
    }));
  }

  #gcExpired() {
    for (const [id, reservation] of this.reservations) {
      if (reservation.status === 'pending' && reservation.expiresAt <= this.now()) {
        this.#releaseInternal(reservation);
        void id;
      }
    }
  }

  #releaseInternal(reservation) {
    for (const line of reservation.items) {
      const product = this.products.find((p) => p.id === line.productId);
      if (product) product.stock += line.quantity;
    }
    reservation.status = 'released';
  }

  /**
   * Atomically reserves stock for every line, or rejects with the offending lines.
   * Idempotent: replaying the same orderId returns the original reservation.
   */
  async reserve({ orderId, items }) {
    this.#gcExpired();
    const existing = [...this.reservations.values()].find((r) => r.orderId === orderId);
    if (existing) {
      if (existing.status === 'pending' || existing.status === 'committed') return existing;
      throw conflict(
        'Reservation already released',
        `order ${orderId} previously released its stock`,
        'reservation-released',
      );
    }

    const shortages = [];
    const seen = new Map();
    for (const line of items) {
      const quantity = (seen.get(line.productId) ?? 0) + line.quantity;
      seen.set(line.productId, quantity);
      const product = this.products.find((p) => p.id === line.productId || p.slug === line.productId);
      if (!product) {
        shortages.push({ productId: line.productId, requested: quantity, available: 0, reason: 'unknown-product' });
        continue;
      }
      if (product.stock < quantity) {
        shortages.push({
          productId: product.id,
          requested: quantity,
          available: product.stock,
          reason: 'insufficient-stock',
        });
      }
    }
    if (shortages.length > 0) throw new InsufficientStockError(shortages);

    const reservation = {
      id: `res-${orderId}`,
      orderId,
      status: 'pending',
      items: [...seen.entries()].map(([productId, quantity]) => ({ productId, quantity })),
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: this.now() + this.reservationTtlMs,
    };
    for (const line of reservation.items) {
      const product = this.products.find((p) => p.id === line.productId);
      product.stock -= line.quantity;
    }
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  async commit(reservationId) {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw notFound('Reservation', reservationId);
    reservation.status = 'committed';
    return reservation;
  }

  async release(reservationId) {
    this.#gcExpired();
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw notFound('Reservation', reservationId);
    if (reservation.status === 'pending') this.#releaseInternal(reservation);
    return { id: reservationId, status: reservation.status };
  }

  async stats() {
    this.#gcExpired();
    const lowStock = this.products.filter((p) => p.stock > 0 && p.stock <= 5).length;
    const outOfStock = this.products.filter((p) => p.stock === 0).length;
    const pending = [...this.reservations.values()].filter((r) => r.status === 'pending').length;
    return {
      products: this.products.length,
      categories: this.categoryList.length,
      totalUnits: this.products.reduce((sum, p) => sum + p.stock, 0),
      lowStock,
      outOfStock,
      pendingReservations: pending,
    };
  }

  async healthCheck() {
    return { ok: true, detail: `in-memory store with ${this.products.length} products` };
  }

  async close() {}
}

export function createRepository({ driver, connectionString, logger, products, categories }) {
  if (driver === 'memory') {
    return Promise.resolve(new MemoryCatalogRepository({ products, categories }));
  }
  return import('./postgres-catalog-repository.js').then(({ PostgresCatalogRepository }) =>
    PostgresCatalogRepository.create({ connectionString, logger }),
  );
}
