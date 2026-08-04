(function attachAmrsCloudApi(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    root.AmrsCloudApi = api.AmrsCloudApi;
    root.createDualTransport = api.createDualTransport;
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function createModule(root) {
  "use strict";

  // This is intentionally a non-production placeholder. The deployed Worker URL is configurable.
  const DEFAULT_CLOUDFLARE_BASE_URL = "https://amrs-api.example.invalid";
  const DEFAULT_DEPLOY_ID_KEYS = ["_ml_gas", "gasDeployId", "deployId"];
  const DEFAULT_SESSION_STORAGE_KEY = "_amrs_cloud_session_v1";
  const DEFAULT_TIMEOUT_MS = 45000;
  const DEFAULT_SESSION_TIMEOUT_MS = 15000;
  const DEFAULT_PREFLIGHT_TIMEOUT_MS = 8000;
  const DEFAULT_POLL_TIMEOUT_MS = 12000;
  const DEFAULT_POLL_ATTEMPTS = 5;
  const DEFAULT_AVAILABILITY_TTL_MS = 30000;
  const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

  const PENDING_STATES = new Set([
    "accepted",
    "queued",
    "pending",
    "processing",
    "running",
    "started",
    "in_progress",
    "in-progress",
  ]);

  function asString(value) {
    return value == null ? "" : String(value);
  }

  function sleep(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(delayMs) || 0)));
  }

  function isTransientStatus(status) {
    const value = Number(status);
    return value === 408 || value === 429 || value >= 500;
  }

  function isAbortError(error) {
    return error?.name === "AbortError" || error?.code === 20;
  }

  function readStorage(storage, key) {
    try {
      return storage && typeof storage.getItem === "function" ? storage.getItem(key) : null;
    } catch {
      return null;
    }
  }

  function writeStorage(storage, key, value) {
    try {
      if (storage && typeof storage.setItem === "function") storage.setItem(key, value);
    } catch {
      // Private browsing and blocked storage should not disable the transport.
    }
  }

  function removeStorage(storage, key) {
    try {
      if (storage && typeof storage.removeItem === "function") storage.removeItem(key);
    } catch {
      // See writeStorage.
    }
  }

  function decodeBase64Url(value) {
    const source = asString(value).replace(/-/g, "+").replace(/_/g, "/");
    const padded = source + "=".repeat((4 - (source.length % 4)) % 4);
    try {
      if (typeof atob === "function") return atob(padded);
      if (typeof Buffer !== "undefined") return Buffer.from(padded, "base64").toString("utf8");
    } catch {
      return "";
    }
    return "";
  }

  function tokenExpiry(token, fallbackExpiresAt, now) {
    const parts = asString(token).split(".");
    for (const index of [0, 1]) {
      if (!parts[index]) continue;
      try {
        const payload = JSON.parse(decodeBase64Url(parts[index]));
        if (Number.isFinite(Number(payload.exp))) return Number(payload.exp) * 1000;
      } catch {
        // Continue to the next segment for JWT-shaped tokens.
      }
    }
    return Number.isFinite(Number(fallbackExpiresAt))
      ? Number(fallbackExpiresAt)
      : now + DEFAULT_SESSION_TTL_MS;
  }

  function stableSerialize(value, seen = new Set()) {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
    if (typeof value === "boolean" || typeof value === "bigint") return String(value);
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value !== "object") return JSON.stringify(String(value));
    if (seen.has(value)) throw new TypeError("Circular mutation payload");
    seen.add(value);
    let result;
    if (Array.isArray(value)) {
      result = `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
    } else if (value instanceof Date) {
      result = JSON.stringify(value.toISOString());
    } else {
      result = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`).join(",")}}`;
    }
    seen.delete(value);
    return result;
  }

  function stableHash(value) {
    const input = String(value);
    let first = 2166136261;
    let second = 2246822519;
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      first ^= code;
      first = Math.imul(first, 16777619);
      second ^= code + index;
      second = Math.imul(second, 3266489917);
    }
    return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
  }

  function normalizeBaseUrl(value, fallback = DEFAULT_CLOUDFLARE_BASE_URL) {
    const raw = value === false || value == null || value === "" ? fallback : value;
    if (raw === false || raw == null || raw === "") return "";
    const url = new URL(String(raw));
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }

  function extractDeployId(value) {
    const raw = asString(value).trim().replace(/^['"]|['"]$/g, "");
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) {
      try {
        const url = new URL(raw);
        const match = url.pathname.match(/^\/macros\/s\/([^/]+)(?:\/(?:exec|dev))?\/?$/i);
        return url.hostname.toLowerCase() === "script.google.com" && match ? match[1] : "";
      } catch {
        return "";
      }
    }
    return raw.replace(/\/(?:exec|dev)\/?$/i, "").trim();
  }

  function deployIdToGasUrl(value) {
    const id = extractDeployId(value);
    return id ? `https://script.google.com/macros/s/${encodeURIComponent(id)}/exec` : "";
  }

  function normalizeQuery(query) {
    if (query == null || query === "") return "";
    if (typeof query === "string") {
      const value = query.trim();
      if (value.startsWith("/api")) {
        const index = value.indexOf("?");
        return index < 0 ? "" : value.slice(index + 1);
      }
      return value.replace(/^\?/, "");
    }
    if (query instanceof URLSearchParams) return query.toString();
    if (query instanceof URL) return query.search.replace(/^\?/, "");
    if (typeof query === "object") {
      const params = new URLSearchParams();
      for (const [key, rawValue] of Object.entries(query)) {
        if (rawValue == null) continue;
        const values = Array.isArray(rawValue) ? rawValue : [rawValue];
        values.forEach((value) => params.append(key, String(value)));
      }
      return params.toString();
    }
    return String(query);
  }

  function apiUrl(baseUrl, path, query) {
    const url = new URL(path, `${baseUrl}/`);
    const search = normalizeQuery(query);
    if (search) url.search = search;
    return url.toString();
  }

  function gasUrlWithQuery(baseUrl, query) {
    const url = new URL(baseUrl);
    const search = normalizeQuery(query);
    if (search) {
      const existing = url.search.replace(/^\?/, "");
      url.search = existing ? `${existing}&${search}` : search;
    }
    return url.toString();
  }

  function makeId(prefix, factory) {
    if (typeof factory === "function") return asString(factory(prefix));
    if (root?.crypto?.randomUUID) return `${prefix}-${root.crypto.randomUUID()}`;
    if (typeof crypto !== "undefined" && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function responseIsOk(response) {
    if (typeof response?.ok === "boolean") return response.ok;
    const status = Number(response?.status || 0);
    return status >= 200 && status < 300;
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

  class AmrsTransportError extends Error {
    constructor(message, metadata = {}) {
      super(message);
      this.name = "AmrsTransportError";
      this.backend = metadata.backend || "unknown";
      this.httpStatus = Number(metadata.httpStatus || metadata.status || 0) || 0;
      this.status = this.httpStatus;
      this.unknownOutcome = Boolean(metadata.unknownOutcome);
      this.retryable = Boolean(metadata.retryable);
      this.kind = metadata.kind || "request";
      this.phase = metadata.phase || "api";
      this.operationId = metadata.operationId || "";
      this.batchId = metadata.batchId || "";
      this.apiAttempted = Boolean(metadata.apiAttempted);
      this.details = metadata.details ?? null;
      this.cause = metadata.cause;
    }

    toJSON() {
      return {
        name: this.name,
        message: this.message,
        backend: this.backend,
        httpStatus: this.httpStatus,
        unknownOutcome: this.unknownOutcome,
        retryable: this.retryable,
        kind: this.kind,
        phase: this.phase,
        operationId: this.operationId,
        batchId: this.batchId,
        apiAttempted: this.apiAttempted,
      };
    }
  }

  function asTransportError(error, metadata = {}) {
    if (error instanceof AmrsTransportError) {
      Object.assign(error, metadata);
      error.status = error.httpStatus;
      return error;
    }
    return new AmrsTransportError(error?.message || "Request failed", {
      ...metadata,
      cause: error,
    });
  }

  function isPendingOutcome(data) {
    if (!data || typeof data !== "object") return false;
    if (data.pending === true || data.complete === false || data.resolved === false) return true;
    const state = asString(data.status || data.state).trim().toLowerCase();
    return PENDING_STATES.has(state);
  }

  function isSubmissionPayload(payload) {
    if (Array.isArray(payload)) return true;
    const action = asString(payload?.action).trim().toLowerCase();
    return action === "submitrecords" || action === "submit_records";
  }

  function clonePayload(payload) {
    if (Array.isArray(payload)) return payload.slice();
    if (payload && typeof payload === "object") return { ...payload };
    return payload;
  }

  class DualTransport {
    constructor(options = {}) {
      const configuredBase = typeof options.cloudflareBaseUrl === "function"
        ? options.cloudflareBaseUrl()
        : options.cloudflareBaseUrl;
      const globalBase = root?.AMRS_CLOUDFLARE_BASE_URL;
      this.cloudflareBaseUrl = normalizeBaseUrl(configuredBase ?? globalBase ?? DEFAULT_CLOUDFLARE_BASE_URL);
      this.fetchImpl = options.fetchImpl || root?.fetch || (typeof fetch === "function" ? fetch : null);
      this.storage = options.storage ?? (() => {
        try { return root?.localStorage || null; } catch { return null; }
      })();
      this.deployId = options.deployId;
      this.getDeployId = options.getDeployId;
      this.gasUrl = options.gasUrl;
      this.getGasUrl = options.getGasUrl;
      this.deployIdKeys = Array.isArray(options.deployIdKeys) && options.deployIdKeys.length
        ? options.deployIdKeys.slice()
        : DEFAULT_DEPLOY_ID_KEYS.slice();
      this.sessionStorageKey = options.sessionStorageKey || DEFAULT_SESSION_STORAGE_KEY;
      this.now = options.now || (() => Date.now());
      this.sleep = options.sleep || sleep;
      this.idFactory = options.idFactory;
      this.defaultTimeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
      this.sessionTimeoutMs = Number(options.sessionTimeoutMs || DEFAULT_SESSION_TIMEOUT_MS);
      this.preflightTimeoutMs = Number(options.preflightTimeoutMs || DEFAULT_PREFLIGHT_TIMEOUT_MS);
      this.pollTimeoutMs = Number(options.pollTimeoutMs || DEFAULT_POLL_TIMEOUT_MS);
      this.pollAttempts = Math.max(1, Number(options.pollAttempts || DEFAULT_POLL_ATTEMPTS));
      this.pollDelayMs = Math.max(0, Number(options.pollDelayMs ?? 500));
      this.availabilityTtlMs = Math.max(0, Number(options.availabilityTtlMs ?? DEFAULT_AVAILABILITY_TTL_MS));
      this.sessionTtlMs = Math.max(60000, Number(options.sessionTtlMs || DEFAULT_SESSION_TTL_MS));
      this._session = null;
      this._sessionPromise = null;
      this._cloudAvailability = { state: "unknown", checkedAt: 0 };
      this.lastBackend = "";
    }

    _newId(prefix) {
      return makeId(prefix, this.idFactory);
    }

    _readStoredDeployId() {
      if (typeof this.getDeployId === "function") {
        try {
          const value = this.getDeployId();
          if (value) return extractDeployId(value);
        } catch {
          // Fall back to the normal local-storage lookup.
        }
      }
      if (this.deployId) return extractDeployId(this.deployId);
      for (const key of this.deployIdKeys) {
        const value = readStorage(this.storage, key);
        if (value) return extractDeployId(value);
      }
      return "";
    }

    _resolveGasUrl() {
      const value = typeof this.getGasUrl === "function" ? this.getGasUrl() : this.gasUrl;
      if (value) return deployIdToGasUrl(value).startsWith("https://script.google.com/") && !/^https?:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(String(value))
        ? deployIdToGasUrl(value)
        : String(value);
      return deployIdToGasUrl(this._readStoredDeployId());
    }

    _readStoredSession() {
      if (this._session && this._session.expiresAt > this.now() + 30000) return this._session;
      if (this._session) this._session = null;
      const raw = readStorage(this.storage, this.sessionStorageKey);
      if (!raw) return null;
      try {
        const value = JSON.parse(raw);
        if (value?.token && Number(value.expiresAt) > this.now() + 30000) {
          this._session = { token: String(value.token), expiresAt: Number(value.expiresAt) };
          return this._session;
        }
      } catch {
        // Ignore corrupted local cache and negotiate a fresh session.
      }
      removeStorage(this.storage, this.sessionStorageKey);
      return null;
    }

    _saveSession(token, responseBody) {
      const now = this.now();
      const expiresIn = Number(responseBody?.expiresIn ?? responseBody?.expires_in);
      const explicitExpiresAt = Number(responseBody?.expiresAt ?? responseBody?.expires_at);
      const responseExpiresAt = Number.isFinite(explicitExpiresAt) && explicitExpiresAt > 10000000000
        ? explicitExpiresAt
        : Number.isFinite(explicitExpiresAt) && explicitExpiresAt > 0
          ? explicitExpiresAt * 1000
          : Number.isFinite(expiresIn) && expiresIn > 0
            ? now + expiresIn * 1000
            : now + this.sessionTtlMs;
      const session = {
        token: String(token),
        expiresAt: tokenExpiry(token, responseExpiresAt, now),
      };
      this._session = session;
      writeStorage(this.storage, this.sessionStorageKey, JSON.stringify(session));
      return session;
    }

    clearSession() {
      this._session = null;
      removeStorage(this.storage, this.sessionStorageKey);
    }

    getState() {
      return {
        backend: this.lastBackend,
        cloudflare: { ...this._cloudAvailability },
        hasSession: Boolean(this._readStoredSession()),
        hasGasFallback: Boolean(this._resolveGasUrl()),
      };
    }

    async _requestRaw(url, init = {}, options = {}) {
      if (typeof this.fetchImpl !== "function") {
        throw new AmrsTransportError("Fetch is not available", {
          backend: options.backend,
          kind: "configuration",
          phase: options.phase,
          retryable: false,
        });
      }
      const method = String(init.method || "GET").toUpperCase();
      const mutation = Boolean(options.mutation);
      const externalSignal = init.signal;
      if (externalSignal?.aborted) {
        throw new AmrsTransportError("Request was cancelled", {
          backend: options.backend,
          kind: "abort",
          phase: options.phase,
          retryable: false,
        });
      }
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      let timedOut = false;
      let externallyAborted = false;
      let started = false;
      const forwardAbort = () => {
        externallyAborted = true;
        controller?.abort();
      };
      if (externalSignal && controller) externalSignal.addEventListener("abort", forwardAbort, { once: true });
      const timeoutMs = Number(options.timeoutMs || this.defaultTimeoutMs);
      const timer = controller && timeoutMs > 0
        ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs)
        : null;
      const requestInit = { ...init };
      if (controller) requestInit.signal = controller.signal;
      try {
        started = true;
        const response = await this.fetchImpl(url, requestInit);
        const status = Number(response?.status || 0);
        const body = await readResponseBody(response);
        if (!responseIsOk(response)) {
          const message = body?.message || `Backend request failed (${status || "unknown"})`;
          throw new AmrsTransportError(String(message), {
            backend: options.backend,
            httpStatus: status,
            kind: "http",
            phase: options.phase,
            details: body,
            unknownOutcome: mutation && started && (status === 0 || isTransientStatus(status)),
            retryable: isTransientStatus(status),
          });
        }
        this.lastBackend = options.backend || this.lastBackend;
        return body == null ? { success: true } : body;
      } catch (error) {
        if (error instanceof AmrsTransportError) throw error;
        const externallyCancelled = externallyAborted || isAbortError(error) && !timedOut;
        const kind = timedOut ? "timeout" : externallyCancelled ? "abort" : "network";
        throw new AmrsTransportError(
          timedOut ? "Backend request timed out" : externallyCancelled ? "Request was cancelled" : "Backend network request failed",
          {
            backend: options.backend,
            kind,
            phase: options.phase,
            cause: error,
            unknownOutcome: mutation && started,
            retryable: !externallyCancelled,
          },
        );
      } finally {
        if (timer) clearTimeout(timer);
        if (externalSignal && controller) externalSignal.removeEventListener("abort", forwardAbort);
      }
    }

    async ensureSession({ forceRefresh = false, signal } = {}) {
      if (!forceRefresh) {
        const cached = this._readStoredSession();
        if (cached) return cached.token;
      }
      if (this._sessionPromise) return this._sessionPromise;
      if (!this.cloudflareBaseUrl) {
        throw new AmrsTransportError("Cloudflare endpoint is not configured", {
          backend: "cloudflare",
          kind: "session-unavailable",
          phase: "session",
          retryable: false,
        });
      }
      const deployId = this._readStoredDeployId();
      if (!deployId) {
        throw new AmrsTransportError("GAS Deploy ID is not configured", {
          backend: "cloudflare",
          kind: "session-unavailable",
          phase: "session",
          retryable: false,
        });
      }
      this._sessionPromise = (async () => {
        try {
          const body = await this._requestRaw(
            apiUrl(this.cloudflareBaseUrl, "/session"),
            {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({ deployId }),
              signal,
            },
            { backend: "cloudflare", phase: "session", timeoutMs: this.sessionTimeoutMs },
          );
          const token = asString(body?.token).trim();
          if (!token) {
            throw new AmrsTransportError("Cloudflare session response did not include a token", {
              backend: "cloudflare",
              kind: "session-unavailable",
              phase: "session",
              details: body,
              retryable: false,
            });
          }
          return this._saveSession(token, body).token;
        } catch (error) {
          const wrapped = asTransportError(error, {
            backend: "cloudflare",
            phase: "session",
            kind: error?.kind === "http" && [401, 403].includes(error.httpStatus)
              ? "session-unavailable"
              : error?.kind,
            retryable: error?.retryable,
            unknownOutcome: false,
          });
          if (wrapped.kind !== "session-unavailable") wrapped.kind = "session-unavailable";
          wrapped.unknownOutcome = false;
          throw wrapped;
        } finally {
          this._sessionPromise = null;
        }
      })();
      return this._sessionPromise;
    }

    async checkCloudHealth({ force = false, signal } = {}) {
      const now = this.now();
      if (!force && this._cloudAvailability.checkedAt && now - this._cloudAvailability.checkedAt < this.availabilityTtlMs) {
        return this._cloudAvailability.state === "available";
      }
      if (!this.cloudflareBaseUrl) {
        this._cloudAvailability = { state: "unavailable", checkedAt: now, error: "not-configured" };
        return false;
      }
      try {
        await this._requestRaw(
          apiUrl(this.cloudflareBaseUrl, "/health"),
          { method: "GET", headers: { accept: "application/json" }, signal },
          { backend: "cloudflare", phase: "preflight", timeoutMs: this.preflightTimeoutMs },
        );
        this._cloudAvailability = { state: "available", checkedAt: this.now() };
        return true;
      } catch (error) {
        this._cloudAvailability = {
          state: "unavailable",
          checkedAt: this.now(),
          error: error?.kind || "network",
        };
        return false;
      }
    }

    async _cloudGet(query, options = {}) {
      let token;
      try {
        token = await this.ensureSession({ signal: options.signal });
      } catch (error) {
        throw asTransportError(error, {
          backend: "cloudflare",
          kind: "session-unavailable",
          phase: "session",
          unknownOutcome: false,
        });
      }
      const request = async (bearer) => this._requestRaw(
        apiUrl(this.cloudflareBaseUrl, "/api", query),
        {
          method: "GET",
          headers: { accept: "application/json", authorization: `Bearer ${bearer}` },
          signal: options.signal,
        },
        { backend: "cloudflare", phase: "api", timeoutMs: options.timeoutMs || this.defaultTimeoutMs },
      );
      try {
        return await request(token);
      } catch (error) {
        if (error.httpStatus !== 401 || options._sessionRetried) throw error;
        this.clearSession();
        try {
          const refreshed = await this.ensureSession({ forceRefresh: true, signal: options.signal });
          return await request(refreshed);
        } catch (refreshError) {
          throw asTransportError(refreshError, {
            backend: "cloudflare",
            kind: "session-unavailable",
            phase: "session",
            unknownOutcome: false,
          });
        }
      }
    }

    async _gasGet(query, options = {}) {
      const gasUrl = this._resolveGasUrl();
      if (!gasUrl) {
        throw new AmrsTransportError("GAS Deploy ID is not configured", {
          backend: "gas",
          kind: "configuration",
          phase: "fallback",
          retryable: false,
        });
      }
      return this._requestRaw(
        gasUrlWithQuery(gasUrl, query),
        {
          method: "GET",
          headers: { accept: "application/json" },
          signal: options.signal,
        },
        { backend: "gas", phase: "fallback", timeoutMs: options.timeoutMs || this.defaultTimeoutMs },
      );
    }

    _shouldFallbackGet(error) {
      return error?.kind === "session-unavailable"
        || error?.kind === "network"
        || error?.kind === "timeout"
        || isTransientStatus(error?.httpStatus);
    }

    async get(queryOrOptions = "", maybeOptions = {}) {
      const optionKeys = ["query", "signal", "timeoutMs", "_sessionRetried"];
      const isOptionsObject = queryOrOptions
        && typeof queryOrOptions === "object"
        && !(queryOrOptions instanceof URLSearchParams)
        && !(queryOrOptions instanceof URL)
        && optionKeys.some((key) => Object.prototype.hasOwnProperty.call(queryOrOptions, key));
      const options = isOptionsObject ? { ...queryOrOptions } : { ...maybeOptions, query: queryOrOptions };
      const query = options.query ?? "";
      if (!this.cloudflareBaseUrl) {
        return this._gasGet(query, options);
      }
      try {
        return await this._cloudGet(query, options);
      } catch (cloudError) {
        if (options.signal?.aborted || !this._shouldFallbackGet(cloudError)) throw cloudError;
        try {
          return await this._gasGet(query, options);
        } catch (gasError) {
          gasError.cloudError = cloudError;
          throw gasError;
        }
      }
    }

    _normalizeMutation(payload, options = {}) {
      const submission = isSubmissionPayload(payload);
      const submissionRecords = Array.isArray(payload) ? payload : Array.isArray(payload?.records) ? payload.records : [];
      const submissionKey = submissionRecords.map((record) => asString(record?.submissionId)).filter(Boolean).join("|");
      const batchId = submission
        ? asString(options.batchId || payload?.batchId || (submissionKey ? `batch-${stableHash(submissionKey)}` : this._newId("batch")))
        : "";
      let requestId = asString(options.requestId || payload?.requestId || "");
      if (!requestId && submission) requestId = batchId;
      if (!requestId) {
        let key;
        try {
          key = options.idempotencyKey || stableSerialize({ action: "mutation", payload });
        } catch {
          key = `${options.idempotencyKey || "mutation"}:${String(payload)}`;
        }
        requestId = `request-${stableHash(key)}`;
      }
      let body = clonePayload(payload);
      if (Array.isArray(body)) {
        body = { action: "submitRecords", records: body, batchId, requestId };
      } else if (body && typeof body === "object") {
        body.requestId = requestId;
        if (submission) body.batchId = batchId;
      } else {
        body = { payload: body, requestId };
      }
      return { body, requestId, batchId, submission };
    }

    async _gasPost(normalized, options = {}) {
      const gasUrl = this._resolveGasUrl();
      if (!gasUrl) {
        throw new AmrsTransportError("GAS Deploy ID is not configured", {
          backend: "gas",
          kind: "configuration",
          phase: "fallback",
          operationId: normalized.requestId,
          batchId: normalized.batchId,
          retryable: false,
        });
      }
      const body = JSON.stringify(normalized.body);
      return this._requestRaw(
        gasUrl,
        {
          method: "POST",
          headers: { "content-type": "text/plain", accept: "application/json" },
          body,
          signal: options.signal,
        },
        {
          backend: "gas",
          phase: "fallback",
          timeoutMs: options.timeoutMs || this.defaultTimeoutMs,
          mutation: false,
        },
      );
    }

    async _cloudPost(normalized, options = {}) {
      let token = await this.ensureSession({ signal: options.signal });
      let sessionRetried = false;
      let apiAttempted = false;
      while (true) {
        try {
          apiAttempted = true;
          const response = await this._requestRaw(
            apiUrl(this.cloudflareBaseUrl, "/api"),
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json",
                authorization: `Bearer ${token}`,
              },
              body: JSON.stringify(normalized.body),
              signal: options.signal,
            },
            {
              backend: "cloudflare",
              phase: "api",
              timeoutMs: options.timeoutMs || this.defaultTimeoutMs,
              mutation: true,
            },
          );
          if (isPendingOutcome(response)) {
            return this._reconcile(normalized, new AmrsTransportError("Cloudflare operation is still processing", {
              backend: "cloudflare",
              kind: "pending",
              phase: "api",
              operationId: normalized.requestId,
              batchId: normalized.batchId,
              unknownOutcome: true,
              retryable: true,
              details: response,
            }), options);
          }
          return response;
        } catch (error) {
          // A rejected token is a known pre-mutation failure; retry Worker auth only.
          if (error.httpStatus === 401 && !sessionRetried) {
            sessionRetried = true;
            this.clearSession();
            try {
              token = await this.ensureSession({ forceRefresh: true, signal: options.signal });
            } catch (refreshError) {
              refreshError.apiAttempted = apiAttempted;
              throw refreshError;
            }
            continue;
          }
          error.apiAttempted = apiAttempted;
          if (!error.unknownOutcome) throw error;
          return this._reconcile(normalized, error, options);
        }
      }
    }

    async _reconcile(normalized, originalError, options = {}) {
      const id = normalized.submission ? normalized.batchId : normalized.requestId;
      const path = normalized.submission ? "/submissions/" : "/operations/";
      let lastError = originalError;
      for (let attempt = 0; attempt < this.pollAttempts; attempt += 1) {
        if (options.signal?.aborted) {
          throw new AmrsTransportError("Request was cancelled before outcome was confirmed", {
            backend: "cloudflare",
            kind: "abort",
            phase: "reconcile",
            operationId: normalized.requestId,
            batchId: normalized.batchId,
            unknownOutcome: true,
            retryable: false,
            cause: originalError,
          });
        }
        try {
          const token = await this.ensureSession();
          const body = await this._requestRaw(
            apiUrl(this.cloudflareBaseUrl, `${path}${encodeURIComponent(id)}`),
            {
              method: "GET",
              headers: { accept: "application/json", authorization: `Bearer ${token}` },
              signal: options.signal,
            },
            { backend: "cloudflare", phase: "reconcile", timeoutMs: options.pollTimeoutMs || this.pollTimeoutMs },
          );
          if (isPendingOutcome(body)) {
            lastError = new AmrsTransportError("Cloudflare operation is still processing", {
              backend: "cloudflare",
              kind: "pending",
              phase: "reconcile",
              operationId: normalized.requestId,
              batchId: normalized.batchId,
              unknownOutcome: true,
              retryable: true,
              details: body,
            });
          } else if (body?.success === false) {
            throw new AmrsTransportError(String(body.message || "Cloudflare operation failed"), {
              backend: "cloudflare",
              kind: "operation-failed",
              phase: "reconcile",
              operationId: normalized.requestId,
              batchId: normalized.batchId,
              unknownOutcome: false,
              retryable: Boolean(body.retryable),
              details: body,
            });
          } else {
            return body;
          }
        } catch (error) {
          if (error.httpStatus === 401 && attempt < this.pollAttempts - 1) {
            this.clearSession();
            try {
              await this.ensureSession({ forceRefresh: true, signal: options.signal });
            } catch (refreshError) {
              lastError = refreshError;
            }
          } else if (error?.kind === "operation-failed") {
            throw error;
          } else {
            lastError = error;
          }
        }
        if (attempt < this.pollAttempts - 1) await this.sleep(this.pollDelayMs * (attempt + 1));
      }
      throw new AmrsTransportError("提交結果未能確認，請稍後重新核對", {
        backend: "cloudflare",
        kind: "unknown-outcome",
        phase: "reconcile",
        operationId: normalized.requestId,
        batchId: normalized.batchId,
        unknownOutcome: true,
        retryable: true,
        details: { lastError: lastError?.toJSON ? lastError.toJSON() : lastError?.message },
        cause: lastError,
      });
    }

    async post(payload, options = {}) {
      const normalized = this._normalizeMutation(payload, options);
      const forceGas = options.backend === "gas" || options.forceGas === true;
      let cloudReady = false;
      if (!forceGas) cloudReady = await this.checkCloudHealth({ force: options.forcePreflight === true, signal: options.signal });
      if (!cloudReady || forceGas || !this.cloudflareBaseUrl) {
        return this._gasPost(normalized, options);
      }
      try {
        return await this._cloudPost(normalized, options);
      } catch (error) {
        // Once _cloudPost has started /api, errors are returned as-is. In particular,
        // unknownOutcome must never be sent to GAS as a duplicate mutation.
        if (error?.unknownOutcome || error?.phase === "api" || error?.apiAttempted) throw error;
        // Session negotiation failed before /api started, so GAS is a safe fallback.
        this._cloudAvailability = { state: "unavailable", checkedAt: this.now(), error: error?.kind || "session" };
        return this._gasPost(normalized, options);
      }
    }

    request(method, queryOrPayload, options = {}) {
      const verb = String(method || "GET").toUpperCase();
      return verb === "GET" ? this.get(queryOrPayload, options) : this.post(queryOrPayload, options);
    }
  }

  function createDualTransport(options) {
    return new DualTransport(options);
  }

  class AmrsCloudApi extends DualTransport {
    static createDualTransport(options) {
      return createDualTransport(options);
    }
  }

  return {
    AmrsCloudApi,
    AmrsTransportError,
    DualTransport,
    DEFAULT_CLOUDFLARE_BASE_URL,
    createDualTransport,
    deployIdToGasUrl,
    extractDeployId,
    isTransientStatus,
    normalizeBaseUrl,
  };
}));
