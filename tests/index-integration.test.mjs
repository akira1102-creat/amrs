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

test("Token management explains that Galaxy Log uses the existing AE permission", () => {
  const source = fs.readFileSync(new URL("../token-admin.js", import.meta.url), "utf8");
  assert.match(source, /Galaxy 取 Log 使用「SAE \/ TAE」權限/);
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

test("Galaxy Log stays in its own page and cached assets", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const worker = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  assert.match(html, /id="galaxyLogMenuBtn"/);
  assert.match(html, /id="galaxyLogPage"/);
  assert.match(html, /showPage\('galaxyLog'\)/);
  assert.match(html, /xlsx\.mini\.min\.js\?v=20260901r/);
  assert.match(html, /galaxy-log\.js\?v=20260901r/);
  assert.match(html, /galaxy-log\.css\?v=20260901r/);
  assert.match(worker, /xlsx\.mini\.min\.js\?v=20260901r/);
  assert.match(worker, /galaxy-log\.js\?v=20260901r/);
  assert.match(worker, /galaxy-log\.css\?v=20260901r/);
  assert.match(html, /function ensureGalaxyLogApp\(\)/);
  assert.match(html, /galaxyLog\s*:\s*'galaxyLogPage'/);
  const galaxy = fs.readFileSync(new URL("../galaxy-log.js", import.meta.url), "utf8");
  assert.match(galaxy, /id="galaxySyncBtn"/);
  assert.match(galaxy, /id="galaxySyncBtn"[^>]*>同步至雲端</);
  assert.match(galaxy, /id="galaxyImportBtn"[^>]*>下載雲端資料</);
  assert.match(galaxy, /id="galaxyCsvImportBtn"[^>]*>匯入 CSV</);
  assert.match(galaxy, /id="galaxyCsvFileInput"[^>]*type="file"/);
  assert.match(galaxy, /id="galaxyExportCsvBtn"[^>]*>匯出 CSV</);
  assert.doesNotMatch(galaxy, /id="galaxyLogClearBtn"/);
  assert.doesNotMatch(galaxy, /id="galaxyExportXlsxBtn"/);
  assert.doesNotMatch(galaxy, /galaxyFileInput/);
  assert.match(galaxy, /syncGalaxyLog/);
});

test("Galaxy Log receives the authenticated dual transport for cloud sync", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const ensure = html.match(/function ensureGalaxyLogApp\(\)\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(ensure, /transport\s*:\s*_dualTransport/);
});

test("GitHub Pages stages the independent Galaxy Log assets", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  const copyCommand = workflow.match(/cp ([^\r\n]+) _site\//)?.[1] || "";
  for (const asset of ["galaxy-log.js", "galaxy-log.css", "xlsx.mini.min.js"]) {
    assert.ok(copyCommand.split(/\s+/).includes(asset), `missing ${asset} from Pages artifact`);
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

test("submission flow checks machine states and offers selectable Hold and Waiting Parts actions", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /submissionWarnings/);
  assert.match(html, /submitWarningModal/);
  assert.match(html, /bpHoldReleaseDate/);
  assert.match(html, /bpRepairDay/);
  assert.match(html, /brokenPartsRepairs/);
});
