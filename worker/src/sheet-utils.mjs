function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new RangeError(`${label} must be a positive integer`);
  return number;
}

export function columnNumberToA1(value) {
  let number = positiveInteger(value, "Column");
  let result = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result;
}

export function a1ColumnToNumber(value) {
  const label = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]+$/.test(label)) throw new RangeError("A1 column must contain letters only");
  let number = 0;
  for (const character of label) number = number * 26 + character.charCodeAt(0) - 64;
  return number;
}

export function quoteSheetName(value) {
  const name = String(value || "").trim();
  if (!name) throw new TypeError("Sheet name is required");
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

export function a1Range(sheetNameOrOptions, startRow, startColumn, endRow, endColumn) {
  let options;
  if (sheetNameOrOptions && typeof sheetNameOrOptions === "object") {
    options = sheetNameOrOptions;
  } else {
    options = { sheetName: sheetNameOrOptions, startRow, startColumn, endRow, endColumn };
  }
  const row = positiveInteger(options.startRow ?? options.row, "Start row");
  const column = positiveInteger(options.startColumn ?? options.column, "Start column");
  const finalRow = options.endRow != null
    ? positiveInteger(options.endRow, "End row")
    : options.rowCount == null
      ? row
      : row + positiveInteger(options.rowCount, "Row count") - 1;
  const finalColumn = options.endColumn != null
    ? positiveInteger(options.endColumn, "End column")
    : options.columnCount == null
      ? column
      : column + positiveInteger(options.columnCount, "Column count") - 1;
  if (finalRow < row || finalColumn < column) throw new RangeError("A1 range end must not precede its start");
  const prefix = options.sheetName == null && options.sheet == null
    ? ""
    : `${quoteSheetName(options.sheetName ?? options.sheet)}!`;
  const first = `${columnNumberToA1(column)}${row}`;
  const last = `${columnNumberToA1(finalColumn)}${finalRow}`;
  return `${prefix}${first}${finalRow === row && finalColumn === column ? "" : `:${last}`}`;
}

export function a1Cell(sheetName, row, column) {
  return a1Range(sheetName, row, column);
}

export function a1RowRange(sheetName, row, startColumn, endColumn) {
  return a1Range(sheetName, row, startColumn, row, endColumn);
}
