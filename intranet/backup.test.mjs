import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorksheets } from './worksheets.mjs';
import { saveWorksheetBackup } from './backup.mjs';

test('data backup preserves all worksheets and never overwrites an existing file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amrs-backup-test-'));
  const sheets = openWorksheets(':memory:');
  try {
    sheets.initialize('example', { Worksheet: [['SN', 'Date']], Monthly: [['Total', 0]] });
    await sheets.valuesUpdate({ spreadsheetId: 'example', range: 'Worksheet!A3', values: [['synthetic']] });
    const destination = join(directory, 'backup.json');
    assert.equal(saveWorksheetBackup(sheets, destination).workbooks, 1);
    const content = readFileSync(destination, 'utf8');
    const snapshot = JSON.parse(content);
    assert.equal(snapshot.format, 'amrs-local-worksheets');
    assert.deepEqual(snapshot.workbooks[0].sheets[0].values, [['SN', 'Date'], null, ['synthetic']]);
    assert.deepEqual(snapshot.workbooks[0].sheets[1].values, [['Total', 0]]);
    assert.throws(() => saveWorksheetBackup(sheets, destination), { code: 'EEXIST' });
    assert.equal(readFileSync(destination, 'utf8'), content);
  } finally { sheets.close(); rmSync(directory, { recursive: true, force: true }); }
});
