import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntranetServer } from './server.mjs';
import { createAccessToken } from '../worker/src/access-tokens.mjs';

function requestFrom(address, port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const content = body == null ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({
      host: '127.0.0.1', port, path, method, localAddress: address, agent: false,
      headers: content ? { ...headers, 'content-type': 'application/json', 'content-length': content.length } : headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    if (content) request.write(content);
    request.end();
  });
}

test('four independent HTTP clients share submissions and reads across a host restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amrs-http-clients-'));
  const originalFetch = globalThis.fetch;
  let app;
  globalThis.fetch = () => { throw new Error('External requests forbidden'); };

  async function startServer() {
    app = createIntranetServer({ directory });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    return app.server.address().port;
  }

  try {
    let port = await startServer();
    const clientAddresses = ['127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.5'];
    const clients = await Promise.all(clientAddresses.map(async (address, index) => {
      const { token } = await createAccessToken(app.runtime.db, { label: `Synthetic HTTP ${index}`, permissions: ['ae'] });
      const response = await requestFrom(address, port, '/session', { method: 'POST', body: { token } });
      assert.equal(response.status, 200, `${address} can authenticate through the host`);
      const session = JSON.parse(response.body);
      return { address, index, authorization: `Bearer ${session.token}` };
    }));

    const serialNumbers = clients.map(client => `991${client.index}`);
    const firstWrites = await Promise.all(clients.map(client => requestFrom(client.address, port, '/api', {
      method: 'POST',
      headers: { authorization: client.authorization },
      body: {
        action: 'submitRecords', requestId: `http-client-${client.index}`,
        records: [{
          company: 'SCL', casino: 'Venetian', date: '2026/01/01', model: 'SAE', serialNo: serialNumbers[client.index],
          reason: 'PM', actionTaken: 'Preventive Maintenance', inspector: 'Synthetic', poNumber: 'TEST', submissionId: `http-row-${client.index}`,
        }],
      },
    })));
    for (let index = 0; index < firstWrites.length; index += 1) {
      assert.ok([200, 409, 503].includes(firstWrites[index].status), `first write ${index} has a known outcome`);
      if (firstWrites[index].status !== 200) {
        const retry = await requestFrom(clients[index].address, port, '/api', {
          method: 'POST',
          headers: { authorization: clients[index].authorization },
          body: {
            action: 'submitRecords', requestId: `http-client-${index}`,
            records: [{
              company: 'SCL', casino: 'Venetian', date: '2026/01/01', model: 'SAE', serialNo: serialNumbers[index],
              reason: 'PM', actionTaken: 'Preventive Maintenance', inspector: 'Synthetic', poNumber: 'TEST', submissionId: `http-row-${index}`,
            }],
          },
        });
        assert.equal(retry.status, 200, `client ${index} can safely retry its write`);
      }
    }

    await app.close();
    app = undefined;
    port = await startServer();
    for (const client of clients) {
      const response = await requestFrom(client.address, port, '/api?action=dashboard&company=SCL&includeParts=0&refresh=1', {
        headers: { authorization: client.authorization },
      });
      assert.equal(response.status, 200, `${client.address} can read shared data after host restart`);
      for (const serialNo of serialNumbers) assert.ok(response.body.includes(serialNo), `${client.address} sees ${serialNo}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (app) await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
