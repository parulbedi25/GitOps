import { z } from 'zod';
import { serviceSchema, urlSchema } from '@shopstack/telemetry';

export const configSchema = serviceSchema({
  PSP_DRIVER: z.enum(['simulated']).default('simulated'),
  PSP_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  /** HMAC key for PSP webhooks. Sourced from the cloud secret manager (ExternalSecret). */
  PSP_WEBHOOK_SECRET: z.string().min(16).max(200).optional(),
  DB_DRIVER: z.enum(['memory', 'postgres']).default('memory'),
  DATABASE_URL: urlSchema.optional(),
});
