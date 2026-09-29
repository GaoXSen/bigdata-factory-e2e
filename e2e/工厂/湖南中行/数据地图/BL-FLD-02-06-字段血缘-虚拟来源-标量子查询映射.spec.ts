/** BL-FLD-02-06｜字段血缘｜虚拟来源标量子查询映射。语法矩阵对齐表级 BL-02-06。 */
import { test } from '../utils.js';
import { runVirtualSourceFieldLineageCase } from './字段血缘语法用例工具.js';

const VIRTUAL_SOURCE = 'e2e_hn_fld_vsql_scalar_src_v1';
const TARGET = 'e2e_hn_gbase_fld_vsql_scalar_target_v1';
const SQL = `INSERT INTO ${TARGET} (
  max_amount,
  v_id
)
SELECT
  (SELECT MAX(v_amount) FROM ${VIRTUAL_SOURCE} WHERE v_id IS NOT NULL),
  v_id
FROM ${VIRTUAL_SOURCE}`;

test('BL-FLD-02-06｜字段血缘｜虚拟来源标量子查询映射', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(240_000);
  // 2026-09-17（闭环复测）：原 BUG-F02 跳过按任务约定复核移除，实测并按真实断言
  // 记录结果；失败时在结果文件归类根因，不放宽字段断言。
  await runVirtualSourceFieldLineageCase(loginPage, consoleErrors, report, {
    caseNo: 'BL-FLD-02-06',
    reportTitle: '虚拟来源标量子查询映射',
    targetTable: TARGET,
    ddlColumns: 'max_amount VARCHAR(32), v_id VARCHAR(64)',
    sql: SQL,
    expectedNodes: [VIRTUAL_SOURCE, TARGET],
    virtualSourceTables: [VIRTUAL_SOURCE],
    relations: [
      // 标量子查询列的字段血缘应指向内层聚合列 v_amount，而非整表任意字段。
      // 内层 WHERE 中的 v_id 可能带来附加边；断言只要求 v_amount 边存在，容忍多余边。
      { targetField: 'max_amount', sources: [{ table: VIRTUAL_SOURCE, field: 'v_amount' }] },
      { targetField: 'v_id', sources: [{ table: VIRTUAL_SOURCE, field: 'v_id' }] },
    ],
  });
});
