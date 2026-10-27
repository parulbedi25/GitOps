/**
 * Configuration is read from the environment and validated once, at boot.
 *
 * The environment is the only configuration channel a pod has, and the GitOps
 * pipeline owns it (each overlay's `config:` block becomes a ConfigMap). Failing
 * fast at startup — instead of throwing 500s on the first request — is the whole
 * point: `kubectl logs` shows the bad variable, the pod never becomes Ready, and
 * Argo Rollouts stops the canary.
 */
import { z } from 'zod';

/** A URL that must be absolute, e.g. `http://cart-service:8080`. */
export const urlSchema = z.string().url();

/**
 * Boolean from an environment variable. Kubernetes ConfigMaps are strings, so
 * `COOKIE_SECURE=false` must not be truthy just because it is non-empty.
 */
export const zBoolean = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalised = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalised)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(normalised)) return false;
  return value; // let zod report a proper type error
}, z.boolean());

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

/** Keys every service shares. */
export const baseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Injected by the Helm chart from the release name; also the metric label. */
  SERVICE_NAME: z.string().min(1).default('shopstack-service'),
  SERVICE_VERSION: z.string().default('0.0.0-dev'),
  /** Commit SHA, baked into the image at build time. */
  SERVICE_COMMIT: z.string().default('unknown'),
  DEPLOYMENT_ENVIRONMENT: z.enum(['local', 'dev', 'qa', 'staging', 'prod']).default('local'),

  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  LOG_PRETTY: zBoolean.default(false),

  /** How long to keep serving in-flight requests after SIGTERM. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  /** Hard ceiling on a single request, so a stuck handler cannot pile up. */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),
  HTTP_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(10_000_000).default(262_144),

  /** Fault injection is only ever enabled in dev/QA (see the overlay values). */
  ALLOW_CHAOS: zBoolean.default(false),

  /** Read by the app only for log context; set by the Downward API. */
  POD_NAME: z.string().optional(),
  POD_NAMESPACE: z.string().optional(),
  NODE_NAME: z.string().optional(),
});

/** Builds the full schema for a service: base keys + service-specific ones. */
export function serviceSchema(extra = {}) {
  return baseConfigSchema.extend(extra);
}

/**
 * Parses `process.env` against a schema. Unknown variables are ignored — the
 * process environment is shared with the platform (Kubernetes injects dozens).
 */
export function loadConfig(schema = baseConfigSchema) {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const details = result.error.issues
      .map(
        (issue) =>
          `  ${issue.path.join('.')}: ${issue.message} (received ${JSON.stringify(process.env[issue.path[0]])})`,
      )
      .join('\n');
    throw new Error(`invalid configuration:\n${details}`);
  }
  const config = result.data;
  // Derived flags are computed here so no service re-implements them (and gets
  // `NODE_ENV=production` vs `DEPLOYMENT_ENVIRONMENT=prod` subtly wrong).
  config.isProduction = config.DEPLOYMENT_ENVIRONMENT === 'prod' || config.NODE_ENV === 'production';
  config.isTest = config.NODE_ENV === 'test';
  return config;
}
