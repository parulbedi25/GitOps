/**
 * Catalog service entrypoint.
 */
import {
  loadConfig,
  createLogger,
  createMetrics,
  HealthRegistry,
  createService,
  createChaosController,
} from '@shopstack/telemetry';
import { configSchema } from './config.js';
import { createRepository } from './catalog.js';
import { TtlCache } from './cache.js';
import { registerRoutes } from './routes.js';
import { categories, products } from './data/products.js';

async function main() {
  const config = loadConfig(configSchema);
  const logger = createLogger({
    service: config.SERVICE_NAME,
    version: config.SERVICE_VERSION,
    environment: config.DEPLOYMENT_ENVIRONMENT,
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY,
  });

  if (config.DB_DRIVER === 'postgres' && !config.DATABASE_URL) {
    throw new Error('DB_DRIVER=postgres requires DATABASE_URL');
  }

  const metrics = createMetrics({
    service: config.SERVICE_NAME,
    version: config.SERVICE_VERSION,
    environment: config.DEPLOYMENT_ENVIRONMENT,
    commit: config.SERVICE_COMMIT,
  });

  const repository = await createRepository({
    driver: config.DB_DRIVER,
    connectionString: config.DATABASE_URL,
    logger,
    products,
    categories,
  });

  const cache = new TtlCache({ ttlMs: config.CACHE_TTL_MS });

  const health = new HealthRegistry({ onEvent: (msg, meta) => logger.warn(meta ?? {}, msg) });
  // The catalogue store is the only thing this service cannot work without.
  health.register('catalog-store', () => repository.healthCheck(), { critical: true });

  const chaos = createChaosController({ enabled: config.ALLOW_CHAOS, metrics, logger });

  const service = await createService({
    config,
    metrics,
    logger,
    health,
    chaos,
    routes: (app) => registerRoutes({ app, repository, metrics, cache, config }),
  });

  service.onShutdown(() => repository.close());
  service.installSignalHandlers();
  await service.start();
}

main().catch((err) => {
  console.error(`[catalog-service] fatal: ${err.message}`);
  process.exit(1);
});
