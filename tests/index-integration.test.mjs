import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("opening Token management does not initialize or load CVCS", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const ensureApps = html.match(/function ensureFeatureApps\(\)\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.doesNotMatch(ensureApps, /_cvcsApp\?\.mount\(\)/);
});

test("every credential requires a live server verification before access", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const refresh = html.match(/async function refreshAccessSession\(\)\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(refresh, /ensureSession\(\{forceRefresh:true\}\)/);
  assert.doesNotMatch(refresh, /_accessPermissions=\['schedule','ae','cvcs'\]/);
  assert.match(refresh, /_accessPermissions=\[\]/);
  assert.doesNotMatch(html, /unlockApp\(\);\s*if\(await refreshAccessSession\(\)\)/);
});

test("legacy Deploy IDs never reveal or enter Token management", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /hasAccess\('admin'\)\|\|_dualTransport\?\.getState\(\)\.legacy/);
  assert.doesNotMatch(html, /legacyAdmin/);
});

test("connection testing verifies both personal Tokens and legacy Deploy IDs through Cloudflare", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const connection = html.match(/async function testConnection\(\)\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(connection, /await tester\.ensureSession\(\{forceRefresh:true\}\)/);
  assert.doesNotMatch(connection, /tester\.get\('action=ping'/);
});

test("Token management has no legacy administrator bootstrap", () => {
  const source = fs.readFileSync(new URL("../token-admin.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /bootstrapAccessToken|token-bootstrap|async bootstrap\(/);
});
