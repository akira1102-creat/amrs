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
  mergeImportedSnapshot,
  mergeImportedTasks,
  parseGalaxyColumnGroups,
  parseGalaxyRows,
  parseWorkbookFile,
  pendingMutations,
  reconcileImportedTasks,
  readStoredState,
  tasksToCsv,
  tasksToColumnGroups,
  tasksToRows,
  writeStoredState,
} = galaxyModule;

test("reconciles offline CSV rows against cloud tasks instead of treating regenerated IDs as changes", () => {
  const cloudTasks = [
    { id: "cloud-1190-17", fullSerial: "A02-001190", serialLast4: "1190", targetDate: "2026-05-17", completedDate: "", status: "pending", groupIndex: 0, rowIndex: 2, duplicateIndex: 0 },
    { id: "cloud-1190-16", fullSerial: "A02-001190", serialLast4: "1190", targetDate: "2026-05-16", completedDate: "", status: "pending", groupIndex: 0, rowIndex: 3, duplicateIndex: 0 },
    { id: "cloud-1193-02", fullSerial: "A02-001193", serialLast4: "1193", targetDate: "2026-06-02", completedDate: "", status: "pending", groupIndex: 0, rowIndex: 4, duplicateIndex: 0 },
  ];
  const importedTasks = [
    { id: "offline-1", fullSerial: "A02-001190", serialLast4: "1190", targetDate: "2026-05-17", completedDate: "2026-09-01", status: "done" },
    { id: "offline-2", fullSerial: "A02-001190", serialLast4: "1190", targetDate: "2026-05-16", completedDate: "2026-09-01", status: "done" },
    { id: "offline-3", fullSerial: "A02-001193", serialLast4: "1193", targetDate: "2026-06-02", completedDate: "", status: "pending" },
  ];

  const result = reconcileImportedTasks(importedTasks, cloudTasks);
  assert.deepEqual(result.tasks.map((task) => task.id), ["cloud-1190-17", "cloud-1190-16", "cloud-1193-02"]);
  assert.deepEqual(result.changes.map((change) => [change.taskId, change.patch.completedDate]), [
    ["cloud-1190-17", "2026-09-01"],
    ["cloud-1190-16", "2026-09-01"],
  ]);
  assert.equal(result.added, 0);
  assert.equal(result.updated, 2);
});

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
  const ids = ["galaxyLogPage", "galaxySyncBtn", "galaxyImportBtn", "galaxyCsvImportBtn", "galaxyCsvFileInput", "galaxyExportCsvBtn", "galaxyLogSearch", "galaxyLogStatusFilter", "galaxyLogSummary", "galaxyLogOfflineBadge", "galaxyLogStatus", "galaxyLogIssues", "galaxyPendingPanel", "galaxyLogList"];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  return {
    getElementById(id) { return elements.get(id) || null; },
    elements,
  };
}

test("exports CSV with the complete SN first and last four digits second", () => {
  const tasks = [{ fullSerial: "A02-001190", serialLast4: "1190", targetDate: "2026-05-17", completedDate: "", status: "pending", note: "" }];
  assert.deepEqual(tasksToRows(tasks)[1].slice(0, 2), ["A02-001190", "1190"]);
  assert.deepEqual(tasksToRows(tasks)[0], ["SN", "SN末4位", "指定 Log 日期", "取 Log 日期", "狀態"]);
  assert.equal(tasksToRows(tasks)[1].length, 5);
  assert.match(tasksToCsv(tasks), /A02-001190,1190,2026-05-17/);
  assert.doesNotMatch(tasksToCsv(tasks), /備註/);
});

test("replaces the local Galaxy snapshot only when the imported CSV is newer", () => {
  const oldTask = { id: "old", fullSerial: "A02-001190", serialLast4: "1190", targetDate: "2026-05-17", completedDate: "", status: "pending" };
  const newTask = { id: "new", fullSerial: "A02-001193", serialLast4: "1193", targetDate: "2026-06-02", completedDate: "2026-09-01", status: "done" };
  const state = { tasks: [oldTask], cloudTasks: [oldTask], outbox: [], importedFileModifiedAt: 1000, sourceName: "old.csv" };
  const newer = mergeImportedSnapshot(state, { tasks: [newTask], issues: [], sheetName: "Galaxy Log" }, 2000);
  assert.equal(newer.replaced, true);
  assert.deepEqual(newer.state.tasks.map((task) => task.id), ["new"]);
  assert.equal(newer.state.importedFileModifiedAt, 2000);

  const older = mergeImportedSnapshot(state, { tasks: [newTask], issues: [], sheetName: "Galaxy Log" }, 500);
  assert.equal(older.replaced, false);
  assert.equal(older.reason, "older");
  assert.deepEqual(older.state.tasks.map((task) => task.id), ["old"]);
  const confirmed = mergeImportedSnapshot(state, { tasks: [newTask], issues: [], sheetName: "Galaxy Log" }, 500, { allowOlder: true });
  assert.equal(confirmed.replaced, true);
  assert.deepEqual(confirmed.state.tasks.map((task) => task.id), ["new"]);
});

test("uses the new cloud wording in the Galaxy shell", () => {
  const documentRef = fakeGalaxyDocument();
  const app = createApplication({ document: documentRef, storage: new MemoryStorage(), transport: null });
  app.mount();
  assert.equal(documentRef.elements.get("galaxySyncBtn").textContent, "同步至雲端");
  assert.equal(documentRef.elements.get("galaxyImportBtn").textContent, "下載雲端資料");
});

test("does not download cloud data automatically when the page mounts", async () => {
  const documentRef = fakeGalaxyDocument();
  const getCalls = [];
  const app = createApplication({ document: documentRef, storage: new MemoryStorage(), transport: { get: async (query) => { getCalls.push(query); return { success: true, tasks: [], issues: [] }; }, post: async () => ({ success: true, results: [], tasks: [], issues: [] }) } });
  app.mount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(getCalls, []);
});

test("clears local tasks and pending changes before downloading the cloud snapshot", async () => {
  const task = { id: "local-1", fullSerial: "A02-001190", serialLast4: "1190", targetDate: "2026-09-01", completedDate: "2026-09-01", status: "done" };
  const storage = new MemoryStorage();
  writeStoredState(storage, { tasks: [task], cloudTasks: [task], outbox: [{ mutationId: "m-1", taskId: task.id, patch: { status: "done", completedDate: task.completedDate } }] });
  const documentRef = fakeGalaxyDocument();
  const app = createApplication({ document: documentRef, storage, transport: { get: async () => ({ success: true, tasks: [{ ...task, completedDate: "", status: "pending" }], issues: [] }), post: async () => ({ success: true, results: [], tasks: [], issues: [] }) } });
  const previousConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    app.mount();
    documentRef.elements.get("galaxyImportBtn").listeners.get("click")();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    if (previousConfirm === undefined) delete globalThis.confirm;
    else globalThis.confirm = previousConfirm;
  }
  assert.equal(app.getState().outbox.length, 0);
  assert.deepEqual(app.getState().tasks.map((item) => item.status), ["pending"]);
});

test("downloads cloud data in AMRS without asking for confirmation", async () => {
  const task = { id: "local-1", fullSerial: "A02-001190", serialLast4: "1190", targetDate: "2026-09-01", completedDate: "", status: "pending" };
  const storage = new MemoryStorage();
  writeStoredState(storage, { tasks: [task], cloudTasks: [task] });
  const documentRef = fakeGalaxyDocument();
  const app = createApplication({ document: documentRef, storage, transport: { get: async () => ({ success: true, tasks: [{ ...task, fullSerial: "A02-001193", serialLast4: "1193" }], issues: [] }), post: async () => ({ success: true, results: [], tasks: [], issues: [] }) } });
  const previousConfirm = globalThis.confirm;
  let confirmCalled = false;
  globalThis.confirm = () => { confirmCalled = true; return false; };
  try {
    app.mount();
    documentRef.elements.get("galaxyImportBtn").listeners.get("click")();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    if (previousConfirm === undefined) delete globalThis.confirm;
    else globalThis.confirm = previousConfirm;
  }
  assert.equal(confirmCalled, false);
  assert.deepEqual(app.getState().tasks.map((item) => item.serialLast4), ["1193"]);
});

test("opens the CSV file picker from the visible AMRS import button", () => {
  const documentRef = fakeGalaxyDocument();
  const app = createApplication({ document: documentRef, storage: new MemoryStorage(), transport: null });
  app.mount();
  const picker = documentRef.elements.get("galaxyCsvFileInput");
  documentRef.elements.get("galaxyCsvImportBtn").listeners.get("click")();
  assert.equal(picker.clicked, true);
});

test("opens an editable pending changes list from the local change badge", () => {
  const task = { id: "pending-1", fullSerial: "A02-001190", serialLast4: "1190", targetDate: "2026-09-01", completedDate: "2026-09-01", status: "done" };
  const storage = new MemoryStorage();
  writeStoredState(storage, { tasks: [task], cloudTasks: [{ ...task, completedDate: "", status: "pending" }], outbox: [{ mutationId: "m-1", taskId: task.id, patch: { status: "done", completedDate: "2026-09-01" }, baseCompletedDate: "" }] });
  const documentRef = fakeGalaxyDocument();
  const app = createApplication({ document: documentRef, storage, transport: null });
  app.mount();
  documentRef.elements.get("galaxyLogOfflineBadge").listeners.get("click")();
  const panel = documentRef.elements.get("galaxyPendingPanel");
  assert.match(panel.innerHTML, /已按好，待同步/);
  assert.match(panel.innerHTML, /A02-001190/);
  assert.match(panel.innerHTML, /data-pending-action="delete"/);
  assert.match(panel.innerHTML, /data-pending-action="bulk-done"/);
  assert.match(panel.innerHTML, /data-pending-action="bulk-no-log"/);
});

test("applies a new result to multiple pending changes and deletes selected changes", () => {
  const tasks = [1, 2].map((index) => ({ id: `pending-${index}`, fullSerial: `A02-00119${index}`, serialLast4: `119${index}`, targetDate: `2026-09-0${index}`, completedDate: `2026-09-0${index}`, status: "done" }));
  const storage = new MemoryStorage();
  writeStoredState(storage, { tasks, cloudTasks: tasks.map((task) => ({ ...task, completedDate: "", status: "pending" })), outbox: tasks.map((task) => ({ mutationId: `m-${task.id}`, taskId: task.id, patch: { status: "done", completedDate: task.completedDate }, baseCompletedDate: "" })) });
  const documentRef = fakeGalaxyDocument();
  const app = createApplication({ document: documentRef, storage, transport: null });
  app.mount();
  const badge = documentRef.elements.get("galaxyLogOfflineBadge");
  badge.listeners.get("click")();
  const panel = documentRef.elements.get("galaxyPendingPanel");
  const change = panel.listeners.get("change");
  change({ target: { id: "galaxyPendingSelectAll", checked: true } });
  panel.listeners.get("click")({ target: { closest: () => ({ dataset: { pendingAction: "bulk-no-log" } }) } });
  assert.equal(app.getState().tasks.every((task) => task.status === "no_log"), true);
  panel.listeners.get("change")({ target: { id: "galaxyPendingSelectAll", checked: true } });
  panel.listeners.get("click")({ target: { closest: () => ({ dataset: { pendingAction: "delete" } }) } });
  assert.equal(app.getState().outbox.length, 0);
  assert.equal(app.getState().tasks.every((task) => task.status === "pending" && task.completedDate === ""), true);
});

test("shows and queues a no-log result beside the completed action", async () => {
  const documentRef = fakeGalaxyDocument();
  const transport = {
    get: async () => ({ success: true, tasks: [{ id: "no-log-1", fullSerial: "A02-001190", serialLast4: "1190", targetDate: "2026-09-01", completedDate: "", status: "pending" }], issues: [] }),
    post: async () => ({ success: true, results: [], tasks: [], issues: [] }),
  };
  const app = createApplication({ document: documentRef, storage: new MemoryStorage(), transport });
  app.mount();
  documentRef.elements.get("galaxyImportBtn").listeners.get("click")();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(documentRef.elements.get("galaxyLogList").innerHTML, /galaxy-task-serial">1190 <span>完整 SN A02-001190<\/span>/);
  assert.match(documentRef.elements.get("galaxyLogList").innerHTML, /data-galaxy-action="complete"/);
  assert.match(documentRef.elements.get("galaxyLogList").innerHTML, /data-galaxy-action="no-log"/);
  documentRef.elements.get("galaxyLogList").listeners.get("click")({
    target: { closest: () => ({ dataset: { galaxyAction: "no-log", galaxyId: "no-log-1" } }) },
  });
  assert.equal(app.getState().tasks[0].status, "no_log");
  assert.match(app.getState().tasks[0].completedDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(app.getState().outbox[0].patch.status, "no_log");
  assert.match(app.getState().outbox[0].patch.completedDate, /^\d{4}-\d{2}-\d{2}$/);
});

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

test("parses the compact A B C Galaxy sheet headers without treating target dates as completion dates", () => {
  const result = parseGalaxyRows({
    sheetName: "Galaxy Log",
    rows: [
      ["機身號碼", "指定取log日期", "成功取log日期"],
      ["A02-001190", "2026/5/17", ""],
      ["", "2026/5/16", "2026/9/1"],
    ],
  });

  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.tasks.map((task) => [task.fullSerial, task.targetDate, task.completedDate, task.status]), [
    ["A02-001190", "2026-05-17", "", "pending"],
    ["A02-001190", "2026-05-16", "2026-09-01", "done"],
  ]);
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

test("reads the standardized CSV with full SN instead of treating the last-four column as SN", async () => {
  const result = await parseWorkbookFile({
    name: "Galaxy.csv",
    text: async () => "SN,SN末4位,指定 Log 日期,取 Log 日期,狀態\r\nA02-001190,1190,2026-05-17,,未取\r\n",
  });
  assert.equal(result.tasks[0].fullSerial, "A02-001190");
  assert.equal(result.tasks[0].serialLast4, "1190");
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

test("carries merged serial numbers down within repeated Galaxy Log columns", () => {
  const result = parseGalaxyColumnGroups({
    rows: [
      ["SN末4位", "指定 Log 日期", "取 Log 日期"],
      ["A02-001190", "2026/5/17", ""],
      ["", "2026/5/16", ""],
      ["A02-001193", "2026/6/2", ""],
      ["", "2026/6/2", ""],
      ["", "2026/5/30", ""],
    ],
  });

  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.tasks.map((task) => [task.serialLast4, task.targetDate]), [
    ["1190", "2026-05-17"],
    ["1190", "2026-05-16"],
    ["1193", "2026-06-02"],
    ["1193", "2026-06-02"],
    ["1193", "2026-05-30"],
  ]);
  assert.equal(result.tasks[2].fullSerial, "A02-001193");
});

test("detects blank spacer columns between repeated Galaxy Log groups", () => {
  const result = parseGalaxyColumnGroups({
    rows: [
      ["A02-001190", "2026/5/17", "", "", "A02-001193", "2026/6/2", "", ""],
      ["", "2026/5/16", "", "", "", "2026/5/30", "", ""],
    ],
  });

  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.tasks.map((task) => [task.serialLast4, task.targetDate, task.groupIndex]), [
    ["1190", "2026-05-17", 0],
    ["1190", "2026-05-16", 0],
    ["1193", "2026-06-02", 1],
    ["1193", "2026-05-30", 1],
  ]);
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

test("opens the pending changes panel instead of uploading imported files immediately", async () => {
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
  documentRef.elements.get("galaxyImportBtn").listeners.get("click")();
  await new Promise((resolve) => setTimeout(resolve, 0));

  await app.importFile({
    name: "Galaxy.csv",
    text: async () => "SN末4位,指定 Log 日期,取 Log 日期\r\n1190,2026/09/01,\r\n",
  });

  assert.equal(calls.length, 0);
  assert.equal(app.getState().outbox.length, 1);
  assert.match(documentRef.elements.get("galaxyPendingPanel").innerHTML, /已按好，待同步/);

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

  assert.equal(calls.length, 0);
  assert.equal(app.getState().outbox.length, 2);
  assert.match(documentRef.elements.get("galaxyPendingPanel").innerHTML, /已按好，待同步/);
});

test("imports an offline CSV and queues only rows that differ from the cloud snapshot", async () => {
  const cloudTasks = [
    { id: "cloud-1190-17", fullSerial: "A02-001190", serialLast4: "1190", targetDate: "2026-05-17", completedDate: "", status: "pending", groupIndex: 0, rowIndex: 2, duplicateIndex: 0 },
    { id: "cloud-1190-16", fullSerial: "A02-001190", serialLast4: "1190", targetDate: "2026-05-16", completedDate: "", status: "pending", groupIndex: 0, rowIndex: 3, duplicateIndex: 0 },
    { id: "cloud-1193-02", fullSerial: "A02-001193", serialLast4: "1193", targetDate: "2026-06-02", completedDate: "", status: "pending", groupIndex: 0, rowIndex: 4, duplicateIndex: 0 },
  ];
  const storage = new MemoryStorage();
  writeStoredState(storage, { tasks: cloudTasks, cloudTasks, importedFileModifiedAt: 1000 });
  const documentRef = fakeGalaxyDocument();
  const app = createApplication({ document: documentRef, storage, transport: null });
  app.mount();
  await app.importFile({
    name: "Galaxy.csv",
    lastModified: 2000,
    text: async () => "SN,SN末4位,指定 Log 日期,取 Log 日期,狀態\r\nA02-001190,1190,2026-05-17,2026-09-01,已取\r\nA02-001190,1190,2026-05-16,2026-09-01,已取\r\nA02-001193,1193,2026-06-02,,未取\r\n",
  });

  assert.equal(app.getState().tasks.length, 3);
  assert.deepEqual(app.getState().tasks.map((task) => task.id), ["cloud-1190-17", "cloud-1190-16", "cloud-1193-02"]);
  assert.deepEqual(app.getState().outbox.map((mutation) => mutation.taskId), ["cloud-1190-17", "cloud-1190-16"]);
  assert.match(documentRef.elements.get("galaxyPendingPanel").innerHTML, /已按好，待同步（2）/);
});

test("asks before replacing the local snapshot with an older CSV", async () => {
  const currentTask = { id: "current", fullSerial: "A02-001190", serialLast4: "1190", targetDate: "2026-05-17", completedDate: "", status: "pending" };
  const olderTask = { id: "older", fullSerial: "A02-001193", serialLast4: "1193", targetDate: "2026-06-02", completedDate: "", status: "pending" };
  const storage = new MemoryStorage();
  writeStoredState(storage, { tasks: [currentTask], cloudTasks: [currentTask], importedFileModifiedAt: 2000 });
  const documentRef = fakeGalaxyDocument();
  const app = createApplication({ document: documentRef, storage, transport: null });
  const previousConfirm = globalThis.confirm;
  let confirmCalls = 0;
  globalThis.confirm = () => { confirmCalls += 1; return confirmCalls > 1; };
  const file = { name: "older.csv", lastModified: 1000, text: async () => "SN,SN末4位,指定 Log 日期,取 Log 日期,狀態\r\nA02-001193,1193,2026-06-02,,未取\r\n" };
  try {
    app.mount();
    await app.importFile(file);
    assert.deepEqual(app.getState().tasks.map((task) => task.id), ["current"]);
    assert.match(documentRef.elements.get("galaxyLogStatus").textContent, /已取消匯入/);
    await app.importFile(file);
  } finally {
    if (previousConfirm === undefined) delete globalThis.confirm;
    else globalThis.confirm = previousConfirm;
  }
  assert.equal(confirmCalls, 2);
  assert.deepEqual(app.getState().tasks.map((task) => task.fullSerial), ["A02-001193"]);
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

test("distinguishes Google Sheet write permission from an AMRS Token permission error", async () => {
  const documentRef = fakeGalaxyDocument();
  const transport = {
    get: async () => ({
      success: true,
      tasks: [{ id: "sheet-permission-1", fullSerial: "1190", serialLast4: "1190", targetDate: "2026-09-01", completedDate: "", status: "pending" }],
      issues: [],
    }),
    post: async () => { throw Object.assign(new Error("Google Sheets request failed (403)"), { httpStatus: 403 }); },
  };
  const app = createApplication({ document: documentRef, storage: new MemoryStorage(), transport });
  app.mount();
  documentRef.elements.get("galaxyImportBtn").listeners.get("click")();
  await new Promise((resolve) => setTimeout(resolve, 0));
  documentRef.elements.get("galaxyLogList").listeners.get("click")({
    target: { closest: () => ({ dataset: { galaxyAction: "complete", galaxyId: "sheet-permission-1" } }) },
  });
  await app.syncCloud();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const status = documentRef.elements.get("galaxyLogStatus").textContent;
  assert.match(status, /Google Sheet.*編輯權限/);
  assert.doesNotMatch(status, /Token 沒有 Galaxy\/AE 權限/);
});
