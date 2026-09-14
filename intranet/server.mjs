import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { openRuntime } from './runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = new Set(['index.html', 'cloud-api.js', 'access-control.js', 'cvcs.js', 'cvcs.css', 'token-admin.js', 'galaxy-log.js', 'galaxy-log.css', 'mgm-check-request.js', 'mgm-check-request.css', 'worksheet-editor.js', 'worksheet-editor.css', 'xlsx.mini.min.js', 'manifest.json', 'sw.js', 'icon.png', 'apple-touch-icon.png']);
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', png: 'image/png' };
export const INTRANET_VERSION = 'intranet-0.2.2';

export function localAsset(name, content) {
  if (name === 'index.html') {
    return content.replace(/const _CLOUDFLARE_API_URL='[^']*';/, 'const _CLOUDFLARE_API_URL=location.origin;')
      .replace(/const _APP_VERSION='[^']*';/, `const _APP_VERSION='${INTRANET_VERSION}';`)
      // The shared cloud PIN is replaced by the local server's per-user tokens.
      .replace(/const _PH='[^']*';/, "const _PH='intranet-token-login';localStorage.setItem('_ml_auth',_PH);")
      .replace(/function getScriptUrl\(\)\{[\s\S]*?\n\}/, "function getScriptUrl(){return hasPersonalToken()?location.origin+'/api':'';}")
      .replace(/function hasAnyDeployId\(\)\{[^\n]*\}/, 'function hasAnyDeployId(){return hasPersonalToken();}')
      // The browser's internet status does not determine LAN reachability.
      // Let the existing timed API request and retry backoff establish success.
      .replaceAll('||!navigator.onLine', '')
      .replaceAll('&&navigator.onLine', '')
      .replace("navigator.onLine?'正在驗證連線及使用權限…':'目前離線，正在檢查連線…'", "'正在驗證內網主機連線及使用權限…'")
      .replace(/雲端/g, '內網主機');
  }
  if (name === 'cloud-api.js') return content.replace(/function deployIdToGasUrl\(value\) \{[\s\S]*?\n  \}/, 'function deployIdToGasUrl(value) { return ""; }');
  if (['galaxy-log.js', 'mgm-check-request.js', 'worksheet-editor.js'].includes(name)) return content.replace(/雲端/g, '內網主機');
  if (name === 'sw.js') return content.replace(/const CACHE = '[^']*';/, `const CACHE = '${INTRANET_VERSION}';`);
  return content;
}

export function createIntranetServer({ directory, runtime = openRuntime(directory) }) {
  const server = http.createServer(async (incoming, outgoing) => {
    const headers = {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
      'cache-control': 'no-store',
    };
    try {
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
      const raw = await readFile(join(root, name));
      const content = ['html', 'js'].includes(extension) ? localAsset(name, raw.toString('utf8')) : raw;
      outgoing.writeHead(200, { ...headers, 'content-type': types[extension] || 'application/octet-stream' });
      outgoing.end(incoming.method === 'HEAD' ? undefined : content);
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, headers);
      outgoing.end('Local server error');
    }
  });
  return { server, runtime, async close() { await new Promise(resolve => server.close(resolve)); runtime.close(); } };
}
