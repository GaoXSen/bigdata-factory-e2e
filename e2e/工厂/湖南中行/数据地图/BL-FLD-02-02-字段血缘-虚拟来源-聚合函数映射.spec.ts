/** BL-FLD-02-02｜字段血缘｜虚拟来源聚合函数映射。语法矩阵对齐表级 BL-02-02。 */
import { test } from '../utils.js';
import { runVirtualSourceFieldLineageCase } from './字段血缘语法用例工具.js';

const VIRTUAL_SOURCE = 'e2e_hn_fld_vsql_agg_src_v1';
const TARGET = 'e2e_hn_gbase_fld_vsql_agg_target_v1';
// COUNT(*) 的产品字段血缘语义当前没有页面证据：不在静态阶段预设“常量”，
// 关系标记 upstreamUnknown，用例只采集弹窗证据与截图，交视觉复核阶段裁定。
const SQL = `INSERT INTO ${TARGET} (
  total_amount,
  max_id,
  row_count
)
SELECT
  SUM(v_amount),
  MAX(v_id),
  COUNT(*)
FROM ${VIRTUAL_SOURCE}`;

test('BL-FLD-02-02｜字段血缘｜虚拟来源聚合函数映射', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(240_000);
  await runVirtualSourceFieldLineageCase(loginPage, consoleErrors, report, {
    caseNo: 'BL-FLD-02-02',
    reportTitle: '虚拟来源聚合函数映射',
    targetTable: TARGET,
    ddlColumns: 'total_amount VARCHAR(32), max_id VARCHAR(64), row_count VARCHAR(32)',
    sql: SQL,
    expectedNodes: [VIRTUAL_SOURCE, TARGET],
    virtualSourceTables: [VIRTUAL_SOURCE],
    relations: [
      { targetField: 'total_amount', sources: [{ table: VIRTUAL_SOURCE, field: 'v_amount' }] },
      { targetField: 'max_id', sources: [{ table: VIRTUAL_SOURCE, field: 'v_id' }] },
      { targetField: 'row_count', sources: [], upstreamUnknown: true },
    ],
  });
});
