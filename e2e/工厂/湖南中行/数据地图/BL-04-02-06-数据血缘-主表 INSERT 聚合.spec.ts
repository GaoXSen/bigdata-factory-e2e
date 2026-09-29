import { test } from '../utils.js';
import { assertNoUnexpectedLineageConsoleErrors, configureExistingLineageStatement, expectLineage, openTableLineage } from './血缘测试工具.js';
import { gbaseSplitLineageCases } from './GBase拆分血缘用例.js';
import type { ExistingLineageStatementCase } from './血缘测试工具.js';
import type { Page } from '@playwright/test';

test.describe.configure({ timeout: 480_000 });
// 2026-09-16（闭环复测）：expectLineage 默认只重读 6 次图谱，不足以区分“回写
// 滞后”与“解析失败”（基线即 6 次窗口内失败）；未显式配置时提升到 16 次，
// 与本文件 480s 用例时限配套。
if (!process.env.LINEAGE_GRAPH_ATTEMPTS) process.env.LINEAGE_GRAPH_ATTEMPTS = '16';

/**
 * 目标表任务调度的 Monaco 编辑器存在“旧脚本回显晚于清空”的竞态：上轮保存的
 * SQL 在清空动作之后才回填，expect.poll 以 “Expected: '' Received: 旧 SQL” 失败
 * （基线 run-20260915-134701-316 中 BL-04-02-09 即此现象）。该瞬态只影响页面
 * 输入，不影响已保存数据；对这类错误把整段配置流程重试一次。
 */
async function configureExistingStatementWithRetry(
  page: Page,
  item: ExistingLineageStatementCase,
): Promise<void> {
  // 2026-09-16（闭环复测）：并发 agent 的剪贴板竞争会让单次粘贴落空/回显覆盖，
  // 单次重试仍不够，改为最多 3 次整段重试，逐次加长间隔错开其他进程的写入窗口。
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

// GBase 来源关系基础解析当前不可用，保留 SQL 等待解析链路修复后复测。

test("BL-04-02-06｜GBase 主表 INSERT 聚合", async ({ loginPage, consoleErrors, report }) => {
  const base = gbaseSplitLineageCases["BL-04-02-06"];
  // 2026-09-16（闭环复测）：按任务约定，任务调度 SQL 去掉末尾分号后一次性粘贴
  // 标准多行文本；复杂语法（三表 LEFT JOIN + GROUP BY 聚合）与全部来源节点
  // 断言保持不变，不允许删除来源节点断言来伪造通过。
  const item: ExistingLineageStatementCase = { ...base, sql: base.sql.replace(/;\s*$/, '') };
  await configureExistingStatementWithRetry(loginPage, item);
  await openTableLineage(loginPage, item.targetTable);
  await expectLineage(loginPage, item);
  await assertNoUnexpectedLineageConsoleErrors(consoleErrors);
  await report("GBase血缘解析-BL-04-02-06", true, `GBase B 过程主表聚合 INSERT\n实际提交 SQL：\n${item.sql}`);
});
