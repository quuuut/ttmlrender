// ─── TTML Parser ──────────────────────────────────────────────────────────────
import { state } from './state.js';
import { parseTime } from './utils.js';

const NS     = 'http://www.w3.org/ns/ttml';
const TTM_NS = 'http://www.w3.org/ns/ttml#metadata';

export function parseTTML(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'text/xml');

  const container = document.getElementById('lyrics-container');
  container.innerHTML = '';
  state.spans = [];
  state.lines = [];
  state.breakBars = [];

  const xmlErr = doc.querySelector('parsererror');
  if (xmlErr) {
    const msg = xmlErr.textContent.split('\n')[0].trim();
    container.innerHTML = `<div class="empty-state">
      <div class="big">INVALID FILE</div>
      <div class="sub">The file could not be read as XML.<br><em>${msg}</em><br><br>Make sure the file is a valid .ttml file and try again.</div>
    </div>`;
    return;
  }

  let pEls = doc.getElementsByTagNameNS(NS, 'p');
  if (pEls.length === 0) pEls = doc.getElementsByTagName('p');
  if (pEls.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <div class="big">NO LYRICS FOUND</div>
      <div class="sub">The file was read successfully but contains no lyric lines.<br>Check that it is a TTML lyric file (not a subtitle or caption file) and try again.</div>
    </div>`;
    return;
  }

  Array.from(pEls).forEach((p) => {
    const agent     = p.getAttributeNS(TTM_NS, 'agent') || p.getAttribute('ttm:agent') || 'v1';
    const lineBegin = parseTime(p.getAttribute('begin'));
    const lineEnd   = parseTime(p.getAttribute('end'));

    const tokens = [];

    function collectTokens(node, forceAdlib) {
      node.childNodes.forEach(child => {
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.textContent) tokens.push({ type: 'text', text: child.textContent, isAdlib: !!forceAdlib });
        } else if (child.nodeType === Node.ELEMENT_NODE && child.localName === 'span') {
          const b    = child.getAttribute('begin');
          const e    = child.getAttribute('end');
          const role = child.getAttributeNS(TTM_NS, 'role') || child.getAttribute('ttm:role') || '';
          const isXBg = role === 'x-bg';
          if (role && role !== 'x-bg') return;
          if (isXBg) {
            collectTokens(child, true);
          } else if (b && e) {
            const begin = parseTime(b), end = parseTime(e);
            const text = child.textContent;
            tokens.push({ type: 'span', begin, end, wordDuration: end - begin, text, isAdlib: !!forceAdlib });
          } else {
            collectTokens(child, forceAdlib);
          }
        }
      });
    }
    collectTokens(p, false);

    const hasXBgAdlib = tokens.some(t => t.isAdlib);
    let mainTokens, adlibTokens;
    if (hasXBgAdlib) {
      mainTokens  = tokens.filter(t => !t.isAdlib);
      adlibTokens = tokens.filter(t => t.isAdlib);
      while (mainTokens.length && mainTokens[mainTokens.length - 1].type === 'text') mainTokens.pop();
    } else {
      const fullText = tokens.map(t => t.text).join('').trim();
      const entireLineIsAdlib = fullText.startsWith('(');
      let splitIdx = -1;
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].text && tokens[i].text.includes('(')) { splitIdx = i; break; }
      }
      if (entireLineIsAdlib) {
        mainTokens = []; adlibTokens = tokens;
      } else if (splitIdx >= 0) {
        mainTokens  = tokens.slice(0, splitIdx);
        adlibTokens = tokens.slice(splitIdx);
        while (mainTokens.length && mainTokens[mainTokens.length - 1].type === 'text') mainTokens.pop();
      } else {
        mainTokens = tokens; adlibTokens = [];
      }
    }

    // ── DOM builders ──────────────────────────────────────────────────────────

    function makeSpanEl(tok) {
      const spanEl = document.createElement('span');
      spanEl.className = 'lyric-span';
      spanEl.dataset.begin    = tok.begin;
      spanEl.dataset.end      = tok.end;
      spanEl.dataset.duration = tok.wordDuration;
      spanEl.textContent = tok.text.trimEnd();
      spanEl.style.setProperty('--word-dur', tok.wordDuration.toFixed(3) + 's');
      spanEl.addEventListener('click', () => {
        // Deferred import avoids circular dependency with sync.js
        import('./sync.js').then(m => m.seekToTime(tok.begin));
      });
      state.spans.push({ el: spanEl, begin: tok.begin, end: tok.end, duration: tok.wordDuration, lineEl: null });
      return spanEl;
    }

    function appendSpanWithTrail(parent, tok) {
      parent.appendChild(makeSpanEl(tok));
      const trail = tok.text.match(/\s+$/);
      if (trail) parent.appendChild(document.createTextNode(trail[0]));
    }

    function appendGroupWithTrail(parent, group) {
      const lastTok = group[group.length - 1];
      const trail   = lastTok.text.match(/\s+$/);
      if (group.length === 1) {
        appendSpanWithTrail(parent, group[0]);
      } else {
        const wrapper = document.createElement('span');
        wrapper.className = 'word-group';
        group.forEach(t => wrapper.appendChild(makeSpanEl(t)));
        parent.appendChild(wrapper);
        if (trail) parent.appendChild(document.createTextNode(trail[0]));
      }
    }

    function buildLine(tokenList, isAdlib) {
      const lineEl = document.createElement('div');
      lineEl.className = 'lyric-line' + (isAdlib ? ' adlib' : '');
      lineEl.dataset.agent = agent;
      const spanToks = tokenList.filter(t => t.type === 'span');
      const lb = spanToks.length ? spanToks[0].begin : lineBegin;
      const le = spanToks.length ? spanToks[spanToks.length - 1].end : lineEnd;
      lineEl.dataset.begin = lb;
      lineEl.dataset.end   = le;
      const processedTokens = isAdlib ? stripParensFromTokens(tokenList) : tokenList;

      let i = 0;
      while (i < processedTokens.length) {
        const tok = processedTokens[i];
        if (tok.type === 'text') {
          lineEl.appendChild(document.createTextNode(tok.text));
          i++;
        } else {
          const group = [tok];
          let j = i + 1;
          if (!/\s$/.test(tok.text)) {
            while (j < processedTokens.length) {
              const next = processedTokens[j];
              if (next.type === 'text') {
                if (/\S/.test(next.text)) break;
                const afterSpace = processedTokens[j + 1];
                if (!afterSpace || afterSpace.type !== 'span') break;
                break;
              } else {
                group.push(next);
                j++;
                if (/\s$/.test(next.text)) break;
              }
            }
          }
          if (group.length === 1) appendSpanWithTrail(lineEl, group[0]);
          else appendGroupWithTrail(lineEl, group);
          i = j;
        }
      }
      return { lineEl, begin: lb, end: le };
    }

    if (mainTokens.some(t => t.type === 'span')) {
      const { lineEl, begin, end } = buildLine(mainTokens, false);
      lineEl.querySelectorAll('.lyric-span').forEach(el => {
        const s = state.spans.find(s => s.el === el && s.lineEl === null);
        if (s) s.lineEl = lineEl;
      });
      container.appendChild(lineEl);
      state.lines.push({ el: lineEl, begin, end });
    }

    if (adlibTokens.some(t => t.type === 'span')) {
      const { lineEl, begin, end } = buildLine(adlibTokens, true);
      lineEl.querySelectorAll('.lyric-span').forEach(el => {
        const s = state.spans.find(s => s.el === el && s.lineEl === null);
        if (s) s.lineEl = lineEl;
      });
      container.appendChild(lineEl);
      state.lines.push({ el: lineEl, begin, end });
    }
  });

  // ── Long-word detection ────────────────────────────────────────────────────
  if (state.spans.length > 0) {
    const durations = state.spans.map(s => s.duration).sort((a, b) => a - b);
    const median    = durations[Math.floor(durations.length / 2)];
    const threshold = median * 3;
    state.spans.forEach(s => { s.isLong = s.duration >= threshold; });
  }

  // ── Break bars ─────────────────────────────────────────────────────────────
  state.breakBars = [];
  const BREAK_THRESHOLD = 5;
  for (let i = 0; i < state.lines.length - 1; i++) {
    const gap = state.lines[i + 1].begin - state.lines[i].end;
    if (gap >= BREAK_THRESHOLD) {
      const barEl = document.createElement('div');
      barEl.className = 'break-bar';
      const secs = Math.round(gap);
      barEl.innerHTML = `<div class="break-bar-label">${secs}s</div><div class="break-bar-track"><div class="break-bar-fill"></div></div>`;
      state.lines[i].el.after(barEl);
      state.breakBars.push({
        el: barEl,
        fillEl: barEl.querySelector('.break-bar-fill'),
        start: state.lines[i].end,
        end: state.lines[i + 1].begin,
        gap,
      });
    }
  }

  if (state.lines.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <div class="big">NO TIMED LINES</div>
      <div class="sub">The file was parsed but contained no word-timed lyric lines.<br>This player requires a TTML file with word-level timing (e.g. from Apple Music).</div>
    </div>`;
  }

  // ── Songwriter credits ─────────────────────────────────────────────────────
  const songwriters = Array.from(doc.getElementsByTagName('songwriter'))
    .map(el => el.textContent.trim()).filter(Boolean);
  if (songwriters.length > 0) {
    const credit = document.createElement('div');
    credit.className = 'songwriter-credit';
    credit.textContent = 'Written by: ' + songwriters.join(', ');
    container.appendChild(credit);
  }
}

export function stripParensFromTokens(tokenList) {
  const result = tokenList.map(t => ({ ...t }));
  for (let i = 0; i < result.length; i++) {
    const stripped = result[i].text.replace(/^\s*\(\s*/, '');
    if (stripped !== result[i].text) { result[i].text = stripped; break; }
  }
  for (let i = result.length - 1; i >= 0; i--) {
    const stripped = result[i].text.replace(/\s*\)\s*$/, '');
    if (stripped !== result[i].text) { result[i].text = stripped; break; }
  }
  result.forEach(t => { t.text = t.text.replace(/[()]/g, ''); });
  return result;
}
