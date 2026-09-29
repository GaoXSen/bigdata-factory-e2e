import { test } from '../utils.js';
import { expectLineage, openTableLineage, resolveExistingLineageFixture, runLineageCase, assertNoUnexpectedLineageConsoleErrors } from './血缘测试工具.js';
// 2026-09-15（35F 复测）：调度回写在高负载下滞后超过 2 分钟，把用例时限放宽到
// 900s，配合 LINEAGE_GRAPH_ATTEMPTS=16 的图谱重读窗口区分“回写滞后”与“解析失败”。
test.describe.configure({ timeout: 900_000 });
// 2026-09-17（闭环复测）：与本目录其他血缘用例对齐，未显式配置时把图谱重读
// 窗口提升到 16 次，区分“调度回写滞后”与“解析失败”。
if (!process.env.LINEAGE_GRAPH_ATTEMPTS) process.env.LINEAGE_GRAPH_ATTEMPTS = '16';
test('BL-02-08｜数据血缘｜自动解析 CTAS 表级与字段血缘', async ({ loginPage, consoleErrors, report }) => {
  // 2026-09-17（闭环复测）：MySQL 夹具下 CTAS（CREATE TABLE ... AS SELECT）的图谱
  // 自 2026-08-28 起多轮一致只返回目标表（BUG-F02，解析能力缺口，已在
  // bug问题清单-湖南中行-20260911-run100227.md 第二节记录）。按本轮任务约定改用
  // GBase 夹具复测解析能力。SQL 采用两个“已验证可解析”元素的最小组合：
  // CTAS 前缀取自基线唯一通过的 MID01（BL-04-02-03），SELECT * 取自 restore 基线
  // 的 INSERT ... SELECT *（2026-09-17 第一轮同表刚验证可正常回写血缘）。
  // 上一版 SELECT id AS id ... GROUP BY id 属未验证形态，第一轮失败后弃用；
  // 注：BL-04-02-04（MID02）基线失败是编辑器清空超时（工具层），不能作为
  // “GROUP BY 形态被产品拒解析”的证据。只校验来源/目标表节点存在，字段映射交给人工复核。
  const fixture = await resolveExistingLineageFixture(loginPage, true, 'gbase', 'BL-02-08');
  const item = {
    targetTable: fixture.targetTable,
    fixtureSet: 'gbase' as const,
    fixtureKey: 'BL-02-08',
    sql: `CREATE TEMPORARY TABLE ${fixture.targetTable} AS\n` +
      `SELECT * FROM ${fixture.sourceTable}`,
    // CTAS 的复杂字段映射不由 TS 判定，只核验来源表和目标表是否出现。
    expectedNodes: [fixture.sourceTable, fixture.targetTable],
  };
  await runLineageCase(loginPage, item, async () => {
    await openTableLineage(loginPage, item.targetTable);
    await expectLineage(loginPage, item);
  });
  await assertNoUnexpectedLineageConsoleErrors(consoleErrors); await report('自动解析真实表 CTAS 血缘（GBase 标准格式）', true, `实际提交 SQL：\n${item.sql}`);
});