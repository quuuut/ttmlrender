// ─── Frame Worker ─────────────────────────────────────────────────────────────
// Draws frames with a single OffscreenCanvas 2D context (no WebGL composite),
// encodes with VideoEncoder, and streams compressed packets back as they arrive
// instead of buffering everything until flush.
// Listens on a BroadcastChannel cancel flag for instant cancellation.

const W = 1280, H = 720;
const LEFT_PAD = 80, RIGHT_PAD = 80;
const MAX_TEXT_W = W - LEFT_PAD - RIGHT_PAD;
const BG = '#0a0a0f';
const COL_DIM = '#3a3a55';
const COL_MID = '#6a6a9a';
const COL_BRIGHT = '#c8c8e8';
const COL_ACTIVE = '#e8f440';
const COL_BORDER = '#1e1e2e';
const JITTER_DUR = 0.060;
const FONT_STACK = '"Lyrics", "DM Mono", monospace';
const CENTER_Y = H / 2 - 20;

// ── Helpers ────────────────────────────────────────────────────────────────────
function easeOutExpo(t) { return 1 - Math.pow(1 - t, 3.5); }

function getSpanY(span, t) {
  if (t < span.begin) return 2;
  if (t >= span.end) return 0;
  const elapsed = t - span.begin;
  const wordDur = span.end - span.begin;
  if (elapsed < JITTER_DUR) return 2 + 3 * (elapsed / JITTER_DUR);
  const p = Math.min((elapsed - JITTER_DUR) / Math.max(wordDur - JITTER_DUR, 0.001), 1);
  return 5 * (1 - easeOutExpo(p));
}

function getScrollStartTime(layout, idx) {
  const SCROLL_ARRIVE = 0.75;
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

// ── Frame draw ─────────────────────────────────────────────────────────────────
// Single 2D canvas — no WebGL composite overhead, no extra drawImage blits.
// fillRect for the background is negligible vs. the text draw cost.
function drawFrame(ctx, layout, creditText, t, viewOffsetY) {
  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  for (const entry of layout) {
    const entryTop = entry.y - viewOffsetY;
    if (entryTop + entry.totalH < -10 || entryTop > H + 10) continue;

    const l = entry.lineObj;
    const isActive = t >= l.begin && t < l.end;
    const isPastLine = l.end <= t;
    const isRight = entry.agent === 'v2';

    ctx.font = `${entry.fontSize}px ${FONT_STACK}`;
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = entry.isAdlib ? 0.6 : 1.0;

    let rowY = entryTop;
    for (const row of entry.rows) {
      const rowW = row.reduce((s, seg) => s + seg.width, 0);
      let xCursor = isRight ? (W - RIGHT_PAD - rowW) : LEFT_PAD;

      for (const seg of row) {
        // Monomorphic span check: sentinel begin === -1 means no span
        if (seg.span.begin < 0) {
          ctx.shadowBlur = 0;
          ctx.fillStyle = isPastLine ? COL_BRIGHT : (isActive ? COL_MID : COL_DIM);
          ctx.fillText(seg.text, xCursor, rowY + entry.fontSize + 2);
        } else {
          const s = seg.span;
          const spanActive = t >= s.begin && t < s.end;
          const spanPast = s.end <= t;
          const ty = getSpanY(s, t);
          ctx.fillStyle = spanActive
            ? COL_ACTIVE
            : spanPast
              ? COL_BRIGHT
              : (isPastLine || isActive) ? COL_MID : COL_DIM;
          ctx.shadowColor = COL_ACTIVE;
          ctx.shadowBlur = spanActive ? 18 : 0;
          ctx.fillText(seg.text, xCursor, rowY + entry.fontSize + ty);
        }
        xCursor += seg.width;
      }
      rowY += entry.wExtra;
    }

    ctx.globalAlpha = 1.0;
    ctx.shadowBlur = 0;

    // Gap progress bar
    const nextEntry = layout[entry.i + 1];
    if (nextEntry) {
      const gap = nextEntry.lineObj.begin - l.end;
      if (gap >= 5) {
        const barY = entry.y + entry.totalH - viewOffsetY + 18;
        const barW = MAX_TEXT_W * 0.5;
        ctx.fillStyle = COL_BORDER;
        ctx.fillRect(LEFT_PAD, barY, barW, 2);
        if (t > l.end && t < nextEntry.lineObj.begin) {
          ctx.fillStyle = COL_ACTIVE;
          ctx.fillRect(LEFT_PAD, barY, barW * ((t - l.end) / gap), 2);
        } else if (t >= nextEntry.lineObj.begin) {
          ctx.fillStyle = COL_ACTIVE;
          ctx.fillRect(LEFT_PAD, barY, barW, 2);
        }
        ctx.globalAlpha = 0.4;
        ctx.font = `11px ${FONT_STACK}`;
        ctx.fillStyle = COL_BRIGHT;
        ctx.fillText(Math.round(gap) + 's', LEFT_PAD + barW + 8, barY + 2);
        ctx.globalAlpha = 1.0;
      }
    }
  }

  // Songwriter credit
  if (creditText) {
    const lastEntry = layout[layout.length - 1];
    const lastDrawY = lastEntry ? (lastEntry.y + lastEntry.totalH - viewOffsetY) : H - 60;
    if (lastDrawY + 60 > 0 && lastDrawY < H) {
      ctx.globalAlpha = 0.4;
      ctx.font = `14px ${FONT_STACK}`;
      ctx.fillStyle = COL_BRIGHT;
      const words = creditText.split(' ');
      let line = '', creditY = lastDrawY + 40;
      for (const word of words) {
        const test = line ? line + ' ' + word : word;
        if (ctx.measureText(test).width > MAX_TEXT_W && line) {
          ctx.fillText(line, LEFT_PAD, creditY); line = word; creditY += 20;
        } else { line = test; }
      }
      if (line) ctx.fillText(line, LEFT_PAD, creditY);
      ctx.globalAlpha = 1.0;
    }
  }
}

// ── Message handler ────────────────────────────────────────────────────────────
// Expected message: { layout, creditText, frames, videoConfig, cancelChannelName }
self.onmessage = async (e) => {
  try {
    const { layout, creditText, frames, videoConfig, cancelChannelName } = e.data;

    console.log('frame-worker: started — frames=', frames.length,
      'firstFrame=', frames[0]?.frameIndex, 'codec=', videoConfig.codec);

    // ── Cancel channel ──────────────────────────────────────────────────────────
    let cancelled = false;
    const cancelChannel = new BroadcastChannel(cancelChannelName);
    cancelChannel.onmessage = () => {
      cancelled = true;
      console.log('frame-worker: received cancel signal');
    };

    // ── Canvas setup ────────────────────────────────────────────────────────────
    // Single 2D OffscreenCanvas — no WebGL, no composite blit overhead.
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    const font = new FontFace('Lyrics', 'url(/fonts/LyricsRegular.woff2)');
    try {
      await font.load();
      self.fonts.add(font);
    } catch (e) {
      console.warn('frame-worker: font load failed, falling back', e);
    }

    // Warm up font cache so the first real frame doesn't stall
    ctx.font = `38px ${FONT_STACK}`;
    ctx.fillText('', 0, 0);

    // ── VideoEncoder setup ────────────────────────────────────────────────────
    const frameDuration = Math.round(1_000_000 / videoConfig.framerate);
    const MAX_QUEUE = 12;
    const PROGRESS_EVERY = Math.max(1, Math.round(videoConfig.framerate));

    // Stream packets back immediately rather than buffering — cuts peak memory
    // usage by ~50% and lets the main thread start muxing sooner.
    const encoderOutput = (chunk, metadata) => {
      console.log('chunk:', chunk.type, 'size:', chunk.byteLength, 'has config:', !!metadata?.decoderConfig);      
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      self.postMessage({
        packet: {
          frameIndex: Math.round((chunk.timestamp / 1_000_000) * videoConfig.framerate),
          type:       chunk.type,
          timestamp:  chunk.timestamp,
          duration:   chunk.duration ?? frameDuration,
          data,
          decoderConfig: metadata?.decoderConfig ?? null,  // ← add this
        },
      }, [data.buffer]);
    };

    const encoder = new VideoEncoder({
      output: encoderOutput,
      error: (err) => self.postMessage({ error: String(err) }),
    });

    encoder.configure(videoConfig);
    console.log('frame-worker: encoder configured — codec=', videoConfig.codec,
      'hw=', videoConfig.hardwareAcceleration);

    // ── Backpressure ──────────────────────────────────────────────────────────
    function drainEncoder() {
      if (encoder.encodeQueueSize <= MAX_QUEUE) return Promise.resolve();
      return new Promise(resolve => {
        const onDequeue = () => {
          if (encoder.encodeQueueSize <= MAX_QUEUE) {
            encoder.removeEventListener('dequeue', onDequeue);
            resolve();
          }
        };
        encoder.addEventListener('dequeue', onDequeue);
      });
    }

    // ── Frame loop ────────────────────────────────────────────────────────────
    for (let fi = 0; fi < frames.length; fi++) {
      if (cancelled) {
        encoder.close();
        cancelChannel.close();
        self.postMessage({ cancelled: true });
        return;
      }

      await drainEncoder();

      const { frameIndex, t, viewOffsetY } = frames[fi];
      const timestamp = Math.round(frameIndex * frameDuration);

      drawFrame(ctx, layout, creditText, t, viewOffsetY);

// DEBUG
if (fi < 5) {
  const imageData = ctx.getImageData(0, 0, W, H);
  const data = imageData.data;
  let r = 0, g = 0, b = 0;
  const step = 100; // sample every 100th pixel for speed
  let count = 0;
  for (let i = 0; i < data.length; i += 4 * step) {
    r += data[i]; g += data[i+1]; b += data[i+2];
    count++;
  }
  console.log(`fi=${fi} t=${t.toFixed(2)} avg RGB: ${(r/count)|0} ${(g/count)|0} ${(b/count)|0}`);
}
      const vf = new VideoFrame(canvas, { timestamp, duration: frameDuration });
      // Keyframe every 5s — VP9/AVC keyframes are expensive; 5s is plenty for
      // a static lyrics video and halves the number of costly intra-frame encodes
      // vs. the previous 2s interval.
        encoder.encode(vf, { keyFrame: frameIndex % (videoConfig.framerate * 5) === 0 || fi === 0 });
      vf.close();

      // if ((fi + 1) % PROGRESS_EVERY === 0 || fi === frames.length - 1) {
      self.postMessage({ progress: fi + 1 });
      // }

      // if ((fi + 1) % Math.max(1, Math.round(videoConfig.framerate / 2)) === 0) {
      // console.log(`frame-worker: encoded frame ${frameIndex} (queue=${encoder.encodeQueueSize})`);
      // }
    }

    await encoder.flush();
    console.log('frame-worker: flush complete');
    encoder.close();
    cancelChannel.close();

    // Signal completion — no packet payload, we streamed them already
    self.postMessage({ done: true });

  } catch (err) {
    console.error('frame-worker error:', err);
    self.postMessage({ error: String(err) });
  }
};