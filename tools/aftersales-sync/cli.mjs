import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AfterSalesClient, AmrsClient, fetchAmrsHistory, planMissingMachines, planSync, provisionMachines, runSync, suggestVenueMappings } from './bridge.mjs';

const COMPANIES = ['Melco', 'MGM', 'SJM', 'SCL', 'GEG', 'Wynn'];
const here = path.dirname(fileURLToPath(import.meta.url));

export function parseOptions(argv) {
  const options = {
    command: 'preview', amrsMode: 'worker', amrsUrl: '', aftersalesUrl: 'http://127.0.0.1:5000',
    dbPath: '', venueMapPath: '', companies: [...COMPANIES], from: '', intervalMinutes: 60,
    autoCreateMissing: false, installDateSource: '',
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('--')) options.command = args.shift();
  if (!['preview', 'apply', 'watch', 'map'].includes(options.command)) throw new Error('Unknown command');
  while (args.length) {
    const name = args.shift();
    if (name === '--auto-create-missing') { options.autoCreateMissing = true; continue; }
    const key = {
      '--amrs-mode': 'amrsMode', '--amrs-url': 'amrsUrl', '--aftersales-url': 'aftersalesUrl',
      '--db': 'dbPath', '--venue-map': 'venueMapPath', '--companies': 'companies',
      '--from': 'from', '--interval-minutes': 'intervalMinutes', '--install-date-source': 'installDateSource',
    }[name];
    if (!key) throw new Error(`Unknown option: ${name}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    options[key] = value;
  }
  if (!['worker', 'gas'].includes(options.amrsMode)) throw new Error('Invalid AMRS mode');
  if (typeof options.companies === 'string') {
    options.companies = [...new Set(options.companies.split(',').map(item => item.trim()).filter(Boolean))];
    if (!options.companies.length || options.companies.some(item => !COMPANIES.includes(item))) throw new Error('Invalid company list');
  }
  if (options.from) {
    const match = options.from.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const parsed = match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (!parsed || parsed.toISOString().slice(0, 10) !== options.from) throw new Error('Invalid from date');
  }
  options.intervalMinutes = Number(options.intervalMinutes);
  if (!Number.isInteger(options.intervalMinutes) || options.intervalMinutes < 5) throw new Error('Interval must be at least 5 minutes');
  if (options.autoCreateMissing && options.installDateSource !== 'earliest-service') {
    throw new Error('Installation date source must be earliest-service for automatic creation');
  }
  return options;
}

export async function runCycle(options, { db, amrs, aftersales, venueMap = {} }) {
  const records = await fetchAmrsHistory(amrs, options.companies, { from: options.from });
  let directory = aftersales ? await aftersales.get('/api/customers') : null;
  if (options.command === 'map') return { suggestions: suggestVenueMappings(records, db, directory), total: records.length };
  let plan = planSync(records, db, venueMap, directory);
  const missing = plan.blocked.filter(item => item.reason === 'serial-not-found').map(item => item.record);
  const provisionPlan = planMissingMachines(missing, db, venueMap);
  const result = { provisionableMachines: provisionPlan.machines.length, provisionBlockedReasons: provisionPlan.blockedReasons };
  if ((options.command === 'apply' || options.command === 'watch') && options.autoCreateMissing) {
    if (!aftersales) throw new Error('aftersales credentials required for automatic creation');
    result.provision = await provisionMachines(provisionPlan.machines, db, aftersales,
      { installDateSource: options.installDateSource });
    directory = await aftersales.get('/api/customers');
    plan = planSync(records, db, venueMap, directory);
  }
  result.counts = plan.counts;
  result.blockedReasons = Object.fromEntries([...new Set(plan.blocked.map(item => item.reason))].sort()
    .map(reason => [reason, plan.blocked.filter(item => item.reason === reason).length]));
  if (options.command === 'apply' || options.command === 'watch') {
    if (!aftersales) throw new Error('aftersales credentials required for writing');
    result.writes = await runSync(plan, aftersales, db);
  }
  return result;
}

async function defaultWorkerUrl() {
  const source = await readFile(path.resolve(here, '../../index.html'), 'utf8');
  const match = source.match(/const _CLOUDFLARE_API_URL='(https:\/\/[^']+)'/);
  if (!match) throw new Error('AMRS Worker URL is not configured; pass --amrs-url');
  return match[1];
}

function printResult(result) {
  if (result.suggestions) return;
  console.log(JSON.stringify({ ...result.counts, blockedReasons: result.blockedReasons,
    provisionableMachines: result.provisionableMachines, provisionBlockedReasons: result.provisionBlockedReasons,
    ...(result.provision ? { provision: result.provision } : {}),
    ...(result.writes ? { writes: result.writes } : {}) }, null, 2));
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const dbPath = options.dbPath || path.resolve(here, '../../../aftersales/data/data/aftersales.db');
  if (!existsSync(dbPath)) throw new Error('aftersales database not found; pass --db');
  const credential = process.env.AMRS_SYNC_CREDENTIAL || '';
  if (!credential) throw new Error('AMRS_SYNC_CREDENTIAL is required');
  const amrsUrl = options.amrsUrl || (options.amrsMode === 'worker'
    ? await defaultWorkerUrl()
    : `https://script.google.com/macros/s/${encodeURIComponent(credential)}/exec`);
  const amrs = new AmrsClient({ baseUrl: amrsUrl, credential, mode: options.amrsMode });
  const venueMapPath = options.venueMapPath || path.resolve(here, 'venue-map.local.json');
  const venueMap = existsSync(venueMapPath) ? JSON.parse(await readFile(venueMapPath, 'utf8')) : {};
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const aftersales = new AfterSalesClient({
        baseUrl: options.aftersalesUrl,
        username: process.env.AFTERSALES_SYNC_USERNAME || '',
        password: process.env.AFTERSALES_SYNC_PASSWORD || '',
      });
    if (!aftersales.username || !aftersales.password) throw new Error('aftersales username and password are required');

    if (options.command === 'map') {
      const { suggestions, total } = await runCycle(options, { db, amrs, aftersales });
      const target = options.venueMapPath || path.resolve(here, 'venue-map.suggested.local.json');
      await writeFile(target, `${JSON.stringify(suggestions, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      console.log(`Reviewed mapping template created. Records scanned: ${total}. Venue entries: ${Object.keys(suggestions).length}.`);
      console.log('Review the suggested local venue map before using it for apply.');
      return;
    }

    if (options.command !== 'watch') {
      printResult(await runCycle(options, { db, amrs, aftersales, venueMap }));
      return;
    }
    let lastFull = 0;
    for (;;) {
      const now = Date.now();
      const full = now - lastFull >= 24 * 60 * 60 * 1000;
      const from = full ? options.from : new Date(now - 45 * 86400000).toISOString().slice(0, 10);
      try {
        printResult(await runCycle({ ...options, from }, { db, amrs, aftersales, venueMap }));
        if (full) lastFull = now;
      } catch (error) {
        console.error(`Sync cycle failed${error?.status ? ` (HTTP ${error.status})` : ''}.`);
      }
      await new Promise(resolve => setTimeout(resolve, options.intervalMinutes * 60_000));
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main().catch(error => {
    const code = error?.status ? `HTTP ${error.status}` : error?.code || 'configuration or connection error';
    console.error(`Sync stopped (${code}).`);
    process.exitCode = 1;
  });
}
