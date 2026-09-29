/**
 * 数据查询 — DQ-03-01 自助查询：执行历史 → 底部箭头 → 历史按钮 → 文件夹/脚本 增改删
 *
 * 用例行 49：历史会话与脚本管理——文件夹/脚本增删改；脚本增删改不影响执行记录。
 *
 * 页面业务事实（run-20260914-110852-805 失败快照 + 20260915 任务确认）：
 *   1. 自助查询先真实执行只读 SQL（SELECT 1 AS <uuid marker>），以结果表头回显为准；
 *   2. 黑色结果区折叠时底部只有一个向上箭头（图标: up），先点开；
 *   3. 结果区右上角有两个时钟按钮（图标: clock-circle）：第一个是执行计时器，
 *      第二个才进入“运行历史”；
 *   4. 运行历史与脚本管理同在左侧控制台（Tab：数据源/运行历史/脚本）：
 *      - 运行历史：本轮 SQL 卡片（listitem，内含 SQL 文本与 预览/申请下载）；
 *      - 脚本：搜索框（“搜索脚本或文件夹”）+ 文件夹树，节点为普通 generic
 *        （无 treeitem role），每行自带 图标: edit / 图标: delete，caret 控制展开。
 *
 * 历史失败结论（temp/环境阻断报告-dq-03-01-repair-20260908.md 等）：
 *   - 旧实现用全页 getByText('我的文件夹') 选父级，点到左侧脚本树同名节点，
 *     父级未真正选中 → 文件夹被建到根目录（快照中历史遗留 folder_* 全在根层级）；
 *   - HN-20260911-170538-001：新建文件夹提示“创建成功”但树不显示。
 *
 * run-20260915-121633-268（20260915 页面回归 r1）实测补充：
 *   - 切走再切回“脚本”Tab 并不会重拉左树——新建/重命名后的节点在整树里始终
 *     不出现（失败快照中树仅有“公共文件夹/我的文件夹”两个根节点），而搜索框
 *     过滤与下拉浮层都是实时数据（保存脚本弹窗能立刻选到刚建的文件夹）。
 *     因此：回显/行内操作/展开以“搜索呈现节点”为可见性手段，“消失”以
 *     “实时搜索不到”为判据；Tab 切换仍按页面规范执行（清过滤 + 切换），
 *     但不再把“整树可见”当作真判据。
 *
 * run-20260915-125534-973（r2 第一轮）实测补充：
 *   - 链路前段（SQL 执行、运行历史入口与回显、文件夹增改、脚本保存与重命名、
 *     回显/消失断言）全部真实通过；失败在脚本删除——搜索结果由后端异步返回，
 *     findTreeRow“等 800ms + 单次定位”会在结果渲染前放弃（失败快照里目标节点
 *     连同行内 edit/delete 图标实际已渲染）。因此 findTreeRow 搜索后改为
 *     250ms 间隔轮询定位（10 秒上限），其余判据不变。
 *
 * run-20260915-134701-316（r2 第二轮全量）实测补充：
 *   - 删除脚本步骤报“删除目标不可见”：失败快照显示“脚本”Tab 已 [selected]，但
 *     控制台只渲染了数据源/运行历史两个面板，脚本面板（搜索框+树）整体未挂载
 *     （DQ-06-03 同轮同证）。快速“运行历史→脚本”切换会触发该懒加载面板丢挂载。
 *     修复：searchScriptTree 找不到搜索框时先 ensureScriptPanelVisible 重点击
 *     “脚本”Tab 强制重新挂载，仍不可用才按“搜索框不可用”上报。
 *
 * run-20260929-002954-565 失败 + 后端静态核对（agent-10 复核）：
 *   - 失败：新建文件夹弹窗父级下拉未提供“我的文件夹”；失败快照里脚本 Tab 只剩
 *     搜索框、整树无任何节点（连“公共文件夹”也未提供）——环境清理后
 *     df_self_query_dict 的根节点种子数据不复存在；
 *   - 后端证据（C:\Users\gaosen\Desktop\auto_test\bigdata-factory-api）：
 *     SelfQueryController 暴露 /self/query/addDict、/updateDict、/deleteDict、
 *     /queryRootDict、/allDict；SelfQueryBizImpl#listRootDict 仅按 parent_id='-1'
 *     查库、无任何兜底创建；#createDict 要求父目录已存在且 dict_type 继承父级；
 *     #updateDict/#deleteDict 仅创建者可操作、删除前校验目录下无子节点；
 *     “我的文件夹(id=2)/公共文件夹(id=1)”仅由一次性初始化脚本
 *     bigdata-factory-api-boot/sql/mysql.sql(L4134-4135)、gauss.sql(L3480-3481)
 *     写入（create_by='system'）。
 *   - 结论：“我的文件夹”不是后端运行时保证的默认根节点，而新用例不得依赖历史
 *     用户数据 → 父级改为在弹窗下拉中按候选顺序动态解析（私有系统根“我的文件夹”
 *     优先、公共系统根“公共文件夹”兜底，均缺失则按环境前置缺失跳过）；本轮自建
 *     唯一英文文件夹作前置，原有脚本增改删断言全部保留，finally 按“先脚本后
 *     文件夹”精确回收（后端禁止删除仍有子节点的目录）。
 *
 * 验证闭环（每轮对象均为 UUID 唯一名，只影响本轮数据）：
 *   - 历史：执行后回显；脚本增删改后历史仍在（不影响执行记录）；
 *   - 文件夹：新增（回显）→ 重命名（新名回显/旧名消失）→ 删除（消失）；
 *   - 脚本：保存（回显）→ 重命名（新名回显/旧名消失）→ 删除（消失）。
 */

import type { Locator, Page } from '@playwright/test';
import { test, expect, uuid } from '../utils.js';
import {
  assertNoConsoleErrors,
  chooseConfiguredDataSource,
  executeSql,
  openSelfServiceQuery,
  settleDropdown,
  tableRows,
} from '../utils.js';

const CONFIGURED_SOURCE = {
  type: process.env.QUERY_SOURCE_TYPE?.trim() || 'MYSQL',
  name: process.env.QUERY_SOURCE_NAME?.trim() || '192.168.76.110:13306/e2e_test',
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactText(text: string): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`);
}

async function firstVisible(candidates: Locator[], timeout = 0): Promise<Locator | undefined> {
  const deadline = Date.now() + timeout;
  do {
    for (const candidate of candidates) {
      const count = await candidate.count();
      // 结果面板、弹窗和抽屉经常保留同名隐藏节点，倒序优先当前可见实例。
      for (let index = count - 1; index >= 0; index -= 1) {
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
  const target = await firstVisible(
    [
      page
        .locator('button:visible, a:visible, label:visible, [role="button"]:visible, [role="tab"]:visible')
        .filter({ hasText: exactText(text) }),
      page.getByText(text, { exact: true }).filter({ visible: true }),
    ],
    10_000,
  );
  if (!target) throw new Error(`可见文本“${text}”未找到，当前页面：${page.url()}`);
  await target.click();
  await page.waitForTimeout(500);
}

async function clickVisibleButton(page: Page, name: RegExp): Promise<void> {
  const target = await firstVisible(
    [
      page.getByRole('button', { name }).filter({ visible: true }),
      page.locator('button:visible, [role="button"]:visible').filter({ hasText: name }),
    ],
    10_000,
  );
  if (!target) throw new Error(`可见按钮“${name}”未找到，当前页面：${page.url()}`);
  await target.click();
  await page.waitForTimeout(500);
}

/**
 * 数据源选择失败时只对已确认的“下拉项不存在”分支抛环境前置条件缺失；
 * 其它错误继续抛出，避免把真实定位或服务问题伪装成环境阻断。
 */
async function chooseConfiguredDataSourceOrSkip(page: Page): Promise<boolean> {
  try {
    await chooseConfiguredDataSource(page, { ...CONFIGURED_SOURCE, schema: false });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingType = message.includes(`下拉选项“${CONFIGURED_SOURCE.type}”未找到`);
    const missingSource = message.includes(`下拉选项“${CONFIGURED_SOURCE.name}”未找到`);
    if (missingType || missingSource) {
      const missing = missingType ? `数据源类型 ${CONFIGURED_SOURCE.type}` : `数据源 ${CONFIGURED_SOURCE.name}`;
      throw new Error(`环境前置条件缺失：未提供 ${missing}，无法完成真实连接选择。`);
    }
    throw error;
  }
}

/** 仅这些错误代表“执行机剪贴板链不可用”，才允许降级为键盘一次性插入。（DQ-04-01 已验证实现） */
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
 * 按“前 48 字符探针 + 本轮 marker”判据回读 Monaco 编辑器，确认 SQL 已写入。
 * 与下方降级路径同一口径：视图模型 + textarea 输入值一起读（textarea 的
 * inputValue 不一定同步）。共享 executeSql 内部的粘贴校验是 best-effort
 * （失败被吞掉后仍会点击执行按钮），因此调用方必须显式回读确认。
 */
async function editorContainsSql(page: Page, sql: string): Promise<boolean> {
  const editor = page.getByRole('textbox', { name: /Editor content;Press Alt\+F1/ }).last();
  const normalizeSqlText = (value: string): string => value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const editorText = async (): Promise<string> =>
    `${await page.locator('.monaco-editor:visible .view-lines').last().innerText().catch(() => '')}\n${await editor.inputValue().catch(() => '')}`;
  const expected = normalizeSqlText(sql);
  const probe = expected.slice(0, 48);
  const markerText = normalizeSqlText(markerOf(sql));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const actual = normalizeSqlText(await editorText());
    if (actual.includes(probe) && actual.includes(markerText)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}


/**
 * 公共 executeSql 优先按“人工复制后 Ctrl+V”路径把长 SQL 一次性粘贴进 Monaco。
 * run-20260914-110852-805 的真实失败是执行机系统剪贴板不可用（powershell/
 * clip.exe 均失败），且被测页面为 http 非安全上下文（navigator.clipboard 为
 * undefined），三级降级全部失败；公共工具按任务约束不改，本 spec 内仅对该
 * 错误降级 page.keyboard.insertText：CDP Input.insertText 同样一次性插入整条
 * SQL，不经系统剪贴板，也不会逐字触发 Monaco 自动补全改写语句。写入后回读
 * 校验（与公共实现一致的前 48 字符探针 + 本轮 marker），最终仍由“结果中出现
 * 本轮 marker”确认 SQL 真实执行。
 *
 * run-20260929-044522-605 新证据：执行机剪贴板三级写入（powershell×4、
 * clip.exe×2、navigator.clipboard×2，http 非安全上下文 TypeError）与合成
 * paste 全部失败后，公共 pasteLongText 不抛错而按成功返回；公共 executeSql
 * 内的粘贴校验是 best-effort（失败被吞掉），于是拿着空编辑器点击了执行按钮
 * ——无任何 SQL 执行 API 调用，25 秒等结果超时。因此 executeSql 正常返回后
 * 必须回读编辑器确认 SQL 确实写入；为空或不匹配时同样走下方 insertText
 * 降级，降级触发不再依赖异常。
 */
async function executeSqlWithClipboardFallback(page: Page, sql: string): Promise<void> {
  let editorReady = false;
  try {
    await executeSql(page, sql);
    editorReady = await editorContainsSql(page, sql);
  } catch (error) {
    if (!isClipboardUnavailable(error)) throw error;
  }
  if (editorReady) return;
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
 * 只读 SELECT 的结果回显判据：marker 是结果列别名，只有结果表会渲染成
 * columnheader；tableRows 兜底。不用全页 getByText(marker)——它会命中 Monaco
 * 编辑器里的 SQL 文本造成假通过（旧实现已删除该候选）。
 * 结果 25 秒未回显且出现 SQL 报错提示时，把报错原文抛出（真实失败，不伪装）。
 */
async function waitForQueryResult(page: Page, marker: string): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const result = await firstVisible(
      [
        page.getByRole('columnheader', { name: exactText(marker) }).filter({ visible: true }),
        tableRows(page).filter({ hasText: marker }),
      ],
      500,
    );
    if (result) return;
    const sqlError = await firstVisible(
      [
        page.locator('.ant-message-error:visible, .el-message--error:visible, .ant-notification-notice-error:visible'),
        page
          .getByText(/SQL解析失败|SQL执行失败|syntax error|查询失败|服务异常|Streaming result set|still active/i)
          .filter({ visible: true }),
      ],
      200,
    );
    if (sqlError) {
      const message = (await sqlError.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (/Streaming result set|still active/i.test(message)) {
        await page.waitForTimeout(3_000); // 结果集暂被占用：退避后继续等本轮 marker
        continue;
      }
      throw new Error(`SQL 执行报错，无法继续历史/脚本验证：“${message}”。`);
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`目标查询结果“${marker}”25 秒内未返回，无法继续验证运行历史。`);
}

/** 运行历史激活判据：Tab 被选中，或历史卡片特征内容（预览/申请下载）可见。 */
async function runHistoryActive(page: Page): Promise<boolean> {
  const tab = page.getByRole('tab', { name: '运行历史', exact: true }).last();
  if ((await tab.getAttribute('aria-selected').catch(() => null)) === 'true') return true;
  return Boolean(
    await firstVisible([page.getByText(/申请下载|预览/).filter({ visible: true })], 500),
  );
}

/**
 * 进入运行历史（入口路径与 DQ-03-02 一致，该 spec 已验证）：
 *   1. 结果区折叠时底部只有“图标: up”向上箭头，先点开；
 *   2. 结果区右上角有两个“图标: clock-circle”：第一个是执行计时器，第二个才是
 *      运行历史入口——按可见顺序取第 2 个；
 *   3. 点击后用 runHistoryActive 验证；未激活则依次退回第 1 个时钟、控制台
 *      “运行历史”Tab（run-20260914 快照实证存在），全部失败才抛错。
 */
async function openRunHistoryPanel(page: Page): Promise<void> {
  const expandArrow = await firstVisible(
    [
      page.locator('[aria-label="图标: up"]:visible'),
      page.locator('[title*="展开"]:visible, [aria-label*="展开"]:visible'),
    ],
    2_000,
  );
  if (expandArrow) {
    await expandArrow.click();
    await page.waitForTimeout(600);
  }

  const clocks = page.locator('[aria-label="图标: clock-circle"]');
  const total = await clocks.count().catch(() => 0);
  const visibleIndexes: number[] = [];
  for (let index = total - 1; index >= 0; index -= 1) {
    if (await clocks.nth(index).isVisible().catch(() => false)) visibleIndexes.push(index);
  }
  visibleIndexes.reverse(); // 还原 DOM 顺序：视觉上第二个时钟 = 可见序列第 2 个
  const candidates: Locator[] = [];
  if (visibleIndexes.length >= 2) candidates.push(clocks.nth(visibleIndexes[1]));
  if (visibleIndexes.length >= 1) candidates.push(clocks.nth(visibleIndexes[0]));
  candidates.push(page.getByRole('tab', { name: '运行历史', exact: true }).last());

  const problems: string[] = [];
  for (const candidate of candidates) {
    try {
      await candidate.click({ timeout: 2_000 });
    } catch (error) {
      problems.push(`点击失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      continue;
    }
    await page.waitForTimeout(800);
    if (await runHistoryActive(page)) return;
    problems.push('点击后运行历史未激活');
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(300);
  }
  throw new Error(`进入“运行历史”失败（已尝试：${problems.join('；')}），当前页面：${page.url()}`);
}

/**
 * 运行历史按 SQL 文本找本轮卡片：run-20260914 快照证实历史是 listitem 卡片
 * （SQL 文本 + 预览/申请下载），不是 table row；卡片优先，行选择器兜底。
 */
async function findHistoryRowBySql(page: Page, sql: string): Promise<Locator | undefined> {
  return firstVisible(
    [
      page.getByRole('listitem').filter({ hasText: sql }),
      page.getByRole('row').filter({ hasText: sql }),
      page.locator('tr:visible').filter({ hasText: sql }),
      page
        .locator('div:visible')
        .filter({ hasText: sql })
        .filter({ hasText: /预览|申请下载|下载/ })
        .last(),
    ],
    15_000,
  );
}

async function switchConsoleTab(page: Page, name: string): Promise<void> {
  const target = await firstVisible(
    [
      page.getByRole('tab', { name: exactText(name) }).filter({ visible: true }),
      page
        .locator('[role="tab"]:visible, .ant-tabs-tab:visible, .el-tabs__item:visible')
        .filter({ hasText: exactText(name) }),
    ],
    10_000,
  );
  if (!target) throw new Error(`控制台 Tab“${name}”未找到，当前页面：${page.url()}`);
  await target.click();
  await page.waitForTimeout(800);
}

/**
 * 左树整树刷新实测不生效（切 Tab 后仍是旧快照），但按页面规范仍走“清空搜索框 →
 * 切运行历史 → 切回脚本”完成刷新动作；可见性与判据由搜索（实时数据）承担，
 * 见 findTreeRow / expandTreeNode / assertTreeEcho / assertTreeGone。
 */
async function refreshScriptTree(page: Page): Promise<void> {
  const searchBox = await firstVisible(
    [page.getByPlaceholder(/搜索脚本或文件夹/).filter({ visible: true })],
    2_000,
  );
  if (searchBox) {
    await searchBox.fill('').catch(() => undefined);
    await page.keyboard.press('Escape').catch(() => undefined);
  }
  await switchConsoleTab(page, '运行历史');
  await switchConsoleTab(page, '脚本');
  await page.waitForTimeout(600);
}

/** 用脚本 Tab 的搜索框过滤树；搜索是实时数据源（左树整树为旧快照，见 assertTreeGone 注释）。
 *  返回是否找到并使用了搜索框，供“消失”判据区分“搜不到”与“没有搜索框”。 */
/**
 * 脚本面板挂载判据：搜索框可见。
 * run-20260915-134701-316 失败快照（本用例删除步骤 + DQ-06-03 新建文件夹步骤同轮
 * 同证）：“脚本”Tab 已 [selected]，但控制台只渲染了数据源/运行历史面板，脚本面板
 * （搜索框+树）整体未挂载——树定位与搜索两处全部扑空。快速“运行历史→脚本”切换
 * 会触发该懒加载面板丢挂载；重点击一次“脚本”Tab 可强制重新挂载。
 */
async function ensureScriptPanelVisible(page: Page): Promise<boolean> {
  const boxVisible = (): Promise<Locator | undefined> =>
    firstVisible(
      [
        page.getByPlaceholder(/搜索脚本或文件夹/).filter({ visible: true }),
        page.getByRole('textbox', { name: /搜索脚本或文件夹/ }).filter({ visible: true }),
      ],
      3_000,
    );
  if (await boxVisible()) return true;
  await switchConsoleTab(page, '脚本');
  return Boolean(await boxVisible());
}

async function searchScriptTree(page: Page, keyword: string): Promise<boolean> {
  const boxCandidates = (): Locator[] => [
    page.getByPlaceholder(/搜索脚本或文件夹/).filter({ visible: true }),
    page.getByRole('textbox', { name: /搜索脚本或文件夹/ }).filter({ visible: true }),
  ];
  let box = await firstVisible(boxCandidates(), 5_000);
  if (!box && (await ensureScriptPanelVisible(page))) {
    box = await firstVisible(boxCandidates(), 2_000);
  }
  if (!box) return false;
  await box.fill(keyword);
  await page.keyboard.press('Enter').catch(() => undefined);
  const searchIcon = await firstVisible(
    [box.locator('xpath=..').locator('[aria-label="图标: search"]:visible')],
    1_000,
  );
  if (searchIcon) await searchIcon.click().catch(() => undefined);
  await page.waitForTimeout(800);
  return true;
}

async function assertTreeEcho(page: Page, name: string, label: string): Promise<void> {
  const target = page.getByText(name, { exact: true }).filter({ visible: true });
  try {
    await expect(target.last(), `${label}“${name}”应在脚本树回显`).toBeVisible({ timeout: 10_000 });
    return;
  } catch {
    // run-20260915-121633-268 实测：切 Tab 后整树仍是旧快照（本轮新建节点根本不在整树里），
    // 直接断言大概率失败；搜索框为实时数据源，用搜索过滤再断言一次，两次都失败才是真失败。
  }
  if (!(await searchScriptTree(page, name))) {
    throw new Error(`脚本 Tab 搜索框不可用，无法验证“${label}“${name}””是否回显，当前页面：${page.url()}`);
  }
  await expect(
    target.last(),
    `${label}“${name}”未在脚本树回显（整树断言与实时搜索均未命中）。` +
      '整树不随 Tab 切换刷新符合已知问题 HN-20260911-170538-001（创建成功但树不显示），但实时搜索仍搜不到即按真实失败上报。',
  ).toBeVisible({ timeout: 10_000 });
}

async function assertTreeGone(page: Page, name: string, label: string): Promise<void> {
  // run-20260915-121633-268 实测：切 Tab 后整树仍是旧快照（本轮新建节点根本不在整树里），
  // “整树看不到”不能作为消失判据——会把“树从未显示过”误判为“已删除”（假通过）。
  // 搜索框是实时数据源：删除/重命名后按名称搜索仍搜得到 = 未消失（真实失败）；搜不到 = 消失证据。
  // 断言前留出搜索结果渲染时间，避免“结果未加载完”造成的假通过。
  if (!(await searchScriptTree(page, name))) {
    throw new Error(`脚本 Tab 搜索框不可用，无法验证“${name}”是否从脚本树消失，当前页面：${page.url()}`);
  }
  await page.waitForTimeout(1_500);
  await expect(
    page.getByText(name, { exact: true }).filter({ visible: true }),
    `${label}“${name}”删除/重命名后按名称搜索仍可见（搜索为实时数据，说明对象未被删除/改名）。`,
  ).toHaveCount(0, { timeout: 10_000 });
}

/**
 * 脚本树节点没有 treeitem role（run-20260914 快照为普通 generic）。
 * 按精确文本向上找包含 edit/delete 图标的行容器，供行内编辑/删除使用；
 * 找不到带图标的容器时退回文本节点本身。
 */
async function findTreeRow(page: Page, name: string): Promise<Locator | undefined> {
  const locateOnce = async (): Promise<Locator | undefined> => {
    const labels = page.getByText(name, { exact: true }).filter({ visible: true });
    for (let index = await labels.count() - 1; index >= 0; index -= 1) {
      const label = labels.nth(index);
      if (!(await label.isVisible().catch(() => false))) continue;
      let scope: Locator = label;
      for (let level = 0; level < 8; level += 1) {
        const rowIcons = scope.locator('[aria-label="图标: edit"]:visible, [aria-label="图标: delete"]:visible');
        if (await rowIcons.count()) return scope;
        scope = scope.locator('..');
      }
      return label;
    }
    return undefined;
  };
  const direct = await locateOnce();
  if (direct) return direct;
  // run-20260915-121633-268 实测：切 Tab 后左树仍是旧快照，本轮新建/改名节点不在整树里，
  // 只有搜索框过滤（实时数据）才呈现。行内 edit/delete 操作前先搜索把目标节点带出来。
  if (!(await searchScriptTree(page, name))) return undefined;
  // run-20260915-125534-973 实测：搜索结果由后端异步返回，“等待 800ms + 单次定位”
  // 会在结果渲染前放弃（失败快照里节点与行内图标实际已渲染）。改为轮询定位。
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const found = await locateOnce();
    if (found) return found;
    await page.waitForTimeout(250);
  }
  return undefined;
}

/** 展开树节点：从名称文本向上找同行 caret（caret-right = 折叠态需点击展开）。
 *  整树找不到时用搜索把节点带出来再试（左树整树为旧快照，见 assertTreeGone 注释）。 */
async function expandTreeNode(page: Page, name: string): Promise<Locator | undefined> {
  const attempt = async (deadline: number): Promise<Locator | undefined> => {
    while (Date.now() < deadline) {
      const labels = page.getByText(name, { exact: true }).filter({ visible: true });
      for (let index = await labels.count() - 1; index >= 0; index -= 1) {
        const label = labels.nth(index);
        if (!(await label.isVisible().catch(() => false))) continue;
        let scope: Locator = label;
        for (let level = 0; level < 8; level += 1) {
          const caret = scope
            .locator(
              '[aria-label="图标: caret-down"]:visible, [aria-label="图标: caret-right"]:visible, [aria-label="图标: caret-up"]:visible',
            )
            .last();
          if (await caret.isVisible().catch(() => false)) {
            const direction = (await caret.getAttribute('aria-label').catch(() => '')) || '';
            if (direction.includes('caret-right')) {
              await caret
                .click({ timeout: 2_000 })
                .catch(() => caret.click({ force: true }).catch(() => undefined));
              await page.waitForTimeout(500);
            }
            return label;
          }
          scope = scope.locator('..');
        }
        return label;
      }
      await page.waitForTimeout(250);
    }
    return undefined;
  };
  const direct = await attempt(Date.now() + 4_000);
  if (direct) return direct;
  if (!(await searchScriptTree(page, name))) return undefined;
  return attempt(Date.now() + 6_000);
}

/** 下拉浮层定位器：父级/文件夹选择必须限定在浮层内，不能全页找同名文本。 */
function dropdownOverlay(page: Page): Locator {
  return page.locator(
    '.ant-select-dropdown:visible, .el-select-dropdown:visible, ' +
      '.ant-cascader-menus:visible, .el-cascader-panel:visible, ' +
      '.ant-tree-select-dropdown:visible, [role="listbox"]:visible',
  );
}

/**
 * 在运行时解析出的父级下新建本轮唯一英文文件夹，返回实际选中的父级名；
 * 父级下拉未提供任何候选系统根时返回 undefined（调用方按环境前置缺失跳过）。
 * 关键约束一：父级选项必须限定在下拉浮层内——旧实现全页 getByText('我的文件夹')
 * 会点到左侧脚本树同名节点，父级从未真正选中，历史轮次的 folder_* 全被建到
 * 根目录（run-20260914 快照根层级遗留 folder_443cbb7e 等即此原因）。
 * 关键约束二：父级不能写死——“我的文件夹/公共文件夹”只是建库初始化脚本
 * （mysql.sql/gauss.sql）写入 df_self_query_dict 的种子数据，后端运行时不保证
 * 存在（SelfQueryBizImpl#listRootDict 仅查库、#createDict 要求父目录已存在），
 * 因此按 parentNames 顺序在浮层内动态解析候选。
 */
async function createFolderUnder(
  page: Page,
  folderName: string,
  parentNames: string[],
): Promise<string | undefined> {
  await page.locator('[aria-label="图标: plus-circle"]:visible').first().click();
  await clickVisibleText(page, '新增文件夹').catch(() => clickVisibleText(page, '新建文件夹'));
  const folderDialog = page.locator('.ant-modal:visible, [role="dialog"]:visible').last();
  await expect(folderDialog).toBeVisible({ timeout: 10_000 });

  const parentText = folderDialog.getByText('请选择父级文件夹', { exact: true }).first();
  if (!(await parentText.isVisible().catch(() => false))) {
    throw new Error(`新建文件夹弹窗中未找到“请选择父级文件夹”选择器，当前页面：${page.url()}`);
  }
  await parentText.click();
  let parentOption: Locator | undefined;
  let chosenParent: string | undefined;
  for (const parentName of parentNames) {
    let option = await firstVisible([dropdownOverlay(page).getByText(parentName, { exact: true })], 3_000);
    if (!option) {
      // 下拉可能没被文本点击打开：再按弹窗内 combobox 方式点一次后重试当前候选。
      const combobox = await firstVisible([folderDialog.locator('[role="combobox"]:visible')], 1_500);
      if (combobox) await combobox.click().catch(() => undefined);
      option = await firstVisible([dropdownOverlay(page).getByText(parentName, { exact: true })], 3_000);
    }
    if (option) {
      parentOption = option;
      chosenParent = parentName;
      break;
    }
  }
  if (!parentOption || !chosenParent) {
    const cancel = await firstVisible(
      [folderDialog.getByRole('button', { name: /取\s*消/ }).filter({ visible: true })],
      1_500,
    );
    if (cancel) await cancel.click().catch(() => undefined);
    return undefined;
  }
  await parentOption.click();
  await settleDropdown(page);

  const nameInput = await firstVisible(
    [
      page.getByPlaceholder(/请输入文件夹名称/).filter({ visible: true }),
      folderDialog.getByPlaceholder(/名称/).filter({ visible: true }),
      folderDialog.locator('input:visible').last(),
    ],
    10_000,
  );
  if (!nameInput) throw new Error('文件夹名称输入框未找到或不可见。');
  await nameInput.fill(folderName);
  await clickVisibleButton(page, /^\s*确\s*定\s*$/);
  await expect(
    page.getByText(/文件夹创建成功|创建成功|操作成功/).filter({ visible: true }).last(),
  ).toBeVisible({ timeout: 10_000 });
  return chosenParent;
}

/**
 * 行内“编辑”图标重命名。编辑弹窗结构未在快照中确认，按两个可靠信号定位名称框：
 * 弹窗内值为旧名的 input（父级/名称同框时唯一准确），找不到再找页面上值为旧名
 * 的 input（行内编辑态）。成功 toast 文案未知，只做辅助等待，真实判据是随后的
 * 回显/消失断言。
 */
async function renameTreeNode(page: Page, oldName: string, newName: string): Promise<void> {
  const row = await findTreeRow(page, oldName);
  if (!row) throw new Error(`重命名目标“${oldName}”在脚本树中不可见，无法点击编辑图标。`);
  await row
    .getByText(oldName, { exact: true })
    .first()
    .scrollIntoViewIfNeeded({ timeout: 3_000 })
    .catch(() => undefined);
  await row
    .locator('[aria-label="图标: edit"]')
    .first()
    .click({ timeout: 3_000 })
    .catch(() => row.locator('[aria-label="图标: edit"]').first().click({ force: true }));

  const dialog = page.locator('.ant-modal:visible, [role="dialog"]:visible').last();
  let nameInput: Locator | undefined;
  const scopes: Locator[] = [];
  if (await dialog.isVisible().catch(() => false)) scopes.push(dialog.locator('input:visible'));
  // 全页兜底时排除左树搜索框：assertTreeEcho 的搜索回退会把搜索框填成本轮对象名，
  // 其值恰好等于旧名，若不排除会把新名误填进搜索框而不是重命名输入框。
  scopes.push(page.locator('input:visible:not([placeholder*="搜索脚本或文件夹"])'));
  for (const scope of scopes) {
    for (let index = await scope.count() - 1; index >= 0; index -= 1) {
      const input = scope.nth(index);
      const value = ((await input.inputValue().catch(() => '')) || '').trim();
      if (value === oldName) {
        nameInput = input;
        break;
      }
    }
    if (nameInput) break;
  }
  if (!nameInput) {
    throw new Error(
      `点击“${oldName}”编辑图标后未出现可用的重命名输入框（弹窗与行内都没有值为旧名的输入框），当前页面：${page.url()}`,
    );
  }
  await nameInput.fill(newName);
  const confirm = await firstVisible(
    [
      dialog.getByRole('button', { name: /^\s*确\s*定\s*$/ }).filter({ visible: true }),
      page.getByRole('button', { name: /^\s*确\s*定\s*$/ }).filter({ visible: true }),
    ],
    5_000,
  );
  if (confirm) await confirm.click();
  else await nameInput.press('Enter');
  await firstVisible(
    [page.getByText(/修改成功|编辑成功|更新成功|重命名成功|操作成功|保存成功/).filter({ visible: true })],
    3_000,
  );
}

/**
 * 把当前编辑器 SQL 保存为脚本并放入本轮文件夹。
 * 文件夹选项同样限定在下拉浮层内（同父级选择的教训），选择成功与否由随后的
 * 树回显 + 嵌套证据判定，不以保存 toast 替代。
 */
async function saveScriptIntoFolder(page: Page, folderName: string, scriptName: string): Promise<void> {
  await clickVisibleButton(page, /保\s*存/);
  const saveDialog = page.locator('.ant-modal:visible, [role="dialog"]:visible').last();
  await expect(saveDialog).toBeVisible({ timeout: 10_000 });
  await saveDialog.locator('input:visible').first().fill(scriptName);

  const folderPlaceholder = saveDialog.getByText('请选择文件夹', { exact: true }).first();
  if (!(await folderPlaceholder.isVisible().catch(() => false))) {
    throw new Error('保存脚本弹窗中未找到“请选择文件夹”选择器。');
  }
  await folderPlaceholder.click();
  let folderOption = await firstVisible([dropdownOverlay(page).getByText(folderName, { exact: true })], 5_000);
  if (!folderOption) {
    const combobox = await firstVisible([saveDialog.locator('[role="combobox"]:visible')], 1_500);
    if (combobox) await combobox.click();
    folderOption = await firstVisible([dropdownOverlay(page).getByText(folderName, { exact: true })], 5_000);
  }
  if (!folderOption) throw new Error(`保存脚本弹窗下拉中未找到本轮文件夹“${folderName}”选项。`);
  await folderOption.click();
  await settleDropdown(page);

  const saveConfirm = await firstVisible(
    [saveDialog.getByRole('button', { name: /^\s*确\s*定\s*$/ }).filter({ visible: true })],
    10_000,
  );
  if (!saveConfirm) throw new Error('保存脚本确认按钮未找到或不可见。');
  await saveConfirm.click();
  await expect(
    page.getByText(/保存成功|新增成功|操作成功/).filter({ visible: true }).last(),
  ).toBeVisible({ timeout: 10_000 });
}

/**
 * 嵌套证据：脚本文本节点的祖先中存在“直接包含文件夹名文本节点”的元素，
 * 即脚本渲染在该文件夹内部。若树实现为平铺渲染（同级缩进）会拿不到该证据，
 * 只作报告记录，回显断言不依赖它。
 */
async function scriptInsideFolder(page: Page, folderName: string, scriptName: string): Promise<boolean> {
  const label = page.getByText(scriptName, { exact: true }).filter({ visible: true }).last();
  if (!(await label.isVisible().catch(() => false))) return false;
  const folderAncestor = label.locator(
    `xpath=ancestor::*[text()[normalize-space(.)='${folderName}']]`,
  );
  return (await folderAncestor.count().catch(() => 0)) > 0;
}

/**
 * 行内“删除”图标删除节点。可能有确认弹窗（Modal/Popconfirm），5 秒内出现则确认；
 * 无确认弹窗视为直接删除。删除 toast 文案未知，真实判据是随后的消失断言。
 */
async function deleteTreeNode(page: Page, name: string): Promise<void> {
  const row = await findTreeRow(page, name);
  if (!row) throw new Error(`删除目标“${name}”在脚本树中不可见，无法点击删除图标。`);
  await row
    .getByText(name, { exact: true })
    .first()
    .scrollIntoViewIfNeeded({ timeout: 3_000 })
    .catch(() => undefined);
  await row
    .locator('[aria-label="图标: delete"]')
    .first()
    .click({ timeout: 3_000 })
    .catch(() => row.locator('[aria-label="图标: delete"]').first().click({ force: true }));
  const confirm = await firstVisible(
    [
      page
        .locator('.ant-modal:visible, [role="dialog"]:visible, .ant-popover:visible, .ant-popconfirm:visible')
        .getByRole('button', { name: /^\s*确\s*定\s*$/ })
        .filter({ visible: true }),
      page.getByRole('button', { name: /^\s*确\s*定\s*$/ }).filter({ visible: true }),
    ],
    5_000,
  );
  if (confirm) await confirm.click();
  await firstVisible([page.getByText(/删除成功|操作成功/).filter({ visible: true })], 3_000);
}

/**
 * 轮次兜底回收（finally 专用）：按“先脚本后文件夹”删除本轮对象——后端
 * deleteDict 禁止删除仍有子节点的目录（SelfQueryBizImpl#deleteDict），脚本必须
 * 先于所在文件夹删除。每个对象先按实时搜索确认可见：搜不到视为已回收/未创建
 * （不记残留）；可见但删除/消失验证失败才记入残留串，由调用方 attach 到测试
 * 报告供人工确认。全程 best-effort，任何异常都不改变用例本身的结果。
 */
async function recycleRoundTreeNodes(page: Page, scriptNames: string[], folderNames: string[]): Promise<string> {
  const leftovers: string[] = [];
  try {
    // 失败现场可能停在弹窗/下拉浮层：先收起，避免遮挡脚本 Tab 的搜索与行内删除。
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(300);
  } catch {
    return leftovers.join(', ');
  }
  for (const name of [...scriptNames, ...folderNames]) {
    try {
      if (!(await findTreeRow(page, name))) continue;
      await deleteTreeNode(page, name);
      await assertTreeGone(page, name, '兜底回收');
    } catch {
      leftovers.push(name);
    }
  }
  return leftovers.join(', ');
}

test.describe('DQ-03-01｜数据查询｜执行历史→底部箭头→历史按钮→文件夹 脚本增改删', () => {
  test.beforeEach(async ({ loginPage }) => {
    await openSelfServiceQuery(loginPage);
  });

  test('DQ-03-01｜数据查询｜执行历史→底部箭头→历史按钮→文件夹 脚本增改删', async ({
    loginPage,
    consoleErrors,
    report,
  }) => {
    // 一条长链路：执行 SQL → 运行历史回显 → 本轮唯一英文文件夹前置（文件夹 增/改）→
    // 脚本 增/改/删 → 文件夹 删（即精确回收）→ 历史保留；任何一步失败由 finally 兜底回收。
    test.setTimeout(300_000);
    const page = loginPage;
    const testInfo = test.info();
    if (!(await chooseConfiguredDataSourceOrSkip(page))) return;
    await settleDropdown(page);

    const marker = `dq03_${uuid()}`;
    const sql = `SELECT 1 AS ${marker}`;
    await executeSqlWithClipboardFallback(page, sql);
    await waitForQueryResult(page, marker);

    // ① 运行历史：底部箭头展开结果区 → 右上角第二个时钟按钮进入
    await openRunHistoryPanel(page);
    const historyRow = await findHistoryRowBySql(page, sql);
    if (!historyRow) {
      throw new Error(`环境前置条件缺失：目标历史会话“${sql}”未出现在当前用户的运行历史中。`);
    }
    await report('执行SQL并进入运行历史', true, `SQL=${sql}；运行历史卡片已回显`);

    // ② 脚本 Tab：本轮唯一英文文件夹前置 → 文件夹 改 → 脚本 增/改/删 → 文件夹 删
    await switchConsoleTab(page, '脚本');
    const folderName = `folder_${uuid()}`;
    const folderRenamed = `folder_${uuid()}_r`;
    const scriptName = `script_${uuid()}`;
    const scriptRenamed = `script_${uuid()}_r`;
    // 重命名后跟随更新；finally 兜底回收按最新名优先尝试。
    let folderCurrentName = folderName;
    try {
      // “我的文件夹”只是建库初始化脚本写入的种子数据（后端运行时不保证存在，见文件头
      // run-20260929 复核说明），新用例不得依赖：父级在弹窗下拉中按候选顺序动态解析，
      // 私有系统根“我的文件夹”优先、公共系统根“公共文件夹”兜底；两者都未提供说明
      // 字典根数据缺失，无法安全建立本轮前置，按环境前置缺失跳过（不伪造通过）。
      const parentRoot = await createFolderUnder(page, folderName, ['我的文件夹', '公共文件夹']);
      if (!parentRoot) {
        await report(
          '文件夹新增+重命名',
          false,
          '环境前置缺失：新建文件夹弹窗的父级下拉未提供“我的文件夹/公共文件夹”任一系统根' +
            '（两者仅由建库初始化脚本 mysql.sql/gauss.sql 写入，后端运行时不保证），本轮唯一英文文件夹前置无法建立，跳过。',
        );
        testInfo.skip();
        return;
      }
      await refreshScriptTree(page);
      await assertTreeEcho(page, folderName, '新增文件夹');

      await renameTreeNode(page, folderName, folderRenamed);
      folderCurrentName = folderRenamed;
      await refreshScriptTree(page);
      await assertTreeEcho(page, folderRenamed, '重命名后文件夹');
      await assertTreeGone(page, folderName, '重命名前文件夹');
      await report('文件夹新增+重命名', true, `父级=${parentRoot}；${folderName} → ${folderRenamed}`);

      await saveScriptIntoFolder(page, folderRenamed, scriptName);
      await refreshScriptTree(page);
      await expandTreeNode(page, folderRenamed);
      await assertTreeEcho(page, scriptName, '保存后脚本');
      const nested = await scriptInsideFolder(page, folderRenamed, scriptName);

      await renameTreeNode(page, scriptName, scriptRenamed);
      await refreshScriptTree(page);
      await expandTreeNode(page, folderRenamed);
      await assertTreeEcho(page, scriptRenamed, '重命名后脚本');
      await assertTreeGone(page, scriptName, '重命名前脚本');
      await report('脚本保存+重命名', true, `${scriptName} → ${scriptRenamed}`);

      await deleteTreeNode(page, scriptRenamed);
      await refreshScriptTree(page);
      await assertTreeGone(page, scriptRenamed, '删除后脚本');

      await deleteTreeNode(page, folderRenamed);
      await refreshScriptTree(page);
      await assertTreeGone(page, folderRenamed, '删除后文件夹');
      await report('脚本+文件夹删除', true, `脚本 ${scriptRenamed} 与文件夹 ${folderRenamed} 已删除`);

      // ③ 脚本/文件夹增删改不影响执行记录：运行历史仍保留本轮 SQL
      await switchConsoleTab(page, '运行历史');
      const remainingHistoryRow = await findHistoryRowBySql(page, sql);
      if (!remainingHistoryRow) {
        throw new Error(`脚本/文件夹增删改后目标运行历史“${sql}”未保留（应不受影响）。`);
      }

      await assertNoConsoleErrors(consoleErrors);
      await report(
        '自助查询-历史会话与脚本增改删',
        true,
        `历史SQL=${sql}；父级=${parentRoot}；文件夹=${folderRenamed}（原 ${folderName}）；脚本=${scriptRenamed}（原 ${scriptName}）；` +
          `脚本嵌套证据=${nested ? '脚本渲染于目标文件夹内部' : '未取得嵌套证据（树可能平铺渲染），已按回显断言'}`,
      );
    } finally {
      // 精确回收兜底：任何一步失败都不把本轮 folder_*/script_* 留在环境里。
      // 顺序必须先脚本后文件夹（后端 deleteDict 禁止删除有子节点的目录）；
      // 兜底全程 best-effort，不吞/不改原始失败结果。
      const leftover = await recycleRoundTreeNodes(page, [scriptRenamed, scriptName], [folderCurrentName, folderName]);
      if (leftover) {
        testInfo.attach('dq03-01-本轮残留对象', {
          body: `轮次兜底回收后脚本树中仍可见（需人工确认）：${leftover}`,
          contentType: 'text/plain',
        });
      }
    }
  });
});
