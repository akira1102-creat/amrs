import assert from "node:assert/strict";
import test from "node:test";

import {
  BROKEN_PARTS_HEADERS,
  GEG_MONTHLY_TARGETS,
  MONTHLY_VENUES,
  aaTagsFromRows,
  brokenPartsRecordFromRow,
  brokenPartsRecordToValues,
  brokenPartsDate,
  combineMonthlyStats,
  companySchema,
  formatSheetDate,
  getBrokenPartsPage,
  getBrokenPartsRecords,
  getBrokenPartsStats,
  getDashboardRecords,
  getInspectorColumn,
  getMonthlyScheduleFromRows,
  getRecordWidth,
  isMonthlyVisitCompleted,
  mergeRecord,
  monthlyStatsCompanyFromRows,
  normalizeAaTag,
  normalizeCompany,
  normalizeDateParam,
  normalizeMonthlyCode,
  partsCodesFromRows,
  parseScheduleOverviewDate,
  recordFromRow,
  recordToValues,
  recordsMatch,
  scheduleAliasesInText,
  scheduleIsoDate,
  scheduleMonthCode,
  scheduleOverviewFromRows,
  scheduleSheetName,
  scheduleAssignmentWithVenue,
  scheduleAssignmentWithoutVenue,
  scheduleVenueEntriesInText,
  scheduleVenueLink,
  validateEditedRecord,
  validateHoldDates,
  validateIncomingRecord,
} from "../src/domain.mjs";

function validRecord(overrides = {}) {
  return {
    company: "SCL",
    casino: "Venetian",
    date: "2026/08/04",
    poNumber: "PO-TEST",
    model: "SAE",
    serialNo: "123",
    reason: "Error",
    actionTaken: "Repair",
    errorDescription: "Synthetic test",
    boxId: "BOX-1",
    inspector: "Inspector A",
    ...overrides,
  };
}

function brokenRow({
  casino = "Venetian",
  model = "SAE",
  serialNo = "123",
  partsNo = "P-001",
  desc = "Synthetic part",
  colC = "C",
  qty = "1",
  repairDay = "waiting",
  foundDay = "2026/08/04",
  remark = "",
  activation = "",
  unlock = "wait for unlock",
  hold = "2026/08/04",
  release = "",
} = {}) {
  return [casino, model, serialNo, partsNo, desc, colC, qty, repairDay, foundDay, remark, activation, unlock, hold, release];
}

test("normalizes dates with validation and the GAS display shapes", () => {
  assert.equal(normalizeDateParam("2026-8-4T10:00:00+08:00"), "2026/08/04");
  assert.equal(normalizeDateParam("2024/02/29"), "2024/02/29");
  assert.equal(normalizeDateParam("2025/02/29"), "");
  assert.equal(normalizeDateParam(new Date("2026-08-03T16:30:00.000Z")), "2026/08/04");
  assert.equal(formatSheetDate(new Date("2026-08-03T16:30:00.000Z")), "2026/08/04");
  assert.equal(brokenPartsDate(new Date("2026-08-03T16:30:00.000Z")), "2026/8/4");
  assert.equal(brokenPartsDate("2026-08-04T10:00:00.000Z"), "2026/8/4");
  assert.equal(brokenPartsDate("waiting"), "waiting");
});

test("maps company schemas without sheet services", () => {
  assert.equal(normalizeCompany("mgm"), "MGM");
  assert.equal(normalizeCompany("unknown"), "SCL");
  assert.equal(getRecordWidth("GEG"), 12);
  assert.equal(getRecordWidth("MGM"), 11);
  assert.equal(getRecordWidth("SCL"), 10);
  assert.equal(getInspectorColumn("GEG"), 12);
  assert.equal(companySchema("MGM").fields.at(-1), "location");
});

test("maps GEG and MGM rows to the stable record contract", () => {
  const geg = recordFromRow(
    ["Galaxy", "2026/08/04", "PO-G", "TAE", "7", "12345", "54321", "Error", "Repair", "Details", "BOX", "I-A"],
    "2026/08/04",
    2,
    "GEG",
    "record-geg",
  );
  assert.deepEqual(geg, {
    rowNumber: 2,
    recordId: "record-geg",
    company: "GEG",
    casino: "Galaxy",
    date: "2026/08/04",
    poNumber: "PO-G",
    model: "TAE",
    serialNo: "7",
    voidSeal: "12345",
    newVoidSeal: "54321",
    reason: "Error",
    actionTaken: "Repair",
    errorDescription: "Details",
    boxId: "BOX",
    inspector: "I-A",
  });

  const mgm = recordFromRow(
    ["MGM Macau", "2026/08/04", "PO-M", "SAE", "8", "Error", "Repair", "Details", "BOX", "I-B", "Floor"],
    "2026/08/04",
    3,
    "MGM",
  );
  assert.equal(mgm.location, "Floor");
  assert.equal(mgm.company, "MGM");
});

test("writes records in the company-specific GAS column order", () => {
  const geg = validRecord({
    company: "GEG",
    casino: "Galaxy",
    model: "TAE",
    voidSeal: "12345",
    newVoidSeal: "54321",
  });
  assert.deepEqual(recordToValues(geg, "GEG"), [
    "Galaxy", "2026/08/04", "PO-TEST", "TAE", "123", "12345", "54321", "Error", "Repair", "Synthetic test", "BOX-1", "Inspector A",
  ]);
  assert.deepEqual(recordToValues(validRecord({ company: "MGM", location: "Workshop" }), "MGM"), [
    "Venetian", "2026/08/04", "PO-TEST", "SAE", "123", "Error", "Repair", "Synthetic test", "BOX-1", "Inspector A", "Workshop",
  ]);
});

test("merges editable fields while preserving row identity and detects stale edits", () => {
  const original = recordFromRow(
    ["Venetian", "2026/08/04", "PO-TEST", "SAE", "123", "Error", "Repair", "Details", "BOX", "I-A"],
    "2026/08/04",
    4,
    "SCL",
    "record-4",
  );
  const merged = mergeRecord(original, { company: "MGM", rowNumber: 999, reason: "Updated", inspector: "I-B" });
  assert.equal(merged.company, "SCL");
  assert.equal(merged.rowNumber, 4);
  assert.equal(merged.reason, "Updated");
  assert.equal(merged.recordId, "record-4");
  assert.equal(recordsMatch(original, { ...original }, "SCL"), true);
  assert.equal(recordsMatch(original, { ...original, inspector: "other" }, "SCL"), false);
  assert.equal(recordsMatch({ ...original, location: "Floor" }, { ...original, location: "Workshop" }, "MGM"), false);
});

test("validates incoming and edited records with GAS error messages", () => {
  assert.doesNotThrow(() => validateIncomingRecord(validRecord({ bpQty: "2", bpUodActivationDate: "2026/08/04", bpUodUnlockDate: "wait for unlock" })));
  assert.throws(() => validateIncomingRecord(validRecord({ serialNo: "12345" })), { message: "Serial No. must be 1-4 digits" });
  assert.throws(() => validateIncomingRecord(validRecord({ date: "2026/02/30" })), { message: "Invalid date" });
  assert.throws(() => validateIncomingRecord(validRecord({ model: "XYZ" })), { message: "Invalid model" });
  assert.throws(() => validateIncomingRecord(validRecord({ location: "Lobby" })), { message: "Invalid MGM location" });
  assert.throws(() => validateIncomingRecord(validRecord({ bpQty: "0" })), { message: "Invalid parts quantity" });
  assert.throws(() => validateHoldDates({ bpHoldReleaseDate: "2026/08/04" }), { message: "Hold date is required before release" });
  assert.throws(() => validateHoldDates({ bpHoldDate: "2026/08/05", bpHoldReleaseDate: "2026/08/04" }), { message: "Hold release date cannot be earlier than hold date" });
  assert.throws(() => validateEditedRecord(validRecord({ model: "XYZ" }), validRecord(), { model: "XYZ" }), { message: "Invalid model" });
  assert.doesNotThrow(() => validateEditedRecord(validRecord({ actionTaken: "" }), validRecord(), { actionTaken: "" }));
});

test("maps parts rows and broken-part records", () => {
  assert.deepEqual(partsCodesFromRows([["P-1", "Filter", "C1"], ["", "Ignored", ""], ["P-2", "", "C2"]]), [
    { code: "P-1", label: "P-1 Filter", desc: "Filter", colC: "C1" },
    { code: "P-2", label: "P-2 ", desc: "", colC: "C2" },
  ]);
  const row = brokenRow({ repairDay: "2026/08/05", unlock: "2026/08/06", hold: "2026/08/04", release: "2026/08/05" });
  assert.deepEqual(brokenPartsRecordFromRow(row, 9), {
    rowNumber: 9,
    casino: "Venetian",
    model: "SAE",
    serialNo: "123",
    brokenParts: "P-001",
    bpDesc: "Synthetic part",
    bpColC: "C",
    bpQty: "1",
    bpRepairDay: "2026/08/05",
    date: "2026/08/04",
    bpRemark: "",
    bpUodActivationDate: "",
    bpUodUnlockDay: "2026/08/06",
    bpUodUnlockDate: "2026/08/06",
    bpHoldDate: "2026/08/04",
    bpHoldReleaseDate: "2026/08/05",
  });
  assert.deepEqual(brokenPartsRecordToValues(brokenPartsRecordFromRow(row, 9)), row);
  assert.equal(brokenPartsRecordToValues({
    bpUodUnlockDate: "Wait for Unlock",
    bpUodUnlockDay: "2026/08/11",
  })[11], "2026/08/11");
});

test("filters, sorts, and paginates broken-part rows by status", () => {
  const rows = [
    [...BROKEN_PARTS_HEADERS],
    brokenRow({ serialNo: "101", partsNo: "P-WAIT", repairDay: "waiting", unlock: "wait for unlock", hold: "2026/08/04", release: "" }),
    brokenRow({ serialNo: "102", partsNo: "P-DONE", repairDay: "2026/08/05", unlock: "2026/08/06", hold: "2026/08/04", release: "2026/08/05" }),
  ];
  assert.equal(getBrokenPartsRecords(rows, "", { status: "waiting" })[0].serialNo, "101");
  assert.equal(getBrokenPartsRecords(rows, "", { status: "repaired" })[0].serialNo, "102");
  assert.equal(getBrokenPartsRecords(rows, "", { status: "uod-waiting" })[0].serialNo, "101");
  assert.equal(getBrokenPartsRecords(rows, "", { status: "uod-unlocked" })[0].serialNo, "102");
  assert.equal(getBrokenPartsRecords(rows, "", { status: "holding" })[0].serialNo, "101");
  assert.equal(getBrokenPartsRecords(rows, "", { status: "hold-released" })[0].serialNo, "102");
  const page = getBrokenPartsPage(rows, "", { sort: "newest", page: 1, pageSize: 1 });
  assert.deepEqual(page, {
    success: true,
    records: [brokenPartsRecordFromRow(rows[2], 3)],
    page: 1,
    pageSize: 1,
    totalMatches: 2,
    totalPages: 2,
    sort: "newest",
  });
  assert.equal(getBrokenPartsPage(rows, "", { sort: "oldest", page: 2, pageSize: 1 }).records[0].serialNo, "102");
  assert.deepEqual(getBrokenPartsStats(rows, { serialNo: "101" }), {
    records: [brokenPartsRecordFromRow(rows[1], 2)],
    topParts: [{ label: "P-WAIT", count: 1 }],
  });
});

test("filters dashboard rows and computes full-result statistics", () => {
  const rows = [
    ["Venetian", "2026/08/01", "PO-1", "SAE", "7", "Error", "Repair", "D", "B", "I-A", "record-a"],
    ["Venetian", "2026/08/02", "PO-2", "SAE", "7", "Error", "Repair", "D", "B", "I-B", "record-b"],
    ["Londoner", "2026/08/03", "PO-3", "TAE", "8", "Jam", "Replace", "D", "B", "I-C", "record-c"],
  ];
  const result = getDashboardRecords(rows, {
    company: "SCL",
    serialNo: "7",
    sort: "newest",
    page: 1,
    pageSize: 1,
    includeParts: "0",
  }, { idColumn: 11 });
  assert.equal(result.success, true);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].recordId, "record-b");
  assert.equal(result.totalMatches, 2);
  assert.deepEqual(result.stats.models, { SAE: 2 });
  assert.deepEqual(result.stats.repeatSerials, [{ label: "7", count: 2 }]);
  assert.deepEqual(result.history, {
    serialNo: "7",
    total: 2,
    latestDate: "2026/08/02",
    casinos: ["Venetian"],
    topReasons: [{ label: "Error", count: 2 }],
    parts: null,
  });
  const queryResult = getDashboardRecords(rows, { company: "SCL", q: "londoner", sort: "oldest" });
  assert.equal(queryResult.records[0].serialNo, "8");
});

test("normalizes AA tags and drops invalid rows", () => {
  assert.equal(normalizeAaTag("TAE12"), "TAE0012");
  assert.equal(normalizeAaTag("AA-7"), "TAE0007");
  assert.equal(normalizeAaTag(""), "");
  assert.deepEqual(aaTagsFromRows([
    ["Serial No.", "AA Tag"],
    ["7", "TAE12"],
    ["89", "AA-3"],
    ["12345", "4"],
    ["bad", "5"],
  ]), [
    { serialNo: "7", aaTag: "TAE0012" },
    { serialNo: "89", aaTag: "TAE0003" },
  ]);
});

test("parses schedule venue aliases and links them to companies", () => {
  assert.deepEqual(scheduleVenueEntriesInText("VML* and VML, plus L’Arc"), [
    { venue: "L’Arc", machineCountExcluded: false },
    { venue: "Venetian", machineCountExcluded: false },
  ]);
  assert.deepEqual(scheduleAliasesInText("LON* VML"), ["Londoner", "Venetian"]);
  assert.deepEqual(scheduleVenueEntriesInText("LON* GX"), [
    { venue: "Londoner", machineCountExcluded: true },
    { venue: "Galaxy", machineCountExcluded: false },
  ]);
  assert.deepEqual(scheduleVenueEntriesInText("Londoner*"), [
    { venue: "Londoner", machineCountExcluded: true },
  ]);
  assert.deepEqual(scheduleVenueLink("Venetian"), { company: "SCL", venue: "Venetian" });
  assert.deepEqual(scheduleVenueLink("Galaxy"), { company: "GEG", venue: "Galaxy" });
  assert.equal(scheduleVenueLink("Unknown"), null);
});

test("builds the weekday schedule overview contract from table rows", () => {
  const headers = Array.from({ length: 20 }, (_, index) => (index === 1 ? "Alex" : index === 12 ? "Bea" : ""));
  const monday = Array(20).fill("");
  monday[0] = "3";
  monday[1] = "VML";
  monday[12] = "VML*";
  const overview = scheduleOverviewFromRows({ from: "2026/08/03", days: 3 }, { "2608": [headers, monday] });
  assert.equal(overview.success, true);
  assert.equal(overview.from, "2026-08-03");
  assert.equal(overview.days.length, 3);
  assert.equal(overview.days[0].items[0].title, "Venetian");
  assert.equal(overview.days[0].items[0].linked, true);
  assert.deepEqual(overview.days[0].items[0].am, [{ name: "Alex", assignment: "VML" }]);
  assert.deepEqual(overview.days[0].items[0].pm, [{ name: "Bea", assignment: "VML*" }]);
  assert.deepEqual(overview.days[0].items[0].machineCountExcluded, { am: false, pm: true });
});

test("maps separate AM and PM schedule remarks from their sections", () => {
  const headers = ["Day", "Marco", "Alex", "Remark", "Marco", "Bea", "Remark"];
  const monday = ["3", "VML", "VML", "Morning note", "VML", "VML", "Afternoon note"];
  const overview = scheduleOverviewFromRows({ from: "2026/08/03", days: 1 }, { "2608": [headers, monday] });
  assert.deepEqual(overview.days[0].remarks, { am: "Morning note", pm: "Afternoon note" });
  assert.deepEqual(overview.days[0].items[0].am.map((person) => person.name), ["Marco", "Alex"]);
  assert.deepEqual(overview.days[0].items[0].pm.map((person) => person.name), ["Marco", "Bea"]);
});

test("exposes shift-specific staff options and removes only the selected venue", () => {
  const headers = ["Day", "Marco", "Alex", "Remark", "Marco", "Bea", "Remark"];
  const monday = ["3", "VML / LON", "", "", "VML", "LON", ""];
  const overview = scheduleOverviewFromRows({ from: "2026/08/03", days: 1 }, { "2608": [headers, monday] });
  assert.deepEqual(overview.days[0].people, { am: ["Marco", "Alex"], pm: ["Marco", "Bea"] });
  assert.equal(scheduleAssignmentWithoutVenue("VML / LON", "Venetian"), "LON");
  assert.equal(scheduleAssignmentWithoutVenue("VML*", "Venetian"), "");
  assert.equal(scheduleAssignmentWithVenue("LON", "Venetian"), "LON / VML");
});

test("combines monthly counts, targets, and schedule visits", () => {
  assert.equal(normalizeMonthlyCode("2608"), "2608");
  assert.throws(() => normalizeMonthlyCode("2613"), { message: "Invalid month" });
  assert.equal(scheduleSheetName("2608"), "2026-AUG");
  const date = parseScheduleOverviewDate("2026/08/03");
  assert.equal(scheduleIsoDate(date), "2026-08-03");
  assert.equal(scheduleMonthCode(date), "2608");
  assert.equal(isMonthlyVisitCompleted("2607", 31, "Venetian", new Date("2026-08-03T04:00:00Z")), true);

  const company = monthlyStatsCompanyFromRows({ company: "SCL", month: "2608", poNumber: "PO-TEST" }, [
    ["Venetian", "2026/08/01", "PO-TEST"],
    ["Venetian", "2026/08/02", "OTHER"],
    ["Londoner", "2026/08/03", "PO-TEST"],
  ]);
  assert.equal(company.counts.Venetian, 1);
  assert.equal(company.counts.Londoner, 1);
  assert.equal(company.counts.Parisian, 0);

  const base = {
    monthCode: "2608",
    scheduleSheet: "2026-AUG",
    monthLabel: "2026年8月",
    scheduleVenues: {
      Venetian: { scheduledVisits: 2, completedVisits: 1, remainingVisits: 1, visitPercent: 50 },
    },
    sclSettings: { poNumber: "PO-TEST", targets: { Venetian: 4 } },
    monthlyVenues: MONTHLY_VENUES,
    gegTargets: GEG_MONTHLY_TARGETS,
  };
  const combined = combineMonthlyStats(base, [company]);
  const scl = combined.companies.find((item) => item.company === "SCL");
  assert.equal(combined.success, true);
  assert.equal(scl.venues.find((item) => item.venue === "Venetian").remaining, 3);
  assert.equal(scl.venues.find((item) => item.venue === "Venetian").percent, 25);
  assert.equal(scl.venues.find((item) => item.venue === "Venetian").machinesPerRemainingVisit, 3);
});

test("maps monthly schedule rows and applies venue-specific completion cutoffs", () => {
  const rows = [];
  const row = Array(20).fill("");
  row[0] = "3";
  row[1] = "VML";
  row[12] = "VML*";
  rows.push(row);
  const schedule = getMonthlyScheduleFromRows(rows, "2608", new Date("2026-08-03T03:00:00.000Z"), "2026-AUG");
  assert.equal(schedule.sheetName, "2026-AUG");
  assert.deepEqual(schedule.venues.Venetian, { scheduledVisits: 1, completedVisits: 0, remainingVisits: 1, visitPercent: 0 });
  const completed = getMonthlyScheduleFromRows(rows, "2608", new Date("2026-08-03T05:00:00.000Z"), "2026-AUG");
  assert.equal(completed.venues.Venetian.completedVisits, 1);
});
