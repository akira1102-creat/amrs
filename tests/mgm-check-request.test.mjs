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

function followupToggleTarget(requestId, field, choice) {
  const card = { dataset: { mgmCheckId: requestId } };
  const button = {
    dataset: { mgmCheckFollowupField: field, mgmCheckFollowupValue: choice },
    closest(selector) {
      if (selector === "button[data-mgm-check-followup-field]") return button;
      if (selector === "[data-mgm-check-id]") return card;
      return null;
    },
  };
  return button;
}

function pendingActionTarget(action, requestId) {
  const button = {
    dataset: { mgmCheckPendingAction: action, mgmCheckPendingId: requestId },
    closest(selector) {
      if (selector === "button[data-mgm-check-pending-action]") return button;
      return null;
    },
  };
  return button;
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

test("orders MGM Check Request results from the latest event date and time to the oldest", () => {
  const requests = parseRequestRows({
    sheetName: "MGM Macau",
    rows: [headers,
      ["2026/06/09", "11:15", "", "21BB02", "100", "TAE0100", "BOX-1", "", "Oldest", "", "", ""],
      ["2026-06-10", "08:00", "", "21BB03", "200", "TAE0200", "BOX-2", "", "Morning", "", "", ""],
      ["2026/6/10", "13:30", "", "21BB04", "300", "TAE0300", "BOX-3", "", "Latest", "", "", ""],
    ],
  });

  assert.deepEqual(
    filterRequests(requests, { query: "", status: "all", site: "all" }).map((row) => row.serialNo),
    ["300", "200", "100"],
  );
});

test("filters MGM requests by overall, machine and card inspection completion", () => {
  const requests = parseRequestRows({
    sheetName: "MGM Macau",
    rows: [headers,
      ["2026/06/10", "08:00", "", "21BB01", "100", "TAE0100", "BOX-1", "", "Both pending", "", "", ""],
      ["2026/06/10", "09:00", "", "21BB02", "200", "TAE0200", "BOX-2", "", "Machine checked", "已CHECK", "", ""],
      ["2026/06/10", "10:00", "", "21BB03", "300", "TAE0300", "BOX-3", "", "Card checked", "", "已檢查", ""],
      ["2026/06/10", "11:00", "", "21BB04", "400", "TAE0400", "BOX-4", "", "Both checked", "已CHECK", "已檢查", ""],
    ],
  });
  const serials = (status) => filterRequests(requests, { query: "", status, site: "all" }).map((row) => row.serialNo);

  assert.deepEqual(serials("pending"), ["300", "200", "100"]);
  assert.deepEqual(serials("done"), ["400"]);
  assert.deepEqual(serials("machine-pending"), ["300", "100"]);
  assert.deepEqual(serials("machine-done"), ["400", "200"]);
  assert.deepEqual(serials("card-pending"), ["200", "100"]);
  assert.deepEqual(serials("card-done"), ["400", "300"]);
});

test("treats machine-without-data and broken-card choices as completed checks", () => {
  const requests = parseRequestRows({
    sheetName: "MGM Macau",
    rows: [headers,
      ["2026/06/10", "08:00", "", "21BB01", "100", "TAE0100", "BOX-1", "", "No machine data", "無機台資料", "已CHECK", ""],
      ["2026/06/10", "09:00", "", "21BB02", "200", "TAE0200", "BOX-2", "", "Broken card", "已CHECK", "已碎牌", ""],
      ["2026/06/10", "10:00", "", "21BB03", "300", "TAE0300", "BOX-3", "", "Both alternate outcomes", "無機台資料", "已碎牌", ""],
    ],
  });
  const serials = (status) => filterRequests(requests, { query: "", status, site: "all" }).map((row) => row.serialNo);

  assert.deepEqual(serials("done"), ["300", "200", "100"]);
  assert.deepEqual(serials("machine-done"), ["300", "200", "100"]);
  assert.deepEqual(serials("card-done"), ["300", "200", "100"]);
  assert.deepEqual(serials("machine-pending"), []);
  assert.deepEqual(serials("card-pending"), []);
});

test("defaults MGM Check Request to show every completion status", () => {
  const requests = parseRequestRows({
    sheetName: "MGM Macau",
    rows: [headers,
      ["2026/06/10", "08:00", "", "21BB01", "100", "TAE0100", "BOX-1", "", "Still pending", "", "", ""],
      ["2026/06/10", "09:00", "", "21BB02", "200", "TAE0200", "BOX-2", "", "Already checked", "已CHECK", "已CHECK", ""],
    ],
  });
  const document = fakeDocument();
  const storage = new MemoryStorage();
  writeStoredState(storage, { requests, cloudRequests: requests, outbox: [] });

  createApplication({ document, storage, transport: null, isOnline: () => false }).mount();

  assert.equal(document.getElementById("mgmCheckStatusFilter").value, "all");
  assert.match(document.getElementById("mgmCheckList").innerHTML, /Still pending/);
  assert.match(document.getElementById("mgmCheckList").innerHTML, /Already checked/);
});

test("renders card follow-up controls with the stored choice highlighted", () => {
  const requests = parseRequestRows({
    sheetName: "MGM Macau",
    rows: [headers,
      ["2026/06/10", "08:00", "", "21BB02", "100", "TAE0100", "BOX-1", "", "Waiting", "", "", ""],
      ["2026/06/10", "09:00", "", "21BB03", "200", "TAE0200", "BOX-2", "", "Checked", "已CHECK", "已檢查", ""],
    ],
  });
  const document = fakeDocument();
  const storage = new MemoryStorage();
  writeStoredState(storage, { requests, cloudRequests: requests, outbox: [] });
  const app = createApplication({ document, storage, transport: null, isOnline: () => false });

  app.mount();
  app.setFilter({ status: "all" });

  const html = document.getElementById("mgmCheckList").innerHTML;
  assert.equal((html.match(/data-mgm-check-followup-field=/g) || []).length, 12);
  assert.match(html, /機台檢查狀況/);
  assert.match(html, /實牌檢查狀況/);
  assert.match(html, /data-mgm-check-followup-field="machineStatus" data-mgm-check-followup-value="pending"[^>]*aria-pressed="true"/);
  assert.match(html, /data-mgm-check-followup-field="cardStatus" data-mgm-check-followup-value="done"[^>]*aria-pressed="true"/);
  assert.match(html, /data-mgm-check-followup-field="machineStatus" data-mgm-check-followup-value="no-machine-data"/);
  assert.match(html, /data-mgm-check-followup-field="cardStatus" data-mgm-check-followup-value="broken-card"/);
  assert.match(html, /data-mgm-check-followup-field="machineStatus" data-mgm-check-followup-value="no-machine-data"[^>]*>無機台<\/button>/);
  assert.doesNotMatch(html, /data-mgm-check-followup-field="machineStatus" data-mgm-check-followup-value="no-machine-data"[^>]*>無機台資料<\/button>/);
  assert.match(html, /data-mgm-check-followup-field="machineStatus" data-mgm-check-followup-value="pending"[^>]*>待跟進<\/button><button[^>]*data-mgm-check-followup-field="machineStatus" data-mgm-check-followup-value="no-machine-data"[^>]*>無機台<\/button><button[^>]*data-mgm-check-followup-field="machineStatus" data-mgm-check-followup-value="done"[^>]*>已檢查<\/button>/);
  assert.equal((html.match(/class="mgm-check-state done">已完成/g) || []).length, 1);
  assert.doesNotMatch(html, /待檢查/);
});

test("tapping a card follow-up choice updates only that check and queues it for storage", () => {
  const request = parseRequestRows({
    sheetName: "MGM Macau",
    rows: [headers, ["2026/06/10", "08:00", "", "21BB02", "100", "TAE0100", "BOX-1", "", "Waiting", "未CHECK", "未CHECK", ""]],
  })[0];
  const document = fakeDocument();
  const storage = new MemoryStorage();
  writeStoredState(storage, { requests: [request], cloudRequests: [request], outbox: [] });
  const app = createApplication({ document, storage, transport: null, isOnline: () => false });
  app.mount();
  const click = document.getElementById("mgmCheckList").listeners.get("click");

  click({ target: followupToggleTarget(request.id, "machineStatus", "done") });
  assert.equal(app.getState().requests[0].machineStatus, "已CHECK");
  assert.equal(app.getState().requests[0].cardStatus, "未CHECK");
  assert.equal(app.getState().requests[0].status, "pending");
  assert.deepEqual(app.getState().outbox[0].patch, { machineStatus: "已CHECK" });

  click({ target: followupToggleTarget(request.id, "cardStatus", "done") });
  assert.equal(app.getState().requests[0].cardStatus, "已CHECK");
  assert.equal(app.getState().requests[0].status, "done");
  assert.deepEqual(app.getState().outbox[0].patch, { machineStatus: "已CHECK", cardStatus: "已CHECK" });
});

test("tapping alternate machine and card outcomes stores their exact status values", () => {
  const request = parseRequestRows({
    sheetName: "MGM Macau",
    rows: [headers, ["2026/06/10", "08:00", "", "21BB02", "100", "TAE0100", "BOX-1", "", "Waiting", "未CHECK", "未CHECK", ""]],
  })[0];
  const document = fakeDocument();
  const storage = new MemoryStorage();
  writeStoredState(storage, { requests: [request], cloudRequests: [request], outbox: [] });
  const app = createApplication({ document, storage, transport: null, isOnline: () => false });
  app.mount();
  const click = document.getElementById("mgmCheckList").listeners.get("click");

  click({ target: followupToggleTarget(request.id, "machineStatus", "no-machine-data") });
  assert.equal(app.getState().requests[0].machineStatus, "無機台資料");
  assert.equal(app.getState().requests[0].status, "pending");
  assert.deepEqual(app.getState().outbox[0].patch, { machineStatus: "無機台資料" });

  click({ target: followupToggleTarget(request.id, "cardStatus", "broken-card") });
  assert.equal(app.getState().requests[0].cardStatus, "已碎牌");
  assert.equal(app.getState().requests[0].status, "done");
  assert.deepEqual(app.getState().outbox[0].patch, { machineStatus: "無機台資料", cardStatus: "已碎牌" });
});

test("lists a pending MGM change above the cards and lets the user discard it back to the cloud value", () => {
  const request = parseRequestRows({
    sheetName: "MGM Macau",
    rows: [headers, ["2026/09/10", "08:00", "", "21BB02", "1190", "TAE1190", "BOX-1", "", "Waiting", "未CHECK", "未CHECK", ""]],
  })[0];
  const changed = applyDraft({ requests: [request], cloudRequests: [request], outbox: [] }, request.id, { machineStatus: "已CHECK" }, 9000);
  const document = fakeDocument();
  const storage = new MemoryStorage();
  writeStoredState(storage, changed);
  const app = createApplication({ document, storage, transport: null, isOnline: () => false });

  app.mount();

  const badge = document.getElementById("mgmCheckPendingBadge");
  const panel = document.getElementById("mgmCheckPendingPanel");
  assert.equal(badge.textContent, "待儲存變更（1）");
  assert.equal(panel.hidden, false);
  assert.match(panel.innerHTML, /1190/);
  assert.match(panel.innerHTML, /機台檢查狀況：已檢查/);
  assert.match(panel.innerHTML, /刪除此變更/);

  panel.listeners.get("click")({ target: pendingActionTarget("delete-one", request.id) });
  assert.equal(app.getState().outbox.length, 0);
  assert.equal(app.getState().requests[0].machineStatus, "未CHECK");
  assert.equal(app.getState().requests[0].cardStatus, "未CHECK");
});

test("discarding a pending new MGM request removes the local-only row", () => {
  const staged = stageNewRequest({}, {
    sheetName: "MGM Cotai",
    eventDate: "2026-09-10",
    eventTime: "09:30",
    table: "112BB01",
    serialNo: "1193",
    eventDetails: "新增後需要刪除",
  }, 9100);
  const document = fakeDocument();
  const storage = new MemoryStorage();
  writeStoredState(storage, staged);
  const app = createApplication({ document, storage, transport: null, isOnline: () => false });

  app.mount();

  const panel = document.getElementById("mgmCheckPendingPanel");
  assert.match(panel.innerHTML, /新增客戶檢查請求/);
  panel.listeners.get("click")({ target: pendingActionTarget("delete-one", staged.requests[0].id) });
  assert.equal(app.getState().outbox.length, 0);
  assert.equal(app.getState().requests.length, 0);
});

test("renders MGM event date and time prominently before Table, BOX ID and Vault ID", () => {
  const requests = parseRequestRows({
    sheetName: "MGM Cotai",
    rows: [headers,
      ["2026/06/11", "08:30", "09:10", "21BB02", "100", "TAE0100", "BOX-1", "VA-1", "Check", "", "", ""],
    ],
  });
  const document = fakeDocument();
  const storage = new MemoryStorage();
  writeStoredState(storage, { requests, cloudRequests: requests, outbox: [] });

  createApplication({ document, storage, transport: null, isOnline: () => false }).mount();

  const html = document.getElementById("mgmCheckList").innerHTML;
  assert.match(html, /<div class="mgm-check-datetime"><span>事發日期及時間<\/span><strong>2026\/06\/11 08:30<\/strong><small>結束 09:10<\/small><\/div>/);
  assert.match(html, /<div class="mgm-check-location"><span>Table 21BB02<\/span><span>BOX ID BOX-1<\/span><span>Vault ID VA-1<\/span><\/div>/);
  assert.ok(html.indexOf("mgm-check-datetime") < html.indexOf("mgm-check-location"));
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

test("every page mount downloads the latest cloud request list even when local data exists", async () => {
  const calls = [];
  const transport = { get: async (query) => { calls.push(query); return { success: true, requests: [], aaTags: [] }; }, post: async () => ({ success: true }) };
  const storage = new MemoryStorage();
  const app = createApplication({ document: fakeDocument(), storage, transport, isOnline: () => true });
  app.mount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /action=mgmCheckRequests/);

  const localRequest = parseRequestRows({ sheetName: "MGM Macau", rows: [headers, ["2026/6/9", "11:15", "", "21BB02", "259", "TAE0248", "BOX-1", "", "Issue", "", "", ""]] })[0];
  const cached = new MemoryStorage();
  writeStoredState(cached, { requests: [localRequest], cloudRequests: [localRequest], outbox: [] });
  const cachedCalls = [];
  const cachedApp = createApplication({
    document: fakeDocument(),
    storage: cached,
    transport: { get: async (query) => { cachedCalls.push(query); return { success: true, requests: [localRequest], aaTags: [] }; }, post: async () => ({ success: true }) },
    isOnline: () => true,
  });
  cachedApp.mount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  cachedApp.mount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cachedCalls.length, 2);
  assert.equal(readStoredState(cached).requests.length, 1);
});

test("renders the operational search, cloud actions and editable E-H J-L fields", () => {
  const document = fakeDocument();
  createApplication({ document, storage: new MemoryStorage(), transport: null, isOnline: () => false }).mount();
  const html = document.getElementById("mgmCheckRequestPage").innerHTML;
  assert.match(html, /MGM Check Request/);
  assert.match(html, /輸入 SN、AA Tag、Table 或 BOX ID/);
  assert.match(html, /重新載入/);
  assert.match(html, /儲存資料/);
  assert.doesNotMatch(html, /同步至雲端/);
  assert.match(html, /直接讀取及儲存最新雲端資料/);
  assert.match(html, /新增檢查請求/);
  assert.match(html, /<option value="all">場地篩選<\/option>/);
  assert.match(html, /<option value="all">全部<\/option>/);
  assert.match(html, /<option value="machine-pending">機台未完成<\/option>/);
  assert.match(html, /<option value="machine-done">機台已完成<\/option>/);
  assert.match(html, /<option value="card-pending">實牌未完成<\/option>/);
  assert.match(html, /<option value="card-done">實牌已完成<\/option>/);
  assert.deepEqual(EDITABLE_FIELDS, ["serialNo", "aaTag", "boxId", "vaultId", "machineStatus", "cardStatus", "remark"]);
});
