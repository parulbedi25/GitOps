import client from 'prom-client';

/**
 * The metric contract.
 *
 * Metric and label names are a public interface — PrometheusRules, Grafana
 * dashboards, `kubectl` one-liners and the Argo Rollouts AnalysisTemplate all
 * depend on them. Renaming one is a breaking change and gets the same review as
 * an API change.
 *
 * Naming: `shopstack_<subsystem>_<name>_<unit>`. Every series carries `service`
 * (a default label); `namespace` comes from Prometheus' target labels, so the
 * same image reports correctly in dev, QA and production without knowing where it
 * runs.
 */
const PREFIX = 'shopstack_';

export function createMetrics({ service, version, environment, commit = 'unknown' }) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service });

  // Node process metrics (heap, GC, event loop lag, CPU) — the saturation half of
  // the RED/USE method.
  client.collectDefaultMetrics({ register: registry, prefix: PREFIX });

  const httpRequests = new client.Counter({
    name: `${PREFIX}http_requests_total`,
    help: 'HTTP requests handled, by route and status class.',
    labelNames: ['method', 'route', 'status', 'status_class'],
    registers: [registry],
  });

  const httpDuration = new client.Histogram({
    name: `${PREFIX}http_request_duration_seconds`,
    help: 'HTTP request duration in seconds.',
    labelNames: ['method', 'route', 'status_class'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2, 5],
    registers: [registry],
  });

  const httpErrors = new client.Counter({
    name: `${PREFIX}http_request_errors_total`,
    help: 'Requests that ended in an error, by stable error code.',
    labelNames: ['method', 'route', 'code'],
    registers: [registry],
  });

  const inFlight = new client.Gauge({
    name: `${PREFIX}http_requests_in_flight`,
    help: 'Requests currently being processed.',
    registers: [registry],
  });

  const buildInfo = new client.Gauge({
    name: `${PREFIX}build_info`,
    help: 'Always 1; the labels identify the running build.',
    labelNames: ['version', 'commit', 'node_version', 'environment'],
    registers: [registry],
  });
  buildInfo.set(
    { version, commit, node_version: process.versions.node, environment },
    1,
  );

  const dependencyUp = new client.Gauge({
    name: `${PREFIX}dependency_up`,
    help: '1 when the last call to a downstream dependency succeeded.',
    labelNames: ['dependency'],
    registers: [registry],
  });

  const dependencyDuration = new client.Histogram({
    name: `${PREFIX}dependency_request_duration_seconds`,
    help: 'Latency of calls to downstream services.',
    labelNames: ['dependency', 'outcome'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const chaosEnabled = new client.Gauge({
    name: `${PREFIX}chaos_enabled`,
    help: '1 when a fault-injection mode is active on this pod.',
    labelNames: ['mode'],
    registers: [registry],
  });

  return {
    registry,
    client,
    http: { httpRequests, httpDuration, httpErrors, inFlight },
    dependency: { dependencyUp, dependencyDuration },
    buildInfo,
    chaosEnabled,

    /** Declare a domain metric. Names are always prefixed with `shopstack_`. */
    counter(name, help, labelNames = []) {
      return new client.Counter({ name: withPrefix(name), help, labelNames, registers: [registry] });
    },
    gauge(name, help, labelNames = []) {
      return new client.Gauge({ name: withPrefix(name), help, labelNames, registers: [registry] });
    },
    histogram(name, help, labelNames = [], buckets) {
      return new client.Histogram({
        name: withPrefix(name),
        help,
        labelNames,
        ...(buckets ? { buckets } : {}),
        registers: [registry],
      });
    },

    async render() {
      return registry.metrics();
    },
    get contentType() {
      return registry.contentType;
    },
  };
}

/** Accepts both `orders_total` and `shopstack_orders_total`. */
function withPrefix(name) {
  return name.startsWith(PREFIX) ? name : `${PREFIX}${name}`;
}

/**
 * RED signals for every route.
 *
 * The `route` label uses the route *template* (`/api/products/:id`), never the raw
 * URL: labelling by URL turns every product id into its own time series and is the
 * single most common way to melt a Prometheus instance.
 */
export function installHttpMetrics(app, metrics) {
  app.addHook('onRequest', async (request) => {
    request.metricStartedAt = process.hrtime.bigint();
    metrics.http.inFlight.inc();
  });

  app.addHook('onResponse', async (request, reply) => {
    if (!request.metricStartedAt) return;
    metrics.http.inFlight.dec();

    const route = request.routeOptions?.url || request.routerPath || 'unmatched';
    const status = String(reply.statusCode);
    const statusClass = `${status[0]}xx`;
    const seconds = Number(process.hrtime.bigint() - request.metricStartedAt) / 1e9;

    metrics.http.httpRequests.inc({ method: request.method, route, status, status_class: statusClass });
    metrics.http.httpDuration.observe({ method: request.method, route, status_class: statusClass }, seconds);

    if (reply.errorCode) {
      metrics.http.httpErrors.inc({ method: request.method, route, code: reply.errorCode });
    }
  });
}
