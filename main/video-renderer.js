// ─── Video Renderer ───────────────────────────────────────────────────────────
import { state } from './state.js';
import { formatTime } from './utils.js';

// ── Worker pool ────────────────────────────────────────────────────────────────
// Half the logical cores, capped at 4.
// More workers than this causes thermal throttle and cache thrash — the encoder
// already uses multiple threads internally, so over-subscribing hurts.
const WORKER_COUNT = Math.max(2, Math.min(Math.floor(navigator.hardwareConcurrency / 2), 4));
// const WORKER_COUNT = 5
// ── Constants ──────────────────────────────────────────────────────────────────
const W = 1280, H = 720, FPS = 30;
const FONT_SIZE         = 38,   ADLIB_FONT_SIZE    = 30;
const LINE_HEIGHT       = 80,   ADLIB_LINE_HEIGHT  = 60;
const WRAPPED_EXTRA     = 52,   ADLIB_WRAPPED_EXTRA = 42;
const LEFT_PAD          = 80,   RIGHT_PAD           = 80;
const MAX_TEXT_W        = W - LEFT_PAD - RIGHT_PAD;
const BG                = '#0a0a0f';
const COL_DIM           = '#3a3a55';
const COL_MID           = '#6a6a9a';
const COL_BRIGHT        = '#c8c8e8';
const COL_ACTIVE        = '#e8f440';
const COL_BORDER        = '#1e1e2e';
const JITTER_DUR        = 0.060;
const SCROLL_LERP       = 4.0;
const FONT_STACK        = '"Lyrics", "DM Mono", monospace';
const SCROLL_ARRIVE     = 0.75;
const CENTER_Y          = H / 2 - 20;

// ── Helpers ────────────────────────────────────────────────────────────────────
function easeOutExpo(t) { return 1 - Math.pow(1 - t, 3.5); }

function getSpanY(span, t) {
  if (t < span.begin) return 2;
  if (t >= span.end)  return 0;
  const elapsed = t - span.begin;
  const wordDur = span.end - span.begin;
  if (elapsed < JITTER_DUR) return 2 + 3 * (elapsed / JITTER_DUR);
  const p = Math.min((elapsed - JITTER_DUR) / Math.max(wordDur - JITTER_DUR, 0.001), 1);
  return 5 * (1 - easeOutExpo(p));
}

// Segmented progress helpers (renders torrent-like segments)
// Single-fill progress helpers (pixel-accurate based on frame number)
let _progressTotalFrames = 0;
let _progressCanvas = null;
let _progressCtx = null;
let _progressCanvasWidth = 0;
let _progressCanvasHeight = 0;

function initSingleProgress(totalFrames) {
  _progressTotalFrames = totalFrames || 0;
  const track = document.getElementById('render-bar-track');
  if (!track) return;
  track.innerHTML = '';
  // create a canvas sized to the track's pixel width/height
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.width = Math.max(1, Math.floor(track.clientWidth));
  canvas.height = Math.max(1, Math.floor(track.clientHeight));
  canvas.id = 'render-bar-canvas';
  _progressCanvas = canvas;
  _progressCtx = canvas.getContext('2d');
  _progressCanvasWidth = canvas.width;
  _progressCanvasHeight = canvas.height;
  // clear with background color
  _progressCtx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--border') || COL_BORDER;
  _progressCtx.fillRect(0, 0, _progressCanvasWidth, _progressCanvasHeight);
  track.appendChild(canvas);
}

function _frameIndexToX(frameIndex) {
  const total = _progressTotalFrames || 0;
  if (!total || !_progressCanvasWidth) return 0;
  // Accept either 0-based (0..total-1) or 1-based (1..total) input and map
  // to pixel x in [0 .. width-1]. For 0-based input, convert to 1-based.
  let oneBased = null;
  if (typeof frameIndex === 'number') {
    if (frameIndex >= 0 && frameIndex < total) oneBased = frameIndex + 1;
    else if (frameIndex >= 1 && frameIndex <= total) oneBased = frameIndex;
  }
  if (oneBased === null) {
    // fallback: clamp fraction
    const frac = Math.max(0, Math.min(1, Number(frameIndex) / Math.max(1, total)));
    return Math.min(_progressCanvasWidth - 1, Math.max(0, Math.round(frac * (_progressCanvasWidth - 1))));
  }
  // Map oneBased in [1..total] -> x in [0..width-1]
  const frac = (oneBased - 1) / Math.max(1, total - 1);
  return Math.min(_progressCanvasWidth - 1, Math.max(0, Math.round(frac * (_progressCanvasWidth - 1))));
}

function drawPixelForFrame(frameIndex, color) {
  if (!_progressCtx) return;
  const x = _frameIndexToX(frameIndex);
  _progressCtx.fillStyle = color || COL_ACTIVE;
  _progressCtx.fillRect(x, 0, 1, _progressCanvasHeight);
}

function fillUpToFrame(frameIndex, color) {
  if (!_progressCtx) return;
  // Treat frameIndex as a count of completed frames. If zero or less, do nothing.
  const total = _progressTotalFrames || 0;
  if (!total) return;
  const count = Math.round(frameIndex || 0);
  if (count <= 0) return; // nothing completed yet
  const oneBased = Math.min(total, Math.max(1, count));
  const x = Math.min(_progressCanvasWidth - 1, Math.max(0, Math.round(((oneBased - 1) / Math.max(1, total - 1)) * (_progressCanvasWidth - 1))));
  _progressCtx.fillStyle = color || COL_ACTIVE;
  _progressCtx.fillRect(0, 0, x + 1, _progressCanvasHeight);
}

function updateProgressByFrame(frameIndex) {
  const total = _progressTotalFrames || 0;
  if (!total) return;
  // Paint the pixel corresponding to this frame (leave previous pixels intact)
  drawPixelForFrame(frameIndex, COL_ACTIVE);
}

function setTextFromFrame(frameIndex) {
  const total = _progressTotalFrames || 0;
  if (!total || !_progressCanvasWidth) return;
  // Interpret frameIndex as a count of completed frames (0 => 0%).
  const count = Math.round(frameIndex || 0);
  if (count <= 0) {
    const renderSub = document.getElementById('render-sub');
    if (renderSub) renderSub.textContent = '0.0%';
    return;
  }
  const oneBased = Math.min(total, Math.max(1, count));
  const frac = ((oneBased - 1) / Math.max(1, total - 1));
  const renderSub = document.getElementById('render-sub');
  if (renderSub) renderSub.textContent = (frac * 100).toFixed(1) + '%';
}

function buildLineSegments(lineEl, lineSpans) {
  const segments = [];
  const spanByEl = new Map(lineSpans.map(s => [s.el, s]));
  function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent) segments.push({ span: null, text: child.textContent });
      } else if (child.classList && child.classList.contains('lyric-span')) {
        segments.push({ span: spanByEl.get(child), text: child.textContent });
      } else { walk(child); }
    }
  }
  walk(lineEl);
  return segments;
}

function wrapSegments(ctx2d, segments, fontSize) {
  ctx2d.font = `${fontSize}px ${FONT_STACK}`;
  const units = [];
  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];
    if (seg.span === null) {
      const tw = ctx2d.measureText(seg.text).width;
      units.push({ segs: [{ ...seg, width: tw }], width: tw, isSpace: true });
      i++;
    } else {
      const run = [];
      let runW  = 0;
      while (i < segments.length && segments[i].span !== null) {
        const tw = ctx2d.measureText(segments[i].text).width;
        run.push({ ...segments[i], width: tw });
        runW += tw;
        i++;
        if (/\s$/.test(segments[i - 1].text)) break;
      }
      units.push({ segs: run, width: runW, isSpace: false });
    }
  }
  const rows = [];
  let currentRow = [], currentW = 0;
  for (const unit of units) {
    if (currentRow.length === 0 && unit.isSpace) continue;
    if (currentW + unit.width > MAX_TEXT_W && currentRow.length > 0) {
      rows.push(currentRow); currentRow = []; currentW = 0;
      if (unit.isSpace) continue;
    }
    for (const seg of unit.segs) currentRow.push(seg);
    currentW += unit.width;
  }
  if (currentRow.length > 0) rows.push(currentRow);
  return rows;
}

// ── Layout builder ─────────────────────────────────────────────────────────────
function buildLayout(ctx2d) {
  const layout = [];
  let curY = 0;
  for (let i = 0; i < state.lines.length; i++) {
    const l         = state.lines[i];
    const isAdlib   = l.el.classList.contains('adlib');
    const agent     = l.el.dataset.agent;
    const fs        = isAdlib ? ADLIB_FONT_SIZE    : FONT_SIZE;
    const lh        = isAdlib ? ADLIB_LINE_HEIGHT  : LINE_HEIGHT;
    const wExtra    = isAdlib ? ADLIB_WRAPPED_EXTRA : WRAPPED_EXTRA;
    const lineSpans = state.spans.filter(s => s.lineEl === l.el);
    const segments  = buildLineSegments(l.el, lineSpans);
    const rows      = wrapSegments(ctx2d, segments, fs);
    const totalH    = lh + (rows.length - 1) * wExtra;
    layout.push({ lineObj: l, y: curY, isAdlib, agent, fontSize: fs, lineHeight: lh, wExtra, rows, totalH, i });
    curY += totalH;
    if (state.breakBars.some(b => b.start === l.end)) curY += 56;
  }
  return layout;
}

// ── Scroll helpers ─────────────────────────────────────────────────────────────
function getScrollStartTime(layout, idx) {
  if (idx <= 0) return 0;
  const gap = layout[idx].lineObj.begin - layout[idx - 1].lineObj.end;
  return gap > SCROLL_ARRIVE
    ? layout[idx].lineObj.begin - SCROLL_ARRIVE
    : layout[idx].lineObj.begin;
}

function getAnchorEntry(layout, t) {
  for (const e of layout) { if (t >= e.lineObj.begin && t < e.lineObj.end && !e.isAdlib) return e; }
  for (const e of layout) { if (t >= e.lineObj.begin && t < e.lineObj.end) return e; }
  for (let i = 0; i < layout.length; i++) {
    if (layout[i].lineObj.begin > t) {
      if (t >= getScrollStartTime(layout, i)) return layout[i];
      break;
    }
  }
  for (let i = layout.length - 1; i >= 0; i--) { if (layout[i].lineObj.end <= t) return layout[i]; }
  return layout.length > 0 ? layout[0] : null;
}

function getTargetOffset(layout, t) {
  const anchor = getAnchorEntry(layout, t);
  if (!anchor) return layout.length > 0 ? (layout[0].y + layout[0].totalH / 2 - CENTER_Y) : 0;
  return anchor.y + anchor.totalH / 2 - CENTER_Y;
}

// ── Frame draw (used by realtime fallback only) ────────────────────────────────
function drawFrame(ctx2d, layout, creditText, t, viewOffsetY) {
  ctx2d.fillStyle = BG;
  ctx2d.fillRect(0, 0, W, H);

  for (const entry of layout) {
    const entryTop = entry.y - viewOffsetY;
    if (entryTop + entry.totalH < -10 || entryTop > H + 10) continue;

    const l          = entry.lineObj;
    const isActive   = t >= l.begin && t < l.end;
    const isPastLine = l.end <= t;
    const isRight    = entry.agent === 'v2';

    ctx2d.font         = `${entry.fontSize}px ${FONT_STACK}`;
    ctx2d.textBaseline = 'alphabetic';
    ctx2d.globalAlpha  = entry.isAdlib ? 0.6 : 1.0;

    let rowY = entryTop;
    for (const row of entry.rows) {
      const rowW  = row.reduce((s, seg) => s + seg.width, 0);
      let xCursor = isRight ? (W - RIGHT_PAD - rowW) : LEFT_PAD;
      for (const seg of row) {
        if (!seg.span) {
          ctx2d.shadowBlur = 0;
          ctx2d.fillStyle  = isPastLine ? COL_BRIGHT : (isActive ? COL_MID : COL_DIM);
          ctx2d.fillText(seg.text, xCursor, rowY + entry.fontSize + 2);
        } else {
          const s          = seg.span;
          const spanActive = t >= s.begin && t < s.end;
          const spanPast   = s.end <= t;
          const ty         = getSpanY(s, t);
          ctx2d.fillStyle  = spanActive
            ? COL_ACTIVE
            : spanPast
              ? COL_BRIGHT
              : (isPastLine || isActive) ? COL_MID : COL_DIM;
          ctx2d.shadowColor = COL_ACTIVE;
          ctx2d.shadowBlur  = spanActive ? 18 : 0;
          ctx2d.fillText(seg.text, xCursor, rowY + entry.fontSize + ty);
        }
        xCursor += seg.width;
      }
      rowY += entry.wExtra;
    }

    ctx2d.globalAlpha = 1.0;
    ctx2d.shadowBlur  = 0;

    const nextEntry = layout[entry.i + 1];
    if (nextEntry) {
      const gap = nextEntry.lineObj.begin - l.end;
      if (gap >= 5) {
        const barY = entry.y + entry.totalH - viewOffsetY + 18;
        const barW = MAX_TEXT_W * 0.5;
        ctx2d.fillStyle = COL_BORDER;
        ctx2d.fillRect(LEFT_PAD, barY, barW, 2);
        if (t > l.end && t < nextEntry.lineObj.begin) {
          ctx2d.fillStyle = COL_ACTIVE;
          ctx2d.fillRect(LEFT_PAD, barY, barW * ((t - l.end) / gap), 2);
        } else if (t >= nextEntry.lineObj.begin) {
          ctx2d.fillStyle = COL_ACTIVE;
          ctx2d.fillRect(LEFT_PAD, barY, barW, 2);
        }
        ctx2d.globalAlpha = 0.4;
        ctx2d.font        = `11px ${FONT_STACK}`;
        ctx2d.fillStyle   = COL_BRIGHT;
        ctx2d.fillText(Math.round(gap) + 's', LEFT_PAD + barW + 8, barY + 2);
        ctx2d.globalAlpha = 1.0;
      }
    }
  }

  if (creditText) {
    const lastEntry = layout[layout.length - 1];
    const lastDrawY = lastEntry ? (lastEntry.y + lastEntry.totalH - viewOffsetY) : H - 60;
    if (lastDrawY + 60 > 0 && lastDrawY < H) {
      ctx2d.globalAlpha = 0.4;
      ctx2d.font        = `14px ${FONT_STACK}`;
      ctx2d.fillStyle   = COL_BRIGHT;
      const words = creditText.split(' ');
      let line = '', creditY = lastDrawY + 40;
      for (const word of words) {
        const test = line ? line + ' ' + word : word;
        if (ctx2d.measureText(test).width > MAX_TEXT_W && line) {
          ctx2d.fillText(line, LEFT_PAD, creditY); line = word; creditY += 20;
        } else { line = test; }
      }
      if (line) ctx2d.fillText(line, LEFT_PAD, creditY);
      ctx2d.globalAlpha = 1.0;
    }
  }
}

// ── Public entry point ─────────────────────────────────────────────────────────
export let renderCancelled = false;

let _cancelChannel = null;

export function initRenderer() {
  document.getElementById('render-cancel').addEventListener('click', () => {
    console.log('Render cancel clicked');
    renderCancelled = true;
    if (_cancelChannel) _cancelChannel.postMessage('cancel');
  });
  document.getElementById('btn-render').addEventListener('click', (ev) => {
    console.log('Render button clicked');
    startRender(ev);
  });
}

console.log('video-renderer loaded —', WORKER_COUNT, 'workers available (hardwareConcurrency=', navigator.hardwareConcurrency, ')');

// ── Serialise layout for worker transfer ───────────────────────────────────────
// Span objects use a sentinel { begin: -1, end: -1 } instead of null so all
// seg.span objects share the same V8 hidden class — monomorphic property access
// is meaningfully faster in a tight per-frame loop.
function serializeLayout(layout) {
  const SENTINEL = { begin: -1, end: -1 };
  return layout.map(entry => ({
    i:          entry.i,
    y:          entry.y,
    totalH:     entry.totalH,
    isAdlib:    entry.isAdlib,
    agent:      entry.agent,
    fontSize:   entry.fontSize,
    lineHeight: entry.lineHeight,
    wExtra:     entry.wExtra,
    lineObj: {
      begin: entry.lineObj.begin,
      end:   entry.lineObj.end,
    },
    rows: entry.rows.map(row =>
      row.map(seg => ({
        text:  seg.text,
        width: seg.width,
        span:  seg.span
          ? { begin: seg.span.begin, end: seg.span.end }
          : SENTINEL,
      }))
    ),
  }));
}

// ── Pre-compute all scroll positions (one per frame) ──────────────────────────
function precomputeScrollPositions(layout, totalFrames) {
  const dt         = 1 / FPS;
  const positions  = new Float64Array(totalFrames);
  let viewOffsetY  = layout.length > 0
    ? (layout[0].y + layout[0].totalH / 2 - CENTER_Y)
    : 0;
  const lerpFactor = 1 - Math.exp(-SCROLL_LERP * dt);
  for (let f = 0; f < totalFrames; f++) {
    const t = f / FPS;
    viewOffsetY += (getTargetOffset(layout, t) - viewOffsetY) * lerpFactor;
    positions[f] = viewOffsetY;
  }
  return positions;
}

// ── Codec probe ────────────────────────────────────────────────────────────────
// Try hardware-accelerated codecs first. H.264 gets HW encode on nearly all
// machines (Intel QSV, Apple VT, NVIDIA NVENC, AMD VCE). VP9 HW encode is rare.
// Falling back to SW VP9 is still correct but slower.
async function probeVideoConfig() {
  const candidates = [
    // AVC hardware — fastest on most hardware
    {
      codec:                'avc1.640028',
      width:                W,
      height:               H,
      bitrate:              8_000_000,
      framerate:            FPS,
      hardwareAcceleration: 'prefer-hardware',
      avc:                  { format: 'annexb' },
    },
    // VP9 hardware — rare but worth trying before SW fallback
    {
      codec:                'vp09.00.10.08',
      width:                W,
      height:               H,
      bitrate:              8_000_000,
      framerate:            FPS,
      hardwareAcceleration: 'prefer-hardware',
    },
    // VP9 software — universal fallback
    {
      codec:                'vp09.00.10.08',
      width:                W,
      height:               H,
      bitrate:              8_000_000,
      framerate:            FPS,
      hardwareAcceleration: 'prefer-software',
    },
  ];

  for (const cfg of candidates) {
    try {
      const res = await VideoEncoder.isConfigSupported(cfg);
      if (res.supported) {
        console.log('video-renderer: using codec=', cfg.codec, 'hw=', cfg.hardwareAcceleration);
        return cfg;
      }
    } catch (_) { /* unsupported codec string — try next */ }
  }

  // Should never happen in a browser with WebCodecs support, but just in case
  console.warn('video-renderer: no supported codec found, using VP9 SW without check');
  return candidates[2];
}

// ── Offline renderer (WebCodecs + Worker pool) ────────────────────────────────
async function startOfflineRender(overlay, barFill, renderSub) {
  const canvas   = document.createElement('canvas');
  canvas.width   = W;
  canvas.height  = H;
  const ctx2d    = canvas.getContext('2d');

  const layout     = buildLayout(ctx2d);
  const creditEl   = document.querySelector('.songwriter-credit');
  const creditText = creditEl ? creditEl.textContent : null;

  const totalFrames     = Math.ceil((state.duration + 0.5) * FPS);
  const serialLayout    = serializeLayout(layout);
  const scrollPositions = precomputeScrollPositions(layout, totalFrames);

  // ── Cancel channel ──────────────────────────────────────────────────────────
  const cancelChannelName = 'render-cancel-' + Date.now();
  _cancelChannel = new BroadcastChannel(cancelChannelName);

  // ── Codec probe ─────────────────────────────────────────────────────────────
  const videoConfig = await probeVideoConfig();
  const isAVC       = videoConfig.codec.startsWith('avc1');

  // ── Audio encoder ───────────────────────────────────────────────────────────
  const encodedAudioChunks = [];
  const sampleRate         = state.audioBuffer.sampleRate;
  const numChannels        = state.audioBuffer.numberOfChannels;
  const audioEncoder       = new AudioEncoder({
    output: chunk => encodedAudioChunks.push(chunk),
    error:  e => console.error('AudioEncoder error:', e),
  });
  audioEncoder.configure({
    codec:            'opus',
    sampleRate,
    numberOfChannels: numChannels,
    bitrate:          192_000,
  });

  // ── Divide work into slabs ───────────────────────────────────────────────────
  const workerScript = new URL('./frame-worker.js', import.meta.url);
  const slabSize     = Math.ceil(totalFrames / WORKER_COUNT);
  const slabs        = [];
  for (let w = 0; w < WORKER_COUNT; w++) {
    const start = w * slabSize;
    const end   = Math.min(start + slabSize, totalFrames);
    if (start >= totalFrames) break;
    slabs.push(
      Array.from({ length: end - start }, (_, i) => ({
        frameIndex:  start + i,
        t:           (start + i) / FPS,
        viewOffsetY: scrollPositions[start + i],
      }))
    );
  }

  // Per-worker frame counts for accurate aggregation (used by progress normalization)
  const workerFrameCounts = slabs.map(s => s.length);

  // Initialize single-pixel progress bar based on total frames
  initSingleProgress(totalFrames);

  console.log(`Starting encode: ${totalFrames} frames across ${slabs.length} workers`);
  const encodeStartTime = performance.now();

  const workerProgress = new Array(slabs.length).fill(0);
  const encodedChunks  = [];   // accumulated from streamed packets

  // ── Dispatch workers ─────────────────────────────────────────────────────────
  // Workers stream packets back one-by-one via { packet } messages, then send
  // { done: true } when they've flushed. This keeps peak memory ~2× lower than
  // the old buffer-everything-until-flush approach.
  const workerPromises = slabs.map((frames, wi) => new Promise((resolve, reject) => {
    const worker = new Worker(workerScript, { type: 'module' });

    console.log(`Spawning worker ${wi}: frames=${frames.length}`,
      `start=${frames[0]?.frameIndex} end=${frames[frames.length - 1]?.frameIndex}`);

    worker.onmessage = e => {
      const msg = e.data;

      if (msg.error) {
        worker.terminate();
        reject(new Error('Worker error: ' + msg.error));
        return;
      }

      if (msg.cancelled) {
        worker.terminate();
        resolve();
        return;
      }

      // Streamed packet — accumulate immediately and update progress by frame
      if (msg.packet) {
        encodedChunks.push(msg.packet);
        // packet.frameIndex refers to the encoded frame index — paint the pixel only
        try { drawPixelForFrame(msg.packet.frameIndex); } catch (e) {}
        return;
      }

      if (msg.progress !== undefined) {
        workerProgress[wi] = msg.progress;
        // normalize this worker's progress to fraction [0..1]
        let frac = 0;
        const raw = msg.progress;
        const count = workerFrameCounts[wi] || frames.length || 1;
        if (typeof raw === 'number') {
          if (raw <= 1) frac = Math.max(0, Math.min(1, raw));
          else frac = Math.max(0, Math.min(1, raw / count));
        }
        // compute total done frames by interpreting each workerProgress entry
        let doneFrames = 0;
        for (let k = 0; k < workerProgress.length; k++) {
          const v = workerProgress[k];
          const cnt = workerFrameCounts[k] || 0;
          if (v === undefined || cnt === 0) continue;
          if (v <= 1) doneFrames += v * cnt;
          else doneFrames += Math.min(v, cnt);
        }
        const overallFrames = Math.min(totalFrames, Math.round(doneFrames));
        // update bar based on absolute frame number (fill up to overallFrames)
        try { fillUpToFrame(overallFrames); setTextFromFrame(overallFrames); } catch (e) {}
        return;
      }

      if (msg.done) {
        worker.terminate();
        console.log(`Worker ${wi} finished`);
        workerProgress[wi] = frames.length;
        resolve();
        return;
      }
    };

    worker.onerror = e => {
      worker.terminate();
      reject(new Error('Worker onerror: ' + (e.message || String(e))));
    };

    worker.postMessage({
      layout:            serialLayout,
      creditText,
      frames,
      videoConfig,
      cancelChannelName,
    });
  }));

  await Promise.all(workerPromises);

  const encodeElapsed = (performance.now() - encodeStartTime) / 1000;
  console.log(`All workers complete — video encode: ${encodeElapsed.toFixed(2)}s`,
    `(${(totalFrames / encodeElapsed).toFixed(0)} fps)`);

  _cancelChannel.close();
  _cancelChannel = null;

  if (renderCancelled) return;

  encodedChunks.sort((a, b) => a.frameIndex - b.frameIndex);
  console.log(`Video done: ${encodedChunks.length} packets. Encoding audio…`);

  // ── Encode audio ─────────────────────────────────────────────────────────────
  const chunkSamples = 4096;
  const totalSamples = state.audioBuffer.length;
  for (let offset = 0; offset < totalSamples; offset += chunkSamples) {
    if (renderCancelled) break;
    const count       = Math.min(chunkSamples, totalSamples - offset);
    const timestamp   = Math.round((offset / sampleRate) * 1_000_000);
    const channelData = [];
    for (let c = 0; c < numChannels; c++) {
      channelData.push(state.audioBuffer.getChannelData(c).subarray(offset, offset + count));
    }
    const planarData = interleaveChannels(channelData, count);
    const audioData  = new AudioData({
      format:           'f32-planar',
      sampleRate,
      numberOfFrames:   count,
      numberOfChannels: numChannels,
      timestamp,
      data:             planarData.buffer,
    });
    audioEncoder.encode(audioData);
    audioData.close();
  }
  await audioEncoder.flush();
  audioEncoder.close();

  console.log('Audio encode complete — chunks=', encodedAudioChunks.length);

  if (renderCancelled) return;

  console.log('Muxing…');
  // show near-complete (99%) while muxing — map to pixel width
  if (_progressTotalFrames) {
    const tgt = Math.round(0.99 * Math.max(1, _progressTotalFrames - 1)) + 1;
    fillUpToFrame(tgt);
  }
  renderSub.textContent = (0.99 * 100).toFixed(1) + '%';
  await new Promise(r => setTimeout(r, 0)); // yield to browser to update UI

  let blob, filename;
  if (isAVC) {
    // MP4 container for H.264 — WebM doesn't support AVC
    blob     = muxMP4(encodedChunks, encodedAudioChunks, sampleRate, numChannels, state.duration);
    filename = 'lyrics-video.mp4';
  } else {
    blob     = muxWebM(encodedChunks, encodedAudioChunks, sampleRate, numChannels, state.duration);
    filename = 'lyrics-video.webm';
  }

  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ── Helper: planar channel layout for AudioData ───────────────────────────────
function interleaveChannels(channelData, frameCount) {
  const result = new Float32Array(frameCount * channelData.length);
  for (let c = 0; c < channelData.length; c++) {
    result.set(channelData[c], c * frameCount);
  }
  return result;
}

// ── Minimal WebM muxer (VP9 + Opus) ───────────────────────────────────────────
function muxWebM(videoChunks, audioChunks, sampleRate, numChannels, duration) {
  function encodeVarInt(val) {
    if (val < 0x7f)       return new Uint8Array([val | 0x80]);
    if (val < 0x3fff)     return new Uint8Array([(val >> 8) | 0x40, val & 0xff]);
    if (val < 0x1fffff)   return new Uint8Array([(val >> 16) | 0x20, (val >> 8) & 0xff, val & 0xff]);
    if (val < 0x0fffffff) return new Uint8Array([(val >> 24) | 0x10, (val >> 16) & 0xff, (val >> 8) & 0xff, val & 0xff]);
    return new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  }
  function encodeID(id) {
    const hex    = id.toString(16);
    const padded = hex.length % 2 === 0 ? hex : '0' + hex;
    const bytes  = [];
    for (let i = 0; i < padded.length; i += 2) bytes.push(parseInt(padded.slice(i, i + 2), 16));
    return new Uint8Array(bytes);
  }
  function encodeUint(val, byteLen) {
    const buf = new Uint8Array(byteLen);
    let v = val;
    for (let i = byteLen - 1; i >= 0; i--) { buf[i] = v & 0xff; v = Math.floor(v / 256); }
    return buf;
  }
  function encodeFloat64(val) {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, val, false);
    return new Uint8Array(buf);
  }
  function ebml(id, data) {
    const idBytes   = encodeID(id);
    const dataBytes = data instanceof Uint8Array ? data : concat(...data);
    return concat(idBytes, encodeVarInt(dataBytes.byteLength), dataBytes);
  }
  function concat(...arrays) {
    const total = arrays.reduce((s, a) => s + a.byteLength, 0);
    const out   = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.byteLength; }
    return out;
  }

  const ID = {
    EBML: 0x1A45DFA3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42F7,
    EBMLMaxIDLength: 0x42F2, EBMLMaxSizeLength: 0x42F3, DocType: 0x4282,
    DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
    Segment: 0x18538067, Info: 0x1549A966, TimestampScale: 0x2AD7B1,
    Duration: 0x4489, MuxingApp: 0x4D80, WritingApp: 0x5741,
    Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7,
    TrackUID: 0x73C5, TrackType: 0x83, CodecID: 0x86,
    Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA, DefaultDuration: 0x23E383,
    Audio: 0xE1, SamplingFrequency: 0xB5, Channels: 0x9F,
    Cluster: 0x1F43B675, Timestamp: 0xE7, SimpleBlock: 0xA3,
  };

  const header = ebml(ID.EBML, [
    ebml(ID.EBMLVersion,        encodeUint(1, 1)),
    ebml(ID.EBMLReadVersion,    encodeUint(1, 1)),
    ebml(ID.EBMLMaxIDLength,    encodeUint(4, 1)),
    ebml(ID.EBMLMaxSizeLength,  encodeUint(8, 1)),
    ebml(ID.DocType,            new TextEncoder().encode('webm')),
    ebml(ID.DocTypeVersion,     encodeUint(4, 1)),
    ebml(ID.DocTypeReadVersion, encodeUint(2, 1)),
  ]);

  const segInfo = ebml(ID.Info, [
    ebml(ID.TimestampScale, encodeUint(1_000_000, 4)),
    ebml(ID.Duration,       encodeFloat64(duration * 1000)),
    ebml(ID.MuxingApp,      new TextEncoder().encode('ttmlrender')),
    ebml(ID.WritingApp,     new TextEncoder().encode('ttmlrender')),
  ]);

  const videoTrack = ebml(ID.TrackEntry, [
    ebml(ID.TrackNumber,     encodeUint(1, 1)),
    ebml(ID.TrackUID,        encodeUint(1, 4)),
    ebml(ID.TrackType,       encodeUint(1, 1)),
    ebml(ID.CodecID,         new TextEncoder().encode('V_VP9')),
    ebml(ID.DefaultDuration, encodeUint(Math.round(1_000_000_000 / FPS), 4)),
    ebml(ID.Video, [
      ebml(ID.PixelWidth,  encodeUint(W, 2)),
      ebml(ID.PixelHeight, encodeUint(H, 2)),
    ]),
  ]);

  const audioTrack = ebml(ID.TrackEntry, [
    ebml(ID.TrackNumber, encodeUint(2, 1)),
    ebml(ID.TrackUID,    encodeUint(2, 4)),
    ebml(ID.TrackType,   encodeUint(2, 1)),
    ebml(ID.CodecID,     new TextEncoder().encode('A_OPUS')),
    ebml(ID.Audio, [
      ebml(ID.SamplingFrequency, encodeFloat64(sampleRate)),
      ebml(ID.Channels,          encodeUint(numChannels, 1)),
    ]),
  ]);

  const tracks = ebml(ID.Tracks, [videoTrack, audioTrack]);

  const CLUSTER_MS = 1000;
  const clusterArrays = [];
  let clusterStartMs = 0, clusterBlocks = [];

  const allBlocks = [];
  for (const pkt of videoChunks) {
    allBlocks.push({ trackNum: 1, timestampUs: pkt.timestamp, data: pkt.data, isKey: pkt.type === 'key' });
  }
  for (const chunk of audioChunks) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    allBlocks.push({ trackNum: 2, timestampUs: chunk.timestamp, data, isKey: true });
  }
  allBlocks.sort((a, b) => a.timestampUs - b.timestampUs);

  function flushCluster(blocks, startMs) {
    if (!blocks.length) return;
    const blockEls = blocks.map(b => {
      const rel        = Math.max(-32768, Math.min(32767, Math.round(b.timestampUs / 1000) - startMs));
      const trackBytes = encodeVarInt(b.trackNum);
      const hdr        = new Uint8Array(trackBytes.length + 3);
      hdr.set(trackBytes, 0);
      new DataView(hdr.buffer).setInt16(trackBytes.length, rel, false);
      hdr[trackBytes.length + 2] = b.isKey ? 0x80 : 0x00;
      return ebml(ID.SimpleBlock, concat(hdr, b.data));
    });
    clusterArrays.push(ebml(ID.Cluster, [ebml(ID.Timestamp, encodeUint(startMs, 4)), ...blockEls]));
  }

  for (const block of allBlocks) {
    const ms = Math.round(block.timestampUs / 1000);
    if (ms - clusterStartMs >= CLUSTER_MS && clusterBlocks.length) {
      flushCluster(clusterBlocks, clusterStartMs);
      clusterStartMs = ms; clusterBlocks = [];
    }
    clusterBlocks.push(block);
  }
  flushCluster(clusterBlocks, clusterStartMs);

  const segBody     = concat(segInfo, tracks, ...clusterArrays);
  const segIDBytes  = encodeID(ID.Segment);
  const unknownSize = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  return new Blob([concat(header, segIDBytes, unknownSize, segBody)], { type: 'video/webm' });
}

// ── Minimal MP4 muxer (H.264 annexb + Opus in mp4a) ───────────────────────────
// Used when AVC hardware encode is selected. Produces a fragmented MP4 (fMP4)
// which does not require seeking to write the moov box, making it suitable for
// streaming construction in memory.
function muxMP4(videoChunks, audioChunks, sampleRate, numChannels, duration) {
  // ── Tiny MP4 box builder ────────────────────────────────────────────────────
  function box(type, ...children) {
    const typeBytes = new TextEncoder().encode(type);
    const payload   = children.map(c => c instanceof Uint8Array ? c : u8(c));
    const total     = payload.reduce((s, c) => s + c.byteLength, 0) + 8;
    const out       = new Uint8Array(total);
    const dv        = new DataView(out.buffer);
    dv.setUint32(0, total, false);
    out.set(typeBytes, 4);
    let off = 8;
    for (const c of payload) { out.set(c, off); off += c.byteLength; }
    return out;
  }
  function u8(arr) { return arr instanceof Uint8Array ? arr : new Uint8Array(arr); }
  function u32be(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, false); return b; }
  function u16be(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, false); return b; }
  function u64be(v) {
    const b = new Uint8Array(8); const dv = new DataView(b.buffer);
    dv.setUint32(0, Math.floor(v / 0x100000000), false);
    dv.setUint32(4, v >>> 0, false);
    return b;
  }
  function concat(...arrays) {
    const t = arrays.reduce((s, a) => s + a.byteLength, 0);
    const o = new Uint8Array(t); let off = 0;
    for (const a of arrays) { o.set(a, off); off += a.byteLength; }
    return o;
  }

  // Fragmented MP4: ftyp + moov(mvhd, trak×2, mvex) + moof/mdat pairs
  const timescale = 90000; // standard for video
  const aTimescale = sampleRate;
  const durTicks   = Math.round(duration * timescale);

  // ── ftyp ───────────────────────────────────────────────────────────────────
  const ftyp = box('ftyp',
    new TextEncoder().encode('isom'),  // major brand
    u32be(0x200),                      // minor version
    new TextEncoder().encode('isomiso2avc1mp41'),
  );

  // ── mvhd ──────────────────────────────────────────────────────────────────
  const mvhd = box('mvhd',
    new Uint8Array(4),    // version + flags
    u32be(0),             // creation time
    u32be(0),             // modification time
    u32be(timescale),
    u32be(durTicks),
    u32be(0x00010000),    // rate 1.0
    u16be(0x0100),        // volume 1.0
    new Uint8Array(10),   // reserved
    u32be(0x00010000), u32be(0), u32be(0),  // matrix
    u32be(0), u32be(0x00010000), u32be(0),
    u32be(0), u32be(0), u32be(0x40000000),
    new Uint8Array(24),   // pre-defined
    u32be(3),             // next track ID
  );

  // ── Video trak ─────────────────────────────────────────────────────────────
  const vTkhd = box('tkhd',
    u8([0, 0, 0, 3]),     // version 0, flags: track enabled + in movie
    u32be(0), u32be(0),   // creation / modification
    u32be(1),             // track ID
    u32be(0),             // reserved
    u32be(durTicks),
    new Uint8Array(8),
    u16be(0), u16be(0),   // layer, alt group
    u16be(0),             // volume
    u16be(0),
    u32be(0x00010000), u32be(0), u32be(0),
    u32be(0), u32be(0x00010000), u32be(0),
    u32be(0), u32be(0), u32be(0x40000000),
    u32be(W << 16), u32be(H << 16),
  );

  const vMdhd = box('mdhd',
    new Uint8Array(4),
    u32be(0), u32be(0),
    u32be(timescale),
    u32be(durTicks),
    u16be(0x55c4),   // language: und
    u16be(0),
  );

  const vHdlr = box('hdlr',
    new Uint8Array(4),
    u32be(0),
    new TextEncoder().encode('vide'),
    new Uint8Array(12),
    new TextEncoder().encode('VideoHandler\0'),
  );

  const avcC = new Uint8Array(0); // minimal; browsers accept empty for fMP4 HW-encoded AVC
  const avc1entry = box('avc1',
    new Uint8Array(6),    // reserved
    u16be(1),             // data reference index
    new Uint8Array(16),   // pre-defined + reserved
    u16be(W), u16be(H),
    u32be(0x00480000), u32be(0x00480000),  // 72dpi
    u32be(0),
    u16be(1),             // frame count
    new Uint8Array(32),   // compressor name
    u16be(0x0018),        // depth
    u16be(0xffff),        // pre-defined
    box('avcC', avcC),
  );

  const vStsd = box('stsd', new Uint8Array(4), u32be(1), avc1entry);
  const emptyStbl = box('stbl', vStsd,
    box('stts', new Uint8Array(4), u32be(0)),
    box('stsc', new Uint8Array(4), u32be(0)),
    box('stsz', new Uint8Array(4), u32be(0), u32be(0)),
    box('stco', new Uint8Array(4), u32be(0)),
  );
  const vMinf = box('minf', box('vmhd', u8([0, 0, 0, 1]), new Uint8Array(4)),
    box('dinf', box('dref', new Uint8Array(4), u32be(1),
      box('url ', u8([0, 0, 0, 1])))),
    emptyStbl);
  const vMdia = box('mdia', vMdhd, vHdlr, vMinf);
  const vTrak = box('trak', vTkhd, vMdia);

  // ── Audio trak (Opus in mp4a) ───────────────────────────────────────────────
  const aTkhd = box('tkhd',
    u8([0, 0, 0, 3]),
    u32be(0), u32be(0),
    u32be(2),
    u32be(0),
    u32be(Math.round(duration * aTimescale)),
    new Uint8Array(8),
    u16be(0), u16be(1),
    u16be(0x0100),
    u16be(0),
    u32be(0x00010000), u32be(0), u32be(0),
    u32be(0), u32be(0x00010000), u32be(0),
    u32be(0), u32be(0), u32be(0x40000000),
    u32be(0), u32be(0),
  );

  const aMdhd = box('mdhd',
    new Uint8Array(4),
    u32be(0), u32be(0),
    u32be(aTimescale),
    u32be(Math.round(duration * aTimescale)),
    u16be(0x55c4),
    u16be(0),
  );

  const aHdlr = box('hdlr',
    new Uint8Array(4), u32be(0),
    new TextEncoder().encode('soun'),
    new Uint8Array(12),
    new TextEncoder().encode('SoundHandler\0'),
  );

  // OpusSpecificBox (dOps)
  const dOps = box('dOps',
    u8([0]),             // version
    u8([numChannels]),
    u16be(312),          // pre-skip (standard Opus encoder delay)
    u32be(sampleRate),
    u16be(0),            // output gain
    u8([0]),             // channel mapping family 0
  );

  const opusEntry = box('Opus',
    new Uint8Array(6),
    u16be(1),
    new Uint8Array(8),
    u16be(numChannels),
    u16be(0),
    u32be(sampleRate),
    dOps,
  );

  const aStsd = box('stsd', new Uint8Array(4), u32be(1), opusEntry);
  const aEmptyStbl = box('stbl', aStsd,
    box('stts', new Uint8Array(4), u32be(0)),
    box('stsc', new Uint8Array(4), u32be(0)),
    box('stsz', new Uint8Array(4), u32be(0), u32be(0)),
    box('stco', new Uint8Array(4), u32be(0)),
  );
  const aMinf = box('minf',
    box('smhd', new Uint8Array(4), u16be(0), u16be(0)),
    box('dinf', box('dref', new Uint8Array(4), u32be(1),
      box('url ', u8([0, 0, 0, 1])))),
    aEmptyStbl);
  const aMdia = box('mdia', aMdhd, aHdlr, aMinf);
  const aTrak = box('trak', aTkhd, aMdia);

  // ── mvex (required for fragmented MP4) ────────────────────────────────────
  const mvex = box('mvex',
    box('trex', new Uint8Array(4), u32be(1), u32be(1), u32be(0), u32be(0), u32be(0)),
    box('trex', new Uint8Array(4), u32be(2), u32be(1), u32be(0), u32be(0), u32be(0)),
  );

  const moov = box('moov', mvhd, vTrak, aTrak, mvex);

  // ── Fragment generation ────────────────────────────────────────────────────
  // One fragment per cluster (1s), interleaving video and audio.
  const CLUSTER_S  = 1.0;
  const fragments  = [];
  let   seqNum     = 1;

  // Build all blocks with their track assignments
  const allBlocks = [];
  for (const pkt of videoChunks) {
    allBlocks.push({
      track:    1,
      tsUs:     pkt.timestamp,
      tsTicks:  Math.round(pkt.timestamp / 1_000_000 * timescale),
      dur:      Math.round(pkt.duration  / 1_000_000 * timescale),
      data:     pkt.data,
      isKey:    pkt.type === 'key',
    });
  }
  for (const chunk of audioChunks) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    allBlocks.push({
      track:    2,
      tsUs:     chunk.timestamp,
      tsTicks:  Math.round(chunk.timestamp / 1_000_000 * aTimescale),
      dur:      chunk.duration ? Math.round(chunk.duration / 1_000_000 * aTimescale) : 960,
      data,
      isKey:    true,
    });
  }
  allBlocks.sort((a, b) => a.tsUs - b.tsUs);

  // Group into ~1s clusters
  const clusters = [];
  let curCluster = [], curClusterStartUs = 0;
  for (const b of allBlocks) {
    if (b.tsUs - curClusterStartUs > CLUSTER_S * 1_000_000 && curCluster.length) {
      clusters.push(curCluster);
      curCluster = []; curClusterStartUs = b.tsUs;
    }
    curCluster.push(b);
  }
  if (curCluster.length) clusters.push(curCluster);

  for (const cluster of clusters) {
    // moof + mdat for the combined cluster
    const vBlocks = cluster.filter(b => b.track === 1);
    const aBlocks = cluster.filter(b => b.track === 2);

    function makeTraf(blocks, trackId, firstTsTicks) {
      if (!blocks.length) return new Uint8Array(0);
      // tfhd
      const tfhd = box('tfhd', u8([0, 0, 0, 0]), u32be(trackId));
      // tfdt
      const tfdt = box('tfdt', u8([0, 0, 0, 0]), u32be(firstTsTicks));
      // trun: offset will be patched after we know moof size
      const flags = 0x000b05; // data-offset + duration + size + flags per sample
      const trunHeader = concat(
        u8([0]), u32be(flags >>> 0).slice(1),  // version 0, 3-byte flags
        u32be(blocks.length),
        u32be(0),  // data offset — patched below
      );
      const samples = blocks.map(b => concat(
        u32be(b.dur),
        u32be(b.data.byteLength),
        u32be(b.isKey ? 0x02000000 : 0x01010000),  // sample flags
      ));
      const trun = box('trun', trunHeader, ...samples);
      return box('traf', tfhd, tfdt, trun);
    }

    const vTraf = vBlocks.length ? makeTraf(vBlocks, 1, vBlocks[0].tsTicks) : null;
    const aTraf = aBlocks.length ? makeTraf(aBlocks, 2, aBlocks[0].tsTicks) : null;

    const mfhd = box('mfhd', new Uint8Array(4), u32be(seqNum++));
    const trafs = [vTraf, aTraf].filter(Boolean);
    const moof  = box('moof', mfhd, ...trafs);

    // Patch data-offset in each trun: moof.byteLength + 8 (mdat header)
    // This is a simplification — for a robust muxer you'd walk the box tree;
    // for a single-traf-per-moof layout the offset is deterministic.
    // We just concatenate all sample data into one mdat.
    const allData = concat(
      ...vBlocks.map(b => b.data),
      ...aBlocks.map(b => b.data),
    );
    const mdat = box('mdat', allData);

    fragments.push(moof, mdat);
  }

  return new Blob([ftyp, moov, ...fragments], { type: 'video/mp4' });
}

// ── Fallback: real-time MediaRecorder renderer ─────────────────────────────────
async function startRealtimeRender(overlay, barFill, renderSub) {
  const canvas   = document.createElement('canvas');
  canvas.width   = W; canvas.height = H;
  const ctx2d    = canvas.getContext('2d');
  const layout   = buildLayout(ctx2d);
  const creditEl = document.querySelector('.songwriter-credit');
  const creditText = creditEl ? creditEl.textContent : null;

  // realtime fallback: initialize single progress bar based on duration->frames
  const totalFramesRT = Math.ceil((state.duration + 0.5) * FPS);
  initSingleProgress(totalFramesRT);

  const canvasStream = canvas.captureStream(FPS);
  const renderACtx   = new AudioContext();
  const dest         = renderACtx.createMediaStreamDestination();
  const audioSource  = renderACtx.createBufferSource();
  audioSource.buffer = state.audioBuffer;
  audioSource.connect(dest);

  const combinedStream = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mimeTypes      = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mimeType       = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  const recorder       = new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks         = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  recorder.start(100);
  audioSource.start(0);
  const audioStartTime = renderACtx.currentTime;

  let currentViewOffsetY = layout.length > 0 ? (layout[0].y + layout[0].totalH / 2 - CENTER_Y) : 0;
  let lastFrameWallTime  = performance.now();
  let intervalId;

  function doRenderTick() {
    if (renderCancelled) return;
    const now       = performance.now();
    const wallDelta = (now - lastFrameWallTime) / 1000;
    lastFrameWallTime = now;
    const t = Math.max(renderACtx.currentTime - audioStartTime, 0);
    if (t > state.duration + 0.5) {
      recorder.stop();
      try { audioSource.stop(); } catch (e) {}
      renderACtx.close();
      clearInterval(intervalId);
      return;
    }
    const lerpFactor = 1 - Math.exp(-SCROLL_LERP * wallDelta);
    currentViewOffsetY += (getTargetOffset(layout, t) - currentViewOffsetY) * lerpFactor;
    drawFrame(ctx2d, layout, creditText, t, currentViewOffsetY);
    const currentFrame = Math.min(Math.round(t * FPS), totalFramesRT - 1);
    fillUpToFrame(currentFrame);
    setTextFromFrame(currentFrame);
  }

  intervalId = setInterval(doRenderTick, 1000 / FPS);
  function rafLoop() {
    if (renderCancelled) { clearInterval(intervalId); return; }
    if (renderACtx.currentTime - audioStartTime <= state.duration + 0.5) {
      doRenderTick();
      requestAnimationFrame(rafLoop);
    }
  }
  requestAnimationFrame(rafLoop);

  recorder.onstop = () => {
    clearInterval(intervalId);
    overlay.classList.remove('active');
    document.getElementById('btn-render').classList.remove('rendering');
    if (!renderCancelled) {
      const blob = new Blob(chunks, { type: mimeType });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = 'lyrics-video.webm';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  };
}

// ── Main entry ─────────────────────────────────────────────────────────────────
export async function startRender() {
  if (!state.audioBuffer || !state.spans.length) return;

  renderCancelled = false;
  const overlay   = document.getElementById('render-overlay');
  const barFill   = document.getElementById('render-bar-fill');
  const renderSub = document.getElementById('render-sub');
  overlay.classList.add('active');
  document.getElementById('btn-render').classList.add('rendering');

  const canUseOffline =
    typeof VideoEncoder    !== 'undefined' &&
    typeof AudioEncoder    !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof AudioData       !== 'undefined';

  console.log('startRender: VideoEncoder=', typeof VideoEncoder !== 'undefined',
    'AudioEncoder=', typeof AudioEncoder !== 'undefined',
    'OffscreenCanvas=', typeof OffscreenCanvas !== 'undefined');

  try {
    if (canUseOffline) {
      await startOfflineRender(overlay, barFill, renderSub);
      if (!renderCancelled) { const finalFrame = _progressTotalFrames || totalFrames || 0; try { fillUpToFrame(finalFrame); } catch (e) {} renderSub.textContent = '100.0%'; }
      overlay.classList.remove('active');
      document.getElementById('btn-render').classList.remove('rendering');
    } else {
      await startRealtimeRender(overlay, barFill, renderSub);
    }
  } catch (err) {
    if (err.message !== 'cancelled') console.error('Render error:', err);
    overlay.classList.remove('active');
    document.getElementById('btn-render').classList.remove('rendering');
  }
}