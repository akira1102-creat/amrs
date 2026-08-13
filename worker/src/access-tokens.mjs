import { sha256Base64Url } from "./crypto.mjs";

export const ACCESS_PERMISSIONS = Object.freeze(["schedule", "ae", "cvcs", "admin"]);
export const ACCESS_TOKEN_STATUS = Object.freeze({ ACTIVE: "active", SUSPENDED: "suspended" });

function text(value) {
  return String(value == null ? "" : value).trim();
}

function nowValue(now = Date.now) {
  const value = typeof now === "function" ? now() : now;
  return Number.isFinite(Number(value)) ? Math.floor(Number(value)) : Date.now();
}

function statement(db, sql, bindings = []) {
  if (!db || typeof db.prepare !== "function") throw Object.assign(new Error("D1 token storage is unavailable"), { status: 503 });
  const prepared = db.prepare(sql);
  return typeof prepared.bind === "function" ? prepared.bind(...bindings) : prepared;
}

function parsePermissions(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return []; }
  }
  if (value && typeof value === "object") return Object.entries(value).filter(([, enabled]) => Boolean(enabled)).map(([permission]) => permission);
  return [];
}

export function normalizePermissions(value) {
  const requested = new Set(parsePermissions(value).map(text));
  return ACCESS_PERMISSIONS.filter((permission) => requested.has(permission));
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: text(row.id),
    tokenSuffix: text(row.token_suffix || row.tokenSuffix),
    label: text(row.label),
    note: text(row.note),
    permissions: normalizePermissions(row.permissions_json ?? row.permissions),
    status: text(row.status) || ACCESS_TOKEN_STATUS.ACTIVE,
    createdAt: Number(row.created_at ?? row.createdAt) || 0,
    updatedAt: Number(row.updated_at ?? row.updatedAt) || 0,
    lastUsedAt: row.last_used_at == null && row.lastUsedAt == null ? null : Number(row.last_used_at ?? row.lastUsedAt),
  };
}

function randomHex(bytes = 24) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function defaultToken() {
  return `amrs_${randomHex()}`;
}

function defaultId() {
  return globalThis.crypto?.randomUUID ? crypto.randomUUID() : randomHex(16);
}

function validStatus(value) {
  const status = text(value) || ACCESS_TOKEN_STATUS.ACTIVE;
  if (!Object.values(ACCESS_TOKEN_STATUS).includes(status)) throw Object.assign(new Error("Invalid token status"), { status: 400 });
  return status;
}

export async function createAccessToken(db, input = {}, options = {}) {
  const label = text(input.label);
  if (!label) throw Object.assign(new Error("Token label is required"), { status: 400 });
  const permissions = normalizePermissions(input.permissions);
  if (!permissions.length) throw Object.assign(new Error("At least one permission is required"), { status: 400 });
  const token = text((options.randomToken || defaultToken)());
  if (token.length < 20) throw Object.assign(new Error("Generated token is too short"), { status: 500 });
  const id = text((options.randomId || defaultId)());
  const timestamp = nowValue(options.now);
  const tokenHash = await sha256Base64Url(token);
  const tokenSuffix = token.slice(-4);
  await statement(db, `
    INSERT INTO access_tokens (
      id, token_hash, token_suffix, label, note, permissions_json, status,
      created_at, updated_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `, [id, tokenHash, tokenSuffix, label, text(input.note), JSON.stringify(permissions), ACCESS_TOKEN_STATUS.ACTIVE, timestamp, timestamp]).run();
  return { token, record: { id, tokenSuffix, label, note: text(input.note), permissions, status: ACCESS_TOKEN_STATUS.ACTIVE, createdAt: timestamp, updatedAt: timestamp, lastUsedAt: null } };
}

export async function listAccessTokens(db) {
  const result = await statement(db, `
    SELECT id, token_suffix, label, note, permissions_json, status,
           created_at, updated_at, last_used_at
      FROM access_tokens
     ORDER BY created_at DESC
  `).all();
  return (result?.results || []).map(mapRow);
}

export async function getAccessToken(db, id) {
  return mapRow(await statement(db, `
    SELECT id, token_suffix, label, note, permissions_json, status,
           created_at, updated_at, last_used_at
      FROM access_tokens
     WHERE id = ?
  `, [text(id)]).first());
}

export async function findActiveAccessToken(db, token, options = {}) {
  const raw = text(token);
  if (!raw) return null;
  const hash = await sha256Base64Url(raw);
  const row = await statement(db, `
    SELECT id, token_suffix, label, note, permissions_json, status,
           created_at, updated_at, last_used_at
      FROM access_tokens
     WHERE token_hash = ?
  `, [hash]).first();
  const mapped = mapRow(row);
  if (!mapped || mapped.status !== ACCESS_TOKEN_STATUS.ACTIVE) return null;
  const timestamp = nowValue(options.now);
  await statement(db, `
    UPDATE access_tokens
       SET last_used_at = ?, updated_at = ?
     WHERE id = ?
  `, [timestamp, timestamp, mapped.id]).run();
  return { ...mapped, lastUsedAt: timestamp, updatedAt: timestamp };
}

export async function findActiveAccessTokenById(db, id, options = {}) {
  const record = await getAccessToken(db, id);
  if (!record || record.status !== ACCESS_TOKEN_STATUS.ACTIVE) return null;
  if (options.touch === false) return record;
  const timestamp = nowValue(options.now);
  const minimumInterval = Math.max(0, Number(options.minimumTouchIntervalMs ?? 5 * 60 * 1000));
  if (record.lastUsedAt && timestamp - record.lastUsedAt < minimumInterval) return record;
  await statement(db, `
    UPDATE access_tokens
       SET last_used_at = ?, updated_at = ?
     WHERE id = ?
  `, [timestamp, timestamp, record.id]).run();
  return { ...record, lastUsedAt: timestamp, updatedAt: timestamp };
}

export async function updateAccessToken(db, id, changes = {}, options = {}) {
  const current = await getAccessToken(db, id);
  if (!current) throw Object.assign(new Error("Token not found"), { status: 404 });
  const permissions = Object.hasOwn(changes, "permissions") ? normalizePermissions(changes.permissions) : current.permissions;
  if (current.permissions.includes("admin") && !permissions.includes("admin")) {
    throw Object.assign(new Error("The administrator permission cannot be removed from an administrator token"), { status: 400 });
  }
  if (!permissions.length) throw Object.assign(new Error("At least one permission is required"), { status: 400 });
  const label = Object.hasOwn(changes, "label") ? text(changes.label) : current.label;
  if (!label) throw Object.assign(new Error("Token label is required"), { status: 400 });
  const note = Object.hasOwn(changes, "note") ? text(changes.note) : current.note;
  const status = Object.hasOwn(changes, "status") ? validStatus(changes.status) : current.status;
  const timestamp = nowValue(options.now);
  await statement(db, `
    UPDATE access_tokens
       SET label = ?, note = ?, permissions_json = ?, status = ?, updated_at = ?
     WHERE id = ?
  `, [label, note, JSON.stringify(permissions), status, timestamp, current.id]).run();
  return { ...current, label, note, permissions, status, updatedAt: timestamp };
}

export async function deleteAccessToken(db, id) {
  const result = await statement(db, "DELETE FROM access_tokens WHERE id = ?", [text(id)]).run();
  const changes = Number(result?.meta?.changes);
  return Number.isFinite(changes) ? changes > 0 : true;
}

export async function bootstrapAdministratorToken(db, input = {}, options = {}) {
  const existing = await listAccessTokens(db);
  if (existing.length) throw Object.assign(new Error("Administrator token has already been initialized"), { status: 409 });
  return createAccessToken(db, {
    label: text(input.label) || "System Owner",
    note: text(input.note) || "Initial administrator token",
    permissions: ACCESS_PERMISSIONS,
  }, options);
}

export async function handleAccessTokenAdminAction(db, payload = {}, options = {}) {
  const action = text(payload.action);
  if (action === "listAccessTokens") return { success: true, tokens: await listAccessTokens(db) };
  if (action === "createAccessToken") {
    const created = await createAccessToken(db, payload, options);
    return { success: true, token: created.token, record: created.record };
  }
  if (action === "updateAccessToken") {
    return { success: true, record: await updateAccessToken(db, payload.id, payload, options) };
  }
  if (action === "deleteAccessToken") {
    const deleted = await deleteAccessToken(db, payload.id);
    if (!deleted) throw Object.assign(new Error("Token not found"), { status: 404 });
    return { success: true, deleted: true };
  }
  throw Object.assign(new Error("Unsupported token administration action"), { status: 400 });
}
