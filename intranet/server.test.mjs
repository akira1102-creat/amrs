import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntranetServer } from './server.mjs';

test('intranet HTTP server serves the app and denies private files and external browser connections', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amrs-server-test-'));
  const app = createIntranetServer({ directory });
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const response = await fetch(base);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /const _CLOUDFLARE_API_URL=location.origin/);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal((await fetch(`${base}/intranet/session-secret`)).status, 404);
    assert.equal((await fetch(`${base}/worker/src/config.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/session`, { method: 'POST', headers: { origin: 'https://example.invalid' }, body: '{}' })).status, 403);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
