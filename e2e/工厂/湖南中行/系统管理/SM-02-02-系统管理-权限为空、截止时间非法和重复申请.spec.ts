/**
 * SM-02-02｜系统管理｜表权限申请异常路径（空权限/非法期限/字段范围/无审批流）
 *
 * DS-PERM-33 清洁环境静态校准（2026-09-22，环境不可用，仅静态校准，不运行 Playwright）：
 * 在 PERM-STATIC-04 静态骨架上解除全部历史固化资产依赖，改为本轮自备（全 ASCII 唯一）：
 *   - 主体：申请人/一级/二级审批人均为 newPermissionIdentity('sm0202*') UUID 唯一账号
 *     （管理员 createAndInviteUser 页面化创建，收尾尽力删除回收），不再依赖
 *     permissionFixtures 固化用户（sm02_apply_user / e2e_perm_*_v2 等）；
 *   - 角色：本轮 newPermissionRole 唯一角色并绑定对应账号（菜单按 SM-00-01 实证口径：
 *     申请人=数据地图+数据查询，审批人=数据地图；唯一命名，按 SM-00-02/DS-PERM-25/30
 *     先例用后保留，不创建、不修改任何既有角色/用户）；
 *   - 目标表：RUN_TAG=e2e_sm0202_<uuid>，两张专用表 <RUN_TAG>_t / <RUN_TAG>_u MySQL 直连
 *     CREATE TABLE（sm_id/sm_name/sm_value 三列、各 2 行种子，COUNT=2 硬断言），不读
 *     DATA_PERMISSION_TABLE、无固化兜底表名；阶段0c 元数据预热；finally DROP IF EXISTS；
 *   - 申请单：permissionRunId 唯一 marker（申请原因），仅命中本轮自建申请，绝不使用
 *     历史记录；负向意外提交的补救撤销与收尾兜底撤销都仅针对本轮 marker。
 *
 * 五条产品断言保持不变（PERM-STATIC-04 口径，未削弱），以单用例分阶段承载：
 *   阶段1 空权限：不勾选任何权限类型提交 → 应被表单校验拦截；
 *   阶段2 截止时间非法：截止时间改为过去日期（或清空）提交 → 应被拦截；
 *   阶段3 单表部分字段：字段范围=部分字段时可多选字段，属合法申请——提交成功落库
 *        （我的申请-未审批 在列）后立即撤销并核验终态=已撤销、未审批页签消失，
 *        不遗留待审批数据；
 *   阶段4 多表禁止部分字段：勾选本轮两张自备表批量申请并选择部分字段 → 应被拦截；
 *   阶段5 无审批流：申请弹窗无可用审批流时提交 → 应被拦截。
 *
 * 同包显式前置（DS-PERM-69 清洁环境：阶段0b2 管理员把“表权限”审批流整体替换为本轮
 * 自建 2 级用户型审批人，进入时先捕获快照、finally 按快照恢复；口径同 SM-02-01/03）：
 *   - 阶段3 正向提交依赖该自建审批流（用户型节点候选含本轮审批人）；进入时该类型本
 *     就未配置（应用后无法恢复为“未配置”）或“确认应用”被拦截时按前置不足 skip，不破坏共享态；
 *   - 阶段5 仅在页面自然呈现“无可用审批流”时验证；本轮已自建审批流（阶段3 依赖同一
 *     配置）时按前置不足 skip 并写明原因，脚本不擅自移除审批流配置（互补而非矛盾）；
 *   - 阶段4 需要表查询提供批量申请入口（批量按钮或卡片复选框），缺失时按前置不足
 *     skip 并附证据（校准点：批量申请入口形态）。
 *
 * 副作用与回收（清洁环境）：本用例不执行任何“同意”审批动作，申请在待审批阶段即撤销，
 * 不会产生表授权行（授权仅发生在终审通过后，见 SM-02-05/06 语义）；finally 顺序：兜底
 * 撤销遗留未审批申请（仅本轮 marker）→ DROP 两张本轮表 → 删除本轮账号（角色按先例
 * 保留）。中断轮次也回收本轮资产，不触碰任何既有用户/角色/表/申请。
 *
 * 结构（DS-PERM-24/25/29/30 同型单用例 try/finally）：阶段0a 自建两张专用表 → 0b 自建
 * 账号与角色 → 0c 元数据预热 → 1 空权限 → 2 非法期限 → 3 单表部分字段正向+撤销自清理
 * → 4 多表+部分字段拦截 → 5 无审批流拦截 → finally 回收。复用 SM-02-01 已实证入口：
 * 申请人登录 → 数据地图-表查询 搜索目标表 → 卡片/详情“申请权限”弹窗。
 *
 * 规则：RUN_PERMISSION_APPROVAL=1 闸门（条件 skip、非永久）；DB_* MySQL 前置门禁（条件
 * skip）；负向用例若“未被拦截”，先尽力撤销本轮申请再定性失败，不把测试侧定位问题伪装
 * 成产品缺陷，也不留悬挂待审批数据；串行执行（--workers=1，跨账号状态不复用）；浏览器
 * 页面操作 + MySQL 直连 DDL（仅本轮自备表）。
 *
 * 页面恢复后优先校准（TODO[env] --headed 首轮）：字段范围控件形态、批量申请入口形态、
 * 审批流缺失提示文案、日期控件交互方式、卡片复选框与批量弹窗联动。
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
  dismissPermissionDropdown,
  requirePermissionTableName,
  resolveMysqlPermissionResource,
  type MysqlPermissionResource,
} from './数据权限闭环工具.js';
import {
  approvalEntryUrl,
  expectApplicationFinalStatus,
  findApprovalMarkerRow,
  openApprovalLeaf,
  openApprovalWorkbenchAs,
  openTableQueryCard,
  permissionRunId,
  requireAdminIdentity,
  requirePermissionApprovalEnvironment,
  revokeApplicationAsApplicant,
} from './权限审批待调试工具.js';

/** 本轮自备主体（DS-PERM-33 起解耦 permissionFixtures 固化用户依赖；全 ASCII 唯一）。 */
const applicant = newPermissionIdentity('sm0202a');
const approverLevel1 = newPermissionIdentity('sm0202l1');
const approverLevel2 = newPermissionIdentity('sm0202l2');

/** 正向阶段（单表部分字段）的可指派审批人：均为本轮自建账号（循环承接各节点）。 */
const APPROVAL_PLAN: PermissionIdentity[] = [approverLevel1, approverLevel2];

/** 本轮自备角色：菜单按 SM-00-01 实证口径（DS-PERM-30 同型）；唯一 UUID 命名，用后保留。 */
const ROLE_PLAN: Array<{ role: PermissionRole; menus: string[]; member: PermissionIdentity }> = [
  { role: newPermissionRole('sm0202', 'applicant'), menus: ['数据地图', '数据查询'], member: applicant },
  { role: newPermissionRole('sm0202', 'approver1'), menus: ['数据地图'], member: approverLevel1 },
  { role: newPermissionRole('sm0202', 'approver2'), menus: ['数据地图'], member: approverLevel2 },
];

/** 本轮运行标记：两张自备表共用该前缀（表查询检索一次即可同屏见两张卡片）。 */
const RUN_TAG = `e2e_sm0202_${uuid()}`;

/** 本轮自备专用表×2：主表承载单表场景；副表与主表共同构成“多表”并承载无审批流场景。 */
const permissionResource: MysqlPermissionResource = resolveMysqlPermissionResource({
  tableName: `${RUN_TAG}_t`,
});
const TABLE_MAIN = requirePermissionTableName(permissionResource);
const TABLE_SECOND = `${RUN_TAG}_u`;

/** 自助查询数据源弹窗展示基础名（如 192.168.76.110），与数据权限页完整展示名不同（同 SM-03-09）。 */
const querySourceName = (process.env.QUERY_SOURCE_NAME?.trim() || permissionResource.sourceName)
  .split(/[:：]/)[0].trim();

/** 仍处“未审批”的本轮申请 marker：可能落库前入列；终态确认后出列；finally 兜底撤销。 */
const pendingMarkers: string[] = [];

/** 下拉选项渲染在页面级（teleport），Ant/Element 双兼容（与 SM-02-01 同源）。 */
const OPTION_SELECTOR = [
  '.ant-select-dropdown:visible .ant-select-item-option',
  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
  '.el-select-dropdown:visible .el-select-dropdown__item',
  '[role="listbox"]:visible [role="option"]',
  'li[role="option"]:visible',
].join(', ');

/** “无可用审批流”提示文案（阶段3 前置判定与阶段5 拦截验收共用）。 */
const FLOW_MISSING_PATTERN = /暂无审批流|未配置审批|无可用审批|没有审批流|暂无流程/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 返回 locator 中第一个可见元素（自上而下），与 SM-02-01 firstVisibleMatching 一致。 */
async function firstVisibleMatching(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

/** 有界轮询：action 返回 true 即成功；超时返回 false（不抛错，由调用方定性）。 */
async function waitForTrue(page: Page, action: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await action().catch(() => false)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/** 前置不足：写清原因后跳过，不伪造通过、不误报缺陷。 */
function skipForMissingEnvironment(reason: string): never {
  test.info().attach('ENV-SM0202-前置证据.txt', { body: reason, contentType: 'text/plain; charset=utf-8' });
  test.skip(true, 'ENV-SM0202：' + reason);
  throw new Error('UNREACHABLE：test.skip 应已中断用例。');
}

/** marker 标记终态：从未审批跟踪表移除（indexOf<0 时不动，防 splice(-1) 误删末位）。 */
function markSettled(marker: string): void {
  const index = pendingMarkers.indexOf(marker);
  if (index >= 0) pendingMarkers.splice(index, 1);
}

/**
 * 自助查询侧栏在部分版本只渲染图标链接（本地复刻自 SM-03-09/DS-PERM-30，共享 utils 未
 * 导出该入口，保持双孪生可编译）：优先侧栏真实链接，否则已知 hash 路由直达。
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

/** “刷新数据库元数据”确认弹窗处理（复制自 SM-03-09/SM-03-06/DS-PERM-30 已实证实现）。 */
async function confirmMetadataRefreshDialog(page: Page, timeoutMs = 8_000): Promise<boolean> {
  const dialog = page.locator('[role="dialog"]:visible, .el-message-box:visible, .ant-modal:visible').first();
  if (!(await dialog.isVisible().catch(() => false))) return false;
  const confirm = dialog.getByRole('button', { name: /确\s*定|^是$/ }).first();
  if (!(await confirm.isVisible().catch(() => false))) return false;
  await confirm.click({ timeout: timeoutMs }).catch(() => undefined);
  await expect(dialog).toBeHidden({ timeout: 15_000 }).catch(() => undefined);
  return true;
}

/** 元数据预热前刷新数据库元数据（目录控件未渲染时安全跳过；同 SM-03-09/DS-PERM-30）。 */
async function refreshDatabaseMetadata(page: Page): Promise<void> {
  await expect(page.getByText('数据库', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  const treeIcon = page.locator('.ant-tree-title, .el-tree-node__label').first();
  if (!(await treeIcon.isVisible().catch(() => false))) return;
  await treeIcon.hover();
  const refreshButton = page.locator('[aria-label*="刷新"], [title*="刷新"]').first();
  if (!(await refreshButton.isVisible().catch(() => false))) return;
  await refreshButton.click().catch(() => undefined);
  await confirmMetadataRefreshDialog(page);
}

/**
 * 创建本轮唯一专用表并写入 2 行种子（MySQL 直连 DDL，仅本用例资源；模板 SM-03-09/
 * DS-PERM-30 createPermissionFixtureTable）。建表失败为真实失败（调用方上抛前尽力
 * DROP 半建表），不伪造通过。
 */
async function createPermissionFixtureTable(tableName: string, seedLabel: string): Promise<number> {
  await query(
    `CREATE TABLE ${tableName} (`
      + 'sm_id varchar(64) NOT NULL,'
      + 'sm_name varchar(128) DEFAULT NULL,'
      + 'sm_value varchar(128) DEFAULT NULL,'
      + 'PRIMARY KEY (sm_id)'
      + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
  );
  await query(
    `INSERT INTO ${tableName} (sm_id, sm_name, sm_value) VALUES `
      + `('sm-1', '${seedLabel}-a', '${tableName}'), ('sm-2', '${seedLabel}-b', 'sm0202-apply-edge')`,
  );
  const rows = await query(`SELECT COUNT(*) AS total FROM ${tableName}`);
  const total = Number((rows[0] as { total?: unknown } | undefined)?.total ?? -1);
  expect(total, `专用表 ${tableName} 种子数据应为 2 行，实际：${JSON.stringify(rows)}`).toBe(2);
  return 2;
}

/**
 * 尽力删除本轮自建账号（用户管理页：按本轮唯一账号查询 → 行内“删除”→ 确认；模板
 * SM-03-09/DS-PERM-30 deleteOwnUser）。只回收本轮自备账号；任一步不满足都返回说明
 * 文本而不抛错，不掩盖主结果。
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

/** 可见弹层（Ant/Element 双兼容）：申请权限与批量申请弹窗共用。 */
function visibleLayer(page: Page): Locator {
  return page.locator(
    '[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible, .ant-drawer:visible, .el-drawer:visible',
  ).last();
}

/**
 * 打开目标表的“申请权限”弹窗并返回弹层。入口优先级：卡片“申请权限”图标 → 表详情页
 * “申请权限”按钮（与 SM-02-01/共享 submitTablePermissionApply 同源）。
 */
async function openApplyDialog(page: Page, tableName: string): Promise<Locator> {
  const card = await openTableQueryCard(page, tableName);
  if (!card) {
    skipForMissingEnvironment(
      '申请人在数据地图-表查询中搜不到本轮自备表 ' + tableName
        + '（元数据可能未刷新，阶段0c 预热未生效；校准点：元数据刷新机制/表查询检索）。',
    );
  }
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
        '目标表 ' + tableName + ' 的卡片与详情页均未见“申请权限”入口：可能申请人已持有该表权限，或页面结构已变化（校准点：卡片操作区实现）。',
      );
    }
  }
  const layer = visibleLayer(page);
  await expect(layer).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/申请表|申请权限/).first()).toBeVisible();
  return layer;
}

/** 申请原因：本轮 UUID 唯一标记（负向用例意外提交时也以此标记定位撤销）。 */
async function fillApplyReason(layer: Locator, marker: string): Promise<void> {
  const labelledBox = layer.getByRole('textbox', { name: /申请原因|申请说明|申请理由|备注/ }).first();
  let reasonBox: Locator | undefined = await labelledBox.isVisible().catch(() => false) ? labelledBox : undefined;
  if (!reasonBox) reasonBox = await firstVisibleMatching(layer.locator('textarea:visible'));
  if (!reasonBox) {
    throw new Error('申请弹窗未找到“申请原因”输入框（校准点）：' + (await layer.innerText().catch(() => '')).slice(0, 200));
  }
  await reasonBox.fill(marker);
}

/** 确保“使用”权限类型勾选（软校验：控件缺失或勾选未生效返回 false，不阻断）。 */
async function ensureUsePermissionChecked(layer: Locator): Promise<boolean> {
  const flag = layer.locator('[type="checkbox"], .el-checkbox, .ant-checkbox').filter({ hasText: '使用' }).first();
  if (!(await flag.isVisible().catch(() => false))) return false;
  const input = flag.locator('input[type="checkbox"]').first();
  if (!(await input.isChecked().catch(() => false))) await flag.click();
  return input.isChecked().catch(() => false);
}

/** 取消弹窗内所有权限类型勾选（空权限场景）。 */
async function uncheckAllPermissionTypes(layer: Locator): Promise<void> {
  for (const typeLabel of ['使用', '管理']) {
    const flag = layer.locator('[type="checkbox"], .el-checkbox, .ant-checkbox').filter({ hasText: typeLabel }).first();
    if (!(await flag.isVisible().catch(() => false))) continue;
    const input = flag.locator('input[type="checkbox"]').first();
    if (await input.isChecked().catch(() => false)) await flag.click();
  }
}

/** 尽力撤销本轮待审批申请（负向用例意外提交后的自清理；全程容错，失败不掩盖原始失败）。 */
async function attemptRevokeBestEffort(page: Page, marker: string): Promise<void> {
  try {
    await revokeApplicationAsApplicant(page, applicant, marker);
    markSettled(marker);
  } catch {
    // 自清理失败不掩盖原始定性失败；悬挂申请以 marker 标记，便于人工清理定位。
  }
}

/**
 * 负向提交探针：点击提交后期望 弹窗保持开启 或 出现校验提示 = 被拦截。
 * 未被拦截时（真实提交可能已落库）：尽力撤销本轮申请后再定性失败。
 */
async function expectSubmitBlocked(page: Page, layer: Locator, marker: string): Promise<string> {
  const submit = layer.getByRole('button', { name: /提\s*交|确\s*定/ }).last();
  if (!(await submit.isVisible().catch(() => false))) {
    throw new Error('申请弹窗未找到提交按钮（校准点：确认提交按钮定位）。');
  }
  await submit.click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  const tip = page.getByText(/不能为空|请选择|请勾选|请输入|至少|必填|未指定|不允许|不支持|已过期|晚于|早于|失败/).first();
  const tipText = (await tip.isVisible().catch(() => false)) ? ((await tip.innerText().catch(() => '')) ?? '').trim() : '';
  const stillOpen = await layer.isVisible().catch(() => false);
  if (stillOpen || tipText) {
    return (stillOpen ? '拦截证据=弹窗保持开启' : '拦截证据=页面校验提示') + (tipText ? '；提示=' + tipText : '');
  }
  await attemptRevokeBestEffort(page, marker);
  throw new Error('负向提交未被拦截（弹窗已关闭且无校验提示）：校准点——确认产品是否允许该非法值；若确属允许请回填用例预期；本轮申请已尽力撤销。');
}

/**
 * 指派弹窗内全部可指派审批节点（本轮审批人循环承接），返回实际指派序列（登录用户名）。
 * 无可指派节点时：呈现“无可用审批流”→ 按前置不足 skip（该拦截由阶段5 验收）；否则按
 * 固定审批人流处理（返回空序列，直接提交）。候选缺失时只读探查候选名单后 skip，不留
 * 悬挂申请。
 */
async function assignApprovalNodesFromPlan(page: Page, layer: Locator): Promise<string[]> {
  const sequence: string[] = [];
  const boxes = layer.locator('.el-select:visible, .ant-select:visible');
  const total = await boxes.count();
  for (let index = 0; index < total; index += 1) {
    const box = boxes.nth(index);
    const input = box.locator('input').first();
    const placeholder = (await input.getAttribute('placeholder').catch(() => '')) ?? '';
    const boxText = (await box.innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (!/请选择(用户|审批人)/.test(placeholder + ' ' + boxText)) continue;
    const assignee = APPROVAL_PLAN[sequence.length % APPROVAL_PLAN.length];
    const aliases = [assignee.userName, assignee.nickname];
    await box.click();
    await waitForTrue(page, async () => (await page.locator(OPTION_SELECTOR).count()) > 0, 4_000);
    const option = await firstVisibleMatching(
      page.locator(OPTION_SELECTOR).filter({ hasText: new RegExp(aliases.map(escapeRegExp).join('|')) }),
    );
    if (!option) {
      const candidates = (await page.locator(OPTION_SELECTOR).allInnerTexts().catch(() => [] as string[]))
        .map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean);
      await dismissPermissionDropdown(page);
      skipForMissingEnvironment(
        '待指派审批节点候选中无本轮自备审批人（实测候选=[' + candidates.join('、') + ']）；正向提交需本轮审批人可承接的审批流（校准点：审批流配置/候选来源）。',
      );
    }
    await option.click();
    await dismissPermissionDropdown(page);
    sequence.push(assignee.userName);
  }
  if (sequence.length === 0) {
    const text = (await layer.innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (FLOW_MISSING_PATTERN.test(text)) {
      skipForMissingEnvironment(
        '申请弹窗呈现“无可用审批流”：单表部分字段正向提交需要可用审批流（该拦截行为由阶段5 单独验收），本轮无法完成正向闭环（校准点：表权限审批流配置）。',
      );
    }
    // 无待指派节点且无“无审批流”提示：按固定审批人流处理，直接提交（拦截语义交给提交探针）。
  }
  return sequence;
}

/** 选择“部分字段”并勾选最多 2 个非“使用/管理”的字段复选项，返回字段标签（字段可多选证据）。 */
async function pickPartialFieldOptions(layer: Locator): Promise<string[]> {
  const partial = layer.getByText(/部分字段|自选字段/).first();
  if (!(await partial.isVisible().catch(() => false))) {
    skipForMissingEnvironment('申请弹窗未提供“部分字段”选择（校准点：确认字段范围控件形态）；字段范围场景无法构造。');
  }
  await partial.click();
  await layer.page().waitForTimeout(600);

  const fieldFlags = layer.locator('[type="checkbox"], .el-checkbox, .ant-checkbox')
    .filter({ hasNotText: /使用|管理/ });
  const picked: string[] = [];
  const total = await fieldFlags.count();
  for (let index = 0; index < total && picked.length < 2; index += 1) {
    const flag = fieldFlags.nth(index);
    if (!(await flag.isVisible().catch(() => false))) continue;
    const label = ((await flag.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    await flag.click();
    picked.push(label.slice(0, 40));
  }
  if (picked.length === 0) {
    skipForMissingEnvironment('选择“部分字段”后未出现可勾选的字段列表（校准点：确认字段多选控件形态）。');
  }
  return picked;
}

/** 正向提交：提交后弹窗应关闭（落库证据由 我的申请-未审批 行核对）。 */
async function submitAndExpectClosed(page: Page, layer: Locator): Promise<void> {
  const submit = layer.getByRole('button', { name: /提\s*交|确\s*定/ }).last();
  await expect(submit).toBeVisible();
  const blocked = page.getByText(/未指定审批人|请补全/).first();
  try {
    await submit.click({ timeout: 10_000 });
  } catch {
    if (await blocked.isVisible().catch(() => false)) {
      throw new Error('提交被表单校验拦截：' + ((await blocked.innerText().catch(() => '')) ?? ''));
    }
    await page.waitForTimeout(3_000);
    if (await layer.isVisible().catch(() => false)) {
      const retry = layer.getByRole('button', { name: /提\s*交|确\s*定/ }).last();
      if (!(await retry.isDisabled().catch(() => false))) await retry.click({ timeout: 10_000 }).catch(() => undefined);
    }
  }
  await expect.poll(async () => {
    if (await blocked.isVisible().catch(() => false)) return 'blocked';
    return (await layer.isVisible().catch(() => false)) ? 'open' : 'closed';
  }, { timeout: 15_000 }).toBe('closed');
}

/** 勾选卡片复选框（仅本轮自备表卡片）：优先可见 input，回退复选框包装节点；勾选后复核。 */
async function checkTableCard(page: Page, card: Locator, tableName: string): Promise<void> {
  const input = card.locator('input[type="checkbox"]').first();
  if (await input.isVisible().catch(() => false)) {
    if (!(await input.isChecked().catch(() => false))) await input.click();
  } else {
    const wrapper = await firstVisibleMatching(
      card.locator('.el-checkbox:visible, .ant-checkbox:visible, .ant-checkbox-wrapper:visible, [class*="checkbox" i]:visible'),
    );
    if (!wrapper) {
      skipForMissingEnvironment('本轮自备表 ' + tableName + ' 卡片内未见复选框（校准点：卡片多选控件形态）；多表场景无法构造。');
    }
    await wrapper.click();
  }
  const checked = await waitForTrue(page, async () => input.isChecked().catch(() => false), 5_000);
  if (!checked) {
    throw new Error('卡片 ' + tableName + ' 复选框勾选未生效（校准点：卡片多选交互）。');
  }
}

/** 兜底撤销仍处未审批的本轮申请：仅本轮 marker；失败附证据不掩盖主结果。 */
async function revokeLeftoverPendingApplications(page: Page): Promise<void> {
  for (const marker of pendingMarkers.slice()) {
    try {
      await revokeApplicationAsApplicant(page, applicant, marker);
      markSettled(marker);
      console.warn(`[SM-02-02 收尾] 遗留申请 ${marker} 已兜底撤销。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      test.info().attach('SM-02-02-收尾清理证据.txt', {
        body: '兜底撤销申请 ' + marker + ' 失败：' + message,
        contentType: 'text/plain; charset=utf-8',
      });
      console.warn(`[SM-02-02 收尾] 遗留申请 ${marker} 兜底撤销失败：${message.slice(0, 160)}`);
    }
  }
}

/**
 * ── 本轮自建“表权限”审批流配置（DS-PERM-69 清洁环境迁移；复刻 SM-02-03/SM-02-01）──
 * 系统管理→审批管理→流程配置：按业务类型卡片布局，“表权限申请”卡片恰 1 个“配 置”
 * 入口；配置弹窗=审批级数 radio(1-5)+审批说明 textarea+环节设置（每级 审批人类型/
 * 具体审批人 两个 select，DOM 序 2i/2i+1）+“确认应用”（同类型唯一配置槽：整体替换，
 * 无新建/停用开关）。本轮把“表权限”流整体替换为 2 级用户型审批人（均为本轮自建
 * 账号）；进入时先捕获快照，finally 按快照恢复（共享配置，恢复失败在通过路径显式
 * 失败）。已知边界（DS-PERM-31 实证）：重开弹窗不回显审批说明；进入时该类型本就
 * 未配置时应用后无法恢复为“未配置”——应用前检测并按前置不足跳过，不破坏共享态。
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
const TABLE_FLOW_MARKER = permissionRunId('e2e_flow0202');

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

test('SM-02-02｜系统管理｜表权限申请异常路径（空权限/非法期限/字段范围/无审批流）', async ({ loginPage, consoleErrors, report }) => {
  requirePermissionApprovalEnvironment();

  // 前置门禁（条件 skip、非永久）：两张本轮专用表必须 MySQL 直连创建；DB_* 未配置或非
  // MySQL 时按“前置不足”跳过并写明原因（数据库配置存在但不可达时建表为真实失败）。
  const cfg = dbConfig();
  if (!cfg || cfg.type !== 'mysql') {
    test.skip(
      !cfg || cfg.type !== 'mysql',
      `前置不足：未配置 MySQL 数据库环境（DB_TYPE=${process.env.DB_TYPE ?? ''}，DB_HOST=${process.env.DB_HOST ?? ''}），无法创建本轮唯一专用表。`,
    );
  }

  test.setTimeout(900_000);
  const page = loginPage;
  const adminIdentity = requireAdminIdentity();

  /** DS-PERM-69：阶段0b2 “确认应用”成功后置 true——finally 据此恢复进入时配置。 */
  let flowMutated = false;
  /** “表权限”流程进入时配置快照（阶段0b2 首开弹窗捕获；finally 恢复基线）。 */
  let initialFlowSnapshot: TableFlowSnapshot | undefined;
  /** 主路径异常/跳过标记：finally 中恢复失败仅在通过路径上升级为失败。 */
  let mainError: unknown;

  try {
    // 阶段0a（自备专用表×2）：MySQL 直连建表 + 各 2 行种子；建表失败为真实失败，上抛前
    // 先尽力 DROP 半建表避免残留。主表承载单表场景，副表与主表共同构成“多表”。
    let seededMain = 0;
    let seededSecond = 0;
    try {
      seededMain = await createPermissionFixtureTable(TABLE_MAIN, 'e2e-sm0202-main');
      seededSecond = await createPermissionFixtureTable(TABLE_SECOND, 'e2e-sm0202-second');
    } catch (fixtureError) {
      await query(`DROP TABLE IF EXISTS ${TABLE_MAIN}`).catch(() => undefined);
      await query(`DROP TABLE IF EXISTS ${TABLE_SECOND}`).catch(() => undefined);
      throw fixtureError;
    }
    await report(
      'SM-02-02 阶段0a｜创建本轮专用表',
      true,
      `主表=${permissionResource.sourceName}/${TABLE_MAIN}（种子 ${seededMain} 行）；副表=${TABLE_SECOND}（种子 ${seededSecond} 行）；均为 MySQL 直建、列 sm_id/sm_name/sm_value。`,
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
      'SM-02-02 阶段0b｜创建本轮账号与角色',
      true,
      `申请人=${applicant.userName}；一级=${approverLevel1.userName}；二级=${approverLevel2.userName}；`
        + `角色=${ROLE_PLAN.map((plan) => plan.role.roleName).join('、')}（唯一命名，用后保留）。`,
    );

    // 阶段0b2（自建审批流配置，DS-PERM-69）：管理员把“表权限”审批流整体替换为 2 级
    // 用户型审批人（一级=l1、二级=l2，均本轮自建账号）——阶段3 正向提交与“多表/部分
    // 字段”拦截探针不再依赖环境历史审批流与固定审批人。进入时先捕获快照（finally 恢复
    // 基线）；进入时本就未配置（应用后无法恢复为“未配置”，产品无停用/清空开关）或
    // “确认应用”被拦截时按前置不足跳过，不破坏共享态。
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
        'SM-02-02 阶段0b2｜自建“表权限”审批流（2 级用户型，本轮账号）',
        true,
        '进入时快照=级数 ' + initialFlowSnapshot.level + '、各级['
          + initialFlowSnapshot.nodes.map((pair) => pair.join('/')).join('；') + ']、说明“'
          + (initialFlowSnapshot.remark || '空') + '”（收尾按快照恢复）；本轮已应用=2 级用户型 '
          + approverLevel1.userName + '→' + approverLevel2.userName + '，说明标记=' + TABLE_FLOW_MARKER
          + '（重开不回显，人工检索线索）。',
      );
    }

    // 阶段0c（元数据预热）：让平台元数据缓存感知本轮新表（数据地图-表查询可检索）；
    // 尽力而为、如实记录，不阻断——真正验收以阶段1 申请弹窗可打开（表可选）为准。
    let metadataWarmup: string;
    try {
      await openSelfServiceQuery(page);
      await chooseConfiguredDataSource(page, {
        type: permissionResource.sourceTypeName,
        name: querySourceName,
        schema: false,
      });
      await refreshDatabaseMetadata(page);
      metadataWarmup = '自助查询目录已尝试按实时元数据刷新，本轮两张新表进入平台元数据缓存。';
    } catch (metadataError) {
      metadataWarmup = `预热未完成（不阻断）：${metadataError instanceof Error ? metadataError.message.split('，')[0] : String(metadataError)}`;
    }
    await report('SM-02-02 阶段0c｜刷新数据库元数据（管理员）', true, metadataWarmup);

    // ── 阶段1（空权限）：不勾选任何权限类型提交 → 应被表单校验拦截 ──
    const emptyMarker = permissionRunId('e2e_sm0202_empty');
    pendingMarkers.push(emptyMarker);
    await loginAs(page, applicant, { entryUrl: approvalEntryUrl('/dataMap/tableQuery/tablesQuery') });
    {
      const layer = await openApplyDialog(page, TABLE_MAIN);
      await fillApplyReason(layer, emptyMarker);
      await uncheckAllPermissionTypes(layer);
      const evidence = await expectSubmitBlocked(page, layer, emptyMarker);
      markSettled(emptyMarker);
      await report('SM-02-02 阶段1｜空权限提交被拦截', true, evidence + '；标记=' + emptyMarker + '。');
    }

    // ── 阶段2（截止时间非法）：过去日期提交 → 应被拦截 ──
    const expireMarker = permissionRunId('e2e_sm0202_expire');
    pendingMarkers.push(expireMarker);
    await loginAs(page, applicant, { entryUrl: approvalEntryUrl('/dataMap/tableQuery/tablesQuery') });
    {
      const layer = await openApplyDialog(page, TABLE_MAIN);
      await fillApplyReason(layer, expireMarker);
      await ensureUsePermissionChecked(layer);

      // 截止时间控件：可编辑才构造非法值（过去日期优先，其次清空）。
      const expiryInput = layer.locator(
        '.el-date-editor input:visible, .ant-picker input:visible, input[placeholder*="截止"]:visible, input[placeholder*="时间"]:visible',
      ).first();
      if (!(await expiryInput.isVisible().catch(() => false))) {
        skipForMissingEnvironment('申请弹窗未见可编辑的截止时间控件（默认永久只读时“非法期限”无法从页面构造；校准点：确认期限控件形态）。');
      }
      await expiryInput.fill('2020-01-01').catch(async () => { await expiryInput.fill('').catch(() => undefined); });
      await expiryInput.press('Enter').catch(() => undefined);
      const value = ((await expiryInput.inputValue().catch(() => '')) ?? '').trim();
      if (value !== '2020-01-01' && value !== '') {
        skipForMissingEnvironment('截止时间控件不接受直接输入（当前值=' + value + '），“非法期限”无法构造；校准点：确认日期选择器交互方式。');
      }
      const evidence = await expectSubmitBlocked(page, layer, expireMarker);
      markSettled(expireMarker);
      await report('SM-02-02 阶段2｜非法截止时间提交被拦截', true, evidence + '；构造值=' + (value || '（空）') + '，标记=' + expireMarker + '。');
    }

    // ── 阶段3（单表部分字段）：多选字段属合法申请——提交成功落库后立即撤销自清理 ──
    const partialMarker = permissionRunId('e2e_sm0202_part');
    pendingMarkers.push(partialMarker);
    await loginAs(page, applicant, { entryUrl: approvalEntryUrl('/dataMap/tableQuery/tablesQuery') });
    {
      const layer = await openApplyDialog(page, TABLE_MAIN);
      await fillApplyReason(layer, partialMarker);
      const picked = await pickPartialFieldOptions(layer);
      await ensureUsePermissionChecked(layer);
      const sequence = await assignApprovalNodesFromPlan(page, layer);
      await submitAndExpectClosed(page, layer);

      // 落库证据 + 立即撤销自清理：合法申请不留待审批数据。
      await openApprovalWorkbenchAs(page, applicant, '我的申请');
      const row = await findApprovalMarkerRow(page, '未审批', partialMarker);
      if (!row) {
        throw new Error('我的申请-未审批 未出现本申请 ' + partialMarker + '：提交可能未落库或列表结构变化（校准点）。');
      }
      await revokeApplicationAsApplicant(page, applicant, partialMarker);
      markSettled(partialMarker);
      await expectApplicationFinalStatus(page, applicant, partialMarker, /已撤销/, '已撤销');
      // 撤销后：未审批页签不再出现本轮标记（不可再撤销、自清理闭环）。
      if (await findApprovalMarkerRow(page, '未审批', partialMarker)) {
        throw new Error('撤销后 我的申请-未审批 仍存在 ' + partialMarker + '（校准点：撤销后列表流转）。');
      }
      await report(
        'SM-02-02 阶段3｜单表部分字段多选提交并撤销',
        true,
        '字段多选=[' + picked.join('、') + ']；审批序列=' + (sequence.length ? sequence.join('→') : '固定审批人流')
          + '；提交成功且 我的申请-未审批 在列，随后已撤销（终态=已撤销、未审批页签消失）；标记=' + partialMarker + '。',
      );
    }

    // ── 阶段4（多表禁止部分字段）：勾选本轮两张自备表批量申请+部分字段 → 应被拦截 ──
    const multiMarker = permissionRunId('e2e_sm0202_multi');
    pendingMarkers.push(multiMarker);
    await loginAs(page, applicant, { entryUrl: approvalEntryUrl('/dataMap/tableQuery/tablesQuery') });
    {
      // 按本轮共用前缀检索：两张自备卡片同屏可见（仅勾选本轮卡片，绝不触碰其它卡片）。
      const firstCard = await openTableQueryCard(page, RUN_TAG);
      if (!firstCard) {
        skipForMissingEnvironment('按本轮前缀 ' + RUN_TAG + ' 检索未见任何自备表卡片（元数据可能未刷新）；多表场景无法构造（校准点）。');
      }
      const cardScope = page.locator(
        '.table-query .card:visible, .table-query .ant-card:visible, .table-query .el-card:visible',
      );
      const cardMain = await firstVisibleMatching(cardScope.filter({ hasText: TABLE_MAIN }));
      const cardSecond = await firstVisibleMatching(cardScope.filter({ hasText: TABLE_SECOND }));
      if (!cardMain || !cardSecond) {
        skipForMissingEnvironment(
          '按本轮前缀 ' + RUN_TAG + ' 检索未见两张自备表卡片（主表=' + Boolean(cardMain) + '，副表=' + Boolean(cardSecond)
            + '）；“多表+部分字段”无法构造（校准点：元数据刷新/卡片检索）。',
        );
      }
      await checkTableCard(page, cardMain, TABLE_MAIN);
      await checkTableCard(page, cardSecond, TABLE_SECOND);

      // 批量入口：勾选后等待“批量申请”按钮或批量弹窗任一出现；均未出现按前置不足跳过。
      const batchEntry = page.getByRole('button', { name: /批量(申请|授权|权限)/ }).first();
      const entryAppeared = await waitForTrue(page, async () =>
        (await batchEntry.isVisible().catch(() => false)) || (await visibleLayer(page).isVisible().catch(() => false)), 5_000);
      if (!entryAppeared) {
        skipForMissingEnvironment('勾选本轮两张自备表卡片后未见“批量申请”按钮或批量弹窗（校准点：批量申请入口形态）；“多表+部分字段”无法构造。');
      }
      if (await batchEntry.isVisible().catch(() => false)) await batchEntry.click();
      const layer = visibleLayer(page);
      await expect(layer).toBeVisible({ timeout: 10_000 });
      await fillApplyReason(layer, multiMarker);
      const partial = layer.getByText(/部分字段|自选字段/).first();
      if (!(await partial.isVisible().catch(() => false))) {
        skipForMissingEnvironment('批量申请弹窗未提供“部分字段”选择（校准点：确认批量弹窗字段范围控件）；“多表禁止部分字段”无法构造。');
      }
      await partial.click();
      await ensureUsePermissionChecked(layer);
      const evidence = await expectSubmitBlocked(page, layer, multiMarker);
      markSettled(multiMarker);
      await report('SM-02-02 阶段4｜多表+部分字段提交被拦截', true, evidence + '；标记=' + multiMarker + '。');
    }

    // ── 阶段5（无审批流）：申请无可用审批流时提交 → 应被拦截 ──
    const noFlowMarker = permissionRunId('e2e_sm0202_noflow');
    pendingMarkers.push(noFlowMarker);
    await loginAs(page, applicant, { entryUrl: approvalEntryUrl('/dataMap/tableQuery/tablesQuery') });
    {
      const layer = await openApplyDialog(page, TABLE_SECOND);
      await fillApplyReason(layer, noFlowMarker);
      await ensureUsePermissionChecked(layer);

      // 无审批流仅在页面自然呈现时验证；脚本不擅自移除共享审批流配置。
      const flowMissing = layer.getByText(FLOW_MISSING_PATTERN).first();
      if (!(await flowMissing.isVisible().catch(() => false))) {
        skipForMissingEnvironment('本轮已在阶段0b2 自建 2 级用户型“表权限”审批流（阶段3 正向闭环依赖同一配置）；“无审批流”需环境提供未配置审批流的表/类型，脚本不擅自移除审批流配置（DS-PERM-69；校准点）。');
      }
      const evidence = await expectSubmitBlocked(page, layer, noFlowMarker);
      markSettled(noFlowMarker);
      await report('SM-02-02 阶段5｜无审批流提交被拦截', true, evidence + '；标记=' + noFlowMarker + '。');
    }

    await assertNoConsoleErrors(consoleErrors);
    await report(
      'SM-02-02｜表权限申请异常路径（清洁环境）',
      true,
      `表=${TABLE_MAIN}+${TABLE_SECOND}（本轮自建，收尾 DROP）；主体=${applicant.userName}/${approverLevel1.userName}/${approverLevel2.userName}（本轮自备，收尾回收）；`
        + '审批流=本轮自建 2 级用户型（收尾恢复进入时配置）；'
        + '空权限拦截 → 非法期限拦截 → 单表部分字段提交+撤销自清理 → 多表+部分字段拦截 → 无审批流拦截。',
    );

  } catch (error) {
    mainError = error;
    throw error;
  } finally {
    // 收尾回收（仅本轮前缀资产；每步尽力而为、失败仅记录不抛出，不掩盖主结果）。
    const issues: string[] = [];
    // 1) 兜底撤销仍处未审批的本轮申请（如阶段3 撤销前中断），避免悬挂待审批单。
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
        await report('SM-02-02 收尾｜恢复“表权限”审批流进入时配置', true,
          '级数=' + initialFlowSnapshot.level + '，各级=[' + initialFlowSnapshot.nodes.map((pair) => pair.join('/')).join('；')
            + ']；说明按快照尽力回填（产品重开弹窗不回显说明；人工检索标记=' + TABLE_FLOW_MARKER + '）。');
      } catch (restoreError) {
        flowRestoreFailed = true;
        const detail = restoreError instanceof Error ? restoreError.message : String(restoreError);
        issues.push(`“表权限”审批流恢复未闭环：${detail}`);
        await test.info().attach('SM-02-02-审批流恢复证据.txt', {
          body: '恢复进入时配置失败：' + detail + '；快照=' + JSON.stringify(initialFlowSnapshot)
            + '；本轮标记=' + TABLE_FLOW_MARKER + '（请人工按标记检索恢复）。',
          contentType: 'text/plain; charset=utf-8',
        }).catch(() => undefined);
      }
    }
    // 3) DROP 两张本轮专用表（本用例不执行审批同意，不产生授权行；表删除即彻底回收）。
    for (const table of [TABLE_MAIN, TABLE_SECOND]) {
      try {
        await query(`DROP TABLE IF EXISTS ${table}`);
      } catch (dropError) {
        issues.push(`专用表回收未完成（${table}）：${dropError instanceof Error ? dropError.message : String(dropError)}`);
      }
    }
    // 4) 删除本轮自建账号（用户管理页行内删除；角色按先例保留——唯一 UUID 命名）。
    try {
      await loginAs(page, adminIdentity);
      const outcomes: string[] = [];
      for (const identity of [applicant, approverLevel1, approverLevel2]) {
        outcomes.push(`${identity.userName}：${await deleteOwnUser(page, identity)}`);
      }
      await report('SM-02-02 收尾｜回收本轮账号', true, outcomes.join('；') + '。');
    } catch (userError) {
      issues.push(`本轮账号回收未完成：${userError instanceof Error ? userError.message.split('，')[0] : String(userError)}`);
    }
    for (const issue of issues) console.warn(`[SM-02-02 收尾] ${issue}`);
    // DS-PERM-69：共享“表权限”审批流恢复失败属共享态漂移——通过路径必须显式失败；
    // 主路径已失败/跳过时保留原始结果，仅以告警与附件暴露（不掩盖）。
    if (!mainError && flowRestoreFailed) {
      throw new Error('“表权限”审批流恢复未闭环（共享态漂移；详见附件 SM-02-02-审批流恢复证据.txt）。');
    }
  }
});
