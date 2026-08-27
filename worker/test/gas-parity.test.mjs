import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const gasCodePath = path.resolve(root, "..", "amrs-gas", "code.js");
const gasCvcsPath = path.resolve(root, "..", "amrs-gas", "cvcs.js");
const gasAvailable = fs.existsSync(gasCodePath) && fs.existsSync(gasCvcsPath);
const gasCode = gasAvailable ? fs.readFileSync(gasCodePath, "utf8") : "";

test("GAS exposes every CVCS read and write action used by Worker", { skip: !gasAvailable }, () => {
  assert.equal(fs.existsSync(gasCvcsPath), true);
  const gasCvcs = fs.readFileSync(gasCvcsPath, "utf8");
  const actions = [
    "cvcsOptions", "cvcsRecords", "cvcsBrokenParts", "updateCvcsOptions",
    "submitCvcsRecords", "submitCvcsBrokenParts", "updateCvcsRecord",
    "deleteCvcsRecord", "bulkUpdateCvcsRecords", "bulkDeleteCvcsRecords",
    "updateCvcsBrokenPart", "deleteCvcsBrokenPart", "bulkUpdateCvcsBrokenParts",
  ];
  actions.forEach((action) => assert.ok(gasCode.includes(`'${action}'`) || gasCvcs.includes(`'${action}'`), action));
});

test("GAS keeps the schedule remark write path and full-width afternoon columns", { skip: !gasAvailable }, () => {
  assert.match(gasCode, /data\.action === 'updateScheduleRemark'/);
  assert.match(gasCode, /function updateScheduleRemark\(params\)/);
  assert.match(gasCode, /Math\.max\(20, sheet\.getMaxColumns\(\)\)/);
});

test("GAS exposes the schedule personnel read and write path", { skip: !gasAvailable }, () => {
  assert.match(gasCode, /data\.action === 'updateSchedulePeople'/);
  assert.match(gasCode, /function updateSchedulePeople\(params\)/);
  assert.match(gasCode, /people: \{ am: \[\], pm: \[\] \}/);
});

test("GAS bootstrap declares the approved nine visible CVCS worksheets and hidden identity headers", { skip: !gasAvailable }, () => {
  const source = fs.readFileSync(gasCvcsPath, "utf8");
  [
    "CVCS Records", "Sub Location", "Antenna Size", "Antenna Status", "Version",
    "Reason Action Mapping", "Parts Change", "CVCS Broken Parts", "CVCS Parts List",
  ].forEach((sheet) => assert.ok(source.includes(`'${sheet}'`) || source.includes(`"${sheet}"`), sheet));
  assert.ok(source.includes("AMRS Submission ID"));
  assert.ok(source.includes("Following Up"));
});
