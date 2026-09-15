import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { openRuntime } from './runtime.mjs';
import { isAllowedIntranetClient } from './network-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = new Set(['index.html', 'access-control.js', 'cvcs.js', 'cvcs.css', 'token-admin.js', 'galaxy-log.js', 'galaxy-log.css', 'mgm-check-request.js', 'mgm-check-request.css', 'worksheet-editor.js', 'worksheet-editor.css', 'intranet-transport.js', 'xlsx.mini.min.js', 'manifest.json', 'sw.js', 'icon.png', 'apple-touch-icon.png']);
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', png: 'image/png' };
export const INTRANET_VERSION = 'intranet-0.2.17';

export function createIntranetServer({ directory, runtime = openRuntime(directory) }) {
  const server = http.createServer(async (incoming, outgoing) => {
    const headers = {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
      'cache-control': 'no-store',
    };
    try {
      if (!isAllowedIntranetClient(incoming.socket?.remoteAddress)) {
        outgoing.writeHead(403, headers); outgoing.end('Intranet clients only'); return;
      }
      const url = new URL(incoming.url, 'http://localhost');
      if (/^\/(?:session|api|health|operations(?:\/|$)|submissions(?:\/|$))/.test(url.pathname)) {
        if (incoming.headers.origin && new URL(incoming.headers.origin).host !== incoming.headers.host) {
          outgoing.writeHead(403, headers); outgoing.end('Origin not allowed'); return;
        }
        const chunks = []; let length = 0;
        for await (const chunk of incoming) {
          length += chunk.length;
          if (length > 10 * 1024 * 1024) { outgoing.writeHead(413, headers); outgoing.end('Request too large'); return; }
          chunks.push(chunk);
        }
        const request = new Request(url, { method: incoming.method, headers: incoming.headers, ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Buffer.concat(chunks) } : {}) });
        const response = await runtime.handle(request);
        outgoing.writeHead(response.status, { ...headers, ...Object.fromEntries(response.headers) });
        outgoing.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!assets.has(name) || !['GET', 'HEAD'].includes(incoming.method)) { outgoing.writeHead(404, headers); outgoing.end('Not found'); return; }
      const extension = name.split('.').at(-1);
      const content = await readFile(join(root, name));
      outgoing.writeHead(200, { ...headers, 'content-type': types[extension] || 'application/octet-stream' });
      outgoing.end(incoming.method === 'HEAD' ? undefined : content);
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, headers);
      outgoing.end('Local server error');
    }
  });
  return { server, runtime, async close() { await new Promise(resolve => server.close(resolve)); runtime.close(); } };
}
