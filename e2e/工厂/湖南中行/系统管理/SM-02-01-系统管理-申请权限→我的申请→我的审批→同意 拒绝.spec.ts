/**
 * SM-02-01｜系统管理｜申请权限 → 我的申请 → 我的审批 → 同意/拒绝（多级审批闭环）
 *
 * 静态开发依据（页面结构变化时按这些线索校准定位）：
 *   1. 申请入口：申请人登录 → 数据地图-表查询 搜索目标表 → 卡片/详情“申请权限”弹窗；
 *      弹窗含申请原因、截止时间（默认永久 2099-01-01）、逐级审批节点，“提交”后节点
 *      未选全会提示“还有 N 个审批节点未指定审批人”（temp/dq0301-14F-r1 trace 快照、
 *      归档表查询 Excel 行25 用例）。
 *   1a. 2026-09-17 实测弹窗结构升级：审批流程=规则预览（提交→第N审批人→结束）；
 *      用户型节点=禁用文本框（审批人由配置固定、不可修改）；角色型节点=“请选择
 *      审批人”下拉（候选=该节点配置角色的成员）；旧版“请选择用户”下拉保持兼容。
 *   2. 审批实例：表权限申请逐级审批（第一/第二/第三审批人），approveIdea 1=同意
 *      2=驳回；非最终节点同意只推进到下一审批人，最终节点同意才回写已通过，任一
 *      节点驳回即回写已驳回（run-20260915 trace 审批实例 JSON、权限与审批测试理解.md §5）。
 *   3. 我的申请/我的审批：#/systemManage/approvalManage/myApply|myExamine；页签
 *      未审批/已审批；查询字段“审批名称”；行内 同意/拒绝 → 确定 → 成功提示
 *      （归档 22_26_27_44-系统管理.spec.ts 行26/27）。
 *   4. 审批工作台入口：账号冷启动直达审批路由会被产品路由守卫重定向 404（角色动态
 *      路由在应用初始化完成后才注册）；先登录到该账号可达的数据地图-表查询页（与
 *      申请人发起申请同一入口），再做应用内 hash 直达，未呈现审批页签时用
 *      “系统管理→审批管理”真实菜单兜底（110 环境 20260920 run-212403-837 实证）。
 *
 * DS-PERM-32 清洁环境静态校准（2026-09-22，环境不可用，仅静态校准，不运行 Playwright）：
 *   解除全部历史固化资产依赖（不假设任何固定用户/角色/表/审批流/记录），改为本轮自备
 *   （全 ASCII 唯一）：
 *   - 主体：申请人/一级/二级审批人均为 newPermissionIdentity('sm0201*') UUID 唯一账号
 *     （管理员 createAndInviteUser 页面化创建，收尾尽力删除回收），不再依赖 SM-00-01
 *     幂等夹具 e2e_perm_req_v2/e2e_perm_l1_v2/e2e_perm_l2_v2；角色为本轮
 *     newPermissionRole 唯一角色并绑定（菜单按 SM-00-01 实证口径：申请人=数据地图+
 *     数据查询，审批人=数据地图；唯一命名，用后保留，先例 SM-00-02/DS-PERM-25）。
 *   - 目标表：e2e_sm0201t_<uuid>，MySQL 直连 CREATE TABLE（sm_id/sm_name/sm_value
 *     三列、2 行种子，COUNT=2 硬断言），不读 DATA_PERMISSION_TABLE、无固化兜底表名；
 *     阶段0c 元数据预热；finally DROP IF EXISTS 回收。
 *   - 申请单：permissionRunId 唯一 marker（申请原因），仅命中本轮自建申请，绝不使用
 *     历史记录；兜底撤销也仅针对本轮 marker。
 *   - 审批流（DS-PERM-69）：阶段0b2 由管理员在 系统管理→审批管理→流程配置 把“表权限”
 *     流整体替换为 2 级用户型审批人（一级=l1、二级=l2，均本轮自建账号）；进入时配置
 *     先捕获快照，finally 按快照恢复原状态（共享配置，恢复失败在通过路径显式失败，
 *     口径同 SM-02-03）。进入时该类型本就未配置（应用后无法恢复为“未配置”，产品无
 *     停用/清空开关）或“确认应用”被拦截时按前置不足条件 skip，不破坏共享态；审批
 *     序列以申请弹窗解析结果为准，不假定固定审批人顺序。
 *
 * 闭环（两条业务口径均保留，未削弱；DS-PERM-24/25 同型单用例 try/finally）：
 *   同意路径（阶段1）：申请人提交（申请原因=本轮唯一标记）→ 我的申请-未审批在列 +
 *     “审批名称”随机名负向查询（命中即失败）→ 逐级审批人同意（如配置第三节点按同
 *     序列补审）→ 我的申请-已审批=已通过 → 申请人重新进入目标表详情（终态表权限
 *     生效证据）→ 资源视角回收本轮授权行（为拒绝路径重新申请清障）。
 *   拒绝路径（阶段2）：申请人再提交 → 未审批在列 → 一级审批人拒绝 → 已审批=已驳回。
 *
 * 申请契约（PERM-STATIC-04 静态补强，保留）：提交前核验 表信息回显、权限类型多选
 *   （使用+管理同时勾选）、字段范围=全部字段、截止时间默认永久；契约点存在但不符合
 *   预期才定性失败，控件缺失只记为校准点并写入用例附件，页面恢复后按附件逐项复核。
 *
 * 规则：RUN_PERMISSION_APPROVAL=1 闸门 + DB_* MySQL 前置门禁（均为条件 skip、非永久）；
 *   仅浏览器页面操作 + MySQL 直连 DDL（仅本轮自备表）；UUID 标记隔离；跨账号状态
 *   串行执行（--workers=1）。
 */
import type { Locator, Page } from '@playwright/test';
import {
  assertNoConsoleErrors,
  chooseConfiguredDataSource,
  clickMenu,
  dbConfig,
  expect,
  fillByLabel,
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
} from './权限测试工具.js';
import type { PermissionIdentity, PermissionRole } from './权限测试工具.js';
import {
  deletePermissionFromRow,
  dismissPermissionDropdown,
  findResourceViewAuthorizationRow,
  openDataPermissionPage,
  requirePermissionTableName,
  resolveMysqlPermissionResource,
} from './数据权限闭环工具.js';
import type { MysqlPermissionResource } from './数据权限闭环工具.js';
import {
  openApprovalLeaf,
  permissionRunId,
  requirePermissionApprovalEnvironment,
  revokeApplicationAsApplicant,
} from './权限审批待调试工具.js';

type E2EPage = Parameters<typeof clickMenu>[0];

/** 本轮自备主体（DS-PERM-32 起解耦 permissionFixtures 固化用户依赖；全 ASCII 唯一）。 */
const applicant = newPermissionIdentity('sm0201a');
const approverLevel1 = newPermissionIdentity('sm0201l1');
const approverLevel2 = newPermissionIdentity('sm0201l2');

/** 本轮主体索引：审批序列按用户名取回登录身份。 */
const OWN_IDENTITIES: PermissionIdentity[] = [applicant, approverLevel1, approverLevel2];

/**
 * 审批节点指派计划：一级=l1、二级=l2、（如配置第三节点）三级再指派 l1，
 * 保证闭环不超出本轮自备账号。
 */
const APPROVAL_PLAN: PermissionIdentity[] = [approverLevel1, approverLevel2, approverLevel1];

/** 本轮自备角色：菜单按 SM-00-01 实证口径；唯一 UUID 命名，用后保留（先例 SM-00-02）。 */
const ROLE_PLAN: Array<{ role: PermissionRole; menus: string[]; member: PermissionIdentity }> = [
  { role: newPermissionRole('sm0201', 'applicant'), menus: ['数据地图', '数据查询'], member: applicant },
  { role: newPermissionRole('sm0201', 'approver1'), menus: ['数据地图'], member: approverLevel1 },
  { role: newPermissionRole('sm0201', 'approver2'), menus: ['数据地图'], member: approverLevel2 },
];

/** 本轮自备专用表：UUID 唯一、MySQL 直建；不读 DATA_PERMISSION_TABLE，无固化兜底表名。 */
const permissionResource: MysqlPermissionResource = resolveMysqlPermissionResource({
  tableName: `e2e_sm0201t_${uuid()}`,
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

/** 审批管理工作台路由：本轮账号 hash 直达与菜单兜底共用。 */
const APPROVAL_ROUTES: Record<string, string> = {
  我的申请: '#/systemManage/approvalManage/myApply',
  我的审批: '#/systemManage/approvalManage/myExamine',
  用户权限: '#/systemManage/userPermission/dataPermission',
};

/** 前置不足（目标表/审批流/审批入口）：写清原因后跳过，不伪造通过、不误报缺陷。 */
function skipForMissingEnvironment(reason: string): never {
  // 证据同时落为用例附件，避免列表报告不显示 skip 原因时证据丢失。
  test.info().attach('ENV-SM0201-前置证据.txt', { body: reason, contentType: 'text/plain; charset=utf-8' });
  test.skip(true, 'ENV-SM0201：' + reason);
  throw new Error('UNREACHABLE：test.skip 应已中断用例。');
}

/** marker 标记终态：从未审批跟踪表移除（indexOf<0 时不动，防 splice(-1) 误删末位）。 */
function markSettled(marker: string): void {
  const index = pendingMarkers.indexOf(marker);
  if (index >= 0) pendingMarkers.splice(index, 1);
}

/** 审批序列的用户名取回本轮登录身份；未知用户名=脚本与指派计划不一致，显式失败。 */
function identityByUserName(userName: string): PermissionIdentity {
  const identity = OWN_IDENTITIES.find((item) => item.userName === userName);
  if (!identity) throw new Error('未知的本轮审批人用户名：' + userName);
  return identity;
}

/** 与 SM-03-04 相同的落地页入口构造：显式 ENTRY_URL > 环境默认值。 */
function entryUrlFor(pathWithoutHash: string): string {
  const entry = new URL(
    process.env.ENTRY_URL ?? 'http://bigdata.dev.northking.net/bigdata-ui-factory/#/dataAccess/dataSource',
  );
  entry.hash = pathWithoutHash;
  return entry.toString();
}

/** 本轮主体展示名（姓名/用户名）→ 登录用户名：节点上显示的是姓名，审批操作按用户名登录。 */
const OWN_NAME_TO_USER = new Map<string, string>(
  OWN_IDENTITIES.flatMap((identity) => [
    [identity.userName, identity.userName],
    [identity.nickname, identity.userName],
  ]),
);

async function firstVisibleMatching(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

function successNotice(page: E2EPage, pattern: string | RegExp) {
  return page.locator(
    '.ant-message-notice-content:visible, .ant-notification-notice-message:visible, .el-message:visible, '
      + '[role="alert"]:visible, [class*="toast"]:visible, [class*="message"]:visible',
  ).filter({ hasText: pattern }).last();
}

function visibleRows(page: E2EPage) {
  return page.locator(
    'tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not([role="columnheader"])',
  );
}

async function waitForTrue(page: E2EPage, action: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await action().catch(() => false)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/**
 * 系统管理的 Tab 在窄窗口下会被收进 Ant/Element 的“更多”菜单。
 * 本 spec 内自带点击器，避免把隐藏 Tab 当成不存在，也不修改共享工具。
 */
async function clickSystemTab(page: E2EPage, name: string): Promise<void> {
  const tabSelector = '[role="tab"]:visible, .ant-tabs-tab:visible, .el-tabs__item:visible';
  const findDirect = async (): Promise<Locator | undefined> => {
    const candidates = [
      page.locator(tabSelector).filter({ hasText: new RegExp('^\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$') }),
      page.getByRole('tab', { name, exact: true }),
    ];
    for (const candidate of candidates) {
      const item = await firstVisibleMatching(candidate);
      if (item) return item;
    }
    return undefined;
  };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const direct = await findDirect();
    if (direct) {
      await direct.click();
      const selected = await direct.getAttribute('aria-selected');
      if (selected !== null) await expect(direct).toHaveAttribute('aria-selected', 'true');
      await page.waitForTimeout(500);
      return;
    }

    const more = await firstVisibleMatching(page.locator(
      '.ant-tabs-nav-operations .ant-tabs-nav-more:visible, .el-tabs__nav-more:visible, [role="tablist"]:visible [aria-label*="更多"]:visible, [role="tablist"]:visible [title*="更多"]:visible, [role="tablist"]:visible [aria-label="···"]:visible, [role="tablist"]:visible [title="···"]:visible',
    ));
    if (more) {
      await more.click();
      const popup = page.locator(
        '.ant-tabs-dropdown:visible, .ant-dropdown:visible, .el-tabs__dropdown-menu:visible, .el-dropdown-menu:visible, [role="menu"]:visible',
      );
      const hidden = await firstVisibleMatching(
        popup.getByRole('menuitem', { name, exact: true }).or(popup.getByText(name, { exact: true })),
      );
      if (hidden) {
        await hidden.click();
        await page.waitForTimeout(500);
        return;
      }
    }
    await page.waitForTimeout(250);
  }

  const emptyState = page.getByText(/暂无数据|暂无记录|没有数据|没有记录/).first();
  if (await emptyState.isVisible().catch(() => false)) {
    throw new Error('当前环境没有可切换的“' + name + '”数据权限 Tab 内容');
  }
  throw new Error('系统管理 Tab“' + name + '”未找到（已检查可见 Tab 及“更多”菜单），当前页面：' + page.url());
}

async function openSystemLeaf(page: E2EPage, leaf: string): Promise<void> {
  if (!page.url().includes('/systemManage/')) {
    // “系统管理”在窄顶栏被收进“···”；可见顶栏中找不到文字不等于没有权限。
    await clickMenu(page, '系统管理');
  }

  const route = APPROVAL_ROUTES[leaf];
  if (route) {
    // “我的申请/我的审批”并非用户权限下的页面，而是“审批管理”的折叠叶子。
    // 先展开审批管理，再点击目标叶子；账号确实无权限时给出明确报错。
    if (leaf === '我的申请' || leaf === '我的审批') {
      // 「审批管理」可能是折叠分组：首次点击只展开不出叶子（动画/二次渲染时序），
      // 因此叶子用 4 秒窗口轮询，未出现时补点一次分组再查，不把展开时序误判为无权限。
      const menuScope = page.locator(
        '.el-menu:visible, .el-aside:visible, aside:visible, [class*="sidebar" i]:visible, [class*="menu" i]:visible',
      );
      const approvalGroup = await firstVisibleMatching(menuScope.getByText('审批管理', { exact: true }))
        ?? await firstVisibleMatching(page.getByText('审批管理', { exact: true }));
      if (!approvalGroup) {
        throw new Error('系统管理左侧未找到“审批管理”菜单（角色需在角色管理中勾选「审批管理」菜单）。');
      }
      await approvalGroup.click();
      let approvalLeaf: Locator | undefined;
      const leafDeadline = Date.now() + 4_000;
      while (!(approvalLeaf = await firstVisibleMatching(page.getByText(leaf, { exact: true })))) {
        if (Date.now() > leafDeadline) break;
        if (await approvalGroup.isVisible().catch(() => false)) await approvalGroup.click().catch(() => undefined);
        await page.waitForTimeout(400);
      }
      if (!approvalLeaf) throw new Error('“审批管理”展开后未找到“' + leaf + '”入口。');
      await approvalLeaf.click();
      await expect(page).toHaveURL(new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      await expect(page.locator('body')).toBeVisible();
      return;
    }
    const link = page.locator('a[href="' + route + '"]:visible').first();
    if (!(await link.count())) {
      throw new Error('当前账号没有“' + leaf + '”菜单/角色权限');
    }
    await link.click();
    await expect(page).toHaveURL(new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await expect(page.locator('body')).toBeVisible();
    return;
  }

  const menuItem = await firstVisibleMatching(page.getByText(leaf, { exact: true }));
  if (!menuItem) {
    throw new Error('当前账号没有“' + leaf + '”菜单/角色权限');
  }
  const before = page.url();
  await clickMenu(page, '系统管理', leaf);
  await expect.poll(() => page.url(), { timeout: 10_000 }).not.toBe(before);
  await expect(page.locator('body')).toBeVisible();
}

/**
 * 本轮账号打开 我的申请/我的审批。
 * 110 环境实测（20260920 run-212403-837）：账号冷启动直达
 * #/systemManage/approvalManage/myExamine 必然被产品路由守卫重定向 #/404
 * （角色动态路由在应用初始化完成后才注册），而 loginAs 不支持候选落地页，
 * 直接以审批路由作为登录入口会在 loginWithCredentials 内抛
 * “入口不是该账号可访问的模块”。因此先登录到本轮账号可达的数据地图-表查询页
 * （与申请人发起申请同一入口，已实证可达），再做应用内 hash 直达；
 * 未落在目标路由或未呈现审批页签时，用“系统管理→审批管理”真实菜单兜底；
 * 两条路径都失败按环境前置不足跳过（flash 验证点：本轮角色的审批入口形态）。
 */
async function openApprovalPageAs(page: E2EPage, identity: PermissionIdentity, leaf: string): Promise<void> {
  const fragment = (APPROVAL_ROUTES[leaf] ?? '').replace('#', '');
  await loginAs(page, identity, { entryUrl: entryUrlFor('/dataMap/tableQuery/tablesQuery') });
  const ready = async () => /未审批|已审批/.test(await page.locator('body').innerText().catch(() => ''));
  // 应用内 hash 直达：仅改 hash 不重载文档，此时 SPA 已按该账号角色完成动态路由
  // 注册，不再经过冷启动守卫的 404 重定向。
  if (!page.url().includes(fragment)) {
    await page.evaluate((hash) => { window.location.hash = hash; }, '#' + fragment).catch(() => undefined);
    await page.waitForTimeout(1_000);
  }
  const directOk = page.url().includes(fragment) && await waitForTrue(page, ready, 8_000);
  if (directOk) return;
  let menuOk = false;
  try {
    await openSystemLeaf(page, leaf);
    menuOk = await waitForTrue(page, ready, 8_000);
  } catch {
    menuOk = false;
  }
  if (!menuOk) {
    // 跳过前固化现场：最终 URL 能区分「守卫重定向 404」「停在数据地图」「菜单存在但页签未渲染」，
    // 避免下一轮诊断只能依赖运行日志。
    const finalUrl = page.url();
    const bodySnippet = (await page.locator('body').innerText().catch(() => ''))
      .replace(/\s+/g, ' ').trim().slice(0, 300);
    skipForMissingEnvironment(
      '本轮账号 ' + identity.userName + ' 无法进入“' + leaf + '”：hash 直达(' + fragment
        + ')未呈现审批页签，菜单兜底也未成功；最终URL=' + finalUrl
        + '；页面片段=' + bodySnippet
        + '。请确认本轮角色已在角色管理勾选「系统管理/审批管理」菜单（flash 验证点：审批入口形态）。',
    );
  }
}

/** 可见弹层（Ant/Element 双兼容）：申请权限与审批确认共用。 */
function visibleLayer(page: E2EPage): Locator {
  return page.locator(
    '[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible, .ant-drawer:visible, .el-drawer:visible',
  ).last();
}

/** 下拉选项渲染在页面级（teleport），Ant/Element 双兼容。 */
const OPTION_SELECTOR = [
  '.ant-select-dropdown:visible .ant-select-item-option',
  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
  '.el-select-dropdown:visible .el-select-dropdown__item',
  '[role="listbox"]:visible [role="option"]',
  'li[role="option"]:visible',
].join(', ');

/** 节点序号：第一→1 … 第十→10；解析失败返回大数保证排序兜底。 */
function approvalLevelOf(text: string): number {
  const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const match = text.match(/第([一二三四五六七八九十])审批人/);
  return match ? (map[match[1]] ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 弹窗审批节点：固定用户=配置确定（禁用文本框）；待指派=“请选择(用户|审批人)”下拉。 */
type WorkflowNode =
  | { kind: '固定用户'; level: number; displayName: string; rowText: string; y: number }
  | { kind: '待指派'; level: number; displayName: string; rowText: string; y: number; box: Locator };

/**
 * 解析申请弹窗的审批节点指派区，按页面纵向顺序返回。
 * 用户型节点=行内禁用文本框（有姓名值）；角色型/旧版节点=“请选择(用户|审批人)”下拉。
 * 禁用输入框只认“第N审批人”行，避免把日期等其它禁用控件误判为审批节点。
 */
async function collectWorkflowNodes(layer: Locator): Promise<WorkflowNode[]> {
  const nodes: WorkflowNode[] = [];
  const fixedInputs = layer.locator('input:disabled');
  const fixedTotal = await fixedInputs.count();
  for (let index = 0; index < fixedTotal; index += 1) {
    const input = fixedInputs.nth(index);
    const displayName = ((await input.inputValue().catch(() => '')) ?? '').trim();
    if (!displayName) continue;
    const row = input.locator('xpath=ancestor::*[contains(normalize-space(string(.)), "审批人")][1]');
    if (!(await row.isVisible().catch(() => false))) continue;
    const rowText = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!/第[一二三四五六七八九十]{1,2}审批人/.test(rowText)) continue;
    const y = (await row.boundingBox().catch(() => null))?.y ?? Number.MAX_SAFE_INTEGER;
    nodes.push({ kind: '固定用户', level: approvalLevelOf(rowText), displayName, rowText, y });
  }
  const boxes = layer.locator('.el-select:visible, .ant-select:visible');
  const total = await boxes.count();
  for (let index = 0; index < total; index += 1) {
    const box = boxes.nth(index);
    const input = box.locator('input').first();
    const placeholder = (await input.getAttribute('placeholder').catch(() => '')) ?? '';
    const boxText = (await box.innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (!/请选择(用户|审批人)/.test(placeholder + ' ' + boxText)) continue;
    const y = (await box.boundingBox().catch(() => null))?.y ?? Number.MAX_SAFE_INTEGER;
    nodes.push({ kind: '待指派', level: 0, displayName: '', rowText: boxText, y, box });
  }
  return nodes.sort((a, b) => a.y - b.y);
}

/** 只读探查待指派节点的候选审批人名单：只打开下拉收集文本，不选中、不改动环境。 */
async function peekAssignCandidates(page: E2EPage, box: Locator): Promise<string[]> {
  if (!(await box.isVisible().catch(() => false))) return [];
  await box.click();
  await waitForTrue(page, async () => (await page.locator(OPTION_SELECTOR).count()) > 0, 4_000);
  const texts = (await page.locator(OPTION_SELECTOR).allInnerTexts().catch(() => [] as string[]))
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  await dismissPermissionDropdown(page);
  return texts;
}

/** 待指派节点选中本轮审批人后，节点应回显该用户名或其姓名（候选展示形态因版本而异）。 */
async function expectNodeShows(page: E2EPage, node: Extract<WorkflowNode, { kind: '待指派' }>, userName: string): Promise<void> {
  const displayPattern = new RegExp(
    '(' + [...OWN_NAME_TO_USER.keys()].filter((name) => OWN_NAME_TO_USER.get(name) === userName).map(escapeRegExp).join('|') + ')',
  );
  await expect.poll(async () => {
    const input = node.box!.locator('input').first();
    return (await input.inputValue().catch(() => '')) + ' ' + (await node.box!.innerText().catch(() => ''));
  }, { timeout: 5_000 }).toMatch(displayPattern);
}

/**
 * 解析并指派申请弹窗的审批节点，返回实际审批序列（登录用户名，按节点顺序）。
 * 节点指派计划（APPROVAL_PLAN）：一级=l1、二级=l2、（如配置第三节点）三级再指派 l1；
 * 用户型固定节点若属本轮自备主体则计入序列，否则闭环无法由本轮账号承接——此时只读
 * 探查角色型节点候选名单作为精确前置证据，按环境前置不足 skip（不提交、不留悬挂申请）。
 */
async function assignApprovalNodes(page: E2EPage, layer: Locator, plan: PermissionIdentity[]): Promise<string[]> {
  const nodes = await collectWorkflowNodes(layer);
  const sequence: string[] = [];
  const candidateReport: string[] = [];
  let blockedBy: string | undefined;

  for (const node of nodes) {
    if (node.kind === '固定用户') {
      const mapped = OWN_NAME_TO_USER.get(node.displayName);
      if (mapped) sequence.push(mapped);
      else if (blockedBy === undefined) blockedBy = node.displayName + '（' + node.rowText + '）';
      continue;
    }
    if (blockedBy !== undefined) {
      // 已被固定节点阻断：后续节点只探查候选名单作证据，不做指派、不提交申请。
      const candidates = await peekAssignCandidates(page, node.box!);
      candidateReport.push('候选=[' + candidates.join('、') + ']');
      continue;
    }
    if (sequence.length >= plan.length) continue;
    const userName = plan[sequence.length].userName;
    // 候选下拉可能展示账号或姓名：账号与本轮自备账号的姓名都作为候选匹配依据。
    const aliases = [userName, ...[...OWN_NAME_TO_USER.entries()].filter(([, user]) => user === userName).map(([name]) => name)]
      .filter((item, index, all) => all.indexOf(item) === index);
    await node.box!.click();
    await waitForTrue(page, async () => (await page.locator(OPTION_SELECTOR).count()) > 0, 4_000);
    const aliasPattern = new RegExp(aliases.map(escapeRegExp).join('|'));
    // 候选接口返回后选项 DOM 才逐步挂载：一次性判定会把「稍后可见」误判为不存在。
    // 在 6 秒窗口内轮询可见匹配，窗口耗尽仍无才定性失败（语义不变，只是等稳）。
    let option: Locator | undefined;
    const optionDeadline = Date.now() + 6_000;
    while (!(option = await firstVisibleMatching(page.locator(OPTION_SELECTOR).filter({ hasText: aliasPattern })))) {
      if (Date.now() > optionDeadline) break;
      await page.waitForTimeout(300);
    }
    if (!option) {
      const candidates = (await page.locator(OPTION_SELECTOR).allInnerTexts().catch(() => [] as string[]))
        .map((item) => item.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      await dismissPermissionDropdown(page);
      throw new Error(
        '审批节点候选列表中未找到本轮审批人 ' + userName + '；实测候选=[' + candidates.join('、')
          + ']（flash 验证点：确认该用户是当前节点配置角色的成员，或调整环境审批流配置）。',
      );
    }
    await option.click();
    await expectNodeShows(page, node, userName);
    sequence.push(userName);
  }

  if (blockedBy !== undefined) {
    skipForMissingEnvironment(
      '审批流最早的节点固定为非本轮自备用户 ' + blockedBy + '：申请会停在该固定用户的“我的审批”，'
        + '本轮自备账号（' + OWN_IDENTITIES.map((identity) => identity.userName).join('/') + '）无法承接该节点，'
        + '同意/拒绝闭环在本环境无法由本轮账号完成。角色型节点候选只读探查：'
        + (candidateReport.join('；') || '无待指派节点')
        + '。需环境将表权限审批流配置为可指派节点（本轮审批人在候选名单），或提供固定审批人账号后回归。',
    );
  }
  await dismissPermissionDropdown(page);
  return sequence;
}

/** 数据地图-表查询：搜索目标表并返回其可见卡片（找不到返回 undefined）。 */
async function openTargetTableCard(page: E2EPage, tableName: string): Promise<Locator | undefined> {
  await clickMenu(page, '数据地图');
  const link = page.locator('a[href="#/dataMap/tableQuery/tablesQuery"]:visible').last();
  if (await link.isVisible().catch(() => false)) {
    await link.click();
  } else {
    await clickMenu(page, '数据地图', '表查询');
  }
  const search = page.getByPlaceholder(/按表名|表名|搜索/).first();
  await expect(search).toBeVisible({ timeout: 15_000 });
  await search.click();
  await search.fill('');
  // 逐字输入并回车+失焦：兼容 input/change 与 keyup.enter 两种提交实现。
  await search.pressSequentially(tableName, { delay: 10 });
  await search.press('Enter');
  await search.blur();
  const cardLocator = page.locator(
    '.table-query .card:visible, .table-query .ant-card:visible, .table-query .el-card:visible',
  );
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const card = await firstVisibleMatching(cardLocator.filter({ hasText: tableName }));
    if (card) return card;
    await page.waitForTimeout(500);
  }
  return undefined;
}

/** 本轮申请契约核验结论（PERM-STATIC-04）：submitTableApply 写入，用例 report 上报。 */
const applyContractEvidence: string[] = [];

/**
 * 申请弹窗契约核验（PERM-STATIC-04 静态补强）：
 *  1. 表信息回显：弹窗存在表信息回显区时应包含目标表名（不含=定性失败）；
 *     完全找不到回显区=记录校准点（新版弹窗可能只在标题/前置上下文携带表名）。
 *  2. 权限类型多选：“使用/管理”同时可见时全部勾选并确认两者同时保持勾选；
 *     仅一种可见时按实际记录（校准点：确认环境是否开放“管理”类型）。
 *  3. 字段范围：提供“全部字段/部分字段”选择时正向用例选“全部字段”；未提供则记录校准点。
 *  4. 永久期限：截止时间默认应为永久（“永久”选项或 2099-01-01）；默认即永久则
 *     原样保留提交，否则显式选回“永久”并记录控件形态。
 */
async function assertApplyContract(page: E2EPage, layer: Locator, tableName: string): Promise<string[]> {
  const evidence: string[] = [];
  const layerText = async (): Promise<string> =>
    (await layer.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();

  // 1) 表信息回显：有回显区却不含目标表=定性失败；无回显区=校准点。
  const dialogText = await layerText();
  if (/表名|申请表|目标表|数据表/.test(dialogText)) {
    if (dialogText.includes(tableName)) evidence.push('表信息=弹窗回显目标表名');
    else throw new Error('申请弹窗表信息区未包含目标表 ' + tableName + '（flash 验证点：确认申请入口与目标表一致）。');
  } else {
    evidence.push('表信息=弹窗未见表名回显区（校准点：确认表信息是否移入弹窗标题或前置上下文）');
  }

  // 2) 权限类型多选：使用+管理 同时可见则全部勾选，并确认多选同时生效。
  const checkedTypes: string[] = [];
  for (const typeLabel of ['使用', '管理']) {
    const flag = layer.locator('[type="checkbox"], .el-checkbox, .ant-checkbox').filter({ hasText: typeLabel }).first();
    if (!(await flag.isVisible().catch(() => false))) continue;
    const input = flag.locator('input[type="checkbox"]').first();
    if (!(await input.isChecked().catch(() => false))) await flag.click();
    if (await waitForTrue(page, async () => input.isChecked().catch(() => false), 3_000)) checkedTypes.push(typeLabel);
    else evidence.push('权限类型=“' + typeLabel + '”勾选未生效（校准点：确认复选框定位）');
  }
  if (checkedTypes.length >= 2) evidence.push('权限类型=多选生效（' + checkedTypes.join('+') + '）');
  else if (checkedTypes.length === 1) evidence.push('权限类型=仅“' + checkedTypes[0] + '”可见并已勾选（校准点：确认环境是否提供“管理”类型）');
  else if (!evidence.some((item) => item.startsWith('权限类型='))) evidence.push('权限类型=未见复选控件（校准点：确认权限类型控件形态）');

  // 3) 字段范围：正向契约=全部字段。
  const allFields = layer.getByText(/全部字段|所有字段/).first();
  if (await allFields.isVisible().catch(() => false)) {
    await allFields.click();
    evidence.push('字段范围=已选“全部字段”');
  } else {
    evidence.push('字段范围=未见“全部字段”控件（校准点：确认申请弹窗是否提供字段范围选择）');
  }

  // 4) 永久期限：默认永久则原样保留；否则显式选回“永久”。
  const permanent = layer.getByText(/永久/).first();
  if (await permanent.isVisible().catch(() => false)) {
    await permanent.click();
    evidence.push('期限=已按“永久”选项提交');
  } else {
    const expiryInput = layer.locator(
      '.el-date-editor input:visible, .ant-picker input:visible, input[placeholder*="截止"]:visible, input[placeholder*="时间"]:visible',
    ).first();
    const value = (await expiryInput.isVisible().catch(() => false))
      ? ((await expiryInput.inputValue().catch(() => '')) ?? '')
      : '';
    if (/2099|永久/.test(value)) evidence.push('期限=默认永久（' + value + '）');
    else if (value) evidence.push('期限=默认值“' + value + '”非永久（校准点：确认默认期限契约应为永久）');
    else evidence.push('期限=未见截止时间控件（校准点：确认是否默认永久且不展示控件）');
  }
  await dismissPermissionDropdown(page);
  return evidence;
}

/**
 * 申请人发起表权限申请：弹窗内填申请原因（本轮 UUID 标记，行定位唯一键）、
 * 契约核验（表信息/权限类型多选/全部字段/永久期限）、逐级指派审批节点后提交。
 * 返回实际形成的审批序列（用户名数组，按节点顺序）。
 */
async function submitTableApply(page: E2EPage, tableName: string, marker: string): Promise<string[]> {
  const card = await openTargetTableCard(page, tableName);
  if (!card) {
    skipForMissingEnvironment(
      '申请人在数据地图-表查询中搜不到本轮自备表 ' + tableName
        + '：新表可能尚未进入平台元数据缓存（阶段0c 预热失败或未完成，元数据刷新链路异常）；'
        + '请检查自助查询元数据刷新后重跑（flash 验证点：新建表上线可见性）。',
    );
  }
  // 入口优先级：卡片“申请权限”图标 → 表详情页“申请权限”按钮。
  const icon = card.locator(
    '[aria-label="图标: safety-certificate"], [aria-label*="safety-certificate" i], [aria-label*="权限"], [title*="权限"]',
  ).first();
  if (await icon.isVisible().catch(() => false)) {
    await icon.click();
  } else {
    const name = card.locator('.table-name:visible, [class*="table-name"]:visible').first();
    await name.click();
    await page.waitForTimeout(400);
    const applyButton = page.getByRole('button', { name: /申请权限/ }).first();
    if (await applyButton.isVisible().catch(() => false)) {
      await applyButton.click();
    } else {
      skipForMissingEnvironment(
        '目标表 ' + tableName + ' 的卡片与详情页均未见“申请权限”入口：可能申请人已持有该表权限'
          + '（阶段1.5 回收未完成或环境侧历史授权残留），或页面结构已变化（flash 验证点）。',
      );
    }
  }
  const layer = visibleLayer(page);
  await expect(layer).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/申请表|申请权限/).first()).toBeVisible();

  // 申请原因：本轮 UUID 唯一标记，是后续 我的申请/我的审批 定位本申请的唯一键。
  const labelledBox = layer.getByRole('textbox', { name: /申请原因|申请说明|申请理由|备注/ }).first();
  let reasonBox: Locator | undefined = await labelledBox.isVisible().catch(() => false) ? labelledBox : undefined;
  if (!reasonBox) reasonBox = await firstVisibleMatching(layer.locator('textarea:visible'));
  if (!reasonBox) {
    throw new Error(
      '申请弹窗未找到“申请原因”输入框（flash 验证点）：弹窗文本='
        + (await layer.innerText().catch(() => '')).slice(0, 200),
    );
  }
  await reasonBox.fill(marker);

  // 申请契约（PERM-STATIC-04）：表信息回显 / 权限类型多选 / 字段范围=全部字段 / 永久期限。
  // 契约点缺失不阻断闭环（记为校准点），契约点存在但不符合预期才定性失败。
  applyContractEvidence.length = 0;
  applyContractEvidence.push(...(await assertApplyContract(page, layer, tableName)));
  test.info().attach('SM-02-01-申请契约核验.txt', {
    body: applyContractEvidence.join('\n'),
    contentType: 'text/plain; charset=utf-8',
  });

  // 审批节点：一级=l1、二级=l2、（如有第三节点）l1 轮换，保证闭环不超出本轮自备账号。
  const sequence = await assignApprovalNodes(page, layer, APPROVAL_PLAN);
  if (sequence.length < 2) {
    skipForMissingEnvironment(
      '当前表权限审批流可由申请人指派的审批节点不足 2 级（实测 ' + sequence.length
        + ' 级）；多级审批需先在环境为表权限审批流配置两级及以上可选审批节点。',
    );
  }

  const submit = layer.getByRole('button', { name: /提\s*交|确\s*定/ }).last();
  await expect(submit).toBeVisible();
  // 节点校验提示若出现说明指派未生效；否则以弹窗关闭作为提交完成的硬证据。
  const blocked = page.getByText(/未指定审批人|请补全/).first();
  // 提交成功后弹窗随即卸载，Playwright 可能把已生效的点击误判为 detached 并重试至超时
  // （run-20260920-211314 实测：报 detach 但弹窗已关、焦点已还原到入口图标=提交已落库）。
  // 点击失败时先看弹窗状态：已关闭=首次点击已生效，不补点以免重复提交；
  // 仍开启时先等待在途提交落定，确认仍开启才补点一次（按钮 loading/disabled 时不补点）。
  try {
    await submit.click({ timeout: 10_000 });
  } catch {
    if (await blocked.isVisible().catch(() => false)) {
      throw new Error('提交被表单校验拦截：' + (await blocked.innerText().catch(() => '')));
    }
    await page.waitForTimeout(3_000);
    if (await layer.isVisible().catch(() => false)) {
      const retrySubmit = layer.getByRole('button', { name: /提\s*交|确\s*定/ }).last();
      if (!(await retrySubmit.isDisabled().catch(() => false))) {
        await retrySubmit.click({ timeout: 10_000 });
      }
    }
  }
  await expect.poll(async () => {
    if (await blocked.isVisible().catch(() => false)) return 'blocked';
    return (await layer.isVisible().catch(() => false)) ? 'open' : 'closed';
  }, { timeout: 15_000 }).toBe('closed');
  // 成功 toast 只作辅助证据（瞬时 toast 不可作为唯一证据），落库由 我的申请 行核对。
  await expect(successNotice(page, /成功|提交|申请/)).toBeVisible({ timeout: 5_000 }).catch(() => undefined);
  return sequence;
}

/** 我的申请/我的审批：切页签 → 查询 → 返回包含本轮标记的首个可见行。 */
async function findMarkerRow(
  page: E2EPage,
  tab: '未审批' | '已审批',
  marker: string,
): Promise<Locator | undefined> {
  await clickSystemTab(page, tab);
  await page.getByRole('button', { name: /查\s*询/ }).first().click();
  await page.waitForTimeout(400);
  const row = await firstVisibleMatching(visibleRows(page).filter({ hasText: marker }));
  if (row) return row;
  // 列表刷新存在竞态（刚提交/刚审批的记录可能晚于查询结果渲染）：
  // 重查一次再定性“不存在”，避免把渲染时序误判成节点归属问题。
  await page.waitForTimeout(1_200);
  await page.getByRole('button', { name: /查\s*询/ }).first().click();
  await page.waitForTimeout(600);
  return firstVisibleMatching(visibleRows(page).filter({ hasText: marker }));
}

/**
 * 以指定审批人身份处理本轮申请（同意/拒绝）：
 * true=已处理；false=该账号“未审批”列表没有此申请（不是当前节点审批人）。
 */
async function handlePendingApproval(
  page: E2EPage,
  identity: PermissionIdentity,
  marker: string,
  action: '同意' | '拒绝',
): Promise<boolean> {
  await openApprovalPageAs(page, identity, '我的审批');
  const row = await findMarkerRow(page, '未审批', marker);
  if (!row) return false;
  const actionPattern = action === '同意' ? /同\s*意/ : /拒\s*绝/;
  const actionButton = row.getByRole('button', { name: actionPattern }).first();
  if (await actionButton.isVisible().catch(() => false)) {
    await actionButton.click();
  } else {
    const actionText = row.getByText(actionPattern).first();
    await expect(actionText).toBeVisible({ timeout: 5_000 });
    await actionText.click();
  }
  // 确认弹窗：审批意见按历史数据可填可不填（同意记录带意见、驳回记录可为空）。
  const layer = page.locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible').last();
  const confirmScope = (await layer.isVisible().catch(() => false)) ? layer : page;
  const opinion = confirmScope.locator('textarea:visible').first();
  if (await opinion.isVisible().catch(() => false)) await opinion.fill(action + ' ' + marker);
  const confirmButton = confirmScope.getByRole('button', { name: /^确\s*定$/ }).last();
  if (await confirmButton.isVisible().catch(() => false)) await confirmButton.click();
  await expect(
    successNotice(page, new RegExp('(?:' + action + '|操作|审批).*成功')),
  ).toBeVisible({ timeout: 10_000 });
  return true;
}

/** 申请人复核最终状态：已审批页签必须出现本轮申请，且状态文本匹配预期。 */
async function expectFinalStatusAsApplicant(
  page: E2EPage,
  applicantIdentity: PermissionIdentity,
  marker: string,
  statusPattern: RegExp,
  expectedLabel: string,
): Promise<void> {
  await openApprovalPageAs(page, applicantIdentity, '我的申请');
  const row = await findMarkerRow(page, '已审批', marker);
  if (!row) {
    throw new Error('我的申请-已审批 未找到本申请 ' + marker + '：流程可能未走完或列表结构变化。');
  }
  const rowText = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ');
  if (!statusPattern.test(rowText)) {
    throw new Error('申请 ' + marker + ' 最终状态应为“' + expectedLabel + '”，实际行文本：' + rowText);
  }
}

/**
 * 自助查询侧栏在部分版本只渲染图标链接（本地复刻自 SM-03-09/SM-02-05，共享 utils
 * 未导出该入口，保持双孪生可编译）：优先侧栏真实链接，否则已知 hash 路由直达。
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

/** “刷新数据库元数据”确认弹窗处理（复制自 SM-03-09/SM-02-05 已实证实现）。 */
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

/** 元数据预热前刷新数据库元数据（目录控件未渲染时安全跳过；同 SM-03-09/SM-02-05）。 */
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
 * 阶段0a：创建本轮唯一专用表并写入 2 行种子（MySQL 直连 DDL，仅本用例资源；模板
 * SM-03-09/SM-02-05 createPermissionFixtureTable）。建表失败为真实失败（调用方上抛
 * 前尽力 DROP 半建表），不伪造通过。
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
      + `('sm-1', 'e2e-sm0201-a', '${TARGET_TABLE}'), ('sm-2', 'e2e-sm0201-b', 'sm-02-01-approval-close-loop')`,
  );
  const rows = await query(`SELECT COUNT(*) AS total FROM ${TARGET_TABLE}`);
  const total = Number((rows[0] as { total?: unknown } | undefined)?.total ?? -1);
  expect(total, `专用表 ${TARGET_TABLE} 种子数据应为 2 行，实际：${JSON.stringify(rows)}`).toBe(2);
  return 2;
}

/**
 * 尽力删除本轮自建账号（用户管理页：按本轮唯一账号查询 → 行内“删除”→ 确认；模板
 * SM-03-09/SM-02-05 deleteOwnUser）。只回收本轮自备账号；任一步不满足都返回说明文本
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

/**
 * 清理“本轮申请人 × 本轮专用表”的授权行（终审同意自动授权的回收；资源视角页面操作，
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
      console.warn(`[SM-02-01 收尾] 遗留申请 ${marker} 已兜底撤销。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      test.info().attach('SM-02-01-收尾清理证据.txt', {
        body: '兜底撤销申请 ' + marker + ' 失败：' + message,
        contentType: 'text/plain; charset=utf-8',
      });
      console.warn(`[SM-02-01 收尾] 遗留申请 ${marker} 兜底撤销失败：${message.slice(0, 160)}`);
    }
  }
}

/**
 * ── 本轮自建“表权限”审批流配置（DS-PERM-69 清洁环境迁移）──
 * 页面模型与操作序列复刻 SM-02-03（DS-PERM-31 headed 实证）：系统管理→审批管理→
 * 流程配置 为按业务类型卡片布局，“表权限申请”卡片恰 1 个“配 置”入口；配置弹窗=
 * 审批级数 radio(1-5)+审批说明 textarea+环节设置（每级 审批人类型/具体审批人 两个
 * select，DOM 序 2i/2i+1）+“确认应用”（同类型唯一配置槽：整体替换该类型配置，无
 * 新建/停用开关）。本轮把“表权限”流整体替换为 2 级用户型审批人（均为本轮自建
 * 账号）——闭环不再依赖环境历史审批流与固定审批人；进入时配置先捕获快照，finally
 * 按快照恢复原状态（共享配置，恢复失败在通过路径显式失败，口径同 SM-02-03）。
 * 已知边界（DS-PERM-31 实证）：重开弹窗不回显审批说明，快照说明可能读为空，恢复按
 * 快照值尽力回填；进入时该类型本就未配置（级数/各级为空）时，应用后无法恢复为
 * “未配置”——应用前检测并按前置不足跳过，不破坏共享态。
 */
const TABLE_FLOW_CARD = '表权限申请';

/** 流程配置下拉选项（页面级 teleport，Ant/Element 双兼容；同 SM-02-03）。 */
const TABLE_FLOW_OPTION_SELECTOR = [
  '.ant-select-dropdown:visible .ant-select-item-option',
  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
  '.el-select-dropdown:visible .el-select-dropdown__item',
  '[role="listbox"]:visible [role="option"]',
  'li[role="option"]:visible',
].join(', ');

/** 本轮“表权限”流程审批说明唯一标记（前缀+时间戳；人工检索/残留排查线索）。 */
const TABLE_FLOW_MARKER = permissionRunId('e2e_flow0201');

/** “表权限”流程进入时配置快照（级数+各级[类型,审批人]+说明；finally 恢复基线）。 */
interface TableFlowSnapshot {
  level: string;
  nodes: Array<[string, string]>;
  remark: string;
}

function tableFlowEscapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function tableFlowWaitForTrue(page: Page, action: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await action().catch(() => false)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

function tableFlowVisibleLayer(page: Page): Locator {
  return page.locator(
    '[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible, .ant-drawer:visible, .el-drawer:visible',
  ).last();
}

/** 关闭可能悬空的下拉（Esc + 空白处点击，均容错；同 SM-02-03 dismissDropdownLocal）。 */
async function dismissTableFlowDropdown(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.locator('body').click({ position: { x: 5, y: 5 }, force: true }).catch(() => undefined);
  await page.waitForTimeout(200);
}

/** 流程配置页打开策略：真实菜单优先，hash 直达兜底（侧栏折叠/菜单时序不作唯一依赖）。 */
async function openTableFlowConfigPage(page: Page): Promise<void> {
  try {
    await openApprovalLeaf(page, '流程配置');
  } catch {
    await page.evaluate(() => { window.location.hash = '#/systemManage/approvalManage/flowConfig'; }).catch(() => undefined);
    await page.waitForTimeout(1_200);
  }
  await expect(page).toHaveURL(/flowConfig/, { timeout: 15_000 }).catch(() => undefined);
  await expect(page.locator('.config-card').first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(400);
}

/** “表权限申请”业务类型卡片（标题含类型名的 .config-card）。 */
function tableFlowCard(page: Page): Locator {
  return page.locator('.config-card').filter({ hasText: TABLE_FLOW_CARD }).first();
}

/** 打开“表权限申请”卡片的“配 置”弹窗；恰一个配置入口本身即断言（同类型唯一配置形态）。 */
async function openTableFlowDialog(page: Page): Promise<Locator> {
  const card = tableFlowCard(page);
  await expect(card).toBeVisible({ timeout: 10_000 });
  const entry = card.getByRole('button', { name: /配\s*置/ });
  await expect(entry).toHaveCount(1);
  await entry.first().click();
  const dialog = tableFlowVisibleLayer(page);
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog).toContainText('审批级数', { timeout: 8_000 });
  await page.waitForTimeout(600); // 等弹窗配置回显渲染稳定
  return dialog;
}

/** 关闭配置弹窗：优先“取 消”，Esc 兜底，并等待隐藏。 */
async function closeTableFlowDialog(page: Page, dialog: Locator): Promise<void> {
  const cancel = dialog.getByRole('button', { name: /取\s*消/ }).first();
  if (await cancel.isVisible().catch(() => false)) await cancel.click().catch(() => undefined);
  else await page.keyboard.press('Escape').catch(() => undefined);
  await dialog.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => undefined);
}

/** 当前勾选的审批级数（radio value；无勾选返回 ''）。 */
async function readTableFlowLevel(dialog: Locator): Promise<string> {
  const checked = dialog.locator('input[type="radio"]:checked');
  const count = await checked.count();
  for (let index = 0; index < count; index += 1) {
    const value = await checked.nth(index).getAttribute('value').catch(() => null);
    if (value) return value;
  }
  return '';
}

/** 等待谓词成立（有界轮询），超时抛出携带实测快照的断言错误。 */
async function expectTableFlowCondition(
  page: Page,
  actual: () => Promise<string>,
  predicate: (value: string) => boolean,
  message: string,
  timeoutMs = 8_000,
): Promise<string> {
  let value = '';
  const ok = await tableFlowWaitForTrue(page, async () => {
    value = await actual();
    return predicate(value);
  }, timeoutMs);
  if (!ok) throw new Error(`${message}（实测=${value || '空'}）`);
  return value;
}

/** 环节设置的 select 对（DOM 顺序=层级序：2i=审批人类型，2i+1=具体审批人；探针实证）。 */
function tableFlowNodeSelects(dialog: Locator): Locator {
  return dialog.locator('.ant-select:visible');
}

/** 切换审批级数并核验生效（级数切换后环节设置节点同步增减）。 */
async function setTableFlowLevel(page: Page, dialog: Locator, level: number): Promise<void> {
  const radio = dialog.locator(`input[type="radio"][value="${level}"]`);
  if ((await radio.count()) === 0) {
    throw new Error(`审批级数单选组缺少 ${level} 级选项（校准点：确认级数控件形态）。`);
  }
  await radio.check({ force: true }).catch(async () => {
    await dialog.getByText(`${level}级`, { exact: true }).first().click();
  });
  await expectTableFlowCondition(page, () => readTableFlowLevel(dialog), (value) => value === String(level),
    `审批级数切至 ${level} 未生效`);
  await expectTableFlowCondition(page, async () => String(await tableFlowNodeSelects(dialog).count()),
    (value) => value === String(level * 2),
    `级数 ${level} 的环节设置节点数应为 ${level * 2}（类型+审批人各一）`);
}

/** 选择第 levelIndex 级的审批人类型（用户/角色）。 */
async function pickTableFlowNodeType(page: Page, dialog: Locator, levelIndex: number, kind: string): Promise<void> {
  const typeSelect = tableFlowNodeSelects(dialog).nth(levelIndex * 2);
  await typeSelect.click();
  const option = page.locator(TABLE_FLOW_OPTION_SELECTOR)
    .filter({ hasText: new RegExp('^\\s*' + kind + '\\s*$') }).first();
  await expect(option).toBeVisible({ timeout: 6_000 });
  await option.click();
  await expectTableFlowCondition(page, async () => ((await typeSelect.innerText().catch(() => '')) ?? '').trim(),
    (value) => value.includes(kind), `第 ${levelIndex + 1} 级审批人类型应为 ${kind}`);
}

/** 选择第 levelIndex 级的具体审批人（支持输入过滤；候选缺失=硬错误并附候选样本）。 */
async function pickTableFlowNodeApprover(
  page: Page,
  dialog: Locator,
  levelIndex: number,
  aliasPattern: RegExp,
  searchText: string,
): Promise<void> {
  const approverSelect = tableFlowNodeSelects(dialog).nth(levelIndex * 2 + 1);
  await approverSelect.click();
  await page.waitForTimeout(400);
  const searchInput = approverSelect
    .locator('input.ant-select-selection-search-input, input[type="search"]').first();
  if (searchText && (await searchInput.count()) && (await searchInput.isVisible().catch(() => false))) {
    await searchInput.pressSequentially(searchText, { delay: 20 }).catch(() => undefined);
  }
  const option = page.locator(TABLE_FLOW_OPTION_SELECTOR).filter({ hasText: aliasPattern }).first();
  if (!(await tableFlowWaitForTrue(page, async () => option.isVisible().catch(() => false), 6_000))) {
    const candidates = (await page.locator(TABLE_FLOW_OPTION_SELECTOR).allInnerTexts().catch(() => [] as string[]))
      .map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 30).join('、');
    await dismissTableFlowDropdown(page);
    throw new Error(`第 ${levelIndex + 1} 级审批人候选中未找到“${searchText}”`
      + `（校准点：确认候选接口/筛选行为）；候选样本=[${candidates}]。`);
  }
  await option.click();
  await expectTableFlowCondition(page, async () => ((await approverSelect.innerText().catch(() => '')) ?? '').trim(),
    (value) => aliasPattern.test(value), `第 ${levelIndex + 1} 级具体审批人回显应为 ${searchText}`);
}

/** 读取第 levelIndex 级的当前回显（类型, 审批人）。 */
async function readTableFlowNodePair(dialog: Locator, levelIndex: number): Promise<[string, string]> {
  const selects = tableFlowNodeSelects(dialog);
  const kind = ((await selects.nth(levelIndex * 2).innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
  const approver = ((await selects.nth(levelIndex * 2 + 1).innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
  return [kind, approver];
}

/** 审批说明输入框（弹窗内唯一 textarea；探针实证）。 */
function tableFlowRemarkBox(dialog: Locator): Locator {
  return dialog.locator('textarea').first();
}

/** 确认应用；返回拦截提示文本（'' = 已提交且弹窗关闭；兼容二次确认弹层）。 */
async function applyTableFlowDialog(page: Page, dialog: Locator): Promise<string> {
  const apply = dialog.getByRole('button', { name: /确\s*认\s*应\s*用/ }).first();
  await expect(apply).toBeVisible({ timeout: 5_000 });
  await apply.click();
  const blockTip = page
    .locator('.ant-message, .el-message, .ant-form-item-explain-error, .el-form-item__error, [role="alert"]')
    .filter({ hasText: /必填|请选择|请输入|已存在|唯一|失败|层级|审批人|类型/ });
  const tip = await tableFlowWaitForTrue(page, async () => (await blockTip.count()) > 0, 3_000);
  if (tip) {
    const text = ((await blockTip.first().innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
    if (text) {
      await dismissTableFlowDropdown(page);
      return text;
    }
  }
  if (!(await dialog.waitFor({ state: 'hidden', timeout: 4_000 }).then(() => true).catch(() => false))) {
    // 兼容二次确认弹层：出现“确定”则确认一次后继续等待关闭。
    const confirmButton = page.getByRole('button', { name: /^确\s*定$/ }).last();
    if (await confirmButton.isVisible().catch(() => false)) {
      await confirmButton.click().catch(() => undefined);
      await dialog.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => undefined);
    }
  }
  await page.waitForTimeout(800);
  return '';
}

/** 捕获弹窗当前配置快照。 */
async function captureTableFlowSnapshot(dialog: Locator, level: number): Promise<TableFlowSnapshot> {
  const nodes: Array<[string, string]> = [];
  for (let index = 0; index < level; index += 1) nodes.push(await readTableFlowNodePair(dialog, index));
  return { level: String(level), nodes, remark: (await tableFlowRemarkBox(dialog).inputValue().catch(() => '')) ?? '' };
}

/** 按快照恢复配置：切级数→逐级类型/审批人→说明→确认应用（被拦截=真实失败）。 */
async function restoreTableFlowSnapshot(page: Page, dialog: Locator, snapshot: TableFlowSnapshot): Promise<void> {
  const level = Number(snapshot.level);
  await setTableFlowLevel(page, dialog, level);
  for (let index = 0; index < level; index += 1) {
    const [kind, approver] = snapshot.nodes[index];
    if (!kind) throw new Error(`初始快照第 ${index + 1} 级类型为空，无法恢复（校准点）。`);
    await pickTableFlowNodeType(page, dialog, index, kind);
    if (approver) {
      await pickTableFlowNodeApprover(page, dialog, index,
        new RegExp('^\\s*' + tableFlowEscapeRegExp(approver) + '\\s*$'), approver);
    }
  }
  await tableFlowRemarkBox(dialog).fill(snapshot.remark);
  const tip = await applyTableFlowDialog(page, dialog);
  if (tip) throw new Error('恢复进入时配置被拦截：' + tip);
}

test('SM-02-01｜系统管理｜申请权限→我的申请→我的审批→同意 拒绝', async ({ loginPage, consoleErrors, report }) => {
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

  /** DS-PERM-69：阶段0b2 “确认应用”成功后置 true——finally 据此恢复进入时配置。 */
  let flowMutated = false;
  /** “表权限”流程进入时配置快照（阶段0b2 首开弹窗捕获；finally 恢复基线）。 */
  let initialFlowSnapshot: TableFlowSnapshot | undefined;
  /** 主路径异常/跳过标记：finally 中恢复失败仅在通过路径上升级为失败。 */
  let mainError: unknown;

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
      'SM-02-01 阶段0a｜创建本轮专用表',
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
      'SM-02-01 阶段0b｜创建本轮账号与角色',
      true,
      `申请人=${applicant.userName}；一级=${approverLevel1.userName}；二级=${approverLevel2.userName}；`
        + `角色=${ROLE_PLAN.map((plan) => plan.role.roleName).join('、')}（唯一命名，用后保留）。`,
    );

    // 阶段0b2（自建审批流配置，DS-PERM-69）：管理员把“表权限”审批流整体替换为 2 级
    // 用户型审批人（一级=l1、二级=l2，均本轮自建账号）——后续申请/审批闭环不再依赖
    // 环境历史审批流与固定审批人。进入时先捕获快照（finally 恢复基线）；进入时本就
    // 未配置（应用后无法恢复为“未配置”，产品无停用/清空开关）或“确认应用”被拦截时
    // 按前置不足跳过，不破坏共享态。
    {
      await openTableFlowConfigPage(page);
      const probe = await openTableFlowDialog(page);
      const entryLevel = await readTableFlowLevel(probe);
      if (!entryLevel) {
        await closeTableFlowDialog(page, probe);
        skipForMissingEnvironment(
          '“表权限”流程配置弹窗未识别到已勾选的审批级数（进入时该类型疑似未配置）；'
            + '本轮应用自建配置后将无法恢复为“未配置”状态（产品无停用/清空开关），按前置不足跳过。',
        );
      }
      initialFlowSnapshot = await captureTableFlowSnapshot(probe, Number(entryLevel));
      await closeTableFlowDialog(page, probe);
      if (initialFlowSnapshot.nodes.some(([kind]) => !kind)) {
        skipForMissingEnvironment(
          '“表权限”流程进入时配置存在空级（类型/审批人为空）：本轮应用自建配置后无法恢复为'
            + '“未配置”状态（产品无停用/清空开关），按前置不足跳过，不破坏共享态。进入时快照='
            + initialFlowSnapshot.nodes.map((pair) => pair.join('/')).join('；'),
        );
      }
      const flowDialog = await openTableFlowDialog(page);
      await setTableFlowLevel(page, flowDialog, 2);
      await pickTableFlowNodeType(page, flowDialog, 0, '用户');
      await pickTableFlowNodeApprover(page, flowDialog, 0,
        new RegExp([approverLevel1.userName, approverLevel1.nickname].map(tableFlowEscapeRegExp).join('|')),
        approverLevel1.userName);
      await pickTableFlowNodeType(page, flowDialog, 1, '用户');
      await pickTableFlowNodeApprover(page, flowDialog, 1,
        new RegExp([approverLevel2.userName, approverLevel2.nickname].map(tableFlowEscapeRegExp).join('|')),
        approverLevel2.userName);
      await tableFlowRemarkBox(flowDialog).fill(TABLE_FLOW_MARKER);
      // 预应用持值断言：确认应用前说明确实持有本轮标记（确定性回读；重开后不回显）。
      await expect(tableFlowRemarkBox(flowDialog)).toHaveValue(TABLE_FLOW_MARKER);
      const blockedTip = await applyTableFlowDialog(page, flowDialog);
      if (blockedTip) {
        skipForMissingEnvironment(
          '本轮 2 级用户型审批流“确认应用”被拦截：' + blockedTip
            + '（校准点：确认必填项与应用限制；本轮配置未生效，共享配置未变更）。',
        );
      }
      flowMutated = true;
      // 应用后回显核验（DS-PERM-31 实证：说明不回显，仅核验级数与各级审批人）。
      const echo = await openTableFlowDialog(page);
      try {
        await expectTableFlowCondition(page, () => readTableFlowLevel(echo),
          (value) => value === '2', '应用后回显级数应为 2');
        for (const [index, approver] of [approverLevel1, approverLevel2].entries()) {
          await expectTableFlowCondition(page, async () => {
            const [kind, name] = await readTableFlowNodePair(echo, index);
            return kind + '|' + name;
          }, (value) => {
            const [kind, name] = value.split('|');
            return kind.includes('用户')
              && (name.includes(approver.userName) || name.includes(approver.nickname));
          }, '第 ' + (index + 1) + ' 级应回显本轮用户型审批人');
        }
      } finally {
        await closeTableFlowDialog(page, echo);
      }
      await report(
        'SM-02-01 阶段0b2｜自建“表权限”审批流（2 级用户型，本轮账号）',
        true,
        '进入时快照=级数 ' + initialFlowSnapshot.level + '、各级['
          + initialFlowSnapshot.nodes.map((pair) => pair.join('/')).join('；') + ']、说明“'
          + (initialFlowSnapshot.remark || '空') + '”（收尾按快照恢复）；本轮已应用=2 级用户型 '
          + approverLevel1.userName + '→' + approverLevel2.userName + '，说明标记=' + TABLE_FLOW_MARKER
          + '（重开不回显，人工检索线索）。',
      );
    }

    // 阶段0c（元数据预热）：让平台元数据缓存感知本轮新表（数据地图-表查询可检索）；
    // 尽力而为、如实记录，不阻断——真正验收以阶段1 申请提交（表可选）为准。
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
    await report('SM-02-01 阶段0c｜刷新数据库元数据（管理员）', true, metadataWarmup);

    // 阶段1（多级同意闭环）：申请人提交 → 我的申请-未审批在列 + 审批名称负向查询 →
    // 逐级审批人同意 → 已审批=已通过 → 申请人进入目标表详情（终态表权限生效证据）。
    const agreeMarker = permissionRunId('e2e_sm0201_agree');
    await loginAs(page, applicant, { entryUrl: entryUrlFor('/dataMap/tableQuery/tablesQuery') });
    const sequence = await submitTableApply(page, TARGET_TABLE, agreeMarker);
    pendingMarkers.push(agreeMarker);
    await report(
      '申请人已提交表权限申请',
      true,
      '表=' + TARGET_TABLE + '，申请原因标记=' + agreeMarker + '，审批序列=' + sequence.join('→') + '。',
    );

    // 提交落库核验：先在“我的申请-未审批”确认本申请在列（不依赖 toast）。
    await openApprovalPageAs(page, applicant, '我的申请');
    const pendingRow = await findMarkerRow(page, '未审批', agreeMarker);
    if (!pendingRow) {
      throw new Error('我的申请-未审批 未出现本申请 ' + agreeMarker + '：提交可能未落库或列表结构变化。');
    }
    // 审批名称模糊查询（保留原用例的列表筛选语义）：随机名应查不到任何行。
    await fillByLabel(page, '审批名称', permissionRunId('e2e_sm0201_none'));
    await page.getByRole('button', { name: /查\s*询/ }).first().click();
    await expect(visibleRows(page)).toHaveCount(0, { timeout: 10_000 });
    await fillByLabel(page, '审批名称', '');

    // 逐级审批（一级→二级→如有第三节点按同序列补审），每级由对应本轮账号真实处理。
    for (const userName of sequence) {
      const handled = await handlePendingApproval(page, identityByUserName(userName), agreeMarker, '同意');
      if (!handled) {
        throw new Error(
          '审批人 ' + userName + ' 的“我的审批-未审批”中没有本申请 ' + agreeMarker
            + '：审批流节点归属与脚本指派不一致（flash 验证点：确认该节点审批人配置）。',
        );
      }
      await report('审批节点已同意', true, '审批人=' + userName + '，标记=' + agreeMarker + '。');
    }

    // 申请人确认最终状态=已通过（最终节点同意才回写通过）。
    await expectFinalStatusAsApplicant(page, applicant, agreeMarker, /已通过/, '已通过');
    markSettled(agreeMarker);

    // 生效层复核：申请人重新打开数据地图-表查询并进入目标表详情。
    const card = await openTargetTableCard(page, TARGET_TABLE);
    if (!card) throw new Error('审批通过后申请人在表查询中搜不到目标表 ' + TARGET_TABLE + '。');
    const name = card.locator('.table-name:visible, [class*="table-name"]:visible').first();
    await name.click();
    await expect(page.getByRole('heading', { name: '基础信息' })).toBeVisible({ timeout: 10_000 });

    await report(
      'SM-02-01 阶段1｜多级审批同意闭环',
      true,
      '表=' + TARGET_TABLE + '，标记=' + agreeMarker + '，序列=' + sequence.join('→') + '，最终状态=已通过，表详情可达，申请契约=['
        + applyContractEvidence.join('；') + ']。',
    );

    // 阶段1.5（回收本轮授权行）：终审同意会对申请人自动授权该表；若不回收，拒绝路径
    // 的再次申请可能因“已持有权限”而搜不到申请入口。资源视角页面操作、尽力而为；
    // 失败只附证据，阶段2 由提交入口可见性如实定性（不伪造通过）。
    try {
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      const released = await purgeOwnGrantedTablePermissions(page);
      await report(
        'SM-02-01 阶段1.5｜回收本轮已授权表权限',
        true,
        `已删除“本轮申请人×本轮表”授权 ${released} 条（0 条=资源视角未见授权行，不影响继续）。`,
      );
    } catch (releaseError) {
      test.info().attach('SM-02-01-阶段1.5回收证据.txt', {
        body: String(releaseError instanceof Error ? releaseError.message : releaseError),
        contentType: 'text/plain; charset=utf-8',
      });
    }

    // 阶段2（一级拒绝闭环）：申请人再提交 → 未审批在列 → 一级审批人拒绝 → 已驳回。
    const rejectMarker = permissionRunId('e2e_sm0201_reject');
    await loginAs(page, applicant, { entryUrl: entryUrlFor('/dataMap/tableQuery/tablesQuery') });
    const rejectSequence = await submitTableApply(page, TARGET_TABLE, rejectMarker);
    pendingMarkers.push(rejectMarker);
    // 提交落库核验（与同意路径同标准）：先在“我的申请-未审批”确认本申请在列，
    // 再切换审批人——避免提交环节的静默失败被误读成“审批节点未指派/为空”
    // （run-20260920-222301 实测教训：弹窗被误关后断言 705 把测试侧问题错怪到节点归属）。
    await openApprovalPageAs(page, applicant, '我的申请');
    if (!(await findMarkerRow(page, '未审批', rejectMarker))) {
      throw new Error('我的申请-未审批 未出现本申请 ' + rejectMarker + '：提交可能未落库或列表结构变化。');
    }
    // 拒绝在第一节点即可终止流程（后端：任一节点驳回即回写已驳回）。
    const rejected = await handlePendingApproval(page, identityByUserName(rejectSequence[0]), rejectMarker, '拒绝');
    if (!rejected) {
      throw new Error('一级审批人 ' + rejectSequence[0] + ' 未在“我的审批-未审批”中看到申请 ' + rejectMarker + '。');
    }
    await expectFinalStatusAsApplicant(page, applicant, rejectMarker, /已驳回|已拒绝/, '已驳回/已拒绝');
    markSettled(rejectMarker);
    await report(
      'SM-02-01 阶段2｜一级审批拒绝闭环',
      true,
      '表=' + TARGET_TABLE + '，标记=' + rejectMarker + '，一级审批人=' + rejectSequence[0] + '，最终状态=已驳回。',
    );

    await assertNoConsoleErrors(consoleErrors);
    await report(
      'SM-02-01｜系统管理｜申请权限→我的申请→我的审批→同意 拒绝',
      true,
      `表=${TARGET_TABLE}（本轮自备）；主体=${applicant.userName}/${approverLevel1.userName}/${approverLevel2.userName}（本轮自备，收尾回收）；`
        + `审批流=本轮自建 2 级用户型（收尾恢复进入时配置）；同意路径序列=${sequence.join('→')}→已通过+表详情可达；拒绝路径=一级拒绝→已驳回。`,
    );

  } catch (error) {
    mainError = error;
    throw error;
  } finally {
    // 收尾回收（仅本轮前缀资产；每步尽力而为、失败仅记录不抛出，不掩盖主结果）。
    const issues: string[] = [];
    // 1) 兜底撤销仍处未审批的本轮申请（如审批动作前中断），避免悬挂待审批单。
    try {
      await revokeLeftoverPendingApplications(page);
    } catch (cleanupError) {
      issues.push(`遗留申请兜底撤销异常：${cleanupError instanceof Error ? cleanupError.message.split('，')[0] : String(cleanupError)}`);
    }
    // 2) 恢复“表权限”审批流进入时配置（DS-PERM-69；共享配置，恢复失败在通过路径显式
    //    失败、主路径已失败/跳过时仅告警附证据，不掩盖共享态漂移；口径同 SM-02-03 收尾）。
    let flowRestoreFailed = false;
    if (flowMutated && initialFlowSnapshot) {
      try {
        await loginAs(page, adminIdentity);
        await openTableFlowConfigPage(page);
        const dialog = await openTableFlowDialog(page);
        try {
          await restoreTableFlowSnapshot(page, dialog, initialFlowSnapshot);
        } finally {
          await closeTableFlowDialog(page, dialog);
        }
        const echo = await openTableFlowDialog(page);
        let echoLevel = '';
        try {
          echoLevel = await readTableFlowLevel(echo);
        } finally {
          await closeTableFlowDialog(page, echo);
        }
        if (echoLevel !== initialFlowSnapshot.level) {
          throw new Error('恢复后回显级数=' + (echoLevel || '空') + '，应为 ' + initialFlowSnapshot.level + '（校准点）。');
        }
        await report('SM-02-01 收尾｜恢复“表权限”审批流进入时配置', true,
          '级数=' + initialFlowSnapshot.level + '，各级=[' + initialFlowSnapshot.nodes.map((pair) => pair.join('/')).join('；')
            + ']；说明按快照尽力回填（产品重开弹窗不回显说明；人工检索标记=' + TABLE_FLOW_MARKER + '）。');
      } catch (restoreError) {
        flowRestoreFailed = true;
        const detail = restoreError instanceof Error ? restoreError.message : String(restoreError);
        issues.push(`“表权限”审批流恢复未闭环：${detail}`);
        await test.info().attach('SM-02-01-审批流恢复证据.txt', {
          body: '恢复进入时配置失败：' + detail + '；快照=' + JSON.stringify(initialFlowSnapshot)
            + '；本轮标记=' + TABLE_FLOW_MARKER + '（请人工按标记检索恢复）。',
          contentType: 'text/plain; charset=utf-8',
        }).catch(() => undefined);
      }
    }
    // 3) 回收“本轮申请人 × 本轮专用表”授权行（终审同意的自动授权；先删授权行再删表）。
    try {
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      const removed = await purgeOwnGrantedTablePermissions(page);
      if (removed > 0) {
        await report('SM-02-01 收尾｜回收本轮授权', true, `已删除“本轮申请人×本轮表”授权 ${removed} 条（表=${TARGET_TABLE}）。`);
      }
    } catch (purgeError) {
      issues.push(`本轮授权回收未完成（${TARGET_TABLE}×${applicant.userName}）：${purgeError instanceof Error ? purgeError.message.split('，')[0] : String(purgeError)}`);
    }
    // 4) DROP 本轮专用表（授权行已按主体×表清理；表删除即兜底彻底回收）。
    try {
      await query(`DROP TABLE IF EXISTS ${TARGET_TABLE}`);
    } catch (dropError) {
      issues.push(`专用表回收未完成（${TARGET_TABLE}）：${dropError instanceof Error ? dropError.message : String(dropError)}`);
    }
    // 5) 删除本轮自建账号（用户管理页行内删除；角色按先例保留——唯一 UUID 命名）。
    try {
      await loginAs(page, adminIdentity);
      const outcomes: string[] = [];
      for (const identity of [applicant, approverLevel1, approverLevel2]) {
        outcomes.push(`${identity.userName}：${await deleteOwnUser(page, identity)}`);
      }
      await report('SM-02-01 收尾｜回收本轮账号', true, outcomes.join('；') + '。');
    } catch (userError) {
      issues.push(`本轮账号回收未完成：${userError instanceof Error ? userError.message.split('，')[0] : String(userError)}`);
    }
    for (const issue of issues) console.warn(`[SM-02-01 收尾] ${issue}`);
    // DS-PERM-69：共享“表权限”审批流恢复失败属共享态漂移——通过路径必须显式失败；
    // 主路径已失败/跳过时保留原始结果，仅以告警与附件暴露（不掩盖）。
    if (!mainError && flowRestoreFailed) {
      throw new Error('“表权限”审批流恢复未闭环（共享态漂移；详见附件 SM-02-01-审批流恢复证据.txt）。');
    }
  }
});
