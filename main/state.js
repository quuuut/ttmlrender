// ─── Shared mutable state ─────────────────────────────────────────────────────
// All modules import from here so they all reference the same arrays/objects.

export const state = {
  // Lyric data
  spans: [],
  lines: [],
  breakBars: [],

  // Sync loop
  rafId: null,
  activeSpanSet: new Set(),
  activeLineSet: new Set(),

  // Web Audio
  actx: null,
  audioBuffer: null,
  sourceNode: null,
  isPlaying: false,
  startedAt: 0,
  pausedAt: 0,
  duration: 0,
  playGeneration: 0,
};
