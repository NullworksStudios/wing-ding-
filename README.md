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
  seed topics. Recently watched videos are filtered out.
- **Likes** — persisted to a JSON store and shown in the Liked tab, which also
  feeds personalization.
- **Comments** — local, per-video comments with a bottom sheet UI.
- **Adaptive quality** — tries 720p first; if the download falls below
  `SLOW_KBPS`, it kills the attempt and retries at 480p, then prefers 480p for the
  rest of the process.
- **Disk cache** — MP4s live on disk with LRU eviction up to `CACHE_MAX_MB`.
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
4. *(Recommended)* Add a **Volume** mounted at `/app/data`. Without it, likes,
   comments, and the video cache are wiped on every redeploy.
5. *(Optional but recommended)* Add `YT_COOKIE` as a variable. Without cookies,
   datacenter IPs may be asked to "sign in to confirm you're not a bot".
6. Healthcheck is `/api/health` and the app listens on Railway's injected `PORT`.

The image installs a self-contained `yt-dlp_linux` binary (no Python), plus
`ffmpeg` and `ca-certificates`. `yt-dlp` moves fast — redeploy periodically to
pick up a fresh binary (the Dockerfile always pulls `latest`).

### Hardware notes

- Keep `DOWNLOAD_CONCURRENCY=1` on a 1 GB / 2 vCPU box.
- `CACHE_MAX_MB=1400` is roughly a third of a small Railway volume. Lower it if
  you have less disk; raise it if you have more.
- Two videos downloading at 720p can spike memory. If you see restarts, lower
  `MAX_HEIGHT` to `480` or `CACHE_MAX_MB` to keep less on disk.

## Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port. Railway injects this. |
| `DATA_DIR` | `./data` | JSON database + default cache location. Mount your volume here. |
| `CACHE_DIR` | `$DATA_DIR/cache` | Where MP4s are stored. |
| `CACHE_MAX_MB` | `1400` | Max size of the MP4 cache; LRU eviction beyond this. |
| `MAX_HEIGHT` | `720` | Preferred vertical resolution. |
| `FALLBACK_HEIGHT` | `480` | Resolution used when the link is slow. |
| `SLOW_KBPS` | `350` | Below this speed the 720p attempt is killed. `0` disables. |
| `SLOW_GRACE_MS` | `12000` | Ignore speed readings during the first N ms of a download. |
| `DOWNLOAD_CONCURRENCY` | `1` | Simultaneous downloads (capped at 3). |
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
  result for 5 minutes, and invalidates on like changes.

## API sketch

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness probe for Railway. |
| `GET` | `/api/status` | Auth mode, yt-dlp version, cache/queue stats. |
| `GET` | `/api/feed?limit=18` | Personalized feed. |
| `GET` | `/api/search?q=...&kind=auto\|topic\|tag\|channel` | Search Shorts. |
| `GET` | `/api/liked` | Liked videos. |
| `GET` | `/api/recent` | Recent searches + like count. |
| `POST` | `/api/video/:id` | Queue/download a video. Body may include metadata and `priority`. |
| `GET` | `/api/video/:id/status` | Download job status. |
| `GET` | `/api/video/:id/file` | MP4 stream (Range supported). |
| `POST` / `DELETE` | `/api/video/:id/like` | Like / unlike. |
| `POST` | `/api/video/:id/view` | Record a view for feed filtering. |
| `GET` / `POST` | `/api/video/:id/comments` | Read / add comments. |

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
  server.js     Express routes, security headers, cache/queue status
  ytdlp.js      search (topic/tag/channel), normalization, auth args
  downloads.js  queue, slow-link fallback, format choice, LRU cache
  feed.js       personalization + feed assembly
  store.js      JSON persistence (likes, history, searches, comments)
  util.js       ids, text cleanup, tag extraction
public/
  index.html    app shell (feed, search, liked, comments)
  app.js        player, search, likes, comments, polling
  styles.css    dark TikTok-ish UI
Dockerfile      Railway image (yt-dlp + ffmpeg)
railway.json    build + healthcheck config
```

## Notes & caveats

This is a personal project. It downloads videos through `yt-dlp`; whether that is
acceptable for a given video or region is between you and YouTube's Terms of
Service. Don't run a public, high-traffic instance, and don't redistribute
downloaded content. Use cookies only from an account you control.

Everything is stored locally: likes, history, search history, and comments live
in `$DATA_DIR/db.json`. There are no accounts and no external database.
