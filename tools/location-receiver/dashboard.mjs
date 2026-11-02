/**
 * The one page the receiver serves: a map and a table of the last reports.
 *
 * Leaflet is loaded from a CDN, so the page degrades to a plain table when the
 * browser is offline — the table is the source of truth either way.
 */
export function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TrailPin receiver</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 16px; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 12px; }
  h1 { font-size: 18px; margin: 0 12px 0 0; }
  input, button { font: inherit; padding: 6px 10px; border-radius: 8px; border: 1px solid #8888; }
  input { min-width: 220px; }
  button { cursor: pointer; }
  #status { color: #666; }
  #map { height: 320px; border-radius: 12px; margin-bottom: 16px; background: #0000000a; }
  #map:empty { display: none; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #8883; white-space: nowrap; }
  th { font-weight: 600; opacity: .75; }
  td.num { font-variant-numeric: tabular-nums; }
  a { color: inherit; }
  .empty { padding: 24px; text-align: center; opacity: .6; }
</style>
</head>
<body>
<header>
  <h1>TrailPin receiver</h1>
  <input id="token" type="password" placeholder="API token" autocomplete="off">
  <button id="refresh" type="button">Refresh</button>
  <span id="status">—</span>
</header>

<div id="map"></div>

<table id="points">
  <thead>
    <tr>
      <th>Time</th>
      <th>Device</th>
      <th>Latitude</th>
      <th>Longitude</th>
      <th>Accuracy</th>
      <th>Battery</th>
      <th>Map</th>
    </tr>
  </thead>
  <tbody></tbody>
</table>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  var tokenInput = document.getElementById('token');
  var statusEl = document.getElementById('status');
  var tableBody = document.querySelector('#points tbody');
  var mapEl = document.getElementById('map');
  var map = null;
  var markers = null;

  var saved = localStorage.getItem('trailpin-token');
  if (saved) tokenInput.value = saved;

  tokenInput.addEventListener('change', function () {
    localStorage.setItem('trailpin-token', tokenInput.value.trim());
    refresh();
  });

  document.getElementById('refresh').addEventListener('click', refresh);

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function num(value, digits) {
    if (value === null || value === undefined || value === '') return '—';
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toFixed(digits) : '—';
  }

  function when(point) {
    var ms = point.tst || point.receivedAt || Date.now();
    return new Date(ms).toLocaleTimeString();
  }

  function cell(text, className) {
    var td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  function row(point) {
    var tr = document.createElement('tr');
    tr.appendChild(cell(when(point)));
    tr.appendChild(cell(point.tid || '—'));
    tr.appendChild(cell(num(point.lat, 6), 'num'));
    tr.appendChild(cell(num(point.lon, 6), 'num'));
    tr.appendChild(cell(point.acc === null || point.acc === undefined ? '—' : num(point.acc, 1) + ' m', 'num'));
    tr.appendChild(cell(point.batt === null || point.batt === undefined ? '—' : point.batt + ' %', 'num'));
    var link = document.createElement('a');
    link.href = 'https://www.openstreetmap.org/?mlat=' + point.lat + '&mlon=' + point.lon;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'open';
    var td = document.createElement('td');
    td.appendChild(link);
    tr.appendChild(td);
    return tr;
  }

  function drawMap(points) {
    if (!window.L || !mapEl) return;
    if (!map) {
      map = window.L.map('map');
      window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
      }).addTo(map);
      markers = window.L.layerGroup().addTo(map);
    }
    markers.clearLayers();
    if (!points.length) {
      map.setView([0, 0], 2);
      return;
    }
    var coords = [];
    points.forEach(function (point) {
      coords.push([point.lat, point.lon]);
      window.L.circleMarker([point.lat, point.lon], {
        radius: 5,
        weight: 2,
        color: '#1b6b4a',
        fillOpacity: 0.6
      }).addTo(markers);
    });
    if (coords.length > 1) {
      window.L.polyline(coords, { color: '#1b6b4a', weight: 2, opacity: 0.7 }).addTo(markers);
    }
    map.fitBounds(coords, { padding: [24, 24], maxZoom: 16 });
  }

  function render(points) {
    tableBody.textContent = '';
    if (!points.length) {
      var tr = document.createElement('tr');
      var td = cell('No reports yet — start tracking in the app.', 'empty');
      td.colSpan = 7;
      tr.appendChild(td);
      tableBody.appendChild(tr);
      drawMap(points);
      return;
    }
    points.slice(-50).reverse().forEach(function (point) {
      tableBody.appendChild(row(point));
    });
    drawMap(points);
  }

  function refresh() {
    var token = tokenInput.value.trim();
    if (!token) {
      setStatus('enter the token');
      return;
    }
    fetch('/api/points?token=' + encodeURIComponent(token), { cache: 'no-store' })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          setStatus(result.body && result.body.error ? result.body.error : 'request failed');
          return;
        }
        render(result.body.points || []);
        setStatus(result.body.count + ' point(s) · ' + new Date().toLocaleTimeString());
      })
      .catch(function (error) {
        setStatus('error: ' + error.message);
      });
  }

  refresh();
  setInterval(refresh, 5000);
</script>
</body>
</html>`;
}
