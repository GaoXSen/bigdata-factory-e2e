import { expect, Page, Locator } from '@playwright/test';
import { loginWithCredentials, uuid } from '../utils.js';
import { clickVisible, expectSuccess, visible, visibleDialog } from '../抽样用例工具.js';
import { MenuNavigator } from '../菜单导航工具.js';

export interface PermissionIdentity {
  userName: string;
  nickname: string;
  password: string;
  phone: string;
  email: string;
}

export interface PermissionRole {
  roleName: string;
  roleKey: string;
}

export const permissionPassword = process.env.SM_PERMISSION_PASSWORD?.trim() || '';

/**
 * 固定的权限测试资产。它们不是一次性垃圾数据：初始化用例首次创建并授予最小
 * 菜单权限，后续权限、审批和表权限用例全部复用，避免每轮生成一批 UUID 用户。
 */
export const permissionFixtures = {
  applicant: {
    // 2026-09-21：旧固定角色创建于菜单树调整前；复用时不会回补菜单。
    // 换一组版本化夹具重新按当前树授权，保留旧用户/角色，不删除历史数据。
    userName: 'e2e_perm_req_v2',
    nickname: 'E2E权限申请人V2',
    password: permissionPassword,
    phone: '18654235891',
    email: 'e2e_perm_req_v2@northking.test',
  },
  approverLevel1: {
    userName: 'e2e_perm_l1_v2',
    nickname: 'E2E权限一级审批人V2',
    password: permissionPassword,
    phone: '18654235892',
    email: 'e2e_perm_l1_v2@northking.test',
  },
  approverLevel2: {
    userName: 'e2e_perm_l2_v2',
    nickname: 'E2E权限二级审批人V2',
    password: permissionPassword,
    phone: '18654235893',
    email: 'e2e_perm_l2_v2@northking.test',
  },
  roles: {
    applicant: { roleName: 'E2E权限申请人V2', roleKey: 'e2e_perm_req_v2' },
    approverLevel1: { roleName: 'E2E权限一级审批人V2', roleKey: 'e2e_perm_l1_v2' },
    approverLevel2: { roleName: 'E2E权限二级审批人V2', roleKey: 'e2e_perm_l2_v2' },
  },
} as const satisfies {
  applicant: PermissionIdentity;
  approverLevel1: PermissionIdentity;
  approverLevel2: PermissionIdentity;
  roles: Record<string, PermissionRole>;
};

export function newPermissionIdentity(caseKey: string): PermissionIdentity {
  const suffix = uuid();
  const digits = String(parseInt(suffix, 16) % 100000).padStart(5, '0');
  return {
    // 页面限制用户名长度为 2～20；保留用例前缀和 UUID，但不把描述性文字原样塞进账号。
    userName: `e2e_${caseKey.slice(0, 6)}_${suffix}`,
    nickname: `e2e_auth_${caseKey}_${suffix}`,
    password: permissionPassword,
    phone: process.env.SM_USER_PHONE ?? `186542${digits}`,
    email: process.env.SM_USER_EMAIL ?? `75421${digits}@qq.com`,
  };
}

export function newPermissionRole(caseKey: string, level: string): PermissionRole {
  const suffix = uuid();
  return {
    roleName: `r_${caseKey.slice(0, 5)}_${level.slice(0, 2)}_${suffix}`,
    roleKey: `r_${caseKey.slice(0, 5)}_${level.slice(0, 2)}_${suffix}`,
  };
}

export async function openSystemPage(page: Page, route: string): Promise<void> {
  const systemSidebarReady = async () => {
    const approval = page.getByText('审批管理', { exact: true }).last();
    const permissions = page.getByText('用户权限', { exact: true }).last();
    return (await approval.isVisible().catch(() => false)) || (await permissions.isVisible().catch(() => false));
  };

  // “系统管理”在当前前端被折叠进顶栏“···”。优先真实点击该入口；若溢出
  // 菜单的 DOM 形态变化导致通用导航无法命中，再用目标 hash 兜底，随后仍以
  // 系统管理左侧栏真实出现作为成功条件，不能只看 URL。
  if (!(await systemSidebarReady())) {
    let openedFromOverflow = false;
    const overflow = await visible(
      page.getByRole('menuitem', { name: /^(?:···|…|\.\.\.|更多)$/ }),
    ) ?? await visible(page.getByText(/^(?:···|…|\.\.\.|更多)$/, { exact: true }));
    if (overflow) {
      await overflow.click().catch(() => undefined);
      await page.waitForTimeout(500);
      const system = await visible(page.getByText('系统管理', { exact: true }));
      if (system) {
        await system.click().catch(() => undefined);
        openedFromOverflow = true;
        await page.waitForTimeout(800);
      }
    }
    if (!openedFromOverflow || !(await systemSidebarReady())) {
      // 保留旧导航器作为第二个 UI 路径，兼容“更多”浮层不带标准 role 的版本。
      await new MenuNavigator(page).clickPath('系统管理').catch(() => undefined);
      await page.waitForTimeout(500);
    }
    if (!(await systemSidebarReady())) {
      const baseUrl = page.url().split('#')[0];
      await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);
    }
    await expect.poll(systemSidebarReady, { timeout: 15_000 }).toBe(true);
  }

  const leafByRoute: Record<string, string> = {
    '#/systemManage/userPermission/userManage': '用户管理',
    '#/systemManage/userPermission/roleManage': '角色管理',
    '#/systemManage/userPermission/dataPermission': '数据权限',
  };
  const leafName = leafByRoute[route];
  if (!leafName) throw new Error(`未登记的系统管理路由：${route}`);

  const permissionGroup = page.getByText('用户权限', { exact: true }).last();
  if (await permissionGroup.isVisible().catch(() => false)) {
    await permissionGroup.click();
    await page.waitForTimeout(250);
  }
  const leaf = page.getByText(leafName, { exact: true }).last();
  await expect(leaf, `系统管理左侧未出现“${leafName}”`).toBeVisible({ timeout: 10_000 });
  await leaf.click();
  await expect.poll(() => page.url(), { timeout: 15_000 }).toContain(route.slice(1));
}

export async function openUserManagement(page: Page): Promise<void> {
  // 当前前端已将“系统管理”从顶栏收进数据治理模块，顶栏菜单文字不再稳定；
  // 用户管理的实际 hash 路由保持不变。连续创建用户时直接进入该路由，避免
  // 第二个用户开始因菜单不可见而中断。
  await openSystemPage(page, '#/systemManage/userPermission/userManage');
  await expect.poll(() => page.url(), { timeout: 20_000 }).toContain('/systemManage/userPermission/userManage');
  await expect(page.getByRole('button', { name: '新增用户' })).toBeVisible({ timeout: 30_000 });
}

export async function openRoleManagement(page: Page): Promise<void> {
  await openSystemPage(page, '#/systemManage/userPermission/roleManage');
  await expect.poll(() => page.url(), { timeout: 20_000 }).toContain('/systemManage/userPermission/roleManage');
  await expect(page.getByRole('button', { name: /新建/ })).toBeVisible({ timeout: 30_000 });
}

async function chooseVisibleOrganization(page: Page): Promise<void> {
  const select = page.getByRole('textbox', { name: '请选择组织' }).last();
  await select.click();
  const configured = (process.env.SM_PERMISSION_ORG_NAMES ?? '测试管理员,简单用户组,简单用户,hive流程审批组织')
    .split(',').map((item) => item.trim()).filter(Boolean);
  const options = page.getByRole('listitem');
  let selected = false;
  for (const name of configured) {
    const option = options.filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}$`) }).last();
    if (await option.isVisible().catch(() => false)) {
      await option.click();
      selected = true;
      break;
    }
  }
  if (!selected) throw new Error('权限测试用户没有可用组织；请先在组织管理中准备测试组织。');
  // Element 多选下拉在选中后可能继续占据浮层层级。这里不能用“包含确定取消
  // 的外层 div”去点击确认，因为它有时会误命中用户新增弹窗的提交按钮；
  // 只收起下拉，组织值由主表单的确定按钮一次提交。
  await page.waitForTimeout(350);
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.locator('.el-select-dropdown:visible, .ant-select-dropdown:visible').press('Escape').catch(() => undefined);
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.mouse.move(0, 0);
}

export async function createAndInviteUser(
  page: Page,
  identity: PermissionIdentity,
  options: { openPage?: boolean; assignOrganization?: boolean } = {},
): Promise<void> {
  // 新用户连续创建时已经停留在用户管理页，重复用 hash 直达会触发当前前端
  // 的路由组件残留（URL 正确但仍渲染“文件接入”）。仅在首个对象时进入页面。
  if (options.openPage !== false) await openUserManagement(page);
  await clickVisible(page, '新增用户');
  const dialog = await visibleDialog(page);
  await dialog.getByPlaceholder('请输入用户名称').fill(identity.userName);
  await page.getByRole('textbox', { name: '请输入用户昵称' }).last().fill(identity.nickname);
  await dialog.getByPlaceholder('请输入手机号码').fill(identity.phone);
  await page.getByRole('textbox', { name: '请输入邮箱' }).last().fill(identity.email);
  await page.getByRole('textbox', { name: '请输入用户密码' }).last().fill(identity.password);
  const gender = page.getByRole('textbox', { name: '请选择性别' }).last();
  if (await gender.isVisible().catch(() => false)) {
    await gender.click();
    const male = page.getByRole('listitem').filter({ hasText: /^男$/ }).last();
    if (await male.isVisible().catch(() => false)) await male.click();
  }
  // “新增用户”与“邀请用户”是两段业务：新增时不指定组织，由邀请操作写入
  // 当前活动组织。若先选组织，后台已经创建用户—组织关系，邀请会被判为重复。
  if (options.assignOrganization === true) await chooseVisibleOrganization(page);
  await page.mouse.move(0, 0);
  await dialog.getByRole('button', { name: /^确\s*定$/ }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expectSuccess(page, /成功|新增/);

  const invitation = await inviteUserToCurrentOrganization(page, identity);
  if (invitation === 'not-found') {
    throw new Error(`新建用户“${identity.userName}”未出现在邀请候选列表中，不能确认其已加入当前组织。`);
  }
  const row = await findUserRow(page, identity.userName);
  if (!row) throw new Error(`用户“${identity.userName}”邀请后未出现在当前组织用户列表中。`);
}

/**
 * 将一个全局用户加入当前登录组织。
 * 返回 not-found 表示该账号尚未创建；already-in-current-org 表示接口拒绝了重复
 * 邀请，但列表已验证该用户本来就在当前组织，因此仍可安全复用。
 */
async function inviteUserToCurrentOrganization(
  page: Page,
  identity: PermissionIdentity,
): Promise<'invited' | 'already-in-current-org' | 'not-found'> {
  await clickVisible(page, '邀请用户');
  const invite = await visibleDialog(page);
  const inviteSelector = invite.getByRole('textbox', { name: '请选择用户' });
  await inviteSelector.click();
  // 邀请下拉默认只加载前几条用户；必须输入本轮唯一账号进行远程筛选，
  // 不能假定新建用户刚好在第一页。
  await inviteSelector.fill(identity.userName);
  await page.waitForTimeout(500);
  // 邀请下拉在当前前端会截断较长昵称（例如只显示 e2e_auth_sm00_applicant_be66c4），
  // 不能再把完整“用户名(昵称)”作为可见文本断言。用户名是本轮唯一值，按它定位
  // 既能适配截断展示，也不会误邀请其它用户。
  const option = page.getByRole('listitem').filter({ hasText: new RegExp(identity.userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).last();
  if (!(await option.isVisible({ timeout: 3_000 }).catch(() => false))) {
    await invite.getByRole('button', { name: /取\s*消|Close/ }).first().click().catch(() => undefined);
    return 'not-found';
  }
  await option.click();
  // 提示文案可能瞬间消失，因此先监听真实接口结果；它能明确区分成功和重复邀请。
  const inviteResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && /\/systemUser\/inviteUser(?:\?|$)/.test(response.url()),
    { timeout: 10_000 },
  ).catch(() => undefined);
  await invite.getByRole('button', { name: /^确\s*定$/ }).click();
  const response = await inviteResponse;
  if (response) {
    const responseText = await response.text().catch(() => '');
    if (/邀请用户已存在当前组织|重复邀请/.test(responseText)) {
      await invite.getByRole('button', { name: /取\s*消|Close/ }).first().click().catch(() => undefined);
      return 'already-in-current-org';
    }
    if (response.ok() && /(?:"code"\s*:\s*(?:0|200)|"success"\s*:\s*true|成功)/.test(responseText)) {
      await expect(invite).toBeHidden({ timeout: 10_000 });
      return 'invited';
    }
  }
  // 不能用“邀请”作为成功关键词：后端的“邀请用户已存在当前组织”是业务拒绝，
  // 文本同样含“邀请”。只接受 success 样式或明确的“操作成功/邀请成功”。
  const success = page.locator(
    '.el-message--success:visible, .ant-message-success:visible, [role="alert"][data-type="success"]:visible',
  ).filter({ hasText: /成功/ }).last();
  if (await success.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await expect(invite).toBeHidden({ timeout: 10_000 });
    return 'invited';
  }
  // 失败提示（特别是“已在当前组织”）可能很快消失。关闭弹窗后以用户列表
  // 为准：列表能查到即说明当前组织关系已满足，属于可复用状态而不是用例失败。
  if (await invite.isVisible().catch(() => false)) {
    await invite.getByRole('button', { name: /取\s*消|Close/ }).first().click().catch(() => undefined);
  }
  return (await findUserRow(page, identity.userName)) ? 'already-in-current-org' : 'not-found';
}

async function findUserRow(page: Page, userName: string): Promise<Locator | undefined> {
  const query = page.getByRole('textbox', { name: '请输入用户名称' }).first();
  await query.fill(userName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  // 用户列表在当前版本同时存在 Element Table 与 div-table 两种实现；新增/邀请后
  // 还会异步刷新，不能把固定 3 秒内没有 tr 行误判为未加入组织。用户名是唯一值，
  // 以真正可见的单元格为准，并在成功接口后的合理窗口内轮询。
  const userTexts = page.getByText(userName, { exact: true });
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    for (let index = await userTexts.count() - 1; index >= 0; index -= 1) {
      const text = userTexts.nth(index);
      if (await text.isVisible().catch(() => false)) return text;
    }
    await page.waitForTimeout(250);
  }
  return undefined;
}

/** 首次创建并归属到测试组织，后续运行只复用，绝不删除。 */
export async function ensurePermissionUser(
  page: Page,
  identity: PermissionIdentity,
  options: { openPage?: boolean } = {},
): Promise<'created' | 'reused'> {
  if (!identity.password) {
    throw new Error('缺少 SM_PERMISSION_PASSWORD：权限测试用户的登录口令必须由本机环境变量提供。');
  }
  if (options.openPage !== false) await openUserManagement(page);
  if (await findUserRow(page, identity.userName)) return 'reused';
  const existing = await inviteUserToCurrentOrganization(page, identity);
  if (existing !== 'not-found') return 'reused';
  await createAndInviteUser(page, identity, { openPage: false, assignOrganization: false });
  return 'created';
}

async function selectRoleMenu(page: Page, dialog: Locator, menuName: string): Promise<void> {
  const text = dialog.getByText(menuName, { exact: true }).last();
  if (!(await text.isVisible().catch(() => false))) {
    throw new Error(`角色菜单树未找到可选菜单“${menuName}”；不能静默创建无菜单角色。`);
  }
  let scope = text;
  for (let level = 0; level < 6; level += 1) {
    // Element Tree 的实际可点击对象是 tree-node__content，原生 checkbox 会被它
    // 拦截。直接对当前祖先范围内的原生 input 做 force check，既不会点到文字，
  // 也不会受浮层命中区域影响。
    const native = scope.locator('input[type="checkbox"]').first();
    if (await native.count()) {
      if (!(await native.isChecked().catch(() => false))) {
        // 该版本 Element UI 将真正的 change 事件绑定在 label.el-checkbox 上。
        // 直接 force check 原生 input 不会更新 Vue 状态，因此优先点击它的 label。
        const label = native.locator('xpath=ancestor::label[contains(@class,"el-checkbox")][1]').first();
        if (await label.count()) await label.click({ force: true });
        else await native.check({ force: true });
        await expect(native).toBeChecked({ timeout: 5_000 });
      }
      return;
    }
    scope = scope.locator('..');
  }
  await text.click();
}

export async function createRole(
  page: Page,
  role: PermissionRole,
  menuNames: string[] = [],
  options: { openPage?: boolean } = {},
): Promise<void> {
  if (options.openPage !== false) await openRoleManagement(page);
  await clickVisible(page, '新建');
  const dialog = await visibleDialog(page);
  await dialog.getByPlaceholder('请输入角色名称').fill(role.roleName);
  const key = dialog.getByPlaceholder('请输入权限字符');
  if (await key.isVisible().catch(() => false)) await key.fill(role.roleKey);
  for (const menuName of menuNames) await selectRoleMenu(page, dialog, menuName);
  await dialog.getByRole('button', { name: /^确\s*定$/ }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expectSuccess(page, /成功|新增|保存/);
  // 保存接口成功后，当前前端可能已发出一次早于 insert 返回的列表请求，页面会
  // 短暂保留旧页。按新角色名主动查询才是对创建结果的可靠验证。
  if (!(await findRoleRow(page, role.roleName))) {
    throw new Error(`角色“${role.roleName}”保存成功后未能从角色列表查询到。`);
  }
}

async function findRoleRow(page: Page, roleName: string): Promise<Locator | undefined> {
  const query = page.getByRole('textbox', { name: '请输入角色名称' }).first();
  const search = page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first();
  // 当前表格的角色名列并不总是落在 tr / role=row 节点上；旧定位因此把截图中
  // 明明已存在的“E2E权限申请人”误判为不存在，继而重复点击新建。先精确定位
  // 角色文字，再向上取当前表格行，兼容 Element table 和 div-table 两种实现。
  const pollRoleText = async (timeoutMs: number): Promise<Locator | undefined> => {
    const roleTexts = page.getByText(roleName, { exact: true });
    let roleText: Locator | undefined;
    const deadline = Date.now() + timeoutMs;
    while (!roleText && Date.now() < deadline) {
      const count = await roleTexts.count();
      for (let index = count - 1; index >= 0; index -= 1) {
        if (await roleTexts.nth(index).isVisible().catch(() => false)) {
          roleText = roleTexts.nth(index);
          break;
        }
      }
      if (!roleText) await page.waitForTimeout(200);
    }
    return roleText;
  };
  await query.fill(roleName);
  await search.click();
  let roleText = await pollRoleText(8_000);
  // 20260916 SM-00-01 失败实证（角色“E2E权限二级审批人”创建/查询后未出现在列表）：
  // 连续处理多个角色时，查询点击可能落在列表刷新/上一弹窗关闭的竞态窗口内，单次
  // 轮询落空即误报。仅重试一次“重新查询”，不放宽“角色必须真实出现”的断言语义。
  if (!roleText) {
    await query.fill(roleName);
    await search.click();
    roleText = await pollRoleText(10_000);
  }
  if (!roleText) return undefined;
  const candidates = [
    roleText.locator('xpath=ancestor::tr[1]'),
    roleText.locator('xpath=ancestor::*[contains(@class,"el-table__row") or @role="row"][1]'),
    roleText.locator('xpath=parent::*'),
  ];
  for (const row of candidates) {
    if (await row.isVisible().catch(() => false)) return row;
  }
  return undefined;
}

/** 首次创建固定角色并记录菜单权限，后续运行直接复用已有角色。 */
export async function ensurePermissionRole(
  page: Page,
  role: PermissionRole,
  menuNames: string[],
  options: { openPage?: boolean } = {},
): Promise<'created' | 'reused'> {
  if (options.openPage !== false) await openRoleManagement(page);
  if (await findRoleRow(page, role.roleName)) return 'reused';
  await createRole(page, role, menuNames, { openPage: false });
  return 'created';
}

export async function assignRoleToUser(page: Page, role: PermissionRole, identity: PermissionIdentity): Promise<void> {
  await openRoleManagement(page);
  // 初始化会连续创建三个角色，页面会保留上一个角色的查询条件；不能直接
  // 从当前列表找目标角色，必须先按本次角色名查询。
  const row = await findRoleRow(page, role.roleName);
  if (!row) throw new Error(`角色“${role.roleName}”创建/查询后未出现在角色列表中。`);
  await clickVisible(row, '分配用户');
  // “分配用户”先进入角色的授权用户子页，点击“添加用户”后才出现选择用户弹窗。
  // 旧版代码把第一步误当成弹窗，导致已经进入授权页仍白等 10 秒。
  // 已授权用户不会再出现在“添加用户”的候选列表中。初始化用例是可重复执行的，
  // 因此必须先检查当前角色的已授权用户表；否则第二次运行会把正常复用误判为
  // “候选用户不存在”。
  // 授权用户页存在 Element Table / div-table 两种渲染；不要只依赖 tr / role=row。
  // 刚进入子页时列表也可能晚于“添加用户”按钮出现，给它短暂的稳定窗口。
  const existingUsers = page.getByText(identity.userName, { exact: true });
  const existingDeadline = Date.now() + 6_000;
  while (Date.now() < existingDeadline) {
    for (let index = await existingUsers.count() - 1; index >= 0; index -= 1) {
      if (await existingUsers.nth(index).isVisible().catch(() => false)) return;
    }
    await page.waitForTimeout(200);
  }
  const addUser = await visible(page.getByRole('button', { name: /添加用户/ }));
  if (!addUser) throw new Error('角色授权用户页没有找到“添加用户”按钮。');
  // 当前页的“添加用户”会打开独立选择用户窗口。页面偶发在子页刚加载时吞掉
  // 第一次 click，因此仅在窗口未出现时重试一次，不把它误判成权限/用户问题。
  await addUser.click();
  let dialog = await visible(page.locator('[role="dialog"], .el-dialog, .ant-modal'));
  if (!dialog) {
    await page.waitForTimeout(400);
    await addUser.click({ force: true });
    dialog = await visible(page.locator('[role="dialog"], .el-dialog, .ant-modal'));
  }
  if (!dialog) {
    throw new Error('点击“添加用户”后未出现选择用户窗口；请确认当前前端是否仍以弹窗方式分配角色用户。');
  }
  // 选择窗口默认只显示当前页（截图中共 49 条），固定夹具用户不保证在首页。
  // 必须先在弹窗内按用户名查询，再勾选左侧复选框；直接找文本会把分页问题
  // 误判成“用户不存在”。
  const query = dialog.getByRole('textbox', { name: '请输入用户名称' }).first();
  if (await query.isVisible().catch(() => false)) {
    await query.fill(identity.userName);
    await clickVisible(dialog, /查\s*询|搜\s*索/, { timeoutMs: 5_000 });
  }
  const user = dialog.getByText(identity.userName, { exact: true }).last();
  await expect(user).toBeVisible({ timeout: 10_000 });
  const checkbox = await visible(user.locator('xpath=ancestor::*[self::tr or @role="row" or contains(@class,"tree-node")][1]')
    .locator('input[type="checkbox"], .el-checkbox, .ant-checkbox'));
  if (checkbox) await checkbox.click(); else await user.click();
  await dialog.getByRole('button', { name: /^确\s*定$/ }).last().click();
  await expectSuccess(page, /成功|保存|授权/);
}

export async function loginAs(
  page: Page,
  identity: PermissionIdentity,
  options: { entryUrl?: string; fallbackEntryUrls?: string[] } = {},
): Promise<void> {
  await page.context().clearCookies();
  // 当前应用把登录令牌保存在 localStorage；仅清 Cookie 后再次访问入口会直接复用
  // 管理员会话，表面上完成了“登录”，实际账号却没有切换。先清同源持久化状态，
  // 再复用正式登录表单，才能验证菜单权限真正作用于目标用户。
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  }).catch(() => undefined);
  // 仅在当前 SPA 中跳转入口时，Vuex 仍可能保留管理员菜单，
  // loginWithCredentials 会因已见主导航而提前返回，根本不会提交目标用户的凭据。
  // 先离开当前文档，确保后续从入口加载的是一个全新的应用实例。
  await page.goto('about:blank');
  await loginWithCredentials(page, {
    username: identity.userName,
    password: identity.password,
    entryUrl: options.entryUrl,
    fallbackEntryUrls: options.fallbackEntryUrls,
  });
  // loginWithCredentials 已从稳定入口重新完成了整次 SPA 初始化。额外 reload 当前
  // hash 地址会在新前端偶发落到 404（实际失败快照已证实），反而覆盖了刚建立的新用户
  // 会话；因此直接校验当前页面的身份信息。
  await expect.poll(
    async () => (await page.locator('body').innerText().catch(() => '')).includes(identity.userName)
      || (await page.locator('body').innerText().catch(() => '')).includes(identity.nickname),
    { timeout: 20_000, message: `登录后页面未呈现目标用户“${identity.userName}”` },
  ).toBe(true);
}
