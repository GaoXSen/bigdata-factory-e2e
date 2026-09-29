/**
 * 来源：工厂测试用例-标准化业务版-湖南中行-数据地图闭环固化版.xlsx / DS-03-01
 * API 管理：新增→查询→编辑→上线→商店查询→下线→删除。级联值只取页面已保存的数据源。
 */
// 环境配置中心（ENV-CONFIG-40）先于工具导入：首次解析会把 API_* 兼容变量
// 按 dataSourceNames.apiService 回填，后续工具与用例读到一致的默认值。
import { testEnvironment } from '../../../test-environment.js';
import { test, expect, uuid, clickMenu, assertNoConsoleErrors } from '../utils.js';
import {
  clickVisible,
  expectSuccess,
  visible,
  visibleDialog,
} from '../抽样用例工具.js';

test.describe.configure({ timeout: 120_000 });

// API 级联链路来自配置中心 dataSourceNames.apiService（DS-PERM-51）：
// API_* 兼容变量可单项覆盖，代码不再写死 110/113 地址、库名或历史表名。
const apiService = testEnvironment.dataSourceNames.apiService;
const API_CHAIN = [
  process.env.API_DATA_SOURCE_TYPE?.trim() || apiService.type,
  process.env.API_DATA_SOURCE_NAME?.trim() || apiService.name,
  process.env.API_DATABASE?.trim() || apiService.database,
  process.env.API_SCHEMA?.trim() || apiService.schema,
  process.env.API_TABLE?.trim() || apiService.table || '',
];

async function chooseDialogOption(page: Parameters<typeof visibleDialog>[0], dialog: Awaited<ReturnType<typeof visibleDialog>>, index: number, expected: string): Promise<void> {
  const combobox = dialog.getByRole('combobox').nth(index);
  await expect(combobox).toBeVisible();
  await combobox.click({ force: true });
  // 级联数据源有时展示为“192.168.76.110”，而配置只写地址；
  // 优先精确命中，找不到时允许在当前可见弹层中按文本包含匹配。
  const exact = page.getByRole('option', { name: expected, exact: true }).last();
  const partial = page.getByRole('option', { name: expected, exact: false }).last();
  const option = page.locator(
    '.ant-select-dropdown:visible .ant-select-item-option, .ant-select-dropdown:visible .ant-select-dropdown-menu-item, ' +
    '.el-select-dropdown:visible .el-select-dropdown__item, [role="listbox"]:visible [role="option"]',
  ).filter({ hasText: expected }).last();
  // 来源表级联接口返回较慢时，点击下拉框后不会立即渲染 option；
  // 等待“精确/包含/组件节点”任一路径出现，避免把异步数据误报为定位失败。
  await expect.poll(async () => (
    await exact.isVisible().catch(() => false) ||
    await partial.isVisible().catch(() => false) ||
    await option.isVisible().catch(() => false)
  ), { timeout: 20_000 }).toBe(true);
  const visibleOption = await exact.isVisible().catch(() => false)
    ? exact
    : await partial.isVisible().catch(() => false)
      ? partial
      : option;
  await visibleOption.click({ force: true });
  await page.waitForTimeout(300);
}

async function selectApiFields(dialog: Awaited<ReturnType<typeof visibleDialog>>): Promise<void> {
  // 录制稿显示：选择来源表、POST 和请求地址后，需要勾选可暴露的字段。
  // 字段列表在选定数据表后异步加载（本轮实测曾即时计数为 0 导致误报），先轮询等待渲染。
  const fields = dialog.locator('input[type="checkbox"]:visible');
  await expect.poll(async () => await fields.count(), {
    timeout: 15_000,
    message: '目标表未显示可选择字段，无法创建可调用 API。',
  }).toBeGreaterThan(0);
  const count = await fields.count();
  for (let index = 0; index < Math.min(count, 3); index += 1) {
    const field = fields.nth(index);
    if (!(await field.isChecked())) await field.check();
  }
}

async function queryApi(page: Parameters<typeof visibleDialog>[0], apiName: string): Promise<void> {
  const queryInput = page.getByRole('textbox').first();
  await expect(queryInput).toBeVisible({ timeout: 10_000 });
  await queryInput.fill(apiName);
  const queryButton = page.getByRole('button', { name: /查询/ }).last();
  await expect(queryButton).toBeVisible({ timeout: 10_000 });
  await queryButton.click();
  await page.waitForTimeout(500);
}

/** API 列表的数据表与操作表是两个并列 table，不能在操作表中按 API 名称找行。 */
async function apiOperationRow(page: Parameters<typeof visibleDialog>[0], apiName: string): Promise<Awaited<ReturnType<typeof visibleDialog>>> {
  const dataTable = page.locator('table:visible').filter({ hasText: /API名称/ }).last();
  const dataRows = dataTable.locator('tbody > tr:visible, [role="row"]:visible');
  const operationTable = page.locator('table:visible').filter({ hasText: /操作/ }).last();
  const operationRows = operationTable.locator('tbody > tr:visible, [role="row"]:visible');
  for (let index = 0; index < await dataRows.count(); index += 1) {
    if (await dataRows.nth(index).getByText(apiName, { exact: true }).count()) {
      const operationRow = operationRows.nth(index);
      await expect(operationRow).toBeVisible({ timeout: 15_000 });
      return operationRow as Awaited<ReturnType<typeof visibleDialog>>;
    }
  }
  throw new Error(`API 列表未找到本轮 API：${apiName}`);
}

/** finally 清理：只删除本轮唯一命名的 API；查询不到（未创建或已删除）时静默结束。 */
async function deleteRoundApiIfPresent(page: Parameters<typeof visibleDialog>[0], apiName: string): Promise<void> {
  try {
    // 中途失败时创建弹窗可能仍打开，先收起再走列表查询，避免误填弹窗输入框。
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(300);
    await queryApi(page, apiName);
    const row = await apiOperationRow(page, apiName);
    await clickVisible(row, /删\s*除/);
    await clickVisible(page, /确\s*定|删\s*除/);
    await page.waitForTimeout(500);
  } catch {
    // 清理是 best-effort：唯一 UUID 名称只可能命中本轮资源，失败不改变用例真实结果。
  }
}

/** 上线/下线本轮 API：按唯一名称查询定位操作行，点击按钮并等待成功提示。 */
async function toggleRoundApiOnline(page: Parameters<typeof visibleDialog>[0], apiName: string, action: RegExp): Promise<void> {
  await queryApi(page, apiName);
  const row = await apiOperationRow(page, apiName);
  await clickVisible(row, action);
  await expectSuccess(page, /成功|上线|下线/);
  await page.waitForTimeout(300);
}

/** 商店卡片：按 API 名称向上找到带“申请权限”按钮的卡片；找不到即上线后商店不可见。 */
async function requireStoreCard(page: Parameters<typeof visibleDialog>[0], apiName: string): Promise<Awaited<ReturnType<typeof visibleDialog>>> {
  const name = page.getByText(apiName, { exact: true });
  const count = await name.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    let scope = name.nth(index);
    for (let level = 0; level < 6; level += 1) {
      if (await scope.getByText('申请权限', { exact: true }).count()) return scope;
      scope = scope.locator('..');
    }
  }
  throw new Error(`上线 API“${apiName}”未出现在 API 商店，当前页面：${page.url()}`);
}

test('DS-03-01｜API 新增、查询、编辑、查询、删除闭环', async ({ loginPage, consoleErrors, report }) => {
  // 环境重置迁移（DS-PERM-51）：移除 ENV-02 时代的历史跳过，恢复创建闭环的真实验证。
  // 创建“保存”若再返回后端错误，按页面真实提示失败并附证据，finally 仍只清理本轮资源。
  test.setTimeout(240_000);
  const page = loginPage;
  const apiName = `codex_api_${uuid()}`;
  try {
    await clickMenu(page, '数据服务', 'API管理');
    // API 页面同时可能存在列表“新增/新建”文字和其它菜单按钮；
    // 固定点击页面右上角真实的新建 API 按钮，避免命中旧页面残留节点。
    const createApiButton = page.getByRole('button', { name: '+ 新建API', exact: true });
    await expect(createApiButton).toBeVisible({ timeout: 15_000 });
    await createApiButton.click();
    const dialog = await visibleDialog(page);
    const textboxes = dialog.getByRole('textbox');
    await textboxes.nth(0).fill(apiName);
    await textboxes.nth(1).fill(`抽样 API ${apiName}`);

    for (let index = 0; index < API_CHAIN.length; index += 1) {
      await chooseDialogOption(page, dialog, index, API_CHAIN[index]);
    }
    await expect(dialog.getByRole('radio', { name: 'post', exact: true })).toBeVisible();
    await dialog.getByRole('radio', { name: 'post', exact: true }).check();
    // 页面校验要求请求路径以字母开头，只允许字母、数字和下划线。
    await textboxes.nth(2).fill(`e2e_${apiName}`);
    await selectApiFields(dialog);
    await clickVisible(dialog, /保\s*存/);
    // 当前版本保存成功后弹窗不会自动关闭；录制流程也是“保存→取消”后回到列表。
    // 先识别明确的失败提示，再关闭创建弹窗并通过列表查询确认真正落库。
    await page.waitForTimeout(500);
    const failureNotice = page.locator('.ant-message-notice-content:visible, .ant-notification-notice:visible, .el-message:visible, [role="alert"]:visible')
      .filter({ hasText: /失败|验证不通过|不能为空|错误/ }).last();
    if (await failureNotice.isVisible().catch(() => false)) {
      throw new Error(`API 创建失败：${await failureNotice.innerText()}`);
    }
    const cancelCreate = dialog.getByRole('button', { name: /取\s*消/ });
    if (await cancelCreate.isVisible().catch(() => false)) await cancelCreate.click();
    await queryApi(page, apiName);
    const row = await apiOperationRow(page, apiName);
    await clickVisible(row, /编辑/);
    const editDialog = await visibleDialog(page);
    await editDialog.getByRole('textbox').nth(1).fill(`抽样 API ${apiName}_编辑后`);
    await clickVisible(editDialog, /保\s*存/);
    await page.waitForTimeout(500);
    const cancelEdit = editDialog.getByRole('button', { name: /取\s*消/ });
    if (await cancelEdit.isVisible().catch(() => false)) await cancelEdit.click();
    await queryApi(page, apiName);
    // 上线 → API 商店可查询 → 下线（DS-PERM-74 补齐行 52 闭环；删除仍在下方主流程）。
    const onlineRow = await apiOperationRow(page, apiName);
    await clickVisible(onlineRow, /上\s*线/);
    await expectSuccess(page, /成功|上线/);
    await clickMenu(page, '数据服务', 'API应用', 'API商店');
    const storeQuery = page.getByRole('textbox').first();
    await expect(storeQuery).toBeVisible({ timeout: 10_000 });
    await storeQuery.fill(apiName);
    const storeQueryButton = page.getByRole('button', { name: /查\s*询/ }).last();
    await expect(storeQueryButton).toBeVisible({ timeout: 10_000 });
    await storeQueryButton.click();
    await page.waitForTimeout(500);
    const storeCard = await requireStoreCard(page, apiName);
    await expect(storeCard).toBeVisible();
    // 回到 API 管理执行下线，保证后续删除闭环不受上线状态限制。
    await clickMenu(page, '数据服务', 'API管理');
    await queryApi(page, apiName);
    const offlineRow = await apiOperationRow(page, apiName);
    await clickVisible(offlineRow, /下\s*线/);
    await expectSuccess(page, /成功|下线/);
    await queryApi(page, apiName);
    const latestRow = await apiOperationRow(page, apiName);
    await clickVisible(latestRow, /删除/);
    await clickVisible(page, /确\s*定|删除/);
    await expectSuccess(page, /删除成功|成功/);
    await expect(page.getByText(apiName, { exact: true })).toHaveCount(0);

    await assertNoConsoleErrors(consoleErrors);
    await report('DS-03-01 API 上线商店下线删除闭环', true, `使用已登记链路：${API_CHAIN.join(' → ')}。`);
  } finally {
    // 主流程已删除时此处查询不到，自动空操作；只清理本轮唯一命名资源。
    await deleteRoundApiIfPresent(page, apiName);
  }
});
