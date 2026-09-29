/**
 * 数据地图 — 表管理 E2E 测试
 *
 * 覆盖场景（参考 Excel「测试用例」Sheet）：
 *   行1  — 在表管理中按真实表来源和状态标签组合筛选，核对列表或明确空态
 *
 * 2026-09-22（DS-PERM-37 复位敏感修复）：删除了从未被本用例调用的
 * 新建表/编辑表残留代码（DATABASE_SOURCES、openCreateTable 等），
 * 其中包含已下线的 192.168.79.52/79.69 旧数据源名称；本用例不再
 * 依赖这些旧环境。行2/3/4/7/17/23 场景如需恢复，请基于当前数据源
 * 环境重新实现。
 *
 * 关键要求：
 *   1. 所有操作用 page. 浏览器操作（无 fetch/axios 等 API 调用）
 *   2. UUID 后缀隔离所有测试数据
 *   3. 控制台错误收集
 *   4. 选择器为通用匹配，接入真实环境后按页面校准（TODO[env] 标注）
 *   5.（DS-PERM-52）前置消费 DM-00-03 状态工件（temp/dm-matrix/fixture-state.json）：
 *      逐格核对已初始化的「来源×状态」，缺失时报告具体来源/状态与人工补救入口
 */

import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../utils.js';
import { assertNoConsoleErrors, clickMenu } from '../utils.js';
import type { Locator, Page } from '@playwright/test';

/**
 * 兼容不同表格实现的数据行定位。
 *
 * Ant Design / Element 的数据行通常位于 tbody 中；部分页面使用无 tbody
 * 的可访问性表格，因此补充 role=row，并排除 role=columnheader 所在的表头行。
 */
const tableRows = (page: Page) =>
  page.locator([
    'tbody > tr:visible',
    '.ant-table-tbody > tr:visible',
    '.el-table__body-wrapper tr:visible',
    '[role="row"]:visible:not(:has([role="columnheader"]))',
  ].join(', '));


// 数据地图里的“来源”是表的接入方式，不是 MySQL/OpenGauss/GBase 数据库连接类型。
// 当前页面实际展示五类来源；每类至少应有一个已准备的测试表，才能验证筛选生效。
const TABLE_SOURCE_FILTERS = ['自行建表', '数据集成', '文件接入', 'FTP文件接入', '数据采集'] as const;
const TABLE_STATUS_FILTERS: ReadonlyArray<{ name: string; matcher: RegExp }> = [
  { name: '物理表存在', matcher: /^物理表存在(?:\s*[（(]\s*\d+\s*[）)])?$/ },
  { name: '物理表存在&上线', matcher: /^物理表存在\s*&\s*上线(?:\s*[（(]\s*\d+\s*[）)])?$/ },
  { name: '物理表存在&下线', matcher: /^物理表存在\s*&\s*下线(?:\s*[（(]\s*\d+\s*[）)])?$/ },
  { name: '草稿', matcher: /^草稿(?:\s*[（(]\s*\d+\s*[）)])?$/ },
];

function skipForMissingEnvironment(message: string): never {
  throw new Error(`环境前置条件缺失：${message}`);
}

/**
 * DS-PERM-52：DM-00-03 落盘的状态工件最小消费结构（只声明本用例用到的字段）。
 * 工件缺省路径 temp/dm-matrix/fixture-state.json，键名 dmMatrix；
 * DM_MATRIX_TABLES 可注入同构 JSON，DM_MATRIX_STATE 可覆盖工件路径。
 */
interface DmMatrixTableEntry {
  tableName?: string;
  expectedStatus?: string;
  verifiedStatus?: string;
}

interface DmMatrixSourceState {
  prepared?: boolean;
  reason?: string;
  manualEnv?: string;
  tables?: DmMatrixTableEntry[];
}

interface DmMatrixState {
  runId?: string;
  createdAt?: string;
  gaps?: string[];
  sources?: Record<string, DmMatrixSourceState>;
}

const DM_MATRIX_STATE_PATH = process.env.DM_MATRIX_STATE?.trim()
  ? path.resolve(process.env.DM_MATRIX_STATE.trim())
  : path.resolve('temp', 'dm-matrix', 'fixture-state.json');

function loadDmMatrixState(): DmMatrixState | undefined {
  const inline = process.env.DM_MATRIX_TABLES?.trim();
  if (inline) {
    try {
      return JSON.parse(inline) as DmMatrixState;
    } catch (error) {
      throw new Error(`DM_MATRIX_TABLES 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    const raw = fs.readFileSync(DM_MATRIX_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { dmMatrix?: DmMatrixState };
    return parsed.dmMatrix;
  } catch {
    // 工件不存在或损坏：按“无 DM-00-03 前置”处理，不阻塞原有口径的报错。
    return undefined;
  }
}

/** 把 DM-00-03 对该来源的初始化结论拼进环境缺失报错，定位到具体原因与人工入口。 */
function describeMatrixGap(source: string, matrix: DmMatrixState | undefined): string {
  const sourceState = matrix?.sources?.[source];
  if (!sourceState) {
    return '；未找到 DM-00-03 初始化工件（temp/dm-matrix/fixture-state.json），请先串行运行 DM-00-03 准备矩阵夹具';
  }
  if (sourceState.prepared === false) {
    const reason = sourceState.reason ?? '原因未记录';
    const manual = sourceState.manualEnv ? `（人工入口：${sourceState.manualEnv}）` : '';
    return `；DM-00-03 初始化记录：该来源未准备——${reason}${manual}`;
  }
  const tables = (sourceState.tables ?? [])
    .filter((table) => table.tableName)
    .map((table) => `${table.tableName}(${table.expectedStatus ?? '状态未知'})`);
  return tables.length
    ? `；DM-00-03 已准备的表：${tables.join('、')}，请核对列表筛选或串行重跑 DM-00-03`
    : '';
}

/**
 * 打开表管理实际页面。
 *
 * 第二轮页面快照表明当前版本侧栏只渲染“表管理”折叠项，真实链接是
 * `#/dataMap/tableManage`；页面中并不存在可见的
 * `a[href="#/dataMap/tableManage/tablesManage"]`。先按实际侧栏展开，
 * 再优先点击真实出现的子链接；没有子链接时父路由本身就是列表页。
 */
async function openTableManageLeaf(page: Page): Promise<void> {
  // 真实录制确认表管理列表路由；直接进入可避免侧栏动画/同名“表管理”误点。
  const baseUrl = page.url().split('#')[0];
  await page.goto(`${baseUrl}#/dataMap/tableManage/tablesManage`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  return;
  // 先进入顶层“数据地图”，再按真实叶子 href 进入 tablesManage。
  // 这里不再依赖“表管理→表管理”的同名文字层级：侧栏展开由接口异步返回，
  // 直接等待叶子 href 可见可以避免菜单尚未渲染或已展开时的误点/收起。
  await clickMenu(page, '数据地图');
  const tableListChild = page.locator(
    'a:visible[href*="#/dataMap/tableManage/tablesManage"], ' +
      '[role="menuitem"]:visible a[href*="#/dataMap/tableManage/tablesManage"]',
  ).last();
  if (!(await tableListChild.isVisible().catch(() => false))) {
    const submenuTitle = page
      .locator('.el-submenu__title:visible, .ant-menu-submenu-title:visible, [role="menuitem"]:visible')
      .filter({ hasText: /^\s*表管理\s*$/ })
      .last();
    await expect(submenuTitle).toBeVisible({ timeout: 10_000 });
    await submenuTitle.click();
    await page.waitForTimeout(500);
  }
  await expect(tableListChild).toBeVisible({ timeout: 15_000 });
  await tableListChild.click();

  if (!/#\/dataMap\/tableManage(?:\/tablesManage)?/.test(page.url())) {
    await page.waitForURL(/#\/dataMap\/tableManage(?:\/tablesManage)?/, { timeout: 10_000 });
  }
  await page.waitForTimeout(500);
}


/**
 * 页面页签的 DOM 结构不固定：可能是 Ant/Element 的 Tab，也可能只有 role=tab。
 * 统一从“真实 Tab 容器”中匹配，避免 getByText(...).first() 命中隐藏模板或正文文本。
 */
const TAB_SELECTORS = [
  '[role="tab"]',
  '.ant-tabs-tab',
  '.el-tabs__item',
  '[class*="tab-item"]',
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
].join(', ');

const TAB_FALLBACK_SELECTORS = [
  'button',
  'a',
  'li',
  '[role="tab"]',
  '[role="option"]',
  '[class*="tab"]',
].join(', ');

function tabTextMatches(actual: string, expected: string | RegExp): boolean {
  const normalized = actual.replace(/\s+/g, ' ').trim();
  if (typeof expected === 'string') return normalized === expected;
  expected.lastIndex = 0;
  const matched = expected.test(normalized);
  expected.lastIndex = 0;
  return matched;
}

async function findVisibleText(locator: Locator, text: string | RegExp): Promise<Locator | undefined> {
  for (let index = await locator.count() - 1; index >= 0; index--) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const actual = await candidate.innerText().catch(() => '');
    if (tabTextMatches(actual, text)) return candidate;
  }
  return undefined;
}

async function findVisibleTab(page: Page, text: string | RegExp): Promise<Locator | undefined> {
  const directTab = await findVisibleText(page.locator(TAB_SELECTORS), text);
  if (directTab) return directTab;
  const popupTab = await findVisibleText(page.locator(TAB_POPUP_SELECTORS), text);
  if (popupTab) return popupTab;

  // 表管理的来源切换在当前版本不是 role=tab，而是单选按钮：
  // radio “自行建表/数据集成/文件接入/FTP文件接入”。对外仍按 Tab 语义处理，
  // 这样既兼容实际 DOM，也能继续复用隐藏项展开逻辑。
  const radioTabs = page.getByRole('radio', { name: text });
  for (let index = await radioTabs.count() - 1; index >= 0; index -= 1) {
    const radio = radioTabs.nth(index);
    if (await radio.isVisible().catch(() => false)) return radio;
  }

  // radio 的可访问名称在不同 Chromium/组件版本中可能无法被
  // getByRole 稳定解析，但其旁边的可见文字始终存在；点击文字会冒泡到
  // 组件的单选容器，适配当前页面的真实 DOM。
  const textCandidates = typeof text === 'string'
    ? page.getByText(text, { exact: true })
    : page.getByText(text);
  for (let index = await textCandidates.count() - 1; index >= 0; index -= 1) {
    const candidate = textCandidates.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }

  // 某些页面没有 role=tab/class，只在可见 Tab 容器中渲染 button/a/li。
  const containers = page.locator(TAB_CONTAINER_SELECTORS);
  for (let index = await containers.count() - 1; index >= 0; index--) {
    const container = containers.nth(index);
    if (!(await container.isVisible().catch(() => false))) continue;
    const fallbackTab = await findVisibleText(container.locator(TAB_FALLBACK_SELECTORS), text);
    if (fallbackTab) return fallbackTab;
  }
  return undefined;
}

async function findVisibleTabOverflow(page: Page): Promise<Locator | undefined> {
  // Ant 的 nav-more 通常只有图标，没有“更多”文字，不能用文本匹配判断。
  const direct = page.locator(TAB_OVERFLOW_SELECTORS);
  for (let index = await direct.count() - 1; index >= 0; index--) {
    const candidate = direct.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }

  const containers = page.locator(TAB_CONTAINER_SELECTORS);
  for (let index = await containers.count() - 1; index >= 0; index--) {
    const container = containers.nth(index);
    if (!(await container.isVisible().catch(() => false))) continue;
    const candidates = container.locator(
      '[class*="more"], [class*="More"], [aria-label*="更多"], [title*="更多"], ' +
      '[aria-label*="more" i], [title*="more" i], button, [role="button"], span, a',
    );
    for (let candidateIndex = await candidates.count() - 1; candidateIndex >= 0; candidateIndex--) {
      const candidate = candidates.nth(candidateIndex);
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

/** 点击真实可见 Tab；若目标在“更多/…”中，先展开对应 Tab 溢出菜单。 */
async function clickVisibleTab(page: Page, text: string | RegExp): Promise<void> {
  const deadline = Date.now() + 10_000;
  let overflowOpened = false;
  while (Date.now() < deadline) {
    const tab = await findVisibleTab(page, text);
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
    await page.waitForTimeout(200);
  }
  throw new Error(`页签“${text}”未找到可见节点或“更多”入口，当前页面：${page.url()}`);
}

async function clickVisibleButton(page: Page, name: string | RegExp): Promise<void> {
  const buttons = page.getByRole('button', { name });
  for (let index = await buttons.count() - 1; index >= 0; index -= 1) {
    const button = buttons.nth(index);
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      return;
    }
  }
  throw new Error(`按钮“${name}”未找到可见节点，当前页面：${page.url()}`);
}

async function waitForManageListState(page: Page): Promise<'rows' | 'empty'> {
  const emptyStates = page.getByText(/暂无数据|没有数据|空空如也/);
  await expect.poll(async () => {
    if (await tableRows(page).count()) return 'rows';
    for (let index = await emptyStates.count() - 1; index >= 0; index -= 1) {
      if (await emptyStates.nth(index).isVisible().catch(() => false)) return 'empty';
    }
    // Ant/Element 空态在部分版本只给容器 class，不给稳定的可访问文本节点；
    // 以可见空态容器和页面可见文字作双重兜底，避免把真实空态误判成 loading。
    if (await page.locator('.ant-empty:visible, .el-empty:visible, [class*="empty"]:visible').count()) {
      return 'empty';
    }
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (/暂无数据|没有数据|空空如也/.test(bodyText)) return 'empty';
    return 'loading';
  }, { timeout: 10_000 }).toMatch(/rows|empty/);
  return (await tableRows(page).count()) ? 'rows' : 'empty';
}

test.describe("DM-01-01｜数据地图｜表来源与状态标签组合查询", () => {
  test.beforeEach(async ({ loginPage }) => {
    await openTableManageLeaf(loginPage);
  })
  test("DM-01-01｜数据地图｜表来源与状态标签组合查询", async ({ loginPage, consoleErrors, report }) => {
      test.setTimeout(180_000);
      const page = loginPage;
      const observed: string[] = [];
      // DS-PERM-52：读取 DM-00-03 落盘的初始化工件（缺省 temp/dm-matrix/fixture-state.json）。
      const matrix = loadDmMatrixState();

      for (const source of TABLE_SOURCE_FILTERS) {
        let sourceHasRows = false;
        for (const status of TABLE_STATUS_FILTERS) {
          await openTableManageLeaf(page);
          await clickVisibleTab(page, status.matcher);
          await clickVisibleTab(page, source);
          const state = await waitForManageListState(page);
          const count = await tableRows(page).count();
          sourceHasRows ||= state === 'rows' && count > 0;
          observed.push(`${source}/${status.name}:${state === 'rows' ? `${count}条` : '空态'}`);
        }
        if (!sourceHasRows) {
          skipForMissingEnvironment(
            `来源“${source}”在四个状态标签下均无测试表；请先通过该来源准备一张表后复测`
            + describeMatrixGap(source, matrix) + '。',
          );
        }
      }

      // DS-PERM-52：逐格核对 DM-00-03 工件声明的「来源×状态」表是否真的命中，
      // 避免“来源整体有表、但某状态格缺表”被整体断言吞掉。
      if (matrix) {
        const missingCells: string[] = [];
        for (const source of TABLE_SOURCE_FILTERS) {
          for (const table of matrix.sources?.[source]?.tables ?? []) {
            if (!table.tableName || !table.expectedStatus) continue;
            const observedCell = observed.find((line) => line.startsWith(`${source}/${table.expectedStatus}:`));
            if (observedCell?.endsWith('空态')) {
              missingCells.push(`${source}/${table.expectedStatus}：DM-00-03 已初始化表 ${table.tableName} 但列表为空`);
            }
          }
        }
        if (missingCells.length) {
          skipForMissingEnvironment(
            `DM-00-03 已初始化但矩阵未命中：${missingCells.join('；')}；请串行重跑 DM-00-03（headed --workers=1）后复测`,
          );
        }
      }

      await assertNoConsoleErrors(consoleErrors);
      await report('数据地图表来源与状态标签组合查询', true, observed.join('；'));
    })
});
