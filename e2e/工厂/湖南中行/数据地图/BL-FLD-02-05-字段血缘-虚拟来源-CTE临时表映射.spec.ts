/**
 * BL-FLD-02-05｜字段血缘｜虚拟来源 CTE 临时表映射。语法矩阵对齐表级 BL-02-05。
 *
 * 血缘解析器的 CTE 语法按项目 Java 基准写为 INSERT INTO … WITH … SELECT；
 * 不能把 WITH 放在整条 DML 最前面，否则解析器不会建立来源表关系。
 * CTE 临时名 tmp 也必须列入 virtualSourceTables，否则前置逻辑会把它
 * 误当成缺失物理表去创建。
 */
import { test } from '../utils.js';
import { runVirtualSourceFieldLineageCase } from './字段血缘语法用例工具.js';

const VIRTUAL_SOURCE = 'e2e_hn_fld_vsql_cte_src_v1';
const TARGET = 'e2e_hn_gbase_fld_vsql_cte_target_v1';
const SQL = `INSERT INTO ${TARGET} (
  v_id,
  total
)
WITH tmp AS (
  SELECT v_id, SUM(v_amount) AS total FROM ${VIRTUAL_SOURCE} GROUP BY v_id
)
SELECT
  v_id,
  total
FROM tmp`;

test('BL-FLD-02-05｜字段血缘｜虚拟来源CTE临时表映射', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(240_000);
  // 2026-09-17（闭环复测）：原 BUG-F02 跳过按任务约定复核移除，实测并按真实断言
  // 记录结果；失败时在结果文件归类根因，不放宽字段断言。
  await runVirtualSourceFieldLineageCase(loginPage, consoleErrors, report, {
    caseNo: 'BL-FLD-02-05',
    reportTitle: '虚拟来源CTE临时表映射',
    targetTable: TARGET,
    ddlColumns: 'v_id VARCHAR(64), total VARCHAR(32)',
    sql: SQL,
    expectedNodes: [VIRTUAL_SOURCE, TARGET],
    virtualSourceTables: [VIRTUAL_SOURCE, 'tmp'],
    relations: [
      // 期望字段血缘穿透 CTE：外层 v_id <- src.v_id；聚合列 total <- src.v_amount。
      // 若当前解析器不支持 CTE 字段穿透，用例按实际结果失败并归因，不放宽断言。
      { targetField: 'v_id', sources: [{ table: VIRTUAL_SOURCE, field: 'v_id' }] },
      { targetField: 'total', sources: [{ table: VIRTUAL_SOURCE, field: 'v_amount' }] },
    ],
  });
});
