import { sha256Base64Url } from './crypto.mjs';
import { COMPANIES } from './config.mjs';

export const LOG_HEADERS = ['ID', 'Company', 'Venue', 'Title', 'Content', 'Status', 'Priority', 'Due Date', 'Known People', 'Created At', 'Updated At'];
export const COMMENT_HEADERS = ['ID', 'Entry ID', 'Name', 'Content', 'Created At'];
export const LOG_ACTIONS = new Set(['followupLog', 'createFollowupLog', 'updateFollowupLog', 'addFollowupComment']);
const STATUSES = ['pending', 'progress', 'waiting', 'completed'];
const text = value => String(value ?? '').trim();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function required(value, label, maximum) {
  const result = text(value);
  if (!result || result.length > maximum) throw fail(`${label}必須填寫，且不可超過 ${maximum} 字`);
  return result;
}
function entryInput(input = {}) {
  const company = text(input.company), venue = text(input.venue);
  if (company !== 'ALL' && !COMPANIES.includes(company)) throw fail('請選擇公司');
  if (company !== 'ALL' && !venue) throw fail('請選擇場地');
  if (venue.length > 100) throw fail('場地名稱過長');
  const status = text(input.status) || 'pending', priority = text(input.priority) || 'normal';
  if (!STATUSES.includes(status) || !['normal', 'urgent'].includes(priority)) throw fail('狀態或優先程度無效');
  const dueDate = text(input.dueDate);
  if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(Date.parse(dueDate)) || new Date(dueDate).toISOString().slice(0, 10) !== dueDate)) throw fail('跟進日期無效');
  const knownPeople = Array.isArray(input.knownPeople) ? [...new Set(input.knownPeople.map(text).filter(Boolean))] : [];
  if (knownPeople.length > 30 || knownPeople.some(name => name.length > 60)) throw fail('知悉同事資料過長');
  const content = text(input.content);
  if (content.length > 8000) throw fail('內容不可超過 8000 字');
  return { company, venue: company === 'ALL' ? '全部場地' : venue, title: required(input.title, '標題', 160), content, status, priority, dueDate, knownPeople };
}
const inputValues = entry => [entry.company, entry.venue, entry.title, entry.content, entry.status, entry.priority, entry.dueDate, JSON.stringify(entry.knownPeople)];
async function fromRow(row, rowNumber) {
  const values = LOG_HEADERS.map((_, index) => text(row[index]));
  let knownPeople;
  try { knownPeople = JSON.parse(values[8] || '[]'); } catch { knownPeople = []; }
  return { id: values[0], company: values[1], venue: values[2], title: values[3], content: values[4], status: values[5], priority: values[6], dueDate: values[7], knownPeople: Array.isArray(knownPeople) ? knownPeople : [], createdAt: values[9], updatedAt: values[10], version: await sha256Base64Url(JSON.stringify(values)), rowNumber };
}

export function createFollowupLogRepository({ config, sheets, now = Date.now }) {
  function sheetId() {
    if (!text(config.followupLogSheetId)) throw fail('跟進日誌尚未設定雲端試算表', 503);
    return text(config.followupLogSheetId);
  }
  async function table(sheet, headers) {
    const response = await sheets.valuesGet({ spreadsheetId: sheetId(), range: `${sheet}!A:${sheet === 'Entries' ? 'K' : 'E'}`, valueRenderOption: 'FORMATTED_VALUE' });
    const rows = response.values || [];
    if (headers.some((header, index) => text(rows[0]?.[index]) !== header)) throw fail('日誌試算表欄位不符，請聯絡管理員', 503);
    return rows;
  }
  async function entries() {
    const rows = await table('Entries', LOG_HEADERS);
    return Promise.all(rows.slice(1).map((row, index) => fromRow(row, index + 2))).then(items => items.filter(item => item.id));
  }
  async function comments() {
    const rows = await table('Comments', COMMENT_HEADERS);
    return rows.slice(1).filter(row => text(row[0])).map(row => ({ id: text(row[0]), entryId: text(row[1]), name: text(row[2]), content: text(row[3]), createdAt: text(row[4]) }));
  }
  async function get(params = {}) {
    const all = await entries(), allComments = await comments();
    if (text(params.id)) {
      const entry = all.find(item => item.id === text(params.id));
      if (!entry) throw fail('找不到此事項，請重新載入', 404);
      return { success: true, entry, comments: allComments.filter(comment => comment.entryId === entry.id) };
    }
    const search = text(params.search).toLowerCase(), status = text(params.status) || 'active';
    let filtered = all.filter(item => (!params.company || item.company === params.company) && (!params.venue || item.venue === params.venue)
      && (status === 'all' || (status === 'active' ? item.status !== 'completed' : item.status === status))
      && (!search || [item.title, item.content, item.venue, ...item.knownPeople].some(value => text(value).toLowerCase().includes(search))));
    const lastComment = new Map(), counts = new Map();
    allComments.forEach(comment => { counts.set(comment.entryId, (counts.get(comment.entryId) || 0) + 1); if (comment.createdAt > (lastComment.get(comment.entryId) || '')) lastComment.set(comment.entryId, comment.createdAt); });
    filtered = filtered.map(item => ({ ...item, updatedAt: [item.updatedAt, lastComment.get(item.id) || ''].sort().at(-1), commentCount: counts.get(item.id) || 0 }));
    filtered.sort((a, b) => Number(a.status === 'completed') - Number(b.status === 'completed') || Number(b.priority === 'urgent') - Number(a.priority === 'urgent') || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const page = Math.max(1, Number.parseInt(params.page, 10) || 1), pageSize = 50;
    return { success: true, entries: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize,
      summary: { active: all.filter(item => item.status !== 'completed').length, urgent: all.filter(item => item.status !== 'completed' && item.priority === 'urgent').length, completed: all.filter(item => item.status === 'completed').length } };
  }
  async function post(payload) {
    const id = required(payload.id, '識別碼', 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw fail('識別碼無效');
    const all = await entries(), current = all.find(entry => entry.id === id), timestamp = new Date(typeof now === 'function' ? now() : now).toISOString();
    if (payload.action === 'addFollowupComment') {
      const entryId = required(payload.entryId, '事項識別碼', 100);
      if (!all.some(entry => entry.id === entryId)) throw fail('找不到此事項，請重新載入', 404);
      const comment = { id, entryId, name: required(payload.name, '留言者姓名', 60), content: required(payload.content, '留言', 4000), createdAt: timestamp };
      const existing = (await comments()).find(item => item.id === id);
      if (existing) {
        if (['entryId', 'name', 'content'].some(key => existing[key] !== comment[key])) throw fail('留言識別碼已使用，請重新載入', 409);
        return { success: true, comment: existing };
      }
      await sheets.valuesAppend({ spreadsheetId: sheetId(), range: 'Comments!A:E', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', values: [[id, entryId, comment.name, comment.content, timestamp]] });
      return { success: true, comment };
    }
    const input = entryInput(payload.entry);
    let values;
    if (payload.action === 'createFollowupLog') {
      if (current) {
        if (JSON.stringify(inputValues(input)) !== JSON.stringify(inputValues(current))) throw fail('事項識別碼已使用，請重新載入', 409);
        return { success: true, entry: current };
      }
      values = [id, ...inputValues(input), timestamp, timestamp];
      await sheets.valuesAppend({ spreadsheetId: sheetId(), range: 'Entries!A:K', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', values: [values] });
    } else if (payload.action === 'updateFollowupLog') {
      if (!current) throw fail('找不到此事項，請重新載入', 404);
      if (!payload.baseVersion || payload.baseVersion !== current.version) throw fail('其他同事已修改此事項，請重新載入後再修改', 409);
      values = [id, ...inputValues(input), current.createdAt, timestamp];
      await sheets.valuesUpdate({ spreadsheetId: sheetId(), range: `Entries!A${current.rowNumber}:K${current.rowNumber}`, valueInputOption: 'RAW', values: [values] });
    } else throw fail('日誌操作無效');
    return { success: true, entry: await fromRow(values, current?.rowNumber || all.length + 2) };
  }
  return { get, post };
}
