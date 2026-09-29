/**
 * SM-02-08｜系统管理｜申请部分字段经审批后自动授权与实际访问
 *
 * DS-PERM-109 静态开发（2026-09-23，环境不可用，仅静态开发与类型检查，不运行
 * Playwright/浏览器/数据库；DI-01 已有串行报告、DB DROP 报 ECONNRESET，静态阶段
 * 不把 --list 说成通过）：DS-PERM-99 静态审计确认 SM-02-06 只覆盖“申请全部字段
 * → 审批通过后管理员把授权收窄为部分字段”，**未覆盖申请人直接在申请单选择
 * “部分字段”→ 逐级审批通过 → 系统按申请范围自动授权并实际生效**。本用例补齐
 * 该缺口，独立成篇，不改写 SM-02-06 的默认全部字段覆盖。
 *
 * 业务链（口径对齐 SM-02-06，差异点以【差异】标注）：
 *   1. 归因前置：申请人（本轮自备账号）当前不持有本轮专用表的任何授权；
 *   2.【差异】申请人提交“单表 + 使用 + 部分字段”申请：本地复刻
 *      submitTablePermissionApply 全流程并在申请弹窗内显式切换“部分字段”、
 *      只勾选授予字段 sm_id、显式不勾排除字段 sm_value，提交前回读复核；
 *      审批节点指派复用 assignApprovalNodes 语义（本地复刻，共享工具未导出）；
 *   3. 逐级同意至最终节点，申请终态=已通过；
 *   4.【差异】审批完成生成的授权恰为申请字段范围：用户视角与资源视角出现同一
 *      条“使用”授权且主体=申请人（审批人不得被误授权）；行级回显“部分字段”
 *      + 重开编辑弹窗回显双重校验“含 sm_id、不含 sm_value”；
 *   5. 共享数据权限开关隔离：先记录原始值（finally 必须恢复原值，恢复失败使
 *      测试失败），再开启（§11.1-1：开启后才按数据源、表及字段范围校验）；
 *   6. 申请人重登：数据地图表查询卡片可见、表详情（基础信息+字段区）可达；
 *   7. 实际字段访问（自助查询真实只读 SQL）：授予字段 sm_id 的查询必须成功；
 *   8.【差异】排除字段 sm_value 严格判定：必须得到“没有…权限/权限不足”类
 *      明确权限拒绝才算通过；查询成功或长时间无结果无拦截均按真实失败报出
 *      （DS-PERM-109 边界：不能用任意 SQL 错误或空结果冒充拒绝；静态阶段
 *      无法确定产品业务规则时保留严格判定，待页面校准在结果文档写明）。
 *
 * 本轮最小唯一英文 UUID 自备资产（无任何历史固定用户/表/角色/申请/权限）：
 *   - 主体：申请人/一级/二级审批人均为 newPermissionIdentity('sm0208*') 唯一
 *     账号（createAndInviteUser 页面化创建，收尾尽力删除回收）；
 *   - 角色：newPermissionRole('sm0208', …) 唯一角色并绑定（菜单按 SM-00-01
 *     实证口径：申请人=数据地图+数据查询，审批人=数据地图；用后保留）；
 *   - 目标表：e2e_sm0208t_<uuid>，MySQL 直连 CREATE TABLE（sm_id/sm_name/
 *     sm_value 三列、2 行 ASCII 种子，COUNT=2 硬断言）；默认数据源由配置
 *     中心读取（resolveMysqlPermissionResource + QUERY_SOURCE_NAME 可覆写
 *     展示基础名），主机/端口/显示名/凭据不写死；finally DROP IF EXISTS；
 *   - 申请单：permissionRunId('e2e_sm0208') 唯一 marker（申请原因），兜底撤销
 *     仅命中本轮 marker。
 *
 * 同包显式前置（审批流为环境共享配置，本用例不自建、不修改）：本地复刻的
 * assignApprovalNodes 要求“表权限”审批流暴露 ≥2 个可指派节点且本轮审批人
 * （sm0208*）在其候选名单中；节点为固定非计划用户或候选缺失时，按前置不足
 * skip 并附候选名单证据，不伪造通过、不误报缺陷。
 *
 * 申请弹窗字段范围控件形态未实测：按 SM-03-10/SM-02-06 阶段8 已固化口径
 * “标签+行为”定位（部分字段文本 → combobox 增量/复选组/穿梭框三形态兼容
 * detectFieldSelectionControl），证据不足时显式 TODO[env] 失败，不虚构页面
 * 结构、不永久 skip、不删除断言。
 *
 * 副作用与回收（清洁环境，仅本轮前缀资产；DS-PERM-109 边界：清理失败须留证
 * 并影响结果，不吞错）：finally 依次——兜底撤销仍处未审批的本轮申请 → 资源
 * 视角回收“本轮主体×本轮专用表”授权行 → DROP 本轮表 → 尽力删除本轮自建
 * 账号 → 恢复数据权限开关原始值（共享配置，恢复失败显式暴露）；任一资产
 * 回收失败时以附件留证，主流程无失败则以收尾失败定性用例失败。
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
  type MysqlPermissionResource,
  closePermissionDialog,
  deletePermissionFromRow,
  dismissPermissionDropdown,
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
} from './数据权限闭环工具.js';
import {
  expectApplicationFinalStatus,
  findApprovalMarkerRow,
  handlePendingApproval,
  openApprovalWorkbenchAs,
  openTableQueryCard,
  permissionRunId,
  requireAdminIdentity,
  requirePermissionApprovalEnvironment,
  revokeApplicationAsApplicant,
  skipForMissingEnvironment,
} from './权限审批待调试工具.js';

test.describe.configure({ mode: 'serial', timeout: 240_000 });

/** 本轮自备主体（全 ASCII 唯一）：申请人 + 一级/二级审批人。 */
const applicant = newPermissionIdentity('sm0208a');
const approverLevel1 = newPermissionIdentity('sm0208l1');
const approverLevel2 = newPermissionIdentity('sm0208l2');

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
  { role: newPermissionRole('sm0208', 'applicant'), menus: ['数据地图', '数据查询'], member: applicant },
  { role: newPermissionRole('sm0208', 'approver1'), menus: ['数据地图'], member: approverLevel1 },
  { role: newPermissionRole('sm0208', 'approver2'), menus: ['数据地图'], member: approverLevel2 },
];

/** 本轮自备专用表：UUID 唯一、MySQL 直建；不读 DATA_PERMISSION_TABLE，无固化兜底表名。 */
const permissionResource: MysqlPermissionResource = resolveMysqlPermissionResource({
  tableName: `e2e_sm0208t_${uuid()}`,
});
const TARGET_TABLE = requirePermissionTableName(permissionResource);

/** 字段范围标记（均为本轮专用表内真实列）：授予 sm_id、排除 sm_value。 */
const ALLOWED_FIELD = 'sm_id';
const DENIED_FIELD = 'sm_value';

/** 自助查询数据源弹窗展示基础名（QUERY_SOURCE_NAME 可覆写；同 SM-03-09 口径）。 */
const querySourceName = (process.env.QUERY_SOURCE_NAME?.trim() || permissionResource.sourceName)
  .split(/[:：]/)[0].trim();

/** 仍处“未审批”的本轮申请 marker：提交成功入列；终态确认后出列；finally 兜底撤销。 */
const pendingMarkers: string[] = [];

/** marker 标记终态：从未审批跟踪表移除（indexOf<0 时不动，防 splice(-1) 误删末位）。 */
function markSettled(marker: string): void {
  const index = pendingMarkers.indexOf(marker);
  if (index >= 0) pendingMarkers.splice(index, 1);
}

/** 返回 locator 中第一个可见元素（与共享工具 firstVisibleMatching 语义一致，本文件自持）。 */
async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

/**
 * 以下审批节点指派 helpers 为权限审批待调试工具.ts 同名实现的本地复刻（共享
 * 工具未导出，且本用例需在“使用”勾选与节点指派之间插入字段范围选择，无法
 * 复用整段 submitTablePermissionApply；口径与 SM-02-01/03/05/06 一致）。
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

/** 成功提示（Ant/Element 双兼容 + 通用 alert/toast/message）。 */
function successNotice(page: Page, pattern: string | RegExp) {
  return page.locator(
    '.ant-message-notice-content:visible, .ant-notification-notice-message:visible, .el-message:visible, '
      + '[role="alert"]:visible, [class*="toast"]:visible, [class*="message"]:visible',
  ).filter({ hasText: pattern }).last();
}

/** 可见弹层（Ant/Element 双兼容）：申请权限与审批/撤销确认共用。 */
function visibleLayer(page: Page): Locator {
  return page.locator(
    '[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible, .ant-drawer:visible, .el-drawer:visible',
  ).last();
}

/** 下拉选项渲染在页面级（teleport），Ant/Element 双兼容（口径同 SM-02-01）。 */
const APPROVAL_OPTION_SELECTOR = [
  '.ant-select-dropdown:visible .ant-select-item-option',
  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
  '.el-select-dropdown:visible .el-select-dropdown__item',
  '[role="listbox"]:visible [role="option"]',
  'li[role="option"]:visible',
].join(', ');

/** 弹窗审批节点：固定用户=审批流配置确定（禁用文本框回显）；待指派=“请选择(用户|审批人)”下拉。 */
type ApprovalNode =
  | { kind: '固定用户'; level: number; displayName: string; rowText: string; y: number }
  | { kind: '待指派'; level: number; displayName: string; rowText: string; y: number; box: Locator };

/** 节点序号：第一→1 … 第十→10；解析失败返回大数保证排序兜底。 */
function approvalLevelOf(text: string): number {
  const map: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  const match = text.match(/第([一二三四五六七八九十])审批人/);
  return match ? (map[match[1]] ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
}

/**
 * 解析申请弹窗的审批节点指派区，按页面纵向顺序返回。
 * 禁用输入框只认“第N审批人”行，避免把日期等其它禁用控件误判为审批节点。
 */
async function collectApprovalNodes(layer: Locator): Promise<ApprovalNode[]> {
  const nodes: ApprovalNode[] = [];
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

/** 计划审批人（登录用户名/展示昵称）→ 登录用户名：固定节点回显名与账号双向兼容。 */
function approvalAliasesOf(plan: PermissionIdentity[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const identity of plan) {
    map.set(identity.userName, identity.userName);
    if (identity.nickname) map.set(identity.nickname, identity.userName);
  }
  return map;
}

/** 只读探查待指派节点的候选审批人名单：只打开下拉收集文本，不选中、不改动环境。 */
async function peekAssignCandidates(page: Page, box: Locator): Promise<string[]> {
  if (!(await box.isVisible().catch(() => false))) return [];
  await box.click();
  await waitForTrue(page, async () => (await page.locator(APPROVAL_OPTION_SELECTOR).count()) > 0, 4_000);
  const texts = (await page.locator(APPROVAL_OPTION_SELECTOR).allInnerTexts().catch(() => [] as string[]))
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  await dismissPermissionDropdown(page);
  return texts;
}

/** 待指派节点选中计划审批人后，节点应回显该用户名或其昵称（候选展示形态因版本而异）。 */
async function expectNodeShows(
  page: Page,
  node: Extract<ApprovalNode, { kind: '待指派' }>,
  aliases: string[],
): Promise<void> {
  const displayPattern = new RegExp('(' + aliases.map(escapeRegExp).join('|') + ')');
  await expect.poll(async () => {
    const input = node.box.locator('input').first();
    return (await input.inputValue().catch(() => '')) + ' ' + (await node.box.innerText().catch(() => ''));
  }, { timeout: 5_000 }).toMatch(displayPattern);
}

/**
 * 解析并指派申请弹窗的审批节点，返回实际审批序列（登录用户名，按节点顺序）。
 * 用户型固定节点若属计划账号则计入序列，否则闭环无法承接——只读探查角色型节点
 * 候选名单作为精确前置证据，按环境前置不足 skip（不提交、不留悬挂申请）。
 */
async function assignApprovalNodes(page: Page, layer: Locator, plan: PermissionIdentity[]): Promise<string[]> {
  const aliasToUser = approvalAliasesOf(plan);
  const nodes = await collectApprovalNodes(layer);
  const sequence: string[] = [];
  const candidateReport: string[] = [];
  let blockedBy: string | undefined;

  for (const node of nodes) {
    if (node.kind === '固定用户') {
      const mapped = aliasToUser.get(node.displayName);
      if (mapped) sequence.push(mapped);
      else if (blockedBy === undefined) blockedBy = node.displayName + '（' + node.rowText + '）';
      continue;
    }
    if (blockedBy !== undefined) {
      const candidates = await peekAssignCandidates(page, node.box);
      candidateReport.push('候选=[' + candidates.join('、') + ']');
      continue;
    }
    if (sequence.length >= plan.length) continue;
    const identity = plan[sequence.length];
    const aliases = [identity.userName, identity.nickname]
      .filter((item, index, all) => Boolean(item) && all.indexOf(item) === index);
    await node.box.click();
    await waitForTrue(page, async () => (await page.locator(APPROVAL_OPTION_SELECTOR).count()) > 0, 4_000);
    const aliasPattern = new RegExp(aliases.map(escapeRegExp).join('|'));
    // 候选接口返回后选项 DOM 才逐步挂载：6 秒窗口内轮询可见匹配，耗尽仍无才定性失败。
    let option: Locator | undefined;
    const optionDeadline = Date.now() + 6_000;
    while (!(option = await firstVisible(
      page.locator(APPROVAL_OPTION_SELECTOR).filter({ hasText: aliasPattern }),
    ))) {
      if (Date.now() > optionDeadline) break;
      await page.waitForTimeout(300);
    }
    if (!option) {
      const candidates = (await page.locator(APPROVAL_OPTION_SELECTOR).allInnerTexts().catch(() => [] as string[]))
        .map((item) => item.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      await dismissPermissionDropdown(page);
      throw new Error(
        '审批节点候选列表中未找到计划审批人 ' + identity.userName + '；实测候选=[' + candidates.join('、')
          + ']（flash 验证点：确认该用户是当前节点配置角色的成员，或调整环境审批流配置）。',
      );
    }
    await option.click();
    await expectNodeShows(page, node, aliases);
    sequence.push(identity.userName);
  }

  if (blockedBy !== undefined) {
    skipForMissingEnvironment(
      '审批流最早的节点固定为非计划审批人 ' + blockedBy + '：申请会停在该固定用户的“我的审批”，'
        + '计划账号无法承接该节点，闭环在本环境无法完成。角色型节点候选只读探查：'
        + (candidateReport.join('；') || '无待指派节点')
        + '。需环境将表权限审批流配置为计划账号/其角色成员，或提供固定审批人账号后回归。',
    );
  }
  await dismissPermissionDropdown(page);
  return sequence;
}

/**
 * 自助查询入口（管理员会话与受限申请人会话共用）。同 SM-03-03/09/10 家族：先真实
 * 侧边栏，再 hash 直达；受限账号可能连菜单都被裁剪，hash 兜底是关键路径。
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
 * SM-02-05/06/SM-03-06 createPermissionFixtureTable）。建表失败为真实失败（调用方
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
      + `('sm-1', 'e2e-sm0208-a', '${TARGET_TABLE}'), ('sm-2', 'e2e-sm0208-b', 'sm0208-apply-partial-field')`,
  );
  const rows = await query(`SELECT COUNT(*) AS total FROM ${TARGET_TABLE}`);
  const total = Number((rows[0] as { total?: unknown } | undefined)?.total ?? -1);
  expect(total, `专用表 ${TARGET_TABLE} 种子数据应为 2 行，实际：${JSON.stringify(rows)}`).toBe(2);
  return 2;
}

/**
 * 尽力删除本轮自建账号（用户管理页：按本轮唯一账号查询 → 行内“删除”→ 确认；
 * 模板 SM-02-05/SM-03-09 deleteOwnUser）。只回收本轮自备账号；任一步不满足都
 * 返回说明文本而不抛错（是否定性失败由 finally 的收尾契约决定）。
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
      console.warn(`[SM-02-08 收尾] 遗留申请 ${marker} 已兜底撤销。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      test.info().attach('SM-02-08-收尾清理证据.txt', {
        body: '兜底撤销申请 ' + marker + ' 失败：' + message,
        contentType: 'text/plain; charset=utf-8',
      });
      console.warn(`[SM-02-08 收尾] 遗留申请 ${marker} 兜底撤销失败：${message.slice(0, 160)}`);
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
 * （本地复刻自 SM-03-03/10：e2e/utils.ts 未导出该变体；相比 assertNoConsoleErrors
 * 仅放行显式列出的预期失败模式，其余仍判失败）。
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
async function expectRowExactPermissionType(row: Locator, expected: '使用' | '管理'): Promise<void> {
  const raw = await row.innerText({ timeout: 5_000 }).catch(() => '');
  const normalized = raw.replace(/\s+/g, '');
  const other: '使用' | '管理' = expected === '使用' ? '管理' : '使用';
  expect(normalized, `权限行应包含权限类型“${expected}”，实际行文本：${raw}`).toContain(expected);
  expect(
    normalized,
    `权限行不应残留权限类型“${other}”（编辑/新增应为整体覆盖，实际行文本：${raw}）`,
  ).not.toContain(other);
}

/** 字段范围选项文本：部分字段（申请单与授权行/编辑弹窗共用同一口径）。 */
const FIELD_SCOPE_PARTIAL = /部\s*分\s*字\s*段/;
/** 字段范围选项文本：全部字段（申请“部分字段”后任何回显不得再出现）。 */
const FIELD_SCOPE_ALL = /全\s*部\s*字\s*段/;
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
    throw new Error(`弹窗未找到“${label}”选项/控件（需按实际页面校准控件形态），当前页面：${scope.page().url()}`);
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
 * 在字段选择控件中选中指定名称的字段（区别于“任选 count 个”：申请范围必须精确
 * 只含授予字段）。下拉形态：展开后按名称匹配选项点击；复选形态：按 label 文本
 * 匹配勾选。未找到候选返回 false，由调用方按校准点失败。形态判定同 SM-03-10
 * chooseFieldsFromControl / SM-02-06 selectFieldByName。
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

/** 声明的预期失败信号：字段级拦截分支允许后端以 4xx/5xx 拒绝（SM-03-10/02-06 口径）。 */
const EXPECTED_QUERY_FAILURE_PATTERNS: RegExp[] = [
  /Failed to load resource/i,
  /\b(?:40[0139]|500|502|503)\b/,
];

/**
 * 申请人发起“单表 + 使用 + 部分字段”表权限申请（数据地图-表查询 → 申请权限弹窗）。
 * 复刻共享 submitTablePermissionApply 全流程（口径同 SM-02-01/06），并在“使用”
 * 勾选之后、审批节点指派之前插入 DS-PERM-109 关键差异：显式切换“部分字段”→
 * 只勾选授予字段、显式不勾排除字段 → 提交前回读复核（含授予、不含排除）。
 * 申请弹窗若无“部分字段”选项或字段多选控件，按 TODO[env] 真实失败，不默认
 * “全部字段”提交、不虚构页面结构。返回实际审批序列（登录用户名）。
 */
async function submitPartialFieldTablePermissionApply(
  page: Page,
  options: {
    tableName: string;
    marker: string;
    approvalPlan: PermissionIdentity[];
    allowedField: string;
    deniedField: string;
  },
): Promise<string[]> {
  const card = await openTableQueryCard(page, options.tableName);
  if (!card) {
    skipForMissingEnvironment(
      '申请人在数据地图-表查询中搜不到目标表 ' + options.tableName
        + '（可能元数据未刷新，或申请角色菜单未含数据地图）。',
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
        '目标表 ' + options.tableName + ' 的卡片与详情页均未见“申请权限”入口：可能申请人已持有该表权限'
          + '（归因前置应已排除），或页面结构已变化（flash 验证点：卡片操作区实现）。',
      );
    }
  }
  const layer = visibleLayer(page);
  await expect(layer).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/申请表|申请权限/).first()).toBeVisible();
  const labelledBox = layer.getByRole('textbox', { name: /申请原因|申请说明|申请理由|备注/ }).first();
  let reasonBox: Locator | undefined = await labelledBox.isVisible().catch(() => false) ? labelledBox : undefined;
  if (!reasonBox) reasonBox = await firstVisible(layer.locator('textarea:visible'));
  if (!reasonBox) {
    const layerText = (await layer.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error('申请弹窗未找到“申请原因”输入框（flash 验证点）：弹窗文本=' + layerText);
  }
  await reasonBox.fill(options.marker);
  const useFlag = layer.locator('[type="checkbox"], .el-checkbox, .ant-checkbox').filter({ hasText: /使用/ }).first();
  if (await useFlag.isVisible().catch(() => false)) {
    const inner = useFlag.locator('input[type="checkbox"]').first();
    const checked = await inner.isChecked().catch(() => true);
    if (!checked) await useFlag.click();
  }
  // DS-PERM-109 关键差异：字段范围显式选“部分字段”（默认值可能是“全部字段”）。
  // 基线先于切换读取；“部分字段”文本找不到=申请弹窗不支持字段范围选择，真实失败。
  const baselineComboboxCount = await visibleComboboxCount(layer);
  await (await mustText(layer, FIELD_SCOPE_PARTIAL, '部分字段')).click();
  await page.waitForTimeout(800);
  const fieldControl = await detectFieldSelectionControl(layer, baselineComboboxCount);
  if (!fieldControl) {
    throw new Error(
      'TODO[env] 校准：申请弹窗切换“部分字段”后未检测到字段选择控件'
        + '（multi-select/checkbox-group/transfer 形态待实测；不默认按“全部字段”提交）。',
    );
  }
  // 默认可能全选：先移除授予字段之外的已选字段（排除字段必须显式不勾），再精确
  // 选中授予字段；提交前回读复核“含授予、不含排除”。
  const preSelectedFields = await readSelectedFields(fieldControl);
  for (const field of preSelectedFields) {
    if (field === options.allowedField) continue;
    if (!(await deselectField(page, fieldControl, field))) {
      throw new Error(`申请弹窗字段选择失败：已选字段“${field}”未能取消勾选（字段多选形态待环境校准）。`);
    }
  }
  if (!(await selectFieldByName(page, fieldControl, options.allowedField))) {
    throw new Error(`申请弹窗字段选择失败：未找到授予字段“${options.allowedField}”（字段多选形态待环境校准）。`);
  }
  const appliedFields = await readSelectedFields(fieldControl);
  if (!appliedFields.includes(options.allowedField)) {
    throw new Error(
      `申请弹窗提交前复核：已选字段应包含授予字段“${options.allowedField}”，实际=[${appliedFields.join('、')}]。`,
    );
  }
  if (appliedFields.includes(options.deniedField)) {
    throw new Error(
      `申请弹窗提交前复核：已选字段不得包含排除字段“${options.deniedField}”，实际=[${appliedFields.join('、')}]。`,
    );
  }
  const sequence = await assignApprovalNodes(page, layer, options.approvalPlan);
  if (sequence.length < 2) {
    skipForMissingEnvironment(
      '当前表权限审批流可指派的审批节点不足 2 级（实测 ' + sequence.length
        + ' 级）；多级审批需先在环境为表权限审批流配置两级及以上可选审批节点。',
    );
  }
  const submit = layer.getByRole('button', { name: /提\s*交|确\s*定/ }).last();
  await expect(submit).toBeVisible();
  const blocked = page.getByText(/未指定审批人|请补全/).first();
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
  // 关层与拦截提示二选一为完成信号；提示文案未录制（flash 校准点），按通用词兜底。
  await expect.poll(async () => {
    if (await blocked.isVisible().catch(() => false)) return 'blocked';
    return (await layer.isVisible().catch(() => false)) ? 'open' : 'closed';
  }, { timeout: 15_000 }).toBe('closed');
  await expect(successNotice(page, /成功|提交|申请/)).toBeVisible({ timeout: 5_000 }).catch(() => undefined);
  return sequence;
}

test('SM-02-08｜系统管理｜申请部分字段经审批后自动授权与实际访问', async ({ loginPage, consoleErrors, report }) => {
  // RUN_PERMISSION_APPROVAL=1 闸门（条件 skip、非永久）：审批流为环境共享配置。
  requirePermissionApprovalEnvironment();

  // DB_* MySQL 前置门禁（条件 skip、写明原因）：本轮专用表必须 MySQL 直连创建；
  // 配置存在但不可达时建表真实失败，不伪造通过。
  const cfg = dbConfig();
  test.skip(
    !cfg || cfg.type !== 'mysql',
    `前置不足：未配置 MySQL 数据库环境（DB_TYPE=${process.env.DB_TYPE ?? ''}，DB_HOST=${process.env.DB_HOST ?? ''}），无法创建本轮唯一专用表。`,
  );

  // 管理员身份（双视角核验/收尾）：TEST_USER/TEST_PASS 缺失时条件 skip。
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
      'SM-02-08 阶段0a｜创建本轮专用表',
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
      'SM-02-08 阶段0b｜创建本轮账号与角色',
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
    await report('SM-02-08 阶段0c｜刷新数据库元数据（管理员）', true, metadataWarmup);

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
      'SM-02-08 阶段1｜归因前置（申请人无任何本表授权）',
      true,
      `双视角均未回显主体 ${applicant.userName} 对 ${TARGET_TABLE} 的授权行。`,
    );

    // 阶段2【DS-PERM-109 核心差异】（提交“部分字段”申请）：申请人登录后在申请弹窗
    // 显式选“部分字段”、只勾授予字段 sm_id、显式不勾排除字段 sm_value，提交前回读
    // 复核（helper 内硬断言）；搜不到目标表/无申请入口/节点不足按前置不足 skip。
    const okMarker = permissionRunId('e2e_sm0208');
    await loginAs(page, applicant);
    const sequence = await submitPartialFieldTablePermissionApply(page, {
      tableName: TARGET_TABLE,
      marker: okMarker,
      approvalPlan: APPROVAL_PLAN,
      allowedField: ALLOWED_FIELD,
      deniedField: DENIED_FIELD,
    });
    pendingMarkers.push(okMarker);
    await report(
      'SM-02-08 阶段2｜申请人提交“部分字段”表权限申请',
      true,
      `marker=${okMarker}；目标表=${TARGET_TABLE}；申请字段范围=部分字段（仅 ${ALLOWED_FIELD}，不含 ${DENIED_FIELD}）；审批序列=${sequence.join('→')}。`,
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
      'SM-02-08 阶段3｜逐级同意至终审通过',
      true,
      `${approverChain.map((identity) => identity.userName).join('→')} 全部同意、待办清空；申请人终态=已通过（应按申请范围“部分字段=${ALLOWED_FIELD}”自动授权 ${TARGET_TABLE}）。`,
    );

    // 阶段4/5【DS-PERM-109 关键核验】（双视角授权一致且恰为申请字段范围）：审批完成
    // 自动生成的授权——用户视角（主体=申请人）与资源视角（对象=同一张表）出现同一
    // 条“使用”授权；结论主体始终是申请人（审批人被错误授权的缺陷不能被本用例掩盖）。
    // 与 SM-02-06 的差异：此处**没有**管理员收窄步骤——若授权为默认“全部字段”或
    // 字段集合与申请不一致，即为“申请字段范围未传导到自动授权”的真实缺陷，判失败。
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
    await expect(resourceViewRow, '按申请“部分字段”生成的授权行应回显“部分字段”').toContainText(FIELD_SCOPE_PARTIAL);
    await expect(resourceViewRow, '授权行不应残留“全部字段”（申请范围未传导即缺陷）').not.toContainText(FIELD_SCOPE_ALL);
    // 行级文本可能不列字段明细：重开编辑弹窗回显做字段集合级硬校验（含授予、不含排除）。
    // TODO[env]：编辑弹窗字段多选形态（multi-select/checkbox-group/transfer）待环境
    // 校准（同 SM-03-10/SM-02-06 阶段8 回显）。
    const echoDialog = await openPermissionEditDialog(page, resourceViewRow);
    const echoBaseline = await visibleComboboxCount(echoDialog);
    await mustText(echoDialog, FIELD_SCOPE_PARTIAL, '部分字段');
    const echoControl = await detectFieldSelectionControl(echoDialog, echoBaseline);
    if (!echoControl) {
      throw new Error('TODO[env] 校准：授权行编辑弹窗未检测到字段选择控件（字段范围回显口径待实测）。');
    }
    const echoedFields = await readSelectedFields(echoControl);
    expect(echoedFields, `自动授权字段集合应包含申请的授予字段“${ALLOWED_FIELD}”`).toContain(ALLOWED_FIELD);
    expect(echoedFields, `自动授权字段集合不应包含申请未勾选的排除字段“${DENIED_FIELD}”`).not.toContain(DENIED_FIELD);
    await closePermissionDialog(page, echoDialog);
    await report(
      'SM-02-08 阶段4/5｜双视角授权一致且恰为申请字段范围（使用·部分字段）',
      true,
      `用户视角与资源视角均回显同一条“使用”授权（主体=${applicant.userName}，表=${TARGET_TABLE}）；`
        + `字段范围=部分字段：含 ${ALLOWED_FIELD}、不含 ${DENIED_FIELD}（行级 + 编辑弹窗回显双重校验，无管理员收窄步骤）。`,
    );

    // 阶段6（开关隔离与开启）：先记录共享开关原始值（finally 必须恢复原值，恢复失败
    // 使测试失败），再开启——业务规则（§11.1-1）：开关关闭时不校验表权限，开启后才
    // 按数据源、表及字段范围校验。
    originalSwitchChecked = await readPermissionSwitchChecked(page);
    if (originalSwitchChecked === false) {
      await setPermissionSwitch(page, true);
    }
    await report(
      'SM-02-08 阶段6｜共享数据权限开关隔离与开启',
      true,
      `原始状态=${originalSwitchChecked ? '开启' : '关闭'}（收尾恢复）；现已开启，后续字段访问按数据源、表及字段范围校验。`,
    );

    // 阶段7（申请人重登·表可见性）：数据地图-表查询卡片可见、表详情（基础信息+字段
    // 区）可达；详情字段区为元数据展示，应同时列出授予与排除字段（字段级控制只在
    // 查询执行层生效）。TODO[env]：卡片点击目标（整卡/表名链接）与详情容器形态待
    // 环境校准（口径同 SM-02-01/06）。
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
      'SM-02-08 阶段7｜申请人重登：表查询卡片与表详情可达',
      true,
      `卡片命中 ${TARGET_TABLE}；详情字段区列出 ${ALLOWED_FIELD} 与 ${DENIED_FIELD}（元数据展示，字段级控制在查询层验证）。`,
    );

    // 阶段8（授予字段实际访问·自助查询真实只读 SQL）：列别名带本轮唯一 marker，
    // 结果列头出现 marker 即查询成功（SM-03-10 已实证口径）；种子两行都应返回。
    await openSelfServiceQuery(page);
    await refreshDatabaseMetadata(page);
    await chooseConfiguredDataSource(page, {
      type: permissionResource.sourceTypeName,
      name: querySourceName,
      schema: false,
    });
    const grantMarker = `fldok_${uuid().slice(0, 8)}`;
    await executeSql(page, `SELECT \`${ALLOWED_FIELD}\` AS ${grantMarker} FROM ${TARGET_TABLE} LIMIT 2`);
    await expect
      .poll(async () => readQueryOutcome(page, grantMarker), {
        timeout: 30_000,
        message: `授予字段 ${ALLOWED_FIELD} 的只读查询未成功返回（部分字段授权未在查询层生效？）`,
      })
      .toBe('done');
    await expect(page.getByText('sm-1').first(), '授予字段查询应返回种子行 sm-1').toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('sm-2').first(), '授予字段查询应返回种子行 sm-2').toBeVisible({ timeout: 5_000 });
    await report(
      'SM-02-08 阶段8｜授予字段实际访问成功',
      true,
      `SELECT \`${ALLOWED_FIELD}\` … FROM ${TARGET_TABLE} 返回种子行 sm-1、sm-2（marker=${grantMarker}）。`,
    );

    // 阶段9【DS-PERM-109 严格判定】（排除字段必须被明确拒绝）：与 SM-03-10 的差异——
    // 那里把“查询成功”记为产品能力差异 annotation；本用例申请单显式只勾 ${ALLOWED_FIELD}，
    // 授权回显已双重确认，若排除字段仍可查=字段范围未在查询层生效的真实缺陷，判失败；
    // 长时间既无结果也无拦截文案同样是失败（TODO[env] 校准），不得以空结果/SQL 错误冒充拒绝。
    const denyMarker = `fldno_${uuid().slice(0, 8)}`;
    await executeSql(page, `SELECT \`${DENIED_FIELD}\` AS ${denyMarker} FROM ${TARGET_TABLE} LIMIT 1`);
    let denyOutcome: 'done' | 'denied' | 'pending' = 'pending';
    const denyDeadline = Date.now() + 30_000;
    while (Date.now() < denyDeadline) {
      const state = await readQueryOutcome(page, denyMarker);
      if (state !== 'pending') {
        denyOutcome = state;
        break;
      }
      await page.waitForTimeout(500);
    }
    if (denyOutcome !== 'denied') {
      const bodyText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(
        denyOutcome === 'done'
          ? `排除字段 ${DENIED_FIELD} 的查询成功返回（marker=${denyMarker} 列头已出现）：申请“部分字段（仅 ${ALLOWED_FIELD}）”`
            + `经审批自动授权后，字段范围未在查询执行层生效——疑似真实缺陷。`
          : `排除字段 ${DENIED_FIELD} 的查询 30 秒内既无结果列头也无“没有…权限/权限不足”拦截文案`
            + `（marker=${denyMarker}）：严格判定不通过，不得以无结果冒充拒绝；当前页面文本：${bodyText}`,
      );
    }
    await report(
      'SM-02-08 阶段9｜排除字段查询被权限拦截（严格判定通过）',
      true,
      `SELECT \`${DENIED_FIELD}\` … FROM ${TARGET_TABLE} 得到“没有…权限/权限不足”类明确拒绝（marker=${denyMarker}）；`
        + `授予字段可查、排除字段被拒，字段级控制在查询层生效。`,
    );

    // 控制台：字段级拦截允许后端以 4xx/5xx 拒绝（已声明），其余错误一律失败。
    await assertNoUnexpectedConsoleErrors(consoleErrors, EXPECTED_QUERY_FAILURE_PATTERNS);
    await report(
      'SM-02-08 结论｜申请人“部分字段”申请经逐级审批自动授权并实际生效',
      true,
      `申请（${okMarker}，部分字段=${ALLOWED_FIELD}）→ ${approverChain.map((identity) => identity.userName).join('→')} 逐级同意 → 自动授权`
        + `（使用·部分字段，双视角一致）→ 授予字段可查（sm-1/sm-2）→ 排除字段被明确拒绝。闭环成立。`,
    );
  } catch (error) {
    // 主体失败先记录、不立即重抛以外的动作——保证 finally 全部收尾步骤执行（DS-PERM-92 口径）。
    mainError = error;
    throw error;
  } finally {

    // 收尾契约（DS-PERM-109）：每步独立 try/catch 保证链式执行；回收失败附件留证，
    // 主流程无失败时收尾失败定性用例失败；共享开关恢复失败无条件显式失败。
    const cleanupIssues: string[] = [];
    const attachCleanupEvidence = (step: string, message: string): void => {
      test.info().attach('SM-02-08-收尾清理证据.txt', {
        body: `[${step}] ${message}`,
        contentType: 'text/plain; charset=utf-8',
      });
    };

    // 1) 兜底撤销仍处“未审批”的本轮申请（helper 内部已逐 marker 留证，不掩盖主结果）。
    try {
      await revokeLeftoverPendingApplications(page);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cleanupIssues.push(`兜底撤销遗留申请失败：${message.slice(0, 160)}`);
      attachCleanupEvidence('兜底撤销', message);
    }

    // 2) 回收“本轮主体×本轮专用表”授权行（管理员·资源视角页面操作，≤10 条防死循环）。
    try {
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      const removedRows = await purgeOwnGrantedTablePermissions(page);
      if (removedRows > 0) {
        console.warn(`[SM-02-08 收尾] 已回收 ${applicant.userName} 对 ${TARGET_TABLE} 的授权行 ${removedRows} 条。`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cleanupIssues.push(`回收授权行失败（${applicant.userName}×${TARGET_TABLE}）：${message.slice(0, 160)}`);
      attachCleanupEvidence('回收授权行', message);
    }

    // 3) DROP 本轮专用表（MySQL 直连；IF EXISTS 幂等，未建表时无副作用）。
    try {
      await query(`DROP TABLE IF EXISTS ${TARGET_TABLE}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cleanupIssues.push(`DROP 本轮专用表失败（${TARGET_TABLE}，需人工清理）：${message.slice(0, 160)}`);
      attachCleanupEvidence('DROP 专用表', message);
    }

    // 4) 尽力删除本轮自建账号（管理员·用户管理页；helper 内部返回说明而非抛错，
    //    仅页面操作异常进入 catch）。角色按先例（SM-00-02）保留复用。
    for (const identity of [applicant, approverLevel1, approverLevel2]) {
      try {
        await loginAs(page, adminIdentity);
        const detail = await deleteOwnUser(page, identity);
        if (!detail.startsWith('列表未查询到')) {
          console.warn(`[SM-02-08 收尾] 账号 ${identity.userName}：${detail}。`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cleanupIssues.push(`删除自建账号失败（${identity.userName}，需人工清理）：${message.slice(0, 160)}`);
        attachCleanupEvidence('删除账号', message);
      }
    }

    // 5) 恢复共享数据权限开关原始值：共享配置，恢复失败无条件显式失败（不吞、不降级）。
    if (originalSwitchChecked !== undefined) {
      try {
        await loginAs(page, adminIdentity);
        await openDataPermissionPage(page);
        await setPermissionSwitch(page, originalSwitchChecked);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attachCleanupEvidence('恢复数据权限开关', message);
        throw new Error(
          `数据权限开关恢复失败（原始状态=${originalSwitchChecked ? '开启' : '关闭'}，共享配置已被本用例改动，必须人工处理）：${message}`,
        );
      }
    }

    // 定性：主流程成功但收尾资产回收失败 → 用例失败（不掩盖）；主流程已有失败时不
    // 覆盖原始错误（Playwright 报首个 throw）。
    if (!mainError && cleanupIssues.length > 0) {
      throw new Error('收尾未完全成功（不掩盖）：' + cleanupIssues.join('；'));
    }
  }
});
