/** BL-FLD-01-00｜字段血缘｜文件接入来源到 MySQL 110 目标表的最小解析基线（2026-09-20 110 环境迁移）。 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../utils.js';
import {
  assertNoUnexpectedLineageConsoleErrors,
  configureAutoLineage,
  ensureFieldLineageTargetTable,
  expectLineage,
  openTableLineage,
} from './血缘测试工具.js';

// 2026-09-20（110 环境迁移）：来源/目标全部落在 MySQL 110（e2e_test），表名加 _0920。
const FILE_SOURCE = 'e2e_hn_fld_file_src_0920';
// 每条 SQL 使用独立目标表/任务。后端当前会为首次解析创建血缘作业记录，
// 后续更新不会重新插入该记录；不能让“基线 SQL”污染主映射 SQL 的解析结果。
const TARGET = 'e2e_hn_fld_baseline_target_0920';
const SQL = `INSERT INTO ${TARGET} (target_id)\nSELECT file_id FROM ${FILE_SOURCE}`;

async function rightMostVisible(candidates: Locator, description: string): Promise<Locator> {
  let winner: Locator | undefined;
  let largestX = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const box = await candidate.boundingBox();
    if (box && box.x > largestX) {
      winner = candidate;
      largestX = box.x;
    }
  }
  if (!winner) throw new Error(`字段血缘图未找到右侧目标表控件：${description}`);
  return winner;
}

async function closeDialog(dialog: Locator): Promise<void> {
  if (!await dialog.isVisible().catch(() => false)) return;
  await dialog.page().keyboard.press('Escape').catch(() => undefined);
  await expect(dialog).toBeHidden({ timeout: 3_000 }).catch(async () => {
    const close = dialog.getByRole('button', { name: /关闭|close/i }).last();
    if (await close.isVisible().catch(() => false)) await close.click();
  });
}

/**
 * 基线失败（run-20260915-134701-316）：目标表刚上线时表查询索引未同步，详情
 * 落入表管理兜底页后“数据血缘”页签定位失败（未找到数据地图详情页签“数据血缘”）。
 * openTableLineage 自身已重试 3 次；这里在其失败后等待元数据同步再整段重试
 * 一次，只重试该页面瞬态，其余错误原样抛出。
 */
async function openTableLineageWithSyncRetry(page: Page, tableName: string): Promise<void> {
  try {
    await openTableLineage(page, tableName);
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    if (!/未找到数据地图详情页签|血缘图仍为空|未能读取/.test(message)) throw error;
    await page.waitForTimeout(15_000);
    await openTableLineage(page, tableName);
  }
}

/**
 * 2026-09-16（闭环复测）：pasteLongText 的 Ctrl+V 在剪贴板互斥锁之外执行，
 * 多个 Playwright 进程并发时粘贴可能整体落空，fillTargetTaskSchedule 以
 * “Expected: <本轮SQL> Received: ''”（Timeout 5000ms exceeded）失败
 * （run-20260916-155048-788 全部 7 例即此）。该瞬态只影响页面输入，不
 * 影响已保存数据；匹配该类错误后整段配置流程重试一次，其余错误原样抛出。
 */
async function configureAutoLineageWithRetry(
  page: Page,
  item: Parameters<typeof configureAutoLineage>[1],
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await configureAutoLineage(page, item);
      return;
    } catch (error) {
      lastError = error;
      const message = String((error as Error)?.message ?? error);
      if (!/(timed out|Timeout \d+ms exceeded)/i.test(message) || !/Expected|Received/.test(message)) throw error;
      await page.waitForTimeout(3_000 + attempt * 2_000);
    }
  }
  throw lastError;
}


test('BL-FLD-01-00｜字段血缘｜文件来源最小字段映射基线', async ({ loginPage, consoleErrors, report }) => {
  // 2026-09-16（闭环复测）：目标表“建表 + 任务调度保存 + 上线 + 图谱重读”全链路
  // 目标表刚上线时表查询索引未同步的页面瞬态，由下方 openTableLineageWithSyncRetry 兜底重试。

  // 在高负载环境下超过 120s（基线即如此），放宽到 420s 区分慢环境与真实失败。
  test.setTimeout(420_000);
  await ensureFieldLineageTargetTable(loginPage, TARGET, undefined, 'mysql');
  await configureAutoLineageWithRetry(loginPage, {
    targetTable: TARGET,
    sql: SQL,
    expectedNodes: [FILE_SOURCE, TARGET],
    expectedRelations: [`${FILE_SOURCE}.file_id -> ${TARGET}.target_id`],
    dataSource: 'mysql',
  });
  await loginPage.waitForTimeout(1_000);
  await openTableLineageWithSyncRetry(loginPage, TARGET);
  await expectLineage(loginPage, { targetTable: TARGET, sql: SQL, expectedNodes: [FILE_SOURCE, TARGET] });

  // 不能只因 file_id 与 target_id 名称不同就判定字段血缘不存在。实际判定为：
  // 点开目标字段 target_id 后，弹窗同时展示来源字段 file_id、目标字段 target_id
  // 和 SQL 自动解析关系边，证明解析器按 SQL 映射而非按字段同名匹配。
  await (await rightMostVisible(loginPage.getByText('展开', { exact: true }), '展开')).click();
  const fieldSearch = await rightMostVisible(loginPage.locator('input[placeholder*="字段"]:visible'), '搜索字段');
  await fieldSearch.fill('target_id');
  await loginPage.waitForTimeout(250);
  await (await rightMostVisible(loginPage.getByText('target_id', { exact: true }), '目标字段 target_id')).click();
  const dialog = loginPage.locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible').last();
  try {
    await expect(dialog).toBeVisible({ timeout: 8_000 });
    await expect(dialog).toContainText(`字段血缘：${TARGET}.target_id`);
    await expect(dialog).toContainText(FILE_SOURCE.slice(0, 18));
    await expect(dialog).toContainText(TARGET.slice(0, 18));
    await expect(dialog.getByText('SQL自动解析', { exact: true })).toBeVisible({ timeout: 6_000 });
    await expect(dialog.getByText('file_id', { exact: true }), '异名映射未展示来源字段 file_id')
      .toBeVisible({ timeout: 6_000 });
    await expect(dialog.getByText('target_id', { exact: true }), '异名映射未展示目标字段 target_id')
      .toBeVisible({ timeout: 6_000 });
  } finally {
    await closeDialog(dialog);
  }
  assertNoUnexpectedLineageConsoleErrors(consoleErrors);
  await report('字段血缘-文件来源最小映射基线', true, `已验证异名字段映射 file_id -> target_id。SQL=${SQL}`);
});
