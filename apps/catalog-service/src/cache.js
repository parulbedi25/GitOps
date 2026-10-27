/**
 * Tiny TTL cache for read-heavy catalog endpoints.
 *
 * Catalog reads outnumber writes ~200:1, so a few seconds of caching removes most
 * database load while keeping the "add to cart shows live stock" experience. The
 * cache is invalidated explicitly on every reservation change, so correctness
 * never depends on the TTL alone.
 */
export class TtlCache {
  constructor({ ttlMs = 5000, maxEntries = 500, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.store = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry.value;
  }

  set(key, value) {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  clear() {
    this.store.clear();
  }

  stats() {
    return { entries: this.store.size, hits: this.hits, misses: this.misses, ttlMs: this.ttlMs };
  }
}
