import { getGoogleAccessToken } from "./google.mjs";

export const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";
export const DEFAULT_VALUE_INPUT_OPTION = "USER_ENTERED";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 10_000;

export class GoogleSheetsError extends Error {
  constructor(message, { status = 0, details = null, retryable = false, url = "" } = {}) {
    super(message);
    this.name = "GoogleSheetsError";
    this.status = status;
    this.details = details;
    this.retryable = retryable;
    this.url = url;
  }
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new RangeError(`${label} must be a positive integer`);
  return number;
}

export function columnNumberToA1(value) {
  let number = positiveInteger(value, "Column");
  let result = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result;
}

export function a1ColumnToNumber(value) {
  const label = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]+$/.test(label)) throw new RangeError("A1 column must contain letters only");
  let number = 0;
  for (const character of label) number = number * 26 + character.charCodeAt(0) - 64;
  return number;
}

export function quoteSheetName(value) {
  const name = String(value || "").trim();
  if (!name) throw new TypeError("Sheet name is required");
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

export function a1Range(sheetNameOrOptions, startRow, startColumn, endRow, endColumn) {
  let options;
  if (sheetNameOrOptions && typeof sheetNameOrOptions === "object") {
    options = sheetNameOrOptions;
  } else {
    options = { sheetName: sheetNameOrOptions, startRow, startColumn, endRow, endColumn };
  }
  const row = positiveInteger(options.startRow ?? options.row, "Start row");
  const column = positiveInteger(options.startColumn ?? options.column, "Start column");
  const finalRow = options.endRow != null
    ? positiveInteger(options.endRow, "End row")
    : options.rowCount == null
      ? row
      : row + positiveInteger(options.rowCount, "Row count") - 1;
  const finalColumn = options.endColumn != null
    ? positiveInteger(options.endColumn, "End column")
    : options.columnCount == null
      ? column
      : column + positiveInteger(options.columnCount, "Column count") - 1;
  if (finalRow < row || finalColumn < column) throw new RangeError("A1 range end must not precede its start");
  const prefix = options.sheetName == null && options.sheet == null
    ? ""
    : `${quoteSheetName(options.sheetName ?? options.sheet)}!`;
  const first = `${columnNumberToA1(column)}${row}`;
  const last = `${columnNumberToA1(finalColumn)}${finalRow}`;
  return `${prefix}${first}${finalRow === row && finalColumn === column ? "" : `:${last}`}`;
}

export function a1Cell(sheetName, row, column) {
  return a1Range(sheetName, row, column);
}

export function a1RowRange(sheetName, row, startColumn, endColumn) {
  return a1Range(sheetName, row, startColumn, row, endColumn);
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function appendQuery(url, query = {}) {
  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue == null) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value == null) continue;
      url.searchParams.append(key, typeof value === "boolean" ? String(value) : String(value));
    }
  }
  return url;
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

function normalizeAccessToken(value) {
  if (value && typeof value === "object") return String(value.access_token || value.accessToken || "").trim();
  return String(value || "").trim();
}

async function resolveAccessToken(options) {
  const direct = normalizeAccessToken(options.accessToken);
  if (direct) return direct;
  if (typeof options.tokenProvider === "function") {
    const provided = await options.tokenProvider();
    const token = normalizeAccessToken(provided);
    if (token) return token;
  }
  if (options.credentials) {
    return getGoogleAccessToken(options.credentials, {
      fetchImpl: options.tokenFetchImpl || options.fetchImpl,
      signJwt: options.signJwt,
      scope: options.scope,
      sleep: options.sleep,
    });
  }
  throw new GoogleSheetsError("Missing Google access token", { status: 500 });
}

function baseRequestOptions(options) {
  return {
    accessToken: options.accessToken,
    tokenProvider: options.tokenProvider,
    credentials: options.credentials,
    tokenFetchImpl: options.tokenFetchImpl,
    signJwt: options.signJwt,
    scope: options.scope,
    fetchImpl: options.fetchImpl,
    headers: options.headers,
    baseUrl: options.baseUrl,
    maxAttempts: options.maxAttempts,
    maxRetries: options.maxRetries,
    retryBaseMs: options.retryBaseMs,
    retryMaxMs: options.retryMaxMs,
    sleep: options.sleep,
  };
}

function normalizeCall(first, second, third, fourth) {
  if (first && typeof first === "object" && !Array.isArray(first)) return first;
  return { accessToken: first, spreadsheetId: second, range: third, ...(fourth || {}) };
}

function requireSpreadsheetId(options) {
  const spreadsheetId = String(options.spreadsheetId || "").trim();
  if (!spreadsheetId) throw new TypeError("spreadsheetId is required");
  return spreadsheetId;
}

function requireRange(options) {
  const range = String(options.range || "").trim();
  if (!range) throw new TypeError("range is required");
  return range;
}

function valueRangeBody(options) {
  if (options.body != null) return options.body;
  const body = { values: options.values };
  if (options.majorDimension != null) body.majorDimension = options.majorDimension;
  if (options.range != null) body.range = options.range;
  return body;
}

function valuesQuery(options, includeInputOption = false) {
  const query = { ...options.query };
  if (includeInputOption) query.valueInputOption = options.valueInputOption || DEFAULT_VALUE_INPUT_OPTION;
  for (const key of [
    "majorDimension",
    "valueRenderOption",
    "dateTimeRenderOption",
    "insertDataOption",
    "includeValuesInResponse",
    "responseValueRenderOption",
    "responseDateTimeRenderOption",
  ]) {
    if (options[key] != null) query[key] = options[key];
  }
  return query;
}

export async function sheetsRequest(options = {}) {
  const requestOptions = { ...options };
  const fetchImpl = requestOptions.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new GoogleSheetsError("Fetch is not available", { status: 500 });
  const accessToken = await resolveAccessToken(requestOptions);
  const baseUrl = String(requestOptions.baseUrl || SHEETS_API_BASE).replace(/\/+$/, "");
  const rawPath = String(requestOptions.path || "").replace(/^\/+/, "");
  if (!rawPath) throw new TypeError("Sheets API path is required");
  const url = appendQuery(new URL(`${baseUrl}/${rawPath}`), requestOptions.query);
  const headers = {
    authorization: `Bearer ${accessToken}`,
    ...(requestOptions.headers || {}),
  };
  let body;
  if (requestOptions.body !== undefined) {
    body = typeof requestOptions.body === "string" ? requestOptions.body : JSON.stringify(requestOptions.body);
    headers["content-type"] = headers["content-type"] || "application/json";
  }
  const maxAttempts = normalizeAttempts(requestOptions);
  const retryBaseMs = Math.max(0, Number(requestOptions.retryBaseMs ?? DEFAULT_RETRY_BASE_MS));
  const retryMaxMs = Math.max(retryBaseMs, Number(requestOptions.retryMaxMs ?? DEFAULT_RETRY_MAX_MS));
  const sleep = requestOptions.sleep || defaultSleep;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetchImpl(url.toString(), {
      method: requestOptions.method || "GET",
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const details = await readResponseBody(response);
    const status = Number(response?.status || 0);
    const ok = response?.ok ?? (status >= 200 && status < 300);
    if (ok) return details;

    const retryable = isRetryableStatus(status);
    const error = new GoogleSheetsError(`Google Sheets request failed (${status || "unknown"})`, {
      status,
      details,
      retryable,
      url: url.toString(),
    });
    if (!retryable || attempt >= maxAttempts - 1) throw error;
    const retryDelay = retryAfterMs(response);
    const exponential = Math.min(retryMaxMs, retryBaseMs * (2 ** attempt));
    await sleep(retryDelay == null ? exponential : Math.min(retryMaxMs, retryDelay));
  }

  throw new GoogleSheetsError("Google Sheets request failed", { status: 503, retryable: true, url: url.toString() });
}

export async function valuesGet(first, second, third, fourth) {
  const options = normalizeCall(first, second, third, fourth);
  const spreadsheetId = requireSpreadsheetId(options);
  const range = requireRange(options);
  return sheetsRequest({
    ...baseRequestOptions(options),
    method: "GET",
    path: `spreadsheets/${encodePathSegment(spreadsheetId)}/values/${encodePathSegment(range)}`,
    query: valuesQuery(options),
  });
}

export async function valuesBatchGet(first, second, third, fourth) {
  const options = normalizeCall(first, second, third, fourth);
  const spreadsheetId = requireSpreadsheetId(options);
  const rawRanges = options.ranges ?? options.range;
  const ranges = Array.isArray(rawRanges) ? rawRanges : [rawRanges];
  const normalizedRanges = ranges.filter((range) => range != null && String(range).trim()).map(String);
  if (!normalizedRanges.length) throw new TypeError("At least one range is required");
  return sheetsRequest({
    ...baseRequestOptions(options),
    method: "GET",
    path: `spreadsheets/${encodePathSegment(spreadsheetId)}/values:batchGet`,
    query: { ...valuesQuery(options), ranges: normalizedRanges },
  });
}

export async function valuesAppend(first, second, third, fourth) {
  const options = normalizeCall(first, second, third, fourth);
  const spreadsheetId = requireSpreadsheetId(options);
  const range = requireRange(options);
  return sheetsRequest({
    ...baseRequestOptions(options),
    method: "POST",
    path: `spreadsheets/${encodePathSegment(spreadsheetId)}/values/${encodePathSegment(range)}:append`,
    query: valuesQuery(options, true),
    body: valueRangeBody(options),
  });
}

export async function valuesUpdate(first, second, third, fourth) {
  const options = normalizeCall(first, second, third, fourth);
  const spreadsheetId = requireSpreadsheetId(options);
  const range = requireRange(options);
  return sheetsRequest({
    ...baseRequestOptions(options),
    method: "PUT",
    path: `spreadsheets/${encodePathSegment(spreadsheetId)}/values/${encodePathSegment(range)}`,
    query: valuesQuery(options, true),
    body: valueRangeBody(options),
  });
}

export async function valuesBatchUpdate(first, second, third) {
  const options = normalizeCall(first, second, third);
  const spreadsheetId = requireSpreadsheetId(options);
  const body = options.body != null
    ? options.body
    : {
        valueInputOption: options.valueInputOption || DEFAULT_VALUE_INPUT_OPTION,
        data: options.data || [],
        ...(options.includeValuesInResponse == null ? {} : { includeValuesInResponse: options.includeValuesInResponse }),
        ...(options.responseValueRenderOption == null ? {} : { responseValueRenderOption: options.responseValueRenderOption }),
        ...(options.responseDateTimeRenderOption == null ? {} : { responseDateTimeRenderOption: options.responseDateTimeRenderOption }),
      };
  return sheetsRequest({
    ...baseRequestOptions(options),
    method: "POST",
    path: `spreadsheets/${encodePathSegment(spreadsheetId)}/values:batchUpdate`,
    body,
  });
}

export async function spreadsheetBatchUpdate(first, second, third) {
  const options = normalizeCall(first, second, third);
  const spreadsheetId = requireSpreadsheetId(options);
  const body = options.body != null
    ? options.body
    : {
        requests: options.requests || [],
        ...(options.includeSpreadsheetInResponse == null ? {} : { includeSpreadsheetInResponse: options.includeSpreadsheetInResponse }),
        ...(options.responseRanges == null ? {} : { responseRanges: options.responseRanges }),
        ...(options.responseIncludeGridData == null ? {} : { responseIncludeGridData: options.responseIncludeGridData }),
      };
  return sheetsRequest({
    ...baseRequestOptions(options),
    method: "POST",
    path: `spreadsheets/${encodePathSegment(spreadsheetId)}:batchUpdate`,
    body,
  });
}

export function createSheetsClient(options = {}) {
  const config = { ...options };
  const call = (method, params, ...rest) => method({ ...config, ...(params && typeof params === "object" ? params : {}), ...rest });
  return {
    request: (params) => sheetsRequest({ ...config, ...params }),
    valuesGet: (params, ...rest) => call(valuesGet, params, ...rest),
    valuesBatchGet: (params, ...rest) => call(valuesBatchGet, params, ...rest),
    valuesAppend: (params, ...rest) => call(valuesAppend, params, ...rest),
    valuesUpdate: (params, ...rest) => call(valuesUpdate, params, ...rest),
    valuesBatchUpdate: (params, ...rest) => call(valuesBatchUpdate, params, ...rest),
    spreadsheetBatchUpdate: (params, ...rest) => call(spreadsheetBatchUpdate, params, ...rest),
    getValues: (params, ...rest) => call(valuesGet, params, ...rest),
    batchGetValues: (params, ...rest) => call(valuesBatchGet, params, ...rest),
    appendValues: (params, ...rest) => call(valuesAppend, params, ...rest),
    updateValues: (params, ...rest) => call(valuesUpdate, params, ...rest),
    batchUpdateValues: (params, ...rest) => call(valuesBatchUpdate, params, ...rest),
    batchUpdateSpreadsheet: (params, ...rest) => call(spreadsheetBatchUpdate, params, ...rest),
    batchUpdate: (params, ...rest) => call(valuesBatchUpdate, params, ...rest),
    get: (params, ...rest) => call(valuesGet, params, ...rest),
    batchGet: (params, ...rest) => call(valuesBatchGet, params, ...rest),
    append: (params, ...rest) => call(valuesAppend, params, ...rest),
    update: (params, ...rest) => call(valuesUpdate, params, ...rest),
  };
}

export const columnToA1 = columnNumberToA1;
export const toA1Column = columnNumberToA1;
export const a1Column = columnNumberToA1;
export const makeA1Range = a1Range;
export const getValues = valuesGet;
export const get = valuesGet;
export const batchGetValues = valuesBatchGet;
export const batchGet = valuesBatchGet;
export const appendValues = valuesAppend;
export const append = valuesAppend;
export const updateValues = valuesUpdate;
export const update = valuesUpdate;
export const batchUpdateValues = valuesBatchUpdate;
export const batchUpdateSpreadsheet = spreadsheetBatchUpdate;
export const batchUpdate = valuesBatchUpdate;
