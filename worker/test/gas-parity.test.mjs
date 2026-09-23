import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

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

test("GAS mirrors model-aware duplicate checks and submission state warnings", { skip: !gasAvailable }, () => {
  assert.match(gasCode, /action === 'submissionWarnings'/);
  assert.match(gasCode, /function getSubmissionWarnings\(params\)/);
  assert.match(gasCode, /String\(params\.model \|\| ''\)\.trim\(\)\.toUpperCase\(\)/);
  assert.match(gasCode, /bpHoldReleaseDate/);
});

test("GAS submission warning detects cross-casino Waiting for Unlock", { skip: !gasAvailable }, () => {
  const start = gasCode.indexOf("function getSubmissionWarnings(params) {");
  const source = gasCode.slice(start, gasCode.indexOf("\nfunction getBrokenPartsPage(", start));
  const row = ["Venetian", "SAE", "3000", "", "", "", "", "", "", "", "2026/08/10", "Wait for Unlock", "", ""];
  const context = vm.createContext({
    normalizeCompany: value => value,
    getBrokenPartsSheet: () => ({}),
    getBrokenPartsRows: () => [row],
    isBrokenPartsHeader: () => false,
    brokenPartsDate: value => value,
    brokenPartsRecordFromRow: (values, rowNumber) => ({ rowNumber, casino: values[0], model: values[1], serialNo: values[2], brokenParts: values[3], bpUodActivationDate: values[10] }),
  });
  vm.runInContext(source, context);
  const result = context.getSubmissionWarnings({ records: [{ company: "SCL", casino: "Parisian", model: "SAE", serialNo: "3000" }] });
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].uodWaiting, true);
  assert.equal(result.warnings[0].bpUodActivationDate, "2026/08/10");
});

test("GAS selected Unlock date writes the original Broken Parts List row", { skip: !gasAvailable }, () => {
  const start = gasCode.indexOf("function updateBrokenPartsRepairDays(company, records) {");
  const source = gasCode.slice(start, gasCode.indexOf("\nfunction brokenPartsCachePrefix(", start));
  const row = ["Venetian", "SAE", "3000", "P-001", "", "", "", "", "", "", "2026/08/10", "Wait for Unlock", "", ""];
  const sheet = {
    getLastRow: () => 2,
    getRange: (_row, column, _height, width = 1) => ({
      getDisplayValues: () => [row.slice(column - 1, column - 1 + width)],
      getValues: () => [row.slice(column - 1, column - 1 + width)],
      setValue: value => { row[column - 1] = value; },
    }),
  };
  const context = vm.createContext({
    getBrokenPartsSheet: () => sheet,
    brokenPartsRecordFromRow: () => ({ model: "SAE", serialNo: "3000", brokenParts: "P-001", bpUodUnlockDay: "Wait for Unlock" }),
    normalizeDateParam: value => /^\d{4}\/\d{2}\/\d{2}$/.test(value) ? value : "",
    validateHoldDates: () => {},
    clearBrokenPartsCache: () => {},
    BROKEN_PARTS_WIDTH: 14,
  });
  vm.runInContext(source, context);
  context.updateBrokenPartsRepairDays("SCL", [{ rowNumber: 2, model: "SAE", serialNo: "3000", brokenParts: "P-001", bpUodUnlockDay: "2026/09/04" }]);
  assert.equal(row[11], "2026/09/04");
  assert.throws(() => context.updateBrokenPartsRepairDays("SCL", [{ rowNumber: 2, model: "SAE", serialNo: "3000", brokenParts: "P-001", bpRepairDay: "2026/09/05", bpUodUnlockDay: "invalid" }]), /Invalid UOD unlock date/);
  assert.equal(row[7], "");
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
