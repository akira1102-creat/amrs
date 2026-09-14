import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local SQLite implementation of the existing server's D1 contract.
// Keeping this contract preserves submission reconciliation and access controls.
export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  sqlite.exec('CREATE TABLE IF NOT EXISTS intranet_migrations (name TEXT PRIMARY KEY)');
  const migrations = fileURLToPath(new URL('../worker/migrations/', import.meta.url));
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    if (sqlite.prepare('SELECT name FROM intranet_migrations WHERE name=?').get(name)) continue;
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.exec(readFileSync(resolve(migrations, name), 'utf8'));
      sqlite.prepare('INSERT INTO intranet_migrations(name) VALUES (?)').run(name);
      sqlite.exec('COMMIT');
    } catch (error) { sqlite.exec('ROLLBACK'); sqlite.close(); throw error; }
  }
  function prepare(sql, bindings = []) {
    return {
      bind: (...values) => prepare(sql, values),
      async first(column) {
        const row = sqlite.prepare(sql).get(...bindings);
        return row ? (column ? row[column] : { ...row }) : null;
      },
      async all() { return { success: true, results: sqlite.prepare(sql).all(...bindings).map(row => ({ ...row })) }; },
      async run() {
        const result = sqlite.prepare(sql).run(...bindings);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
    };
  }
  return { prepare, close: () => sqlite.close() };
}
