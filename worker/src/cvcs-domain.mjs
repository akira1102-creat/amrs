export const CVCS_PROPERTIES = ["Venetian", "Londoner", "Sands", "Plaza", "Parisian"];
export const CVCS_LOCATIONS = ["Cage", "TG", "Card Room", "Other"];
export const CVCS_MODELS = ["SOT", "SCP", "Reader"];
export const CVCS_QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

export const CVCS_RECORD_HEADERS = [
  "Property", "Date", "Location", "Sub Location", "Quarter", "Model", "S/N",
  "Antenna Size", "Antenna Status", "Version", "Reason", "Action Taken & Notes", "Parts Change",
];

export const CVCS_BROKEN_PARTS_HEADERS = [
  "Property", "Model", "S/N", "Parts No.", "Required Parts (EN)", "Qty", "Repair Day",
  "Found Day", "Remark", "Request Follow-up Date", "Follow-up Completed Date",
];

export const CVCS_OPTION_SHEETS = Object.freeze({
  subLocation: "Sub Location",
  antennaSize: "Antenna Size",
  antennaStatus: "Antenna Status",
  version: "Version",
  reasonAction: "Reason Action Mapping",
  partsChange: "Parts Change",
});

function text(value) {
  return String(value == null ? "" : value).trim();
}

function requiredChoice(value, choices, label) {
  const normalized = text(value);
  if (!choices.includes(normalized)) throw Object.assign(new Error(`${label} is required or invalid`), { status: 400 });
  return normalized;
}

function sheetValue(row, index) {
  return row?.[index] == null ? "" : row[index];
}

function normalizeDate(value, label, required = false) {
  const raw = text(value);
  if (!raw) {
    if (required) throw Object.assign(new Error(`${label} is required`), { status: 400 });
    return "";
  }
  if (/^(Waiting Parts)$/i.test(raw)) return "Waiting Parts";
  const match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) throw Object.assign(new Error(`${label} is invalid`), { status: 400 });
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
    throw Object.assign(new Error(`${label} is invalid`), { status: 400 });
  }
  return `${String(year).padStart(4, "0")}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
}

function pageNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function paginate(records, params = {}) {
  const pageSize = Math.min(100, pageNumber(params.pageSize, 10));
  const pages = Math.max(1, Math.ceil(records.length / pageSize));
  const page = Math.min(pages, pageNumber(params.page, 1));
  return {
    records: records.slice((page - 1) * pageSize, page * pageSize),
    total: records.length,
    page,
    pageSize,
    pages,
  };
}

export function normalizeCvcsRecord(record = {}) {
  return {
    rowNumber: Number(record.rowNumber) || 0,
    recordId: text(record.recordId),
    property: requiredChoice(record.property, CVCS_PROPERTIES, "Property"),
    date: normalizeDate(record.date, "Date", true),
    location: requiredChoice(record.location, CVCS_LOCATIONS, "Location"),
    subLocation: text(record.subLocation),
    quarter: record.quarter ? requiredChoice(record.quarter, CVCS_QUARTERS, "Quarter") : "",
    model: requiredChoice(record.model, CVCS_MODELS, "Model"),
    serialNo: (() => {
      const value = text(record.serialNo);
      if (!value) throw Object.assign(new Error("S/N is required"), { status: 400 });
      return value;
    })(),
    antennaSize: text(record.antennaSize),
    antennaStatus: text(record.antennaStatus),
    version: text(record.version),
    reason: text(record.reason) || "PM",
    actionTakenNotes: text(record.actionTakenNotes),
    partsChange: text(record.partsChange),
    submissionId: text(record.submissionId),
  };
}

export function cvcsRecordToValues(record = {}) {
  const value = normalizeCvcsRecord(record);
  return [
    value.property, value.date, value.location, value.subLocation, value.quarter, value.model,
    value.serialNo, value.antennaSize, value.antennaStatus, value.version, value.reason,
    value.actionTakenNotes, value.partsChange,
  ];
}

export function cvcsRecordFromRow(row = [], rowNumber = 0, recordId = "") {
  return {
    rowNumber: Number(rowNumber) || 0,
    recordId: text(recordId),
    property: text(sheetValue(row, 0)),
    date: text(sheetValue(row, 1)),
    location: text(sheetValue(row, 2)),
    subLocation: text(sheetValue(row, 3)),
    quarter: text(sheetValue(row, 4)),
    model: text(sheetValue(row, 5)),
    serialNo: text(sheetValue(row, 6)),
    antennaSize: text(sheetValue(row, 7)),
    antennaStatus: text(sheetValue(row, 8)),
    version: text(sheetValue(row, 9)),
    reason: text(sheetValue(row, 10)),
    actionTakenNotes: text(sheetValue(row, 11)),
    partsChange: text(sheetValue(row, 12)),
  };
}

function recordSearchText(record) {
  return [record.subLocation, record.antennaSize, record.antennaStatus, record.version, record.reason, record.actionTakenNotes, record.partsChange]
    .map(text).join(" ").toLowerCase();
}

export function getCvcsRecordPage(rows = [], params = {}) {
  const property = text(params.property);
  const location = text(params.location);
  const quarter = text(params.quarter);
  const model = text(params.model);
  const serialNo = text(params.serialNo);
  const query = text(params.query).toLowerCase();
  const fuzzy = params.fuzzy === true || /^(1|true)$/i.test(text(params.fuzzy));
  const from = params.from ? normalizeDate(params.from, "From date") : "";
  const to = params.to ? normalizeDate(params.to, "To date") : "";
  const records = rows.filter((record) => {
    if (property && text(record.property) !== property) return false;
    if (location && text(record.location) !== location) return false;
    if (quarter && text(record.quarter) !== quarter) return false;
    if (model && text(record.model) !== model) return false;
    if (from && text(record.date) < from) return false;
    if (to && text(record.date) > to) return false;
    if (serialNo) {
      const candidate = text(record.serialNo);
      if (fuzzy ? !candidate.toLowerCase().includes(serialNo.toLowerCase()) : candidate !== serialNo) return false;
    }
    if (query && (!fuzzy || !recordSearchText(record).includes(query))) return false;
    return true;
  }).sort((left, right) => {
    const direction = text(params.sort).toLowerCase() === "oldest" ? 1 : -1;
    return text(left.date).localeCompare(text(right.date)) * direction || (Number(left.rowNumber) - Number(right.rowNumber)) * direction;
  });
  return paginate(records, params);
}

export function normalizeCvcsBrokenPart(record = {}) {
  const normalized = {
    rowNumber: Number(record.rowNumber) || 0,
    recordId: text(record.recordId),
    property: requiredChoice(record.property, CVCS_PROPERTIES, "Property"),
    model: requiredChoice(record.model, CVCS_MODELS, "Model"),
    serialNo: (() => {
      const value = text(record.serialNo);
      if (!value) throw Object.assign(new Error("S/N is required"), { status: 400 });
      return value;
    })(),
    partsNo: text(record.partsNo),
    requiredPartsEn: text(record.requiredPartsEn),
    qty: text(record.qty),
    repairDay: normalizeDate(record.repairDay, "Repair Day"),
    foundDay: normalizeDate(record.foundDay, "Found Day"),
    remark: text(record.remark),
    requestFollowUpDate: normalizeDate(record.requestFollowUpDate, "Request Follow-up Date"),
    followUpCompletedDate: normalizeDate(record.followUpCompletedDate, "Follow-up Completed Date"),
    submissionId: text(record.submissionId),
  };
  if (!normalized.partsNo && !normalized.requestFollowUpDate) {
    throw Object.assign(new Error("A part or follow-up request is required"), { status: 400 });
  }
  if (!normalized.partsNo) {
    normalized.requiredPartsEn = "";
    normalized.qty = "";
    normalized.repairDay = "";
  }
  return normalized;
}

export function cvcsBrokenPartToValues(record = {}) {
  const value = normalizeCvcsBrokenPart(record);
  return [
    value.property, value.model, value.serialNo, value.partsNo, value.requiredPartsEn, value.qty,
    value.repairDay, value.foundDay, value.remark, value.requestFollowUpDate, value.followUpCompletedDate,
  ];
}

export function cvcsBrokenPartFromRow(row = [], rowNumber = 0, recordId = "") {
  return {
    rowNumber: Number(rowNumber) || 0,
    recordId: text(recordId),
    property: text(sheetValue(row, 0)),
    model: text(sheetValue(row, 1)),
    serialNo: text(sheetValue(row, 2)),
    partsNo: text(sheetValue(row, 3)),
    requiredPartsEn: text(sheetValue(row, 4)),
    qty: text(sheetValue(row, 5)),
    repairDay: text(sheetValue(row, 6)),
    foundDay: text(sheetValue(row, 7)),
    remark: text(sheetValue(row, 8)),
    requestFollowUpDate: text(sheetValue(row, 9)),
    followUpCompletedDate: text(sheetValue(row, 10)),
  };
}

export function cvcsBrokenPartStatus(record = {}) {
  const statuses = [];
  if (text(record.partsNo)) statuses.push(/^waiting parts$/i.test(text(record.repairDay)) || !text(record.repairDay) ? "Waiting Parts" : "Repaired");
  if (text(record.requestFollowUpDate)) statuses.push(text(record.followUpCompletedDate) ? "Follow-up Completed" : "Following Up");
  return statuses;
}

export function getCvcsBrokenPartsPage(rows = [], params = {}) {
  const property = text(params.property);
  const serialNo = text(params.serialNo);
  const partsNo = text(params.partsNo).toLowerCase();
  const status = text(params.status).toLowerCase();
  const records = rows.filter((record) => {
    if (property && text(record.property) !== property) return false;
    if (serialNo && text(record.serialNo) !== serialNo) return false;
    if (partsNo && !text(record.partsNo).toLowerCase().includes(partsNo)) return false;
    if (status && !cvcsBrokenPartStatus(record).some((value) => value.toLowerCase() === status)) return false;
    return true;
  }).sort((left, right) => {
    const direction = text(params.sort).toLowerCase() === "oldest" ? 1 : -1;
    return text(left.foundDay).localeCompare(text(right.foundDay)) * direction || (Number(left.rowNumber) - Number(right.rowNumber)) * direction;
  });
  return paginate(records, params);
}
