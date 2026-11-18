// Live sync: a project kept the same on every computer that has its link, as people work. No sign-in: the link holds a
// long secret room name, and only someone with it can read or change the project. Runs in the main process.
// The server (Supabase) keeps one copy of each room and a version number. Changes go up as whole documents and are
// combined note by note with merge3 (merge.js) when two people changed it at the same time. Pictures travel separately.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { merge3 } = require('./merge');

const LOCAL_ONLY = ['view', 'viewSet', 'updated', 'needsTidy']; // per-person state: never sent
const PREFIX = 'mindview-live:';
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = v => JSON.parse(JSON.stringify(v));
const shareable = doc => { const d = clone(doc); for (const k of LOCAL_ONLY) delete d[k]; return d; };
const usedImages = doc => { const s = new Set(); for (const n of Object.values(doc.nodes || {})) for (const k of ['images', 'bodyImages']) for (const i of n[k] || []) if (/^[a-z0-9]+\.[a-z0-9]+$/i.test(i)) s.add(i); return s; };
const roomOf = link => { const m = /(?:mindview-live:)?([A-Za-z0-9_-]{24,64})\s*$/.exec(String(link || '').trim()); return m ? m[1] : null; };

function createLive({ dataDir, projectsDir, imagesDir, url, key, page, onChange = () => {} }) {
  const liveDir = path.join(dataDir, 'live');
  const stateFile = id => path.join(liveDir, id + '.json');
  const projFile = id => path.join(projectsDir, id + '.json');
  const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const writeAtomic = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, text); fs.renameSync(t, f); };
  const state = {}; // id -> { room, version, base, images: [] }
  const conn = {}; // id -> 'on' | 'off'
  const chans = {};
  const timers = {};
  const queues = {};
  const loadState = id => (state[id] = state[id] || readJSON(stateFile(id), null));
  const saveState = id => writeAtomic(stateFile(id), JSON.stringify(state[id]));
  const isLive = id => !!loadState(id);

  /* ---- the server ---- */
  async function rpc(fn, args) {
    const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    const text = await r.text();
    if (!r.ok) { const e = new Error(r.status >= 500 || r.status === 0 ? 'The live server is not answering. Changes stay here and go out when it is back.' : 'The live server refused: ' + text.slice(0, 200)); e.status = r.status; throw e; }
    return text ? JSON.parse(text) : null;
  }
  let rt = null;
  function client() {
    if (rt) return rt;
    const { RealtimeClient } = require('@supabase/realtime-js');
    rt = new RealtimeClient(url.replace(/^http/, 'ws') + '/realtime/v1', { params: { apikey: key } });
    return rt;
  }
  function listen(id) {
    const st = loadState(id); if (!st || chans[id]) return;
    const ch = client().channel('mv-' + st.room, { config: { broadcast: { self: false } } });
    ch.on('broadcast', { event: 'v' }, ({ payload }) => { if (!payload || !(payload.v > (state[id] || {}).version)) return; pull(id); });
    ch.subscribe(s => {
      const was = conn[id];
      conn[id] = s === 'SUBSCRIBED' ? 'on' : 'off';
      if (s === 'SUBSCRIBED') { pull(id); push(id); } // after a gap: catch up both ways
      if (was !== conn[id]) onChange(id);
    });
    chans[id] = ch;
  }
  function unlisten(id) { const ch = chans[id]; delete chans[id]; delete conn[id]; if (ch) client().removeChannel(ch).catch(() => {}); }

  // one thing at a time per project
  const serial = (id, fn) => (queues[id] = (queues[id] || Promise.resolve()).then(fn).catch(e => { console.error('live', id, e.message); }));

  /* ---- pictures: names are unique, so each one is sent or fetched once ---- */
  async function syncImages(id, doc) {
    const st = state[id]; if (!st) return;
    const want = [...usedImages(doc)].filter(n => !(st.images || []).includes(n));
    if (!want.length) return;
    const there = new Set(await rpc('live_image_names', { p_room: st.room }) || []);
    for (const name of want) {
      const local = path.join(imagesDir, name);
      if (there.has(name)) {
        if (!fs.existsSync(local)) { const b64 = await rpc('live_get_image', { p_room: st.room, p_name: name }); if (b64) { fs.mkdirSync(imagesDir, { recursive: true }); fs.writeFileSync(local, Buffer.from(b64, 'base64')); } }
      } else if (fs.existsSync(local)) {
        const bytes = fs.readFileSync(local);
        if (bytes.length > 8 * 1024 * 1024) continue; // too big to travel
        await rpc('live_put_image', { p_room: st.room, p_name: name, p_data: bytes.toString('base64') });
      } else continue; // nobody has it yet: try again next time
      st.images = [...(st.images || []), name];
    }
    saveState(id);
  }

  /* ---- bring in what the others did ---- */
  // the open project is combined with what is on screen; any other one with its file
  async function integrate(id, version, theirs) {
    const st = state[id];
    let mineText = null, open = false;
    for (let tries = 0; ; tries++) {
      const r = await page(`liveTake(${JSON.stringify(id)})`).catch(() => null);
      if (r === 'closed' || r == null) break; // not on screen: use the file
      if (r !== 'busy') { mineText = r; open = true; break; }
      await new Promise(f => setTimeout(f, Math.min(2000, 300 + tries * 200))); // typing or dragging: wait for it to end
    }
    const local = mineText ? JSON.parse(mineText) : readJSON(projFile(id), {});
    const mine = shareable(local);
    const merged = eq(mine, st.base) ? clone(theirs) : merge3(st.base, mine, theirs).doc;
    const out = { ...merged };
    for (const k of LOCAL_ONLY) if (local[k] !== undefined) out[k] = local[k];
    out.version = out.version || 1; out.view = out.view || { x: 0, y: 0, k: 1 };
    const text = JSON.stringify(out, null, 1);
    writeAtomic(projFile(id), text);
    st.base = clone(theirs); st.version = version; saveState(id);
    if (open) await page(`liveApply(${JSON.stringify(id)}, ${JSON.stringify(text)})`).catch(() => {});
    syncImages(id, out).catch(e => console.error('live images', e.message));
    return !eq(shareable(out), st.base); // something of mine still has to go up
  }
  function pull(id) {
    return serial(id, async () => {
      const st = loadState(id); if (!st) return;
      const r = await rpc('live_get', { p_room: st.room });
      if (!r || r.missing) return;
      if (r.version > st.version && await integrate(id, r.version, r.doc)) schedule(id, 50);
    });
  }

  /* ---- send what changed here ---- */
  function push(id) {
    return serial(id, async () => {
      for (let round = 0; round < 5; round++) {
        const st = loadState(id); if (!st) return;
        const local = readJSON(projFile(id), null); if (!local) return;
        const mine = shareable(local);
        if (eq(mine, st.base)) return;
        const r = await rpc('live_put', { p_room: st.room, p_base: st.version, p_doc: mine });
        if (r.ok) {
          st.base = mine; st.version = r.version; saveState(id);
          if (chans[id]) chans[id].send({ type: 'broadcast', event: 'v', payload: { v: r.version } }).catch(() => {});
          syncImages(id, mine).catch(e => console.error('live images', e.message));
          return;
        }
        if (r.missing) return;
        await integrate(id, r.version, r.doc); // someone was faster: combine, then send again
      }
    });
  }
  function schedule(id, ms = 150) { if (!isLive(id)) return; clearTimeout(timers[id]); timers[id] = setTimeout(() => push(id), ms); }

  /* ---- what the Share menu does ---- */
  async function start(id) {
    if (isLive(id)) return { link: PREFIX + state[id].room };
    const doc = readJSON(projFile(id), null); if (!doc) throw new Error('This project has no saved file yet.');
    const room = crypto.randomBytes(24).toString('base64url'); // 32 characters nobody can guess
    const mine = shareable(doc);
    const r = await rpc('live_put', { p_room: room, p_base: 0, p_doc: mine });
    if (!r.ok) throw new Error('Could not start. Try again.');
    state[id] = { room, version: r.version, base: mine, images: [] }; saveState(id);
    listen(id); syncImages(id, mine).catch(e => console.error('live images', e.message));
    return { link: PREFIX + room };
  }
  async function join(link, makeId) {
    const room = roomOf(link); if (!room) throw new Error('That is not a live link.');
    for (const f of fs.existsSync(liveDir) ? fs.readdirSync(liveDir) : []) {
      const id = f.replace(/\.json$/, '');
      if (loadState(id) && state[id].room === room && fs.existsSync(projFile(id))) return { id, already: true };
    }
    const r = await rpc('live_get', { p_room: room });
    if (!r || r.missing) throw new Error('Nothing found at that link. It may have been stopped.');
    const id = makeId(r.doc.name || 'live');
    const doc = { ...r.doc, version: r.doc.version || 1, view: { x: 0, y: 0, k: 1 }, updated: Date.now() };
    writeAtomic(projFile(id), JSON.stringify(doc, null, 1));
    state[id] = { room, version: r.version, base: clone(r.doc), images: [] }; saveState(id);
    await syncImages(id, r.doc).catch(e => console.error('live images', e.message));
    listen(id);
    return { id, name: r.doc.name };
  }
  function status(id) { const st = loadState(id); return st ? { live: true, link: PREFIX + st.room, connected: conn[id] === 'on' } : { live: false }; }
  // stop on this computer: the notes stay, the others keep the room
  function stop(id) { unlisten(id); clearTimeout(timers[id]); delete state[id]; fs.rmSync(stateFile(id), { force: true }); return true; }
  // for everyone: the room and its pictures are deleted on the server
  async function end(id) { const st = loadState(id); if (!st) return true; await rpc('live_delete', { p_room: st.room }); stop(id); return true; }
  function startAll() { for (const f of fs.existsSync(liveDir) ? fs.readdirSync(liveDir) : []) if (f.endsWith('.json')) { const id = f.slice(0, -5); if (fs.existsSync(projFile(id)) && loadState(id)) listen(id); } }
  function forgetProject(id) { if (isLive(id)) stop(id); }

  return { start, join, status, stop, end, startAll, saved: id => schedule(id), pull, forgetProject, isLive };
}

module.exports = { createLive, roomOf };
