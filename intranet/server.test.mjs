import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntranetServer } from './server.mjs';
import { readFile } from 'node:fs/promises';
import { localAsset, INTRANET_VERSION } from './server.mjs';
import vm from 'node:vm';

test('intranet HTTP server serves the app and denies private files and external browser connections', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amrs-server-test-'));
  const app = createIntranetServer({ directory });
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const response = await fetch(base);
    assert.equal(response.status, 200);
    const html = await response.text();
    for (const [, script] of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (script.trim()) new vm.Script(script, { filename: 'intranet-index-inline.js' });
    }
    assert.match(html, /const _CLOUDFLARE_API_URL=location.origin/);
    assert.match(html, /script src="\.\/intranet-transport\.js\?v=intranet-0\.2\.12"/);
    assert.doesNotMatch(html, /cloud-api\.js|google\.com|workers\.dev|Google Sheet|saved\.kind==='legacy'/);
    assert.match(html, /const _PH='intranet-token-login';localStorage\.setItem\('_ml_auth',_PH\);/);
    assert.match(html, /資料會儲存在公司內網主機/);
    assert.match(html, /貼上內網管理員提供的 Token/);
    assert.doesNotMatch(html, /原有 Deploy ID/);
    assert.doesNotMatch(html, /navigator\.onLine/);
    assert.match(html, /function normalizeCredentialInput\(value\)\{const raw=String\(value\|\|''\)\.trim\(\);return window\.AmrsAccessControl\.credentialKind\(raw\)==='personal'\?raw:'';\}/);
    assert.match(html, /function normalizeDeployInput\(id\)\{return\s+'';\}/);
    assert.match(html, /if\(!_retryQueue.length\)return/);
    assert.match(html, /Math.min\(60000,5000\*Math.pow/);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(response.headers.get('content-security-policy'), /form-action 'self'/);
    const sourceHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const twiceLocalHtml = localAsset('index.html', localAsset('index.html', sourceHtml));
    assert.ok(twiceLocalHtml.includes('function transportFetch(url,options={})'));
    assert.ok(twiceLocalHtml.includes('function initMobileMenuSwipe()'));
    assert.doesNotMatch(twiceLocalHtml, /cloud-api\.js|google\.com|workers\.dev|Google Sheet|saved\.kind==='legacy'/);
    const transport = await fetch(`${base}/intranet-transport.js`);
    assert.equal(transport.status, 200);
    assert.match(await transport.text(), /only connects to the current intranet host|只允許連接目前的內網主機/);
    assert.equal((await fetch(`${base}/cloud-api.js`)).status, 404);
    assert.equal((await fetch(`${base}/intranet/session-secret`)).status, 404);
    assert.equal((await fetch(`${base}/worker/src/config.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/session`, { method: 'POST', headers: { origin: 'https://example.invalid' }, body: '{}' })).status, 403);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('local Galaxy and MGM pages use host reachability, not public internet state', async () => {
  const galaxy = localAsset('galaxy-log.js', await readFile(new URL('../galaxy-log.js', import.meta.url), 'utf8'));
  const mgm = localAsset('mgm-check-request.js', await readFile(new URL('../mgm-check-request.js', import.meta.url), 'utf8'));
  assert.ok(INTRANET_VERSION.endsWith('0.2.12'));
  assert.match(galaxy, /function isOnline\(\) \{ return true; \}/);
  assert.doesNotMatch(galaxy, /Google Sheet|返公司同步|帶 Surface/);
  assert.match(mgm, /: \(\) => true/);
  assert.doesNotMatch(mgm, /root\?\.navigator\?\.onLine/);
});
