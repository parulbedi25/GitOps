/**
 * Cart service entrypoint.
 */
import {
  loadConfig,
  createLogger,
  createMetrics,
  HealthRegistry,
  createService,
  createChaosController,
  createHttpClient,
} from '@shopstack/telemetry';
import { configSchema } from './config.js';
import { createCartRepository } from './repository.js';
import { registerRoutes } from './routes.js';

async function main() {
  const config = loadConfig(configSchema);
  const logger = createLogger({
    service: config.SERVICE_NAME,
    version: config.SERVICE_VERSION,
    environment: config.DEPLOYMENT_ENVIRONMENT,
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY,
  });

  const metrics = createMetrics({
    service: config.SERVICE_NAME,
    version: config.SERVICE_VERSION,
    environment: config.DEPLOYMENT_ENVIRONMENT,
    commit: config.SERVICE_COMMIT,
  });

  const repository = await createCartRepository({
    driver: config.CART_DRIVER,
    redisUrl: config.REDIS_URL,
    ttlSeconds: config.CART_TTL_SECONDS,
    logger,
  });

  const catalogClient = createHttpClient({
    name: 'catalog',
    baseUrl: config.CATALOG_URL,
    metrics,
    logger,
    timeoutMs: config.CATALOG_TIMEOUT_MS,
    retries: 2,
    passthrough4xx: true,
  });

  const health = new HealthRegistry({ onEvent: (msg, meta) => logger.warn(meta ?? {}, msg) });
  health.register('cart-store', () => repository.healthCheck(), { critical: true });
  health.register(
    'catalog-api',
    async () => {
      try {
        await catalogClient.get('/healthz');
        return { ok: true, detail: 'catalog reachable' };
      } catch (err) {
        return { ok: false, detail: err.message };
      }
    },
    // Degraded, not down: browsing still works from cached data, so a catalog
    // blip must not remove every cart pod from the Service.
    { critical: false },
  );

  const chaos = createChaosController({ enabled: config.ALLOW_CHAOS, metrics, logger });

  const service = await createService({
    config,
    metrics,
    logger,
    health,
    chaos,
    routes: (app) => registerRoutes({ app, repository, metrics, config, catalogClient }),
  });

  service.onShutdown(() => repository.close());
  service.installSignalHandlers();
  await service.start();
}

main().catch((err) => {
  console.error(`[cart-service] fatal: ${err.message}`);
  process.exit(1);
});
