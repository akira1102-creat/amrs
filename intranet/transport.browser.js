(function installIntranetTransport(root, factory) {
  const api = factory(root);
  root.createDualTransport = api.createDualTransport;
  root.AmrsTransportError = api.AmrsTransportError;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createTransportModule(root) {
  const SESSION_KEY = '_amrs_intranet_session_v1';
  const TOKEN_KEYS = ['_amrs_access_token_v1', 'amrsAccessToken'];
  const TRANSIENT_STATUSES = new Set([408, 429]);
  const PENDING_STATES = new Set(['pending', 'processing', 'queued', 'running', 'in_progress']);
  const SUBMISSION_ACTIONS = new Set(['submitrecords', 'submit_cvcs_records', 'submitcvcsrecords', 'submit_cvcs_broken_parts', 'submitcvcsbrokenparts']);

  function asString(value) { return String(value == null ? '' : value); }
  function isTransient(status) { return TRANSIENT_STATUSES.has(Number(status)) || Number(status) >= 500; }
  function isAbortError(error) { return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'; }

  function stableSerialize(value, seen = new Set()) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : String(value);
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'boolean') return String(value);
    if (typeof value !== 'object') return JSON.stringify(String(value));
    if (seen.has(value)) throw new TypeError('Cyclic payload');
    seen.add(value);
    let result;
    if (Array.isArray(value)) result = `[${value.map(item => stableSerialize(item, seen)).join(',')}]`;
    else result = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`).join(',')}}`;
    seen.delete(value);
    return result;
  }

  function stableHash(value) {
    let first = 2166136261;
    let second = 2246822519;
    for (const character of String(value)) {
      first = Math.imul(first ^ character.charCodeAt(0), 16777619);
      second = Math.imul(second ^ character.charCodeAt(0), 3266489917);
    }
    return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
  }

  function makeId(prefix) {
    const uuid = root.crypto?.randomUUID?.();
    return `${prefix}-${uuid || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
  }

  function expiryFromToken(token) {
    try {
      const encoded = String(token).split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      const decoded = root.atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='));
      const payload = JSON.parse(decodeURIComponent(Array.from(decoded, char => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')));
      return Number(payload.exp) * 1000;
    } catch { return 0; }
  }

  function responseIsPending(body) {
    if (!body || typeof body !== 'object') return false;
    if (body.pending === true || body.complete === false || body.resolved === false) return true;
    return PENDING_STATES.has(asString(body.status || body.state || body.operation?.status || body.batch?.status).trim().toLowerCase());
  }

  function isSubmission(payload) {
    if (Array.isArray(payload)) return true;
    return SUBMISSION_ACTIONS.has(asString(payload?.action).trim().toLowerCase());
  }

  function normalizeQuery(query) {
    if (query == null || query === '') return '';
    if (typeof query === 'string') return query.trim().replace(/^\?/, '');
    if (query instanceof URLSearchParams) return query.toString();
    if (query instanceof URL) return query.search.replace(/^\?/, '');
    if (typeof query === 'object') {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value == null) continue;
        for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
      }
      return params.toString();
    }
    return String(query);
  }

  async function readResponseBody(response) {
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return { message: text }; }
  }

  class AmrsTransportError extends Error {
    constructor(message, details = {}) {
      super(message);
      this.name = 'AmrsTransportError';
      Object.assign(this, details);
    }
  }

  class IntranetTransport {
    constructor(options = {}) {
      const pageOrigin = root.location?.origin;
      const configuredOrigin = pageOrigin || options.baseUrl;
      if (!configuredOrigin) throw new AmrsTransportError('內網主機位置無效', { kind: 'configuration' });
      const origin = new URL(configuredOrigin).origin;
      if (pageOrigin && origin !== new URL(pageOrigin).origin) throw new AmrsTransportError('只允許連接目前的內網主機', { kind: 'configuration' });
      this.origin = origin;
      this.fetchImpl = options.fetchImpl || root.fetch;
      this.storage = options.storage ?? (() => { try { return root.localStorage || null; } catch { return null; } })();
      this.accessToken = options.accessToken;
      this.getAccessToken = options.getAccessToken;
      this.sessionStorageKey = options.sessionStorageKey || SESSION_KEY;
      this.timeoutMs = Math.max(1000, Number(options.timeoutMs || 45000));
      this.sessionTimeoutMs = Math.max(1000, Number(options.sessionTimeoutMs || 15000));
      this.pollAttempts = Math.max(1, Number(options.pollAttempts || 6));
      this.pollDelayMs = Math.max(0, Number(options.pollDelayMs ?? 300));
      this.sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
      this._session = null;
      this._sessionPromise = null;
      this.lastBackend = '';
    }

    _readStorage(key) {
      try { return this.storage?.getItem?.(key) || ''; } catch { return ''; }
    }

    _writeStorage(key, value) {
      try { this.storage?.setItem?.(key, value); } catch { /* Storage is optional. */ }
    }

    _removeStorage(key) {
      try { this.storage?.removeItem?.(key); } catch { /* Storage is optional. */ }
    }

    _readAccessToken() {
      let value = '';
      try { value = asString(typeof this.getAccessToken === 'function' ? this.getAccessToken() : '').trim(); } catch { /* use stored token */ }
      if (!value) value = asString(this.accessToken).trim();
      if (!value) for (const key of TOKEN_KEYS) { value = this._readStorage(key).trim(); if (value) break; }
      return /^amrs_[A-Za-z0-9_-]{20,}$/.test(value) ? value : '';
    }

    _readStoredSession() {
      const credential = this._readAccessToken();
      if (this._session && this._session.expiresAt > Date.now() + 30000 && this._session.credentialHash === stableHash(credential)) return this._session;
      this._session = null;
      const raw = this._readStorage(this.sessionStorageKey);
      if (!raw || !credential) return null;
      try {
        const value = JSON.parse(raw);
        if (value?.token && Number(value.expiresAt) > Date.now() + 30000 && value.credentialHash === stableHash(credential)) {
          this._session = value;
          return value;
        }
      } catch { /* Remove an invalid local session below. */ }
      this._removeStorage(this.sessionStorageKey);
      return null;
    }

    _saveSession(token, response, credential) {
      const explicit = Number(response?.expiresAt ?? response?.expires_at);
      const expiry = explicit > 10000000000 ? explicit : explicit > 0 ? explicit * 1000 : expiryFromToken(token);
      const session = {
        token: String(token),
        expiresAt: expiry > Date.now() ? expiry : Date.now() + Math.max(60000, Number(response?.expiresIn || 900) * 1000),
        permissions: Array.isArray(response?.permissions) ? response.permissions.map(String) : [],
        label: asString(response?.label),
        credentialHash: stableHash(credential),
      };
      this._session = session;
      this._writeStorage(this.sessionStorageKey, JSON.stringify(session));
      return session;
    }

    clearSession() {
      this._session = null;
      this._removeStorage(this.sessionStorageKey);
    }

    getState() {
      const session = this._readStoredSession();
      return { backend: this.lastBackend, hasSession: Boolean(session), permissions: session?.permissions?.slice() || [], label: session?.label || '', legacy: false, hasGasFallback: false };
    }

    _url(path, query = '') {
      const url = new URL(path, `${this.origin}/`);
      if (url.origin !== this.origin) throw new AmrsTransportError('只允許連接目前的內網主機', { kind: 'configuration' });
      if (query) url.search = normalizeQuery(query);
      return url;
    }

    async _requestRaw(path, init = {}, options = {}) {
      if (typeof this.fetchImpl !== 'function') throw new AmrsTransportError('無法連接內網主機；請檢查區域網絡。', { kind: 'configuration', phase: options.phase });
      const url = this._url(path, options.query);
      const externalSignal = init.signal;
      if (externalSignal?.aborted) throw new AmrsTransportError('Request was cancelled', { kind: 'abort', phase: options.phase });
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timedOut = false;
      const timer = controller ? setTimeout(() => { timedOut = true; controller.abort(); }, Number(options.timeoutMs || this.timeoutMs)) : null;
      const forwardAbort = () => controller?.abort();
      if (externalSignal && controller) externalSignal.addEventListener('abort', forwardAbort, { once: true });
      try {
        const response = await this.fetchImpl(url.toString(), { ...init, credentials: 'same-origin', redirect: 'error', ...(controller ? { signal: controller.signal } : {}) });
        const body = await readResponseBody(response);
        if (!response.ok) {
          throw new AmrsTransportError(body?.message || `內網主機回應錯誤 (${response.status})`, {
            httpStatus: response.status,
            kind: 'http',
            phase: options.phase,
            details: body,
            unknownOutcome: Boolean(options.mutation && isTransient(response.status)),
            retryable: isTransient(response.status),
          });
        }
        this.lastBackend = 'intranet';
        return body == null ? { success: true } : body;
      } catch (error) {
        if (error instanceof AmrsTransportError) throw error;
        const aborted = isAbortError(error) && !timedOut;
        throw new AmrsTransportError(
          timedOut ? '內網主機回應逾時' : aborted ? 'Request was cancelled' : '無法連接內網主機；請檢查區域網絡。',
          { kind: timedOut ? 'timeout' : aborted ? 'abort' : 'network', phase: options.phase, unknownOutcome: Boolean(options.mutation && !aborted), retryable: !aborted, cause: error },
        );
      } finally {
        if (timer) clearTimeout(timer);
        if (externalSignal && controller) externalSignal.removeEventListener('abort', forwardAbort);
      }
    }

    async ensureSession({ forceRefresh = false, signal } = {}) {
      if (!forceRefresh) {
        const cached = this._readStoredSession();
        if (cached) return cached.token;
      }
      if (this._sessionPromise) return this._sessionPromise;
      const credential = this._readAccessToken();
      if (!credential) throw new AmrsTransportError('請輸入有效的內網 Token', { kind: 'session-unavailable', phase: 'session' });
      this._sessionPromise = (async () => {
        try {
          const response = await this._requestRaw('/session', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ token: credential }),
            signal,
          }, { phase: 'session', timeoutMs: this.sessionTimeoutMs });
          if (!response?.token) throw new AmrsTransportError('內網主機沒有提供有效登入狀態', { kind: 'session-unavailable', phase: 'session', details: response });
          return this._saveSession(response.token, response, credential).token;
        } catch (error) {
          error.kind = 'session-unavailable';
          error.unknownOutcome = false;
          throw error;
        } finally { this._sessionPromise = null; }
      })();
      return this._sessionPromise;
    }

    async checkCloudHealth({ signal } = {}) {
      await this._requestRaw('/health', { method: 'GET', headers: { accept: 'application/json' }, signal }, { phase: 'preflight', timeoutMs: this.sessionTimeoutMs });
      return true;
    }

    async _authorizedRequest(path, init, options = {}) {
      let token = await this.ensureSession({ signal: options.signal });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await this._requestRaw(path, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` }, signal: options.signal }, options);
        } catch (error) {
          if (error.httpStatus !== 401 || attempt > 0) throw error;
          this.clearSession();
          token = await this.ensureSession({ forceRefresh: true, signal: options.signal });
        }
      }
      throw new AmrsTransportError('無法連接內網主機；請檢查區域網絡。', { kind: 'network' });
    }

    async get(queryOrOptions = '', maybeOptions = {}) {
      const optionKeys = ['query', 'signal', 'timeoutMs'];
      const isOptions = queryOrOptions && typeof queryOrOptions === 'object'
        && !(queryOrOptions instanceof URLSearchParams) && !(queryOrOptions instanceof URL)
        && optionKeys.some(key => Object.prototype.hasOwnProperty.call(queryOrOptions, key));
      const options = isOptions ? { ...queryOrOptions } : { ...maybeOptions, query: queryOrOptions };
      const url = this._url('/api', options.query ?? '');
      return this._authorizedRequest(`${url.pathname}${url.search}`, { method: 'GET', headers: { accept: 'application/json' } }, { phase: 'api', timeoutMs: options.timeoutMs, signal: options.signal });
    }

    _normalizeMutation(payload, options = {}) {
      const submission = isSubmission(payload);
      const records = Array.isArray(payload) ? payload : Array.isArray(payload?.records) ? payload.records : [];
      const submissionKey = records.map(record => asString(record?.submissionId)).filter(Boolean).join('|');
      const stablePayload = stableSerialize(payload);
      const batchId = submission ? asString(options.batchId || payload?.batchId || `batch-${stableHash(submissionKey || stablePayload)}`) : '';
      const requestId = asString(options.requestId || payload?.requestId || (submission ? batchId : `request-${stableHash(options.idempotencyKey || stablePayload)}`));
      let body = Array.isArray(payload) ? { action: 'submitRecords', records: payload.slice(), batchId, requestId }
        : payload && typeof payload === 'object' ? { ...payload, requestId, ...(submission ? { batchId } : {}) }
          : { payload, requestId };
      return { body, requestId, batchId, submission };
    }

    async _reconcile(normalized, originalError, options = {}) {
      const id = normalized.submission ? normalized.batchId : normalized.requestId;
      const path = `${normalized.submission ? '/submissions/' : '/operations/'}${encodeURIComponent(id)}`;
      let lastError = originalError;
      for (let attempt = 0; attempt < this.pollAttempts; attempt += 1) {
        if (options.signal?.aborted) throw new AmrsTransportError('Request was cancelled before outcome was confirmed', { kind: 'abort', phase: 'reconcile', unknownOutcome: true, requestId: normalized.requestId, batchId: normalized.batchId });
        try {
          const body = await this._authorizedRequest(path, { method: 'GET', headers: { accept: 'application/json' } }, { phase: 'reconcile', timeoutMs: options.pollTimeoutMs || this.timeoutMs, signal: options.signal });
          if (responseIsPending(body)) lastError = new AmrsTransportError('內網主機仍在處理提交', { kind: 'pending', phase: 'reconcile', unknownOutcome: true, details: body });
          else if (body?.success === false) throw new AmrsTransportError(body.message || '提交失敗', { kind: 'operation-failed', phase: 'reconcile', unknownOutcome: false, retryable: Boolean(body.retryable), details: body });
          else return body;
        } catch (error) {
          if (error.kind === 'operation-failed') throw error;
          lastError = error;
        }
        if (attempt < this.pollAttempts - 1) await this.sleep(this.pollDelayMs * (attempt + 1));
      }
      throw new AmrsTransportError('提交結果未能確認，請稍後重新核對', {
        kind: 'unknown-outcome', phase: 'reconcile', unknownOutcome: true, retryable: true,
        requestId: normalized.requestId, batchId: normalized.batchId, cause: lastError,
      });
    }

    async post(payload, options = {}) {
      const normalized = this._normalizeMutation(payload, options);
      const request = () => this._authorizedRequest('/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(normalized.body),
      }, { phase: 'api', timeoutMs: options.timeoutMs, signal: options.signal, mutation: true });
      try {
        const response = await request();
        return responseIsPending(response) ? this._reconcile(normalized, null, options) : response;
      } catch (error) {
        if (error.httpStatus === 401) throw error;
        if (!error.unknownOutcome) throw error;
        return this._reconcile(normalized, error, options);
      }
    }

    request(method, queryOrPayload, options = {}) {
      return String(method || 'GET').toUpperCase() === 'GET'
        ? this.get(queryOrPayload, options)
        : this.post(queryOrPayload, options);
    }
  }

  function createDualTransport(options) { return new IntranetTransport(options); }
  return { AmrsTransportError, IntranetTransport, createDualTransport };
}));
