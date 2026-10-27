import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  loadConfig,
  serviceSchema,
  AppError,
  badRequest,
  conflict,
  notFound,
  unprocessable,
  createMetrics,
  HealthRegistry,
  createHttpClient,
  createService,
  createChaosController,
} from '../src/index.js';
import { silentLogger, testConfig } from '../src/testing.js';

const cleanEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in cleanEnv)) delete process.env[key];
  }
  Object.assign(process.env, cleanEnv);
});

describe('configuration', () => {
  test('applies defaults and derives environment flags', () => {
    for (const key of ['SERVICE_NAME', 'PORT', 'LOG_LEVEL', 'ALLOW_CHAOS', 'DEPLOYMENT_ENVIRONMENT']) {
      delete process.env[key];
    }
    process.env.NODE_ENV = 'test';
    const config = loadConfig(serviceSchema({ FEATURE_FLAG: z.coerce.boolean().default(false) }));

    assert.equal(config.SERVICE_NAME, 'shopstack-service');
    assert.equal(config.PORT, 8080);
    assert.equal(config.HOST, '0.0.0.0');
    assert.equal(config.LOG_LEVEL, 'info');
    assert.equal(config.ALLOW_CHAOS, false);
    assert.equal(config.isTest, true);
    assert.equal(config.isProduction, false);
    assert.equal(config.FEATURE_FLAG, false);
  });

  test('coerces numbers and booleans from strings', () => {
    process.env.PORT = '8099';
    process.env.ALLOW_CHAOS = 'true';
    process.env.REQUEST_TIMEOUT_MS = '2500';
    const config = loadConfig();
    assert.equal(config.PORT, 8099);
    assert.equal(config.ALLOW_CHAOS, true);
    assert.equal(config.REQUEST_TIMEOUT_MS, 2500);
  });

  test('fails fast with the offending variable named', () => {
    process.env.PORT = 'not-a-port';
    assert.throws(() => loadConfig(), /PORT/);
    process.env.PORT = '8080';
  });
});

describe('error model', () => {
  test('renders an RFC 9457 problem document', () => {
    const error = new AppError({ title: 'Payment declined', status: 402, code: 'payment-declined', detail: 'insufficient_funds', reason: 'insufficient_funds' });
    const problem = error.toProblem('trace-1');
    assert.deepEqual(problem, {
      type: 'https://errors.shopstack.dev/payment-declined',
      title: 'Payment declined',
      status: 402,
      code: 'payment-declined',
      detail: 'insufficient_funds',
      reason: 'insufficient_funds',
      traceId: 'trace-1',
    });
  });

  test('moves a list of field errors into errors[]', () => {
    const error = new AppError({ title: 'Insufficient stock', status: 409, code: 'out-of-stock', detail: [{ productId: 'sku-1', available: 0 }] });
    const problem = error.toProblem('trace-2');
    assert.equal(problem.detail, 'Insufficient stock');
    assert.equal(problem.errors[0].productId, 'sku-1');
  });

  test('never leaks the detail of a 5xx', () => {
    const error = new AppError({ title: 'Database exploded', status: 500, code: 'internal-error', detail: 'connection string postgres://user:pw@host' });
    assert.equal(error.toProblem('trace-3').detail, undefined);
  });

  test('helpers produce stable status codes and slugs', () => {
    assert.equal(badRequest('nope').status, 400);
    assert.equal(conflict('Cart is locked', 'in progress', 'cart-locked').code, 'cart-locked');
    assert.equal(unprocessable('Cart is empty', 'add an item', 'cart-empty').status, 422);
    const missing = notFound('Cart item', 'itm-1');
    assert.equal(missing.status, 404);
    assert.equal(missing.code, 'cart-item-not-found');
    assert.match(missing.message, /itm-1/);
  });
});

describe('health registry', () => {
  test('reports ok when every check passes', async () => {
    const health = new HealthRegistry();
    health.register('store', async () => ({ ok: true, detail: 'ready' }));
    const result = await health.check();
    assert.equal(result.status, 'ok');
    assert.equal(result.checks[0].name, 'store');
  });

  test('degrades on a non-critical failure but stays ready', async () => {
    const health = new HealthRegistry();
    health.register('store', () => ({ ok: true }), { critical: true });
    health.register('psp', () => ({ ok: false, detail: 'no secret' }), { critical: false });
    const result = await health.check();
    assert.equal(result.status, 'degraded');
  });

  test('fails readiness when a critical check fails or times out', async () => {
    const health = new HealthRegistry();
    health.register('store', () => ({ ok: false, detail: 'down' }), { critical: true });
    health.register('slow', () => new Promise(() => {}), { critical: false, timeoutMs: 20 });
    const result = await health.check();
    assert.equal(result.status, 'fail');
    assert.equal(result.checks.find((check) => check.name === 'slow').ok, false);
  });
});

describe('metrics', () => {
  test('namespaces domain metrics and labels every series with the service', async () => {
    const metrics = createMetrics({ service: 'demo-service', version: '1.2.3', environment: 'test', commit: 'abc1234' });
    metrics.counter('orders_total', 'Orders by status.', ['status']).labels('confirmed').inc();
    metrics.gauge('inflight', 'In flight.').set(3);

    const rendered = await metrics.render();
    assert.match(rendered, /^shopstack_orders_total\{(?=[^}]*service="demo-service")(?=[^}]*status="confirmed")[^}]*\} 1$/m);
    assert.match(rendered, /^shopstack_inflight\{(?=[^}]*service="demo-service")[^}]*\} 3$/m);
    assert.match(rendered, /shopstack_build_info\{[^}]*version="1.2.3"/);
    assert.match(rendered, /shopstack_nodejs_heap_size_used_bytes|shopstack_process_cpu_seconds_total/);
  });
});

describe('http client', () => {
  const metrics = createMetrics({ service: 'caller', version: '1.0.0', environment: 'test' });
  let server;
  let baseUrl;

  test('calls a downstream service and propagates problem details', async () => {
    const service = await createService({
      config: testConfig({ SERVICE_NAME: 'fake-catalog', REQUEST_TIMEOUT_MS: 2000 }),
      metrics: createMetrics({ service: 'fake-catalog', version: '1.0.0', environment: 'test' }),
      logger: silentLogger(),
      chaos: createChaosController({ enabled: false }),
      routes: (app) => {
        app.get('/api/products/:id', async (request) => ({ id: request.params.id, name: 'Atlas' }));
        app.post('/internal/stock/reservations', async () => {
          throw conflict('Insufficient stock', 'only 2 units', 'out-of-stock');
        });
        app.get('/slow', async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return { ok: true };
        });
        let flakyAttempts = 0;
        app.get('/flaky', async () => {
          flakyAttempts += 1;
          if (flakyAttempts === 1) throw new AppError({ title: 'Boom', status: 503, code: 'boom' });
          return { ok: true, attempt: flakyAttempts };
        });
      },
    });
    server = service.app;
    await server.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${server.server.address().port}`;

    const client = createHttpClient({ name: 'catalog', baseUrl, metrics, logger: silentLogger(), timeoutMs: 500, retries: 1 });

    const product = await client.get('/api/products/sku-1');
    assert.equal(product.name, 'Atlas');

    await assert.rejects(client.post('/internal/stock/reservations', { items: [] }), (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'out-of-stock');
      return true;
    });

    const impatient = createHttpClient({ name: 'catalog-slow', baseUrl, metrics, logger: silentLogger(), timeoutMs: 50 });
    await assert.rejects(impatient.get('/slow'), (error) => {
      assert.equal(error.status, 504);
      assert.equal(error.code, 'upstream-catalog-slow-timeout');
      return true;
    });

    // A 5xx is retried: the first attempt fails, the second succeeds.
    const retrying = createHttpClient({ name: 'flaky', baseUrl, metrics, logger: silentLogger(), retries: 1 });
    const retried = await retrying.get('/flaky');
    assert.equal(retried.attempt, 2);
  });

  test('records dependency metrics', async () => {
    const rendered = await metrics.render();
    assert.match(rendered, /shopstack_dependency_up\{[^}]*dependency="catalog"/);
    assert.match(rendered, /shopstack_dependency_request_duration_seconds_count/);
    await new Promise((resolve) => server.close(resolve));
  });
});

describe('service wrapper', () => {
  test('adds request ids, security headers and problem documents', async () => {
    const service = await createService({
      config: testConfig({ SERVICE_NAME: 'probe-service' }),
      metrics: createMetrics({ service: 'probe-service', version: '1.0.0', environment: 'test' }),
      logger: silentLogger(),
      chaos: createChaosController({ enabled: false }),
      routes: (app) => {
        app.get('/boom', async () => {
          throw new AppError({ title: 'Nope', status: 418, code: 'teapot' });
        });
      },
    });
    service.markReady();

    const ok = await service.app.inject({ url: '/healthz', headers: { 'x-request-id': 'req-123' } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().status, 'ok');
    assert.equal(ok.headers['x-request-id'], 'req-123');
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.match(ok.headers['content-security-policy'], /default-src 'none'/);

    const problem = await service.app.inject({ url: '/boom' });
    assert.equal(problem.statusCode, 418);
    assert.equal(problem.json().code, 'teapot');
    assert.ok(problem.json().traceId);

    const missing = await service.app.inject({ url: '/nope' });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().code, 'route-not-found');

    assert.equal((await service.app.inject({ url: '/readyz' })).statusCode, 200);
    assert.match((await service.app.inject({ url: '/metrics' })).body, /shopstack_http_requests_total/);
    await service.app.close();
  });

  test('a service that has not finished starting fails its startup probe', async () => {
    const service = await createService({
      config: testConfig({ SERVICE_NAME: 'starting-service' }),
      metrics: createMetrics({ service: 'starting-service', version: '1.0.0', environment: 'test' }),
      logger: silentLogger(),
      chaos: createChaosController({ enabled: false }),
      routes: async () => {},
    });
    assert.equal((await service.app.inject({ url: '/startupz' })).statusCode, 503);
    service.markReady();
    assert.equal((await service.app.inject({ url: '/startupz' })).statusCode, 200);
    await service.app.close();
  });
});
