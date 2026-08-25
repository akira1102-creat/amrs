import {
  BROKEN_PARTS_HEADERS,
  COMPANIES,
  DEFAULT_COMPANY,
  WORKSHEET_NAME,
  companySchema,
  normalizeCompany,
} from "./config.mjs";

export const DEFAULT_TIME_ZONE = "Asia/Hong_Kong";
export const BROKEN_PARTS_WIDTH = BROKEN_PARTS_HEADERS.length;

export const MONTHLY_VENUES = {
  Melco: ["ALT", "COD", "SC"],
  MGM: ["MGM Macau", "MGM Cotai"],
  SJM: ["Lisboa", "Grand Lisboa", "Grand Lisboa Palace", "Oceanus", "Jai Alai", "L’Arc"],
  SCL: ["Venetian", "Londoner", "Parisian", "Sands", "Plaza"],
  GEG: ["Galaxy", "StarWorld"],
  Wynn: ["Wynn", "Wynn Palace"],
};

export const SCL_MONTHLY_TARGET_CELLS = {
  Venetian: "C4",
  Londoner: "C8",
  Parisian: "C12",
  Sands: "C16",
  Plaza: "C20",
};

export const GEG_MONTHLY_TARGETS = { Galaxy: 421, StarWorld: 129 };

export const SCHEDULE_VENUE_ALIASES = {
  "GRAND LISBOA PALACE": "Grand Lisboa Palace",
  "MGM COTAI": "MGM Cotai",
  "WYNN PALACE": "Wynn Palace",
  "WYNN MACAU": "Wynn",
  "GRAND LISBOA": "Grand Lisboa",
  "JAI ALAI": "Jai Alai",
  "LONDONER": "Londoner",
  "VENETIAN": "Venetian",
  "PARISIAN": "Parisian",
  "STARWORLD": "StarWorld",
  "OCEANUS": "Oceanus",
  "LISBOA": "Lisboa",
  "SANDS": "Sands",
  "PLAZA": "Plaza",
  "GALAXY": "Galaxy",
  "MGM MACAU": "MGM Macau",
  LON: "Londoner",
  VML: "Venetian",
  PAR: "Parisian",
  PLZ: "Plaza",
  SM: "Sands",
  MGM: "MGM Macau",
  MGMC: "MGM Cotai",
  COD: "COD",
  ALT: "ALT",
  SC: "SC",
  SW: "StarWorld",
  GX: "Galaxy",
  GL: "Grand Lisboa",
  GLP: "Grand Lisboa Palace",
  WYNN: "Wynn",
  WP: "Wynn Palace",
  OCN: "Oceanus",
  "L'ARC": "L’Arc",
};

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function pad2(value) {
  return String(value).padStart(2, "0");
}

function gasString(value) {
  return String(value || "");
}

function rowValue(row, index) {
  return Array.isArray(row) && row[index] != null ? row[index] : "";
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function timeZoneOf(value) {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && value.timeZone) return value.timeZone;
  return DEFAULT_TIME_ZONE;
}

function datePartsInZone(date, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
  };
}

function formatDateInZone(date, timeZone = DEFAULT_TIME_ZONE, compact = false) {
  const parts = datePartsInZone(date, timeZone);
  return [String(parts.year), compact ? String(parts.month) : pad2(parts.month), compact ? String(parts.day) : pad2(parts.day)].join("/");
}

function formatIsoDateInZone(date, timeZone = DEFAULT_TIME_ZONE) {
  const parts = datePartsInZone(date, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function daysInMonth(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validCalendarDate(year, month, day) {
  return year >= 0 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function utcCalendarDate(year, month, day) {
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

export function normalizeDateParam(value, options = DEFAULT_TIME_ZONE) {
  const timeZone = timeZoneOf(options);
  if (!value) return "";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : formatDateInZone(value, timeZone);
  }
  const match = String(value).trim().match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!validCalendarDate(year, month, day)) return "";
  return `${String(year)}/${pad2(month)}/${pad2(day)}`;
}

export function formatSheetDate(value, options = DEFAULT_TIME_ZONE) {
  const timeZone = timeZoneOf(options);
  return value instanceof Date
    ? (Number.isNaN(value.getTime()) ? "" : formatDateInZone(value, timeZone))
    : normalizeDateParam(value, timeZone);
}

export function brokenPartsDate(value, options = DEFAULT_TIME_ZONE) {
  const timeZone = timeZoneOf(options);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : formatDateInZone(value, timeZone, true);
  const text = gasString(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return formatDateInZone(parsed, timeZone, true);
  }
  return text;
}

export function isGegCompany(company) {
  return normalizeCompany(company) === "GEG";
}

export function isMgmCompany(company) {
  return normalizeCompany(company) === "MGM";
}

export function isWynnCompany(company) {
  return normalizeCompany(company) === "Wynn";
}

export function getRecordWidth(company) {
  return companySchema(company).width;
}

export function getInspectorColumn(company) {
  return companySchema(company).inspectorIndex + 1;
}

export function recordFromRow(row, rowDate, rowNumber, company, recordId = "") {
  const normalizedCompany = normalizeCompany(company);
  if (isGegCompany(normalizedCompany)) {
    return {
      rowNumber,
      recordId: recordId || "",
      company: "GEG",
      casino: rowValue(row, 0),
      date: rowDate ?? "",
      poNumber: rowValue(row, 2),
      model: rowValue(row, 3),
      serialNo: rowValue(row, 4),
      voidSeal: rowValue(row, 5),
      newVoidSeal: rowValue(row, 6),
      reason: rowValue(row, 7),
      actionTaken: rowValue(row, 8),
      errorDescription: rowValue(row, 9),
      boxId: rowValue(row, 10),
      inspector: rowValue(row, 11),
    };
  }
  const record = {
    rowNumber,
    recordId: recordId || "",
    company: normalizedCompany,
    casino: rowValue(row, 0),
    date: rowDate ?? "",
    poNumber: rowValue(row, 2),
    model: rowValue(row, 3),
    serialNo: rowValue(row, 4),
    reason: rowValue(row, 5),
    actionTaken: rowValue(row, 6),
    errorDescription: rowValue(row, 7),
    boxId: rowValue(row, 8),
    inspector: rowValue(row, 9),
  };
  if (isMgmCompany(normalizedCompany)) record.location = rowValue(row, 10);
  return record;
}

function calendarOrdinal(value, timeZone = DEFAULT_TIME_ZONE) {
  const normalized = normalizeDateParam(value, timeZone);
  if (!normalized) return null;
  const [year, month, day] = normalized.split("/").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function getDuplicateFaultsFromRows(rows, params = {}) {
  const timeZone = timeZoneOf(params.timeZone);
  const reason = gasString(params.reason).trim();
  if (!reason || reason.toUpperCase() === "PM") return {};
  const serialNos = new Set((Array.isArray(params.serialNos) ? params.serialNos : gasString(params.serialNos).split(","))
    .map((value) => gasString(value).trim())
    .filter(Boolean));
  if (!serialNos.size) return {};
  const endOrdinal = calendarOrdinal(params.date, timeZone);
  if (endOrdinal == null) return {};
  const targetReason = reason.toUpperCase();
  const counts = {};
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const serialNo = gasString(rowValue(row, 4)).trim();
    if (!serialNos.has(serialNo)) return;
    const rowReason = gasString(rowValue(row, normalizeCompany(params.company) === "GEG" ? 7 : 5)).trim();
    if (rowReason.toUpperCase() !== targetReason || rowReason.toUpperCase() === "PM") return;
    const rowOrdinal = calendarOrdinal(rowValue(row, 1), timeZone);
    if (rowOrdinal == null || rowOrdinal <= endOrdinal - 30 || rowOrdinal > endOrdinal) return;
    counts[serialNo] = (counts[serialNo] || 0) + 1;
  });
  return counts;
}

export function recordToValues(record, company) {
  const value = record || {};
  const common = [
    value.casino || "",
    normalizeDateParam(value.date || "") || value.date || "",
    value.poNumber || "",
    value.model || "",
    value.serialNo || "",
  ];
  if (isGegCompany(company)) {
    return common.concat([
      value.voidSeal || "",
      value.newVoidSeal || "",
      value.reason || "",
      value.actionTaken || "",
      value.errorDescription || "",
      value.boxId || "",
      value.inspector || "",
    ]);
  }
  const values = common.concat([
    value.reason || "",
    value.actionTaken || "",
    value.errorDescription || "",
    value.boxId || "",
    value.inspector || "",
  ]);
  if (isMgmCompany(company)) values.push(value.location || "");
  return values;
}

export function recordsMatch(current, original, company) {
  if (!original) return true;
  let fields = ["casino", "date", "poNumber", "model", "serialNo", "reason", "actionTaken", "errorDescription", "boxId"];
  if (isGegCompany(company)) fields = fields.concat(["voidSeal", "newVoidSeal"]);
  if (isMgmCompany(company)) fields.push("location");
  fields.push("inspector");
  return fields.every((key) => {
    const left = key === "date"
      ? normalizeDateParam(current?.[key] || "")
      : String(current?.[key] == null ? "" : current[key]).trim();
    const right = key === "date"
      ? normalizeDateParam(original?.[key] || "")
      : String(original?.[key] == null ? "" : original[key]).trim();
    return left === right;
  });
}

export function mergeRecord(original, changes) {
  const merged = {};
  Object.keys(original || {}).forEach((key) => { merged[key] = original[key]; });
  Object.keys(changes || {}).forEach((key) => {
    if (key !== "rowNumber" && key !== "company") merged[key] = changes[key];
  });
  merged.rowNumber = original?.rowNumber;
  merged.company = original?.company;
  return merged;
}

export function editedFieldChanged(key, original, changes) {
  if (!changes || !own(changes, key)) return false;
  const before = original ? original[key] : "";
  const after = changes[key];
  if (key === "date") return normalizeDateParam(before || "") !== normalizeDateParam(after || "");
  return String(before == null ? "" : before).trim() !== String(after == null ? "" : after).trim();
}

export function validatePoNumber(value) {
  const poNumber = gasString(value).trim();
  if (poNumber.length > 100) throw new Error("PO/month number must be 100 characters or fewer");
  if (/[\u0000-\u001F\u007F]/.test(poNumber)) throw new Error("PO/month number contains invalid characters");
}

export function validateHoldDates(record = {}) {
  const holdDate = gasString(record.bpHoldDate).trim();
  const holdReleaseDate = gasString(record.bpHoldReleaseDate).trim();
  const normalizedHoldDate = holdDate ? normalizeDateParam(holdDate) : "";
  const normalizedReleaseDate = holdReleaseDate ? normalizeDateParam(holdReleaseDate) : "";
  if (holdDate && !normalizedHoldDate) throw new Error("Invalid hold date");
  if (holdReleaseDate && !normalizedReleaseDate) throw new Error("Invalid hold release date");
  if (normalizedReleaseDate && !normalizedHoldDate) throw new Error("Hold date is required before release");
  if (normalizedReleaseDate && normalizedReleaseDate < normalizedHoldDate) throw new Error("Hold release date cannot be earlier than hold date");
}

export function validateIncomingRecord(record = {}) {
  const serialNo = gasString(record.serialNo).trim();
  const poNumber = gasString(record.poNumber).trim();
  const date = normalizeDateParam(record.date || "");
  if (!record.casino) throw new Error("Missing casino");
  if (!/^\d{1,4}$/.test(serialNo)) throw new Error("Serial No. must be 1-4 digits");
  validatePoNumber(poNumber);
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) throw new Error("Invalid date");
  if (!["SAE", "TAE"].includes(String(record.model || "").toUpperCase())) throw new Error("Invalid model");
  if (!gasString(record.reason).trim()) throw new Error("Missing reason");
  if (record.voidSeal && !/^\d{5}$/.test(String(record.voidSeal))) throw new Error("Void Seal must be 5 digits");
  if (record.location && !["Floor", "Workshop"].includes(String(record.location))) throw new Error("Invalid MGM location");
  if (record.bpQty && (!/^\d+$/.test(String(record.bpQty)) || Number(record.bpQty) < 1)) throw new Error("Invalid parts quantity");
  const activationDate = gasString(record.bpUodActivationDate).trim();
  if (activationDate && !normalizeDateParam(activationDate)) throw new Error("Invalid UOD activation date");
  const unlockDate = gasString(record.bpUodUnlockDate || record.bpUodUnlockDay).trim();
  if (unlockDate && !/^wait for unlock$/i.test(unlockDate) && !normalizeDateParam(unlockDate)) throw new Error("Invalid UOD unlock date");
  validateHoldDates(record);
}

export function validateEditedRecord(record = {}, original = {}, changes = {}) {
  if (editedFieldChanged("serialNo", original, changes) && !/^\d{1,4}$/.test(gasString(record.serialNo).trim())) throw new Error("Serial No. must be 1-4 digits");
  if (editedFieldChanged("date", original, changes) && !/^\d{4}\/\d{2}\/\d{2}$/.test(normalizeDateParam(record.date || ""))) throw new Error("Invalid date");
  if (editedFieldChanged("model", original, changes) && !["SAE", "TAE"].includes(String(record.model || "").toUpperCase())) throw new Error("Invalid model");
  if (editedFieldChanged("reason", original, changes) && !gasString(record.reason).trim()) throw new Error("Missing reason");
  if (editedFieldChanged("voidSeal", original, changes) && record.voidSeal && !/^\d{5}$/.test(String(record.voidSeal))) throw new Error("Void Seal must be 5 digits");
  if (editedFieldChanged("location", original, changes) && record.location && !["Floor", "Workshop"].includes(String(record.location))) throw new Error("Invalid MGM location");
  if (editedFieldChanged("poNumber", original, changes)) validatePoNumber(changes.poNumber);
}

export function partsCodesFromRows(rows = []) {
  const result = [];
  rows.forEach((row) => {
    const code = gasString(rowValue(row, 0)).trim();
    const desc = gasString(rowValue(row, 1)).trim();
    const colC = gasString(rowValue(row, 2)).trim();
    if (!code) return;
    result.push({ code, label: `${code} ${desc}`, desc, colC });
  });
  return result;
}

export function isBrokenPartsHeader(row) {
  return gasString(rowValue(row, 2)).trim().toLowerCase() === "serial no.";
}

export function brokenPartsRecordFromRow(row, rowNumber, options = DEFAULT_TIME_ZONE) {
  return {
    rowNumber,
    casino: rowValue(row, 0),
    model: rowValue(row, 1),
    serialNo: rowValue(row, 2),
    brokenParts: rowValue(row, 3),
    bpDesc: rowValue(row, 4),
    bpColC: rowValue(row, 5),
    bpQty: rowValue(row, 6),
    bpRepairDay: brokenPartsDate(rowValue(row, 7), options),
    date: brokenPartsDate(rowValue(row, 8), options),
    bpRemark: rowValue(row, 9),
    bpUodActivationDate: brokenPartsDate(rowValue(row, 10), options),
    bpUodUnlockDay: brokenPartsDate(rowValue(row, 11), options),
    bpUodUnlockDate: brokenPartsDate(rowValue(row, 11), options),
    bpHoldDate: brokenPartsDate(rowValue(row, 12), options),
    bpHoldReleaseDate: brokenPartsDate(rowValue(row, 13), options),
  };
}

export function brokenPartsRecordToValues(record = {}) {
  return [
    record.casino || "",
    record.model || "",
    record.serialNo || "",
    record.brokenParts || "",
    record.bpDesc || "",
    record.bpColC || "",
    record.bpQty || "",
    record.bpRepairDay || "",
    record.date || "",
    record.bpRemark || "",
    record.bpUodActivationDate || "",
    // The editor historically used bpUodUnlockDay while API records may use
    // bpUodUnlockDate. Prefer the editor value when both aliases are present.
    record.bpUodUnlockDay || record.bpUodUnlockDate || "",
    record.bpHoldDate || "",
    record.bpHoldReleaseDate || "",
  ];
}

function normalizedBrokenPartsArgs(rows, serialNo, filters) {
  if (rows && !Array.isArray(rows) && Array.isArray(rows.rows)) {
    return {
      rows: rows.rows,
      serialNo: rows.serialNo ?? "",
      filters: rows.filters || rows,
      options: rows.options || {},
    };
  }
  if (!Array.isArray(rows)) return { rows: [], serialNo: "", filters: {}, options: {} };
  if (serialNo && typeof serialNo === "object") return { rows, serialNo: serialNo.serialNo || "", filters: serialNo, options: filters || {} };
  return { rows, serialNo: serialNo || "", filters: filters || {}, options: {} };
}

function brokenPartStatus(row) {
  const repairDay = brokenPartsDate(rowValue(row, 7));
  const hasPart = !!gasString(rowValue(row, 3)).trim();
  const uodUnlockDate = brokenPartsDate(rowValue(row, 11));
  const holdDate = brokenPartsDate(rowValue(row, 12));
  const holdReleaseDate = brokenPartsDate(rowValue(row, 13));
  return {
    waiting: hasPart && (!gasString(repairDay).trim() || /^waiting$/i.test(gasString(repairDay).trim())),
    repaired: hasPart && !(!gasString(repairDay).trim() || /^waiting$/i.test(gasString(repairDay).trim())),
    uodWaiting: /^wait for unlock$/i.test(gasString(uodUnlockDate).trim()),
    uodUnlocked: !!gasString(uodUnlockDate).trim() && !/^wait for unlock$/i.test(gasString(uodUnlockDate).trim()),
    holding: !!gasString(holdDate).trim() && !gasString(holdReleaseDate).trim(),
    holdReleased: !!gasString(holdDate).trim() && !!gasString(holdReleaseDate).trim(),
  };
}

export function brokenPartsRecordsFromRows(rows = [], serialNo = "", filters = {}, options = {}) {
  const filterSn = gasString(serialNo).trim();
  const filterCasino = gasString(filters.casino).trim();
  const filterParts = gasString(filters.partsNo).trim().toLowerCase();
  let filterStatus = gasString(filters.status).trim().toLowerCase();
  const allowedStatuses = ["waiting", "repaired", "uod-waiting", "uod-unlocked", "holding", "hold-released"];
  if (!allowedStatuses.includes(filterStatus)) filterStatus = "";
  const startRow = Number.isFinite(Number(options.startRow)) ? Number(options.startRow) : 1;
  const result = [];
  rows.forEach((row, index) => {
    if (isBrokenPartsHeader(row)) return;
    if (row.every((value) => value === "" || value == null)) return;
    if (filterSn && gasString(rowValue(row, 2)).trim() !== filterSn) return;
    if (filterCasino && gasString(rowValue(row, 0)).trim() !== filterCasino) return;
    if (filterParts && !gasString(rowValue(row, 3)).toLowerCase().includes(filterParts)) return;
    const status = brokenPartStatus(row);
    if (filterStatus === "waiting" && !status.waiting) return;
    if (filterStatus === "repaired" && !status.repaired) return;
    if (filterStatus === "uod-waiting" && !status.uodWaiting) return;
    if (filterStatus === "uod-unlocked" && !status.uodUnlocked) return;
    if (filterStatus === "holding" && !status.holding) return;
    if (filterStatus === "hold-released" && !status.holdReleased) return;
    result.push(brokenPartsRecordFromRow(row, startRow + index));
  });
  return result;
}

export function getBrokenPartsRecords(rows, serialNo = "", filters = {}) {
  const args = normalizedBrokenPartsArgs(rows, serialNo, filters);
  return brokenPartsRecordsFromRows(args.rows, args.serialNo, args.filters, args.options);
}

function pageNumber(value, fallback) {
  return Number.parseInt(value || String(fallback), 10) || fallback;
}

export function getBrokenPartsPage(rows, serialNo = "", filters = {}) {
  const args = normalizedBrokenPartsArgs(rows, serialNo, filters);
  const effectiveFilters = args.filters;
  const records = brokenPartsRecordsFromRows(args.rows, args.serialNo, effectiveFilters, args.options);
  const sort = gasString(effectiveFilters.sort || "newest").toLowerCase() === "oldest" ? "oldest" : "newest";
  records.sort((left, right) => sort === "oldest"
    ? Number(left.rowNumber || 0) - Number(right.rowNumber || 0)
    : Number(right.rowNumber || 0) - Number(left.rowNumber || 0));
  const pageSize = Math.min(Math.max(pageNumber(effectiveFilters.pageSize, 10), 1), 100);
  const totalMatches = records.length;
  const totalPages = Math.max(1, Math.ceil(totalMatches / pageSize));
  const requestedPage = Math.max(pageNumber(effectiveFilters.page, 1), 1);
  const page = Math.min(requestedPage, totalPages);
  const offset = (requestedPage - 1) * pageSize;
  return {
    success: true,
    records: records.slice(offset, offset + pageSize),
    page,
    pageSize,
    totalMatches,
    totalPages,
    sort,
  };
}

export function incrementCount(map, value) {
  const key = gasString(value).trim();
  if (key) map[key] = (map[key] || 0) + 1;
}

export function topCounts(map, limit = 5, minCount = 1) {
  return Object.keys(map || {})
    .map((key) => ({ label: key, count: map[key] }))
    .filter((item) => item.count >= (minCount || 1))
    .sort((left, right) => right.count - left.count || String(left.label).localeCompare(String(right.label)))
    .slice(0, limit || 5);
}

export function getBrokenPartsStats(rows, filters = {}) {
  if (rows && !Array.isArray(rows) && Array.isArray(rows.rows)) {
    filters = rows.filters || rows;
    rows = rows.rows;
  }
  const safeRows = Array.isArray(rows) ? rows : [];
  const records = brokenPartsRecordsFromRows(safeRows, filters.serialNo || "", {});
  const counts = {};
  const filtered = records.filter((record) => {
    if (filters.casino && String(record.casino) !== filters.casino) return false;
    if (filters.model && String(record.model || "").toUpperCase() !== filters.model) return false;
    const date = normalizeDateParam(record.date || "");
    if (filters.from && date < filters.from) return false;
    if (filters.to && date > filters.to) return false;
    incrementCount(counts, record.brokenParts);
    return true;
  });
  return { records: filtered.slice(-20).reverse(), topParts: topCounts(counts, 5) };
}

function normalizedDashboardArgs(rows, params, options) {
  if (rows && !Array.isArray(rows) && Array.isArray(rows.rows)) {
    return { rows: rows.rows, params: rows.params || rows, options: rows.options || {} };
  }
  return { rows: Array.isArray(rows) ? rows : [], params: params || {}, options: options || {} };
}

function lookupRecordId(recordIds, rowNumber, index) {
  if (!recordIds) return "";
  if (Array.isArray(recordIds)) return gasString(recordIds[rowNumber] ?? recordIds[index] ?? "").trim();
  return gasString(recordIds[rowNumber] ?? recordIds[String(rowNumber)] ?? "").trim();
}

export function getDashboardRecords(rows, params = {}, options = {}) {
  const args = normalizedDashboardArgs(rows, params, options);
  const safeParams = args.params;
  const opts = args.options;
  const company = normalizeCompany(safeParams.company);
  const timeZone = timeZoneOf(opts.timeZone || DEFAULT_TIME_ZONE);
  const casino = gasString(safeParams.casino).trim();
  const model = gasString(safeParams.model).trim().toUpperCase();
  const query = gasString(safeParams.q).trim().toLowerCase();
  const serialNo = gasString(safeParams.serialNo).trim();
  const sort = gasString(safeParams.sort || "newest").toLowerCase() === "oldest" ? "oldest" : "newest";
  const from = normalizeDateParam(safeParams.from || "", timeZone);
  const to = normalizeDateParam(safeParams.to || "", timeZone);
  const pageSize = Math.min(Math.max(pageNumber(safeParams.pageSize, 10), 1), 100);
  const requestedPage = Math.max(pageNumber(safeParams.page, 1), 1);
  const startRow = Number.isFinite(Number(opts.startRow)) ? Number(opts.startRow) : 2;
  const idColumn = Number(opts.idColumn) || 0;
  const orderedRows = args.rows.map((row, index) => ({ row, rowNumber: startRow + index })).reverse();
  if (sort === "oldest") orderedRows.reverse();
  const records = [];
  let totalMatches = 0;
  const modelCounts = {};
  const reasonCounts = {};
  const casinoCounts = {};
  const serialCounts = {};
  let latestDate = "";
  const offset = (requestedPage - 1) * pageSize;
  orderedRows.forEach(({ row, rowNumber }, index) => {
    if (!rowValue(row, 1)) return;
    const rowDate = formatSheetDate(rowValue(row, 1), timeZone);
    if (casino && rowValue(row, 0) !== casino) return;
    if (model && gasString(rowValue(row, 3)).trim().toUpperCase() !== model) return;
    if (from && rowDate < from) return;
    if (to && rowDate > to) return;
    const recordId = idColumn
      ? gasString(rowValue(row, idColumn - 1)).trim()
      : lookupRecordId(opts.recordIds, rowNumber, index);
    const record = recordFromRow(row, rowDate, rowNumber, company, recordId);
    if (serialNo && gasString(record.serialNo).trim() !== serialNo) return;
    if (query && [
      record.casino, record.date, record.poNumber, record.model, record.serialNo,
      record.voidSeal, record.newVoidSeal, record.location, record.inspector,
      record.reason, record.actionTaken, record.errorDescription, record.boxId,
    ].join(" ").toLowerCase().indexOf(query) === -1) return;
    incrementCount(modelCounts, record.model);
    incrementCount(reasonCounts, record.reason);
    incrementCount(casinoCounts, record.casino);
    incrementCount(serialCounts, record.serialNo);
    if (!latestDate || record.date > latestDate) latestDate = record.date;
    if (totalMatches >= offset && records.length < pageSize) records.push(record);
    totalMatches += 1;
  });
  const totalPages = Math.max(1, Math.ceil(totalMatches / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const includeParts = String(safeParams.includeParts || "1") !== "0";
  const brokenStats = serialNo && includeParts
    ? (opts.brokenStats || getBrokenPartsStats(opts.brokenPartsRows || [], { casino, model, serialNo, from, to }))
    : { records: [] };
  return {
    success: true,
    records,
    returned: records.length,
    totalMatches,
    totalPages,
    page,
    pageSize,
    sort,
    totalRows: opts.totalRows ?? args.rows.length,
    stats: {
      total: totalMatches,
      models: modelCounts,
      topReasons: topCounts(reasonCounts, 5),
      topCasinos: topCounts(casinoCounts, 5),
      repeatSerials: topCounts(serialCounts, 5, 2),
    },
    history: serialNo ? {
      serialNo,
      total: totalMatches,
      latestDate,
      casinos: Object.keys(casinoCounts),
      topReasons: topCounts(reasonCounts, 5),
      parts: includeParts ? brokenStats.records : null,
    } : null,
  };
}

export function normalizeAaTag(value) {
  const digits = gasString(value).trim().replace(/^TAE/i, "").replace(/\D/g, "").slice(0, 4);
  return digits ? `TAE${digits.padStart(4, "0")}` : "";
}

export function aaTagsFromRows(rows = []) {
  const result = [];
  rows.forEach((row, index) => {
    const serialNo = gasString(rowValue(row, 0)).trim();
    const aaTag = normalizeAaTag(rowValue(row, 1));
    if (index === 0 && /serial|機身/i.test(serialNo)) return;
    if (!/^\d{1,4}$/.test(serialNo) || !aaTag) return;
    result.push({ serialNo, aaTag });
  });
  return result;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scheduleVenueEntriesInText(value) {
  const text = gasString(value).trim().replace(/[’ʼ`´]/g, "'").toUpperCase();
  if (!text) return [];
  const entriesByVenue = {};
  const venueOrder = [];
  Object.keys(SCHEDULE_VENUE_ALIASES)
    .sort((left, right) => right.length - left.length)
    .forEach((alias) => {
      const matcher = new RegExp(`(^|[^A-Z0-9])(${escapeRegExp(alias)})(?=$|[^A-Z0-9])`, "g");
      let match;
      while ((match = matcher.exec(text))) {
        const venue = SCHEDULE_VENUE_ALIASES[alias];
        const aliasEnd = match.index + match[1].length + match[2].length;
        const excluded = /^\s*\*/.test(text.slice(aliasEnd));
        if (!entriesByVenue[venue]) {
          entriesByVenue[venue] = { venue, machineCountExcluded: excluded };
          venueOrder.push(venue);
        } else {
          entriesByVenue[venue].machineCountExcluded = entriesByVenue[venue].machineCountExcluded && excluded;
        }
      }
    });
  return venueOrder.map((venue) => entriesByVenue[venue]);
}

export function scheduleAliasesInText(value) {
  return scheduleVenueEntriesInText(value).map((entry) => entry.venue);
}

export function scheduleVenueLink(venue) {
  for (const company of Object.keys(MONTHLY_VENUES)) {
    if (MONTHLY_VENUES[company].includes(venue)) return { company, venue };
  }
  return null;
}

export function parseScheduleOverviewDate(value, now = new Date(), options = DEFAULT_TIME_ZONE) {
  const timeZone = timeZoneOf(options);
  const normalized = normalizeDateParam(value || formatSheetDate(now, timeZone), timeZone);
  if (!normalized) throw new Error("Invalid schedule date");
  const [year, month, day] = normalized.split("/").map(Number);
  if (!validCalendarDate(year, month, day)) throw new Error("Invalid schedule date");
  return utcCalendarDate(year, month, day);
}

export function scheduleIsoDate(date, options = DEFAULT_TIME_ZONE) {
  return formatIsoDateInZone(date, timeZoneOf(options));
}

export function scheduleMonthCode(date, options = DEFAULT_TIME_ZONE) {
  const parts = datePartsInZone(date, timeZoneOf(options));
  return `${pad2(parts.year % 100)}${pad2(parts.month)}`;
}

function scheduleTable(value) {
  if (Array.isArray(value)) return { headers: value[0] || [], rows: value.slice(1) };
  if (value && Array.isArray(value.values)) return scheduleTable(value.values);
  return { headers: value?.headers || [], rows: value?.rows || [] };
}

function mapValue(container, key) {
  if (container instanceof Map) return container.get(key);
  return container?.[key];
}

function addUtcDays(date, count) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + count);
  return next;
}

export function scheduleRemarkColumns(headers = []) {
  const normalized = (Array.isArray(headers) ? headers : []).map((header) => gasString(header).trim().toLowerCase());
  const markerColumns = normalized
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => header === "marco")
    .map(({ index }) => index);
  const amStart = markerColumns.length >= 2 ? markerColumns[0] : 1;
  const pmStart = markerColumns.length >= 2 ? markerColumns[1] : 12;
  const ranges = {
    am: { start: amStart, end: Math.max(amStart, pmStart) },
    pm: { start: pmStart, end: normalized.length },
  };
  const findRemark = ({ start, end }) => {
    for (let column = start; column < end; column += 1) {
      if (normalized[column] === "remark" || normalized[column].startsWith("remark ")) return column;
    }
    return -1;
  };
  return {
    am: { start: ranges.am.start, end: ranges.am.end, remark: findRemark(ranges.am) },
    pm: { start: ranges.pm.start, end: ranges.pm.end, remark: findRemark(ranges.pm) },
  };
}

export function scheduleOverviewFromRows(params = {}, scheduleSheets = {}) {
  if (params && params.params && params.scheduleSheets) {
    scheduleSheets = params.scheduleSheets;
    params = params.params;
  }
  const fromDate = parseScheduleOverviewDate(params.from, params.now || new Date(), params.timeZone || DEFAULT_TIME_ZONE);
  const daysCount = Math.min(Math.max(pageNumber(params.days, 7), 1), 45);
  const from = scheduleIsoDate(fromDate, params.timeZone || DEFAULT_TIME_ZONE);
  const requestedDates = [];
  const monthCodes = {};
  for (let offset = 0; offset < daysCount; offset += 1) {
    const date = addUtcDays(fromDate, offset);
    const dayOfWeek = date.getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;
    const iso = scheduleIsoDate(date, params.timeZone || DEFAULT_TIME_ZONE);
    const monthCode = scheduleMonthCode(date, params.timeZone || DEFAULT_TIME_ZONE);
    requestedDates.push({ date: iso, day: date.getUTCDate(), monthCode, items: [], remarks: { am: "", pm: "" } });
    monthCodes[monthCode] = true;
  }
  const missingSheets = [];
  Object.keys(monthCodes).forEach((monthCode) => {
    const tableValue = mapValue(scheduleSheets, monthCode);
    if (tableValue == null) {
      missingSheets.push(scheduleSheetName(monthCode).toUpperCase());
      return;
    }
    const { headers, rows } = scheduleTable(tableValue);
    const wantedDays = {};
    requestedDates.forEach((item) => {
      if (item.monthCode === monthCode) wantedDays[item.day] = item;
    });
    const shiftRanges = scheduleRemarkColumns(headers);
    rows.forEach((row) => {
      const day = Number(gasString(rowValue(row, 0)).trim());
      const dayResult = wantedDays[day];
      if (!dayResult) return;
      Object.entries(shiftRanges).forEach(([shift, range]) => {
        const remarkColumn = range.remark;
        if (remarkColumn >= 0) dayResult.remarks[shift] = gasString(rowValue(row, remarkColumn)).trim();
      });
      const itemMap = {};
      const addAssignment = (column, shift) => {
        if (column === shiftRanges[shift].remark) return;
        const raw = gasString(rowValue(row, column)).trim();
        const person = gasString(rowValue(headers, column)).trim();
        if (!raw || !person) return;
        const visibleRaw = raw.replace(/資料輸入\s*\/\s*緊急任務/g, "").trim();
        if (!visibleRaw) return;
        const venueEntries = scheduleVenueEntriesInText(visibleRaw);
        const entries = venueEntries.length
          ? venueEntries.map((scheduleEntry) => {
            const link = scheduleVenueLink(scheduleEntry.venue);
            return {
              key: `venue:${scheduleEntry.venue}`,
              title: scheduleEntry.venue,
              company: link ? link.company : "",
              venue: scheduleEntry.venue,
              linked: !!link,
              machineCountExcluded: scheduleEntry.machineCountExcluded,
            };
          })
          : [{ key: `other:${visibleRaw.toLowerCase()}`, title: visibleRaw, company: "", venue: "", linked: false }];
        entries.forEach((entry) => {
          if (!itemMap[entry.key]) {
            itemMap[entry.key] = {
              title: entry.title,
              company: entry.company,
              venue: entry.venue,
              linked: entry.linked,
              machineCountExcluded: { am: null, pm: null },
              am: [],
              pm: [],
            };
          }
          const currentExclusion = itemMap[entry.key].machineCountExcluded[shift];
          itemMap[entry.key].machineCountExcluded[shift] = currentExclusion == null
            ? !!entry.machineCountExcluded
            : currentExclusion && !!entry.machineCountExcluded;
          itemMap[entry.key][shift].push({ name: person, assignment: visibleRaw });
        });
      };
      Object.entries(shiftRanges).forEach(([shift, range]) => {
        for (let column = range.start; column < range.end; column += 1) addAssignment(column, shift);
      });
      dayResult.items = Object.keys(itemMap).map((key) => {
        const item = itemMap[key];
        ["am", "pm"].forEach((shift) => {
          const seen = {};
          item[shift] = item[shift].filter((person) => {
            const id = `${person.name}\u0000${person.assignment}`;
            if (seen[id]) return false;
            seen[id] = true;
            return true;
          });
        });
        return item;
      }).sort((left, right) => {
        if (left.linked !== right.linked) return left.linked ? -1 : 1;
        return String(left.title).localeCompare(String(right.title));
      });
    });
  });
  return { success: true, from, days: requestedDates, missingSheets };
}

export function normalizeMonthlyCode(value, now = new Date(), options = DEFAULT_TIME_ZONE) {
  const timeZone = timeZoneOf(options);
  const monthCode = gasString(value || `${String(datePartsInZone(now, timeZone).year).slice(-2)}${pad2(datePartsInZone(now, timeZone).month)}`).trim();
  if (!/^\d{4}$/.test(monthCode) || Number(monthCode.slice(2)) < 1 || Number(monthCode.slice(2)) > 12) throw new Error("Invalid month");
  return monthCode;
}

export function scheduleSheetName(monthCode) {
  return `${String(2000 + Number(monthCode.slice(0, 2)))}-${MONTH_NAMES[Number(monthCode.slice(2)) - 1]}`;
}

export function monthlyTargetNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

export function monthlyVisitCutoffHour(venue) {
  return MONTHLY_VENUES.SCL.includes(venue) || MONTHLY_VENUES.MGM.includes(venue) ? 12 : 17;
}

export function isMonthlyVisitCompleted(monthCode, day, venue, now = new Date(), options = DEFAULT_TIME_ZONE) {
  const timeZone = timeZoneOf(options);
  const currentCode = scheduleMonthCode(now, timeZone);
  if (monthCode < currentCode) return true;
  if (monthCode > currentCode) return false;
  const current = datePartsInZone(now, timeZone);
  if (day < current.day) return true;
  if (day > current.day) return false;
  return current.hour >= monthlyVisitCutoffHour(venue);
}

export function getMonthlyScheduleFromRows(rows, monthCode, now = new Date(), sheetName, options = {}) {
  if (rows && !Array.isArray(rows) && Array.isArray(rows.rows)) {
    options = rows.options || {};
    sheetName = rows.sheetName;
    now = rows.now || new Date();
    monthCode = rows.monthCode;
    rows = rows.rows;
  }
  const normalizedMonth = normalizeMonthlyCode(monthCode, now, options.timeZone || DEFAULT_TIME_ZONE);
  const venues = {};
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const day = Number(gasString(rowValue(row, 0)).trim());
    if (!Number.isFinite(day) || day < 1 || day > 31) return;
    const dayVenues = {};
    row.slice(1, 9).concat(row.slice(12, 20)).forEach((assignment) => {
      scheduleVenueEntriesInText(assignment).forEach((entry) => {
        if (!entry.machineCountExcluded) dayVenues[entry.venue] = true;
      });
    });
    Object.keys(dayVenues).forEach((venue) => {
      if (!venues[venue]) venues[venue] = { scheduledVisits: 0, completedVisits: 0, remainingVisits: 0 };
      venues[venue].scheduledVisits += 1;
      if (isMonthlyVisitCompleted(normalizedMonth, day, venue, now, options.timeZone || DEFAULT_TIME_ZONE)) venues[venue].completedVisits += 1;
      else venues[venue].remainingVisits += 1;
    });
  });
  Object.keys(venues).forEach((venue) => {
    const item = venues[venue];
    item.visitPercent = item.scheduledVisits > 0 ? Math.round(item.completedVisits / item.scheduledVisits * 100) : 0;
  });
  return { sheetName: sheetName || scheduleSheetName(normalizedMonth), venues };
}

export function monthlyStatsBaseFromData(data = {}) {
  const monthCode = normalizeMonthlyCode(data.monthCode || data.month, data.now || new Date(), data.timeZone || DEFAULT_TIME_ZONE);
  const schedule = data.schedule || { sheetName: data.scheduleSheet || "", venues: data.scheduleVenues || {} };
  return {
    success: true,
    monthCode,
    scheduleSheet: schedule.sheetName,
    monthLabel: `${2000 + Number(monthCode.slice(0, 2))}年${Number(monthCode.slice(2))}月`,
    scheduleVenues: schedule.venues || {},
    sclSettings: data.sclSettings || { poNumber: "", targets: {} },
    monthlyVenues: data.monthlyVenues || MONTHLY_VENUES,
    gegTargets: data.gegTargets || GEG_MONTHLY_TARGETS,
  };
}

export function monthlyStatsCompanyFromRows(params = {}, rows = [], settings = {}) {
  if (params && params.params && Array.isArray(params.rows)) {
    settings = params.settings || {};
    rows = params.rows;
    params = params.params;
  }
  const requested = gasString(params.company).trim();
  const company = normalizeCompany(requested);
  if (!requested || requested.toLowerCase() !== company.toLowerCase()) throw new Error("Invalid company");
  const monthCode = normalizeMonthlyCode(params.month || params.monthCode, params.now || new Date(), params.timeZone || DEFAULT_TIME_ZONE);
  const monthlySettings = settings || params.sclSettings || {};
  let poNumber = company === "SCL" ? gasString(params.poNumber).trim() : monthCode;
  if (company === "SCL" && !poNumber) poNumber = gasString(monthlySettings.poNumber).trim();
  const counts = {};
  (MONTHLY_VENUES[company] || []).forEach((venue) => { counts[venue] = 0; });
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const venue = gasString(rowValue(row, 0)).trim();
    if (gasString(rowValue(row, 2)).trim() === poNumber && own(counts, venue)) counts[venue] += 1;
  });
  return { success: true, company, poNumber, counts };
}

export function combineMonthlyStats(base, companyResults = []) {
  const safeBase = base || {};
  const schedule = safeBase.scheduleVenues || {};
  const sclSettings = safeBase.sclSettings || { poNumber: "", targets: {} };
  const gegTargets = safeBase.gegTargets || {};
  const monthlyVenues = safeBase.monthlyVenues || MONTHLY_VENUES;
  return {
    success: true,
    monthCode: safeBase.monthCode,
    scheduleSheet: safeBase.scheduleSheet,
    monthLabel: safeBase.monthLabel,
    companies: (companyResults || []).map((result) => {
      const company = result.company;
      const targets = company === "SCL" ? (sclSettings.targets || {}) : company === "GEG" ? gegTargets : {};
      return {
        company,
        poNumber: result.poNumber,
        venues: (monthlyVenues[company] || []).map((venue) => {
          const done = Number(result.counts?.[venue]) || 0;
          const hasTarget = own(targets, venue);
          const target = hasTarget ? Math.max(0, Number(targets[venue]) || 0) : null;
          const remaining = hasTarget ? Math.max(target - done, 0) : null;
          const visit = schedule[venue] || null;
          return {
            venue,
            done,
            target,
            remaining,
            percent: hasTarget ? (target > 0 ? Math.round(done / target * 100) : (done > 0 ? 100 : 0)) : null,
            scheduledVisits: visit ? visit.scheduledVisits : null,
            completedVisits: visit ? visit.completedVisits : null,
            remainingVisits: visit ? visit.remainingVisits : null,
            visitPercent: visit ? visit.visitPercent : null,
            machinesPerRemainingVisit: (company === "SCL" || company === "GEG") && visit && visit.remainingVisits > 0
              ? Math.ceil(remaining / visit.remainingVisits)
              : null,
          };
        }),
      };
    }),
  };
}

export function monthlyStatsSubsetFromData(params = {}, base, companyResults, companies) {
  if (params && params.base && !base) {
    base = params.base;
    companyResults = params.companyResults || [];
    companies = params.companies;
  }
  const results = companyResults || [];
  if (companies && results.length === 0) return combineMonthlyStats(base, companies.map((company) => ({ company, poNumber: "", counts: {} })));
  return combineMonthlyStats(base, results);
}

export function monthlyVisitCachePhase(monthCode, now = new Date(), options = DEFAULT_TIME_ZONE) {
  const timeZone = timeZoneOf(options);
  const referenceDate = now || new Date();
  const currentCode = scheduleMonthCode(referenceDate, timeZone);
  if (monthCode !== currentCode) return "";
  const parts = datePartsInZone(referenceDate, timeZone);
  const dateKey = `${String(parts.year).padStart(4, "0")}${pad2(parts.month)}${pad2(parts.day)}`;
  const period = parts.hour >= 17 ? "after17" : parts.hour >= 12 ? "after12" : "before12";
  return `-${dateKey}-${period}`;
}

export function monthlyStatsCacheKey(monthCode, now = new Date()) {
  return `monthly-stats-v8-${monthCode}${monthlyVisitCachePhase(monthCode, now)}`;
}

export function monthlyStatsBaseCacheKey(monthCode, now = new Date()) {
  return `monthly-stats-base-v5-${monthCode}${monthlyVisitCachePhase(monthCode, now)}`;
}

export function monthlyCompanyStatsCacheKey(monthCode, company) {
  return `monthly-stats-company-v1-${monthCode}-${normalizeCompany(company)}`;
}

export const partsCodesFromRowsAlias = partsCodesFromRows;
export const getPartsCodesFromRows = partsCodesFromRows;
export const getAaTagsFromRows = aaTagsFromRows;
export const getBrokenPartsPageFromRows = getBrokenPartsPage;
export const getBrokenPartsRecordsFromRows = getBrokenPartsRecords;
export const getBrokenPartsStatsFromRows = getBrokenPartsStats;
export const getDashboardRecordsFromRows = getDashboardRecords;
export const dashboardRecordsFromRows = getDashboardRecords;
export const getScheduleOverviewFromRows = scheduleOverviewFromRows;
export const monthlyScheduleFromRows = getMonthlyScheduleFromRows;
export const monthlyStatsFromData = combineMonthlyStats;
export const getMonthlyStatsSubsetFromData = monthlyStatsSubsetFromData;

export {
  BROKEN_PARTS_HEADERS,
  COMPANIES,
  DEFAULT_COMPANY,
  WORKSHEET_NAME,
  companySchema,
  normalizeCompany,
};
