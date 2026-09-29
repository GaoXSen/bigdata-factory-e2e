import { test } from '../utils.js';
import { assertNoUnexpectedLineageConsoleErrors, configureExistingLineageStatement, expectLineage, openTableLineage } from './血缘测试工具.js';
import { gbaseSplitLineageCases } from './GBase拆分血缘用例.js';

test.describe.configure({ timeout: 240_000 });
// GBase 来源关系基础解析当前不可用，保留 SQL 等待解析链路修复后复测。

test("BL-04-02-05｜GBase MID03 临时表 JOIN", async ({ loginPage, consoleErrors, report }) => {
  const item = gbaseSplitLineageCases["BL-04-02-05"];
  await configureExistingLineageStatement(loginPage, item);
  await openTableLineage(loginPage, item.targetTable);
  await expectLineage(loginPage, item);
  await assertNoUnexpectedLineageConsoleErrors(consoleErrors);
  await report("GBase血缘解析-BL-04-02-05", true, `GBase B 过程 MID03 临时表 CTAS\n实际提交 SQL：\n${item.sql}`);
});
