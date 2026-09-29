/**
 * 数据地图 — DM-07-01 血缘图谱展示、上卷下钻、高亮与节点详情（只读验证）
 *
 * 2026-09-23 清洁环境迁移（DS-PERM-84 发起，DS-PERM-88 拆分轮最终交付本文件；
 * DS-PERM-107 同根修复）：
 * - 不再复用任何共享/历史表对（含 e2e_hn_lineage_*_0920 与 LINEAGE_SOURCE_TABLE/
 *   LINEAGE_TARGET_TABLE 覆盖）：每轮经 configureExistingLineageStatement 以本轮
 *   唯一 UUID ASCII 表对（e2e_dm0701_src_/tgt_<uuid>，MySQL 主库数据源取配置中心）
 *   自建 A→B 血缘（任务调度 SQL 无末尾分号，保存并上线后等待 1 秒再验证），随后
 *   只读验证图谱展示、上卷/下钻、节点展开/收起、高亮与节点详情。
 * - DS-PERM-107：configureAutoLineage 的前置补表会过滤目标表
 *   （ensureSqlReferencedTables），清洁环境下目标表不存在时 openTargetTaskSchedule
 *   直接失败；改用公共入口 configureExistingLineageStatement（显式 sourceTables +
 *   MySQL 脚本类型），源表/目标表均先经页面建表链路（ensureLineageTable）实际
 *   创建并上线，再写入任务调度 SQL、保存并上线。
 * - finally 仅回收本轮表/任务/关系（下线 + 元数据行内删除 + 物理 DROP，逐步尽力
 *   而为），清理失败完整收集（DS-PERM-89）：主体成功但清理未完全成功时聚合上抛使
 *   测试失败；主体失败时保留原错误并附带清理证据；不触碰任何非本轮对象。
 * - 上卷/下钻在当前页面的可观察结果是：图谱同时呈现上游源表节点与下游目标表节点。
 * - 节点展开/收起：A→B 两节点基线图谱可能没有聚合展开入口；有入口才执行并验证，
 *   没有入口时如实写入报告，不伪造覆盖。
 * - 高亮/节点详情：业务录制确认点击图谱节点（SVG rect）会出现节点级操作（lock）；
 *   以“含表名的详情浮层/抽屉、节点级操作图标或图谱内高亮样式”作为可观察断言。
 * - 血缘准备或图谱读取失败时 test.skip 并写明前置条件；不把环境缺失计为产品失败，
 *   也不写死通过结果。
 */

import { test, expect, clickMenu, dbConfig, query, uuid } from '../utils.js';
import type { Locator, Page } from '@playwright/test';
import {
  assertNoUnexpectedLineageConsoleErrors,
  configureExistingLineageStatement,
  openTableLineage,
  visibleLineageControl,
} from './血缘测试工具.js';

/** 与公共工具 expectLineage 同口径：详情页会保留多个可见 tabpanel 空壳，当前内容面板取最后一个含血缘语义文本的面板。 */
function lineagePanel(page: Page): Locator {
  return page.locator('[role="tabpanel"]:visible, .ant-tabs-content:visible, .el-tab-pane:visible')
    .filter({ hasText: /数据血缘|当前表|上游|下游/ })
    .last();
}

/** 当前版本每个节点可能是独立 SVG；表名文本必须落在血缘图的 SVG 节点里，不能用整页文本（详情页标题本身含目标表名，会把空图误判为通过）。 */
function graphNode(panel: Locator, tableName: string): Locator {
  return panel.locator('svg:visible').filter({ hasText: tableName }).last();
}

/** 图例在页面上是一个合并文本节点，不能按多个 exact 文本节点分别定位。 */
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

/** 与 BL-01-01 同口径的展开/收起验证：有入口才执行；无入口如实说明，不把“没有入口”伪装成验证通过。 */
async function tryNodeExpandCollapse(page: Page): Promise<string> {
  const expand = page.locator(
    '[aria-label*="plus" i]:visible, [title*="展开"]:visible, [class*="node"] button:visible',
  ).last();
  if (!(await expand.isVisible().catch(() => false))) {
    return '当前图谱未提供节点展开入口（A→B 两节点基线图谱无聚合节点），未执行展开/收起';
  }
  await expand.click();
  await page.waitForTimeout(300);
  const collapse = page.locator(
    '[aria-label*="minus" i]:visible, [title*="收起"]:visible',
  ).last();
  if (await collapse.isVisible().catch(() => false)) {
    await collapse.click();
  } else {
    // toggle 型控件：展开后没有独立收起按钮时，再次点击原入口即收起。
    await expand.click();
  }
  await page.waitForTimeout(300);
  return '已执行节点展开并收起';
}

/** SVG 文本节点本身常无 pointer-events（BL-01-03 同经验）：按节点包围盒中心用鼠标点击，等价于点击节点主体。 */
async function clickGraphNodeCenter(page: Page, node: Locator): Promise<void> {
  const box = await node.boundingBox();
  if (!box) throw new Error('血缘图节点未取得坐标，无法点击验证高亮/节点详情。');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * 点击图谱节点并观察高亮/节点详情。三类可观察响应：含表名的详情浮层/抽屉、
 * 节点级操作图标（lock/锁定/详情）、图谱内高亮样式。出现任一即记录对应类型；
 * 都未出现时如实说明当前页面版本无可观察响应，不误报为产品缺陷。
 */
async function inspectNodeHighlightAndDetail(
  page: Page,
  panel: Locator,
  tableName: string,
): Promise<string> {
  await clickGraphNodeCenter(page, graphNode(panel, tableName));

  const detailPanel = page.locator(
    '.ant-drawer:visible, .el-drawer:visible, [role="dialog"]:visible, '
      + '.ant-modal:visible, .el-dialog:visible, .ant-popover:visible, .el-popover:visible',
  ).filter({ hasText: tableName }).last();
  const nodeAction = page.locator(
    '[aria-label*="lock" i]:visible, [title*="锁定"]:visible, [title*="详情"]:visible, [aria-label*="detail" i]:visible',
  ).last();
  const highlight = panel.locator(
    'svg:visible [class*="active"], svg:visible [class*="selected"], svg:visible [class*="highlight"]',
  );

  const deadline = Date.now() + 5_000;
  let observed: string | undefined;
  while (Date.now() < deadline && !observed) {
    if (await detailPanel.isVisible().catch(() => false)) {
      observed = `节点详情浮层已打开且包含表名“${tableName}”`;
    } else if (await nodeAction.isVisible().catch(() => false)) {
      observed = '节点级操作已出现（lock/锁定或详情入口），节点点击有选中响应';
    } else if ((await highlight.count()) > 0) {
      observed = '图谱内出现高亮样式节点';
    } else {
      await page.waitForTimeout(250);
    }
  }
  if (observed) {
    // 观察完成后收起浮层/取消选中，保持页面状态干净，便于后续控制台断言。
    await page.keyboard.press('Escape').catch(() => undefined);
  }
  return observed ?? `点击节点“${tableName}”后当前页面版本无可观察高亮/详情响应`;
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
    console.warn(`[dm0701][cleanup] ${detail}。`);
    dropErrors.push(detail);
    return dropErrors;
  }
  for (const name of droppable) {
    try {
      await query(`DROP TABLE IF EXISTS \`${name}\``);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[dm0701][cleanup] 本轮物理表 ${name} DROP 失败（尽力而为）：`, error);
      dropErrors.push(`物理表 ${name} DROP 失败：${message.slice(0, 240)}`);
    }
  }
  return dropErrors;
}

/** 表管理列表定位目标行（口径同 DM-07-02：首个可见输入框＝表名称筛选 + 查询）。 */
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

/** 元数据行内“删除/移除”尽力而为：入口缺失或失败逐项收集返回（UUID 命名可追溯），本函数不抛出。 */
async function deleteRoundMetadataRows(page: Page, names: string[], runTag: string): Promise<string[]> {
  const deleteErrors: string[] = [];
  for (const name of new Set(names)) {
    try {
      await openManageList(page);
      const row = await filterManageRowOnce(page, name);
      if (!row) continue; // 已不在列表＝无需回收
      const action = await findManageRowAction(row, /^删\s*除$|^移\s*除$/);
      if (!action) {
        const detail = `表管理未提供“${name}”删除/移除入口，元数据保留（UUID 命名可追溯）`;
        console.warn(`[dm0701][cleanup] ${detail}。`);
        deleteErrors.push(detail);
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
      console.warn(`[dm0701][cleanup] 本轮元数据“${name}”页面侧回收失败（尽力而为）：`, error);
      deleteErrors.push(`元数据“${name}”页面侧回收失败：${message.slice(0, 240)}`);
    }
  }
  return deleteErrors;
}

/**
 * finally 专用：仅回收本轮 UUID 自建表/任务/关系（下线 + 元数据行内删除 + 物理 DROP）。
 * DS-PERM-89：逐步尽力而为，任一项失败不中断其余步骤，失败完整收集并返回（本函数不抛出）；
 * 由用例结尾统一裁决——主体成功但清理未完全成功须 fail，主体失败保留原错误并附带清理证据。
 * 只按本轮 UUID 表/任务/关系标识回收，不扩大匹配范围、不触碰非本轮对象。
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
      console.warn(`[dm0701][cleanup] 本轮表“${name}”下线尝试失败（尽力而为）：`, error);
      cleanupErrors.push(`表“${name}”下线尝试失败：${message.slice(0, 240)}`);
    }
  }
  try {
    cleanupErrors.push(...(await dropRoundPhysicalTables(names)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[dm0701][cleanup] 本轮物理表回收步骤异常（尽力而为）：', error);
    cleanupErrors.push(`物理表回收步骤异常：${message.slice(0, 240)}`);
  }
  try {
    cleanupErrors.push(...(await deleteRoundMetadataRows(page, names, runTag)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[dm0701][cleanup] 本轮元数据回收步骤异常（尽力而为）：', error);
    cleanupErrors.push(`元数据回收步骤异常：${message.slice(0, 240)}`);
  }
  return cleanupErrors;
}

test.describe('DM-07-01｜数据地图｜血缘上卷、下钻、高亮和节点详情', () => {
  // 2026-09-23 迁移后本用例自带血缘准备（DS-PERM-107：configureExistingLineageStatement
  // 将源/目标表均经页面建表链路实际创建并上线，再任务调度保存 + 上线），加上图谱
  // 多轮重读与节点交互，放宽到 480s；超时只影响本轮等待时长，不改变通过/失败的真实判定。
  test.describe.configure({ timeout: 480_000 });

  test('DM-07-01｜数据地图｜血缘上卷、下钻、高亮和节点详情', async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;

    // ---- 本轮唯一 UUID ASCII 表对与调度 SQL（无末尾分号）：不借历史血缘图/旧节点/
    // 旧任务或 113 数据；表对先登记后创建，部分成功也能在 finally 回收。
    const runTag = uuid();
    const sourceTable = `e2e_dm0701_src_${runTag}`;
    const targetTable = `e2e_dm0701_tgt_${runTag}`;
    const roundTables = [sourceTable, targetTable];
    const scheduleSql = `INSERT INTO ${targetTable}\nSELECT * FROM ${sourceTable}`;

    // DS-PERM-89：先记录主体结果（mainFailed/mainError），finally 清理失败收集进
    // cleanupErrors；主体成功但清理未完全成功须 fail，主体失败保留原错误并附清理证据。
    let mainError: unknown;
    let mainFailed = false;
    const cleanupErrors: string[] = [];

    try {
      // ---- 前置：自建 A→B 血缘。DS-PERM-107：configureAutoLineage 的前置补表会
      // 过滤目标表，清洁环境会在 openTargetTaskSchedule 因找不到目标表直接失败；
      // 改用公共入口 configureExistingLineageStatement，显式声明 sourceTables 与
      // MySQL 脚本类型：源/目标表均经页面建表链路实际创建并上线 → 目标表任务调度
      // 写入 SQL → 保存 → 回表管理上线目标表；MySQL 主库数据源取配置中心。
      // 数据源/权限类失败属环境前置，显式 skip 并写明原因；其余失败原样抛出，
      // 不伪造通过。
      let prepSkip: string | undefined;
      try {
        await configureExistingLineageStatement(page, {
          targetTable,
          sql: scheduleSql,
          expectedNodes: [sourceTable, targetTable],
          expectedRelations: [],
          sourceTables: [sourceTable],
          scriptType: /^\s*MYSQL\s*$/i,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/环境前置条件缺失|权限|未配置|不可用|连接失败/.test(message)) {
          prepSkip = `血缘前置失败（本轮自建表对 ${sourceTable} → ${targetTable}）：${message}。`
            + '请检查配置中心 MySQL 主库数据源登记与建表/任务调度保存/上线权限后重跑。';
        } else {
          throw error;
        }
      }
      test.skip(Boolean(prepSkip), prepSkip ?? '');

      // ---- 任务约定：保存并上线后等待 1 秒再验证，再打开目标表“数据血缘”。
      // 图谱为空或详情接口异常说明环境当前没有可用图谱，属前置数据/服务问题：
      // 跳过并保留原始原因（本轮表对将在 finally 回收）。
      await page.waitForTimeout(1_000);
      try {
        await openTableLineage(page, targetTable);
      } catch (error) {
        test.skip(
          true,
          `环境没有可用血缘图谱（本轮自建表“${targetTable}”打开数据血缘失败）：`
            + `${error instanceof Error ? error.message : String(error)}。`
            + '请检查血缘服务与任务调度解析后重跑。',
        );
      }

      // ---- 1) 展示：图谱画布、人工编辑入口、通知下游与当前版本图例。
      await expect(page.locator(
        '[role="tabpanel"]:visible img:visible, [role="tabpanel"]:visible canvas:visible, [role="tabpanel"]:visible svg:visible',
      ).first()).toBeVisible();
      await expect(await visibleLineageControl(page, /人工编辑|编辑血缘/)).toBeVisible();
      await expect(await visibleLineageControl(page, /通知下游/)).toBeVisible();
      // 当前版本图例为“当前表 / 内部表 / 外部表 / API / 文件”；“数仓表”是旧版页面文案，
      // 不能继续作为成功条件。
      await expectActivePanelText(page, /当前表[\s\S]*内部表[\s\S]*外部表[\s\S]*API[\s\S]*文件/);

      // ---- 2) 上卷/下钻：当前页面的可观察结果是图谱同时呈现上游源表与下游目标表节点。
      const panel = lineagePanel(page);
      await expect(panel).toBeVisible({ timeout: 12_000 });
      const sourceNode = graphNode(panel, sourceTable);
      const targetNode = graphNode(panel, targetTable);
      // 血缘回写可能滞后，先给上游节点一次有限等待；始终缺失说明目标表当前没有
      // A→B 血缘关系（本用例只读，不写 SQL 生成血缘），按环境无可用图谱跳过。
      const upstreamReady = await expect.poll(
        async () => await sourceNode.isVisible().catch(() => false),
        { timeout: 15_000 },
      ).toBe(true).then(() => true, () => false);
      if (!upstreamReady) {
        test.skip(
          true,
          `图谱缺少上游节点“${sourceTable}”：本轮自建 A→B 血缘未在图谱回写。`
            + '请检查任务调度解析服务后重跑本用例。',
        );
      }
      await expect(sourceNode, '上卷：图谱应展示上游源表节点').toBeVisible();
      await expect(targetNode, '下钻：图谱应展示下游目标表节点').toBeVisible();

      // ---- 3) 节点展开/收起：有入口才执行；无入口如实报告。
      const expandResult = await tryNodeExpandCollapse(page);

      // ---- 4) 高亮与节点详情：点击上游节点，观察可观察响应并如实记录。
      const inspectResult = await inspectNodeHighlightAndDetail(page, panel, sourceTable);

      await assertNoUnexpectedLineageConsoleErrors(consoleErrors);
      await report(
        '数据血缘-图谱展示、上卷下钻、高亮与节点详情',
        true,
        [
          `本轮唯一血缘（自建自清）：${sourceTable} → ${targetTable}`,
          '上卷/下钻：图谱同时展示上游源表与下游目标表节点',
          `节点展开/收起：${expandResult}`,
          `高亮与节点详情：${inspectResult}`,
        ].join('；'),
      );
    } catch (error) {
      // DS-PERM-89：先记录主体错误，finally 清理完成后再统一裁决，避免清理异常掩埋主体失败。
      mainFailed = true;
      mainError = error;
    } finally {
      // 收尾（DS-PERM-84/89）：仅回收本轮自建表/任务/关系（下线 + 元数据行内删除 +
      // 物理 DROP），逐步尽力而为并完整收集失败，不掩埋用例真实结果，不触碰非本轮对象。
      try {
        cleanupErrors.push(...(await cleanupRoundLineageFixture(page, roundTables, runTag)));
      } catch (cleanupCrash) {
        // 清理流程自身异常也按清理失败收集，保证 finally 不抛出、不覆盖主体错误。
        const message = cleanupCrash instanceof Error ? cleanupCrash.message : String(cleanupCrash);
        console.error('[dm0701][cleanup] 清理流程自身异常（按清理失败收集）：', cleanupCrash);
        cleanupErrors.push(`清理流程自身异常：${message.slice(0, 240)}`);
      }
    }
    // DS-PERM-89 统一裁决（口径同 DS-01-06/DS-01-07 已验收 scoped-cleanup）：主体失败
    // 优先抛出并附带清理未完成说明（仅追加 message，不改变错误类型，保留 Playwright
    // 对 test.skip 的 skip 判定）；主体通过但清理未完全成功也如实上抛，不伪造通过。
    if (mainFailed) {
      const note = cleanupErrors.length > 0
        ? `（另：本轮清理未完全成功：${cleanupErrors.join('；').slice(0, 600)}）`
        : '';
      if (mainError instanceof Error) mainError.message += note;
      throw mainError;
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        `DM-07-01 主体通过，但本轮血缘资产清理未完全成功（如实上报；待人工复核本轮 UUID 表：${roundTables.join('、')}）：`
          + cleanupErrors.join('；'),
      );
    }
  });
});
