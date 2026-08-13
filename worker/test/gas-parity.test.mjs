import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const gasCode = fs.readFileSync(path.resolve(root, "..", "amrs-gas", "code.js"), "utf8");
const gasCvcsPath = path.resolve(root, "..", "amrs-gas", "cvcs.js");

test("GAS exposes every CVCS read and write action used by Worker", () => {
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

test("GAS bootstrap declares the approved nine visible CVCS worksheets and hidden identity headers", () => {
  const source = fs.readFileSync(gasCvcsPath, "utf8");
  [
    "CVCS Records", "Sub Location", "Antenna Size", "Antenna Status", "Version",
    "Reason Action Mapping", "Parts Change", "CVCS Broken Parts", "CVCS Parts List",
  ].forEach((sheet) => assert.ok(source.includes(`'${sheet}'`) || source.includes(`"${sheet}"`), sheet));
  assert.ok(source.includes("AMRS Submission ID"));
  assert.ok(source.includes("Following Up"));
});
