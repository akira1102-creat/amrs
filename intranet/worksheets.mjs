import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function column(value) {
  return [...value.toUpperCase()].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function rangeParts(range) {
  const match = String(range).match(/^(?:'((?:[^']|'')+)'|([^!]+))!(\$?[A-Z]+\$?\d*)(?::(\$?[A-Z]+\$?\d*))?$/i);
  if (!match) throw new Error('Unsupported worksheet range');
  const cell = value => {
    const [, letters, digits] = value.replaceAll('$', '').match(/^([A-Z]+)(\d*)$/i);
    return { col: column(letters), row: digits ? Number(digits) - 1 : null };
  };
  const start = cell(match[3]), end = cell(match[4] || match[3]);
  return { title: (match[1] || match[2]).replaceAll("''", "'"), startCol: start.col, endCol: end.col, startRow: start.row ?? 0, endRow: end.row ?? Infinity };
}

export function openWorksheets(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS workbooks (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  function read(id) {
    const row = db.prepare('SELECT data FROM workbooks WHERE id=?').get(String(id));
    if (!row) throw Object.assign(new Error('Local workbook not found'), { status: 404 });
    return JSON.parse(row.data);
  }
  function write(id, workbook) {
    db.prepare('INSERT INTO workbooks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(String(id), JSON.stringify(workbook));
  }
  function mutate(id, callback) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const workbook = read(id);
      const result = callback(workbook);
      write(id, workbook);
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function sheetFor(workbook, title) {
    const sheet = workbook.sheets.find(sheet => sheet.properties.title === title);
    if (!sheet) throw Object.assign(new Error('Local worksheet not found'), { status: 400 });
    return sheet;
  }
  function put(workbook, range, values) {
    const area = rangeParts(range), sheet = sheetFor(workbook, area.title);
    if (!Array.isArray(values) || values.some(row => !Array.isArray(row))) throw new Error('Invalid worksheet values');
    values.forEach((row, offset) => {
      const target = sheet.values[area.startRow + offset] ||= [];
      row.forEach((value, index) => { if (value !== null) target[area.startCol + index] = value; });
    });
    return { updatedRange: range, updatedRows: values.length, updatedCells: values.reduce((sum, row) => sum + row.length, 0) };
  }
  const client = {
    async request({ path }) {
      const match = String(path).match(/^spreadsheets\/([^/]+)$/);
      if (!match) throw new Error('Unsupported local metadata request');
      const workbook = read(decodeURIComponent(match[1]));
      return { sheets: workbook.sheets.map(sheet => ({ properties: sheet.properties })) };
    },
    async valuesGet({ spreadsheetId, range }) {
      const area = rangeParts(range), sheet = sheetFor(read(spreadsheetId), area.title);
      const values = sheet.values.slice(area.startRow, area.endRow + 1).map(row => {
        const cells = Array.from({ length: Math.max(0, Math.min(row.length, area.endCol + 1) - area.startCol) }, (_, index) => row[area.startCol + index] ?? '');
        while (cells.length && cells.at(-1) === '') cells.pop();
        return cells;
      });
      while (values.length && !values.at(-1).length) values.pop();
      return { range, values };
    },
    async valuesBatchGet({ spreadsheetId, ranges }) { return { valueRanges: await Promise.all(ranges.map(range => client.valuesGet({ spreadsheetId, range }))) }; },
    async valuesUpdate({ spreadsheetId, range, values }) { return mutate(spreadsheetId, workbook => put(workbook, range, values)); },
    async valuesBatchUpdate({ spreadsheetId, data }) {
      return mutate(spreadsheetId, workbook => ({ responses: data.map(item => put(workbook, item.range, item.values)) }));
    },
    async valuesAppend({ spreadsheetId, range, values }) {
      return mutate(spreadsheetId, workbook => {
        const area = rangeParts(range), sheet = sheetFor(workbook, area.title);
        let end = sheet.values.length;
        while (end && !sheet.values[end - 1].some(value => value !== '' && value != null)) end--;
        const letters = String(range).split('!').at(-1).match(/[A-Z]+/i)[0];
        const target = `'${area.title.replaceAll("'", "''")}'!${letters}${end + 1}`;
        return { updates: put(workbook, target, values) };
      });
    },
    async spreadsheetBatchUpdate({ spreadsheetId, requests }) {
      return mutate(spreadsheetId, workbook => ({ replies: requests.map(request => {
        if (request.addSheet) {
          const title = request.addSheet.properties.title;
          if (workbook.sheets.some(sheet => sheet.properties.title === title)) throw new Error('Worksheet already exists');
          const properties = { ...request.addSheet.properties, sheetId: Math.max(0, ...workbook.sheets.map(sheet => sheet.properties.sheetId)) + 1, index: workbook.sheets.length, gridProperties: { rowCount: 1000, columnCount: 200 } };
          workbook.sheets.push({ properties, values: [] });
          return { addSheet: { properties } };
        }
        const change = request.deleteDimension || request.insertDimension;
        if (change) {
          const { sheetId, dimension, startIndex, endIndex } = change.range;
          const sheet = workbook.sheets.find(sheet => sheet.properties.sheetId === sheetId);
          if (!sheet || !['ROWS', 'COLUMNS'].includes(dimension)) throw new Error('Invalid worksheet dimension');
          const count = endIndex - startIndex;
          if (!Number.isInteger(count) || count < 0 || startIndex < 0) throw new Error('Invalid worksheet indexes');
          if (dimension === 'ROWS') sheet.values.splice(startIndex, request.deleteDimension ? count : 0, ...(request.insertDimension ? Array.from({ length: count }, () => []) : []));
          else sheet.values.forEach(row => row.splice(startIndex, request.deleteDimension ? count : 0, ...(request.insertDimension ? Array(count).fill('') : [])));
          const key = dimension === 'ROWS' ? 'rowCount' : 'columnCount';
          sheet.properties.gridProperties[key] += request.deleteDimension ? -count : count;
          return {};
        }
        if (request.updateDimensionProperties) return {}; // Visibility is handled by the AMRS editor.
        throw new Error('Unsupported local worksheet operation');
      }) }));
    },
  };
  return {
    ...client,
    exists(id) { return !!db.prepare('SELECT id FROM workbooks WHERE id=?').get(String(id)); },
    initialize(id, sheets) {
      if (db.prepare('SELECT id FROM workbooks WHERE id=?').get(String(id))) throw new Error('Workbook already exists');
      write(id, { sheets: Object.entries(sheets).map(([title, values], index) => ({ properties: { title, sheetId: index + 1, index, gridProperties: { rowCount: Math.max(1000, values.length), columnCount: 200 } }, values })) });
    },
    close: () => db.close(),
  };
}
