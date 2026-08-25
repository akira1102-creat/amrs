import { createSession, requireSession } from "./auth.mjs";
import { handleAccessTokenAdminAction } from "./access-tokens.mjs";
import { apiError, corsHeaders, json } from "./http.mjs";
import {
  createSubmissionBatch,
  createSubmissionItem,
  getSubmissionBatch,
  getSubmissionItem,
  listSubmissionItems,
  updateSubmissionBatch,
  updateSubmissionItem,
  withWriteLock,
  SUBMISSION_BATCH_STATUS,
  SUBMISSION_ITEM_STATUS,
} from "./state.mjs";
import { createRepository } from "./repository.mjs";

const repositoryByEnv = new WeakMap();
const OPERATION_PROCESSING = "processing";
const OPERATION_COMPLETED = "completed";
const OPERATION_FAILED = "failed";
const SUBMISSION_ACTIONS = new Set(["submitRecords", "submitCvcsRecords", "submitCvcsBrokenParts"]);

const SCHEDULE_ACTIONS = new Set(["scheduleOverview", "scheduleMachineCounts", "updateScheduleRemark"]);
const ADMIN_ACTIONS = new Set(["bootstrapAccessToken", "listAccessTokens", "createAccessToken", "updateAccessToken", "deleteAccessToken"]);

export function permissionForAction(action) {
  const value = String(action || "").trim();
  if (ADMIN_ACTIONS.has(value)) return "admin";
  if (/cvcs/i.test(value)) return "cvcs";
  if (SCHEDULE_ACTIONS.has(value)) return "schedule";
  return "ae";
}

function isSubmissionAction(action) {
  return SUBMISSION_ACTIONS.has(text(action));
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

function nowValue(now = Date.now()) {
  const value = typeof now === "function" ? now() : now;
  return Number.isFinite(Number(value)) ? Math.floor(Number(value)) : Date.now();
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function parseJson(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function dbStatement(db, sql, bindings = []) {
  if (!db || typeof db.prepare !== "function") {
    throw Object.assign(new Error("D1 binding is required for writes and status tracking"), { status: 503, retryable: true });
  }
  const prepared = db.prepare(sql);
  return typeof prepared.bind === "function" ? prepared.bind(...bindings) : prepared;
}

async function dbFirst(db, sql, bindings = []) {
  return dbStatement(db, sql, bindings).first();
}

async function dbRun(db, sql, bindings = []) {
  return dbStatement(db, sql, bindings).run();
}

function mapOperation(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    action: row.action,
    status: row.status,
    result: parseJson(row.result_json),
    errorMessage: row.error_message ?? null,
    retryable: Boolean(Number(row.retryable || 0)),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

async function getOperation(db, requestId) {
  const id = text(requestId);
  if (!id) return null;
  return mapOperation(await dbFirst(db, `
    SELECT request_id, action, status, result_json, error_message,
           retryable, created_at, updated_at
      FROM operations
     WHERE request_id = ?
  `, [id]));
}

async function startOperation(db, requestId, action, now) {
  const timestamp = nowValue(now);
  const result = await dbRun(db, `
    INSERT INTO operations (
      request_id, action, status, result_json, error_message, retryable, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, NULL, 0, ?, ?)
    ON CONFLICT(request_id) DO NOTHING
  `, [requestId, action, OPERATION_PROCESSING, timestamp, timestamp]);
  const changes = Number(result?.meta?.changes);
  const operation = await getOperation(db, requestId);
  return { operation, created: Number.isFinite(changes) ? changes > 0 : false };
}

async function updateOperation(db, requestId, patch, now) {
  const values = [
    patch.status,
    patch.result == null ? null : JSON.stringify(patch.result),
    patch.errorMessage ?? null,
    patch.retryable ? 1 : 0,
    nowValue(now),
    requestId,
  ];
  await dbRun(db, `
    UPDATE operations
       SET status = ?, result_json = ?, error_message = ?, retryable = ?, updated_at = ?
     WHERE request_id = ?
  `, values);
  return getOperation(db, requestId);
}

class OperationInProgressError extends Error {
  constructor(requestId) {
    super("Request is still processing");
    this.name = "OperationInProgressError";
    this.status = 409;
    this.retryable = true;
    this.operationId = requestId;
  }
}

function getRepository(env, dependencies = {}) {
  if (dependencies.repository) return dependencies.repository;
  if (dependencies.repositoryFactory) return dependencies.repositoryFactory(env);
  if (env && typeof env === "object") {
    const existing = repositoryByEnv.get(env);
    if (existing) return existing;
    const repository = createRepository(env, dependencies);
    repositoryByEnv.set(env, repository);
    return repository;
  }
  return createRepository(env, dependencies);
}

async function parseBody(request) {
  const raw = await request.text();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch {
    throw Object.assign(new Error("Invalid JSON body"), { status: 400 });
  }
}

function deriveRequestId(payload, request) {
  const header = request.headers.get("x-amrs-request-id");
  if (text(payload?.requestId)) return text(payload.requestId);
  if (text(payload?.batchId)) return text(payload.batchId);
  if (header) return text(header);
  const records = Array.isArray(payload) ? payload : payload?.records;
  const firstSubmissionId = Array.isArray(records) ? text(records[0]?.submissionId) : "";
  return firstSubmissionId || randomId();
}

function resultWithOperation(result, operation, batchId = "") {
  return {
    ...(result || {}),
    operationId: operation.requestId,
    requestId: operation.requestId,
    ...(batchId ? { submissionId: batchId, batchId } : {}),
  };
}

async function prepareSubmission(db, payload, requestId, now) {
  if (!payload || !isSubmissionAction(payload.action)) return null;
  const records = Array.isArray(payload.records) ? payload.records : [];
  const batchId = text(payload.batchId) || requestId;
  const batch = await createSubmissionBatch(db, {
    batchId,
    status: SUBMISSION_BATCH_STATUS.PROCESSING,
    expectedCount: records.length,
    now: nowValue(now),
  });
  for (const record of records) {
    if (!text(record?.submissionId)) record.submissionId = randomId();
    await createSubmissionItem(db, {
      submissionId: text(record.submissionId),
      batchId,
      company: payload.action === "submitCvcsBrokenParts" ? "cvcs-broken" : payload.action === "submitCvcsRecords" ? "cvcs" : text(record.company) || "SCL",
      status: SUBMISSION_ITEM_STATUS.PENDING,
      now: nowValue(now),
    });
  }
  return { batchId, payload: { ...payload, batchId, records } };
}

async function markSubmissionItemsBeforeMutation(db, repository, batchId, now) {
  const items = await listSubmissionItems(db, batchId);
  if (!items.length || typeof repository.findSubmissionIds !== "function") return items;
  const found = await repository.findSubmissionIds(items);
  for (const item of items) {
    const status = found[item.submissionId]
      ? SUBMISSION_ITEM_STATUS.SKIPPED
      : SUBMISSION_ITEM_STATUS.PROCESSING;
    if (status !== item.status) {
      await updateSubmissionItem(db, item.submissionId, { status, now: nowValue(now) });
    }
  }
  return listSubmissionItems(db, batchId);
}

async function finalizeSubmissionItems(db, repository, batchId, result, now) {
  const items = await listSubmissionItems(db, batchId);
  const explicitSkipped = new Set((result?.skippedSubmissionIds || []).map(text));
  const explicitInserted = new Set((result?.insertedSubmissionIds || []).map(text));
  const unresolved = items.filter((item) => (
    item.status !== SUBMISSION_ITEM_STATUS.SKIPPED
      && item.status !== SUBMISSION_ITEM_STATUS.INSERTED
      && !explicitSkipped.has(item.submissionId)
      && !explicitInserted.has(item.submissionId)
  ));
  const foundAfter = unresolved.length && typeof repository.findSubmissionIds === "function"
    ? await repository.findSubmissionIds(unresolved)
    : {};
  for (const item of items) {
    let status = item.status;
    if (explicitSkipped.has(item.submissionId)) status = SUBMISSION_ITEM_STATUS.SKIPPED;
    else if (explicitInserted.has(item.submissionId)) status = SUBMISSION_ITEM_STATUS.INSERTED;
    else if (foundAfter[item.submissionId]) status = SUBMISSION_ITEM_STATUS.INSERTED;
    if (status !== item.status) {
      await updateSubmissionItem(db, item.submissionId, { status, now: nowValue(now) });
    }
  }
  return listSubmissionItems(db, batchId);
}

async function reconcileBatch(db, repository, batchId, now) {
  let batch = await getSubmissionBatch(db, batchId);
  if (!batch) return null;
  const items = await listSubmissionItems(db, batchId);
  const pendingItems = items.filter((item) => item.status !== SUBMISSION_ITEM_STATUS.INSERTED && item.status !== SUBMISSION_ITEM_STATUS.SKIPPED);
  if (pendingItems.length) {
    const found = await repository.findSubmissionIds(pendingItems);
    const knownSkipped = new Set(
      Array.isArray(batch.result?.skippedSubmissionIds) ? batch.result.skippedSubmissionIds.map(text) : [],
    );
    const knownInserted = new Set(
      Array.isArray(batch.result?.insertedSubmissionIds) ? batch.result.insertedSubmissionIds.map(text) : [],
    );
    for (const item of pendingItems) {
      const status = knownSkipped.has(item.submissionId)
        ? SUBMISSION_ITEM_STATUS.SKIPPED
        : knownInserted.has(item.submissionId) || found[item.submissionId]
          ? SUBMISSION_ITEM_STATUS.INSERTED
          : item.status;
      if (status !== item.status) await updateSubmissionItem(db, item.submissionId, { status, now: nowValue(now) });
    }
  }
  const refreshedItems = await listSubmissionItems(db, batchId);
  const unresolved = refreshedItems.filter((item) => item.status !== SUBMISSION_ITEM_STATUS.INSERTED && item.status !== SUBMISSION_ITEM_STATUS.SKIPPED);
  if (!unresolved.length && refreshedItems.length >= batch.expectedCount && batch.status !== SUBMISSION_BATCH_STATUS.COMPLETED) {
    const insertedCount = refreshedItems.filter((item) => item.status === SUBMISSION_ITEM_STATUS.INSERTED).length;
    batch = await updateSubmissionBatch(db, batchId, {
      status: SUBMISSION_BATCH_STATUS.COMPLETED,
      insertedCount,
      skippedCount: Math.max(batch.expectedCount - insertedCount, 0),
      result: batch.result || { success: true, acknowledged: batch.expectedCount, inserted: insertedCount },
      now: nowValue(now),
    });
  }
  return { batch, items: await listSubmissionItems(db, batchId) };
}

function mutationCompanies(payload) {
  const values = [];
  const add = (value) => { if (text(value)) values.push(text(value).toLowerCase()); };
  const records = Array.isArray(payload) ? payload : payload?.records;
  if (Array.isArray(records)) records.forEach((record) => add(record?.company));
  if (!Array.isArray(payload)) {
    if (/cvcs/i.test(text(payload.action))) return ["cvcs"];
    add(payload.company);
    add(payload.record?.company);
    if (Array.isArray(payload.brokenPartsRepairs)) payload.brokenPartsRepairs.forEach((item) => add(item?.company || item?.record?.company));
    if (payload.action === "updateMonthlySettings") add("SCL");
    if (payload.action === "ensureBrokenPartsSchema") return null;
  }
  return [...new Set(values)].sort();
}

async function executeMutation(payload, request, env, dependencies = {}) {
  const db = env.DB;
  const repository = getRepository(env, dependencies);
  const now = dependencies.now || (() => Date.now());
  const requestId = deriveRequestId(payload, request);
  const action = Array.isArray(payload) ? "insertRecords" : text(payload?.action) || "insertRecords";
  let operation = await getOperation(db, requestId);
  if (operation?.status === OPERATION_COMPLETED) return resultWithOperation(operation.result, operation, operation.result?.batchId || operation.result?.submissionId || "");
  if (operation?.status === OPERATION_PROCESSING) {
    return {
      success: true,
      status: OPERATION_PROCESSING,
      result: operation.result,
      operationId: requestId,
      requestId,
      retryable: true,
    };
  }
  const started = await startOperation(db, requestId, action, now);
  operation = started.operation;
  if (!started.created && operation?.status === OPERATION_COMPLETED) return resultWithOperation(operation.result, operation, operation.result?.batchId || "");
  if (!started.created && operation?.status === OPERATION_PROCESSING) {
    return {
      success: true,
      status: OPERATION_PROCESSING,
      result: operation.result,
      operationId: requestId,
      requestId,
      retryable: true,
    };
  }
  if (!started.created && operation?.status === OPERATION_FAILED) {
    operation = await updateOperation(db, requestId, { status: OPERATION_PROCESSING, result: null }, now);
  }
  const submissionBatchId = isSubmissionAction(action)
    ? text(payload?.batchId) || requestId
    : "";
  let prepared = null;
  let submissionComplete = true;
  try {
    prepared = await prepareSubmission(db, payload, requestId, now);
    const effectivePayload = prepared?.payload || payload;
    const companies = mutationCompanies(effectivePayload);
    const lockScope = companies?.length === 1 ? `amrs-sheets-write:${companies[0]}` : "amrs-sheets-write:global";
    const result = await withWriteLock(db, {
      scope: lockScope,
      owner: requestId,
      ttlMs: 60_000,
      waitMs: 20_000,
      pollMs: 100,
    }, async () => {
      if (prepared) await markSubmissionItemsBeforeMutation(db, repository, prepared.batchId, now);
      return repository.postAction(effectivePayload);
    });
    const finalResult = resultWithOperation(result, operation || { requestId }, prepared?.batchId || "");
    if (prepared) {
      const items = await finalizeSubmissionItems(db, repository, prepared.batchId, result, now);
      const inserted = items.filter((item) => item.status === SUBMISSION_ITEM_STATUS.INSERTED).length;
      const skipped = items.filter((item) => item.status === SUBMISSION_ITEM_STATUS.SKIPPED).length;
      const complete = items.length >= prepared.payload.records.length
        && items.every((item) => item.status === SUBMISSION_ITEM_STATUS.INSERTED || item.status === SUBMISSION_ITEM_STATUS.SKIPPED);
      submissionComplete = complete;
      await updateSubmissionBatch(db, prepared.batchId, {
        status: complete ? SUBMISSION_BATCH_STATUS.COMPLETED : SUBMISSION_BATCH_STATUS.PROCESSING,
        insertedCount: inserted,
        skippedCount: skipped,
        repairedCount: Number(result?.repaired || 0),
        result: finalResult,
        now: nowValue(now),
      });
    }
    const operationStatus = prepared && !submissionComplete ? OPERATION_PROCESSING : OPERATION_COMPLETED;
    operation = await updateOperation(db, requestId, { status: operationStatus, result: finalResult }, now);
    const response = resultWithOperation(finalResult, operation || { requestId }, prepared?.batchId || "");
    return operationStatus === OPERATION_PROCESSING
      ? { ...response, status: OPERATION_PROCESSING, retryable: true }
      : response;
  } catch (error) {
    const failedBatchId = prepared?.batchId || submissionBatchId;
    if (failedBatchId) {
      await updateSubmissionBatch(db, failedBatchId, {
        status: SUBMISSION_BATCH_STATUS.FAILED,
        errorMessage: String(error?.message || "Submission failed"),
        result: null,
        now: nowValue(now),
      });
    }
    await updateOperation(db, requestId, {
      status: OPERATION_FAILED,
      errorMessage: String(error?.message || "Request failed"),
      retryable: Boolean(error?.retryable || Number(error?.status) >= 500),
    }, now);
    error.operationId = requestId;
    error.requestId = requestId;
    throw error;
  }
}

async function operationStatus(db, repository, requestId, now) {
  let operation = await getOperation(db, requestId);
  if (!operation) throw Object.assign(new Error("Operation not found"), { status: 404 });
  if (operation.status === OPERATION_PROCESSING && isSubmissionAction(operation.action)) {
    const reconciled = await reconcileBatch(db, repository, requestId, now);
    if (reconciled?.batch?.status === SUBMISSION_BATCH_STATUS.COMPLETED) {
      operation = await updateOperation(db, requestId, {
        status: OPERATION_COMPLETED,
        result: reconciled.batch.result || { success: true, batchId: requestId },
      }, now);
    }
  }
  return operation;
}

async function statusResponse(db, repository, id, now) {
  let batch = await getSubmissionBatch(db, id);
  if (!batch) {
    const item = await getSubmissionItem(db, id);
    if (!item) throw Object.assign(new Error("Submission not found"), { status: 404 });
    const reconciled = await reconcileBatch(db, repository, item.batchId, now);
    batch = reconciled?.batch || await getSubmissionBatch(db, item.batchId);
    const items = reconciled?.items || await listSubmissionItems(db, item.batchId);
    return {
      success: true,
      status: batch?.status || item.status,
      result: batch?.result || null,
      retryable: batch?.status === SUBMISSION_BATCH_STATUS.PROCESSING,
      batch,
      items,
    };
  }
  const result = await reconcileBatch(db, repository, id, now);
  const finalBatch = result?.batch || batch;
  return {
    success: true,
    status: finalBatch.status,
    result: finalBatch.result || null,
    retryable: finalBatch.status === SUBMISSION_BATCH_STATUS.PROCESSING,
    batch: finalBatch,
    items: result?.items || [],
  };
}

async function route(request, env, dependencies = {}) {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/health" && request.method === "GET") return { success: true, service: "amrs-api" };
  if (pathname === "/session" && request.method === "POST") return createSession(request, env);
  const now = dependencies.now || (() => Date.now());
  if (pathname === "/api" && request.method === "GET") {
    const params = Object.fromEntries(url.searchParams.entries());
    const permission = permissionForAction(params.action);
    await requireSession(request, env, permission);
    if (permission === "admin") return handleAccessTokenAdminAction(env.DB, params, { now });
    const repository = getRepository(env, dependencies);
    return repository.getAction(params);
  }
  if (pathname === "/api" && request.method === "POST") {
    const payload = await parseBody(request);
    const permission = permissionForAction(payload?.action);
    await requireSession(request, env, permission);
    if (permission === "admin") return handleAccessTokenAdminAction(env.DB, payload, { now });
    return executeMutation(payload, request, env, dependencies);
  }
  await requireSession(request, env);
  const repository = getRepository(env, dependencies);
  const operationMatch = pathname.match(/^\/operations\/([^/]+)$/);
  if (operationMatch && request.method === "GET") {
    const operation = await operationStatus(env.DB, repository, decodeURIComponent(operationMatch[1]), now);
    return { success: true, operation, status: operation.status, result: operation.result, retryable: operation.retryable };
  }
  const submissionMatch = pathname.match(/^\/submissions\/([^/]+)$/);
  if (submissionMatch && request.method === "GET") {
    return statusResponse(env.DB, repository, decodeURIComponent(submissionMatch[1]), now);
  }
  throw Object.assign(new Error("Not found"), { status: 404 });
}

export async function handleRequest(request, env = {}, dependencies = {}) {
  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  try {
    return json(await route(request, env, dependencies), 200, cors);
  } catch (error) {
    console.error("AMRS API request failed", {
      path: new URL(request.url).pathname,
      message: error instanceof Error ? error.message : String(error),
      upstreamStatus: Number(error?.status || 0) || undefined,
      upstreamMessage: error?.details?.error?.message || undefined,
    });
    const result = apiError(error);
    if (error?.operationId) result.body.operationId = error.operationId;
    if (error?.requestId) result.body.requestId = error.requestId;
    return json(result.body, result.status, cors);
  }
}

export { getOperation, reconcileBatch, route };
