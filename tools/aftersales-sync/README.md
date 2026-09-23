# AMRS 網上版 → aftersales 維護記錄同步

這是一個獨立的本機工具。它從 AMRS 網上版讀取已儲存的維護記錄，經運行中的 aftersales HTTP API 建立維護批次；只讀 aftersales SQLite 以核對機器 SN、場地及已同步標記。它不修改 aftersales 程式檔，也不直接寫入其資料庫。

## 需要

- Windows、PowerShell 7、Node.js 24。
- aftersales server 在同一部電腦運行；預設地址為 `http://127.0.0.1:5000`。
- 一個可登入 aftersales、具備維護記錄寫入權限的已啟用帳戶，以及 AMRS 網上版個人 Token。舊版 Deploy ID 可用 `--amrs-mode gas`。
- 確認已備份 aftersales 資料。歷史補錄會真正新增維護批次。

Token、密碼只在啟動時以隱藏輸入讀入程序記憶體，不會寫入設定檔。命令輸出只包含數量及錯誤類別，不列出客戶、場地或 SN。

## 操作

在本資料夾開 PowerShell，依次執行：

```powershell
./Start.ps1 map
./Start.ps1 preview
./Start.ps1 apply
./Start.ps1 watch
```

`map` 掃描全部歷史記錄，產生 `venue-map.suggested.local.json`。它只在同一個 AMRS 場地的機器全部指向同一個 aftersales 客戶及分店時提出建議；不能判斷的項目為 `null`。請逐項核對後，另存成 `venue-map.local.json`。這兩個本機檔案均被 Git 忽略。格式如下，名稱只作示例：

```json
{
  "SCL|Demo Venue": { "customer": "Demo Customer", "branch": "Demo Branch" }
}
```

若 AMRS 場地與 aftersales 分店／客戶名稱完全相同，而且 SN 唯一對應一個正在使用的系統，沒有對照檔亦可預覽及同步。名稱不同時必須提供已核對的對照。`preview` 只列出全量歷史的 `ready`、`already`、`changed`、`blocked` 數量；先處理 `blocked`，再執行 `apply` 補錄。`watch` 首次掃描全量歷史，之後每小時查最近 45 日，並每日再掃一次全量歷史；Ctrl+C 結束。可用 `--interval-minutes 30` 調整間隔。

若程式或資料庫位於其他目錄，可傳入 `--db "<aftersales.db 完整路徑>"`；若 server 使用另一個本機埠，可傳入 `--aftersales-url http://127.0.0.1:<埠>`。工具只會把 aftersales 登入資料送到本機地址。

若 AMRS 使用原有 Deploy ID，可在每個命令後加 `--amrs-mode gas`。預設個人 Token 模式會從同一份 AMRS 網上版程式讀取 Worker 地址；亦可用 `--amrs-url <HTTPS 地址>` 指定。

## 寫入內容及限制

每筆 AMRS 記錄建立一筆 aftersales 維護批次。日期寫入維護日期；場地、機器 SN、`Action Taken`、原因及檢查人寫入備註。工具先以 SN 對應現有已安裝機器，再核對場地；找不到、對應多個系統、場地不同或缺少固定記錄 ID 時會列作 `blocked`，不會新增設備或猜測配對。aftersales 若因空槽位等情況拒絕寫入，會計入 `failed`，不會自動確認。

備註含由 AMRS 固定記錄 ID 算出的來源標記，讓重跑及失去 HTTP 回覆後可與 aftersales 實際資料對帳，不會重覆補錄。AMRS 已同步記錄日後被修改時會列作 `changed`，工具不會自動刪改 aftersales 既有記錄；請核對後決定如何處理。現有 aftersales 維護 API 只提供批次日期、系統編號和備註，SN 及工作內容會顯示於備註，而非獨立搜尋欄位。

`apply`／`watch` 只在 aftersales server 運行時使用。即使 AMRS 網上版暫時無法連線，aftersales 本身仍可在本機繼續使用；同步會等下一次成功連線後重試。
