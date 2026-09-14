import { mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localAsset, INTRANET_VERSION } from './server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = process.argv[2];
const license = process.argv[3];
if (!destination || !license) throw new Error('Specify a new output directory and the matching Node.js LICENSE file');
const licenseText = readFileSync(resolve(license), 'utf8');
if (!licenseText.includes('Permission is hereby granted') || !licenseText.includes('Node.js')) throw new Error('Invalid Node.js license');
const target = resolve(destination);
// Fail on existing destinations. Never recursively copy a workspace or data directory.
mkdirSync(target);
const assets = ['index.html', 'cloud-api.js', 'access-control.js', 'cvcs.js', 'cvcs.css', 'token-admin.js', 'galaxy-log.js', 'galaxy-log.css', 'mgm-check-request.js', 'mgm-check-request.css', 'worksheet-editor.js', 'worksheet-editor.css', 'xlsx.mini.min.js', 'manifest.json', 'sw.js', 'icon.png', 'apple-touch-icon.png'];
const modules = ['database.mjs', 'worksheets.mjs', 'runtime.mjs', 'initialize.mjs', 'server.mjs', 'cli.mjs', 'backup.mjs', 'import-workbooks.mjs', 'README.md'];
function copy(name, transform = false) {
  const output = join(target, name);
  mkdirSync(dirname(output), { recursive: true });
  if (transform) writeFileSync(output, localAsset(name, readFileSync(join(root, name), 'utf8')));
  else copyFileSync(join(root, name), output);
}
for (const asset of assets) copy(asset, /\.(html|js)$/.test(asset));
for (const name of modules) copy(`intranet/${name}`);
for (const directory of ['worker/src', 'worker/migrations']) {
  for (const name of readdirSync(join(root, directory))) if (/\.(mjs|sql)$/.test(name)) copy(`${directory}/${name}`);
}
copyFileSync(process.execPath, join(target, 'node.exe'));
writeFileSync(join(target, 'NODE-LICENSE.txt'), licenseText);
writeFileSync(join(target, 'VERSION.txt'), `${INTRANET_VERSION}\nDevelopment test build - not approved for production\n`);
for (const [name, command] of [['Setup', 'setup'], ['Start', 'start']]) {
  writeFileSync(join(target, `${name}.cmd`), `@echo off\r\ncd /d "%~dp0"\r\n"%~dp0node.exe" "%~dp0intranet\\cli.mjs" ${command} "%~dp0data"\r\npause\r\n`);
}
process.stdout.write(`Built ${INTRANET_VERSION}. No database or credentials included.\n`);
