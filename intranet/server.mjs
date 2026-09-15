import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { openRuntime } from './runtime.mjs';
import { isAllowedIntranetClient } from './network-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = new Set(['index.html', 'access-control.js', 'cvcs.js', 'cvcs.css', 'token-admin.js', 'galaxy-log.js', 'galaxy-log.css', 'mgm-check-request.js', 'mgm-check-request.css', 'worksheet-editor.js', 'worksheet-editor.css', 'intranet-transport.js', 'xlsx.mini.min.js', 'manifest.json', 'sw.js', 'icon.png', 'apple-touch-icon.png']);
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', png: 'image/png' };
export const INTRANET_VERSION = 'intranet-0.2.20';

export function localAsset(name, content) {
  if (name === 'access-control.js') return content
    .replace(/function extractDeployId\(value\)\s*\{[\s\S]*?\n  \}/, 'function extractDeployId(value) { return ""; }');
  if (name === 'index.html') {
    let html = content
      .replace(/const _CLOUDFLARE_API_URL='[^']*';/, 'const _CLOUDFLARE_API_URL=location.origin;')
      .replace(/const _APP_VERSION='[^']*';/, `const _APP_VERSION='${INTRANET_VERSION}';`)
      .replace(/<script src="\.\/cloud-api\.js\?v=[^"]*"><\/script>/, `<script src="./intranet-transport.js?v=${INTRANET_VERSION}"></script>`);
    // The shared cloud PIN is replaced by the local server's per-user tokens.
    if (!html.includes("const _PH='intranet-token-login';localStorage.setItem('_ml_auth',_PH);")) {
      html = html.replace(/const _PH='[^']*';/, "const _PH='intranet-token-login';localStorage.setItem('_ml_auth',_PH);");
    }
    const localGetScriptUrl = "function getScriptUrl(){return hasPersonalToken()?location.origin+'/api':'';}";
    if (!html.includes(localGetScriptUrl)) {
      html = html.replace(/function getScriptUrl\(\)\{[\s\S]*?\n\}/, localGetScriptUrl);
    }
    const localNormalizeCredential = "function normalizeCredentialInput(value){const raw=String(value||'').trim();return window.AmrsAccessControl.credentialKind(raw)==='personal'?raw:'';}";
    if (!html.includes(localNormalizeCredential)) {
      html = html.replace(/function normalizeCredentialInput\(value\)\{[\s\S]*?\n\}/, localNormalizeCredential);
    }
    html = html
      .replace(/function extractDeployId\(value\)\{[\s\S]*?\n\}/, "function extractDeployId(value){return '';}")
      .replace(/function getDeployId\(company\)\{[\s\S]*?\n\}/, "function getDeployId(company){return '';}")
      .replace(/function hasCredentialForCompany\(company\)\{[^\n]*\}/, 'function hasCredentialForCompany(company){return hasPersonalToken();}')
      .replace(/async function transportFetch\(url,options=\{\}\)\{[\s\S]*?\n\}/, "async function transportFetch(url,options={}){const target=new URL(String(url),location.origin);if(target.origin!==location.origin)throw new Error('只允許連接目前的內網主機');return fetch(target.href,{...options,redirect:'error',credentials:'same-origin'});}")
      .replace(/const _dualTransport=[\s\S]*?\n\}\):null;/, "const _dualTransport=typeof window.createDualTransport==='function'?window.createDualTransport({baseUrl:location.origin,fetchImpl:transportFetch,getAccessToken:()=>getAccessToken()}):null;")
      .replace(/function isGasApiUrl\(url\)\{[\s\S]*?\n\}/, 'function isGasApiUrl(url){return false;}')
      .replace(/function isCloudApiUrl\(url\)\{[\s\S]*?\n\}/, "function isCloudApiUrl(url){try{const parsed=new URL(String(url),location.origin);return parsed.origin===location.origin&&parsed.pathname==='/api';}catch(e){return false;}}")
      .replace('const response=await fetch(url,{...options,signal:controller.signal});', 'const response=await transportFetch(url,{...options,signal:controller.signal});')
      .replace(/const legacyId=kind==='legacy'\?extractDeployId\(input\):'';\s*/, '')
      .replace(/const tester=window\.createDualTransport\(\{cloudflareBaseUrl:_CLOUDFLARE_API_URL,fetchImpl:transportFetch,storage:null,accessToken:kind==='personal'\?input:'',deployId:legacyId,gasUrl:legacyId\?'https:\/\/script\.google\.com\/macros\/s\/'.*?\}\);/, "const tester=window.createDualTransport({baseUrl:location.origin,fetchImpl:transportFetch,storage:null,accessToken:kind==='personal'?input:''});")
      .replace(/if\(saved\.kind==='legacy'\)COMPANIES\.forEach\(c=>localStorage\.setItem\(_companyKey\(c\),saved\.value\)\);\r?\n  else COMPANIES\.forEach\(c=>localStorage\.removeItem\(_companyKey\(c\)\)\);/, 'COMPANIES.forEach(c=>localStorage.removeItem(_companyKey(c)));')
      .replace(/function normalizeDeployInput\(id\)\{[^\n]*\}/, "function normalizeDeployInput(id){return '';}")
      .replace(/function hasAnyDeployId\(\)\{[^\n]*\}/, 'function hasAnyDeployId(){return hasPersonalToken();}')
      .replace(/function firstConfiguredCompany\(\)\{[^\n]*\}/, "function firstConfiguredCompany(){return hasPersonalToken()?(activeCompany||'SCL'):'';}")
      .replace('請輸入管理員提供的個人 Token。過渡期間亦可繼續使用原有 Deploy ID；資料只會儲存在本機。', '請輸入內網管理員提供的個人 Token。資料會儲存在公司內網主機。')
      .replace('貼上個人 Token 或原有 Deploy ID', '貼上內網管理員提供的 Token')
      .replaceAll('🔗 測試連線', '連接內網主機')
      .replaceAll('請輸入有效個人 Token 或原有 Deploy ID', '請輸入有效的內網 Token')
      .replaceAll('暫時未能驗證，請確認連線後重試；持續失敗先檢查 Token。', '無法連接內網主機，請檢查區域網絡或聯絡管理員。')
      .replaceAll('暫時無法連接 GAS；如持續出現請檢查 Deploy ID', '無法連接內網主機；請檢查區域網絡。')
      .replaceAll('請檢查 Deploy ID 或提交資料格式', '請檢查內網連線或提交資料格式')
      .replaceAll('GAS 暫時未能連線', '內網主機暫時未能連線')
      // The browser's internet status does not determine LAN reachability.
      // Let the existing timed API request and retry backoff establish success.
      .replaceAll('||!navigator.onLine', '')
      .replaceAll('&&navigator.onLine', '')
      .replace("navigator.onLine?'正在驗證連線及使用權限…':'目前離線，正在檢查連線…'", "'正在驗證內網主機連線及使用權限…'")
      .replace(/雲端/g, '內網主機');
    return html;
  }
  if (name === 'galaxy-log.js') return content.replace(/雲端/g, '內網主機')
    .replace('內網主機清單 · 現場離線使用，返公司同步', '內網共用清單 · 連接辦公室網絡即時使用')
    .replaceAll('同步至內網主機', '儲存至內網主機')
    .replaceAll('Google Sheet', '內網工作表')
    .replaceAll('Google 試算表', '內網工作表')
    .replaceAll('按「下載內網主機資料」讀取 內網工作表；之後帶 Surface 到現場即可離線使用。', '按「下載內網主機資料」讀取公司內網共用清單。')
    .replaceAll('來源檔案仍是 Excel；已嘗試讀取，但要同步取 Log 日期，請先另存為原生 內網工作表', '來源檔案仍是 Excel；請轉換為支援的原生工作表格式')
    .replaceAll('內網工作表 沒有編輯權限；請將 Galaxy 清單分享給 AMRS 內網主機服務並設為「編輯者」，Token 本身已通過', '內網主機沒有該清單的讀寫權限，請聯絡管理員')
    .replaceAll('function isOnline() {\n      return root?.navigator?.onLine !== false;\n    }', 'function isOnline() { return true; }');
  if (name === 'mgm-check-request.js') return content.replace(/雲端/g, '內網主機')
    .replace('() => root?.navigator?.onLine !== false', '() => true');
  if (name === 'worksheet-editor.js') return content.replace(/雲端/g, '內網主機');
  if (name === 'sw.js') return content
    .replace(/const CACHE = '[^']*';/, `const CACHE = '${INTRANET_VERSION}';`)
    .replace(/const ASSETS = \[[^\]]*\];/, `const ASSETS = ['./', './index.html', './intranet-transport.js?v=${INTRANET_VERSION}', './access-control.js?v=${INTRANET_VERSION}', './cvcs.js?v=${INTRANET_VERSION}', './cvcs.css?v=${INTRANET_VERSION}', './token-admin.js?v=${INTRANET_VERSION}', './xlsx.mini.min.js?v=${INTRANET_VERSION}', './galaxy-log.js?v=${INTRANET_VERSION}', './galaxy-log.css?v=${INTRANET_VERSION}', './mgm-check-request.js?v=${INTRANET_VERSION}', './mgm-check-request.css?v=${INTRANET_VERSION}', './worksheet-editor.js?v=${INTRANET_VERSION}', './worksheet-editor.css?v=${INTRANET_VERSION}', './manifest.json?v=${INTRANET_VERSION}', './sw.js'];`)
    .replace("if (e.request.url.includes('script.google.com')) return;", "if (/^\\/(?:api|session|health|operations|submissions)(?:\\/|$)/.test(new URL(e.request.url).pathname)) return;");
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
      const source = name === 'intranet-transport.js' ? join(root, 'intranet', 'transport.browser.js') : join(root, name);
      const raw = await readFile(source);
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
