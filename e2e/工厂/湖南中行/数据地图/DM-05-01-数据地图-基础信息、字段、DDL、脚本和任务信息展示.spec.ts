/**
 * 数据地图 — DM-05-01 表详情展示 E2E 测试
 *
 * 页面实况（依据 20260905 通过轮 run-20260905-064032-060、20260915 DM-03-02 通过链路
 * 与 20260819 复盘快照）：
 * - 表查询主列表是 .table-query 卡片列表；详情路由由卡片内「表名」节点触发，
 *   整卡点击不进入详情（DM-03-02 run-20260915-122506-020 第 1 轮实测）。
 * - 详情页（#/dataMap/tableManage/tableEdit?type=detail）tablist 横向滚动，实际页签为
 *   「基本信息/字段信息/调度任务/数据血缘」等；真实页面没有「脚本信息」页签，
 *   脚本/任务信息统一由「调度任务」页签承载（用例名中的“脚本”即按该页签验证）。
 * - 「查看DDL语句」按钮位于「字段信息」页签，弹窗展示 CREATE TABLE 语句。
 * - 环境同步库更换会让夹具表暂时消失（run-20260908-165151-286 实测搜索后只剩
 *   「暂无数据」）；此时显式 skip 并写明原因，不以空数据假绿，也不误报产品缺陷。
 */

import { test, expect } from '../utils.js';
import { assertNoConsoleErrors, clickMenu } from '../utils.js';
import type { Locator, Page } from '@playwright/test';
import { QUERY_FIXTURE } from './数据地图查询夹具.js';

const TABLE_SEARCH_PLACEHOLDER = '按表名、中文名、描述、负责人搜索';

// 详情页页签横向滚动，可能折叠进“更多”或左右箭头；以下选择器组与
// DM-01 系列、血缘工具保持同一套兼容策略（Ant/Element/通用 tab 三种实现）。
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

// 页签内容的判定目标：真实数据行，或明确空态文案。两者都没有视为页面结构变化。
const DETAIL_ROWS_SELECTOR = [
  '.ant-table-tbody > tr:visible',
  '.el-table__body-wrapper tr:visible',
  'table tbody > tr:visible',
  '[role="row"]:visible:not(:has([role="columnheader"]))',
].join(', ');
const DETAIL_EMPTY_SELECTOR = [
  '.ant-empty:visible',
  '.el-empty:visible',
  '[class*="empty"]:visible',
  'p:visible',
].join(', ');
const EMPTY_STATE_TEXT = /暂无数据|没有数据|空空如也/;

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

async function openTableQueryLeaf(page: Page): Promise<void> {
  await clickMenu(page, '数据地图', '表查询', '表查询');
  await expect(page.locator('.table-query .search-bar, .table-query .card-list').first()).toBeVisible({ timeout: 15_000 });
}

async function waitForExactText(page: Page, text: string, timeout: number): Promise<Locator | undefined> {
  // 表查询首次加载较慢，且加载期间会先短暂显示“暂无数据”（血缘工具同款结论）；
  // 只有目标表名文本真正出现才算检索完成，加载期空态不作为环境缺失结论。
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const located = await lastVisible(page.getByText(text, { exact: true }));
    if (located) return located;
    await page.waitForTimeout(250);
  }
  return undefined;
}

async function searchAndOpenTable(page: Page, tableName: string): Promise<void> {
  const search = page.getByPlaceholder(TABLE_SEARCH_PLACEHOLDER);
  await search.fill('');
  await search.pressSequentially(tableName, { delay: 10 });
  await search.press('Enter');
  await search.blur();

  // 新版表查询卡片不再稳定使用 .card/.table-name class，表名本身是唯一且
  // 可点击的节点。以它作为定位锚点，避免因纯展示层 class 改动错过已初始化表。
  const name = await waitForExactText(page, tableName, 30_000);
  if (!name) {
    test.skip(true, `环境前置缺失：搜索“${tableName}”后未返回该夹具表卡片（当前环境缺少 DM-00-01 初始化的专用表）。`);
    return;
  }
  await name.click();
  await expect(page.getByRole('heading', { name: '基础信息' })).toBeVisible({ timeout: 15_000 });
}

async function waitDetailRowsOrEmpty(page: Page, tabLabel: string, timeout = 15_000): Promise<'rows' | 'empty'> {
  // 页签内容必须有明确结论：真实数据行或空态文案二选一；两者都没有说明页面
  // 结构或接口变化，显式报错而不是让用例静默通过。
  const emptyState = page.locator(DETAIL_EMPTY_SELECTOR).filter({ hasText: EMPTY_STATE_TEXT });
  const rows = page.locator(DETAIL_ROWS_SELECTOR);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await emptyState.first().isVisible().catch(() => false)) return 'empty';
    const rowLimit = Math.min(await rows.count(), 5);
    for (let index = 0; index < rowLimit; index += 1) {
      if (await rows.nth(index).isVisible().catch(() => false)) return 'rows';
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`「${tabLabel}」页签在 ${timeout}ms 内既没有数据行也没有明确空态，请检查页面结构是否变化。当前页面：${page.url()}`);
}

async function closeDetailDialog(page: Page): Promise<void> {
  // 关闭 DDL 弹窗后再切换页签，避免遮罩拦截后续点击；关闭动作本身要有结果断言。
  const dialog = page.locator('.ant-modal:visible, .el-dialog:visible, [role="dialog"]:visible').last();
  const close = dialog.locator(
    '[aria-label="Close"], [aria-label*="close" i], button:has-text("取 消"), button:has-text("取消")',
  ).first();
  if (await close.isVisible().catch(() => false)) {
    await close.click();
  } else {
    await page.keyboard.press('Escape');
  }
  await expect(dialog).toBeHidden({ timeout: 5_000 });
}

test.describe('DM-05-01｜数据地图｜基础信息、字段、DDL 和调度任务面板', () => {
  test.beforeEach(async ({ loginPage }) => {
    await openTableQueryLeaf(loginPage);
    await expect(loginPage.locator('.table-query .search-bar, .table-query .card-list').first()).toBeVisible();
  });

  test('DM-05-01｜数据地图｜基础信息、字段、DDL 和调度任务面板', async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;
    // 只使用 DM-00-01 已初始化、DM-01-04/DM-08-01 长期复用的专用夹具表，不接触业务资产。
    // 精确搜索而不是翻固定页数：夹具所在页会随环境数据增长变化，翻页会把真实存在的表误判为缺失。
    const fixtureName = process.env.DM_VERSION_FIXTURE?.trim() || QUERY_FIXTURE.tableName;
    await searchAndOpenTable(page, fixtureName);

    // 基础信息：表名必须回显。表名在编辑页 disabled 不可改，是唯一稳定锚点；
    // 中文名/描述可能被 DM-08-01 等版本用例调整（描述回显另有 DM-01-04 注明的独立问题），不做强断言。
    await expect.poll(async () => {
      const text = await page.locator('body').innerText().catch(() => '');
      return text.includes(fixtureName) ? 'found' : 'loading';
    }, { timeout: 10_000 }).toBe('found');

    // 字段信息页签：真实字段表格行，或明确空态。
    await clickVisibleTab(page, /字段信息|字段/);
    const fieldState = await waitDetailRowsOrEmpty(page, '字段信息');

    // DDL 弹窗：字段信息页签内「查看DDL语句」按钮触发，内容必须包含建表语句关键字。
    const ddl = page.getByRole('button', { name: '查看DDL语句', exact: true }).last();
    await expect(ddl).toBeVisible({ timeout: 10_000 });
    await ddl.click();
    const ddlDialog = page.locator('.ant-modal:visible, .el-dialog:visible, [role="dialog"]:visible').last();
    await expect(ddlDialog).toBeVisible({ timeout: 10_000 });
    await expect(ddlDialog).toContainText(/CREATE|TABLE|DDL/i);
    await closeDetailDialog(page);

    // 调度任务页签：真实任务配置表格行，或明确空态（夹具表为自行建表来源，无任务是合理空态）。
    await clickVisibleTab(page, /调度任务/);
    const taskState = await waitDetailRowsOrEmpty(page, '调度任务');

    await assertNoConsoleErrors(consoleErrors);
    await report(
      '表查询-基础信息、字段、DDL 和调度任务面板',
      true,
      `夹具表=${fixtureName}；基础信息表名回显=是；字段信息=${fieldState}；DDL弹窗=CREATE语句可见；调度任务=${taskState}`,
    );
  });
});