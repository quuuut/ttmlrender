// ─── Time helpers ─────────────────────────────────────────────────────────────

export function parseTime(str) {
  if (!str) return 0;
  const parts = str.split(':');
  let secs = 0;
  if (parts.length === 3) {
    secs = (+parts[0]) * 3600 + (+parts[1]) * 60 + parseFloat(parts[2]);
  } else if (parts.length === 2) {
    secs = (+parts[0]) * 60 + parseFloat(parts[1]);
  } else {
    secs = parseFloat(parts[0]);
  }
  return secs;
}

export function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
