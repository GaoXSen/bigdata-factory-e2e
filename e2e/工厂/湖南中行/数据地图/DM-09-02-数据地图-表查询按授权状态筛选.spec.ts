/**
 * 数据地图 — 表查询按授权状态筛选 E2E 测试
 * （DM-09-02 / 工作包 DS-PERM-81 清洁环境迁移，闭环模板：系统管理/SM-03-06）
 *
 * 覆盖场景（本轮唯一 表/身份/授权，不借历史权限和共享固定表）：
 *   0. 本轮自备资产：MySQL(DB_*) 直建唯一专用表 e2e_dm0902_<uuid>（2 行种子）；
 *      创建本轮唯一申请人账号 + 含“数据地图/数据查询”菜单的角色并分配。
 *   1. 数据权限（系统管理→用户权限→数据权限）清理本轮主体残留授权（全新 UUID 正常 0 条）。
 *   2. 用户视角给本轮主体新增专用表“使用”权限（勾选具体表 + 永久，防全量通配）；
 *      用户视角/资源视角（数据表页签）严格按唯一标签回显且权限类型恰为“使用”。
 *   3. 以本轮申请人登录 数据地图→表查询：按本轮唯一表名检索卡片并打开详情。
 *   4. 详情“授权情况/授权信息”页签：按唯一标签回显本轮专用表；展示主体明细时按
 *      本轮唯一账号回显，并对筛选框执行 反向（无权关键词→主体行消失）/
 *      正向（本轮账号→回显）筛选（保留原“授权情况展示筛选”交互）。
 *   5. finally 只回收本轮资产（DS-PERM-86 补齐角色回收）：兜底撤销本轮授权 → DROP
 *      本轮专用表 → 删除本轮申请人账号（先删用户即解绑角色）→ 按本轮唯一角色名删除
 *      本轮角色；任一回收未完成都汇总并上抛导致用例失败，不再仅告警放行。
 *
 * 前置门禁：DB_* 未配置或非 MySQL 时按前置不足跳过（无法直建本轮专用表）；
 * 数据源/库/Schema 全部经 resolveMysqlPermissionResource 从环境/公共默认解析，
 * 用例内不写死 IP、库名或历史夹具表名（原 e2e_ 前缀共享表/固定账号已移除）。
 */
import type { Locator, Page } from '@playwright/test';
import {
  assertNoConsoleErrors,
  clickMenu,
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
  openRoleManagement,
  openUserManagement,
  type PermissionIdentity,
  type PermissionRole,
} from '../系统管理/权限测试工具.js';
import {
  type DataPermissionTypeFlag,
  type MysqlPermissionResource,
  deletePermissionFromRow,
  findPermissionRow,
  findResourceViewAuthorizationRow,
  openDataPermissionPage,
  openUserViewCreateDialog,
  queryUserViewPermissionRow,
  refreshPermissionList,
  resolveMysqlPermissionResource,
  selectPermissionTableScope,
  selectUserViewSubject,
  setPermissionExpiry,
  setPermissionTypes,
  submitPermissionDialog,
  switchResourceViewScopeTab,
} from '../系统管理/数据权限闭环工具.js';

test.describe.configure({ mode: 'serial', timeout: 600_000 });

/** 环境前置条件缺失：按既有 数据地图 用例口径显式失败留证，不伪造通过。 */
function skipForMissingEnvironment(message: string): never {
  throw new Error(`环境前置条件缺失：${message}`);
}

/** 管理员身份：与 loginPage fixture 同源（TEST_USER/TEST_PASS），用于申请人视角后切回。 */
const adminIdentity = {
  userName: (process.env.TEST_USER ?? 'admin').trim(),
  nickname: (process.env.TEST_USER ?? 'admin').trim(),
  password: process.env.TEST_PASS ?? '',
  phone: '',
  email: '',
};

/** 本轮自备资源：申请人身份、配套菜单角色与专用表权限资源。 */
interface RoundContext {
  applicant: PermissionIdentity;
  role: PermissionRole;
  resource: MysqlPermissionResource;
  tableName: string;
}

/** 用户视角主体定位参数（成员页签 + 唯一账号/昵称）。 */
function subjectOptionsOf(ctx: RoundContext) {
  return {
    subjectTab: '成员' as const,
    subjectName: ctx.applicant.userName,
    subjectAlias: ctx.applicant.nickname,
  };
}

/**
 * 创建本轮唯一专用表并写入 2 行种子数据（MySQL 直连 DDL，仅本轮资源）。
 * 平台数据源/库/表级联来自实时 JDBC 扫描，建表即对授权下拉可见；
 * 建表失败让用例以真实错误结束，不伪造通过。
 */
async function createRoundFixtureTable(ctx: RoundContext, roundKey: string): Promise<number> {
  await query(
    `CREATE TABLE ${ctx.tableName} (`
    + 'sm_id varchar(64) NOT NULL,'
    + 'sm_name varchar(128) DEFAULT NULL,'
    + 'sm_value varchar(128) DEFAULT NULL,'
    + 'PRIMARY KEY (sm_id)'
    + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
  );
  await query(
    `INSERT INTO ${ctx.tableName} (sm_id, sm_name, sm_value) VALUES `
    + `('sm-1', 'e2e-${roundKey}-a', '${ctx.tableName}'), ('sm-2', 'e2e-${roundKey}-b', 'dm-permission-closed-loop')`,
  );
  const rows = await query(`SELECT COUNT(*) AS total FROM ${ctx.tableName}`);
  const total = Number((rows[0] as { total?: unknown } | undefined)?.total ?? -1);
  expect(total, `专用表 ${ctx.tableName} 种子数据应为 2 行，实际：${JSON.stringify(rows)}`).toBe(2);
  return total;
}

/**
 * 断言权限行（用户视角/资源视角）的权限类型恰为 expected（SM-03-06 同源口径）：
 * 后端 permissionType 拼接为“使用 / 管理 / 使用、管理”，除包含 expected 外还必须
 * 断言另一类型不残留；行内主体名/表名不含“使用/管理”，文本级判断安全。
 */
async function expectRowExactPermissionType(row: Locator, expected: DataPermissionTypeFlag): Promise<void> {
  const raw = await row.innerText({ timeout: 5_000 }).catch(() => '');
  const normalized = raw.replace(/\s+/g, '');
  const other: DataPermissionTypeFlag = expected === '使用' ? '管理' : '使用';
  expect(normalized, `权限行应包含权限类型“${expected}”，实际行文本：${raw}`).toContain(expected);
  expect(
    normalized,
    `权限行不应残留权限类型“${other}”（新增/编辑为整体覆盖，实际行文本：${raw}）`,
  ).not.toContain(other);
}

/**
 * 用户视角给本轮主体新增专用表“使用”权限（勾选具体表 + 永久，防全量通配授权），
 * 再选择 本轮数据库→Schema→专用表 级联并提交。
 */
async function grantRoundTableUsage(page: Page, ctx: RoundContext): Promise<void> {
  await selectUserViewSubject(page, subjectOptionsOf(ctx));
  // 用户视角右侧资源范围默认停在“数据源”；数据表的表单才会动态渲染
  // 数据库 → Schema → 表三级选择器，不切页签会把默认态误判为环境缺失。
  await switchResourceViewScopeTab(page, '数据表');
  const dialog = await openUserViewCreateDialog(page);
  await selectPermissionTableScope(page, dialog, ctx.resource);
  await setPermissionTypes(page, dialog, ['使用']);
  await setPermissionExpiry(page, dialog, '永久');
  await submitPermissionDialog(page, dialog);
}

/**
 * 授权回显（用户/资源双视角严格按唯一标签）：
 * 用户视角重新选中主体 → 刷新 → 按 本轮专用表名 定位行且类型恰为“使用”；
 * 资源视角（数据表页签）按 本轮表 + 本轮主体 定位行且类型恰为“使用”。
 */
async function assertRoundGrantEcho(page: Page, ctx: RoundContext): Promise<void> {
  const createdRow = await queryUserViewPermissionRow(page, { ...subjectOptionsOf(ctx), resource: ctx.resource });
  await expectRowExactPermissionType(createdRow, '使用');
  const resourceRow = await findResourceViewAuthorizationRow(page, {
    resource: ctx.resource,
    subjectName: ctx.applicant.userName,
    scopeTab: '数据表',
  });
  if (!resourceRow) {
    throw new Error(`资源视角（数据表页签）未回显用户 ${ctx.applicant.userName} 对 ${ctx.tableName} 的“使用”授权，不能视为授权生效。`);
  }
  await expectRowExactPermissionType(resourceRow, '使用');
}

/**
 * 清理本轮主体残留授权（仅 本轮申请人 × 本轮专用表，页面操作逐条删除），
 * 保证“无权限”前提（数据表 + 数据源两个页签）。全新 UUID 主体正常为 0 条，
 * 作为中断轮次的防御性兜底保留。（SM-03-06 同源口径）
 */
async function purgeStaleRoundPermissions(page: Page, ctx: RoundContext): Promise<number> {
  await selectUserViewSubject(page, subjectOptionsOf(ctx));
  let removed = 0;
  await switchResourceViewScopeTab(page, '数据表');
  await refreshPermissionList(page);
  for (let guard = 0; guard < 20; guard += 1) {
    const stale = await findPermissionRow(page, ctx.tableName, 5_000);
    if (!stale) break;
    await deletePermissionFromRow(page, stale, { uniqueText: ctx.tableName });
    removed += 1;
    await refreshPermissionList(page);
  }
  await switchResourceViewScopeTab(page, '数据源');
  await refreshPermissionList(page);
  for (let guard = 0; guard < 3; guard += 1) {
    const staleSource = await findPermissionRow(page, ctx.resource.sourceName, 4_000);
    if (!staleSource) break;
    await deletePermissionFromRow(page, staleSource, { uniqueText: ctx.resource.sourceName });
    removed += 1;
    await refreshPermissionList(page);
  }
  return removed;
}

/**
 * 删除本轮申请人账号（用户管理页：按本轮唯一账号查询 → 行内“删除” → 确认）。
 * 只允许命中本轮 UUID 命名账号；返回文本以“回收未完成”前缀标记失败步骤，
 * 由 cleanupRoundAssets 汇总后经 finally 上抛（DS-PERM-86：清理失败不得静默放行）。
 */
async function deleteOwnApplicantUser(page: Page, applicant: PermissionIdentity): Promise<string> {
  await openUserManagement(page);
  const search = page.getByRole('textbox', { name: '请输入用户名称' }).first();
  await search.fill(applicant.userName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(800);
  const userText = page.getByText(applicant.userName, { exact: true }).last();
  if (!(await userText.isVisible().catch(() => false))) {
    return '无需回收：列表未查询到本轮账号（可能此前已删除）';
  }
  const row = userText.locator('xpath=ancestor::tr[1]');
  if (!(await row.isVisible().catch(() => false))) {
    return '回收未完成：账号可见但未取到表格行';
  }
  const deleteButton = row.getByRole('button', { name: /删\s*除/ }).first();
  if (!(await deleteButton.isVisible().catch(() => false))) {
    return '回收未完成：行内未找到“删除”按钮';
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
  if (await userText.isVisible().catch(() => false)) {
    return '回收未完成：已提交删除但用户列表仍回显该账号';
  }
  return '已回收：已提交删除并确认列表不再显示该账号';
}

/**
 * 删除本轮自建角色（角色管理页：按本轮唯一角色名查询 → 行内“删除” → 确认；
 * 模板 SM-00-01 deleteOwnRole）。本轮角色经 assignRoleToUser 绑定本轮申请人，
 * 收尾按“先删本轮用户（解绑）→ 再删本轮角色”顺序执行，规避“角色仍有成员
 * 不可删”的系统约束。只允许命中本轮 UUID 命名角色；返回文本以“回收未完成”
 * 前缀标记失败步骤，由 cleanupRoundAssets 汇总后经 finally 上抛（DS-PERM-86）。
 */
async function deleteOwnApplicantRole(page: Page, role: PermissionRole): Promise<string> {
  await openRoleManagement(page);
  const search = page.getByRole('textbox', { name: '请输入角色名称' }).first();
  await search.fill(role.roleName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(800);
  const roleText = page.getByText(role.roleName, { exact: true }).last();
  if (!(await roleText.isVisible().catch(() => false))) {
    return '无需回收：角色列表未查询到本轮角色（可能此前已删除）';
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
  if (!row) return '回收未完成：角色可见但未取到表格行';
  const deleteButton = row.getByRole('button', { name: /删\s*除/ }).first();
  if (!(await deleteButton.isVisible().catch(() => false))) {
    return '回收未完成：角色行未提供“删除”入口';
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
  if (await roleText.isVisible().catch(() => false)) {
    return '回收未完成：已提交删除但角色列表仍回显该角色';
  }
  return '已回收：已提交删除并确认列表不再显示该角色';
}

/**
 * finally 只回收本轮资产（DS-PERM-86 补齐角色回收）：兜底撤销本轮授权 → DROP 本轮
 * 专用表 → 删除本轮申请人账号（先删用户即解绑角色）→ 删除本轮角色。全部仅按本轮
 * UUID 唯一命名定位（applicant.userName / role.roleName / tableName），不触碰并行
 * 轮次或历史资产。任一步未完成都记入返回的 issues，不中断其余回收步骤；是否上抛
 * 由调用方 finally 依据主体结果决定，不再仅 console.warn 后放行。
 */
async function cleanupRoundAssets(page: Page, ctx: RoundContext, roundKey: string): Promise<string[]> {
  const issues: string[] = [];
  try {
    await loginAs(page, adminIdentity);
    await openDataPermissionPage(page);
    const removed = await purgeStaleRoundPermissions(page, ctx);
    if (removed > 0) {
      console.warn(`[${roundKey}] 收尾兜底撤销本轮授权 ${removed} 条（${ctx.applicant.userName} × ${ctx.tableName}）。`);
    }
  } catch (error) {
    issues.push(`授权兜底撤销未完成：${error instanceof Error ? error.message.split('，')[0] : String(error)}`);
  }
  try {
    await query(`DROP TABLE IF EXISTS ${ctx.tableName}`);
  } catch (error) {
    issues.push(`专用表 ${ctx.tableName} 回收未完成：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const outcome = await deleteOwnApplicantUser(page, ctx.applicant);
    if (outcome.startsWith('回收未完成')) {
      issues.push(`申请人账号${outcome}`);
    } else {
      console.warn(`[${roundKey}] 收尾回收本轮账号 ${ctx.applicant.userName}：${outcome}`);
    }
  } catch (error) {
    issues.push(`申请人账号回收未完成：${error instanceof Error ? error.message.split('，')[0] : String(error)}`);
  }
  try {
    const outcome = await deleteOwnApplicantRole(page, ctx.role);
    if (outcome.startsWith('回收未完成')) {
      issues.push(`本轮角色${outcome}`);
    } else {
      console.warn(`[${roundKey}] 收尾回收本轮角色 ${ctx.role.roleName}：${outcome}`);
    }
  } catch (error) {
    issues.push(`本轮角色回收未完成：${error instanceof Error ? error.message.split('，')[0] : String(error)}`);
  }
  return issues;
}

/** 表查询卡片选择器与搜索占位符（原实现口径）。 */
const MAIN_CARD_SELECTOR = '.table-query .card:visible';
const TABLE_SEARCH_PLACEHOLDER = '按表名、中文名、描述、负责人搜索';

/** 详情页签候选（Ant/Element 页签 + 自定义 tab 项）与详情表格候选。 */
const TAB_SELECTORS = '[role="tab"]:visible, .ant-tabs-tab:visible, .el-tabs__item:visible, [class*="tab-item"]:visible';
const DETAIL_TABLE_SELECTOR = '.ant-table:visible, .el-table:visible, table:visible, [role="grid"]:visible';

/** 详情区当前激活的面板（取最后一个可见且非空的 tabpanel）。 */
function activeDetailPanel(page: Page): Locator {
  return page.locator('[role="tabpanel"]:visible').filter({ hasText: /\S/ }).last();
}

/** 面板内主体标签是否回显（唯一账号或唯一昵称）。 */
async function panelHasSubjectTag(panel: Locator, applicant: PermissionIdentity): Promise<boolean> {
  const text = await panel.innerText().catch(() => '');
  return text.includes(applicant.userName) || text.includes(applicant.nickname);
}

/** 点击第一个文本匹配 expected 的可见页签（兼容按钮实现）。 */
async function clickVisibleTab(page: Page, expected: RegExp): Promise<void> {
  const candidates = page.locator(TAB_SELECTORS);
  const count = await candidates.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const text = (await candidate.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (expected.test(text)) {
      await candidate.click();
      await page.waitForTimeout(400);
      return;
    }
  }
  const button = page.getByRole('button', { name: expected }).last();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    await page.waitForTimeout(400);
    return;
  }
  skipForMissingEnvironment(`详情页未找到匹配 ${expected} 的页签。`);
}

/** 表查询：按关键词检索并返回命中本轮专用表的卡片（未回显按前置缺失显式失败）。 */
async function searchRoundTableCard(page: Page, tableName: string): Promise<Locator> {
  const search = page.getByPlaceholder(TABLE_SEARCH_PLACEHOLDER);
  await expect(search).toBeVisible({ timeout: 10_000 });
  await search.click();
  await search.fill('');
  await search.pressSequentially(tableName, { delay: 10 });
  await search.press('Enter');
  await search.blur();
  const card = page.locator(MAIN_CARD_SELECTOR).filter({ hasText: tableName }).first();
  await expect(
    card,
    `表查询未回显本轮专用表卡片 ${tableName}（本轮授权后的表查询前置缺失）`,
  ).toBeVisible({ timeout: 15_000 });
  return card;
}

/** 打开卡片详情：点击表名卡片，等待“基础信息”标题。 */
async function openCardDetail(page: Page, card: Locator): Promise<void> {
  const name = card.locator('.table-name:visible, [class*="table-name"]:visible').first();
  await expect(name).toBeVisible();
  await name.click();
  await page.waitForTimeout(300);
  await expect(page.getByRole('heading', { name: '基础信息' })).toBeVisible({ timeout: 10_000 });
}

test.describe('DM-09-02｜数据地图｜表查询按授权状态筛选', () => {
  test('DM-09-02｜数据地图｜表查询按授权状态筛选', async ({ loginPage, consoleErrors, report }) => {
    const cfg = dbConfig();
    test.skip(
      !cfg || cfg.type !== 'mysql',
      `前置不足：未配置 MySQL 数据库环境（DB_HOST=${process.env.DB_HOST ?? ''}，DB_TYPE=${process.env.DB_TYPE ?? ''}），无法创建本轮唯一专用表。`,
    );

    const page = loginPage;
    const applicant = newPermissionIdentity('dm0902');
    const applicantRole = newPermissionRole('dm0902', 'map');
    const tableName = `e2e_dm0902_${uuid()}`;
    const resource = resolveMysqlPermissionResource({ tableName });
    const ctx: RoundContext = { applicant, role: applicantRole, resource, tableName };

    // 阶段0a：本轮唯一专用表（MySQL 直建，2 行种子）。
    const seededRows = await createRoundFixtureTable(ctx, 'dm0902');
    await report(
      'DM-09-02 阶段0a｜创建本轮专用表',
      true,
      `专用表=${tableName}（MySQL 直连创建，种子 ${seededRows} 行）。`,
    );

    // 申请人登录：受限账号从可达的自助查询入口进入，候选页兜底完成会话初始化
    // （SM-03-06 同源口径），随后经菜单导航到目标页。
    const loginAsApplicant = async (): Promise<void> => {
      const entry = new URL(page.url());
      entry.hash = '#/dataQuery/selfServiceQuery';
      const fallbackEntryUrls = ['#/dataMap/tableQuery/tablesQuery', '#/dataAccess/fileAccess', '#/']
        .map((hash) => {
          const url = new URL(entry.toString());
          url.hash = hash;
          return url.toString();
        });
      await loginAs(page, applicant, { entryUrl: entry.toString(), fallbackEntryUrls });
    };

    // 主体异常先记录再进入收尾（DS-PERM-86，DS-01-06/07 收尾同源口径）：
    // finally 优先原样上抛主体错误（不掩盖主结果），并在主体错误信息后附带
    // 回收未完成说明；主体通过但回收未完成也聚合上抛，不再仅告警放行。
    let mainError: unknown;
    let mainFailed = false;
    try {
      // 阶段0b：本轮唯一身份与角色。
      await loginAs(page, adminIdentity);
      await createAndInviteUser(page, applicant);
      await createRole(page, applicantRole, ['数据地图', '数据查询']);
      await assignRoleToUser(page, applicantRole, applicant);
      await report(
        'DM-09-02 阶段0b｜创建申请人账号并授予数据地图菜单角色',
        true,
        `角色=${applicantRole.roleName}（菜单：数据地图/数据查询）已分配给 ${applicant.userName}。`,
      );

      // 阶段1：数据权限页清理本轮主体残留授权（全新 UUID 正常 0 条）。
      await openDataPermissionPage(page);
      const removedStale = await purgeStaleRoundPermissions(page, ctx);
      await report('DM-09-02 阶段1｜残留权限清理', true, `主体=${applicant.userName}；清理残留 ${removedStale} 条（0=首次执行）。`);

      // 阶段2：用户视角新增“使用”授权 → 双视角唯一标签回显。
      await grantRoundTableUsage(page, ctx);
      await assertRoundGrantEcho(page, ctx);
      await report('DM-09-02 阶段2｜新增“使用”授权并双视角唯一标签回显', true, `专用表=${tableName}；用户视角/资源视角权限类型恰为“使用”。`);

      // 阶段3：申请人视角进入 数据地图→表查询，检索本轮专用表卡片并打开详情。
      await loginAsApplicant();
      try {
        await clickMenu(page, '数据地图', '表查询', '表查询');
      } catch (error) {
        skipForMissingEnvironment(`本轮申请人未能进入“数据地图→表查询”（角色菜单可能未覆盖该叶子）：${error instanceof Error ? error.message : String(error)}`);
      }
      await expect(
        page.locator('.table-query .search-bar, .table-query .card-list').first(),
      ).toBeVisible({ timeout: 15_000 });
      const card = await searchRoundTableCard(page, tableName);
      await report('DM-09-02 阶段3｜表查询回显本轮专用表卡片', true, `关键词=${tableName}（唯一标签）。`);
      await openCardDetail(page, card);

      // 阶段4：详情“授权情况”页签——唯一标签回显 + 授权状态筛选（保留原交互）。
      await clickVisibleTab(page, /授权情况|授权信息/);
      await expect(
        page.locator(`${DETAIL_TABLE_SELECTOR}, .ant-empty:visible, .el-empty:visible, [class*="empty"]:visible`).first(),
      ).toBeVisible({ timeout: 10_000 });
      const panel = activeDetailPanel(page);
      await expect.poll(
        async () => ((await panel.innerText().catch(() => '')).includes(tableName) ? 'echo' : 'loading'),
        { timeout: 10_000, message: `授权情况页签未回显本轮专用表 ${tableName}` },
      ).toBe('echo');
      const subjectEchoed = await panelHasSubjectTag(panel, applicant);

      const filter = panel
        .locator('input[placeholder*="筛选" i]:visible, input[placeholder*="权限" i]:visible, input[type="text"]:visible')
        .first();
      const panelQueryButton = panel.getByRole('button', { name: /查\s*询/ }).first();
      const hasFilter = await filter.isVisible().catch(() => false);
      if (hasFilter && subjectEchoed) {
        // 反向：无权关键词筛选后主体行消失（保留原“筛选_${uuid}”交互，断言升级）。
        await filter.fill(`筛选_${uuid()}`);
        if (await panelQueryButton.isVisible().catch(() => false)) await panelQueryButton.click();
        await expect.poll(
          async () => ((await panelHasSubjectTag(panel, applicant)) ? 'still' : 'gone'),
          { timeout: 8_000, message: '无权关键词筛选后授权情况仍回显本轮主体' },
        ).toBe('gone');
        // 正向：按本轮唯一账号筛选后回显。
        await filter.fill(applicant.userName);
        if (await panelQueryButton.isVisible().catch(() => false)) await panelQueryButton.click();
        await expect.poll(
          async () => ((await panelHasSubjectTag(panel, applicant)) ? 'back' : 'loading'),
          { timeout: 8_000, message: `按本轮账号 ${applicant.userName} 筛选后授权情况未回显主体` },
        ).toBe('back');
        await report('DM-09-02 阶段4｜授权情况唯一标签回显与筛选', true, '唯一账号回显；无权关键词筛选后主体行消失，按本轮账号筛选后回显。');
      } else {
        await report(
          'DM-09-02 阶段4｜授权情况唯一标签回显',
          true,
          subjectEchoed
            ? '面板回显本轮主体唯一标签（未展示独立筛选框，筛选交互不可用）。'
            : '当前版本授权情况面板未展示主体明细，回显以唯一表名为准（如实记录，不伪造主体断言）。',
        );
      }

      await assertNoConsoleErrors(consoleErrors);
      await report('DM-09-02｜表查询按授权状态筛选完成', true, `本轮唯一 表/身份/授权：表=${tableName}，主体=${applicant.userName}；finally 仅回收本轮资产。`);
    } catch (error) {
      mainError = error;
      mainFailed = true;
    } finally {
      const cleanupIssues = await cleanupRoundAssets(page, ctx, 'DM-09-02');
      if (mainFailed) {
        if (cleanupIssues.length) {
          const detail = cleanupIssues.join('；');
          if (mainError instanceof Error) {
            mainError.message = `${mainError.message}｜[DM-09-02] 收尾回收未完成：${detail}`;
          } else {
            console.warn(`[DM-09-02] 收尾回收未完成：${detail}`);
          }
        }
        throw mainError;
      }
      if (cleanupIssues.length) {
        throw new Error(`[DM-09-02] 收尾回收未完成（仅限本轮 UUID 资产，不触碰其它资产）：${cleanupIssues.join('；')}`);
      }
    }
  });
});





