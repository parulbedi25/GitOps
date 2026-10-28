/**
 * Catalog HTTP API.
 *
 * Reads (`/api/*`) are consumed by the storefront and, through the API gateway,
 * by partners. Writes (`/internal/stock/*`) are only ever called by checkout and
 * are therefore excluded from the public ingress and covered by a NetworkPolicy
 * that allows traffic from checkout pods only.
 */
import { badRequest, notFound } from '@shopstack/telemetry';
import { InsufficientStockError } from './catalog.js';

const productSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    slug: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    category: { type: 'string' },
    priceCents: { type: 'integer' },
    currency: { type: 'string' },
    stock: { type: 'integer' },
    rating: { type: 'number' },
    reviewCount: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
    featured: { type: 'boolean' },
    inStock: { type: 'boolean' },
    lowStock: { type: 'boolean' },
    image: { type: 'string' },
  },
};

const errorSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    code: { type: 'string' },
    detail: {},
    errors: { type: 'array', items: { type: 'object', additionalProperties: true } },
    traceId: { type: 'string' },
  },
};

/** Serializer: hide internal fields such as reservation TTLs from the public API. */
const publicProduct = (p) => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
  description: p.description,
  category: p.category,
  priceCents: p.priceCents,
  currency: p.currency,
  stock: p.stock,
  inStock: p.stock > 0,
  lowStock: p.stock > 0 && p.stock <= 5,
  rating: p.rating,
  reviewCount: p.reviewCount,
  tags: p.tags ?? [],
  featured: Boolean(p.featured),
  image: `/media/${p.slug}.svg`,
});

export async function registerRoutes({ app, repository, metrics, cache, config }) {
  const reservations = metrics.counter('shopstack_catalog_reservations_total', 'Stock reservations by outcome.', [
    'outcome',
  ]);
  const stockGauge = metrics.gauge('shopstack_catalog_stock_units', 'Units on hand per product.', ['product']);
  const outOfStockGauge = metrics.gauge(
    'shopstack_catalog_out_of_stock_products',
    'Number of products with zero stock.',
  );
  const cacheCounter = metrics.counter('shopstack_catalog_cache_events_total', 'Product cache hits and misses.', [
    'result',
  ]);

  /** Refresh low-cardinality inventory gauges in the background (never on the request path). */
  const refreshGauges = async () => {
    try {
      const stats = await repository.stats();
      outOfStockGauge.set(stats.outOfStock);
      const { items } = await repository.list({ limit: 100 });
      for (const product of items) stockGauge.labels(product.id).set(product.stock);
    } catch (err) {
      app.log.debug({ err }, 'failed to refresh catalog gauges');
    }
  };
  const timer = setInterval(refreshGauges, config.METRICS_REFRESH_MS);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
  void refreshGauges();

  // ── Catalog reads ─────────────────────────────────────────────────────────
  app.get(
    '/api/categories',
    { schema: { response: { 200: { type: 'object', properties: { items: { type: 'array' } } } } } },
    async () => {
      const cached = cache.get('categories');
      if (cached) {
        cacheCounter.labels('hit').inc();
        return cached;
      }
      cacheCounter.labels('miss').inc();
      const items = await repository.categories();
      const payload = { items };
      cache.set('categories', payload);
      return payload;
    },
  );

  app.get(
    '/api/products',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            category: { type: 'string', maxLength: 40 },
            q: { type: 'string', maxLength: 120 },
            limit: { type: 'integer', minimum: 1, maximum: 48, default: 12 },
            offset: { type: 'integer', minimum: 0, maximum: 1000, default: 0 },
            sort: {
              type: 'string',
              enum: ['relevance', 'price_asc', 'price_desc', 'rating', 'newest'],
              default: 'relevance',
            },
            inStock: { type: 'boolean', default: false },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              items: { type: 'array', items: productSchema },
              total: { type: 'integer' },
              limit: { type: 'integer' },
              offset: { type: 'integer' },
              nextOffset: { type: ['integer', 'null'] },
            },
          },
          400: errorSchema,
        },
      },
    },
    async (request) => {
      const query = request.query;
      const cacheKey = `products:${JSON.stringify(query)}`;
      const cached = cache.get(cacheKey);
      if (cached) {
        cacheCounter.labels('hit').inc();
        return cached;
      }
      cacheCounter.labels('miss').inc();

      const result = await repository.list({ ...query, inStockOnly: query.inStock });
      const payload = {
        items: result.items.map(publicProduct),
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        nextOffset: result.offset + result.items.length < result.total ? result.offset + result.items.length : null,
      };
      cache.set(cacheKey, payload);
      return payload;
    },
  );

  app.get(
    '/api/products/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 120 } } },
        response: { 200: productSchema, 404: errorSchema },
      },
    },
    async (request) => {
      const product = await repository.get(request.params.id);
      if (!product) throw notFound('Product', request.params.id);
      return publicProduct(product);
    },
  );

  app.get(
    '/api/products/:id/related',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 12, default: 4 } },
        },
      },
    },
    async (request) => {
      const product = await repository.get(request.params.id);
      if (!product) throw notFound('Product', request.params.id);
      const items = await repository.related(product, request.query.limit);
      return { items: items.map(publicProduct) };
    },
  );

  // ── Internal inventory API (checkout only) ────────────────────────────────
  app.get('/internal/stock/:productId', async (request) => {
    const product = await repository.get(request.params.productId);
    if (!product) throw notFound('Product', request.params.productId);
    return { productId: product.id, available: product.stock, reserved: false };
  });

  app.post(
    '/internal/stock/reservations',
    {
      schema: {
        body: {
          type: 'object',
          required: ['orderId', 'items'],
          additionalProperties: false,
          properties: {
            orderId: { type: 'string', minLength: 3, maxLength: 80 },
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: {
                type: 'object',
                required: ['productId', 'quantity'],
                additionalProperties: false,
                properties: {
                  productId: { type: 'string', minLength: 1, maxLength: 80 },
                  quantity: { type: 'integer', minimum: 1, maximum: 20 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const reservation = await repository.reserve(request.body);
        reservations.labels('reserved').inc();
        cache.clear();
        void refreshGauges();
        return reply.code(201).send(reservation);
      } catch (err) {
        if (err instanceof InsufficientStockError) reservations.labels('rejected').inc();
        throw err;
      }
    },
  );

  app.post('/internal/stock/reservations/:reservationId/commit', async (request) => {
    const result = await repository.commit(request.params.reservationId);
    reservations.labels('committed').inc();
    return result;
  });

  app.post('/internal/stock/reservations/:reservationId/release', async (request) => {
    const result = await repository.release(request.params.reservationId);
    reservations.labels('released').inc();
    cache.clear();
    void refreshGauges();
    return result;
  });

  app.get('/internal/stats', async () => {
    const stats = await repository.stats();
    return { ...stats, cache: cache.stats() };
  });

  app.post('/internal/cache/flush', async () => {
    if (config.DEPLOYMENT_ENVIRONMENT === 'prod')
      throw badRequest('cache flush disabled in production', 'cache-flush-disabled');
    cache.clear();
    return { flushed: true };
  });
}
