import assert from "node:assert/strict";
import test from "node:test";
import mgmModule from "../mgm-check-request.js";

const {
  applyDraft,
  createApplication,
  EDITABLE_FIELDS,
  filterRequests,
  mergeCloudSnapshot,
  parseRequestRows,
  readStoredState,
  stageNewRequest,
  writeStoredState,
} = mgmModule;

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.dataset = {};
    this.listeners = new Map();
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this[name] = value; }
}

function fakeDocument() {
  const ids = ["mgmCheckRequestPage"];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  return {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
    elements,
  };
}

const headers = ["事發日期", "事發時間", "結束時間", "Table", "Serial NO.", "AA Tag", "BOX ID", "Vault ID", "事件詳情", "機台跟進狀況", "實牌跟進狀況", "備注", "欄1"];
const tagRows = [{ serialNo: "259", aaTag: "TAE0248" }, { serialNo: "532", aaTag: "TAE0521" }];

test("parses both MGM request tabs and resolves either missing identifier from the MGM AA map", () => {
  const macau = parseRequestRows({
    sheetName: "MGM Macau",
    rows: [headers, ["2026/6/9", "11:15", "11:24", "21BB02", "259", "", "BOX-1", "VA-1", "Can't read", "", "", ""]],
    aaTags: tagRows,
  });
  const cotai = parseRequestRows({
    sheetName: "MGM Cotai",
    rows: [headers, ["2026/6/29", "0:01", "0:05", "112BB01", "", "TAE0521", "BOX-2", "", "Double draw", "未CHECK", "未CHECK", ""]],
    aaTags: tagRows,
  });
  assert.equal(macau[0].serialNo, "259");
  assert.equal(macau[0].aaTag, "TAE0248");
  assert.equal(macau[0].aaTagResolved, true);
  assert.equal(cotai[0].serialNo, "532");
  assert.equal(cotai[0].serialResolved, true);
  assert.equal(macau[0].status, "pending");
  assert.equal(cotai[0].status, "pending");
  assert.equal(macau[0].id, "MGM Macau:2");
});

test("searches SN and AA Tag exactly while allowing Table and BOX text lookup", () => {
  const requests = parseRequestRows({
    sheetName: "MGM Macau",
    rows: [headers,
      ["2026/6/9", "11:15", "", "21BB02", "259", "TAE0248", "BOX-ONE", "", "One", "", "", ""],
      ["2026/6/10", "12:00", "", "31BB05", "379", "TAE0368", "BOX-TWO", "", "Two", "已CHECK", "已CHECK", "OK"],
    ],
  });
  assert.deepEqual(filterRequests(requests, { query: "259", status: "all", site: "all" }).map((row) => row.serialNo), ["259"]);
  assert.deepEqual(filterRequests(requests, { query: "TAE0368", status: "all", site: "all" }).map((row) => row.serialNo), ["379"]);
  assert.deepEqual(filterRequests(requests, { query: "31BB", status: "all", site: "all" }).map((row) => row.serialNo), ["379"]);
  assert.equal(filterRequests(requests, { query: "25", status: "all", site: "all" }).length, 0);
  assert.equal(filterRequests(requests, { query: "", status: "done", site: "all" }).length, 1);
});

test("stores one merged offline mutation and keeps it over a refreshed cloud snapshot", () => {
  const request = parseRequestRows({
    sheetName: "MGM Macau",
    rows: [headers, ["2026/6/9", "11:15", "", "21BB02", "259", "", "BOX-1", "", "Issue", "", "", ""]],
    aaTags: tagRows,
  })[0];
  const first = applyDraft({ requests: [request], cloudRequests: [request], outbox: [] }, request.id, {
    serialNo: "259", aaTag: "TAE0248", machineStatus: "已CHECK", cardStatus: "未CHECK", remark: "待覆核",
  }, 1000);
  const second = applyDraft(first, request.id, { cardStatus: "已CHECK", remark: "完成" }, 2000);
  assert.equal(second.outbox.length, 1);
  assert.deepEqual(second.outbox[0].patch, { aaTag: "TAE0248", machineStatus: "已CHECK", cardStatus: "已CHECK", remark: "完成" });
  const refreshed = mergeCloudSnapshot(second, { requests: [request], aaTags: tagRows }, 3000);
  assert.equal(refreshed.requests[0].machineStatus, "已CHECK");
  assert.equal(refreshed.requests[0].cardStatus, "已CHECK");
  assert.equal(refreshed.outbox.length, 1);
});

test("stages a new customer request offline and links SN with AA Tag", () => {
  const staged = stageNewRequest({ aaTags: tagRows }, {
    sheetName: "MGM Macau",
    eventDate: "2026-09-07",
    eventTime: "10:20",
    table: "21BB02",
    serialNo: "259",
    eventDetails: "客戶要求檢查",
  }, 4000);
  assert.equal(staged.requests.length, 1);
  assert.equal(staged.requests[0].aaTag, "TAE0248");
  assert.equal(staged.requests[0].status, "pending");
  assert.deepEqual(staged.outbox[0], {
    kind: "create",
    mutationId: staged.outbox[0].mutationId,
    requestId: staged.requests[0].id,
    sheetName: "MGM Macau",
    row: {
      eventDate: "2026-09-07",
      eventTime: "10:20",
      endTime: "",
      table: "21BB02",
      serialNo: "259",
      aaTag: "TAE0248",
      boxId: "",
      vaultId: "",
      eventDetails: "客戶要求檢查",
      machineStatus: "",
      cardStatus: "",
      remark: "",
    },
    updatedAt: 4000,
  });
});

test("first mount downloads automatically only when no local request list exists", async () => {
  const calls = [];
  const transport = { get: async (query) => { calls.push(query); return { success: true, requests: [], aaTags: [] }; }, post: async () => ({ success: true }) };
  const storage = new MemoryStorage();
  createApplication({ document: fakeDocument(), storage, transport, isOnline: () => true }).mount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /action=mgmCheckRequests/);

  const localRequest = parseRequestRows({ sheetName: "MGM Macau", rows: [headers, ["2026/6/9", "11:15", "", "21BB02", "259", "TAE0248", "BOX-1", "", "Issue", "", "", ""]] })[0];
  const cached = new MemoryStorage();
  writeStoredState(cached, { requests: [localRequest], cloudRequests: [localRequest], outbox: [] });
  createApplication({ document: fakeDocument(), storage: cached, transport: { get: async () => { throw new Error("must not auto download"); } }, isOnline: () => true }).mount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(readStoredState(cached).requests.length, 1);
});

test("renders the operational search, cloud actions and editable E-H J-L fields", () => {
  const document = fakeDocument();
  createApplication({ document, storage: new MemoryStorage(), transport: null, isOnline: () => false }).mount();
  const html = document.getElementById("mgmCheckRequestPage").innerHTML;
  assert.match(html, /MGM Check Request/);
  assert.match(html, /輸入 SN、AA Tag、Table 或 BOX ID/);
  assert.match(html, /下載雲端資料/);
  assert.match(html, /同步至雲端/);
  assert.match(html, /新增檢查請求/);
  assert.deepEqual(EDITABLE_FIELDS, ["serialNo", "aaTag", "boxId", "vaultId", "machineStatus", "cardStatus", "remark"]);
});
