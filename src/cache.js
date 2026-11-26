import { REDIS_URL } from './config.js';

// Redis is a cache, never the source of truth. Every mutation still lands in
// the durable store (MongoDB, or db.json), and startup warms Redis from it.
// If Redis is missing or drops, calls fall through to a tiny in-process map so
// the app keeps working.

let client = null;
let ready = false;
let connecting = null;

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
  connecting = (async () => {
    try {
      const { createClient } = await import('redis');
      client = createClient({
        url: REDIS_URL,
        socket: {
          connectTimeout: 8_000,
          reconnectStrategy: (retries) => Math.min(250 * (retries + 1), 3_000)
        }
      });
      client.on('error', (error) => {
        if (ready) console.warn('[cache] Redis error:', error.message);
      });
      client.on('ready', () => {
        ready = true;
      });
      client.on('end', () => {
        ready = false;
      });
      await client.connect();
      ready = true;
      console.log('[cache] Redis connected');
      return { mode: 'redis' };
    } catch (error) {
      console.warn('[cache] Redis unavailable, using in-process cache:', error.message);
      try {
        await client?.disconnect();
      } catch {}
      client = null;
      ready = false;
      return { mode: 'memory' };
    }
  })();
  return connecting;
}

export function cacheMode() {
  return ready ? 'redis' : 'memory';
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
  try {
    await client?.quit();
  } catch {}
  client = null;
  ready = false;
}

export const FEED_PREFIX = 'hhl:feed:';
