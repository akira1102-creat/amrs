import assert from "node:assert/strict";
import test from "node:test";
import {
  a1Range,
  columnNumberToA1,
  createSheetsClient,
  valuesBatchGet,
} from "../src/sheets.mjs";

test("builds valid A1 columns and sheet ranges", () => {
  assert.equal(columnNumberToA1(1), "A");
  assert.equal(columnNumberToA1(26), "Z");
  assert.equal(columnNumberToA1(27), "AA");
  assert.equal(a1Range("Sheet 1", 2, 1, 4, 3), "'Sheet 1'!A2:C4");
  assert.equal(a1Range("Worksheet", 7, 2), "Worksheet!B7");
  assert.equal(a1Range({ sheet: "Worksheet", row: 2, column: 2, rowCount: 2, columnCount: 3 }), "Worksheet!B2:D3");
});

test("covers values get, batchGet, append, update and both batchUpdate endpoints", async () => {
  const requests = [];
  const client = createSheetsClient({
    accessToken: "synthetic-access-token",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    sleep: async () => {},
  });

  await client.valuesGet({ spreadsheetId: "synthetic-sheet-id", range: "Worksheet!A1:B2" });
  await client.valuesBatchGet({ spreadsheetId: "synthetic-sheet-id", ranges: ["Worksheet!A1", "Worksheet!B2"] });
  await client.valuesAppend({ spreadsheetId: "synthetic-sheet-id", range: "Worksheet!A:B", values: [["x", "y"]] });
  await client.valuesUpdate({ spreadsheetId: "synthetic-sheet-id", range: "Worksheet!A1:B1", values: [["x", "y"]] });
  await client.valuesBatchUpdate({
    spreadsheetId: "synthetic-sheet-id",
    data: [{ range: "Worksheet!A1", values: [["x"]] }],
  });
  await client.spreadsheetBatchUpdate({
    spreadsheetId: "synthetic-sheet-id",
    requests: [{ updateSheetProperties: { properties: { sheetId: 1 } } }],
  });

  assert.equal(requests.length, 6);
  assert.match(requests[0].url, /\/values\/Worksheet%21A1%3AB2$/);
  assert.match(requests[1].url, /\/values:batchGet\?/);
  assert.match(requests[1].url, /ranges=Worksheet%21A1/);
  assert.match(requests[2].url, /:append\?/);
  assert.match(requests[3].url, /\/values\/Worksheet%21A1%3AB1\?/);
  assert.match(requests[4].url, /\/values:batchUpdate$/);
  assert.match(requests[5].url, /:batchUpdate$/);
  assert.equal(requests[2].init.method, "POST");
  assert.equal(requests[3].init.method, "PUT");
  assert.equal(requests[4].init.method, "POST");
  assert.equal(requests[5].init.method, "POST");
});

test("retries values requests on 429 and 5xx, then returns the successful JSON", async () => {
  const statuses = [429, 503, 200];
  const delays = [];
  let calls = 0;
  const client = createSheetsClient({
    accessToken: "synthetic-access-token",
    fetchImpl: async () => {
      const status = statuses[calls++];
      return new Response(JSON.stringify(status === 200 ? { values: [["ok"]] } : { error: "busy" }), { status });
    },
    sleep: async (delay) => delays.push(delay),
    retryBaseMs: 10,
  });

  const result = await client.valuesGet({ spreadsheetId: "synthetic-sheet-id", range: "Worksheet!A1" });

  assert.deepEqual(result, { values: [["ok"]] });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("accepts positional batch ranges without collapsing them into one range", async () => {
  let requestedUrl = "";
  await valuesBatchGet("synthetic-access-token", "synthetic-sheet-id", ["Worksheet!A1", "Worksheet!B2"], {
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response("{}", { status: 200 });
    },
    sleep: async () => {},
  });
  const url = new URL(requestedUrl);
  assert.deepEqual(url.searchParams.getAll("ranges"), ["Worksheet!A1", "Worksheet!B2"]);
});
