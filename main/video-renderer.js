// ─── Video Renderer ───────────────────────────────────────────────────────────
import { state } from './state.js';
import { formatTime } from './utils.js';

// ── Worker pool ────────────────────────────────────────────────────────────────
// Half the logical cores, capped at 4.
// More workers than this causes thermal throttle and cache thrash — the encoder
// already uses multiple threads internally, so over-subscribing hurts.
const WORKER_COUNT = Math.max(2, Math.min(Math.floor(navigator.hardwareConcurrency / 2), 4));
// const WORKER_COUNT = 6
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


function setTextFromFrame(frameIndex) {
  const total = _progressTotalFrames || 0;
  if (!total || !_progressCanvasWidth) return;
  // Interpret frameIndex as a count of completed frames (0 => 0%).
  const count = Math.round(frameIndex || 0);
  const renderSub = document.getElementById('render-sub');
  if (count <= 0) {
    renderSub.textContent = '0.0%';
    return;
  }
  const oneBased = Math.min(total, Math.max(1, count));
  const frac = ((oneBased - 1) / Math.max(1, total - 1));
  renderSub.textContent = (frac * 100).toFixed(1) + '%';
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
      avc:                  { format: 'avc' },
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
      bitrateMode:          'constant'
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

  // Initialize single-pixel progress bar based on total frames
  initSingleProgress(totalFrames);

  console.log(`Starting encode: ${totalFrames} frames across ${slabs.length} workers`);
  const encodeStartTime = performance.now();

  const encodedChunks  = [];   // accumulated from streamed packets

  // ── Dispatch workers ─────────────────────────────────────────────────────────
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
        try { 
          drawPixelForFrame(msg.packet.frameIndex, COL_ACTIVE);
          const completedFrames = encodedChunks.length;
          const overallPercent = (completedFrames / totalFrames) * 100;
          renderSub.textContent = overallPercent.toFixed(1) + '%';
        } catch (e) {}
        return;
      }

      if (msg.done) {
        worker.terminate();
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
  if (_progressTotalFrames) {
    const tgt = Math.round(0.99 * Math.max(1, _progressTotalFrames - 1)) + 1;
    fillUpToFrame(tgt);
  }
  renderSub.textContent = (0.99 * 100).toFixed(1) + '%';
  await new Promise(r => setTimeout(r, 0));

  let blob, filename;
  if (isAVC) {
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

// ── WebM muxer using webm-muxer.js
function muxWebM(videoChunks, audioChunks, sampleRate, numChannels, duration) {
  const { Muxer, ArrayBufferTarget } = WebMMuxer;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'V_VP9', width: W, height: H, frameRate: FPS },
    audio: { codec: 'A_OPUS', numberOfChannels: numChannels, sampleRate },
  });

  for (const pkt of videoChunks) {
    muxer.addVideoChunkRaw(
      pkt.data,
      pkt.type,
      pkt.timestamp,
      pkt.decoderConfig ? { decoderConfig: pkt.decoderConfig } : undefined,
    );
  }
  for (const chunk of audioChunks) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    muxer.addAudioChunkRaw(data, 'key', chunk.timestamp);
  }

  muxer.finalize();
  return new Blob([target.buffer], { type: 'video/webm' });
}

// ── MP4 muxer using mp4-muxer.js
function muxMP4(videoChunks, audioChunks, sampleRate, numChannels, duration) {
  const { Muxer, ArrayBufferTarget } = Mp4Muxer;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: W, height: H, frameRate: FPS },
    audio: { codec: 'opus', numberOfChannels: numChannels, sampleRate },
    fastStart: 'in-memory',
  });

  for (const pkt of videoChunks) {
    muxer.addVideoChunkRaw(pkt.data, pkt.type, pkt.timestamp, pkt.duration, pkt.decoderConfig ?? undefined);
  }
  for (const chunk of audioChunks) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    muxer.addAudioChunkRaw(data, 'key', chunk.timestamp, chunk.duration ?? undefined);
  }

  muxer.finalize();
  return new Blob([target.buffer], { type: 'video/mp4' });
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
    console.log(`Rendered frame for t=${t.toFixed(2)}s (frame ${currentFrame})`);
  }

  function rafLoop() {
    if (renderCancelled) { return; }
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