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
    const reads = [
      { action: 'today', company: 'SCL' },
      { action: 'duplicateFault', company: 'SCL', serialNos: '1234', reason: 'Fault', date: '2026/09/15' },
      { action: 'submissionWarnings', records: JSON.stringify([{ company: 'SCL', model: 'SAE', serialNo: '1234' }]) },
      { action: 'dashboard', company: 'SCL', includeParts: '0' },
      { action: 'parts' },
      { action: 'template', company: 'SCL' },
      { action: 'aaTags', company: 'MGM' },
      { action: 'brokenPartsList', company: 'SCL' },
      { action: 'monthlyStats', month: '2609' },
      { action: 'monthlyStatsBase', month: '2609' },
      { action: 'monthlyStatsCompany', company: 'SCL', month: '2609' },
      { action: 'scheduleMachineCounts', month: '2609' },
      { action: 'scheduleOverview', from: '2026/09/15', days: '1' },
      { action: 'monthlySettings', company: 'GEG' },
      { action: 'galaxyLogOverview' },
      { action: 'mgmCheckRequests' },
      { action: 'worksheetGrid', company: 'SCL' },
      { action: 'cvcsOptions' },
      { action: 'cvcsRecords' },
      { action: 'cvcsBrokenParts' },
      { action: 'cvcsWorksheetGrid', property: 'Venetian' },
    ];
    for (const params of reads) {
      params.refresh = '1';
      const query = new URLSearchParams(params);
      const response = await runtime.handle(new Request(`http://localhost/api?${query}`, { headers: { authorization: `Bearer ${session.token}` } }));
      assert.equal(response.status, 200, `${params.action} should stay available through the local API`);
      const result = await response.json();
      assert.notEqual(result.error, 'unknown action', `${params.action} should be handled by the local repository`);
      if (params.action === 'parts') assert.ok(Array.isArray(result.parts));
      if (params.action === 'mgmCheckRequests') assert.equal(result.success, true);
    }
    const denied = await runtime.handle(new Request('http://localhost/api?action=ping'));
    assert.equal(denied.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
