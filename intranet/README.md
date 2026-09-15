# AMRS 內網版（開發中）

四部電腦透過公司內網使用同一主機，資料寫入主機 SQLite。
主機需要開機及運行程式；其他電腦需要連到主機的內網，不需要互聯網。
內網包包含整個 AMRS 的主要模組：六家公司資料輸入、工作安排、資料查詢、每月統計、零件及跟進、CVCS、Galaxy、MGM Check Request 和系統管理。主要頁面已用本機合成資料巡查；公司資料遷移、四台實機驗收、完整操作驗收、備份還原演練及公司 IT 網絡審批仍未完成，不可視為正式投產。

## 開發環境啟動

使用支援 `node:sqlite` 的 Node.js 24。從專案根目錄執行：

```powershell
node intranet/cli.mjs setup ./intranet-data
node intranet/cli.mjs start ./intranet-data
```

首次設定會在本機終端顯示管理員 Token，請妥善保管，不要放入共用文件。
主機瀏覽器開啟 `http://localhost:8080`。其他電腦使用主機內網 IP 及連接埠；啟動時會列出偵測到的私有 IPv4 網址，方便同事直接選用。
伺服器只接受本機、RFC1918 私有 IPv4 網段及內部/鏈路本地 IPv6 來源；不要設定路由器對外轉發，並由公司 IT 再用防火牆限定辦公室內網。
HTTP 內網頁面不等於已支援可安裝 PWA；HTTPS 及安裝流程仍待驗證。

## 搬入原有 Excel 資料

準備本機 Excel 檔案及 JSON 對照檔。鍵名只接受以下資料簿：
`Melco`、`MGM`、`SJM`、`SCL`、`GEG`、`Wynn`、`parts`、`schedule`、`cvcs`、`galaxy-log`、`mgm-check-request`。
檔案路徑相對於對照檔位置，例子：

```json
{
  "Melco": "melco.xlsx",
  "MGM": "mgm.xlsx",
  "SJM": "sjm.xlsx",
  "SCL": "scl.xlsx",
  "GEG": "geg.xlsx",
  "Wynn": "wynn.xlsx",
  "parts": "parts.xlsx",
  "schedule": "schedule.xlsx",
  "cvcs": "cvcs.xlsx",
  "galaxy-log": "galaxy-log.xlsx",
  "mgm-check-request": "mgm-check-request.xlsx"
}
```

```powershell
node intranet/cli.mjs import ./new-local-data ./mapping.json
node intranet/cli.mjs setup ./new-local-data
node intranet/cli.mjs start ./new-local-data
```

目標目錄必須不存在，避免覆蓋原有資料。原始檔案不會修改。
保留工作表名稱及欄位順序；合併格會展開為相同內容。
讀入的是 Excel 已儲存的顯示值，不會運算 Excel 公式；搬入前應先在 Excel 重算並儲存。
匯入對照檔必須列出以上全部 11 個資料簿；缺少或拼錯時會在讀取 Excel 前拒絕匯入，避免首次啟動以空白工作簿補齊而誤以為搬遷完成。即使某個資料簿目前沒有紀錄，也請提供該資料簿的 Excel 檔及工作表。

## 備份及還原工作表

```powershell
node intranet/cli.mjs backup ./intranet-data ./backup-new.json
node intranet/cli.mjs restore ./restored-data ./backup-new.json
node intranet/cli.mjs setup ./restored-data
```

備份不會覆蓋已有檔案，還原只接受新目錄。備份包括業務工作表，**不包括登入憑證、提交追蹤及系統操作紀錄**，不是整個系統的災難復原映像。
還原後需重新建立登入憑證。備份包含公司資料，應只保存在公司批准的本機或內網儲存裝置。

## 已有自動測試

## 建立 Windows 內網測試包

在 Windows 使用 Node.js 24，並準備相同版本的官方 Node.js LICENSE 檔案：

```powershell
node intranet/build.mjs ./new-test-package ./node-LICENSE.txt
```

只會複製指定程式檔、執行環境及授權文字，不會複製資料庫或登入 Token。
輸出目錄必須不存在。需要沿用現有公司資料時，先將全部 11 個 Excel 工作簿列入 mapping JSON，在首次設定前執行 `Import.cmd mapping.json`；成功後才執行 `Setup.cmd` 建立管理員 Token，再以 `Start.cmd` 啟動主機。全新空白測試環境則直接執行 `Setup.cmd`，再執行 `Start.cmd`。資料放在包內 `data` 目錄。
此為開發測試包，包含整個 AMRS 介面並移除公網服務客戶端；未經公司 IT 批准及四台實機驗收，不可當作正式部署。

## 自動測試

```powershell
node --test intranet/*.test.mjs
```

目前涵蓋本機持久儲存、維護提交及查詢、身份驗證、靜態檔案限制、工作表編輯、備份還原及 Excel 轉換。另已用本機瀏覽器巡查主要 AMRS 頁面，確認資料請求只到測試內網主機。
這不代表所有操作細節、公司資料遷移、四台實機併發、公司網絡隔離政策或 IT 資安審查已通過。
