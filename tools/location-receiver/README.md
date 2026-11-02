# TrailPin receiver

A dependency-free HTTP endpoint (and one page of map) for the
[TrailPin Android tracker](../../android/README.md). It exists so the app can be
tested end to end before it is pointed at a real website — and to document, in
code, the request shape the app produces.

```bash
TRACKER_TOKEN=secret PORT=8080 node tools/location-receiver/server.mjs
# or: npm run start:receiver
```

| Route                    | Purpose                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `GET /`                  | Dashboard: token box, map, table of the last 50 reports                     |
| `GET/POST /api/location` | Ingest one report. Token may be in the query, the body or `X-Tracker-Token` |
| `GET /api/points`        | JSON feed of everything received (`?token=…`)                               |
| `GET /healthz`           | `{ ok, points }`                                                            |

Accepted parameters: `lat`/`latitude`, `lon`/`lng`/`longitude`, `tid`, `tst`,
`acc`, `alt`, `vel`, `bear`, `batt`, `prov`. Missing coordinates and
out-of-range values get a `400`; a wrong token gets a `401`.

```bash
curl "http://localhost:8080/api/location?token=secret&lat=31.326&lon=75.576&tid=curl"
curl -X POST "http://localhost:8080/api/location?token=secret" \
  -H 'content-type: application/json' \
  -d '{"lat":31.326,"lon":75.576,"tid":"curl","batt":87}'
```

Environment:

| Variable             | Default    | Meaning                                                           |
| -------------------- | ---------- | ----------------------------------------------------------------- |
| `PORT`               | `8080`     | Listen port (binds `0.0.0.0`, so a phone on the LAN can reach it) |
| `TRACKER_TOKEN`      | `changeme` | The shared secret the app must send                               |
| `TRACKER_MAX_POINTS` | `5000`     | In-memory ring buffer size                                        |
| `TRACKER_STORE`      | _(none)_   | Optional JSON file to persist points across restarts              |

Tests use the Node built-in runner and no dependencies:

```bash
npm test --prefix tools/location-receiver     # or: npm run test:receiver
```

Points are kept in memory; this is a development tool, not a database. Replace it
with the route in your own website when you are ready — the contract is the table
above and nothing else.
