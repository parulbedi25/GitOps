/**
 * Cart HTTP API.
 *
 * Public routes are used by the storefront; `/internal/*` routes are used by
 * checkout to lock the cart for the duration of the saga. Locking prevents the
 * classic double-submit bug: pay for the basket, then change it in another tab
 * while the payment is in flight.
 */
import { randomUUID } from 'node:crypto';
import { badRequest, conflict, notFound } from '@shopstack/telemetry';
import {
  addItem,
  calculateTotals,
  clear,
  emptyCart,
  lock,
  MAX_QUANTITY_PER_LINE,
  mergeCarts,
  removeItem,
  setQuantity,
  unlock,
} from './cart.js';

const cartSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string' },
    currency: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          productId: { type: 'string' },
          slug: { type: 'string' },
          name: { type: 'string' },
          image: { type: 'string' },
          unitPriceCents: { type: 'integer' },
          quantity: { type: 'integer' },
        },
      },
    },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    version: { type: 'integer' },
  },
};

const totalsSchema = {
  type: 'object',
  properties: {
    itemCount: { type: 'integer' },
    subtotalCents: { type: 'integer' },
    shippingCents: { type: 'integer' },
    taxCents: { type: 'integer' },
    totalCents: { type: 'integer' },
    currency: { type: 'string' },
    freeShippingThresholdCents: { type: 'integer' },
    amountToFreeShippingCents: { type: 'integer' },
  },
};

const cartEnvelope = {
  type: 'object',
  properties: { cart: cartSchema, totals: totalsSchema },
};

export async function registerRoutes({ app, repository, metrics, config, catalogClient }) {
  const pricing = {
    taxRateBps: config.TAX_RATE_BPS,
    shippingFeeCents: config.SHIPPING_FEE_CENTS,
    freeShippingThresholdCents: config.FREE_SHIPPING_THRESHOLD_CENTS,
  };

  const cartsCreated = metrics.counter('shopstack_carts_created_total', 'Carts created.');
  const itemsAdded = metrics.counter('shopstack_cart_items_added_total', 'Cart lines added.');
  const cartValue = metrics.histogram(
    'shopstack_cart_value_cents',
    'Subtotal of a cart when it is locked for checkout.',
    [],
    [500, 1000, 2500, 5000, 10000, 20000, 50000, 100000],
  );
  const lockConflicts = metrics.counter(
    'shopstack_cart_lock_conflicts_total',
    'Optimistic concurrency conflicts on carts.',
  );
  const locks = metrics.counter('shopstack_cart_lock_total', 'Cart lock transitions.', ['action']);

  /** Packages the cart with the pricing breakdown the UI needs. */
  const envelope = (cart) => ({ cart, totals: calculateTotals(cart, pricing) });

  async function fetchCart(cartId) {
    return repository.get(cartId);
  }

  async function loadOrCreate(cartId) {
    const existing = await fetchCart(cartId);
    if (existing) return { cart: existing, created: false };
    const cart = emptyCart(cartId);
    cartsCreated.inc();
    return { cart, created: true };
  }

  async function persist(cart, expectedVersion) {
    const saved = await repository.update(cart, expectedVersion);
    if (!saved) {
      lockConflicts.inc();
      throw conflict(
        'Cart was modified concurrently',
        'another session updated this cart; reload and retry',
        'cart-version-conflict',
      );
    }
    return saved;
  }

  async function fetchProduct(productId) {
    return catalogClient.get(`/api/products/${encodeURIComponent(productId)}`);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  app.post(
    '/api/carts',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { customerId: { type: 'string', maxLength: 80 } },
        },
        response: { 201: cartEnvelope },
      },
    },
    async (request, reply) => {
      const cart = emptyCart(`cart-${randomUUID()}`);
      if (request.body?.customerId) cart.customerId = request.body.customerId;
      cartsCreated.inc();
      await repository.put(cart);
      return reply.code(201).send(envelope(cart));
    },
  );

  app.get(
    '/api/carts/:cartId',
    {
      schema: {
        params: { type: 'object', required: ['cartId'], properties: { cartId: { type: 'string', maxLength: 80 } } },
        response: { 200: cartEnvelope },
      },
    },
    async (request) => {
      const cart = await fetchCart(request.params.cartId);
      if (!cart) throw notFound('Cart', request.params.cartId);
      return envelope(cart);
    },
  );

  // ── Items ─────────────────────────────────────────────────────────────────
  app.post(
    '/api/carts/:cartId/items',
    {
      schema: {
        params: { type: 'object', required: ['cartId'], properties: { cartId: { type: 'string', maxLength: 80 } } },
        body: {
          type: 'object',
          required: ['productId'],
          additionalProperties: false,
          properties: {
            productId: { type: 'string', minLength: 1, maxLength: 80 },
            quantity: { type: 'integer', minimum: 1, maximum: MAX_QUANTITY_PER_LINE, default: 1 },
          },
        },
        response: { 200: cartEnvelope },
      },
    },
    async (request) => {
      const { cartId } = request.params;
      const { productId, quantity } = request.body;

      let product;
      try {
        product = await fetchProduct(productId);
      } catch (err) {
        if (err.status === 404) throw notFound('Product', productId);
        throw err;
      }

      const { cart } = await loadOrCreate(cartId);
      const nextCart = addItem(cart, product, quantity);
      const saved = await persist(nextCart, cart.version || undefined);
      itemsAdded.inc();
      return envelope(saved);
    },
  );

  app.patch(
    '/api/carts/:cartId/items/:itemId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['cartId', 'itemId'],
          properties: { cartId: { type: 'string' }, itemId: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['quantity'],
          additionalProperties: false,
          properties: { quantity: { type: 'integer', minimum: 0, maximum: MAX_QUANTITY_PER_LINE } },
        },
        response: { 200: cartEnvelope },
      },
    },
    async (request) => {
      const cart = await fetchCart(request.params.cartId);
      if (!cart) throw notFound('Cart', request.params.cartId);
      const updated = setQuantity(cart, request.params.itemId, request.body.quantity);
      return envelope(await persist(updated, cart.version));
    },
  );

  app.delete(
    '/api/carts/:cartId/items/:itemId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['cartId', 'itemId'],
          properties: { cartId: { type: 'string' }, itemId: { type: 'string' } },
        },
        response: { 200: cartEnvelope },
      },
    },
    async (request) => {
      const cart = await fetchCart(request.params.cartId);
      if (!cart) throw notFound('Cart', request.params.cartId);
      const updated = removeItem(cart, request.params.itemId);
      return envelope(await persist(updated, cart.version));
    },
  );

  app.delete(
    '/api/carts/:cartId',
    {
      schema: {
        params: { type: 'object', required: ['cartId'], properties: { cartId: { type: 'string' } } },
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      await repository.delete(request.params.cartId);
      return reply.code(204).send();
    },
  );

  /** Merges an anonymous cart into the signed-in customer's cart. */
  app.post(
    '/api/carts/:cartId/merge',
    {
      schema: {
        params: { type: 'object', required: ['cartId'], properties: { cartId: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['sourceCartId'],
          additionalProperties: false,
          properties: { sourceCartId: { type: 'string', minLength: 1, maxLength: 80 } },
        },
        response: { 200: cartEnvelope },
      },
    },
    async (request) => {
      if (request.params.cartId === request.body.sourceCartId) {
        throw badRequest('cannot merge a cart into itself', 'merge-same-cart');
      }
      const [target, source] = await Promise.all([
        fetchCart(request.params.cartId),
        fetchCart(request.body.sourceCartId),
      ]);
      if (!target || !source) throw notFound('Cart', !target ? request.params.cartId : request.body.sourceCartId);
      const merged = mergeCarts(target, source);
      await repository.delete(source.id);
      return envelope(await persist(merged, target.version));
    },
  );

  // ── Checkout coordination (internal) ──────────────────────────────────────
  app.post('/internal/carts/:cartId/lock', async (request) => {
    const cart = await fetchCart(request.params.cartId);
    if (!cart) throw notFound('Cart', request.params.cartId);
    if (cart.status === 'locked') {
      locks.labels('idempotent').inc();
      return envelope(cart);
    }
    const locked = lock(cart);
    const saved = await persist(locked, cart.version);
    cartValue.observe(calculateTotals(saved, pricing).subtotalCents);
    locks.labels('locked').inc();
    return envelope(saved);
  });

  app.post('/internal/carts/:cartId/unlock', async (request) => {
    const cart = await fetchCart(request.params.cartId);
    if (!cart) throw notFound('Cart', request.params.cartId);
    const unlocked = unlock(cart);
    locks.labels('unlocked').inc();
    return envelope(await persist(unlocked, cart.version));
  });

  app.post('/internal/carts/:cartId/clear', async (request) => {
    const cart = await fetchCart(request.params.cartId);
    if (!cart) throw notFound('Cart', request.params.cartId);
    return envelope(await persist(clear(cart), cart.version));
  });

  /** Checkout reads the authoritative cart snapshot from here. */
  app.get('/internal/carts/:cartId', async (request) => {
    const cart = await fetchCart(request.params.cartId);
    if (!cart) throw notFound('Cart', request.params.cartId);
    return envelope(cart);
  });

  app.get('/internal/stats', async () => ({
    driver: config.CART_DRIVER,
    pricing,
  }));
}
