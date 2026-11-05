import assert from 'node:assert/strict';
import test from 'node:test';
let reasonStatsFromRows;
try{({reasonStatsFromRows}=await import('../src/reason-stats.mjs'));}catch{}
test('reason statistics use dates and company-specific columns without exposing machine records',()=>{
 assert.equal(typeof reasonStatsFromRows,'function','reason statistics must be implemented');
 const rows=[
  ['Venue A','2026/11/01','OLD-PO','SAE','9001',' PM '],
  ['Venue B','2026/11/02','NEW-PO','TAE','9002','Wrong Reading'],
  ['Venue C','2026/11/03','','SAE','9001',' wrong reading '],
  ['Venue C','2026/11/04','','SAE','9003',''],
  ['Venue C','2026/10/31','','SAE','9004','Too old'],
  ['Venue C','2026/12/01','','SAE','9005','Too new'],
  ['Venue C','not-a-date','','SAE','9006','Invalid date'],
  ['','','','','','']
 ];
 const r=reasonStatsFromRows(rows,{company:'SCL',month:'2026-11'},[{reason:'Custom reason'},{reason:'PM'}]);
 assert.equal(r.total,4);
 assert.equal(r.blankReasons,1);
 assert.deepEqual(r.reasons,[{reason:'Wrong Reading',count:2},{reason:'PM',count:1}]);
 assert.ok(r.reasonOptions.includes('Custom reason'));
 assert.ok(!JSON.stringify(r).includes('9001'));
 const geg=reasonStatsFromRows([['Galaxy','2026/11/01','','AE3','9001','00123','00456','Seal Broken']],{company:'GEG',month:'2026-11'});
 assert.deepEqual(geg.reasons,[{reason:'Seal Broken',count:1}]);
 assert.equal(reasonStatsFromRows(rows,{company:'SCL',month:'all'}).total,6);
 assert.throws(()=>reasonStatsFromRows(rows,{company:'BAD',month:'2026-11'}),/company/i);
 assert.throws(()=>reasonStatsFromRows(rows,{company:'SCL',month:'2026-13'}),/month/i);
});
