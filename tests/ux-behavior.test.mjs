import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');

test('cached navigation resolves even when the network never finishes',async()=>{
  const handlers={},cached={cached:true};let response;
  vm.runInNewContext(fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8'),{
    self:{location:{origin:'https://example.invalid'},addEventListener:(type,fn)=>handlers[type]=fn},
    URL,caches:{match:async()=>cached},fetch:()=>new Promise(()=>{}),
  });
  handlers.fetch({request:{url:'https://example.invalid/',method:'GET',mode:'navigate'},waitUntil:()=>{},respondWith:p=>response=p});
  assert.equal(await Promise.race([response,new Promise(resolve=>setTimeout(()=>resolve('timeout'),100))]),cached);
});

test('submission checks start together and preserve state warnings before confirmation',async()=>{
  const source=html.slice(html.indexOf('async function submitAll()'),html.indexOf('function cancelConfirm()'));
  let finishDuplicate,finishState,opened;
  const started=[];
  const context=vm.createContext({
    queue:[{sn:'9001',model:'SAE',reason:'PM',date:'2026/01/01'}],activeCompany:'SCL',_submitCheckBusy:false,
    document:{getElementById:()=>({value:'2026-01-01'})},fmtDate:s=>s,
    collectQueueDuplicateWarnings:()=>[],syncSubmitButtonState:()=>{},showLoadingProgress:()=>({}),hideLoadingProgress:()=>{},
    collectRecentDuplicateWarnings:()=>{started.push('duplicates');return new Promise(resolve=>finishDuplicate=resolve);},
    collectSubmissionWarnings:()=>{started.push('states');return new Promise(resolve=>finishState=resolve);},
    openSubmissionWarningModal:rows=>opened=rows,showSubmitConfirmation:()=>assert.fail('must show state reminders first'),
  });
  vm.runInContext(source,context);
  const promise=context.submitAll();assert.deepEqual(started,['duplicates','states']);
  finishState([{holding:true}]);finishDuplicate([]);await promise;
  assert.equal(opened[0].holding,true);assert.equal(context._submitCheckBusy,false);
});

test('safe update refuses to reload during submission or failed draft save',()=>{
  const source=html.slice(html.indexOf('function applySafeUpdate()'),html.indexOf('function offerSafeUpdate()'));
  let reloads=0,saves=0;
  const context=vm.createContext({_updatePending:true,isSubmitting:true,_submitCheckBusy:false,dashboardEditingIdx:-1,_galaxyLogApp:null,
    document:{querySelector:()=>null},saveInputDraft:()=>{saves++;return false;},window:{location:{reload:()=>reloads++}},showToast:()=>{},
  });
  vm.runInContext(source,context);context.applySafeUpdate();assert.equal(saves,0);
  context.isSubmitting=false;context.applySafeUpdate();assert.equal(saves,1);assert.equal(reloads,0);
  context.saveInputDraft=()=>true;context.applySafeUpdate();assert.equal(reloads,1);
});
