import { cleanText } from './util.js';

// yt-dlp's flat hashtag/channel pages often omit uploader info, which hides the
// subscribe button and leaves liked videos without a channel. YouTube's oEmbed
// endpoint fills that gap cheaply and without auth.

const POSITIVE_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 20 * 60 * 1000;
const MAX_CONCURRENT = 6;
const cache = new Map();
let active = 0;
const waiters = [];

async function withSlot(fn) {
  if (active < MAX_CONCURRENT) {
    active += 1;
  } else {
    await new Promise((resolve) => waiters.push(resolve));
  }
  try {
    return await fn();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  }
}

function cached(videoId) {
  const hit = cache.get(videoId);
  if (!hit) return undefined;
  const ttl = hit.value ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
  return Date.now() - hit.at < ttl ? hit.value : undefined;
}

async function lookup(videoId) {
  const hit = cached(videoId);
  if (hit !== undefined) return hit;
  return withSlot(async () => {
    const again = cached(videoId);
    if (again !== undefined) return again;
    let value = null;
    try {
      const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`
      )}&format=json`;
      const response = await fetch(url, {
        headers: { 'user-agent': 'HussHussSlop/1.0' },
        signal: AbortSignal.timeout(4_000)
      });
      if (response.ok) {
        const data = await response.json();
        const channelId = /\/channel\/(UC[A-Za-z0-9_-]{20,})/.exec(String(data.author_url || ''))?.[1] || '';
        value = {
          channel: cleanText(data.author_name, 120),
          channelUrl:
            typeof data.author_url === 'string' && /^https?:\/\//.test(data.author_url) ? data.author_url : '',
          channelId
        };
        if (!value.channel && !value.channelUrl) value = null;
      }
    } catch {
      value = null;
    }
    cache.set(videoId, { at: Date.now(), value });
    if (cache.size > 4000) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 500);
      for (const [key] of oldest) cache.delete(key);
    }
    return value;
  });
}

export async function enrichItems(items, { max = 60 } = {}) {
  if (!Array.isArray(items) || !items.length) return items;
  const limit = Math.min(items.length, max);
  const enriched = await Promise.all(
    items.map(async (item, index) => {
      if (!item || index >= limit || item.channel || item.channelId) return item;
      const info = await lookup(item.id);
      if (!info) return item;
      return {
        ...item,
        channel: item.channel || info.channel,
        channelId: item.channelId || info.channelId,
        channelUrl: item.channelUrl || info.channelUrl
      };
    })
  );
  return enriched;
}
