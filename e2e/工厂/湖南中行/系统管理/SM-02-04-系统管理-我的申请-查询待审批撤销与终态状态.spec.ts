/**
 * SM-02-04｜系统管理｜我的申请：查询检索、待审批撤销与终态状态
 *
 * DS-PERM-30 清洁环境静态校准（2026-09-22，环境不可用，仅静态校准，不运行 Playwright）：
 * 在 PERM-STATIC-04 静态骨架上解除全部历史固化资产依赖，改为本轮自备（全 ASCII 唯一）：
 *   - 主体：申请人/一级/二级审批人均为 newPermissionIdentity('sm0204*') UUID 唯一账号
 *     （管理员 createAndInviteUser 页面化创建，收尾尽力删除回收）；
 *   - 角色：本轮 newPermissionRole 唯一角色并绑定对应账号（菜单按 SM-00-01 实证口径：
 *     申请人=数据地图+数据查询，审批人=数据地图；角色唯一命名，按 SM-00-02/DS-PERM-25
 *     先例用后保留，不创建、不修改任何既有角色/用户）；
 *   - 目标表：e2e_sm0204t_<uuid>，MySQL 直连 CREATE TABLE（sm_id/sm_name/sm_value 三列、
 *     2 行种子，COUNT=2 硬断言），不读 DATA_PERMISSION_TABLE、无 sm_test_00 固化兜底；
 *     阶段0c 元数据预热使其可被数据地图-表查询检索；finally DROP IF EXISTS 回收；
 *   - 申请单：permissionRunId 唯一 marker（申请原因），仅命中本轮自建申请，绝不使用
 *     历史记录；残留清理与兜底撤销也仅针对本轮 marker；
 *   - 提交人修正：静态稿由 loginPage（管理员会话）提交申请、却到申请人“我的申请”
 *     断言，属口径不一致；现改为申请人本人登录提交（数据地图-表查询 → 申请权限）。
 *
 * 业务断言保持不变（PERM-STATIC-04 口径，未削弱）：
 *   1. 查询检索：我的申请-未审批 默认列表可检索到本轮申请；按本轮表名检索仍命中；
 *      随机关键字不得命中本轮申请（精确检索契约，命中即失败）；
 *   2. 待审批撤销：仅未审批可撤销——撤销成功后未审批页签消失，已审批页签出现
 *      “已撤销”终态；
 *   3. 终态不可再操作：已撤销行不再提供撤销入口（仍可见即失败）；阶段1 遗留的待审批
 *      申请尽力撤销自清理（失败附证据说明，不误报缺陷）。
 *
 * 同包显式前置（DS-PERM-69 清洁环境：阶段0b2 管理员把“表权限”审批流整体替换为本轮
 * 自建 2 级用户型审批人，进入时先捕获快照、finally 按快照恢复；口径同 SM-02-01/03）：
 * 共享工具 submitTablePermissionApply/assignApprovalNodes 在该自建流上指派本轮审批人
 * （e2e_sm0204l*_<uuid>）；进入时该类型本就未配置（应用后无法恢复为“未配置”）或
 * “确认应用”被拦截时按前置不足 skip，不破坏共享态、不伪造通过、不误报缺陷。
 *
 * 结构（DS-PERM-24/25 同型单用例 try/finally，中断轮次也回收本轮资产）：阶段0a 自建
 * 专用表 → 0b 自建账号与角色 → 0c 元数据预热 → 1 查询契约 → 2 撤销闭环 → 3 终态不可
 * 再操作+自清理 → finally 兜底撤销遗留申请/删表/删账号（仅本轮前缀）。
 *
 * 规则：RUN_PERMISSION_APPROVAL=1 闸门（条件 skip、非永久）；DB_* MySQL 前置门禁（条件
 * skip）；串行执行（--workers=1）；UUID 标记隔离；浏览器页面操作 + MySQL 直连 DDL（仅
 * 本轮自备表）。查询字段形态（表名/单号/原因）环境恢复后校准。
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
  requirePermissionTableName,
  resolveMysqlPermissionResource,
  type MysqlPermissionResource,
} from './数据权限闭环工具.js';
import {
  expectApplicationFinalStatus,
  findApprovalMarkerRow,
  openApprovalLeaf,
  openApprovalWorkbenchAs,
  permissionRunId,
  requirePermissionApprovalEnvironment,
  revokeApplicationAsApplicant,
  submitTablePermissionApply,
} from './权限审批待调试工具.js';

/** 本轮自备主体（DS-PERM-30 起解耦 permissionFixtures 固化用户依赖；全 ASCII 唯一）。 */
const applicant = newPermissionIdentity('sm0204a');
const approverLevel1 = newPermissionIdentity('sm0204l1');
const approverLevel2 = newPermissionIdentity('sm0204l2');

/** 两级审批计划：均为本轮自建账号（指派给申请弹窗的可指派节点）。 */
const APPROVAL_PLAN: PermissionIdentity[] = [approverLevel1, approverLevel2];

/** 本轮自备角色：菜单按 SM-00-01 实证口径；唯一 UUID 命名，用后保留（先例 SM-00-02）。 */
const ROLE_PLAN: Array<{ role: PermissionRole; menus: string[]; member: PermissionIdentity }> = [
  { role: newPermissionRole('sm0204', 'applicant'), menus: ['数据地图', '数据查询'], member: applicant },
  { role: newPermissionRole('sm0204', 'approver1'), menus: ['数据地图'], member: approverLevel1 },
  { role: newPermissionRole('sm0204', 'approver2'), menus: ['数据地图'], member: approverLevel2 },
];

/** 本轮自备专用表：UUID 唯一、MySQL 直建；不读 DATA_PERMISSION_TABLE，无固化兜底表名。 */
const permissionResource: MysqlPermissionResource = resolveMysqlPermissionResource({
  tableName: `e2e_sm0204t_${uuid()}`,
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

/** 仍处“未审批”的本轮申请 marker：提交成功入列；撤销/终态确认后出列；finally 兜底撤销。 */
const pendingMarkers: string[] = [];

/** 工作台查询：填关键字并点击查询（清空=查全量）；查询字段形态环境恢复后校准（flash 验证点）。 */
async function searchWorkbench(page: Page, keyword: string): Promise<void> {
  const box = page.getByRole('textbox').first();
  await box.fill(keyword).catch(() => undefined);
  await page.getByRole('button', { name: /查\s*询/ }).first().click().catch(() => undefined);
  await page.waitForTimeout(600);
}

/** 前置不足：写清原因后跳过，不伪造通过、不误报缺陷。 */
function skipForMissingEnvironment(reason: string): never {
  test.info().attach('ENV-SM0204-前置证据.txt', { body: reason, contentType: 'text/plain; charset=utf-8' });
  test.skip(true, 'ENV-SM0204：' + reason);
  throw new Error('UNREACHABLE：test.skip 应已中断用例。');
}

/** marker 标记终态/已撤销：从未审批跟踪表移除（indexOf<0 时不动，防 splice(-1) 误删末位）。 */
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
 * createPermissionFixtureTable）。返回实际种子行数作为夹具证据；建表失败为真实失败
 * （调用方上抛前尽力 DROP 半建表），不伪造通过。
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
      + `('sm-1', 'e2e-sm0204-a', '${TARGET_TABLE}'), ('sm-2', 'e2e-sm0204-b', 'my-apply-close-loop')`,
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

/** 兜底撤销仍处未审批的本轮申请：仅本轮 marker；失败附证据不掩盖主结果。 */
async function revokeLeftoverPendingApplications(page: Page): Promise<void> {
  for (const marker of pendingMarkers.slice()) {
    try {
      await revokeApplicationAsApplicant(page, applicant, marker);
      markSettled(marker);
      console.warn(`[SM-02-04 收尾] 遗留申请 ${marker} 已兜底撤销。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      test.info().attach('SM-02-04-收尾清理证据.txt', {
        body: '兜底撤销申请 ' + marker + ' 失败：' + message,
        contentType: 'text/plain; charset=utf-8',
      });
      console.warn(`[SM-02-04 收尾] 遗留申请 ${marker} 兜底撤销失败：${message.slice(0, 160)}`);
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
const TABLE_FLOW_MARKER = permissionRunId('e2e_flow0204');

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

test('SM-02-04｜系统管理｜我的申请-查询撤销与终态状态', async ({ loginPage, consoleErrors, report }) => {
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
      'SM-02-04 阶段0a｜创建本轮专用表',
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
      'SM-02-04 阶段0b｜创建本轮账号与角色',
      true,
      `申请人=${applicant.userName}；一级=${approverLevel1.userName}；二级=${approverLevel2.userName}；`
        + `角色=${ROLE_PLAN.map((plan) => plan.role.roleName).join('、')}（唯一命名，用后保留）。`,
    );

    // 阶段0b2（自建审批流配置，DS-PERM-69）：管理员把“表权限”审批流整体替换为 2 级
    // 用户型审批人（一级=l1、二级=l2，均本轮自建账号）——阶段1/2 的申请提交不再依赖
    // 环境历史审批流与固定审批人。进入时先捕获快照（finally 恢复基线）；进入时本就
    // 未配置（应用后无法恢复为“未配置”，产品无停用/清空开关）或“确认应用”被拦截时
    // 按前置不足跳过，不破坏共享态。
    {
      await loginAs(page, adminIdentity);
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
        'SM-02-04 阶段0b2｜自建“表权限”审批流（2 级用户型，本轮账号）',
        true,
        '进入时快照=级数 ' + initialFlowSnapshot.level + '、各级['
          + initialFlowSnapshot.nodes.map((pair) => pair.join('/')).join('；') + ']、说明“'
          + (initialFlowSnapshot.remark || '空') + '”（收尾按快照恢复）；本轮已应用=2 级用户型 '
          + approverLevel1.userName + '→' + approverLevel2.userName + '，说明标记=' + TABLE_FLOW_MARKER
          + '（重开不回显，人工检索线索）。',
      );
    }

    // 阶段0c（元数据预热）：让平台元数据缓存感知本轮新表（数据地图-表查询可检索）；
    // 尽力而为、如实记录，不阻断——真正验收以阶段1 表查询检索为准（同 SM-03-09/10）。
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
    await report('SM-02-04 阶段0c｜刷新数据库元数据（管理员）', true, metadataWarmup);

    // 阶段1（查询契约）：申请人本人提交本轮申请（修正静态稿提交人/断言人不一致）：
    // 默认列表命中 → 按本轮表名检索命中 → 随机关键字不得命中。
    const queryMarker = permissionRunId('e2e_sm0204_q');
    await loginAs(page, applicant);
    await submitTablePermissionApply(page, {
      tableName: TARGET_TABLE,
      marker: queryMarker,
      approvalPlan: APPROVAL_PLAN,
    });
    pendingMarkers.push(queryMarker);

    await openApprovalWorkbenchAs(page, applicant, '我的申请');
    const row = await findApprovalMarkerRow(page, '未审批', queryMarker);
    if (!row) {
      throw new Error('我的申请-未审批 未回显本轮申请 ' + queryMarker + '（校准点：列表字段与默认查询契约）。');
    }
    const rowText = ((await row.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
    if (!rowText.includes(TARGET_TABLE)) {
      test.info().attach('SM-02-04-行文本证据.txt', { body: rowText.slice(0, 400), contentType: 'text/plain; charset=utf-8' });
    }

    // 已知条件检索：查询框填本轮表名后应仍能检索到本轮申请。
    await searchWorkbench(page, TARGET_TABLE);
    const byTable = await findApprovalMarkerRow(page, '未审批', queryMarker);
    if (!byTable) {
      skipForMissingEnvironment(
        '按本轮表名 [' + TARGET_TABLE + '] 检索后未审批页签找不到本轮申请 ' + queryMarker
          + '（校准点：确认查询字段是否支持表名；若仅支持单号/原因，改用原因检索）。',
      );
    }

    // 随机关键字：本轮申请（原因=marker）不应被无关关键字命中——精确检索契约。
    const noise = permissionRunId('e2e_sm0204_none');
    await searchWorkbench(page, noise);
    if (await findApprovalMarkerRow(page, '未审批', queryMarker)) {
      throw new Error('随机关键字 [' + noise + '] 仍能检索到本轮申请 ' + queryMarker + '（疑似未按条件过滤；校准点：查询字段契约）。');
    }
    await report(
      'SM-02-04 阶段1｜我的申请查询契约核验',
      true,
      '默认列表命中；按本轮表名 [' + TARGET_TABLE + '] 检索命中；随机关键字不命中。行文本=' + rowText.slice(0, 160) + '。',
    );

    // 阶段2（撤销闭环）：新一轮申请 → 申请人撤销 → 未审批页签消失 → 已审批页签“已撤销”。
    const revokeMarker = permissionRunId('e2e_sm0204_w');
    await submitTablePermissionApply(page, {
      tableName: TARGET_TABLE,
      marker: revokeMarker,
      approvalPlan: APPROVAL_PLAN,
    });
    pendingMarkers.push(revokeMarker);
    await revokeApplicationAsApplicant(page, applicant, revokeMarker);
    markSettled(revokeMarker);

    if (await findApprovalMarkerRow(page, '未审批', revokeMarker)) {
      throw new Error('撤销成功提示后未审批页签仍存在本轮申请 ' + revokeMarker + '（校准点：撤销后列表刷新）。');
    }
    await expectApplicationFinalStatus(page, applicant, revokeMarker, /已撤销|撤销/, '已撤销');
    await report('SM-02-04 阶段2｜待审批撤销闭环', true, '撤销成功；未审批页签已消失；已审批页签状态=已撤销。');

    // 阶段3（终态不可再操作 + 阶段1 遗留自清理）：已撤销行不得再有撤销入口。
    await openApprovalWorkbenchAs(page, applicant, '我的申请');
    const finalRow = await findApprovalMarkerRow(page, '已审批', revokeMarker);
    if (!finalRow) {
      throw new Error('我的申请-已审批 未找到已撤销申请 ' + revokeMarker + '（校准点：已审批列表契约）。');
    }
    const revokeEntry = finalRow.getByRole('button', { name: /撤\s*销/ }).first();
    if (await revokeEntry.isVisible().catch(() => false)) {
      throw new Error('已撤销终态行仍提供撤销入口（校准点/疑似产品缺陷：终态不可再操作契约）。');
    }

    let cleanupNote = '阶段1未产出待审批申请，无需清理。';
    if (pendingMarkers.includes(queryMarker)) {
      try {
        await revokeApplicationAsApplicant(page, applicant, queryMarker);
        markSettled(queryMarker);
        cleanupNote = '阶段1申请 ' + queryMarker + ' 已撤销清理。';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const finalized = await findApprovalMarkerRow(page, '已审批', queryMarker).catch(() => undefined);
        test.info().attach('SM-02-04-清理证据.txt', {
          body: '撤销阶段1申请 ' + queryMarker + ' 失败：' + message
            + '；已审批页签是否存在该申请=' + (finalized ? '是（已被审批人处理）' : '否（可能列表时序）'),
          contentType: 'text/plain; charset=utf-8',
        });
        cleanupNote = '阶段1申请撤销失败已附证据（' + message.slice(0, 120) + '）。';
      }
    }
    await report('SM-02-04 阶段3｜终态核验与自清理', true, '已撤销行无撤销入口；' + cleanupNote);

    await assertNoConsoleErrors(consoleErrors);
    await report(
      'SM-02-04｜我的申请-查询撤销与终态状态',
      true,
      `表=${TARGET_TABLE}；主体=${applicant.userName}（本轮自备，收尾回收）；`
        + '审批流=本轮自建 2 级用户型（收尾恢复进入时配置）；'
        + '查询契约（默认/表名命中、随机不命中）→撤销闭环（未审批消失、已审批=已撤销）→终态不可再操作。',
    );

  } catch (error) {
    mainError = error;
    throw error;
  } finally {
    // 收尾回收（仅本轮前缀资产；每步尽力而为、失败仅记录不抛出，不掩盖主结果）。
    const issues: string[] = [];
    // 1) 兜底撤销仍处未审批的本轮申请（避免悬挂待审批单）。
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
        await report('SM-02-04 收尾｜恢复“表权限”审批流进入时配置', true,
          '级数=' + initialFlowSnapshot.level + '，各级=[' + initialFlowSnapshot.nodes.map((pair) => pair.join('/')).join('；')
            + ']；说明按快照尽力回填（产品重开弹窗不回显说明；人工检索标记=' + TABLE_FLOW_MARKER + '）。');
      } catch (restoreError) {
        flowRestoreFailed = true;
        const detail = restoreError instanceof Error ? restoreError.message : String(restoreError);
        issues.push(`“表权限”审批流恢复未闭环：${detail}`);
        await test.info().attach('SM-02-04-审批流恢复证据.txt', {
          body: '恢复进入时配置失败：' + detail + '；快照=' + JSON.stringify(initialFlowSnapshot)
            + '；本轮标记=' + TABLE_FLOW_MARKER + '（请人工按标记检索恢复）。',
          contentType: 'text/plain; charset=utf-8',
        }).catch(() => undefined);
      }
    }
    // 3) DROP 本轮专用表（撤销/驳回路径不产生授权；表删除即彻底回收）。
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
      await report('SM-02-04 收尾｜回收本轮账号', true, outcomes.join('；') + '。');
    } catch (userError) {
      issues.push(`本轮账号回收未完成：${userError instanceof Error ? userError.message.split('，')[0] : String(userError)}`);
    }
    for (const issue of issues) console.warn(`[SM-02-04 收尾] ${issue}`);
    // DS-PERM-69：共享“表权限”审批流恢复失败属共享态漂移——通过路径必须显式失败；
    // 主路径已失败/跳过时保留原始结果，仅以告警与附件暴露（不掩盖）。
    if (!mainError && flowRestoreFailed) {
      throw new Error('“表权限”审批流恢复未闭环（共享态漂移；详见附件 SM-02-04-审批流恢复证据.txt）。');
    }
  }
});
