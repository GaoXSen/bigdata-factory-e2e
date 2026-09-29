import { test, expect, dbConfig, query, uuid, clickMenu } from '../utils.js';
import type { Locator, Page, Response } from '@playwright/test';
import {
  assertNoUnexpectedLineageConsoleErrors,
  clickLineageTab,
  openTableLineage,
  visibleLineageControl,
} from './血缘测试工具.js';
import { testEnvironment } from '../../../test-environment.js';

/**
 * DM-07-02｜数据地图｜人工编辑血缘、重复关系和无效节点
 *
 * 证据来源：
 * - 录制草稿 e2e/录制草稿/数据血缘/DM-01-02-…-编辑血缘(.spec.ts) 与 …-编辑血缘-删除(.spec.ts)：
 *   “编辑血缘 → 图标: plus 添加上游 → 手填表名 → 输入上游表名 → 确定 → 草稿行出现”，
 *   删除走“行内 .delete-icon → 请输入删除理由 → 确 定”。
 * - BL-01-02（当前多次通过）：选择表弹窗默认“从目录选择”，需点击“手填表名”标签后才渲染输入框。
 * - 编辑页快照：表级关系表格列（#、上游表、下游表、操作），按钮“应 用”“返回图谱”。
 *
 * 隔离与不落库约定（任务 23；20260920-110 改为 spec 本地准备；2026-09-23 DS-PERM-84
 * 清洁环境迁移：不再回退共享 0920 基线，表对完全本轮自建；DS-PERM-95 收口）：
 * - 表对完全本轮自建：源/目标表每轮唯一 UUID ASCII 命名（e2e_dm0702_src_/tgt_<uuid>，
 *   均落公共配置主库，MySQL 数据源取配置中心），不借历史血缘图/旧节点/旧任务/113 数据；
 *   DS-PERM-95 起表名不再接受 LINEAGE_DM0702_* 等环境变量覆盖，杜绝任何一轮指向历史/共享表。
 *   20260920-110 起：表对由本 spec 自行准备（默认状态页命中即“复用+补上线”仅为幂等
 *   兜底，UUID 命名下实际不会发生；缺失才本地新建，均落公共配置主库）——共享工具的
 *   searchManageRow 在 110 表管理页检索不到已建表、会把已存在表误判为不存在并重复建表
 *   （run-20260920-181310-553 接口 099999“表名重复”证据），共享工具禁改，故本地化；
 *   定位器复用 DM-04-01 20260920 通过轮实现。
 * - finally 仅回收本轮经页面新建的表（下线 + 元数据行内删除 + 物理 DROP，逐步尽力而
 *   为）。DS-PERM-95：清理失败完整收集并在用例结尾统一裁决——主体成功但清理未完全
 *   成功时聚合上抛使测试失败；主体失败时保留原错误并附带清理证据；不触碰任何业务表。
 * - 全程不点击“应 用”，最后“返回图谱”退出：草稿关系不提交，不覆盖任何任务调度 SQL/血缘基线。
 * - 手填表名弹窗（run-20260915-143343-001 / run-20260915-144055-131 实测）：首次打开为
 *   数据源类型/数据源/数据库/Schema/数据表 五字段自由输入表单；重开弹窗可能重置为
 *   “从目录选择”或以级联下拉形态渲染，脚本按 textbox/combobox 双形态自适应并校验单选状态。
 */
// 目标表每轮唯一新建后，需走“表管理直进详情 + 表查询回退”双路径并允许索引延迟；
// 240 秒足以覆盖建表对、上线、草稿增删和本轮回收，避免页面异常时空耗 10 分钟。
test.describe.configure({ timeout: 240_000 });


// ---------------------------------------------------------------------------
// 20260920-110 环境迁移：spec 本地夹具准备（不再走共享工具的建表/检索链路）
//
// 根因（本轮运行证据）：共享 血缘测试工具.ts 的 searchManageRow 靠 placeholder/
// 标签父链找“表名称”输入框，110 表管理页上无法命中（2026-09-15 起即有“建表保存
// 后仍检索不到”的记录），导致已存在的 dm0702 源表被判为不存在、重复建表被接口
// 099999“表名重复”拒绝（run-20260920-181310-553 [dm0702] 日志）；共享工具属于
// 禁改文件，故本 spec 用 DM-04-01 20260920 通过轮（27.8s PASSED）验证过的页面
// 定位自行准备 dm0702 表对：表管理“首个可见输入框=表名称筛选 + 查询”检索、
// 已存在则复用并补上线、缺失才新建（数据层级=应用数据层 + 库/层级=ADS，
// 物理表落公共配置主库）。
// ---------------------------------------------------------------------------

/** 配置中心解析的公共 MySQL 数据源显示名（dataSourceNames.tableManagement，环境重置只改配置）。 */
const MYSQL_SOURCE_TEXT = testEnvironment.dataSourceNames.tableManagement.newDataBase;
/** 显示名转义后的数据源匹配正则（口径同 DM-01-03/DM-09-01 已迁移用例）。 */
const MYSQL_SOURCE_PATTERN = new RegExp(MYSQL_SOURCE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
/** 物理主库名（profile databases.primary.database），用于建表后数据库列回显断言。 */
const PHYSICAL_DB_NAME =
  testEnvironment.databases.primary.database || testEnvironment.dataSourceNames.query.database;
const MANAGE_ROWS_SELECTOR = [
  'tbody > tr:visible',
  '.ant-table-tbody > tr:visible',
  '.el-table__body-wrapper tr:visible',
  '[role="row"]:visible:not(:has([role="columnheader"]))',
].join(', ');
const DROPDOWN_OPTIONS_SELECTOR = [
  '[role="listbox"]:visible [role="option"]:visible',
  '.el-select-dropdown:visible .el-select-dropdown__item:visible:not(.is-disabled)',
  '.el-select-dropdown:visible .el-select-dropdown-menu__item:visible',
  '.ant-select-dropdown:visible .ant-select-item-option:visible:not(.ant-select-item-option-disabled)',
  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item:visible',
  '.el-select-dropdown:visible li:visible',
  '.ant-select-dropdown:visible li:visible',
].join(', ');
const manageRows = (page: Page) => page.locator(MANAGE_ROWS_SELECTOR);

async function lastVisible(locator: Locator): Promise<Locator | undefined> {
  for (let index = await locator.count() - 1; index >= 0; index -= 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

async function visibleButton(page: Page, name: string | RegExp): Promise<Locator | undefined> {
  return lastVisible(page.getByRole('button', { name }));
}

/** 出现二次确认弹窗时点击「确 定」；未出现不阻塞（等待即返回）。 */
async function confirmDialogIfAny(page: Page, timeout = 2_000): Promise<void> {
  // 当前页面的上线确认既可能是标准 role=dialog，也可能是 Element 的
  // .el-message-box（没有 dialog role）。只找前者会让“上线”停在待确认状态，
  // 后续轮询反复点击同一行直至总超时。
  const dialog = page.locator('[role="dialog"]:visible, .el-message-box:visible, .ant-modal:visible').last();
  const confirm = dialog.getByRole('button', { name: /^确\s*定$/ }).last();
  if (await confirm.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false)) {
    await confirm.click({ force: true });
  }
}

async function openTableManage(page: Page): Promise<void> {
  // 先让统一菜单工具完成真实路径切换。当前前端在菜单收起/重绘时，后续再对
  // a[href] 父、子节点各点一次会命中一个已被卸载的链接，导致第二张新表无法创建。
  // 以“新建表”真实可见为完成标志；只有未就绪时才整文档导航兜底。
  try {
    await clickMenu(page, '数据地图', '表管理');
  } catch {
    // 继续走下方整文档导航兜底。
  }
  const isReady = async (): Promise<boolean> => !!(await visibleButton(page, /新建表|新增表/));
  if (!(await isReady())) {
    const freshRoute = new URL(page.url().split('#')[0]);
    freshRoute.searchParams.set('e2e_table_manage', String(Date.now()));
    freshRoute.hash = '/dataMap/tableManage/tablesManage';
    await page.goto(freshRoute.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
  }
  await expect.poll(async () => (
    (await visibleButton(page, /新建表|新增表/)) ? 'ready' : 'loading'
  ), { timeout: 15_000 }).toBe('ready');
}

async function waitForCreateFormReady(page: Page): Promise<void> {
  await expect(page.getByText('语句添加', { exact: true }).last()).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (
    (await visibleButton(page, /保\s*存/)) ? 'ready' : 'loading'
  ), { timeout: 15_000 }).toBe('ready');
}

/** 打开新建表表单并选择公共 MySQL 数据源；返回 false 表示环境缺源（调用方显式报错）。 */
async function openCreateTableForMysql(page: Page): Promise<boolean> {
  const newTable = await visibleButton(page, /新建表|新增表/);
  if (!newTable) throw new Error(`表管理页面没有「新建表」入口，当前页面：${page.url()}`);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await newTable.click({ force: true });
    if (await visibleButton(page, /保\s*存/)) return true;
    const menuItem = page.getByRole('menuitem', { name: MYSQL_SOURCE_PATTERN }).last();
    if (await menuItem.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false)) {
      await menuItem.click({ force: true });
      await waitForCreateFormReady(page);
      return true;
    }
    const options = page.locator(
      '.el-dropdown-menu:visible li:visible, .ant-dropdown-menu:visible li:visible, ' +
        '.ant-dropdown:visible [role="menuitem"]:visible, [role="listbox"]:visible [role="option"]:visible',
    );
    if (await options.first().waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
      let target: Locator | undefined;
      for (let index = await options.count() - 1; index >= 0; index -= 1) {
        const option = options.nth(index);
        if (!(await option.isVisible().catch(() => false))) continue;
        const text = (await option.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (!text || /取消|关闭|新建表/.test(text)) continue;
        if (MYSQL_SOURCE_PATTERN.test(text)) {
          target = option;
          break;
        }
      }
      if (target) {
        await target.click();
        await waitForCreateFormReady(page);
        return true;
      }
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(500);
  }
  return false;
}

async function controlForLabel(page: Page, label: string, selector: string): Promise<Locator> {
  const labels = page.getByText(new RegExp(`\\*?\\s*${label}\\s*[:：]?\\s*$`));
  for (let labelIndex = await labels.count() - 1; labelIndex >= 0; labelIndex -= 1) {
    const labelNode = labels.nth(labelIndex);
    if (!(await labelNode.isVisible().catch(() => false))) continue;
    let scope: Locator = labelNode;
    for (let level = 0; level < 8; level += 1) {
      const control = await lastVisible(scope.locator(selector));
      if (control) return control;
      scope = scope.locator('..');
    }
  }
  throw new Error(`新建表表单未找到「${label}」对应的 ${selector} 控件，当前页面：${page.url()}`);
}

async function fillRequiredInput(page: Page, label: string, value: string): Promise<void> {
  const input = await controlForLabel(page, label, 'input:visible');
  await input.fill(value);
  await input.blur();
  await expect(input).toHaveValue(value);
}

async function selectFirstByLabel(
  page: Page,
  label: string,
  opts: { lenient?: boolean; match?: RegExp } = {},
): Promise<boolean> {
  try {
    const control = await controlForLabel(
      page,
      label,
      '[role="combobox"]:visible, .ant-select:visible, .el-select:visible, select:visible',
    );
    const tag = await control.evaluate((element) => element.tagName.toLowerCase()).catch(() => '');
    if (tag === 'select') {
      const option = control.locator('option:not([disabled])').filter({ hasNotText: /请选择/ }).first();
      await control.selectOption({ label: (await option.innerText()).trim() });
      return true;
    }
    await control.click();
    const options = page.locator(DROPDOWN_OPTIONS_SELECTOR);
    for (let index = await options.count() - 1; index >= 0; index -= 1) {
      const option = options.nth(index);
      const text = (await option.innerText().catch(() => '')).trim();
      if (await option.isVisible().catch(() => false) && text && !/请选择|暂无|无数据/.test(text)) {
        if (opts.match && !opts.match.test(text)) continue;
        await option.click();
        await page.waitForTimeout(100);
        return true;
      }
    }
    throw new Error(opts.match ? `「${label}」没有匹配 ${opts.match} 的可选项。` : `「${label}」没有可选项。`);
  } catch (error) {
    if (opts.lenient) return false;
    throw error;
  }
}

/** 基础必填项；数据层级/库层级 精确匹配“应用数据层 + ADS”（物理库=配置主库 databases.primary.database，110 实测映射）。 */
async function fillCreateBasics(page: Page, tableName: string, chineseName: string): Promise<void> {
  await fillRequiredInput(page, '表名称', tableName);
  await fillRequiredInput(page, '表中文名称', chineseName);
  await selectFirstByLabel(page, '数据层级', { match: /^应用数据层$/ });
  await selectFirstByLabel(page, '库/层级', { match: /^ADS$/ });
  await selectFirstByLabel(page, 'schema', { lenient: true });
  await selectFirstByLabel(page, '主题域', { lenient: true });
  await selectFirstByLabel(page, '负责人');
  await selectFirstByLabel(page, '安全等级', { lenient: true });
  await selectFirstByLabel(page, '数据生命周期');
  await selectFirstByLabel(page, '操作类型');
  const noConfirm = page.getByRole('radio', { name: '否', exact: true }).last();
  if (await noConfirm.isVisible().catch(() => false)) await noConfirm.click();
  await selectFirstByLabel(page, '确认周期', { lenient: true });
  await selectFirstByLabel(page, '排除分区', { lenient: true });
}

/** 表管理筛选定位目标行（首个可见输入框=表名称筛选 + 查询，DM-04-01 通过轮同款）。 */
async function filterManageRow(page: Page, tableName: string, timeout = 15_000): Promise<Locator> {
  const filterInput = page.locator('input:visible:not([type="checkbox"]):not([type="radio"])').first();
  await expect(filterInput).toBeVisible({ timeout: 10_000 });
  await filterInput.fill(tableName);
  const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
  if (await queryButton.isVisible().catch(() => false)) await queryButton.click();
  const row = manageRows(page).filter({ hasText: tableName }).first();
  await expect(row, `表管理未查询到测试表「${tableName}」`).toBeVisible({ timeout });
  return row;
}

/**
 * 逐个状态页签筛选目标表（run-20260920-181310-553 证据：r1 的“保 存”已把
 * e2e_hn_lineage_dm0702_source_0920 写成记录，但默认状态页筛选不到；再建必被
 * 099999“表名重复”拒绝——与共享工具注释记载的 2026-09-15 行为一致）。
 * 找到返回行定位器；所有状态页都没有返回 undefined。
 */
async function filterManageRowAcrossTabs(page: Page, tableName: string): Promise<Locator | undefined> {
  const tabs = page.locator('[role="tab"]:visible, .ant-tabs-tab:visible, .el-tabs__item:visible');
  for (let index = await tabs.count() - 1; index >= 0; index -= 1) {
    const tab = tabs.nth(index);
    const label = (await tab.innerText().catch(() => '')).replace(/\s+/g, '');
    await tab.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(600);
    try {
      const found = await filterManageRow(page, tableName, 4_000);
      if (process.env.LINEAGE_DEBUG === '1') {
        console.log(`[dm0702][debug] 状态页签「${label}」筛选到表「${tableName}」`);
      }
      return found;
    } catch {
      if (process.env.LINEAGE_DEBUG === '1') {
        console.log(`[dm0702][debug] 状态页签「${label}」无表「${tableName}」`);
      }
    }
  }
  return undefined;
}

/** 行内操作定位（固定列布局一行拆多 table，行内未命中按全页可见操作兜底）。 */
async function rowAction(page: Page, row: Locator, name: RegExp): Promise<Locator | undefined> {
  const selectors = 'button:visible, a:visible, .el-link:visible, [role="button"]:visible, [class*="link"]:visible, td:visible';
  const inRow = row.locator(selectors);
  for (let index = await inRow.count() - 1; index >= 0; index -= 1) {
    const action = inRow.nth(index);
    const text = (await action.innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (name.test(text) && (await action.isVisible().catch(() => false))) return action;
  }
  // Element 固定列把“表名”和“操作”渲染到两张同步 table 中，目标行的 action
  // 不一定是 tableName 行的 DOM 后代。查询已把结果收窄为一条时，可用页面中唯一
  // 可见操作兜底；若有多个，绝不随机取最后一个“下线”并把其它表误判为当前表已上线。
  const candidates: Locator[] = [];
  const pageActions = page.locator(selectors);
  for (let index = 0; index < await pageActions.count(); index += 1) {
    const action = pageActions.nth(index);
    const text = (await action.innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (name.test(text) && (await action.isVisible().catch(() => false))) candidates.push(action);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** 上线（幂等）：已上线（行内出现「下线」）直接返回；复用表传 assertE2eTestDb=false。 */
async function bringTableOnline(
  page: Page,
  tableName: string,
  assertE2eTestDb = true,
): Promise<void> {
  // 初始定位：先默认状态页（已上线记录在此），未命中再全页签兜底一次。
  let row = await filterManageRow(page, tableName, 8_000).catch(() => undefined);
  if (!row) row = await filterManageRowAcrossTabs(page, tableName);
  if (!row) throw new Error(`表管理各状态页签都未查询到测试表「${tableName}」，无法执行上线。`);
  if (assertE2eTestDb) {
    // 本地新建的表必须落配置主库（databases.primary.database）：数据库列回显防数据源误选（DM-04-01 契约）。
    await expect(page.locator('body')).toContainText(PHYSICAL_DB_NAME, { timeout: 10_000 });
  }
  const online = await rowAction(page, row, /^上\s*线$/);
  if (online) {
    await online.scrollIntoViewIfNeeded().catch(() => undefined);
    await online.click({ force: true });
    await confirmDialogIfAny(page, 3_000);
  }
  // 轮询必须轻量：此前每轮走「默认页白等 15s + 全页签扫描」（单轮 20s+），上线一旦不
  // 收敛就把 30s 窗口越界拖到分钟级直至用例超时（dm0702-r5 实证：240s 全耗在轮询里）。
  // 上线成功后记录停留在「物理表存在」默认页签，故轮询只查默认页（3s 短超时），
  // 未命中才全页签兜底（限 2 次，防「查询」把激活页签重置后弄丢非默认页记录）。
  // 单轮 2-4s，45s deadline 的越界上界约 60s，不再有挂起式消耗。
  const trySettle = async (): Promise<boolean> => {
    row = await filterManageRow(page, tableName, 3_000).catch(() => undefined);
    if (!row) return false;
    if (await rowAction(page, row, /^下\s*线$/)) return true;
    const retry = await rowAction(page, row, /^上\s*线$/);
    if (retry) {
      await retry.scrollIntoViewIfNeeded().catch(() => undefined);
      await retry.click({ force: true });
      await confirmDialogIfAny(page, 3_000);
    }
    return false;
  };
  const deadline = Date.now() + 45_000;
  let fallbackScans = 0;
  while (Date.now() < deadline) {
    try {
      if (await trySettle()) return;
      if (!row && fallbackScans < 2) {
        fallbackScans += 1;
        row = await filterManageRowAcrossTabs(page, tableName);
        if (row) {
          if (await rowAction(page, row, /^下\s*线$/)) return;
          const retry = await rowAction(page, row, /^上\s*线$/);
          if (retry) {
            await retry.scrollIntoViewIfNeeded().catch(() => undefined);
            await retry.click({ force: true });
            await confirmDialogIfAny(page, 3_000);
          }
        }
      }
    } catch {
      // 列表刷新瞬间行可能未挂载，忽略本轮，下一轮重查。
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`等待 45 秒后表管理中「${tableName}」仍未上线（行内未出现「下线」操作）。`);
}

/** 新建一个最小字段行（e2e_id VARCHAR 64；血缘表对只需最小字段集，列序 DM-04-02 实测）。 */
async function addMinimalFieldRow(page: Page): Promise<void> {
  const rowsBefore = await manageRows(page).count();
  const addButton = await visibleButton(page, /直接添加字段|直接添加|添加字段|新增字段/);
  if (!addButton) throw new Error(`新建表页面没有「添加字段」入口，当前页面：${page.url()}`);
  await addButton.click();
  await expect.poll(async () => await manageRows(page).count(), { timeout: 10_000 })
    .toBeGreaterThan(rowsBefore);
  const row = manageRows(page).last();
  const nameInput = row.locator('input:visible').nth(0);
  await expect(nameInput).toBeVisible();
  await nameInput.fill('e2e_id');
  await nameInput.blur();
  await expect(nameInput).toHaveValue('e2e_id');
  const chineseInput = row.locator('input:visible').nth(1);
  await expect(chineseInput).toBeVisible();
  await chineseInput.fill('主键标识');
  await chineseInput.blur();
  const typeControl = row.locator(
    'select:visible, .ant-select:visible, .ant-select-selector:visible, .el-select:visible, ' +
      '[role="combobox"]:visible, input[placeholder*="类型"]:visible',
  ).first();
  await expect(typeControl).toBeVisible();
  const tag = await typeControl.evaluate((element) => element.tagName.toLowerCase()).catch(() => '');
  if (tag === 'select') {
    const byText = typeControl.locator('option:not([disabled])').filter({ hasText: /varchar/i }).first();
    const fallback = typeControl.locator('option:not([disabled])').filter({ hasNotText: /请选择/ }).first();
    const option = (await byText.count()) ? byText : fallback;
    await typeControl.selectOption({ label: (await option.innerText()).trim() });
  } else {
    await typeControl.click({ force: true });
    const searchInput = page.locator('.ant-select-search__field:visible, .el-select__input:visible').last();
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill('VARCHAR');
    } else {
      await page.keyboard.type('VARCHAR');
    }
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
  }
  const rowText = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ');
  if (!/varchar/i.test(rowText)) {
    throw new Error(`字段「e2e_id」数据类型录入后未回显 VARCHAR（当前行文本：${rowText.slice(0, 120)}）。`);
  }
  const lengthInput = row.locator('input[placeholder*="长度"], input[type="number"], [role="spinbutton"]').first();
  await expect(lengthInput).toBeVisible();
  await lengthInput.fill('64');
  await lengthInput.blur();
}

/** 「建 表」提交：成功契约=跳回表管理列表且新表出现在列表；失败附建表接口证据。 */
async function submitAndExpectTableCreated(page: Page, tableName: string): Promise<void> {
  const apiEvidence: string[] = [];
  const listener = (response: Response): void => {
    if (/createTable|tableManage/i.test(response.url())) {
      void response.text().then((body) => {
        apiEvidence.push(`${response.status()} ${response.url()} :: ${body.slice(0, 300)}`);
      }).catch(() => undefined);
    }
  };
  page.on('response', listener);
  try {
    const build = page.getByRole('button', { name: /^建\s*表$/ }).last();
    await build.scrollIntoViewIfNeeded().catch(() => undefined);
    await build.click();
    await confirmDialogIfAny(page, 2_000);
    await expect(page).toHaveURL(/#\/dataMap\/tableManage\/tablesManage(?:\?|$)/, { timeout: 20_000 });
    await expect(page.locator('body')).toContainText(tableName, { timeout: 15_000 });
  } catch (error) {
    await page.waitForTimeout(400);
    throw new Error(
      `「建 表」提交未跳回表管理列表（表 ${tableName}）。建表接口反馈：`
      + `${apiEvidence.join(' || ') || '未捕获到建表相关接口'}；原始错误：${String(error).slice(0, 200)}`,
    );
  } finally {
    page.off('response', listener);
  }
}

/**
 * 确保 dm0702 单表就绪（已上线、可被表查询检索），返回实际可用的表名：
 * 1) 只在默认状态页按表名筛选 → 命中（=已上线记录）即复用并补上线；
 * 2) 默认页未命中（含记录躺在草稿/下线页签、或确实不存在两种情形）→ 不再尝试
 *    “复用+上线”，直接用「固定名 + 本轮 uuid 尾缀」的唯一新名走本地新建链路。
 *    依据 dm0702-r5 实证（run-20260920-183442-703 超时快照）：草稿态记录的行内
 *    「上线」点击无效——确认后草稿(1) 计数不变、上线(0) 未增加，轮询永不收敛，
 *    240s 全部耗在重试里；而“唯一新名建表+上线”是 DM-04-01 通过轮（27.8s）与
 *    本用例 r3 建表链路验证过的可行路径。唯一新名彻底规避历史草稿/重复记录造成
 *    的 099999“表名重复”，且不删除/不改任何既有数据。
 */
async function ensureDm0702Table(
  page: Page,
  tableName: string,
  chineseName: string,
): Promise<string> {
  await openTableManage(page);
  const found = await filterManageRow(page, tableName, 8_000).catch(() => undefined);
  if (found) {
    // 默认状态页命中即已上线记录：补上线仅为幂等确认，不修改表结构/关系/数据。
    await bringTableOnline(page, tableName, false);
    return tableName;
  }
  const uniqueName = `${tableName}_${uuid().slice(0, 6)}`;
  const entered = await openCreateTableForMysql(page);
  if (!entered) {
    throw new Error(`环境前置缺失：新建表下拉未提供 MySQL 数据源（${MYSQL_SOURCE_TEXT}）。`);
  }
  await fillCreateBasics(page, uniqueName, chineseName);
  await addMinimalFieldRow(page);
  await submitAndExpectTableCreated(page, uniqueName);
  await bringTableOnline(page, uniqueName, true);
  return uniqueName;
}

/**
 * 从表管理直接进入详情并打开数据血缘。
 *
 * 新上线表进入“表查询”索引会有分钟级异步延迟，但表管理列表已经可进入同一个
 * 详情组件；人工编辑血缘无需等待检索索引。直接从本 spec 已验证的表管理行进入，
 * 避免把索引延迟错误归类为“血缘编辑前置缺失”。
 */
async function openDm0702LineageFromManage(page: Page, tableName: string): Promise<void> {
  await openTableManage(page);
  const row = await filterManageRow(page, tableName, 15_000);
  const name = await lastVisible(row.getByText(tableName, { exact: true }))
    ?? await lastVisible(row.locator('a:visible, [role="link"]:visible').filter({ hasText: tableName }))
    ?? await lastVisible(page.getByText(tableName, { exact: true }));
  if (!name) throw new Error(`表管理列表中未找到可点击的测试表名「${tableName}」。`);
  await name.click({ force: true });
  await expect(page.getByText('字段信息', { exact: true }).last(), '点击表名后未进入表详情').toBeVisible({ timeout: 15_000 });
  await clickLineageTab(page, /数据血缘/);
  await expect(await visibleLineageControl(page, /编辑血缘|人工编辑/), '数据血缘页未出现编辑入口').toBeVisible({ timeout: 12_000 });
}

/**
 * 等待表查询索引收录目标表（20260920-110 实测：新上线表要等索引延迟收录，
 * 01:03 轮自建表约 9 分钟后才可检索；openTableLineage 依赖表查询检索打开详情）。
 * 轮询直至卡片出现或超时；共享工具 openTableLineage 不改动，等待前置在用例侧完成。
 */
async function waitForQueryIndexed(page: Page, tableName: string, timeoutMs?: number): Promise<void> {
  const waitMs = timeoutMs ?? Number(process.env.QUERY_INDEX_WAIT_MS ?? 480_000);
  const searchBox = page.getByPlaceholder('按表名、中文名、描述、负责人搜索');
  const deadline = Date.now() + waitMs;
  let round = 0;
  while (Date.now() < deadline) {
    round += 1;
    try {
      await clickMenu(page, '数据地图', '表查询', '表查询');
      await expect(searchBox).toBeVisible({ timeout: 10_000 });
      await searchBox.fill(tableName);
      await searchBox.press('Enter');
      await page.waitForTimeout(2_500);
      if (await page.locator('.table-query .card:visible').filter({ hasText: tableName }).first()
        .isVisible().catch(() => false)) {
        if (process.env.LINEAGE_DEBUG === '1') {
          console.log(`[dm0702][debug] 表查询索引已收录「${tableName}」（第 ${round} 轮）`);
        }
        return;
      }
    } catch {
      // 导航或搜索瞬态失败，下一轮重试。
    }
    await page.waitForTimeout(15_000);
  }
  throw new Error(`等待 ${Math.round(waitMs / 1000)} 秒后表查询仍未收录「${tableName}」索引。`);
}


// ---------------- 本轮资产回收（DS-PERM-84：finally 仅清本轮新建表/任务/关系） ----------------

/** 仅合法 MySQL 标识符（≤64 字符）才可能是本轮自建物理表；非法名直接跳过物理回收。 */
function isDroppablePhysicalName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && name.length <= 64;
}

/** 尽力回收本轮物理表（dbConfig() 缺失或逐表 DROP 失败完整收集返回，不掩埋用例结果）。口径同 DM-03-02。 */
async function dropRoundPhysicalTables(names: string[]): Promise<string[]> {
  const dropErrors: string[] = [];
  const droppable = [...new Set(names)].filter(isDroppablePhysicalName);
  if (!droppable.length) return dropErrors;
  if (!dbConfig()) {
    const detail = `DB 未配置：本轮物理表未物理回收（${droppable.join(', ')}），元数据按 UUID 命名可追溯`;
    console.warn(`[dm0702][cleanup] ${detail}。`);
    dropErrors.push(detail);
    return dropErrors;
  }
  for (const name of droppable) {
    try {
      await query(`DROP TABLE IF EXISTS \`${name}\``);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[dm0702][cleanup] 本轮物理表 ${name} DROP 失败（尽力而为）：`, error);
      dropErrors.push(`物理表 ${name} DROP 失败：${message.slice(0, 240)}`);
    }
  }
  return dropErrors;
}

/** 尽力下线并删除本轮新建表的元数据行；失败完整收集返回（本函数不抛出，UUID 命名可追溯）。 */
async function takeRoundTablesOfflineAndDelete(page: Page, names: string[], runTag: string): Promise<string[]> {
  const stepErrors: string[] = [];
  for (const name of new Set(names)) {
    // 下线（尽力而为）：删除入口通常只对非上线记录开放。
    try {
      await openTableManage(page);
      const offlineRow = await filterManageRow(page, name, 4_000).catch(() => undefined)
        ?? await filterManageRowAcrossTabs(page, name).catch(() => undefined);
      if (offlineRow) {
        const offline = await rowAction(page, offlineRow, /^下\s*线$/);
        if (offline) {
          await offline.click({ force: true });
          await confirmDialogIfAny(page, 3_000);
          await page.waitForTimeout(1_000);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[dm0702][cleanup] 本轮表“${name}”下线尝试失败（尽力而为）：`, error);
      stepErrors.push(`表“${name}”下线尝试失败：${message.slice(0, 240)}`);
    }
    // 元数据行内删除（尽力而为）。
    try {
      await openTableManage(page);
      const row = await filterManageRow(page, name, 4_000).catch(() => undefined)
        ?? await filterManageRowAcrossTabs(page, name).catch(() => undefined);
      if (!row) continue; // 已不在列表＝无需回收
      const action = await rowAction(page, row, /^删\s*除$|^移\s*除$/);
      if (!action) {
        const detail = `表管理未提供“${name}”删除/移除入口，元数据保留（UUID 命名可追溯）`;
        console.warn(`[dm0702][cleanup] ${detail}。`);
        stepErrors.push(detail);
        continue;
      }
      await action.click({ force: true });
      const dialog = page.locator('[role="dialog"]:visible, .el-message-box:visible, .ant-modal:visible').last();
      if (await dialog.isVisible().catch(() => false)) {
        const reason = dialog.getByRole('textbox', { name: /删除理由|删除原因/ }).last();
        if (await reason.isVisible().catch(() => false)) await reason.fill(`e2e-dm0702-本轮清理-${runTag}`);
        const confirm = dialog.getByRole('button', { name: /^确\s*定$|^删\s*除$/ }).last();
        if (await confirm.isVisible().catch(() => false)) await confirm.click({ force: true });
      }
      await page.waitForTimeout(800);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[dm0702][cleanup] 本轮元数据“${name}”删除失败（尽力而为）：`, error);
      stepErrors.push(`元数据“${name}”页面侧回收失败：${message.slice(0, 240)}`);
    }
  }
  return stepErrors;
}

/**
 * finally 专用：仅回收本轮经页面新建表（下线 + 元数据行内删除 + 物理 DROP）。
 * DS-PERM-95：逐步尽力而为，任一项失败不中断其余步骤，失败完整收集并返回（本函数
 * 不抛出）；由用例结尾统一裁决——主体成功但清理未完全成功须 fail，主体失败保留原
 * 错误并附带清理证据。只按本轮 UUID 表名回收，不扩大匹配范围、不触碰非本轮对象。
 */
async function cleanupRoundTables(page: Page, names: string[], runTag: string): Promise<string[]> {
  const cleanupErrors: string[] = [];
  if (!names.length) return cleanupErrors;
  try {
    cleanupErrors.push(...(await takeRoundTablesOfflineAndDelete(page, names, runTag)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[dm0702][cleanup] 本轮下线/元数据回收步骤异常（尽力而为）：', error);
    cleanupErrors.push(`下线/元数据回收步骤异常：${message.slice(0, 240)}`);
  }
  try {
    cleanupErrors.push(...(await dropRoundPhysicalTables(names)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[dm0702][cleanup] 本轮物理表回收步骤异常（尽力而为）：', error);
    cleanupErrors.push(`物理表回收步骤异常：${message.slice(0, 240)}`);
  }
  return cleanupErrors;
}


test('DM-07-02｜数据地图｜人工编辑血缘、重复关系和无效节点', async ({ loginPage, consoleErrors, report }) => {
  const page = loginPage;
  test.setTimeout(240_000);
  const runTag = uuid();
  const notes: string[] = [];
  // DS-PERM-95：仅回收“本轮经页面新建”的表；ensureDm0702Table 的复用命中（幂等
  // 兜底，UUID 命名下实际不会发生）不登记、不回收。
  const createdTables: string[] = [];

  // 前置：准备本轮唯一 UUID ASCII 表对（缺失时经表管理建最小表并上线，不改任何
  // 业务表）。建表/上线权限不足等前置失败按仓库规则显式 skip 并写明原因，不伪造
  // 通过；不再回退共享 0920 基线（DS-PERM-84：人工编辑的表/关系均须本轮自建，
  // 不借历史血缘图/旧节点/旧任务/113 数据）。DS-PERM-95 收口：表名不再接受
  // LINEAGE_DM0702_* 等环境变量覆盖，任何一轮都只使用本轮 UUID ASCII 新建表。
  let sourceTable = `e2e_dm0702_src_${runTag.slice(0, 6)}`;
  let targetTable = `e2e_dm0702_tgt_${runTag.slice(0, 6)}`;
  // ensureDm0702Table 命中复用时原样返回请求名；新建时返回“请求名_uuid 尾缀”。
  const requestedSource = sourceTable;
  const requestedTarget = targetTable;

  // DS-PERM-95：先记录主体结果（mainFailed/mainError），finally 清理失败收集进
  // cleanupErrors；主体成功但清理未完全成功须 fail，主体失败保留原错误并附清理证据。
  let mainError: unknown;
  let mainFailed = false;
  const cleanupErrors: string[] = [];
  try {
    try {
      sourceTable = await ensureDm0702Table(page, requestedSource, 'MySQL血缘源表_dm0702');
      if (sourceTable !== requestedSource) createdTables.push(sourceTable);
      console.log(`[dm0702] source 表就绪：${sourceTable}`);
      targetTable = await ensureDm0702Table(page, requestedTarget, 'MySQL血缘目标表_dm0702');
      if (targetTable !== requestedTarget) createdTables.push(targetTable);
      console.log(`[dm0702] target 表就绪：${targetTable}`);
      notes.push(`本轮唯一表对就绪：${sourceTable} / ${targetTable}（均已上线）`);
    } catch (fixtureError) {
      // 诊断输出：list 报告器不展示 skip 原因，把前置失败直接打到运行日志。
      console.log(`[dm0702] 本轮唯一表对准备失败：${(fixtureError as Error).message}`);
      test.skip(true, `DM-07-02 前置失败：无法准备本轮唯一测试表对（${(fixtureError as Error).message}）。`
        + `请检查建表/上线权限与配置中心 MySQL 数据源（${MYSQL_SOURCE_TEXT}）`);
    }

    // 首选表管理直进详情，规避新表索引延迟；部分旧版详情路由只展示“基本信息”而
    // 不挂血缘页签时，回退到表查询卡片进入的完整详情组件。两条路径都必须看见真实
    // 的“编辑血缘”入口，不能以 URL 或空白详情页假装成功。
    try {
      await openDm0702LineageFromManage(page, targetTable);
    } catch (manageDetailError) {
      try {
        await openTableLineage(page, targetTable, { requireGraph: false });
      } catch (queryDetailError) {
        throw new Error(
          `无法打开「${targetTable}」的数据血缘编辑页：表管理详情=${(manageDetailError as Error).message}；`
            + `表查询详情=${(queryDetailError as Error).message}`,
        );
      }
    }

    // 1) 人工编辑入口：进入编辑态并确认表级编辑页就绪（添加上游/添加下游/应用/返回图谱）。
    await (await visibleLineageControl(page, /编辑血缘|人工编辑/)).click();
    await expect.poll(async () => {
      const text = await page.locator('body').innerText().catch(() => '');
      return /添加上游|添加下游/.test(text) ? 'ready' : 'waiting';
    }, { timeout: 10_000 }).toBe('ready');
    await clickLineageTab(page, /表级/);
    await expect(await visibleLineageControl(page, /应\s*用/)).toBeVisible();
    await expect(await visibleLineageControl(page, /返回图谱/)).toBeVisible();

    // 草稿关系表行定位：只统计当前编辑页可见表格中包含指定表名的行。
    // 行数断言全部采用“相对基线”口径：即使表格渲染固定列导致行 DOM 复制，也不会误判。
    const draftRowWith = (tableName: string): Locator => page
      .locator('.ant-table-tbody:visible tr, .el-table__body-wrapper:visible tbody tr, table:visible tbody tr')
      .filter({ hasText: tableName });
    const baseline = await draftRowWith(sourceTable).count();
    if (baseline > 0) notes.push(`进入编辑页时已存在 ${baseline} 行含 ${sourceTable} 的关系（仅操作本轮新增草稿行）`);

    // 选择表弹窗与“手填表名”切换（BL-01-02 已验证模式：radio input 隐藏，点击标签文本）。
    const chooseTableDialog = () => page.locator('[role="dialog"]:visible, .ant-modal:visible, .el-dialog:visible').last();
    const collectMessage = async (label: string): Promise<void> => {
      const body = await page.locator('body').innerText().catch(() => '');
      const hit = body.split(/\n+/).find((line) => /不存在|无效|重复|已存在|失败|不能|无法|成功/.test(line));
      if (hit) notes.push(`${label}：${hit.trim().slice(0, 80)}`);
    };
    // 2026-09-15 run-20260915-143343-001 实测：当前版本“手填表名”为
    // 数据源类型/数据源/数据库/Schema/数据表 五字段表单（均必填），
    // 不再是录制草稿期的单一“输入上游表名”输入框；按页面实际结构定位。
    // 手填表名五字段默认值统一取自配置中心：QUERY_* 显示名族 + profile 主库物理库名，
    // 语义与原 process.env 回退链一致（配置中心已回填同名兼容变量），不再写死地址。
    const MANUAL_SOURCE_TYPE = testEnvironment.dataSourceNames.query.type;
    const MANUAL_SOURCE_NAME = testEnvironment.dataSourceNames.query.name;
    const MANUAL_SOURCE_DATABASE =
      testEnvironment.databases.primary.database || testEnvironment.dataSourceNames.query.database;
    const MANUAL_SOURCE_SCHEMA = testEnvironment.dataSourceNames.query.schema;
    const manualRadioChecked = async (dialog: Locator): Promise<boolean> => {
      const radio = dialog.getByRole('radio', { name: /手填表名/ }).last();
      if (!(await radio.isVisible().catch(() => false))) return false;
      // 该 radio 选中态不体现在自身 class（run-20260915-145305-872 快照：radio [checked] 但
      // class 无 is-checked，且无 label 祖先可查），直接读 DOM property checked 最可靠。
      const domChecked = await radio.evaluate((el) => {
        if (el instanceof HTMLInputElement && el.type === 'radio') return el.checked;
        return el.getAttribute('aria-checked') === 'true';
      }).catch(() => false);
      if (domChecked) return true;
      const cls = (await radio.getAttribute('class').catch(() => null)) ?? '';
      if (/is-checked|\bchecked\b/i.test(cls)) return true;
      const ancestorCls = await radio.evaluate(
        (el) => el.closest('label, .el-radio, [class*="radio"]')?.getAttribute('class') ?? '',
      ).catch(() => '');
      return /is-checked|\bchecked\b/i.test(ancestorCls ?? '');
    };
    // 选中“手填表名”单选：优先直点 radio 本体，文本兜底。快照（run-20260915-145305-872 /
    // run-20260915-145736-540）证明点击后 radio 确实 [checked][active]，但其选中态无法通过
    // class/aria-checked/property 稳定读取，故就绪以“手填表单出现”为准：
    // textbox 自由输入形态或级联 combobox 形态任一可见即视为切换成功。
    const switchToManualTableName = async (dialog: Locator): Promise<'textbox' | 'combobox'> => {
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      if (!(await manualRadioChecked(dialog))) {
        const radio = dialog.getByRole('radio', { name: /手填表名/ }).last();
        let clicked = false;
        try {
          await radio.click({ force: true, timeout: 3_000 });
          clicked = true;
        } catch {
          /* radio 本体不可命中时走文本兜底 */
        }
        if (!clicked) {
          await dialog.getByText('手填表名', { exact: true }).first()
            .click({ force: true, timeout: 3_000 }).catch(() => undefined);
        }
      }
      const tableTextbox = dialog.getByRole('textbox', { name: /请输入表名|输入上游表名/ }).last();
      const anyCombobox = dialog.getByRole('combobox').last();
      // 注意页面为 Ant Design Vue（run-20260915-150131-965 错误暴露 ant-input/ant-select-selection），
      // .or() 会在两形态并存时触发 strict violation，这里顺序等待。
      try {
        await tableTextbox.waitFor({ state: 'visible', timeout: 8_000 });
        return 'textbox';
      } catch {
        await expect(anyCombobox, '“手填表名”表单应出现（自由输入框或级联下拉）').toBeVisible({ timeout: 8_000 });
        return 'combobox';
      }
    };
    const closeDialog = async (dialog: Locator): Promise<void> => {
      const cancel = dialog.getByRole('button', { name: /取.*消/ }).last();
      if (await cancel.isVisible().catch(() => false)) {
        await cancel.click();
      } else {
        await page.keyboard.press('Escape');
      }
      await page.waitForTimeout(500);
    };
    const pickDropdownOption = async (optionRe: RegExp): Promise<boolean> => {
      await page.waitForTimeout(500);
      // 兼容 Ant Design Vue（ant-select-dropdown）与 Element UI（el-select-dropdown）两种下拉实现。
      const option = page.locator(
        '.ant-select-dropdown:visible .ant-select-dropdown-menu-item:visible, .ant-select-dropdown:visible li:visible, '
        + '.el-select-dropdown__item:visible, .el-select-dropdown:visible li:visible, '
        + '[role="listbox"]:visible [role="option"]:visible, .el-dropdown-menu:visible li:visible',
      ).filter({ hasText: optionRe }).first();
      if (await option.isVisible().catch(() => false)) {
        await option.click({ force: true });
        await page.waitForTimeout(500);
        return true;
      }
      return false;
    };
    // 打开“添加上游”弹窗；若上次弹窗残留（如数据源类型已有值导致字段联动为级联下拉），
    // 先取消再重开一次，尽量回到初始表单。
    const openUpstreamDialog = async (): Promise<Locator> => {
      const existing = chooseTableDialog();
      if (await existing.isVisible().catch(() => false)) await closeDialog(existing);
      await (await visibleLineageControl(page, /添加上游/)).click();
      const dialog = chooseTableDialog();
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(600);
      const typeCombo = dialog.getByRole('combobox').first();
      if ((await typeCombo.inputValue().catch(() => ''))?.trim()) {
        await closeDialog(dialog);
        await (await visibleLineageControl(page, /添加上游/)).click();
        await expect(dialog).toBeVisible({ timeout: 10_000 });
        await page.waitForTimeout(600);
      }
      return dialog;
    };
    const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const submitManualUpstream = async (tableName: string, label: string): Promise<void> => {
      const dialog = await openUpstreamDialog();
      const mode = await switchToManualTableName(dialog);
      if (mode === 'textbox') {
        // 自由输入形态（run-20260915-150131-965 快照）：数据源类型为必填 ant-select，
        // 其 role=combobox 命中的是 .ant-select-selection div（无 input 子节点，
        // inputValue 必然抛错），改读 innerText 判断是否已选；其余字段直接 fill。
        const typeCombo = dialog.getByRole('combobox').first();
        const typePicked = async (): Promise<boolean> => {
          const text = ((await typeCombo.innerText().catch(() => '')) || '').trim();
          return !!text && !/请选择/.test(text);
        };
        if ((await typeCombo.isVisible().catch(() => false)) && !(await typePicked())) {
          await typeCombo.click({ force: true }).catch(() => undefined);
          if (!(await pickDropdownOption(new RegExp(MANUAL_SOURCE_TYPE, 'i')))) {
            // 兜底：再点一次 .ant-select 根节点展开后重试（selection 内层 div 命中面小）。
            await dialog.locator('.ant-select').first().click({ force: true }).catch(() => undefined);
            if (!(await pickDropdownOption(new RegExp(MANUAL_SOURCE_TYPE, 'i')))) {
              notes.push(`数据源类型下拉未出现“${MANUAL_SOURCE_TYPE}”选项（该字段为必填，未选中时提交可能被表单校验拦截）`);
            }
          }
        }
        // 数据源/数据库/Schema 与 0831 宿主表对所在登记源一致（执行脚本 QUERY_* 默认值）。
        const sourceNameBox = dialog.getByRole('textbox', { name: /数据源名称/ }).last();
        if (await sourceNameBox.isVisible().catch(() => false)) await sourceNameBox.fill(MANUAL_SOURCE_NAME);
        const databaseBox = dialog.getByRole('textbox', { name: /数据库名称/ }).last();
        if (await databaseBox.isVisible().catch(() => false)) await databaseBox.fill(MANUAL_SOURCE_DATABASE);
        const schemaBox = dialog.getByRole('textbox', { name: /Schema/i }).last();
        if (await schemaBox.isVisible().catch(() => false)) await schemaBox.fill(MANUAL_SOURCE_SCHEMA);
        const tableBox = dialog.getByRole('textbox', { name: /请输入表名|输入上游表名/ }).last();
        await tableBox.fill(tableName);
      } else {
        // 级联下拉形态（run-20260915-144055-131 实测）：数据源类型→数据源→数据库→Schema→数据表
        // 逐级点选（顺序与弹窗标签一致）；数据源选项用配置显示名/主库名精确区分 sxzh_mas 干扰项（18F 教训）。
        const combos = dialog.getByRole('combobox');
        const cascade: ReadonlyArray<readonly [number, RegExp]> = [
          [0, new RegExp(MANUAL_SOURCE_TYPE, 'i')],
          [1, new RegExp(`${escapeRegExp(MANUAL_SOURCE_NAME)}|${escapeRegExp(MANUAL_SOURCE_DATABASE)}`, 'i')],
          [2, new RegExp(escapeRegExp(MANUAL_SOURCE_DATABASE), 'i')],
          [3, new RegExp(escapeRegExp(MANUAL_SOURCE_SCHEMA), 'i')],
        ];
        for (const [index, optionRe] of cascade) {
          const combo = combos.nth(index);
          if (!(await combo.isVisible().catch(() => false))) continue;
          if ((await combo.inputValue().catch(() => ''))?.trim()) continue; // 已有值跳过
          await combo.click({ force: true }).catch(() => undefined);
          if (!(await pickDropdownOption(optionRe))) {
            notes.push(`级联下拉第 ${index + 1} 项未匹配到选项（${optionRe}），保留当前值继续`);
          }
        }
        const tableCombo = combos.nth(4);
        if (!((await tableCombo.inputValue().catch(() => ''))?.trim())) {
          await tableCombo.click({ force: true }).catch(() => undefined);
          if (!(await pickDropdownOption(new RegExp(escapeRegExp(tableName), 'i')))) {
            throw new Error(`级联下拉中未找到数据表“${tableName}”（该形态仅能选择已登记的表）`);
          }
        }
      }
      await dialog.getByRole('button', { name: /确\s*定/ }).last().click();
      await page.waitForTimeout(1_500);
      await collectMessage(label);
      // 拦截类提交（无效节点/重复关系）弹窗可能保持打开，也可能自动关闭；统一收口避免影响后续行计数。
      if (await dialog.isVisible().catch(() => false)) await closeDialog(dialog);
    };

    // 2) 无效节点拦截：手填本轮 UUID 隔离的不存在表名，草稿表不得出现该行。
    //    任务 25F 允许两种结局：被页面拦截（硬断言 0 行），或明确记录产品实际语义
    //    （草稿阶段允许登记、应用时才校验）——后者如实记录证据，不伪造“被拦截”。
    const invalidTable = `e2e_dm0702_invalid_${runTag}`;
    const invalidBaseline = await draftRowWith(invalidTable).count();
    await submitManualUpstream(invalidTable, '无效节点提交反馈');
    let invalidBlocked = true;
    try {
      await expect.poll(() => draftRowWith(invalidTable).count(), { timeout: 5_000 }).toBe(invalidBaseline);
    } catch {
      invalidBlocked = false;
      notes.push(`无效节点 ${invalidTable} 提交后未被拦截：产品当前语义为草稿阶段允许登记不存在表`
        + `（草稿行数 ${await draftRowWith(invalidTable).count()}，未点击“应用”不会落库）`);
    }

    // 3) 人工新增草稿关系：上游=sourceTable → 下游=targetTable，草稿行必须同时包含两表名。
    await submitManualUpstream(sourceTable, '人工新增提交反馈');
    await expect.poll(() => draftRowWith(sourceTable).count(), { timeout: 10_000 }).toBeGreaterThan(baseline);
    const afterAdd = await draftRowWith(sourceTable).count();
    const addedRow = draftRowWith(sourceTable).filter({ hasText: targetTable }).last();
    await expect(addedRow, `草稿行应同时包含上游“${sourceTable}”与下游“${targetTable}”`).toBeVisible();

    // 4) 重复关系阻止：再次添加同一上游，含该表名的草稿行数不得增长。
    await submitManualUpstream(sourceTable, '重复关系提交反馈');
    await expect.poll(() => draftRowWith(sourceTable).count(), { timeout: 5_000 }).toBe(afterAdd);

    // 5) 人工删除草稿关系：行内删除图标 → 填写删除理由 → 确认，行数回落到基线。
    const deleteIcons = addedRow.locator('.delete-icon, [class*="delete"]');
    let deleteIcon: Locator | undefined;
    for (let index = await deleteIcons.count() - 1; index >= 0; index -= 1) {
      const candidate = deleteIcons.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        deleteIcon = candidate;
        break;
      }
    }
    if (!deleteIcon) throw new Error(`草稿行内未找到可见删除图标（行文本含 ${sourceTable}/${targetTable}）`);
    await deleteIcon.click();
    await page.waitForTimeout(1_000);
    const reasonDialog = chooseTableDialog();
    if (await reasonDialog.isVisible().catch(() => false)) {
      const reasonInput = reasonDialog.getByRole('textbox', { name: /删除理由|删除原因/ }).last();
      if (await reasonInput.isVisible().catch(() => false)) {
        await reasonInput.fill(`e2e-dm0702-删除草稿-${runTag}`);
      }
      const confirm = reasonDialog.getByRole('button', { name: /确\s*定|删\s*除/ }).last();
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
    }
    await expect.poll(() => draftRowWith(sourceTable).count(), { timeout: 10_000 }).toBe(baseline);

    // 6) 不点击“应 用”，直接“返回图谱”退出：草稿不落库，不覆盖共享任务调度 SQL/血缘基线。
    await (await visibleLineageControl(page, /返回图谱/)).click();
    await page.waitForTimeout(800);
    const exitDialog = chooseTableDialog();
    if (await exitDialog.isVisible().catch(() => false)) {
      const exitConfirm = exitDialog.getByRole('button', { name: /确\s*定|确\s*认|放\s*弃/ }).last();
      if (await exitConfirm.isVisible().catch(() => false)) await exitConfirm.click();
    }
    await expect(await visibleLineageControl(page, /编辑血缘|人工编辑/)).toBeVisible();

    await assertNoUnexpectedLineageConsoleErrors(consoleErrors);
    await report('数据地图-人工编辑血缘、重复关系和无效节点', true, [
      `独立夹具：${sourceTable} → ${targetTable}（基线行数 ${baseline}）`,
      invalidBlocked
        ? `无效节点 ${invalidTable} 被拦截（草稿 0 行）`
        : `无效节点 ${invalidTable} 未被拦截——产品实际语义：草稿阶段允许登记不存在表（已如实记录，未点击“应用”不落库）`,
      `人工新增草稿成功（含上游/下游表名，行数 ${baseline}→${afterAdd}）`,
      `重复添加同一上游被阻止（行数保持 ${afterAdd}）`,
      `人工删除草稿后行数回落 ${afterAdd}→${baseline}，未点击“应用”即退出，草稿未落库`,
      notes.length ? `页面反馈：${notes.join('；')}` : '页面未展示可捕获的拦截文案',
    ].join('；'));

  // 收尾（DS-PERM-84/95）：仅回收本轮经页面新建的表（下线 + 元数据行内删除 +
  // 物理 DROP），逐步尽力而为并完整收集失败，不掩埋用例真实结果，不触碰非本轮对象。
  } catch (error) {
    // DS-PERM-95：先记录主体错误，finally 清理完成后再统一裁决，避免清理异常掩埋主体失败。
    mainFailed = true;
    mainError = error;
  } finally {
    try {
      cleanupErrors.push(...(await cleanupRoundTables(page, createdTables, runTag)));
    } catch (cleanupCrash) {
      // 清理流程自身异常也按清理失败收集，保证 finally 不抛出、不覆盖主体错误。
      const message = cleanupCrash instanceof Error ? cleanupCrash.message : String(cleanupCrash);
      console.error('[dm0702][cleanup] 清理流程自身异常（按清理失败收集）：', cleanupCrash);
      cleanupErrors.push(`清理流程自身异常：${message.slice(0, 240)}`);
    }
  }
  // DS-PERM-95 统一裁决（口径同 DM-07-01 已验收 scoped-cleanup）：主体失败优先抛出
  // 并附带清理未完成说明（仅追加 message，不改变错误类型，保留 Playwright 对
  // test.skip 的 skip 判定）；主体通过但清理未完全成功也如实上抛，不伪造通过。
  if (mainFailed) {
    const note = cleanupErrors.length > 0
      ? `（另：本轮清理未完全成功：${cleanupErrors.join('；').slice(0, 600)}）`
      : '';
    if (mainError instanceof Error) mainError.message += note;
    throw mainError;
  }
  if (cleanupErrors.length > 0) {
    throw new Error(
      `DM-07-02 主体通过，但本轮自建资产清理未完全成功（如实上报；待人工复核本轮 UUID 表：${createdTables.join('、')}）：`
        + cleanupErrors.join('；'),
    );
  }
});
