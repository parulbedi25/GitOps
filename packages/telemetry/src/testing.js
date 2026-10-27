/**
 * Test utilities shared by every service's suite.
 *
 * Exported as `@shopstack/telemetry/testing` so tests get a silent logger and a
 * fully-populated config object without duplicating 15 fields per service.
 */
import { pino } from 'pino';
import { createMetrics } from './metrics.js';

export function silentLogger() {
  return pino({ level: 'silent' });
}

/** Complete, valid config for a service under test. */
export function testConfig(overrides = {}) {
  return {
    NODE_ENV: 'test',
    SERVICE_NAME: 'test-service',
    SERVICE_VERSION: '0.0.0-test',
    SERVICE_COMMIT: 'test',
    DEPLOYMENT_ENVIRONMENT: 'local',
    PORT: 0,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    LOG_PRETTY: false,
    SHUTDOWN_TIMEOUT_MS: 2000,
    REQUEST_TIMEOUT_MS: 5000,
    ALLOW_CHAOS: false,
    isProduction: false,
    ...overrides,
  };
}

/** Metrics bundle for a service under test. */
export function testMetrics(service = 'test-service') {
  return createMetrics({ service, version: '0.0.0-test', environment: 'local', commit: 'test' });
}

/** Asserts a response is an RFC 9457 problem document. */
export function expectProblem(body, status) {
  if (body.status !== status || typeof body.code !== 'string' || typeof body.traceId !== 'string') {
    throw new Error(`expected problem+json with status ${status}, got ${JSON.stringify(body)}`);
  }
  return body;
}
