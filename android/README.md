# TrailPin — a small, self-hosted location tracker for Android

A single-purpose Android app in the spirit of [OwnTracks](https://owntracks.org/):
it reads the phone's position and reports it to **your** server. There is no
account, no cloud, no map SDK key, and no backend shipped with it — only a URL, an
API path and a token that you type in.

Everything it does on the wire is one HTTP request:

```
GET /api/location?token=s3cret&lat=31.326000&lon=75.576000&tid=tp-1a2b3c4d&tst=1762040000&acc=8.0&batt=87&prov=gps
```

Both `http://` and `https://` work. Point it at `https://example.com`, at
`http://192.168.1.10:8080`, or at a VPS with no certificate at all — the app
does not care, and neither does your server.

---

## 1. Build the APK

There are three ways. The first needs nothing installed on our machine.

### 1a. Let GitHub build it (recommended)

1. GitHub → **Actions** → **android-apk** → the latest green run.
2. Download the artifact **`trailpin-debug-apk`** (a zip containing `trailpin-debug.apk`).
3. Copy the APK to the phone (USB, Drive, Telegram — anything), tap it, and allow
   "install unknown apps" for the app you opened it from.

Or over USB with the platform tools:

```bash
adb install -r trailpin-debug.apk
```

The workflow lives in [`.github/workflows/android-apk.yaml`](../.github/workflows/android-apk.yaml)
and runs `./gradlew testDebugUnitTest assembleDebug` on every push that touches
`android/**`.

### 1b. Android Studio

Open the **`android/`** folder (not the repository root), let Gradle sync, then
either press ▶ with the phone plugged in, or use
**Build → Build App Bundle(s) / APK(s) → Build APK(s)**. The APK lands in
`android/app/build/outputs/apk/debug/app-debug.apk`.

### 1c. Command line

Requires **JDK 17** and the Android SDK (`ANDROID_HOME` set, with
`platforms;android-34` and `build-tools;34.0.0` installed — Android Studio's SDK
Manager can install those for you).

```bash
cd android
./build-apk.sh            # → android/dist/trailpin-debug.apk
# or, equivalently
./gradlew assembleDebug
```

`local.properties` (written by Android Studio, ignored by git) may hold
`sdk.dir=/path/to/Android/sdk`.

**Signed release build, if you want one.** The `release` variant is signed with the
throwaway debug key so that `./gradlew assembleRelease` always produces something
installable. For a real key:

```bash
keytool -genkeypair -v -keystore trailpin.jks -alias trailpin \
  -keyalg RSA -keysize 2048 -validity 10000
./gradlew assembleRelease -PstoreFile=trailpin.jks -PstorePassword=… -PkeyAlias=trailpin -PkeyPassword=…
```

Keep the keystore and its passwords out of git — and note that a release build
with a different key cannot update an installed debug build; uninstall first.

---

## 2. Configure it

Open the app and fill in the **Server** card:

| Field          | Example                   | Notes                                                                 |
| -------------- | ------------------------- | --------------------------------------------------------------------- |
| Server URL     | `https://example.com`     | Full URL, or a bare host (`example.com`, `192.168.1.10:8080`)         |
| Protocol       | `Auto` / `HTTP` / `HTTPS` | Auto keeps what you typed, and guesses `http` for LAN/localhost names |
| API path       | `/api/location`           | Appended to the server URL                                            |
| API token      | `s3cret`                  | Sent as a query parameter on every request                            |
| Token param    | `token`                   | Rename it if your site expects `key=` or `apikey=`                    |
| Request method | `GET — query string`      | Also `POST` form-encoded or JSON                                      |

The **Request preview** card shows the exact URL this phone will call, updated as
you type. There is nothing hidden behind it.

Then press **Start tracking**. The first fix can take a few seconds outdoors;
**Send test report** sends the last known fix immediately and prints the server's
answer in the activity log.

### What is sent

| Parameter | Meaning                              | Always     |
| --------- | ------------------------------------ | ---------- |
| `token`   | your API token                       | yes        |
| `lat`     | latitude, 6 decimals                 | yes        |
| `lon`     | longitude, 6 decimals                | yes        |
| `tid`     | device ID (`tp-xxxxxxxx` by default) | yes        |
| `tst`     | fix time, seconds since the epoch    | yes        |
| `acc`     | horizontal accuracy in metres        | when known |
| `alt`     | altitude in metres                   | when known |
| `vel`     | speed in m/s                         | when known |
| `bear`    | bearing in degrees                   | when known |
| `batt`    | battery percentage                   | when known |
| `prov`    | `gps`, `network` or `passive`        | when known |

With `POST — form encoded` the coordinates travel in the body
(`lat=…&lon=…&tid=…`) and the token stays in the query string. With
`POST — JSON` the body is `{"lat":…,"lon":…,"tst":…,"tid":…,"token":…}`.

### Tracking behaviour

| Setting               | Default | What it does                                                      |
| --------------------- | ------- | ----------------------------------------------------------------- |
| Interval (seconds)    | 60      | Minimum time between fixes / heartbeat period. Clamped to 5–3600. |
| Distance filter (m)   | 25      | Ignore movement smaller than this; `0` reports every fix.         |
| Report every interval | on      | Sends the last known position even when you have not moved.       |
| Resume after reboot   | off     | Restarts tracking after a reboot or an app update.                |

Failed reports are never lost: they queue on disk (up to 500 points) and are
retried on the next tick. A `4xx` answer other than `408/429` is treated as
permanent so one rejected point cannot block the queue forever.

### Permissions

- **Location** — required. "While using the app" is enough for a foreground
  service started from the app.
- **Location → Allow all the time** — recommended; use the
  _Allow background location_ button.
- **Notifications** (Android 13+) — required for the ongoing notification.
- **Ignore battery optimisation** — strongly recommended; without it Doze can
  delay the heartbeat for minutes. Use the button of the same name.

The tracker runs as a foreground service with a low-importance notification that
shows what happened last and offers **Send now** and **Stop**.

---

## 3. Test it without a server

A dependency-free receiver is in this repository:

```bash
TRACKER_TOKEN=secret PORT=8080 node tools/location-receiver/server.mjs
```

It prints its endpoint, accepts the exact request above, and serves a small map
at <http://localhost:8080/>. On the phone, use
`http://<your-computer-LAN-IP>:8080` + `/api/location` + token `secret` — the app
defaults bare private IPs to `http`, which is what you want on a LAN.

From a shell, the same thing:

```bash
curl "http://localhost:8080/api/location?token=secret&lat=31.326&lon=75.576&tid=curl"
```

On a real website you need a route that reads `token`, `lat` and `lon` and stores
them. Any language, three lines of code. Check the token with a constant-time
comparison, drop reports with impossible coordinates, and rate-limit the endpoint.

---

## 4. How it works inside

```
android/app/src/main/java/com/trailpin/tracker/
├── MainActivity.kt         settings form, live request preview, log, permissions
├── TrackerService.kt       foreground service: locations → queue → HTTP
├── UrlFactory.kt           the URL: scheme, host, path, token, coordinates
├── ReportSender.kt         one HttpURLConnection request, one result
├── PendingQueue.kt         on-disk retry queue (JSON, capped at 500)
├── TrackerConfig.kt        config data class + SharedPreferences store
├── Position.kt             one fix (+ JSON for the queue and POST bodies)
├── LogStore.kt             rotating on-screen log
├── BootReceiver.kt         resume after reboot
└── TrackerAlarmReceiver.kt 15-minute re-arm that survives Android killing the service
```

Deliberate choices, in case you are wondering:

- **No dependencies beyond AndroidX/Material.** `HttpURLConnection` handles both
  schemes and needs no OkHttp, Gson, Retrofit, Play Services or map SDK.
- **`LocationManager`, not FusedLocationProvider**, so the app also works on
  phones without Google Play Services.
- **No https-only enforcement.** `res/xml/network_security_config.xml` permits
  cleartext for every host and additionally trusts user-installed CAs, which
  makes self-signed certificates usable. That is a decision you should make
  knowingly: an http endpoint sends your token in clear text.
- **The token is a query parameter**, exactly as requested. Beware that query
  strings end up in server logs, browser history and proxy logs; rotate the token
  if it leaks, and prefer https for anything beyond a LAN.

`UrlFactory` is pure Kotlin (no Android classes) and is covered by
`app/src/test/java/com/trailpin/tracker/UrlFactoryTest.kt`:

```bash
cd android && ./gradlew testDebugUnitTest
```

---

## 5. Troubleshooting

| Symptom in the log                            | Likely cause / fix                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `HTTP 404`                                    | Wrong API path. The URL is `<server URL><API path>?…` — check the preview.                                                               |
| `HTTP 401` / `403`                            | Token rejected. Check the value and the _token parameter name_ your site expects.                                                        |
| `HTTP 301` / `302`                            | Your site redirects `http` → `https`. `HttpURLConnection` does not follow cross-scheme redirects; switch the protocol to HTTPS yourself. |
| `UnknownHostException`                        | DNS or typo. On a LAN, prefer the IP address.                                                                                            |
| `ConnectException` / `SocketTimeoutException` | Wrong port, firewall, or the server is not listening on `0.0.0.0`.                                                                       |
| `SSLHandshakeException`                       | Certificate problem. Install the CA on the phone (user CAs are trusted) or use http on the LAN.                                          |
| `Waiting for a GPS fix`                       | Indoors. Go outside, or set distance filter to 0 and wait; the network provider will eventually answer.                                  |
| Reports stop when the screen is off           | Battery optimisation is still on, or background location was never granted. Use both buttons in the Tracking card.                       |
| Notification gone after a while               | The service was killed and the alarm has not re-armed it yet (up to 15 minutes), or tracking was stopped from the notification.          |

The log is a file inside the app's private storage (`trailpin.log`), rotated at
300 lines, and is shown at the bottom of the screen. It is the first place to look.

---

## 6. Repository notes

This folder is a standalone Android project inside a GitOps repository. It is not
part of the ShopStack cluster pipeline, is not an npm workspace, and is built by
its own workflow. Root `npm test`, `npm run lint` and
`scripts/validate-manifests.sh` do not build it; `android-apk.yaml` does.
