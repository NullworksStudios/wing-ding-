import { IDLE_AFTER_MS } from './config.js';
import { setDownloadsPaused } from './downloads.js';

// Marks the app idle when nobody has the site open and visible. While idle,
// no new background downloads start. Any visit or heartbeat wakes it up.
let lastSeen = Date.now();
let idle = false;
let timer = null;

export function markActive() {
  lastSeen = Date.now();
  if (idle) {
    idle = false;
    setDownloadsPaused(false);
    console.log('[idle] visitor is back, resuming.');
  }
}

export function isIdle() {
  return idle;
}

export function startIdleWatcher() {
  if (!IDLE_AFTER_MS) return;
  timer = setInterval(() => {
    if (!idle && Date.now() - lastSeen > IDLE_AFTER_MS) {
      idle = true;
      setDownloadsPaused(true);
      console.log(`[idle] no visitors for ${Math.round(IDLE_AFTER_MS / 1000)}s, pausing background work.`);
    }
  }, 5_000);
  timer.unref?.();
}

export function stopIdleWatcher() {
  if (timer) clearInterval(timer);
}
