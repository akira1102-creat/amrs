# Schedule 跟進日誌摘要

`followup-notifications.js` 是通用 GAS 輔助程式，不包含憑證、私人來源 ID 或原始日程。
原有每日 Schedule 入口在載入日誌後，加上同一天 AM／PM 共用的提醒 context：

```js
const followups = loadScheduleFollowups_();
followups.reminders = createScheduleFollowupReminderContext_(ss, today);
```

保留原有 AM／PM 分別匹配場地、略過週末及 Public Holiday、長訊息分段等行為。
組合訊息後，用以下入口取代直接 `sendToDiscord(msg)`：

```js
sendScheduleWithFollowupReminders_(msg, followups.reminders);
```

- 首次提示使用完整文章；同一內容連續工作日提示時，只顯示標題及狀態標籤。
- 上一工作日依日程表判定，跨月、週末及 Public Holiday 仍有效。
- 只顯示標題的日子亦會延續提醒記錄，不會變成隔日輪流發全文。
- 內容、標題、公司、場地、緊急程度或跟進日期更改，重新顯示全文；純更新時間不影響。
- 上一工作日未曾成功提示該事項，重新顯示全文。
- 只在整份 Schedule 全部分段確認成功後，記錄實際顯示的事項。
- 原始日誌及日程不會被修改；私人 Script Properties 只保存最近兩個工作日的事項 ID 及內容 SHA-256，沒有文章內容。
- 各事項、場地組別及文章中的數字編號大點之間留一行空白。
- 新版第一次定時執行沒有舊提醒記錄，會先發全文，再於之後工作日簡化。

此功能只處理每日 Schedule；不更改另一個「新事項／新留言」Discord 通知 GAS。
本機驗證用合成資料及模擬發送，不需要向真正頻道發測試訊息。
