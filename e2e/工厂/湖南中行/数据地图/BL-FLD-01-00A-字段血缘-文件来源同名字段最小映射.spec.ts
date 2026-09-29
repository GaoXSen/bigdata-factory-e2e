/** BL-FLD-01-00A｜字段血缘｜同名字段直传解析基线。 */
import { test } from '../utils.js';
import {
  assertNoUnexpectedLineageConsoleErrors,
  configureAutoLineage,
  ensureFieldLineageTargetTable,
  expectLineage,
  openTableLineage,
} from './血缘测试工具.js';

// 2026-09-20（110 环境迁移）：来源/目标全部落在 MySQL 110（e2e_test），表名加 _0920。
const FILE_SOURCE = 'e2e_hn_fld_file_src_0920';
const TARGET = 'e2e_hn_fld_same_name_target_0920';
const SQL = `INSERT INTO ${TARGET} (file_id)\nSELECT file_id FROM ${FILE_SOURCE}`;

test('BL-FLD-01-00A｜字段血缘｜文件来源同名字段直传最小映射', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(120_000);
  await ensureFieldLineageTargetTable(loginPage, TARGET, 'file_id VARCHAR(64)', 'mysql');
  await configureAutoLineage(loginPage, {
    targetTable: TARGET,
    sql: SQL,
    expectedNodes: [FILE_SOURCE, TARGET],
    expectedRelations: [`${FILE_SOURCE}.file_id -> ${TARGET}.file_id`],
    dataSource: 'mysql',
  });
  await loginPage.waitForTimeout(1_000);
  await openTableLineage(loginPage, TARGET);
  await expectLineage(loginPage, { targetTable: TARGET, sql: SQL, expectedNodes: [FILE_SOURCE, TARGET] });
  assertNoUnexpectedLineageConsoleErrors(consoleErrors);
  await report('字段血缘-同名字段直传最小映射', true, `SQL=${SQL}`);
});
