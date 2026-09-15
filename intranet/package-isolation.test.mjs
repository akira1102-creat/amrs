import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const XLSX = createRequire(import.meta.url)('../xlsx.mini.min.js');
const companyWidths = { Melco: 10, MGM: 11, SJM: 10, SCL: 10, GEG: 12, Wynn: 10 };

function syntheticWorkbookBytes(id) {
  const headers = ['CASINO', 'Date', 'PO Number', 'Model', 'Serial No.', 'Reason', 'Action', 'Error', 'Box ID', 'Inspector', 'Location', 'Extra'];
  const companySheets = [
    ['Worksheet', [headers.slice(0, companyWidths[id])]],
    ['Broken Parts List', [['CASINO', 'Model', 'Serial No.', 'Parts No.', 'Required Parts(JP)', 'Required Parts(EN)', 'Qty', 'Repair Day', 'Found Day', 'Remark', 'UOD Activation Date', 'UOD Unlock Date', 'Hold Date', 'Hold Release Date']]],
    ['Template', [['Reason', 'Action']]], ['AA TAG', [['Serial No.', 'AA Tag']]], ['Monthly', []],
  ];
  const mgmHeaders = ['事發日期', '事發時間', '結束時間', 'Table', 'Serial NO.', 'AA Tag', 'BOX ID', 'Vault ID', '事件詳情', '機台跟進狀況', '實牌跟進狀況', '備注', '欄1'];
  const tabs = companyWidths[id] ? companySheets : {
    parts: [['Parts Code', [['Parts No.', 'Required Parts(JP)', 'Required Parts(EN)']]]],
    schedule: [['Setup', [['Setting', 'Value']]]],
    cvcs: [
      ['CVCS Records', [['Property', 'Date', 'Location', 'Sub Location', 'Quarter', 'Model', 'S/N', 'Antenna Size', 'Antenna Status', 'Version', 'Reason', 'Action Taken & Notes', 'Parts Change']]],
      ['CVCS Broken Parts', [['Property', 'Model', 'S/N', 'Parts No.', 'Required Parts (EN)', 'Qty', 'Repair Day', 'Found Day', 'Remark', 'Request Follow-up Date', 'Follow-up Completed Date']]],
      ['CVCS Parts List', [['Parts No.', 'Required Parts (EN)']]],
      ...['Sub Location', 'Antenna Size', 'Antenna Status', 'Version', 'Reason Action Mapping', 'Parts Change'].map(title => [title, [[title]]]),
    ],
    'galaxy-log': [['Galaxy Log', [['SN', '指定 Log 日期', '取 Log 日期']]]],
    'mgm-check-request': [['MGM Macau', [mgmHeaders]], ['MGM Cotai', [mgmHeaders]]],
  }[id];
  const book = XLSX.utils.book_new();
  for (const [title, values] of tabs) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(values), title);
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test('built intranet package contains no public network clients or endpoints and runs its full local app', async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'amrs-intranet-isolation-'));
  const packageDirectory = join(temporaryRoot, 'package');
  const licenseFile = join(temporaryRoot, 'NODE-LICENSE.txt');
  let app;
  try {
    writeFileSync(licenseFile, 'Node.js\nPermission is hereby granted, free of charge.\n');
    execFileSync(process.execPath, [join(root, 'intranet/build.mjs'), packageDirectory, licenseFile], { cwd: root, stdio: 'pipe' });

    const forbidden = [
      'cloud-api.js',
      'worker/src/index.mjs',
      'worker/src/google.mjs',
      'worker/src/sheets.mjs',
      'worker/src/google-crypto.mjs',
      'worker/src/public-galaxy.mjs',
      'worker/src/cloudflare-cache.mjs',
    ].filter(path => existsSync(join(packageDirectory, path)));
    assert.deepEqual(forbidden, [], 'the package must not include cloud/GAS or Google API clients');
    assert.ok(existsSync(join(packageDirectory, 'intranet-transport.js')), 'the package should include its local-only transport');
    assert.ok(existsSync(join(packageDirectory, 'Import.cmd')), 'the package should offer a guided Excel import before setup');
    const packagedNode = join(packageDirectory, 'node.exe');
    assert.equal(execFileSync(packagedNode, ['--version'], { encoding: 'utf8' }).trim(), process.version);
    const workbookIds = ['Melco', 'MGM', 'SJM', 'SCL', 'GEG', 'Wynn', 'parts', 'schedule', 'cvcs', 'galaxy-log', 'mgm-check-request'];
    const sourceDirectory = join(temporaryRoot, 'source-workbooks');
    mkdirSync(sourceDirectory);
    const mapping = Object.fromEntries(workbookIds.map(id => {
      const filename = join(sourceDirectory, `${id}.xlsx`);
      writeFileSync(filename, syntheticWorkbookBytes(id));
      return [id, filename];
    }));
    const mappingFile = join(sourceDirectory, 'mapping.json');
    writeFileSync(mappingFile, JSON.stringify(mapping));
    const importCommand = join(packageDirectory, 'Import.cmd');
    const dataDirectory = join(packageDirectory, 'data');
    if (process.platform === 'win32') {
      const asPowerShellLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
      const script = `& ${asPowerShellLiteral(importCommand)} ${asPowerShellLiteral(mappingFile)}; exit $LASTEXITCODE`;
      execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', input: '\r\n' });
    } else {
      execFileSync(packagedNode, [join(packageDirectory, 'intranet', 'cli.mjs'), 'import', dataDirectory, mappingFile], { encoding: 'utf8' });
    }
    const localWorksheets = await import(pathToFileURL(join(packageDirectory, 'intranet', 'worksheets.mjs')).href);
    const imported = localWorksheets.openWorksheets(join(dataDirectory, 'worksheets.sqlite'));
    try { assert.deepEqual(imported.snapshot().workbooks.map(workbook => workbook.id).sort(), workbookIds.slice().sort()); }
    finally { imported.close(); }
    const setupOutput = execFileSync(packagedNode, [join(packageDirectory, 'intranet', 'cli.mjs'), 'setup', dataDirectory], { encoding: 'utf8' });
    assert.match(setupOutput, /首次設定完成/);

    const publicEndpoints = [];
    for (const path of filesUnder(packageDirectory).filter(path => /\.(?:html|js|mjs)$/.test(path))) {
      const content = readFileSync(path, 'utf8');
      if (/https?:\/\/(?:[^/\s"'`]+\.)?(?:googleapis\.com|google\.com|workers\.dev)\b|https?:\/\/amrs-cache\.invalid\b|(?:googleapis\.com|google\.com|workers\.dev|script\.google\.com)/i.test(content)) {
        publicEndpoints.push(relative(packageDirectory, path));
      }
    }
    assert.deepEqual(publicEndpoints, [], 'packaged application code must contain no public service endpoints');
    const packagedServiceWorker = readFileSync(join(packageDirectory, 'sw.js'), 'utf8');
    assert.match(packagedServiceWorker, /intranet-transport\.js/);
    assert.doesNotMatch(packagedServiceWorker, /cloud-api\.js|script\.google\.com/);

    const packagedServer = await import(pathToFileURL(join(packageDirectory, 'intranet', 'server.mjs')).href);
    const packagedVersion = packagedServer.INTRANET_VERSION;
    app = packagedServer.createIntranetServer({ directory: join(temporaryRoot, 'runtime-data') });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const page = await fetch(base);
    assert.equal(page.status, 200);
    const html = await page.text();
    const [handlePackagedRequest] = app.server.listeners('request');
    async function packagedRequestFrom(remoteAddress, url = '/') {
      const incoming = {
        socket: { remoteAddress }, method: 'GET', url, headers: {},
        async *[Symbol.asyncIterator]() {},
      };
      const outgoing = {
        headersSent: false,
        writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; this.headersSent = true; },
        end(body) { this.body = body; },
      };
      await handlePackagedRequest(incoming, outgoing);
      return outgoing;
    }
    assert.equal((await packagedRequestFrom('203.0.113.9')).statusCode, 403, 'the packaged server must deny public sources');
    assert.equal((await packagedRequestFrom('203.0.113.9', '/api?action=ping')).statusCode, 403, 'public sources must not reach AMRS data APIs');
    assert.equal((await packagedRequestFrom('192.168.10.20')).statusCode, 200, 'office private-network sources must still load the app');
    assert.equal((await packagedRequestFrom('192.168.10.20', '/api?action=ping')).statusCode, 401, 'office clients must reach normal Token authentication');
    assert.ok(html.includes(`script src="./intranet-transport.js?v=${packagedVersion}"`));
    assert.doesNotMatch(html, /cloud-api\.js|google\.com|workers\.dev/);
    assert.ok(packagedServiceWorker.includes(`const CACHE = '${packagedVersion}';`));
    for (const asset of [
      'access-control.js', 'cvcs.js', 'cvcs.css', 'token-admin.js', 'galaxy-log.js', 'galaxy-log.css',
      'mgm-check-request.js', 'mgm-check-request.css', 'worksheet-editor.js', 'worksheet-editor.css',
      'intranet-transport.js', 'xlsx.mini.min.js', 'manifest.json', 'sw.js', 'icon.png', 'apple-touch-icon.png',
    ]) assert.equal((await fetch(`${base}/${asset}?v=${packagedVersion}`)).status, 200, `${asset} is part of the local AMRS app`);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  } finally {
    if (app) await app.close();
    if (temporaryRoot.startsWith(tmpdir())) rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
