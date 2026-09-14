function text(value) {
  return String(value == null ? "" : value).trim();
}

function parseCsvRows(value) {
  const source = String(value || "").replace(/^\ufeff/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some((item) => text(item) !== "")) rows.push(row);
      row = [];
      continue;
    }
    cell += character;
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some((item) => text(item) !== "")) rows.push(row);
  }
  return rows;
}

export async function readPublicGalaxyCsv(spreadsheetId, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw Object.assign(new Error("公開清單暫時未能讀取"), { status: 503, retryable: true });
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/export?format=csv`;
  const response = await fetchImpl(url, { method: "GET", headers: { accept: "text/csv" } });
  const status = Number(response?.status || 0);
  const body = typeof response?.text === "function" ? await response.text() : "";
  const ok = response?.ok ?? (status >= 200 && status < 300);
  if (!ok) throw Object.assign(new Error("公開清單暫時未能讀取"), { status: status || 502, retryable: status >= 500 });
  return parseCsvRows(body);
}
