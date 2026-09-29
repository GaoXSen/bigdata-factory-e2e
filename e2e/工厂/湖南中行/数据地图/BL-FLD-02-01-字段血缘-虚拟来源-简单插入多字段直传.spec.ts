/** BL-FLD-02-01｜字段血缘｜虚拟来源简单插入多字段直传。语法矩阵对齐表级 BL-02-01。 */
import { test } from '../utils.js';
import { runVirtualSourceFieldLineageCase } from './字段血缘语法用例工具.js';

const VIRTUAL_SOURCE = 'e2e_hn_fld_vsql_simple_src_v1';
const TARGET = 'e2e_hn_gbase_fld_vsql_simple_target_v1';
// 标准多行格式（业务已人工验证）：无终止分号，一次性整段粘贴。
const SQL = `INSERT INTO ${TARGET} (
  v_id,
  v_name,
  v_amount
)
SELECT
  v_id,
  v_name,
  v_amount
FROM ${VIRTUAL_SOURCE}`;

test('BL-FLD-02-01｜字段血缘｜虚拟来源简单插入多字段直传', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(240_000);
  await runVirtualSourceFieldLineageCase(loginPage, consoleErrors, report, {
    caseNo: 'BL-FLD-02-01',
    reportTitle: '虚拟来源简单插入多字段直传',
    targetTable: TARGET,
    ddlColumns: 'v_id VARCHAR(64), v_name VARCHAR(128), v_amount VARCHAR(32)',
    sql: SQL,
    expectedNodes: [VIRTUAL_SOURCE, TARGET],
    virtualSourceTables: [VIRTUAL_SOURCE],
    relations: [
      { targetField: 'v_id', sources: [{ table: VIRTUAL_SOURCE, field: 'v_id' }] },
      { targetField: 'v_name', sources: [{ table: VIRTUAL_SOURCE, field: 'v_name' }] },
      { targetField: 'v_amount', sources: [{ table: VIRTUAL_SOURCE, field: 'v_amount' }] },
    ],
  });
});
