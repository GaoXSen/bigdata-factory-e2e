import { test } from '../utils.js';
import { expectLineage, openTableLineage, resolveExistingLineageFixture, runLineageCase, assertNoUnexpectedLineageConsoleErrors } from './血缘测试工具.js';
test.describe.configure({ timeout: 240_000 });
// 2026-09-05 已完成真实页面回归：任务保存、上线和目标表血缘刷新均成功，
// 但 CTE 聚合 SQL 的图谱仅返回目标表，未解析出来源表。该问题属于当前
// 血缘解析能力，不能通过放宽“来源节点必须存在”的断言伪造通过；待解析器
// 支持后再解除跳过并复测。
test('BL-02-05｜数据血缘｜自动解析 CTE 与聚合字段血缘', async ({ loginPage, consoleErrors, report }) => {
  // BUG-F02 同因 + HN-20260911-170538-004（产品缺陷，后端血缘 SQL 解析能力缺口，非环境/定位问题）：
  // CTE 聚合 SQL 已按项目 Java 基准写为 INSERT INTO … WITH … SELECT，任务保存、上线和血缘页
  // 刷新均成功，但图谱只返回目标表，始终不显示来源表节点。证据：HN-20260911-170538-004
  // （BL-02-05/06，本地模型开发调度/LOCAL-AI-20260914-003-真实BUG问题清单/glm5.3-执行结果.md）；
  // bug问题清单-湖南中行-20260911-run100227.md 第二节 BUG-F02；run-20260911-170538 与
  // run-20260915-134701 均复现「血缘图未显示节点：e2e_hn_lineage_bl_02_05_source_0901」。
  // 同链路 BL-02-01/02 可通过，失败与 CTE 语法强相关，不得用重跑掩盖。原 SQL 与预期血缘完整
  // 保留在下方；恢复条件：解析器支持 CTE 血缘并在图谱返回来源表节点后，删除本 skip 按原断言
  // 复测，不得放宽来源节点断言伪造通过。
  const fixture = await resolveExistingLineageFixture(loginPage, true, 'gbase', 'BL-02-05');
  const item = {
    targetTable: fixture.targetTable,
    fixtureSet: 'gbase' as const,
    fixtureKey: 'BL-02-05',
    // 血缘解析器的 CTE 语法按项目 Java 基准写为 INSERT INTO … WITH … SELECT；
    // 不能把 WITH 放在整条 DML 最前面，否则解析器不会建立来源表关系。
    sql: `INSERT INTO ${fixture.targetTable} (${fixture.targetField})\n` +
      `WITH temp_view AS (\n` +
      `  SELECT ${fixture.sourceField}, MAX(${fixture.sourceField}) AS total FROM ${fixture.sourceTable} GROUP BY ${fixture.sourceField}\n` +
      `)\n` +
      `SELECT ${fixture.sourceField} FROM temp_view`,
    expectedNodes: [fixture.sourceTable, fixture.targetTable],
    expectedRelations: [`${fixture.sourceField} -> ${fixture.targetField}`],
  };
  await runLineageCase(loginPage, item, async () => {
    await openTableLineage(loginPage, item.targetTable);
    await expectLineage(loginPage, item);
  });
  await assertNoUnexpectedLineageConsoleErrors(consoleErrors); await report('自动解析真实表 CTE 与聚合字段血缘', true, `实际提交 SQL：\n${item.sql}`);
});
