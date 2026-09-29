/**
 * DI-04-03｜数据接入｜文本字段批量同步与调度执行
 *
 * 湖南中行第一版标准化用例。来源：工厂测试用例-标准化业务版-FTP已补充-四环境配置版.xlsx。
 * 一个业务用例对应一个 spec.ts；本文件保留完整业务输入，未将缺失信息伪装成通过。
 *
 * 20260917 静态修复（agent-7，未启动页面回归，页面通过状态“待 flash 验证”）：
 * - 表单结构依据 20260916 探查（temp/公司模型任务/20260916-闭环/cline-runs/probe-batchsync2.log）：
 *   批量同步创建页（#/dataAccess/batchSyncCreate）步骤1 的 9 个 .ant-form-item 无控件 id，
 *   仅按 label 区分：数据源类型/数据源名称/数据库名称/Schema/表名称（源=第 0 处，目标=第 1 处）；
 *   步骤2 为表级映射（源表→目标表，自动建表+全量同步，含“批量修改表名”）；
 *   步骤3 调度配置字段 id：name（任务名称）/commandParam/slot/maxRetry（重试次数）。
 * - 页面没有独立“调度平台连接”配置；调度能力=任务上线后由行内“执行”触发
 *   （探查实证行按钮：执行/下线/日志）。原步骤 2“配置调度平台及执行周期”与步骤 5“再按调度方式触发一次”
 *   按页面真实能力映射为：上线纳入调度 → 手动执行一次核对实例 → 再次执行一次核对实例。
 * - “文本字段”按页面能力映射：本轮自建来源表 e2e_src_<uuid> 含文本字段（name/phone_number/adress_di，
 *   4 字段与原验证表形态一致），断言表级映射 + 实例执行成功终态 + 目标表文本字段非空
 *   目标数据核验使用本地严格 query 断言：仅来源表前置检查确认 DB_*或驱动缺失时环境 skip。
 * - 目标表名用“批量修改表名”唯一化（默认目标表名=源表名，多轮回归会因同名表冲突）。
 *
 * 20260917 页面验证 round1 实证（run-20260917-120322-289 error-context.md）：
 * 批量同步“表名称”下拉展开后选项为空、选择器内置搜索输入框（multiple/showSearch），
 * 必须键入表名触发过滤/异步加载——已改用 pickBatchSyncTableBySearch（键入→等选项→选中→Esc 收起）。
 */
import { test, expect, uuid, clickMenu, assertNoConsoleErrors, query } from '../utils.js';
import type { Page } from '@playwright/test';
import {
  dataSyncSource,
  dataSyncTarget,
  findDataSyncTaskOperationRow,
  openBatchSyncCreate,
  pickBatchSyncLabeledSelect,
  pickBatchSyncTableBySearch,
} from './数据集成工具.js';

/**
 * DS-PERM-68 清洁环境迁移：来源表不再使用历史缺省表（DATA_SYNC_SOURCE_TABLE 缺省值），
 * 本轮经配置中心来源库（query()，e2e/utils.ts 代持主库连接）直建唯一 ASCII 来源表
 * （4 字段与原验证表形态一致，文本字段语义不变），并插入 2 行文本样例。
 */
async function createRoundSourceTable(roundId: string): Promise<string> {
  const sourceTable = `e2e_src_${roundId}`;
  const qualifiedTable = `\`${dataSyncSource.database}\`.\`${sourceTable}\``;
  const ddl =
    `CREATE TABLE ${qualifiedTable} (` +
    '`name` VARCHAR(64) NULL, `age` INT NULL, `phone_number` VARCHAR(32) NULL, `adress_di` VARCHAR(128) NULL)';
  try {
    await query(ddl);
    await query(
      'INSERT INTO `' + dataSyncSource.database + '`.`' + sourceTable + '` (`name`, `age`, `phone_number`, `adress_di`) VALUES ' +
        `('张三', 28, '13800000001', '长沙市岳麓区'), ('李四', 35, '13800000002', '长沙市开福区')`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/未配置|暂未接入/.test(message)) {
      test.skip(true, `环境前置缺失：配置中心主库未配置或驱动缺失，无法创建本轮唯一来源表（${message}）`);
    }
    try {
      await query(`DROP TABLE IF EXISTS ${qualifiedTable}`);
    } catch (cleanupError) {
      console.warn(
        `[cleanup] 本轮来源表建表后未回收：${qualifiedTable}；原因：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  }
  return sourceTable;
}

/** 批量同步来源/目标整链选择；每轮重试都重新拉取下拉选项与“表名称”搜索结果。 */
async function selectRoundSourceAndTargetChain(page: Page, sourceTable: string): Promise<void> {
  await pickBatchSyncLabeledSelect(page, '数据源类型', 0, dataSyncSource.type);
  await pickBatchSyncLabeledSelect(page, '数据源名称', 0, dataSyncSource.name);
  await pickBatchSyncLabeledSelect(page, '数据库名称', 0, dataSyncSource.database);
  await pickBatchSyncLabeledSelect(page, 'Schema', 0, dataSyncSource.schema);
  // “表名称”下拉展开后不预加载选项（multiple/showSearch），必须键入表名触发搜索（20260917 round1 实证）。
  await pickBatchSyncTableBySearch(page, '表名称', 0, sourceTable);
  await pickBatchSyncLabeledSelect(page, '数据源类型', 1, dataSyncTarget.type);
  await pickBatchSyncLabeledSelect(page, '数据源名称', 1, dataSyncTarget.name);
  await pickBatchSyncLabeledSelect(page, '数据库名称', 1, dataSyncTarget.database);
  await pickBatchSyncLabeledSelect(page, 'Schema', 1, dataSyncTarget.schema);
}

/** 本轮新建表存在平台元数据刷新窗口：整链重选并显式重试；穷尽仍不可见则可读失败，不退回历史表。 */
async function selectRoundSourceAndTargetWithRefresh(page: Page, sourceTable: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await selectRoundSourceAndTargetChain(page, sourceTable);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 5) break;
      await page.waitForTimeout(3_000);
    }
  }
  throw new Error(
    `本轮来源表 ${sourceTable} 在平台“${dataSyncSource.name}/${dataSyncSource.database}”批量同步下拉中` +
      `重试 5 次后仍不可见（元数据刷新等待已穷尽）：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** 在数据集成列表按任务名精确查询，返回该任务的操作列行。 */
async function searchBatchSyncTask(page: Page, taskName: string) {
  await clickMenu(page, '数据接入', '数据集成');
  await page.getByRole('textbox').first().fill(taskName);
  await page.getByRole('button', { name: /查询/ }).click();
  await expect(page.getByText(taskName, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  return findDataSyncTaskOperationRow(page, taskName);
}

/** 点击行内“执行”触发一次任务；“执行”提交可能没有成功 toast，真实结果以实例/日志终态为准。 */
async function executeBatchSyncTaskOnce(page: Page, taskName: string) {
  const operationRow = await searchBatchSyncTask(page, taskName);
  const runButton = operationRow.getByRole('button', { name: '执行', exact: true });
  await expect(runButton, `任务 ${taskName} 行内应有“执行”按钮`).toBeVisible({ timeout: 10_000 });
  await runButton.click();
  await page.waitForTimeout(800);
}

/** 打开行内“日志”并轮询实例执行终态；成功终态返回，失败终态抛错（不伪造通过）。 */
async function openBatchSyncLogAndAwaitSuccess(page: Page, taskName: string, timeoutMs: number) {
  const operationRow = await searchBatchSyncTask(page, taskName);
  const logButton = operationRow.getByRole('button', { name: '日志', exact: true });
  await expect(logButton, `任务 ${taskName} 行内应有“日志”入口`).toBeVisible({ timeout: 10_000 });
  const knownPages = new Set(page.context().pages());
  const opened = page.context().waitForEvent('page', { timeout: 2_000 }).catch(() => undefined);
  await logButton.click();
  const popup = await opened;
  const logPage =
    popup ?? page.context().pages().find((candidate) => !knownPages.has(candidate)) ?? page;
  if (logPage !== page) await logPage.bringToFront();
  const rows = logPage.locator('tbody tr:visible, [role="row"]:visible');
  await expect(rows.first(), '“日志”应打开实例/日志视图').toBeVisible({ timeout: 15_000 });
  const deadline = Date.now() + timeoutMs;
  let statusText = '';
  while (Date.now() < deadline) {
    // DS-PERM-68：状态行只绑定包含本轮唯一任务名的实例行；页面不渲染任务名时，
    // 仅当“自本轮任务行打开 + 恰好 1 行”才允许兜底读取，绝不取任意首行。
    const total = await rows.count();
    let boundIndex = -1;
    for (let index = 0; index < total; index += 1) {
      const text = (await rows.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ');
      if (text.includes(taskName)) {
        statusText = text;
        boundIndex = index;
        break;
      }
    }
    if (boundIndex < 0 && total === 1) {
      statusText = (await rows.first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    }
    if (/执行成功|同步完成|接入成功|执行完成/.test(statusText)) return;
    if (/执行失败|同步失败|接入失败|异常/.test(statusText)) {
      throw new Error(`批量同步任务 ${taskName} 执行失败：${statusText}`);
    }
    const refresh = logPage.getByRole('button', { name: /^(?:查询|刷新)$/ }).last();
    if (await refresh.isVisible().catch(() => false)) await refresh.click().catch(() => undefined);
    await logPage.waitForTimeout(1_000);
  }
  throw new Error(
    `批量同步任务 ${taskName} 在 ${timeoutMs / 1000}s 内未出现执行成功终态；最后一次状态：${statusText || '未读取到'}`,
  );
}

// 用例编号：DI-04-03
// 功能模块：数据接入
// 测试类型：兼容性
// 公共配置引用：D001；D010；D008；D002
// 前置条件：准备包含文本字段的批量同步数据、目标表和可用调度平台连接。
// 实际测试数据：D008：源文件/表、文本字段、目标表、调度方式、预期解析结果：源=本轮自建 e2e_src_<uuid>
//   （含文本字段 name/phone_number/adress_di），目标=本轮唯一 e2e_di0403_<uuid> 自动建表。
// 操作步骤：1. 创建批量同步任务并配置文本解析（映射为：选择含文本字段的源表+自动建表目标）。
// 2. 配置调度平台及执行周期（映射为：任务保存后上线纳入调度；页面无独立调度平台配置）。
// 3. 保存并手动执行一次。
// 4. 查看任务状态、实例日志和目标表数据。
// 5. 再按调度方式触发一次并比对结果（映射为：再次执行并核对实例终态）。
// 预期结果：文本内容按规则解析并入库；任务可推送/适配约定调度平台；任务状态、日志和目标数据正确。
// 异常输入及预期：文本编码错误、字段超长、解析规则为空、调度连接失败、重复执行（待 flash 验证后逐项补充）。
// 清理/回滚：任务先下线再删除（行操作仅实证 执行/下线/日志；无删除入口则保留 UUID 任务）、本轮目标表与来源表 DROP IF EXISTS。
// 业务补充项：【本次新增来源】参考“通用需求池”第3行。
// 历史TS追溯：本次新增；参考“通用需求池”第3行。
test('DI-04-03｜数据接入｜文本字段批量同步与调度执行', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(300_000);
  const page = loginPage;
  const suffix = uuid();
  const taskName = `E2E_DI0403_${suffix}`;
  const targetTable = `e2e_di0403_${suffix}`;
  let taskCreated = false;
  // 步骤 0：本轮唯一来源表 + 文本样例行（不再依赖历史缺省表；主库未配置时给出可读跳过）。
  const sourceTable = await createRoundSourceTable(suffix);

  try {
    // 步骤 1：创建批量同步任务——选择含文本字段的源表与自动建表目标。
    await openBatchSyncCreate(page);
    // 步骤 1：选择数据源与目标——本轮唯一来源表经“整链重选 + 元数据刷新重试”定位（原历史表引用已移除）。
    await selectRoundSourceAndTargetWithRefresh(page, sourceTable);

    // 步骤 2：表级字段映射——断言源表按“自动建表 + 全量同步”生成映射。
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    const mappingRow = page.locator('tbody tr').filter({ hasText: sourceTable }).first();
    await expect(mappingRow).toBeVisible({ timeout: 15_000 });
    await expect(mappingRow).toContainText('自动建表');
    await expect(mappingRow).toContainText('全量同步');
    // 目标表名唯一化：默认目标表名=源表名，多轮回归会因同名表冲突。
    await page.getByRole('button', { name: '批量修改表名', exact: true }).click();
    const renameDialog = page.getByRole('dialog').last();
    await expect(renameDialog, '“批量修改表名”应弹出重命名弹窗').toBeVisible({ timeout: 10_000 });
    const renameInput = renameDialog.getByRole('textbox').first();
    await expect(renameInput).toBeVisible({ timeout: 5_000 });
    await renameInput.fill(targetTable);
    await renameDialog.getByRole('button', { name: /确\s*定|确\s*认|保\s*存/ }).last().click();
    await expect(
      page.locator('tbody tr').filter({ hasText: targetTable }).first(),
      '重命名后映射表应出现本轮唯一目标表名',
    ).toBeVisible({ timeout: 10_000 });

    // 步骤 3：调度配置（任务保存后以上线+执行触发调度链路）。
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    const taskNameInput = page.locator('#name');
    await expect(taskNameInput, '调度配置步骤应出现任务名称输入框(#name)').toBeVisible({ timeout: 10_000 });
    await taskNameInput.fill(taskName);
    const retryInput = page.locator('#maxRetry');
    await expect(retryInput).toBeVisible({ timeout: 10_000 });
    await retryInput.fill('1');
    const nonCore = page.getByRole('radio', { name: '否', exact: true }).last();
    await nonCore.check().catch(async () => nonCore.click());
    await page.getByRole('button', { name: /^\s*确\s*定\s*$/ }).click();
    await expect
      .poll(
        async () =>
          page.url().includes('/dataAccess/dataInteration') ||
          (await page.getByText(/成功|已保存|已创建/).last().isVisible().catch(() => false)),
        { timeout: 20_000 },
      )
      .toBe(true);
    taskCreated = true;

    // 步骤 4：上线纳入调度（原“配置调度平台及执行周期”的页面真实能力映射）。
    let operationRow = await searchBatchSyncTask(page, taskName);
    const onlineButton = operationRow.getByRole('button', { name: '上线', exact: true });
    await expect(onlineButton).toBeVisible({ timeout: 10_000 });
    await onlineButton.click();
    const confirmOnline = page.getByRole('button', { name: /确定|确认/ }).last();
    if (await confirmOnline.isVisible().catch(() => false)) await confirmOnline.click();
    operationRow = await findDataSyncTaskOperationRow(page, taskName);
    await expect(operationRow.getByRole('button', { name: '下线', exact: true })).toBeVisible({ timeout: 20_000 });

    // 步骤 5：手动执行一次，并在实例日志中核对执行成功终态。
    await executeBatchSyncTaskOnce(page, taskName);
    await openBatchSyncLogAndAwaitSuccess(page, taskName, 90_000);

    // 步骤 6：目标表数据核验（业务执行成功后 DB 查询属于必验断言，连接异常必须失败）。
    const countRows = await query(`SELECT COUNT(*) AS cnt FROM ${dataSyncTarget.database}.${targetTable}`);
    expect(Number(countRows[0]?.cnt ?? 0), '同步后目标表应有数据').toBeGreaterThan(0);
    const textRows = await query(
      `SELECT name FROM ${dataSyncTarget.database}.${targetTable} WHERE name IS NOT NULL AND TRIM(name) <> '' LIMIT 1`,
    );
    expect(textRows.length, '目标表文本字段 name 应存在非空值').toBeGreaterThan(0);

    // 步骤 7：再按调度链路触发一次并核对结果（重复执行等价验证）。
    await executeBatchSyncTaskOnce(page, taskName);
    await openBatchSyncLogAndAwaitSuccess(page, taskName, 90_000);

    await assertNoConsoleErrors(consoleErrors);
    await report(
      'DI-04-03 文本字段批量同步与调度执行',
      true,
      `源=${dataSyncSource.database}.${sourceTable}；目标=${dataSyncTarget.database}.${targetTable}；任务=${taskName}（上线态）。`,
    );
  } finally {
    // 清理（DS-PERM-68）：只回收本轮资产。任务先下线再删除（行操作仅实证 执行/下线/日志，无删除入口则告警保留，UUID 隔离）；
    // 本轮目标表与本轮来源表 DROP IF EXISTS（DB 未配置时记录原因跳过，不影响用例结果）。
    if (taskCreated) {
      try {
        await searchBatchSyncTask(page, taskName).catch(() => undefined);
        let row = await findDataSyncTaskOperationRow(page, taskName).catch(() => undefined);
        if (row) {
          const offlineButton = row.getByRole('button', { name: '下线', exact: true });
          if (await offlineButton.isVisible().catch(() => false)) {
            await offlineButton.click().catch(() => undefined);
            const confirmOffline = page.getByRole('button', { name: /确定|确认/ }).last();
            if (await confirmOffline.isVisible().catch(() => false)) await confirmOffline.click().catch(() => undefined);
            await page.waitForTimeout(500);
            row = await findDataSyncTaskOperationRow(page, taskName).catch(() => undefined);
          }
        }
        if (row) {
          const deleteButton = row.getByRole('button', { name: '删除', exact: true });
          if (await deleteButton.isVisible().catch(() => false)) {
            await deleteButton.click().catch(() => undefined);
            const confirmDelete = page.getByRole('button', { name: /确\s*认|确\s*定/ }).last();
            if (await confirmDelete.isVisible().catch(() => false)) await confirmDelete.click().catch(() => undefined);
            await page.waitForTimeout(500);
            console.warn(`[cleanup] 已请求删除本轮任务：${taskName}`);
          } else {
            console.warn(`[cleanup] 数据集成列表未提供“删除”操作，本轮任务保留（UUID 隔离）：${taskName}`);
          }
        }
      } catch (error) {
        console.warn(`[cleanup] 本轮任务回收未完成（${taskName}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const [database, table] of [
      [dataSyncTarget.database, targetTable],
      [dataSyncSource.database, sourceTable],
    ] as const) {
      try {
        await query(`DROP TABLE IF EXISTS \`${database}\`.\`${table}\``);
        console.warn(`[cleanup] 已回收本轮表：${database}.${table}`);
      } catch (error) {
        console.warn(
          `[cleanup] 本轮表未回收（DB 未配置或直连失败）：${database}.${table}；原因：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
});
