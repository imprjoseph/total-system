/**
 * 管理者在 Apps Script 編輯器手動執行的函式。
 */

/**
 * 建立 accounts 分頁與簽章密鑰。可重複執行：已存在的分頁只補缺少的欄位，既有資料不動。
 */
function setupAccounts() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME, 0);

  const wanted = BASE_COLUMNS.concat(SYSTEM_COLUMNS);
  const lastColumn = sheet.getLastColumn();
  const header = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(h => String(h).trim()) : [];
  const missing = wanted.filter(c => header.indexOf(c) === -1);
  if (missing.length) {
    sheet.getRange(1, header.length + 1, 1, missing.length).setValues([missing]);
    missing.forEach(c => header.push(c));
  }
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');

  // 密碼欄設成純文字，否則 0123 這類密碼會被試算表轉成數字 123。
  const passwordCol = header.indexOf('password') + 1;
  sheet.getRange(1, passwordCol, sheet.getMaxRows(), 1).setNumberFormat('@');
  const dataRows = Math.max(sheet.getMaxRows() - 1, 1);
  ['active', 'admin'].forEach(c => sheet.getRange(2, header.indexOf(c) + 1, dataRows, 1).insertCheckboxes());
  const typeRule = SpreadsheetApp.newDataValidation()
    .requireValueInList([ACCOUNT_TYPES.STAFF, ACCOUNT_TYPES.DISPATCH], true).setAllowInvalid(false).build();
  sheet.getRange(2, header.indexOf('type') + 1, dataRows, 1).setDataValidation(typeRule);
  // 角色欄做成下拉選單，直接改試算表時也只能選有效角色，和帳號管理頁的檢查一致。
  SYSTEMS.forEach(s => {
    const rule = SpreadsheetApp.newDataValidation().requireValueInList(s.roles, true).setAllowInvalid(false).build();
    sheet.getRange(2, header.indexOf(s.id) + 1, dataRows, 1).setDataValidation(rule);
  });

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN_SECRET')) props.setProperty('TOKEN_SECRET', newSecret_());

  console.log('accounts 分頁已就緒，新增欄位：' + (missing.join(', ') || '無'));
  console.log('請在自己那一列勾選 admin，才能使用帳號管理頁');
  return { addedColumns: missing };
}

/**
 * 緊急時使用：更換簽章密鑰，所有人在所有系統的登入立刻失效、必須重新登入。
 */
function rotateSecret() {
  PropertiesService.getScriptProperties().setProperty('TOKEN_SECRET', newSecret_());
  console.log('已更換密鑰，所有登入已失效');
}

function newSecret_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}
