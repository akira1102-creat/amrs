import { signGoogleJwt } from "./crypto.mjs";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 250;

export class GoogleTokenError extends Error {
  constructor(message, { status = 0, details = null, retryable = false } = {}) {
    super(message);
    this.name = "GoogleTokenError";
    this.status = status;
    this.details = details;
    this.retryable = retryable;
  }
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function normalizeAttempts(options) {
  const value = options.maxAttempts ?? (
    options.maxRetries == null ? DEFAULT_MAX_ATTEMPTS : Number(options.maxRetries) + 1
  );
  return Math.max(1, Number.isFinite(Number(value)) ? Math.floor(Number(value)) : DEFAULT_MAX_ATTEMPTS);
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function retryAfterMs(response) {
  const value = response?.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function readResponseBody(response) {
  if (!response) return null;
  if (typeof response.text === "function") {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (typeof response.json === "function") {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  return null;
}

export function normalizeServiceAccountCredentials(credentials) {
  let parsed = credentials;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new GoogleTokenError("Invalid Google service-account JSON", { status: 500 });
    }
  }
  if (parsed && typeof parsed === "object" && !parsed.client_email && !parsed.clientEmail) {
    const nested = parsed.GOOGLE_SERVICE_ACCOUNT_JSON || parsed.GOOGLE_SERVICE_ACCOUNT || parsed.serviceAccount;
    if (nested) return normalizeServiceAccountCredentials(nested);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new GoogleTokenError("Missing Google service-account credentials", { status: 500 });
  }
  const clientEmail = String(parsed.client_email || parsed.clientEmail || "").trim();
  const privateKey = String(parsed.private_key || parsed.privateKey || "").replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) {
    throw new GoogleTokenError("Incomplete Google service-account credentials", { status: 500 });
  }
  return { ...parsed, client_email: clientEmail, private_key: privateKey };
}

function normalizeOptions(options) {
  if (typeof options === "function") return { fetchImpl: options };
  return options && typeof options === "object" ? options : {};
}

export async function getGoogleAccessToken(credentials, rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  const serviceAccount = normalizeServiceAccountCredentials(credentials);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new GoogleTokenError("Fetch is not available", { status: 500 });
  }
  const signJwt = options.signJwt || signGoogleJwt;
  const scope = Array.isArray(options.scope)
    ? options.scope.join(" ")
    : String(options.scope || GOOGLE_SHEETS_SCOPE).trim();
  const assertion = await signJwt(serviceAccount, scope);
  const body = new URLSearchParams({
    grant_type: JWT_BEARER_GRANT,
    assertion,
  });
  const tokenUrl = options.tokenUrl || GOOGLE_TOKEN_URL;
  const maxAttempts = normalizeAttempts(options);
  const sleep = options.sleep || defaultSleep;
  const retryBaseMs = Math.max(0, Number(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const details = await readResponseBody(response);
    const status = Number(response?.status || 0);
    const ok = response?.ok ?? (status >= 200 && status < 300);
    if (ok) {
      const accessToken = String(details?.access_token || "").trim();
      if (!accessToken) {
        throw new GoogleTokenError("Google token response did not include an access token", {
          status: 502,
          details,
        });
      }
      return accessToken;
    }

    const retryable = isRetryableStatus(status);
    const error = new GoogleTokenError(`Google token request failed (${status || "unknown"})`, {
      status,
      details,
      retryable,
    });
    if (!retryable || attempt >= maxAttempts - 1) throw error;
    const retryDelay = retryAfterMs(response);
    await sleep(retryDelay == null ? retryBaseMs * (2 ** attempt) : retryDelay);
  }

  throw new GoogleTokenError("Google token request failed", { status: 503, retryable: true });
}

export function createGoogleAccessTokenProvider(credentials, rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  let cached = null;
  let pending = null;
  return async ({ forceRefresh = false } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    if (!forceRefresh && cached && cached.expiresAt > now + 60) return cached.accessToken;
    if (!pending) {
      pending = getGoogleAccessToken(credentials, options).then((accessToken) => {
        const expiresIn = Math.max(60, Number(options.expiresIn || 3600));
        cached = { accessToken, expiresAt: now + expiresIn };
        return accessToken;
      }).finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}

export const getGoogleServiceAccountToken = getGoogleAccessToken;
export const getServiceAccountAccessToken = getGoogleAccessToken;
export const getGoogleToken = getGoogleAccessToken;
