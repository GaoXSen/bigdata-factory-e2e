/**
 * BL-FLD-02-08｜字段血缘｜虚拟来源 CTAS 建表映射。语法矩阵对齐表级 BL-02-08。
 *
 * 沿用 BL-02-08 模式：目标表已由前置建表并上线，任务调度中的 CTAS 语句
 * 只作为血缘解析器输入（解析不执行 SQL）；验证解析器能否从 CREATE TABLE … AS
 * SELECT 中建立“虚拟来源表 -> 目标表”的字段级映射（含 AS 别名重命名）。
 * 若解析器在目标表已物理存在时拒绝 CTAS 输入，用例按实际结果失败并归因，
 * 保留该失败风险，不为了通过改写语法。
 */
import { test } from '../utils.js';
import { runVirtualSourceFieldLineageCase } from './字段血缘语法用例工具.js';

const VIRTUAL_SOURCE = 'e2e_hn_fld_vsql_ctas_src_v1';
const TARGET = 'e2e_hn_gbase_fld_vsql_ctas_target_v1';
const SQL = `CREATE TABLE ${TARGET} AS
SELECT
  v_id AS out_id,
  v_name
FROM ${VIRTUAL_SOURCE}`;

test('BL-FLD-02-08｜字段血缘｜虚拟来源CTAS建表映射', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(240_000);
  // 2026-09-17（闭环复测）：原 BUG-F02 跳过按任务约定复核移除，实测并按真实断言
  // 记录结果；失败时在结果文件归类根因，不放宽字段断言。
  await runVirtualSourceFieldLineageCase(loginPage, consoleErrors, report, {
    caseNo: 'BL-FLD-02-08',
    reportTitle: '虚拟来源CTAS建表映射',
    targetTable: TARGET,
    ddlColumns: 'out_id VARCHAR(64), v_name VARCHAR(128)',
    sql: SQL,
    expectedNodes: [VIRTUAL_SOURCE, TARGET],
    virtualSourceTables: [VIRTUAL_SOURCE],
    relations: [
      // CTAS 的字段血缘必须按 AS 别名建立映射：out_id <- src.v_id（异名），
      // v_name <- src.v_name（同名直传）。
      { targetField: 'out_id', sources: [{ table: VIRTUAL_SOURCE, field: 'v_id' }] },
      { targetField: 'v_name', sources: [{ table: VIRTUAL_SOURCE, field: 'v_name' }] },
    ],
  });
});
