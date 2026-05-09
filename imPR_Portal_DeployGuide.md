# imPR Enterprise Portal — 部署安裝指南
## GitHub Pages + Google Apps Script + Google Sheets

---

## 第一步：建立 Google Sheet 資料庫

1. 前往 https://sheets.google.com
2. 建立新試算表，命名：**imPR Portal Database**
3. 複製網址列中的 Sheet ID（格式如：`1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms`）
4. 記下此 ID，後面會用到

---

## 第二步：部署 Google Apps Script

1. 前往 https://script.google.com
2. 點「新專案」
3. 將 `Code.gs` 的內容**全部貼入**
4. 修改頂部設定：
   ```javascript
   const CONFIG = {
     SHEET_ID: '貼入你的 Google Sheet ID',
     JWT_SECRET: '自訂一段安全密鑰（至少 32 字元）',
     ADMIN_EMAIL: 'admin@impr.com.tw',  // 改成你的 email
     ...
   };
   ```
5. **執行初始化**：
   - 在函式下拉選單選擇 `initSystem`
   - 點「執行」▶
   - 第一次會要求授權 → 點「審查權限」→「允許」
   - 確認 Apps Script Logger 顯示「✅ imPR Portal 系統初始化完成！」

6. **部署為 Web App**：
   - 點右上角「部署」→「新增部署作業」
   - 類型選「網頁應用程式」
   - 說明：`imPR Portal API v1`
   - 執行身分：**「我（你的帳號）」**
   - 誰可以存取：**「所有人」**（含未登入者，因為 API 自行驗證 JWT）
   - 點「部署」
   - **複製 Web App 網址**（格式：`https://script.google.com/macros/s/AKfycb.../exec`）

7. **設定健康偵測排程**（選用）：
   - 點左側「觸發條件」（鬧鐘圖示）
   - 新增觸發條件
   - 函式：`scheduledHealthCheck`
   - 活動來源：時間驅動
   - 類型：小時計時器
   - 每：1 小時
   - 儲存

---

## 第三步：建立 GitHub Repository

1. 前往 https://github.com → 點「New repository」
2. 名稱：`impr-portal`（或自訂）
3. 設為 **Public**（GitHub Pages 免費版需 Public）
4. 初始化 README：勾選
5. 建立 Repository

---

## 第四步：上傳前端檔案

### 方法 A：GitHub 網頁直接上傳（最簡單）

1. 在 Repository 頁面點「Add file」→「Upload files」
2. 上傳以下檔案：
   - `index.html`（Portal 主程式，即 `imPR_Portal_Complete.html` 改名）
3. Commit changes

### 方法 B：使用 Git（推薦）

```bash
git clone https://github.com/你的帳號/impr-portal.git
cd impr-portal
# 複製 imPR_Portal_Complete.html 為 index.html
cp imPR_Portal_Complete.html index.html
git add .
git commit -m "Initial Portal deployment"
git push origin main
```

---

## 第五步：設定 GitHub Pages

1. 進入 Repository → 點「Settings」
2. 左側選「Pages」
3. Source：選「Deploy from a branch」
4. Branch：選「main」，資料夾選「/ (root)」
5. 儲存
6. 等待 1-2 分鐘，頁面會顯示網址：
   `https://你的帳號.github.io/impr-portal`

---

## 第六步：設定前端連接 API

開啟 `index.html`（或直接在 GitHub 上編輯），找到：
```javascript
const GAS_URL = 'YOUR_GAS_WEB_APP_URL_HERE';
```

替換為第二步取得的 Web App 網址：
```javascript
const GAS_URL = 'https://script.google.com/macros/s/AKfycb.../exec';
```

儲存並 Push 到 GitHub。

---

## 第七步：測試登入

1. 開啟 `https://你的帳號.github.io/impr-portal`
2. 使用初始帳號登入：
   - Email：`admin@impr.com.tw`（你設定的）
   - 密碼：`Admin@impr2026`
3. 登入成功後**立即修改密碼**（後台 → 使用者管理）

---

## Google Sheet 結構（initSystem 自動建立）

| 工作表名稱 | 用途 |
|-----------|------|
| users | 使用者帳號資料 |
| systems | 系統入口設定 |
| categories | 系統分類 |
| announcements | 公告內容 |
| favorites | 使用者收藏 |
| usage_logs | 點擊存取紀錄 |
| sessions | JWT 登入工作階段 |
| settings | 系統設定 |

---

## 常見問題排解

### Q: 登入後顯示「無法連線至伺服器」
- 確認 `GAS_URL` 設定正確
- 確認 GAS 部署設定為「所有人」可存取
- 在瀏覽器直接開啟 GAS URL 確認是否有回應

### Q: initSystem 執行失敗
- 確認 SHEET_ID 正確
- 確認已給予 Google Apps Script 存取 Google Sheets 的授權

### Q: GitHub Pages 顯示 404
- 確認主要檔案命名為 `index.html`
- 確認 Pages 設定已啟用並指向正確 Branch

### Q: 如何新增系統入口？
- 用 Admin 帳號登入 → 後台管理 → 系統管理 → 新增系統

### Q: 如何新增員工帳號？
- 後台 → 使用者管理 → 新增使用者 → 設定角色

---

## 安全注意事項

1. **修改 JWT_SECRET**：使用至少 32 字元的隨機字串
2. **修改初始密碼**：第一次登入後立即更改
3. **定期清理 sessions**：GAS 可設 weekly trigger 清理過期 session
4. **Google Sheet 存取**：只有 GAS 有寫入權限，Sheet 本身不對外開放

---

## 維護與更新

### 更新前端
```bash
# 修改 index.html 後
git add index.html
git commit -m "Update portal UI"
git push origin main
# GitHub Pages 約 1 分鐘自動更新
```

### 更新 GAS 後端
1. 開啟 script.google.com
2. 修改程式碼
3. 點「部署」→「管理部署作業」→「編輯」
4. 版本選「建立新版本」→「部署」

### 備份資料
- Google Sheet 資料會自動保留於 Google Drive
- 可在 Google Sheet 選「檔案」→「下載」→「CSV」做本地備份

---

**版本** v1.0.0 | **日期** 2026-05-09 | **新動力公共關係顧問股份有限公司**
