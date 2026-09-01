import assert from "node:assert/strict";
import test from "node:test";
import { sha256Base64Url } from "../src/crypto.mjs";
import { handleRequest, permissionForAction } from "../src/api.mjs";
import { withWriteLock } from "../src/state.mjs";

function createD1Harness() {
  const operations = new Map();
  const batches = new Map();
  const items = new Map();
  const locks = new Map();
  const calls = [];

  function rowForOperation(value) {
    return value ? {
      request_id: value.requestId,
      action: value.action,
      status: value.status,
      result_json: value.resultJson,
      error_message: value.errorMessage,
      retryable: value.retryable,
      created_at: value.createdAt,
      updated_at: value.updatedAt,
    } : null;
  }

  function rowForBatch(value) {
    return value ? { batch_id: value.batchId, status: value.status, expected_count: value.expectedCount, inserted_count: value.insertedCount, skipped_count: value.skippedCount, repaired_count: value.repairedCount, result_json: value.resultJson, error_message: value.errorMessage, created_at: value.createdAt, updated_at: value.updatedAt } : null;
  }

  function rowForItem(value) {
    return value ? { submission_id: value.submissionId, batch_id: value.batchId, company: value.company, status: value.status, row_number: value.rowNumber, created_at: value.createdAt, updated_at: value.updatedAt } : null;
  }

  function updateFromSql(sql, bindings, table, key, map) {
    const setClause = sql.match(/SET (.+?) WHERE /s)?.[1] || "";
    const assignments = setClause.split(", ").filter(Boolean);
    const id = bindings[bindings.length - 1];
    const value = table.get(id);
    if (!value) return { success: true, meta: { changes: 0 } };
    assignments.forEach((assignment, index) => {
      const column = assignment.split(" = ")[0];
      map(value, column, bindings[index]);
    });
    return { success: true, meta: { changes: 1 } };
  }

  return {
    calls,
    operations,
    batches,
    items,
    locks,
    prepare(sql) {
      return {
        bind(...bindings) {
          calls.push({ sql, bindings });
          return {
            async run() {
              if (sql.includes("INSERT INTO operations")) {
                const [requestId, action, status, createdAt, updatedAt] = bindings;
                if (operations.has(requestId)) return { success: true, meta: { changes: 0 } };
                operations.set(requestId, { requestId, action, status, resultJson: null, errorMessage: null, retryable: 0, createdAt, updatedAt });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.startsWith("UPDATE operations")) {
                const [status, resultJson, errorMessage, retryable, updatedAt, requestId] = bindings;
                const value = operations.get(requestId);
                Object.assign(value, { status, resultJson, errorMessage, retryable, updatedAt });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes("INSERT INTO submission_batches")) {
                const [batchId, status, expectedCount, insertedCount, skippedCount, repairedCount, resultJson, errorMessage, createdAt, updatedAt] = bindings;
                if (batches.has(batchId)) return { success: true, meta: { changes: 0 } };
                batches.set(batchId, { batchId, status, expectedCount, insertedCount, skippedCount, repairedCount, resultJson, errorMessage, createdAt, updatedAt });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.startsWith("UPDATE submission_batches")) {
                return updateFromSql(sql, bindings, batches, "batch_id", (value, column, input) => {
                  const key = { expected_count: "expectedCount", inserted_count: "insertedCount", skipped_count: "skippedCount", repaired_count: "repairedCount", result_json: "resultJson", error_message: "errorMessage" }[column] || column;
                  value[key] = input;
                });
              }
              if (sql.includes("INSERT INTO submission_items")) {
                const [submissionId, batchId, company, status, rowNumber, createdAt, updatedAt] = bindings;
                if (items.has(submissionId)) return { success: true, meta: { changes: 0 } };
                items.set(submissionId, { submissionId, batchId, company, status, rowNumber, createdAt, updatedAt });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.startsWith("UPDATE submission_items")) {
                return updateFromSql(sql, bindings, items, "submission_id", (value, column, input) => {
                  value[{ batch_id: "batchId", company: "company", row_number: "rowNumber" }[column] || column] = input;
                });
              }
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
                if (locks.get(scope)?.owner === owner) locks.delete(scope);
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 1 } };
            },
            async first() {
              if (sql.includes("FROM operations")) return rowForOperation(operations.get(bindings[0]));
              if (sql.includes("FROM submission_batches")) return rowForBatch(batches.get(bindings[0]));
              if (sql.includes("FROM submission_items")) return rowForItem(items.get(bindings[0]));
              if (sql.includes("FROM write_locks")) {
                const value = locks.get(bindings[0]);
                return value ? { scope: bindings[0], owner: value.owner, expires_at: value.expiresAt } : null;
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM submission_items")) {
                const batchId = bindings[0];
                return { results: [...items.values()].filter((item) => item.batchId === batchId).map(rowForItem) };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };
}

async function createAuthenticatedContext() {
  const deployId = "synthetic-deploy-id";
  const env = {
    DB: createD1Harness(),
    AMRS_DEPLOY_ID_HASH: await sha256Base64Url(deployId),
    AMRS_TOKEN_SECRET: "synthetic-token-secret",
    ALLOWED_ORIGINS: "https://synthetic.example",
  };
  const sessionResponse = await handleRequest(new Request("https://worker.example/session", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://synthetic.example" },
    body: JSON.stringify({ deployId }),
  }), env);
  const session = await sessionResponse.json();
  return { env, token: session.token };
}

function request(url, token, init = {}) {
  return new Request(`https://worker.example${url}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      origin: "https://synthetic.example",
      ...(init.headers || {}),
    },
  });
}

test("maps every API action to its server-enforced permission group", () => {
  assert.equal(permissionForAction("scheduleOverview"), "schedule");
  assert.equal(permissionForAction("updateScheduleRemark"), "schedule");
  assert.equal(permissionForAction("updateSchedulePeople"), "schedule");
  assert.equal(permissionForAction("submitRecords"), "ae");
  assert.equal(permissionForAction("submissionWarnings"), "ae");
  assert.equal(permissionForAction("galaxyLogOverview"), "ae");
  assert.equal(permissionForAction("syncGalaxyLog"), "ae");
  assert.equal(permissionForAction("cvcsRecords"), "cvcs");
  assert.equal(permissionForAction("submitCvcsRecords"), "cvcs");
  assert.equal(permissionForAction("createAccessToken"), "admin");
});

test("legacy authentication cannot bootstrap an administrator token", async () => {
  const { env, token } = await createAuthenticatedContext();
  const response = await handleRequest(request("/api", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "bootstrapAccessToken", label: "System Owner" }),
  }), env);
  assert.equal(response.status, 403);
});

test("returns a pollable top-level processing status for an existing operation", async () => {
  const { env, token } = await createAuthenticatedContext();
  env.DB.operations.set("request-processing", {
    requestId: "request-processing", action: "updateRecord", status: "processing", resultJson: null, errorMessage: null, retryable: 0, createdAt: 1, updatedAt: 1,
  });
  const repository = { postAction: async () => { throw new Error("must not execute twice"); }, getAction: async () => ({ success: true }), findSubmissionIds: async () => ({}) };
  const response = await handleRequest(request("/api", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "updateRecord", requestId: "request-processing" }),
  }), env, { repository });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.status, "processing");
  assert.equal(body.operationId, "request-processing");
});

test("reconciles a submission batch and preserves inserted versus skipped item status", async () => {
  const { env, token } = await createAuthenticatedContext();
  const calls = [];
  let statusWhenWrite;
  const repository = {
    getAction: async () => ({ success: true }),
    findSubmissionIds: async (items) => Object.fromEntries(items.filter((item) => item.submissionId === "new-id").map((item) => [item.submissionId, { company: "SCL" }])),
    postAction: async (payload) => {
      calls.push(payload);
      statusWhenWrite = env.DB.batches.get("batch-status-test")?.status;
      return { success: true, inserted: 1, skipped: 1, insertedSubmissionIds: ["new-id"], skippedSubmissionIds: ["old-id"] };
    },
  };
  const payload = {
    action: "submitRecords",
    requestId: "batch-status-test",
    records: [
      { company: "SCL", submissionId: "new-id" },
      { company: "SCL", submissionId: "old-id" },
    ],
  };
  const response = await handleRequest(request("/api", token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }), env, { repository });
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.status, undefined);
  assert.equal(statusWhenWrite, "processing");
  assert.equal(calls.length, 1);
  assert.equal(env.DB.items.get("new-id").status, "inserted");
  assert.equal(env.DB.items.get("old-id").status, "skipped");

  const statusResponse = await handleRequest(request("/submissions/batch-status-test", token), env, { repository });
  const status = await statusResponse.json();
  assert.equal(status.status, "completed");
  assert.equal(status.result.inserted, 1);
  assert.equal(status.items.find((item) => item.submissionId === "old-id").status, "skipped");
});

test("reconciles pre-existing IDs before the write and new IDs after the write", async () => {
  const { env, token } = await createAuthenticatedContext();
  let lookupCount = 0;
  const repository = {
    findSubmissionIds: async (items) => {
      lookupCount += 1;
      if (lookupCount === 1) return Object.fromEntries(items.filter((item) => item.submissionId === "existing-id").map((item) => [item.submissionId, { company: "SCL" }]));
      return Object.fromEntries(items.filter((item) => item.submissionId === "new-id").map((item) => [item.submissionId, { company: "SCL" }]));
    },
    postAction: async () => ({ success: true, inserted: 1, skipped: 1 }),
  };
  const response = await handleRequest(request("/api", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "submitRecords",
      requestId: "before-after-reconcile",
      records: [
        { company: "SCL", submissionId: "existing-id" },
        { company: "SCL", submissionId: "new-id" },
      ],
    }),
  }), env, { repository });
  assert.equal(response.status, 200);
  assert.equal(lookupCount, 2);
  assert.equal(env.DB.items.get("existing-id").status, "skipped");
  assert.equal(env.DB.items.get("new-id").status, "inserted");
});

test("keeps the operation processing when a successful write cannot yet be reconciled", async () => {
  const { env, token } = await createAuthenticatedContext();
  const repository = {
    findSubmissionIds: async () => ({}),
    postAction: async () => ({ success: true, inserted: 1, skipped: 0 }),
  };
  const response = await handleRequest(request("/api", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "submitRecords",
      requestId: "unresolved-operation",
      records: [{ company: "SCL", submissionId: "unresolved-id" }],
    }),
  }), env, { repository });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "processing");
  assert.equal(env.DB.items.get("unresolved-id").status, "processing");
  assert.equal(env.DB.batches.get("unresolved-operation").status, "processing");
});

test("keeps a processing submission pollable through both batch and item status endpoints", async () => {
  const { env, token } = await createAuthenticatedContext();
  env.DB.batches.set("processing-batch", {
    batchId: "processing-batch", status: "processing", expectedCount: 1,
    insertedCount: 0, skippedCount: 0, repairedCount: 0, resultJson: null,
    errorMessage: null, createdAt: 1, updatedAt: 1,
  });
  env.DB.items.set("processing-item", {
    submissionId: "processing-item", batchId: "processing-batch", company: "SCL",
    status: "processing", rowNumber: null, createdAt: 1, updatedAt: 1,
  });
  const repository = { findSubmissionIds: async () => ({}) };
  for (const path of ["/submissions/processing-batch", "/submissions/processing-item"]) {
    const response = await handleRequest(request(path, token), env, { repository });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.status, "processing");
    assert.equal(body.result, null);
  }
});

test("uses a company-specific D1 lock for a single-company mutation", async () => {
  const { env, token } = await createAuthenticatedContext();
  const repository = {
    getAction: async () => ({ success: true }),
    findSubmissionIds: async () => ({}),
    postAction: async () => ({ success: true, saved: 1 }),
  };
  const response = await handleRequest(request("/api", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "updateTemplate", requestId: "company-lock-test", company: "SCL", mappings: [] }),
  }), env, { repository });
  assert.equal(response.status, 200);
  assert.ok(env.DB.calls.some((call) => call.sql.includes("INSERT INTO write_locks") && call.bindings[0] === "amrs-sheets-write:scl"));
});

test("routes Galaxy Log overview and sync through the AE session and dedicated lock", async () => {
  const { env, token } = await createAuthenticatedContext();
  const calls = [];
  const repository = {
    getAction: async (params) => { calls.push(["get", params.action]); return { success: true, tasks: [] }; },
    postAction: async (payload) => { calls.push(["post", payload.action]); return { success: true, results: [] }; },
  };
  const overviewResponse = await handleRequest(request("/api?action=galaxyLogOverview", token), env, { repository });
  assert.equal(overviewResponse.status, 200);
  assert.equal((await overviewResponse.json()).success, true);
  const syncResponse = await handleRequest(request("/api", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "syncGalaxyLog", requestId: "galaxy-sync-lock", mutations: [] }),
  }), env, { repository });
  assert.equal(syncResponse.status, 200);
  assert.deepEqual(calls, [["get", "galaxyLogOverview"], ["post", "syncGalaxyLog"]]);
  assert.ok(env.DB.calls.some((call) => call.sql.includes("INSERT INTO write_locks") && call.bindings[0] === "amrs-sheets-write:galaxy-log"));
});

test("uses the global D1 lock for a multi-company submission batch", async () => {
  const { env, token } = await createAuthenticatedContext();
  const repository = {
    findSubmissionIds: async () => ({}),
    postAction: async () => ({
      success: true,
      inserted: 2,
      skipped: 0,
      insertedSubmissionIds: ["scl-id", "mgm-id"],
      skippedSubmissionIds: [],
    }),
  };
  const response = await handleRequest(request("/api", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "submitRecords",
      requestId: "global-lock-test",
      records: [
        { company: "SCL", submissionId: "scl-id" },
        { company: "MGM", submissionId: "mgm-id" },
      ],
    }),
  }), env, { repository });
  assert.equal(response.status, 200);
  assert.ok(env.DB.calls.some((call) => call.sql.includes("INSERT INTO write_locks") && call.bindings[0] === "amrs-sheets-write:global"));
});

test("tracks CVCS submissions as idempotent batches under a dedicated write lock", async () => {
  const { env, token } = await createAuthenticatedContext();
  const repository = {
    findSubmissionIds: async (items) => Object.fromEntries(items.map((item) => [item.submissionId, { company: "cvcs" }])),
    postAction: async () => ({
      success: true,
      inserted: 1,
      skipped: 0,
      insertedSubmissionIds: ["cvcs-id"],
      skippedSubmissionIds: [],
    }),
  };
  const response = await handleRequest(request("/api", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "submitCvcsRecords",
      requestId: "cvcs-lock-test",
      records: [{ property: "Venetian", submissionId: "cvcs-id" }],
    }),
  }), env, { repository });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.batchId, "cvcs-lock-test");
  assert.equal(env.DB.items.get("cvcs-id").company, "cvcs");
  assert.ok(env.DB.calls.some((call) => call.sql.includes("INSERT INTO write_locks") && call.bindings[0] === "amrs-sheets-write:cvcs"));
});

test("advances a dynamic clock while waiting for a D1 write lock", async () => {
  const { env } = await createAuthenticatedContext();
  const scope = "amrs-sheets-write:dynamic-clock";
  env.DB.locks.set(scope, { owner: "other-request", expiresAt: Date.now() + 1_000 });
  setTimeout(() => env.DB.locks.delete(scope), 15);
  const result = await withWriteLock(env.DB, {
    scope,
    owner: "current-request",
    ttlMs: 1_000,
    waitMs: 200,
    pollMs: 5,
    now: () => Date.now(),
  }, async () => "acquired");
  assert.equal(result, "acquired");
});
