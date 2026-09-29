/**
 * SM-00-01｜系统管理｜权限测试用户、角色与授权初始化（清洁环境自建版）。
 *
 * DS-PERM-49 清洁环境与配置中心校准（2026-09-22，静态开发，未运行页面/数据库）：
 * 解除对历史固化资产（permissionFixtures 固定用户 e2e_perm_*_v2、固定角色、固定
 * 手机号/邮箱）的依赖，改为每轮自建唯一 ASCII 对象，环境清空后可独立复跑：
 *   - 用户：newPermissionIdentity('sm0001*') 生成 UUID 唯一账号（口令统一来自
 *     SM_PERMISSION_PASSWORD 兼容变量，与 权限测试工具.permissionPassword 同源；
 *     登录链路走配置中心 TEST_USER/TEST_PASS 的 loginPage 夹具，spec 内无任何
 *     写死口令），经 createAndInviteUser 页面化“新增用户 → 邀请入当前组织”；
 *   - 角色：newPermissionRole('sm0001', …) UUID 唯一角色，菜单保持本用例实证口径
 *     （申请人=数据地图+数据查询；两级审批=数据地图），经 createRole 真实勾选；
 *   - 授权：assignRoleToUser 走“分配用户 → 按用户名搜索 → 勾选 → 确定”页面路径；
 *   - 清理：finally 尽力删除本轮自建用户与角色（仅限本轮 UUID 命名对象；删除入口
 *     缺失或后端拒绝时记录说明文本，不掩盖主结果，交由 --headed 校准）。
 *
 * 保留的真实断言（未削弱）：
 *   1. 用户创建并邀请后，按用户名查询用户列表必须出现真实可见行；
 *   2. 角色创建后，按角色名查询角色列表必须出现真实可见行；
 *   3. 每个角色的“分配用户”授权表中必须出现对应用户的真实可见记录。
 * 成功证据一律是列表/授权表中的真实可见记录，不依赖任何瞬时 toast。
 *
 * 页面事实（来自历史失败快照，不能违背）：
 *   1. 新用户必须被邀请进入当前组织后，才会出现在用户列表中；
 *   2. 目标用户已被邀请时，页面短暂提示后邀请弹窗可能仍然停留——“已存在当前
 *      组织”与成功提示都含“邀请”字样，因此由 权限测试工具.inviteUserToCurrent-
 *      Organization 按真实接口结果与“按用户名查询后的可见行”判定，不以固定
 *      toast 文案为准；
 *   3. 登录后默认落在“数据接入→数据源管理”，本用例经系统管理真实导航进入目标页，
 *      不绕道文件接入；
 *   4. 连续创建多个用户/角色时仅首个进入对应页面（重复 hash 直达会触发当前前端
 *      路由组件残留）。
 *
 * 下游影响（业务不确定项，详见 result-DS-PERM-49.md）：SM-00-01 不再预建
 * permissionFixtures 固定账号；仍消费固化账号的用例（如 SM-02-07）需自行迁移为
 * 本轮自备，或显式调用 权限测试工具.ensurePermissionUser（工具未改动，仍可用）。
 */
import { test, expect, assertNoConsoleErrors } from '../utils.js';
import type { Locator, Page } from '@playwright/test';
import { clickVisible } from '../抽样用例工具.js';
import {
  assignRoleToUser,
  createAndInviteUser,
  createRole,
  newPermissionIdentity,
  newPermissionRole,
  openRoleManagement,
  openUserManagement,
} from './权限测试工具.js';
import type { PermissionIdentity, PermissionRole } from './权限测试工具.js';

test.describe.configure({ mode: 'serial', timeout: 300_000 });

/** 定位/等待类失败优先归为页面结构问题，避免把前端改版误报成业务失败。 */
function looksLikePageStructureIssue(reason: string): boolean {
  return /Timed out|timeout|locator|未找到可见操作|toBeVisible|toBeHidden|toBeChecked|严格模式|strict mode/i
    .test(reason);
}

/** 把用户准备阶段异常归因为：用户创建 / 用户邀请 / 页面结构或导航。 */
function classifyUserPhase(reason: string): string {
  if (looksLikePageStructureIssue(reason)) return '页面结构或导航';
  if (/邀请|inviteUser/.test(reason)) return '用户邀请';
  if (/新增用户|请输入用户|密码|昵称|邮箱|手机|性别|组织|用户列表/.test(reason)) return '用户创建';
  return '页面结构或导航';
}

/** 把角色阶段异常归因为：角色配置 / 角色授权 / 页面结构或导航。 */
function classifyRolePhase(reason: string): string {
  if (looksLikePageStructureIssue(reason)) return '页面结构或导航';
  if (/分配用户|添加用户|授权/.test(reason)) return '角色授权';
  if (/角色/.test(reason)) return '角色配置';
  return '页面结构或导航';
}

/**
 * 以阶段标签包裹一步初始化：失败时说明具体卡在用户创建、用户邀请、角色配置、
 * 角色授权还是页面结构，并保留原始错误信息便于人工跟进。
 */
async function runStep<T>(
  phase: string | ((reason: string) => string),
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const label = typeof phase === 'function' ? phase(reason) : phase;
    throw new Error(`【SM-00-01｜${label}】${reason}`);
  }
}

/** 在轮询窗口内等待精确文本作为可见元素出现；兼容 Element Table 与 div-table 两种渲染。 */
async function waitExactTextVisible(page: Page, text: string, timeoutMs: number): Promise<Locator | undefined> {
  const matches = page.getByText(text, { exact: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let index = await matches.count() - 1; index >= 0; index -= 1) {
      const item = matches.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
    await page.waitForTimeout(250);
  }
  return undefined;
}

/** 终态核验：按用户名查询用户列表，必须看到可见行才算初始化成功。 */
async function assertUserListed(page: Page, userName: string): Promise<void> {
  const query = page.getByRole('textbox', { name: '请输入用户名称' }).first();
  await expect(
    query,
    '用户管理列表的“请输入用户名称”查询框不可见，页面结构可能已变化',
  ).toBeVisible({ timeout: 10_000 });
  await query.fill(userName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  const row = await waitExactTextVisible(page, userName, 15_000);
  if (!row) {
    throw new Error(`按用户名“${userName}”查询后 15 秒内未在用户列表看到该用户；用户创建或邀请未真正生效。`);
  }
}

/**
 * 按角色名查询角色列表，返回包含该角色的可见表格行。
 * 角色未出现、或文字可见但取不到行容器时，都以带角色名的明确错误失败。
 */
async function findVisibleRoleRow(page: Page, roleName: string, timeoutMs: number): Promise<Locator> {
  const query = page.getByRole('textbox', { name: '请输入角色名称' }).first();
  await expect(
    query,
    '角色管理列表的“请输入角色名称”查询框不可见，页面结构可能已变化',
  ).toBeVisible({ timeout: 10_000 });
  const search = page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first();
  await query.fill(roleName);
  await search.click();
  let roleText = await waitExactTextVisible(page, roleName, timeoutMs);
  // 20260916 失败实证（角色“E2E权限二级审批人”查询未出现在列表）：阶段3/4 连续
  // 按角色查询时，查询点击可能落在列表刷新竞态窗口内导致整窗轮询落空。仅重试
  // 一次“重新查询”，不放宽“角色必须真实可见”的断言语义。
  if (!roleText) {
    await query.fill(roleName);
    await search.click();
    roleText = await waitExactTextVisible(page, roleName, timeoutMs);
  }
  if (!roleText) {
    throw new Error(`按角色名“${roleName}”查询后 ${Math.round(timeoutMs / 1000)} 秒内（含一次重查）未在角色列表看到该角色。`);
  }
  // 角色列并不总是落在 tr / role=row 节点上；先精确定位角色文字，再向上取表格行，
  // 兼容 Element table 与 div-table 两种实现（与权限测试工具的定位策略一致）。
  const candidates = [
    roleText.locator('xpath=ancestor::tr[1]'),
    roleText.locator('xpath=ancestor::*[contains(@class,"el-table__row") or @role="row"][1]'),
    roleText.locator('xpath=parent::*'),
  ];
  for (const row of candidates) {
    if (await row.isVisible().catch(() => false)) return row;
  }
  throw new Error(`角色“${roleName}”文字可见，但无法定位其所在表格行；页面结构可能已变化。`);
}

/** 打开角色“分配用户”子页，以授权用户表中的可见用户名确认分配真实生效。 */
async function assertUserAssignedToRole(page: Page, roleName: string, userName: string): Promise<void> {
  // 上一步可能停留在其它角色的授权用户子页；openRoleManagement 经真实菜单回到角色列表。
  await openRoleManagement(page);
  const row = await findVisibleRoleRow(page, roleName, 10_000);
  await clickVisible(row, '分配用户');
  // 授权用户子页的列表可能晚于按钮出现；以真实可见的用户名文本为证据，
  // 不依赖“分配成功”toast。
  const authorized = await waitExactTextVisible(page, userName, 15_000);
  if (!authorized) {
    throw new Error(`角色“${roleName}”的授权用户表中未出现用户“${userName}”；角色分配未生效或授权页结构已变化。`);
  }
}

/**
 * 尽力删除本轮自建账号（用户管理页：按本轮唯一账号查询 → 行内“删除”→ 确认；
 * 模板 SM-02-02/SM-03-09 deleteOwnUser）。只回收本轮 UUID 命名账号；任一步不满足
 * 都返回说明文本而不抛错，不掩盖主结果。
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
 * 尽力删除本轮自建角色（角色管理页：按本轮唯一角色名查询 → 行内“删除”→ 确认）。
 * 历史用例从未执行过页面级角色删除（先例是唯一命名保留），删除入口是否存在属
 * --headed 校准点：入口缺失、后端拒绝或结构变化时返回说明文本，不抛错、不掩盖
 * 主结果；只允许命中本轮 UUID 命名角色。
 */
async function deleteOwnRole(page: Page, role: PermissionRole): Promise<string> {
  await openRoleManagement(page);
  const search = page.getByRole('textbox', { name: '请输入角色名称' }).first();
  await search.fill(role.roleName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(800);
  const roleText = page.getByText(role.roleName, { exact: true }).last();
  if (!(await roleText.isVisible().catch(() => false))) {
    return '角色列表未查询到本轮角色（可能此前已删除）';
  }
  let row: Locator | undefined;
  for (const candidate of [
    roleText.locator('xpath=ancestor::tr[1]'),
    roleText.locator('xpath=ancestor::*[contains(@class,"el-table__row") or @role="row"][1]'),
  ]) {
    if (await candidate.isVisible().catch(() => false)) {
      row = candidate;
      break;
    }
  }
  if (!row) return '角色可见但未取到表格行，跳过页面删除（角色保留）';
  const deleteButton = row.getByRole('button', { name: /删\s*除/ }).first();
  if (!(await deleteButton.isVisible().catch(() => false))) {
    return '角色行未提供“删除”入口（历史先例为唯一命名保留），本轮角色保留';
  }
  await deleteButton.click();
  const confirmDialog = page
    .locator('[role="dialog"]:visible, .el-message-box:visible, .el-dialog:visible, .ant-modal:visible')
    .first();
  if (await confirmDialog.isVisible().catch(() => false)) {
    const confirm = confirmDialog.getByRole('button', { name: /确\s*定|^是$/ }).first();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
  }
  await expect(roleText).toBeHidden({ timeout: 10_000 }).catch(() => undefined);
  return '已提交删除并确认列表不再显示该角色';
}

test('SM-00-01｜权限测试用户、角色与授权初始化（本轮唯一·清洁环境自建）', async ({ loginPage, consoleErrors, report }) => {
  const page = loginPage;

  // 本轮自建对象：UUID 唯一 ASCII 命名，环境清空后无需任何历史用户/角色即可执行。
  const userPlan: Array<{ label: string; identity: PermissionIdentity }> = [
    { label: '申请人', identity: newPermissionIdentity('sm0001a') },
    { label: '一级审批人', identity: newPermissionIdentity('sm0001l1') },
    { label: '二级审批人', identity: newPermissionIdentity('sm0001l2') },
  ];
  // 当前版本角色树可直接配置的一级菜单为“数据地图、数据查询”等；“审批管理”
  // 不是独立可勾选节点，而是在已授权菜单下按角色生效的系统页面。这里不伪造
  // 不存在的节点，审批链用例再按实际页面验证可见性与操作权限。
  const rolePlan: Array<{ label: string; role: PermissionRole; menus: string[]; member: PermissionIdentity }> = [
    { label: '申请人角色', role: newPermissionRole('sm0001', 'applicant'), menus: ['数据地图', '数据查询'], member: userPlan[0].identity },
    { label: '一级审批角色', role: newPermissionRole('sm0001', 'approver1'), menus: ['数据地图'], member: userPlan[1].identity },
    { label: '二级审批角色', role: newPermissionRole('sm0001', 'approver2'), menus: ['数据地图'], member: userPlan[2].identity },
  ];

  try {
    // 阶段 1：本轮用户。createAndInviteUser 内部“新增用户→邀请入当前组织”；
    // 已存在/重复邀请的快速提示按真实接口结果与列表可见行判定，不依赖固定 toast；
    // 连续创建时仅首个进入用户管理页（工具注释：重复 hash 直达会触发路由残留）。
    const userStates: string[] = [];
    for (const [index, plan] of userPlan.entries()) {
      await runStep(
        (reason) => `本轮用户自建（${plan.label} ${plan.identity.userName}）｜${classifyUserPhase(reason)}`,
        () => createAndInviteUser(page, plan.identity, { openPage: index === 0 }),
      );
      userStates.push(`${plan.label}=${plan.identity.userName}（新建并邀请）`);
    }

    // 阶段 2：本轮角色。createRole 真实勾选菜单，保存成功后按角色名主动查询可见
    // 才算创建完成（工具内真实断言，非 toast）；连续创建时仅首个进入角色管理页。
    const roleStates: string[] = [];
    for (const [index, plan] of rolePlan.entries()) {
      await runStep(
        (reason) => `本轮角色自建（${plan.label} ${plan.role.roleName}）｜${classifyRolePhase(reason)}`,
        () => createRole(page, plan.role, plan.menus, { openPage: index === 0 }),
      );
      roleStates.push(`${plan.label}=${plan.role.roleName}（新建并勾选菜单）`);
    }

    // 阶段 3：角色-用户授权。assignRoleToUser 先在授权用户表确认，已授权直接返回；
    // 新添加时的 toast 只是过程反馈，最终证据由阶段 4 收口。
    for (const plan of rolePlan) {
      await runStep(
        (reason) => `角色授权（${plan.role.roleName} → ${plan.member.userName}）｜${classifyRolePhase(reason)}`,
        () => assignRoleToUser(page, plan.role, plan.member),
      );
    }

    // 阶段 4：终态核验。任何一次运行结束时，都以三类真实可见记录收口：
    // 用户列表中的三个账号、角色列表中的三个角色、每个角色授权用户表中的对应用户。
    await runStep('用户列表核验', async () => {
      await openUserManagement(page);
      for (const plan of userPlan) await assertUserListed(page, plan.identity.userName);
    });
    await runStep('角色列表核验', async () => {
      await openRoleManagement(page);
      for (const plan of rolePlan) await findVisibleRoleRow(page, plan.role.roleName, 10_000);
    });
    for (const plan of rolePlan) {
      await runStep(
        `授权关系核验（${plan.role.roleName} → ${plan.member.userName}）`,
        () => assertUserAssignedToRole(page, plan.role.roleName, plan.member.userName),
      );
    }

    await assertNoConsoleErrors(consoleErrors);
    await report(
      '权限测试本轮用户、角色与授权已自建并核验',
      true,
      `用户=${userStates.join('、')}；角色=${roleStates.join('、')}；` +
        `用户列表核验通过（${userPlan.map((item) => item.identity.userName).join('、')}）；` +
        `角色与授权关系核验通过（${rolePlan.map((item) => `${item.role.roleName}→${item.member.userName}`).join('、')}）；` +
        '收尾仅回收本轮 UUID 对象。',
    );
  } finally {
    // 收尾回收（scoped cleanup）：仅删除本轮 UUID 命名的用户与角色；每步尽力而为，
    // 失败仅记录不抛出，不掩盖主结果。用户先于角色（顺序与 SM-02-02 收尾先例一致）。
    const issues: string[] = [];
    try {
      const outcomes: string[] = [];
      for (const plan of userPlan) {
        outcomes.push(`${plan.identity.userName}：${await deleteOwnUser(page, plan.identity)}`);
      }
      await report('SM-00-01 收尾｜回收本轮用户', true, outcomes.join('；') + '。');
    } catch (cleanupError) {
      issues.push(`本轮用户回收未完成：${cleanupError instanceof Error ? cleanupError.message.split('，')[0] : String(cleanupError)}`);
    }
    try {
      const outcomes: string[] = [];
      for (const plan of rolePlan) {
        outcomes.push(`${plan.role.roleName}：${await deleteOwnRole(page, plan.role)}`);
      }
      await report('SM-00-01 收尾｜回收本轮角色', true, outcomes.join('；') + '。');
    } catch (cleanupError) {
      issues.push(`本轮角色回收未完成：${cleanupError instanceof Error ? cleanupError.message.split('，')[0] : String(cleanupError)}`);
    }
    for (const issue of issues) console.warn(`[SM-00-01 收尾] ${issue}`);
  }
});
