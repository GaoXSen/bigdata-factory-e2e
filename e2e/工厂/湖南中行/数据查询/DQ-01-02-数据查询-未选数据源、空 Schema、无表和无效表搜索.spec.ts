/**
 * 数据查询 — 自助查询：DQ-01-02 异常数据源选择 E2E 测试
 *
 * 覆盖场景（参考 Excel「测试用例」Sheet 行46～48 与归档原始用例）：
 *   1. 未选数据源直接执行 —— 查询应被阻止（无执行入口/前端拦截/服务端拒绝/明确提示）
 *   2. 空 Schema —— Schema 清空后页面不崩溃、可继续操作（当前版本不可清空时按实际行为记录）
 *   3. 无表搜索 —— 不存在的表名在左侧目录中无命中、无误命中
 *   4. 无效表搜索/查询 —— 特殊字符关键字不崩溃、可恢复；查询不存在的表被拒绝且无结果集
 *
 * 断言原则（对应“不能依赖单一 toast 文案”）：
 *   多路证据任一成立即判“操作被正确阻止或页面给出明确异常状态”：
 *     a) 前端未发起 /self/query/submitQuery；
 *     b) submitQuery 全部被拒绝（HTTP >= 400 或请求失败）；
 *     c) message/notification/alert 等提示容器或自助查询“查询结果”面板错误行出现关键词；
 *     d) 页面状态信号（仍处于未选数据源、弹出数据源选择弹窗等）。
 *   负向断言：成功才可能出现的数据行标记不出现；编辑器仍可操作（修正后流程可继续）。
 *
 * 关键要求：
 *   1. 所有操作用 page. 浏览器操作（无 fetch/axios 等 API 调用）
 *   2. UUID 后缀隔离所有测试数据；只查不写、不产生脏数据
 *   3. SQL 写入不依赖 Windows 剪贴板（run-20260914-110852-805 证据：
 *      powershell/clip.exe/浏览器 Clipboard API 三路全部失败），改用
 *      keyboard.insertText + 页面内 monaco 模型兜底，写入后按视图文本校验
 */

import { access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { Download, Locator, Page } from '@playwright/test';
import { test, expect, uuid } from '../utils.js';
import { assertNoUnexpectedConsoleErrors, chooseConfiguredDataSource, expectSqlEditorText, openSelfServiceQuery, pasteLongText, tableRows } from '../utils.js';

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

/** Schema 选项在当前打开的下拉面板中的候选定位；只在面板内搜索，避免命中左侧目录树同名节点。 */
function schemaOptionCandidates(page: Page, schema: string): Locator[] {
  return [
    page.getByRole('option', { name: exactText(schema) }),
    page.locator('[role="listbox"]:visible [role="option"]').filter({ hasText: exactText(schema) }),
    page.locator(
      '.ant-select-dropdown:visible .ant-select-item-option, ' +
      '.ant-select-dropdown:visible .ant-select-dropdown-menu-item, ' +
      '.el-select-dropdown:visible .el-select-dropdown__item, ' +
      '[role="listbox"]:visible .el-select-dropdown__item',
    ).filter({ hasText: exactText(schema) }),
  ];
}

/**
 * Schema 是否已回显到可见 combobox：从最后一个 combobox 往前扫描，任一文本包含
 * 目标 Schema 即认为已选中（工具栏 Schema 下拉不保证是最后一个可见 combobox）。
 */
async function schemaEchoContains(page: Page, schema: string, timeoutMs: number): Promise<boolean> {
  try {
    await expect.poll(async () => {
      const comboboxes = page.locator('[role="combobox"]:visible');
      const count = await comboboxes.count();
      for (let index = count - 1; index >= 0; index -= 1) {
        const text = (await comboboxes.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (text.includes(schema)) return text;
      }
      return '';
    }, { timeout: timeoutMs }).toContain(schema);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在数据源选定后的 Schema 下拉中真实选择目标库并等待选中值回显。
 *
 * run-20260916-173034-218 基线：共享 chooseConfiguredDataSource 的 Schema 分支
 * 取“最后一个可见 combobox”，且选项搜索以页面文本兜底会命中左侧目录树中的
 * “e2e_test”节点，导致本簇 6 个用例全部静默未选中（combobox 仍是“选择Schema”
 * 占位）。DQ-02-01 同轮通过的 selectSchemaInCombobox（占位符定位 combobox →
 * 面板内精确匹配选项 → 回显轮询）证明该路径在当前前端版本有效，此处复用该模式
 * 并加重试；数据源类型/名称仍由共享工具选择，不修改共享 utils.ts。
 */
async function selectSchemaInCombobox(page: Page, schema: string): Promise<void> {
  const openSchemaDropdown = async (): Promise<void> => {
    const box = await firstVisible([
      page.locator('[role="combobox"]:visible').filter({ hasText: /选择\s*Schema/i }),
      page.getByText(/选择\s*Schema/).filter({ visible: true }),
      page.locator('[role="combobox"]:visible').last(),
    ], 10_000);
    if (!box) throw new Error(`Schema 选择下拉框未找到，当前页面：${page.url()}`);
    await box.click({ force: true });
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // 已选中目标值时直接返回，保证重试幂等。
    if (await schemaEchoContains(page, schema, 1_000)) return;
    await openSchemaDropdown();
    const option = await firstVisible(schemaOptionCandidates(page, schema), 5_000);
    if (!option) {
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(500);
      continue;
    }
    await option.click();
    await page.waitForTimeout(600);
    if (await schemaEchoContains(page, schema, 5_000)) return;
    await page.waitForTimeout(500);
  }
  // 终局定性：区分“下拉里根本没有该选项”（环境前置缺失）与“选项在但点击未生效”
  // （脚本/前端问题）；不能一律归为环境，也不能静默吞掉。
  await openSchemaDropdown();
  const optionStillExists = await firstVisible(schemaOptionCandidates(page, schema), 3_000);
  await page.keyboard.press('Escape').catch(() => undefined);
  if (!optionStillExists) {
    throw new Error(`环境前置条件缺失：数据源下拉中没有 Schema 选项“${schema}”。`);
  }
  throw new Error(`Schema 选项“${schema}”存在于下拉中，但点击选择后未回显到 combobox（已重试 3 次），当前页面：${page.url()}`);
}

/**
 * 数据源选择失败时只对已确认的“下拉项/Schema 不存在”分支跳过；其它错误继续抛出，
 * 避免把真实定位或服务问题伪装成环境阻断。
 *
 * run-20260916-173034-218 基线：共享工具的 Schema 分支会静默未选中（详见
 * selectSchemaInCombobox 注释），这里让共享工具只负责“数据源类型 → 数据源 → 确定”，
 * Schema 改由本文件内带回显校验的 selectSchemaInCombobox 完成。
 */
async function chooseConfiguredDataSourceOrSkip(
  page: Page,
  options: { schema?: string | false },
): Promise<boolean> {
  try {
    await chooseConfiguredDataSource(page, { ...CONFIGURED_SOURCE, schema: false });
    if (options.schema) {
      await selectSchemaInCombobox(page, options.schema);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingType = message.includes(`下拉选项“${CONFIGURED_SOURCE.type}”未找到`);
    const missingSource = message.includes(`下拉选项“${CONFIGURED_SOURCE.name}”未找到`);
    const missingSchema = message.includes('当前数据源没有可选 Schema') ||
      (typeof options.schema === 'string' &&
        message.includes(`数据源下拉中没有 Schema 选项“${options.schema}”`));
    if (missingType || missingSource || missingSchema) {
      const missing = missingType
        ? `数据源类型 ${CONFIGURED_SOURCE.type}`
        : missingSource
          ? `数据源 ${CONFIGURED_SOURCE.name}`
          : `Schema ${options.schema || '默认 Schema'}`;
      throw new Error( `环境前置条件缺失：未提供 ${missing}，无法完成真实连接/Schema 选择。`);
    }
    throw error;
  }
}

async function assertConfiguredSourceAndSchema(page: Page, schema: string): Promise<boolean> {
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

  // run-20260916-173034-218 基线：工具栏 Schema combobox 不一定是“最后一个”可见
  // combobox；从后往前扫描可见 combobox，任一文本包含目标 Schema 即视为已选中
  //（selectSchemaInCombobox 的回显轮询已保证选中，这里做独立复核）。
  // run-20260922-180828-791：选中后“Schema 下拉框回显”与“左侧树节点”是两个异步
  // 稳定的信号（本轮树已全量渲染、下拉框仍短暂回到“选择Schema”占位；上一轮
  // run-20260922-175656-267 相反）。改为统一轮询等待两个信号同时出现（10s），
  // 超时才按各自语义如实报错，不把页面重渲染的稳定过程误判成环境前置缺失。
  let selectedSchema = '';
  let schemaNode: Locator | undefined;
  const settleDeadline = Date.now() + 10_000;
  do {
    const schemaComboboxes = page.locator('[role="combobox"]:visible');
    const schemaComboboxCount = await schemaComboboxes.count();
    for (let index = schemaComboboxCount - 1; index >= 0; index -= 1) {
      selectedSchema = (await schemaComboboxes.nth(index).innerText().catch(() => '')).trim();
      if (selectedSchema.includes(schema)) break;
    }
    if (selectedSchema.includes(schema)) {
      const schemaTexts = page.getByText(schema, { exact: true }).filter({ visible: true });
      const schemaTextCount = await schemaTexts.count();
      for (let index = 0; index < schemaTextCount; index += 1) {
        const candidate = schemaTexts.nth(index);
        const inCombobox = candidate.locator('xpath=ancestor-or-self::*[@role="combobox"]');
        if (!(await inCombobox.count())) {
          schemaNode = candidate;
          break;
        }
      }
    }
    if (selectedSchema.includes(schema) && schemaNode) break;
    if (Date.now() >= settleDeadline) break;
    await page.waitForTimeout(250);
  } while (true);
  if (!schemaNode) {
    throw new Error( `环境前置条件缺失：数据源 ${CONFIGURED_SOURCE.name} 下没有目标 Schema ${schema} 的树节点/表资源。`);
    return false;
  }
  if (!selectedSchema.includes(schema)) {
    // 与 selectSchemaInCombobox 终局定性一致：选项存在且树已展示，但回显丢失属于
    // 页面状态不稳定/前端回显缺陷，不能伪装成环境阻断，也不静默放过。
    throw new Error(
      `页面数据源选择状态未稳定：Schema “${schema}”已展示在左侧树，但工具栏 Schema combobox 10s 内未回显（当前值“${selectedSchema || '空'}”），无法确认真实选中。`,
    );
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
// ==================== DQ-01-02 异常路径专用辅助 ====================

/** 记录 /self/query/submitQuery 的请求结果，用于“操作被阻止/被拒绝”的网络级证据。 */
interface SubmitQueryEvidence {
  requests: Array<{ url: string; status: number | null }>;
}

function trackSubmitQuery(page: Page): SubmitQueryEvidence {
  const evidence: SubmitQueryEvidence = { requests: [] };
  page.on('response', (response) => {
    if (response.url().includes('/self/query/submitQuery')) {
      evidence.requests.push({ url: response.url(), status: response.status() });
    }
  });
  page.on('requestfailed', (request) => {
    if (request.url().includes('/self/query/submitQuery')) {
      evidence.requests.push({ url: request.url(), status: null });
    }
  });
  return evidence;
}

/** 收集常见提示容器（message/notification/alert/表单错误）的可见文本；不绑定单一 toast 文案。 */
async function visibleFeedbackText(page: Page): Promise<string> {
  const containers = page.locator(
    '.ant-message, .ant-notification-notice, .ant-alert, .el-message, .el-notification, [role="alert"], .ant-form-item-explain-error',
  );
  const count = await containers.count().catch(() => 0);
  const texts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = containers.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const text = ((await item.innerText().catch(() => '')) || '').trim();
    if (text) texts.push(text);
  }
  // 页面事实（run-20260915-103451-564 失败快照 e744 节点）：自助查询执行失败时，
  // 错误文案不在 message/alert 容器，而是渲染在底部“查询结果”面板的普通节点，
  // 形如 “error:执行第0条sql异常:SQLSyntaxErrorException: Table '…' doesn't exist”。
  // 将该错误行并入提示证据源；是否构成“明确异常”仍由调用方的关键词模式判定。
  const resultPanelErrors = page
    .getByText(/error\s*[:：]|执行第\s*\d+\s*条\s*sql\s*异常/i)
    .filter({ visible: true });
  const errorCount = await resultPanelErrors.count().catch(() => 0);
  for (let index = 0; index < errorCount; index += 1) {
    const text = ((await resultPanelErrors.nth(index).innerText().catch(() => '')) || '').trim();
    if (text) texts.push(text);
  }
  return texts.join('\n');
}

/**
 * 异常路径核心断言：操作被正确阻止或页面给出明确异常状态。
 * 接受多路证据（前端未发请求 / 服务端拒绝 / 关键词提示 / 额外页面信号），
 * 任一成立即通过；全部缺失时抛出带完整证据的失败，便于区分脚本问题与真实 BUG。
 */
async function assertBlockedOrClearError(page: Page, options: {
  label: string;
  keywordPattern: RegExp;
  submitEvidence: SubmitQueryEvidence;
  extraSignals?: Array<{ label: string; check: () => Promise<boolean> }>;
}): Promise<string> {
  const requests = options.submitEvidence.requests;
  const statuses = requests.map((item) => (item.status === null ? '请求失败' : String(item.status)));
  const signals: string[] = [];
  if (requests.length === 0) {
    signals.push('前端未发起 submitQuery 请求（操作在页面层被阻止）');
  } else if (requests.every((item) => item.status === null || item.status >= 400)) {
    signals.push(`submitQuery 被拒绝（状态码：${statuses.join('、')}）`);
  }
  const feedback = await visibleFeedbackText(page);
  if (feedback && options.keywordPattern.test(feedback)) {
    signals.push(`页面出现明确提示：${feedback.slice(0, 160)}`);
  }
  for (const extra of options.extraSignals ?? []) {
    if (await extra.check().catch(() => false)) signals.push(extra.label);
  }
  if (!signals.length) {
    throw new Error(
      `【${options.label}】未验证到“操作被阻止或明确异常状态”：submitQuery 共 ${requests.length} 次` +
        `（状态码：${statuses.join('、') || '无'}），页面可见提示：${feedback ? feedback.slice(0, 160) : '（空）'}，` +
        `当前页面：${page.url()}。`,
    );
  }
  return signals.join('；');
}

/** 异常路径负向断言：查询成功才可能出现的数据行标记不应出现（编辑器文本、隐藏面板不算结果）。 */
async function assertNoResultRows(page: Page, marker: string | RegExp, label: string): Promise<void> {
  const rows = tableRows(page).filter({ hasText: marker });
  await expect(rows, `【${label}】查询不应产生成功的数据行`).toHaveCount(0, { timeout: 1_500 });
}

/**
 * 搜索异常负向断言：不存在的表名/特殊字符关键字不应命中目录节点。
 * 用 exact 精确匹配节点文本，避免把“未找到 xxx”这类空态提示文案误判为命中。
 */
async function assertNoTreeHit(page: Page, keyword: string, label: string): Promise<void> {
  const hit = page.getByText(keyword, { exact: true }).filter({ visible: true });
  await expect(hit, `【${label}】不应误命中左侧目录节点`).toHaveCount(0, { timeout: 1_000 });
}

/** 在左侧目录搜索框输入关键字并触发搜索（Enter + 搜索图标双通道）。 */
async function searchSelfServiceTree(page: Page, searchBox: Locator, keyword: string): Promise<void> {
  await searchBox.fill(keyword);
  await searchBox.press('Enter').catch(() => undefined);
  const searchIcon = page.locator('[aria-label="图标: search"]:visible').first();
  if (await searchIcon.isVisible().catch(() => false)) {
    await searchIcon.click().catch(() => undefined);
  }
}

/** Monaco 展示层会把空格转成 NBSP 并可能折行/追加空白；统一规范化后再比较。 */
function normalizeSqlText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Monaco 的 textarea 是输入桥接，不一定同步 inputValue；视图模型和输入值一起读。 */
async function readEditorText(page: Page): Promise<string> {
  const viewText = await page
    .locator('.monaco-editor:visible .view-lines')
    .last()
    .innerText()
    .catch(() => '');
  const inputValue = await page
    .getByRole('textbox', { name: /Editor content;Press Alt\+F1/ })
    .last()
    .inputValue()
    .catch(() => '');
  return `${viewText}\n${inputValue}`;
}

/**
 * 向自助查询 Monaco 编辑器写入 SQL 并完整回读校验（本 spec 专用，替代依赖
 * Windows 剪贴板的 executeSql）。与 DQ-02-01 同路径，写入回退链：
 *   1. clipboard —— 公共 pasteLongText（powershell→clip.exe→浏览器 Clipboard
 *      API→合成 paste 事件→insertText 的人工粘贴通道），与真实用户路径一致，
 *      仍为首选；
 *   2. keyboard —— page.keyboard.insertText（CDP 一次性插入，不经系统剪贴板、
 *      不逐字触发 Monaco 自动补全）；
 *   3. typed —— editor.pressSequentially 逐字键入（最接近人工敲键，可能触发
 *      自动补全，靠回读校验兜底）。
 * run-20260920-093617-273/103941-510 实测：执行机 OS 剪贴板“写入成功”但
 * Ctrl+V 后 Monaco 回读为空（云桌面/DLP 允许写剪贴板、拦截粘贴读取），旧版
 * “仅当 pasteLongText 抛错才降级”的 isClipboardUnavailable 判定覆盖不了该
 * 场景，因此改为按“回读结果”降级。每次尝试前清空编辑器并轮询确认为空，
 * 防止多次尝试内容叠加造成 includes 误判；该页面未暴露 window.monaco，无法
 * 用页面内 API 兜底，因此无论哪条路径，写入后都必须完整回读并包含整条 SQL，
 * 防止自动补全或粘贴截断改写语句后被静默执行。三层全部失败才抛错，错误信息
 * 带各层的实际回读内容。
 */
async function writeSqlToEditor(page: Page, sql: string): Promise<'clipboard' | 'keyboard' | 'typed'> {
  const editor = page.getByRole('textbox', { name: /Editor content;Press Alt\+F1/ }).last();
  await expect(editor).toBeVisible({ timeout: 10_000 });
  // 前一步下拉选择可能残留浮层，先收起再聚焦编辑器。
  await page.keyboard.press('Escape').catch(() => undefined);

  /** 每次写入尝试前清空编辑器并轮询确认为空，避免多次尝试内容叠加。 */
  async function clearEditor(): Promise<void> {
    // 执行过一次查询后，结果面板/页面焦点可能不在编辑器上：Ctrl+A/Backspace 会
    // 落到页面其他区域，导致旧 SQL 残留（run-20260920-174405/174604 实测）。
    // 因此点击后必须确认焦点真的在编辑器内，未聚焦则按 Escape 收起可能的浮层
    // 并重试；清空未生效时整体重试，三次仍失败才带着回读内容抛错。
    const readBack = async (): Promise<string> => normalizeSqlText(await readEditorText(page));
    let lastText = '';
    for (let round = 0; round < 3; round += 1) {
      if (round > 0) {
        await page.keyboard.press('Escape').catch(() => undefined);
      }
      await editor.click({ force: true });
      try {
        await expect(editor).toBeFocused({ timeout: 2_000 });
      } catch {
        continue; // 焦点被浮层/结果面板抢占，收起浮层后重试
      }
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      try {
        await expect.poll(async () => readBack(), { timeout: 3_000 }).toBe('');
        return;
      } catch {
        lastText = await readBack();
      }
    }
    throw new Error(`编辑器清空失败：Ctrl+A/Backspace 后回读仍为“${lastText.slice(0, 120)}”。`);
  }

  const attempts: Array<{ mode: 'clipboard' | 'keyboard' | 'typed'; write: () => Promise<void> }> = [
    {
      mode: 'clipboard',
      write: async () => {
        await pasteLongText(page, editor, sql);
      },
    },
    {
      mode: 'keyboard',
      write: async () => {
        await page.keyboard.insertText(sql);
      },
    },
    {
      mode: 'typed',
      write: async () => {
        await editor.pressSequentially(sql, { delay: 5 });
      },
    },
  ];

  const expected = normalizeSqlText(sql);
  const failures: string[] = [];
  for (const attempt of attempts) {
    await clearEditor();
    try {
      await attempt.write();
    } catch (error) {
      failures.push(`【${attempt.mode}】写入抛错：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    let actual = '';
    try {
      // 给 Monaco 渲染/粘贴事件传播一点时间，回读通过即本层成功。
      await expect
        .poll(async () => {
          actual = normalizeSqlText(await readEditorText(page));
          return actual.includes(expected);
        }, { timeout: 3_000 })
        .toBe(true);
      return attempt.mode;
    } catch {
      failures.push(`【${attempt.mode}】回读不一致：期望包含“${expected}”，实际为“${actual.slice(0, 300)}”`);
    }
  }
  throw new Error(`SQL 写入编辑器失败（已依次尝试 clipboard→keyboard→typed）：${failures.join('；')}。`);
}

/** 写入 SQL 并点击真实“执行”入口（与公共 executeSql 相同的按钮定位，但不依赖剪贴板）。 */
async function runSelfServiceSql(page: Page, sql: string): Promise<void> {
  await writeSqlToEditor(page, sql);
  const iconButton = page.locator('[aria-label="图标: caret-right"]:visible').first();
  const textButton = page.getByRole('button', { name: /^\s*执\s*行\s*$/ }).first();
  const executeButton = (await iconButton.count()) ? iconButton : textButton;
  await expect(executeButton).toBeVisible({ timeout: 10_000 });
  await executeButton.click();
  await page.waitForTimeout(1_000);
}

/** 清空 Schema 后重新选择原 Schema（供后续无效表查询恢复到“存在的 Schema”状态）。 */
async function reselectSchema(page: Page, schema: string): Promise<void> {
  const combobox = page.locator('[role="combobox"]:visible').last();
  await expect(combobox).toBeVisible({ timeout: 10_000 });
  await combobox.click({ force: true });
  const option = await firstVisible([
    page.locator('[role="option"]:visible').filter({ hasText: exactText(schema) }),
    page.getByText(schema, { exact: true }).filter({ visible: true }),
  ], 5_000);
  if (!option) {
    throw new Error(`环境前置条件缺失：清空 Schema 后无法重新选择 ${schema}，无法继续无效表查询。`);
  }
  await option.click();
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(500);
}

test.describe("DQ-01-02｜数据查询｜未选数据源、空 Schema、无表和无效表搜索", () => {
  test.beforeEach(async ({ loginPage }, testInfo) => {
    // 行49包含菜单重载、运行历史和脚本树刷新；超时必须在 beforeEach 开始前调高，
    // 仅在用例正文中 test.setTimeout 会来不及覆盖慢速菜单导航。
    if (testInfo.title.includes('历史会话与脚本：执行生成历史会话')) {
      testInfo.setTimeout(120_000);
    }
    await openSelfServiceQuery(loginPage);
  })
  test("DQ-01-02｜数据查询｜未选数据源、空 Schema、无表和无效表搜索", async ({ loginPage, consoleErrors, report }) => {
      const page = loginPage;

      // ============ 场景 1：未选数据源直接执行 ============
      const submitEvidence = trackSubmitQuery(page);
      const chooseEntry = await firstVisible([
        page.getByText('选择数据源', { exact: true }).filter({ visible: true }),
        page.getByText('请选择数据源', { exact: true }).filter({ visible: true }),
      ], 5_000);
      if (!chooseEntry) {
        // 不伪造“未选数据源”状态：页面自动恢复上次选择时按环境前置缺失处理。
        throw new Error('环境前置条件缺失：自助查询页未处于“未选数据源”初始状态（页面可能自动恢复了上次选择），无法构造未选数据源分支。');
      }
      const noSourceMarker = `e2e_nosrc_${uuid()}`;
      const noSourceSql = `SELECT 1 AS ${noSourceMarker}`;
      const unselectedExecuteEntry = await firstVisible([
        page.locator('[aria-label="图标: caret-right"]:visible'),
        page.getByRole('button', { name: /^\s*执\s*行\s*$/ }).filter({ visible: true }),
      ], 3_000);
      const unselectedEditor = await firstVisible([
        page.getByRole('textbox', { name: /Editor content;Press Alt\+F1/ }),
      ], 3_000);
      if (!unselectedExecuteEntry || !unselectedEditor) {
        // 未选数据源时页面不提供 SQL 编辑与执行入口：查询无法发起，本身就是“被阻止”的页面级证据。
        await assertNoResultRows(page, noSourceMarker, '未选数据源-无执行入口');
        await report('自助查询-未选数据源执行被阻止', true,
          '未选数据源时页面未渲染 SQL 编辑器/执行入口，查询无法发起（页面级阻止）。');
      } else {
        await runSelfServiceSql(page, noSourceSql);
        await page.waitForTimeout(3_000);
        const noSourceEvidence = await assertBlockedOrClearError(page, {
          label: '未选数据源执行',
          keywordPattern: /数据源|请选择|未选择|为空|datasource/i,
          submitEvidence,
          extraSignals: [
            {
              label: '页面仍处于未选数据源状态',
              check: async () => (await page.getByText('选择数据源', { exact: true }).filter({ visible: true }).count()) > 0,
            },
            {
              label: '页面弹出数据源选择弹窗引导先选择数据源',
              check: async () =>
                (await page.getByRole('button', { name: /^\s*确\s*定\s*$/ }).filter({ visible: true }).count()) > 0 &&
                (await page.locator('[role="combobox"]:visible').count()) >= 2,
            },
          ],
        });
        await assertNoResultRows(page, noSourceMarker, '未选数据源执行');
        // 修正为合法值后流程可继续：编辑器仍可操作（SQL 是否保留只记录，不作为硬断言）。
        await expect(unselectedEditor).toBeVisible();
        let noSourceSqlKept = false;
        try {
          await expectSqlEditorText(page, noSourceSql);
          noSourceSqlKept = true;
        } catch {
          noSourceSqlKept = false;
        }
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.waitForTimeout(500);
        await report('自助查询-未选数据源执行被阻止', true,
          `${noSourceEvidence}；编辑器仍可操作（${noSourceSqlKept ? 'SQL 保留，可直接修正后继续' : 'SQL 被清空，可重新输入'}）。`);
      }

      // ============ 场景 2：选择数据源 → 空 Schema、无表与无效表搜索 ============
      if (!(await chooseConfiguredDataSourceOrSkip(page, { schema: CONFIGURED_SCHEMA }))) return;
      if (!(await assertConfiguredSourceAndSchema(page, CONFIGURED_SCHEMA))) return;

      // —— 空 Schema：尝试清空 Schema，页面不崩溃、可继续操作 ——
      const schemaCombobox = page.locator('[role="combobox"]:visible').last();
      await expect(schemaCombobox).toBeVisible({ timeout: 10_000 });
      await schemaCombobox.hover().catch(() => undefined);
      const schemaClearIcon = await firstVisible([
        page.locator('.ant-select:has([role="combobox"]) .ant-select-clear:visible'),
        page.locator('[role="combobox"]:visible [aria-label="图标: close-circle"]:visible'),
      ], 2_000);
      let schemaCleared = false;
      if (schemaClearIcon) {
        await schemaClearIcon.click();
        await page.waitForTimeout(800);
        const remainingSchema = (await schemaCombobox.innerText().catch(() => '')).trim();
        schemaCleared = !remainingSchema.includes(CONFIGURED_SCHEMA);
        await report('自助查询-空Schema状态', true, schemaCleared
          ? `Schema 已清空（原值 ${CONFIGURED_SCHEMA}，当前值“${remainingSchema || '（空）'}”），页面未崩溃、可继续操作。`
          : `当前版本 Schema 选择不可被清空（点击清除图标后仍为 ${CONFIGURED_SCHEMA}），按页面实际行为记录，不判失败。`);
      } else {
        await report('自助查询-空Schema状态', true,
          '当前页面未提供 Schema 清除入口，空 Schema 状态不可构造，按页面实际行为记录。');
      }

      // —— 无表搜索：本轮唯一的不存在表名不应命中任何目录节点 ——
      const searchBox = await firstVisible([
        page.getByRole('textbox', { name: /搜索表名|存储过程/ }),
        page.locator('input:visible[placeholder*="搜索"], input:visible[placeholder*="表名"]').first(),
      ], 10_000);
      if (!searchBox) {
        throw new Error(`左侧“搜索表名/存储过程”输入框未找到，当前页面：${page.url()}`);
      }
      const databaseIcons = page.locator('[aria-label="图标: database"]:visible');
      const databaseCountBefore = await databaseIcons.count();
      const missingKeyword = `codex_nonexistent_${uuid()}`;
      await searchSelfServiceTree(page, searchBox, missingKeyword);
      await page.waitForTimeout(1_500);
      await assertNoTreeHit(page, missingKeyword, '无表搜索');
      await report('自助查询-无表搜索无命中', true,
        `不存在的表名 ${missingKeyword} 未命中左侧目录任何节点，无误命中。`);

      // —— 无效表搜索：特殊字符关键字不崩溃、不误命中，且可恢复 ——
      const invalidKeyword = `__NOT_FOUND_${uuid()}__<>'"&%_`;
      await searchSelfServiceTree(page, searchBox, invalidKeyword);
      await page.waitForTimeout(1_000);
      await assertNoTreeHit(page, invalidKeyword, '无效表搜索');
      await expect(page.getByRole('textbox', { name: /Editor content;Press Alt\+F1/ }).last()).toBeVisible({ timeout: 10_000 });
      await searchBox.fill('');
      await searchBox.press('Enter').catch(() => undefined);
      const reloadIcon = page.locator('[aria-label="图标: reload"]:visible').first();
      if (await reloadIcon.isVisible().catch(() => false)) {
        await reloadIcon.click();
      }
      await page.waitForTimeout(1_200);
      if (databaseCountBefore > 0) {
        expect(await databaseIcons.count(), '清空搜索后左侧数据库目录应恢复显示').toBeGreaterThan(0);
      }
      await report('自助查询-无效表搜索可恢复', true,
        `特殊字符关键字 ${invalidKeyword} 未误命中、页面未崩溃，清空后目录恢复。`);

      // ============ 场景 3：无效表查询（存在的 Schema 下查询本轮不存在的表） ============
      if (schemaCleared) {
        await reselectSchema(page, CONFIGURED_SCHEMA);
      }
      const missingTableSql = `SELECT * FROM codex_nonexistent_${uuid()}`;
      submitEvidence.requests.length = 0;
      await runSelfServiceSql(page, missingTableSql);
      await page.waitForTimeout(3_000);
      // 当前演示环境会把错误留在后端执行记录/空 alert 中，不在页面渲染错误文案；
      // 因此以网络级拒绝证据为主、页面提示为辅，不把断言押在单一 toast 文案上。
      const invalidTableEvidence = await assertBlockedOrClearError(page, {
        label: '无效表查询',
        keywordPattern: /不存在|doesn'?t\s*exist|unknown|no\s+such\s+table|失败|错误|异常|error/i,
        submitEvidence,
      });
      await assertNoResultRows(page, /codex_nonexistent/, '无效表查询');
      // 校准保留：执行后编辑器仍保留 SQL 且可继续操作（修正为合法值后流程可继续）。
      await expectSqlEditorText(page, missingTableSql);
      await report('自助查询-无效表查询被拒绝', true, invalidTableEvidence);
      await assertNoUnexpectedConsoleErrors(consoleErrors, [
        /\/self\/query\/submitQuery/,
        /status of 500|AxiosError|Internal Server Error/i,
      ]);
    })
});
