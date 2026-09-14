import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRuntime } from './runtime.mjs';
import { createAccessToken } from '../worker/src/access-tokens.mjs';

test('local runtime authenticates and serves original API with all external requests forbidden', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amrs-runtime-test-'));
  const runtime = openRuntime(directory);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('External network forbidden'); };
  try {
    const { token } = await createAccessToken(runtime.db, { label: 'Synthetic administrator', permissions: ['ae', 'cvcs', 'schedule', 'admin'] });
    const response = await runtime.handle(new Request('http://localhost/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }));
    assert.equal(response.status, 200);
    const session = await response.json();
    assert.equal(session.success, true);
    const ping = await runtime.handle(new Request('http://localhost/api?action=ping', { headers: { authorization: `Bearer ${session.token}` } }));
    assert.deepEqual(await ping.json(), { success: true });
    const denied = await runtime.handle(new Request('http://localhost/api?action=ping'));
    assert.equal(denied.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
