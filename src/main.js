const { app, BrowserWindow, ipcMain, Menu, shell, screen, dialog, safeStorage, clipboard } = require('electron');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

// Where notes live: Documents\Mindview when installed, next to the project in development.
const dataDir = app.isPackaged
  ? path.join(app.getPath('documents'), 'Mindview')
  : path.resolve(__dirname, '..');
const projectsDir = path.join(dataDir, 'projects');
const backupDir = path.join(dataDir, 'backups');
const settingsFile = path.join(dataDir, 'settings.json');
const legacyBoard = path.join(dataDir, 'board.json');
const imagesDir = path.join(dataDir, 'images');

/* ---------------- helpers ---------------- */

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const validId = id => typeof id === 'string' && /^[a-z0-9-]{1,80}$/.test(id);
const projectFile = id => {
  if (!validId(id)) throw new Error('bad project id');
  return path.join(projectsDir, id + '.json');
};
function slugify(name) {
  const base = String(name || 'project').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'project';
  let id = base, i = 2;
  while (fs.existsSync(path.join(projectsDir, id + '.json'))) id = `${base}-${i++}`;
  return id;
}

/* ---------------- settings ---------------- */

let settings = readJSON(settingsFile, {});
let settingsTimer = null;
function saveSettings(now) {
  clearTimeout(settingsTimer);
  const write = () => { try { writeAtomic(settingsFile, JSON.stringify(settings, null, 1)); } catch (e) { console.error(e); } };
  if (now) write(); else settingsTimer = setTimeout(write, 400);
}

/* ---------------- projects ---------------- */

// First run of the installed app: bring over notes from the older portable copy
// (the "notes-canvas app" folder), leaving the original untouched.
function importPortableData() {
  if (!app.isPackaged) return;
  fs.mkdirSync(projectsDir, { recursive: true });
  if (settings.importedFrom || fs.readdirSync(projectsDir).some(f => f.endsWith('.json'))) return;
  const candidates = [path.resolve(path.dirname(process.execPath), '..')];
  const desktop = app.getPath('desktop');
  candidates.push(path.join(desktop, 'notes-canvas app'));
  try {
    for (const d of fs.readdirSync(desktop, { withFileTypes: true })) {
      if (d.isDirectory()) candidates.push(path.join(desktop, d.name, 'notes-canvas app'));
    }
  } catch {}
  for (const dir of candidates) {
    const proj = path.join(dir, 'projects'), board = path.join(dir, 'board.json');
    const hasProjects = fs.existsSync(proj) && fs.readdirSync(proj).some(f => f.endsWith('.json'));
    if (!hasProjects && !fs.existsSync(board)) continue;
    if (hasProjects) {
      for (const f of fs.readdirSync(proj)) {
        if (f.endsWith('.json')) fs.copyFileSync(path.join(proj, f), path.join(projectsDir, f));
      }
    } else {
      fs.copyFileSync(board, legacyBoard);
    }
    const old = readJSON(path.join(dir, 'settings.json'), null);
    if (old) settings = { ...old, ...settings };
    settings.importedFrom = dir;
    saveSettings(true);
    return;
  }
}

function migrateLegacy() {
  fs.mkdirSync(projectsDir, { recursive: true });
  if (!fs.existsSync(legacyBoard)) return;
  const d = readJSON(legacyBoard, null);
  if (!d) return;
  const id = slugify('The Phone Calls');
  d.name = d.name || 'The Phone Calls';
  if (d.theme && !settings.theme) settings.theme = d.theme;
  writeAtomic(projectFile(id), JSON.stringify(d, null, 1));
  fs.renameSync(legacyBoard, path.join(dataDir, 'board.old.json'));
  settings.lastProject = settings.lastProject || id;
  saveSettings(true);
}

function listProjects() {
  fs.mkdirSync(projectsDir, { recursive: true });
  const out = [];
  for (const f of fs.readdirSync(projectsDir)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    if (!validId(id)) continue;
    const file = path.join(projectsDir, f);
    const d = readJSON(file, null);
    if (!d) continue;
    out.push({
      id,
      name: d.name || id,
      notes: d.nodes ? Object.keys(d.nodes).length : 0,
      updated: fs.statSync(file).mtimeMs,
    });
  }
  return out.sort((a, b) => b.updated - a.updated);
}

function createProject(name) {
  fs.mkdirSync(projectsDir, { recursive: true });
  const id = slugify(name);
  const d = { version: 1, name: String(name || 'Untitled project').slice(0, 120), view: { x: 0, y: 0, k: 1 }, nodes: {} };
  writeAtomic(projectFile(id), JSON.stringify(d, null, 1));
  return id;
}

function dailyBackups() {
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    for (const p of listProjects()) {
      const target = path.join(backupDir, `${p.id}-${day}.json`);
      if (!fs.existsSync(target)) fs.copyFileSync(projectFile(p.id), target);
    }
    // keep the last 30 days per project
    const byProject = {};
    for (const f of fs.readdirSync(backupDir)) {
      const m = /^(.+)-(\d{4}-\d\d-\d\d)\.json$/.exec(f);
      if (m) (byProject[m[1]] = byProject[m[1]] || []).push(f);
    }
    for (const files of Object.values(byProject)) {
      files.sort();
      while (files.length > 30) fs.unlinkSync(path.join(backupDir, files.shift()));
    }
  } catch (e) {
    console.error('backup failed', e);
  }
}

/* ---------------- window ---------------- */

const THEMES = {
  dark: { color: '#111214', symbolColor: '#b9bcc4' },
  light: { color: '#f4f2ee', symbolColor: '#45464b' },
};

let win;

function restoredBounds() {
  const b = settings.window;
  const def = { width: 1440, height: 900 };
  if (!b || !b.width || !b.height) return def;
  // only reuse the position if it is still on a connected screen
  const visible = screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x + 80 < a.x + a.width && b.x + b.width - 80 > a.x && b.y >= a.y - 10 && b.y + 40 < a.y + a.height;
  });
  return visible ? { x: b.x, y: b.y, width: b.width, height: b.height } : { width: b.width, height: b.height };
}

function rememberBounds() {
  if (!win || win.isDestroyed()) return;
  const maximized = win.isMaximized() || win.isFullScreen();
  const b = maximized ? win.getNormalBounds() : win.getBounds();
  settings.window = { ...b, maximized };
  saveSettings();
}

function createWindow() {
  const theme = THEMES[settings.theme] || THEMES.dark;
  win = new BrowserWindow({
    ...restoredBounds(),
    minWidth: 720,
    minHeight: 480,
    backgroundColor: theme.color,
    title: 'Mindview',
    icon: path.join(__dirname, 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...theme, height: 44 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.once('ready-to-show', () => {
    if (settings.window && settings.window.maximized) win.maximize();
    win.show();
  });
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, rememberBounds);
  win.on('close', () => { rememberBounds(); saveSettings(true); });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('will-navigate', e => e.preventDefault()); // a file dropped outside a note must not replace the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ---------------- IPC ---------------- */

ipcMain.on('projects:list', e => { e.returnValue = listProjects(); });
ipcMain.on('project:load', (e, id) => {
  try { e.returnValue = fs.readFileSync(projectFile(id), 'utf8'); } catch { e.returnValue = null; }
});
ipcMain.handle('project:save', (_e, id, text) => { writeAtomic(projectFile(id), text); return true; });
ipcMain.on('project:saveSync', (e, id, text) => {
  try { writeAtomic(projectFile(id), text); e.returnValue = true; } catch { e.returnValue = false; }
});
ipcMain.on('project:create', (e, name) => { e.returnValue = createProject(name); });
ipcMain.on('project:delete', (e, id) => {
  try {
    // never truly lost: it moves into backups\deleted
    const dir = path.join(backupDir, 'deleted');
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(projectFile(id), path.join(dir, `${id}-${Date.now()}.json`));
    e.returnValue = true;
  } catch { e.returnValue = false; }
});
ipcMain.on('settings:get', e => { e.returnValue = settings; });
ipcMain.on('settings:set', (_e, patch) => { Object.assign(settings, patch); saveSettings(); });
ipcMain.on('data:path', e => { e.returnValue = dataDir; });
ipcMain.on('theme:set', (_e, name) => {
  const t = THEMES[name] || THEMES.dark;
  try { win.setTitleBarOverlay({ ...t, height: 44 }); } catch {}
  win.setBackgroundColor(t.color);
});
ipcMain.on('title:set', (_e, title) => { if (win) win.setTitle(String(title).slice(0, 200)); });
ipcMain.on('dev:tools', () => win.webContents.toggleDevTools());

/* images: one file per picture in <data>\images, named by content hash */
const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'];
function saveImage(buf, ext) {
  ext = String(ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!IMG_EXT.includes(ext)) ext = 'png';
  fs.mkdirSync(imagesDir, { recursive: true });
  const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + '.' + ext;
  const file = path.join(imagesDir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return name;
}
ipcMain.handle('image:save', (_e, bytes, ext) => saveImage(Buffer.from(bytes), ext));
ipcMain.handle('image:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add images', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: IMG_EXT }] });
  if (r.canceled) return [];
  return r.filePaths.map(f => saveImage(fs.readFileSync(f), path.extname(f).slice(1)));
});
ipcMain.on('image:base', e => { e.returnValue = pathToFileURL(imagesDir).href + '/'; });

/* mods: single-file packages (<id>.js with a JSON header) in <data>\mods, plus the ones that ship with the app */
const modsDir = path.join(dataDir, 'mods');
const builtinModsDir = path.join(__dirname, 'mods');
// colours a theme mod sets, so the Mods page can show a preview without running it
function themePreview(src) {
  const pick = body => { const o = {}; for (const k of ['bg', 'card', 'text', 'accent', 'line', 'edge']) { const m = new RegExp('--' + k + '\\s*:\\s*([^;}]+)').exec(body); if (m && /^[#\w(),.%\s-]{3,48}$/.test(m[1].trim())) o[k] = m[1].trim(); } return Object.keys(o).length ? o : null; };
  const out = {};
  for (const v of ['dark', 'light']) { const b = new RegExp('\\.theme-' + v + '\\s*\\{([^}]*)\\}').exec(src); const o = b && pick(b[1]); if (o) out[v] = o; }
  if (!out.dark && !out.light) { const o = pick(src); if (o) out.dark = out.light = o; }
  return out.dark || out.light ? out : null;
}
function modMeta(source) {
  const m = /\/\*\s*@mindview-mod\s*([\s\S]*?)\*\//.exec(source || '');
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(j.id || '')) return null;
    return { id: j.id, name: String(j.name || j.id).slice(0, 60), version: String(j.version || '1.0.0').slice(0, 20), kind: j.kind === 'content' ? 'content' : 'usage', description: String(j.description || '').slice(0, 240), author: String(j.author || '').slice(0, 60), tags: (Array.isArray(j.tags) ? j.tags : []).map(t => String(t).trim().slice(0, 28)).filter(Boolean).slice(0, 6) , base: j.base === 'dark' || j.base === 'light' ? j.base : '', partial: !(j.base === 'dark' || j.base === 'light'), preview: (Array.isArray(j.tags) ? j.tags : []).some(t => String(t).trim().toLowerCase() === 'theme') ? themePreview(source) : null, about: String(j.about || '').slice(0, 4000), media: (Array.isArray(j.media) ? j.media : []).map(String).slice(0, 8), icon: typeof j.icon === 'string' && /^[MmLlHhVvCcSsQqTtAaZz0-9\s.,\-eE]{3,900}$/.test(j.icon) ? j.icon : '' };
  } catch { return null; }
}
// a mod's example pictures: web or data addresses as they are, plain names from the folder named after the mod
function modMedia(meta, dir, base) {
  return (meta.media || []).map(x => /^(https:\/\/|data:image\/)/.test(x) ? x : /^[\w.-]+$/.test(x) ? (base ? base + meta.id + '/' + x : fs.existsSync(path.join(dir, meta.id, x)) ? require('url').pathToFileURL(path.join(dir, meta.id, x)).href : '') : '').filter(Boolean);
}
function modFile(id) {
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(String(id))) return null;
  for (const [dir, from] of [[modsDir, 'user'], [builtinModsDir, 'included']]) { const f = path.join(dir, id + '.js'); if (fs.existsSync(f)) return { file: f, from }; }
  return null;
}
function listMods() {
  const out = {};
  for (const [dir, from] of [[builtinModsDir, 'included'], [modsDir, 'user']]) {
    let files = []; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.js')); } catch { /* no folder yet */ }
    for (const f of files) { try { const meta = modMeta(fs.readFileSync(path.join(dir, f), 'utf8')); if (meta && meta.id + '.js' === f) out[meta.id] = { ...meta, media: modMedia(meta, dir), from }; } catch { /* unreadable */ } }
  }
  return Object.values(out).sort((a, b) => a.name.localeCompare(b.name));
}
function installMod(source) {
  const meta = modMeta(source);
  if (!meta) throw new Error('That file is not a Mindview mod package (its header is missing or broken).');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(path.join(modsDir, meta.id + '.js'), source);
  return meta;
}
const repoModsDir = pid => path.join(dataDir, 'repos', pid, 'mods');
ipcMain.on('mods:list', e => { e.returnValue = listMods(); });
ipcMain.on('mods:read', (e, id) => { const f = modFile(id); try { e.returnValue = f ? fs.readFileSync(f.file, 'utf8') : null; } catch { e.returnValue = null; } });
ipcMain.on('mods:inProject', (e, pid) => { // mod packages that came along with a shared project
  const out = [];
  try { if (validId(pid)) for (const f of fs.readdirSync(repoModsDir(pid))) { const meta = modMeta(fs.readFileSync(path.join(repoModsDir(pid), f), 'utf8')); if (meta) out.push(meta); } } catch { /* none */ }
  e.returnValue = out;
});
ipcMain.handle('mods:add', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add a mod package', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Mindview mods', extensions: ['js'] }] });
  if (r.canceled) return { ok: [] };
  try { return { ok: r.filePaths.map(f => installMod(fs.readFileSync(f, 'utf8'))) }; } catch (e) { return { error: e.message }; }
});
ipcMain.handle('mods:addFromProject', (_e, pid, id) => {
  try { if (!validId(pid) || !/^[a-z0-9-]+$/.test(id)) throw new Error('bad id'); return { ok: installMod(fs.readFileSync(path.join(repoModsDir(pid), id + '.js'), 'utf8')) }; } catch (e) { return { error: e.message }; }
});
// the open catalog: a public GitHub repository with a mods/ folder of packages (settings.mods.repo = "owner/name")
const HOME_REPO = 'Attrom/mindview'; // where Mindview itself and the shared mods live
const modsRepo = () => { const r = (settings.mods && settings.mods.repo) || HOME_REPO; return /^[\w.-]+\/[\w.-]+$/.test(r) ? r : ''; };
async function catalog() {
  const repo = modsRepo(); if (!repo) return [];
  const r = await fetch(`${process.env.MINDVIEW_GITHUB_API || 'https://api.github.com'}/repos/${repo}/contents/mods`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Mindview' } });
  if (r.status === 404) throw new Error(`No mods folder found in ${repo}.`);
  if (!r.ok) throw new Error(r.status === 403 ? 'GitHub is limiting requests right now. Try again in a while.' : `GitHub answered ${r.status}.`);
  const out = [];
  for (const f of (await r.json()).filter(f => f.type === 'file' && f.name.endsWith('.js') && f.download_url)) {
    try { const src = await (await fetch(f.download_url)).text(); const meta = modMeta(src); if (meta && meta.id + '.js' === f.name) out.push({ ...meta, media: modMedia(meta, '', f.download_url.replace(/[^/]+$/, '')), url: f.download_url }); } catch { /* skip this one */ }
  }
  return out;
}
ipcMain.handle('mods:catalog', async () => { try { return { ok: await catalog(), repo: modsRepo() }; } catch (e) { return { error: e.message, repo: modsRepo() }; } });
ipcMain.handle('mods:install', async (_e, id) => {
  try {
    if (!modsRepo()) throw new Error('Nowhere to browse is set yet. Set it under Mods > Library, or add the package file.');
    const item = (await catalog()).find(m => m.id === id); if (!item) throw new Error('That mod is not in the catalog.');
    return { ok: installMod(await (await fetch(item.url)).text()) };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('mods:remove', (_e, id) => { const f = modFile(id); if (f && f.from === 'user') { fs.rmSync(f.file, { force: true }); fs.rmSync(path.join(modsDir, id), { recursive: true, force: true }); } return true; }); // its pictures folder goes too
ipcMain.handle('mods:openFolder', () => {
  fs.mkdirSync(modsDir, { recursive: true });
  try { fs.copyFileSync(path.join(builtinModsDir, 'HOW-TO-WRITE-A-MOD.md'), path.join(modsDir, 'HOW-TO-WRITE-A-MOD.md')); } catch { /* guide missing */ }
  shell.openPath(modsDir); return true;
});

/* sharing through Git / GitHub (see share.js). The GitHub token is kept encrypted by the operating system */
const { createShare } = require('./share');
function getToken() {
  const t = settings.github && settings.github.token; if (!t) return null;
  try { return settings.github.enc ? safeStorage.decryptString(Buffer.from(t, 'base64')) : t; } catch { return null; }
}
function setToken(token) {
  settings.github = settings.github || {};
  if (!token) { delete settings.github.token; delete settings.github.enc; }
  else if (safeStorage.isEncryptionAvailable()) { settings.github.token = safeStorage.encryptString(token).toString('base64'); settings.github.enc = true; }
  else { settings.github.token = token; settings.github.enc = false; }
  saveSettings(true);
}
const share = createShare({ dataDir, projectsDir, imagesDir, getToken, modFile: id => { const f = modFile(id); return f && f.file; }, ...(process.env.MINDVIEW_GITHUB_API ? { apiBase: process.env.MINDVIEW_GITHUB_API } : {}) }); // the env override is for tests
// The app's own GitHub sign-in (an OAuth app with Device flow; the ID is public, there is no secret). With it, signing in is one button.
const BUILT_IN_CLIENT_ID = 'Ov23li2RMoUbCFGUOqEy';
const GH_KEY = /^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/;
const clientId = () => (settings.github && settings.github.clientId) || BUILT_IN_CLIENT_ID;
const shareApi = {
  status: async id => ({ ...(await share.status(id)), clientId: clientId() }),
  publish: (id, opts) => share.publish(id, opts),
  openShared: spec => share.openShared(spec, slugify),
  sync: (id, message) => share.sync(id, message),
  history: id => share.history(id),
  restore: (id, oid) => share.restore(id, oid),
  invite: (id, name) => share.invite(id, name),
  people: id => share.people(id),
  unlink: id => share.unlink(id),
  remove: id => share.remove(id),
  signInToken: async token => { setToken(String(token || '').trim()); share.forget(); try { return await share.whoami(true); } catch (e) { setToken(null); share.forget(); throw e.code === 'AUTH' ? new Error('GitHub did not accept that key. Create a new one and try again.') : e; } },
  setClientId: id => { settings.github = settings.github || {}; settings.github.clientId = String(id || '').trim(); saveSettings(true); return true; },
  deviceStart: () => share.deviceStart(clientId()),
  devicePoll: async code => { const r = await share.devicePoll(clientId(), code); if (r.token) { setToken(r.token); share.forget(); return { user: await share.whoami(true) }; } return r; },
  signOut: () => { setToken(null); share.forget(); return true; },
  clipKey: () => { const t = clipboard.readText().trim(); return GH_KEY.test(t) ? t : ''; }, // a GitHub key the user just copied
  copy: text => { clipboard.writeText(String(text || '')); return true; },
  openUrl: url => { if (/^https:\/\/(www\.)?github\.com\//.test(String(url))) shell.openExternal(url); return true; },
};
ipcMain.handle('share:call', async (_e, method, ...args) => {
  try {
    if (!Object.prototype.hasOwnProperty.call(shareApi, method)) throw new Error('unknown');
    if (['status', 'publish', 'sync', 'history', 'restore', 'invite', 'people', 'unlink'].includes(method) && !validId(args[0])) throw new Error('bad project id');
    return { ok: await shareApi[method](...args) };
  } catch (e) { console.error('share', method, e); return { error: String(e && e.message || e), code: e && e.code }; }
});

/* ---------------- MCP: let AI apps read and edit projects ---------------- */
const os = require('os');
const http = require('http');
const mcp = require('./mcp-server.js');
const mcpDir = path.join(dataDir, 'mcp');
const mcpScript = path.join(mcpDir, 'mindview-mcp.js');
const mcpOps = mcp.makeOps(dataDir);
function putMcpFiles() { // the server and what it hands out, kept beside the data so an AI app can run it without the app
  fs.mkdirSync(path.join(mcpDir, 'included-mods'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'mcp-server.js'), mcpScript);
  try { fs.copyFileSync(path.join(__dirname, 'mods', 'HOW-TO-WRITE-A-MOD.md'), path.join(mcpDir, 'mod-guide.md')); const inc = fs.readdirSync(path.join(__dirname, 'mods')).filter(f => f.endsWith('.js')); for (const f of fs.readdirSync(path.join(mcpDir, 'included-mods'))) if (f.endsWith('.js') && !inc.includes(f)) fs.rmSync(path.join(mcpDir, 'included-mods', f), { force: true }); for (const f of fs.readdirSync(path.join(__dirname, 'mods')).filter(f => f.endsWith('.js'))) fs.copyFileSync(path.join(__dirname, 'mods', f), path.join(mcpDir, 'included-mods', f)); } catch (e) { console.error(e); }
}
const inPage = code => (win && !win.isDestroyed() ? win.webContents.executeJavaScript(code, true) : Promise.resolve(null));
// a call from the MCP server while the app is open: save what is on screen, change the file, show the result
async function mcpLive(tool, args) {
  let open = null;
  try { open = await inPage('flushForShare(), currentId'); } catch { /* window busy: work on the file as it is */ }
  const r = mcpOps.call(tool, args, true);
  try {
    if (r.changed && r.changed === open) await inPage('reloadAfterShare()');
    if (r.mod) await inPage(`aiModSaved(${JSON.stringify(r.mod.id)}, ${JSON.stringify(r.mod.project)})`);
    for (const d of r.requestsDone || []) await inPage(`aiRequestDone(${JSON.stringify(d.id)}, ${JSON.stringify(d.summary || 'Done.')})`);
    if (r.show) { await inPage(`(currentId === ${JSON.stringify(r.show.project)} || openProject(${JSON.stringify(r.show.project)})), focusNote(${JSON.stringify(r.show.note)})`); if (win.isMinimized()) win.restore(); win.focus(); }
  } catch (e) { console.error('mcp', e); }
  return { text: r.text };
}
function startMcpBridge() {
  const token = crypto.randomBytes(24).toString('hex');
  let chain = Promise.resolve();
  const srv = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.headers['x-mindview'] !== token) { res.statusCode = 403; return res.end(); }
    let body = ''; req.setEncoding('utf8'); req.on('data', c => { body += c; if (body.length > 4e6) req.destroy(); });
    req.on('end', () => {
      chain = chain.then(async () => {
        let out;
        try { const { tool, args } = JSON.parse(body); out = await mcpLive(tool, args); }
        catch (e) { out = { text: e.expected ? e.message : 'Mindview could not do that: ' + e.message, error: true }; }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out));
      });
    });
  });
  srv.on('error', e => console.error('mcp bridge', e));
  srv.listen(0, '127.0.0.1', () => {
    try { fs.mkdirSync(mcpDir, { recursive: true }); writeAtomic(path.join(mcpDir, 'live.json'), JSON.stringify({ port: srv.address().port, token, pid: process.pid })); } catch (e) { console.error(e); }
  });
  app.on('will-quit', () => { try { fs.rmSync(path.join(mcpDir, 'live.json'), { force: true }); } catch { /* fine */ } });
  // keep the installed copy of the server in step with this version of the app
  try { if (fs.existsSync(mcpScript)) putMcpFiles(); } catch (e) { console.error(e); }
}
// how each AI app is told about the server
const mcpEntry = () => ({ command: process.execPath, args: [mcpScript], env: { ELECTRON_RUN_AS_NODE: '1' } });
const home = os.homedir(), appData = () => app.getPath('appData');
function claudeDesktopFiles() {
  const out = [path.join(appData(), 'Claude', 'claude_desktop_config.json')];
  try { // the Microsoft Store build keeps its settings elsewhere
    const pk = path.join(process.env.LOCALAPPDATA || '', 'Packages');
    for (const d of fs.readdirSync(pk)) if (/^(AnthropicPBC\.)?Claude/i.test(d)) { const f = path.join(pk, d, 'LocalCache', 'Roaming', 'Claude'); if (fs.existsSync(f)) out.push(path.join(f, 'claude_desktop_config.json')); }
  } catch { /* not there */ }
  return out;
}
const jsonTarget = (files, key, extra = {}) => ({
  files, found: () => files().some(f => fs.existsSync(path.dirname(f)) && (path.dirname(f) !== home || fs.existsSync(f))),
  has: f => { const j = readJSON(f, null); return !!(j && j[key] && j[key].mindview); },
  current: f => { const m = (readJSON(f, {})[key] || {}).mindview || {}; return m.command === process.execPath && Array.isArray(m.args) && m.args[0] === mcpScript; },
  put(f) {
    let j = {};
    if (fs.existsSync(f)) { const t = fs.readFileSync(f, 'utf8'); if (t.trim()) { try { j = JSON.parse(t); } catch { throw new Error(`Could not read ${f} (it is not plain JSON), so nothing was changed.`); } } }
    if (!j || typeof j !== 'object' || Array.isArray(j)) j = {};
    j[key] = j[key] && typeof j[key] === 'object' ? j[key] : {}; j[key].mindview = { ...extra, ...mcpEntry() };
    fs.mkdirSync(path.dirname(f), { recursive: true }); writeAtomic(f, JSON.stringify(j, null, 2));
  },
  drop(f) { const j = readJSON(f, null); if (j && j[key] && j[key].mindview) { delete j[key].mindview; writeAtomic(f, JSON.stringify(j, null, 2)); } },
});
const tomlStrip = t => t.replace(/(^|\n)\[mcp_servers\.mindview(\.[^\]]+)?\][^\n]*(\n(?!\s*\[)[^\n]*)*/g, '$1').replace(/\n{3,}/g, '\n\n');
const mcpTargets = {
  'claude-desktop': { name: 'Claude (desktop app)', note: 'Restart Claude afterwards.', ...jsonTarget(claudeDesktopFiles, 'mcpServers') },
  'claude-code': { name: 'Claude Code', ...jsonTarget(() => [path.join(home, '.claude.json')], 'mcpServers', { type: 'stdio' }) },
  codex: {
    name: 'Codex', files: () => [path.join(home, '.codex', 'config.toml')], found: () => fs.existsSync(path.join(home, '.codex')),
    has: f => { try { return /^\[mcp_servers\.mindview\]/m.test(fs.readFileSync(f, 'utf8')); } catch { return false; } },
    current: f => { try { const t = fs.readFileSync(f, 'utf8'); return t.includes('command = ' + JSON.stringify(process.execPath)) && t.includes(JSON.stringify(mcpScript)); } catch { return false; } },
    put(f) {
      const e = mcpEntry(); let t = ''; try { t = tomlStrip(fs.readFileSync(f, 'utf8')); } catch { /* new file */ }
      t = t.replace(/\s*$/, '') + `${t.trim() ? '\n\n' : ''}[mcp_servers.mindview]\ncommand = ${JSON.stringify(e.command)}\nargs = [${e.args.map(a => JSON.stringify(a)).join(', ')}]\n\n[mcp_servers.mindview.env]\nELECTRON_RUN_AS_NODE = "1"\n`;
      fs.mkdirSync(path.dirname(f), { recursive: true }); writeAtomic(f, t);
    },
    drop(f) { try { writeAtomic(f, tomlStrip(fs.readFileSync(f, 'utf8'))); } catch { /* no file */ } },
  },
  cursor: { name: 'Cursor', ...jsonTarget(() => [path.join(home, '.cursor', 'mcp.json')], 'mcpServers') },
  vscode: { name: 'VS Code (Copilot)', ...jsonTarget(() => [path.join(appData(), 'Code', 'User', 'mcp.json')], 'servers', { type: 'stdio' }) },
  gemini: { name: 'Gemini CLI', ...jsonTarget(() => [path.join(home, '.gemini', 'settings.json')], 'mcpServers') },
};
/* AI mode: hand an instruction to an AI agent installed on this PC (signed in with the user's own account), which works through the MCP server */
function findCli(name) {
  const winOS = process.platform === 'win32';
  const dirs = [...(process.env.PATH || '').split(path.delimiter), path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), ...(winOS ? [path.join(appData(), 'npm')] : ['/usr/local/bin', '/opt/homebrew/bin'])];
  for (const n of winOS ? [name + '.exe', name + '.cmd'] : [name]) for (const d of dirs) { if (!d) continue; const f = path.join(d, n); try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ } }
  return null;
}
const ensureMcp = id => { const t = mcpTargets[id], all = t.files(), there = all.filter(f => fs.existsSync(path.dirname(f))); let added = false; for (const f of there.length ? there : [all[0]]) if (!t.has(f) || !t.current(f)) { t.put(f); added = true; } return added; }; // the agent must know the Mindview server
const lastLine = s => s.trim().split('\n').pop() || '';
const aiAgents = {
  claude: {
    name: 'Claude Code', cli: 'claude', signIn: 'run "claude" in a terminal and sign in with your Claude account',
    args() { const cfg = path.join(mcpDir, 'claude-mcp.json'); writeAtomic(cfg, JSON.stringify({ mcpServers: { mindview: mcpEntry() } })); return ['-p', '--mcp-config', cfg, '--strict-mcp-config', '--allowedTools', 'mcp__mindview', '--tools', '', '--output-format', 'json', '--no-session-persistence']; },
    read(out) { let j = null; try { j = JSON.parse(lastLine(out)); } catch { /* not JSON */ } return j ? { text: typeof j.result === 'string' ? j.result.trim() : '', failed: !!j.is_error } : { text: '', failed: true }; },
  },
  codex: {
    name: 'Codex', cli: 'codex', signIn: 'run "codex" in a terminal and sign in',
    args() { ensureMcp('codex'); this.last = path.join(mcpDir, 'codex-last.txt'); fs.rmSync(this.last, { force: true }); return ['exec', '--skip-git-repo-check', '-o', this.last, '-']; },
    read() { let text = ''; try { text = fs.readFileSync(this.last, 'utf8').trim(); } catch { /* nothing written */ } return { text, failed: !text }; },
  },
  gemini: {
    name: 'Gemini CLI', cli: 'gemini', signIn: 'run "gemini" in a terminal and sign in',
    args() { // trust the Mindview server so its tools run without a question nobody can answer
      const f = mcpTargets.gemini.files()[0]; ensureMcp('gemini'); const j = readJSON(f, {}); if (!j.mcpServers.mindview.trust) { j.mcpServers.mindview.trust = true; writeAtomic(f, JSON.stringify(j, null, 2)); }
      return ['--allowed-mcp-server-names', 'mindview', '-p', 'Follow the instructions given on standard input.'];
    },
    read(out) { return { text: out.trim(), failed: !out.trim() }; },
  },
};
// the user wants only Claude here (2026-11-11); the other programs stay written above in case they come back
for (const k of ['codex', 'gemini']) delete aiAgents[k];
for (const k of ['codex', 'cursor', 'vscode', 'gemini']) delete mcpTargets[k];
// Claude desktop cannot be started in the background: requests wait in a list that it collects through the MCP server
aiAgents['claude-desktop'] = { name: 'Claude desktop app', queue: true };
const requestsFile = path.join(mcpDir, 'requests.json');
const agentPath = id => {
  if (aiAgents[id].queue) return mcpTargets[id].found() ? 'queue' : null;
  const own = settings.ai && settings.ai.paths && settings.ai.paths[id]; // a program the user pointed to
  if (own) { try { if (fs.statSync(own).isFile()) return own; } catch { /* moved away */ } }
  return process.env['MINDVIEW_' + id.toUpperCase()] || findCli(aiAgents[id].cli);
};
function agentList() {
  const list = Object.entries(aiAgents).map(([id, a]) => ({ id, name: a.name, found: !!agentPath(id), queue: !!a.queue }));
  const want = settings.ai && settings.ai.agent, pick = list.find(a => a.id === want && a.found) || list.find(a => a.found);
  return { list, selected: pick ? pick.id : null };
}
let aiChain = Promise.resolve();
function askAgent({ project, projectName, target, instruction }) {
  return new Promise(resolve => {
    const id = agentList().selected;
    if (!id) return resolve({ error: 'Claude was not found on this PC. Install Claude Code (and sign in once by running "claude" in a terminal) or the Claude desktop app, then try again.' });
    const agent = aiAgents[id], exe = agentPath(id);
    const t = target || {}, notes = (t.notes || []).map(n => `- [${n.id}] ${n.title}`).join('\n');
    const pointed = t.kind === 'note' ? (t.part && t.part !== 'the note itself' ? `${t.part}, in this note:\n${notes}` : `this note:\n${notes}`) : t.kind === 'link' ? `${t.part || 'the link between these notes'}:\n${notes}` : t.kind === 'notes' ? `these notes (selected by dragging over them):\n${notes}`
      : t.kind === 'section' ? `the section "${t.section}"${notes ? ', which holds:\n' + notes : ' (empty)'}` : t.kind === 'interface' ? `exactly this part of the Mindview window itself: ${t.what}${t.selector ? ` (element ${t.selector}: ${t.html})` : ''}` : 'an empty spot on the canvas';
    const prompt = `You are the assistant inside Mindview, a canvas of notes arranged as trees. The user is looking at the project "${projectName}" (id: ${project}).\nThey pointed at ${pointed}\n\nTheir instruction:\n${instruction}\n\nCarry it out with the mindview tools (read the project first if you need more context; changes appear on their canvas at once). If they want Mindview itself changed (how it looks or behaves, shortcuts, a new feature) rather than their notes, do that by writing a mod: call mod_guide first, then save_mod; it takes effect at once. If an installed mod already covers the same thing, change that mod instead of adding another. When done, answer in one or two short plain sentences saying what you did. Do not ask questions back.`;
    if (agent.queue) {
      try {
        putMcpFiles(); const fresh = ensureMcp(id);
        const rid = crypto.randomBytes(4).toString('hex'), list = readJSON(requestsFile, []).filter(r => r && r.id);
        list.push({ id: rid, time: Date.now(), project, projectName, pointed, instruction });
        writeAtomic(requestsFile, JSON.stringify(list, null, 1));
        const phrase = 'Do my Mindview requests'; clipboard.writeText(phrase);
        return resolve({ queued: rid, agent: agent.name, ok: `Waiting for Claude. ${fresh ? 'Restart the Claude app first (Mindview was just connected to it), then in' : 'In'} Claude, send: “${phrase}” (copied, just paste it).` });
      } catch (e) { return resolve({ error: e.message, agent: agent.name }); }
    }
    let child, done = false, out = '', err = '';
    const finish = r => { if (!done) { done = true; clearTimeout(timer); resolve({ ...r, agent: agent.name }); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ error: `${agent.name} took longer than 5 minutes, so I stopped it. Whatever it had already changed is kept.` }); }, 300000);
    try {
      putMcpFiles();
      const args = agent.args(), viaShell = /\.cmd$/i.test(exe);
      child = require('child_process').spawn(viaShell ? `"${exe}"` : exe, viaShell ? args.map(a => (a === '' || /\s/.test(a) ? `"${a}"` : a)) : args, { cwd: mcpDir, shell: viaShell, windowsHide: true });
    } catch (e) { return finish({ error: `Could not start ${agent.name}: ${e.message}` }); }
    child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { err += c; });
    child.on('error', e => finish({ error: `Could not start ${agent.name}: ${e.message}` }));
    child.on('close', code => {
      let r; try { r = agent.read(out, err); } catch (e) { r = { text: '', failed: true }; }
      if (!r.failed && code === 0) return finish({ ok: r.text || 'Done.' });
      const why = r.text || lastLine(err) || out.trim().slice(-300) || `${agent.name} stopped (code ${code}).`;
      finish({ error: /log ?in|sign ?in|authenticat|api key|credential|unauthorized/i.test(why) ? `${agent.name} is not signed in. Open a terminal, ${agent.signIn}, then try again. (${why.slice(0, 160)})` : why.slice(0, 600) });
    });
    child.stdin.on('error', () => {}); child.stdin.end(prompt);
  });
}
ipcMain.handle('ai:ask', (_e, req) => { const p = aiChain.then(() => askAgent(req || {})).catch(e => ({ error: e.message })); aiChain = p; return p; });
ipcMain.handle('ai:agents', () => agentList());
ipcMain.handle('ai:pick', async (_e, id, locate) => {
  if (!aiAgents[id]) return agentList();
  if (aiAgents[id].queue) { settings.ai = { ...(settings.ai || {}), agent: id }; saveSettings(); return agentList(); }
  if (locate || !agentPath(id)) { // not found by itself: let them point to it
    const r = await dialog.showOpenDialog(win, { title: `Where is ${aiAgents[id].name}? Choose its program (${aiAgents[id].cli})`, properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe', 'cmd', 'bat'] }, { name: 'All files', extensions: ['*'] }] : [] });
    if (r.canceled || !r.filePaths[0]) return agentList();
    settings.ai = { ...(settings.ai || {}), paths: { ...((settings.ai || {}).paths || {}), [id]: r.filePaths[0] } };
  }
  settings.ai = { ...(settings.ai || {}), agent: id }; saveSettings();
  return agentList();
});
const mcpStatus = () => Object.entries(mcpTargets).map(([id, t]) => ({ id, name: t.name, note: t.note || '', found: t.found(), installed: t.files().some(f => t.has(f)), stale: t.files().some(f => t.has(f) && !t.current(f)) }));
ipcMain.handle('mcp:status', () => mcpStatus());
ipcMain.handle('mcp:install', (_e, id) => {
  try {
    const t = mcpTargets[id]; if (!t) throw new Error('Unknown app.');
    putMcpFiles();
    const all = t.files(), there = all.filter(f => fs.existsSync(path.dirname(f)));
    for (const f of there.length ? there : [all[0]]) {
      if (fs.existsSync(f) && !fs.existsSync(f + '.before-mindview')) fs.copyFileSync(f, f + '.before-mindview'); // one safety copy of their settings
      t.put(f);
    }
    return { ok: mcpStatus() };
  } catch (e) { return { error: e.message, ok: mcpStatus() }; }
});
ipcMain.handle('mcp:remove', (_e, id) => {
  try { const t = mcpTargets[id]; for (const f of t.files()) if (t.has(f)) t.drop(f); return { ok: mcpStatus() }; } catch (e) { return { error: e.message, ok: mcpStatus() }; }
});

/* ---------- updates ----------
   A newer app.asar is fetched from the latest release of the home repository, checked against its
   published sha256, kept in <data>\update, and put in place when Mindview closes or next starts. */
const BUILD = 89;
const ofs = require('original-fs'); // plain file access: Electron's fs would treat app.asar as a folder
const updateUrl = process.env.MINDVIEW_UPDATE_URL || `https://github.com/${HOME_REPO}/releases/latest/download/`;
const liveAsar = process.env.MINDVIEW_UPDATE_TARGET || path.join(process.resourcesPath, 'app.asar');
const canUpdate = app.isPackaged || !!process.env.MINDVIEW_UPDATE_TARGET;
const updDir = path.join(dataDir, 'update');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
function applyUpdate() {
  if (!canUpdate || !ofs.existsSync(path.join(updDir, 'version.json'))) return false;
  let done = false;
  try {
    const v = JSON.parse(ofs.readFileSync(path.join(updDir, 'version.json'), 'utf8'));
    const buf = ofs.readFileSync(path.join(updDir, 'app.bin'));
    if (v.build > BUILD && sha256(buf) === v.sha256) {
      try { ofs.writeFileSync(liveAsar + '.new', buf); ofs.renameSync(liveAsar + '.new', liveAsar); }
      catch { ofs.writeFileSync(liveAsar, buf); try { ofs.rmSync(liveAsar + '.new', { force: true }); } catch { /* leftover */ } }
      done = true;
    }
  } catch (e) { console.error('update not applied', e); }
  try { ofs.rmSync(updDir, { recursive: true, force: true }); } catch { /* next time */ }
  return done;
}
async function checkUpdate() {
  if (!canUpdate) return;
  try {
    const r = await fetch(updateUrl + 'version.json', { headers: { 'User-Agent': 'Mindview' } }); if (!r.ok) return;
    const v = await r.json(); if (!(v.build > BUILD) || !/^[0-9a-f]{64}$/.test(v.sha256 || '')) return;
    try { if (JSON.parse(ofs.readFileSync(path.join(updDir, 'version.json'), 'utf8')).build === v.build) return; } catch { /* nothing waiting */ }
    const a = await fetch(updateUrl + 'app.asar', { headers: { 'User-Agent': 'Mindview' } }); if (!a.ok) return;
    const buf = Buffer.from(await a.arrayBuffer()); if (sha256(buf) !== v.sha256) return;
    ofs.mkdirSync(updDir, { recursive: true });
    ofs.writeFileSync(path.join(updDir, 'app.bin'), buf);
    ofs.writeFileSync(path.join(updDir, 'version.json'), JSON.stringify({ build: v.build, sha256: v.sha256 }));
  } catch (e) { console.error('update check failed', e.message); }
}
ipcMain.on('app:build', e => { e.returnValue = BUILD; });

app.whenReady().then(() => {
  if (applyUpdate()) { app.relaunch(); app.exit(0); return; } // a waiting update: start again as the new version
  Menu.setApplicationMenu(null);
  try { fs.mkdirSync(dataDir, { recursive: true }); importPortableData(); } catch (e) { console.error('import failed', e); }
  try { migrateLegacy(); } catch (e) { console.error('migration failed', e); }
  dailyBackups();
  createWindow();
  startMcpBridge();
  setTimeout(checkUpdate, 4000);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { applyUpdate(); });
