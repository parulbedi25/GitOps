/**
 * Probe registry.
 *
 * Kubernetes asks three different questions and conflating them causes outages:
 *
 *   /startupz  finished initialising?          (startupProbe  — no traffic yet)
 *   /readyz    should this pod receive traffic? (readinessProbe — dependency break)
 *   /healthz   is the process wedged?           (livenessProbe  — restart it)
 *
 * Only *critical* checks fail readiness with a 503. A degraded dependency (the
 * catalog is slow, the PSP is down) is reported but does not remove every pod from
 * the Service — that turns a partial outage into a total one.
 */
export class HealthRegistry {
  /**
   * @param {{onEvent?: (message: string, meta?: object) => void}} [options]
   */
  constructor({ onEvent } = {}) {
    this.checks = new Map();
    this.ready = false;
    this.shuttingDown = false;
    this.startedAt = Date.now();
    this.onEvent = onEvent;
  }

  /**
   * @param {string} name
   * @param {() => Promise<{ok: boolean, detail?: string}>|{ok: boolean, detail?: string}} fn
   * @param {{critical?: boolean, timeoutMs?: number}} [options]
   */
  register(name, fn, { critical = false, timeoutMs = 2000 } = {}) {
    this.checks.set(name, { name, fn, critical, timeoutMs });
    return this;
  }

  markReady() {
    this.ready = true;
    this.onEvent?.('service ready');
  }

  markShuttingDown() {
    this.shuttingDown = true;
    this.onEvent?.('service draining');
  }

  /** Runs one check with a timeout; never throws. */
  async #run(check) {
    const started = Date.now();
    try {
      const result = await Promise.race([
        check.fn(),
        // Deliberately not unref'd: the timeout is what keeps the event loop
        // alive long enough to fail the probe instead of hanging silently.
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`timed out after ${check.timeoutMs}ms`)), check.timeoutMs),
        ),
      ]);
      const ok = result === true || result?.ok === true;
      if (!ok) this.onEvent?.(`health check failed: ${check.name}`, { detail: result?.detail });
      return {
        name: check.name,
        ok,
        critical: check.critical,
        detail: result?.detail ?? (ok ? 'ok' : 'failed'),
        durationMs: Date.now() - started,
      };
    } catch (error) {
      this.onEvent?.(`health check errored: ${check.name}`, { err: error.message });
      return {
        name: check.name,
        ok: false,
        critical: check.critical,
        detail: error.message,
        durationMs: Date.now() - started,
      };
    }
  }

  /**
   * @returns {Promise<{status: 'ok'|'degraded'|'fail', checks: object[]}>}
   *   `fail` is reserved for a critical check failing or a draining pod.
   */
  async check() {
    if (this.shuttingDown) {
      return { status: 'fail', checks: [{ name: 'lifecycle', ok: false, critical: true, detail: 'shutting down' }] };
    }
    const checks = await Promise.all([...this.checks.values()].map((check) => this.#run(check)));
    const criticalFailure = checks.some((check) => !check.ok && check.critical);
    const anyFailure = checks.some((check) => !check.ok);
    return { status: criticalFailure ? 'fail' : anyFailure ? 'degraded' : 'ok', checks };
  }
}

/** Responses 200 when ready, 503 when a critical dependency or startup fails. */
export async function probeHandler(health, { startup = false } = {}) {
  const result = await health.check();
  const ready = startup ? health.ready && result.status !== 'fail' : result.status !== 'fail';
  return { statusCode: ready ? 200 : 503, body: { status: ready ? result.status : 'fail', ...result, ready: health.ready } };
}
