import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './database.mjs';

test('local database installs server tables and preserves committed data after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amrs-intranet-test-'));
  let db;
  try {
    const filename = join(directory, 'test.sqlite');
    db = openDatabase(filename);
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    assert.ok(tables.results.some(row => row.name === 'operations'));
    assert.ok(tables.results.some(row => row.name === 'access_tokens'));
    await db.prepare('CREATE TABLE durability_test (id TEXT PRIMARY KEY, value TEXT)').run();
    await db.prepare('INSERT INTO durability_test VALUES (?, ?)').bind('example', 'saved locally').run();
    db.close();
    db = openDatabase(filename);
    assert.equal(await db.prepare('SELECT value FROM durability_test WHERE id=?').bind('example').first('value'), 'saved locally');
    assert.equal(await db.prepare('SELECT value FROM durability_test WHERE id=?').bind('missing').first(), null);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
