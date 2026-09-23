import { createHash } from 'node:crypto';

const MARKER = /\[AMRS-SYNC:([a-f0-9]{24}):([a-f0-9]{16})\]/g;

function text(value) {
  return String(value ?? '').trim();
}

function cleanLine(value) {
  return text(value).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').replace(/\[AMRS-SYNC:/gi, '［AMRS-SYNC:');
}

function comparable(value) {
  return text(value).normalize('NFKC').toLocaleLowerCase('en-US');
}

function digest(value, length) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function maintenanceDate(value) {
  const match = text(value).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function sourceMarker(record) {
  return digest(`${text(record.company)}\0${text(record.recordId)}`, 24);
}

function contentMarker(record, date) {
  return digest(JSON.stringify([
    text(record.company), text(record.casino), date, text(record.serialNo),
    text(record.actionTaken), text(record.reason), text(record.inspector),
  ]), 16);
}

function remarksFor(record, key, content) {
  const lines = [
    `[AMRS-SYNC:${key}:${content}]`,
    `場地：${cleanLine(record.casino)}`,
    `機器 SN：${cleanLine(record.serialNo)}`,
    `工作內容：${cleanLine(record.actionTaken) || '未填寫'}`,
  ];
  if (text(record.reason)) lines.push(`原因：${cleanLine(record.reason)}`);
  if (text(record.inspector)) lines.push(`檢查人：${cleanLine(record.inspector)}`);
  return lines.join('\n');
}

function existingMarkers(db) {
  const result = new Map();
  const rows = db.prepare("SELECT Id, Remarks FROM maintenance_batches WHERE Remarks LIKE '%[AMRS-SYNC:%'").all();
  for (const row of rows) {
    for (const match of text(row.Remarks).matchAll(MARKER)) {
      const entries = result.get(match[1]) || [];
      entries.push({ batchId: row.Id, digest: match[2] });
      result.set(match[1], entries);
    }
  }
  return result;
}

function existingMarkerForKey(db, key) {
  const rows = db.prepare('SELECT Id, Remarks FROM maintenance_batches WHERE Remarks LIKE ?')
    .all(`%[AMRS-SYNC:${key}:%`);
  const matches = [];
  for (const row of rows) {
    for (const match of text(row.Remarks).matchAll(MARKER)) {
      if (match[1] === key) matches.push({ batchId: row.Id, digest: match[2] });
    }
  }
  return matches;
}

function installationsForSerial(db, serial) {
  return db.prepare(`
    SELECT i.Id AS installationId, i.SystemNo AS systemNo,
           c.Name AS customerName, b.Name AS branchName
    FROM product_assets AS asset
    JOIN installation_devices AS device ON device.ProductAssetId = asset.Id
    JOIN installations AS i ON i.Id = device.InstallationId
    JOIN customers AS c ON c.Id = i.CustomerId
    LEFT JOIN branches AS b ON b.Id = i.BranchId
    WHERE asset.SerialNumber = ? COLLATE NOCASE
      AND asset.IsDeleted = 0 AND i.IsActive = 1
  `).all(serial);
}

function installationFor(db, record, venueMap) {
  const serial = text(record.serialNo);
  if (!serial) return { reason: 'missing-serial' };
  const rows = installationsForSerial(db, serial);
  if (!rows.length) return { reason: 'serial-not-found' };

  const venue = text(record.casino);
  const configured = venueMap[`${text(record.company)}|${venue}`];
  const matching = rows.filter((row) => configured
    ? comparable(row.customerName) === comparable(configured.customer)
      && comparable(row.branchName) === comparable(configured.branch)
    : comparable(row.branchName || row.customerName) === comparable(venue));
  if (!matching.length) return { reason: 'venue-mismatch' };
  if (matching.length !== 1) return { reason: 'ambiguous-serial' };
  const sameSystemNo = db.prepare('SELECT COUNT(*) AS total FROM installations WHERE IsActive = 1 AND SystemNo = ? COLLATE NOCASE')
    .get(matching[0].systemNo).total;
  if (sameSystemNo !== 1) return { reason: 'ambiguous-system-no' };
  return { installation: matching[0] };
}

export function suggestVenueMappings(records, db) {
  const venues = new Map();
  for (const record of records) {
    const key = `${text(record.company)}|${text(record.casino)}`;
    if (!venues.has(key)) venues.set(key, { candidates: new Map(), uncertain: false });
    const item = venues.get(key);
    const matches = installationsForSerial(db, text(record.serialNo));
    if (matches.length !== 1) {
      item.uncertain = true;
      continue;
    }
    const candidate = { customer: matches[0].customerName, branch: matches[0].branchName || '' };
    item.candidates.set(JSON.stringify(candidate), candidate);
  }
  return Object.fromEntries([...venues].map(([key, item]) => [
    key,
    !item.uncertain && item.candidates.size === 1 ? [...item.candidates.values()][0] : null,
  ]));
}

export function planSync(records, db, venueMap = {}) {
  const plan = { ready: [], already: [], changed: [], blocked: [] };
  const seen = new Set();
  const destination = existingMarkers(db);
  for (const record of records) {
    if (!text(record?.recordId)) {
      plan.blocked.push({ reason: 'missing-record-id' });
      continue;
    }
    const date = maintenanceDate(record.date);
    if (!date) {
      plan.blocked.push({ reason: 'invalid-date' });
      continue;
    }
    if (!text(record.company)) {
      plan.blocked.push({ reason: 'missing-company' });
      continue;
    }
    const key = sourceMarker(record);
    if (seen.has(key)) {
      plan.blocked.push({ reason: 'duplicate-source-id' });
      continue;
    }
    seen.add(key);
    const content = contentMarker(record, date);
    const found = destination.get(key) || [];
    if (found.length > 1) {
      plan.blocked.push({ reason: 'duplicate-destination-marker' });
      continue;
    }
    if (found.length === 1) {
      plan[found[0].digest === content ? 'already' : 'changed'].push({ key });
      continue;
    }
    const match = installationFor(db, record, venueMap);
    if (match.reason) {
      plan.blocked.push({ reason: match.reason });
      continue;
    }
    plan.ready.push({
      key,
      content,
      payload: {
        systemNos: [match.installation.systemNo],
        maintenanceDate: date,
        remarks: remarksFor(record, key, content),
        confirmEmptySlots: false,
      },
    });
  }
  plan.counts = {
    total: records.length,
    ready: plan.ready.length,
    already: plan.already.length,
    changed: plan.changed.length,
    blocked: plan.blocked.length,
  };
  return plan;
}

export async function runSync(plan, aftersalesClient, db, onResult = () => {}) {
  const result = { created: 0, reconciled: 0, failed: 0 };
  for (const item of plan.ready) {
    const before = existingMarkerForKey(db, item.key);
    if (before.length === 1 && before[0].digest === item.content) {
      result.reconciled += 1;
      onResult('reconciled');
      continue;
    }
    if (before.length) {
      result.failed += 1;
      onResult('failed', 0);
      continue;
    }
    try {
      await aftersalesClient.createMaintenance(item.payload);
      const confirmed = existingMarkerForKey(db, item.key);
      if (confirmed.length !== 1 || confirmed[0].digest !== item.content) {
        throw new Error('Write was not confirmed in aftersales');
      }
      result.created += 1;
      onResult('created');
    } catch (error) {
      const reconciled = existingMarkerForKey(db, item.key);
      if (reconciled.length === 1 && reconciled[0].digest === item.content) {
        result.reconciled += 1;
        onResult('reconciled');
      } else {
        result.failed += 1;
        onResult('failed', Number(error?.status) || 0);
      }
    }
  }
  return result;
}

async function responseJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.success === false) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export class AmrsClient {
  constructor({ baseUrl, credential = '', mode = 'worker', fetchImpl = fetch }) {
    this.baseUrl = new URL(baseUrl);
    if (this.baseUrl.protocol !== 'https:') throw new Error('AMRS URL must use HTTPS');
    if (!['worker', 'gas'].includes(mode)) throw new Error('Unsupported AMRS mode');
    this.mode = mode;
    this.credential = credential;
    this.fetchImpl = fetchImpl;
    this.session = '';
  }

  async queryDashboard(params, refreshed = false) {
    const url = new URL(this.mode === 'worker' ? '/api' : this.baseUrl.href, this.baseUrl);
    for (const [key, value] of Object.entries({ action: 'dashboard', ...params, sort: 'oldest', pageSize: 100, includeParts: 0 })) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    if (this.mode === 'gas') return responseJson(await this.fetchImpl(url));
    if (!this.session) {
      const session = await responseJson(await this.fetchImpl(new URL('/session', this.baseUrl), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: this.credential }),
      }));
      this.session = text(session.token);
      if (!this.session) throw new Error('AMRS session token missing');
    }
    const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.session}` } });
    if (response.status === 401 && !refreshed) {
      this.session = '';
      return this.queryDashboard(params, true);
    }
    return responseJson(response);
  }
}

export async function fetchAmrsHistory(client, companies, { from = '', to = '' } = {}) {
  const records = [];
  for (const company of companies) {
    let page = 1;
    let totalPages = 1;
    do {
      const response = await client.queryDashboard({ company, from, to, page });
      if (!Array.isArray(response.records)) throw new Error('AMRS dashboard response has no records array');
      records.push(...response.records);
      totalPages = Number(response.totalPages) || 1;
      page += 1;
      if (page > 10000) throw new Error('AMRS dashboard pagination exceeded safety limit');
    } while (page <= totalPages);
  }
  return records;
}

export class AfterSalesClient {
  constructor({ baseUrl = 'http://127.0.0.1:5000', username, password, fetchImpl = fetch }) {
    this.baseUrl = new URL(baseUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(this.baseUrl.hostname)
      || !['http:', 'https:'].includes(this.baseUrl.protocol)) {
      throw new Error('aftersales URL must be loopback');
    }
    this.username = username;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.cookies = new Map();
    this.csrf = '';
    this.authenticated = false;
  }

  async request(path, options = {}) {
    const headers = { ...options.headers };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await this.fetchImpl(new URL(path, this.baseUrl), { ...options, headers });
    for (const cookie of response.headers.getSetCookie?.() || []) {
      const first = cookie.split(';', 1)[0];
      const index = first.indexOf('=');
      if (index > 0) this.cookies.set(first.slice(0, index), first.slice(index + 1));
    }
    return responseJson(response);
  }

  async login() {
    const csrf = await this.request('/api/auth/csrf');
    this.csrf = text(csrf.csrfToken);
    if (!this.csrf) throw new Error('aftersales CSRF token missing');
    await this.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf },
      body: JSON.stringify({ username: this.username, password: this.password, rememberMe: false }),
    });
    this.authenticated = true;
  }

  async createMaintenance(payload, refreshed = false) {
    if (!this.authenticated) await this.login();
    try {
      return await this.request('/api/maintenance/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (error.status !== 401 || refreshed) throw error;
      this.authenticated = false;
      this.cookies.clear();
      return this.createMaintenance(payload, true);
    }
  }
}
