import test from 'node:test';
import assert from 'node:assert/strict';
import * as networkPolicy from './network-policy.mjs';

test('startup directions list unique private IPv4 URLs and omit public or non-routed interfaces', () => {
  const interfaces = {
    Ethernet: [
      { address: '192.168.10.24', family: 'IPv4', internal: false },
      { address: '203.0.113.17', family: 'IPv4', internal: false },
      { address: '172.20.5.6', family: 4, internal: false },
      { address: '169.254.1.9', family: 'IPv4', internal: false },
    ],
    WiFi: [
      { address: '192.168.10.24', family: 4, internal: false },
      { address: '10.40.2.7', family: 'IPv4', internal: false },
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: 'fe80::12', family: 'IPv6', internal: false },
    ],
  };

  const message = networkPolicy.intranetStartupMessage?.(8080, interfaces) ?? '';
  assert.match(message, /http:\/\/localhost:8080/);
  assert.match(message, /http:\/\/10\.40\.2\.7:8080/);
  assert.match(message, /http:\/\/172\.20\.5\.6:8080/);
  assert.match(message, /http:\/\/192\.168\.10\.24:8080/);
  assert.doesNotMatch(message, /203\.0\.113\.17|169\.254\.1\.9|127\.0\.0\.1|fe80::12/);
});
