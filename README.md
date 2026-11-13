# Mindview

Trees of notes on a zoomable canvas. A portable Windows app: nothing to install.

## Get it

1. Download **Mindview.zip** from the [latest release](https://github.com/Attrom/mindview/releases/latest).
2. Unzip it anywhere.
3. Open `Mindview.exe`. Windows may warn the first time: choose **More info**, then **Run anyway**.

Mindview keeps itself up to date: a new version is fetched in the background and is in place the next time you open the app.

Your notes stay on your PC, in `Documents\Mindview`.

## Mods

Mods and themes published in [`mods/`](mods) appear in Mindview under **Mods > Library**.

## Build from source

```
npm ci
npx @electron/packager . Mindview --platform=win32 --arch=x64 --electron-version=45.2.3 --icon=src/icon.ico --asar
```
