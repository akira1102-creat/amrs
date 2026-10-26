import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

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

test('Schedule reminders stop after seven Hong Kong calendar days even if edited or commented later', () => {
  const a = app();
  const entry = { id: 'seven-day', venue: 'Site Alpha', title: 'Limited notice', status: 'pending', createdAt: '2026-10-20T16:30:00Z', updatedAt: '2026-10-27T05:00:00Z' };
  assert.match(a.buildVenueFollowupText_('A', { entries: [entry], reminders: { day: '2026-10-27', record: () => false } }), /Limited notice/);
  assert.equal(a.buildVenueFollowupText_('A', { entries: [entry], reminders: { day: '2026-10-28', record: () => { throw new Error('Expired entries must not enter receipt'); } } }), '');
  assert.match(a.buildVenueFollowupText_('A', { entries: [{ ...entry, schedulePermanent: true }], reminders: { day: '2027-02-01', record: () => false } }), /Limited notice/);
  assert.equal(a.buildVenueFollowupText_('A', { entries: [{ ...entry, schedulePermanent: true, status: 'completed' }], reminders: { day: '2027-02-01' } }), '');
});

test('the optional permanent column works with old sheets and rejects a mismatched new header', () => {
  const a = app();
  const legacy = a.parseScheduleFollowups_([headers, row('old', 'Site Alpha')])[0];
  assert.equal(legacy.createdAt, '2026-01-01T00:00:00Z');
  assert.equal(legacy.schedulePermanent, false);
  const extended = [...headers, 'Schedule Permanent'];
  for (const [value, expected] of [['TRUE', true], ['FALSE', false], ['', false]]) {
    assert.equal(a.parseScheduleFollowups_([extended, [...row('new', 'Site Alpha'), value]])[0].schedulePermanent, expected);
  }
  assert.throws(() => a.parseScheduleFollowups_([[...headers, 'Unrelated column']]), /欄位/);
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
  const am = a.buildVenueFollowupText_('A*', { entries, day: '2026-01-01' }), pm = a.buildVenueFollowupText_('B', { entries, day: '2026-01-01' });
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
  const text = a.buildVenueFollowupText_('A', {entries, day: '2026-01-01'});
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

function reminders() {
  const properties = new Map();
  const store = { getProperty: key => properties.get(key) || null,
    setProperty(key, value) { properties.set(key, String(value)); return this; },
    deleteProperty(key) { properties.delete(key); return this; } };
  const a = app({
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => store },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, value, charset) => Array.from(createHash(algorithm).update(value, charset).digest()) },
    buildScheduleForDate: (_ss, date) => ({ isWeekend: [0,6].includes(date.getDay()), isHoliday: date.getFullYear() === 2026 && date.getMonth() === 0 && date.getDate() === 13 }),
  });
  assert.equal(typeof a.createScheduleFollowupReminderContext_, 'function');
  const entry = {id:'synthetic-entry',company:'TEST',venue:'Site Alpha',title:'Check connection',content:'Full details',status:'pending',priority:'normal',dueDate:'2026-01-16',updatedAt:'2026-01-01'};
  const render = (date, entries = [entry], venues = {A:['Person A']}) => {
    const context = a.createScheduleFollowupReminderContext_({}, date);
    return {context, text:a.buildScheduleFollowupBlock_(venues,{entries,reminders:context})};
  };
  return {a,properties,entry,render};
}

test('first successful reminder is full, next consecutive workdays remain title-only',()=>{
  const t=reminders();
  const first=t.render(new Date(2026,0,8));assert.match(first.text,/Full details/);
  t.a.commitScheduleFollowupReminders_(first.context);
  const second=t.render(new Date(2026,0,9));assert.match(second.text,/Check connection/);assert.doesNotMatch(second.text,/Full details|跟進日期/);
  t.a.commitScheduleFollowupReminders_(second.context);
  const third=t.render(new Date(2026,0,12));assert.doesNotMatch(third.text,/Full details/);
});

test('weekends and Public Holiday are skipped when finding the preceding workday',()=>{
  const t=reminders();const friday=t.render(new Date(2026,0,9));t.a.commitScheduleFollowupReminders_(friday.context);
  const monday=t.render(new Date(2026,0,12));assert.doesNotMatch(monday.text,/Full details/);t.a.commitScheduleFollowupReminders_(monday.context);
  const wednesday=t.render(new Date(2026,0,14));assert.doesNotMatch(wednesday.text,/Full details/);
});

test('a missing working-day reminder and changed content both require full text again',()=>{
  const t=reminders();const first=t.render(new Date(2026,0,8));t.a.commitScheduleFollowupReminders_(first.context);
  const missing=t.render(new Date(2026,0,9),[],{B:['Person A']});t.a.commitScheduleFollowupReminders_(missing.context);
  assert.match(t.render(new Date(2026,0,12)).text,/Full details/);
  t.entry.content='Updated full details';assert.match(t.render(new Date(2026,0,9)).text,/Updated full details/);
});

test('only rendered entries are recorded and timestamp-only updates do not repeat the article',()=>{
  const t=reminders();const first=t.render(new Date(2026,0,8));t.a.commitScheduleFollowupReminders_(first.context);
  t.entry.updatedAt='2026-01-09';assert.doesNotMatch(t.render(new Date(2026,0,9)).text,/Full details/);
  const other={...t.entry,id:'different-entry',title:'Another item'};assert.match(t.render(new Date(2026,0,9),[other]).text,/Full details/);
});

test('failed Discord sends do not mark full articles delivered; successful sends do',()=>{
  const t=reminders();t.a.sendToDiscord=()=>false;
  const first=t.render(new Date(2026,0,8));assert.equal(typeof t.a.sendScheduleWithFollowupReminders_,'function');
  assert.equal(t.a.sendScheduleWithFollowupReminders_(first.text,first.context),false);
  assert.match(t.render(new Date(2026,0,9)).text,/Full details/);
  t.a.sendToDiscord=()=>true;t.a.sendScheduleWithFollowupReminders_(first.text,first.context);
  assert.doesNotMatch(t.render(new Date(2026,0,9)).text,/Full details/);
});

test('major journal items, venue groups and numbered points are separated by a blank line',()=>{
  const t=reminders();t.entry.content='1）First point\nDetails\n2）Second point';
  const text=t.render(new Date(2026,0,8),[t.entry,{...t.entry,id:'second',title:'Next item'},{...t.entry,id:'third',venue:'Site Beta',title:'Other venue'}],{A:[],B:[]}).text;
  assert.match(text,/Details\n\n　　　2）Second point/);
  assert.match(text,/跟進日期：2026-01-16\n\n　　• .*Next item/);
  assert.match(text,/跟進日期：2026-01-16\n\n　📌 Site Beta/);
});

test('large reminder receipts stay below property value limits and contain no article text',()=>{
  const t=reminders();const entries=Array.from({length:180},(_,i)=>({...t.entry,id:'synthetic-entry-'+i}));
  const first=t.render(new Date(2026,0,8),entries);t.a.commitScheduleFollowupReminders_(first.context);
  for(const value of t.properties.values()){assert.ok(Buffer.byteLength(value,'utf8')<9000);assert.doesNotMatch(value,/Full details|Check connection/);}
  const next=t.render(new Date(2026,0,9),entries);assert.equal((next.text.match(/synthetic-entry/g)||[]).length,0);assert.doesNotMatch(next.text,/Full details/);
});

test('unreadable previous schedule and corrupt history default to complete reminders',()=>{
  const t=reminders();const first=t.render(new Date(2026,0,8));t.a.commitScheduleFollowupReminders_(first.context);
  const receiptKey=Array.from(t.properties.keys()).find(key=>key.endsWith('_0'));
  t.properties.set(receiptKey,'not valid JSON');assert.match(t.render(new Date(2026,0,9)).text,/Full details/);
  t.a.buildScheduleForDate=()=>({error:'Unavailable'});assert.match(t.render(new Date(2026,0,9)).text,/Full details/);
});

test('preceding workday is found across a month boundary',()=>{
  const t=reminders();const friday=t.render(new Date(2026,0,30));t.a.commitScheduleFollowupReminders_(friday.context);
  assert.doesNotMatch(t.render(new Date(2026,1,2)).text,/Full details/);
});

test('old receipts are pruned while the last two working-day receipts remain',()=>{
  const t=reminders();for(const day of [8,9,12,14])t.a.commitScheduleFollowupReminders_(t.render(new Date(2026,0,day)).context);
  const keys=Array.from(t.properties.keys()).join('\n');
  assert.doesNotMatch(keys,/SENT_2026-01-08|SENT_2026-01-09/);assert.match(keys,/SENT_2026-01-12/);assert.match(keys,/SENT_2026-01-14/);
});
