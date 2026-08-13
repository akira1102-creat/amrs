import assert from "node:assert/strict";
import test from "node:test";

import {
  createAccessToken,
  bootstrapAdministratorToken,
  deleteAccessToken,
  findActiveAccessToken,
  handleAccessTokenAdminAction,
  listAccessTokens,
  normalizePermissions,
  updateAccessToken,
} from "../src/access-tokens.mjs";
import { sha256Base64Url } from "../src/crypto.mjs";

function createDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async run() {
              if (sql.includes("INSERT INTO access_tokens")) {
                const [id, tokenHash, tokenSuffix, label, note, permissionsJson, status, createdAt, updatedAt] = bindings;
                rows.set(id, { id, token_hash: tokenHash, token_suffix: tokenSuffix, label, note, permissions_json: permissionsJson, status, created_at: createdAt, updated_at: updatedAt, last_used_at: null });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE access_tokens") && sql.includes("last_used_at")) {
                const [lastUsedAt, updatedAt, id] = bindings;
                Object.assign(rows.get(id), { last_used_at: lastUsedAt, updated_at: updatedAt });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE access_tokens")) {
                const [label, note, permissionsJson, status, updatedAt, id] = bindings;
                Object.assign(rows.get(id), { label, note, permissions_json: permissionsJson, status, updated_at: updatedAt });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("DELETE FROM access_tokens")) {
                return { meta: { changes: rows.delete(bindings[0]) ? 1 : 0 } };
              }
              return { meta: { changes: 0 } };
            },
            async first() {
              if (sql.includes("token_hash")) return [...rows.values()].find((row) => row.token_hash === bindings[0]) || null;
              if (sql.includes("WHERE id")) return rows.get(bindings[0]) || null;
              return null;
            },
            async all() {
              return { results: [...rows.values()] };
            },
          };
        },
      };
    },
  };
}

test("normalizes only approved permission groups and requires explicit admin", () => {
  assert.deepEqual(normalizePermissions(["schedule", "cvcs", "unknown"]), ["schedule", "cvcs"]);
  assert.deepEqual(normalizePermissions({ ae: true, admin: false, cvcs: true }), ["ae", "cvcs"]);
});

test("creates a one-time plaintext token while storing only its hash", async () => {
  const db = createDb();
  const created = await createAccessToken(db, {
    label: "Synthetic User",
    note: "Synthetic note",
    permissions: ["schedule", "cvcs"],
  }, {
    now: () => 1000,
    randomToken: () => "amrs_synthetic_plaintext_token",
    randomId: () => "token-synthetic",
  });
  assert.equal(created.token, "amrs_synthetic_plaintext_token");
  assert.equal(created.record.tokenSuffix, "oken");
  const stored = db.rows.get("token-synthetic");
  assert.equal(stored.token_hash, await sha256Base64Url(created.token));
  assert.equal(JSON.stringify(stored).includes(created.token), false);
  assert.equal((await listAccessTokens(db))[0].token, undefined);
});

test("finds active tokens, updates last use, and rejects suspended tokens", async () => {
  const db = createDb();
  const { token, record } = await createAccessToken(db, { label: "Synthetic", permissions: ["ae"] }, {
    now: () => 1000,
    randomToken: () => "amrs_synthetic_active_token",
    randomId: () => "token-active",
  });
  const found = await findActiveAccessToken(db, token, { now: () => 2000 });
  assert.equal(found.id, record.id);
  assert.equal(db.rows.get(record.id).last_used_at, 2000);
  await updateAccessToken(db, record.id, { status: "suspended", permissions: ["ae"] }, { now: () => 3000 });
  assert.equal(await findActiveAccessToken(db, token, { now: () => 4000 }), null);
});

test("updates metadata and permissions without allowing an empty administrator", async () => {
  const db = createDb();
  const { record } = await createAccessToken(db, { label: "Owner", permissions: ["admin", "cvcs"] }, {
    randomToken: () => "amrs_synthetic_admin_token",
    randomId: () => "token-admin",
  });
  await assert.rejects(updateAccessToken(db, record.id, { permissions: [] }), /administrator/i);
  const updated = await updateAccessToken(db, record.id, { label: "Owner 2", note: "Updated", permissions: ["admin", "schedule"] });
  assert.equal(updated.label, "Owner 2");
  assert.deepEqual(updated.permissions, ["schedule", "admin"]);
});

test("permanently deletes a token", async () => {
  const db = createDb();
  const { record } = await createAccessToken(db, { label: "Departed", permissions: ["ae"] }, {
    randomToken: () => "amrs_synthetic_departed_token",
    randomId: () => "token-departed",
  });
  assert.equal(await deleteAccessToken(db, record.id), true);
  assert.equal(db.rows.size, 0);
});

test("admin actions create, list, suspend, and delete tokens without returning stored plaintext", async () => {
  const db = createDb();
  const created = await handleAccessTokenAdminAction(db, {
    action: "createAccessToken",
    label: "New Starter",
    permissions: ["schedule", "ae"],
  }, { randomToken: () => "amrs_synthetic_managed_token", randomId: () => "token-managed", now: () => 1000 });
  assert.equal(created.token, "amrs_synthetic_managed_token");
  const listed = await handleAccessTokenAdminAction(db, { action: "listAccessTokens" });
  assert.equal(listed.tokens[0].token, undefined);
  await handleAccessTokenAdminAction(db, { action: "updateAccessToken", id: "token-managed", status: "suspended", permissions: ["schedule", "ae"] });
  assert.equal(db.rows.get("token-managed").status, "suspended");
  await handleAccessTokenAdminAction(db, { action: "deleteAccessToken", id: "token-managed" });
  assert.equal(db.rows.size, 0);
});

test("legacy bootstrap creates exactly one administrator token", async () => {
  const db = createDb();
  const created = await bootstrapAdministratorToken(db, { label: "System Owner" }, {
    randomToken: () => "amrs_synthetic_bootstrap_token",
    randomId: () => "bootstrap-admin",
  });
  assert.deepEqual(created.record.permissions, ["schedule", "ae", "cvcs", "admin"]);
  await assert.rejects(bootstrapAdministratorToken(db, { label: "Another Owner" }), /already/i);
});
