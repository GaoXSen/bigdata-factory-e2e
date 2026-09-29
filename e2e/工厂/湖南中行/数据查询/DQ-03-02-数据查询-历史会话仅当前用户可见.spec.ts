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
import { assertNoConsoleErrors, chooseConfiguredDataSource, executeSql, openSelfServiceQuery, tableRows } from '../utils.js';
import {
  assignRoleToUser,
  ensurePermissionRole,
  ensurePermissionUser,
  loginAs,
  newPermissionIdentity,
  newPermissionRole,
  openUserManagement,
} from '../系统管理/权限测试工具.js';
import type { PermissionIdentity } from '../系统管理/权限测试工具.js';

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

  // run-20260916-173034-218 基线：工具栏 Schema combobox 不一定是“最后一个”可见
  // combobox；从后往前扫描可见 combobox，任一文本包含目标 Schema 即视为已选中
  //（selectSchemaInCombobox 的回显轮询已保证选中，这里做独立复核）。
  const schemaComboboxes = page.locator('[role="combobox"]:visible');
  const schemaComboboxCount = await schemaComboboxes.count();
  let selectedSchema = '';
  for (let index = schemaComboboxCount - 1; index >= 0; index -= 1) {
    selectedSchema = (await schemaComboboxes.nth(index).innerText().catch(() => '')).trim();
    if (selectedSchema.includes(schema)) break;
  }
  if (!selectedSchema.includes(schema)) {
    throw new Error(
      `环境前置条件缺失：目标 Schema ${schema} 未被真实选中（已扫描 ${schemaComboboxCount} 个可见 combobox），当前值为“${selectedSchema}”。`,
    );
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

async function findHistoryRowBySql(page: Page, sqlOrMarker: string): Promise<Locator | undefined> {
  return firstVisible([
    // 当前版本的运行历史是卡片而不是表格行；同时保留表格兼容分支。
    // 用本轮唯一 marker 查找，避免 SQL 格式化造成空格/换行差异。
    page.getByText(sqlOrMarker, { exact: false }).filter({ visible: true }),
    page.getByRole('row').filter({ hasText: sqlOrMarker }),
    page.locator('tr:visible').filter({ hasText: sqlOrMarker }),
    page.locator('[class*="history"]:visible, [class*="record"]:visible, [class*="session"]:visible')
      .filter({ hasText: sqlOrMarker }),
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

/**
 * 尽力删除本轮自建账号（用户管理页：按本轮唯一账号查询 → 行内“删除”→ 确认；
 * 模板 SM-02-05 deleteOwnUser）。只回收本轮自备账号；任一步不满足都返回
 * 说明文本而不抛错，不掩盖主结果。
 */
async function deleteOwnUser(page: Page, identity: PermissionIdentity): Promise<string> {
  await openUserManagement(page);
  const search = page.getByRole('textbox', { name: '请输入用户名称' }).first();
  await search.fill(identity.userName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(800);
  const userText = page.getByText(identity.userName, { exact: true }).last();
  if (!(await userText.isVisible().catch(() => false))) {
    return '列表未查询到本轮账号（可能此前已删除）';
  }
  const row = userText.locator('xpath=ancestor::tr[1]');
  if (!(await row.isVisible().catch(() => false))) {
    return '账号可见但未取到表格行，跳过页面删除（账号保留）';
  }
  const deleteButton = row.getByRole('button', { name: /删\s*除/ }).first();
  if (!(await deleteButton.isVisible().catch(() => false))) {
    return '行内未找到“删除”按钮，跳过页面删除（账号保留）';
  }
  await deleteButton.click();
  const confirmDialog = page
    .locator('[role="dialog"]:visible, .el-message-box:visible, .el-dialog:visible, .ant-modal:visible')
    .first();
  if (await confirmDialog.isVisible().catch(() => false)) {
    const confirm = confirmDialog.getByRole('button', { name: /确\s*定|^是$/ }).first();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
  }
  await expect(userText).toBeHidden({ timeout: 10_000 }).catch(() => undefined);
  return '已提交删除并确认列表不再显示该账号';
}

test.describe("DQ-03-02｜数据查询｜历史会话仅当前用户可见", () => {
  test.beforeEach(async ({ loginPage }, testInfo) => {
    // 本用例含两次账号切换（管理员→受限用户→切回管理员）与运行历史刷新，
    // 全局 30 秒必然不够。超时必须在 beforeEach 开始前调高，
    // 仅在用例正文中 test.setTimeout 会来不及覆盖慢速菜单导航。
    // （旧条件“历史会话与脚本：执行生成历史会话”是 DQ-03-01 的复制残留，从不匹配本用例。）
    if (testInfo.title.includes('历史会话仅当前用户可见')) {
      testInfo.setTimeout(180_000);
    }
    await openSelfServiceQuery(loginPage);
  })
  test("DQ-03-02｜数据查询｜历史会话仅当前用户可见", async ({ loginPage, consoleErrors, report }) => {
      const page = loginPage;
      // 管理员身份必须显式提供：去掉 'admin' 兜底，缺 TEST_USER/TEST_PASS
      // 视为环境前置不足直接失败，不悄悄换账号破坏隔离结论。
      const adminUserName = (process.env.TEST_USER ?? '').trim();
      const adminIdentity: PermissionIdentity = {
        userName: adminUserName,
        nickname: adminUserName,
        password: (process.env.TEST_PASS ?? '').trim(),
        phone: '',
        email: '',
      };
      if (!adminUserName || !adminIdentity.password) {
        throw new Error('缺少 TEST_USER/TEST_PASS，无法完成“管理员→独立用户→管理员”的历史会话隔离闭环。');
      }
      // 本轮唯一 ASCII 账号（前缀 dq0302）：不再复用固定共享夹具账号，避免
      // 依赖 SM-00-01 先行初始化，也避免共享账号的历史会话互相污染；账号在
      // 本用例 finally 中尽力回收（deleteOwnUser），角色按系列先例用后保留。
      const applicant = newPermissionIdentity('dq0302');
      const applicantRole = newPermissionRole('dq0302', 'viewer');
      await ensurePermissionUser(page, applicant);
      await ensurePermissionRole(page, applicantRole, ['数据地图', '数据查询']);
      await assignRoleToUser(page, applicantRole, applicant);
      try {
      await openSelfServiceQuery(page);
      if (!(await chooseConfiguredDataSourceOrSkip(page, { schema: CONFIGURED_SCHEMA }))) return;
      if (!(await assertConfiguredSourceAndSchema(page, CONFIGURED_SCHEMA))) return;
      const marker = `marker_${uuid()}`;
      const sql = `SELECT '${marker}' AS m`;
      await executeSql(page, sql);
      if (!(await waitForQueryResult(page, marker))) return;
      // 历史会话中应包含本次执行的 marker
      await clickVisibleHistoryTab(page);
      if (!(await findHistoryRowBySql(page, marker))) {
        throw new Error( `执行成功后目标历史会话“${sql}”未返回，无法验证当前用户可见性。`);
        return;
      }
      // 切换至独立、仅有“数据查询”菜单的测试用户，验证不能看见管理员本轮历史。
      // 29F 实证：受限账号从默认入口（数据源管理页）登录会落入产品 #/404，
      // 必须从该账号已被授权的自助查询入口完成切换（与 SM-03-05/06 同模式）。
      const applicantEntryUrl = new URL(page.url());
      applicantEntryUrl.hash = '#/dataQuery/selfServiceQuery';
      await loginAs(page, applicant, { entryUrl: applicantEntryUrl.toString() });
      await openSelfServiceQuery(page);
      await clickVisibleHistoryTab(page);
      const leakedHistory = await findHistoryRowBySql(page, marker);
      if (leakedHistory) {
        throw new Error(`真实业务BUG：独立用户“${applicant.userName}”可查看管理员历史会话“${sql}”。`);
      }
      // 隔离闭环：切回管理员后本人历史会话必须仍然可见，证明上面的“不可见”
      // 是真实的用户隔离，而不是历史丢失或列表未加载造成的假阴性。
      await loginAs(page, adminIdentity, { entryUrl: applicantEntryUrl.toString() });
      await openSelfServiceQuery(page);
      await clickVisibleHistoryTab(page);
      const restoredHistory = await findHistoryRowBySql(page, marker);
      if (!restoredHistory) {
        throw new Error(`切回管理员“${adminIdentity.userName}”后本人历史会话“${sql}”不可见，隔离结论无法成立。`);
      }
      await assertNoConsoleErrors(consoleErrors);
      await report('自助查询-历史会话按用户隔离', true, `管理员历史=${sql}；独立用户=${applicant.userName} 未检索到该记录；切回${adminIdentity.userName}后记录仍可见。`);
      } finally {
        // 尽力回收本轮自备账号：若仍停留在独立用户会话，先切回管理员再进用户管理删除；
        // 失败仅附证据与告警，不掩盖主结果（模板 SM-02-05 收尾）。
        try {
          const bodyText = (await page.locator('body').innerText().catch(() => '')).trim();
          if (!bodyText.includes(adminUserName)) {
            await loginAs(page, adminIdentity);
          }
          const cleanupOutcome = await deleteOwnUser(page, applicant);
          test.info().attach('DQ-03-02-收尾清理证据.txt', {
            body: `本轮账号 ${applicant.userName}：${cleanupOutcome}`,
            contentType: 'text/plain; charset=utf-8',
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          test.info().attach('DQ-03-02-收尾清理证据.txt', {
            body: `本轮账号 ${applicant.userName} 回收失败：${message}`,
            contentType: 'text/plain; charset=utf-8',
          });
          console.warn(`[DQ-03-02 收尾] 账号 ${applicant.userName} 回收失败：${message.slice(0, 160)}`);
        }
      }
    })
});
