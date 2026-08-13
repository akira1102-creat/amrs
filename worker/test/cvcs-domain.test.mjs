import assert from "node:assert/strict";
import test from "node:test";

import {
  CVCS_BROKEN_PARTS_HEADERS,
  CVCS_OPTION_SHEETS,
  CVCS_PROPERTIES,
  CVCS_RECORD_HEADERS,
  cvcsBrokenPartFromRow,
  cvcsBrokenPartStatus,
  cvcsBrokenPartToValues,
  cvcsRecordFromRow,
  cvcsRecordToValues,
  getCvcsBrokenPartsPage,
  getCvcsRecordPage,
  normalizeCvcsBrokenPart,
  normalizeCvcsRecord,
} from "../src/cvcs-domain.mjs";

function record(overrides = {}) {
  return {
    property: "Venetian",
    date: "2026/08/13",
    location: "Cage",
    subLocation: "North",
    quarter: "Q1",
    model: "SOT",
    serialNo: "1234",
    antennaSize: "Large",
    antennaStatus: "Active",
    version: "1.0",
    reason: "PM",
    actionTakenNotes: "Inspection",
    partsChange: "Cable",
    submissionId: "cvcs-submission-synthetic",
    ...overrides,
  };
}

test("declares the approved properties, headers, and shared option sheets", () => {
  assert.deepEqual(CVCS_PROPERTIES, ["Venetian", "Londoner", "Sands", "Plaza", "Parisian"]);
  assert.equal(CVCS_RECORD_HEADERS.length, 13);
  assert.equal(CVCS_BROKEN_PARTS_HEADERS.length, 11);
  assert.deepEqual(Object.keys(CVCS_OPTION_SHEETS), ["subLocation", "antennaSize", "antennaStatus", "version", "reasonAction", "partsChange"]);
});

test("normalizes required CVCS record fields and defaults Reason to PM", () => {
  const normalized = normalizeCvcsRecord(record({ reason: "", actionTakenNotes: "", quarter: "" }));
  assert.equal(normalized.reason, "PM");
  assert.equal(normalized.quarter, "");
  assert.equal(normalized.date, "2026/08/13");
  assert.throws(() => normalizeCvcsRecord(record({ location: "" })), /Location/);
  assert.throws(() => normalizeCvcsRecord(record({ model: "Unknown" })), /Model/);
  assert.throws(() => normalizeCvcsRecord(record({ property: "Unknown" })), /Property/);
  assert.throws(() => normalizeCvcsRecord(record({ date: "2026/02/30" })), /Date/);
});

test("round-trips a CVCS record through the sheet value order", () => {
  const values = cvcsRecordToValues(record());
  assert.equal(values.length, 13);
  assert.equal(values[0], "Venetian");
  assert.equal(values[6], "1234");
  const restored = cvcsRecordFromRow(values, 12, "record-synthetic");
  assert.equal(restored.rowNumber, 12);
  assert.equal(restored.recordId, "record-synthetic");
  assert.equal(restored.actionTakenNotes, "Inspection");
});

test("applies exact S/N by default and fuzzy matching only when requested", () => {
  const rows = [
    record({ serialNo: "1234", subLocation: "Alpha" }),
    record({ serialNo: "91234", subLocation: "Beta" }),
    record({ serialNo: "5555", reason: "Reader fault" }),
  ];
  assert.deepEqual(getCvcsRecordPage(rows, { serialNo: "1234" }).records.map((item) => item.serialNo), ["1234"]);
  assert.deepEqual(getCvcsRecordPage(rows, { query: "reader", fuzzy: true }).records.map((item) => item.serialNo), ["5555"]);
  assert.equal(getCvcsRecordPage(rows, { query: "reader", fuzzy: false }).total, 0);
});

test("filters, sorts, and paginates CVCS records on the server", () => {
  const rows = [
    record({ property: "Plaza", serialNo: "0001", date: "2026/08/10" }),
    record({ property: "Plaza", serialNo: "0002", date: "2026/08/12" }),
    record({ property: "Sands", serialNo: "0003", date: "2026/08/11" }),
  ];
  const result = getCvcsRecordPage(rows, { property: "Plaza", sort: "newest", page: 1, pageSize: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.pages, 2);
  assert.equal(result.records[0].serialNo, "0002");
});

test("allows part-only, follow-up-only, and combined broken-part rows", () => {
  const part = normalizeCvcsBrokenPart({ property: "Venetian", model: "SOT", serialNo: "1234", partsNo: "CV-1", requiredPartsEn: "Cable", qty: "1", foundDay: "2026/08/13" });
  const follow = normalizeCvcsBrokenPart({ property: "Venetian", model: "SOT", serialNo: "1234", requestFollowUpDate: "2026/08/13" });
  assert.equal(part.partsNo, "CV-1");
  assert.equal(follow.requestFollowUpDate, "2026/08/13");
  assert.throws(() => normalizeCvcsBrokenPart({ property: "Venetian", model: "SOT", serialNo: "1234" }), /part or follow-up/i);
});

test("round-trips broken parts and derives approved statuses", () => {
  const source = normalizeCvcsBrokenPart({
    property: "Venetian",
    model: "SOT",
    serialNo: "1234",
    partsNo: "CV-1",
    requiredPartsEn: "Cable",
    qty: "2",
    repairDay: "Waiting Parts",
    foundDay: "2026/08/13",
    requestFollowUpDate: "2026/08/13",
  });
  const values = cvcsBrokenPartToValues(source);
  const restored = cvcsBrokenPartFromRow(values, 4, "broken-synthetic");
  assert.equal(restored.requiredPartsEn, "Cable");
  assert.deepEqual(cvcsBrokenPartStatus(restored), ["Waiting Parts", "Following Up"]);
  assert.deepEqual(cvcsBrokenPartStatus({ ...restored, repairDay: "2026/08/14", followUpCompletedDate: "2026/08/15" }), ["Repaired", "Follow-up Completed"]);
});

test("filters CVCS broken parts by status with server pagination", () => {
  const rows = [
    normalizeCvcsBrokenPart({ property: "Venetian", model: "SOT", serialNo: "1001", requestFollowUpDate: "2026/08/13" }),
    normalizeCvcsBrokenPart({ property: "Sands", model: "Reader", serialNo: "1002", partsNo: "CV-2", requiredPartsEn: "Board", qty: "1", repairDay: "2026/08/14", foundDay: "2026/08/13" }),
  ];
  const result = getCvcsBrokenPartsPage(rows, { status: "Following Up", page: 1, pageSize: 10 });
  assert.equal(result.total, 1);
  assert.equal(result.records[0].serialNo, "1001");
});
