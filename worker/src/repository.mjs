import {
  AA_TAG_SHEET,
  BROKEN_PARTS_HEADERS,
  BROKEN_PARTS_SHEET,
  COMPANIES,
  MONTHLY_SHEET,
  SUBMISSION_HEADER,
  TEMPLATE_SHEET,
  WORKSHEET_NAME,
  companySchema,
  loadRuntimeConfig,
  normalizeCompany,
} from "./config.mjs";
import {
  aaTagsFromRows,
  brokenPartsRecordFromRow,
  brokenPartsRecordToValues,
  combineMonthlyStats,
  formatSheetDate,
  getBrokenPartsPage,
  getDashboardRecords,
  getDuplicateFaultsFromRows,
  getMonthlyScheduleFromRows,
  getMonthlyStatsSubsetFromData,
  monthlyCompanyStatsCacheKey,
  monthlyStatsBaseFromData,
  monthlyStatsBaseCacheKey,
  monthlyStatsCacheKey,
  monthlyStatsCompanyFromRows,
  normalizeDateParam,
  normalizeMonthlyCode,
  partsCodesFromRows,
  recordFromRow,
  recordToValues,
  recordsMatch,
  scheduleMonthCode,
  scheduleOverviewFromRows,
  scheduleRemarkColumns,
  scheduleSheetName,
  validateEditedRecord,
  validateHoldDates,
  validateIncomingRecord,
} from "./domain.mjs";
import { createGoogleAccessTokenProvider } from "./google.mjs";
import { createCvcsRepository } from "./cvcs-repository.mjs";
import {
  a1Range,
  columnNumberToA1,
  createSheetsClient,
  quoteSheetName,
} from "./sheets.mjs";

const DEFAULT_CACHE_TTL_MS = 15_000;
const LONG_CACHE_TTL_MS = 5 * 60_000;
const MONTHLY_STATS_CACHE_TTL_MS = 10 * 60_000;
const MAX_READ_COLUMNS = 200;

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

function hasRecordValue(value) {
  return Array.isArray(value) ? value.length > 0 : text(value) !== "";
}

function needsBrokenPartsWrite(record = {}) {
  return [
    "brokenParts",
    "bpUodActivationDate",
    "bpUodUnlockDay",
    "bpUodUnlockDate",
    "bpHoldDate",
    "bpHoldReleaseDate",
  ].some((field) => hasRecordValue(record[field]));
}

function nowMs(now) {
  const value = typeof now === "function" ? now() : now;
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp) : Date.now();
}

function rowsFrom(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.results) ? result.results : [];
}

function jsonParse(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function d1Statement(db, sql, bindings = []) {
  if (!db || typeof db.prepare !== "function") return null;
  const prepared = db.prepare(sql);
  return typeof prepared.bind === "function" ? prepared.bind(...bindings) : prepared;
}

async function d1First(db, sql, bindings = []) {
  const statement = d1Statement(db, sql, bindings);
  return statement && typeof statement.first === "function" ? statement.first() : null;
}

async function d1Run(db, sql, bindings = []) {
  const statement = d1Statement(db, sql, bindings);
  return statement && typeof statement.run === "function" ? statement.run() : null;
}

function cacheMemoryKey(scope, key) {
  return `${scope}\u0000${key}`;
}

function clearMemoryScope(memory, scope) {
  for (const key of memory.keys()) {
    if (key.startsWith(`${scope}\u0000`)) memory.delete(key);
  }
}

async function cacheGeneration(db, scope) {
  if (!db) return 0;
  try {
    const row = await d1First(db, "SELECT generation FROM cache_generations WHERE scope = ?", [scope]);
    return Number(row?.generation || 0);
  } catch {
    return 0;
  }
}

async function adapterGet(adapter, key) {
  if (!adapter || typeof adapter.get !== "function") return null;
  try {
    const value = await adapter.get(key);
    if (value instanceof Response) {
      if (!value.ok) return null;
      return value.json();
    }
    return value == null ? null : value;
  } catch {
    return null;
  }
}

async function adapterPut(adapter, key, value, ttlMs) {
  if (!adapter || typeof adapter.put !== "function") return;
  try { await adapter.put(key, value, ttlMs); } catch { /* cache only */ }
}

async function adapterInvalidate(adapter, scope) {
  if (!adapter) return;
  try {
    if (typeof adapter.invalidate === "function") await adapter.invalidate(scope);
    else if (typeof adapter.delete === "function") await adapter.delete(scope);
  } catch { /* cache only */ }
}

export function createCloudflareCacheAdapter(cache = globalThis.caches?.default) {
  if (!cache || typeof cache.match !== "function" || typeof cache.put !== "function") return null;
  const requestFor = (key) => new Request(`https://amrs-cache.invalid/v1/${encodeURIComponent(String(key))}`);
  return {
    async get(key) {
      return cache.match(requestFor(key));
    },
    async put(key, value, ttlMs) {
      const maxAge = Math.max(1, Math.ceil((Number(ttlMs) || DEFAULT_CACHE_TTL_MS) / 1000));
      await cache.put(requestFor(key), new Response(JSON.stringify(value), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${maxAge}`,
        },
      }));
    },
  };
}

async function readCache(db, memory, adapter, scope, key, now) {
  const current = nowMs(now);
  const generation = await cacheGeneration(db, scope);
  const memoryKey = cacheMemoryKey(scope, key);
  const local = memory.get(memoryKey);
  if (local && local.generation === generation && local.expiresAt > current) return local.value;
  memory.delete(memoryKey);
  const value = await adapterGet(adapter, `${scope}:${generation}:${key}`);
  if (value == null) return null;
  memory.set(memoryKey, { value, generation, expiresAt: current + DEFAULT_CACHE_TTL_MS });
  return value;
}

async function writeCache(db, memory, adapter, scope, key, value, ttlMs, now) {
  const current = nowMs(now);
  const expiresAt = current + Math.max(1_000, Number(ttlMs) || DEFAULT_CACHE_TTL_MS);
  const generation = await cacheGeneration(db, scope);
  const memoryKey = cacheMemoryKey(scope, key);
  memory.set(memoryKey, { value, generation, expiresAt });
  await adapterPut(adapter, `${scope}:${generation}:${key}`, value, ttlMs);
  return value;
}

async function invalidateCache(db, memory, adapter, scope, now) {
  clearMemoryScope(memory, scope);
  await adapterInvalidate(adapter, scope);
  if (!db) return;
  const current = nowMs(now);
  try {
    await d1Run(db, `
      INSERT INTO cache_generations (scope, generation, updated_at)
      VALUES (?, 1, ?)
      ON CONFLICT(scope) DO UPDATE SET
        generation = cache_generations.generation + 1,
        updated_at = excluded.updated_at
    `, [scope, current]);
  } catch {
    // A stale cache is preferable to taking the write path down.
  }
}

function cached(memory, db, adapter, scope, key, loader, options = {}) {
  const ttlMs = options.ttlMs || DEFAULT_CACHE_TTL_MS;
  const skipCache = options.refresh === true || options.cache === false;
  return (async () => {
    if (!skipCache) {
      const cachedValue = await readCache(db, memory, adapter, scope, key, options.now);
      if (cachedValue != null) return cachedValue;
    }
    const value = await loader();
    return writeCache(db, memory, adapter, scope, key, value, ttlMs, options.now);
  })();
}

function sheetRange(sheetName, range) {
  return `${quoteSheetName(sheetName)}!${range}`;
}

function rangeForColumns(sheetName, startRow, endRow, endColumn) {
  const first = `A${startRow}`;
  const last = `${columnNumberToA1(endColumn)}${endRow == null ? "" : endRow}`;
  return sheetRange(sheetName, `${first}:${last}`);
}

function nonEmptyRow(row) {
  return Array.isArray(row) && row.some((value) => text(value) !== "");
}

function headerIndex(headers, wanted) {
  const target = text(wanted).toLowerCase();
  return headers.findIndex((value) => text(value).toLowerCase() === target) + 1;
}

function lastNonEmptyColumn(headers) {
  let last = 0;
  headers.forEach((value, index) => { if (text(value)) last = index + 1; });
  return last;
}

function arrayValue(row, column) {
  return Array.isArray(row) && row[column - 1] != null ? row[column - 1] : "";
}

function normalizeRequestCompany(company) {
  const requested = text(company);
  const normalized = normalizeCompany(requested);
  if (!requested || requested.toLowerCase() !== normalized.toLowerCase()) {
    throw Object.assign(new Error("Invalid company"), { status: 400 });
  }
  return normalized;
}

function getIdGenerator(deps) {
  return deps.uuid || (() => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  });
}

export function createRepository(env = {}, dependencies = {}) {
  const config = dependencies.config || loadRuntimeConfig(env);
  const db = dependencies.db ?? env.DB;
  const now = dependencies.now || (() => Date.now());
  const uuid = getIdGenerator(dependencies);
  let tokenProvider = dependencies.tokenProvider;
  if (!tokenProvider && env.GOOGLE_SERVICE_ACCOUNT) {
    tokenProvider = createGoogleAccessTokenProvider(env.GOOGLE_SERVICE_ACCOUNT);
  }
  const sheets = dependencies.sheetsClient || createSheetsClient({
    tokenProvider,
    credentials: env.GOOGLE_SERVICE_ACCOUNT,
    maxAttempts: 5,
    retryBaseMs: 750,
    retryMaxMs: 8_000,
  });
  const memory = dependencies.memoryCache || new Map();
  const cacheAdapter = dependencies.cacheAdapter || dependencies.responseCache || createCloudflareCacheAdapter();
  const metadataMemory = new Map();
  let cvcsRepository;

  function getCvcsRepository() {
    if (cvcsRepository) return cvcsRepository;
    cvcsRepository = createCvcsRepository({
      loadTable: loadCvcsTable,
      appendRows: async (table, rows) => appendValues(table.spreadsheetId, table.sheet.title, table.idColumn || table.headers.length, rows),
      writeRows: async (table, rows) => {
        const data = rows.map(({ rowNumber, values }) => ({
          range: `${quoteSheetName(table.sheet.title)}!A${rowNumber}:${columnNumberToA1(values.length)}${rowNumber}`,
          values: [values],
        }));
        if (data.length) await sheets.valuesBatchUpdate({ spreadsheetId: table.spreadsheetId, data, valueInputOption: "USER_ENTERED" });
      },
      deleteRows: async (table, rows) => deleteRows(table.spreadsheetId, table.sheet.sheetId, rows),
      replaceSheet: replaceCvcsSheet,
      invalidate: async (scopes) => Promise.all(scopes.map((scope) => invalidateCache(db, memory, cacheAdapter, scope, now))),
      uuid,
    });
    return cvcsRepository;
  }

  async function spreadsheetMetadata(spreadsheetId, options = {}) {
    const key = String(spreadsheetId);
    if (!options.refresh && metadataMemory.has(key)) return metadataMemory.get(key);
    const response = await sheets.request({
      method: "GET",
      path: `spreadsheets/${encodeURIComponent(key)}`,
      query: {
        fields: "sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))",
      },
    });
    const result = Array.isArray(response?.sheets)
      ? response.sheets.map((sheet) => sheet.properties || {}).filter((properties) => properties.title)
      : [];
    metadataMemory.set(key, result);
    return result;
  }

  function findSheet(metadata, title, fallbackFirst = false) {
    const expected = text(title).toLowerCase();
    return metadata.find((item) => text(item.title).toLowerCase() === expected)
      || (fallbackFirst ? metadata[0] : null)
      || null;
  }

  async function ensureGridColumns(spreadsheetId, sheet, requiredColumn) {
    const current = Number(sheet?.gridProperties?.columnCount || 0);
    if (current >= requiredColumn || !sheet?.sheetId) return;
    await sheets.spreadsheetBatchUpdate({
      spreadsheetId,
      requests: [{
        insertDimension: {
          range: {
            sheetId: Number(sheet.sheetId),
            dimension: "COLUMNS",
            startIndex: current,
            endIndex: requiredColumn,
          },
          inheritFromBefore: true,
        },
      }],
    });
    metadataMemory.delete(String(spreadsheetId));
  }

  async function hideColumn(spreadsheetId, sheetId, column) {
    if (!sheetId) return;
    try {
      await sheets.spreadsheetBatchUpdate({
        spreadsheetId,
        requests: [{
          updateDimensionProperties: {
            range: { sheetId: Number(sheetId), dimension: "COLUMNS", startIndex: column - 1, endIndex: column },
            properties: { hidden: true },
            fields: "hidden",
          },
        }],
      });
    } catch {
      // Hiding the implementation column is best effort; it is never part of the UI contract.
    }
  }

  async function readValues(spreadsheetId, sheetName, range, options = {}) {
    const response = await sheets.valuesGet({
      spreadsheetId,
      range: sheetRange(sheetName, range),
      valueRenderOption: "FORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    return Array.isArray(response?.values) ? response.values : [];
  }

  async function writeValues(spreadsheetId, sheetName, range, values) {
    return sheets.valuesUpdate({
      spreadsheetId,
      range: sheetRange(sheetName, range),
      values,
      valueInputOption: "USER_ENTERED",
      includeValuesInResponse: false,
    });
  }

  async function appendValues(spreadsheetId, sheetName, endColumn, values) {
    return sheets.valuesAppend({
      spreadsheetId,
      range: sheetRange(sheetName, `A:${columnNumberToA1(endColumn)}`),
      values,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      includeValuesInResponse: false,
    });
  }

  async function deleteRows(spreadsheetId, sheetId, rowNumbers) {
    const sorted = [...new Set(rowNumbers.map((row) => Number(row)).filter((row) => row >= 2))].sort((a, b) => b - a);
    if (!sorted.length) return;
    const groups = [];
    for (const row of sorted) {
      const last = groups[groups.length - 1];
      if (last && row === last.start - 1) {
        last.start = row;
        last.count += 1;
      } else groups.push({ start: row, count: 1 });
    }
    await sheets.spreadsheetBatchUpdate({
      spreadsheetId,
      requests: groups.map((group) => ({
        deleteDimension: {
          range: {
            sheetId: Number(sheetId),
            dimension: "ROWS",
            startIndex: group.start - 1,
            endIndex: group.start - 1 + group.count,
          },
        },
      })),
    });
  }

  async function addSheet(spreadsheetId, title) {
    const response = await sheets.spreadsheetBatchUpdate({
      spreadsheetId,
      requests: [{ addSheet: { properties: { title } } }],
    });
    const properties = response?.replies?.[0]?.addSheet?.properties;
    metadataMemory.delete(String(spreadsheetId));
    return properties || null;
  }

  async function ensureSheet(spreadsheetId, title, options = {}) {
    let metadata = await spreadsheetMetadata(spreadsheetId, { refresh: options.refresh });
    let sheet = findSheet(metadata, title, false);
    if (!sheet && options.create) {
      sheet = await addSheet(spreadsheetId, title);
      metadata = await spreadsheetMetadata(spreadsheetId, { refresh: true });
      sheet = findSheet(metadata, title, false) || sheet;
    }
    return sheet;
  }

  async function ensureIdentity(spreadsheetId, sheet, values, minimumColumn, scope) {
    const source = values.map((row) => Array.isArray(row) ? row.slice() : []);
    if (!source.length) source.push([]);
    const headers = source[0] || [];
    const existingIdColumn = headerIndex(headers, SUBMISSION_HEADER);
    let idColumn = existingIdColumn;
    if (!idColumn) idColumn = Math.max(minimumColumn, lastNonEmptyColumn(headers) + 1);
    await ensureGridColumns(spreadsheetId, sheet, idColumn);
    let headerChanged = false;
    if (existingIdColumn !== idColumn) {
      await writeValues(spreadsheetId, sheet.title, `${columnNumberToA1(idColumn)}1`, [[SUBMISSION_HEADER]]);
      await hideColumn(spreadsheetId, sheet.sheetId, idColumn);
      while (source[0].length < idColumn) source[0].push("");
      source[0][idColumn - 1] = SUBMISSION_HEADER;
      headerChanged = true;
    }
    const rowCount = Math.max(source.length - 1, 0);
    const idValues = [];
    let changed = false;
    for (let index = 0; index < rowCount; index += 1) {
      const row = source[index + 1] || [];
      while (row.length < idColumn) row.push("");
      let id = text(row[idColumn - 1]);
      if (nonEmptyRow(row.slice(0, minimumColumn - 1)) && !id) {
        id = text(uuid());
        row[idColumn - 1] = id;
        changed = true;
      }
      idValues.push([id]);
      source[index + 1] = row;
    }
    if (changed && rowCount) {
      await writeValues(spreadsheetId, sheet.title, `${columnNumberToA1(idColumn)}2:${columnNumberToA1(idColumn)}${rowCount + 1}`, idValues);
    }
    return { values: headerChanged || changed ? source : values, idColumn, scope };
  }

  async function readMainTable(company, options = {}) {
    const normalized = normalizeCompany(company);
    const spreadsheetId = config.sheets[normalized];
    const metadata = await spreadsheetMetadata(spreadsheetId, { refresh: options.cache === false });
    const sheet = findSheet(metadata, WORKSHEET_NAME, true);
    if (!sheet) return { company: normalized, sheet: null, values: [], rows: [], idColumn: 0, width: companySchema(normalized).width };
    const width = companySchema(normalized).width;
    const readColumns = Math.min(MAX_READ_COLUMNS, Math.max(52, Number(sheet.gridProperties?.columnCount || 0)));
    const scope = `main:${normalized}`;
    const values = await cached(memory, db, cacheAdapter, scope, `${spreadsheetId}:${sheet.title}`,
      () => readValues(spreadsheetId, sheet.title, `A1:${columnNumberToA1(readColumns)}`),
      { refresh: options.refresh, cache: options.cache !== false, ttlMs: DEFAULT_CACHE_TTL_MS, now });
    let identity = { values, idColumn: headerIndex(values[0] || [], SUBMISSION_HEADER) };
    if (options.ensureIdentity !== false) {
      identity = await ensureIdentity(spreadsheetId, sheet, values, width + 1, scope);
      if (identity.values !== values) {
        await invalidateCache(db, memory, cacheAdapter, scope, now);
        await writeCache(db, memory, cacheAdapter, scope, `${spreadsheetId}:${sheet.title}`, identity.values, DEFAULT_CACHE_TTL_MS, now);
      }
    }
    return {
      company: normalized,
      spreadsheetId,
      sheet,
      values: identity.values,
      rows: identity.values.slice(1),
      idColumn: identity.idColumn,
      width,
    };
  }

  async function readSpecialTable(spreadsheetId, title, range, options = {}) {
    const metadata = await spreadsheetMetadata(spreadsheetId, { refresh: options.cache === false });
    const sheet = findSheet(metadata, title, options.fallbackFirst === true);
    if (!sheet) return { sheet: null, values: [] };
    const scope = options.scope || `sheet:${spreadsheetId}:${sheet.title}`;
    const values = await cached(memory, db, cacheAdapter, scope, `${spreadsheetId}:${sheet.title}:${range}`,
      () => readValues(spreadsheetId, sheet.title, range),
      { refresh: options.refresh, cache: options.cache !== false, ttlMs: options.ttlMs || DEFAULT_CACHE_TTL_MS, now });
    return { spreadsheetId, sheet, values };
  }

  async function loadCvcsTable(title, headers, options = {}) {
    const spreadsheetId = text(config.cvcsSheetId);
    if (!spreadsheetId) throw Object.assign(new Error("CVCS spreadsheet is not configured"), { status: 503 });
    const sheet = await ensureSheet(spreadsheetId, title, { create: true, refresh: options.refresh || options.cache === false });
    if (!sheet) throw Object.assign(new Error(`CVCS worksheet not found: ${title}`), { status: 502 });
    const scope = options.scope || `cvcs:${title}`;
    const readColumns = Math.min(MAX_READ_COLUMNS, Math.max(26, Number(sheet.gridProperties?.columnCount || 0), headers.length + 1));
    let values = await cached(memory, db, cacheAdapter, scope, `${spreadsheetId}:${title}`,
      () => readValues(spreadsheetId, title, `A1:${columnNumberToA1(readColumns)}`),
      { refresh: options.refresh, cache: options.cache !== false, ttlMs: DEFAULT_CACHE_TTL_MS, now });
    const currentHeaders = values[0] || [];
    if (headers.some((header, index) => text(currentHeaders[index]) !== header)) {
      await writeValues(spreadsheetId, title, `A1:${columnNumberToA1(headers.length)}1`, [headers]);
      values = [headers.slice(), ...values.slice(1)];
      await invalidateCache(db, memory, cacheAdapter, scope, now);
    }
    let identity = { values, idColumn: 0 };
    if (options.identity) {
      identity = await ensureIdentity(spreadsheetId, sheet, values, headers.length + 1, scope);
      if (identity.values !== values) await invalidateCache(db, memory, cacheAdapter, scope, now);
    }
    return {
      spreadsheetId,
      sheet,
      headers,
      values: identity.values,
      rows: identity.values.slice(1),
      idColumn: identity.idColumn,
    };
  }

  async function replaceCvcsSheet(title, rows, width) {
    const spreadsheetId = text(config.cvcsSheetId);
    if (!spreadsheetId) throw Object.assign(new Error("CVCS spreadsheet is not configured"), { status: 503 });
    const sheet = await ensureSheet(spreadsheetId, title, { create: true, refresh: true });
    const current = await readValues(spreadsheetId, title, `A1:${columnNumberToA1(width)}`);
    const rowCount = Math.max(current.length, rows.length, 1);
    const padded = rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
    while (padded.length < rowCount) padded.push(Array(width).fill(""));
    await writeValues(spreadsheetId, title, `A1:${columnNumberToA1(width)}${rowCount}`, padded);
    metadataMemory.delete(spreadsheetId);
    return sheet;
  }

  async function readBrokenTable(company, options = {}) {
    const normalized = normalizeCompany(company);
    const spreadsheetId = config.sheets[normalized];
    const metadata = await spreadsheetMetadata(spreadsheetId, { refresh: options.cache === false });
    const sheet = findSheet(metadata, BROKEN_PARTS_SHEET, false);
    if (!sheet) return { company: normalized, spreadsheetId, sheet: null, values: [], rows: [], idColumn: 0 };
    const readColumns = Math.min(MAX_READ_COLUMNS, Math.max(52, Number(sheet.gridProperties?.columnCount || 0)));
    const scope = `broken:${normalized}`;
    const values = await cached(memory, db, cacheAdapter, scope, `${spreadsheetId}:${sheet.title}`,
      () => readValues(spreadsheetId, sheet.title, `A1:${columnNumberToA1(readColumns)}`),
      { refresh: options.refresh, cache: options.cache !== false, ttlMs: DEFAULT_CACHE_TTL_MS, now });
    let identity = { values, idColumn: headerIndex(values[0] || [], SUBMISSION_HEADER) };
    if (options.ensureIdentity !== false) {
      identity = await ensureIdentity(spreadsheetId, sheet, values, BROKEN_PARTS_HEADERS.length + 1, scope);
      if (identity.values !== values) {
        await invalidateCache(db, memory, cacheAdapter, scope, now);
        await writeCache(db, memory, cacheAdapter, scope, `${spreadsheetId}:${sheet.title}`, identity.values, DEFAULT_CACHE_TTL_MS, now);
      }
    }
    return {
      company: normalized,
      spreadsheetId,
      sheet,
      values: identity.values,
      rows: identity.values.slice(1),
      idColumn: identity.idColumn,
    };
  }

  async function ensureBrokenTable(company) {
    const normalized = normalizeCompany(company);
    const spreadsheetId = config.sheets[normalized];
    let sheet = await ensureSheet(spreadsheetId, BROKEN_PARTS_SHEET, { create: true, refresh: true });
    if (!sheet) throw Object.assign(new Error("Broken Parts List not found"), { status: 502 });
    await ensureGridColumns(spreadsheetId, sheet, BROKEN_PARTS_HEADERS.length);
    const values = await readValues(spreadsheetId, sheet.title, `A1:${columnNumberToA1(Math.max(52, BROKEN_PARTS_HEADERS.length + 1))}`);
    const currentHeaders = values[0] || [];
    const headerUpdates = [];
    BROKEN_PARTS_HEADERS.forEach((header, index) => {
      const current = text(currentHeaders[index]);
      if (!current || (index === 10 && current === "UOD Unlock Day") || (index === 11 && current === "UOD Unlock Day")) {
        headerUpdates.push({ range: `${columnNumberToA1(index + 1)}1`, values: [[header]] });
      }
    });
    if (headerUpdates.length) await sheets.valuesBatchUpdate({ spreadsheetId, data: headerUpdates, valueInputOption: "USER_ENTERED" });
    metadataMemory.delete(String(spreadsheetId));
    const refreshedMetadata = await spreadsheetMetadata(spreadsheetId, { refresh: true });
    sheet = findSheet(refreshedMetadata, BROKEN_PARTS_SHEET, false) || sheet;
    return { normalized, spreadsheetId, sheet, values };
  }

  async function readTemplate(company, options = {}) {
    const normalized = normalizeCompany(company);
    const table = await readSpecialTable(config.sheets[normalized], TEMPLATE_SHEET, "A1:B", {
      ...options,
      scope: `template:${normalized}`,
      ttlMs: LONG_CACHE_TTL_MS,
    });
    const mappings = [];
    table.values.forEach((row, index) => {
      const reason = text(row?.[0]);
      const action = text(row?.[1]);
      if (!reason && !action) return;
      if (index === 0 && reason.toLowerCase() === "reason") return;
      mappings.push({ reason, action });
    });
    return mappings;
  }

  async function readParts(options = {}) {
    const table = await readSpecialTable(config.partsSheetId, "Parts Code", "A1:C", {
      ...options,
      fallbackFirst: true,
      scope: "parts-codes",
      ttlMs: LONG_CACHE_TTL_MS,
    });
    return partsCodesFromRows(table.values);
  }

  async function readAaTags(options = {}) {
    const metadata = await spreadsheetMetadata(config.sheets.MGM, { refresh: options.cache === false });
    const sheet = findSheet(metadata, AA_TAG_SHEET, false);
    if (!sheet) return [];
    const scope = "aa-tags";
    const values = await cached(memory, db, cacheAdapter, scope, `${config.sheets.MGM}:${sheet.title}`,
      () => readValues(config.sheets.MGM, sheet.title, "A1:B"),
      { refresh: options.refresh, cache: options.cache !== false, ttlMs: LONG_CACHE_TTL_MS, now });
    return aaTagsFromRows(values);
  }

  async function readMonthlySettings(options = {}) {
    const table = await readSpecialTable(config.sheets.SCL, MONTHLY_SHEET, "A1:C20", {
      ...options,
      scope: "monthly-settings",
      ttlMs: DEFAULT_CACHE_TTL_MS,
    });
    const values = table.values;
    const cell = (row, column) => values[row - 1]?.[column - 1] ?? "";
    const number = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
    };
    return {
      poNumber: text(cell(2, 2)),
      targets: {
        Venetian: number(cell(4, 3)),
        Londoner: number(cell(8, 3)),
        Parisian: number(cell(12, 3)),
        Sands: number(cell(16, 3)),
        Plaza: number(cell(20, 3)),
      },
    };
  }

  async function readScheduleTable(monthCode, options = {}) {
    const sheetName = scheduleSheetName(monthCode);
    const metadata = await spreadsheetMetadata(config.scheduleSheetId, { refresh: options.cache === false });
    const sheet = findSheet(metadata, sheetName, false);
    if (!sheet) return null;
    const scope = `schedule:${monthCode}`;
    const values = await cached(memory, db, cacheAdapter, scope, `${config.scheduleSheetId}:${sheet.title}`,
      () => readValues(config.scheduleSheetId, sheet.title, `A3:${columnNumberToA1(Math.max(20, Number(sheet.gridProperties?.columnCount) || 0))}`),
      { refresh: options.refresh, cache: options.cache !== false, ttlMs: DEFAULT_CACHE_TTL_MS, now });
    return {
      spreadsheetId: config.scheduleSheetId,
      sheetId: sheet.sheetId,
      sheetName: sheet.title,
      headerRow: 3,
      headers: values[0] || [],
      rows: values.slice(1),
    };
  }

  async function mainRowsForCompany(company, options = {}) {
    return readMainTable(company, { ...options, ensureIdentity: options.ensureIdentity !== false });
  }

  async function getDashboard(params = {}) {
    const company = normalizeCompany(params.company);
    const main = await mainRowsForCompany(company, { refresh: text(params.refresh) === "1" });
    const serialNo = text(params.serialNo);
    let brokenRows = [];
    if (serialNo && text(params.includeParts || "1") !== "0") {
      const broken = await readBrokenTable(company, { refresh: text(params.refresh) === "1" });
      brokenRows = broken.values;
    }
    return getDashboardRecords(main.rows, params, {
      timeZone: config.timeZone,
      startRow: 2,
      idColumn: main.idColumn,
      totalRows: main.rows.length,
      brokenPartsRows: brokenRows,
    });
  }

  async function getToday(params = {}) {
    const company = normalizeCompany(params.company);
    const main = await mainRowsForCompany(company, { refresh: text(params.refresh) === "1" });
    const today = formatSheetDate(new Date(nowMs(now)), config.timeZone);
    const casino = text(params.casino);
    const records = [];
    main.rows.forEach((row, index) => {
      const rowDate = formatSheetDate(arrayValue(row, 2), config.timeZone);
      if (!rowDate || rowDate !== today || (casino && text(arrayValue(row, 1)) !== casino)) return;
      const recordId = main.idColumn ? text(arrayValue(row, main.idColumn)) : "";
      records.push(recordFromRow(row, rowDate, index + 2, company, recordId));
    });
    return { records };
  }

  async function getDuplicateFaults(params = {}) {
    const company = normalizeCompany(params.company);
    const reason = text(params.reason);
    const date = normalizeDateParam(params.date, config.timeZone);
    if (!date) throw Object.assign(new Error("Invalid date"), { status: 400 });
    const serialNos = text(params.serialNos).split(",").map((value) => text(value)).filter(Boolean);
    const main = await mainRowsForCompany(company, { refresh: true, cache: false });
    return {
      success: true,
      duplicates: getDuplicateFaultsFromRows(main.rows, { company, serialNos, reason, date, timeZone: config.timeZone }),
    };
  }

  async function getBrokenParts(params = {}) {
    const company = normalizeCompany(params.company);
    const table = await readBrokenTable(company, { refresh: text(params.refresh) === "1" });
    return getBrokenPartsPage(table.values, text(params.serialNo), params);
  }

  async function monthlyBase(params = {}) {
    const monthCode = normalizeMonthlyCode(params.month, new Date(nowMs(now)), config.timeZone);
    const refresh = text(params.refresh) === "1";
    return cached(memory, db, cacheAdapter, "monthly-base", monthlyStatsBaseCacheKey(monthCode, new Date(nowMs(now))), async () => {
      const schedule = await readScheduleTable(monthCode, { refresh });
      const scheduleData = schedule
        ? getMonthlyScheduleFromRows(schedule.rows, monthCode, new Date(nowMs(now)), schedule.sheetName, { timeZone: config.timeZone })
        : { sheetName: scheduleSheetName(monthCode), venues: {} };
      const settings = await readMonthlySettings({ refresh });
      return monthlyStatsBaseFromData({
        monthCode,
        now: new Date(nowMs(now)),
        timeZone: config.timeZone,
        schedule: { sheetName: scheduleData.sheetName, venues: scheduleData.venues },
        sclSettings: settings,
      });
    }, { refresh, ttlMs: MONTHLY_STATS_CACHE_TTL_MS, now });
  }

  async function monthlyCompany(params = {}) {
    const company = normalizeRequestCompany(params.company);
    const monthCode = normalizeMonthlyCode(params.month, new Date(nowMs(now)), config.timeZone);
    const refresh = text(params.refresh) === "1";
    return cached(memory, db, cacheAdapter, `monthly-company:${company}`, monthlyCompanyStatsCacheKey(monthCode, company), async () => {
      const main = await mainRowsForCompany(company, { refresh });
      const settings = company === "SCL" ? await readMonthlySettings({ refresh }) : {};
      return monthlyStatsCompanyFromRows({
        company,
        month: monthCode,
        poNumber: params.poNumber,
        now: new Date(nowMs(now)),
        timeZone: config.timeZone,
      }, main.rows, settings);
    }, { refresh, ttlMs: MONTHLY_STATS_CACHE_TTL_MS, now });
  }

  async function monthlySubset(params = {}, companies = COMPANIES) {
    const monthCode = normalizeMonthlyCode(params.month, new Date(nowMs(now)), config.timeZone);
    const refresh = text(params.refresh) === "1";
    const allCompanies = companies.length === COMPANIES.length && COMPANIES.every((company) => companies.includes(company));
    const scope = allCompanies ? "monthly-all" : "monthly-machine-counts";
    return cached(memory, db, cacheAdapter, scope, monthlyStatsCacheKey(monthCode, new Date(nowMs(now))), async () => {
      const base = await monthlyBase({ ...params, month: monthCode });
      const results = await Promise.all(companies.map((company) => monthlyCompany({
        ...params,
        company,
        month: monthCode,
      })));
      return getMonthlyStatsSubsetFromData({ base, companyResults: results });
    }, { refresh, ttlMs: MONTHLY_STATS_CACHE_TTL_MS, now });
  }

  async function scheduleOverview(params = {}) {
    const from = params.from || formatSheetDate(new Date(nowMs(now)), config.timeZone);
    const days = Math.min(Math.max(Number.parseInt(params.days || "7", 10) || 7, 1), 45);
    const monthCodes = new Set();
    const start = new Date(`${String(from).replace(/\//g, "-")}T12:00:00Z`);
    for (let index = 0; index < days; index += 1) {
      const date = new Date(start.getTime());
      date.setUTCDate(start.getUTCDate() + index);
      monthCodes.add(scheduleMonthCode(date, config.timeZone));
    }
    const entries = await Promise.all([...monthCodes].map(async (monthCode) => [
      monthCode,
      await readScheduleTable(monthCode, { refresh: text(params.refresh) === "1" }),
    ]));
    const scheduleSheets = Object.fromEntries(entries.filter(([, value]) => value));
    return scheduleOverviewFromRows({
      ...params,
      from,
      days,
      now: new Date(nowMs(now)),
      timeZone: config.timeZone,
    }, scheduleSheets);
  }

  async function invalidateSchedule(monthCode) {
    await Promise.all([
      invalidateCache(db, memory, cacheAdapter, `schedule:${monthCode}`, now),
      invalidateCache(db, memory, cacheAdapter, "monthly-base", now),
      invalidateCache(db, memory, cacheAdapter, "monthly-all", now),
      invalidateCache(db, memory, cacheAdapter, "monthly-machine-counts", now),
    ]);
  }

  async function updateScheduleRemark(payload = {}) {
    const monthCode = normalizeMonthlyCode(payload.month, new Date(nowMs(now)), config.timeZone);
    const date = normalizeDateParam(payload.date, config.timeZone);
    if (!date) throw Object.assign(new Error("Invalid schedule date"), { status: 400 });
    const shift = text(payload.shift).toLowerCase();
    if (shift !== "am" && shift !== "pm") throw Object.assign(new Error("Invalid schedule shift"), { status: 400 });
    const remark = String(payload.remark == null ? "" : payload.remark).trim();
    if (remark.length > 2000) throw Object.assign(new Error("Schedule remark is too long"), { status: 400 });
    const table = await readScheduleTable(monthCode, { refresh: true, cache: false });
    if (!table) throw Object.assign(new Error(`Schedule sheet ${scheduleSheetName(monthCode)} was not found`), { status: 404 });
    const day = Number(date.slice(-2));
    const rowIndex = table.rows.findIndex((row) => Number(text(row?.[0])) === day);
    if (rowIndex < 0) throw Object.assign(new Error(`Schedule date ${date} was not found`), { status: 404 });
    const remarkColumn = scheduleRemarkColumns(table.headers)[shift].remark;
    if (remarkColumn < 0) throw Object.assign(new Error(`The ${shift.toUpperCase()} schedule remark column was not found`), { status: 400 });
    const rowNumber = table.headerRow + 1 + rowIndex;
    await writeValues(
      table.spreadsheetId,
      table.sheetName,
      `${columnNumberToA1(remarkColumn + 1)}${rowNumber}`,
      [[remark]],
    );
    await invalidateSchedule(monthCode);
    return { success: true, monthCode, date, shift, remark };
  }

  async function getAction(params = {}) {
    const action = text(params.action);
    const cvcsResult = await getCvcsRepository().getAction(params);
    if (cvcsResult) return cvcsResult;
    if (action === "ping") return { success: true };
    if (action === "today") return getToday(params);
    if (action === "duplicateFault") return getDuplicateFaults(params);
    if (action === "dashboard") return getDashboard(params);
    if (action === "parts") return { parts: await readParts({ refresh: text(params.refresh) === "1" }) };
    if (action === "template") return { success: true, mappings: await readTemplate(params.company, { refresh: text(params.refresh) === "1" }) };
    if (action === "aaTags") return { success: true, tags: await readAaTags({ refresh: text(params.refresh) === "1" }) };
    if (action === "brokenPartsList") return getBrokenParts(params);
    if (action === "monthlyStats") return monthlySubset(params, COMPANIES);
    if (action === "monthlyStatsBase") return monthlyBase(params);
    if (action === "monthlyStatsCompany") return monthlyCompany(params);
    if (action === "scheduleMachineCounts") return monthlySubset(params, ["SCL", "GEG"]);
    if (action === "scheduleOverview") return scheduleOverview(params);
    if (action === "monthlySettings") return { success: true, settings: await readMonthlySettings({ refresh: text(params.refresh) === "1" }) };
    return { error: "unknown action" };
  }

  function writeValueRangeForRow(sheetName, rowNumber, values) {
    return { range: `${quoteSheetName(sheetName)}!A${rowNumber}:${columnNumberToA1(values.length)}${rowNumber}`, values: [values] };
  }

  async function resolveMainRecord(company, candidate, options = {}) {
    const main = await mainRowsForCompany(company, { refresh: true, cache: false });
    const recordId = text(candidate?.recordId);
    if (!recordId) throw new Error("Please reload before editing this record");
    let rowNumber = 0;
    main.rows.forEach((row, index) => {
      if (text(arrayValue(row, main.idColumn)) === recordId) rowNumber = index + 2;
    });
    if (!rowNumber) throw new Error("Record changed; please reload");
    const row = main.rows[rowNumber - 2] || [];
    const current = recordFromRow(row, formatSheetDate(arrayValue(row, 2), config.timeZone), rowNumber, company, recordId);
    return { main, rowNumber, row, current, recordId };
  }

  async function updateRecord(payload) {
    const candidate = payload.record || {};
    const company = normalizeCompany(candidate.company || payload.company);
    const target = await resolveMainRecord(company, payload.original || candidate);
    if (!recordsMatch(target.current, payload.original || null, company)) return { success: false, message: "Record changed; please reload" };
    const after = { ...target.current, ...candidate, rowNumber: target.rowNumber, company };
    validateEditedRecord(after, target.current, candidate);
    await writeValues(target.main.spreadsheetId, target.main.sheet.title, `A${target.rowNumber}:${columnNumberToA1(target.main.width)}${target.rowNumber}`, [recordToValues(after, company)]);
    await invalidateCompany(company);
    return { success: true, rowNumber: target.rowNumber, recordId: target.recordId };
  }

  async function deleteRecord(payload) {
    const candidate = payload.record || {};
    const company = normalizeCompany(candidate.company || payload.company);
    const target = await resolveMainRecord(company, candidate);
    if (!recordsMatch(target.current, candidate, company)) return { success: false, message: "Record changed; please reload" };
    await deleteRows(target.main.spreadsheetId, target.main.sheet.sheetId, [target.rowNumber]);
    await invalidateCompany(company);
    return { success: true, rowNumber: target.rowNumber };
  }

  async function bulkDeleteRecords(payload) {
    const company = normalizeCompany(payload.company);
    const records = Array.isArray(payload.records) ? payload.records : [];
    if (!records.length) return { success: false, message: "No records supplied" };
    const main = await mainRowsForCompany(company, { refresh: true, cache: false });
    const targets = [];
    const seen = new Set();
    records.forEach((candidate) => {
      const id = text(candidate.recordId);
      if (!id) throw new Error("Please reload before deleting these records");
      const rowNumber = main.rows.findIndex((row) => text(arrayValue(row, main.idColumn)) === id) + 2;
      if (rowNumber < 2 || seen.has(rowNumber)) throw new Error("Invalid or duplicate row number");
      seen.add(rowNumber);
      const current = recordFromRow(main.rows[rowNumber - 2], formatSheetDate(arrayValue(main.rows[rowNumber - 2], 2), config.timeZone), rowNumber, company, id);
      if (!recordsMatch(current, candidate, company)) throw new Error("Record changed; please reload");
      targets.push(rowNumber);
    });
    await deleteRows(main.spreadsheetId, main.sheet.sheetId, targets);
    await invalidateCompany(company);
    return { success: true, deleted: targets.length };
  }

  async function bulkUpdateRecords(payload) {
    const company = normalizeCompany(payload.company);
    const records = Array.isArray(payload.records) ? payload.records : [];
    const requested = payload.changes || {};
    const allowed = ["casino", "date", "poNumber", "model", "reason", "actionTaken"];
    const changes = Object.fromEntries(allowed.filter((key) => own(requested, key) && text(requested[key]) !== "").map((key) => [key, requested[key]]));
    if (!Object.keys(changes).length) return { success: false, message: "No changes supplied" };
    if (!records.length) throw new Error("No records supplied");
    const main = await mainRowsForCompany(company, { refresh: true, cache: false });
    const targets = records.map((candidate) => {
      const id = text(candidate.recordId);
      if (!id) throw new Error("Please reload before editing these records");
      const rowNumber = main.rows.findIndex((row) => text(arrayValue(row, main.idColumn)) === id) + 2;
      if (rowNumber < 2) throw new Error("Record changed; please reload");
      const current = recordFromRow(main.rows[rowNumber - 2], formatSheetDate(arrayValue(main.rows[rowNumber - 2], 2), config.timeZone), rowNumber, company, id);
      if (!recordsMatch(current, candidate, company)) throw new Error("Record changed; please reload");
      const after = { ...current, ...changes, rowNumber, company };
      validateEditedRecord(after, current, changes);
      return { rowNumber, current, after };
    });
    const data = [];
    for (const [key, value] of Object.entries(changes)) {
      const column = companySchema(company).fields.indexOf(key) + 1;
      if (column < 1) continue;
      const normalized = key === "date" ? normalizeDateParam(value) : value;
      targets.forEach(({ rowNumber }) => data.push({
        range: `${quoteSheetName(main.sheet.title)}!${columnNumberToA1(column)}${rowNumber}`,
        values: [[normalized]],
      }));
    }
    if (data.length) await sheets.valuesBatchUpdate({ spreadsheetId: main.spreadsheetId, data, valueInputOption: "USER_ENTERED" });
    await invalidateCompany(company);
    return { success: true, saved: targets.length };
  }

  async function updateTemplate(payload) {
    const company = normalizeCompany(payload.company);
    const spreadsheetId = config.sheets[company];
    const sheet = await ensureSheet(spreadsheetId, TEMPLATE_SHEET, { create: true, refresh: true });
    const current = await readValues(spreadsheetId, sheet.title, "A1:B");
    const mappings = (Array.isArray(payload.mappings) ? payload.mappings : [])
      .map((item) => ({ reason: text(item.reason), action: text(item.action) }))
      .filter((item) => item.reason || item.action);
    const rowCount = Math.max(current.length, mappings.length + 1, 1);
    const rows = [["Reason", "Action Taken"], ...mappings.map(({ reason, action }) => [reason, action])];
    while (rows.length < rowCount) rows.push(["", ""]);
    await writeValues(spreadsheetId, sheet.title, `A1:B${rowCount}`, rows);
    await invalidateCache(db, memory, cacheAdapter, `template:${company}`, now);
    return { success: true, saved: mappings.length, mappings };
  }

  async function updateBrokenPartsList(payload) {
    const company = normalizeCompany(payload.company);
    const ensured = await ensureBrokenTable(company);
    const table = await readBrokenTable(company, { refresh: true, cache: false });
    const originalLastRow = table.values.length;
    const deleted = [...new Set((payload.deletedRowNumbers || []).map((value) => Number.parseInt(value, 10)).filter((row) => row > 1 && row <= originalLastRow))];
    const deletedSet = new Set(deleted);
    const data = [];
    const newRows = [];
    const records = Array.isArray(payload.records) ? payload.records : [];
    records.forEach((record) => {
      validateHoldDates(record);
      const values = brokenPartsRecordToValues(record);
      const rowNumber = Number.parseInt(record.rowNumber, 10);
      if (rowNumber && !deletedSet.has(rowNumber) && rowNumber < originalLastRow + 1) {
        data.push(writeValueRangeForRow(ensured.sheet.title, rowNumber, values));
      } else if (!rowNumber) {
        newRows.push(values);
      }
    });
    if (data.length) await sheets.valuesBatchUpdate({ spreadsheetId: ensured.spreadsheetId, data, valueInputOption: "USER_ENTERED" });
    if (newRows.length) await appendValues(ensured.spreadsheetId, ensured.sheet.title, BROKEN_PARTS_HEADERS.length, newRows);
    if (deleted.length) await deleteRows(ensured.spreadsheetId, ensured.sheet.sheetId, deleted);
    await invalidateCompany(company);
    const refreshed = await readBrokenTable(company, { refresh: true, cache: false });
    return {
      success: true,
      saved: records.length,
      deleted: deleted.length,
      headers: (refreshed.values[0] || []).slice(0, BROKEN_PARTS_HEADERS.length),
      totalRows: Math.max(refreshed.values.length - 1, 0),
    };
  }

  async function bulkUpdateBrokenPartsRecords(payload) {
    const company = normalizeCompany(payload.company);
    const records = Array.isArray(payload.records) ? payload.records : [];
    if (!records.length) throw new Error("No records supplied");
    const requested = payload.changes || {};
    const allowed = new Set([
      "casino", "model", "brokenParts", "bpDesc", "bpColC", "bpQty",
      "bpRepairDay", "date", "bpRemark", "bpUodActivationDate",
      "bpUodUnlockDate", "bpUodUnlockDay", "bpHoldDate", "bpHoldReleaseDate",
    ]);
    const suppliedKeys = Object.keys(requested).filter((key) => text(requested[key]) !== "");
    const unsupported = suppliedKeys.find((key) => !allowed.has(key));
    if (unsupported) throw new Error(`Unsupported Broken Parts field: ${unsupported}`);
    if (!suppliedKeys.length) return { success: false, message: "No changes supplied" };

    const changes = {};
    suppliedKeys.forEach((key) => { changes[key] = requested[key]; });
    if (own(changes, "bpUodUnlockDay")) {
      changes.bpUodUnlockDate = changes.bpUodUnlockDay;
      delete changes.bpUodUnlockDay;
    }
    const normalizeDateChange = (key, waitingPattern = null) => {
      if (!own(changes, key)) return;
      const value = text(changes[key]);
      if (waitingPattern?.test(value)) {
        changes[key] = value;
        return;
      }
      const normalized = normalizeDateParam(value, config.timeZone);
      if (!normalized) throw new Error(`Invalid Broken Parts date: ${key}`);
      changes[key] = normalized;
    };
    normalizeDateChange("bpRepairDay", /^waiting$/i);
    normalizeDateChange("date");
    normalizeDateChange("bpUodActivationDate");
    normalizeDateChange("bpUodUnlockDate", /^wait for unlock$/i);
    normalizeDateChange("bpHoldDate");
    normalizeDateChange("bpHoldReleaseDate");
    if (own(changes, "model") && !["SAE", "TAE"].includes(text(changes.model).toUpperCase())) throw new Error("Invalid model");
    if (own(changes, "model")) changes.model = text(changes.model).toUpperCase();
    if (own(changes, "bpQty") && (!/^\d+$/.test(text(changes.bpQty)) || Number(changes.bpQty) < 1)) throw new Error("Invalid parts quantity");

    const table = await readBrokenTable(company, { refresh: true, cache: false });
    const seen = new Set();
    const targets = records.map((candidate) => {
      const rowNumber = Number.parseInt(candidate.rowNumber, 10);
      if (rowNumber < 2 || rowNumber > table.values.length || seen.has(rowNumber)) throw new Error("Invalid or duplicate Broken Parts row number");
      seen.add(rowNumber);
      const current = brokenPartsRecordFromRow(table.values[rowNumber - 1] || [], rowNumber, config.timeZone);
      const currentValues = brokenPartsRecordToValues(current).map(text);
      const candidateValues = brokenPartsRecordToValues(candidate).map(text);
      if (currentValues.some((value, index) => value !== candidateValues[index])) throw new Error("Broken Parts record changed; please reload");
      const after = { ...current, ...changes, rowNumber };
      if (own(changes, "bpUodUnlockDate")) after.bpUodUnlockDay = changes.bpUodUnlockDate;
      validateHoldDates(after);
      return { rowNumber, values: brokenPartsRecordToValues(after) };
    });
    const data = targets.map(({ rowNumber, values }) => writeValueRangeForRow(table.sheet.title, rowNumber, values));
    await sheets.valuesBatchUpdate({ spreadsheetId: table.spreadsheetId, data, valueInputOption: "USER_ENTERED" });
    await invalidateCompany(company);
    return { success: true, saved: targets.length };
  }

  async function updateMonthlySettings(payload) {
    const settings = payload.settings || {};
    const poNumber = text(settings.poNumber);
    if (!poNumber) throw new Error("Monthly PO number is required");
    const targetCells = { Venetian: "C4", Londoner: "C8", Parisian: "C12", Sands: "C16", Plaza: "C20" };
    const data = [{ range: `${quoteSheetName(MONTHLY_SHEET)}!B2`, values: [[poNumber]] }];
    for (const [venue, cell] of Object.entries(targetCells)) {
      const raw = text(settings.targets?.[venue]);
      if (!/^\d+$/.test(raw)) throw new Error(`${venue} target must be a non-negative integer`);
      data.push({ range: `${quoteSheetName(MONTHLY_SHEET)}!${cell}`, values: [[Number(raw)]] });
    }
    await sheets.valuesBatchUpdate({ spreadsheetId: config.sheets.SCL, data, valueInputOption: "USER_ENTERED" });
    await Promise.all([
      invalidateCache(db, memory, cacheAdapter, "monthly-settings", now),
      invalidateCache(db, memory, cacheAdapter, "monthly-base", now),
      invalidateCache(db, memory, cacheAdapter, "monthly-company:SCL", now),
      invalidateCache(db, memory, cacheAdapter, "monthly-all", now),
      invalidateCache(db, memory, cacheAdapter, "monthly-machine-counts", now),
    ]);
    return { success: true, settings: await readMonthlySettings({ refresh: true }) };
  }

  async function ensureBrokenPartsSchema() {
    const companies = [];
    for (const company of COMPANIES) {
      const ensured = await ensureBrokenTable(company);
      companies.push({ company, headers: BROKEN_PARTS_HEADERS.slice() });
      await invalidateCompany(company);
      void ensured;
    }
    return { success: true, companies };
  }

  async function updateBrokenRepairDays(repairs = []) {
    const grouped = new Map();
    for (const item of repairs) {
      const record = item?.record || {};
      const company = normalizeCompany(item?.company || record.company);
      if (!grouped.has(company)) grouped.set(company, []);
      grouped.get(company).push(record);
    }
    let repaired = 0;
    for (const [company, records] of grouped) {
      const table = await readBrokenTable(company, { refresh: true, cache: false });
      if (!table.sheet) throw new Error("Broken Parts List not found");
      const data = [];
      for (const record of records) {
        const rowNumber = Number.parseInt(record.rowNumber, 10);
        if (!rowNumber || rowNumber < 2 || rowNumber > table.values.length) throw new Error("Invalid Broken Parts List row");
        const row = table.values[rowNumber - 1] || [];
        if (text(arrayValue(row, 3)) !== text(record.serialNo) || text(arrayValue(row, 4)) !== text(record.brokenParts)) {
          throw new Error("Broken Parts List record changed; please reload");
        }
        data.push({ range: `${quoteSheetName(table.sheet.title)}!H${rowNumber}`, values: [[record.bpRepairDay || ""]] });
        repaired += 1;
      }
      if (data.length) await sheets.valuesBatchUpdate({ spreadsheetId: table.spreadsheetId, data, valueInputOption: "USER_ENTERED" });
      await invalidateCompany(company);
    }
    return repaired;
  }

  async function insertRecords(records, options = {}) {
    const list = Array.isArray(records) ? records : [records];
    const today = options.today || formatSheetDate(new Date(nowMs(now)), config.timeZone);
    const grouped = new Map();
    list.forEach((raw) => {
      const record = { ...(raw || {}) };
      validateIncomingRecord(record);
      const company = normalizeCompany(record.company);
      if (!grouped.has(company)) grouped.set(company, []);
      if (!text(record.submissionId)) record.submissionId = text(uuid());
      grouped.get(company).push(record);
    });
    let inserted = 0;
    let skipped = 0;
    const insertedSubmissionIds = [];
    const skippedSubmissionIds = [];
    for (const [company, companyRecords] of grouped) {
      const main = await mainRowsForCompany(company, { refresh: true, cache: false });
      const existing = new Set(main.rows.map((row) => text(arrayValue(row, main.idColumn))).filter(Boolean));
      const fresh = companyRecords.filter((record) => {
        const id = text(record.submissionId);
        if (existing.has(id)) {
          skipped += 1;
          skippedSubmissionIds.push(id);
          return false;
        }
        existing.add(id);
        insertedSubmissionIds.push(id);
        return true;
      });
      if (fresh.length) {
        const rows = fresh.map((record) => {
          const values = recordToValues({ ...record, date: record.date || today }, company);
          while (values.length < main.idColumn) values.push("");
          values[main.idColumn - 1] = text(record.submissionId);
          return values;
        });
        await appendValues(main.spreadsheetId, main.sheet.title, main.idColumn, rows);
        inserted += fresh.length;
      }
      const brokenRecords = companyRecords.filter(needsBrokenPartsWrite);
      if (brokenRecords.length) {
        const broken = await readBrokenTable(company, { refresh: true, cache: false });
        const existingBroken = new Set((broken.rows || []).map((row) => text(arrayValue(row, broken.idColumn))).filter(Boolean));
        const brokenRows = [];
        for (const record of brokenRecords) {
          const unlock = record.bpUodUnlockDate || record.bpUodUnlockDay || "";
          if (!record.brokenParts && !record.bpUodActivationDate && !unlock && !record.bpHoldDate && !record.bpHoldReleaseDate) continue;
          if (existingBroken.has(text(record.submissionId))) continue;
          const values = brokenPartsRecordToValues({ ...record, date: record.date || today });
          while (values.length < broken.idColumn) values.push("");
          values[broken.idColumn - 1] = text(record.submissionId);
          brokenRows.push(values);
          existingBroken.add(text(record.submissionId));
        }
        if (brokenRows.length) await appendValues(broken.spreadsheetId, broken.sheet.title, broken.idColumn, brokenRows);
      }
      await invalidateCompany(company);
    }
    return {
      success: true,
      inserted,
      skipped,
      acknowledged: list.length,
      insertedSubmissionIds,
      skippedSubmissionIds,
    };
  }

  async function postAction(payload = {}) {
    if (!Array.isArray(payload)) {
      const cvcsResult = await getCvcsRepository().postAction(payload);
      if (cvcsResult) return cvcsResult;
    }
    if (!Array.isArray(payload) && payload.action === "updateRecord") return updateRecord(payload);
    if (!Array.isArray(payload) && payload.action === "deleteRecord") return deleteRecord(payload);
    if (!Array.isArray(payload) && payload.action === "bulkDeleteRecords") return bulkDeleteRecords(payload);
    if (!Array.isArray(payload) && payload.action === "updateTemplate") return updateTemplate(payload);
    if (!Array.isArray(payload) && payload.action === "updateBrokenPartsList") return updateBrokenPartsList(payload);
    if (!Array.isArray(payload) && payload.action === "bulkUpdateBrokenPartsRecords") return bulkUpdateBrokenPartsRecords(payload);
    if (!Array.isArray(payload) && payload.action === "ensureBrokenPartsSchema") return ensureBrokenPartsSchema();
    if (!Array.isArray(payload) && payload.action === "updateMonthlySettings") return updateMonthlySettings(payload);
    if (!Array.isArray(payload) && payload.action === "updateScheduleRemark") return updateScheduleRemark(payload);
    if (!Array.isArray(payload) && payload.action === "bulkUpdateRecords") return bulkUpdateRecords(payload);
    if (!Array.isArray(payload) && payload.action === "submitRecords") {
      const repaired = await updateBrokenRepairDays(payload.brokenPartsRepairs || []);
      const result = await insertRecords(payload.records || [], payload);
      result.repaired = repaired;
      return result;
    }
    return insertRecords(payload);
  }

  async function findSubmissionIds(items = []) {
    const cvcsItems = items.filter((item) => /^cvcs(?:-broken)?$/i.test(text(item.company)));
    const regularItems = items.filter((item) => !/^cvcs(?:-broken)?$/i.test(text(item.company)));
    const groups = new Map();
    regularItems.forEach((item) => {
      const company = normalizeCompany(item.company);
      if (!groups.has(company)) groups.set(company, []);
      groups.get(company).push(text(item.submissionId));
    });
    const found = {};
    if (cvcsItems.length) Object.assign(found, await getCvcsRepository().findSubmissionIds(cvcsItems));
    for (const [company, ids] of groups) {
      const main = await mainRowsForCompany(company, { refresh: true, cache: false, ensureIdentity: false });
      const wanted = new Set(ids.filter(Boolean));
      main.rows.forEach((row) => {
        const id = text(arrayValue(row, main.idColumn));
        if (id && wanted.has(id)) found[id] = { company, rowNumber: main.rows.indexOf(row) + 2 };
      });
    }
    return found;
  }

  async function invalidateCompany(company) {
    const normalized = normalizeCompany(company);
    await Promise.all([
      invalidateCache(db, memory, cacheAdapter, `main:${normalized}`, now),
      invalidateCache(db, memory, cacheAdapter, `broken:${normalized}`, now),
      invalidateCache(db, memory, cacheAdapter, `monthly-company:${normalized}`, now),
      invalidateCache(db, memory, cacheAdapter, "monthly-base", now),
      invalidateCache(db, memory, cacheAdapter, "monthly-all", now),
      invalidateCache(db, memory, cacheAdapter, "monthly-machine-counts", now),
    ]);
  }

  return {
    config,
    db,
    sheets,
    getAction,
    postAction,
    getDashboard,
    getToday,
    getDuplicateFaults,
    getBrokenParts,
    monthlyBase,
    monthlyCompany,
    monthlySubset,
    scheduleOverview,
    updateScheduleRemark,
    findSubmissionIds,
    invalidateCompany,
    readMainTable,
    readBrokenTable,
  };
}
