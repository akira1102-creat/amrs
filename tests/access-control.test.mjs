import assert from "node:assert/strict";
import test from "node:test";
import accessModule from "../access-control.js";

const {
  credentialKind,
  filterVisiblePages,
  hasPermission,
  pagePermission,
  saveCredential,
} = accessModule;

class Storage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test("personal tokens and legacy Deploy IDs use separate storage", () => {
  const storage = new Storage();
  assert.equal(credentialKind("amrs_12345678901234567890"), "personal");
  assert.equal(credentialKind("https://script.google.com/macros/s/synthetic-id/exec"), "legacy");

  saveCredential(storage, "amrs_12345678901234567890");
  assert.equal(storage.getItem("_amrs_access_token_v1"), "amrs_12345678901234567890");
  assert.equal(storage.getItem("_ml_gas"), null);

  saveCredential(storage, "https://script.google.com/macros/s/synthetic-id/exec");
  assert.equal(storage.getItem("_amrs_access_token_v1"), null);
  assert.equal(storage.getItem("_ml_gas"), "synthetic-id");
});

test("page permissions hide unavailable product areas", () => {
  assert.equal(pagePermission("schedule"), "schedule");
  assert.equal(pagePermission("cvcs-input"), "cvcs");
  assert.equal(pagePermission("token-admin"), "admin");
  assert.equal(hasPermission(["schedule", "cvcs"], "cvcs"), true);
  assert.equal(hasPermission(["schedule"], "ae"), false);
  assert.deepEqual(
    filterVisiblePages(["schedule", "ae-input", "cvcs-input", "token-admin"], ["schedule", "cvcs"]),
    ["schedule", "cvcs-input"],
  );
});
