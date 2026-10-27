/**
 * Checkout service entrypoint.
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
import { createOrderRepository } from './repository.js';
import { CheckoutService } from './checkout.js';
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

  if (config.DB_DRIVER === 'postgres' && !config.DATABASE_URL) {
    throw new Error('DB_DRIVER=postgres requires DATABASE_URL');
  }

  const metrics = createMetrics({
    service: config.SERVICE_NAME,
    version: config.SERVICE_VERSION,
    environment: config.DEPLOYMENT_ENVIRONMENT,
    commit: config.SERVICE_COMMIT,
  });

  const repository = await createOrderRepository({
    driver: config.DB_DRIVER,
    connectionString: config.DATABASE_URL,
    logger,
  });

  const clientOptions = { metrics, logger, timeoutMs: config.STEP_TIMEOUT_MS, retries: 2, passthrough4xx: true };
  const cartClient = createHttpClient({ name: 'cart', baseUrl: config.CART_URL, ...clientOptions });
  const catalogClient = createHttpClient({ name: 'catalog', baseUrl: config.CATALOG_URL, ...clientOptions });
  const paymentsClient = createHttpClient({ name: 'payments', baseUrl: config.PAYMENTS_URL, ...clientOptions });

  const service = new CheckoutService({
    repository,
    cartClient,
    catalogClient,
    paymentsClient,
    metrics,
    logger,
  });

  const health = new HealthRegistry({ onEvent: (msg, meta) => logger.warn(meta ?? {}, msg) });
  health.register('order-store', () => repository.healthCheck(), { critical: true });
  for (const [name, client] of [
    ['cart-api', cartClient],
    ['catalog-api', catalogClient],
    ['payments-api', paymentsClient],
  ]) {
    health.register(
      name,
      async () => {
        try {
          await client.get('/healthz');
          return { ok: true, detail: `${name} reachable` };
        } catch (err) {
          return { ok: false, detail: err.message };
        }
      },
      // Degraded, not fatal: checkout already surfaces per-step failures through
      // its saga metrics, and pulling pods out of the Service cannot help a
      // dependency that is down for everyone.
      { critical: false },
    );
  }

  const chaos = createChaosController({ enabled: config.ALLOW_CHAOS, metrics, logger });

  const app = await createService({
    config,
    metrics,
    logger,
    health,
    chaos,
    routes: (fastify) => registerRoutes({ app: fastify, service, config }),
  });

  app.onShutdown(() => repository.close());
  app.installSignalHandlers();
  await app.start();
}

main().catch((err) => {
  console.error(`[checkout-service] fatal: ${err.message}`);
  process.exit(1);
});
