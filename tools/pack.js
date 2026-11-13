// Builds dist/app.asar (what Mindview runs) and dist/version.json (what the update check reads).
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const stage = path.join(root, '.build');
const dist = path.join(root, 'dist');

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(dist, { recursive: true });
for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, f), path.join(stage, f));
fs.cpSync(path.join(root, 'src'), path.join(stage, 'src'), { recursive: true });
execSync('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', { cwd: stage, stdio: 'inherit' });

(async () => {
  const out = path.join(dist, 'app.bin'); // not named .asar while it is written, so tools do not mistake it for a folder
  await require('@electron/asar').createPackage(stage, out);
  const build = +/const BUILD = (\d+);/.exec(fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8'))[1];
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
  fs.renameSync(out, path.join(dist, 'app.asar'));
  fs.writeFileSync(path.join(dist, 'version.json'), JSON.stringify({ build, sha256 }) + '\n');
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`dist/app.asar  build ${build}  sha256 ${sha256}`);
})().catch(e => { console.error(e); process.exit(1); });
