# How to write a Mindview mod

A mod is one `.js` file. Put it in this folder (or use Mods > Add a package), then switch it on in the Mods menu,
for all projects or only for the open one.

## The file

```js
/* @mindview-mod
{
  "id": "my-mod",
  "name": "My mod",
  "version": "1.0.0",
  "kind": "usage",
  "description": "One line on what it does.",
  "author": "You",
  "tags": ["Quality of life"],
  "icon": "M10 3v14M3 10h14"
}
*/
Mindview.mod(api => {
  // runs when the mod is switched on (and each time a project that uses it opens)
  api.addKey('ctrl+shift+h', () => api.toast('Hello'));
});
```

The header must be real JSON. `id` uses letters, digits and dashes and is also the file name (`my-mod.js`). `kind` is `usage` or `content`.

## Tags

`tags` says what the mod is about; people filter by them. Use one to three of: Quality of life, Text formatting, Nodes,
Connections, External applications, Style, Feature, Theme, Data formats, Presentation. Add a new one only if none fits.

## The mod's page (`about`, `media`)
Clicking a mod's card opens its page. Put the explanation there, not on the card:
- `"about"`: a clear, short explanation of what the mod does and how to use it. Plain text; a blank line starts a new paragraph, lines starting with `- ` make a list.
- `"media"`: up to 8 example pictures or GIFs, each an `https://` address, a `data:image/...` address, or a file name in a folder named after the mod next to its file (`mods/<id>/example.gif`).
Keep `description` to one short line for the card.
Every mod gets a page in the same style as the included Text styles mod (`text-style`): one opening line on what it does, a short `- ` list of how to use it step by step, then any extra notes; and at least one picture or GIF showing it in use. Pass picture files to `save_mod` as `media` (base64 content or a path on this computer); they are saved in `mods/<id>/`.

## Themes

A theme is a mod tagged `Theme`. Themes are not listed with the other mods: they have their own page (right-click
the dark-mode button, or its menu > Manage themes) and only one is in use at a time. There are two sorts, and the
header must say which:

- **Full theme**: add `"base": "dark"` or `"base": "light"`. Choosing it switches Mindview to that base and the
  theme must set **every** colour variable, so it looks the same whichever mode the person came from:
  `--bg --grid-dot --card --card-hover --text --text-dim --text-faint --line --edge --neutral --chrome
  --chrome-border --chrome-hover --shadow --shadow-lg --accent`. Write them in one block:
  `body.theme-dark, body.theme-light { ... }`.
- **Accent (partial theme)**: leave `base` out (or add `"partial": true`). It changes only a few things (say, the accent)
  on top of the full theme in use (one accent at a time; clicking it again takes it off). Set those variables in
  `html body.theme-dark { }` and `html body.theme-light { }` (the `html body` makes them win over the full theme).
  It is listed under "Accents" in the app.

The preview on the Themes page is drawn from these values.

## Icon

`icon` is the picture on the mod's card. Always give one. It is the `d` of a single SVG path, drawn as a 1.5px line
(no fill) inside a 20 by 20 box: keep it within 3 to 17 on both axes, simple, a few strokes, in the style of a line
icon that hints at what the mod does. Only path commands and numbers are allowed (several shapes = several `M`
sub-paths in the one string). Without it the card shows the first letter of the name.

## Two kinds (`kind`)

`kind` is technical, not something people browse by: it tells Mindview whether the mod stores anything in projects.


- **usage**: changes how *you* use Mindview: shortcuts, themes, buttons. Nothing is saved in the project.
  "This project" is remembered on your computer only.
- **content**: changes what a project *contains*: text styles, new kinds of notes, media. Whatever it stores is saved
  in the project. A project that uses a content mod records that it needs it, and anyone opening the project without
  the mod is asked to add it. In a shared project the mod package travels with the project (folder `mods/`).

## The toolkit (`api`)

Usage:
- `api.addStyle(css)` add CSS (themes: override the variables on `.theme-dark` / `.theme-light`, e.g. `--bg --card --text --accent --line`)
- `api.addKey('ctrl+shift+k', fn)` a shortcut; it wins over the built-in one with the same keys
- `api.addButton({ label, onClick })` a button in the top bar
- `api.addMenuItem(label, fn, show)` an item in a note's right-click menu; `label` may be `note => text`; `show(note)` may hide it
- `api.addElement(el)` add your own panel to the window
- `api.on('open', doc => {})`, `api.on('render', () => {})`, `api.on('note', (el, note) => {})`, `api.on('body', (el, note) => {})` (the description panel's text block, when it shows a note), `api.on('select', id => {})`
- `api.onCleanup(fn)` undo anything else you did; everything added through the toolkit is removed for you
- `api.toast(text)`

Content (saved in the project under your mod's id, never mixed with the core fields):
- `api.data(note)` / `api.setData(note, value)` your data on one note (`undefined` removes it)
- `api.projectData()` / `api.setProjectData(value)` your data for the whole project

The `'note'` event runs for every note each time the canvas is drawn, before notes are measured. Use it to dress the
note's element from your data, and always clear what you set when the data is gone.

The app itself: `api.app` gives `notes()`, `note(id)`, `children(id)`, `element(id)`, `select(id)`, `goTo(id)`,
`focus(id)`, `edit(id)`, `render()`, `relayout()`, `checkpoint()` (undo point), `save()`, `doc`, `selected`.
These reach into the core and may change between versions; `api.version` tells you the toolkit version.

## Feel and practicality

A mod should feel like it was always part of Mindview.

- Every option the mod adds must be easy to find and easy to change, in the place the person would look for it:
  a style for lines belongs where lines are (for example the right-click menu of the canvas or a note), a mode that
  is switched often gets a small top-bar button that shows the current state. A keyboard shortcut can be extra,
  never the only way in.
- As little text as possible: no descriptions, explanations, hints or tooltips in the interface. Use short labels
  (one or two words) or an icon. The header `description` is one short sentence.
- Show the current state (on/off, which style) at a glance, and let one click change it.
- Match Mindview's look: use the colour variables, the existing button classes (`tb-btn`), rounded corners, quiet
  colours.

## Rules of the road

- Keep your data under `api.setData` / `api.setProjectData`. Projects must still open in the core without your mod.
- A mod is code that runs inside Mindview with access to your projects. Install only mods you trust.
- Look at `theme-ocean.js` and `text-style.js` (included with the app) for complete examples.

## Map of the Mindview window (for CSS and for finding elements)

- `body` has class `theme-dark` or `theme-light`; colours are CSS variables set there: `--bg --card --card-hover --text --text-dim --text-faint --line --edge --neutral --chrome --chrome-border --chrome-hover --accent --shadow --font`.
- Top bar `#titlebar`: left group `.brand` (`.brand-sub` "Mindview", `#btn-mods`, `#btn-ai`, `#project-btn`, `#save-state`, `#btn-share`), right group `.tb-actions` (`#btn-auto` auto-arrange switch, `#btn-tidy`, `#btn-theme`, `#btn-help`). Top bar buttons use class `tb-btn`.
- Menus under the top bar: `#project-menu`, `#share-menu`, `#mods-menu`, `#ai-menu`.
- Canvas `#viewport` > `#world` (moved and scaled for pan/zoom) > `#sections` (frames, `.section` with `.sec-label`), `#edges` (svg, one `path` per line between notes), `#nodes`.
- A note is `.node[data-id]` inside `#nodes`: classes `sm|md|lg`, `selected`, `msel` (multi-selected), `collapsed`, `notext` (zoomed out too far to read: shown as a small chip); its colour is the CSS variable `--c`; its title is the child `.text`.
- Floating parts: `#node-toolbar` (S/M/L and colours, with the right-click menu), `#jump-menu` (the right-click menu of a note), `#note-body` (description panel under the selected note), `#section-toolbar`, `#link-toolbar`, `#toast`, `#help`, `#lightbox`.
- A note object (from `api.app.notes()`): `{ id, parentId, text, body, color, size, url, images, bodyImages, section, x, y }`. Colours: none, amber, red, pink, violet, blue, teal, green.
- Built-in keys you may override with `api.addKey`: Tab (add child), Enter (add sibling / edit), Delete, Ctrl+Z / Ctrl+Y, Ctrl+C / Ctrl+V, Ctrl+O (projects), Ctrl+F (search), Ctrl+L (tidy), Alt+A (AI mode), 1/2/3 (size), ? (help).
