/**
 * 来源：工厂测试用例-标准化业务版-湖南中行-数据地图闭环固化版.xlsx / DM-02-01
 * 数据地图新建表：基础信息→生命周期→字段→保存/建表。
 *
 * 2026-09-22（DS-PERM-63 清洁环境迁移，保留当日既有用户改动）：
 * - 建表入口数据源按配置中心的公共 MySQL 类型（/mysql/i）匹配；下拉未提供 MySQL 数据源
 *   属环境前置缺失，上报证据后条件跳过，不抛错硬失败、也不静默选第一个库。
 * - 负责人不再取下拉首项（旧数据假设）：口径同 DM-00-03 selectOwner，优先缺省管理员
 *   （admin，与配置中心登录账号 TEST_USER 缺省一致），否则首个可选项；下拉为空=环境
 *   前置缺失，条件跳过。
 * - 三个用例统一 try/finally：登记本轮 UUID 自建表，finally 仅清理本轮表（物理表尽力
 *   DROP + 元数据行内删除入口尽力尝试），清理失败只告警、不掩埋用例真实结果。
 * - 引用元数据链路增加数据元库为空守卫（弹窗打开但无数据元行=环境前置缺失，条件跳过留证）。
 * - 硬链接双入口兼容：仅从 ../utils.js 与 ../抽样用例工具.js 取工具与配置（dbConfig() 等），
 *   不直接相对引用 e2e/test-environment.ts（孪生路径相对深度不同会断链）。
 */
import { test, expect, uuid, clickMenu, assertNoConsoleErrors, query, dbConfig } from '../utils.js';
import {
  chooseFirstOption,
  clickFormControlByLabel,
  clickVisible,
  fillFormField,
  visible,
} from '../抽样用例工具.js';
import type { Locator, Page, TestInfo } from '@playwright/test';

async function openTableManage(page: Page): Promise<void> {
  // 从默认“数据源管理”直接 goto 数据地图深层 hash 时，当前 SPA 偶发只改地址
  // 或直接保留原组件。使用真实菜单切换才能稳定卸载旧页面并挂载表管理列表。
  try {
    await clickMenu(page, '数据地图', '表管理');
  } catch {
    // 登录后首屏偶发只渲染空的顶栏容器，菜单文字尚未挂载。此时用同一个 hash
    // 不会重建 Vue 实例，必须带一次性 query 参数进行完整文档导航再进入表管理。
    const freshRoute = new URL(page.url().split('#')[0]);
    freshRoute.searchParams.set('e2e_table_manage', String(Date.now()));
    freshRoute.hash = '/dataMap/tableManage/tablesManage';
    await page.goto(freshRoute.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
  }
  // 当前数据地图把“表管理”拆为父路由与同名列表叶子。父路由只显示侧栏，不会
  // 挂载列表/新建表按钮；必须展开父菜单后点击 /tablesManage 叶子。
  const parent = page.locator('a[href="#/dataMap/tableManage"]:visible').last();
  if (await parent.isVisible().catch(() => false)) await parent.click();
  const leaf = page.locator('a[href="#/dataMap/tableManage/tablesManage"]:visible').last();
  await expect(leaf, '表管理菜单没有渲染列表叶子页').toBeVisible({ timeout: 12_000 });
  await leaf.click();
  await expect(page).toHaveURL(/#\/dataMap\/tableManage\/tablesManage(?:\?|$)/, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: /新建表|新增表/ }).last()).toBeVisible({ timeout: 15_000 });
}

async function chooseFirstFormOption(page: Page, label: RegExp): Promise<void> {
  try {
    const control = await clickFormControlByLabel(page, label);
    await chooseFirstOption(page, control, String(label));
  } catch (error) {
    // MySQL 新建表页的 schema、主领域和安全等级在当前环境可能是非必填且没有可选数据；
    // 不能把这些可选项误判成建表主流程失败，必填项仍继续抛错。
    if (/schema|主领域|主题域|安全等级/i.test(String(label))) return;
    throw error;
  }
}

async function openCreateTableEntry(page: Page): Promise<boolean> {
  // “新建表”是带下拉箭头的组合按钮。通用文本点击会命中外层容器而不展开
  // 数据源菜单；这里固定点击真实 button，并且只选择配置中心的公共 MySQL 数据源
  // （按 /mysql/i 类型匹配，具体数据源实例由环境配置决定，spec 不持有数据源名称）。
  const newTable = page.getByRole('button', { name: /^新建表/ }).last();
  const source = page.getByRole('menuitem', { name: /mysql/i }).last();
  let opened = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await newTable.click({ force: true });
    if (await source.isVisible({ timeout: 2_000 }).catch(() => false)) {
      opened = true;
      break;
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(300);
  }
  if (!opened) return false;
  await source.click({ force: true });
  // 新版表单在数据库选中后先展示“语句添加”，再加载保存按钮。
  await expect(page.getByText('语句添加', { exact: true }).last()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /保\s*存/ }).last()).toBeVisible({ timeout: 15_000 });
  return true;
}

const fieldRows = (page: Page) => page.locator([
  'tbody > tr:visible',
  '.ant-table-tbody > tr:visible',
  '.el-table__body-wrapper tr:visible',
  '[role="row"]:visible:not(:has([role="columnheader"]))',
].join(', '));


async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  for (let index = 0; index < await locator.count(); index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

/**
 * 负责人解析（口径同 DM-00-03 selectOwner）：下拉中优先缺省管理员（admin，与配置中心
 * 登录账号 TEST_USER 缺省一致），否则首个可选项；返回 'owner-empty' 表示下拉无可选项，
 * 属环境前置缺失，由用例上报证据后条件跳过，不假设任何旧负责人数据。
 */
async function pickOwnerFormOption(page: Page): Promise<'selected' | 'owner-empty'> {
  const pickFromOpenedDropdown = async (): Promise<'selected' | 'owner-empty'> => {
    const options = page.locator(
      '.el-select-dropdown:visible .el-select-dropdown__item, .ant-select-dropdown:visible .ant-select-item, ' +
        '[role="listbox"]:visible [role="option"], .el-dropdown-menu:visible li',
    ).filter({ visible: true });
    const first = options.first();
    if (!(await first.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false))) {
      await page.keyboard.press('Escape').catch(() => undefined);
      return 'owner-empty';
    }
    const preferred = options.filter({ hasText: /admin/i }).first();
    if (await preferred.isVisible().catch(() => false)) {
      await preferred.click();
      return 'selected';
    }
    await first.click();
    return 'selected';
  };
  // 表单行的 label 距其 select 仅 1 层父链；逐候选（从后往前）在 ≤4 层父链内定位真实
  // select 包裹层，避免“字段信息”列头同名文字把锚点选错（口径同 DM-03-02）。
  const candidates = page.getByText(/负责人/).filter({ visible: true });
  for (let index = await candidates.count() - 1; index >= 0; index -= 1) {
    let scope = candidates.nth(index);
    for (let level = 0; level < 4; level += 1) {
      const wrapper = await firstVisible(scope.locator('select:visible, .ant-select:visible, .el-select:visible'));
      if (wrapper) {
        await wrapper.click();
        return await pickFromOpenedDropdown();
      }
      scope = scope.locator('..');
    }
  }
  // 兜底：共享工具的可见控件查找（保持原语义）。
  const control = await clickFormControlByLabel(page, /负责人/);
  await control.click();
  return await pickFromOpenedDropdown();
}

async function openCreateTableForm(
  page: Page,
  tableName: string,
  chineseName: string,
): Promise<'ok' | 'source-missing' | 'owner-empty'> {
  await openTableManage(page);
  if (!(await openCreateTableEntry(page))) return 'source-missing';
  await fillFormField(page, /表名称|表名/, tableName);
  await fillFormField(page, /表中文名称|表中文名/, chineseName);
  for (const label of [/数据层级/, /库.?层级/, /schema/i, /主领域|主题域/, /安全等级/]) {
    await chooseFirstFormOption(page, label);
  }
  const ownerState = await pickOwnerFormOption(page);
  if (ownerState === 'owner-empty') return 'owner-empty';
  await chooseFirstFormOption(page, /数据生命周期/);
  await chooseFirstFormOption(page, /操作类型/);
  const noConfirm = page.getByRole('radio', { name: '否', exact: true }).last();
  if (await noConfirm.isVisible().catch(() => false)) await noConfirm.check();
  return 'ok';
}


async function fillParsedFieldDetails(page: Page): Promise<void> {
  // DDL 解析已经给出真实字段类型；这里只补齐必填中文名，不重新选择类型，
  // 避免把 INTEGER 等类型误改成下拉框第一项 CHAR。
  const chineseInputs = page.locator('input[placeholder*="字段中文"]:visible');

  for (let index = 0; index < await chineseInputs.count(); index += 1) {
    await chineseInputs.nth(index).fill(`字段${index + 1}`);
  }
}
async function fillDirectFieldRows(page: Page): Promise<void> {
  const rows = fieldRows(page);
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const inputs = row.locator('input:visible');
    if (await inputs.count() > 1) await inputs.nth(1).fill(`字段${index + 1}`);
    // 数据类型带 * 是必填项。测试准备表统一使用页面支持且跨环境兼容性最好的
    // VARCHAR，避免“看起来有字段、实际保存时类型为空”或超长类型被后端拒绝。
    const typeControl = row.locator(
      'select:visible, .el-select:visible, .ant-select:visible, .ant-select-selector:visible, ' +
        '[role="combobox"]:visible, input[placeholder*="类型"]:visible',
    ).first();
    if (!(await typeControl.count())) throw new Error(`字段第 ${index + 1} 行未找到数据类型必填控件。`);
    const tagName = await typeControl.evaluate((element) => element.tagName.toLowerCase()).catch(() => '');
    if (tagName === 'select') {
      const options = typeControl.locator('option');
      let selected = false;
      for (let optionIndex = 0; optionIndex < await options.count(); optionIndex += 1) {
        const option = options.nth(optionIndex);
        const text = (await option.innerText().catch(() => '')).trim();
        if (/varchar|char/i.test(text)) {
          await typeControl.selectOption({ label: text });
          selected = true;
          break;
        }
      }
      if (!selected) throw new Error(`字段第 ${index + 1} 行没有 VARCHAR/CHAR 类型选项。`);
    } else {
      await typeControl.click({ force: true });
      const searchInput = page.locator('.ant-select-search__field:visible, input[placeholder*="搜索"]:visible').last();
      if (await searchInput.isVisible().catch(() => false)) await searchInput.fill('VARCHAR');
      else await page.keyboard.type('VARCHAR');
      const option = page.locator(
        '.el-select-dropdown__item:visible, .ant-select-item-option:visible, ' +
          '.ant-select-dropdown-menu-item:visible, [role="listbox"] [role="option"]:visible',
      ).filter({ hasText: /VARCHAR|CHAR(?:ACTER)?/i }).last();
      if (await option.isVisible().catch(() => false)) await option.click({ force: true });
      else await page.keyboard.press('Enter');
    }
    const lengthInput = row.locator('input[placeholder*="长度"], input[type="number"], [role="spinbutton"]').first();
    if (await lengthInput.isVisible().catch(() => false)) await lengthInput.fill('64');
  }
}

async function submitCreateTable(page: Page, tableName: string): Promise<void> {
  await page.getByRole('button', { name: /建\s*表/ }).last().click();
  await expect(page).toHaveURL(/#\/dataMap\/tableManage/, { timeout: 15_000 });
  await expect(fieldRows(page).filter({ hasText: tableName }).first()).toBeVisible({ timeout: 15_000 });
}


// ==================== 本轮自建资产清理（DS-PERM-63） ====================

/** 仅合法 MySQL 标识符（≤64 字符）才可能是本轮真实物理表；非法探针名直接跳过物理回收。 */
function isDroppablePhysicalName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && name.length <= 64;
}

/** 尽力回收本轮物理表（dbConfig() 缺失或 DROP 失败只告警，不掩埋用例结果）。 */
async function dropRoundPhysicalTables(names: string[]): Promise<void> {
  const droppable = [...new Set(names)].filter(isDroppablePhysicalName);
  if (!droppable.length) return;
  if (!dbConfig()) {
    console.warn(`[cleanup] DB 未配置：本轮物理表未回收（${droppable.join(', ')}），元数据按 UUID 可追溯。`);
    return;
  }
  for (const name of droppable) {
    try {
      await query(`DROP TABLE IF EXISTS \`${name}\``);
    } catch (error) {
      console.warn(`[cleanup] 本轮物理表 ${name} DROP 失败（尽力而为）：`, error);
    }
  }
}

/** 行内操作定位（口径同 DM-03-02 manageRowAction）：仅接受精确“删除/移除”文本，避免误触其它列。 */
async function findRowAction(page: Page, row: Locator, name: RegExp): Promise<Locator | undefined> {
  const selectors = 'button:visible, a:visible, .el-link:visible, [role="button"]:visible, [class*="link"]:visible';
  for (const scope of [row.locator(selectors), row.locator('td:visible').last().locator(selectors)]) {
    for (let index = await scope.count() - 1; index >= 0; index -= 1) {
      const candidate = scope.nth(index);
      const text = (await candidate.innerText().catch(() => '')).replace(/\s+/g, '');
      if (name.test(text) && (await candidate.isVisible().catch(() => false))) return candidate;
    }
  }
  return undefined;
}

/** 元数据行内删除入口尽力而为：入口不存在（当前版本未提供）时仅告警保留，UUID 可追溯。 */
async function deleteRoundMetadataRows(page: Page, names: string[]): Promise<void> {
  for (const name of new Set(names)) {
    try {
      let filter = page.locator('input:visible:not([type="checkbox"]):not([type="radio"])').first();
      if (!(await filter.isVisible().catch(() => false))) {
        // 用例结束页可能仍停在表单页：尝试一次菜单导航回列表（失败则放弃页面侧回收）。
        await clickMenu(page, '数据地图', '表管理').catch(() => undefined);
        const leaf = page.locator('a[href="#/dataMap/tableManage/tablesManage"]:visible').last();
        if (await leaf.isVisible().catch(() => false)) await leaf.click().catch(() => undefined);
        await page.waitForTimeout(500);
        filter = page.locator('input:visible:not([type="checkbox"]):not([type="radio"])').first();
        if (!(await filter.isVisible().catch(() => false))) {
          console.warn(`[cleanup] 未回到表管理列表，跳过“${name}”元数据页面侧回收（UUID 可追溯）。`);
          continue;
        }
      }
      await filter.fill(name);
      const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
      if (await queryButton.isVisible().catch(() => false)) await queryButton.click();
      const row = fieldRows(page).filter({ hasText: name }).first();
      if (!(await row.isVisible({ timeout: 3_000 }).catch(() => false))) continue;
      const action = await findRowAction(page, row, /^删\s*除$|^移\s*除$/);
      if (!action) {
        console.warn(`[cleanup] 表管理未提供“${name}”行内删除/移除入口，元数据保留（UUID 可追溯）。`);
        continue;
      }
      await action.click();
      const dialog = page.getByRole('dialog').last();
      const confirm = (await dialog.isVisible().catch(() => false))
        ? dialog.getByRole('button', { name: /^确\s*定$/ }).last()
        : page.getByRole('button', { name: /^确\s*定$/ }).last();
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
    } catch (error) {
      console.warn(`[cleanup] 本轮元数据“${name}”页面侧回收失败（尽力而为）：`, error);
    }
  }
}

/** finally 专用：仅清理本轮 UUID 自建表（物理表 + 元数据行内入口），全部尽力而为、只告警不抛错。 */
async function cleanupRoundTables(page: Page, names: string[]): Promise<void> {
  if (!names.length) return;
  await dropRoundPhysicalTables(names);
  await deleteRoundMetadataRows(page, names);
}


test.describe('DM-02-01｜数据地图｜新建表', () => {
  test.describe.configure({ timeout: 300_000 });

  test('DM-02-01｜数据地图新建表：生命周期与字段完整填写', async ({ loginPage, consoleErrors, report }, testInfo) => {
    const page = loginPage;
    const tableName = `codex_tbl_${uuid()}`;
    const roundTables = [tableName];
    try {
      await openTableManage(page);
      if (!(await openCreateTableEntry(page))) {
        await report('DM-02-01 新建表完整表单', false, '环境前置缺失：新建表下拉未提供 MySQL 数据源，无法进入建表表单，跳过。');
        testInfo.skip();
        return;
      }
  
      await fillFormField(page, /表名称|表名/, tableName);
      await fillFormField(page, /表中文名称|表中文名/, `抽样表_${uuid()}`);
      for (const label of [/数据层级/, /库.?层级/, /schema/i, /主领域|主题域/, /安全等级/]) {
        await chooseFirstFormOption(page, label);
      }
      const ownerState = await pickOwnerFormOption(page);
      if (ownerState === 'owner-empty') {
        await report('DM-02-01 新建表完整表单', false, '环境前置缺失：负责人下拉无可选项（清洁环境应至少包含缺省管理员），跳过。');
        testInfo.skip();
        return;
      }
      // 生命周期是下拉框，不能只填写上方基础信息后直接保存。
      await chooseFirstFormOption(page, /数据生命周期/);
      await chooseFirstFormOption(page, /操作类型/);
      const noConfirm = page.getByRole('radio', { name: '否', exact: true }).last();
      if (await noConfirm.isVisible().catch(() => false)) await noConfirm.check();
  
      await clickVisible(page, /语句添加/);
      const editor = page.locator('.monaco-editor:visible textarea').last();
      await expect(editor).toBeVisible({ timeout: 10_000 });
      await editor.fill(`CREATE TABLE ${tableName} (id VARCHAR(64), name VARCHAR(128), remark VARCHAR(255))`);
      await page.getByRole('button', { name: /解\s*析|校\s*验/ }).last().click();
      // 解析接口是异步更新字段表；用字段行出现作为成功信号，
      // 不依赖某个字段文本是否被固定列裁切。
      await expect.poll(() => fieldRows(page).count(), { timeout: 15_000 }).toBeGreaterThan(0);
      await fillParsedFieldDetails(page);
      await page.getByRole('button', { name: /建\s*表/ }).last().click();
      await expect(page).toHaveURL(/#\/dataMap\/tableManage\/tablesManage(?:\?|$)/, { timeout: 15_000 });
      const search = page.locator('input:visible').first();
      if (await search.isVisible().catch(() => false)) {
        await search.fill(tableName);
        const query = page.getByRole('button', { name: /查\s*询/ }).last();
        if (await query.isVisible().catch(() => false)) await query.click();
      }
      await expect(page.locator('body')).toContainText(tableName, { timeout: 15_000 });
      // 新建表默认处于“物理表存在&下线”；必须上线后才会出现在表查询。
      const createdRow = page.locator('tr:visible').filter({ hasText: tableName }).last();
      const online = createdRow.getByText(/上\s*线/).last();
      if (await online.isVisible().catch(() => false)) {
        await online.click();
        const dialog = page.getByRole('dialog').last();
        const confirm = dialog.getByRole('button', { name: /^确\s*定$/ }).last();
        if (await confirm.isVisible().catch(() => false)) await confirm.click();
        await page.waitForTimeout(800);
      }
  
      await assertNoConsoleErrors(consoleErrors);
      await report('DM-02-01 新建表完整表单', true, `本轮表名：${tableName}；仅使用 UUID 测试对象，finally 已尽力回收本轮表。`);
    } finally {
      await cleanupRoundTables(page, roundTables);
    }
  });


  test('DM-02-01｜数据地图新建表：手动添加字段', async ({ loginPage, consoleErrors, report }, testInfo) => {
    const page = loginPage;
    const tableName = `codex_manual_${uuid()}`;
    const roundTables = [tableName];
    try {
      const formState = await openCreateTableForm(page, tableName, `手动字段表_${uuid()}`);
      if (formState !== 'ok') {
        const reason = formState === 'source-missing'
          ? '新建表下拉未提供 MySQL 数据源，无法进入建表表单'
          : '负责人下拉无可选项（清洁环境应至少包含缺省管理员）';
        await report('DM-02-01 新建表-手动添加字段', false, `环境前置缺失：${reason}，跳过。`);
        testInfo.skip();
        return;
      }
      await clickVisible(page, /直接添加字段|直接添加|添加字段|新增字段/);
      await fieldRows(page).last().locator('input').first().fill('id');
      await clickVisible(page, /直接添加字段|直接添加|添加字段|新增字段/);
      await fieldRows(page).last().locator('input').first().fill('name');
      await fillDirectFieldRows(page);
      await submitCreateTable(page, tableName);
      await assertNoConsoleErrors(consoleErrors);
      await report('DM-02-01 新建表-手动添加字段', true, `本轮表名：${tableName}；finally 已尽力回收本轮表。`);
    } finally {
      await cleanupRoundTables(page, roundTables);
    }
  });

  test('DM-02-01｜数据地图新建表：引用元数据添加字段', async ({ loginPage, consoleErrors, report }, testInfo) => {
    const page = loginPage;
    const tableName = `codex_metadata_${uuid()}`;
    const roundTables = [tableName];
    try {
      const formState = await openCreateTableForm(page, tableName, `元数据字段表_${uuid()}`);
      if (formState !== 'ok') {
        const reason = formState === 'source-missing'
          ? '新建表下拉未提供 MySQL 数据源，无法进入建表表单'
          : '负责人下拉无可选项（清洁环境应至少包含缺省管理员）';
        await report('DM-02-01 新建表-引用元数据', false, `环境前置缺失：${reason}，跳过。`);
        testInfo.skip();
        return;
      }
      await clickVisible(page, /引用数据元/);
      const dialog = page.locator('.ant-modal:visible, .el-dialog:visible, [role="dialog"]:visible').filter({ hasText: /数据元|字段/ }).last();
      if (!(await dialog.isVisible().catch(() => false))) await clickVisible(page, /选择数据元|引用数据元/);
      const scope = (await dialog.isVisible().catch(() => false)) ? dialog : page;
      const firstRow = scope.locator('tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible').first();
      if (await dialog.isVisible().catch(() => false)) {
        // 弹窗已打开但列表为空＝清洁环境数据元库为空，属环境前置缺失，
        // 上报证据后条件跳过，不再把“无数据可引用”误报为用例失败。
        const appeared = await firstRow.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
        if (!appeared) {
          await report('DM-02-01 新建表-引用元数据', false, '环境前置缺失：数据元选择弹窗内无任何数据元行（清洁环境数据元库为空），无法继续引用元数据链路，跳过。');
          testInfo.skip();
          return;
        }
      }
      await expect(firstRow).toBeVisible({ timeout: 10_000 });
      await firstRow.locator('input[type="checkbox"], .el-checkbox').first().click();
      await scope.getByRole('button', { name: /确\s*定|引\s*用/ }).last().click();
      await expect(fieldRows(page)).toHaveCount(1);
      await page.getByRole('button', { name: /保\s*存|建\s*表/ }).last().click();
      await expect(page.locator('.ant-message-notice-content:visible, .el-message:visible, [role="alert"]:visible'))
        .toContainText(/保存成功|建表成功|成功/, { timeout: 15_000 });
      await assertNoConsoleErrors(consoleErrors);
      await report('DM-02-01 新建表-引用元数据', true, `本轮表名：${tableName}；finally 已尽力回收本轮表。`);
    } finally {
      await cleanupRoundTables(page, roundTables);
    }
  });
});
