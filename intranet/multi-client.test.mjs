import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRuntime } from './runtime.mjs';
import { createAccessToken } from '../worker/src/access-tokens.mjs';

test('four local API clients preserve submissions, retries and shared reads across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amrs-multi-test-'));
  let runtimes = [openRuntime(directory)];
  for (let index = 1; index < 4; index += 1) runtimes.push(openRuntime(directory));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('External requests forbidden'); };
  try {
    const clients = [];
    for (let index = 0; index < runtimes.length; index += 1) {
      const runtime = runtimes[index];
      const { token } = await createAccessToken(runtime.db, { label: `Synthetic ${index}`, permissions: ['ae'] });
      const response = await runtime.handle(new Request('http://localhost/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }));
      const session = await response.json();
      clients.push({ runtime, headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, payload: {
        action: 'submitRecords', requestId: `synthetic-client-${index}`, records: [{
          company: 'SCL', casino: 'Venetian', date: '2026/01/01', model: 'SAE', serialNo: `990${index}`,
          reason: 'PM', actionTaken: 'Preventive Maintenance', inspector: 'Synthetic', poNumber: 'TEST', submissionId: `synthetic-row-${index}`,
        }],
      } });
    }
    const submit = client => client.runtime.handle(new Request('http://localhost/api', { method: 'POST', headers: client.headers, body: JSON.stringify(client.payload) }));
    const first = await Promise.all(clients.map(submit));
    for (let i = 0; i < first.length; i++) {
      assert.ok([200, 409, 503].includes(first[i].status));
      const retry = await submit(clients[i]);
      assert.equal(retry.status, 200);
      const result = await retry.json();
      assert.equal(result.success, true);
    }
    runtimes.forEach(runtime => runtime.close());
    runtimes = [openRuntime(directory)];
    const rows = (await runtimes[0].sheets.valuesGet({ spreadsheetId: 'SCL', range: 'Worksheet!A2:Z' })).values;
    assert.equal(rows.length, 4);
    for (let i = 0; i < 4; i++) assert.equal(rows.filter(row => row.includes(`990${i}`)).length, 1);
    for (const client of clients) {
      const response = await runtimes[0].handle(new Request('http://localhost/api?action=dashboard&company=SCL&includeParts=0&refresh=1', { headers: client.headers }));
      assert.equal(response.status, 200);
      const body = await response.text();
      for (let i = 0; i < 4; i++) assert.ok(body.includes(`990${i}`));
    }
  } finally { globalThis.fetch = originalFetch; runtimes.forEach(runtime => runtime.close()); rmSync(directory, { recursive: true, force: true }); }
});
