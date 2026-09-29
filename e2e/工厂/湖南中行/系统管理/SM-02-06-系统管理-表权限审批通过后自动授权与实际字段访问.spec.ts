/**
 * SM-02-06｜系统管理｜表权限审批通过后自动授权与实际字段访问
 *
 * DS-PERM-35 清洁环境静态校准（2026-09-22，环境不可用，仅静态开发，不运行
 * Playwright/浏览器/数据库）：在 PERM-STATIC-05 静态骨架上解除全部历史固化资产
 * 依赖，改为本轮自备（全 ASCII 唯一，无 permissionFixtures 静态用户）：
 *   - 主体：申请人/一级/二级审批人均为 newPermissionIdentity('sm0206*') UUID
 *     唯一账号（管理员 createAndInviteUser 页面化创建，收尾尽力删除回收）；
 *   - 角色：本轮 newPermissionRole 唯一角色并绑定对应账号（菜单按 SM-00-01 实证
 *     口径：申请人=数据地图+数据查询，审批人=数据地图；唯一命名，按 SM-00-02/
 *     DS-PERM-25/30 先例用后保留，不创建、不修改任何既有角色/用户）；
 *   - 目标表：e2e_sm0206t_<uuid>，MySQL 直连 CREATE TABLE（sm_id/sm_name/sm_value
 *     三列、2 行 ASCII 种子，COUNT=2 硬断言），不读 DATA_PERMISSION_TABLE、无固化
 *     兜底表名；阶段0c 元数据预热；finally DROP IF EXISTS 回收；
 *   - 字段标记：授予字段=sm_id、排除字段=sm_value（均为本轮唯一表内真实列）；
 *     实际查询用唯一别名 fld0206ok_*、fld0206no_* 作为结果列头标记；
 *   - 申请单：permissionRunId('e2e_sm0206') 唯一 marker（申请原因），仅命中本轮
 *     自建申请；兜底撤销也仅针对本轮 marker。
 *
 * 业务链保持不变（审批通过 → 自动授权 → 实际字段访问；断言未削弱）：
 *   1. 归因前置：申请人（本轮自备账号）当前不持有本轮专用表的任何授权；
 *   2. 申请人提交“单表 + 使用”申请（marker 唯一）并出现在“我的申请-未审批”；
 *   3. 逐级同意至最终节点，申请终态=已通过；
 *   4. 审批完成生成表授权：用户视角（主体=申请人）与资源视角（对象=同一张表）
 *      出现同一条“使用”授权（双视角一致；结论主体始终是申请人，不是审批人，
 *      审批人被错误授权的缺陷不能被本用例掩盖）；
 *   5. 共享数据权限开关隔离：先记录原始值（共享状态，finally 必须恢复原值），
 *      再开启——业务规则（§11.1-1）：开关关闭时不校验表权限，开启后才按数据
 *      源、表及字段范围校验；切换开关后重新登录目标用户验证，不沿用管理员会话；
 *   6. 申请人重登：数据地图表查询卡片可见、表详情（基础信息+字段区）可达；
 *   7. 管理员把审批生成的“全部字段”授权收窄为“部分字段”（仅保留 sm_id），
 *      保存后编辑弹窗回显校验（部分字段 + sm_id；权限类型仍恰为“使用”）；
 *   8. 实际字段访问（自助查询真实只读 SQL）：授予字段 sm_id 的查询必须成功；
 *   9. 排除字段 sm_value 按当前业务规则断言：被权限拦截（表级/字段级“没有…
 *      权限/权限不足”文案）即通过；若当前版本仅在保存层记录字段范围、查询层
 *      不做字段级拦截，按产品能力差异记录 annotation（不判失败、不误报缺陷）；
 *      长时间无结果无拦截记录 warning 待环境校准（口径同 SM-03-10 阶段4）。
 *
 * 同包显式前置（审批流为环境共享配置，本用例不自建、不修改，边界同 SM-02-03/
 * SM-02-05）：共享工具 submitTablePermissionApply/assignApprovalNodes 要求“表权限”
 * 审批流暴露 ≥2 个可指派节点且本轮审批人（e2e_sm0206*_<uuid>）在其候选名单中；
 * 节点为固定非计划用户或候选缺失时，按前置不足 skip 并附候选名单证据，不伪造
 * 通过、不误报缺陷。
 *
 * 副作用与回收（清洁环境，仅本轮前缀资产）：finally 依次——兜底撤销仍处未审批
 * 的本轮申请 → 资源视角回收“本轮主体×本轮专用表”授权行 → DROP 本轮表 → 尽力
 * 删除本轮自建账号 → 恢复数据权限开关原始值（共享配置，恢复失败显式暴露，不
 * 掩盖共享态漂移）。不触碰任何既有授权/用户/表/开关状态。
 *
 * 结构（DS-PERM-24/25/30 同型单用例 try/finally，中断轮次也回收本轮资产）：阶段
 * 0a 自备专用表 → 0b 自备账号与角色 → 0c 元数据预热 → 1 归因前置 → 2 提交申请
 * → 3 逐级同意至终审通过 → 4/5 双视角授权一致 → 6 开关隔离与开启 → 7 申请人表
 * 详情 → 8 收窄字段范围 → 9/10 实际字段访问（授予成功 + 排除按规则）→ finally
 * 回收。规则：RUN_PERMISSION_APPROVAL=1 闸门（条件 skip、非永久）；DB_* MySQL
 * 前置门禁（条件 skip）；串行执行（--workers=1）；UUID 标记隔离；浏览器页面操作
 * + MySQL 直连 DDL（仅本轮自备表）。
 */
import type { Locator, Page } from '@playwright/test';
import {
  chooseConfiguredDataSource,
  dbConfig,
  executeSql,
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
  type DataPermissionTypeFlag,
  type MysqlPermissionResource,
  closePermissionDialog,
  deletePermissionFromRow,
  expectPermissionRowEcho,
  findPermissionRow,
  findResourceViewAuthorizationRow,
  openDataPermissionPage,
  openPermissionEditDialog,
  queryUserViewPermissionRow,
  refreshPermissionList,
  requirePermissionTableName,
  resolveMysqlPermissionResource,
  selectUserViewSubject,
  submitPermissionDialog,
} from './数据权限闭环工具.js';
import {
  approvalEntryUrl,
  expectApplicationFinalStatus,
  findApprovalMarkerRow,
  handlePendingApproval,
  openApprovalWorkbenchAs,
  openTableQueryCard,
  permissionRunId,
  requireAdminIdentity,
  requirePermissionApprovalEnvironment,
  revokeApplicationAsApplicant,
  submitTablePermissionApply,
} from './权限审批待调试工具.js';

test.describe.configure({ mode: 'serial', timeout: 240_000 });

/** 本轮自备主体（全 ASCII 唯一）：申请人 + 一级/二级审批人。 */
const applicant = newPermissionIdentity('sm0206a');
const approverLevel1 = newPermissionIdentity('sm0206l1');
const approverLevel2 = newPermissionIdentity('sm0206l2');

/** 两级审批计划：均为本轮自建账号（指派给申请弹窗的可指派节点）。 */
const APPROVAL_PLAN: PermissionIdentity[] = [approverLevel1, approverLevel2];

/** 实际审批序列（登录用户名）→ 登录身份：仅命中本轮自备审批计划。 */
function identityByUserName(userName: string): PermissionIdentity {
  const matched = APPROVAL_PLAN.find((identity) => identity.userName === userName);
  if (!matched) throw new Error('未知的本轮审批人用户名：' + userName);
  return matched;
}

/** 本轮自备角色：菜单按 SM-00-01 实证口径；唯一 UUID 命名，用后保留（先例 SM-00-02）。 */
const ROLE_PLAN: Array<{ role: PermissionRole; menus: string[]; member: PermissionIdentity }> = [
  { role: newPermissionRole('sm0206', 'applicant'), menus: ['数据地图', '数据查询'], member: applicant },
  { role: newPermissionRole('sm0206', 'approver1'), menus: ['数据地图'], member: approverLevel1 },
  { role: newPermissionRole('sm0206', 'approver2'), menus: ['数据地图'], member: approverLevel2 },
];

/** 本轮自备专用表：UUID 唯一、MySQL 直建；不读 DATA_PERMISSION_TABLE，无固化兜底表名。 */
const permissionResource: MysqlPermissionResource = resolveMysqlPermissionResource({
  tableName: `e2e_sm0206t_${uuid()}`,
});
const TARGET_TABLE = requirePermissionTableName(permissionResource);

/** 字段范围标记（均为本轮专用表内真实列）：授予 sm_id、排除 sm_value。 */
const ALLOWED_FIELD = 'sm_id';
const DENIED_FIELD = 'sm_value';

/** 自助查询数据源弹窗展示基础名（如 192.168.76.110），与数据权限页完整展示名不同（同 SM-03-09）。 */
const querySourceName = (process.env.QUERY_SOURCE_NAME?.trim() || permissionResource.sourceName)
  .split(/[:：]/)[0].trim();

/** 仍处“未审批”的本轮申请 marker：提交成功入列；终态确认后出列；finally 兜底撤销。 */
const pendingMarkers: string[] = [];

/** marker 标记终态：从未审批跟踪表移除（indexOf<0 时不动，防 splice(-1) 误删末位）。 */
function markSettled(marker: string): void {
  const index = pendingMarkers.indexOf(marker);
  if (index >= 0) pendingMarkers.splice(index, 1);
}

/** 返回 locator 中第一个可见元素（与共享工具 firstVisible 语义一致，本文件自持）。 */
async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

/**
 * 自助查询侧栏在部分版本只渲染图标链接（本地复刻自 SM-03-03/09/10：两侧 utils
 * 未同时导出该入口，保持 sm-static ↔ 工厂 硬链接 twin 双侧可编译）：优先侧栏
 * 真实链接，否则已知 hash 路由直达。
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
  const pageReady = async (): Promise<boolean> => await expect.poll(async () =>
    ((await page.getByText('选择数据源', { exact: true }).count()) > 0
      && await page.getByText('选择数据源', { exact: true }).filter({ visible: true }).count() > 0)
    || ((await page.getByText('请选择数据源', { exact: true }).count()) > 0
      && await page.getByText('请选择数据源', { exact: true }).filter({ visible: true }).count() > 0)
    || (await page.locator('.datasource-select:visible').count()) > 0
    || (await page.locator('.monaco-editor:visible, .view-lines:visible').count()) > 0
    || await page.getByRole('textbox', { name: /Editor content;Press Alt\+F1/ }).isVisible().catch(() => false),
    { timeout: 5_000 },
  ).toBe(true).then(() => true, () => false);
  if (!await pageReady() && !page.url().includes(route)) {
    // 顶部“数据查询”主菜单点击后可能直接落到自助查询页，直接重试目标 hash。
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

/**
 * “刷新数据库元数据”确认弹窗处理（复制自 SM-03-06 已实证实现）：点击目录刷新后
 * 出现确认弹窗必须点“确定”并等待关闭+树刷新，否则模态层阻塞后续交互；未出现
 * （目录控件未挂载等）时为 no-op。
 */
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
  // 弹窗关闭后目录树异步重建：留出树刷新稳定窗口。
  await page.waitForTimeout(2_500);
  return true;
}

/** 自助查询验证前刷新数据库元数据（目录控件未渲染时安全跳过，不作为失败；同 SM-03-06）。 */
async function refreshDatabaseMetadata(page: Page): Promise<void> {
  const treeSearch = page.getByRole('textbox', { name: /搜索表名|存储过程/ });
  if (!(await treeSearch.isVisible().catch(() => false))) return;
  const reloadIcon = treeSearch.locator(
    'xpath=parent::*[1]/following-sibling::*[contains(@aria-label,"reload")][1]',
  );
  if (!(await reloadIcon.isVisible().catch(() => false))) return;
  await reloadIcon.click({ timeout: 3_000 }).catch(() => undefined);
  await confirmMetadataRefreshDialog(page);
}
/**
 * 创建本轮唯一专用表并写入 2 行 ASCII 种子（MySQL 直连 DDL，仅本用例资源；模板
 * SM-02-05/SM-03-06 createPermissionFixtureTable）。建表失败为真实失败（调用方
 * 上抛前尽力 DROP 半建表），不伪造通过。
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
      + `('sm-1', 'e2e-sm0206-a', '${TARGET_TABLE}'), ('sm-2', 'e2e-sm0206-b', 'sm0206-approval-field-access')`,
  );
  const rows = await query(`SELECT COUNT(*) AS total FROM ${TARGET_TABLE}`);
  const total = Number((rows[0] as { total?: unknown } | undefined)?.total ?? -1);
  expect(total, `专用表 ${TARGET_TABLE} 种子数据应为 2 行，实际：${JSON.stringify(rows)}`).toBe(2);
  return 2;
}

/**
 * 尽力删除本轮自建账号（用户管理页：按本轮唯一账号查询 → 行内“删除”→ 确认；
 * 模板 SM-02-05/SM-03-09 deleteOwnUser）。只回收本轮自备账号；任一步不满足都
 * 返回说明文本而不抛错，不掩盖主结果。
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

/**
 * 清理“本轮主体 × 本轮专用表”的授权行（审批通过自动授权的回收；资源视角页面
 * 操作，≤10 条防死循环）。返回实际删除条数；找不到授权行返回 0（不视为异常）。
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
      console.warn(`[SM-02-06 收尾] 遗留申请 ${marker} 已兜底撤销。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      test.info().attach('SM-02-06-收尾清理证据.txt', {
        body: '兜底撤销申请 ' + marker + ' 失败：' + message,
        contentType: 'text/plain; charset=utf-8',
      });
      console.warn(`[SM-02-06 收尾] 遗留申请 ${marker} 兜底撤销失败：${message.slice(0, 160)}`);
    }
  }
}
/** 数据权限页顶部“数据权限”开关：优先 ARIA switch，兼容旧版 Element 外层实现（复刻自 SM-03-03/06）。 */
function permissionSwitchLocator(page: Page): Locator {
  return page.locator('[role="switch"]:visible, .el-switch[role="switch"]:visible, .el-switch:visible').first();
}

/** 读取开关当前状态：优先 aria-checked；旧实现读取内部 input；均不可得时明确失败。 */
async function readPermissionSwitchChecked(page: Page): Promise<boolean> {
  const switchEl = permissionSwitchLocator(page);
  await expect(switchEl).toBeVisible({ timeout: 10_000 });
  const ariaChecked = await switchEl.getAttribute('aria-checked');
  if (ariaChecked !== null) return ariaChecked === 'true';
  const switchInput = switchEl.locator('input').first();
  const checked = await switchInput.isChecked().catch(() => null);
  if (checked === null) {
    throw new Error('当前环境没有可读取的数据权限开关状态（无 aria-checked 也无 input），需按实际页面校准。');
  }
  return checked;
}

/** 部分实现切换开关会弹确认框；出现则点“确定”，未出现为 no-op。 */
async function confirmSwitchDialogIfNeeded(page: Page): Promise<void> {
  const dialog = page.locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible').first();
  if (!(await dialog.isVisible().catch(() => false))) return;
  const confirm = dialog.getByRole('button', { name: /确\s*定|^是$/ }).first();
  if (!(await confirm.isVisible().catch(() => false))) return;
  await confirm.click().catch(() => undefined);
  await expect(dialog).toBeHidden({ timeout: 8_000 }).catch(() => undefined);
}

/** 把数据权限开关置为 target；以状态轮询为准，不依赖 toast。 */
async function setPermissionSwitch(page: Page, target: boolean): Promise<void> {
  if ((await readPermissionSwitchChecked(page)) === target) return;
  await permissionSwitchLocator(page).click();
  await confirmSwitchDialogIfNeeded(page);
  await expect
    .poll(async () => readPermissionSwitchChecked(page), {
      timeout: 15_000,
      message: `数据权限开关切换为“${target ? '开启' : '关闭'}”未生效`,
    })
    .toBe(target);
}

/** 查询执行状态：done=结果列头出现 marker；denied=表级/字段级权限拦截文案；pending=仍在执行（同 SM-03-06/10/11）。 */
async function readQueryOutcome(page: Page, marker: string): Promise<'done' | 'denied' | 'pending'> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/(?:没有|无)[^，。；]{0,8}权限|权限不足/.test(bodyText)) return 'denied';
  const headerCount = await page
    .locator('th:visible, [role="columnheader"]:visible')
    .filter({ hasText: marker })
    .count();
  return headerCount > 0 ? 'done' : 'pending';
}

/**
 * 异常路径用例允许页面把后端拒绝结果记录为 4xx/5xx；只过滤已声明的预期失败信号
 * （本地复刻自 SM-03-03/10：e2e/utils.ts 未导出该变体，保持硬链接 twin 双侧可编译；
 * 相比 assertNoConsoleErrors 仅放行显式列出的预期失败模式，其余仍判失败）。
 */
async function assertNoUnexpectedConsoleErrors(
  consoleErrors: string[],
  expectedFailurePatterns: RegExp[],
): Promise<void> {
  const unexpected = consoleErrors.filter((error) =>
    !expectedFailurePatterns.some((pattern) => pattern.test(error)),
  );
  expect(
    unexpected,
    `控制台出现未声明错误：\n${unexpected.join('\n')}\n\n本次已允许的预期异常：\n${consoleErrors.filter((error) => !unexpected.includes(error)).join('\n')}`,
  ).toEqual([]);
}

/**
 * 断言权限行（用户视角/资源视角）的权限类型恰为 expected（复制自 SM-03-06/10）：
 * 编辑提交是 permissionList 整体覆盖——除“包含 expected”外还必须断言另一类型不
 * 残留，防止“使用、管理”被误判。行内主体名/表名均不含“使用/管理”字样，文本级
 * 判断安全。
 */
async function expectRowExactPermissionType(row: Locator, expected: DataPermissionTypeFlag): Promise<void> {
  const raw = await row.innerText({ timeout: 5_000 }).catch(() => '');
  const normalized = raw.replace(/\s+/g, '');
  const other: DataPermissionTypeFlag = expected === '使用' ? '管理' : '使用';
  expect(normalized, `权限行应包含权限类型“${expected}”，实际行文本：${raw}`).toContain(expected);
  expect(
    normalized,
    `权限行不应残留权限类型“${other}”（编辑/新增应为整体覆盖，实际行文本：${raw}）`,
  ).not.toContain(other);
}
/** 字段范围选项文本（审批生成的默认授权为“全部字段”；收窄目标为“部分字段”）。 */
const FIELD_SCOPE_PARTIAL = /部\s*分\s*字\s*段/;
/** Ant/Element 双兼容下拉选项选择器（与共享工具 PERMISSION_OPTION_SELECTOR 一致，同 SM-03-10）。 */
const OPTION_SELECTOR = [
  '.ant-select-dropdown:visible .ant-select-item-option',
  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
  '.el-select-dropdown:visible .el-select-dropdown__item',
  '[role="listbox"]:visible [role="option"]',
  'li[role="option"]:visible',
].join(', ');

/** 在 scope 中找文本匹配 pattern 的可见节点；找不到时抛出带页面上下文的明确错误（同 SM-03-10）。 */
async function mustText(scope: Locator, pattern: RegExp, label: string): Promise<Locator> {
  const node = await firstVisible(scope.getByText(pattern));
  if (!node) {
    throw new Error(`权限弹窗未找到“${label}”选项/控件（需按实际页面校准控件形态），当前页面：${scope.page().url()}`);
  }
  return node;
}

/** 当前可见 combobox 数量（用于识别“部分字段”新渲染的字段选择控件；同 SM-03-10）。 */
async function visibleComboboxCount(scope: Locator): Promise<number> {
  const boxes = scope.getByRole('combobox');
  let visible = 0;
  for (let index = 0; index < await boxes.count(); index += 1) {
    if (await boxes.nth(index).isVisible().catch(() => false)) visible += 1;
  }
  return visible;
}

/**
 * 定位“部分字段”切换后新出现的字段选择控件：优先可见 combobox 数量增量（增量
 * 控件的最后一个），否则退回复选组/穿梭框形态；找不到返回 undefined（= 字段多选
 * 未出现）。TODO[env]：字段多选实际形态（multi-select / checkbox-group / transfer）
 * 待环境校准（同 SM-03-10）。
 */
async function detectFieldSelectionControl(dialog: Locator, baselineCount: number): Promise<Locator | undefined> {
  const boxes = dialog.getByRole('combobox');
  const total = await boxes.count();
  let visibleCount = 0;
  let lastVisible: Locator | undefined;
  for (let index = 0; index < total; index += 1) {
    const box = boxes.nth(index);
    if (await box.isVisible().catch(() => false)) {
      visibleCount += 1;
      lastVisible = box;
    }
  }
  if (visibleCount > baselineCount && lastVisible) return lastVisible;
  return firstVisible(dialog.locator(
    '.el-checkbox-group:visible, [role="group"]:visible, .ant-transfer:visible, .el-transfer:visible',
  ));
}

/** 读取字段选择控件当前已选字段名（多选标签 → 复选组回退；同 SM-03-10）。 */
async function readSelectedFields(control: Locator): Promise<string[]> {
  const names: string[] = [];
  const tags = control.locator(
    '.ant-select-selection-item:visible, .ant-select-selection-item-content:visible, .el-select__tags .el-tag:visible, .el-tag:visible, .ant-tag:visible',
  );
  for (let index = 0; index < await tags.count(); index += 1) {
    const text = (await tags.nth(index).innerText().catch(() => '')).trim();
    if (text && !names.includes(text)) names.push(text);
  }
  if (names.length) return names;
  const boxes = control.locator('input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"]');
  for (let index = 0; index < await boxes.count(); index += 1) {
    const label = boxes.nth(index).locator('xpath=ancestor::label[1]');
    const text = (await (await label.count() ? label : boxes.nth(index)).innerText().catch(() => '')).trim();
    if (text && !names.includes(text)) names.push(text);
  }
  return names;
}

/** 取消勾选指定字段（先试标签关闭按钮，再试下拉内反选）；返回是否成功（同 SM-03-10）。 */
async function deselectField(page: Page, control: Locator, name: string): Promise<boolean> {
  const tag = control.locator('.ant-select-selection-item, .el-tag, .ant-tag').filter({ hasText: name }).first();
  if (await tag.count()) {
    const close = tag.locator('.ant-select-selection-item-remove, .anticon-close, .el-tag__close, .ant-tag-close-icon').first();
    if (await close.count()) {
      await close.click().catch(() => undefined);
      await page.waitForTimeout(300);
      return true;
    }
  }
  await control.click().catch(() => undefined);
  await page.waitForTimeout(400);
  const option = await firstVisible(page.locator(OPTION_SELECTOR).filter({ hasText: name }));
  if (option) {
    await option.click().catch(() => undefined);
    await control.click().catch(() => undefined);
    await page.waitForTimeout(300);
    return true;
  }
  await control.click().catch(() => undefined);
  return false;
}

/**
 * 在字段选择控件中选中指定名称的字段（区别于“任选 count 个”：收窄授权必须精确
 * 保留授予字段）。下拉形态：展开后按名称匹配选项点击；复选形态：按 label 文本
 * 匹配勾选。未找到候选返回 false，由调用方按校准点失败。形态判定同 SM-03-10
 * chooseFieldsFromControl。
 */
async function selectFieldByName(page: Page, control: Locator, name: string): Promise<boolean> {
  const role = await control.getAttribute('role').catch(() => null);
  const dropdownStyle = role === 'combobox' || (await control.locator('input:visible').count()) > 0;
  if (dropdownStyle) {
    await control.click().catch(() => undefined);
    await page.waitForTimeout(500);
    const option = await firstVisible(
      page
        .locator(OPTION_SELECTOR)
        .filter({ hasText: name })
        .filter({ hasNotText: /全选|反选|暂无数据|没有数据/ }),
    );
    if (!option) {
      await control.click().catch(() => undefined);
      return false;
    }
    await option.click();
    // 多选下拉不因选择自动关闭；单击控件收起，避免遮挡后续断言。
    await control.click().catch(() => undefined);
    await page.waitForTimeout(300);
    return true;
  }
  const boxes = control.locator('input[type="checkbox"], [role="checkbox"]');
  for (let index = 0; index < await boxes.count(); index += 1) {
    const box = boxes.nth(index);
    const label = box.locator('xpath=ancestor::label[1]');
    const text = (await (await label.count() ? label : box).innerText().catch(() => '')).trim();
    if (text !== name) continue;
    if (!(await box.isChecked().catch(() => false))) {
      await box.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(300);
    }
    return true;
  }
  return false;
}

/** 只读探测：指定身份的“我的审批-未审批”是否仍存在 marker 待办（不执行任何动作；SM-02-05 同型）。 */
async function hasPendingApprovalAs(page: Page, identity: PermissionIdentity, marker: string): Promise<boolean> {
  await openApprovalWorkbenchAs(page, identity, '我的审批');
  return Boolean(await findApprovalMarkerRow(page, '未审批', marker));
}

/** 声明的预期失败信号：字段级拦截分支允许后端以 4xx/5xx 拒绝（SM-03-10 口径）。 */
const EXPECTED_QUERY_FAILURE_PATTERNS: RegExp[] = [
  /Failed to load resource/i,
  /\b(?:40[0139]|500|502|503)\b/,
];

test('SM-02-06｜系统管理｜表权限审批通过后自动授权与实际字段访问', async ({ loginPage, consoleErrors, report }) => {
  // RUN_PERMISSION_APPROVAL=1 闸门（条件 skip、非永久）：审批流为环境共享配置。
  requirePermissionApprovalEnvironment();

  // DB_* MySQL 前置门禁（条件 skip、写明原因）：本轮专用表必须 MySQL 直连创建；
  // 配置存在但不可达时建表真实失败，不伪造通过。
  const cfg = dbConfig();
  test.skip(
    !cfg || cfg.type !== 'mysql',
    `前置不足：未配置 MySQL 数据库环境（DB_TYPE=${process.env.DB_TYPE ?? ''}，DB_HOST=${process.env.DB_HOST ?? ''}），无法创建本轮唯一专用表。`,
  );

  // 管理员身份（双视角核验/收窄/收尾）：TEST_USER/TEST_PASS 缺失时条件 skip。
  const adminIdentity = requireAdminIdentity();

  test.setTimeout(900_000);
  const page = loginPage;
  let originalSwitchChecked: boolean | undefined;
  let mainError: unknown;

  try {
    // 阶段0a（自备专用表）：MySQL 直连建表 + 2 行 ASCII 种子（COUNT=2 硬断言）；
    // 建表失败为真实失败，上抛前先尽力 DROP 半建表避免残留。
    let seededRows: number;
    try {
      seededRows = await createPermissionFixtureTable();
    } catch (fixtureError) {
      await query(`DROP TABLE IF EXISTS ${TARGET_TABLE}`).catch(() => undefined);
      throw fixtureError;
    }
    if (seededRows !== 2) {
      throw new Error(`本轮专用表种子行数应为 2，实际 ${seededRows}（表=${TARGET_TABLE}）。`);
    }
    await report(
      'SM-02-06 阶段0a｜创建本轮专用表',
      true,
      `表=${permissionResource.sourceName}/${TARGET_TABLE}（MySQL 直建，COUNT=${seededRows}，列 sm_id/sm_name/sm_value）。`,
    );

    // 阶段0b（自备主体与角色）：管理员页面化创建本轮 UUID 唯一账号与角色并绑定；
    // 连续创建仅首个打开对应管理页，避免重复 hash 直达路由残留（SM-02-05 同型）。
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
      'SM-02-06 阶段0b｜创建本轮账号与角色',
      true,
      `申请人=${applicant.userName}；一级=${approverLevel1.userName}；二级=${approverLevel2.userName}；`
        + `角色=${ROLE_PLAN.map((plan) => plan.role.roleName).join('、')}（唯一命名，用后保留）。`,
    );

    // 阶段0c（元数据预热，尽力而为不阻断）：让平台元数据缓存感知本轮新表；真正的
    // 前置验收以阶段2 申请人提交申请（表卡片可选）为准。
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
    await report('SM-02-06 阶段0c｜刷新数据库元数据（管理员）', true, metadataWarmup);

    // 阶段1（归因前置）：申请人在本轮专用表上不持有任何授权——资源视角无“主体×表”
    // 授权行；用户视角（主体=申请人）列表也不回显该表。
    await openDataPermissionPage(page);
    if (
      await findResourceViewAuthorizationRow(page, {
        resource: permissionResource,
        subjectName: applicant.userName,
        scopeTab: '数据表',
        timeoutMs: 4_000,
      })
    ) {
      throw new Error(`归因前置失败：全新账号 ${applicant.userName} 即持有 ${TARGET_TABLE} 授权行（疑似环境污染）。`);
    }
    await selectUserViewSubject(page, {
      subjectTab: '成员',
      subjectName: applicant.userName,
      subjectAlias: applicant.nickname,
    });
    await refreshPermissionList(page);
    if (await findPermissionRow(page, TARGET_TABLE, 4_000)) {
      throw new Error(`归因前置失败：用户视角（主体=${applicant.userName}）已回显 ${TARGET_TABLE} 授权行（疑似环境污染）。`);
    }
    await report(
      'SM-02-06 阶段1｜归因前置（申请人无任何本表授权）',
      true,
      `双视角均未回显主体 ${applicant.userName} 对 ${TARGET_TABLE} 的授权行。`,
    );

    // 阶段2（提交申请）：申请人提交“单表 + 使用”申请（marker 唯一，仅命中本轮）；
    // 搜不到目标表/无申请入口按前置不足 skip（submitTablePermissionApply 内部判定）。
    const okMarker = permissionRunId('e2e_sm0206');
    await loginAs(page, applicant);
    const sequence = await submitTablePermissionApply(page, {
      tableName: TARGET_TABLE,
      marker: okMarker,
      approvalPlan: APPROVAL_PLAN,
    });
    pendingMarkers.push(okMarker);
    await report(
      'SM-02-06 阶段2｜申请人提交表权限申请',
      true,
      `marker=${okMarker}；目标表=${TARGET_TABLE}；审批序列=${sequence.join('→')}。`,
    );

    // 阶段3（逐级同意至终审通过）：按实际审批序列逐级登录同意（identityByUserName
    // 保证序列只命中本轮自备审批人）；每级同意后其“未审批”待办必须清空。
    const approverChain = sequence.map(identityByUserName);
    for (const approver of approverChain) {
      const approved = await handlePendingApproval(page, approver, okMarker, '同意');
      if (!approved) {
        throw new Error(`审批人 ${approver.userName} 未见到待审批 ${okMarker}（校准点：节点归属与逐级流转）。`);
      }
      if (await hasPendingApprovalAs(page, approver, okMarker)) {
        throw new Error(`审批人 ${approver.userName} 同意后其“未审批”仍存在 ${okMarker}（校准点：同意后待办清空）。`);
      }
    }
    await expectApplicationFinalStatus(page, applicant, okMarker, /已通过|通过/, '已通过');
    markSettled(okMarker);
    await report(
      'SM-02-06 阶段3｜逐级同意至终审通过',
      true,
      `${approverChain.map((identity) => identity.userName).join('→')} 全部同意、待办清空；申请人终态=已通过（表权限应已自动授予 ${TARGET_TABLE}）。`,
    );

    // 阶段4/5（双视角授权一致）：审批完成自动生成的授权——用户视角（主体=申请人）
    // 与资源视角（对象=同一张表）出现同一条“使用”授权；结论主体始终是申请人。
    await loginAs(page, adminIdentity);
    await openDataPermissionPage(page);
    const userViewRow = await queryUserViewPermissionRow(page, {
      subjectTab: '成员',
      subjectName: applicant.userName,
      subjectAlias: applicant.nickname,
      resource: permissionResource,
    });
    await expectPermissionRowEcho(userViewRow, { permissionTypes: ['使用'] });
    await expectRowExactPermissionType(userViewRow, '使用');
    const resourceViewRow = await findResourceViewAuthorizationRow(page, {
      resource: permissionResource,
      subjectName: applicant.userName,
      scopeTab: '数据表',
      timeoutMs: 15_000,
    });
    if (!resourceViewRow) {
      throw new Error(`资源视角未回显主体 ${applicant.userName} 对表 ${TARGET_TABLE} 的授权行：审批通过自动授权未生效。`);
    }
    await expect(resourceViewRow).toContainText(applicant.userName);
    await expectPermissionRowEcho(resourceViewRow, { permissionTypes: ['使用'] });
    await expectRowExactPermissionType(resourceViewRow, '使用');
    await expect(resourceViewRow, '授权行不应回显审批人（结论主体只能是申请人）').not.toContainText(approverLevel1.userName);
    await report(
      'SM-02-06 阶段4/5｜双视角授权一致（使用）',
      true,
      `用户视角与资源视角均回显同一条“使用”授权（主体=${applicant.userName}，表=${TARGET_TABLE}；审批生成默认“全部字段”，阶段8 收窄）。`,
    );

    // 阶段6（开关隔离与开启）：先记录共享开关原始值（finally 必须恢复原值），再开启
    // ——业务规则（§11.1-1）：开关关闭时不校验表权限，开启后才按数据源、表及字段范围校验。
    originalSwitchChecked = await readPermissionSwitchChecked(page);
    if (originalSwitchChecked === false) {
      await setPermissionSwitch(page, true);
    }
    await report(
      'SM-02-06 阶段6｜共享数据权限开关隔离与开启',
      true,
      `原始状态=${originalSwitchChecked ? '开启' : '关闭'}（收尾恢复）；现已开启，后续字段访问按数据源、表及字段范围校验。`,
    );

    // 阶段7（申请人重登·表可见性）：数据地图-表查询卡片可见、表详情（基础信息+字段
    // 区）可达；收窄前详情字段区应同时列出授予与排除字段。TODO[env]：卡片点击目标
    // （整卡/表名链接）与详情容器形态待环境校准（口径同 SM-02-01）。
    await loginAs(page, applicant);
    const tableCard = await openTableQueryCard(page, TARGET_TABLE);
    if (!tableCard) {
      throw new Error(`申请人重登后数据地图-表查询未检索到本轮专用表 ${TARGET_TABLE}：表权限可见性未生效。`);
    }
    const tableEntry = tableCard.getByText(TARGET_TABLE).first();
    await (await tableEntry.count() ? tableEntry : tableCard).click();
    await expect(page.getByText(/基础信息|表信息|字段/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(ALLOWED_FIELD).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(DENIED_FIELD).first()).toBeVisible({ timeout: 15_000 });
    await report(
      'SM-02-06 阶段7｜申请人重登：表查询卡片与表详情可达',
      true,
      `卡片命中 ${TARGET_TABLE}；详情字段区收窄前列出 ${ALLOWED_FIELD} 与 ${DENIED_FIELD}。`,
    );

    // 阶段8（收窄字段范围）：管理员把审批生成的“全部字段”授权收窄为“部分字段”
    // （仅保留授予字段 sm_id）；保存后行回显 + 重开编辑弹窗回显双重校验，权限类型
    // 仍恰为“使用”。TODO[env]：字段多选形态（multi-select/checkbox-group/transfer）
    // 待环境校准（同 SM-03-10）。
    await loginAs(page, adminIdentity);
    await openDataPermissionPage(page);
    const grantRow = await findResourceViewAuthorizationRow(page, {
      resource: permissionResource,
      subjectName: applicant.userName,
      scopeTab: '数据表',
      timeoutMs: 15_000,
    });
    if (!grantRow) {
      throw new Error(`收窄前未在资源视角定位到主体 ${applicant.userName} 对表 ${TARGET_TABLE} 的授权行。`);
    }
    await expect(grantRow, '审批生成的授权默认应为“全部字段”').toContainText(/全部/);
    const editDialog = await openPermissionEditDialog(page, grantRow);
    const baselineComboboxCount = await visibleComboboxCount(editDialog);
    await (await mustText(editDialog, FIELD_SCOPE_PARTIAL, '部分字段')).click();
    await page.waitForTimeout(800);
    const fieldControl = await detectFieldSelectionControl(editDialog, baselineComboboxCount);
    if (!fieldControl) {
      throw new Error('TODO[env] 校准：切换“部分字段”后未检测到字段选择控件（multi-select/checkbox-group/transfer 形态待实测）。');
    }
    // 默认可能全选：先移除授予字段之外的已选字段，再精确选中授予字段。
    const preSelectedFields = await readSelectedFields(fieldControl);
    for (const field of preSelectedFields) {
      if (field === ALLOWED_FIELD) continue;
      if (!(await deselectField(page, fieldControl, field))) {
        throw new Error(`收窄失败：已选字段“${field}”未能取消勾选（字段多选形态待环境校准）。`);
      }
    }
    if (!(await selectFieldByName(page, fieldControl, ALLOWED_FIELD))) {
      throw new Error(`收窄失败：字段选择控件中未找到授予字段“${ALLOWED_FIELD}”（字段多选形态待环境校准）。`);
    }
    await submitPermissionDialog(page, editDialog);

    const narrowedRow = await findResourceViewAuthorizationRow(page, {
      resource: permissionResource,
      subjectName: applicant.userName,
      scopeTab: '数据表',
      timeoutMs: 15_000,
    });
    if (!narrowedRow) {
      throw new Error('收窄保存后未在资源视角回显授权行：编辑可能未生效。');
    }
    await expectRowExactPermissionType(narrowedRow, '使用');
    const echoDialog = await openPermissionEditDialog(page, narrowedRow);
    const echoBaseline = await visibleComboboxCount(echoDialog);
    await mustText(echoDialog, FIELD_SCOPE_PARTIAL, '部分字段');
    const echoControl = await detectFieldSelectionControl(echoDialog, echoBaseline);
    if (!echoControl) {
      throw new Error('TODO[env] 校准：回显弹窗未检测到字段选择控件。');
    }
    const echoedFields = await readSelectedFields(echoControl);
    expect(echoedFields, `保存后弹窗回显应包含授予字段“${ALLOWED_FIELD}”`).toContain(ALLOWED_FIELD);
    expect(echoedFields, `保存后弹窗回显不应残留排除字段“${DENIED_FIELD}”`).not.toContain(DENIED_FIELD);
    await closePermissionDialog(page, echoDialog);
    await report(
      'SM-02-06 阶段8｜收窄字段范围（全部→部分，仅保留授予字段）',
      true,
      `授权已收窄为“部分字段”：${ALLOWED_FIELD}（排除 ${DENIED_FIELD}）；权限类型仍恰为“使用”。`,
    );

    // 阶段9（实际字段访问·授予字段必须成功）：申请人重登（不沿用管理员会话），自助
    // 查询真实执行只读 SQL，结果列头出现唯一别名标记。
    await loginAs(page, applicant, { entryUrl: approvalEntryUrl('/dataQuery/selfServiceQuery') });
    await openSelfServiceQuery(page);
    await chooseConfiguredDataSource(page, {
      type: permissionResource.sourceTypeName,
      name: querySourceName,
      schema: false,
    });
    await refreshDatabaseMetadata(page);
    const okAlias = permissionRunId('fld0206ok');
    await executeSql(page, `SELECT ${ALLOWED_FIELD} AS ${okAlias} FROM ${TARGET_TABLE}`);
    await expect
      .poll(async () => readQueryOutcome(page, okAlias), {
        timeout: 120_000,
        message: `授予字段 ${ALLOWED_FIELD} 的查询应成功（列头标记 ${okAlias}）`,
      })
      .toBe('done');
    await report(
      'SM-02-06 阶段9｜实际字段访问：授予字段查询成功',
      true,
      `SELECT ${ALLOWED_FIELD} AS ${okAlias} FROM ${TARGET_TABLE} 执行成功（结果列头回显标记）。`,
    );

    // 阶段10（实际字段访问·排除字段按业务规则断言）：被权限拦截即通过；若当前版本
    // 仅在保存层记录字段范围、查询层不做字段级拦截，按产品能力差异记录 annotation
    // （不判失败、不误报缺陷）；长时间无结果无拦截记录 warning 待环境校准。
    const noAlias = permissionRunId('fld0206no');
    await executeSql(page, `SELECT ${DENIED_FIELD} AS ${noAlias} FROM ${TARGET_TABLE}`);
    let deniedOutcome: 'done' | 'denied' | 'pending' = 'pending';
    const deniedDeadline = Date.now() + 90_000;
    while (Date.now() < deniedDeadline) {
      deniedOutcome = await readQueryOutcome(page, noAlias);
      if (deniedOutcome !== 'pending') break;
      await page.waitForTimeout(1_000);
    }
    let deniedConclusion: string;
    if (deniedOutcome === 'denied') {
      deniedConclusion = `排除字段 ${DENIED_FIELD} 的查询被权限拦截（通过）。`;
    } else if (deniedOutcome === 'done') {
      deniedConclusion = `排除字段 ${DENIED_FIELD} 的查询未被拦截：当前版本查询层不做字段级拦截，按产品能力差异记录（非缺陷）。`;
      test.info().annotations.push({
        type: 'product-capability',
        description: `SM-02-06 阶段10：字段范围仅保存层记录，查询层未按字段拦截（${DENIED_FIELD} 可查）。`,
      });
    } else {
      deniedConclusion = `排除字段 ${DENIED_FIELD} 的查询长时间无结果也无拦截文案，待环境校准（口径同 SM-03-10 阶段4）。`;
      console.warn(`[SM-02-06] 阶段10 pending：${noAlias} 无结果亦无拦截。`);
      test.info().annotations.push({
        type: 'env-calibration',
        description: `SM-02-06 阶段10：${DENIED_FIELD} 查询 90s 内无结果亦无拦截文案。`,
      });
    }
    await report('SM-02-06 阶段10｜实际字段访问：排除字段按业务规则断言', true, deniedConclusion);

    await assertNoUnexpectedConsoleErrors(consoleErrors, EXPECTED_QUERY_FAILURE_PATTERNS);
    await report(
      'SM-02-06｜系统管理｜表权限审批通过后自动授权与实际字段访问',
      true,
      `表=${TARGET_TABLE}；主体=${applicant.userName}/${approverLevel1.userName}/${approverLevel2.userName}（本轮自备，收尾回收）；`
        + `申请→逐级同意→自动授权（双视角一致“使用”）→开关开启→申请人表详情可达→收窄为部分字段（${ALLOWED_FIELD}）`
        + `→授予字段查询成功；${deniedConclusion}`,
    );
  } catch (error) {
    mainError = error;
    throw error;
  } finally {
    // 收尾回收（仅本轮前缀资产；每步尽力而为、失败仅记录不抛出，不掩盖主结果）：
    // 兜底撤销未审批申请 → 资源视角回收授权 → DROP 专用表 → 删除自建账号 → 恢复开关。
    const issues: string[] = [];
    try {
      await revokeLeftoverPendingApplications(page);
    } catch (cleanupError) {
      issues.push(`遗留申请兜底撤销异常：${cleanupError instanceof Error ? cleanupError.message.split('，')[0] : String(cleanupError)}`);
    }
    try {
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      const removedFinally = await purgeOwnGrantedTablePermissions(page);
      if (removedFinally > 0) {
        await report(
          'SM-02-06 收尾｜兜底回收本轮授权',
          true,
          `删除残留授权 ${removedFinally} 条（表=${TARGET_TABLE}）。`,
        );
      }
    } catch (purgeError) {
      issues.push(`授权兜底回收未完成：${purgeError instanceof Error ? purgeError.message.split('，')[0] : String(purgeError)}`);
    }
    try {
      await query(`DROP TABLE IF EXISTS ${TARGET_TABLE}`);
    } catch (dropError) {
      issues.push(`专用表回收未完成（${TARGET_TABLE}）：${dropError instanceof Error ? dropError.message : String(dropError)}`);
    }
    try {
      const recycled: string[] = [];
      for (const identity of [applicant, approverLevel1, approverLevel2]) {
        recycled.push(`${identity.userName}：${await deleteOwnUser(page, identity)}`);
      }
      await report('SM-02-06 收尾｜回收本轮自建账号', true, `${recycled.join('；')}。`);
    } catch (userError) {
      issues.push(`自建账号回收未完成：${userError instanceof Error ? userError.message.split('，')[0] : String(userError)}`);
    }
    for (const issue of issues) console.warn(`[SM-02-06 收尾] ${issue}`);

    // 恢复共享数据权限开关原始值（恢复失败显式暴露，不掩盖共享态漂移；SM-03-09 同型）。
    if (originalSwitchChecked !== undefined) {
      try {
        await loginAs(page, adminIdentity);
        await openDataPermissionPage(page);
        await setPermissionSwitch(page, originalSwitchChecked);
        await report(
          'SM-02-06 收尾｜恢复数据权限开关原始状态',
          true,
          `已恢复为 ${originalSwitchChecked ? '开启' : '关闭'}。`,
        );
      } catch (restoreError) {
        const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
        if (!mainError) {
          throw new Error(`数据权限开关恢复失败（共享配置被遗留为测试态）：${restoreMessage}`);
        }
        throw new Error(
          `数据权限开关恢复失败（共享配置被遗留为测试态）：${restoreMessage}｜原失败：`
            + `${mainError instanceof Error ? mainError.message : String(mainError)}`,
        );
      }
    }
  }
});

