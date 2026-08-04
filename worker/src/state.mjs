export const DEFAULT_WRITE_LOCK_TTL_MS = 60_000;

export const SUBMISSION_BATCH_STATUS = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
});

export const SUBMISSION_ITEM_STATUS = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  INSERTED: "inserted",
  SKIPPED: "skipped",
  FAILED: "failed",
});

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function timestamp(value) {
  const number = Number(typeof value === "function" ? value() : value);
  if (!Number.isFinite(number)) throw new TypeError("Timestamp must be finite");
  return Math.floor(number);
}

function nowFrom(input, options = {}) {
  const value = options.now ?? input?.now ?? Date.now();
  return timestamp(value);
}

function serializeJson(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function parseJson(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function mapBatchRow(row) {
  if (!row) return null;
  return {
    batchId: row.batch_id,
    status: row.status,
    expectedCount: Number(row.expected_count || 0),
    insertedCount: Number(row.inserted_count || 0),
    skippedCount: Number(row.skipped_count || 0),
    repairedCount: Number(row.repaired_count || 0),
    result: parseJson(row.result_json),
    errorMessage: row.error_message ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapItemRow(row) {
  if (!row) return null;
  return {
    submissionId: row.submission_id,
    batchId: row.batch_id,
    company: row.company,
    status: row.status,
    rowNumber: row.row_number == null ? null : Number(row.row_number),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapLockRow(row) {
  if (!row) return null;
  return { scope: row.scope, owner: row.owner, expiresAt: Number(row.expires_at) };
}

function statement(db, sql, bindings = []) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("D1 database is required");
  const prepared = db.prepare(sql);
  return typeof prepared.bind === "function" ? prepared.bind(...bindings) : prepared;
}

async function run(db, sql, bindings) {
  return statement(db, sql, bindings).run();
}

async function first(db, sql, bindings) {
  return statement(db, sql, bindings).first();
}

function batchInput(input, expectedCount, options) {
  if (typeof input === "string") return { ...(options || {}), batchId: input, expectedCount };
  return { ...(input || {}), ...(options || {}) };
}

function itemInput(input, options) {
  if (typeof input === "string") return { ...(options || {}), submissionId: input };
  return { ...(input || {}), ...(options || {}) };
}

function batchValues(input) {
  const createdAt = nowFrom(input, { now: input.createdAt ?? input.created_at ?? input.now });
  const updatedAt = nowFrom(input, { now: input.updatedAt ?? input.updated_at ?? input.now ?? createdAt });
  return {
    batchId: requiredText(input.batchId ?? input.batch_id, "batchId"),
    status: String(input.status || SUBMISSION_BATCH_STATUS.PENDING),
    expectedCount: Number(input.expectedCount ?? input.expected_count ?? 0),
    insertedCount: Number(input.insertedCount ?? input.inserted_count ?? 0),
    skippedCount: Number(input.skippedCount ?? input.skipped_count ?? 0),
    repairedCount: Number(input.repairedCount ?? input.repaired_count ?? 0),
    resultJson: serializeJson(input.result ?? input.result_json),
    errorMessage: input.errorMessage ?? input.error_message ?? null,
    createdAt,
    updatedAt,
  };
}

function itemValues(input) {
  const createdAt = nowFrom(input, { now: input.createdAt ?? input.created_at ?? input.now });
  const updatedAt = nowFrom(input, { now: input.updatedAt ?? input.updated_at ?? input.now ?? createdAt });
  return {
    submissionId: requiredText(input.submissionId ?? input.submission_id, "submissionId"),
    batchId: requiredText(input.batchId ?? input.batch_id, "batchId"),
    company: requiredText(input.company, "company"),
    status: String(input.status || SUBMISSION_ITEM_STATUS.PENDING),
    rowNumber: input.rowNumber ?? input.row_number ?? null,
    createdAt,
    updatedAt,
  };
}

export async function getSubmissionBatch(db, batchId) {
  const id = requiredText(batchId, "batchId");
  return mapBatchRow(await first(db, `
    SELECT batch_id, status, expected_count, inserted_count, skipped_count,
           repaired_count, result_json, error_message, created_at, updated_at
      FROM submission_batches
     WHERE batch_id = ?
  `, [id]));
}

export async function createSubmissionBatch(db, input, expectedCount, options = {}) {
  const values = batchValues(batchInput(input, expectedCount, options));
  await run(db, `
    INSERT INTO submission_batches (
      batch_id, status, expected_count, inserted_count, skipped_count,
      repaired_count, result_json, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(batch_id) DO NOTHING
  `, [
    values.batchId,
    values.status,
    values.expectedCount,
    values.insertedCount,
    values.skippedCount,
    values.repairedCount,
    values.resultJson,
    values.errorMessage,
    values.createdAt,
    values.updatedAt,
  ]);
  return (await getSubmissionBatch(db, values.batchId)) || {
    ...values,
    result: parseJson(values.resultJson),
  };
}

export async function upsertSubmissionBatch(db, input, options = {}) {
  const values = batchValues(batchInput(input, undefined, options));
  await run(db, `
    INSERT INTO submission_batches (
      batch_id, status, expected_count, inserted_count, skipped_count,
      repaired_count, result_json, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(batch_id) DO UPDATE SET
      status = excluded.status,
      expected_count = excluded.expected_count,
      inserted_count = excluded.inserted_count,
      skipped_count = excluded.skipped_count,
      repaired_count = excluded.repaired_count,
      result_json = excluded.result_json,
      error_message = excluded.error_message,
      updated_at = excluded.updated_at
  `, [
    values.batchId,
    values.status,
    values.expectedCount,
    values.insertedCount,
    values.skippedCount,
    values.repairedCount,
    values.resultJson,
    values.errorMessage,
    values.createdAt,
    values.updatedAt,
  ]);
  return (await getSubmissionBatch(db, values.batchId)) || {
    ...values,
    result: parseJson(values.resultJson),
  };
}

export async function updateSubmissionBatch(db, batchId, rawPatch = {}, options = {}) {
  const id = requiredText(batchId, "batchId");
  const patch = typeof rawPatch === "string" ? { status: rawPatch } : (rawPatch || {});
  const values = [];
  const assignments = [];
  const fields = [
    ["status", "status"],
    ["expectedCount", "expected_count"],
    ["insertedCount", "inserted_count"],
    ["skippedCount", "skipped_count"],
    ["repairedCount", "repaired_count"],
    ["errorMessage", "error_message"],
  ];
  for (const [inputKey, column] of fields) {
    const snakeKey = column;
    if (!hasOwn(patch, inputKey) && !hasOwn(patch, snakeKey)) continue;
    assignments.push(`${column} = ?`);
    values.push(hasOwn(patch, inputKey) ? patch[inputKey] : patch[snakeKey]);
  }
  if (hasOwn(patch, "result") || hasOwn(patch, "result_json")) {
    assignments.push("result_json = ?");
    values.push(serializeJson(patch.result ?? patch.result_json));
  }
  const updatedAt = nowFrom(patch, options);
  assignments.push("updated_at = ?");
  values.push(updatedAt, id);
  await run(db, `UPDATE submission_batches SET ${assignments.join(", ")} WHERE batch_id = ?`, values);
  return getSubmissionBatch(db, id);
}

export async function getSubmissionItem(db, submissionId) {
  const id = requiredText(submissionId, "submissionId");
  return mapItemRow(await first(db, `
    SELECT submission_id, batch_id, company, status, row_number, created_at, updated_at
      FROM submission_items
     WHERE submission_id = ?
  `, [id]));
}

export async function listSubmissionItems(db, batchId, options = {}) {
  const id = requiredText(batchId, "batchId");
  const status = options.status == null ? null : String(options.status);
  const result = status == null
    ? await statement(db, `
        SELECT submission_id, batch_id, company, status, row_number, created_at, updated_at
          FROM submission_items
         WHERE batch_id = ?
         ORDER BY row_number IS NULL, row_number, created_at, submission_id
      `, [id]).all()
    : await statement(db, `
        SELECT submission_id, batch_id, company, status, row_number, created_at, updated_at
          FROM submission_items
         WHERE batch_id = ? AND status = ?
         ORDER BY row_number IS NULL, row_number, created_at, submission_id
      `, [id, status]).all();
  const rows = Array.isArray(result) ? result : (result?.results || []);
  return rows.map(mapItemRow);
}

export async function createSubmissionItem(db, input, options = {}) {
  const values = itemValues(itemInput(input, options));
  await run(db, `
    INSERT INTO submission_items (
      submission_id, batch_id, company, status, row_number, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(submission_id) DO NOTHING
  `, [
    values.submissionId,
    values.batchId,
    values.company,
    values.status,
    values.rowNumber,
    values.createdAt,
    values.updatedAt,
  ]);
  return (await getSubmissionItem(db, values.submissionId)) || valuesToItem(values);
}

export async function upsertSubmissionItem(db, input, options = {}) {
  const values = itemValues(itemInput(input, options));
  await run(db, `
    INSERT INTO submission_items (
      submission_id, batch_id, company, status, row_number, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(submission_id) DO UPDATE SET
      batch_id = excluded.batch_id,
      company = excluded.company,
      status = excluded.status,
      row_number = excluded.row_number,
      updated_at = excluded.updated_at
  `, [
    values.submissionId,
    values.batchId,
    values.company,
    values.status,
    values.rowNumber,
    values.createdAt,
    values.updatedAt,
  ]);
  return (await getSubmissionItem(db, values.submissionId)) || valuesToItem(values);
}

function valuesToItem(values) {
  return {
    submissionId: values.submissionId,
    batchId: values.batchId,
    company: values.company,
    status: values.status,
    rowNumber: values.rowNumber == null ? null : Number(values.rowNumber),
    createdAt: values.createdAt,
    updatedAt: values.updatedAt,
  };
}

export async function updateSubmissionItem(db, submissionId, rawPatch = {}, options = {}) {
  const id = requiredText(submissionId, "submissionId");
  const patch = typeof rawPatch === "string" ? { status: rawPatch } : (rawPatch || {});
  const values = [];
  const assignments = [];
  const fields = [
    ["batchId", "batch_id"],
    ["company", "company"],
    ["status", "status"],
    ["rowNumber", "row_number"],
  ];
  for (const [inputKey, column] of fields) {
    const snakeKey = column;
    if (!hasOwn(patch, inputKey) && !hasOwn(patch, snakeKey)) continue;
    assignments.push(`${column} = ?`);
    values.push(hasOwn(patch, inputKey) ? patch[inputKey] : patch[snakeKey]);
  }
  const updatedAt = nowFrom(patch, options);
  assignments.push("updated_at = ?");
  values.push(updatedAt, id);
  await run(db, `UPDATE submission_items SET ${assignments.join(", ")} WHERE submission_id = ?`, values);
  return getSubmissionItem(db, id);
}

function lockInput(scopeOrInput, ownerOrOptions, optionsOrTtl, maybeOptions) {
  if (scopeOrInput && typeof scopeOrInput === "object") {
    const options = {
      ...(typeof ownerOrOptions === "object" ? ownerOrOptions : {}),
      ...(typeof optionsOrTtl === "object" ? optionsOrTtl : {}),
      ...(maybeOptions || {}),
    };
    return { ...scopeOrInput, ...options };
  }
  const options = {
    ...(typeof optionsOrTtl === "object" ? optionsOrTtl : {}),
    ...(maybeOptions || {}),
  };
  if (typeof optionsOrTtl === "number") options.ttlMs = optionsOrTtl;
  return { ...options, scope: scopeOrInput, owner: ownerOrOptions };
}

function lockValues(scopeOrInput, ownerOrOptions, optionsOrTtl, maybeOptions) {
  const input = lockInput(scopeOrInput, ownerOrOptions, optionsOrTtl, maybeOptions);
  const scope = requiredText(input.scope, "scope");
  const owner = requiredText(input.owner, "owner");
  const now = nowFrom(input, input);
  const ttlMs = Number(input.ttlMs ?? DEFAULT_WRITE_LOCK_TTL_MS);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be positive");
  return { scope, owner, now, expiresAt: now + Math.floor(ttlMs), input };
}

export async function getWriteLock(db, scope) {
  const value = requiredText(scope, "scope");
  return mapLockRow(await first(db, `
    SELECT scope, owner, expires_at
      FROM write_locks
     WHERE scope = ?
  `, [value]));
}

export async function acquireWriteLock(db, scopeOrInput, ownerOrOptions, optionsOrTtl, maybeOptions) {
  const values = lockValues(scopeOrInput, ownerOrOptions, optionsOrTtl, maybeOptions);
  const result = await run(db, `
    INSERT INTO write_locks (scope, owner, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      owner = excluded.owner,
      expires_at = excluded.expires_at
    WHERE write_locks.expires_at <= ? OR write_locks.owner = ?
  `, [values.scope, values.owner, values.expiresAt, values.now, values.owner]);
  const changes = Number(result?.meta?.changes);
  if (Number.isFinite(changes)) return changes > 0;
  const current = await getWriteLock(db, values.scope);
  return current?.owner === values.owner && current.expiresAt === values.expiresAt;
}

export async function renewWriteLock(db, scopeOrInput, ownerOrOptions, optionsOrTtl, maybeOptions) {
  return acquireWriteLock(db, scopeOrInput, ownerOrOptions, optionsOrTtl, maybeOptions);
}

export async function releaseWriteLock(db, scopeOrInput, ownerOrOptions) {
  const input = lockInput(scopeOrInput, ownerOrOptions);
  const scope = requiredText(input.scope, "scope");
  const owner = requiredText(input.owner, "owner");
  const result = await run(db, "DELETE FROM write_locks WHERE scope = ? AND owner = ?", [scope, owner]);
  const changes = Number(result?.meta?.changes);
  return Number.isFinite(changes) ? changes > 0 : true;
}

export class WriteLockBusyError extends Error {
  constructor(scope) {
    super(`Write lock is busy for ${scope}`);
    this.name = "WriteLockBusyError";
    this.status = 409;
    this.retryable = true;
    this.scope = scope;
  }
}

function withLockInput(scopeOrInput, ownerOrCallback, callbackOrOptions, maybeOptions) {
  if (scopeOrInput && typeof scopeOrInput === "object") {
    const callback = typeof ownerOrCallback === "function" ? ownerOrCallback : callbackOrOptions;
    const options = typeof ownerOrCallback === "function"
      ? (callbackOrOptions || maybeOptions || {})
      : (maybeOptions || {});
    return { input: { ...scopeOrInput, ...options }, callback };
  }
  return {
    input: { scope: scopeOrInput, owner: ownerOrCallback, ...(maybeOptions || {}) },
    callback: callbackOrOptions,
  };
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function withWriteLock(db, scopeOrInput, ownerOrCallback, callbackOrOptions, maybeOptions) {
  const { input, callback } = withLockInput(scopeOrInput, ownerOrCallback, callbackOrOptions, maybeOptions);
  if (typeof callback !== "function") throw new TypeError("Lock callback is required");
  const values = lockValues(input);
  const waitMs = Math.max(0, Number(input.waitMs || 0));
  const pollMs = Math.max(1, Number(input.pollMs || 100));
  const wait = input.sleep || sleep;
  const startedAt = values.now;
  let acquired = false;
  while (!acquired) {
    acquired = await acquireWriteLock(db, values.input);
    if (acquired) break;
    const currentNow = nowFrom(input, input);
    if (currentNow - startedAt >= waitMs) throw new WriteLockBusyError(values.scope);
    await wait(Math.min(pollMs, waitMs - (currentNow - startedAt)));
  }

  try {
    return await callback({ scope: values.scope, owner: values.owner, expiresAt: values.expiresAt });
  } finally {
    await releaseWriteLock(db, values.scope, values.owner);
  }
}

export const createBatch = createSubmissionBatch;
export const getBatch = getSubmissionBatch;
export const updateBatch = updateSubmissionBatch;
export const createItem = createSubmissionItem;
export const getItem = getSubmissionItem;
export const updateItem = updateSubmissionItem;
export const tryAcquireWriteLock = acquireWriteLock;
export const acquireLock = acquireWriteLock;
export const releaseLock = releaseWriteLock;
export const withLock = withWriteLock;
