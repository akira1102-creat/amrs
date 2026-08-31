import assert from "node:assert/strict";
import test from "node:test";
import galaxyModule from "../galaxy-log.js";

const {
  buildTaskId,
  completeTask,
  filterTasks,
  formatLocalDateTime,
  mergeImportedTasks,
  parseGalaxyRows,
  readStoredState,
  writeStoredState,
} = galaxyModule;

class MemoryStorage {
  #values = new Map();

  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
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
