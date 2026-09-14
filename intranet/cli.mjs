import { resolve } from 'node:path';
import { openRuntime } from './runtime.mjs';
import { createIntranetServer } from './server.mjs';
import { createAccessToken, listAccessTokens } from '../worker/src/access-tokens.mjs';
import { saveWorksheetBackup } from './backup.mjs';
import { openWorksheets } from './worksheets.mjs';
import { existsSync } from 'node:fs';

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
} else if (command === 'start') {
  const app = createIntranetServer({ directory });
  const port = Number(process.env.AMRS_PORT || 8080);
  app.server.listen(port, process.env.AMRS_HOST || '0.0.0.0', () => {
    process.stdout.write(`AMRS 內網版已啟動。本機請開啟 http://localhost:${port}\n其他電腦請使用此主機的內網 IP 及相同連接埠。\n`);
  });
  const stop = () => app.close().then(() => process.exit(0));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} else {
  throw new Error('支援指令：setup、start、backup');
}
