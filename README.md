# Huss Huss Slop

A self-hosted, TikTok-style feed for YouTube Shorts. Search by topic, channel, or
hashtag, get an automatic For You feed tuned to what you like, and actually stream
the videos — each one is downloaded server-side with `yt-dlp` and remuxed to MP4
for fast, seekable playback.

Built to run on a small Railway instance (1 GB RAM / 2 vCPU) and to fall back to
yt-dlp's `visionos` player client when no YouTube cookies are available.

## Features

- **Streaming player** — vertical snap-scroll feed, autoplay on scroll, tap to
  pause, mute toggle, progress bar, prefetching of the next video.
- **Search** — topic (`dog`), hashtag (`#dog`), channel (`@MrBeast`, channel URL,
  or channel ID). Auto-detects the kind, or force it with the chips.
- **For You feed** — builds preferences from your likes, searches, and watch
  history, then pulls matching hashtag/shorts candidates. Cold start uses rotating
  seed topics. Recently watched videos are filtered out. Sources are interleaved
  round-robin with at most two clips per channel, plus one rotating fresh topic and
  one random "slop" clip that never touches your tastes.
- **Subscriptions** — subscribe from any short (feed, liked, or search results).
  Subscribed channels and channels like them are pushed to the top of For You.
- **Per-device profiles** — every browser gets its own id (cookie) with separate
  likes, history, searches, subscriptions, and cached feed. Comments stay shared.
- **Portable feeds** — a dedicated Feeds tab names a profile, exports it as an
  8-character code, lists your past exports, and imports by **name or code**
  on another device to clone its likes, searches, and subscriptions. Codes and
  names live on the server that created them, so both devices must use the same
  site URL.
- **Likes** — persisted to a JSON store and shown in the Liked tab, which also
  feeds personalization.
- **Comments** — server-side per-video comments with a bottom sheet UI, shared by
  every visitor and persisted in `$DATA_DIR/db.json`.
- **Adaptive quality** — tries 720p first; if the download falls below
  `SLOW_KBPS`, it kills the attempt and retries at 480p, then prefers 480p for the
  rest of the process.
- **Disk cache** - MP4s live on disk with LRU eviction up to `CACHE_MAX_MB`.
- **No repeats** - videos you have opened are excluded from For You permanently
  (not just for a few hours), and the feed refills itself from fresh topics.
- **Feedbook Marketplace** - post a feed with a name, blurb and cover image;
  anyone can hit **Load** to clone it into their own For You. Posts are stored
  server-side with the export code they minted.
- **Live admin banners** - a password-protected panel in the web UI broadcasts a
  banner to every connected viewer in real time over Server-Sent Events.
- **Auth fallback** — `YT_COOKIE` (raw cookies.txt contents or a path) /
  `YT_COOKIE_FILE`, otherwise `player_client=visionos`.

## Quick start (local)

Requirements: **Node.js 20+**, **yt-dlp**, and **ffmpeg** on your `PATH`.

```bash
npm install
npm start
# open http://localhost:8080
```

Windows PowerShell:

```powershell
$env:PORT = 8099
node src/server.js
```

On first boot you'll see which auth mode was chosen:

```
[auth] YouTube auth: no cookies, falling back to player_client=visionos
[cache] 0 video(s), 0.0 MB on disk.
Huss Huss Slop listening on http://0.0.0.0:8080
```

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. New Railway project → **Deploy from GitHub repo**.
3. Railway detects `railway.json` and builds the `Dockerfile` (multi-arch: amd64
   and arm64 are both handled).
4. *(Recommended)* Add the **MongoDB** plugin. Railway injects `MONGO_URL`, which
   the app auto-detects, so likes, comments, subscriptions and **feed share codes**
   survive redeploys. Without Mongo, mount a **Volume** at `/app/data` instead —
   otherwise all state (and any export code you made) is wiped on every deploy.
5. *(Recommended)* Add the **Redis** plugin. `REDIS_URL` is injected; feed builds,
   share lookups and marketplace reads are cached there. The DB remains the
   source of truth and Redis is only a cache.
6. *(Recommended)* Mount a **Volume** at `/app/data` for the video cache (the free
   500 MB volume holds roughly 450 MB of MP4s plus `db.json`).
7. *(Optional but recommended)* Add `YT_COOKIE` as a variable. Without cookies,
   datacenter IPs may be asked to "sign in to confirm you're not a bot".
8. Healthcheck is `/api/health` and the app listens on Railway's injected `PORT`.

The image installs a self-contained `yt-dlp_linux` binary (no Python), plus
`ffmpeg` and `ca-certificates`. `yt-dlp` moves fast — redeploy periodically to
pick up a fresh binary (the Dockerfile always pulls `latest`).

### Hardware notes

- Keep `DOWNLOAD_CONCURRENCY=1` on a 1 GB / 2 vCPU box.
- `CACHE_MAX_MB=450` leaves headroom on Railway's free 500 MB volume for
  `db.json` and temp files. Raise it if you mounted a bigger disk.
- Two videos downloading at 720p can spike memory. If you see restarts, lower
  `MAX_HEIGHT` to `480` or `CACHE_MAX_MB` to keep less on disk.

## Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port. Railway injects this. |
| `DATA_DIR` | `./data` | JSON mirror + default cache location. Mount your volume here. |
| `CACHE_DIR` | `$DATA_DIR/cache` | Where MP4s are stored. |
| `CACHE_MAX_MB` | `450` | Max size of the MP4 cache; LRU eviction beyond this. |
| `MONGODB_URI` | *(blank)* | Mongo connection string. Railway's plugin sets `MONGO_URL`, which is also read. |
| `MONGODB_DB` | `huss_huss_slop` | Database name used inside Mongo. |
| `REDIS_URL` | *(blank)* | Cache for feed builds/shares/market. Railway's plugin injects it; falls back to memory. |
| `ADMIN_TOKEN` | *(random)* | Password for the ⚙ admin panel / live banners. Random per boot if unset. |
| `MAX_HEIGHT` | `720` | Preferred vertical resolution. |
| `FALLBACK_HEIGHT` | `480` | Resolution used when the link is slow. |
| `SLOW_KBPS` | `350` | Below this speed the 720p attempt is killed. `0` disables. |
| `SLOW_GRACE_MS` | `12000` | Ignore speed readings during the first N ms of a download. |
| `DOWNLOAD_CONCURRENCY` | `1` | Simultaneous downloads (capped at 3). |
| `DOWNLOAD_FRAGMENTS` | `8` | Parallel DASH fragments per download (capped at 16). |
| `DOWNLOAD_TIMEOUT_MS` | `240000` | Per-attempt download timeout. |
| `MAX_SHORT_SECONDS` | `180` | Longer entries are rejected as "not a Short". |
| `SEARCH_CONCURRENCY` | `3` | Max concurrent yt-dlp metadata/search processes. |
| `YTDLP_PATH` | `yt-dlp` | Path to the yt-dlp binary. |
| `YT_JS_RUNTIME` | `node` | JS runtime for YouTube signature solving; `off` disables. |
| `YT_PLAYER_CLIENT` | `visionos` | Player client used when no cookies are configured. |
| `YT_COOKIE` | — | Raw Netscape `cookies.txt` contents **or** a path to one. |
| `YT_COOKIE_FILE` | — | Path to a `cookies.txt` already on disk. |

See `.env.example` for a copy-paste starting point.

### About cookies

`YT_COOKIE_FILE` wins if both are set. When `YT_COOKIE` looks like file contents
(contains newlines/tabs or starts with `# Netscape HTTP Cookie File`) it is
written to `$DATA_DIR/cookies.txt` with `0600` permissions and used with
`--cookies`. A single-line value is treated as a path instead.

Export cookies from a logged-in YouTube session with a browser extension (for
example "Get cookies.txt LOCALLY") and paste the whole file into the variable.
Treat those cookies like a password: they can access the account they came from.

If no cookies are configured, the app uses:

```
--extractor-args youtube:player_client=visionos
```

which works surprisingly often from datacenter IPs. If YouTube starts blocking
it, a cookie file is the reliable fix.

## How it works

```
Browser (vanilla JS)
   │  /api/*
   ▼
Express (src/server.js)
   ├─ search/feed  → yt-dlp -J (flat playlist)  → src/ytdlp.js
   ├─ personalization / JSON store               → src/feed.js, src/store.js
   └─ download queue → yt-dlp -f ... --remux mp4 → src/downloads.js
                                                   └─ $CACHE_DIR/<id>.mp4
```

- Searches return metadata only; the browser asks for a download when a slide
  becomes visible (`POST /api/video/:id`), then polls `/status` until ready.
- `/api/video/:id/file` serves the MP4 with HTTP Range support, so the `<video>`
  element can seek and the browser can stream instead of waiting for the file.
- Format selection caps **both** width and height (720×1280 vertical Shorts), so
  a "480p" fallback really selects 480p instead of silently matching 720p.
- The feed extracts hashtags/keywords from liked and searched videos, caches the
  result per client for 5 minutes, and invalidates on like or subscription changes.
- A client is identified by the `hhl_cid` cookie (or an `x-client-id` header for
  scripts). The first real page visit adopts the pre-multi-client profile, so an
  existing install keeps its likes and subscriptions.
- Every opened video is recorded in that client's history and excluded from For
  You for good. If filtering leaves too few clips, the feed pulls extra rotating
  topics instead of padding with repeats.
- Live banners ride a single SSE connection per browser (`/api/live`); the admin
  endpoint pushes `banner` events and the page renders them as a floating pill.
- At boot the durable DB (Mongo, else `db.json`) is loaded first, then Redis is
  warmed from it. Feed builds (5 min), share codes/names (1 h) and the market
  list (30 s) are cached in Redis. Every mutation still writes the DB, and the
  affected Redis keys are refreshed or dropped, so Redis is never authoritative.

## Admin banners

Set `ADMIN_TOKEN` (or read the generated password from the boot log), open the
site, click the **⚙** button in the top bar, paste the password, type a message
and hit **Send live**. Every connected browser shows it for the chosen duration.
Tones: lime, blue, amber, red. The panel also shows the live viewer count.

The same thing from a terminal:

```bash
curl -X POST https://your-app.up.railway.app/api/admin/banner \
  -H "content-type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"text":"SLOP HOUR STARTS NOW","tone":"lime","seconds":8}'
```

## API sketch

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness probe for Railway. |
| `GET` | `/api/status` | Auth mode, yt-dlp version, cache/queue stats. |
| `GET` | `/api/feed?limit=18` | Personalized feed for this client. |
| `POST` | `/api/feed/share` | Mint a named share code: `{ "name": "roblox brainrot" }`. |
| `GET` | `/api/feed/shares` | This client's exported feeds (names + codes). |
| `DELETE` | `/api/feed/shares/:code` | Forget an export (the code itself still works). |
| `GET` | `/api/feed/shared/:code` | Inspect a share code's name and counts. |
| `POST` | `/api/feed/import` | Replace this client's tastes with `{ "code": "name-or-code" }`. |
| `GET` | `/api/market` | Feedbook posts (name, blurb, cover, code, counts). |
| `POST` | `/api/market` | Post this client's feed: `{ "name", "description", "image" }`. |
| `DELETE` | `/api/market/:id` | Remove one of your own posts. |
| `GET` | `/api/live` | Server-Sent Events stream: live banners + viewer count. |
| `POST` | `/api/admin/banner` | Broadcast `{ "text", "tone", "seconds" }`; header `x-admin-token`. |
| `GET` | `/api/admin/session` | Validate the admin password and read the live viewer count. |
| `GET` | `/api/search?q=...&kind=auto\|topic\|tag\|channel` | Search Shorts (exact titles first). |
| `GET` | `/api/liked` | Liked videos. |
| `GET` / `POST` / `DELETE` | `/api/subscriptions` | List, toggle (`subscribed:false`), or remove subscriptions. |
| `GET` | `/api/recent` | Recent searches + like count. |
| `POST` | `/api/video/:id` | Queue/download a video. Body may include metadata and `priority`. |
| `GET` | `/api/video/:id/status` | Download job status. |
| `GET` | `/api/video/:id/file` | MP4 stream (Range supported). |
| `POST` / `DELETE` | `/api/video/:id/like` | Like / unlike. |
| `POST` | `/api/video/:id/view` | Record a view for feed filtering. |
| `GET` / `POST` | `/api/video/:id/comments` | Read / add comments (shared by everyone). |

## Troubleshooting

**"YouTube wants a sign-in from this server."**
Datacenter IPs get bot-checked. Add `YT_COOKIE`. If cookies also fail, redeploy
to refresh yt-dlp, and make sure `ffmpeg` is present (it is in the Docker image).

**Search works but videos won't play.**
Check `/api/status` for the yt-dlp version, then try one video directly:
`POST /api/video/<id>` and poll `/status`. The error message comes from yt-dlp's
last stderr line and is usually descriptive.

**Everything 480p after one slow download.**
That's intentional: once a slow link is detected the process prefers
`FALLBACK_HEIGHT` until restart. Restart the service to go back to 720p.

**Disk filling up.**
Lower `CACHE_MAX_MB`, or mount a larger volume. The cache only ever holds
downloaded Shorts, and the oldest are evicted first.

**Railway restarts / OOM.**
Set `DOWNLOAD_CONCURRENCY=1`, reduce `MAX_HEIGHT` to `480`, and/or lower
`CACHE_MAX_MB`. Prefer a 2 GB instance if you can.

## Project layout

```
src/
  config.js     env parsing + auth resolution (cookies vs visionOS)
  server.js     Express routes, client ids, security headers, cache/queue status
  ytdlp.js      search (topic/tag/channel), normalization, auth args, ranking
  downloads.js  queue, slow-link fallback, format choice, LRU cache
  feed.js       per-client personalization, subscriptions, related tags, wildcard
  enrich.js     oEmbed channel metadata for items yt-dlp left blank
  idle.js       pauses new downloads when nobody is watching
  store.js      persistence (Mongo or JSON): clients, likes, history, searches, subs, shares
  util.js       ids, text cleanup, tag extraction
public/
  index.html    app shell (feed, search, subs, liked, comments)
  app.js        player, search, likes, comments, subscriptions, share codes
  styles.css    dark TikTok-ish UI
Dockerfile      Railway image (yt-dlp + ffmpeg)
railway.json    build + healthcheck config
```

## Notes & caveats

This is a personal project. It downloads videos through `yt-dlp`; whether that is
acceptable for a given video or region is between you and YouTube's Terms of
Service. Don't run a public, high-traffic instance, and don't redistribute
downloaded content. Use cookies only from an account you control.

There are no accounts. State lives in MongoDB when `MONGODB_URI` (or Railway's
`MONGO_URL`) is set — per-device profiles (likes, history, search history,
subscriptions), share codes, global comment threads and video metadata all go
into a single `state` document. That means an export code made on Railway still
works after a redeploy, and from any other browser.

With no database configured the app writes `$DATA_DIR/db.json` instead. In that
mode you must mount a volume at `/app/data`, or likes, comments and share codes
disappear on the next deploy (the Feeds tab warns you when this is the case).
