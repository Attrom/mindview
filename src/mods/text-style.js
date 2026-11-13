/* @mindview-mod
{
  "id": "text-style",
  "name": "Text styles",
  "version": "2.1.0",
  "kind": "content",
  "description": "Select words in a note or its description to make them bold, italic, handwritten or coloured. Right-click a note to style all of it. Saved with the project.",
  "author": "Mindview",
  "tags": ["Text formatting", "Style"],
  "icon": "M4.5 16L10 4l5.500 12M6.600 11.500h6.800",
  "about": "Make some words stand out: bold, italic, handwritten, or red, green or blue.\n\n- Edit a note's title (click it twice), or click into its description.\n- Select the words you want to change. A small bar appears above them.\n- Pick a style or a colour. Pick it again to take it off, or use × to clear everything.\n- Ctrl+B and Ctrl+I work too.\n\nTo style a whole note at once, right-click it and choose Bold, Italic, Handwritten or Text colour.\n\nThe styles are saved in the project, so people you share it with see them too (they are asked to add this mod).",
  "media": ["select.gif", "result.png"]
}
*/
Mindview.mod(api => {
  const COLORS = { red: '#e5675c', green: '#5fb878', blue: '#5b9df0' };
  const FONT = '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive';
  const KEYS = ['b', 'i', 'h', 'c'];
  // data: { bold, italic, hand, color } for the whole note, plus t / d = { text, runs: [[start, end, {b, i, h, c}]] } for parts of the title / description

  // ---- runs <-> one style per character ----
  const expand = (len, runs) => { const a = new Array(len).fill(null); for (const [s, e, st] of runs || []) for (let i = Math.max(0, s); i < Math.min(len, e); i++) a[i] = st; return a; };
  const same = (x, y) => KEYS.every(k => (x && x[k]) === (y && y[k]));
  function compress(a) {
    const runs = []; let i = 0;
    while (i < a.length) { let j = i; while (j < a.length && same(a[j], a[i])) j++; if (a[i] && KEYS.some(k => a[i][k])) runs.push([i, j, a[i]]); i = j; }
    return runs;
  }
  // the text changed since the styles were set: keep each style on the same words
  function follow(part, text) {
    if (!part || part.text === text) return part;
    const o = part.text; let p = 0; while (p < o.length && p < text.length && o[p] === text[p]) p++;
    let q = 0; while (q < o.length - p && q < text.length - p && o[o.length - 1 - q] === text[text.length - 1 - q]) q++;
    const a = expand(o.length, part.runs), mid = new Array(text.length - p - q).fill(a[p - 1] && p > 0 ? a[p - 1] : null);
    return { text, runs: compress(a.slice(0, p).concat(mid, a.slice(o.length - q))) };
  }

  // ---- drawing ----
  function paint(el, text, part) {
    const runs = part ? part.runs : [];
    const sig = text + '\u0000' + JSON.stringify(runs);
    if (el.dataset.ts === sig) return;
    if (!runs.length && !el.dataset.ts) return; // nothing styled, nothing to undo
    const frag = document.createDocumentFragment(); let at = 0;
    for (const [s, e, st] of runs) {
      if (s > at) frag.appendChild(document.createTextNode(text.slice(at, s)));
      const sp = document.createElement('span'); sp.className = 'ts';
      if (st.b) sp.style.fontWeight = '700';
      if (st.i) sp.style.fontStyle = 'italic';
      if (st.h) sp.style.fontFamily = FONT;
      if (st.c) { sp.style.color = COLORS[st.c] || ''; sp.style.setProperty('--tc', COLORS[st.c] || ''); }
      sp.textContent = text.slice(s, e); frag.appendChild(sp); at = e;
    }
    if (at < text.length) frag.appendChild(document.createTextNode(text.slice(at)));
    el.textContent = ''; el.appendChild(frag);
    el.dataset.ts = runs.length ? sig : '';
  }
  function partFor(note, key, text) {
    const s = api.data(note); if (!s || !s[key]) return null;
    const f = follow(s[key], text);
    if (f !== s[key]) { if (f.runs.length) s[key] = f; else delete s[key]; } // kept in step quietly, saved with the next change
    return f.runs.length ? f : null;
  }
  // called for every note each time the canvas is drawn: set the style, or clear it
  function dress(el, note) {
    const s = api.data(note) || {};
    const t = el.querySelector('.text'); if (!t) return;
    t.style.fontWeight = s.bold ? '700' : '';
    t.style.fontStyle = s.italic ? 'italic' : '';
    t.style.fontFamily = s.hand ? FONT : '';
    t.style.color = s.color ? COLORS[s.color] || '' : '';
    if (!el.classList.contains('editing')) paint(t, note.text || '', partFor(note, 't', note.text || ''));
  }
  api.on('note', dress);
  api.on('body', (el, note) => paint(el, el.textContent, partFor(note, 'd', el.textContent)));
  api.onCleanup(() => {
    for (const n of api.app.notes()) { const el = api.app.element(n.id); if (el) { dress(el, {}); const t = el.querySelector('.text'); if (t && t.dataset.ts) { t.textContent = n.text || ''; t.dataset.ts = ''; } } }
    const b = document.querySelector('#note-body .nb-text'); if (b && b.dataset.ts) { b.textContent = b.textContent; b.dataset.ts = ''; }
  });

  // ---- the whole note, from its right-click menu ----
  const flip = key => note => { const s = Object.assign({}, api.data(note)); if (s[key]) delete s[key]; else s[key] = true; api.setData(note, Object.keys(s).length ? s : undefined); };
  const mark = (key, label) => note => ((api.data(note) || {})[key] ? '✓ ' : '') + label;
  api.addMenuItem(mark('bold', 'Bold'), flip('bold'));
  api.addMenuItem(mark('italic', 'Italic'), flip('italic'));
  api.addMenuItem(mark('hand', 'Handwritten'), flip('hand'));
  api.addMenuItem(note => 'Text colour: ' + ((api.data(note) || {}).color || 'default'), note => {
    const s = Object.assign({}, api.data(note));
    const order = [undefined, 'red', 'green', 'blue'], next = order[(order.indexOf(s.color) + 1) % order.length];
    if (next) s.color = next; else delete s.color;
    api.setData(note, Object.keys(s).length ? s : undefined);
  });

  // ---- selected words: a small bar above the selection ----
  api.addStyle(`
    #ts-bar { position: fixed; z-index: 60; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 9px; background: var(--chrome); border: 1px solid var(--chrome-border); box-shadow: var(--shadow-lg); backdrop-filter: blur(14px); animation: rise .12s var(--ease); }
    #ts-bar[hidden] { display: none; }
    .ts[style*="--tc"]::selection { color: var(--tc); background: color-mix(in srgb, var(--tc) 24%, transparent); } /* the colour shows while the words are still selected */
    #ts-bar button { min-width: 26px; height: 26px; padding: 0 6px; border-radius: 6px; color: var(--text-dim); font-size: 13px; font-weight: 600; line-height: 1; display: grid; place-items: center; }
    #ts-bar button:hover { background: var(--chrome-hover); color: var(--text); }
    #ts-bar button.on { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--text); }
    #ts-bar .dot { width: 13px; height: 13px; border-radius: 50%; background: var(--d); }
    #ts-bar button.on .dot { box-shadow: 0 0 0 2px var(--chrome), 0 0 0 3.5px var(--d); }
    #ts-bar .sep { width: 1px; height: 16px; background: var(--chrome-border); margin: 0 3px; }
    #ts-bar svg { width: 14px; height: 14px; display: block; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
    #ts-bar [data-k="b"] svg { stroke-width: 2.1; }
  `);
  const bar = document.createElement('div'); bar.id = 'ts-bar'; bar.hidden = true;
  const svg = d => `<svg viewBox="0 0 16 16"><path d="${d}"/></svg>`;
  bar.innerHTML = `<button data-k="b">${svg('M5 3h3.8a2.5 2.5 0 010 5H5zM5 8h4.3a2.5 2.5 0 010 5H5z')}</button><button data-k="i">${svg('M7.5 3h4.5M4 13h4.5M9.8 3l-3.6 10')}</button><button data-k="h">${svg('M10.5 6.5C9 4.8 4.5 5.5 4.5 9.4c0 3.2 3.6 3.6 5.6.7l.6-3.6v4.4c0 1.6 1.6 1.9 3 1.1')}</button><span class="sep"></span>`
    + Object.entries(COLORS).map(([k, c]) => `<button data-k="c" data-c="${k}"><span class="dot" style="--d:${c}"></span></button>`).join('')
    + `<span class="sep"></span><button data-k="x"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>`;
  api.addElement(bar);

  // where the selection is: the title being edited, or the description
  function here() {
    const sel = getSelection(); if (!sel.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0), node = r.commonAncestorContainer, elm = node.nodeType === 1 ? node : node.parentElement;
    const title = elm && elm.closest('.node.editing .text'), body = !title && elm && elm.closest('#note-body .nb-text');
    const box = title || body; if (!box) return null;
    const id = title ? title.closest('.node').dataset.id : api.app.selected;
    const note = id && api.app.note(id); if (!note) return null;
    const off = (n, o) => { const x = document.createRange(); x.setStart(box, 0); x.setEnd(n, o); return x.toString().length; };
    const s = off(r.startContainer, r.startOffset), e = off(r.endContainer, r.endOffset);
    return s < e ? { box, note, key: title ? 't' : 'd', s, e, rect: r.getBoundingClientRect() } : null;
  }
  function select(box, s, e) {
    const at = i => { const w = document.createTreeWalker(box, NodeFilter.SHOW_TEXT); let n, left = i; while ((n = w.nextNode())) { if (left <= n.length) return [n, left]; left -= n.length; } return [box, box.childNodes.length]; };
    const r = document.createRange(); r.setStart(...at(s)); r.setEnd(...at(e));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  }
  function show() {
    const h = here(); if (!h) { bar.hidden = true; return; }
    const text = h.box.textContent, part = follow((api.data(h.note) || {})[h.key], text), a = expand(text.length, part && part.runs).slice(h.s, h.e);
    for (const b of bar.querySelectorAll('button')) {
      const k = b.dataset.k;
      b.classList.toggle('on', k !== 'x' && a.every(st => st && (k === 'c' ? st.c === b.dataset.c : st[k])));
    }
    bar.hidden = false;
    const w = bar.offsetWidth, hgt = bar.offsetHeight;
    bar.style.left = Math.max(8, Math.min(innerWidth - w - 8, h.rect.left + h.rect.width / 2 - w / 2)) + 'px';
    bar.style.top = (h.rect.top - hgt - 8 < 50 ? h.rect.bottom + 8 : h.rect.top - hgt - 8) + 'px';
  }
  function apply(k, c) {
    const h = here(); if (!h) return;
    const text = h.box.textContent, data = Object.assign({}, api.data(h.note));
    const a = expand(text.length, (follow(data[h.key], text) || {}).runs);
    const range = a.slice(h.s, h.e), on = k !== 'x' && range.every(st => st && (k === 'c' ? st.c === c : st[k]));
    for (let i = h.s; i < h.e; i++) {
      const st = Object.assign({}, a[i]);
      if (k === 'x') KEYS.forEach(x => delete st[x]);
      else if (on) delete st[k];
      else st[k] = k === 'c' ? c : true;
      a[i] = KEYS.some(x => st[x]) ? st : null;
    }
    const runs = compress(a);
    if (runs.length) data[h.key] = { text, runs }; else delete data[h.key];
    if (k === 'x' && h.key === 't' && h.s === 0 && h.e === text.length) ['bold', 'italic', 'hand', 'color'].forEach(x => delete data[x]);
    const { box, s, e, key, note } = h;
    api.setData(note, Object.keys(data).length ? data : undefined);
    paint(box, text, runs.length ? data[key] : null); // the box being typed in is not redrawn by the app
    box.focus(); select(box, s, e); show();
  }
  bar.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); }); // keep the words selected
  bar.addEventListener('click', e => { const b = e.target.closest('button'); if (b) apply(b.dataset.k, b.dataset.c); });
  const onSel = () => show();
  document.addEventListener('selectionchange', onSel);
  api.onCleanup(() => document.removeEventListener('selectionchange', onSel));
  api.addKey('ctrl+b', () => apply('b'));
  api.addKey('ctrl+i', () => apply('i'));
});
