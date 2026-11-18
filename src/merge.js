// Combining two people's edits of one project, note by note and field by field (used by live sync, live.js).
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/* ---- three-way merge of two people's edits, note by note and field by field ---- */
const QUIET = new Set(['x', 'y', 'nudge', 'w', 'h', 'ox', 'oy', 'pad']); // layout: mine wins without calling it a conflict
function mergeItem(b, o, t, conflicts, label) {
  const out = {};
  for (const f of new Set([...Object.keys(o), ...Object.keys(t)])) {
    const bv = b ? b[f] : undefined, ov = o[f], tv = t[f];
    let v;
    if (eq(ov, tv)) v = ov;
    else if (eq(ov, bv)) v = tv;
    else if (eq(tv, bv)) v = ov;
    else { v = ov; if (!QUIET.has(f)) conflicts.push({ what: label(o), field: f }); }
    if (v !== undefined) out[f] = clone(v);
  }
  return out;
}
function mergeMap(b, o, t, conflicts, label) {
  b = b || {}; o = o || {}; t = t || {};
  const out = {};
  for (const k of new Set([...Object.keys(o), ...Object.keys(t)])) {
    const bv = b[k], ov = o[k], tv = t[k];
    if (ov && tv) out[k] = mergeItem(bv, ov, tv, conflicts, label);
    else if (ov) { if (!bv || !eq(ov, bv)) out[k] = clone(ov); } // they deleted it: gone, unless I changed it since
    else if (tv) { if (!bv || !eq(tv, bv)) out[k] = clone(tv); }
  }
  return out;
}
const byId = list => Object.fromEntries((list || []).map(x => [x.id, x]));
function merge3(base, ours, theirs) {
  base = base || {};
  const conflicts = [];
  const title = n => String(n.text || n.label || 'note').split('\n')[0].slice(0, 40);
  const out = {};
  for (const f of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    if (['nodes', 'sections', 'links'].includes(f)) continue;
    const bv = base[f], ov = ours[f], tv = theirs[f];
    const v = eq(ov, tv) ? ov : eq(ov, bv) ? tv : ov;
    if (v !== undefined) out[f] = clone(v);
  }
  out.nodes = mergeMap(base.nodes, ours.nodes, theirs.nodes, conflicts, title);
  out.sections = mergeMap(base.sections, ours.sections, theirs.sections, conflicts, title);
  out.links = Object.values(mergeMap(byId(base.links), byId(ours.links), byId(theirs.links), conflicts, () => 'arrow'));
  // repair anything left pointing at a note the other person deleted
  for (const n of Object.values(out.nodes)) {
    if (n.parentId && !out.nodes[n.parentId]) n.parentId = null;
    if (n.section && !out.sections[n.section]) delete n.section;
  }
  for (const s of Object.values(out.sections)) if (s.parent && !out.sections[s.parent]) s.parent = null;
  out.links = out.links.filter(L => out.nodes[L.a] && out.nodes[L.b]);
  return { doc: out, conflicts };
}

module.exports = { merge3 };
