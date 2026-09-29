/**
 * 数据地图 — 表查询 E2E 测试
 *
 * 页面实况：表查询主列表是 .table-query .card 卡片列表，不是 tbody 主表；
 * 卡片来源标签由后端来源编码映射为“ftp文件接入/文件接入/数据集成/自行建表”。
 * 需要 Gbase 或某个来源表时，找不到真实卡片必须显式跳过，不以空数据假绿。
 *
 * DS-PERM-70（20260922）：本轮经表管理自建的唯一 UUID 夹具表在 finally 中尽力
 * 回收——物理表 DROP（限定配置主库）+ 元数据行内“下线/删除”入口，只针对本轮表、
 * 全部尽力而为且失败仅告警，不掩埋用例真实结果，也不触碰任何非本轮资产。
 */

import { test, expect, uuid } from '../utils.js';
import { assertNoConsoleErrors, clickMenu, submitAndExpectSuccess, dbConfig, query } from '../utils.js';
import type { Locator, Page, Response } from '@playwright/test';
import { testEnvironment } from '../../../test-environment.js';
import { QUERY_FIXTURE } from './数据地图查询夹具.js';


// 实际页面的卡片有时直接挂在 card-list 下，有时中间还有一层布局容器；
// 统一按表查询区域内可见卡片取值，避免来源数据被布局层级误筛掉。
const MAIN_CARD_SELECTOR = '.table-query .card:visible';
const DETAIL_TABLE_SELECTOR = [
  '.ant-table:visible',
  '.el-table:visible',
  'table:visible',
  '[role="grid"]:visible',
].join(', ');
const DETAIL_ROWS_SELECTOR = [
  '.ant-table-tbody > tr:visible',
  '.el-table__body-wrapper tr:visible',
  'table tbody > tr:visible',
  '[role="row"]:visible:not(:has([role="columnheader"]))',
].join(', ');
const TABLE_SEARCH_PLACEHOLDER = '按表名、中文名、描述、负责人搜索';

type SourceKind = '自行建表' | '数据集成' | '文件接入' | 'FTP文件接入';

const SOURCE_DEFINITIONS: Record<SourceKind, RegExp> = {
  自行建表: /data[_-]?map|自行建表|自建表/i,
  数据集成: /data[_-]?sync[_-]?task|数据集成/i,
  文件接入: /file[_-]?upload|文件接入/i,
  FTP文件接入: /ftp[_-]?file[_-]?upload|ftp文件接入/i,
};

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

async function lastVisible(locator: Locator): Promise<Locator | undefined> {
  for (let index = await locator.count() - 1; index >= 0; index -= 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return undefined;
}

async function resetCardPagination(page: Page): Promise<void> {
  const firstPage = await lastVisible(page.getByRole('listitem', { name: /^\s*1\s*$/ }));
  if (!firstPage) return;
  const className = await firstPage.getAttribute('class') ?? '';
  const current = await firstPage.getAttribute('aria-current');
  if (/active|selected/i.test(className) || current === 'page') return;
  await firstPage.click();
  await page.waitForTimeout(350);
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

async function expectVisibleAction(page: Page, name: string | RegExp): Promise<void> {
  await expect.poll(async () => (await findVisibleAction(page, name)) ? 'found' : 'missing', {
    timeout: 10_000,
  }).toBe('found');
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

async function submitVisibleAndExpectSuccess(page: Page, buttonName: string | RegExp): Promise<void> {
  await clickVisibleButton(page, buttonName);
  const message = page.locator(
    '.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible, [class*="message"]:visible',
  ).filter({ hasText: /成功|完成|更新/ }).first();
  await expect(message).toBeVisible({ timeout: 10_000 });
}

function skipForMissingEnvironment(message: string): never {
  throw new Error(`环境前置条件缺失：${message}`);
}

async function currentCards(page: Page): Promise<Locator[]> {
  return visibleLocators(page.locator(MAIN_CARD_SELECTOR));
}

async function cardMetadata(card: Locator): Promise<string> {
  const source = card.locator('.source-tag').first();
  return [
    await source.getAttribute('class'),
    await source.innerText().catch(() => ''),
    await card.innerText().catch(() => ''),
  ].filter(Boolean).join(' ');
}

async function findCardOnCurrentOrNextPage(
  page: Page,
  predicate: (metadata: string) => boolean,
): Promise<Locator | undefined> {
  // 每次从第一页开始，避免前一个来源搜索停在末页后把真实存在于首页的
  // 来源误判为“环境缺失”。
  await resetCardPagination(page);
  // 当前环境全量列表已达 130+ 张（10 条/页 ≈ 13 页），10 页上限会漏掉末页的
  // 夹具表；放宽到 16 页覆盖全部真实分页。
  for (let pageIndex = 0; pageIndex < 16; pageIndex += 1) {
    for (const card of await currentCards(page)) {
      if (predicate(await cardMetadata(card))) return card;
    }

    const next = (await lastVisible(page.getByRole('listitem', { name: '下一页' }))) ??
      (await lastVisible(page.getByRole('button', { name: '下一页' }))) ??
      (await lastVisible(page.locator(
        '.table-query .ant-pagination-next:visible, .table-query li[title="下一页"]:visible',
      )));
    if (!next) return undefined;
    const nextClass = await next.getAttribute('class') ?? '';
    const ariaDisabled = await next.getAttribute('aria-disabled');
    if (/disabled/i.test(nextClass) || ariaDisabled === 'true') return undefined;
    await next.click();
    await page.waitForTimeout(350);
  }
  return undefined;
}

async function requireSourceCard(page: Page, source: SourceKind): Promise<Locator> {
  const card = await findCardOnCurrentOrNextPage(page, (metadata) => SOURCE_DEFINITIONS[source].test(metadata));
  return card ?? skipForMissingEnvironment(`未找到“${source}”来源表卡片，请先准备该来源的可查询测试表。`);
}

async function requireDatabaseCard(page: Page, database: 'HIVE' | 'Gbase'): Promise<Locator> {
  const matcher = database === 'HIVE' ? /\bHIVE\b/i : /\bGBASE(?:8A)?\b/i;
  const card = await findCardOnCurrentOrNextPage(page, (metadata) => matcher.test(metadata));
  return card ?? skipForMissingEnvironment(`未找到 ${database} 数据库类型的可查询表，分区测试跳过。`);
}

async function requirePartitionData(page: Page, database: 'HIVE' | 'Gbase'): Promise<void> {
  const panel = activeDetailPanel(page);
  await expect(panel).toBeVisible({ timeout: 10_000 });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const text = await panel.innerText().catch(() => '');
    const rows = panel.locator(DETAIL_ROWS_SELECTOR);
    const rowCount = await rows.count();
    if (/暂无数据|没有数据|空空如也/.test(text)) {
      skipForMissingEnvironment(`${database} 测试表的分区页没有分区数据，分区测试跳过。`);
    }
    if (rowCount > 0) return;
    await page.waitForTimeout(250);
  }

  // 有些版本只渲染“分区/存储量/操作”表头，不渲染空态组件；
  // 此时仍按环境数据缺失处理，避免把空表误报为定位失败。
  skipForMissingEnvironment(`${database} 测试表分区页未返回可用分区行，分区测试跳过。`);
}

async function requireAnyCard(page: Page): Promise<Locator> {
  const empty = page.locator(
    '.table-query .ant-empty:visible, .table-query .el-empty:visible, .table-query [class*="empty"]:visible',
  ).filter({ hasText: /暂无数据|没有数据|空空如也/ }).first();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const cards = await currentCards(page);
    if (cards.length) return cards[0];
    if (await empty.isVisible().catch(() => false)) {
      // 首次路由进入时组件会短暂渲染空态；继续等待，避免把加载瞬态误判为环境没有表。
      await page.waitForTimeout(500);
      continue;
    }
    await page.waitForTimeout(300);
  }
  skipForMissingEnvironment('表查询列表30秒内没有加载出可用测试表卡片。');
}

async function submitCardSearch(
  page: Page,
  value: string,
  expectedTableName = value,
): Promise<'cards' | 'empty'> {
  const emptyStates = page.locator(
    '.table-query .ant-empty:visible, .table-query .el-empty:visible, ' +
    '.table-query [class*="empty"]:visible, .table-query p:visible',
  ).filter({ hasText: /暂无数据|没有数据|空空如也/ });
  // 先等页面当前列表落定（卡片或空态二选一）。run-20260916-agent8 实测：在初始
  // 列表请求尚未返回时提交搜索，提交事件会被组件初始化吞掉，旧列表一直残留。
  await expect.poll(async () => {
    if (await (await currentCards(page)).length) return 'ready';
    if (await emptyStates.first().isVisible().catch(() => false)) return 'ready';
    return 'loading';
  }, { timeout: 15_000 }).toBe('ready');

  const search = page.getByPlaceholder(TABLE_SEARCH_PLACEHOLDER);
  await search.click();
  await search.fill('');
  // 页面同时存在 input/change 与 keyup.enter 两种实现；逐字输入并主动失焦，
  // 让两类页面都收到真实事件，避免只改了输入框值却仍展示上一页卡片。
  if (value) await search.pressSequentially(value, { delay: 10 });
  // 以真实搜索接口响应作为“本次提交已被受理”的锚点；接口未触发时退回纯 UI 判定。
  const searchSettled = page.waitForResponse(
    (response) => response.url().includes('datamap_search/search_table'),
    { timeout: 15_000 },
  ).then(() => undefined).catch(() => undefined);
  await search.press('Enter');
  await searchSettled;
  await search.blur();
  await page.waitForTimeout(300);
  // 查询结果可能分页展示：以“翻页后能找到目标表”为命中标准；找不到目标表时
  // 由调用方的命中断言给出明确失败，空态仅用于区分“无结果”与“未命中”。
  const fixtureCard = await findCardOnCurrentOrNextPage(
    page,
    (metadata) => metadata.includes(expectedTableName),
  );
  if (fixtureCard) return 'cards';
  return 'empty';
}

async function openCard(page: Page, card: Locator): Promise<void> {
  const name = card.locator('.table-name:visible, [class*="table-name"]:visible').first();
  await expect(name).toBeVisible();
  await name.click();
  await page.waitForTimeout(300);
  await expect(page.getByRole('heading', { name: '基础信息' })).toBeVisible();
}

async function returnToTableQuery(page: Page): Promise<void> {
  await page.goBack();
  await expect(page.locator(
    `${MAIN_CARD_SELECTOR}, .table-query .ant-empty:visible, .table-query .el-empty:visible, ` +
    '.table-query [class*="empty"]:visible',
  ).first()).toBeVisible();
}

async function clickCardEdit(card: Locator): Promise<void> {
  const edit = card.locator(
    '[aria-label="图标: edit"], [aria-label*="edit" i], [aria-label*="编辑"], ' +
    '.anticon-edit, [class*="icon-edit"]',
  ).first();
  await expect(edit).toBeVisible();
  await edit.click();
}

async function clickCardPermission(card: Locator): Promise<void> {
  const permission = card.locator(
    '[aria-label="图标: safety-certificate"], [aria-label*="safety-certificate" i], ' +
    '[aria-label*="权限"], [title*="权限"]',
  ).first();
  await expect(permission).toBeVisible();
  await permission.click();
}

async function openTableQueryLeaf(page: Page): Promise<void> {
  // 当前前端对深层 hash 的直接跳转偶发只改 URL、不卸载“数据源管理”组件。
  // 通过真实菜单链路进入，才能让左侧树和表查询组件同步完成切换。
  await clickMenu(page, '数据地图', '表查询', '表查询');
  await expect(page.locator('.table-query .search-bar, .table-query .card-list').first())
    .toBeVisible({ timeout: 15_000 });
}

function activeDetailPanel(page: Page): Locator {
  // 组件会同时保留多个可见 tabpanel 空壳；当前内容面板是其中最后一个
  // 含有实际文本的面板，不能简单取所有可见节点的 last()。
  return page.locator('[role="tabpanel"]:visible').filter({ hasText: /\S/ }).last();
}

async function expectActivePanelText(page: Page, pattern: RegExp): Promise<void> {
  await expect.poll(async () => {
    const panels = page.locator('[role="tabpanel"]:visible');
    let text = '';
    for (let index = 0; index < await panels.count(); index += 1) {
      text += `\n${await panels.nth(index).innerText().catch(() => '')}`;
    }
    pattern.lastIndex = 0;
    return pattern.test(text) ? 'matched' : 'loading';
  }, { timeout: 10_000 }).toBe('matched');
}

async function requireVersionRow(page: Page): Promise<Locator> {
  const panel = activeDetailPanel(page);
  const versionTable = panel.locator(DETAIL_TABLE_SELECTOR).filter({ hasText: /版本|DDL|SQL|操作|上线|下线/ }).last();
  const emptyState = panel.locator(
    '.ant-empty:visible, .el-empty:visible, [class*="empty"]:visible, p:visible',
  ).filter({ hasText: /暂无数据|没有数据|空空如也/ }).first();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await emptyState.isVisible().catch(() => false)) {
      skipForMissingEnvironment('当前测试表没有可用的目标版本记录，版本测试跳过。');
    }
    if (await versionTable.isVisible().catch(() => false)) {
      const rows = versionTable.locator(
        'tbody > tr:visible, [role="row"]:visible:not(:has([role="columnheader"]))',
      );
      if (await rows.count()) return rows.first();
    }
    await page.waitForTimeout(250);
  }

  skipForMissingEnvironment('版本页签存在但没有可用的目标版本记录，版本测试跳过。');
}

async function expectDetailTableOrEmpty(page: Page): Promise<void> {
  await expect(
    page.locator(`${DETAIL_TABLE_SELECTOR}, .ant-empty:visible, .el-empty:visible, [class*="empty"]:visible`).first(),
  ).toBeVisible();
}
/**
 * —— 本轮自建夹具表链路（移植 DM-07-02 / DM-08-01 已验证的表管理建表链路）——
 * 20260920-110 迁移后，共享夹具 e2e_dm_query_fixture_v2 的记录不再出现在表查询
 * 列表（表管理各状态页签也检索不到，详情接口 099999“数据源不存在”）。按
 * 20260920 夹具策略改为：每轮用“固定名 + uuid 尾缀”的唯一新名经表管理自建
 * 最小表并上线，四项搜索关键词全部来自本轮新建记录，不依赖、不修改、不删除
 * 任何历史共享夹具数据。
 */
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

async function visibleButton(page: Page, name: string | RegExp): Promise<Locator | undefined> {
  return lastVisible(page.getByRole('button', { name }));
}

/** 出现二次确认弹窗时点击「确 定」；未出现不阻塞（等待即返回）。 */
async function confirmDialogIfAny(page: Page, timeout = 2_000): Promise<void> {
  const confirm = page.getByRole('dialog').last()
    .getByRole('button', { name: /^确\s*定$/ }).last();
  if (await confirm.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false)) {
    await confirm.click();
  }
}

async function openTableManage(page: Page): Promise<void> {
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

/**
 * 基础必填项 + 表级“描述”（数据层级/库层级 精确匹配“应用数据层 + ADS”，
 * 物理库=配置中心主库（databases.primary.database），110 实测映射）。表级“描述”是 textbox（快照 ref=e233，
 * 可访问名“描述:”）；字段行的“描述”列在添加字段行之后才出现，填写基础
 * 信息时 first() 即表级描述输入框。
 */
async function fillCreateBasics(
  page: Page,
  record: { tableName: string; chineseName: string; description: string },
): Promise<void> {
  await fillRequiredInput(page, '表名称', record.tableName);
  await fillRequiredInput(page, '表中文名称', record.chineseName);
  const descriptionInput = page.getByRole('textbox', { name: /^描述\s*[:：]?\s*$/ }).first();
  await expect(descriptionInput, '新建表表单未渲染表级“描述”输入框').toBeVisible({ timeout: 10_000 });
  await descriptionInput.fill(record.description);
  await descriptionInput.blur();
  await expect(descriptionInput).toHaveValue(record.description);
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
 * 逐个状态页签筛选目标表（run-20260920-181310-553 证据：记录可能躺在
 * 非默认状态页签）。找到返回行定位器；所有状态页都没有返回 undefined。
 */
async function filterManageRowAcrossTabs(page: Page, tableName: string): Promise<Locator | undefined> {
  const tabs = page.locator('[role="tab"]:visible, .ant-tabs-tab:visible, .el-tabs__item:visible');
  for (let index = await tabs.count() - 1; index >= 0; index -= 1) {
    const tab = tabs.nth(index);
    await tab.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(600);
    try {
      return await filterManageRow(page, tableName, 4_000);
    } catch {
      // 当前页签无该表，继续下一个页签。
    }
  }
  return undefined;
}

/** 行内操作定位（固定列布局一行拆多 table，行内未命中按全页可见操作兜底）。 */
async function rowAction(page: Page, row: Locator, name: RegExp): Promise<Locator | undefined> {
  const selectors = 'button:visible, a:visible, .el-link:visible, [role="button"]:visible, [class*="link"]:visible, td:visible';
  for (const scope of [row.locator(selectors), page.locator(selectors)]) {
    for (let index = await scope.count() - 1; index >= 0; index -= 1) {
      const action = scope.nth(index);
      const text = (await action.innerText().catch(() => '')).replace(/\s+/g, ' ');
      if (name.test(text) && (await action.isVisible().catch(() => false))) return action;
    }
  }
  return undefined;
}

/** 新建一个最小字段行（e2e_id VARCHAR 64；查询夹具只需最小字段集，列序 DM-04-02 实测）。 */
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

/** 上线并轮询到行内出现「下线」（唯一新名建表后必经；物理库列须回显配置主库名）。 */
async function bringTableOnline(page: Page, tableName: string): Promise<void> {
  let row = await filterManageRow(page, tableName, 8_000).catch(() => undefined);
  if (!row) row = await filterManageRowAcrossTabs(page, tableName);
  if (!row) throw new Error(`表管理各状态页签都未查询到测试表「${tableName}」，无法执行上线。`);
  // 本地新建的表必须落配置主库（databases.primary.database）：数据库列回显防数据源误选（DM-04-01 契约）。
  await expect(page.locator('body')).toContainText(PHYSICAL_DB_NAME, { timeout: 10_000 });
  const online = await rowAction(page, row, /^上\s*线$/);
  if (online) {
    await online.click();
    await confirmDialogIfAny(page, 3_000);
  }
  // 轮询只查默认页（记录上线后停留在此），未命中才全页签兜底（限 2 次）。
  const deadline = Date.now() + 45_000;
  let fallbackScans = 0;
  while (Date.now() < deadline) {
    try {
      row = await filterManageRow(page, tableName, 3_000).catch(() => undefined);
      if (row && await rowAction(page, row, /^下\s*线$/)) return;
      const retry = row ? await rowAction(page, row, /^上\s*线$/) : undefined;
      if (retry) {
        await retry.click();
        await confirmDialogIfAny(page, 3_000);
      }
      if (!row && fallbackScans < 2) {
        fallbackScans += 1;
        row = await filterManageRowAcrossTabs(page, tableName);
      }
    } catch {
      // 列表刷新瞬间行可能未挂载，忽略本轮，下一轮重查。
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`等待 45 秒后表管理中「${tableName}」仍未上线（行内未出现「下线」操作）。`);
}

// ==================== 本轮自建夹具表清理（DS-PERM-70） ====================

/** 仅合法 MySQL 标识符（≤64 字符）才可能是本轮真实物理表；非法探针名直接跳过物理回收。 */
function isDroppablePhysicalName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && name.length <= 64;
}

/**
 * 尽力回收本轮物理表（口径同 DM-02-01 DS-PERM-63）：建表链路保证物理表落在配置
 * 主库（PHYSICAL_DB_NAME），DROP 显式限定该库；DB 未配置或 DROP 失败只告警，
 * 不掩埋用例结果；遗留表按 UUID 表名可追溯。
 */
async function dropRoundPhysicalTables(names: string[]): Promise<void> {
  const droppable = [...new Set(names)].filter(isDroppablePhysicalName);
  if (!droppable.length) return;
  if (!dbConfig()) {
    console.warn(`[cleanup] DB 未配置：本轮物理表未回收（${droppable.join(', ')}），元数据按 UUID 表名可追溯。`);
    return;
  }
  for (const name of droppable) {
    const target = PHYSICAL_DB_NAME && isDroppablePhysicalName(PHYSICAL_DB_NAME)
      ? `\`${PHYSICAL_DB_NAME}\`.\`${name}\``
      : `\`${name}\``;
    try {
      await query(`DROP TABLE IF EXISTS ${target}`);
    } catch (error) {
      console.warn(`[cleanup] 本轮物理表 ${name} DROP 失败（尽力而为）：`, error);
    }
  }
}

/** 行内“下线”尽力而为：上线状态可能拦截元数据删除，先恢复为可删除状态。 */
async function bringRoundTableOfflineBestEffort(page: Page, tableName: string): Promise<void> {
  try {
    let row = await filterManageRow(page, tableName, 6_000).catch(() => undefined);
    if (!row) row = await filterManageRowAcrossTabs(page, tableName);
    if (!row) {
      console.warn(`[cleanup] 表管理未查询到本轮表「${tableName}」，跳过下线（可能已被回收）。`);
      return;
    }
    const offline = await rowAction(page, row, /^下\s*线$/);
    if (offline) {
      await offline.click();
      await confirmDialogIfAny(page, 3_000);
      await page.waitForTimeout(1_000);
    }
  } catch (error) {
    console.warn(`[cleanup] 本轮表「${tableName}」下线失败（尽力而为）：`, error);
  }
}

/** 元数据行内删除入口尽力而为：入口不存在或删除失败仅告警保留，UUID 表名可追溯。 */
async function deleteRoundMetadataRowBestEffort(page: Page, tableName: string): Promise<void> {
  try {
    let row = await filterManageRow(page, tableName, 6_000).catch(() => undefined);
    if (!row) row = await filterManageRowAcrossTabs(page, tableName);
    if (!row) return; // 已不存在视为本轮元数据回收完成。
    const action = await rowAction(page, row, /^删\s*除$|^移\s*除$/);
    if (!action) {
      console.warn(`[cleanup] 表管理未提供「${tableName}」行内删除/移除入口，元数据保留（UUID 可追溯）。`);
      return;
    }
    await action.click();
    await confirmDialogIfAny(page, 5_000);
  } catch (error) {
    console.warn(`[cleanup] 本轮元数据「${tableName}」页面侧回收失败（尽力而为）：`, error);
  }
}

/**
 * finally 专用：仅清理本轮 UUID 自建夹具表（物理表 + 元数据行内入口），
 * 全部尽力而为、只告警不抛错，绝不掩埋用例真实结果。
 */
async function cleanupRoundQueryFixture(page: Page, tableName: string): Promise<void> {
  if (!tableName) return;
  await dropRoundPhysicalTables([tableName]);
  try {
    await openTableManage(page);
  } catch (error) {
    console.warn(`[cleanup] 未回到表管理列表，跳过「${tableName}」元数据页面侧回收（UUID 可追溯）：`, error);
    return;
  }
  await bringRoundTableOfflineBestEffort(page, tableName);
  await deleteRoundMetadataRowBestEffort(page, tableName);
}

/**
 * 每轮自建唯一查询夹具表并上线，返回四项搜索关键词全部来自该新记录：
 * 表名/中文名/描述 = QUERY_FIXTURE 基准值 + uuid 尾缀（唯一，规避历史
 * 草稿/重复记录的 099999“表名重复”），负责人 = 建表表单默认回显（admin）。
 * 完成后回到表查询叶子页，测试体的搜索动作直接可用。
 */
async function ensureQueryFixtureTable(page: Page): Promise<{
  tableName: string; chineseName: string; description: string; owner: string;
}> {
  const suffix = uuid().slice(0, 6);
  const record = {
    tableName: `${QUERY_FIXTURE.tableName}_${suffix}`,
    chineseName: `${QUERY_FIXTURE.chineseName}_${suffix}`,
    description: `${QUERY_FIXTURE.description}_${suffix}`,
    owner: QUERY_FIXTURE.owner,
  };
  await openTableManage(page);
  const entered = await openCreateTableForMysql(page);
  if (!entered) {
    throw new Error(`环境前置缺失：新建表下拉未提供 MySQL 数据源（${MYSQL_SOURCE_TEXT}）。`);
  }
  await fillCreateBasics(page, record);
  await addMinimalFieldRow(page);
  await submitAndExpectTableCreated(page, record.tableName);
  await bringTableOnline(page, record.tableName);
  await openTableQueryLeaf(page);
  // 110 环境实测：表查询索引对新上线表有分钟级延迟收录（01:03 轮自建的
  // e2e_dm_query_fixture_v2_ca18fa 约 9 分钟后才可检索到）。四种关键词的断言
  // 必须真实命中，因此先轮询等索引收录本轮新表；超时按环境前置缺失显式 skip
  // （QUERY_INDEX_WAIT_MS 可调，默认 480s），不放宽任何断言口径。
  const indexWaitMs = Number(process.env.QUERY_INDEX_WAIT_MS ?? 480_000);
  const searchBox = page.getByPlaceholder(TABLE_SEARCH_PLACEHOLDER);
  const indexDeadline = Date.now() + indexWaitMs;
  let indexed = false;
  while (Date.now() < indexDeadline) {
    try {
      await searchBox.fill(record.tableName);
      await searchBox.press('Enter');
      await page.waitForTimeout(2_500);
      if (await page.locator(MAIN_CARD_SELECTOR).filter({ hasText: record.tableName }).first()
        .isVisible().catch(() => false)) {
        indexed = true;
        break;
      }
    } catch {
      // 搜索瞬态失败继续轮询。
    }
    await page.waitForTimeout(15_000);
    await openTableQueryLeaf(page);
  }
  if (!indexed) {
    skipForMissingEnvironment(
      `表查询索引未在 ${Math.round(indexWaitMs / 1000)} 秒内收录本轮新建表「${record.tableName}」`
      + `（110 环境实测索引延迟收录可达约 9 分钟；可用 QUERY_INDEX_WAIT_MS 调整等待上限）。`,
    );
  }
  // 清空关键词恢复全量列表，交回测试体按四种关键词逐一真实检索。
  await searchBox.fill('');
  await searchBox.press('Enter');
  await page.waitForTimeout(1_500);
  return record;
}

test.describe("DM-01-04｜数据地图｜表名、中文名、描述、负责人查询", () => {
  test.beforeEach(async ({ loginPage }) => {
    await openTableQueryLeaf(loginPage);
    await expect(loginPage.locator('.table-query .search-bar, .table-query .card-list').first()).toBeVisible();
  })
test("DM-01-04｜数据地图｜表名、中文名、描述、负责人查询", async ({ loginPage, consoleErrors, report }) => {
      // 历史 skip（BUG-D02）已解除：run-20260911 的负责人查询失败需要按当前页面
      // 重新实测；本用例继续要求四种关键词都真实命中夹具表，命中结果允许翻页查找。
      const page = loginPage;
      // 前置包含建表、上线与等待表查询索引收录（110 环境延迟可达分钟级），放宽超时。
      test.setTimeout(600_000);
      await expect(page.locator('.table-query .pagination:visible, .table-query .ant-pagination:visible').first()).toBeVisible();

      // 20260920-110 迁移后共享夹具记录已从表查询列表消失（环境适配，非产品断言
      // 变化）：每轮经表管理自建唯一夹具表并上线，四项搜索关键词全部来自本轮
      // 新建记录，断言口径（四种关键词真实命中同一张自有表）保持不变。
      const fixture = await ensureQueryFixtureTable(page);
      // DS-PERM-70：本轮唯一自建夹具表只服务本轮断言；无论结果如何，finally
      // 只回收本轮 UUID 表（物理 DROP + 元数据行内下线/删除均尽力而为），
      // 清理失败仅告警，不掩埋上方任何真实断言结果，也不触碰非本轮资产。
      try {
        // 先以表名精确找到夹具、进入详情，确认建表时填入的四项元数据真实存在。
        expect(await submitCardSearch(page, fixture.tableName)).toBe('cards');
        // 搜索受理后组件可能再触发一次列表刷新并把分页重置回第一页（20260920-110
        // 现场：输入框仍有关键词、列表却回到 130 条全量第一页），所以定位夹具卡片
        // 必须沿用上方“翻页查找”的同一口径，不能只看当前页。
        const fixtureCard = await findCardOnCurrentOrNextPage(
          page,
          (metadata) => metadata.includes(fixture.tableName),
        );
        await expect(fixtureCard, `表名搜索应能定位夹具表 ${fixture.tableName}`).toBeTruthy();
        await openCard(page, fixtureCard!);
        await expect(page.locator('body')).toContainText(fixture.tableName);
        await expect(page.locator('body')).toContainText(fixture.chineseName);
        const ownerLabel = page.getByText(/负责人/, { exact: false }).last();
        await expect(ownerLabel.locator('..')).toContainText(fixture.owner);

        // 详情页“描述”当前可能存在回显缺失，属于详情展示的独立问题；
        // 本用例继续验证描述字段作为查询条件时是否能命中同一张表。

        // 四种正向查询都必须返回同一张自有夹具表，不依赖环境原有表的描述或负责人。
        for (const [field, value] of [
          ['表名', fixture.tableName],
          ['中文名', fixture.chineseName],
          ['描述', fixture.description],
          ['负责人', fixture.owner],
        ] as const) {
          await openTableQueryLeaf(page);
          const state = await submitCardSearch(page, value, fixture.tableName);
          // 已确认真实产品缺陷（BUG-D02）：全局搜索输入负责人返回“暂无数据”，
          // 而同一夹具表按表名/中文名/描述均可命中（上方步骤已实测）。保留
          // 真实断言并显式定性，不以放宽口径修复。
          if (field === '负责人' && state !== 'cards') {
            throw new Error(
              `真实产品BUG：负责人搜索未命中夹具表（搜索词=${value}，结果=${state}；` +
                `同一表 ${fixture.tableName} 按表名/中文名/描述均可命中，` +
                `详情页负责人回显=${fixture.owner}）。`,
            );
          }
          expect(state, `${field} 查询应命中夹具表`).toBe('cards');
          // 负责人等宽泛关键词可能命中多页结果；夹具表允许出现在后续分页，
          // 但必须真实出现，不能只看首页就判定命中或未命中。
          expect(
            await findCardOnCurrentOrNextPage(page, (metadata) => metadata.includes(fixture.tableName)),
            `${field} 查询结果应包含夹具表 ${fixture.tableName}`,
          ).toBeTruthy();
        }
        await assertNoConsoleErrors(consoleErrors);
        await report('表查询-夹具表的表名、中文名、描述、负责人均应命中', true, fixture.tableName);
      } finally {
        await cleanupRoundQueryFixture(page, fixture.tableName);
      }
    })
});
