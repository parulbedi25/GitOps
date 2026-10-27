/**
 * Storefront entrypoint.
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

  const catalogClient = createHttpClient({
    name: 'catalog',
    baseUrl: config.CATALOG_URL,
    metrics,
    logger,
    timeoutMs: config.CATALOG_TIMEOUT_MS,
    retries: 1,
    passthrough4xx: true,
  });
  const cartClient = createHttpClient({
    name: 'cart',
    baseUrl: config.CART_URL,
    metrics,
    logger,
    timeoutMs: config.CART_TIMEOUT_MS,
    retries: 1,
    passthrough4xx: true,
  });
  const checkoutClient = createHttpClient({
    name: 'checkout',
    baseUrl: config.CHECKOUT_URL,
    metrics,
    logger,
    timeoutMs: config.CHECKOUT_TIMEOUT_MS,
    retries: 0,
    passthrough4xx: true,
  });

  const health = new HealthRegistry({ onEvent: (msg, meta) => logger.warn(meta ?? {}, msg) });
  // The storefront can render a degraded home page without the catalog, so its
  // dependency checks are informational rather than fatal.
  for (const [name, client] of [
    ['catalog-api', catalogClient],
    ['cart-api', cartClient],
    ['checkout-api', checkoutClient],
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
      { critical: false, timeoutMs: 2000 },
    );
  }

  const chaos = createChaosController({ enabled: config.ALLOW_CHAOS, metrics, logger });

  const service = await createService({
    config,
    metrics,
    logger,
    health,
    chaos,
    // Embeddable on purpose (the platform preview shows it in an iframe), but the
    // CSP still forbids inline script and cross-origin resources.
    security: { frameOptions: false },
    routes: (app) => registerRoutes({ app, metrics, config, catalogClient, cartClient, checkoutClient }),
  });

  service.installSignalHandlers();
  await service.start();
}

main().catch((err) => {
  console.error(`[storefront] fatal: ${err.message}`);
  process.exit(1);
});
