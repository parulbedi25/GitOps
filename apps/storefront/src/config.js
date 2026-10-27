import { z } from 'zod';
import { serviceSchema, zBoolean } from '@shopstack/telemetry';

export const configSchema = serviceSchema({
  CATALOG_URL: z.string().url().default('http://localhost:8081'),
  CART_URL: z.string().url().default('http://localhost:8082'),
  CHECKOUT_URL: z.string().url().default('http://localhost:8084'),
  CATALOG_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(2500),
  CART_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(2500),
  CHECKOUT_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(10000),
  /** Set to true when the site is served over TLS (always true outside local dev). */
  COOKIE_SECURE: zBoolean.default(true),
});
