import { test } from '../utils.js';
import { assertNoUnexpectedLineageConsoleErrors, configureExistingLineageStatement, expectLineage, openTableLineage } from './血缘测试工具.js';
import { gbaseSplitLineageCases } from './GBase拆分血缘用例.js';

test.describe.configure({ timeout: 240_000 });
// 2026-09-05：已用同源/目标夹具验证最简单 INSERT…SELECT，图谱仍不返回来源表。
// 不能以删去来源节点断言替代，待 GBase 解析链路修复后复测。

test("BL-04-01-02｜GBase 44列 INSERT 直投", async ({ loginPage, consoleErrors, report }) => {
  const item = gbaseSplitLineageCases["BL-04-01-02"];
  await configureExistingLineageStatement(loginPage, item);
  await openTableLineage(loginPage, item.targetTable);
  await expectLineage(loginPage, item);
  await assertNoUnexpectedLineageConsoleErrors(consoleErrors);
  await report("GBase血缘解析-BL-04-01-02", true, `GBase A 过程的 44 列 INSERT 表级血缘\n实际提交 SQL：\n${item.sql}`);
});
