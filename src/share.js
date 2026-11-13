// Sharing a project through Git (GitHub). Runs in the main process; no Git install is needed.
// A shared project keeps a working copy in <data>/repos/<id>/ holding project.json and images/.
const path = require('path');
const fs = require('fs');
const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');

const FILE = 'project.json';
const BRANCH = 'main';
const LOCAL_ONLY = ['view', 'viewSet', 'updated', 'needsTidy']; // per-person state: never shared

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

function createShare({ dataDir, projectsDir, imagesDir, getToken, modFile = () => null, apiBase = 'https://api.github.com', loginBase = 'https://github.com' }) {
  const reposDir = path.join(dataDir, 'repos');
  const dirOf = id => path.join(reposDir, id);
  const projFile = id => path.join(projectsDir, id + '.json');
  const linked = id => fs.existsSync(path.join(dirOf(id), '.git'));
  const onAuth = () => { const t = getToken(); return t ? { username: t, password: 'x-oauth-basic' } : {}; };
  const onAuthFailure = () => { const e = new Error('GitHub refused the sign-in. Sign in again, and check that you were invited to this project.'); e.code = 'AUTH'; throw e; };
  const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

  /* ---- GitHub API ---- */
  async function api(method, url, body) {
    const token = getToken();
    if (!token) { const e = new Error('Sign in to GitHub first.'); e.code = 'AUTH'; throw e; }
    const r = await fetch(url.startsWith('http') ? url : apiBase + url, {
      method,
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Mindview', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (!r.ok) {
      const detail = data && (data.errors && data.errors[0] && data.errors[0].message || data.message);
      const e = new Error(r.status === 401 ? 'GitHub sign-in expired. Sign in again.' : detail || `GitHub answered ${r.status}`);
      e.status = r.status; if (r.status === 401) e.code = 'AUTH';
      throw e;
    }
    return data;
  }
  let me = null;
  async function whoami(fresh) {
    if (!getToken()) { me = null; return null; }
    if (me && !fresh) return me;
    const u = await api('GET', '/user');
    me = { login: u.login, name: u.name || u.login, id: u.id, avatar: u.avatar_url };
    return me;
  }
  const author = async () => { const u = await whoami(); return { name: u.name, email: `${u.id}+${u.login}@users.noreply.github.com` }; };

  // sign in with a code typed at github.com/login/device (needs the client id of a GitHub OAuth app with device flow on)
  async function form(url, params) {
    const r = await fetch(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mindview' }, body: new URLSearchParams(params).toString() });
    return r.json();
  }
  async function deviceStart(clientId) {
    const d = await form(loginBase + '/login/device/code', { client_id: clientId, scope: 'repo delete_repo' });
    if (!d.device_code) throw new Error(d.error_description || 'GitHub did not accept this app id. Check the client ID and that "Device flow" is enabled for the app.');
    return { deviceCode: d.device_code, userCode: d.user_code, url: d.verification_uri, interval: d.interval || 5, expiresIn: d.expires_in || 900 };
  }
  async function devicePoll(clientId, deviceCode) {
    const d = await form(loginBase + '/login/oauth/access_token', { client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (d.access_token) return { token: d.access_token };
    if (d.error === 'authorization_pending') return { pending: true };
    if (d.error === 'slow_down') return { pending: true, slow: true };
    throw new Error(d.error === 'expired_token' ? 'The code expired. Start the sign-in again.' : d.error === 'access_denied' ? 'The sign-in was cancelled.' : d.error_description || 'Sign-in failed.');
  }

  /* ---- between the app's own project file and the shared working copy ---- */
  const usedImages = doc => { const s = new Set(); for (const n of Object.values(doc.nodes || {})) for (const k of ['images', 'bodyImages']) for (const i of n[k] || []) if (/^[a-z0-9]+\.[a-z0-9]+$/i.test(i)) s.add(i); return s; };
  function shareable(doc) { const d = clone(doc); for (const k of LOCAL_ONLY) delete d[k]; return d; }
  const stringify = doc => JSON.stringify(doc, null, 1) + '\n';
  function exportToRepo(id) {
    const doc = readJSON(projFile(id), null); if (!doc) throw new Error('This project has no saved file yet.');
    const dir = dirOf(id);
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, FILE), stringify(shareable(doc)));
    // the content mods this project needs travel with it (people are asked before one is installed)
    for (const r of Array.isArray(doc.requires) ? doc.requires : []) {
      const src = r && modFile(r.id); if (!src) continue;
      fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
      const dst = path.join(dir, 'mods', r.id + '.js'), text = fs.readFileSync(src);
      if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(text)) fs.writeFileSync(dst, text);
    }
    for (const img of usedImages(doc)) {
      const src = path.join(imagesDir, img), dst = path.join(dir, 'images', img);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    }
  }
  function importFromRepo(id) {
    const dir = dirOf(id);
    const shared = readJSON(path.join(dir, FILE), null); if (!shared) throw new Error('That link is not a Mindview project.');
    const local = readJSON(projFile(id), {});
    const doc = { ...shared };
    for (const k of LOCAL_ONLY) if (local[k] !== undefined) doc[k] = local[k];
    doc.version = doc.version || 1; doc.view = doc.view || { x: 0, y: 0, k: 1 };
    doc.updated = Date.now();
    fs.mkdirSync(projectsDir, { recursive: true });
    const tmp = projFile(id) + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(doc, null, 1)); fs.renameSync(tmp, projFile(id));
    const imgs = path.join(dir, 'images');
    if (fs.existsSync(imgs)) { fs.mkdirSync(imagesDir, { recursive: true }); for (const f of fs.readdirSync(imgs)) { const dst = path.join(imagesDir, f); if (!fs.existsSync(dst)) fs.copyFileSync(path.join(imgs, f), dst); } }
    return doc;
  }
  async function stageAll(dir) {
    let changed = false;
    for (const [file, head, work, stage] of await git.statusMatrix({ fs, dir })) {
      if (work === 0) { await git.remove({ fs, dir, filepath: file }); changed = true; }
      else if (work !== head || stage !== work) { await git.add({ fs, dir, filepath: file }); if (work !== head) changed = true; }
    }
    return changed;
  }
  const resolve = async (dir, ref) => { try { return await git.resolveRef({ fs, dir, ref }); } catch { return null; } };
  const blobJSON = async (dir, oid) => { if (!oid) return null; try { const { blob } = await git.readBlob({ fs, dir, oid, filepath: FILE }); return JSON.parse(Buffer.from(blob).toString('utf8')); } catch { return null; } };
  const remoteUrl = async dir => { try { return await git.getConfig({ fs, dir, path: 'remote.origin.url' }); } catch { return null; } };
  const repoSlug = url => { const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url || ''); return m ? { owner: m[1], repo: m[2] } : null; };

  /* ---- what the Share menu shows ---- */
  async function status(id) {
    const user = await whoami().catch(() => null);
    if (!linked(id)) return { signedIn: !!getToken(), user, linked: false };
    const dir = dirOf(id), url = await remoteUrl(dir);
    const head = await blobJSON(dir, await resolve(dir, 'HEAD'));
    const local = readJSON(projFile(id), null);
    const dirty = !!local && !eq(shareable(local), head);
    return { signedIn: !!getToken(), user, linked: true, url: (url || '').replace(/\.git$/, ''), slug: repoSlug(url), dirty };
  }

  /* ---- publish this project as a new private repository of mine ---- */
  async function publish(id, { name, isPrivate = true }) {
    if (linked(id)) throw new Error('This project is already shared.');
    const u = await whoami();
    const repoName = String(name || id).trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || id;
    let repo;
    try { repo = await api('POST', '/user/repos', { name: repoName, private: isPrivate, description: 'Mindview project', auto_init: false }); }
    catch (e) { if (e.status === 422) throw new Error(`You already shared something called “${repoName}”. Pick another name.`); throw e; }
    const dir = dirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    await git.init({ fs, dir, defaultBranch: BRANCH });
    await git.addRemote({ fs, dir, remote: 'origin', url: repo.clone_url, force: true });
    exportToRepo(id);
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name || id}\n\nA [Mindview](https://github.com/${u.login}/${repoName}) project. Open it from Mindview: Share > Open a shared project > \`${u.login}/${repoName}\`.\n`);
    await stageAll(dir);
    await git.commit({ fs, dir, message: 'Start sharing this project', author: await author() });
    await git.push({ fs, http, dir, remote: 'origin', ref: BRANCH, onAuth, onAuthFailure });
    return { url: repo.html_url };
  }

  /* ---- open a project someone shared with me ---- */
  async function openShared(spec, makeId) {
    let s = String(spec || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
    const m = /^(?:https?:\/\/[^/]+\/)?([^/\s]+)\/([^/\s]+)$/.exec(s);
    if (!m) throw new Error('Paste the whole link your friend sent you. It starts with github.com.');
    const owner = m[1], repo = m[2];
    const url = /^https?:\/\//.test(s) ? s : `https://github.com/${owner}/${repo}`;
    if (apiBase.includes('github.com')) { // an invitation to it may still be waiting: accept it
      try { for (const inv of await api('GET', '/user/repository_invitations')) if (inv.repository && inv.repository.full_name.toLowerCase() === `${owner}/${repo}`.toLowerCase()) await api('PATCH', '/user/repository_invitations/' + inv.id); } catch (e) { if (e.code === 'AUTH') throw e; }
    }
    for (const d of fs.existsSync(reposDir) ? fs.readdirSync(reposDir) : []) {
      const sl = repoSlug(await remoteUrl(path.join(reposDir, d)));
      if (sl && sl.owner.toLowerCase() === owner.toLowerCase() && sl.repo.toLowerCase() === repo.toLowerCase() && fs.existsSync(projFile(d))) return { id: d, already: true };
    }
    const id = makeId(repo), dir = dirOf(id);
    try {
      fs.mkdirSync(dir, { recursive: true });
      await git.clone({ fs, http, dir, url, ref: BRANCH, singleBranch: true, onAuth, onAuthFailure });
      const doc = importFromRepo(id);
      return { id, name: doc.name };
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      if (e.code === 'NotFoundError' || (e.data && e.data.statusCode === 404)) throw new Error('Nothing found at that link, or you have not been invited to it yet.');
      throw e;
    }
  }

  /* ---- sync: save my changes as a version, bring in the others', send mine ---- */
  async function sync(id, message) {
    if (!linked(id)) throw new Error('This project is not shared yet.');
    const dir = dirOf(id), who = await author();
    exportToRepo(id);
    let committed = false;
    if (await stageAll(dir)) { await git.commit({ fs, dir, message: (message || '').trim() || 'Update notes', author: who }); committed = true; }
    const before = await resolve(dir, 'HEAD');
    await git.fetch({ fs, http, dir, remote: 'origin', ref: BRANCH, singleBranch: true, onAuth, onAuthFailure });
    const theirs = await resolve(dir, `refs/remotes/origin/${BRANCH}`);
    let incoming = 0, conflicts = [];
    if (theirs && theirs !== before) {
      const bases = await git.findMergeBase({ fs, dir, oids: [before, theirs] });
      const base = bases[0] || null;
      if (base === theirs) { /* nothing new from the others */ }
      else {
        incoming = (await git.log({ fs, dir, ref: theirs })).findIndex(c => c.oid === base); if (incoming < 0) incoming = 1;
        if (base === before) { // I had nothing new: just move up to their version
          await git.writeRef({ fs, dir, ref: `refs/heads/${BRANCH}`, value: theirs, force: true });
          await git.checkout({ fs, dir, ref: BRANCH, force: true });
        } else { // both sides changed: combine them note by note
          const m = merge3(await blobJSON(dir, base), await blobJSON(dir, before) || {}, await blobJSON(dir, theirs) || {});
          conflicts = m.conflicts;
          // their pictures come along
          try { for (const f of (await git.readTree({ fs, dir, oid: theirs, filepath: 'images' })).tree) { const dst = path.join(dir, 'images', f.path); if (!fs.existsSync(dst)) { const { blob } = await git.readBlob({ fs, dir, oid: f.oid }); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, Buffer.from(blob)); } } } catch { /* no images folder */ }
          fs.writeFileSync(path.join(dir, FILE), stringify(m.doc));
          await stageAll(dir);
          await git.commit({ fs, dir, message: 'Combine changes', author: who, parent: [before, theirs] });
        }
      }
    }
    const after = await resolve(dir, 'HEAD');
    let pushed = false;
    if (after !== theirs) {
      try { await git.push({ fs, http, dir, remote: 'origin', ref: BRANCH, onAuth, onAuthFailure }); pushed = true; }
      catch (e) {
        if (e.code === 'PushRejectedError') throw new Error('Someone synced at the same moment. Press Sync again.');
        if (e.data && e.data.statusCode === 403) throw new Error('You can read this project but not change it. Ask its owner to invite you.');
        throw e;
      }
    }
    if (after !== before) importFromRepo(id);
    return { committed, incoming, pushed, changed: after !== before, conflicts };
  }

  /* ---- history ---- */
  async function history(id) {
    if (!linked(id)) return [];
    const dir = dirOf(id);
    try { const seen = new Set(); return (await git.log({ fs, dir, depth: 80 })).filter(c => !seen.has(c.oid) && seen.add(c.oid)).map(c => ({ oid: c.oid, message: c.commit.message.trim(), author: c.commit.author.name, time: c.commit.author.timestamp * 1000, merge: c.commit.parent.length > 1 })).sort((a, b) => b.time - a.time); }
    catch { return []; }
  }
  // bring an old version back as my current notes (it becomes a normal change, shared on the next sync)
  async function restore(id, oid) {
    const dir = dirOf(id), old = await blobJSON(dir, oid);
    if (!old) throw new Error('That version could not be read.');
    const local = readJSON(projFile(id), {});
    const doc = { ...old }; for (const k of LOCAL_ONLY) if (local[k] !== undefined) doc[k] = local[k];
    doc.updated = Date.now();
    fs.writeFileSync(projFile(id), JSON.stringify(doc, null, 1));
    return true;
  }

  /* ---- people ---- */
  async function invite(id, username) {
    const sl = repoSlug(await remoteUrl(dirOf(id))); if (!sl) throw new Error('This project is not shared yet.');
    const name = String(username || '').trim().replace(/^@/, '');
    if (!/^[A-Za-z0-9-]{1,39}$/.test(name)) throw new Error('That is not a GitHub username.');
    try { await api('PUT', `/repos/${sl.owner}/${sl.repo}/collaborators/${name}`, { permission: 'push' }); }
    catch (e) { if (e.status === 404) throw new Error(`No GitHub user called “${name}”, or only the owner of this project can invite.`); if (e.status === 403) throw new Error('Only the owner of this project can invite people.'); throw e; }
    return { spec: `${sl.owner}/${sl.repo}` };
  }
  async function people(id) {
    const sl = repoSlug(await remoteUrl(dirOf(id))); if (!sl) return [];
    try { return (await api('GET', `/repos/${sl.owner}/${sl.repo}/collaborators?per_page=100`)).map(u => u.login); } catch { return []; }
  }
  // stop sharing on this computer (the repository on GitHub stays as it is)
  function unlink(id) { fs.rmSync(dirOf(id), { recursive: true, force: true }); return true; }

  // delete the shared copy on GitHub for everyone, then stop sharing here (the notes on this computer stay)
  async function remove(id) {
    const sl = repoSlug(await remoteUrl(dirOf(id))); if (!sl) throw new Error('This project is not shared yet.');
    const u = await whoami();
    if (u.login.toLowerCase() !== sl.owner.toLowerCase()) throw new Error('Only the person who shared this project can delete it from GitHub.');
    try { await api('DELETE', `/repos/${sl.owner}/${sl.repo}`); }
    catch (e) {
      if (e.status === 403) { const x = new Error('Mindview needs your permission to delete. Sign in once more, then delete again.'); x.code = 'AUTH'; throw x; }
      if (e.status !== 404) throw e; // already gone on GitHub: just stop sharing here
    }
    unlink(id);
    return { name: `${sl.owner}/${sl.repo}` };
  }

  return { status, publish, openShared, sync, history, restore, invite, people, unlink, remove, whoami, deviceStart, devicePoll, forget: () => { me = null; } };
}

module.exports = { createShare, merge3 };
