export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

const STOP_WORDS = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves shorts short shortvideo viral fyp youtube video videos new best top amazing official full hd 4k`
    .split(/\s+/)
);

export function cleanText(value, max = 300) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function stripQuotes(value) {
  const v = String(value ?? '').trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

export function extractVideoId(input) {
  const raw = String(input ?? '');
  if (VIDEO_ID_RE.test(raw)) return raw;
  const match =
    raw.match(/\/shorts\/([A-Za-z0-9_-]{6,20})/) ||
    raw.match(/[?&]v=([A-Za-z0-9_-]{6,20})/) ||
    raw.match(/youtu\.be\/([A-Za-z0-9_-]{6,20})/);
  return match ? match[1] : null;
}

export function tagsFromTitle(title) {
  const text = cleanText(title, 500);
  const tags = [];
  const push = (tag) => {
    const t = String(tag).toLowerCase().replace(/^#+/, '').replace(/[^\p{L}\p{N}_-]/gu, '');
    if (t.length < 2 || t.length > 30 || STOP_WORDS.has(t)) return;
    if (/^\d+$/.test(t)) return;
    if (!tags.includes(t)) tags.push(t);
  };

  for (const match of text.matchAll(/#([\p{L}\p{N}_-]{2,30})/gu)) push(match[1]);

  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,24}/gu);
  if (words) {
    for (const word of words) {
      const t = word.replace(/^['-]+|['-]+$/g, '');
      if (t.length < 3) continue;
      push(t);
      if (tags.length >= 10) break;
    }
  }
  return tags.slice(0, 10);
}

export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function formatDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '';
  if (s < 60) return `0:${String(Math.round(s)).padStart(2, '0')}`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return `${m}:${String(rest).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
