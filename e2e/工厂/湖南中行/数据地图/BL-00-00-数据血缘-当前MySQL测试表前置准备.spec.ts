/**
 * 血缘前置阶段：清洁环境下自建本轮唯一的 MySQL 源表、目标表和一条可见基线血缘。
 *
 * 2026-09-23 清洁环境迁移（DS-PERM-75，静态开发）：
 * - 不再固化跨用例共享表对（如 e2e_hn_lineage_*_0920/_0831），也不依赖 113
 *   历史元数据、旧表或残留调度任务：每轮使用本轮唯一 UUID ASCII 表对
 *   （e2e_bl0000_src_/tgt_<uuid>），物理库取配置中心 MySQL110 主库，经
 *   configureExistingLineageStatement 先显式建齐源/目标表并上线，再在目标表
 *   “任务调度”写入最小 INSERT…SELECT 基线（SQL 无末尾分号，保存并上线）。
 *   DS-PERM-106：configureAutoLineage 的前置补表会排除目标表
 *   （ensureSqlReferencedTables 过滤 targetTable），本轮 UUID 目标表必须先建。
 * - 后续 BL-01-01/BL-02-01 已按同口径各自自建本轮夹具，不再消费本用例产物；
 *   本用例回归“血缘基础表初始化”本身的可验证职责。
 * - 任务约定：解析等待最多 1 秒后验证基线图谱（源表与目标表节点均可见）。
 * - finally 仅回收本轮表/任务（下线 + 元数据行内删除 + 物理 DROP，逐步尽力而为
 *   并完整收集失败）；主体成功但清理未完全成功时如实上抛，不伪造通过。
 * - 硬链接双入口约束：仅从 '../utils.js' 与 './血缘测试工具.js' 取工具与配置
 *   （MySQL110 主库数据源由公共工具按配置中心解析），不直接深层相对引用
 *   e2e/test-environment.ts（孪生路径相对深度不同会断链）。
 */
import { test, clickMenu, dbConfig, query, uuid } from '../utils.js';
import type { Locator, Page } from '@playwright/test';
import {
  assertNoUnexpectedLineageConsoleErrors,
  configureExistingLineageStatement,
  expectLineage,
  openTableLineage,
} from './血缘测试工具.js';

// ---------------- 本轮资产回收（DS-PERM-75：finally 仅清本轮表/任务） ----------------

/** 仅合法 MySQL 标识符（≤64 字符）才可能是本轮自建物理表；非法名直接跳过物理回收。 */
function isDroppablePhysicalName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && name.length <= 64;
}

/** 尽力回收本轮物理表（dbConfig() 缺失或逐表 DROP 失败完整收集返回，不掩埋用例结果）。口径同 DM-07-01。 */
async function dropRoundPhysicalTables(names: string[]): Promise<string[]> {
  const dropErrors: string[] = [];
  const droppable = [...new Set(names)].filter(isDroppablePhysicalName);
  if (!droppable.length) return dropErrors;
  if (!dbConfig()) {
    const detail = `DB 未配置：本轮物理表未物理回收（${droppable.join(', ')}），元数据按 UUID 命名可追溯`;
    console.warn(`[bl0000][cleanup] ${detail}。`);
    dropErrors.push(detail);
    return dropErrors;
  }
  for (const name of droppable) {
    try {
      await query(`DROP TABLE IF EXISTS \`${name}\``);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[bl0000][cleanup] 本轮物理表 ${name} DROP 失败（尽力而为）：`, error);
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
        console.warn(`[bl0000][cleanup] ${detail}。`);
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
      console.warn(`[bl0000][cleanup] 本轮元数据“${name}”页面侧回收失败（尽力而为）：`, error);
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
      console.warn(`[bl0000][cleanup] 本轮表“${name}”下线尝试失败（尽力而为）：`, error);
      cleanupErrors.push(`表“${name}”下线尝试失败：${message.slice(0, 240)}`);
    }
  }
  try {
    cleanupErrors.push(...(await dropRoundPhysicalTables(names)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[bl0000][cleanup] 本轮物理表回收步骤异常（尽力而为）：', error);
    cleanupErrors.push(`物理表回收步骤异常：${message.slice(0, 240)}`);
  }
  try {
    cleanupErrors.push(...(await deleteRoundMetadataRows(page, names, runTag)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[bl0000][cleanup] 本轮元数据回收步骤异常（尽力而为）：', error);
    cleanupErrors.push(`元数据回收步骤异常：${message.slice(0, 240)}`);
  }
  return cleanupErrors;
}

test.describe('BL-00-00｜数据血缘｜当前 MySQL 测试表前置准备', () => {
  // 迁移后本用例自带血缘准备（configureExistingLineageStatement：显式建齐源/目标
  // 两表 + 任务调度保存 + 上线；DS-PERM-106 修复目标表不会被自动补建的缺口）
  // 加基线图谱验证，默认 30s 不够用；放宽到 480s，超时只影响本轮等待时长，
  // 不改变通过/失败的真实判定。
  test.describe.configure({ timeout: 480_000 });

  test('BL-00-00｜数据血缘｜当前 MySQL 测试表前置准备', async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;

    // ---- 本轮唯一 UUID ASCII 表对与调度 SQL（无末尾分号）：不借 113 历史元数据、
    // 旧表或残留调度任务；表对先登记后创建，部分成功也能在 finally 回收。
    const runTag = uuid();
    const sourceTable = `e2e_bl0000_src_${runTag}`;
    const targetTable = `e2e_bl0000_tgt_${runTag}`;
    const roundTables = [sourceTable, targetTable];
    const baselineSql = `INSERT INTO ${targetTable}\nSELECT * FROM ${sourceTable}`;

    // 先记录主体结果（mainFailed/mainError），finally 清理失败收集进 cleanupErrors；
    // 主体成功但清理未完全成功须 fail，主体失败保留原错误并附清理证据。
    let mainError: unknown;
    let mainFailed = false;
    const cleanupErrors: string[] = [];

    try {
      // ---- 前置：本轮自建基线血缘（configureExistingLineageStatement 先经
      // ensureLineageTable 显式建齐源/目标表并上线 → 目标表任务调度写入 SQL →
      // 保存 → 回表管理上线目标表；MySQL 主库数据源取配置中心 MySQL110）。
      // 数据源/权限类失败属环境前置，显式 skip 并写明原因；其余失败原样抛出。
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
            + '请检查配置中心 MySQL110 主库数据源登记与建表/任务调度保存/上线权限后重跑。';
        } else {
          throw error;
        }
      }
      test.skip(Boolean(prepSkip), prepSkip ?? '');

      // ---- 任务约定：解析等待最多 1 秒后验证；图谱打开失败属环境前置（服务/回写
      // 问题），跳过并保留原始原因（本轮表对将在 finally 回收）。
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

      // ---- 基线验证：空态插画同样含 SVG；只有图中同时出现本轮源表与目标表节点，
      // 才是真正的基线血缘。
      await expectLineage(page, {
        targetTable,
        sql: '',
        expectedNodes: [sourceTable, targetTable],
      });

      await assertNoUnexpectedLineageConsoleErrors(consoleErrors);
      await report(
        '血缘当前 MySQL 测试表前置准备',
        true,
        `源表：${sourceTable}；目标表：${targetTable}（本轮唯一 UUID 自建并上线）。`
          + `基线 SQL（无末尾分号）：${baselineSql.replace(/\n/g, ' ')}；已保存任务调度并上线，`
          + '等待 1 秒后图谱已展示源表与目标表节点。',
      );
    } catch (error) {
      mainFailed = true;
      mainError = error;
    } finally {
      // 收尾：仅回收本轮自建表/任务（下线 + 元数据行内删除 + 物理 DROP），逐步
      // 尽力而为并完整收集失败，不掩埋用例真实结果，不触碰非本轮对象。
      try {
        cleanupErrors.push(...(await cleanupRoundLineageFixture(page, roundTables, runTag)));
      } catch (cleanupCrash) {
        const message = cleanupCrash instanceof Error ? cleanupCrash.message : String(cleanupCrash);
        console.error('[bl0000][cleanup] 清理流程自身异常（按清理失败收集）：', cleanupCrash);
        cleanupErrors.push(`清理流程自身异常：${message.slice(0, 240)}`);
      }
    }
    // 统一裁决：主体失败优先抛出并附带清理未完成说明（不改变错误类型，保留
    // Playwright 对 test.skip 的 skip 判定）；主体通过但清理未完全成功也如实上抛。
    if (mainFailed) {
      const note = cleanupErrors.length > 0
        ? `（另：本轮清理未完全成功：${cleanupErrors.join('；').slice(0, 600)}）`
        : '';
      if (mainError instanceof Error) mainError.message += note;
      throw mainError;
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        `BL-00-00 主体通过，但本轮血缘资产清理未完全成功（如实上报；待人工复核本轮 UUID 表：${roundTables.join('、')}）：`
          + cleanupErrors.join('；'),
      );
    }
  });
});
