export const COMPANIES = ["Melco", "MGM", "SJM", "SCL", "GEG", "Wynn"];
export const DEFAULT_COMPANY = "SCL";
export const WORKSHEET_NAME = "Worksheet";
export const BROKEN_PARTS_SHEET = "Broken Parts List";
export const TEMPLATE_SHEET = "Template";
export const AA_TAG_SHEET = "AA TAG";
export const MONTHLY_SHEET = "Monthly";
export const SUBMISSION_HEADER = "AMRS Submission ID";
export const BROKEN_PARTS_HEADERS = [
  "CASINO",
  "Model",
  "Serial No.",
  "Parts No.",
  "Required Parts(JP)",
  "Required Parts(EN)",
  "Qty",
  "Repair Day",
  "Found Day",
  "Remark",
  "UOD Activation Date",
  "UOD Unlock Date",
  "Hold Date",
  "Hold Release Date",
];

export function normalizeCompany(value) {
  const raw = String(value || DEFAULT_COMPANY).trim().toLowerCase();
  return COMPANIES.find((company) => company.toLowerCase() === raw) || DEFAULT_COMPANY;
}

export function companySchema(company) {
  const normalized = normalizeCompany(company);
  if (normalized === "GEG") {
    return {
      width: 12,
      inspectorIndex: 11,
      fields: ["casino", "date", "poNumber", "model", "serialNo", "voidSeal", "newVoidSeal", "reason", "actionTaken", "errorDescription", "boxId", "inspector"],
    };
  }
  if (normalized === "MGM") {
    return {
      width: 11,
      inspectorIndex: 9,
      fields: ["casino", "date", "poNumber", "model", "serialNo", "reason", "actionTaken", "errorDescription", "boxId", "inspector", "location"],
    };
  }
  return {
    width: 10,
    inspectorIndex: 9,
    fields: ["casino", "date", "poNumber", "model", "serialNo", "reason", "actionTaken", "errorDescription", "boxId", "inspector"],
  };
}

export function loadRuntimeConfig(env) {
  let parsed;
  try {
    parsed = JSON.parse(env.AMRS_CONFIG || "{}");
  } catch {
    throw Object.assign(new Error("Invalid server configuration"), { status: 500 });
  }
  const sheets = parsed.sheets || {};
  for (const company of COMPANIES) {
    if (!sheets[company]) throw Object.assign(new Error("Missing company sheet configuration"), { status: 500 });
  }
  if (!parsed.partsSheetId || !parsed.scheduleSheetId) {
    throw Object.assign(new Error("Missing shared sheet configuration"), { status: 500 });
  }
  return {
    sheets,
    partsSheetId: parsed.partsSheetId,
    scheduleSheetId: parsed.scheduleSheetId,
    timeZone: parsed.timeZone || "Asia/Hong_Kong",
  };
}

