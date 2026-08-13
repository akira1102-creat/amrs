import assert from "node:assert/strict";
import test from "node:test";

import { createAccessToken, updateAccessToken } from "../src/access-tokens.mjs";
import { createSession, requireSession } from "../src/auth.mjs";
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
              } else if (sql.includes("UPDATE access_tokens") && sql.includes("last_used_at")) {
                const [lastUsedAt, updatedAt, id] = bindings;
                Object.assign(rows.get(id), { last_used_at: lastUsedAt, updated_at: updatedAt });
              } else if (sql.includes("UPDATE access_tokens")) {
                const [label, note, permissionsJson, status, updatedAt, id] = bindings;
                Object.assign(rows.get(id), { label, note, permissions_json: permissionsJson, status, updated_at: updatedAt });
              }
              return { meta: { changes: 1 } };
            },
            async first() {
              if (sql.includes("token_hash")) return [...rows.values()].find((row) => row.token_hash === bindings[0]) || null;
              if (sql.includes("WHERE id")) return rows.get(bindings[0]) || null;
              return null;
            },
          };
        },
      };
    },
  };
}

function authRequest(token) {
  return new Request("https://worker.example/api", { headers: { authorization: `Bearer ${token}` } });
}

test("creates a permission-bearing session from a personal token", async () => {
  const DB = createDb();
  const created = await createAccessToken(DB, { label: "Synthetic", permissions: ["schedule", "cvcs"] }, {
    randomToken: () => "amrs_synthetic_user_token",
    randomId: () => "token-user",
  });
  const env = { DB, AMRS_TOKEN_SECRET: "synthetic-session-secret" };
  const result = await createSession(new Request("https://worker.example/session", {
    method: "POST",
    body: JSON.stringify({ token: created.token }),
  }), env);
  assert.deepEqual(result.permissions, ["schedule", "cvcs"]);
  assert.equal(result.legacy, false);
  const claims = await requireSession(authRequest(result.token), env, "cvcs");
  assert.equal(claims.tokenId, "token-user");
  await assert.rejects(requireSession(authRequest(result.token), env, "ae"), /permission/i);
});

test("keeps Deploy ID as a non-admin universal legacy session", async () => {
  const deployId = "synthetic-legacy-deploy-id";
  const env = {
    DB: createDb(),
    AMRS_DEPLOY_ID_HASH: await sha256Base64Url(deployId),
    AMRS_TOKEN_SECRET: "synthetic-session-secret",
  };
  const result = await createSession(new Request("https://worker.example/session", {
    method: "POST",
    body: JSON.stringify({ deployId }),
  }), env);
  assert.equal(result.legacy, true);
  assert.deepEqual(result.permissions, ["schedule", "ae", "cvcs"]);
  await requireSession(authRequest(result.token), env, "ae");
  await assert.rejects(requireSession(authRequest(result.token), env, "admin"), /permission/i);
});

test("revoking a personal token invalidates an existing session on its next request", async () => {
  const DB = createDb();
  const created = await createAccessToken(DB, { label: "Synthetic", permissions: ["cvcs"] }, {
    randomToken: () => "amrs_synthetic_revoked_token",
    randomId: () => "token-revoked",
  });
  const env = { DB, AMRS_TOKEN_SECRET: "synthetic-session-secret" };
  const session = await createSession(new Request("https://worker.example/session", {
    method: "POST",
    body: JSON.stringify({ token: created.token }),
  }), env);
  await updateAccessToken(DB, created.record.id, { status: "suspended", permissions: ["cvcs"] });
  await assert.rejects(requireSession(authRequest(session.token), env, "cvcs"), /Unauthorized/);
});
