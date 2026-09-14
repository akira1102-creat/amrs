import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from './database.mjs';
import { openWorksheets } from './worksheets.mjs';
import { createRepository } from '../worker/src/repository.mjs';
import { handleRequest } from '../worker/src/api.mjs';
import { COMPANIES } from '../worker/src/config.mjs';
import { initializeWorkbooks } from './initialize.mjs';

export function openRuntime(directory) {
  mkdirSync(directory, { recursive: true });
  const secretFile = join(directory, 'session-secret');
  try { writeFileSync(secretFile, randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const db = openDatabase(join(directory, 'system.sqlite'));
  const sheets = openWorksheets(join(directory, 'worksheets.sqlite'));
  initializeWorkbooks(sheets);
  const config = {
    sheets: Object.fromEntries(COMPANIES.map(company => [company, company])),
    partsSheetId: 'parts', scheduleSheetId: 'schedule', cvcsSheetId: 'cvcs',
    galaxyLogSheetId: 'galaxy-log', mgmCheckRequestSheetId: 'mgm-check-request',
    timeZone: 'Asia/Hong_Kong',
  };
  const env = { DB: db, AMRS_TOKEN_SECRET: readFileSync(secretFile, 'utf8') };
  const repository = createRepository(env, {
    config, sheetsClient: sheets,
  });
  return {
    db, sheets, config,
    handle: request => handleRequest(request, env, { repository }),
    close() { db.close(); sheets.close(); },
  };
}
