import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import {
  PORT,
  ROOT,
  DATA_DIR,
  CACHE_DIR,
  CACHE_MAX_MB,
  MAX_HEIGHT,
  FALLBACK_HEIGHT,
  ensureDirs,
  getAuth
} from './config.js';
import { Store } from './store.js';
import { cleanText, extractVideoId, VIDEO_ID_RE } from './util.js';
import { search, detectKind, friendlyError, ytdlpVersion } from './ytdlp.js';
import { ensureDownload, getJob, cachedFile, cacheInfo, queueInfo, startDownloads, stopDownloads } from './downloads.js';
import { markActive, isIdle, startIdleWatcher, stopIdleWatcher } from './idle.js';
import { buildFeed, invalidateFeed } from './feed.js';
import { enrichItems } from './enrich.js';

ensureDirs();
const store = new Store(path.join(DATA_DIR, 'db.json'));
const auth = getAuth();
startDownloads();
startIdleWatcher();

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'"
  );
  next();
});

// Any real request (not health checks) counts as a visitor; the page also
// sends /api/ping while it is visible so a quiet open tab keeps the app awake.
app.use((req, res, next) => {
  if (req.path !== '/api/health' && req.method !== 'HEAD') markActive();
  next();
});

const CLIENT_COOKIE = 'hhl_cid';
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function readClientId(req) {
  const header = String(req.get('x-client-id') || '').trim();
  if (CLIENT_ID_RE.test(header)) return header;
  const fromCookie = parseCookies(req.headers.cookie || '')[CLIENT_COOKIE];
  if (CLIENT_ID_RE.test(String(fromCookie || ''))) return String(fromCookie);
  return null;
}

// Each browser/device gets its own likes, history, subscriptions and cached
// feed. Comments stay global on purpose so everyone sees the same thread.
app.use((req, res, next) => {
  let clientId = readClientId(req);
  const navigating =
    (req.method === 'GET' || req.method === 'HEAD') &&
    (req.path === '/' || req.path === '/index.html') &&
    String(req.get('sec-fetch-mode') || '') === 'navigate';
  // Only a real page visit can adopt the profile from pre-multi-client
  // versions (the old global likes/subscriptions). API clients and bots must
  // not steal it, so they get a fresh anonymous id instead.
  if (!clientId && navigating) clientId = store.claimPrimaryClient();
  if (!clientId) clientId = randomBytes(9).toString('base64url');
  res.cookie(CLIENT_COOKIE, clientId, {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    httpOnly: true
  });
  req.clientId = clientId;
  next();
});

const buckets = new Map();
function allow(key, limit, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.reset < now) {
    bucket = { count: 0, reset: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.reset < now) buckets.delete(key);
}, 60_000).unref();

function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function validVideoId(req, res) {
  const id = extractVideoId(req.params.id);
  if (!id || !VIDEO_ID_RE.test(id)) {
    res.status(400).json({ error: 'Bad video id' });
    return null;
  }
  return id;
}

function metaFromReq(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  return {
    id: req.params.id,
    title: cleanText(body.title, 300),
    channel: cleanText(body.channel, 120),
    channelId: cleanText(body.channelId, 64),
    channelUrl: typeof body.channelUrl === 'string' ? body.channelUrl : '',
    duration: Number(body.duration) || null,
    thumb: typeof body.thumb === 'string' ? body.thumb : ''
  };
}

let versionPromise = null;
function serverInfo() {
  if (!versionPromise) versionPromise = ytdlpVersion();
  return {
    name: 'Huss Huss Slop',
    version: '1.0.0',
    authMode: auth.mode,
    cookiesConfigured: Boolean(auth.cookieFile),
    playerClient: auth.cookieFile ? null : auth.client,
    dataDir: DATA_DIR,
    cacheDir: CACHE_DIR,
    limits: {
      cacheMb: CACHE_MAX_MB,
      maxHeight: MAX_HEIGHT,
      fallbackHeight: FALLBACK_HEIGHT
    }
  };
}

app.post('/api/ping', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, idle: isIdle(), uptime: Math.round(process.uptime()) });
});

app.get(
  '/api/status',
  wrap(async (req, res) => {
    const info = serverInfo();
    const ytdlp = versionPromise ? await versionPromise : null;
    res.json({
      ...info,
      ytdlp,
      cache: cacheInfo(),
      queue: queueInfo(),
      stats: store.stats(req.clientId),
      recentSearches: store.recentSearches(req.clientId, 8),
      uptime: Math.round(process.uptime())
    });
  })
);

app.get(
  '/api/feed',
  wrap(async (req, res) => {
    const limit = Math.max(4, Math.min(30, Number(req.query.limit) || 18));
    const exclude = String(req.query.exclude || '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => VIDEO_ID_RE.test(id))
      .slice(0, 80);
    const feed = await buildFeed(store, req.clientId, { limit, exclude });
    const items = await enrichItems(feed.items);
    res.json({
      ...feed,
      items: items.map((item) => ({ ...item, subscribed: store.isSubscribed(item, req.clientId) }))
    });
  })
);

app.get(
  '/api/search',
  wrap(async (req, res) => {
    const q = cleanText(req.query.q, 120);
    if (!q) return res.status(400).json({ error: 'Type something to search.' });
    if (!allow(`search:${clientKey(req)}`, 40, 60_000)) {
      return res.status(429).json({ error: 'Slow down a little — search limit reached.' });
    }
    const kind = String(req.query.kind || 'auto');
    const normalizedKind = ['auto', 'topic', 'channel', 'tag'].includes(kind) ? kind : 'auto';
    try {
      const result = await search(q, normalizedKind, 24);
      store.recordSearch(q, result.kind, req.clientId);
      const items = await enrichItems(result.items);
      res.json({
        query: q,
        kind: result.kind,
        detectedKind: detectKind(q),
        items: items.map((item) => ({ ...item, subscribed: store.isSubscribed(item, req.clientId) }))
      });
    } catch (error) {
      res.status(502).json({ error: friendlyError(error), query: q });
    }
  })
);

app.get(
  '/api/liked',
  wrap(async (req, res) => {
    const items = await enrichItems(store.getLiked(req.clientId));
    store.hydrateLiked(items, req.clientId);
    res.json({
      items: items.map((item) => ({ ...item, subscribed: store.isSubscribed(item, req.clientId) })),
      count: items.length
    });
  })
);

app.get('/api/subscriptions', (req, res) => {
  const items = store.subscriptions(req.clientId);
  res.json({ items, count: items.length });
});

app.post('/api/subscriptions', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.subscribed === false) {
    const result = store.removeSubscription(body, req.clientId);
    invalidateFeed(req.clientId);
    return res.json(result);
  }
  const result = store.addSubscription(body, req.clientId);
  if (!result.subscribed) {
    return res.status(400).json({ error: result.error || 'Could not subscribe to that channel.' });
  }
  invalidateFeed(req.clientId);
  res.json(result);
});

app.delete('/api/subscriptions/:key', (req, res) => {
  const result = store.removeSubscription(decodeURIComponent(req.params.key || ''), req.clientId);
  invalidateFeed(req.clientId);
  res.json(result);
});

app.post('/api/feed/share', (req, res) => {
  const name = cleanText(req.body?.name, 40);
  const share = store.createShare(req.clientId, { name });
  if (!share) return res.status(400).json({ error: 'Nothing to share yet. Like something first.' });
  res.json({
    code: share.code,
    name: share.name,
    createdAt: share.createdAt,
    counts: {
      likes: share.snapshot.likes.length,
      searches: share.snapshot.searches.length,
      subscriptions: share.snapshot.subscriptions.length
    }
  });
});

app.get('/api/feed/shares', (req, res) => {
  const items = store.exports(req.clientId).map((entry) => {
    const share = store.getShare(entry.code);
    return {
      ...entry,
      share: share
        ? {
            likes: share.snapshot.likes.length,
            searches: share.snapshot.searches.length,
            subscriptions: share.snapshot.subscriptions.length
          }
        : null
    };
  });
  res.json({ items, count: items.length });
});

app.delete('/api/feed/shares/:code', (req, res) => {
  res.json(store.removeExport(req.clientId, String(req.params.code || '').toLowerCase()));
});

app.get('/api/feed/shared/:code', (req, res) => {
  const share = store.getShare(req.params.code);
  if (!share) return res.status(404).json({ error: 'That feed code does not exist.' });
  res.json({
    code: share.code,
    name: share.name || '',
    createdAt: share.createdAt,
    counts: {
      likes: share.snapshot.likes.length,
      searches: share.snapshot.searches.length,
      subscriptions: share.snapshot.subscriptions.length
    }
  });
});

app.post('/api/feed/import', (req, res) => {
  const code = cleanText(req.body?.code, 12);
  if (!code) return res.status(400).json({ error: 'Enter a feed code.' });
  const share = store.getShare(code);
  if (!share) return res.status(404).json({ error: 'That feed code does not exist.' });
  const result = store.importShare(req.clientId, share);
  invalidateFeed(req.clientId);
  res.json({ ...result, code: share.code });
});

app.get(
  '/api/recent',
  wrap(async (req, res) => {
    res.json({
      searches: store.recentSearches(req.clientId, 12),
      likes: store.getLiked(req.clientId).length
    });
  })
);

app.post('/api/video/:id', (req, res) => {
  const id = validVideoId(req, res);
  if (!id) return;
  if (!allow(`dl:${clientKey(req)}`, 200, 60_000)) {
    return res.status(429).json({ error: 'Too many downloads requested. Give it a second.' });
  }
  store.rememberVideo(metaFromReq(req));
  const priority = Boolean(req.body?.priority);
  const job = ensureDownload(id, { priority });
  if (!job) return res.status(400).json({ error: 'Bad video id' });
  res.json({ ...job, liked: store.isLiked(id, req.clientId), comments: store.commentCount(id) });
});

app.get('/api/video/:id/status', (req, res) => {
  const id = validVideoId(req, res);
  if (!id) return;
  res.json({ ...getJob(id), liked: store.isLiked(id, req.clientId), comments: store.commentCount(id) });
});

app.get('/api/video/:id/file', (req, res) => {
  const id = validVideoId(req, res);
  if (!id) return;
  const file = cachedFile(id);
  if (!file) {
    return res.status(409).json({ error: 'Video is not downloaded yet', status: getJob(id).status });
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(file, { cacheControl: false, etag: true, lastModified: true }, (error) => {
    if (error && !res.headersSent) res.status(500).end();
  });
});

app.post('/api/video/:id/like', (req, res) => {
  const id = validVideoId(req, res);
  if (!id) return;
  const meta = metaFromReq(req);
  store.rememberVideo(meta);
  const result = store.addLike(meta, req.clientId);
  invalidateFeed(req.clientId);
  res.json({ ...result, id, comments: store.commentCount(id) });
});

app.delete('/api/video/:id/like', (req, res) => {
  const id = validVideoId(req, res);
  if (!id) return;
  const result = store.removeLike(id, req.clientId);
  invalidateFeed(req.clientId);
  res.json({ ...result, id });
});

app.post('/api/video/:id/view', (req, res) => {
  const id = validVideoId(req, res);
  if (!id) return;
  store.recordView(metaFromReq(req), req.clientId);
  res.json({ ok: true });
});

app.get('/api/video/:id/comments', (req, res) => {
  const id = validVideoId(req, res);
  if (!id) return;
  const comments = store.getComments(id);
  res.json({ id, count: comments.length, comments });
});

app.post('/api/video/:id/comments', (req, res) => {
  const id = validVideoId(req, res);
  if (!id) return;
  if (!allow(`comment:${clientKey(req)}`, 60, 60_000)) {
    return res.status(429).json({ error: 'Comment limit reached. Breathe.' });
  }
  const name = cleanText(req.body?.name, 32) || 'anon';
  const text = cleanText(req.body?.text, 600);
  if (!text) return res.status(400).json({ error: 'Comment is empty.' });
  const comment = store.addComment(id, name, text);
  if (!comment) return res.status(400).json({ error: 'Comment is empty.' });
  res.json({ comment, count: store.commentCount(id) });
});

app.use(
  express.static(path.join(ROOT, 'public'), {
    index: 'index.html',
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  })
);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  console.error('[server]', error?.message || error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Something broke on the server.' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Huss Huss Slop listening on http://0.0.0.0:${PORT}`);
  console.log(`[auth] mode=${auth.mode}${auth.client ? ` client=${auth.client}` : ''}`);
});

function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down.`);
  stopDownloads();
  stopIdleWatcher();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
