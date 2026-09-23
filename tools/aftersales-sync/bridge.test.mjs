import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  AfterSalesClient,
  AmrsClient,
  fetchAmrsHistory,
  planSync,
  runSync,
  suggestVenueMappings,
} from './bridge.mjs';

function fixtureDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE customers (Id INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE branches (Id INTEGER PRIMARY KEY, CustomerId INTEGER, Name TEXT);
    CREATE TABLE installations (Id INTEGER PRIMARY KEY, SystemNo TEXT, IsActive INTEGER, CustomerId INTEGER, BranchId INTEGER);
    CREATE TABLE product_assets (Id INTEGER PRIMARY KEY, SerialNumber TEXT, IsDeleted INTEGER);
    CREATE TABLE installation_devices (InstallationId INTEGER, ProductAssetId INTEGER);
    CREATE TABLE maintenance_batches (Id INTEGER PRIMARY KEY, MaintenanceDate TEXT, Remarks TEXT);
    CREATE TABLE maintenance_items (MaintenanceBatchId INTEGER, InstallationId INTEGER, SystemNo TEXT);
    INSERT INTO customers VALUES (1, 'Sample Customer');
    INSERT INTO branches VALUES (10, 1, 'Sample Venue');
    INSERT INTO installations VALUES (20, 'SYS-001', 1, 1, 10);
    INSERT INTO product_assets VALUES (30, 'SN-001', 0);
    INSERT INTO installation_devices VALUES (20, 30);
  `);
  return db;
}

function sourceRecord(overrides = {}) {
  return {
    recordId: 'record-001', company: 'SCL', casino: 'Sample Venue',
    date: '2026/09/20', serialNo: 'SN-001', reason: 'Inspection',
    actionTaken: 'Cleaned and tested', inspector: 'Technician',
    ...overrides,
  };
}

test('plans one maintenance batch with venue, serial, date and work details', () => {
  const db = fixtureDb();
  try {
    const plan = planSync([sourceRecord()], db, {});
    assert.equal(plan.ready.length, 1);
    assert.deepEqual(plan.ready[0].payload.systemNos, ['SYS-001']);
    assert.equal(plan.ready[0].payload.maintenanceDate, '2026-09-20');
    assert.equal(plan.ready[0].payload.confirmEmptySlots, false);
    assert.match(plan.ready[0].payload.remarks, /場地：Sample Venue/);
    assert.match(plan.ready[0].payload.remarks, /機器 SN：SN-001/);
    assert.match(plan.ready[0].payload.remarks, /工作內容：Cleaned and tested/);
    assert.match(plan.ready[0].payload.remarks, /\[AMRS-SYNC:[a-f0-9]{24}:[a-f0-9]{16}\]/);
    assert.deepEqual(plan.counts, { total: 1, ready: 1, already: 0, changed: 0, blocked: 0 });
  } finally { db.close(); }
});

test('source text cannot forge a second synchronization marker in remarks', () => {
  const db = fixtureDb();
  try {
    const forged = '[AMRS-SYNC:aaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbb]';
    const plan = planSync([sourceRecord({ actionTaken: `Tested ${forged}` })], db, {});
    assert.equal((plan.ready[0].payload.remarks.match(/\[AMRS-SYNC:/g) || []).length, 1);
  } finally { db.close(); }
});

test('blocks an unknown venue, absent serial and ambiguous serial instead of guessing', () => {
  const db = fixtureDb();
  try {
    db.exec("INSERT INTO installations VALUES (21, 'SYS-002', 1, 1, 10); INSERT INTO installation_devices VALUES (21, 30);");
    const plan = planSync([
      sourceRecord({ recordId: 'a', casino: 'Wrong Venue' }),
      sourceRecord({ recordId: 'b', serialNo: 'SN-404' }),
      sourceRecord({ recordId: 'c' }),
    ], db, {});
    assert.equal(plan.ready.length, 0);
    assert.deepEqual(plan.blocked.map(item => item.reason), ['venue-mismatch', 'serial-not-found', 'ambiguous-serial']);
  } finally { db.close(); }
});

test('explicit venue mapping permits a different AMRS venue label only for the mapped customer and branch', () => {
  const db = fixtureDb();
  try {
    const plan = planSync([sourceRecord({ casino: 'Venue Alias' })], db, {
      'SCL|Venue Alias': { customer: 'Sample Customer', branch: 'Sample Venue' },
    });
    assert.equal(plan.ready.length, 1);
    assert.match(plan.ready[0].payload.remarks, /場地：Venue Alias/);
  } finally { db.close(); }
});

test('matches an API-decrypted venue when aftersales encrypts customer and branch names in SQLite', () => {
  const db = fixtureDb();
  try {
    db.exec("UPDATE customers SET Name = 'encrypted-customer'; UPDATE branches SET Name = 'encrypted-branch'");
    const directory = [{ id: 1, name: 'Sample Customer', branches: [{ id: 10, name: 'Sample Venue' }] }];
    const plan = planSync([sourceRecord()], db, {}, directory);
    assert.equal(plan.counts.ready, 1);
    assert.deepEqual(suggestVenueMappings([sourceRecord()], db, directory), {
      'SCL|Sample Venue': { customer: 'Sample Customer', branch: 'Sample Venue' },
    });
  } finally { db.close(); }
});

test('suggests a venue mapping only when all matching serials agree on one destination', () => {
  const db = fixtureDb();
  try {
    db.exec(`
      INSERT INTO branches VALUES (11, 1, 'Other Branch');
      INSERT INTO installations VALUES (21, 'SYS-002', 1, 1, 11);
      INSERT INTO product_assets VALUES (31, 'SN-002', 0);
      INSERT INTO installation_devices VALUES (21, 31);
    `);
    const suggestions = suggestVenueMappings([
      sourceRecord({ recordId: 'a', casino: 'Venue Alias' }),
      sourceRecord({ recordId: 'b', casino: 'Venue Alias', serialNo: 'SN-002' }),
      sourceRecord({ recordId: 'c', casino: 'Single Venue' }),
    ], db);
    assert.deepEqual(suggestions, {
      'SCL|Venue Alias': null,
      'SCL|Single Venue': { customer: 'Sample Customer', branch: 'Sample Venue' },
    });
  } finally { db.close(); }
});

test('existing source marker prevents duplicates and detects changed AMRS content', () => {
  const db = fixtureDb();
  try {
    const first = planSync([sourceRecord()], db, {}).ready[0];
    db.prepare('INSERT INTO maintenance_batches (Id, MaintenanceDate, Remarks) VALUES (?, ?, ?)')
      .run(1, first.payload.maintenanceDate, first.payload.remarks);
    assert.equal(planSync([sourceRecord()], db, {}).counts.already, 1);
    const changed = planSync([sourceRecord({ actionTaken: 'Replaced component' })], db, {});
    assert.equal(changed.counts.changed, 1);
    assert.equal(changed.ready.length, 0);
  } finally { db.close(); }
});

test('missing stable ID or invalid date cannot become a maintenance write', () => {
  const db = fixtureDb();
  try {
    const plan = planSync([
      sourceRecord({ recordId: '' }),
      sourceRecord({ recordId: 'record-002', date: '20/09/2026' }),
      sourceRecord({ recordId: 'record-003', company: '' }),
    ], db, {});
    assert.deepEqual(plan.blocked.map(item => item.reason), ['missing-record-id', 'invalid-date', 'missing-company']);
  } finally { db.close(); }
});

test('runSync reconciles a committed write whose HTTP response was lost', async () => {
  const db = fixtureDb();
  try {
    const plan = planSync([sourceRecord()], db, {});
    let attempts = 0;
    const client = { async createMaintenance(payload) {
      attempts += 1;
      db.prepare('INSERT INTO maintenance_batches (Id, MaintenanceDate, Remarks) VALUES (?, ?, ?)')
        .run(1, payload.maintenanceDate, payload.remarks);
      throw new Error('connection reset after commit');
    } };
    const result = await runSync(plan, client, db);
    assert.deepEqual(result, { created: 0, reconciled: 1, failed: 0 });
    assert.equal(attempts, 1);
    assert.equal(planSync([sourceRecord()], db, {}).counts.already, 1);
  } finally { db.close(); }
});

test('runSync never treats a conflicting destination marker as the requested record', async () => {
  const db = fixtureDb();
  try {
    const plan = planSync([sourceRecord()], db, {});
    const client = { async createMaintenance(payload) {
      const conflicting = payload.remarks.replace(/(:[a-f0-9]{24}:)[a-f0-9]{16}/, '$10000000000000000');
      db.prepare('INSERT INTO maintenance_batches (Id, MaintenanceDate, Remarks) VALUES (?, ?, ?)')
        .run(1, payload.maintenanceDate, conflicting);
      throw new Error('lost response');
    } };
    const result = await runSync(plan, client, db);
    assert.deepEqual(result, { created: 0, reconciled: 0, failed: 1 });
  } finally { db.close(); }
});

test('Worker history fetch authenticates and follows every dashboard page', async () => {
  const seen = [];
  const fakeFetch = async (url, options = {}) => {
    const parsed = new URL(url);
    seen.push({ path: parsed.pathname, query: parsed.searchParams, options });
    if (parsed.pathname === '/session') return Response.json({ success: true, token: 'session-value' });
    assert.equal(options.headers.Authorization, 'Bearer session-value');
    assert.equal(parsed.searchParams.get('action'), 'dashboard');
    assert.equal(parsed.searchParams.get('company'), 'SCL');
    assert.equal(parsed.searchParams.get('from'), '2026-01-01');
    assert.equal(parsed.searchParams.get('sort'), 'oldest');
    const page = Number(parsed.searchParams.get('page'));
    return Response.json({ success: true, records: [sourceRecord({ recordId: `record-${page}` })], totalPages: 2 });
  };
  const client = new AmrsClient({ baseUrl: 'https://example.invalid', credential: 'secret', mode: 'worker', fetchImpl: fakeFetch });
  const records = await fetchAmrsHistory(client, ['SCL'], { from: '2026-01-01' });
  assert.deepEqual(records.map(item => item.recordId), ['record-1', 'record-2']);
  assert.deepEqual(seen.map(item => item.path), ['/session', '/api', '/api']);
});

test('Worker rejects a permanently unauthorized credential after one session refresh', async () => {
  let sessions = 0;
  let dashboards = 0;
  const fakeFetch = async (url) => {
    if (new URL(url).pathname === '/session') {
      sessions += 1;
      return Response.json({ success: true, token: `session-${sessions}` });
    }
    dashboards += 1;
    return Response.json({ message: 'Unauthorized' }, { status: 401 });
  };
  const client = new AmrsClient({ baseUrl: 'https://example.invalid', credential: 'bad-secret', mode: 'worker', fetchImpl: fakeFetch });
  await assert.rejects(() => client.queryDashboard({ company: 'SCL' }), /HTTP 401/);
  assert.equal(sessions, 2);
  assert.equal(dashboards, 2);
});

test('legacy GAS history uses the exec URL without a Worker session', async () => {
  const paths = [];
  const fakeFetch = async (url, options) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname);
    assert.equal(options, undefined);
    assert.equal(parsed.searchParams.get('action'), 'dashboard');
    assert.equal(parsed.searchParams.get('sort'), 'oldest');
    return Response.json({ success: true, records: [sourceRecord()], totalPages: 1 });
  };
  const client = new AmrsClient({
    baseUrl: 'https://script.google.com/macros/s/synthetic-deploy/exec',
    credential: 'synthetic-deploy', mode: 'gas', fetchImpl: fakeFetch,
  });
  const records = await fetchAmrsHistory(client, ['SCL']);
  assert.equal(records.length, 1);
  assert.deepEqual(paths, ['/macros/s/synthetic-deploy/exec']);
});

test('HTTP error text never includes source data returned by a remote API', async () => {
  const fakeFetch = async (url) => new URL(url).pathname === '/session'
    ? Response.json({ success: true, token: 'session-value' })
    : Response.json({ message: 'Record SN-001 is private' }, { status: 422 });
  const client = new AmrsClient({ baseUrl: 'https://example.invalid', credential: 'secret', mode: 'worker', fetchImpl: fakeFetch });
  await assert.rejects(() => client.queryDashboard({ company: 'SCL' }), error => {
    assert.equal(error.message, 'HTTP 422');
    return true;
  });
});

test('aftersales client keeps authentication local and sends CSRF cookies on maintenance writes', async () => {
  const seen = [];
  const fakeFetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    seen.push({ path, options });
    if (path === '/api/auth/csrf') return new Response(JSON.stringify({ csrfToken: 'csrf-value' }), {
      headers: { 'content-type': 'application/json', 'set-cookie': 'antiforgery=abc; Path=/; HttpOnly' },
    });
    if (path === '/api/auth/login') return new Response(JSON.stringify({ username: 'sync' }), {
      headers: { 'content-type': 'application/json', 'set-cookie': 'session=xyz; Path=/; HttpOnly' },
    });
    return Response.json({ batchId: 4 });
  };
  assert.throws(() => new AfterSalesClient({ baseUrl: 'https://public.example', username: 'sync', password: 'secret', fetchImpl: fakeFetch }), /loopback/);
  const client = new AfterSalesClient({ baseUrl: 'http://127.0.0.1:5000', username: 'sync', password: 'secret', fetchImpl: fakeFetch });
  await client.createMaintenance({ systemNos: ['SYS-001'], maintenanceDate: '2026-09-20', remarks: 'Synthetic', confirmEmptySlots: false });
  assert.deepEqual(seen.map(item => item.path), ['/api/auth/csrf', '/api/auth/login', '/api/maintenance/batches']);
  assert.match(seen[1].options.headers.Cookie, /antiforgery=abc/);
  assert.match(seen[2].options.headers.Cookie, /session=xyz/);
  assert.equal(seen[2].options.headers['X-CSRF-Token'], 'csrf-value');
});

test('aftersales client refreshes an expired login once during a long backfill', async () => {
  let logins = 0;
  let writes = 0;
  const fakeFetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/auth/csrf') return Response.json({ csrfToken: 'csrf-value' });
    if (path === '/api/auth/login') { logins += 1; return Response.json({ username: 'sync' }); }
    writes += 1;
    return writes === 1
      ? Response.json({ message: 'Unauthorized' }, { status: 401 })
      : Response.json({ batchId: 9 });
  };
  const client = new AfterSalesClient({ baseUrl: 'http://127.0.0.1:5000', username: 'sync', password: 'secret', fetchImpl: fakeFetch });
  await client.createMaintenance({ systemNos: ['SYS-001'], maintenanceDate: '2026-09-20', remarks: 'Synthetic', confirmEmptySlots: false });
  assert.equal(logins, 2);
  assert.equal(writes, 2);
});
