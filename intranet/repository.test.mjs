import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorksheets } from './worksheets.mjs';
import { openDatabase } from './database.mjs';
import { createRepository } from '../worker/src/repository.mjs';
import { COMPANIES, companySchema } from '../worker/src/config.mjs';

test('existing maintenance repository submits and queries against local storage without external requests', async () => {
  const sheets = openWorksheets(':memory:');
  const db = openDatabase(':memory:');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('External network forbidden'); };
  try {
    const config = { sheets: Object.fromEntries(COMPANIES.map(company => [company, company])), partsSheetId: 'parts', scheduleSheetId: 'schedule', timeZone: 'Asia/Hong_Kong' };
    for (const company of COMPANIES) sheets.initialize(company, { Worksheet: [companySchema(company).fields] });
    const repository = createRepository({}, { db, config, sheetsClient: sheets });
    const result = await repository.postAction({ action: 'submitRecords', records: [{ company: 'SCL', casino: 'Venetian', date: '2026/09/14', model: 'SAE', serialNo: '9999', reason: 'PM', actionTaken: 'Preventive Maintenance', inspector: 'Test', poNumber: 'TEST', submissionId: 'synthetic-only' }] });
    assert.equal(result.inserted, 1);
    const page = await repository.getAction({ action: 'dashboard', company: 'SCL', serialNo: '9999', includeParts: '0', refresh: '1' });
    assert.ok(JSON.stringify(page).includes('9999'));
    const repeated = await repository.postAction({ action: 'submitRecords', records: [{ company: 'SCL', casino: 'Venetian', date: '2026/09/14', model: 'SAE', serialNo: '9999', reason: 'PM', actionTaken: 'Preventive Maintenance', inspector: 'Test', poNumber: 'TEST', submissionId: 'synthetic-only' }] });
    assert.equal(repeated.inserted, 0);
    assert.equal(repeated.skipped, 1);
  } finally { globalThis.fetch = originalFetch; db.close(); sheets.close(); }
});
