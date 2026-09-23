import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { parseOptions, runCycle } from './cli.mjs';

function fixtureDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE customers (Id INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE branches (Id INTEGER PRIMARY KEY, CustomerId INTEGER, Name TEXT);
    CREATE TABLE installations (Id INTEGER PRIMARY KEY, SystemNo TEXT, IsActive INTEGER, CustomerId INTEGER, BranchId INTEGER);
    CREATE TABLE product_assets (Id INTEGER PRIMARY KEY, SerialNumber TEXT, IsDeleted INTEGER);
    CREATE TABLE installation_devices (InstallationId INTEGER, ProductAssetId INTEGER);
    CREATE TABLE maintenance_batches (Id INTEGER PRIMARY KEY, MaintenanceDate TEXT, Remarks TEXT);
    INSERT INTO customers VALUES (1, 'Sample Customer');
    INSERT INTO branches VALUES (10, 1, 'Sample Venue');
    INSERT INTO installations VALUES (20, 'SYS-001', 1, 1, 10);
    INSERT INTO product_assets VALUES (30, 'SN-001', 0);
    INSERT INTO installation_devices VALUES (20, 30);
  `);
  return db;
}

const record = {
  recordId: 'record-001', company: 'SCL', casino: 'Sample Venue',
  date: '2026/09/20', serialNo: 'SN-001', actionTaken: 'Tested',
};

test('CLI defaults to full-history preview and rejects unknown arguments', () => {
  assert.deepEqual(parseOptions([]), {
    command: 'preview', amrsMode: 'worker', amrsUrl: '', aftersalesUrl: 'http://127.0.0.1:5000',
    dbPath: '', venueMapPath: '', companies: ['Melco', 'MGM', 'SJM', 'SCL', 'GEG', 'Wynn'],
    from: '', intervalMinutes: 60, autoCreateMissing: false, installDateSource: '',
  });
  assert.throws(() => parseOptions(['apply', '--unknown']), /Unknown option/);
  assert.equal(parseOptions(['apply', '--from', '2026-01-01', '--companies', 'SCL,GEG']).from, '2026-01-01');
  assert.throws(() => parseOptions(['preview', '--from', '2026-02-30']), /Invalid from date/);
  assert.equal(parseOptions(['apply', '--auto-create-missing', '--install-date-source', 'earliest-service']).autoCreateMissing, true);
  assert.throws(() => parseOptions(['apply', '--auto-create-missing']), /Installation date source/);
});

test('preview plans historical records without calling the aftersales write API', async () => {
  const db = fixtureDb();
  try {
    const amrs = { async queryDashboard() { return { records: [record], totalPages: 1 }; } };
    const aftersales = {
      async get() { return [{ id: 1, name: 'Sample Customer', branches: [{ id: 10, name: 'Sample Venue' }] }]; },
      async createMaintenance() { throw new Error('preview must not write'); },
    };
    const result = await runCycle({ command: 'preview', companies: ['SCL'], from: '' }, { db, amrs, aftersales, venueMap: {} });
    assert.deepEqual(result.counts, { total: 1, ready: 1, already: 0, changed: 0, blocked: 0 });
    assert.equal(result.provisionableMachines, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM maintenance_batches').get().total, 0);
  } finally { db.close(); }
});

test('apply writes once and the next historical scan reports the record as already synced', async () => {
  const db = fixtureDb();
  try {
    const amrs = { async queryDashboard() { return { records: [record], totalPages: 1 }; } };
    const aftersales = { async get() { return [{ id: 1, name: 'Sample Customer', branches: [{ id: 10, name: 'Sample Venue' }] }]; },
      async createMaintenance(payload) {
      db.prepare('INSERT INTO maintenance_batches (MaintenanceDate, Remarks) VALUES (?, ?)')
        .run(payload.maintenanceDate, payload.remarks);
      return { batchId: 1 };
    } };
    const options = { command: 'apply', companies: ['SCL'], from: '' };
    const first = await runCycle(options, { db, amrs, aftersales, venueMap: {} });
    const second = await runCycle(options, { db, amrs, aftersales, venueMap: {} });
    assert.deepEqual(first.writes, { created: 1, reconciled: 0, failed: 0 });
    assert.deepEqual(second.counts, { total: 1, ready: 0, already: 1, changed: 0, blocked: 0 });
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM maintenance_batches').get().total, 1);
  } finally { db.close(); }
});

test('preview identifies an unregistered SAE machine without creating it', async () => {
  const db = fixtureDb();
  try {
    const amrs = { async queryDashboard() { return { records: [{ ...record, serialNo: 'SN-NEW', model: 'SAE' }], totalPages: 1 }; } };
    const aftersales = {
      async get() { return [{ id: 1, name: 'Sample Customer', branches: [{ id: 10, name: 'Sample Venue' }] }]; },
      async post() { throw new Error('preview must not create master data'); },
    };
    const result = await runCycle({ command: 'preview', companies: ['SCL'], from: '' }, { db, amrs, aftersales });
    assert.equal(result.provisionableMachines, 1);
    assert.equal(result.counts.blocked, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM product_assets').get().total, 1);
  } finally { db.close(); }
});
