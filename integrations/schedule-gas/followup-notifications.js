// GAS integration build 2026.10.08-1. No credentials or private sheet IDs belong here.
// Helpers end in '_' so the public schedule web app cannot call them via google.script.run.
function scheduleFollowupVenue_(value) {
  const clean = String(value || '').trim().replace(/\s*\*+\s*$/, '').replace(/[’']/g, "'");
  const key = clean.toLowerCase().replace(/\s+/g, '');
  const aliases = typeof SCHEDULE_FOLLOWUP_VENUE_ALIASES === 'undefined' ? {} : SCHEDULE_FOLLOWUP_VENUE_ALIASES;
  const alias = Object.keys(aliases).find(code => code.toLowerCase().replace(/\s+/g, '') === key);
  return alias ? aliases[alias] : clean;
}

function scheduleFollowupVenueKey_(value) {
  return scheduleFollowupVenue_(value).toLowerCase().replace(/\s+/g, '');
}

function parseScheduleFollowups_(rows) {
  const headers = ['ID','Company','Venue','Title','Content','Status','Priority','Due Date','Known People','Created At','Updated At'];
  if (headers.some((header, index) => String(rows[0] && rows[0][index] || '').trim() !== header)) {
    throw new Error('跟進日誌欄位不符');
  }
  return rows.slice(1).map(row => ({
    id: String(row[0] || '').trim(), company: String(row[1] || '').trim(),
    venue: String(row[2] || '').trim(), title: String(row[3] || '').trim(),
    content: String(row[4] || '').trim(), status: String(row[5] || '').trim(),
    priority: String(row[6] || '').trim(), dueDate: String(row[7] || '').trim(),
    updatedAt: String(row[10] || '').trim(),
  })).filter(entry => entry.id && entry.venue && entry.title && ['pending','progress','waiting'].includes(entry.status))
    .sort((a,b) => Number(b.priority === 'urgent') - Number(a.priority === 'urgent') || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

function loadScheduleFollowups_() {
  try {
    const id = PropertiesService.getScriptProperties().getProperty('FOLLOWUP_LOG_SHEET_ID');
    if (!id) throw new Error('未設定來源');
    const sheet = SpreadsheetApp.openById(id).getSheetByName('Entries');
    if (!sheet) throw new Error('缺少 Entries');
    const lastRow = Math.max(1, sheet.getLastRow());
    return { entries: parseScheduleFollowups_(sheet.getRange(1,1,lastRow,11).getDisplayValues()), error: '' };
  } catch (error) {
    // Never expose sheet IDs, authorization details or raw provider errors in Discord.
    Logger.log('跟進日誌未能讀取，請檢查私有來源設定、欄位及執行帳戶權限');
    return { entries: [], error: '⚠️ 跟進日誌暫時未能讀取，請到 AMRS 查看當日場地跟進事項。' };
  }
}

function scheduleFollowupDiscordText_(value) {
  return String(value || '').replace(/([\\*_`~|>])/g, '\\$1');
}

function buildVenueFollowupText_(venue, followups) {
  const key = scheduleFollowupVenueKey_(venue);
  const entries = (followups.entries || []).filter(entry => ['pending','progress','waiting'].includes(entry.status) && scheduleFollowupVenueKey_(entry.venue) === key);
  if (!entries.length) return '';
  const labels = { pending:'待跟進', progress:'進行中', waiting:'等待' };
  let text = `　📌 ${scheduleFollowupDiscordText_(scheduleFollowupVenue_(venue))} 未完成跟進（${entries.length} 項）\n`;
  entries.forEach(entry => {
    const urgent = entry.priority === 'urgent' ? '🚨 緊急 · ' : '';
    text += `　　• [${urgent}${labels[entry.status]}] ${scheduleFollowupDiscordText_(entry.title)}\n`;
    if (entry.content) text += entry.content.split(/\r?\n/).map(line => `　　　${scheduleFollowupDiscordText_(line)}`).join('\n') + '\n';
    if (entry.dueDate) text += `　　　跟進日期：${scheduleFollowupDiscordText_(entry.dueDate)}\n`;
  });
  return text;
}

function buildScheduleFollowupBlock_(venueMap, followups) {
  const seen = new Set();
  let block = '';
  Object.keys(venueMap || {}).forEach(venue => {
    const key = scheduleFollowupVenueKey_(venue);
    if (seen.has(key)) return;
    seen.add(key);
    block += buildVenueFollowupText_(venue, followups);
  });
  return block ? '\n' + block : '';
}

function splitScheduleDiscordMessages_(message) {
  const chunks = [];
  let remaining = String(message || '');
  while (remaining.length > 1900) {
    let end = remaining.lastIndexOf('\n', 1899) + 1;
    if (!end) end = 1900;
    // A long single line may contain a surrogate pair across the split point.
    if (/[\uD800-\uDBFF]/.test(remaining.charAt(end - 1))) end -= 1;
    chunks.push(remaining.slice(0,end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function verifyDailyScheduleFollowups_() {
  const followups = loadScheduleFollowups_();
  if (followups.error) throw new Error(followups.error);
  const schedule = buildScheduleForDate(SpreadsheetApp.getActiveSpreadsheet(), new Date());
  if (schedule.error) throw new Error(schedule.error);
  const countFor = period => {
    const keys = new Set(Object.keys(period && period.venueMap || {}).map(scheduleFollowupVenueKey_));
    return followups.entries.filter(entry => keys.has(scheduleFollowupVenueKey_(entry.venue))).length;
  };
  const summary = { build:'2026.10.08-1', readOk:true, activeEntries:followups.entries.length,
    amMatched:countFor(schedule.am), pmMatched:countFor(schedule.pm), silentDay:!!(schedule.isHoliday || schedule.isWeekend), sendsDiscord:false };
  Logger.log('跟進日誌驗證完成：' + JSON.stringify(summary));
  return summary;
}
