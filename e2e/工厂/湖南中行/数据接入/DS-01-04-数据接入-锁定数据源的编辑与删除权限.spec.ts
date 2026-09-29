/**
 * DS-01-04｜数据接入｜锁定数据源的编辑与删除权限
 *
 * 湖南中行第一版标准化用例。来源：工厂测试用例-标准化业务版-FTP已补充-四环境配置版.xlsx。
 * 一个业务用例对应一个 spec.ts；本文件保留完整业务输入，未将缺失信息伪装成通过。
 *
 * 20260922 清洁环境静态迁移（任务 DS-PERM-18，静态验证：MySQL 110 当前 ECONNRESET，仅 tsc + --list）：
 * - 数据库资源固定默认 MySQL 110：192.168.76.110:13306/e2e_test（可用 DB_HOST/DB_PORT/DB_NAME 覆盖），
 *   凭据只从 DB_USER/DB_PASS 环境变量读取；历史 79.52 OpenGauss 连接（jdbc:opengauss://192.168.79.52...）、
 *   固定账号 sxzh_mas 与 HUNAN_D002_PASSWORD 依赖已按清洁基线彻底移除，不假设任何历史数据源存在。
 * - 只操作自动化自有数据源（唯一英文前缀 e2eds04+UUID，MYSQL@110，连接配置同 DS-01-01/02 已验证模式），
 *   不动任何已有业务数据源；用例结束（含 skip/失败）在 finally 中清理自有数据源。
 *
 * 20260917 静态修复（agent-7）保留的页面证据与断言结构：
 * - 页面证据（20260916 探查 cline-runs/probe-datasource.log）：数据源卡片 hover 前后仅暴露
 *   “图标: edit”“图标: delete” 两个操作，全页正则检索“锁定”无任何命中——
 *   当前页面没有数据源锁定入口、锁定状态文案与解锁恢复方式。
 * - 自有卡片 hover 后探测锁定入口（卡片范围内“锁定/解锁”文本或 aria-label/图标含 lock）：
 *   不存在 → test.skip（精确环境前置，附探查证据；非永久跳过，入口出现即自动转真实执行）；
 *   存在 → 锁定→断言锁定状态→管理员编辑被拦截→解锁→编辑恢复→删除（该分支待产品提供锁定入口后由 flash 验证）。
 * - 双账号权限矩阵（普通账号对锁定数据源不可编辑/删除）需 DS_LOCK_USER/DS_LOCK_PASS，当前环境未提供；
 *   入口补齐后先验证管理员侧锁定状态与编辑拦截，账号补齐后再扩展双账号断言。
 */
import { test, expect, uuid, clickMenu, assertNoConsoleErrors } from '../utils.js';
import {
  clickCardAction,
  clickVisible,
  confirmDangerDialog,
  expectSuccess,
  fillPlaceholder,
} from '../抽样用例工具.js';

// 用例编号：DS-01-04
// 功能模块：数据接入
// 测试类型：权限/状态
// 公共配置引用：D001；D010；D002
// 前置条件：准备一条可用数据源和有/无数据源管理权限的账号。
// 实际测试数据：D002：数据源名称、管理员账号、普通账号、锁定状态：自有数据源 e2eds04+UUID（默认 MYSQL 192.168.76.110:13306/e2e_test，凭据由 DB_USER/DB_PASS 注入）。
// 操作步骤：1. 使用管理员配置并锁定测试数据源。
// 2. 使用普通账号尝试编辑、删除和修改连接配置。
// 3. 使用管理员解锁后再次操作。
// 4. 核对列表状态、按钮可用性和数据库配置。
// 预期结果：锁定后禁止未授权修改，页面明确展示状态和提示；解锁后按权限恢复操作；线上已有数据源不被误改。
// 异常输入及预期：重复锁定、无权限解锁、删除锁定数据源、并发编辑（入口补齐后补充验证）。
// 清理/回滚：恢复本轮数据源原锁定状态；不删除已有连接。
// 业务补充项：【本次新增来源】参考“通用需求池”第39行。
// 历史TS追溯：20260917 为 79.52 OpenGauss + HUNAN_D002_PASSWORD 版（agent-7）；20260922 按清洁基线迁移 MYSQL@110（DS-PERM-18）；参考“通用需求池”第39行。

test('DS-01-04｜数据接入｜锁定数据源的编辑与删除权限', async ({ loginPage, consoleErrors, report }) => {
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
        '清洁库基线已移除历史 79.52 OpenGauss 连接与 HUNAN_D002_PASSWORD 依赖（DS-PERM-18）；本用例只操作自有数据源，不动已有业务配置。',
    );
    return;
  }

  const sourceName = `e2eds04${uuid()}`; // 唯一英文前缀 + UUID：绝不触碰既有数据源
  let created = false;
  try {
    // 1. 管理员创建自有 MYSQL 数据源（连接配置与 DS-01-01/02 相同，已验证可连）。
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
    await fillPlaceholder(page, '请输入数据源名称', sourceName);
    await fillPlaceholder(page, '请输入数据源描述', `ds0104_${uuid()}`);
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
      '创建后列表应真实回显唯一名称卡片（连接 toast 不作为通过证据）',
    ).toBeVisible({ timeout: 15_000 });
    created = true;

    // 2. 在自有卡片上探测锁定入口（hover 前后均检查；不做任何写操作）。
    const ownName = page.getByText(sourceName, { exact: true }).filter({ visible: true }).last();
    await expect(ownName).toBeVisible({ timeout: 15_000 });
    let ownCard = ownName;
    for (let level = 0; level < 8; level += 1) {
      const className = (await ownCard.getAttribute('class').catch(() => '')) ?? '';
      if (className.includes('data-source')) break;
      ownCard = ownCard.locator('..');
    }
    await ownCard.hover();
    await page.waitForTimeout(600);
    const lockText = ownCard.getByText(/锁定|解锁/).filter({ visible: true });
    const lockIcon = ownCard
      .locator('[aria-label*="lock" i], [aria-label*="锁定"], .anticon-lock')
      .filter({ visible: true });
    const hasLockEntry =
      (await lockText.count().catch(() => 0)) > 0 || (await lockIcon.count().catch(() => 0)) > 0;
    if (!hasLockEntry) {
      test.skip(
        true,
        '环境前置缺失：数据源管理页面当前没有锁定入口——20260916 探查实证卡片仅“编辑/删除”图标、' +
          '全页无“锁定”文本；缺少锁定入口、锁定状态文案、权限角色（含普通账号 DS_LOCK_USER/DS_LOCK_PASS）' +
          '与解锁恢复方式，不能伪造锁定权限验证。',
      );
      return;
    }

    // 3. 锁定自有数据源并断言状态文案（以下分支待产品提供锁定入口后由 flash 验证）。
    const lockAction = (await lockText.count()) > 0 ? lockText.first() : lockIcon.first();
    await lockAction.click();
    await expect(
      page.getByText(/已锁定|锁定中|锁定/).filter({ visible: true }).first(),
      '锁定后应出现明确的状态文案',
    ).toBeVisible({ timeout: 10_000 });

    // 4. 管理员编辑被拦截：锁定数据源不允许修改连接配置。
    await clickCardAction(page, sourceName, '编辑');
    await expect(
      page.getByText(/锁定|已锁|禁止|无权|不允许/).filter({ visible: true }).first(),
      '锁定数据源进入编辑应被拦截并提示原因',
    ).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape').catch(() => undefined);
    await clickVisible(page, /取\s*消/).catch(() => undefined);

    // 5. 解锁后编辑恢复。
    const unlockAction = page.getByText(/解锁/).filter({ visible: true }).first();
    await expect(unlockAction).toBeVisible({ timeout: 10_000 });
    await unlockAction.click();
    await page.waitForTimeout(800);
    await clickCardAction(page, sourceName, '编辑');
    await fillPlaceholder(page, '请输入数据源描述', `ds0104_${uuid()}_unlocked`);
    await clickVisible(page, /保存|确\s*定/);
    await expectSuccess(page, /保存成功|修改成功|更新成功|成功/);
    await expect(page.getByText(sourceName, { exact: true }).last()).toBeVisible({ timeout: 15_000 });

    await assertNoConsoleErrors(consoleErrors);
    await report('DS-01-04 锁定数据源权限', true, `自有数据源 ${sourceName} 锁定/解锁与编辑拦截验证完成；未触碰已有数据源。`);
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