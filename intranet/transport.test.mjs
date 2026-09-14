import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntranetServer } from './server.mjs';
import { createAccessToken } from '../worker/src/access-tokens.mjs';

const require = createRequire(import.meta.url);

test('local-only transport authenticates, reads and writes through the intranet host only', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amrs-transport-test-'));
  const app = createIntranetServer({ directory });
  const originalLocation = globalThis.location;
  const originalFetch = globalThis.fetch;
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const { token } = await createAccessToken(app.runtime.db, { label: 'Synthetic local user', permissions: ['ae'] });
    const contactedOrigins = [];
    globalThis.location = { origin: base };
    const { createDualTransport } = require('./transport.browser.js');
    const transport = createDualTransport({
      baseUrl: 'https://example.invalid',
      accessToken: token,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        contactedOrigins.push(url.origin);
        return originalFetch(input, init);
      },
    });

    await transport.ensureSession({ forceRefresh: true });
    const parts = await transport.get('action=parts');
    assert.ok(Array.isArray(parts.parts));
    const submitted = await transport.post({ action: 'submitRecords', records: [{
      company: 'SCL', casino: 'Venetian', date: '2026/09/15', model: 'SAE', serialNo: '9915',
      reason: 'PM', actionTaken: 'Preventive Maintenance', inspector: 'Synthetic', poNumber: 'TEST', submissionId: 'offline-transport-test',
    }] });
    assert.equal(submitted.inserted, 1);
    const dashboard = await transport.get('action=dashboard&company=SCL&serialNo=9915&includeParts=0&refresh=1');
    assert.ok(JSON.stringify(dashboard).includes('9915'));
    assert.ok(contactedOrigins.length >= 4);
    assert.deepEqual([...new Set(contactedOrigins)], [base]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
    await app.close();
    if (directory.startsWith(tmpdir())) rmSync(directory, { recursive: true, force: true });
  }
});
