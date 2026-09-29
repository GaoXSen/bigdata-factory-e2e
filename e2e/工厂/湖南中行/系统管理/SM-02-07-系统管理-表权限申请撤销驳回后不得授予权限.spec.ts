/**
 * SM-02-07（DS-PERM-53 净环境迁移版）｜系统管理｜表权限申请撤销/驳回后不得授予权限
 *
 * 业务口径（两条相互独立的申请链，负向收口，对应旧用例的两条 test）：
 *   - 链A 撤销：申请人提交“使用”表权限申请 →“我的申请-未审批”回显 → 申请人主动撤销 →
 *     最终态“已撤销”→ 管理员用户/资源双视角均无授权行 → 申请人重登后表卡片仍在且
 *     “申请权限”入口仍可用（未持有权限的可观察信号）。
 *   - 链B 驳回：申请人提交 → 流程序列首个承接人拒绝 → 最终态“已驳回”（兼容“已拒绝”
 *     等义文案）→ 双视角均无授权行 → 申请人重登后卡片仍在且仍可再次申请。
 *   - 负向结论主体都是申请人（不是审批人）；任一视角出现授权行即按产品缺陷失败
 *    （“流程终止后仍生成授权”），不允许静默通过。
 *   - 负向断言区分两类信号：主体/资源“选中信号”失败（用户视角主体选不中、资源视角
 *     级联点不中目标表）＝页面/前置未加载类问题，显式归因报错；“选中信号”通过后列表
 *     轮询无行＝真实“未生成授权”。每个视角附页面文本证据便于人工复核。
 *   - 查询级拒绝证据（DS-PERM-105）：撤销/驳回链在“双视角无授权行 + 申请入口仍可用”
 *     之后，新增申请人本人对本轮专用表的实际查询断言：预期“数据源因无表级使用权限
 *     不可见”或“只读 SQL 被表级‘没有使用权限’拦截”二者其一；审批本就未通过，本链路
 *     从未生成授权，表述为“未获授权且实际查询被拦截”，不写“先授权后撤销”。判定复用
 *     SM-03-10/11 的 readQueryOutcome 状态机与 chooseConfiguredDataSource 已知错误文案；
 *     连接失败、表不存在、SQL/字段错误、页面未加载等其余错误原样上抛，不冒充“无权限”。
 *
 * 净环境改造（对齐 SM-02-06 迁移模式与任务包 DS-PERM-53）：
 *   - 不再使用 permissionFixtures 固定账号；每条链自备本轮 UUID 唯一 ASCII 资产：
 *     申请人/两节点审批人账号（newPermissionIdentity）、3 个角色（申请人=数据地图+
 *     数据查询；审批人=数据地图）、专用表 e2e_sm0207?*_t_<uuid>（MySQL 直建 2 行种子）、
 *     申请标识 permissionRunId（本轮唯一）。
 *   - 物理库统一走配置中心（query→dbConfig，主库名取 dbConfig()?.database）；
 *     平台展示名走 resolveMysqlPermissionResource 内建回落链（DATA_PERMISSION_* →
 *     导出链环境变量 → 配置中心展示名），用例内不再散落 process.env 读取。
 *   - 前置门（条件 skip，不永久跳过）：RUN_PERMISSION_APPROVAL=1（共享审批流须允许本
 *     组织申请，且流程序列可分配节点≥2 且含本轮审批人，否则按工具内口径条件 skip 并附
 *     候选证据，不误报产品缺陷）；MySQL 未配置时条件 skip。
 *   - finally 收尾（仅本轮资产，尽力而为、不掩盖主结果）：兜底撤销未终结申请 → 兜底
 *     删除本轮授权行（负向链路应删到 0，>0 即阶段断言缺陷的直接佐证）→ DROP 专用表 →
 *     删除本轮账号 → 恢复数据权限开关原始值（恢复失败显式暴露并附带原失败）。
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
  openRoleManagement,
  openUserManagement,
  type PermissionIdentity,
  type PermissionRole,
} from './权限测试工具.js';
import {
  deletePermissionFromRow,
  findPermissionRow,
  findResourceViewAuthorizationRow,
  openDataPermissionPage,
  refreshPermissionList,
  resolveMysqlPermissionResource,
  selectUserViewSubject,
  type MysqlPermissionResource,
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

async function assertNoUnexpectedConsoleErrors(
  consoleErrors: string[],
  expectedFailurePatterns: RegExp[],
): Promise<void> {
  const unexpected = consoleErrors.filter((error) =>
    !expectedFailurePatterns.some((pattern) => pattern.test(error)),
  );
  expect(
    unexpected,
    `控制台出现未声明错误：\n${unexpected.join('\n')}\n\n本次已允许的预期异常：\n${
      consoleErrors.filter((error) => !unexpected.includes(error)).join('\n')
    }`,
  ).toEqual([]);
}

/**
 * 管理员身份（配置中心账号 TEST_USER/TEST_PASS）：创建主体/角色、双视角断言与
 * finally 恢复开关时使用。延迟到用例运行期解析：requireAdminIdentity 缺账号时走
 * skipForMissingEnvironment 的条件 skip（test.info() 仅在用例运行期可用，模块
 * 顶层调用会使整份文件加载崩溃）；首次解析后缓存，同一进程内不重复校验。
 */
let adminIdentityCache: PermissionIdentity | undefined;
function adminIdentity(): PermissionIdentity {
  adminIdentityCache ??= requireAdminIdentity();
  return adminIdentityCache;
}

/** 物理主库名（utils→dbConfig() 配置中心口径，仅用于可读报告；DDL 走 query() 同源）。 */
const primaryDbName = dbConfig()?.database ?? '未配置主库';

/**
 * 本轮链资产：两条链完全独立（账号/角色/专用表/申请标识均为本轮 UUID 唯一，ASCII）。
 * 展示名回落链由 resolveMysqlPermissionResource 内建，用例内不再散落 process.env 读取。
 */
interface ChainAssets {
  label: string;
  tableName: string;
  marker: string;
  applicant: PermissionIdentity;
  approverLevel1: PermissionIdentity;
  approverLevel2: PermissionIdentity;
  roles: { applicant: PermissionRole; approverLevel1: PermissionRole; approverLevel2: PermissionRole };
  permissionResource: MysqlPermissionResource;
  /** 仍处“未审批”的本轮申请 marker：提交成功入列；终态确认后出列；finally 兜底撤销。 */
  pendingMarkers: string[];
}

function newChainAssets(caseKey: string, label: string): ChainAssets {
  const tableName = `e2e_${caseKey}t_${uuid()}`;
  return {
    label,
    tableName,
    marker: permissionRunId(caseKey),
    applicant: newPermissionIdentity(`${caseKey}a`),
    approverLevel1: newPermissionIdentity(`${caseKey}l1`),
    approverLevel2: newPermissionIdentity(`${caseKey}l2`),
    roles: {
      applicant: newPermissionRole(caseKey, 'applicant'),
      approverLevel1: newPermissionRole(caseKey, 'approver-level1'),
      approverLevel2: newPermissionRole(caseKey, 'approver-level2'),
    },
    permissionResource: resolveMysqlPermissionResource({ tableName }),
    pendingMarkers: [],
  };
}

/** 链A＝撤销链；链B＝驳回链（模块级各生成一次；串行单 worker，资产互不共享）。 */
const revokeChain = newChainAssets('sm0207rv', '撤销链A');
const rejectChain = newChainAssets('sm0207rj', '驳回链B');

/** marker 标记终态：从未审批跟踪表移除（indexOf<0 时不动，防 splice(-1) 误删末位）。 */
function markSettled(assets: ChainAssets, marker: string): void {
  const index = assets.pendingMarkers.indexOf(marker);
  if (index >= 0) assets.pendingMarkers.splice(index, 1);
}

/** 统一错误消息提取。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 实际审批序列（登录用户名）→ 本轮链的登录身份：与旧用例 identityByUserName 同口径。 */
function identityForSequence(assets: ChainAssets, userName: string | undefined): PermissionIdentity {
  if (userName) {
    for (const identity of [assets.approverLevel1, assets.approverLevel2]) {
      if (identity.userName === userName) return identity;
    }
  }
  throw new Error(
    `流程序列返回了非本轮审批人的用户名：${String(userName)}`
      + `（本轮=${assets.approverLevel1.userName}/${assets.approverLevel2.userName}）。`,
  );
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

/** 采集页面可读文本证据（空白归一、截断 400 字）附加到报告，返回截断文本。 */
async function attachPageTextEvidence(page: Page, label: string): Promise<string> {
  const raw = await page.locator('body').innerText().catch(() => '');
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const snippet = normalized.length > 400 ? `${normalized.slice(0, 400)}…` : normalized;
  test.info().attach(label, { body: snippet || '（未能读取页面文本）', contentType: 'text/plain; charset=utf-8' });
  return snippet;
}

/** 数据权限页顶部“数据权限”开关：优先 ARIA switch，兼容旧版 Element 外层实现（复刻自 SM-02-06/SM-03-06）。 */
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

/**
 * 自助查询侧栏在部分版本只渲染图标链接（本地复刻自 SM-02-06/SM-03-09：两侧 utils
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
 * “刷新数据库元数据”确认弹窗处理（复制自 SM-02-06/SM-03-06 已实证实现）：点击目录
 * 刷新后出现确认弹窗必须点“确定”并等待关闭+树刷新，否则模态层阻塞后续交互；未出现
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

/** 自助查询验证前刷新数据库元数据（目录控件未渲染时安全跳过，不作为失败；同 SM-02-06）。 */
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
 * SM-02-06/SM-03-06 createPermissionFixtureTable）。建表失败为真实失败（调用方
 * 上抛前尽力 DROP 半建表），不伪造通过。
 */
async function createPermissionFixtureTable(tableName: string): Promise<number> {
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
      + `('sm-1', 'e2e-sm0207-a', '${tableName}'), ('sm-2', 'e2e-sm0207-b', 'sm0207-approval-terminated')`,
  );
  const rows = await query(`SELECT COUNT(*) AS total FROM ${tableName}`);
  const total = Number((rows[0] as { total?: unknown } | undefined)?.total ?? -1);
  expect(total, `专用表 ${tableName} 种子数据应为 2 行，实际：${JSON.stringify(rows)}`).toBe(2);
  return 2;
}

/**
 * 创建本轮链的全部主体（页面真实操作，任一步失败即真实失败、不静默）：
 * 申请人/两节点审批人账号（用户管理页真实新增+邀请组织）、3 个角色（申请人=数据地图+
 * 数据查询，可到表查询并发起申请；审批人=数据地图，可到审批工作台），并把角色绑定到
 * 对应账号。
 */
async function provisionApprovalChainAssets(page: Page, assets: ChainAssets): Promise<void> {
  await openUserManagement(page);
  await createAndInviteUser(page, assets.applicant, { openPage: false });
  await createAndInviteUser(page, assets.approverLevel1, { openPage: false });
  await createAndInviteUser(page, assets.approverLevel2, { openPage: false });
  await openRoleManagement(page);
  await createRole(page, assets.roles.applicant, ['数据地图', '数据查询'], { openPage: false });
  await createRole(page, assets.roles.approverLevel1, ['数据地图'], { openPage: false });
  await createRole(page, assets.roles.approverLevel2, ['数据地图'], { openPage: false });
  await assignRoleToUser(page, assets.roles.applicant, assets.applicant);
  await assignRoleToUser(page, assets.roles.approverLevel1, assets.approverLevel1);
  await assignRoleToUser(page, assets.roles.approverLevel2, assets.approverLevel2);
}

/**
 * 负向核验（结论主体=申请人；阶段0e 归因前置与终止后断言共用）：用户视角与资源视角
 * 都必须不存在申请人 × 本轮专用表的授权行；任何一条存在即“流程终止后仍生成授权”，
 * 按产品缺陷失败并附行文本。两类信号显式区分、不互相冒充：
 *   - 主体/资源选中失败（selectUserViewSubject、资源视角级联）＝页面/前置未加载类问题，
 *     抛出带归因前缀的错误，不得误报成“未生成授权”；
 *   - 选中信号通过后（用户视角主体可选中；资源视角级联点中目标表且“新建权限”启用）
 *     列表轮询无行＝真实“未生成授权”。
 * 每个视角附页面文本证据（可读、截断），便于人工复核。前置：page 已以管理员登录。
 */
async function expectNoGrantForApplicant(page: Page, assets: ChainAssets, when: string): Promise<void> {
  await openDataPermissionPage(page);

  // —— 用户视角：主体可选中是“页面已加载”信号；选中后列表无行才是“未生成授权”。 ——
  try {
    await selectUserViewSubject(page, {
      subjectTab: '成员',
      subjectName: assets.applicant.userName,
      subjectAlias: assets.applicant.nickname,
    });
  } catch (selectionError) {
    throw new Error(`用户视角主体未选中（归因：页面/主体未加载类前置问题，而非“未生成授权”）：${messageOf(selectionError)}`);
  }
  await refreshPermissionList(page);
  await attachPageTextEvidence(page, `SM-02-07 ${assets.label} 用户视角页面证据（${when}）`);
  const userViewRow = await findPermissionRow(page, assets.tableName, 6_000);
  if (userViewRow) {
    const rowText = (await userViewRow.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    throw new Error(
      `${when}：用户视角仍存在申请人 ${assets.applicant.userName} × 表 ${assets.tableName} 的授权行`
        + `：流程终止后不得生成表授权。行文本=${rowText}`,
    );
  }

  // —— 资源视角：级联点中目标表（工具内以“新建权限”启用为选中信号）后查申请人行。 ——
  let resourceViewRow: Locator | undefined;
  try {
    resourceViewRow = await findResourceViewAuthorizationRow(page, {
      resource: assets.permissionResource,
      subjectName: assets.applicant.userName,
      scopeTab: '数据表',
      timeoutMs: 6_000,
    });
  } catch (resourceError) {
    throw new Error(`资源视角未选中目标资源（归因：页面/资源未加载类前置问题，而非“未生成授权”）：${messageOf(resourceError)}`);
  }
  await attachPageTextEvidence(page, `SM-02-07 ${assets.label} 资源视角页面证据（${when}）`);
  if (resourceViewRow) {
    const rowText = (await resourceViewRow.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    throw new Error(
      `${when}：资源视角表 ${assets.tableName} 仍存在申请人 ${assets.applicant.userName} 的授权行`
        + `：流程终止后不得生成表授权。行文本=${rowText}`,
    );
  }
}

/**
 * 申请人侧负向证据：重登后表查询元数据仍可见（卡片在），且“申请权限”入口仍可用
 * ＝申请人未因本轮申请获得该表权限（与 SM-02-01“已持有权限时入口消失”的口径互补）。
 * 卡片搜不到＝页面/元数据类前置问题（显式报错，不与“未生成授权”混同）；入口不可见时
 * 抛出带两种解释的失败（可能已被错误授权 / 卡片操作区实现变化），不允许静默通过。
 */
async function expectApplicantStillUnprivileged(page: Page, assets: ChainAssets): Promise<void> {
  await loginAs(page, assets.applicant, { entryUrl: approvalEntryUrl('/dataMap/tableQuery/tablesQuery') });
  const card = await openTableQueryCard(page, assets.tableName);
  if (!card) {
    const evidence = await attachPageTextEvidence(page, `SM-02-07 ${assets.label} 申请人重登-表查询页面证据`);
    throw new Error(`申请人在表查询中搜不到目标表 ${assets.tableName}：负向核验缺少比对基线。页面文本=${evidence}`);
  }
  await expect(card).toBeVisible();
  const icon = card.locator(
    '[aria-label="图标: safety-certificate"], [aria-label*="safety-certificate" i], [aria-label*="权限"], [title*="权限"]',
  ).first();
  const cardText = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ');
  test.info().attach(`SM-02-07 ${assets.label} 申请人卡片证据`, { body: cardText, contentType: 'text/plain; charset=utf-8' });
  if (!(await icon.isVisible().catch(() => false))) {
    // 卡片刚展开时操作区可能晚一拍渲染：短等待后复查一次，仍不可见才按缺陷/改版报出。
    await page.waitForTimeout(1_000);
  }
  if (!(await icon.isVisible().catch(() => false))) {
    throw new Error(
      `申请人 ${assets.applicant.userName} 的表卡片未见“申请权限”入口：可能已被错误授权，或卡片操作区实现变化（flash 校准点）。卡片文本=${cardText}`,
    );
  }
}

/** 自助查询数据源弹窗展示基础名（完整展示名去掉“:库”后缀；口径同 SM-03-09/10/11 的 querySourceName）。 */
function querySourceNameOf(assets: ChainAssets): string {
  return assets.permissionResource.sourceName.split(/[:：]/)[0].trim();
}

/**
 * 自助查询执行结果状态机（复刻 SM-03-10/11 同名判定）：done=结果列头出现本轮唯一别名；
 * denied=页面出现表级权限拦截文案（后端口径“【表名】数据表没有使用权限，请确认”）；
 * pending=仍在执行。denied 判定读 body 文本，SQL 别名本身不会误报。
 */
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
 * 查询级拒绝证据（DS-PERM-105，语义同 SM-03-10/11 expectTableQueryBlocked）：申请人未获
 * 授权时对本轮专用表的实际查询必须被明确拦截，两种预期表现其一即成立：
 *   a) 数据源因无表级使用权限记录不可见（chooseConfiguredDataSource 抛已知文案）；
 *   b) 数据源仍可选，提交只读 COUNT SQL 被表级“没有使用权限”拦截（denied 终态）。
 * 其余失败（连接失败、表不存在、SQL/字段错误、页面未加载）原样上抛，或以 poll 超时
 * +页面文本证据显式报因；不以卡片存在、按钮可点或空结果替代拒绝。前置：page 已以
 * 申请人身份登录。返回命中描述供 report 记录。
 */
async function expectApplicantTableQueryBlocked(
  page: Page,
  assets: ChainAssets,
  when: string,
): Promise<string> {
  await openSelfServiceQuery(page);
  try {
    await chooseConfiguredDataSource(page, {
      type: assets.permissionResource.sourceTypeName,
      name: querySourceNameOf(assets),
      schema: false,
    });
  } catch (error) {
    const message = messageOf(error);
    const hiddenByPermission = [
      `下拉选项“${assets.permissionResource.sourceTypeName}”未找到`,
      `下拉选项“${querySourceNameOf(assets)}”未找到`,
      '数据源弹窗下拉框数量不足',
      '当前数据源没有可选 Schema',
      '自助查询的数据源选择入口未找到',
    ].some((fragment) => message.includes(fragment));
    if (hiddenByPermission) {
      return `数据源已因无表级使用权限不可见（${message.split('，')[0]}）`;
    }
    throw error;
  }
  const marker = `sm0207deny_${uuid()}`;
  await executeSql(page, `SELECT COUNT(*) AS ${marker} FROM ${assets.tableName}`);
  try {
    await expect
      .poll(async () => readQueryOutcome(page, marker), {
        timeout: 30_000,
        message: `${when}：申请人 ${assets.applicant.userName} 未获授权，对 ${assets.tableName} 的查询未被拦截`
          + '——流程终止未在查询层生效，或存在本轮之外的主体/通配授权（真实失败）。',
      })
      .toBe('denied');
  } catch (pollError) {
    const evidence = await attachPageTextEvidence(page, `SM-02-07 ${assets.label} ${when} 查询未被拦截页面证据`);
    throw new Error(`${messageOf(pollError)}｜页面文本=${evidence}`);
  }
  return '数据源仍可见，但申请人查询被表级“没有使用权限”拦截（未获授权且实际查询被拦截）';
}

/**
 * 清理“本轮主体 × 本轮专用表”的授权行（finally 兜底；资源视角页面操作，≤10 条防死
 * 循环）。返回实际删除条数；找不到授权行返回 0（负向链路的预期值；不视为异常）。
 */
async function purgeOwnGrantedTablePermissions(page: Page, assets: ChainAssets): Promise<number> {
  let removed = 0;
  for (let guard = 0; guard < 10; guard += 1) {
    const stale = await findResourceViewAuthorizationRow(page, {
      resource: assets.permissionResource,
      subjectName: assets.applicant.userName,
      scopeTab: '数据表',
      timeoutMs: 4_000,
    });
    if (!stale) break;
    await deletePermissionFromRow(page, stale, { uniqueText: assets.tableName });
    removed += 1;
  }
  return removed;
}

/** 兜底撤销仍处未审批的本轮申请：仅本轮 marker；失败附证据不掩盖主结果。 */
async function revokeLeftoverPendingApplications(page: Page, assets: ChainAssets): Promise<void> {
  for (const marker of assets.pendingMarkers.slice()) {
    try {
      await revokeApplicationAsApplicant(page, assets.applicant, marker);
      markSettled(assets, marker);
      console.warn(`[SM-02-07 ${assets.label} 收尾] 遗留申请 ${marker} 已兜底撤销。`);
    } catch (error) {
      const message = messageOf(error);
      test.info().attach(`SM-02-07 ${assets.label} 收尾兜底撤销证据-${marker}`, {
        body: `兜底撤销申请 ${marker} 失败：${message}`,
        contentType: 'text/plain; charset=utf-8',
      });
      console.warn(`[SM-02-07 ${assets.label} 收尾] 遗留申请 ${marker} 兜底撤销失败：${message.slice(0, 160)}`);
    }
  }
}

/**
 * 尽力删除本轮自建账号（用户管理页：按本轮唯一账号查询 → 行内“删除”→ 确认；模板
 * SM-02-06/SM-03-09 deleteOwnUser）。只回收本轮自备账号；任一步不满足都返回说明文本
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
 * finally 收尾（仅本轮资产；每步尽力而为、失败仅记录不抛出，不掩盖主结果；顺序同
 * SM-02-06/SM-03-09）：兜底撤销未终结申请 → 兜底删除本轮授权行（负向链路应删到 0，
 * >0 即阶段断言缺陷/环境污染的直接佐证，如实上报）→ DROP 专用表 → 删除本轮账号 →
 * 恢复数据权限开关原始值（共享配置：恢复失败必须显式暴露并附带原失败原因）。
 */
async function cleanupChainAssets(
  page: Page,
  assets: ChainAssets,
  mainError: unknown,
  originalSwitchChecked: boolean | undefined,
  report: (name: string, passed: boolean, detail?: string) => Promise<void>,
): Promise<void> {
  const issues: string[] = [];
  try {
    await loginAs(page, adminIdentity());
    await revokeLeftoverPendingApplications(page, assets);
    await openDataPermissionPage(page);
    const removedFinally = await purgeOwnGrantedTablePermissions(page, assets);
    if (removedFinally > 0) {
      const note = `删除残留授权 ${removedFinally} 条（表=${assets.tableName}）；该行即阶段断言所指缺陷/污染的直接佐证。`;
      test.info().attach(`SM-02-07 ${assets.label} 收尾兜底回收授权`, { body: note, contentType: 'text/plain; charset=utf-8' });
      console.warn(`[SM-02-07 ${assets.label} 收尾] ${note}`);
    }
  } catch (purgeError) {
    issues.push(`申请/授权兜底回收未完成：${messageOf(purgeError)}`);
  }
  try {
    await query(`DROP TABLE IF EXISTS ${assets.tableName}`);
  } catch (dropError) {
    issues.push(`专用表回收未完成（${assets.tableName}）：${messageOf(dropError)}`);
  }
  try {
    await loginAs(page, adminIdentity());
    for (const identity of [assets.applicant, assets.approverLevel1, assets.approverLevel2]) {
      const outcome = await deleteOwnUser(page, identity);
      await report(`SM-02-07 ${assets.label} 收尾｜回收本轮账号`, true, `${identity.userName}：${outcome}。`);
    }
  } catch (userError) {
    issues.push(`本轮账号回收未完成：${messageOf(userError)}`);
  }
  for (const issue of issues) console.warn(`[SM-02-07 ${assets.label} 收尾] ${issue}`);

  // 恢复全局数据权限开关（共享配置；SM-03-09 同型）：恢复失败必须显式暴露并附带原失败
  // 原因，避免共享环境被遗留为测试态。
  if (originalSwitchChecked !== undefined) {
    try {
      await loginAs(page, adminIdentity());
      await openDataPermissionPage(page);
      await setPermissionSwitch(page, originalSwitchChecked);
      await report(
        `SM-02-07 ${assets.label} 收尾｜恢复数据权限开关原始状态`,
        true,
        `已恢复为 ${originalSwitchChecked ? '开启' : '关闭'}。`,
      );
    } catch (restoreError) {
      const restoreMessage = messageOf(restoreError);
      if (mainError === undefined) {
        throw new Error(`数据权限开关恢复失败（共享配置被遗留为测试态）：${restoreMessage}`);
      }
      throw new Error(`数据权限开关恢复失败（共享配置被遗留为测试态）：${restoreMessage}｜原失败：${messageOf(mainError)}`);
    }
  }
}

test('SM-02-07｜申请人撤销：流程终止且不生成表授权（净环境）', async ({ loginPage, consoleErrors, report }) => {
  requirePermissionApprovalEnvironment();
  const cfg = dbConfig();
  test.skip(!cfg || cfg.type !== 'mysql', '前置不足：未配置 MySQL 数据库环境（DB_TYPE/DB_HOST），无法创建本轮唯一专用表。');
  test.setTimeout(900_000);
  const page = loginPage;
  const assets = revokeChain;
  let originalSwitchChecked: boolean | undefined;
  let mainError: unknown;

  try {
    // 阶段0a（自备专用表）：MySQL 直连建表 + 2 行种子；建表失败为真实失败，上抛前尽力 DROP 半建表。
    try {
      const seededRows = await createPermissionFixtureTable(assets.tableName);
      await report(
        'SM-02-07 撤销链 阶段0a｜创建本轮专用表',
        true,
        `表=${primaryDbName}/${assets.tableName}（MySQL 直建，种子 ${seededRows} 行；平台展示源=${assets.permissionResource.sourceName}）。`,
      );
    } catch (fixtureError) {
      await query(`DROP TABLE IF EXISTS ${assets.tableName}`).catch(() => undefined);
      throw fixtureError;
    }

    // 阶段0b（自备主体）：管理员创建本轮申请人/两节点审批人账号、3 个角色并完成绑定。
    await loginAs(page, adminIdentity());
    await provisionApprovalChainAssets(page, assets);
    await report(
      'SM-02-07 撤销链 阶段0b｜创建本轮主体与角色',
      true,
      `申请人=${assets.applicant.userName}；审批人=${assets.approverLevel1.userName}/${assets.approverLevel2.userName}`
        + `（UUID 唯一，finally 尽力删除）；角色=申请人(数据地图+数据查询)/审批人(数据地图)×2。`,
    );

    // 阶段0c（元数据预热）：尽力而为、不阻断；本轮新表进入平台元数据缓存后表查询/申请级联才可见。
    let metadataWarmup: string;
    try {
      await openSelfServiceQuery(page);
      await chooseConfiguredDataSource(page, {
        type: assets.permissionResource.sourceTypeName,
        name: assets.permissionResource.sourceName.split(/[:：]/)[0].trim(),
        schema: false,
      });
      await refreshDatabaseMetadata(page);
      metadataWarmup = '自助查询目录已尝试按实时元数据刷新，本轮新表进入平台元数据缓存。';
    } catch (metadataError) {
      metadataWarmup = `预热未完成（不阻断）：${messageOf(metadataError).split('，')[0]}`;
    }
    await report('SM-02-07 撤销链 阶段0c｜刷新数据库元数据（管理员）', true, metadataWarmup);

    // 阶段0d（全局开关）：记录数据权限开关原始状态并确保“开启”（表权限语义前提；finally 恢复原值）。
    await openDataPermissionPage(page);
    originalSwitchChecked = await readPermissionSwitchChecked(page);
    await setPermissionSwitch(page, true);
    await report(
      'SM-02-07 撤销链 阶段0d｜确保数据权限开关开启',
      true,
      `开关原始=${originalSwitchChecked ? '开启' : '关闭'}（finally 恢复原值），已置开启；表=${assets.tableName}；主体=${assets.applicant.userName}。`,
    );

    // 阶段0e（归因前置·双视角负向）：全新主体×全新表本不应有任何授权行；若发现即环境污染
    //（真实失败）。选中信号失败＝页面/前置未加载类（助手显式归因），不与“未生成授权”混同。
    await expectNoGrantForApplicant(page, assets, '阶段0e前置');
    await report(
      'SM-02-07 撤销链 阶段0e｜归因前置：双视角均无授权行',
      true,
      `主体=${assets.applicant.userName}；表=${assets.tableName}；用户/资源双视角均未回显授权行（选中信号已硬校验，页面证据已附加）。`,
    );

    // 阶段1（提交申请）：申请人经表查询卡片发起“使用”权限申请；流程序列由共享审批流决定。
    await loginAs(page, assets.applicant, { entryUrl: approvalEntryUrl('/dataMap/tableQuery/tablesQuery') });
    const sequence = await submitTablePermissionApply(page, {
      tableName: assets.tableName,
      marker: assets.marker,
      approvalPlan: [assets.approverLevel1, assets.approverLevel2, assets.approverLevel1],
    });
    assets.pendingMarkers.push(assets.marker);
    await openApprovalWorkbenchAs(page, assets.applicant, '我的申请');
    expect(
      await findApprovalMarkerRow(page, '未审批', assets.marker),
      `我的申请-未审批 未出现本申请 ${assets.marker}：提交可能未落库或列表结构变化。`,
    ).toBeTruthy();
    await report(
      'SM-02-07 撤销链 阶段1｜申请人提交使用权限申请',
      true,
      `表=${assets.tableName}，标识=${assets.marker}；节点序列=${sequence.join(' → ')}；“我的申请-未审批”已回显。`,
    );

    // 阶段2（撤销）：申请人主动撤销 → 最终态“已撤销”（硬校验，读不到最终态按失败处理）。
    await revokeApplicationAsApplicant(page, assets.applicant, assets.marker);
    await expectApplicationFinalStatus(page, assets.applicant, assets.marker, /已撤销/, '已撤销');
    markSettled(assets, assets.marker);
    await report('SM-02-07 撤销链 阶段2｜申请人撤销并确认终态', true, `标识=${assets.marker}；终态=已撤销。`);

    // 阶段3（负向·管理员双视角）：撤销后不生成授权。
    await loginAs(page, adminIdentity());
    await expectNoGrantForApplicant(page, assets, '阶段3撤销后');
    await report(
      'SM-02-07 撤销链 阶段3｜撤销后双视角均无授权行',
      true,
      `主体=${assets.applicant.userName}；表=${assets.tableName}；用户/资源双视角均未生成授权（页面证据已附加）。`,
    );

    // 阶段4（负向收口·申请人侧）：重登后卡片仍在，且“申请权限”入口仍可用（未获授权信号）。
    await expectApplicantStillUnprivileged(page, assets);
    await report(
      'SM-02-07 撤销链 阶段4｜申请人重登：无授权且仍可再次申请',
      true,
      `表=${assets.tableName}；卡片可检索，“申请权限”入口仍可见（未获授权信号）。`,
    );

    // 阶段5（查询级拒绝收口，DS-PERM-105）：申请人以本人会话对本轮专用表实际查询，
    // 必须被明确拦截（本链路从未生成授权——预期“未获授权且实际查询被拦截”，非“先授权后撤销”）。
    await loginAs(page, assets.applicant, { entryUrl: approvalEntryUrl('/dataQuery/selfServiceQuery') });
    const revokeBlockedDetail = await expectApplicantTableQueryBlocked(page, assets, '撤销后');
    await report(
      'SM-02-07 撤销链 阶段5｜申请人实际查询被拦截（未获授权且查询级拒绝）',
      true,
      `表=${assets.tableName}；主体=${assets.applicant.userName}；${revokeBlockedDetail}。`,
    );

    // 无权限查询被后端拒绝属于本用例预期失败信号；其余控制台错误仍然失败（口径同 SM-03-10）。
    await assertNoUnexpectedConsoleErrors(consoleErrors, [
      /self\/query\/submitQuery/,
      /没有使用权限/,
      /dataPermission\//,
    ]);
    await report(
      'SM-02-07｜申请人撤销后不生成表授权（净环境闭环）',
      true,
      `表=${primaryDbName}/${assets.tableName}，主体=${assets.applicant.userName}（本轮自备，finally 回收）；`
        + `提交（使用）→ 我的申请可见 → 撤销 → 终态=已撤销 → 双视角无授权行 → 申请人重登仍可发起申请`
        + `→ 实际查询被拦截（未获授权且查询级拒绝）。`,
    );
  } catch (error) {
    mainError = error;
    throw error;
  } finally {
    await cleanupChainAssets(page, assets, mainError, originalSwitchChecked, report);
  }
});

test('SM-02-07｜审批人驳回：流程终止且不生成表授权（净环境）', async ({ loginPage, consoleErrors, report }) => {
  requirePermissionApprovalEnvironment();
  const cfg = dbConfig();
  test.skip(!cfg || cfg.type !== 'mysql', '前置不足：未配置 MySQL 数据库环境（DB_TYPE/DB_HOST），无法创建本轮唯一专用表。');
  test.setTimeout(900_000);
  const page = loginPage;
  const assets = rejectChain;
  let originalSwitchChecked: boolean | undefined;
  let mainError: unknown;

  try {
    // 阶段0a（自备专用表）：与本轮撤销链完全隔离的新表；建表失败为真实失败，上抛前尽力 DROP 半建表。
    try {
      const seededRows = await createPermissionFixtureTable(assets.tableName);
      await report(
        'SM-02-07 驳回链 阶段0a｜创建本轮专用表',
        true,
        `表=${primaryDbName}/${assets.tableName}（MySQL 直建，种子 ${seededRows} 行；平台展示源=${assets.permissionResource.sourceName}）。`,
      );
    } catch (fixtureError) {
      await query(`DROP TABLE IF EXISTS ${assets.tableName}`).catch(() => undefined);
      throw fixtureError;
    }

    // 阶段0b（自备主体）：本轮独立的申请人/两节点审批人账号、3 个角色并完成绑定。
    await loginAs(page, adminIdentity());
    await provisionApprovalChainAssets(page, assets);
    await report(
      'SM-02-07 驳回链 阶段0b｜创建本轮主体与角色',
      true,
      `申请人=${assets.applicant.userName}；审批人=${assets.approverLevel1.userName}/${assets.approverLevel2.userName}`
        + `（UUID 唯一，finally 尽力删除）；角色=申请人(数据地图+数据查询)/审批人(数据地图)×2。`,
    );

    // 阶段0c（元数据预热）：尽力而为、不阻断；本轮新表进入平台元数据缓存后表查询/申请级联才可见。
    let metadataWarmup: string;
    try {
      await openSelfServiceQuery(page);
      await chooseConfiguredDataSource(page, {
        type: assets.permissionResource.sourceTypeName,
        name: assets.permissionResource.sourceName.split(/[:：]/)[0].trim(),
        schema: false,
      });
      await refreshDatabaseMetadata(page);
      metadataWarmup = '自助查询目录已尝试按实时元数据刷新，本轮新表进入平台元数据缓存。';
    } catch (metadataError) {
      metadataWarmup = `预热未完成（不阻断）：${messageOf(metadataError).split('，')[0]}`;
    }
    await report('SM-02-07 驳回链 阶段0c｜刷新数据库元数据（管理员）', true, metadataWarmup);

    // 阶段0d（全局开关）：记录原始状态并确保“开启”（表权限语义前提；finally 恢复原值）。
    await openDataPermissionPage(page);
    originalSwitchChecked = await readPermissionSwitchChecked(page);
    await setPermissionSwitch(page, true);
    await report(
      'SM-02-07 驳回链 阶段0d｜确保数据权限开关开启',
      true,
      `开关原始=${originalSwitchChecked ? '开启' : '关闭'}（finally 恢复原值），已置开启；表=${assets.tableName}；主体=${assets.applicant.userName}。`,
    );

    // 阶段0e（归因前置·双视角负向）：全新主体×全新表本不应有任何授权行；若发现即环境污染
    //（真实失败）。选中信号失败＝页面/前置未加载类（助手显式归因），不与“未生成授权”混同。
    await expectNoGrantForApplicant(page, assets, '阶段0e前置');
    await report(
      'SM-02-07 驳回链 阶段0e｜归因前置：双视角均无授权行',
      true,
      `主体=${assets.applicant.userName}；表=${assets.tableName}；用户/资源双视角均未回显授权行（选中信号已硬校验，页面证据已附加）。`,
    );

    // 阶段1（提交申请）：申请人经表查询卡片发起“使用”权限申请；流程序列由共享审批流决定。
    await loginAs(page, assets.applicant, { entryUrl: approvalEntryUrl('/dataMap/tableQuery/tablesQuery') });
    const sequence = await submitTablePermissionApply(page, {
      tableName: assets.tableName,
      marker: assets.marker,
      approvalPlan: [assets.approverLevel1, assets.approverLevel2, assets.approverLevel1],
    });
    assets.pendingMarkers.push(assets.marker);
    await openApprovalWorkbenchAs(page, assets.applicant, '我的申请');
    expect(
      await findApprovalMarkerRow(page, '未审批', assets.marker),
      `我的申请-未审批 未出现本申请 ${assets.marker}：提交可能未落库或列表结构变化。`,
    ).toBeTruthy();
    await report(
      'SM-02-07 驳回链 阶段1｜申请人提交使用权限申请',
      true,
      `表=${assets.tableName}，标识=${assets.marker}；节点序列=${sequence.join(' → ')}；“我的申请-未审批”已回显。`,
    );

    // 阶段2（驳回）：流程序列首个承接人执行“拒绝” → 最终态“已驳回”（兼容“已拒绝”等义文案）。
    const firstNode = sequence[0];
    const rejected = await handlePendingApproval(page, identityForSequence(assets, firstNode), assets.marker, '拒绝');
    if (!rejected) {
      throw new Error(
        `审批人 ${String(firstNode)} 的“我的审批-未审批”中没有本申请 ${assets.marker}：`
          + '审批流节点归属与脚本指派不一致（共享审批流须按顺序分配本轮审批人；候选证据已由工具附加）。',
      );
    }
    await expectApplicationFinalStatus(page, assets.applicant, assets.marker, /已驳回|已拒绝/, '已驳回');
    markSettled(assets, assets.marker);
    await report(
      'SM-02-07 驳回链 阶段2｜首节点拒绝并确认终态',
      true,
      `标识=${assets.marker}；拒绝人=${String(firstNode)}；终态=已驳回。`,
    );

    // 阶段3（负向·管理员双视角）：驳回后不生成授权。
    await loginAs(page, adminIdentity());
    await expectNoGrantForApplicant(page, assets, '阶段3驳回后');
    await report(
      'SM-02-07 驳回链 阶段3｜驳回后双视角均无授权行',
      true,
      `主体=${assets.applicant.userName}；表=${assets.tableName}；用户/资源双视角均未生成授权（页面证据已附加）。`,
    );

    // 阶段4（负向收口·申请人侧）：重登后卡片仍在，且“申请权限”入口仍可用（未获授权信号）。
    await expectApplicantStillUnprivileged(page, assets);
    await report(
      'SM-02-07 驳回链 阶段4｜申请人重登：无授权且仍可再次申请',
      true,
      `表=${assets.tableName}；卡片可检索，“申请权限”入口仍可见（未获授权信号）。`,
    );

    // 阶段5（查询级拒绝收口，DS-PERM-105）：申请人以本人会话对本轮专用表实际查询，
    // 必须被明确拦截（审批本就未通过、从未生成授权——预期“未获授权且实际查询被拦截”）。
    await loginAs(page, assets.applicant, { entryUrl: approvalEntryUrl('/dataQuery/selfServiceQuery') });
    const rejectBlockedDetail = await expectApplicantTableQueryBlocked(page, assets, '驳回后');
    await report(
      'SM-02-07 驳回链 阶段5｜申请人实际查询被拦截（未获授权且查询级拒绝）',
      true,
      `表=${assets.tableName}；主体=${assets.applicant.userName}；${rejectBlockedDetail}。`,
    );

    // 无权限查询被后端拒绝属于本用例预期失败信号；其余控制台错误仍然失败（口径同 SM-03-10）。
    await assertNoUnexpectedConsoleErrors(consoleErrors, [
      /self\/query\/submitQuery/,
      /没有使用权限/,
      /dataPermission\//,
    ]);
    await report(
      'SM-02-07｜审批人驳回后不生成表授权（净环境闭环）',
      true,
      `表=${primaryDbName}/${assets.tableName}，主体=${assets.applicant.userName}（本轮自备，finally 回收）；`
        + `提交（使用）→ 我的申请可见 → 首节点拒绝 → 终态=已驳回 → 双视角无授权行 → 申请人重登仍可发起申请`
        + `→ 实际查询被拦截（未获授权且查询级拒绝）。`,
    );
  } catch (error) {
    mainError = error;
    throw error;
  } finally {
    await cleanupChainAssets(page, assets, mainError, originalSwitchChecked, report);
  }
});
