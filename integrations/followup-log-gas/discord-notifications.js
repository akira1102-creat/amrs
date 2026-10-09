/** @OnlyCurrentDoc */
// Bound-sheet GAS build 2026.10.09-3. Keep Webhook and all source IDs private.
// Entries and Comments are append-only; AMRS edits rows and soft-deletes entries.
function installFollowupDiscord() {
  followupDiscordLocked_(function () {
    const props = PropertiesService.getScriptProperties();
    followupDiscordWebhook_(props);
    const source = followupDiscordSource_();
    const saved = props.getProperty('FOLLOWUP_DISCORD_STATE');
    if (!saved) {
      props.setProperty('FOLLOWUP_DISCORD_STATE', JSON.stringify({
        version: 1, sheet: source.id,
        Entries: source.Entries.length, Comments: source.Comments.length,
        entryId: source.Entries[source.Entries.length - 1][0],
        commentId: source.Comments[source.Comments.length - 1][0]
      }));
    } else followupDiscordValidateState_(JSON.parse(saved), source);
    if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'pollFollowupDiscord')) {
      ScriptApp.newTrigger('pollFollowupDiscord').timeBased().everyMinutes(1).create();
    }
    Logger.log('跟進日誌通知已啟用；舊資料不會補發。');
  });
}

function pollFollowupDiscord() {
  followupDiscordLocked_(function () {
    const props = PropertiesService.getScriptProperties();
    const webhook = followupDiscordWebhook_(props);
    const saved = props.getProperty('FOLLOWUP_DISCORD_STATE');
    if (!saved) throw new Error('請先執行 installFollowupDiscord，避免補發舊資料。');
    if (Number(props.getProperty('FOLLOWUP_DISCORD_RETRY_AT') || 0) > Date.now()) return;
    const source = followupDiscordSource_(), state = JSON.parse(saved);
    followupDiscordValidateState_(state, source);
    const parents = {};
    source.Entries.slice(1).forEach(row => { parents[row[0]] = row; });
    let budget = 20;
    const pending = JSON.parse(props.getProperty('FOLLOWUP_DISCORD_OUTBOX') || 'null');
    const order = pending && pending.event.indexOf('Comments:') === 0 ? ['Comments','Entries'] : ['Entries','Comments'];
    for (const name of order) {
      const idKey = name === 'Entries' ? 'entryId' : 'commentId';
      while (state[name] < source[name].length && budget > 0) {
        const row = source[name][state[name]];
        const parent = name === 'Entries' ? row : parents[row[1]];
        const event = name + ':' + state[name] + ':' + row[0];
        const eligible = row[0] && parent && parent[5] !== 'deleted';
        if (eligible) {
          let outbox = JSON.parse(props.getProperty('FOLLOWUP_DISCORD_OUTBOX') || 'null');
          if (outbox && outbox.event !== event) throw new Error('通知佇列與來源不符，請檢查來源排序。');
          if (!outbox) {
            const chunks = followupDiscordChunks_(followupDiscordText_(name, row, parent));
            chunks.forEach((text, i) => props.setProperty('FOLLOWUP_DISCORD_CHUNK_' + i, text));
            outbox = { event: event, count: chunks.length, next: 0 };
            props.setProperty('FOLLOWUP_DISCORD_OUTBOX', JSON.stringify(outbox));
          }
          while (outbox.next < outbox.count && budget > 0) {
            const content = props.getProperty('FOLLOWUP_DISCORD_CHUNK_' + outbox.next);
            if (!content) throw new Error('通知快照不完整，請檢查私人設定。');
            if (!followupDiscordSend_(webhook, content, props)) return;
            budget--;
            outbox.next++;
            props.setProperty('FOLLOWUP_DISCORD_OUTBOX', JSON.stringify(outbox));
          }
          if (outbox.next < outbox.count) return;
        }
        state[name]++; state[idKey] = row[0];
        props.setProperty('FOLLOWUP_DISCORD_STATE', JSON.stringify(state));
        followupDiscordClearOutbox_(props);
      }
    }
  });
}

function testFollowupDiscord() {
  const props = PropertiesService.getScriptProperties();
  if (!followupDiscordSend_(followupDiscordWebhook_(props), '✅ AMRS 跟進日誌通知連接測試成功。新事項及新留言會自動發到本頻道；舊資料不會補發。', props)) {
    throw new Error('Discord 暫時限流，請稍後再測試。');
  }
}

function followupDiscordLocked_(action) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try { return action(); } finally { lock.releaseLock(); }
}

function followupDiscordWebhook_(props) {
  const url = String(props.getProperty('FOLLOWUP_DISCORD_WEBHOOK') || '').trim();
  if (!/^https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url)) throw new Error('請設定有效的私人 Discord Webhook。');
  return url;
}

function followupDiscordSource_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  if (!book) throw new Error('此 GAS 必須綁定跟進日誌 Sheet。');
  const result = { id: book.getId() };
  const headers = {
    Entries: ['ID','Company','Venue','Title','Content','Status','Priority','Due Date','Known People','Created At','Updated At'],
    Comments: ['ID','Entry ID','Name','Content','Created At']
  };
  Object.keys(headers).forEach(name => {
    const sheet = book.getSheetByName(name);
    if (!sheet) throw new Error('缺少日誌工作表：' + name);
    const rows = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), headers[name].length).getDisplayValues();
    if (headers[name].some((header, i) => rows[0][i] !== header)) throw new Error('日誌欄位不符：' + name);
    result[name] = rows;
  });
  return result;
}

function followupDiscordValidateState_(state, source) {
  if (state.version !== 1 || state.sheet !== source.id) throw new Error('通知來源已改變，請勿重用其他 Sheet 的設定。');
  for (const name of ['Entries','Comments']) {
    const cursor = state[name], id = state[name === 'Entries' ? 'entryId' : 'commentId'];
    if (!Number.isInteger(cursor) || cursor < 1 || cursor > source[name].length) throw new Error('日誌來源已縮短，停止通知以免遺漏資料。');
    if (source[name][cursor - 1][0] !== id) throw new Error('日誌來源排序已改變，停止通知以免重複。');
  }
}

function followupDiscordText_(name, row, parent) {
  const company = parent[1] === 'OTHER' ? '其他事項' : parent[1];
  const scope = company + (parent[2] ? ' / ' + parent[2] : '');
  let author = row[2];
  if (name === 'Entries') {
    try { author = JSON.parse(parent[8]).join('、'); } catch (_) { author = parent[8]; }
  }
  const text = (name === 'Entries' ? '📌 新跟進事項' : '💬 新留言') + '\n' + scope + '\n事項：' + parent[3] + '\n' +
    (name === 'Entries' ? '輸入者：' : '留言者：') + author + '\n' + (name === 'Entries' ? parent[4] : row[3]) +
    '\n查看：' + 'https://akira1102-creat.github.io/amrs/';
  // Plain text, no accidental formatting or user-supplied mass mentions.
  return text.replace(/([\\*_`~|>])/g, '\\$1');
}

function followupDiscordChunks_(text) {
  const chunks = [];
  while (text.length > 1900) {
    let end = text.lastIndexOf('\n', 1899) + 1 || 1900;
    if (/[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
    chunks.push(text.slice(0, end)); text = text.slice(end);
  }
  if (text) chunks.push(text);
  return chunks;
}

function followupDiscordSend_(url, content, props) {
  let response;
  try {
    response = UrlFetchApp.fetch(url + '?wait=true', { method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ content: content, allowed_mentions: { parse: [] } }), muteHttpExceptions: true, followRedirects: false });
  } catch (_) { throw new Error('Discord 通知連線失敗，待下次重試。'); }
  const code = response.getResponseCode();
  if (code === 429) {
    let seconds = 60;
    try { seconds = Math.max(1, Number(JSON.parse(response.getContentText()).retry_after) || 60); } catch (_) {}
    props.setProperty('FOLLOWUP_DISCORD_RETRY_AT', String(Date.now() + seconds * 1000));
    return false;
  }
  if (code < 200 || code >= 300) throw new Error('Discord 通知失敗（HTTP ' + code + '），待下次重試。');
  props.deleteProperty('FOLLOWUP_DISCORD_RETRY_AT');
  return true;
}

function followupDiscordClearOutbox_(props) {
  const outbox = JSON.parse(props.getProperty('FOLLOWUP_DISCORD_OUTBOX') || 'null');
  props.deleteProperty('FOLLOWUP_DISCORD_OUTBOX');
  if (outbox) for (let i = 0; i < outbox.count; i++) props.deleteProperty('FOLLOWUP_DISCORD_CHUNK_' + i);
}
