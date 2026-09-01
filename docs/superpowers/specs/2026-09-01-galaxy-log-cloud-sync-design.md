# Galaxy Log 雲端 Google Sheet 同步設計

## 目標

將 Galaxy 取 Log 清單改成「雲端主資料 + 本機離線工作佇列」：

- 公司有網絡時，可以讀取及同步指定的 Google Sheet。
- 現場無網絡時，Surface 仍可查看清單、標記已取 Log，以及保留未同步變更。
- 有網絡時按「匯入雲端」匯入 Excel／CSV 後會直接寫回 Google Sheet；現場完成取 Log 的變更則先留在本機，之後按「同步」寫回。
- 保留 Excel／CSV 匯出功能，不影響 AMRS 其他公司及功能。

## 雲端資料來源

使用者提供的 Galaxy Log Google Sheet，由 Worker 的受保護設定提供 spreadsheet ID；程式碼及瀏覽器不硬編號或顯示該 ID。Worker 優先使用名為 `Galaxy Log` 的分頁；如果該檔案已有其他名稱的第一個分頁則沿用第一個分頁，完全沒有分頁時才建立 `Galaxy Log`。

瀏覽器沿用 AMRS 現有 Worker session／permission 流程，由 Worker 使用現有 Google Sheets service account 寫入；不在前端直接登入 Google 或保存 Google credential。

## Sheet 格式

使用原有固定三欄一組的版面，支援任意數量的欄組：

```text
A-C: 機身號碼（最後 4 位） | 指定取 Log 日期 | 成功取 Log 日期
D-F: 機身號碼（最後 4 位） | 指定取 Log 日期 | 成功取 Log 日期
...每 3 欄重複一組
```

系統內每組三欄轉成一筆 task。清單列以第一行作標題（如存在）及其後資料列；空白欄組略過。`taskId` 由「SN 末 4 位 + 指定日期 + 欄組位置 + 列位置」穩定產生，避免同一 SN／日期因為在不同欄組而被錯誤合併。Worker 只更新對應第三欄，不會把客戶既定的三欄版面改成另一種格式。

Worker 內部 task 會附帶狀態、來源欄組／列位置及更新時間等同步資料，但這些欄位只存在 API／本機狀態，不會新增可見欄位到客戶 Sheet。若指定 Sheet 已有三欄一組資料，讀取及同步均直接使用該格式；匯入 Excel／CSV 仍接受現有 P.Mass／JM 來源格式，並轉成同一套 task。

## 本機狀態

localStorage 保存：

- 最近一次成功從雲端下載的 task snapshot。
- Excel／CSV 匯入後的本機清單；有網絡時同時上傳雲端，離線時保留待同步佇列。
- 未同步的 mutation outbox（完成、改回未取、匯入新增／更新）。
- `lastCloudSyncAt`、最後同步結果及需要留意的錯誤。

每個 mutation 帶有 task ID、變更欄位、客戶端更新時間及唯一 mutation ID；重試不會重複新增或覆蓋已完成資料。

## 使用流程

### 開啟頁面

- 有網絡及有效 AMRS session：讀取雲端清單，合併本機未同步 outbox 後顯示。
- 無網絡、session 暫時不可用或讀取失敗：顯示上次本機 snapshot，並清楚顯示「離線／未同步」狀態；不清除本機資料。

### 現場操作

按「已取 Log」或「改回未取」時，立即更新畫面及本機 snapshot，並加入 outbox；不要求即時網絡。完成日期使用 Surface 的本地日期。

### 按同步

1. 鎖定同步按鈕，避免重複提交。
2. 以 task ID 批量提交 outbox；新增及更新均採 upsert。
3. Worker 在同一個寫入鎖內讀取最新 Sheet、套用變更、寫回及清除快取。
4. 成功後重新下載雲端清單，更新本機 snapshot、`lastCloudSyncAt`，只移除已確認的 mutation。
5. 部分失敗時保留未成功 mutation，顯示失敗數量，讓使用者稍後再次同步。

### 匯入雲端

1. 使用者選取 Excel／CSV 後，瀏覽器先在本機解析既有格式。
2. 解析出的新增／更新資料先寫入本機及 outbox；有網絡及有效 session 時立即呼叫同步流程。
3. 離線或雲端暫時不可用時保留本機資料，稍後按「同步雲端」重試。

## 衝突規則

- 雲端已有完成日期，而本機只保存未取：保留雲端完成日期。
- 本機有未同步完成日期，而雲端仍未完成：同步時套用本機完成日期。
- 雲端與本機對同一 task 都有不同完成日期／狀態：不靜默覆蓋；保留本機 outbox，顯示該 task 為「需跟進／同步衝突」，待使用者重新操作後再提交。
- 以 stable task ID 判斷同一筆資料，不以 SN 末 4 位單獨判斷。

## API

新增受現有 AMRS session 保護的兩個 action：

- `galaxyLogOverview`（GET）：回傳標準化 task、來源欄組、Sheet 分頁及 server 版本時間。
- `syncGalaxyLog`（POST）：接受 mutation 陣列，回傳每筆 mutation 的 `applied`／`conflict`／`failed` 結果及同步後的版本時間。

兩個 action 沿用 AE permission。寫入 action 使用既有 D1 operation／sheet write lock／cache invalidation 模式。

## 錯誤及安全

- 沒有設定 Galaxy Sheet ID 時，Worker 回傳可理解的設定錯誤；前端保留本機模式，不會阻止現場工作。
- Sheet 權限、session 過期、網絡中斷均以可重試狀態顯示，outbox 不會被刪除。
- 不將 Google Sheet URL、service account、token 或其他 credential 寫入前端 bundle、localStorage、日誌或匯出檔。
- 所有寫入只限 Galaxy Log 專用分頁，不觸碰 AMRS 公司維護記錄。

## 驗證及交付

- 先以合成的三欄／六欄／九欄資料測試解析、upsert、重試及衝突。
- 加入前端 localStorage／offline／sync 測試及 Worker repository／API 測試。
- 通過現有 root tests、Worker tests、語法檢查及 diff 檢查。
- 發佈前更新 index app bump、所有 Galaxy 資產 query version 及 Service Worker cache；再驗證線上頁面和 Worker API。
