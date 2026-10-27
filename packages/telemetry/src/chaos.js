import { envNumber } from './env.js';

/**
 * Runtime fault injection.
 *
 * This exists to make progressive delivery *demonstrable*: enable 20% errors on a
 * canary (only the canary pods get the call), watch the AnalysisTemplate drop
 * below 99.5% and watch Argo Rollouts abort the release on its own. That is the
 * difference between "we have canary deployments" and "we proved the safety net
 * works".
 *
 * It is gated by `ALLOW_CHAOS`, which every overlay sets explicitly and production
 * sets to false. The routes are not even registered when it is off.
 */
export function createChaosController({ enabled = false, metrics, logger } = {}) {
  const state = {
    latencyMs: envNumber('CHAOS_LATENCY_MS', 0),
    errorRate: envNumber('CHAOS_ERROR_RATE', 0),
    status: envNumber('CHAOS_STATUS', 503),
  };

  const publish = () => {
    metrics?.chaosEnabled?.set({ mode: 'latency' }, state.latencyMs > 0 ? 1 : 0);
    metrics?.chaosEnabled?.set({ mode: 'error' }, state.errorRate > 0 ? 1 : 0);
    logger?.debug?.(state, 'chaos state changed');
  };
  publish();

  const controller = {
    enabled,
    get active() {
      return state.latencyMs > 0 || state.errorRate > 0;
    },
    snapshot: () => ({ ...state, enabled }),
    set(patch = {}) {
      if (patch.latencyMs !== undefined) {
        state.latencyMs = Math.max(0, Math.min(Number(patch.latencyMs) || 0, 30_000));
      }
      if (patch.errorRate !== undefined) {
        state.errorRate = Math.max(0, Math.min(Number(patch.errorRate) || 0, 1));
      }
      if (patch.status !== undefined) {
        state.status = [400, 429, 500, 502, 503].includes(Number(patch.status)) ? Number(patch.status) : 503;
      }
      publish();
      return controller.snapshot();
    },
    reset() {
      state.latencyMs = 0;
      state.errorRate = 0;
      state.status = 503;
      publish();
      return controller.snapshot();
    },

    /**
     * Fastify onRequest hook. Health and metrics endpoints are always excluded:
     * a chaos experiment must never make a pod look dead to kubelet, or the
     * experiment restarts the pod instead of failing requests.
     */
    async middleware(request) {
      if (!controller.active) return;
      if (request.url.startsWith('/internal/chaos') || request.url.startsWith('/healthz') ||
          request.url.startsWith('/readyz') || request.url.startsWith('/livez') ||
          request.url.startsWith('/startupz') || request.url.startsWith('/metrics')) {
        return;
      }
      if (state.latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.latencyMs));
      }
      if (state.errorRate > 0 && Math.random() < state.errorRate) {
        const { AppError } = await import('./errors.js');
        throw new AppError({
          title: 'Injected fault',
          status: state.status,
          code: 'chaos-injected',
          detail: 'Fault injection is enabled on this pod (ALLOW_CHAOS).',
        });
      }
    },

    registerRoutes(app) {
      app.get('/internal/chaos', async () => controller.snapshot());
      app.post('/internal/chaos', async (request) => controller.set(request.body ?? {}));
      app.delete('/internal/chaos', async () => controller.reset());
    },
  };

  return controller;
}
