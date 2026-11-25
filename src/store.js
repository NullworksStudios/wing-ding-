import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { tagsFromTitle, cleanText, extractVideoId } from './util.js';

const MAX_LIKES = 500;
const MAX_HISTORY = 400;
const MAX_SEARCHES = 150;
const MAX_VIDEOS = 1200;
const MAX_COMMENTS_PER_VIDEO = 2000;
const MAX_SUBSCRIPTIONS = 200;
const MAX_CLIENTS = 500;
const MAX_SHARES = 500;

const SHARE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function emptyProfile() {
  return {
    likes: [],
    history: [],
    searches: [],
    subscriptions: [],
    exports: [],
    updatedAt: Date.now()
  };
}

function emptyData() {
  return {
    clients: {},
    comments: {},
    videos: {},
    shares: {},
    primaryAssigned: false,
    createdAt: Date.now()
  };
}

function videoMeta(input) {
  const id = extractVideoId(input?.id || '');
  if (!id) return null;
  return {
    id,
    title: cleanText(input.title, 300),
    channel: cleanText(input.channel, 120),
    channelId: cleanText(input.channelId, 64),
    channelUrl: typeof input.channelUrl === 'string' && /^https?:\/\//.test(input.channelUrl) ? input.channelUrl : '',
    duration: Number(input.duration) || null,
    thumb:
      typeof input.thumb === 'string' && /^https:\/\//.test(input.thumb)
        ? input.thumb
        : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    tags:
      Array.isArray(input.tags) && input.tags.length
        ? input.tags.slice(0, 10).map((t) => cleanText(t, 30)).filter(Boolean)
        : tagsFromTitle(input.title)
  };
}

function normalizeClientId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{6,64}$/.test(id) ? id : 'default';
}

function nameKey(input) {
  return cleanText(input?.channel, 120).replace(/^@/, '').trim().toLowerCase();
}

function urlKey(input) {
  return String(input?.channelUrl || '')
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '');
}

function subscriptionKey(input) {
  const channelId = cleanText(input?.channelId, 64);
  if (channelId) return `id:${channelId}`;
  const name = nameKey(input);
  if (name) return `name:${name}`;
  const url = urlKey(input);
  if (url) return `url:${url}`;
  return null;
}

function sameChannel(a, b) {
  const aId = cleanText(a?.channelId, 64);
  const bId = cleanText(b?.channelId, 64);
  if (aId && bId && aId === bId) return true;
  const aName = nameKey(a);
  const bName = nameKey(b);
  if (aName && bName && aName === bName) return true;
  const aUrl = urlKey(a);
  const bUrl = urlKey(b);
  return Boolean(aUrl && bUrl && aUrl === bUrl);
}

function shareCode() {
  let code = '';
  for (let i = 0; i < 8; i += 1) code += SHARE_ALPHABET[randomInt(SHARE_ALPHABET.length)];
  return code;
}

export class Store {
  constructor(file, { mongoUri = '', mongoDb = 'huss_huss_slop' } = {}) {
    this.file = file;
    this.mongoUri = String(mongoUri || '').trim();
    this.mongoDb = String(mongoDb || '').trim() || 'huss_huss_slop';
    this.storage = 'json';
    this.client = null;
    this.collection = null;
    this.mongoTimer = null;
    this.mongoChain = Promise.resolve();
    this.revision = 1;
    this.data = emptyData();
    this.load();
  }

  normalize(raw) {
    const parsed = raw && typeof raw === 'object' ? raw : {};
    const legacy = {
      likes: Array.isArray(parsed.likes) ? parsed.likes : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
      searches: Array.isArray(parsed.searches) ? parsed.searches : [],
      subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : []
    };
    const data = { ...emptyData(), ...parsed };
    if (!data.clients || typeof data.clients !== 'object') data.clients = {};
    if (!data.comments || typeof data.comments !== 'object') data.comments = {};
    if (!data.videos || typeof data.videos !== 'object') data.videos = {};
    if (!data.shares || typeof data.shares !== 'object') data.shares = {};
    data.primaryAssigned = Boolean(data.primaryAssigned);

    // Older versions kept a single global profile. Move it intact to the
    // "default" profile so the existing owner keeps their likes and subs.
    if (!data.clients.default) {
      data.clients.default = { ...emptyProfile(), ...legacy };
    }
    delete data.likes;
    delete data.history;
    delete data.searches;
    delete data.subscriptions;
    return data;
  }

  load() {
    try {
      this.data = this.normalize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[store] Could not read database, starting fresh:', error.message);
    }
  }

  // Mongo is the durable backing store on Railway; the local JSON file is
  // still written as a mirror so local dev works with no database.
  async init() {
    if (!this.mongoUri) {
      console.log('[store] Persistence: local JSON (set MONGODB_URI to survive redeploys)');
      return this;
    }
    try {
      const { MongoClient } = await import('mongodb');
      this.client = new MongoClient(this.mongoUri, {
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 8000
      });
      await this.client.connect();
      this.collection = this.client.db(this.mongoDb).collection('state');
      const doc = await this.collection.findOne({ _id: 'state' });
      this.storage = 'mongo';
      if (doc && doc.data) {
        this.data = this.normalize(doc.data);
        console.log('[store] Persistence: MongoDB (loaded saved state)');
      } else {
        await this.flushMongo();
        console.log('[store] Persistence: MongoDB (seeded from local JSON)');
      }
      this.save();
    } catch (error) {
      this.storage = 'json';
      console.warn('[store] MongoDB unavailable, using local JSON:', error.message);
      try {
        await this.client?.close();
      } catch {}
      this.client = null;
      this.collection = null;
    }
    return this;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.data.clients = this.pruneClients(this.data.clients);
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error('[store] Save failed:', error.message);
    }
    this.scheduleMongo();
  }

  scheduleMongo() {
    if (!this.collection) return;
    clearTimeout(this.mongoTimer);
    this.mongoTimer = setTimeout(() => {
      this.mongoTimer = null;
      this.flushMongo();
    }, 400);
    this.mongoTimer.unref?.();
  }

  flushMongo() {
    if (!this.collection) return Promise.resolve();
    const snapshot = structuredClone(this.data);
    const write = this.mongoChain
      .then(() =>
        this.collection.replaceOne(
          { _id: 'state' },
          { _id: 'state', data: snapshot, updatedAt: new Date() },
          { upsert: true }
        )
      )
      .catch((error) => {
        console.warn('[store] MongoDB write failed:', error.message);
      });
    this.mongoChain = write;
    return write;
  }

  async close() {
    if (this.mongoTimer) {
      clearTimeout(this.mongoTimer);
      this.mongoTimer = null;
    }
    await this.flushMongo();
    try {
      await this.client?.close();
    } catch {}
  }

  pruneClients(clients) {
    const entries = Object.entries(clients);
    if (entries.length <= MAX_CLIENTS) return clients;
    entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
    return Object.fromEntries(entries.slice(0, MAX_CLIENTS));
  }

  bump() {
    this.revision += 1;
  }

  profile(clientId, { create = true } = {}) {
    const id = normalizeClientId(clientId);
    let profile = this.data.clients[id];
    if (!profile && create) {
      profile = emptyProfile();
      this.data.clients[id] = profile;
    }
    return profile || null;
  }

  hasClient(clientId) {
    return Boolean(this.data.clients[normalizeClientId(clientId)]);
  }

  claimPrimaryClient() {
    if (this.data.primaryAssigned) return null;
    this.data.primaryAssigned = true;
    this.bump();
    this.save();
    return this.data.clients.default ? 'default' : null;
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

  getLiked(clientId) {
    return this.profile(clientId)?.likes || [];
  }

  isLiked(id, clientId) {
    return this.getLiked(clientId).some((v) => v.id === id);
  }

  addLike(input, clientId) {
    const meta = videoMeta(input) || this.getVideo(input?.id);
    const profile = this.profile(clientId);
    if (!meta || !profile) return { liked: false, error: 'Bad video metadata' };
    profile.likes = profile.likes.filter((v) => v.id !== meta.id);
    profile.likes.unshift({ ...meta, likedAt: Date.now() });
    profile.likes = profile.likes.slice(0, MAX_LIKES);
    profile.updatedAt = Date.now();
    this.rememberVideo(meta);
    this.bump();
    this.save();
    return { liked: true };
  }

  removeLike(id, clientId) {
    const profile = this.profile(clientId);
    if (!profile) return { liked: false };
    const before = profile.likes.length;
    profile.likes = profile.likes.filter((v) => v.id !== id);
    if (profile.likes.length !== before) {
      profile.updatedAt = Date.now();
      this.bump();
      this.save();
    }
    return { liked: false };
  }

  recordView(input, clientId) {
    const meta = videoMeta(input) || this.getVideo(input?.id);
    const profile = this.profile(clientId);
    if (!meta || !profile) return null;
    profile.history = profile.history.filter((v) => v.id !== meta.id);
    profile.history.unshift({ ...meta, viewedAt: Date.now() });
    profile.history = profile.history.slice(0, MAX_HISTORY);
    profile.updatedAt = Date.now();
    this.rememberVideo(meta);
    this.save();
    return meta;
  }

  recordSearch(query, kind, clientId) {
    const q = cleanText(query, 120);
    const profile = this.profile(clientId);
    if (!q || !profile) return;
    profile.searches = profile.searches.filter((s) => s.q.toLowerCase() !== q.toLowerCase());
    profile.searches.unshift({ q, kind: cleanText(kind, 20) || 'auto', at: Date.now() });
    profile.searches = profile.searches.slice(0, MAX_SEARCHES);
    profile.updatedAt = Date.now();
    this.bump();
    this.save();
  }

  recentSearches(clientId, limit = 10) {
    return (this.profile(clientId)?.searches || []).slice(0, limit);
  }

  subscriptions(clientId) {
    return this.profile(clientId)?.subscriptions || [];
  }

  isSubscribed(input, clientId) {
    if (!input) return false;
    return this.subscriptions(clientId).some((sub) => sameChannel(sub, input));
  }

  addSubscription(input, clientId) {
    const key = subscriptionKey(input);
    const profile = this.profile(clientId);
    if (!key || !profile) {
      return { subscribed: false, error: 'That video has no channel info to subscribe to.' };
    }
    const existing = profile.subscriptions.find((sub) => sub.key === key || sameChannel(sub, input));
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
    profile.subscriptions = [
      entry,
      ...profile.subscriptions.filter((sub) => sub.key !== key && !sameChannel(sub, entry))
    ].slice(0, MAX_SUBSCRIPTIONS);
    profile.updatedAt = Date.now();
    this.bump();
    this.save();
    return { subscribed: true, subscription: entry };
  }

  removeSubscription(input, clientId) {
    const profile = this.profile(clientId);
    if (!profile) return { subscribed: false };
    const key = typeof input === 'string' ? input : '';
    const before = profile.subscriptions.length;
    profile.subscriptions = profile.subscriptions.filter((sub) => {
      if (key && sub.key === key) return false;
      if (!key && sameChannel(sub, input)) return false;
      return true;
    });
    if (profile.subscriptions.length !== before) {
      profile.updatedAt = Date.now();
      this.bump();
      this.save();
    }
    return { subscribed: false };
  }

  // oEmbed can fill in a channel that yt-dlp left blank. Persist that so the
  // like survives with its channel link and future subscribe presses work.
  hydrateLiked(items, clientId) {
    const profile = this.profile(clientId, { create: false });
    if (!profile || !Array.isArray(items) || !items.length) return;
    const byId = new Map(items.map((item) => [item.id, item]));
    let changed = false;
    profile.likes = profile.likes.map((like) => {
      const fresh = byId.get(like.id);
      if (!fresh) return like;
      const merged = {
        ...like,
        channel: like.channel || fresh.channel || '',
        channelId: like.channelId || fresh.channelId || '',
        channelUrl: like.channelUrl || fresh.channelUrl || ''
      };
      if (
        merged.channel !== like.channel ||
        merged.channelId !== like.channelId ||
        merged.channelUrl !== like.channelUrl
      ) {
        changed = true;
        this.rememberVideo(merged);
        return merged;
      }
      return like;
    });
    if (changed) {
      profile.updatedAt = Date.now();
      this.save();
    }
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

  preferences(clientId) {
    const profile = this.profile(clientId);
    if (!profile) return [];
    const scores = new Map();
    const bump = (tag, weight) => {
      const t = String(tag).toLowerCase().trim();
      if (t.length < 2 || t.length > 30) return;
      scores.set(t, (scores.get(t) || 0) + weight);
    };
    const tagsOf = (video) => (Array.isArray(video.tags) && video.tags.length ? video.tags : tagsFromTitle(video.title));

    for (const video of profile.likes.slice(0, 80)) {
      for (const tag of tagsOf(video).slice(0, 8)) bump(tag, 3);
      if (video.channel) bump(`channel:${video.channel.toLowerCase()}`, 0.5);
    }
    for (const search of profile.searches.slice(0, 40)) {
      const words = tagsFromTitle(search.q);
      for (const tag of words.slice(0, 5)) bump(tag, 1.6);
      for (const tag of words.slice(0, 3)) bump(tag, 0.8);
    }
    for (const video of profile.history.slice(0, 120)) {
      for (const tag of tagsOf(video).slice(0, 6)) bump(tag, 0.8);
    }

    return [...scores.entries()]
      .filter(([tag]) => !tag.startsWith('channel:'))
      .map(([tag, score]) => ({ tag, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }

  stats(clientId) {
    const profile = clientId ? this.profile(clientId) : null;
    return {
      likes: profile ? profile.likes.length : 0,
      history: profile ? profile.history.length : 0,
      searches: profile ? profile.searches.length : 0,
      subscriptions: profile ? profile.subscriptions.length : 0,
      clients: Object.keys(this.data.clients).length,
      comments: Object.values(this.data.comments).reduce(
        (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
        0
      )
    };
  }

  createShare(clientId, { name = '', snapshot } = {}) {
    const profile = this.profile(clientId);
    if (!profile) return null;
    const code = shareCode();
    const label = cleanText(name, 40) || 'My slop feed';
    this.data.shares[code] = {
      code,
      name: label,
      createdAt: Date.now(),
      snapshot: {
        likes: (snapshot?.likes || profile.likes).slice(0, 80),
        searches: (snapshot?.searches || profile.searches).slice(0, 40),
        subscriptions: (snapshot?.subscriptions || profile.subscriptions).slice(0, 50)
      }
    };
    profile.exports = Array.isArray(profile.exports) ? profile.exports : [];
    profile.exports = [
      { code, name: label, at: Date.now() },
      ...profile.exports.filter((entry) => entry.code !== code)
    ].slice(0, 20);
    const entries = Object.entries(this.data.shares);
    if (entries.length > MAX_SHARES) {
      entries.sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
      this.data.shares = Object.fromEntries(entries.slice(0, MAX_SHARES));
    }
    this.bump();
    this.save();
    return this.data.shares[code];
  }

  exports(clientId) {
    const profile = this.profile(clientId, { create: false });
    return Array.isArray(profile?.exports) ? profile.exports : [];
  }

  removeExport(clientId, code) {
    const profile = this.profile(clientId, { create: false });
    if (!profile || !Array.isArray(profile.exports)) return { removed: false };
    const before = profile.exports.length;
    profile.exports = profile.exports.filter((entry) => entry.code !== code);
    if (profile.exports.length !== before) {
      profile.updatedAt = Date.now();
      this.bump();
      this.save();
    }
    return { removed: profile.exports.length !== before };
  }

  getShare(code) {
    const key = String(code || '').trim().toLowerCase();
    if (!key) return null;
    return this.data.shares[key] || null;
  }

  allShares(limit = 100) {
    return Object.values(this.data.shares)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, limit)
      .map((share) => ({
        code: share.code,
        name: share.name || '',
        createdAt: share.createdAt,
        counts: {
          likes: share.snapshot.likes.length,
          searches: share.snapshot.searches.length,
          subscriptions: share.snapshot.subscriptions.length
        }
      }));
  }

  // Imports accept either the 8-character code or the feed name given at
  // export time. Names are easier to read out loud and retype on another PC.
  findShare(value) {
    const key = String(value || '').trim().toLowerCase();
    if (!key) return null;
    const byCode = this.data.shares[key];
    if (byCode) return byCode;
    const named = Object.values(this.data.shares).filter(
      (share) => String(share.name || '').trim().toLowerCase() === key
    );
    if (!named.length) return null;
    named.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return named[0];
  }

  importShare(clientId, share) {
    const profile = this.profile(clientId);
    if (!profile || !share?.snapshot) return { imported: false };
    const snapshot = share.snapshot;
    profile.likes = Array.isArray(snapshot.likes) ? snapshot.likes.slice(0, MAX_LIKES) : [];
    profile.searches = Array.isArray(snapshot.searches) ? snapshot.searches.slice(0, MAX_SEARCHES) : [];
    profile.subscriptions = Array.isArray(snapshot.subscriptions)
      ? snapshot.subscriptions.slice(0, MAX_SUBSCRIPTIONS)
      : [];
    profile.history = [];
    profile.lastImport = { code: share.code, name: share.name || '', at: Date.now() };
    profile.updatedAt = Date.now();
    this.bump();
    this.save();
    return {
      imported: true,
      name: share.name || '',
      likes: profile.likes.length,
      searches: profile.searches.length,
      subscriptions: profile.subscriptions.length
    };
  }
}
