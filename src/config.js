import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripQuotes } from './util.js';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const positive = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const PORT = positive(process.env.PORT, 8080);
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
export const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(DATA_DIR, 'cache'));
export const CACHE_MAX_MB = positive(process.env.CACHE_MAX_MB, 1400);
export const MAX_HEIGHT = Math.round(positive(process.env.MAX_HEIGHT, 720));
export const FALLBACK_HEIGHT = Math.round(positive(process.env.FALLBACK_HEIGHT, 480));
export const SLOW_KBPS = positive(process.env.SLOW_KBPS, 350);
export const SLOW_GRACE_MS = positive(process.env.SLOW_GRACE_MS, 12_000);
export const DOWNLOAD_CONCURRENCY = Math.min(3, Math.round(positive(process.env.DOWNLOAD_CONCURRENCY, 1)));
export const DOWNLOAD_TIMEOUT_MS = positive(process.env.DOWNLOAD_TIMEOUT_MS, 240_000);
export const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
export const YT_JS_RUNTIME = process.env.YT_JS_RUNTIME === 'off' ? '' : process.env.YT_JS_RUNTIME || 'node';
export const YT_PLAYER_CLIENT = process.env.YT_PLAYER_CLIENT || 'visionos';
export const MAX_SHORT_SECONDS = positive(process.env.MAX_SHORT_SECONDS, 180);

let cachedAuth = null;

function normalizeCookieText(text) {
  return text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * Resolves the YouTube auth strategy once at boot.
 * 1. YT_COOKIE (raw cookies.txt contents or a path to one) → use cookies.
 * 2. YT_COOKIE_FILE path → use cookies.
 * 3. otherwise → fall back to the visionOS yt-dlp player client.
 */
export function getAuth() {
  if (cachedAuth) return cachedAuth;
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let cookieFile = null;

  const fileEnv = process.env.YT_COOKIE_FILE;
  if (fileEnv) {
    const candidate = path.resolve(stripQuotes(fileEnv));
    if (fs.existsSync(candidate)) cookieFile = candidate;
    else console.warn(`[auth] YT_COOKIE_FILE points to a missing file: ${candidate}`);
  }

  const rawEnv = process.env.YT_COOKIE;
  if (!cookieFile && rawEnv && rawEnv.trim()) {
    const raw = stripQuotes(rawEnv);
    const looksLikeContent = raw.includes('\n') || raw.includes('\t') || raw.startsWith('# Netscape');
    if (looksLikeContent) {
      const text = normalizeCookieText(raw);
      const target = path.join(DATA_DIR, 'cookies.txt');
      try {
        fs.writeFileSync(target, text + '\n', { mode: 0o600 });
        cookieFile = target;
        console.log(`[auth] YT_COOKIE loaded from environment (${text.split('\n').length} lines).`);
      } catch (error) {
        console.error('[auth] Could not write cookies file:', error.message);
      }
    } else {
      const candidate = path.resolve(raw);
      if (fs.existsSync(candidate)) {
        cookieFile = candidate;
        console.log(`[auth] Using cookies file from YT_COOKIE path: ${candidate}`);
      } else {
        console.warn('[auth] YT_COOKIE is set but does not look like cookies.txt and is not an existing path. Using visionOS fallback.');
      }
    }
  }

  cachedAuth = {
    cookieFile,
    mode: cookieFile ? 'cookies' : 'visionos',
    client: cookieFile ? null : YT_PLAYER_CLIENT
  };
  console.log(
    cookieFile
      ? '[auth] YouTube auth: cookies.txt'
      : `[auth] YouTube auth: no cookies, falling back to player_client=${YT_PLAYER_CLIENT}`
  );
  return cachedAuth;
}

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}
