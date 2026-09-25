import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const renderSource=html.match(/function renderDashboardInsights\(stats,history\)\{[\s\S]*?\n\}/)?.[0];
assert.ok(renderSource,'dashboard insights renderer must exist');

function render(parts){
  const panel={innerHTML:'',classList:{add(){},remove(){}}};
  const context={document:{getElementById:()=>panel},esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')};
  vm.createContext(context);
  vm.runInContext(renderSource,context);
  context.renderDashboardInsights({total:1,models:{},topReasons:[],topCasinos:[],repeatSerials:[]},{serialNo:'1234',latestDate:'2026/09/23',casinos:['Test venue'],total:1,topReasons:[],parts});
  return panel.innerHTML;
}

test('UOD-only history omits empty parts placeholders and shows each field on its own line',()=>{
  const output=render([{brokenParts:'',bpRepairDay:'',bpUodActivationDate:'2026/09/22',bpUodUnlockDay:'Wait for Unlock',date:'2026/09/23'}]);
  assert.match(output,/零件或UOD履歷/);
  assert.doesNotMatch(output,/沒有使用零件|未設定/);
  assert.match(output,/UOD Activation[^<]*2026\/09\/22<\/div>/);
  assert.match(output,/UOD Unlock[^<]*Wait for Unlock<\/div>/);
  assert.match(output,/發現日期[^<]*2026\/09\/23<\/div>/);
  assert.doesNotMatch(output,/UOD Activation[^<]*·/);
});

test('history hides empty records but keeps parts and UOD records in separate blocks',()=>{
  const output=render([
    {brokenParts:'',bpRepairDay:'',date:'2026/09/20'},
    {brokenParts:'TEST-1',bpRepairDay:'Waiting',date:'2026/09/21'},
    {brokenParts:'',bpRepairDay:'',bpUodActivationDate:'2026/09/22',date:'2026/09/23'},
  ]);
  assert.equal((output.match(/class="dash-history-entry"/g)||[]).length,2);
  assert.match(output,/零件[^<]*TEST-1<\/div>/);
  assert.match(output,/維修日期[^<]*Waiting<\/div>/);
  assert.doesNotMatch(output,/2026\/09\/20/);
});
