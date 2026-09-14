import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test('built intranet package contains no public network clients or endpoints and runs its full local app', async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'amrs-intranet-isolation-'));
  const packageDirectory = join(temporaryRoot, 'package');
  const licenseFile = join(temporaryRoot, 'NODE-LICENSE.txt');
  let app;
  try {
    writeFileSync(licenseFile, 'Node.js\nPermission is hereby granted, free of charge.\n');
    execFileSync(process.execPath, [join(root, 'intranet/build.mjs'), packageDirectory, licenseFile], { cwd: root, stdio: 'pipe' });

    const forbidden = [
      'cloud-api.js',
      'worker/src/index.mjs',
      'worker/src/google.mjs',
      'worker/src/sheets.mjs',
      'worker/src/google-crypto.mjs',
      'worker/src/public-galaxy.mjs',
      'worker/src/cloudflare-cache.mjs',
    ].filter(path => existsSync(join(packageDirectory, path)));
    assert.deepEqual(forbidden, [], 'the package must not include cloud/GAS or Google API clients');
    assert.ok(existsSync(join(packageDirectory, 'intranet-transport.js')), 'the package should include its local-only transport');
    const packagedNode = join(packageDirectory, 'node.exe');
    assert.equal(execFileSync(packagedNode, ['--version'], { encoding: 'utf8' }).trim(), process.version);
    const setupDirectory = join(temporaryRoot, 'setup-data');
    const setupOutput = execFileSync(packagedNode, [join(packageDirectory, 'intranet', 'cli.mjs'), 'setup', setupDirectory], { encoding: 'utf8' });
    assert.match(setupOutput, /首次設定完成/);

    const publicEndpoints = [];
    for (const path of filesUnder(packageDirectory).filter(path => /\.(?:html|js|mjs)$/.test(path))) {
      const content = readFileSync(path, 'utf8');
      if (/https?:\/\/(?:[^/\s"'`]+\.)?(?:googleapis\.com|google\.com|workers\.dev)\b|https?:\/\/amrs-cache\.invalid\b/i.test(content)) {
        publicEndpoints.push(relative(packageDirectory, path));
      }
    }
    assert.deepEqual(publicEndpoints, [], 'packaged application code must contain no public service endpoints');
    const packagedServiceWorker = readFileSync(join(packageDirectory, 'sw.js'), 'utf8');
    assert.match(packagedServiceWorker, /intranet-transport\.js/);
    assert.doesNotMatch(packagedServiceWorker, /cloud-api\.js|script\.google\.com/);

    const packagedServer = await import(pathToFileURL(join(packageDirectory, 'intranet', 'server.mjs')).href);
    app = packagedServer.createIntranetServer({ directory: join(temporaryRoot, 'runtime-data') });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const page = await fetch(base);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /script src="\.\/intranet-transport\.js\?v=intranet-0\.2\.14"/);
    assert.doesNotMatch(html, /cloud-api\.js|google\.com|workers\.dev/);
    assert.match(packagedServiceWorker, /const CACHE = 'intranet-0\.2\.14';/);
    for (const asset of [
      'access-control.js', 'cvcs.js', 'cvcs.css', 'token-admin.js', 'galaxy-log.js', 'galaxy-log.css',
      'mgm-check-request.js', 'mgm-check-request.css', 'worksheet-editor.js', 'worksheet-editor.css',
      'intranet-transport.js', 'xlsx.mini.min.js', 'manifest.json', 'sw.js', 'icon.png', 'apple-touch-icon.png',
    ]) assert.equal((await fetch(`${base}/${asset}?v=intranet-0.2.14`)).status, 200, `${asset} is part of the local AMRS app`);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  } finally {
    if (app) await app.close();
    if (temporaryRoot.startsWith(tmpdir())) rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
