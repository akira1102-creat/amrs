import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorksheets } from './worksheets.mjs';

test('local worksheet storage supports repository ranges, appends, atomic edits and row deletion', async () => {
  const sheets = openWorksheets(':memory:');
  try {
    sheets.initialize('example', { Worksheet: [['Header', 'Value'], ['synthetic', 'one']] });
    await sheets.valuesAppend({ spreadsheetId: 'example', range: "'Worksheet'!A:B", values: [['second', 'two']] });
    assert.deepEqual((await sheets.valuesGet({ spreadsheetId: 'example', range: "'Worksheet'!A2:B" })).values, [['synthetic', 'one'], ['second', 'two']]);
    await assert.rejects(sheets.valuesBatchUpdate({ spreadsheetId: 'example', data: [
      { range: "'Worksheet'!B2", values: [['must roll back']] },
      { range: "'Missing'!A1", values: [['invalid']] },
    ] }));
    assert.deepEqual((await sheets.valuesGet({ spreadsheetId: 'example', range: "'Worksheet'!B2" })).values, [['one']]);
    await sheets.spreadsheetBatchUpdate({ spreadsheetId: 'example', requests: [{ deleteDimension: { range: { sheetId: 1, dimension: 'ROWS', startIndex: 1, endIndex: 2 } } }] });
    assert.deepEqual((await sheets.valuesGet({ spreadsheetId: 'example', range: "'Worksheet'!A2:B" })).values, [['second', 'two']]);
    const created = await sheets.spreadsheetBatchUpdate({ spreadsheetId: 'example', requests: [{ addSheet: { properties: { title: "Test's sheet" } } }] });
    assert.equal(created.replies[0].addSheet.properties.title, "Test's sheet");
    await sheets.valuesUpdate({ spreadsheetId: 'example', range: "'Test''s sheet'!AA3", values: [['local']] });
    assert.deepEqual((await sheets.valuesGet({ spreadsheetId: 'example', range: "'Test''s sheet'!AA3:AB" })).values, [['local']]);
    assert.deepEqual((await sheets.valuesGet({ spreadsheetId: 'example', range: "'Test''s sheet'!AA1:AB" })).values, [[], [], ['local']]);
    await sheets.valuesUpdate({ spreadsheetId: 'example', range: "'Test''s sheet'!A1001", values: [['last']] });
    const metadata = await sheets.request({ path: 'spreadsheets/example' });
    assert.equal(metadata.sheets[1].properties.gridProperties.rowCount, 1001);
    await sheets.spreadsheetBatchUpdate({ spreadsheetId: 'example', requests: [{ insertDimension: { range: { sheetId: created.replies[0].addSheet.properties.sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 } } }] });
    assert.deepEqual((await sheets.valuesGet({ spreadsheetId: 'example', range: "'Test''s sheet'!AB3" })).values, [['local']]);
  } finally { sheets.close(); }
});
