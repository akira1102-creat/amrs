(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AmrsFollowupLog = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const STATUS = { pending: '待跟進', progress: '跟進中', waiting: '等待回覆', completed: '已完成' };
  const text = value => String(value ?? '').trim();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const id = () => root.crypto.randomUUID();
  const time = (value, compact = false) => value ? new Date(value).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false, ...(compact ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } : {}) }) : '';
  const options = (values, selected) => values.map(([value, label]) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
  const peopleHtml = people => (people || []).map(name => `<span class="fl-person">${esc(name)}</span>`).join('') || '<span class="fl-muted">未填寫</span>';
  function renderCard(entry) {
    return `<button type="button" class="fl-row ${entry.priority === 'urgent' && entry.status !== 'completed' ? 'fl-urgent' : ''}" data-fl-open="${esc(entry.id)}" aria-label="查看事項：${esc(entry.title)}">
      <span class="fl-row-status"><span class="fl-status fl-${esc(entry.status)}">${esc(STATUS[entry.status] || entry.status)}</span>${entry.priority === 'urgent' ? '<span class="fl-priority">緊急</span>' : ''}</span>
      <span class="fl-row-venue">${esc(entry.venue)}</span>
      <span class="fl-row-main"><span class="fl-row-title">${esc(entry.title)}</span>${entry.content ? `<span class="fl-row-preview">${esc(entry.content)}</span>` : ''}${entry.dueDate ? `<span class="fl-row-due">跟進日期：${esc(entry.dueDate)}</span>` : ''}</span>
      <span class="fl-row-people"><span class="fl-row-label">知悉同事：</span><span class="fl-row-names">${esc((entry.knownPeople || []).join('、') || '未填寫')}</span></span>
      <span class="fl-row-updated"><span class="fl-row-time-full">${esc(time(entry.updatedAt)) || '—'}</span><span class="fl-row-time-short">${esc(time(entry.updatedAt, true)) || '—'}</span></span>
      <span class="fl-row-comments">${Number(entry.commentCount) || 0} 則留言<span class="fl-row-arrow" aria-hidden="true"> ›</span></span></button>`;
  }
  class Application {
    constructor(dependencies = {}) {
      this.document = dependencies.document || root.document;
      this.transport = dependencies.transport;
      this.toast = dependencies.toast || (() => {});
      this.confirm = dependencies.confirm || (message => root.confirm(message));
      this.venues = dependencies.venues || {};
      this.people = dependencies.people || (() => []);
      this.storage = dependencies.storage;
      this.onRead = dependencies.onRead || (() => {});
      this.onChange = dependencies.onChange || (() => {});
      this.filters = { company: '', venue: '', status: 'active', search: '' };
      this.entries = []; this.total = 0; this.page = 1; this.pageSize = 50; this.summary = {};
      this.loading = false; this.busy = false; this.error = ''; this.seq = 0; this.detailSeq = 0;
      this.modal = null; this.bound = false; this.pendingPayload = null; this.unknownWrite = false;
      this.filtersOpen = false;
    }
    host() { return this.document.getElementById('followupLogPage'); }
    isBusy() { return this.busy || this.unknownWrite || !!(this.modal && this.modalDirty); }
    async mount() {
      const host = this.host();
      if (!host) return;
      if (!this.bound) {
        this.bound = true;
        host.addEventListener('click', event => this.click(event));
        host.addEventListener('change', event => this.change(event));
        host.addEventListener('toggle', event => { if (event.target.classList?.contains('fl-filter-panel')) this.filtersOpen = event.target.open; }, true);
        host.addEventListener('input', event => { if (event.target.closest('.fl-modal')) this.modalDirty = true; });
        host.addEventListener('keydown', event => { if (event.key === 'Escape' && this.modal) this.closeModal(); if (event.key === 'Enter' && event.target.id === 'flSearch') { event.preventDefault(); this.applyFilters(); } });
      }
      this.render();
      await this.load();
    }
    async load(page = this.page) {
      const seq = ++this.seq;
      this.loading = true; this.error = ''; this.page = page; this.render();
      try {
        const result = await this.transport.get(new URLSearchParams({ action: 'followupLog', ...this.filters, page: String(page) }).toString());
        if (seq !== this.seq) return;
        if (!result?.success) throw new Error(result?.message || '日誌載入失敗');
        this.entries = result.entries || []; this.total = result.total; this.pageSize = result.pageSize || 50; this.summary = result.summary || {};
      } catch (error) { if (seq === this.seq) this.error = error.message || '日誌載入失敗'; }
      finally { if (seq === this.seq) { this.loading = false; this.render(); } }
    }
    render() {
      const host = this.host(); if (!host || this.modal) return;
      host.innerHTML = `<section class="fl-page"><div class="fl-header"><div><h2>跟進日誌</h2><p class="fl-muted">場地事項、留言及進展</p></div><div class="fl-actions"><button type="button" data-fl="refresh"${this.loading ? ' disabled' : ''}>${this.loading ? '正在載入…' : '重新載入'}</button><button class="fl-primary" type="button" data-fl="new">新增事項</button></div></div>
        <div class="fl-summary"><span>未完成 <strong>${this.summary.active || 0}</strong></span><span>緊急 <strong>${this.summary.urgent || 0}</strong></span><span>已完成 <strong>${this.summary.completed || 0}</strong></span></div>
        <details class="fl-filter-panel"${this.filtersOpen ? ' open' : ''}><summary>篩選或搜尋</summary><div class="fl-filters"><label>公司篩選<select id="flCompany">${options([['', '全部公司'], ['ALL', '全部場地通知'], ...Object.keys(this.venues).map(v => [v, v])], this.filters.company)}</select></label>
        <label>場地篩選<input id="flVenue" list="flVenueList" value="${esc(this.filters.venue)}" placeholder="全部場地"><datalist id="flVenueList">${(this.filters.company ? this.venues[this.filters.company] || [] : Object.values(this.venues).flat()).map(v => `<option value="${esc(v)}"></option>`).join('')}</datalist></label>
        <label>狀態篩選<select id="flStatus">${options([['active', '未完成'], ['all', '全部'], ...Object.entries(STATUS)], this.filters.status)}</select></label>
        <label class="fl-search">搜尋<input id="flSearch" value="${esc(this.filters.search)}" placeholder="標題、內容、場地或知悉同事"></label><button type="button" data-fl="search">搜尋</button></div></details>
        <p class="fl-message${this.error ? ' fl-error' : ''}" role="status">${esc(this.error || (this.loading ? '正在讀取雲端資料…' : `共 ${this.total} 項`))}</p>
        <div class="fl-list"><div class="fl-list-head" aria-hidden="true"><span>狀態</span><span>場地</span><span>事項</span><span>知悉同事</span><span>最後更新</span><span>留言</span></div>${this.entries.map(entry => `<div class="fl-list-item">${renderCard(entry)}<div class="fl-delete-cell"><button type="button" class="fl-delete" data-fl-delete="${esc(entry.id)}" aria-label="刪除事項：${esc(entry.title)}">刪除</button></div></div>`).join('') || (!this.loading ? '<div class="fl-empty">未有符合條件的事項。按「新增事項」開始記錄。</div>' : '')}</div>
        <div class="fl-pagination"><button type="button" data-fl="prev"${this.page <= 1 || this.loading ? ' disabled' : ''}>上一頁</button><span>第 ${this.page} 頁</span><button type="button" data-fl="next"${this.page * this.pageSize >= this.total || this.loading ? ' disabled' : ''}>下一頁</button></div></section>`;
    }
    value(name) { return text(this.host()?.querySelector(`#${name}`)?.value); }
    applyFilters() {
      this.filters = { company: this.value('flCompany'), venue: this.value('flVenue'), status: this.value('flStatus') || 'active', search: this.value('flSearch') };
      return this.load(1);
    }
    async click(event) {
      const button = event.target.closest('button'); if (!button || button.disabled) return;
      const action = button.dataset.fl;
      if (button.dataset.flOpen) return this.openDetail(button.dataset.flOpen);
      if (button.dataset.flDelete) return this.openDelete(this.entries.find(entry => entry.id === button.dataset.flDelete));
      if (button.dataset.flRemove) { this.knownPeople = this.knownPeople.filter(name => name !== button.dataset.flRemove); this.renderPeople(); this.modalDirty = true; return; }
      if (action === 'refresh') return this.load();
      if (action === 'search') return this.applyFilters();
      if (action === 'prev' || action === 'next') return this.load(this.page + (action === 'prev' ? -1 : 1));
      if (action === 'new') return this.openEditor();
      if (action === 'close') return this.closeModal();
      if (action === 'edit') return this.openEditor(this.detail.entry);
      if (action === 'save') return this.saveEditor();
      if (action === 'comment') return this.saveComment();
      if (action === 'delete') return this.openDelete(this.detail.entry);
      if (action === 'delete-confirm') return this.confirmDelete();
      if (action === 'add-person') {
        const name = this.value('flPerson'); if (!name || name.length > 60) return;
        this.knownPeople = [...new Set([...this.knownPeople, name])]; this.renderPeople(); this.host().querySelector('#flPerson').value = ''; this.modalDirty = true;
      }
    }
    change(event) {
      if (event.target.id === 'flEditCompany') {
        const company = this.value('flEditCompany');
        const input = this.host().querySelector('#flEditVenue'); input.value = company === 'ALL' ? '全部場地' : ''; input.disabled = company === 'ALL';
        this.host().querySelector('#flEditVenueList').innerHTML = (this.venues[company] || []).map(v => `<option value="${esc(v)}"></option>`).join('');
      } else if (event.target.id === 'flCompany') { this.host().querySelector('#flVenue').value = ''; this.applyFilters(); }
      else if (event.target.id === 'flStatus') this.applyFilters();
    }
    closeModal(force = false) {
      if (this.busy || (!force && this.unknownWrite)) { this.toast('正在確認儲存結果，請勿關閉；可重試同一筆儲存', 'err'); return false; }
      if (!force && this.modalDirty && !this.confirm('尚未儲存的內容會被放棄，確定關閉？')) return false;
      this.detailSeq++; this.modal = null; this.modalDirty = false; this.pendingPayload = null; this.render();
      this.lastFocus?.focus?.(); return true;
    }
    deactivate() {
      if (this.modal) return this.closeModal();
      if (this.busy || this.unknownWrite) return false;
      this.detailSeq++; return true;
    }
    showModal(title, content, actions) {
      if (this.modal && !this.closeModal()) return false;
      this.lastFocus = this.document.activeElement; this.modal = true; this.modalDirty = false; this.unknownWrite = false;
      const host = this.host();
      host.insertAdjacentHTML('beforeend', `<div class="fl-overlay"><section class="fl-modal" role="dialog" aria-modal="true" aria-labelledby="flModalTitle"><div class="fl-modal-head"><h3 id="flModalTitle">${esc(title)}</h3><button type="button" data-fl="close" aria-label="關閉">×</button></div><div class="fl-modal-content">${content}</div><p id="flModalMessage" class="fl-message" role="status"></p><div class="fl-actions fl-modal-actions">${actions}<button type="button" data-fl="close">關閉</button></div></section></div>`);
      setTimeout(() => host.querySelector('.fl-modal input, .fl-modal button')?.focus(), 0);
      return true;
    }
    async openDetail(entryId) {
      if (this.busy || this.modal) return;
      const seq = ++this.detailSeq;
      this.toast('正在載入事項…', 'info');
      try {
        const result = await this.transport.get(new URLSearchParams({ action: 'followupLog', id: entryId }).toString());
        if (seq !== this.detailSeq) return;
        if (!result?.success) throw new Error(result?.message || '事項載入失敗');
        this.detail = result;
        let author = ''; try { author = this.storage?.getItem('_amrs_log_comment_name') || ''; } catch {}
        const shown = this.showModal(result.entry.title, `<p>${esc(result.entry.venue)} · <span class="fl-status fl-${esc(result.entry.status)}">${esc(STATUS[result.entry.status])}</span>${result.entry.priority === 'urgent' ? ' · 緊急' : ''}</p>
          <p class="fl-full-content">${esc(result.entry.content || '未填寫內容')}</p><div class="fl-people"><span class="fl-muted">知悉同事</span>${peopleHtml(result.entry.knownPeople)}</div>
          ${result.entry.dueDate ? `<p>跟進日期：${esc(result.entry.dueDate)}</p>` : ''}<p class="fl-muted">建立：${esc(time(result.entry.createdAt))}<br>更新：${esc(time(result.entry.updatedAt))}</p>
          <h4>留言及進展</h4><div class="fl-comments">${result.comments.map(comment => `<article class="fl-comment"><div><strong>${esc(comment.name)}</strong><small>${esc(time(comment.createdAt))}</small></div><p>${esc(comment.content)}</p></article>`).join('') || '<p class="fl-muted">未有留言</p>'}</div>
          <div class="fl-comment-form"><label>留言者姓名<input id="flAuthor" list="flNames" value="${esc(author)}" maxlength="60" placeholder="輸入或選擇姓名"></label>${this.namesList()}<label>留言<textarea id="flComment" maxlength="4000" rows="3" placeholder="記錄最新進展或需要留意的事情"></textarea></label><button class="fl-primary" type="button" data-fl="comment">發佈留言</button></div>`, '<button type="button" data-fl="edit">修改事項／狀態</button><button type="button" class="fl-delete" data-fl="delete">刪除事項</button>');
        if (shown) this.onRead(result.entry);
        this.commentId = id();
      } catch (error) { this.toast(error.message || '事項載入失敗', 'err'); }
    }
    namesList() {
      const names = [...new Set([...this.people(), ...this.entries.flatMap(entry => entry.knownPeople || [])])];
      return `<datalist id="flNames">${names.map(name => `<option value="${esc(name)}"></option>`).join('')}</datalist>`;
    }
    openDelete(entry) {
      if (this.busy || !entry) return;
      if (!this.showModal('確認刪除事項', `<p>確定要刪除以下事項？</p><p><strong>${esc(entry.title)}</strong></p><p class="fl-muted">場地：${esc(entry.venue)}</p><p>確認後，此事項及留言將不再顯示於跟進日誌。</p>`, '<button type="button" class="fl-delete" data-fl="delete-confirm">確認刪除</button>')) return;
      this.deleting = entry;
    }
    async confirmDelete() {
      if (!this.deleting) return;
      const result = await this.write({action:'deleteFollowupLog', id:this.deleting.id, baseVersion:this.deleting.version});
      if (!result) return;
      this.closeModal(true); this.deleting = null; this.toast('事項已刪除', 'ok'); await this.load(); this.onChange();
    }
    openEditor(entry = null) {
      if (this.busy) return;
      const company = entry?.company || 'ALL';
      if (!this.showModal(entry ? '修改事項' : '新增事項', `<div class="fl-edit-grid"><label>公司<select id="flEditCompany">${options([['ALL', '全部場地'], ...Object.keys(this.venues).map(v => [v, v])], company)}</select></label><label>場地<input id="flEditVenue" list="flEditVenueList" value="${esc(entry?.venue || (company === 'ALL' ? '全部場地' : ''))}"${company === 'ALL' ? ' disabled' : ''}><datalist id="flEditVenueList">${(this.venues[company] || []).map(v => `<option value="${esc(v)}"></option>`).join('')}</datalist></label>
        <label class="fl-wide">標題 *<input id="flTitle" value="${esc(entry?.title)}" maxlength="160" placeholder="簡短講述要跟進的事情"></label><label class="fl-wide">內容<textarea id="flContent" maxlength="8000" rows="4">${esc(entry?.content)}</textarea></label>
        <label>狀態<select id="flEditStatus">${options(Object.entries(STATUS), entry?.status || 'pending')}</select></label><label>優先程度<select id="flPriority">${options([['normal', '一般'], ['urgent', '緊急']], entry?.priority || 'normal')}</select></label><label>跟進日期（選填）<input id="flDueDate" type="date" value="${esc(entry?.dueDate)}"></label>
        <div class="fl-wide"><label>知悉同事（選填）</label><div id="flPeople" class="fl-people"></div><div class="fl-add-person"><input id="flPerson" list="flNames" maxlength="60" placeholder="輸入或選擇姓名">${this.namesList()}<button type="button" data-fl="add-person">加入</button></div><small class="fl-muted">只表示知道此事，不代表處理責任。</small></div></div>`, '<button class="fl-primary" type="button" data-fl="save">儲存到雲端</button>')) return;
      this.editing = entry; this.editorId = entry?.id || id(); this.knownPeople = [...(entry?.knownPeople || [])];
      this.renderPeople();
    }
    renderPeople() {
      this.host().querySelector('#flPeople').innerHTML = this.knownPeople.map(name => `<span class="fl-person">${esc(name)}<button type="button" data-fl-remove="${esc(name)}" aria-label="移除${esc(name)}">×</button></span>`).join('') || '<span class="fl-muted">未選擇同事</span>';
    }
    modalMessage(message, error = false) {
      const el = this.host()?.querySelector('#flModalMessage'); if (el) { el.textContent = message; el.classList.toggle('fl-error', error); }
    }
    async write(payload) {
      if (this.busy) return null;
      this.busy = true; this.pendingPayload = this.pendingPayload || payload;
      const modal = this.host()?.querySelector('.fl-modal');
      modal?.querySelectorAll('button,input,select,textarea').forEach(el => { if (!Object.hasOwn(el.dataset, 'flDisabled')) el.dataset.flDisabled = el.disabled ? '1' : ''; el.disabled = true; });
      this.modalMessage('正在儲存到雲端…');
      try {
        const result = await this.transport.post(this.pendingPayload);
        if (!result?.success) throw new Error(result?.message || '儲存失敗');
        this.pendingPayload = null; this.unknownWrite = false; this.modalDirty = false;
        return result;
      } catch (error) {
        this.unknownWrite = !!error.unknownOutcome;
        if (!this.unknownWrite) this.pendingPayload = null;
        this.modalMessage(this.unknownWrite ? '尚未確認儲存結果，請重試同一筆儲存；不要修改內容或關閉。' : error.message || '儲存失敗，內容仍然保留', true);
        this.toast(error.message || '儲存失敗', 'err'); return null;
      } finally {
        this.busy = false;
        modal?.querySelectorAll('button,input,select,textarea').forEach(el => { el.disabled = this.unknownWrite ? !['save','comment','delete-confirm'].includes(el.dataset.fl) : el.dataset.flDisabled === '1'; if (!this.unknownWrite) delete el.dataset.flDisabled; });
      }
    }
    async saveEditor() {
      const entry = { company: this.value('flEditCompany'), venue: this.value('flEditVenue'), title: this.value('flTitle'), content: this.value('flContent'), status: this.value('flEditStatus'), priority: this.value('flPriority'), dueDate: this.value('flDueDate'), knownPeople: this.knownPeople };
      if (!entry.title || (!entry.venue && entry.company !== 'ALL')) { this.modalMessage('請填寫標題及場地', true); return; }
      const result = await this.write({ action: this.editing ? 'updateFollowupLog' : 'createFollowupLog', id: this.editorId, baseVersion: this.editing?.version, entry });
      if (!result) return;
      this.closeModal(true); this.toast('事項已儲存', 'ok'); await this.load(); await this.openDetail(result.entry.id); this.onChange();
    }
    async saveComment() {
      const name = this.value('flAuthor'), content = this.value('flComment');
      if (!name || !content) { this.modalMessage('請填寫留言者姓名及留言內容', true); return; }
      const entryId = this.detail.entry.id;
      const result = await this.write({ action: 'addFollowupComment', id: this.commentId, entryId, name, content });
      if (!result) return;
      try { this.storage?.setItem('_amrs_log_comment_name', name); } catch {}
      this.closeModal(true); this.toast('留言已儲存', 'ok'); await this.load(); await this.openDetail(entryId); this.onChange();
    }
  }
  class Notifications {
    constructor(dependencies = {}) {
      this.document = dependencies.document || root.document;
      this.storage = dependencies.storage;
      this.transport = dependencies.transport;
      this.onNavigate = dependencies.onNavigate || (() => {});
      this.canRefresh = dependencies.canRefresh || (() => true);
      this.now = dependencies.now || (() => Date.now());
      this.lastActivityAt = this.now();
      this.activityEvents = ['pointerdown', 'pointermove', 'keydown', 'input', 'wheel', 'touchstart', 'scroll'];
      this.activityListener = () => {
        if (this.document?.hidden || this.timer === null) return;
        const wasIdle = this.isIdle();
        this.lastActivityAt = this.now();
        if (wasIdle) {
          root.clearInterval(this.timer);
          this.timer = root.setInterval(() => void this.refresh(), 180000);
          void this.refresh();
        }
      };
      this.entries = []; this.seq = 0; this.loading = false; this.timer = null; this.bound = false; this.expanded = true;
      this.read = Object.create(null);
      try {
        const saved = JSON.parse(this.storage?.getItem('_amrs_log_read_v1') || '{}');
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) for (const [key,value] of Object.entries(saved)) if (typeof value === 'string') this.read[key] = value;
      } catch {}
    }
    host() { return this.document?.getElementById('followupNotice'); }
    unread() { return this.entries.filter(entry => entry.revision && this.read[entry.id] !== entry.revision); }
    markRead(entry) {
      if (!entry?.id || !entry.revision) return;
      this.read[entry.id] = entry.revision;
      try { this.storage?.setItem('_amrs_log_read_v1', JSON.stringify(this.read)); } catch {}
      this.render();
    }
    start() {
      if (this.timer !== null) return;
      this.lastActivityAt = this.now();
      for (const type of this.activityEvents) this.document?.addEventListener?.(type, this.activityListener, { passive: true, capture: true });
      this.timer = root.setInterval(() => void this.refresh(), 180000);
      void this.refresh();
    }
    stop() {
      if (this.timer !== null) root.clearInterval(this.timer);
      for (const type of this.activityEvents) this.document?.removeEventListener?.(type, this.activityListener, { capture: true });
      this.timer = null; this.seq++; this.loading = false; this.entries = []; this.render();
    }
    isIdle() { return this.now() - this.lastActivityAt >= 600000; }
    async refresh() {
      if (this.loading || this.isIdle() || !this.canRefresh()) return;
      const seq = ++this.seq; this.loading = true;
      try {
        const result = await this.transport.get('action=followupNotifications&notificationPoll=idle-v1');
        if (seq !== this.seq || !this.canRefresh()) return;
        if (result?.success) { this.entries = result.entries || []; this.render(); }
      } catch {} // Keep the last confirmed unread list during transient network failures.
      finally { if (seq === this.seq) this.loading = false; }
    }
    render() {
      const host = this.host(); if (!host) return;
      if (!this.bound) {
        this.bound = true;
        host.addEventListener('click', event => {
          const button = event.target.closest('button[data-fl-notice]');
          if (button) this.onNavigate(button.dataset.flNotice);
        });
        host.addEventListener('toggle', event => { if (event.target.classList?.contains('fl-notice-panel')) this.expanded = event.target.open; }, true);
      }
      const unread = this.unread(); host.hidden = !unread.length;
      host.innerHTML = unread.length ? `<details class="fl-notice-panel"${this.expanded ? ' open' : ''}><summary>跟進日誌 · ${unread.length} 項未讀<span>按事項查看</span></summary><div class="fl-notice-list">${unread.map(entry => `<button type="button" data-fl-notice="${esc(entry.id)}" class="${entry.priority === 'urgent' ? 'fl-notice-urgent' : ''}"><span>${esc(entry.venue)}</span><strong>${esc(entry.title)}</strong><span class="fl-status fl-${esc(entry.status)}">${esc(STATUS[entry.status] || entry.status)}</span><span aria-hidden="true">›</span></button>`).join('')}</div></details>` : '';
    }
  }
  return { STATUS, renderCard, createApplication: dependencies => new Application(dependencies), createNotifications: dependencies => new Notifications(dependencies) };
}));
