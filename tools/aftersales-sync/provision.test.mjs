import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as provision from './bridge.mjs';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE product_assets (Id INTEGER PRIMARY KEY, SerialNumber TEXT, IsDeleted INTEGER);
    CREATE TABLE installations (Id INTEGER PRIMARY KEY, SystemNo TEXT, IsActive INTEGER);
  `);
  return db;
}

function record(overrides = {}) {
  return { company: 'SCL', casino: 'Sample Venue', serialNo: 'SN-002', model: 'SAE', date: '2026/09/20', ...overrides };
}

test('groups one absent SN into one machine with its earliest known service date', () => {
  const db = database();
  try {
    const result = provision.planMissingMachines?.([
      record(), record({ date: '2025/02/03' }),
    ], db);
    assert.ok(result, 'machine provisioning plan should exist');
    assert.deepEqual(result.machines, [{
      serialNo: 'SN-002', model: 'SAE', customer: 'SCL', branch: 'Sample Venue',
      earliestServiceDate: '2025-02-03',
    }]);
    assert.deepEqual(result.blockedReasons, {});
  } finally { db.close(); }
});

test('never invents a second machine when an SN or system number already exists', () => {
  const db = database();
  try {
    db.exec("INSERT INTO product_assets VALUES (1, 'SN-003', 0); INSERT INTO installations VALUES (1, 'SN-004', 1)");
    const result = provision.planMissingMachines?.([
      record({ serialNo: 'SN-003' }), record({ serialNo: 'SN-004' }),
    ], db);
    assert.ok(result, 'machine provisioning plan should exist');
    assert.equal(result.machines.length, 0);
    assert.deepEqual(result.blockedReasons, { 'asset-already-exists': 1, 'system-number-exists': 1 });
  } finally { db.close(); }
});

test('blocks unknown or conflicting models and conflicting venue ownership', () => {
  const db = database();
  try {
    const result = provision.planMissingMachines?.([
      record({ serialNo: 'A', model: 'Other' }),
      record({ serialNo: 'B', model: 'SAE' }), record({ serialNo: 'B', model: 'TAE' }),
      record({ serialNo: 'C', casino: 'Sample Venue' }), record({ serialNo: 'C', casino: 'Different Venue' }),
    ], db);
    assert.ok(result, 'machine provisioning plan should exist');
    assert.equal(result.machines.length, 0);
    assert.deepEqual(result.blockedReasons, { 'unsupported-model': 1, 'conflicting-model': 1, 'conflicting-venue': 1 });
  } finally { db.close(); }
});

test('uses a reviewed venue map when naming a new customer and branch', () => {
  const db = database();
  try {
    const result = provision.planMissingMachines?.([record({ casino: 'Venue Alias' })], db, {
      'SCL|Venue Alias': { customer: 'Sample Customer', branch: 'Sample Branch' },
    });
    assert.ok(result, 'machine provisioning plan should exist');
    assert.deepEqual(result.machines[0], {
      serialNo: 'SN-002', model: 'SAE', customer: 'Sample Customer', branch: 'Sample Branch',
      earliestServiceDate: '2026-09-20',
    });
  } finally { db.close(); }
});

test('automatic creation reports authorization failure without leaking source details', async () => {
  const db = database();
  try {
    const client = { async get() { throw Object.assign(new Error('private serial SN-002'), { status: 403 }); } };
    const machines = provision.planMissingMachines([record()], db).machines;
    const result = await provision.provisionMachines(machines, db, client, { installDateSource: 'earliest-service' });
    assert.deepEqual(result, { created: 0, failed: 1, failureReasons: { 'HTTP 403': 1 } });
  } finally { db.close(); }
});
