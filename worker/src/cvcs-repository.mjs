import {
  CVCS_BROKEN_PARTS_HEADERS,
  CVCS_OPTION_SHEETS,
  CVCS_RECORD_HEADERS,
  cvcsBrokenPartFromRow,
  cvcsBrokenPartToValues,
  cvcsRecordFromRow,
  cvcsRecordToValues,
  getCvcsBrokenPartsPage,
  getCvcsRecordPage,
  normalizeCvcsBrokenPart,
  normalizeCvcsRecord,
} from "./cvcs-domain.mjs";

export const CVCS_RECORDS_SHEET = "CVCS Records";
export const CVCS_BROKEN_PARTS_SHEET = "CVCS Broken Parts";
export const CVCS_PARTS_LIST_SHEET = "CVCS Parts List";

function text(value) {
  return String(value == null ? "" : value).trim();
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function equalValues(left, right) {
  return left.length === right.length && left.every((value, index) => text(value) === text(right[index]));
}

function mapTable(table, mapper) {
  return (table.rows || []).map((row, index) => mapper(row, index + 2, text(row?.[table.idColumn - 1])));
}

function findByIdentity(table, candidate, mapper, values) {
  const recordId = text(candidate?.recordId);
  if (!recordId) throw Object.assign(new Error("Please reload before editing this CVCS record"), { status: 409 });
  const index = (table.rows || []).findIndex((row) => text(row?.[table.idColumn - 1]) === recordId);
  if (index < 0) throw Object.assign(new Error("CVCS record changed; please reload"), { status: 409 });
  const current = mapper(table.rows[index], index + 2, recordId);
  if (!equalValues(values(current), values(candidate))) throw Object.assign(new Error("CVCS record changed; please reload"), { status: 409 });
  return { rowNumber: index + 2, current, recordId };
}

export function createCvcsRepository(deps) {
  const {
    loadTable,
    appendRows,
    writeRows,
    deleteRows,
    replaceSheet,
    invalidate,
    uuid,
  } = deps;

  async function recordTable(options = {}) {
    return loadTable(CVCS_RECORDS_SHEET, CVCS_RECORD_HEADERS, { ...options, identity: true, scope: "cvcs:records" });
  }

  async function brokenTable(options = {}) {
    return loadTable(CVCS_BROKEN_PARTS_SHEET, CVCS_BROKEN_PARTS_HEADERS, { ...options, identity: true, scope: "cvcs:broken" });
  }

  async function optionValues(sheetName, options = {}) {
    const table = await loadTable(sheetName, ["Option"], { ...options, identity: false, scope: `cvcs:option:${sheetName}` });
    return (table.values || []).slice(1).map((row) => text(row?.[0])).filter(Boolean);
  }

  async function getOptions(params = {}) {
    const refresh = text(params.refresh) === "1";
    const entries = await Promise.all(Object.entries(CVCS_OPTION_SHEETS).map(async ([key, sheetName]) => {
      if (key === "reasonAction") {
        const table = await loadTable(sheetName, ["Reason", "Action Taken & Notes"], { refresh, identity: false, scope: `cvcs:option:${sheetName}` });
        return [key, (table.values || []).slice(1).map((row) => ({ reason: text(row?.[0]), actionTakenNotes: text(row?.[1]) })).filter((row) => row.reason || row.actionTakenNotes)];
      }
      return [key, await optionValues(sheetName, { refresh })];
    }));
    const partsTable = await loadTable(CVCS_PARTS_LIST_SHEET, ["Parts No.", "Required Parts (EN)"], { refresh, identity: false, scope: "cvcs:parts" });
    const parts = (partsTable.values || []).slice(1).map((row) => ({ partsNo: text(row?.[0]), requiredPartsEn: text(row?.[1]) })).filter((row) => row.partsNo || row.requiredPartsEn);
    return { success: true, options: Object.fromEntries(entries), parts };
  }

  async function getRecords(params = {}) {
    const table = await recordTable({ refresh: text(params.refresh) === "1" });
    return { success: true, ...getCvcsRecordPage(mapTable(table, cvcsRecordFromRow), params) };
  }

  async function getBrokenParts(params = {}) {
    const table = await brokenTable({ refresh: text(params.refresh) === "1" });
    return { success: true, ...getCvcsBrokenPartsPage(mapTable(table, cvcsBrokenPartFromRow), params) };
  }

  async function updateOptions(payload = {}) {
    const key = text(payload.key);
    const sheetName = CVCS_OPTION_SHEETS[key];
    if (!sheetName) throw Object.assign(new Error("Unknown CVCS option list"), { status: 400 });
    if (key === "reasonAction") {
      const rows = (Array.isArray(payload.options) ? payload.options : []).map((item) => [text(item.reason), text(item.actionTakenNotes)]).filter((row) => row[0] || row[1]);
      await replaceSheet(sheetName, [["Reason", "Action Taken & Notes"], ...rows], 2);
      await invalidate([`cvcs:option:${sheetName}`]);
      return { success: true, saved: rows.length, options: rows.map(([reason, actionTakenNotes]) => ({ reason, actionTakenNotes })) };
    }
    const values = [...new Set((Array.isArray(payload.options) ? payload.options : []).map(text).filter(Boolean))];
    await replaceSheet(sheetName, [["Option"], ...values.map((value) => [value])], 1);
    await invalidate([`cvcs:option:${sheetName}`]);
    return { success: true, saved: values.length, options: values };
  }

  async function submitRecords(payload = {}) {
    const records = (Array.isArray(payload.records) ? payload.records : []).map((raw) => {
      const submissionId = text(raw?.submissionId) || text(uuid());
      return normalizeCvcsRecord({ ...raw, submissionId });
    });
    if (!records.length) throw Object.assign(new Error("No CVCS records supplied"), { status: 400 });
    const table = await recordTable({ refresh: true, cache: false });
    const existing = new Set((table.rows || []).map((row) => text(row?.[table.idColumn - 1])).filter(Boolean));
    const rows = [];
    const insertedSubmissionIds = [];
    const skippedSubmissionIds = [];
    for (const record of records) {
      if (existing.has(record.submissionId)) {
        skippedSubmissionIds.push(record.submissionId);
        continue;
      }
      const values = cvcsRecordToValues(record);
      while (values.length < table.idColumn) values.push("");
      values[table.idColumn - 1] = record.submissionId;
      rows.push(values);
      existing.add(record.submissionId);
      insertedSubmissionIds.push(record.submissionId);
    }
    if (rows.length) await appendRows(table, rows);
    await invalidate(["cvcs:records"]);
    return { success: true, inserted: rows.length, skipped: skippedSubmissionIds.length, acknowledged: records.length, insertedSubmissionIds, skippedSubmissionIds };
  }

  async function submitBrokenParts(payload = {}) {
    const records = (Array.isArray(payload.records) ? payload.records : []).map((raw) => {
      const submissionId = text(raw?.submissionId) || text(uuid());
      return normalizeCvcsBrokenPart({ ...raw, submissionId });
    });
    if (!records.length) throw Object.assign(new Error("No CVCS Broken Parts records supplied"), { status: 400 });
    const table = await brokenTable({ refresh: true, cache: false });
    const existing = new Set((table.rows || []).map((row) => text(row?.[table.idColumn - 1])).filter(Boolean));
    const rows = [];
    const insertedSubmissionIds = [];
    const skippedSubmissionIds = [];
    for (const record of records) {
      if (existing.has(record.submissionId)) {
        skippedSubmissionIds.push(record.submissionId);
        continue;
      }
      const values = cvcsBrokenPartToValues(record);
      while (values.length < table.idColumn) values.push("");
      values[table.idColumn - 1] = record.submissionId;
      rows.push(values);
      existing.add(record.submissionId);
      insertedSubmissionIds.push(record.submissionId);
    }
    if (rows.length) await appendRows(table, rows);
    await invalidate(["cvcs:broken"]);
    return { success: true, inserted: rows.length, skipped: skippedSubmissionIds.length, acknowledged: records.length, insertedSubmissionIds, skippedSubmissionIds };
  }

  async function updateRecord(payload = {}) {
    const candidate = payload.record || {};
    const table = await recordTable({ refresh: true, cache: false });
    const target = findByIdentity(table, candidate, cvcsRecordFromRow, cvcsRecordToValues);
    const after = normalizeCvcsRecord({ ...candidate, ...(payload.changes || {}), recordId: target.recordId, rowNumber: target.rowNumber });
    await writeRows(table, [{ rowNumber: target.rowNumber, values: cvcsRecordToValues(after) }]);
    await invalidate(["cvcs:records"]);
    return { success: true, rowNumber: target.rowNumber, recordId: target.recordId };
  }

  async function deleteRecord(payload = {}) {
    const candidate = payload.record || {};
    const table = await recordTable({ refresh: true, cache: false });
    const target = findByIdentity(table, candidate, cvcsRecordFromRow, cvcsRecordToValues);
    await deleteRows(table, [target.rowNumber]);
    await invalidate(["cvcs:records"]);
    return { success: true, deleted: 1 };
  }

  async function bulkRecords(payload = {}, remove = false) {
    const records = Array.isArray(payload.records) ? payload.records : [];
    if (!records.length) throw Object.assign(new Error("No CVCS records supplied"), { status: 400 });
    const table = await recordTable({ refresh: true, cache: false });
    const targets = records.map((candidate) => findByIdentity(table, candidate, cvcsRecordFromRow, cvcsRecordToValues));
    if (remove) {
      await deleteRows(table, targets.map((target) => target.rowNumber));
      await invalidate(["cvcs:records"]);
      return { success: true, deleted: targets.length };
    }
    const requested = payload.changes || {};
    const allowed = ["property", "date", "location", "subLocation", "quarter", "model", "antennaSize", "antennaStatus", "version", "reason", "actionTakenNotes", "partsChange"];
    const changes = Object.fromEntries(allowed.filter((key) => own(requested, key) && text(requested[key]) !== "").map((key) => [key, requested[key]]));
    if (!Object.keys(changes).length) throw Object.assign(new Error("No CVCS changes supplied"), { status: 400 });
    const writes = targets.map((target) => ({ rowNumber: target.rowNumber, values: cvcsRecordToValues({ ...target.current, ...changes }) }));
    await writeRows(table, writes);
    await invalidate(["cvcs:records"]);
    return { success: true, saved: writes.length };
  }

  async function updateBrokenPart(payload = {}) {
    const candidate = payload.record || {};
    const table = await brokenTable({ refresh: true, cache: false });
    const target = findByIdentity(table, candidate, cvcsBrokenPartFromRow, cvcsBrokenPartToValues);
    const after = normalizeCvcsBrokenPart({ ...candidate, ...(payload.changes || {}), recordId: target.recordId, rowNumber: target.rowNumber });
    await writeRows(table, [{ rowNumber: target.rowNumber, values: cvcsBrokenPartToValues(after) }]);
    await invalidate(["cvcs:broken"]);
    return { success: true, rowNumber: target.rowNumber, recordId: target.recordId };
  }

  async function deleteBrokenPart(payload = {}) {
    const candidate = payload.record || {};
    const table = await brokenTable({ refresh: true, cache: false });
    const target = findByIdentity(table, candidate, cvcsBrokenPartFromRow, cvcsBrokenPartToValues);
    await deleteRows(table, [target.rowNumber]);
    await invalidate(["cvcs:broken"]);
    return { success: true, deleted: 1 };
  }

  async function bulkBrokenParts(payload = {}) {
    const records = Array.isArray(payload.records) ? payload.records : [];
    if (!records.length) throw Object.assign(new Error("No CVCS Broken Parts records supplied"), { status: 400 });
    const table = await brokenTable({ refresh: true, cache: false });
    const targets = records.map((candidate) => findByIdentity(table, candidate, cvcsBrokenPartFromRow, cvcsBrokenPartToValues));
    const requested = payload.changes || {};
    const allowed = ["property", "model", "partsNo", "requiredPartsEn", "qty", "repairDay", "foundDay", "remark", "requestFollowUpDate", "followUpCompletedDate"];
    const changes = Object.fromEntries(allowed.filter((key) => own(requested, key) && text(requested[key]) !== "").map((key) => [key, requested[key]]));
    if (!Object.keys(changes).length) throw Object.assign(new Error("No CVCS Broken Parts changes supplied"), { status: 400 });
    const writes = targets.map((target) => ({ rowNumber: target.rowNumber, values: cvcsBrokenPartToValues({ ...target.current, ...changes }) }));
    await writeRows(table, writes);
    await invalidate(["cvcs:broken"]);
    return { success: true, saved: writes.length };
  }

  async function findSubmissionIds(items = []) {
    const wanted = new Set(items.map((item) => text(item.submissionId)).filter(Boolean));
    const found = {};
    for (const [kind, loader] of [["cvcs", recordTable], ["cvcs-broken", brokenTable]]) {
      const table = await loader({ refresh: true, cache: false, ensureIdentity: false });
      (table.rows || []).forEach((row, index) => {
        const id = text(row?.[table.idColumn - 1]);
        if (wanted.has(id)) found[id] = { company: kind, rowNumber: index + 2 };
      });
    }
    return found;
  }

  async function getAction(params = {}) {
    if (params.action === "cvcsOptions") return getOptions(params);
    if (params.action === "cvcsRecords") return getRecords(params);
    if (params.action === "cvcsBrokenParts") return getBrokenParts(params);
    return null;
  }

  async function postAction(payload = {}) {
    if (payload.action === "updateCvcsOptions") return updateOptions(payload);
    if (payload.action === "submitCvcsRecords") return submitRecords(payload);
    if (payload.action === "submitCvcsBrokenParts") return submitBrokenParts(payload);
    if (payload.action === "updateCvcsRecord") return updateRecord(payload);
    if (payload.action === "deleteCvcsRecord") return deleteRecord(payload);
    if (payload.action === "bulkUpdateCvcsRecords") return bulkRecords(payload, false);
    if (payload.action === "bulkDeleteCvcsRecords") return bulkRecords(payload, true);
    if (payload.action === "updateCvcsBrokenPart") return updateBrokenPart(payload);
    if (payload.action === "deleteCvcsBrokenPart") return deleteBrokenPart(payload);
    if (payload.action === "bulkUpdateCvcsBrokenParts") return bulkBrokenParts(payload);
    return null;
  }

  return { getAction, postAction, findSubmissionIds, recordTable, brokenTable };
}
