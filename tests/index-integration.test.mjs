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

test("sidebar separates AE and CVCS query sections", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /id="dataQueryMenuSection">AE 資料查詢</);
  assert.match(html, /id="cvcsQueryMenuSection">CVCS 資料查詢</);
  const cvcsSection = html.indexOf('id="cvcsQueryMenuSection"');
  assert.ok(cvcsSection > html.indexOf('id="brokenPartsCompanyMenu"'));
  assert.ok(cvcsSection < html.indexOf('id="cvcsQueryMenuBtn"'));
});

test("CVCS input shows one Property badge below its title", () => {
  const source = fs.readFileSync(new URL("../cvcs.js", import.meta.url), "utf8");
  const renderInput = source.match(/renderInput\(\) \{([\s\S]*?)\n    \}\n    comboField/)?.[1] || "";
  assert.match(renderInput, /<h2>CVCS 資料輸入<\/h2><span class="cvcs-property-badge">/);
  assert.doesNotMatch(renderInput, /<p>\$\{escapeHtml\(this\.activeProperty\)\}<\/p>/);
  assert.equal((renderInput.match(/cvcs-property-badge/g) || []).length, 1);
});

test("all frontend assets use one release URL so an old worker cannot mix JavaScript versions", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const worker = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  const urls = [...html.matchAll(/(?:href|src)="\.\/(?:cvcs\.css|cloud-api\.js|access-control\.js|cvcs\.js|token-admin\.js)\?v=([^"]+)"/g)];
  assert.equal(urls.length, 5);
  assert.equal(new Set(urls.map((match) => match[1])).size, 1);
  const release = urls[0][1];
  for (const asset of ["cvcs.css", "cloud-api.js", "access-control.js", "cvcs.js", "token-admin.js"]) {
    assert.match(worker, new RegExp(`${asset.replace(".", "\\.")}\\?v=${release}`));
  }
});

test("schedule remarks expose edit controls for both shifts", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /updateScheduleRemark/);
  assert.match(html, /openScheduleRemark\('\$\{date\}','\$\{shift\}'\)/);
  assert.match(html, /shift==='pm'\?'下午':'上午'/);
});

test("schedule cards expose shift-scoped personnel editing and mobile edge swipe navigation", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /updateSchedulePeople/);
  assert.match(html, /openSchedulePeopleEditor/);
  assert.match(html, /touchstart/);
  assert.match(html, /clientX > 24/);
});

test("schedule personnel editor offers a dropdown for every person in the selected shift", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<select[^>]+id="schedulePeopleEditSelect"/);
  assert.match(html, /scheduleAvailablePeople/);
  assert.match(html, /schedulePeopleEditSelect/);
});
