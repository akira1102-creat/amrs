import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const path = new URL('../integrations/report-gas/company-reports.js',import.meta.url);
function app() {
  const context=vm.createContext({Utilities:{formatDate:(date,_zone,format)=>format==='yyyy/MM/dd'?date.toISOString().slice(0,10).replaceAll('-','/'):date.toISOString().slice(2,7).replace('-','')}});
  if(fs.existsSync(path)) vm.runInContext(fs.readFileSync(path,'utf8'),context);
  return context;
}
const row=(venue,date,reason,error='')=>[venue,date,'2610','Type','synthetic-serial',reason,'Action',error];
test('new rows group by venue and date and error descriptions become Check Request',()=>{
 const a=app();assert.equal(typeof a.summarizeDailyCompanyRows_,'function');
 const s=a.summarizeDailyCompanyRows_({company:'Test Group',reasonIndex:5,errorIndex:7},[row('Site Alpha','2026-10-08','PM'),row('Site Alpha','2026-10-08','Other','Details'),row('Site Beta','2026-10-07','PM')]);
 assert.match(s,/Site Alpha.*2026\/10\/08/);assert.match(s,/Total: 2/);assert.match(s,/Check Request: 1/);assert.match(s,/PM: 1/);assert.match(s,/sum total: \*\*3\*\*/);
});
test('alternate schema uses its own reason and error indexes',()=>{
 const a=app();assert.equal(typeof a.summarizeDailyCompanyRows_,'function');
 const data=[['Site Alpha','2026-10-08','2610','Type','synthetic-serial','seal','new seal','PM','Action','']];
 const s=a.summarizeDailyCompanyRows_({company:'Alternate',reasonIndex:7,errorIndex:9},data);assert.match(s,/PM: 1/);assert.doesNotMatch(s,/seal: 1/);
});
test('first run includes only today while an existing cursor includes backdated newly appended rows',()=>{
 const a=app();assert.equal(typeof a.selectDailyReportRows_,'function');
 const rows=[row('Site Alpha','2026-10-01','PM'),row('Site Alpha','2026-10-08','PM'),row('Site Beta','2026-10-03','PM')];
 assert.equal(a.selectDailyReportRows_(rows,null,'2026/10/08').length,1);
 const result=a.selectDailyReportRows_(rows,3,'2026/10/08');assert.equal(result.length,1);assert.equal(result[0][1],'2026-10-03');
});
test('invalid dates and blank or unlabelled rows are not counted',()=>{
 const a=app();assert.equal(typeof a.summarizeDailyCompanyRows_,'function');
 const s=a.summarizeDailyCompanyRows_({company:'Test',reasonIndex:5,errorIndex:7},[row('Site Alpha','bad date','PM'),row('','2026-10-08','PM'),row('Site Alpha','2026-10-08','')]);assert.equal(s,'');
});
test('custom reason names cannot collide with object prototype fields',()=>{const a=app();const s=a.summarizeDailyCompanyRows_({company:'Test',reasonIndex:5,errorIndex:7},[row('Site Alpha','2026-10-08','constructor'),row('Site Alpha','2026-10-08','__proto__')]);assert.match(s,/constructor: 1/);assert.match(s,/\\_\\_proto\\_\\_: 1/);});
test('monthly summary does not fabricate machine targets and still shows scheduled visits',()=>{
 const a=app();assert.equal(typeof a.buildCompanyMonthlyText_,'function');
 const s=a.buildCompanyMonthlyText_({company:'Test',venues:['Site Alpha']},{done:{'Site Alpha':4},targets:{},total:4},{done:{'Site Alpha':2},targets:{},total:2},{'Site Alpha':3});
 assert.match(s,/本月已做.*2.*4/);assert.match(s,/剩 3 次/);assert.doesNotMatch(s,/平均每次|Remain:|剩餘台數/);
});
test('monthly machine targets calculate completion and ceiling average',()=>{
 const a=app();assert.equal(typeof a.buildCompanyMonthlyText_,'function');
 const s=a.buildCompanyMonthlyText_({company:'Test',venues:['Site Alpha','Site Beta']},{done:{'Site Alpha':4,'Site Beta':8},targets:{'Site Alpha':11,'Site Beta':5},total:12},{done:{'Site Alpha':2,'Site Beta':3},targets:{'Site Alpha':11,'Site Beta':5},total:5},{'Site Alpha':3,'Site Beta':2});
 assert.match(s,/平均每次 3/);assert.match(s,/本月已完成/);
});
test('unchanged monthly values do not generate another notification',()=>{
 const a=app();assert.equal(typeof a.buildCompanyMonthlyText_,'function');const s={done:{'Site Alpha':4},targets:{},total:4};assert.equal(a.buildCompanyMonthlyText_({company:'Test',venues:['Site Alpha']},s,s,{'Site Alpha':3}),'');
});
test('remaining visits count distinct days, ignore starred-only visits and remarks',()=>{
 const a=app();assert.equal(typeof a.countCompanyRemainingVisits_,'function');
 const rows=[['','Marco','Other','Remark','Marco','Other','Remark'],[8,'A','','','','',''],[9,'A','A','','A','',''],[10,'A*','','A','','',''],[11,'','','A','','',''],[12,'Public Holiday','','','A','','']];
 const result=a.countCompanyRemainingVisits_(rows,[{venues:['Site Alpha'],codes:{'Site Alpha':'A'}}],8);assert.equal(result['Site Alpha'],1);
});
test('long reports split within Discord limit without losing emoji or content',()=>{
 const a=app();assert.equal(typeof a.splitDailyCompanyMessages_,'function');const text='📋'.repeat(3000);const chunks=a.splitDailyCompanyMessages_(text);assert.equal(chunks.join(''),text);for(const c of chunks){assert.ok(c.length<=1900);assert.doesNotMatch(c,/[\uD800-\uDBFF]$/);}
});

function reportRuntime({failSend=false,failRead=false,legacy=false}={}) {
 const state=legacy?{lastSentRow:'2',lastData:JSON.stringify({'Site Alpha Remain':9,'本月Total':1})}:{};
 const sent=[];let released=false;
 const sources=['Group One','Group Two','Group Three','Group Four','Group Five','Group Six'].map((company,index)=>({company,sheetId:'synthetic-'+index,venues:['Site Alpha'],codes:{'Site Alpha':'A'},width:8,reasonIndex:5,errorIndex:7,...(legacy&&index===0?{legacy:true,targetCells:{'Site Alpha':4}}:{})}));
 const rows=[['CASINO','DATE','PO Number','Model','Serial No.','Reason','Action Taken','Error Description'],row('Site Alpha','2026-10-01','PM'),row('Site Alpha','2026-10-08','PM')];
 const monthly=Array.from({length:22},()=>['','','']);monthly[1][1]='2610';monthly[3][2]=10;
 const props={getProperty:key=>state[key]??null,setProperties:values=>Object.assign(state,values)};
 class Clock extends Date { constructor(...args){super(...(args.length?args:['2026-10-08T08:00:00Z']));} }
 const a=vm.createContext({Date:Clock,REPORT_SOURCES:sources,SCHEDULE_SHEET_ID:'synthetic-schedule',PropertiesService:{getScriptProperties:()=>props},console:{log:()=>{}},
 Utilities:{formatDate:(date,_zone,format)=>format==='yyyy/MM/dd'?date.toISOString().slice(0,10).replaceAll('-','/'):date.toISOString().slice(2,7).replace('-','')},
 LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{released=true;}})},
 sendToDiscord:text=>{sent.push(text);return !failSend;},
 SpreadsheetApp:{openById:id=>{
  if(failRead&&id==='synthetic-2')throw Error('Synthetic private error');
  if(id==='synthetic-schedule')return{getSheetByName:()=>({getDataRange:()=>({getValues:()=>[['','Marco','Remark','Marco','Remark'],[9,'A','','A','']]})})};
  return{getSheetByName:name=>name==='Monthly'?{getRange:()=>({getValues:()=>monthly})}:{getLastRow:()=>rows.length,getRange:()=>({getValues:()=>rows})}};
 }} });
 vm.runInContext(fs.readFileSync(path,'utf8'),a);return{a,state,sent,released:()=>released};
}
test('all six groups share one report run and retain independent sent cursors',()=>{
 const s=reportRuntime();s.a.runAllDailyCompanyReports_();const text=s.sent.join('');for(const group of ['One','Two','Three','Four','Five','Six']){assert.match(text,new RegExp('Group '+group));assert.equal(s.state['dailyReport.Group '+group+'.row'],'3');}assert.doesNotMatch(text,/2026\/10\/01/);
 const count=s.sent.length;s.a.runAllDailyCompanyReports_();assert.equal(s.sent.length,count);assert.equal(s.released(),true);
});
test('Discord failure does not advance sent cursors or monthly snapshots',()=>{const s=reportRuntime({failSend:true});assert.throws(()=>s.a.runAllDailyCompanyReports_(),/發送失敗/);assert.deepEqual(s.state,{});assert.equal(s.released(),true);});
test('unreadable source prevents false success and state advancement',()=>{const s=reportRuntime({failRead:true});assert.throws(()=>s.a.runAllDailyCompanyReports_(),/Synthetic private error/);assert.equal(s.sent.length,0);assert.deepEqual(s.state,{});assert.equal(s.released(),true);});
test('read-only verification does not send Discord or update cursors',()=>{const s=reportRuntime();const result=s.a.verifyAllDailyCompanyReports_();assert.equal(result.readOk,true);assert.equal(result.companies.length,6);assert.equal(s.sent.length,0);assert.deepEqual(s.state,{});});
test('legacy cursor and monthly snapshot migrate without re-reporting history',()=>{const s=reportRuntime({legacy:true});s.a.runAllDailyCompanyReports_();assert.doesNotMatch(s.sent.join(''),/2026\/10\/01/);assert.match(s.sent.join(''),/9 → \*\*8\*\*/);assert.equal(s.state.lastSentRow,'3');assert.equal(JSON.parse(s.state.lastData)['Site Alpha Remain'],8);});
