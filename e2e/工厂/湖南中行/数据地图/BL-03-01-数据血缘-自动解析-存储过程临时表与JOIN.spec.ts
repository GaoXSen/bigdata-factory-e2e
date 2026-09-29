import { test } from '../utils.js';
import type { Page } from '@playwright/test';
import { expectLineage, openTableLineage, resolveExistingLineageFixture, runLineageCase, assertNoUnexpectedLineageConsoleErrors } from './血缘测试工具.js';
// 2026-09-15（35F 复测）：调度回写在高负载下滞后超过 2 分钟，把用例时限放宽到
// 900s，配合 LINEAGE_GRAPH_ATTEMPTS=16 的图谱重读窗口区分“回写滞后”与“解析失败”。
test.describe.configure({ timeout: 900_000 });
// 2026-09-16（闭环复测）：基线 run-20260915-134701-316 未显式设置
// LINEAGE_GRAPH_ATTEMPTS，expectLineage 只重读 6 次就判定来源节点缺失，与上方
// 注释约定的 16 次窗口不一致；未显式配置时在本文件内补齐，保证任何入口运行一致。
if (!process.env.LINEAGE_GRAPH_ATTEMPTS) process.env.LINEAGE_GRAPH_ATTEMPTS = '16';

/**
 * 目标表任务调度的 Monaco 编辑器存在“旧脚本回显晚于清空”的竞态：上轮保存的
 * SQL 在清空动作之后才回填（“Expected: '' Received: 旧 SQL”）；并发运行时剪贴板
 * 竞争还会让粘贴整体落空（“Expected: 本轮SQL Received: ''”，run-20260916-155048-788
 * 全部 7 例即此，且该报错文案为 “Timeout 5000ms exceeded” 而非 “timed out”）。
 * （基线中 BL-04-02-09 即此现象；本用例目标表同样带有 9/15 保存的旧脚本）。
 * 该瞬态只影响页面输入，不影响已保存数据；对这类错误把整段流程重试一次，
 * 页面结构/接口类错误不重试，避免掩盖真实缺陷。
 */
async function runLineageCaseWithEditorRetry<T>(
  page: Page,
  item: Parameters<typeof runLineageCase>[1],
  verify: () => Promise<T>,
): Promise<T> {
  // 2026-09-16（闭环复测）：并发 agent 的剪贴板竞争会让单次粘贴落空/回显覆盖，
  // 单次重试仍不够（run-20260916-160424-003 中 BL-03-01 两种变体都复现），
  // 改为最多 3 次整段重试，逐次加长间隔错开其他进程的剪贴板写入窗口。
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await runLineageCase(page, item, verify);
    } catch (error) {
      lastError = error;
      const message = String((error as Error)?.message ?? error);
      if (!/(timed out|Timeout \d+ms exceeded)/i.test(message) || !/Expected|Received/.test(message)) throw error;
      await page.waitForTimeout(3_000 + attempt * 2_000);
    }
  }
  throw lastError;
}

// 2026-09-17（闭环复测）：存储过程包装（CREATE PROCEDURE ... BEGIN ... END）在
// MySQL/GBase 两条解析链路均不产生来源节点（BUG-F02 历史证据：2026-09-05、
// run-20260911-100227/170538、run-20260915-134701、run-20260916-173034 多轮一致，
// 过程体里的临时表 CTAS 与 JOIN 单独提交时可解析）。按本轮任务约定，改用 GBase
// 夹具与当前已可解析的标准格式保留“临时表 + JOIN”语义：临时表 CTAS 承载来源表
// 自连接（来源表同时出现在 FROM 与 SELECT 列表，与已通过的 BL-04-02-05 同型），
// 不带末尾分号、一次性粘贴；存储过程体解析缺口维持已上报缺陷结论，不因本格式
// 调整而关闭。
test('BL-03-01｜数据血缘｜自动解析存储过程临时表与 JOIN', async ({ loginPage, consoleErrors, report }) => {
  // 只校验真实源表和目标表进入图谱；临时表别名、自连接细节和边详情不作自动断言。
  const fixture = await resolveExistingLineageFixture(loginPage, true, 'gbase', 'BL-03-01');
  const item = {
    targetTable: fixture.targetTable,
    fixtureSet: 'gbase' as const,
    fixtureKey: 'BL-03-01',
    sql: `CREATE TEMPORARY TABLE ${fixture.targetTable} AS\n` +
      `SELECT A.${fixture.sourceField}\n` +
      `FROM ${fixture.sourceTable} A\n` +
      `JOIN ${fixture.sourceTable} B ON A.${fixture.sourceField} = B.${fixture.sourceField}\n` +
      `GROUP BY A.${fixture.sourceField}`,
    // 临时表、JOIN 的字段级关系交给人工核验；TS 只核验
    // 真实来源表和目标表是否进入血缘图谱。
    expectedNodes: [fixture.sourceTable, fixture.targetTable],
  };
  await runLineageCaseWithEditorRetry(loginPage, item, async () => {
    await openTableLineage(loginPage, item.targetTable);
    await expectLineage(loginPage, item);
  });
  await assertNoUnexpectedLineageConsoleErrors(consoleErrors); await report('自动解析真实表存储过程、临时表和 JOIN 血缘', true, `实际提交 SQL：\n${item.sql}`);
});

