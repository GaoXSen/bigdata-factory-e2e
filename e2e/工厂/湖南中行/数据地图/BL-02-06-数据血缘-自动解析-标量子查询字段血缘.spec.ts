import { test } from '../utils.js';
import { expectLineage, openTableLineage, resolveExistingLineageFixture, runLineageCase, assertNoUnexpectedLineageConsoleErrors } from './血缘测试工具.js';
test.describe.configure({ timeout: 240_000 });
// 2026-09-05 已完成真实页面回归：任务保存、上线和目标表血缘刷新均成功，
// 但标量子查询 SQL 的图谱仅返回目标表，未解析出来源表。保留真实 SQL 和
// 独立夹具，待解析器支持后解除跳过复测，不能改宽断言而误报通过。
test('BL-02-06｜数据血缘｜自动解析标量子查询字段血缘', async ({ loginPage, consoleErrors, report }) => {
  // BUG-F02 同因 + HN-20260911-170538-004（产品缺陷，后端血缘 SQL 解析能力缺口，非环境/定位问题）：
  // 标量子查询 SQL 的任务保存、上线和血缘页刷新均成功，但图谱只返回目标表，始终不显示来源表节点。
  // 证据：HN-20260911-170538-004（BL-02-05/06，本地模型开发调度/LOCAL-AI-20260914-003-真实BUG
  // 问题清单/glm5.3-执行结果.md）；bug问题清单-湖南中行-20260911-run100227.md 第二节 BUG-F02；
  // run-20260911-100227、run-20260911-170538、run-20260915-134701 均复现
  // 「血缘图未显示节点：e2e_hn_lineage_bl_02_06_source_0901」。同链路 BL-02-01/02 可通过，
  // 失败与标量子查询语法强相关，不得用重跑掩盖。原 SQL 与预期节点完整保留在下方；
  // 恢复条件：解析器支持标量子查询血缘并在图谱返回来源表节点后，删除本 skip 按原断言复测，
  // 不得放宽来源节点断言伪造通过。
  // 标量子查询不是不可自动化的复杂流程：该用例有独立的源/目标夹具，
  // 通过目标表任务调度保存并上线后，只核验表级来源→目标节点；字段细节再由人工复核。
  const fixture = await resolveExistingLineageFixture(loginPage, true, 'gbase', 'BL-02-06');
  const item = {
    targetTable: fixture.targetTable,
    fixtureSet: 'gbase' as const,
    fixtureKey: 'BL-02-06',
    sql: `INSERT INTO ${fixture.targetTable} (${fixture.targetField})\n` +
      `SELECT (SELECT MAX(${fixture.sourceField}) FROM ${fixture.sourceTable} WHERE ${fixture.sourceField} IS NOT NULL)\n` +
      `FROM ${fixture.sourceTable}`,
    // 复杂 SQL 只自动核验表级节点；字段映射由人工在页面关系详情中复核。
    expectedNodes: [fixture.sourceTable, fixture.targetTable],
  };
  await runLineageCase(loginPage, item, async () => {
    await openTableLineage(loginPage, item.targetTable);
    await expectLineage(loginPage, item);
  });
  await assertNoUnexpectedLineageConsoleErrors(consoleErrors); await report('自动解析真实表标量子查询字段血缘', true, `实际提交 SQL：\n${item.sql}`);
});

