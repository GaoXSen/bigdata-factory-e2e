/**
 * DS-01-01｜数据接入｜数据源新增、查询、编辑、查询、删除闭环
 *
 * 来源：工厂测试用例-标准化业务版-湖南中行-数据地图闭环固化版.xlsx / DS-01-01。
 * 20260922 清洁环境基线重构（任务 DS-PERM-06）：
 * - 数据库资源固定 MySQL 110；不再使用历史 79.52 OpenGauss、
 *   HUNAN_D002_PASSWORD 或任何历史遗留数据源；连接信息缺失时明确 skip，不伪造。
 * - 唯一资源由本用例页面流程创建（唯一英文前缀 e2eds01+UUID），用例结束（含失败）在 finally 清理。
 * - 新增/编辑/删除均以列表真实可见结果断言：新增后唯一名称卡片回显；编辑后新描述真实回显
 *   （卡片渲染描述文本时直接断言，否则以重新打开的编辑表单回显值为证据）；删除后唯一名称
 *   与新描述从列表消失。连接/保存 toast 仅作流程中间信号，绝不替代结果断言。
 * - 名称查询：列表页提供查询输入控件时按唯一名称过滤并断言唯一卡片；当前构建未提供时
 *  （DS-PERM-01 三轮 input/button 枚举证据一致）以唯一名称卡片真实回显作为查询结果断言，
 *   并以 blocking annotation 记录控件缺失，不伪造查询控件或接口证据。
 * 20260922 清洁环境迁移（任务 DS-PERM-57）：
 * - 主库物理连接改经 '../utils.js' 的 dbConfig() 取得（内部即 e2e/test-environment.ts
 *   配置中心：profile mysql110-ftp113 基线 + DB_* 兼容变量单项覆盖，凭据仅来自进程
 *   环境变量；硬链接双路径下两份 utils 镜像同构，spec 不直接 import 配置中心）；
 *   spec 内不持有 host/port/帐号/口令兜底；finally 清理仍仅限本轮创建的数据源。
 */
import { assertNoConsoleErrors, clickMenu, dbConfig, expect, test, uuid } from '../utils.js';
import {
  clickCardAction,
  clickVisible,
  confirmDangerDialog,
  expectSuccess,
  fillPlaceholder,
} from '../抽样用例工具.js';
import type { Locator } from '@playwright/test';

test('DS-01-01｜数据源新增、查询、编辑、查询、删除闭环', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(240_000);
  const page = loginPage;

  // ---------- 环境前置：主库物理连接经 dbConfig()（e2e/test-environment.ts 配置中心）解析；缺失时明确 skip ----------
  const primaryDb = dbConfig();
  if (!primaryDb || !primaryDb.host || !primaryDb.database || !primaryDb.user || !primaryDb.password) {
    test.skip(
      true,
      '环境前置条件缺失：dbConfig() 未能解析出完整主库连接（host/database/user/password；' +
        '内部经 e2e/test-environment.ts 配置中心按 profile mysql110-ftp113 基线解析，' +
        '凭据仅来自 DB_USER/DB_PASS 等进程环境变量）。' +
        '清洁库基线不允许依赖历史数据源，本用例拒绝在无可用连接信息时伪造 CRUD 结果。',
    );
    return;
  }
  const dbHost = primaryDb.host;
  const dbPort = String(primaryDb.port);
  const dbUser = primaryDb.user;
  const dbPass = primaryDb.password;
  const dbName = primaryDb.database;

  const sourceName = `e2eds01${uuid()}`; // 唯一英文前缀 + UUID：绝不触碰既有数据源
  const descriptionBefore = `ds0101_${uuid()}`;
  const descriptionAfter = `${descriptionBefore}_edit`;
  let created = false;
  let deleted = false;
  let queryControlMissingNoted = false;

  /** 列表页名称查询输入框；排除弹窗内输入框并要求稳定可见，当前构建未提供时返回 null。 */
  async function findListSearchInputOrNull(): Promise<Locator | null> {
    const patterns = [/请输入(数据源)?名称/, /名称/, /关键字|关键词/, /搜索|search/i];
    for (const pattern of patterns) {
      const candidate = page.getByPlaceholder(pattern).filter({ visible: true }).first();
      if (!(await candidate.isVisible().catch(() => false))) continue;
      // 排除新增/编辑弹窗内的搜索框（如类型弹窗“请输入关键字搜索”）：仅当输入框不在任何 dialog 内才算列表控件。
      const insideDialog = await candidate
        .evaluate((el) => Boolean(el.closest('[role="dialog"]')))
        .catch(() => true);
      if (insideDialog) continue;
      // 稳定性双检：列表刷新/弹窗关闭动画期间可能瞬时可见，间隔后仍可见才采用。
      await page.waitForTimeout(400);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      return candidate;
    }
    return null;
  }

  async function triggerSearch(input: Locator): Promise<void> {
    const button = page
      .getByRole('button', { name: /^\s*(查\s*询|搜\s*索)\s*$/ })
      .filter({ visible: true })
      .first();
    if (await button.isVisible().catch(() => false)) {
      await button.click();
    } else {
      await input.press('Enter');
    }
  }

  /**
   * 唯一名称查询：列表提供查询控件时按名称过滤、断言唯一卡片后恢复列表；
   * 控件缺失或不可用（含瞬时可见导致的查找失败）时，以唯一名称卡片真实回显
   * 作为查询结果断言，并记录一次说明，不伪造查询控件或接口证据。
   */
  async function queryUniqueSource(step: string): Promise<void> {
    let usedSearch = false;
    try {
      const searchInput = await findListSearchInputOrNull();
      if (searchInput) {
        await searchInput.fill(sourceName, { timeout: 5_000 });
        await triggerSearch(searchInput);
        usedSearch = true;
      }
    } catch (controlError) {
      const reason = controlError instanceof Error ? controlError.message.split('\n')[0] : String(controlError);
      console.warn(`[DS-01-01] ${step}：列表查询控件不可用（${reason}），回退为唯一名称回显断言。`);
    }
    if (!usedSearch && !queryControlMissingNoted) {
      queryControlMissingNoted = true;
      test.info().annotations.push({
        type: 'blocking',
        description:
          '数据源列表页未提供可用的名称查询输入控件（与 DS-PERM-01 三轮控件枚举证据一致），' +
          '“查询”步骤以唯一名称卡片真实回显作为结果断言，未伪造查询控件或接口证据。',
      });
    }
    const nameText = page.getByText(sourceName, { exact: true }).filter({ visible: true });
    await expect(nameText.first(), `${step}：唯一名称应真实回显`).toBeVisible({ timeout: 15_000 });
    await expect(nameText, `${step}：唯一名称应仅对应一张卡片`).toHaveCount(1);
    if (usedSearch) {
      try {
        const searchInput = await findListSearchInputOrNull();
        if (searchInput) {
          await searchInput.fill('', { timeout: 5_000 });
          await triggerSearch(searchInput);
        }
      } catch (restoreError) {
        const reason = restoreError instanceof Error ? restoreError.message.split('\n')[0] : String(restoreError);
        console.warn(`[DS-01-01] ${step}：查询条件恢复失败（不影响断言结果）：${reason}`);
      }
    }
  }

  /** 删除本用例唯一数据源：危险确认 + 唯一名称与新描述从列表消失（真实结果断言）。 */
  async function deleteOwnSource(): Promise<void> {
    await page.keyboard.press('Escape').catch(() => undefined);
    await clickMenu(page, '数据接入', '数据源管理').catch(() => undefined);
    await clickCardAction(page, sourceName, '删除');
    await confirmDangerDialog(page);
    await expect(
      page.getByText(sourceName, { exact: true }).filter({ visible: true }),
      '删除后唯一名称应从列表消失',
    ).toHaveCount(0, { timeout: 15_000 });
    await expect(
      page.getByText(descriptionAfter, { exact: true }).filter({ visible: true }),
      '删除后新描述应从列表消失',
    ).toHaveCount(0, { timeout: 15_000 });
    // 删除 toast 仅作辅助信号：删除结果已由“列表消失”硬断言决定。
    await expectSuccess(page, /删除成功|移除成功|操作成功|成功/).catch(() => undefined);
  }

  try {
    // 1. 进入 数据接入→数据源管理，以“添加数据源”入口可见作为列表加载完成标志。
    await clickMenu(page, '数据接入', '数据源管理');
    const addEntry = page
      .getByRole('button', { name: /添加数据源|新增数据源/ })
      .filter({ visible: true })
      .first();
    await expect(addEntry, '数据源管理列表应出现“添加数据源”入口').toBeVisible({ timeout: 15_000 });

    // 2. 新增 MYSQL@110 自有数据源：类型选择→表单→测试连接→确定（全页面操作）。
    await addEntry.click();
    const typeDialog = page.getByRole('dialog', { name: /添加数据源|新增数据源/ }).last();
    await expect(typeDialog, '点击后应弹出数据源类型选择弹窗').toBeVisible({ timeout: 10_000 });
    const typeSearch = typeDialog.getByPlaceholder('请输入关键字搜索');
    if (await typeSearch.isVisible().catch(() => false)) {
      await typeSearch.fill('MYSQL');
      await clickVisible(typeDialog, /搜\s*索|图标:\s*search/).catch(() => undefined);
    }
    await clickVisible(typeDialog, 'MYSQL', { timeoutMs: 5_000 });
    await clickVisible(typeDialog, '下一步');
    await fillPlaceholder(page, '请输入数据源名称', sourceName);
    await fillPlaceholder(page, '请输入数据源描述', descriptionBefore);
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
    const createdCard = page.getByText(sourceName, { exact: true }).filter({ visible: true });
    await expect(
      createdCard.first(),
      '新增后列表应真实回显唯一名称卡片（连接 toast 不作为通过证据）',
    ).toBeVisible({ timeout: 15_000 });
    created = true;
    await report('新增数据源', true, `自有 MYSQL@110 数据源 ${sourceName} 创建成功并回显于列表。`);

    // 3. 唯一名称查询/回显。
    await queryUniqueSource('新增后查询');
    await report('新增后唯一名称查询', true, `唯一名称 ${sourceName} 查询/回显断言通过。`);

    // 4. 编辑描述：保存后以页面真实回显验证（卡片描述文本或编辑表单回显值）。
    await clickCardAction(page, sourceName, '编辑');
    const editDescField = page.getByPlaceholder('请输入数据源描述', { exact: true }).last();
    await expect(editDescField, '编辑弹窗应回显数据源描述输入框').toBeVisible({ timeout: 10_000 });
    await editDescField.fill(descriptionAfter);
    await clickVisible(page, /保存|确\s*定/);
    // 表单关闭是保存动作真实完成的可见信号（不以 toast 单独作为通过证据）。
    await expect(editDescField, '保存后编辑弹窗应关闭').toBeHidden({ timeout: 10_000 });
    await expectSuccess(page, /保存成功|修改成功|更新成功|成功/).catch(() => undefined);
    await expect(
      page.getByText(sourceName, { exact: true }).filter({ visible: true }).first(),
      '编辑保存后数据源应仍在列表回显',
    ).toBeVisible({ timeout: 15_000 });
    const editedOnCard = page.getByText(descriptionAfter, { exact: true }).filter({ visible: true });
    if ((await editedOnCard.count()) > 0) {
      await expect(editedOnCard.first(), '编辑后的新描述应在卡片上真实回显').toBeVisible({ timeout: 15_000 });
    } else {
      // 卡片不渲染描述文本时：重新打开编辑弹窗，以表单回显值证明新描述已真实保存。
      await clickCardAction(page, sourceName, '编辑');
      const echoField = page.getByPlaceholder('请输入数据源描述', { exact: true }).last();
      await expect(echoField, '编辑弹窗应回显已保存的新描述').toBeVisible({ timeout: 10_000 });
      await expect(echoField).toHaveValue(descriptionAfter, { timeout: 10_000 });
      try {
        await clickVisible(page, /取\s*消/);
      } catch {
        await page.keyboard.press('Escape').catch(() => undefined);
      }
      await expect(echoField).toBeHidden({ timeout: 10_000 });
    }
    await report('编辑描述', true, `描述已改为 ${descriptionAfter}，新描述已在页面真实回显。`);

    // 5. 再次唯一名称查询/回显。
    await queryUniqueSource('编辑后查询');

    // 6. 删除：危险确认后唯一名称与新描述从列表消失（真实结果断言）。
    await deleteOwnSource();
    deleted = true;
    await report('删除数据源', true, `唯一数据源 ${sourceName} 已删除并从列表消失。`);

    await assertNoConsoleErrors(consoleErrors);
    await report(
      'DS-01-01 数据源 CRUD 闭环',
      true,
      '新增→唯一名称查询/回显→编辑描述→再次回显→删除→列表消失 全部以页面真实可见结果验证（MySQL 110，自有资源已清理）。',
    );
  } finally {
    if (created && !deleted) {
      try {
        await deleteOwnSource();
      } catch (cleanupError) {
        const remaining = await page
          .getByText(sourceName, { exact: true })
          .filter({ visible: true })
          .count()
          .catch(() => -1);
        console.warn(
          `[DS-01-01] 清理未确认：自有数据源 ${sourceName} 仍可见（可见匹配=${remaining}）；` +
            `清理异常：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
  }
});
