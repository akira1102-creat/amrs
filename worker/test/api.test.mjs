import assert from "node:assert/strict";
import test from "node:test";
import { issueSessionToken, sha256Base64Url } from "../src/crypto.mjs";
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
              if (sql.trimStart().startsWith("UPDATE operations")) {
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
  assert.equal(permissionForAction("mgmCheckRequests"), "ae");
  assert.equal(permissionForAction("syncMgmCheckRequests"), "ae");
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

for (const status of ["completed", "processing", "failed"]) {
  test(`rejects cross-permission ${status} operation reads and cached replay`, async () => {
    const { env } = await createAuthenticatedContext();
    const token = await issueSessionToken(env.AMRS_TOKEN_SECRET, { scope: "amrs", permissions: ["ae"] });
    env.DB.operations.set("restricted-operation", {
      requestId: "restricted-operation", action: "updateScheduleRemark", status,
      resultJson: JSON.stringify({ success: true, remark: "Synthetic private schedule note" }),
      errorMessage: null, retryable: 0, createdAt: 1, updatedAt: 1,
    });
    const repository = { postAction: async () => { throw new Error("unauthorized mutation executed"); } };
    for (const init of [
      { path: "/operations/restricted-operation" },
      { path: "/operations/restricted%2Doperation" },
      { path: "/api", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "updateRecord", requestId: "restricted-operation" }) },
      { path: "/api", method: "POST", headers: { "content-type": "application/json", "x-amrs-request-id": "restricted-operation" }, body: JSON.stringify({ action: "updateRecord" }) },
    ]) {
      const { path, ...options } = init;
      const response = await handleRequest(request(path, token, options), env, { repository });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).result, undefined);
      assert.equal(env.DB.operations.get("restricted-operation").status, status);
    }
  });
}

for (const company of ["cvcs", "cvcs-broken", "SCL"]) {
  test(`checks stored ${company} submission scope before batch or item reconciliation`, async () => {
    const { env } = await createAuthenticatedContext();
    const permission = company.startsWith("cvcs") ? "cvcs" : "ae";
    const deniedToken = await issueSessionToken(env.AMRS_TOKEN_SECRET, { scope: "amrs", permissions: [permission === "ae" ? "cvcs" : "ae"] });
    const allowedToken = await issueSessionToken(env.AMRS_TOKEN_SECRET, { scope: "amrs", permissions: [permission] });
    env.DB.batches.set("restricted-batch", {
      batchId: "restricted-batch", status: "processing", expectedCount: 1,
      insertedCount: 0, skippedCount: 0, repairedCount: 0, resultJson: null,
      errorMessage: null, createdAt: 1, updatedAt: 1,
    });
    env.DB.items.set("restricted-item", {
      submissionId: "restricted-item", batchId: "restricted-batch", company,
      status: "processing", rowNumber: null, createdAt: 1, updatedAt: 1,
    });
    let reconciliations = 0;
    const repository = { findSubmissionIds: async () => { reconciliations++; return { "restricted-item": { company } }; } };
    for (const path of ["/submissions/restricted-batch", "/submissions/restricted-item"]) {
      const response = await handleRequest(request(path, deniedToken), env, { repository });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).batch, undefined);
      assert.equal(reconciliations, 0);
      assert.equal(env.DB.items.get("restricted-item").status, "processing");
    }
    for (const path of ["/submissions/restricted-batch", "/submissions/restricted-item"]) {
      const response = await handleRequest(request(path, allowedToken), env, { repository });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, "completed");
    }
  });
}

test("permits shared schedule access and idempotent replay for a matching scope", async () => {
  const { env } = await createAuthenticatedContext();
  const token = await issueSessionToken(env.AMRS_TOKEN_SECRET, { scope: "amrs", permissions: ["schedule"] });
  env.DB.operations.set("shared-operation", {
    requestId: "shared-operation", action: "updateScheduleRemark", status: "completed",
    resultJson: JSON.stringify({ success: true, remark: "Synthetic shared note" }),
    errorMessage: null, retryable: 0, createdAt: 1, updatedAt: 1,
  });
  const repository = { postAction: async () => { throw new Error("must not execute twice"); } };
  const read = await handleRequest(request("/operations/shared-operation", token), env, { repository });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).result.remark, "Synthetic shared note");
  const replay = await handleRequest(request("/api", token, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "updateScheduleRemark", requestId: "shared-operation" }),
  }), env, { repository });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).remark, "Synthetic shared note");
});

test("rejects reusing a CVCS batch ID or item ID through an AE submission", async () => {
  const { env, token: universalToken } = await createAuthenticatedContext();
  const repository = {
    findSubmissionIds: async () => ({}),
    postAction: async () => ({ success: true, inserted: 1 }),
  };
  const initial = await handleRequest(request("/api", universalToken, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "submitCvcsRecords", requestId: "cvcs-request", batchId: "cvcs-batch", records: [{ submissionId: "cvcs-existing-item" }] }),
  }), env, { repository });
  assert.equal(initial.status, 200);
  const token = await issueSessionToken(env.AMRS_TOKEN_SECRET, { scope: "amrs", permissions: ["ae"] });
  for (const [batchId, submissionId] of [["cvcs-batch", "ae-new-item"], ["ae-new-batch", "cvcs-existing-item"]]) {
    const response = await handleRequest(request("/api", token, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "submitRecords", requestId: `ae-request-${batchId}`, batchId, records: [{ company: "SCL", submissionId }] }),
    }), env, { repository });
    assert.equal(response.status, 403);
    assert.equal(env.DB.batches.has("ae-new-batch"), false);
    assert.equal(env.DB.items.has("ae-new-item"), false);
    assert.equal(env.DB.batches.get("cvcs-batch").status, "processing");
  }
});

test("denies CVCS operation polling before reconciliation can run", async () => {
  const { env } = await createAuthenticatedContext();
  const token = await issueSessionToken(env.AMRS_TOKEN_SECRET, { scope: "amrs", permissions: ["ae"] });
  env.DB.operations.set("cvcs-poll", { requestId: "cvcs-poll", action: "submitCvcsRecords", status: "processing", resultJson: null, errorMessage: null, retryable: 0, createdAt: 1, updatedAt: 1 });
  env.DB.batches.set("cvcs-poll", { batchId: "cvcs-poll", status: "processing", expectedCount: 1, insertedCount: 0, skippedCount: 0, repairedCount: 0, resultJson: null, errorMessage: null, createdAt: 1, updatedAt: 1 });
  env.DB.items.set("cvcs-poll-item", { submissionId: "cvcs-poll-item", batchId: "cvcs-poll", company: "cvcs", status: "processing", rowNumber: null, createdAt: 1, updatedAt: 1 });
  let reconciliations = 0;
  const response = await handleRequest(request("/operations/cvcs-poll", token), env, { repository: { findSubmissionIds: async () => { reconciliations++; return {}; } } });
  assert.equal(response.status, 403);
  assert.equal(reconciliations, 0);
});

test("rechecks operation scope when a concurrent insert wins the request ID", async () => {
  const { env } = await createAuthenticatedContext();
  const token = await issueSessionToken(env.AMRS_TOKEN_SECRET, { scope: "amrs", permissions: ["ae"] });
  const originalPrepare = env.DB.prepare;
  env.DB.prepare = (sql) => {
    if (sql.includes("INSERT INTO operations")) env.DB.operations.set("racing-request", {
      requestId: "racing-request", action: "updateScheduleRemark", status: "completed",
      resultJson: JSON.stringify({ remark: "Synthetic concurrent note" }), errorMessage: null,
      retryable: 0, createdAt: 1, updatedAt: 1,
    });
    return originalPrepare(sql);
  };
  const response = await handleRequest(request("/api", token, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "updateRecord", requestId: "racing-request" }),
  }), env, { repository: { postAction: async () => { throw new Error("must not write"); } } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).remark, undefined);
});

test("requires all stored scopes for mixed batches, including item aliases", async () => {
  const { env } = await createAuthenticatedContext();
  env.DB.batches.set("mixed-batch", { batchId: "mixed-batch", status: "completed", expectedCount: 2, insertedCount: 2, skippedCount: 0, repairedCount: 0, resultJson: '{"success":true}', errorMessage: null, createdAt: 1, updatedAt: 1 });
  for (const [submissionId, company] of [["mixed-ae", "SCL"], ["mixed-cvcs", "cvcs-broken"]]) env.DB.items.set(submissionId, { submissionId, batchId: "mixed-batch", company, status: "inserted", rowNumber: 1, createdAt: 1, updatedAt: 1 });
  env.DB.operations.set("mixed-operation", { requestId: "mixed-operation", action: "submitRecords", status: "completed", resultJson: '{"success":true,"batchId":"mixed-batch"}', errorMessage: null, retryable: 0, createdAt: 1, updatedAt: 1 });
  for (const permissions of [["ae"], ["cvcs"], ["ae", "cvcs"]]) {
    const token = await issueSessionToken(env.AMRS_TOKEN_SECRET, { scope: "amrs", permissions });
    for (const path of ["/submissions/mixed-batch", "/submissions/mixed-ae", "/submissions/mixed-cvcs"]) {
      const response = await handleRequest(request(path, token), env, { repository: {} });
      assert.equal(response.status, permissions.length === 2 ? 200 : 403);
    }
    if (permissions.includes("ae")) {
      const read = await handleRequest(request("/operations/mixed-operation", token), env, { repository: {} });
      assert.equal(read.status, permissions.length === 2 ? 200 : 403);
      const replay = await handleRequest(request("/api", token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "submitRecords", requestId: "mixed-operation", records: [] }) }), env, { repository: {} });
      assert.equal(replay.status, permissions.length === 2 ? 200 : 403);
    }
  }
});

test("uses stored operation linkage for empty batches and fails closed without it", async () => {
  const { env } = await createAuthenticatedContext();
  env.DB.operations.set("empty-cvcs-operation", { requestId: "empty-cvcs-operation", action: "submitCvcsRecords", status: "completed", resultJson: null, errorMessage: null, retryable: 0, createdAt: 1, updatedAt: 1 });
  for (const [batchId, result] of [["linked-empty-batch", { operationId: "empty-cvcs-operation" }], ["unlinked-empty-batch", null]]) env.DB.batches.set(batchId, { batchId, status: "completed", expectedCount: 0, insertedCount: 0, skippedCount: 0, repairedCount: 0, resultJson: JSON.stringify(result), errorMessage: null, createdAt: 1, updatedAt: 1 });
  for (const [permissions, path, expected] of [
    [["ae"], "/submissions/linked-empty-batch", 403],
    [["cvcs"], "/submissions/linked-empty-batch", 200],
    [["ae"], "/submissions/unlinked-empty-batch", 403],
    [["cvcs"], "/submissions/unlinked-empty-batch", 403],
    [["ae", "cvcs"], "/submissions/unlinked-empty-batch", 200],
  ]) {
    const token = await issueSessionToken(env.AMRS_TOKEN_SECRET, { scope: "amrs", permissions });
    const response = await handleRequest(request(path, token), env, { repository: {} });
    assert.equal(response.status, expected);
  }
});

test("polling reconciles the authorized linked batch, not a colliding request ID", async () => {
  const { env } = await createAuthenticatedContext();
  const token = await issueSessionToken(env.AMRS_TOKEN_SECRET, { scope: "amrs", permissions: ["ae"] });
  env.DB.operations.set("colliding-id", { requestId: "colliding-id", action: "submitRecords", status: "processing", resultJson: '{"success":true,"batchId":"own-ae-batch"}', errorMessage: null, retryable: 0, createdAt: 1, updatedAt: 1 });
  for (const [batchId, company, status, domain] of [["own-ae-batch", "SCL", "completed", "ae"], ["colliding-id", "cvcs", "processing", "cvcs"]]) {
    env.DB.batches.set(batchId, { batchId, status, expectedCount: 1, insertedCount: status === "completed" ? 1 : 0, skippedCount: 0, repairedCount: 0, resultJson: JSON.stringify({ success: true, domain, batchId }), errorMessage: null, createdAt: 1, updatedAt: 1 });
    env.DB.items.set(`${batchId}-item`, { submissionId: `${batchId}-item`, batchId, company, status: status === "completed" ? "inserted" : "processing", rowNumber: null, createdAt: 1, updatedAt: 1 });
  }
  const response = await handleRequest(request("/operations/colliding-id", token), env, { repository: { findSubmissionIds: async (items) => Object.fromEntries(items.map((item) => [item.submissionId, { company: item.company }])) } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.domain, "ae");
  assert.equal(env.DB.batches.get("colliding-id").status, "processing");
  assert.equal(env.DB.items.get("colliding-id-item").status, "processing");
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

test("routes MGM Check Request reads and writes through AE with a dedicated lock", async () => {
  const { env, token } = await createAuthenticatedContext();
  const calls = [];
  const repository = {
    getAction: async (params) => { calls.push(["get", params.action]); return { success: true, requests: [] }; },
    postAction: async (payload) => { calls.push(["post", payload.action]); return { success: true, results: [] }; },
  };
  const readResponse = await handleRequest(request("/api?action=mgmCheckRequests", token), env, { repository });
  assert.equal(readResponse.status, 200);
  const writeResponse = await handleRequest(request("/api", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "syncMgmCheckRequests", requestId: "mgm-check-lock", mutations: [] }),
  }), env, { repository });
  assert.equal(writeResponse.status, 200);
  assert.deepEqual(calls, [["get", "mgmCheckRequests"], ["post", "syncMgmCheckRequests"]]);
  assert.ok(env.DB.calls.some((call) => call.sql.includes("INSERT INTO write_locks") && call.bindings[0] === "amrs-sheets-write:mgm-check-request"));
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
