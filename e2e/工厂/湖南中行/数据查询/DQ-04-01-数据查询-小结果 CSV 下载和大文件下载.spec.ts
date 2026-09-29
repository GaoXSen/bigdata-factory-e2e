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

import { access, mkdir, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { BrowserContext, Download, Locator, Page, TestInfo } from '@playwright/test';
import { test, expect, uuid } from '../utils.js';
import { assertNoConsoleErrors, chooseConfiguredDataSource, executeSql, loginWithCredentials, openSelfServiceQuery, settleDropdown, tableRows } from '../utils.js';

// 小结果下载完成后，后端连接上的流式结果集可能长时间不释放：run-20260915-104846-255
// 与 run-20260915-105736-519 两次实测，150 秒内重试 8 次仍报 “Streaming result set
// is still active”，且每次报错中的 ResultsetRowsStreaming@hash 都不同；页面流量里
// 不存在任何“关闭结果/释放连接”类接口，关闭结果页签不会通知后端释放。因此本用例
// 预留两层真实用户恢复动作：同页“关闭报错页签→退避重试”，仍失败则新开浏览器会话
// （同账号重新登录）后重试。只放宽本用例的上限，不改变全局 timeout。
// run-20260915-134701-316 复跑再次复现（150 秒内流式占用报错 4 次，新会话同样被占用）：
// 两层恢复动作做尽后仍稳定为流式占用时，按真实业务BUG上报并附证据，不做无限重试。
// 大结果文件生成/传输可能明显慢于小结果，下载事件等待单独放宽。
const DOWNLOAD_EVENT_TIMEOUT_LARGE = 120_000;
// 两层恢复动作的最坏耗时限定了本用例测试级超时：小结果窗口 60s + 大结果窗口 150s +
// 新会话登录/导航约 40s + 大文件下载事件 120s + 附件/截图开销。
const TEST_TIMEOUT = 600_000;
const CONFIGURED_SOURCE = { type: process.env.QUERY_SOURCE_TYPE?.trim() || 'MYSQL', name: process.env.QUERY_SOURCE_NAME?.trim() || '192.168.76.110:13306/e2e_test' };

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

type QueryOutcome = 'result' | 'streamingBusy' | 'noResult';

/**
 * 观察一轮 SQL 执行的页面结局（不抛错，由调用方决定重试策略）：
 * - result：本轮 marker 出现在结果表/结果文本中；
 * - streamingBusy：结果区出现“Streaming result set … is still active”。
 *   run-20260915 两次实测的页面行为：结果“下载”完成后立即执行下一条 SQL，即使
 *   “结果 N”页签已关闭，后端连接上的流式结果集仍未释放，新结果页签直接展示
 *   “服务异常:Streaming result set…”。9 次重试的报错里 ResultsetRowsStreaming@hash
 *   各不相同，说明不是单个游标未关，而是下载动作导致后续连接持续带病分发；这是
 *   页面真实行为，只能按真实用户方式恢复（见 executeSqlUntilResult 的升级策略），
 *   不允许改用接口绕过，也不允许把该错误吞掉当成通过；
 * - noResult：窗口内既没有 marker 也没有错误提示（大结果可能仍在渲染）。
 * 其余 SQL 错误提示只显示几秒，必须在轮询结果时同步抓取，否则提示消失后
 * 会被误报成“查询未返回”，掩盖真正的 SQL 或产品问题。streamingErrors 用于
 * 收集每次占用报错的完整文本（含游标 hash），作为恢复升级与最终报告的证据。
 */
async function inspectQueryOutcome(
  page: Page,
  marker: string,
  timeoutMs: number,
  streamingErrors?: string[],
): Promise<QueryOutcome> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await firstVisible([
      tableRows(page).filter({ hasText: marker }),
      page.getByText(marker, { exact: true }).filter({ visible: true }),
    ], 500);
    if (result) return 'result';

    const sqlError = await firstVisible([
      page.locator('.ant-message-error:visible, .el-message--error:visible'),
      page.getByText(/SQL解析失败|SQL执行失败|syntax error|查询失败|服务异常|Streaming result set|still active/i).filter({ visible: true }),
    ], 100);
    if (sqlError) {
      const message = (await sqlError.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (/Streaming result set|still active/i.test(message)) {
        streamingErrors?.push(`${new Date().toISOString()} ${message}`);
        return 'streamingBusy';
      }
      throw new Error(`执行 SQL 后页面报错：${message || '未知 SQL 错误'}`);
    }
  }
  return 'noResult';
}

/**
 * 依次关闭当前所有可见的“结果 N”页签，返回关闭数量；一个都没有时返回 0，
 * 不抛错（重试场景中失败结果页签可能已被页面自行收起，不能因此中断流程）。
 */
async function closeAllResultTabs(page: Page): Promise<number> {
  let closed = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const resultTabs = page.getByRole('tab').filter({ hasText: /^\s*结果\s*\d+/ });
    let target: Locator | undefined;
    for (let index = await resultTabs.count() - 1; index >= 0; index -= 1) {
      const candidate = resultTabs.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        target = candidate;
        break;
      }
    }
    if (!target) break;
    const close = target.locator('[aria-label="图标: close"], [aria-label="icon: close"], .anticon-close').first();
    if (!(await close.isVisible().catch(() => false))) break;
    await close.click({ force: true });
    closed += 1;
    await page.waitForTimeout(400);
  }
  return closed;
}

/** 仅这些错误代表“执行机剪贴板链不可用”，才允许降级为键盘一次性插入。 */
function isClipboardUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ['写入 Windows 剪贴板失败', '等待剪贴板互斥锁超时', '当前运行环境不是 Windows'].some((pattern) =>
    message.includes(pattern),
  );
}

/** 从 SQL 文本中取本轮唯一 marker（列别名），用于回读校验与结果定位。 */
function markerOf(sql: string): string {
  const match = sql.match(/AS\s+([A-Za-z0-9_]+)/i);
  if (!match) throw new Error(`SQL 中未找到 AS 别名 marker，无法校验写入：${sql.slice(0, 80)}`);
  return match[1];
}

/**
 * 公共 executeSql 优先按“人工复制后 Ctrl+V”路径把长 SQL 一次性粘贴进 Monaco。
 * run-20260914-110852-805 的真实失败是执行机系统剪贴板不可用（powershell/
 * clip.exe 均失败），且被测页面为 http 非安全上下文（navigator.clipboard 为
 * undefined），三级降级全部失败；公共工具按任务约束不改，本 spec 内仅对该
 * 错误降级 page.keyboard.insertText：CDP Input.insertText 同样一次性插入整条
 * SQL，不经系统剪贴板，也不会逐字触发 Monaco 自动补全改写语句。写入后回读
 * 校验（与公共实现一致的前 48 字符探针 + 本轮 marker），最终仍由“结果中出现
 * 本轮 marker / 下载文件落地”确认 SQL 真实执行。
 */
async function executeSqlWithClipboardFallback(page: Page, sql: string): Promise<void> {
  try {
    await executeSql(page, sql);
    return;
  } catch (error) {
    if (!isClipboardUnavailable(error)) throw error;
  }
  const editor = page.getByRole('textbox', { name: /Editor content;Press Alt\+F1/ }).last();
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape').catch(() => undefined);
  await editor.click({ force: true });
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(sql);

  // Monaco 的 textarea 不一定同步 inputValue；视图模型和输入值一起读。
  const normalizeSqlText = (value: string): string => value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const editorText = async (): Promise<string> =>
    `${await page.locator('.monaco-editor:visible .view-lines').last().innerText().catch(() => '')}\n${await editor.inputValue().catch(() => '')}`;
  const expected = normalizeSqlText(sql);
  const probe = expected.slice(0, 48);
  const markerText = normalizeSqlText(markerOf(sql));
  let actual = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    actual = normalizeSqlText(await editorText());
    if (actual.includes(probe) && actual.includes(markerText)) break;
    await page.waitForTimeout(300);
  }
  if (!(actual.includes(probe) && actual.includes(markerText))) {
    throw new Error(`降级 insertText 写入 SQL 后回读不一致：期望包含“${probe}”，实际为“${actual.slice(0, 200)}”。`);
  }

  // 与公共 executeSql 相同的执行按钮定位：三角图标优先，文字按钮兜底。
  const iconButton = page.locator('[aria-label="图标: caret-right"]:visible').first();
  const textButton = page.getByRole('button', { name: /^\s*执\s*行\s*$/ }).first();
  const executeButton = (await iconButton.count()) ? iconButton : textButton;
  await expect(executeButton).toBeVisible({ timeout: 10_000 });
  await executeButton.click();
  await page.waitForTimeout(1_000);
}

/**
 * 为“流式结果集占用”准备的新浏览器会话：真实用户在页面反复报“服务异常”后，
 * 会新开浏览器窗口用同一账号重新登录再试。这里创建全新的浏览器上下文（全新
 * Cookie/Token，等价于新会话），仍然全部走页面操作完成登录、导航与数据源选择，
 * 不调用任何登录/查询接口。视口与全局配置保持一致（1280×720），避免菜单折叠
 * 差异引入新的定位问题。
 */
async function openFreshSelfServiceSession(page: Page): Promise<{ newPage: Page; context: BrowserContext }> {
  const browser = page.context().browser();
  if (!browser) throw new Error('当前用例未运行在常驻浏览器上，无法新开浏览器会话重试。');
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const newPage = await context.newPage();
  await loginWithCredentials(newPage);
  await openSelfServiceQuery(newPage);
  await chooseConfiguredDataSourceOrSkip(newPage, { schema: false });
  await settleDropdown(newPage);
  return { newPage, context };
}

/**
 * 写入并执行 SQL，直到本轮 marker 结果真实出现在结果区。
 *
 * run-20260915 两次实测：结果“下载”完成后，即使关闭“结果 N”页签，后端流式
 * 结果集也不释放——150 秒重试 8 次仍报错，每次报错的 ResultsetRowsStreaming@hash
 * 均不同，页面流量中无“关闭结果”类接口（页签关闭不会通知后端）。升级式恢复：
 *   第 1 层（同页，真实用户“稍候重试”）：关闭报错结果页签 → 退避等待 → 重新执行
 *   （本用例 SQL 均为只读 SELECT，可安全重跑）；
 *   第 2 层（新会话，真实用户“重开浏览器重新登录”，allowNewSession 时启用）：
 *   全新浏览器上下文登录同一账号，重新导航并选择数据源后重试。
 * 各层窗口耗尽仍失败则如实抛错并附上占用报错证据，绝不以 toast、进度条或
 * 运行历史旧记录充当本轮结果。
 */
async function executeSqlUntilResult(
  page: Page,
  sql: string,
  marker: string,
  deadlineMs: number,
  options: { allowNewSession?: boolean; streamingErrors?: string[] } = {},
): Promise<{ resultPage: Page; contextToClose?: BrowserContext; escalations: string[] }> {
  const deadline = Date.now() + deadlineMs;
  const streamingErrors = options.streamingErrors;
  const escalations: string[] = [];
  const inSessionAttempts = options.allowNewSession ? 2 : 4;
  const streamingEvidence = (): string =>
    streamingErrors?.length
      ? `（流式结果集占用报错 ${streamingErrors.length} 次，最近一次：${streamingErrors[streamingErrors.length - 1]}）`
      : '';
  // 终局失败定性（run-20260915-134701-316 / 任务 agent-8）：重试次数有上限，两层真实
  // 用户恢复动作做尽后，若每次失败都是“Streaming result set ... still active”，说明
  // 后端连接未释放且前端任何操作都无法恢复，输出真实业务BUG 与证据，不再以环境/定位
  // 类错误上报，也不做无限重试。
  let lastOutcome: 'result' | 'streamingBusy' | 'noResult' | undefined;
  function throwTerminal(context: string): never {
    if (lastOutcome === 'streamingBusy' && streamingErrors?.length) {
      throw new Error(
        `真实业务BUG：MySQL 流式结果集在后端连接上未释放——${context}后仍稳定复现` +
        `${streamingEvidence()}；恢复动作：${escalations.join('→')}。` +
        '（run-20260915-104846-255、run-20260915-105736-519、run-20260915-134701-316 多轮实测：' +
        '每次报错的 ResultsetRowsStreaming@hash 均不同，页面无任何“释放结果集/连接”接口，' +
        '关闭结果页签无效，新开浏览器会话仍被同一连接池占用。）',
      );
    }
    throw new Error(
      `目标查询结果“${marker}”在 ${deadlineMs / 1000} 秒窗口内未返回：${context}${streamingEvidence()}；恢复动作：${escalations.join('→')}。`,
    );
  }

  // 第 1 层：同页重试。
  for (let attempt = 1; attempt <= inSessionAttempts && Date.now() < deadline; attempt += 1) {
    await executeSqlWithClipboardFallback(page, sql);
    const outcome = await inspectQueryOutcome(page, marker, 25_000, streamingErrors);
    lastOutcome = outcome;
    if (outcome === 'result') return { resultPage: page, escalations };
    if (outcome === 'streamingBusy') {
      await closeAllResultTabs(page);
      // 后端释放流式结果集需要时间；按指数退避等待后重试。
      await page.waitForTimeout(Math.min(5_000 * attempt, 10_000));
      continue;
    }
    // noResult：结果迟迟未渲染（大结果集较慢），稍候后重试执行。
    await page.waitForTimeout(2_000);
  }
  if (!options.allowNewSession || Date.now() >= deadline) {
    throwTerminal('同页退避重试');
  }

  // 第 2 层：新开浏览器会话（同账号重新登录）后重试；新会话若同样被占用，
  // 说明后端连接池层面的泄漏对全部会话生效，必须如实失败。
  escalations.push('新开浏览器会话（同账号重新登录）后重试');
  let newPage: Page;
  let newContext: BrowserContext;
  try {
    ({ newPage, context: newContext } = await openFreshSelfServiceSession(page));
  } catch (error) {
    escalations.push(`新会话准备失败：${error instanceof Error ? error.message : String(error)}`);
    throw new Error(
      `目标查询结果“${marker}”在同页重试与新会话重试后均未返回${streamingEvidence()}；恢复动作：${escalations.join('→')}。`,
    );
  }
  for (let attempt = 1; attempt <= 2 && Date.now() < deadline; attempt += 1) {
    await executeSqlWithClipboardFallback(newPage, sql);
    const outcome = await inspectQueryOutcome(newPage, marker, 25_000, streamingErrors);
    lastOutcome = outcome;
    if (outcome === 'result') return { resultPage: newPage, contextToClose: newContext, escalations };
    if (outcome === 'streamingBusy') {
      await closeAllResultTabs(newPage);
      await newPage.waitForTimeout(10_000);
      continue;
    }
    await newPage.waitForTimeout(2_000);
  }
  throwTerminal('同页重试与新浏览器会话重试均失败');
}

async function findHistoryRowBySql(page: Page, marker: string): Promise<Locator | undefined> {
  const row = await firstVisible([
    page.getByRole('row').filter({ hasText: marker }),
    page.locator('tr:visible').filter({ hasText: marker }),
  ], 10_000);
  if (row) return row;
  // 当前版本运行历史使用卡片列表，卡片内有 SQL 和“预览/申请下载”，
  // 不应限定为 table row。
  return firstVisible([
    page.locator('div:visible').filter({ hasText: marker }).filter({ hasText: /预览|申请下载|下载/ }).last(),
    page.getByText(marker, { exact: false }).filter({ visible: true }).last().locator('..'),
  ], 10_000);
}

function buildMysqlLargeResultSql(marker: string, rowCount = 1_200): string {
  // 不能拼接 1200 段 UNION ALL：SQL 过长、错误难以定位，并且没有真正覆盖
  // “大于 1000 行”的下载分支。当前专项数据源固定为 MySQL 8，使用 4 位数字
  // 的笛卡尔积一次生成 0～9999 的序列，再取前 1200 行。它只读、不依赖业务表。
  const safeRowCount = Math.max(1, Math.min(rowCount, 10_000));
  const digits = 'SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9';
  const rowNumber = 'ones.n + tens.n * 10 + hundreds.n * 100 + thousands.n * 1000';
  // 直接在四个数字集合的笛卡尔积上计算序号；输出无首尾空行、无分号的标准 SQL。
  return [
    'SELECT',
    `  ${rowNumber} + 1 AS row_id,`,
    `  CONCAT('${marker}_', LPAD(${rowNumber} + 1, 4, '0')) AS download_marker`,
    `FROM (${digits}) AS ones`,
    `CROSS JOIN (${digits}) AS tens`,
    `CROSS JOIN (${digits}) AS hundreds`,
    `CROSS JOIN (${digits}) AS thousands`,
    `WHERE ${rowNumber} < ${safeRowCount}`,
    'ORDER BY row_id',
  ].join('\n');
}

async function findHistoryDownloadButton(row: Locator, large: boolean): Promise<Locator | undefined> {
  const buttons = row.locator('button:visible, a:visible, [role="button"]:visible');
  for (let index = await buttons.count() - 1; index >= 0; index -= 1) {
    const button = buttons.nth(index);
    const metadata = [
      await button.innerText().catch(() => ''),
      await button.getAttribute('aria-label'),
      await button.getAttribute('title'),
    ].filter(Boolean).join(' ');
    if (!/下载/i.test(metadata)) continue;
    if (large && /csv/i.test(metadata)) continue;
    if (!large && !/csv/i.test(metadata)) continue;
    return button;
  }
  return undefined;
}

async function downloadCurrentResult(
  page: Page,
  testInfo: TestInfo,
  label: string,
  eventTimeoutMs = 30_000,
): Promise<string> {
  // 结果面板的“下载”才是当前结果文件下载；运行历史卡片上的“申请下载”
  // 只代表提交异步任务，不能作为文件已经落地的通过依据。
  const downloadButton = page.getByRole('button', { name: /下载/ }).last();
  await expect(downloadButton).toBeVisible({ timeout: 10_000 });
  const downloadPromise = page.waitForEvent('download', { timeout: eventTimeoutMs }).catch(() => undefined);
  await downloadButton.click();
  const download = await downloadPromise;
  if (!download) throw new Error(`${label}点击“下载”后未产生浏览器文件下载。`);
  // 当前版本结果面板导出文件名为“结果 N.xls”，而历史版本可能是 CSV/XLSX。
  // 用例的核心是浏览器真实下载、文件非空和结果内容，不应把前端导出格式差异误报成下载失败。
  const savedPath = await persistAndAssertDownload(download, testInfo, label, /\.(?:csv|xls|xlsx)$/i);
  // 下载成功提示、浏览器下载反馈会短暂覆盖右侧执行按钮。下一步还要执行 SQL，
  // 先收起页面通知层；executeSql 内也会再次 Esc，避免不同版本的提示层残留。
  for (const close of [
    page.locator('.ant-message-notice-close:visible, .ant-notification-close-icon:visible, .el-notification__closeBtn:visible'),
  ]) {
    for (let index = 0; index < await close.count(); index += 1) {
      await close.nth(index).click({ force: true }).catch(() => undefined);
    }
  }
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(350);
  return savedPath;
}

/**
 * MySQL 查询结果以流式结果集保留在连接上；若不关闭当前“结果 N”页签就立即
 * 执行下一条 SQL，后端会返回 “Streaming result set is still active”。
 */
async function closeCurrentQueryResult(page: Page): Promise<void> {
  const resultTabs = page.getByRole('tab').filter({ hasText: /^\s*结果\s*\d+/ });
  let selectedTab: Locator | undefined;
  for (let index = await resultTabs.count() - 1; index >= 0; index -= 1) {
    const candidate = resultTabs.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    if ((await candidate.getAttribute('aria-selected')) === 'true') {
      selectedTab = candidate;
      break;
    }
  }
  selectedTab ??= await firstVisible([resultTabs.last()], 2_000);
  if (!selectedTab) throw new Error('小结果下载完成后未找到当前“结果 N”页签，无法释放流式结果集。');

  const close = selectedTab.locator('[aria-label="图标: close"], [aria-label="icon: close"], .anticon-close').first();
  await expect(close).toBeVisible({ timeout: 5_000 });
  await close.click({ force: true });
  await page.waitForTimeout(500);
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

  // 当前版本将运行历史作为左侧控制台 tab 展示；编辑器标题栏的
  // clock-circle 仅是计时器，优先点击真实的“运行历史”tab。
  const historyTab = page.getByRole('tab', { name: '运行历史', exact: true }).last();
  if (await historyTab.isVisible().catch(() => false)) {
    await historyTab.click();
    await page.waitForTimeout(800);
    return;
  }

  // 真实页面结构：查询结果标题的同级工具栏依次是导出、历史（时钟）、刷新。
  // 只在该工具栏内取 history，避免误点编辑器顶部的 clock-circle。
  const resultToolbar = resultTitle.locator('..');
  const historyButton = await firstVisible([
    resultToolbar.locator('[aria-label="图标: history"]:visible'),
    resultToolbar.locator('[aria-label="图标: clock-circle"]:visible'),
    resultToolbar.locator('[title*="历史"]:visible, [aria-label*="历史"]:visible'),
    // 当前版本将运行历史时钟放在查询控制台标题栏，结果面板展开后从页面
    // 唯一可见的 clock-circle 兜底定位。
    page.locator('[aria-label="图标: clock-circle"]:visible').last(),
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

function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, '_');
}

/**
 * 下载成功必须产生一个可长期保留的本地文件：
 * - download 事件只能证明浏览器开始处理下载；
 * - download.path() 位于 Playwright 临时目录，浏览器上下文关闭后可能被清理；
 * - saveAs() 后再校验并附加到报告，才能作为本轮测试的实际下载证据。
 */
async function persistAndAssertDownload(
  download: Download,
  testInfo: TestInfo,
  label: string,
  expectedFileName?: RegExp,
): Promise<string> {
  const failure = await download.failure();
  expect(failure, `${label}下载失败`).toBeNull();

  const suggestedFileName = download.suggestedFilename().trim();
  expect(suggestedFileName, `${label}下载未返回文件名`).not.toBe('');
  if (expectedFileName) {
    expect(suggestedFileName, `${label}下载文件名或格式不正确`).toMatch(expectedFileName);
  }

  const downloadDirectory = testInfo.outputPath('downloads');
  await mkdir(downloadDirectory, { recursive: true });
  const savedFileName = `${safeFileName(label)}-${safeFileName(suggestedFileName)}`;
  const savedFilePath = testInfo.outputPath('downloads', savedFileName);
  await download.saveAs(savedFilePath);

  await access(savedFilePath, fsConstants.R_OK);
  const fileInfo = await stat(savedFilePath);
  expect(fileInfo.isFile(), `${label}下载结果不是文件：${savedFilePath}`).toBe(true);
  expect(fileInfo.size, `${label}下载结果为空文件：${savedFilePath}`).toBeGreaterThan(0);

  await testInfo.attach(`${label}-${suggestedFileName}`, {
    path: savedFilePath,
    contentType: /\.csv$/i.test(suggestedFileName) ? 'text/csv' : 'application/octet-stream',
  });
  return savedFilePath;
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
test.describe("DQ-04-01｜数据查询｜小结果 CSV 下载和大文件下载", () => {
  test.beforeEach(async ({ loginPage }, testInfo) => {
    // 行49包含菜单重载、运行历史和脚本树刷新；超时必须在 beforeEach 开始前调高，
    // 仅在用例正文中 test.setTimeout 会来不及覆盖慢速菜单导航。
    if (testInfo.title.includes('历史会话与脚本：执行生成历史会话')) {
      testInfo.setTimeout(120_000);
    }
    await openSelfServiceQuery(loginPage);
  })
  test("DQ-04-01｜数据查询｜小结果 CSV 下载和大文件下载", async ({ loginPage, consoleErrors, report }, testInfo) => {
      test.setTimeout(TEST_TIMEOUT);
      const page = loginPage;
      // 本用例的两条 SQL 都不访问业务表：只需确认 MySQL 数据源已选中即可。
      // 当前前端版本选择数据源后只渲染资源树（无 Schema 下拉框），不能再因
      // 与下载无关的 Schema 控件缺失而中断实际下载验证。
      if (!(await chooseConfiguredDataSourceOrSkip(page, { schema: false }))) return;
      await settleDropdown(page);
      const smallMarker = `download_small_${uuid()}`;
      const smallSql = `SELECT 1 AS ${smallMarker}`;
      // 小结果执行前没有下载动作，不存在流式占用，只做同页重试。
      const smallRun = await executeSqlUntilResult(page, smallSql, smallMarker, 60_000);

      // 必须在小结果仍是当前结果时下载，不能先执行大结果再把同一份文件
      // 误记成“小结果下载”。
      const smallDownload = await downloadCurrentResult(smallRun.resultPage, testInfo, '小结果表格');
      await closeCurrentQueryResult(smallRun.resultPage);

      const largeMarker = `download_large_${uuid()}`;
      const largeSql = buildMysqlLargeResultSql(largeMarker);
      // 小结果下载后，后端流式结果集长时间占用连接（run-20260915-104846-255 与
      // run-20260915-105736-519 两次实测，同页重试 8 次/150 秒仍失败）。按真实
      // 用户升级式恢复：同页“关闭报错页签→退避重试”，仍失败则新开浏览器会话
      // （同账号重新登录）后重试；无论哪种途径，结果与下载都必须真实发生。
      const streamingErrors: string[] = [];
      const largeRun = await executeSqlUntilResult(page, largeSql, largeMarker, 150_000, {
        allowNewSession: true,
        streamingErrors,
      });

      // 直接从结果面板下载并落盘，避免把运行历史中的“申请下载”或进度条
      // 当成文件已生成；小结果和较大结果都必须产生非空本地文件。大结果
      // 可能经历异步生成，下载事件等待单独放宽到 120 秒。
      const largeDownload = await downloadCurrentResult(largeRun.resultPage, testInfo, '大结果表格', DOWNLOAD_EVENT_TIMEOUT_LARGE);
      // 新会话中的下载文件已落盘并附加到报告，此时可安全关闭该上下文。
      await largeRun.contextToClose?.close().catch(() => undefined);
      await assertNoConsoleErrors(consoleErrors);
      const escalationNote = largeRun.escalations.length
        ? `；流式占用恢复动作：${largeRun.escalations.join('→')}`
        : '';
      const streamingNote = streamingErrors.length ? `；流式占用报错 ${streamingErrors.length} 次` : '';
      await report('自助查询-小结果与大文件实际下载', true, `小结果=${smallDownload}；大结果=${largeDownload}${escalationNote}${streamingNote}`);
    })
});
