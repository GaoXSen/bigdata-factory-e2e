/**
 * BL-FLD-01-05｜字段血缘｜XLS 来源同名五字段直传。
 *
 * 依赖 BL-FLD-00-04 建好的 e2e_hn_fld_xls_src_0920（文件接入 xls 自动建表，MySQL 110）。
 * 验证 Excel 97-2003 接入来源在字段血缘图谱中与 CSV 基线行为一致。
 */
import { test } from '../utils.js';
import { runVirtualSourceFieldLineageCase } from './字段血缘语法用例工具.js';

// 2026-09-20（110 环境迁移）：来源/目标全部落在 MySQL 110（e2e_test），表名加 _0920。
const SOURCE = 'e2e_hn_fld_xls_src_0920';
const TARGET = 'e2e_hn_fld_xls_direct_target_0920';
const FIELDS = ['file_id', 'shared_key', 'file_name', 'file_amount', 'business_date'];
const SQL = `INSERT INTO ${TARGET} (${FIELDS.join(', ')})\nSELECT ${FIELDS.join(', ')} FROM ${SOURCE}`;
const DDL = 'file_id VARCHAR(64), shared_key VARCHAR(64), file_name VARCHAR(128), file_amount DECIMAL(18,2), business_date VARCHAR(32)';

test('BL-FLD-01-05｜字段血缘｜XLS 来源同名五字段直传', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(240_000);
  // 2026-09-17（闭环复测）：原 BUG-F01 跳过按任务约定复核移除（同 BL-FLD-01-04，
  // 兄弟用例 BL-FLD-01-00A 已通过），实测并按真实断言记录结果。
  await runVirtualSourceFieldLineageCase(loginPage, consoleErrors, report, {
    caseNo: 'BL-FLD-01-05',
    reportTitle: 'XLS来源同名五字段直传',
    targetTable: TARGET,
    ddlColumns: DDL,
    sql: SQL,
    expectedNodes: [SOURCE, TARGET],
    virtualSourceTables: [],
    dataSource: 'mysql',
    relations: FIELDS.map((field) => ({
      targetField: field,
      sources: [{ table: SOURCE, field }],
    })),
  });
});
