import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkbookManifest, workbookFromBytes } from './import-workbooks.mjs';
import { openWorksheets } from './worksheets.mjs';
const XLSX = createRequire(import.meta.url)('../xlsx.mini.min.js');

test('local Excel conversion preserves tabs, formatted identifiers and merged rows', async () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['SN', 'Date'], ['EXAMPLE-0001', '2026/01/01'], ['', '2026/01/02']]);
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

test('imports a complete mapping for every AMRS workbook', () => {
  const directory = mkdtempSync(join(tmpdir(), 'amrs-import-'));
  const filename = join(directory, 'manifest.json');
  const workbookIds = ['Melco', 'MGM', 'SJM', 'SCL', 'GEG', 'Wynn', 'parts', 'schedule', 'cvcs', 'galaxy-log', 'mgm-check-request'];
  try {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Example']]), 'Data');
    const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    const manifest = Object.fromEntries(workbookIds.map(id => {
      const file = `${id}.xlsx`;
      writeFileSync(join(directory, file), bytes);
      return [id, file];
    }));
    writeFileSync(filename, JSON.stringify(manifest));
    assert.deepEqual(readWorkbookManifest(filename).workbooks.map(workbook => workbook.id), workbookIds);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
