# imPR 帳號中心

公司內部系統共用的帳號服務：一組帳號密碼登入入口網站後，所有放在 `imprjoseph.github.io` 的內部系統都共用這次登入。

| 位置 | 內容 |
|---|---|
| `auth-service/src/` | Apps Script 原始碼（綁在「imPR 帳號中心」試算表上） |
| `sso/sso.js` | 各系統前端載入的共用登入程式 |
| `login/` | 登入頁與變更密碼頁 |
| `admin/` | 帳號管理頁（只有 admin 勾選的帳號能用） |
| `portal/` | 系統入口，登入後只列出有權限的系統 |

## 第一次啟用（管理者做一次）

1. 打開「imPR 帳號中心」試算表 → 擴充功能 → Apps Script。
2. 函式選單選 `setupAccounts`，按「執行」，依畫面授權。這一步會建立 `accounts` 分頁和簽章密鑰；沒做之前，帳號中心不會回應任何請求。
3. 在 `accounts` 分頁每人填一列：

| 欄位 | 說明 |
|---|---|
| account | 登入帳號，不分大小寫 |
| password | 密碼，以明碼存放 |
| name / email / dept | 姓名、email、部門 |
| type | 帳號類型：`正職` 或 `派遣`，空白視為正職。派遣帳號只能使用派遣人員勤務，其他系統的角色和 admin 都不生效 |
| active | 勾選才能登入；離職或停權時取消勾選 |
| admin | 勾選的人是帳號管理員，可以用帳號管理頁 |
| note | 備註 |
| 系統欄（`activity-tracker`、`impr-attendance`…、`ai-design`） | 這個人在該系統的角色，例如 `admin`、`manager`、`staff`；空白代表不能使用 |

**這份試算表只能分享給管理者本人。** 密碼是明碼，任何能打開它的人都看得到全公司密碼；其他系統一律透過帳號中心驗證，不需要、也不應該直接讀這張表。

## 帳號管理頁

帳號管理員從入口網站右上角「帳號管理」進入（`/total-system/admin/`），可以新增帳號、修改姓名／email／部門、設定各系統角色、停用帳號、重設密碼。

- 每個系統的角色只能從固定清單選（定義在 `Code.js` 的 `SYSTEMS`），試算表的角色欄也是同一份下拉選單。新增系統或角色時改 `SYSTEMS`，再執行一次 `setupAccounts`。
- 管理頁不顯示密碼，只能重設；重設時一併解除鎖定。要看原密碼請直接開試算表。
- 管理員不能停用自己或拿掉自己的管理權限，避免最後一位管理員把自己鎖在外面。

## 規則與原因

- 憑證有效 12 小時（一個工作天）。入口網站每次開啟都會回查帳號表，停用立即生效；其他系統只檢查簽章，最晚 12 小時後失效。
- 同一帳號連續輸錯 5 次鎖定 15 分鐘，登入和變更密碼共用次數。服務對所有人開放，不限次數就能無限猜密碼。代價是別人可以故意輸錯，把某個帳號鎖住 15 分鐘；遇到時等 15 分鐘即可。
- 登入頁設了內容安全政策：只執行本站程式、只連線到帳號中心，降低被插入惡意程式偷密碼的風險。
- 帳號不存在和密碼錯誤回同一句話，避免被拿來試出哪些帳號存在。
- 緊急時（例如懷疑憑證外洩）在編輯器執行 `rotateSecret`：所有人在所有系統立刻登出。
- 憑證存在瀏覽器 localStorage，`imprjoseph.github.io` 底下的任何頁面都讀得到，包括對外的活動網站。所以憑證只代表「登入過」，各系統後端仍要向帳號中心驗證身分與角色，不能只信瀏覽器端的內容。

## API（POST，body 為 JSON 字串，不設 Content-Type）

| action | 參數 | 回傳 |
|---|---|---|
| `login` | account, password | token, user |
| `me` | token | 新 token、最新 user（回查帳號表） |
| `verify` | token, system | user, role（沒有該系統角色時回 `FORBIDDEN`） |
| `changePassword` | token, oldPassword, newPassword | 新 token, user |

錯誤格式：`{ ok:false, error:{ code, message } }`。code 有 VALIDATION、AUTH、LOCKED、DISABLED、TOKEN、FORBIDDEN、LOCK、INTERNAL。

## 部署與測試

```bash
cd auth-service
node test/run.js
node test/sso.js
npx -y @google/clasp push -f
npx -y @google/clasp redeploy <deploymentId> -d "說明"
```

`clasp create` 會把 `appsscript.json` 覆蓋成預設值（時區變成紐約、沒有網頁應用程式設定），推送前要確認內容。
