import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepository } from '../src/repository.mjs';
import { permissionForAction, handleRequest } from '../src/api.mjs';
import { issueSessionToken } from '../src/crypto.mjs';
import access from '../../access-control.js';

test('follow-up log is admin-only on both navigation and every API action', async () => {
  assert.equal(access.pagePermission('followupLog'), 'admin');
  for (const action of ['followupLog', 'createFollowupLog', 'updateFollowupLog', 'addFollowupComment']) {
    assert.equal(permissionForAction(action), 'admin');
    const env = { AMRS_TOKEN_SECRET: 'synthetic-secret' };
    const token = await issueSessionToken(env.AMRS_TOKEN_SECRET, { scope: 'amrs', permissions: ['ae', 'schedule'], legacy: true });
    for (const method of ['GET', 'POST']) {
      let calls = 0;
      const response = await handleRequest(new Request(`https://synthetic.example/api?action=${action}`, {
        method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ action }) } : {}),
      }), env, { repository: { getAction() { calls++; }, postAction() { calls++; } } });
      assert.equal(response.status, 403);
      assert.equal(calls, 0);
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

test('non-admin cannot obtain a log mutation result through an operation id or cross-action replay', async () => {
  const env = { AMRS_TOKEN_SECRET: 'synthetic-secret', DB: { prepare() { return { bind() { return this; }, async first() { return { request_id: 'synthetic-request', action: 'createFollowupLog', status: 'completed', result_json: '{"success":true,"entry":{"title":"Private test"}}' }; } }; } } };
  const token = await issueSessionToken(env.AMRS_TOKEN_SECRET, { scope: 'amrs', permissions: ['ae'], legacy: true });
  for (const request of [new Request('https://synthetic.example/operations/synthetic-request', { headers: { authorization: `Bearer ${token}` } }), new Request('https://synthetic.example/api', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'updateMonthlySettings', requestId: 'synthetic-request' }) })]) {
    const response = await handleRequest(request, env, { repository: {} });
    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /Private test/);
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
