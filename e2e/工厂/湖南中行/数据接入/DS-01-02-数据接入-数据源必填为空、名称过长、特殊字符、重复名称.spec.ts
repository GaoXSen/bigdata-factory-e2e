/**
 * DS-01-02｜数据接入｜数据源名称必填与重复名称阻止创建
 *
 * 20260922 清洁环境基线重构（任务 DS-PERM-08）：
 * - 数据库资源固定 MySQL 110；不再依赖历史 79.52 OpenGauss 连接或
 *   HUNAN_D002_PASSWORD；连接信息缺失时明确 skip，不伪造结果。
 * - 唯一资源由本用例页面流程创建（唯一英文前缀 e2eds02+UUID），不触碰任何既有数据源。
 * 20260922 清洁环境迁移（任务 DS-PERM-57）：
 * - 主库物理连接改经 '../utils.js' 的 dbConfig() 取得（内部即 e2e/test-environment.ts
 *   配置中心：profile mysql110-ftp113 基线 + DB_* 兼容变量单项覆盖，凭据仅来自进程
 *   环境变量；硬链接双路径下两份 utils 镜像同构，spec 不直接 import 配置中心）；
 *   spec 内不持有 host/port/帐号/口令兜底。
 * - 清理范围收敛为“仅本轮创建的数据源”：取消按 e2eds02 前缀扫描历史遗留对象的
 *   预清理与兜底清理（避免触碰非本轮资产）；finally 只删除本轮 sourceName。
 * - 本用例只断言页面已明确的两条稳定规则：
 *   1) 名称必填：其他连接字段全部有效、名称留空时，最终提交被页面阻止且连接表单仍打开；
 *   2) 名称不可重复：同名有效配置再次提交后创建被阻止（列表中唯一名称仍只有原记录 1 条），
 *      只断言创建被阻止，不写死提示文案。
 * - 长度和特殊字符边界在业务给出明确规则前不臆造失败断言。
 * - 连接/保存 toast 仅作流程中间信号；创建与删除均以列表真实回显结果断言。
 */
import { clickMenu, dbConfig, expect, test, uuid } from '../utils.js';
import {
  clickCardAction,
  clickVisible,
  confirmDangerDialog,
  expectSuccess,
  fillPlaceholder,
} from '../抽样用例工具.js';

test('DS-01-02｜数据接入｜名称必填与重复名称不得创建', async ({ loginPage, report }) => {
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
        '清洁库基线不允许依赖历史数据源（79.52 OpenGauss / HUNAN_D002_PASSWORD 已废弃），' +
        '本用例拒绝在无可用连接信息时伪造必填/重名校验结果。',
    );
    return;
  }
  const dbHost = primaryDb.host;
  const dbPort = String(primaryDb.port);
  const dbUser = primaryDb.user;
  const dbPass = primaryDb.password;
  const dbName = primaryDb.database;

  const sourceName = `e2eds02${uuid()}`; // 唯一英文前缀 + UUID：绝不触碰既有数据源
  const description = `ds0102_${uuid()}`;

  /** 连接表单中的名称输入框；表单打开期间可见，关闭后隐藏。 */
  const nameField = (): ReturnType<typeof page.getByPlaceholder> =>
    page.getByPlaceholder('请输入数据源名称', { exact: true }).last();

  /** 打开添加数据源两步向导：类型选择（内置搜索过滤出 MYSQL）→ 连接表单。 */
  async function openMysqlCreateWizard(): Promise<void> {
    await clickMenu(page, '数据接入', '数据源管理');
    const addEntry = page
      .getByRole('button', { name: /添加数据源|新增数据源/ })
      .filter({ visible: true })
      .first();
    await expect(addEntry, '数据源管理列表应出现“添加数据源”入口').toBeVisible({ timeout: 15_000 });
    await addEntry.click();
    const typeDialog = page.getByRole('dialog', { name: /添加数据源|新增数据源/ }).last();
    await expect(typeDialog, '点击后应弹出数据源类型选择弹窗').toBeVisible({ timeout: 10_000 });
    // 首屏类型卡片不暴露类型文本，必须先用弹窗内置搜索过滤（与 DS-01-03/06 同一方式）。
    const typeSearch = typeDialog.getByPlaceholder('请输入关键字搜索');
    if (await typeSearch.isVisible().catch(() => false)) {
      await typeSearch.fill('MYSQL');
      await clickVisible(typeDialog, /搜\s*索|图标:\s*search/).catch(() => undefined);
    }
    await clickVisible(typeDialog, 'MYSQL', { timeoutMs: 5_000 });
    await clickVisible(typeDialog, '下一步');
    await expect(nameField(), '选择 MYSQL 并下一步后应进入连接表单').toBeVisible({ timeout: 10_000 });
  }

  /** 填写 MYSQL 连接表单；name 传 undefined 表示刻意留空名称（必填校验分支）。 */
  async function fillMysqlConnection(name: string | undefined): Promise<void> {
    if (name !== undefined) await fillPlaceholder(page, '请输入数据源名称', name);
    await fillPlaceholder(page, '请输入数据源描述', description);
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
  }

  /** 按唯一名称删除数据源：危险确认后以“列表中名称消失”为真实结果断言。 */
  async function deleteByName(name: string): Promise<void> {
    await clickCardAction(page, name, '删除');
    await confirmDangerDialog(page);
    await expect(
      page.getByText(name, { exact: true }).filter({ visible: true }),
      `删除后 ${name} 应从列表消失`,
    ).toHaveCount(0, { timeout: 15_000 });
    // 删除 toast 仅辅助信号；删除结果已由“列表消失”硬断言决定。
    await expectSuccess(page, /删除成功|移除成功|操作成功|成功/).catch(() => undefined);
  }

  /**
   * 仅回收本轮创建的 sourceName：逐张删除同名可见卡片（重复名未被阻止的产品缺陷
   * 场景下可能存在两张），绝不扫描或删除其他轮次/他人的数据源资产。
   */
  async function deleteThisRoundSource(): Promise<void> {
    const remainingCards = page.getByText(sourceName, { exact: true }).filter({ visible: true });
    for (let attempt = 0; attempt < 6 && (await remainingCards.count()) > 0; attempt += 1) {
      await deleteByName(sourceName);
    }
    await expect(
      remainingCards,
      `本轮数据源 ${sourceName} 清理后应从列表完全消失`,
    ).toHaveCount(0, { timeout: 10_000 });
  }

  try {
    // 1. 进入 数据接入→数据源管理。
    await clickMenu(page, '数据接入', '数据源管理');

    // 2. 名称必填：其他连接字段全部有效、名称留空，最终提交必须被页面阻止且表单仍打开。
    await openMysqlCreateWizard();
    await fillMysqlConnection(undefined);
    // “测试连接”仅校验 JDBC 连通性，不负责表单必填校验；名称必填应在最终“确定”提交时由页面阻止。
    await clickVisible(page, /确\s*定/);
    // 阻止证据 1：提交后连接表单未关闭（未进入创建流程）。
    await expect(
      nameField(),
      '空名称提交后连接表单应保持打开（创建被页面阻止）',
    ).toBeVisible({ timeout: 10_000 });
    // 阻止证据 2：页面出现名称必填校验提示。当前前端把校验提示渲染为普通 generic 节点，
    // 不带 Element/Ant 的 error 样式类；不能只按样式类定位，否则真实提示存在时仍误判失败。
    const validationHint = page
      .getByText(/数据源名称.*(?:不能为空|必填)|名称\s*(?:不能为空|必填)|请输入数据源名称/, { exact: false })
      .filter({ visible: true })
      .last();
    await expect(validationHint, '空名称提交后页面应出现名称必填校验提示').toBeVisible({ timeout: 10_000 });
    await report('名称必填校验', true, '空名称提交被页面阻止：连接表单保持打开且出现名称必填提示。');
    await clickVisible(page, /取\s*消/);
    await expect(nameField(), '取消后创建弹窗应关闭，避免影响后续步骤').toBeHidden({ timeout: 10_000 });

    // 3. 创建唯一基线数据源：测试连接成功后确定，以列表真实回显为创建证据。
    await openMysqlCreateWizard();
    await fillMysqlConnection(sourceName);
    await clickVisible(page, '测试连接');
    await expectSuccess(page, /连接成功|测试成功|成功/);
    await clickVisible(page, /确\s*定/);
    await expect(
      page.getByText(sourceName, { exact: true }).filter({ visible: true }).first(),
      '创建后列表应真实回显唯一名称卡片（连接 toast 不作为通过证据）',
    ).toBeVisible({ timeout: 15_000 });
    await report('创建唯一数据源', true, `自有 MYSQL@110 数据源 ${sourceName} 创建成功并回显于列表。`);

    // 4. 重复名称：同名有效配置再次提交，只断言创建被阻止，不写死提示文案。
    await openMysqlCreateWizard();
    await fillMysqlConnection(sourceName);
    await clickVisible(page, '测试连接');
    await expectSuccess(page, /连接成功|测试成功|成功/);
    await clickVisible(page, /确\s*定/);
    // 无论提示文案如何、表单是否停留：唯一名称必须仍只有原记录 1 条 ——
    // 这既是“重复创建被阻止”的证据，也同时排除“原记录被破坏”的情况。
    await expect(
      page.getByText(sourceName, { exact: true }).filter({ visible: true }),
      `重复名称提交后创建应被阻止：列表中“${sourceName}”必须仍只有原记录 1 条`,
    ).toHaveCount(1, { timeout: 15_000 });
    await report('重复名称阻止创建', true, `同名 ${sourceName} 再次提交被阻止，列表仍仅原记录 1 条。`);
    // 重复提交若停留在表单上，先取消关闭，保持页面状态干净。
    if (await nameField().isVisible().catch(() => false)) {
      await clickVisible(page, /取\s*消/);
      await expect(nameField(), '重复提交尝试后应能关闭创建弹窗').toBeHidden({ timeout: 10_000 });
    }

    // 5. 清理：删除本用例唯一数据源，以列表回显消失为真实结果断言。
    await deleteByName(sourceName);
    await report('清理自有数据源', true, `唯一数据源 ${sourceName} 已删除并从列表消失。`);

    await report(
      'DS-01-02 数据源名称必填与重复名称阻止创建',
      true,
      `空名称提交被阻止且表单保持打开；唯一源 ${sourceName} 创建成功；同名再次提交被阻止（列表仍 1 条）；自有源已删除（MySQL 110，全程页面操作）。`,
    );
  } finally {
    await page.keyboard.press('Escape').catch(() => undefined);
    try {
      await clickMenu(page, '数据接入', '数据源管理');
      // 仅删除本轮创建的 sourceName；绝不清理其他轮次/他人的数据源资产。
      await deleteThisRoundSource();
    } catch (cleanupError) {
      const remaining = await page
        .getByText(sourceName, { exact: true })
        .filter({ visible: true })
        .count()
        .catch(() => -1);
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`[DS-01-02] 本轮数据源 ${sourceName} 清理未完全确认（源名称可见匹配=${remaining}）：${message}`);
      test.info().annotations.push({ type: 'cleanup-warning', description: `清理未完全确认：${message}` });
    }
  }
});
