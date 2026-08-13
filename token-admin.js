(function attachTokenAdmin(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AmrsTokenAdmin = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createTokenAdminModule(root) {
  "use strict";

  const PERMISSIONS = Object.freeze([
    ["schedule", "工作安排"], ["ae", "SAE / TAE"], ["cvcs", "CVCS"], ["admin", "Token 管理"],
  ]);
  function text(value) { return String(value == null ? "" : value).trim(); }
  function esc(value) { return text(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
  function normalizeTokenForm(input = {}) {
    const label = text(input.label); if (!label) throw new Error("Token label is required");
    const requested = new Set(Array.isArray(input.permissions) ? input.permissions.map(text) : []);
    const permissions = PERMISSIONS.map(([key]) => key).filter((key) => requested.has(key));
    if (!permissions.length) throw new Error("At least one permission is required");
    return { label, note: text(input.note), permissions };
  }
  function tokenView(record = {}) {
    return {
      id: text(record.id), tokenSuffix: text(record.tokenSuffix), maskedToken: `•••• ${text(record.tokenSuffix)}`,
      label: text(record.label), note: text(record.note), permissions: (record.permissions || []).map(text),
      status: text(record.status) || "active", createdAt: Number(record.createdAt) || 0,
      updatedAt: Number(record.updatedAt) || 0, lastUsedAt: record.lastUsedAt == null ? null : Number(record.lastUsedAt),
    };
  }
  function dateTime(value) { return value ? new Date(Number(value)).toLocaleString("zh-HK", { hour12: false }) : "從未使用"; }

  class TokenAdminApplication {
    constructor(options = {}) { this.transport = options.transport; this.toast = options.toast || (() => {}); this.showLoading = options.showLoading || (() => null); this.hideLoading = options.hideLoading || (() => {}); this.records = []; }
    mount() {
      const host = root?.document?.getElementById("tokenAdminPage"); if (!host) return;
      if (this.transport?.getState?.().legacy) {
        host.innerHTML = `<div class="cvcs-shell"><div class="cvcs-page-head"><div><h2>Token 管理初始化</h2><p>先建立第一個管理員 Token，之後請用新 Token 重新登入。</p></div></div><section class="cvcs-panel"><p class="cvcs-overlay-note">這個步驟只可執行一次。完整 Token 只會顯示一次。</p><button class="cvcs-primary" id="token-bootstrap" type="button">建立管理員 Token</button></section></div>`;
        root.document.getElementById("token-bootstrap").addEventListener("click", () => this.bootstrap());
        return;
      }
      host.innerHTML = `<div class="cvcs-shell"><div class="cvcs-page-head"><div><h2>Token 管理</h2><p>管理同事權限；完整 Token 只會在新增後顯示一次。</p></div><button class="cvcs-primary" id="token-create" type="button">＋ 新增 Token</button></div><section class="cvcs-panel"><div class="cvcs-toolbar"><button id="token-refresh" type="button">重新整理</button></div><div id="token-list" class="token-list"><div class="cvcs-empty">載入中...</div></div></section></div>`;
      root.document.getElementById("token-create").addEventListener("click", () => this.openForm()); root.document.getElementById("token-refresh").addEventListener("click", () => this.load()); this.load();
    }
    async bootstrap() {
      if (!root.confirm("確定建立第一個管理員 Token？")) return;
      const loading = this.showLoading("管理員 Token 建立中，請稍等...");
      try { const data = await this.transport.post({ action: "bootstrapAccessToken", label: "System Owner" }); if (!data?.success || !data.token) throw new Error(data?.message || "建立失敗"); this.showCreatedToken(data.token, data.record); } catch (error) { this.toast(error.message || "管理員 Token 建立失敗", "err"); } finally { this.hideLoading(loading); }
    }
    async load() {
      if (!this.transport) return; const loading = this.showLoading("Token 資料載入中，請稍等...");
      try { const data = await this.transport.get(new URLSearchParams({ action: "listAccessTokens" })); if (!data?.success) throw new Error(data?.message || "載入失敗"); this.records = (data.tokens || []).map(tokenView); this.render(); } catch (error) { this.toast(error.message || "Token 載入失敗", "err"); } finally { this.hideLoading(loading); }
    }
    render() {
      const host = root.document.getElementById("token-list"); if (!host) return;
      host.innerHTML = this.records.length ? this.records.map((record, index) => `<article class="token-card"><div><strong>${esc(record.label)}</strong><span>${esc(record.maskedToken)}</span></div><p>${esc(record.note || "沒有備註")}</p><div class="token-permissions">${record.permissions.map((permission) => `<span>${esc(PERMISSIONS.find(([key]) => key === permission)?.[1] || permission)}</span>`).join("")}</div><dl><div><dt>狀態</dt><dd class="${record.status === "active" ? "token-active" : "token-suspended"}">${record.status === "active" ? "啟用" : "已停用"}</dd></div><div><dt>建立</dt><dd>${esc(dateTime(record.createdAt))}</dd></div><div><dt>最後使用</dt><dd>${esc(dateTime(record.lastUsedAt))}</dd></div></dl><div class="token-actions"><button data-token-edit="${index}" type="button">編輯</button><button data-token-toggle="${index}" type="button">${record.status === "active" ? "停用" : "重新啟用"}</button><button data-token-delete="${index}" class="danger" type="button">刪除</button></div></article>`).join("") : `<div class="cvcs-empty">未有個人 Token</div>`;
      host.querySelectorAll("[data-token-edit]").forEach((button) => button.addEventListener("click", () => this.openForm(this.records[Number(button.dataset.tokenEdit)])));
      host.querySelectorAll("[data-token-toggle]").forEach((button) => button.addEventListener("click", () => { const record = this.records[Number(button.dataset.tokenToggle)]; this.update(record, { status: record.status === "active" ? "suspended" : "active" }); }));
      host.querySelectorAll("[data-token-delete]").forEach((button) => button.addEventListener("click", () => this.remove(this.records[Number(button.dataset.tokenDelete)])));
    }
    permissionControls(selected = []) { const values = new Set(selected); return PERMISSIONS.map(([key, label]) => `<label><input type="checkbox" value="${key}" ${values.has(key) ? "checked" : ""}> ${esc(label)}</label>`).join(""); }
    openForm(record = null) {
      this.openModal(record ? "編輯 Token" : "新增 Token", `<div class="token-form"><label><span>標記名稱 *</span><input id="token-label" value="${esc(record?.label)}" placeholder="例如：同事姓名或裝置"></label><label><span>備註</span><input id="token-note" value="${esc(record?.note)}" placeholder="選填"></label><fieldset><legend>可使用功能 *</legend>${this.permissionControls(record?.permissions)}</fieldset></div>`, `<button data-close type="button">取消</button><button class="cvcs-primary" id="token-save" type="button">${record ? "儲存" : "新增"}</button>`);
      root.document.getElementById("token-save").addEventListener("click", () => {
        try { const value = normalizeTokenForm({ label: root.document.getElementById("token-label").value, note: root.document.getElementById("token-note").value, permissions: [...root.document.querySelectorAll(".token-form fieldset input:checked")].map((input) => input.value) }); if (record) this.update(record, value, true); else this.create(value); } catch (error) { this.toast(error.message, "err"); }
      });
    }
    async create(value) {
      const loading = this.showLoading("Token 新增中，請稍等...");
      try { const data = await this.transport.post({ action: "createAccessToken", ...value }); if (!data?.success || !data.token) throw new Error(data?.message || "新增失敗"); this.showCreatedToken(data.token, data.record); } catch (error) { this.toast(error.message || "新增 Token 失敗", "err"); } finally { this.hideLoading(loading); }
    }
    showCreatedToken(token, record) {
      this.openModal("Token 已建立", `<p class="cvcs-overlay-note">請立即交給對應同事並妥善保存。關閉後系統無法再次顯示完整 Token。</p><div class="token-created"><code id="created-token">${esc(token)}</code><button id="copy-created-token" type="button">複製</button></div><strong>${esc(record?.label)}</strong>`, `<button class="cvcs-primary" id="token-created-done" type="button">我已保存</button>`);
      root.document.getElementById("copy-created-token").addEventListener("click", async () => { try { await root.navigator.clipboard.writeText(token); this.toast("Token 已複製", "ok"); } catch { this.toast("無法自動複製，請手動選取", "err"); } });
      root.document.getElementById("token-created-done").addEventListener("click", () => { this.closeModal(); if (this.transport?.getState?.().legacy) { this.toast("請按右上設定，改用新管理員 Token 登入", "ok"); this.mount(); } else this.load(); });
    }
    async update(record, changes, close = false) {
      const loading = this.showLoading("Token 更新中，請稍等..."); try { const data = await this.transport.post({ action: "updateAccessToken", id: record.id, ...changes }); if (!data?.success) throw new Error(data?.message || "更新失敗"); if (close) this.closeModal(); this.toast("Token 已更新", "ok"); this.load(); } catch (error) { this.toast(error.message || "更新 Token 失敗", "err"); } finally { this.hideLoading(loading); }
    }
    async remove(record) {
      if (!root.confirm(`確定永久刪除 ${record.label} 的 Token？`)) return; const loading = this.showLoading("Token 刪除中，請稍等..."); try { await this.transport.post({ action: "deleteAccessToken", id: record.id }); this.toast("Token 已刪除", "ok"); this.load(); } catch (error) { this.toast(error.message || "刪除 Token 失敗", "err"); } finally { this.hideLoading(loading); }
    }
    openModal(title, body, actions) { this.closeModal(); const overlay = root.document.createElement("div"); overlay.id = "token-overlay"; overlay.className = "cvcs-overlay"; overlay.innerHTML = `<div class="cvcs-overlay-box"><div class="cvcs-overlay-head"><h3>${esc(title)}</h3><button data-close type="button">關閉</button></div>${body}<div class="cvcs-overlay-actions">${actions}</div></div>`; root.document.body.appendChild(overlay); overlay.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => this.closeModal())); }
    closeModal() { root?.document?.getElementById("token-overlay")?.remove(); }
  }
  function createApplication(options) { return new TokenAdminApplication(options); }
  return { PERMISSIONS, TokenAdminApplication, createApplication, normalizeTokenForm, tokenView };
}));
