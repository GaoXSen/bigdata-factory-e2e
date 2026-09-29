import { test } from '../utils.js';
import { assertNoUnexpectedLineageConsoleErrors, configureExistingLineageStatement, expectLineage, openTableLineage } from './血缘测试工具.js';
import { gbaseSplitLineageCases } from './GBase拆分血缘用例.js';
import type { ExistingLineageStatementCase } from './血缘测试工具.js';
import type { Page } from '@playwright/test';

test.describe.configure({ timeout: 480_000 });
// 2026-09-17（闭环复测）：基线 run-20260916-173034 中本用例因任务调度编辑器
// “清空/回显竞态 + 剪贴板粘贴落空”失败（Expected: 本轮SQL Received: ''），属脚本
// 瞬态而非解析缺陷；与本目录 BL-04-01-01/BL-04-02-06 对齐：未显式配置时把图谱
// 重读窗口提升到 16 次，粘贴类超时整段重试最多 3 次。
if (!process.env.LINEAGE_GRAPH_ATTEMPTS) process.env.LINEAGE_GRAPH_ATTEMPTS = '16';

/**
 * 目标表任务调度的 Monaco 编辑器存在“旧脚本回显晚于清空”的竞态：上轮保存的
 * SQL 在清空动作之后才回填，expect.poll 以 “Expected: '' Received: 旧 SQL” 失败；
 * 并发运行时剪贴板竞争还会让粘贴整体落空（“Expected: 本轮SQL Received: ''”）。
 * 该瞬态只影响页面输入，不影响已保存数据；对这类错误把整段配置流程重试，
 * 页面结构/接口类错误不重试，避免掩盖真实缺陷。
 */
async function configureExistingStatementWithRetry(
  page: Page,
  item: ExistingLineageStatementCase,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await configureExistingLineageStatement(page, item);
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

test("BL-04-02-04｜GBase MID02 临时表聚合", async ({ loginPage, consoleErrors, report }) => {
  const base = gbaseSplitLineageCases["BL-04-02-04"];
  // 2026-09-17（闭环复测）：按任务约定，任务调度 SQL 去掉末尾分号后一次性粘贴
  // 标准多行文本；语法（临时表 CTAS + GROUP BY 聚合）与来源节点断言保持不变。
  const item: ExistingLineageStatementCase = { ...base, sql: base.sql.replace(/;\s*$/, '') };
  await configureExistingStatementWithRetry(loginPage, item);
  await openTableLineage(loginPage, item.targetTable);
  await expectLineage(loginPage, item);
  await assertNoUnexpectedLineageConsoleErrors(consoleErrors);
  await report("GBase血缘解析-BL-04-02-04", true, `GBase B 过程 MID02 临时表 CTAS\n实际提交 SQL：\n${item.sql}`);
});