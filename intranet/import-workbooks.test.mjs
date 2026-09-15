import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
