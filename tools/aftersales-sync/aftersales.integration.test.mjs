import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFile, cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { AfterSalesClient, planMissingMachines, planSync, runSync } from './bridge.mjs';
import { runCycle } from './cli.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../aftersales');
const executable = path.join(root, 'AfterSalesManagement.exe');

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Isolated aftersales process exited before becoming ready');
    try {
      const response = await fetch(`${baseUrl}/api/auth/csrf`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Still starting. */ }
    await delay(250);
  }
  throw new Error('Isolated aftersales process did not become ready');
}

test('published aftersales accepts synthetic maintenance and auto-created Card Shoe assets through its live API', { skip: !existsSync(executable) }, async () => {
  const base = path.resolve(tmpdir());
  const temp = await mkdtemp(path.join(base, 'aftersales-sync-test-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child;
  let db;
  try {
    await copyFile(executable, path.join(temp, 'AfterSalesManagement.exe'));
    await copyFile(path.join(root, 'appsettings.json'), path.join(temp, 'appsettings.json'));
    await cp(path.join(root, 'wwwroot'), path.join(temp, 'wwwroot'), { recursive: true });
    child = spawn(path.join(temp, 'AfterSalesManagement.exe'), [], {
      cwd: temp, windowsHide: true, stdio: 'ignore',
      env: {
        ...process.env,
        Server__Host: '127.0.0.1', Server__Port: String(port), Server__OpenBrowserOnStart: 'false',
        Storage__DataDir: path.join(temp, 'data'),
      },
    });
    await waitForServer(baseUrl, child);
    const client = new AfterSalesClient({
      baseUrl, username: 'synthetic_sync_user', password: 'SyntheticPassword123!',
    });
    const csrf = await client.request('/api/auth/csrf');
    await client.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken },
      body: JSON.stringify({
        username: 'synthetic_sync_user', password: 'SyntheticPassword123!',
        confirmPassword: 'SyntheticPassword123!',
      }),
    });
    const dbPath = path.join(temp, 'data', 'data', 'aftersales.db');
    const databaseFiles = (await readdir(temp, { recursive: true }))
      .filter(item => item.toLowerCase().endsWith('.db'));
    assert.equal(existsSync(dbPath), true, `isolated data directory should contain the database; found: ${databaseFiles.join(', ')}`);
    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec(`
        UPDATE users SET Role = 0, Status = 1 WHERE Username = 'synthetic_sync_user';
        INSERT INTO customers (Id, Name, IsActive, CreatedAt) VALUES (1, 'Sample Customer', 1, '2026-09-01T00:00:00Z');
        INSERT INTO branches (Id, CustomerId, Name, IsActive, CreatedAt) VALUES (1, 1, 'Sample Venue', 1, '2026-09-01T00:00:00Z');
        INSERT INTO product_types (Id, Name, IsActive) VALUES (1, 'Sample Type', 1);
        INSERT INTO product_models (Id, ProductTypeId, Name, IsActive) VALUES (1, 1, 'Sample Model', 1);
        INSERT INTO product_systems (Id, Name, IsActive) VALUES (1, 'Sample Product System', 1);
        INSERT INTO system_device_templates (Id, ProductSystemId, ProductTypeId, DeviceName, SlotCode, SortOrder, IsRequired, IsActive)
          VALUES (1, 1, 1, 'Sample Device', 'SLOT-1', 1, 1, 1);
        INSERT INTO product_assets (Id, SerialNumber, Status, ProductTypeId, ProductModelId, OwnerCustomerId, PurchaseDate, IsDeleted, CreatedAt)
          VALUES (1, 'SN-001', 1, 1, 1, 1, '2026-09-01', 0, '2026-09-01T00:00:00Z');
        INSERT INTO installations (Id, SystemNo, IsActive, ProductSystemId, CustomerId, BranchId, InstallDate, CreatedAt)
          VALUES (1, 'SYS-001', 1, 1, 1, 1, '2026-09-01', '2026-09-01T00:00:00Z');
        INSERT INTO installation_devices (Id, InstallationId, TemplateId, ProductAssetId, InstalledAt)
          VALUES (1, 1, 1, 1, '2026-09-01');
      `);
    } finally { seed.close(); }
    db = new DatabaseSync(dbPath, { readOnly: true });
    const record = {
      recordId: 'synthetic-record-001', company: 'SCL', casino: 'Sample Venue',
      date: '2026/09/20', serialNo: 'SN-001', actionTaken: 'Cleaned and tested',
    };
    const plan = planSync([record], db, {});
    assert.equal(plan.counts.ready, 1);
    const outcomes = [];
    const syncResult = await runSync(plan, client, db, (...args) => outcomes.push(args));
    assert.deepEqual(syncResult, { created: 1, reconciled: 0, failed: 0 }, `outcomes: ${JSON.stringify(outcomes)}`);
    assert.equal(planSync([record], db, {}).counts.already, 1);

    const missing = {
      recordId: 'synthetic-record-002', company: 'New Company', casino: 'New Venue',
      date: '2026/09/21', serialNo: 'SN-002', model: 'TAE', actionTaken: 'Inspected',
    };
    const planned = planMissingMachines([missing], db);
    assert.equal(planned.machines.length, 1);
    const amrs = { async queryDashboard() { return { records: [missing], totalPages: 1 }; } };
    const cycleOptions = { command: 'apply', companies: ['New Company'], from: '', autoCreateMissing: true,
      installDateSource: 'earliest-service' };
    const firstCycle = await runCycle(cycleOptions, { db, amrs, aftersales: client });
    assert.deepEqual(firstCycle.provision, { created: 1, failed: 0 });
    assert.deepEqual(firstCycle.writes, { created: 1, reconciled: 0, failed: 0 });
    const directory = await client.get('/api/customers');
    const newCustomer = directory.find(item => item.name === 'New Company');
    assert.ok(newCustomer);
    assert.ok(newCustomer.branches.some(item => item.name === 'New Venue'));
    const options = await client.get('/api/products/options');
    assert.equal(options.productTypes.filter(item => item.name === 'Card Shoe').length, 1);
    assert.equal(options.productModels.filter(item => item.name === 'TAE').length, 1);
    assert.equal(options.productSystems.filter(item => item.name === 'Card Shoe').length, 1);
    // The published aftersales API substitutes installDate when purchaseDate is null.
    assert.equal(db.prepare("SELECT PurchaseDate FROM product_assets WHERE SerialNumber = 'SN-002'").get().PurchaseDate, '2026-09-21');
    const newPlan = planSync([missing], db, {}, directory);
    assert.equal(newPlan.counts.already, 1);
    const repeated = await runCycle(cycleOptions, { db, amrs, aftersales: client });
    assert.equal(repeated.counts.already, 1);
    assert.deepEqual(repeated.provision, { created: 0, failed: 0 });
  } finally {
    db?.close();
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, delay(5000)]);
    }
    const resolved = path.resolve(temp);
    if (resolved.startsWith(`${base}${path.sep}`) && path.basename(resolved).startsWith('aftersales-sync-test-')) {
      await rm(resolved, { recursive: true, force: true });
    }
  }
});
