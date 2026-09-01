(function attachAmrsGalaxyLog(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AmrsGalaxyLog = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createModule(root) {
  "use strict";

  const STORAGE_KEY = "_amrs_galaxy_log_v1";
  const STATE_VERSION = 2;
  const COLUMN_GROUP_HEADERS = ["SN末4位", "指定 Log 日期", "取 Log 日期"];
  const STATUS_LABELS = {
    pending: "未取",
    done: "已取",
    no_log: "沒有當天 Log",
    needs_review: "需跟進",
  };
  const NO_LOG_MARKER = "已檢查無log";

  function text(value) {
    return String(value == null ? "" : value).trim();
  }

  function escapeHtml(value) {
    return text(value).replace(/[&<>'"]/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    }[char]));
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function isoFromDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function formatLocalDateTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${isoFromDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function excelSerialToIso(value) {
    const serial = Number(value);
    if (!Number.isFinite(serial) || serial < 1 || serial > 100000) return "";
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
    return date.toISOString().slice(0, 10);
  }

  function monthNameToNumber(value) {
    const month = text(value).toLowerCase().slice(0, 3);
    return {
      jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
      jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    }[month] || 0;
  }

  function validIsoDate(year, month, day) {
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) return "";
    return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
  }

  function normalizeDate(value, fallbackYear = new Date().getFullYear()) {
    if (value instanceof Date) return isoFromDate(value);
    if (typeof value === "number") return excelSerialToIso(value);
    const raw = text(value);
    if (!raw || /^=?#?N\/?A$/i.test(raw)) return "";

    let match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (match) return validIsoDate(match[1], match[2], match[3]);

    match = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (match) {
      const first = Number(match[1]);
      const second = Number(match[2]);
      const year = Number(match[3]);
      if (second > 12) return validIsoDate(year, first, second);
      if (first > 12) return validIsoDate(year, second, first);
      return validIsoDate(year, first, second);
    }

    match = raw.match(/^(\d{1,2})[- ]([A-Za-z]{3,9})(?:[- ](\d{4}))?$/);
    if (match) {
      const month = monthNameToNumber(match[2]);
      if (!month) return "";
      return validIsoDate(match[3] || fallbackYear, month, match[1]);
    }
    return "";
  }

  function noLogDate(value) {
    const raw = text(value);
    if (!/(?:沒有當天\s*log|已檢查\s*無\s*log|no\s*log)/i.test(raw)) return "";
    const dateText = raw
      .replace(/(?:沒有當天\s*log|已檢查\s*無\s*log|no\s*log)/ig, "")
      .replace(/[（）()[\]]/g, " ")
      .trim();
    return normalizeDate(dateText);
  }

  function isNoLogValue(value) {
    return /(?:沒有當天\s*log|已檢查\s*無\s*log|no\s*log)/i.test(text(value));
  }

  function normalizeSerial(value) {
    const raw = text(value).replace(/^'+/, "").replace(/\s+/g, "").toUpperCase();
    if (!raw || /^=?#?N\/?A$/i.test(raw) || raw.startsWith("=")) return "";
    return raw;
  }

  function serialLast4(value) {
    const match = normalizeSerial(value).match(/(\d{4})$/);
    return match ? match[1] : "";
  }

  function isSerialLike(value) {
    const raw = normalizeSerial(value);
    if (!raw || /^DATE$/i.test(raw) || /SERIAL|OCCURRED|COMPLETED|機身|號碼|日期/i.test(raw)) return false;
    return /\d/.test(raw);
  }

  function hash(value) {
    let result = 2166136261;
    for (const char of String(value)) {
      result ^= char.charCodeAt(0);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(16).padStart(8, "0");
  }

  function buildTaskId(fullSerial, targetDate, occurrenceIndex = 0) {
    return `gx-${hash(`${normalizeSerial(fullSerial)}|${normalizeDate(targetDate)}|${String(occurrenceIndex)}`)}`;
  }

  function buildColumnTaskId(serial, targetDate, groupIndex, rowIndex, occurrenceIndex = 0) {
    return buildTaskId(serial, targetDate, `g${Number(groupIndex) || 0}r${Number(rowIndex) || 0}o${Number(occurrenceIndex) || 0}`);
  }

  function columnHeaderRow(row = []) {
    const values = Array.isArray(row) ? row.map((value) => text(value).toLowerCase()) : [];
    if (!values.length) return false;
    const hasSerialLabel = values.some((value) => /sn|serial|機身|機台|序號|號碼/.test(value));
    const hasTargetLabel = values.some((value) => /指定|target|occurred|日期|log/.test(value));
    const hasCompletionLabel = values.some((value) => /取\s*log|completed|complete|完成/.test(value));
    return hasSerialLabel && hasTargetLabel && hasCompletionLabel;
  }

  function standardizedTaskHeaderRow(row = []) {
    const values = Array.isArray(row) ? row.map((value) => text(value).toLowerCase()) : [];
    return values.some((value) => /^sn$|^serial(?: number)?$/.test(value))
      && values.some((value) => /末\s*4|last\s*4/.test(value))
      && values.some((value) => /指定\s*log\s*日期|target\s*date/.test(value))
      && values.some((value) => /取\s*log\s*日期|completed\s*date/.test(value));
  }

  function galaxyColumnBases(matrix, startRow) {
    const values = Array.isArray(matrix) ? matrix : [];
    const width = values.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
    const header = startRow > 0 && Array.isArray(values[startRow - 1]) ? values[startRow - 1] : [];
    const bases = [];
    const serialHeader = /sn|serial|機身|機台|序號|號碼/;
    const targetHeader = /指定|target|occurred|日期|log/;
    for (let column = 0; column < Math.max(1, width - 1); column += 1) {
      const headerPair = startRow > 0
        && serialHeader.test(text(header[column]).toLowerCase())
        && targetHeader.test(text(header[column + 1]).toLowerCase());
      const dataPair = values.slice(startRow).some((row) => Array.isArray(row)
        && serialLast4(row[column])
        && !normalizeDate(row[column])
        && normalizeDate(row[column + 1]));
      if (headerPair || dataPair) bases.push(column);
    }
    if (bases.length) return bases;
    const stride = width > 3 && width % 4 === 0 ? 4 : 3;
    return Array.from({ length: Math.max(1, Math.ceil(width / stride)) }, (_, index) => index * stride)
      .filter((base) => base < Math.max(width, 3));
  }

  function parseGalaxyColumnGroups({ rows = [], sheetName = "Galaxy Log" } = {}) {
    const matrix = Array.isArray(rows) ? rows : [];
    const tasks = [];
    const issues = [];
    const width = matrix.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
    const startRow = columnHeaderRow(matrix[0]) ? 1 : 0;
    const groupBases = galaxyColumnBases(matrix, startRow);
    const groupCount = groupBases.length;
    const occurrenceByKey = new Map();

    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      let currentSerial = "";
      let currentFullSerial = "";
      for (let rowOffset = startRow; rowOffset < matrix.length; rowOffset += 1) {
        const row = Array.isArray(matrix[rowOffset]) ? matrix[rowOffset] : [];
        const base = groupBases[groupIndex];
        const rawSerial = row[base];
        const rawTarget = row[base + 1];
        const rawCompleted = row[base + 2];
        if (!text(rawSerial) && !text(rawTarget) && !text(rawCompleted)) {
          currentSerial = "";
          currentFullSerial = "";
          continue;
        }

        if (text(rawSerial)) {
          currentFullSerial = normalizeSerial(rawSerial);
          currentSerial = serialLast4(currentFullSerial) || currentFullSerial;
        }
        const serial = currentSerial;
        const targetDate = normalizeDate(rawTarget);
        const completedText = text(rawCompleted);
        const noLog = isNoLogValue(completedText);
        const completedDate = noLog ? noLogDate(completedText) : normalizeDate(rawCompleted);
        if (!serial) {
          issues.push({ row: rowOffset + 1, groupIndex, type: "missing-serial", message: "找不到機身號碼（最後 4 位）", value: text(rawSerial) });
          continue;
        }
        if (!targetDate) {
          issues.push({ row: rowOffset + 1, groupIndex, type: "invalid-date", message: "指定 Log 日期格式無法辨識", value: text(rawTarget) });
          continue;
        }
        if (completedText && !completedDate && !noLog && !/^(?:n\/?a|-)$/i.test(completedText)) {
          issues.push({ row: rowOffset + 1, groupIndex, type: "completion-value", message: "取 Log 日期格式無法辨識", value: completedText });
        }
        const key = `${serial}|${targetDate}`;
        const occurrenceIndex = occurrenceByKey.get(`${groupIndex}|${key}`) || 0;
        occurrenceByKey.set(`${groupIndex}|${key}`, occurrenceIndex + 1);
        const rowIndex = rowOffset + 1;
        tasks.push({
          id: buildColumnTaskId(serial, targetDate, groupIndex, rowIndex, occurrenceIndex),
          fullSerial: currentFullSerial || serial,
          serialLast4: serial,
          targetDate,
          completedDate,
          status: noLog ? "no_log" : completedDate ? "done" : (completedText ? "needs_review" : "pending"),
          note: completedText && !completedDate && !noLog ? completedText : "",
          sourceSheet: text(sheetName),
          sourceRow: rowIndex,
          groupIndex,
          rowIndex,
          duplicateIndex: occurrenceIndex,
          sourceFormat: "columns",
        });
      }
    }
    return { kind: "columns", sheetName, tasks, issues, groupCount, groupBases };
  }

  function tasksToColumnGroups(tasks) {
    const values = Array.isArray(tasks) ? tasks : [];
    const groupCount = Math.max(1, ...values.map((task) => Number(task?.groupIndex) >= 0 ? Number(task.groupIndex) + 1 : 1));
    const rows = [Array.from({ length: groupCount }, () => COLUMN_GROUP_HEADERS).flat()];
    const nextRowByGroup = Array(groupCount).fill(2);
    const sorted = values.slice().sort((left, right) => Number(left?.groupIndex || 0) - Number(right?.groupIndex || 0)
      || Number(left?.rowIndex || 0) - Number(right?.rowIndex || 0)
      || text(left?.targetDate).localeCompare(text(right?.targetDate)));
    for (const task of sorted) {
      const groupIndex = Math.max(0, Number(task?.groupIndex) || 0);
      const rowIndex = Number(task?.rowIndex) >= 2 ? Number(task.rowIndex) : nextRowByGroup[groupIndex];
      nextRowByGroup[groupIndex] = Math.max(nextRowByGroup[groupIndex], rowIndex + 1);
      while (rows.length < rowIndex) rows.push(Array(groupCount * 3).fill(""));
      while (rows[rowIndex - 1].length < groupCount * 3) rows[rowIndex - 1].push("");
      const base = groupIndex * 3;
      rows[rowIndex - 1][base] = text(task.serialLast4 || serialLast4(task.fullSerial));
      rows[rowIndex - 1][base + 1] = text(task.targetDate);
      rows[rowIndex - 1][base + 2] = task.status === "no_log" ? `${text(task.completedDate)} ${NO_LOG_MARKER}`.trim() : text(task.completedDate);
    }
    return rows;
  }

  function findHeaderInfo(rows) {
    const limit = Math.min(Array.isArray(rows) ? rows.length : 0, 30);
    for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
      const row = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : [];
      const labels = row.map((value) => text(value).toLowerCase());
      const serialCol = labels.findIndex((value) => /serial|s\/?n|機身|機台|序號/.test(value));
      const completedCol = labels.findIndex((value) => /completed|complete|取\s*log|完成/.test(value));
      const targetCol = labels.findIndex((value) => /occurred|指定|log.*date|發生|日期/.test(value) && !/completed|complete|完成/.test(value));
      const statusCol = labels.findIndex((value) => /status|狀態/.test(value));
      const noteCol = labels.findIndex((value) => /note|remark|備註/.test(value));
      if (serialCol >= 0 && completedCol >= 0 && targetCol >= 0) return { rowIndex, serialCol, targetCol, completedCol, statusCol, noteCol };
    }
    return null;
  }

  function taskFromValues({ fullSerial, targetDate, completedDate, status, note, sheetName, sourceRow, occurrenceIndex }) {
    const serial = normalizeSerial(fullSerial);
    const target = normalizeDate(targetDate);
    const complete = normalizeDate(completedDate);
    return {
      id: buildTaskId(serial, target, occurrenceIndex),
      fullSerial: serial,
      serialLast4: serialLast4(serial),
      targetDate: target,
      completedDate: complete,
      status: status || (complete ? "done" : "pending"),
      note: text(note),
      sourceSheet: text(sheetName),
      sourceRow: Number(sourceRow) || 0,
      duplicateIndex: Number(occurrenceIndex) || 0,
    };
  }

  function parseGalaxyRows({ sheetName = "", rows = [] } = {}) {
    const matrix = Array.isArray(rows) ? rows : [];
    const header = findHeaderInfo(matrix);
    const tasks = [];
    const issues = [];
    const occurrenceByKey = new Map();
    const addTask = (values) => {
      const key = `${normalizeSerial(values.fullSerial)}|${normalizeDate(values.targetDate)}`;
      const occurrenceIndex = occurrenceByKey.get(key) || 0;
      occurrenceByKey.set(key, occurrenceIndex + 1);
      tasks.push(taskFromValues({ ...values, occurrenceIndex }));
    };

    if (header) {
      let currentSerial = "";
      for (let index = header.rowIndex + 1; index < matrix.length; index += 1) {
        const row = Array.isArray(matrix[index]) ? matrix[index] : [];
        const rawSerial = row[header.serialCol];
        if (text(rawSerial)) currentSerial = normalizeSerial(rawSerial);
        const rawTarget = row[header.targetCol];
        const rawCompleted = row[header.completedCol];
        const rawStatus = header.statusCol >= 0 ? row[header.statusCol] : "";
        const rawNote = header.noteCol >= 0 ? row[header.noteCol] : "";
        if (!text(rawTarget) && !text(rawSerial) && !text(rawCompleted)) continue;
        const rawCompletionText = text(rawCompleted);
        const noLogCompletion = isNoLogValue(rawCompletionText);
        const rawCompletionDate = noLogCompletion ? noLogDate(rawCompletionText) : normalizeDate(rawCompleted);
        const invalidCompletion = rawCompletionText && !rawCompletionDate && !noLogCompletion && !/^(?:n\/?a|-)$/i.test(rawCompletionText);
        if (!text(rawSerial) && invalidCompletion) currentSerial = "";
        if (!currentSerial) {
          issues.push({ row: index + 1, type: "missing-serial", message: "找不到 SN", value: text(rawSerial) || "" });
          continue;
        }
        const targetDate = normalizeDate(rawTarget);
        if (!targetDate) {
          issues.push({ row: index + 1, type: "invalid-date", message: "指定 Log 日期格式無法辨識", value: text(rawTarget) });
          continue;
        }
        const completedDate = rawCompletionDate;
        const completionText = rawCompletionText;
        const statusText = text(rawStatus).toLowerCase();
        const explicitDone = /done|已取|complete|完成/.test(statusText);
        const explicitNoLog = /no[_ -]?log|沒有當天\s*log/.test(statusText) || isNoLogValue(completionText);
        const explicitNeedsReview = /needs?[\s_-]*review|需\s*跟進|跟進|review/.test(statusText);
        const explicitPending = /pending|未取/.test(statusText);
        const status = explicitNoLog ? "no_log" : completedDate || explicitDone ? "done" : explicitNeedsReview || invalidCompletion ? "needs_review" : explicitPending ? "pending" : "pending";
        if (invalidCompletion) {
          issues.push({ row: index + 1, type: "completion-value", message: "完成欄不是日期，已保留作需跟進", value: completionText });
        }
        addTask({
          fullSerial: currentSerial,
          targetDate,
          completedDate,
          status,
          note: text(rawNote) || (invalidCompletion ? completionText : ""),
          sheetName,
          sourceRow: index + 1,
        });
      }
      return { kind: "source", sheetName, tasks, issues };
    }

    let currentSerial = "";
    for (let index = 0; index < matrix.length; index += 1) {
      const row = Array.isArray(matrix[index]) ? matrix[index] : [];
      const rawSerial = row[0];
      const rawTarget = row[1];
      if (text(rawSerial) && isSerialLike(rawSerial)) currentSerial = normalizeSerial(rawSerial);
      if (!text(rawTarget)) continue;
      if (!currentSerial) {
        issues.push({ row: index + 1, type: "missing-serial", message: "找不到 SN", value: text(rawSerial) });
        continue;
      }
      const targetDate = normalizeDate(rawTarget);
      if (!targetDate) {
        issues.push({ row: index + 1, type: "invalid-date", message: "指定 Log 日期格式無法辨識", value: text(rawTarget) });
        continue;
      }
      addTask({ fullSerial: currentSerial, targetDate, sheetName, sourceRow: index + 1 });
    }
    return { kind: "print", sheetName, tasks, issues };
  }

  function isSourceSheet(rows) {
    return !!findHeaderInfo(rows);
  }

  function mergeImportedTasks(existing, imported, { importedAt = new Date().toISOString(), sourceName = "" } = {}) {
    const tasks = (Array.isArray(existing) ? existing : []).map((task) => ({ ...task }));
    const byId = new Map(tasks.map((task, index) => [task.id, { task, index }]));
    let added = 0;
    let updated = 0;
    for (const incoming of Array.isArray(imported) ? imported : []) {
      if (!incoming?.id || !incoming.fullSerial || !incoming.targetDate) continue;
      const found = byId.get(incoming.id);
      if (!found) {
        tasks.push({ ...incoming, importedAt, sourceName, updatedAt: importedAt });
        byId.set(incoming.id, { task: tasks[tasks.length - 1], index: tasks.length - 1 });
        added += 1;
        continue;
      }
      const current = found.task;
      const localDone = current.status === "done" && current.completedDate;
      const incomingDone = incoming.status === "done" && incoming.completedDate;
      Object.assign(current, incoming, {
        completedDate: localDone ? current.completedDate : (incoming.completedDate || current.completedDate || ""),
        status: localDone ? "done" : (incomingDone ? "done" : (current.status === "done" ? "done" : incoming.status || current.status || "pending")),
        note: current.note || incoming.note || "",
        importedAt,
        sourceName,
        updatedAt: importedAt,
      });
      updated += 1;
    }
    return { tasks, added, updated };
  }

  function snapshotTimestamp(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function mergeImportedSnapshot(value, parsed, fileModifiedAt = 0) {
    const current = normalizeState(value);
    const incomingAt = snapshotTimestamp(fileModifiedAt);
    const currentAt = snapshotTimestamp(current.importedFileModifiedAt);
    const replace = currentAt <= 0 ? true : incomingAt > currentAt;
    if (!replace) return { replaced: false, state: current, reason: "older-or-same" };
    const importedAt = new Date().toISOString();
    const tasks = (Array.isArray(parsed?.tasks) ? parsed.tasks : []).map(normalizeTask).filter(Boolean)
      .map((task) => ({ ...task, importedAt, sourceName: text(parsed?.sourceName), updatedAt: importedAt }));
    return {
      replaced: true,
      state: {
        ...current,
        tasks,
        issues: Array.isArray(parsed?.issues) ? parsed.issues.slice(0, 200) : [],
        importedAt,
        importedFileModifiedAt: incomingAt || Date.now(),
        sourceName: text(parsed?.sourceName),
        sourceSheet: text(parsed?.sheetName),
        snapshotSource: text(parsed?.sourceName),
      },
    };
  }

  function completeTask(tasks, id, completedDate = isoFromDate(new Date())) {
    const date = normalizeDate(completedDate) || isoFromDate(new Date());
    return (Array.isArray(tasks) ? tasks : []).map((task) => task.id === id ? { ...task, status: "done", completedDate: date, updatedAt: new Date().toISOString() } : { ...task });
  }

  function reopenTask(tasks, id) {
    return (Array.isArray(tasks) ? tasks : []).map((task) => task.id === id ? { ...task, status: "pending", completedDate: "", updatedAt: new Date().toISOString() } : { ...task });
  }

  function filterTasks(tasks, { query = "", status = "pending" } = {}) {
    const normalizedQuery = text(query).toLowerCase();
    return (Array.isArray(tasks) ? tasks : [])
      .filter((task) => !status || status === "all" || task.status === status)
      .filter((task) => !normalizedQuery || [task.fullSerial, task.serialLast4, task.targetDate, task.completedDate].some((value) => text(value).toLowerCase().includes(normalizedQuery)))
      .sort((left, right) => {
        const statusWeight = { pending: 0, needs_review: 1, done: 2 };
        return (statusWeight[left.status] ?? 9) - (statusWeight[right.status] ?? 9)
          || text(left.targetDate).localeCompare(text(right.targetDate))
          || text(left.fullSerial).localeCompare(text(right.fullSerial))
          || Number(left.duplicateIndex || 0) - Number(right.duplicateIndex || 0);
      });
  }

  function normalizeTask(task) {
    if (!task || typeof task !== "object") return null;
    const serial = normalizeSerial(task.fullSerial || task.serialLast4);
    const targetDate = normalizeDate(task.targetDate);
    if (!task.id || !serial || !targetDate) return null;
    const completedDate = normalizeDate(task.completedDate);
    const status = STATUS_LABELS[task.status] ? task.status : (completedDate ? "done" : "pending");
    return {
      ...task,
      fullSerial: serial,
      serialLast4: task.serialLast4 || serialLast4(serial),
      targetDate,
      completedDate,
      status,
      note: text(task.note),
      groupIndex: Number.isFinite(Number(task.groupIndex)) ? Number(task.groupIndex) : 0,
      rowIndex: Number.isFinite(Number(task.rowIndex)) ? Number(task.rowIndex) : 0,
    };
  }

  function stablePatchKey(patch = {}) {
    return Object.keys(patch).sort().map((key) => `${key}:${text(patch[key])}`).join("|");
  }

  function createMutationOutbox(state, mutation) {
    const source = state && typeof state === "object" ? state : {};
    const taskId = text(mutation?.taskId);
    if (!taskId || !mutation?.patch || typeof mutation.patch !== "object") return { ...source, outbox: Array.isArray(source.outbox) ? source.outbox.slice() : [] };
    const patch = { ...mutation.patch };
    const mutationId = text(mutation.mutationId) || `gm-${hash(`${taskId}|${stablePatchKey(patch)}`)}`;
    const previous = (Array.isArray(source.outbox) ? source.outbox : []).find((item) => text(item?.taskId) === taskId);
    const next = {
      mutationId,
      taskId,
      patch,
      baseCompletedDate: previous ? text(previous.baseCompletedDate) : text(mutation.baseCompletedDate),
      createdAt: text(mutation.createdAt) || new Date().toISOString(),
    };
    const outbox = (Array.isArray(source.outbox) ? source.outbox : []).filter((item) => text(item?.taskId) !== taskId);
    outbox.push(next);
    return { ...source, outbox };
  }

  function pendingMutations(state) {
    return (Array.isArray(state?.outbox) ? state.outbox : []).filter((mutation) => text(mutation?.taskId) && mutation?.patch && typeof mutation.patch === "object");
  }

  function mergeCloudTasks(localTasks, cloudTasks, outbox = []) {
    const local = (Array.isArray(localTasks) ? localTasks : []).map(normalizeTask).filter(Boolean);
    const cloud = (Array.isArray(cloudTasks) ? cloudTasks : []).map(normalizeTask).filter(Boolean);
    const pendingById = new Map((Array.isArray(outbox) ? outbox : []).map((mutation) => [text(mutation?.taskId), mutation]));
    const tasks = [];
    const conflicts = [];
    const idRemaps = [];
    const seen = new Set();

    const samePosition = (left, right) => Number(left?.groupIndex) === Number(right?.groupIndex)
      && Number(left?.rowIndex) >= 2
      && Number(left?.rowIndex) === Number(right?.rowIndex);
    const sameIdentity = (left, right) => text(left?.serialLast4 || serialLast4(left?.fullSerial))
      === text(right?.serialLast4 || serialLast4(right?.fullSerial))
      && text(left?.targetDate) === text(right?.targetDate);
    const localEntryFor = (remote) => {
      const exact = local.find((candidate) => !seen.has(candidate.id) && candidate.id === remote.id);
      if (exact) return exact;
      const positioned = local.find((candidate) => !seen.has(candidate.id) && sameIdentity(candidate, remote) && samePosition(candidate, remote));
      if (positioned) return positioned;
      const duplicateIndex = Number(remote.duplicateIndex || 0);
      const duplicate = local.find((candidate) => !seen.has(candidate.id) && sameIdentity(candidate, remote) && Number(candidate.duplicateIndex || 0) === duplicateIndex);
      if (duplicate) return duplicate;
      return local.find((candidate) => !seen.has(candidate.id) && sameIdentity(candidate, remote)) || null;
    };

    for (const remote of cloud) {
      const current = localEntryFor(remote);
      if (current && current.id !== remote.id) idRemaps.push({ from: current.id, to: remote.id });
      const pending = pendingById.get(remote.id) || (current && pendingById.get(current.id));
      let merged = { ...remote };
      if (pending) {
        const desired = { ...remote, ...pending.patch };
        const localCompleted = normalizeDate(pending.patch.completedDate || current?.completedDate);
        const cloudCompleted = normalizeDate(remote.completedDate);
        if (localCompleted && cloudCompleted && localCompleted !== cloudCompleted) {
          merged = { ...remote, ...(current || {}), ...pending.patch, status: "needs_review", conflict: true };
          conflicts.push({ taskId: remote.id, localCompletedDate: localCompleted, cloudCompletedDate: cloudCompleted });
        } else {
          merged = desired;
        }
      } else if (current && !remote.completedDate && current.completedDate) {
        merged = { ...remote, ...current };
      }
      merged.id = remote.id;
      tasks.push(merged);
      if (current) seen.add(current.id);
    }
    for (const current of local) {
      if (!seen.has(current.id)) tasks.push({ ...current });
    }
    return { tasks, conflicts, idRemaps };
  }

  function normalizeState(value) {
    const state = value && typeof value === "object" ? value : {};
    const tasks = Array.isArray(state.tasks) ? state.tasks.map(normalizeTask).filter(Boolean) : [];
    const cloudTasks = Array.isArray(state.cloudTasks) ? state.cloudTasks.map(normalizeTask).filter(Boolean) : [];
    const outbox = Array.isArray(state.outbox) ? state.outbox.filter((mutation) => text(mutation?.taskId) && mutation?.patch && typeof mutation.patch === "object").map((mutation) => ({
      mutationId: text(mutation.mutationId) || `gm-${hash(`${text(mutation.taskId)}|${stablePatchKey(mutation.patch)}`)}`,
      taskId: text(mutation.taskId),
      patch: { ...mutation.patch },
      baseCompletedDate: text(mutation.baseCompletedDate),
      createdAt: text(mutation.createdAt),
    })) : [];
    return {
      version: STATE_VERSION,
      tasks,
      cloudTasks,
      outbox,
      conflicts: Array.isArray(state.conflicts) ? state.conflicts.slice(0, 200) : [],
      cloudReadOnly: Boolean(state.cloudReadOnly),
      lastCloudSyncAt: text(state.lastCloudSyncAt),
      lastCloudError: text(state.lastCloudError),
      issues: Array.isArray(state.issues) ? state.issues.slice(0, 200) : [],
      importedAt: text(state.importedAt),
      importedFileModifiedAt: snapshotTimestamp(state.importedFileModifiedAt),
      snapshotSource: text(state.snapshotSource),
      sourceName: text(state.sourceName),
      sourceSheet: text(state.sourceSheet),
    };
  }

  function readStoredState(storage = root?.localStorage) {
    try {
      const raw = storage?.getItem?.(STORAGE_KEY);
      return normalizeState(raw ? JSON.parse(raw) : null);
    } catch {
      return normalizeState(null);
    }
  }

  function writeStoredState(storage, state) {
    const normalized = normalizeState(state);
    storage?.setItem?.(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  }

  function csvCell(value) {
    const raw = text(value);
    return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
  }

  function tasksToRows(tasks) {
    return [
      ["SN", "SN末4位", "指定 Log 日期", "取 Log 日期", "狀態"],
      ...(Array.isArray(tasks) ? tasks : []).map((task) => [
        task.fullSerial,
        task.serialLast4 || serialLast4(task.fullSerial),
        task.targetDate,
        task.completedDate,
        STATUS_LABELS[task.status] || task.status,
      ]),
    ];
  }

  function tasksToCsv(tasks) {
    return `\ufeff${tasksToRows(tasks).map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
  }

  function parseCsvText(value) {
    const source = String(value || "").replace(/^\ufeff/, "");
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1];
      if (char === '"' && quoted && next === '"') { cell += '"'; index += 1; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (char === "," && !quoted) { row.push(cell); cell = ""; continue; }
      if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && next === "\n") index += 1;
        row.push(cell); cell = "";
        if (row.some((value) => text(value))) rows.push(row);
        row = [];
        continue;
      }
      cell += char;
    }
    if (cell || row.length) { row.push(cell); if (row.some((value) => text(value))) rows.push(row); }
    return rows;
  }

  function downloadBlob(blob, filename, documentRef = root?.document) {
    if (!documentRef?.createElement || !root?.URL?.createObjectURL) return false;
    const url = root.URL.createObjectURL(blob);
    const link = documentRef.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    link.click();
    setTimeout(() => root.URL.revokeObjectURL(url), 0);
    return true;
  }

  function exportTasksXlsx(tasks, xlsx = root?.XLSX, documentRef = root?.document) {
    if (!xlsx?.utils?.aoa_to_sheet || !xlsx?.write) throw new Error("Excel 匯出元件未載入");
    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.aoa_to_sheet(tasksToRows(tasks));
    xlsx.utils.book_append_sheet(workbook, worksheet, "Galaxy Log");
    const output = xlsx.write(workbook, { bookType: "xlsx", type: "array" });
    return downloadBlob(new Blob([output], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `Galaxy-Log-${isoFromDate(new Date()) || "export"}.xlsx`, documentRef);
  }

  function exportTasksCsv(tasks, documentRef = root?.document) {
    return downloadBlob(new Blob([tasksToCsv(tasks)], { type: "text/csv;charset=utf-8" }), `Galaxy-Log-${isoFromDate(new Date()) || "export"}.csv`, documentRef);
  }

  async function parseWorkbookFile(file, xlsx = root?.XLSX) {
    if (!file) throw new Error("請選擇 Excel 或 CSV 檔案");
    if (/\.csv$/i.test(file.name || "")) {
      const rows = parseCsvText(await file.text());
      return standardizedTaskHeaderRow(rows[0])
        ? parseGalaxyRows({ sheetName: file.name || "CSV", rows })
        : columnHeaderRow(rows[0])
          ? parseGalaxyColumnGroups({ sheetName: file.name || "CSV", rows })
          : parseGalaxyRows({ sheetName: file.name || "CSV", rows });
    }
    if (!xlsx?.read || !xlsx?.utils?.sheet_to_json) throw new Error("Excel 匯入元件未載入，請重新整理 AMRS");
    const workbook = xlsx.read(await file.arrayBuffer(), { type: "array", cellDates: true, cellNF: true, cellText: true });
    const candidateNames = Array.isArray(workbook.SheetNames) ? workbook.SheetNames : [];
    const sourceName = candidateNames.find((name) => /p\.?mass|jm/i.test(name) && isSourceSheet(xlsx.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: null })))
      || candidateNames.find((name) => isSourceSheet(xlsx.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: null })))
      || candidateNames.find((name) => /print.?layout/i.test(name))
      || candidateNames[0];
    if (!sourceName) throw new Error("找不到可用工作表");
    const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sourceName], { header: 1, raw: true, defval: null });
    if (standardizedTaskHeaderRow(rows[0])) {
      const parsedStandard = parseGalaxyRows({ sheetName: sourceName, rows });
      parsedStandard.sourceName = file.name || "";
      parsedStandard.ignoredSheets = candidateNames.filter((name) => name !== sourceName);
      return parsedStandard;
    }
    if (columnHeaderRow(rows[0])) {
      const parsedColumns = parseGalaxyColumnGroups({ sheetName: sourceName, rows });
      parsedColumns.sourceName = file.name || "";
      parsedColumns.ignoredSheets = candidateNames.filter((name) => name !== sourceName);
      return parsedColumns;
    }
    const parsed = parseGalaxyRows({ sheetName: sourceName, rows });
    parsed.sourceName = file.name || "";
    parsed.ignoredSheets = candidateNames.filter((name) => name !== sourceName);
    return parsed;
  }

  function createApplication(options = {}) {
    const documentRef = options.document || root?.document;
    const storage = options.storage || root?.localStorage;
    const transport = options.transport;
    let state = readStoredState(storage);
    let filter = { query: "", status: "pending" };
    let mounted = false;
    let busy = false;
    let cloudBusy = false;

    function isOnline() {
      return root?.navigator?.onLine !== false;
    }

    function persist(next) {
      state = writeStoredState(storage, next);
      return state;
    }

    function queueTaskMutation(taskId, patch, baseCompletedDate = "") {
      const current = state.tasks.find((task) => task.id === taskId);
      if (!current) return false;
      const nextTasks = state.tasks.map((task) => task.id === taskId ? { ...task, ...patch, updatedAt: new Date().toISOString() } : { ...task });
      const next = createMutationOutbox({ ...state, tasks: nextTasks }, {
        taskId,
        patch: {
          fullSerial: current.fullSerial,
          serialLast4: current.serialLast4 || serialLast4(current.fullSerial),
          targetDate: current.targetDate,
          groupIndex: current.groupIndex,
          rowIndex: current.rowIndex,
          duplicateIndex: current.duplicateIndex,
          ...patch,
        },
        baseCompletedDate: baseCompletedDate || current.completedDate,
      });
      persist(next);
      return true;
    }

    function notify(message, kind = "ok") {
      if (typeof options.toast === "function") options.toast(message, kind === "err" ? "err" : kind === "warn" ? "warn" : "ok");
      const status = documentRef?.getElementById?.("galaxyLogStatus");
      if (status) { status.textContent = message; status.dataset.kind = kind; }
    }

    function shell() {
      return `<div class="galaxy-page-shell">
        <div class="galaxy-page-head">
          <div><div class="galaxy-page-title">Galaxy 取 Log</div><div class="galaxy-page-subtitle">雲端清單 · 現場離線使用，返公司同步</div></div>
          <div class="galaxy-page-actions">
            <button class="galaxy-btn cloud" id="galaxySyncBtn" type="button">同步至雲端</button>
            <button class="galaxy-btn primary" id="galaxyImportBtn" type="button">下載雲端資料</button>
            <button class="galaxy-btn" id="galaxyCsvImportBtn" type="button">匯入 CSV</button>
            <button class="galaxy-btn" id="galaxyExportCsvBtn" type="button">匯出 CSV</button>
            <input id="galaxyCsvFileInput" type="file" accept=".csv,text/csv" hidden>
          </div>
        </div>
        <div class="galaxy-status-strip"><span id="galaxyLogSummary"></span><span id="galaxyLogOfflineBadge"></span><span id="galaxyLogStatus" role="status" aria-live="polite"></span></div>
        <div class="galaxy-filter-bar">
          <input id="galaxyLogSearch" type="search" inputmode="search" placeholder="搜尋完整 SN 或末四位" autocomplete="off">
          <select id="galaxyLogStatusFilter" aria-label="篩選狀態"><option value="pending">未取</option><option value="needs_review">需跟進</option><option value="done">已取</option><option value="no_log">沒有當天 Log</option><option value="all">全部</option></select>
          <button class="galaxy-btn" id="galaxyLogClearBtn" type="button">清除本機清單</button>
        </div>
        <div id="galaxyLogIssues"></div>
        <div id="galaxyLogList" class="galaxy-task-list"></div>
      </div>`;
    }

    function cloudErrorMessage(error) {
      const raw = text(error?.details?.error?.message || error?.message);
      if (/office file|not supported for this document|native google sheet/i.test(raw)) {
        return "來源檔案仍是 Excel；已嘗試讀取，但要同步取 Log 日期，請先另存為原生 Google 試算表";
      }
      const status = Number(error?.httpStatus || error?.status || 0);
      if (status === 401) return "雲端登入已失效，請重新輸入 Token";
      if (status === 403 && /google\s+(?:sheets?|sheet)\s+request\s+failed|google\s+(?:sheets?|sheet).*permission|insufficient.*permission.*spreadsheet|caller does not have permission/i.test(raw)) {
        return "Google Sheet 沒有編輯權限；請將 Galaxy 清單分享給 AMRS 雲端服務並設為「編輯者」，Token 本身已通過";
      }
      if (status === 403) return "目前 Token 沒有 Galaxy/AE 權限，請聯絡管理員";
      if (status >= 500 || /backend temporarily unavailable|network request failed|timed out/i.test(raw)) {
        return "雲端服務暫時未能連線，請稍後再試";
      }
      return raw || "雲端連線失敗，已保留本機資料";
    }

    function transportAvailable() {
      return !!transport && typeof transport.get === "function" && typeof transport.post === "function";
    }

    async function waitForCloudIdle(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (cloudBusy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      return !cloudBusy;
    }

    async function loadCloud({ silent = false } = {}) {
      if (cloudBusy || !isOnline() || !transport || typeof transport.get !== "function") return false;
      cloudBusy = true;
      render();
      try {
        const response = await transport.get("action=galaxyLogOverview&refresh=1", { timeoutMs: 20_000 });
        if (response?.success === false) throw new Error(response.message || "雲端清單讀取失敗");
        const cloudTasks = Array.isArray(response?.tasks) ? response.tasks : [];
        const merged = mergeCloudTasks(state.tasks, cloudTasks, state.outbox);
        const remaps = new Map(merged.idRemaps.map(({ from, to }) => [from, to]));
        const outbox = state.outbox.map((mutation) => remaps.has(mutation.taskId) ? { ...mutation, taskId: remaps.get(mutation.taskId) } : { ...mutation });
        persist({
          ...state,
          tasks: merged.tasks,
          cloudTasks,
          outbox,
          issues: Array.isArray(response?.issues) ? response.issues : state.issues,
          conflicts: merged.conflicts,
          cloudReadOnly: Boolean(response?.readOnly),
          lastCloudSyncAt: new Date().toISOString(),
          lastCloudError: "",
        });
        if (!silent) notify(
          response?.readOnly
            ? `✓ 已載入雲端清單（${cloudTasks.length} 筆）；來源係 Excel，只能讀取，請轉為原生 Google 試算表後同步`
            : `✓ 已載入雲端清單（${cloudTasks.length} 筆）`,
          response?.readOnly ? "warn" : "ok",
        );
        return true;
      } catch (error) {
        const message = cloudErrorMessage(error);
        persist({ ...state, lastCloudError: message });
        if (!silent) notify(message, "warn");
        return false;
      } finally {
        cloudBusy = false;
        render();
      }
    }

    function remapTaskId(tasks, fromId, toId) {
      return (Array.isArray(tasks) ? tasks : []).map((task) => task.id === fromId ? { ...task, id: toId } : { ...task });
    }

    async function syncCloud() {
      if (cloudBusy) return false;
      if (!isOnline()) { notify("目前離線，返公司有網絡時先同步", "warn"); return false; }
      if (!transportAvailable()) { notify("雲端同步尚未連接，現時只保存本機資料", "warn"); return false; }
      const mutations = pendingMutations(state);
      if (!mutations.length) {
        await loadCloud();
        if (!cloudBusy) notify("目前沒有待同步變更");
        return true;
      }
      cloudBusy = true;
      render();
      try {
        const requestId = `galaxy-sync-${hash(mutations.map((item) => item.mutationId || item.taskId).join("|"))}`;
        const response = await transport.post({ action: "syncGalaxyLog", requestId, mutations }, { timeoutMs: 30_000, requestId });
        if (response?.success === false) throw new Error(response.message || "雲端同步失敗");
        const results = Array.isArray(response?.results) ? response.results : [];
        let tasks = state.tasks.slice();
        let outbox = pendingMutations(state).slice();
        const resultByMutation = new Map(results.map((result) => [text(result.mutationId), result]));
        for (const mutation of mutations) {
          const result = resultByMutation.get(text(mutation.mutationId));
          const canonicalId = text(result?.canonicalTaskId);
          if (canonicalId && canonicalId !== mutation.taskId) {
            tasks = remapTaskId(tasks, mutation.taskId, canonicalId);
            outbox = outbox.map((item) => item.mutationId === mutation.mutationId ? { ...item, taskId: canonicalId } : item);
          }
          if (result?.status === "applied") {
            outbox = outbox.filter((item) => item.mutationId !== mutation.mutationId);
          }
        }
        const cloudTasks = Array.isArray(response?.tasks) ? response.tasks : [];
        const merged = mergeCloudTasks(tasks, cloudTasks, outbox);
        const remaps = new Map(merged.idRemaps.map(({ from, to }) => [from, to]));
        outbox = outbox.map((item) => remaps.has(item.taskId) ? { ...item, taskId: remaps.get(item.taskId) } : { ...item });
        persist({
          ...state,
          tasks: merged.tasks,
          cloudTasks,
          outbox,
          conflicts: merged.conflicts.concat(results.filter((result) => result.status === "conflict").map((result) => ({ taskId: result.taskId, message: result.message || "雲端資料有衝突" }))),
          lastCloudSyncAt: new Date().toISOString(),
          lastCloudError: "",
        });
        const applied = results.filter((result) => result.status === "applied").length;
        const conflicts = results.filter((result) => result.status === "conflict").length;
        const failed = results.filter((result) => result.status === "failed").length;
        notify(`✓ 已同步 ${applied} 筆${conflicts ? `，${conflicts} 筆衝突` : ""}${failed ? `，${failed} 筆待重試` : ""}`, conflicts || failed ? "warn" : "ok");
        return true;
      } catch (error) {
        const message = cloudErrorMessage(error);
        persist({ ...state, lastCloudError: message });
        notify(message, "err");
        return false;
      } finally {
        cloudBusy = false;
        render();
      }
    }

    function bind() {
      documentRef.getElementById("galaxySyncBtn")?.addEventListener("click", () => { void syncCloud(); });
      documentRef.getElementById("galaxyImportBtn")?.addEventListener("click", () => { void loadCloud(); });
      const csvFileInput = documentRef.getElementById("galaxyCsvFileInput");
      documentRef.getElementById("galaxyCsvImportBtn")?.addEventListener("click", () => { csvFileInput?.click(); });
      csvFileInput?.addEventListener("change", (event) => {
        const file = event?.target?.files?.[0] || event?.currentTarget?.files?.[0];
        if (file) void importFile(file);
        if (event?.target) event.target.value = "";
      });
      documentRef.getElementById("galaxyExportCsvBtn")?.addEventListener("click", () => {
        try { exportTasksCsv(state.tasks, documentRef); notify("✓ 已匯出 CSV"); } catch (error) { notify(error.message || "CSV 匯出失敗", "err"); }
      });
      documentRef.getElementById("galaxyLogSearch")?.addEventListener("input", (event) => { filter.query = event.target.value; render(); });
      documentRef.getElementById("galaxyLogStatusFilter")?.addEventListener("change", (event) => { filter.status = event.target.value; render(); });
      documentRef.getElementById("galaxyLogClearBtn")?.addEventListener("click", () => {
        if (!state.tasks.length) { notify("目前沒有本機清單", "warn"); return; }
        if (!root.confirm?.("確定要清除這部 Surface 的 Galaxy 清單及完成記錄嗎？")) return;
        state = writeStoredState(storage, { tasks: [], cloudTasks: [], outbox: [], conflicts: [], issues: [], cloudReadOnly: false, importedAt: "", importedFileModifiedAt: 0, snapshotSource: "", sourceName: "", sourceSheet: "", lastCloudSyncAt: "", lastCloudError: "" });
        notify("已清除本機 Galaxy 清單");
        render();
      });
      documentRef.getElementById("galaxyLogList")?.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-galaxy-action]");
        if (!button) return;
        const id = button.dataset.galaxyId;
        const action = button.dataset.galaxyAction;
        if (action === "complete") {
          const current = state.tasks.find((task) => task.id === id);
          const completedDate = isoFromDate(new Date());
          if (current && queueTaskMutation(id, { status: "done", completedDate }, current.completedDate)) notify("✓ 已記錄取 Log 日期（待同步）");
        } else if (action === "no-log") {
          const current = state.tasks.find((task) => task.id === id);
          const checkedDate = isoFromDate(new Date());
          if (current && queueTaskMutation(id, { status: "no_log", completedDate: checkedDate }, current.completedDate)) notify("已記錄沒有當天 Log（待同步）");
        } else if (action === "reopen") {
          const current = state.tasks.find((task) => task.id === id);
          if (current && queueTaskMutation(id, { status: "pending", completedDate: "" }, current.completedDate)) notify("已改回未取（待同步）");
        }
        render();
      });
      root.addEventListener?.("online", () => { render(); void loadCloud({ silent: true }); });
      root.addEventListener?.("offline", render);
    }

    async function importFile(file) {
      if (busy) return;
      busy = true;
      notify("讀取清單中…");
      try {
        const parsed = await parseWorkbookFile(file);
        parsed.sourceName = file.name || "";
        const beforeTasks = state.tasks.slice();
        const beforeById = new Map(beforeTasks.map((task) => [task.id, task]));
        const isCsv = /\.csv$/i.test(file.name || "");
        const snapshot = isCsv ? mergeImportedSnapshot(state, parsed, file.lastModified || 0) : { replaced: false, state, reason: "workbook-merge" };
        if (isCsv && !snapshot.replaced) {
          notify("這份 CSV 比本機資料舊或相同，已保留本機資料", "warn");
          return;
        }
        const importedAt = snapshot.state.importedAt || new Date().toISOString();
        const merged = isCsv ? { tasks: snapshot.state.tasks, added: snapshot.state.tasks.length, updated: 0 } : mergeImportedTasks(state.tasks, parsed.tasks, { importedAt, sourceName: file.name || "" });
        let nextState = isCsv ? { ...snapshot.state, outbox: [] } : { ...state, tasks: merged.tasks, issues: parsed.issues, importedAt, sourceName: file.name || "", sourceSheet: parsed.sheetName || "" };
        for (const incoming of parsed.tasks || []) {
          const previous = beforeById.get(incoming.id);
          const changed = !previous
            || text(previous.completedDate) !== text(incoming.completedDate)
            || text(previous.targetDate) !== text(incoming.targetDate)
            || text(previous.fullSerial) !== text(incoming.fullSerial);
          if (!changed) continue;
          nextState = createMutationOutbox(nextState, {
            taskId: incoming.id,
            patch: {
              fullSerial: incoming.fullSerial,
              serialLast4: incoming.serialLast4 || serialLast4(incoming.fullSerial),
              targetDate: incoming.targetDate,
              completedDate: incoming.completedDate || "",
              status: incoming.status || (incoming.completedDate ? "done" : "pending"),
              groupIndex: Number(incoming.groupIndex) || 0,
              rowIndex: Number(incoming.rowIndex) || 0,
              duplicateIndex: Number(incoming.duplicateIndex) || 0,
            },
            baseCompletedDate: previous?.completedDate || "",
          });
        }
        persist(nextState);
        const ignored = parsed.ignoredSheets?.length ? `，跳過 ${parsed.ignoredSheets.length} 張其他工作表` : "";
        filter.status = "pending";
        const pendingCount = pendingMutations(nextState).length;
        if (pendingCount && isOnline() && transportAvailable()) {
          notify("檔案已讀取，正在同步至雲端…");
          if (await waitForCloudIdle()) await syncCloud();
          else notify("雲端仍在讀取，資料已保存本機，稍後按「同步至雲端」", "warn");
        } else if (pendingCount) {
          notify(`✓ 已保存本機：新增 ${merged.added} 筆、更新 ${merged.updated} 筆；返公司有網絡時按「同步至雲端」${ignored}`, "warn");
        } else {
          notify(`✓ 清單沒有新變更${ignored}`);
        }
      } catch (error) {
        notify(error.message || "匯入失敗", "err");
      } finally {
        busy = false;
        render();
      }
    }

    function render() {
      const page = documentRef?.getElementById?.("galaxyLogPage");
      if (!page || !mounted) return;
      const tasks = filterTasks(state.tasks, filter);
      const counts = state.tasks.reduce((result, task) => { result[task.status] = (result[task.status] || 0) + 1; return result; }, {});
      const summary = documentRef.getElementById("galaxyLogSummary");
      const importedAt = formatLocalDateTime(state.importedAt);
      const cloudSyncAt = formatLocalDateTime(state.lastCloudSyncAt);
      const pendingCount = pendingMutations(state).length;
      if (summary) summary.textContent = `全部 ${state.tasks.length} · 未取 ${counts.pending || 0} · 已取 ${counts.done || 0} · 沒有當天 Log ${counts.no_log || 0} · 需跟進 ${counts.needs_review || 0}${importedAt ? ` · 最後匯入 ${importedAt}` : ""}${cloudSyncAt ? ` · 最後同步 ${cloudSyncAt}` : ""}${pendingCount ? ` · 待同步 ${pendingCount}` : ""}`;
      const offline = documentRef.getElementById("galaxyLogOfflineBadge");
      if (offline) {
        const offlineMode = !isOnline();
        const cloudError = Boolean(state.lastCloudError);
        offline.textContent = offlineMode ? "離線模式" : cloudError ? "雲端讀取失敗" : state.cloudReadOnly ? "雲端只讀" : pendingCount ? "有本機變更" : transportAvailable() ? "雲端已連接" : "本機資料已保存";
        offline.className = offlineMode || cloudError ? "offline" : state.cloudReadOnly ? "pending" : pendingCount ? "pending" : "local";
      }
      const syncButton = documentRef.getElementById("galaxySyncBtn");
      if (syncButton) {
        syncButton.disabled = cloudBusy || !isOnline() || !transportAvailable();
        syncButton.textContent = cloudBusy ? "同步中…" : pendingCount ? `同步至雲端（${pendingCount}）` : "同步至雲端";
      }
      const importButton = documentRef.getElementById("galaxyImportBtn");
      if (importButton) {
        importButton.disabled = cloudBusy || !isOnline() || !transportAvailable();
        importButton.textContent = cloudBusy ? "讀取中…" : "下載雲端資料";
      }
      const search = documentRef.getElementById("galaxyLogSearch"); if (search && search.value !== filter.query) search.value = filter.query;
      const statusSelect = documentRef.getElementById("galaxyLogStatusFilter"); if (statusSelect) statusSelect.value = filter.status;
      const issueHost = documentRef.getElementById("galaxyLogIssues");
      if (issueHost) {
        const conflictMarkup = state.conflicts.length ? `<details class="galaxy-issues conflicts" open><summary>同步衝突：${state.conflicts.length} 筆需要留意</summary><div>${state.conflicts.slice(0, 40).map((conflict) => `<div>${escapeHtml(conflict.message || `Task ${conflict.taskId || ""} 的雲端資料與本機不同`)}</div>`).join("")}</div></details>` : "";
        const issueMarkup = state.issues.length ? `<details class="galaxy-issues"><summary>匯入檢查：${state.issues.length} 項需要留意</summary><div>${state.issues.slice(0, 40).map((issue) => `<div>第 ${escapeHtml(issue.row)} 行：${escapeHtml(issue.message)}${issue.value ? `（${escapeHtml(issue.value)}）` : ""}</div>`).join("")}${state.issues.length > 40 ? "<div>其餘問題已省略，請修正原檔後重新匯入。</div>" : ""}</div></details>` : "";
        issueHost.innerHTML = conflictMarkup + issueMarkup;
      }
      const list = documentRef.getElementById("galaxyLogList");
      if (!list) return;
      if (!tasks.length) {
        list.innerHTML = state.tasks.length ? `<div class="galaxy-empty">沒有符合目前篩選的任務。</div>` : `<div class="galaxy-empty"><strong>尚未有 Galaxy 清單</strong><span>按「下載雲端資料」讀取 Google Sheet；之後帶 Surface 到現場即可離線使用。</span></div>`;
        return;
      }
      list.innerHTML = tasks.map((task) => `<article class="galaxy-task-card ${escapeHtml(task.status)}">
        <div class="galaxy-task-main">
          <div class="galaxy-task-serial">${escapeHtml(task.serialLast4 || serialLast4(task.fullSerial))} <span>完整 SN ${escapeHtml(task.fullSerial)}</span>${task.duplicateIndex ? '<em>疑似重覆</em>' : ""}</div>
          <div class="galaxy-task-target">指定 Log 日期 <strong>${escapeHtml(task.targetDate.replace(/-/g, "/"))}</strong></div>
          ${task.note ? `<div class="galaxy-task-note">${escapeHtml(task.note)}</div>` : ""}
        </div>
        <div class="galaxy-task-state"><span class="galaxy-state-badge ${escapeHtml(task.status)}">${escapeHtml(STATUS_LABELS[task.status] || task.status)}</span>${task.completedDate ? `<span class="galaxy-complete-date">${task.status === "no_log" ? "檢查日期" : "取 Log"}：${escapeHtml(task.completedDate.replace(/-/g, "/"))}</span>` : ""}</div>
        <div class="galaxy-task-actions">${task.status === "done" || task.status === "no_log" ? `<button class="galaxy-btn small" data-galaxy-action="reopen" data-galaxy-id="${escapeHtml(task.id)}" type="button">改回未取</button>` : `<button class="galaxy-btn complete" data-galaxy-action="complete" data-galaxy-id="${escapeHtml(task.id)}" type="button">✓ 已取 Log</button><button class="galaxy-btn no-log" data-galaxy-action="no-log" data-galaxy-id="${escapeHtml(task.id)}" type="button">沒有當天 Log</button>`}</div>
      </article>`).join("");
    }

    function mount() {
      const page = documentRef?.getElementById?.("galaxyLogPage");
      if (!page) return false;
      if (!mounted) {
        page.innerHTML = shell();
        bind();
        mounted = true;
      }
      if (isOnline() && transportAvailable()) void loadCloud({ silent: true });
      render();
      return true;
    }

    return {
      mount,
      render,
      importFile,
      loadCloud,
      syncCloud,
      getState: () => normalizeState(state),
      setFilter: (next) => { filter = { ...filter, ...(next || {}) }; render(); },
    };
  }

  return {
    STORAGE_KEY,
    STATUS_LABELS,
    NO_LOG_MARKER,
    buildTaskId,
    completeTask,
    createMutationOutbox,
    createApplication,
    exportTasksXlsx,
    exportTasksCsv,
    filterTasks,
    formatLocalDateTime,
    mergeCloudTasks,
    mergeImportedSnapshot,
    mergeImportedTasks,
    normalizeDate,
    normalizeSerial,
    parseCsvText,
    parseGalaxyColumnGroups,
    parseGalaxyRows,
    parseWorkbookFile,
    pendingMutations,
    readStoredState,
    reopenTask,
    serialLast4,
    tasksToColumnGroups,
    tasksToCsv,
    tasksToRows,
    writeStoredState,
  };
}));
