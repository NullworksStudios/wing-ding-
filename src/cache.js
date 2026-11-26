import { REDIS_URL } from './config.js';

// Redis is a cache, never the source of truth. Every mutation still lands in
// the durable store (MongoDB, or db.json), and startup warms Redis from it.
// If Redis is missing or drops, calls fall through to a tiny in-process map so
// the app keeps working.

let client = null;
let ready = false;
let connecting = null;
let retryTimer = null;
// How long to keep an unreachable Redis from blocking boot. On a tiny Railway
// box a bad host/IPv6-only URL can hang `connect()` far past its own timeout,
// and the app must never wait for a cache.
const CONNECT_TIMEOUT_MS = 4_000;

const local = new Map();

function now() {
  return Date.now();
}

function localStorageSet(key, value, ttlSec) {
  local.set(key, { value, exp: ttlSec ? now() + ttlSec * 1000 : 0 });
  if (local.size > 500) {
    const oldest = local.keys().next().value;
    if (oldest !== undefined) local.delete(oldest);
  }
}

function localStorageGet(key) {
  const entry = local.get(key);
  if (!entry) return null;
  if (entry.exp && entry.exp < now()) {
    local.delete(key);
    return null;
  }
  return entry.value;
}

export async function initCache() {
  if (!REDIS_URL) {
    console.log('[cache] Redis not configured - using in-process cache only');
    return { mode: 'memory' };
  }
  if (connecting) return connecting;
  if (client) return { mode: cacheMode() };
  connecting = (async () => {
    let candidate = null;
    try {
      const { createClient } = await import('redis');
      candidate = createClient({
        url: REDIS_URL,
        socket: {
          connectTimeout: 3_000,
          reconnectStrategy: (retries) => Math.min(250 * (retries + 1), 3_000)
        }
      });
      candidate.on('ready', () => {
        ready = true;
      });
      candidate.on('end', () => {
        ready = false;
      });
      candidate.on('error', (error) => {
        // Silence connect retries while we are still deciding whether to keep
        // this client at all; after boot a real outage is worth a warning.
        if (ready) console.warn('[cache] Redis error:', error.message);
      });
      let timer = null;
      const guard = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('connect timed out')), CONNECT_TIMEOUT_MS);
        timer.unref?.();
      });
      try {
        await Promise.race([candidate.connect(), guard]);
      } finally {
        clearTimeout(timer);
      }
      ready = true;
      client = candidate;
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
      console.log('[cache] Redis connected');
      return { mode: 'redis' };
    } catch (error) {
      console.warn('[cache] Redis unavailable, using in-process cache:', error.message);
      try {
        await candidate?.disconnect();
      } catch {}
      client = null;
      ready = false;
      scheduleRedisRetry();
      return { mode: 'memory' };
    }
  })();
  return connecting;
}

export function cacheMode() {
  return ready ? 'redis' : 'memory';
}

// A failed boot attempt should not be permanent: retry quietly in the
// background until it answers, then report "redis" again.
function scheduleRedisRetry() {
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    if (ready) {
      clearInterval(retryTimer);
      retryTimer = null;
      return;
    }
    initCache().catch(() => {});
  }, 60_000);
  retryTimer.unref?.();
}

export async function cacheGet(key) {
  if (ready && client) {
    try {
      const value = await client.get(key);
      if (value != null) return value;
    } catch {}
  }
  return localStorageGet(key);
}

export async function cacheSet(key, value, ttlSec = 300) {
  localStorageSet(key, value, ttlSec);
  if (ready && client) {
    try {
      if (ttlSec > 0) await client.set(key, value, { EX: ttlSec });
      else await client.set(key, value);
    } catch {}
  }
}

export async function cacheDel(key) {
  local.delete(key);
  if (ready && client) {
    try {
      await client.del(key);
    } catch {}
  }
}

export async function cacheDelPrefix(prefix) {
  for (const key of [...local.keys()]) if (key.startsWith(prefix)) local.delete(key);
  if (ready && client) {
    try {
      for await (const key of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 200 })) {
        await client.del(key);
      }
    } catch {}
  }
}

export async function cacheClose() {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  try {
    await client?.disconnect();
  } catch {}
  client = null;
  ready = false;
}

export const FEED_PREFIX = 'hhl:feed:';
