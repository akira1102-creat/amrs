# AMRS — 更新流程指引

## 公開／私有原始碼邊界

公開程式庫只保存通用登入入口、載入器及部署工具。完整應用原始碼保留於本機 `.private-runtime/source`，不可重新加入公開版本。既有 Git 歷史未因此清除。

修改應用時，編輯私有來源，執行原有前端及 API 測試，再執行 `node scripts/build-private-client.mjs`。以 `worker/deploy-private.jsonc` 部署受驗證介面及原有 API，保留現有環境變數、密鑰及 D1 綁定；完成後才推送公開登入入口。

公開入口用 `node --test test/*.test.mjs` 驗證，並以 `node scripts/build-public.mjs <新輸出目錄>` 打包。只可發佈此輸出，不能將工作目錄或私有來源整份發佈。

> 每次有任何修改推送到 `main`，**必須同時完成以下兩步**，確保已安裝 PWA 的用戶能自動取得最新版本，不受 Service Worker / 瀏覽器暫存影響。

---

## 每次更新必做 Checklist

### 1. 更新 `sw.js` — Cache Name Bump

開啟 `public/sw.js`，把第一行 `CACHE` 的版本號 +1：

```js
// 例如舊版
const CACHE = 'akira-ml-v8';

// 改成
const CACHE = 'akira-ml-v9';
```

> **原因**：Service Worker 靠 cache name 判斷是否有新版。名稱不變 → 舊 SW 繼續服務 → 用戶看不到更新。

---

### 2. 更新 `index.html` — APP_BUMP + 版本號

在 `.private-runtime/source/index.html` `<script>` 內找到：

```js
const _APP_BUMP = '2026.05.13-1';
```

改成今日日期 + 流水號，例如：

```js
const _APP_BUMP = '2026.05.14-1';
```

同時更新底部版本顯示用的常數（同一個 `_APP_BUMP` 值會自動反映到 UI）。

同步更新 `public/index.html` 及 `public/sw.js` 的公開資源版本，重新產生受驗證介面包。介面包版本包含內容雜湊；未改動時仍須先驗證 Token 才可重用本機快取。

> **原因**：`manifest.json?v=...` 的 query string 版本 + HTML 的 bump 值雙重確保瀏覽器不會用暫存版本。

---

## 版本號格式說明

| 項目 | 格式 | 範例 |
|------|------|-----------|
| `CACHE`（sw.js）| `akira-ml-vN` | `akira-ml-v8` |
| `_APP_BUMP`（index.html）| `YYYY.MM.DD-N` | `2026.05.13-1` |
| UI 顯示版本（底部灰字）| `v0.NNN` | `v0.800` |

UI 顯示版本號（`v0.NNN`）對應 sw.js cache name 的 `N` 值 × 100，方便用戶截圖反映問題時對版本。

---

## 快速指令（給 AI/自動化）

每次叫 AI 幫你更新時，可以直接說：

> 「幫我推送修改，記得 BUMP」

AI 會自動：
- `sw.js` cache name +1
- `_APP_BUMP` 更新成今日日期
- UI 底部版本號跟隨更新
- 一次 commit 推上去
