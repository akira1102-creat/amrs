import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorksheets } from './worksheets.mjs';
import { openDatabase } from './database.mjs';
import { createRepository } from '../worker/src/repository.mjs';
import { COMPANIES, companySchema } from '../worker/src/config.mjs';
import { initializeWorkbooks } from './initialize.mjs';

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

test('CVCS records submit and query through local worksheets without public network access', async () => {
  const sheets = openWorksheets(':memory:');
  const db = openDatabase(':memory:');
  initializeWorkbooks(sheets);
  let publicFetchCalls = 0;
  try {
    const config = {
      sheets: Object.fromEntries(COMPANIES.map(company => [company, company])),
      partsSheetId: 'parts', scheduleSheetId: 'schedule', cvcsSheetId: 'cvcs',
      galaxyLogSheetId: 'galaxy-log', mgmCheckRequestSheetId: 'mgm-check-request',
      timeZone: 'Asia/Hong_Kong',
    };
    const repository = createRepository({}, {
      db,
      config,
      sheetsClient: sheets,
      publicFetch: async () => { publicFetchCalls++; throw new Error('External network forbidden'); },
    });
    const serialNo = 'QAOFFLINECVCS0915';
    const submitted = await repository.postAction({ action: 'submitCvcsRecords', records: [{
      property: 'Venetian', date: '2026/09/15', location: 'Cage', model: 'SOT', serialNo,
      reason: 'PM', submissionId: 'synthetic-cvcs-offline',
    }] });
    const listed = await repository.getAction({ action: 'cvcsRecords', serialNo, pageSize: 10, page: 1 });
    assert.equal(submitted.inserted, 1);
    assert.equal(listed.total, 1);
    assert.equal(listed.records[0].serialNo, serialNo);
    assert.equal(publicFetchCalls, 0);
  } finally { db.close(); sheets.close(); }
});

test('whole AMRS read pages use local workbooks without public network access', async () => {
  const sheets = openWorksheets(':memory:');
  const db = openDatabase(':memory:');
  initializeWorkbooks(sheets);
  let publicFetchCalls = 0;
  try {
    const config = {
      sheets: Object.fromEntries(COMPANIES.map(company => [company, company])),
      partsSheetId: 'parts', scheduleSheetId: 'schedule', cvcsSheetId: 'cvcs',
      galaxyLogSheetId: 'galaxy-log', mgmCheckRequestSheetId: 'mgm-check-request',
      timeZone: 'Asia/Hong_Kong',
    };
    const repository = createRepository({}, {
      db,
      config,
      sheetsClient: sheets,
      publicFetch: async () => { publicFetchCalls++; throw new Error('External network forbidden'); },
    });
    for (const company of COMPANIES) {
      const grid = await repository.getAction({ action: 'worksheetGrid', company, page: 'last' });
      assert.equal(grid.success, true);
      assert.equal(grid.company, company);
    }
    const [parts, schedule, monthly, galaxy, mgm, cvcs] = await Promise.all([
      repository.getAction({ action: 'parts' }),
      repository.getAction({ action: 'scheduleOverview', days: 7 }),
      repository.getAction({ action: 'monthlyStats', month: '2609' }),
      repository.getAction({ action: 'galaxyLogOverview', refresh: '1' }),
      repository.getAction({ action: 'mgmCheckRequests', refresh: '1' }),
      repository.getAction({ action: 'cvcsRecords', page: 1, pageSize: 10 }),
    ]);
    assert.ok(Array.isArray(parts.parts));
    assert.ok(schedule && typeof schedule === 'object');
    assert.ok(monthly && typeof monthly === 'object');
    assert.equal(galaxy.success, true);
    assert.equal(mgm.success, true);
    assert.ok(Array.isArray(mgm.requests));
    assert.equal(cvcs.success, true);
    assert.equal(publicFetchCalls, 0);
  } finally { db.close(); sheets.close(); }
});
