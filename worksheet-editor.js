(function attachWorksheetEditor(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AmrsWorksheetEditor = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createWorksheetEditorModule(root) {
  "use strict";

  function text(value) { return String(value == null ? "" : value); }
  function escapeHtml(value) {
    return text(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  }
  function columnLabel(number) {
    let value = Math.max(1, Number(number) || 1);
    let result = "";
    while (value > 0) {
      const remainder = (value - 1) % 26;
      result = String.fromCharCode(65 + remainder) + result;
      value = Math.floor((value - 1) / 26);
    }
    return result;
  }
  function rowKey(row, index = 0) { return text(row?.recordId) || `row-${Number(row?.rowNumber) || index + 2}`; }
  function cloneValues(values) { return (Array.isArray(values) ? values : []).map(text); }

  function createGridDraft(snapshot = {}) {
    const rows = (Array.isArray(snapshot.rows) ? snapshot.rows : []).map((row, index) => ({
      ...row,
      key: rowKey(row, index),
      originalValues: cloneValues(row.values),
      values: cloneValues(row.values),
    }));
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return {
      rows,
      setCell(key, columnIndex, value) {
        const row = byKey.get(text(key));
        const index = Number(columnIndex);
        if (!row || !Number.isInteger(index) || index < 0 || index >= row.values.length) return false;
        row.values[index] = text(value);
        return row.values[index] !== row.originalValues[index];
      },
      cellChanged(key, columnIndex) {
        const row = byKey.get(text(key));
        return Boolean(row && row.values[Number(columnIndex)] !== row.originalValues[Number(columnIndex)]);
      },
      changeCount() {
        return rows.reduce((total, row) => total + row.values.filter((value, index) => value !== row.originalValues[index]).length, 0);
      },
      mutations() {
        return rows.filter((row) => row.values.some((value, index) => value !== row.originalValues[index])).map((row) => ({
          rowNumber: Number(row.rowNumber),
          recordId: text(row.recordId),
          originalValues: row.originalValues.slice(),
          values: row.values.slice(),
        }));
      },
    };
  }

  function createApplication(options = {}) {
    const documentRef = options.document || root?.document;
    const transport = options.transport || null;
    const toast = options.toast || (() => {});
    const confirmAction = options.confirm || ((message) => root?.confirm ? root.confirm(message) : true);
    const onClose = options.onClose || (() => {});
    let context = { kind: "ae", company: "SCL", property: "" };
    let state = { title: "表格編輯", headers: [], rows: [], page: 1, pages: 1, pageSize: 60, total: 0 };
    let draft = createGridDraft(state);
    let loading = false;
    let saving = false;
    let mounted = false;
    let bound = false;

    function host() { return documentRef?.getElementById?.("worksheetEditorPage") || null; }
    function permission() { return context.kind === "cvcs" ? "cvcs" : "ae"; }
    function setContext(next = {}) {
      context = {
        kind: next.kind === "cvcs" ? "cvcs" : "ae",
        company: text(next.company || "SCL"),
        property: text(next.property),
      };
      state = { title: "表格編輯", headers: [], rows: [], page: 1, pages: 1, pageSize: 60, total: 0 };
      draft = createGridDraft(state);
      mounted = false;
    }
    function queryFor(page = 1, refresh = false) {
      const params = new URLSearchParams({
        action: context.kind === "cvcs" ? "cvcsWorksheetGrid" : "worksheetGrid",
        page: String(page),
        pageSize: String(state.pageSize || 60),
        ...(refresh ? { refresh: "1" } : {}),
      });
      if (context.kind === "cvcs") params.set("property", context.property);
      else params.set("company", context.company);
      return params.toString();
    }
    function renderRows() {
      if (!draft.rows.length) return `<tr><td class="worksheet-row-number">—</td><td class="worksheet-empty" colspan="${Math.max(state.headers.length, 1)}">沒有資料</td></tr>`;
      return draft.rows.map((row) => `<tr data-grid-row="${escapeHtml(row.key)}"><th class="worksheet-row-number" scope="row">${Number(row.rowNumber) || ""}</th>${row.values.map((value, columnIndex) => `<td class="worksheet-cell${draft.cellChanged(row.key, columnIndex) ? " changed" : ""}" data-grid-cell="${escapeHtml(row.key)}" data-grid-column="${columnIndex}" contenteditable="true" role="textbox" spellcheck="false">${escapeHtml(value)}</td>`).join("")}</tr>`).join("");
    }
    function render() {
      const target = host(); if (!target) return;
      const changes = draft.changeCount();
      target.innerHTML = `<div class="worksheet-shell">
        <header class="worksheet-toolbar">
          <button class="worksheet-back" data-ws-action="close" type="button">← 返回</button>
          <div class="worksheet-heading"><h2>${escapeHtml(state.title)}</h2><p>可修改現有資料；標題列及系統 ID 已鎖定</p></div>
          <div class="worksheet-actions"><button data-ws-action="reload" type="button" ${loading || saving ? "disabled" : ""}>重新載入</button><button class="worksheet-save" data-ws-action="save" type="button" ${!changes || loading || saving ? "disabled" : ""}>${saving ? "儲存中…" : `儲存 ${changes} 格變更`}</button></div>
        </header>
        <div class="worksheet-summary">${loading ? "正在載入雲端資料…" : `共 ${state.total || 0} 行 · 第 ${state.page || 1} / ${state.pages || 1} 頁 · 每頁 ${state.pageSize || 60} 行`}</div>
        <div class="worksheet-grid-wrap" tabindex="0">
          <table class="worksheet-grid">
            <thead><tr><th class="worksheet-corner"></th>${state.headers.map((_, index) => `<th class="worksheet-column-letter">${columnLabel(index + 1)}</th>`).join("")}</tr>
            <tr><th class="worksheet-row-number">1</th>${state.headers.map((header) => `<th data-grid-header>${escapeHtml(header)}</th>`).join("")}</tr></thead>
            <tbody>${renderRows()}</tbody>
          </table>
        </div>
        <footer class="worksheet-pager"><button data-ws-page="${Math.max(1, state.page - 1)}" type="button" ${state.page <= 1 || loading || saving ? "disabled" : ""}>上一頁</button><span>第 ${state.page || 1} / ${state.pages || 1} 頁</span><button data-ws-page="${Math.min(state.pages, state.page + 1)}" type="button" ${state.page >= state.pages || loading || saving ? "disabled" : ""}>下一頁</button></footer>
      </div>`;
      bind();
    }
    function updateSaveButton() {
      const button = documentRef?.querySelector?.('[data-ws-action="save"]');
      if (!button) return;
      const changes = draft.changeCount();
      button.textContent = `儲存 ${changes} 格變更`;
      button.disabled = !changes || loading || saving;
    }
    function bind() {
      const target = host();
      if (!target || bound || typeof target.addEventListener !== "function") return;
      bound = true;
      target.addEventListener("input", (event) => {
        const cell = event.target?.closest?.("[data-grid-cell]");
        if (!cell) return;
        const changed = draft.setCell(cell.dataset.gridCell, Number(cell.dataset.gridColumn), cell.innerText ?? cell.textContent ?? "");
        cell.classList?.toggle?.("changed", changed);
        updateSaveButton();
      });
      target.addEventListener("keydown", (event) => {
        const cell = event.target?.closest?.("[data-grid-cell]");
        if (!cell || event.key !== "Enter" || event.shiftKey) return;
        event.preventDefault();
        const row = cell.closest("tr")?.nextElementSibling;
        row?.querySelector?.(`[data-grid-column="${cell.dataset.gridColumn}"]`)?.focus?.();
      });
      target.addEventListener("click", async (event) => {
        const action = event.target?.closest?.("[data-ws-action]")?.dataset?.wsAction;
        if (action === "close") {
          if (!draft.changeCount() || confirmAction("尚有未儲存變更，確定離開？")) {
            draft = createGridDraft(state);
            onClose();
          }
          return;
        }
        if (action === "reload") { await load(state.page, true, true); return; }
        if (action === "save") { await save(); return; }
        const page = Number(event.target?.closest?.("[data-ws-page]")?.dataset?.wsPage);
        if (page && page !== state.page && (!draft.changeCount() || confirmAction("轉頁會放棄未儲存變更，確定繼續？"))) await load(page, false, false);
      });
    }
    async function load(page = 1, refresh = false, ask = false) {
      if (!transport || loading || saving) return false;
      if (ask && draft.changeCount() && !confirmAction("重新載入會放棄未儲存變更，確定繼續？")) return false;
      loading = true; render();
      try {
        const result = await transport.get(queryFor(page, refresh));
        if (!result?.success) throw new Error(result?.message || "表格載入失敗");
        state = { ...state, ...result, headers: Array.isArray(result.headers) ? result.headers.map(text) : [], rows: Array.isArray(result.rows) ? result.rows : [] };
        draft = createGridDraft(state);
        return true;
      } catch (error) {
        toast(error.message || "表格載入失敗", "err");
        return false;
      } finally { loading = false; render(); }
    }
    async function save() {
      const mutations = draft.mutations();
      if (!mutations.length || !transport || saving) return false;
      if (!confirmAction(`確定儲存 ${draft.changeCount()} 格變更？`)) return false;
      saving = true; render();
      try {
        const action = context.kind === "cvcs" ? "updateCvcsWorksheetGrid" : "updateWorksheetGrid";
        const payload = { action, mutations, ...(context.kind === "cvcs" ? { property: context.property } : { company: context.company }) };
        const result = await transport.post(payload);
        if (!result?.success) throw new Error(result?.message || "儲存失敗");
        toast(`已儲存 ${Number(result.saved) || 0} 行`, "ok");
        state = { ...state, rows: draft.rows.map((row) => ({ ...row, values: row.values.slice() })) };
        draft = createGridDraft(state);
        saving = false;
        render();
        await load(state.page, true, false);
        return true;
      } catch (error) {
        toast(error.message || "儲存失敗；請重新載入後再試", "err");
        return false;
      } finally { saving = false; render(); }
    }
    async function mount() {
      render();
      if (mounted) return true;
      mounted = true;
      return load(1, true, false);
    }
    return {
      setContext,
      permission,
      mount,
      load,
      save,
      render,
      discardChanges: () => { draft = createGridDraft(state); render(); },
      isBusy: () => saving || draft.changeCount() > 0,
      getState: () => ({ ...state, context: { ...context }, changeCount: draft.changeCount() }),
      getDraft: () => draft,
    };
  }

  return { columnLabel, createGridDraft, createApplication };
}));
