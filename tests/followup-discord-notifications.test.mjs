import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const file = new URL('../integrations/followup-log-gas/discord-notifications.js', import.meta.url);
const entriesHeader = ['ID','Company','Venue','Title','Content','Status','Priority','Due Date','Known People','Created At','Updated At'];
const commentsHeader = ['ID','Entry ID','Name','Content','Created At'];
const entry = (id, content = 'Check connection', status = 'pending') => [id,'TEST','Site Alpha','Test issue',content,status,'normal','','["Person A"]','2026-01-01','2026-01-01'];
function app() {
  const data = {Entries:[entriesHeader,entry('old')],Comments:[commentsHeader,['old-comment','old','Person B','Old comment','2026-01-01']]};
  const props = new Map([['FOLLOWUP_DISCORD_WEBHOOK','https://discord.com/api/webhooks/123456/synthetic-token']]);
  const sent = [], triggers = [], codes = [];
  const store = {getProperty:k=>props.get(k)||null,setProperty(k,v){props.set(k,String(v));return this;},deleteProperty(k){props.delete(k);return this;}};
  const book = {getId:()=> 'synthetic-sheet',getSheetByName(name){return {getLastRow:()=>data[name].length,getRange(r,c,h,w){return {getDisplayValues:()=>data[name].slice(r-1,r-1+h).map(row=>row.slice(c-1,c-1+w))};}};}};
  const a = vm.createContext({Date,JSON,Math,PropertiesService:{getScriptProperties:()=>store},SpreadsheetApp:{getActiveSpreadsheet:()=>book},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},ScriptApp:{getProjectTriggers:()=>triggers,newTrigger(name){return {timeBased(){return this;},everyMinutes(n){assert.equal(n,1);return this;},create(){triggers.push({getHandlerFunction:()=>name});}};}},UrlFetchApp:{fetch(url,options){assert.ok(url.endsWith('?wait=true'));const body=JSON.parse(options.payload);sent.push(body);return {getResponseCode:()=>codes.shift()||200,getContentText:()=>'{"retry_after":1}'};}},Logger:{log(){}}});
  if(fs.existsSync(file)) vm.runInContext(fs.readFileSync(file,'utf8'),a);
  assert.equal(typeof a.installFollowupDiscord,'function','notification installation must exist');
  return {a,data,props,sent,codes,triggers};
}

test('installation baselines old entries and comments without posting or duplicating triggers',()=>{
  const t=app();t.a.installFollowupDiscord();t.a.pollFollowupDiscord();t.a.installFollowupDiscord();
  assert.equal(t.sent.length,0);assert.equal(t.triggers.length,1);
});
test('new entry and comment send company, venue, title, author and content without mentions',()=>{
  const t=app();t.a.installFollowupDiscord();t.data.Entries.push(entry('new','@everyone Check cable'));
  t.data.Comments.push(['new-comment','new','Person C','Bring spare','2026-01-02']);
  t.a.pollFollowupDiscord();t.a.pollFollowupDiscord();
  assert.equal(t.sent.length,2);
  assert.match(t.sent[0].content,/TEST.*Site Alpha/);assert.match(t.sent[0].content,/Person A/);assert.match(t.sent[0].content,/Check cable/);
  assert.match(t.sent[1].content,/Test issue/);assert.match(t.sent[1].content,/Person C/);assert.match(t.sent[1].content,/Bring spare/);
  assert.deepEqual(t.sent[0].allowed_mentions,{parse:[]});
});
test('editing existing entries and deleted entries do not create notifications',()=>{
  const t=app();t.a.installFollowupDiscord();t.data.Entries[1][4]='Edited old text';t.data.Entries.push(entry('deleted','','deleted'));
  t.data.Comments.push(['deleted-comment','deleted','Person C','Ignored','2026-01-02']);t.a.pollFollowupDiscord();assert.equal(t.sent.length,0);
});
test('failed delivery retries same message and only confirmed success advances the queue',()=>{
  const t=app();t.a.installFollowupDiscord();t.data.Entries.push(entry('new'));t.codes.push(500);
  assert.throws(()=>t.a.pollFollowupDiscord(),/Discord.*500/);t.a.pollFollowupDiscord();t.a.pollFollowupDiscord();
  assert.equal(t.sent.length,2);assert.equal(t.sent[0].content,t.sent[1].content);
});
test('long messages checkpoint sent chunks and retain an immutable snapshot across retries',()=>{
  const t=app();t.a.installFollowupDiscord();t.data.Entries.push(entry('new','Long text '.repeat(500)));t.codes.push(200,500);
  assert.throws(()=>t.a.pollFollowupDiscord());const first=t.sent[0].content, failed=t.sent[1].content;
  t.data.Entries[2][4]='edited after failure';t.a.pollFollowupDiscord();
  assert.equal(t.sent[2].content,failed);assert.equal(t.sent.filter(x=>x.content===first).length,1);
  assert.ok(t.sent.every(x=>x.content.length<=1900));
});
test('schema mismatch and shortened source fail safely instead of dropping queued work',()=>{
  const t=app();t.a.installFollowupDiscord();t.data.Entries[0][1]='Wrong';assert.throws(()=>t.a.pollFollowupDiscord(),/欄位/);
  t.data.Entries[0][1]='Company';t.data.Comments.pop();assert.throws(()=>t.a.pollFollowupDiscord(),/縮短/);assert.equal(t.sent.length,0);
});
test('missing webhook cannot create a trigger or baseline that loses later events',()=>{
  const t=app();t.props.delete('FOLLOWUP_DISCORD_WEBHOOK');assert.throws(()=>t.a.installFollowupDiscord(),/Webhook/);assert.equal(t.triggers.length,0);
});
test('rate limit preserves the queue and does not immediately hammer Discord',()=>{
  const t=app();t.a.installFollowupDiscord();t.data.Entries.push(entry('new'));t.codes.push(429);t.a.pollFollowupDiscord();t.a.pollFollowupDiscord();assert.equal(t.sent.length,1);
});
test('an unfinished long comment is resumed before a newly appended entry',()=>{
  const t=app();t.a.installFollowupDiscord();for(let i=0;i<19;i++) t.data.Entries.push(entry('new-'+i));
  t.data.Comments.push(['long-comment','old','Person B','Comment text '.repeat(400),'2026-01-02']);
  t.a.pollFollowupDiscord();t.data.Entries.push(entry('later-entry','Later entry'));
  assert.doesNotThrow(()=>t.a.pollFollowupDiscord());assert.ok(t.sent.some(x=>x.content.includes('Later entry')));
});
