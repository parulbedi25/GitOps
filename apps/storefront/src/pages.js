/**
 * Page templates.
 *
 * Each function returns the *body* markup; `layout()` in ui.js wraps it in the
 * document shell. Pages receive plain data from the route layer, never a client,
 * which keeps them trivially unit-testable.
 */
import { alert, emptyState, esc, formatDate, layout, money, productCard, quantityStepper, ratingStars, stockNote } from './ui.js';

const CATEGORY_LABELS = {
  audio: 'Audio',
  workspace: 'Workspace',
  home: 'Home',
  outdoors: 'Outdoors',
  apparel: 'Apparel',
  accessories: 'Accessories',
};

const categoryLabel = (slug) => CATEGORY_LABELS[slug] ?? slug;

function heroSection(featured) {
  const hero = featured[0];
  const categoryChips = ['audio', 'workspace', 'home', 'outdoors', 'apparel', 'accessories'];
  return `<section class="hero page">
    <div>
      <p class="eyebrow">Autumn collection · 2026</p>
      <h1>Objects made for the way you <em>actually</em> live.</h1>
      <p class="lede">Considered audio, desk and outdoor gear — designed to last longer than the trend cycle and priced without the middleman.</p>
      <div class="hero-actions">
        <a class="btn btn-primary" href="#collection">Shop the collection</a>
        <a class="btn btn-ghost" href="/category/audio">Explore audio</a>
      </div>
      <div class="hero-proof">
        <div><strong>4.7/5</strong><span>from 12,400 reviews</span></div>
        <div><strong>48h</strong><span>average delivery</span></div>
        <div><strong>30 days</strong><span>free returns</span></div>
      </div>
      <div class="chip-row"></div>
    </div>
    <div class="hero-visual">
      <div class="hero-card">
        <img src="/media/hero.svg" alt="" width="520" height="560">
        <div class="hero-card-body">
          <div>
            <p class="eyebrow">${esc(categoryLabel(hero?.category ?? 'audio'))}</p>
            <h3>${esc(hero?.name ?? 'Atlas ANC Headphones')}</h3>
          </div>
          <span class="price">${money(hero?.priceCents ?? 27900)}</span>
        </div>
      </div>
      <div class="hero-float"><span class="dot" aria-hidden="true"></span> In stock · dispatched today</div>
    </div>
  </section>
  <div class="page"><div class="chip-row" aria-label="Shop by category">
    ${categoryChips
      .map((slug) => `<a class="pill" href="/category/${slug}">${esc(categoryLabel(slug))}</a>`)
      .join('')}
  </div></div>`;
}

/**
 * @param {{products: object[], categories: {slug: string, name: string, count: number}[], featured: object[], version: string, environment: string, cartCount: number}} data
 */
export function renderHome({ products, featured = [], version, environment, cartCount }) {
  const body = `
  ${heroSection(featured.length ? featured : products)}
  <section class="section page" id="collection">
    <div class="section-head">
      <div>
        <p class="eyebrow">The edit</p>
        <h2>Most loved this month</h2>
      </div>
      <a class="link-more" href="/category/audio">Browse all products →</a>
    </div>
    <div class="grid">
      ${products.slice(0, 8).map((product) => productCard(product, { categoryLabel: categoryLabel(product.category) })).join('')}
    </div>
  </section>
  <section class="section page">
    <div class="panel">
      <div class="row-between">
        <div>
          <p class="eyebrow">Built to be repaired</p>
          <h2>Buy once. Keep it for a decade.</h2>
          <p class="muted">Every product ships with a parts index, a repair guide, and a two-year warranty. Spare parts stay in stock for seven years.</p>
        </div>
        <a class="btn btn-ghost" href="/search?q=warranty">Read our promise</a>
      </div>
    </div>
  </section>
  <section class="section page">
    <div class="section-head">
      <div>
        <p class="eyebrow">Everything in stock</p>
        <h2>The full catalogue</h2>
      </div>
      <span class="muted">${products.length} products</span>
    </div>
    <div class="grid">
      ${products.map((product) => productCard(product, { categoryLabel: categoryLabel(product.category) })).join('')}
    </div>
  </section>`;

  return layout({
    title: 'Considered objects for everyday life',
    description: 'ShopStack — considered audio, workspace, home and outdoor gear. Free shipping over $75.',
    body,
    cartCount,
    activeNav: '/',
    version,
    environment,
  });
}

/** Category / search listing. */
export function renderCatalog({ heading, subheading, products, categories, activeCategory, query, offset, limit, total, version, environment, cartCount }) {
  const nextOffset = offset + products.length < total ? offset + products.length : null;
  const prevOffset = Math.max(0, offset - limit);
  const body = `
  <div class="page">
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><span>${esc(heading)}</span></nav>
    <div class="section-head">
      <div>
        <p class="eyebrow">${esc(subheading)}</p>
        <h1>${esc(heading)}</h1>
      </div>
      <form method="get" action="/search" class="row-between">
        <label class="sr-only" for="sortless">Refine</label>
        <input id="sortless" name="q" type="search" placeholder="Filter this collection…" value="${esc(query ?? '')}">
        <button class="btn btn-sm btn-ghost" type="submit">Search</button>
      </form>
    </div>
    <div class="chip-row" aria-label="Categories">
      <a class="pill" href="/" ${!activeCategory ? 'aria-current="true"' : ''}>All</a>
      ${categories
        .map(
          (category) =>
            `<a class="pill" href="/category/${esc(category.slug)}" ${activeCategory === category.slug ? 'aria-current="true"' : ''}>${esc(category.name)} <span class="count">${category.count}</span></a>`,
        )
        .join('')}
    </div>
    <p class="muted">${total} ${total === 1 ? 'product' : 'products'}${query ? ` matching “${esc(query)}”` : ''}</p>
    ${
      products.length === 0
        ? emptyState({
            title: 'No products matched',
            message: 'Try a broader search, or browse the full catalogue.',
            actionHref: '/',
            actionLabel: 'Shop everything',
          })
        : `<div class="grid">${products.map((product) => productCard(product, { categoryLabel: categoryLabel(product.category) })).join('')}</div>`
    }
    <nav class="row-between" aria-label="Pagination">
      ${offset > 0 ? `<a class="btn btn-sm btn-ghost" href="?offset=${prevOffset}">← Previous</a>` : '<span></span>'}
      ${nextOffset !== null ? `<a class="btn btn-sm btn-ghost" href="?offset=${nextOffset}">Next →</a>` : '<span></span>'}
    </nav>
  </div>`;

  return layout({ title: heading, description: subheading, body, cartCount, activeNav: activeCategory ? `/category/${activeCategory}` : '/', version, environment });
}

export function renderProduct({ product, related, version, environment, cartCount }) {
  const body = `
  <div class="page">
    <nav class="breadcrumb" aria-label="Breadcrumb">
      <a href="/">Home</a><span aria-hidden="true">/</span>
      <a href="/category/${esc(product.category)}">${esc(categoryLabel(product.category))}</a><span aria-hidden="true">/</span>
      <span>${esc(product.name)}</span>
    </nav>
    <div class="product">
      <div>
        <div class="product-gallery"><img src="${esc(product.image)}" alt="${esc(product.name)}" width="640" height="640"></div>
        <div class="tag-row">
          ${(product.tags ?? []).map((tag) => `<span class="tag">#${esc(tag)}</span>`).join('')}
        </div>
      </div>
      <div class="product-info">
        ${product.featured ? '<span class="badge badge-accent">Editor’s pick</span>' : ''}
        <h1>${esc(product.name)}</h1>
        ${ratingStars(product.rating, product.reviewCount)}
        <div class="product-price">${money(product.priceCents, product.currency)} ${stockNote(product)}</div>
        <p class="product-desc">${esc(product.description)}</p>
        ${
          product.stock === 0
            ? alert({ tone: 'info', title: 'Sold out', message: 'Join the waitlist — we restock every fortnight.' })
            : `<form method="post" action="/cart/items" data-add-to-cart class="buy-row">
                <input type="hidden" name="productId" value="${esc(product.id)}">
                <input type="hidden" name="returnTo" value="/product/${esc(product.slug)}">
                ${quantityStepper({ value: 1, max: Math.min(20, Math.max(1, product.stock)), action: '/cart/items', productId: product.id, returnTo: `/product/${product.slug}` })}
                <button class="btn btn-primary" type="submit">Add to bag</button>
              </form>`
        }
        <div class="meta-list">
          <div><dt>SKU</dt><dd>${esc(product.id)}</dd></div>
          <div><dt>Delivery</dt><dd>Free over $75 · 1–2 business days</dd></div>
          <div><dt>Warranty</dt><dd>2 years, parts available for 7</dd></div>
          <div><dt>Returns</dt><dd>30 days, prepaid label included</dd></div>
        </div>
      </div>
    </div>
  </div>
  <section class="section page">
    <div class="section-head"><div><p class="eyebrow">Pairs well with</p><h2>From the same collection</h2></div></div>
    <div class="grid">${related.map((item) => productCard(item, { categoryLabel: categoryLabel(item.category) })).join('')}</div>
  </section>`;

  return layout({
    title: product.name,
    description: product.description,
    body,
    cartCount,
    activeNav: `/category/${product.category}`,
    version,
    environment,
  });
}

export function renderCart({ cart, totals, version, environment, notice }) {
  const cartCount = totals?.itemCount ?? 0;
  if (!cart || cart.items.length === 0) {
    return layout({
      title: 'Your bag',
      description: 'Your ShopStack bag is empty.',
      body: `<div class="page">${emptyState({
        title: 'Your bag is empty',
        message: 'Good design is worth the wait. Start with the pieces everyone comes back for.',
        actionHref: '/',
        actionLabel: 'Start shopping',
      })}</div>`,
      cartCount: 0,
      version,
      environment,
    });
  }

  const progress = Math.min(100, Math.round((totals.subtotalCents / totals.freeShippingThresholdCents) * 100));
  const body = `
  <div class="page">
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><span>Your bag</span></nav>
    <div class="section-head"><div><p class="eyebrow">${cartCount} ${cartCount === 1 ? 'item' : 'items'}</p><h1>Your bag</h1></div></div>
    ${notice ? alert({ tone: 'info', message: notice }) : ''}
    <div class="cart-layout">
      <div class="panel">
        ${cart.items
          .map(
            (item) => `<div class="line-item">
              <a class="line-thumb" href="/product/${esc(item.slug)}"><img src="${esc(item.image)}" alt="" width="84" height="84"></a>
              <div>
                <p class="line-title"><a href="/product/${esc(item.slug)}">${esc(item.name)}</a></p>
                <p class="line-meta">${money(item.unitPriceCents, cart.currency)} each</p>
                <div class="line-controls">
                  <form method="post" action="/cart/items/${esc(item.id)}" data-qty-form>
                    ${quantityStepper({ value: item.quantity, max: 20, action: `/cart/items/${item.id}`, productId: item.productId, returnTo: '/cart' })}
                  </form>
                  <form method="post" action="/cart/items/${esc(item.id)}/remove">
                    <button class="link-quiet" type="submit">Remove</button>
                  </form>
                </div>
              </div>
              <div class="line-total">${money(item.unitPriceCents * item.quantity, cart.currency)}</div>
            </div>`,
          )
          .join('')}
      </div>
      <aside class="panel panel-sticky">
        <h2>Summary</h2>
        <div class="summary-row"><span>Subtotal</span><span>${money(totals.subtotalCents)}</span></div>
        <div class="summary-row"><span>Shipping</span><span>${totals.shippingCents === 0 ? 'Free' : money(totals.shippingCents)}</span></div>
        <div class="summary-row"><span>Estimated tax</span><span>${money(totals.taxCents)}</span></div>
        <div class="summary-row total"><span>Total</span><span class="price">${money(totals.totalCents)}</span></div>
        ${
          totals.amountToFreeShippingCents > 0
            ? `<div class="free-ship">Add ${money(totals.amountToFreeShippingCents)} for free shipping<progress class="progress" max="100" value="${progress}" aria-label="Progress towards free shipping">${progress}%</progress></div>`
            : `<div class="free-ship">Free carbon-neutral shipping unlocked<progress class="progress" max="100" value="100" aria-label="Free shipping unlocked">100%</progress></div>`
        }
        <a class="btn btn-accent btn-block" href="/checkout">Continue to checkout</a>
        <p class="muted">Taxes are calculated server-side at 8.25%. Payments are simulated — use the test card on the next page.</p>
      </aside>
    </div>
  </div>`;

  return layout({ title: 'Your bag', description: 'Review your ShopStack bag.', body, cartCount, version, environment });
}

export function renderCheckout({ cart, totals, idempotencyKey, customer = {}, error, version, environment }) {
  const body = `
  <div class="page">
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/cart">Bag</a><span aria-hidden="true">/</span><span>Checkout</span></nav>
    <div class="section-head"><div><p class="eyebrow">Secure checkout</p><h1>Where should it go?</h1></div></div>
    ${error ? alert({ tone: 'danger', title: error.title ?? 'Checkout failed', message: error.message }) : ''}
    <form method="post" action="/checkout" class="checkout-layout" autocomplete="on">
      <div class="panel">
        <input type="hidden" name="idempotencyKey" value="${esc(idempotencyKey)}">
        <h2 class="fieldset-title">Contact</h2>
        <div class="field">
          <label for="email">Email address</label>
          <input id="email" name="email" type="email" required value="${esc(customer.email ?? '')}" placeholder="you@example.com" autocomplete="email">
          <span class="hint">Order confirmation and tracking are sent here.</span>
        </div>
        <div class="field">
          <label for="name">Full name</label>
          <input id="name" name="name" type="text" required value="${esc(customer.name ?? '')}" placeholder="Ada Lovelace" autocomplete="name">
        </div>

        <h2 class="fieldset-title">Shipping address</h2>
        <div class="field">
          <label for="line1">Address</label>
          <input id="line1" name="line1" type="text" required placeholder="12 Analytical Way" autocomplete="address-line1">
        </div>
        <div class="field">
          <label for="line2">Apartment, suite (optional)</label>
          <input id="line2" name="line2" type="text" placeholder="Flat 4" autocomplete="address-line2">
        </div>
        <div class="field-row">
          <div class="field">
            <label for="city">City</label>
            <input id="city" name="city" type="text" required placeholder="London" autocomplete="address-level2">
          </div>
          <div class="field">
            <label for="state">State / region</label>
            <input id="state" name="state" type="text" placeholder="Greater London" autocomplete="address-level1">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="postalCode">Postal code</label>
            <input id="postalCode" name="postalCode" type="text" required placeholder="EC1A 1BB" autocomplete="postal-code">
          </div>
          <div class="field">
            <label for="country">Country</label>
            <select id="country" name="country" required autocomplete="country">
              <option value="GB">United Kingdom</option>
              <option value="US">United States</option>
              <option value="IN">India</option>
              <option value="DE">Germany</option>
            </select>
          </div>
        </div>

        <h2 class="fieldset-title">Payment</h2>
        <div class="alert alert-info">
          <div><strong>Demo checkout — no real money moves.</strong>Use <span class="kbd-note">4242 4242 4242 4242</span> to succeed, or <span class="kbd-note">tok_declined</span> to watch the saga compensate.</div>
        </div>
        <div class="field">
          <label for="cardNumber">Card number</label>
          <input id="cardNumber" name="cardNumber" type="text" inputmode="numeric" required value="4242 4242 4242 4242" autocomplete="cc-number">
          <span class="hint">Tokenised in the browser; the raw PAN never reaches our APIs.</span>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="expiry">Expiry</label>
            <input id="expiry" name="expiry" type="text" required value="12/29" placeholder="MM/YY" autocomplete="cc-exp">
          </div>
          <div class="field">
            <label for="cvc">CVC</label>
            <input id="cvc" name="cvc" type="text" required value="123" inputmode="numeric" autocomplete="cc-csc">
          </div>
        </div>
        <button class="btn btn-accent btn-block" type="submit">Pay ${money(totals.totalCents)}</button>
        <p class="muted">By paying you agree to our terms. Requests are idempotent — a double click will never charge you twice.</p>
      </div>
      <aside class="panel panel-sticky">
        <h2>Your order</h2>
        ${cart.items
          .map(
            (item) => `<div class="line-item">
              <span class="line-thumb"><img src="${esc(item.image)}" alt="" width="64" height="64"></span>
              <div><p class="line-title">${esc(item.name)}</p><p class="line-meta">Qty ${item.quantity} · ${money(item.unitPriceCents)}</p></div>
              <div class="line-total">${money(item.unitPriceCents * item.quantity)}</div>
            </div>`,
          )
          .join('')}
        <div class="divider"></div>
        <div class="summary-row"><span>Subtotal</span><span>${money(totals.subtotalCents)}</span></div>
        <div class="summary-row"><span>Shipping</span><span>${totals.shippingCents === 0 ? 'Free' : money(totals.shippingCents)}</span></div>
        <div class="summary-row"><span>Tax</span><span>${money(totals.taxCents)}</span></div>
        <div class="summary-row total"><span>Total</span><span class="price">${money(totals.totalCents)}</span></div>
      </aside>
    </form>
  </div>`;

  return layout({ title: 'Checkout', description: 'Complete your ShopStack order.', body, cartCount: totals.itemCount, version, environment });
}

export function renderOrder({ order, version, environment }) {
  const confirmed = order.status === 'confirmed';
  const body = `
  <div class="page">
    <div class="confirm-head">
      <div class="tick" aria-hidden="true">
        ${
          confirmed
            ? '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 12.5l5 5L20 6.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            : '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 7v7M12 17.5v.5" stroke-linecap="round"/></svg>'
        }
      </div>
      <p class="eyebrow">Order ${esc(order.id)}</p>
      <h1>${confirmed ? 'Thank you — your order is confirmed.' : `This order is ${esc(order.status)}.`}</h1>
      <p class="muted">A confirmation is on its way to ${esc(order.customer?.email ?? 'your inbox')}. Keep the order number handy for tracking.</p>
    </div>
    <div class="cart-layout">
      <div class="panel">
        <h2>What’s on the way</h2>
        ${order.items
          .map(
            (item) => `<div class="line-item">
              <span class="line-thumb"><img src="${esc(item.image)}" alt="" width="84" height="84"></span>
              <div><p class="line-title">${esc(item.name)}</p><p class="line-meta">Qty ${item.quantity} · ${money(item.unitPriceCents)}</p></div>
              <div class="line-total">${money(item.lineTotalCents)}</div>
            </div>`,
          )
          .join('')}
        <div class="divider"></div>
        <div class="summary-row"><span>Subtotal</span><span>${money(order.pricing.subtotalCents)}</span></div>
        <div class="summary-row"><span>Shipping</span><span>${order.pricing.shippingCents === 0 ? 'Free' : money(order.pricing.shippingCents)}</span></div>
        <div class="summary-row"><span>Tax</span><span>${money(order.pricing.taxCents)}</span></div>
        <div class="summary-row total"><span>Total paid</span><span class="price">${money(order.pricing.totalCents)}</span></div>
      </div>
      <aside class="panel">
        <h2>Order journey</h2>
        <ul class="timeline">
          ${order.timeline
            .filter((step) => step.status === 'succeeded')
            .map(
              (step) => `<li><span class="node" aria-hidden="true"></span>
                <span>${esc(step.step.replaceAll('_', ' '))}</span>
                <time datetime="${esc(step.at)}">${formatDate(step.at)}</time></li>`,
            )
            .join('')}
        </ul>
        <div class="divider"></div>
        <h2>Shipping to</h2>
        <p class="muted">${esc(order.customer?.name ?? '')}<br>
          ${esc(order.shippingAddress?.line1 ?? '')}${order.shippingAddress?.line2 ? `<br>${esc(order.shippingAddress.line2)}` : ''}<br>
          ${esc(order.shippingAddress?.city ?? '')}${order.shippingAddress?.state ? `, ${esc(order.shippingAddress.state)}` : ''} ${esc(order.shippingAddress?.postalCode ?? '')}<br>
          ${esc(order.shippingAddress?.country ?? '')}
        </p>
        <div class="divider"></div>
        <div class="summary-row"><span>Payment</span><span>${esc(order.payment?.method?.type ?? 'card')} ${order.payment?.provider?.last4 ? `•••• ${esc(order.payment.provider.last4)}` : ''}</span></div>
        <div class="summary-row"><span>Status</span><span class="badge ${confirmed ? 'badge-success' : 'badge-danger'}">${esc(order.payment?.status ?? order.status)}</span></div>
        <a class="btn btn-ghost btn-block" href="/">Continue shopping</a>
      </aside>
    </div>
  </div>`;

  return layout({
    title: `Order ${order.id}`,
    description: 'Your ShopStack order confirmation.',
    body,
    cartCount: 0,
    version,
    environment,
  });
}

/** Small lookup page linked from the footer so orders are reachable without a cookie. */
export function renderOrderLookup({ orderId, error, version, environment }) {
  const body = `
  <div class="page">
    <div class="section-head"><div><p class="eyebrow">Order support</p><h1>Track an order</h1></div></div>
    ${error ? alert({ tone: 'danger', title: 'Not found', message: error }) : ''}
    <form method="get" action="/orders/lookup" class="panel">
      <div class="field">
        <label for="orderId">Order number</label>
        <input id="orderId" name="orderId" type="text" value="${esc(orderId ?? '')}" placeholder="ord_1a2b3c…" required>
        <span class="hint">It is on your confirmation email, and at the top of the order page.</span>
      </div>
      <button class="btn btn-primary" type="submit">Find my order</button>
    </form>
  </div>`;
  return layout({ title: 'Track an order', description: 'Look up a ShopStack order.', body, cartCount: 0, version, environment });
}

export function renderError({ status = 500, title = 'Something went wrong', message, traceId, version, environment, cartCount = 0 }) {
  const body = `
  <div class="page">
    ${emptyState({
      title: `${status} — ${title}`,
      message: message ?? 'The page could not be rendered. Our team has been notified.',
      actionHref: '/',
      actionLabel: 'Back to the shop',
    })}
    ${traceId ? `<p class="muted">Reference: <span class="kbd-note">${esc(traceId)}</span></p>` : ''}
  </div>`;
  return layout({ title, description: title, body, cartCount, version, environment });
}
