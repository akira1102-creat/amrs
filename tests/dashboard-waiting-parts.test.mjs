import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function source(name){
  const match=html.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*?\\)\\{[\\s\\S]*?\\n\\}`));
  assert.ok(match,`${name} must be present`);
  return match[0];
}
function element(value=''){
  return {value,textContent:'',innerHTML:'',classList:{toggle(){},add(){},remove(){}},appendChild(){}};
}

test('exact SN query checks waiting parts even without a maintenance history',async()=>{
  const elements={dashSearch:element('1234'),dashFrom:element(),dashTo:element(),dashModel:element('SAE'),dashSort:element('newest'),dashRows:element(),dashMobileRows:element(),dashSummary:element()};
  const waitingCalls=[];
  const context={
    document:{getElementById:id=>elements[id],body:{classList:{toggle(){}}}},
    getScriptUrl:()=>'/api',parseDashVenueFilter:()=>({company:'SCL',casino:''}),
    isDashFuzzy:()=>false,validateDashSearchInput:()=>true,renderDashboardWaitingParts:()=>{},
    loadDashboardWaitingParts:(...args)=>{waitingCalls.push(args);},
    dashboardRecords:[],dashboardSelectedRecords:new Map(),dashboardRequest:null,dashboardPageSize:10,
    dashColspan:()=>10,updateDashboardPager(){},updateDashboardSelectionTools(){},showLoadingProgress:()=>1,hideLoadingProgress(){},
    fetchJsonWithTimeout:async()=>({success:true,records:[],totalMatches:0,page:1,totalPages:1,stats:null,history:null}),
    renderDashboardRows(){},renderDashboardInsights(){},showToast(){},URLSearchParams,AbortController,
    currentDashboardCompany:'',dashboardLastQuery:null,esc:value=>value,Date,
  };
  vm.createContext(context);
  vm.runInContext(source('loadDashboard'),context);
  await context.loadDashboard();
  assert.equal(waitingCalls.length,1);
  assert.equal(waitingCalls[0][0],'SCL');
  assert.equal(waitingCalls[0][1],'1234');
  assert.equal(waitingCalls[0][2],'SAE');
});

test('waiting-parts lookup limits results to exact SN, selected model and unresolved parts',async()=>{
  const panel=element();
  const urls=[];
  const records=[
    {serialNo:'1234',model:'SAE',brokenParts:'TEST-1',bpDesc:'Sensor',bpRepairDay:'Waiting',date:'2026/09/20',casino:'Test venue'},
    {serialNo:'1234',model:'TAE',brokenParts:'TEST-2',bpRepairDay:'Waiting',date:'2026/09/21'},
    {serialNo:'1234',model:'SAE',brokenParts:'TEST-3',bpRepairDay:'2026/09/22',date:'2026/09/20'},
    {serialNo:'9999',model:'SAE',brokenParts:'TEST-4',bpRepairDay:'Waiting',date:'2026/09/20'},
  ];
  const context={
    document:{getElementById:()=>panel},URLSearchParams,
    getScriptUrl:()=>'/api',
    fetchJsonWithTimeout:async url=>{urls.push(url);return {success:true,records,totalPages:1,totalMatches:4};},
    esc:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),
  };
  vm.createContext(context);
  vm.runInContext(`${source('renderDashboardWaitingParts')}\n${source('loadDashboardWaitingParts')}`,context);
  await context.loadDashboardWaitingParts('SCL','1234','SAE',new AbortController().signal);
  const query=new URL(urls[0],'https://example.test').searchParams;
  assert.equal(query.get('action'),'brokenPartsList');
  assert.equal(query.get('status'),'waiting');
  assert.equal(query.get('serialNo'),'1234');
  assert.match(panel.innerHTML,/TEST-1/);
  assert.match(panel.innerHTML,/Sensor/);
  assert.match(panel.innerHTML,/2026\/09\/20/);
  assert.doesNotMatch(panel.innerHTML,/TEST-[234]/);
});

test('a superseded exact-SN search cannot display waiting parts for the previous machine',async()=>{
  const elements={dashSearch:element('1234'),dashFrom:element(),dashTo:element(),dashModel:element(),dashSort:element('newest'),dashRows:element(),dashMobileRows:element(),dashSummary:element()};
  const pending=[];
  const waitingCalls=[];
  const context={
    document:{getElementById:id=>elements[id],body:{classList:{toggle(){}}}},
    getScriptUrl:()=>'/api',parseDashVenueFilter:()=>({company:'SCL',casino:''}),
    isDashFuzzy:()=>false,validateDashSearchInput:()=>true,renderDashboardWaitingParts:()=>{},
    loadDashboardWaitingParts:(...args)=>{waitingCalls.push(args);},
    dashboardRecords:[],dashboardSelectedRecords:new Map(),dashboardRequest:null,dashboardPageSize:10,
    dashColspan:()=>10,updateDashboardPager(){},updateDashboardSelectionTools(){},showLoadingProgress:()=>1,hideLoadingProgress(){},
    fetchJsonWithTimeout:()=>new Promise(resolve=>pending.push(resolve)),
    renderDashboardRows(){},renderDashboardInsights(){},showToast(){},URLSearchParams,AbortController,
    currentDashboardCompany:'',dashboardLastQuery:null,esc:value=>value,Date,
  };
  vm.createContext(context);
  vm.runInContext(source('loadDashboard'),context);
  const first=context.loadDashboard();
  elements.dashSearch.value='5678';
  const second=context.loadDashboard();
  const response={success:true,records:[],totalMatches:0,page:1,totalPages:1,stats:null,history:null};
  pending[1](response);
  await second;
  pending[0](response);
  await first;
  assert.equal(waitingCalls.length,1);
  assert.equal(waitingCalls[0][1],'5678');
});
