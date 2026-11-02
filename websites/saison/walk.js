/**
 * SAISON / Cinematic Walk 4K — motion-interpolated sequence
 *
 * Scroll-driven image sequence, not a continuously playing movie.
 * The viewport follows scroll position without waiting for a network request;
 * decoded frames are prioritised around the visible camera and preloaded ahead.
 * Adjacent ready frames are blended for sub-frame motion.
 */
const FRAME_COUNT = 241;
const LAST_FRAME = FRAME_COUNT - 1;
const VERSION = 'cinematic4k1';
const requestedQuality = new URLSearchParams(location.search).get('quality');
const lowBandwidth = navigator.connection?.saveData === true;
// Full 4K-sized upscaled frames for roomy desktop viewports, with a lighter
// 1080p stream on phones/slow connections. ?quality=4k / ?quality=1080 override.
const quality = requestedQuality === '4k' || requestedQuality === '1080'
  ? requestedQuality : (!lowBandwidth && matchMedia('(min-width: 1000px)').matches ? '4k' : '1080');
const BASE = new URL(quality === '4k' ? './walk-4k/' : './walk-1080/', import.meta.url);

const walk = document.querySelector('#experience');
const stage = document.querySelector('.walk-stage');
const host = document.querySelector('#scene');
const loading = document.querySelector('#walk-loading');
const copies = [...document.querySelectorAll('[data-copy]')];
const destinations = [...document.querySelectorAll('.destinations [data-go]')];
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const mobile = window.matchMedia('(max-width: 650px)');
const saveData = navigator.connection?.saveData === true;
const maxReady = quality === '4k' ? 12 : mobile.matches ? 26 : 36;
const concurrency = saveData ? 2 : quality === '4k' ? 3 : mobile.matches ? 4 : 5;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = value => Math.max(0, Math.min(1, value));

const labels = [
  'THE ENTRANCE', 'THE DINING ROOM', 'THE OPEN KITCHEN',
  'THE WINE COUNTER', 'THE WINDOW TABLE'
];
const descriptions = [
  'Candlelit Saison dining room with ivory seating, marble tables and an onyx bar.',
  'Marble dining tables with candlelight, crystal glasses and ivory seating.',
  'The open kitchen with a pale marble pass and warm bronze lighting.',
  'The illuminated onyx wine counter and brass shelves.',
  'An intimate candlelit table beside the evening windows.'
];
const mapPoints = [[47, 105], [58, 76], [48, 51], [66, 26], [28, 20]];
const mapDot = document.querySelector('#map-dot');
const positionLabel = document.querySelector('#position-label');
const positionNumber = document.querySelector('#position-number');
const scrollHint = document.querySelector('#scroll-hint');

const canvas = document.createElement('canvas');
canvas.className = 'walk-canvas';
canvas.setAttribute('aria-hidden', 'true');
host.prepend(canvas);
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

// Entries contain decoded HTMLImageElements. Browser network caching can reuse
// evicted WebP bytes, while the bounded map prevents excessive decoded memory.
const ready = new Map();
const pending = new Set();
const queued = new Map();
const failures = new Map();
let active = 0;
let useCounter = 0;
let requestedCursor = -1;
let requestedDestination = -1;
let current = 0;
let target = 0;
let manualStop = 0;
let lastStop = -1;
let lastFramePaint = '';
let canvasDrawn = false;
let inView = true;
let animationId = 0;
let previousTime = 0;
let scrollStart = 0;
let scrollLength = 1;
let canvasWidth = 0;
let canvasHeight = 0;

const frameUrl = index => new URL(`f${String(index + 1).padStart(4, '0')}.webp?v=${VERSION}`, BASE).href;
const frameIndex = progress => reduced.matches ? manualStop * 60 : clamp(progress) * LAST_FRAME;

function queueFrame(index, priority = 0) {
  if (index < 0 || index > LAST_FRAME || ready.has(index) || pending.has(index)) return;
  const fail = failures.get(index);
  if (fail && Date.now() < fail.retryAt) return;
  const old = queued.get(index);
  if (old === undefined || priority > old) queued.set(index, priority);
}

function trimCache() {
  if (ready.size <= maxReady) return;
  const nearCurrent = frameIndex(current);
  const nearTarget = frameIndex(target);
  const protection = new Set([
    Math.floor(nearCurrent), Math.ceil(nearCurrent),
    Math.floor(nearTarget), Math.ceil(nearTarget)
  ]);
  const candidates = [...ready].filter(([index]) => !protection.has(index));
  candidates.sort(([a, x], [b, y]) => {
    const distA = Math.min(Math.abs(a - nearCurrent), Math.abs(a - nearTarget));
    const distB = Math.min(Math.abs(b - nearCurrent), Math.abs(b - nearTarget));
    return (distB - distA) || (x.used - y.used);
  });
  while (ready.size > maxReady && candidates.length) {
    const [index] = candidates.shift();
    ready.delete(index);
  }
}

function pump() {
  while (active < concurrency && queued.size) {
    // Priority is recalculated when the user changes scroll direction. Old
    // distant preloads must never outrank frames needed *right now*.
    const wanted = frameIndex(current);
    const destination = frameIndex(target);
    const [index] = [...queued].sort((a, b) =>
      (b[1] - a[1]) ||
      (Math.min(Math.abs(a[0] - wanted), Math.abs(a[0] - destination)) -
       Math.min(Math.abs(b[0] - wanted), Math.abs(b[0] - destination)))
    )[0];
    queued.delete(index);
    if (pending.has(index) || ready.has(index)) continue;

    active++;
    pending.add(index);
    const image = new Image();
    image.decoding = 'async';
    let settled = false;
    const watchdog = setTimeout(() => complete(false), 12000);

    function complete(success) {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      active--;
      pending.delete(index);
      if (success && image.naturalWidth) {
        ready.set(index, { image, used: ++useCounter });
        failures.delete(index);
        trimCache();
      } else {
        const count = (failures.get(index)?.count || 0) + 1;
        failures.set(index, { count, retryAt: Date.now() + Math.min(20000, count * 2000) });
      }
      requestDraw();
      pump();
    }

    image.onload = () => {
      if (typeof image.decode === 'function') {
        image.decode().then(() => complete(true), () => complete(image.complete && image.naturalWidth > 0));
      } else complete(true);
    };
    image.onerror = () => complete(false);
    image.src = frameUrl(index);
  }
}

function prefetch(force = false) {
  const cursor = Math.round(frameIndex(current));
  const destination = Math.round(frameIndex(target));
  if (!force && cursor === requestedCursor && destination === requestedDestination) return;
  requestedCursor = cursor;
  requestedDestination = destination;

  // Discard requests left over from a different scroll position. Requests
  // already in flight can finish and be reused normally.
  queued.clear();
  const direction = target >= current ? 1 : -1;
  for (const center of [cursor, destination]) {
    queueFrame(center, 100);
    queueFrame(center + 1, 96);
    queueFrame(center - 1, 96);
    for (let offset = 2; offset <= (quality === '4k' ? 9 : mobile.matches ? 12 : 18); offset++) {
      queueFrame(center + direction * offset, 75 - offset);
      queueFrame(center - direction * offset, 63 - offset);
    }
  }
  // Keep the chapter anchors convenient for direct navigation.
  for (const anchor of [0, 60, 120, 180, 240]) queueFrame(anchor, 9);
  pump();
}

function fitCanvas() {
  if (!ctx) return;
  const rect = host.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, mobile.matches ? 1.25 : quality === '4k' ? 2 : 1.5);
  const width = Math.max(1, Math.round(Math.min(quality === '4k' ? 3840 : mobile.matches ? 1440 : 1920, rect.width * ratio)));
  const height = Math.max(1, Math.round(rect.height * width / Math.max(1, rect.width)));
  if (width === canvasWidth && height === canvasHeight) return;
  canvasWidth = canvas.width = width;
  canvasHeight = canvas.height = height;
  lastFramePaint = '';
}

function drawCover(image) {
  const width = canvasWidth;
  const height = canvasHeight;
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawnWidth = image.naturalWidth * scale;
  const drawnHeight = image.naturalHeight * scale;
  ctx.drawImage(image, (width - drawnWidth) / 2, (height - drawnHeight) / 2,
    drawnWidth, drawnHeight);
}

function closestReady(index) {
  let best = null;
  let distance = Infinity;
  for (const [key, value] of ready) {
    const difference = Math.abs(key - index);
    if (difference < distance) { best = [key, value]; distance = difference; }
  }
  return best;
}

function paint(progress) {
  if (!ctx || !ready.size) return false;
  fitCanvas();
  const position = frameIndex(progress);
  const lower = Math.floor(position);
  const upper = Math.min(LAST_FRAME, lower + 1);
  const fraction = position - lower;
  const a = ready.get(lower);
  const b = ready.get(upper);

  let first;
  let second = null;
  let blend = 0;
  if (a && b && lower !== upper && !reduced.matches) {
    first = [lower, a];
    second = [upper, b];
    blend = fraction;
  } else if (a) first = [lower, a];
  else if (b) first = [upper, b];
  else first = closestReady(position);

  if (!first) return false;
  first[1].used = ++useCounter;
  if (second) second[1].used = ++useCounter;
  // 1/32 opacity precision limits needless full-canvas repaints while
  // retaining near-continuous motion when both neighboring frames are ready.
  const signature = `${canvasWidth}/${canvasHeight}/${first[0]}/${second?.[0] ?? -1}/${Math.round(blend * 64)}`;
  if (signature === lastFramePaint) return true;
  lastFramePaint = signature;

  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = mobile.matches ? 'medium' : 'high';
  drawCover(first[1].image);
  if (second && blend > 0.015) {
    ctx.globalAlpha = blend;
    drawCover(second[1].image);
    ctx.globalAlpha = 1;
  }
  canvasDrawn = true;
  host.classList.add('walk-ready');
  canvas.dataset.frame = String(Math.round(position) + 1);
  loading.hidden = true;
  return true;
}

function chapter(progress) {
  const stop = reduced.matches ? manualStop : Math.min(4, Math.round(progress * 4));
  if (stop !== lastStop) {
    stage.dataset.stop = String(stop);
    copies.forEach(copy => {
      const hidden = Number(copy.dataset.copy) !== stop;
      copy.setAttribute('aria-hidden', String(hidden));
      copy.inert = hidden;
    });
    destinations.forEach(button => {
      if (Number(button.dataset.go) === stop) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    positionLabel.textContent = labels[stop];
    positionNumber.textContent = `0${stop + 1} / 05`;
    scrollHint.textContent = reduced.matches ? 'CHOOSE A ROOM BELOW' :
      stop === 4 ? 'YOUR EVENING STARTS HERE' : 'SCROLL TO WALK INSIDE';
    host.setAttribute('aria-label', descriptions[stop]);
    lastStop = stop;
  }
  stage.style.setProperty('--progress', progress.toFixed(4));
  const section = Math.min(3, Math.floor(progress * 4));
  const mix = progress * 4 - section;
  mapDot.setAttribute('cx', String(lerp(mapPoints[section][0], mapPoints[section + 1][0], mix)));
  mapDot.setAttribute('cy', String(lerp(mapPoints[section][1], mapPoints[section + 1][1], mix)));
}

function animate(time) {
  animationId = 0;
  if (document.hidden || !inView) return;
  const dt = previousTime ? Math.min(0.05, (time - previousTime) / 1000) : 1 / 60;
  previousTime = time;

  // No artificial 16%-per-second movement cap. Following scroll position
  // should be responsive; the damping only removes tiny wheel/touch jitters.
  const gap = Math.abs(target - current);
  const responsiveness = gap > 0.11 ? 23 : 15;
  current = reduced.matches ? target : lerp(current, target, 1 - Math.exp(-responsiveness * dt));
  if (Math.abs(target - current) < 0.00002) current = target;

  prefetch();
  paint(current);
  chapter(current);
  if (!canvasDrawn) loading.hidden = false;
  if (current !== target) requestDraw();
}

function requestDraw() {
  if (!animationId && !document.hidden && inView) {
    animationId = requestAnimationFrame(animate);
  }
}

function measureScrollGeometry() {
  scrollStart = window.scrollY + walk.getBoundingClientRect().top;
  scrollLength = Math.max(1, walk.offsetHeight - window.innerHeight);
}

function onScroll() {
  if (reduced.matches) return;
  target = clamp((window.scrollY - scrollStart) / scrollLength);
  requestDraw();
}

function refreshLayout() {
  measureScrollGeometry();
  fitCanvas();
  onScroll();
  requestDraw();
}

document.querySelectorAll('[data-go]').forEach(button => {
  button.addEventListener('click', () => {
    const stop = Number(button.dataset.go);
    if (reduced.matches) {
      manualStop = stop;
      target = stop / 4;
      prefetch(true);
      requestDraw();
    } else {
      window.scrollTo({ top: scrollStart + stop / 4 * scrollLength, behavior: 'smooth' });
    }
  });
});

window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', refreshLayout, { passive: true });
reduced.addEventListener('change', () => {
  manualStop = Math.round(current * 4);
  if (reduced.matches) target = manualStop / 4;
  refreshLayout();
  prefetch(true);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(animationId);
    animationId = 0;
  } else {
    previousTime = 0;
    refreshLayout();
  }
});
new IntersectionObserver(entries => {
  inView = entries[0].isIntersecting;
  if (!inView) {
    cancelAnimationFrame(animationId);
    animationId = 0;
  } else {
    previousTime = 0;
    refreshLayout();
    prefetch(true);
  }
}, { rootMargin: '150% 0px' }).observe(walk);
new ResizeObserver(refreshLayout).observe(host);
window.addEventListener('online', () => { failures.clear(); prefetch(true); requestDraw(); });

// The source photo is immediately visible while the first frame decodes.
chapter(0);
measureScrollGeometry();
queueFrame(0, 1000);
queueFrame(1, 999);
queueFrame(2, 998);
pump();
onScroll();
requestDraw();

// Minimal diagnostic surface for automated and manual browser QA.
window.__saisonWalkDiagnostics = () => ({
  current: +current.toFixed(4), target: +target.toFixed(4),
  ready: ready.size, pending: pending.size, queue: queued.size,
  painted: canvasDrawn, shownFrame: Number(canvas.dataset.frame || 0),
  quality, sourceResolution: '1280x720', outputResolution: quality === '4k' ? '3840x2160 (upscaled)' : '1920x1080 (upscaled)' 
});
