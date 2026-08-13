import assert from "node:assert/strict";
import test from "node:test";
import tokenAdmin from "../token-admin.js";

test("token form requires a label and at least one permission", () => {
  assert.throws(() => tokenAdmin.normalizeTokenForm({ label: "", permissions: ["schedule"] }), /label/i);
  assert.throws(() => tokenAdmin.normalizeTokenForm({ label: "User", permissions: [] }), /permission/i);
  assert.deepEqual(tokenAdmin.normalizeTokenForm({ label: " User ", note: " Note ", permissions: ["schedule", "cvcs", "invalid"] }), {
    label: "User", note: "Note", permissions: ["schedule", "cvcs"],
  });
});

test("token list never exposes a recoverable token value", () => {
  const view = tokenAdmin.tokenView({ id: "1", tokenSuffix: "cafe", label: "Staff", permissions: ["ae"], status: "active" });
  assert.equal(view.maskedToken, "•••• cafe");
  assert.equal(Object.hasOwn(view, "token"), false);
});
