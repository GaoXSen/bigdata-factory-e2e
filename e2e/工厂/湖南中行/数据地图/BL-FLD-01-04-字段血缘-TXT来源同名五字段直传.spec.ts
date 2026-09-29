/**
 * BL-FLD-01-04｜字段血缘｜TXT 来源同名五字段直传。
 *
 * 依赖 BL-FLD-00-03 建好的 e2e_hn_fld_txt_src_0920（文件接入 txt 自动建表，MySQL 110）。
 * 验证 txt 接入来源在字段血缘图谱中与 CSV 基线（BL-FLD-01-00A）行为一致：
 * 表级节点 + 五个同名字段的“SQL自动解析”边。
 */
import { test } from '../utils.js';
import { runVirtualSourceFieldLineageCase } from './字段血缘语法用例工具.js';

// 2026-09-20（110 环境迁移）：来源/目标全部落在 MySQL 110（e2e_test），表名加 _0920。
const SOURCE = 'e2e_hn_fld_txt_src_0920';
const TARGET = 'e2e_hn_fld_txt_direct_target_0920';
const FIELDS = ['file_id', 'shared_key', 'file_name', 'file_amount', 'business_date'];
const SQL = `INSERT INTO ${TARGET} (${FIELDS.join(', ')})\nSELECT ${FIELDS.join(', ')} FROM ${SOURCE}`;
const DDL = 'file_id VARCHAR(64), shared_key VARCHAR(64), file_name VARCHAR(128), file_amount DECIMAL(18,2), business_date VARCHAR(32)';

test('BL-FLD-01-04｜字段血缘｜TXT 来源同名五字段直传', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(240_000);
  // 2026-09-17（闭环复测）：原 BUG-F01 跳过（09-11 记录文件接入来源字段详情无上游
  // 字段区块）按任务约定复核——同链路 BL-FLD-01-00A（CSV 文件来源）字段级断言已在
  // 基线 run-20260916-173034 通过，跳过疑似陈旧；移除后实测并按真实断言记录结果。
  await runVirtualSourceFieldLineageCase(loginPage, consoleErrors, report, {
    caseNo: 'BL-FLD-01-04',
    reportTitle: 'TXT来源同名五字段直传',
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
