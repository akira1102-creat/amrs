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
  } finally { db.close(); sheets.close(); }
});

test('whole AMRS read pages use local workbooks without public network access', async () => {
  const sheets = openWorksheets(':memory:');
  const db = openDatabase(':memory:');
  initializeWorkbooks(sheets);
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
  } finally { db.close(); sheets.close(); }
});

test('Galaxy Log and MGM Check Request save and reload through local workbooks', async () => {
  const sheets = openWorksheets(':memory:');
  const db = openDatabase(':memory:');
  initializeWorkbooks(sheets);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('External network forbidden'); };
  try {
    const config = {
      sheets: Object.fromEntries(COMPANIES.map(company => [company, company])),
      partsSheetId: 'parts', scheduleSheetId: 'schedule', cvcsSheetId: 'cvcs',
      galaxyLogSheetId: 'galaxy-log', mgmCheckRequestSheetId: 'mgm-check-request',
      timeZone: 'Asia/Hong_Kong',
    };
    const repository = createRepository({}, { db, config, sheetsClient: sheets });
    const galaxy = await repository.postAction({ action: 'syncGalaxyLog', mutations: [{
      mutationId: 'synthetic-galaxy-mutation', taskId: 'synthetic-galaxy-task',
      serialLast4: '1190', fullSerial: 'A02-001190', targetDate: '2026/09/15', groupIndex: 0, duplicateIndex: 0,
      patch: { completedDate: '2026/09/15' },
    }] });
    assert.equal(galaxy.success, true);
    assert.equal(galaxy.results[0].status, 'applied');
    const galaxyRead = await repository.getAction({ action: 'galaxyLogOverview', refresh: '1' });
    assert.equal(galaxyRead.tasks[0].fullSerial, 'A02-001190');
    assert.equal(galaxyRead.tasks[0].completedDate, '2026-09-15');

    const created = await repository.postAction({ action: 'syncMgmCheckRequests', mutations: [{
      mutationId: 'synthetic-mgm-create', requestId: 'synthetic-mgm-request', kind: 'create', sheetName: 'MGM Macau',
      row: { eventDate: '2026/09/15', eventTime: '10:00', table: 'QA TABLE', serialNo: '9988', eventDetails: 'Synthetic offline check' },
    }] });
    assert.equal(created.results[0].status, 'applied');
    const mgmRead = await repository.getAction({ action: 'mgmCheckRequests', refresh: '1' });
    const request = mgmRead.requests.find(item => item.eventDetails === 'Synthetic offline check');
    assert.ok(request);
    const updated = await repository.postAction({ action: 'syncMgmCheckRequests', mutations: [{
      mutationId: 'synthetic-mgm-update', requestId: request.id, sheetName: request.sheetName,
      rowNumber: request.rowNumber, baseVersion: request.version,
      patch: { machineStatus: '已檢查', cardStatus: '已檢查' },
    }] });
    assert.equal(updated.results[0].status, 'applied');
    const confirmed = await repository.getAction({ action: 'mgmCheckRequests', refresh: '1' });
    const savedRequest = confirmed.requests.find(item => item.eventDetails === 'Synthetic offline check');
    assert.equal(savedRequest.machineStatus, '已檢查');
    assert.equal(savedRequest.cardStatus, '已檢查');
    assert.equal(savedRequest.status, 'done');
  } finally { globalThis.fetch = originalFetch; db.close(); sheets.close(); }
});

test('schedule, monthly settings, parts follow-up, templates, and worksheet edits persist locally', async () => {
  const sheets = openWorksheets(':memory:');
  const db = openDatabase(':memory:');
  initializeWorkbooks(sheets);
  try {
    const config = {
      sheets: Object.fromEntries(COMPANIES.map(company => [company, company])),
      partsSheetId: 'parts', scheduleSheetId: 'schedule', cvcsSheetId: 'cvcs',
      galaxyLogSheetId: 'galaxy-log', mgmCheckRequestSheetId: 'mgm-check-request',
      timeZone: 'Asia/Hong_Kong',
    };
    await sheets.valuesUpdate({ spreadsheetId: 'SCL', range: 'Worksheet!A1:J2', values: [
      ['CASINO', 'DATE', 'PO Number', 'Model', 'Serial No.', 'Reason', 'Action Taken', 'Error Description', 'Box ID', 'Inspector'],
      ['Venetian', '2026/09/15', '2609', 'SAE', '9987', 'PM', 'Preventive Maintenance', '', '', 'Synthetic'],
    ] });
    await sheets.valuesUpdate({ spreadsheetId: 'SCL', range: "'Broken Parts List'!A1:N2", values: [
      ['CASINO', 'Model', 'Serial No.', 'Parts No.', 'Required Parts(JP)', 'Required Parts(EN)', 'Qty', 'Repair Day', 'Found Day', 'Remark', 'UOD Activation Date', 'UOD Unlock Date', 'Hold Date', 'Hold Release Date'],
      ['Venetian', 'SAE', '9988', 'AE-1', '部品', 'PART', '1', 'Waiting', '2026/09/14', '', '', '', '', ''],
    ] });
    await sheets.spreadsheetBatchUpdate({ spreadsheetId: 'schedule', requests: [{ addSheet: { properties: { title: '2026-SEP' } } }] });
    await sheets.valuesUpdate({ spreadsheetId: 'schedule', range: "'2026-SEP'!A3:G4", values: [
      ['Day', 'Marco', 'Alex', 'Remark', 'Marco', 'Bea', 'Remark'],
      [15, 'VML / LON', 'VML', 'AM note', 'VML', 'LON', 'PM note'],
    ] });

    const repository = createRepository({}, { db, config, sheetsClient: sheets });
    const template = await repository.postAction({ action: 'updateTemplate', company: 'SCL', mappings: [{ reason: 'PM', action: 'Offline synthetic template' }] });
    assert.equal(template.success, true);
    assert.deepEqual((await repository.getAction({ action: 'template', company: 'SCL', refresh: '1' })).mappings,
      [{ reason: 'PM', action: 'Offline synthetic template' }]);

    const partsSaved = await repository.postAction({ action: 'updateBrokenPartsList', company: 'SCL', records: [{
      rowNumber: 2, casino: 'Venetian', model: 'SAE', serialNo: '9988', brokenParts: 'AE-1',
      bpDesc: '部品', bpColC: 'PART', bpQty: '1', bpRepairDay: '2026/09/15', foundDay: '2026/09/14', bpRemark: 'Local completion',
    }], deletedRowNumbers: [] });
    assert.equal(partsSaved.success, true);
    assert.equal((await repository.getAction({ action: 'brokenPartsList', company: 'SCL', serialNo: '9988', refresh: '1' })).records[0].bpRepairDay, '2026/09/15');

    const settingsSaved = await repository.postAction({ action: 'updateMonthlySettings', company: 'GEG', settings: { targets: { Galaxy: 500, StarWorld: 129 } } });
    assert.deepEqual(settingsSaved.settings.targets, { Galaxy: 500, StarWorld: 129 });
    assert.equal((await repository.getAction({ action: 'monthlySettings', company: 'GEG', refresh: '1' })).settings.targets.Galaxy, 500);

    await repository.postAction({ action: 'updateScheduleRemark', month: '2609', date: '2026/09/15', shift: 'pm', remark: 'Local PM note' });
    await repository.postAction({ action: 'updateSchedulePeople', month: '2609', date: '2026/09/15', shift: 'am', company: 'SCL', venue: 'Londoner', people: ['Alex'] });
    const schedule = (await repository.getAction({ action: 'scheduleOverview', from: '2026/09/15', days: '1', refresh: '1' })).days[0];
    assert.equal(schedule.remarks.pm, 'Local PM note');
    const scheduleRow = (await sheets.valuesGet({ spreadsheetId: 'schedule', range: "'2026-SEP'!A4:G4" })).values[0];
    assert.deepEqual(scheduleRow.slice(1, 3), ['VML', 'VML / LON']);
    assert.deepEqual(scheduleRow.slice(4, 7), ['VML', 'LON', 'Local PM note']);

    const grid = await repository.getAction({ action: 'worksheetGrid', company: 'SCL', page: '1', pageSize: '100', refresh: '1' });
    const row = grid.rows[0];
    const values = row.values.slice();
    values[6] = 'Local grid edit';
    const gridSaved = await repository.postAction({ action: 'updateWorksheetGrid', company: 'SCL', mutations: [{ ...row, values, originalValues: row.values }] });
    assert.equal(gridSaved.saved, 1);
    assert.equal((await repository.getAction({ action: 'worksheetGrid', company: 'SCL', page: '1', pageSize: '100', refresh: '1' })).rows[0].values[6], 'Local grid edit');
  } finally { db.close(); sheets.close(); }
});
