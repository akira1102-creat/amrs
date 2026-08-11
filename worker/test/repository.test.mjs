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
};

test("implements all 14 GET action contracts against synthetic Sheets", async () => {
  const harness = createSheetsHarness(companyData);
  const repository = createRepository({}, { config, sheetsClient: harness.client, now: () => Date.parse("2026-08-04T04:00:00Z") });
  const actions = [
    ["ping", {}],
    ["today", { company: "SCL" }],
    ["duplicateFault", { company: "SCL", serialNos: "1234", reason: "Hardware Problem", date: "2026/08/04" }],
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
    if (["dashboard", "brokenPartsList", "monthlyStats", "monthlyStatsBase", "monthlyStatsCompany", "scheduleMachineCounts", "scheduleOverview", "monthlySettings"].includes(action)) {
      assert.equal(result.success, true, action);
    }
  }
  assert.equal((await repository.getAction({ action: "parts" })).parts.length, 2);
  assert.equal((await repository.getAction({ action: "aaTags", company: "MGM" })).tags[0].aaTag, "TAE0051");
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
