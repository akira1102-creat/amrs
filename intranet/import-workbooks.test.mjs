import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as importWorkbooks from './import-workbooks.mjs';
import { readWorkbookManifest, workbookFromBytes } from './import-workbooks.mjs';
import { openWorksheets } from './worksheets.mjs';
const XLSX = createRequire(import.meta.url)('../xlsx.mini.min.js');
const workbookIds = ['Melco', 'MGM', 'SJM', 'SCL', 'GEG', 'Wynn', 'parts', 'schedule', 'cvcs', 'galaxy-log', 'mgm-check-request'];
const companyWidths = { Melco: 10, MGM: 11, SJM: 10, SCL: 10, GEG: 12, Wynn: 10 };

function syntheticWorkbookBytes(id, { omitSheet = '', mainTitle = 'Worksheet', mainWidth = companyWidths[id] } = {}) {
  const companySheets = [
    [mainTitle, [Array.from({ length: mainWidth }, (_, index) => `Field ${index + 1}`)]],
    ['Broken Parts List', [['CASINO', 'Model', 'Serial No.', 'Parts No.', 'Required Parts(JP)', 'Required Parts(EN)', 'Qty', 'Repair Day', 'Found Day', 'Remark', 'UOD Activation Date', 'UOD Unlock Date', 'Hold Date', 'Hold Release Date']]],
    ['Template', [['Reason', 'Action'], ['PM', 'Preventive Maintenance']]],
    ['AA TAG', [['Serial No.', 'AA Tag']]],
    ['Monthly', []],
  ];
  const mgmHeaders = ['事發日期', '事發時間', '結束時間', 'Table', 'Serial NO.', 'AA Tag', 'BOX ID', 'Vault ID', '事件詳情', '機台跟進狀況', '實牌跟進狀況', '備注', '欄1'];
  const cvcsOptionSheets = [
    'Sub Location', 'Antenna Size', 'Antenna Status', 'Version', 'Reason Action Mapping', 'Parts Change',
  ];
  const worksheets = companyWidths[id] ? companySheets : {
    parts: [['Parts Code', [['Parts No.', 'Required Parts(JP)', 'Required Parts(EN)']]]],
    schedule: [['Setup', [['Setting', 'Value']]]],
    cvcs: [
      ['CVCS Records', [['Property', 'Date', 'Location', 'Sub Location', 'Quarter', 'Model', 'S/N', 'Antenna Size', 'Antenna Status', 'Version', 'Reason', 'Action Taken & Notes', 'Parts Change']]],
      ['CVCS Broken Parts', [['Property', 'Model', 'S/N', 'Parts No.', 'Required Parts (EN)', 'Qty', 'Repair Day', 'Found Day', 'Remark', 'Request Follow-up Date', 'Follow-up Completed Date']]],
      ['CVCS Parts List', [['Parts No.', 'Required Parts (EN)']]],
      ...cvcsOptionSheets.map(title => [title, [title === 'Reason Action Mapping' ? ['Reason', 'Action Taken & Notes'] : [title]]]),
    ],
    'galaxy-log': [['Galaxy Log', [['SN', '指定 Log 日期', '取 Log 日期']]]],
    'mgm-check-request': [['MGM Macau', [mgmHeaders]], ['MGM Cotai', [mgmHeaders]]],
  }[id];
  const book = XLSX.utils.book_new();
  for (const [title, values] of worksheets) {
    if (title !== omitSheet) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(values), title);
  }
  if (!book.SheetNames.length) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Synthetic fallback']]), 'Data');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

function writeCompleteManifest(directory, overrides = {}) {
  const manifest = Object.fromEntries(workbookIds.map(id => {
    const file = `${id}.xlsx`;
    writeFileSync(join(directory, file), overrides[id] || syntheticWorkbookBytes(id));
    return [id, file];
  }));
  const filename = join(directory, 'manifest.json');
  writeFileSync(filename, JSON.stringify(manifest));
  return filename;
}

function writeCompleteSelection(directory, overrides = {}) {
  return workbookIds.map(id => {
    const filename = join(directory, `${id}.xlsx`);
    writeFileSync(filename, overrides[id] || syntheticWorkbookBytes(id));
    return { id, file: filename };
  });
}

function withoutFormulaResult(bytes, worksheetPath, formula, cachedValue) {
  const zip = Buffer.from(bytes);
  let eocd = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65_557); offset--) {
    if (zip.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  assert.notEqual(eocd, -1, 'fixture should be a ZIP workbook');
  let central = zip.readUInt32LE(eocd + 16);
  const entries = zip.readUInt16LE(eocd + 10);
  for (let index = 0; index < entries; index++) {
    const nameLength = zip.readUInt16LE(central + 28);
    const extraLength = zip.readUInt16LE(central + 30);
    const commentLength = zip.readUInt16LE(central + 32);
    const name = zip.toString('utf8', central + 46, central + 46 + nameLength);
    if (name === worksheetPath) {
      assert.equal(zip.readUInt16LE(central + 10), 0, 'fixture worksheet should use stored ZIP entries');
      const local = zip.readUInt32LE(central + 42);
      const localNameLength = zip.readUInt16LE(local + 26);
      const localExtraLength = zip.readUInt16LE(local + 28);
      const dataOffset = local + 30 + localNameLength + localExtraLength;
      const dataLength = zip.readUInt32LE(central + 24);
      const xml = zip.toString('utf8', dataOffset, dataOffset + dataLength);
      const result = `<f>${formula}</f><v>${cachedValue}</v>`;
      const resultOffset = xml.indexOf(result);
      assert.notEqual(resultOffset, -1, 'fixture should contain the requested cached formula result');
      const valueXml = `<v>${cachedValue}</v>`;
      const withoutResult = Buffer.from(`${xml.slice(0, resultOffset)}<f>${formula}</f>${' '.repeat(valueXml.length)}${xml.slice(resultOffset + result.length)}`);
      assert.equal(withoutResult.length, dataLength, 'removing the cached result should preserve the ZIP entry length');
      withoutResult.copy(zip, dataOffset);
      const crc = (() => {
        let value = 0xffffffff;
        for (const byte of withoutResult) {
          value ^= byte;
          for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
        }
        return (value ^ 0xffffffff) >>> 0;
      })();
      zip.writeUInt32LE(crc, local + 14);
      zip.writeUInt32LE(crc, central + 16);
      return zip;
    }
    central += 46 + nameLength + extraLength + commentLength;
  }
  assert.fail(`fixture is missing worksheet ${worksheetPath}`);
}

test('local Excel conversion preserves tabs, formatted identifiers and merged rows', async () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['SN', 'Date', 'Collected'], ['EXAMPLE-0001', '2026/01/01', ''], ['', '2026/01/02', '']]);
  sheet['!merges'] = [{ s: { r: 1, c: 0 }, e: { r: 2, c: 0 } }];
  XLSX.utils.book_append_sheet(book, sheet, 'Galaxy Log');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Keep', 0]]), 'Other');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const workbook = workbookFromBytes('galaxy-log', bytes);
  assert.equal(workbook.sheets.length, 2);
  const local = openWorksheets(':memory:');
  try {
    local.restoreEmpty({ format: 'amrs-local-worksheets', version: 1, workbooks: [workbook] });
    assert.deepEqual((await local.valuesGet({ spreadsheetId: 'galaxy-log', range: "'Galaxy Log'!A2:B3" })).values,
      [['EXAMPLE-0001', '2026/01/01'], ['EXAMPLE-0001', '2026/01/02']]);
    assert.throws(() => workbookFromBytes('unknown', bytes), /Unknown/);
  } finally { local.close(); }
});

test('rejects Excel formulas without saved results instead of silently importing blank cells', () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['SN', '指定 Log 日期', '取 Log 日期'],
    ['SYNTHETIC-LOG-0001', 0, ''],
  ]);
  sheet.B2 = { t: 'n', v: 1, f: '1+1' };
  XLSX.utils.book_append_sheet(book, sheet, 'Galaxy Log');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: false });
  assert.equal(workbookFromBytes('galaxy-log', bytes).sheets[0].values[1][1], '1', 'formula with a saved result should import its cached value');
  const uncalculated = withoutFormulaResult(bytes, 'xl/worksheets/sheet1.xml', '1+1', '1');
  const sheetXml = Buffer.from(XLSX.CFB.find(XLSX.CFB.read(uncalculated, { type: 'buffer' }), '/xl/worksheets/sheet1.xml').content).toString('utf8');
  const formulaCell = sheetXml.match(/<c\b(?=[^>]*\br="B2")[^>]*>([\s\S]*?)<\/c>/)?.[1];
  assert.match(formulaCell, /<f>1\+1<\/f>/, 'fixture should preserve the formula');
  assert.doesNotMatch(formulaCell, /<v\b/, 'fixture should remove the saved result');

  assert.throws(() => workbookFromBytes('galaxy-log', uncalculated), /galaxy-log.*formula without a saved result.*Galaxy Log.*B2/i);
});

test('rejects a company workbook whose maintenance worksheet is too narrow for its AMRS schema', () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['CASINO'], ['Venetian']]), 'Worksheet');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  assert.throws(() => workbookFromBytes('SCL', bytes), /SCL.*Worksheet.*10 columns/i);
});

test('rejects a shared AMRS workbook when a required service worksheet is missing', () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Property', 'Date']]), 'CVCS Records');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  assert.throws(() => workbookFromBytes('cvcs', bytes), /cvcs.*CVCS Broken Parts/i);
});

test('rejects incomplete workbook mappings before importing a partial AMRS dataset', () => {
  const directory = mkdtempSync(join(tmpdir(), 'amrs-import-'));
  const filename = join(directory, 'manifest.json');
  try {
    writeFileSync(filename, JSON.stringify({ SCL: 'missing.xlsx' }));
    assert.throws(() => readWorkbookManifest(filename), /Missing workbook mappings: Melco, MGM, SJM, GEG, Wynn, parts, schedule, cvcs, galaxy-log, mgm-check-request/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const [id, missingTitle] of [
  ['schedule', 'Setup'],
  ['cvcs', 'CVCS Broken Parts'],
  ['mgm-check-request', 'MGM Cotai'],
]) test(`rejects ${id} workbook imports that omit ${missingTitle}`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'amrs-import-'));
  try {
    const filename = writeCompleteManifest(directory, {
      [id]: syntheticWorkbookBytes(id, { omitSheet: missingTitle }),
    });
    assert.throws(() => readWorkbookManifest(filename), new RegExp(`${id}.*${missingTitle}`));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('imports a complete mapping with AMRS worksheet structures for every workbook', () => {
  const directory = mkdtempSync(join(tmpdir(), 'amrs-import-'));
  try {
    const filename = writeCompleteManifest(directory);
    assert.deepEqual(readWorkbookManifest(filename).workbooks.map(workbook => workbook.id), workbookIds);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('imports selected Excel files directly without requiring a mapping manifest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'amrs-import-selected-'));
  try {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['SN', '指定 Log 日期', '取 Log 日期'],
      ['SYNTHETIC-LOG-0001', '2026/05/17', ''],
    ]), 'Galaxy Log');
    const selections = writeCompleteSelection(directory, {
      'galaxy-log': XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }),
    });

    assert.equal(typeof importWorkbooks.readSelectedWorkbooks, 'function');
    const snapshot = importWorkbooks.readSelectedWorkbooks(selections);
    assert.deepEqual(snapshot.workbooks.map(workbook => workbook.id), workbookIds);
    assert.deepEqual(snapshot.workbooks.find(workbook => workbook.id === 'galaxy-log').sheets[0].values[1],
      ['SYNTHETIC-LOG-0001', '2026/05/17', '']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects duplicate selections instead of silently replacing one workbook role', () => {
  const directory = mkdtempSync(join(tmpdir(), 'amrs-import-selected-'));
  try {
    const selections = writeCompleteSelection(directory);
    selections[selections.length - 1] = { id: 'SCL', file: selections[selections.length - 1].file };
    assert.equal(typeof importWorkbooks.readSelectedWorkbooks, 'function');
    assert.throws(() => importWorkbooks.readSelectedWorkbooks(selections), /Duplicate workbook selection.*SCL/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a partial file-picker selection before attempting to read any workbook', () => {
  const directory = mkdtempSync(join(tmpdir(), 'amrs-import-selected-'));
  try {
    const selections = writeCompleteSelection(directory).slice(1);
    assert.equal(typeof importWorkbooks.readSelectedWorkbooks, 'function');
    assert.throws(() => importWorkbooks.readSelectedWorkbooks(selections), /Missing workbook selections: Melco/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('treats a cancelled Windows workbook picker as a safe no-op', () => {
  assert.equal(typeof importWorkbooks.selectWorkbookFiles, 'function');
  const selected = importWorkbooks.selectWorkbookFiles({
    platform: 'win32',
    spawn: () => ({ status: 2, stdout: '', stderr: '' }),
  });
  assert.equal(selected, null);
});

test('decodes selected workbook paths without corrupting Unicode filenames', () => {
  const expected = [{ id: 'SCL', file: 'C:\\Synthetic\\AMRS 維護記錄.xlsx' }];
  const stdout = Buffer.from(JSON.stringify(expected), 'utf8').toString('base64');
  assert.equal(typeof importWorkbooks.selectWorkbookFiles, 'function');
  const selected = importWorkbooks.selectWorkbookFiles({
    platform: 'win32',
    spawn: () => ({ status: 0, stdout: `${stdout}\r\n`, stderr: '' }),
  });
  assert.deepEqual(selected, expected);
});
