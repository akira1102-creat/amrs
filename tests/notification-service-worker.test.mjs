import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
function dispatch(request) {
  const handlers = new Map();
  const self = { location: { origin: 'https://app.example.invalid' }, addEventListener: (type, handler) => handlers.set(type, handler) };
  vm.runInNewContext(source, { self, URL, Response });
  let response;
  handlers.get('fetch')({ request, respondWith(value) { response = Promise.resolve(value); } });
  return response;
}

test('updated service worker answers legacy notification polls locally until the page is reopened', async () => {
  const response = await dispatch(new Request('https://api.example.invalid/?action=followupNotifications'));
  assert.ok(response, 'legacy polling must not fall through to the network');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, false);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('new idle-aware notification polls are allowed through to the API', () => {
  assert.equal(dispatch(new Request('https://api.example.invalid/?action=followupNotifications&notificationPoll=idle-v1')), undefined);
});

test('legacy poll suspension never blocks normal log reads, writes or other API actions', () => {
  for (const action of ['followupLog', 'monthlyStats', 'schedule']) {
    assert.equal(dispatch(new Request(`https://api.example.invalid/?action=${action}`)), undefined);
  }
  assert.equal(dispatch(new Request('https://api.example.invalid/', { method: 'POST', body: '{"action":"addFollowupComment"}' })), undefined);
});
