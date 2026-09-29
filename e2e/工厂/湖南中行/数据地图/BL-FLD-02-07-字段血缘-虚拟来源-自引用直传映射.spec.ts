/**
 * BL-FLD-02-07｜字段血缘｜虚拟来源自引用直传映射。语法矩阵对齐表级 BL-02-07。
 *
 * 自引用语法的来源就是目标表自身（INSERT INTO t SELECT FROM t），
 * 因此本用例没有外部虚拟来源表；表级图谱仅要求目标表节点，
 * 字段级期望为“目标字段 <- 目标表自身同名字段”的自环关系。
 * 是否属于“虚拟来源”专项的归属问题按任务要求在最终报告中提出；
 * 本用例保持独立自环语义，不擅自改成普通简单插入。
 */
import { test } from '../utils.js';
import { runVirtualSourceFieldLineageCase } from './字段血缘语法用例工具.js';

const TARGET = 'e2e_hn_gbase_fld_vsql_self_target_v1';
const SQL = `INSERT INTO ${TARGET} (
  v_id,
  v_name
)
SELECT
  v_id,
  v_name
FROM ${TARGET}
WHERE v_id IS NOT NULL`;

test('BL-FLD-02-07｜字段血缘｜虚拟来源自引用直传映射', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(240_000);
  // 2026-09-17（闭环复测）：原 BUG-F02 跳过按任务约定复核移除，实测并按真实断言
  // 记录结果（表级自引用 BL-02-07 已通过，跳过可能已陈旧）；失败时在结果文件归类
  // 根因，不放宽字段断言。
  await runVirtualSourceFieldLineageCase(loginPage, consoleErrors, report, {
    caseNo: 'BL-FLD-02-07',
    reportTitle: '虚拟来源自引用直传映射',
    targetTable: TARGET,
    ddlColumns: 'v_id VARCHAR(64), v_name VARCHAR(128)',
    sql: SQL,
    expectedNodes: [TARGET],
    virtualSourceTables: [],
    relations: [
      { targetField: 'v_id', sources: [{ table: TARGET, field: 'v_id' }] },
      { targetField: 'v_name', sources: [{ table: TARGET, field: 'v_name' }] },
    ],
  });
});
