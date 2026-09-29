/**
 * SM-03-05｜系统管理｜数据源“管理/使用”权限分离 + 实际访问闭环（DS-PERM-05 升级版）
 *
 * 相对旧静态版的升级点（任务-DS-PERM-05）：
 *   1. 不再只做 kind=2“管理”的静态回显：本轮覆盖“管理/使用”两条权限线，
 *      且新建数据源后核验“创建人自动获得 管理+使用 双授权”；
 *   2. 使用权限的实际访问必须由独立非管理员主体验证（自助查询可选 + SQL 真实执行）；
 *      管理权限的实际编辑/删除也必须由独立主体验证（数据源管理页改备注并删除该源）；
 *   3. 干净库自初始化：角色/用户/数据源全部用本用例唯一英文前缀（e2esm0305*）现场创建，
 *      不假设历史固化夹具仍存在；结尾删除本轮新建数据源（级联回收授权）。
 *
 * 业务模型依据（glm5.3-01 + 后端 DataSourceBizImpl/DataPermissionBizImpl 复核）：
 *   - 数据源权限 kind=2 只承载“管理”；数据表权限 kind=5 承载“使用/管理”；
 *     新建数据源时后端为创建人写入 源级管理 + 表级通配使用 记录，因此创建人双授权
 *     在数据权限页表现为：数据源页签=管理 行，数据表页签=使用 行；
 *   - 数据源“可使用”判定走 kind=5（checkSourceUsePermission）：无使用授权时，
 *     自助查询的数据源下拉整体不可见或无该源选项，两种表现都视为不可访问成立；
 *   - 数据源管理页的“新增/编辑/删除”受管理与按钮权限控制。
 *
 * 任务-DS-PERM-07（清洁环境第二轮闭环）升级点：
 *   4. 阶段 0–7 全程 try/finally 兜底清理：任一步失败都在本轮当场回收自建的
 *      e2esm0305* 前缀对象（主体授权行→数据源→用户→角色），中途失败也不得依赖
 *      “下一轮开头清理”；通过路径若仍有未回收对象则明确判失败。
 *   5. “页面未提供删除/移除入口”属产品能力缺口：登记进清理步骤与报告附件，
 *      不静默、也不冒充业务断言失败。
 *
 * 资源约定（DS-PERM-82 起为清洁环境自备）：连接参数从配置中心 DB_*（utils.dbConfig）
 *   解析，DATA_PERMISSION_* 仅作显式覆盖，不再硬编码环境 IP/口令；本轮数据源唯一
 *   命名 e2esm0305ds_*，专用表本轮直建直回收（e2esm0305tb_*），不依赖历史/共享资源。
 * 收尾失败上抛（DS-PERM-92）：收尾各步（授权回收/数据源/专用表/用户/角色）失败逐项
 *   收集且不阻断其余回收；主体成功而收尾未完成时用例必须失败；主体失败时保留原始
 *   错误实例（不掩盖主因），仅在错误信息上附加收尾回收证据后原样重抛。
 * 关键要求：全部浏览器页面操作；真实断言（列表回显 + 实际访问结果）；结尾回收本轮数据。
 */
import type { Locator, Page } from '@playwright/test';
import { chooseConfiguredDataSource, dbConfig, executeSql, expect, query, test, uuid } from '../utils.js';
import {
  assignRoleToUser,
  createRole,
  ensurePermissionUser,
  loginAs,
  newPermissionIdentity,
  newPermissionRole,
  openRoleManagement,
  openUserManagement,
} from './权限测试工具.js';
import {
  type MysqlPermissionResource,
  confirmPermissionDangerAction,
  deletePermissionFromRow,
  findPermissionRow,
  findResourceViewAuthorizationRow,
  openDataPermissionPage,
  openUserViewCreateDialog,
  refreshPermissionList,
  selectPermissionSource,
  selectPermissionSourceType,
  selectUserViewSubject,
  setPermissionExpiry,
  setPermissionTypes,
  submitPermissionDialog,
  switchResourceViewScopeTab,
} from './数据权限闭环工具.js';
import { clickVisible, expectSuccess, visible, visibleDialog } from '../抽样用例工具.js';

/* ------------------------------------------------------------------ 常量 */

const ADMIN_USER = process.env.TEST_USER ?? 'admin';
// 连接信息（DS-PERM-82）：以配置中心 DB_*（utils.dbConfig）为准，DATA_PERMISSION_*
// 仅作显式覆盖，不再硬编码环境 IP/口令兜底。DB_* 未配置或非 MySQL 时在用例内按
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
/** 本用例唯一英文前缀资源名（干净库自初始化；重跑残留按前缀回收）。 */
const SOURCE_PREFIX = 'e2esm0305ds';
const SOURCE_NAME = `${SOURCE_PREFIX}_${uuid().replace(/-/g, '').slice(0, 10)}`;
const EDIT_REMARK = `${SOURCE_PREFIX}_edited_${uuid().replace(/-/g, '').slice(0, 6)}`;
/** 数据表页签核验用本轮唯一专用表（DS-PERM-82：阶段0直建、收尾DROP，不指向历史/共享表）。 */
const PERMISSION_TABLE = `e2esm0305tb_${uuid().replace(/-/g, '').slice(0, 12)}`;
/** 下拉选项通用可见选择器（Ant/Element 双兼容，与共享工具同款）。 */
const OPTION_SELECTOR = [
  '.ant-select-dropdown:visible .ant-select-item-option',
  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
  '.el-select-dropdown:visible .el-select-dropdown__item',
  '[role="listbox"]:visible [role="option"]',
].join(', ');

const permissionResource: MysqlPermissionResource = {
  sourceTypeName: 'MYSQL',
  // DS-PERM-82：所有授权/回收/探针只针对本轮唯一新建数据源 e2esm0305ds_*；
  // 源删除级联回收创建人自动授权，不依赖任何历史/共享数据源。
  sourceName: SOURCE_NAME,
  databaseName: MYSQL_DB,
  schemaName: MYSQL_DB,
  // 资源视角“数据表”页签核验创建人表级通配使用授权需要具体代表表；
  // 工具 requirePermissionTableName 只认 resource.tableName（r2 失败实证）；
  // DS-PERM-82 起指向本轮唯一专用表（阶段0直建、收尾DROP）。
  tableName: PERMISSION_TABLE,
};

/** 管理员登录身份（执行脚本注入 TEST_USER/TEST_PASS）。 */
const adminIdentity = {
  userName: ADMIN_USER,
  nickname: ADMIN_USER,
  password: process.env.TEST_PASS ?? '',
  phone: '',
  email: '',
};
/* ------------------------------------------------- 页面级 helper（用例内实现） */

/** 行内文本压缩读取（用于权限类型/资源名包含断言）。 */
async function rowText(row: Locator): Promise<string> {
  return (await row.innerText().catch(() => '')).replace(/\s+/g, '');
}

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
async function createMysqlDataSource(page: Page, name: string): Promise<void> {
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
  await fillField(dialog, ['备注', '描述'], `SM-03-05 DS-PERM-05 ${SOURCE_PREFIX}`);
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
 * 与 scripts/清理并重建数据源.mjs:96-99 的已验证删除流程同源。
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
 * DS-PERM-82：配置库直建本轮唯一专用表（id/name/remark 三列 + 2 行种子）。
 * 表随用例轮次生灭：阶段 0 直建并种子化，收尾 DROP；COUNT≠种子数立即失败，
 * 绝不回退选择历史/共享表。
 */
async function createRoundPermissionTable(tableName: string): Promise<number> {
  await query(`CREATE TABLE ${tableName} (id INT PRIMARY KEY, name VARCHAR(64), remark VARCHAR(128))`);
  await query(
    `INSERT INTO ${tableName} (id, name, remark) VALUES (1, 'sm0305_a', 'seed-a'), (2, 'sm0305_b', 'seed-b')`,
  );
  const rows = await query(`SELECT COUNT(*) AS total FROM ${tableName}`);
  const total = Number(rows[0]?.total ?? 0);
  if (total !== 2) {
    throw new Error(`本轮专用表 ${tableName} 建表/种子写入后 COUNT=${total}（期望 2）。`);
  }
  return total;
}

/**
 * 回收上一轮残留的 e2esm0305 前缀数据源（仅限本用例前缀，不动共享资源）。
 * DS-PERM-92：返回 leftover——删除预算耗尽后本前缀卡片仍可见 = 本步回收未完成，
 * 由调用方如实登记进 issues（不扩大删除范围，也不静默放行）。
 */
async function purgeLeftoverSources(
  page: Page,
): Promise<{ removed: number; leftover: boolean }> {
  await openDataSourceManagement(page);
  let removed = 0;
  for (let guard = 0; guard < 5; guard += 1) {
    // 卡片级定位：数据源管理页卡片 .data-source（scripts/清理并重建数据源.mjs 同源），
    // 仅回收卡片文本含本用例前缀的卡片；严禁页面级删除图标兜底 —— r3 曾因该兜底
    // 误点首个共享源（192.168.76.113:13306/e2e_test）的删除图标。
    const card = page
      .locator('.data-source:visible')
      .filter({ hasText: new RegExp(`${SOURCE_PREFIX}_[0-9a-f]{6}`) })
      .first();
    if (!(await card.isVisible().catch(() => false))) {
      const staleText = page.getByText(new RegExp(`^${SOURCE_PREFIX}_`)).first();
      if (await staleText.isVisible().catch(() => false)) {
        throw new Error(
          '页面存在本用例前缀数据源但未匹配到 .data-source 卡片结构（页面结构已变化）；'
            + '已停止回收，不做页面级兜底以免误删共享数据源。',
        );
      }
      break;
    }
    const del = card
      .locator('[aria-label="图标: delete"], [aria-label*="delete" i], .anticon-delete, [class*="icon-delete"]')
      .first();
    if (!(await del.isVisible().catch(() => false))) {
      throw new Error(
        '本用例前缀数据源卡片存在但无删除入口（权限不足或页面结构变化）；'
          + '已停止回收，不做页面级兜底以免误删共享数据源。',
      );
    }
    await del.click();
    await confirmRemoveDataSource(page);
    await expectSuccess(page, /成功|删除/);
    removed += 1;
    await page.waitForTimeout(800);
  }
  // DS-PERM-92：预算耗尽后本前缀数据源卡片仍可见 = 回收未完成，如实上报。
  const leftoverCard = page
    .locator('.data-source:visible')
    .filter({ hasText: new RegExp(`${SOURCE_PREFIX}_[0-9a-f]{6}`) })
    .first();
  const leftover = await leftoverCard.isVisible().catch(() => false);
  return { removed, leftover };
}

/* ------------------- try/finally 兜底清理（任务-DS-PERM-07；仅本前缀对象） */

/** 错误信息压缩为单行短文本（仅供清理步骤登记，不在清理路径抛出）。 */
function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * 触发“删除/移除”：行内文本按钮 → 行内图标（均严格限定在匹配行内）。
 * 不做页面级图标兜底：匹配行无删除入口时返回 false，由调用方按
 * “页面未提供删除入口”登记（任务-DS-PERM-07 第 5 点），绝不点其他行的图标。
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

/** 按唯一英文前缀在列表页逐行清扫历史残留（上限 guard 次），返回删除数。 */
async function sweepRowsByPrefix(
  page: Page,
  options: { queryName: string; prefix: string; openPage: () => Promise<void>; guard: number },
): Promise<number> {
  let removed = 0;
  await options.openPage();
  for (let guard = 0; guard < options.guard; guard += 1) {
    const query = page.getByRole('textbox', { name: options.queryName }).first();
    await query.fill(options.prefix);
    await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
    const nameText = page.getByText(new RegExp(`^${options.prefix}`)).first();
    await nameText.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    if (!(await nameText.isVisible().catch(() => false))) break;
    const row = nameText.locator(
      'xpath=ancestor::*[self::tr or @role="row" or contains(@class,"el-table__row")][1]',
    );
    if (!(await clickDeleteAction(row))) break;
    await confirmPermissionDangerAction(page);
    await page.waitForTimeout(1_000);
    removed += 1;
  }
  return removed;
}

/**
 * 用户视角回收主体在目标源上的全部授权行（数据表/数据源两页签逐条删除）。
 * DS-PERM-92：返回 leftover——删除预算耗尽后目标源授权行仍可见 = 本步回收未完成，
 * 由调用方如实登记进 issues（不扩大删除范围，也不静默放行）。
 */
async function revokeSubjectPermissions(
  page: Page,
  subject: { userName: string; nickname: string },
): Promise<{ removed: number; leftover: boolean }> {
  await openDataPermissionPage(page);
  await selectUserViewSubject(page, {
    subjectTab: '成员' as const,
    subjectName: subject.userName,
    subjectAlias: subject.nickname,
  });
  let removed = 0;
  let leftover = false;
  for (const tab of ['数据表', '数据源'] as const) {
    await switchResourceViewScopeTab(page, tab);
    await refreshPermissionList(page);
    for (let guard = 0; guard < 5; guard += 1) {
      const stale = await findPermissionRow(page, SOURCE_NAME, 3_000);
      if (!stale) break;
      await deletePermissionFromRow(page, stale, { uniqueText: SOURCE_NAME });
      await refreshPermissionList(page);
      removed += 1;
    }
    // DS-PERM-92：预算耗尽后该页签仍回显目标源授权行 = 回收未完成，如实上报。
    if (await findPermissionRow(page, SOURCE_NAME, 3_000)) leftover = true;
  }
  return { removed, leftover };
}

/**
 * try/finally 兜底清理入口：只回收本用例唯一前缀对象（数据源 e2esm0305ds_*、
 * 专用表 e2esm0305tb_*、用户 e2e_sm0305_*、角色 r_sm030_us_* 及其授权行）。
 * 每步独立 try/catch：单步失败登记后继续下一步，保证中途失败也不遗留资源、不依赖
 * “下一轮开头清理”。DS-PERM-92 裁决口径：issues 非空 = 收尾未完成——通过路径必须
 * 判失败；主体失败路径在错误信息上附加 issues 证据后原样重抛（见用例 finally）。
 * 用户/角色“无删除入口”属产品能力缺口，登记为收尾未完成并参与上述裁决（不冒充
 * 业务断言失败，也不静默放行）。
 */
async function cleanupCaseObjects(
  page: Page,
  subject: { userName: string; nickname: string },
  roleName: string,
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

  await runStep('主体残留授权回收（用户视角数据表/数据源页签）', async () => {
    const { removed, leftover } = await revokeSubjectPermissions(page, subject);
    return {
      ok: !leftover,
      detail: leftover
        ? `removed=${removed}；预算耗尽后仍有目标源授权行（回收未完成）`
        : `removed=${removed}；两页签已无目标源授权行`,
    };
  });
  await runStep('本前缀数据源回收（e2esm0305ds_*）', async () => {
    const { removed, leftover } = await purgeLeftoverSources(page);
    return {
      ok: !leftover,
      detail: leftover
        ? `removed=${removed}；预算耗尽后仍有本前缀数据源卡片（回收未完成）`
        : `removed=${removed}；已无本前缀数据源`,
    };
  });
  await runStep('本轮专用表回收（DS-PERM-82，仅本轮唯一表）', async () => {
    await query(`DROP TABLE IF EXISTS ${PERMISSION_TABLE}`);
    return { ok: true, detail: `dropped=${PERMISSION_TABLE}` };
  });
  await runStep('本轮用户删除', async () => {
    const outcome = await deleteNamedRow(page, {
      queryName: '请输入用户名称',
      name: subject.userName,
      openPage: () => openUserManagement(page),
    });
    const swept = await sweepRowsByPrefix(page, {
      queryName: '请输入用户名称',
      prefix: 'e2e_sm0305_',
      openPage: () => openUserManagement(page),
      guard: 5,
    });
    return {
      ok: outcome === 'deleted' || outcome === 'absent',
      detail: outcome === 'no-entry'
        ? `no-entry（页面未提供删除/移除入口，用户残留在案）；历史前缀清扫 swept=${swept}`
        : `${outcome}；历史前缀清扫 swept=${swept}`,
    };
  });
  await runStep('本轮角色删除', async () => {
    const outcome = await deleteNamedRow(page, {
      queryName: '请输入角色名称',
      name: roleName,
      openPage: () => openRoleManagement(page),
    });
    const swept = await sweepRowsByPrefix(page, {
      queryName: '请输入角色名称',
      prefix: 'r_sm030_us_',
      openPage: () => openRoleManagement(page),
      guard: 5,
    });
    return {
      ok: outcome === 'deleted' || outcome === 'absent',
      detail: outcome === 'no-entry'
        ? `no-entry（页面未提供删除入口，角色残留在案）；历史前缀清扫 swept=${swept}`
        : `${outcome}；历史前缀清扫 swept=${swept}`,
    };
  });
  return { steps, issues };
}
/** 进入自助查询页（e2e/utils.ts 未导出权威实现，本地最小复刻）。 */
async function openSelfServiceQuery(page: Page): Promise<void> {
  const base = process.env.BASE_URL;
  if (!base) throw new Error('缺少 BASE_URL，无法进入自助查询页。');
  await page.goto(
    `${base.replace(/\/+$/, '')}/#/dataQuery/selfServiceQuery`,
    { waitUntil: 'domcontentloaded', timeout: 30_000 },
  );
  await page.waitForTimeout(1_500);
}

/** 负向探针：打开数据源下拉，断言目标源不可选（未授权 → 不可见/无该源选项）。 */
async function assertSourceAbsentInSelfQuery(page: Page, sourceName: string): Promise<void> {
  await openSelfServiceQuery(page);
  const combo = (await visible(page.getByPlaceholder(/选\s*择\s*数\s*据\s*源|请选择数据源/)))
    ?? (await visible(page.locator('.ant-select:visible, .el-select:visible').first()));
  if (!combo) throw new Error('自助查询页未找到数据源下拉控件，无法做未授权负向验证。');
  await combo.click();
  await page.waitForTimeout(1_000);
  const options = page.locator(OPTION_SELECTOR);
  const count = await options.count();
  const texts: string[] = [];
  for (let i = 0; i < count; i += 1) texts.push(await options.nth(i).innerText().catch(() => ''));
  const leaked = texts.filter((t) => t.includes(sourceName));
  expect(
    leaked,
    `未授权主体在自助查询数据源下拉仍可见目标源 ${sourceName}（选项=${texts.join('、')}）。`,
  ).toEqual([]);
  await page.keyboard.press('Escape');
}

/** 控制台错误过滤：数据权限/数据源已知 4xx 过程信号放行，其余必须为空。 */
async function assertNoUnexpectedConsoleErrors(
  consoleErrors: string[],
  allow: RegExp[],
): Promise<void> {
  const unexpected = consoleErrors.filter((message) => !allow.some((re) => re.test(message)));
  expect(unexpected, `出现意外控制台错误：${unexpected.join(' | ')}`).toEqual([]);
}
/* ------------------------------------------------------------------ 用例本体 */

test.describe.configure({ mode: 'serial', timeout: 600_000 });

test.describe('SM-03-05｜系统管理｜数据源管理/使用权限分离与实际访问闭环', () => {
  test('SM-03-05｜数据源管理/使用权限分离与实际访问闭环（DS-PERM-07）', async ({
    loginPage,
    consoleErrors,
    report,
  }, testInfo) => {
    const page = loginPage;
    test.setTimeout(600_000);
    const subject = newPermissionIdentity('sm0305');
    const subjectRole = newPermissionRole('sm0305req', 'use');
    const subjectOptions = {
      subjectTab: '成员' as const,
      subjectName: subject.userName,
      subjectAlias: subject.nickname,
    };
    // 门禁（DS-PERM-82）：本轮唯一数据源/专用表要求 DB_* 指向可直连 MySQL；
    // 未配置按前置不足跳过（写明原因，不伪造通过、不误报产品缺陷，非永久 skip）。
    if (!ROUND_DB || ROUND_DB.type !== 'mysql' || !MYSQL_USER || !MYSQL_PASS) {
      test.skip(
        !ROUND_DB || ROUND_DB.type !== 'mysql' || !MYSQL_USER || !MYSQL_PASS,
        `前置不足：未配置可直连 MySQL（DB_HOST=${process.env.DB_HOST ?? ''}，DB_TYPE=${process.env.DB_TYPE ?? ''}），`
          + '无法创建本轮唯一数据源与专用表（DS-PERM-82）。',
      );
      return;
    }
    // 业务闭环主流程（阶段 0–7）集中在一个闭包里：任何一处失败都会先进入下方
    // finally 执行兜底清理，再以原始错误结束用例（保留真实失败原因不被掩盖）。
    const runClosedLoop = async (): Promise<void> => {

    // 阶段 0：干净库自初始化 —— 唯一英文前缀 角色+用户+菜单；回收本用例残留源；
    // 直建本轮唯一专用表（DS-PERM-82：不依赖历史/共享表）。
    const seededRows = await createRoundPermissionTable(PERMISSION_TABLE);
    const { removed: removedSources } = await purgeLeftoverSources(page);
    await createRole(page, subjectRole, ['数据接入', '数据查询']);
    await ensurePermissionUser(page, subject);
    await assignRoleToUser(page, subjectRole, subject);
    await report(
      'SM-03-05 阶段0｜前置初始化（唯一英文前缀角色/用户/菜单）',
      true,
      `角色=${subjectRole.roleName}；用户=${subject.userName}；菜单=数据接入/数据查询（模块级，含数据源管理与自助查询子页）；`
        + `专用表=${PERMISSION_TABLE}（MySQL 直建，种子 ${seededRows} 行）；`
        + `回收本用例前缀残留数据源 ${removedSources} 个。`,
    );

    // 阶段 1：管理员新建数据源，并在数据权限页核验“创建人 管理+使用 双授权”。
    await createMysqlDataSource(page, SOURCE_NAME);
    await openDataPermissionPage(page);
    const creatorSourceRow = await findResourceViewAuthorizationRow(page, {
      resource: permissionResource,
      subjectName: ADMIN_USER,
      scopeTab: '数据源',
    });
    if (!creatorSourceRow) {
      throw new Error(`新建数据源后，资源视角(数据源页签)未回显创建人 ${ADMIN_USER} 的授权行。`);
    }
    const creatorSourceTypes = await rowText(creatorSourceRow);
    expect(creatorSourceTypes, '创建人在数据源页签的权限类型应含“管理”').toContain('管理');
    const creatorTableRow = await findResourceViewAuthorizationRow(page, {
      resource: permissionResource,
      subjectName: ADMIN_USER,
      scopeTab: '数据表',
    });
    if (!creatorTableRow) {
      throw new Error(`新建数据源后，资源视角(数据表页签)未回显创建人 ${ADMIN_USER} 的表级授权行。`);
    }
    const creatorTableTypes = await rowText(creatorTableRow);
    expect(creatorTableTypes, '创建人在数据表页签的权限类型应含“使用”').toContain('使用');
    await report(
      'SM-03-05 阶段1｜新建数据源 + 创建人双授权核验',
      true,
      `数据源=${SOURCE_NAME}；创建人 ${ADMIN_USER}：数据源页签行含“管理”，数据表页签行含“使用”。`,
    );

    // 阶段 2：独立主体授权前负向探针 —— 自助查询数据源下拉无该源（使用权限未授予）。
    await loginAs(page, subject);
    await assertSourceAbsentInSelfQuery(page, SOURCE_NAME);
    await report(
      'SM-03-05 阶段2｜使用权限授予前负向探针',
      true,
      `主体=${subject.userName} 未获“使用”授权：自助查询数据源下拉不可见 ${SOURCE_NAME}。`,
    );

    // 阶段 3：管理员授予“使用”（数据表范围、数据表留空 → 源级通配 kind=5 使用记录），
    // 并核验资源视角(数据表页签)回显主体“使用”授权。
    await loginAs(page, adminIdentity);
    await openDataPermissionPage(page);
    await selectUserViewSubject(page, subjectOptions);
    const useDialog = await openUserViewCreateDialog(page);
    const tableScopeText = useDialog.getByText('数据表', { exact: true }).last();
    await expect(tableScopeText, '权限弹窗未找到“数据表”资源范围切换文本。')
      .toBeVisible({ timeout: 5_000 });
    await tableScopeText.click();
    await page.waitForTimeout(600);
    await selectPermissionSourceType(page, useDialog, permissionResource.sourceTypeName);
    await selectPermissionSource(page, useDialog, permissionResource);
    // 数据表留空：落库为该源全表通配的使用记录（与 一次性授权-数据源使用权限-工具 一致）。
    await setPermissionTypes(page, useDialog, ['使用']);
    await setPermissionExpiry(page, useDialog, '永久');
    await submitPermissionDialog(page, useDialog);
    const subjectUseRow = await findResourceViewAuthorizationRow(page, {
      resource: permissionResource,
      subjectName: subject.userName,
      scopeTab: '数据表',
    });
    if (!subjectUseRow) {
      throw new Error(`授予“使用”后，资源视角(数据表页签)未回显主体 ${subject.userName} 的授权行。`);
    }
    const subjectUseTypes = await rowText(subjectUseRow);
    expect(subjectUseTypes, '主体的数据表页签权限类型应含“使用”').toContain('使用');
    await report(
      'SM-03-05 阶段3｜授予“使用”并回显',
      true,
      `数据表范围（表留空=源级通配）已授予 使用；资源视角数据表页签回显主体 ${subject.userName} 行含“使用”。`,
    );

    // 阶段 4：独立主体正向实际访问 —— 自助查询该源可选 + SQL 真实执行成功。
    await loginAs(page, subject);
    await openSelfServiceQuery(page);
    await chooseConfiguredDataSource(page, {
      type: permissionResource.sourceTypeName,
      name: SOURCE_NAME,
      schema: false,
    });
    await executeSql(page, 'SELECT 1 AS e2e_sm0305_probe');
    await report(
      'SM-03-05 阶段4｜“使用”权限实际访问（独立主体验证）',
      true,
      `主体=${subject.userName} 在自助查询可选 ${SOURCE_NAME} 并真实执行 SELECT 1 成功（kind=5 使用权限实际生效）。`,
    );

    // 阶段 5：管理员授予“管理”（数据源范围 kind=2），资源视角(数据源页签)回显主体授权。
    await loginAs(page, adminIdentity);
    await openDataPermissionPage(page);
    await selectUserViewSubject(page, subjectOptions);
    const manageDialog = await openUserViewCreateDialog(page);
    await selectPermissionSourceType(page, manageDialog, permissionResource.sourceTypeName);
    await selectPermissionSource(page, manageDialog, permissionResource);
    await setPermissionTypes(page, manageDialog, ['管理']);
    await setPermissionExpiry(page, manageDialog, '永久');
    await submitPermissionDialog(page, manageDialog);
    const subjectManageRow = await findResourceViewAuthorizationRow(page, {
      resource: permissionResource,
      subjectName: subject.userName,
      scopeTab: '数据源',
    });
    if (!subjectManageRow) {
      throw new Error(`授予“管理”后，资源视角(数据源页签)未回显主体 ${subject.userName} 的授权行。`);
    }
    const subjectManageTypes = await rowText(subjectManageRow);
    expect(subjectManageTypes, '主体的数据源页签权限类型应含“管理”').toContain('管理');
    await report(
      'SM-03-05 阶段5｜授予“管理”并回显',
      true,
      `数据源范围已授予 管理；资源视角数据源页签回显主体 ${subject.userName} 行含“管理”。`,
    );

    // 阶段 6：独立主体“管理”权限实际编辑/删除（数据源管理页）。
    await loginAs(page, subject);
    await openDataSourceManagement(page);
    const sourceText = page.getByText(SOURCE_NAME, { exact: true }).first();
    await expect(sourceText, '主体在数据源管理页未看到目标数据源（管理权限/菜单未生效）。')
      .toBeVisible({ timeout: 15_000 });
    const sourceRow = sourceText.locator(
      'xpath=ancestor::*[self::tr or @role="row" or contains(@class,"card")][1]',
    );
    const editButton = (await visible(sourceRow.getByRole('button', { name: /编\s*辑/ })))
      ?? (await visible(sourceRow.locator('[aria-label*="edit" i], .anticon-edit, [class*="icon-edit"]').first()));
    if (!editButton) throw new Error('主体视角下目标数据源行未提供“编辑”操作（管理权限未实际生效）。');
    await editButton.click();
    const editDialog = await visibleDialog(page);
    if (!await fillField(editDialog, ['备注', '描述'], EDIT_REMARK)) {
      throw new Error('数据源编辑弹窗未找到“备注/描述”可编辑项。');
    }
    await editDialog.getByRole('button', { name: /确\s*定|保\s*存/ }).last().click();
    await expectSuccess(page, /成功|保存|编辑/);
    await report(
      'SM-03-05 阶段6a｜“管理”权限实际编辑（独立主体验证）',
      true,
      `主体=${subject.userName} 将数据源 ${SOURCE_NAME} 备注改为 ${EDIT_REMARK} 并保存成功。`,
    );

    const deleteButton = (await visible(sourceRow.getByRole('button', { name: /删\s*除/ })))
      ?? (await visible(sourceRow.locator('[aria-label*="delete" i], .anticon-delete, [class*="icon-delete"]').first()));
    if (!deleteButton) throw new Error('主体视角下目标数据源行未提供“删除”操作（管理权限未实际生效）。');
    await deleteButton.click();
    // 新版删除确认为键入 DELETE + “确 认”（run-20260922-125745-604 trace 实证），
    // 旧版“确 定”按钮分支已移除。
    await confirmRemoveDataSource(page);
    await expectSuccess(page, /成功|删除/);
    await expect(
      page.getByText(SOURCE_NAME, { exact: true }).first(),
      '主体删除数据源后列表仍回显该源，删除未生效。',
    ).toBeHidden({ timeout: 15_000 });
    await report(
      'SM-03-05 阶段6b｜“管理”权限实际删除（独立主体验证）',
      true,
      `主体=${subject.userName} 删除数据源 ${SOURCE_NAME} 成功；列表不再回显。`,
    );

    // 阶段 7：级联回收核验 —— 数据源删除后，数据权限页不再回显主体/创建人授权行。
    await loginAs(page, adminIdentity);
    await openDataPermissionPage(page);
    const ghostSubject = await findResourceViewAuthorizationRow(page, {
      resource: permissionResource,
      subjectName: subject.userName,
      scopeTab: '数据源',
      timeoutMs: 6_000,
    });
    if (ghostSubject) {
      throw new Error(`删除数据源后，数据权限页仍回显主体 ${subject.userName} 的授权行，级联回收未生效。`);
    }
    const ghostCreator = await findResourceViewAuthorizationRow(page, {
      resource: permissionResource,
      subjectName: ADMIN_USER,
      scopeTab: '数据源',
      timeoutMs: 6_000,
    });
    if (ghostCreator) {
      throw new Error(`删除数据源后，数据权限页仍回显创建人 ${ADMIN_USER} 的授权行，级联回收未生效。`);
    }
    await report(
      'SM-03-05 阶段7｜删除数据源后权限级联回收核验',
      true,
      '数据权限页（数据源页签）已无主体与创建人的授权行，随源删除级联回收。',
    );

    // 数据权限页查询/删除与自助查询的 4xx 属预期过程信号；其余控制台错误仍然失败。
    await assertNoUnexpectedConsoleErrors(consoleErrors, [
      /getCreatedDataSource|dataPermission\//,
      /没有(使用|管理)?权限/,
    ]);

    await report(
      'SM-03-05｜数据源管理/使用权限分离与实际访问闭环完成',
      true,
      `资源=${SOURCE_NAME}（MYSQL ${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DB}），主体=${subject.userName}；`
        + '已完成：自初始化角色/用户→新建数据源→创建人双授权核验→使用授权前负向→使用授权后实际查询→'
        + '管理授权后实际编辑/删除→级联回收核验。',
    );
    };

    // 收尾兜底（任务-DS-PERM-07）：先执行阶段 0–7 主流程，再在 finally 中当场回收
    // 全部 e2esm0305* 前缀对象，禁止依赖“下一轮开头清理”。主流程失败时保留原始错误
    // 并在 finally 后原样重抛；清理框架自身的异常只登记，绝不覆盖原始失败原因。
    // DS-PERM-92 收尾裁决：收尾任一步失败只收集、不掩盖主因；主体成功 + 收尾未完成
    // 必须判失败；主体失败保留原始错误实例并在其信息上附加收尾回收证据。
    const cleanup: { steps: string[]; issues: string[] } = { steps: [], issues: [] };
    let flowError: unknown;
    let flowFailed = false;
    try {
      await runClosedLoop();
    } catch (error) {
      flowFailed = true;
      flowError = error;
    } finally {
      try {
        const result = await cleanupCaseObjects(page, subject, subjectRole.roleName);
        cleanup.steps.push(...result.steps);
        cleanup.issues.push(...result.issues);
      } catch (cleanupError) {
        cleanup.issues.push(`兜底清理框架异常：${describeError(cleanupError)}`);
      }
      await testInfo
        .attach('sm0305-finally-cleanup.log', {
          body: cleanup.steps.join('\n') || '（无清理步骤记录）',
          contentType: 'text/plain',
        })
        .catch(() => undefined);
      await report(
        'SM-03-05 收尾｜try/finally 兜底清理（仅回收 e2esm0305* 本前缀对象）',
        cleanup.issues.length === 0,
        cleanup.steps.join('；') || '无可回收对象（本轮未产生资源）。',
      );
      // 统一裁决①（主体成功路径，DS-PERM-92）：仍存在未回收对象 = 清理未闭环，
      // 必须判失败（清洁环境口径：收尾失败不得以通过收场）；失败路径不在此抛出，
      // 避免覆盖主流程的原始失败原因。
      if (!flowFailed && cleanup.issues.length > 0) {
        throw new Error(`兜底清理未完全回收本用例对象：${cleanup.issues.join('；')}`);
      }
    }
    // 统一裁决②（主体失败路径，DS-PERM-92）：保留原始错误实例原样重抛（不掩盖主因、
    // 不改判 skip/fail 语义），仅当存在收尾未完成时在 Error 信息上附加收尾回收证据。
    if (flowFailed) {
      if (flowError instanceof Error && cleanup.issues.length > 0) {
        flowError.message = `${flowError.message}（另：本轮收尾回收未完全成功：${cleanup.issues.join('；').slice(0, 600)}）`;
      }
      throw flowError;
    }
  });
});






