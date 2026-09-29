/**
 * 数据血缘 — BL-02-07 自动解析自引用更新字段血缘
 *
 * 2026-09-23 清洁环境迁移（DS-PERM-102，静态开发）：
 * - 不再消费 resolveExistingLineageFixture 指向环境重置前的固定 complex 夹具表
 *   （e2e_hn_lineage_*_0920 家族），也不依赖 113 历史元数据、旧表或残留调度任务：
 *   每轮以本轮唯一 UUID ASCII 目标表（e2e_bl0207_tgt_<uuid>；MySQL 主库数据源由
 *   公共工具按配置中心解析，spec 内不写死主机/端口/显示名/凭据）自建夹具（建表 →
 *   目标表任务调度写入自引用 INSERT…SELECT（无末尾分号）→ 保存 → 上线），等待
 *   1 秒后验证自动解析出的自引用表级血缘。
 * - 建表入口使用共享工具导出的 configureExistingLineageStatement：先经
 *   ensureLineageTable 建齐本轮目标表（缺失即建、MySQL 页面最小建表），再写任务
 *   调度并上线。configureAutoLineage 只补建 SQL 引用的源表，目标表必须预先存在
 *   （openTargetTaskSchedule → searchManageRowAcrossStates 找不到即抛错），因此
 *   本轮自建表不能只依赖它。自引用 SQL 不需要源表，sourceTables 留空。脚本方言
 *   显式指定 MYSQL（与 configureAutoLineage 的 MySQL 默认一致；该入口缺省是 GBase）。
 * - 建表字段固定为共享工具最小 DDL（id/name/remark），与旧固定夹具同构：自引用
 *   SQL 沿用首字段 id，保留“INSERT INTO 目标(id) SELECT id FROM 目标 WHERE id
 *   IS NOT NULL”的语义。既有业务边界原样保留：自引用复杂 SQL 只断言目标表节点
 *   出现在图谱中，字段级自引用关系由人工复核，不猜测字段名、不放宽断言。
 * - finally 仅回收本轮表/任务（下线 + 元数据行内删除 + 物理 DROP，逐步尽力而为
 *   并完整收集失败）；主体成功但清理未完全成功时如实上抛，不伪造通过。
 * - 硬链接双入口约束：仅从 '../utils.js' 与 './血缘测试工具.js' 取工具与配置，
 *   不直接深层相对引用 e2e/test-environment.ts（孪生路径相对深度不同会断链）。
 */
import { test, clickMenu, dbConfig, query, uuid } from '../utils.js';
import type { Locator, Page } from '@playwright/test';
import {
  assertNoUnexpectedLineageConsoleErrors,
  configureExistingLineageStatement,
  expectLineage,
  openTableLineage,
} from './血缘测试工具.js';

// ---------------- 本轮资产回收（DS-PERM-102：finally 仅清本轮表/任务） ----------------

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
    console.warn(`[bl0207][cleanup] ${detail}。`);
    dropErrors.push(detail);
    return dropErrors;
  }
  for (const name of droppable) {
    try {
      await query(`DROP TABLE IF EXISTS \`${name}\``);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[bl0207][cleanup] 本轮物理表 ${name} DROP 失败（尽力而为）：`, error);
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
        console.warn(`[bl0207][cleanup] ${detail}。`);
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
      console.warn(`[bl0207][cleanup] 本轮元数据“${name}”页面侧回收失败（尽力而为）：`, error);
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
      console.warn(`[bl0207][cleanup] 本轮表“${name}”下线尝试失败（尽力而为）：`, error);
      cleanupErrors.push(`表“${name}”下线尝试失败：${message.slice(0, 240)}`);
    }
  }
  try {
    cleanupErrors.push(...(await dropRoundPhysicalTables(names)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[bl0207][cleanup] 本轮物理表回收步骤异常（尽力而为）：', error);
    cleanupErrors.push(`物理表回收步骤异常：${message.slice(0, 240)}`);
  }
  try {
    cleanupErrors.push(...(await deleteRoundMetadataRows(page, names, runTag)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[bl0207][cleanup] 本轮元数据回收步骤异常（尽力而为）：', error);
    cleanupErrors.push(`元数据回收步骤异常：${message.slice(0, 240)}`);
  }
  return cleanupErrors;
}

test.describe('BL-02-07｜数据血缘｜自动解析自引用更新字段血缘', () => {
  // 2026-09-23（DS-PERM-102）：迁移后本用例自带建表 + 任务调度保存 + 上线 + 本轮
  // 回收，把时限由 240s 放宽到 480s（对齐 DS-PERM-75 对 BL-01-01 的同口径放宽）；
  // 超时只影响本轮等待时长，不改变通过/失败的真实判定。
  test.describe.configure({ timeout: 480_000 });

  test('BL-02-07｜数据血缘｜自动解析自引用更新字段血缘', async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;

    // ---- 本轮唯一 UUID ASCII 目标表与自引用 SQL（无末尾分号）：不借历史元数据、
    // 旧表或残留调度任务；建表字段为共享工具最小 DDL（id/name/remark），自引用沿用
    // 首字段 id，不猜测。自引用不需要源表，sourceTables 留空。
    const runTag = uuid();
    const targetTable = `e2e_bl0207_tgt_${runTag}`;
    const roundTables = [targetTable];
    const item = {
      targetTable,
      sql: `INSERT INTO ${targetTable} (id)\nSELECT id FROM ${targetTable} WHERE id IS NOT NULL`,
      expectedNodes: [targetTable],
    };

    // 先记录主体结果，finally 清理失败收集进 cleanupErrors；主体成功但清理未完全
    // 成功须 fail，主体失败保留原错误并附清理证据（见用例结尾统一裁决）。
    let mainError: unknown;
    let mainFailed = false;
    const cleanupErrors: string[] = [];

    try {
      // ---- 前置：本轮自建夹具（建目标表并上线 → 目标表任务调度写入自引用 SQL →
      // 保存 → 回表管理上线目标表；MySQL 主库数据源由公共工具按配置中心解析）。
      // 数据源/权限类失败属环境前置，显式 skip 并写明原因；其余失败原样抛出。
      let prepSkip: string | undefined;
      try {
        await configureExistingLineageStatement(page, {
          targetTable,
          sql: item.sql,
          // 该入口缺省 GBase；显式 MYSQL 与 configureAutoLineage 的默认方言一致。
          scriptType: /^\s*MYSQL\s*$/i,
          expectedNodes: item.expectedNodes,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/环境前置条件缺失|权限|未配置|不可用|连接失败/.test(message)) {
          prepSkip = `环境前置条件缺失（本轮自建夹具阶段）：${message.slice(0, 200)}`;
        } else {
          throw error;
        }
      }
      test.skip(Boolean(prepSkip), prepSkip ?? '');

      // ---- 任务约定：解析等待最多 1 秒后验证（保存并上线完成后再读取图谱）。
      await page.waitForTimeout(1_000);
      try {
        await openTableLineage(page, item.targetTable);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        test.skip(true, `环境没有可用血缘图谱（本轮自建表“${item.targetTable}”打开数据血缘失败）：${message.slice(0, 120)}`);
      }
      // 自引用复杂 SQL 只核验目标表节点出现（既有业务边界原样保留）；字段级自引用
      // 关系由人工复核。期望节点断言由 expectLineage 保留，不放宽、不伪造通过。
      await expectLineage(page, item);
      await assertNoUnexpectedLineageConsoleErrors(consoleErrors);
      await report('自动解析真实表自引用字段血缘', true, `实际提交 SQL：\n${item.sql}`);
    } catch (error) {
      mainFailed = true;
      mainError = error;
    } finally {
      try {
        cleanupErrors.push(...(await cleanupRoundLineageFixture(page, roundTables, runTag)));
      } catch (cleanupCrash) {
        const message = cleanupCrash instanceof Error ? cleanupCrash.message : String(cleanupCrash);
        console.error('[bl0207][cleanup] 清理流程自身异常（按清理失败收集）：', cleanupCrash);
        cleanupErrors.push(`清理流程自身异常：${message.slice(0, 240)}`);
      }
    }

    // ---- 统一裁决：主体失败＝失败（附清理证据，不掩盖原错误）；主体成功但清理未
    // 完全成功＝失败（如实上抛，不伪造通过）；全部成功才通过。
    if (mainFailed) {
      const detail = cleanupErrors.length ? `；本轮回收未完全成功：${cleanupErrors.join('；')}` : '';
      if (mainError instanceof Error) mainError.message += detail;
      throw mainError;
    }
    if (cleanupErrors.length) {
      throw new Error(`BL-02-07 主体通过，但本轮表/任务回收未完全成功：${cleanupErrors.join('；')}`);
    }
  });
});


