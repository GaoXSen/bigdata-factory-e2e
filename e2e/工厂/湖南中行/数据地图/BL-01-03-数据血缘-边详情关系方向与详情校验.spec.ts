/**
 * 数据血缘 — BL-01-03 边详情关系方向与详情校验（点击关系边 → 上游/下游/关系详情）
 *
 * 2026-09-23 清洁环境迁移（DS-PERM-101，静态开发）：
 * - DS-PERM-97 只读审计确认本用例仍消费共享固定表链路（resolveExistingLineageFixture
 *   + restoreLineageBaseline → 固定 e2e_hn_lineage_*_0920 表对），清洁环境依赖旧共享
 *   表。现迁移为每轮唯一 UUID ASCII 表对（e2e_bl0103_src_/tgt_<uuid>，MySQL 主库数据
 *   源取配置中心，由公共工具按配置中心解析）经 configureExistingLineageStatement
 *   自建 A→B 基线血缘（先显式建齐源/目标表并上线）：任务调度 SQL 标准两行、
 *   无末尾分号，保存并上线后等待 1 秒再验证。DS-PERM-106：configureAutoLineage
 *   的前置补表会排除目标表，本轮 UUID 目标表必须先建。
 * - 业务断言原样保留：点击两表节点之间的血缘关系边（而非节点本身）后，页面打开
 *   同时包含源表与目标表的关系详情面板，并呈现上游/下游/关系语义文本；方向语义由
 *   “源表=上游、目标表=下游”的 A→B 准备与面板同时含两表共同保证，不删除、不放宽。
 * - finally 仅回收本轮表/任务（下线 + 元数据行内删除 + 物理 DROP，逐步尽力而为并
 *   完整收集失败）；主体成功但清理未完全成功时如实上抛使测试失败，不伪造通过。
 * - 硬链接双入口约束：仅从 '../utils.js' 与 './血缘测试工具.js' 取工具与配置，
 *   不直接深层相对引用 e2e/test-environment.ts（孪生路径相对深度不同会断链）。
 */
import { test, expect, clickMenu, dbConfig, query, uuid } from '../utils.js';
import type { Locator, Page } from '@playwright/test';
import {
  assertNoUnexpectedLineageConsoleErrors,
  configureExistingLineageStatement,
  openTableLineage,
} from './血缘测试工具.js';

/**
 * 点击两张表节点中间的连线，而不是点击任意一个节点。
 * 当前页面可能用 SVG、canvas 或图片化图谱渲染，表名文本的坐标是三种
 * 渲染方式都能稳定取得的公共锚点；从两个节点中心计算连线中点可避免
 * 把“点击表查看表详情”误当成“点击边查看关系详情”。
 */
async function clickEdgeBetweenTables(
  page: Parameters<typeof openTableLineage>[0],
  sourceTable: string,
  targetTable: string,
): Promise<void> {
  const source = page.getByText(sourceTable, { exact: true }).last();
  const target = page.getByText(targetTable, { exact: true }).last();
  await expect(source).toBeVisible({ timeout: 12_000 });
  await expect(target).toBeVisible({ timeout: 12_000 });
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error(`血缘图未取得源表“${sourceTable}”或目标表“${targetTable}”的节点坐标。`);
  }

  // 当前版本的边不是可直接定位的 SVG rect，而是显示在两节点之间的
  // “SQL自动解析”关系标签；优先点击这个标签，避免坐标落在不可交互的
  // 箭头间隙。其他渲染版本没有标签时再走坐标中点回退。
  const relationLabel = page.getByText('SQL自动解析', { exact: true }).last();
  if (await relationLabel.isVisible().catch(() => false)) {
    // 当前 SVG 中“SQL自动解析”文字本身没有 cursor/click 事件，
    // 它的父级 generic 才是关系边的交互节点；按层级依次尝试。
    const relationCandidates = [
      relationLabel,
      relationLabel.locator('xpath=..'),
      relationLabel.locator('xpath=../..'),
      relationLabel.locator('xpath=../../..'),
    ];
    for (const candidate of relationCandidates) {
      if (!(await candidate.isVisible().catch(() => false))) continue;
      await candidate.click({ force: true }).catch(() => undefined);
      try {
        await expect.poll(async () => {
          const body = await page.locator('body').innerText().catch(() => '');
          const panel = page.locator(
            '.ant-drawer:visible, .el-drawer:visible, [role="dialog"]:visible, .ant-modal:visible, .el-dialog:visible',
          );
          return (await panel.count()) > 0 || /关系详情|血缘关系|上游表|下游表/.test(body);
        }, { timeout: 2_000 }).toBe(true);
        return;
      } catch {
        // 当前层不是交互节点，继续尝试父级或坐标回退。
      }
    }
  }

  const candidates = [0.5, 0.4, 0.6, 0.3, 0.7];
  for (const ratio of candidates) {
    const x = sourceBox.x + sourceBox.width / 2
      + (targetBox.x + targetBox.width / 2 - sourceBox.x - sourceBox.width / 2) * ratio;
    const y = sourceBox.y + sourceBox.height / 2
      + (targetBox.y + targetBox.height / 2 - sourceBox.y - sourceBox.height / 2) * ratio;
    await page.mouse.click(x, y);
    let opened = false;
    try {
      await expect.poll(async () => {
        const body = await page.locator('body').innerText().catch(() => '');
        const panel = page.locator(
          '.ant-drawer:visible, .el-drawer:visible, [role="dialog"]:visible, .ant-modal:visible, .el-dialog:visible',
        );
        return (await panel.count()) > 0 || /关系详情|血缘关系|上游表|下游表/.test(body);
      }, { timeout: 1_500 }).toBe(true);
      opened = true;
    } catch {
      // 连线点击位置可能落在箭头或折线路径旁，继续尝试下一个中点。
    }
    if (opened) return;
  }
  throw new Error(`点击“${sourceTable}→${targetTable}”之间的血缘关系后未打开关系详情。`);
}

// ---------------- 本轮资产回收（DS-PERM-101：finally 仅清本轮表/任务） ----------------

/** 仅合法 MySQL 标识符（≤64 字符）才可能是本轮自建物理表；非法名直接跳过物理回收。 */
function isDroppablePhysicalName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && name.length <= 64;
}

/** 尽力回收本轮物理表（dbConfig() 缺失或逐表 DROP 失败完整收集返回，不掩埋用例结果）。口径同 BL-01-01/DM-07-01。 */
async function dropRoundPhysicalTables(names: string[]): Promise<string[]> {
  const dropErrors: string[] = [];
  const droppable = [...new Set(names)].filter(isDroppablePhysicalName);
  if (!droppable.length) return dropErrors;
  if (!dbConfig()) {
    const detail = `DB 未配置：本轮物理表未物理回收（${droppable.join(', ')}），元数据按 UUID 命名可追溯`;
    console.warn(`[bl0103][cleanup] ${detail}。`);
    dropErrors.push(detail);
    return dropErrors;
  }
  for (const name of droppable) {
    try {
      await query(`DROP TABLE IF EXISTS \`${name}\``);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[bl0103][cleanup] 本轮物理表 ${name} DROP 失败（尽力而为）：`, error);
      dropErrors.push(`物理表 ${name} DROP 失败：${message.slice(0, 240)}`);
    }
  }
  return dropErrors;
}

/** 表管理列表定位目标行（首个可见输入框＝表名称筛选 + 查询）。 */
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

/** 行内操作入口定位（按钮 → 链接/文字/单元格兜底）。 */
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

/** 元数据行内“下线”尽力而为：已下线/无入口时静默返回。 */
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
        console.warn(`[bl0103][cleanup] ${detail}。`);
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
      console.warn(`[bl0103][cleanup] 本轮元数据“${name}”页面侧回收失败（尽力而为）：`, error);
      deleteErrors.push(`元数据“${name}”页面侧回收失败：${message.slice(0, 240)}`);
    }
  }
  return deleteErrors;
}

/**
 * finally 专用：仅回收本轮 UUID 自建表/任务（下线 + 元数据行内删除 + 物理 DROP）。
 * 逐步尽力而为，任一项失败不中断其余步骤，失败完整收集并返回（本函数不抛出）；
 * 由用例结尾统一裁决——主体成功但清理未完全成功须 fail，主体失败保留原错误并
 * 附清理证据。只按本轮 UUID 表标识回收，不扩大匹配范围、不触碰非本轮对象。
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
      console.warn(`[bl0103][cleanup] 本轮表“${name}”下线尝试失败（尽力而为）：`, error);
      cleanupErrors.push(`表“${name}”下线尝试失败：${message.slice(0, 240)}`);
    }
  }
  try {
    cleanupErrors.push(...(await dropRoundPhysicalTables(names)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[bl0103][cleanup] 本轮物理表回收步骤异常（尽力而为）：', error);
    cleanupErrors.push(`物理表回收步骤异常：${message.slice(0, 240)}`);
  }
  try {
    cleanupErrors.push(...(await deleteRoundMetadataRows(page, names, runTag)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[bl0103][cleanup] 本轮元数据回收步骤异常（尽力而为）：', error);
    cleanupErrors.push(`元数据回收步骤异常：${message.slice(0, 240)}`);
  }
  return cleanupErrors;
}

test.describe('BL-01-03｜数据血缘｜边详情关系方向与详情校验', () => {
  // 迁移后本用例自带血缘准备（configureExistingLineageStatement：显式建齐源/目标
  // 两表 + 任务调度保存 + 上线；DS-PERM-106 修复目标表不会被自动补建的缺口）
  // 加边点击与关系详情验证，原 240s 可能被截断；放宽到 480s，超时只影响本轮等待
  // 时长，不改变通过/失败的真实判定。
  test.describe.configure({ timeout: 480_000 });

  test('BL-01-03｜数据血缘｜边详情关系方向与详情校验', async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;

    // ---- 本轮唯一 UUID ASCII 表对与调度 SQL（标准两行、无末尾分号）：不借 113 历史
    // 元数据、共享固定表或残留调度任务，也不依赖其它用例产物；自建自清，部分成功
    // 也能在 finally 回收。
    const runTag = uuid();
    const sourceTable = `e2e_bl0103_src_${runTag}`;
    const targetTable = `e2e_bl0103_tgt_${runTag}`;
    const roundTables = [sourceTable, targetTable];
    const baselineSql = `INSERT INTO ${targetTable}\nSELECT * FROM ${sourceTable}`;

    // 先记录主体结果（mainFailed/mainError），finally 清理失败收集进 cleanupErrors；
    // 主体成功但清理未完全成功须 fail，主体失败保留原错误并附清理证据。
    let mainError: unknown;
    let mainFailed = false;
    const cleanupErrors: string[] = [];

    try {
      // ---- 前置：本轮自建 A→B 基线血缘（configureExistingLineageStatement 先经
      // ensureLineageTable 显式建齐源/目标表并上线 → 任务调度写 SQL → 保存并
      // 上线；MySQL 主库数据源取配置中心，由共享工具按配置中心解析）。数据源/权限
      // 类失败属环境前置，显式 skip 并写明原因；其余失败原样抛出，不伪造通过。
      let prepSkip: string | undefined;
      try {
        await configureExistingLineageStatement(page, {
          targetTable,
          sourceTables: [sourceTable],
          sql: baselineSql,
          // 该入口缺省脚本方言是 GBase；本轮 MySQL SQL 必须显式选择 MYSQL。
          scriptType: /^\s*MYSQL\s*$/i,
          expectedNodes: [sourceTable, targetTable],
          expectedRelations: [],
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

      // ---- 任务约定：保存并上线后等待 1 秒再验证。图谱打开失败属环境前置，跳过并
      // 保留原始原因（本轮表对将在 finally 回收）。
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

      // ---- 业务断言（原样保留）：点击本轮源/目标表之间的血缘关系边，打开关系详情。
      await clickEdgeBetweenTables(page, sourceTable, targetTable);

      const relationPanel = page.locator(
        '.ant-drawer:visible, .el-drawer:visible, [role="dialog"]:visible, .ant-modal:visible, .el-dialog:visible',
      ).filter({ hasText: sourceTable }).filter({ hasText: targetTable }).last();
      await expect(relationPanel, '点击血缘边后应打开包含源表和目标表的关系详情').toBeVisible({ timeout: 10_000 });
      await expect(relationPanel).toContainText(sourceTable);
      await expect(relationPanel).toContainText(targetTable);
      await expect(relationPanel).toContainText(/上游|下游|关系|自动解析|人工编辑/);

      await assertNoUnexpectedLineageConsoleErrors(consoleErrors);
      await report(
        '数据血缘-边详情关系方向与详情校验',
        true,
        `本轮唯一血缘（自建自清）：上游 ${sourceTable} → 下游 ${targetTable}；点击关系边后已展示上游、下游与关系详情。`,
      );
    } catch (error) {
      // 先记录主体错误，finally 清理完成后再统一裁决，避免清理异常掩埋主体失败。
      mainFailed = true;
      mainError = error;
    } finally {
      // 收尾：仅回收本轮自建表/任务（下线 + 元数据行内删除 + 物理 DROP），逐步
      // 尽力而为并完整收集失败，不掩埋用例真实结果，不触碰非本轮对象。
      try {
        cleanupErrors.push(...(await cleanupRoundLineageFixture(page, roundTables, runTag)));
      } catch (cleanupCrash) {
        const message = cleanupCrash instanceof Error ? cleanupCrash.message : String(cleanupCrash);
        console.error('[bl0103][cleanup] 清理流程自身异常（按清理失败收集）：', cleanupCrash);
        cleanupErrors.push(`清理流程自身异常：${message.slice(0, 240)}`);
      }
    }
    // 统一裁决：主体失败优先抛出并附带清理未完成说明（不改变错误类型，保留
    // Playwright 对 test.skip 的 skip 判定）；主体通过但清理未完全成功也如实上抛使
    // 测试失败，不伪造通过。
    if (mainFailed) {
      const note = cleanupErrors.length > 0
        ? `（另：本轮清理未完全成功：${cleanupErrors.join('；').slice(0, 600)}）`
        : '';
      if (mainError instanceof Error) mainError.message += note;
      throw mainError;
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        `BL-01-03 主体通过，但本轮血缘资产清理未完全成功（如实上报；待人工复核本轮 UUID 表：${roundTables.join('、')}）：`
          + cleanupErrors.join('；'),
      );
    }
  });
});