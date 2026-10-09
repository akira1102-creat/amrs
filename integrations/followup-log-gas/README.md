# 跟進日誌 Discord 通知

將 `discord-notifications.js` 加入跟進日誌試算表所綁定的 Apps Script。
此腳本不需要公開 Web App 部署，也不會更改日誌資料。

1. 私人「指令碼屬性」新增 `FOLLOWUP_DISCORD_WEBHOOK`，填入指定 Discord 頻道的 Webhook。
2. 執行 `installFollowupDiscord`，授權試算表讀取、外部請求及自動觸發條件。
3. 執行 `testFollowupDiscord`，確認指定頻道收到連接測試。

每分鐘檢查新增事項及留言。首次安裝只建立基準，不補發歷史。
重新執行安裝不會重設進度或增加重複觸發條件。
已刪除事項及其留言不發送；編輯現有文章不另發新通知。
公司、場地、標題、內容及輸入者／留言者會發到指定頻道，不觸發大量標註。
沒有新資料時不呼叫 Discord；此流程不使用 Cloudflare。

長文章自動分段，已確認成功的段落保留進度；429 等待後重試，其他失敗保留待發內容。
網絡中斷或執行中止若發生於 Discord 已收取、但 GAS 未記錄成功的一刻，仍可能重複一個段落，無法保證絕對只送一次。

來源必須維持 AMRS 的 append-only／soft-delete 工作方式。
不要手動排序、搬移、刪除 `Entries`／`Comments` 原始列。
若來源縮短或已處理位置的 ID 改變，腳本停止並於 GAS 執行記錄報錯，避免靜默漏發。

暫停：在 GAS「觸發條件」刪除 `pollFollowupDiscord` 的時間觸發條件。
恢復：再次執行 `installFollowupDiscord`，沿用原進度。

Webhook、來源 ID、通知進度及文章快照只可保留於私人 GAS 設定；不要提交到版本庫。
