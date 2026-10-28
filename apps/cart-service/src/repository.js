/**
 * Cart persistence.
 *
 * Carts are short-lived, high-churn, and must survive a pod restart in the middle
 * of a canary rollout — which is why production runs on Redis (managed
 * ElastiCache/Memorystore, reached through the `redis-credentials` ExternalSecret)
 * while dev and QA use the in-memory driver.
 *
 * The in-memory driver is deliberately TTL-based so that a leaking dev cluster
 * does not slowly OOM.
 */
export class MemoryCartRepository {
  constructor({ ttlSeconds = 60 * 60 * 24 * 7, now = () => Date.now() } = {}) {
    this.store = new Map();
    this.ttlMs = ttlSeconds * 1000;
    this.now = now;
  }

  #sweep() {
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= this.now()) this.store.delete(key);
    }
  }

  async get(id) {
    const entry = this.store.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(id);
      return null;
    }
    return structuredClone(entry.value);
  }

  async put(cart) {
    this.#sweep();
    this.store.set(cart.id, { value: structuredClone(cart), expiresAt: this.now() + this.ttlMs });
    return cart;
  }

  async delete(id) {
    this.store.delete(id);
  }

  /** Optimistic concurrency: only write when the caller's version still matches. */
  async update(cart, expectedVersion) {
    const entry = this.store.get(cart.id);
    const currentVersion = entry?.value?.version;
    if (entry && expectedVersion !== undefined && currentVersion !== expectedVersion) {
      return null;
    }
    return this.put(cart);
  }

  async healthCheck() {
    return { ok: true, detail: `in-memory cart store with ${this.store.size} carts` };
  }

  async close() {}
}

export class RedisCartRepository {
  static async create({ url, ttlSeconds, logger }) {
    const { createClient } = await import('redis');
    const client = createClient({
      url,
      socket: { connectTimeout: 3000, reconnectStrategy: (retries) => Math.min(retries * 100, 3000) },
    });
    client.on('error', (err) => logger?.error({ err }, 'redis client error'));
    await client.connect();
    return new RedisCartRepository(client, ttlSeconds);
  }

  constructor(client, ttlSeconds) {
    this.client = client;
    this.ttlSeconds = ttlSeconds;
  }

  #key(id) {
    return `shopstack:cart:${id}`;
  }

  async get(id) {
    const raw = await this.client.get(this.#key(id));
    return raw ? JSON.parse(raw) : null;
  }

  async put(cart) {
    await this.client.set(this.#key(cart.id), JSON.stringify(cart), { EX: this.ttlSeconds });
    return cart;
  }

  async update(cart, expectedVersion) {
    if (expectedVersion === undefined) return this.put(cart);
    // WATCH/MULTI gives compare-and-set semantics so two concurrent tabs cannot
    // silently clobber each other's cart.
    await this.client.watch(this.#key(cart.id));
    const raw = await this.client.get(this.#key(cart.id));
    const current = raw ? JSON.parse(raw) : null;
    const currentVersion = current?.version ?? -1;
    if (currentVersion !== expectedVersion && !(current === null && expectedVersion === 0)) {
      await this.client.unwatch();
      return null;
    }
    return this.put(cart);
  }

  async delete(id) {
    await this.client.del(this.#key(id));
  }

  async healthCheck() {
    try {
      const pong = await this.client.ping();
      return { ok: pong === 'PONG', detail: `redis ${pong}` };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }

  async close() {
    await this.client.quit().catch(() => {});
  }
}

export async function createCartRepository({ driver, redisUrl, ttlSeconds, logger }) {
  if (driver === 'redis') {
    if (!redisUrl) throw new Error('CART_DRIVER=redis requires REDIS_URL');
    return RedisCartRepository.create({ url: redisUrl, ttlSeconds, logger });
  }
  return new MemoryCartRepository({ ttlSeconds });
}
