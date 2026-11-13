# Working on Mindview: guide for an agent

You are helping someone who has just downloaded Mindview and wants to use it, change it, or publish changes.
Read this whole file first. Act on what the person asks; this file tells you where things are and how each job is done.

## What Mindview is

A Windows desktop app: trees of notes on a zoomable canvas. It is portable (a folder with `Mindview.exe`, no installer).

It has two parts:

| Part | Where | Changes when |
|---|---|---|
| The engine (Electron 45.2.3) | `Mindview.exe` and the files beside it | Almost never. Needs a fresh zip. |
| The app itself | `resources\app.asar` beside the exe (about 7 MB) | Every update. This is what the source in `src/` builds into. |

Everything a person makes stays outside the app folder, in `Documents\Mindview`:

- `projects\<id>.json`: one file per project (the notes).
- `mods\<id>.js`: mods the person made or added.
- `settings.json`, `images\`, `backups\`, `repos\` (working copies of shared projects), `update\` (a downloaded update waiting to be applied).

Never put a person's projects, settings or sign-in data into this repository. It is public.

## This repository (`Attrom/mindview`)

- `main` branch: the source.
  - `src/main.js`: main process (files, windows, sharing, mods, update check). Holds `const BUILD = N;`, the version number.
  - `src/app.js`, `src/index.html`, `src/style.css`: the window (canvas, notes, menus).
  - `src/preload.js`: the bridge, exposed to the window as `window.desktop`.
  - `src/share.js`: sharing projects through GitHub. `src/mcp-server.js`: the tools Mindview offers to AI assistants.
  - `src/mods/`: mods and themes that ship inside the app, and `HOW-TO-WRITE-A-MOD.md`.
  - `mods/`: the shared mod Library. Every `<id>.js` here appears in everyone's Mindview under Mods > Library.
  - `tools/pack.js`: builds the app file.
- `updates` branch: only `app.asar` and `version.json` (`{"build": N, "sha256": "..."}`). Every installed Mindview reads this branch.

## How updates reach people

A few seconds after it starts, Mindview fetches `version.json` from the `updates` branch. If its `build` is higher than the
running one, it downloads `app.asar` from the same branch, checks the sha256, and swaps it in when the app closes or next
starts. Nobody runs a command. So: whatever is on the `updates` branch is what everyone gets. Treat a push there as a release.

## Jobs

### 1. Just use the newest Mindview

Nothing to do. Open `Mindview.exe`; close and reopen it once after an update has downloaded.

### 2. Make a mod or a theme (changes looks or behaviour without touching the app)

Prefer this over changing the app whenever it is enough.

- Read `src/mods/HOW-TO-WRITE-A-MOD.md`. A mod is one file named `<id>.js` with a `@mindview-mod` JSON header.
- If Mindview's AI tools are connected to you (AI icon, top right in Mindview), call `mod_guide`, then `save_mod`.
  Otherwise write the file into `Documents\Mindview\mods\` and switch it on in Mindview under Mods.
- To share it with everyone: add the file (and its `<id>/` picture folder, if any) to `mods/` on `main`. Ask the person first.

### 3. Change Mindview itself

Needs Git and Node.js 20 or newer on the PC.

```
git clone https://github.com/Attrom/mindview
cd mindview
npm ci
npm start
```

`npm start` runs Mindview from source. In that mode it keeps its data in the repository folder (`projects/`, `settings.json`, and
so on; all ignored by Git) instead of `Documents\Mindview`, so experiments do not touch real notes. Note that in this mode the
person's mods folder is the repository's `mods/` folder: do not commit a mod from there unless the person wants it published.

Edit files in `src/`, then close and run `npm start` again to see the change.

### 4. Put a change into the installed Mindview on this PC

```
npm run pack
```

This writes `dist/app.asar` and `dist/version.json`. Close Mindview, copy `dist/app.asar` over `resources\app.asar` beside
`Mindview.exe`, and open Mindview again. Keep the old file until the new one is seen to work.

### 5. Publish a change to everyone

Only when the person asks for a release. It cannot be taken back once people have updated.

1. Raise `BUILD` in `src/main.js` by one. An update is only taken when the number is higher.
2. Commit the source to `main` (directly with write access, otherwise as a pull request for the owner to approve).
3. `npm run pack`.
4. Put the two files on the `updates` branch:

```
git worktree add ../mindview-updates updates
copy dist\app.asar ..\mindview-updates\app.asar
copy dist\version.json ..\mindview-updates\version.json
cd ..\mindview-updates
git add app.asar version.json
git commit -m "Build N"
git push origin updates
```

5. Check: `https://raw.githubusercontent.com/Attrom/mindview/updates/version.json` shows the new build (allow a few minutes),
   and its `sha256` matches the pushed `app.asar`. Then start an installed Mindview twice and confirm the change is there.

Pushing needs write access to the repository. The owner gives it under Settings > Collaborators on GitHub. Without it,
open a pull request and stop there.

## Rules the owner has set for the interface

- Minimal text. No instructional hints, no descriptions under controls.
- No hover tooltips, with one exception already in place (the screen-edge arrows show the title of the note they point to).
- No counts on tabs.
- Previews and demos use generic content, never a person's own notes.
- Theme and font are personal choices: they are saved in settings, never in a project file.
- Options must be easy to find where the person is already looking.

## Things that go wrong

- Do not declare a top-level `const desktop` in `src/app.js`. It collides with `window.desktop` and the window stays blank.
- In `src/main.js`, read or write `app.asar` only through `original-fs`. Electron's own `fs` treats `.asar` files as folders.
- After replacing `app.asar`, Mindview must be restarted. A running copy keeps half of the old one.
- Free notes are stored with their position at 100% zoom; in memory they hold the position at the current zoom. Use the
  existing helpers (`canonNodes`, `fromCanon`) when touching save, load or undo.
- A project file may carry data from mods you do not know (`n.mod`, `doc.modData`). Always keep it.
- To test the update check without touching a real install, set `MINDVIEW_UPDATE_URL` (a folder address serving
  `version.json` and `app.asar`) and `MINDVIEW_UPDATE_TARGET` (the file to replace) before `npm start`.
- GitHub sign-in for sharing uses the built-in client ID in `src/main.js`. It is public by design; there is no secret to add.

## When you finish a job

Tell the person what changed, whether it is only on this PC or published to everyone, and that Mindview needs a restart.
