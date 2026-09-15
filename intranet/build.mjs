import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
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
const assets = ['index.html', 'access-control.js', 'cvcs.js', 'cvcs.css', 'token-admin.js', 'galaxy-log.js', 'galaxy-log.css', 'mgm-check-request.js', 'mgm-check-request.css', 'worksheet-editor.js', 'worksheet-editor.css', 'intranet-transport.js', 'xlsx.mini.min.js', 'manifest.json', 'sw.js', 'icon.png', 'apple-touch-icon.png'];
const modules = ['database.mjs', 'worksheets.mjs', 'runtime.mjs', 'network-policy.mjs', 'initialize.mjs', 'cli.mjs', 'backup.mjs', 'import-workbooks.mjs', 'README.md'];
const localWorkerModules = ['access-tokens.mjs', 'api.mjs', 'auth.mjs', 'config.mjs', 'cvcs-domain.mjs', 'cvcs-repository.mjs', 'crypto.mjs', 'domain.mjs', 'http.mjs', 'repository.mjs', 'sheet-utils.mjs', 'state.mjs'];
function copy(name, transform = false) {
  const output = join(target, name);
  mkdirSync(dirname(output), { recursive: true });
  const source = name === 'intranet-transport.js' ? join(root, 'intranet', 'transport.browser.js') : join(root, name);
  if (transform) writeFileSync(output, localAsset(name, readFileSync(source, 'utf8')));
  else copyFileSync(source, output);
}
for (const asset of assets) copy(asset, /\.(html|js)$/.test(asset));
for (const name of modules) copy(`intranet/${name}`);
mkdirSync(join(target, 'intranet'), { recursive: true });
copyFileSync(join(root, 'intranet/package-server.mjs'), join(target, 'intranet/server.mjs'));
for (const name of localWorkerModules) copy(`worker/src/${name}`);
for (const name of ['0001_submission_state.sql', '0002_cache_operations.sql', '0003_access_tokens.sql']) copy(`worker/migrations/${name}`);
copyFileSync(process.execPath, join(target, 'node.exe'));
writeFileSync(join(target, 'NODE-LICENSE.txt'), licenseText);
writeFileSync(join(target, 'VERSION.txt'), `${INTRANET_VERSION}\nDevelopment test build - not approved for production\n`);
for (const [name, command] of [['Setup', 'setup'], ['Start', 'start']]) {
  writeFileSync(join(target, `${name}.cmd`), `@echo off\r\ncd /d "%~dp0"\r\n"%~dp0node.exe" "%~dp0intranet\\cli.mjs" ${command} "%~dp0data"\r\npause\r\n`);
}
writeFileSync(join(target, 'Import.cmd'), [
  '@echo off',
  'setlocal',
  'cd /d "%~dp0"',
  'if "%~1"=="" goto usage',
  'if exist "%~dp0data" goto dataExists',
  'if not exist "%~f1" goto mappingMissing',
  '"%~dp0node.exe" "%~dp0intranet\\cli.mjs" import "%~dp0data" "%~f1"',
  'if errorlevel 1 goto importFailed',
  'echo.',
  'echo Excel 資料已搬入。請再執行 Setup.cmd 建立管理員 Token，然後執行 Start.cmd。',
  'pause',
  'exit /b 0',
  ':usage',
  'echo 用法：Import.cmd "mapping.json"',
  'echo 請先列出 11 個 AMRS 工作簿的 Excel 檔案映射，並在首次 Setup.cmd 前執行。',
  'exit /b 2',
  ':dataExists',
  'echo 已有 data 資料夾。為免覆蓋資料，匯入已停止；請聯絡管理員。',
  'pause',
  'exit /b 2',
  ':mappingMissing',
  'echo 找不到指定 mapping.json，請確認路徑。',
  'pause',
  'exit /b 2',
  ':importFailed',
  'echo Excel 匯入失敗。原 Excel 檔案不會被修改；請按畫面錯誤修正後再試。',
  'pause',
  'exit /b 1',
  '',
].join('\r\n'));
process.stdout.write(`Built ${INTRANET_VERSION}. No database or credentials included.\n`);
