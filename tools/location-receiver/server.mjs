/**
 * TrailPin receiver — a dependency-free HTTP endpoint for the Android tracker.
 *
 * It exists so you can prove the app works before pointing it at your real
 * website. It accepts exactly the request the phone sends:
 *
 *   GET  /api/location?token=…&lat=31.32&lon=75.57&tid=tp-1a2b3c4d&tst=…
 *   POST /api/location            (form encoded or JSON body, token in query)
 *
 * plus a small dashboard at "/" and a read-only feed at "/api/points".
 *
 *   PORT=8080 TRACKER_TOKEN=secret node tools/location-receiver/server.mjs
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dashboardHtml } from './dashboard.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const TOKEN_KEYS = ['token', 'api_token', 'apikey', 'key'];

/**
 * Builds a receiver without starting it, which is what the tests use.
 *
 * @param {object} [options]
 * @param {string} [options.token] shared secret the phone must send
 * @param {number} [options.maxPoints] how many points to keep in memory
 * @param {string|null} [options.storagePath] optional JSON file to persist to
 */
export function createReceiver(options = {}) {
  const token = options.token ?? process.env.TRACKER_TOKEN ?? 'changeme';
  const maxPoints = options.maxPoints ?? Number(process.env.TRACKER_MAX_POINTS ?? 5000);
  const storagePath = options.storagePath ?? process.env.TRACKER_STORE ?? null;
  const points = [];

  let pendingWrite = Promise.resolve();

  function persist() {
    if (!storagePath) return;
    const snapshot = JSON.stringify(points, null, 2);
    pendingWrite = pendingWrite
      .then(() => writeFile(storagePath, snapshot, 'utf8'))
      .catch((error) => console.error('[receiver] could not persist points:', error.message));
  }

  async function load() {
    if (!storagePath) return;
    try {
      const raw = await readFile(storagePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        points.push(...parsed.slice(-maxPoints));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('[receiver] could not read the store:', error.message);
      }
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      json(res, 500, { ok: false, error: error.message });
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost'));
    const route = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && route === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(dashboardHtml());
      return;
    }

    if (route === '/healthz') {
      json(res, 200, { ok: true, points: points.length });
      return;
    }

    if (route === '/api/location') {
      if (req.method !== 'GET' && req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'use GET or POST' });
        return;
      }

      const body = req.method === 'POST' ? await readBody(req) : '';
      const params = parseParams(url, body, req.headers['content-type']);

      if (suppliedToken(params, req) !== token) {
        json(res, 401, { ok: false, error: 'invalid token' });
        return;
      }

      const result = buildPoint(params);
      if (result.error) {
        json(res, 400, { ok: false, error: result.error });
        return;
      }

      points.push(result.point);
      if (points.length > maxPoints) {
        points.splice(0, points.length - maxPoints);
      }
      persist();
      console.log(
        '[receiver] ' +
          result.point.tid +
          ' → ' +
          result.point.lat +
          ',' +
          result.point.lon +
          ' (±' +
          (result.point.acc ?? '?') +
          ' m)',
      );
      json(res, 200, { ok: true, point: result.point });
      return;
    }

    if (route === '/api/points') {
      if (suppliedToken(url.searchParams, req) !== token) {
        json(res, 401, { ok: false, error: 'invalid token' });
        return;
      }
      json(res, 200, { ok: true, count: points.length, points });
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
  }

  return {
    server,
    points,
    load,
    /** Flushes any pending write, then stops listening. */
    async close() {
      await pendingWrite;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('request body is larger than ' + MAX_BODY_BYTES + ' bytes');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseParams(url, body, contentType) {
  const params = new URLSearchParams(url.searchParams);
  if (!body) return params;

  if ((contentType ?? '').includes('application/json')) {
    try {
      const parsed = JSON.parse(body);
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== null && value !== undefined && typeof value !== 'object') {
          params.set(key, String(value));
        }
      }
    } catch {
      // A body that is not JSON is simply ignored; validation reports the rest.
    }
    return params;
  }

  for (const [key, value] of new URLSearchParams(body)) {
    params.set(key, value);
  }
  return params;
}

function suppliedToken(params, req) {
  for (const key of TOKEN_KEYS) {
    const value = params.get(key);
    if (value) return value;
  }
  const header = req.headers['x-tracker-token'];
  return typeof header === 'string' ? header : null;
}

function firstValue(params, keys) {
  for (const key of keys) {
    const value = params.get(key);
    if (value !== null && value !== '') return value;
  }
  return null;
}

function numberParam(params, keys) {
  const raw = firstValue(params, keys);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Validates one report and returns `{ point }` or `{ error }`. */
export function buildPoint(params) {
  const lat = numberParam(params, ['lat', 'latitude']);
  const lon = numberParam(params, ['lon', 'lng', 'long', 'longitude']);

  if (lat === null || lon === null) {
    return { error: 'lat and lon are required numeric parameters' };
  }
  if (lat < -90 || lat > 90) {
    return { error: 'lat must be between -90 and 90' };
  }
  if (lon < -180 || lon > 180) {
    return { error: 'lon must be between -180 and 180' };
  }

  const seconds = numberParam(params, ['tst', 'timestamp', 'time']);
  const receivedAt = Date.now();

  return {
    point: {
      id: firstValue(params, ['id']) ?? randomUUID(),
      tid: firstValue(params, ['tid', 'device', 'device_id']) ?? 'unknown',
      lat,
      lon,
      acc: numberParam(params, ['acc', 'accuracy']),
      alt: numberParam(params, ['alt', 'altitude']),
      vel: numberParam(params, ['vel', 'speed']),
      bear: numberParam(params, ['bear', 'bearing', 'heading']),
      batt: numberParam(params, ['batt', 'battery']),
      prov: firstValue(params, ['prov', 'provider']),
      tst: seconds === null ? receivedAt : Math.round(seconds * 1000),
      receivedAt,
    },
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  const receiver = createReceiver();
  await receiver.load();

  receiver.server.listen(port, '0.0.0.0', () => {
    const token = process.env.TRACKER_TOKEN ?? 'changeme';
    console.log('TrailPin receiver listening on port ' + port);
    console.log('  dashboard : http://localhost:' + port + '/');
    console.log('  endpoint  : http://localhost:' + port + '/api/location');
    console.log('  token     : ' + token);
    console.log(
      '  try it    : curl "http://localhost:' +
        port +
        '/api/location?token=' +
        encodeURIComponent(token) +
        '&lat=31.326&lon=75.576&tid=curl"',
    );
  });
}
