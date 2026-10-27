import pino from 'pino';

/**
 * Structured JSON logs, one line per event, always carrying the service identity.
 *
 * Logs are shipped to Loki by the platform, so the format is an interface:
 * changing it breaks dashboards and alerts. Pretty printing exists for local
 * development only (`LOG_PRETTY=true`) and every environment overlay sets it to
 * `false`.
 */
export function createLogger({ service, version, environment, level = 'info', pretty = false, ...extra }) {
  const options = {
    level,
    base: { service, version, environment, ...extra },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Never let a credential reach a log aggregator. Defence in depth: the
    // services also avoid logging these fields at all.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-psp-signature"]',
        'req.headers["idempotency-key"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.secret',
        '*.token',
        '*.pan',
        '*.cvv',
      ],
      censor: '[redacted]',
    },
  };

  if (pretty) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service,version,environment' },
      },
    });
  }
  return pino(options);
}
