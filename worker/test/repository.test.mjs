import assert from "node:assert/strict";
import test from "node:test";
import { createCloudflareCacheAdapter, createRepository } from "../src/repository.mjs";
import { getDuplicateFaultsFromRows } from "../src/domain.mjs";

test("Cloudflare cache adapter keeps short-lived Sheet payloads outside D1", async () => {
  const entries = new Map();
  const adapter = createCloudflareCacheAdapter({
    match: async (request) => entries.get(request.url)?.clone() || null,
    put: async (request, response) => entries.set(request.url, response.clone()),
  });

  await adapter.put("main:SCL:0:sheet", { rows: [["SCL"]] }, 15_000);
  const response = await adapter.get("main:SCL:0:sheet");

  assert.deepEqual(await response.json(), { rows: [["SCL"]] });
  assert.equal(response.headers.get("cache-control"), "public, max-age=15");
});

function columnNumber(label) {
  let result = 0;
  for (const character of String(label).toUpperCase()) result = result * 26 + character.charCodeAt(0) - 64;
  return result;
}

function columnLabel(number) {
  let value = Number(number);
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function unquoteSheet(value) {
  return String(value).replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
}

function parseRange(range) {
  const bang = String(range).lastIndexOf("!");
  const sheetName = unquoteSheet(String(range).slice(0, bang));
  const cells = String(range).slice(bang + 1);
  const [left, right = left] = cells.split(":");
  const parseCell = (cell) => {
    const match = String(cell).match(/^([A-Z]+)(\d*)$/i);
    return { column: columnNumber(match?.[1] || "A"), row: match?.[2] ? Number(match[2]) : null };
  };
  const start = parseCell(left);
  const end = parseCell(right);
  return {
    sheetName,
    startRow: start.row || 1,
    startColumn: start.column,
    endRow: end.row,
    endColumn: end.column,
  };
}

function cloneRows(rows) {
  return rows.map((row) => (Array.isArray(row) ? row.slice() : []));
}

function createSheetsHarness(initial = {}) {
  const sheets = new Map();
  let nextSheetId = 1;
  for (const [spreadsheetId, definitions] of Object.entries(initial)) {
    for (const definition of definitions) {
      sheets.set(`${spreadsheetId}:${definition.title}`, {
        spreadsheetId,
        sheetId: definition.sheetId || nextSheetId++,
        title: definition.title,
        values: cloneRows(definition.values || []),
        gridProperties: { columnCount: definition.columnCount || 26, rowCount: definition.rowCount || 1000 },
      });
    }
  }

  function getSheet(spreadsheetId, title) {
    return sheets.get(`${spreadsheetId}:${title}`);
  }

  function ensureCell(sheet, row, column) {
    while (sheet.values.length < row) sheet.values.push([]);
    for (const current of sheet.values) while (current.length < column) current.push("");
  }

  function writeRange(spreadsheetId, range, values) {
    const parsed = parseRange(range);
    const sheet = getSheet(spreadsheetId, parsed.sheetName);
    if (!sheet) throw new Error(`Unknown sheet ${parsed.sheetName}`);
    const rows = Array.isArray(values) ? values : [];
    rows.forEach((row, rowOffset) => {
      const targetRow = parsed.startRow + rowOffset;
      const target = Array.isArray(row) ? row : [];
      target.forEach((value, columnOffset) => {
        ensureCell(sheet, targetRow, parsed.startColumn + columnOffset);
        sheet.values[targetRow - 1][parsed.startColumn - 1 + columnOffset] = value;
      });
    });
    sheet.gridProperties.rowCount = Math.max(sheet.gridProperties.rowCount, sheet.values.length);
    sheet.gridProperties.columnCount = Math.max(sheet.gridProperties.columnCount, parsed.startColumn + Math.max(parsed.endColumn - parsed.startColumn, 0));
  }

  function readRange(spreadsheetId, range) {
    const parsed = parseRange(range);
    const sheet = getSheet(spreadsheetId, parsed.sheetName);
    if (!sheet) throw new Error(`Unknown sheet ${parsed.sheetName}`);
    const endRow = parsed.endRow || Math.max(sheet.values.length, parsed.startRow);
    const endColumn = parsed.endColumn || Math.max(sheet.gridProperties.columnCount, parsed.startColumn);
    return Array.from({ length: Math.max(0, endRow - parsed.startRow + 1) }, (_, rowOffset) => {
      const source = sheet.values[parsed.startRow - 1 + rowOffset] || [];
      return Array.from({ length: Math.max(0, endColumn - parsed.startColumn + 1) }, (_, columnOffset) => source[parsed.startColumn - 1 + columnOffset] ?? "");
    });
  }

  const client = {
    async request({ path }) {
      const match = String(path).match(/^spreadsheets\/([^/]+)$/);
      const spreadsheetId = decodeURIComponent(match?.[1] || "");
      return {
        sheets: [...sheets.values()]
          .filter((sheet) => sheet.spreadsheetId === spreadsheetId)
          .map((sheet) => ({ properties: { sheetId: sheet.sheetId, title: sheet.title, gridProperties: sheet.gridProperties } })),
      };
    },
    async valuesGet({ spreadsheetId, range }) { return { values: readRange(spreadsheetId, range) }; },
    async valuesUpdate({ spreadsheetId, range, values }) { writeRange(spreadsheetId, range, values); return { updatedRows: values.length }; },
    async valuesAppend({ spreadsheetId, range, values }) {
      const parsed = parseRange(range);
      const sheet = getSheet(spreadsheetId, parsed.sheetName);
      values.forEach((row) => sheet.values.push(row.slice()));
      return { updates: { updatedRows: values.length } };
    },
    async valuesBatchUpdate({ spreadsheetId, data }) {
      data.forEach((entry) => writeRange(spreadsheetId, entry.range, entry.values));
      return { totalUpdatedRows: data.length };
    },
    async spreadsheetBatchUpdate({ spreadsheetId, requests }) {
      const replies = [];
      requests.forEach((request) => {
        if (request.addSheet) {
          const title = request.addSheet.properties.title;
          const sheet = {
            spreadsheetId,
            sheetId: nextSheetId++,
            title,
            values: [],
            gridProperties: { columnCount: 26, rowCount: 1000 },
          };
          sheets.set(`${spreadsheetId}:${title}`, sheet);
          replies.push({ addSheet: { properties: sheet } });
          return;
        }
        const dimension = request.insertDimension;
        if (dimension) {
          const sheet = [...sheets.values()].find((item) => item.spreadsheetId === spreadsheetId && item.sheetId === dimension.range.sheetId);
          const start = Number(dimension.range.startIndex);
          const count = Number(dimension.range.endIndex) - start;
          sheet.gridProperties.columnCount += count;
          sheet.values.forEach((row) => row.splice(start, 0, ...Array(count).fill("")));
          return;
        }
        const deletion = request.deleteDimension;
        if (deletion) {
          const sheet = [...sheets.values()].find((item) => item.spreadsheetId === spreadsheetId && item.sheetId === deletion.range.sheetId);
          if (deletion.range.dimension === "ROWS") sheet.values.splice(deletion.range.startIndex, deletion.range.endIndex - deletion.range.startIndex);
        }
      });
      return { replies };
    },
  };
  return { client, sheets };
}

const config = {
  sheets: { Melco: "melco", MGM: "mgm", SJM: "sjm", SCL: "scl", GEG: "geg", Wynn: "wynn" },
  partsSheetId: "parts",
  scheduleSheetId: "schedule",
  cvcsSheetId: "cvcs",
  galaxyLogSheetId: "galaxy-log",
  timeZone: "Asia/Hong_Kong",
};

const commonHeaders = ["CASINO", "DATE", "PO Number", "Model", "Serial No.", "Reason", "Action Taken", "Error Description", "Box ID", "Inspector"];
const companyData = {
  scl: [{ title: "Worksheet", values: [commonHeaders, ["Venetian", "2026/08/04", "2608", "SAE", "1234", "PM", "Preventive Maintenance", "", "", "Alice"]] }, {
    title: "Broken Parts List",
    values: [["CASINO", "Model", "Serial No.", "Parts No.", "Required Parts(JP)", "Required Parts(EN)", "Qty", "Repair Day", "Found Day", "Remark", "UOD Activation Date", "UOD Unlock Date", "Hold Date", "Hold Release Date"], ["Venetian", "SAE", "1234", "AE-1", "部品", "PART", "1", "Waiting", "2026/08/04", "", "", "", "", ""]],
  }, { title: "Template", values: [["Reason", "Action Taken"], ["PM", "Preventive Maintenance"]] }, { title: "Monthly", values: Array.from({ length: 20 }, () => ["", "", ""]).map((row, index) => index === 1 ? ["", "2608", ""] : index === 3 ? ["", "", "10"] : row) }],
  mgm: [{ title: "Worksheet", values: [commonHeaders.concat("Location"), ["MGM Macau", "2026/08/04", "2608", "TAE", "51", "PM", "Preventive Maintenance", "", "", "Bob", "Floor"]] }, { title: "AA TAG", values: [["Serial No.", "AA Tag"], ["51", "TAE0051"]] }],
  sjm: [{ title: "Worksheet", values: [commonHeaders, ["Lisboa", "2026/08/04", "2608", "SAE", "2", "PM", "Preventive Maintenance", "", "", ""]] }],
  geg: [{ title: "Worksheet", values: [["CASINO", "DATE", "PO Number", "Model", "Serial No.", "Void Seal", "New Void Seal", "Reason", "Action Taken", "Error Description", "Box ID", "Inspector"], ["Galaxy", "2026/08/04", "2608", "TAE", "3", "00001", "", "PM", "Preventive Maintenance", "", "", ""]] }],
  melco: [{ title: "Worksheet", values: [commonHeaders, ["ALT", "2026/08/04", "2608", "SAE", "4", "PM", "Preventive Maintenance", "", "", ""]] }],
  wynn: [{ title: "Worksheet", values: [commonHeaders, ["Wynn", "2026/08/04", "2608", "SAE", "5", "PM", "Preventive Maintenance", "", "", ""]] }],
  parts: [{ title: "Parts List", values: [["AE-1", "部品", "PART"], ["TAE-1", "部品2", "PART2"]] }],
  schedule: [{ title: "2026-AUG", values: [["Day", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S"], [4, "VML", "", "", "", "", "", "", "", "", "", "", "LON", "", "", "", "", "", ""]] }],
  "galaxy-log": [{ title: "Galaxy Log", values: [
    ["SN末4位", "指定 Log 日期", "取 Log 日期", "SN末4位", "指定 Log 日期", "取 Log 日期"],
    ["1190", "2026/08/01", "", "1192", "2026/08/02", "2026/08/03"],
    ["1191", "2026/08/04", "", "", "", ""],
  ] }],
  cvcs: [
    { title: "CVCS Records", values: [["Property", "Date", "Location", "Sub Location", "Quarter", "Model", "S/N", "Antenna Size", "Antenna Status", "Version", "Reason", "Action Taken & Notes", "Parts Change"], ["Venetian", "2026/08/04", "Cage", "North", "Q1", "SOT", "1234", "Large", "Active", "1.0", "PM", "Inspection", "Cable"]] },
    { title: "Sub Location", values: [["Option"], ["North"], ["South"]] },
    { title: "Antenna Size", values: [["Option"], ["Large"]] },
    { title: "Antenna Status", values: [["Option"], ["Active"]] },
    { title: "Version", values: [["Option"], ["1.0"]] },
    { title: "Reason Action Mapping", values: [["Reason", "Action Taken & Notes"], ["PM", "Inspection"]] },
    { title: "Parts Change", values: [["Option"], ["Cable"]] },
    { title: "CVCS Broken Parts", values: [["Property", "Model", "S/N", "Parts No.", "Required Parts (EN)", "Qty", "Repair Day", "Found Day", "Remark", "Request Follow-up Date", "Follow-up Completed Date"], ["Venetian", "SOT", "1234", "", "", "", "", "2026/08/04", "", "2026/08/04", ""]] },
    { title: "CVCS Parts List", values: [["Parts No.", "Required Parts (EN)"], ["CV-1", "Cable"]] },
  ],
};

test("implements all GET action contracts against synthetic Sheets", async () => {
  const harness = createSheetsHarness(companyData);
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-04T04:00:00Z") });
  const actions = [
    ["ping", {}],
    ["today", { company: "SCL" }],
    ["duplicateFault", { company: "SCL", serialNos: "1234", reason: "Hardware Problem", date: "2026/08/04" }],
    ["submissionWarnings", { records: [{ company: "SCL", casino: "Venetian", model: "SAE", serialNo: "1234" }] }],
    ["dashboard", { company: "SCL", page: "1", pageSize: "10", serialNo: "1234" }],
    ["parts", {}],
    ["template", { company: "SCL" }],
    ["aaTags", { company: "MGM" }],
    ["brokenPartsList", { company: "SCL", page: "1", pageSize: "10" }],
    ["monthlyStats", { month: "2608" }],
    ["monthlyStatsBase", { month: "2608" }],
    ["monthlyStatsCompany", { company: "SCL", month: "2608" }],
    ["scheduleMachineCounts", { month: "2608" }],
    ["scheduleOverview", { from: "2026/08/04", days: "7" }],
    ["monthlySettings", {}],
  ];
  for (const [action, params] of actions) {
    const result = await repository.getAction({ action, ...params });
    assert.notEqual(result, undefined, action);
    if (action === "ping") assert.equal(result.success, true, action);
    if (action === "today") assert.ok(Array.isArray(result.records), action);
    if (action === "parts") assert.ok(Array.isArray(result.parts), action);
    if (action === "aaTags") assert.ok(Array.isArray(result.tags), action);
    if (action === "template") assert.ok(Array.isArray(result.mappings), action);
    if (action === "submissionWarnings") assert.ok(Array.isArray(result.warnings), action);
    if (["dashboard", "brokenPartsList", "monthlyStats", "monthlyStatsBase", "monthlyStatsCompany", "scheduleMachineCounts", "scheduleOverview", "monthlySettings"].includes(action)) {
      assert.equal(result.success, true, action);
    }
  }
  assert.equal((await repository.getAction({ action: "parts" })).parts.length, 2);
  assert.equal((await repository.getAction({ action: "aaTags", company: "MGM" })).tags[0].aaTag, "TAE0051");
});

test("returns current submission warnings with row identity", async () => {
  const harness = createSheetsHarness(companyData);
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-04T04:00:00Z") });
  const result = await repository.getAction({
    action: "submissionWarnings",
    records: [{ company: "SCL", casino: "Venetian", model: "SAE", serialNo: "1234" }],
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.warnings.map(({ company, rowNumber, model, serialNo, holding, waiting }) => ({
    company, rowNumber, model, serialNo, holding, waiting,
  })), [{ company: "SCL", rowNumber: 2, model: "SAE", serialNo: "1234", holding: false, waiting: true }]);
});

test("schedule overview keeps an afternoon remark beyond the legacy T-column range", async () => {
  const headers = Array.from({ length: 23 }, (_, index) => `Person ${index}`);
  headers[0] = "Day";
  headers[1] = "Marco";
  headers[20] = "Marco";
  headers[22] = "Remark";
  const row = Array(23).fill("");
  row[0] = 4;
  row[20] = "VML";
  row[22] = "Afternoon note";
  const harness = createSheetsHarness({ ...companyData, schedule: [{ title: "2026-AUG", values: [[], [], headers, row] }] });
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-04T04:00:00Z") });

  const result = await repository.getAction({ action: "scheduleOverview", from: "2026/08/04", days: "1", refresh: "1" });

  assert.equal(result.days[0].remarks.pm, "Afternoon note");
});

test("updates the requested schedule remark cell and invalidates the schedule read path", async () => {
  const headers = Array.from({ length: 23 }, (_, index) => `Person ${index}`);
  headers[0] = "Day";
  headers[1] = "Marco";
  headers[20] = "Marco";
  headers[22] = "Remark";
  const row = Array(23).fill("");
  row[0] = 4;
  row[20] = "VML";
  const harness = createSheetsHarness({ ...companyData, schedule: [{ title: "2026-AUG", values: [[], [], headers, row] }] });
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-04T04:00:00Z") });

  const result = await repository.postAction({ action: "updateScheduleRemark", month: "2608", date: "2026/08/04", shift: "pm", remark: "Updated afternoon note" });

  assert.equal(result.success, true);
  assert.equal(harness.sheets.get("schedule:2026-AUG").values[3][22], "Updated afternoon note");
});

test("updates only the selected schedule shift and venue personnel", async () => {
  const headers = ["Day", "Marco", "Alex", "Remark", "Marco", "Bea", "Remark"];
  const row = [4, "VML / LON", "VML", "", "VML", "LON", ""];
  const harness = createSheetsHarness({ ...companyData, schedule: [{ title: "2026-AUG", values: [[], [], headers, row] }] });
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-04T04:00:00Z") });

  const result = await repository.postAction({
    action: "updateSchedulePeople",
    month: "2608",
    date: "2026/08/04",
    shift: "am",
    company: "SCL",
    venue: "Londoner",
    people: ["Alex"],
  });

  assert.equal(result.success, true);
  const saved = harness.sheets.get("schedule:2026-AUG").values[3];
  assert.equal(saved[1], "VML");
  assert.equal(saved[2], "VML / LON");
  assert.equal(saved[4], "VML");
  assert.equal(saved[5], "LON");
});

test("finds same non-PM serial and reason within the requested 30-day window", () => {
  const rows = [
    ["Venetian", "2026/08/04", "2608", "SAE", "1234", "Hardware Problem", "Repair", "", "", ""],
    ["Venetian", "2026/07/06", "2607", "SAE", "1234", "Hardware Problem", "Repair", "", "", ""],
    ["Venetian", "2026/07/05", "2607", "SAE", "1234", "Hardware Problem", "Repair", "", "", ""],
    ["Venetian", "2026/07/20", "2607", "SAE", "1234", "PM", "Preventive Maintenance", "", "", ""],
    ["Venetian", "2026/07/20", "2607", "SAE", "9999", "Hardware Problem", "Repair", "", "", ""],
  ];
  assert.deepEqual(getDuplicateFaultsFromRows(rows, {
    company: "SCL",
    serialNos: ["1234", "9999"],
    reason: "Hardware Problem",
    date: "2026/08/04",
    timeZone: "Asia/Hong_Kong",
  }), { "1234": 2, "9999": 1 });
  assert.deepEqual(getDuplicateFaultsFromRows(rows, {
    company: "SCL",
    serialNos: ["1234"],
    reason: "PM",
    date: "2026/08/04",
    timeZone: "Asia/Hong_Kong",
  }), {});
});

test("separates duplicate faults by model when a model is supplied", () => {
  const rows = [
    ["Venetian", "2026/08/04", "2608", "SAE", "1000", "Hardware Problem", "Repair", "", "", ""],
    ["Venetian", "2026/08/03", "2608", "TAE", "1000", "Hardware Problem", "Repair", "", "", ""],
  ];
  assert.deepEqual(getDuplicateFaultsFromRows(rows, {
    company: "SCL",
    model: "TAE",
    serialNos: ["1000"],
    reason: "Hardware Problem",
    date: "2026/08/04",
    timeZone: "Asia/Hong_Kong",
  }), { "1000": 1 });
});

test("passes the selected model through the duplicate read action", async () => {
  const data = structuredClone(companyData);
  data.scl[0].values.push(["Venetian", "2026/08/03", "2608", "TAE", "1000", "Hardware Problem", "Repair", "", "", ""]);
  const harness = createSheetsHarness(data);
  const repository = createRepository({}, { config, sheetsClient: harness.client });
  const result = await repository.getAction({
    action: "duplicateFault",
    company: "SCL",
    model: "TAE",
    serialNos: "1000",
    reason: "Hardware Problem",
    date: "2026/08/04",
  });
  assert.deepEqual(result.duplicates, { "1000": 1 });
});

test("loads shared CVCS options and server-paged record and follow-up results", async () => {
  const harness = createSheetsHarness(companyData);
  const repository = createRepository({}, { config, sheetsClient: harness.client, uuid: () => "synthetic-generated-id" });
  const options = await repository.getAction({ action: "cvcsOptions" });
  assert.deepEqual(options.options.subLocation, ["North", "South"]);
  assert.deepEqual(options.options.reasonAction, [{ reason: "PM", actionTakenNotes: "Inspection" }]);
  assert.deepEqual(options.parts, [{ partsNo: "CV-1", requiredPartsEn: "Cable" }]);
  const records = await repository.getAction({ action: "cvcsRecords", serialNo: "1234", page: "1", pageSize: "10" });
  assert.equal(records.total, 1);
  assert.equal(records.records[0].property, "Venetian");
  const broken = await repository.getAction({ action: "cvcsBrokenParts", status: "Following Up", page: "1", pageSize: "10" });
  assert.equal(broken.total, 1);
  assert.equal(broken.records[0].serialNo, "1234");
});

test("submits CVCS records idempotently and keeps Property queues separate", async () => {
  const harness = createSheetsHarness(companyData);
  const repository = createRepository({}, { config, sheetsClient: harness.client, uuid: () => "synthetic-generated-id" });
  const payload = {
    action: "submitCvcsRecords",
    records: [{
      submissionId: "cvcs-submission-new",
      property: "Plaza",
      date: "2026/08/05",
      location: "TG",
      model: "Reader",
      serialNo: "7777",
      reason: "PM",
      actionTakenNotes: "Inspection",
    }],
  };
  const first = await repository.postAction(payload);
  const second = await repository.postAction(payload);
  assert.equal(first.inserted, 1);
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, 1);
  const rows = harness.sheets.get("cvcs:CVCS Records").values.filter((row) => row[6] === "7777");
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], "Plaza");
});

test("updates CVCS option lists without adding custom record text automatically", async () => {
  const harness = createSheetsHarness(companyData);
  const repository = createRepository({}, { config, sheetsClient: harness.client, uuid: () => "synthetic-option-id" });
  await repository.postAction({ action: "updateCvcsOptions", key: "subLocation", options: ["East", "West"] });
  const options = await repository.getAction({ action: "cvcsOptions", refresh: "1" });
  assert.deepEqual(options.options.subLocation, ["East", "West"]);
  assert.equal(options.options.subLocation.includes("Custom record value"), false);
});

test("edits, bulk edits, and deletes CVCS records with stale snapshot protection", async () => {
  const harness = createSheetsHarness(companyData);
  let id = 0;
  const repository = createRepository({}, { config, sheetsClient: harness.client, uuid: () => `synthetic-record-id-${++id}` });
  const loaded = await repository.getAction({ action: "cvcsRecords", serialNo: "1234", refresh: "1" });
  const original = loaded.records[0];
  await repository.postAction({ action: "updateCvcsRecord", record: original, changes: { reason: "Fault", actionTakenNotes: "Reset" } });
  const edited = (await repository.getAction({ action: "cvcsRecords", serialNo: "1234", refresh: "1" })).records[0];
  assert.equal(edited.reason, "Fault");
  await assert.rejects(repository.postAction({ action: "updateCvcsRecord", record: original, changes: { reason: "Stale" } }), /changed/i);
  await repository.postAction({ action: "bulkUpdateCvcsRecords", records: [edited], changes: { quarter: "Q4" } });
  const bulkEdited = (await repository.getAction({ action: "cvcsRecords", serialNo: "1234", refresh: "1" })).records[0];
  assert.equal(bulkEdited.quarter, "Q4");
  const deleted = await repository.postAction({ action: "deleteCvcsRecord", record: bulkEdited });
  assert.equal(deleted.deleted, 1);
  assert.equal((await repository.getAction({ action: "cvcsRecords", serialNo: "1234", refresh: "1" })).total, 0);
});

test("submits and completes CVCS follow-up records without requiring a part", async () => {
  const harness = createSheetsHarness(companyData);
  let id = 0;
  const repository = createRepository({}, { config, sheetsClient: harness.client, uuid: () => `synthetic-broken-id-${++id}` });
  const payload = {
    action: "submitCvcsBrokenParts",
    records: [{ submissionId: "follow-up-new", property: "Sands", model: "SCP", serialNo: "2222", requestFollowUpDate: "2026/08/05" }],
  };
  assert.equal((await repository.postAction(payload)).inserted, 1);
  assert.equal((await repository.postAction(payload)).skipped, 1);
  const waiting = (await repository.getAction({ action: "cvcsBrokenParts", serialNo: "2222", refresh: "1" })).records[0];
  assert.equal(waiting.partsNo, "");
  await repository.postAction({ action: "updateCvcsBrokenPart", record: waiting, changes: { followUpCompletedDate: "2026/08/06" } });
  const completed = (await repository.getAction({ action: "cvcsBrokenParts", status: "Follow-up Completed", serialNo: "2222", refresh: "1" })).records[0];
  assert.equal(completed.followUpCompletedDate, "2026/08/06");
});

test("does not read the Broken Parts List for a normal submission", async () => {
  const harness = createSheetsHarness(companyData);
  let brokenReads = 0;
  const sheetsClient = {
    ...harness.client,
    async valuesGet(options) {
      if (String(options.range).includes("Broken Parts List")) brokenReads += 1;
      return harness.client.valuesGet(options);
    },
  };
  const repository = createRepository({}, { config, sheetsClient, uuid: () => "normal-submission-id" });
  const result = await repository.postAction({
    action: "submitRecords",
    records: [{
      submissionId: "normal-submission-id",
      company: "SCL",
      casino: "Venetian",
      date: "2026/08/04",
      poNumber: "",
      model: "SAE",
      serialNo: "2345",
      reason: "PM",
      actionTaken: "Preventive Maintenance",
    }],
  });
  assert.equal(result.success, true);
  assert.equal(brokenReads, 0);
});

test("updates selected Hold release without clearing the existing Repair Day", async () => {
  const data = structuredClone(companyData);
  data.scl[1].values[1][12] = "2026/08/01";
  const harness = createSheetsHarness(data);
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-04T04:00:00Z") });
  const result = await repository.postAction({
    action: "submitRecords",
    brokenPartsRepairs: [{
      company: "SCL",
      record: { rowNumber: 2, model: "SAE", serialNo: "1234", brokenParts: "AE-1", bpHoldReleaseDate: "2026/08/04" },
    }],
    records: [{
      submissionId: "hold-release-submit",
      company: "SCL",
      casino: "Venetian",
      date: "2026/08/04",
      poNumber: "2608",
      model: "SAE",
      serialNo: "4321",
      reason: "PM",
      actionTaken: "Preventive Maintenance",
    }],
  });
  assert.equal(result.success, true);
  assert.equal(harness.sheets.get("scl:Broken Parts List").values[1][7], "Waiting");
  assert.equal(harness.sheets.get("scl:Broken Parts List").values[1][13], "2026/08/04");
});

test("updates selected Waiting Parts status to today's Repair Day", async () => {
  const harness = createSheetsHarness(companyData);
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-04T04:00:00Z") });
  await repository.postAction({
    action: "submitRecords",
    brokenPartsRepairs: [{
      company: "SCL",
      record: { rowNumber: 2, model: "SAE", serialNo: "1234", brokenParts: "AE-1", bpRepairDay: "2026/08/04" },
    }],
    records: [{
      submissionId: "waiting-parts-submit",
      company: "SCL",
      casino: "Venetian",
      date: "2026/08/04",
      poNumber: "2608",
      model: "SAE",
      serialNo: "4322",
      reason: "PM",
      actionTaken: "Preventive Maintenance",
    }],
  });
  assert.equal(harness.sheets.get("scl:Broken Parts List").values[1][7], "2026/08/04");
});

test("shares monthly statistics for ten minutes across Worker instances", async () => {
  const harness = createSheetsHarness(companyData);
  let nowMs = Date.parse("2026-08-04T04:00:00Z");
  let valuesReads = 0;
  const sheetsClient = {
    ...harness.client,
    async valuesGet(options) {
      valuesReads += 1;
      return harness.client.valuesGet(options);
    },
  };
  const entries = new Map();
  const cacheAdapter = {
    async get(key) {
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= nowMs) return null;
      return entry.value;
    },
    async put(key, value, ttlMs) {
      entries.set(key, { value, expiresAt: nowMs + ttlMs });
    },
  };
  const firstRepository = createRepository({}, {
    config,
    sheetsClient,
    cacheAdapter,
    memoryCache: new Map(),
    now: () => nowMs,
  });

  await firstRepository.getAction({ action: "monthlyStats", month: "2608" });
  const readsAfterFirstLoad = valuesReads;
  assert.ok(readsAfterFirstLoad > 0);

  nowMs += 20_000;
  const secondRepository = createRepository({}, {
    config,
    sheetsClient,
    cacheAdapter,
    memoryCache: new Map(),
    now: () => nowMs,
  });
  await secondRepository.getAction({ action: "monthlyStats", month: "2608" });
  assert.equal(valuesReads, readsAfterFirstLoad);

  await secondRepository.getAction({ action: "monthlyStats", month: "2608", refresh: "1" });
  assert.ok(valuesReads > readsAfterFirstLoad);
});

test("uses hidden submission IDs to make repeated submissions idempotent", async () => {
  const harness = createSheetsHarness(companyData);
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-04T04:00:00Z"), uuid: () => "generated-id-1" });
  const record = {
    company: "SCL",
    casino: "Venetian",
    date: "2026/08/04",
    poNumber: "2608",
    model: "SAE",
    serialNo: "9876",
    reason: "PM",
    actionTaken: "Preventive Maintenance",
    submissionId: "submission-id-1",
  };
  const first = await repository.postAction({ action: "submitRecords", records: [record] });
  const second = await repository.postAction({ action: "submitRecords", records: [record] });
  assert.equal(first.inserted, 1);
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, 1);
  const dashboard = await repository.getAction({ action: "dashboard", company: "SCL", serialNo: "9876", page: "1", pageSize: "10" });
  assert.equal(dashboard.totalMatches, 1);
});

test("writes Template mappings as two-dimensional Sheet rows", async () => {
  const harness = createSheetsHarness(companyData);
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-04T04:00:00Z") });

  const result = await repository.postAction({
    action: "updateTemplate",
    company: "SCL",
    mappings: [{ reason: "TEST", action: "Synthetic Action" }],
  });

  assert.equal(result.success, true);
  assert.deepEqual(harness.sheets.get("scl:Template").values.slice(0, 2), [
    ["Reason", "Action Taken"],
    ["TEST", "Synthetic Action"],
  ]);
});

test("writes an edited Broken Parts record as one complete Sheet row", async () => {
  const harness = createSheetsHarness(companyData);
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-04T04:00:00Z") });

  const result = await repository.postAction({
    action: "updateBrokenPartsList",
    company: "SCL",
    records: [{
      rowNumber: 2,
      casino: "Venetian",
      model: "SAE",
      serialNo: "1234",
      brokenParts: "AE-1",
      bpDesc: "TEST PART",
      bpColC: "TEST PART EN",
      bpQty: "2",
      bpRepairDay: "Waiting",
      foundDay: "2026/08/04",
      bpRemark: "updated remark",
    }],
    deletedRowNumbers: [],
  });

  assert.equal(result.success, true);
  assert.equal(harness.sheets.get("scl:Broken Parts List").values[1][9], "updated remark");
});

test("writes the edited UOD unlock date instead of the stale alias", async () => {
  const harness = createSheetsHarness(companyData);
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-11T04:00:00Z") });

  const result = await repository.postAction({
    action: "updateBrokenPartsList",
    company: "SCL",
    records: [{
      rowNumber: 2,
      casino: "Venetian",
      model: "TAE",
      serialNo: "1234",
      brokenParts: "",
      bpUodActivationDate: "2026/07/22",
      bpUodUnlockDate: "Wait for Unlock",
      bpUodUnlockDay: "2026/08/11",
    }],
    deletedRowNumbers: [],
  });

  assert.equal(result.success, true);
  assert.equal(harness.sheets.get("scl:Broken Parts List").values[1][11], "2026/08/11");
});

test("bulk updates the requested Broken Parts fields for every selected snapshot", async () => {
  const data = structuredClone(companyData);
  data.scl[1].values.push(["Londoner", "TAE", "5678", "TAE-1", "部品2", "PART2", "1", "Waiting", "2026/08/05", "", "", "Wait for Unlock", "", ""]);
  const harness = createSheetsHarness(data);
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-11T04:00:00Z") });
  const page = await repository.getAction({ action: "brokenPartsList", company: "SCL", page: "1", pageSize: "10", sort: "oldest" });

  const result = await repository.postAction({
    action: "bulkUpdateBrokenPartsRecords",
    company: "SCL",
    records: page.records,
    changes: { bpRepairDay: "2026/08/11", bpRemark: "completed" },
  });

  const rows = harness.sheets.get("scl:Broken Parts List").values;
  assert.deepEqual(result, { success: true, saved: 2 });
  assert.equal(rows[1][7], "2026/08/11");
  assert.equal(rows[2][7], "2026/08/11");
  assert.equal(rows[1][9], "completed");
  assert.equal(rows[2][9], "completed");
});

test("bulk Broken Parts update rejects Serial No changes", async () => {
  const harness = createSheetsHarness(companyData);
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-11T04:00:00Z") });
  const page = await repository.getAction({ action: "brokenPartsList", company: "SCL", page: "1", pageSize: "10" });

  await assert.rejects(
    repository.postAction({
      action: "bulkUpdateBrokenPartsRecords",
      company: "SCL",
      records: page.records,
      changes: { serialNo: "9999" },
    }),
    /Unsupported Broken Parts field/,
  );
  assert.equal(harness.sheets.get("scl:Broken Parts List").values[1][2], "1234");
});

test("bulk Broken Parts update rejects stale snapshots before writing any row", async () => {
  const data = structuredClone(companyData);
  data.scl[1].values.push(["Londoner", "TAE", "5678", "TAE-1", "部品2", "PART2", "1", "Waiting", "2026/08/05", "", "", "", "", ""]);
  const harness = createSheetsHarness(data);
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-11T04:00:00Z") });
  const page = await repository.getAction({ action: "brokenPartsList", company: "SCL", page: "1", pageSize: "10", sort: "oldest" });
  harness.sheets.get("scl:Broken Parts List").values[2][9] = "changed in Sheet";

  await assert.rejects(
    repository.postAction({
      action: "bulkUpdateBrokenPartsRecords",
      company: "SCL",
      records: page.records,
      changes: { bpRepairDay: "2026/08/11" },
    }),
    /Broken Parts record changed; please reload/,
  );
  assert.equal(harness.sheets.get("scl:Broken Parts List").values[1][7], "Waiting");
  assert.equal(harness.sheets.get("scl:Broken Parts List").values[2][7], "Waiting");
});

test("reads Galaxy Log repeated column groups into stable tasks", async () => {
  const harness = createSheetsHarness(companyData);
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-04T04:00:00Z") });

  const result = await repository.getAction({ action: "galaxyLogOverview" });

  assert.equal(result.success, true);
  assert.equal(result.tasks.length, 3);
  assert.deepEqual(result.tasks.map((task) => [task.serialLast4, task.targetDate, task.completedDate, task.groupIndex]), [
    ["1190", "2026-08-01", "", 0],
    ["1191", "2026-08-04", "", 0],
    ["1192", "2026-08-02", "2026-08-03", 1],
  ]);
});

test("carries merged serial numbers down within Galaxy Log columns", async () => {
  const data = structuredClone(companyData);
  data["galaxy-log"] = [{ title: "Galaxy Log", values: [
    ["SN末4位", "指定 Log 日期", "取 Log 日期"],
    ["A02-001190", "2026/5/17", ""],
    ["", "2026/5/16", ""],
    ["A02-001193", "2026/6/2", ""],
    ["", "2026/6/2", ""],
    ["", "2026/5/30", ""],
  ] }];
  const harness = createSheetsHarness(data);
  const repository = createRepository({}, { config, sheetsClient: harness.client });

  const result = await repository.getAction({ action: "galaxyLogOverview", refresh: "1" });

  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.tasks.map((task) => [task.serialLast4, task.targetDate]), [
    ["1190", "2026-05-17"],
    ["1190", "2026-05-16"],
    ["1193", "2026-06-02"],
    ["1193", "2026-06-02"],
    ["1193", "2026-05-30"],
  ]);
  assert.equal(result.tasks[2].fullSerial, "A02-001193");
});

test("detects blank spacer columns between repeated Galaxy Log groups", async () => {
  const data = structuredClone(companyData);
  data["galaxy-log"] = [{ title: "Galaxy Log", values: [
    ["A02-001190", "2026/5/17", "", "", "A02-001193", "2026/6/2", "", ""],
    ["", "2026/5/16", "", "", "", "2026/5/30", "", ""],
  ] }];
  const harness = createSheetsHarness(data);
  const repository = createRepository({}, { config, sheetsClient: harness.client });

  const result = await repository.getAction({ action: "galaxyLogOverview", refresh: "1" });

  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.tasks.map((task) => [task.serialLast4, task.targetDate, task.groupIndex]), [
    ["1190", "2026-05-17", 0],
    ["1190", "2026-05-16", 0],
    ["1193", "2026-06-02", 1],
    ["1193", "2026-05-30", 1],
  ]);
});

test("writes Galaxy completion into the completion column after a spacer", async () => {
  const data = structuredClone(companyData);
  data["galaxy-log"] = [{ title: "Galaxy Log", values: [
    ["A02-001190", "2026/5/17", "", "", "A02-001193", "2026/6/2", "", ""],
  ] }];
  const harness = createSheetsHarness(data);
  const repository = createRepository({}, { config, sheetsClient: harness.client });
  const overview = await repository.getAction({ action: "galaxyLogOverview", refresh: "1" });
  const target = overview.tasks.find((task) => task.serialLast4 === "1193");

  const result = await repository.postAction({
    action: "syncGalaxyLog",
    mutations: [{ taskId: target.id, patch: { completedDate: "2026/9/1", status: "done" }, baseCompletedDate: "" }],
  });

  assert.equal(result.results[0].status, "applied");
  assert.equal(harness.sheets.get("galaxy-log:Galaxy Log").values[0][2], "");
  assert.equal(harness.sheets.get("galaxy-log:Galaxy Log").values[0][6], "2026-09-01");
});

test("writes a no-log marker and returns the no_log task status", async () => {
  const data = structuredClone(companyData);
  data["galaxy-log"] = [{ title: "Galaxy Log", values: [
    ["SN末4位", "指定 Log 日期", "取 Log 日期"],
    ["1190", "2026/08/01", ""],
  ] }];
  const harness = createSheetsHarness(data);
  const repository = createRepository({}, { config, sheetsClient: harness.client });
  const overview = await repository.getAction({ action: "galaxyLogOverview", refresh: "1" });
  const result = await repository.postAction({
    action: "syncGalaxyLog",
    mutations: [{ taskId: overview.tasks[0].id, patch: { status: "no_log", completedDate: "" }, baseCompletedDate: "" }],
  });

  assert.equal(result.results[0].status, "applied");
  assert.equal(result.tasks[0].status, "no_log");
  assert.equal(harness.sheets.get("galaxy-log:Galaxy Log").values[1][2], "沒有當天 Log");
});

test("reads a public CSV export when the configured Galaxy workbook is still an Office file", async () => {
  const officeError = Object.assign(new Error("Google Sheets request failed (400)"), {
    status: 400,
    details: {
      error: {
        status: "FAILED_PRECONDITION",
        message: "This operation is not supported for this document. The document must not be an Office file.",
      },
    },
  });
  const sheetsClient = {
    async request() { throw officeError; },
    async valuesGet() { throw officeError; },
  };
  const repository = createRepository({}, {
    config,
    sheetsClient,
    publicFetch: async () => new Response("A02-001190,2026/5/17,,A02-002086,2026/6/18,2026/8/31\r\n", {
      status: 200,
      headers: { "content-type": "text/csv" },
    }),
  });

  const result = await repository.getAction({ action: "galaxyLogOverview", refresh: "1" });

  assert.equal(result.success, true);
  assert.equal(result.readOnly, true);
  assert.deepEqual(result.tasks.map((task) => [task.serialLast4, task.targetDate, task.completedDate]), [
    ["1190", "2026-05-17", ""],
    ["2086", "2026-06-18", "2026-08-31"],
  ]);
});

test("refuses Galaxy Log writes while the source is an Office file", async () => {
  const officeError = Object.assign(new Error("Google Sheets request failed (400)"), {
    status: 400,
    details: { error: { status: "FAILED_PRECONDITION", message: "The document must not be an Office file." } },
  });
  const repository = createRepository({}, {
    config,
    sheetsClient: { async request() { throw officeError; }, async valuesGet() { throw officeError; } },
    publicFetch: async () => new Response("1190,2026/5/17,\r\n", { status: 200 }),
  });

  await assert.rejects(
    repository.postAction({ action: "syncGalaxyLog", mutations: [{ taskId: "gx-office", patch: { completedDate: "2026-09-01" } }] }),
    /原生 Google 試算表/,
  );
});

test("normalizes common locale-formatted Galaxy dates", async () => {
  const data = structuredClone(companyData);
  data["galaxy-log"] = [{ title: "Galaxy Log", values: [
    ["SN末4位", "指定 Log 日期", "取 Log 日期"],
    ["1190", "9/1/2026", "9/2/2026"],
  ] }];
  const harness = createSheetsHarness(data);
  const repository = createRepository({}, { config, sheetsClient: harness.client });

  const result = await repository.getAction({ action: "galaxyLogOverview", refresh: "1" });

  assert.deepEqual(result.tasks.map((task) => [task.targetDate, task.completedDate, task.status]), [["2026-09-01", "2026-09-02", "done"]]);
});

test("syncs Galaxy Log completion idempotently and reports a cloud conflict", async () => {
  const harness = createSheetsHarness(companyData);
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-04T04:00:00Z") });
  const overview = await repository.getAction({ action: "galaxyLogOverview" });
  const target = overview.tasks[0];
  const mutation = { mutationId: "mutation-1", taskId: target.id, patch: { completedDate: "2026-08-05", status: "done" }, baseCompletedDate: "" };

  const first = await repository.postAction({ action: "syncGalaxyLog", mutations: [mutation] });
  assert.equal(first.results[0].status, "applied");
  assert.equal(harness.sheets.get("galaxy-log:Galaxy Log").values[1][2], "2026-08-05");

  const second = await repository.postAction({ action: "syncGalaxyLog", mutations: [mutation] });
  assert.equal(second.results[0].status, "applied");
  assert.equal(harness.sheets.get("galaxy-log:Galaxy Log").values[1][2], "2026-08-05");

  harness.sheets.get("galaxy-log:Galaxy Log").values[1][2] = "2026-08-06";
  const conflict = await repository.postAction({ action: "syncGalaxyLog", mutations: [mutation] });
  assert.equal(conflict.results[0].status, "conflict");
  assert.equal(harness.sheets.get("galaxy-log:Galaxy Log").values[1][2], "2026-08-06");
});

test("appends a new Galaxy task into its requested repeated-column group", async () => {
  const data = structuredClone(companyData);
  data["galaxy-log"] = [{ title: "Galaxy Log", columnCount: 3, values: [
    ["SN末4位", "指定 Log 日期", "取 Log 日期"],
    ["1190", "2026/08/01", ""],
  ] }];
  const harness = createSheetsHarness(data);
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-04T04:00:00Z") });

  const result = await repository.postAction({
    action: "syncGalaxyLog",
    mutations: [{
      mutationId: "mutation-new-group",
      taskId: "local-only-task",
      patch: { serialLast4: "2290", targetDate: "2026-08-02", groupIndex: 1, rowIndex: 2, completedDate: "2026-08-04", status: "done" },
      baseCompletedDate: "",
    }],
  });

  assert.equal(result.results[0].status, "applied");
  const saved = harness.sheets.get("galaxy-log:Galaxy Log").values[1];
  assert.deepEqual(saved.slice(3, 6), ["2290", "2026-08-02", "2026-08-04"]);
});
