const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const player = $('#player');
const feedState = $('#feedState');
const feedStateTitle = $('#feedStateTitle');
const feedStateText = $('#feedStateText');
const feedStateActions = $('#feedStateActions');
const feedStateOrb = $('.loader-orb', feedState);
const feedRetryBtn = $('#feedRetryBtn');
const backFab = $('#backFab');
const playerEnd = $('#playerEnd');
const authPill = $('#authPill');
const searchForm = $('#searchForm');
const searchInput = $('#searchInput');
const searchGo = $('#searchGo');
const searchResults = $('#searchResults');
const searchStatus = $('#searchStatus');
const recentWrap = $('#recentWrap');
const recentChips = $('#recentChips');
const likedResults = $('#likedResults');
const likedStatus = $('#likedStatus');
const subsResults = $('#subsResults');
const subsStatus = $('#subsStatus');
const commentsSheet = $('#commentsSheet');
const commentList = $('#commentList');
const commentCount = $('#commentCount');
const commentForm = $('#commentForm');
const commentName = $('#commentName');
const commentText = $('#commentText');
const toastEl = $('#toast');

const state = {
  view: 'feed',
  mode: 'feed',
  items: [],
  index: 0,
  muted: localStorage.getItem('hhl.muted') !== '0',
  nickname: localStorage.getItem('hhl.name') || '',
  searchKind: 'auto',
  searchBusy: false,
  feedBusy: false,
  feedEnd: false,
  backView: 'search',
  recent: [],
  engine: null,
  commentsItem: null,
  likedDirty: true,
  subsDirty: true,
  feedDirty: false,
  viewTimer: null
};

let slides = [];
let toastTimer = null;

const observer = new IntersectionObserver(
  (entries) => {
    if (state.view !== 'feed') return;
    const visible = entries
      .filter((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.55)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    const index = Number(visible.target.dataset.index);
    if (!Number.isFinite(index)) return;
    if (index !== state.index) activate(index);
  },
  { root: player, threshold: [0.55, 0.75] }
);

/* ---------------- api ---------------- */

async function api(path, { method = 'GET', body, signal, timeout = 150_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const abort = () => controller.abort();
  if (signal) signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('That took too long. Try again.');
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abort);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- helpers ---------------- */

function fmtViews(views) {
  const n = Number(views);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B views`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M views`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K views`;
  return `${n} views`;
}

function fmtDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '';
  if (s < 60) return `0:${String(Math.round(s)).padStart(2, '0')}`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return `${m}:${String(rest).padStart(2, '0')}`;
}

function timeAgo(timestamp) {
  const seconds = Math.max(0, (Date.now() - Number(timestamp || 0)) / 1000);
  if (seconds < 45) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return `${Math.floor(seconds / 604800)}w`;
}

function meta(item) {
  return {
    title: item.title || '',
    channel: item.channel || '',
    channelId: item.channelId || '',
    duration: item.duration || null,
    thumb: item.thumb || ''
  };
}

function channelIdentity(item) {
  if (!item) return '';
  if (item.channelId) return `id:${item.channelId}`;
  if (item.channel) return `name:${item.channel.replace(/^@/, '').trim().toLowerCase()}`;
  if (item.channelUrl) return `url:${String(item.channelUrl).toLowerCase()}`;
  return '';
}

function toast(message, isError = false) {
  if (!message) return;
  toastEl.textContent = message;
  toastEl.classList.toggle('error', Boolean(isError));
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2800);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/* ---------------- views ---------------- */

function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  $$('.view').forEach((section) => {
    section.classList.toggle('is-active', section.id === `view-${view}`);
  });
  $$('.tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.view === view);
  });
  if (view !== 'feed') {
    pauseActive();
    if (view === 'search') loadStatus();
    if (view === 'subs') loadSubs();
    if (view === 'liked') loadLiked();
  }
}

function pauseActive() {
  clearTimeout(state.viewTimer);
  const slide = slides[state.index];
  const video = slide?.querySelector('video');
  if (video && !video.paused) video.pause();
}

function updateBack() {
  backFab.hidden = state.mode === 'feed';
  if (state.mode !== 'feed' && state.index >= state.items.length - 1) {
    playerEnd.textContent = 'End of results · hit Back';
    playerEnd.hidden = false;
  } else if (state.mode === 'feed' && state.feedEnd && state.index >= state.items.length - 1) {
    playerEnd.textContent = "That's all the slop for now";
    playerEnd.hidden = false;
  } else {
    playerEnd.hidden = true;
  }
}

/* ---------------- slide creation ---------------- */

const ICONS = {
  like:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.4s-7.2-4.4-9.3-8.7C.8 8 2.7 4.4 6.2 4c2-.2 3.9.8 4.8 2.5.9-1.7 2.8-2.7 4.8-2.5 3.5.4 5.4 4 3.5 7.7-2.1 4.3-9.3 8.7-9.3 8.7z"/></svg>',
  comment:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9.2 8.4 9 9 0 0 1-3.3-.7L3 21l1.8-4.5A8.4 8.4 0 1 1 21 11.5z"/></svg>',
  sound:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.1L12 5.5v13l-4.9-4H4z"/><path class="wave" d="M15.4 8.6a4.8 4.8 0 0 1 0 6.8"/><path class="wave" d="M18 6a8.4 8.4 0 0 1 0 12"/><path class="slash" d="M4 4l16 16"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>'
};

function createSlide(item, index) {
  const slide = document.createElement('article');
  slide.className = 'slide';
  slide.dataset.index = String(index);
  slide.dataset.id = item.id;
  slide.dataset.ready = '0';
  slide.dataset.loading = '0';
  slide.innerHTML = `
    <div class="video-wrap">
      <div class="slide-bg"></div>
      <video playsinline loop preload="none"></video>
      <div class="video-status">
        <span class="spinner"></span>
        <span class="status-text">Queued…</span>
        <button type="button" class="retry" hidden>Retry</button>
      </div>
      <button type="button" class="bigplay" aria-label="Play">▶</button>
    </div>
    <div class="slide-shade"></div>
    <div class="slide-meta">
      <div class="reason"></div>
      <div class="channel-row">
        <div class="channel"></div>
        <button type="button" class="sub-btn" hidden>Subscribe</button>
      </div>
      <h2 class="title"></h2>
      <div class="meta-row"><span class="quality"></span><span class="views"></span></div>
    </div>
    <div class="actions">
      <button type="button" class="act like" data-liked="0" aria-label="Like">
        ${ICONS.like}<span class="act-label">Like</span>
      </button>
      <button type="button" class="act comment" aria-label="Comments">
        ${ICONS.comment}<span class="act-label">Talk</span>
      </button>
      <button type="button" class="act sound" aria-label="Toggle sound">
        ${ICONS.sound}<span class="act-label">Sound</span>
      </button>
      <a class="act openyt" href="${item.url || `https://www.youtube.com/shorts/${item.id}`}" target="_blank" rel="noopener noreferrer" aria-label="Open on YouTube">
        ${ICONS.open}<span class="act-label">Open</span>
      </a>
    </div>
    <div class="progress-rail"><span></span></div>
  `;

  const video = $('video', slide);
  video.poster = item.thumb || '';
  video.muted = state.muted;
  const background = $('.slide-bg', slide);
  if (item.thumb) background.style.backgroundImage = `url("${item.thumb.replace(/"/g, '%22')}")`;
  if (state.muted) slide.querySelector('.sound').classList.add('muted');

  if (item.title) $('.title', slide).textContent = item.title;
  const channel = $('.channel', slide);
  if (item.channel) channel.textContent = item.channel.startsWith('@') ? item.channel : `@${item.channel.replace(/^@/, '')}`;
  else if (item.channelId) channel.textContent = 'YouTube channel';
  if (item.channel || item.channelId) {
    $('.sub-btn', slide).hidden = false;
    setSubUI(slide, Boolean(item.subscribed));
  }
  const reason = $('.reason', slide);
  if (item.reason) reason.textContent = item.reason;
  const views = $('.views', slide);
  if (item.views) views.textContent = fmtViews(item.views);
  if (item.duration) {
    const duration = document.createElement('span');
    duration.textContent = fmtDuration(item.duration);
    $('.meta-row', slide).prepend(duration);
  }
  if (item.liked) setLikeUI(slide, true);
  if (item.comments) setCommentUI(slide, item.comments);

  video.addEventListener('loadedmetadata', () => {
    slide.classList.toggle('landscape', video.videoWidth > video.videoHeight * 1.04);
  });
  video.addEventListener('play', () => slide.classList.remove('paused'));
  video.addEventListener('pause', () => {
    if (state.view === 'feed' && Number(slide.dataset.index) === state.index) slide.classList.add('paused');
  });
  video.addEventListener('timeupdate', () => {
    const rail = $('.progress-rail span', slide);
    if (!rail || !Number.isFinite(video.duration) || video.duration <= 0) return;
    rail.style.width = `${Math.min(100, (video.currentTime / video.duration) * 100)}%`;
  });
  video.addEventListener('error', () => {
    if (slide.dataset.ready === '1' && video.src) showSlideError(slide, 'Playback failed. Tap retry.');
  });

  observer.observe(slide);
  return slide;
}

function appendSlides(items) {
  for (const item of items) {
    const index = state.items.length;
    state.items.push(item);
    const slide = createSlide(item, index);
    slides.push(slide);
    player.appendChild(slide);
  }
}

function removeAllSlides() {
  observer.disconnect();
  player.innerHTML = '';
  slides = [];
}

/* ---------------- activation / playback ---------------- */

function activate(index, { force = false } = {}) {
  if (!state.items[index]) return;
  if (state.view !== 'feed') setView('feed');
  const previous = slides[state.index];
  const next = slides[index];
  if (previous && previous !== next) {
    const oldVideo = previous.querySelector('video');
    if (oldVideo) oldVideo.pause();
  }
  state.index = index;
  updateBack();
  prepareMedia(index);
  scheduleView(index);
  if (index + 1 < state.items.length) prefetch(index + 1);
  if (state.mode === 'feed' && !state.feedEnd && index >= state.items.length - 4) loadFeed(false);
  if (force && next) {
    const video = next.querySelector('video');
    if (video && video.src) playSlide(next);
  }
}

function scrollToIndex(index, smooth = true) {
  const top = index * player.clientHeight;
  player.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
}

function playSlide(slide) {
  const video = slide?.querySelector('video');
  if (!video || !video.src) return;
  video.muted = state.muted;
  const promise = video.play();
  if (promise?.catch) promise.catch(() => slide.classList.add('paused'));
}

function togglePlay(slide) {
  const video = slide?.querySelector('video');
  if (!video) return;
  if (video.paused) playSlide(slide);
  else video.pause();
}

function scheduleView(index) {
  clearTimeout(state.viewTimer);
  state.viewTimer = setTimeout(() => {
    if (state.index !== index || state.view !== 'feed') return;
    const slide = slides[index];
    const video = slide?.querySelector('video');
    if (!video || video.paused) return;
    const item = state.items[index];
    if (!item || item.viewed) return;
    item.viewed = true;
    api(`/api/video/${item.id}/view`, { method: 'POST', body: meta(item) }).catch(() => {});
  }, 3200);
}

async function prefetch(index) {
  const item = state.items[index];
  if (!item || item.prefetched) return;
  item.prefetched = true;
  try {
    const job = await api(`/api/video/${item.id}`, {
      method: 'POST',
      body: { ...meta(item), priority: false },
      timeout: 20_000
    });
    if (job?.status === 'error') item.prefetched = false;
  } catch {
    item.prefetched = false;
  }
}

/* ---------------- media pipeline ---------------- */

function setStatus(slide, text, { spinner = true, retry = false } = {}) {
  const status = $('.video-status', slide);
  if (!status) return;
  status.hidden = false;
  $('.status-text', status).textContent = text;
  $('.spinner', status).hidden = !spinner;
  $('.retry', status).hidden = !retry;
  slide.classList.toggle('has-error', retry);
}

function showSlideError(slide, message) {
  slide.classList.remove('is-ready');
  slide.dataset.ready = '0';
  slide.dataset.loading = '0';
  setStatus(slide, message || 'Could not load this one.', { spinner: false, retry: true });
}

function updateJobUI(slide, job) {
  const quality = $('.quality', slide);
  if (quality) quality.textContent = job.quality ? `${job.quality}p` : '';
  if (job.status === 'downloading') {
    const percent = job.progress > 0 ? ` ${job.progress}%` : '';
    setStatus(slide, `Fetching${job.quality ? ` ${job.quality}p` : ''}…${percent}`);
  } else if (job.status === 'queued') {
    setStatus(slide, 'Queued…');
  }
  if (job.note && job.status === 'downloading') {
    const status = $('.status-text', slide);
    if (status) status.textContent = job.note;
  }
}

async function prepareMedia(index) {
  const slide = slides[index];
  const item = state.items[index];
  if (!slide || !item) return;

  if (slide.dataset.ready === '1') {
    if (state.index === index) playSlide(slide);
    return;
  }
  if (slide.dataset.loading === '1') return;

  slide.dataset.loading = '1';
  setStatus(slide, 'Queued…');

  try {
    let job = await api(`/api/video/${item.id}`, {
      method: 'POST',
      body: { ...meta(item), priority: true }
    });
    updateJobUI(slide, job);
    if (typeof job.liked === 'boolean') setLikeUI(slide, job.liked);
    if (typeof job.comments === 'number') setCommentUI(slide, job.comments);

    while (job.status === 'queued' || job.status === 'downloading') {
      await sleep(950);
      if (!slide.isConnected) return;
      job = await api(`/api/video/${item.id}/status`);
      if (!slide.isConnected) return;
      updateJobUI(slide, job);
    }

    if (job.status === 'ready') {
      slide.dataset.ready = '1';
      slide.classList.add('is-ready');
      const video = $('video', slide);
      video.src = `/api/video/${item.id}/file`;
      video.load();
      if (state.index === index) playSlide(slide);
      video.addEventListener(
        'canplay',
        () => {
          if (state.index === index) playSlide(slide);
        },
        { once: true }
      );
      if (typeof job.liked === 'boolean') setLikeUI(slide, job.liked);
      if (typeof job.comments === 'number') setCommentUI(slide, job.comments);
    } else {
      showSlideError(slide, job.error || 'Download failed.');
    }
  } catch (error) {
    if (slide.isConnected) showSlideError(slide, error.message || 'Network error.');
  } finally {
    slide.dataset.loading = '0';
  }
}

/* ---------------- likes / comments UI ---------------- */

function setLikeUI(slide, liked) {
  const button = slide?.querySelector('.like');
  if (!button) return;
  button.dataset.liked = liked ? '1' : '0';
  button.classList.toggle('on', Boolean(liked));
  $('.act-label', button).textContent = liked ? 'Liked' : 'Like';
}

function setCommentUI(slide, count) {
  const button = slide?.querySelector('.comment');
  if (!button) return;
  $('.act-label', button).textContent = count > 0 ? String(count) : 'Talk';
}

function setCommentUIById(id, count) {
  slides.forEach((slide) => {
    if (slide.dataset.id === id) setCommentUI(slide, count);
  });
  if (state.commentsItem?.id === id) commentCount.textContent = String(count);
}

function setSubUI(slide, subscribed) {
  const button = slide?.querySelector('.sub-btn');
  if (!button) return;
  button.dataset.subscribed = subscribed ? '1' : '0';
  button.classList.toggle('on', Boolean(subscribed));
  button.textContent = subscribed ? 'Subscribed' : 'Subscribe';
}

function setSubUIByIdentity(identity, subscribed) {
  if (!identity) return;
  slides.forEach((slide) => {
    const item = state.items[Number(slide.dataset.index)];
    if (item && channelIdentity(item) === identity) {
      item.subscribed = subscribed;
      setSubUI(slide, subscribed);
    }
  });
}

async function setSubscription(target, subscribe) {
  const identity = channelIdentity(target);
  if (!identity) {
    toast('That short has no channel info.', true);
    return;
  }
  const body = {
    channel: target.channel || '',
    channelId: target.channelId || '',
    channelUrl: target.channelUrl || '',
    subscribed: Boolean(subscribe)
  };
  try {
    const result = await api('/api/subscriptions', { method: 'POST', body });
    setSubUIByIdentity(identity, Boolean(result.subscribed));
    state.subsDirty = true;
    state.feedDirty = true;
    if (result.subscribed) {
      toast(`Subscribed to ${target.channel ? `@${target.channel.replace(/^@/, '')}` : 'channel'} — feed updated`);
    } else {
      toast('Unsubscribed');
    }
    return result;
  } catch (error) {
    toast(error.message, true);
    return null;
  }
}

async function toggleSubscription(index) {
  const item = state.items[index];
  if (!item) return;
  await setSubscription(item, !item.subscribed);
}

async function toggleLike(index) {
  const item = state.items[index];
  const slide = slides[index];
  if (!item || !slide) return;
  const button = slide.querySelector('.like');
  if (button.dataset.busy === '1') return;
  button.dataset.busy = '1';
  const liked = button.dataset.liked === '1';
  try {
    const result = await api(`/api/video/${item.id}/like`, {
      method: liked ? 'DELETE' : 'POST',
      body: liked ? undefined : meta(item)
    });
    item.liked = result.liked;
    setLikeUI(slide, result.liked);
    state.likedDirty = true;
    if (result.liked) toast('Saved to liked slop');
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.dataset.busy = '0';
  }
}

function renderComments(comments) {
  commentList.innerHTML = '';
  if (!comments.length) {
    const empty = document.createElement('div');
    empty.className = 'comment-empty';
    empty.textContent = 'No slop talk yet. Be the first.';
    commentList.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const comment of comments) {
    const row = document.createElement('div');
    row.className = 'comment';
    row.innerHTML = `
      <div class="comment-avatar"></div>
      <div class="comment-body">
        <div class="comment-top"><span class="comment-name"></span><span class="comment-time"></span></div>
        <div class="comment-text"></div>
      </div>
    `;
    row.querySelector('.comment-avatar').textContent = (comment.name || '?').slice(0, 1);
    row.querySelector('.comment-name').textContent = comment.name || 'anon';
    row.querySelector('.comment-time').textContent = timeAgo(comment.at);
    row.querySelector('.comment-text').textContent = comment.text;
    fragment.appendChild(row);
  }
  commentList.appendChild(fragment);
}

async function openComments(item) {
  if (!item) return;
  state.commentsItem = item;
  commentCount.textContent = '0';
  commentText.value = '';
  commentName.value = state.nickname || '';
  commentList.innerHTML = '<div class="comment-empty">Loading chatter…</div>';
  commentsSheet.hidden = false;
  document.body.classList.add('sheet-open');
  setTimeout(() => commentText.focus(), 120);
  try {
    const data = await api(`/api/video/${item.id}/comments`);
    commentCount.textContent = String(data.count || 0);
    setCommentUIById(item.id, data.count || 0);
    renderComments(data.comments || []);
  } catch (error) {
    commentList.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'comment-empty';
    empty.textContent = error.message;
    commentList.appendChild(empty);
  }
}

function closeComments() {
  commentsSheet.hidden = true;
  document.body.classList.remove('sheet-open');
  state.commentsItem = null;
}

async function submitComment(event) {
  event.preventDefault();
  const item = state.commentsItem;
  if (!item) return;
  const text = commentText.value.trim();
  if (!text) {
    commentText.focus();
    return;
  }
  const name = commentName.value.trim() || 'anon';
  state.nickname = name;
  localStorage.setItem('hhl.name', name);
  const sendBtn = $('button.send', commentForm);
  sendBtn.disabled = true;
  try {
    const data = await api(`/api/video/${item.id}/comments`, {
      method: 'POST',
      body: { name, text }
    });
    commentText.value = '';
    commentCount.textContent = String(data.count || 0);
    setCommentUIById(item.id, data.count || 0);
    const latest = await api(`/api/video/${item.id}/comments`);
    renderComments(latest.comments || []);
  } catch (error) {
    toast(error.message, true);
  } finally {
    sendBtn.disabled = false;
    commentText.focus();
  }
}

/* ---------------- feed ---------------- */

function showFeedState({ title, text, loading = false, actions = false, retry = true }) {
  feedState.hidden = false;
  feedStateOrb.hidden = !loading;
  feedStateTitle.textContent = title || '';
  feedStateText.textContent = text || '';
  feedStateActions.hidden = !actions;
  feedRetryBtn.hidden = !retry;
}

function hideFeedState() {
  feedState.hidden = true;
}

async function loadFeed(reset = true) {
  if (state.feedBusy) return;
  state.feedBusy = true;

  if (reset) {
    setView('feed');
    state.mode = 'feed';
    state.index = 0;
    state.feedEnd = false;
    state.feedDirty = false;
    state.items = [];
    removeAllSlides();
    playerEnd.hidden = true;
    backFab.hidden = true;
    showFeedState({
      title: 'Farming slop…',
      text: 'Warming up the yt-dlp machine.',
      loading: true
    });
  }

  try {
    const exclude = state.items
      .slice(-60)
      .map((item) => item.id)
      .join(',');
    const data = await api(`/api/feed?limit=18${exclude ? `&exclude=${encodeURIComponent(exclude)}` : ''}`, {
      timeout: 90_000
    });
    if (reset) {
      state.items = [];
      removeAllSlides();
    }
    const existing = new Set(state.items.map((item) => item.id));
    const fresh = (data.items || []).filter((item) => !existing.has(item.id));
    appendSlides(fresh);

    if (reset) {
      if (!state.items.length) {
        showFeedState({
          title: 'No slop on the line',
          text: data.error || 'Nothing came back from YouTube. Try searching instead.',
          loading: false,
          actions: true
        });
        return;
      }
      hideFeedState();
      scrollToIndex(0, false);
      activate(0);
    }

    if (!data.hasMore || !fresh.length) state.feedEnd = true;
    if (state.mode === 'feed' && state.items.length) updateBack();
    if (data.reason && state.items.length && state.mode === 'feed') {
      state.reason = data.reason;
    }
  } catch (error) {
    if (reset) {
      showFeedState({
        title: "Couldn't farm slop",
        text: error.message,
        loading: false,
        actions: true
      });
    } else {
      toast(error.message, true);
    }
  } finally {
    state.feedBusy = false;
  }
}

function startFeed() {
  state.mode = 'feed';
  setView('feed');
  if (!state.items.length || state.feedEnd || state.feedDirty) loadFeed(true);
  else activate(state.index);
}

/* ---------------- player opening ---------------- */

function openPlayer(items, startIndex = 0, mode = 'feed', backView = 'search') {
  if (!items?.length) return;
  state.mode = mode;
  state.backView = backView;
  state.items = [];
  state.index = 0;
  state.feedEnd = mode === 'feed';
  removeAllSlides();
  playerEnd.hidden = true;
  backFab.hidden = mode === 'feed';
  hideFeedState();
  appendSlides(items);
  setView('feed');
  requestAnimationFrame(() => {
    scrollToIndex(startIndex, false);
    activate(startIndex);
  });
}

/* ---------------- search ---------------- */

function renderResultRow(item, { liked = false } = {}) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'result';
  row.innerHTML = `
    <div class="result-thumb">
      <img alt="" loading="lazy" referrerpolicy="no-referrer" />
      <span class="dur"></span>
    </div>
    <div class="result-body">
      <div class="result-title"></div>
      <div class="result-meta"></div>
    </div>
    <span class="result-play" aria-hidden="true">▶</span>
  `;
  const img = row.querySelector('img');
  img.src = item.thumb || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`;
  img.alt = item.title || '';
  row.querySelector('.dur').textContent = fmtDuration(item.duration);
  row.querySelector('.result-title').textContent = item.title || 'Untitled slop';
  const metaRow = row.querySelector('.result-meta');
  if (item.channel) {
    const channel = document.createElement('span');
    channel.textContent = item.channel;
    metaRow.appendChild(channel);
  }
  const views = fmtViews(item.views);
  if (views) {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '·';
    metaRow.appendChild(sep);
    const viewsEl = document.createElement('span');
    viewsEl.textContent = views;
    metaRow.appendChild(viewsEl);
  }
  if (liked) {
    const heart = document.createElement('span');
    heart.className = 'heart';
    heart.textContent = '♥ liked';
    metaRow.appendChild(heart);
  }
  return row;
}

function skeletonList(count = 4) {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < count; i += 1) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton';
    fragment.appendChild(skeleton);
  }
  return fragment;
}

function emptyState({ emoji = '🫠', title, text, actionLabel, action }) {
  const box = document.createElement('div');
  box.className = 'empty';
  box.innerHTML = `<span class="empty-emoji"></span><span class="empty-title"></span><span class="empty-text"></span>`;
  box.querySelector('.empty-emoji').textContent = emoji;
  box.querySelector('.empty-title').textContent = title;
  box.querySelector('.empty-text').textContent = text;
  if (actionLabel && action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-lime';
    button.textContent = actionLabel;
    button.addEventListener('click', action);
    box.appendChild(button);
  }
  return box;
}

function updateRecentUI() {
  recentChips.innerHTML = '';
  const searches = state.recent.slice(0, 8);
  recentWrap.hidden = !searches.length;
  for (const query of searches) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = query;
    chip.addEventListener('click', () => {
      searchInput.value = query;
      runSearch(query);
    });
    recentChips.appendChild(chip);
  }
}

function renderEngineStatus(extra = '') {
  const engine = state.engine;
  if (!engine) {
    searchStatus.textContent = extra || '';
    return;
  }
  const cacheMb = Math.round((engine.cache?.bytes || 0) / 1024 / 1024);
  const auth = engine.authMode === 'cookies' ? 'cookies' : `visionOS / ${engine.playerClient || 'fallback'}`;
  const queue = `${engine.queue?.active || 0} active · ${engine.queue?.queued || 0} queued`;
  searchStatus.innerHTML = '';
  const parts = [extra, `auth: ${auth}`, `cache: ${cacheMb} MB`, queue].filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    if (i) searchStatus.append(' · ');
    const span = document.createElement('span');
    if (i === 0 && extra) span.className = 'strong';
    span.textContent = parts[i];
    searchStatus.appendChild(span);
  }
}

async function loadStatus() {
  try {
    const data = await api('/api/status', { timeout: 20_000 });
    state.engine = data;
    state.recent = (data.recentSearches || []).map((entry) => entry.q).filter(Boolean);
    authPill.textContent = data.authMode === 'cookies' ? 'cookies' : 'visionOS';
    authPill.dataset.mode = data.authMode;
    authPill.title =
      data.authMode === 'cookies'
        ? 'Using YT_COOKIE cookies.txt for YouTube auth'
        : `No cookies found — using yt-dlp player_client=${data.playerClient || 'visionOS'}`;
    updateRecentUI();
    renderEngineStatus(state.lastSearchMeta || '');
  } catch {
    authPill.textContent = 'offline';
    authPill.dataset.mode = 'error';
  }
}

async function runSearch(queryInput) {
  const q = String(queryInput ?? searchInput.value).trim();
  if (!q || state.searchBusy) return;
  state.searchBusy = true;
  searchGo.disabled = true;
  searchGo.textContent = '…';
  searchResults.innerHTML = '';
  searchResults.appendChild(skeletonList(5));
  searchStatus.textContent = 'Dialing YouTube…';

  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&kind=${encodeURIComponent(state.searchKind)}`, {
      timeout: 150_000
    });
    const items = data.items || [];
    searchResults.innerHTML = '';
    if (!items.length) {
      searchResults.appendChild(
        emptyState({
          emoji: '🕳️',
          title: 'No slop found',
          text: 'Try a broader topic, a different tag, or paste a channel handle.'
        })
      );
    } else {
      const fragment = document.createDocumentFragment();
      items.forEach((item, index) => {
        const row = renderResultRow(item);
        row.addEventListener('click', () => openPlayer(items, index, 'search', 'search'));
        fragment.appendChild(row);
      });
      searchResults.appendChild(fragment);
    }
    const kindLabel = data.kind === 'channel' ? 'channel' : data.kind === 'tag' ? 'tag' : 'topic';
    state.lastSearchMeta = `${plural(items.length, 'short')} · ${kindLabel} · “${q}”`;
    renderEngineStatus(state.lastSearchMeta);
    state.recent = [q, ...state.recent.filter((entry) => entry.toLowerCase() !== q.toLowerCase())].slice(0, 10);
    updateRecentUI();
    localStorage.setItem('hhl.lastSearch', q);
    loadStatus();
  } catch (error) {
    searchResults.innerHTML = '';
    searchResults.appendChild(
      emptyState({
        emoji: '📡',
        title: 'Search failed',
        text: error.message,
        actionLabel: 'Retry',
        action: () => runSearch(q)
      })
    );
    renderEngineStatus();
  } finally {
    state.searchBusy = false;
    searchGo.disabled = false;
    searchGo.textContent = 'Slop it';
  }
}

/* ---------------- liked ---------------- */

async function loadLiked() {
  if (!state.likedDirty && likedResults.childElementCount) return;
  likedResults.innerHTML = '';
  likedResults.appendChild(skeletonList(4));
  likedStatus.textContent = 'Loading your terrible taste…';
  try {
    const data = await api('/api/liked');
    const items = data.items || [];
    likedResults.innerHTML = '';
    state.likedDirty = false;
    if (!items.length) {
      likedResults.appendChild(
        emptyState({
          emoji: '🖤',
          title: 'Nothing liked yet',
          text: 'Tap the heart on something in the feed. The algorithm — me — will learn.',
          actionLabel: 'Open the feed',
          action: startFeed
        })
      );
      likedStatus.textContent = 'Likes train the For You feed.';
      return;
    }
    const fragment = document.createDocumentFragment();
    items.forEach((item, index) => {
      const row = renderResultRow(item, { liked: true });
      row.addEventListener('click', () => openPlayer(items, index, 'liked', 'liked'));
      fragment.appendChild(row);
    });
    likedResults.appendChild(fragment);
    likedStatus.textContent = `${plural(items.length, 'liked short')} · these shape the For You feed.`;
  } catch (error) {
    likedResults.innerHTML = '';
    likedResults.appendChild(
      emptyState({
        emoji: '📡',
        title: 'Could not load likes',
        text: error.message,
        actionLabel: 'Retry',
        action: loadLiked
      })
    );
    likedStatus.textContent = '';
  }
}

/* ---------------- subscriptions ---------------- */

function subDisplayName(sub) {
  if (sub.channel) return `@${String(sub.channel).replace(/^@/, '')}`;
  return sub.channelId || 'YouTube channel';
}

async function watchChannel(sub) {
  const q = sub.channelUrl || sub.channelId || sub.channel;
  if (!q) return;
  toast('Loading channel…');
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&kind=channel`, { timeout: 150_000 });
    const items = data.items || [];
    if (!items.length) {
      toast('That channel has no Shorts right now.', true);
      return;
    }
    for (const item of items) {
      item.subscribed = true;
      if (!item.channel) item.channel = sub.channel || '';
      if (!item.channelId) item.channelId = sub.channelId || '';
      if (!item.channelUrl) item.channelUrl = sub.channelUrl || '';
    }
    openPlayer(items, 0, 'subs', 'subs');
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadSubs() {
  if (!state.subsDirty && subsResults.childElementCount) return;
  subsResults.innerHTML = '';
  subsResults.appendChild(skeletonList(3));
  subsStatus.textContent = 'Loading your channels…';
  try {
    const data = await api('/api/subscriptions');
    const items = data.items || [];
    subsResults.innerHTML = '';
    state.subsDirty = false;
    if (!items.length) {
      subsResults.appendChild(
        emptyState({
          emoji: '📺',
          title: 'No subscriptions yet',
          text: 'Tap Subscribe next to a channel in the feed. Subscribed channels get pushed to the top of For You.',
          actionLabel: 'Open the feed',
          action: startFeed
        })
      );
      subsStatus.textContent = 'Subscribed channels are recommended first.';
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const sub of items) {
      const card = document.createElement('div');
      card.className = 'sub-card';
      card.innerHTML = `
        <div class="sub-avatar"></div>
        <div class="sub-info">
          <div class="sub-name"></div>
          <div class="sub-meta"></div>
        </div>
        <button type="button" class="btn btn-lime sub-watch">Watch</button>
        <button type="button" class="btn btn-ghost sub-remove">Unsub</button>
      `;
      card.querySelector('.sub-avatar').textContent = (sub.channel || '?').replace(/^@/, '').slice(0, 1).toUpperCase();
      card.querySelector('.sub-name').textContent = subDisplayName(sub);
      card.querySelector('.sub-meta').textContent = `Subscribed ${timeAgo(sub.addedAt)}`;
      card.querySelector('.sub-watch').addEventListener('click', () => watchChannel(sub));
      card.querySelector('.sub-remove').addEventListener('click', async () => {
        await setSubscription(sub, false);
        state.subsDirty = true;
        loadSubs();
      });
      fragment.appendChild(card);
    }
    subsResults.appendChild(fragment);
    subsStatus.textContent = `${plural(items.length, 'channel')} feeding your For You.`;
  } catch (error) {
    subsResults.innerHTML = '';
    subsResults.appendChild(
      emptyState({
        emoji: '📡',
        title: 'Could not load subscriptions',
        text: error.message,
        actionLabel: 'Retry',
        action: loadSubs
      })
    );
    subsStatus.textContent = '';
  }
}

/* ---------------- events ---------------- */

function bindEvents() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view;
      if (view === 'feed') {
        if (state.mode !== 'feed' || state.feedDirty) loadFeed(true);
        else setView('feed');
      } else {
        setView(view);
      }
    });
  });

  $('#brandBtn').addEventListener('click', () => {
    if (state.mode !== 'feed' || state.feedDirty) loadFeed(true);
    else setView('feed');
  });

  backFab.addEventListener('click', () => {
    pauseActive();
    setView(state.backView || 'search');
  });

  player.addEventListener('click', (event) => {
    const slide = event.target.closest('.slide');
    if (!slide) return;
    const index = Number(slide.dataset.index);
    if (event.target.closest('.retry')) {
      event.stopPropagation();
      slide.classList.remove('has-error');
      slide.dataset.ready = '0';
      slide.dataset.loading = '0';
      setStatus(slide, 'Retrying…');
      prepareMedia(index);
      return;
    }
    if (event.target.closest('.sub-btn')) {
      toggleSubscription(index);
      return;
    }
    if (event.target.closest('.like')) {
      toggleLike(index);
      return;
    }
    if (event.target.closest('.comment')) {
      openComments(state.items[index]);
      return;
    }
    if (event.target.closest('.sound')) {
      toggleMute();
      return;
    }
    if (event.target.closest('.openyt')) return;
    if (event.target.closest('.bigplay')) {
      playSlide(slide);
      return;
    }
    if (event.target.closest('.video-wrap')) togglePlay(slide);
  });

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-sheet]')) closeComments();
    const go = event.target.closest('[data-go]');
    if (go) setView(go.dataset.go);
  });

  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch();
  });

  $$('#kindChips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.searchKind = chip.dataset.kind || 'auto';
      $$('#kindChips .chip').forEach((other) => other.classList.toggle('is-active', other === chip));
      const hints = {
        auto: 'dogs, @MrBeast, #satisfying…',
        topic: 'topic — e.g. cooking hacks',
        channel: '@handle or full channel URL',
        tag: '#dog, #satisfying, #diy'
      };
      searchInput.placeholder = hints[state.searchKind] || hints.auto;
      searchInput.focus();
    });
  });

  commentForm.addEventListener('submit', submitComment);
  commentName.addEventListener('input', () => {
    state.nickname = commentName.value;
    localStorage.setItem('hhl.name', commentName.value);
  });

  feedRetryBtn.addEventListener('click', () => loadFeed(true));

  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input, textarea, button, a')) return;
    if (state.view !== 'feed') return;
    if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault();
      const next = Math.min(state.index + 1, state.items.length - 1);
      if (next !== state.index) {
        scrollToIndex(next);
        activate(next);
      }
    } else if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault();
      const previous = Math.max(0, state.index - 1);
      if (previous !== state.index) {
        scrollToIndex(previous);
        activate(previous);
      }
    } else if (event.key === 'm') {
      toggleMute();
    } else if (event.key === 'l') {
      toggleLike(state.index);
    } else if (event.key === ' ') {
      event.preventDefault();
      togglePlay(slides[state.index]);
    } else if (event.key === 'Escape') {
      closeComments();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !commentsSheet.hidden) closeComments();
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.view === 'feed' && slides[state.index]) {
        player.scrollTop = state.index * player.clientHeight;
      }
    }, 180);
  });
}

function toggleMute() {
  state.muted = !state.muted;
  localStorage.setItem('hhl.muted', state.muted ? '1' : '0');
  slides.forEach((slide) => {
    const video = slide.querySelector('video');
    if (video) video.muted = state.muted;
    slide.querySelector('.sound')?.classList.toggle('muted', state.muted);
  });
  if (!state.muted) {
    slides.forEach((slide) => {
      const video = slide.querySelector('video');
      if (video?.src && video.paused && Number(slide.dataset.index) === state.index) playSlide(slide);
    });
  }
}

/* ---------------- boot ---------------- */

function boot() {
  commentName.value = state.nickname;
  const lastSearch = localStorage.getItem('hhl.lastSearch');
  if (lastSearch) {
    searchInput.value = lastSearch;
    state.recent = [lastSearch];
    updateRecentUI();
  }
  bindEvents();
  loadStatus();
  loadFeed(true);
}

boot();

// Heartbeat: tells the server someone is looking, so it stays out of idle.
// Hidden tabs send nothing, which lets the server pause background work.
(function heartbeat() {
  const ping = () => {
    if (document.visibilityState === 'visible') fetch('/api/ping', { method: 'POST', keepalive: true }).catch(() => {});
  };
  setInterval(ping, 30_000);
  document.addEventListener('visibilitychange', ping);
  ping();
})();
