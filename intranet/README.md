# AMRS 內網版（開發中）

四部電腦透過公司內網使用同一主機，資料寫入主機 SQLite。
主機需要開機及運行程式；其他電腦需要連到主機的內網，不需要互聯網。
此版本尚未完成完整介面、部署及多用戶驗證，不應直接代替正式系統。

## 開發環境啟動

使用支援 `node:sqlite` 的 Node.js 24。從專案根目錄執行：

```powershell
node intranet/cli.mjs setup ./intranet-data
node intranet/cli.mjs start ./intranet-data
```

首次設定會在本機終端顯示管理員 Token，請妥善保管，不要放入共用文件。
主機瀏覽器開啟 `http://localhost:8080`。其他電腦使用主機內網 IP 及連接埠。
不要設定路由器對外轉發；防火牆應由公司 IT 限定辦公室內網。
HTTP 內網頁面不等於已支援可安裝 PWA；HTTPS 及安裝流程仍待驗證。

## 搬入原有 Excel 資料

準備本機 Excel 檔案及 JSON 對照檔。鍵名只接受以下資料簿：
`Melco`、`MGM`、`SJM`、`SCL`、`GEG`、`Wynn`、`parts`、`schedule`、`cvcs`、`galaxy-log`、`mgm-check-request`。
檔案路徑相對於對照檔位置，例子：

```json
{
  "SCL": "maintenance.xlsx",
  "schedule": "schedule.xlsx",
  "galaxy-log": "log-list.xlsx"
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
未提供的資料簿會在首次啟動時建立空白結構。

## 備份及還原工作表

```powershell
node intranet/cli.mjs backup ./intranet-data ./backup-new.json
node intranet/cli.mjs restore ./restored-data ./backup-new.json
node intranet/cli.mjs setup ./restored-data
```

備份不會覆蓋已有檔案，還原只接受新目錄。備份包括業務工作表，**不包括登入憑證、提交追蹤及系統操作紀錄**，不是整個系統的災難復原映像。
還原後需重新建立登入憑證。備份包含公司資料，應只保存在公司批准的本機或內網儲存裝置。

## 已有自動測試

## 建立 Windows 開發測試包

在 Windows 使用 Node.js 24，並準備相同版本的官方 Node.js LICENSE 檔案：

```powershell
node intranet/build.mjs ./new-test-package ./node-LICENSE.txt
```

只會複製指定程式檔、執行環境及授權文字，不會複製資料庫或登入 Token。
輸出目錄必須不存在。包內 `Setup.cmd` 作首次設定，`Start.cmd` 啟動主機；資料放在包內 `data` 目錄。
此為開發測試包，尚未完成可交付版本的介面及隔離環境驗證。

## 自動測試

```powershell
node --test intranet/*.test.mjs
```

目前涵蓋本機持久儲存、維護提交及查詢、身份驗證、靜態檔案限制、工作表編輯、備份還原及 Excel 轉換。
不代表所有原版功能、四台實機併發或無外網環境的瀏覽器操作已通過驗證。
