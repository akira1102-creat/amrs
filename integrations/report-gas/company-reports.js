// Daily report build 2026.10.08-1. Sources and credentials stay in the private GAS.
function dailyReportDate_(value) {
  if (value === '' || value == null) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return Utilities.formatDate(date, 'Asia/Macau', 'yyyy/MM/dd');
}

function dailyReportText_(value) {
  return String(value == null ? '' : value).trim().replace(/([\\*_`~|>])/g,'\\$1');
}

function selectDailyReportRows_(rows, cursor, today) {
  return cursor == null ? rows.filter(row => dailyReportDate_(row[1]) === today) : rows.slice(Math.max(0, cursor - 1));
}

function summarizeDailyCompanyRows_(source, rows) {
  const groups = new Map();
  rows.forEach(row => {
    const venue = String(row[0] || '').trim();
    const date = dailyReportDate_(row[1]);
    const error = String(row[source.errorIndex] || '').trim();
    const reason = error ? 'Check Request' : String(row[source.reasonIndex] || '').trim();
    if (!venue || !date || !reason) return;
    const key = venue + '||' + date;
    if (!groups.has(key)) groups.set(key,{venue,date,total:0,reasons:Object.create(null)});
    const group = groups.get(key);
    group.total++;
    group.reasons[reason] = (group.reasons[reason] || 0) + 1;
  });
  if (!groups.size) return '';
  const dates = [...new Set([...groups.values()].map(g => g.date))].sort();
  const range = dates.length === 1 ? dates[0] : dates[0] + ' ~ ' + dates[dates.length - 1];
  let text = `📋 **${dailyReportText_(source.company)} Maintain 日報 — ${range}**\n`;
  let total = 0;
  groups.forEach(group => {
    total += group.total;
    text += `\n🚩 **${dailyReportText_(group.venue)} (${group.date})**\n　Total: ${group.total}\n`;
    Object.entries(group.reasons).sort((a,b)=>b[1]-a[1]).forEach(([reason,count])=>{ text += `　• ${dailyReportText_(reason)}: ${count}\n`; });
  });
  if (groups.size >= 2) text += `────────────────\n📊 The sum total: **${total}**\n`;
  return text;
}

function buildCompanyMonthlyText_(source, current, previous, visits) {
  if (!previous || JSON.stringify(current) === JSON.stringify(previous)) return '';
  let text = `📋 **${dailyReportText_(source.company)} Maintain Remain Daily Update**\n`;
  source.venues.forEach(venue => {
    const done = Number(current.done[venue]) || 0;
    const before = Number(previous.done[venue]) || 0;
    const hasTarget = Object.prototype.hasOwnProperty.call(current.targets,venue);
    const remaining = hasTarget ? Math.max(0, current.targets[venue] - done) : null;
    const oldRemaining = hasTarget && Object.prototype.hasOwnProperty.call(previous.targets,venue) ? Math.max(0,previous.targets[venue]-before) : null;
    const count = visits[venue];
    const value = hasTarget ? (remaining <= 0 ? '✅ 本月已完成' : remaining) : '本月已做 ' + done;
    const oldValue = hasTarget ? (oldRemaining == null ? null : oldRemaining <= 0 ? '✅ 本月已完成' : oldRemaining) : '本月已做 ' + before;
    const change = oldValue != null && oldValue !== value ? `${oldValue} → **${value}**` : value;
    let suffix = count == null ? '' : ` (剩 ${hasTarget && remaining <= 0 ? 0 : count} 次`;
    if (count != null && hasTarget) suffix += `，平均每次 ${count > 0 && remaining > 0 ? Math.ceil(remaining/count) : '-'}`;
    if (count != null) suffix += ')';
    text += `• ${dailyReportText_(venue)}: ${change}${suffix}\n`;
  });
  text += `────────────────\n• 本月Total: ${current.total}\n`;
  return text;
}

function countCompanyRemainingVisits_(rows, sources, today) {
  const counts = {};
  sources.forEach(source=>source.venues.forEach(venue=>{counts[venue]=0;}));
  const header = rows.findIndex(row => row.filter(v=>String(v).trim()==='Marco').length >= 2);
  if (header < 0) throw new Error('工作安排標題欄位不符');
  const columns = rows[header].map((v,index)=>String(v).trim() && String(v).trim() !== 'Remark' ? index : -1).filter(index=>index>0);
  rows.slice(header+1).forEach(row=>{
    const day = Number(row[0]);
    if (!Number.isInteger(day) || day <= today || day > 31) return;
    const tasks = columns.map(index=>String(row[index] || '').trim().toUpperCase());
    if (tasks.some(v=>/PUBLIC HOLIDAY|假期|休息|CHINESE NEW YEAR|MERRY CHRISTMAS/.test(v))) return;
    sources.forEach(source=>source.venues.forEach(venue=>{
      // Starred tasks do not count as a normal maintenance visit, matching AMRS.
      const code = String(source.codes[venue] || venue).toUpperCase();
      if (tasks.includes(code) || tasks.includes(venue.toUpperCase())) counts[venue]++;
    }));
  });
  return counts;
}

function splitDailyCompanyMessages_(message) {
  const chunks = [];
  let text = String(message || '');
  while (text.length > 1900) {
    let end = text.lastIndexOf('\n',1899)+1 || 1900;
    if (/[\uD800-\uDBFF]/.test(text[end-1])) end--;
    chunks.push(text.slice(0,end));text=text.slice(end);
  }
  if (text) chunks.push(text);
  return chunks;
}

function collectDailyCompanyReport_(source, props, now, visits) {
  const ss = SpreadsheetApp.openById(source.sheetId);
  const sheet = ss.getSheetByName('Worksheet');
  if (!sheet) throw new Error('缺少維護資料工作表');
  const last = Math.max(1,sheet.getLastRow());
  const values = sheet.getRange(1,1,last,source.width).getValues();
  const header = values[0].map(v=>String(v).trim().toLowerCase());
  if (header[0] !== 'casino' || header[1] !== 'date' || header[source.reasonIndex] !== 'reason' || !header[source.errorIndex].startsWith('error description')) throw new Error('維護資料欄位不符');
  let lastData = 1;
  values.forEach((row,index)=>{if(index && String(row[0] || '').trim())lastData=index+1;});
  const rows = values.slice(1,lastData);
  const rowKey = 'dailyReport.' + source.company + '.row';
  const monthlyKey = 'dailyReport.' + source.company + '.monthly';
  let saved = props.getProperty(rowKey);
  if (saved == null && source.legacy) saved = props.getProperty('lastSentRow');
  const cursor = saved == null ? null : Number(saved);
  if (cursor != null && (!Number.isInteger(cursor) || cursor < 1 || cursor > lastData)) throw new Error('已發送位置不符，請檢查資料有否刪行');
  const today = dailyReportDate_(now);
  const month = Utilities.formatDate(now,'Asia/Macau','yyMM');
  const current = {month,done:{},targets:{},total:0};
  source.venues.forEach(venue=>{current.done[venue]=0;});
  let monthlyValues = null;
  if (source.targetCells) {
    const monthlySheet = ss.getSheetByName('Monthly');
    if (!monthlySheet) throw new Error('缺少本月設定');
    monthlyValues = monthlySheet.getRange(1,1,22,3).getValues();
    Object.keys(source.targetCells).forEach(venue=>{
      const value = monthlyValues[source.targetCells[venue]-1][2];
      if (value !== '' && value != null && Number.isFinite(Number(value)) && Number(value)>=0) current.targets[venue]=Number(value);
    });
  }
  const po = source.legacy ? String(monthlyValues[1][1]).trim() : month;
  rows.forEach(row=>{const venue=String(row[0] || '').trim();if(String(row[2] || '').trim()===po && Object.prototype.hasOwnProperty.call(current.done,venue)){current.done[venue]++;current.total++;}});
  let previous = props.getProperty(monthlyKey);
  previous = previous ? JSON.parse(previous) : null;
  // Preserve the previous SCL formula-based snapshot for the first upgraded run.
  if (!previous && source.legacy) {
    const legacy = JSON.parse(props.getProperty('lastData') || '{}');
    if(Object.keys(legacy).length) {
      previous = {month,done:{},targets:current.targets,total:legacy['本月Total']};
      source.venues.forEach(venue=>{previous.done[venue]=current.targets[venue]-Number(legacy[venue+' Remain']);});
    }
  }
  const report = summarizeDailyCompanyRows_(source,selectDailyReportRows_(rows,cursor,today));
  const remain = buildCompanyMonthlyText_(source,current,previous,visits);
  const updates = {[rowKey]:String(lastData),[monthlyKey]:JSON.stringify(current)};
  if(source.legacy) {
    updates.lastSentRow = String(lastData);
    const legacy={};source.venues.forEach(venue=>{legacy[venue+' Remain']=current.targets[venue]-current.done[venue];});legacy['本月Total']=current.total;
    updates.lastData=JSON.stringify(legacy);
  }
  return {company:source.company,report,remain,updates,newRows:selectDailyReportRows_(rows,cursor,today).length,firstRun:cursor==null};
}

function collectAllDailyCompanyReports_() {
  const now = new Date();
  const props = PropertiesService.getScriptProperties();
  const monthNames=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const schedule = SpreadsheetApp.openById(SCHEDULE_SHEET_ID).getSheetByName(now.getFullYear()+'-'+monthNames[now.getMonth()]);
  if (!schedule) throw new Error('找不到當月工作安排');
  const visits = countCompanyRemainingVisits_(schedule.getDataRange().getValues(),REPORT_SOURCES,now.getDate());
  return REPORT_SOURCES.map(source=>collectDailyCompanyReport_(source,props,now,visits));
}

function runAllDailyCompanyReports_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { console.log('已有工作報告正在處理，跳過重複執行');return; }
  try {
    const reports = collectAllDailyCompanyReports_();
    const message = reports.flatMap(r=>[r.report,r.remain]).filter(Boolean).join('\n\n');
    const chunks = splitDailyCompanyMessages_(message);
    for(let index=0;index<chunks.length;index++) {
      const prefix=index ? `📋 工作報告（續 ${index+1}/${chunks.length}）\n` : '';
      if (!sendToDiscord(prefix+chunks[index])) throw new Error('工作報告發送失敗，已保留發送位置供重試');
    }
    const updates={};reports.forEach(r=>Object.assign(updates,r.updates));
    PropertiesService.getScriptProperties().setProperties(updates);
    console.log('工作報告處理完成：公司數 '+reports.length+'，訊息段數 '+chunks.length);
  } finally {lock.releaseLock();}
}

function verifyAllDailyCompanyReports_() {
  const reports=collectAllDailyCompanyReports_();
  const summary={build:'2026.10.08-1',readOk:true,companies:reports.map(r=>({company:r.company,readOk:true,firstRun:r.firstRun,hasNewRows:r.newRows>0})),sendsDiscord:false,changesSendState:false};
  console.log('全場工作報告驗證完成：'+JSON.stringify(summary));
  return summary;
}
