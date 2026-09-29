import { test } from '../utils.js';
import { expectLineage, openTableLineage, resolveExistingLineageFixture, runLineageCase, assertNoUnexpectedLineageConsoleErrors } from './血缘测试工具.js';
test.describe.configure({ timeout: 240_000 });
// 2026-09-17（闭环复测）：与本目录其他血缘用例对齐，未显式配置时把图谱重读
// 窗口提升到 16 次，区分“调度回写滞后”与“解析失败”。
if (!process.env.LINEAGE_GRAPH_ATTEMPTS) process.env.LINEAGE_GRAPH_ATTEMPTS = '16';
test('BL-02-03｜数据血缘｜自动解析 CASE 表达式字段血缘', async ({ loginPage, consoleErrors, report }) => {
  // BUG-F02 同因（产品缺陷，后端血缘 SQL 解析能力缺口，非环境/定位问题）：CASE 表达式 SQL 的
  // 任务保存、上线和血缘页刷新均成功，但 selectJobLineage 图谱只返回目标表，始终不显示来源表节点。
  // 证据：bug问题清单-湖南中行-20260911-run100227.md 第二节 BUG-F02（表级用例 BL-02-03/05/06/08
  // 同因，09-10/09-11 相邻两轮一致失败）；run-20260911-100227、run-20260911-170538、
  // run-20260915-134701 均复现「血缘图未显示节点：e2e_hn_lineage_bl_02_03_source_0901」。
  // 同链路简单直传/聚合用例 BL-02-01/02 可通过，失败与 CASE 语法强相关，不得用重跑掩盖。
  // 原 SQL、预期节点与字段关系完整保留在下方；恢复条件：解析器支持 CASE 表达式血缘并在图谱
  // 返回来源表节点后，删除本 skip 按原断言复测，不得放宽来源节点断言伪造通过。
  const fixture = await resolveExistingLineageFixture(loginPage, true, 'gbase', 'BL-02-03');
  const item = {
    targetTable: fixture.targetTable,
    fixtureSet: 'gbase' as const,
    fixtureKey: 'BL-02-03',
    sql: `CREATE TEMPORARY TABLE ${fixture.targetTable} AS\n` +
      `SELECT CASE WHEN ${fixture.sourceField} IS NOT NULL THEN '高' ELSE '低' END AS ${fixture.targetField} FROM ${fixture.sourceTable} GROUP BY ${fixture.sourceField}`,
    expectedNodes: [fixture.sourceTable, fixture.targetTable],
    expectedRelations: [`${fixture.sourceField} -> ${fixture.targetField}`],
  };
  await runLineageCase(loginPage, item, async () => {
    await openTableLineage(loginPage, item.targetTable);
    await expectLineage(loginPage, item);
  });
  await assertNoUnexpectedLineageConsoleErrors(consoleErrors); await report('自动解析真实表 CASE 字段血缘', true, `实际提交 SQL：\n${item.sql}`);
});
