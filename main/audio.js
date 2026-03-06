// ─── Web Audio Engine ─────────────────────────────────────────────────────────
import { state } from './state.js';

export function ensureContext() {
  if (!state.actx) state.actx = new (window.AudioContext || window.webkitAudioContext)();
  if (state.actx.state === 'suspended') state.actx.resume();
}

export function startPlayback(offset) {
  ensureContext();
  const gen = ++state.playGeneration;
  if (state.sourceNode) { try { state.sourceNode.stop(); } catch (e) {} }
  state.sourceNode = state.actx.createBufferSource();
  state.sourceNode.buffer = state.audioBuffer;
  state.sourceNode.connect(state.actx.destination);
  state.sourceNode.onended = () => {
    if (gen !== state.playGeneration) return;
    if (state.isPlaying) {
      state.isPlaying = false;
      state.pausedAt  = 0;
      document.getElementById('play-icon').setAttribute('points', '4,2 14,8 4,14');
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
      document.getElementById('seek-bar').value = 0;
      document.getElementById('current-time').textContent = '0:00';
      state.activeSpanSet = new Set();
      state.activeLineSet = new Set();
      state.spans.forEach(s => s.el.classList.remove('active', 'long-word', 'past'));
      state.lines.forEach(l => l.el.classList.remove('active-line'));
      state.breakBars.forEach(b => { b.fillEl.style.width = '0%'; b.el.style.opacity = '0.3'; });
    }
  };
  state.startedAt = state.actx.currentTime - offset;
  state.sourceNode.start(0, offset);
  state.isPlaying = true;
}