/**
 * 数据地图 — 新建/编辑生成版本并查看版本列表 E2E 测试
 *
 * 页面实况：表查询主列表是 .table-query .card 卡片列表，不是 tbody 主表；
 * 详情页“版本列表”页签以“版本号 + 回滚”表格展示版本记录。
 * DS-PERM-77（20260922）清洁环境口径：版本创建、编辑、版本列表断言全部只绑定
 * 本轮经表管理“新建表”自建的唯一 UUID 表，不借历史表、历史版本或旧库记录；
 * finally 仅回收本轮自建表（物理 DROP + 元数据行内下线/删除；DS-PERM-91 起
 * 清理失败完整收集并在用例结尾统一裁决：主体成功而清理未完全成功须 fail，
 * 主体失败保留原失败并附清理证据，不再仅告警放行）；
 * 环境数据缺失时显式跳过，不以空数据假绿。
 */

import { test, expect, uuid } from '../utils.js';
import { assertNoConsoleErrors, clickMenu, query, dbConfig } from '../utils.js';
import type { Locator, Page, Response } from '@playwright/test';
import { testEnvironment } from '../../../test-environment.js';


// 实际页面的卡片有时直接挂在 card-list 下，有时中间还有一层布局容器；
// 统一按表查询区域内可见卡片取值，避免来源数据被布局层级误筛掉。
const MAIN_CARD_SELECTOR = '.table-query .card:visible';
const TABLE_SEARCH_PLACEHOLDER = '按表名、中文名、描述、负责人搜索';

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

function matchesText(actual: string, expected: string | RegExp): boolean {
  const normalized = actual.replace(/\s+/g, ' ').trim();
  if (typeof expected === 'string') return normalized === expected;
  expected.lastIndex = 0;
  const matched = expected.test(normalized);
  expected.lastIndex = 0;
  return matched;
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

    // 某些版本的组件只给文字节点挂了可见样式，父级才是真正的点击区域。
    // 仅在页签容器内兜底，避免误点详情正文中的同名字段。
    const textFallback = await findVisibleText(container.getByText(expected, { exact: true }), expected);
    if (textFallback) return textFallback;
  }
  return undefined;
}

async function visibleLocators(locator: Locator): Promise<Locator[]> {
  const result: Locator[] = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) result.push(candidate);
  }
  return result;
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

    // 横向页签也可能通过左右箭头滚动，而不是提供“更多”菜单。
    // 每轮只推进一次，推进后重新查找目标页签，避免固定取第一个同名节点。
    const scroller = await findVisibleTabScroller(page);
    if (scroller) {
      await scroller.click();
      await page.waitForTimeout(250);
      continue;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`详情页未找到可见页签“${expected}”，也未找到可展开的“更多”入口，当前页面：${page.url()}`);
}

async function findVisibleAction(page: Page, name: string | RegExp): Promise<Locator | undefined> {
  // 优先走 Playwright 的可访问名称查询，避免逐个读取 body 下上百个按钮的
  // innerText/属性；并发或页面动画期间，后者会把一次定位拖到全局超时。
  const roleButtons = page.getByRole('button', { name });
  for (let index = await roleButtons.count() - 1; index >= 0; index -= 1) {
    const button = roleButtons.nth(index);
    if (await button.isVisible().catch(() => false)) return button;
  }
  const roleLinks = page.getByRole('link', { name });
  for (let index = await roleLinks.count() - 1; index >= 0; index -= 1) {
    const link = roleLinks.nth(index);
    if (await link.isVisible().catch(() => false)) return link;
  }

  const roots = [
    activeDetailPanel(page),
    page.locator('body'),
  ];
  for (const root of roots) {
    const buttons = root.locator('button:visible, [role="button"]:visible, a:visible');
    for (let index = await buttons.count() - 1; index >= 0; index -= 1) {
      const button = buttons.nth(index);
      const metadata = [
        await button.innerText().catch(() => ''),
        await button.getAttribute('aria-label'),
        await button.getAttribute('title'),
      ].filter(Boolean).join(' ');
      if (await button.isVisible().catch(() => false) && matchesText(metadata, name)) return button;
    }
  }
  return undefined;
}

async function clickVisibleButton(page: Page, name: string | RegExp): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const button = await findVisibleAction(page, name);
    if (button) {
      await button.click();
      return;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`按钮“${name}”未找到可见节点，当前页面：${page.url()}`);
}

function skipForMissingEnvironment(message: string): never {
  throw new Error(`环境前置条件缺失：${message}`);
}

async function currentCards(page: Page): Promise<Locator[]> {
  return visibleLocators(page.locator(MAIN_CARD_SELECTOR));
}

async function submitCardSearch(page: Page, value: string): Promise<'cards' | 'empty'> {
  const search = page.getByPlaceholder(TABLE_SEARCH_PLACEHOLDER);
  await search.click();
  await search.fill('');
  // 页面同时存在 input/change 与 keyup.enter 两种实现；逐字输入并主动失焦，
  // 让两类页面都收到真实事件，避免只改了输入框值却仍展示上一页卡片。
  if (value) await search.pressSequentially(value, { delay: 10 });
  await search.press('Enter');
  await search.blur();
  const emptyStates = page.locator(
    '.table-query .ant-empty:visible, .table-query .el-empty:visible, ' +
    '.table-query [class*="empty"]:visible, .table-query p:visible',
  ).filter({ hasText: /暂无数据|没有数据|空空如也/ });
  await expect.poll(async () => {
    const cards = await currentCards(page);
    if (!value && cards.length > 0) return 'cards';
    // 当前版本的卡片外层不再带 .card class，但表名本身仍是可点击的可见
    // 节点。按精确表名确认结果，避免“界面已有结果却一直 loading”。
    if (value && await page.getByText(value, { exact: true }).filter({ visible: true }).last()
      .isVisible().catch(() => false)) return 'cards';
    if (await emptyStates.first().isVisible().catch(() => false)) return 'empty';
    // 对非空关键词，旧列表必须先消失后才算回车提交完成；否则会把
    // press('Enter') 后尚未刷新完的旧卡片误判成查询成功。
    if (value && cards.length === 0) return 'empty';
    return 'loading';
  }, { timeout: 10_000 }).toMatch(/cards|empty/);
  return (await currentCards(page)).length ? 'cards' : 'empty';
}

async function openCard(page: Page, card: Locator): Promise<void> {
  const name = card.locator('.table-name:visible, [class*="table-name"]:visible').first();
  await expect(name).toBeVisible();
  await name.click();
  await page.waitForTimeout(300);
  await expect(page.getByRole('heading', { name: '基础信息' })).toBeVisible();
}

async function openTableQueryLeaf(page: Page): Promise<void> {
  await clickMenu(page, '数据地图', '表查询', '表查询');
  await expect(page.locator('.table-query .search-bar, .table-query .card-list').first()).toBeVisible({ timeout: 15_000 });
}

function activeDetailPanel(page: Page): Locator {
  // 组件会同时保留多个可见 tabpanel 空壳；当前内容面板是其中最后一个
  // 含有实际文本的面板，不能简单取所有可见节点的 last()。
  return page.locator('[role="tabpanel"]:visible').filter({ hasText: /\S/ }).last();
}

async function requireVersionRow(page: Page): Promise<Locator> {
  const panel = activeDetailPanel(page);
  const emptyState = panel.locator(
    '.ant-empty:visible, .el-empty:visible, [class*="empty"]:visible, p:visible',
  ).filter({ hasText: /暂无数据|没有数据|空空如也/ }).first();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const missingTableId = page.getByText(/入参中的表id必填/i).last();
    if (await missingTableId.isVisible().catch(() => false)) {
      throw new Error('真实业务BUG：版本列表请求缺少 tableId，页面显示“入参中的表id必填”。');
    }
    if (await emptyState.isVisible().catch(() => false)) {
      skipForMissingEnvironment('当前测试表没有可用的目标版本记录，版本测试跳过。');
    }
    const tables = panel.locator('table:visible, [role="grid"]:visible');
    for (let index = await tables.count() - 1; index >= 0; index -= 1) {
      const table = tables.nth(index);
      const text = await table.innerText().catch(() => '');
      if (!/版本号/.test(text) || !/回\s*(?:滚|退)/.test(text)) continue;
      // 版本列表会把后续行渲染在滚动容器外；不能按 :visible 过滤，否则只计到首行。
      const rows = table.locator('tbody > tr, [role="row"]:not(:has([role="columnheader"]))');
      if (await rows.count()) return rows.first();
    }
    await page.waitForTimeout(250);
  }

  skipForMissingEnvironment('版本页签存在但没有可用的目标版本记录，版本测试跳过。');
}

async function versionTotalCount(page: Page): Promise<number> {
  const total = page.getByText(/总共\s*\d+\s*条/).last();
  await expect(total, '版本列表未显示版本总条数').toBeVisible({ timeout: 10_000 });
  const matched = (await total.innerText()).match(/(\d+)/);
  if (!matched) throw new Error(`无法从版本总条数中提取数字：${await total.innerText()}`);
  return Number(matched[1]);
}

// ---------------------------------------------------------------------------
// 20260920-110 环境迁移：共享版本夹具缺失时的本地保障（dm0702-r6 同款链路）。
//
// 证据：run-20260920-190019-450（r1）表管理默认页签搜索 e2e_dm_query_fixture_v2
// 15s 未命中；同日 12:34 轮该表曾可上线并走到编辑提交（updateTable 20s 超时），
// 提示编辑链路会把记录挪出默认状态页签（DM-07-02 run-20260920-181310-553 同款记载；
// 草稿/下线态行内「上线」已被 dm0702-r5 实证无效）。故默认页未命中时不复用不可控
// 状态记录，改用「固定名+本轮 uuid」唯一新名本地新建+上线（DM-04-01 27.8s /
// dm0702-r3、r6 验证路径，落公共配置主库），不删除/不改任何既有数据。
// 定位器与 DM-07-02 spec 本地实现一致（加 dm0801 前缀防与本文件既有函数重名）。
// ---------------------------------------------------------------------------
/** 配置中心解析的公共 MySQL 数据源显示名（dataSourceNames.tableManagement，环境重置只改配置）。 */
const MYSQL_SOURCE_TEXT = testEnvironment.dataSourceNames.tableManagement.newDataBase;
/** 显示名转义后的数据源匹配正则（口径同 DM-01-03/DM-09-01 已迁移用例）。 */
const DM0801_MYSQL_SOURCE_PATTERN = new RegExp(MYSQL_SOURCE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const DM0801_DROPDOWN_OPTIONS_SELECTOR = [
  '[role="listbox"]:visible [role="option"]:visible',
  '.el-select-dropdown:visible .el-select-dropdown__item:visible:not(.is-disabled)',
  '.ant-select-dropdown:visible .ant-select-item-option:visible:not(.ant-select-item-option-disabled)',
  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item:visible',
  '.el-select-dropdown:visible li:visible',
  '.ant-select-dropdown:visible li:visible',
].join(', ');

async function dm0801LastVisible(locator: Locator): Promise<Locator | undefined> {
  for (let index = await locator.count() - 1; index >= 0; index -= 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

async function dm0801VisibleButton(page: Page, name: string | RegExp): Promise<Locator | undefined> {
  return dm0801LastVisible(page.getByRole('button', { name }));
}

/** 出现二次确认弹窗时点击「确 定」；未出现不阻塞（等待即返回）。 */
async function dm0801ConfirmDialogIfAny(page: Page, timeout = 2_000): Promise<void> {
  const confirm = page.getByRole('dialog').last()
    .getByRole('button', { name: /^确\s*定$/ }).last();
  if (await confirm.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false)) {
    await confirm.click();
  }
}

async function dm0801OpenTableManage(page: Page): Promise<void> {
  // hash 直跳不重挂组件，必须真实菜单切换；菜单未挂载时带一次性 query 整文档导航
  // （DM-03-02/DM-04-01 20260915 通过轮既有兜底）。
  try {
    await clickMenu(page, '数据地图', '表管理');
  } catch {
    const freshRoute = new URL(page.url().split('#')[0]);
    freshRoute.searchParams.set('e2e_table_manage', String(Date.now()));
    freshRoute.hash = '/dataMap/tableManage/tablesManage';
    await page.goto(freshRoute.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
  }
  const parent = page.locator('a[href="#/dataMap/tableManage"]:visible').last();
  if (await parent.isVisible().catch(() => false)) await parent.click();
  const leaf = page.locator('a[href="#/dataMap/tableManage/tablesManage"]:visible').last();
  await expect(leaf, '表管理菜单没有渲染列表叶子页').toBeVisible({ timeout: 12_000 });
  await leaf.click();
  await expect.poll(async () => (
    (await dm0801VisibleButton(page, /新建表|新增表/)) ? 'ready' : 'loading'
  ), { timeout: 15_000 }).toBe('ready');
}

async function dm0801WaitForCreateFormReady(page: Page): Promise<void> {
  await expect(page.getByText('语句添加', { exact: true }).last()).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (
    (await dm0801VisibleButton(page, /保\s*存/)) ? 'ready' : 'loading'
  ), { timeout: 15_000 }).toBe('ready');
}


/** 打开新建表表单并选择公共 MySQL 数据源；返回 false 表示环境缺源（调用方显式报错）。 */
async function dm0801OpenCreateTableForMysql(page: Page): Promise<boolean> {
  const newTable = await dm0801VisibleButton(page, /新建表|新增表/);
  if (!newTable) throw new Error(`表管理页面没有「新建表」入口，当前页面：${page.url()}`);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await newTable.click({ force: true });
    if (await dm0801VisibleButton(page, /保\s*存/)) return true;
    const menuItem = page.getByRole('menuitem', { name: DM0801_MYSQL_SOURCE_PATTERN }).last();
    if (await menuItem.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false)) {
      await menuItem.click({ force: true });
      await dm0801WaitForCreateFormReady(page);
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
        if (DM0801_MYSQL_SOURCE_PATTERN.test(text)) {
          target = option;
          break;
        }
      }
      if (target) {
        await target.click();
        await dm0801WaitForCreateFormReady(page);
        return true;
      }
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(500);
  }
  return false;
}

async function dm0801ControlForLabel(page: Page, label: string, selector: string): Promise<Locator> {
  const labels = page.getByText(new RegExp(`\\*?\\s*${label}\\s*[:：]?\\s*$`));
  for (let labelIndex = await labels.count() - 1; labelIndex >= 0; labelIndex -= 1) {
    const labelNode = labels.nth(labelIndex);
    if (!(await labelNode.isVisible().catch(() => false))) continue;
    let scope: Locator = labelNode;
    for (let level = 0; level < 8; level += 1) {
      const control = await dm0801LastVisible(scope.locator(selector));
      if (control) return control;
      scope = scope.locator('..');
    }
  }
  throw new Error(`新建表表单未找到「${label}」对应的 ${selector} 控件，当前页面：${page.url()}`);
}

async function dm0801FillRequiredInput(page: Page, label: string, value: string): Promise<void> {
  const input = await dm0801ControlForLabel(page, label, 'input:visible');
  await input.fill(value);
  await input.blur();
  await expect(input).toHaveValue(value);
}

async function dm0801SelectFirstByLabel(
  page: Page,
  label: string,
  opts: { lenient?: boolean; match?: RegExp } = {},
): Promise<boolean> {
  try {
    const control = await dm0801ControlForLabel(
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
    const options = page.locator(DM0801_DROPDOWN_OPTIONS_SELECTOR);
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

/** 基础必填项；数据层级/库层级 精确匹配「应用数据层 + ADS」（物理库=配置中心主库 databases.primary.database，110 实测映射）。 */
async function dm0801FillCreateBasics(page: Page, tableName: string, chineseName: string): Promise<void> {
  await dm0801FillRequiredInput(page, '表名称', tableName);
  await dm0801FillRequiredInput(page, '表中文名称', chineseName);
  await dm0801SelectFirstByLabel(page, '数据层级', { match: /^应用数据层$/ });
  await dm0801SelectFirstByLabel(page, '库/层级', { match: /^ADS$/ });
  await dm0801SelectFirstByLabel(page, 'schema', { lenient: true });
  await dm0801SelectFirstByLabel(page, '主题域', { lenient: true });
  await dm0801SelectFirstByLabel(page, '负责人');
  await dm0801SelectFirstByLabel(page, '安全等级', { lenient: true });
  await dm0801SelectFirstByLabel(page, '数据生命周期');
  await dm0801SelectFirstByLabel(page, '操作类型');
  const noConfirm = page.getByRole('radio', { name: '否', exact: true }).last();
  if (await noConfirm.isVisible().catch(() => false)) await noConfirm.click();
  await dm0801SelectFirstByLabel(page, '确认周期', { lenient: true });
  await dm0801SelectFirstByLabel(page, '排除分区', { lenient: true });
}


/** 新建一个最小字段行（e2e_id VARCHAR 64；列序 DM-04-02 实测）。 */
async function dm0801AddMinimalFieldRow(page: Page): Promise<void> {
  const rowsBefore = await manageRows(page).count();
  const addButton = await dm0801VisibleButton(page, /直接添加字段|直接添加|添加字段|新增字段/);
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
  const rowText = await row.innerText();
  if (!/varchar/i.test(rowText)) {
    throw new Error(`字段「e2e_id」数据类型录入后未回显 VARCHAR（当前行文本：${rowText.slice(0, 120)}）。`);
  }
  const lengthInput = row.locator('input[placeholder*="长度"], input[type="number"], [role="spinbutton"]').first();
  await expect(lengthInput).toBeVisible();
  await lengthInput.fill('64');
  await lengthInput.blur();
}

/** 「建 表」提交：成功契约=跳回表管理列表且新表出现在列表；失败附建表接口证据。 */
async function dm0801SubmitCreateTable(page: Page, tableName: string): Promise<void> {
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
    await dm0801ConfirmDialogIfAny(page, 2_000);
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

/** 上线（幂等，dm0702-r6 同款轻量轮询）：行内出现「下线」即视为已上线收敛。 */
async function dm0801BringOnline(page: Page, tableName: string): Promise<void> {
  const trySettle = async (): Promise<boolean> => {
    const row = await manageFixtureRow(page, tableName, 3_000).catch(() => undefined);
    if (!row) return false;
    if (await manageRowAction(page, row, /^下\s*线$/).catch(() => undefined)) return true;
    const retry = await manageRowAction(page, row, /^上\s*线$/).catch(() => undefined);
    if (retry) {
      await retry.click();
      await dm0801ConfirmDialogIfAny(page, 3_000);
    }
    return false;
  };
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      if (await trySettle()) return;
    } catch {
      // 列表刷新瞬间行可能未挂载，忽略本轮，下一轮重查。
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`等待 45 秒后表管理中「${tableName}」仍未上线（行内未出现「下线」操作）。`);
}

/**
 * 确保版本夹具表就绪（已上线、可被表查询检索）：表名由调用方给定的本轮唯一
 * UUID ASCII 名（e2e_dm_version_<uuid>，DS-PERM-77 起不再派生自任何历史夹具名）
 * 经表管理“新建表”本地新建 + 上线，不复用、不检索任何既有记录。
 *
 * 不复用的决定性依据（20260920）：共享夹具 e2e_dm_query_fixture_v2
 * （tableId=6a98e5c2e4b0517ed7ae3ffe）在 110 后端的数据源已丢失——行内编辑进入编辑页时
 * GET /tableManage/getTableInfoDetail 返回 {"code":"099999","message":"数据源不存在！！！"}
 * → 表单必填项全部不回显 → 提交被校验拦截，updateTable 从未发出
 * （12:34 共享夹具轮、r2 run-20260920-191704-568、r3 run-20260920-192225-181 三次复现）。
 * 同期 DM-08-02 用本轮新建表（配置中心公共 MySQL 数据源）完整通过
 * 编辑+版本回滚，证明链路本身正常、问题特定于该夹具表绑定的数据源丢失。
 */
async function ensureVersionFixtureTable(
  page: Page,
  tableName: string,
  chineseName: string,
): Promise<string> {
  await dm0801OpenTableManage(page);
  const entered = await dm0801OpenCreateTableForMysql(page);
  if (!entered) {
    throw new Error(`环境前置缺失：新建表下拉未提供 MySQL 数据源（${MYSQL_SOURCE_TEXT}）。`);
  }
  await dm0801FillCreateBasics(page, tableName, chineseName);
  await dm0801AddMinimalFieldRow(page);
  await dm0801SubmitCreateTable(page, tableName);
  await dm0801BringOnline(page, tableName);
  return tableName;
}


async function requireExactCard(page: Page, tableName: string): Promise<Locator> {
  // 上线后表查询索引会异步刷新；在有限窗口内重复检索，不能把刚完成上线的表误判为缺失。
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await submitCardSearch(page, tableName) === 'cards') {
      for (const card of await currentCards(page)) {
        const name = (await card.locator('.table-name:visible, [class*="table-name"]:visible').first()
          .innerText().catch(() => '')).trim();
        if (name === tableName) return card;
      }
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`上线后等待 25 秒仍未在表查询中找到版本夹具表“${tableName}”。`);
}

async function openVersionList(page: Page, tableName: string): Promise<Locator> {
  const card = await requireExactCard(page, tableName);
  await openCard(page, card);
  await clickVisibleTab(page, /版本列表|版本信息/);
  return requireVersionRow(page);
}

/** 读取编辑表单关键必填项的当前回显值，用于缺陷定性证据。 */
async function dm0801ReadFormEchoState(page: Page): Promise<string> {
  const parts: string[] = [];
  for (const label of ['数据层级', '库/层级', 'schema', '表名称', '表中文名称', '负责人']) {
    const item = page.locator('.ant-form-item, .el-form-item, [class*="form-item"]').filter({ hasText: label }).last();
    const value = await item.locator('input').first().inputValue().catch(() => '<读取失败>');
    parts.push(`${label}=${value || '<空>'}`);
  }
  return parts.join('；');
}

/** 读取表单项（label 所在控件行）的可见文本，判断下拉是否停留在占位符（DM-08-02 同款）。 */
async function dm0801FormItemText(page: Page, label: RegExp): Promise<string> {
  const labelNode = await dm0801LastVisible(page.getByText(label));
  if (!labelNode) return '';
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
 * 编辑页「数据生命周期配置」提交前补齐（DM-08-02 20260920 通过轮实证）：该区块在编辑页
 * 不回显建表时的选择（combobox 停在「请选择」且未标 *），空生命周期会被提交校验拦截
 * 且无正向提示。补选后核对不再停留在「请选择」，不吞异常。
 */
async function dm0801EnsureLifecycleConfigured(page: Page): Promise<void> {
  const lifecycleLabels: Array<[RegExp, string]> = [
    [/数据生命周期/, '数据生命周期'],
    [/操作类型/, '操作类型'],
  ];
  for (const [pattern, label] of lifecycleLabels) {
    const before = await dm0801FormItemText(page, pattern);
    if (!before || /请选择/.test(before)) {
      if (!(await dm0801SelectFirstByLabel(page, label, { lenient: true }))) {
        throw new Error(`编辑页「${label}」未找到可补选的下拉控件。`);
      }
    }
    const after = await dm0801FormItemText(page, pattern);
    if (!after || /请选择/.test(after)) {
      throw new Error(`编辑页「${label}」补选后仍未生效（表单项文本：“${after}”）。`);
    }
  }
}

async function editFixtureDescription(page: Page, apiEvidence: string[]): Promise<string> {
  // 先补齐生命周期再动描述：提交校验先拦必填项，避免 updateTable 不发出的盲等。
  await dm0801EnsureLifecycleConfigured(page);
  const description = page.locator('textarea#businessRemark:visible').last();
  await expect(description, '编辑页未找到表级描述输入框').toBeVisible({ timeout: 10_000 });
  const marker = `版本编辑_${uuid()}`;
  await description.click();
  await description.press('Control+A');
  await description.pressSequentially(marker, { delay: 10 });
  await description.press('Tab');
  await expect(description).toHaveValue(marker);

  const waitForUpdate = page.waitForResponse(
    (response) => response.request().method() === 'POST' && /\/tableManage\/updateTable/.test(response.url()),
    { timeout: 20_000 },
  );
  // 必填校验被拦截时请求不会发出：与等待接口并行检测「请选择/请输入」校验红字，命中即定性。
  const validationError = page.locator('.ant-form-item-explain-error, .el-form-item__error, [class*="error-message"]')
    .filter({ hasText: /请选择|请输入/ }).first();
  const validationBlocked = (async () => {
    await validationError.waitFor({ state: 'visible', timeout: 20_000 });
    throw new Error('edit-validation-blocked');
  })();
  validationBlocked.catch(() => undefined); // race 落败分支的 rejection 需要吸收，避免 unhandled。

  // 现网版本由编辑页“建表”提交产生；“保存”只更新元数据草稿。
  await clickVisibleButton(page, /^建\s*表$/);
  const response = await Promise.race([waitForUpdate, validationBlocked]).catch(async (error) => {
    if (String((error as Error)?.message ?? error).includes('edit-validation-blocked')) {
      throw new Error(
        `编辑页「建 表」提交被必填校验拦截（POST /tableManage/updateTable 请求未发出）。`
        + `表单回显状态：${await dm0801ReadFormEchoState(page)}。`
        + `编辑页加载接口证据：${apiEvidence.join(' || ') || '未捕获到 tableManage 相关接口'}。`
        + `该现象与 20260920 12:34 轮共享夹具（e2e_dm_query_fixture_v2）上的失败一致，`
        + `指向编辑页不回显已有数据的页面缺陷。`,
      );
    }
    throw new Error(
      `编辑提交接口 /tableManage/updateTable 20 秒未返回。接口证据：`
      + `${apiEvidence.join(' || ') || '未捕获到 tableManage 相关接口'}。`,
    );
  });
  if (response.status() !== 200) {
    throw new Error(`编辑保存接口返回 HTTP ${response.status()}。接口证据：${apiEvidence.join(' || ')}`);
  }
  return marker;
}

const manageRows = (page: Page) => page.locator([
  'tbody > tr:visible',
  '.ant-table-tbody > tr:visible',
  '.el-table__body-wrapper tr:visible',
  '[role="row"]:visible:not(:has([role="columnheader"]))',
].join(', '));

async function openTableManageLeaf(page: Page): Promise<void> {
  const baseUrl = page.url().split('#')[0];
  await page.goto(`${baseUrl}#/dataMap/tableManage/tablesManage`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/#\/dataMap\/tableManage\/tablesManage(?:\?|$)/, { timeout: 15_000 });
}

async function manageFixtureRow(page: Page, tableName: string, timeout = 15_000): Promise<Locator> {
  const filter = page.locator('input:visible:not([type="checkbox"]):not([type="radio"])').first();
  await filter.fill(tableName);
  const query = page.getByRole('button', { name: /查\s*询/ }).last();
  if (await query.isVisible().catch(() => false)) await query.click();
  const row = manageRows(page).filter({ hasText: tableName }).first();
  await expect(row, `表管理未查询到自动化夹具“${tableName}”`).toBeVisible({ timeout });
  return row;
}

async function manageRowAction(page: Page, row: Locator, name: RegExp): Promise<Locator> {
  const selectors = 'button:visible, a:visible, .el-link:visible, [role="button"]:visible, [class*="link"]:visible, td:visible';
  for (const actions of [row.locator(selectors), page.locator(selectors)]) {
    for (let index = await actions.count() - 1; index >= 0; index -= 1) {
      const action = actions.nth(index);
      const text = (await action.innerText().catch(() => '')).replace(/\s+/g, ' ');
      name.lastIndex = 0;
      if (name.test(text)) return action;
    }
  }
  const textActions = page.getByText(name);
  for (let index = await textActions.count() - 1; index >= 0; index -= 1) {
    const action = textActions.nth(index);
    if (await action.isVisible().catch(() => false)) return action;
  }
  throw new Error(`表管理夹具“${await row.innerText().catch(() => '')}”没有操作“${name}”。`);
}

async function confirmManageDialog(page: Page): Promise<void> {
  const dialog = page.locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible').last();
  const confirm = (await dialog.isVisible().catch(() => false))
    ? dialog.getByRole('button', { name: /确\s*定|提\s*交/ }).last()
    : page.getByRole('button', { name: /确\s*定|提\s*交/ }).last();
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
}

async function setFixtureOnlineState(page: Page, tableName: string, target: 'online' | 'offline'): Promise<void> {
  let row = await manageFixtureRow(page, tableName);
  const actionName = target === 'offline' ? /^下\s*线$/ : /^上\s*线$/;
  const action = await manageRowAction(page, row, actionName).catch(() => undefined);
  if (!action) {
    const opposite = target === 'offline' ? /^上\s*线$/ : /^下\s*线$/;
    if (await manageRowAction(page, row, opposite).catch(() => undefined)) return;
    throw new Error(`无法确认夹具表“${tableName}”当前的上下线状态。`);
  }
  await action.click();
  await confirmManageDialog(page);
  const expectedNextAction = target === 'offline' ? /^上\s*线$/ : /^下\s*线$/;
  await expect.poll(async () => {
    row = await manageFixtureRow(page, tableName);
    return (await manageRowAction(page, row, expectedNextAction).catch(() => undefined)) ? target : 'waiting';
  }, { timeout: 20_000 }).toBe(target);
}

// ==================== 本轮自建资产清理（DS-PERM-77，20260922） ====================
// 口径同 DM-02-01（DS-PERM-63）/DM-01-04（DS-PERM-70）：仅回收本轮 UUID 自建表，
// 物理 DROP 限定配置主库 + 元数据行内“下线/删除”尽力而为；清理失败只告警，
// 不掩埋用例真实结果，也绝不触碰历史表或不明来源数据。

/** 物理主库名（profile databases.primary.database），DROP 显式限定该库。 */
const DM0801_PHYSICAL_DB_NAME =
  testEnvironment.databases.primary.database || testEnvironment.dataSourceNames.query.database;

/** 仅合法 MySQL 标识符（≤64 字符）才可能是本轮真实物理表；非法名直接跳过物理回收。 */
function dm0801IsDroppablePhysicalName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && name.length <= 64;
}

/** 尽力回收本轮物理表：DB 未配置与逐表 DROP 失败完整收集返回（不掩埋用例结果，DS-PERM-91）。 */
async function dm0801DropRoundPhysicalTables(names: string[]): Promise<string[]> {
  const dropErrors: string[] = [];
  const droppable = [...new Set(names)].filter(dm0801IsDroppablePhysicalName);
  if (!droppable.length) return dropErrors;
  if (!dbConfig()) {
    const detail = `DB 未配置：本轮物理表未物理回收（${droppable.join(', ')}），元数据按 UUID 表名可追溯`;
    console.warn(`[cleanup] ${detail}。`);
    dropErrors.push(detail);
    return dropErrors;
  }
  for (const name of droppable) {
    const target = DM0801_PHYSICAL_DB_NAME && dm0801IsDroppablePhysicalName(DM0801_PHYSICAL_DB_NAME)
      ? `\`${DM0801_PHYSICAL_DB_NAME}\`.\`${name}\``
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
async function dm0801BringRoundTableOfflineBestEffort(page: Page, tableName: string): Promise<string[]> {
  const offlineErrors: string[] = [];
  try {
    const row = await manageFixtureRow(page, tableName, 6_000).catch(() => undefined);
    if (!row) {
      // 元数据行已不存在＝无可下线对象，视为已回收，不计失败。
      console.warn(`[cleanup] 表管理未查询到本轮表「${tableName}」，跳过下线（可能已被回收）。`);
      return offlineErrors;
    }
    const offline = await manageRowAction(page, row, /^下\s*线$/).catch(() => undefined);
    if (offline) {
      await offline.click();
      await confirmManageDialog(page);
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
async function dm0801DeleteRoundMetadataRowBestEffort(page: Page, tableName: string): Promise<string[]> {
  const deleteErrors: string[] = [];
  try {
    const row = await manageFixtureRow(page, tableName, 6_000).catch(() => undefined);
    if (!row) return deleteErrors; // 已不存在视为本轮元数据回收完成。
    const action = await manageRowAction(page, row, /^删\s*除$|^移\s*除$/).catch(() => undefined);
    if (!action) {
      const detail = `表管理未提供「${tableName}」行内删除/移除入口，元数据保留（UUID 可追溯）`;
      console.warn(`[cleanup] ${detail}。`);
      deleteErrors.push(detail);
      return deleteErrors;
    }
    await action.click();
    await confirmManageDialog(page);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[cleanup] 本轮元数据「${tableName}」页面侧回收失败（尽力而为）：`, error);
    deleteErrors.push(`元数据「${tableName}」页面侧回收失败：${message.slice(0, 240)}`);
  }
  return deleteErrors;
}

/**
 * finally 专用：仅回收本轮 UUID 自建版本夹具表（物理表 + 元数据行内入口）。
 * DS-PERM-91：逐步尽力而为，任一项失败不中断其余步骤，失败完整收集并返回（本函数不抛出）；
 * 由用例结尾统一裁决——主体成功但清理未完全成功须 fail，主体失败保留原错误并附带清理证据。
 */
async function cleanupRoundVersionFixture(page: Page, tableName: string): Promise<string[]> {
  const cleanupErrors: string[] = [];
  if (!tableName) return cleanupErrors;
  try {
    cleanupErrors.push(...(await dm0801DropRoundPhysicalTables([tableName])));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[cleanup] 本轮物理表回收步骤异常（尽力而为）：', error);
    cleanupErrors.push(`物理表回收步骤异常：${message.slice(0, 240)}`);
  }
  try {
    await dm0801OpenTableManage(page);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[cleanup] 未回到表管理列表，跳过「${tableName}」元数据页面侧回收（UUID 可追溯）：`, error);
    cleanupErrors.push(`未回到表管理列表，「${tableName}」元数据页面侧回收未执行：${message.slice(0, 240)}`);
    return cleanupErrors;
  }
  cleanupErrors.push(...(await dm0801BringRoundTableOfflineBestEffort(page, tableName)));
  cleanupErrors.push(...(await dm0801DeleteRoundMetadataRowBestEffort(page, tableName)));
  return cleanupErrors;
}

test.describe("DM-08-01｜数据地图｜新建 编辑生成版本并查看版本列表", () => {
  // 300s：默认页未命中时的「唯一新名建表+上线」链路 worst case（入口+基础信息+字段+提交≤35s
  // +上线≤46s，dm0702-r6 已验证）加版本闭环主体。各步骤自带超时，总预算只提供余量，不掩盖挂起。
  test.describe.configure({ timeout: 300_000 });
  test.beforeEach(async ({ loginPage }) => {
    await openTableQueryLeaf(loginPage);
    await expect(loginPage.locator('.table-query .search-bar, .table-query .card-list').first()).toBeVisible();
  })
  test("DM-08-01｜数据地图｜新建 编辑生成版本并查看版本列表", async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;
    // 夹具策略（20260920 定稿；DS-PERM-77 收紧）：每轮「本轮唯一 UUID ASCII 表名」本地
    // 新建+上线，不复用、不检索任何既有记录，表名不再派生自历史夹具名。决定性依据：共享
    // 夹具 e2e_dm_query_fixture_v2 在 110 后端绑定的数据源已丢失，getTableInfoDetail 返回
    // {"code":"099999","message":"数据源不存在！！！"}（12:34 共享夹具轮、r2
    // run-20260920-191704-568、r3 run-20260920-192225-181 三次复现），编辑页必填项全部不
    // 回显、提交被校验拦截；同期 DM-08-02 用本轮新建表完整通过编辑+版本回滚，证明链路
    // 正常、问题特定于该夹具表。「新建」亦是本用例标题语义的一部分。版本递增断言原样保留。
    const tableName = `e2e_dm_version_${uuid()}`;
    const chineseName = `数据地图版本夹具_${uuid()}`;
    // DS-PERM-91：先记录主体结果（mainFailed/mainError），finally 清理失败收集进
    // cleanupErrors；主体成功但清理未完全成功须 fail，主体失败保留原错误并附清理证据。
    let mainError: unknown;
    let mainFailed = false;
    const cleanupErrors: string[] = [];
    try {
      await ensureVersionFixtureTable(page, tableName, chineseName);
      // 只操作本轮自建表：先记录版本数，再编辑并保存一次。
      await openTableManageLeaf(page);
      await setFixtureOnlineState(page, tableName, 'online');
      await openTableQueryLeaf(page);
      await openVersionList(page, tableName);
      const beforeTotal = await versionTotalCount(page);
      await openTableManageLeaf(page);
      await setFixtureOnlineState(page, tableName, 'offline');
      const offlineRow = await manageFixtureRow(page, tableName);
      // 采集编辑页加载阶段（detail/query）与提交阶段（updateTable）的接口证据，失败时随错误输出。
      const editApiEvidence: string[] = [];
      const evidenceListener = (response: Response): void => {
        if (/tableManage/i.test(response.url()) && editApiEvidence.length < 8) {
          void response.text().then((body) => {
            editApiEvidence.push(
              `${response.request().method()} ${response.status()} ${response.url().split('?')[0]} :: ${body.slice(0, 200)}`,
            );
          }).catch(() => undefined);
        }
      };
      page.on('response', evidenceListener);
      let marker: string;
      try {
        await (await manageRowAction(page, offlineRow, /^编\s*辑$/)).click();
        marker = await editFixtureDescription(page, editApiEvidence);
      } finally {
        page.off('response', evidenceListener);
      }
      await openTableManageLeaf(page);
      await setFixtureOnlineState(page, tableName, 'online');
      await openTableQueryLeaf(page);
      await openVersionList(page, tableName);
      await expect.poll(() => versionTotalCount(page), {
        timeout: 30_000,
        intervals: [500, 1_000, 2_000],
      }).toBeGreaterThan(beforeTotal);
      await assertNoConsoleErrors(consoleErrors);
      await report('表查询-编辑本轮自建表后版本列表递增', true,
        `表=${tableName}（本轮唯一 UUID 自建表，finally 仅回收本轮资产）；标记=${marker}`);
    } catch (error) {
      // DS-PERM-91：先记录主体错误，finally 清理完成后再统一裁决，避免清理异常掩埋主体失败。
      mainFailed = true;
      mainError = error;
    } finally {
      // DS-PERM-77/91：无论结果如何，仅回收本轮 UUID 自建表（物理 DROP + 元数据行内
      // 下线/删除尽力而为）；失败完整收集，不掩埋上方任何真实断言结果，不触碰非本轮资产。
      try {
        cleanupErrors.push(...(await cleanupRoundVersionFixture(page, tableName)));
      } catch (cleanupCrash) {
        // 清理流程自身异常也按清理失败收集，保证 finally 不抛出、不覆盖主体错误。
        const message = cleanupCrash instanceof Error ? cleanupCrash.message : String(cleanupCrash);
        console.error('[cleanup] 清理流程自身异常（按清理失败收集）：', cleanupCrash);
        cleanupErrors.push(`清理流程自身异常：${message.slice(0, 240)}`);
      }
    }
    // DS-PERM-91 统一裁决（口径同 DM-07-01 DS-PERM-89 / DM-09/10 DS-PERM-86 已验收
    // scoped-cleanup）：主体失败优先抛出并附带清理未完成说明（仅追加 message，不改变
    // 错误类型，保留既有 skip/失败判定）；主体通过但清理未完全成功也如实上抛，
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
        `DM-08-01 主体通过，但本轮 UUID 自建表清理未完全成功（如实上报；待人工复核本轮 UUID 表：${tableName}）：`
          + cleanupErrors.join('；'),
      );
    }
  })
});
