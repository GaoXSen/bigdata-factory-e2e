/**
 * 数据查询 — 自助查询 E2E 测试
 *
 * 覆盖场景（参考 Excel「测试用例」Sheet，序号对应 1～73）：
 *   行46/47 — 选择数据源：数据源类型 → 数据源 → 展示其下所有数据库/schema/表
 *   行48 — SQL 查询：不选 schema 可查当前连接 schema 下表；选错 schema 查询报错
 *   行49 — 历史会话与脚本管理：历史会话仅当前用户可见；文件夹/脚本增删改；脚本增删改不影响执行记录
 *   行50 — 结果下载：右下角历史记录、下载结果、下载大文件（>1000 条）
 *   行51 — 查询管理：所有用户执行记录；kill 长时间未结束的 sqlsession
 *
 * 扩展（测试用例编写规范.md 覆盖深度）：
 *   - 边界值：SQL 语法错误提示、空 SQL 执行
 *   - 权限：历史会话仅当前用户可见（换账号验证）
 *
 * 关键要求：
 *   1. 所有操作用 page. 浏览器操作（无 fetch/axios 等 API 调用）
 *   2. UUID 后缀隔离所有测试数据
 *   3. 控制台错误收集；选择器 TODO[env] 校准
 */

import { access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { Download, Locator, Page } from '@playwright/test';
import { test, expect, uuid } from '../utils.js';
import { assertNoUnexpectedConsoleErrors, chooseConfiguredDataSource, executeSql, openSelfServiceQuery, tableRows } from '../utils.js';
import {
  loginAs,
} from '../系统管理/权限测试工具.js';

// 下载接口会先提交异步任务，再由浏览器接收文件；只放宽本用例的上限，不能改变全局 timeout。
const RESULT_DOWNLOAD_TIMEOUT = 180_000;
const CONFIGURED_SOURCE = { type: process.env.QUERY_SOURCE_TYPE?.trim() || 'MYSQL', name: process.env.QUERY_SOURCE_NAME?.trim() || '192.168.76.110:13306/e2e_test' };
const CONFIGURED_SCHEMA = process.env.QUERY_SCHEMA?.trim() || 'e2e_test';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactText(text: string): RegExp {
  return new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`);
}

async function firstVisible(candidates: Locator[], timeout = 0): Promise<Locator | undefined> {
  const deadline = Date.now() + timeout;
  do {
    for (const candidate of candidates) {
      const count = await candidate.count();
      // 结果面板、弹窗和抽屉经常保留同名隐藏节点，倒序优先当前可见实例。
      for (let index = count - 1; index >= 0; index--) {
        const item = candidate.nth(index);
        if (await item.isVisible().catch(() => false)) return item;
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (true);
  return undefined;
}

async function clickVisibleText(page: Page, text: string): Promise<void> {
  const target = await firstVisible([
    page.locator('button:visible, a:visible, label:visible, [role="button"]:visible, [role="tab"]:visible')
      .filter({ hasText: exactText(text) }),
    page.getByText(text, { exact: true }).filter({ visible: true }),
  ], 10_000);
  if (!target) throw new Error(`可见文本“${text}”未找到，当前页面：${page.url()}`);
  await target.click();
  await page.waitForTimeout(500);
}

async function clickVisibleButton(page: Page, name: RegExp): Promise<void> {
  const target = await firstVisible([
    page.getByRole('button', { name }).filter({ visible: true }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: name }),
  ], 10_000);
  if (!target) throw new Error(`可见按钮“${name}”未找到，当前页面：${page.url()}`);
  await target.click();
  await page.waitForTimeout(500);
}

async function clickVisibleResultTab(page: Page, text: string): Promise<void> {
  const target = await firstVisible([
    page.locator(
      '[role="tab"]:visible, .ant-tabs-tab:visible, .el-tabs__item:visible, .el-tab-pane:visible button:visible',
    ).filter({ hasText: exactText(text) }),
    page.getByText(text, { exact: true }).filter({ visible: true }),
  ], 10_000);
  if (!target) throw new Error(`结果 Tab“${text}”未找到，当前页面：${page.url()}`);
  await target.click();
  await page.waitForTimeout(800);
}

async function clickVisibleHistoryTab(page: Page): Promise<void> {
  const names = ['历史会话', '运行历史', '历史记录'];
  const tabSelector = '[role="tab"]:visible, .ant-tabs-tab:visible, .el-tabs__item:visible';

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const direct = await firstVisible(
      names.flatMap((name) => [
        page.locator(tabSelector).filter({ hasText: exactText(name) }),
        page.getByText(name, { exact: true }).filter({ visible: true }),
      ]),
      1_000,
    );
    if (direct) {
      await direct.click();
      await page.waitForTimeout(800);
      return;
    }

    // 窄窗口下 Ant/Element 会把左侧 Tab 收进“更多”；只在 Tab 操作区内查找，
    // 避免误点顶部主菜单的“更多”。
    const more = await firstVisible([
      page.locator('.ant-tabs-nav-operations .ant-tabs-nav-more:visible'),
      page.locator('.el-tabs__nav-more:visible, .el-tabs__dropdown:visible'),
      page.locator('[role="tablist"]:visible').locator('[aria-label*="更多"]:visible, [title*="更多"]:visible, [aria-label="···"]:visible, [title="···"]:visible'),
    ], 1_000);
    if (more) {
      await more.click();
      const popup = page.locator(
        '.ant-tabs-dropdown:visible, .ant-dropdown:visible, .el-tabs__dropdown-menu:visible, .el-dropdown-menu:visible, [role="menu"]:visible',
      );
      const hidden = await firstVisible(
        names.flatMap((name) => [
          popup.getByRole('menuitem', { name, exact: true }),
          popup.getByText(name, { exact: true }),
        ]),
        2_000,
      );
      if (hidden) {
        await hidden.click();
        await page.waitForTimeout(800);
        return;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`历史 Tab 未找到（已检查“历史会话/运行历史/历史记录”及 Tab 更多菜单），当前页面：${page.url()}`);
}

/**
 * 数据源选择失败时只对已确认的“下拉项/Schema 不存在”分支跳过；其它错误继续抛出，
 * 避免把真实定位或服务问题伪装成环境阻断。
 */
async function chooseConfiguredDataSourceOrSkip(
  page: Page,
  options: { schema?: string | false },
): Promise<boolean> {
  try {
    await chooseConfiguredDataSource(page, {
      ...CONFIGURED_SOURCE,
      schema: options.schema,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingType = message.includes(`下拉选项“${CONFIGURED_SOURCE.type}”未找到`);
    const missingSource = message.includes(`下拉选项“${CONFIGURED_SOURCE.name}”未找到`);
    const missingSchema = message.includes('当前数据源没有可选 Schema') ||
      (typeof options.schema === 'string' && message.includes(`下拉选项“${options.schema}”未找到`));
    if (missingType || missingSource || missingSchema) {
      const missing = missingType
        ? `数据源类型 ${CONFIGURED_SOURCE.type}`
        : missingSource
          ? `数据源 ${CONFIGURED_SOURCE.name}`
          : `Schema ${options.schema || '默认 Schema'}`;
      throw new Error( `环境前置条件缺失：未提供 ${missing}，无法完成真实连接/Schema 选择。`);
      return false;
    }
    throw error;
  }
}

async function assertConfiguredSourceAndSchema(page: Page, schema: string): Promise<boolean> {
  // 新同步环境可能在页面展示名后追加业务库/项目后缀；校验类型和配置名称前缀。
  const sourceNamePattern = new RegExp(
    `^\\s*${escapeRegExp(CONFIGURED_SOURCE.type)}\\s*/\\s*${escapeRegExp(CONFIGURED_SOURCE.name)}`,
    'i',
  );
  const source = await firstVisible([
    page.locator('.datasource-select:visible').filter({ hasText: sourceNamePattern }),
    page.getByText(sourceNamePattern).filter({ visible: true }),
  ], 10_000);
  if (!source) throw new Error(`已选择数据源文本未找到，当前页面：${page.url()}`);
  const selectedSourceText = (await source.innerText()).replace(/\\s+/g, ' ').trim();
  if (!sourceNamePattern.test(selectedSourceText)) {
    throw new Error(`已选择数据源与配置不一致，实际为“${selectedSourceText}”。`);
  }

  const schemaBox = await firstVisible([
    page.locator('[role="combobox"]:visible').last(),
  ], 10_000);
  if (!schemaBox) {
    throw new Error( `环境前置条件缺失：数据源 ${CONFIGURED_SOURCE.name} 未提供可选择的 Schema ${schema}。`);
    return false;
  }
  const selectedSchema = (await schemaBox.innerText()).trim();
  if (!selectedSchema.includes(schema)) {
    throw new Error( `环境前置条件缺失：目标 Schema ${schema} 未被真实选中，当前值为“${selectedSchema}”。`);
    return false;
  }

  // 真实页面的左侧数据库树在部分版本不提供 role=treeitem；同时保留 Schema 下拉框文本。
  // 只接受不在 combobox 内的可见 Schema 文本，避免把下拉框值误判成树节点。
  const schemaTexts = page.getByText(schema, { exact: true }).filter({ visible: true });
  let schemaNode: Locator | undefined;
  for (let index = 0; index < await schemaTexts.count(); index += 1) {
    const candidate = schemaTexts.nth(index);
    const inCombobox = candidate.locator('xpath=ancestor-or-self::*[@role="combobox"]');
    if (!(await inCombobox.count())) {
      schemaNode = candidate;
      break;
    }
  }
  if (!schemaNode) {
    throw new Error( `环境前置条件缺失：数据源 ${CONFIGURED_SOURCE.name} 下没有目标 Schema ${schema} 的树节点/表资源。`);
    return false;
  }  return true;
}

async function waitForQueryResult(page: Page, marker: string): Promise<boolean> {
  const result = await firstVisible([
    tableRows(page).filter({ hasText: marker }),
    page.getByText(marker, { exact: true }).filter({ visible: true }),
  ], 10_000);
  if (result) return true;
  throw new Error( `环境前置条件缺失：目标查询结果“${marker}”未返回，无法继续验证历史/下载。`);
  return false;
}

async function findHistoryRowBySql(page: Page, sql: string): Promise<Locator | undefined> {
  return firstVisible([
    page.getByRole('row').filter({ hasText: sql }),
    page.locator('tr:visible').filter({ hasText: sql }),
  ], 10_000);
}

async function expandTreeItem(page: Page, text: string): Promise<Locator | undefined> {
  const deadline = Date.now() + 10_000;
  const matcher = new RegExp(escapeRegExp(text));
  while (Date.now() < deadline) {
    const rows = page.getByRole('treeitem', { name: matcher });
    const count = await rows.count().catch(() => 0);
    // 脚本树保存后会整体刷新；每轮重新取 Locator，不能复用刷新前的节点句柄。
    for (let index = count - 1; index >= 0; index -= 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) continue;
      try {
        await row.scrollIntoViewIfNeeded({ timeout: 800 });
        const expanded = await row.getAttribute('aria-expanded', { timeout: 800 });
        const className = await row.getAttribute('class', { timeout: 800 });
        if (expanded === 'false' || className?.includes('switcher-close')) {
          const switcher = row.locator('.ant-tree-switcher, [role="button"]').first();
          if (await switcher.count()) await switcher.click({ timeout: 1_000 });
          else await row.click({ timeout: 1_000 });
          await page.waitForTimeout(500);
        }
        return row;
      } catch {
        // 本轮正好碰到树刷新，丢弃这个节点，下一轮重新定位。
      }
    }
    await page.waitForTimeout(250);
  }
  return undefined;
}

/**
 * 打开自助查询底部黑色控制台里的运行历史。
 *
 * 页面有两个容易混淆的入口：左侧“历史会话”是会话树，底部“查询结果”
 * 右上角的时钟才是当前 SQL 的运行历史（并包含下载 CSV 等操作）。窄窗口
 * 或结果面板折叠时，底部只显示一个向上箭头，需要先展开结果面板。
 */
async function openQueryResultHistory(page: Page): Promise<void> {
  const expandResultPanel = await firstVisible([
    page.locator('[aria-label="图标: up"]:visible'),
    page.locator('[title*="展开"]:visible, [aria-label*="展开"]:visible'),
  ], 2_000);
  if (expandResultPanel) {
    await expandResultPanel.click();
    await page.waitForTimeout(500);
  }

  const resultTitle = await firstVisible([
    page.getByText('查询结果', { exact: true }).filter({ visible: true }),
  ], 10_000);
  if (!resultTitle) {
    throw new Error(`底部“查询结果”面板未展开，无法打开运行历史，当前页面：${page.url()}`);
  }

  // 真实页面结构：查询结果标题的同级工具栏依次是导出、历史（时钟）、刷新。
  // 只在该工具栏内取 history，避免误点编辑器顶部的 clock-circle。
  const resultToolbar = resultTitle.locator('..');
  const historyButton = await firstVisible([
    resultToolbar.locator('[aria-label="图标: history"]:visible'),
    resultToolbar.locator('[aria-label="图标: clock-circle"]:visible'),
    resultToolbar.locator('[title*="历史"]:visible, [aria-label*="历史"]:visible'),
  ], 5_000);
  if (!historyButton) {
    throw new Error(`“查询结果”面板右上角运行历史时钟未找到，当前页面：${page.url()}`);
  }
  await historyButton.click();
  await page.waitForTimeout(800);
}

async function openRunHistory(page: Page): Promise<void> {
  await openQueryResultHistory(page);
}

async function assertReadableDownload(download: Download, label: string): Promise<void> {
  const failure = await download.failure();
  expect(failure, `${label}下载失败`).toBeNull();

  const filePath = await download.path();
  if (!filePath) throw new Error(`${label}下载未生成本地文件路径。`);

  await access(filePath, fsConstants.R_OK);
  const fileInfo = await stat(filePath);
  expect(fileInfo.isFile(), `${label}下载结果不是文件：${filePath}`).toBe(true);
  expect(fileInfo.size, `${label}下载结果为空文件：${filePath}`).toBeGreaterThan(0);
}

/**
 * 查询管理不在自助查询页的默认侧栏中，需先重新展开“数据查询”菜单；
 * 当前账号若没有该菜单则按权限/环境前置条件跳过，不把缺菜单误报成定位失败。
 */
async function openQueryManagement(page: Page): Promise<boolean> {
  const directCandidates = [
    page.getByRole('menuitem', { name: '查询管理', exact: true }),
    page.getByRole('link', { name: '查询管理', exact: true }),
    page.locator('.ant-menu-item:visible, .el-menu-item:visible, a:visible').filter({ hasText: /^\s*查询管理\s*$/ }),
    page.getByText('查询管理', { exact: true }),
  ];
  const overflowCandidates = [
    page.getByRole('button', { name: /^(?:更多|···|…|\.\.\.)$/ }),
    page.getByRole('menuitem', { name: /^(?:···|…|\.\.\.)$/ }),
    page.locator('[aria-label*="更多"]:visible, [title*="更多"]:visible'),
    page.getByText('更多', { exact: true }),
  ];

  for (let attempt = 0; attempt < 6; attempt++) {
    const direct = await firstVisible(directCandidates, 700);
    if (direct) {
      await direct.click();
      await page.waitForTimeout(800);
      return true;
    }

    // 先点顶部“数据查询”重新触发侧栏渲染，再检查侧栏叶子项。
    if (attempt === 0) {
      const topQuery = await firstVisible([
        page.getByRole('menuitem', { name: '数据查询', exact: true }),
        page.locator('.ant-menu-item:visible, .el-menu-item:visible').filter({ hasText: /^\s*数据查询\s*$/ }),
      ], 1_000);
      if (topQuery) {
        await topQuery.click();
        await page.waitForTimeout(800);
        continue;
      }
    }

    const overflow = await firstVisible(overflowCandidates, 700);
    if (overflow) {
      await overflow.click();
      await page.waitForTimeout(500);
    } else {
      await page.waitForTimeout(400);
    }
  }
  return false;
}
test.describe("DQ-05-01｜数据查询｜查询所有用户记录并终止长时间会话", () => {
  test.beforeEach(async ({ loginPage }, testInfo) => {
    // 本用例要在主会话之外再用第二个独立浏览器登录管理员、执行 SLEEP(90) 长会话，
    // 然后进入“查询管理”定位并终止该会话，全程远超全局默认 30s。
    // 超时必须在 beforeEach 开始前调高；仅在用例正文中 test.setTimeout
    // 会来不及覆盖慢速登录/菜单导航。（原先从行49复制来的标题条件对本用例永不生效。）
    testInfo.setTimeout(300_000);
    await openSelfServiceQuery(loginPage);
  })
  test("DQ-05-01｜数据查询｜查询所有用户记录并终止长时间会话", async ({ loginPage, consoleErrors, report, browser }) => {
      const page = loginPage;

      // 只创建本用例独有的可终止长会话。禁止挑选、终止页面既有会话，
      // 否则会影响人工调试或其他自动化用例。
      const marker = `e2e_kill_${uuid()}`;
      const administrator = {
        // 管理员身份必须显式提供：去掉 'admin' 兜底，缺 TEST_USER 视为环境前置不足。
        userName: (process.env.TEST_USER ?? '').trim(),
        nickname: (process.env.TEST_USER ?? '').trim(),
        password: (process.env.TEST_PASS ?? '').trim(),
        phone: '',
        email: '',
      };
      if (!administrator.userName) throw new Error('缺少 TEST_USER，无法在独立浏览器上下文创建本轮长会话。');
      if (!administrator.password) throw new Error('缺少 TEST_PASS，无法在独立浏览器上下文创建本轮长会话。');
      const secondaryContext = await browser.newContext();
      const secondaryPage = await secondaryContext.newPage();
      try {
        // 使用管理员的第二个独立浏览器会话：测试的是“查询管理能否发现并终止
        // 自己创建的会话”，不应额外依赖普通用户的数据源数据权限。
        await loginAs(secondaryPage, administrator);
        await openSelfServiceQuery(secondaryPage);
        await chooseConfiguredDataSourceOrSkip(secondaryPage, { schema: CONFIGURED_SCHEMA });
        await executeSql(secondaryPage, `SELECT SLEEP(90) AS ${marker}`);

        if (!(await openQueryManagement(page))) {
          throw new Error('当前管理员账号未提供“查询管理”菜单，无法验证仅终止本轮会话。');
        }
        const targetRow = await firstVisible([
          tableRows(page).filter({ hasText: marker }),
          page.locator('tr:visible, [class*="table-row"]:visible').filter({ hasText: marker }),
        ], 30_000);
        if (!targetRow) {
          throw new Error(`真实业务BUG：查询管理未展示本轮长会话“${marker}”，无法执行安全终止验证。`);
        }
        // 终止目标绑定凭据：确认弹窗正文只引用行的“名称”单元格（SQL<开始时间>），
        // 不含 UUID 标记（标记在“sql语句”列），因此必须先读名称用于弹窗锚定。
        // 读不到名称就不能证明终止目标只属于本轮，直接失败而不是盲点确认。
        const targetRowName = ((await targetRow
          .locator('td, [role="cell"], [role="gridcell"]')
          .first()
          .innerText()
          .catch(() => '')).trim())
          || (await targetRow.innerText().catch(() => '')).split('\n')[0]?.trim()
          || '';
        if (!targetRowName) {
          throw new Error(`无法读取目标行“${marker}”的名称单元格，不能安全绑定 kill 确认弹窗。`);
        }
        const killBtn = await firstVisible([
          targetRow.getByRole('button', { name: /kill|结束|终止/i }),
          targetRow.locator('button:visible, [role="button"]:visible, a:visible').filter({ hasText: /kill|结束|终止/i }),
          // 当前页面将 kill 渲染为无 role 的文字链接，且仅在“运行中”行展示。
          // 目标行已经以 UUID 标记核对过，使用全页精确文本不会误终止历史会话。
          page.getByText(/^kill$/i).filter({ visible: true }),
        ], 10_000);
        if (!killBtn) {
          throw new Error(`真实业务BUG：查询管理展示了本轮长会话“${marker}”，但该行没有“终止/Kill”操作。`);
        }
        await killBtn.click();
        // 确认弹窗为 Ant Modal：标题“确认 kill？”、正文“确定终止查询「<行名称>」吗？”，
        // 按钮为“取 消/确 定”（Ant 两字按钮插入空格）。确认必须同时满足标题与目标行
        // 名称，并只在该弹窗作用域内点“确 定”——原先全页 `.last()` 会把候选钉死在
        // DOM 最后一个同名节点上（弹窗关闭后节点仍保留），一旦尾部存在隐藏的“确 定”，
        // firstVisible 判其不可见便静默返回 undefined，确认滞留导致后续刷新点击被
        // ant-modal-wrap 遮罩拦截超时（run-20260929-002954-565 实测）。
        const killDialog = page
          .locator('[role="dialog"]:visible, .ant-modal-wrap:visible')
          .filter({ hasText: /确\s*认\s*kill/i })
          .filter({ hasText: targetRowName });
        const confirm = await firstVisible([
          killDialog.getByRole('button', { name: /^确\s*定$/ }),
          killDialog.locator('button:visible, [role="button"]:visible').filter({ hasText: /^确\s*定$/ }),
        ], 5_000);
        if (!confirm) {
          throw new Error(`kill 确认弹窗未出现或未引用目标行“${targetRowName}”，拒绝在未确认绑定的情况下继续，当前页面：${page.url()}`);
        }
        await confirm.click();

        // 终止生效必须以目标行状态变化为准（整改项5）：原先的 /成功|已结束|已终止/
        // 全页文本匹配会误命中历史行的“成功”状态单元格——第1轮复跑中 stopQuery
        // 返回 500 时该断言仍然假通过。改为点击“查询”刷新列表后重读目标行，
        // 只有该行脱离“运行中”（或从列表消失）才视为终止成功。
        let rowTextAfterKill = '';
        for (let attempt = 0; attempt < 8; attempt++) {
          const refreshButton = await firstVisible([
            page.getByRole('button', { name: /^查\s*询$/ }),
            page.locator('button:visible').filter({ hasText: /^查\s*询$/ }),
          ], 3_000);
          if (refreshButton) await refreshButton.click();
          await page.waitForTimeout(2_000);
          const rowAfterKill = await firstVisible([
            tableRows(page).filter({ hasText: marker }),
            page.locator('tr:visible, [class*="table-row"]:visible').filter({ hasText: marker }),
          ], 8_000);
          if (!rowAfterKill) {
            // 目标行从列表消失：视为已结束且被列表过滤，终止已生效。
            rowTextAfterKill = '';
            break;
          }
          rowTextAfterKill = (await rowAfterKill.innerText().catch(() => '')).trim();
          if (rowTextAfterKill && !rowTextAfterKill.includes('运行中')) break;
        }
        expect(
          rowTextAfterKill.includes('运行中')
            ? `目标行仍为“运行中”，终止未生效，行文本：${rowTextAfterKill.slice(0, 160)}`
            : '',
          `本轮长会话 ${marker} 点击 kill 并确认后，刷新查询管理列表仍未脱离“运行中”（stopQuery 疑似未生效）`,
        ).toBe('');
        // 终止接口当前契约成功返回；终止效果仍以上面的目标行状态断言为准，
        // 异常 HTTP 与控制台错误不再放行，按默认门禁失败。
        await assertNoUnexpectedConsoleErrors(consoleErrors, []);
        await report(
          '查询管理-本轮长会话创建并终止',
          true,
          `会话标记=${marker}；发起用户=${administrator.userName}`,
        );
      } finally {
        await secondaryContext.close().catch(() => undefined);
      }
    })
});
