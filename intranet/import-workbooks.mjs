import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { COMPANIES } from '../worker/src/config.mjs';

const XLSX = createRequire(import.meta.url)('../xlsx.mini.min.js');
const allowed = new Set([...COMPANIES, 'parts', 'schedule', 'cvcs', 'galaxy-log', 'mgm-check-request']);

export function workbookFromBytes(id, bytes) {
  if (!allowed.has(id)) throw new Error('Unknown AMRS workbook');
  const source = XLSX.read(bytes, { type: 'buffer', cellDates: false });
  if (!source.SheetNames.length) throw new Error('Workbook has no worksheets');
  return { id, sheets: source.SheetNames.map((title, index) => {
    const sheet = source.Sheets[title];
    // Formatted values preserve date strings and leading zero identifiers.
    const values = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: true });
    for (const merge of sheet['!merges'] || []) {
      const value = values[merge.s.r]?.[merge.s.c] ?? '';
      for (let r = merge.s.r; r <= merge.e.r; r++) {
        values[r] ||= [];
        for (let c = merge.s.c; c <= merge.e.c; c++) if (!values[r][c]) values[r][c] = value;
      }
    }
    return { properties: { title, sheetId: index + 1, index, gridProperties: {
      rowCount: Math.max(1000, values.length), columnCount: Math.max(200, ...values.map(row => row.length)),
    } }, values };
  }) };
}

export function readWorkbookManifest(filename) {
  const manifest = JSON.parse(readFileSync(filename, 'utf8'));
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object' || !Object.keys(manifest).length) throw new Error('Expected workbook ID to local file mapping');
  const entries = Object.entries(manifest);
  const unknown = entries.map(([id]) => id).filter(id => !allowed.has(id));
  if (unknown.length) throw new Error(`Unknown AMRS workbook mappings: ${unknown.join(', ')}`);
  const missing = [...allowed].filter(id => !Object.hasOwn(manifest, id));
  if (missing.length) throw new Error(`Missing workbook mappings: ${missing.join(', ')}`);
  if (entries.some(([, file]) => typeof file !== 'string' || !file)) throw new Error('Invalid workbook filename');
  return { format: 'amrs-local-worksheets', version: 1, createdAt: new Date().toISOString(),
    workbooks: entries.map(([id, file]) => {
      return workbookFromBytes(id, readFileSync(resolve(dirname(filename), file)));
    }),
  };
}
