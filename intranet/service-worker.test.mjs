import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { localAsset, INTRANET_VERSION } from './server.mjs';

test('local service worker never intercepts shared data APIs but still caches static assets', async () => {
  const handlers = {};
  let cacheReads = 0;
  const script = localAsset('sw.js', readFileSync(new URL('../sw.js', import.meta.url), 'utf8'));
  assert.ok(script.includes(INTRANET_VERSION));
  vm.runInNewContext(script, {
    URL, self: { location: { origin: 'http://localhost' }, addEventListener: (event, handler) => { handlers[event] = handler; } },
    caches: { match: async () => { cacheReads++; return 'cached-static'; } },
  });
  for (const path of ['/api?action=dashboard', '/api?action=scheduleOverview', '/session', '/health', '/operations/test', '/submissions/test']) {
    let intercepted = false;
    handlers.fetch({ request: { url: `http://localhost${path}`, method: 'GET' }, respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false, path);
  }
  assert.equal(cacheReads, 0);
  let response;
  handlers.fetch({ request: { url: 'http://localhost/cvcs.js', method: 'GET' }, respondWith: promise => { response = promise; } });
  assert.equal(await response, 'cached-static');
  assert.equal(cacheReads, 1);
});
