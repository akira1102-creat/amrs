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
  assert.match(card, /知悉同事/);
  assert.match(card, /Operator A/);
  assert.match(card, /2 則留言/);
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
