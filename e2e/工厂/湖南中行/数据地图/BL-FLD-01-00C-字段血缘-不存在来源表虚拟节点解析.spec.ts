/** BL-FLD-01-00C｜字段血缘｜不存在来源表写入 GBase 目标表仍应生成虚拟表级节点。 */
import { test } from '../utils.js';
import {
  assertNoUnexpectedLineageConsoleErrors,
  configureAutoLineage,
  ensureFieldLineageTargetTable,
  expectLineage,
  openTableLineage,
} from './血缘测试工具.js';

// 该来源表故意不存在于任何已登记数据源，也不在表管理中创建；目标表使用 GBase。
// 仅验证解析器是否按 SQL 文本保留“虚拟来源表 -> 目标表”的表级关系。
const VIRTUAL_SOURCE = 'e2e_hn_fld_virtual_missing_source_v1';
const TARGET = 'e2e_hn_gbase_fld_virtual_target_v1';
const SQL = `INSERT INTO ${TARGET} (file_id)\nSELECT file_id FROM ${VIRTUAL_SOURCE}`;

test('BL-FLD-01-00C｜字段血缘｜不存在来源表仍解析虚拟表级血缘', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(120_000);
  await ensureFieldLineageTargetTable(loginPage, TARGET, 'file_id VARCHAR(64)', 'gbase');
  await configureAutoLineage(loginPage, {
    targetTable: TARGET,
    sql: SQL,
    expectedNodes: [VIRTUAL_SOURCE, TARGET],
    virtualSourceTables: [VIRTUAL_SOURCE],
    dataSource: 'gbase',
  });
  // 当前环境的解析是异步回写，但通常 1 秒内可见；不以固定长等待掩盖解析失败。
  await loginPage.waitForTimeout(1_000);
  await openTableLineage(loginPage, TARGET);
  await expectLineage(loginPage, {
    targetTable: TARGET,
    sql: SQL,
    expectedNodes: [VIRTUAL_SOURCE, TARGET],
  });
  assertNoUnexpectedLineageConsoleErrors(consoleErrors);
  await report('字段血缘-不存在来源表虚拟节点解析', true, `SQL=${SQL}`);
});
