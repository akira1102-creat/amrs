import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  AA_TAG_SHEET,
  BROKEN_PARTS_SHEET,
  COMPANIES,
  MONTHLY_SHEET,
  TEMPLATE_SHEET,
  WORKSHEET_NAME,
  companySchema,
} from '../worker/src/config.mjs';
import { CVCS_OPTION_SHEETS } from '../worker/src/cvcs-domain.mjs';
import {
  CVCS_BROKEN_PARTS_SHEET,
  CVCS_PARTS_LIST_SHEET,
  CVCS_RECORDS_SHEET,
} from '../worker/src/cvcs-repository.mjs';
import { MGM_CHECK_REQUEST_SHEETS } from '../worker/src/domain.mjs';

const XLSX = createRequire(import.meta.url)('../xlsx.mini.min.js');
export const IMPORT_WORKBOOKS = Object.freeze([
  ...COMPANIES.map(id => ({ id, label: `${id} 維護資料` })),
  { id: 'parts', label: '零件資料' },
  { id: 'schedule', label: '工作安排' },
  { id: 'cvcs', label: 'CVCS' },
  { id: 'galaxy-log', label: 'Galaxy 取 Log' },
  { id: 'mgm-check-request', label: 'MGM Check Request' },
]);
const allowed = new Set(IMPORT_WORKBOOKS.map(({ id }) => id));
const supportingCompanySheets = [BROKEN_PARTS_SHEET, TEMPLATE_SHEET, AA_TAG_SHEET, MONTHLY_SHEET];
const requiredSheets = {
  schedule: ['Setup'],
  cvcs: [CVCS_RECORDS_SHEET, CVCS_BROKEN_PARTS_SHEET, CVCS_PARTS_LIST_SHEET, ...Object.values(CVCS_OPTION_SHEETS)],
  'mgm-check-request': MGM_CHECK_REQUEST_SHEETS,
};

const WINDOWS_PICKER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms',
  '$items = ConvertFrom-Json -InputObject $env:AMRS_IMPORT_WORKBOOKS',
  '$selected = @()',
  "$initialDirectory = ''",
  'foreach ($item in $items) {',
  '  $dialog = New-Object System.Windows.Forms.OpenFileDialog',
  '  $dialog.Title = "請選擇 $($item.label) 的 Excel 檔案"',
  "  $dialog.Filter = 'Excel 工作簿 (*.xlsx;*.xlsm;*.xls)|*.xlsx;*.xlsm;*.xls|所有檔案 (*.*)|*.*'",
  '  $dialog.Multiselect = $false',
  '  $dialog.CheckFileExists = $true',
  '  $dialog.RestoreDirectory = $true',
  '  if ($initialDirectory) { $dialog.InitialDirectory = $initialDirectory }',
  '  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { $dialog.Dispose(); exit 2 }',
  '  $selected += [PSCustomObject]@{ id = [string]$item.id; file = [string]$dialog.FileName }',
  '  $initialDirectory = [System.IO.Path]::GetDirectoryName($dialog.FileName)',
  '  $dialog.Dispose()',
  '}',
  '$json = ConvertTo-Json -InputObject @($selected) -Depth 3 -Compress',
  '[Console]::WriteLine([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json)))',
].join('\n');

function matchingSheet(sheets, title) {
  const expected = title.toLowerCase();
  return sheets.find(sheet => String(sheet.properties.title).trim().toLowerCase() === expected) || null;
}

function columnCount(sheet) {
  return (sheet?.values || []).reduce((maximum, row) => Math.max(maximum, Array.isArray(row) ? row.length : 0), 0);
}

function requireSheet(id, sheets, title) {
  if (!matchingSheet(sheets, title)) throw new Error(`AMRS workbook ${id} is missing required worksheet "${title}"`);
}

function validateWorkbook(id, sheets) {
  if (COMPANIES.includes(id)) {
    const main = matchingSheet(sheets, WORKSHEET_NAME) || sheets[0];
    const minimumColumns = companySchema(id).width;
    if (columnCount(main) < minimumColumns) {
      throw new Error(`AMRS workbook ${id} must include "${WORKSHEET_NAME}" or a compatible first worksheet with at least ${minimumColumns} columns`);
    }
    for (const title of supportingCompanySheets) requireSheet(id, sheets, title);
    return;
  }

  for (const title of requiredSheets[id] || []) requireSheet(id, sheets, title);

  // These two workbook readers intentionally support legacy files whose first tab has a different title.
  const fallbackSheets = { parts: { title: 'Parts Code', width: 3 }, 'galaxy-log': { title: 'Galaxy Log', width: 3 } };
  const fallback = fallbackSheets[id];
  if (fallback) {
    const sheet = matchingSheet(sheets, fallback.title) || sheets[0];
    if (columnCount(sheet) < fallback.width) {
      throw new Error(`AMRS workbook ${id} must include "${fallback.title}" or a compatible first worksheet with at least ${fallback.width} columns`);
    }
  }
}

export function workbookFromBytes(id, bytes) {
  if (!allowed.has(id)) throw new Error('Unknown AMRS workbook');
  const source = XLSX.read(bytes, { type: 'buffer', cellDates: false });
  if (!source.SheetNames.length) throw new Error('Workbook has no worksheets');
  const sheets = source.SheetNames.map((title, index) => {
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
  });
  validateWorkbook(id, sheets);
  return { id, sheets };
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

export function selectWorkbookFiles({ platform = process.platform, spawn = spawnSync } = {}) {
  if (platform !== 'win32') throw new Error('Excel 檔案選擇器只支援 Windows；可改用 mapping JSON 匯入。');
  const result = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-Command', WINDOWS_PICKER_SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, AMRS_IMPORT_WORKBOOKS: JSON.stringify(IMPORT_WORKBOOKS) },
  });
  if (result.error) throw new Error(`無法開啟本機 Excel 檔案選擇器：${result.error.message}`);
  if (result.status === 2) return null;
  if (result.status !== 0) {
    const detail = String(result.stderr || '').trim();
    throw new Error(`Excel 檔案選擇器失敗${detail ? `：${detail}` : `（代碼 ${result.status ?? '未知'}）`}`);
  }

  const output = Buffer.isBuffer(result.stdout) ? result.stdout.toString('ascii') : String(result.stdout ?? '');
  const encoded = output.trim();
  if (!encoded) throw new Error('Excel 檔案選擇器沒有回傳所選檔案。');
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    throw new Error('Excel 檔案選擇器回傳資料無效。');
  }
}

export function readSelectedWorkbooks(selections) {
  if (!Array.isArray(selections)) throw new Error('Expected AMRS workbook file selections');
  const files = new Map();
  for (const selection of selections) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)
      || typeof selection.id !== 'string' || typeof selection.file !== 'string' || !selection.file.trim()) {
      throw new Error('Invalid AMRS workbook file selection');
    }
    if (!allowed.has(selection.id)) throw new Error(`Unknown workbook selection: ${selection.id}`);
    if (files.has(selection.id)) throw new Error(`Duplicate workbook selection: ${selection.id}`);
    files.set(selection.id, resolve(selection.file));
  }
  const missing = IMPORT_WORKBOOKS.map(({ id }) => id).filter(id => !files.has(id));
  if (missing.length) throw new Error(`Missing workbook selections: ${missing.join(', ')}`);
  return {
    format: 'amrs-local-worksheets',
    version: 1,
    createdAt: new Date().toISOString(),
    workbooks: IMPORT_WORKBOOKS.map(({ id }) => workbookFromBytes(id, readFileSync(files.get(id)))),
  };
}
