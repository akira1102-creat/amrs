import assert from "node:assert/strict";
import test from "node:test";
import galaxyModule from "../galaxy-log.js";

const {
  buildTaskId,
  completeTask,
  createMutationOutbox,
  createApplication,
  filterTasks,
  formatLocalDateTime,
  mergeCloudTasks,
  mergeImportedTasks,
  parseGalaxyColumnGroups,
  parseGalaxyRows,
  pendingMutations,
  readStoredState,
  tasksToColumnGroups,
  writeStoredState,
} = galaxyModule;

class MemoryStorage {
  #values = new Map();

  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.files = [];
    this.dataset = {};
    this.listeners = new Map();
  }

  addEventListener(type, listener) { this.listeners.set(type, listener); }
  click() { this.clicked = true; }
}

function fakeGalaxyDocument() {
  const ids = ["galaxyLogPage", "galaxySyncBtn", "galaxyImportBtn", "galaxyExportXlsxBtn", "galaxyLogSearch", "galaxyLogStatusFilter", "galaxyLogClearBtn", "galaxyLogSummary", "galaxyLogOfflineBadge", "galaxyLogStatus", "galaxyLogIssues", "galaxyLogList"];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  return {
    getElementById(id) { return elements.get(id) || null; },
    elements,
  };
}

test("parses the print layout while carrying merged serial numbers down", () => {
  const result = parseGalaxyRows({
    sheetName: "Print_Layout (2)",
    rows: [
      ["A02-001190", 46159],
      [null, 46158],
      ["A02-001193", "2026/6/2"],
      [null, "2026/6/2"],
    ],
  });

  assert.equal(result.issues.length, 0);
  assert.equal(result.tasks.length, 4);
  assert.deepEqual(result.tasks.slice(0, 2).map((task) => [task.fullSerial, task.serialLast4, task.targetDate]), [
    ["A02-001190", "1190", "2026-05-17"],
    ["A02-001190", "1190", "2026-05-16"],
  ]);
  assert.equal(result.tasks[2].fullSerial, "A02-001193");
});

test("parses the source layout and maps completed dates without adding an operator field", () => {
  const result = parseGalaxyRows({
    sheetName: "P.Mass& JM (2)",
    rows: [
      ["Occurred", "Serial number", "Completed Date"],
      ["2026-05-09", "A02-001113", "2026-07-31"],
      ["2026-05-06", null, "2026-07-31"],
      ["2026-06-12", "A02-001115", null],
    ],
  });

  assert.equal(result.tasks.length, 3);
  assert.deepEqual(result.tasks.map((task) => task.status), ["done", "done", "pending"]);
  assert.equal(result.tasks[0].completedDate, "2026-07-31");
  assert.equal(Object.hasOwn(result.tasks[0], "completedBy"), false);
});

test("re-imports the standardized Galaxy export with spaced Log headers", () => {
  const result = parseGalaxyRows({
    sheetName: "Galaxy Log",
    rows: [
      ["SN", "SN末4位", "指定 Log 日期", "取 Log 日期", "狀態", "備註"],
      ["A02-001190", "1190", "2026-05-17", "2026-08-31", "已取", ""],
      ["A02-001193", "1193", "2026-06-02", "", "未取", ""],
      ["A02-001115", "1115", "2026-06-12", "", "需跟進", "formating, Can't log collection"],
    ],
  });

  assert.equal(result.kind, "source");
  assert.equal(result.tasks.length, 3);
  assert.equal(result.tasks[0].status, "done");
  assert.equal(result.tasks[0].completedDate, "2026-08-31");
  assert.equal(result.tasks[1].status, "pending");
  assert.equal(result.tasks[2].status, "needs_review");
  assert.equal(result.tasks[2].note, "formating, Can't log collection");
});

test("keeps duplicate source rows as separate tasks and merges re-imports by stable task id", () => {
  const imported = parseGalaxyRows({
    sheetName: "Print_Layout (2)",
    rows: [
      ["A02-001193", "2026-06-02"],
      [null, "2026-06-02"],
    ],
  }).tasks;
  const first = mergeImportedTasks([], imported, { importedAt: "2026-08-31T00:00:00.000Z" });
  assert.equal(first.tasks.length, 2);
  assert.notEqual(first.tasks[0].id, first.tasks[1].id);
  const completed = completeTask(first.tasks, first.tasks[0].id, "2026-08-31");
  const second = mergeImportedTasks(completed, imported, { importedAt: "2026-09-01T00:00:00.000Z" });
  assert.equal(second.tasks.length, 2);
  assert.equal(second.tasks[0].status, "done");
  assert.equal(second.tasks[0].completedDate, "2026-08-31");
});

test("filters by last four digits and status while retaining exact full serial identity", () => {
  const tasks = [
    { id: buildTaskId("A02-001190", "2026-05-17", 0), fullSerial: "A02-001190", serialLast4: "1190", targetDate: "2026-05-17", status: "pending" },
    { id: buildTaskId("A02-002190", "2026-05-18", 0), fullSerial: "A02-002190", serialLast4: "2190", targetDate: "2026-05-18", status: "done" },
  ];
  assert.equal(filterTasks(tasks, { query: "1190", status: "pending" }).length, 1);
  assert.equal(filterTasks(tasks, { query: "A02-002190", status: "all" })[0].fullSerial, "A02-002190");
});

test("stored state round-trips through the isolated Galaxy storage key", () => {
  const storage = new MemoryStorage();
  const state = { tasks: [{ id: "gx-1", fullSerial: "A02-001190", targetDate: "2026-05-17", status: "pending" }], issues: [], importedAt: "2026-08-31T00:00:00.000Z" };
  writeStoredState(storage, state);
  const restored = readStoredState(storage);
  assert.equal(restored.tasks[0].id, "gx-1");
  assert.equal(restored.tasks[0].fullSerial, "A02-001190");
  assert.equal(restored.tasks[0].serialLast4, "1190");
  assert.equal(restored.importedAt, state.importedAt);
});

test("formats imported timestamps as a local date and time", () => {
  assert.match(formatLocalDateTime("2026-08-31T15:57:00.000Z"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatLocalDateTime("not-a-date"), "");
});

test("does not carry a previous serial into a source row with an error note and no serial", () => {
  const result = parseGalaxyRows({
    sheetName: "P.Mass& JM (2)",
    rows: [
      ["Occurred", "Serial number", "Completed Date"],
      ["2026-05-12", "A02-001999", null],
      ["2026-05-13", null, "Insufficient data"],
    ],
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].fullSerial, "A02-001999");
  assert.equal(result.issues.some((issue) => issue.type === "missing-serial"), true);
});

test("parses repeated three-column Galaxy Log groups and keeps group identity", () => {
  const result = parseGalaxyColumnGroups({
    rows: [
      ["SN末4位", "指定 Log 日期", "取 Log 日期", "SN末4位", "指定 Log 日期", "取 Log 日期"],
      ["1190", "2026/09/01", "", "1190", "2026/09/01", "2026/09/02"],
      ["1191", "2026/09/05", "", "", "", ""],
    ],
  });

  assert.equal(result.issues.length, 0);
  assert.equal(result.tasks.length, 3);
  assert.deepEqual(result.tasks.map((task) => [task.serialLast4, task.targetDate, task.completedDate, task.groupIndex]), [
    ["1190", "2026-09-01", "", 0],
    ["1191", "2026-09-05", "", 0],
    ["1190", "2026-09-01", "2026-09-02", 1],
  ]);
  assert.notEqual(result.tasks[0].id, result.tasks[2].id);
});

test("serializes Galaxy tasks back into repeated three-column groups", () => {
  const tasks = [
    { id: "gx-a", serialLast4: "1190", targetDate: "2026-09-01", completedDate: "", groupIndex: 0, rowIndex: 2 },
    { id: "gx-b", serialLast4: "1191", targetDate: "2026-09-05", completedDate: "2026-09-06", groupIndex: 0, rowIndex: 3 },
    { id: "gx-c", serialLast4: "1190", targetDate: "2026-09-01", completedDate: "2026-09-02", groupIndex: 1, rowIndex: 2 },
  ];

  assert.deepEqual(tasksToColumnGroups(tasks), [
    ["SN末4位", "指定 Log 日期", "取 Log 日期", "SN末4位", "指定 Log 日期", "取 Log 日期"],
    ["1190", "2026-09-01", "", "1190", "2026-09-01", "2026-09-02"],
    ["1191", "2026-09-05", "2026-09-06", "", "", ""],
  ]);
});

test("queues one idempotent local mutation and exposes only pending mutations", () => {
  const base = { tasks: [], outbox: [] };
  const mutation = { taskId: "gx-a", patch: { completedDate: "2026-09-02", status: "done" } };
  const once = createMutationOutbox(base, mutation);
  const twice = createMutationOutbox(once, mutation);

  assert.equal(once.outbox.length, 1);
  assert.equal(twice.outbox.length, 1);
  assert.equal(pendingMutations(twice)[0].taskId, "gx-a");
});

test("keeps the original cloud base when a local mutation is changed before sync", () => {
  const first = createMutationOutbox({ tasks: [], outbox: [] }, {
    taskId: "gx-a",
    patch: { completedDate: "2026-09-02", status: "done" },
    baseCompletedDate: "",
  });
  const changed = createMutationOutbox(first, {
    taskId: "gx-a",
    patch: { completedDate: "", status: "pending" },
    baseCompletedDate: "2026-09-02",
  });

  assert.equal(changed.outbox.length, 1);
  assert.equal(changed.outbox[0].baseCompletedDate, "");
});

test("merges cloud completion while preserving local pending changes and flags conflicts", () => {
  const local = [{ id: "gx-a", serialLast4: "1190", targetDate: "2026-09-01", completedDate: "", status: "pending" }];
  const cloud = [{ id: "gx-a", serialLast4: "1190", targetDate: "2026-09-01", completedDate: "2026-09-02", status: "done" }];
  const retained = mergeCloudTasks(local, cloud, []);
  assert.equal(retained.tasks[0].completedDate, "2026-09-02");
  assert.equal(retained.tasks[0].status, "done");

  const conflict = mergeCloudTasks(local, [{ ...cloud[0], completedDate: "2026-09-03" }], [
    { mutationId: "m-1", taskId: "gx-a", patch: { completedDate: "2026-09-02", status: "done" } },
  ]);
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.tasks[0].completedDate, "2026-09-02");
});

test("merges pre-cloud local ids into the matching repeated-column task", () => {
  const merged = mergeCloudTasks([
    { id: "old-print-id", fullSerial: "1190", serialLast4: "1190", targetDate: "2026-09-01", completedDate: "", status: "pending", groupIndex: 0, rowIndex: 2 },
  ], [
    { id: "new-column-id", fullSerial: "1190", serialLast4: "1190", targetDate: "2026-09-01", completedDate: "", status: "pending", groupIndex: 0, rowIndex: 2 },
  ], [
    { mutationId: "m-old", taskId: "old-print-id", patch: { completedDate: "2026-09-03", status: "done" }, baseCompletedDate: "" },
  ]);

  assert.equal(merged.tasks.length, 1);
  assert.equal(merged.tasks[0].id, "new-column-id");
  assert.equal(merged.tasks[0].completedDate, "2026-09-03");
  assert.deepEqual(merged.idRemaps, [{ from: "old-print-id", to: "new-column-id" }]);
});

test("uploads Excel or CSV import mutations through cloud sync when online", async () => {
  const documentRef = fakeGalaxyDocument();
  const calls = [];
  const transport = {
    get: async () => ({ success: true, tasks: [], issues: [] }),
    post: async (payload) => {
      calls.push(payload);
      return {
        success: true,
        results: payload.mutations.map((mutation) => ({ mutationId: mutation.mutationId, taskId: mutation.taskId, status: "applied" })),
        tasks: [],
        issues: [],
      };
    },
  };
  const app = createApplication({ document: documentRef, storage: new MemoryStorage(), transport });
  app.mount();
  await new Promise((resolve) => setTimeout(resolve, 0));

  await app.importFile({
    name: "Galaxy.csv",
    text: async () => "SN末4位,指定 Log 日期,取 Log 日期\r\n1190,2026/09/01,\r\n",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "syncGalaxyLog");
  assert.equal(calls[0].mutations.length, 1);
  assert.equal(app.getState().outbox.length, 0);

  const previousXlsx = globalThis.XLSX;
  globalThis.XLSX = {
    read: () => ({ SheetNames: ["Galaxy"], Sheets: { Galaxy: {} } }),
    utils: {
      sheet_to_json: () => [
        ["SN末4位", "指定 Log 日期", "取 Log 日期"],
        ["1191", "2026/09/02", ""],
      ],
    },
  };
  try {
    await app.importFile({ name: "Galaxy.xlsx", arrayBuffer: async () => new ArrayBuffer(0) });
  } finally {
    if (previousXlsx === undefined) delete globalThis.XLSX;
    else globalThis.XLSX = previousXlsx;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[1].action, "syncGalaxyLog");
  assert.equal(calls[1].mutations.length, 1);
  assert.equal(app.getState().outbox.length, 0);
});

test("loads the Google Sheet from the cloud import button", async () => {
  const documentRef = fakeGalaxyDocument();
  const getCalls = [];
  const transport = {
    get: async (query) => {
      getCalls.push(query);
      return {
        success: true,
        tasks: [{ id: "cloud-1", fullSerial: "1190", serialLast4: "1190", targetDate: "2026-09-01", completedDate: "", status: "pending" }],
        issues: [],
      };
    },
    post: async () => ({ success: true, results: [], tasks: [], issues: [] }),
  };
  const app = createApplication({ document: documentRef, storage: new MemoryStorage(), transport });
  app.mount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  getCalls.length = 0;

  const importButton = documentRef.elements.get("galaxyImportBtn");
  assert.equal(importButton.disabled, false);
  importButton.listeners.get("click")();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(getCalls, ["action=galaxyLogOverview&refresh=1"]);
  assert.equal(app.getState().tasks[0].id, "cloud-1");
  assert.equal(documentRef.elements.get("galaxyLogStatus").textContent, "✓ 已載入雲端清單（1 筆）");
});

test("shows that an Office workbook is read-only instead of hiding the cloud source problem", async () => {
  const documentRef = fakeGalaxyDocument();
  const transport = {
    get: async () => ({
      success: true,
      readOnly: true,
      tasks: [{ id: "office-1", fullSerial: "1190", serialLast4: "1190", targetDate: "2026-09-01", completedDate: "", status: "pending" }],
      issues: [],
    }),
    post: async () => ({ success: true, results: [], tasks: [], issues: [] }),
  };
  const app = createApplication({ document: documentRef, storage: new MemoryStorage(), transport });
  app.mount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  documentRef.elements.get("galaxyImportBtn").listeners.get("click")();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(app.getState().cloudReadOnly, true);
  assert.equal(documentRef.elements.get("galaxyLogOfflineBadge").textContent, "雲端只讀");
  assert.match(documentRef.elements.get("galaxyLogStatus").textContent, /只能讀取/);
});

test("surfaces the native Google Sheet requirement when a cloud sync is rejected", async () => {
  const documentRef = fakeGalaxyDocument();
  const transport = {
    get: async () => ({
      success: true,
      readOnly: true,
      tasks: [{ id: "office-2", fullSerial: "1191", serialLast4: "1191", targetDate: "2026-09-02", completedDate: "", status: "pending" }],
      issues: [],
    }),
    post: async () => { throw Object.assign(new Error("Galaxy Log 來源仍是 Excel，請先另存為原生 Google 試算表後再同步"), { httpStatus: 409 }); },
  };
  const app = createApplication({ document: documentRef, storage: new MemoryStorage(), transport });
  app.mount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  documentRef.elements.get("galaxyImportBtn").listeners.get("click")();
  await new Promise((resolve) => setTimeout(resolve, 0));
  documentRef.elements.get("galaxyLogList").listeners.get("click")({
    target: { closest: () => ({ dataset: { galaxyAction: "complete", galaxyId: "office-2" } }) },
  });
  await app.syncCloud();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(documentRef.elements.get("galaxyLogStatus").textContent, /原生 Google 試算表/);
});
