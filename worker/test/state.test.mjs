import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireWriteLock,
  createSubmissionBatch,
  getWriteLock,
  updateSubmissionItem,
  withWriteLock,
} from "../src/state.mjs";

function createD1Harness() {
  const calls = [];
  const locks = new Map();
  const batchRow = {
    batch_id: "batch-test",
    status: "pending",
    expected_count: 2,
    inserted_count: 0,
    skipped_count: 0,
    repaired_count: 0,
    result_json: null,
    error_message: null,
    created_at: 1000,
    updated_at: 1000,
  };

  return {
    calls,
    locks,
    prepare(sql) {
      return {
        bind(...bindings) {
          const statement = {
            async run() {
              calls.push({ sql, bindings });
              if (sql.includes("INSERT INTO write_locks")) {
                const [scope, owner, expiresAt, now, sameOwner] = bindings;
                const current = locks.get(scope);
                if (!current || current.expiresAt <= now || current.owner === sameOwner) {
                  locks.set(scope, { owner, expiresAt });
                  return { success: true, meta: { changes: 1 } };
                }
                return { success: true, meta: { changes: 0 } };
              }
              if (sql.includes("DELETE FROM write_locks")) {
                const [scope, owner] = bindings;
                const current = locks.get(scope);
                if (current?.owner === owner) {
                  locks.delete(scope);
                  return { success: true, meta: { changes: 1 } };
                }
                return { success: true, meta: { changes: 0 } };
              }
              return { success: true, meta: { changes: 1 } };
            },
            async first() {
              calls.push({ sql, bindings });
              if (sql.includes("FROM submission_batches")) return batchRow;
              if (sql.includes("FROM write_locks")) {
                const current = locks.get(bindings[0]);
                return current ? { scope: bindings[0], owner: current.owner, expires_at: current.expiresAt } : null;
              }
              return {
                submission_id: "submission-test",
                batch_id: "batch-test",
                company: "SCL",
                status: "processing",
                row_number: 3,
                created_at: 1000,
                updated_at: 2000,
              };
            },
            async all() {
              calls.push({ sql, bindings });
              return { results: [] };
            },
          };
          return statement;
        },
      };
    },
  };
}

test("creates a submission batch and maps its D1 row to camelCase", async () => {
  const db = createD1Harness();
  const batch = await createSubmissionBatch(db, { batchId: "batch-test", expectedCount: 2, now: 1000 });
  assert.equal(batch.batchId, "batch-test");
  assert.equal(batch.expectedCount, 2);
  assert.equal(batch.status, "pending");
  assert.ok(db.calls.some(({ sql }) => sql.includes("INSERT INTO submission_batches")));
});

test("updates an item status without accepting unsafe column names", async () => {
  const db = createD1Harness();
  const item = await updateSubmissionItem(db, "submission-test", { status: "processing", rowNumber: null, now: 2000 });
  assert.equal(item.submissionId, "submission-test");
  assert.equal(item.status, "processing");
  const update = db.calls.find(({ sql }) => sql.includes("UPDATE submission_items"));
  assert.ok(update);
  assert.match(update.sql, /SET status = \?, row_number = \?, updated_at = \?/);
  assert.match(update.sql, /WHERE submission_id = \?/);
  assert.deepEqual(update.bindings, ["processing", null, 2000, "submission-test"]);
});

test("acquires an unexpired lock only for its current owner", async () => {
  const db = createD1Harness();
  assert.equal(await acquireWriteLock(db, "sheet-write", "owner-a", { ttlMs: 100, now: 1000 }), true);
  assert.equal(await acquireWriteLock(db, "sheet-write", "owner-b", { ttlMs: 100, now: 1050 }), false);
  assert.deepEqual(await getWriteLock(db, "sheet-write"), {
    scope: "sheet-write",
    owner: "owner-a",
    expiresAt: 1100,
  });
});

test("withWriteLock releases the lock after the callback", async () => {
  const db = createD1Harness();
  let callbackLock;
  const result = await withWriteLock(db, "sheet-write", "owner-a", async (lock) => {
    callbackLock = lock;
    return "written";
  }, { ttlMs: 100, now: 1000 });
  assert.equal(result, "written");
  assert.equal(callbackLock.owner, "owner-a");
  assert.equal(db.locks.has("sheet-write"), false);
});

test("withWriteLock accepts object-form lock options", async () => {
  const db = createD1Harness();
  let callbackLock;
  await withWriteLock(db, { scope: "sheet-write", owner: "owner-a" }, (lock) => {
    callbackLock = lock;
  }, { ttlMs: 100, now: 1000 });
  assert.equal(callbackLock.expiresAt, 1100);
});
