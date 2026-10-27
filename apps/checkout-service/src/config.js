import { z } from 'zod';
import { serviceSchema, urlSchema } from '@shopstack/telemetry';

export const configSchema = serviceSchema({
  DB_DRIVER: z.enum(['memory', 'postgres']).default('memory'),
  DATABASE_URL: urlSchema.optional(),
  CART_URL: z.string().url().default('http://localhost:8082'),
  CATALOG_URL: z.string().url().default('http://localhost:8081'),
  PAYMENTS_URL: z.string().url().default('http://localhost:8083'),
  STEP_TIMEOUT_MS: z.coerce.number().int().min(200).max(30000).default(4000),
});
