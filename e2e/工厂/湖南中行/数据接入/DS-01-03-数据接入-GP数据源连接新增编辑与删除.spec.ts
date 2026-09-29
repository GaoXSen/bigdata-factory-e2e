/**
 * DS-01-03｜数据接入｜数据源连接、新增、编辑与删除（MYSQL@110 清洁基线）
 *
 * 湖南中行第一版标准化用例。来源：工厂测试用例-标准化业务版-FTP已补充-四环境配置版.xlsx / DS-01-03。
 * 一个业务用例对应一个 spec.ts；本文件保留完整业务输入，未将缺失信息伪装成通过。
 *
 * 20260922 清洁环境静态迁移（任务 DS-PERM-18，静态验证：MySQL 110 当前 ECONNRESET，仅 tsc + --list）：
 * - 数据库资源固定默认 MySQL 110：192.168.76.110:13306/e2e_test（可用 DB_HOST/DB_PORT/DB_NAME 覆盖）；
 *   凭据只从 DB_USER/DB_PASS 环境变量读取，缺失时明确 skip，不在代码中写死（资源/当前测试环境基线.md）。
 * - 移除历史遗留依赖：GP_DRIVER/GP_JDBC_URL/GP_USERNAME/GP_PASSWORD 门控与 GP 类型入口探测
 *   （页面数据源类型全集 DM/GAUSSDBM/GBASE8A/HIVE/MYSQL/ORACLE11G/POSTGRESQL 无 GP，20260916 探查证据；
 *   原 GP 门控使本用例长期处于 skip）。同一 CRUD 断言链现运行于标准 MYSQL@110 基线；
 *   GP 驱动兼容性验证需真实 GP 环境恢复后另行回归，不在本用例伪造。
 * - 唯一资源由本用例页面流程创建（唯一英文前缀 e2eds03+UUID），不触碰任何既有数据源；
 *   用例结束（含失败）在 finally 中仅清理本用例自有名称对象。
 * - 业务断言保持：新增后列表唯一名称回显；编辑备注后真实回显并再次测试连接成功；删除后唯一名称从列表消失。
 */
import { test, expect, uuid, clickMenu, assertNoConsoleErrors } from '../utils.js';
import {
  clickCardAction,
  clickVisible,
  confirmDangerDialog,
  expectSuccess,
  fillPlaceholder,
} from '../抽样用例工具.js';

// 用例编号：DS-01-03
// 功能模块：数据接入
// 测试类型：兼容性
// 公共配置引用：D001；D010；D002
// 前置条件：准备可用 MySQL 110 连接账号（DB_USER/DB_PASS 环境变量注入）。
// 实际测试数据：D002：MYSQL 连接（默认 192.168.76.110:13306/e2e_test，DB_HOST/DB_PORT/DB_NAME 可覆盖）、唯一名称 e2eds03+UUID、描述 ds0103_+UUID。
// 操作步骤：1. 进入数据源管理并新增 MYSQL 数据源。
// 2. 填写驱动、地址、端口、数据库、Schema、账号和密码。
// 3. 点击连接测试并保存。
// 4. 查询、编辑备注、再次测试连接。
// 5. 删除本轮数据源并确认已有连接不受影响。
// 预期结果：MYSQL 数据源字段可填写，连接测试和保存成功；列表、编辑和删除结果正确；已有数据源不受影响。
// 异常输入及预期：驱动为空、URL 错误、端口错误、账号无权限、重复名称。
// 清理/回滚：删除本轮 MYSQL 数据源，不删除数据库、表和数据。
// 业务补充项：【本次新增来源】参考“通用需求池”第2行。
// 历史TS追溯：20260917 为 GP 环境门控版（agent-7）；20260922 按清洁基线迁移 MYSQL@110（DS-PERM-18）；参考“通用需求池”第2行。
test('DS-01-03｜数据接入｜MYSQL 数据源连接、新增、编辑与删除', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(240_000);
  const page = loginPage;

  // ---------- 环境前置：默认 MySQL 110（192.168.76.110:13306/e2e_test）；凭据仅由环境注入 ----------
  const dbHost = (process.env.DB_HOST ?? '192.168.76.110').trim();
  const dbPort = (process.env.DB_PORT ?? '13306').trim();
  const dbName = (process.env.DB_NAME ?? 'e2e_test').trim();
  const dbUser = (process.env.DB_USER ?? '').trim();
  const dbPass = process.env.DB_PASS ?? '';
  if (!dbUser || !dbPass) {
    test.skip(
      true,
      '环境前置条件缺失：未提供 DB_USER/DB_PASS（MySQL 110 连接账号）。' +
        '清洁库基线不依赖历史数据源（GP_* 门控与历史固定凭据已按 DS-PERM-18 移除），本用例拒绝在无凭据时伪造连接与 CRUD 结果。',
    );
    return;
  }

  const sourceName = `e2eds03${uuid()}`; // 唯一英文前缀 + UUID：绝不触碰既有数据源
  const sourceDescription = `ds0103_${uuid()}`;
  const sourceDescriptionAfter = `${sourceDescription}_edit`;
  let created = false;
  try {
    // 1. 新增 MYSQL 数据源：类型卡片必须先用内置搜索过滤（首屏卡片不暴露类型文本，DS-01-01/02 已验证）。
    await clickMenu(page, '数据接入', '数据源管理');
    await clickVisible(page, /添加数据源|新增数据源/, { timeoutMs: 15_000 });
    const typeDialog = page.getByRole('dialog', { name: '添加数据源' }).last();
    await expect(typeDialog).toBeVisible({ timeout: 10_000 });
    const typeSearch = typeDialog.getByPlaceholder('请输入关键字搜索');
    if (await typeSearch.isVisible().catch(() => false)) {
      await typeSearch.fill('MYSQL');
      await clickVisible(typeDialog, /搜\s*索|图标:\s*search/).catch(() => undefined);
    }
    await clickVisible(typeDialog, 'MYSQL', { timeoutMs: 5_000 });
    await clickVisible(typeDialog, '下一步');

    // 2. 填写连接信息并测试连接、保存。
    await fillPlaceholder(page, '请输入数据源名称', sourceName);
    await fillPlaceholder(page, '请输入数据源描述', sourceDescription);
    const driverField = page.getByPlaceholder('请输入驱动类', { exact: true }).last();
    if (await driverField.isVisible().catch(() => false)) {
      await driverField.fill('com.mysql.cj.jdbc.Driver');
    }
    await fillPlaceholder(
      page,
      '请输入链接地址',
      `jdbc:mysql://${dbHost}:${dbPort}/${dbName}?useUnicode=true&characterEncoding=utf-8&useSSL=false&serverTimezone=Asia/Shanghai`,
    );
    await fillPlaceholder(page, '请输入用户名', dbUser);
    await fillPlaceholder(page, '请输入密码', dbPass);
    await clickVisible(page, '测试连接');
    await expectSuccess(page, /连接成功|测试成功|成功/);
    await clickVisible(page, /确\s*定/);
    await expect(
      page.getByText(sourceName, { exact: true }).filter({ visible: true }).first(),
      '新增后列表应真实回显唯一名称卡片（连接 toast 不作为通过证据）',
    ).toBeVisible({ timeout: 15_000 });
    created = true;

    // 3. 查询、编辑备注、再次测试连接：以表单关闭与页面真实回显为保存证据，不以 toast 单独判定。
    await clickCardAction(page, sourceName, '编辑');
    const editDescField = page.getByPlaceholder('请输入数据源描述', { exact: true }).last();
    await expect(editDescField, '编辑弹窗应回显数据源描述输入框').toBeVisible({ timeout: 10_000 });
    await editDescField.fill(sourceDescriptionAfter);
    await clickVisible(page, '测试连接');
    await expectSuccess(page, /连接成功|测试成功|成功/);
    await clickVisible(page, /保存|确\s*定/);
    await expect(editDescField, '保存后编辑弹窗应关闭').toBeHidden({ timeout: 10_000 });
    await expectSuccess(page, /保存成功|修改成功|更新成功|成功/).catch(() => undefined);
    await expect(
      page.getByText(sourceName, { exact: true }).filter({ visible: true }).first(),
      '编辑保存后数据源应仍在列表回显',
    ).toBeVisible({ timeout: 15_000 });
    const editedOnCard = page.getByText(sourceDescriptionAfter, { exact: true }).filter({ visible: true });
    if ((await editedOnCard.count()) > 0) {
      await expect(editedOnCard.first(), '编辑后的新描述应在卡片上真实回显').toBeVisible({ timeout: 15_000 });
    } else {
      // 卡片不渲染描述文本时：重新打开编辑弹窗，以表单回显值证明新描述已真实保存。
      await clickCardAction(page, sourceName, '编辑');
      const echoField = page.getByPlaceholder('请输入数据源描述', { exact: true }).last();
      await expect(echoField, '编辑弹窗应回显已保存的新描述').toBeVisible({ timeout: 10_000 });
      await expect(echoField).toHaveValue(sourceDescriptionAfter, { timeout: 10_000 });
      try {
        await clickVisible(page, /取\s*消/);
      } catch {
        await page.keyboard.press('Escape').catch(() => undefined);
      }
      await expect(echoField).toBeHidden({ timeout: 10_000 });
    }

    // 4. 删除本轮数据源（只删除本用例 UUID 数据源，不触碰已有连接）。
    await clickCardAction(page, sourceName, '删除');
    await confirmDangerDialog(page);
    await expectSuccess(page, /删除成功|移除成功|操作成功|成功/);
    await expect(
      page.getByText(sourceName, { exact: true }),
      '删除后唯一名称应从列表消失（已有数据源不受影响）',
    ).toHaveCount(0, { timeout: 15_000 });
    created = false;

    await assertNoConsoleErrors(consoleErrors);
    await report(
      'DS-01-03 数据源 CRUD',
      true,
      `MYSQL@110 数据源 ${sourceName} 新增/编辑/删除闭环完成，未触碰已有数据源。`,
    );
  } finally {
    if (created) {
      await page.keyboard.press('Escape').catch(() => undefined);
      await clickMenu(page, '数据接入', '数据源管理').catch(() => undefined);
      await clickCardAction(page, sourceName, '删除').catch(() => undefined);
      await confirmDangerDialog(page).catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }
});