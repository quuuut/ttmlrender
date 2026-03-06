// ─── File Upload & Drop Handlers ─────────────────────────────────────────────
import { state } from './state.js';
import { parseTTML } from './ttml-parser.js';
import { ensureContext } from './audio.js';
import { checkReady } from './controls.js';
import { formatTime } from './utils.js';

export function initUploads() {
  // ── TTML file ──────────────────────────────────────────────────────────────
  document.getElementById('ttml-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById('ttml-hint').style.display = 'none';
    const nameEl = document.getElementById('ttml-name');
    nameEl.textContent = file.name;
    nameEl.style.display = 'block';
    const reader = new FileReader();
    reader.onload = (ev) => { parseTTML(ev.target.result); checkReady(); };
    reader.readAsText(file);
  });

  // ── Audio file ─────────────────────────────────────────────────────────────
  document.getElementById('audio-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById('audio-hint').style.display = 'none';
    const nameEl = document.getElementById('audio-name');
    nameEl.textContent = file.name;
    nameEl.style.display = 'block';
    document.getElementById('total-time').textContent = '…';
    const reader = new FileReader();
    reader.onload = async (ev) => {
      ensureContext();
      try {
        state.audioBuffer = await state.actx.decodeAudioData(ev.target.result);
        state.duration = state.audioBuffer.duration;
        document.getElementById('total-time').textContent = formatTime(state.duration);
        document.getElementById('seek-bar').max = state.duration;
        checkReady();
      } catch (err) {
        document.getElementById('total-time').textContent = 'ERR';
        console.error('Audio decode error:', err);
      }
    };
    reader.readAsArrayBuffer(file);
  });

  // ── Drag & drop zones ──────────────────────────────────────────────────────
  ['ttml-drop', 'audio-drop'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('dragover',  (e) => { e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', ()  => el.classList.remove('drag-over'));
    el.addEventListener('drop',      (e) => { e.preventDefault(); el.classList.remove('drag-over'); });
  });
}
