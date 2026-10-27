import { AppError } from './errors.js';

/**
 * Service-to-service HTTP client.
 *
 * Rules encoded here, once, for every call in the platform:
 *   - every call has a deadline (`AbortSignal.timeout`): a hung dependency must
 *     not consume the caller's connection pool;
 *   - idempotent reads are retried, writes never are (a retried POST without an
 *     idempotency key is how you charge a customer twice);
 *   - a downstream problem+json is re-thrown as-is (`passthrough4xx`), so a 409
 *     "out of stock" stays a 409 with the same code at the edge;
 *   - every call feeds `dependency_up` and `dependency_request_duration_seconds`.
 */
export function createHttpClient({
  name,
  baseUrl,
  metrics,
  logger,
  timeoutMs = 2000,
  retries = 0,
  passthrough4xx = true,
  headers: defaultHeaders = {},
}) {
  const root = String(baseUrl || '').replace(/\/+$/, '');

  function record(outcome, seconds) {
    metrics?.dependency?.dependencyDuration?.observe({ dependency: name, outcome }, seconds);
    metrics?.dependency?.dependencyUp?.set({ dependency: name }, outcome === 'success' ? 1 : 0);
  }

  async function call(method, path, { body, query, headers = {}, timeout = timeoutMs, retry, idempotencyKey } = {}) {
    const attempts = (retry ?? (method === 'GET' ? retries : 0)) + 1;
    const url = new URL(path, root);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const started = process.hrtime.bigint();
      try {
        const response = await fetch(url, {
          method,
          headers: {
            accept: 'application/json',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
            ...defaultHeaders,
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });

        const text = await response.text();
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        const payload = text ? parseJson(text) : null;

        if (response.ok) {
          record('success', seconds);
          return payload;
        }

        const retryable = response.status >= 500 || response.status === 429;
        record(retryable ? 'failure' : 'client-error', seconds);

        const upstreamProblem = {
          title: payload?.title ?? `${name} request failed`,
          status: response.status,
          code: payload?.code ?? `upstream-${name}-${response.status}`,
          detail: payload?.detail ?? `${method} ${url.pathname} returned ${response.status}`,
          ...(payload && typeof payload === 'object' ? pickExtras(payload) : {}),
        };

        // A 4xx is the caller's fault and is meaningful to it (`out-of-stock`,
        // `payment-declined`), so it travels unchanged. When a service explicitly
        // opts out, it is translated into a 502 — used where the downstream
        // contract is an implementation detail the caller must not depend on.
        const error =
          response.status < 500 && !passthrough4xx
            ? new AppError({ title: `${name} rejected the request`, status: 502, code: `upstream-${name}-rejected`, detail: upstreamProblem.detail })
            : new AppError(upstreamProblem);
        error.upstreamStatus = response.status;
        lastError = error;

        if (retryable && attempt < attempts) {
          logger?.warn?.({ dependency: name, status: response.status, attempt }, 'retrying downstream call');
          await backoff(attempt);
          continue;
        }
        throw error;
      } catch (error) {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        if (error instanceof AppError) throw error;

        const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
        record(timedOut ? 'timeout' : 'error', seconds);
        lastError = new AppError({
          title: timedOut ? `${name} timed out` : `${name} is unreachable`,
          status: 504,
          code: timedOut ? `upstream-${name}-timeout` : `upstream-${name}-unreachable`,
          detail: error.message,
        });
        if (attempt < attempts) {
          logger?.warn?.({ dependency: name, attempt, err: error.message }, 'retrying downstream call');
          await backoff(attempt);
          continue;
        }
        throw lastError;
      }
    }
    throw lastError;
  }

  return {
    name,
    baseUrl: root,
    get: (path, options = {}) => call('GET', path, options),
    // Writes take the body as the second positional argument, which is how the
    // services read: `client.post('/api/payments', payload, { idempotencyKey })`.
    post: (path, body, options = {}) => call('POST', path, { ...options, body }),
    patch: (path, body, options = {}) => call('PATCH', path, { ...options, body }),
    put: (path, body, options = {}) => call('PUT', path, { ...options, body }),
    delete: (path, options = {}) => call('DELETE', path, options),
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text.slice(0, 200) };
  }
}

/** Keeps problem members such as `reason` and `paymentId` on the way through. */
const RESERVED_PROBLEM_MEMBERS = new Set(['type', 'title', 'status', 'code', 'detail', 'traceId']);
function pickExtras(payload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => !RESERVED_PROBLEM_MEMBERS.has(key)),
  );
}

function backoff(attempt) {
  const base = 50 * 2 ** (attempt - 1);
  return new Promise((resolve) => setTimeout(resolve, base + Math.random() * base * 0.2));
}
