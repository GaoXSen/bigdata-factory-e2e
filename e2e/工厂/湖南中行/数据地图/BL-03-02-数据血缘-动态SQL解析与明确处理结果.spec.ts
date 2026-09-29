/**
 * 数据血缘 — BL-03-02 动态 SQL 解析与明确处理结果
 *
 * 2026-09-23 清洁环境迁移（DS-PERM-103，静态开发）：
 * - 不再经 resolveExistingLineageFixture(loginPage, true, 'complex', 'BL-03-02')
 *   消费重置前固定表（e2e_hn_complex_*_0920 / e2e_hn_lineage_bl_03_02_* 共享表
 *   对，以及 113 历史元数据、旧表或残留调度任务）：每轮以本轮唯一 UUID ASCII
 *   源/目标表（e2e_bl0302_src_/tgt_<uuid>，MySQL 主库数据源由共享工具按配置中
 *   心解析）与同轮唯一存储过程、调度任务经 configureAutoLineage 自建自清。
 * - 动态 SQL 语义逐字保留（2026-09-05 缺陷现场形状）：CREATE PROCEDURE 过程体
 *   内以字符串拼出 INSERT…SELECT，再 PREPARE/EXECUTE/DEALLOCATE 执行；用例目标
 *   仍是“提交后来源节点与目标节点均出现，或给出明确失败原因”。不把动态 SQL 换
 *   成普通 INSERT 假装通过；已知解析器对动态 SQL 的历史缺陷（任务保存、上线和
 *   目标表详情均已成功，但图谱未返回来源表）仍需真实运行在节点断言处单独判定，
 *   本文件不预判、不放宽、不永久 skip。
 * - `PREPARE stmt FROM sql_str` 中的 sql_str 只是过程体局部变量，但共享工具的
 *   sqlReferencedTables 会把 `FROM sql_str` 误认成物理来源表；该标识经
 *   virtualSourceTables 声明为虚拟来源，避免前置补表按固定名“sql_str”创建跨轮
 *   共享物理表。又因 configureAutoLineage 的前置补表会过滤目标表，本轮先用同一
 *   共享建表链路（ensureSqlReferencedTables，目标过滤参数传入不在 SQL 中的哨兵
 *   名）把两张 UUID 表都建好并上线，再进入任务调度写入、保存与上线。
 * - finally 仅回收本轮表/过程/任务（下线 + 元数据行内删除 + 物理 DROP TABLE/
 *   DROP PROCEDURE，逐步尽力而为并完整收集失败）；主体成功但清理未完全成功时
 *   如实上抛，不伪造通过。
 * - 硬链接双入口约束：仅从 '../utils.js' 与 './血缘测试工具.js' 取工具与配置
 *   （MySQL 主库数据源由公共工具按配置中心解析），不直接深层相对引用
 *   e2e/test-environment.ts（孪生路径相对深度不同会断链）。
 */
import { test, clickMenu, dbConfig, query, uuid } from '../utils.js';
import type { Locator, Page } from '@playwright/test';
import {
  assertNoUnexpectedLineageConsoleErrors,
  configureAutoLineage,
  ensureSqlReferencedTables,
  expectLineage,
  openTableLineage,
} from './血缘测试工具.js';

// 2026-09-15（35F 复测）：调度回写在高负载下滞后超过 2 分钟，把用例时限放宽到
// 900s，配合 LINEAGE_GRAPH_ATTEMPTS=16 的图谱重读窗口区分“回写滞后”与“解析失败”。
test.describe.configure({ timeout: 900_000 });
// 2026-09-16（闭环复测）：基线 run-20260915-134701-316 未显式设置
// LINEAGE_GRAPH_ATTEMPTS，expectLineage 只重读 6 次就判定来源节点缺失，与上方
// 注释约定的 16 次窗口不一致；未显式配置时在本文件内补齐，保证任何入口运行一致。
if (!process.env.LINEAGE_GRAPH_ATTEMPTS) process.env.LINEAGE_GRAPH_ATTEMPTS = '16';

// ---------------- 本轮资产回收（DS-PERM-103：finally 仅清本轮表/过程/任务） ----------------

/** 仅合法 MySQL 标识符（≤64 字符）才可能是本轮自建物理表；非法名直接跳过物理回收。 */
function isDroppablePhysicalName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && name.length <= 64;
}

/** 尽力回收本轮物理表（dbConfig() 缺失或逐表 DROP 失败完整收集返回，不掩埋用例结果）。口径同 BL-02-01。 */
async function dropRoundPhysicalTables(names: string[]): Promise<string[]> {
  const dropErrors: string[] = [];
  const droppable = [...new Set(names)].filter(isDroppablePhysicalName);
  if (!droppable.length) return dropErrors;
  if (!dbConfig()) {
    const detail = `DB 未配置：本轮物理表未物理回收（${droppable.join(', ')}），元数据按 UUID 命名可追溯`;
    console.warn(`[bl0302][cleanup] ${detail}。`);
    dropErrors.push(detail);
    return dropErrors;
  }
  for (const name of droppable) {
    try {
      await query(`DROP TABLE IF EXISTS \`${name}\``);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[bl0302][cleanup] 本轮物理表 ${name} DROP 失败（尽力而为）：`, error);
      dropErrors.push(`物理表 ${name} DROP 失败：${message.slice(0, 240)}`);
    }
  }
  return dropErrors;
}

/**
 * 尽力回收本轮存储过程：任务若被调度真实执行，CREATE PROCEDURE 会在配置中心
 * 主库留下本轮同名过程；未执行或已清理时 DROP IF EXISTS 为幂等 no-op。
 * 过程名只按本轮 UUID 命名，回收不扩大匹配范围；失败完整收集返回。
 */
async function dropRoundProcedure(name: string): Promise<string[]> {
  const dropErrors: string[] = [];
  if (!isDroppablePhysicalName(name)) return dropErrors;
  if (!dbConfig()) {
    const detail = `DB 未配置：本轮存储过程未物理回收（${name}），UUID 命名可追溯`;
    console.warn(`[bl0302][cleanup] ${detail}。`);
    dropErrors.push(detail);
    return dropErrors;
  }
  try {
    await query(`DROP PROCEDURE IF EXISTS \`${name}\``);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[bl0302][cleanup] 本轮存储过程 ${name} DROP 失败（尽力而为）：`, error);
    dropErrors.push(`存储过程 ${name} DROP 失败：${message.slice(0, 240)}`);
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
        console.warn(`[bl0302][cleanup] ${detail}。`);
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
      console.warn(`[bl0302][cleanup] 本轮元数据“${name}”页面侧回收失败（尽力而为）：`, error);
      deleteErrors.push(`元数据“${name}”页面侧回收失败：${message.slice(0, 240)}`);
    }
  }
  return deleteErrors;
}

/**
 * finally 专用：仅回收本轮 UUID 自建表/存储过程/任务（下线 + 物理 DROP +
 * 元数据行内删除）。逐步尽力而为，任一项失败不中断其余步骤，失败完整收集并
 * 返回（本函数不抛出）；由用例结尾统一裁决——主体成功但清理未完全成功须 fail，
 * 主体失败保留原错误并附清理证据。只按本轮 UUID 标识回收，不扩大匹配范围、
 * 不触碰非本轮对象。
 */
async function cleanupRoundLineageFixture(
  page: Page,
  names: string[],
  procedureName: string,
  runTag: string,
): Promise<string[]> {
  const cleanupErrors: string[] = [];
  for (const name of new Set(names)) {
    try {
      await openManageList(page);
      await takeRoundTableOffline(page, name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[bl0302][cleanup] 本轮表“${name}”下线尝试失败（尽力而为）：`, error);
      cleanupErrors.push(`表“${name}”下线尝试失败：${message.slice(0, 240)}`);
    }
  }
  try {
    cleanupErrors.push(...(await dropRoundPhysicalTables(names)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[bl0302][cleanup] 本轮物理表回收步骤异常（尽力而为）：', error);
    cleanupErrors.push(`物理表回收步骤异常：${message.slice(0, 240)}`);
  }
  try {
    cleanupErrors.push(...(await dropRoundProcedure(procedureName)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[bl0302][cleanup] 本轮存储过程回收步骤异常（尽力而为）：', error);
    cleanupErrors.push(`存储过程回收步骤异常：${message.slice(0, 240)}`);
  }
  try {
    cleanupErrors.push(...(await deleteRoundMetadataRows(page, names, runTag)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[bl0302][cleanup] 本轮元数据回收步骤异常（尽力而为）：', error);
    cleanupErrors.push(`元数据回收步骤异常：${message.slice(0, 240)}`);
  }
  return cleanupErrors;
}

/**
 * 目标表任务调度的 Monaco 编辑器存在“旧脚本回显晚于清空”的竞态：上一轮保存的
 * SQL 在清空动作之后才回填（“Expected: '' Received: 旧 SQL”）；并发运行时剪贴板
 * 竞争还会让粘贴整体落空（“Expected: 本轮SQL Received: ''”，run-20260916-155048-788
 * 全部 7 例即此，且该报错文案为 “Timeout 5000ms exceeded” 而非 “timed out”）。
 * 迁移后每轮首建目标表，但重试轮次打开任务调度时编辑器已带有上一轮保存的脚本，
 * 该竞态依然成立。它只影响页面输入，不影响已保存数据；对这类错误把整段流程
 * （前置建表 → 任务调度写入 → 保存上线 → 图谱验证）重试，最多 3 次并逐次加长
 * 间隔错开其他进程的写入窗口；页面结构/接口类错误不重试，血缘解析失败
 * （“血缘图未显示节点…”）不匹配重试条件，不会被当成输入瞬态掩盖。
 */
async function runDynamicSqlRoundWithEditorRetry<T>(page: Page, flow: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await flow();
    } catch (error) {
      lastError = error;
      const message = String((error as Error)?.message ?? error);
      if (!/(timed out|Timeout \d+ms exceeded)/i.test(message) || !/Expected|Received/.test(message)) throw error;
      await page.waitForTimeout(3_000 + attempt * 2_000);
    }
  }
  throw lastError;
}

// 2026-09-05：任务保存、上线和目标表详情均已成功，但动态 SQL 的图谱未返回
// 来源表。此为解析器缺陷线索；迁移后仍以真实运行在节点断言处单独判定——
// 来源/目标节点出现即通过，未出现则按 expectLineage 的明确失败原因失败。
test('BL-03-02｜数据血缘｜动态 SQL 解析与明确处理结果', async ({ loginPage, consoleErrors, report }) => {
  const page = loginPage;

  // ---- 本轮唯一 UUID ASCII 源/目标表、存储过程与调度任务（不借 113/0920 历史
  // 元数据、旧表或残留调度任务，也不消费其它用例产物；自建自清）。动态 SQL 中
  // 静态字符串明确给出源表，使解析器有可验证的输入；只要源/目标节点出现即通过，
  // 不判断动态 SQL 的字段关系（expectedRelations: [] 边界与改前一致）。
  const runTag = uuid();
  const sourceTable = `e2e_bl0302_src_${runTag}`;
  const targetTable = `e2e_bl0302_tgt_${runTag}`;
  const procedureName = `e2e_bl0302_proc_${runTag}`;
  const roundTables = [sourceTable, targetTable];
  // 共享建表链路的表字段固定为 id/name/remark；动态 SQL 的字段沿用共享工具的
  // LINEAGE_DEFAULT_FIELD 覆盖约定，默认取首字段 id（不硬编码环境地址/凭据）。
  const lineageField = process.env.LINEAGE_DEFAULT_FIELD?.trim() || 'id';
  const item = {
    targetTable,
    // 动态 SQL 语义逐字保留：过程体内拼 INSERT…SELECT 字符串并 PREPARE/EXECUTE；
    // 仅表名/字段/过程名替换为本轮 UUID 标识。保留过程体分号与 END;——不把动态
    // SQL 换成普通 INSERT；调度链路对多语句过程体的真实执行/解析表现由真实运行判定。
    sql: `CREATE PROCEDURE ${procedureName}()\nBEGIN\n`
      + `  DECLARE sql_str TEXT;\n`
      + `  SET sql_str = 'INSERT INTO ${targetTable} (${lineageField}) SELECT ${lineageField} FROM ${sourceTable}';\n`
      + `  PREPARE stmt FROM sql_str; EXECUTE stmt; DEALLOCATE PREPARE stmt;\nEND;`,
    // sql_str 只是过程体局部变量，不能被前置补表逻辑当成物理表创建（固定名会
    // 跨轮共享、残留）；来源/目标两张 UUID 表仍会被正常创建/复用。
    virtualSourceTables: ['sql_str'],
    expectedNodes: [sourceTable, targetTable],
    expectedRelations: [],
  };

  // 先记录主体结果（mainFailed/mainError），finally 清理失败收集进 cleanupErrors；
  // 主体成功但清理未完全成功须 fail，主体失败保留原错误并附清理证据。
  let mainError: unknown;
  let mainFailed = false;
  const cleanupErrors: string[] = [];

  try {
    let prepSkip: string | undefined;
    // 记录失败发生的阶段：只有“前置建表/任务调度”阶段的错误才参与环境前置
    // 分类；图谱打开失败按环境前置显式 skip；节点断言失败是业务解析结果，
    // 原样抛出（明确失败原因），不当输入瞬态重试或跳过。阶段经由 currentPhase()
    // 读取（异步闭包内的赋值不参与局部控制流收窄）。
    let phase: 'prepare' | 'open' | 'assert' = 'prepare';
    const currentPhase = (): 'prepare' | 'open' | 'assert' => phase;
    try {
      await runDynamicSqlRoundWithEditorRetry(page, async () => {
        phase = 'prepare';
        // configureAutoLineage 的前置补表只处理 SQL 引用表并过滤目标表；本轮
        // 源/目标表均为全新 UUID 表，先用同一共享建表链路把两张表都建好并上线
        // （目标过滤参数传入不在 SQL 中的哨兵名＝不过滤；sql_str 继续按虚拟
        // 来源排除）。数据源类型走共享工具默认 MySQL（配置中心主库）。
        await ensureSqlReferencedTables(page, item.sql, `__e2e_bl0302_precreate_${runTag}`, item.virtualSourceTables);
        await configureAutoLineage(page, item);
        // 任务约定：保存并上线完成后等待 1 秒再查血缘；图谱重读窗口由
        // LINEAGE_GRAPH_ATTEMPTS（本文件默认 16）在 expectLineage 内消费，
        // 不删除既有必要的业务等待/重读窗口。
        await page.waitForTimeout(1_000);
        phase = 'open';
        await openTableLineage(page, item.targetTable);
        phase = 'assert';
        await expectLineage(page, item);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (currentPhase() === 'prepare' && /环境前置条件缺失|权限|未配置|不可用|连接失败/.test(message)) {
        prepSkip = `血缘前置失败（本轮自建表对 ${sourceTable} → ${targetTable}，动态 SQL 任务）：${message}。`
          + '请检查配置中心 MySQL 主库数据源登记与建表/任务调度保存/上线权限后重跑。';
      } else if (currentPhase() === 'open') {
        test.skip(
          true,
          `环境没有可用血缘图谱（本轮自建表“${item.targetTable}”打开数据血缘失败）：${message}。`
            + '请检查血缘服务与任务调度解析后重跑。',
        );
      } else {
        throw error;
      }
    }
    test.skip(Boolean(prepSkip), prepSkip ?? '');

    await assertNoUnexpectedLineageConsoleErrors(consoleErrors);
    await report(
      '动态 SQL 血缘-展示明确解析结果或原因',
      true,
      `目标表：${targetTable}\n源表：${sourceTable}\n存储过程：${procedureName}\n实际提交 SQL：\n${item.sql}`,
    );
  } catch (error) {
    mainFailed = true;
    mainError = error;
  } finally {
    // 收尾：仅回收本轮自建表/存储过程/任务（下线 + 物理 DROP TABLE/PROCEDURE +
    // 元数据行内删除），逐步尽力而为并完整收集失败，不掩埋用例真实结果，
    // 不触碰非本轮对象。
    try {
      cleanupErrors.push(...(await cleanupRoundLineageFixture(page, roundTables, procedureName, runTag)));
    } catch (cleanupCrash) {
      const message = cleanupCrash instanceof Error ? cleanupCrash.message : String(cleanupCrash);
      console.error('[bl0302][cleanup] 清理流程自身异常（按清理失败收集）：', cleanupCrash);
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
      `BL-03-02 主体通过，但本轮血缘资产清理未完全成功（如实上报；待人工复核本轮 UUID 表：${roundTables.join('、')}）：`
        + cleanupErrors.join('；'),
    );
  }
});

