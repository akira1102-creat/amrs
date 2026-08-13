(function attachCvcs(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AmrsCvcs = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createCvcsModule(root) {
  "use strict";

  const PROPERTIES = Object.freeze(["Venetian", "Londoner", "Sands", "Plaza", "Parisian"]);
  const LOCATIONS = Object.freeze(["Cage", "TG", "Card Room", "Other"]);
  const MODELS = Object.freeze(["SOT", "SCP", "Reader"]);
  const QUARTERS = Object.freeze(["Q1", "Q2", "Q3", "Q4"]);
  const PAGE_SIZES = Object.freeze([10, 30, 50, 80, 100]);
  const QUEUE_PREFIX = "_amrs_cvcs_queue_v1_";
  const PREF_KEY = "_amrs_cvcs_preferences_v1";
  const USAGE_KEY = "_amrs_cvcs_usage_v1";

  const RECORD_FIELDS = Object.freeze([
    ["property", "場所 / Property"], ["date", "日期 / Date"], ["location", "位置 / Location"],
    ["subLocation", "子位置 / Sub Location"], ["quarter", "季度 / Quarter"], ["model", "機型 / Model"],
    ["serialNo", "機身號碼 / S/N"], ["antennaSize", "天線尺寸 / Antenna Size"],
    ["antennaStatus", "天線狀態 / Antenna Status"], ["version", "版本 / Version"],
    ["reason", "原因 / Reason"], ["actionTakenNotes", "處理方法及備註 / Action Taken & Notes"],
    ["partsChange", "更換零件 / Parts Change"],
  ]);
  const BROKEN_FIELDS = Object.freeze([
    ["property", "場所 / Property"], ["model", "機型 / Model"], ["serialNo", "機身號碼 / S/N"],
    ["partsNo", "零件編號 / Parts No."], ["requiredPartsEn", "零件名稱 / Required Parts (EN)"],
    ["qty", "數量 / Qty"], ["repairDay", "維修日 / Repair Day"], ["foundDay", "發現日 / Found Day"],
    ["remark", "備註 / Remark"], ["requestFollowUpDate", "要求跟進日期 / Request Follow-up Date"],
    ["followUpCompletedDate", "完成跟進日期 / Follow-up Completed Date"],
  ]);

  function text(value) { return String(value == null ? "" : value).trim(); }
  function escapeHtml(value) {
    return text(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }
  function dateInput(value) {
    const match = text(value).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    return match ? `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}` : "";
  }
  function todayIso(now = new Date()) {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }
  function uniqueStrings(values) {
    const seen = new Set();
    return (Array.isArray(values) ? values : []).map(text).filter((value) => value && !seen.has(value) && seen.add(value));
  }
  function rankOptions(query, values, usage = {}) {
    const normalized = text(query).toLowerCase();
    return uniqueStrings(values).map((value, index) => {
      const candidate = value.toLowerCase();
      const match = !normalized ? 3 : candidate === normalized ? 0 : candidate.startsWith(normalized) ? 1 : candidate.includes(normalized) ? 2 : 3;
      return { value, index, match, used: Number(usage[value]) || 0 };
    }).sort((left, right) => left.match - right.match || right.used - left.used || left.index - right.index).map((item) => item.value);
  }
  function actionForReason(reason, mappings = []) {
    const normalized = text(reason).toLowerCase();
    if (!normalized) return null;
    const match = (Array.isArray(mappings) ? mappings : []).find((item) => text(item.reason).toLowerCase() === normalized);
    return match ? text(match.actionTakenNotes) : null;
  }
  function createDefaultForm(property, now = new Date()) {
    return {
      property: PROPERTIES.includes(property) ? property : PROPERTIES[0], date: todayIso(now), location: LOCATIONS[0],
      subLocation: "", quarter: "", model: MODELS[0], serialNo: "", antennaSize: "", antennaStatus: "",
      version: "", reason: "PM", actionTakenNotes: "", partsChange: "",
    };
  }
  function makeId(prefix = "cvcs") {
    if (root?.crypto?.randomUUID) return `${prefix}-${root.crypto.randomUUID()}`;
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  function requiredChoice(value, choices, label) {
    const normalized = text(value);
    if (!choices.includes(normalized)) throw new Error(`${label} is required`);
    return normalized;
  }
  function buildRecord(input = {}, idFactory = () => makeId("cvcs")) {
    const record = {
      property: requiredChoice(input.property, PROPERTIES, "Property"), date: dateInput(input.date),
      location: requiredChoice(input.location, LOCATIONS, "Location"), subLocation: text(input.subLocation),
      quarter: input.quarter ? requiredChoice(input.quarter, QUARTERS, "Quarter") : "",
      model: requiredChoice(input.model, MODELS, "Model"), serialNo: text(input.serialNo),
      antennaSize: text(input.antennaSize), antennaStatus: text(input.antennaStatus), version: text(input.version),
      reason: text(input.reason) || "PM", actionTakenNotes: text(input.actionTakenNotes), partsChange: text(input.partsChange),
      submissionId: text(input.submissionId) || text(idFactory()),
    };
    if (!record.date) throw new Error("Date is required");
    if (!record.serialNo) throw new Error("S/N is required");
    return record;
  }
  function buildBrokenPart(input = {}, idFactory = () => makeId("cvcs-part")) {
    const record = {
      property: requiredChoice(input.property, PROPERTIES, "Property"), model: requiredChoice(input.model, MODELS, "Model"),
      serialNo: text(input.serialNo), partsNo: text(input.partsNo), requiredPartsEn: text(input.requiredPartsEn), qty: text(input.qty),
      repairDay: text(input.repairDay), foundDay: dateInput(input.foundDay), remark: text(input.remark),
      requestFollowUpDate: dateInput(input.requestFollowUpDate), followUpCompletedDate: "",
      submissionId: text(input.submissionId) || text(idFactory()),
    };
    if (!record.serialNo) throw new Error("S/N is required");
    if (!record.partsNo && !record.requestFollowUpDate) throw new Error("A part or follow-up request is required");
    if (!record.partsNo) Object.assign(record, { requiredPartsEn: "", qty: "", repairDay: "" });
    return record;
  }
  function buildRecordQuery(filters = {}) {
    const params = new URLSearchParams({ action: "cvcsRecords" });
    ["property", "from", "to", "location", "quarter", "model", "serialNo", "query", "sort"].forEach((key) => {
      if (text(filters[key])) params.set(key, text(filters[key]));
    });
    params.set("fuzzy", filters.fuzzy ? "1" : "0");
    params.set("page", String(Math.max(1, Number(filters.page) || 1)));
    params.set("pageSize", String(PAGE_SIZES.includes(Number(filters.pageSize)) ? Number(filters.pageSize) : 10));
    return params;
  }
  function buildBrokenQuery(filters = {}) {
    const params = new URLSearchParams({ action: "cvcsBrokenParts" });
    ["property", "serialNo", "partsNo", "status", "sort"].forEach((key) => {
      if (text(filters[key])) params.set(key, text(filters[key]));
    });
    params.set("page", String(Math.max(1, Number(filters.page) || 1)));
    params.set("pageSize", String(PAGE_SIZES.includes(Number(filters.pageSize)) ? Number(filters.pageSize) : 10));
    return params;
  }
  function visibleFields(record, kind = "record") {
    return (kind === "broken" ? BROKEN_FIELDS : RECORD_FIELDS)
      .filter(([key]) => text(record?.[key]))
      .map(([key, label]) => ({ key, label, value: text(record[key]) }));
  }
  function brokenStatuses(record = {}) {
    const result = [];
    if (text(record.partsNo)) result.push(!text(record.repairDay) || /^waiting parts$/i.test(text(record.repairDay)) ? "Waiting Parts" : "Repaired");
    if (text(record.requestFollowUpDate)) result.push(text(record.followUpCompletedDate) ? "Follow-up Completed" : "Following Up");
    return result;
  }

  class CvcsApplication {
    constructor(options = {}) {
      this.transport = options.transport;
      this.storage = options.storage || root?.localStorage;
      this.toast = options.toast || (() => {});
      this.showLoading = options.showLoading || (() => null);
      this.hideLoading = options.hideLoading || (() => {});
      this.activeProperty = PROPERTIES[0];
      this.options = { subLocation: [], antennaSize: [], antennaStatus: [], version: [], reasonAction: [{ reason: "PM", actionTakenNotes: "" }], partsChange: [] };
      this.parts = [];
      this.optionsLoaded = false;
      this.editingQueueIndex = -1;
      this.forms = Object.fromEntries(PROPERTIES.map((property) => [property, createDefaultForm(property)]));
      this.queryState = { property: "", from: "", to: "", location: "", quarter: "", model: "", serialNo: "", query: "", fuzzy: false, sort: "newest", page: 1, pageSize: 10 };
      this.brokenState = { property: "", serialNo: "", partsNo: "", status: "", sort: "newest", page: 1, pageSize: 10 };
      this.queryRecords = [];
      this.brokenRecords = [];
      this.selectedRecords = new Set();
      this.selectedBroken = new Set();
      this.loadPreferences();
    }

    loadPreferences() {
      try {
        const value = JSON.parse(this.storage?.getItem(PREF_KEY) || "{}");
        if (PAGE_SIZES.includes(Number(value.queryPageSize))) this.queryState.pageSize = Number(value.queryPageSize);
        if (PAGE_SIZES.includes(Number(value.brokenPageSize))) this.brokenState.pageSize = Number(value.brokenPageSize);
      } catch { /* Ignore corrupted preferences. */ }
    }
    savePreferences() {
      this.storage?.setItem(PREF_KEY, JSON.stringify({ queryPageSize: this.queryState.pageSize, brokenPageSize: this.brokenState.pageSize }));
    }
    queueKey(property = this.activeProperty) { return `${QUEUE_PREFIX}${property}`; }
    getQueue(property = this.activeProperty) {
      try { return JSON.parse(this.storage?.getItem(this.queueKey(property)) || "[]"); } catch { return []; }
    }
    saveQueue(queue, property = this.activeProperty) { this.storage?.setItem(this.queueKey(property), JSON.stringify(queue)); }
    usage() { try { return JSON.parse(this.storage?.getItem(USAGE_KEY) || "{}"); } catch { return {}; } }
    recordUsage(record) {
      const usage = this.usage();
      [record.subLocation, record.antennaSize, record.antennaStatus, record.version, record.reason, record.actionTakenNotes, record.partsChange]
        .map(text).filter(Boolean).forEach((value) => { usage[value] = (Number(usage[value]) || 0) + 1; });
      this.storage?.setItem(USAGE_KEY, JSON.stringify(usage));
    }

    mount() {
      if (!root?.document) return;
      this.renderInput();
      this.renderQueryShell();
      this.renderBrokenShell();
      this.loadOptions();
    }
    optionValues(key) {
      if (key === "reason") return this.options.reasonAction.map((item) => item.reason);
      if (key === "actionTakenNotes") return this.options.reasonAction.map((item) => item.actionTakenNotes);
      return this.options[key] || [];
    }
    datalist(key, id) {
      const values = rankOptions("", this.optionValues(key), this.usage());
      return `<datalist id="${id}">${values.map((value) => `<option value="${escapeHtml(value)}"></option>`).join("")}</datalist>`;
    }
    selectOptions(values, selected = "", blank = "") {
      return `${blank !== null ? `<option value="">${escapeHtml(blank)}</option>` : ""}${values.map((value) => `<option${value === selected ? " selected" : ""}>${escapeHtml(value)}</option>`).join("")}`;
    }

    renderInput() {
      const host = root.document.getElementById("cvcsInputPage"); if (!host) return;
      const form = this.forms[this.activeProperty] || createDefaultForm(this.activeProperty);
      const queue = this.getQueue();
      host.innerHTML = `<div class="cvcs-shell">
        <div class="cvcs-page-head"><div><h2>CVCS 資料輸入</h2><span class="cvcs-property-badge">${escapeHtml(this.activeProperty)}</span></div></div>
        <div class="cvcs-input-layout"><div class="cvcs-main-column">
          <section class="cvcs-panel"><h3>基本資料</h3><div class="cvcs-grid cvcs-grid-4">
            <label><span>日期 / Date *</span><input id="cvcs-date" type="date" required value="${escapeHtml(form.date)}"></label>
            <label><span>位置 / Location *</span><select id="cvcs-location">${this.selectOptions(LOCATIONS, form.location, null)}</select></label>
            <label><span>子位置 / Sub Location</span><div class="cvcs-inline">${this.comboInput("subLocation", form.subLocation)}<button type="button" data-option-edit="subLocation" title="編輯清單">編輯</button></div></label>
            <label><span>季度 / Quarter</span><select id="cvcs-quarter">${this.selectOptions(QUARTERS, form.quarter, "不限")}</select></label>
          </div></section>
          <section class="cvcs-panel"><h3>設備資料</h3><div class="cvcs-grid cvcs-grid-4">
            <label><span>機型 / Model *</span><select id="cvcs-model">${this.selectOptions(MODELS, form.model, null)}</select></label>
            <label><span>機身號碼 / S/N *</span><input id="cvcs-serialNo" value="${escapeHtml(form.serialNo)}" autocomplete="off"></label>
            ${this.comboField("antennaSize", "天線尺寸 / Antenna Size", form.antennaSize)}
            ${this.comboField("antennaStatus", "天線狀態 / Antenna Status", form.antennaStatus)}
            ${this.comboField("version", "版本 / Version", form.version)}
          </div></section>
          <section class="cvcs-panel"><div class="cvcs-section-head cvcs-maintenance-head"><h3>維修資料</h3><button type="button" data-option-edit="reasonAction">編輯原因 / 處理方法</button></div><div class="cvcs-grid cvcs-grid-3">
            ${this.comboField("reason", "原因 / Reason *", form.reason, false, false)}
            ${this.comboField("actionTakenNotes", "處理方法及備註 / Action Taken & Notes", form.actionTakenNotes, true, false)}
            ${this.comboField("partsChange", "更換零件 / Parts Change", form.partsChange)}
          </div></section>
          ${this.renderBrokenInput(form)}
          <button class="cvcs-primary cvcs-add" id="cvcs-add-btn" type="button">${this.editingQueueIndex >= 0 ? "儲存待提交項目" : "＋ 加入待提交"}</button>
        </div><aside class="cvcs-queue-column">
          <section class="cvcs-panel cvcs-queue-panel"><div class="cvcs-section-head"><h3>待提交 <span>${queue.length}</span></h3><div><button id="cvcs-select-all" type="button">全選</button><button id="cvcs-delete-selected" class="danger" type="button">刪除選取</button></div></div>
            <div id="cvcs-queue-list">${this.queueCards(queue)}</div></section>
          <button class="cvcs-submit" id="cvcs-submit-btn" type="button" ${queue.length ? "" : "disabled"}>提交 ${queue.length} 筆</button>
        </aside></div>
      </div>`;
      this.bindInput();
    }
    comboField(key, label, value, wide = false, editable = true) {
      return `<label class="${wide ? "cvcs-wide" : ""}"><span>${escapeHtml(label)}</span><div class="cvcs-inline">${this.comboInput(key, value)}${editable ? `<button type="button" data-option-edit="${key}" title="編輯清單">編輯</button>` : ""}</div></label>`;
    }
    comboInput(key, value) {
      return `<span class="cvcs-combo"><input id="cvcs-${key}" data-cvcs-combo="${key}" value="${escapeHtml(value)}" autocomplete="off"><span class="cvcs-suggestion-menu" id="cvcs-${key}-menu"></span></span>`;
    }
    renderBrokenInput(form) {
      return `<details class="cvcs-panel cvcs-details"><summary>壞零件 / 跟進</summary><div class="cvcs-grid cvcs-grid-4 cvcs-detail-body">
        <label><span>零件編號 / Parts No.</span><span class="cvcs-combo"><input id="cvcs-part-no" autocomplete="off" placeholder="輸入相關文字搜尋"><span class="cvcs-suggestion-menu" id="cvcs-part-menu"></span></span></label>
        <label><span>零件名稱 / Required Parts (EN)</span><input id="cvcs-part-name" readonly></label>
        <label id="cvcs-part-qty-field"><span>數量 / Qty</span><input id="cvcs-part-qty" type="number" min="1" inputmode="numeric"></label>
        <label id="cvcs-repair-field"><span>維修日 / Repair Day</span><div class="cvcs-inline"><input id="cvcs-repair-day" type="date"><button id="cvcs-wait-parts" type="button">等待零件</button></div></label>
        <label><span>發現日 / Found Day</span><input id="cvcs-found-day" type="date" value="${escapeHtml(form.date)}"></label>
        <label class="cvcs-wide"><span>備註 / Remark</span><input id="cvcs-part-remark"></label>
      </div><div class="cvcs-follow-row"><div class="cvcs-follow-control"><button id="cvcs-follow-toggle" type="button" aria-pressed="false">要求跟進 / Request Following Up</button><span>點擊按鈕以標記需要後續跟進</span></div></div></details>`;
    }
    queueCards(queue) {
      if (!queue.length) return `<div class="cvcs-empty">未有待提交資料</div>`;
      return queue.map((item, index) => `<article class="cvcs-mini-card"><label class="cvcs-check"><input type="checkbox" data-queue-select="${index}"></label><div><strong>${escapeHtml(item.main.serialNo)}</strong><span>${escapeHtml(item.main.model)} · ${escapeHtml(item.main.location)}</span><small>${escapeHtml(item.main.reason)}${item.broken ? " · 壞件/跟進" : ""}</small></div><div class="cvcs-card-actions"><button data-queue-edit="${index}" type="button">編輯</button><button data-queue-delete="${index}" class="danger" type="button">刪除</button></div></article>`).join("");
    }
    readForm() {
      const value = (id) => root.document.getElementById(`cvcs-${id}`)?.value || "";
      return { property: this.activeProperty, date: value("date"), location: value("location"), subLocation: value("subLocation"), quarter: value("quarter"), model: value("model"), serialNo: value("serialNo"), antennaSize: value("antennaSize"), antennaStatus: value("antennaStatus"), version: value("version"), reason: value("reason"), actionTakenNotes: value("actionTakenNotes"), partsChange: value("partsChange") };
    }
    readBroken(main) {
      const value = (id) => root.document.getElementById(id)?.value || "";
      const follow = root.document.getElementById("cvcs-follow-toggle")?.getAttribute("aria-pressed") === "true";
      const partsNo = value("cvcs-part-no");
      if (!partsNo && !follow) return null;
      return buildBrokenPart({ property: main.property, model: main.model, serialNo: main.serialNo, partsNo, requiredPartsEn: value("cvcs-part-name"), qty: value("cvcs-part-qty"), repairDay: value("cvcs-repair-day"), foundDay: value("cvcs-found-day") || main.date, remark: value("cvcs-part-remark"), requestFollowUpDate: follow ? main.date : "" });
    }
    bindInput() {
      const doc = root.document;
      this.inputAbort?.abort();this.inputAbort=new AbortController();
      ["subLocation", "antennaSize", "antennaStatus", "version", "reason", "actionTakenNotes", "partsChange"].forEach((key) => this.bindCombo(key));
      this.bindPartsCombo();
      doc.querySelectorAll("[data-option-edit]").forEach((button) => button.addEventListener("click", () => this.openOptionEditor(button.dataset.optionEdit)));
      doc.getElementById("cvcs-reason")?.addEventListener("change", (event) => {
        const action = actionForReason(event.target.value, this.options.reasonAction);
        if (action !== null) {
          const input = doc.getElementById("cvcs-actionTakenNotes");
          input.value = action;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      doc.getElementById("cvcs-part-no")?.addEventListener("input", (event) => {
        const match = this.parts.find((item) => text(item.partsNo).toLowerCase() === text(event.target.value).toLowerCase());
        doc.getElementById("cvcs-part-name").value = match?.requiredPartsEn || "";
      });
      doc.getElementById("cvcs-wait-parts")?.addEventListener("click", (event) => {
        const input = doc.getElementById("cvcs-repair-day");
        const active = input.dataset.waiting !== "1"; input.dataset.waiting = active ? "1" : ""; input.type = active ? "text" : "date"; input.value = active ? "Waiting Parts" : ""; input.readOnly = active; event.currentTarget.classList.toggle("active", active);
      });
      doc.getElementById("cvcs-follow-toggle")?.addEventListener("click", (event) => {
        const active = event.currentTarget.getAttribute("aria-pressed") !== "true"; event.currentTarget.setAttribute("aria-pressed", String(active)); event.currentTarget.classList.toggle("active", active);
      });
      doc.getElementById("cvcs-add-btn")?.addEventListener("click", () => this.addQueueItem());
      doc.getElementById("cvcs-submit-btn")?.addEventListener("click", () => this.submitQueue());
      doc.getElementById("cvcs-select-all")?.addEventListener("click", () => doc.querySelectorAll("[data-queue-select]").forEach((box) => { box.checked = true; }));
      doc.getElementById("cvcs-delete-selected")?.addEventListener("click", () => this.deleteSelectedQueue());
      doc.querySelectorAll("[data-queue-edit]").forEach((button) => button.addEventListener("click", () => this.editQueueItem(Number(button.dataset.queueEdit))));
      doc.querySelectorAll("[data-queue-delete]").forEach((button) => button.addEventListener("click", () => { const queue = this.getQueue(); queue.splice(Number(button.dataset.queueDelete), 1); this.saveQueue(queue); this.renderInput(); }));
      ["date", "location", "subLocation", "quarter", "model", "serialNo", "antennaSize", "antennaStatus", "version", "reason", "actionTakenNotes", "partsChange"].forEach((key) => doc.getElementById(`cvcs-${key}`)?.addEventListener("change", () => { this.forms[this.activeProperty] = this.readForm(); }));
      doc.addEventListener("pointerdown", (event) => { if (!event.target.closest(".cvcs-combo")) doc.querySelectorAll(".cvcs-suggestion-menu.open").forEach((menu) => menu.classList.remove("open")); }, { signal: this.inputAbort.signal });
    }
    bindCombo(key) {
      const doc = root.document, input = doc.getElementById(`cvcs-${key}`), menu = doc.getElementById(`cvcs-${key}-menu`); if (!input || !menu) return;
      const render = () => {
        const values = rankOptions(input.value, this.optionValues(key), this.usage());
        menu.innerHTML = values.length ? values.map((value) => `<button type="button" data-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join("") : `<span>沒有清單選項，可保留自行輸入內容</span>`;
        menu.classList.add("open");
        menu.querySelectorAll("button").forEach((button) => button.addEventListener("pointerdown", (event) => { event.preventDefault(); input.value = button.dataset.value; input.dispatchEvent(new Event("change", { bubbles: true })); menu.classList.remove("open"); }, { signal: this.inputAbort.signal }));
      };
      input.addEventListener("focus", render, { signal: this.inputAbort.signal }); input.addEventListener("click", render, { signal: this.inputAbort.signal }); input.addEventListener("input", render, { signal: this.inputAbort.signal });
    }
    bindPartsCombo() {
      const doc = root.document, input = doc.getElementById("cvcs-part-no"), menu = doc.getElementById("cvcs-part-menu"); if (!input || !menu) return;
      const render = () => {
        const query = text(input.value).toLowerCase(); if (!query) { menu.classList.remove("open"); menu.innerHTML = ""; return; }
        const values = this.parts.filter((part) => `${part.partsNo} ${part.requiredPartsEn}`.toLowerCase().includes(query)).slice(0, 100);
        menu.innerHTML = values.length ? values.map((part) => `<button type="button" data-code="${escapeHtml(part.partsNo)}" data-name="${escapeHtml(part.requiredPartsEn)}"><strong>${escapeHtml(part.partsNo)}</strong><small>${escapeHtml(part.requiredPartsEn)}</small></button>`).join("") : `<span>沒有相關零件</span>`; menu.classList.add("open");
        menu.querySelectorAll("button").forEach((button) => button.addEventListener("pointerdown", (event) => { event.preventDefault(); input.value = button.dataset.code; doc.getElementById("cvcs-part-name").value = button.dataset.name; menu.classList.remove("open"); }, { signal: this.inputAbort.signal }));
      };
      input.addEventListener("focus", render, { signal: this.inputAbort.signal }); input.addEventListener("input", render, { signal: this.inputAbort.signal });
    }
    addQueueItem() {
      try {
        const main = buildRecord(this.readForm());
        const broken = this.readBroken(main);
        const queue = this.getQueue();
        const value = { main, broken };
        if (this.editingQueueIndex >= 0) queue[this.editingQueueIndex] = value; else queue.push(value);
        this.recordUsage(main); this.saveQueue(queue); this.forms[this.activeProperty] = createDefaultForm(this.activeProperty); this.editingQueueIndex = -1; this.renderInput(); this.toast("已加入待提交", "ok");
      } catch (error) { this.toast(error.message || "請填寫必填資料", "err"); }
    }
    editQueueItem(index) {
      const item = this.getQueue()[index]; if (!item) return;
      this.forms[this.activeProperty] = { ...item.main, date: dateInput(item.main.date) }; this.editingQueueIndex = index; this.renderInput();
      const doc = root.document;
      if (item.broken) {
        doc.querySelector(".cvcs-details").open = true;
        doc.getElementById("cvcs-part-no").value = item.broken.partsNo || ""; doc.getElementById("cvcs-part-name").value = item.broken.requiredPartsEn || ""; doc.getElementById("cvcs-part-qty").value = item.broken.qty || ""; doc.getElementById("cvcs-found-day").value = dateInput(item.broken.foundDay); doc.getElementById("cvcs-part-remark").value = item.broken.remark || "";
        if (/^waiting parts$/i.test(item.broken.repairDay || "")) doc.getElementById("cvcs-wait-parts").click(); else doc.getElementById("cvcs-repair-day").value = dateInput(item.broken.repairDay);
        if (item.broken.requestFollowUpDate) doc.getElementById("cvcs-follow-toggle").click();
      }
    }
    deleteSelectedQueue() {
      const selected = [...root.document.querySelectorAll("[data-queue-select]:checked")].map((box) => Number(box.dataset.queueSelect));
      if (!selected.length) return this.toast("請先選取項目", "err");
      const remove = new Set(selected); const queue = this.getQueue().filter((_, index) => !remove.has(index)); this.saveQueue(queue); this.renderInput();
    }
    async submitQueue() {
      const queue = this.getQueue(); if (!queue.length || !this.transport) return;
      if (!root.confirm(`確定提交 ${queue.length} 筆 ${this.activeProperty} CVCS 記錄？`)) return;
      const loading = this.showLoading(`CVCS 資料提交中，請稍等...`);
      try {
        const main = queue.map((item) => item.main);
        const broken = queue.map((item) => item.broken).filter(Boolean);
        await this.transport.post({ action: "submitCvcsRecords", records: main });
        if (broken.length) await this.transport.post({ action: "submitCvcsBrokenParts", records: broken });
        this.saveQueue([]); this.forms[this.activeProperty] = createDefaultForm(this.activeProperty); this.renderInput(); this.toast("CVCS 資料提交完成", "ok");
      } catch (error) { this.toast(error?.unknownOutcome ? "提交結果未能確認，請稍後重新核對，切勿重複提交" : (error.message || "提交失敗"), "err"); }
      finally { this.hideLoading(loading); }
    }
    setProperty(property) {
      if (!PROPERTIES.includes(property)) return;
      const currentForm = root.document?.getElementById("cvcs-date") ? this.readForm() : null;
      if (currentForm) this.forms[this.activeProperty] = currentForm;
      this.activeProperty = property; this.editingQueueIndex = -1; this.renderInput();
    }
    async loadOptions(force = false) {
      if ((this.optionsLoaded && !force) || !this.transport) return;
      try {
        const data = await this.transport.get(new URLSearchParams({ action: "cvcsOptions", ...(force ? { refresh: "1" } : {}) }));
        if (!data?.success) throw new Error(data?.message || "清單載入失敗");
        this.options = { ...this.options, ...(data.options || {}) }; this.parts = Array.isArray(data.parts) ? data.parts : []; this.optionsLoaded = true; this.renderInput();
      } catch (error) { this.toast(error.message || "CVCS 選項載入失敗", "err"); }
    }
    openOptionEditor(key) {
      const actualKey = key === "reason" || key === "actionTakenNotes" ? "reasonAction" : key;
      const paired = actualKey === "reasonAction";
      if (paired) return this.openReasonActionEditor();
      this.openEditor({ title: `編輯 ${key}`, note: "每行一個選項，可自行排序。", value: this.optionValues(actualKey).join("\n"), onSave: async (value) => {
        await this.saveOptions(actualKey, uniqueStrings(value.split(/\r?\n/)));
      } });
    }
    async saveOptions(key, options) {
      const loading = this.showLoading("清單儲存中，請稍等...");
      try { const data = await this.transport.post({ action: "updateCvcsOptions", key, options }); if (!data?.success) throw new Error(data?.message || "儲存失敗"); this.options[key] = data.options || options; this.optionsLoaded = true; this.closeOverlay(); this.renderInput(); this.toast("清單已更新", "ok"); } catch (error) { this.toast(error.message || "清單儲存失敗", "err"); } finally { this.hideLoading(loading); }
    }
    openReasonActionEditor() {
      const rows = this.options.reasonAction.length ? this.options.reasonAction : [{ reason: "", actionTakenNotes: "" }];
      const body = `<p class="cvcs-overlay-note">左欄原因會自動配對同一列的處理方法及備註。可拖拉調整順序。</p><div id="cvcs-reason-action-rows" class="cvcs-paired-list">${rows.map((item, index) => this.reasonActionRow(item, index)).join("")}</div>`;
      this.openOverlay("編輯原因 / 處理方法", body, `<button id="cvcs-paired-add" type="button">＋ 新增一行</button><button id="cvcs-paired-sort" type="button">A–Z 排列</button><button data-close type="button">取消</button><button class="cvcs-primary" id="cvcs-paired-save" type="button">儲存</button>`);
      this.bindReasonActionRows();
      root.document.getElementById("cvcs-paired-add").addEventListener("click", () => { const host = root.document.getElementById("cvcs-reason-action-rows"); host.insertAdjacentHTML("beforeend", this.reasonActionRow({}, host.children.length)); this.bindReasonActionRows(); host.querySelector(".cvcs-paired-row:last-child input")?.focus(); });
      root.document.getElementById("cvcs-paired-sort").addEventListener("click", () => { const values = this.collectReasonActionRows().sort((a, b) => a.reason.localeCompare(b.reason, "en", { sensitivity: "base" })); root.document.getElementById("cvcs-reason-action-rows").innerHTML = values.map((item, index) => this.reasonActionRow(item, index)).join(""); this.bindReasonActionRows(); });
      root.document.getElementById("cvcs-paired-save").addEventListener("click", () => this.saveOptions("reasonAction", this.collectReasonActionRows()));
    }
    reasonActionRow(item = {}, index = 0) {
      return `<div class="cvcs-paired-row" data-paired-index="${index}"><button class="cvcs-paired-drag" type="button" draggable="true" aria-label="拖拉排序" title="拖拉排序">☰</button><input data-paired-field="reason" value="${escapeHtml(item.reason)}" placeholder="原因 / Reason"><input data-paired-field="action" value="${escapeHtml(item.actionTakenNotes)}" placeholder="處理方法及備註 / Action Taken & Notes"><button class="cvcs-paired-delete danger" type="button" aria-label="刪除">×</button></div>`;
    }
    collectReasonActionRows() {
      return [...root.document.querySelectorAll("#cvcs-reason-action-rows .cvcs-paired-row")].map((row) => ({ reason: text(row.querySelector('[data-paired-field="reason"]')?.value), actionTakenNotes: text(row.querySelector('[data-paired-field="action"]')?.value) })).filter((item) => item.reason || item.actionTakenNotes);
    }
    bindReasonActionRows() {
      const host = root.document.getElementById("cvcs-reason-action-rows"); if (!host) return;
      let dragged = null;
      host.querySelectorAll(".cvcs-paired-delete").forEach((button) => { button.onclick = () => { button.closest(".cvcs-paired-row")?.remove(); if (!host.children.length) host.innerHTML = this.reasonActionRow(); this.bindReasonActionRows(); }; });
      host.querySelectorAll(".cvcs-paired-row").forEach((row) => {
        const handle = row.querySelector(".cvcs-paired-drag");
        handle.ondragstart = (event) => { dragged = row; row.classList.add("dragging"); event.dataTransfer.effectAllowed = "move"; };
        handle.ondragend = () => { row.classList.remove("dragging"); dragged = null; };
        row.ondragover = (event) => { if (!dragged || dragged === row) return; event.preventDefault(); const rect = row.getBoundingClientRect(); host.insertBefore(dragged, event.clientY < rect.top + rect.height / 2 ? row : row.nextSibling); };
        handle.onpointerdown = (event) => { if (event.pointerType === "mouse") return; dragged = row; row.classList.add("dragging"); handle.setPointerCapture(event.pointerId); event.preventDefault(); };
        handle.onpointermove = (event) => { if (!dragged || event.pointerType === "mouse") return; const target = root.document.elementFromPoint(event.clientX, event.clientY)?.closest(".cvcs-paired-row"); if (!target || target === dragged || !host.contains(target)) return; const rect = target.getBoundingClientRect(); host.insertBefore(dragged, event.clientY < rect.top + rect.height / 2 ? target : target.nextSibling); };
        const finish = () => { if (dragged) dragged.classList.remove("dragging"); dragged = null; };
        handle.onpointerup = finish; handle.onpointercancel = finish;
      });
    }

    renderQueryShell() {
      const host = root.document.getElementById("cvcsQueryPage"); if (!host) return;
      host.innerHTML = `<div class="cvcs-shell"><div class="cvcs-page-head"><div><h2>CVCS 資料查詢</h2><p>預設精準搜尋 S/N</p></div></div>
        <section class="cvcs-panel"><div class="cvcs-filter-grid">
          <label><span>場所 / Property</span><select id="cvcs-q-property">${this.selectOptions(PROPERTIES, this.queryState.property, "全部")}</select></label>
          <label><span>由 / From</span><input id="cvcs-q-from" type="date" value="${escapeHtml(this.queryState.from)}"></label>
          <label><span>至 / To</span><input id="cvcs-q-to" type="date" value="${escapeHtml(this.queryState.to)}"></label>
          <label><span>位置 / Location</span><select id="cvcs-q-location">${this.selectOptions(LOCATIONS, this.queryState.location, "全部")}</select></label>
          <label><span>機型 / Model</span><select id="cvcs-q-model">${this.selectOptions(MODELS, this.queryState.model, "全部")}</select></label>
          <label><span>排序</span><select id="cvcs-q-sort"><option value="newest">最新優先</option><option value="oldest"${this.queryState.sort === "oldest" ? " selected" : ""}>最舊優先</option></select></label>
          <label class="cvcs-search-field"><span>搜尋</span><div class="cvcs-inline"><input id="cvcs-q-serial" value="${escapeHtml(this.queryState.serialNo)}" placeholder="請輸入準確 S/N"><button id="cvcs-q-fuzzy" class="${this.queryState.fuzzy ? "active" : ""}" type="button">模糊搜尋</button></div></label>
          <button class="cvcs-primary" id="cvcs-q-search" type="button">搜尋</button>
        </div><div class="cvcs-toolbar"><button id="cvcs-q-select" type="button">選取本頁</button><button id="cvcs-q-bulk" type="button">批量修改</button><button id="cvcs-q-delete" class="danger" type="button">批量刪除</button><button id="cvcs-q-xls" type="button">Excel</button><button id="cvcs-q-pdf" type="button">PDF</button><label>每頁 <select id="cvcs-q-size">${PAGE_SIZES.map((size) => `<option${size === this.queryState.pageSize ? " selected" : ""}>${size}</option>`).join("")}</select></label></div>
        <div id="cvcs-q-summary" class="cvcs-summary">按搜尋載入資料</div><div id="cvcs-q-results" class="cvcs-card-grid"></div><div id="cvcs-q-pager" class="cvcs-pager"></div></section></div>`;
      this.bindQuery();
    }
    bindQuery() {
      const doc = root.document;
      doc.getElementById("cvcs-q-fuzzy")?.addEventListener("click", (event) => { this.queryState.fuzzy = !this.queryState.fuzzy; event.currentTarget.classList.toggle("active", this.queryState.fuzzy); });
      doc.getElementById("cvcs-q-search")?.addEventListener("click", () => this.loadRecords(1));
      doc.getElementById("cvcs-q-size")?.addEventListener("change", (event) => { this.queryState.pageSize = Number(event.target.value); this.savePreferences(); this.loadRecords(1); });
      doc.getElementById("cvcs-q-select")?.addEventListener("click", () => { this.queryRecords.forEach((record) => this.selectedRecords.add(record.recordId)); this.renderRecordResults(); });
      doc.getElementById("cvcs-q-bulk")?.addEventListener("click", () => this.bulkRecords(false));
      doc.getElementById("cvcs-q-delete")?.addEventListener("click", () => this.bulkRecords(true));
      doc.getElementById("cvcs-q-xls")?.addEventListener("click", () => this.openExport("record", "xls"));
      doc.getElementById("cvcs-q-pdf")?.addEventListener("click", () => this.openExport("record", "pdf"));
    }
    readQueryFilters() {
      const doc = root.document; const value = (id) => doc.getElementById(id)?.value || "";
      Object.assign(this.queryState, { property: value("cvcs-q-property"), from: value("cvcs-q-from"), to: value("cvcs-q-to"), location: value("cvcs-q-location"), model: value("cvcs-q-model"), sort: value("cvcs-q-sort"), serialNo: value("cvcs-q-serial") });
    }
    async loadRecords(page = 1) {
      this.readQueryFilters(); this.queryState.page = page;
      const loading = this.showLoading("CVCS 資料載入中，請稍等...");
      try { const data = await this.transport.get(buildRecordQuery(this.queryState)); if (!data?.success) throw new Error(data?.message || "查詢失敗"); this.queryRecords = data.records || []; Object.assign(this.queryState, { page: data.page || 1, pages: data.pages || 1, total: data.total || 0 }); this.selectedRecords.clear(); this.renderRecordResults(); } catch (error) { this.toast(error.message || "查詢失敗", "err"); } finally { this.hideLoading(loading); }
    }
    renderRecordResults() {
      const doc = root.document, host = doc.getElementById("cvcs-q-results"), summary = doc.getElementById("cvcs-q-summary"), pager = doc.getElementById("cvcs-q-pager"); if (!host) return;
      summary.textContent = `共找到 ${this.queryState.total || 0} 筆記錄`;
      host.innerHTML = this.queryRecords.length ? this.queryRecords.map((record, index) => this.resultCard(record, "record", index)).join("") : `<div class="cvcs-empty">沒有資料</div>`;
      pager.innerHTML = `<button type="button" ${this.queryState.page <= 1 ? "disabled" : ""} data-page="${this.queryState.page - 1}">上一頁</button><span>第 ${this.queryState.page || 1} / ${this.queryState.pages || 1} 頁</span><button type="button" ${this.queryState.page >= this.queryState.pages ? "disabled" : ""} data-page="${this.queryState.page + 1}">下一頁</button>`;
      pager.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => this.loadRecords(Number(button.dataset.page))));
      this.bindResultCards("record");
    }
    resultCard(record, kind, index) {
      const selected = (kind === "record" ? this.selectedRecords : this.selectedBroken).has(record.recordId);
      const statuses = kind === "broken" ? brokenStatuses(record).map((status) => `<span class="cvcs-status ${status.toLowerCase().replaceAll(" ", "-")}">${escapeHtml(status)}</span>`).join("") : "";
      return `<article class="cvcs-result-card"><div class="cvcs-result-head"><label><input type="checkbox" data-${kind}-select="${index}" ${selected ? "checked" : ""}><strong>記錄 ${index + 1} · S/N ${escapeHtml(record.serialNo)}</strong></label><div>${statuses}<button data-${kind}-edit="${index}" type="button">編輯</button><button data-${kind}-delete="${index}" class="danger" type="button">刪除</button></div></div><dl>${visibleFields(record, kind).map((field) => `<div><dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(field.value)}</dd></div>`).join("")}</dl></article>`;
    }
    bindResultCards(kind) {
      const doc = root.document, records = kind === "record" ? this.queryRecords : this.brokenRecords, selected = kind === "record" ? this.selectedRecords : this.selectedBroken;
      doc.querySelectorAll(`[data-${kind}-select]`).forEach((box) => box.addEventListener("change", () => { const record = records[Number(box.dataset[`${kind}Select`])]; if (box.checked) selected.add(record.recordId); else selected.delete(record.recordId); }));
      doc.querySelectorAll(`[data-${kind}-edit]`).forEach((button) => button.addEventListener("click", () => this.editServerRecord(kind, records[Number(button.dataset[`${kind}Edit`])])));
      doc.querySelectorAll(`[data-${kind}-delete]`).forEach((button) => button.addEventListener("click", () => this.deleteServerRecord(kind, records[Number(button.dataset[`${kind}Delete`])])));
    }
    editableFields(kind) { return kind === "record" ? RECORD_FIELDS.filter(([key]) => key !== "property" && key !== "serialNo") : BROKEN_FIELDS.filter(([key]) => key !== "property" && key !== "serialNo"); }
    editServerRecord(kind, record) {
      this.openFormEditor({ title: `編輯 S/N ${record.serialNo}`, fields: this.editableFields(kind), record, onSave: async (changes) => {
        const action = kind === "record" ? "updateCvcsRecord" : "updateCvcsBrokenPart"; const loading = this.showLoading("資料儲存中，請稍等...");
        try { await this.transport.post({ action, record, changes }); this.closeOverlay(); this.toast("資料已更新", "ok"); if (kind === "record") this.loadRecords(this.queryState.page); else this.loadBroken(this.brokenState.page); } catch (error) { this.toast(error.message || "儲存失敗", "err"); } finally { this.hideLoading(loading); }
      } });
    }
    async deleteServerRecord(kind, record) {
      if (!root.confirm(`確定刪除 S/N ${record.serialNo}？`)) return;
      const loading = this.showLoading("刪除資料中，請稍等...");
      try { await this.transport.post({ action: kind === "record" ? "deleteCvcsRecord" : "deleteCvcsBrokenPart", record }); this.toast("記錄已刪除", "ok"); if (kind === "record") this.loadRecords(this.queryState.page); else this.loadBroken(this.brokenState.page); } catch (error) { this.toast(error.message || "刪除失敗", "err"); } finally { this.hideLoading(loading); }
    }
    async bulkRecords(remove) {
      const records = this.queryRecords.filter((record) => this.selectedRecords.has(record.recordId));
      if (!records.length) return this.toast("請先選取記錄", "err");
      if (remove) {
        if (!root.confirm(`確定刪除 ${records.length} 筆記錄？`)) return;
        const loading = this.showLoading("批量刪除中，請稍等..."); try { await this.transport.post({ action: "bulkDeleteCvcsRecords", records }); this.toast("記錄已刪除", "ok"); this.loadRecords(this.queryState.page); } catch (error) { this.toast(error.message || "刪除失敗", "err"); } finally { this.hideLoading(loading); } return;
      }
      this.openBulkEditor("record", records);
    }

    renderBrokenShell() {
      const host = root.document.getElementById("cvcsBrokenPage"); if (!host) return;
      host.innerHTML = `<div class="cvcs-shell"><div class="cvcs-page-head"><div><h2>CVCS 壞零件 / 跟進列表</h2><p>跨全部 Property</p></div></div><section class="cvcs-panel">
        <div class="cvcs-filter-grid cvcs-broken-filter"><label><span>場所 / Property</span><select id="cvcs-b-property">${this.selectOptions(PROPERTIES, this.brokenState.property, "全部")}</select></label><label><span>S/N</span><input id="cvcs-b-serial" value="${escapeHtml(this.brokenState.serialNo)}"></label><label><span>零件編號</span><input id="cvcs-b-parts" value="${escapeHtml(this.brokenState.partsNo)}"></label><label><span>狀態</span><select id="cvcs-b-status"><option value="">全部</option>${["Waiting Parts", "Repaired", "Following Up", "Follow-up Completed"].map((value) => `<option${this.brokenState.status === value ? " selected" : ""}>${value}</option>`).join("")}</select></label><label><span>排序</span><select id="cvcs-b-sort"><option value="newest">最新優先</option><option value="oldest"${this.brokenState.sort === "oldest" ? " selected" : ""}>最舊優先</option></select></label><button class="cvcs-primary" id="cvcs-b-search" type="button">篩選（搜尋）</button></div>
        <div class="cvcs-toolbar"><button id="cvcs-b-select" type="button">選取本頁</button><button id="cvcs-b-bulk" type="button">批量修改</button><button id="cvcs-b-xls" type="button">Excel</button><button id="cvcs-b-pdf" type="button">PDF</button><label>每頁 <select id="cvcs-b-size">${PAGE_SIZES.map((size) => `<option${size === this.brokenState.pageSize ? " selected" : ""}>${size}</option>`).join("")}</select></label></div>
        <div id="cvcs-b-summary" class="cvcs-summary">按篩選載入資料</div><div id="cvcs-b-results" class="cvcs-card-grid"></div><div id="cvcs-b-pager" class="cvcs-pager"></div></section></div>`;
      this.bindBroken();
    }
    bindBroken() {
      const doc = root.document;
      doc.getElementById("cvcs-b-search")?.addEventListener("click", () => this.loadBroken(1));
      doc.getElementById("cvcs-b-size")?.addEventListener("change", (event) => { this.brokenState.pageSize = Number(event.target.value); this.savePreferences(); this.loadBroken(1); });
      doc.getElementById("cvcs-b-select")?.addEventListener("click", () => { this.brokenRecords.forEach((record) => this.selectedBroken.add(record.recordId)); this.renderBrokenResults(); });
      doc.getElementById("cvcs-b-bulk")?.addEventListener("click", () => { const records = this.brokenRecords.filter((record) => this.selectedBroken.has(record.recordId)); if (!records.length) this.toast("請先選取記錄", "err"); else this.openBulkEditor("broken", records); });
      doc.getElementById("cvcs-b-xls")?.addEventListener("click", () => this.openExport("broken", "xls")); doc.getElementById("cvcs-b-pdf")?.addEventListener("click", () => this.openExport("broken", "pdf"));
    }
    readBrokenFilters() { const doc = root.document, value = (id) => doc.getElementById(id)?.value || ""; Object.assign(this.brokenState, { property: value("cvcs-b-property"), serialNo: value("cvcs-b-serial"), partsNo: value("cvcs-b-parts"), status: value("cvcs-b-status"), sort: value("cvcs-b-sort") }); }
    async loadBroken(page = 1) {
      this.readBrokenFilters(); this.brokenState.page = page; const loading = this.showLoading("CVCS 壞件列表載入中，請稍等...");
      try { const data = await this.transport.get(buildBrokenQuery(this.brokenState)); if (!data?.success) throw new Error(data?.message || "載入失敗"); this.brokenRecords = data.records || []; Object.assign(this.brokenState, { page: data.page || 1, pages: data.pages || 1, total: data.total || 0 }); this.selectedBroken.clear(); this.renderBrokenResults(); } catch (error) { this.toast(error.message || "載入失敗", "err"); } finally { this.hideLoading(loading); }
    }
    renderBrokenResults() {
      const doc = root.document, host = doc.getElementById("cvcs-b-results"), summary = doc.getElementById("cvcs-b-summary"), pager = doc.getElementById("cvcs-b-pager"); if (!host) return;
      summary.textContent = `共找到 ${this.brokenState.total || 0} 筆記錄`; host.innerHTML = this.brokenRecords.length ? this.brokenRecords.map((record, index) => this.resultCard(record, "broken", index)).join("") : `<div class="cvcs-empty">沒有資料</div>`;
      pager.innerHTML = `<button type="button" ${this.brokenState.page <= 1 ? "disabled" : ""} data-page="${this.brokenState.page - 1}">上一頁</button><span>第 ${this.brokenState.page || 1} / ${this.brokenState.pages || 1} 頁</span><button type="button" ${this.brokenState.page >= this.brokenState.pages ? "disabled" : ""} data-page="${this.brokenState.page + 1}">下一頁</button>`; pager.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => this.loadBroken(Number(button.dataset.page)))); this.bindResultCards("broken");
    }
    openBulkEditor(kind, records) {
      const fields = this.editableFields(kind); this.openFormEditor({ title: `批量修改 ${records.length} 筆記錄`, fields, record: {}, blankLabel: "留空代表不更改", onSave: async (changes) => {
        const filtered = Object.fromEntries(Object.entries(changes).filter(([, value]) => text(value))); if (!Object.keys(filtered).length) return this.toast("請輸入最少一項修改", "err");
        const action = kind === "record" ? "bulkUpdateCvcsRecords" : "bulkUpdateCvcsBrokenParts"; const loading = this.showLoading("批量修改中，請稍等...");
        try { await this.transport.post({ action, records, changes: filtered }); this.closeOverlay(); this.toast("批量修改完成", "ok"); if (kind === "record") this.loadRecords(this.queryState.page); else this.loadBroken(this.brokenState.page); } catch (error) { this.toast(error.message || "修改失敗", "err"); } finally { this.hideLoading(loading); }
      } });
    }
    openExport(kind, format) {
      const records = kind === "record" ? this.queryRecords : this.brokenRecords; if (!records.length) return this.toast("沒有可匯出的資料", "err");
      const fields = (kind === "record" ? RECORD_FIELDS : BROKEN_FIELDS).filter(([key]) => records.some((record) => text(record[key])));
      const body = `<div class="cvcs-export-fields">${fields.map(([key, label]) => `<label><input type="checkbox" value="${key}" checked> ${escapeHtml(label)}</label>`).join("")}</div>`;
      this.openOverlay("選擇匯出欄位", body, `<button data-close type="button">取消</button><button class="cvcs-primary" id="cvcs-export-confirm" type="button">開始匯出</button>`);
      root.document.getElementById("cvcs-export-confirm").addEventListener("click", () => { const selected = [...root.document.querySelectorAll(".cvcs-export-fields input:checked")].map((input) => input.value); this.exportRecords(records, fields.filter(([key]) => selected.includes(key)), format); this.closeOverlay(); });
    }
    exportRecords(records, fields, format) {
      const title = "CVCS Maintenance Record"; const table = `<table><thead><tr>${fields.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${records.map((record) => `<tr>${fields.map(([key]) => `<td>${escapeHtml(record[key])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      if (format === "pdf") { const win = root.open("", "_blank"); if (!win) return this.toast("請允許彈出視窗", "err"); win.document.write(`<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:12px Arial;margin:24px}h1{font-size:18px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:6px;text-align:left}</style><h1>${title}</h1>${table}`); win.document.close(); win.focus(); setTimeout(() => win.print(), 250); return; }
      const blob = new Blob([`<html><meta charset="utf-8"><body><h1>${title}</h1>${table}</body></html>`], { type: "application/vnd.ms-excel;charset=utf-8" }); const link = root.document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${title}.xls`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
    openFormEditor({ title, fields, record, onSave, blankLabel = "" }) {
      const body = `${blankLabel ? `<p class="cvcs-overlay-note">${escapeHtml(blankLabel)}</p>` : ""}<div class="cvcs-form-editor">${fields.map(([key, label]) => `<label><span>${escapeHtml(label)}</span>${this.editorControl(key, record[key])}</label>`).join("")}</div>`;
      this.openOverlay(title, body, `<button data-close type="button">取消</button><button class="cvcs-primary" id="cvcs-editor-save" type="button">儲存</button>`);
      root.document.getElementById("cvcs-editor-save").addEventListener("click", () => { const changes = Object.fromEntries(fields.map(([key]) => [key, root.document.querySelector(`[data-edit-field="${key}"]`)?.value || ""])); onSave(changes); });
    }
    editorControl(key, value) {
      if (key === "location") return `<select data-edit-field="${key}">${this.selectOptions(LOCATIONS, value, "不更改")}</select>`;
      if (key === "quarter") return `<select data-edit-field="${key}">${this.selectOptions(QUARTERS, value, "不更改")}</select>`;
      if (key === "model") return `<select data-edit-field="${key}">${this.selectOptions(MODELS, value, "不更改")}</select>`;
      if (/date|day/i.test(key)) return `<input data-edit-field="${key}" type="date" value="${escapeHtml(dateInput(value))}">`;
      return `<input data-edit-field="${key}" value="${escapeHtml(value)}">`;
    }
    openEditor({ title, note, value, onSave }) {
      this.openOverlay(title, `<p class="cvcs-overlay-note">${escapeHtml(note)}</p><textarea id="cvcs-option-editor">${escapeHtml(value)}</textarea>`, `<button data-close type="button">取消</button><button class="cvcs-primary" id="cvcs-option-save" type="button">儲存</button>`);
      root.document.getElementById("cvcs-option-save").addEventListener("click", () => onSave(root.document.getElementById("cvcs-option-editor").value));
    }
    openOverlay(title, body, actions) {
      this.closeOverlay(); const overlay = root.document.createElement("div"); overlay.id = "cvcs-overlay"; overlay.className = "cvcs-overlay"; overlay.innerHTML = `<div class="cvcs-overlay-box"><div class="cvcs-overlay-head"><h3>${escapeHtml(title)}</h3><button data-close type="button">關閉</button></div>${body}<div class="cvcs-overlay-actions">${actions}</div></div>`; root.document.body.appendChild(overlay); overlay.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => this.closeOverlay())); overlay.addEventListener("click", (event) => { if (event.target === overlay) this.closeOverlay(); });
    }
    closeOverlay() { root?.document?.getElementById("cvcs-overlay")?.remove(); }
  }

  function createApplication(options) { return new CvcsApplication(options); }

  return {
    BROKEN_FIELDS, LOCATIONS, MODELS, PAGE_SIZES, PROPERTIES, QUARTERS, RECORD_FIELDS,
    CvcsApplication, brokenStatuses, buildBrokenPart, buildBrokenQuery, buildRecord, buildRecordQuery,
    actionForReason, createApplication, createDefaultForm, rankOptions, todayIso, visibleFields,
  };
}));
