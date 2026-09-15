import { resolve } from 'node:path';
import { openRuntime } from './runtime.mjs';
import { createIntranetServer } from './server.mjs';
import { intranetStartupMessage } from './network-policy.mjs';
import { createAccessToken, listAccessTokens } from '../worker/src/access-tokens.mjs';
import { saveWorksheetBackup } from './backup.mjs';
import { openWorksheets } from './worksheets.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { readWorkbookManifest } from './import-workbooks.mjs';

const [command = 'start', folder = './intranet-data'] = process.argv.slice(2);
const directory = resolve(folder);
if (command === 'setup') {
  const runtime = openRuntime(directory);
  try {
    if ((await listAccessTokens(runtime.db)).length) throw new Error('已完成首次設定，請使用現有管理員登入管理用戶。');
    const result = await createAccessToken(runtime.db, { label: '內網管理員', permissions: ['ae', 'cvcs', 'schedule', 'admin'] });
    process.stdout.write(`首次設定完成。請妥善保存以下管理員 Token，並在 AMRS 登入畫面輸入：\n${result.token}\n`);
  } finally { runtime.close(); }
} else if (command === 'backup') {
  const destination = process.argv[4];
  const database = resolve(directory, 'worksheets.sqlite');
  if (!destination || !existsSync(database)) throw new Error('請指定現有資料目錄及新備份檔案：backup <資料目錄> <新檔案.json>');
  const sheets = openWorksheets(database);
  try {
    const result = saveWorksheetBackup(sheets, resolve(destination));
    process.stdout.write(`已備份 ${result.workbooks} 個資料簿（不包含登入憑證）。\n`);
  } finally { sheets.close(); }
} else if (command === 'restore' || command === 'import') {
  const source = process.argv[4];
  const database = resolve(directory, 'worksheets.sqlite');
  if (!source || existsSync(directory)) throw new Error('還原請使用全新資料目錄：restore <新資料目錄> <備份.json>；不會覆蓋現有資料。');
  const snapshot = command === 'import' ? readWorkbookManifest(resolve(source)) : JSON.parse(readFileSync(resolve(source), 'utf8'));
  const sheets = openWorksheets(database);
  try {
    sheets.restoreEmpty(snapshot);
    process.stdout.write('工作表已還原至新目錄。請執行 setup 建立此主機的登入憑證。\n');
  } finally { sheets.close(); }
} else if (command === 'start') {
  const app = createIntranetServer({ directory });
  const port = Number(process.env.AMRS_PORT || 8080);
  app.server.listen(port, process.env.AMRS_HOST || '0.0.0.0', () => {
    process.stdout.write(intranetStartupMessage(port));
  });
  const stop = () => app.close().then(() => process.exit(0));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} else {
  throw new Error('支援指令：setup、start、backup、restore、import');
}
