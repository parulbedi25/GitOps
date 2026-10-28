/**
 * Cart domain — pure functions, no I/O.
 *
 * Money is always integer cents. Floating point arithmetic on prices is how
 * e-commerce companies end up with a €0.01 reconciliation bug in their monthly
 * close, so cents are enforced at the type boundary (see routes/schemas).
 */
import { conflict, notFound, unprocessable } from '@shopstack/telemetry';

export const MAX_QUANTITY_PER_LINE = 20;
export const MAX_LINES = 40;

export function emptyCart(cartId, now = new Date()) {
  const timestamp = now.toISOString();
  return {
    id: cartId,
    status: 'open',
    items: [],
    currency: 'USD',
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 0,
  };
}

export function itemIdFor(productId) {
  return `itm-${productId}`;
}

/**
 * Adds a product, merging with an existing line. The caller is responsible for
 * having fetched the authoritative product snapshot (price, name, stock).
 */
export function addItem(cart, product, quantity, now = new Date()) {
  if (cart.status !== 'open')
    throw conflict('Cart is locked', 'a checkout is already in progress for this cart', 'cart-locked');
  if (quantity > MAX_QUANTITY_PER_LINE) {
    throw unprocessable('Quantity limit exceeded', `at most ${MAX_QUANTITY_PER_LINE} units per line`, 'quantity-limit');
  }

  const itemId = itemIdFor(product.id);
  const existing = cart.items.find((item) => item.id === itemId);
  const nextQuantity = (existing?.quantity ?? 0) + quantity;

  if (nextQuantity > MAX_QUANTITY_PER_LINE) {
    throw unprocessable('Quantity limit exceeded', `at most ${MAX_QUANTITY_PER_LINE} units per line`, 'quantity-limit');
  }
  if (product.stock < nextQuantity) {
    throw conflict(
      'Not enough stock',
      `only ${product.stock} units of ${product.name} are available`,
      'insufficient-stock',
    );
  }
  if (!existing && cart.items.length >= MAX_LINES) {
    throw unprocessable('Cart is full', `at most ${MAX_LINES} distinct items per cart`, 'cart-full');
  }

  const items = existing
    ? cart.items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              quantity: nextQuantity,
              unitPriceCents: product.priceCents,
              name: product.name,
              image: product.image,
            }
          : item,
      )
    : [
        ...cart.items,
        {
          id: itemId,
          productId: product.id,
          slug: product.slug,
          name: product.name,
          image: product.image,
          unitPriceCents: product.priceCents,
          currency: product.currency ?? cart.currency,
          quantity,
        },
      ];

  return touch(cart, { items }, now);
}

export function setQuantity(cart, itemId, quantity, now = new Date()) {
  if (cart.status !== 'open')
    throw conflict('Cart is locked', 'a checkout is already in progress for this cart', 'cart-locked');
  const item = cart.items.find((line) => line.id === itemId);
  if (!item) throw notFound('Cart item', itemId);
  if (quantity > MAX_QUANTITY_PER_LINE) {
    throw unprocessable('Quantity limit exceeded', `at most ${MAX_QUANTITY_PER_LINE} units per line`, 'quantity-limit');
  }
  const items =
    quantity <= 0
      ? cart.items.filter((line) => line.id !== itemId)
      : cart.items.map((line) => (line.id === itemId ? { ...line, quantity } : line));
  return touch(cart, { items }, now);
}

export function removeItem(cart, itemId, now = new Date()) {
  if (!cart.items.some((line) => line.id === itemId)) throw notFound('Cart item', itemId);
  return touch(cart, { items: cart.items.filter((line) => line.id !== itemId) }, now);
}

/**
 * Merges an anonymous cart into a customer cart (sign-in flow).
 * Quantities are capped per line so a hostile client cannot create a
 * 10,000-unit basket by merging repeatedly.
 */
export function mergeCarts(target, source, now = new Date()) {
  const items = [...target.items];
  for (const incoming of source.items) {
    const index = items.findIndex((line) => line.productId === incoming.productId);
    if (index >= 0) {
      items[index] = {
        ...items[index],
        quantity: Math.min(MAX_QUANTITY_PER_LINE, items[index].quantity + incoming.quantity),
      };
    } else if (items.length < MAX_LINES) {
      items.push({ ...incoming });
    }
  }
  return touch(target, { items }, now);
}

export function lock(cart, now = new Date()) {
  if (cart.items.length === 0)
    throw unprocessable('Cart is empty', 'add at least one item before checking out', 'cart-empty');
  if (cart.status === 'locked') return cart;
  return touch(cart, { status: 'locked' }, now);
}

export function unlock(cart, now = new Date()) {
  if (cart.status !== 'locked') return cart;
  return touch(cart, { status: 'open' }, now);
}

export function clear(cart, now = new Date()) {
  return touch(cart, { items: [], status: 'open' }, now);
}

function touch(cart, patch, now) {
  return { ...cart, ...patch, updatedAt: now.toISOString(), version: cart.version + 1 };
}

/**
 * Server-side money maths. Never trust a client-supplied total.
 *
 * @param {object} cart
 * @param {{taxRateBps: number, shippingFeeCents: number, freeShippingThresholdCents: number}} pricing
 */
export function calculateTotals(cart, { taxRateBps, shippingFeeCents, freeShippingThresholdCents }) {
  const subtotalCents = cart.items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  const itemCount = cart.items.reduce((sum, item) => sum + item.quantity, 0);
  const shippingCents = subtotalCents === 0 || subtotalCents >= freeShippingThresholdCents ? 0 : shippingFeeCents;
  const taxCents = Math.round((subtotalCents * taxRateBps) / 10_000);
  return {
    itemCount,
    subtotalCents,
    shippingCents,
    taxCents,
    totalCents: subtotalCents + shippingCents + taxCents,
    currency: cart.currency,
    freeShippingThresholdCents,
    amountToFreeShippingCents: Math.max(0, freeShippingThresholdCents - subtotalCents),
  };
}
