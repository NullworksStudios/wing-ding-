import { spawn } from 'node:child_process';
import {
  YTDLP_PATH,
  YT_JS_RUNTIME,
  MAX_SHORT_SECONDS,
  getAuth
} from './config.js';
import { VIDEO_ID_RE, cleanText, extractVideoId, tagsFromTitle } from './util.js';

const SEARCH_TTL_MS = 10 * 60 * 1000;
const HASHTAG_TTL_MS = 6 * 60 * 1000;
const MAX_CONCURRENT_FETCHES = Math.max(1, Number(process.env.SEARCH_CONCURRENCY) || 3);
const cache = new Map();
let activeFetches = 0;
const fetchWaiters = [];

async function withFetchSlot(fn) {
  if (activeFetches < MAX_CONCURRENT_FETCHES) {
    activeFetches += 1;
  } else {
    await new Promise((resolve) => fetchWaiters.push(resolve));
  }
  try {
    return await fn();
  } finally {
    const next = fetchWaiters.shift();
    if (next) next();
    else activeFetches -= 1;
  }
}

function ansiStrip(text) {
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
}

export function friendlyError(error) {
  const raw = ansiStrip(error?.stderr || error?.message || 'yt-dlp failed');
  const line =
    raw
      .split('\n')
      .map((l) => l.replace(/^ERROR:\s*/i, '').trim())
      .filter(Boolean)
      .pop() || 'yt-dlp failed';

  if (/sign in to confirm|not a bot|confirm you.?re not a bot/i.test(raw)) {
    return 'YouTube wants a sign-in from this server. Add a cookies.txt via YT_COOKIE.';
  }
  if (/private video|members-only/i.test(raw)) return 'That video is private or members-only.';
  if (/video unavailable|this video is not available|has been removed/i.test(raw)) return 'That video is unavailable.';
  if (/HTTP Error 429|too many requests/i.test(raw)) return 'YouTube is rate-limiting this server. Wait a bit or add cookies.';
  if (/Unable to extract|player response|nsig|signature/i.test(raw)) {
    return 'YouTube extraction failed. Update yt-dlp or add cookies via YT_COOKIE.';
  }
  if (/requested format is not available/i.test(raw)) return 'No downloadable format was available.';
  if (/timed out|timeout/i.test(raw)) return 'YouTube took too long to respond. Try again.';
  return cleanText(line, 220) || 'yt-dlp failed';
}

function commonArgs() {
  const args = ['--ignore-config', '--no-warnings', '--no-playlist', '--socket-timeout', '20', '--retries', '2'];
  if (YT_JS_RUNTIME) args.push('--js-runtimes', YT_JS_RUNTIME);
  return args;
}

function authArgs() {
  const auth = getAuth();
  if (auth.cookieFile) return ['--cookies', auth.cookieFile];
  return ['--extractor-args', `youtube:player_client=${auth.client || 'visionos'}`];
}

function collect(args, { timeout = 60_000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(YTDLP_PATH, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      const error = new Error('yt-dlp timed out');
      error.stderr = stderr;
      finish(reject, error);
    }, timeout);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 30_000_000 && !onLine) stdout = stdout.slice(-1_000_000);
      if (onLine) {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) onLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 40_000) stderr = stderr.slice(-40_000);
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (code === 0) finish(resolve, { stdout, stderr });
      else {
        const error = new Error(`yt-dlp exited with code ${code}`);
        error.stderr = stderr;
        error.code = code;
        finish(reject, error);
      }
    });
  });
}

async function cached(key, ttl, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const entry = { at: Date.now(), promise: loader() };
  cache.set(key, entry);
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 40);
    for (const [k] of oldest) cache.delete(k);
  }
  try {
    return await entry.promise;
  } catch (error) {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  }
}

function pickThumb(entry, id) {
  const list = Array.isArray(entry.thumbnails) ? entry.thumbnails.filter((t) => t?.url) : [];
  if (!list.length) return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  list.sort((a, b) => Math.abs((a.width || 320) - 480) - Math.abs((b.width || 320) - 480));
  return list[0].url;
}

function normalizeEntry(entry, source, { allowUnknownDuration = false } = {}) {
  if (!entry || entry._type === 'playlist' || entry._type === 'channel') return null;
  const url = entry.url || entry.webpage_url || '';
  const id = extractVideoId(entry.id) || extractVideoId(url);
  if (!id || !VIDEO_ID_RE.test(id)) return null;
  if (entry.live_status === 'is_live' || entry.live_status === 'is_upcoming') return null;

  const duration = Number(entry.duration) > 0 ? Math.round(Number(entry.duration)) : null;
  const isShortUrl = /\/shorts\//.test(url);
  if (!allowUnknownDuration && duration == null && !isShortUrl) return null;
  if (duration != null && duration > MAX_SHORT_SECONDS) return null;
  if (duration != null && duration < 2) return null;

  const title = cleanText(entry.title, 300);
  if (!title || /^\[?(private|deleted) video\]?$/i.test(title)) return null;

  return {
    id,
    title,
    channel: cleanText(entry.channel || entry.uploader || '', 120),
    channelId: cleanText(entry.channel_id || entry.uploader_id || '', 64),
    channelUrl: entry.channel_url || entry.uploader_url || '',
    duration,
    views: Number(entry.view_count) || null,
    thumb: pickThumb(entry, id),
    url: `https://www.youtube.com/shorts/${id}`,
    tags: tagsFromTitle(title),
    isShort: isShortUrl || (duration != null && duration <= MAX_SHORT_SECONDS),
    source
  };
}

async function fetchRaw(url, limit, { timeout = 55_000 } = {}) {
  const args = [
    ...commonArgs(),
    ...authArgs(),
    '-J',
    '--flat-playlist',
    '--playlist-end',
    String(limit),
    url
  ];
  return withFetchSlot(async () => {
    const { stdout } = await collect(args, { timeout });
    try {
      const data = JSON.parse(stdout);
      return Array.isArray(data?.entries) ? data.entries : [data];
    } catch {
      throw new Error('YouTube returned an unexpected response. Try again.');
    }
  });
}

async function fetchFlat(url, limit, { allowUnknownDuration = false, source = 'search', timeout = 55_000 } = {}) {
  const entries = await fetchRaw(url, limit, { timeout });
  return entries
    .map((entry) => normalizeEntry(entry, source, { allowUnknownDuration }))
    .filter(Boolean);
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function hashtagSlug(query) {
  // Keep the tag the user typed. Never pick one word out of a phrase:
  // "#inthistown" must stay "inthistown", not collapse to "town".
  const slug = String(query)
    .replace(/^#+/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '') // hashtags can't contain spaces
    .replace(/[^\p{L}\p{N}_-]+/gu, '');
  return slug ? slug.slice(0, 80) : null;
}

function scoreEntry(item, index, sourceBoost) {
  let score = sourceBoost - index * 0.04 + Math.random() * 0.35;
  if (item.duration != null && item.duration <= 65) score += 1.1;
  if (item.isShort) score += 0.9;
  if (/#shorts?\b/i.test(item.title)) score += 1.2;
  if (item.views) score += Math.min(1.4, Math.log10(item.views + 1) / 7);
  return score;
}

function queryTerms(query) {
  return String(query)
    .toLowerCase()
    .replace(/^#/, '')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((word) => word.length >= 3)
    .slice(0, 6);
}

function countTerms(item, terms) {
  if (!terms.length) return 0;
  const haystack = `${item.title} ${item.channel || ''} ${(item.tags || []).join(' ')}`.toLowerCase();
  let matched = 0;
  for (const term of terms) {
    if (haystack.includes(term)) matched += 1;
  }
  return matched;
}

function rank(groups, limit, terms = []) {
  const seen = new Set();
  const scored = [];
  const multiTerm = terms.length >= 2;
  for (const { items, boost } of groups) {
    items.forEach((item, index) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      let score = scoreEntry(item, index, boost);
      const matched = countTerms(item, terms);
      // Multi-word searches must honour every word. An "any word" match is not
      // enough: a search for "funny roblox stories" should not float generic
      // "stories" clips to the top, and items matching nothing should not be
      // injected from side channels at all.
      if (multiTerm) {
        if (matched === 0) {
          score -= 5;
        } else {
          score += (matched / terms.length) * 4;
          if (matched === terms.length) score += 1.5;
        }
      } else if (matched > 0) {
        score += 1.2;
      }
      scored.push({ item, score, matched });
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const pool = multiTerm ? scored.filter(({ matched }) => matched > 0) : scored;
  const ranked = pool.length ? pool : scored;
  return ranked.slice(0, limit).map(({ item }) => item);
}

export function detectKind(query) {
  const q = String(query || '').trim();
  if (!q) return 'topic';
  if (q.startsWith('#')) return 'tag';
  if (/^(channel|ch):/i.test(q)) return 'channel';
  if (q.startsWith('@')) return 'channel';
  if (/^(https?:\/\/)?(www\.|m\.)?youtube\.com\/(channel\/|c\/|user\/|@)/i.test(q)) return 'channel';
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(q)) return 'channel';
  return 'topic';
}

function stripKindPrefix(query, kind) {
  let q = String(query || '').trim();
  if (kind === 'channel') q = q.replace(/^(channel|ch):/i, '').trim();
  return q;
}

async function hashtagEntries(tag, limit, source = 'hashtag') {
  const slug = hashtagSlug(tag);
  if (!slug) return [];
  return cached(`hashtag:${slug}:${limit}`, HASHTAG_TTL_MS, () =>
    fetchFlat(`https://www.youtube.com/hashtag/${encodeURIComponent(slug)}/shorts`, limit, {
      allowUnknownDuration: true,
      source
    })
  );
}

async function resolveChannelUrl(query) {
  const q = stripKindPrefix(query, 'channel');
  if (!q) throw new Error('Type a channel name, @handle or channel URL.');

  const direct = q.match(/(?:youtube\.com\/)(channel\/[A-Za-z0-9_-]+|c\/[^/?#]+|user\/[^/?#]+|@[^/?#]+)/i);
  if (direct) {
    const path = direct[1].replace(/\/+$/, '');
    return `https://www.youtube.com/${path}`;
  }
  if (q.startsWith('@')) {
    const handle = q.split(/\s+/)[0].replace(/\/+$/, '');
    return `https://www.youtube.com/${handle}`;
  }
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(q)) return `https://www.youtube.com/channel/${q}`;

  const channelSearchUrl =
    'https://www.youtube.com/results?search_query=' +
    encodeURIComponent(q) +
    '&sp=EgIQAg%253D%253D';
  const rawEntries = await fetchRaw(channelSearchUrl, 6, { timeout: 45_000 });
  const channelEntry = rawEntries.find(
    (entry) => /youtube\.com\/(channel\/|@|c\/|user\/)/i.test(entry.url || entry.webpage_url || '')
  );
  if (channelEntry) return channelEntry.url || channelEntry.webpage_url;

  const fallbackEntries = await fetchFlat(`ytsearch5:${q}`, 5, {
    allowUnknownDuration: true,
    source: 'search',
    timeout: 45_000
  });
  const found = fallbackEntries.find((entry) => entry.channelUrl);
  if (found?.channelUrl) return found.channelUrl;
  throw new Error('Could not find that channel. Try an @handle or the full channel URL.');
}

function shortsUrlFor(channelUrl) {
  const clean = channelUrl.replace(/\/+$/, '');
  if (/\/(shorts|videos|streams|playlists)$/i.test(clean)) return clean.replace(/\/(videos|streams|playlists)$/i, '/shorts');
  return `${clean}/shorts`;
}

export async function searchChannel(query, limit = 24) {
  const key = `channel:${query.toLowerCase()}:${limit}`;
  return cached(key, SEARCH_TTL_MS, async () => {
    const channelUrl = await resolveChannelUrl(query);
    const items = await fetchFlat(shortsUrlFor(channelUrl), Math.min(limit * 2, 60), {
      allowUnknownDuration: true,
      source: 'channel',
      timeout: 60_000
    });
    if (!items.length) throw new Error('That channel has no public Shorts (or YouTube hid them).');
    return items.slice(0, limit);
  });
}

export async function searchTopic(query, limit = 24) {
  const q = stripKindPrefix(query, 'topic');
  const key = `topic:${q.toLowerCase()}:${limit}`;
  return cached(key, SEARCH_TTL_MS, async () => {
    // Always search the full phrase the user typed. Only a single-word query
    // can sensibly be treated as a hashtag; deriving "#stories" from
    // "funny roblox stories" is what used to ruin topic results.
    const singleWord = !/\s/.test(q);
    const mainCount = Math.min(40, limit * 2);
    const tasks = [
      fetchFlat(`ytsearch${mainCount}:${q} #shorts`, mainCount, {
        allowUnknownDuration: false,
        source: 'search'
      }).catch((error) => ({ error })),
      fetchFlat(`ytsearch${Math.min(30, limit * 2)}:${q}`, Math.min(30, limit * 2), {
        allowUnknownDuration: false,
        source: 'search'
      }).catch((error) => ({ error })),
      singleWord
        ? hashtagEntries(q, Math.min(30, limit * 2)).catch((error) => ({ error }))
        : Promise.resolve([])
    ];
    const [a, b, c] = await Promise.all(tasks);
    const failures = [a, b, c].filter((result) => result?.error);
    const groups = [
      { items: Array.isArray(a) ? a : [], boost: 1.5 },
      { items: Array.isArray(c) ? c : [], boost: 1.1 },
      { items: Array.isArray(b) ? b : [], boost: 1.0 }
    ];
    const items = rank(groups, limit, queryTerms(q));
    if (!items.length) {
      const first = failures[0]?.error;
      if (first) throw new Error(friendlyError(first));
      throw new Error('No Shorts found for that search. Try another topic or a hashtag.');
    }
    return items;
  });
}

export async function searchTag(query, limit = 24) {
  const tag = stripKindPrefix(query, 'tag').replace(/^#+/, '').trim();
  if (!tag) throw new Error('Type a tag, like #dog.');
  const key = `tag:${tag.toLowerCase()}:${limit}`;
  return cached(key, SEARCH_TTL_MS, async () => {
    const [hashtag, searched] = await Promise.all([
      hashtagEntries(tag, Math.min(limit * 2, 50)).catch((error) => ({ error })),
      fetchFlat(`ytsearch${Math.min(30, limit)}:#${tag} #shorts`, Math.min(30, limit), {
        allowUnknownDuration: false,
        source: 'search'
      }).catch((error) => ({ error }))
    ]);
    const groups = [
      { items: Array.isArray(hashtag) ? hashtag : [], boost: 1.2 },
      { items: Array.isArray(searched) ? searched : [], boost: 1.3 }
    ];
    const items = rank(groups, limit, queryTerms(tag));
    if (!items.length) {
      const error = hashtag?.error || searched?.error;
      if (error) throw new Error(friendlyError(error));
      throw new Error('No Shorts found for that hashtag.');
    }
    return items;
  });
}

export async function search(query, kind = 'auto', limit = 24) {
  const resolvedKind = !kind || kind === 'auto' ? detectKind(query) : kind;
  if (resolvedKind === 'channel') return { kind: resolvedKind, items: await searchChannel(query, limit) };
  if (resolvedKind === 'tag') return { kind: resolvedKind, items: await searchTag(query, limit) };
  return { kind: 'topic', items: await searchTopic(query, limit) };
}

export async function feedTagItems(tag, limit = 20) {
  const key = `feedtag:${tag.toLowerCase()}:${limit}`;
  return cached(key, HASHTAG_TTL_MS, async () => {
    const searched = await fetchFlat(`ytsearch${Math.min(limit * 2, 40)}:#${tag} shorts`, Math.min(limit * 2, 40), {
      allowUnknownDuration: false,
      source: 'search'
    }).catch((error) => {
      console.warn(`[ytdlp] feed search for ${tag} failed:`, friendlyError(error));
      return [];
    });
    if (searched.length >= 8) return searched.slice(0, limit);
    const extra = await hashtagEntries(tag, limit).catch(() => []);
    return rank(
      [
        { items: searched, boost: 1.4 },
        { items: extra, boost: 0.7 }
      ],
      limit,
      queryTerms(tag)
    );
  });
}

export async function feedSearchItems(query, limit = 8) {
  const q = String(query || '').trim().replace(/^#+/, '').trim();
  if (!q) return [];
  const key = `feedsearch:${q.toLowerCase()}:${limit}`;
  return cached(key, HASHTAG_TTL_MS, async () => {
    // Search the exact phrase the user typed, then keep only entries that
    // actually match it. Used to turn recent searches into feed recommendations.
    const raw = await fetchFlat(`ytsearch${Math.min(limit * 2, 30)}:${q} #shorts`, Math.min(limit * 2, 30), {
      allowUnknownDuration: false,
      source: 'search'
    }).catch(() => []);
    return rank([{ items: raw, boost: 1.4 }], limit, queryTerms(q));
  });
}

export async function channelFeedItems(sub, limit = 8) {
  const identity = sub.channelId || sub.channelUrl || sub.channel;
  const key = `subfeed:${String(identity).toLowerCase()}:${limit}`;
  return cached(key, HASHTAG_TTL_MS, async () => {
    const base = sub.channelUrl || (sub.channelId ? `https://www.youtube.com/channel/${sub.channelId}` : sub.channel);
    if (!base) return [];
    const channelUrl = await resolveChannelUrl(base);
    const items = await fetchFlat(shortsUrlFor(channelUrl), Math.min(limit * 2, 30), {
      allowUnknownDuration: true,
      source: 'subscription',
      timeout: 60_000
    });
    return items.slice(0, limit).map((item) => ({
      ...item,
      channel: item.channel || sub.channel || '',
      channelId: item.channelId || sub.channelId || '',
      channelUrl: item.channelUrl || sub.channelUrl || channelUrl,
      subscribed: true
    }));
  });
}

export async function ytdlpVersion() {
  try {
    const { stdout } = await collect(['--version'], { timeout: 10_000 });
    return stdout.trim().split('\n')[0];
  } catch {
    return null;
  }
}

export { collect, commonArgs, authArgs };
