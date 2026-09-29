/** BL-FLD-02-03｜字段血缘｜虚拟来源 CASE 表达式映射。语法矩阵对齐表级 BL-02-03。 */
import { test } from '../utils.js';
import { runVirtualSourceFieldLineageCase } from './字段血缘语法用例工具.js';

const VIRTUAL_SOURCE = 'e2e_hn_fld_vsql_case_src_v1';
const TARGET = 'e2e_hn_gbase_fld_vsql_case_target_v1';
const SQL = `INSERT INTO ${TARGET} (
  level_tag,
  v_id
)
SELECT
  CASE WHEN v_amount > 100 THEN 'HIGH' ELSE 'LOW' END,
  v_id
FROM ${VIRTUAL_SOURCE}`;

test('BL-FLD-02-03｜字段血缘｜虚拟来源CASE表达式映射', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(240_000);
  // 2026-09-17（闭环复测）：原 BUG-F02 跳过按任务约定复核移除，实测并按真实断言
  // 记录结果（同矩阵 BL-FLD-02-01/02/04 已通过，跳过可能已陈旧）；失败时在结果
  // 文件归类根因，不放宽字段断言。
  await runVirtualSourceFieldLineageCase(loginPage, consoleErrors, report, {
    caseNo: 'BL-FLD-02-03',
    reportTitle: '虚拟来源CASE表达式映射',
    targetTable: TARGET,
    ddlColumns: 'level_tag VARCHAR(16), v_id VARCHAR(64)',
    sql: SQL,
    expectedNodes: [VIRTUAL_SOURCE, TARGET],
    virtualSourceTables: [VIRTUAL_SOURCE],
    relations: [
      // CASE 分支的字段血缘应穿透到条件列 v_amount，而不是仅按输出常量处理。
      { targetField: 'level_tag', sources: [{ table: VIRTUAL_SOURCE, field: 'v_amount' }] },
      { targetField: 'v_id', sources: [{ table: VIRTUAL_SOURCE, field: 'v_id' }] },
    ],
  });
});
