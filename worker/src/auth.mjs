import { issueSessionToken, sha256Base64Url, verifySessionToken } from "./crypto.mjs";
import { findActiveAccessToken, findActiveAccessTokenById } from "./access-tokens.mjs";

const LEGACY_PERMISSIONS = Object.freeze(["schedule", "ae", "cvcs"]);

function denied(message = "Unauthorized", status = 401) {
  return Object.assign(new Error(message), { status });
}

function hasPermission(permissions, requiredPermission) {
  return !requiredPermission || permissions.includes(requiredPermission);
}

export async function createSession(request, env) {
  const body = await request.json();
  const credential = String(body?.token || body?.deployId || "").trim();
  if (!credential || !env.AMRS_TOKEN_SECRET) throw denied("Invalid connection details");

  if (env.DB) {
    const personal = await findActiveAccessToken(env.DB, credential);
    if (personal) {
      return {
        success: true,
        token: await issueSessionToken(env.AMRS_TOKEN_SECRET, {
          scope: "amrs",
          tokenId: personal.id,
          permissions: personal.permissions,
          legacy: false,
        }),
        permissions: personal.permissions,
        legacy: false,
        label: personal.label,
      };
    }
  }

  if (!env.AMRS_DEPLOY_ID_HASH) throw denied("Invalid connection details");
  const digest = await sha256Base64Url(credential);
  if (digest !== env.AMRS_DEPLOY_ID_HASH) throw denied("Invalid connection details");
  return {
    success: true,
    token: await issueSessionToken(env.AMRS_TOKEN_SECRET, { scope: "amrs", permissions: LEGACY_PERMISSIONS, legacy: true }),
    permissions: [...LEGACY_PERMISSIONS],
    legacy: true,
    label: "Legacy Universal Token",
  };
}

export async function requireSession(request, env, requiredPermission = "") {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const claims = env.AMRS_TOKEN_SECRET ? await verifySessionToken(env.AMRS_TOKEN_SECRET, token) : null;
  if (!claims || claims.scope !== "amrs") throw denied();

  let permissions;
  if (claims.tokenId) {
    const personal = env.DB ? await findActiveAccessTokenById(env.DB, claims.tokenId) : null;
    if (!personal) throw denied();
    permissions = personal.permissions;
    claims.permissions = permissions;
    claims.legacy = false;
    claims.label = personal.label;
  } else {
    permissions = Array.isArray(claims.permissions) ? claims.permissions : LEGACY_PERMISSIONS;
    claims.permissions = permissions.filter((permission) => permission !== "admin");
    claims.legacy = true;
  }
  if (!hasPermission(claims.permissions, requiredPermission)) throw denied("Missing permission", 403);
  return claims;
}
