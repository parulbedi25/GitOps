/**
 * Captures the exact request bytes before JSON parsing.
 *
 * Webhook signatures are computed over the raw payload; re-serialising the parsed
 * object changes key order and whitespace and would silently break verification.
 * This parser is registered only in the payments service, which accepts JSON and
 * nothing else.
 */
export async function rawBodyPlugin(app) {
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 262144 }, (request, body, done) => {
    request.rawBody = body;
    if (!body || body.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch (err) {
      err.statusCode = 400;
      err.code = 'invalid-json';
      done(err);
    }
  });
}
