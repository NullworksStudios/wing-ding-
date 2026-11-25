import { feedTagItems, channelFeedItems } from './ytdlp.js';
import { tagsFromTitle } from './util.js';

const SEEDS = [
  'funny',
  'satisfying',
  'cats',
  'dogs',
  'memes',
  'cooking',
  'gaming',
  'football',
  'music',
  'dance',
  'diy',
  'comedy',
  'animals',
  'basketball',
  'cars',
  'art',
  'science',
  'history',
  'facts',
  'asmr',
  'skateboarding',
  'makeup',
  'magic',
  'experiments'
];

const EXPLORE_TAGS = [
  'ai video',
  'ai slop',
  'satisfying',
  'cursed ai',
  'random funny',
  'memes',
  'oddly satisfying',
  'unexpected',
  'weird facts'
];

const FEED_TTL_MS = 5 * 60 * 1000;
const RECENT_VIEW_MS = 6 * 60 * 60 * 1000;
// Two clips per channel keeps the feed feeling like a mix, not a channel dump.
const MAX_ITEMS_PER_CHANNEL = 2;
const MAX_CACHED_CLIENTS = 250;

let seedCursor = 0;
const feedCache = new Map();

function rememberFeed(clientId, entry) {
  feedCache.delete(clientId);
  feedCache.set(clientId, entry);
  if (feedCache.size > MAX_CACHED_CLIENTS) {
    const stale = [...feedCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 25);
    for (const [key] of stale) feedCache.delete(key);
  }
}

function nextSeeds(count) {
  const picks = [];
  for (let i = 0; i < count; i += 1) {
    picks.push(SEEDS[(seedCursor + i) % SEEDS.length]);
  }
  seedCursor = (seedCursor + count) % SEEDS.length;
  return picks;
}

function channelKey(item) {
  if (!item) return '';
  if (item.channelId) return `id:${item.channelId}`;
  if (item.channel) return `name:${String(item.channel).toLowerCase()}`;
  return '';
}

// Build the feed by taking one clip at a time from every source, rather than
// letting the heaviest source run to the end. That guarantees the feed
// alternates between subscriptions, related channels and topics, and the
// per-channel cap stops one uploader from filling a stretch of the feed.
function mergeCandidates(groups) {
  const seen = new Set();
  const buckets = [];
  for (const group of groups) {
    const weight = group.weight || 0;
    const items = [];
    group.items.forEach((item, index) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      let score = weight * 2 - index * 0.03 + Math.random() * 0.6;
      if (item.duration != null && item.duration <= 65) score += 0.9;
      if (item.views) score += Math.min(1.8, Math.log10(item.views + 1) / 6.5);
      items.push({ ...item, reason: group.reason, _score: score });
    });
    if (!items.length) continue;
    items.sort((a, b) => b._score - a._score);
    buckets.push({ order: weight + Math.random() * 0.35, items, cursor: 0 });
  }
  buckets.sort((a, b) => b.order - a.order);

  const counts = new Map();
  const front = [];
  const backlog = [];

  let progressed = true;
  let round = 0;
  const offset = Math.floor(Math.random() * Math.max(1, buckets.length));
  while (progressed) {
    progressed = false;
    for (let step = 0; step < buckets.length; step += 1) {
      const bucket = buckets[(step + offset + round) % buckets.length];
      while (bucket.cursor < bucket.items.length) {
        const entry = bucket.items[bucket.cursor];
        bucket.cursor += 1;
        progressed = true;
        const key = channelKey(entry);
        const used = key ? counts.get(key) || 0 : 0;
        if (key && used >= MAX_ITEMS_PER_CHANNEL) {
          backlog.push(entry);
          continue;
        }
        if (key) counts.set(key, used + 1);
        front.push(entry);
        break;
      }
    }
    round += 1;
  }

  return [...front, ...backlog].map(({ _score, ...item }) => item);
}

function deriveRelatedTags(subscriptionResults, subscriptions) {
  const banned = new Set();
  for (const sub of subscriptions) {
    if (sub.channelId) banned.add(String(sub.channelId).toLowerCase());
    const name = String(sub.channel || '')
      .toLowerCase()
      .replace(/^@/, '')
      .replace(/[^\p{L}\p{N}]+/gu, '');
    if (name) banned.add(name);
  }
  const counts = new Map();
  for (const items of subscriptionResults) {
    for (const item of items) {
      for (const tag of tagsFromTitle(item.title).slice(0, 6)) {
        const compact = tag.replace(/[^\p{L}\p{N}]+/gu, '');
        if (compact.length < 3 || banned.has(compact)) continue;
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([tag]) => tag);
}

async function maybeExplore() {
  if (Math.random() > 0.5) return null;
  const tag = EXPLORE_TAGS[Math.floor(Math.random() * EXPLORE_TAGS.length)];
  const items = await feedTagItems(tag, 6).catch(() => []);
  if (!items.length) return null;
  return {
    tag,
    items: items.slice(0, 1).map((item) => ({
      ...item,
      explore: true,
      reason: `Random slop · #${tag}`
    }))
  };
}

async function gather(store, clientId) {
  const profile = store.profile(clientId, { create: false }) || { subscriptions: [], history: [] };
  const prefs = store.preferences(clientId);
  const subscriptions = (profile.subscriptions || []).slice(0, 4);
  const personalized = prefs.length > 0 || subscriptions.length > 0;
  // Always reserve one slot for a rotating seed topic, so the feed keeps
  // surfacing new corners of YouTube instead of only replaying your habits.
  const fresh = nextSeeds(1);
  const prefCount = subscriptions.length ? 3 : 4;
  const prefTags = prefs.slice(0, prefCount).map((p) => p.tag);
  const tags = prefs.length ? [...prefTags, ...fresh] : nextSeeds(subscriptions.length ? 4 : 5);
  const weightFor = (tag) => {
    const found = prefs.find((p) => p.tag === tag);
    return found ? Math.min(2.5, 0.6 + found.score / 12) : 0.55;
  };

  const primaryTags = [...new Set(tags)].slice(0, 5);
  const [subscriptionResults, tagResults] = await Promise.all([
    Promise.all(subscriptions.map((sub) => channelFeedItems(sub, 6).catch(() => []))),
    Promise.all(primaryTags.map((tag) => feedTagItems(tag, 18).catch(() => [])))
  ]);

  const relatedTags = deriveRelatedTags(subscriptionResults, subscriptions);
  const [relatedResults, explore] = await Promise.all([
    Promise.all(relatedTags.map((tag) => feedTagItems(tag, 12).catch(() => []))),
    maybeExplore()
  ]);

  // Prefer a subscription with a real channel id for the headline; legacy
  // entries can carry messy display names.
  const spotlight = subscriptions.find((sub) => sub.channelId) || subscriptions[0];

  const prefSet = new Set(prefTags);
  const groups = [
    ...subscriptionResults.map((items, index) => ({
      items,
      weight: 2.6,
      reason: subscriptions[index]?.channel
        ? `New from @${subscriptions[index].channel}`
        : 'From a channel you subscribed to'
    })),
    ...relatedResults.map((items, index) => ({
      items,
      weight: 1.9,
      reason: spotlight?.channel
        ? `Channels like @${spotlight.channel}`
        : `Because you follow #${relatedTags[index]}`
    })),
    ...tagResults.map((items, index) => ({
      items,
      weight: weightFor(primaryTags[index]),
      reason: prefSet.has(primaryTags[index])
        ? personalized
          ? `Because you like #${primaryTags[index]}`
          : 'Fresh slop'
        : `Fresh slop · #${primaryTags[index]}`
    }))
  ];

  let items = mergeCandidates(groups);

  if (items.length < 6) {
    const extraSeeds = nextSeeds(2);
    const extra = await Promise.all(extraSeeds.map((tag) => feedTagItems(tag, 18).catch(() => [])));
    items = mergeCandidates([
      ...groups,
      ...extra.map((list) => ({
        items: list,
        weight: 0.3,
        reason: 'Fresh slop'
      }))
    ]);
  }

  const now = Date.now();
  const watched = new Set(
    (profile.history || [])
      .filter((video) => now - (video.viewedAt || 0) < RECENT_VIEW_MS)
      .map((video) => video.id)
  );

  items = items.filter((item) => !watched.has(item.id));

  // One wildcard per feed: tastes like the feed but is not derived from it and
  // does not record a view, so it cannot rewire personalization.
  const exploreItem = explore?.items?.[0];
  if (exploreItem && !watched.has(exploreItem.id) && !items.some((item) => item.id === exploreItem.id)) {
    const room = Math.max(1, Math.min(6, items.length - 2));
    const at = Math.min(items.length, 2 + Math.floor(Math.random() * room));
    items.splice(at, 0, exploreItem);
  }

  return {
    items,
    personalized,
    tags: primaryTags,
    subscriptions: subscriptions.length,
    relatedTags,
    reason: personalized
      ? `Tuned to ${
          spotlight?.channel
            ? `@${spotlight.channel}`
            : primaryTags.slice(0, 2).map((tag) => `#${tag}`).join(' · ')
        }`
      : 'Fresh slop · no history yet',
    error: items.length
      ? null
      : 'Could not fetch a feed. YouTube may be blocking this server — try a search or add cookies.'
  };
}

export async function buildFeed(store, clientId, { limit = 18, exclude = [] } = {}) {
  const prefs = store.preferences(clientId);
  const profile = store.profile(clientId, { create: false });
  const signature = `${prefs
    .slice(0, 8)
    .map((p) => p.tag)
    .join(',')}|${(profile?.subscriptions || [])
    .slice(0, 8)
    .map((s) => s.key)
    .join(',')}`;
  let cached = feedCache.get(clientId);
  const stale = !cached || cached.signature !== signature || Date.now() - cached.at > FEED_TTL_MS;

  if (stale) {
    const gathered = await gather(store, clientId);
    cached = { signature, at: Date.now(), ...gathered };
    rememberFeed(clientId, cached);
  }

  const excluded = new Set(exclude);
  let items = cached.items.filter((item) => !excluded.has(item.id));

  if (items.length < 4 && Date.now() - cached.at > 30_000) {
    const gathered = await gather(store, clientId);
    cached = { signature, at: Date.now(), ...gathered };
    rememberFeed(clientId, cached);
    items = cached.items.filter((item) => !excluded.has(item.id));
  }

  return {
    items: items.slice(0, limit),
    reason: cached.reason,
    personalized: cached.personalized,
    tags: cached.tags,
    subscriptions: cached.subscriptions,
    relatedTags: cached.relatedTags,
    error: items.length ? null : cached.error,
    hasMore: items.length > limit
  };
}

export function invalidateFeed(clientId) {
  if (clientId) feedCache.delete(clientId);
  else feedCache.clear();
}
