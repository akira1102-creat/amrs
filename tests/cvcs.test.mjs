import assert from "node:assert/strict";
import test from "node:test";
import cvcs from "../cvcs.js";

test("editable combo ranking puts matches before frequently used and remaining options", () => {
  const options = ["South Cage", "Main TG", "Cage Office", "North Cage"];
  const ranked = cvcs.rankOptions("cage", options, { "Main TG": 99, "North Cage": 4 });
  assert.deepEqual(ranked, ["Cage Office", "North Cage", "South Cage", "Main TG"]);
});

test("new CVCS forms derive Property and required defaults", () => {
  const form = cvcs.createDefaultForm("Londoner", new Date("2026-08-13T09:00:00+08:00"));
  assert.equal(form.property, "Londoner");
  assert.equal(form.date, "2026-08-13");
  assert.equal(form.reason, "PM");
  assert.equal(form.location, "Cage");
  assert.equal(form.model, "SOT");
});

test("record builder rejects missing required fields and keeps optional custom text", () => {
  assert.throws(() => cvcs.buildRecord({ property: "Plaza", date: "2026-08-13", location: "", model: "SOT", serialNo: "1", reason: "PM" }), /Location/);
  const record = cvcs.buildRecord({
    property: "Plaza",
    date: "2026-08-13",
    location: "Other",
    subLocation: "Custom Room",
    model: "Reader",
    serialNo: "R-7",
    reason: "Custom Reason",
    actionTakenNotes: "Custom note",
  }, () => "submission-fixed");
  assert.equal(record.subLocation, "Custom Room");
  assert.equal(record.submissionId, "submission-fixed");
});

test("broken-part builder permits follow-up without a part", () => {
  const followUp = cvcs.buildBrokenPart({
    property: "Venetian",
    model: "SCP",
    serialNo: "17",
    requestFollowUpDate: "2026-08-13",
  }, () => "follow-up-fixed");
  assert.equal(followUp.partsNo, "");
  assert.equal(followUp.requestFollowUpDate, "2026-08-13");
  assert.throws(() => cvcs.buildBrokenPart({ property: "Venetian", model: "SCP", serialNo: "17" }), /part or follow-up/i);
});

test("new follow-up requests cannot be completed during data entry", () => {
  const followUp = cvcs.buildBrokenPart({
    property: "Venetian",
    model: "SCP",
    serialNo: "17",
    requestFollowUpDate: "2026-08-13",
    followUpCompletedDate: "2026-08-13",
  });
  assert.equal(followUp.followUpCompletedDate, "");
});

test("reason selection uses the action from the same mapping row", () => {
  const mappings = [
    { reason: "PM", actionTakenNotes: "Inspection" },
    { reason: "Reader Error", actionTakenNotes: "Reset reader" },
  ];
  assert.equal(cvcs.actionForReason("reader error", mappings), "Reset reader");
  assert.equal(cvcs.actionForReason("reader", mappings), null);
});

test("CVCS filters serialize exact and fuzzy searches explicitly", () => {
  const exact = cvcs.buildRecordQuery({ property: "", serialNo: "123", fuzzy: false, page: 2, pageSize: 30 });
  assert.equal(exact.get("action"), "cvcsRecords");
  assert.equal(exact.get("serialNo"), "123");
  assert.equal(exact.get("fuzzy"), "0");
  assert.equal(exact.has("property"), false);
  assert.equal(exact.get("page"), "2");
});

test("empty fields are omitted from record cards", () => {
  const fields = cvcs.visibleFields({ property: "Sands", serialNo: "88", quarter: "", version: "" }, "record");
  assert.deepEqual(fields.map((field) => field.key), ["property", "serialNo"]);
});
