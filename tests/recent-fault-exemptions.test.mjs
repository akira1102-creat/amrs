import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function setup(storage=new Map()){
  const start=html.indexOf('function recentFaultExemptionKey(');
  assert.notEqual(start,-1,'editable reminder exemptions must be available');
  const elements={recentFaultExemptionOptions:{innerHTML:''},recentFaultExemptionSummary:{textContent:''},date:{value:'2026-09-04'}};
  const requests=[],toasts=[];
  const context=vm.createContext({activeCompany:'SCL',REASONS:['PM','PO','Test Fault'],queue:[],todayRecords:[],isSubmitting:false,_submitCheckBusy:false,
    document:{getElementById:id=>elements[id]},
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},
    esc:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    showToast:(...args)=>toasts.push(args),URLSearchParams,fmtDate:value=>value.replaceAll('-','/'),getScriptUrl:()=> 'https://example.invalid',
    fetchJsonWithTimeout:async url=>{requests.push(new URL(url));return {success:true,duplicates:{'9001':2}};},
  });
  vm.runInContext(html.slice(start,html.indexOf('function todaySheetDate()',start)),context);
  return {context,elements,storage,requests,toasts};
}

test('every company starts with only PM exempt; blank and malformed settings keep that default',()=>{
  const {context,storage}=setup();
  for(const company of ['SCL','GEG','MGM','Melco','Wynn','SJM']){
    assert.deepEqual(Array.from(context.getRecentFaultExemptions(company)),['PM']);
  }
  for(const raw of ['bad','{}','[null,1]']){
    storage.set(context.recentFaultExemptionKey('SCL'),raw);
    assert.deepEqual(Array.from(context.getRecentFaultExemptions('SCL')),['PM']);
  }
});

test('multi-select persists per company and survives a new page; empty selection enables PM checks',async()=>{
  const {context,storage,requests}=setup();
  context.setRecentFaultExemption('PO',true);
  context.queue=[{company:'SCL',sn:'9001',model:'TAE',reason:' po ',date:'2026/09/04'}];
  assert.equal((await context.collectRecentDuplicateWarnings()).length,0);
  assert.equal(requests.length,0);
  assert.deepEqual(Array.from(setup(storage).context.getRecentFaultExemptions('SCL')),['PM','PO']);
  assert.deepEqual(Array.from(context.getRecentFaultExemptions('GEG')),['PM']);
  context.setRecentFaultExemption('PO',false);
  context.setRecentFaultExemption('PM',false);
  context.queue[0].reason='PM';
  assert.equal((await context.collectRecentDuplicateWarnings()).length,1);
  assert.equal(requests[0].searchParams.get('reason'),'PM');
  assert.equal(requests[0].searchParams.get('includePm'),'1');
  assert.deepEqual(Array.from(setup(storage).context.getRecentFaultExemptions()),[]);
});

test('only 30-day reminders use exemptions; same-day duplicate protection remains active',async()=>{
  const {context,requests}=setup();
  context.duplicateMachineKey=(model,sn)=>`${model}:${sn}`;
  context.setRecentFaultExemption('PO',true);
  context.queue=[
    {company:'SCL',model:'SAE',sn:'9001',reason:'PO',date:'2026/09/04'},
    {company:'SCL',model:'SAE',sn:'9001',reason:'PO',date:'2026/09/04'},
    {company:'GEG',model:'TAE',sn:'9001',reason:'PO',date:'2026/09/03'},
  ];
  assert.ok(context.collectQueueDuplicateWarnings().length>0);
  const warnings=await context.collectRecentDuplicateWarnings();
  assert.equal(requests.length,1);
  assert.equal(requests[0].searchParams.get('company'),'GEG');
  assert.equal(requests[0].searchParams.get('model'),'TAE');
  assert.equal(requests[0].searchParams.get('date'),'2026/09/03');
  assert.match(warnings[0].message,/PO/);
  assert.match(warnings[0].message,/2 筆/);
});

test('selector uses current editable reasons and preserves removed selected reasons safely',()=>{
  const {context,elements}=setup();
  context.setRecentFaultExemption('Old Reason',true);
  context.REASONS=['PM','New Reason','<Test>'];
  context.renderRecentFaultExemptions();
  assert.match(elements.recentFaultExemptionOptions.innerHTML,/New Reason/);
  assert.match(elements.recentFaultExemptionOptions.innerHTML,/Old Reason/);
  assert.match(elements.recentFaultExemptionOptions.innerHTML,/&lt;Test>/);
  assert.match(elements.recentFaultExemptionSummary.textContent,/PM.*Old Reason/);
});

test('storage failure and an active submission do not silently change exemptions',()=>{
  const {context,toasts}=setup();
  context.localStorage.setItem=()=>{throw Error('synthetic storage failure');};
  context.setRecentFaultExemption('PO',true);
  assert.deepEqual(Array.from(context.getRecentFaultExemptions()),['PM']);
  assert.equal(toasts.length,1);
  context._submitCheckBusy=true;
  context.setRecentFaultExemption('PM',false);
  assert.deepEqual(Array.from(context.getRecentFaultExemptions()),['PM']);
});
