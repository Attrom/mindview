/* Mindview MCP server.
   One file, no dependencies. Run by an AI app as:  <Mindview.exe> <this file>   with ELECTRON_RUN_AS_NODE=1
   It speaks MCP over stdin/stdout. When Mindview is open it hands each call to the app (so the canvas stays in step);
   otherwise it works on the project files directly. The app also loads this file for the tools themselves. */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const VERSION = '1.1.0';
const COLORS = ['none', 'amber', 'red', 'pink', 'violet', 'blue', 'teal', 'green'];
const SIZES = ['sm', 'md', 'lg'];

/* ---------------- the tools ---------------- */

const note = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Existing note to change. Leave out to add a new note.' },
    ref: { type: 'string', description: 'A temporary name for a new note, so later notes in the same call can use it as their parent.' },
    parent: { type: 'string', description: 'Parent note: an id, or the ref of a note earlier in this call. Empty string makes it a top-level note.' },
    title: { type: 'string', description: 'Short text shown on the canvas.' },
    description: { type: 'string', description: 'Longer text, shown only when the note is selected.' },
    color: { type: 'string', enum: COLORS },
    size: { type: 'string', enum: SIZES },
    url: { type: 'string', description: 'Web link opened when the note is clicked. Empty string removes it.' },
  },
};
const TOOLS = [
  { name: 'list_projects', description: 'List the Mindview projects (id, name, number of notes).', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_project', description: 'Read a project as an indented outline of its notes (ids in brackets), with arrows between notes listed below. Give `note` to read one note in full with its branch, or `query` to list only the notes whose title or description contains the text.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project id or name.' }, note: { type: 'string' }, query: { type: 'string' } }, required: ['project'] } },
  { name: 'write_notes', description: 'Add new notes and/or change existing ones, several at once. A note with `id` is changed (only the fields given); a note without is added. Notes form a tree through `parent`; build a whole branch in one call by giving new notes a `ref` and using it as the `parent` of later ones.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, notes: { type: 'array', items: note, minItems: 1 } }, required: ['project', 'notes'] } },
  { name: 'delete_notes', description: 'Delete notes. The notes under a deleted note are deleted with it.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, ids: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['project', 'ids'] } },
  { name: 'link_notes', description: 'Draw an arrow between two notes that are not parent and child (or remove it with remove: true).',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, both_ways: { type: 'boolean' }, remove: { type: 'boolean' } }, required: ['project', 'from', 'to'] } },
  { name: 'create_project', description: 'Create a new, empty project.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'mod_guide', description: 'How to change Mindview itself (its looks, shortcuts, behaviour, new features) by writing a mod: returns the guide, the map of the window, and the mods already installed. Give `id` to also get the source of one installed mod. Call this before save_mod.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'save_mod', description: 'Install or replace a mod (one JavaScript file with the @mindview-mod header) and switch it on. To change an earlier mod, read it with mod_guide and save the whole new source under the same id.',
    inputSchema: { type: 'object', properties: { source: { type: 'string', description: 'The complete mod file.' }, project: { type: 'string', description: 'Switch it on for this project only. Leave out to switch it on for all projects.' }, media: { type: 'array', description: 'Example pictures or GIFs for the mod page, saved in a folder named after the mod; list their names in the header "media".', items: { type: 'object', properties: { name: { type: 'string', description: 'File name, e.g. example.gif' }, base64: { type: 'string', description: 'The file content, base64-encoded (png, jpg, gif or webp).' }, path: { type: 'string', description: 'Or: the full path of a picture on this computer to copy.' } }, required: ['name'] } } }, required: ['source'] } },
  { name: 'requests', description: 'Requests the user left for you inside Mindview (they pointed at something there and typed an instruction). Call it when they ask you to do their Mindview requests. Carry each one out with the other tools, then call this again with `done` to report what you did.',
    inputSchema: { type: 'object', properties: { done: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, summary: { type: 'string', description: 'One or two short sentences on what you did.' } }, required: ['id', 'summary'] } } } } },
  { name: 'show_note', description: 'Bring a note into view in the Mindview window (Mindview must be open).',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, note: { type: 'string' } }, required: ['project', 'note'] } },
];

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const first = s => String(s || '').split('\n')[0];
const fail = msg => { const e = new Error(msg); e.expected = true; return e; };

function modHeader(source) {
  const m = /^\s*\/\*\s*@mindview-mod\s*([\s\S]*?)\*\//.exec(source); if (!m) return null;
  try { const j = JSON.parse(m[1]); if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(j.id || '')) return null; return { id: j.id, name: String(j.name || j.id), kind: j.kind === 'content' ? 'content' : 'usage', description: String(j.description || ''), tags: (Array.isArray(j.tags) ? j.tags : []).map(String) }; } catch { return null; }
}
function makeOps(dataDir) {
  const dir = path.join(dataDir, 'projects');
  const file = id => path.join(dir, id + '.json');
  const list = () => {
    let files = []; try { files = fs.readdirSync(dir).filter(f => /^[a-z0-9-]{1,80}\.json$/.test(f)); } catch { /* none yet */ }
    return files.map(f => { try { const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { id: f.slice(0, -5), name: d.name || f.slice(0, -5), notes: Object.keys(d.nodes || {}).length }; } catch { return null; } }).filter(Boolean);
  };
  const find = p => {
    const all = list(), q = String(p || '').trim().toLowerCase();
    const hit = all.find(x => x.id === q) || all.find(x => x.name.toLowerCase() === q) || (all.filter(x => x.name.toLowerCase().includes(q)).length === 1 && q ? all.find(x => x.name.toLowerCase().includes(q)) : null);
    if (!hit) throw fail(`No project "${p}". Projects: ${all.map(x => `${x.name} (${x.id})`).join(', ') || 'none'}.`);
    return hit.id;
  };
  const load = id => { const d = JSON.parse(fs.readFileSync(file(id), 'utf8')); d.nodes = d.nodes || {}; d.links = d.links || []; return d; };
  const save = (id, d) => { d.updated = Date.now(); const tmp = file(id) + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(d, null, 1), 'utf8'); fs.renameSync(tmp, file(id)); };
  const kids = (d, id) => Object.values(d.nodes).filter(n => (n.parentId || null) === id || (id === null && n.parentId && !d.nodes[n.parentId])).sort((a, b) => a.y - b.y || a.x - b.x);
  const need = (d, id) => { const n = d.nodes[id]; if (!n) throw fail(`No note with id "${id}" in this project.`); return n; };
  const sectionOf = (d, n) => { let s = n; while (s && s.section === undefined && s.parentId) s = d.nodes[s.parentId]; return s && s.section && d.sections && d.sections[s.section] ? d.sections[s.section].label || '' : ''; };
  const line = (d, n, depth) => {
    const tags = [];
    if (n.color && n.color !== 'none') tags.push(n.color);
    if (n.body) tags.push('has description');
    if (n.url) tags.push('link');
    if ((n.images || []).length + (n.bodyImages || []).length) tags.push('images');
    const sec = !n.parentId || n.section !== undefined ? sectionOf(d, n) : '';
    if (sec) tags.push('section: ' + sec);
    return `${'  '.repeat(depth)}- [${n.id}] ${first(n.text) || '(untitled)'}${tags.length ? '  (' + tags.join(', ') + ')' : ''}`;
  };
  const outline = (d, id, depth, out) => { for (const n of kids(d, id)) { out.push(line(d, n, depth)); outline(d, n.id, depth + 1, out); } return out; };
  const arrows = (d, only) => d.links.filter(L => L.kind === 'flow' && d.nodes[L.a] && d.nodes[L.b] && (!only || only.has(L.a) || only.has(L.b)))
    .map(L => `[${L.a}] ${first(d.nodes[L.a].text)} ${L.dir === 'both' ? '<->' : '->'} [${L.b}] ${first(d.nodes[L.b].text)}`);

  const run = {
    list_projects() {
      const all = list();
      return { text: all.length ? all.map(p => `${p.name}  (id: ${p.id}, ${p.notes} notes)`).join('\n') : 'There are no projects yet.' };
    },
    read_project({ project, note: nid, query }) {
      const id = find(project), d = load(id);
      if (nid) {
        const n = need(d, nid), path_ = []; for (let p = d.nodes[n.parentId]; p; p = d.nodes[p.parentId]) path_.unshift(first(p.text));
        const out = [`Note [${n.id}] in "${d.name || id}"`, `Title: ${n.text || ''}`];
        if (path_.length) out.push('Under: ' + path_.join(' > '));
        out.push(`Colour: ${n.color || 'none'}, size: ${n.size || 'md'}`);
        if (n.url) out.push('Link: ' + n.url);
        const sec = sectionOf(d, n); if (sec) out.push('Section: ' + sec);
        if (n.body) out.push('Description:\n' + n.body);
        const sub = outline(d, n.id, 0, []); if (sub.length) out.push('Notes under it:\n' + sub.join('\n'));
        const ar = arrows(d, new Set([n.id])); if (ar.length) out.push('Arrows:\n' + ar.join('\n'));
        return { text: out.join('\n') };
      }
      if (query) {
        const q = String(query).toLowerCase();
        const hits = Object.values(d.nodes).filter(n => (n.text || '').toLowerCase().includes(q) || (n.body || '').toLowerCase().includes(q));
        return { text: hits.length ? `${hits.length} note${hits.length > 1 ? 's' : ''} in "${d.name || id}" matching "${query}":\n` + hits.slice(0, 100).map(n => line(d, n, 0)).join('\n') : `Nothing in "${d.name || id}" matches "${query}".` };
      }
      const out = outline(d, null, 0, []), ar = arrows(d);
      return { text: `Project "${d.name || id}" (id: ${id}), ${Object.keys(d.nodes).length} notes\n` + (out.join('\n') || '(empty)') + (ar.length ? '\n\nArrows:\n' + ar.join('\n') : '') };
    },
    write_notes({ project, notes }) {
      const id = find(project), d = load(id);
      if (!Array.isArray(notes) || !notes.length) throw fail('Give at least one note.');
      const refs = {}, done = [];
      const parentOf = v => { if (v === '' || v === null) return null; if (refs[v]) return refs[v]; need(d, v); return v; };
      for (const a of notes) {
        if (a.color !== undefined && !COLORS.includes(a.color)) throw fail(`Unknown colour "${a.color}". Use one of: ${COLORS.join(', ')}.`);
        if (a.size !== undefined && !SIZES.includes(a.size)) throw fail('Size is sm, md or lg.');
        let n;
        if (a.id) {
          n = need(d, a.id);
          if (a.parent !== undefined) {
            const p = parentOf(a.parent);
            for (let x = p; x; x = d.nodes[x] && d.nodes[x].parentId) if (x === n.id) throw fail(`Cannot move [${n.id}] under itself or one of its own notes.`);
            if ((n.parentId || null) !== p) { const sib = kids(d, p); n.parentId = p; n.y = sib.length ? sib[sib.length - 1].y + 60 : (p ? d.nodes[p].y : 0); if (p) { n.x = d.nodes[p].x + 300; delete n.section; } delete n.nudge; }
          }
          done.push(`changed [${n.id}] ${first(a.title !== undefined ? a.title : n.text)}`);
        } else {
          const p = a.parent === undefined ? null : parentOf(a.parent), sib = kids(d, p), nid = uid();
          n = d.nodes[nid] = { id: nid, parentId: p, x: p ? d.nodes[p].x + 300 : (sib.length ? sib[sib.length - 1].x : 0), y: sib.length ? sib[sib.length - 1].y + (p ? 60 : 240) : (p ? d.nodes[p].y : 0), text: '', size: p ? 'md' : 'lg', color: p ? d.nodes[p].color || 'none' : 'none' };
          if (a.ref) refs[a.ref] = nid;
          done.push(`added [${nid}] ${first(a.title)}`);
        }
        if (a.title !== undefined) n.text = String(a.title);
        if (a.description !== undefined) { if (a.description) n.body = String(a.description); else delete n.body; }
        if (a.color !== undefined) n.color = a.color;
        if (a.size !== undefined) n.size = a.size;
        if (a.url !== undefined) { if (a.url) { if (!/^https?:\/\//i.test(a.url)) throw fail('A link must start with http:// or https://'); n.url = a.url; } else delete n.url; }
      }
      save(id, d);
      return { text: done.join('\n'), changed: id };
    },
    delete_notes({ project, ids }) {
      const id = find(project), d = load(id); let count = 0;
      const drop = nid => { for (const k of kids(d, nid)) drop(k.id); delete d.nodes[nid]; count++; };
      for (const nid of ids || []) { if (d.nodes[nid]) drop((need(d, nid)).id); }
      if (!count) throw fail('None of those notes exist in this project.');
      d.links = d.links.filter(L => d.nodes[L.a] && d.nodes[L.b]);
      save(id, d);
      return { text: `Deleted ${count} note${count > 1 ? 's' : ''}.`, changed: id };
    },
    link_notes({ project, from, to, both_ways, remove }) {
      const id = find(project), d = load(id); need(d, from); need(d, to);
      if (from === to) throw fail('A note cannot link to itself.');
      const same = L => L.kind === 'flow' && ((L.a === from && L.b === to) || (L.a === to && L.b === from));
      const had = d.links.some(same);
      d.links = d.links.filter(L => !same(L));
      if (remove) { if (!had) throw fail('There is no arrow between those notes.'); }
      else d.links.push({ id: uid(), kind: 'flow', a: from, b: to, dir: both_ways ? 'both' : 'one' });
      save(id, d);
      return { text: remove ? 'Arrow removed.' : 'Arrow added.', changed: id };
    },
    create_project({ name }) {
      name = String(name || '').trim().slice(0, 80); if (!name) throw fail('Give the project a name.');
      fs.mkdirSync(dir, { recursive: true });
      const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'project';
      let id = base, i = 2; while (fs.existsSync(file(id))) id = `${base}-${i++}`;
      save(id, { version: 1, name, nodes: {}, links: [], sections: {} });
      return { text: `Created "${name}" (id: ${id}).`, created: id };
    },
    mod_guide({ id }) {
      let guide = ''; try { guide = fs.readFileSync(path.join(dataDir, 'mcp', 'mod-guide.md'), 'utf8'); } catch { guide = 'The guide is missing: open Mindview once, then try again.'; }
      const mods = [];
      for (const d of [path.join(dataDir, 'mcp', 'included-mods'), path.join(dataDir, 'mods')]) { let fl = []; try { fl = fs.readdirSync(d).filter(f => f.endsWith('.js')); } catch { /* none */ }
        for (const f of fl) { try { const m = modHeader(fs.readFileSync(path.join(d, f), 'utf8')); if (m) mods.push(`- ${m.id} (${m.kind}${m.tags.length ? '; tags: ' + m.tags.join(', ') : ''}): ${m.name}. ${m.description}`); } catch { /* skip */ } } }
      let out = guide + '\n\n## Mods installed now\n' + (mods.join('\n') || '(none)');
      if (id) { let src = null; for (const d of [path.join(dataDir, 'mods'), path.join(dataDir, 'mcp', 'included-mods')]) { try { src = src || fs.readFileSync(path.join(d, id + '.js'), 'utf8'); } catch { /* next */ } } out += `\n\n## Source of ${id}\n` + (src ? '```js\n' + src + '\n```' : 'There is no mod with that id.'); }
      return { text: out };
    },
    save_mod({ source, project, media }, live) {
      const m = modHeader(String(source || ''));
      if (!m) throw fail('That is not a mod package: it must start with the /* @mindview-mod { ...JSON... } */ header (id of lowercase letters, digits and dashes) and then call Mindview.mod(api => { ... }).');
      if (!/Mindview\.mod\s*\(/.test(source)) throw fail('The file must call Mindview.mod(api => { ... }).');
      try { new Function('Mindview', source); } catch (e) { throw fail('The mod has a syntax error, so it was not saved: ' + e.message); }
      const pid = project ? find(project) : null;
      fs.mkdirSync(path.join(dataDir, 'mods'), { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'mods', m.id + '.js'), source);
      for (const f of Array.isArray(media) ? media.slice(0, 8) : []) { // the mod page's example pictures
        const name = String(f && f.name || ''); if (!/^[\w.-]+\.(png|jpe?g|gif|webp)$/i.test(name)) throw fail('Media names must be plain file names ending in .png, .jpg, .gif or .webp.');
        const dir = path.join(dataDir, 'mods', m.id); fs.mkdirSync(dir, { recursive: true });
        if (f.base64) fs.writeFileSync(path.join(dir, name), Buffer.from(String(f.base64), 'base64'));
        else if (f.path && fs.existsSync(String(f.path))) fs.copyFileSync(String(f.path), path.join(dir, name));
        else throw fail('Each media item needs base64 content or a path to an existing file.');
      }
      if (!live) { // Mindview is closed: switch it on in the settings file
        const sf = path.join(dataDir, 'settings.json'); let st = {}; try { st = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch { /* new */ }
        st.mods = st.mods || {}; st.mods.global = st.mods.global || []; st.mods.projects = st.mods.projects || {};
        if (m.kind === 'content' && pid) { const d = load(pid); d.mods = [...new Set([...(d.mods || []), m.id])]; save(pid, d); }
        else if (pid) st.mods.projects[pid] = [...new Set([...(st.mods.projects[pid] || []), m.id])];
        else st.mods.global = [...new Set([...st.mods.global, m.id])];
        fs.writeFileSync(sf, JSON.stringify(st, null, 1));
      }
      return { text: `Saved the mod "${m.name}" (${m.id}) and switched it on ${pid ? 'for this project' : 'for all projects'}.`, mod: { id: m.id, project: pid } };
    },
    requests({ done }) {
      const f = path.join(dataDir, 'mcp', 'requests.json'); let list = []; try { list = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* none */ }
      const finished = (done || []).filter(d => d && list.some(r => r.id === d.id));
      if (finished.length) { list = list.filter(r => !finished.some(d => d.id === r.id)); fs.writeFileSync(f, JSON.stringify(list, null, 1)); }
      const text = list.length ? `${list.length} request${list.length > 1 ? 's' : ''} waiting. Carry each out with the mindview tools (to change Mindview itself rather than notes, write a mod: mod_guide, then save_mod), then call requests again with done.\n\n` +
        list.map(r => `Request ${r.id}, in project "${r.projectName}" (id: ${r.project}).\nThey pointed at ${r.pointed}\nInstruction: ${r.instruction}`).join('\n\n') : 'No requests are waiting.';
      return { text: (finished.length ? `Marked ${finished.length} done. ` : '') + text, requestsDone: finished };
    },
    show_note({ project, note: nid }) {
      const id = find(project), d = load(id); need(d, nid);
      return { text: `Showing "${first(d.nodes[nid].text)}" in Mindview.`, show: { project: id, note: nid }, offline: 'Mindview is not open, so there is nothing to show it in. Open Mindview and try again.' };
    },
  };
  return { call(tool, args, live) { if (!run[tool]) throw fail(`Unknown tool "${tool}".`); return run[tool](args || {}, live); } };
}

module.exports = { TOOLS, VERSION, makeOps };

/* ---------------- the stdio server ---------------- */

if (require.main === module) {
  const dataDir = process.env.MINDVIEW_DATA || path.resolve(__dirname, '..');
  const ops = makeOps(dataDir);
  // is Mindview open? then let it do the work, so what is on screen and what is on disk stay the same
  const viaApp = (tool, args) => new Promise(resolve => {
    let live; try { live = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp', 'live.json'), 'utf8')); } catch { return resolve(null); }
    const body = JSON.stringify({ tool, args });
    const req = http.request({ host: '127.0.0.1', port: live.port, method: 'POST', path: '/', timeout: 8000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-mindview': live.token } }, res => {
      let s = ''; res.setEncoding('utf8'); res.on('data', c => { s += c; }); res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(s) : null); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(null)); req.end(body);
  });
  async function callTool(name, args) {
    try {
      const live = await viaApp(name, args);
      if (live) return { content: [{ type: 'text', text: live.text }], isError: !!live.error };
      const r = ops.call(name, args);
      return { content: [{ type: 'text', text: r.offline || r.text }], isError: !!r.offline };
    } catch (e) { return { content: [{ type: 'text', text: e.expected ? e.message : 'Mindview could not do that: ' + e.message }], isError: true }; }
  }
  const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
  const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
  async function handle(m) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return;
    const reply = result => { if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result }); };
    if (m.method === 'initialize') return reply({ protocolVersion: PROTOCOLS.includes(m.params && m.params.protocolVersion) ? m.params.protocolVersion : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name: 'mindview', title: 'Mindview', version: VERSION },
      instructions: 'Mindview is a canvas of notes arranged as trees. Each note has a short title and an optional longer description. Read a project before changing it, and use the note ids shown in brackets.' });
    if (m.method === 'ping') return reply({});
    if (m.method === 'tools/list') return reply({ tools: TOOLS });
    if (m.method === 'tools/call') return reply(await callTool(m.params && m.params.name, m.params && m.params.arguments));
    if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } });
  }
  let buf = '', chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const text = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!text) continue;
      let m; try { m = JSON.parse(text); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      chain = chain.then(() => handle(m)).catch(e => process.stderr.write(String(e && e.stack || e) + '\n'));
    }
  });
  process.stdin.on('end', () => chain.then(() => process.exit(0)));
}
