(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(root)root.AmrsReasonDashboard=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const COMPANIES=['SCL','GEG','MGM','Melco','SJM','Wynn'];
 const key=reason=>String(reason??'').trim().toUpperCase();
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function summarize(data,exemptions=[]){
  const excludedKeys=new Set(exemptions.map(key));
  const reasons=(data.reasons||[]).filter(r=>!excludedKeys.has(key(r.reason))).map(r=>({...r})).sort((a,b)=>b.count-a.count||a.reason.localeCompare(b.reason));
  const included=reasons.reduce((sum,r)=>sum+r.count,0);
  const excluded=(data.reasons||[]).reduce((sum,r)=>sum+(excludedKeys.has(key(r.reason))?r.count:0),0);
  return {included,excluded,reasons:reasons.map(r=>({...r,share:data.total?r.count/data.total*100:0}))};
 }
 function createApp({container,loadCompany,getReasonOptions=()=>[],storage,notify=()=>{},now=()=>Date.now()}){
  const document=container.ownerDocument;
  const cache=new Map(),exemptions=new Map(),results=new Map(),errors=new Map();
  let built=false,active=false,month='',allDates=false,request=null,generation=0,dialogCompany='';
  const el=id=>container.querySelector('#'+id);
  const period=()=>allDates?'all':month;
  const number=n=>Number(n||0).toLocaleString('zh-HK');
  const exclusionKey=company=>'_amrs_reason_dashboard_excluded_v1:'+company;
  const monthNow=()=>{
   const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit'}).formatToParts(new Date(now()));
   return parts.find(p=>p.type==='year').value+'-'+parts.find(p=>p.type==='month').value;
  };
  function selected(company){
   if(!exemptions.has(company)){
    let value=['PM'];
    try{const saved=JSON.parse(storage?.getItem(exclusionKey(company))||'null');if(Array.isArray(saved)&&saved.every(r=>typeof r==='string'))value=saved;}catch{}
    exemptions.set(company,value);
   }
   return exemptions.get(company);
  }
  function options(company){
   const seen=new Set();
   const data=results.get(company),templates=data?.templateReasons?.length?data.templateReasons:getReasonOptions(company);
   return ['PM',...templates,...(data?.reasonOptions||[]),...(data?.reasons||[]).map(r=>r.reason),...selected(company)].map(v=>String(v||'').trim()).filter(v=>{
    const k=key(v);if(!k||seen.has(k))return false;seen.add(k);return true;
   });
  }
  function setExcluded(company,values){
   try{storage?.setItem(exclusionKey(company),JSON.stringify(values));}
   catch{notify('排除設定未能儲存，請檢查瀏覽器儲存空間');return false;}
   exemptions.set(company,values);render();return true;
  }
  function bars(rows,max){
   return '<ol class="reason-bars">'+rows.map(r=>`<li><div class="reason-bar-label"><span>${esc(r.reason)}</span><strong>${number(r.count)} 筆 <small>${r.share.toFixed(1)}%</small></strong></div><div class="reason-bar-track" aria-hidden="true"><span style="width:${max?Math.max(0,r.count/max*100):0}%"></span></div></li>`).join('')+'</ol>';
  }
  function render(){
   if(!built)return;
   const summaries=new Map(COMPANIES.filter(c=>results.has(c)).map(c=>[c,summarize(results.get(c),selected(c))]));
   const max=Math.max(0,...[...summaries.values()].flatMap(s=>s.reasons.map(r=>r.count)));
   el('reasonStatsGrid').innerHTML=COMPANIES.map(company=>{
    const data=results.get(company),summary=summaries.get(company),error=errors.get(company);
    const excluded=selected(company);
    const header=`<div class="reason-company-head"><h2>${company}</h2><button type="button" data-exclusions="${company}" aria-haspopup="dialog">排除原因${excluded.length?' ('+excluded.length+')':''}</button></div>`;
    if(!data)return `<section class="reason-company-card" data-company="${company}">${header}<p class="${error?'reason-error':'reason-muted'}" role="status">${error?'未能載入此公司資料，唔會當作零筆。':'正在載入…'}</p>${error?`<button type="button" data-retry="${company}">重試</button>`:''}</section>`;
    const updated=data.generatedAt?new Date(data.generatedAt).toLocaleString('zh-HK'):'';
    return `<section class="reason-company-card" data-company="${company}">${header}
     <p class="reason-counts">計算 <strong>${number(summary.included)}</strong> 筆 <span>／原有 ${number(data.total)} 筆</span></p>
     <p class="reason-muted reason-excluded-count">已排除 ${number(summary.excluded)} 筆${data.blankReasons?' · 原因空白 '+number(data.blankReasons)+' 筆':''}</p>
     ${error?'<p class="reason-error" role="status">更新失敗，以下為上次資料。<button type="button" data-retry="'+company+'">重試</button></p>':''}
     ${!data.total?'<p class="reason-empty">此期間未有維護記錄。</p>':!summary.included?'<p class="reason-empty">未有可計算原因；可能已全部排除，或原因欄為空白。</p>':bars(summary.reasons.slice(0,5),max)}
     ${summary.reasons.length>5?`<details><summary>其餘 ${summary.reasons.length-5} 項原因</summary>${bars(summary.reasons.slice(5),max)}</details>`:''}
     <p class="reason-updated">更新：${esc(updated||'—')}</p>
    </section>`;
   }).join('');
   const loaded=results.size,failed=errors.size;
   el('reasonStatsStatus').textContent=(request?'更新中 · ':'')+loaded+'/6 間公司已載入'+(failed?' · '+failed+' 間更新失敗':'');
  }
  function syncControls(){
   el('reasonStatsMonth').value=month;el('reasonStatsMonth').disabled=allDates;
   el('reasonStatsAll').checked=allDates;
   el('reasonStatsPrev').disabled=el('reasonStatsNext').disabled=allDates;
   el('reasonStatsRefresh').disabled=!!request;
  }
  function populateDialog(){
   const company=dialogCompany;if(!company)return;
   el('reasonExclusionTitle').textContent=company+' 排除原因';
   const checked=new Set(selected(company).map(key));
   el('reasonExclusionOptions').innerHTML=options(company).map(reason=>`<label><input type="checkbox" value="${esc(reason)}"${checked.has(key(reason))?' checked':''}><span>${esc(reason)}</span></label>`).join('');
   el('reasonExclusionSummary').textContent=selected(company).length?selected(company).join('、'):'無（全部原因都計算）';
  }
  function openExclusions(company){
   dialogCompany=company;populateDialog();
   el('reasonExclusionDialog').showModal();
  }
  function deactivate(){
   active=false;generation++;request?.abort();request=null;
   if(built){el('reasonExclusionDialog').close();syncControls();}
  }
  function reset(){
   deactivate();cache.clear();results.clear();errors.clear();
  }
  function validResponse(data,company,wanted){
   return data?.success===true&&data.company===company&&data.month===wanted&&Number.isSafeInteger(data.total)&&data.total>=0
    &&Number.isSafeInteger(data.blankReasons)&&data.blankReasons>=0&&Array.isArray(data.reasons)
    &&data.reasons.every(r=>typeof r.reason==='string'&&Number.isSafeInteger(r.count)&&r.count>0)
    &&data.reasons.reduce((sum,r)=>sum+r.count,0)+data.blankReasons===data.total;
  }
  async function load(force=false,onlyCompany=''){
   if(!active)return;
   request?.abort();const controller=new AbortController(),id=++generation,wanted=period();
   request=controller;syncControls();
   const targets=onlyCompany?[onlyCompany]:COMPANIES;
   if(!onlyCompany){results.clear();errors.clear();}
   const tasks=[];
   for(const company of targets){
    const saved=cache.get(wanted+':'+company);
    if(saved)results.set(company,saved.data);
    if(force||!saved||now()-saved.savedAt>180000)tasks.push(company);
   }
   render();
   let cursor=0;
   const run=async()=>{
    while(cursor<tasks.length&&!controller.signal.aborted){
     const company=tasks[cursor++];
     try{
      const data=await loadCompany(company,wanted,{force,signal:controller.signal});
      if(!active||id!==generation)return;
      if(!validResponse(data,company,wanted))throw Error('Invalid statistics response');
      cache.set(wanted+':'+company,{data,savedAt:now()});results.set(company,data);errors.delete(company);
     }catch(error){
      if(controller.signal.aborted||!active||id!==generation)return;
      errors.set(company,true);
     }
     render();
    }
   };
   try{await Promise.all([run(),run()]);}
   finally{if(id===generation){request=null;syncControls();render();}}
  }
  function changeMonth(delta){
   const [y,m]=month.split('-').map(Number),date=new Date(Date.UTC(y,m-1+delta,1));
   const next=date.toISOString().slice(0,7);if(!/^20\d{2}-/.test(next))return;month=next;syncControls();void load();
  }
  function build(){
   if(built)return;
   built=true;month=monthNow();
   container.innerHTML=`<div class="reason-dashboard-shell">
    <header class="reason-dashboard-head"><h1>維護儀表板</h1><button type="button" id="reasonStatsRefresh">重新整理</button></header>
    <div class="reason-period-controls"><button type="button" id="reasonStatsPrev" aria-label="上個月">‹</button><label>統計月份<input type="month" id="reasonStatsMonth" min="2000-01" max="2099-12"></label><button type="button" id="reasonStatsNext" aria-label="下個月">›</button><label class="reason-all"><input type="checkbox" id="reasonStatsAll">全部日期</label></div>
    <p class="reason-muted">按維護記錄日期計算，每筆記錄計一次，唔係不重複機台數。預設排除 PM；剔選項目唔計算，與30日提醒設定分開。</p>
    <p class="reason-muted">每間公司先顯示最多五項。長條共用筆數刻度；百分比＝該原因筆數 ÷ 該公司所選期間嘅原有總筆數（包括已排除及原因空白嘅記錄）。</p>
    <p id="reasonStatsStatus" class="reason-muted" role="status"></p>
    <div id="reasonStatsGrid" class="reason-stats-grid"></div>
    <dialog id="reasonExclusionDialog" class="reason-exclusion-dialog" aria-labelledby="reasonExclusionTitle">
     <div class="reason-dialog-head"><h2 id="reasonExclusionTitle"></h2><button type="button" id="reasonExclusionClose" aria-label="關閉排除清單">✕</button></div>
     <p>剔選後，唔計算該原因嘅記錄。</p><p class="reason-muted">只影響本儀表板，設定會按公司記住喺目前瀏覽器。</p>
     <p id="reasonExclusionSummary" class="reason-muted"></p>
     <button type="button" id="reasonExclusionClear">取消全部排除</button>
     <div id="reasonExclusionOptions" class="reason-exclusion-options"></div>
    </dialog>
   </div>`;
   el('reasonStatsRefresh').addEventListener('click',()=>void load(true));
   el('reasonStatsPrev').addEventListener('click',()=>changeMonth(-1));
   el('reasonStatsNext').addEventListener('click',()=>changeMonth(1));
   el('reasonStatsMonth').addEventListener('change',e=>{if(/^20\d{2}-(0[1-9]|1[0-2])$/.test(e.target.value)){month=e.target.value;void load();}else syncControls();});
   el('reasonStatsAll').addEventListener('change',e=>{allDates=e.target.checked;syncControls();void load();});
   el('reasonStatsGrid').addEventListener('click',e=>{
    const options=e.target.closest('[data-exclusions]'),retry=e.target.closest('[data-retry]');
    if(options)openExclusions(options.dataset.exclusions);
    if(retry)void load(true,retry.dataset.retry);
   });
   el('reasonExclusionClose').addEventListener('click',()=>el('reasonExclusionDialog').close());
   el('reasonExclusionClear').addEventListener('click',()=>{if(setExcluded(dialogCompany,[]))populateDialog();});
   el('reasonExclusionOptions').addEventListener('change',e=>{
    if(e.target.type!=='checkbox')return;
    const values=selected(dialogCompany).filter(r=>key(r)!==key(e.target.value));
    if(e.target.checked)values.push(e.target.value);
    if(!setExcluded(dialogCompany,values))e.target.checked=!e.target.checked;
    el('reasonExclusionSummary').textContent=selected(dialogCompany).join('、')||'無（全部原因都計算）';
   });
  }
  function mount(){build();active=true;syncControls();void load();}
  return {mount,deactivate,reset};
 }
 return {createApp,summarize};
});
