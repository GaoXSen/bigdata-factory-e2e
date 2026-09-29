/**
 * DM-08-02｜数据地图｜多数据库版本回滚（本轮 UUID 自建表收敛版）
 *
 * 设计变更（LOCAL-AI-20260915-004 任务 31，静态开发，不跑浏览器；
 * DS-PERM-77 20260922 清洁环境迁移收紧：补 finally 仅回收本轮资产）：
 * - 旧实现复用 DM-08-01 的共享夹具表 e2e_dm_query_fixture_v2：该夹具只保证“表存在”，
 *   不保证“存在一个以上版本”。已知业务事实是“回滚按钮只有表存在一个以上版本时才能
 *   点击”，旧实现会在单版本状态下仍遍历寻找可点击的“回滚”按钮，属于设计缺陷。
 * - 新流程只操作本轮 UUID 自建表，不依赖、不编辑任何历史表或共享夹具：
 *   1) 表管理“新建表”split-button 下拉精确选择配置中心的公共 MySQL 数据源
 *      （dataSourceNames.tableManagement）建表并上线（建表/上线链路复用已通过的 DM-03-02、DM-04-01 实现）；
 *   2) 上线态表提交编辑会被业务码 099999 拒绝，先下线，再从表管理行内「编辑」进入
 *      编辑页，做且仅做一次可观察编辑：表中文名称 V1→V2，经“建 表”提交
 *      POST /tableManage/updateTable（HTTP 200 且业务码成功），制造第二版本；
 *   3) 重新上线后在表查询详情“版本列表”页签，用页面真实版本行断言至少两条版本；
 *      不足两条时抛出明确错误（环境/产品未能生成第二版本），不伪通过、不静默跳过；
 *   4) 选定非当前（旧）版本行的“回滚”按钮执行回滚（当前版本行按钮为禁用态，天然跳过）；
 *   5) 断言一（版本行证据）：被选目标版本行的“回滚”按钮翻转为禁用（已成为当前版本）；
 *   6) 断言二（回显字段证据）：重新打开表查询详情，基础信息回显恢复旧值 V1，
 *      且不再包含编辑后的 V2；不依赖 URL/toast 单一证据。
 * - 新建表下拉缺少公共 MySQL 数据源属于环境前置不足：按 DM-03-02/DM-04-01 约定
 *   显式 skip 并在报告中写明原因。
 * - 本轮 UUID 测试表落在公共配置主库（databases.primary.database）；DS-PERM-77（20260922）
 *   起 finally 仅回收本轮资产：物理 DROP（限定配置主库、仅本轮 UUID 表名）+ 元数据行内
 *   “下线/删除”尽力而为；DS-PERM-91（20260923）起清理失败完整收集并在用例结尾统一裁决
 *   上抛（主体成功而清理未完全成功须 fail，主体失败保留原失败并附清理证据），不再仅告警放行。
 */
import { test, expect, uuid, assertNoConsoleErrors, clickMenu, query, dbConfig } from '../utils.js';
import {
  chooseFirstOption,
  clickFormControlByLabel,
  clickVisible,
  fillFormField,
} from '../抽样用例工具.js';
import type { Locator, Page } from '@playwright/test';
import { testEnvironment } from '../../../test-environment.js';

/** 公共 MySQL 测试库数据源：本轮唯一允许新建物理表的目标数据源（配置中心 tableManagement，DM-04-01 精确匹配约定）。 */
const MYSQL_SOURCE_TEXT = testEnvironment.dataSourceNames.tableManagement.newDataBase;
/** 数据源必须精确命中公共配置源；宽松匹配实测会把表建到其它 MySQL 源。 */
const MYSQL_SOURCE_PATTERN = new RegExp(MYSQL_SOURCE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
/** 物理主库名（profile databases.primary.database），清理时 DROP 显式限定该库（DS-PERM-77）。 */
const PHYSICAL_DB_NAME =
  testEnvironment.databases.primary.database || testEnvironment.dataSourceNames.query.database;
const MAIN_CARD_SELECTOR = '.table-query .card:visible';
const TABLE_SEARCH_PLACEHOLDER = '按表名、中文名、描述、负责人搜索';

/** 兼容 Ant/Element/无障碍表格的数据行定位。 */
const fieldRows = (page: Page) => page.locator([
  'tbody > tr:visible',
  '.ant-table-tbody > tr:visible',
  '.el-table__body-wrapper tr:visible',
  '[role="row"]:visible:not(:has([role="columnheader"]))',
].join(', '));

// 详情页页签定位与展开兜底（DM-08-01 同页面族实现：溢出“更多”菜单 + 左右滚动）。
const TAB_SELECTORS = [
  '[role="tab"]:visible',
  '.ant-tabs-tab:visible',
  '.el-tabs__item:visible',
  '[class*="tab-item"]:visible',
].join(', ');
const TAB_OVERFLOW_SELECTORS = [
  '.ant-tabs-nav-more:visible',
  '.ant-tabs-dropdown-trigger:visible',
  '.el-tabs__more:visible',
  '.el-tabs__nav-more:visible',
  '[class*="tabs"][class*="more"]:visible',
  '[class*="tab"][class*="more"]:visible',
  '[aria-label*="更多"]:visible',
  '[title*="更多"]:visible',
].join(', ');
const TAB_CONTAINER_SELECTORS = [
  '[role="tablist"]:visible',
  '.ant-tabs-nav:visible',
  '.el-tabs__nav-wrap:visible',
  '.el-tabs__nav:visible',
  '.ant-tabs:visible',
  '.el-tabs:visible',
].join(', ');
const TAB_POPUP_SELECTORS = [
  '.ant-tabs-dropdown:visible .ant-tabs-dropdown-menu-item',
  '.ant-tabs-dropdown-menu:visible .ant-tabs-dropdown-menu-item',
  '.ant-dropdown:visible .ant-dropdown-menu-item',
  '.el-tabs__dropdown:visible .el-dropdown-menu__item',
  '.el-dropdown-menu:visible .el-dropdown-menu__item',
  '[role="menu"]:visible [role="menuitem"]',
  '[role="listbox"]:visible [role="option"]',
  '[role="menu"]:visible button',
  '[role="menu"]:visible a',
  '[role="menu"]:visible li',
].join(', ');
const TAB_SCROLL_SELECTORS = [
  '[aria-label*="上一页" i]:visible',
  '[aria-label*="下一页" i]:visible',
  '[aria-label*="left" i]:visible',
  '[aria-label*="right" i]:visible',
  '[title*="上一页" i]:visible',
  '[title*="下一页" i]:visible',
  '[title*="left" i]:visible',
  '[title*="right" i]:visible',
  '[class*="prev"]:visible',
  '[class*="next"]:visible',
  '[class*="left"]:visible',
  '[class*="right"]:visible',
].join(', ');

// ---------------------------------------------------------------------------
// 页签定位（详情页“版本列表”页签可能折叠在“更多”或横向滚动区域内）
// ---------------------------------------------------------------------------

function matchesText(actual: string, expected: string | RegExp): boolean {
  const normalized = actual.replace(/\s+/g, ' ').trim();
  if (typeof expected === 'string') return normalized === expected;
  expected.lastIndex = 0;
  const matched = expected.test(normalized);
  expected.lastIndex = 0;
  return matched;
}

async function visibleLocators(locator: Locator): Promise<Locator[]> {
  const result: Locator[] = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) result.push(candidate);
  }
  return result;
}

async function findVisibleText(locator: Locator, expected: string | RegExp): Promise<Locator | undefined> {
  for (let index = await locator.count() - 1; index >= 0; index -= 1) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    if (matchesText(await candidate.innerText().catch(() => ''), expected)) return candidate;
  }
  return undefined;
}

async function findVisibleTab(page: Page, expected: string | RegExp): Promise<Locator | undefined> {
  const direct = await findVisibleText(page.locator(TAB_SELECTORS), expected);
  if (direct) return direct;
  const popup = await findVisibleText(page.locator(TAB_POPUP_SELECTORS), expected);
  if (popup) return popup;

  for (const container of await visibleLocators(page.locator(TAB_CONTAINER_SELECTORS))) {
    const nested = await findVisibleText(
      container.locator('button, a, li, span, [role="tab"], [role="option"], [class*="tab"]'),
      expected,
    );
    if (nested) return nested;
    // 某些版本的组件只给文字节点挂了可见样式，父级才是真正的点击区域；
    // 仅在页签容器内兜底，避免误点详情正文中的同名字段。
    const textFallback = await findVisibleText(container.getByText(expected, { exact: true }), expected);
    if (textFallback) return textFallback;
  }
  return undefined;
}

async function findVisibleTabOverflow(page: Page): Promise<Locator | undefined> {
  const direct = await findVisibleText(page.locator(TAB_OVERFLOW_SELECTORS), /./);
  if (direct) return direct;

  for (const container of await visibleLocators(page.locator(TAB_CONTAINER_SELECTORS))) {
    const candidates = container.locator(
      '[class*="more"], [class*="More"], [aria-label*="更多"], [title*="更多"], ' +
      '[aria-label*="more" i], [title*="more" i], button, [role="button"], span, a',
    );
    for (let index = await candidates.count() - 1; index >= 0; index -= 1) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const metadata = [
        await candidate.getAttribute('class'),
        await candidate.getAttribute('aria-label'),
        await candidate.getAttribute('title'),
        await candidate.innerText().catch(() => ''),
      ].filter(Boolean).join(' ');
      if (/(?:more|更多|\.\.\.|…|···)/i.test(metadata)) return candidate;
    }
  }
  return undefined;
}

async function findVisibleTabScroller(page: Page): Promise<Locator | undefined> {
  for (const container of await visibleLocators(page.locator(TAB_CONTAINER_SELECTORS))) {
    const candidates = container.locator(TAB_SCROLL_SELECTORS);
    for (let index = await candidates.count() - 1; index >= 0; index -= 1) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const metadata = [
        await candidate.getAttribute('class'),
        await candidate.getAttribute('aria-label'),
        await candidate.getAttribute('title'),
        await candidate.innerText().catch(() => ''),
      ].filter(Boolean).join(' ');
      if (/(?:next|right|下一页|nav-operations)/i.test(metadata)) return candidate;
    }
  }
  return undefined;
}

async function clickVisibleTab(page: Page, expected: string | RegExp): Promise<void> {
  const deadline = Date.now() + 10_000;
  let overflowOpened = false;
  while (Date.now() < deadline) {
    const tab = await findVisibleTab(page, expected);
    if (tab) {
      await tab.click();
      await page.waitForTimeout(250);
      return;
    }
    if (!overflowOpened) {
      const overflow = await findVisibleTabOverflow(page);
      if (overflow) {
        await overflow.click();
        overflowOpened = true;
        await page.waitForTimeout(300);
        continue;
      }
    }
    // 横向页签也可能通过左右箭头滚动，而不是提供“更多”菜单；
    // 每轮只推进一次，推进后重新查找目标页签，避免固定取第一个同名节点。
    const scroller = await findVisibleTabScroller(page);
    if (scroller) {
      await scroller.click();
      await page.waitForTimeout(250);
      continue;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`详情页未找到可见页签“${expected}”，当前页面：${page.url()}`);
}

// ---------------------------------------------------------------------------
// 表管理：导航 / 新建表入口（精确公共 MySQL 源）
// ---------------------------------------------------------------------------

async function openTableManage(page: Page): Promise<void> {
  // 登录后默认停在“数据接入→数据源管理”，直接 goto 数据地图 hash 只改地址不重挂
  // 组件；先走真实菜单切换，失败时带一次性 query 参数做完整文档导航兜底
  // （DM-03-02/DM-04-01 20260915 通过轮页面实况）。
  try {
    await clickMenu(page, '数据地图', '表管理');
  } catch {
    const freshRoute = new URL(page.url().split('#')[0]);
    freshRoute.searchParams.set('e2e_table_manage', String(Date.now()));
    freshRoute.hash = '/dataMap/tableManage/tablesManage';
    await page.goto(freshRoute.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
  }
  // “表管理”拆为父路由与同名列表叶子；父路由只显示侧栏，必须展开后点击叶子。
  const parent = page.locator('a[href="#/dataMap/tableManage"]:visible').last();
  if (await parent.isVisible().catch(() => false)) await parent.click();
  const leaf = page.locator('a[href="#/dataMap/tableManage/tablesManage"]:visible').last();
  await expect(leaf, '表管理菜单没有渲染列表叶子页').toBeVisible({ timeout: 12_000 });
  await leaf.click();
  await expect(page).toHaveURL(/#\/dataMap\/tableManage\/tablesManage(?:\?|$)/, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: /新建表|新增表/ }).last()).toBeVisible({ timeout: 15_000 });
}

/** 在已展开的数据源下拉里精确匹配公共配置 MySQL 源（menuitem 与通用下拉兜底）。 */
async function findMysqlSourceOption(page: Page): Promise<Locator | undefined> {
  const menuitem = page.getByRole('menuitem', { name: MYSQL_SOURCE_PATTERN }).last();
  if (await menuitem.isVisible().catch(() => false)) return menuitem;
  const options = page.locator([
    '[role="listbox"]:visible [role="option"]',
    '.el-select-dropdown:visible .el-select-dropdown__item:visible',
    '.ant-select-dropdown:visible .ant-select-item-option:visible',
    '.ant-dropdown:visible li:visible',
    '.el-dropdown-menu:visible li:visible',
    '[role="menu"]:visible li:visible',
  ].join(', '));
  for (let index = await options.count() - 1; index >= 0; index -= 1) {
    const candidate = options.nth(index);
    const text = (await candidate.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (MYSQL_SOURCE_PATTERN.test(text)) return candidate;
  }
  return undefined;
}

/**
 * “新建表”split-button 第一次点击只展开数据源菜单；必须精确选择配置的公共 MySQL
 * 数据源（MYSQL_SOURCE_TEXT）才进入建表表单。下拉缺源按环境前置不足返回 false，
 * 由调用方显式 skip，不伪造通过（DM-03-02/DM-04-01 既有约定）。
 */
async function openCreateTableForMysql(page: Page): Promise<boolean> {
  const newTable = page.getByRole('button', { name: /^新建表/ }).last();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await newTable.click({ force: true });
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const source = await findMysqlSourceOption(page);
      if (source) {
        await source.click({ force: true });
        // 新版表单在数据库选中后先展示“语句添加”，再加载“保 存”按钮。
        await expect(page.getByText('语句添加', { exact: true }).last()).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole('button', { name: /保\s*存/ }).last()).toBeVisible({ timeout: 15_000 });
        return true;
      }
      await page.waitForTimeout(200);
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(300);
  }
  return false;
}

async function chooseFirstFormOption(page: Page, label: RegExp): Promise<void> {
  try {
    const control = await clickFormControlByLabel(page, label);
    await chooseFirstOption(page, control, String(label));
  } catch (error) {
    // schema、主题域和安全等级在当前环境可能是非必填且没有可选数据；
    // 不能把这些可选项误判成建表主流程失败，必填项仍继续抛错。
    if (/schema|主领域|主题域|安全等级/i.test(String(label))) return;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 表管理：行内上下线与编辑入口
// ---------------------------------------------------------------------------

async function manageRow(page: Page, tableName: string): Promise<Locator> {
  const filter = page.locator('input:visible:not([type="checkbox"]):not([type="radio"])').first();
  await filter.fill(tableName);
  const query = page.getByRole('button', { name: /查\s*询/ }).last();
  if (await query.isVisible().catch(() => false)) await query.click();
  const row = fieldRows(page).filter({ hasText: tableName }).first();
  await expect(row, `表管理未查询到本轮测试表“${tableName}”`).toBeVisible({ timeout: 15_000 });
  return row;
}

async function manageRowAction(page: Page, row: Locator, name: RegExp): Promise<Locator | undefined> {
  const selectors = 'button:visible, a:visible, .el-link:visible, [role="button"]:visible, [class*="link"]:visible, td:visible';
  for (const scope of [row.locator(selectors), page.locator(selectors)]) {
    for (let index = await scope.count() - 1; index >= 0; index -= 1) {
      const action = scope.nth(index);
      const text = (await action.innerText().catch(() => '')).replace(/\s+/g, ' ');
      name.lastIndex = 0;
      if (name.test(text) && (await action.isVisible().catch(() => false))) return action;
      name.lastIndex = 0;
    }
  }
  return undefined;
}

async function bringTableOnline(page: Page, tableName: string): Promise<void> {
  // 新建表默认“物理表存在&下线”；编辑提交后也会回到下线态。幂等：已上线时
  // 行内不存在「上线」操作，直接通过后续“「下线」重新出现”的判定。
  let row = await manageRow(page, tableName);
  const online = await manageRowAction(page, row, /^上\s*线$/);
  if (online) {
    await online.click();
    const dialog = page.getByRole('dialog').last();
    const confirm = (await dialog.isVisible().catch(() => false))
      ? dialog.getByRole('button', { name: /^确\s*定$/ }).last()
      : page.getByRole('button', { name: /^确\s*定$/ }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
  }
  await expect.poll(async () => {
    row = await manageRow(page, tableName);
    return (await manageRowAction(page, row, /^下\s*线$/)) ? 'online' : 'waiting';
  }, { timeout: 20_000 }).toBe('online');
}

/**
 * 表管理行内「下线」（DM-03-02 页面实况）：上线态表提交编辑会被业务码 099999
 * “表已上线不予许修改！！！”拒绝，编辑前必须先下线。以行内「上线」重新出现
 * 作为“当前已下线”的判定，确认弹窗存在则点“确定”。
 */
async function bringTableOffline(page: Page, tableName: string): Promise<void> {
  let row = await manageRow(page, tableName);
  const offline = await manageRowAction(page, row, /^下\s*线$/);
  if (offline) {
    await offline.click();
    const dialog = page.getByRole('dialog').last();
    const confirm = (await dialog.isVisible().catch(() => false))
      ? dialog.getByRole('button', { name: /^确\s*定$/ }).last()
      : page.getByRole('button', { name: /^确\s*定$/ }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
  }
  await expect.poll(async () => {
    row = await manageRow(page, tableName);
    return (await manageRowAction(page, row, /^上\s*线$/)) ? 'offline' : 'waiting';
  }, { timeout: 20_000 }).toBe('offline');
}

/**
 * 表管理行内「编辑」进入编辑页。目标表下线期间可能不出现在表查询，
 * 编辑入口固定使用表管理行内操作；行内文本未命中时回退到行内 edit 图标。
 */
async function openEditFromManageRow(page: Page, tableName: string): Promise<void> {
  const row = await manageRow(page, tableName);
  const editAction = (await manageRowAction(page, row, /^编\s*辑$/))
    ?? row.locator('[aria-label*="edit" i], [class*="edit" i]').filter({ visible: true }).last();
  if (!(await editAction.isVisible().catch(() => false))) {
    throw new Error(`表管理行内未找到「编辑」操作：${tableName}`);
  }
  await editAction.click();
  await expect(page.getByRole('tab', { name: /基本信息/ })).toBeVisible({ timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// 本轮自建资产清理（DS-PERM-77，20260922；口径同 DM-02-01 DS-PERM-63）：
// 仅回收本轮 UUID 自建表，物理 DROP 限定配置主库 + 元数据行内“下线/删除”
// 尽力而为；清理失败只告警，不掩埋用例真实结果，不触碰历史表或不明来源数据。
// ---------------------------------------------------------------------------

/** 仅合法 MySQL 标识符（≤64 字符）才可能是本轮真实物理表；非法名直接跳过物理回收。 */
function isDroppablePhysicalName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && name.length <= 64;
}

/** 尽力回收本轮物理表：DB 未配置与逐表 DROP 失败完整收集返回（不掩埋用例结果，DS-PERM-91）。 */
async function dropRoundPhysicalTables(names: string[]): Promise<string[]> {
  const dropErrors: string[] = [];
  const droppable = [...new Set(names)].filter(isDroppablePhysicalName);
  if (!droppable.length) return dropErrors;
  if (!dbConfig()) {
    const detail = `DB 未配置：本轮物理表未物理回收（${droppable.join(', ')}），元数据按 UUID 表名可追溯`;
    console.warn(`[cleanup] ${detail}。`);
    dropErrors.push(detail);
    return dropErrors;
  }
  for (const name of droppable) {
    const target = PHYSICAL_DB_NAME && isDroppablePhysicalName(PHYSICAL_DB_NAME)
      ? `\`${PHYSICAL_DB_NAME}\`.\`${name}\``
      : `\`${name}\``;
    try {
      await query(`DROP TABLE IF EXISTS ${target}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[cleanup] 本轮物理表 ${name} DROP 失败（尽力而为）：`, error);
      dropErrors.push(`物理表 ${name} DROP 失败：${message.slice(0, 240)}`);
    }
  }
  return dropErrors;
}

/** 行内“下线”尽力而为：上线状态可能拦截元数据删除，先恢复为可删除状态；失败收集返回，本函数不抛出（DS-PERM-91）。 */
async function bringRoundTableOfflineBestEffort(page: Page, tableName: string): Promise<string[]> {
  const offlineErrors: string[] = [];
  try {
    const row = await manageRow(page, tableName).catch(() => undefined);
    if (!row) {
      // 元数据行已不存在＝无可下线对象，视为已回收，不计失败。
      console.warn(`[cleanup] 表管理未查询到本轮表「${tableName}」，跳过下线（可能已被回收）。`);
      return offlineErrors;
    }
    const offline = await manageRowAction(page, row, /^下\s*线$/);
    if (offline) {
      await offline.click();
      const dialog = page.getByRole('dialog').last();
      const confirm = (await dialog.isVisible().catch(() => false))
        ? dialog.getByRole('button', { name: /^确\s*定$/ }).last()
        : page.getByRole('button', { name: /^确\s*定$/ }).last();
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
      await page.waitForTimeout(1_000);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[cleanup] 本轮表「${tableName}」下线失败（尽力而为）：`, error);
    offlineErrors.push(`表「${tableName}」下线失败：${message.slice(0, 240)}`);
  }
  return offlineErrors;
}

/** 元数据行内删除入口尽力而为：入口缺失或删除失败逐项收集返回（UUID 表名可追溯），本函数不抛出（DS-PERM-91）。 */
async function deleteRoundMetadataRowBestEffort(page: Page, tableName: string): Promise<string[]> {
  const deleteErrors: string[] = [];
  try {
    const row = await manageRow(page, tableName).catch(() => undefined);
    if (!row) return deleteErrors; // 已不存在视为本轮元数据回收完成。
    const action = await manageRowAction(page, row, /^删\s*除$|^移\s*除$/);
    if (!action) {
      const detail = `表管理未提供「${tableName}」行内删除/移除入口，元数据保留（UUID 可追溯）`;
      console.warn(`[cleanup] ${detail}。`);
      deleteErrors.push(detail);
      return deleteErrors;
    }
    await action.click();
    const dialog = page.getByRole('dialog').last();
    const confirm = (await dialog.isVisible().catch(() => false))
      ? dialog.getByRole('button', { name: /^确\s*定$/ }).last()
      : page.getByRole('button', { name: /^确\s*定$/ }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[cleanup] 本轮元数据「${tableName}」页面侧回收失败（尽力而为）：`, error);
    deleteErrors.push(`元数据「${tableName}」页面侧回收失败：${message.slice(0, 240)}`);
  }
  return deleteErrors;
}

/**
 * finally 专用：仅回收本轮 UUID 自建回滚表（物理表 + 元数据行内入口）。
 * DS-PERM-91：逐步尽力而为，任一项失败不中断其余步骤，失败完整收集并返回（本函数不抛出）；
 * 由用例结尾统一裁决——主体成功但清理未完全成功须 fail，主体失败保留原错误并附带清理证据。
 */
async function cleanupRoundRollbackTable(page: Page, tableName: string): Promise<string[]> {
  const cleanupErrors: string[] = [];
  if (!tableName) return cleanupErrors;
  try {
    cleanupErrors.push(...(await dropRoundPhysicalTables([tableName])));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[cleanup] 本轮物理表回收步骤异常（尽力而为）：', error);
    cleanupErrors.push(`物理表回收步骤异常：${message.slice(0, 240)}`);
  }
  try {
    await openTableManage(page);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[cleanup] 未回到表管理列表，跳过「${tableName}」元数据页面侧回收（UUID 可追溯）：`, error);
    cleanupErrors.push(`未回到表管理列表，「${tableName}」元数据页面侧回收未执行：${message.slice(0, 240)}`);
    return cleanupErrors;
  }
  cleanupErrors.push(...(await bringRoundTableOfflineBestEffort(page, tableName)));
  cleanupErrors.push(...(await deleteRoundMetadataRowBestEffort(page, tableName)));
  return cleanupErrors;
}

// ---------------------------------------------------------------------------
// 建表（DDL 语句添加）与一次可观察编辑（制造第二版本）
// ---------------------------------------------------------------------------

/**
 * 建本轮 UUID 表并上线（DM-03-02 通过轮实现）：必填项 + 数据生命周期一次性补齐，
 * “语句添加”录入 DDL、解析后补字段中文名，“建 表”提交跳回表管理列表。
 * chineseV1 即回滚目标旧值（回滚断言二使用）。
 */
async function createThisRoundTable(page: Page, tableName: string, chineseV1: string): Promise<void> {
  await fillFormField(page, /表名称|表名/, tableName);
  await fillFormField(page, /表中文名称|表中文名/, chineseV1);
  for (const label of [/数据层级/, /库.?层级/, /schema/i, /主领域|主题域/, /负责人/, /安全等级/]) {
    await chooseFirstFormOption(page, label);
  }
  // 数据生命周期等必填配置在建表时一次性补齐，编辑阶段再按需补选，
  // 避免“目标表生命周期为空、提交被校验拦截且无正向提示”的形态。
  await chooseFirstFormOption(page, /数据生命周期/);
  await chooseFirstFormOption(page, /操作类型/);
  const noConfirm = page.getByRole('radio', { name: '否', exact: true }).last();
  if (await noConfirm.isVisible().catch(() => false)) await noConfirm.check();

  await clickVisible(page, /语句添加/);
  const editor = page.locator('.monaco-editor:visible textarea').last();
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await editor.fill(`CREATE TABLE ${tableName} (id VARCHAR(64), name VARCHAR(128), remark VARCHAR(255))`);
  await page.getByRole('button', { name: /解\s*析|校\s*验/ }).last().click();
  // 解析接口异步更新字段表；用字段行出现作为成功信号。
  await expect.poll(() => fieldRows(page).count(), { timeout: 15_000 }).toBeGreaterThan(0);
  // DDL 解析已经给出真实字段类型；这里只补齐必填中文名，不重新选择类型。
  const chineseInputs = page.locator('input[placeholder*="字段中文"]:visible');
  for (let index = 0; index < await chineseInputs.count(); index += 1) {
    await chineseInputs.nth(index).fill(`字段${index + 1}`);
  }

  await page.getByRole('button', { name: /建\s*表/ }).last().click();
  await expect(page).toHaveURL(/#\/dataMap\/tableManage\/tablesManage(?:\?|$)/, { timeout: 15_000 });
  await bringTableOnline(page, tableName);
}

/** 读取表单项（label 所在控件行）的可见文本，用于判断下拉是否停留在占位符。 */
async function formItemText(page: Page, label: RegExp): Promise<string> {
  const labelNode = page.getByText(label).filter({ visible: true }).last();
  await expect(labelNode).toBeVisible({ timeout: 10_000 });
  const labelLength = (await labelNode.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().length;
  let scope: Locator = labelNode;
  for (let level = 0; level < 6; level += 1) {
    scope = scope.locator('..');
    const text = (await scope.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (text.length > labelLength) return text;
  }
  return '';
}

/**
 * 「数据生命周期配置」提交前补齐（编辑页实况）：该区块在编辑页不回显建表时的
 * 选择（combobox 为空且未标 *），空生命周期会被提交校验拦截。补选后核对
 * 不再停留在“请选择”，不吞异常。
 */
async function ensureLifecycleConfigured(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: '数据生命周期配置' })).toBeVisible({ timeout: 10_000 });
  const lifecycleLabels: Array<[RegExp, string]> = [
    [/数据生命周期/, '数据生命周期'],
    [/操作类型/, '操作类型'],
  ];
  for (const [pattern, label] of lifecycleLabels) {
    const before = await formItemText(page, pattern);
    if (!before || /请选择/.test(before)) {
      await chooseFirstFormOption(page, pattern);
    }
    const after = await formItemText(page, pattern);
    if (!after || /请选择/.test(after)) {
      throw new Error(`编辑页“${label}”补选后仍未生效（表单项文本：“${after}”）。`);
    }
  }
}

/**
 * 一次可观察编辑（制造第二版本）：仅修改表中文名称 V1→V2（详情页回显的硬证据
 * 字段），经“建 表”提交 POST /tableManage/updateTable。判定为 HTTP 200 且业务码
 * 成功（当前环境成功码 “000000”/“0”/数字 200；“保 存”只更新草稿，不是提交链路）。
 */
async function editChineseNameAndSubmit(page: Page, chineseV2: string): Promise<void> {
  await ensureLifecycleConfigured(page);

  const chineseInput = page.getByPlaceholder('请输入表中文名称', { exact: true }).last();
  await chineseInput.fill(chineseV2);
  await expect(chineseInput).toHaveValue(chineseV2);

  const submitted = page.waitForResponse(
    (response) => response.request().method() === 'POST' && /\/tableManage\/updateTable/.test(response.url()),
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: /^建\s*表$/ }).last().click();
  // 若“建 表”触发二次确认框则点“确定”；无弹窗时视为正常路径，继续等待提交接口。
  const confirmDialog = page.getByRole('dialog').last();
  if (await confirmDialog.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const confirmButton = confirmDialog.getByRole('button', { name: /^确\s*定$/ }).last();
    if (await confirmButton.isVisible().catch(() => false)) await confirmButton.click();
  }
  const response = await submitted;
  if (response.status() !== 200) {
    throw new Error(`编辑提交接口 /tableManage/updateTable 返回 HTTP ${response.status()}。`);
  }
  const body = await response.json().catch(() => null);
  if (body && typeof body === 'object' && 'code' in body) {
    const rawCode = (body as { code?: unknown }).code;
    const codeText = String(rawCode ?? '').trim();
    const numeric = Number(rawCode);
    const success = codeText === '000000' || codeText === '0'
      || (Number.isFinite(numeric) && numeric === 200);
    if (!success) {
      throw new Error(`编辑提交接口业务返回非成功（第二版本未被创建）：${JSON.stringify(body)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 表查询：卡片精确检索 / 详情打开
// ---------------------------------------------------------------------------

async function currentCards(page: Page): Promise<Locator[]> {
  return visibleLocators(page.locator(MAIN_CARD_SELECTOR));
}

/** 提交表查询搜索并等待卡片刷新；返回最终页面形态（cards/empty/loading）。 */
async function submitCardSearch(page: Page, keyword: string): Promise<'cards' | 'empty' | 'loading'> {
  const input = page.getByPlaceholder(TABLE_SEARCH_PLACEHOLDER).first();
  await input.fill(keyword);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  let status: 'cards' | 'empty' | 'loading' = 'loading';
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const cards = await currentCards(page);
    if (cards.length > 0) { status = 'cards'; break; }
    const empty = page.locator('.el-empty:visible, .ant-empty:visible, text=/暂无数据|没有找到|无数据/');
    if (await empty.first().isVisible().catch(() => false)) { status = 'empty'; break; }
    await page.waitForTimeout(500);
  }
  if (status === 'loading') {
    const cards = await currentCards(page);
    status = cards.length > 0 ? 'cards' : 'empty';
  }
  return status;
}

/** 精确匹配表名（.table-name 文本 === tableName），避免 uuid 前缀互相误命中。 */
async function exactCard(page: Page, tableName: string): Promise<Locator | undefined> {
  for (const card of await currentCards(page)) {
    const name = (await card.locator('.table-name:visible, [class*="table-name"]:visible').first()
      .innerText().catch(() => '')).trim();
    if (name === tableName) return card;
  }
  return undefined;
}

/** 上线后表查询索引可能延迟；在 30 秒窗口内重复检索，不能把刚上线的表误判为缺失。 */
async function requireExactCard(page: Page, tableName: string): Promise<Locator> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await submitCardSearch(page, tableName) === 'cards') {
      const card = await exactCard(page, tableName);
      if (card) return card;
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`等待 30 秒仍未在表查询中找到本轮测试表“${tableName}”。`);
}

/** 详情页由点击卡片上的表名节点触发（点击卡片容器不触发详情路由）。 */
async function openCard(page: Page, card: Locator): Promise<void> {
  const name = card.locator('.table-name:visible, [class*="table-name"]:visible').first();
  await expect(name).toBeVisible({ timeout: 10_000 });
  await name.click();
  await page.waitForTimeout(300);
  await expect(page.getByRole('heading', { name: '基础信息' })).toBeVisible({ timeout: 15_000 });
}

/** 数据地图内 hash 直跳表查询（同 SPA 家族内导航，DM-03-02 通过轮实现）。 */
async function openTableQueryLeaf(page: Page): Promise<void> {
  const baseUrl = page.url().split('#')[0];
  const route = `${baseUrl}#/dataMap/tableQuery/tablesQuery`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    if (!/#\/dataMap\/tableQuery(?:\/tablesQuery)?(?:\?|$)/.test(page.url())) continue;
    if (await page.locator('.table-query .search-bar, .table-query .card-list').first()
      .isVisible({ timeout: 5_000 }).catch(() => false)) return;
  }
  throw new Error(`数据地图“表查询”重试 3 次后仍未打开或未渲染，当前页面：${page.url()}`);
}

// ---------------------------------------------------------------------------
// 版本列表与回滚断言（页面真实版本行 + 详情回显双证据）
// ---------------------------------------------------------------------------

function activeDetailPanel(page: Page): Locator {
  // 组件会同时保留多个可见 tabpanel 空壳；当前内容面板是其中最后一个
  // 含有实际文本的面板，不能简单取所有可见节点的 last()。
  return page.locator('[role="tabpanel"]:visible').filter({ hasText: /\S/ }).last();
}

/** 定位“版本列表”表格的数据行（表头含“版本号”与“回滚/回退”）。 */
async function versionTableRows(page: Page): Promise<Locator | undefined> {
  const panel = activeDetailPanel(page);
  const tables = panel.locator('table:visible, [role="grid"]:visible');
  for (let index = await tables.count() - 1; index >= 0; index -= 1) {
    const table = tables.nth(index);
    const text = await table.innerText().catch(() => '');
    if (!/版本号/.test(text) || !/回\s*(?:滚|退)/.test(text)) continue;
    // 版本列表会把后续行渲染在滚动容器外；不能按 :visible 过滤，否则只计到首行。
    return table.locator('tbody > tr, [role="row"]:not(:has([role="columnheader"]))');
  }
  return undefined;
}

/**
 * 版本列表必须出现至少两条真实版本行。本用例在建表后已通过一次可观察编辑
 * 制造第二版本；若轮询窗口内仍不足两条，说明环境/产品未能生成第二版本，
 * 属于明确的前置失败：抛错而非伪通过、非静默跳过（回滚按钮在单版本下不可点击）。
 */
async function requireAtLeastTwoVersionRows(page: Page): Promise<Locator> {
  const deadline = Date.now() + 30_000;
  let observed = '版本列表表格尚未渲染';
  while (Date.now() < deadline) {
    const rows = await versionTableRows(page);
    if (rows) {
      const count = await rows.count();
      if (count >= 2) return rows;
      observed = `仅 ${count} 条版本行`;
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(
    `环境不可回滚：本轮自建表已完成一次可观察编辑，但版本列表仍不足两条（${observed}）。` +
    '回滚按钮只有表存在一个以上版本时才能点击，本用例拒绝在单版本状态下盲点回滚。',
  );
}

/**
 * 点击第一个可用（非禁用）的“回滚”按钮并返回其版本号。当前版本行的
 * “回滚”按钮为禁用态会被跳过；本轮表仅经历一次编辑，可回退目标即旧版本 V1。
 */
async function clickEnabledRollback(page: Page, rows: Locator): Promise<string> {
  let rollbackCount = 0;
  for (let rowIndex = 0; rowIndex < await rows.count(); rowIndex += 1) {
    const row = rows.nth(rowIndex);
    const actions = row.locator('button:visible, a:visible, [role="button"]:visible');
    for (let index = await actions.count() - 1; index >= 0; index -= 1) {
      const action = actions.nth(index);
      const metadata = [
        await action.innerText().catch(() => ''),
        await action.getAttribute('title'),
        await action.getAttribute('aria-label'),
      ].filter(Boolean).join(' ');
      if (!/回\s*(?:滚|退)/.test(metadata)) continue;
      rollbackCount += 1;
      const disabled = (await action.getAttribute('aria-disabled')) === 'true' ||
        !(await action.isEnabled().catch(() => false));
      if (disabled) continue;
      const version = (await row.innerText()).match(/^\s*(\d+(?:\.\d+)*)/)?.[1];
      if (!version) throw new Error(`无法从待回退版本行提取版本号：${await row.innerText()}`);
      await action.click();
      // 当前页面实现为点击即回退；若存在二次确认弹窗则点「确 定」。
      const confirmDialog = page.getByRole('dialog').last();
      if (await confirmDialog.isVisible({ timeout: 3_000 }).catch(() => false)) {
        const confirmButton = confirmDialog.getByRole('button', { name: /^确\s*定$/ }).last();
        if (await confirmButton.isVisible().catch(() => false)) await confirmButton.click();
      }
      return version;
    }
  }
  throw new Error(
    rollbackCount
      ? '版本列表已有多个版本，但所有“回滚”按钮均不可用。'
      : '版本列表中未找到“回滚”操作；请确认当前页面版本行已超过一个。',
  );
}

/** 断言一：指定版本号所在行的“回滚”按钮是否已翻转为禁用（已成为当前版本）。 */
async function isCurrentVersion(page: Page, version: string): Promise<boolean> {
  const rows = await versionTableRows(page);
  if (!rows) return false;
  const pattern = new RegExp(`^\\s*${version.replace(/\./g, '\\.')}(?:\\s|$)`);
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    if (!(await row.innerText().catch(() => '')).match(pattern)) continue;
    const rollback = row.getByRole('button', { name: /回\s*(?:滚|退)/ }).last();
    return (await rollback.getAttribute('aria-disabled')) === 'true' ||
      !(await rollback.isEnabled().catch(() => false));
  }
  return false;
}

/**
 * 断言二（回显字段硬证据，不依赖 URL/toast）：重新打开详情，基础信息必须回显
 * 回滚目标版本的旧中文名 V1，且不再包含编辑后的 V2。
 */
async function expectDetailEchoRestored(
  page: Page,
  tableName: string,
  chineseV1: string,
  chineseV2: string,
): Promise<void> {
  await openTableQueryLeaf(page);
  const card = await requireExactCard(page, tableName);
  await openCard(page, card);
  await expect.poll(async () => {
    const body = await page.locator('body').innerText().catch(() => '');
    return body.includes(chineseV1) ? 'restored' : 'waiting';
  }, { timeout: 30_000, intervals: [500, 1_000, 2_000] }).toBe('restored');
  const body = await page.locator('body').innerText().catch(() => '');
  if (body.includes(chineseV2)) {
    throw new Error(`回滚后详情回显未恢复旧值：页面仍包含编辑后中文名「${chineseV2}」。`);
  }
}

// ---------------------------------------------------------------------------
// 用例：本轮 UUID 自建表 → 一次可观察编辑制造第二版本 → 旧版本回滚 → 回显恢复
// ---------------------------------------------------------------------------

test.describe('DM-08-02｜数据地图｜版本回退', () => {
  test.describe.configure({ timeout: 480_000 });

  test('DM-08-02｜数据地图｜版本回退（本轮自建表制造第二版本）', async ({ loginPage, consoleErrors, report }, testInfo) => {
    const page = loginPage;
    const tableName = `e2e_dm_rollback_${uuid()}`;
    const chineseV1 = `回滚旧版_${uuid()}`;
    const chineseV2 = `回滚新版_${uuid()}`;
    // DS-PERM-77：新建表下拉缺源显式 skip 时未进入建表表单，本轮无资产、无需回收；
    // 一旦进入建表表单即登记回收（表未建成时 DROP IF EXISTS / 行检索均为无害空操作）。
    let roundTableCreated = false;
    // DS-PERM-91：先记录主体结果（mainFailed/mainError），finally 清理失败收集进
    // cleanupErrors；主体成功但清理未完全成功须 fail，主体失败保留原错误并附清理证据。
    let mainError: unknown;
    let mainFailed = false;
    const cleanupErrors: string[] = [];

    try {
      // 1. 表管理 + 新建表入口：精确选择公共 MySQL 数据源；缺源按环境前置不足显式跳过。
      await openTableManage(page);
      const entered = await openCreateTableForMysql(page);
      if (!entered) {
        await report('DM-08-02 版本回退（本轮自建表）', false,
          `环境前置缺失：新建表下拉未提供 MySQL 数据源（${MYSQL_SOURCE_TEXT}），无法创建本轮测试表，跳过。`);
        testInfo.skip();
        return;
      }
      roundTableCreated = true;

      // 2. 建本轮 UUID 表（中文名 V1 = 回滚目标旧值）并上线。
      await createThisRoundTable(page, tableName, chineseV1);

      // 3. 一次可观察编辑制造第二版本：上线态不允许修改，先下线；从表管理行内
      //    「编辑」进入，中文名 V1→V2 经“建 表”提交 updateTable（业务码成功），
      //    随后回表管理重新上线。
      await bringTableOffline(page, tableName);
      await openEditFromManageRow(page, tableName);
      await editChineseNameAndSubmit(page, chineseV2);
      await openTableManage(page);
      await bringTableOnline(page, tableName);

      // 4. 表查询详情“版本列表”页签：用页面真实版本行确认至少两条版本。
      await openTableQueryLeaf(page);
      const card = await requireExactCard(page, tableName);
      await openCard(page, card);
      await clickVisibleTab(page, /版本列表|版本信息/);
      const allVersionRows = await requireAtLeastTwoVersionRows(page);
      const versionCount = await allVersionRows.count();

      // 5. 选定非当前（旧）版本行的“回滚”执行回滚；当前版本行按钮禁用会被跳过。
      const rollbackVersion = await clickEnabledRollback(page, allVersionRows);

      // 6. 断言一（版本行证据）：目标版本行“回滚”按钮翻转为禁用（已成为当前版本）。
      await expect.poll(() => isCurrentVersion(page, rollbackVersion), { timeout: 20_000 }).toBe(true);

      // 7. 断言二（回显字段证据）：回滚可能把表置回下线态，先幂等恢复在线，
      //    再重新打开详情断言回显恢复旧值 V1 且不再包含 V2。
      await openTableManage(page);
      await bringTableOnline(page, tableName);
      await expectDetailEchoRestored(page, tableName, chineseV1, chineseV2);

      await assertNoConsoleErrors(consoleErrors);
      await report('DM-08-02 版本回退（本轮自建表）', true,
        `表=${tableName}（${MYSQL_SOURCE_TEXT} 本轮唯一新建，仅操作本轮 UUID 表）；`
        + `版本制造=建表 V1（中文名=${chineseV1}）+ 一次可观察编辑 V2（中文名=${chineseV2}，`
        + 'POST /tableManage/updateTable HTTP 200 业务码成功）；'
        + `版本列表=页面真实版本行 ${versionCount} 条（≥2 才允许回滚）；`
        + `回滚=选定非当前（旧）版本 ${rollbackVersion} 行内「回滚」；`
        + '断言一=该版本行「回滚」按钮翻转为禁用（已成为当前版本）；'
        + `断言二=详情回显恢复旧值「${chineseV1}」且不再包含「${chineseV2}」。`);
    } catch (error) {
      // DS-PERM-91：先记录主体错误（含 testInfo.skip 的跳过错误，重抛同一实例保留 skip
      // 判定），finally 清理完成后再统一裁决，避免清理异常掩埋主体失败。
      mainFailed = true;
      mainError = error;
    } finally {
      // DS-PERM-77/91：无论结果如何，仅回收本轮 UUID 自建表（物理 DROP 限定配置主库 +
      // 元数据行内下线/删除尽力而为）；失败完整收集，不掩埋上方任何真实断言结果，
      // 也不触碰非本轮资产。
      if (roundTableCreated) {
        try {
          cleanupErrors.push(...(await cleanupRoundRollbackTable(page, tableName)));
        } catch (cleanupCrash) {
          // 清理流程自身异常也按清理失败收集，保证 finally 不抛出、不覆盖主体错误。
          const message = cleanupCrash instanceof Error ? cleanupCrash.message : String(cleanupCrash);
          console.error('[cleanup] 清理流程自身异常（按清理失败收集）：', cleanupCrash);
          cleanupErrors.push(`清理流程自身异常：${message.slice(0, 240)}`);
        }
      }
    }
    // DS-PERM-91 统一裁决（口径同 DM-07-01 DS-PERM-89 / DM-09/10 DS-PERM-86 已验收
    // scoped-cleanup）：主体失败优先抛出并附带清理未完成说明（仅追加 message，不改变
    // 错误类型，保留 testInfo.skip 的 skip 判定）；主体通过但清理未完全成功也如实上抛，
    // 不伪造通过、不再仅告警放行。
    if (mainFailed) {
      const note = cleanupErrors.length > 0
        ? `（另：本轮清理未完全成功：${cleanupErrors.join('；').slice(0, 600)}）`
        : '';
      if (mainError instanceof Error) mainError.message += note;
      throw mainError;
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        `DM-08-02 主体通过，但本轮 UUID 自建表清理未完全成功（如实上报；待人工复核本轮 UUID 表：${tableName}）：`
          + cleanupErrors.join('；'),
      );
    }
  });
});







