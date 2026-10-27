import Fastify from 'fastify';
import { installHttpLayer, requestId } from './http.js';
import { installHttpMetrics } from './metrics.js';
import { HealthRegistry } from './health.js';

/**
 * The service wrapper: everything that is identical across the five services.
 *
 * A service supplies `routes` (and optionally `plugins`); it gets logging,
 * metrics, probes, the problem+json contract, chaos injection, request ids,
 * security headers and graceful shutdown for free. Keeping this here — rather than
 * copied into each service — is why a cross-cutting change (a new header, a new
 * probe) is a one-file pull request.
 */
export async function createService({
  config,
  metrics,
  logger,
  health = new HealthRegistry(),
  chaos,
  security = { frameOptions: true },
  plugins = [],
  routes,
}) {
  const app = Fastify({
    ...(logger ? { loggerInstance: logger } : { logger: false }),
    disableRequestLogging: true,
    requestTimeout: config.REQUEST_TIMEOUT_MS,
    bodyLimit: config.HTTP_BODY_LIMIT_BYTES,
    trustProxy: true,
    genReqId: (request) => requestId(request),
    // `removeAdditional: true` strips unknown body fields instead of rejecting
    // them: a client sending `totalCents: 1` must not be able to influence — nor
    // break — a request whose total is computed server-side.
    ajv: { customOptions: { allErrors: true, removeAdditional: true, coerceTypes: 'array', useDefaults: true } },
  });

  app.decorate('config', config);
  app.decorate('metrics', metrics);

  installHttpLayer(app, { config, metrics });
  installHttpMetrics(app, metrics);

  // CSP is per-service (the storefront serves HTML, the APIs do not), but the
  // framing policy is uniform unless a service opts out — the storefront is
  // embedded in the platform's preview iframe.
  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.url.startsWith('/metrics')) {
      if (security.frameOptions !== false) reply.header('x-frame-options', 'DENY');
      if (!reply.getHeader('content-security-policy')) {
        reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      }
    }
    return payload;
  });

  if (chaos?.enabled) {
    app.addHook('onRequest', (request) => chaos.middleware(request));
    chaos.registerRoutes?.(app);
  }

  // ── Probes and telemetry ──────────────────────────────────────────────────
  app.get('/healthz', async (request, reply) => {
    // Liveness: the event loop answered. Dependencies belong in /readyz.
    if (health.shuttingDown) return reply.code(503).send({ status: 'draining' });
    return reply.send({
      status: 'ok',
      service: config.SERVICE_NAME,
      version: config.SERVICE_VERSION,
      environment: config.DEPLOYMENT_ENVIRONMENT,
      uptimeSeconds: Math.round((Date.now() - health.startedAt) / 1000),
    });
  });

  app.get('/livez', async (request, reply) =>
    reply.code(health.shuttingDown ? 503 : 200).send({ status: health.shuttingDown ? 'draining' : 'ok' }),
  );

  app.get('/startupz', async (request, reply) =>
    reply.code(health.ready ? 200 : 503).send({ status: health.ready ? 'ok' : 'starting' }),
  );

  app.get('/readyz', async (request, reply) => {
    const result = await health.check();
    const ready = result.status !== 'fail';
    return reply.code(ready ? 200 : 503).send({ ...result, ready, version: config.SERVICE_VERSION });
  });

  app.get('/metrics', async (request, reply) => {
    const body = await metrics.render();
    return reply.header('content-type', metrics.contentType).send(body);
  });

  app.get('/info', async () => ({
    service: config.SERVICE_NAME,
    version: config.SERVICE_VERSION,
    commit: config.SERVICE_COMMIT,
    environment: config.DEPLOYMENT_ENVIRONMENT,
    node: process.version,
    ready: health.ready,
  }));

  for (const plugin of plugins) await app.register(plugin);
  await routes(app);

  const shutdownHooks = [];
  const api = {
    app,
    config,
    metrics,
    health,
    chaos,
    logger: app.log,
    markReady: () => health.markReady(),
    onShutdown: (fn) => {
      shutdownHooks.push(fn);
      return api;
    },
    installSignalHandlers: () => installSignalHandlers(api, shutdownHooks),
    /** Binds the port and flips the startup probe. */
    async start() {
      await app.listen({ port: config.PORT, host: config.HOST });
      health.markReady();
      app.log.info(
        { port: config.PORT, environment: config.DEPLOYMENT_ENVIRONMENT, service: config.SERVICE_NAME },
        'service listening',
      );
      return api;
    },
    async close() {
      await app.close();
    },
  };
  return api;
}

/**
 * Graceful shutdown in the order Kubernetes expects:
 *   1. fail readiness immediately (endpoint removal propagates while the pod is
 *      still serving — the chart's preStop sleep covers the propagation delay);
 *   2. stop accepting connections and let in-flight requests finish;
 *   3. close pools and clients;
 *   4. exit.
 */
function installSignalHandlers(api, shutdownHooks) {
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    api.health.markShuttingDown();
    api.logger.info({ signal }, 'shutting down');

    const timer = setTimeout(() => {
      api.logger.error({ timeoutMs: api.config.SHUTDOWN_TIMEOUT_MS }, 'graceful shutdown timed out, exiting');
      process.exit(1);
    }, api.config.SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    try {
      await api.app.close();
      for (const hook of shutdownHooks) await hook();
      clearTimeout(timer);
      api.logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      api.logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (error) => {
    api.logger.error({ err: error }, 'unhandled rejection');
  });
  process.on('uncaughtException', (error) => {
    api.logger.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });
}
