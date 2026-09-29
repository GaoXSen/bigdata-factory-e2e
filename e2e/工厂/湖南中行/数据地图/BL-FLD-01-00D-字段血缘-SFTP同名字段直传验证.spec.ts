/** BL-FLD-01-00D｜字段血缘｜SFTP 来源同名字段直传。 */
import { expect, test } from '../utils.js';
import type { Locator, Page } from '@playwright/test';
import {
  assertNoUnexpectedLineageConsoleErrors,
  configureAutoLineage,
  ensureFieldLineageTargetTable,
  expectLineage,
  openTableLineage,
} from './血缘测试工具.js';

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
 * 基线失败同 BL-FLD-01-00：目标表刚上线时表查询索引未同步，详情落入表管理
 * 兜底页后“数据血缘”页签定位失败。openTableLineage 自身已重试 3 次；这里在
 * 其失败后等待元数据同步再整段重试一次，只重试该页面瞬态。
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

// 该来源表由 SFTP 文件接入创建，已由页面验证可查看字段；本用例不重建它。
// 2026-09-20（110 环境迁移）：SFTP 来源表/目标全部落在 MySQL 110（e2e_test），表名加 _0920。
const SFTP_SOURCE = 'e2e_hn_fld_sftp_src_0920';
const TARGET = 'e2e_hn_fld_sftp_field_target_0920';
const SQL = `INSERT INTO ${TARGET} (sftp_id)\nSELECT sftp_id FROM ${SFTP_SOURCE}`;

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


test('BL-FLD-01-00D｜字段血缘｜SFTP同名字段直传与字段链路验证', async ({ loginPage, consoleErrors, report }) => {
  // 2026-09-16（闭环复测）：基线在导航阶段即被 180s 超时终止（浏览器被关闭，
  // locator.count: Target page ... has been closed）；目标表建表 + 调度保存 +
  // 图谱重读全链路放宽到 420s，先排除慢环境因素再判定真实失败。
  test.setTimeout(420_000);
  await ensureFieldLineageTargetTable(loginPage, TARGET, 'sftp_id VARCHAR(64)', 'mysql');
  await configureAutoLineageWithRetry(loginPage, {
    targetTable: TARGET,
    sql: SQL,
    expectedNodes: [SFTP_SOURCE, TARGET],
    expectedRelations: [`${SFTP_SOURCE}.sftp_id -> ${TARGET}.sftp_id`],
    dataSource: 'mysql',
  });
  await loginPage.waitForTimeout(1_000);
  await openTableLineageWithSyncRetry(loginPage, TARGET);
  await expectLineage(loginPage, {
    targetTable: TARGET,
    sql: SQL,
    expectedNodes: [SFTP_SOURCE, TARGET],
    expectedRelations: [`${SFTP_SOURCE}.sftp_id -> ${TARGET}.sftp_id`],
  });
  // 字段链路验证（任务要求：字段默认只显示三个时可按字段名搜索，点击右下角
  // 展开/加号查看上下游）：展开右侧目标表节点，搜索 sftp_id，打开字段详情弹窗，
  // 验证“来源表前缀 + sftp_id + SQL自动解析”关系边。同名字段会同时渲染在弹窗
  // 两端节点上，使用 first() 规避 strict-mode 多匹配。
  await (await rightMostVisible(loginPage.getByText('展开', { exact: true }), '展开')).click();
  const fieldSearch = await rightMostVisible(loginPage.locator('input[placeholder*="字段"]:visible'), '搜索字段');
  await fieldSearch.fill('sftp_id');
  await loginPage.waitForTimeout(250);
  await (await rightMostVisible(loginPage.getByText('sftp_id', { exact: true }), '目标字段 sftp_id')).click();
  const dialog = loginPage.locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible').last();
  try {
    await expect(dialog).toBeVisible({ timeout: 8_000 });
    await expect(dialog).toContainText(`字段血缘：${TARGET}.sftp_id`);
    await expect(dialog).toContainText(SFTP_SOURCE.slice(0, 18));
    await expect(dialog).toContainText(TARGET.slice(0, 18));
    await expect(dialog.getByText('SQL自动解析', { exact: true }).first()).toBeVisible({ timeout: 6_000 });
  } finally {
    await closeDialog(dialog);
  }
  assertNoUnexpectedLineageConsoleErrors(consoleErrors);
  await report('字段血缘-SFTP同名字段直传验证', true, `已验证同名字段直传 sftp_id -> sftp_id 及 SQL自动解析字段边。SQL=${SQL}`);
});
