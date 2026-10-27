/**
 * Payments service entrypoint.
 */
import { loadConfig, createLogger, createMetrics, HealthRegistry, createService, createChaosController } from '@shopstack/telemetry';
import { configSchema } from './config.js';
import { createPaymentRepository } from './repository.js';
import { SimulatedProcessor } from './payments.js';
import { registerRoutes } from './routes.js';
import { rawBodyPlugin } from './raw-body.js';

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
  if (!config.PSP_WEBHOOK_SECRET) {
    logger.warn('PSP_WEBHOOK_SECRET is not set: the /webhooks/psp endpoint will return 503');
  }

  const metrics = createMetrics({
    service: config.SERVICE_NAME,
    version: config.SERVICE_VERSION,
    environment: config.DEPLOYMENT_ENVIRONMENT,
    commit: config.SERVICE_COMMIT,
  });

  const repository = await createPaymentRepository({
    driver: config.DB_DRIVER,
    connectionString: config.DATABASE_URL,
    logger,
  });

  const processor = new SimulatedProcessor({ failureRate: config.PSP_FAILURE_RATE, logger });

  const health = new HealthRegistry({ onEvent: (msg, meta) => logger.warn(meta ?? {}, msg) });
  health.register('payment-store', () => repository.healthCheck(), { critical: true });
  health.register('psp-credentials', async () => ({
    ok: Boolean(config.PSP_WEBHOOK_SECRET),
    detail: config.PSP_WEBHOOK_SECRET ? 'webhook secret present' : 'webhook secret missing',
  }), { critical: false });

  const chaos = createChaosController({ enabled: config.ALLOW_CHAOS, metrics, logger });

  const service = await createService({
    config,
    metrics,
    logger,
    health,
    chaos,
    plugins: [rawBodyPlugin],
    routes: (app) => registerRoutes({ app, repository, metrics, config, processor }),
  });

  service.onShutdown(() => repository.close());
  service.installSignalHandlers();
  await service.start();
}

main().catch((err) => {
  console.error(`[payments-service] fatal: ${err.message}`);
  process.exit(1);
});
