import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('// ── Retry Queue'),html.indexOf('// ── Broken Parts',html.indexOf('// ── Retry Queue')));
const record=(id,company='SCL')=>({submissionId:id,company,serialNo:'1234',model:'SAE',casino:'Sample',date:'2026/01/02',reason:'PM',actionTaken:'Inspection',inspector:'Sample User'});
function app({legacy=[],items=[],confirm=true,status,fail=false}={}){
  const storage=new Map([['_ml_retry',JSON.stringify(legacy)],['_ml_queue_v2_SCL',JSON.stringify(items)],['auth','untouched']]);
  const elements=new Map(['retryNotice','retryNoticeMsg','retrySyncBtn','retryDeleteBtn'].map(id=>[id,{style:{},disabled:false,textContent:''}]));
  const timers=new Map(),events={},messages=[],confirmations=[],logs=[],reads=[];
  let failStorage=fail;
  const ctx=vm.createContext({queue:structuredClone(items),activeCompany:'SCL',isSubmitting:false,_submitCheckBusy:false,editingIdx:-1,editTemp:null,selectedQueueIdxs:new Set(),COMPANIES:['SCL','MGM','GEG'],
    document:{getElementById:id=>elements.get(id)||null},navigator:{onLine:true},
    localStorage:{getItem:key=>storage.get(key)||null,removeItem:key=>storage.delete(key),setItem(key,value){if(failStorage)throw Error('synthetic storage failure');storage.set(key,value);}},
    window:{addEventListener:(type,fn)=>{events[type]=fn;},confirm:message=>{confirmations.push(message);return confirm;}},
    setTimeout:fn=>{timers.set(1,fn);return 1;},clearTimeout:id=>timers.delete(id),
    ensureSubmissionIds:()=>false,queueStorageKey:company=>'_ml_queue_v2_'+company,
    showToast:(...args)=>messages.push(args),renderQueue(){},saveQueue(){ctx.localStorage.setItem('_ml_queue_v2_SCL',JSON.stringify(ctx.queue));},
    _appendLocalLog:rows=>logs.push(...rows),_dualTransport:{getSubmissionStatus:async id=>{reads.push(id);return status?status(id):{success:true,status:'failed',items:[]};}},
    submitAll:()=>{throw Error('must not automatically submit');},
  });
  vm.runInContext(source+'\nthis.pendingLegacy=()=>_retryQueue;',ctx);
  return {ctx,storage,elements,timers,events,messages,confirmations,logs,reads,failStorage:value=>{failStorage=value;}};
}

test('legacy retries become individually visible editable queue items without automatic uploads',()=>{
  const t=app({legacy:[{records:[record('one'),record('two')],repairs:[{company:'SCL',record:{serialNo:'1234',model:'SAE',rowNumber:2,bpRepairDay:'2026/01/02'}}]}],items:[{submissionId:'draft',sn:'2222',company:'SCL'}]});
  assert.deepEqual(Array.from(t.ctx.queue,item=>item.submissionId),['draft','one','two']);
  assert.equal(t.ctx.queue[1].sn,'1234');assert.equal(t.ctx.queue[1].action,'Inspection');
  assert.equal(t.ctx.queue[1].submissionRecovery.state,'unknown');
  assert.equal(t.ctx.queue[1].submissionRecovery.lookupId,t.ctx.queue[2].submissionRecovery.lookupId);
  assert.equal(t.ctx.queue[1].retryRepairs[0].record.rowNumber,2);
  assert.equal(JSON.parse(t.storage.get('_ml_retry')).length,0);
  assert.equal(t.timers.size,0);assert.equal(t.storage.get('auth'),'untouched');
});

test('failed submission retains every remaining row, distinguishing an unknown first chunk from unattempted chunks',()=>{
  const t=app({items:[{submissionId:'one',sn:'1234',company:'SCL'},{submissionId:'two',sn:'2345',company:'SCL'}]});
  t.ctx.queueSubmissionRetry([{records:[record('one')]},{records:[record('two')]}],0,{message:'Synthetic timeout',unknownOutcome:true,batchId:'synthetic-batch'});
  assert.equal(t.ctx.queue.length,2);assert.equal(t.ctx.queue[0].submissionRecovery.state,'unknown');
  assert.equal(t.ctx.queue[1].submissionRecovery.state,'not-sent');
  assert.equal(JSON.parse(t.storage.get('_ml_queue_v2_SCL')).length,2);
  assert.equal(t.timers.size,0);
});

test('an explicit server failure is still reconciled before editing because a main row may already exist',async()=>{
  const t=app({items:[{submissionId:'one',sn:'1234',company:'SCL'}],status:()=>({status:'failed',result:{requiresOriginalPayload:true},items:[{submissionId:'one',status:'inserted'}]})});
  t.ctx.queueSubmissionRetry([{records:[record('one')]}],0,{message:'Synthetic followup failure',unknownOutcome:false});
  assert.equal(await t.ctx.reconcileQueuedSubmissions(),true);
  assert.equal(t.reads.length,1);assert.equal(t.ctx.queue[0].submissionRecovery.state,'replay');
});

test('migration persists before removing the old retry store and is idempotent across restarts',()=>{
  const legacy=[{records:[record('one')]}];
  const blocked=app({legacy,fail:true});assert.equal(blocked.ctx.pendingLegacy().length,1);assert.equal(blocked.ctx.queue.length,0);
  assert.equal(JSON.parse(blocked.storage.get('_ml_retry')).length,1);
  const t=app({legacy,items:[{submissionId:'one',sn:'1234',company:'SCL'}]});
  assert.equal(t.ctx.queue.length,1);assert.equal(t.ctx.queue[0].submissionRecovery.state,'unknown');
});

test('cancel pending submissions removes only highlighted local rows after confirmation, never cloud or ordinary drafts',()=>{
  const t=app({legacy:[{records:[record('one'),record('other','MGM')]}],items:[{submissionId:'draft',sn:'2222',company:'SCL'}]});
  t.ctx.discardSubmissionRetries();assert.equal(t.confirmations.length,1);
  assert.equal(t.ctx.queue.length,1);assert.equal(t.ctx.queue[0].submissionId,'draft');
  assert.equal(JSON.parse(t.storage.get('_ml_queue_v2_MGM')).length,1);assert.equal(t.reads.length,0);
  assert.equal(t.storage.get('auth'),'untouched');assert.equal(t.timers.size,0);
});

test('cancel confirmation and failed persistence cannot discard pending data',()=>{
  const cancelled=app({legacy:[{records:[record('one')]}],confirm:false});cancelled.ctx.discardSubmissionRetries();assert.equal(cancelled.ctx.queue.length,1);
  const blocked=app({legacy:[{records:[record('one')]}]});blocked.failStorage(true);blocked.ctx.discardSubmissionRetries();assert.equal(blocked.ctx.queue.length,1);
  assert.ok(blocked.messages.some(([message,type])=>type==='err'&&/未能/.test(message)));
});

test('recovery checks once per batch and removes only acknowledged rows before a new submit',async()=>{
  const t=app({legacy:[{records:[record('saved'),record('missing')]}],status:()=>({success:true,status:'failed',items:[{submissionId:'saved',status:'inserted'},{submissionId:'missing',status:'failed'}]})});
  assert.equal(await t.ctx.reconcileQueuedSubmissions(),true);
  assert.equal(t.reads.length,1);assert.equal(t.ctx.queue.length,1);assert.equal(t.ctx.queue[0].submissionId,'missing');
  assert.equal(t.ctx.queue[0].submissionRecovery.state,'failed');assert.equal(t.logs[0].submissionId,'saved');
});

test('still processing rows and failed status reads stay highlighted and cannot be edited or resubmitted unsafely',async()=>{
  for(const status of [()=>({success:true,status:'processing'}),()=>{throw Error('Synthetic offline');}]){
    const t=app({legacy:[{records:[record('one')]}],status});
    assert.equal(await t.ctx.reconcileQueuedSubmissions(),false);assert.equal(t.ctx.queue.length,1);
    assert.equal(t.ctx.queue[0].submissionRecovery.state,'unknown');
  }
});

test('a missing server batch permits only an original-payload retry, never claims rows were confirmed absent',async()=>{
  const t=app({legacy:[{records:[record('one')]}],status:()=>{throw Object.assign(Error('Not found'),{httpStatus:404});}});
  assert.equal(await t.ctx.reconcileQueuedSubmissions(),true);
  assert.equal(t.ctx.queue[0].submissionRecovery.state,'replay');
  assert.ok(!t.ctx.queue[0].submissionRecovery.message.includes('已核對未寫入'));
});

test('partially written followups retain the original payload for an idempotent retry instead of being silently dropped',async()=>{
  const t=app({legacy:[{records:[record('one')]}],status:()=>({success:true,status:'failed',result:{requiresOriginalPayload:true},items:[{submissionId:'one',status:'inserted'}]})});
  assert.equal(await t.ctx.reconcileQueuedSubmissions(),true);
  assert.equal(t.ctx.queue.length,1);assert.equal(t.ctx.queue[0].submissionRecovery.state,'replay');assert.equal(t.logs.length,0);
});

test('a 48-row submission keeps the 28 unsaved records individually in the queue after a mid-submit failure',async()=>{
  const items=Array.from({length:48},(_,i)=>({submissionId:'synthetic-'+i,company:'SCL',sn:String(1000+i),model:'SAE',casino:'Sample',date:'2026/01/02',reason:'PM',action:'Inspection'}));
  const t=app({items});
  for(const [id,value] of [['casino','Sample'],['date','2026-01-02'],['poNumber','synthetic-po'],['submitBtn',''],['confirmModal','']])t.elements.set(id,{value,disabled:false,textContent:'',classList:{remove(){}}});
  let sends=0;
  Object.assign(t.ctx,{_pendingSubmissionRepairs:[],_pendingSubmitSummary:null,_casinoKey:company=>'casino-'+company,saveCompanyPoNumber(){},fmtDate:value=>value.replaceAll('-','/'),
    clearMonthlyStatsCache(){},loadTodayRecords(){},showSubmitProgress(){},hideSubmitProgress(){},syncSubmitButtonState(){},mergeSubmissionRepairs:rows=>rows,
    postSubmissionJson:async()=>{if(++sends===1)return {success:true,inserted:20};throw Object.assign(Error('Synthetic lost response'),{unknownOutcome:true,batchId:'synthetic-lost-batch'});},
  });
  vm.runInContext(html.slice(html.indexOf('async function doSubmit()'),html.indexOf('let _toastTimer')),t.ctx);
  await t.ctx.doSubmit();
  assert.equal(t.ctx.queue.length,28);
  assert.equal(t.ctx.queue[0].submissionId,'synthetic-20');
  assert.equal(t.ctx.queue.filter(item=>item.submissionRecovery?.state==='unknown').length,20);
  assert.equal(t.ctx.queue.filter(item=>item.submissionRecovery?.state==='not-sent').length,8);
  assert.equal(t.logs.length,20);assert.equal(sends,2);assert.equal(t.timers.size,0);
});

test('each retained failure renders its own highlight, edit button and cancellation button with escaped errors',()=>{
  const t=app({items:[{submissionId:'one',sn:'1234',company:'SCL'},{submissionId:'two',sn:'2345',company:'SCL'}]});
  t.ctx.queueSubmissionRetry([{records:[record('one')]},{records:[record('two')]}],0,{message:'<script>synthetic</script>',unknownOutcome:false});
  const nodes=new Map();
  t.ctx.document.getElementById=id=>{if(!nodes.has(id))nodes.set(id,{style:{},classList:{toggle(){}},textContent:'',innerHTML:''});return nodes.get(id);};
  Object.assign(t.ctx,{_isMob:true,renderQueueDuplicateNotice(){},syncSubmitButtonState(){},updateSnPadQueue(){}});
  vm.runInContext(html.slice(html.indexOf('function esc('),html.indexOf('function updateSnPadQueue()'))+html.slice(html.indexOf('function renderQueue()'),html.indexOf('function loadTodayRecords()')),t.ctx);
  t.ctx.renderQueue();
  const markup=nodes.get('queueList').innerHTML;
  assert.equal((markup.match(/class="q-item q-recovery/g)||[]).length,2);
  assert.equal((markup.match(/class="q-submit-status"/g)||[]).length,2);
  assert.equal((markup.match(/取消提交<\/button>/g)||[]).length,2);
  assert.equal((markup.match(/onclick="startEditQueue\(/g)||[]).length,2);
  assert.ok(!markup.includes('<script>synthetic</script>'));assert.ok(markup.includes('&lt;script&gt;'));
});

test('editing a confirmed unwritten failure preserves optional fields and drops repairs linked to a different machine',async()=>{
  const t=app({legacy:[{records:[{...record('one'),bpHoldDate:'2026/01/02',brokenParts:'TEST-PART'}],repairs:[{company:'SCL',record:{serialNo:'1234',model:'SAE',rowNumber:2}}]}],status:()=>({status:'failed',items:[{submissionId:'one',status:'failed'}]})});
  Object.assign(t.ctx,{ALL_ACTIONS:['Inspection'],canonicalAaTag:value=>value||'',fmtDate:value=>value.replaceAll('-','/'),scheduleQueueDuplicateCheck(){}});
  vm.runInContext(html.slice(html.indexOf('async function startEditQueue('),html.indexOf('function setEditActionMode('))+html.slice(html.indexOf('function saveEditQueue('),html.indexOf('function toggleQueueSelect(')),t.ctx);
  await t.ctx.startEditQueue(0);
  assert.equal(t.ctx.editingIdx,0);assert.equal(t.ctx.editTemp.brokenParts,'TEST-PART');
  t.ctx.editTemp.sn='2345';t.ctx.editTemp.model='TAE';t.ctx.editTemp.bpHoldDate='';
  t.ctx.saveEditQueue(0);
  assert.equal(t.ctx.queue[0].sn,'2345');assert.equal(t.ctx.queue[0].model,'TAE');assert.equal(t.ctx.queue[0].bpHoldDate,'');
  assert.equal(t.ctx.queue[0].retryRepairs.length,0);assert.equal(t.ctx.queue[0].submissionRecovery.state,'failed');
  assert.equal(JSON.parse(t.storage.get('_ml_queue_v2_SCL'))[0].sn,'2345');
});

test('individual cancellation keeps other rows and persists removal without uploading',()=>{
  const t=app({legacy:[{records:[record('one'),record('two')]}]});
  Object.assign(t.ctx,{confirm:t.ctx.window.confirm,showUndoNotice:()=>{}});
  vm.runInContext(html.slice(html.indexOf('function removeFromQueue('),html.indexOf('function esc(')),t.ctx);
  t.ctx.removeFromQueue(0);
  assert.equal(t.confirmations.length,1);assert.equal(t.ctx.queue.length,1);assert.equal(t.ctx.queue[0].submissionId,'two');
  assert.equal(JSON.parse(t.storage.get('_ml_queue_v2_SCL')).length,1);assert.equal(t.reads.length,0);assert.equal(t.timers.size,0);
});
