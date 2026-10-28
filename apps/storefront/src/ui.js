/**
 * Server-side rendering primitives.
 *
 * No template engine, no client framework: the storefront returns complete HTML
 * documents with a hash-friendly query string for CSS/JS. That keeps Time To First
 * Byte low, keeps the Content-Security-Policy strict (`script-src 'self'`), and
 * means the shop still renders if the customer's JS fails to load.
 *
 * Everything interpolated into markup goes through `esc()`.
 */

export const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const CURRENCY_FORMATTERS = new Map();

/** Formats integer cents as currency. Money is never a float in this codebase. */
export function money(cents, currency = 'USD') {
  const key = currency;
  if (!CURRENCY_FORMATTERS.has(key)) {
    CURRENCY_FORMATTERS.set(key, new Intl.NumberFormat('en-US', { style: 'currency', currency: key }));
  }
  return CURRENCY_FORMATTERS.get(key).format((cents ?? 0) / 100);
}

export function formatDate(iso) {
  if (!iso) return '';
  return (
    new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(
      new Date(iso),
    ) + ' UTC'
  );
}

const star = `<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 1.6l2.6 5.3 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L1.5 7.7l5.9-.8z"/></svg>`;

export function ratingStars(rating, reviewCount) {
  return `<span class="rating" aria-label="Rated ${rating} out of 5 from ${reviewCount} reviews">${star}<strong>${rating.toFixed(1)}</strong><span aria-hidden="true">·</span>${reviewCount.toLocaleString('en-US')}</span>`;
}

export function stockNote(product) {
  if (product.stock === 0) return '<p class="stock-note out">Sold out</p>';
  if (product.stock <= 5) return `<p class="stock-note low">Only ${product.stock} left</p>`;
  return '<p class="stock-note">In stock, ships in 1–2 days</p>';
}

const NAV = [
  { href: '/', label: 'Shop all' },
  { href: '/category/audio', label: 'Audio' },
  { href: '/category/workspace', label: 'Workspace' },
  { href: '/category/outdoors', label: 'Outdoors' },
  { href: '/category/apparel', label: 'Apparel' },
];

/**
 * Wraps page content in the document shell.
 * @param {{title: string, description: string, body: string, cartCount?: number, activeNav?: string, version?: string, environment?: string}} opts
 */
export function layout({
  title,
  description,
  body,
  cartCount = 0,
  activeNav = '',
  version = 'dev',
  environment = 'local',
}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} · ShopStack</title>
  <meta name="description" content="${esc(description)}">
  <meta name="theme-color" content="#fbf9f5">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/assets/app.css?v=1">
  <script src="/assets/app.js?v=1" defer></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <div class="announce">
    <div class="page">
      <span>Free carbon-neutral shipping over $75</span>
      <span>30-day returns, no questions</span>
      <span>2-year warranty on all electronics</span>
    </div>
  </div>
  <header class="site-header">
    <div class="page">
      <a class="brand" href="/" aria-label="ShopStack home">
        <span class="brand-mark" aria-hidden="true">S</span>
        ShopStack
      </a>
      <nav class="nav" aria-label="Primary">
        ${NAV.map(
          (item) => `<a href="${item.href}"${activeNav === item.href ? ' aria-current="page"' : ''}>${item.label}</a>`,
        ).join('')}
      </nav>
      <div class="header-actions">
        <form class="search" role="search" action="/search" method="get">
          <label class="sr-only" for="q">Search products</label>
          <input id="q" name="q" type="search" placeholder="Search the shop…" autocomplete="off">
          <button type="submit" aria-label="Search">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4 4" stroke-linecap="round"/>
            </svg>
          </button>
        </form>
        <a class="cart-link" href="/cart">
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
            <path d="M3 5h2l1.6 8.4A2 2 0 008.6 15h6.2a2 2 0 002-1.6L18 8H6" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="8.5" cy="17.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="17.5" r="1.2" fill="currentColor" stroke="none"/>
          </svg>
          <span>Bag</span>
          <span class="cart-count" data-cart-count${cartCount === 0 ? ' hidden' : ''}>${cartCount}</span>
        </a>
      </div>
    </div>
  </header>
  <main id="main">
    ${body}
  </main>
  <footer class="site-footer">
    <div class="page">
      <div class="footer-inner">
        <div class="footer-brand">
          <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">S</span> ShopStack</a>
          <p>Considered objects for the way you actually live — audio, workspace, home and the outdoors.</p>
          <p class="footer-build"><span class="kbd-note">v${esc(version)}</span> <span class="kbd-note">${esc(environment)}</span></p>
        </div>
        <div>
          <h4>Shop</h4>
          <ul>
            <li><a href="/category/audio">Audio</a></li>
            <li><a href="/category/workspace">Workspace</a></li>
            <li><a href="/category/home">Home</a></li>
            <li><a href="/category/outdoors">Outdoors</a></li>
            <li><a href="/category/accessories">Accessories</a></li>
          </ul>
        </div>
        <div>
          <h4>Service</h4>
          <ul>
            <li><a href="/cart">Your bag</a></li>
            <li><a href="/orders/lookup">Track an order</a></li>
            <li><a href="/healthz">Service status</a></li>
            <li><a href="/metrics">Metrics</a></li>
          </ul>
        </div>
        <div>
          <h4>Platform</h4>
          <ul>
            <li>Argo CD · GitOps</li>
            <li>Argo Rollouts · canary</li>
            <li>Prometheus · Grafana</li>
            <li>Trivy · Cosign · Kyverno</li>
          </ul>
        </div>
      </div>
      <div class="footer-bottom">
        <span>© ${new Date().getFullYear()} ShopStack. A reference GitOps platform — no real payments are processed.</span>
        <span>Prices in USD · Demo data</span>
      </div>
    </div>
  </footer>
</body>
</html>`;
}

export function productCard(product, { categoryLabel = '' } = {}) {
  const soldOut = product.stock === 0;
  return `<article class="card">
    <a class="card-media" href="/product/${esc(product.slug)}" aria-label="${esc(product.name)}">
      <img src="${esc(product.image)}" alt="" width="188" height="188" loading="lazy">
      <span class="card-flag">
        ${product.featured ? '<span class="badge badge-accent">Editor’s pick</span>' : ''}
        ${soldOut ? '<span class="badge badge-danger">Sold out</span>' : ''}
      </span>
    </a>
    <div class="card-body">
      <span class="card-cat">${esc(categoryLabel || product.category)}</span>
      <h3 class="card-title"><a href="/product/${esc(product.slug)}">${esc(product.name)}</a></h3>
      ${ratingStars(product.rating, product.reviewCount)}
      <div class="card-foot">
        <span class="price">${money(product.priceCents, product.currency)}</span>
        ${soldOut ? '<span class="stock-note out">Sold out</span>' : stockNote(product)}
      </div>
    </div>
    ${
      soldOut
        ? ''
        : `<div class="card-quick">
            <form method="post" action="/cart/items" data-add-to-cart>
              <input type="hidden" name="productId" value="${esc(product.id)}">
              <input type="hidden" name="quantity" value="1">
              <input type="hidden" name="returnTo" value="${esc(product.slug ? `/product/${product.slug}` : '/')}">
              <button type="submit" aria-label="Add ${esc(product.name)} to bag">
                <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true">
                  <path d="M10 4v12M4 10h12" stroke-linecap="round"/>
                </svg>
              </button>
            </form>
          </div>`
    }
  </article>`;
}

/** Quantity stepper; works without JS because the +/- are submit buttons. */
export function quantityStepper({ value = 1, max = 20, action, productId, returnTo }) {
  return `<form class="qty" method="post" action="${action}" data-qty-form>
    <input type="hidden" name="productId" value="${esc(productId)}">
    ${returnTo ? `<input type="hidden" name="returnTo" value="${esc(returnTo)}">` : ''}
    <button type="button" data-qty-step="-1" aria-label="Decrease quantity">−</button>
    <input type="number" name="quantity" value="${value}" min="1" max="${max}" aria-label="Quantity" inputmode="numeric">
    <button type="button" data-qty-step="1" aria-label="Increase quantity">+</button>
    <noscript><button type="submit" class="btn btn-sm btn-ghost">Update</button></noscript>
  </form>`;
}

export function alert({ tone = 'info', title, message }) {
  return `<div class="alert alert-${tone}" role="${tone === 'danger' ? 'alert' : 'status'}">
    ${title ? `<div><strong>${esc(title)}</strong>${message ? esc(message) : ''}</div>` : `<div>${esc(message)}</div>`}
  </div>`;
}

export function emptyState({ title, message, actionHref, actionLabel }) {
  return `<div class="empty">
    <p class="eyebrow">Nothing here yet</p>
    <h1>${esc(title)}</h1>
    <p>${esc(message)}</p>
    <a class="btn btn-primary" href="${esc(actionHref)}">${esc(actionLabel)}</a>
  </div>`;
}
