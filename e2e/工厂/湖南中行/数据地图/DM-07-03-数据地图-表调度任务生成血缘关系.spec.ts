/**
 * 数据地图 — 表调度任务生成血缘关系 E2E 测试
 *
 * 已确认业务流：目标表上线则先下线 → 编辑目标表“任务调度” → 一次性粘贴无末尾
 * 分号的标准 SQL（INSERT INTO 目标 SELECT * FROM 源）→ 填写失败重试次数 →
 * 保存 → 回表管理将目标表上线 → 上线后等待 1 秒，在详情“数据血缘”验证源表和
 * 目标表。不去数据开发创建任务。
 *
 * 2026-09-23 清洁环境迁移（DS-PERM-84）：源表/目标表/调度任务/关系全部使用本轮
 * 唯一 UUID ASCII 命名（e2e_dm0703_src_/tgt_<uuid>，走配置中心 MySQL 主库数据源），
 * 不再复用共享 0920 基线表对或任何历史血缘/旧任务/
 * 113 数据。DS-PERM-95：finally 仅回收本轮表/任务/关系（下线 + 元数据行内删除 +
 * 物理 DROP），逐步尽力而为并完整收集清理失败，在用例结尾统一裁决——主体成功但
 * 清理未完全成功时聚合上抛使测试失败，主体失败时保留原错误并附带清理证据；
 * 不触碰业务表。若任务调度保存与目标表上线都真实成功、而接口/页面仍无血缘，
 * 按任务约定保留请求证据并定性产品 BUG，不得改写一条“额外正确的 SQL”掩盖失败。
 *
 * DS-PERM-107 同根修复：configureAutoLineage 的前置补表会过滤目标表
 * （ensureSqlReferencedTables），清洁环境下目标表不存在时 openTargetTaskSchedule
 * 直接失败；改用公共入口 configureExistingLineageStatement（显式 sourceTables +
 * MySQL 脚本类型），源表/目标表均先经页面建表链路（ensureLineageTable）实际创建
 * 并上线，再写入任务调度 SQL、保存并上线。
 */

import fs from 'node:fs';
import path from 'node:path';
import { test, expect, clickMenu, dbConfig, query, uuid } from '../utils.js';
import type {
  Locator,
  Page,
  Request as PlaywrightRequest,
  Response as PlaywrightResponse,
} from '@playwright/test';
import {
  assertNoUnexpectedLineageConsoleErrors,
  configureExistingLineageStatement,
  expectLineage,
  openTableLineage,
} from './血缘测试工具.js';


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
  for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
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
  const card = (await currentCards(page))[0];
  return card ?? skipForMissingEnvironment('表查询列表没有可用测试表卡片。');
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
  const baseUrl = page.url().split('#')[0];
  await page.goto(`${baseUrl}#/dataMap/tableQuery/tablesQuery`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/#\/dataMap\/tableQuery\/tablesQuery/);
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
// ---------------- 本轮资产回收（DS-PERM-84：finally 仅清本轮表/任务/关系） ----------------

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
    console.warn(`[dm0703][cleanup] ${detail}。`);
    dropErrors.push(detail);
    return dropErrors;
  }
  for (const name of droppable) {
    try {
      await query(`DROP TABLE IF EXISTS \`${name}\``);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[dm0703][cleanup] 本轮物理表 ${name} DROP 失败（尽力而为）：`, error);
      dropErrors.push(`物理表 ${name} DROP 失败：${message.slice(0, 240)}`);
    }
  }
  return dropErrors;
}

/** 表管理列表定位目标行（口径同 DM-07-01：首个可见输入框＝表名称筛选 + 查询）。 */
async function filterManageRowOnce(page: Page, tableName: string): Promise<Locator | undefined> {
  const filterInput = page.locator('input:visible:not([type="checkbox"]):not([type="radio"])').first();
  if (!(await filterInput.isVisible().catch(() => false))) return undefined;
  await filterInput.fill(tableName);
  const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
  if (await queryButton.isVisible().catch(() => false)) await queryButton.click();
  const row = page.locator(
    'tbody > tr:visible, .ant-table-tbody > tr:visible, .el-table__body-wrapper tr:visible, '
      + '[role="row"]:visible:not(:has([role="columnheader"]))',
  ).filter({ hasText: tableName }).first();
  return (await row.isVisible({ timeout: 4_000 }).catch(() => false)) ? row : undefined;
}

/** 打开“数据地图 → 表管理”；菜单失败时按已知 hash 兜底导航（回收属尽力而为）。 */
async function openManageList(page: Page): Promise<void> {
  try {
    await clickMenu(page, '数据地图', '表管理');
  } catch {
    const baseUrl = page.url().split('#')[0];
    await page
      .goto(`${baseUrl}#/dataMap/tableManage/tablesManage`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      .catch(() => undefined);
  }
  await page.waitForTimeout(800);
}

/** 行内操作入口定位（口径同 DM-07-02 rowAction：按钮 → 链接/文字/单元格兜底）。 */
async function findManageRowAction(row: Locator, name: RegExp): Promise<Locator | undefined> {
  const button = row.getByRole('button', { name }).last();
  if (await button.isVisible().catch(() => false)) return button;
  const linkish = row
    .locator('a:visible, [role="button"]:visible, .el-button:visible, .ant-btn:visible, td:visible')
    .filter({ hasText: name })
    .last();
  if (await linkish.isVisible().catch(() => false)) return linkish;
  return undefined;
}

/** 元数据行内“下线”尽力而为：已下线/无入口时静默返回（口径同血缘工具上线等待）。 */
async function takeRoundTableOffline(page: Page, tableName: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const row = await filterManageRowOnce(page, tableName);
    if (!row) return;
    const offline = await findManageRowAction(row, /^下\s*线$/);
    if (!offline) return;
    await offline.click({ force: true }).catch(() => undefined);
    const dialog = page.locator('[role="dialog"]:visible, .el-message-box:visible, .ant-modal:visible').last();
    const confirm = dialog.getByRole('button', { name: /^确\s*定$/ }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(1_000);
  }
}

/** 元数据行内“删除/移除”尽力而为：入口缺失或失败完整收集返回（本函数不抛出，UUID 命名可追溯）。 */
async function deleteRoundMetadataRows(page: Page, names: string[], runTag: string): Promise<string[]> {
  const stepErrors: string[] = [];
  for (const name of new Set(names)) {
    try {
      await openManageList(page);
      const row = await filterManageRowOnce(page, name);
      if (!row) continue; // 已不在列表＝无需回收
      const action = await findManageRowAction(row, /^删\s*除$|^移\s*除$/);
      if (!action) {
        const detail = `表管理未提供“${name}”删除/移除入口，元数据保留（UUID 命名可追溯）`;
        console.warn(`[dm0703][cleanup] ${detail}。`);
        stepErrors.push(detail);
        continue;
      }
      await action.click({ force: true }).catch(() => undefined);
      const dialog = page.locator('[role="dialog"]:visible, .el-message-box:visible, .ant-modal:visible').last();
      if (await dialog.isVisible().catch(() => false)) {
        const reason = dialog.getByRole('textbox', { name: /删除理由|删除原因/ }).last();
        if (await reason.isVisible().catch(() => false)) await reason.fill(`e2e-本轮清理-${runTag}`);
        const confirm = dialog.getByRole('button', { name: /^确\s*定$|^删\s*除$/ }).last();
        if (await confirm.isVisible().catch(() => false)) await confirm.click({ force: true }).catch(() => undefined);
      }
      await page.waitForTimeout(800);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[dm0703][cleanup] 本轮元数据“${name}”页面侧回收失败（尽力而为）：`, error);
      stepErrors.push(`元数据“${name}”页面侧回收失败：${message.slice(0, 240)}`);
    }
  }
  return stepErrors;
}

/**
 * finally 专用：仅回收本轮 UUID 自建表（下线 + 元数据行内删除 + 物理 DROP）。
 * DS-PERM-95：逐步尽力而为，任一项失败不中断其余步骤，失败完整收集并返回（本函数
 * 不抛出）；由用例结尾统一裁决——主体成功但清理未完全成功须 fail，主体失败保留原
 * 错误并附带清理证据。只按本轮 UUID 表名回收，不扩大匹配范围、不触碰非本轮对象。
 */
async function cleanupRoundLineageFixture(page: Page, names: string[], runTag: string): Promise<string[]> {
  const cleanupErrors: string[] = [];
  if (!names.length) return cleanupErrors;
  for (const name of new Set(names)) {
    try {
      await openManageList(page);
      await takeRoundTableOffline(page, name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[dm0703][cleanup] 本轮表“${name}”下线尝试失败（尽力而为）：`, error);
      cleanupErrors.push(`表“${name}”下线尝试失败：${message.slice(0, 240)}`);
    }
  }
  try {
    cleanupErrors.push(...(await dropRoundPhysicalTables(names)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[dm0703][cleanup] 本轮物理表回收步骤异常（尽力而为）：', error);
    cleanupErrors.push(`物理表回收步骤异常：${message.slice(0, 240)}`);
  }
  try {
    cleanupErrors.push(...(await deleteRoundMetadataRows(page, names, runTag)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[dm0703][cleanup] 本轮元数据回收步骤异常（尽力而为）：', error);
    cleanupErrors.push(`元数据回收步骤异常：${message.slice(0, 240)}`);
  }
  return cleanupErrors;
}


test.describe("DM-07-03｜数据地图｜表调度任务生成血缘关系", () => {
  // 血缘回写滞后时需三轮串行重读（openTableLineage 自带 3 次 + 兜底轮 +
  // expectLineage 默认 6 次），240s 可能被截断，放宽到 480s；超时只影响本轮
  // 等待时长，不改变通过/失败的真实判定。
  test.describe.configure({ timeout: 480_000 });
  test("DM-07-03｜数据地图｜表调度任务生成血缘关系", async ({ loginPage, consoleErrors, report }, testInfo) => {
    const page = loginPage;
    const runTag = uuid();

    // —— 关键接口证据采集（只读监听，不拦截、不修改任何请求）——
    // 任务约定：保存/上线真实成功但血缘仍为空时，必须保留请求证据定性产品 BUG。
    const evidence: string[] = [];
    const stamp = (): string => new Date().toISOString();
    const clip = (text: string): string => text.slice(0, 2_000);
    const onResponse = (response: PlaywrightResponse): void => {
      const url = response.url();
      let label = '';
      if (/\/job\/scheduler\/(?:updateTableJob|saveTableJob)/.test(url)) label = '任务调度保存';
      else if (/\/etljob\/selectEtlJobInfo/.test(url)) label = '表任务详情';
      else if (/selectJobLineage|\/lineage\//i.test(url)) label = '血缘图谱';
      if (!label) return;
      void response
        .text()
        .then(
          (body) => evidence.push(`[${stamp()}] ${label} 响应 ${response.status()} ${response.url()}\n${clip(body)}`),
          () => evidence.push(`[${stamp()}] ${label} 响应 ${response.status()} ${response.url()}\n<读取响应体失败>`),
        )
        .catch(() => undefined);
    };
    const onRequest = (request: PlaywrightRequest): void => {
      if (!/\/job\/scheduler\/(?:updateTableJob|saveTableJob)/.test(request.url())) return;
      evidence.push(
        `[${stamp()}] 任务调度保存 请求 ${request.method()} ${request.url()}\n${clip(request.postData() ?? '<无请求体>')}`,
      );
    };
    page.on('response', onResponse);
    page.on('request', onRequest);
    const dumpEvidence = (headline: string): void => {
      try {
        const file = path.join(process.cwd(), 'temp', `DM-07-03-血缘接口证据-${Date.now()}.md`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `# ${headline}\n\n${evidence.join('\n\n')}\n`, 'utf8');
        testInfo.attach('血缘接口证据', { path: file, contentType: 'text/markdown' });
      } catch {
        // 证据落盘失败不改变业务断言结果。
      }
    };

    // DS-PERM-84：源表/目标表/任务/关系全部本轮自建（UUID ASCII 唯一命名），
    // 不再复用共享 0920 基线，也不重建历史同名表；建表、任务调度与上线全部经
    // configureExistingLineageStatement（配置中心 MySQL 主库数据源）完成，仅影响
    // 本轮对象。DS-PERM-107：源/目标表均经页面建表链路实际创建并上线。
    const sourceTable = `e2e_dm0703_src_${runTag.slice(0, 6)}`;
    const targetTable = `e2e_dm0703_tgt_${runTag.slice(0, 6)}`;
    const roundTables = [sourceTable, targetTable];
    const sql = `INSERT INTO ${targetTable}\nSELECT * FROM ${sourceTable}`;
    // DS-PERM-95：先记录主体结果（mainFailed/mainError），finally 清理失败收集进
    // cleanupErrors；主体成功但清理未完全成功须 fail，主体失败保留原错误并附清理证据。
    let mainError: unknown;
    let mainFailed = false;
    const cleanupErrors: string[] = [];
    try {
      await configureExistingLineageStatement(page, {
        targetTable,
        sql,
        expectedNodes: [sourceTable, targetTable],
        expectedRelations: [],
        sourceTables: [sourceTable],
        scriptType: /^\s*MYSQL\s*$/i,
      });
      await report('本轮夹具自建', true, `源表=${sourceTable}；目标表=${targetTable}（本轮唯一新建并上线）`);

      // 已确认业务流：上线则先下线 → 编辑目标表“任务调度” → 一次性粘贴无末尾
      // 分号的标准 SQL → 填写失败重试次数 → 保存（校验请求体携带完整 SQL 且
      // 业务码成功）→ 回表管理将目标表上线（校验状态真实翻转）。
      await report(
        '任务调度保存与上线',
        true,
        `SQL：INSERT INTO ${targetTable} SELECT * FROM ${sourceTable}；脚本类型=MYSQL；失败重试次数=1`,
      );

      // 3) 上线后等待 1 秒，再从表查询打开详情“数据血缘”。
      await page.waitForTimeout(1_000);

      // 4) 三轮串行重读：openTableLineage 自带 3 次读取；血缘回写滞后再兜底 1 轮；
      //    expectLineage 默认重读 6 次。仍为空则按任务约定定性产品 BUG。
      try {
        await openTableLineage(page, targetTable);
      } catch (firstError) {
        await page.waitForTimeout(15_000);
        try {
          await openTableLineage(page, targetTable);
        } catch (secondError) {
          throw new Error(
            `产品BUG定性：目标表“${targetTable}”任务调度保存接口成功、表已上线，但源表/目标表` +
              `血缘图持续为空（三轮串行重读均无图谱）。首读：${String((firstError as Error).message).slice(0, 160)}` +
              `；末读：${String((secondError as Error).message).slice(0, 160)}。完整请求证据见附件“血缘接口证据”。`,
          );
        }
      }
      try {
        await expectLineage(page, {
          targetTable,
          sql,
          expectedNodes: [sourceTable, targetTable],
          expectedRelations: [],
        });
      } catch (error) {
        throw new Error(
          `产品BUG定性：目标表“${targetTable}”任务调度保存接口成功、表已上线，但血缘图未稳定展示` +
            `源表/目标表。${String((error as Error).message).slice(0, 240)} 完整请求证据见附件“血缘接口证据”。`,
        );
      }

      await assertNoUnexpectedLineageConsoleErrors(consoleErrors);
      await report('数据血缘-表任务调度生成关系', true, `任务 SQL：${sourceTable} → ${targetTable}`);
    } catch (error) {
      // DS-PERM-95：先落盘证据并记录主体错误，finally 清理完成后再统一裁决，
      // 避免清理异常掩埋主体失败。
      const headline = String((error as Error).message).replace(/\x1b\[[0-9;]*m/g, '');
      dumpEvidence(`DM-07-03 执行证据：${headline.slice(0, 120)}`);
      mainFailed = true;
      mainError = error;
    } finally {
      page.off('response', onResponse);
      page.off('request', onRequest);
      // DS-PERM-84/95：仅回收本轮自建表/任务/关系（下线 + 元数据行内删除 + 物理
      // DROP），逐步尽力而为并完整收集失败，不掩埋用例真实结果，不触碰非本轮对象。
      try {
        cleanupErrors.push(...(await cleanupRoundLineageFixture(page, roundTables, runTag)));
      } catch (cleanupCrash) {
        // 清理流程自身异常也按清理失败收集，保证 finally 不抛出、不覆盖主体错误。
        const message = cleanupCrash instanceof Error ? cleanupCrash.message : String(cleanupCrash);
        console.error('[dm0703][cleanup] 清理流程自身异常（按清理失败收集）：', cleanupCrash);
        cleanupErrors.push(`清理流程自身异常：${message.slice(0, 240)}`);
      }
    }
    // DS-PERM-95 统一裁决（口径同 DM-07-01 已验收 scoped-cleanup）：主体失败优先抛出
    // 并附带清理未完成说明（仅追加 message，不改变错误类型，保留 Playwright 对
    // test.skip/skipForMissingEnvironment 的 skip 判定）；主体通过但清理未完全成功也
    // 如实上抛，不伪造通过。
    if (mainFailed) {
      const note = cleanupErrors.length > 0
        ? `（另：本轮清理未完全成功：${cleanupErrors.join('；').slice(0, 600)}）`
        : '';
      if (mainError instanceof Error) mainError.message += note;
      throw mainError;
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        `DM-07-03 主体通过，但本轮自建资产清理未完全成功（如实上报；待人工复核本轮 UUID 表：${roundTables.join('、')}）：`
          + cleanupErrors.join('；'),
      );
    }
  });
});
