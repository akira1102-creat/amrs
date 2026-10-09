import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = fs.existsSync(new URL('../followup-log.js', import.meta.url)) ? fs.readFileSync(new URL('../followup-log.js', import.meta.url), 'utf8') : '';
const context = vm.createContext({ module: { exports: {} }, setTimeout, clearTimeout, URLSearchParams, crypto: globalThis.crypto });
vm.runInContext(source, context);
const log = context.module.exports;

test('log cards escape content and show known colleagues without responsibility or acknowledgement', () => {
  assert.equal(typeof log.renderCard, 'function');
  const card = log.renderCard({ id: 'test-id', title: '<img src=x>', venue: 'Test Venue', content: 'First\nSecond', status: 'pending', knownPeople: ['Operator A'], commentCount: 2 });
  assert.match(card, /&lt;img src=x&gt;/);
  assert.doesNotMatch(card, /<img|負責人|我已知悉/);
  assert.match(card, /輸入者/);
  assert.match(card, /Operator A/);
  assert.match(card, /2 則留言/);
});

function editorHarness(values = {}) {
  const controls = {}, errors = {}, focused = [];
  for (const name of ['flEditCompany', 'flEditVenue', 'flTitle', 'flContent', 'flEditStatus', 'flPriority', 'flDueDate', 'flPerson']) {
    const attributes = {}, classes = new Set();
    controls[name] = { value: values[name] || '', innerHTML: '', disabled: false,
      classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); }, contains: name => classes.has(name) },
      setAttribute(name, value) { attributes[name] = value; }, removeAttribute(name) { delete attributes[name]; }, getAttribute: name => attributes[name],
      focus() { focused.push(name); }, scrollIntoView() {} };
    errors[`${name}Error`] = { textContent: '', hidden: true };
  }
  controls.flPeople = { innerHTML: '' };
  const message = { textContent: '', classList: { toggle() {} } };
  const host = { querySelector: selector => selector === '#flModalMessage' ? message : controls[selector.slice(1)] || errors[selector.slice(1)] || null };
  const calls = [];
  const app = log.createApplication({ document: { getElementById: () => host }, venues: { GEG: ['Test Venue'], SCL: ['Other Venue'] }, transport: { async post(payload) { calls.push(payload); return { success: false, message: 'Synthetic save failure' }; } } });
  app.knownPeople = []; app.editorId = 'synthetic-editor';
  return { app, controls, errors, focused, message, calls };
}

test('empty mandatory fields are highlighted together and focus moves to the first missing field without writing', async () => {
  const { app, controls, errors, focused, calls } = editorHarness();
  await app.saveEditor();
  assert.equal(calls.length, 0);
  for (const field of ['flEditCompany', 'flTitle', 'flPerson']) {
    assert.equal(controls[field].getAttribute('aria-invalid'), 'true');
    assert.equal(controls[field].classList.contains('fl-invalid'), true);
    assert.ok(errors[`${field}Error`].textContent);
  }
  assert.equal(controls.flEditVenue.getAttribute('aria-invalid'), undefined);
  assert.equal(focused[0], 'flEditCompany');
});

test('optional venue can be blank and a typed inputter is saved even without pressing add', async () => {
  const { app, calls } = editorHarness({ flEditCompany: 'OTHER', flTitle: 'Test entry', flPerson: 'Operator A', flEditStatus: 'pending', flPriority: 'normal' });
  await app.saveEditor();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].entry.company, 'OTHER');
  assert.equal(calls[0].entry.venue, '');
  assert.deepEqual(Array.from(calls[0].entry.knownPeople), ['Operator A']);
});

test('required-field highlights clear after the user fills the missing information', async () => {
  const { app, controls, errors } = editorHarness();
  await app.saveEditor();
  controls.flEditCompany.value = 'OTHER'; controls.flTitle.value = 'Test entry'; controls.flPerson.value = 'Operator A';
  assert.equal(app.validateEditor(false), true);
  for (const name of ['flEditCompany', 'flTitle', 'flPerson']) {
    assert.equal(controls[name].getAttribute('aria-invalid'), undefined);
    assert.equal(errors[`${name}Error`].hidden, true);
  }
});

test('validation summary stops requesting the company as soon as a company has been selected', async () => {
  const { app, controls, message } = editorHarness();
  await app.saveEditor(); controls.flEditCompany.value = 'OTHER';
  assert.equal(app.validateEditor(false), false);
  assert.doesNotMatch(message.textContent, /請選擇公司/);
  assert.match(message.textContent, /標題|輸入者/);
});

test('diary items and unread notices still identify other matters when optional venue is empty', async () => {
  const entry = { id: 'other-entry', company: 'OTHER', venue: '', title: 'Test other matter', knownPeople: ['Operator A'], status: 'pending', revision: 'one' };
  assert.match(log.renderCard(entry), /其他事項/);
  const host = { innerHTML: '', addEventListener() {} };
  const notices = log.createNotifications({ document: { getElementById: () => host }, transport: { get: async () => ({ success: true, entries: [entry] }) } });
  await notices.refresh();
  assert.match(host.innerHTML, /其他事項/);
});

test('company changes replace the select options and clear a venue from another company', () => {
  const { app, controls } = editorHarness({ flEditCompany: 'GEG', flEditVenue: 'Other Venue' });
  app.change({ target: controls.flEditCompany = { ...controls.flEditCompany, id: 'flEditCompany' } });
  assert.equal(controls.flEditVenue.value, '');
  assert.match(controls.flEditVenue.innerHTML, />全部<\/option>/);
  assert.match(controls.flEditVenue.innerHTML, /Test Venue/);
  assert.doesNotMatch(controls.flEditVenue.innerHTML, /Other Venue/);
  assert.equal(app.modalDirty, true);
});

test('a cross-company venue is rejected and highlighted before submission', async () => {
  const { app, calls, controls } = editorHarness({ flEditCompany: 'GEG', flEditVenue: 'Other Venue', flTitle: 'Test entry', flPerson: 'Operator A' });
  await app.saveEditor();
  assert.equal(calls.length, 0);
  assert.equal(controls.flEditVenue.getAttribute('aria-invalid'), 'true');
});

test('new entry uses explicit company and fixed venue selects with other matters and required inputter', () => {
  const { app } = editorHarness(); let html;
  app.showModal = (_title, content) => { html = content; return true; };
  app.openEditor();
  assert.match(html, /<select id="flEditCompany"[^>]*required/);
  assert.match(html, /value="" selected>請選擇公司/);
  assert.match(html, /value="OTHER">其他事項/);
  assert.match(html, /<select id="flEditVenue"/);
  assert.doesNotMatch(html, /<input id="flEditVenue"/);
  assert.match(html, /輸入者.*必填/);
});

test('each list entry is one keyboard-accessible detail button containing its summary fields', () => {
  const row = log.renderCard({ id: 'synthetic-row', title: 'Test follow-up', venue: 'Test Venue', content: 'Summary text', status: 'pending', priority: 'urgent', knownPeople: ['Operator A'], updatedAt: '2026-10-07T02:00:00Z', commentCount: 3 });
  assert.match(row, /^<button[^>]+data-fl-open="synthetic-row"/);
  assert.equal((row.match(/<button\b/g) || []).length, 1);
  for (const field of ['待跟進', '緊急', 'Test Venue', 'Test follow-up', 'Summary text', 'Operator A', '3 則留言']) assert.ok(row.includes(field));
});

test('mount downloads the active list and a failed refresh preserves visible records', async () => {
  assert.equal(typeof log.createApplication, 'function');
  const host = { innerHTML: '', querySelector: () => null, addEventListener() {} }, calls = [];
  let fail = false;
  const app = log.createApplication({ document: { getElementById: () => host }, transport: { async get(query) { calls.push(query); if (fail) throw new Error('Offline'); return { success: true, entries: [{ id: 'test-id', title: 'Retained', status: 'pending', knownPeople: [] }], total: 1, page: 1, pageSize: 50, summary: { active: 1, completed: 0, urgent: 0 } }; } }, toast() {} });
  await app.mount();
  assert.match(calls[0], /action=followupLog/);
  assert.match(calls[0], /status=active/);
  assert.match(host.innerHTML, /Retained/);
  fail = true;
  await app.load();
  assert.match(host.innerHTML, /Retained/);
  assert.match(host.innerHTML, /Offline/);
});

test('concurrent write clicks create one request', async () => {
  assert.equal(typeof log.createApplication, 'function');
  let resolve, calls = 0;
  const app = log.createApplication({ document: { getElementById: () => null }, transport: { post: () => { calls++; return new Promise(done => { resolve = done; }); } }, toast() {} });
  const pending = app.write({ action: 'addFollowupComment', id: 'same-id', name: 'Operator A', content: 'Test comment', entryId: 'entry-id' });
  assert.equal(await app.write({ action: 'addFollowupComment', id: 'same-id' }), null);
  resolve({ success: true });
  assert.equal((await pending).success, true);
  assert.equal(calls, 1);
  assert.equal(app.isBusy(), false);
});

test('cancelled editor switch preserves the existing edit identity and known people', () => {
  const app = log.createApplication({ document: { getElementById: () => null } });
  app.editing = { id: 'original' }; app.editorId = 'original'; app.knownPeople = ['Operator A'];
  app.showModal = () => false;
  app.openEditor({ id: 'replacement', company: 'ALL', knownPeople: ['Operator B'] });
  assert.equal(app.editorId, 'original');
  assert.deepEqual(app.knownPeople, ['Operator A']);
  assert.equal(app.editing.id, 'original');
});

test('unknown write retries the same payload and restores original enabled controls after a known failure', async () => {
  const controls = [{ disabled: true, dataset: {} }, { disabled: false, dataset: {} }, { disabled: false, dataset: { fl: 'save' } }];
  const modal = { querySelectorAll: () => controls };
  const host = { querySelector: selector => selector === '.fl-modal' ? modal : null };
  const requests = [];
  const app = log.createApplication({ document: { getElementById: () => host }, transport: { async post(payload) { requests.push(payload); const error = new Error('Retry'); error.unknownOutcome = requests.length === 1; throw error; } }, toast() {} });
  const original = { action: 'createFollowupLog', id: 'retry-id', entry: { title: 'Original' } };
  await app.write(original);
  assert.equal(app.isBusy(), true);
  assert.deepEqual(controls.map(control => control.disabled), [true, true, false]);
  await app.write({ ...original, entry: { title: 'Changed' } });
  assert.equal(requests[1], original);
  assert.deepEqual(controls.map(control => control.disabled), [true, false, false]);
  assert.equal(app.pendingPayload, null);
  assert.equal(app.isBusy(), false);
});

test('filters and search are collapsed initially and remain expanded through list refreshes', async () => {
  const host={innerHTML:'',querySelector:()=>null,addEventListener(){}};
  const app=log.createApplication({document:{getElementById:()=>host},transport:{get:async()=>({success:true,entries:[],total:0})}});
  await app.mount();
  assert.match(host.innerHTML,/<details[^>]*class="fl-filter-panel"[^>]*><summary>篩選或搜尋/);
  assert.doesNotMatch(host.innerHTML,/<details[^>]*class="fl-filter-panel"[^>]*\bopen\b/);
  app.filtersOpen=true;await app.load();
  assert.match(host.innerHTML,/<details[^>]*class="fl-filter-panel"[^>]*\bopen\b/);
});

test('device unread state is persisted only after reading, and new revisions become unread again', async () => {
  assert.equal(typeof log.createNotifications,'function');
  const data=new Map(),storage={getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)};
  const host={innerHTML:'',hidden:true,addEventListener(){}};
  let feed=[{id:'test-notice',title:'<img src=x>',venue:'Test venue',status:'pending',revision:'one'}];
  const dependencies={document:{getElementById:()=>host},storage,transport:{get:async()=>({success:true,entries:feed})}};
  const notices=log.createNotifications(dependencies);
  await notices.refresh();assert.equal(notices.unread().length,1);assert.equal(host.hidden,false);assert.match(host.innerHTML,/&lt;img src=x&gt;/);
  notices.markRead(feed[0]);assert.equal(notices.unread().length,0);assert.equal(host.hidden,true);
  const reloaded=log.createNotifications(dependencies);await reloaded.refresh();assert.equal(reloaded.unread().length,0);
  feed=[{...feed[0],revision:'two'}];await reloaded.refresh();assert.equal(reloaded.unread().length,1);
  const otherDevice=log.createNotifications({...dependencies,storage:{getItem:()=>null}});await otherDevice.refresh();assert.equal(otherDevice.unread().length,1);
  feed=[];await reloaded.refresh();assert.equal(reloaded.unread().length,0);
});

test('late notification responses cannot reappear after authentication is stopped', async () => {
  assert.equal(typeof log.createNotifications,'function');
  let done;const host={innerHTML:'',hidden:true,addEventListener(){}};
  const notices=log.createNotifications({document:{getElementById:()=>host},transport:{get:()=>new Promise(resolve=>done=resolve)}});
  const pending=notices.refresh();notices.stop();done({success:true,entries:[{id:'private-test',revision:'one'}]});await pending;
  assert.equal(host.hidden,true);assert.equal(notices.unread().length,0);
});

test('leaving the log while details load never marks a hidden entry as read', async () => {
  let done,reads=0;
  const app=log.createApplication({document:{getElementById:()=>null},onRead:()=>reads++,transport:{get:()=>new Promise(resolve=>done=resolve)},toast(){}});
  const pending=app.openDetail('entry-one');
  assert.equal(typeof app.deactivate,'function');
  assert.equal(app.deactivate(),true);
  done({success:true,entry:{id:'entry-one',title:'Test entry',status:'pending',revision:'one'},comments:[]});await pending;
  assert.equal(reads,0);
  assert.equal(app.modal,null);
});

function notificationClock() {
  let time = 0, timerId = 0;
  const timers = new Map(), listeners = new Map(), queries = [];
  const document = {
    hidden: false, getElementById: () => null,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  const runtime = vm.createContext({ module: { exports: {} }, URLSearchParams,
    setInterval(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay, due: time + delay }); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  vm.runInContext(source, runtime);
  const notices = runtime.module.exports.createNotifications({ document, now: () => time,
    canRefresh: () => !document.hidden,
    transport: { async get(query) { queries.push(query); return { success: true, entries: [] }; } },
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { notices, document, queries, settle,
    activity(type) { for (const listener of listeners.get(type) || []) listener({ type }); },
    async advance(target) {
      while (true) {
        const next = [...timers.values()].filter(timer => timer.due <= target).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        time = next.due; next.due += next.delay; next.callback(); await settle();
      }
      time = target; await settle();
    },
  };
}

test('notification polling checks on open and every three minutes, not every minute', async () => {
  const clock = notificationClock();
  clock.notices.start(); await clock.settle();
  assert.equal(clock.queries.length, 1);
  assert.equal(new URLSearchParams(clock.queries[0]).get('notificationPoll'), 'idle-v1');
  await clock.advance(179999); assert.equal(clock.queries.length, 1);
  await clock.advance(180000); assert.equal(clock.queries.length, 2);
  clock.notices.start();
  await clock.advance(360000); assert.equal(clock.queries.length, 3);
});

test('ten minutes without interaction pauses polling and visibility refresh until user activity resumes', async () => {
  const clock = notificationClock();
  clock.notices.start(); await clock.settle(); await clock.advance(599999);
  assert.equal(clock.queries.length, 4);
  await clock.advance(600000);
  await clock.notices.refresh(); assert.equal(clock.queries.length, 4);
  await clock.advance(900000); assert.equal(clock.queries.length, 4);
  clock.activity('pointerdown'); await clock.settle(); assert.equal(clock.queries.length, 5);
  clock.activity('pointermove'); clock.activity('input'); await clock.settle();
  assert.equal(clock.queries.length, 5);
  await clock.advance(1080000); assert.equal(clock.queries.length, 6);
});

test('keyboard, touch and scrolling reset idle time without issuing a request per interaction', async () => {
  for (const type of ['keydown', 'touchstart', 'wheel', 'scroll', 'input', 'pointermove']) {
    const clock = notificationClock();
    clock.notices.start(); await clock.settle(); await clock.advance(540000);
    clock.activity(type); await clock.settle(); assert.equal(clock.queries.length, 4);
    await clock.advance(720000); assert.equal(clock.queries.length, 5, type);
    await clock.advance(1140000); await clock.notices.refresh();
    assert.equal(clock.queries.length, 7, type);
  }
});

test('hidden pages cannot poll or reset idle time, and stopped authentication cannot be resumed by interaction', async () => {
  const clock = notificationClock();
  clock.notices.start(); await clock.settle(); clock.document.hidden = true;
  await clock.advance(600000); clock.activity('keydown');
  clock.document.hidden = false; await clock.notices.refresh();
  assert.equal(clock.queries.length, 1);
  clock.activity('touchstart'); await clock.settle(); assert.equal(clock.queries.length, 2);
  clock.notices.stop(); await clock.advance(1500000);
  clock.activity('pointerdown'); await clock.settle(); assert.equal(clock.queries.length, 2);
  clock.notices.start(); await clock.settle(); assert.equal(clock.queries.length, 3);
});
