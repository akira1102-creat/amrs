(function attachAmrsMgmCheckRequest(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AmrsMgmCheckRequest = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createModule(root) {
  "use strict";

  const STORAGE_KEY = "_amrs_mgm_check_request_v1";
  const EDITABLE_FIELDS = ["serialNo", "aaTag", "boxId", "vaultId", "machineStatus", "cardStatus", "remark"];
  const NEW_FIELDS = ["eventDate", "eventTime", "endTime", "table", "serialNo", "aaTag", "boxId", "vaultId", "eventDetails", "machineStatus", "cardStatus", "remark"];
  const SHEETS = ["MGM Macau", "MGM Cotai"];
  const PENDING_FIELD_LABELS = {
    serialNo: "Serial NO.", aaTag: "AA Tag", boxId: "BOX ID", vaultId: "Vault ID",
    machineStatus: "機台檢查狀況", cardStatus: "實牌檢查狀況", remark: "備注",
  };

  function text(value) { return String(value == null ? "" : value).trim(); }
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    }[character]));
  }
  function own(object, key) { return Object.prototype.hasOwnProperty.call(object || {}, key); }
  function normalizeSerial(value) {
    const raw = text(value).replace(/^SN\s*/i, "").replace(/^'+/, "");
    if (!raw) return "";
    const digits = raw.replace(/\D/g, "");
    return digits ? String(Number(digits.slice(-4))) : raw.toUpperCase();
  }
  function normalizeAaTag(value) {
    const digits = text(value).toUpperCase().replace(/^TAE/, "").replace(/\D/g, "").slice(-4);
    return digits ? `TAE${digits.padStart(4, "0")}` : "";
  }
  const FOLLOWUP_OPTIONS = {
    machineStatus: [
      { key: "pending", label: "待跟進", value: "未CHECK" },
      { key: "no-machine-data", label: "無機台資料", value: "無機台資料" },
      { key: "done", label: "已檢查", value: "已CHECK" },
    ],
    cardStatus: [
      { key: "pending", label: "待跟進", value: "未CHECK" },
      { key: "done", label: "已檢查", value: "已CHECK" },
      { key: "broken-card", label: "已碎牌", value: "已碎牌" },
    ],
  };
  function isFollowupChecked(value) { return /^已\s*(?:check|檢查)$/i.test(text(value)); }
  function followupChoice(field, value) {
    if (isFollowupChecked(value)) return "done";
    const normalized = text(value);
    if (field === "machineStatus" && normalized === "無機台資料") return "no-machine-data";
    if (field === "cardStatus" && normalized === "已碎牌") return "broken-card";
    return "pending";
  }
  function followupOption(field, choice) { return (FOLLOWUP_OPTIONS[field] || []).find((option) => option.key === choice) || null; }
  function followupLabel(value) {
    if (isFollowupChecked(value)) return "已檢查";
    if (text(value) === "無機台資料") return "無機台資料";
    if (text(value) === "已碎牌") return "已碎牌";
    return "待跟進";
  }
  function requestStatus(request) {
    return followupChoice("machineStatus", request?.machineStatus) !== "pending"
      && followupChoice("cardStatus", request?.cardStatus) !== "pending" ? "done" : "pending";
  }
  function requestEventStamp(request = {}) {
    const dateMatch = text(request.eventDate).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (!dateMatch) return Number.NEGATIVE_INFINITY;
    const [, yearText, monthText, dayText] = dateMatch;
    const year = Number(yearText), month = Number(monthText), day = Number(dayText);
    const timeMatch = text(request.eventTime).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    const hour = timeMatch ? Number(timeMatch[1]) : 0;
    const minute = timeMatch ? Number(timeMatch[2]) : 0;
    const second = timeMatch && timeMatch[3] ? Number(timeMatch[3]) : 0;
    const stamp = Date.UTC(year, month - 1, day, hour, minute, second);
    const parsed = new Date(stamp);
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return Number.NEGATIVE_INFINITY;
    return stamp;
  }
  function hash(value) {
    let result = 2166136261;
    for (const character of String(value)) { result ^= character.charCodeAt(0); result = Math.imul(result, 16777619); }
    return (result >>> 0).toString(16).padStart(8, "0");
  }
  function tagMaps(aaTags = []) {
    const aaBySerial = new Map();
    const serialByAa = new Map();
    (Array.isArray(aaTags) ? aaTags : []).forEach((item) => {
      const serialNo = normalizeSerial(item?.serialNo);
      const aaTag = normalizeAaTag(item?.aaTag);
      if (serialNo && aaTag) { aaBySerial.set(serialNo, aaTag); serialByAa.set(aaTag, serialNo); }
    });
    return { aaBySerial, serialByAa };
  }
  function rowVersion(row = []) { return hash(Array.from({ length: 12 }, (_, index) => text(row[index])).join("\u0000")); }

  function parseRequestRows({ rows = [], sheetName = "", aaTags = [] } = {}) {
    const values = Array.isArray(rows) ? rows : [];
    const { aaBySerial, serialByAa } = tagMaps(aaTags);
    return values.slice(1).map((row, index) => {
      const cells = Array.from({ length: 13 }, (_, column) => text(Array.isArray(row) ? row[column] : ""));
      if (!cells.slice(0, 12).some(Boolean)) return null;
      const sourceSerialNo = normalizeSerial(cells[4]);
      const sourceAaTag = normalizeAaTag(cells[5]);
      const serialNo = sourceSerialNo || serialByAa.get(sourceAaTag) || "";
      const aaTag = sourceAaTag || aaBySerial.get(sourceSerialNo) || "";
      const request = {
        id: `${sheetName}:${index + 2}`,
        sheetName: text(sheetName),
        rowNumber: index + 2,
        eventDate: cells[0], eventTime: cells[1], endTime: cells[2], table: cells[3],
        serialNo, aaTag, sourceSerialNo, sourceAaTag,
        serialResolved: !sourceSerialNo && !!serialNo,
        aaTagResolved: !sourceAaTag && !!aaTag,
        boxId: cells[6], vaultId: cells[7], eventDetails: cells[8],
        machineStatus: cells[9], cardStatus: cells[10], remark: cells[11],
        version: rowVersion(cells),
      };
      request.status = requestStatus(request);
      return request;
    }).filter(Boolean);
  }

  function normalizeRequest(request = {}) {
    const result = { ...request };
    result.id = text(result.id) || `${text(result.sheetName)}:${Number(result.rowNumber)}`;
    result.sheetName = text(result.sheetName);
    result.rowNumber = Number(result.rowNumber) || 0;
    result.serialNo = normalizeSerial(result.serialNo);
    result.aaTag = normalizeAaTag(result.aaTag);
    EDITABLE_FIELDS.slice(2).forEach((field) => { result[field] = text(result[field]); });
    result.status = requestStatus(result);
    result.version = text(result.version);
    return result;
  }

  function normalizeState(value = {}) {
    return {
      requests: (Array.isArray(value.requests) ? value.requests : []).map(normalizeRequest),
      cloudRequests: (Array.isArray(value.cloudRequests) ? value.cloudRequests : []).map(normalizeRequest),
      aaTags: Array.isArray(value.aaTags) ? value.aaTags.map((item) => ({ serialNo: normalizeSerial(item?.serialNo), aaTag: normalizeAaTag(item?.aaTag) })).filter((item) => item.serialNo && item.aaTag) : [],
      outbox: Array.isArray(value.outbox) ? value.outbox.filter((item) => item && text(item.requestId)) : [],
      conflicts: Array.isArray(value.conflicts) ? value.conflicts : [],
      lastDownloadedAt: text(value.lastDownloadedAt),
      lastSyncAt: text(value.lastSyncAt),
      lastCloudError: text(value.lastCloudError),
    };
  }

  function readStoredState(storage) {
    try { return normalizeState(JSON.parse(storage?.getItem?.(STORAGE_KEY) || "{}")); }
    catch { storage?.removeItem?.(STORAGE_KEY); return normalizeState(); }
  }
  function writeStoredState(storage, value) {
    const state = normalizeState(value);
    storage?.setItem?.(STORAGE_KEY, JSON.stringify(state));
    return state;
  }

  function fieldValue(value, field) { return field === "serialNo" ? normalizeSerial(value) : field === "aaTag" ? normalizeAaTag(value) : text(value); }

  function stageNewRequest(value, draft = {}, updatedAt = Date.now()) {
    const state = normalizeState(value);
    const sheetName = text(draft.sheetName);
    if (!SHEETS.includes(sheetName)) throw new Error("請選擇 MGM Macau 或 MGM Cotai");
    const row = {};
    NEW_FIELDS.forEach((field) => { row[field] = fieldValue(draft[field], field); });
    const maps = tagMaps(state.aaTags);
    if (row.serialNo && !row.aaTag) row.aaTag = maps.aaBySerial.get(row.serialNo) || "";
    if (row.aaTag && !row.serialNo) row.serialNo = maps.serialByAa.get(row.aaTag) || "";
    if (!row.eventDate) throw new Error("請填寫事發日期");
    if (!row.eventTime) throw new Error("請填寫事發時間");
    if (!row.table) throw new Error("請填寫 Table");
    if (!row.eventDetails) throw new Error("請填寫事件詳情");
    const stamp = Number(updatedAt) || Date.now();
    const mutationId = `mgm-check-create-${hash(`${sheetName}|${stamp}|${row.eventDate}|${row.eventTime}|${row.table}`)}`;
    const requestId = `local:${mutationId}`;
    const request = normalizeRequest({
      id: requestId, sheetName, rowNumber: 0, ...row,
      sourceSerialNo: row.serialNo, sourceAaTag: row.aaTag,
      serialResolved: false, aaTagResolved: false, version: "", localOnly: true,
    });
    return normalizeState({
      ...state,
      requests: [request, ...state.requests],
      outbox: [...state.outbox, { kind: "create", mutationId, requestId, sheetName, row, updatedAt: stamp }],
    });
  }

  function applyDraft(value, requestId, draft = {}, updatedAt = Date.now()) {
    const state = normalizeState(value);
    const current = state.requests.find((request) => request.id === requestId);
    if (!current) return state;
    const base = state.cloudRequests.find((request) => request.id === requestId) || current;
    const candidate = { ...current };
    EDITABLE_FIELDS.forEach((field) => { if (own(draft, field)) candidate[field] = fieldValue(draft[field], field); });
    const maps = tagMaps(state.aaTags);
    if (own(draft, "serialNo") && candidate.serialNo && !own(draft, "aaTag")) candidate.aaTag = maps.aaBySerial.get(candidate.serialNo) || candidate.aaTag;
    if (own(draft, "aaTag") && candidate.aaTag && !own(draft, "serialNo")) candidate.serialNo = maps.serialByAa.get(candidate.aaTag) || candidate.serialNo;
    candidate.status = requestStatus(candidate);
    const stagedCreate = state.outbox.find((item) => item.requestId === requestId && item.kind === "create");
    if (stagedCreate) {
      const row = { ...stagedCreate.row };
      NEW_FIELDS.forEach((field) => { row[field] = fieldValue(candidate[field], field); });
      candidate.sourceSerialNo = candidate.serialNo;
      candidate.sourceAaTag = candidate.aaTag;
      return normalizeState({
        ...state,
        requests: state.requests.map((request) => request.id === requestId ? candidate : request),
        outbox: state.outbox.map((item) => item.requestId === requestId ? { ...item, row, updatedAt: Number(updatedAt) || Date.now() } : item),
        conflicts: state.conflicts.filter((item) => item.requestId !== requestId),
      });
    }
    const patch = {};
    EDITABLE_FIELDS.forEach((field) => {
      const desired = fieldValue(candidate[field], field);
      const original = fieldValue(field === "serialNo" ? (base.sourceSerialNo ?? base.serialNo) : field === "aaTag" ? (base.sourceAaTag ?? base.aaTag) : base[field], field);
      if (desired !== original) patch[field] = desired;
    });
    const outbox = state.outbox.filter((item) => item.requestId !== requestId);
    if (Object.keys(patch).length) outbox.push({
      mutationId: text(state.outbox.find((item) => item.requestId === requestId)?.mutationId) || `mgm-check-${hash(`${requestId}|${updatedAt}`)}`,
      requestId,
      sheetName: base.sheetName,
      rowNumber: base.rowNumber,
      baseVersion: base.version,
      patch,
      updatedAt: Number(updatedAt) || Date.now(),
    });
    return normalizeState({ ...state, requests: state.requests.map((request) => request.id === requestId ? candidate : request), outbox, conflicts: state.conflicts.filter((item) => item.requestId !== requestId) });
  }

  function mergeCloudSnapshot(value, response = {}, downloadedAt = Date.now()) {
    const previous = normalizeState(value);
    const cloudRequests = (Array.isArray(response.requests) ? response.requests : []).map(normalizeRequest);
    const next = normalizeState({
      ...previous,
      requests: cloudRequests,
      cloudRequests,
      aaTags: Array.isArray(response.aaTags) ? response.aaTags : previous.aaTags,
      lastDownloadedAt: new Date(downloadedAt).toISOString(),
      lastCloudError: "",
      conflicts: [],
    });
    const missing = [];
    let merged = next;
    previous.outbox.forEach((mutation) => {
      if (mutation.kind === "create") {
        const local = previous.requests.find((request) => request.id === mutation.requestId);
        if (local && !merged.requests.some((request) => request.id === local.id)) merged.requests.unshift(local);
        return;
      }
      if (!merged.requests.some((request) => request.id === mutation.requestId)) {
        const local = previous.requests.find((request) => request.id === mutation.requestId);
        if (local) merged.requests.push(local);
        missing.push({ requestId: mutation.requestId, message: "雲端已找不到這筆記錄" });
        return;
      }
      merged = applyDraft({ ...merged, outbox: previous.outbox }, mutation.requestId, mutation.patch, mutation.updatedAt);
    });
    merged.outbox = previous.outbox;
    merged.conflicts = missing;
    return normalizeState(merged);
  }

  function filterRequests(requests = [], filter = {}) {
    const query = text(filter.query);
    const status = text(filter.status || "all");
    const site = text(filter.site || "all");
    const aaQuery = /^TAE/i.test(query) ? normalizeAaTag(query) : "";
    const serialQuery = /^\d{1,4}$/.test(query) ? normalizeSerial(query) : "";
    const freeQuery = !aaQuery && !serialQuery ? query.toLowerCase() : "";
    return (Array.isArray(requests) ? requests : []).filter((request) => {
      const machineChecked = followupChoice("machineStatus", request.machineStatus) !== "pending";
      const cardChecked = followupChoice("cardStatus", request.cardStatus) !== "pending";
      const statusMatches = status === "all"
        || (status === "pending" && (!machineChecked || !cardChecked))
        || (status === "done" && machineChecked && cardChecked)
        || (status === "machine-pending" && !machineChecked)
        || (status === "machine-done" && machineChecked)
        || (status === "card-pending" && !cardChecked)
        || (status === "card-done" && cardChecked);
      if (!statusMatches) return false;
      if (site !== "all" && request.sheetName !== site) return false;
      if (!query) return true;
      if (aaQuery) return normalizeAaTag(request.aaTag) === aaQuery;
      if (serialQuery) return normalizeSerial(request.serialNo) === serialQuery;
      return [request.table, request.boxId, request.vaultId].some((value) => text(value).toLowerCase().includes(freeQuery));
    }).map((request, index) => ({ request, index, stamp: requestEventStamp(request) }))
      .sort((left, right) => right.stamp - left.stamp || left.index - right.index)
      .map(({ request }) => request);
  }

  function shell() {
    return `<div class="mgm-check-shell">
      <header class="mgm-check-head"><div><h1>MGM Check Request</h1><p>MGM Macau／MGM Cotai · 直接讀取及儲存最新雲端資料</p></div><div class="mgm-check-actions"><button id="mgmCheckAddBtn" class="mgm-check-btn add" type="button">＋ 新增檢查請求</button><button id="mgmCheckSyncBtn" class="mgm-check-btn sync" type="button">儲存資料</button><button id="mgmCheckDownloadBtn" class="mgm-check-btn primary" type="button">重新載入</button></div></header>
      <div class="mgm-check-status"><span id="mgmCheckSummary">尚未下載清單</span><button id="mgmCheckPendingBadge" type="button" hidden>待儲存變更</button><strong id="mgmCheckConnection">本機未有資料</strong><span id="mgmCheckMessage"></span></div>
      <div id="mgmCheckPendingPanel" hidden></div>
      <form id="mgmCheckNewForm" class="mgm-check-new" hidden>
        <div class="mgm-check-new-title"><strong>新增客戶檢查請求</strong><span>加入後按「儲存資料」寫入雲端</span></div>
        <div class="mgm-check-new-grid">
          <label><span>場地 *</span><select id="mgmCheckNewSheet"><option>MGM Macau</option><option>MGM Cotai</option></select></label>
          <label><span>事發日期 *</span><input id="mgmCheckNewDate" type="date" required></label>
          <label><span>事發時間 *</span><input id="mgmCheckNewTime" type="time" required></label>
          <label><span>結束時間</span><input id="mgmCheckNewEndTime" type="time"></label>
          <label><span>Table *</span><input id="mgmCheckNewTable" autocomplete="off" required></label>
          <label><span>Serial NO.</span><input id="mgmCheckNewSerial" inputmode="numeric" autocomplete="off"></label>
          <label><span>AA Tag</span><input id="mgmCheckNewAaTag" autocomplete="off"></label>
          <label><span>BOX ID</span><input id="mgmCheckNewBox" autocomplete="off"></label>
          <label><span>Vault ID</span><input id="mgmCheckNewVault" autocomplete="off"></label>
          <label class="wide"><span>事件詳情 *</span><textarea id="mgmCheckNewDetails" rows="3" required></textarea></label>
        </div>
        <div class="mgm-check-editor-actions"><button id="mgmCheckNewCancel" type="button">取消</button><button class="save" type="submit">加入待儲存</button></div>
      </form>
      <div class="mgm-check-filters"><input id="mgmCheckSearch" type="search" inputmode="search" autocomplete="off" placeholder="輸入 SN、AA Tag、Table 或 BOX ID"><select id="mgmCheckSiteFilter"><option value="all">場地篩選</option><option>MGM Macau</option><option>MGM Cotai</option></select><select id="mgmCheckStatusFilter"><option value="all">全部</option><option value="pending">未完成</option><option value="done">已完成</option><option value="machine-pending">機台未完成</option><option value="machine-done">機台已完成</option><option value="card-pending">實牌未完成</option><option value="card-done">實牌已完成</option></select></div>
      <div id="mgmCheckConflicts"></div><div id="mgmCheckList" class="mgm-check-list"></div><button id="mgmCheckMoreBtn" class="mgm-check-more" type="button" hidden>顯示更多</button>
    </div>`;
  }

  function formatDateTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-HK", { hour12: false });
  }

  function createApplication(options = {}) {
    const documentRef = options.document || root?.document;
    const storage = options.storage || root?.localStorage;
    const transport = options.transport || null;
    const online = typeof options.isOnline === "function" ? options.isOnline : () => root?.navigator?.onLine !== false;
    const notify = typeof options.toast === "function" ? options.toast : () => {};
    let state = readStoredState(storage);
    let mounted = false;
    let busy = false;
    let editingId = "";
    let creating = false;
    let searchTimer = null;
    let visibleLimit = 50;
    let filter = { query: "", site: "all", status: "all" };
    let pendingPanelOpen = state.outbox.length > 0;
    let pendingSelectedIds = new Set();

    function persist(next) { state = writeStoredState(storage, next); return state; }
    function setMessage(message, kind = "") {
      const host = documentRef?.getElementById?.("mgmCheckMessage");
      if (host) { host.textContent = message; host.dataset.kind = kind; }
    }
    function transportAvailable() { return !!transport && typeof transport.get === "function" && typeof transport.post === "function"; }

    async function loadCloud({ silent = false } = {}) {
      if (busy || !online() || !transport || typeof transport.get !== "function") return false;
      busy = true; render(); if (!silent) setMessage("正在下載雲端資料…");
      try {
        const response = await transport.get("action=mgmCheckRequests&refresh=1", { timeoutMs: 30_000 });
        if (!response?.success || !Array.isArray(response.requests)) throw new Error(response?.message || "下載失敗");
        persist(mergeCloudSnapshot(state, response, Date.now()));
        setMessage(`已下載 ${state.requests.length} 筆`, "ok");
        if (!silent) notify(`✓ 已下載 ${state.requests.length} 筆 MGM Check Request`);
        return true;
      } catch (error) {
        persist({ ...state, lastCloudError: text(error?.message || "下載失敗") });
        setMessage(state.requests.length ? "下載失敗，繼續使用本機資料" : "未能下載，請連線後重試", "err");
        if (!silent) notify("MGM Check Request 下載失敗", "err");
        return false;
      } finally { busy = false; render(); }
    }

    async function syncCloud() {
      if (busy || !state.outbox.length || !online() || !transportAvailable()) return false;
      busy = true; render(); setMessage("正在儲存資料…");
      const mutations = state.outbox.map((item) => ({ ...item }));
      const requestId = `mgm-check-sync-${hash(mutations.map((item) => item.mutationId).sort().join("|"))}`;
      try {
        const response = await transport.post({ action: "syncMgmCheckRequests", requestId, mutations }, { requestId, timeoutMs: 30_000 });
        if (!response?.success || !Array.isArray(response.results)) throw new Error(response?.message || "同步失敗");
        const applied = new Set(response.results.filter((item) => item.status === "applied").map((item) => text(item.mutationId)));
        const conflicts = response.results.filter((item) => item.status !== "applied");
        const remaining = state.outbox.filter((item) => !applied.has(text(item.mutationId)));
        let next = mergeCloudSnapshot({ ...state, outbox: remaining }, response, Date.now());
        next = { ...next, outbox: remaining, conflicts, lastSyncAt: new Date().toISOString() };
        persist(next);
        setMessage(conflicts.length ? `${applied.size} 筆已儲存，${conflicts.length} 筆需要重新載入檢查` : `已儲存 ${applied.size} 筆`, conflicts.length ? "warn" : "ok");
        notify(conflicts.length ? "部分記錄有衝突，未有覆蓋雲端資料" : `✓ 已儲存 ${applied.size} 筆` , conflicts.length ? "err" : undefined);
        return conflicts.length === 0;
      } catch (error) {
        setMessage("儲存失敗，未儲存變更已保留", "err"); notify("儲存失敗，變更沒有遺失", "err"); return false;
      } finally { busy = false; render(); }
    }

    function editorMarkup(request) {
      const field = (name, label, multiline = false) => `<label><span>${label}</span>${multiline ? `<textarea data-mgm-check-field="${name}" rows="2">${escapeHtml(request[name])}</textarea>` : `<input data-mgm-check-field="${name}" value="${escapeHtml(request[name])}">`}</label>`;
      return `<div class="mgm-check-editor">
        <div class="mgm-check-editor-grid">${field("serialNo", "Serial NO.")}${field("aaTag", "AA Tag")}${field("boxId", "BOX ID")}${field("vaultId", "Vault ID")}${field("machineStatus", "機台檢查狀況", true)}${field("cardStatus", "實牌檢查狀況", true)}${field("remark", "備注", true)}</div>
        <div class="mgm-check-editor-actions"><button data-mgm-check-action="cancel" type="button">取消</button><button class="save" data-mgm-check-action="save" type="button">加入待儲存</button></div>
      </div>`;
    }

    function requestMarkup(request) {
      const pending = state.outbox.some((item) => item.requestId === request.id);
      const cardState = [request.status === "done" ? "已完成" : "", pending ? "待儲存" : ""].filter(Boolean).join(" · ");
      const resolved = [request.serialResolved ? "SN 由 AA Tag 對照" : "", request.aaTagResolved ? "AA Tag 由 SN 對照" : ""].filter(Boolean).join(" · ");
      const eventDateTime = [request.eventDate, request.eventTime].filter(Boolean).join(" ") || "未有日期及時間";
      const followup = (field, label, value) => {
        const selected = followupChoice(field, value);
        const option = ({ key, label: optionLabel }) => `<button type="button" class="mgm-check-followup-option ${key}${selected === key ? " selected" : ""}" data-mgm-check-followup-field="${field}" data-mgm-check-followup-value="${key}" aria-pressed="${selected === key}">${optionLabel}</button>`;
        return `<div class="mgm-check-followup-control"><span>${label}</span><div class="mgm-check-followup-options">${(FOLLOWUP_OPTIONS[field] || []).map(option).join("")}</div></div>`;
      };
      return `<article class="mgm-check-card ${request.status}${pending ? " local-change" : ""}" data-mgm-check-id="${escapeHtml(request.id)}">
        <div class="mgm-check-card-top"><div class="mgm-check-identifiers"><strong>${escapeHtml(request.serialNo || "未有 SN")}</strong><span>↔</span><strong>${escapeHtml(request.aaTag || "未有 AA Tag")}</strong>${resolved ? `<small>${escapeHtml(resolved)}</small>` : ""}</div><span class="mgm-check-site">${escapeHtml(request.sheetName)}</span></div>
        <div class="mgm-check-datetime"><span>事發日期及時間</span><strong>${escapeHtml(eventDateTime)}</strong>${request.endTime ? `<small>結束 ${escapeHtml(request.endTime)}</small>` : ""}</div>
        <div class="mgm-check-location"><span>Table ${escapeHtml(request.table || "—")}</span><span>BOX ID ${escapeHtml(request.boxId || "—")}</span><span>Vault ID ${escapeHtml(request.vaultId || "—")}</span></div>
        <div class="mgm-check-event">${escapeHtml(request.eventDetails || "未有事件詳情")}</div>
        ${editingId === request.id ? editorMarkup(request) : `<div class="mgm-check-followup">${followup("machineStatus", "機台檢查狀況", request.machineStatus)}${followup("cardStatus", "實牌檢查狀況", request.cardStatus)}${request.remark ? `<p>${escapeHtml(request.remark)}</p>` : ""}</div><div class="mgm-check-card-actions">${cardState ? `<span class="mgm-check-state ${request.status}">${cardState}</span>` : ""}<button data-mgm-check-action="edit" type="button">修改資料</button></div>`}
      </article>`;
    }

    function pendingEntries() {
      const requestById = new Map(state.requests.map((request) => [request.id, request]));
      const cloudById = new Map(state.cloudRequests.map((request) => [request.id, request]));
      return state.outbox.map((mutation) => ({
        mutation,
        request: requestById.get(mutation.requestId),
        canDiscard: mutation.kind === "create" || cloudById.has(mutation.requestId),
      }));
    }

    function pendingChangeMarkup(entry) {
      const mutation = entry.mutation;
      const request = entry.request || {};
      const isCreate = mutation.kind === "create";
      const dateTime = [request.eventDate || mutation.row?.eventDate, request.eventTime || mutation.row?.eventTime].filter(Boolean).join(" ");
      const identifiers = [request.serialNo || mutation.row?.serialNo, request.aaTag || mutation.row?.aaTag].filter(Boolean).join(" ↔ ");
      const table = request.table || mutation.row?.table;
      const subtitle = [request.sheetName || mutation.sheetName, dateTime, table ? `Table ${table}` : "", identifiers].filter(Boolean).join(" · ");
      const changes = isCreate
        ? [["事件詳情", request.eventDetails || mutation.row?.eventDetails || "未填寫"]]
        : Object.entries(mutation.patch || {}).map(([field, value]) => [PENDING_FIELD_LABELS[field] || field, ["machineStatus", "cardStatus"].includes(field) ? followupLabel(value) : text(value) || "（清空）"]);
      const selected = pendingSelectedIds.has(mutation.requestId);
      return `<article class="mgm-check-pending-row${selected ? " selected" : ""}">
        <label class="mgm-check-pending-select"><input type="checkbox" data-mgm-check-pending-select="1" data-mgm-check-pending-id="${escapeHtml(mutation.requestId)}"${selected ? " checked" : ""}${entry.canDiscard ? "" : " disabled"}><span><strong>${isCreate ? "新增客戶檢查請求" : "修改檢查請求"}</strong><small>${escapeHtml(subtitle || "未有記錄資料")}</small></span></label>
        <div class="mgm-check-pending-changes">${changes.map(([label, value]) => `<span>${escapeHtml(label)}：${escapeHtml(value)}</span>`).join("")}</div>
        <button type="button" class="mgm-check-pending-delete" data-mgm-check-pending-action="delete-one" data-mgm-check-pending-id="${escapeHtml(mutation.requestId)}"${entry.canDiscard ? "" : " disabled"}>刪除此變更</button>
      </article>`;
    }

    function renderPendingPanel() {
      const panel = documentRef.getElementById("mgmCheckPendingPanel");
      if (!panel) return;
      const entries = pendingEntries();
      if (!entries.length || !pendingPanelOpen) { panel.hidden = true; panel.innerHTML = ""; return; }
      const removable = entries.filter((entry) => entry.canDiscard);
      const selectedCount = [...pendingSelectedIds].filter((requestId) => removable.some((entry) => entry.mutation.requestId === requestId)).length;
      const allSelected = removable.length > 0 && selectedCount === removable.length;
      panel.hidden = false;
      panel.innerHTML = `<section class="mgm-check-pending-panel-inner" aria-label="待儲存變更">
        <div class="mgm-check-pending-head"><div><strong>待儲存變更（${entries.length}）</strong><span>可查看每筆變更內容，或刪除後還原至最近雲端資料。</span></div><button type="button" data-mgm-check-pending-action="close">收起</button></div>
        <div class="mgm-check-pending-toolbar"><label><input type="checkbox" data-mgm-check-pending-select-all="1"${allSelected ? " checked" : ""}${removable.length ? "" : " disabled"}> 全選</label><span>已選 ${selectedCount} 筆</span><button type="button" data-mgm-check-pending-action="delete-selected"${selectedCount ? "" : " disabled"}>刪除選取</button></div>
        <div class="mgm-check-pending-list">${entries.map(pendingChangeMarkup).join("")}</div>
      </section>`;
    }

    function discardPendingChanges(requestIds = []) {
      const requestedIds = new Set((Array.isArray(requestIds) ? requestIds : []).map(text).filter(Boolean));
      if (!requestedIds.size) return 0;
      const cloudById = new Map(state.cloudRequests.map((request) => [request.id, request]));
      const mutationByRequestId = new Map(state.outbox.map((mutation) => [mutation.requestId, mutation]));
      const removableIds = new Set([...requestedIds].filter((requestId) => mutationByRequestId.get(requestId)?.kind === "create" || cloudById.has(requestId)));
      if (!removableIds.size) return 0;
      persist({
        ...state,
        requests: state.requests.flatMap((request) => {
          if (!removableIds.has(request.id)) return [request];
          const baseline = cloudById.get(request.id);
          return baseline ? [baseline] : [];
        }),
        outbox: state.outbox.filter((mutation) => !removableIds.has(mutation.requestId)),
        conflicts: state.conflicts.filter((conflict) => !removableIds.has(conflict.requestId)),
      });
      pendingSelectedIds = new Set([...pendingSelectedIds].filter((requestId) => !removableIds.has(requestId)));
      if (!state.outbox.length) pendingPanelOpen = false;
      return removableIds.size;
    }

    function render() {
      if (!mounted) return;
      const filtered = filterRequests(state.requests, filter);
      const pendingTotal = state.requests.filter((request) => request.status === "pending").length;
      const summary = documentRef.getElementById("mgmCheckSummary");
      if (summary) summary.textContent = `全部 ${state.requests.length} · 未完成 ${pendingTotal} · 已完成 ${state.requests.length - pendingTotal} · 待儲存 ${state.outbox.length}`;
      const pendingBadge = documentRef.getElementById("mgmCheckPendingBadge");
      if (pendingBadge) {
        const pendingCount = state.outbox.length;
        pendingBadge.hidden = !pendingCount;
        pendingBadge.disabled = !pendingCount;
        pendingBadge.textContent = `待儲存變更（${pendingCount}）`;
        pendingBadge.setAttribute("aria-expanded", String(pendingCount && pendingPanelOpen));
        pendingBadge.setAttribute("aria-label", pendingCount ? `開啟待儲存變更清單，共 ${pendingCount} 筆` : "沒有待儲存變更");
      }
      const connection = documentRef.getElementById("mgmCheckConnection");
      if (connection) connection.textContent = !online() ? "暫時離線" : state.lastCloudError ? "雲端讀取失敗" : state.requests.length ? "雲端最新資料" : "正在連接雲端";
      const sync = documentRef.getElementById("mgmCheckSyncBtn");
      if (sync) { sync.disabled = busy || !online() || !transportAvailable() || !state.outbox.length; sync.textContent = busy ? "處理中…" : state.outbox.length ? `儲存資料（${state.outbox.length}）` : "儲存資料"; }
      const download = documentRef.getElementById("mgmCheckDownloadBtn");
      if (download) { download.disabled = busy || !online() || !transport || typeof transport.get !== "function"; download.textContent = busy ? "載入中…" : "重新載入"; }
      const list = documentRef.getElementById("mgmCheckList");
      if (list) list.innerHTML = filtered.length ? filtered.slice(0, visibleLimit).map(requestMarkup).join("") : `<div class="mgm-check-empty"><strong>${state.requests.length ? "找不到符合條件的記錄" : "正在載入 MGM Check Request 清單"}</strong><span>${state.requests.length ? "請檢查 SN／AA Tag 或改為查看全部。" : "每次進入頁面都會自動載入最新雲端資料。"}</span></div>`;
      const more = documentRef.getElementById("mgmCheckMoreBtn");
      if (more) { more.hidden = filtered.length <= visibleLimit; more.textContent = `顯示更多（${Math.min(visibleLimit, filtered.length)} / ${filtered.length}）`; }
      const conflicts = documentRef.getElementById("mgmCheckConflicts");
      if (conflicts) conflicts.innerHTML = state.conflicts.length ? `<div class="mgm-check-conflict">${state.conflicts.length} 筆資料在雲端已有改動，未有覆蓋。請先重新載入再檢查。</div>` : "";
      const search = documentRef.getElementById("mgmCheckSearch"); if (search && search.value !== filter.query) search.value = filter.query;
      const site = documentRef.getElementById("mgmCheckSiteFilter"); if (site) site.value = filter.site;
      const status = documentRef.getElementById("mgmCheckStatusFilter"); if (status) status.value = filter.status;
      const form = documentRef.getElementById("mgmCheckNewForm"); if (form) form.hidden = !creating;
      const add = documentRef.getElementById("mgmCheckAddBtn"); if (add) { add.disabled = busy; add.textContent = creating ? "收起新增表格" : "＋ 新增檢查請求"; }
      renderPendingPanel();
    }

    function draftFromEditor() {
      const card = documentRef.getElementById("mgmCheckList");
      const result = {};
      card?.querySelectorAll?.(`[data-mgm-check-id="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(editingId) : editingId}"] [data-mgm-check-field]`).forEach((input) => { result[input.dataset.mgmCheckField] = input.value; });
      return result;
    }

    function bind() {
      documentRef.getElementById("mgmCheckAddBtn")?.addEventListener("click", () => {
        creating = !creating;
        if (creating) {
          const date = documentRef.getElementById("mgmCheckNewDate");
          if (date && !date.value) {
            const now = new Date();
            date.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
          }
        }
        render();
      });
      documentRef.getElementById("mgmCheckNewCancel")?.addEventListener("click", () => { creating = false; render(); });
      documentRef.getElementById("mgmCheckNewForm")?.addEventListener("submit", (event) => {
        event.preventDefault();
        try {
          const value = (id) => documentRef.getElementById(id)?.value || "";
          const next = stageNewRequest(state, {
            sheetName: value("mgmCheckNewSheet"), eventDate: value("mgmCheckNewDate"), eventTime: value("mgmCheckNewTime"), endTime: value("mgmCheckNewEndTime"),
            table: value("mgmCheckNewTable"), serialNo: value("mgmCheckNewSerial"), aaTag: value("mgmCheckNewAaTag"), boxId: value("mgmCheckNewBox"),
            vaultId: value("mgmCheckNewVault"), eventDetails: value("mgmCheckNewDetails"),
          }, Date.now());
          persist(next); creating = false; pendingPanelOpen = true; pendingSelectedIds.clear(); filter = { query: "", site: "all", status: "all" };
          ["mgmCheckNewTime", "mgmCheckNewEndTime", "mgmCheckNewTable", "mgmCheckNewSerial", "mgmCheckNewAaTag", "mgmCheckNewBox", "mgmCheckNewVault", "mgmCheckNewDetails"].forEach((id) => { const input = documentRef.getElementById(id); if (input) input.value = ""; });
          setMessage("新請求已加入，請按「儲存資料」", "ok"); notify("✓ 新請求已加入待儲存清單"); render();
        } catch (error) { setMessage(text(error?.message || "未能新增檢查請求"), "err"); }
      });
      documentRef.getElementById("mgmCheckNewSerial")?.addEventListener("input", (event) => { const mapped = tagMaps(state.aaTags).aaBySerial.get(normalizeSerial(event.target.value)); const target = documentRef.getElementById("mgmCheckNewAaTag"); if (mapped && target) target.value = mapped; });
      documentRef.getElementById("mgmCheckNewAaTag")?.addEventListener("input", (event) => { const mapped = tagMaps(state.aaTags).serialByAa.get(normalizeAaTag(event.target.value)); const target = documentRef.getElementById("mgmCheckNewSerial"); if (mapped && target) target.value = mapped; });
      documentRef.getElementById("mgmCheckDownloadBtn")?.addEventListener("click", () => loadCloud());
      documentRef.getElementById("mgmCheckSyncBtn")?.addEventListener("click", syncCloud);
      documentRef.getElementById("mgmCheckPendingBadge")?.addEventListener("click", () => {
        if (!state.outbox.length) return;
        pendingPanelOpen = !pendingPanelOpen;
        if (!pendingPanelOpen) pendingSelectedIds.clear();
        render();
      });
      documentRef.getElementById("mgmCheckPendingPanel")?.addEventListener("change", (event) => {
        const input = event?.target;
        const entries = pendingEntries().filter((entry) => entry.canDiscard);
        if (input?.dataset?.mgmCheckPendingSelectAll) {
          pendingSelectedIds = input.checked ? new Set(entries.map((entry) => entry.mutation.requestId)) : new Set();
          render();
          return;
        }
        const requestId = text(input?.dataset?.mgmCheckPendingId);
        if (!requestId || !entries.some((entry) => entry.mutation.requestId === requestId)) return;
        if (input.checked) pendingSelectedIds.add(requestId); else pendingSelectedIds.delete(requestId);
        render();
      });
      documentRef.getElementById("mgmCheckPendingPanel")?.addEventListener("click", (event) => {
        const button = event?.target?.closest?.("button[data-mgm-check-pending-action]");
        if (!button || busy) return;
        const action = text(button.dataset?.mgmCheckPendingAction);
        if (action === "close") { pendingPanelOpen = false; pendingSelectedIds.clear(); render(); return; }
        const requestIds = action === "delete-one" ? [text(button.dataset?.mgmCheckPendingId)] : action === "delete-selected" ? [...pendingSelectedIds] : [];
        if (!requestIds.length) return;
        if (typeof root?.confirm === "function" && !root.confirm(`確定刪除 ${requestIds.length} 筆待儲存變更？這些資料會還原至最近雲端資料。`)) return;
        const removed = discardPendingChanges(requestIds);
        if (!removed) { setMessage("這筆變更暫時未能還原，請重新載入後再試", "warn"); render(); return; }
        setMessage(`已刪除 ${removed} 筆待儲存變更`, "ok");
        notify(`✓ 已刪除 ${removed} 筆待儲存變更`);
        render();
      });
      documentRef.getElementById("mgmCheckSearch")?.addEventListener("input", (event) => { filter.query = event.target.value; visibleLimit = 50; clearTimeout(searchTimer); searchTimer = setTimeout(render, 90); });
      documentRef.getElementById("mgmCheckSiteFilter")?.addEventListener("change", (event) => { filter.site = event.target.value; visibleLimit = 50; render(); });
      documentRef.getElementById("mgmCheckStatusFilter")?.addEventListener("change", (event) => { filter.status = event.target.value; visibleLimit = 50; render(); });
      documentRef.getElementById("mgmCheckMoreBtn")?.addEventListener("click", () => { visibleLimit += 50; render(); });
      documentRef.getElementById("mgmCheckList")?.addEventListener("click", (event) => {
        const followupButton = event?.target?.closest?.("button[data-mgm-check-followup-field]");
        if (followupButton && !busy) {
          const card = followupButton.closest?.("[data-mgm-check-id]");
          const requestId = card?.dataset?.mgmCheckId;
          const field = text(followupButton.dataset?.mgmCheckFollowupField);
          const choice = text(followupButton.dataset?.mgmCheckFollowupValue);
          const request = state.requests.find((item) => item.id === requestId);
          const selected = followupChoice(field, request?.[field]);
          const option = followupOption(field, choice);
          const nextValue = option?.value || "";
          if (!request || !option || !nextValue || selected === choice) return;
          const next = applyDraft(state, requestId, { [field]: nextValue }, Date.now());
          if (JSON.stringify(next.outbox) === JSON.stringify(state.outbox)) return;
          persist(next); pendingPanelOpen = state.outbox.length > 0; pendingSelectedIds.clear();
          const fieldLabel = field === "machineStatus" ? "機台檢查狀況" : "實牌檢查狀況";
          const choiceLabel = option.label;
          setMessage(`${fieldLabel}已設為${choiceLabel}，請按「儲存資料」`, "ok");
          notify(`✓ ${fieldLabel}已設為${choiceLabel}`);
          render();
          return;
        }
        const button = event?.target?.closest?.("button[data-mgm-check-action]"); if (!button || busy) return;
        const card = button.closest?.("[data-mgm-check-id]"); const requestId = card?.dataset?.mgmCheckId || editingId;
        if (button.dataset.mgmCheckAction === "edit") { editingId = requestId; render(); return; }
        if (button.dataset.mgmCheckAction === "cancel") { editingId = ""; render(); return; }
        if (button.dataset.mgmCheckAction === "save") {
          const next = applyDraft(state, requestId, draftFromEditor(), Date.now());
          if (JSON.stringify(next.outbox) === JSON.stringify(state.outbox)) { setMessage("沒有需要儲存的變更", "warn"); editingId = ""; render(); return; }
          persist(next); editingId = ""; pendingPanelOpen = state.outbox.length > 0; pendingSelectedIds.clear(); setMessage("修改已加入，請按「儲存資料」", "ok"); notify("✓ 修改已加入待儲存清單"); render();
        }
      });
      documentRef.getElementById("mgmCheckList")?.addEventListener("input", (event) => {
        const input = event?.target; const field = input?.dataset?.mgmCheckField;
        if (!editingId || (field !== "serialNo" && field !== "aaTag")) return;
        const maps = tagMaps(state.aaTags);
        const card = input.closest?.("[data-mgm-check-id]");
        if (field === "serialNo") { const other = card?.querySelector?.('[data-mgm-check-field="aaTag"]'); const mapped = maps.aaBySerial.get(normalizeSerial(input.value)); if (other && mapped) other.value = mapped; }
        else { const other = card?.querySelector?.('[data-mgm-check-field="serialNo"]'); const mapped = maps.serialByAa.get(normalizeAaTag(input.value)); if (other && mapped) other.value = mapped; }
      });
      root?.addEventListener?.("online", () => { render(); void loadCloud({ silent: true }); });
      root?.addEventListener?.("offline", render);
    }

    function mount() {
      const page = documentRef?.getElementById?.("mgmCheckRequestPage"); if (!page) return false;
      if (!mounted) { page.innerHTML = shell(); mounted = true; bind(); }
      render();
      if (online()) void loadCloud({ silent: true });
      return true;
    }

    return { mount, render, loadCloud, syncCloud, isBusy: () => busy, getState: () => normalizeState(state), setFilter: (next) => { filter = { ...filter, ...(next || {}) }; visibleLimit = 50; render(); } };
  }

  return {
    STORAGE_KEY,
    EDITABLE_FIELDS,
    applyDraft,
    createApplication,
    filterRequests,
    mergeCloudSnapshot,
    normalizeAaTag,
    normalizeSerial,
    parseRequestRows,
    readStoredState,
    stageNewRequest,
    writeStoredState,
  };
}));
