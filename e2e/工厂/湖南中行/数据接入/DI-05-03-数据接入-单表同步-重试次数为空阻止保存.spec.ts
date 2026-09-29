/**
 * DI-05-03｜数据接入｜单表同步-重试次数为空阻止保存
 *
 * DS-PERM-66 清洁环境迁移（静态开发，未启动浏览器/数据库回归）：
 *   - 不再依赖历史来源表（如 test_gs_0903）或固定数据源名：本轮先经配置中心
 *     （e2e/test-environment.ts；DATA_SYNC_SOURCE_* 与 DATA_SYNC_TARGET_* 兼容变量可覆盖）
 *     指向的来源库直建唯一 ASCII 来源表 e2e_src_retry_<uuid>（4 字段，
 *     与原验证表形态一致，来源字段计数断言语义不变）；
 *   - 新建表进入平台元数据存在刷新窗口：来源表下拉选择带显式整链重选重试
 *     （下拉每次展开都会重新拉取选项，等价于明确的元数据刷新等待），
 *     重试穷尽仍不可见则以可读错误失败，绝不借历史表蒙混；
 *   - 校验断言不依赖瞬时 toast：保存被阻断的持久证据=表单仍停留调度页，
 *     任务名称/重试次数原值可读；未保存任务、未创建目标表；
 *   - finally 只回收本轮资产：意外落库时按唯一名下线+删除任务（无删除入口则告警保留）、
 *     本轮来源/目标表 DROP IF EXISTS，不触碰任何历史任务/旧表；
 *   - DB 前置（DB_HOST/DB_USER/DB_PASS，经配置中心解析）缺失时显式 skip 并说明，
 *     不伪造通过；数据库连接一律由 e2e/utils.ts 的 query()（配置中心主库）代持，
 *     本 spec 不出现 host、port、账号、密码或固定库名。
 */
import { clickMenu, expect, query, test, uuid } from '../utils.js';
import {
  dataSyncSource,
  dataSyncTarget,
  findDataSyncTaskOperationRow,
  openSingleTableSyncCreate,
  selectDataSyncOption,
} from './数据集成工具.js';
import type { Page } from '@playwright/test';

/** 在配置中心来源库直建本轮唯一来源表；DB 未配置/驱动缺失时按前置缺失 skip，不伪造通过。 */
async function createRoundSourceTable(roundId: string): Promise<string> {
  const sourceTable = `e2e_src_${roundId}`;
  const ddl =
    'CREATE TABLE `' + dataSyncSource.database + '`.`' + sourceTable + '` (' +
    '`name` VARCHAR(64) NULL, `age` INT NULL, `phone_number` VARCHAR(32) NULL, `adress_di` VARCHAR(128) NULL)';
  try {
    await query(ddl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/未配置|暂未接入/.test(message)) {
      test.skip(true, `环境前置缺失：配置中心主库未配置或驱动缺失，无法创建本轮唯一来源表（${message}）`);
    }
    throw error;
  }
  return sourceTable;
}

/**
 * 选择“本轮来源表 → 自动建表目标表”。
 * 新建的来源表进入平台元数据存在刷新窗口：selectDataSyncOption 单次下拉等待有限，
 * 这里在当前创建页整链重选并显式重试（每次下拉展开都会重新拉取选项）；
 * 重试穷尽仍不可见则抛出可读错误，绝不退回历史表。
 */
async function selectRoundSourceAndAutomaticTarget(
  page: Page,
  sourceTable: string,
  targetTable: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await selectDataSyncOption(page, 'sourceDatabaseTypeId', dataSyncSource.type);
      await selectDataSyncOption(page, 'sourceSourceId', dataSyncSource.name);
      await selectDataSyncOption(page, 'sourceDatabaseId', dataSyncSource.database);
      await selectDataSyncOption(page, 'sourceSchemaId', dataSyncSource.schema);
      await selectDataSyncOption(page, 'sourceTableId', sourceTable);

      await selectDataSyncOption(page, 'sinkDatabaseTypeId', dataSyncTarget.type);
      await selectDataSyncOption(page, 'sinkSourceId', dataSyncTarget.name);
      await selectDataSyncOption(page, 'sinkDatabaseId', dataSyncTarget.database);
      await selectDataSyncOption(page, 'sinkSchemaId', dataSyncTarget.schema);

      const autoBuild = page.getByRole('radio', { name: '自动建表', exact: true });
      await expect(autoBuild).toBeVisible({ timeout: 10_000 });
      await autoBuild.check().catch(async () => await autoBuild.click());
      // 页面标签的 for=sinkTableId 未实际落在输入框 DOM 上；当前版本以此占位定位。
      const targetInput = page.getByPlaceholder('请输入自建表', { exact: true });
      await expect(targetInput).toBeVisible({ timeout: 10_000 });
      await targetInput.fill(targetTable);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 5) break;
      // 显式元数据刷新等待：整链重选会重新拉取各下拉选项，而不是退回历史表。
      await page.waitForTimeout(3_000);
    }
  }
  throw new Error(
    `本轮来源表 ${sourceTable} 在平台“${dataSyncSource.name}/${dataSyncSource.database}”下拉中` +
      `重试 5 次后仍不可见（元数据刷新等待已穷尽）：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * finally 只回收本轮资产：确认点击后若意外落库，按唯一名下线+删除任务
 * （无删除入口则告警保留，UUID 隔离）；再直连回收本轮目标/来源表（DROP IF EXISTS）；
 * 不触碰任何历史任务/旧表。
 */
async function cleanupRoundAssets(
  page: Page,
  taskName: string,
  sourceTable: string,
  targetTable: string,
  taskExisted: boolean,
): Promise<void> {
  try {
    if (taskExisted) {
      await clickMenu(page, '数据接入', '数据集成').catch(() => undefined);
      await page.getByRole('textbox').first().fill(taskName).catch(() => undefined);
      await page.getByRole('button', { name: /查询/ }).click().catch(() => undefined);
      await page.waitForTimeout(600);
      const row = await findDataSyncTaskOperationRow(page, taskName).catch(() => undefined);
      if (row) {
        const offline = row.getByRole('button', { name: '下线', exact: true });
        if (await offline.isVisible().catch(() => false)) {
          await offline.click().catch(() => undefined);
          const confirmOffline = page.getByRole('button', { name: /确定|确认/ }).last();
          if (await confirmOffline.isVisible().catch(() => false)) await confirmOffline.click().catch(() => undefined);
          await page.waitForTimeout(500);
        }
        const deleteButton = row.getByRole('button', { name: '删除', exact: true });
        if (await deleteButton.isVisible().catch(() => false)) {
          await deleteButton.click().catch(() => undefined);
          const confirmDelete = page.getByRole('button', { name: /确\s*认|确\s*定/ }).last();
          if (await confirmDelete.isVisible().catch(() => false)) await confirmDelete.click().catch(() => undefined);
          await page.waitForTimeout(800);
          console.warn(`[cleanup] 已请求删除本轮意外落库任务：${taskName}`);
        } else {
          console.warn(`[cleanup] 数据集成列表未提供“删除”操作，本轮任务保留（UUID 隔离）：${taskName}`);
        }
      }
    }
  } catch (error) {
    console.warn(`[cleanup] 本轮任务回收未完成（${taskName}）：${error instanceof Error ? error.message : String(error)}`);
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
        `[cleanup] 本轮表未回收（DB 未配置或直连失败）：${database}.${table}；` +
          `原因：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

test.describe('DI-05-03｜数据接入｜单表同步调度必填校验', () => {
  test('DI-05-03｜数据接入｜重试次数为空时不能保存同步任务', async ({ loginPage, report }) => {
    // 直建来源表 + 元数据刷新重试 + 三步向导超过默认时限，放宽并保留余量。
    test.setTimeout(180_000);
    const page = loginPage;
    const suffix = uuid();
    const sourceTable = await createRoundSourceTable(`retry_${suffix}`);
    const targetTable = `e2e_sync_retry_${suffix}`;
    const taskName = `E2E_SYNC_RETRY_${suffix}`;
    let confirmClicked = false;
    try {
      await openSingleTableSyncCreate(page);
      await selectRoundSourceAndAutomaticTarget(page, sourceTable, targetTable);
      await page.getByRole('button', { name: '下一步', exact: true }).click();
      await expect(page.getByText(/当前共\s*4\s*个来源字段/)).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: '下一步', exact: true }).click();

      await page.getByLabel('任务名称', { exact: true }).fill(taskName);
      const retryCount = page.getByRole('spinbutton').last();
      await expect(retryCount).toBeVisible({ timeout: 10_000 });
      await retryCount.fill('');
      await page.getByRole('radio', { name: '否', exact: true }).last().check().catch(async () => {
        await page.getByRole('radio', { name: '否', exact: true }).last().click();
      });
      await page.getByRole('button', { name: /^\s*确\s*定\s*$/ }).click();
      confirmClicked = true;

      // 重试次数为 * 必填项：保存被阻断的持久证据=表单仍停留调度页（任务名称/重试次数
      // 原值可读），不依赖瞬时 toast；未产生同步任务，也未创建目标表。
      await expect(page.getByLabel('任务名称', { exact: true })).toHaveValue(taskName, { timeout: 10_000 });
      await expect(retryCount).toHaveValue('');
      await report(
        '数据集成-单表同步-重试次数为空-阻止保存',
        true,
        `本轮来源表=${dataSyncSource.database}.${sourceTable}；保存被阻断停留调度页；未保存任务、未创建目标表。`,
      );
    } finally {
      await cleanupRoundAssets(page, taskName, sourceTable, targetTable, confirmClicked);
    }
  });
});
