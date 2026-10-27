/**
 * One error model for every service: RFC 9457 "problem details".
 *
 *   { type, title, status, code, detail, traceId, ...extra }
 *
 * `code` is the stable, machine-readable identifier (`payment-declined`,
 * `cart-locked`). Clients branch on the code; humans read the title. `traceId` is
 * the Fastify request id and appears on every log line for that request, so a
 * customer quoting the id is enough to reconstruct the incident.
 */

const ERROR_BASE_URL = 'https://errors.shopstack.dev';

export class AppError extends Error {
  /**
   * @param {object} problem
   * @param {string} [problem.title] short human title
   * @param {number} [problem.status] HTTP status
   * @param {string} [problem.code] stable machine-readable code
   * @param {string|object[]} [problem.detail] one-line explanation, or a list of
   *   field errors (an `errors` array is emitted alongside the message)
   * @param {Record<string, unknown>} [problem.extra] extra problem members
   */
  constructor({ title = 'Internal server error', status = 500, code = 'internal-error', detail, ...extra } = {}) {
    const isList = Array.isArray(detail);
    super(isList ? title : (detail ?? title));
    this.name = 'AppError';
    this.title = title;
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.extra = extra;
    // 5xx details describe internals and must never reach a client.
    this.expose = status < 500;
  }

  toProblem(traceId) {
    const isList = Array.isArray(this.detail);
    return {
      type: `${ERROR_BASE_URL}/${this.code}`,
      title: this.title,
      status: this.status,
      code: this.code,
      detail: isList ? this.title : this.expose ? this.detail : undefined,
      ...(isList ? { errors: this.detail } : {}),
      ...this.extra,
      traceId,
    };
  }
}

const kebab = (value) =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export const badRequest = (detail, code = 'bad-request') =>
  new AppError({ title: 'Bad request', status: 400, code, detail });

export const unauthorized = (detail, code = 'unauthorized') =>
  new AppError({ title: 'Unauthorized', status: 401, code, detail });

export const forbidden = (detail, code = 'forbidden') =>
  new AppError({ title: 'Forbidden', status: 403, code, detail });

/** `notFound('Cart', id)` -> 404 `cart-not-found`. */
export const notFound = (what, identifier) =>
  new AppError({
    title: `${what} not found`,
    status: 404,
    code: `${kebab(what)}-not-found`,
    detail: identifier ? `${what} ${identifier} does not exist.` : `${what} does not exist.`,
  });

export const conflict = (title, detail, code = 'conflict') =>
  new AppError({ title, status: 409, code, detail });

export const unprocessable = (title, detail, code = 'unprocessable-entity') =>
  new AppError({ title, status: 422, code, detail });

export const tooManyRequests = (detail, code = 'rate-limited') =>
  new AppError({ title: 'Too many requests', status: 429, code, detail });

export const serviceUnavailable = (detail, code = 'service-unavailable') =>
  new AppError({ title: 'Service unavailable', status: 503, code, detail });
