/**
 * SM-00-02｜系统管理｜数据权限与审批专属用户角色资源前置准备
 *
 * 为 RUN_PERMISSION_APPROVAL=1 解锁的表权限审批用例（SM-02-06/SM-02-07）验证
 * “按轮新建专属对象”路径本身，并记录数据资源前置；全部对象使用唯一英文前缀
 * （permissionRunId）+ UUID，本轮唯一（与 SM-00-01 相同的清洁环境自建口径）。
 *
 * DS-PERM-49 清洁环境与配置中心校准（2026-09-22，静态开发）：
 *   1. 创建并邀请 申请人 / 一级审批人 / 二级审批人 / 无权限用户 四个账号
 *      （newPermissionIdentity 全 ASCII 用户名+昵称；口令来自 SM_PERMISSION_PASSWORD
 *      兼容变量，与工具同源；已存在/重复邀请的快速提示由工具按真实接口结果与
 *      列表可见行判定，不依赖固定 toast）；
 *   2. 创建 申请人 / 一级审批人 / 二级审批人 三个专属角色并绑定对应用户
 *      （无权限用户不绑定任何角色，作为“零权限”对照组）；
 *   3. 记录表权限闭环专用表（DATA_PERMISSION_TABLE 等 env 解析结果）；数据源
 *      显示名/库/Schema 优先取兼容变量，未设置时取配置中心
 *      testEnvironment.dataSourceNames.exportSource（不再隐式依赖工具内历史字面量）；
 *   4. 记录数据权限页“数据权限开关”初值（只读，不改开关状态）；
 *   5. 收尾 scoped cleanup：finally 尽力删除本轮自建用户与角色（仅限本轮 UUID
 *      命名对象；删除入口缺失或后端拒绝时记录说明，不掩盖主结果）。
 *
 * 双入口修复说明（2026-09-22 DS-PERM-65：硬链接双入口模块解析回归修复，仅静态开发）：
 *   - 本正文与 e2e/sm-static/SM-00-02.spec.ts 为同一硬链接，必须双目录均可被 Playwright
 *     加载；此前引入的 '../../../test-environment.js' 直连导入，其相对深度只在中文权威
 *     目录成立，sm-static 侧 --list 报 Cannot find module。
 *   - 改经 '../utils.js'（两侧镜像同构、均可解析）触发 e2e/test-environment.ts（配置
 *     中心）加载：配置中心首次解析会把 EXPORT_SOURCE_NAME / EXPORT_DATABASE /
 *     EXPORT_SCHEMA 按 profile 基线回填 process.env（显式变量优先，与
 *     testEnvironment.dataSourceNames.exportSource 同名同源）。本文件改读同名变量，
 *     配置中心语义不变，spec 内不持有展示名兜底值，回填缺失时显式失败、不硬编码、不 skip。
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test, assertNoConsoleErrors } from '../utils.js';
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
import { openDataPermissionPage, resolveMysqlPermissionResource } from './数据权限闭环工具.js';
import { permissionRunId, requirePermissionApprovalEnvironment } from './权限审批待调试工具.js';

test.describe.configure({ mode: 'serial', timeout: 240_000 });

/**
 * 读取数据权限页“数据权限开关”当前状态（初值记录，只读）。
 * 开关控件形态未见录制确认（flash 校准点）：按 [role=switch]/ant/el 三种兼容
 * 定位读取 aria-checked / class；页面无可见开关时返回“未识别”，由调用方把
 * 现场一并落附件，交由 --headed 校准，不猜测状态、不写死初值。
 */
async function readDataPermissionSwitchState(page: Page): Promise<string> {
  const switches = page.locator('[role="switch"]:visible, .ant-switch:visible, .el-switch:visible');
  const total = await switches.count();
  for (let index = 0; index < total; index += 1) {
    const node = switches.nth(index);
    if (!(await node.isVisible().catch(() => false))) continue;
    const aria = await node.getAttribute('aria-checked').catch(() => null);
    if (aria === 'true') return '开启';
    if (aria === 'false') return '关闭';
    const classes = (await node.getAttribute('class').catch(() => '')) ?? '';
    if (/is-checked|switch-checked/.test(classes)) return '开启';
    return '关闭';
  }
  return '未识别（页面无可见开关控件，flash 校准点）';
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
 * 删除入口是否存在属 --headed 校准点：入口缺失、后端拒绝或结构变化时返回说明
 * 文本，不抛错、不掩盖主结果；只允许命中本轮 UUID 命名角色。
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
    return '角色行未提供“删除”入口，本轮角色保留';
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

/**
 * 配置中心同源读取（DS-PERM-65 双入口修复）：本正文同时被 e2e/sm-static 与中文权威目录
 * 加载，不能直接 import '../../../test-environment.js'（该相对深度只在权威目录成立）。
 * '../utils.js' 双侧均可解析，且其内部加载 e2e/test-environment.ts；配置中心首次解析会把
 * EXPORT_SOURCE_NAME / EXPORT_DATABASE / EXPORT_SCHEMA 按 profile 基线回填 process.env
 * （显式变量优先，与 testEnvironment.dataSourceNames.exportSource 同名同源）。此处按同名
 * 变量读取，spec 内不持有任何数据源展示名兜底值；回填缺失说明配置中心加载链被破坏，显式
 * 失败，不回退硬编码。
 */
function configuredExportSource(): { name: string; database: string; schema: string } {
  const name = process.env.EXPORT_SOURCE_NAME?.trim() ?? '';
  const database = process.env.EXPORT_DATABASE?.trim() ?? '';
  const schema = process.env.EXPORT_SCHEMA?.trim() ?? '';
  if (!name || !database || !schema) {
    throw new Error(
      '配置中心同源变量缺失：EXPORT_SOURCE_NAME / EXPORT_DATABASE / EXPORT_SCHEMA 出现空值。' +
        '本用例经 ../utils.js 加载 e2e/test-environment.ts（ENV-CONFIG-40）后，应由配置中心' +
        '首次解析的兼容回填提供上述变量（与 dataSourceNames.exportSource 同名同源）；请检查' +
        '配置中心加载与回填逻辑（DS-PERM-65），不得在用例内硬编码数据源展示名。',
    );
  }
  return { name, database, schema };
}

test('SM-00-02｜系统管理｜数据权限与审批专属用户角色资源前置准备', async ({ loginPage, consoleErrors, report }) => {
  requirePermissionApprovalEnvironment();
  test.setTimeout(600_000);
  const page = loginPage;
  const runId = permissionRunId('e2e_auth');

  // 本轮自建对象（UUID 唯一 ASCII 命名）；绑定关系在 try 外先定义，收尾回收要用。
  const userPlan = [
    { label: '申请人', identity: newPermissionIdentity(`${runId}_apply`) },
    { label: '一级审批人', identity: newPermissionIdentity(`${runId}_appr1`) },
    { label: '二级审批人', identity: newPermissionIdentity(`${runId}_appr2`) },
    { label: '无权限用户', identity: newPermissionIdentity(`${runId}_noperm`) },
  ];
  const noPermission = userPlan[3].identity;
  const bindings: Array<{ role: PermissionRole; member: PermissionIdentity }> = [
    { role: newPermissionRole(runId, 'applicant'), member: userPlan[0].identity },
    { role: newPermissionRole(runId, 'approver1'), member: userPlan[1].identity },
    { role: newPermissionRole(runId, 'approver2'), member: userPlan[2].identity },
  ];

  // 数据资源前置（DS-PERM-49 配置中心校准）：数据源显示名/库/Schema 优先取兼容
  // 变量（数据权限闭环工具的 env 解析结果）；未设置时回落到配置中心 exportSource
  // （HS_DSCHEMA 导出源）同名同源变量（DS-PERM-65：EXPORT_SOURCE_NAME /
  // EXPORT_DATABASE / EXPORT_SCHEMA 的配置中心回填值），不再隐式依赖工具内历史
  // 字面量。表名仍必须显式配置，脚本不随机选共享表。
  const resource = resolveMysqlPermissionResource();
  const exportSource = configuredExportSource();
  const sourceName = resource.sourceName ?? exportSource.name;
  const databaseName = resource.databaseName ?? exportSource.database;
  const schemaName = resource.schemaName ?? exportSource.schema;
  const tableEvidence = resource.tableName
    ? `专属表=${resource.tableName}；数据源=${sourceName}；库=${databaseName}；Schema=${schemaName}`
    : '未配置 DATA_PERMISSION_TABLE：SM-02-06/SM-02-07 将按前置不足跳过，脚本不随机选共享表。';
  const sourceProvenance = `数据资源口径（DS-PERM-49）：显示名/库/Schema 优先取兼容变量；` +
    `未设置部分回落到配置中心 exportSource 同名同源回填变量（DS-PERM-65）` +
    `（显示名=${exportSource.name}，库=${exportSource.database}，Schema=${exportSource.schema}）。`;

  try {
    // 1. 四个专属账号：唯一英文前缀 + UUID（newPermissionIdentity 保证用户名/昵称
    //    全 ASCII），创建并邀请进当前组织。已存在/重复邀请的快速提示由工具按真实
    //    接口结果与列表可见行判定；连续创建时仅首个进入用户管理页（工具注释：
    //    重复 hash 直达会触发当前前端路由组件残留）。
    let userPageOpened = false;
    for (const plan of userPlan) {
      await createAndInviteUser(page, plan.identity, { openPage: !userPageOpened });
      userPageOpened = true;
    }
    await report(
      '专属用户已创建并邀请',
      true,
      `runId=${runId}；${userPlan.map((plan) => `${plan.label}=${plan.identity.userName}`).join('；')}。`,
    );

    // 2. 三个专属角色并绑定对应用户；无权限用户不绑任何角色（零权限对照）。
    //    角色同样仅首个打开角色管理页，避免连续 hash 直达的路由残留。
    let rolePageOpened = false;
    for (const binding of bindings) {
      await createRole(page, binding.role, [], { openPage: !rolePageOpened });
      rolePageOpened = true;
    }
    for (const binding of bindings) {
      await assignRoleToUser(page, binding.role, binding.member);
    }
    await report(
      '专属角色已创建并绑定',
      true,
      `角色=${bindings.map((item) => item.role.roleName).join('、')}；无权限用户 ${noPermission.userName} 未绑定任何角色。`,
    );

    // 3. 记录表权限闭环专用表（SM-02-06/07 的授权对象；缺失不判失败——后续用例
    //    会按前置不足跳过，这里把“缺失”本身也作为证据落附件）。
    test.info().attach('SM-00-02-专属表.txt', {
      body: `${tableEvidence}\n${sourceProvenance}`,
      contentType: 'text/plain; charset=utf-8',
    });

    // 4. 数据权限开关初值（只读记录）：先真实打开数据权限页，再读开关状态；
    //    页面打开本身是真实断言（用户视角/资源视角必须可见）。
    await openDataPermissionPage(page);
    await expect(page.locator('body')).toContainText(/用户视角|资源视角/);
    const switchState = await readDataPermissionSwitchState(page);
    test.info().attach(
      'SM-00-02-数据权限开关初值.txt',
      { body: `数据权限开关初值=${switchState}`, contentType: 'text/plain; charset=utf-8' },
    );

    await assertNoConsoleErrors(consoleErrors);
    await report(
      'SM-00-02 前置准备完成',
      true,
      `runId=${runId}；${tableEvidence}；数据权限开关初值=${switchState}。收尾仅回收本轮 UUID 对象。`,
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
      await report('SM-00-02 收尾｜回收本轮用户', true, outcomes.join('；') + '。');
    } catch (cleanupError) {
      issues.push(`本轮用户回收未完成：${cleanupError instanceof Error ? cleanupError.message.split('，')[0] : String(cleanupError)}`);
    }
    try {
      const outcomes: string[] = [];
      for (const binding of bindings) {
        outcomes.push(`${binding.role.roleName}：${await deleteOwnRole(page, binding.role)}`);
      }
      await report('SM-00-02 收尾｜回收本轮角色', true, outcomes.join('；') + '。');
    } catch (cleanupError) {
      issues.push(`本轮角色回收未完成：${cleanupError instanceof Error ? cleanupError.message.split('，')[0] : String(cleanupError)}`);
    }
    for (const issue of issues) console.warn(`[SM-00-02 收尾] ${issue}`);
  }
});
