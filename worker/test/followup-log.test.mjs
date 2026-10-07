import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepository } from '../src/repository.mjs';
import { permissionForAction, handleRequest } from '../src/api.mjs';
import { issueSessionToken } from '../src/crypto.mjs';
import access from '../../access-control.js';

test('follow-up log is available to every authenticated token but never anonymously', async () => {
  assert.equal(access.pagePermission('followupLog'), '');
  for (const action of ['followupLog', 'followupNotifications', 'createFollowupLog', 'updateFollowupLog', 'deleteFollowupLog', 'addFollowupComment']) {
    assert.equal(permissionForAction(action), '');
    let operation=null,lock=null;
    const env = { AMRS_TOKEN_SECRET: 'synthetic-secret', DB:{prepare(sql){return {bind(...args){return {
      async first(){return sql.includes('FROM operations')?operation:sql.includes('FROM write_locks')?lock:null;},
      async run(){
        if(sql.includes('INSERT INTO operations'))operation={request_id:args[0],action:args[1],status:args[2],created_at:args[3],updated_at:args[4]};
        else if(sql.startsWith('UPDATE operations'))Object.assign(operation,{status:args[0],result_json:args[1],error_message:args[2],retryable:args[3],updated_at:args[4]});
        else if(sql.includes('INSERT INTO write_locks'))lock={scope:args[0],owner:args[1],expires_at:args[2]};
        else if(sql.includes('DELETE FROM write_locks'))lock=null;
        return {success:true,meta:{changes:1}};
      }
    };}};}} };
    const token = await issueSessionToken(env.AMRS_TOKEN_SECRET, { scope: 'amrs', permissions: ['ae', 'schedule'], legacy: true });
    for (const method of ['GET', 'POST']) {
      let calls = 0;
      const response = await handleRequest(new Request(`https://synthetic.example/api?action=${action}`, {
        method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ action }) } : {}),
      }), env, { repository: { getAction() { calls++; return {success:true}; }, postAction() { calls++; return {success:true}; } } });
      assert.equal(response.status, 200);
      assert.equal(calls, 1);
      const anonymous = await handleRequest(new Request(`https://synthetic.example/api?action=${action}`, {method, headers:{'content-type':'application/json'}, ...(method==='POST'?{body:JSON.stringify({action})}:{})}), env, {repository:{getAction(){throw new Error('Anonymous access');},postAction(){throw new Error('Anonymous access');}}});
      assert.equal(anonymous.status, 401);
    }
  }
});

const headers = ['ID', 'Company', 'Venue', 'Title', 'Content', 'Status', 'Priority', 'Due Date', 'Known People', 'Created At', 'Updated At'];

test('authenticated administrator log GET reaches the log repository, not token management', async () => {
  const env = { AMRS_TOKEN_SECRET: 'synthetic-secret', DB: { prepare() { return { bind() { return this; }, async first() { return { id: 'synthetic-admin', permissions_json: '["admin"]', status: 'active', last_used_at: Date.now() }; }, async run() { return {}; } }; } } };
  const token = await issueSessionToken(env.AMRS_TOKEN_SECRET, { scope: 'amrs', tokenId: 'synthetic-admin' });
  let calls = 0;
  const response = await handleRequest(new Request('https://synthetic.example/api?action=followupLog', { headers: { authorization: `Bearer ${token}` } }), env, { repository: { async getAction(params) { calls++; assert.equal(params.action, 'followupLog'); return { success: true, entries: [], total: 0 }; } } });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal((await response.json()).total, 0);
});
const commentHeaders = ['ID', 'Entry ID', 'Name', 'Content', 'Created At'];

test('authenticated non-admin can reconcile log operations but anonymous clients cannot', async () => {
  const env = { AMRS_TOKEN_SECRET: 'synthetic-secret', DB: { prepare() { return { bind() { return this; }, async first() { return { request_id: 'synthetic-request', action: 'createFollowupLog', status: 'completed', result_json: '{"success":true,"entry":{"title":"Private test"}}' }; } }; } } };
  const token = await issueSessionToken(env.AMRS_TOKEN_SECRET, { scope: 'amrs', permissions: ['ae'], legacy: true });
  for (const request of [new Request('https://synthetic.example/operations/synthetic-request', { headers: { authorization: `Bearer ${token}` } }), new Request('https://synthetic.example/api', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'updateMonthlySettings', requestId: 'synthetic-request' }) })]) {
    const response = await handleRequest(request, env, { repository: {} });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Private test/);
    const anonymous = await handleRequest(new Request(request.url, {method:request.method, headers:{'content-type':'application/json'}, ...(request.method==='POST'?{body:JSON.stringify({action:'updateMonthlySettings',requestId:'synthetic-request'})}:{})}), env, {repository:{}});
    assert.equal(anonymous.status, 401);
  }
});
function harness() {
  const tables = { Entries: [headers], Comments: [commentHeaders] }, writes = [];
  const sheetsClient = {
    async valuesGet({ spreadsheetId, range }) {
      assert.equal(spreadsheetId, 'synthetic-log');
      return { values: structuredClone(tables[range.split('!')[0]]) };
    },
    async valuesAppend(options) {
      assert.equal(options.valueInputOption, 'RAW');
      writes.push(options);
      tables[options.range.split('!')[0]].push(...structuredClone(options.values));
      return {};
    },
    async valuesUpdate(options) {
      assert.equal(options.valueInputOption, 'RAW');
      writes.push(options);
      const [sheet, cell] = options.range.split('!');
      tables[sheet][Number(cell.match(/\d+/)[0]) - 1] = structuredClone(options.values[0]);
      return {};
    },
  };
  const repo = createRepository({}, { config: { followupLogSheetId: 'synthetic-log' }, sheetsClient, now: () => 1791324000000 });
  return { repo, tables, writes };
}
const newEntry = () => ({ action: 'createFollowupLog', id: 'synthetic-entry', entry: {
  company: 'GEG', venue: 'Test Venue', title: 'Test follow-up', content: '=literal text',
  status: 'pending', priority: 'normal', dueDate: '', knownPeople: ['Operator A', 'Operator B'],
} });

test('creates a cloud log entry once, reads it back and leaves existing sheets untouched', async () => {
  const { repo, tables, writes } = harness();
  const result = await repo.postAction(newEntry());
  assert.equal(result.success, true);
  assert.equal(result.entry.content, '=literal text');
  assert.deepEqual(result.entry.knownPeople, ['Operator A', 'Operator B']);
  await repo.postAction(newEntry());
  assert.equal(tables.Entries.length, 2);
  assert.equal(writes.length, 1);
  const list = await repo.getAction({ action: 'followupLog' });
  assert.equal(list.total, 1);
  assert.equal(list.entries[0].id, 'synthetic-entry');
  assert.ok(list.entries[0].version);
});

test('all-status log list keeps unfinished entries ahead of completed urgent entries', async () => {
  const { repo } = harness();
  for (const [id, status, priority] of [['done', 'completed', 'urgent'], ['pending', 'pending', 'normal'], ['urgent', 'progress', 'urgent']]) {
    const payload = newEntry(); payload.id = id; payload.entry.status = status; payload.entry.priority = priority;
    await repo.postAction(payload);
  }
  const list = await repo.getAction({ action: 'followupLog', status: 'all' });
  assert.deepEqual(list.entries.map(entry => entry.id), ['urgent', 'pending', 'done']);
});

test('rejects stale edits and supports completed and active filters', async () => {
  const { repo } = harness();
  const { entry } = await repo.postAction(newEntry());
  const updated = await repo.postAction({ action: 'updateFollowupLog', id: entry.id, baseVersion: entry.version, entry: { ...entry, status: 'completed' } });
  assert.equal(updated.entry.status, 'completed');
  await assert.rejects(repo.postAction({ action: 'updateFollowupLog', id: entry.id, baseVersion: entry.version, entry }), error => error.status === 409);
  assert.equal((await repo.getAction({ action: 'followupLog', status: 'active' })).total, 0);
  assert.equal((await repo.getAction({ action: 'followupLog', status: 'completed' })).total, 1);
  assert.equal((await repo.getAction({ action: 'followupLog', company: 'SCL' })).total, 0);
});

test('named comments are independent append-only records and retry without duplication', async () => {
  const { repo, tables } = harness();
  await repo.postAction(newEntry());
  const comment = { action: 'addFollowupComment', id: 'synthetic-comment', entryId: 'synthetic-entry', name: 'Operator A', content: '<script>literal</script>' };
  await repo.postAction(comment);
  await repo.postAction(comment);
  await repo.postAction({ ...comment, id: 'synthetic-comment-2', name: 'Operator B', content: 'Second update' });
  assert.equal(tables.Comments.length, 3);
  const detail = await repo.getAction({ action: 'followupLog', id: 'synthetic-entry' });
  assert.equal(detail.comments.length, 2);
  assert.equal(detail.comments[0].name, 'Operator A');
  assert.equal(detail.comments[0].content, '<script>literal</script>');
  await assert.rejects(repo.postAction({ ...comment, id: 'bad-comment', name: '' }), error => error.status === 400);
  await assert.rejects(repo.postAction({ ...comment, id: 'unknown-comment', entryId: 'missing' }), error => error.status === 404);
});

test('missing log configuration and mismatched headers cannot write', async () => {
  const { repo, tables, writes } = harness();
  tables.Entries[0] = ['Wrong header'];
  await assert.rejects(repo.postAction(newEntry()), error => error.status === 503);
  assert.equal(writes.length, 0);
  const missing = createRepository({}, { config: {}, sheetsClient: {} });
  await assert.rejects(missing.getAction({ action: 'followupLog' }), error => error.status === 503);
});

test('confirmed deletion hides only the selected entry and retries without resurrection', async () => {
  const {repo,tables}=harness();
  const {entry}=await repo.postAction(newEntry());
  const other=newEntry();other.id='another-entry';await repo.postAction(other);
  await repo.postAction({action:'addFollowupComment',id:'comment-one',entryId:entry.id,name:'Operator A',content:'Update'});
  await assert.rejects(repo.postAction({action:'deleteFollowupLog',id:entry.id,baseVersion:'stale'}),error=>error.status===409);
  assert.equal((await repo.getAction({action:'followupLog',status:'all'})).total,2);
  const payload={action:'deleteFollowupLog',id:entry.id,baseVersion:entry.version};
  assert.equal((await repo.postAction(payload)).success,true);
  assert.equal((await repo.postAction(payload)).success,true);
  assert.deepEqual((await repo.getAction({action:'followupLog',status:'all'})).entries.map(item=>item.id),['another-entry']);
  await assert.rejects(repo.getAction({action:'followupLog',id:entry.id}),error=>error.status===404);
  await assert.rejects(repo.postAction(newEntry()),error=>error.status===409);
  await assert.rejects(repo.postAction({action:'addFollowupComment',id:'comment-two',entryId:entry.id,name:'Operator A',content:'Late update'}),error=>error.status===404);
  assert.equal(tables.Entries[1][5],'deleted');
});

test('notification feed includes every page and uses the same revision as details, including new comments', async () => {
  const {repo}=harness();
  for(let i=0;i<51;i++){const payload=newEntry();payload.id='entry-'+i;await repo.postAction(payload);}
  const initial=await repo.getAction({action:'followupNotifications'});
  assert.equal(initial.entries.length,51);
  const oldRevision=initial.entries.find(entry=>entry.id==='entry-0').revision;
  assert.ok(oldRevision);
  const details=await repo.getAction({action:'followupLog',id:'entry-0'});
  assert.equal(details.entry.revision,oldRevision);
  await repo.postAction({action:'addFollowupComment',id:'new-comment',entryId:'entry-0',name:'Operator A',content:'New comment'});
  const refreshed=await repo.getAction({action:'followupNotifications'});
  assert.notEqual(refreshed.entries.find(entry=>entry.id==='entry-0').revision,oldRevision);
  assert.equal((await repo.getAction({action:'followupLog',id:'entry-0'})).entry.revision,refreshed.entries.find(entry=>entry.id==='entry-0').revision);
  assert.equal(initial.entries[0].content,undefined);
});
