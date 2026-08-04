import { issueSessionToken, sha256Base64Url, verifySessionToken } from "./crypto.mjs";

export async function createSession(request, env) {
  const body = await request.json();
  const deployId = String(body?.deployId || "").trim();
  if (!deployId || !env.AMRS_DEPLOY_ID_HASH || !env.AMRS_TOKEN_SECRET) {
    throw Object.assign(new Error("Invalid connection details"), { status: 401 });
  }
  const digest = await sha256Base64Url(deployId);
  if (digest !== env.AMRS_DEPLOY_ID_HASH) {
    throw Object.assign(new Error("Invalid connection details"), { status: 401 });
  }
  return {
    success: true,
    token: await issueSessionToken(env.AMRS_TOKEN_SECRET, { scope: "amrs" }),
  };
}

export async function requireSession(request, env) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const claims = env.AMRS_TOKEN_SECRET ? await verifySessionToken(env.AMRS_TOKEN_SECRET, token) : null;
  if (!claims || claims.scope !== "amrs") {
    throw Object.assign(new Error("Unauthorized"), { status: 401 });
  }
  return claims;
}

