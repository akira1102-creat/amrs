// GAS integration build 2026.10.12-1. No credentials or private sheet IDs belong here.
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

function scheduleFollowupMatchesVenue_(entry, venue) {
  const key = scheduleFollowupVenueKey_(venue);
  if (!['全部', '全部場地'].includes(entry.venue)) return scheduleFollowupVenueKey_(entry.venue) === key;
  const companies = typeof SCHEDULE_FOLLOWUP_COMPANY_VENUES !== 'undefined' ? SCHEDULE_FOLLOWUP_COMPANY_VENUES : {
    Melco: ['ALT', 'COD', 'SC'],
    MGM: ['MGM Macau', 'MGM Cotai'],
    SJM: ['Lisboa', 'Grand Lisboa', 'Grand Lisboa Palace', 'Oceanus', 'Jai Alai', 'L’Arc'],
    SCL: ['Venetian', 'Parisian', 'Londoner', 'Plaza', 'Sands'],
    GEG: ['Galaxy', 'StarWorld'],
    Wynn: ['Wynn', 'Wynn Palace'],
  };
  const venues = entry.company === 'ALL' ? Object.keys(companies).reduce((all, company) => all.concat(companies[company]), []) : companies[entry.company] || [];
  return venues.some(value => scheduleFollowupVenueKey_(value) === key);
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
  const entries = (followups.entries || []).filter(entry => ['pending','progress','waiting'].includes(entry.status) && scheduleFollowupMatchesVenue_(entry, venue));
  if (!entries.length) return '';
  const labels = { pending:'待跟進', progress:'進行中', waiting:'等待' };
  let text = `　📌 ${scheduleFollowupDiscordText_(scheduleFollowupVenue_(venue))} 未完成跟進（${entries.length} 項）\n`;
  const items = entries.map(entry => {
    const urgent = entry.priority === 'urgent' ? '🚨 緊急 · ' : '';
    let item = `　　• [${urgent}${labels[entry.status]}] ${scheduleFollowupDiscordText_(entry.title)}`;
    const compact = followups.reminders ? followups.reminders.record(entry) : false;
    if (!compact) {
      if (entry.content) {
        const lines = entry.content.split(/\r?\n/);
        lines.forEach((line, i) => {
          // Keep existing paragraph breaks; give numbered major points breathing room.
          if (i && lines[i - 1].trim() && /^\s*(?:\d+\s*[.)）、]|[①②③④⑤⑥⑦⑧⑨⑩])/.test(line)) item += '\n';
          item += '\n' + (line.trim() ? '　　　' + scheduleFollowupDiscordText_(line) : '');
        });
      }
      if (entry.dueDate) item += `\n　　　跟進日期：${scheduleFollowupDiscordText_(entry.dueDate)}`;
    }
    return item;
  });
  return text + items.join('\n\n') + '\n';
}

function buildScheduleFollowupBlock_(venueMap, followups) {
  const seen = new Set();
  const blocks = [];
  Object.keys(venueMap || {}).forEach(venue => {
    const key = scheduleFollowupVenueKey_(venue);
    if (seen.has(key)) return;
    seen.add(key);
    const block = buildVenueFollowupText_(venue, followups);
    if (block) blocks.push(block.trimEnd());
  });
  return blocks.length ? '\n' + blocks.join('\n\n') + '\n' : '';
}

function scheduleFollowupDateKey_(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
}

function previousScheduleFollowupWorkday_(ss, date) {
  for (let offset = 1; offset <= 45; offset++) {
    const previous = new Date(date);
    previous.setDate(date.getDate() - offset);
    if ([0,6].includes(previous.getDay())) continue;
    const schedule = buildScheduleForDate(ss, previous);
    // Missing monthly data is not evidence of a holiday. Safely show full text.
    if (!schedule || schedule.error) return '';
    if (!schedule.isHoliday && !schedule.isWeekend) return scheduleFollowupDateKey_(previous);
  }
  return '';
}

function scheduleFollowupFingerprint_(entry) {
  const value = JSON.stringify([entry.company,entry.venue,entry.title,entry.content,entry.priority,entry.dueDate]);
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(byte => (byte & 255).toString(16).padStart(2,'0')).join('');
}

function readScheduleFollowupReceipt_(props, dateKey) {
  const receipt = Object.create(null);
  if (!dateKey) return receipt;
  try {
    const prefix = 'SCHEDULE_FOLLOWUP_SENT_' + dateKey + '_';
    const count = Number(props.getProperty(prefix + 'COUNT') || 0);
    if (!Number.isInteger(count) || count < 0 || count > 100) return receipt;
    for (let i = 0; i < count; i++) {
      const pairs = JSON.parse(props.getProperty(prefix + i));
      if (!Array.isArray(pairs)) throw new Error('Invalid receipt');
      pairs.forEach(pair => {
        if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !/^[a-f0-9]{64}$/.test(pair[1])) throw new Error('Invalid receipt');
        receipt[pair[0]] = pair[1];
      });
    }
    return receipt;
  } catch (_) {
    Logger.log('跟進提醒記錄未能讀取，本次使用完整文章。');
    return Object.create(null);
  }
}

function createScheduleFollowupReminderContext_(ss, date) {
  const props = PropertiesService.getScriptProperties();
  const day = scheduleFollowupDateKey_(date), previousDay = previousScheduleFollowupWorkday_(ss, date);
  const previous = readScheduleFollowupReceipt_(props, previousDay);
  const today = readScheduleFollowupReceipt_(props, day);
  return {
    day: day, previousDay: previousDay, records: Object.create(null),
    record: function(entry) {
      const fingerprint = scheduleFollowupFingerprint_(entry);
      this.records[entry.id] = fingerprint;
      return previous[entry.id] === fingerprint || today[entry.id] === fingerprint;
    }
  };
}

function commitScheduleFollowupReminders_(context) {
  const props = PropertiesService.getScriptProperties();
  const receipt = Object.assign(readScheduleFollowupReceipt_(props, context.day), context.records);
  const prefix = 'SCHEDULE_FOLLOWUP_SENT_' + context.day + '_';
  const pairs = Object.keys(receipt).map(id => [id,receipt[id]]);
  const count = Math.ceil(pairs.length / 40);
  for (let i = 0; i < count; i++) props.setProperty(prefix + i, JSON.stringify(pairs.slice(i * 40,(i + 1) * 40)));
  props.setProperty(prefix + 'COUNT', String(count));
  // Retain only today and the preceding workday. Receipts contain IDs + hashes, never articles.
  const savedDate = props.getProperty('SCHEDULE_FOLLOWUP_LAST_SENT_DAY');
  if (savedDate && savedDate !== context.day && savedDate !== context.previousDay && /^\d{4}-\d{2}-\d{2}$/.test(savedDate)) {
    const oldPrefix = 'SCHEDULE_FOLLOWUP_SENT_' + savedDate + '_';
    const oldCount = Math.min(100, Math.max(0, Number(props.getProperty(oldPrefix + 'COUNT')) || 0));
    for (let i = 0; i < oldCount; i++) props.deleteProperty(oldPrefix + i);
    props.deleteProperty(oldPrefix + 'COUNT');
  }
  // Track the retained previous day so it can be pruned on the next run.
  const olderDate = props.getProperty('SCHEDULE_FOLLOWUP_PREVIOUS_SENT_DAY');
  if (olderDate && olderDate !== context.day && olderDate !== context.previousDay && /^\d{4}-\d{2}-\d{2}$/.test(olderDate)) {
    const oldPrefix = 'SCHEDULE_FOLLOWUP_SENT_' + olderDate + '_';
    const oldCount = Math.min(100, Math.max(0, Number(props.getProperty(oldPrefix + 'COUNT')) || 0));
    for (let i = 0; i < oldCount; i++) props.deleteProperty(oldPrefix + i);
    props.deleteProperty(oldPrefix + 'COUNT');
  }
  props.setProperty('SCHEDULE_FOLLOWUP_PREVIOUS_SENT_DAY', context.previousDay);
  props.setProperty('SCHEDULE_FOLLOWUP_LAST_SENT_DAY', context.day);
}

function sendScheduleWithFollowupReminders_(message, context) {
  if (!sendToDiscord(message)) return false;
  try { commitScheduleFollowupReminders_(context); }
  catch (_) { Logger.log('通知已發送，但跟進提醒記錄未能儲存；下次保留完整文章。'); }
  return true;
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
    const venues = Object.keys(period && period.venueMap || {});
    return followups.entries.filter(entry => venues.some(venue => scheduleFollowupMatchesVenue_(entry, venue))).length;
  };
  const summary = { build:'2026.10.12-1', readOk:true, activeEntries:followups.entries.length,
    amMatched:countFor(schedule.am), pmMatched:countFor(schedule.pm), silentDay:!!(schedule.isHoliday || schedule.isWeekend), sendsDiscord:false };
  Logger.log('跟進日誌驗證完成：' + JSON.stringify(summary));
  return summary;
}
