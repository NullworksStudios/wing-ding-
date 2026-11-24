import { feedTagItems, channelFeedItems, feedSearchItems } from './ytdlp.js';

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
  'art'
];

const FEED_TTL_MS = 5 * 60 * 1000;
const RECENT_VIEW_MS = 6 * 60 * 60 * 1000;

let cachedFeed = null;
let seedCursor = 0;

function nextSeeds(count) {
  const picks = [];
  for (let i = 0; i < count; i += 1) {
    picks.push(SEEDS[(seedCursor + i) % SEEDS.length]);
  }
  seedCursor = (seedCursor + count) % SEEDS.length;
  return picks;
}

function mergeCandidates(groups) {
  const seen = new Set();
  const items = [];
  for (const group of groups) {
    const weight = group.weight || 0;
    group.items.forEach((item, index) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      let score = weight * 2 - index * 0.03 + Math.random() * 0.5;
      if (item.duration != null && item.duration <= 65) score += 0.9;
      if (item.views) score += Math.min(1.8, Math.log10(item.views + 1) / 6.5);
      items.push({
        ...item,
        reason: group.reason,
        _score: score
      });
    });
  }
  items.sort((a, b) => b._score - a._score);
  return items.map(({ _score, ...item }) => item);
}

async function gather(store) {
  const prefs = store.preferences();
  const subscriptions = (store.data.subscriptions || []).slice(0, 3);
  const personalized = prefs.length > 0;
  const primaryCount = subscriptions.length ? 2 : 3;
  const tags = personalized ? prefs.slice(0, primaryCount).map((p) => p.tag) : nextSeeds(primaryCount);
  const weightFor = (tag) => {
    const found = prefs.find((p) => p.tag === tag);
    return found ? Math.min(2.5, 0.6 + found.score / 12) : 0.4;
  };

  const primaryTags = tags.slice(0, primaryCount);
  const tagSet = new Set(primaryTags.map((tag) => tag.toLowerCase()));
  const recentSearches = [...new Set((store.data.searches || []).map((entry) => entry.q).filter(Boolean))]
    .filter((query) => !tagSet.has(query.replace(/^#+/, '').trim().toLowerCase()))
    .slice(0, 2);

  const [results, subscriptionResults, searchResults] = await Promise.all([
    Promise.all(primaryTags.map((tag) => feedTagItems(tag, 24))),
    Promise.all(subscriptions.map((sub) => channelFeedItems(sub, 8).catch(() => []))),
    Promise.all(recentSearches.map((query) => feedSearchItems(query, 8).catch(() => [])))
  ]);
  const groups = [
    ...subscriptionResults.map((items, index) => ({
      items,
      weight: 3.4,
      reason: subscriptions[index]?.channel
        ? `New from @${subscriptions[index].channel}`
        : 'From a channel you subscribed to'
    })),
    ...searchResults.map((items, index) => ({
      items,
      weight: 2.8,
      reason: `Because you searched “${recentSearches[index]}”`
    })),
    ...results.map((items, index) => ({
      items,
      weight: weightFor(primaryTags[index]),
      reason: personalized ? `Because you like #${primaryTags[index]}` : 'Fresh slop'
    }))
  ];

  let items = mergeCandidates(groups);

  if (items.length < 6) {
    const extraSeeds = nextSeeds(2);
    const extra = await Promise.all(extraSeeds.map((tag) => feedTagItems(tag, 18)));
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
    store.data.history
      .filter((video) => now - (video.viewedAt || 0) < RECENT_VIEW_MS)
      .map((video) => video.id)
  );

  items = items.filter((item) => !watched.has(item.id));

  return {
    items,
    personalized,
    tags: primaryTags,
    reason: personalized
      ? `Tuned to ${primaryTags.slice(0, 2).map((tag) => `#${tag}`).join(' · ')}`
      : 'Fresh slop · no history yet',
    error: items.length ? null : 'Could not fetch a feed. YouTube may be blocking this server — try a search or add cookies.'
  };
}

export async function buildFeed(store, { limit = 18, exclude = [] } = {}) {
  const prefs = store.preferences();
  const signature = `${store.revision}|${prefs
    .slice(0, 8)
    .map((p) => p.tag)
    .join(',')}`;
  const stale = !cachedFeed || cachedFeed.signature !== signature || Date.now() - cachedFeed.at > FEED_TTL_MS;

  if (stale) {
    const gathered = await gather(store);
    cachedFeed = { signature, at: Date.now(), ...gathered };
  }

  const excluded = new Set(exclude);
  let items = cachedFeed.items.filter((item) => !excluded.has(item.id));

  if (items.length < 4 && Date.now() - cachedFeed.at > 30_000) {
    const gathered = await gather(store);
    cachedFeed = { signature, at: Date.now(), ...gathered };
    items = cachedFeed.items.filter((item) => !excluded.has(item.id));
  }

  return {
    items: items.slice(0, limit),
    reason: cachedFeed.reason,
    personalized: cachedFeed.personalized,
    tags: cachedFeed.tags,
    error: items.length ? null : cachedFeed.error,
    hasMore: items.length > limit
  };
}

export function invalidateFeed() {
  cachedFeed = null;
}
