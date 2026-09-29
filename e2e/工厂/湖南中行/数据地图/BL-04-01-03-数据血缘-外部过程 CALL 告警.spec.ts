import { test } from '../utils.js';
import { assertNoUnexpectedLineageConsoleErrors, configureExistingLineageStatement, expectLineage, openTableLineage } from './血缘测试工具.js';
import { gbaseSplitLineageCases } from './GBase拆分血缘用例.js';

test.describe.configure({ timeout: 240_000 });
// GBase 来源关系基础解析当前不可用；外部过程告警待该解析链路修复后统一复测。

test("BL-04-01-03｜GBase 外部过程 CALL 告警", async ({ loginPage, consoleErrors, report }) => {
  const item = gbaseSplitLineageCases["BL-04-01-03"];
  await configureExistingLineageStatement(loginPage, item);
  await openTableLineage(loginPage, item.targetTable);
  await expectLineage(loginPage, item);
  await assertNoUnexpectedLineageConsoleErrors(consoleErrors);
  await report("GBase血缘解析-BL-04-01-03", true, `GBase A 过程外部 CALL 不生成虚假表节点\n实际提交 SQL：\n${item.sql}`);
});
