import assert from "node:assert/strict";
import test from "node:test";
import { companySchema, normalizeCompany } from "../src/config.mjs";

test("normalizes known companies and defaults unknown values", () => {
  assert.equal(normalizeCompany("mgm"), "MGM");
  assert.equal(normalizeCompany("unknown"), "SCL");
});

test("preserves company-specific worksheet widths", () => {
  assert.equal(companySchema("SCL").width, 10);
  assert.equal(companySchema("MGM").width, 11);
  assert.equal(companySchema("GEG").width, 12);
  assert.equal(companySchema("GEG").fields[11], "inspector");
});

