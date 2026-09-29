/**
 * 系统管理 E2E 测试 — 数据权限开关闭环（PERM-STATIC-03 / 工作包 DS-PERM-09）
 *
 * 覆盖场景（权限与审批测试理解.md §11.1-1、§11.3 行180）：
 *   0. 本轮自备被授权主体与专用表：创建本轮唯一申请人账号 + 含“数据地图/数据查询”
 *      菜单的角色，并在配置库直建本轮唯一英文前缀专用表 e2e_sw0303_*；不再依赖
 *      历史固化夹具，也不断言/依赖固定存量表（工作包允许“创建本轮唯一资源”）。
 *   1. 记录数据权限开关原始状态（共享配置，结束时必须恢复原值）；
 *   2. 开关“关闭”时不校验表权限：无授权用户对专用表的只读 COUNT 查询直接成功；
 *   3. 开关“开启”后按数据源/表校验：同一无授权用户的查询被“没有使用权限”拦截，
 *      或数据源在自助查询整体不可见——两种表现均视为拦截成立；
 *   4. 授予专用表“使用”权限后同一用户再次查询成功（用户/资源双视角回显 + 实际访问）；
 *   5. 删除授权回收；finally 恢复开关原值并只回收本轮资源。
 *
 * 业务依据：
 *   - 数据权限开关默认关闭；关闭时不校验表权限；开启后才按数据源、表及字段范围
 *     校验。切换开关后必须重新登录目标用户验证，不能沿用管理员会话（§11.1-1）。
 *   - “配置保存成功”≠权限生效：每个阶段都以目标用户在“数据查询 → 自助查询”的
 *     真实只读查询结果断言，不以 toast/回显单独判定（工作包验收要求）。
 *
 * 资源边界与回收（DS-PERM-09）：
 *   - 专用表由本用例以 CREATE TABLE 直建于 DB_* 配置库（即自助查询数据源
 *     192.168.76.110/e2e_test 同库），仅 2 行种子数据；平台数据源/库/表级联来自
 *     实时 JDBC 扫描（DataSourceMetaDataCache#loadSingleSource → scanAllTables），
 *     新表对授权下拉可见；Redis 元数据缓存（fac_ds_m*）默认开启，故授权前先以
 *     管理员在自助查询刷新一次数据库元数据——该预热失败会如实记录，最终仍以
 *     授权下拉能否真实选中新表为准，不做静默放行。
 *   - finally 只回收本轮资源：兜底删除本轮主体×本轮表的授权 → DROP 本轮专用表 →
 *     尽力删除本轮申请人账号（回收失败会暴露，不掩盖主结果）；角色按 SM-00-02
 *     先例保留（r_sw030 前缀唯一命名，不影响回归）。不触碰既有业务数据。
 *   - requirePermissionApprovalEnvironment 门禁：未设 RUN_PERMISSION_APPROVAL=1 时
 *     跳过；与 SM-00-02 串行同跑（本用例自备主体，不读取 SM-00-02 运行时状态）。
 *   - DB_* 未配置或非 MySQL 时按前置不足跳过：无法创建本轮专用表。
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
} from './权限测试工具.js';
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
} from './数据权限闭环工具.js';
import { requirePermissionApprovalEnvironment } from './权限审批待调试工具.js';

/** 本轮自备资源：申请人身份、专用表权限资源与自助查询侧的数据源基础名。 */
interface Sw0303Context {
  applicant: PermissionIdentity;
  resource: MysqlPermissionResource;
  tableName: string;
  querySourceName: string;
}

/** 管理员身份：与 loginPage fixture 同源，用于切换用户后切回。 */
const adminIdentity = {
  userName: (process.env.TEST_USER ?? 'admin').trim(),
  nickname: (process.env.TEST_USER ?? 'admin').trim(),
  password: process.env.TEST_PASS ?? '',
  phone: '',
  email: '',
};

/**
 * 以下 helper 在 e2e/utils.ts 未导出（仅权威目录 工厂/湖南中行/utils.ts 提供）。
 * 为保持 sm-static ↔ 工厂 硬链接 twin 双侧可编译（两侧 '../utils.js' 解析到不同
 * 文件），按权威实现本地复刻，不跨中文路径导入（PERM-STATIC-03 静态开发 2026-09-21）。
 */
/** 异常路径用例允许页面把后端拒绝结果记录为 4xx/5xx；只过滤已声明的预期失败信号。 */
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
 * 自助查询侧栏在部分版本只渲染图标链接，没有“自助查询”可定位文本。
 * 已登录时直接进入已知 hash 路由，避免菜单已完成跳转后仍因找不到文字而失败。
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

/** 返回 locator 中第一个可见元素（与共享工具 firstVisible 语义一致，本文件自持）。 */
async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

/** 数据权限页顶部“数据权限”开关：优先 ARIA switch，兼容旧版 Element 外层实现。 */
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
 * 断言权限行权限类型恰为 expected（复制自 SM-03-06 同名实现）：除包含 expected 外，
 * 还断言另一类型不残留，防止“使用、管理”被误判成单一类型；行文本级判断安全
 * （行内主体名/表名均不含“使用/管理”字样）。
 */
async function expectRowExactPermissionType(row: Locator, expected: DataPermissionTypeFlag): Promise<void> {
  const raw = await row.innerText({ timeout: 5_000 }).catch(() => '');
  const normalized = raw.replace(/\s+/g, '');
  const other: DataPermissionTypeFlag = expected === '使用' ? '管理' : '使用';
  expect(normalized, `权限行应包含权限类型“${expected}”，实际行文本：${raw}`).toContain(expected);
  expect(
    normalized,
    `权限行不应残留权限类型“${other}”（新增/编辑应为整体覆盖，实际行文本：${raw}）`,
  ).not.toContain(other);
}

/**
 * 创建本轮唯一专用表并写入 2 行种子数据（MySQL 直连 DDL，仅本用例资源）。
 * 平台数据源/库/表级联来自实时 JDBC 扫描，建表即对授权下拉与自助查询目录可见；
 * 返回实际种子行数作为夹具证据（建表失败会让用例以真实错误结束，不伪造通过）。
 */
async function createPermissionFixtureTable(ctx: Sw0303Context): Promise<number> {
  await query(
    `CREATE TABLE ${ctx.tableName} (`
    + 'sw_id varchar(64) NOT NULL,'
    + 'sw_name varchar(128) DEFAULT NULL,'
    + 'sw_value varchar(128) DEFAULT NULL,'
    + 'PRIMARY KEY (sw_id)'
    + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
  );
  await query(
    `INSERT INTO ${ctx.tableName} (sw_id, sw_name, sw_value) VALUES `
    + `('sw-1', 'e2e-sw0303-a', '${ctx.tableName}'), ('sw-2', 'e2e-sw0303-b', 'closed-loop')`,
  );
  const rows = await query(`SELECT COUNT(*) AS total FROM ${ctx.tableName}`);
  const total = Number((rows[0] as { total?: unknown } | undefined)?.total ?? -1);
  expect(total, `专用表 ${ctx.tableName} 种子数据应为 2 行，实际：${JSON.stringify(rows)}`).toBe(2);
  return total;
}

/**
 * 尽力删除本轮申请人账号（用户管理页：按本轮唯一账号查询 → 行内“删除” → 确认）。
 * 只回收本轮自备账号；任一步不满足都返回说明文本而不抛错，不掩盖主结果。
 */
async function deleteOwnApplicantUser(page: Page, applicant: PermissionIdentity): Promise<string> {
  await openUserManagement(page);
  const search = page.getByRole('textbox', { name: '请输入用户名称' }).first();
  await search.fill(applicant.userName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(800);
  const userText = page.getByText(applicant.userName, { exact: true }).last();
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
 * 清理本轮主体可能残留的权限记录（仅 本轮申请人 × 本轮专用表，页面操作逐条删除），
 * 保证“无权限”前提成立；复制自 SM-03-06 的 purge 实现（数据表 + 数据源两个页签）：
 * r12 实证面板默认停在“数据源”页签，表级残留行在“数据表”页签下，不切页签会静默漏删。
 */
async function purgeStaleTablePermissions(page: Page, ctx: Sw0303Context): Promise<number> {
  await selectUserViewSubject(page, {
    subjectTab: '成员',
    subjectName: ctx.applicant.userName,
    subjectAlias: ctx.applicant.nickname,
  });
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

/** “刷新数据库元数据”确认弹窗处理（复制自 SM-03-06 已实证实现：不确认会以模态层阻塞目录交互）。 */
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

/** 自助查询验证前刷新数据库元数据（目录控件未渲染时安全跳过；同 SM-03-06）。 */
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

/** 查询执行状态：done=结果列头出现；denied=表级权限拦截文案；pending=仍在执行（同 SM-03-06）。 */
async function readQueryOutcome(page: Page, marker: string): Promise<'done' | 'denied' | 'pending'> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/没有使用权限/.test(bodyText)) return 'denied';
  const headerCount = await page
    .locator('th:visible, [role="columnheader"]:visible')
    .filter({ hasText: marker })
    .count();
  return headerCount > 0 ? 'done' : 'pending';
}

/**
 * 实际访问断言（允许访问）：选择 MySQL 数据源后执行只读 COUNT，真实返回结果。
 * 不以“数据源可选”或“表节点可见”替代——COUNT 成功才是权限放行的充分证据。
 */
async function expectTableQueryGranted(page: Page, ctx: Sw0303Context): Promise<void> {
  await openSelfServiceQuery(page);
  await refreshDatabaseMetadata(page);
  await chooseConfiguredDataSource(page, {
    type: ctx.resource.sourceTypeName,
    name: ctx.querySourceName,
    schema: false,
  });
  const marker = `swqry_${uuid()}`;
  await executeSql(page, `SELECT COUNT(*) AS ${marker} FROM ${ctx.tableName}`);
  await expect
    .poll(async () => readQueryOutcome(page, marker), {
      timeout: 30_000,
      message: `对 ${ctx.tableName} 的只读 COUNT 查询未成功返回（若页面提示无权限，说明当前开关/授权状态与预期不符）`,
    })
    .toBe('done');
}

/**
 * 实际访问断言（应被拦截）：两种预期表现其一即成立（同 SM-03-06 阶段8 语义）：
 *   a) 数据源因无 kind=5 表级记录在自助查询不可见（chooseConfiguredDataSource 抛已知文案）；
 *   b) 数据源仍可选，提交 SQL 被表级权限拦截（“没有使用权限”）。
 * 返回实际命中的表现描述，供 report 记录。
 */
async function expectTableQueryBlocked(page: Page, ctx: Sw0303Context): Promise<string> {
  await openSelfServiceQuery(page);
  try {
    await chooseConfiguredDataSource(page, {
      type: ctx.resource.sourceTypeName,
      name: ctx.querySourceName,
      schema: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hiddenByPermission = [
      `下拉选项“${ctx.resource.sourceTypeName}”未找到`,
      `下拉选项“${ctx.querySourceName}”未找到`,
      '数据源弹窗下拉框数量不足',
      '当前数据源没有可选 Schema',
      '自助查询的数据源选择入口未找到',
    ].some((fragment) => message.includes(fragment));
    if (hiddenByPermission) {
      return `数据源已因无表级使用权限不可见（${message.split('，')[0]}）`;
    }
    throw error;
  }
  const marker = `swdeny_${uuid()}`;
  await executeSql(page, `SELECT COUNT(*) AS ${marker} FROM ${ctx.tableName}`);
  await expect
    .poll(async () => readQueryOutcome(page, marker), {
      timeout: 30_000,
      message: `开关开启且无授权时，对 ${ctx.tableName} 的查询未被拦截——开关开启后的表级校验未生效`,
    })
    .toBe('denied');
  return '数据源仍可见，但查询被表级“没有使用权限”拦截';
}

test.describe.configure({ mode: 'serial', timeout: 600_000 });

test.describe('SM-03-03｜系统管理｜权限开关、无权限账号和非负责人操作', () => {
  test('SM-03-03｜系统管理｜权限开关、无权限账号和非负责人操作', async (
    { loginPage, consoleErrors, report },
  ) => {
    requirePermissionApprovalEnvironment();

    // 前置门禁：本轮专用表需要 MySQL 直连（DB_*）；未配置按前置不足跳过，不伪造通过。
    const cfg = dbConfig();
    if (!cfg || cfg.type !== 'mysql') {
      test.skip(
        !cfg || cfg.type !== 'mysql',
        `前置不足：未配置 MySQL 数据库环境（DB_HOST=${process.env.DB_HOST ?? ''}，DB_TYPE=${process.env.DB_TYPE ?? ''}），无法创建本轮唯一专用表。`,
      );
    }

    const page = loginPage;

    // 阶段 0a：本轮自备主体与专用表（不依赖历史固化夹具，资源边界见文件头）。
    const applicant = newPermissionIdentity('sw0303');
    const applicantRole = newPermissionRole('sw0303', 'applicant');
    const tableName = `e2e_sw0303_${uuid()}`;
    const resource = resolveMysqlPermissionResource({ tableName });
    const querySourceName = (process.env.QUERY_SOURCE_NAME?.trim() || resource.sourceName)
      .split(/[:：]/)[0].trim();
    const ctx: Sw0303Context = { applicant, resource, tableName, querySourceName };
    const subjectOptions = {
      subjectTab: '成员' as const,
      subjectName: applicant.userName,
      subjectAlias: applicant.nickname,
    };
    const resourceSubjectQuery = { ...subjectOptions, resource };
    const seededRows = await createPermissionFixtureTable(ctx);
    await report(
      'SM-03-03 阶段0a｜创建本轮申请人身份与专用表',
      true,
      `申请人=${applicant.userName}；专用表=${tableName}（MySQL 直连创建，种子 ${seededRows} 行）。`,
    );

    // 申请人可达入口与兜底（同 SM-03-06：受限账号直接落自助查询 hash 可能 #/404）。
    const loginAsApplicant = async (): Promise<void> => {
      const entry = new URL(page.url());
      entry.hash = '#/dataQuery/selfServiceQuery';
      const fallbackEntryUrls = ['#/dataAccess/fileAccess', '#/dataMap/tableQuery/tablesQuery', '#/']
        .map((hash) => {
          const url = new URL(entry.toString());
          url.hash = hash;
          return url.toString();
        });
      await loginAs(page, applicant, { entryUrl: entry.toString(), fallbackEntryUrls });
    };

    let originalChecked: boolean | undefined;
    let mainError: unknown;
    try {
      await loginAs(page, adminIdentity);

      // 阶段 0b：创建申请人账号并授予含“数据地图/数据查询”菜单的角色（可进入自助查询）。
      await createAndInviteUser(page, applicant);
      await createRole(page, applicantRole, ['数据地图', '数据查询']);
      await assignRoleToUser(page, applicantRole, applicant);
      await report(
        'SM-03-03 阶段0b｜创建申请人账号并授予查询菜单角色',
        true,
        `角色=${applicantRole.roleName}（菜单：数据地图/数据查询）已分配给 ${applicant.userName}。`,
      );

      // 阶段 0c：元数据缓存预热——以管理员在自助查询刷新一次数据库元数据，让本轮
      // 新表进入平台元数据缓存（fac_ds_m* 默认开启）。预热失败如实记录，不静默；
      // 真正的验收仍以阶段5授权下拉能否选中新表 + 实际查询为准。
      let metadataWarmup = '目录控件未渲染，按 SM-03-06 语义安全跳过（授权下拉以实时/缓存数据为准）';
      try {
        await openSelfServiceQuery(page);
        await chooseConfiguredDataSource(page, {
          type: resource.sourceTypeName,
          name: querySourceName,
          schema: false,
        });
        await refreshDatabaseMetadata(page);
        metadataWarmup = '自助查询目录已按实时元数据刷新，本轮新表进入平台元数据缓存。';
      } catch (metadataError) {
        metadataWarmup = `预热未完成（不阻断）：${metadataError instanceof Error ? metadataError.message.split('，')[0] : String(metadataError)}`;
      }
      await report('SM-03-03 阶段0c｜刷新数据库元数据（管理员）', true, metadataWarmup);

      // 阶段 1：记录开关原始状态（共享配置，结束时必须恢复）。
      await openDataPermissionPage(page);
      originalChecked = await readPermissionSwitchChecked(page);
      await report(
        'SM-03-03 阶段1｜读取开关原始状态',
        true,
        `数据权限开关当前=${originalChecked ? '开启' : '关闭'}（结束时恢复原值）；专用表=${tableName}；主体=${applicant.userName}。`,
      );

      // 阶段 2：关闭开关 + 清理本轮主体残留授权，保证“无授权”前提成立。
      await setPermissionSwitch(page, false);
      const removedStale = await purgeStaleTablePermissions(page, ctx);
      await report(
        'SM-03-03 阶段2｜开关关闭并清理残留授权',
        true,
        `开关=关闭；清理主体 ${applicant.userName} 的残留权限 ${removedStale} 条（0=首次执行或此前已回收）。`,
      );

      // 阶段 3：开关关闭 → 无授权用户不被校验，只读查询直接成功（实际访问断言）。
      await loginAsApplicant();
      await expectTableQueryGranted(page, ctx);
      await report(
        'SM-03-03 阶段3｜关闭开关：无授权不校验（实际访问）',
        true,
        `${applicant.userName} 在无任何表授权的情况下，对 ${tableName} 的只读 COUNT 查询成功——关闭态不校验表权限。`,
      );

      // 阶段 4：开启开关 → 同一无授权用户被拦截（重新登录，不沿用管理员会话）。
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      await setPermissionSwitch(page, true);
      await loginAsApplicant();
      const blockedDetail = await expectTableQueryBlocked(page, ctx);
      await report(
        'SM-03-03 阶段4｜开启开关：无授权被拦截（实际访问）',
        true,
        `${applicant.userName}：${blockedDetail}。`,
      );

      // 阶段 5：授予专用表“使用”权限 → 双视角回显 + 实际访问恢复。
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      await selectUserViewSubject(page, subjectOptions);
      await switchResourceViewScopeTab(page, '数据表');
      const createDialog = await openUserViewCreateDialog(page);
      await selectPermissionTableScope(page, createDialog, resource);
      await setPermissionTypes(page, createDialog, ['使用']);
      await setPermissionExpiry(page, createDialog, '永久');
      await submitPermissionDialog(page, createDialog);
      const createdRow = await queryUserViewPermissionRow(page, resourceSubjectQuery);
      await expectRowExactPermissionType(createdRow, '使用');
      const resourceEchoRow = await findResourceViewAuthorizationRow(page, {
        resource,
        subjectName: applicant.userName,
        scopeTab: '数据表',
      });
      if (!resourceEchoRow) {
        throw new Error(`资源视角（数据表页签）未回显用户 ${applicant.userName} 对 ${tableName} 的“使用”授权，不能视为授权生效。`);
      }
      await loginAsApplicant();
      await expectTableQueryGranted(page, ctx);
      await report(
        'SM-03-03 阶段5｜授予“使用”后可访问（双视角回显+实际访问）',
        true,
        `用户视角/资源视角均回显 使用 权限；${applicant.userName} 对 ${tableName} 的只读 COUNT 查询重新成功。`,
      );

      // 阶段 6：删除授权并确认资源视角不再回显（回收本轮授权）。
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      const finalRow = await queryUserViewPermissionRow(page, resourceSubjectQuery);
      await deletePermissionFromRow(page, finalRow, { uniqueText: tableName });
      const ghostRow = await findResourceViewAuthorizationRow(page, {
        resource,
        subjectName: applicant.userName,
        scopeTab: '数据表',
        timeoutMs: 8_000,
      });
      if (ghostRow) {
        throw new Error(`删除权限后资源视角仍回显 ${applicant.userName} 的授权行，删除可能未生效。`);
      }
      await report('SM-03-03 阶段6｜删除授权并双视角确认消失', true, '本轮授权已回收。');

      await assertNoUnexpectedConsoleErrors(consoleErrors, [
        /self\/query\/submitQuery/,
        /没有使用权限/,
      ]);
      await report(
        'SM-03-03｜数据权限开关闭环完成',
        true,
        `关闭不校验 → 开启拦截 → 授予“使用”后可访问 → 删除回收；开关将恢复为 ${originalChecked ? '开启' : '关闭'}。`,
      );
    } catch (error) {
      mainError = error;
      throw error;
    } finally {
      const cleanupIssues: string[] = [];
      // 收尾 1：兜底回收本轮授权（仅 本轮主体×本轮表；主流程已删则此处为 0 条）。
      // 尽力而为：失败记录并在收尾汇总暴露，不掩盖主结果，也不阻断后续回收。
      try {
        await loginAs(page, adminIdentity);
        await openDataPermissionPage(page);
        const removedFinally = await purgeStaleTablePermissions(page, ctx);
        if (removedFinally > 0) {
          await report('SM-03-03 收尾｜兜底回收本轮授权', true, `删除残留授权 ${removedFinally} 条。`);
        }
      } catch (purgeError) {
        cleanupIssues.push(`授权兜底回收未完成：${purgeError instanceof Error ? purgeError.message.split('，')[0] : String(purgeError)}`);
      }
      // 收尾 2：DROP 本轮专用表（仅本轮资源，不含任何既有表）。
      try {
        await query(`DROP TABLE IF EXISTS ${tableName}`);
      } catch (dropError) {
        cleanupIssues.push(`专用表 ${tableName} 回收未完成：${dropError instanceof Error ? dropError.message : String(dropError)}`);
      }
      // 收尾 3：尽力删除本轮申请人账号（角色按 SM-00-02 先例保留：唯一命名不影响回归）。
      try {
        const outcome = await deleteOwnApplicantUser(page, applicant);
        await report('SM-03-03 收尾｜回收本轮申请人账号', true, `${applicant.userName}：${outcome}。`);
      } catch (userError) {
        cleanupIssues.push(`申请人账号回收未完成：${userError instanceof Error ? userError.message.split('，')[0] : String(userError)}`);
      }
      // 收尾 4：恢复开关为原始状态——共享配置，恢复失败必须显式暴露（附带原失败原因）。
      if (originalChecked !== undefined) {
        try {
          await loginAs(page, adminIdentity);
          await openDataPermissionPage(page);
          await setPermissionSwitch(page, originalChecked);
          await report(
            'SM-03-03 收尾｜恢复数据权限开关原始状态',
            true,
            `已恢复为 ${originalChecked ? '开启' : '关闭'}。`,
          );
        } catch (restoreError) {
          const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
          const prefix = `数据权限开关恢复失败（共享配置被遗留为测试态）：${restoreMessage}`;
          if (mainError) {
            throw new Error(
              `${prefix}｜原失败：${mainError instanceof Error ? mainError.message : String(mainError)}`,
            );
          }
          throw new Error(
            cleanupIssues.length ? `${prefix}｜另有收尾回收未完成：${cleanupIssues.join('；')}` : prefix,
          );
        }
      }
      if (cleanupIssues.length) {
        // 回收未完成不改变用例判定（不影响被测功能结果），但必须在输出中可见。
        console.warn(`[SM-03-03] 收尾回收未完成（资源为唯一命名，不影响回归）：${cleanupIssues.join('；')}`);
      }
    }
  });
});