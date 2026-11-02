import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReceiver, buildPoint } from '../server.mjs';

const TOKEN = 'test-token';

async function start(options = {}) {
  const receiver = createReceiver({ token: TOKEN, ...options });
  await new Promise((resolve) => receiver.server.listen(0, '127.0.0.1', resolve));
  const address = receiver.server.address();
  return {
    receiver,
    base: 'http://127.0.0.1:' + address.port,
    stop: () => receiver.close(),
  };
}

function report(base, query) {
  return fetch(base + '/api/location?' + query);
}

test('GET report is accepted and stored', async (t) => {
  const app = await start();
  t.after(() => app.stop());

  const response = await report(
    app.base,
    'token=' + TOKEN + '&lat=31.326&lon=75.576&tid=tp-abc&tst=1762040000&acc=8&batt=87&prov=gps',
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.point.lat, 31.326);
  assert.equal(body.point.lon, 75.576);
  assert.equal(body.point.tid, 'tp-abc');
  assert.equal(body.point.tst, 1_762_040_000_000);
  assert.equal(body.point.acc, 8);
  assert.equal(body.point.batt, 87);
  assert.equal(app.receiver.points.length, 1);
});

test('POST form encoded report is accepted', async (t) => {
  const app = await start();
  t.after(() => app.stop());

  const response = await fetch(app.base + '/api/location?token=' + TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'lat=12.5&lon=-7.25&tid=form',
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.point.lat, 12.5);
  assert.equal(body.point.lon, -7.25);
  assert.equal(body.point.prov, null);
});

test('POST JSON report is accepted', async (t) => {
  const app = await start();
  t.after(() => app.stop());

  const response = await fetch(app.base + '/api/location?token=' + TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lat: -33.8688, lon: 151.2093, tid: 'json', acc: 5.5, batt: 42 }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.point.lat, -33.8688);
  assert.equal(body.point.batt, 42);
  assert.equal(app.receiver.points.length, 1);
});

test('latitude/longitude aliases and the token header also work', async (t) => {
  const app = await start();
  t.after(() => app.stop());

  const response = await fetch(app.base + '/api/location?latitude=1.5&longitude=2.5', {
    headers: { 'x-tracker-token': TOKEN },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.point.lat, 1.5);
  assert.equal(body.point.lon, 2.5);
});

test('a wrong or missing token is rejected', async (t) => {
  const app = await start();
  t.after(() => app.stop());

  const wrong = await report(app.base, 'token=nope&lat=1&lon=2');
  assert.equal(wrong.status, 401);

  const missing = await report(app.base, 'lat=1&lon=2');
  assert.equal(missing.status, 401);
  assert.equal(app.receiver.points.length, 0);
});

test('coordinates are validated', async (t) => {
  const app = await start();
  t.after(() => app.stop());

  const missing = await report(app.base, 'token=' + TOKEN);
  assert.equal(missing.status, 400);

  const outOfRange = await report(app.base, 'token=' + TOKEN + '&lat=99&lon=2');
  assert.equal(outOfRange.status, 400);

  const notANumber = await report(app.base, 'token=' + TOKEN + '&lat=abc&lon=2');
  assert.equal(notANumber.status, 400);

  assert.equal(app.receiver.points.length, 0);
});

test('the point feed is token protected', async (t) => {
  const app = await start();
  t.after(() => app.stop());

  await report(app.base, 'token=' + TOKEN + '&lat=1&lon=2');

  const denied = await fetch(app.base + '/api/points');
  assert.equal(denied.status, 401);

  const allowed = await fetch(app.base + '/api/points?token=' + TOKEN);
  const body = await allowed.json();
  assert.equal(allowed.status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.points[0].lat, 1);
});

test('the dashboard and health check respond', async (t) => {
  const app = await start();
  t.after(() => app.stop());

  const dashboard = await fetch(app.base + '/');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await dashboard.text(), /TrailPin receiver/);

  const health = await fetch(app.base + '/healthz');
  assert.deepEqual(await health.json(), { ok: true, points: 0 });

  const missing = await fetch(app.base + '/nope');
  assert.equal(missing.status, 404);
});

test('points survive a restart when a store file is configured', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trailpin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storagePath = join(directory, 'points.json');

  const first = await start({ storagePath });
  await report(first.base, 'token=' + TOKEN + '&lat=9.5&lon=8.5&tid=durable');
  await first.stop();

  const second = await start({ storagePath });
  t.after(() => second.stop());
  await second.receiver.load();

  assert.equal(second.receiver.points.length, 1);
  assert.equal(second.receiver.points[0].tid, 'durable');
});

test('buildPoint rejects half a coordinate pair', () => {
  assert.ok(buildPoint(new URLSearchParams('lat=1')).error);
  assert.ok(buildPoint(new URLSearchParams('lon=1')).error);
  assert.equal(buildPoint(new URLSearchParams('lat=1&lon=2')).point.lat, 1);
});
