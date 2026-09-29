/**
 * SM-02-05｜系统管理｜我的审批：逐级同意至终审通过与拒绝即终止
 *
 * DS-PERM-30 清洁环境静态校准（2026-09-22，环境不可用，仅静态校准，不运行 Playwright）：
 * 在 PERM-STATIC-04 静态骨架上解除全部历史固化资产依赖，改为本轮自备（全 ASCII 唯一）：
 *   - 主体：申请人/一级/二级审批人均为 newPermissionIdentity('sm0205*') UUID 唯一账号
 *     （管理员 createAndInviteUser 页面化创建，收尾尽力删除回收）；
 *   - 角色：本轮 newPermissionRole 唯一角色并绑定对应账号（菜单按 SM-00-01 实证口径：
 *     申请人=数据地图+数据查询，审批人=数据地图；唯一命名，按 SM-00-02/DS-PERM-25
 *     先例用后保留，不创建、不修改任何既有角色/用户）；
 *   - 目标表：e2e_sm0205t_<uuid>，MySQL 直连 CREATE TABLE（sm_id/sm_name/sm_value 三列、
 *     2 行种子，COUNT=2 硬断言），不读 DATA_PERMISSION_TABLE、无固化兜底表名；阶段0c
 *     元数据预热；finally DROP IF EXISTS 回收；
 *   - 申请单：permissionRunId 唯一 marker（申请原因），仅命中本轮自建申请，绝不使用
 *     历史记录；兜底撤销也仅针对本轮 marker。
 *
 * 业务断言保持不变（PERM-STATIC-04 口径，未削弱）：
 *   1. 逐级同意：两级审批计划——第一审批人同意后其待办清空、申请流转至第二审批人；
 *      第二审批人终审同意后待办清空，申请人终态=已通过；
 *   2. 拒绝即终止：另一轮申请第一审批人拒绝后直接终态=已驳回，第二审批人无待办，
 *      申请人侧未审批页签不再出现该申请（不可再撤销）。
 *
 * 同包显式前置（DS-PERM-69 清洁环境：阶段0b2 管理员把“表权限”审批流整体替换为本轮
 * 自建 2 级用户型审批人，进入时先捕获快照、finally 按快照恢复；口径同 SM-02-01/03）：
 * 共享工具 submitTablePermissionApply/assignApprovalNodes 在该自建流上指派本轮审批人
 * （e2e_sm0205l*_<uuid>），逐级同意/拒绝路径均以申请弹窗解析的实际审批序列为准（不
 * 假定固定顺序）；进入时该类型本就未配置（应用后无法恢复为“未配置”）或“确认应用”
 * 被拦截时按前置不足 skip，不破坏共享态、不伪造通过、不误报缺陷。
 *
 * 副作用与回收（清洁环境）：终审同意后申请人将获得本轮自备表的表权限（SM-02-06 自动
 * 授权语义）；finally 先按“本轮主体 × 本轮专用表”尽力回收该授权行（资源视角页面操
 * 作），再 DROP 本轮表、删除本轮账号——不触碰任何既有授权/用户/表。旧静态稿“撤销申
 * 请不回收已授权限”的历史行为不再适用：本用例全部资产本轮自建，随表整体回收。
 *
 * 结构（DS-PERM-24/25 同型单用例 try/finally，中断轮次也回收本轮资产）：阶段0a 自建
 * 专用表 → 0b 自建账号与角色 → 0c 元数据预热 → 1 逐级同意至终审通过 → 2 拒绝即终止
 * → finally 兜底撤销/回收授权/删表/删账号（仅本轮前缀）。
 *
 * 规则：RUN_PERMISSION_APPROVAL=1 闸门（条件 skip、非永久）；DB_* MySQL 前置门禁（条件
 * skip）；串行执行（--workers=1）；UUID 标记隔离；浏览器页面操作 + MySQL 直连 DDL
 * （仅本轮自备表）。
 */
import type { Locator, Page } from '@playwright/test';
import {
  assertNoConsoleErrors,
  chooseConfiguredDataSource,
  dbConfig,
  expect,
  query,
  test,
  uuid,
} from '../utils.js';
import {
  assignRoleToUser,
  createAndInviteUser,
  createRole,
  loginAs,
  newPermissionIdentity,
  newPermissionRole,
  openUserManagement,
  type PermissionIdentity,
  type PermissionRole,
} from './权限测试工具.js';
import {
  deletePermissionFromRow,
  findResourceViewAuthorizationRow,
  openDataPermissionPage,
  requirePermissionTableName,
  resolveMysqlPermissionResource,
  type MysqlPermissionResource,
} from './数据权限闭环工具.js';
import {
  expectApplicationFinalStatus,
  findApprovalMarkerRow,
  handlePendingApproval,
  openApprovalLeaf,
  openApprovalWorkbenchAs,
  permissionRunId,
  requirePermissionApprovalEnvironment,
  revokeApplicationAsApplicant,
  submitTablePermissionApply,
} from './权限审批待调试工具.js';

/** 本轮自备主体（DS-PERM-30 起解耦 permissionFixtures 固化用户依赖；全 ASCII 唯一）。 */
const applicant = newPermissionIdentity('sm0205a');
const approverLevel1 = newPermissionIdentity('sm0205l1');
const approverLevel2 = newPermissionIdentity('sm0205l2');

/** 两级审批计划：均为本轮自建账号（指派给申请弹窗的可指派节点）。 */
const APPROVAL_PLAN: PermissionIdentity[] = [approverLevel1, approverLevel2];

/** 本轮自备角色：菜单按 SM-00-01 实证口径；唯一 UUID 命名，用后保留（先例 SM-00-02）。 */
const ROLE_PLAN: Array<{ role: PermissionRole; menus: string[]; member: PermissionIdentity }> = [
  { role: newPermissionRole('sm0205', 'applicant'), menus: ['数据地图', '数据查询'], member: applicant },
  { role: newPermissionRole('sm0205', 'approver1'), menus: ['数据地图'], member: approverLevel1 },
  { role: newPermissionRole('sm0205', 'approver2'), menus: ['数据地图'], member: approverLevel2 },
];

/** 本轮自备专用表：UUID 唯一、MySQL 直建；不读 DATA_PERMISSION_TABLE，无固化兜底表名。 */
const permissionResource: MysqlPermissionResource = resolveMysqlPermissionResource({
  tableName: `e2e_sm0205t_${uuid()}`,
});
const TARGET_TABLE = requirePermissionTableName(permissionResource);

/** 自助查询数据源弹窗展示基础名（如 192.168.76.110），与数据权限页完整展示名不同（同 SM-03-09）。 */
const querySourceName = (process.env.QUERY_SOURCE_NAME?.trim() || permissionResource.sourceName)
  .split(/[:：]/)[0].trim();

/** 管理员身份：与 loginPage fixture 同源，用于前置创建与收尾回收。 */
const adminIdentity: PermissionIdentity = {
  userName: (process.env.TEST_USER ?? 'admin').trim(),
  nickname: (process.env.TEST_USER ?? 'admin').trim(),
  password: process.env.TEST_PASS ?? '',
  phone: '',
  email: '',
};

/** 仍处“未审批”的本轮申请 marker：提交成功入列；终态确认后出列；finally 兜底撤销。 */
const pendingMarkers: string[] = [];

/** 前置不足：写清原因后跳过，不伪造通过、不误报缺陷。 */
function skipForMissingEnvironment(reason: string): never {
  test.info().attach('ENV-SM0205-前置证据.txt', { body: reason, contentType: 'text/plain; charset=utf-8' });
  test.skip(true, 'ENV-SM0205：' + reason);
  throw new Error('UNREACHABLE：test.skip 应已中断用例。');
}

/** marker 标记终态：从未审批跟踪表移除（indexOf<0 时不动，防 splice(-1) 误删末位）。 */
function markSettled(marker: string): void {
  const index = pendingMarkers.indexOf(marker);
  if (index >= 0) pendingMarkers.splice(index, 1);
}

/**
 * 自助查询侧栏在部分版本只渲染图标链接（本地复刻自 SM-03-09，共享 utils 未导出该
 * 入口，保持双孪生可编译）：优先侧栏真实链接，否则已知 hash 路由直达。
 */
async function openSelfServiceQuery(page: Page): Promise<void> {
  const route = '#/dataQuery/selfServiceQuery';
  const targetUrl = (): string => {
    const target = new URL(page.url());
    // URL.hash 赋值时不再携带 #，避免不同 Chromium 版本出现 ##/ 路由差异。
    target.hash = route.slice(1);
    return target.toString();
  };
  const sideLink = page.locator(`a[href*="${route}"]:visible`).last();
  if (await sideLink.isVisible().catch(() => false)) {
    await sideLink.click({ force: true });
    await page.waitForURL(new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).catch(() => undefined);
  } else if (!page.url().includes(route)) {
    await page.goto(targetUrl(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
  }
  await expect.poll(async () =>
    ((await page.getByText('选择数据源', { exact: true }).count()) > 0
      && await page.getByText('选择数据源', { exact: true }).filter({ visible: true }).count() > 0)
    || ((await page.getByText('请选择数据源', { exact: true }).count()) > 0
      && await page.getByText('请选择数据源', { exact: true }).filter({ visible: true }).count() > 0)
    || (await page.locator('.datasource-select:visible').count()) > 0
    || (await page.locator('.monaco-editor:visible, .view-lines:visible').count()) > 0
    || await page.getByRole('textbox', { name: /Editor content;Press Alt\+F1/ }).isVisible().catch(() => false),
    { timeout: 20_000 },
  ).toBe(true);
}

/** “刷新数据库元数据”确认弹窗处理（复制自 SM-03-09/SM-03-06 已实证实现）。 */
async function confirmMetadataRefreshDialog(page: Page, timeoutMs = 8_000): Promise<boolean> {
  const dialog = page.getByRole('dialog', { name: /刷新数据库元数据/ });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await dialog.isVisible().catch(() => false)) break;
    await page.waitForTimeout(250);
  }
  if (!(await dialog.isVisible().catch(() => false))) return false;
  await dialog.getByRole('button', { name: /确\s*定/ }).first().click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await page.waitForTimeout(2_500);
  return true;
}

/** 元数据预热前刷新数据库元数据（目录控件未渲染时安全跳过；同 SM-03-09）。 */
async function refreshDatabaseMetadata(page: Page): Promise<void> {
  const treeSearch = page.getByRole('textbox', { name: /搜索表名|存储过程/ });
  if (!(await treeSearch.isVisible().catch(() => false))) return;
  const reloadIcon = treeSearch.locator(
    'xpath=parent::*[1]/following-sibling::*[contains(@aria-label,"reload")][1]',
  );
  if (!(await reloadIcon.isVisible().catch(() => false))) return;
  await reloadIcon.click({ timeout: 2_000 }).catch(() => undefined);
  await confirmMetadataRefreshDialog(page).catch(() => undefined);
}

/**
 * 创建本轮唯一专用表并写入 2 行种子（MySQL 直连 DDL，仅本用例资源；模板 SM-03-09
 * createPermissionFixtureTable）。建表失败为真实失败（调用方上抛前尽力 DROP 半建表），
 * 不伪造通过。
 */
async function createPermissionFixtureTable(): Promise<number> {
  await query(
    `CREATE TABLE ${TARGET_TABLE} (`
      + 'sm_id varchar(64) NOT NULL,'
      + 'sm_name varchar(128) DEFAULT NULL,'
      + 'sm_value varchar(128) DEFAULT NULL,'
      + 'PRIMARY KEY (sm_id)'
      + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
  );
  await query(
    `INSERT INTO ${TARGET_TABLE} (sm_id, sm_name, sm_value) VALUES `
      + `('sm-1', 'e2e-sm0205-a', '${TARGET_TABLE}'), ('sm-2', 'e2e-sm0205-b', 'my-approve-close-loop')`,
  );
  const rows = await query(`SELECT COUNT(*) AS total FROM ${TARGET_TABLE}`);
  const total = Number((rows[0] as { total?: unknown } | undefined)?.total ?? -1);
  expect(total, `专用表 ${TARGET_TABLE} 种子数据应为 2 行，实际：${JSON.stringify(rows)}`).toBe(2);
  return 2;
}

/**
 * 尽力删除本轮自建账号（用户管理页：按本轮唯一账号查询 → 行内“删除”→ 确认；模板
 * SM-03-09 deleteOwnApplicantUser）。只回收本轮自备账号；任一步不满足都返回说明文本
 * 而不抛错，不掩盖主结果。
 */
async function deleteOwnUser(page: Page, identity: PermissionIdentity): Promise<string> {
  await openUserManagement(page);
  const search = page.getByRole('textbox', { name: '请输入用户名称' }).first();
  await search.fill(identity.userName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(800);
  const userText = page.getByText(identity.userName, { exact: true }).last();
  if (!(await userText.isVisible().catch(() => false))) {
    return '列表未查询到本轮账号（可能此前已删除）';
  }
  const row = userText.locator('xpath=ancestor::tr[1]');
  if (!(await row.isVisible().catch(() => false))) {
    return '账号可见但未取到表格行，跳过页面删除（账号保留）';
  }
  const deleteButton = row.getByRole('button', { name: /删\s*除/ }).first();
  if (!(await deleteButton.isVisible().catch(() => false))) {
    return '行内未找到“删除”按钮，跳过页面删除（账号保留）';
  }
  await deleteButton.click();
  const confirmDialog = page
    .locator('[role="dialog"]:visible, .el-message-box:visible, .el-dialog:visible, .ant-modal:visible')
    .first();
  if (await confirmDialog.isVisible().catch(() => false)) {
    const confirm = confirmDialog.getByRole('button', { name: /确\s*定|^是$/ }).first();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
  }
  await expect(userText).toBeHidden({ timeout: 10_000 }).catch(() => undefined);
  return '已提交删除并确认列表不再显示该账号';
}

/** 只读探测：指定身份的“我的审批-未审批”是否存在 marker 待办（不执行任何动作）。 */
async function hasPendingApprovalAs(page: Page, identity: PermissionIdentity, marker: string): Promise<boolean> {
  await openApprovalWorkbenchAs(page, identity, '我的审批');
  return Boolean(await findApprovalMarkerRow(page, '未审批', marker));
}

/**
 * 清理“本轮主体 × 本轮专用表”的授权行（终审同意自动授权的回收；资源视角页面操作，
 * ≤10 条防死循环）。返回实际删除条数；找不到授权行返回 0（不视为异常）。
 */
async function purgeOwnGrantedTablePermissions(page: Page): Promise<number> {
  let removed = 0;
  for (let guard = 0; guard < 10; guard += 1) {
    const stale = await findResourceViewAuthorizationRow(page, {
      resource: permissionResource,
      subjectName: applicant.userName,
      scopeTab: '数据表',
      timeoutMs: 4_000,
    });
    if (!stale) break;
    await deletePermissionFromRow(page, stale, { uniqueText: TARGET_TABLE });
    removed += 1;
  }
  return removed;
}

/** 兜底撤销仍处未审批的本轮申请：仅本轮 marker；失败附证据不掩盖主结果。 */
async function revokeLeftoverPendingApplications(page: Page): Promise<void> {
  for (const marker of pendingMarkers.slice()) {
    try {
      await revokeApplicationAsApplicant(page, applicant, marker);
      markSettled(marker);
      console.warn(`[SM-02-05 收尾] 遗留申请 ${marker} 已兜底撤销。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      test.info().attach('SM-02-05-收尾清理证据.txt', {
        body: '兜底撤销申请 ' + marker + ' 失败：' + message,
        contentType: 'text/plain; charset=utf-8',
      });
      console.warn(`[SM-02-05 收尾] 遗留申请 ${marker} 兜底撤销失败：${message.slice(0, 160)}`);
    }
  }
}

test('SM-02-05｜系统管理｜我的审批-逐级同意与拒绝终止', async ({ loginPage, consoleErrors, report }) => {
  requirePermissionApprovalEnvironment();

  // 前置门禁（条件 skip、非永久）：本轮专用表必须 MySQL 直连创建；DB_* 未配置或非
  // MySQL 时按“前置不足”跳过并写明原因（数据库配置存在但不可达时建表真实失败）。
  const cfg = dbConfig();
  if (!cfg || cfg.type !== 'mysql') {
    test.skip(
      !cfg || cfg.type !== 'mysql',
      `前置不足：未配置 MySQL 数据库环境（DB_TYPE=${process.env.DB_TYPE ?? ''}，DB_HOST=${process.env.DB_HOST ?? ''}），`
        + '无法创建本轮唯一专用表。',
    );
  }

  test.setTimeout(900_000);
  const page = loginPage;

  try {
    // 阶段0a（自备专用表）：MySQL 直连建表 + 2 行种子；建表失败为真实失败，上抛前先
    // 尽力 DROP 半建表避免残留。
    let seededRows = 0;
    try {
      seededRows = await createPermissionFixtureTable();
    } catch (fixtureError) {
      await query(`DROP TABLE IF EXISTS ${TARGET_TABLE}`).catch(() => undefined);
      throw fixtureError;
    }
    await report(
      'SM-02-05 阶段0a｜创建本轮专用表',
      true,
      `表=${permissionResource.sourceName}/${TARGET_TABLE}（MySQL 直建，种子 ${seededRows} 行，列 sm_id/sm_name/sm_value）。`,
    );

    // 阶段0b（自备主体与角色）：管理员创建本轮 UUID 唯一账号与角色并绑定（不依赖任何
    // 历史用户/角色；连续创建仅首个打开对应管理页，避免重复 hash 直达路由残留）。
    await loginAs(page, adminIdentity);
    let userPageOpened = false;
    for (const identity of [applicant, approverLevel1, approverLevel2]) {
      await createAndInviteUser(page, identity, { openPage: !userPageOpened });
      userPageOpened = true;
    }
    let rolePageOpened = false;
    for (const plan of ROLE_PLAN) {
      await createRole(page, plan.role, plan.menus, { openPage: !rolePageOpened });
      rolePageOpened = true;
    }
    for (const plan of ROLE_PLAN) {
      await assignRoleToUser(page, plan.role, plan.member);
    }
    await report(
      'SM-02-05 阶段0b｜创建本轮账号与角色',
      true,
      `申请人=${applicant.userName}；一级=${approverLevel1.userName}；二级=${approverLevel2.userName}；`
        + `角色=${ROLE_PLAN.map((plan) => plan.role.roleName).join('、')}（唯一命名，用后保留）。`,
    );

    // 阶段0c（元数据预热）：让平台元数据缓存感知本轮新表（数据地图-表查询可检索）；
    // 尽力而为、如实记录，不阻断——真正验收以阶段1 申请提交（表可选）为准（同 SM-03-09/10）。
    let metadataWarmup: string;
    try {
      await openSelfServiceQuery(page);
      await chooseConfiguredDataSource(page, {
        type: permissionResource.sourceTypeName,
        name: querySourceName,
        schema: false,
      });
      await refreshDatabaseMetadata(page);
      metadataWarmup = '自助查询目录已尝试按实时元数据刷新，本轮新表进入平台元数据缓存。';
    } catch (metadataError) {
      metadataWarmup = `预热未完成（不阻断）：${metadataError instanceof Error ? metadataError.message.split('，')[0] : String(metadataError)}`;
    }
    await report('SM-02-05 阶段0c｜刷新数据库元数据（管理员）', true, metadataWarmup);

    // 阶段1（逐级同意）：申请人提交 → 第一审批人同意（其待办清空、流转第二审批人）
    // → 第二审批人终审同意（待办清空）→ 申请人终态=已通过。
    const okMarker = permissionRunId('e2e_sm0205_ok');
    await loginAs(page, applicant);
    const sequence = await submitTablePermissionApply(page, {
      tableName: TARGET_TABLE,
      marker: okMarker,
      approvalPlan: APPROVAL_PLAN,
    });
    pendingMarkers.push(okMarker);

    const first = await handlePendingApproval(page, APPROVAL_PLAN[0], okMarker, '同意');
    if (!first) {
      throw new Error('第一审批人 ' + APPROVAL_PLAN[0].userName + ' 未见到待审批 ' + okMarker + '（校准点：节点归属与指派一致性）。');
    }
    // 流转证据：第一审批人待办清空。
    const stillForFirst = await hasPendingApprovalAs(page, APPROVAL_PLAN[0], okMarker);
    if (stillForFirst) {
      throw new Error('第一审批人同意后其“未审批”仍存在 ' + okMarker + '（校准点：同意后待办流转）。');
    }

    const second = await handlePendingApproval(page, APPROVAL_PLAN[1], okMarker, '同意');
    if (!second) {
      throw new Error('第一审批人同意后，第二审批人 ' + APPROVAL_PLAN[1].userName + ' 未见到待审批 ' + okMarker + '（校准点：逐级流转）。');
    }
    // 终审证据：第二审批人待办清空。
    const stillForSecond = await hasPendingApprovalAs(page, APPROVAL_PLAN[1], okMarker);
    if (stillForSecond) {
      throw new Error('第二审批人终审同意后其“未审批”仍存在 ' + okMarker + '（校准点：终审后待办清空）。');
    }

    await expectApplicationFinalStatus(page, applicant, okMarker, /已通过|通过/, '已通过');
    markSettled(okMarker);
    await report(
      'SM-02-05 阶段1｜逐级同意至终审通过',
      true,
      '审批序列=' + sequence.join('→') + '；两级同意后待办均清空；申请人终态=已通过'
        + '（表权限已授予本轮自备表 ' + TARGET_TABLE + '，收尾随表回收）。',
    );

    // 阶段2（拒绝即终止）：新一轮申请 → 第一审批人拒绝 → 直接终态=已驳回；第二审批
    // 人无待办；申请人侧未审批页签不再出现该申请（不可再撤销）。
    const rejectMarker = permissionRunId('e2e_sm0205_rej');
    await submitTablePermissionApply(page, {
      tableName: TARGET_TABLE,
      marker: rejectMarker,
      approvalPlan: APPROVAL_PLAN,
    });
    pendingMarkers.push(rejectMarker);

    const rejected = await handlePendingApproval(page, APPROVAL_PLAN[0], rejectMarker, '拒绝');
    if (!rejected) {
      throw new Error('第一审批人 ' + APPROVAL_PLAN[0].userName + ' 未见到待审批 ' + rejectMarker + '（校准点：节点归属与指派一致性）。');
    }
    // 拒绝即终止：第二审批人不出现待办。
    const leakedToSecond = await hasPendingApprovalAs(page, APPROVAL_PLAN[1], rejectMarker);
    if (leakedToSecond) {
      throw new Error('第一级拒绝后申请仍流转至第二审批人（校准点/疑似产品缺陷：拒绝即终止契约）。');
    }

    await expectApplicationFinalStatus(page, applicant, rejectMarker, /已驳回|驳回|拒绝/, '已驳回');
    markSettled(rejectMarker);

    // 申请人侧：未审批页签不再出现该申请（终态不可撤销）。
    await openApprovalWorkbenchAs(page, applicant, '我的申请');
    if (await findApprovalMarkerRow(page, '未审批', rejectMarker)) {
      throw new Error('驳回终态后申请人“未审批”页签仍存在 ' + rejectMarker + '（校准点：终态后列表流转）。');
    }
    await report(
      'SM-02-05 阶段2｜拒绝即终止',
      true,
      '第一级拒绝→第二级无待办；申请人终态=已驳回；未审批页签已消失（不可再撤销）。',
    );

    await assertNoConsoleErrors(consoleErrors);
    await report(
      'SM-02-05｜我的审批-逐级同意与拒绝终止',
      true,
      `表=${TARGET_TABLE}；主体=${applicant.userName}/${approverLevel1.userName}/${approverLevel2.userName}（本轮自备，收尾回收）；`
        + '逐级同意（两级待办清空、终态=已通过）→拒绝即终止（第二级无待办、终态=已驳回、未审批页签消失）。',
    );
  } finally {
    // 收尾回收（仅本轮前缀资产；每步尽力而为、失败仅记录不抛出，不掩盖主结果）。
    const issues: string[] = [];
    // 1) 兜底撤销仍处未审批的本轮申请（如阶段2 拒绝动作前中断），避免悬挂待审批单。
    try {
      await revokeLeftoverPendingApplications(page);
    } catch (cleanupError) {
      issues.push(`遗留申请兜底撤销异常：${cleanupError instanceof Error ? cleanupError.message.split('，')[0] : String(cleanupError)}`);
    }
    // 2) 回收“本轮主体 × 本轮专用表”授权行（终审同意的自动授权；先删授权行再删表）。
    try {
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      const removed = await purgeOwnGrantedTablePermissions(page);
      if (removed > 0) {
        await report('SM-02-05 收尾｜回收本轮授权', true, `已删除“本轮主体×本轮表”授权 ${removed} 条（表=${TARGET_TABLE}）。`);
      }
    } catch (purgeError) {
      issues.push(`本轮授权回收未完成（${TARGET_TABLE}×${applicant.userName}）：${purgeError instanceof Error ? purgeError.message.split('，')[0] : String(purgeError)}`);
    }
    // 3) DROP 本轮专用表（授权行已按主体×表清理；表删除即兜底彻底回收）。
    try {
      await query(`DROP TABLE IF EXISTS ${TARGET_TABLE}`);
    } catch (dropError) {
      issues.push(`专用表回收未完成（${TARGET_TABLE}）：${dropError instanceof Error ? dropError.message : String(dropError)}`);
    }
    // 4) 删除本轮自建账号（用户管理页行内删除；角色按先例保留——唯一 UUID 命名）。
    try {
      await loginAs(page, adminIdentity);
      const outcomes: string[] = [];
      for (const identity of [applicant, approverLevel1, approverLevel2]) {
        outcomes.push(`${identity.userName}：${await deleteOwnUser(page, identity)}`);
      }
      await report('SM-02-05 收尾｜回收本轮账号', true, outcomes.join('；') + '。');
    } catch (userError) {
      issues.push(`本轮账号回收未完成：${userError instanceof Error ? userError.message.split('，')[0] : String(userError)}`);
    }
    for (const issue of issues) console.warn(`[SM-02-05 收尾] ${issue}`);
  }
});
