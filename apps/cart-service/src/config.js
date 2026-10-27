import { z } from 'zod';
import { serviceSchema, urlSchema } from '@shopstack/telemetry';

export const configSchema = serviceSchema({
  CART_DRIVER: z.enum(['memory', 'redis']).default('memory'),
  REDIS_URL: urlSchema.optional(),
  CART_TTL_SECONDS: z.coerce.number().int().min(60).max(2592000).default(604800),
  CATALOG_URL: z.string().url().default('http://localhost:8081'),
  TAX_RATE_BPS: z.coerce.number().int().min(0).max(5000).default(825),
  SHIPPING_FEE_CENTS: z.coerce.number().int().min(0).max(100000).default(599),
  FREE_SHIPPING_THRESHOLD_CENTS: z.coerce.number().int().min(0).max(1000000).default(7500),
  CATALOG_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(2000),
});
