#!/usr/bin/env node
/**
 * End-to-end smoke test against a running local stack.
 *
 *   ./scripts/dev-stack.sh
 *   npm run smoke
 *
 * It exercises the whole shopper journey through the storefront's real HTTP
 * surface, including the failure path that matters most in commerce: a declined
 * card must leave inventory exactly as it found it.
 *
 * Exit code 0 = every assertion passed. This is the same journey the Kubernetes
 * deployment gets checked with after a rollout.
 */
const BASE = process.env.STOREFRONT_URL ?? 'http://localhost:8080';
const SERVICES = {
  catalog: process.env.CATALOG_URL ?? 'http://localhost:8081',
  cart: process.env.CART_URL ?? 'http://localhost:8082',
  payments: process.env.PAYMENTS_URL ?? 'http://localhost:8083',
  checkout: process.env.CHECKOUT_URL ?? 'http://localhost:8084',
  storefront: BASE,
};

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

/** A cookie jar, because the storefront keeps the cart id in a cookie. */
class Jar {
  constructor() {
    this.cookies = new Map();
  }

  absorb(response) {
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const [name, value] = pair.split('=');
      this.cookies.set(name.trim(), value);
    }
  }

  header() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

async function request(url, { method = 'GET', jar, body, headers = {}, redirect = 'manual', json = false } = {}) {
  const response = await fetch(url, {
    method,
    redirect,
    headers: {
      ...(jar && jar.cookies.size ? { cookie: jar.header() } : {}),
      ...(json ? { accept: 'application/json' } : {}),
      ...(body && !json ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...headers,
    },
    body: json && body ? JSON.stringify(body) : body,
    signal: AbortSignal.timeout(15_000),
  });
  jar?.absorb(response);
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, location: response.headers.get('location') };
}

const form = (fields) => new URLSearchParams(fields).toString();

async function stockOf(sku) {
  const response = await request(`${SERVICES.catalog}/api/products/${sku}`, { json: true });
  return response.status === 200 ? JSON.parse(response.text).stock : null;
}

async function main() {
  console.log(`\n\u001b[1mShopStack smoke test\u001b[0m  ${BASE}\n`);

  section('Health of all five services');
  for (const [name, url] of Object.entries(SERVICES)) {
    const live = await request(`${url}/healthz`);
    const ready = await request(`${url}/readyz`);
    check(`${name} is live (/healthz 200)`, live.status === 200, `status ${live.status}`);
    check(`${name} is ready (/readyz 200)`, ready.status === 200, `status ${ready.status}`);
    const metrics = await request(`${url}/metrics`);
    check(`${name} exposes shopstack_ metrics`, metrics.status === 200 && metrics.text.includes('shopstack_http_requests_total'));
  }

  section('Storefront rendering');
  const home = await request(BASE);
  check('home page renders', home.status === 200, `status ${home.status}`);
  check('home page lists products', /class="card/.test(home.text));
  check('home page sends a strict CSP', /default-src 'self'/.test(home.headers.get('content-security-policy') ?? ''));
  check('responses carry a request id', Boolean(home.headers.get('x-request-id')));

  const productSlug = home.text.match(/href="\/product\/([a-z0-9-]+)"/)?.[1];
  check('home page links to a product detail page', Boolean(productSlug), 'no product link found');
  if (productSlug) {
    const product = await request(`${BASE}/product/${productSlug}`);
    check('product detail page renders', product.status === 200, `status ${product.status}`);
    const art = await request(`${BASE}/media/${productSlug}.svg`);
    check('product artwork is served as SVG', art.status === 200 && art.text.includes('<svg'));
  }

  section('Happy path: add to bag → checkout → order');
  const sku = 'sku-1001';
  const stockBefore = await stockOf(sku);
  const jar = new Jar();
  await request(`${BASE}/cart`, { jar });

  const add = await request(`${BASE}/cart/items`, {
    method: 'POST',
    jar,
    body: form({ productId: sku, quantity: '1', returnTo: '/cart' }),
  });
  check('add to bag redirects back to the cart', add.status === 303 && add.location.endsWith('/cart'), `${add.status} ${add.location}`);

  const cart = await request(`${BASE}/cart`, { jar });
  check('cart shows the item', cart.text.includes('Atlas ANC Headphones'));
  check('cart shows a money total', /\$\d+\.\d{2}/.test(cart.text));

  const checkoutPage = await request(`${BASE}/checkout`, { jar });
  const idempotencyKey = checkoutPage.text.match(/name="idempotencyKey" value="([^"]+)"/)?.[1];
  check('checkout page exposes an idempotency key', Boolean(idempotencyKey));

  const placed = await request(`${BASE}/checkout`, {
    method: 'POST',
    jar,
    body: form({
      idempotencyKey,
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      line1: '12 Analytical Way',
      city: 'London',
      postalCode: 'EC1A 1BB',
      country: 'GB',
      cardNumber: '4242 4242 4242 4242',
    }),
  });
  check('order is accepted and redirected to the confirmation', placed.status === 303 && /\/orders\/ord_/.test(placed.location ?? ''), `${placed.status} ${placed.location}`);

  if (placed.location) {
    const order = await request(new URL(placed.location, BASE).toString(), { jar });
    check('order confirmation renders', order.status === 200, `status ${order.status}`);
    check('confirmation names the order', /ord_[0-9a-f-]{8}/.test(order.text));
  }

  const stockAfter = await stockOf(sku);
  check('stock was decremented by exactly one', stockBefore !== null && stockAfter === stockBefore - 1, `${stockBefore} → ${stockAfter}`);

  section('Failure path: declined card is fully compensated');
  const declineSku = 'sku-1014';
  const declineStockBefore = await stockOf(declineSku);
  const jar2 = new Jar();
  await request(`${BASE}/cart/items`, { method: 'POST', jar: jar2, body: form({ productId: declineSku, quantity: '1' }) });

  const checkoutPage2 = await request(`${BASE}/checkout`, { jar: jar2 });
  const key2 = checkoutPage2.text.match(/name="idempotencyKey" value="([^"]+)"/)?.[1];
  const declined = await request(`${BASE}/checkout`, {
    method: 'POST',
    jar: jar2,
    body: form({
      idempotencyKey: key2,
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      line1: '12 Analytical Way',
      city: 'London',
      postalCode: 'EC1A 1BB',
      country: 'GB',
      cardNumber: '4000 0000 0000 0002',
    }),
  });
  check('declined payment returns 402', declined.status === 402, `status ${declined.status}`);
  check('declined page explains nothing was charged', /No money was taken/i.test(declined.text));

  const declineStockAfter = await stockOf(declineSku);
  check('stock is restored after the saga compensates', declineStockAfter === declineStockBefore, `${declineStockBefore} → ${declineStockAfter}`);

  section('Observability contract');
  const metrics = await request(`${BASE}/metrics`);
  for (const metric of [
    'shopstack_storefront_page_renders_total',
    'shopstack_http_request_duration_seconds_bucket',
    'shopstack_build_info',
  ]) {
    check(`metrics expose ${metric}`, metrics.text.includes(metric));
  }
  const orders = await request(`${SERVICES.checkout}/internal/orders/stats`, { json: true });
  check('checkout reports order statistics', orders.status === 200);

  console.log(`\n${failures.length === 0 ? '\u001b[32m' : '\u001b[31m'}${passed} checks passed, ${failures.length} failed\u001b[0m\n`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  failed: ${failure.name} ${failure.detail}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`\n\u001b[31msmoke test crashed\u001b[0m: ${error.message}`);
  console.error('Is the stack running?  ./scripts/dev-stack.sh');
  process.exit(1);
});
