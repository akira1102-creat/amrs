import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const helperPath = new URL('../integrations/schedule-gas/followup-notifications.js', import.meta.url);
const headers = ['ID','Company','Venue','Title','Content','Status','Priority','Due Date','Known People','Created At','Updated At'];
const row = (id, venue, status = 'pending', extra = {}) => [id, 'TEST', venue, extra.title || `Task ${id}`, extra.content || '', status, extra.priority || 'normal', extra.dueDate || '', '[]', '2026-01-01T00:00:00Z', extra.updatedAt || '2026-01-01T00:00:00Z'];
function app(overrides = {}) {
  const context = vm.createContext({ SCHEDULE_FOLLOWUP_VENUE_ALIASES: { A: 'Site Alpha', B: 'Site Beta' }, ...overrides });
  if (fs.existsSync(helperPath)) vm.runInContext(fs.readFileSync(helperPath, 'utf8'), context);
  return context;
}
function readableRows(rows, properties = { FOLLOWUP_LOG_SHEET_ID: 'synthetic-sheet' }) {
  return {
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key] || '' }) },
    SpreadsheetApp: { openById(id) {
      assert.equal(id, 'synthetic-sheet');
      return { getSheetByName(name) {
        assert.equal(name, 'Entries');
        return { getLastRow: () => rows.length, getRange(r, c, height, width) {
          assert.deepEqual([r,c,height,width], [1,1,rows.length,11]);
          return { getDisplayValues: () => rows };
        } };
      } };
    } },
    Logger: { log() {} },
  };
}

test('only unfinished, non-deleted journal entries are eligible for notifications', () => {
  const a = app();
  assert.equal(typeof a.parseScheduleFollowups_, 'function', 'journal parser must exist');
  const result = a.parseScheduleFollowups_([headers, row('a','Site Alpha'), row('b','Site Alpha','progress'), row('c','Site Alpha','waiting'), row('d','Site Alpha','completed'), row('e','Site Alpha','deleted'), row('','Site Alpha')]);
  assert.deepEqual(Array.from(result, x => x.id), ['a','b','c']);
});

test('AM and PM each match their own venues, including aliases and starred venue codes', () => {
  const a = app();
  assert.equal(typeof a.buildVenueFollowupText_, 'function', 'venue formatter must exist');
  const data = { entries: [row('a','Site Alpha'),row('b','Site Beta'),row('c','Site Gamma')].map(r => ({id:r[0],venue:r[2],title:r[3],status:r[5]})) };
  const am = a.buildVenueFollowupText_('A*', data), pm = a.buildVenueFollowupText_('b', data);
  assert.match(am, /Task a/); assert.doesNotMatch(am, /Task b|Task c/);
  assert.match(pm, /Task b/); assert.doesNotMatch(pm, /Task a|Task c/);
  assert.equal(a.buildVenueFollowupText_('資料輸入', data), '');
  assert.equal(a.buildVenueFollowupText_('AL', data), '');
});

test('all-venue notices match only scheduled venues belonging to the chosen company', () => {
  const a = app({ SCHEDULE_FOLLOWUP_COMPANY_VENUES: { TEST: ['Site Alpha'], SECOND: ['Site Beta'] } });
  const entries = a.parseScheduleFollowups_([headers, row('all', '全部'), row('unspecified', ''), ['other', 'OTHER', '全部', 'Other matters', '', 'pending']]);
  const am = a.buildVenueFollowupText_('A*', { entries }), pm = a.buildVenueFollowupText_('B', { entries });
  assert.match(am, /Task all/);
  assert.doesNotMatch(am, /Task unspecified|Other matters/);
  assert.equal(pm, '');
  assert.equal(a.buildVenueFollowupText_('AL', { entries }), '');
});

test('one unfinished item is listed once per venue even when a venue has multiple spellings', () => {
  const a = app();
  assert.equal(typeof a.buildScheduleFollowupBlock_, 'function', 'period formatter must exist');
  const text = a.buildScheduleFollowupBlock_({ A:['Person A'], 'a*':['Person B'], B:['Person C'] }, {entries:[{id:'a',venue:'Site Alpha',title:'Alpha task',status:'pending'}]});
  assert.equal((text.match(/Alpha task/g) || []).length, 1);
  assert.match(text, /Site Alpha/); assert.doesNotMatch(text, /Site Beta/);
});

test('urgent items precede normal items and notification includes actionable content and due date', () => {
  const a = app();
  assert.equal(typeof a.parseScheduleFollowups_, 'function');
  const entries = a.parseScheduleFollowups_([headers,row('n','Site Alpha'),row('u','Site Alpha','waiting',{priority:'urgent',content:'Check cable\nBring replacement',dueDate:'2026-01-02'})]);
  const text = a.buildVenueFollowupText_('A', {entries});
  assert.ok(text.indexOf('Task u') < text.indexOf('Task n'));
  assert.match(text,/緊急/); assert.match(text,/等待/); assert.match(text,/Check cable/); assert.match(text,/Bring replacement/); assert.match(text,/2026-01-02/);
});

test('journal read validates the exact schema and excludes deleted rows', () => {
  const a = app(readableRows([headers,row('a','Site Alpha'),row('b','Site Beta','deleted')]));
  assert.equal(typeof a.loadScheduleFollowups_, 'function', 'journal loader must exist');
  const result = a.loadScheduleFollowups_();
  assert.equal(result.error, ''); assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].title, 'Task a');
});

test('missing source or malformed headers are explicit failures, not a false no-followups result', () => {
  const a = app(readableRows([['Wrong header']], {}));
  assert.equal(typeof a.loadScheduleFollowups_, 'function');
  assert.ok(a.loadScheduleFollowups_().error);
  const b = app(readableRows([['Wrong header']]));
  assert.ok(b.loadScheduleFollowups_().error);
});

test('read failures remain safe and never disclose private error details in a Discord warning', () => {
  const a = app({PropertiesService:{getScriptProperties:()=>({getProperty:()=> 'synthetic-sheet'})},SpreadsheetApp:{openById(){throw new Error('private ID / credential detail');}},Logger:{log(){}}});
  assert.equal(typeof a.loadScheduleFollowups_, 'function');
  const result = a.loadScheduleFollowups_();
  assert.ok(result.error); assert.doesNotMatch(result.error,/private ID|credential/);
  assert.equal(result.entries.length, 0);
});

test('Discord chunks stay within the content limit without truncating long content or splitting emoji', () => {
  const a = app();
  assert.equal(typeof a.splitScheduleDiscordMessages_, 'function', 'long notices need splitting');
  const source = '🌅 上午\n' + '📋'.repeat(1600) + '\n🌆 下午\n' + 'Reminder\n'.repeat(500);
  const chunks = a.splitScheduleDiscordMessages_(source);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), source);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1900);
    assert.doesNotMatch(chunk, /[\uD800-\uDBFF]$/);
    assert.doesNotMatch(chunk, /^[\uDC00-\uDFFF]/);
  }
});
