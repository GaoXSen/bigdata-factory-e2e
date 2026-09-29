/** BL-FLD-02-04｜字段血缘｜虚拟来源 JOIN 两表映射。语法矩阵对齐表级 BL-02-04。 */
import { test } from '../utils.js';
import { runVirtualSourceFieldLineageCase } from './字段血缘语法用例工具.js';

const SOURCE_A = 'e2e_hn_fld_vsql_join_a_src_v1';
const SOURCE_B = 'e2e_hn_fld_vsql_join_b_src_v1';
const TARGET = 'e2e_hn_gbase_fld_vsql_join_target_v1';
const SQL = `INSERT INTO ${TARGET} (
  a_id,
  join_key,
  a_amount,
  b_region
)
SELECT
  a.v_id,
  a.v_key,
  a.v_amount,
  b.v_region
FROM ${SOURCE_A} a
INNER JOIN ${SOURCE_B} b
  ON a.v_key = b.v_key`;

test('BL-FLD-02-04｜字段血缘｜虚拟来源JOIN两表映射', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(240_000);
  await runVirtualSourceFieldLineageCase(loginPage, consoleErrors, report, {
    caseNo: 'BL-FLD-02-04',
    reportTitle: '虚拟来源JOIN两表映射',
    targetTable: TARGET,
    ddlColumns: 'a_id VARCHAR(64), join_key VARCHAR(64), a_amount VARCHAR(32), b_region VARCHAR(32)',
    sql: SQL,
    expectedNodes: [SOURCE_A, SOURCE_B, TARGET],
    virtualSourceTables: [SOURCE_A, SOURCE_B],
    relations: [
      { targetField: 'a_id', sources: [{ table: SOURCE_A, field: 'v_id' }] },
      { targetField: 'join_key', sources: [{ table: SOURCE_A, field: 'v_key' }] },
      { targetField: 'a_amount', sources: [{ table: SOURCE_A, field: 'v_amount' }] },
      { targetField: 'b_region', sources: [{ table: SOURCE_B, field: 'v_region' }] },
    ],
  });
});
