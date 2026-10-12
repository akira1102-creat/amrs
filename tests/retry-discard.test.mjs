import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('// ── Retry Queue');
const end=html.indexOf('// ── Broken Parts',start);
const chunk=(company,id)=>({records:[{company,submissionId:id,serialNo:'1234'}],repairs:[{company,record:{rowNumber:2}}]});
function app(items=[chunk('SCL','synthetic-scl')],options={}) {
  const storage=options.storage||new Map([['_ml_retry',JSON.stringify(items)],['_ml_queue_SCL','unsubmitted-draft'],['auth','unchanged']]);
  const elements=new Map(['retryNotice','retryNoticeMsg','retrySyncBtn','retryDeleteBtn'].map(id=>[id,{style:{},disabled:false,textContent:''}]));
  const timers=new Map(),events={},messages=[],confirmations=[],sent=[];
  let timerId=0,failStorage=false;
  const ctx=vm.createContext({activeCompany:'SCL',navigator:{onLine:false},document:{getElementById:id=>elements.get(id)||null},
    localStorage:{getItem:key=>storage.get(key)||null,setItem(key,value){if(failStorage)throw Error('synthetic storage failure');storage.set(key,value);}},
    window:{addEventListener:(name,fn)=>{events[name]=fn;},confirm:message=>{confirmations.push(message);return options.confirm!==false;}},
    setTimeout:(fn)=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),
    ensureSubmissionIds:()=>false,showToast:(...args)=>messages.push(args),getScriptUrl:()=> 'https://synthetic.invalid',
    postSubmissionJson:async body=>{sent.push(body);return options.send?options.send(body):{success:true};},_appendLocalLog:()=>{},
  });
  vm.runInContext(html.slice(start,end)+'\nthis.state=()=>({queue:_retryQueue,busy:_retryBusy,error:_retryLastError});',ctx);
  ctx._updateRetryNotice();
  return {ctx,storage,elements,timers,events,messages,confirmations,sent,failStorage:value=>{failStorage=value;}};
}

test('discard removes pending local records after confirmation without sending or touching drafts',async()=>{
  const t=app();assert.equal(typeof t.ctx.discardSubmissionRetries,'function');
  t.ctx.navigator.onLine=true;t.ctx._scheduleRetry(1000);assert.equal(t.timers.size,1);
  t.ctx.discardSubmissionRetries();assert.equal(t.confirmations.length,1);
  assert.match(t.confirmations[0],/SCL.*1 筆/);assert.match(t.confirmations[0],/不會刪除.*雲端/);
  assert.match(t.confirmations[0],/若尚未寫入雲端.*需重新輸入/);
  assert.equal(JSON.parse(t.storage.get('_ml_retry')).length,0);assert.equal(t.timers.size,0);
  assert.equal(t.elements.get('retryNotice').style.display,'none');
  assert.equal(t.storage.get('_ml_queue_SCL'),'unsubmitted-draft');assert.equal(t.storage.get('auth'),'unchanged');
  await t.ctx._attemptRetry();assert.equal(t.sent.length,0);
});

test('cancel preserves records, pending timer and cloud data',()=>{
  const t=app(undefined,{confirm:false});assert.equal(typeof t.ctx.discardSubmissionRetries,'function');
  t.ctx.navigator.onLine=true;t.ctx._scheduleRetry();const before=t.storage.get('_ml_retry');
  t.ctx.discardSubmissionRetries();assert.equal(t.storage.get('_ml_retry'),before);assert.equal(t.timers.size,1);assert.equal(t.sent.length,0);
});

test('discard targets the displayed company and preserves other company records and repairs',()=>{
  const mixed={records:[{company:'SCL',submissionId:'synthetic-a'},{company:'MGM',submissionId:'synthetic-b'}],repairs:[{company:'SCL',record:{rowNumber:2}},{company:'MGM',record:{rowNumber:3}}]};
  const t=app([mixed,chunk('SCL','synthetic-c'),chunk('GEG','synthetic-d')]);assert.equal(typeof t.ctx.discardSubmissionRetries,'function');
  assert.match(t.elements.get('retryNoticeMsg').textContent,/^2 筆/);
  t.ctx.discardSubmissionRetries();const remaining=JSON.parse(t.storage.get('_ml_retry'));
  assert.deepEqual(remaining.map(x=>x.records[0].company),['MGM','GEG']);assert.equal(remaining[0].repairs[0].company,'MGM');
  t.ctx.activeCompany='MGM';t.ctx._updateRetryNotice();assert.match(t.elements.get('retryNoticeMsg').textContent,/^1 筆/);
});

test('discard remains discarded after app restart and an online event',async()=>{
  const t=app();assert.equal(typeof t.ctx.discardSubmissionRetries,'function');t.ctx.discardSubmissionRetries();
  const reopened=app([],{storage:t.storage});reopened.ctx.navigator.onLine=true;reopened.events.online();
  assert.equal(reopened.timers.size,0);await reopened.ctx._attemptRetry();assert.equal(reopened.sent.length,0);
});

test('an in-flight retry cannot be discarded or cause another batch to be removed',async()=>{
  let finish;const t=app([chunk('SCL','synthetic-a'),chunk('MGM','synthetic-b')],{send:()=>new Promise(resolve=>{finish=resolve;})});
  assert.equal(typeof t.ctx.discardSubmissionRetries,'function');t.ctx.navigator.onLine=true;const running=t.ctx._attemptRetry();
  assert.equal(t.elements.get('retryDeleteBtn').disabled,true);t.ctx.discardSubmissionRetries();assert.equal(t.confirmations.length,0);
  finish({success:false,message:'Synthetic failed result',retryable:false});await running;
  assert.equal(t.ctx.state().queue.length,2);assert.equal(t.elements.get('retryDeleteBtn').disabled,false);
});

test('failed local persistence leaves pending data intact and warns the user',()=>{
  const t=app();assert.equal(typeof t.ctx.discardSubmissionRetries,'function');const before=t.storage.get('_ml_retry');t.failStorage(true);
  t.ctx.discardSubmissionRetries();assert.equal(t.storage.get('_ml_retry'),before);assert.equal(t.ctx.state().queue.length,1);
  assert.ok(t.messages.some(([text,type])=>type==='err'&&/未能刪除/.test(text)));
});
