/**
 * 系统管理 E2E 测试 — 用户视角数据源权限增查改删（SM-03-07，DS-PERM-87 清洁环境迁移版）
 *
 * 覆盖场景（Excel「测试用例」行44 数据权限 · 用户视角 · 数据源权限；断言口径完整平移）：
 *   1. 成员主体下新增数据源“管理”权限：固定勾选本轮唯一 MySQL 数据源 + 永久，
 *      防止未选明细落库为全量通配授权（glm5.3-01 业务模型 §1.3）；
 *   2. 用户视角跨页查询回显：权限类型恰为“管理”，行内不得残留“使用”；
 *   3. 资源视角（数据源页签）回显同一授权（授权用户 × 权限类型）；
 *   4. 编辑权限截止时间：永久 → 自定义未来日期（数据源权限弹窗只渲染“管理”，
 *      页面无“使用/管理”级别切换，因此不伪造权限级别修改，只编辑真实可编辑项）；
 *   5. 删除该权限：用户视角与资源视角均不再回显（删除后显式复查）。
 *
 * 业务边界（glm5.3-01 业务模型复核 / 权限与审批测试理解.md）：
 *   - 数据源权限（permissionKind=2）只承载“管理”；“使用”与字段范围（全部字段/
 *     部分字段）只属于数据表权限（kind=5）。本用例不把数据源权限写成字段权限，
 *     也不断言自助查询的数据源可选性（kind=2 不改变 checkSourceUsePermission
 *     的 kind=5 判定，实际访问验证由 SM-03-05/SM-03-06 承载）；
 *   - 授权固定到本轮唯一资源：数据源名称是本轮授权行的唯一文本（uniqueText），
 *     新增/编辑/删除均以它定位；资源不携带 tableName，杜绝误跑到表级/字段范围授权。
 *
 * DS-PERM-87 静态校准（替换历史固化资产依赖；结构对齐 SM-03-05 已验证闭环）：
 *   1. 不再依赖历史共享数据源显示名与固定连接信息：管理员经 UI 创建本轮唯一
 *      MySQL 数据源（名称 e2esm0307ds_<uuid 派生>），JDBC 连接参数取配置中心
 *      DB_*（utils.dbConfig，由 e2e/test-environment.ts 解析），DATA_PERMISSION_*
 *      仅作显式覆盖；DB_* 未配置或非 MySQL 按前置不足 skip（非永久 skip）。
 *   2. 授权/回收仅作用于 本轮新建成员（newPermissionIdentity + createAndInviteUser，
 *      SM-00-02 同型）× 本轮唯一数据源；本轮角色（数据地图/数据查询菜单）分配给
 *      成员，不依赖任何历史固化用户/角色。
 *   3. 收尾按 DS-PERM-87 裁决口径（聚合自 SM-03-01/02 与 DS-PERM-90 已验证实现）：
 *      仅回收本轮资产（授权 → 数据源 → 成员 → 角色），逐项登记、单步失败不阻断
 *      其余回收；主流程失败保留原始错误并附加清理留证后重抛，主流程通过但清理
 *      未完成时用例判失败（不伪造通过、不误报产品缺陷）。数据源/成员/角色
 *      “页面未提供删除入口”属产品能力缺口，登记为收尾未完成并参与裁决。
 *   4. 控制台错误门禁保持运行期派生允许清单（getCreatedDataSource / dataPermission/
 *      4xx 过程信号 + 无权限提示），其余控制台错误仍然失败。
 *
 * 与 SM-03-05 的分工：SM-03-05 是数据源管理权限的双视角 + 实际访问边界闭环；
 * 本用例是用户视角 CRUD 主链路，无身份切换、无实际访问断言，查询回显使用共享
 * 工具的跨页版本。
 *
 * 关键要求：
 *   1. 全部为浏览器页面操作（无 fetch/axios 等接口直调）；
 *   2. 保存成功不以 toast 判定，一律以用户/资源两个视角的列表回显断言；
 *   3. 不使用永久 skip，不吞异常；页面结构与预期不符时保留明确失败。
 */
import type { Locator, Page } from '@playwright/test';
import { dbConfig, expect, test, uuid } from '../utils.js';
import {
  assignRoleToUser,
  createAndInviteUser,
  createRole,
  loginAs,
  newPermissionIdentity,
  newPermissionRole,
  openRoleManagement,
  openUserManagement,
} from './权限测试工具.js';
import {
  type MysqlPermissionResource,
  type UserViewSubjectTab,
  confirmPermissionDangerAction,
  deletePermissionFromRow,
  findPermissionRowAcrossPages,
  findResourceViewAuthorizationRow,
  openDataPermissionPage,
  openPermissionEditDialog,
  openPermissionTableMaxPageSize,
  openUserViewCreateDialog,
  queryUserViewPermissionRowAcrossPages,
  refreshPermissionList,
  resetPermissionTableToFirstPage,
  selectPermissionSource,
  selectPermissionSourceType,
  selectUserViewSubject,
  setPermissionExpiry,
  setPermissionTypes,
  submitPermissionDialog,
  submitPermissionEditDialog,
} from './数据权限闭环工具.js';
import { requirePermissionApprovalEnvironment } from './权限审批待调试工具.js';
import { clickVisible, expectSuccess, visible, visibleDialog } from '../抽样用例工具.js';

/* ------------------------------------------------------------------ 常量 */

const ADMIN_USER = process.env.TEST_USER ?? 'admin';
// 连接信息（DS-PERM-87）：以配置中心 DB_*（utils.dbConfig，e2e/test-environment.ts 解析）
// 为准，DATA_PERMISSION_* 仅作显式覆盖，不硬编码环境 IP/口令。未配置时用例内按
// 前置不足 skip（见用例本体门禁），非永久 skip。
const ROUND_DB = dbConfig();
const MYSQL_HOST = process.env.DATA_PERMISSION_HOST?.trim() || ROUND_DB?.host || '';
const MYSQL_PORT = String(process.env.DATA_PERMISSION_PORT?.trim() || ROUND_DB?.port || '');
const MYSQL_DB = process.env.DATA_PERMISSION_DATABASE?.trim() || ROUND_DB?.database || '';
const MYSQL_USER = process.env.DATA_PERMISSION_DB_USER?.trim() || ROUND_DB?.user || '';
const MYSQL_PASS = process.env.DATA_PERMISSION_DB_PASS?.trim() || ROUND_DB?.password || '';
const JDBC_URL =
  `jdbc:mysql://${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DB}`
  + '?allowMultiQueries=true&characterEncoding=utf-8';
/** MySQL 驱动类（新建第二步“驱动类”必填项；与后端 dataSourceProperties 存量值一致）。 */
const MYSQL_DRIVER = process.env.DATA_PERMISSION_DRIVER?.trim() || 'com.mysql.cj.jdbc.Driver';

/** 本轮唯一英文前缀数据源名（uuid 派生；授权/回收/删除都只认这个名字）。 */
const SOURCE_PREFIX = 'e2esm0307ds';
const SOURCE_NAME = `${SOURCE_PREFIX}_${uuid().replace(/-/g, '').slice(0, 10)}`;

/**
 * 本轮唯一 MySQL 数据源（kind=2 数据源权限，不涉及表级明细/字段范围）。
 * databaseName/schemaName 取配置中心解析结果，不再指向历史显示名；携带 tableName
 * 属配置串台，本用例的资源字面量从不设置它。
 */
const permissionResource: MysqlPermissionResource = {
  sourceTypeName: 'MYSQL',
  sourceName: SOURCE_NAME,
  databaseName: MYSQL_DB,
  schemaName: MYSQL_DB,
};

/** 管理员登录身份（执行脚本注入 TEST_USER/TEST_PASS；收尾回收时切回管理员）。 */
const adminIdentity = {
  userName: ADMIN_USER,
  nickname: ADMIN_USER,
  password: process.env.TEST_PASS ?? '',
  phone: '',
  email: '',
};

/** 用户视角主体定位参数（成员页签；与共享工具 selectUserViewSubject 入参同型）。 */
type SubjectOptions = {
  subjectTab: UserViewSubjectTab;
  subjectName: string;
  subjectAlias?: string;
};

/**
 * 编辑阶段使用近期未来日期：当前 CalendarPicker 为 readonly 日期控件，不能用
 * 2099 这类远期值逐月翻页（工具 setPermissionExpiry 限制 monthOffset ≤ 1），
 * +7 天跨月安全。回显断言只取日期段，避免时间控件版本差异造成秒级格式误报。
 */
const EDIT_EXPIRY_TIME = (() => {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 23:59:59`;
})();
const EDIT_EXPIRY_DATE = EDIT_EXPIRY_TIME.slice(0, 10);

/* ------------------------------------------------- 页面级 helper（用例内实现） */

/** 行内文本压缩读取（用于权限类型/资源名包含断言）。 */
async function rowText(row: Locator): Promise<string> {
  return (await row.innerText().catch(() => '')).replace(/\s+/g, '');
}

/**
 * 断言权限行（用户视角/资源视角）的权限类型恰为“管理”。
 * 数据源权限（kind=2）只承载 isManage，行内出现“使用”即说明落库内容与预期
 * 不符（例如误写了 kind=5 双标志记录），必须失败。行内主体名、数据源名均不含
 * “使用/管理”字样，文本级判断安全。
 */
async function expectRowManageOnly(row: Locator, context: string): Promise<void> {
  const raw = await row.innerText({ timeout: 5_000 }).catch(() => '');
  const normalized = raw.replace(/\s+/g, '');
  expect(normalized, `${context}：权限行应包含权限类型“管理”，实际行文本：${raw}`).toContain('管理');
  expect(
    normalized,
    `${context}：数据源权限只承载“管理”，行内不应出现“使用”，实际行文本：${raw}`,
  ).not.toContain('使用');
}

/** 断言权限行回显了编辑后的自定义截止时间（只比对日期段，避免秒级格式差异误报）。 */
async function expectRowCustomExpiry(row: Locator, context: string): Promise<void> {
  const raw = await row.innerText({ timeout: 5_000 }).catch(() => '');
  expect(
    raw,
    `${context}：权限行应回显自定义截止时间 ${EDIT_EXPIRY_DATE}，实际行文本：${raw}`,
  ).toContain(EDIT_EXPIRY_DATE);
}

/** 下拉选项通用可见选择器（Ant/Element 双兼容，与共享工具同款）。 */
const OPTION_SELECTOR = [
  '.ant-select-dropdown:visible .ant-select-item-option',
  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
  '.el-select-dropdown:visible .el-select-dropdown__item',
  '[role="listbox"]:visible [role="option"]',
].join(', ');

/** 通用表单文本填写：label → placeholder → 表单节点 三路兜底；返回是否命中。 */
async function fillField(scope: Locator, labels: string[], value: string): Promise<boolean> {
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

/** 通用下拉选择：按 label 定位表单项内 select，点开后按精确文本选选项。 */
async function pickSelectOption(
  scope: Locator,
  labels: string[],
  optionText: string,
): Promise<boolean> {
  for (const label of labels) {
    const item = scope
      .locator('.ant-form-item:visible, .el-form-item:visible')
      .filter({ hasText: label })
      .first();
    if (!(await item.isVisible().catch(() => false))) continue;
    const select = item
      .locator('.ant-select:visible, .el-select:visible, [role="combobox"]:visible')
      .first();
    if (!(await select.isVisible().catch(() => false))) continue;
    await select.click();
    const optionLoc = scope
      .page()
      .locator(OPTION_SELECTOR)
      .filter({ hasText: new RegExp(`^\\s*${optionText}\\s*$`) })
      .first();
    await optionLoc.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
    if (await optionLoc.isVisible().catch(() => false)) {
      await optionLoc.click();
      return true;
    }
    await scope.page().keyboard.press('Escape');
  }
  return false;
}

/** 打开 数据接入 → 数据源管理 页面。 */
async function openDataSourceManagement(page: Page): Promise<void> {
  await clickVisible(page, '数据接入');
  await clickVisible(page, '数据源管理');
  await page.waitForTimeout(1_200);
}

/** 管理员新建 MYSQL 数据源（表单字段多形态兜底；失败留明确错误）。 */
async function createRoundMysqlDataSource(page: Page, name: string): Promise<void> {
  await openDataSourceManagement(page);
  const newButton = (await visible(page.getByRole('button', { name: /新(建|增|添)|添加数据源/ })))
    ?? (await visible(page.getByText(/^(新(建|增|添)|添加数据源)$/, { exact: true })));
  if (!newButton) throw new Error('数据源管理页未找到“新建/新增”入口（可能受按钮权限控制）。');
  await newButton.click();
  const typeDialog = await visibleDialog(page);
  const mysqlCard = await visible(typeDialog.getByText(/MYSQL|MySQL/i).first());
  if (mysqlCard) {
    await mysqlCard.click();
  } else if (!await pickSelectOption(typeDialog, ['数据源类型', '类型', '数据库类型'], 'MYSQL')) {
    throw new Error('数据源新建弹窗未找到 MYSQL 类型选择入口（卡片与下拉均未命中）。');
  }
  // 新建为两步向导：第一步仅选类型，点“下一步”后才是名称/连接信息表单
  // （run-20260922-113651-980 快照实证：第一步含类型卡片 + 取消/下一步按钮）。
  const nextButton = await visible(typeDialog.getByRole('button', { name: /下一步/ }));
  if (nextButton) await nextButton.click();
  const dialog = await visibleDialog(page);
  if (!await fillField(dialog, ['数据源名称', '名称', '源名称'], name)) {
    throw new Error('数据源新建弹窗未找到“数据源名称”输入框。');
  }
  // 第二步表单（run-20260922-122802-480 trace 实证）：数据源名称/数据源描述/
  // 驱动类(必填)/链接地址(必填)/用户名(必填)/密码(必填) + Druid连接池参数(可选表格)；
  // 无 主机/端口/数据库名 字段，连接信息由 JDBC URL 承载。
  if (!await fillField(dialog, ['驱动类'], MYSQL_DRIVER)) {
    throw new Error('数据源新建弹窗未找到“驱动类”必填输入框。');
  }
  // 链接地址 = JDBC URL（产品标签为“链接地址”；主机/端口形态仅作旧页面兜底）。
  if (!await fillField(dialog, ['链接地址', 'URL', '连接地址', 'JDBC'], JDBC_URL)) {
    const hostOk = await fillField(dialog, ['主机', 'IP', '服务器'], MYSQL_HOST);
    await fillField(dialog, ['端口'], MYSQL_PORT);
    if (!hostOk) throw new Error('数据源新建弹窗既无 链接地址 也无 主机/IP 输入框，无法完成连接信息。');
  }
  if (!await fillField(dialog, ['用户名', '用户', '账号'], MYSQL_USER)) {
    throw new Error('数据源新建弹窗未找到“用户名”输入框。');
  }
  if (!await fillField(dialog, ['密码'], MYSQL_PASS)) {
    throw new Error('数据源新建弹窗未找到“密码”输入框。');
  }
  await fillField(dialog, ['备注', '描述'], `SM-03-07 DS-PERM-87 ${SOURCE_PREFIX}`);
  // 第二步底部按钮为 测试连接/上一步/确 定（trace 实证）：先测试连接（结果 toast 不作为
  // 通过依据，连接失败也允许继续提交，以最终“列表回显”为创建成功判据），再确 定 提交。
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

/**
 * 数据源“删除”二次确认弹窗：新版为高危操作弹窗，需在
 * input[placeholder="请输入DELETE"] 键入 DELETE 后点击“确 认”按钮
 * （run-20260922-125745-604 trace 实证；旧版“确 定”按钮已不存在）。
 */
async function confirmRemoveDataSource(page: Page): Promise<void> {
  const modal = page
    .locator('.ant-modal:visible, .el-dialog:visible, [role="dialog"]:visible')
    .last();
  await modal.waitFor({ state: 'visible', timeout: 8_000 });
  const typed = modal.locator('input[placeholder="请输入DELETE"]:visible').first();
  if (await typed.isVisible().catch(() => false)) {
    await typed.fill('DELETE');
  }
  await modal.getByRole('button', { name: /确\s*认|删\s*除/ }).last().click();
}

/**
 * 删除本轮唯一数据源（卡片级定位，严禁页面级删除图标兜底 —— 严禁误点共享源）。
 * 返回 deleted（已删除且复查卡片不再回显）/ absent（本来不存在）/ no-entry
 * （页面未提供删除入口，属产品能力缺口）/ delete-not-effective（点了删除但卡片仍在）。
 */
async function deleteRoundDataSource(
  page: Page,
  sourceName: string,
): Promise<'deleted' | 'absent' | 'no-entry' | 'delete-not-effective'> {
  await openDataSourceManagement(page);
  const card = page
    .locator('.data-source:visible')
    .filter({ hasText: sourceName })
    .first();
  if (!(await card.isVisible().catch(() => false))) return 'absent';
  const del = card
    .locator('[aria-label="图标: delete"], [aria-label*="delete" i], .anticon-delete, [class*="icon-delete"]')
    .first();
  if (!(await del.isVisible().catch(() => false))) return 'no-entry';
  await del.click();
  await confirmRemoveDataSource(page);
  await expectSuccess(page, /成功|删除/);
  await page.waitForTimeout(800);
  // 删除后按同名复查：卡片不再回显才算删除生效（与“列表回显为唯一证据”一致）。
  const again = page
    .locator('.data-source:visible')
    .filter({ hasText: sourceName })
    .first();
  return (await again.isVisible().catch(() => false)) ? 'delete-not-effective' : 'deleted';
}

/** 错误信息压缩为单行短文本（仅供清理步骤登记，不在清理路径抛出）。 */
function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * 触发“删除/移除”：行内文本按钮 → 行内图标（均严格限定在匹配行内）。
 * 不做页面级图标兜底：匹配行无删除入口时返回 false，由调用方按
 * “页面未提供删除入口”登记（不冒充业务断言失败），绝不点其他行的图标。
 */
async function clickDeleteAction(scope: Locator): Promise<boolean> {
  const textButton = scope.getByRole('button', { name: /删\s*除|移\s*除/ }).first();
  if (await textButton.isVisible().catch(() => false)) {
    await textButton.click();
    return true;
  }
  const rowIcon = scope
    .locator('[aria-label*="delete" i], [aria-label*="删除"], .anticon-delete, [class*="icon-delete"]')
    .first();
  if (await rowIcon.isVisible().catch(() => false)) {
    await rowIcon.click();
    return true;
  }
  return false;
}

/**
 * 在用户管理/角色管理页按唯一名称删除单个对象并复查列表。
 * 返回 deleted（已删除且复查不再回显）/ absent（本来不存在）/ no-entry（页面未
 * 提供删除入口，属产品能力缺口）/ delete-not-effective（点了删除但行仍在）。
 */
async function deleteNamedRow(
  page: Page,
  options: { queryName: string; name: string; openPage: () => Promise<void> },
): Promise<'deleted' | 'absent' | 'no-entry' | 'delete-not-effective'> {
  await options.openPage();
  const query = page.getByRole('textbox', { name: options.queryName }).first();
  await query.fill(options.name);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  const nameText = page.getByText(options.name, { exact: true }).last();
  await nameText.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
  if (!(await nameText.isVisible().catch(() => false))) return 'absent';
  const row = nameText.locator(
    'xpath=ancestor::*[self::tr or @role="row" or contains(@class,"el-table__row")][1]',
  );
  if (!(await clickDeleteAction(row))) return 'no-entry';
  await confirmPermissionDangerAction(page);
  await page.waitForTimeout(1_000);
  // 删除后按同名复查：列表不再回显才算删除生效（与“列表回显为唯一证据”一致）。
  await query.fill(options.name);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(1_000);
  const again = page.getByText(options.name, { exact: true }).last();
  return (await again.isVisible().catch(() => false)) ? 'delete-not-effective' : 'deleted';
}

/**
 * 用户视角回收本轮主体在本轮数据源上的全部授权行（同原阶段 1 结构：选主体 →
 * 开大分页 → 回第 1 页 → 跨页检索删除）。全新本轮组合正常 0 条，防御同键重试
 * 轮次。DS-PERM-87：返回 leftover——删除预算耗尽后仍回显 = 本步回收未完成，
 * 由调用方如实登记进 issues（不扩大删除范围，也不静默放行）。
 */
async function revokeRoundPermissions(
  page: Page,
  subjectOptions: SubjectOptions,
): Promise<{ removed: number; leftover: boolean }> {
  await openDataPermissionPage(page);
  await selectUserViewSubject(page, subjectOptions);
  await openPermissionTableMaxPageSize(page);
  await resetPermissionTableToFirstPage(page);
  await refreshPermissionList(page);
  let removed = 0;
  for (let guard = 0; guard < 5; guard += 1) {
    const stale = await findPermissionRowAcrossPages(page, SOURCE_NAME, 5_000);
    if (!stale) break;
    await deletePermissionFromRow(page, stale, { uniqueText: SOURCE_NAME });
    removed += 1;
    await resetPermissionTableToFirstPage(page);
    await refreshPermissionList(page);
  }
  const leftover = !!(await findPermissionRowAcrossPages(page, SOURCE_NAME, 3_000));
  return { removed, leftover };
}

/**
 * try/finally 兜底清理入口：只回收本轮 uuid 资产（授权行 e2esm0307ds_* × 本轮成员、
 * 本轮唯一数据源、本轮成员账号、本轮角色）。每步独立 try/catch：单步失败登记后
 * 继续下一步。DS-PERM-87 裁决口径：issues 非空 = 收尾未完成——通过路径必须判失败；
 * 主体失败路径在错误信息上附加 issues 证据后原样重抛（见用例 finally）。数据源/
 * 成员/角色“无删除入口”属产品能力缺口，登记为收尾未完成并参与裁决（不冒充业务
 * 断言失败，也不静默放行）。
 */
async function cleanupCaseObjects(
  page: Page,
  scope: { userName: string; roleName: string; subjectOptions: SubjectOptions },
): Promise<{ steps: string[]; issues: string[] }> {
  const steps: string[] = [];
  const issues: string[] = [];
  const runStep = async (
    name: string,
    action: () => Promise<{ ok: boolean; detail: string }>,
  ): Promise<void> => {
    try {
      const { ok, detail } = await action();
      steps.push(`${name}：${detail}`);
      if (!ok) issues.push(`${name}：${detail}`);
    } catch (error) {
      const detail = `失败：${describeError(error)}`;
      steps.push(`${name}：${detail}`);
      issues.push(`${name}：${detail}`);
    }
  };

  try {
    await loginAs(page, adminIdentity);
  } catch (error) {
    issues.push(`管理员重新登录失败，兜底清理中止：${describeError(error)}`);
    return { steps, issues };
  }

  await runStep('本轮授权回收（仅 本轮成员 × 本轮数据源）', async () => {
    const { removed, leftover } = await revokeRoundPermissions(page, scope.subjectOptions);
    return {
      ok: !leftover,
      detail: leftover
        ? `removed=${removed}；预算耗尽后仍回显本轮数据源授权行（回收未完成）`
        : `removed=${removed}；已无本轮数据源授权行`,
    };
  });
  await runStep('本轮数据源删除（仅本轮唯一命名 e2esm0307ds_*，卡片级定位）', async () => {
    const outcome = await deleteRoundDataSource(page, SOURCE_NAME);
    return {
      ok: outcome === 'deleted' || outcome === 'absent',
      detail: outcome === 'no-entry'
        ? 'no-entry（页面未提供删除入口，数据源残留在案）'
        : outcome === 'delete-not-effective'
          ? 'delete-not-effective（已提交删除但卡片仍回显）'
          : outcome,
    };
  });
  await runStep('本轮成员删除', async () => {
    const outcome = await deleteNamedRow(page, {
      queryName: '请输入用户名称',
      name: scope.userName,
      openPage: () => openUserManagement(page),
    });
    return {
      ok: outcome === 'deleted' || outcome === 'absent',
      detail: outcome === 'no-entry'
        ? 'no-entry（页面未提供删除/移除入口，成员残留在案）'
        : outcome,
    };
  });
  await runStep('本轮角色删除', async () => {
    const outcome = await deleteNamedRow(page, {
      queryName: '请输入角色名称',
      name: scope.roleName,
      openPage: () => openRoleManagement(page),
    });
    return {
      ok: outcome === 'deleted' || outcome === 'absent',
      detail: outcome === 'no-entry'
        ? 'no-entry（页面未提供删除入口，角色残留在案）'
        : outcome,
    };
  });
  return { steps, issues };
}

/* ------------------------------------------------------------------ 用例本体 */

test.describe.configure({ mode: 'serial', timeout: 600_000 });
test('SM-03-07｜系统管理｜用户视角数据源权限增查改删', async ({
  loginPage,
  consoleErrors,
  report,
}) => {
  requirePermissionApprovalEnvironment();
  // 门禁（DS-PERM-87）：本轮唯一数据源要求 DB_* 指向可直连 MySQL；未配置按前置
  // 不足 skip（写明原因，不伪造通过、不误报产品缺陷，非永久 skip）。
  if (!ROUND_DB || ROUND_DB.type !== 'mysql' || !MYSQL_USER || !MYSQL_PASS) {
    test.skip(
      !ROUND_DB || ROUND_DB.type !== 'mysql' || !MYSQL_USER || !MYSQL_PASS,
      `前置不足：未配置可直连 MySQL（DB_HOST=${process.env.DB_HOST ?? ''}，DB_TYPE=${process.env.DB_TYPE ?? ''}），`
        + '无法创建本轮唯一数据源（DS-PERM-87）。',
    );
    return;
  }
  const page = loginPage;

  // 本轮唯一主体/角色（uuid 唯一命名，只由本轮创建、收尾回收；声明在 try 外供收尾使用）。
  const subject = newPermissionIdentity('sm0307a');
  const subjectRole = newPermissionRole('sm0307', 'subject');
  const subjectOptions: SubjectOptions = {
    subjectTab: '成员',
    subjectName: subject.userName,
    subjectAlias: subject.nickname,
  };
  const rowQuery = { ...subjectOptions, resource: permissionResource };

  // 业务闭环主流程集中在一个闭包里：任何一处失败都会先进入下方 finally 执行兜底
  // 清理，再以原始错误结束用例（保留真实失败原因不被掩盖，DS-PERM-87）。
  let mainError: unknown;
  let mainFailed = false;
  try {
    // 阶段 0a：本轮唯一主体 —— 新建成员（创建+邀请）→ 新建角色（数据地图/数据查询
    // 菜单）→ 角色分配给成员。不依赖任何历史固化用户/角色。
    await createAndInviteUser(page, subject);
    await createRole(page, subjectRole, ['数据地图', '数据查询']);
    await assignRoleToUser(page, subjectRole, subject);
    await report(
      'SM-03-07 阶段0a｜创建本轮唯一主体与角色',
      true,
      `成员=${subject.userName}；角色=${subjectRole.roleName}（菜单=数据地图/数据查询，已分配给成员）。`,
    );

    // 阶段 0b（DS-PERM-87）：管理员创建本轮唯一 MySQL 数据源（JDBC 指向配置中心
    // DB_* 解析的库）；后续授权/回收仅针对该源，不再依赖历史共享数据源与固定连接信息。
    await createRoundMysqlDataSource(page, SOURCE_NAME);
    await report(
      'SM-03-07 阶段0b｜创建本轮唯一数据源',
      true,
      `数据源=${SOURCE_NAME}（JDBC 指向配置中心 DB_* 解析的库）；后续授权/回收仅针对该源。`,
    );

    // 阶段 1：清理同键（本轮数据源 × 本轮主体）残留（全新组合正常 0 条，防同键重试）。
    // 仅按本轮数据源名定位本轮授权行，不触碰其他数据。
    await openDataPermissionPage(page);
    const removedStale = await revokeRoundPermissions(page, subjectOptions);
    await report(
      'SM-03-07 阶段1｜残留权限清理',
      true,
      `主体=${subject.userName}；数据源=${SOURCE_NAME}；本轮清理残留记录 ${removedStale.removed} 条`
        + '（0=全新本轮组合首次执行；仅限本轮uuid资产）。',
    );

    // 阶段 2：用户视角新增数据源“管理”权限（固定勾选唯一数据源 + 永久）并跨页回显。
    // 数据源权限弹窗只渲染“管理”控件（页面已知形态），setPermissionTypes 对未渲染
    // 的“使用”自动跳过，不伪造成已配置。
    await selectUserViewSubject(page, subjectOptions);
    const createDialog = await openUserViewCreateDialog(page);
    await selectPermissionSourceType(page, createDialog, permissionResource.sourceTypeName);
    await selectPermissionSource(page, createDialog, permissionResource);
    await setPermissionTypes(page, createDialog, ['管理']);
    await setPermissionExpiry(page, createDialog, '永久');
    await submitPermissionDialog(page, createDialog);
    const createdRow = await queryUserViewPermissionRowAcrossPages(page, rowQuery);
    await expect(createdRow).toContainText(permissionResource.sourceName);
    await expectRowManageOnly(createdRow, '阶段2 用户视角回显');
    await report(
      'SM-03-07 阶段2｜用户视角新增“管理”并回显',
      true,
      `数据源=${permissionResource.sourceName}，权限类型=管理（不含使用），截止=永久。`,
    );

    // 阶段 3：资源视角（数据源页签）回显同一授权（授权用户 × 权限类型）。
    const resourceRow = await findResourceViewAuthorizationRow(page, {
      resource: permissionResource,
      subjectName: subject.userName,
      scopeTab: '数据源',
    });
    if (!resourceRow) {
      throw new Error(
        `资源视角（数据源页签）未回显用户 ${subject.userName} 对 ${permissionResource.sourceName} 的“管理”授权。`,
      );
    }
    await expectRowManageOnly(resourceRow, '阶段3 资源视角回显');
    await report(
      'SM-03-07 阶段3｜资源视角回显',
      true,
      `数据源=${permissionResource.sourceName} 的授权列表已出现 ${subject.userName}，权限类型=管理。`,
    );

    // 阶段 4：编辑权限截止时间（永久 → 自定义未来日期）并在两个视角回显。
    // 数据源权限弹窗只渲染“管理”，页面无“使用/管理”级别切换，不伪造权限级别修改；
    // 后端 permissionList 整体覆盖，编辑时显式保持“管理”勾选（漏勾会清权）。
    const beforeEditRow = await queryUserViewPermissionRowAcrossPages(page, rowQuery);
    await expectRowManageOnly(beforeEditRow, '阶段4 编辑前行复核');
    const editDialog = await openPermissionEditDialog(page, beforeEditRow);
    await submitPermissionEditDialog(page, editDialog, {
      permissionTypes: ['管理'],
      expiry: { customTime: EDIT_EXPIRY_TIME },
    });
    const editedRow = await queryUserViewPermissionRowAcrossPages(page, rowQuery);
    await expectRowManageOnly(editedRow, '阶段4 编辑后用户视角回显');
    await expectRowCustomExpiry(editedRow, '阶段4 编辑后用户视角回显');

    const resourceEditedRow = await findResourceViewAuthorizationRow(page, {
      resource: permissionResource,
      subjectName: subject.userName,
      scopeTab: '数据源',
    });
    if (!resourceEditedRow) {
      throw new Error(
        `编辑截止时间后，资源视角（数据源页签）未回显用户 ${subject.userName} 对 ${permissionResource.sourceName} 的授权。`,
      );
    }
    await expectRowManageOnly(resourceEditedRow, '阶段4 编辑后资源视角回显');
    await expectRowCustomExpiry(resourceEditedRow, '阶段4 编辑后资源视角回显');
    await report(
      'SM-03-07 阶段4｜编辑截止时间并双视角回显',
      true,
      `已编辑权限截止时间：永久 → ${EDIT_EXPIRY_TIME}；用户视角与资源视角均回显 管理 + ${EDIT_EXPIRY_DATE}。`
        + '（数据源权限页面无“使用/管理”级别切换，未伪造权限级别修改。）',
    );

    // 阶段 5：删除权限，双视角确认消失。删除后先回第 1 页再跨页检索，避免
    // “停留在后页、下一页已禁用”造成行仍存在的假阴性。
    const finalRow = await queryUserViewPermissionRowAcrossPages(page, rowQuery);
    await deletePermissionFromRow(page, finalRow, { uniqueText: permissionResource.sourceName });
    await resetPermissionTableToFirstPage(page);
    await refreshPermissionList(page);
    const ghostUserRow = await findPermissionRowAcrossPages(page, permissionResource.sourceName, 5_000);
    if (ghostUserRow) {
      throw new Error('删除权限后，用户视角（成员页签）仍回显该数据源授权行，删除可能未生效。');
    }
    const ghostResourceRow = await findResourceViewAuthorizationRow(page, {
      resource: permissionResource,
      subjectName: subject.userName,
      scopeTab: '数据源',
      timeoutMs: 8_000,
    });
    if (ghostResourceRow) {
      throw new Error(
        `删除权限后，资源视角（数据源页签）仍回显用户 ${subject.userName} 的授权行，删除可能未生效。`,
      );
    }
    await report(
      'SM-03-07 阶段5｜删除权限并双视角确认消失',
      true,
      '用户视角行已消失；资源视角授权行已消失。',
    );

    // 数据权限页的列表查询/删除会触发 dataPermission 系列请求，其 4xx 属预期
    // 过程信号（SM-03-05 已验证同型过滤）；其余控制台错误仍然失败。
    await assertNoUnexpectedConsoleErrors(consoleErrors, [
      /getCreatedDataSource|dataPermission\//,
      /没有(使用|管理)?权限/,
    ]);

    await report(
      'SM-03-07｜用户视角数据源权限增查改删完成',
      true,
      `资源=${permissionResource.sourceTypeName} ${permissionResource.sourceName}，主体=${subject.userName}；`
        + '已完成：新增管理→用户视角跨页查询→资源视角回显→编辑截止时间双视角回显→删除→双视角消失。'
        + '（kind=2 数据源权限不涉及“使用”与字段范围，不把数据源权限写成字段权限。）',
    );
  } catch (error) {
    mainError = error;
    mainFailed = true;
  } finally {
    // 收尾（DS-PERM-87）：仅回收本轮 uuid 资产（授权 → 数据源 → 成员 → 角色），
    // 逐项登记、单步失败不阻断其余回收；聚合裁决见下。
    let steps: string[] = [];
    let issues: string[] = [];
    try {
      ({ steps, issues } = await cleanupCaseObjects(page, {
        userName: subject.userName,
        roleName: subjectRole.roleName,
        subjectOptions,
      }));
    } catch (cleanupError) {
      issues.push(`收尾-清理器异常：${describeError(cleanupError)}`);
    }
    const cleanupNote = issues.join('；');
    if (steps.length > 0) {
      await report(
        'SM-03-07 收尾｜本轮资产回收',
        issues.length === 0,
        issues.length === 0
          ? steps.join('；')
          : `回收未完成留证：${cleanupNote}（已完成步骤：${steps.join('；')}）`,
      ).catch(() => undefined);
    }
    if (mainFailed) {
      if (cleanupNote && mainError instanceof Error) {
        mainError.message = `${mainError.message}｜[SM-03-07] 收尾回收未完成：${cleanupNote}`;
      } else if (cleanupNote) {
        console.warn(`[SM-03-07] 主流程错误非 Error 实例，收尾回收未完成留证：${cleanupNote}`);
      }
      throw mainError;
    }
    if (cleanupNote) {
      throw new Error(
        `[SM-03-07] 主流程通过，但收尾回收未完成（仅限本轮 uuid 资产，不触碰共享/历史资产）：${cleanupNote}`,
      );
    }
  }
});

/** 控制台错误门禁（本地复刻权威 utils 实现；同 SM-03-05/06 配置类用例口径）。 */
function assertNoUnexpectedConsoleErrors(consoleErrors: string[], allowedPatterns: RegExp[]): void {
  const unexpected = consoleErrors.filter(
    (message) => !allowedPatterns.some((pattern) => pattern.test(message)),
  );
  expect(unexpected, '出现未声明的控制台错误（允许清单之外）').toEqual([]);
}