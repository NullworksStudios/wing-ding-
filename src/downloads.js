import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  CACHE_DIR,
  CACHE_MAX_MB,
  MAX_HEIGHT,
  FALLBACK_HEIGHT,
  SLOW_KBPS,
  SLOW_GRACE_MS,
  DOWNLOAD_CONCURRENCY,
  DOWNLOAD_TIMEOUT_MS,
  YT_JS_RUNTIME,
  YTDLP_PATH,
  getAuth
} from './config.js';
import { VIDEO_ID_RE } from './util.js';
import { friendlyError } from './ytdlp.js';

const jobs = new Map();
const queue = [];
const cacheIndex = new Map();
let activeCount = 0;
let preferredHeight = MAX_HEIGHT;
let shuttingDown = false;
let gcTimer = null;

class SlowDownloadError extends Error {
  constructor() {
    super('Download was too slow');
    this.slow = true;
  }
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.on('error', () => {
        try {
          child.kill('SIGKILL');
        } catch {}
      });
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  }
}

function authArgsFor(client) {
  const auth = getAuth();
  if (auth.cookieFile) return ['--cookies', auth.cookieFile];
  return ['--extractor-args', `youtube:player_client=${client || auth.client || 'visionos'}`];
}

function baseArgs() {
  const args = [
    '--ignore-config',
    '--no-warnings',
    '--no-playlist',
    '--newline',
    '--progress',
    '--socket-timeout',
    '20',
    '--retries',
    '3',
    '--fragment-retries',
    '3',
    '--concurrent-fragments',
    '4'
  ];
  if (YT_JS_RUNTIME) args.push('--js-runtimes', YT_JS_RUNTIME);
  return args;
}

function formatFor(height) {
  if (!height) return 'bv*+ba/b';
  // Vertical Shorts are 720x1280, so cap both dimensions. A height-only cap
  // would filter out every 480p vertical format and silently fall back to 720p.
  const cap = height >= 720 ? 1280 : 854;
  const capped = `[width<=${cap}][height<=${cap}]`;
  return [
    `bv*${capped}+ba[ext=m4a]`,
    `bv*${capped}+ba`,
    `b${capped}`,
    'b'
  ].join('/');
}

function sortFor(height) {
  return height ? `res:${height},vcodec:h264,ext:mp4:m4a` : 'res,vcodec:h264,ext:mp4:m4a';
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    quality: job.height || null,
    speedKbps: job.speedKbps || null,
    error: job.error || null,
    note: job.note || null,
    bytes: job.bytes || 0,
    queued: Math.max(0, queue.length),
    active: activeCount
  };
}

function cacheEntry(id) {
  return cacheIndex.get(id) || null;
}

function touch(id) {
  const entry = cacheIndex.get(id);
  if (entry) entry.atime = Date.now();
}

function findVideoFile(id) {
  const exact = path.join(CACHE_DIR, `${id}.mp4`);
  if (fs.existsSync(exact)) return exact;
  try {
    const matches = fs
      .readdirSync(CACHE_DIR)
      .filter((name) => name.startsWith(`${id}.`) && /\.(mp4|mkv|webm)$/i.test(name));
    if (matches.length) {
      const file = path.join(CACHE_DIR, matches[0]);
      return file;
    }
  } catch {}
  return null;
}

function cleanupFiles(id, { keepFinal = false } = {}) {
  try {
    for (const name of fs.readdirSync(CACHE_DIR)) {
      if (!name.startsWith(`${id}.`)) continue;
      if (keepFinal && name === `${id}.mp4`) continue;
      try {
        fs.unlinkSync(path.join(CACHE_DIR, name));
      } catch {}
    }
  } catch {}
}

function scanCache() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(CACHE_DIR)) {
      const full = path.join(CACHE_DIR, name);
      if (name.endsWith('.mp4')) {
        const id = name.slice(0, -4);
        if (!VIDEO_ID_RE.test(id)) continue;
        try {
          const stat = fs.statSync(full);
          if (stat.size < 10_000) {
            fs.unlinkSync(full);
            continue;
          }
          cacheIndex.set(id, { id, file: full, size: stat.size, atime: stat.mtimeMs || now });
        } catch {}
      } else if (/\.(part|ytdl|temp)$/i.test(name)) {
        try {
          if (now - fs.statSync(full).mtimeMs > 60 * 60 * 1000) fs.unlinkSync(full);
        } catch {}
      }
    }
    console.log(`[cache] ${cacheIndex.size} video(s), ${(cacheBytes() / 1024 / 1024).toFixed(1)} MB on disk.`);
  } catch (error) {
    console.warn('[cache] Scan failed:', error.message);
  }
}

function cacheBytes() {
  let total = 0;
  for (const entry of cacheIndex.values()) total += entry.size || 0;
  return total;
}

function evictIfNeeded(keepId) {
  const maxBytes = CACHE_MAX_MB * 1024 * 1024;
  let total = cacheBytes();
  if (total <= maxBytes) return;
  const entries = [...cacheIndex.values()].filter((entry) => entry.id !== keepId).sort((a, b) => a.atime - b.atime);
  for (const entry of entries) {
    if (total <= maxBytes * 0.9 || cacheIndex.size <= 3) break;
    try {
      fs.unlinkSync(entry.file);
      cacheIndex.delete(entry.id);
      total -= entry.size || 0;
    } catch {}
  }
}

function isFatalForHeights(error) {
  const text = `${error?.stderr || ''}\n${error?.message || ''}`;
  return /sign in to confirm|not a bot|HTTP Error 429|private video|video unavailable|members-only|has been removed/i.test(text);
}

function attemptDownload(job, height, client) {
  return new Promise((resolve, reject) => {
    cleanupFiles(job.id);
    const target = path.join(CACHE_DIR, '%(id)s.%(ext)s');
    const args = [
      ...baseArgs(),
      ...authArgsFor(client),
      '-f',
      formatFor(height),
      '-S',
      sortFor(height),
      '--merge-output-format',
      'mp4',
      '--remux-video',
      'mp4',
      '-o',
      target,
      `https://www.youtube.com/watch?v=${job.id}`
    ];

    let child;
    try {
      child = spawn(YTDLP_PATH, args, {
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });
    } catch (error) {
      reject(error);
      return;
    }

    const startedAt = Date.now();
    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    let slowKilled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };

    const timeout = setTimeout(() => {
      killTree(child);
      const error = new Error('Download timed out');
      error.stderr = stderr;
      finish(reject, error);
    }, DOWNLOAD_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('[download]')) continue;
        const percentMatch = line.match(/(\d+(?:\.\d+)?)%/);
        if (percentMatch) {
          job.progress = Math.min(99, Math.max(job.progress, Math.round(Number(percentMatch[1]))));
        }
        const speedMatch = line.match(/at\s+([\d.]+)\s*(K|M|G)?iB\/s/i);
        if (speedMatch) {
          const value = Number(speedMatch[1]);
          const unit = (speedMatch[2] || 'K').toUpperCase();
          const kbps = unit === 'G' ? value * 1024 * 1024 : unit === 'M' ? value * 1024 : value;
          job.speedKbps = Math.round(kbps);
        }
        if (
          height >= MAX_HEIGHT &&
          SLOW_KBPS > 0 &&
          !slowKilled &&
          Date.now() - startedAt > SLOW_GRACE_MS &&
          job.progress < 85 &&
          job.speedKbps &&
          job.speedKbps < SLOW_KBPS
        ) {
          slowKilled = true;
          killTree(child);
          return;
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 40_000) stderr = stderr.slice(-40_000);
    });

    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (slowKilled) {
        finish(reject, new SlowDownloadError());
        return;
      }
      if (code === 0) {
        const file = findVideoFile(job.id);
        if (!file) {
          const error = new Error('Download finished but no video file was created');
          error.stderr = stderr;
          finish(reject, error);
          return;
        }
        finish(resolve, { file, height });
      } else {
        const error = new Error(`yt-dlp exited with code ${code}`);
        error.stderr = stderr;
        error.code = code;
        finish(reject, error);
      }
    });
  });
}

async function runJob(job) {
  const auth = getAuth();
  const cookieMode = Boolean(auth.cookieFile);
  const primaryClient = auth.client || 'visionos';
  const clients = cookieMode ? [null] : [primaryClient];
  const heights = [...new Set([preferredHeight, FALLBACK_HEIGHT, 0])].filter((h) => h >= 0);
  const tried = new Set();
  let lastError = null;

  for (const height of heights) {
    for (let ci = 0; ci < clients.length; ci += 1) {
      const client = clients[ci];
      const key = `${client || 'cookies'}:${height}`;
      if (tried.has(key)) continue;
      tried.add(key);

      job.status = 'downloading';
      job.height = height || null;
      job.progress = 0;
      job.speedKbps = null;
      job.attempts += 1;
      job.startedAt = Date.now();

      try {
        const { file } = await attemptDownload(job, height, client);
        const stat = fs.statSync(file);
        const finalFile = path.join(CACHE_DIR, `${job.id}.mp4`);
        if (file !== finalFile) {
          try {
            fs.renameSync(file, finalFile);
          } catch {
            fs.copyFileSync(file, finalFile);
            fs.unlinkSync(file);
          }
        }
        cacheIndex.set(job.id, {
          id: job.id,
          file: finalFile,
          size: stat.size,
          quality: height || null,
          atime: Date.now()
        });
        evictIfNeeded(job.id);
        job.status = 'ready';
        job.progress = 100;
        job.file = finalFile;
        job.bytes = stat.size;
        job.finishedAt = Date.now();
        job.error = null;
        console.log(`[download] ${job.id} ready (${height || 'best'}p, ${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
        return;
      } catch (error) {
        lastError = error;
        const text = `${error?.stderr || ''}\n${error?.message || ''}`;
        if (error?.slow) {
          if (height > FALLBACK_HEIGHT) {
            preferredHeight = Math.min(preferredHeight, FALLBACK_HEIGHT);
            job.note = `Slow link detected — dropping to ${FALLBACK_HEIGHT}p.`;
            console.log(`[download] Slow network, ${FALLBACK_HEIGHT}p will be preferred from now on.`);
          }
          continue;
        }
        if (!cookieMode && /invalid player client/i.test(text) && !clients.includes('ios')) {
          clients.push('ios');
          continue;
        }
        if (isFatalForHeights(error)) break;
      }
    }
    if (lastError && isFatalForHeights(lastError)) break;
  }

  job.status = 'error';
  job.finishedAt = Date.now();
  job.error = friendlyError(lastError);
  console.error(`[download] ${job.id} failed:`, lastError?.stderr?.split('\n').slice(-3).join(' | ') || lastError?.message);
}

function pump() {
  if (shuttingDown) return;
  while (activeCount < DOWNLOAD_CONCURRENCY && queue.length) {
    let index = queue.findIndex((id) => jobs.get(id)?.priority);
    if (index === -1) index = 0;
    const [id] = queue.splice(index, 1);
    const job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    activeCount += 1;
    runJob(job)
      .catch((error) => {
        job.status = 'error';
        job.error = friendlyError(error);
        job.finishedAt = Date.now();
      })
      .finally(() => {
        activeCount -= 1;
        pump();
      });
  }
}

export function ensureDownload(id, { priority = false } = {}) {
  if (!VIDEO_ID_RE.test(id)) return null;
  const cached = cacheEntry(id);
  if (cached) {
    touch(id);
    return {
      id,
      status: 'ready',
      progress: 100,
      quality: cached.quality || null,
      error: null,
      bytes: cached.size,
      queued: queue.length,
      active: activeCount
    };
  }

  let job = jobs.get(id);
  if (job) {
    // A priority request means the user is looking at (or retrying) this slide,
    // so give a failed download a fresh attempt instead of replaying the error.
    if (job.status === 'error' && (priority || Date.now() - (job.finishedAt || 0) > 5_000)) {
      jobs.delete(id);
      job = null;
    } else {
      if (priority && job.status === 'queued') job.priority = true;
      return publicJob(job);
    }
  }

  if (!job) {
    job = {
      id,
      status: 'queued',
      progress: 0,
      height: null,
      speedKbps: null,
      error: null,
      note: null,
      priority: Boolean(priority),
      attempts: 0,
      createdAt: Date.now(),
      finishedAt: null
    };
    jobs.set(id, job);
    queue.push(id);
    pump();
  }
  return publicJob(job);
}

export function getJob(id) {
  const cached = cacheEntry(id);
  if (cached) {
    return {
      id,
      status: 'ready',
      progress: 100,
      quality: cached.quality || null,
      error: null,
      bytes: cached.size,
      queued: queue.length,
      active: activeCount
    };
  }
  const job = jobs.get(id);
  return job ? publicJob(job) : { id, status: 'idle', progress: 0, quality: null, error: null };
}

export function cachedFile(id) {
  const entry = cacheEntry(id);
  if (!entry) return null;
  touch(id);
  return entry.file;
}

export function cacheInfo() {
  return {
    count: cacheIndex.size,
    bytes: cacheBytes(),
    maxBytes: CACHE_MAX_MB * 1024 * 1024,
    preferredHeight
  };
}

export function queueInfo() {
  return {
    active: activeCount,
    queued: queue.length,
    concurrency: DOWNLOAD_CONCURRENCY,
    preferredHeight
  };
}

export function startDownloads() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  scanCache();
  if (gcTimer) clearInterval(gcTimer);
  gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (!job.finishedAt) continue;
      if (now - job.finishedAt > 60 * 60 * 1000 && !cacheIndex.has(id)) jobs.delete(id);
    }
    // Drop entries whose files vanished under us.
    for (const [id, entry] of cacheIndex) {
      if (!fs.existsSync(entry.file)) cacheIndex.delete(id);
    }
  }, 5 * 60 * 1000);
  gcTimer.unref?.();
}

export function stopDownloads() {
  shuttingDown = true;
  if (gcTimer) clearInterval(gcTimer);
}
