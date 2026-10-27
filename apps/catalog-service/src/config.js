import { z } from 'zod';
import { serviceSchema, urlSchema } from '@shopstack/telemetry';

export const configSchema = serviceSchema({
  DB_DRIVER: z.enum(['memory', 'postgres']).default('memory'),
  DATABASE_URL: urlSchema.optional(),
  /** How long a catalogue read may be served from the in-process cache. */
  CACHE_TTL_MS: z.coerce.number().int().min(0).max(60_000).default(5000),
  /** How often inventory gauges are recomputed for Prometheus. */
  METRICS_REFRESH_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
  LOW_STOCK_THRESHOLD: z.coerce.number().int().min(1).max(1000).default(5),
});
