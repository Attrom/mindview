'use strict';

/* =========================================================
   The Phone Calls · Notes — a tree of notes on a canvas
   ========================================================= */

const COLORS = [
  { key: 'none',   name: 'Plain',  dark: null,      light: null },
  { key: 'amber',  name: 'Amber',  dark: '#e8b04b', light: '#d1961f' },
  { key: 'red',    name: 'Red',    dark: '#e5675c', light: '#d4483c' },
  { key: 'pink',   name: 'Pink',   dark: '#e07ab0', light: '#cc5592' },
  { key: 'violet', name: 'Violet', dark: '#9d86f0', light: '#7a5fe0' },
  { key: 'blue',   name: 'Blue',   dark: '#5b9cf0', light: '#3a7fdc' },
  { key: 'teal',   name: 'Teal',   dark: '#3ec1b5', light: '#1fa094' },
  { key: 'green',  name: 'Green',  dark: '#7dc36b', light: '#55a443' },
];
const SIZES = ['sm', 'md', 'lg'];
const GAP_X = 70, GAP_Y = 16, ROOT_GAP = 56;
const MIN_K = 0.12, MAX_K = 3;

const host = window.desktop || null;
if (host) document.body.classList.add("desktop");

/* ---------------- storage: one file per project ---------------- */
// In the desktop app this goes to projects\<id>.json; in a plain browser it uses localStorage.
const store = host ? {
  list: () => host.listProjects(),
  load: id => host.load(id),
  save: (id, t) => host.save(id, t),
  saveSync: (id, t) => host.saveSync(id, t),
  create: name => host.createProject(name),
  remove: id => host.deleteProject(id),
  settings: () => host.getSettings() || {},
  setSettings: patch => host.setSettings(patch),
} : (() => {
  const key = id => 'nc-project:' + id;
  const S = () => JSON.parse(localStorage.getItem('nc-settings') || '{}');
  const api = {
    list() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k.startsWith('nc-project:')) continue;
        try { const d = JSON.parse(localStorage.getItem(k)); out.push({ id: k.slice(11), name: d.name || k.slice(11), notes: Object.keys(d.nodes || {}).length, updated: d.updated || 0 }); } catch {}
      }
      return out.sort((a, b) => b.updated - a.updated);
    },
    load: id => localStorage.getItem(key(id)),
    save: async (id, t) => localStorage.setItem(key(id), t),
    saveSync: (id, t) => localStorage.setItem(key(id), t),
    create(name) {
      let base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project', id = base, i = 2;
      while (localStorage.getItem(key(id))) id = `${base}-${i++}`;
      localStorage.setItem(key(id), JSON.stringify({ version: 1, name, view: { x: 0, y: 0, k: 1 }, nodes: {} }));
      return id;
    },
    remove: id => { localStorage.removeItem(key(id)); return true; },
    settings: S,
    setSettings: patch => localStorage.setItem('nc-settings', JSON.stringify(Object.assign(S(), patch))),
  };
  const legacy = localStorage.getItem('phonecalls-board'); // older single-board preview data
  if (legacy && !api.list().length) {
    const d = JSON.parse(legacy); d.name = d.name || 'The Phone Calls';
    localStorage.setItem(key('the-phone-calls'), JSON.stringify(d));
    localStorage.removeItem('phonecalls-board');
  }
  return api;
})();
const settings = store.settings();
let uiTheme = settings.theme === 'light' ? 'light' : 'dark';
let currentId = null;

/* ---------------- state ---------------- */

let doc = { version: 1, theme: 'dark', view: { x: 0, y: 0, k: 1 }, nodes: {}, sections: {} };
let selectedId = null;
let editingId = null;
const multi = new Set(); // notes picked together with the selection rectangle
let nodeMenuFor = null; // note whose right-click menu is open (its size/colour bar shows with it)
let freshId = null;          // note just created; deleted if left empty
const sizeCache = {};        // id -> {w,h}
const els = {};              // id -> element
const undoStack = [], redoStack = [];

const $ = s => document.querySelector(s);
const viewport = $('#viewport'), world = $('#world'), nodesLayer = $('#nodes');
const edgesSvg = $('#edges'), grid = $('#grid'), sectionsLayer = $('#sections');
const toolbar = $('#node-toolbar');

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const N = id => doc.nodes[id];
const all = () => Object.values(doc.nodes);
const childrenOf = id => all().filter(n => n.parentId === id).sort((a, b) => a.y - b.y || a.x - b.x);
const roots = () => all().filter(n => !n.parentId || !N(n.parentId));
const colorOf = n => {
  const c = COLORS.find(c => c.key === n.color);
  return c ? c[uiTheme] : null;
};
function descendants(id, out = []) {
  for (const c of childrenOf(id)) { out.push(c.id); descendants(c.id, out); }
  return out;
}
/* ---- zoom-based unfolding: deeper levels appear as you zoom in ---- */
function depthOf(n) {
  let d = 0, p = n.parentId && N(n.parentId);
  while (p && d < 99) { d++; p = p.parentId && N(p.parentId); }
  return d;
}
// a level unfolds once its text is big enough to read; before that its parent shows a +N badge.
// Roots and their children always show.
const READ_PX = 8.5; // smallest text worth showing, in screen pixels
// on-screen font size of a tree note at depth d and zoom k (same rules as computeScales)
function levelScreenPx(d, k) {
  let font = 0;
  for (let i = 0; i <= d; i++) {
    const cls = treeClass(i);
    let f = TREE_PX(i) * (k >= 1 ? 1 : Math.min(6, Math.pow(k, SHRINK[cls] - 1)));
    if (i) f = Math.max(Math.min(f, font * CHILD_RATIO), Math.min(MIN_FONT, font * CHILD_RATIO));
    font = f;
  }
  return font * k;
}
const textZoomCache = [];
function textZoom(d) { // zoom at which depth d becomes readable
  if (textZoomCache[d] !== undefined) return textZoomCache[d];
  let lo = 0.01, hi = 50;
  if (levelScreenPx(d, lo) >= READ_PX) hi = lo;
  for (let i = 0; i < 50 && hi - lo > 1e-4; i++) { const m = (lo + hi) / 2; if (levelScreenPx(d, m) >= READ_PX) hi = m; else lo = m; }
  return (textZoomCache[d] = hi);
}
const revealZoom = d => (d <= 1 ? 0 : textZoom(d)); // a level unfolds once its own text is readable; until then its parent shows +N
const startZoom = d => (d <= 1 ? 0 : revealZoom(d) * 0.95); // short unfold, no long half-faded stage
const fullZoom = d => (d <= 1 ? 0 : revealZoom(d));
let forcedDepth = null;
function levelP(d, k = doc.view.k) {
  if (forcedDepth !== null) return d <= forcedDepth ? 1 : 0;
  if (d <= 1) return 1;
  const a = startZoom(d), b = fullZoom(d);
  return Math.min(1, Math.max(0, (k - a) / (b - a)));
}
const maxDepthAt = k => { let d = 1; while (d < 60 && k > startZoom(d + 1)) d++; return d; };
const maxDepth = () => (forcedDepth !== null ? forcedDepth : maxDepthAt(doc.view.k));
let lastPointer = null; // where the cursor is, so zooming keeps that spot steady
const pOf = n => levelP(depthOf(n));
const isHidden = n => pOf(n) < 1; // levels only show once fully unfolded
const kidsHidden = n => levelP(depthOf(n) + 1) <= 0;
function isAncestor(a, b) { // is a an ancestor of b?
  let p = N(b) && N(b).parentId;
  while (p) { if (p === a) return true; p = N(p) && N(p).parentId; }
  return false;
}
const size = id => sizeCache[id] || { w: 160, h: 40 };

/* ---------------- persistence ---------------- */

function serialize() {
  if (typeof computeRequires === 'function' && modMetas) { const r = computeRequires(); if (r.length) doc.requires = r; else delete doc.requires; }
  return JSON.stringify({ ...doc, nodes: canonNodes() }, null, 1);
}

let migrated = false; const wasFolded = [];
function load(id) {
  let text = null;
  try { text = store.load(id); } catch {}
  if (text) {
    try {
      const d = JSON.parse(text);
      if (d && d.nodes) doc = Object.assign(doc, d);
    } catch (e) { console.error('Could not read board', e); }
  }
  doc.view = doc.view || { x: 0, y: 0, k: 1 };
  if (!doc.sections || typeof doc.sections !== 'object') doc.sections = {};
  for (const sec of Object.values(doc.sections)) {
    for (const k of ['x', 'y', 'w', 'h']) sec[k] = Number(sec[k]) || 0;
    sec.label = sec.label || ''; sec.color = sec.color || 'none';
  }
  for (const n of all()) {
    n.size = SIZES.includes(n.size) ? n.size : 'md';
    n.text = n.text || '';
    if ('collapsed' in n) { if (n.collapsed) wasFolded.push(n.id); delete n.collapsed; migrated = true; } // folding is now driven by zoom
  }
  doc.links = Array.isArray(doc.links) ? doc.links.filter(L => N(L.a) && N(L.b) && L.a !== L.b) : [];
}
// notes under the same parent all share one size (the largest one among them)
const RANK = { sm: 0, md: 1, lg: 2 };
function unifySiblingSizes() {
  const groups = {};
  for (const n of all()) if (n.parentId && N(n.parentId)) (groups[n.parentId] = groups[n.parentId] || []).push(n);
  for (const g of Object.values(groups)) {
    const top = g.reduce((a, n) => (RANK[n.size] > RANK[a] ? n.size : a), 'sm');
    for (const n of g) n.size = top;
  }
}
const siblingsOf = n => (n.parentId && N(n.parentId) ? all().filter(o => o.parentId === n.parentId) : [n]);

let saveTimer = null;
const saveState = $('#save-state');
function scheduleSave() {
  saveState.textContent = 'Saving…'; saveState.className = 'save-state saving';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 350);
}
async function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  try {
    if (!currentId) return;
    doc.updated = Date.now();
    await store.save(currentId, serialize());
    saveState.textContent = 'Saved'; saveState.className = 'save-state';
    if (shareState && shareState.linked) { clearTimeout(shareDotTimer); shareDotTimer = setTimeout(refreshShare, 1200); }
  } catch (e) {
    console.error(e);
    saveState.textContent = 'Not saved!'; saveState.className = 'save-state error';
  }
}
window.addEventListener('beforeunload', () => {
  if (editingId) commitEdit();
  if (editingSection) finishSectionLabel(true);
  if (currentId) store.saveSync(currentId, serialize());
});

/* ---------------- history ---------------- */

function snapshot() { return JSON.stringify({ n: canonNodes(), l: doc.links || [], s: doc.sections || {} }); }
function checkpoint() {
  undoStack.push(snapshot());
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;
}
function restore(from, to) {
  if (!from.length) return;
  if (editingId) finishEditing(false);
  to.push(snapshot());
  if (editingSection) finishSectionLabel(false);
  const snap = JSON.parse(from.pop());
  if (snap && snap.n) { doc.nodes = snap.n; doc.links = snap.l || []; doc.sections = snap.s || {}; } else doc.nodes = snap;
  if (selectedId && !N(selectedId)) selectedId = null;
  if (selectedLink && !linkById(selectedLink)) selectedLink = null;
  if (selectedSection && !SEC(selectedSection)) selectedSection = null;
  render(); fromCanon(); render(); scheduleSave();
}
const undo = () => restore(undoStack, redoStack);
const redo = () => restore(redoStack, undoStack);

/* ---------------- snapping while dragging ---------------- */
// Ctrl held: the note lands on the grid (the dots). Otherwise it lines up with the notes it is connected to when close.
const GRID = 24;
function snapMove(d, ox, oy, onGrid) {
  const s0 = d.start[d.id], sz = size(d.id), guides = [];
  let nx = s0.x + ox, ny = s0.y + oy;
  if (onGrid) return { x: Math.round((nx + sz.w / 2) / GRID) * GRID - sz.w / 2 - s0.x, y: Math.round((ny + sz.h / 2) / GRID) * GRID - sz.h / 2 - s0.y, guides }; // the note's centre lands on a grid point
  const me = N(d.id), th = 8 / view().k;
  const linked = new Set([me.parentId, ...childrenOf(d.id).map(c => c.id), ...doc.links.flatMap(L => L.a === d.id ? [L.b] : L.b === d.id ? [L.a] : [])]);
  let bx = null, by = null;
  for (const id of linked) {
    const c = N(id); if (!c || d.exclude.has(id) || !els[id] || els[id].classList.contains('zhide')) continue;
    const cs = size(id);
    for (const [t, line] of [[c.y + cs.h / 2 - sz.h / 2, 'mid'], [c.y, 'top'], [c.y + cs.h - sz.h, 'bottom']]) { const dd = Math.abs(ny - t); if (dd < th && (!by || dd < by.dd)) by = { dd, t, c, cs, line }; }
    for (const [t, line] of [[c.x + cs.w / 2 - sz.w / 2, 'mid'], [c.x, 'left'], [c.x + cs.w - sz.w, 'right']]) { const dd = Math.abs(nx - t); if (dd < th && (!bx || dd < bx.dd)) bx = { dd, t, c, cs, line }; }
  }
  if (by) { ny = by.t; const y = by.line === 'mid' ? ny + sz.h / 2 : by.line === 'top' ? ny : ny + sz.h; guides.push(`M${Math.min(nx, by.c.x)} ${y}H${Math.max(nx + sz.w, by.c.x + by.cs.w)}`); }
  if (bx) { nx = bx.t; const x = bx.line === 'mid' ? nx + sz.w / 2 : bx.line === 'left' ? nx : nx + sz.w; guides.push(`M${x} ${Math.min(ny, bx.c.y)}V${Math.max(ny + sz.h, bx.c.y + bx.cs.h)}`); }
  return { x: nx - s0.x, y: ny - s0.y, guides };
}

/* ---------------- view transform ---------------- */

const view = () => doc.view;
function paintView() {
  const { x, y, k } = view();
  world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  world.style.setProperty('--k', k);
  const g = 24 * k;
  grid.style.backgroundSize = `${g}px ${g}px`;
  grid.style.backgroundPosition = `${x}px ${y}px`;
  grid.style.opacity = k < 0.35 ? 0 : 1;
  $('#z-level').textContent = Math.round(k * 100) + '%';
}
let lastK = null, lastDepth = null, inZoomUpdate = false;
function applyView() {
  paintView();
  if (view().k !== lastK && !inZoomUpdate) {
    inZoomUpdate = true;
    try { onZoomChange(); } finally { inZoomUpdate = false; }
    lastK = view().k;
    paintView();
  }
  positionToolbar();
  positionLinkToolbar();
  paintRootMarkers();
  positionSectionToolbar();
}

/* ---- readable at any zoom: notes shrink slower than the canvas,
        and a note is never bigger than its parent ---- */
const BASE_PX = { sm: 13.5, md: 16, lg: 21 };
const SHRINK = { sm: 0.5, md: 0.38, lg: 0.28 }; // 1 = shrinks with the canvas, 0 = never shrinks
const CHILD_RATIO = 0.74, MIN_FONT = 7;
// tree notes are sized by their level (root biggest); free-standing notes use S/M/L
const TREE_PX = d => Math.max(8, 28 * Math.pow(0.74, d)); // each level about a quarter smaller than its parent
const treeClass = d => (d === 0 ? 'lg' : d === 1 ? 'md' : 'sm');
const isTree = n => !!(n.parentId && N(n.parentId)) || all().some(o => o.parentId === n.id);
function classOf(n, hasKids) {
  const inTree = (n.parentId && N(n.parentId)) || hasKids;
  return inTree ? treeClass(depthOf(n)) : n.size;
}
function computeScales(k) {
  const kids = {};
  for (const n of all()) { const pid = n.parentId && N(n.parentId) ? n.parentId : '_'; (kids[pid] = kids[pid] || []).push(n); }
  const out = {};
  const grow = cls => (k >= 1 ? 1 : Math.min(6, Math.pow(k, SHRINK[cls] - 1)));
  const visit = (n, parentFont, d) => {
    const inTree = d > 0 || (kids[n.id] || []).length > 0;
    const cls = inTree ? treeClass(d) : n.size;
    let font = (inTree ? TREE_PX(d) : BASE_PX[cls]) * grow(cls);
    if (parentFont) font = Math.max(Math.min(font, parentFont * CHILD_RATIO), Math.min(MIN_FONT, parentFont * CHILD_RATIO));
    out[n.id] = font / BASE_PX[cls];
    if (d < 60) for (const c of kids[n.id] || []) visit(c, font, d + 1);
  };
  for (const r of kids['_'] || []) visit(r, 0, 0);
  return out;
}
const scaleNow = {};
// set each note's size for zoom k; returns ids whose size changed noticeably
function applyScales(k, exact) {
  const changed = [], sc = computeScales(k);
  for (const id in sc) {
    const el = els[id]; if (!el) continue;
    const old = scaleNow[id];
    if (old === undefined || exact ? old !== sc[id] : Math.abs(sc[id] / old - 1) > 0.008) {
      scaleNow[id] = sc[id]; el.style.setProperty('--s', sc[id].toFixed(4)); changed.push(id);
    }
  }
  paintText();
  return changed;
}
// too small to read: keep the box, hide the words
function paintText() {
  const k = view().k;
  for (const id in els) {
    const el = els[id], cls = el.classList.contains('lg') ? 'lg' : el.classList.contains('md') ? 'md' : 'sm';
    const px = (scaleNow[id] || 1) * BASE_PX[cls] * k;
    el.classList.toggle('notext', id !== editingId && id !== freshId && px < READ_PX * 0.9);
  }
}
function paintLevels() {
  for (const n of all()) {
    const el = els[n.id]; if (!el) continue;
    const pinned = n.id === editingId || n.id === freshId;
    const pv = pinned ? 1 : pOf(n) >= 1 ? 1 : 0; // a level pops in once fully unfolded (no half-faded stage)
    el.style.setProperty('--p', pv);
    el.classList.toggle('zhide', pv <= 0);
  }
}
let gestureAnchor = null, gestureTimer = null;
// runs on every zoom change: fade levels in/out, resize notes, reflow the tree
function onZoomChange() {
  const k = view().k;
  const md = maxDepthAt(k) * 2 + (levelP(maxDepthAt(k), k) >= 1 ? 1 : 0); // also re-render when a level finishes unfolding (badges)
  if (md !== lastDepth) {
    lastDepth = md;
    if (editingId && editingId !== freshId && isHidden(N(editingId))) commitEdit();
    render(); // badges + visibility
  }
  const anchor = !viewAnimating && !noteDragging()
    ? (gestureAnchor && N(gestureAnchor) && !isHidden(N(gestureAnchor)) ? gestureAnchor : (gestureAnchor = anchorNote()))
    : null;
  clearTimeout(gestureTimer); gestureTimer = setTimeout(() => (gestureAnchor = null), 250);
  const pre = anchor && centerOnScreen(anchor);
  const before = {};
  for (const id in sizeCache) before[id] = sizeCache[id];
  paintLevels();
  const changed = applyScales(k);
  if (changed.length) measure();
  if (noteDragging()) { drawEdges(); return; }
  cancelAnimationFrame(layoutAnim);
  const pos = layoutTargets();
  for (const id in pos) {
    const n = N(id); if (!n) continue;
    putAt(n, pos[id]);
    if (els[id]) { els[id].style.left = n.x + 'px'; els[id].style.top = n.y + 'px'; }
  }
  if (anchor) { // keep the note under the cursor still
    const after = centerOnScreen(anchor);
    view().x += pre.x - after.x; view().y += pre.y - after.y;
  }
  void before; void changed;
  drawEdges();
}
function toWorld(cx, cy) {
  const { x, y, k } = view();
  return { x: (cx - x) / k, y: (cy - y) / k };
}
function toScreen(wx, wy) {
  const { x, y, k } = view();
  return { x: wx * k + x, y: wy * k + y };
}
let viewSaveTimer = null;
let settleTimer = null;
function viewChanged() {
  world.classList.add('moving');
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => world.classList.remove('moving'), 180);
  applyView();
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(scheduleSave, 600);
}
function zoomAt(cx, cy, factor) {
  const v = view();
  const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
  const f = k / v.k;
  v.x = cx - (cx - v.x) * f;
  v.y = cy - (cy - v.y) * f;
  v.k = k;
  viewChanged();
}
let viewAnim = null;
let viewAnimating = false;
function animateView(target, ms = 320) {
  cancelAnimationFrame(viewAnim);
  viewAnimating = true;
  const from = { ...view() }, t0 = performance.now();
  const step = now => {
    const t = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - t, 3);
    const v = view();
    v.x = from.x + (target.x - from.x) * e;
    v.y = from.y + (target.y - from.y) * e;
    v.k = from.k + (target.k - from.k) * e;
    viewChanged();
    if (t < 1) viewAnim = requestAnimationFrame(step); else viewAnimating = false;
  };
  viewAnim = requestAnimationFrame(step);
}
function zoomCenter(factor) {
  lastPointer = { x: innerWidth / 2, y: innerHeight / 2 };
  const v = view();
  const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
  const cx = innerWidth / 2, cy = innerHeight / 2, f = k / v.k;
  animateView({ x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f, k }, 180);
}
// bounds of what shows at depth d (using the tidy layout for that depth when auto-arrange is on)
function boundsAtDepth(d) {
  forcedDepth = d;
  const pos = layoutTargets();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of all()) {
    if (depthOf(n) > d) continue;
    const s = size(n.id), p = pos ? pos[n.id] : n;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + s.w); y1 = Math.max(y1, p.y + s.h);
  }
  for (const sec of allSections()) {
    x0 = Math.min(x0, sec.x); y0 = Math.min(y0, sec.y);
    x1 = Math.max(x1, sec.x + sec.w); y1 = Math.max(y1, sec.y + sec.h);
  }
  forcedDepth = null;
  return { x0, y0, x1, y1 };
}
function fitAll(animate = true) {
  if (!all().length && !allSections().length) { animateView({ x: innerWidth / 2, y: innerHeight / 2, k: 1 }); return; }
  const pad = 80, top = 44;
  const W = innerWidth - pad * 2, H = innerHeight - top - pad * 2;
  const deepest = Math.max(1, ...all().map(depthOf));
  let x0, y0, x1, y1, k;
  // show the deepest level whose whole tree still fits on screen
  for (let d = deepest; d >= 1; d--) {
    k = view().k;
    for (let it = 0; it < 4; it++) { // notes grow when zoomed out, so settle on a zoom
      applyScales(k); measure();
      ({ x0, y0, x1, y1 } = boundsAtDepth(d));
      k = Math.min(1.1, Math.max(MIN_K, Math.min(W / (x1 - x0), H / (y1 - y0))));
    }
    if (d === 1 || k >= fullZoom(d)) { k = Math.max(k, fullZoom(d)); if (d < deepest) k = Math.min(k, startZoom(d + 1) - 0.001); break; }
  }
  const target = {
    k,
    x: innerWidth / 2 - ((x0 + x1) / 2) * k,
    y: top + (innerHeight - top) / 2 - ((y0 + y1) / 2) * k,
  };
  applyScales(view().k, true); measure();
  if (animate) animateView(target); else { Object.assign(view(), target); viewChanged(); }
}
function ensureVisible(id) {
  const n = N(id); if (!n) return;
  const s = size(id), k = view().k;
  const a = toScreen(n.x, n.y), b = toScreen(n.x + s.w, n.y + s.h);
  const m = 60, top = 44 + 60;
  let dx = 0, dy = 0;
  if (b.x > innerWidth - m) dx = innerWidth - m - b.x;
  if (a.x + dx < m) dx = m - a.x;
  if (b.y > innerHeight - m) dy = innerHeight - m - b.y;
  if (a.y + dy < top) dy = top - a.y;
  if (dx || dy) animateView({ x: view().x + dx, y: view().y + dy, k }, 260);
}

/* ---------------- rendering ---------------- */

function render() {
  const live = new Set();
  for (const n of all()) {
    live.add(n.id);
    let el = els[n.id];
    if (!el) {
      el = document.createElement('div');
      el.className = 'node';
      el.dataset.id = n.id;
      el.innerHTML = '<div class="text" data-ph="Write something…"></div><div class="handle" title="Drag to connect, click to add"></div>';
      nodesLayer.appendChild(el);
      els[n.id] = el;
    }
    const kids = childrenOf(n.id);
    el.classList.remove('sm', 'md', 'lg');
    el.classList.add(classOf(n, kids.length > 0));

    el.classList.toggle('selected', n.id === selectedId);
    el.classList.toggle('msel', multi.has(n.id));
    const folded = kids.length > 0 && levelP(depthOf(n) + 1) < 1; // +N stays until the children have fully unfolded
    el.classList.toggle('collapsed', folded);
    const pv = n.id === editingId || n.id === freshId ? 1 : pOf(n) >= 1 ? 1 : 0;
    el.style.setProperty('--p', pv);
    el.classList.toggle('zhide', pv <= 0);
    const c = colorOf(n);
    if (c) el.style.setProperty('--c', c); else el.style.removeProperty('--c');
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    const t = el.firstChild;
    if (n.id !== editingId && t.textContent !== n.text) t.textContent = n.text;
    let fold = el.querySelector('.fold');
    if (folded) {
      if (!fold) { fold = document.createElement('div'); fold.className = 'fold'; el.appendChild(fold); }
      const count = descendants(n.id).length;
      fold.textContent = '+' + count;
      fold.title = `${count} more note${count > 1 ? 's' : ''}. Zoom in, or click to zoom into this branch`;
    } else if (fold) fold.remove();
    paintThumbs(el, n.images, 'note');
    el.classList.toggle('has-url', !!n.url);
    el.classList.toggle('has-imgs', !!(n.images && n.images.length));
    let bm = el.querySelector('.body-mark');
    const hasBody = !!(n.body && n.body.trim()), hasBodyImgs = false; // no marker for pictures kept in the body
    el.classList.toggle('has-body', hasBody || hasBodyImgs);
    if (hasBody || hasBodyImgs) {
      if (!bm) { bm = document.createElement('div'); bm.className = 'body-mark'; el.appendChild(bm); }
      const html = (hasBody ? '<svg viewBox="0 0 16 16"><path d="M4 5h8M4 8h8M4 11h5"/></svg>' : '') + (hasBodyImgs ? '<svg viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><path d="M3 11l3.2-3.2 2.3 2.3 1.6-1.6L13 11.5"/><circle cx="10.3" cy="6.3" r=".9"/></svg>' : '');
      if (bm.dataset.k !== html) { bm.innerHTML = html; bm.dataset.k = html; }
      bm.title = 'Has more ' + (hasBody && hasBodyImgs ? 'text and images' : hasBody ? 'text' : 'images') + ': click the note to see it';
    } else if (bm) bm.remove();
    const jumps = jumpTargets(n.id);
    let jb = el.querySelector('.jump');
    if (jumps.length) {
      if (!jb) { jb = document.createElement('div'); jb.className = 'jump'; el.appendChild(jb); }
      jb.innerHTML = '<svg viewBox="0 0 16 16"><path d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.5 2.5 0 013.5 3.5L10.5 8M9 11.5l-1.2 1.2a2.5 2.5 0 01-3.5-3.5L5.5 8"/></svg>' + (jumps.length > 1 ? `<span>${jumps.length}</span>` : '');
      jb.title = jumps.length === 1 ? `Jump to “${firstLine(N(jumps[0]).text)}” (right-click for options)` : `${jumps.length} linked notes`;
    } else if (jb) jb.remove();
  }
  for (const id of Object.keys(els)) {
    if (!live.has(id)) { if (els[id].contains(bodyPanel)) { bodyShell = null; bodyFor = null; bodyPanel.hidden = true; document.body.appendChild(bodyPanel); } els[id].remove(); delete els[id]; delete sizeCache[id]; }
  }
  if (modLive.size) { for (const n of all()) if (els[n.id]) modEmit('note', els[n.id], n); modEmit('render'); } // mods dress the notes before they are measured
  if (window.findHook) window.findHook(); // keep search matches lit after a redraw
  applyScales(view().k, true);
  measure();
  drawEdges();
  renderSections();
  $('#empty').hidden = all().length > 0 || allSections().length > 0;
  updateToolbar();
}

// siblings get the same width: the widest one's natural width
// tree notes get a width set by their level (in em of their own font, so a child is always
// narrower than its parent); free notes keep their natural width
const TREE_EM = d => (d === 0 ? 11 : 12);
function measure() {
  const tree = new Set();
  for (const n of all()) if (n.parentId && N(n.parentId)) { tree.add(n.id); tree.add(n.parentId); }
  for (const id in els) {
    const n = N(id);
    els[id].style.width = n && tree.has(id) ? TREE_EM(depthOf(n)) + 'em' : '';
  }
  for (const id in els) {
    const el = els[id], z = { w: el.offsetWidth, h: el.offsetHeight }, old = sizeCache[id], n = N(id), sc = scaleNow[id] || 1;
    // a free note that grew or shrank with the zoom does so around its centre, so notes lined up at one zoom stay lined up at every zoom
    if (n && old && !tree.has(id) && measuredScale[id] !== undefined && measuredScale[id] !== sc && id !== (dragState && dragState.id)) {
      n.x -= (z.w - old.w) / 2; n.y -= (z.h - old.h) / 2; el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
    }
    measuredScale[id] = sc; sizeCache[id] = z;
  }
}
// In files and undo steps a free note's x,y is its top-left corner at 100% zoom; on screen it is kept centred on the same spot.
const measuredScale = {};
const freeOff = n => { const sc = scaleNow[n.id] || 1, z = sizeCache[n.id]; return !z || sc === 1 || isTree(n) ? null : { x: (z.w - z.w / sc) / 2, y: (z.h - z.h / sc) / 2 }; };
function canonNodes() {
  const out = {}, r = v => Math.round(v * 100) / 100;
  for (const n of all()) { const o = freeOff(n); out[n.id] = o ? { ...n, x: r(n.x + o.x), y: r(n.y + o.y) } : n; }
  return out;
}
function fromCanon() {
  for (const n of all()) { const o = freeOff(n); if (!o) continue; n.x -= o.x; n.y -= o.y; if (els[n.id]) { els[n.id].style.left = n.x + 'px'; els[n.id].style.top = n.y + 'px'; } }
  drawEdges();
}

function edgePath(p, c) {
  const ps = size(p.id), cs = size(c.id);
  const pcx = p.x + ps.w / 2, ccx = c.x + cs.w / 2;
  let x1, x2;
  const y1 = p.y + ps.h / 2, y2 = c.y + cs.h / 2;
  if (ccx >= pcx) { x1 = p.x + ps.w; x2 = c.x; } else { x1 = p.x; x2 = c.x + cs.w; }
  const dx = Math.max(30, Math.abs(x2 - x1) * 0.5) * (x2 >= x1 ? 1 : -1);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

let ghostEdge = null; // {from:id, x, y}
function drawEdges() {
  fitSections();
  let html = '';
  for (const n of all()) {
    if (!n.parentId || !N(n.parentId) || isHidden(n)) continue;
    const p = N(n.parentId);
    const c = colorOf(n);
    const hl = selectedId && (selectedId === n.id || selectedId === p.id);
    const pv = n.id === editingId || n.id === freshId ? 1 : pOf(n) >= 1 ? 1 : 0;
    if (!pv) continue;
    const style = (c ? `stroke:${c};opacity:${(hl ? .95 : .55) * pv}` : `opacity:${pv}` + (hl ? ';stroke:var(--text-dim)' : ''));
    html += `<path d="${edgePath(p, n)}" data-child="${n.id}" class="${hl ? 'hl' : ''}" style="${style}"/>`;
  }
  for (const L of doc.links) {
    if (L.kind !== 'flow') continue;
    const A = N(L.a), B = N(L.b);
    if (!A || !B || isHidden(A) || isHidden(B)) continue;
    const sel = L.id === selectedLink;
    const hl = sel || selectedId === L.a || selectedId === L.b;
    const d = flowPath(A, B);
    const m = sel ? 'url(#arr-sel)' : hl ? 'url(#arr-hl)' : 'url(#arr)';
    html += `<path class="flow${sel ? ' sel' : hl ? ' hl' : ''}" data-flow="${L.id}" d="${d}" marker-end="${m}"${L.dir === 'both' ? ` marker-start="${m}"` : ''}/>`;
    html += `<path class="hit" data-link="${L.id}" d="${d}"/>`;
  }
  if (ghostEdge) {
    const p = N(ghostEdge.from), ps = size(p.id);
    const x1 = ghostEdge.x >= p.x + ps.w / 2 ? p.x + ps.w : p.x, y1 = p.y + ps.h / 2;
    const dx = Math.max(30, Math.abs(ghostEdge.x - x1) * .5) * (ghostEdge.x >= x1 ? 1 : -1);
    html += `<path class="ghost" d="M${x1},${y1} C${x1 + dx},${y1} ${ghostEdge.x - dx},${ghostEdge.y} ${ghostEdge.x},${ghostEdge.y}"/>`;
  }
  if (dragState && dragState.guides) for (const g of dragState.guides) html += `<path class="snap-guide" d="${g}"/>`; // lining up with a connected note
  edgesSvg.innerHTML = ARROW_DEFS + html;
}
const ARROW_DEFS = '<defs>' + ['arr', 'arr-hl', 'arr-sel'].map(id =>
  `<marker id="${id}" class="${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z"/></marker>`).join('') + '</defs>';
// straight connector between the edges of two boxes (flow-chart style)
function flowPath(A, B) {
  const a = size(A.id), b = size(B.id);
  const ax = A.x + a.w / 2, ay = A.y + a.h / 2, bx = B.x + b.w / 2, by = B.y + b.h / 2;
  const edge = (cx, cy, w, h, tx, ty) => {
    const dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const t = Math.min(dx ? (w / 2 + 6) / Math.abs(dx) : Infinity, dy ? (h / 2 + 6) / Math.abs(dy) : Infinity);
    return { x: cx + dx * t, y: cy + dy * t };
  };
  const p = edge(ax, ay, a.w, a.h, bx, by), q = edge(bx, by, b.w, b.h, ax, ay);
  return `M${p.x.toFixed(1)},${p.y.toFixed(1)} L${q.x.toFixed(1)},${q.y.toFixed(1)}`;
}

/* ---------------- relations: arrows and jump links ---------------- */

let selectedLink = null;
const linkById = id => (doc.links || []).find(L => L.id === id);
const firstLine = t => (t || 'Untitled note').split('\n')[0].slice(0, 40);
function jumpTargets(id) {
  const out = [];
  for (const L of doc.links || []) {
    if (L.kind !== 'jump') continue;
    if (L.a === id && N(L.b)) out.push(L.b);
    else if (L.b === id && N(L.a)) out.push(L.a);
  }
  return out;
}
function addLink(kind, a, b, dir = 'one') {
  if (!N(a) || !N(b) || a === b) return null;
  const same = doc.links.find(L => L.kind === kind && ((L.a === a && L.b === b) || (L.a === b && L.b === a)));
  if (same) { if (kind === 'flow') { same.dir = same.a === a && same.b === b && same.dir === dir ? same.dir : 'both'; } return same.id; }
  const id = uid();
  doc.links.push({ id, kind, a, b, dir });
  return id;
}
function selectLink(id) {
  if (editingId) commitEdit();
  select(null);
  selectedLink = id;
  drawEdges();
  updateLinkToolbar();
}
const linkBar = $('#link-toolbar');
function updateLinkToolbar() {
  const L = selectedLink && linkById(selectedLink);
  if (!L || dragState) { linkBar.hidden = true; return; }
  linkBar.hidden = false;
  linkBar.querySelector('[data-dir=one]').classList.toggle('active', L.dir !== 'both');
  linkBar.querySelector('[data-dir=both]').classList.toggle('active', L.dir === 'both');
  linkBar.querySelector('[data-act=flip]').disabled = L.dir === 'both';
  positionLinkToolbar();
}
function positionLinkToolbar() {
  const L = selectedLink && linkById(selectedLink);
  if (linkBar.hidden || !L) return;
  const A = N(L.a), B = N(L.b), a = size(A.id), b = size(B.id);
  const m = toScreen((A.x + a.w / 2 + B.x + b.w / 2) / 2, (A.y + a.h / 2 + B.y + b.h / 2) / 2);
  linkBar.style.left = Math.max(8, Math.min(innerWidth - linkBar.offsetWidth - 8, m.x - linkBar.offsetWidth / 2)) + 'px';
  linkBar.style.top = Math.max(50, m.y - linkBar.offsetHeight - 14) + 'px';
}
linkBar.addEventListener('pointerdown', e => e.stopPropagation());
linkBar.addEventListener('click', e => {
  const b = e.target.closest('button'); const L = selectedLink && linkById(selectedLink);
  if (!b || !L) return;
  checkpoint();
  if (b.dataset.dir) L.dir = b.dataset.dir;
  else if (b.dataset.act === 'flip') [L.a, L.b] = [L.b, L.a];
  else if (b.dataset.act === 'delete') { deleteLink(L.id); return; }
  drawEdges(); updateLinkToolbar(); scheduleSave();
});
function deleteLink(id) {
  doc.links = doc.links.filter(L => L.id !== id);
  if (selectedLink === id) selectedLink = null;
  linkBar.hidden = true;
  render(); scheduleSave();
  toast('Connection removed', 'Undo', undo);
}

// jump: move the view to a linked note (zooming in far enough for it to show)
let jumpHistory = [];
function focusNote(id, fromId) {
  const n = N(id); if (!n) return;
  if (editingId) commitEdit();
  const d = depthOf(n);
  const k = Math.min(MAX_K, Math.max(view().k, d >= 2 ? fullZoom(d) + 0.02 : 0, 0.55));
  forcedDepth = Math.max(maxDepthAt(k), d);
  applyScales(k); measure();
  const pos = layoutTargets();
  forcedDepth = null;
  const p = pos ? pos[id] : n, s = size(id);
  applyScales(view().k, true); measure();
  animateView({ k, x: innerWidth / 2 - (p.x + s.w / 2) * k, y: 22 + innerHeight / 2 - (p.y + s.h / 2) * k }, 420);
  if (fromId) jumpHistory.push(fromId);
  setTimeout(() => {
    select(id);
    const el = els[id];
    if (el) { el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse'); }
  }, 430);
  if (fromId) toast(`Jumped to “${firstLine(n.text)}”`, 'Back', () => { const back = jumpHistory.pop(); if (back) focusNote(back); });
}
const jumpMenu = $('#jump-menu');
function openJumpMenu(id, sx, sy) {
  const targets = jumpTargets(id);
  let html = '<div class="pm-label">Jump to</div>';
  for (const t of targets) {
    html += `<div class="jm-row"><button class="pm-item" data-jump="${t}"><span class="pm-name">${esc(firstLine(N(t).text))}</span></button>` +
      `<button class="jm-x" data-unlink="${t}" title="Remove this link">×</button></div>`;
  }
  jumpMenu.innerHTML = html;
  jumpMenu.classList.remove('node-menu');
  jumpMenu.dataset.from = id;
  jumpMenu.hidden = false;
  jumpMenu.style.left = Math.min(innerWidth - jumpMenu.offsetWidth - 8, sx) + 'px';
  jumpMenu.style.top = Math.min(innerHeight - jumpMenu.offsetHeight - 8, sy + 8) + 'px';
}
jumpMenu.addEventListener('pointerdown', e => e.stopPropagation());
jumpMenu.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const from = jumpMenu.dataset.from;
  jumpMenu.hidden = true;
  if (b.dataset.moditem) { const it = modMenuItems().find(x => x.key === b.dataset.moditem); if (it && N(from)) { try { it.run(N(from)); } catch (err) { console.error('mod menu', err); } } return; }
  if (b.dataset.unlinkurl) { const n = N(from); if (n && n.url) { checkpoint(); delete n.url; render(); scheduleSave(); toast('Link removed'); } return; }
  if (b.dataset.copylink) { copyText(noteLink(from)); toast('Link copied: paste it onto a note to make that note a shortcut here'); return; }
  if (b.dataset.jump) focusNote(b.dataset.jump, from);
  else if (b.dataset.unlink) {
    const t = b.dataset.unlink;
    checkpoint();
    doc.links = doc.links.filter(L => !(L.kind === 'jump' && ((L.a === from && L.b === t) || (L.a === t && L.b === from))));
    render(); scheduleSave();
    toast('Link removed', 'Undo', undo);
  }
});
document.addEventListener('pointerdown', e => { if (!jumpMenu.hidden && !e.target.closest('#jump-menu')) jumpMenu.hidden = true; });

// after dragging the + handle: choose what kind of relation to make
const relMenu = $('#relation-menu');
let relPending = null;
function openRelationMenu(from, to, at, sx, sy) {
  relPending = { from, to, at };
  const canChild = to && !isAncestor(to, from);
  const item = (act, icon, label, hint, disabled) =>
    `<button class="rm-item" data-rel="${act}"${disabled ? ' disabled' : ''}><span class="rm-ic">${icon}</span><span class="rm-text"><b>${label}</b><small>${hint}</small></span></button>`;
  let html = '';
  if (to) {
    html += item('child', '⤷', 'Make it a child', 'Part of this note’s tree', !canChild);
    html += item('flow', '→', 'Arrow', 'A one-way connection', false);
    html += item('both', '↔', 'Two-way arrow', 'Connected both ways', false);
    html += item('jump', '⇢', 'Jump link', 'Hidden; click the link badge to jump', false);
  } else {
    html += item('new-child', '⤷', 'Child note', 'A new note in this tree', false);
    html += item('new-flow', '→', 'Connected note', 'A free note with an arrow to it', false);
  }
  relMenu.innerHTML = html;
  relMenu.hidden = false;
  relMenu.style.left = Math.max(8, Math.min(innerWidth - relMenu.offsetWidth - 8, sx + 10)) + 'px';
  relMenu.style.top = Math.max(50, Math.min(innerHeight - relMenu.offsetHeight - 8, sy + 10)) + 'px';
}
function closeRelationMenu() { relMenu.hidden = true; relPending = null; ghostEdge = null; drawEdges(); }
relMenu.addEventListener('pointerdown', e => e.stopPropagation());
relMenu.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || !relPending) return;
  const { from, to, at } = relPending;
  closeRelationMenu();
  const act = b.dataset.rel;
  if (act === 'new-child') { addChild(from, at); return; }
  if (act === 'new-flow') {
    if (editingId) commitEdit();
    checkpoint();
    const id = createNode({ x: Math.round(at.x - 60), y: Math.round(at.y - 20), size: 'md', color: N(from).color || 'none' });
    addLink('flow', from, id, 'one');
    freshId = id; render(); startEditing(id);
    return;
  }
  checkpoint();
  if (act === 'child') {
    if (reparent(to, from)) { select(to); toast('Moved under this note', 'Undo', undo); } else undoStack.pop();
    render(); relayout(); scheduleSave(); return;
  }
  if (act === 'flow' || act === 'both') { const id = addLink('flow', from, to, act === 'both' ? 'both' : 'one'); render(); selectLink(id); }
  if (act === 'jump') { addLink('jump', from, to); render(); select(from); toast('Jump link added: click the link badge on either note to jump'); }
  scheduleSave();
});
document.addEventListener('pointerdown', e => { if (!relMenu.hidden && !e.target.closest('#relation-menu')) closeRelationMenu(); });

/* ---------------- selection & toolbar ---------------- */

function setMulti(ids) {
  multi.clear(); for (const i of ids) if (N(i)) multi.add(i);
  for (const k in els) els[k].classList.toggle('msel', multi.has(k));
}
function select(id) {
  if (id !== selectedId && modLive.size) queueMicrotask(() => modEmit('select', id));
  if (multi.size && !(id && multi.has(id))) setMulti([]);
  if (editingId && editingId !== id) commitEdit();
  if (id && selectedLink) { selectedLink = null; linkBar.hidden = true; }
  if (id && selectedSection) selectSection(null);
  if (selectedId === id) return;
  selectedId = id;
  for (const k in els) els[k].classList.toggle('selected', k === id);
  drawEdges();
  updateToolbar();
}

function buildToolbar() {
  for (const wrap of [$('#nt-colors'), $('#st-colors')]) {
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.dataset.color = c.key;
      b.title = c.name;
      b.innerHTML = '<span class="swatch"></span>';
      wrap.appendChild(b);
    }
  }
  paintSwatches();
}
function paintSwatches() {
  for (const b of document.querySelectorAll('#nt-colors button, #st-colors button')) {
    const c = COLORS.find(c => c.key === b.dataset.color);
    b.firstChild.style.setProperty('--sw', c[uiTheme] || 'var(--neutral)');
  }
}
function updateToolbar() {
  const n = selectedId && N(selectedId);
  if (!n || dragState || (editingId && editingId !== n.id) || isHidden(n)) { toolbar.hidden = true; hideBody(); return; }
  showBody(n);
  toolbar.hidden = nodeMenuFor !== n.id; // the size/colour bar shows only with the right-click menu
  if (toolbar.hidden) return;
  const tree = isTree(n);
  for (const b of toolbar.querySelectorAll('[data-size]')) {
    b.classList.toggle('active', !tree && b.dataset.size === n.size);
    b.disabled = tree;
  }
  $('#nt-sizes').title = tree ? 'Notes in a tree are sized by their level' : '';
  for (const b of toolbar.querySelectorAll('[data-color]')) b.classList.toggle('active', b.dataset.color === (n.color || 'none'));
  const hasKids = childrenOf(n.id).length > 0;
  const col = $('#nt-collapse');
  col.disabled = !hasKids;
  col.title = 'Zoom into this branch (Space)';
  $('#nt-detach').disabled = !n.parentId;
  $('#nt-unlink').hidden = !n.url;
  positionToolbar();
}
/* ---- fully zoomed out: round markers on the screen edge point at root notes that are out of view ---- */
let rootMarkersEl = null;
function paintRootMarkers() {
  if (!rootMarkersEl) { rootMarkersEl = document.createElement('div'); rootMarkersEl.id = 'root-markers'; document.body.appendChild(rootMarkersEl); }
  const out = [];
  if (view().k <= MIN_K * 1.03) {
    const v0 = viewport.getBoundingClientRect(), top = Math.max(v0.top, $('#titlebar').getBoundingClientRect().bottom), pad = 26;
    const vr = { left: v0.left, right: v0.right, top, bottom: v0.bottom, width: v0.width, height: v0.bottom - top };
    const cx = vr.left + vr.width / 2, cy = vr.top + vr.height / 2;
    for (const r of roots()) {
      if (!els[r.id]) continue;
      const z = size(r.id), a = toScreen(r.x, r.y), b = toScreen(r.x + z.w, r.y + z.h);
      if (b.x > vr.left && a.x < vr.right && b.y > vr.top && a.y < vr.bottom) continue; // on screen
      const tx = (a.x + b.x) / 2, ty = (a.y + b.y) / 2, dx = tx - cx, dy = ty - cy;
      const t = Math.min(Math.abs((vr.width / 2 - pad) / (dx || 1e-9)), Math.abs((vr.height / 2 - pad) / (dy || 1e-9)));
      out.push({ id: r.id, x: cx + dx * t, y: cy + dy * t, ang: Math.atan2(dy, dx) * 180 / Math.PI, c: colorOf(r) || 'var(--text-dim)', label: firstLine(r.text) });
    }
  }
  const html = out.map(m => `<button class="root-marker${m.x > innerWidth / 2 ? ' tl' : ''}${m.y < 90 ? ' tb' : m.y > innerHeight - 60 ? ' tt' : ''}" data-root="${m.id}" data-tip="${esc(m.label)}" style="left:${m.x}px;top:${m.y}px;--c:${m.c}"><span style="transform:rotate(${m.ang}deg)"><svg viewBox="0 0 16 16"><path d="M3 8h9.5M9 4.5L12.5 8 9 11.5"/></svg></span></button>`).join('');
  if (rootMarkersEl.innerHTML !== html) rootMarkersEl.innerHTML = html;
}
document.addEventListener('pointerdown', e => {
  const m = e.target.closest && e.target.closest('.root-marker'); if (!m) return;
  e.preventDefault(); e.stopPropagation();
  if (N(m.dataset.root)) focusBranch(m.dataset.root);
}, true);
function positionToolbar() {
  positionBody();
  positionNodeMenu();
  if (toolbar.hidden || !selectedId || !N(selectedId)) return;
  const n = N(selectedId), s = size(n.id);
  const a = toScreen(n.x, n.y), b = toScreen(n.x + s.w, n.y + s.h);
  const tw = toolbar.offsetWidth, th = toolbar.offsetHeight;
  let left = (a.x + b.x) / 2 - tw / 2;
  let top = a.y - th - 12;
  if (top < 50) top = b.y + 12;
  left = Math.max(8, Math.min(innerWidth - tw - 8, left));
  top = Math.max(50, Math.min(innerHeight - th - 8, top));
  toolbar.style.left = left + 'px';
  toolbar.style.top = top + 'px';
}

/* ---- a note's body: longer text kept off the canvas, shown in a panel under the note while it's selected ---- */
const bodyPanel = $('#note-body'), bodyText = $('#note-body .nb-text'), bodyImgsEl = $('#note-body .nb-imgs');
// the description is an editable block (so mods can style parts of it); .value reads and writes its plain text
Object.defineProperty(bodyText, 'value', { get() { return this.textContent; }, set(v) { this.textContent = v; } });
let bodyFor = null, bodyDirty = false;
function showBody(n) {
  if (bodyFor !== n.id) {
    commitBody();
    if (document.activeElement === bodyText) bodyText.blur(); // it now belongs to another note
    bodyFor = n.id;
  }
  if (document.activeElement !== bodyText) {
    if (bodyText.value !== (n.body || '')) bodyText.value = n.body || ''; // e.g. after undo
    if (modLive.size) modEmit('body', bodyText, n); // mods dress the description
  }
  paintThumbs(bodyImgsEl, n.bodyImages, 'body');
  bodyPanel.classList.toggle('empty', !bodyText.value && !(n.bodyImages && n.bodyImages.length));
  openBody(n.id);
}
// The description lives inside its note: a frame (.nb-shell) grows out of the note's own box to hold it.
// The frame floats over the canvas, so the note keeps its size for lines, snapping and the layout.
let bodyShell = null;
function shellMetrics(el, shell) {
  const cs = getComputedStyle(el);
  shell.style.setProperty('--nh', el.offsetHeight + 'px'); shell.style.setProperty('--nw', el.offsetWidth + 'px');
  shell.style.setProperty('--pl', cs.paddingLeft); shell.style.setProperty('--bw', cs.borderTopWidth);
}
// the + handle rides on the frame's right edge
const setGrow = (el, w) => el.style.setProperty('--grow', Math.max(0, (w - el.offsetWidth) / (scaleNow[el.dataset.id] || 1)).toFixed(1) + 'px');
function closeShell(shell, el) {
  if (!shell) return;
  if (el) el.style.removeProperty('--grow');
  if (!el || !el.isConnected) { shell.remove(); return; }
  const w = shell.offsetWidth, h = shell.offsetHeight;
  shell.classList.add('closing'); shell.style.width = w + 'px'; shell.style.height = h + 'px';
  shell.getBoundingClientRect(); // start the shrink from the open size
  shell.style.width = el.offsetWidth + 'px'; shell.style.height = el.offsetHeight + 'px';
  setTimeout(() => { shell.remove(); if (!el.querySelector(':scope > .nb-shell')) el.classList.remove('nb-open'); }, 230);
}
function openBody(id) {
  const el = els[id]; if (!el) return;
  if (bodyShell && bodyShell.parentNode === el && bodyShell.contains(bodyPanel)) { bodyPanel.hidden = false; shellMetrics(el, bodyShell); return; }
  const old = bodyShell, oldEl = old && old.parentNode;
  for (const g of el.querySelectorAll(':scope > .nb-shell')) if (g !== old) g.remove(); // a frame still closing on this note
  bodyPanel.style.width = '';
  const shell = document.createElement('div'); shell.className = 'nb-shell';
  el.appendChild(shell); shell.appendChild(bodyPanel); bodyPanel.hidden = false; bodyShell = shell;
  el.classList.add('nb-open'); shellMetrics(el, shell);
  if (old) { if (oldEl === el) old.remove(); else closeShell(old, oldEl); }
  const w = shell.offsetWidth, h = shell.offsetHeight; // grow from the note's size to the full frame
  bodyPanel.style.width = bodyPanel.offsetWidth + 'px'; // the text keeps its line breaks while the frame grows
  setGrow(el, w);
  shell.classList.add('opening'); shell.style.width = el.offsetWidth + 'px'; shell.style.height = el.offsetHeight + 'px';
  shell.getBoundingClientRect();
  shell.style.width = w + 'px'; shell.style.height = h + 'px';
  setTimeout(() => { if (shell.isConnected && !shell.classList.contains('closing')) { shell.classList.remove('opening'); shell.style.width = shell.style.height = ''; if (bodyShell === shell) bodyPanel.style.width = ''; } }, 240);
}
function hideBody() {
  commitBody(); bodyFor = null;
  if (bodyPanel.hidden && !bodyShell) return;
  if (document.activeElement === bodyText) bodyText.blur();
  const shell = bodyShell, el = shell && shell.parentNode; bodyShell = null;
  bodyPanel.hidden = true; document.body.appendChild(bodyPanel); // parked outside the canvas until the next note
  closeShell(shell, el);
}
function commitBody() { bodyDirty = false; }
function fitBody() {} // the frame grows with its text
function positionBody() {
  const el = bodyShell && bodyFor && els[bodyFor]; if (!el || bodyShell.parentNode !== el) return;
  shellMetrics(el, bodyShell); if (!bodyShell.classList.contains('opening')) setGrow(el, bodyShell.offsetWidth);
}
bodyText.addEventListener('focus', () => { if (editingId) commitEdit(); bodyDirty = false; });
bodyText.addEventListener('input', () => {
  const n = bodyFor && N(bodyFor); if (!n) return;
  if (!bodyDirty) { checkpoint(); bodyDirty = true; } // one undo step per editing session
  const v = bodyText.value;
  if (v.trim()) n.body = v; else delete n.body;
  bodyPanel.classList.toggle('empty', !v);
  fitBody(); positionBody();
  render(); scheduleSave();
});
bodyText.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); bodyText.blur(); }
});
bodyText.addEventListener('blur', () => { bodyDirty = false; });
bodyPanel.addEventListener('pointerdown', e => e.stopPropagation());
for (const t of ['dblclick', 'contextmenu']) bodyPanel.addEventListener(t, e => e.stopPropagation());

/* ---- images: in the note itself (n.images, shown on the canvas) or in its body (n.bodyImages, shown in the panel).
   The desktop app keeps each picture as a file in <data>\images; in a plain browser they're stored inline ---- */
const imgBase = host && host.imageBase ? host.imageBase() : '';
const imgSrc = name => (/^(data|blob|file|https?):/.test(name) ? name : imgBase + encodeURIComponent(name));
let thumbRelayout = 0;
function paintThumbs(box, list, where) {
  list = list || [];
  let wrap = where === 'note' ? box.querySelector(':scope > .imgs') : box;
  if (!list.length) { if (where === 'note' && wrap) wrap.remove(); else if (wrap) wrap.textContent = ''; return; }
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'imgs'; box.firstChild.after(wrap); }
  const key = list.join('|');
  if (wrap.dataset.k === key) return;
  wrap.dataset.k = key;
  wrap.classList.toggle('multi', list.length > 1);
  wrap.innerHTML = list.map((name, i) => `<div class="thumb" data-where="${where}" data-i="${i}"><img draggable="false" alt=""><button class="x" title="Remove image">×</button></div>`).join('');
  wrap.querySelectorAll('img').forEach((img, i) => {
    img.onload = img.onerror = () => { // notes change size as their pictures arrive
      cancelAnimationFrame(thumbRelayout);
      thumbRelayout = requestAnimationFrame(() => { measure(); relayout(); positionToolbar(); });
    };
    img.src = imgSrc(list[i]);
  });
}
const IMG_TYPES = /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml|avif)$/;
async function addImages(id, files, where) {
  const n = N(id); if (!n) return;
  files = [...files].filter(f => IMG_TYPES.test(f.type));
  if (!files.length) return;
  const names = [];
  for (const f of files) {
    const ext = (f.type.split('/')[1] || 'png').replace('svg+xml', 'svg').replace('jpeg', 'jpg');
    if (host && host.saveImage) names.push(await host.saveImage(new Uint8Array(await f.arrayBuffer()), ext));
    else names.push(await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); }));
  }
  pushImages(id, names, where);
}
function pushImages(id, names, where) {
  const n = N(id); if (!n || !names.length) return;
  if (editingId) commitEdit();
  checkpoint();
  const k = where === 'body' ? 'bodyImages' : 'images';
  n[k] = [...(n[k] || []), ...names];
  render(); relayout(); scheduleSave();
  toast(names.length > 1 ? `${names.length} images added` : 'Image added');
}
function removeImage(id, where, i) {
  const n = N(id), k = where === 'body' ? 'bodyImages' : 'images';
  if (!n || !n[k] || !n[k][i]) return;
  checkpoint();
  n[k] = n[k].filter((_, j) => j !== i);
  if (!n[k].length) delete n[k];
  render(); relayout(); scheduleSave();
}
async function pickImages(id, where) {
  if (host && host.pickImages) { pushImages(id, await host.pickImages(), where); return; }
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
  inp.onchange = () => addImages(id, inp.files, where);
  inp.click();
}
const clipImages = dt => (dt ? [...dt.items].filter(it => it.kind === 'file' && IMG_TYPES.test(it.type)).map(it => it.getAsFile()).filter(Boolean) : []);
// full-size view
const lightbox = $('#lightbox');
function openLightbox(src) { lightbox.querySelector('img').src = src; lightbox.hidden = false; }
lightbox.addEventListener('pointerdown', e => { e.stopPropagation(); lightbox.hidden = true; });
window.addEventListener('keydown', e => { if (!lightbox.hidden && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); lightbox.hidden = true; } }, true);
// pasting a picture: into the body when typing there, otherwise into the selected note
const URL_RE = /^(https?:\/\/|www\.|mindview:\/\/)\S+$/i;
document.addEventListener('paste', e => {
  const files = clipImages(e.clipboardData);
  if (!files.length) { // a web address pasted onto a selected note (not while writing) is attached to it, hidden
    const txt = (e.clipboardData && e.clipboardData.getData('text/plain') || '').trim();
    if (txt.startsWith(CLIP_MARK) && !editingId && !editingSection && !typingTarget(e)) {
      let pack = null; try { pack = JSON.parse(txt.slice(CLIP_MARK.length)); } catch (_) {}
      if (pack) { e.preventDefault(); pasteNotes(pack); return; }
    }
    if (!URL_RE.test(txt) || editingId || !selectedId || !N(selectedId)) return;
    if (e.target.closest && e.target.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
    e.preventDefault();
    const n = N(selectedId);
    checkpoint();
    n.url = /^www\./i.test(txt) ? 'https://' + txt : txt;
    render(); scheduleSave();
    toast(/^mindview:/i.test(n.url) ? 'Shortcut attached: clicking the note brings the linked note into focus' : 'Link attached: clicking the note opens it');
    return;
  }
  const inBody = e.target.closest && e.target.closest('#note-body');
  const id = inBody ? bodyFor : editingId || selectedId;
  if (!id || !N(id)) return;
  if (!inBody && e.target.closest && e.target.closest('input, textarea')) return;
  e.preventDefault();
  addImages(id, files, inBody ? 'body' : 'note');
});
// dropping picture files: onto a note puts them in the note, onto the panel in its body
document.addEventListener('dragover', e => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  const t = e.target.closest && e.target.closest('.node, #note-body');
  e.dataTransfer.dropEffect = t ? 'copy' : 'none';
  document.querySelectorAll('.img-drop').forEach(x => x !== t && x.classList.remove('img-drop'));
  if (t) t.classList.add('img-drop');
});
document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.querySelectorAll('.img-drop').forEach(x => x.classList.remove('img-drop')); });
document.addEventListener('drop', e => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  document.querySelectorAll('.img-drop').forEach(x => x.classList.remove('img-drop'));
  const files = e.dataTransfer.files;
  if (e.target.closest && e.target.closest('#note-body')) { if (bodyFor) addImages(bodyFor, files, 'body'); return; }
  const nodeEl = e.target.closest && e.target.closest('.node');
  if (nodeEl) { select(nodeEl.dataset.id); addImages(nodeEl.dataset.id, files, 'note'); }
  else toast('Drop images onto a note, or onto its text panel');
});
// clicking a thumbnail opens it; its × removes it (on the canvas and in the panel)
bodyImgsEl.addEventListener('click', e => {
  const th = e.target.closest('.thumb'); if (!th || !bodyFor) return;
  if (e.target.closest('.x')) removeImage(bodyFor, 'body', +th.dataset.i);
  else openLightbox(th.querySelector('img').src);
});

/* ---------------- editing ---------------- */

let editStartedAt = 0;
let pendingFocus = 0; // a click's branch focus waits briefly in case it turns into a double-click
function openNoteLink(id) {
  const n = N(id); if (!n || !n.url) return false;
  const m = /^mindview:\/\/([^/]+)\/(.+)$/i.exec(n.url);
  if (m) { // a shortcut to another note: bring it into focus (switching project if it lives in another one)
    const pid = decodeURIComponent(m[1]), nid = m[2];
    if (host && pid !== currentId && store.list().some(p => p.id === pid)) openProject(pid);
    if (N(nid)) { select(nid); focusBranch(nid); } else toast('The linked note no longer exists');
    return true;
  }
  if (!/^https?:\/\//i.test(n.url)) return false;
  window.open(n.url, '_blank', 'noopener'); // the desktop app hands it to the default browser
  return true;
}
// enter edit mode with the caret where the pointer clicked
function editAt(id, cx, cy) {
  startEditing(id, false);
  editStartedAt = performance.now();
  const t = els[id] && els[id].firstChild;
  const r = document.caretRangeFromPoint && document.caretRangeFromPoint(cx, cy);
  if (t && r && t.contains(r.startContainer)) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
}
function startEditing(id, selectAll = true) {
  const el = els[id]; if (!el) return;
  if (editingId && editingId !== id) commitEdit();
  select(id);
  editingId = id;
  el.classList.add('editing');
  const t = el.firstChild;
  t.contentEditable = 'plaintext-only';
  t.focus();
  const range = document.createRange();
  range.selectNodeContents(t);
  if (!selectAll) range.collapse(false);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  updateToolbar();
}
function finishEditing(save) {
  const id = editingId; if (!id) return;
  const el = els[id], n = N(id);
  editingId = null;
  if (el) {
    const t = el.firstChild;
    t.contentEditable = 'false';
    el.classList.remove('editing');
    if (n && save) {
      const text = t.innerText.replace(/ /g, ' ').replace(/\n+$/, '').trim();
      if (!text && freshId === id) {
        // empty brand new note: drop it quietly
        delete doc.nodes[id];
        doc.links = doc.links.filter(L => N(L.a) && N(L.b));
        undoStack.pop();
        const parent = n.parentId;
        selectedId = parent && N(parent) ? parent : null;
      } else if (text !== n.text) {
        if (freshId !== id) checkpoint();
        n.text = text;
      }
    }
  }
  freshId = null;
  getSelection().removeAllRanges();
  render();
  relayout();
  scheduleSave();
}
const commitEdit = () => finishEditing(true);

/* ---------------- mutations ---------------- */

function createNode(props) {
  const id = uid();
  const n = doc.nodes[id] = Object.assign({ id, parentId: null, x: 0, y: 0, text: '', size: 'md', color: 'none' }, props);
  const p = n.parentId && N(n.parentId);
  if (!p) { const sid = sectionAt(n.x + 60, n.y + 20); if (sid) n.section = sid; } // a child simply follows its parent
  return id;
}
function newRootAt(wx, wy) {
  if (editingId) commitEdit();
  checkpoint();
  const id = createNode({ x: Math.round(wx - 80), y: Math.round(wy - 20), size: 'lg' });
  freshId = id;
  render();
  startEditing(id);
}
function newRootCenter() {
  const c = toWorld(innerWidth / 2, innerHeight / 2);
  newRootAt(c.x + (Math.random() - .5) * 40, c.y + (Math.random() - .5) * 40);
}
function addChild(pid, at) {
  const p = N(pid); if (!p) return;
  if (editingId) commitEdit();
  if (!N(pid)) return;
  checkpoint();
  if (kidsHidden(p)) zoomToBranch(pid, true);
  const ps = size(pid);
  const kids = childrenOf(pid);
  const childSize = kids.length ? kids[0].size : (p.size === 'lg' ? 'md' : 'sm');
  let x, y;
  if (at) { x = at.x; y = at.y - 18; }
  else if (kids.length) {
    const last = kids.reduce((a, b) => (a.y + size(a.id).h > b.y + size(b.id).h ? a : b));
    x = last.x; y = last.y + size(last.id).h + GAP_Y;
  } else {
    x = p.x + ps.w + GAP_X; y = p.y + ps.h / 2 - 18;
  }
  const id = createNode({ parentId: pid, x: Math.round(x), y: Math.round(y), size: childSize, color: p.color || 'none' });
  freshId = id;
  render();
  if (true) {
    // arrange the branch so the new note slots in neatly
    const target = layoutTargets();
    putAt(N(id), target[id], Math.round(target[id].x), Math.round(target[id].y));
    render();
    animateLayout(target);
    setTimeout(() => ensureVisible(id), 400);
  } else ensureVisible(id);
  startEditing(id);
  return id;
}
function addSibling(id) {
  const n = N(id); if (!n) return;
  if (!n.parentId) {
    if (editingId) commitEdit();
    checkpoint();
    const s = size(id);
    const nid = createNode({ x: n.x, y: n.y + s.h + ROOT_GAP, size: n.size, color: n.color });
    freshId = nid; render(); relayout(); ensureVisible(nid); startEditing(nid);
    return;
  }
  addChild(n.parentId);
}
function deleteNode(id) {
  const n = N(id); if (!n) return;
  if (editingId) finishEditing(false);
  checkpoint();
  const gone = [id, ...descendants(id)];
  for (const g of gone) delete doc.nodes[g];
  doc.links = doc.links.filter(L => N(L.a) && N(L.b));
  selectedId = n.parentId && N(n.parentId) ? n.parentId : null;
  render(); relayout(); scheduleSave();
  const label = (n.text || 'Note').split('\n')[0].slice(0, 28);
  toast(gone.length > 1 ? `Deleted “${label}” and ${gone.length - 1} more` : `Deleted “${label}”`, 'Undo', undo);
}
/* ---- copy / paste / duplicate: notes with everything under them, their contents and the arrows between them ---- */
const CLIP_MARK = 'mindview-notes:';
function packNotes(ids) {
  const set = new Set(ids.filter(i => N(i)).flatMap(i => [i, ...descendants(i)]));
  return {
    nodes: [...set].map(i => JSON.parse(JSON.stringify(N(i)))),
    links: doc.links.filter(L => set.has(L.a) && set.has(L.b)).map(L => ({ ...L })),
  };
}
// adds packed notes as new ones. keepParents: the top notes stay under their old parent (a duplicate);
// otherwise they become notes of their own, with the group's top-left corner at `at`
function insertNotes(pack, { keepParents = false, at = null } = {}) {
  const map = {}, inSet = new Set(pack.nodes.map(n => n.id));
  for (const n of pack.nodes) map[n.id] = uid();
  const tops = pack.nodes.filter(n => !inSet.has(n.parentId));
  let dx = 0, dy = 0;
  if (at && tops.length) { dx = Math.round(at.x - Math.min(...tops.map(n => n.x))); dy = Math.round(at.y - Math.min(...tops.map(n => n.y))); }
  for (const src of pack.nodes) {
    const n = JSON.parse(JSON.stringify(src));
    n.id = map[src.id]; n.x += dx; n.y += dy;
    if (inSet.has(src.parentId)) n.parentId = map[src.parentId];
    else if (!(keepParents && src.parentId && N(src.parentId))) {
      n.parentId = null; delete n.nudge;
      const sid = sectionAt(n.x + 60, n.y + 20); if (sid) n.section = sid; else delete n.section;
    }
    if (n.section && !SEC(n.section)) delete n.section;
    doc.nodes[n.id] = n;
  }
  for (const L of pack.links || []) if (map[L.a] && map[L.b]) doc.links.push({ ...L, id: uid(), a: map[L.a], b: map[L.b] });
  return tops.map(n => map[n.id]);
}
function pasteNotes(pack) {
  if (!pack || !Array.isArray(pack.nodes) || !pack.nodes.length) return;
  if (editingId) commitEdit();
  checkpoint();
  const pt = lastPointer || { x: innerWidth / 2, y: innerHeight / 2 };
  const tops = insertNotes(pack, { at: toWorld(pt.x, pt.y) });
  render(); relayout(); scheduleSave();
  if (tops.length === 1) select(tops[0]); else { select(null); setMulti(tops); }
  toast(pack.nodes.length > 1 ? `Pasted ${pack.nodes.length} notes` : 'Pasted note');
}
const typingTarget = e => e.target.closest && e.target.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]');
document.addEventListener('copy', e => {
  if (editingId || editingSection || typingTarget(e)) return;
  const ids = multi.size ? [...multi] : selectedId && N(selectedId) ? [selectedId] : [];
  if (!ids.length) return;
  const pack = packNotes(ids);
  e.clipboardData.setData('text/plain', CLIP_MARK + JSON.stringify(pack));
  e.preventDefault();
  toast(pack.nodes.length > 1 ? `Copied ${pack.nodes.length} notes` : 'Copied note');
});
function deleteMany(ids) {
  ids = ids.filter(i => N(i)); if (!ids.length) return;
  if (editingId) finishEditing(false);
  checkpoint();
  const gone = new Set(ids.flatMap(i => [i, ...descendants(i)]));
  for (const g of gone) delete doc.nodes[g];
  doc.links = doc.links.filter(L => N(L.a) && N(L.b));
  selectedId = null; setMulti([]);
  render(); relayout(); scheduleSave();
  toast(`Deleted ${gone.size} notes`, 'Undo', undo);
}
function setSize(id, s) {
  const n = N(id); if (!n || n.size === s || isTree(n)) return; // tree notes are sized by level
  checkpoint(); n.size = s; render(); relayout(); scheduleSave();
}
function setColor(id, c) { const n = N(id); if (!n || n.color === c) return; checkpoint(); n.color = c; render(); scheduleSave(); }
// zoom in on a note just enough to show its children, centred on its branch
function zoomToBranch(id, instant) {
  const n = N(id); if (!n) return;
  const ids = [id, ...descendants(id).filter(d => depthOf(N(d)) <= depthOf(n) + 1)];
  forcedDepth = Math.max(maxDepth(), depthOf(n) + 1);
  const pos = layoutTargets(); // where things will sit once revealed
  forcedDepth = null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of ids) {
    const m = pos ? pos[d] : N(d), s = size(d);
    x0 = Math.min(x0, m.x); y0 = Math.min(y0, m.y); x1 = Math.max(x1, m.x + s.w); y1 = Math.max(y1, m.y + s.h);
  }
  const need = fullZoom(depthOf(n) + 1) + 0.02;
  const fit = Math.min((innerWidth - 160) / (x1 - x0), (innerHeight - 200) / (y1 - y0));
  const k = Math.min(MAX_K, Math.max(need, view().k, Math.min(fit, 1.1)));
  const target = { k, x: innerWidth / 2 - ((x0 + x1) / 2) * k, y: 22 + innerHeight / 2 - ((y0 + y1) / 2) * k };
  if (instant) { cancelAnimationFrame(viewAnim); viewAnimating = true; Object.assign(view(), target); viewChanged(); viewAnimating = false; }
  else animateView(target);
}
const toggleCollapse = zoomToBranch;
// double-click: frame a note and its children, zooming in or out as needed
function focusBranch(id) {
  const n = N(id); if (!n) return;
  const d0 = depthOf(n), kids = childrenOf(id);
  const ids = [id, ...kids.map(c => c.id)];
  const need = kids.length ? (d0 + 1 >= 2 ? fullZoom(d0 + 1) + 0.02 : 0) : (d0 >= 2 ? fullZoom(d0) + 0.02 : 0);
  let k = view().k, box = null;
  for (let i = 0; i < 6; i++) { // lay out as it will look at zoom k, fit, repeat until the zoom settles
    const kNow = view().k; view().k = k;
    applyScales(k); measure();
    const pos = layoutTargets();
    view().k = kNow;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of ids) {
      const m = pos ? pos[c] || N(c) : N(c), s = size(c);
      x0 = Math.min(x0, m.x); y0 = Math.min(y0, m.y); x1 = Math.max(x1, m.x + s.w); y1 = Math.max(y1, m.y + s.h);
    }
    box = { x0, y0, x1, y1 };
    const fit = Math.min((innerWidth - 160) / Math.max(1, x1 - x0), (innerHeight - 220) / Math.max(1, y1 - y0));
    const kNew = Math.min(MAX_K, 1.4, Math.max(MIN_K, need, fit));
    if (Math.abs(kNew / k - 1) < 0.01) break;
    k = i < 3 ? kNew : Math.sqrt(k * kNew); // damp if it oscillates
  }
  applyScales(view().k, true); measure();
  animateView({ k, x: innerWidth / 2 - ((box.x0 + box.x1) / 2) * k, y: 22 + innerHeight / 2 - ((box.y0 + box.y1) / 2) * k }, 420);
  select(id);
}
function applyLayoutNow(id) {
  const pos = layoutTargets(id); delete pos[id];
  for (const k in pos) Object.assign(N(k), { x: Math.round(pos[k].x), y: Math.round(pos[k].y) });
  render();
}
// lay the unfolded branch out neatly beside its parent
function unfoldLayout(id) {
  const target = layoutTargets(id);
  delete target[id];
  animateLayout(target);
}
function reparent(id, newParent) {
  const n = N(id);
  if (!n || id === newParent || (newParent && isAncestor(id, newParent))) return false;
  n.parentId = newParent || null;
  if (newParent) { const sib = all().find(o => o.parentId === newParent && o.id !== id); if (sib) n.size = sib.size; }
  return true;
}

/* ---------------- tidy layout ---------------- */

/* ---- hand placement: with auto-arrange off, a dragged note keeps a nudge from its arranged spot,
   stored per zoom level (how many levels are unfolded), relative to its parent ---- */
const lastNudgeY = {};
function zoomLevel(k = doc.view.k) { let d = 1; while (d < 60 && levelP(d + 1, k) >= 1) d++; return d; }
function nudgeOf(n, k = doc.view.k) {
  if (!n.nudge) return { x: 0, y: 0 };
  const L = zoomLevel(k), t = levelP(L + 1, k), a = n.nudge[L] || { x: 0, y: 0 }, b = n.nudge[L + 1] || { x: 0, y: 0 };
  return t > 0 ? { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } : a;
}
function addNudge(n, dx, dy) {
  const L = zoomLevel(), cur = (n.nudge && n.nudge[L]) || { x: 0, y: 0 };
  n.nudge = n.nudge || {};
  const x = Math.round(cur.x + dx), y = Math.round(cur.y + dy);
  if (x || y) n.nudge[L] = { x, y }; else delete n.nudge[L];
  if (!Object.keys(n.nudge).length) delete n.nudge;
}
function layoutTargets(onlyId) {
  const pos = {};
  const sub = {};
  const shown = []; // tree notes that take up room now
  const kidsMap = {};
  for (const n of all()) if (n.parentId && N(n.parentId)) (kidsMap[n.parentId] = kidsMap[n.parentId] || []).push(n);
  const orderY = n => n.y - (lastNudgeY[n.id] || 0); // sibling order ignores hand nudges
  for (const id in kidsMap) kidsMap[id].sort((a, b) => orderY(a) - orderY(b) || a.x - b.x);
  const kidsOf = id => kidsMap[id] || [];
  const depth = {};
  const dOf = id => (depth[id] !== undefined ? depth[id] : (depth[id] = depthOf(N(id))));
  const pk = id => levelP(dOf(id) + 1); // how unfolded this note's children are
  const visKids = id => (pk(id) > 0 ? kidsOf(id) : []);
  // spacing grows with the notes when zoomed out
  const kidScale = id => Math.max(1, ...kidsOf(id).map(c => scaleNow[c.id] || 1));
  const gx = id => GAP_X * Math.max(scaleNow[id] || 1, kidScale(id));
  const gy = id => GAP_Y * kidScale(id);
  // siblings whose own children are showing get extra room, so each family reads as a group
  const GROUP = 2.2;
  const famP = id => (visKids(id).length ? pk(id) : 0);
  const secM = Math.max(1, 1 / doc.view.k);
  const secOf = n => effSec(n);
  const gapAfter = (pid, kids, i) => {
    const g = gy(pid) * (1 + GROUP * Math.max(famP(kids[i].id), famP(kids[i + 1].id)));
    const a = secOf(kids[i]), b = secOf(kids[i + 1]);
    if (a === b) return g;
    // leave room for the section frames (and the label of the one below) between neighbours in different sections
    return Math.max(g, ((a ? SEC_PAD : 0) + (b ? SEC_TOP : 0) + 14) * secM);
  };
  const gapsSum = (pid, kids) => { let g = 0; for (let i = 0; i < kids.length - 1; i++) g += gapAfter(pid, kids, i); return g; };
  const tuck = (id, at) => { for (const c of kidsOf(id)) { pos[c.id] = { ...at }; tuck(c.id, at); } };
  // a section dragged away from its tree's layout carries an offset (ox, oy); its notes are placed shifted by it
  const off = id => { let x = 0, y = 0, sec = N(id) && effSec(N(id)) && SEC(effSec(N(id))), g = 0; while (sec && g++ < 20) { x += sec.ox || 0; y += sec.oy || 0; sec = sec.parent && SEC(sec.parent); } return { x, y }; };
  const relOff = id => { const n = N(id), a = off(id); if (!n.parentId || !N(n.parentId)) return a; const b = off(n.parentId); return { x: a.x - b.x, y: a.y - b.y }; };
  // a subtree pulled away by its section no longer takes room among its siblings
  const detached = id => { const r = relOff(id); return r.x !== 0 || r.y !== 0; };
  const stackKids = id => visKids(id).filter(k => !detached(k.id));
  const measureSub = id => {
    const all = visKids(id), kids = all.filter(k => !detached(k.id)), h = size(id).h, p = pk(id);
    for (const k of all) if (detached(k.id)) measureSub(k.id);
    if (!kids.length) return (sub[id] = h);
    const sum = (kids.reduce((s, k) => s + measureSub(k.id), 0) + gapsSum(id, kids)) * p;
    return (sub[id] = Math.max(h, sum));
  };
  const place = (id, x, top) => {
    const ro = relOff(id); x += ro.x; top += ro.y;
    const n0 = N(id); shown.push(id);
    if (n0.parentId && N(n0.parentId)) { const a = nudgeOf(n0); x += a.x; top += a.y; lastNudgeY[id] = a.y; } // moved by hand at this zoom level
    const s = size(id), p = pk(id);
    pos[id] = { x, y: top + (sub[id] - s.h) / 2 };
    if (!visKids(id).length) { tuck(id, pos[id]); return; } // folded away behind their parent
    const cx = x + s.w + gx(id) * (0.45 + 0.55 * p);
    // detached kids that moved together (same offset) stack as their own group, centred on the parent
    const groups = {};
    for (const k of visKids(id)) if (detached(k.id)) { const r = relOff(k.id), key = r.x + ',' + r.y; (groups[key] = groups[key] || []).push(k); }
    const stack = list => {
      const sum = (list.reduce((a, k) => a + sub[k.id], 0) + gapsSum(id, list)) * p;
      let cy = top + (sub[id] - sum) / 2;
      list.forEach((k, i) => {
        const slot = sub[k.id] * p;
        place(k.id, cx, cy + (slot - sub[k.id]) / 2);
        if (i < list.length - 1) cy += slot + gapAfter(id, list, i) * p;
      });
    };
    for (const g of Object.values(groups)) stack(g);
    const kids = stackKids(id);
    if (kids.length) stack(kids);
    // the kids that stay in the tree make way for any group a section pulled away, so nothing ends up over its frame
    const fixed = Object.values(groups);
    if (!fixed.length || !kids.length) return;
    const gap = Math.max(gy(id), 14 * secM);
    for (const g of fixed) {
      const F = g.map(k => subBox(k.id)).reduce(unionBox);
      const fc = (F.y0 + F.y1) / 2;
      const boxes = kids.map(k => subBox(k.id));
      const centre = i => (boxes[i].y0 + boxes[i].y1) / 2;
      const idx = kids.map((k, i) => i);
      const above = idx.filter(i => centre(i) < fc).reverse(), below = idx.filter(i => centre(i) >= fc);
      for (const [list, dir] of [[above, -1], [below, 1]]) {
        const obst = [F];
        for (const i of list) {
          const b = boxes[i];
          let need = 0;
          for (const o of obst) {
            if (b.x0 >= o.x1 + gap || b.x1 <= o.x0 - gap) continue;
            need = dir < 0 ? Math.min(need, o.y0 - gap - b.y1) : Math.max(need, o.y1 + gap - b.y0);
          }
          if (need) { shiftSub(kids[i].id, need); b.y0 += need; b.y1 += need; }
          obst.push(b);
        }
      }
    }
  };
  // a subtree's extent as drawn, with room for the frames of the sections its notes sit in
  const subBox = id => {
    const p = pos[id], s = size(id), sec = secOf(N(id));
    const pad = sec ? SEC_PAD * secM : 0, top = sec ? SEC_TOP * secM : 0;
    let b = { x0: p.x - pad, x1: p.x + s.w + pad, y0: p.y - top, y1: p.y + s.h + pad };
    for (const k of visKids(id)) b = unionBox(b, subBox(k.id));
    return b;
  };
  const unionBox = (a, b) => ({ x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1) });
  const shiftSub = (id, dy) => { pos[id].y += dy; for (const k of kidsOf(id)) if (pos[k.id]) shiftSub(k.id, dy); };
  if (onlyId) {
    measureSub(onlyId);
    const oo = relOff(onlyId);
    place(onlyId, N(onlyId).x - oo.x, N(onlyId).y - oo.y - (sub[onlyId] - size(onlyId).h) / 2);
    return pos;
  }
  const rs = roots().sort((a, b) => a.y - b.y || a.x - b.x);
  const boxes = [], frees = [];
  shown.length = 0;
  for (const r of rs) {
    if (!kidsOf(r.id).length) { pos[r.id] = { x: r.x, y: r.y - (r.push || 0) }; frees.push(r); continue; } // free notes stay put (r.push: how far a tree pushed it from there)
    measureSub(r.id);
    const ro = off(r.id), rx = r.x - ro.x; // place() adds the offset back
    let top = r.y - ro.y - (sub[r.id] - size(r.id).h) / 2;
    place(r.id, rx, top);
    const box = subBox(r.id), y0 = box.y0; // whole tree as drawn, including groups a section pulled away
    for (let guard = 0; guard < 200; guard++) {
      const hit = boxes.find(b => box.x0 < b.x1 + 40 && box.x1 > b.x0 - 40 && box.y0 < b.y1 + ROOT_GAP && box.y1 > b.y0 - ROOT_GAP);
      if (!hit) break;
      const shift = hit.y1 + ROOT_GAP - box.y0;
      box.y0 += shift; box.y1 += shift;
    }
    if (box.y0 !== y0) shiftSub(r.id, box.y0 - y0);
    boxes.push(box);
  }
  if (alignWho) { const who = alignWho; alignWho = null; alignLinked(pos, who); }
  // a free note makes way (up or down, whichever is nearer) for a tree that unfolds over it, and goes back once there is room again
  const PAD = 14 * secM, rect = id => { const p = pos[id], s = size(id); return { x0: p.x, x1: p.x + s.w, y0: p.y, y1: p.y + s.h }; };
  const obst = shown.map(rect);
  for (const r of frees) {
    const p = pos[r.id], s = size(r.id), home = (p.home = p.y);
    const near = obst.filter(o => o.x0 < p.x + s.w + PAD && o.x1 > p.x - PAD);
    const clear = y => !near.some(o => o.y0 < y + s.h + PAD - 0.01 && o.y1 > y - PAD + 0.01);
    if (clear(home)) continue;
    let best = null, cost = Infinity;
    for (const o of near) for (const y of [o.y0 - PAD - s.h, o.y1 + PAD]) {
      const c = Math.abs(y - home) * ((r.push || 0) * (y - home) < 0 ? 1.5 : 1); // rather stay on the side it is already on
      if (c < cost && clear(y)) { best = y; cost = c; }
    }
    if (best !== null) { p.y = best; obst.push(rect(r.id)); }
  }
  return pos;
}
// Auto-arrange for diagrams: free notes joined by an arrow get their centres lined up when they are already nearly in line
// (within ALIGN_NEAR), so a column or a row of boxes is exact while notes placed apart on purpose are left alone.
const ALIGN_NEAR = 24;
let alignWho = null; // 'all' (Arrange) or the notes just moved (Auto): who the next layout may line up
function alignLinked(pos, who) {
  const free = id => N(id) && pos[id] && !isTree(N(id)) && !isHidden(N(id));
  const c = id => { const z = size(id); return { x: pos[id].x + z.w / 2, y: pos[id].y + z.h / 2 }; };
  for (const ax of ['x', 'y']) {
    const o = ax === 'x' ? 'y' : 'x', up = {}, find = i => (up[i] === undefined || up[i] === i ? i : (up[i] = find(up[i])));
    for (const L of doc.links || []) {
      if (L.kind !== 'flow' || !free(L.a) || !free(L.b)) continue;
      const a = c(L.a), b = c(L.b), d = Math.abs(a[ax] - b[ax]);
      if (d <= ALIGN_NEAR && Math.abs(a[o] - b[o]) > d) { up[L.a] = find(L.a); up[L.b] = find(L.b); up[find(L.a)] = find(L.b); }
    }
    const groups = {};
    for (const id in up) (groups[find(id)] = groups[find(id)] || []).push(id);
    for (const g of Object.values(groups)) {
      const mine = who === 'all' ? g : g.filter(id => who.has(id)); if (!mine.length) continue;
      const rest = who === 'all' ? g : g.filter(id => !who.has(id)); // moved notes join the ones that stayed
      const v = (rest.length ? rest : g).map(id => c(id)[ax]).sort((p, q) => p - q), t = v[(v.length - 1) >> 1]; // the middle one stays, the rest join it
      for (const id of mine) { const dd = t - c(id)[ax]; pos[id][ax] += dd; if (ax === 'y' && pos[id].home !== undefined) pos[id].home += dd; } // lining up is not being pushed aside by a tree
    }
  }
}
let layoutAnim = null;
function tidy() {
  if (editingId) commitEdit();
  if (!all().length) return;
  checkpoint();
  const L = zoomLevel(); // tidy clears hand placement at this zoom level
  for (const n of all()) if (n.nudge && n.nudge[L]) { delete n.nudge[L]; if (!Object.keys(n.nudge).length) delete n.nudge; }
  alignWho = 'all';
  animateLayout(layoutTargets());
}
const autoOn = () => doc.autoLayout !== false;
function relayout() { if (all().length) animateLayout(layoutTargets()); }
function anchorNote() {
  const pt = lastPointer || { x: innerWidth / 2, y: innerHeight / 2 };
  const w = toWorld(pt.x, pt.y);
  let best = null, bd = Infinity;
  for (const n of all()) {
    if (isHidden(n) && !(n.parentId && N(n.parentId) && !isHidden(N(n.parentId)))) continue;
    const s = size(n.id), dx = Math.max(n.x - w.x, 0, w.x - n.x - s.w), dy = Math.max(n.y - w.y, 0, w.y - n.y - s.h);
    const d = dx * dx + dy * dy;
    if (!isHidden(n) && d < bd) { bd = d; best = n.id; }
  }
  return best;
}
// put a note where the layout wants it; a free note that made way for a tree remembers how far it went (n.push), so it can go back
function putAt(n, p, x = p.x, y = p.y) {
  n.x = x; n.y = y;
  const d = p.home === undefined ? 0 : y - p.home;
  if (Math.abs(d) > 0.5) n.push = d; else delete n.push;
}
const centerOnScreen = id => { const n = N(id), z = size(id); return toScreen(n.x + z.w / 2, n.y + z.h / 2); };
function animateLayout(target, anchor, ms = 380, pre = null) {
  const from = {};
  for (const id in target) from[id] = { x: N(id).x, y: N(id).y };
  cancelAnimationFrame(layoutAnim);
  const t0 = performance.now();
  const step = now => {
    const t = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - t, 3);
    const A = anchor && N(anchor);
    const before = A && (pre || centerOnScreen(anchor)); pre = null;
    for (const id in target) {
      const n = N(id); if (!n) continue;
      putAt(n, target[id], Math.round(from[id].x + (target[id].x - from[id].x) * e), Math.round(from[id].y + (target[id].y - from[id].y) * e));
      if (els[id]) { els[id].style.left = n.x + 'px'; els[id].style.top = n.y + 'px'; }
    }
    if (A) { // keep the note under the cursor still while the tree reshapes
      const after = centerOnScreen(anchor);
      view().x += before.x - after.x; view().y += before.y - after.y; applyView();
    }
    drawEdges(); positionToolbar();
    if (t < 1) layoutAnim = requestAnimationFrame(step);
    else scheduleSave();
  };
  layoutAnim = requestAnimationFrame(step);
}

/* ---------------- sections: rectangles that group a region ----------------
   Right-drag on empty canvas draws one. They sit behind notes and pan/zoom
   with the canvas. Drag the label to move (with its member notes; frames refit
   around their notes on every move/zoom), drag a corner to resize, double-click the label to
   rename, Delete removes (Ctrl+Z brings it back). */

const MIN_SECTION = 40;            // smallest section, in canvas units
const secEls = {};                 // id -> element
let selectedSection = null;
let editingSection = null;         // section whose label is being edited
let freshSection = null;           // section just drawn (its label edit is part of the same undo step)
const sectionToolbar = $('#section-toolbar');
const SEC = id => doc.sections && doc.sections[id];
const allSections = () => Object.values(doc.sections || {});
const noteDragging = () => !!dragState && (dragState.type === 'move' || dragState.type === 'link');

function renderSections() {
  const live = new Set();
  // big sections first, so smaller ones nested inside stay on top and clickable
  const list = allSections().sort((a, b) => b.w * b.h - a.w * a.h);
  for (const sec of list) {
    live.add(sec.id);
    let el = secEls[sec.id];
    if (!el) {
      el = document.createElement('div');
      el.className = 'section';
      el.dataset.sid = sec.id;
      el.innerHTML = '<div class="sec-label" data-ph="Section"></div>' +
        ['nw', 'ne', 'sw', 'se'].map(c => `<div class="sec-h ${c}" data-corner="${c}"></div>`).join('');
      secEls[sec.id] = el;
    }
    placeSection(sec);
    el.classList.toggle('selected', sec.id === selectedSection);
    const c = colorOf(sec);
    if (c) el.style.setProperty('--c', c); else el.style.removeProperty('--c');
    const t = el.firstChild;
    if (sec.id !== editingSection && t.textContent !== sec.label) t.textContent = sec.label;
  }
  for (const id of Object.keys(secEls)) {
    if (!live.has(id)) { secEls[id].remove(); delete secEls[id]; }
  }
  // stacking order (only touch the DOM when it changed, so a label being edited keeps focus)
  const order = list.map(s => secEls[s.id]), now = [...sectionsLayer.children].filter(c => c !== draftEl);
  if (order.length !== now.length || order.some((el, i) => el !== now[i])) for (const el of order) sectionsLayer.appendChild(el);
  if (draftEl) sectionsLayer.appendChild(draftEl);
  updateSectionToolbar();
}
function placeSection(sec) {
  const el = secEls[sec.id]; if (!el) return;
  el.style.left = sec.x + 'px'; el.style.top = sec.y + 'px';
  el.style.width = sec.w + 'px'; el.style.height = sec.h + 'px';
}

function selectSection(id) {
  if (editingSection && editingSection !== id) finishSectionLabel(true);
  if (id && (selectedId || editingId)) select(null);
  if (selectedSection === id) { updateSectionToolbar(); return; }
  selectedSection = id;
  for (const k in secEls) secEls[k].classList.toggle('selected', k === id);
  updateSectionToolbar();
}
function updateSectionToolbar() {
  const sec = selectedSection && SEC(selectedSection);
  if (!sec || (dragState && dragState.type !== 'pan') || editingSection) { sectionToolbar.hidden = true; return; }
  sectionToolbar.hidden = false;
  for (const b of sectionToolbar.querySelectorAll('[data-color]')) b.classList.toggle('active', b.dataset.color === (sec.color || 'none'));
  positionSectionToolbar();
}
function positionSectionToolbar() {
  if (sectionToolbar.hidden || !selectedSection || !SEC(selectedSection)) return;
  const sec = SEC(selectedSection);
  const a = toScreen(sec.x, sec.y), b = toScreen(sec.x + sec.w, sec.y + sec.h);
  const tw = sectionToolbar.offsetWidth, th = sectionToolbar.offsetHeight;
  let left = a.x, top = a.y - th - 10;
  if (top < 50) top = Math.min(Math.max(a.y, 50) + 44, b.y + 10); // no room above: tuck inside, under the label
  left = Math.max(8, Math.min(innerWidth - tw - 8, left));
  top = Math.max(50, Math.min(innerHeight - th - 8, top));
  sectionToolbar.style.left = left + 'px';
  sectionToolbar.style.top = top + 'px';
}

function createSection(rect) {
  if (editingId) commitEdit();
  checkpoint();
  const id = uid();
  doc.sections[id] = { id, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h), label: '', color: 'none' };
  freshSection = id;
  const r = doc.sections[id];
  const outer = sectionAt(r.x + r.w / 2, r.y + r.h / 2, id);
  if (outer && SEC(outer).w * SEC(outer).h > r.w * r.h) r.parent = outer;
  r.v = 2; claimArea(r);
  renderSections(); fitSections();
  selectSection(id);
  startSectionLabel(id);
  scheduleSave();
  $('#empty').hidden = true;
}
function deleteSection(id) {
  const sec = SEC(id); if (!sec) return;
  if (editingSection) finishSectionLabel(false);
  if (editingId) finishEditing(false);
  checkpoint();
  // the section goes with everything inside it: its notes (and their children) and any sections nested in it
  const secs = [id, ...allSections().filter(o => secInside(o.id, id)).map(o => o.id)], fam = new Set(secs);
  const gone = new Set();
  for (const n of all()) if (fam.has(effSec(n))) { gone.add(n.id); for (const d of descendants(n.id)) gone.add(d); }
  for (const g of gone) delete doc.nodes[g];
  doc.links = doc.links.filter(L => N(L.a) && N(L.b));
  for (const s2 of secs) delete doc.sections[s2];
  for (const o of allSections()) if (o.parent && !SEC(o.parent)) o.parent = sec.parent || null;
  if (selectedSection && !SEC(selectedSection)) selectedSection = null;
  if (selectedId && !N(selectedId)) selectedId = null;
  render(); relayout(); scheduleSave();
  $('#empty').hidden = all().length > 0 || allSections().length > 0;
  const what = sec.label ? `section “${sec.label.slice(0, 28)}”` : 'section';
  toast(gone.size ? `Deleted ${what} and its ${gone.size} note${gone.size > 1 ? 's' : ''}` : `Deleted ${what}`, 'Undo', undo);
}

function setSectionColor(id, c) {
  const sec = SEC(id); if (!sec || sec.color === c) return;
  checkpoint(); sec.color = c; renderSections(); scheduleSave();
}

function startSectionLabel(id) {
  const el = secEls[id]; if (!el) return;
  if (editingId) commitEdit();
  editingSection = id;
  el.classList.add('editing');
  const t = el.firstChild;
  t.contentEditable = 'plaintext-only';
  t.focus();
  const range = document.createRange(); range.selectNodeContents(t);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  updateSectionToolbar();
}
function finishSectionLabel(save) {
  const id = editingSection; if (!id) return;
  editingSection = null;
  const el = secEls[id], sec = SEC(id);
  if (el) {
    const t = el.firstChild;
    t.contentEditable = 'false';
    el.classList.remove('editing');
    if (sec && save) {
      const text = t.innerText.replace(/\s+/g, ' ').trim().slice(0, 120);
      if (text !== sec.label) { if (freshSection !== id) checkpoint(); sec.label = text; scheduleSave(); }
    }
    if (sec) t.textContent = sec.label;
  }
  freshSection = null;
  getSelection().removeAllRanges();
  renderSections();
}
sectionsLayer.addEventListener('keydown', e => {
  if (!editingSection) return;
  e.stopPropagation();
  if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); finishSectionLabel(true); }
});
sectionsLayer.addEventListener('focusout', () => {
  setTimeout(() => { if (editingSection && document.activeElement !== secEls[editingSection]?.firstChild) finishSectionLabel(true); }, 0);
});

/* live rectangle while right-dragging */
let draftEl = null;
function showDraft(r) {
  if (!draftEl) { draftEl = document.createElement('div'); draftEl.className = 'section draft'; sectionsLayer.appendChild(draftEl); }
  draftEl.style.left = r.x + 'px'; draftEl.style.top = r.y + 'px';
  draftEl.style.width = r.w + 'px'; draftEl.style.height = r.h + 'px';
}
function hideDraft() { if (draftEl) { draftEl.remove(); draftEl = null; } }
const rectFrom = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });


// a note's section: its own (n.section), or else its parent's. false = explicitly in none
function effSec(n) {
  for (let m = n, g = 0; m && g < 60; g++) {
    if (m.section !== undefined) return m.section && SEC(m.section) ? m.section : null;
    m = m.parentId && N(m.parentId);
  }
  return null;
}
/* ---- membership: each note belongs to at most one section (n.section). A section with
   members wraps them: its frame is fitted around them every time things move or zoom ---- */
const secDepth = sec => { let d = 0, p = sec; while (p && p.parent && SEC(p.parent) && d < 20) { p = SEC(p.parent); d++; } return d; };
const secInside = (id, anc) => { let p = SEC(id), g = 0; while (p && p.parent && g++ < 20) { if (p.parent === anc) return true; p = SEC(p.parent); } return false; };
function sectionAt(x, y, except) {
  let best = null;
  for (const sec of allSections()) {
    if (sec.id === except) continue;
    if (x >= sec.x && x <= sec.x + sec.w && y >= sec.y && y <= sec.y + sec.h && (!best || sec.w * sec.h < best.w * best.h)) best = sec;
  }
  return best ? best.id : null;
}
const noteCentre = n => { const z = size(n.id); return { x: n.x + z.w / 2, y: n.y + z.h / 2 }; };
// claim the notes (and smaller sections) lying in sec's current rectangle
function claimArea(sec) {
  const r = sec, inR = (x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  for (const o of allSections()) {
    if (o.id === sec.id || secInside(sec.id, o.id)) continue;
    if (inR(o.x, o.y) && inR(o.x + o.w, o.y + o.h) && o.w * o.h < r.w * r.h) { if (!o.parent || !SEC(o.parent) || o.parent === sec.parent) o.parent = sec.id; }
    else if (o.parent === sec.id) o.parent = sec.parent || null;
  }
  for (const n of all()) {
    const c = noteCentre(n);
    const e = effSec(n), mine = e === sec.id || (e && secInside(e, sec.id));
    if (inR(c.x, c.y)) { if (!mine) n.section = sec.id; }
    else if (n.section === sec.id) delete n.section; // falls back to whatever its parent is in
  }
}
// a hidden note is folded into its nearest visible ancestor: the frame wraps that instead
function shownAs(n) { let m = n, g = 0; while (m && isHidden(m) && m.parentId && g++ < 60) m = N(m.parentId); return m && !isHidden(m) ? m : null; }
const SEC_PAD = 22, SEC_TOP = 44;
let fitting = false;
function fitSections() {
  if (fitting || !doc.sections) return;
  const list = allSections();
  if (!list.length) return;
  fitting = true;
  try {
    // sections drawn before membership existed: adopt whatever lies inside them now
    for (const sec of list.filter(x => !x.v).sort((a, b) => a.w * a.h - b.w * b.h)) { sec.v = 2; claimArea(sec); }
    const frozen = dragState && (dragState.type === 'move' || (dragState.type === 'section-resize' && dragState.sid));
    // while a section is dragged, the others hold still (so it can be dropped into or out of them)
    const moving = dragState && dragState.type === 'section-move' && dragState.moved ? new Set(dragState.secs) : null;
    const m = Math.max(1, 1 / view().k); // keep the padding readable when zoomed out
    const boxes = {};
    for (const n of all()) {
      const es = effSec(n); if (!es) continue;
      const v = shownAs(n); if (!v || !els[v.id]) continue;
      const z = size(v.id), fold = els[v.id].querySelector('.fold') ? 52 * (scaleNow[v.id] || 1) : 0; // room for the +N badge
      (boxes[es] = boxes[es] || []).push({ x0: v.x, y0: v.y, x1: v.x + z.w + fold, y1: v.y + z.h });
    }
    for (const sec of list.sort((a, b) => secDepth(b) - secDepth(a))) { // innermost first
      if (moving && !moving.has(sec.id)) continue;
      if (frozen && (dragState.type === 'move' || dragState.sid === sec.id)) { if (sec.parent && SEC(sec.parent)) (boxes[sec.parent] = boxes[sec.parent] || []).push({ x0: sec.x, y0: sec.y, x1: sec.x + sec.w, y1: sec.y + sec.h }); continue; }
      const b = boxes[sec.id];
      if (b && b.length) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const q of b) { x0 = Math.min(x0, q.x0); y0 = Math.min(y0, q.y0); x1 = Math.max(x1, q.x1); y1 = Math.max(y1, q.y1); }
        let nx = x0 - SEC_PAD * m, ny = y0 - SEC_TOP * m, nw = x1 - x0 + 2 * SEC_PAD * m, nh = y1 - y0 + (SEC_TOP + SEC_PAD) * m;
        if (sec.stretched) { // just stretched by hand (auto-arrange off): remember how far beyond its notes each side reaches
          const q = { l: Math.max(0, Math.round(nx - sec.x)), t: Math.max(0, Math.round(ny - sec.y)), r: Math.max(0, Math.round(sec.x + sec.w - nx - nw)), b: Math.max(0, Math.round(sec.y + sec.h - ny - nh)) };
          delete sec.stretched;
          if (q.l || q.t || q.r || q.b) sec.pad = q; else delete sec.pad;
        }
        if (sec.pad) { const q = sec.pad; nx -= q.l; ny -= q.t; nw += q.l + q.r; nh += q.t + q.b; }
        if (Math.abs(nx - sec.x) + Math.abs(ny - sec.y) + Math.abs(nw - sec.w) + Math.abs(nh - sec.h) > 0.5) {
          Object.assign(sec, { x: nx, y: ny, w: nw, h: nh });
          placeSection(sec);
        }
      }
      if (sec.parent && SEC(sec.parent) && !(moving && sec.id === dragState.sid)) (boxes[sec.parent] = boxes[sec.parent] || []).push({ x0: sec.x, y0: sec.y, x1: sec.x + sec.w, y1: sec.y + sec.h });
    }
  } finally { fitting = false; }
  if (selectedSection) positionSectionToolbar();
}
// what moves with a section: notes whose centre is inside it, and sections fully inside it.
// With auto-arrange on, a note's place comes from its tree, so only whole trees whose root is inside move.
function sectionContents(sec) {
  const secs = allSections().filter(o => secInside(o.id, sec.id)).map(o => o.id);
  const fam = new Set([sec.id, ...secs]);
  let notes = all().filter(n => fam.has(effSec(n))).map(n => n.id);
  const isRoot = id => !N(id).parentId || !N(N(id).parentId);
  const rootOf = id => { let n = N(id), g = 0; while (n.parentId && N(n.parentId) && g++ < 60) n = N(n.parentId); return n.id; };
  void rootOf; // notes follow the section's offset in the layout
  void isRoot;
  notes = [...new Set(notes)];
  return { notes, secs };
}

/* ---------------- pointer interaction ---------------- */

let dragState = null;
let spaceDown = false;

function nodeAtPoint(wx, wy, exclude) {
  const list = all().filter(n => !isHidden(n) && !exclude.has(n.id));
  for (let i = list.length - 1; i >= 0; i--) {
    const n = list[i], s = size(n.id);
    if (wx >= n.x && wx <= n.x + s.w && wy >= n.y && wy <= n.y + s.h) return n.id;
  }
  return null;
}
function setDropTarget(id) {
  if (dragState.drop === id) return;
  if (dragState.drop && els[dragState.drop]) els[dragState.drop].classList.remove('drop-target');
  dragState.drop = id;
  if (id && els[id]) els[id].classList.add('drop-target');
}

viewport.addEventListener('pointerdown', e => {
  const hit = e.button === 0 && e.target.closest && e.target.closest('.hit');
  if (hit && !spaceDown) { e.preventDefault(); selectLink(hit.dataset.link); return; }
  const nodeEl = e.target.closest('.node');
  const id = nodeEl && nodeEl.dataset.id;
  if (nodeEl && e.target.closest('.jump') && e.button === 0) {
    e.preventDefault(); e.stopPropagation();
    const t = jumpTargets(id);
    if (t.length === 1) focusNote(t[0], id); else openJumpMenu(id, e.clientX, e.clientY);
    return;
  }
  if (nodeEl && e.button === 0 && !spaceDown && e.target.closest('.thumb')) {
    e.preventDefault(); e.stopPropagation();
    const th = e.target.closest('.thumb');
    if (document.activeElement === bodyText) bodyText.blur();
    if (e.target.closest('.x')) removeImage(id, 'note', +th.dataset.i);
    else { select(id); openLightbox(th.querySelector('img').src); }
    return;
  }
  if (!nodeEl && selectedLink) { selectedLink = null; linkBar.hidden = true; drawEdges(); }

  if (e.button === 2) {
    // right-drag on empty canvas (or inside a section) draws a section; a plain right-click does nothing
    if (nodeEl || dragState) return;
    viewport.setPointerCapture(e.pointerId);
    dragState = { type: 'section-draw', sx: e.clientX, sy: e.clientY, moved: false, start: toWorld(e.clientX, e.clientY) };
    return;
  }
  if (dragState && dragState.type === 'section-draw') return;

  // sections: drag the label to move, a corner to resize, click the label to select
  const secEl = !nodeEl && e.button === 0 && !spaceDown && e.target.closest('.sec-label, .sec-h') && e.target.closest('.section');
  if (secEl) {
    const sid = secEl.dataset.sid, sec = SEC(sid);
    if (sid === editingSection && e.target.closest('.sec-label')) return; // let text selection happen
    e.preventDefault();
    if (editingId) commitEdit();
    selectSection(sid);
    viewport.setPointerCapture(e.pointerId);
    const corner = e.target.dataset.corner;
    if (corner) {
      dragState = { type: 'section-resize', sid, corner, sx: e.clientX, sy: e.clientY, moved: false, orig: { ...sec } };
    } else {
      const inside = sectionContents(sec);
      const secs = [sid, ...inside.secs];
      dragState = {
        type: 'section-move', sid, sx: e.clientX, sy: e.clientY, moved: false, ox0: sec.ox || 0, oy0: sec.oy || 0,
        notes: inside.notes, secs,
        start: Object.fromEntries([...inside.notes.map(n => [n, { x: N(n).x, y: N(n).y }]), ...secs.map(s => [s, { x: SEC(s).x, y: SEC(s).y }])]),
      };
    }
    return;
  }

  // pan: middle button or space+drag. A left-drag on empty canvas draws a selection rectangle
  if (e.button === 1 || spaceDown || !nodeEl) {
    if (editingId) commitEdit();
    if (editingSection) finishSectionLabel(true);
    e.preventDefault();
    viewport.setPointerCapture(e.pointerId);
    if (!nodeEl && e.button === 0 && !spaceDown) {
      select(null); selectSection(null);
      dragState = { type: 'marquee', sx: e.clientX, sy: e.clientY, moved: false, start: toWorld(e.clientX, e.clientY) };
      return;
    }
    dragState = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: view().x, vy: view().y };
    viewport.classList.add('panning');
    return;
  }
  if (id === editingId) return; // let text selection happen

  if (e.target.classList.contains('fold')) {
    e.stopPropagation(); select(id); toggleCollapse(id); return;
  }

  if (e.target.classList.contains('handle')) {
    e.preventDefault();
    select(id);
    viewport.setPointerCapture(e.pointerId);
    dragState = { type: 'link', id, sx: e.clientX, sy: e.clientY, moved: false, drop: null };
    updateToolbar();
    return;
  }

  e.preventDefault();
  const wasSelected = selectedId === id && !pendingFocus;
  const group = multi.size > 1 && multi.has(id); // dragging one of several selected notes moves them all
  select(id);
  const moving = group ? [...new Set([...multi].flatMap(m => [m, ...descendants(m)]))] : [id, ...descendants(id)];
  dragState = {
    type: 'move', id, sx: e.clientX, sy: e.clientY, moved: false, drop: null, wasSelected, group, dup: e.altKey,
    moving, exclude: new Set(moving),
    start: Object.fromEntries(moving.map(m => [m, { x: N(m).x, y: N(m).y }])),
  };
  viewport.setPointerCapture(e.pointerId);
});

window.addEventListener('pointermove', e => { lastPointer = { x: e.clientX, y: e.clientY }; });
viewport.addEventListener('pointermove', e => {
  const d = dragState; if (!d) return;
  const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
  if (d.type === 'pan') {
    view().x = d.vx + dx; view().y = d.vy + dy; viewChanged(); return;
  }
  if (!d.moved && Math.hypot(dx, dy) < 4) return;
  if (!d.moved) {
    d.moved = true;
    if (d.type === 'move') {
      hideBody(); // while it is being dragged a note shows only its title
      cancelAnimationFrame(layoutAnim); checkpoint(); els[d.id] && els[d.id].classList.add('dragging'); for (const m of d.moving) d.start[m] = { x: N(m).x, y: N(m).y };
      if (d.dup) { // Alt+drag: a copy stays behind where the selection was
        const tops = d.group ? [...multi] : [d.id];
        insertNotes(packNotes(tops), { keepParents: true });
        render();
      }
    }
    if (d.type === 'section-move' || d.type === 'section-resize') { checkpoint(); secEls[d.sid] && secEls[d.sid].classList.add('dragging'); }
    toolbar.hidden = true; sectionToolbar.hidden = true;
  }
  const w = toWorld(e.clientX, e.clientY);
  const k = view().k;
  if (d.type === 'section-draw') { showDraft(rectFrom(d.start, w)); return; }
  if (d.type === 'marquee') { showDraft(rectFrom(d.start, w)); draftEl.classList.add('marquee'); return; }
  if (d.type === 'section-move') {
    if (d.moved) { // tree notes: shift the section's offset and re-run the layout, so only its notes move
      const sec = SEC(d.sid);
      d.corr = d.corr || { x: 0, y: 0 };
      if (sec) { sec.ox = Math.round(d.ox0 + d.corr.x + dx / k); sec.oy = Math.round(d.oy0 + d.corr.y + dy / k); }
      for (const m of d.notes) { const n = N(m); if (n && !(n.parentId && N(n.parentId)) && d.start[m]) { n.x = Math.round(d.start[m].x + dx / k); n.y = Math.round(d.start[m].y + dy / k); delete n.push; } } // roots keep their own place
      let pos = layoutTargets();
      const a = d.notes.find(m => pos[m] && d.start[m]);
      if (sec && a && !d.corrected) { // the subtree may have jumped when it left its siblings: cancel that once
        d.corrected = true;
        const ex = d.start[a].x + dx / k - pos[a].x, ey = d.start[a].y + dy / k - pos[a].y;
        if (Math.abs(ex) + Math.abs(ey) > 1) { d.corr = { x: ex, y: ey }; sec.ox += Math.round(ex); sec.oy += Math.round(ey); pos = layoutTargets(); }
      }
      for (const id in pos) { const n = N(id); if (!n) continue; putAt(n, pos[id]); if (els[id]) { els[id].style.left = n.x + 'px'; els[id].style.top = n.y + 'px'; } }
      for (const s2 of d.secs) { const o = SEC(s2); if (!o) continue; o.x = Math.round(d.start[s2].x + dx / k); o.y = Math.round(d.start[s2].y + dy / k); placeSection(o); }
      drawEdges();
      return;
    }
    let gx = dx / k, gy = dy / k;
    const s0 = (e.ctrlKey || e.metaKey) && d.secs.length && d.start[d.secs[0]];
    if (s0) { gx = Math.round((s0.x + gx) / GRID) * GRID - s0.x; gy = Math.round((s0.y + gy) / GRID) * GRID - s0.y; }
    for (const m of d.notes) {
      const n = N(m); if (!n) continue;
      n.x = Math.round(d.start[m].x + gx); n.y = Math.round(d.start[m].y + gy); delete n.push;
      if (els[m]) { els[m].style.left = n.x + 'px'; els[m].style.top = n.y + 'px'; }
    }
    for (const s of d.secs) {
      const sec = SEC(s); if (!sec) continue;
      sec.x = Math.round(d.start[s].x + gx); sec.y = Math.round(d.start[s].y + gy);
      placeSection(sec);
    }
    if (d.notes.length) drawEdges();
    return;
  }
  if (d.type === 'section-resize') {
    const o = d.orig, sec = SEC(d.sid); if (!sec) return;
    let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
    if (d.corner.includes('w')) x0 = Math.min(o.x + dx / k, x1 - MIN_SECTION); else x1 = Math.max(x1 + dx / k, x0 + MIN_SECTION);
    if (d.corner.includes('n')) y0 = Math.min(o.y + dy / k, y1 - MIN_SECTION); else y1 = Math.max(y1 + dy / k, y0 + MIN_SECTION);
    Object.assign(sec, { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) });
    placeSection(sec);
    return;
  }
  if (d.type === 'move') {
    const off = snapMove(d, dx / k, dy / k, e.ctrlKey || e.metaKey);
    for (const m of d.moving) {
      const n = N(m);
      n.x = Math.round(d.start[m].x + off.x);
      n.y = Math.round(d.start[m].y + off.y); delete n.push;
      if (els[m]) { els[m].style.left = n.x + 'px'; els[m].style.top = n.y + 'px'; }
    }
    const target = d.group ? null : nodeAtPoint(w.x, w.y, d.exclude);
    setDropTarget(target && target !== N(d.id).parentId ? target : null);
    d.guides = off.guides; drawEdges();
  } else if (d.type === 'link') {
    const target = nodeAtPoint(w.x, w.y, new Set([d.id]));
    setDropTarget(target);
    ghostEdge = { from: d.id, x: w.x, y: w.y };
    drawEdges();
  }
});

function endDrag(e) {
  const d = dragState; if (!d) return;
  dragState = null;
  viewport.classList.remove('panning');
  if (d.type === 'pan') { updateToolbar(); updateSectionToolbar(); return; }
  if (d.type === 'marquee') {
    hideDraft();
    if (!d.moved || e.type === 'pointercancel') return;
    const r = rectFrom(d.start, toWorld(e.clientX, e.clientY));
    const hit = all().filter(n => { if (isHidden(n)) return false; const z = size(n.id); return n.x < r.x + r.w && n.x + z.w > r.x && n.y < r.y + r.h && n.y + z.h > r.y; }).map(n => n.id);
    if (hit.length === 1) select(hit[0]); else setMulti(hit);
    updateToolbar();
    return;
  }
  if (d.type === 'section-draw') {
    hideDraft();
    if (!d.moved || e.type === 'pointercancel') return; // a plain right-click: nothing happens, as before
    const r = rectFrom(d.start, toWorld(e.clientX, e.clientY));
    // too small to be on purpose? (measured on screen, so it works at any zoom)
    if (r.w * view().k < 12 && r.h * view().k < 12) return;
    r.w = Math.max(r.w, MIN_SECTION); r.h = Math.max(r.h, MIN_SECTION);
    createSection(r);
    return;
  }
  if (d.type === 'section-move' || d.type === 'section-resize') {
    if (secEls[d.sid]) secEls[d.sid].classList.remove('dragging');
    if (d.moved) {
      if (d.type === 'section-resize' && SEC(d.sid)) {
        claimArea(SEC(d.sid));
        // auto-arrange off: the frame keeps the size you gave it; on: it snaps back around its notes
        if (autoOn()) delete SEC(d.sid).pad; else SEC(d.sid).stretched = true;
      }
      if (d.type === 'section-move' && SEC(d.sid)) { // dropped into (or out of) another section
        const me = SEC(d.sid), pw = toWorld(e.clientX, e.clientY), cx = pw.x, cy = pw.y; // where the pointer lets go
        let best = null;
        for (const o of allSections()) {
          if (d.secs.includes(o.id) || o.w * o.h <= me.w * me.h) continue;
          if (cx >= o.x && cx <= o.x + o.w && cy >= o.y && cy <= o.y + o.h && (!best || o.w * o.h < best.w * best.h)) best = o;
        }
        me.parent = best ? best.id : null;
      }
      if (d.type === 'section-move' && d.notes.length) { render(); relayout(); }
      else { renderSections(); drawEdges(); }
      scheduleSave();
    }
    updateSectionToolbar();
    return;
  }
  if (d.drop && els[d.drop]) els[d.drop].classList.remove('drop-target');
  if (d.type === 'move' && d.group) { // several notes moved together: each keeps the place it was dragged to
    if (els[d.id]) els[d.id].classList.remove('dragging');
    if (!d.moved) { setMulti([]); d.group = false; }
    else {
      const set = new Set(d.moving);
      for (const m of multi) {
        const n = N(m); if (!n || !d.start[m]) continue;
        const dx = n.x - d.start[m].x, dy = n.y - d.start[m].y;
        if (n.parentId && N(n.parentId)) { if (!set.has(n.parentId) && !autoOn()) { addNudge(n, dx, dy); lastNudgeY[n.id] = nudgeOf(n).y; } }
        else { const t = (c => sectionAt(c.x, c.y))(noteCentre(n)); if (t) n.section = t; else delete n.section; for (const c of descendants(n.id)) if (set.has(c) && N(c)) delete N(c).section; }
      }
      if (autoOn()) alignWho = new Set(d.moving);
      render(); relayout(); scheduleSave(); updateToolbar();
      return;
    }
  }
  if (d.type === 'move') {
    if (els[d.id]) els[d.id].classList.remove('dragging');
    if (d.moved) {
      const dropped = N(d.id);
      if (dropped) {
        const target = d.drop && N(d.drop) ? effSec(N(d.drop)) : (c => sectionAt(c.x, c.y))(noteCentre(dropped));
        const parentSec = dropped.parentId && N(dropped.parentId) ? effSec(N(dropped.parentId)) : null;
        if ((target || null) === parentSec && !(d.drop && !dropped.parentId)) delete dropped.section; // same as its parent: just follow it
        else dropped.section = target || false;
        const went = new Set(d.moving); // the notes under it that moved with it go in or out of the section with it
        for (const c of descendants(dropped.id)) if (went.has(c) && N(c)) delete N(c).section;
      }
      const mn = N(d.id);
      if (!autoOn() && !d.drop && mn && mn.parentId && N(mn.parentId) && d.start[d.id]) {
        const dx = mn.x - d.start[d.id].x, dy = mn.y - d.start[d.id].y;
        addNudge(mn, dx, dy); lastNudgeY[mn.id] = nudgeOf(mn).y; // keep its place among siblings
        if (d.moving.length === 1) for (const c of childrenOf(mn.id)) addNudge(c, -dx, -dy); // Alt: the branch stays put
      }
      if (autoOn() && mn && mn.nudge) { // moved while auto-arrange is on: this note goes back to its arranged place at this zoom level
        const L = zoomLevel(); delete mn.nudge[L]; if (!Object.keys(mn.nudge).length) delete mn.nudge;
      }
      if (d.drop && reparent(d.id, d.drop)) {
        if (mn) delete mn.nudge;
        // snap beside new parent
        const p = N(d.drop), ps = size(p.id), n = N(d.id);
        const ox = p.x + ps.w + GAP_X - n.x, oy = 0;
        if (n.x < p.x + ps.w) for (const m of d.moving) { N(m).x += ox; N(m).y += oy; }
        toast('Attached under “' + (p.text || 'note').split('\n')[0].slice(0, 30) + '”', 'Undo', undo);
      }
      if (autoOn()) alignWho = new Set(d.moving);
      render(); relayout(); scheduleSave();
    } else if (e && e.type === 'pointerup' && !e.altKey && N(d.id) && els[d.id]) {
      // click a note: select it and bring its branch into view; click it again (or double-click) to write
      if (d.wasSelected || pendingFocus) { clearTimeout(pendingFocus); pendingFocus = 0; editAt(d.id, e.clientX, e.clientY); return; }
      const id = d.id;
      if (openNoteLink(id) && /^mindview:/i.test(N(id).url)) return; // a shortcut: focus went to the linked note
      pendingFocus = setTimeout(() => { pendingFocus = 0; if (N(id) && selectedId === id && !editingId) focusBranch(id); }, 260); // wait: it may be a double-click
      updateToolbar();
      return;
    }
    updateToolbar();
  } else if (d.type === 'link') {
    if (!d.moved) { ghostEdge = null; drawEdges(); addChild(d.id); return; }
    const w = toWorld(e.clientX, e.clientY);
    if (d.drop) { const t = N(d.drop), ts = size(d.drop); ghostEdge = { from: d.id, x: t.x + ts.w / 2, y: t.y + ts.h / 2 }; }
    drawEdges();
    openRelationMenu(d.id, d.drop, w, e.clientX, e.clientY);
  }
}
viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);

viewport.addEventListener('dblclick', e => {
  // the click lands on the canvas (it captures the pointer while you press), so look at what's under it
  const under = document.elementFromPoint(e.clientX, e.clientY) || e.target;
  const nodeEl = under.closest('.node:not(.zhide)');
  if (under.closest('.handle, .fold, .sec-h')) return;
  if (nodeEl) {
    const id = nodeEl.dataset.id;
    // double-click writes (the second click of it already started editing); while writing it selects a word
    clearTimeout(pendingFocus); pendingFocus = 0;
    if (editingId === id) return;
    editAt(id, e.clientX, e.clientY);
    return;
  }
  const label = under.closest('.sec-label');
  if (label) { const sid = label.parentNode.dataset.sid; if (sid !== editingSection) { selectSection(sid); startSectionLabel(sid); } return; }
  const w = toWorld(e.clientX, e.clientY);
  newRootAt(w.x, w.y);
});

viewport.addEventListener('wheel', e => {
  e.preventDefault();
  cancelAnimationFrame(viewAnim); viewAnimating = false;
  lastPointer = { x: e.clientX, y: e.clientY };
  const trackpadPan = !e.ctrlKey && (Math.abs(e.deltaX) > 0 || (e.deltaMode === 0 && Math.abs(e.deltaY) < 40 && !Number.isInteger(e.deltaY)));
  if (trackpadPan) {
    view().x -= e.deltaX; view().y -= e.deltaY; viewChanged(); return;
  }
  const scale = e.deltaMode === 1 ? 30 : 1;
  const factor = Math.exp(-e.deltaY * scale * (e.ctrlKey ? 0.01 : 0.0018));
  smoothZoom(e.clientX, e.clientY, factor);
}, { passive: false });

// glide toward the wheel's target zoom instead of jumping a notch at a time
let zoomGoal = null, zoomRaf = null;
function smoothZoom(cx, cy, factor) {
  const base = zoomGoal ? zoomGoal.k : view().k;
  zoomGoal = { k: Math.min(MAX_K, Math.max(MIN_K, base * factor)), cx, cy };
  if (zoomRaf) return;
  const step = () => {
    const k = view().k, r = zoomGoal.k / k;
    if (Math.abs(r - 1) < 0.002) { zoomAt(zoomGoal.cx, zoomGoal.cy, r); zoomGoal = null; zoomRaf = null; return; }
    zoomAt(zoomGoal.cx, zoomGoal.cy, Math.pow(r, 0.22));
    zoomRaf = requestAnimationFrame(step);
  };
  zoomRaf = requestAnimationFrame(step);
}

viewport.addEventListener('contextmenu', e => {
  e.preventDefault();
  const jb = e.target.closest && e.target.closest('.jump');
  if (jb) { openJumpMenu(jb.parentElement.dataset.id, e.clientX, e.clientY); return; }
  const under = document.elementFromPoint(e.clientX, e.clientY) || e.target;
  const nodeEl = under.closest && under.closest('.node:not(.zhide)');
  if (nodeEl) openNodeMenu(nodeEl.dataset.id, e.clientX, e.clientY);
});
/* right-click a note: its context menu */
function openNodeMenu(id, sx, sy) {
  if (editingId && editingId !== id) commitEdit();
  clearTimeout(pendingFocus); pendingFocus = 0;
  select(id);
  jumpMenu.innerHTML = '<button class="pm-item" data-copylink="1"><span class="pm-name">Copy link</span></button>' +
    (N(id).url ? '<button class="pm-item" data-unlinkurl="1"><span class="pm-name">Remove link</span></button>' : '') +
    modMenuItems().filter(it => !it.show || it.show(N(id))).map(it => `<button class="pm-item" data-moditem="${esc(it.key)}"><span class="pm-name">${esc(typeof it.label === 'function' ? it.label(N(id)) : it.label)}</span></button>`).join('');
  nodeMenuFor = id;
  jumpMenu.classList.add('node-menu');
  jumpMenu.dataset.from = id;
  jumpMenu.hidden = false;
  positionNodeMenu();
  updateToolbar();
}
// the menu sits just right of the note (clear of its + handle and badges), or left of it when there's no room
function positionNodeMenu() {
  if (!nodeMenuFor || jumpMenu.hidden || !N(nodeMenuFor)) return;
  const n = N(nodeMenuFor), z = size(n.id), el = els[n.id];
  const a = toScreen(n.x, n.y), b = toScreen(n.x + z.w, n.y + z.h);
  let right = b.x;
  if (el) for (const c of el.querySelectorAll('.fold, .handle')) right = Math.max(right, c.getBoundingClientRect().right);
  const w = jumpMenu.offsetWidth, h = jumpMenu.offsetHeight;
  let left = right + 10;
  if (left + w > innerWidth - 8) left = Math.max(8, a.x - 10 - w);
  const top = Math.max(50, Math.min(innerHeight - h - 8, a.y));
  jumpMenu.style.left = left + 'px'; jumpMenu.style.top = top + 'px';
}
new MutationObserver(() => { if (jumpMenu.hidden && nodeMenuFor) { nodeMenuFor = null; updateToolbar(); } }).observe(jumpMenu, { attributes: true, attributeFilter: ['hidden'] });
// a note's link is a shortcut that brings that note into focus: paste it onto another note, then click that note
const noteLink = id => 'mindview://' + encodeURIComponent(currentId || 'board') + '/' + id;
function copyText(t) {
  const fallback = () => { const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); };
  try { navigator.clipboard.writeText(t).catch(fallback); } catch (_) { fallback(); }
}

/* ---------------- text editing events ---------------- */

nodesLayer.addEventListener('keydown', e => {
  if (!editingId) return;
  e.stopPropagation();
  const id = editingId;
  if (e.key === 'Escape') { e.preventDefault(); commitEdit(); return; }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitEdit(); if (N(id)) addSibling(id); return; }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); return; }
  if (e.key === 'Tab') { e.preventDefault(); commitEdit(); if (N(id)) addChild(id); return; }
  if (e.key === 'ArrowDown' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitEdit(); if (N(id)) { select(id); updateToolbar(); bodyText.focus(); } return; }
});
nodesLayer.addEventListener('input', () => {
  if (!editingId) return;
  measure(); drawEdges();
});
nodesLayer.addEventListener('focusout', e => {
  if (editingId && els[editingId] && els[editingId].contains(e.target)) {
    // defer so clicks that start a new edit are handled first
    setTimeout(() => { if (editingId && document.activeElement !== els[editingId]?.firstChild) commitEdit(); }, 0);
  }
});

/* ---------------- keyboard ---------------- */

function navigate(dir) {
  const n = selectedId && N(selectedId);
  if (!n) { const r = roots()[0]; if (r) { select(r.id); ensureVisible(r.id); } return; }
  let next = null;
  if (dir === 'left') next = n.parentId;
  else if (dir === 'right') {
    if (childrenOf(n.id).length && kidsHidden(n)) zoomToBranch(n.id);
    const kids = childrenOf(n.id); if (kids.length) next = kids[Math.floor((kids.length - 1) / 2)].id;
  } else {
    const sibs = n.parentId ? childrenOf(n.parentId) : roots().sort((a, b) => a.y - b.y);
    const i = sibs.findIndex(s => s.id === n.id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (sibs[j]) next = sibs[j].id;
  }
  if (next && N(next)) {
    select(next);
    if (isHidden(N(next))) zoomToBranch(N(next).parentId); else ensureVisible(next);
  }
}

window.addEventListener('keydown', e => {
  if (!$('#help').hidden) {
    if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); $('#help').hidden = true; }
    return;
  }
  if (editingId || editingSection) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const id = selectedId && N(selectedId) ? selectedId : null;
  if (e.key === 'F2' && !id && !(selectedSection && SEC(selectedSection)) && !multi.size) { e.preventDefault(); renameProjectInline(); return; }
  const k = e.key;

  if (dragState && dragState.type === 'section-draw') { // Esc cancels the section being drawn
    if (k === 'Escape') { dragState = null; hideDraft(); }
    return;
  }
  const sid = !id && selectedSection && SEC(selectedSection) ? selectedSection : null;
  if (sid && !ctrl) {
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteSection(sid); return; }
    if (k === 'Enter' || k === 'F2') { e.preventDefault(); startSectionLabel(sid); return; }
    if (k === 'Escape') { selectSection(null); return; }
  }

  if (k === ' ' && !id) { spaceDown = true; viewport.style.cursor = 'grab'; e.preventDefault(); return; }
  if (ctrl && k.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (ctrl && (k.toLowerCase() === 'y' || (k.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (ctrl && k.toLowerCase() === 'n') { e.preventDefault(); newRootCenter(); return; }
  if (ctrl && k.toLowerCase() === 'o') { e.preventDefault(); menu.hidden ? openMenu() : closeMenu(); return; }
  if (!menu.hidden && k === 'Escape') { closeMenu(); return; }
  if (ctrl && k.toLowerCase() === 'l') { e.preventDefault(); tidy(); return; }
  if (ctrl && k === '0') { e.preventDefault(); fitAll(); return; }
  if (ctrl && (k === '=' || k === '+')) { e.preventDefault(); zoomCenter(1.25); return; }
  if (ctrl && k === '-') { e.preventDefault(); zoomCenter(0.8); return; }
  if (ctrl && e.shiftKey && k.toLowerCase() === 'i' && host) { host.toggleDevTools(); return; }
  if (k === '?') { openHelp(); return; }

  if (k === 'Escape') { if (!relMenu.hidden) closeRelationMenu(); jumpMenu.hidden = true; if (selectedLink) { selectedLink = null; linkBar.hidden = true; drawEdges(); } select(null); return; }
  if (selectedLink && (k === 'Delete' || k === 'Backspace')) { e.preventDefault(); checkpoint(); deleteLink(selectedLink); return; }
  if (multi.size > 1) {
    if (k === 'Escape') { setMulti([]); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteMany([...multi]); return; }
  }
  if (k.startsWith('Arrow')) { e.preventDefault(); navigate(k.slice(5).toLowerCase()); return; }
  if (!id) return;
  if (k === 'Tab') { e.preventDefault(); addChild(id); return; }
  if (k === 'Enter' && ctrl) { e.preventDefault(); addSibling(id); return; }
  if (k === 'Enter' || k === 'F2') { e.preventDefault(); startEditing(id, false); return; }
  if (k === ' ') { e.preventDefault(); toggleCollapse(id); return; }
  if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteNode(id); return; }
  if (!ctrl && ['1', '2', '3'].includes(k)) { setSize(id, SIZES[+k - 1]); return; }
});
window.addEventListener('keyup', e => {
  if (e.key === ' ') { spaceDown = false; viewport.style.cursor = ''; }
});

/* ---------------- chrome buttons ---------------- */

toolbar.addEventListener('pointerdown', e => e.stopPropagation());
sectionToolbar.addEventListener('pointerdown', e => e.stopPropagation());
sectionToolbar.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || !selectedSection) return;
  const sid = selectedSection;
  if (b.dataset.color) setSectionColor(sid, b.dataset.color);
  else if (b.id === 'st-rename') startSectionLabel(sid);
  else if (b.id === 'st-delete') deleteSection(sid);
});
toolbar.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || !selectedId) return;
  const id = selectedId;
  if (b.dataset.size) setSize(id, b.dataset.size);
  else if (b.dataset.color && multi.size > 1 && multi.has(id)) { checkpoint(); for (const m of multi) if (N(m)) N(m).color = b.dataset.color; render(); scheduleSave(); }
  else if (b.dataset.color) setColor(id, b.dataset.color);
  else if (b.id === 'nt-child') addChild(id);
  else if (b.id === 'nt-collapse') toggleCollapse(id);
  else if (b.id === 'nt-detach') { checkpoint(); reparent(id, null); render(); relayout(); scheduleSave(); }
  else if (b.id === 'nt-unlink') { checkpoint(); delete N(id).url; render(); updateToolbar(); scheduleSave(); toast('Link removed'); }
  else if (b.id === 'nt-delete') deleteNode(id);
});

/* no hover tooltips: every title attribute becomes an aria-label (kept for screen readers) */
function stripTitles(root) {
  const list = root.querySelectorAll ? root.querySelectorAll('[title]') : [];
  for (const el of [root, ...list]) {
    if (!el.getAttribute || !el.hasAttribute('title')) continue;
    const t = el.getAttribute('title');
    if (t) el.setAttribute('aria-label', t);
    el.removeAttribute('title');
  }
}
stripTitles(document.body);
new MutationObserver(ms => { for (const m of ms) { if (m.type === 'attributes') stripTitles(m.target); else m.addedNodes.forEach(n => n.nodeType === 1 && stripTitles(n)); } })
  .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
$('#btn-tidy').onclick = tidy;
$('#btn-auto').onclick = () => {
  doc.autoLayout = !autoOn(); paintAuto(); scheduleSave();
  toast(autoOn() ? 'Auto on: what you add or move from now on is arranged for you' : 'Auto off: place notes and stretch sections by hand');
};
function paintAuto() { $('#btn-auto').classList.toggle('on', autoOn()); }
$('#btn-help').onclick = openHelp;
/* ---------------- Share: versions and collaboration through Git (GitHub) ---------------- */
const shareMenu = $('#share-menu'), shareBusy = $('#share-busy');
let shareDotTimer = 0;
let shareState = null, shareView = null, shareMsg = null, shareDevice = null, sharePoll = 0, shareHist = [], sharePeople = [];
const shareCall = async (method, ...args) => {
  if (!host || !host.share) throw new Error('Sharing works in the desktop app.');
  const r = await host.share(method, ...args);
  if (r.error) { const e = new Error(r.error); e.code = r.code; throw e; }
  return r.ok;
};
async function shareBusyWhile(text, fn) {
  $('#share-busy-text').textContent = text; shareBusy.hidden = false;
  try { return await fn(); } finally { shareBusy.hidden = true; }
}
// everything on screen goes to disk first, so the shared copy is made from what you see
function flushForShare() { if (editingId) finishEditing(true); clearTimeout(saveTimer); saveTimer = null; doc.updated = Date.now(); store.saveSync(currentId, serialize()); saveState.textContent = 'Saved'; saveState.className = 'save-state'; }
function reloadAfterShare() { openProject(currentId); }
async function refreshShare() {
  try { shareState = await shareCall('status', currentId); } catch (e) { shareState = { signedIn: false, linked: false }; shareMsg = { err: e.message }; }
  $('#share-dot').hidden = !(shareState.linked && shareState.dirty);
  if (shareState.linked && !shareMenu.hidden) { shareCall('history', currentId).then(h => { shareHist = h; if (!shareMenu.hidden) paintShare(); }).catch(() => {}); }
  if (!shareMenu.hidden) paintShare();
}
const ago = t => { const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };
function paintShare() {
  const st = shareState || {}; let h = '';
  const msg = shareMsg ? `<div class="${shareMsg.err ? 'sh-err' : 'sh-ok'}">${esc(shareMsg.err || shareMsg.ok)}</div>` : '';
  if (!host || !host.share) h = '<div class="sh-note" style="padding-top:8px">Sharing works in the desktop app.</div>';
  else if (!st.signedIn) {
    h += '<div class="pm-label">Share with GitHub</div>';
    if (shareDevice) {
      h += `<div class="sh-note">GitHub is open in your browser. Paste this code there (it is already copied) and press Authorize.</div><div class="sh-code">${esc(shareDevice.userCode)}</div>
        <button class="sh-big" data-act="device-open">Open GitHub again</button><div class="sh-note">Waiting for you there… <span class="sh-link" data-act="device-cancel">Cancel</span></div>`;
    } else if (shareView === 'token') {
      h += `<div class="sh-steps">
          <div class="sh-step"><b>1</b><div><button class="sh-big" data-act="token-page">Create my key on GitHub</button><div class="sh-note">On the page that opens, set Expiration to “No expiration”, scroll down and press the green <b>Generate token</b> button.</div></div></div>
          <div class="sh-step"><b>2</b><div><div class="sh-note">Copy the key GitHub shows you and come back here. Mindview signs you in by itself.</div>
            <form class="pm-form" data-form="token"><input id="sh-input" type="password" placeholder="or paste the key here" autocomplete="off"><button class="pm-ok">Sign in</button></form></div></div>
        </div>
        <div class="sh-note"><span class="sh-link" data-act="back">Back</span></div>`;
    } else {
      h += '<div class="sh-note">Keep versions of this project and work on it with friends. All you need is a GitHub account.</div>';
      h += `<button class="sh-big" data-act="${st.clientId ? 'device' : 'token'}">Sign in with GitHub</button>`;
      h += '<div class="sh-note"><span class="sh-link" data-act="signup">I don’t have an account yet</span></div>';
    }
  } else {
    const who = st.user ? esc(st.user.login) : 'GitHub';
    if (!st.linked) {
      h += '<div class="pm-label">Share this project</div>';
      if (shareView === 'publish') {
        h += `<div class="sh-note">Puts this project in a private place on your GitHub account. Only people you invite can see it.</div>
          <form class="pm-form" data-form="publish"><input id="sh-input" maxlength="90" placeholder="Name" value="${esc((doc.name || 'project').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''))}"><button class="pm-ok">Publish</button></form>
          <div class="sh-note"><span class="sh-link" data-act="back">Back</span></div>`;
      } else if (shareView === 'open') {
        h += `<div class="sh-note">Paste the link a friend sent you.</div>
          <form class="pm-form" data-form="open"><input id="sh-input" placeholder="Link"><button class="pm-ok">Open</button></form>
          <div class="sh-note"><span class="sh-link" data-act="back">Back</span></div>`;
      } else {
        h += `<div class="sh-note">“${esc(doc.name || 'This project')}” is only on this computer.</div>
          <button class="sh-big" data-act="publish">Share this project</button><button class="sh-big quiet" data-act="open">Open a project shared with me</button>`;
      }
    } else {
      h += `<div class="pm-label">Shared project</div>
        <div class="sh-row"><span class="sh-grow"><b>${esc(st.slug ? st.slug.owner + '/' + st.slug.repo : st.url || '')}</b></span><span class="sh-link" data-act="copylink">Copy link</span></div>
        <div class="sh-note">${st.dirty ? 'You have changes that are not shared yet.' : 'Nothing new on this computer. Sync to get what the others did.'}</div>
        <form class="pm-form" data-form="sync"><input id="sh-input" maxlength="140" placeholder="What changed? (optional)"><button class="pm-ok">Sync</button></form>`;
      h += '<div class="pm-sep"></div><div class="pm-label">People</div>';
      if (sharePeople.length) h += `<div class="sh-note">${sharePeople.map(esc).join(', ')}</div>`;
      h += '<form class="pm-form" data-form="invite"><input id="sh-invite" placeholder="GitHub username of a friend"><button class="pm-ok">Invite</button></form><div class="sh-note">Then send them the link. They open it with Share, “Open a project shared with me”.</div>';
      h += '<div class="pm-sep"></div><div class="pm-label">Versions</div><div class="sh-hist">';
      h += shareHist.length ? shareHist.map((c, i) => `<div class="sh-ver"><span class="sh-msg">${esc(c.message.split('\n')[0])}</span><span class="sh-meta">${esc(c.author)} · ${ago(c.time)}</span>${i ? `<span class="sh-link" data-act="restore" data-oid="${c.oid}">Restore</span>` : ''}</div>`).join('') : '<div class="sh-note">Loading…</div>';
      h += '</div><div class="pm-sep"></div>';
      const mine = !!(st.slug && st.user && st.user.login.toLowerCase() === st.slug.owner.toLowerCase()); // only the person who shared it can delete it
      h += shareView === 'unlink'
        ? (mine
          ? '<div class="pm-confirm sh-stop"><span>Stop sharing this project? Your notes stay on this computer. Do you also want to delete the copy on GitHub? Deleting removes it for everyone you invited and cannot be undone.</span><button data-act="unlink-yes">Stop, keep the copy</button><button class="pm-danger" data-act="delete-yes">Stop and delete it</button><button data-act="back">Cancel</button></div>'
          : '<div class="pm-confirm"><span>Stop syncing this project on this computer? Your notes stay, and so does the copy on GitHub.</span><button class="pm-danger" data-act="unlink-yes">Stop sharing</button><button data-act="back">Cancel</button></div>')
        : '<div class="sh-row"><span class="sh-link" data-act="open">Open a project shared with me</span><span class="sh-grow"></span><span class="sh-link" data-act="unlink">Stop sharing</span></div>';
      if (shareView === 'open') h += `<form class="pm-form" data-form="open"><input id="sh-input2" placeholder="Link"><button class="pm-ok">Open</button></form>`;
    }
    h += `<div class="pm-sep"></div><div class="sh-row"><span class="sh-grow">Signed in as <b>${who}</b></span><span class="sh-link" data-act="signout">Sign out</span></div>`;
  }
  const keep = document.activeElement && shareMenu.contains(document.activeElement) && document.activeElement.id ? { id: document.activeElement.id, v: document.activeElement.value } : null;
  shareMenu.innerHTML = msg + h;
  if (keep && $('#' + keep.id)) { $('#' + keep.id).value = keep.v; $('#' + keep.id).focus(); }
}
const underButton = (menu, btn) => { menu.style.right = 'auto'; menu.style.left = Math.max(8, Math.min(btn.getBoundingClientRect().left, innerWidth - menu.offsetWidth - 8)) + 'px'; };
function openShare() { shareView = null; shareMsg = null; shareMenu.hidden = false; underButton(shareMenu, $('#btn-share')); $('#btn-share').classList.add('open'); paintShare(); refreshShare().then(() => { if (shareState.linked) shareCall('people', currentId).then(p => { sharePeople = p; if (!shareMenu.hidden) paintShare(); }).catch(() => {}); }); }
function closeShare() { shareMenu.hidden = true; $('#btn-share').classList.remove('open'); }
function stopDevice() { clearTimeout(sharePoll); sharePoll = 0; shareDevice = null; }
async function shareDo(text, fn) {
  shareMsg = null;
  try { await shareBusyWhile(text, fn); } catch (e) { shareMsg = { err: e.message }; if (e.code === 'AUTH') await shareCall('signOut').catch(() => {}); }
  shareView = shareMsg && shareMsg.err ? shareView : null;
  if (!(shareMsg && shareMsg.err) && document.activeElement && shareMenu.contains(document.activeElement)) document.activeElement.blur(); // done: clear the field
  await refreshShare(); paintShare();
}
// Back from GitHub with a freshly copied key: sign in with it, no pasting needed.
let shareKeyWait = false;
window.addEventListener('focus', async () => {
  if (!shareKeyWait || shareMenu.hidden || shareView !== 'token' || (shareState && shareState.signedIn)) return;
  let key = ''; try { key = await shareCall('clipKey'); } catch (_) {}
  if (key) { shareKeyWait = false; shareForms.token(key); }
});
const shareActions = {
  back: () => { shareView = null; shareMsg = null; paintShare(); },
  token: () => { shareView = 'token'; paintShare(); },
  signup: () => shareCall('openUrl', 'https://github.com/signup'),
  copylink: async () => { if (!shareState.url) return; await shareCall('copy', shareState.url); shareMsg = { ok: 'Link copied. Send it to the people you invited.' }; paintShare(); },
  publish: () => { shareView = 'publish'; paintShare(); const i = $('#sh-input'); if (i) { i.focus(); i.select(); } },
  open: () => { shareView = 'open'; paintShare(); const i = $('#sh-input') && $('#sh-input').closest('[data-form="open"]') ? $('#sh-input') : $('#sh-input2'); if (i) i.focus(); },
  unlink: () => { shareView = 'unlink'; paintShare(); },
  'delete-yes': () => shareDo('Deleting…', async () => { const r = await shareCall('remove', currentId); shareHist = []; sharePeople = []; shareMsg = { ok: 'Sharing stopped and the copy on GitHub is deleted. Your notes are still here.' }; }),
  'token-page': () => { shareKeyWait = true; shareCall('openUrl', 'https://github.com/settings/tokens/new?scopes=repo,delete_repo&description=Mindview'); },
  repo: () => shareState.url && shareCall('openUrl', shareState.url),
  'device-open': () => shareDevice && shareCall('openUrl', shareDevice.url),
  'device-cancel': () => { stopDevice(); paintShare(); },
  device: async () => {
    shareMsg = null;
    try { shareDevice = await shareCall('deviceStart'); } catch (e) { shareMsg = { err: e.message }; paintShare(); return; }
    paintShare(); shareCall('copy', shareDevice.userCode); shareCall('openUrl', shareDevice.url);
    let wait = shareDevice.interval * 1000; const dev = shareDevice;
    const tick = async () => {
      if (shareDevice !== dev) return;
      try { const r = await shareCall('devicePoll', dev.deviceCode); if (r.user) { stopDevice(); shareMsg = { ok: 'Signed in as ' + r.user.login + '.' }; await refreshShare(); paintShare(); return; } if (r.slow) wait += 5000; }
      catch (e) { stopDevice(); shareMsg = { err: e.message }; paintShare(); return; }
      sharePoll = setTimeout(tick, wait);
    };
    sharePoll = setTimeout(tick, wait);
  },
  signout: async () => { stopDevice(); await shareCall('signOut'); shareMsg = null; shareView = null; await refreshShare(); paintShare(); },
  'unlink-yes': () => shareDo('Stopping…', async () => { await shareCall('unlink', currentId); shareHist = []; sharePeople = []; }),
  restore: el => shareDo('Restoring…', async () => { flushForShare(); await shareCall('restore', currentId, el.dataset.oid); reloadAfterShare(); shareMsg = { ok: 'That version is back on your canvas. Sync to share it with the others.' }; }),
};
const shareForms = {
  token: v => shareDo('Signing in…', async () => { const u = await shareCall('signInToken', v); shareMsg = { ok: 'Signed in as ' + u.login + '.' }; }),
  publish: v => shareDo('Sharing…', async () => { flushForShare(); const r = await shareCall('publish', currentId, { name: v }); shareMsg = { ok: 'Shared. Invite a friend below and send them the link.' }; }),
  open: v => shareDo('Opening…', async () => { flushForShare(); const r = await shareCall('openShared', v); openProject(r.id); shareMsg = { ok: r.already ? 'You already have this project. Switched to it.' : 'Opened “' + (r.name || r.id) + '”.' }; }),
  sync: v => shareDo('Syncing…', async () => {
    flushForShare();
    const r = await shareCall('sync', currentId, v);
    if (r.changed) reloadAfterShare();
    const parts = [];
    if (r.incoming) parts.push(`Got ${r.incoming} change${r.incoming > 1 ? 's' : ''} from the others.`);
    if (r.pushed) parts.push('Your changes are shared.');
    if (!parts.length) parts.push('Everything is already up to date.');
    if (r.conflicts.length) parts.push(`${r.conflicts.length} edit${r.conflicts.length > 1 ? 's' : ''} clashed, yours were kept: ${[...new Set(r.conflicts.map(c => '“' + c.what + '”'))].slice(0, 4).join(', ')}.`);
    shareMsg = { ok: parts.join(' ') };
  }),
  invite: v => shareDo('Inviting…', async () => { const r = await shareCall('invite', currentId, v); shareMsg = { ok: `Invited ${v.replace(/^@/, '')}. They open it with Share > Open a shared project > ${r.spec}` }; sharePeople = await shareCall('people', currentId).catch(() => sharePeople); }),
};
$('#btn-share').addEventListener('click', e => { e.stopPropagation(); if (shareMenu.hidden) openShare(); else closeShare(); });
shareMenu.addEventListener('pointerdown', e => e.stopPropagation());
shareMenu.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') closeShare(); });
shareMenu.addEventListener('click', e => { const el = e.target.closest('[data-act]'); if (el && shareActions[el.dataset.act]) { e.preventDefault(); shareActions[el.dataset.act](el); } });
shareMenu.addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target.closest('form'), v = (f.querySelector('input').value || '').trim();
  if (!v && f.dataset.form !== 'sync') return;
  if (shareForms[f.dataset.form]) shareForms[f.dataset.form](v);
});
document.addEventListener('pointerdown', e => { if (!shareMenu.hidden && !e.target.closest('#share-menu, #btn-share')) closeShare(); });

$('#help-close').onclick = () => ($('#help').hidden = true);
$('#help').addEventListener('pointerdown', e => { if (e.target.id === 'help') $('#help').hidden = true; });
// Light / dark. With theme mods installed (tag "Theme"), the button opens a list of every theme instead.
const themeMenu = $('#theme-menu');
// Themes that come with Mindview start in the Library; the ones added to the collection are listed here.
// (Dark and Light are always there.) Removing one sends it back to the Library.
function themesIn() {
  settings.mods = settings.mods || {};
  if (!settings.mods.themesIn) { // first run with this: keep what is in use, unless it was removed before
    const t = settings.themes || { global: { key: ':dark' }, projects: {} }, hid = settings.mods.hidden || [];
    settings.mods.themesIn = [...new Set([t.global, ...Object.values(t.projects || {})].map(e => e && e.key).filter(k => k && k[0] !== ':' && !hid.includes(k)))];
    delete settings.mods.hidden; store.setSettings({ mods: settings.mods });
  }
  return settings.mods.themesIn;
}
const shelved = () => (settings.mods.shelved = settings.mods.shelved || []); // things I made, moved to the Library
const themeInCollection = m => m.from === 'user' ? !shelved().includes(m.id) : themesIn().includes(m.id);
const themeMods = () => { refreshMods(); return modMetas.filter(m => isThemeMod(m) && themeInCollection(m)); };
// Theme choice lives in the user's own settings, never in a project: { global: entry, projects: { pid: entry } },
// entry = { key: ':dark' | ':light' | full theme mod id, mode: 'dark' | 'light', accent: accent (partial) theme id or null }
function isThemeMod(m) { return (m.tags || []).some(t => t.toLowerCase() === 'theme'); }
const isThemeId = id => { const m = modMeta(id); return !!m && isThemeMod(m); };
function themeState() {
  if (!settings.themes) { // first run with this: take over what was on before
    const old = ((settings.mods || {}).global || []).find(isThemeId);
    settings.themes = { global: old ? { key: old, mode: uiTheme } : { key: ':' + uiTheme, mode: uiTheme }, projects: {} };
  }
  settings.themes.projects = settings.themes.projects || {};
  for (const e of [settings.themes.global, ...Object.values(settings.themes.projects)]) { // older choices: an accent picked on its own sat on Dark or Light
    const m = e.key[0] !== ':' && modMeta(e.key); if (m && m.partial) { e.accent = e.key; e.key = ':' + e.mode; }
  }
  return settings.themes;
}
const themeEntry = () => { const t = themeState(); return t.projects[currentId] || t.global; };
const themeHere = () => !!themeState().projects[currentId];
const usable = k => !!k && k[0] !== ':' && !!modMeta(k) && themeInCollection(modMeta(k));
const themeActive = () => { const k = themeEntry().key; return usable(k) ? k : null; }; // the full theme (null = plain Dark or Light)
const accentActive = () => { const k = themeEntry().accent; return usable(k) ? k : null; };
const saveThemes = () => store.setSettings({ themes: settings.themes });
function applyThemeMode() { const e = themeEntry(); const m = themeActive() && modMeta(e.key); const mode = m && m.base ? m.base : e.mode; if (mode !== uiTheme) setTheme(mode, false); }
function paintThemes() {
  const act = themeActive();
  const row = (key, name, on, part) => `<div class="ai-row ai-agent${on ? ' on' : ''}" data-theme="${esc(key)}"><span class="ai-radio"></span><b>${esc(name)}</b>${part ? '<span class="ai-state">Partial</span>' : ''}</div>`;
  const mods = host && host.modsList ? themeMods() : [];
  const parts = mods.filter(m => m.partial);
  const full = row(':dark', 'Dark', !act && uiTheme === 'dark') + row(':light', 'Light', !act && uiTheme === 'light') + mods.filter(m => !m.partial).map(m => row(m.id, m.name, act === m.id)).join('');
  themeMenu.classList.toggle('two', parts.length > 0);
  themeMenu.innerHTML = (parts.length ? `<div class="tm-cols"><div><div class="pm-label">Full themes</div>${full}</div><div><div class="pm-label">Accents</div>${parts.map(m => row(m.id, m.name, accentActive() === m.id)).join('')}</div></div>` : full)
    + `<div class="tm-sep"></div><button class="tm-scope${themeHere() ? ' on' : ''}" data-tm="scope"><span class="switch"></span>This project only</button>`
    + (host && host.modsList ? `<button class="tm-act" data-tm="manage"><svg viewBox="0 0 20 20"><path d="M10 3a7 7 0 1 0 0 14c1 0 1.500-.7 1.500-1.500 0-1.200-1-1.500-1-2.500 0-.8.7-1.500 1.500-1.500H14a3 3 0 0 0 3-3C17 5.500 14 3 10 3z"/><circle cx="6.500" cy="9" r=".9"/><circle cx="9" cy="6" r=".9"/><circle cx="12.500" cy="6.500" r=".9"/></svg>Manage themes</button>` : '');
}
// a removed theme: wherever it was chosen, fall back to the plain Dark or Light it sat on
function forgetTheme(id) { const t = themeState(); for (const e of [t.global, ...Object.values(t.projects)]) { if (e.key === id) e.key = ':' + e.mode; if (e.accent === id) e.accent = null; } }
async function setThemeScope(here) {
  const t = themeState();
  if (here) t.projects[currentId] = { ...t.global, ...(t.projects[currentId] || {}) }; else delete t.projects[currentId];
  saveThemes(); await refreshTheme();
}
function closeThemes() { themeMenu.hidden = true; $('#btn-theme').classList.remove('open'); }
async function pickTheme(key) {
  const t = themeState(), m = key[0] === ':' ? null : modMeta(key);
  const e = { ...themeEntry() };
  if (m && m.partial) e.accent = e.accent === key ? null : key; // accents go on top of the theme; the same one again takes it off
  else { e.key = key; e.mode = key[0] === ':' ? key.slice(1) : m && m.base ? m.base : uiTheme; }
  if (themeHere()) t.projects[currentId] = e; else t.global = e;
  saveThemes(); await refreshTheme();
}
async function refreshTheme() {
  applyThemeMode(); store.setSettings({ theme: uiTheme }); await syncMods(); render();
  if (!modsMenu.hidden) paintMods();
}
$('#btn-theme').addEventListener('click', e => {
  e.stopPropagation();
  if (!themeMenu.hidden) return closeThemes();
  themeMenu.hidden = false; $('#btn-theme').classList.add('open'); paintThemes(); underButton(themeMenu, $('#btn-theme'));
});
themeMenu.addEventListener('pointerdown', e => e.stopPropagation());
themeMenu.addEventListener('click', async e => {
  const a = e.target.closest('[data-tm]');
  if (a && a.dataset.tm === 'scope') { await setThemeScope(!themeHere()); paintThemes(); return; }
  if (a) { closeThemes(); openMods('themes'); return; }
  const r = e.target.closest('[data-theme]'); if (!r) return; await pickTheme(r.dataset.theme); closeThemes();
});
document.addEventListener('pointerdown', e => { if (!themeMenu.hidden && !e.target.closest('#theme-menu, #btn-theme')) closeThemes(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !themeMenu.hidden) closeThemes(); });
$('#z-in').onclick = () => zoomCenter(1.25);
$('#z-out').onclick = () => zoomCenter(0.8);
$('#z-fit').onclick = () => fitAll();
$('#z-level').onclick = () => {
  const v = view(), cx = innerWidth / 2, cy = innerHeight / 2, f = 1 / v.k;
  animateView({ x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f, k: 1 }, 220);
};

function openHelp() {
  if (host) $('#help-path').textContent = 'Your notes are saved automatically, one file per project, in ' + host.dataPath() + '\\projects';
  else $('#help-path').textContent = 'Browser preview: notes are saved in this browser only.';
  $('#help').hidden = false;
}

function setTheme(t, save) {
  uiTheme = t === 'light' ? 'light' : 'dark';
  if (save) store.setSettings({ theme: uiTheme });
  document.body.classList.toggle('theme-dark', uiTheme === 'dark');
  document.body.classList.toggle('theme-light', uiTheme === 'light');
  if (host) host.setTheme(uiTheme);
  paintSwatches();
  if (save) { render(); scheduleSave(); }
}

let toastTimer = null;
function toast(text, action, fn) {
  const t = $('#toast');
  $('#toast-text').textContent = text;
  const a = $('#toast-action');
  a.hidden = !action; a.textContent = action || '';
  a.onclick = () => { t.hidden = true; fn && fn(); };
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
}

window.addEventListener('resize', () => { positionToolbar(); positionSectionToolbar(); });

/* ---------------- projects ---------------- */

function resetCanvas() {
  if (editingId) commitEdit();
  if (saveTimer) saveNow();
  cancelAnimationFrame(layoutAnim); cancelAnimationFrame(viewAnim);
  if (zoomRaf) { cancelAnimationFrame(zoomRaf); zoomRaf = null; zoomGoal = null; }
  if (editingSection) finishSectionLabel(true);
  for (const id in els) { els[id].remove(); delete els[id]; }
  for (const id in measuredScale) delete measuredScale[id];
  for (const id in secEls) { secEls[id].remove(); delete secEls[id]; }
  selectedSection = null; freshSection = null; sectionToolbar.hidden = true;
  for (const id in sizeCache) delete sizeCache[id];
  for (const id in scaleNow) delete scaleNow[id];
  undoStack.length = 0; redoStack.length = 0;
  selectedId = null; editingId = null; freshId = null; selectedLink = null; jumpHistory = [];
  linkBar.hidden = true; jumpMenu.hidden = true; relMenu.hidden = true;
  lastK = null; lastDepth = null; gestureAnchor = null;
  migrated = false; wasFolded.length = 0;
  toolbar.hidden = true; $('#toast').hidden = true;
}

function openProject(id) {
  if (modsMenu && !modsMenu.hidden) closeMods();
  if (currentId && currentId !== id) { if (editingId) commitEdit(); store.saveSync(currentId, serialize()); }
  resetCanvas();
  currentId = id;
  doc = { version: 1, view: { x: 0, y: 0, k: 1 }, nodes: {}, links: [], sections: {} };
  load(id);
  delete doc.theme;
  doc.name = doc.name || 'Untitled project';
  store.setSettings({ lastProject: id });
  paintProjectName();
  paintAuto();
  try { applyFonts(); } catch (_) { /* fonts not set up yet: done once they are */ }
  applyView();
  render();
  fromCanon();
  if (migrated && !doc.needsTidy) {
    // notes that used to be folded were never laid out: place them now
    if (autoOn()) doc.needsTidy = true;
    else {
      for (const nid of wasFolded.sort((a, b) => depthOf(N(a)) - depthOf(N(b)))) if (N(nid)) applyLayoutNow(nid);
      scheduleSave();
    }
  }
  if (doc.needsTidy) {
    const pos = layoutTargets();
    for (const nid in pos) putAt(N(nid), pos[nid], Math.round(pos[nid].x), Math.round(pos[nid].y));
    delete doc.needsTidy;
    render(); scheduleSave();
  }
  if (!doc.viewSet) requestAnimationFrame(() => { fitAll(false); doc.viewSet = true; });
  setTimeout(() => { if (host && host.share) refreshShare(); }, 0); // the Share button shows a dot when this project has unshared changes
  refreshMods(); applyThemeMode(); syncMods().then(() => { modEmit('open', doc); checkMissingMods(); });
}

function paintProjectName() {
  $('#project-name').textContent = doc.name;
  document.title = doc.name + ' · Mindview';
  if (host) host.setTitle(document.title);
}

// F2 with nothing selected: rename the project right in the top bar
function renameProjectInline() {
  closeMenu();
  const el = $('#project-name'), before = doc.name || '';
  el.contentEditable = 'plaintext-only'; el.spellcheck = false; el.classList.add('renaming'); el.focus();
  const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  let done = false;
  const end = save => {
    if (done) return; done = true;
    el.removeEventListener('keydown', onKey, true); el.removeEventListener('blur', onBlur);
    const name = el.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
    el.contentEditable = 'false'; el.classList.remove('renaming'); getSelection().removeAllRanges();
    if (save && name && name !== before) { doc.name = name; scheduleSave(); }
    paintProjectName();
  };
  const onKey = e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); end(true); } else if (e.key === 'Escape') { e.preventDefault(); end(false); } };
  const onBlur = () => end(true);
  const noClick = e => { if (e.key === ' ') e.preventDefault(); }; // a space in a button would press it
  el.addEventListener('keyup', noClick, true);
  el.addEventListener('keydown', onKey, true); el.addEventListener('blur', onBlur);
}

/* project menu */
const menu = $('#project-menu');
let menuMode = null; // null | 'new' | 'delete'
let menuTarget = null; // the project a delete is about
function openMenu() { menuMode = null; paintMenu(); menu.hidden = false; $('#project-btn').classList.add('open'); }
function closeMenu() { menu.hidden = true; menuMode = null; $('#project-btn').classList.remove('open'); }
function esc(t) { return String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function paintMenu() {
  const list = store.list();
  let html = '<div class="pm-label">Projects</div><div class="pm-list">';
  for (const p of list) {
    html += `<div class="pm-row"><button class="pm-item${p.id === currentId ? ' current' : ''}" data-open="${esc(p.id)}">
      <span class="pm-dot"></span><span class="pm-name">${esc(p.name)}</span></button>${list.length > 1 ? `<button class="pm-trash" data-trash="${esc(p.id)}" aria-label="Delete ${esc(p.name)}"><svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2M6 6l.7 10h6.6L14 6M8.500 9v4M11.500 9v4"/></svg></button>` : ''}</div>`;
  }
  html += '</div><div class="pm-sep"></div>';
  if (menuMode === 'new' || menuMode === 'rename') {
    html += `<form class="pm-form" data-form="${menuMode}">
      <input id="pm-input" maxlength="120" placeholder="${menuMode === 'new' ? 'Project name' : 'New name'}" value="${menuMode === 'rename' ? esc(doc.name) : ''}">
      <button type="submit" class="pm-ok">${menuMode === 'new' ? 'Create' : 'Rename'}</button></form>`;
  } else if (menuMode === 'delete') {
    const tp = store.list().find(p => p.id === menuTarget);
    html += `<div class="pm-confirm"><span>Delete “${esc(tp ? tp.name : '')}”? A copy is kept in backups.</span>
      <button class="pm-danger" data-act="confirm-delete">Delete</button><button data-act="cancel">Cancel</button></div>`;
  } else {
    html += `<button class="pm-act" data-act="new"><span class="pm-ic">+</span>New project</button>`;
  }
  menu.innerHTML = html;
  const input = $('#pm-input');
  if (input) { input.focus(); input.select(); }
}
menu.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.trash) { menuTarget = b.dataset.trash; menuMode = 'delete'; paintMenu(); return; }
  if (b.dataset.open) { if (b.dataset.open !== currentId) openProject(b.dataset.open); closeMenu(); return; }
  const act = b.dataset.act;
  if (act === 'new') { menuMode = act; paintMenu(); }
  else if (act === 'cancel') { menuMode = null; paintMenu(); }
  else if (act === 'confirm-delete') {
    const gone = menuTarget, others = store.list().filter(p => p.id !== gone);
    if (!gone || !others.length) return;
    if (gone === currentId) { clearTimeout(saveTimer); saveTimer = null; }
    store.remove(gone);
    if (gone === currentId) { currentId = null; openProject(others[0].id); closeMenu(); }
    else { menuMode = null; menuTarget = null; paintMenu(); }
    toast('Project deleted. A copy is in the backups folder.');
  }
});
menu.addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#pm-input').value.trim(); if (!name) return;
  const id = store.create(name); openProject(id);
  closeMenu();
});
menu.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') closeMenu(); });
menu.addEventListener('pointerdown', e => e.stopPropagation());
$('#project-btn').addEventListener('click', () => { if ($('#project-name').classList.contains('renaming')) return; menu.hidden ? openMenu() : closeMenu(); });
document.addEventListener('pointerdown', e => { if (!menu.hidden && !e.target.closest('#project-menu, #project-btn')) closeMenu(); });

/* ---------------- Mods: packages that change how Mindview works (usage) or what a project can hold (content) ----------------
   A mod is one .js file with a JSON header. It gets a small toolkit (`api`); everything it adds is removed when it is switched off.
   Usage mods are a personal choice (settings). Content mods add data to the project, so the project remembers that it needs them. */
const MOD_API = 1;
const modsMenu = $('#mods-menu'), modsPrompt = $('#mods-prompt');
let modsPrev = {};
let modMetas = [];                     // every package on this computer
const modLive = new Map();             // id -> { dispose: [fn], handlers: {event: [fn]}, keys: [], items: [] }
let modRegister = null;                // set while a package's script runs
settings.mods = settings.mods || {}; settings.mods.global = settings.mods.global || []; settings.mods.projects = settings.mods.projects || {};
const saveModSettings = () => store.setSettings({ mods: settings.mods });
const modMeta = id => modMetas.find(m => m.id === id);
const refreshMods = () => { modMetas = host && host.modsList ? host.modsList() : []; };
settings.mods.excluded = settings.mods.excluded || {};
const modExcluded = () => (settings.mods.excluded[currentId] = settings.mods.excluded[currentId] || []); // on for all projects, but not this one
const projMods = () => (settings.mods.projects[currentId] = settings.mods.projects[currentId] || []);
const hasModData = id => all().some(n => n.mod && n.mod[id] !== undefined) || !!(doc.modData && doc.modData[id] !== undefined);
// which mods should be running for the open project
function modsWanted() {
  const want = new Set([...settings.mods.global.filter(id => !modExcluded().includes(id)), ...projMods(), ...(doc.mods || []), ...(doc.requires || []).map(r => r.id)]);
  const th = themeActive(), ac = accentActive(); // theme mods come from the theme choice, not from the mod switches
  return [...want].filter(id => modMeta(id) && !isThemeId(id)).concat(th ? [th] : [], ac ? [ac] : []);
}
// what this project needs to be seen as intended: its own content mods, plus any whose data it holds
function computeRequires() {
  const out = [];
  for (const m of modMetas) if (m.kind === 'content' && ((doc.mods || []).includes(m.id) || (modLive.has(m.id) && hasModData(m.id)))) out.push({ id: m.id, name: m.name, version: m.version });
  for (const r of doc.requires || []) if (r && r.id && !modMeta(r.id)) out.push(r); // a mod I don't have: keep the note of it
  return out;
}
function modEmit(event, ...args) {
  for (const live of modLive.values()) for (const fn of live.handlers[event] || []) { try { fn(...args); } catch (e) { console.error('mod', event, e); } }
}
const keyName = e => (e.ctrlKey || e.metaKey ? 'ctrl+' : '') + (e.altKey ? 'alt+' : '') + (e.shiftKey ? 'shift+' : '') + (e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
function modKey(e) { // a mod's shortcut wins over the built-in one
  const typing = e.target.closest && e.target.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]');
  const k = keyName(e);
  for (const live of modLive.values()) for (const c of live.keys) {
    if (c.keys !== k || (typing && !(e.ctrlKey || e.metaKey || e.altKey))) continue;
    e.preventDefault(); e.stopPropagation();
    try { c.run(e); } catch (err) { console.error('mod key', err); }
    return true;
  }
  return false;
}
window.addEventListener('keydown', e => { if (modLive.size && modKey(e)) e.stopImmediatePropagation(); }, true);
// ---- search (Ctrl+F): finds notes by title or text, lights them up on the canvas ----
const findBox = document.createElement('div');
findBox.id = 'find'; findBox.hidden = true;
findBox.innerHTML = '<input placeholder="Search notes..." spellcheck="false"><div class="fd-list"></div>';
document.body.appendChild(findBox);
const findInput = findBox.querySelector('input'), findList = findBox.querySelector('.fd-list');
let findAll = [], findAt = 0, findMarked = [];
const findFirst = t => String(t || '').split('\n')[0];
function findMark() {
  for (const el of findMarked) el.classList.remove('fd-hit', 'fd-at', 'fd-in');
  findMarked = [];
  if (findBox.hidden) return;
  const shown = el => el && !el.classList.contains('zhide');
  findAll.forEach((n, i) => {
    let el = els[n.id];
    if (shown(el)) { el.classList.add('fd-hit'); el.classList.toggle('fd-at', i === findAt); findMarked.push(el); return; }
    // hidden inside a folded branch: light up the nearest note you can see
    for (let p = n.parentId && N(n.parentId); p; p = p.parentId && N(p.parentId)) { el = els[p.id]; if (shown(el)) { el.classList.add('fd-in'); findMarked.push(el); break; } }
  });
}
function findPaint() {
  const list = findAll.slice(0, 50);
  findList.textContent = '';
  if (findInput.value.trim() && !list.length) { const d = document.createElement('div'); d.className = 'fd-none'; d.textContent = 'Nothing found'; findList.appendChild(d); }
  list.forEach((n, i) => {
    const d = document.createElement('div'); d.className = 'fd-item' + (i === findAt ? ' on' : ''); d.dataset.i = i;
    d.textContent = findFirst(n.text) || '(untitled)';
    if (n.body) { const sm = document.createElement('small'); sm.textContent = findFirst(n.body); d.appendChild(sm); }
    findList.appendChild(d);
  });
  const on = findList.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  findMark();
}
function findRun() {
  const q = findInput.value.trim().toLowerCase();
  findAll = !q ? [] : all().filter(n => (n.text || '').toLowerCase().includes(q) || (n.body || '').toLowerCase().includes(q));
  findAt = 0; findPaint();
}
function openFind() { if (editingId) finishEditing(true); findBox.hidden = false; findInput.select(); findInput.focus(); findRun(); }
function closeFind() { if (findBox.hidden) return; findBox.hidden = true; findMark(); }
function findGo(i) { const n = findAll[i]; if (!n) return; closeFind(); focusNote(n.id); select(n.id); }
findInput.addEventListener('input', findRun);
findBox.addEventListener('pointerdown', e => e.stopPropagation());
findBox.addEventListener('keydown', e => {
  e.stopPropagation();
  const max = Math.min(findAll.length, 50) - 1;
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); findAt = Math.min(max, findAt + 1); findPaint(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); findAt = Math.max(0, findAt - 1); findPaint(); }
  else if (e.key === 'Enter') { e.preventDefault(); findGo(findAt); }
});
window.findHook = () => { if (!findBox.hidden) findMark(); };
findList.addEventListener('click', e => { const d = e.target.closest('.fd-item'); if (d) findGo(+d.dataset.i); });
document.addEventListener('pointerdown', e => { if (!findBox.hidden && !e.target.closest('#find')) closeFind(); });
window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); e.stopImmediatePropagation(); openFind(); }
}, true);

const modMenuItems = () => [...modLive.entries()].flatMap(([id, live]) => live.items.map((it, i) => ({ ...it, key: id + ':' + i })));

function makeModApi(id, live) {
  const meta = modMeta(id);
  const track = fn => { live.dispose.push(fn); return fn; };
  return {
    version: MOD_API, id, meta,
    // --- usage ---
    addStyle(css) { const el = document.createElement('style'); el.dataset.mod = id; el.textContent = css; document.head.appendChild(el); track(() => el.remove()); return el; },
    addKey(keys, run) { const c = { keys: String(keys).toLowerCase().replace(/\s+/g, '').replace('cmd+', 'ctrl+'), run }; live.keys.push(c); },
    addButton({ label, onClick }) { const b = document.createElement('button'); b.className = 'tb-btn mod-btn'; b.dataset.mod = id; b.innerHTML = `<span>${esc(label)}</span>`; b.addEventListener('click', e => { e.stopPropagation(); onClick(e); }); $('.tb-actions').insertBefore(b, $('.tb-actions').firstChild); track(() => b.remove()); return b; },
    addMenuItem(label, run, show) { live.items.push({ label, run, show }); },   // in a note's right-click menu; label may be a function of the note
    addElement(el) { el.dataset.mod = id; document.body.appendChild(el); track(() => el.remove()); return el; },
    on(event, fn) { (live.handlers[event] = live.handlers[event] || []).push(fn); },   // 'open' | 'render' | 'note' (el, note) | 'body' (el, note: the description panel) | 'select' (id)
    onCleanup(fn) { track(fn); },
    toast: (text) => toast(text),
    // --- content: data saved in the project, kept under this mod's own name ---
    data: note => (note && note.mod ? note.mod[id] : undefined),
    setData(note, value) {
      if (!note) return; checkpoint();
      if (value === undefined || value === null) { if (note.mod) { delete note.mod[id]; if (!Object.keys(note.mod).length) delete note.mod; } }
      else { note.mod = note.mod || {}; note.mod[id] = value; }
      render(); relayout(); scheduleSave();
    },
    projectData: () => (doc.modData ? doc.modData[id] : undefined),
    setProjectData(value) { checkpoint(); doc.modData = doc.modData || {}; if (value === undefined) delete doc.modData[id]; else doc.modData[id] = value; render(); scheduleSave(); },
    // --- the app itself, for anything the toolkit does not cover (may change between versions) ---
    app: {
      get doc() { return doc; }, get selected() { return selectedId; }, get projectId() { return currentId; },
      note: i => N(i), notes: () => all(), children: i => childrenOf(i), element: i => els[i], size: i => ({ ...size(i) }),
      select: i => select(i), focus: i => focusBranch(i), goTo: i => focusNote(i), edit: i => startEditing(i, false),
      render: () => render(), relayout: () => relayout(), checkpoint: () => checkpoint(), save: () => scheduleSave(),
      toWorld: (x, y) => toWorld(x, y), toScreen: (x, y) => toScreen(x, y), view: () => view(),
    },
  };
}
function stopMod(id) {
  const live = modLive.get(id); if (!live) return;
  for (const fn of live.dispose.reverse()) { try { fn(); } catch (e) { console.error('mod cleanup', e); } }
  modLive.delete(id);
}
function startMod(id) {
  return new Promise(resolve => {
    const src = host.modRead(id); if (!src) return resolve(false);
    const live = { dispose: [], handlers: {}, keys: [], items: [] };
    let setup = null;
    modRegister = fn => { setup = fn; };
    const url = URL.createObjectURL(new Blob([`(function (Mindview) {\n${src}\n})({ mod: f => window.__mvModRegister(f), api: ${MOD_API} });\n//# sourceURL=mindview-mod-${id}.js`], { type: 'text/javascript' }));
    const s = document.createElement('script');
    const done = ok => { URL.revokeObjectURL(url); s.remove(); resolve(ok); };
    s.onload = () => {
      modRegister = null;
      if (typeof setup !== 'function') { console.error('mod', id, 'did not call Mindview.mod(...)'); toast(`The mod “${(modMeta(id) || {}).name || id}” failed to start`); return done(false); }
      try { modLive.set(id, live); const r = setup(makeModApi(id, live)); if (typeof r === 'function') live.dispose.push(r); done(true); }
      catch (e) { console.error('mod', id, e); stopMod(id); toast(`The mod “${(modMeta(id) || {}).name || id}” failed to start`); done(false); }
    };
    s.onerror = () => { modRegister = null; toast(`The mod “${(modMeta(id) || {}).name || id}” failed to start`); done(false); };
    s.src = url; document.head.appendChild(s);
  });
}
window.__mvModRegister = f => { if (modRegister) modRegister(f); };
let modSyncing = Promise.resolve();
// bring the running mods in line with what this project and my settings ask for
function syncMods() {
  modSyncing = modSyncing.then(async () => {
    if (!host || !host.modsList) return;
    refreshMods();
    const want = new Set(modsWanted());
    let changed = false;
    for (const id of [...modLive.keys()]) if (!want.has(id)) { stopMod(id); changed = true; }
    for (const id of want) if (!modLive.has(id)) { if (await startMod(id)) changed = true; }
    if (changed) { modEmit('open', doc); render(); relayout(); }
    if (!modsMenu.hidden) paintMods();
  });
  return modSyncing;
}
// opening a project made with content mods I don't have
function checkMissingMods() {
  if (!host || !host.modsList) return;
  const missing = (doc.requires || []).filter(r => r && r.id && !modMeta(r.id));
  if (!missing.length) { modsPrompt.hidden = true; return; }
  const inProject = host.modsInProject(currentId).map(m => m.id);
  modsPrompt.querySelector('.mp-card').innerHTML = `<div class="mp-title">This project needs ${missing.length > 1 ? 'mods' : 'a mod'} you don't have</div>
    <div class="mp-text">It was made with ${missing.length > 1 ? 'these mods' : 'this mod'}. Without ${missing.length > 1 ? 'them' : 'it'} some of its content will not show as intended (nothing is lost).</div>
    ${missing.map(r => `<div class="mp-mod"><b>${esc(r.name || r.id)}</b><span>${esc(r.version || '')}</span>${inProject.includes(r.id) ? `<button data-mp="project" data-id="${esc(r.id)}">Install from this project</button>` : `<button data-mp="catalog" data-id="${esc(r.id)}">Get from the Library</button>`}</div>`).join('')}
    <div class="mp-text mp-warn">Mods are code that runs inside Mindview. Add only mods from people you trust.</div>
    <div class="mp-err" hidden></div>
    <div class="mp-actions"><button data-mp="file">Add a mod package…</button><button data-mp="skip">Open without ${missing.length > 1 ? 'them' : 'it'}</button></div>`;
  modsPrompt.hidden = false;
}
modsPrompt.addEventListener('pointerdown', e => e.stopPropagation());
modsPrompt.addEventListener('keydown', e => e.stopPropagation());
modsPrompt.addEventListener('click', async e => {
  const b = e.target.closest('[data-mp]'); if (!b) return;
  const err = t => { const el = modsPrompt.querySelector('.mp-err'); el.textContent = t; el.hidden = false; };
  if (b.dataset.mp === 'skip') { modsPrompt.hidden = true; return; }
  let r = null;
  if (b.dataset.mp === 'file') r = await host.modsAdd();
  if (b.dataset.mp === 'project') r = await host.modAddFromProject(currentId, b.dataset.id);
  if (b.dataset.mp === 'catalog') { b.textContent = 'Looking…'; r = await host.modInstall(b.dataset.id); }
  if (r && r.error) { err(r.error); if (b.dataset.mp === 'catalog') b.textContent = 'Get from the Library'; return; }
  if (r && r.ok) for (const m of [].concat(r.ok)) markSaved(m && m.id);
  await syncMods(); checkMissingMods();
});

/* ---- the Mods menu ---- */
let modsCatalog = null, modsMsg = null, modsSig = null;
let modsTab = settings.modsTab === 'browse' ? 'browse' : 'saved'; // what I made sits at the top of Collection
let modsTag = null; // tag the list is narrowed to
let modsOpen = null; // the mod whose page is open
let modsKind = ['themes', 'fonts'].includes(settings.modsKind) ? settings.modsKind : 'mods'; // the page shows mods, themes or fonts
// ---- fonts: one for the notes, one for the rest of the window (a personal preference, never saved in projects)
const FONTS = [
  ['', 'Mindview', ''],
  ['georgia', 'Georgia', 'Georgia, "Times New Roman", serif'],
  ['book', 'Cambria', 'Cambria, "Palatino Linotype", Palatino, Georgia, serif'],
  ['trebuchet', 'Trebuchet', '"Trebuchet MS", "Segoe UI", sans-serif'],
  ['verdana', 'Verdana', 'Verdana, Geneva, sans-serif'],
  ['bahn', 'Bahnschrift', 'Bahnschrift, "DIN Alternate", "Segoe UI", sans-serif'],
  ['mono', 'Consolas', 'Consolas, "Cascadia Mono", "SF Mono", Menlo, monospace'],
  ['hand', 'Segoe Print', '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive'],
  ['comic', 'Comic Sans', '"Comic Sans MS", "Comic Neue", cursive'],
];
const fontCss = k => (FONTS.find(f => f[0] === k) || FONTS[0])[2];
// the notes' font, for all projects or for one: { global: key, projects: { pid: key } } (personal, never saved in projects)
function fontPrefs() {
  let f = settings.fonts;
  if (!f || typeof f !== 'object' || 'notes' in f || 'ui' in f) f = { global: (f && f.notes) || '', projects: {} }; // earlier: { notes, ui }
  f.projects = f.projects || {}; settings.fonts = f; return f;
}
const fontHere = () => currentId && Object.prototype.hasOwnProperty.call(fontPrefs().projects, currentId);
const fontNow = () => fontHere() ? fontPrefs().projects[currentId] : fontPrefs().global;
function applyFonts() {
  const css = fontCss(fontNow());
  if (css) document.body.style.setProperty('--note-font', css); else document.body.style.removeProperty('--note-font');
  document.body.style.removeProperty('--font');
}
applyFonts();
function saveFonts() { store.setSettings({ fonts: fontPrefs() }); applyFonts(); render(); relayout(); }
function pickFont(k) { const f = fontPrefs(); if (fontHere()) f.projects[currentId] = k; else f.global = k; saveFonts(); }
function setFontScope(here) { const f = fontPrefs(); if (here) f.projects[currentId] = f.global; else delete f.projects[currentId]; saveFonts(); }
function fontPage() {
  const now = fontNow();
  const tile = ([k, name, css]) => `<button class="ft${now === k ? ' on' : ''}" data-md="font" data-font="${k}">
    <div class="ft-pv" style="${css ? `font-family:${esc(css)}` : ''}"><span class="ft-aa">Aa</span><span class="ft-note">The quick brown fox jumps over the lazy dog. 0123456789</span></div>
    <div class="ft-foot"><b>${esc(name)}</b>${now === k ? '<span>In use</span>' : ''}</div></button>`;
  return `<div class="th-scope"><button class="tm-scope${fontHere() ? ' on' : ''}" data-md="fontscope"><span class="switch"></span>This project only</button><span>${fontHere() ? 'The font you pick applies only to this project. This stays on your computer and is not saved in the project.' : 'The font you pick applies to all projects.'}</span></div>
    <div class="ft-grid">${FONTS.map(tile).join('')}</div>`;
}
const libJust = new Map(); // themes added from the Library during this visit: their cards stay, with Undo
settings.mods.saved = settings.mods.saved || []; // mods taken from Browse (the rest of what is on this computer was made here)
const modIsSaved = m => m.from !== 'user' || settings.mods.saved.includes(m.id);
const markSaved = id => { if (id && !settings.mods.saved.includes(id)) { settings.mods.saved.push(id); saveModSettings(); } };
const TAB_NAME = { saved: 'Collection', browse: 'Library' };
const TAB_NOTE = {
  mods: { saved: 'Mods you made, the ones you added from the Library, and the ones that come with Mindview.', browse: 'Every mod people have published. Add the ones you like to your collection.' },
  themes: { saved: 'Themes you made, the ones you added from the Library, and the ones that come with Mindview. Click one to use it.', browse: 'Every theme people have published. Add the ones you like to your collection.' },
};
const MOD_TAGS = ['Quality of life', 'Text formatting', 'Nodes', 'Connections', 'External applications', 'Style', 'Feature', 'Data formats', 'Presentation']; // same list as the mod guide
const MOD_PROMPT = `I want to make a mod for my Mindview app. Use the mindview tools: first call mod_guide to read how mods work (follow its "Feel and practicality" rules), then write the mod and install it with save_mod.
Make it feel natural and practical to use: every option it adds must be easy to find and to change, right where I would look for it (no hidden shortcuts as the only way in). Write as little text as possible in the interface: no descriptions, explanations or hints, just short labels or icons. Keep the code as small as it can be, give it fitting tags (pick from ${MOD_TAGS.map(t => '"' + t + '"').join(', ')} when one fits) its own icon (the "icon" field of the header). Give it a mod page in the same style as the included Text styles mod (read it with mod_guide, id "text-style"): an "about" with one opening line on what it does, a short "- " list of how to use it step by step, then any extra notes; and example pictures or a GIF in "media" showing it in use (pass the files to save_mod as media), and tell me in one sentence what it does.

What I want: `;
const THEME_PROMPT = `I want to make a colour theme for my Mindview app. Use the mindview tools: first call mod_guide to read how mods and themes work, then write the theme as a mod tagged "Theme" and install it with save_mod. Make it a full theme (a "base" of dark or light in the header, and every colour variable set) unless I only ask to change a few things, give it its own icon and keep its description to a few words. Tell me in one sentence what it looks like.

The look I want: `;
// deleting something I made: it is gone for good, so ask first
function askDelete(name) {
  return new Promise(done => {
    const box = document.createElement('div'); box.id = 'mod-confirm';
    box.innerHTML = `<div class="mp-card"><div class="mp-title">Delete “${esc(name)}”?</div><div class="mcr-note">It will be permanently deleted from this computer. This cannot be undone.</div>
      <div class="mp-actions"><button class="danger" data-ok="1">Delete permanently</button><button data-ok="">Cancel</button></div></div>`;
    document.body.appendChild(box);
    const end = ok => { box.remove(); document.removeEventListener('keydown', onKey, true); done(ok); };
    const onKey = e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); end(false); } };
    document.addEventListener('keydown', onKey, true);
    box.addEventListener('pointerdown', e => { e.stopPropagation(); if (e.target === box) end(false); });
    box.addEventListener('click', e => { const b = e.target.closest('[data-ok]'); if (b) end(!!b.dataset.ok); });
    setTimeout(() => box.querySelector('[data-ok=""]').focus(), 30);
  });
}
// "Create a mod": a box to say what the mod should do; the whole prompt, with that text, is copied on Done
function openModCreate(kind) {
  let box = $('#mod-create'); if (box) box.remove();
  box = document.createElement('div'); box.id = 'mod-create';
  const th = (kind || modsKind) === 'themes';
  box.innerHTML = `<div class="mp-card"><div class="mp-title">Create a ${th ? 'theme' : 'mod'}</div><div class="mcr-note">${th ? 'Describe the look you want.' : 'Say what you want the mod to do.'} The full prompt for Claude is copied when you are done.</div>
    <textarea id="mcr-text" rows="6" placeholder="${th ? 'For example: warm paper colours, dark brown text, a deep red accent' : 'For example: a shortcut that collapses every branch except the one I am on'}"></textarea>
    <div class="mp-actions"><button data-mcr="done">Copy prompt</button><button data-mcr="cancel">Cancel</button></div></div>`;
  document.body.appendChild(box);
  const ta = box.querySelector('textarea');
  const onKey = e => { if (!box.isConnected) return; e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(); } };
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  document.addEventListener('keydown', onKey, true);
  const done = () => { const t = ta.value.trim(); if (!t) { ta.focus(); return; } copyText((th ? THEME_PROMPT : MOD_PROMPT) + t + '\n'); close(); const msg = `Prompt copied. Paste it into Claude (the desktop app or Claude Code) and send. Claude writes the ${th ? 'theme' : 'mod'} and installs it here.`; if (!modsMenu.hidden) { modsMsg = { ok: msg }; paintMods(); } else toast(msg); };
  box.addEventListener('pointerdown', e => { e.stopPropagation(); if (e.target === box) close(); });
  box.addEventListener('click', e => { const b = e.target.closest('[data-mcr]'); if (b) (b.dataset.mcr === 'done' ? done : close)(); });
  setTimeout(() => ta.focus(), 30);
}
const modTint = id => { let n = 2166136261; for (const ch of id) n = Math.imul(n ^ ch.charCodeAt(0), 16777619) >>> 0; n = (n ^ (n >>> 15)) >>> 0; const c = COLORS[1 + n % (COLORS.length - 1)]; return uiTheme === 'light' ? c.light : c.dark; };
const MOD_ICONS = {
  back: '<svg viewBox="0 0 20 20"><path d="M12 4l-6 6 6 6"/></svg>',
  plus: '<svg viewBox="0 0 20 20"><path d="M10 4v12M4 10h12"/></svg>',
  shelf: '<svg viewBox="0 0 20 20"><path d="M3.500 4.500h13v11h-13zM3.500 10h13M8 4.500v5.500M12.500 10v5.500"/></svg>',
  puzzle: '<svg viewBox="0 0 20 20"><path d="M8 3.500h4v2.200a1.600 1.600 0 1 0 3 0h1.500v4.300h-1.700a1.600 1.600 0 1 0 0 3h1.700v3.500h-12v-3.500h1.700a1.600 1.600 0 1 0 0-3H3.500V5.700H8z"/></svg>',
  check: '<svg viewBox="0 0 20 20"><path d="M4.500 10.500l3.500 3.500 7.500-8"/></svg>',
};
function modCard(m, body, cls = '') {
  return `<div class="mc${cls}" data-card="${esc(m.id)}"${body.st ? ` data-st="${body.st}"` : ''} style="--c:${modTint(m.id)}"><div class="mc-top"><div class="mc-icon">${m.icon ? `<svg viewBox="0 0 20 20"><path d="${esc(m.icon)}"/></svg>` : esc((m.name || '?').trim()[0].toUpperCase())}</div>
    <div class="mc-id"><div class="md-head"><b>${esc(m.name)}</b></div><div class="mc-meta">v${esc(m.version)}${m.author ? ' · ' + esc(m.author) : ''}</div></div>${body.side || ''}</div>
    <div class="mc-desc">${esc(m.description || 'No description.')}</div>
    ${(m.tags || []).length || m.kind === 'content' ? `<div class="mc-tags">${(m.tags || []).map(t => `<button class="mc-tag${modsTag === t.toLowerCase() ? ' on' : ''}" data-md="tag" data-tag="${esc(t.toLowerCase())}">${esc(t)}</button>`).join('')}${m.kind === 'content' ? '<span class="mc-tag data">Saved in projects</span>' : ''}</div>` : ''}${body.foot || ''}</div>`;
}
// ---- themes shelf: Dark, Light and theme mods, one in use at a time
const BASE_PREVIEW = { dark: { bg: '#111214', card: '#1b1c20', text: '#e8e6e1', accent: '#e8b04b', line: '#2b2d33', edge: '#464953' }, light: { bg: '#f4f2ee', card: '#ffffff', text: '#24252a', accent: '#c98a1a', line: '#e3e0da', edge: '#c3c0b9' } };
function themeTile(key, name, pv, sub, extra, on) {
  const c = Object.assign({}, BASE_PREVIEW[pv && pv.mode || uiTheme], pv && pv.c);
  const v = Object.entries(c).map(([k, x]) => `--p${k}:${esc(x)}`).join(';');
  return `<div class="th${on ? ' on' : ''}"${key ? ` data-md="theme" data-theme="${esc(key)}"` : ''}>
    <div class="th-pv" style="${v}"><i class="th-a"></i><i class="th-b"></i><i class="th-c"></i><svg viewBox="0 0 100 56" preserveAspectRatio="none"><path d="M34 28C46 28 46 15 58 15M34 28C46 28 46 41 58 41"/></svg></div>
    <div class="th-foot"><div class="th-id"><b>${esc(name)}</b><span>${sub}</span></div>${extra || ''}</div></div>`;
}
function themeShelf(themes, builtIn = modsTab === 'saved', own = false) {
  if (!themes.length && !builtIn) return '';
  const act = modsTab === 'browse' ? null : themeActive();
  const modPv = m => { const p = m.preview || {}; return m.base ? { mode: m.base, c: p[m.base] || p.dark || p.light } : { c: p[uiTheme] || p.dark || p.light || { accent: modTint(m.id) } }; };
  const sub = (m, on) => on ? 'In use' : m.partial ? 'Accent' : (m.author ? 'by ' + esc(m.author) : 'v' + esc(m.version));
  let t = '', tp = '';
  if (builtIn) t += themeTile(':dark', 'Dark', { mode: 'dark' }, !act && uiTheme === 'dark' ? 'In use' : 'Comes with Mindview', '', !act && uiTheme === 'dark') + themeTile(':light', 'Light', { mode: 'light' }, !act && uiTheme === 'light' ? 'In use' : 'Comes with Mindview', '', !act && uiTheme === 'light');
  for (const m of themes) {
    if (modsTab === 'browse') {
      const have = modMeta(m.id), same = have && have.version === m.version;
      const just = libJust.has(m.id);
      const tile = just ? themeTile('', m.name, modPv(m), 'Added · in use', `<button class="mc-btn quiet" data-md="undotheme" data-id="${esc(m.id)}">Undo</button>`, true)
        : !m.url ? themeTile('', m.name, modPv(m), sub(m, false), `${m.from === 'user' ? `<button class="mc-rm" data-md="remove" data-id="${esc(m.id)}">Delete</button>` : ''}<button class="mc-btn" data-md="addtheme" data-id="${esc(m.id)}">Add</button>`) : themeTile('', m.name, modPv(m), sub(m, false), `<button class="mc-btn${have && same ? ' quiet' : ''}" data-md="install" data-id="${esc(m.id)}">${have ? (same ? 'Added' : 'Update') : 'Add'}</button>`);
      if (m.partial) tp += tile; else t += tile;
    } else {
      const on = m.partial ? accentActive() === m.id : act === m.id;
      const tile = themeTile(m.id, m.name, modPv(m), sub(m, on), `<button class="mc-rm" data-md="hide" data-id="${esc(m.id)}">Remove</button>`, on);
      if (m.partial) tp += tile; else t += tile;
    }
  }
  const col = (title, note, tiles) => `<div class="th-col"><div class="mp-sec">${title}</div>${note ? `<div class="th-colnote">${note}</div>` : ''}${tiles ? `<div class="mp-shelf">${tiles}</div>` : '<div class="th-none">None yet.</div>'}</div>`;
  if (own) return `<div class="th-cols">${t ? col('Full themes', '', t) : ''}${tp ? col('Accents', '', tp) : ''}</div>`; // what I made: only the kinds I have
  return `<div class="th-cols">${col('Full themes', 'A complete look of their own.', t)}${col('Accents', 'Add one on top of the theme in use.', tp)}</div>`;
}
// a mod's page: what it does and how to use it, with example pictures
function modPage(m) {
  if (!m) return '';
  const blocks = String(m.about || m.description || '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean).map(b => {
    const lines = b.split('\n');
    if (lines.every(l => /^\s*[-•]\s+/.test(l))) return `<ul>${lines.map(l => `<li>${esc(l.replace(/^\s*[-•]\s+/, ''))}</li>`).join('')}</ul>`;
    return `<p>${esc(b).replace(/\n/g, '<br>')}</p>`;
  }).join('');
  const media = (m.media || []).map(u => `<button class="mpg-shot" data-md="shot" data-src="${esc(u)}"><img src="${esc(u)}" alt="" loading="lazy"></button>`).join('');
  return `<div class="mpg">${blocks ? `<div class="mpg-text">${blocks}</div>` : ''}${media ? `<div class="mpg-media">${media}</div>` : ''}</div>`;
}
function paintMods() {
  refreshMods();
  const keep = modsMenu.scrollTop;
  const head = extra => `<div class="mp-head">${extra || ''}</div>`;
  const looks = `<button class="mp-bigback" data-md="close">${MOD_ICONS.back}<span>Back to notes</span></button><div class="mp-kind${modsKind === 'fonts' ? ' th' : ''}"><i></i><button class="${modsKind === 'themes' ? 'on' : ''}" data-md="kind" data-kind="themes">Themes</button><button class="${modsKind === 'fonts' ? 'on' : ''}" data-md="kind" data-kind="fonts">Fonts</button></div>`;
  if (modsKind === 'fonts') { modsMenu.innerHTML = head(looks) + `<div class="mp-col">${fontPage()}</div>`; modsSig = null; modsMenu.scrollTop = keep; return; }
  if (!host || !host.modsList) { modsMenu.innerHTML = head() + '<div class="mp-col"><div class="mp-empty"><div class="mp-empty-title">Mods work in the desktop app</div></div></div>'; return; }
  const inCatalog = modsTab === 'browse';
  const th = modsKind === 'themes', ofKind = m => isThemeMod(m) === th;
  const mine = modMetas.filter(m => ofKind(m) && !modIsSaved(m) && !shelved().includes(m.id)), saved = modMetas.filter(m => ofKind(m) && modIsSaved(m) && !(th && !themeInCollection(m)));
  const libAll = (modsCatalog && modsCatalog.ok) || [], ownLib = modMetas.filter(m => ofKind(m) && (th ? (m.from === 'included' || m.from === 'user') && (!themeInCollection(m) || libJust.has(m.id)) : shelved().includes(m.id)));
  const lib = ownLib.concat(libAll.filter(m => ofKind(m) && !ownLib.some(o => o.id === m.id)));
  const pool = inCatalog ? lib : mine.concat(saved);
  const themesHere = th ? pool : [], rest = th ? [] : pool; // themes are a page of their own (the Mods / Themes switch)
  const known = th ? [] : MOD_TAGS.concat(modMetas.concat(libAll).filter(m => !isThemeMod(m)).flatMap(m => m.tags || [])); // every tag, even ones nothing has yet
  const tagsHere = [...new Map(known.concat(rest.flatMap(m => m.tags || [])).filter(t => t.toLowerCase() !== 'theme').map(t => [t.toLowerCase(), t])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  if (modsTag && !tagsHere.some(t => t[0] === modsTag)) modsTag = null;
  if (modsOpen && (th || !rest.some(m => m.id === modsOpen))) modsOpen = null;
  const list = modsOpen ? rest.filter(m => m.id === modsOpen) : rest.filter(m => !modsTag || (m.tags || []).some(t => t.toLowerCase() === modsTag));
  const sig = modsKind + '/' + modsTab + '/' + (modsTag || '') + '/' + (modsOpen || ''), nowSt = {};
  let h = '';
  if (modsMsg) h += `<div class="mp-banner ${modsMsg.err ? 'sh-err' : 'sh-ok'}"><span>${esc(modsMsg.err || modsMsg.ok)}</span><button data-md="dismiss">×</button></div>`;
  if (th && !inCatalog) h += `<div class="th-scope"><button class="tm-scope${themeHere() ? ' on' : ''}" data-md="scope"><span class="switch"></span>This project only</button><span>${themeHere() ? 'The theme you pick applies only to this project. This stays on your computer and is not saved in the project.' : 'The theme you pick applies to all projects.'}</span></div>`;
  const madeSec = modsOpen ? '' : '<div class="mp-sec mp-made">Made by me</div>', split = '<hr class="mp-split">';
  if (th && inCatalog && themesHere.length) h += themeShelf(themesHere);
  if (th && !inCatalog) { if (mine.length) h += madeSec + themeShelf(mine, false, true) + split; h += themeShelf(saved); }
  if (modsOpen) h += `<button class="mp-back" data-md="page-close">${MOD_ICONS.back}<span>${TAB_NAME[modsTab]}</span></button>`;
  else if (tagsHere.length) h += `<div class="mp-filter"><button class="mc-tag${modsTag ? '' : ' on'}" data-md="tag" data-tag="">All</button>${tagsHere.map(([k, t]) => `<button class="mc-tag${modsTag === k ? ' on' : ''}" data-md="tag" data-tag="${esc(k)}">${esc(t)}</button>`).join('')}</div>`;
  const empty = (title, text) => `<div class="mp-empty"><div class="mp-empty-icon">${MOD_ICONS.puzzle}</div><div class="mp-empty-title">${title}</div><div class="mp-empty-text">${text}</div></div>`;
  if (inCatalog) {
    const myShelf = th ? [] : list.filter(m => ownLib.includes(m));
    if (myShelf.length) h += madeSec + '<div class="mp-grid">' + myShelf.map(m => modCard(m, { foot: `<div class="mc-foot"><button class="mc-rm" data-md="remove" data-id="${esc(m.id)}">Delete</button><span class="sh-grow"></span><button class="mc-btn" data-md="unshelve" data-id="${esc(m.id)}">Add</button></div>` })).join('') + '</div>' + (modsOpen ? '' : split);
    const others = list.filter(m => !ownLib.includes(m)); list.length = 0; list.push(...others);
    if (th && themesHere.length) { /* themes shown above; what comes with Mindview needs no library */ }
    else if (!modsCatalog) h += '<div class="mp-empty"><span class="spin"></span><div class="mp-empty-text">Loading…</div></div>';
    else if (!modsCatalog.repo) h += empty('No library set yet', 'Enter the GitHub repository that holds the mods below.');
    else if (modsCatalog.error) h += `<div class="mp-banner sh-err"><span>${esc(modsCatalog.error)}</span></div>`;
    else if (!list.length && modsTag) { /* nothing with this tag */ }
    else if (!list.length && !themesHere.length) h += empty('Nothing here yet', `No ${th ? 'themes' : 'mods'} have been published.`);
    else if (!list.length) { /* only themes */ }
    else {
      h += '<div class="mp-grid">';
      for (const m of list) {
        const have = modMeta(m.id), same = have && have.version === m.version;
        h += modCard(m, { foot: `<div class="mc-foot"><span class="mc-state">${have ? (same ? 'In your collection' : `You have v${esc(have.version)}`) : ''}</span><button class="mc-btn${have && same ? ' quiet' : ''}" data-md="install" data-id="${esc(m.id)}">${have ? (same ? 'Add again' : 'Update') : 'Add'}</button></div>` });
      }
      h += '</div>';
    }
    h += `<form class="mp-source" data-form="repo"><label for="md-repo">Library source</label><input id="md-repo" placeholder="owner/name on GitHub" value="${esc((modsCatalog && modsCatalog.repo) || settings.mods.repo || '')}"><button class="mc-btn quiet">Set</button></form>`;
  } else {
    const missing = (doc.requires || []).filter(r => r && r.id && !modMeta(r.id));
    if (missing.length) h += `<div class="mp-banner sh-err"><span>Missing for this project: ${missing.map(r => esc(r.name || r.id)).join(', ')}.</span><button class="mp-banner-act" data-md="missing">Add…</button></div>`;
    if (th) { /* shelves above */ }
    else if (!list.length) { if (!modsTag) h += empty('Your collection is empty', 'Find mods in the Library.'); }
    else {
      const needed = new Set((doc.requires || []).map(r => r.id));
      h += '<div class="mp-grid">';
      const stOf = m => { const g = settings.mods.global.includes(m.id), x = g && modExcluded().includes(m.id); return g ? (x ? 'excluded' : 'global') : (m.kind === 'content' ? (doc.mods || []).includes(m.id) || needed.has(m.id) : projMods().includes(m.id)) ? 'project' : 'off'; };
      const rank = { global: 0, project: 1, excluded: 2, off: 3 };
      list.sort((a, b) => rank[stOf(a)] - rank[stOf(b)] || a.name.localeCompare(b.name));
      const myList = list.filter(m => mine.includes(m)), theirs = list.filter(m => !mine.includes(m));
      if (myList.length) { h = h.replace(/<div class="mp-grid">$/, madeSec + '<div class="mp-grid">'); }
      let sec = 0;
      for (const m of myList.concat(theirs)) {
        if (myList.length && theirs.length && sec === 0 && !mine.includes(m)) { sec = 1; h += '</div>' + split + '<div class="mp-grid">'; }
        const st = stOf(m), was = sig === modsSig && modsPrev[m.id] ? modsPrev[m.id] : st; nowSt[m.id] = st;
        const g = settings.mods.global.includes(m.id), p = m.kind === 'content' ? (doc.mods || []).includes(m.id) || needed.has(m.id) : projMods().includes(m.id);
        const x = g && modExcluded().includes(m.id);
        const need = m.kind === 'content' && !x && (p || (g && hasModData(m.id)));
        h += modCard(m, {
          st,
          side: `<div class="md-toggles md-inline"><button class="md-tog${g ? ' on' : ''}" data-md="global" data-id="${esc(m.id)}">All projects</button>${g ? `<button class="md-tog excl${x ? ' on' : ''}" data-md="exclude" data-id="${esc(m.id)}">Exclude project</button>` : `<button class="md-tog${p ? ' on' : ''}" data-md="project" data-id="${esc(m.id)}">This project</button>`}${m.from === 'user' ? `<button class="mc-rm md-rm" data-md="${modIsSaved(m) ? 'uninstall' : 'shelve'}" data-id="${esc(m.id)}">Remove</button>` : ''}</div>`,
          foot: need ? '<div class="md-need">This project needs this mod: others will be asked to add it.</div>' : '',
        }, ` st-${was}${was !== 'off' ? ' fill' : ''}`);
      }
      h += '</div>';
    }
  }
  if (modsOpen) h += modPage(modMeta(modsOpen) || lib.find(m => m.id === modsOpen));
  const counts = { saved: mine.length + saved.length + (th ? 2 : 0), browse: th || (modsCatalog && modsCatalog.ok) ? lib.length : '' };
  const kinds = `<div class="mp-kind${th ? ' th' : ''}"><i></i><button class="${th ? '' : 'on'}" data-md="kind" data-kind="mods">Mods</button><button class="${th ? 'on' : ''}" data-md="kind" data-kind="themes">Themes</button></div>`;
  const back = th ? looks : '';
  const tabs = back + `<div class="mp-tabs">${['saved', 'browse'].map(k => `<button class="mp-tab${modsTab === k ? ' on' : ''}" data-md="tab" data-tab="${k}">${TAB_NAME[k]}</button>`).join('')}</div>`;
  const actions = `<span class="sh-grow"></span><button class="mp-act primary" data-md="create">${MOD_ICONS.plus}Create a ${th ? 'theme' : 'mod'}</button>`;
  // cards keep their place and colour for one frame, then slide to the new order while the colour wipes in or out
  const before = new Map(); if (sig === modsSig) for (const c of modsMenu.querySelectorAll('.mc[data-card]')) before.set(c.dataset.card, c.getBoundingClientRect());
  modsMenu.innerHTML = head(tabs + actions) + `<div class="mp-col${sig === modsSig ? ' still' : ''}">${h}</div>`;
  modsSig = sig; modsPrev = nowSt;
  modsMenu.scrollTop = keep;
  for (const c of modsMenu.querySelectorAll('.mc[data-st]')) {
    const st = c.dataset.st, r0 = before.get(c.dataset.card), r1 = c.getBoundingClientRect();
    const moved = r0 && (Math.abs(r0.left - r1.left) > 1 || Math.abs(r0.top - r1.top) > 1), recolour = !c.classList.contains('st-' + st);
    if (!moved && !recolour) continue;
    if (moved) { c.style.transition = 'none'; c.style.transform = `translate(${r0.left - r1.left}px, ${r0.top - r1.top}px)`; }
    c.getBoundingClientRect();
    requestAnimationFrame(() => {
      if (recolour) { if (st === 'off') c.classList.remove('fill'); else { c.className = c.className.replace(/st-\w+/, 'st-' + st); c.classList.add('fill'); } }
      if (moved) { c.style.transition = 'transform .42s cubic-bezier(.3,.9,.3,1)'; c.style.transform = ''; setTimeout(() => { c.style.transition = ''; }, 460); }
    });
  }
  modsMenu.scrollTop = keep;
}
async function loadCatalog() { modsCatalog = null; paintMods(); modsCatalog = await host.modsCatalog(); if (!modsMenu.hidden) paintMods(); }
function setModsKind(k) { modsKind = k; settings.modsKind = k; store.setSettings({ modsKind: k }); const open = !modsMenu.hidden; $('#btn-theme').classList.toggle('open', open && k !== 'mods'); $('#btn-mods').classList.toggle('open', open && k === 'mods'); }
function openMods(kind) { closeThemes(); setModsKind(['themes', 'fonts'].includes(kind) ? kind : 'mods'); modsMsg = null; modsTag = null; if (editingId) commitEdit(); modsMenu.hidden = false; $('#btn-theme').classList.toggle('open', modsKind !== 'mods'); $('#btn-mods').classList.toggle('open', modsKind === 'mods'); paintMods(); modsMenu.scrollTop = 0; if (modsTab === 'browse' && host && host.modsCatalog) loadCatalog(); }
function closeMods() { modsOpen = null; libJust.clear(); modsSig = null; modsMenu.hidden = true; $('#btn-theme').classList.remove('open'); $('#btn-mods').classList.remove('open'); }
$('#btn-mods').addEventListener('click', e => { e.stopPropagation(); if (modsMenu.hidden) openMods(); else if (modsKind !== 'mods') { setModsKind('mods'); modsTag = null; modsMsg = null; modsMenu.scrollTop = 0; paintMods(); } else closeMods(); });
// right-click the dark-mode button: the Themes page
$('#btn-theme').addEventListener('contextmenu', e => {
  e.preventDefault(); e.stopPropagation();
  if (modsMenu.hidden) openMods('themes');
  else if (modsKind !== 'themes') { setModsKind('themes'); modsTag = null; modsMsg = null; modsMenu.scrollTop = 0; paintMods(); }
  else closeMods();
});
modsMenu.addEventListener('pointerdown', e => e.stopPropagation());
modsMenu.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') closeMods(); });
window.addEventListener('keydown', e => { if (e.key === 'Escape' && !modsMenu.hidden && !aiMode && !e.target.closest('input, textarea')) { e.preventDefault(); closeMods(); } });
modsMenu.addEventListener('submit', async e => {
  e.preventDefault();
  const v = $('#md-repo').value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
  settings.mods.repo = v; saveModSettings(); await loadCatalog();
});
modsMenu.addEventListener('click', async e => {
  const b = e.target.closest('[data-md]');
  if (!b) { const c = e.target.closest('.mc[data-card]'); if (c && !modsOpen && modsKind === 'mods') { modsOpen = c.dataset.card; modsMenu.scrollTop = 0; paintMods(); } return; }
  const id = b.dataset.id, act = b.dataset.md, meta = id && modMeta(id);
  if (act === 'page-close') { modsOpen = null; paintMods(); return; }
  if (act === 'shot') { openLightbox(b.dataset.src); return; }
  if (act === 'dismiss') { modsMsg = null; paintMods(); return; }
  if (act === 'font') { pickFont(b.dataset.font); paintMods(); return; }
  if (act === 'fontscope') { setFontScope(!fontHere()); paintMods(); return; }
  if (act === 'theme') { if (e.target.closest('button')) return; await pickTheme(b.dataset.theme); paintMods(); return; }
  const flip = act === 'global' || act === 'project' || act === 'exclude'; if (flip) { b.classList.toggle('on'); b.blur(); } // the switch moves at once; the page catches up after
  modsMsg = null;
  const toggle = (list, on) => { const i = list.indexOf(id); if (on && i < 0) list.push(id); if (!on && i >= 0) list.splice(i, 1); };
  if (act === 'global') { toggle(settings.mods.global, !settings.mods.global.includes(id)); saveModSettings(); await syncMods(); scheduleSave(); }
  else if (act === 'exclude') {
    const on = !modExcluded().includes(id); toggle(modExcluded(), on);
    if (on) { // off here means off here: drop this project's own switch for it too
      toggle(projMods(), false);
      if (meta.kind === 'content' && ((doc.mods || []).includes(id) || (doc.requires || []).some(r => r.id === id))) { checkpoint(); doc.mods = (doc.mods || []).filter(i => i !== id); if (!doc.mods.length) delete doc.mods; doc.requires = (doc.requires || []).filter(r => r.id !== id); scheduleSave(); }
      if (meta.kind === 'content' && hasModData(id)) modsMsg = { ok: `“${meta.name}” is off for this project. What it added to the notes is kept, hidden, in case you turn it back on.` };
    }
    saveModSettings(); await syncMods(); scheduleSave();
  }
  else if (act === 'project') {
    if (meta.kind === 'content') { // part of the project itself, shared with everyone who opens it
      const on = !((doc.mods || []).includes(id) || (doc.requires || []).some(r => r.id === id));
      checkpoint(); doc.mods = doc.mods || []; toggle(doc.mods, on);
      if (!on) { doc.requires = (doc.requires || []).filter(r => r.id !== id); if (hasModData(id) && !settings.mods.global.includes(id)) modsMsg = { ok: `“${meta.name}” is off for this project. What it added to the notes is kept, hidden, in case you turn it back on.` }; }
      if (!doc.mods.length) delete doc.mods;
      scheduleSave();
    } else { toggle(projMods(), !projMods().includes(id)); saveModSettings(); }
    await syncMods();
  }
  else if (act === 'scope') { await setThemeScope(!themeHere()); }
  else if (act === 'shelve') { settings.mods.global = settings.mods.global.filter(x => x !== id); for (const k in settings.mods.projects) settings.mods.projects[k] = settings.mods.projects[k].filter(x => x !== id); for (const k in settings.mods.excluded) settings.mods.excluded[k] = settings.mods.excluded[k].filter(x => x !== id); if (!shelved().includes(id)) shelved().push(id); saveModSettings(); await syncMods(); }
  else if (act === 'unshelve') { settings.mods.shelved = shelved().filter(x => x !== id); saveModSettings(); await syncMods(); }
  else if (act === 'hide') { if (meta && meta.from === 'user' && !shelved().includes(id)) shelved().push(id); const l = themesIn(), i = l.indexOf(id); if (i >= 0) l.splice(i, 1); forgetTheme(id); saveModSettings(); saveThemes(); modsMsg = { ok: `Moved ${meta ? meta.name : id} back to the Library.` }; await refreshTheme(); }
  else if (act === 'addtheme') { // add and use at once; the card stays, with Undo
    const t = themeState(); libJust.set(id, { scope: themeHere() ? currentId : null, before: { ...themeEntry() } });
    if (meta && meta.from === 'user') settings.mods.shelved = shelved().filter(x => x !== id); else if (!themesIn().includes(id)) themesIn().push(id);
    saveModSettings(); await pickTheme(id);
  }
  else if (act === 'undotheme') {
    const j = libJust.get(id); libJust.delete(id);
    const l = themesIn(), i = l.indexOf(id); if (i >= 0) l.splice(i, 1); if (meta && meta.from === 'user' && !shelved().includes(id)) shelved().push(id); saveModSettings();
    const t = themeState(); if (j) { if (j.scope) t.projects[j.scope] = j.before; else t.global = j.before; } forgetTheme(id);
    if (j && j.fromLibrary) { settings.mods.saved = settings.mods.saved.filter(x => x !== id); saveModSettings(); await host.modRemove(id); }
    saveThemes(); await refreshTheme();
  }
  else if (act === 'remove' || act === 'uninstall') { const mm = modMeta(id); if (act === 'remove' && !await askDelete(mm ? mm.name : id)) return; if (isThemeId(id)) { forgetTheme(id); saveThemes(); } settings.mods.global = settings.mods.global.filter(x => x !== id); for (const k in settings.mods.projects) settings.mods.projects[k] = settings.mods.projects[k].filter(x => x !== id); for (const k in settings.mods.excluded) settings.mods.excluded[k] = settings.mods.excluded[k].filter(x => x !== id); settings.mods.saved = settings.mods.saved.filter(x => x !== id); settings.mods.shelved = shelved().filter(x => x !== id); saveModSettings(); await host.modRemove(id); await syncMods(); }
  else if (act === 'file') { const r = await host.modsAdd(); if (r.error) modsMsg = { err: r.error }; else if (r.ok.length) modsMsg = { ok: `Added ${r.ok.map(m => m.name).join(', ')}. Switch ${r.ok.length > 1 ? 'them' : 'it'} on below.` }; await syncMods(); checkMissingMods(); }
  else if (act === 'create') { openModCreate(); return; }
  else if (act === 'folder') host.modsOpenFolder();
  else if (act === 'close') { closeMods(); return; }
  else if (act === 'tab') { modsOpen = null; libJust.clear(); modsTab = b.dataset.tab; modsTag = null; settings.modsTab = modsTab; store.setSettings({ modsTab }); modsMsg = null; modsMenu.scrollTop = 0; if (modsTab === 'browse') { loadCatalog(); return; } }
  else if (act === 'tag') { modsOpen = null; modsTag = b.dataset.tag || null; }
  else if (act === 'kind') { if (b.dataset.kind === modsKind) return; modsOpen = null; setModsKind(b.dataset.kind); modsTag = null; modsMenu.scrollTop = 0; }
  else if (act === 'missing') { closeMods(); checkMissingMods(); return; }
  else if (act === 'install' && modsKind === 'themes') {
    b.textContent = 'Adding…'; const had = !!modMeta(id); const before = { ...themeEntry() }, scope = themeHere() ? currentId : null;
    const r = await host.modInstall(id);
    if (r.error) modsMsg = { err: r.error }; else { markSaved(r.ok.id); refreshMods(); libJust.set(r.ok.id, { scope, before, fromLibrary: !had }); await pickTheme(r.ok.id); }
  }
  else if (act === 'install') { b.textContent = 'Adding…'; const r = await host.modInstall(id); if (!r.error) markSaved(r.ok.id); modsMsg = r.error ? { err: r.error } : { ok: isThemeMod(r.ok) ? `Added ${r.ok.name} to your collection. Use it from Collection, or the dark-mode button.` : `Added ${r.ok.name} to your collection. Switch it on under Collection.` }; if (!r.error && modLive.has(id)) { stopMod(id); } await syncMods(); checkMissingMods(); }
  if (flip) await new Promise(r => setTimeout(r, 190));
  paintMods();
});

/* ---- the AI menu: connect AI apps to Mindview (MCP) ---- */
const aiMenu = $('#ai-menu');
let aiApps = null, aiMsg = null, aiAgentsState = null;
const aiAgentName = () => { const s = aiAgentsState, a = s && s.list.find(x => x.id === s.selected); return a ? a.name : 'the AI'; };
if (host && host.aiAgents) host.aiAgents().then(s => { aiAgentsState = s; });
function paintAi() {
  let h = '';
  if (!host || !host.mcpStatus) { aiMenu.innerHTML = h + '<div class="sh-note">This works in the desktop app.</div>'; return; }
  if (aiAgentsState) {
    h += '<div class="pm-label">AI mode (Alt+A)</div>';
    for (const a of aiAgentsState.list) h += `<div class="ai-row ai-agent${a.id === aiAgentsState.selected ? ' on' : ''}${a.found ? '' : ' missing'}" data-agent="${a.id}"><span class="ai-radio"></span><b>${esc(a.name)}</b><span class="ai-state">${a.found ? '' : 'Not found'}</span>${a.queue || a.found ? '' : `<span class="sh-link" data-locate="${a.id}">Locate…</span>`}</div>`;
    if (!aiAgentsState.selected) h += '<div class="sh-note">Claude was not found by itself. If Claude Code is installed, use Locate to point to its program.</div>';
    h += '<div class="pm-sep"></div>';
  }
  const open = !!settings.aiConnectOpen || !!aiMsg;
  const linked = (aiApps || []).some(a => a.installed && !a.stale);
  h += `<div class="pm-label ai-fold${open ? ' open' : ''}" data-fold="1"><span class="ai-chev">›</span>MCP connection${aiApps ? `<span class="ai-conn${linked ? ' on' : ''}">${linked ? 'Connected' : 'Not connected'}</span>` : ''}</div>`;
  if (!open) { aiMenu.innerHTML = h; return; }
  if (aiMsg) h += `<div class="${aiMsg.err ? 'sh-err' : 'sh-ok'}">${esc(aiMsg.err || aiMsg.ok)}</div>`;
  for (const a of aiApps || []) h += `<div class="ai-row"><b>${esc(a.name)}</b><span class="ai-state${a.installed && !a.stale ? ' on' : ''}">${a.stale ? 'Mindview has moved' : a.installed ? 'Connected' : a.found ? '' : 'Not found on this PC'}</span><span class="sh-link" data-ai="${a.installed && !a.stale ? 'remove' : 'install'}" data-id="${a.id}">${a.stale ? 'Reconnect' : a.installed ? 'Remove' : 'Install'}</span></div>`;
  aiMenu.innerHTML = h;
}
async function openAi() { aiMsg = null; aiMenu.hidden = false; $('#btn-ai').classList.add('open'); underButton(aiMenu, $('#btn-ai')); paintAi(); if (host && host.mcpStatus) { [aiApps, aiAgentsState] = await Promise.all([host.mcpStatus(), host.aiAgents()]); paintAi(); } }
function closeAi() { aiMenu.hidden = true; $('#btn-ai').classList.remove('open'); }
$('#btn-ai').addEventListener('click', e => { e.stopPropagation(); if (aiMenu.hidden) openAi(); else closeAi(); });
aiMenu.addEventListener('pointerdown', e => e.stopPropagation());
document.addEventListener('pointerdown', e => { if (!aiMenu.hidden && !e.target.closest('#ai-menu, #btn-ai')) closeAi(); });
aiMenu.addEventListener('click', async e => {
  if (e.target.closest('[data-fold]')) { settings.aiConnectOpen = !(settings.aiConnectOpen || aiMsg); aiMsg = null; store.setSettings({ aiConnectOpen: settings.aiConnectOpen }); paintAi(); return; }
  const ag = e.target.closest('[data-agent]'); if (ag) { aiAgentsState = await host.aiPick(ag.dataset.agent, !!e.target.closest('[data-locate]')); paintAi(); return; }
  const b = e.target.closest('[data-ai]'); if (!b) return;
  const app = (aiApps || []).find(a => a.id === b.dataset.id), on = b.dataset.ai === 'install';
  const r = on ? await host.mcpInstall(app.id) : await host.mcpRemove(app.id);
  aiApps = r.ok || aiApps;
  aiMsg = r.error ? { err: r.error } : { ok: on ? `Mindview is now connected to ${app.name}. ${app.note || 'Restart it if it is open.'}` : `Removed from ${app.name}.` };
  paintAi();
});

/* ---- AI mode (Alt+A): point at something, or drag over an area, and tell the AI what to do ---- */
let aiMode = false, aiDrag = null, aiTarget = null;
const aiBox = document.createElement('div'); aiBox.id = 'ai-box'; aiBox.hidden = true;
aiBox.innerHTML = '<div class="ab-target"></div><textarea rows="2" placeholder="Tell the AI what to do..."></textarea><div class="ab-hint">Enter to send · Esc to cancel</div>';
const aiRect = document.createElement('div'); aiRect.id = 'ai-rect'; aiRect.hidden = true;
const aiTasks = document.createElement('div'); aiTasks.id = 'ai-tasks';
document.body.append(aiRect, aiBox, aiTasks);
const aiInput = aiBox.querySelector('textarea');
aiBox.addEventListener('pointerdown', e => e.stopPropagation()); // typing an instruction must not close the menu being pointed at
function setAiMode(on) {
  aiMode = on; document.body.classList.toggle('ai-mode', on); $('#btn-ai').classList.toggle('on', on);
  if (on) { if (editingId) commitEdit(); } else closeAiBox();
}
function closeAiBox() { showMark(null); for (const el of document.querySelectorAll('.ai-hover')) el.classList.remove('ai-hover'); aiBox.hidden = true; aiRect.hidden = true; aiTarget = null; for (const el of document.querySelectorAll('.ai-pick')) el.classList.remove('ai-pick'); }
const aiLabel = el => (el.getAttribute('aria-label') || el.innerText || el.id || el.tagName).trim().split('\n')[0].slice(0, 60);
// what is under the pointer, in words the AI can act on
const aiSelector = el => (el.id ? '#' + el.id : (el.closest('[id]') ? '#' + el.closest('[id]').id + ' ' : '') + el.tagName.toLowerCase() + [...el.classList].filter(c => c !== 'ai-pick').map(c => '.' + c).join(''));
// the path to an element, from the nearest element with an id: enough for a mod to find exactly that element
const aiPath = el => { const out = []; for (let e = el; e && e !== document.body && out.length < 7; e = e.parentElement) { out.unshift(e.id ? '#' + e.id : e.tagName.toLowerCase() + [...e.classList].filter(c => !/^ai-/.test(c)).map(c => '.' + c).join('')); if (e.id) break; } return out.join(' > '); };
const aiHtml = el => el.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/\s+/g, ' ').slice(0, 300);
// the word under the pointer, when pointing at text
function aiWord(x, y) {
  const r = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y); if (!r || r.startContainer.nodeType !== 3) return '';
  const t = r.startContainer.textContent, i = r.startOffset; let a = i, b = i;
  while (a > 0 && /[\p{L}\p{N}'-]/u.test(t[a - 1])) a--; while (b < t.length && /[\p{L}\p{N}'-]/u.test(t[b])) b++;
  if (a === b) return '';
  const wr = document.createRange(); wr.setStart(r.startContainer, a); wr.setEnd(r.startContainer, b); aiWordRect = wr.getBoundingClientRect();
  return t.slice(a, b);
}
let aiWordRect = null;
const aiMark = document.createElement('div'); aiMark.id = 'ai-mark'; aiMark.hidden = true; document.body.appendChild(aiMark);
function showMark(rect, solid) { // a frame around just the word pointed at
  if (!rect) { aiMark.hidden = true; return; }
  Object.assign(aiMark.style, { left: rect.left - 3 + 'px', top: rect.top - 2 + 'px', width: rect.width + 6 + 'px', height: rect.height + 4 + 'px' });
  aiMark.classList.toggle('solid', !!solid); aiMark.hidden = false;
}
const NOTE_PARTS = [['.handle', 'its + handle (drag to connect, click to add a child)', '+ handle'], ['.fold', 'its badge counting hidden children', 'hidden-children badge'], ['.body-mark', 'the mark showing it has a description', 'description mark'], ['.jump', 'its link badge', 'link badge'], ['.thumb, img', 'an image shown in it', 'image']];
function aiDescribe(x, y) {
  let el = document.elementFromPoint(x, y); if (!el) return null;
  const hit = el.closest('path.hit[data-link]');
  if (hit) { const L = doc.links.find(l => l.id === hit.dataset.link); if (L && N(L.a) && N(L.b)) return { kind: 'link', ids: [L.a, L.b], part: `the ${L.kind === 'jump' ? 'jump link' : 'arrow'} from the first note to the second`, label: `Arrow: ${firstLine(N(L.a).text)} → ${firstLine(N(L.b).text)}`, selector: aiPath(hit), els: [hit] }; }
  const sv = el.closest('svg'); if (sv && el !== sv && !el.closest('#viewport')) el = sv; // an icon counts as a whole
  const node = el.closest('#note-body') ? null : el.closest('.node');
  if (node && N(node.dataset.id)) {
    const n = N(node.dataset.id), title = firstLine(n.text) || '(untitled)';
    for (const [sel, part, short] of NOTE_PARTS) { const p = el.closest(sel); if (p && node.contains(p)) return { kind: 'note', ids: [n.id], part, label: `${short} of “${title}”`, selector: aiPath(p), html: aiHtml(p), els: [p] }; }
    aiWordRect = null; const word = aiWord(x, y);
    return { kind: 'note', ids: [n.id], part: word ? `the word “${word}” in its title` : 'the note itself', word, rect: word ? aiWordRect : null, label: word ? `“${word}” in “${title}”` : 'Note: ' + title, selector: aiPath(el), els: word ? [] : [node] };
  }
  const nb = el.closest('#note-body');
  if (nb && bodyFor && N(bodyFor)) {
    aiWordRect = null; const title = firstLine(N(bodyFor).text) || '(untitled)', img = el.closest('.thumb'), word = img ? '' : aiWord(x, y);
    return { kind: 'note', ids: [bodyFor], part: img ? 'an image in its description' : word ? `the word “${word}” in its description` : 'its description', word, label: img ? `Image in the description of “${title}”` : word ? `“${word}” in the description of “${title}”` : `Description of “${title}”`, selector: aiPath(img || el), rect: word ? aiWordRect : null, els: word ? [] : [img || nb] };
  }
  // section frames let clicks through, so find one by where the pointer is
  for (const [sid, sel] of Object.entries(secEls)) {
    const b = sel.getBoundingClientRect(), s = doc.sections[sid];
    if (s && el.closest('#viewport') && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) { const ids = all().filter(n => effSec(n) === sid).map(n => n.id); return { kind: 'section', section: s.label || '', ids, label: 'Section: ' + (s.label || '(unnamed)'), els: [sel] }; }
  }
  if (!el.closest('#viewport') && el !== document.body && el !== document.documentElement) {
    // the smallest thing under the pointer, named with the control or panel it belongs to
    const ctl = el.closest('button, [data-act], [data-md], .pm-item, .ai-row, .md-row, .sh-row, .mc, .th, .ft, label');
    const panel = el.closest('#titlebar, #project-menu, #share-menu, #mods-menu, #ai-menu, #theme-menu, #note-body, #help, #node-toolbar, #jump-menu, #toast, #find');
    const own = aiLabel(el), where = [ctl && ctl !== el ? aiLabel(ctl) : '', panel ? (panel.id || '').replace(/-/g, ' ') : ''].filter(Boolean).join(', in ');
    const what = (el.tagName === 'svg' ? 'the icon' : `“${own}”`) + (where ? ` (in ${where})` : '');
    return { kind: 'interface', label: 'Interface: ' + (el.tagName === 'svg' ? 'icon' + (ctl ? ' of ' + aiLabel(ctl) : '') : own), what, selector: aiPath(el), html: aiHtml(el) + (ctl && ctl !== el ? ' — inside: ' + aiHtml(ctl) : ''), els: [el] };
  }
  const w = toWorld(x, y);
  return { kind: 'canvas', label: 'Empty canvas', at: { x: Math.round(w.x), y: Math.round(w.y) }, els: [] };
}
function aiDescribeArea(r) {
  const hit = all().filter(n => { const el = els[n.id]; if (!el || el.classList.contains('zhide')) return false; const b = el.getBoundingClientRect(); return b.width && b.left < r.x + r.w && b.right > r.x && b.top < r.y + r.h && b.bottom > r.y; });
  if (!hit.length) { // an area of the interface: say which panel, and what the area shows
    const mid = document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2), panel = mid && !mid.closest('#viewport') && mid.closest('#project-menu, #share-menu, #mods-menu, #ai-menu, #note-body, #help, #titlebar, #node-toolbar, #jump-menu');
    if (panel) {
      const inside = [...panel.querySelectorAll('*')].filter(c => { if (c.children.length && ![...c.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return false; const b = c.getBoundingClientRect(); return b.width && b.left < r.x + r.w && b.right > r.x && b.top < r.y + r.h && b.bottom > r.y; });
      const words = [...new Set(inside.map(c => c.innerText.replace(/[›\s]+/g, ' ').trim().slice(0, 80)).filter(Boolean))].join(' | ').slice(0, 300);
      return { kind: 'interface', label: 'Interface: ' + (words.slice(0, 44) || aiLabel(panel)), what: `an area of ${aiSelector(panel)} showing: ${words}`, selector: aiSelector(panel), html: panel.innerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/\s+/g, ' ').slice(0, 600), els: [] };
    }
    const w = toWorld(r.x + r.w / 2, r.y + r.h / 2); return { kind: 'canvas', label: 'Empty area', at: { x: Math.round(w.x), y: Math.round(w.y) }, els: [] }; }
  return { kind: 'notes', ids: hit.map(n => n.id), label: hit.length === 1 ? 'Note: ' + firstLine(hit[0].text) : `${hit.length} notes`, els: hit.map(n => els[n.id]) };
}
function openAiBox(target, x, y) {
  closeAiBox(); aiTarget = target;
  for (const el of target.els) el.classList.add('ai-pick'); showMark(target.rect, true);
  aiBox.querySelector('.ab-target').textContent = target.label;
  aiBox.querySelector('.ab-hint').textContent = `Enter to send to ${aiAgentName()} · Esc to cancel`; aiInput.placeholder = `Tell ${aiAgentName()} what to do...`;
  aiBox.hidden = false; aiInput.value = '';
  aiBox.style.left = Math.max(8, Math.min(x + 12, innerWidth - aiBox.offsetWidth - 8)) + 'px';
  aiBox.style.top = Math.max(50, Math.min(y + 12, innerHeight - aiBox.offsetHeight - 8)) + 'px';
  aiInput.focus();
}
const aiOwn = e => e.target.closest && e.target.closest('#ai-box, #ai-tasks, #btn-ai, #btn-mods, #btn-share, #project-btn, #btn-theme'); // these still open their menus, so a menu can be pointed at
window.addEventListener('pointerdown', e => {
  if (!aiMode || aiOwn(e)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.button !== 0) return;
  aiDrag = { x: e.clientX, y: e.clientY, moved: false };
}, true);
let aiHoverEls = [], aiHoverRaf = 0;
function aiHover(x, y) { // show exactly what a click would pick
  for (const el of aiHoverEls) el.classList.remove('ai-hover'); aiHoverEls = [];
  if (!aiMode || aiDrag || !aiBox.hidden || x < 0) { if (aiBox.hidden) showMark(null); return; }
  const t = aiDescribe(x, y); if (t) { aiHoverEls = t.els; for (const el of aiHoverEls) el.classList.add('ai-hover'); } showMark(t && t.rect, false);
}
window.addEventListener('pointermove', e => {
  if (!aiMode) return;
  if (!aiOwn(e)) e.stopImmediatePropagation();
  if (!aiDrag) { const x = aiOwn(e) ? -1 : e.clientX, y = e.clientY; cancelAnimationFrame(aiHoverRaf); aiHoverRaf = requestAnimationFrame(() => aiHover(x, y)); return; }
  if (!aiDrag.moved && Math.hypot(e.clientX - aiDrag.x, e.clientY - aiDrag.y) < 6) return;
  if (!aiDrag.moved) { aiDrag.moved = true; closeAiBox(); }
  const x = Math.min(aiDrag.x, e.clientX), y = Math.min(aiDrag.y, e.clientY), w = Math.abs(e.clientX - aiDrag.x), h = Math.abs(e.clientY - aiDrag.y);
  Object.assign(aiRect.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' }); aiRect.hidden = false; aiDrag.r = { x, y, w, h };
}, true);
window.addEventListener('pointerup', e => {
  if (!aiMode) return;
  if (!aiOwn(e)) e.stopImmediatePropagation();
  const d = aiDrag; aiDrag = null; if (!d) return;
  if (d.moved && d.r) { const t = aiDescribeArea(d.r); openAiBox(t, d.r.x + d.r.w, d.r.y + d.r.h); aiRect.hidden = false; }
  else { const t = aiDescribe(e.clientX, e.clientY); if (t) openAiBox(t, e.clientX, e.clientY); }
}, true);
for (const ev of ['click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'auxclick']) window.addEventListener(ev, e => { if (aiMode && !aiOwn(e)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
window.addEventListener('keydown', e => {
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyA') { e.preventDefault(); e.stopImmediatePropagation(); setAiMode(!aiMode); return; }
  if (!aiMode) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (!aiBox.hidden) closeAiBox(); else setAiMode(false); return; }
  if (e.target === aiInput) { e.stopImmediatePropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAi(); } }
}, true);
function aiTask(text) {
  const el = document.createElement('div'); el.className = 'ai-task working';
  el.innerHTML = '<span class="spin"></span><div class="at-text"></div><button class="at-x">×</button>';
  el.querySelector('.at-text').textContent = text; el.querySelector('.at-x').onclick = () => el.remove();
  aiTasks.appendChild(el);
  return {
    wait(msg) { el.className = 'ai-task waiting'; el.querySelector('.at-text').textContent = text + '\n' + msg; },
    done(msg, err) { el.className = 'ai-task' + (err ? ' err' : ''); el.querySelector('.at-text').textContent = msg; if (!err) setTimeout(() => el.remove(), 20000); } };
}
// the AI saved a mod: switch it on and (re)start it
async function aiModSaved(id, project) {
  refreshMods(); const meta = modMeta(id); if (!meta) return;
  if (meta.kind === 'content' && project === currentId) { doc.mods = [...new Set([...(doc.mods || []), id])]; scheduleSave(); }
  else if (project) { const l = settings.mods.projects[project] = settings.mods.projects[project] || []; if (!l.includes(id)) l.push(id); }
  else if (!settings.mods.global.includes(id)) settings.mods.global.push(id);
  saveModSettings();
  if (modLive.has(id)) stopMod(id);
  await syncMods(); render(); relayout();
  toast(`Mod “${meta.name}” is on`, 'Turn off', () => { settings.mods.global = settings.mods.global.filter(x => x !== id); for (const k in settings.mods.projects) settings.mods.projects[k] = settings.mods.projects[k].filter(x => x !== id); if (doc.mods) doc.mods = doc.mods.filter(x => x !== id); saveModSettings(); scheduleSave(); syncMods(); });
}
const aiWaiting = {};
function aiRequestDone(id, summary) { const t = aiWaiting[id]; delete aiWaiting[id]; if (t) t.done(summary); else toast(summary); }
async function sendAi() {
  const text = aiInput.value.trim(), t = aiTarget; if (!text || !t) return;
  closeAiBox();
  if (!host || !host.aiAsk) { toast('AI mode works in the desktop app'); return; }
  flushForShare();
  const task = aiTask(`${aiAgentName()}: ${text}`);
  const target = { kind: t.kind, part: t.part, word: t.word, section: t.section, what: t.what, selector: t.selector, html: t.html, at: t.at, notes: (t.ids || []).slice(0, 80).map(id => ({ id, title: firstLine(N(id).text) })) };
  const r = await host.aiAsk({ project: currentId, projectName: doc.name || currentId, target, instruction: text });
  if (r.queued) { task.wait(r.ok); aiWaiting[r.queued] = task; return; }
  task.done(r.error || r.ok || 'Done', !!r.error);
}

/* ---------------- boot ---------------- */

buildToolbar();
setTheme(uiTheme, false);
{
  const list = store.list();
  let id = settings.lastProject && list.some(p => p.id === settings.lastProject) ? settings.lastProject : list[0] && list[0].id;
  if (!id) id = store.create('My first project');
  openProject(id);
}
