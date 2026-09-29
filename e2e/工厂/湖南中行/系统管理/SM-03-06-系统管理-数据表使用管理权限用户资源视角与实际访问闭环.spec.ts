/**
 * 系统管理 E2E 测试 — 数据表使用/管理权限用户资源视角与实际访问闭环
 * （SM-03-06 / 工作包 DS-PERM-13 清洁环境校准，模板：SM-03-03）
 *
 * 覆盖场景（“使用/管理”权限全生命周期，业务断言与改版前一一对应、不缩水）：
 *   0. 本轮自备被授权主体与专用表：创建本轮唯一申请人账号 + 含“数据地图/数据查询”
 *      菜单的角色，并在 DB_* 配置库（MySQL 110/e2e_test）直建本轮唯一英文前缀专用表
 *      e2e_sw0306_*（2 行种子数据）；不再依赖 SM-00-01 固化用户与 BL-00-00 固化表。
 *   1. 记录数据权限开关原始状态并强制置“开启”（共享配置，结束时恢复原值）：
 *      “删除权限后查询被拦截”等断言仅在开关开启时成立（权限与审批测试理解 §11.1-1），
 *      不依赖环境遗留状态。
 *   2. 清理本轮主体残留授权（全新 UUID 主体正常为 0 条），保证“无授权”前提。
 *   3. 用户视角新增专用表“使用”权限（勾选具体表 + 永久，防全量通配）→ 用户视角回显
 *      恰为“使用”；资源视角（数据表页签）同样回显“使用”。
 *   4. 被授权用户实际访问：自助查询目录可见专用表，且只读 COUNT 真实返回结果。
 *   5. 管理权限实际操作：编辑对话框把权限整体改为“管理”（permissionList 整体覆盖），
 *      用户/资源双视角回显恰为“管理”且“使用”不残留。
 *   6. 删除授权回收：双视角均不再回显。
 *   7. 删除后被授权用户实际访问被拦截：数据源不可见或表级“没有使用权限”二态其一。
 *   8. finally 只回收本轮资源并恢复开关原值；收尾任一步失败均逐项收集并在用例结尾
 *      统一裁决（DS-PERM-92）：主体成功 + 收尾未完成必须失败；主体失败保留原始错误
 *      实例并附加收尾证据后原样重抛。
 *
 * 业务依据：
 *   - 权限类型“使用/管理”编辑为 permissionList 整体覆盖：回显须断言“恰为 expected”，
 *     防止“使用、管理”被误判成单一类型（行内主体名/表名不含“使用/管理”，文本级判断安全）。
 *   - 删除 kind=5 表级记录后，数据源“可使用”失去依据：数据源在自助查询不可见，或查询
 *     被“【表名】数据表没有使用权限，请确认”拦截（glm5.3-01 §3 生效点 B），两态其一即成立。
 *   - “配置保存成功”≠权限生效：阶段 4/7 均以目标用户在“数据查询 → 自助查询”的真实只读
 *     查询结果断言，不以 toast/回显单独判定。
 *
 * 资源边界与回收（DS-PERM-13）：
 *   - 专用表由本用例以 CREATE TABLE 直建于 DB_* 配置库（即自助查询数据源同库）；平台
 *     数据源/库/表级联来自实时 JDBC 扫描，新表对授权下拉可见；Redis 元数据缓存
 *     （fac_ds_m*）默认开启，故授权前先以管理员在自助查询刷新一次数据库元数据（预热
 *     失败如实记录，不静默放行）。
 *   - finally 只回收本轮资源：兜底删除本轮主体×本轮表/源授权 → 删除本轮唯一数据源
 *     （级联回收创建人授权，DS-PERM-82）→ DROP 本轮专用表 → 删除本轮申请人账号 →
 *     删除本轮申请人角色（DS-PERM-82）→ 恢复数据权限开关原值（共享配置遗留为测试态
 *     属最高优先级污染）。收尾任一步失败均逐项收集、不阻断其余回收（DS-PERM-92）：
 *     主体成功 + 收尾未完成必须失败；主体失败保留原始错误并附加收尾证据。不触碰既有业务数据。
 *   - requirePermissionApprovalEnvironment 门禁：未设 RUN_PERMISSION_APPROVAL=1 跳过；
 *     DB_* 未配置或非 MySQL 时按前置不足跳过：无法创建本轮专用表。
 *   - 目录树定位收敛（对 r5-r13 实证的取舍）：保留 Schema/“数据表”分组双实现展开、目录
 *     搜索框兜底（r6 实证 fill+Enter 触发服务端搜索，可越过虚拟滚动）与
 *     dataSourceSchemaMetadata 非 2xx 监听（目录不渲染类产品缺陷的直接证据）；剔除仅服务
 *     旧固化表环境的诊断转储（滚屏遍历、schema 节点 DOM 转储、树行转储）。表可见与
 *     COUNT 成功仍为硬断言，诊断信息并入失败消息。
 *   - 本轮唯一数据源（DS-PERM-82）：不再复用历史/共享数据源——阶段 0b2 以管理员新建
 *     唯一源 e2esm0306ds_*（JDBC 指向配置中心 DB_* 库），授权/回收/负向验证仅针对该源；
 *     收尾删除该源级联回收创建人自动授权，并删除本轮申请人角色。
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
} from './权限测试工具.js';
import {
  type DataPermissionTypeFlag,
  type MysqlPermissionResource,
  confirmPermissionDangerAction,
  deletePermissionFromRow,
  findPermissionRow,
  findResourceViewAuthorizationRow,
  openDataPermissionPage,
  openPermissionEditDialog,
  openUserViewCreateDialog,
  queryUserViewPermissionRow,
  refreshPermissionList,
  resolveMysqlPermissionResource,
  selectPermissionTableScope,
  selectUserViewSubject,
  setPermissionExpiry,
  setPermissionTypes,
  submitPermissionDialog,
  submitPermissionEditDialog,
  switchResourceViewScopeTab,
} from './数据权限闭环工具.js';
import { requirePermissionApprovalEnvironment } from './权限审批待调试工具.js';
import { clickVisible, expectSuccess, visible, visibleDialog } from '../抽样用例工具.js';

/** 本轮自备资源：申请人身份、专用表权限资源与自助查询侧的数据源基础名。 */
interface Sm0306Context {
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

/* ------------------- DS-PERM-82：本轮唯一数据源/角色 创建与回收辅助 ------------------- */

/** 通用表单文本填写：label → placeholder → 表单节点 三路兜底；返回是否命中（同 SM-03-05）。 */
async function fillDialogField(scope: Locator, labels: string[], value: string): Promise<boolean> {
  for (const label of labels) {
    const candidates = [
      scope.getByLabel(label, { exact: false }),
      scope.getByPlaceholder(new RegExp(label)),
      scope
        .locator('.ant-form-item:visible, .el-form-item:visible')
        .filter({ hasText: label })
        .locator('input:visible, textarea:visible'),
    ];
    for (const candidate of candidates) {
      const field = candidate.first();
      if (await field.isVisible().catch(() => false)) {
        await field.fill(value);
        return true;
      }
    }
  }
  return false;
}

/** 打开 数据接入 → 数据源管理 页面。 */
async function openDataSourceManagement(page: Page): Promise<void> {
  await clickVisible(page, '数据接入');
  await clickVisible(page, '数据源管理');
  await page.waitForTimeout(1_200);
}

/**
 * 管理员创建本轮唯一 MYSQL 数据源（DS-PERM-82；两步向导，SM-03-05 同型）。
 * 连接参数取配置中心 DB_*（utils.dbConfig）；调用前门禁已确保为 MySQL。
 */
async function createRoundMysqlDataSource(
  page: Page,
  name: string,
  cfg: { host: string; port: number | string; database: string; user: string; password: string },
): Promise<void> {
  const jdbcUrl =
    `jdbc:mysql://${cfg.host}:${cfg.port}/${cfg.database}?allowMultiQueries=true&characterEncoding=utf-8`;
  await openDataSourceManagement(page);
  const newButton = (await visible(page.getByRole('button', { name: /新(建|增|添)|添加数据源/ })))
    ?? (await visible(page.getByText(/^(新(建|增|添)|添加数据源)$/, { exact: true })));
  if (!newButton) throw new Error('数据源管理页未找到“新建/新增”入口（可能受按钮权限控制）。');
  await newButton.click();
  const typeDialog = await visibleDialog(page);
  const mysqlCard = await visible(typeDialog.getByText(/MYSQL|MySQL/i).first());
  if (mysqlCard) {
    await mysqlCard.click();
  } else {
    const typeSelect = typeDialog
      .locator('.ant-select:visible, .el-select:visible, [role="combobox"]:visible')
      .first();
    if (!await typeSelect.isVisible().catch(() => false)) {
      throw new Error('数据源新建弹窗未找到 MYSQL 类型选择入口（卡片与下拉均未命中）。');
    }
    await typeSelect.click();
    const option = page
      .locator('.ant-select-item-option:visible, .el-select-dropdown__item:visible, [role="option"]:visible')
      .filter({ hasText: /^\s*MYSQL\s*$/i })
      .first();
    await option.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
    if (!await option.isVisible().catch(() => false)) {
      throw new Error('数据源新建弹窗未找到 MYSQL 类型选择入口（卡片与下拉均未命中）。');
    }
    await option.click();
  }
  // 两步向导：第一步仅选类型，点“下一步”后才是名称/连接信息表单（SM-03-05 实证同型）。
  const nextButton = await visible(typeDialog.getByRole('button', { name: /下一步/ }));
  if (nextButton) await nextButton.click();
  const dialog = await visibleDialog(page);
  if (!await fillDialogField(dialog, ['数据源名称', '名称', '源名称'], name)) {
    throw new Error('数据源新建弹窗未找到“数据源名称”输入框。');
  }
  if (!await fillDialogField(dialog, ['驱动类'], 'com.mysql.cj.jdbc.Driver')) {
    throw new Error('数据源新建弹窗未找到“驱动类”必填输入框。');
  }
  if (!await fillDialogField(dialog, ['链接地址', 'URL', '连接地址', 'JDBC'], jdbcUrl)) {
    const hostOk = await fillDialogField(dialog, ['主机', 'IP', '服务器'], cfg.host);
    await fillDialogField(dialog, ['端口'], String(cfg.port));
    if (!hostOk) throw new Error('数据源新建弹窗既无 链接地址 也无 主机/IP 输入框，无法完成连接信息。');
  }
  if (!await fillDialogField(dialog, ['用户名', '用户', '账号'], cfg.user)) {
    throw new Error('数据源新建弹窗未找到“用户名”输入框。');
  }
  if (!await fillDialogField(dialog, ['密码'], cfg.password)) {
    throw new Error('数据源新建弹窗未找到“密码”输入框。');
  }
  await fillDialogField(dialog, ['备注', '描述'], `SM-03-06 DS-PERM-82 e2esm0306ds`);
  const testConnection = await visible(dialog.getByRole('button', { name: /测\s*试\s*连\s*接/ }));
  if (testConnection) {
    await testConnection.click();
    await page.waitForTimeout(4_000);
  }
  await dialog.getByRole('button', { name: /确\s*定|保\s*存|完\s*成/ }).last().click();
  await expectSuccess(page, /成功|新增|保存/);
  // 以“列表出现该源”为创建成功判据（不以 toast 收口）。
  await expect(
    page.getByText(name, { exact: true }).first(),
    `新建数据源 ${name} 后未在数据源管理列表回显。`,
  ).toBeVisible({ timeout: 20_000 });
}

/** 删除本轮唯一数据源：卡片级删除 + 高危确认（键入 DELETE）；仅限本源卡片，不碰共享源。 */
async function deleteRoundDataSource(page: Page, sourceName: string): Promise<string> {
  await openDataSourceManagement(page);
  const card = page.locator('.data-source:visible').filter({ hasText: sourceName }).first();
  await card.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
  if (!(await card.isVisible().catch(() => false))) return 'absent';
  const del = card
    .locator('[aria-label="图标: delete"], [aria-label*="delete" i], .anticon-delete, [class*="icon-delete"]')
    .first();
  if (!(await del.isVisible().catch(() => false))) return 'no-entry';
  await del.click();
  // 高危操作确认弹窗：input[placeholder="请输入DELETE"] 键入 DELETE 后点“确 认”。
  const modal = page.locator('.ant-modal:visible, .el-dialog:visible, [role="dialog"]:visible').last();
  await modal.waitFor({ state: 'visible', timeout: 8_000 });
  const typed = modal.locator('input[placeholder="请输入DELETE"]:visible').first();
  if (await typed.isVisible().catch(() => false)) await typed.fill('DELETE');
  await modal.getByRole('button', { name: /确\s*认|删\s*除/ }).last().click();
  await expectSuccess(page, /成功|删除/);
  await page.waitForTimeout(800);
  // DS-PERM-92：删除后复查卡片不再回显；仍可见 = 删除未生效，如实上报而非记成功。
  if (await card.isVisible().catch(() => false)) return 'delete-not-effective';
  return 'deleted';
}

/** 按唯一名称删除本轮角色：行内文本按钮 → 行内图标（均限定匹配行），返回结果描述。 */
async function deleteRoleByName(page: Page, roleName: string): Promise<string> {
  await openRoleManagement(page);
  const queryBox = page.getByRole('textbox', { name: '请输入角色名称' }).first();
  await queryBox.fill(roleName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  const nameText = page.getByText(roleName, { exact: true }).last();
  await nameText.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
  if (!(await nameText.isVisible().catch(() => false))) return 'absent';
  const row = nameText.locator(
    'xpath=ancestor::*[self::tr or @role="row" or contains(@class,"el-table__row")][1]',
  );
  const textButton = row.getByRole('button', { name: /删\s*除|移\s*除/ }).first();
  const rowIcon = row
    .locator('[aria-label*="delete" i], [aria-label*="删除"], .anticon-delete, [class*="icon-delete"]')
    .first();
  const del = (await textButton.isVisible().catch(() => false)) ? textButton : rowIcon;
  if (!(await del.isVisible().catch(() => false))) return 'no-entry';
  await del.click();
  await confirmPermissionDangerAction(page);
  await page.waitForTimeout(1_000);
  // 删除后按同名复查：列表不再回显才算删除生效。
  await queryBox.fill(roleName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(1_000);
  const again = page.getByText(roleName, { exact: true }).last();
  return (await again.isVisible().catch(() => false)) ? 'delete-not-effective' : 'deleted';
}

/**
 * 以下 helper 在 e2e/utils.ts 未导出（仅权威目录 工厂/湖南中行/utils.ts 提供）。
 * 为保持 sm-static ↔ 工厂 硬链接 twin 双侧可编译（两侧 '../utils.js' 解析到不同
 * 文件），按权威实现本地复刻，不跨中文路径导入（同 SM-03-03，DS-PERM-09 先例）。
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 断言权限行（用户视角/资源视角）的权限类型恰为 expected。
 * 后端 permissionType 拼接为“使用 / 管理 / 使用、管理”，而编辑提交是 permissionList
 * 整体覆盖——因此除“包含 expected”外，还必须断言另一类型不残留，防止“使用、管理”
 * 被误判为已改成“管理”。行内主体名/表名均不含“使用/管理”字样，文本级判断安全。
 */
async function expectRowExactPermissionType(row: Locator, expected: DataPermissionTypeFlag): Promise<void> {
  const raw = await row.innerText({ timeout: 5_000 }).catch(() => '');
  const normalized = raw.replace(/\s+/g, '');
  const other: DataPermissionTypeFlag = expected === '使用' ? '管理' : '使用';
  expect(normalized, `权限行应包含权限类型“${expected}”，实际行文本：${raw}`).toContain(expected);
  expect(
    normalized,
    `权限行不应残留权限类型“${other}”（编辑/新增应为整体覆盖，实际行文本：${raw}）`,
  ).not.toContain(other);
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
 * 创建本轮唯一专用表并写入 2 行种子数据（MySQL 直连 DDL，仅本用例资源）。
 * 平台数据源/库/表级联来自实时 JDBC 扫描，建表即对授权下拉与自助查询目录可见；
 * 返回实际种子行数作为夹具证据（建表失败会让用例以真实错误结束，不伪造通过）。
 */
async function createPermissionFixtureTable(ctx: Sm0306Context): Promise<number> {
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
    + `('sm-1', 'e2e-sw0306-a', '${ctx.tableName}'), ('sm-2', 'e2e-sw0306-b', 'use-manage-closed-loop')`,
  );
  const rows = await query(`SELECT COUNT(*) AS total FROM ${ctx.tableName}`);
  const total = Number((rows[0] as { total?: unknown } | undefined)?.total ?? -1);
  expect(total, `专用表 ${ctx.tableName} 种子数据应为 2 行，实际：${JSON.stringify(rows)}`).toBe(2);
  return total;
}

/**
 * 删除本轮申请人账号（用户管理页：按本轮唯一账号查询 → 行内“删除” → 确认）。
 * 只回收本轮自备账号。DS-PERM-92：返回结构化结果——deleted/absent 视为回收完成；
 * not-effective（行不可得/无删除入口/删除后仍回显）由调用方登记为收尾未完成，
 * 不再以说明文本静默放行。
 */
async function deleteOwnApplicantUser(
  page: Page,
  applicant: PermissionIdentity,
): Promise<{ status: 'deleted' | 'absent' | 'not-effective'; detail: string }> {
  await openUserManagement(page);
  const search = page.getByRole('textbox', { name: '请输入用户名称' }).first();
  await search.fill(applicant.userName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(800);
  const userText = page.getByText(applicant.userName, { exact: true }).last();
  if (!(await userText.isVisible().catch(() => false))) {
    return { status: 'absent', detail: '列表未查询到本轮账号（可能此前已删除）' };
  }
  const row = userText.locator('xpath=ancestor::tr[1]');
  if (!(await row.isVisible().catch(() => false))) {
    return { status: 'not-effective', detail: '账号可见但未取到表格行，未执行页面删除（账号残留）' };
  }
  const deleteButton = row.getByRole('button', { name: /删\s*除/ }).first();
  if (!(await deleteButton.isVisible().catch(() => false))) {
    return { status: 'not-effective', detail: '行内未找到“删除”按钮，未执行页面删除（账号残留）' };
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
  // DS-PERM-92：删除后按同名复查；仍回显 = 删除未生效，如实上报而非记成功。
  if (await userText.isVisible().catch(() => false)) {
    return { status: 'not-effective', detail: '已提交删除但列表仍回显该账号（删除未生效）' };
  }
  return { status: 'deleted', detail: '已删除并确认列表不再显示该账号' };
}

/**
 * 清理本轮主体可能残留的权限记录（仅 本轮申请人 × 本轮专用表，页面操作逐条删除），
 * 保证“无权限”前提成立（数据表 + 数据源两个页签）：r12 实证面板默认停在“数据源”
 * 页签，表级残留行在“数据表”页签下，不切页签会静默漏删。全新 UUID 主体正常为 0 条，
 * 作为中断轮次的防御性兜底保留。
 * DS-PERM-92：返回 leftover——删除预算耗尽后授权行仍可见 = 回收未完成，由调用方如实
 * 登记（阶段 2 调用点仅记录条数、前提语义不变；收尾调用点参与统一裁决）。
 */
async function purgeStaleTablePermissions(
  page: Page,
  ctx: Sm0306Context,
): Promise<{ removed: number; leftover: boolean }> {
  await selectUserViewSubject(page, {
    subjectTab: '成员',
    subjectName: ctx.applicant.userName,
    subjectAlias: ctx.applicant.nickname,
  });
  let removed = 0;
  let leftover = false;
  await switchResourceViewScopeTab(page, '数据表');
  await refreshPermissionList(page);
  for (let guard = 0; guard < 20; guard += 1) {
    const stale = await findPermissionRow(page, ctx.tableName, 5_000);
    if (!stale) break;
    await deletePermissionFromRow(page, stale, { uniqueText: ctx.tableName });
    removed += 1;
    await refreshPermissionList(page);
  }
  // DS-PERM-92：预算耗尽后仍回显目标表授权行 = 本页签回收未完成，如实上报。
  if (await findPermissionRow(page, ctx.tableName, 5_000)) leftover = true;
  await switchResourceViewScopeTab(page, '数据源');
  await refreshPermissionList(page);
  for (let guard = 0; guard < 3; guard += 1) {
    const staleSource = await findPermissionRow(page, ctx.resource.sourceName, 4_000);
    if (!staleSource) break;
    await deletePermissionFromRow(page, staleSource, { uniqueText: ctx.resource.sourceName });
    removed += 1;
    await refreshPermissionList(page);
  }
  // DS-PERM-92：预算耗尽后仍回显目标源授权行 = 本页签回收未完成，如实上报。
  if (await findPermissionRow(page, ctx.resource.sourceName, 4_000)) leftover = true;
  return { removed, leftover };
}

/**
 * 任务27F 页面事实3：目录“刷新数据库元数据”确认弹窗处理。点击自助查询目录的刷新
 * 按钮后会出现“刷新数据库元数据”确认弹窗，必须点击“确定”并等待弹窗关闭和树刷新
 * （run-20260915-104337/105913/110417 三轮实证：弹窗不确认会以模态层阻塞目录后续
 * 全部交互，不能误判为页面卡死）。弹窗未出现（目录控件未挂载等）时为 no-op。
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
  // 弹窗关闭后目录树异步重建：留出树刷新稳定窗口（任务27F 页面事实3）。
  await page.waitForTimeout(2_500);
  return true;
}

/**
 * 自助查询验证前刷新数据库元数据（任务27F 页面事实3）：点击目录“刷新”，出现
 * “刷新数据库元数据”确认弹窗则点击“确定”并等待弹窗关闭+树刷新，随后再查看
 * 数据源/库/Schema/表并执行只读 SQL。目录控件未渲染时安全跳过，不作为失败。
 */
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
 * 在自助查询左侧目录中查找目标表节点。排除数据源/Schema combobox 与 Monaco 编辑器
 * 内的同名文本；轮询窗口内未出现返回 undefined。
 */
async function pollCatalogTableText(
  page: Page,
  tableName: string,
  exact: boolean,
  timeoutMs: number,
): Promise<Locator | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const nodes = page.getByText(tableName, { exact });
    const count = await nodes.count();
    // 从最后一个匹配向前找：getByText 非精确模式会同时命中祖先容器，
    // DOM 序靠后的通常是内层真实节点。
    for (let index = count - 1; index >= 0; index -= 1) {
      const node = nodes.nth(index);
      if (!(await node.isVisible().catch(() => false))) continue;
      const insideControl = node.locator(
        'xpath=ancestor-or-self::*[@role="combobox" or contains(@class, "monaco-editor") or self::input]',
      );
      if ((await insideControl.count()) === 0) return node;
    }
    await page.waitForTimeout(400);
  }
  return undefined;
}

async function findCatalogTableNode(page: Page, tableName: string): Promise<Locator | undefined> {
  return (await pollCatalogTableText(page, tableName, true, 10_000))
    ?? (await pollCatalogTableText(page, tableName, false, 6_000));
}

/** 快速版：仅精确匹配短轮询，用于展开尝试之间的早退检查，避免测试超时。 */
async function tableNodeQuickCheck(page: Page, tableName: string): Promise<Locator | undefined> {
  return pollCatalogTableText(page, tableName, true, 2_500);
}

/**
 * 尽力展开目录树中的库/Schema 节点，直到目标表出现（传入 tableName 时逐尝试早退）。
 * 兼容两种树实现：标准 treeitem 角色（DQ-01-01 expandTreeItem）与当前版本的 antd
 * 虚拟树普通节点行（r10 DOM 实证：.virtual-tree-node > [.ant-tree-switcher
 * (i[aria-label="图标: caret-down"]), .ant-tree-iconEle, .ant-tree-node-content-wrapper]）。
 * r5/r6 实证：点击标题不展开；caret 箭头是展开触发方式，逐项尝试。
 * r8 实证：个别候选点击会把页面导航走——记录进入前 URL，点击后 URL 变化立即导航回工作台。
 */
async function tryExpandCatalogSchema(page: Page, schemaName: string, tableName?: string): Promise<void> {
  // 快速检查（2.5s 精确匹配）用于尝试间早退，避免每步完整轮询耗尽测试超时。
  const tableVisible = async (): Promise<boolean> =>
    Boolean(tableName && (await tableNodeQuickCheck(page, tableName).catch(() => undefined)));
  const urlBefore = page.url();
  const ensureSamePage = async (): Promise<void> => {
    if (page.url() !== urlBefore) {
      await page.goto(urlBefore, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.waitForTimeout(1_500);
    }
  };
  // 兼容 1：标准 treeitem 角色。
  const candidates = page.getByRole('treeitem', { name: new RegExp(escapeRegExp(schemaName)) });
  const count = await candidates.count().catch(() => 0);
  for (let index = count - 1; index >= 0; index -= 1) {
    const node = candidates.nth(index);
    if (!(await node.isVisible().catch(() => false))) continue;
    const expanded = await node.getAttribute('aria-expanded').catch(() => null);
    const className = await node.getAttribute('class').catch(() => null);
    if (expanded === 'true' || className?.includes('switcher-open')) continue;
    const switcher = node.locator('.ant-tree-switcher, [role="button"]').first();
    if (await switcher.count()) await switcher.click({ timeout: 2_000 }).catch(() => undefined);
    else await node.click({ timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    await ensureSamePage();
    if (await tableVisible()) return;
  }
  // 兼容 2：普通节点行（无 treeitem 角色）。仍排除 combobox/Monaco/输入框内同名文本。
  // r7b trace 实证：getByText 只命中最内层标题元素，需爬到行容器（[箭头, 图标, 标题]）
  // 再在行内定位 caret 箭头；行容器限定 2~4 个子元素（r9 实证爬太高会点到导航链接）。
  const titleNodes = page.getByText(schemaName, { exact: true });
  const titleCount = await titleNodes.count().catch(() => 0);
  for (let index = 0; index < titleCount; index += 1) {
    const node = titleNodes.nth(index);
    if (!(await node.isVisible().catch(() => false))) continue;
    const insideControl = node.locator(
      'xpath=ancestor-or-self::*[@role="combobox" or contains(@class, "monaco-editor") or self::input]',
    );
    if ((await insideControl.count()) > 0) continue;
    const row = node.locator('xpath=ancestor::*[count(*) >= 2][count(*) <= 4][1]');
    // r10 实证：antd 虚拟树节点已展开（switcher_open）时无需再点，避免二次点击折叠。
    const alreadyOpen = await row.locator('.ant-tree-switcher_open').count().catch(() => 0);
    if (alreadyOpen > 0) continue;
    const caretCandidates: Locator[] = [
      row.locator('[aria-label*="caret"]').first(),
      row.locator('.ant-tree-switcher').first(),
      row.locator('[class*="caret"]').first(),
    ];
    for (const caret of caretCandidates) {
      if (!(await caret.count().catch(() => 0))) continue;
      await caret.click({ timeout: 2_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
      await ensureSamePage();
      if (await tableVisible()) return;
      break; // 只点第一个命中的箭头候选，避免二次点击把节点重新折叠
    }
    // c. 标题双击（部分实现用双击展开；r5 已证单击无效）。
    await node.dblclick({ timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(1_200);
    await ensureSamePage();
    if (await tableVisible()) return;
  }
}

/** 自助查询执行结果状态：done=结果列头已出现；denied=页面出现表级权限拦截文案；pending=仍在执行。 */
async function readQueryOutcome(page: Page, marker: string): Promise<'done' | 'denied' | 'pending'> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  // 后端已确认文案：【表名】数据表没有使用权限，请确认（glm5.3-01 §3 生效点 B）。
  if (/没有使用权限/.test(bodyText)) return 'denied';
  // marker 是本轮唯一的列别名，只出现在结果表列头（th/columnheader）；
  // Monaco 编辑器中的 SQL 文本不是表格单元格，不会被该选择器命中。
  const headerCount = await page
    .locator('th:visible, [role="columnheader"]:visible')
    .filter({ hasText: marker })
    .count();
  return headerCount > 0 ? 'done' : 'pending';
}

/**
 * 阶段 4 断言（已授权“使用”）：被授权用户在自助查询选择 MySQL 数据源后（新版页面
 * 确认数据源即挂载目录树，Schema 由数据源自动确定、无独立下拉），目录中出现本轮专用表，
 * 且对该表的只读 COUNT 查询真实返回结果（不得被表级权限拦截）——表可见与 COUNT 成功
 * 均为硬断言；attach 在关键检查点留存 aria 快照，便于失败时定位目录树真实状态。
 * schema 固定 false：utils 的版本探测会把残留可见的数据源选择器误判为 Schema 控件。
 */
async function assertTableVisibleAndQueryable(
  page: Page,
  ctx: Sm0306Context,
  attach?: (name: string, body: string) => Promise<void>,
): Promise<void> {
  const snapshot = async (name: string): Promise<void> => {
    if (!attach) return;
    await attach(name, await page.locator('body').ariaSnapshot()).catch(() => undefined);
  };
  // run-20260916-154859 实证：被授权用户打开目录时 dataSourceSchemaMetadata 可能 500
  // （code 999901）导致目录树不渲染。保留监听作为“表节点未找到”时的产品缺陷直接证据。
  const schemaMetadataErrors: string[] = [];
  page.on('response', (response) => {
    if (!response.url().includes('/plugin-datasource/dataSourceSchemaMetadata')) return;
    if (response.status() < 400) return;
    void response.text()
      .then((body) => {
        schemaMetadataErrors.push(`HTTP ${response.status()}：${body.slice(0, 200)}`);
      })
      .catch(() => {
        schemaMetadataErrors.push(`HTTP ${response.status()}：响应体不可读`);
      });
  });
  await openSelfServiceQuery(page);
  // 任务27F 页面事实3：验证前先刷新数据库元数据（确认弹窗→确定→树刷新）。
  await refreshDatabaseMetadata(page);
  await chooseConfiguredDataSource(page, {
    type: ctx.resource.sourceTypeName,
    name: ctx.querySourceName,
    schema: false,
  });

  let tableNode = await findCatalogTableNode(page, ctx.tableName);
  if (!tableNode) {
    await snapshot('sm0306-目录-展开前');
    await tryExpandCatalogSchema(page, ctx.resource.schemaName, ctx.tableName);
    tableNode = await findCatalogTableNode(page, ctx.tableName);
  }
  // r10 DOM 实证：schema 展开后子级是“数据表/存储过程”分组节点，表在“数据表”分组
  // 之下，需对分组节点二次展开（遍历所有可见“数据表”分组，命中目标表即早退）。
  if (!tableNode) {
    await tryExpandCatalogSchema(page, '数据表', ctx.tableName);
    tableNode = await findCatalogTableNode(page, ctx.tableName);
  }
  // 虚拟滚动兜底：目标表行可能渲染在视口外。目录自带“搜索表名/存储过程”过滤框
  // （f1e81 快照实证）；r6 实证 fill+Enter 触发服务端搜索并重载树，可越过虚拟滚动
  // 定位视口外的表行（只可用输入框自身事件，不可点全局 search 图标）。
  if (!tableNode) {
    const tableSearch = page.getByRole('textbox', { name: /搜索表名|存储过程/ });
    if (await tableSearch.isVisible().catch(() => false)) {
      await tableSearch.fill(ctx.tableName);
      await tableSearch.press('Enter').catch(() => undefined);
      await page.waitForTimeout(2_000);
      tableNode = await findCatalogTableNode(page, ctx.tableName);
    }
  }
  if (!tableNode && schemaMetadataErrors.length > 0) {
    await snapshot('sm0306-目录-后端接口错误');
    throw new Error(
      '目录树元数据接口服务端错误（产品缺陷证据，非测试定位问题）：'
        + `/plugin-datasource/dataSourceSchemaMetadata → ${schemaMetadataErrors.join(' ｜ ')}。`
        + `授权主体 ${ctx.applicant.userName} 对 ${ctx.tableName} 的“使用”授权已生效（数据源可选），`
        + '但权限过滤版 Schema 元数据接口异常，目录树未渲染目标表，无法继续验证表可见与只读查询。',
    );
  }
  if (!tableNode) {
    await snapshot('sm0306-目录-最终未命中');
    const ariaText = await page.locator('body').ariaSnapshot().catch(() => '');
    const digest = ariaText
      .split('\n')
      .filter((line) => /caret|e2e_|sw0306|数据表|存储过程|搜索|reload|暂无|empty/i.test(line))
      .slice(0, 60)
      .join('\n');
    throw new Error(
      `已授予“使用”权限后，自助查询目录中仍看不到专用表 ${ctx.tableName}；`
        + `资源=${ctx.resource.sourceName}/${ctx.resource.schemaName}，当前页面：${page.url()}`
        + `\n===== 目录树摘要 =====\n${digest}`,
    );
  }

  const marker = `cnt_${uuid()}`;
  await executeSql(page, `SELECT COUNT(*) AS ${marker} FROM ${ctx.tableName}`);
  await expect
    .poll(async () => readQueryOutcome(page, marker), {
      timeout: 30_000,
      message: `授权“使用”后，对 ${ctx.tableName} 的只读查询未返回结果（若页面提示无权限，说明授权未生效）`,
    })
    .toBe('done');
}

/**
 * 阶段 7 断言（已删除权限）：目标用户视角下该表不可访问。两种已确认的预期表现其一
 * 即成立：
 *   a) 数据源“可使用”依赖 kind=5 表级记录，删除后数据源在自助查询不可见
 *      （chooseConfiguredDataSource 报“下拉选项未找到/入口未找到”）；
 *   b) 数据源仍可选（存在其他通配授权时），提交 SQL 被表级权限拦截（“没有使用权限”）。
 * 若查询仍成功返回结果，则删除未生效，明确失败。返回实际命中的表现描述供 report 记录。
 */
async function expectTableQueryBlocked(page: Page, ctx: Sm0306Context): Promise<string> {
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
      return `数据源/Schema 已因权限删除不可见（${message.split('，')[0]}）`;
    }
    throw error;
  }

  const marker = `delchk_${uuid()}`;
  await executeSql(page, `SELECT COUNT(*) AS ${marker} FROM ${ctx.tableName}`);
  await expect
    .poll(async () => readQueryOutcome(page, marker), {
      timeout: 30_000,
      message: `删除权限后，对 ${ctx.tableName} 的查询仍可成功执行或无明确拦截提示——权限删除未在实际访问层生效`,
    })
    .toBe('denied');
  return '数据源仍可见，但表级查询被“没有使用权限”拦截';
}

test.describe.configure({ mode: 'serial', timeout: 600_000 });

test.describe('SM-03-06｜系统管理｜数据表使用管理权限用户资源视角与实际访问闭环', () => {
  test('SM-03-06｜系统管理｜数据表使用管理权限用户资源视角与实际访问闭环', async (
    { loginPage, consoleErrors, report },
    testInfo,
  ) => {
    requirePermissionApprovalEnvironment();

    // 前置门禁：本轮专用表需要 MySQL 直连（DB_*，即 MySQL 110）；未配置按前置不足跳过。
    const cfg = dbConfig();
    if (!cfg || cfg.type !== 'mysql') {
      test.skip(
        !cfg || cfg.type !== 'mysql',
        `前置不足：未配置 MySQL 数据库环境（DB_HOST=${process.env.DB_HOST ?? ''}，DB_TYPE=${process.env.DB_TYPE ?? ''}），无法创建本轮唯一专用表。`,
      );
    }

    const page = loginPage;
    const attachSnapshot = async (name: string, body: string): Promise<void> => {
      await testInfo.attach(name, { body }).catch(() => undefined);
    };

    // 阶段 0a：本轮自备 主体/专用表/唯一数据源（唯一英文前缀，不依赖 SM-00-01/BL-00-00
    // 固化夹具，也不依赖历史/共享数据源——DS-PERM-82）。
    const applicant = newPermissionIdentity('sw0306');
    const applicantRole = newPermissionRole('sw0306', 'applicant');
    const tableName = `e2e_sw0306_${uuid()}`;
    const sourceName = `e2esm0306ds_${uuid().replace(/-/g, '').slice(0, 10)}`;
    // 授权/回收/探针仅指向本轮唯一新建数据源（阶段 0b2 创建）；源删除级联回收创建人
    // 自动授权。QUERY_SOURCE_NAME 环境覆盖不再参与：避免把验证目标错指到历史/共享源。
    const resource = resolveMysqlPermissionResource({ tableName, sourceName });
    // 自助查询数据源下拉展示的是数据源名称；本轮唯一源名为纯英文标识（不含主机分隔），
    // 截取仅作历史命名形态兜底，避免选项文案不匹配被误报成“权限未生效”。
    const querySourceName = resource.sourceName.split(/[:：]/)[0].trim();
    const ctx: Sm0306Context = { applicant, resource, tableName, querySourceName };
    const subjectOptions = {
      subjectTab: '成员' as const,
      subjectName: applicant.userName,
      subjectAlias: applicant.nickname,
    };
    const resourceSubjectQuery = { ...subjectOptions, resource };
    const seededRows = await createPermissionFixtureTable(ctx);
    await report(
      'SM-03-06 阶段0a｜创建本轮申请人身份与专用表',
      true,
      `申请人=${applicant.userName}；专用表=${tableName}（MySQL 直连创建，种子 ${seededRows} 行）。`,
    );

    // 申请人可达入口与兜底（29F 真实探查实证：受限账号登录 redirect 指向未授权的
    // “数据接入”模块时，登录成功后 SPA 回跳会直落产品 #/404；一律从申请人可达的
    // #/dataQuery/selfServiceQuery 进入，候选页兜底完成会话初始化）。
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
    // DS-PERM-92：主体失败载体（保留原始错误实例，不掩盖主因）与收尾回收失败逐项
    // 收集载体——收尾失败不再 console.warn 后放行，而是在用例结尾统一裁决。
    let mainError: unknown;
    let mainFailed = false;
    const cleanupIssues: string[] = [];
    try {
      await loginAs(page, adminIdentity);

      // 阶段 0b：创建申请人账号并授予含“数据地图/数据查询”菜单的角色（可进入自助查询）。
      await createAndInviteUser(page, applicant);
      await createRole(page, applicantRole, ['数据地图', '数据查询']);
      await assignRoleToUser(page, applicantRole, applicant);
      await report(
        'SM-03-06 阶段0b｜创建申请人账号并授予查询菜单角色',
        true,
        `角色=${applicantRole.roleName}（菜单：数据地图/数据查询）已分配给 ${applicant.userName}。`,
      );

      // 阶段 0b2（DS-PERM-82）：管理员创建本轮唯一数据源（JDBC 指向配置中心 DB_* 库）。
      // 后续授权/回收/负向验证仅针对该源；源删除级联回收创建人自动授权，
      // 不依赖任何历史/共享数据源。
      const roundDb = dbConfig();
      if (!roundDb || roundDb.type !== 'mysql') {
        throw new Error('DB_* 未指向可直连 MySQL，无法创建本轮唯一数据源（DS-PERM-82）。');
      }
      await createRoundMysqlDataSource(page, sourceName, roundDb);
      await report(
        'SM-03-06 阶段0b2｜创建本轮唯一数据源',
        true,
        `数据源=${sourceName}（JDBC 指向 ${roundDb.host}:${roundDb.port}/${roundDb.database}）；后续授权/回收仅针对该源。`,
      );

      // 阶段 0c：元数据缓存预热——以管理员在自助查询刷新一次数据库元数据，让本轮新表
      // 进入平台元数据缓存（fac_ds_m* 默认开启）。预热失败如实记录，不静默；真正的
      // 验收仍以阶段 3 授权下拉能否真实选中新表 + 阶段 4 实际查询为准。
      let metadataWarmup = '目录控件未渲染，按 SM-03-03 语义安全跳过（授权下拉以实时/缓存数据为准）';
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
      await report('SM-03-06 阶段0c｜刷新数据库元数据（管理员）', true, metadataWarmup);

      // 阶段 1：读取开关原始状态并强制置“开启”——阶段 7 的“删除后拦截”仅在开启态
      // 成立（§11.1-1：关闭态不校验表权限），不能依赖环境遗留状态；结束时恢复原值。
      await openDataPermissionPage(page);
      originalChecked = await readPermissionSwitchChecked(page);
      await setPermissionSwitch(page, true);
      await report(
        'SM-03-06 阶段1｜开关置“开启”并记录原始状态',
        true,
        `数据权限开关原始=${originalChecked ? '开启' : '关闭'}（结束时恢复原值）；当前=开启；专用表=${tableName}；主体=${applicant.userName}。`,
      );

      // 阶段 2：清理本轮主体残留授权（全新 UUID 主体正常为 0 条，防御中断轮次残留）。
      const { removed: removedStale } = await purgeStaleTablePermissions(page, ctx);
      await report(
        'SM-03-06 阶段2｜残留权限清理',
        true,
        `主体=${applicant.userName}；专用表=${tableName}；本轮清理残留记录 ${removedStale} 条（0=首次执行或无残留）。`,
      );

      // 阶段 3：用户视角新增专用表“使用”权限（固定勾选具体表 + 永久，防止全量通配授权），
      // 用户视角回显恰为“使用”，资源视角（数据表页签）复核。
      // 用户视角的右侧资源范围默认停在“数据源”；数据表的表单才会动态渲染
      // 数据库 → Schema → 表三级选择器，未切换就查数据库会把默认态误判为环境缺失。
      await selectUserViewSubject(page, subjectOptions);
      await switchResourceViewScopeTab(page, '数据表');
      const createDialog = await openUserViewCreateDialog(page);
      await selectPermissionTableScope(page, createDialog, resource);
      await setPermissionTypes(page, createDialog, ['使用']);
      await setPermissionExpiry(page, createDialog, '永久');
      await submitPermissionDialog(page, createDialog);
      const createdRow = await queryUserViewPermissionRow(page, resourceSubjectQuery);
      await expectRowExactPermissionType(createdRow, '使用');
      const resourceUseRow = await findResourceViewAuthorizationRow(page, {
        resource,
        subjectName: applicant.userName,
        scopeTab: '数据表',
      });
      if (!resourceUseRow) {
        throw new Error(`资源视角（数据表页签）未回显用户 ${applicant.userName} 对 ${tableName} 的“使用”授权，不能视为授权生效。`);
      }
      await expectRowExactPermissionType(resourceUseRow, '使用');
      await report(
        'SM-03-06 阶段3｜新增“使用”并双视角回显',
        true,
        `专用表=${tableName}，用户视角/资源视角权限类型=使用（不含管理）。`,
      );

      // 阶段 4：切换到被授权用户，实际访问验证（目录可见 + 只读 COUNT 真实返回结果）。
      await loginAsApplicant();
      await assertTableVisibleAndQueryable(page, ctx, attachSnapshot);
      await report(
        'SM-03-06 阶段4｜被授权用户实际访问验证（使用）',
        true,
        `${applicant.userName} 在自助查询目录可见 ${tableName}，且 COUNT(*) 只读查询真实返回结果。`,
      );

      // 阶段 5：管理权限实际操作——编辑对话框把权限整体改为“管理”（permissionList
      // 整体覆盖），“使用”应被清除；用户/资源双视角回显恰为“管理”。
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      const beforeEditRow = await queryUserViewPermissionRow(page, resourceSubjectQuery);
      const editDialog = await openPermissionEditDialog(page, beforeEditRow);
      await submitPermissionEditDialog(page, editDialog, { permissionTypes: ['管理'] });
      const managedRow = await queryUserViewPermissionRow(page, resourceSubjectQuery);
      await expectRowExactPermissionType(managedRow, '管理');
      const resourceManageRow = await findResourceViewAuthorizationRow(page, {
        resource,
        subjectName: applicant.userName,
        scopeTab: '数据表',
      });
      if (!resourceManageRow) {
        throw new Error(`资源视角（数据表页签）未回显用户 ${applicant.userName} 对 ${tableName} 的“管理”授权。`);
      }
      await expectRowExactPermissionType(resourceManageRow, '管理');
      await report(
        'SM-03-06 阶段5｜权限改为“管理”后双视角复核',
        true,
        '用户视角与资源视角均回显 权限类型=管理，且不再包含“使用”。',
      );

      // 阶段 6：删除权限并确认双视角均不再回显（回收本轮授权）。
      const finalRow = await queryUserViewPermissionRow(page, resourceSubjectQuery);
      await deletePermissionFromRow(page, finalRow, { uniqueText: tableName });
      await refreshPermissionList(page);
      const ghostUserRow = await findPermissionRow(page, tableName, 6_000);
      if (ghostUserRow) {
        throw new Error(`删除权限后，用户视角仍回显 ${applicant.userName} 的 ${tableName} 授权行，删除可能未生效。`);
      }
      const ghostResourceRow = await findResourceViewAuthorizationRow(page, {
        resource,
        subjectName: applicant.userName,
        scopeTab: '数据表',
        timeoutMs: 8_000,
      });
      if (ghostResourceRow) {
        throw new Error(`删除权限后，资源视角（数据表页签）仍回显用户 ${applicant.userName} 的授权行，删除可能未生效。`);
      }
      await report('SM-03-06 阶段6｜删除权限并双视角确认消失', true, '用户视角行已消失；资源视角授权行已消失。');

      // 阶段 7：再次切换用户，确认该表不再可见/不可访问（两态其一即拦截成立）。
      await loginAsApplicant();
      const inaccessibleDetail = await expectTableQueryBlocked(page, ctx);
      await report(
        'SM-03-06 阶段7｜删除权限后被授权用户实际访问验证',
        true,
        `${applicant.userName}：${inaccessibleDetail}。`,
      );

      // 无权限查询被后端拒绝属于本用例预期失败信号；其余控制台错误仍然失败。
      await assertNoUnexpectedConsoleErrors(consoleErrors, [
        /self\/query\/submitQuery/,
        /没有使用权限/,
      ]);
      await report(
        'SM-03-06｜数据表使用管理权限闭环完成',
        true,
        `资源=${resource.sourceTypeName} ${resource.sourceName}，库/Schema=${resource.databaseName}/${resource.schemaName}，`
          + `专用表=${tableName}（本轮自建），主体=${applicant.userName}；`
          + `已完成：新增使用→双视角回显→实际访问→改为管理→双视角复核→删除→双视角消失→不可访问验证。`,
      );
    } catch (error) {
      // DS-PERM-92：主体失败先记录、不立即重抛——确保 finally 中全部收尾步骤执行
      // 完毕后，在用例结尾统一裁决（重抛同一实例，主体失败原因与既有判定语义
      // 不被收尾异常覆盖）。
      mainError = error;
      mainFailed = true;
    } finally {
      const cleanupIssues: string[] = [];
      // 收尾 1（DS-PERM-92）：兜底回收本轮授权（仅 本轮主体×本轮表/源；主流程已删则
      // 此处为 0 条）。失败/回收不彻底逐项登记，不掩盖主结果，也不阻断后续回收。
      try {
        await loginAs(page, adminIdentity);
        await openDataPermissionPage(page);
        const { removed: removedFinally, leftover: staleLeftover } = await purgeStaleTablePermissions(
          page,
          ctx,
        );
        if (removedFinally > 0) {
          await report('SM-03-06 收尾｜兜底回收本轮授权', true, `删除残留授权 ${removedFinally} 条。`);
        }
        if (staleLeftover) {
          cleanupIssues.push('授权兜底回收未完成：预算耗尽后本轮主体×本轮表/源授权行仍回显');
        }
      } catch (purgeError) {
        cleanupIssues.push(`授权兜底回收未完成：${purgeError instanceof Error ? purgeError.message.split('，')[0] : String(purgeError)}`);
      }
      // 收尾 1b（DS-PERM-82）：删除本轮唯一数据源——源删除级联回收创建人自动授权
      // （与 SM-03-05 结尾删除同型）。DS-PERM-92：删除未生效/无删除入口也属回收
      // 未完成，必须登记，不得以结果文本静默放行。
      try {
        const outcome = await deleteRoundDataSource(page, resource.sourceName);
        if (outcome === 'deleted' || outcome === 'absent') {
          await report('SM-03-06 收尾｜回收本轮唯一数据源', true, `${resource.sourceName}：${outcome}。`);
        } else {
          cleanupIssues.push(`本轮数据源回收未完成：${resource.sourceName} ${outcome}（源残留在案）`);
        }
      } catch (sourceError) {
        cleanupIssues.push(`本轮数据源回收未完成：${sourceError instanceof Error ? sourceError.message.split('，')[0] : String(sourceError)}`);
      }
      // 收尾 2：DROP 本轮专用表（仅本轮资源，不含任何既有表）。
      try {
        await query(`DROP TABLE IF EXISTS ${tableName}`);
      } catch (dropError) {
        cleanupIssues.push(`专用表 ${tableName} 回收未完成：${dropError instanceof Error ? dropError.message : String(dropError)}`);
      }
      // 收尾 3（DS-PERM-92）：删除本轮申请人账号（DS-PERM-82：本轮角色同样删除）。
      // 删除未生效/无删除入口也属回收未完成，必须登记，不得以说明文本静默放行。
      try {
        const { status, detail } = await deleteOwnApplicantUser(page, applicant);
        if (status === 'deleted' || status === 'absent') {
          await report('SM-03-06 收尾｜回收本轮申请人账号', true, `${applicant.userName}：${detail}。`);
        } else {
          cleanupIssues.push(`申请人账号回收未完成：${applicant.userName} ${detail}`);
        }
      } catch (userError) {
        cleanupIssues.push(`申请人账号回收未完成：${userError instanceof Error ? userError.message.split('，')[0] : String(userError)}`);
      }
      // 收尾 3b（DS-PERM-82）：删除本轮申请人角色（唯一英文命名，删除不影响共享回归）。
      // DS-PERM-92：删除未生效/无删除入口也属回收未完成，必须登记。
      try {
        const outcome = await deleteRoleByName(page, applicantRole.roleName);
        if (outcome === 'deleted' || outcome === 'absent') {
          await report('SM-03-06 收尾｜回收本轮申请人角色', true, `${applicantRole.roleName}：${outcome}。`);
        } else {
          cleanupIssues.push(`本轮角色回收未完成：${applicantRole.roleName} ${outcome}（角色残留在案）`);
        }
      } catch (roleError) {
        cleanupIssues.push(`本轮角色回收未完成：${roleError instanceof Error ? roleError.message.split('，')[0] : String(roleError)}`);
      }
      // 收尾 4（DS-PERM-92）：恢复开关为原始状态——共享配置遗留为测试态属最高优先级
      // 污染，恢复失败逐项收集并在用例结尾统一裁决（原 finally 内直接抛错会覆盖
      // 主体失败原因，不符合“保留主错误并附加收尾证据”口径）。
      if (originalChecked !== undefined) {
        try {
          await loginAs(page, adminIdentity);
          await openDataPermissionPage(page);
          await setPermissionSwitch(page, originalChecked);
          await report(
            'SM-03-06 收尾｜恢复数据权限开关原始状态',
            true,
            `已恢复为 ${originalChecked ? '开启' : '关闭'}。`,
          );
        } catch (restoreError) {
          const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
          cleanupIssues.push(`数据权限开关恢复未完成（共享配置被遗留为测试态）：${restoreMessage}`);
        }
      }
      // 收尾证据（DS-PERM-92）：收尾结果附加到报告，未完成项逐条可见，便于人工复核。
      await testInfo
        .attach('sm0306-finally-cleanup.log', {
          body: cleanupIssues.length
            ? `收尾回收未完成：\n${cleanupIssues.join('\n')}`
            : '收尾回收全部完成（授权/数据源/专用表/申请人账号/申请人角色/共享开关）。',
          contentType: 'text/plain',
        })
        .catch(() => undefined);
    }
    // 统一裁决（DS-PERM-92）：
    // ① 主体失败：重抛原始错误实例（不掩盖主因、不改判 skip/fail 语义），仅在
    //    Error 信息上附加收尾未完成证据（截断 600 字符）；
    // ② 主体成功 + 收尾未完成：聚合上抛使测试失败——清洁环境口径，收尾失败不得
    //    以通过收场（不再 console.warn 后放行）。
    if (mainFailed) {
      if (mainError instanceof Error && cleanupIssues.length > 0) {
        mainError.message = `${mainError.message}（另：本轮收尾回收未完全成功：${cleanupIssues.join('；').slice(0, 600)}）`;
      }
      throw mainError;
    }
    if (cleanupIssues.length > 0) {
      throw new Error(
        `SM-03-06 收尾回收未完全成功（清洁环境口径，收尾失败必须阻断通过）：${cleanupIssues.join('；')}`,
      );
    }
  });
});


