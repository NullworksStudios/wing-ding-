import fs from 'node:fs';
import path from 'node:path';
import { tagsFromTitle, cleanText, extractVideoId } from './util.js';

const MAX_LIKES = 500;
const MAX_HISTORY = 400;
const MAX_SEARCHES = 150;
const MAX_VIDEOS = 1200;
const MAX_COMMENTS_PER_VIDEO = 300;
const MAX_SUBSCRIPTIONS = 200;

function emptyData() {
  return {
    likes: [],
    history: [],
    searches: [],
    comments: {},
    videos: {},
    subscriptions: [],
    createdAt: Date.now()
  };
}

function subscriptionKey(input) {
  const channelId = cleanText(input?.channelId, 64);
  if (channelId) return `id:${channelId}`;
  const channel = cleanText(input?.channel, 120).replace(/^@/, '').trim().toLowerCase();
  if (channel) return `name:${channel}`;
  const channelUrl = String(input?.channelUrl || '').trim().toLowerCase();
  if (channelUrl) return `url:${channelUrl}`;
  return null;
}

function videoMeta(input) {
  const id = extractVideoId(input?.id || '');
  if (!id) return null;
  return {
    id,
    title: cleanText(input.title, 300),
    channel: cleanText(input.channel, 120),
    channelId: cleanText(input.channelId, 64),
    duration: Number(input.duration) || null,
    thumb: typeof input.thumb === 'string' && /^https:\/\//.test(input.thumb) ? input.thumb : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    tags: Array.isArray(input.tags) && input.tags.length ? input.tags.slice(0, 10).map((t) => cleanText(t, 30)).filter(Boolean) : tagsFromTitle(input.title)
  };
}

export class Store {
  constructor(file) {
    this.file = file;
    this.revision = 1;
    this.data = emptyData();
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...emptyData(), ...parsed };
      if (!Array.isArray(this.data.likes)) this.data.likes = [];
      if (!Array.isArray(this.data.history)) this.data.history = [];
      if (!Array.isArray(this.data.searches)) this.data.searches = [];
      if (!this.data.comments || typeof this.data.comments !== 'object') this.data.comments = {};
      if (!this.data.videos || typeof this.data.videos !== 'object') this.data.videos = {};
      if (!Array.isArray(this.data.subscriptions)) this.data.subscriptions = [];
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[store] Could not read database, starting fresh:', error.message);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error('[store] Save failed:', error.message);
    }
  }

  bump() {
    this.revision += 1;
  }

  rememberVideo(input) {
    const meta = videoMeta(input);
    if (!meta) return null;
    const existing = this.data.videos[meta.id] || {};
    this.data.videos[meta.id] = { ...existing, ...meta, seenAt: Date.now() };
    const entries = Object.entries(this.data.videos);
    if (entries.length > MAX_VIDEOS) {
      entries.sort((a, b) => (b[1].seenAt || 0) - (a[1].seenAt || 0));
      this.data.videos = Object.fromEntries(entries.slice(0, MAX_VIDEOS));
    }
    return this.data.videos[meta.id];
  }

  getVideo(id) {
    return this.data.videos[id] || null;
  }

  isLiked(id) {
    return this.data.likes.some((v) => v.id === id);
  }

  addLike(input) {
    const meta = videoMeta(input) || this.getVideo(input?.id);
    if (!meta) return { liked: false, error: 'Bad video metadata' };
    this.data.likes = this.data.likes.filter((v) => v.id !== meta.id);
    this.data.likes.unshift({ ...meta, likedAt: Date.now() });
    this.data.likes = this.data.likes.slice(0, MAX_LIKES);
    this.rememberVideo(meta);
    this.bump();
    this.save();
    return { liked: true };
  }

  removeLike(id) {
    const before = this.data.likes.length;
    this.data.likes = this.data.likes.filter((v) => v.id !== id);
    if (this.data.likes.length !== before) {
      this.bump();
      this.save();
    }
    return { liked: false };
  }

  isSubscribed(input) {
    const key = subscriptionKey(input);
    if (!key) return false;
    return this.data.subscriptions.some((sub) => sub.key === key);
  }

  addSubscription(input) {
    const key = subscriptionKey(input);
    if (!key) return { subscribed: false, error: 'That video has no channel info to subscribe to.' };
    const existing = this.data.subscriptions.find((sub) => sub.key === key);
    const entry = {
      key,
      channel: cleanText(input.channel, 120).replace(/^@/, '') || existing?.channel || '',
      channelId: cleanText(input.channelId, 64) || existing?.channelId || '',
      channelUrl:
        typeof input.channelUrl === 'string' && /^https?:\/\//.test(input.channelUrl)
          ? input.channelUrl
          : existing?.channelUrl || '',
      addedAt: existing?.addedAt || Date.now()
    };
    if (!entry.channel) entry.channel = entry.channelId || entry.channelUrl;
    this.data.subscriptions = [entry, ...this.data.subscriptions.filter((sub) => sub.key !== key)].slice(
      0,
      MAX_SUBSCRIPTIONS
    );
    this.bump();
    this.save();
    return { subscribed: true, subscription: entry };
  }

  removeSubscription(input) {
    const key = typeof input === 'string' && /^(id|name|url):/i.test(input) ? input : subscriptionKey(input);
    if (!key) return { subscribed: false };
    const before = this.data.subscriptions.length;
    this.data.subscriptions = this.data.subscriptions.filter((sub) => sub.key !== key);
    if (this.data.subscriptions.length !== before) {
      this.bump();
      this.save();
    }
    return { subscribed: false };
  }

  recordView(input) {
    const meta = videoMeta(input) || this.getVideo(input?.id);
    if (!meta) return null;
    this.data.history = this.data.history.filter((v) => v.id !== meta.id);
    this.data.history.unshift({ ...meta, viewedAt: Date.now() });
    this.data.history = this.data.history.slice(0, MAX_HISTORY);
    this.rememberVideo(meta);
    this.save();
    return meta;
  }

  recordSearch(query, kind) {
    const q = cleanText(query, 120);
    if (!q) return;
    this.data.searches = this.data.searches.filter((s) => s.q.toLowerCase() !== q.toLowerCase());
    this.data.searches.unshift({ q, kind: cleanText(kind, 20) || 'auto', at: Date.now() });
    this.data.searches = this.data.searches.slice(0, MAX_SEARCHES);
    this.bump();
    this.save();
  }

  recentSearches(limit = 10) {
    return this.data.searches.slice(0, limit);
  }

  getComments(id) {
    const list = this.data.comments[id];
    return Array.isArray(list) ? list : [];
  }

  commentCount(id) {
    return this.getComments(id).length;
  }

  addComment(id, name, text) {
    const comment = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: cleanText(name, 32) || 'anon',
      text: cleanText(text, 600),
      at: Date.now()
    };
    if (!comment.text) return null;
    const list = this.getComments(id).slice();
    list.unshift(comment);
    if (list.length > MAX_COMMENTS_PER_VIDEO) list.length = MAX_COMMENTS_PER_VIDEO;
    this.data.comments[id] = list;
    this.save();
    return comment;
  }

  preferences() {
    const scores = new Map();
    const bump = (tag, weight) => {
      const t = String(tag).toLowerCase().trim();
      if (t.length < 2 || t.length > 30) return;
      scores.set(t, (scores.get(t) || 0) + weight);
    };
    const tagsOf = (video) => (Array.isArray(video.tags) && video.tags.length ? video.tags : tagsFromTitle(video.title));

    for (const video of this.data.likes.slice(0, 80)) {
      for (const tag of tagsOf(video).slice(0, 8)) bump(tag, 3);
      if (video.channel) bump(`channel:${video.channel.toLowerCase()}`, 0.5);
    }
    for (const search of this.data.searches.slice(0, 40)) {
      const words = tagsFromTitle(search.q);
      for (const tag of words.slice(0, 5)) bump(tag, 1.6);
      for (const tag of words.slice(0, 3)) bump(tag, 0.8);
    }
    for (const video of this.data.history.slice(0, 120)) {
      for (const tag of tagsOf(video).slice(0, 6)) bump(tag, 0.8);
    }

    return [...scores.entries()]
      .filter(([tag]) => !tag.startsWith('channel:'))
      .map(([tag, score]) => ({ tag, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }

  stats() {
    return {
      likes: this.data.likes.length,
      history: this.data.history.length,
      searches: this.data.searches.length,
      comments: Object.values(this.data.comments).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0)
    };
  }
}
