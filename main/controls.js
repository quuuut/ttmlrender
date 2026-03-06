// ─── Playback Controls ────────────────────────────────────────────────────────
import { state } from './state.js';
import { startPlayback, ensureContext } from './audio.js';
import { syncLoop, seekToTime } from './sync.js';
import { formatTime } from './utils.js';

const btnPlay  = document.getElementById('btn-play');
const playIcon = document.getElementById('play-icon');

export function checkReady() {
  const ready = state.spans.length > 0 && state.audioBuffer !== null;
  document.getElementById('btn-play').disabled    = !ready;
  document.getElementById('seek-bar').disabled    = !ready;
  document.getElementById('btn-render').disabled  = !ready;
}

export function initControls() {
  btnPlay.addEventListener('click', () => {
    if (!state.audioBuffer) return;
    if (!state.isPlaying) {
      startPlayback(state.pausedAt);
      playIcon.setAttribute('points', '4,2 8,2 8,14 4,14 M10,2 14,2 14,14 10,14');
      if (!state.rafId) syncLoop();
    } else {
      state.pausedAt = state.actx.currentTime - state.startedAt;
      state.isPlaying = false;
      try { state.sourceNode.stop(); } catch (e) {}
      playIcon.setAttribute('points', '4,2 14,8 4,14');
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
  });

  document.getElementById('seek-bar').addEventListener('input', (e) => {
    seekToTime(parseFloat(e.target.value));
  });
}
