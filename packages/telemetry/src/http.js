import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

/** Conservative headers applied to every response. */
const SAFE_DEFAULTS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=()',
};

/** The storefront adds image/form directives; APIs never serve HTML. */
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function requestId(request) {
  const header = request.headers['x-request-id'];
  return typeof header === 'string' && header.length > 0 && header.length <= 128 ? header : randomUUID();
}

/**
 * Transport-level concerns: request identity, security headers, the problem+json
 * error contract and a uniform 404.
 */
export function installHttpLayer(app, { config, metrics }) {
  app.addHook('onRequest', async (request, reply) => {
    // Fastify's `request.id` is the trace id: it is echoed to the client, logged
    // with every line and stamped into every problem document.
    reply.header('x-request-id', request.id);
    for (const [key, value] of Object.entries(SAFE_DEFAULTS)) reply.header(key, value);
    if (!request.url.startsWith('/metrics')) {
      reply.header('content-security-policy', API_CSP);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.errorCode = error.code;
      const log = error.status >= 500 ? request.log.error : request.log.warn;
      log.call(request.log, { err: error, code: error.code, status: error.status }, error.title);
      return reply.code(error.status).type('application/problem+json').send(error.toProblem(request.id));
    }

    // Schema validation failures arrive from Ajv with `validation` attached.
    if (error.validation) {
      const code = 'validation-failed';
      reply.errorCode = code;
      return reply
        .code(400)
        .type('application/problem+json')
        .send({
          type: `https://errors.shopstack.dev/${code}`,
          title: 'Request validation failed',
          status: 400,
          code,
          detail: error.message,
          errors: error.validation.map((issue) => ({
            path: issue.instancePath || issue.params?.missingProperty || '/',
            message: issue.message,
          })),
          traceId: request.id,
        });
    }

    if (error.statusCode && error.statusCode < 500) {
      const code = error.code ?? 'bad-request';
      reply.errorCode = code;
      return reply
        .code(error.statusCode)
        .type('application/problem+json')
        .send({
          type: `https://errors.shopstack.dev/${code}`,
          title: error.name || 'Bad request',
          status: error.statusCode,
          code,
          detail: error.message,
          traceId: request.id,
        });
    }

    // Anything else is a bug. Log it in full, tell the client nothing.
    request.log.error({ err: error }, 'unhandled error');
    reply.errorCode = 'internal-error';
    return reply.code(500).type('application/problem+json').send({
      type: 'https://errors.shopstack.dev/internal-error',
      title: 'Internal server error',
      status: 500,
      code: 'internal-error',
      detail: 'The request could not be completed.',
      traceId: request.id,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.errorCode = 'route-not-found';
    return reply
      .code(404)
      .type('application/problem+json')
      .send({
        type: 'https://errors.shopstack.dev/route-not-found',
        title: 'Not found',
        status: 404,
        code: 'route-not-found',
        detail: `No route for ${request.method} ${request.url.split('?')[0]}`,
        traceId: request.id,
      });
  });

  // One structured line per request. The route template, not the raw URL, keeps
  // log cardinality bounded exactly like the metric labels.
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions?.url || 'unmatched',
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        ...(reply.errorCode ? { errorCode: reply.errorCode } : {}),
      },
      'request completed',
    );
  });

  void config;
  void metrics;
}
