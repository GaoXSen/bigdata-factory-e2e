/**
 * DS-01-06 数据接入·数据源按钮权限 + 创建者管理/使用双授权 + 自助查询真实取数
 *
 * 业务契约（已确认，后端源码锚点 dataservice-biz）：
 * - DataSourceBizImpl.createDataSource（约 L400-458）：新增数据源成功后按当前登录人
 *   自动写入两条数据权限（insertPermission ×2）：permissionKind=2（管理）与
 *   permissionKind=5（管理、使用），subject 为当前用户（SubjectTypeEnum.USER），
 *   fieldRange=ALL（页面回显“全部字段”），expireTime 2099-12-31，数据源级通配（无表名）。
 * - 系统服务 DataPermissionServiceImpl.checkSourceUsePermission（L351-416）：自助查询
 *   候选源须存在 permissionKind=5 且 isUse=1 且未过期的授权；
 *   DataSourceBizImpl.querySourceInfoWithUse（L618-628）对 querySourceInfo(type)
 *   逐源剔除“无任一使用授权”的源。
 * - 因此：创建者对“自己新增的数据源”必须同时拥有管理权（可改/删）与使用权
 *   （该源进入自助查询数据源候选池）。
 *
 * 2026-09-22 改版前首轮实证：旧断言（卡片无“使用”标签、自助查询候选池不含新源）
 * 全部通过，说明当时部署后端未落“创建者自动 kind=5 使用授权”这条确认过的规则。
 * 本用例按确认后的契约重写，并对以下验收目标做真实闭环：
 *   1) 负向：仅有“数据源管理”菜单、无新增按钮权限的用户，在数据源管理页
 *      看不到“添加数据源”按钮（按钮权限未下发则按钮不渲染）；
 *   2) 正向：获“数据源管理（含按钮级联）+自助查询”菜单的创建者可以新增数据源；
 *   3) 权限页双视角交叉回显创建者两条授权（DS-PERM-42）：资源视角按源过滤 +
 *      用户视角按成员过滤，均应出现 kind=2 管理行（恰为“管理”，全部字段，
 *      不得残留“使用”）与 kind=5 源级通配使用行（含“使用”）；
 *   4) 创建者进入自助查询：数据源候选池必须包含新源，并对其执行真实只读 SELECT，
 *      结果区回显本轮注入的 marker；
 *   5) 结尾清理全部本轮前缀对象（数据源、2 个角色、2 个用户），清理失败如实上抛，
 *      不伪造通过；发现与契约不符时给出页面证据（真实产品问题）。
 *
 * 2026-09-22 DS-PERM-42 清洁环境重构：
 * - 主库物理连接改经 '../utils.js' 的 dbConfig() 取得（内部即 e2e/test-environment.ts
 *   配置中心：profile 基线 + DB_* 兼容变量覆盖，凭据仅来自进程环境变量；硬链接
 *   双路径下两份 utils 镜像同构，spec 内不再持有固定 IP、端口、库名兜底）；
 *   入口/管理员账号走兼容变量 ENTRY_URL/TEST_USER/TEST_PASS（与配置中心同源）；
 * - 测试账号口令与 e2e/sm-static/权限测试工具.ts 的 permissionPassword 同口径
 *   （仅从 SM_PERMISSION_PASSWORD 读取，不提供公开默认口令）；
 * - 创建者双授权增加用户视角（成员）交叉回显；所有资源仍为本轮唯一 ASCII 名称
 *   并可在 finally 回收，不依赖历史数据源/固定用户/角色/残留数据权限。
 */
import { assertNoConsoleErrors, chooseConfiguredDataSource, clickMenu, dbConfig, executeSql, expect, test, uuid } from '../utils.js';
import type { Locator, Page } from '@playwright/test';
import {
  clickCardAction,
  clickVisible,
  confirmDangerDialog,
  expectSuccess,
  visible,
  visibleDialog,
} from '../抽样用例工具.js';

const MYSQL = 'MYSQL';
// 新建测试账号口令：与 e2e/sm-static/权限测试工具.ts 的 permissionPassword 同口径
// （仅从 SM_PERMISSION_PASSWORD 读取；缺失时跳过）。
const TEST_PASSWORD = process.env.SM_PERMISSION_PASSWORD?.trim() || '';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, '').trim();
}

async function firstVisible(locatorOptions: Locator[]): Promise<Locator | undefined> {
  for (const option of locatorOptions) {
    if (await option.isVisible().catch(() => false)) return option;
  }
  return undefined;
}

/**
 * 由入口 URL 推导 hash 路由地址（应用为 hash 路由：base#/route），兼容 cmd 注入的尾随空格。
 * 入口取兼容变量 ENTRY_URL（与 e2e/test-environment.ts 的 app.entryUrl 同源；兜底值沿用
 * 配置中心 DEFAULT_ENTRY_URL 的基址。硬链接双路径下不能直接 import 配置中心，故走兼容变量）。
 */
function entryFor(hash: string): string {
  const base = (process.env.ENTRY_URL ?? 'http://bigdata.dev.northking.net/bigdata-ui-factory/')
    .trim()
    .split('#')[0]
    .replace(/\/+$/, '');
  return `${base}/#${hash}`;
}

/** 本轮唯一账号/角色（用户名做唯一键；昵称在前端可能截断展示，不做断言键）。 */
function makeIdentity(caseKey: 'noBtn' | 'creator') {
  const suffix = uuid().slice(0, 6);
  const digits = uuid().replace(/\D/g, '').padEnd(8, '7').slice(0, 8);
  return {
    caseKey,
    // 后端校验：用户名称长度必须介于 2 和 20 之间（超长会被确定按钮拦截）
    userName: `ds6_${caseKey}_${suffix}`,
    nickname: `ds6_${caseKey}_${suffix}`,
    password: TEST_PASSWORD,
    phone: `138${digits}`,
    email: `e2e_ds06_${suffix}@example.test`,
    roleName: `ds6_role_${caseKey}_${suffix}`,
  };
}

/** 收集作用域内可见文本，用于失败/差异证据（限长，避免刷屏）。 */
async function dumpVisibleTexts(scope: Locator | Page, selector: string, limit = 40): Promise<string> {
  const texts: string[] = [];
  const candidates = scope.locator(selector);
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, limit); index += 1) {
    const text = (await candidates.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (text) texts.push(text);
  }
  return texts.join(' | ').slice(0, 900) || '（无可见文本）';
}

/** 占位符可含正则的填充辅助（抽样用例工具.fillPlaceholder 仅接受字符串占位符）。 */
async function fillByPlaceholder(page: Page, placeholder: string | RegExp, value: string): Promise<void> {
  const field = page.getByPlaceholder(placeholder, { exact: false }).last();
  await expect(field).toBeVisible({ timeout: 10_000 });
  await field.fill(value);
}
/** 在指定弹窗/容器内把下拉精确选中为某个选项（按文本匹配，不依赖 option 下标）。 */
async function chooseExactDropdownOption(page: Page, scope: Locator, option: string): Promise<void> {
  const box = (await visible(scope.locator('input[placeholder*="类型" i], .el-select, [role="combobox"]'))) ?? scope;
  await box.click();
  const dropdown = page.getByRole('option').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(option)}\\s*$`) }).last();
  const exactOption = await firstVisible([dropdown, scope.locator(`.el-select-dropdown__item:visible:text-is("${option}")`)]);
  if (exactOption) {
    await exactOption.click();
    return;
  }
  const anyOption = scope.locator('.el-select-dropdown__item:visible').filter({ hasText: option }).last();
  await expect(anyOption).toBeVisible({ timeout: 15_000 });
  await anyOption.click();
}

/** 点空白处收起遗留下拉，避免遮挡后续点击。 */
async function dismissOpenDropdown(page: Page): Promise<void> {
  const body = page.locator('body');
  await page.mouse.move(0, 0);
  await body.click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.waitForTimeout(400);
}

/** 自助查询页残留下拉清理：连续 Escape + 空白点击，直到页面上没有展开的 el-select 下拉。 */
async function settleSelfQueryDropdowns(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const openDropdown = await visible(page.locator('.el-select-dropdown:visible, .el-picker-panel:visible'));
    if (!openDropdown) return;
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.mouse.click(10, 10);
    await page.waitForTimeout(500);
  }
}

/** 点击数据权限页指定页签节点（用户视角 / 资源视角 / 数据源 / 数据表）。 */
async function clickPermissionTabNode(page: Page, tabName: string): Promise<void> {
  const tab = page.getByText(tabName, { exact: true }).first();
  await expect(tab).toBeVisible({ timeout: 15_000 });
  await tab.click();
}

/** 定位包含指定文本的权限行所在行容器（表格行结构可能在不同前端版本间变化）。 */
function rowContainerOf(page: Page, text: string): Locator {
  return page.getByText(text, { exact: true }).first().locator('xpath=ancestor-or-self::*[self::tr or contains(@class,"el-table__row") or contains(@class,"row")][1]');
}

async function findPermissionRowByText(page: Page, text: string): Promise<Locator> {
  const rows = page.locator('.el-table__row:visible, tr:visible').filter({ hasText: text });
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  return rows.first();
}

/** 收集包含指定文本的全部可见行文本（同一授权可能按聚合方式回显为多行）。 */
async function collectPermissionRowTexts(page: Page, text: string): Promise<string[]> {
  const rows = page.locator('.el-table__row:visible, tr:visible').filter({ hasText: text });
  const texts: string[] = [];
  const count = await rows.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    texts.push(normalizeText(await rows.nth(index).innerText().catch(() => '')));
  }
  return texts.filter(Boolean);
}

/** 点选数据权限页页签（优先 tab 语义节点，兼容纯文本节点；与 sm-static 权限工具同口径）。 */
async function clickPermissionTabPage(page: Page, tabName: string): Promise<void> {
  const structured = page
    .locator('[role="tab"]:visible, .ant-tabs-tab:visible, .el-tabs__item:visible')
    .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(tabName)}\\s*$`) })
    .first();
  if (await structured.isVisible().catch(() => false)) {
    await structured.click();
    await page.waitForTimeout(500);
    return;
  }
  await clickPermissionTabNode(page, tabName);
}

/**
 * 用户视角（成员）选择主体，并收集其权限列表中命中指定资源名的行文本。
 * 主体列表可能分页/远程搜索：先用主体搜索框缩小范围（找不到搜索框时直接按
 * 本轮唯一账号文本定位），点击主体后权限行按资源唯一名过滤；行渲染滞后时
 * 给一次重试窗口。找不到主体时抛错（由调用方按证据口径归入 problems）。
 */
async function collectUserViewPermissionRows(page: Page, userName: string, resourceName: string): Promise<string[]> {
  await clickPermissionTabPage(page, '用户视角');
  await clickPermissionTabPage(page, '成员');
  const inputs = page.locator('input:visible');
  const inputCount = await inputs.count().catch(() => 0);
  for (let index = 0; index < inputCount; index += 1) {
    const box = inputs.nth(index);
    const placeholder = await box.getAttribute('placeholder').catch(() => null);
    const ariaLabel = await box.getAttribute('aria-label').catch(() => null);
    if (/用户名|成员|主体|搜索|名称/.test(`${placeholder ?? ''}${ariaLabel ?? ''}`)) {
      await box.fill(userName);
      await page.waitForTimeout(600);
      break;
    }
  }
  const subjectNode = page.getByText(userName, { exact: true }).last();
  await expect(subjectNode).toBeVisible({ timeout: 15_000 });
  await subjectNode.click();
  await page.waitForTimeout(800);
  let rows = await collectPermissionRowTexts(page, resourceName);
  if (rows.length === 0) {
    await page.waitForTimeout(1_500);
    rows = await collectPermissionRowTexts(page, resourceName);
  }
  return rows;
}

async function gotoAppHashRoute(page: Page, hash: string): Promise<void> {
  // 与既有用例一致：page.url().split('#')[0] 为基址；应用为 hash 路由，
  // 兜底剔除历史误拼出的路径式路由尾巴，保证目标 URL 幂等不累积。
  const base = page
    .url()
    .split('#')[0]
    .replace(/(\/systemManage|\/dataQuery|\/dataAccess|\/dataAnalysis)(\/.*)?$/, '')
    .replace(/\/+$/, '');
  const target = `${base}/#${hash}`;
  if (page.url() !== target) {
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
  }
}

async function openDataPermissionPage(page: Page): Promise<void> {
  await gotoAppHashRoute(page, '/systemManage/userPermission/dataPermission');
  await expect(page.getByText('数据权限', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('tab', { name: '用户视角' })).toBeVisible({ timeout: 30_000 });
}

async function openSelfServiceQueryPage(page: Page): Promise<void> {
  await gotoAppHashRoute(page, '/dataQuery/selfServiceQuery');
  await expect(page.getByRole('button', { name: /选择数据源/ }).first()).toBeVisible({ timeout: 30_000 });
}

/** 进入系统管理子页面，按就绪判据轮询（hash 直达渲染残留时 reload 兜底一次）。 */
async function openManagePage(page: Page, hash: string, ready: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (await ready()) return;
    await gotoAppHashRoute(page, hash);
    await page.waitForTimeout(600);
    if (await ready()) return;
    if (attempt >= 2) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
      await page.waitForTimeout(1_000);
    }
  }
  throw new Error(`未能进入${label}页面（${hash}），当前 URL：${page.url()}`);
}

/**
 * 数据源管理页按钮可见性探测（负向校验核心）。
 * 受限账号可能没有任何源卡片（源列表按权限过滤），因此页面就绪判据是
 * 主体内容出现“数据源”字样，再开 8 秒窗口探测“添加数据源”是否出现。
 */
async function probeDataSourceManagementPage(page: Page): Promise<{ bodyReady: boolean; addSeen: boolean; bodySnippet: string }> {
  await page.waitForTimeout(2_500);
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const bodyReady = /数据源/.test(bodyText);
  let addSeen = false;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const button = page.getByRole('button', { name: /添加数据源|新增数据源/ }).first();
    const textNode = page.getByText(/添加数据源|新增数据源/).filter({ visible: true }).first();
    if ((await button.isVisible().catch(() => false)) || (await textNode.isVisible().catch(() => false))) {
      addSeen = true;
      break;
    }
    await page.waitForTimeout(400);
  }
  return { bodyReady, addSeen, bodySnippet: bodyText.replace(/\s+/g, ' ').slice(0, 300) };
}
async function findUserRow(page: Page, userName: string): Promise<Locator | undefined> {
  const query = page.getByRole('textbox', { name: '请输入用户名称' }).first();
  await query.fill(userName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  // 用户列表同时存在表格与 div-table 两种实现且会异步刷新；用户名是唯一值，
  // 以真正可见的单元格为准，在查询后的合理窗口内轮询。
  const userTexts = page.getByText(userName, { exact: true });
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    for (let index = (await userTexts.count()) - 1; index >= 0; index -= 1) {
      const text = userTexts.nth(index);
      if (await text.isVisible().catch(() => false)) return text;
    }
    await page.waitForTimeout(250);
  }
  return undefined;
}

async function openUserManagement(page: Page): Promise<void> {
  await openManagePage(
    page,
    '/systemManage/userPermission/userManage',
    () => page.getByRole('button', { name: /新增用户|邀请用户/ }).first().isVisible().catch(() => false),
    '用户管理',
  );
}

/** 新建全局用户并邀请进当前组织（与 sm-static 权限测试工具同口径的页面操作）。 */
async function createUserAndInvite(page: Page, identity: { userName: string; nickname: string; phone: string; email: string; password: string }): Promise<void> {
  await clickVisible(page, '新增用户');
  const dialog = await visibleDialog(page);
  await dialog.getByPlaceholder('请输入用户名称').fill(identity.userName);
  await page.getByRole('textbox', { name: '请输入用户昵称' }).last().fill(identity.nickname);
  await dialog.getByPlaceholder('请输入手机号码').fill(identity.phone);
  await page.getByRole('textbox', { name: '请输入邮箱' }).last().fill(identity.email);
  await page.getByRole('textbox', { name: '请输入用户密码' }).last().fill(identity.password);
  const gender = page.getByRole('textbox', { name: '请选择性别' }).last();
  if (await gender.isVisible().catch(() => false)) {
    await gender.click();
    const male = page.getByRole('listitem').filter({ hasText: /^男$/ }).last();
    if (await male.isVisible().catch(() => false)) await male.click();
  }
  // 新增时不指定组织；组织关系由后续“邀请用户”写入当前活动组织。
  await page.mouse.move(0, 0);
  await dialog.getByRole('button', { name: /^确\s*定$/ }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expectSuccess(page, /成功|新增/);

  // 邀请进当前组织：下拉只加载前几条用户，必须按唯一账号远程筛选。
  await clickVisible(page, '邀请用户');
  const invite = await visibleDialog(page);
  const inviteSelector = invite.getByRole('textbox', { name: '请选择用户' });
  await inviteSelector.click();
  await inviteSelector.fill(identity.userName);
  await page.waitForTimeout(500);
  const option = page.getByRole('listitem').filter({ hasText: new RegExp(escapeRegExp(identity.userName)) }).last();
  if (!(await option.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const dump = await dumpVisibleTexts(invite, '.el-select-dropdown__item:visible, li:visible');
    throw new Error(`新建用户“${identity.userName}”未出现在邀请候选列表中；候选可见项：${dump}`);
  }
  await option.click();
  await invite.getByRole('button', { name: /^确\s*定$/ }).click();
  await expectSuccess(page, /成功/);
  await expect(invite).toBeHidden({ timeout: 10_000 });
  if (!(await findUserRow(page, identity.userName))) {
    throw new Error(`用户“${identity.userName}”邀请后未出现在当前组织用户列表中。`);
  }
}
async function openRoleManagement(page: Page): Promise<void> {
  await openManagePage(
    page,
    '/systemManage/userPermission/roleManage',
    () => page.getByRole('button', { name: /新建|新增/ }).first().isVisible().catch(() => false),
    '角色管理',
  );
}

async function findRoleRow(page: Page, roleName: string): Promise<Locator | undefined> {
  const query = page.getByRole('textbox', { name: '请输入角色名称' }).first();
  await query.fill(roleName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  const nameTexts = page.getByText(roleName, { exact: true });
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    for (let index = (await nameTexts.count()) - 1; index >= 0; index -= 1) {
      const text = nameTexts.nth(index);
      if (await text.isVisible().catch(() => false)) return text;
    }
    await page.waitForTimeout(250);
  }
  return undefined;
}

/** 勾选角色菜单树中的一个菜单节点；节点不存在返回 false（供可选菜单回退）。 */
async function selectRoleMenuNode(page: Page, dialog: Locator, menuName: string): Promise<boolean> {
  const text = dialog.getByText(menuName, { exact: true }).last();
  if (!(await text.isVisible().catch(() => false))) return false;
  let scope = text;
  for (let level = 0; level < 6; level += 1) {
    // Element Tree 的实际可点击对象是 tree-node__content，原生 checkbox 会被其包裹
    const clickable = await visible(scope.locator('..').locator('.el-tree-node__content, label.el-checkbox'));
    if (clickable) {
      await clickable.click();
      await page.waitForTimeout(500);
      return true;
    }
    scope = scope.locator('..');
  }
  throw new Error(`角色菜单树中“${menuName}”找不到可点击的复选区域。`);
}

/**
 * 取消某菜单节点下按钮级联勾选（按节点文本过滤）。
 * 返回被取消勾选的节点文本列表（供报告留痕，证明按钮权限确实未下发）。
 */
async function excludeRoleMenuChildren(page: Page, dialog: Locator, parentNodeName: string, excludePattern: RegExp): Promise<string[]> {
  const parentContent = dialog.locator('.el-tree-node__content').filter({ hasText: parentNodeName }).last();
  if (!(await parentContent.isVisible().catch(() => false))) return [];
  const parentNode = parentContent.locator('xpath=ancestor::*[contains(@class,"el-tree-node")][1]');
  // 展开父节点，确保按钮子节点已渲染
  const expander = parentContent.locator('.el-tree-node__expand-icon').first();
  if (await expander.isVisible().catch(() => false)) {
    await expander.click().catch(() => undefined);
    await page.waitForTimeout(500);
  }
  const excluded: string[] = [];
  const childContents = parentNode.locator('.el-tree-node__content');
  const count = await childContents.count();
  for (let index = 0; index < count; index += 1) {
    const content = childContents.nth(index);
    const label = normalizeText(await content.innerText().catch(() => ''));
    if (!label || !excludePattern.test(label) || label === normalizeText(parentNodeName)) continue;
    const native = content.locator('input[type="checkbox"]').first();
    if (!(await native.count())) continue;
    if (!(await native.isChecked().catch(() => false))) continue;
    const checkboxLabel = content.locator('xpath=ancestor::label[contains(@class,"el-checkbox")][1]');
    if (await checkboxLabel.count()) {
      await checkboxLabel.first().click({ force: true });
    } else {
      await native.setChecked(false, { force: true }).catch(() => undefined);
    }
    await expect(native).not.toBeChecked({ timeout: 5_000 });
    excluded.push(label);
  }
  return excluded;
}
/** 新建角色并勾选菜单；“数据源管理”必须成功（否则用例无业务入口），其余按 fallbackFor 回退。 */
async function createRoleWithMenus(
  page: Page,
  roleName: string,
  menuNames: string[],
  options: { fallbackFor?: Record<string, string>; excludeUnder?: { nodeName: string; pattern: RegExp } } = {},
): Promise<{ granted: string[]; missing: string[]; excluded: string[] }> {
  await clickVisible(page, /新建|新增/);
  const dialog = await visibleDialog(page);
  await fillByPlaceholder(page, '请输入角色名称', roleName);
  const roleKey = dialog.getByRole('textbox', { name: /请输入权限字符|请输入角色标识|请输入角色编码/ }).last();
  if (await roleKey.isVisible().catch(() => false)) {
    await roleKey.fill(`ds06_${uuid().slice(0, 8)}`);
  }
  const granted: string[] = [];
  const missing: string[] = [];
  for (const menuName of menuNames) {
    let target = menuName;
    if (!(await selectRoleMenuNode(page, dialog, target)) && options.fallbackFor?.[menuName]) {
      target = options.fallbackFor[menuName] as string;
    }
    if (await selectRoleMenuNode(page, dialog, target)) {
      granted.push(menuName);
      if (target !== menuName) granted.push(`${menuName}→${target}（回退）`);
    } else {
      missing.push(menuName);
    }
  }
  if (!granted.includes('数据源管理')) {
    const dump = await dumpVisibleTexts(dialog, '.el-tree-node__content:visible');
    throw new Error(`角色“${roleName}”未能勾选数据源管理菜单；缺失：${missing.join('、') || '（未知）'}；菜单树可见节点：${dump}`);
  }
  let excluded: string[] = [];
  if (options.excludeUnder) {
    excluded = await excludeRoleMenuChildren(page, dialog, options.excludeUnder.nodeName, options.excludeUnder.pattern);
  }
  await page.mouse.move(0, 0);
  await dialog.getByRole('button', { name: /^确\s*定$/ }).click();
  await expectSuccess(page, /(成功|新增)/);
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  if (!(await findRoleRow(page, roleName))) {
    throw new Error(`角色“${roleName}”保存后未出现在角色列表中。`);
  }
  return { granted, missing, excluded };
}

/** 在角色列表把角色分配给指定用户（“分配用户”入口，兼容“更多”二级菜单）。 */
async function assignRoleToUser(page: Page, roleName: string, identity: { userName: string }): Promise<void> {
  if (!(await findRoleRow(page, roleName))) throw new Error(`角色“${roleName}”未找到，无法分配用户。`);
  const row = page.locator('.el-table__row:visible, tr:visible').filter({ hasText: roleName }).first();
  await clickVisible(row, /分配用户|更多/, { timeoutMs: 8_000 });
  let dialog = await visibleDialog(page).catch(() => undefined);
  if (!dialog) {
    const menuItem = page.getByText('分配用户', { exact: true }).last();
    if (await menuItem.isVisible().catch(() => false)) {
      await menuItem.click();
      dialog = await visibleDialog(page);
    }
  }
  if (!dialog) {
    throw new Error(`角色“${roleName}”未能打开分配用户弹窗；页面文本：${await dumpVisibleTexts(page, '.el-dialog:visible, .ant-modal:visible')}`);
  }
  const search = dialog.getByPlaceholder(/请输入用户名称|请输入用户昵称|搜索用户/).first();
  if (await search.isVisible().catch(() => false)) {
    await search.fill(identity.userName);
    await page.waitForTimeout(600);
  }
  const userCell = dialog.getByText(identity.userName, { exact: false }).first();
  await expect(userCell).toBeVisible({ timeout: 20_000 });
  const rowScope = userCell.locator('xpath=ancestor-or-self::*[self::tr or contains(@class,"el-table__row") or contains(@class,"row")][1]');
  const checkbox = rowScope.first().locator('input[type="checkbox"], label.el-checkbox').first();
  await checkbox.click({ force: true });
  await clickVisible(dialog, /^确\s*定$/, { timeoutMs: 8_000 });
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  // 分配完成后角色行应回显该用户名
  await expect
    .poll(async () => ((await row.innerText().catch(() => '')).includes(identity.userName) ? 'assigned' : 'pending'), {
      timeout: 15_000,
      message: `角色“${roleName}”分配用户后未回显“${identity.userName}”`,
    })
    .toBe('assigned');
}
/**
 * 切换登录账号：清空旧会话 → 从指定入口进入登录表单 → 提交凭据。
 * 登录完成判据与 sm-static 权限工具 loginAs 相同：页面出现该账号的用户名/昵称。
 * 受限账号若入口路由无权限，SPA 落入 404 时不会出现身份标识，此时如实报错。
 */
async function switchLogin(
  page: Page,
  account: { userName: string; password: string; nickname?: string },
  entryUrl: string,
  label: string,
): Promise<void> {
  await page.context().clearCookies().catch(() => undefined);
  await page.goto('about:blank').catch(() => undefined);
  // 清理上一账号遗留的本地会话，避免 SPA 沿用旧 token 跳过登录表单
  await page
    .evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    })
    .catch(() => undefined);
  const lastErrors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch (error) {
      lastErrors.push(String(error).slice(0, 200));
      if (page.isClosed()) throw error;
    }
    const passwordInput = page.locator('input[type="password"]').first();
    if (await passwordInput.isVisible({ timeout: 15_000 }).catch(() => false)) {
      const usernameInput = page.getByRole('textbox', { name: /账号|用户名/ }).first();
      const fallbackUsernameInput = page
        .locator('input[type="text"], input[placeholder*="用户" i], input[placeholder*="账号" i]')
        .first();
      const activeUsernameInput = (await usernameInput.count()) ? usernameInput : fallbackUsernameInput;
      await activeUsernameInput.fill(account.userName);
      await passwordInput.fill(account.password);
      await page.getByRole('button', { name: /登\s*录|sign\s*in/i }).first().click();
    }
    // 登录完成判据：页面出现该账号的身份标识（用户名或昵称）
    const markers = [account.userName, account.nickname].filter(Boolean) as string[];
    try {
      await expect
        .poll(async () => {
          const bodyText = await page.locator('body').innerText().catch(() => '');
          return markers.some((marker) => bodyText.includes(marker)) ? 'ok' : 'pending';
        }, {
          timeout: 25_000,
          message: `${label}(${account.userName}) 登录后页面未出现该账号身份标识（可能入口路由对该账号不可见），当前 URL：${page.url()}`,
        })
        .toBe('ok');
      return;
    } catch (error) {
      lastErrors.push(String(error).slice(0, 300));
      // 首屏渲染停滞兜底：reload 一次再走完整流程
    }
  }
  throw new Error(
    `切换账号 ${label}(${account.userName}) 未能到达业务页（入口 ${entryUrl}）。` +
      `可能原因：入口路由对该账号不可见/账号密码错误/首屏渲染异常。累计错误：${lastErrors.join(' || ').slice(0, 600)}`,
  );
}

/** 行内删除确认弹窗：有“请输入”校验输入框时走 confirmDangerDialog，否则直接确认。 */
async function confirmRowDeleteDialog(page: Page): Promise<void> {
  const dialog = await visibleDialog(page);
  const input = dialog.getByPlaceholder(/请输入/).last();
  if (await input.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await confirmDangerDialog(page);
    return;
  }
  await clickVisible(dialog, /确\s*认|确\s*定/, { timeoutMs: 8_000 });
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

/** 在用户/角色管理页按唯一文本检索并删除该行（清理环节共用）。 */
async function deleteSubjectRow(page: Page, options: { queryName: string; uniqueText: string; label: string }): Promise<void> {
  const query = page.getByRole('textbox', { name: options.queryName }).first();
  if (!(await query.isVisible().catch(() => false))) {
    const byPlaceholder = page.getByPlaceholder(options.queryName).first();
    if (!(await byPlaceholder.isVisible().catch(() => false))) {
      throw new Error(`${options.label}列表未找到查询框“${options.queryName}”；页面输入框：${await dumpVisibleTexts(page, 'input:visible', 20)}`);
    }
    await byPlaceholder.fill(options.uniqueText);
  } else {
    await query.fill(options.uniqueText);
  }
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(600);
  const row = page.locator('.el-table__row:visible, tr:visible').filter({ hasText: options.uniqueText }).first();
  if (!(await row.isVisible().catch(() => false))) {
    throw new Error(`${options.label}列表未找到“${options.uniqueText}”（可能已被清理）。`);
  }
  await clickVisible(row, /删\s*除/, { timeoutMs: 8_000 });
  await confirmRowDeleteDialog(page);
  await expect
    .poll(async () => ((await row.isVisible().catch(() => false)) ? 'present' : 'gone'), {
      timeout: 12_000,
      message: `${options.label}“${options.uniqueText}”删除确认后仍存在于列表中`,
    })
    .toBe('gone');
}
test('DS-01-06 数据接入：新增按钮权限（负向）+ 创建者管理/使用双授权 + 自助查询真实取数', async ({ loginPage, page, consoleErrors, report }) => {
  test.setTimeout(720_000);

  // ==================== 环境门禁 ====================
  // DS-PERM-42：主库物理连接经 '../utils.js' 的 dbConfig() 取得（内部即
  // e2e/test-environment.ts 配置中心：profile mysql110-ftp113 基线 + DB_* 覆盖，
  // 凭据仅来自进程环境变量；本 spec 硬链接双路径下两份 utils 镜像同构，均可解析）；
  // 入口/管理员账号走兼容变量 ENTRY_URL/TEST_USER/TEST_PASS（与配置中心同源）。
  // spec 内不再持有固定 IP、端口、库名；凭据缺失时按前置不足显式 skip，不伪造通过。
  const primaryDb = dbConfig();
  if (!primaryDb || !primaryDb.user || !primaryDb.password) {
    test.skip(true, '缺少 DB_USER/DB_PASS（dbConfig() 经 e2e/test-environment.ts 解析主库连接），无法执行真实数据源新增与自助查询取数闭环。');
    return;
  }
  const admin = {
    userName: (process.env.TEST_USER ?? 'admin').trim(),
    password: (process.env.TEST_PASS ?? '').trim(),
  };
  if (!admin.password) {
    test.skip(true, '缺少 TEST_PASS（兼容变量，与配置中心 accounts 同源），无法执行多账号权限闭环。');
    return;
  }
  if (!TEST_PASSWORD) {
    test.skip(true, '缺少 SM_PERMISSION_PASSWORD，无法创建本轮权限测试用户。');
    return;
  }
  const dbHost = primaryDb.host;
  const dbPort = String(primaryDb.port);
  const dbName = primaryDb.database;
  const dbUser = primaryDb.user;
  const dbPass = primaryDb.password;
  await loginPage;

  const noBtnUser = makeIdentity('noBtn');
  const creator = makeIdentity('creator');
  // 本轮唯一英文前缀资源（数据源名做唯一键；昵称在前端可能截断展示，不做断言键）。
  const sourceName = `e2e_ds06_src_${uuid().slice(0, 6)}`;
  const sqlMarker = `${sourceName}-ok`;

  const problems: string[] = [];
  const cleanupErrors: string[] = [];
  let sourceCreated = false;
  let sourceCard = page.locator('.data-source:visible').filter({ hasText: sourceName }).first();
  const rolesCreated: string[] = [];
  const usersCreated: string[] = [];
  let mainError: unknown;

  try {
    // ==================== 阶段 1：管理员创建两个测试用户 ====================
    await openUserManagement(page);
    await createUserAndInvite(page, noBtnUser);
    usersCreated.push(noBtnUser.userName);
    await report('创建无按钮权限用户', true, noBtnUser.userName);
    await createUserAndInvite(page, creator);
    usersCreated.push(creator.userName);
    await report('创建创建者用户', true, creator.userName);

    // ==================== 阶段 2：创建两个角色并绑定用户 ====================
    await openRoleManagement(page);
    // 角色 1：仅“数据源管理”菜单；级联勾选后把新增类按钮节点取消勾选
    const noBtnRole = await createRoleWithMenus(page, noBtnUser.roleName, ['数据源管理'], {
      excludeUnder: { nodeName: '数据源管理', pattern: /^(添加|新增)(数据源)?(按钮)?$/ },
    });
    rolesCreated.push(noBtnUser.roleName);
    await report(
      '创建无新增按钮权限角色',
      true,
      `已勾选菜单：${noBtnRole.granted.join('、')}；级联后取消按钮节点：${noBtnRole.excluded.join('、') || '（树中未发现按钮级节点，负向以下一步页面探测为准）'}`,
    );
    // 角色 2：数据源管理（含按钮级联）+ 自助查询；自助查询节点缺失时回退勾选“数据查询”组
    const creatorRole = await createRoleWithMenus(page, creator.roleName, ['数据源管理', '自助查询'], {
      fallbackFor: { 自助查询: '数据查询' },
    });
    rolesCreated.push(creator.roleName);
    await report('创建创建者角色（含自助查询菜单）', true, `已勾选菜单：${creatorRole.granted.join('、')}${creatorRole.missing.length ? `；缺失：${creatorRole.missing.join('、')}` : ''}`);

    await assignRoleToUser(page, noBtnUser.roleName, noBtnUser);
    await report('绑定角色（无按钮用户）', true, `${noBtnUser.roleName} → ${noBtnUser.userName}`);
    await assignRoleToUser(page, creator.roleName, creator);
    await report('绑定角色（创建者）', true, `${creator.roleName} → ${creator.userName}`);

    // ==================== 阶段 3：负向 —— 无按钮权限者看不到“添加数据源” ====================
    await switchLogin(page, noBtnUser, entryFor('#/dataAccess/dataSource'), '无按钮权限用户');
    const probe = await probeDataSourceManagementPage(page);
    if (!probe.bodyReady) {
      problems.push(`无按钮权限用户落地页未渲染出数据源管理内容，负向校验证据不足。页面文本：${probe.bodySnippet}`);
    }
    if (probe.addSeen) {
      problems.push(
        `负向失败：仅有“数据源管理”菜单（已取消新增按钮级联）的账号 ${noBtnUser.userName} 仍能看到“添加数据源”入口。` +
          '按钮权限未按角色裁剪属于产品问题（角色-功能权限应控制按钮渲染）。',
      );
    }
    await report(
      '无按钮权限用户不可见“添加数据源”',
      !probe.addSeen && probe.bodyReady,
      probe.addSeen ? '按钮仍然可见（产品问题）' : `8 秒观察窗内按钮未出现；页面片段：${probe.bodySnippet}`,
    );
    // ==================== 阶段 4：创建者新增数据源（按钮权限 + 管理权闭环） ====================
    await switchLogin(page, creator, entryFor('#/dataAccess/dataSource'), '创建者');
    await clickVisible(page, /添加数据源|新增数据源/, { timeoutMs: 15_000 });
    await page.waitForTimeout(1_000);
    const addCard = page.locator('.data-source:visible').filter({ hasText: /添加数据源|新增数据源|配置数据源/ }).first();
    await expect(addCard).toBeVisible({ timeout: 20_000 });
    await addCard.click();
    await page.waitForTimeout(1_000);
    const sourceDialog = await visibleDialog(page);
    await fillByPlaceholder(page, '请输入数据源名称', sourceName);
    await expect(sourceDialog.getByText(sourceName)).toBeVisible({ timeout: 10_000 });
    const typeDialog = await visibleDialog(page);
    await chooseExactDropdownOption(page, typeDialog, MYSQL);
    await expect(typeDialog.getByText(MYSQL).first()).toBeVisible({ timeout: 20_000 });
    await fillByPlaceholder(page, /请输入主机|请输入IP/, dbHost);
    await fillByPlaceholder(page, /请输入端口|请输入port/i, dbPort);
    await fillByPlaceholder(page, /请输入数据库名|请输入schema名|请输入库/i, dbName);
    await fillByPlaceholder(page, /请输入用户名|请输入账号/, dbUser);
    await fillByPlaceholder(page, /请输入密码/, dbPass);
    await clickVisible(page, /测试连接/);
    await expectSuccess(page, /连接成功/);
    await clickVisible(page, /确\s*定|保\s*存/);
    await expectSuccess(page, /(新增|添加|创建)|操作成功|成功/);
    sourceCard = page.locator('.data-source:visible').filter({ hasText: sourceName }).first();
    await expect(sourceCard).toBeVisible({ timeout: 20_000 });
    sourceCreated = true;
    await report('创建者新增数据源成功', true, `${sourceName}（MYSQL ${dbHost}:${dbPort}/${dbName}）`);

    // ==================== 阶段 5：资源视角回显创建者双授权（kind=2 管理 + kind=5 使用） ====================
    await switchLogin(page, admin, entryFor('#/dataAccess/dataSource'), '管理员');
    await openDataPermissionPage(page);
    await clickPermissionTabNode(page, '资源视角');
    await clickPermissionTabNode(page, '数据源');
    await page.waitForTimeout(800);
    const sourceTypeDialog = await visibleDialog(page);
    await chooseExactDropdownOption(page, sourceTypeDialog, MYSQL);
    await expect(sourceTypeDialog.getByText(MYSQL).first()).toBeVisible({ timeout: 20_000 });
    const sourceNodes = sourceTypeDialog.getByText(sourceName, { exact: false }).filter({ visible: true });
    await expect(sourceNodes.last()).toBeVisible({ timeout: 30_000 });
    await sourceNodes.last().click();
    await expect(page.getByRole('button', { name: /新建权限|新增权限/ }).first()).toBeEnabled({ timeout: 15_000 });
    await page.waitForTimeout(1_000);

    const kindRows = await collectPermissionRowTexts(page, creator.userName);
    if (kindRows.length === 0) {
      // 行渲染可能晚于“新建权限”按钮可用；再给一次窗口
      await page.waitForTimeout(1_500);
      kindRows.push(...(await collectPermissionRowTexts(page, creator.userName)));
    }
    const kind2Row = kindRows.find((text) => /管理/.test(text) && !/使用/.test(text));
    let kind5Row = kindRows.find((text) => /使用/.test(text));
    let kind5EchoTab = '数据源';

    // kind=5 源级通配行可能按“源维度”回显；数据源与数据表两个页签都核验后才能下结论
    if (!kind5Row) {
      await clickPermissionTabNode(page, '数据表');
      await page.waitForTimeout(800);
      const tableTypeDialog = await visibleDialog(page);
      await chooseExactDropdownOption(page, tableTypeDialog, MYSQL);
      await expect(tableTypeDialog.getByText(MYSQL).first()).toBeVisible({ timeout: 20_000 });
      const tableSourceNodes = tableTypeDialog.getByText(sourceName, { exact: false }).filter({ visible: true });
      if (await tableSourceNodes.first().isVisible().catch(() => false)) {
        await tableSourceNodes.last().click();
        await page.waitForTimeout(1_200);
        const tableRows = await collectPermissionRowTexts(page, creator.userName);
        const tableKind5 = tableRows.find((text) => /使用/.test(text));
        if (tableKind5) {
          kind5Row = tableKind5;
          kind5EchoTab = '数据表';
        }
      }
    }

    if (!kind2Row) {
      problems.push(
        `资源视角未回显创建者 kind=2 管理授权行（契约：新增数据源自动授予创建人“管理”）。已见行：${kindRows.join(' || ').slice(0, 900) || '（无）'}`,
      );
    } else {
      expect(kind2Row, 'kind=2 管理行权限类型应为“管理”').toMatch(/管理/);
      expect(kind2Row, 'kind=2 管理行不得出现“使用”').not.toMatch(/使用/);
      expect(kind2Row, 'kind=2 管理行字段范围应回显“全部字段”').toMatch(/全部字段/);
      await report('kind=2 管理授权行回显', true, kind2Row.slice(0, 200));
    }
    if (!kind5Row) {
      problems.push(
        '资源视角未回显创建者 kind=5 源级通配使用授权行（契约：新增数据源应同时自动授予创建人“管理、使用”，' +
          '对应 DataSourceBizImpl.createDataSource 的 insertPermission ×2）。' +
          `已检查${kind5EchoTab === '数据表' ? ' 数据源 与 数据表' : ' 数据源'} 页签；可见行：${kindRows.join(' || ').slice(0, 900) || '（无）'}`,
      );
    } else {
      expect(kind5Row, 'kind=5 使用行权限类型应包含“使用”').toMatch(/使用/);
      await report('kind=5 源级通配使用授权行回显', true, `页签：${kind5EchoTab}；${kind5Row.slice(0, 200)}`);
    }
    // ==================== 阶段 5.5：用户视角（成员=创建者）交叉验证双授权 ====================
    // 与阶段 5 资源视角同一契约：kind=2 恰为“管理”（全部字段、无“使用”）+ kind=5 含“使用”；
    // 两个视角都回显才算交叉验证通过；单视角缺失/页面异常均按证据口径归入 problems。
    try {
      const userViewRows = await collectUserViewPermissionRows(page, creator.userName, sourceName);
      const userKind2Row = userViewRows.find((text) => /管理/.test(text) && !/使用/.test(text));
      const userKind5Row = userViewRows.find((text) => /使用/.test(text));
      if (!userKind2Row || !userKind5Row) {
        problems.push(
          `用户视角（成员=${creator.userName}）未交叉回显创建者双授权（契约：kind=2 管理 + kind=5 管理、使用，` +
            '资源/用户两视角均应可见）。' +
            `已见行：${userViewRows.join(' || ').slice(0, 900) || '（无）'}`,
        );
      } else {
        expect(userKind2Row, '用户视角 kind=2 管理行权限类型应为“管理”').toMatch(/管理/);
        expect(userKind2Row, '用户视角 kind=2 管理行不得出现“使用”').not.toMatch(/使用/);
        expect(userKind2Row, '用户视角 kind=2 管理行字段范围应回显“全部字段”').toMatch(/全部字段/);
        expect(userKind5Row, '用户视角 kind=5 使用行权限类型应包含“使用”').toMatch(/使用/);
        await report(
          '用户视角交叉回显创建者双授权',
          true,
          `kind=2：${userKind2Row.slice(0, 160)}；kind=5：${userKind5Row.slice(0, 160)}`,
        );
      }
    } catch (error) {
      problems.push(`用户视角交叉验证未能完成（主体选择或页面结构异常）：${String(error).slice(0, 400)}`);
    }

    // ==================== 阶段 6：创建者自助查询 —— 候选池含新源 + 真实只读 SELECT ====================
    try {
      await switchLogin(page, creator, entryFor('#/dataQuery/selfServiceQuery'), '创建者-自助查询入口');
    } catch {
      // 自助查询菜单未放行时的回退：从有权限入口进入后按菜单点击（等价真实路径）
      await switchLogin(page, creator, entryFor('#/dataAccess/dataSource'), '创建者-回退入口');
      await clickMenu(page, '数据查询', '自助查询');
    }
    await openSelfServiceQueryPage(page);
    await settleSelfQueryDropdowns(page);
    await expect(page.getByRole('button', { name: /选择数据源/ }).first()).toBeVisible({ timeout: 30_000 });
    await clickVisible(page, /选择数据源/);
    const pickDialog = await visibleDialog(page);
    const typeBox = pickDialog.getByRole('combobox').filter({ hasText: '请选择数据源类型' }).first();
    if (await typeBox.isVisible().catch(() => false)) {
      await typeBox.click();
    } else {
      await pickDialog.getByText('请选择数据源类型', { exact: false }).first().click().catch(() => undefined);
    }
    const mysqlOption = page.getByRole('option').filter({ hasText: new RegExp(`^\\s*${MYSQL}\\s*$`) }).last();
    if (await mysqlOption.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await mysqlOption.click();
    } else {
      await clickVisible(pickDialog, MYSQL);
    }
    await page.waitForTimeout(500);

    // 探测候选池：远程搜索 + 防抖轮询，抓取全部可见候选项作为证据
    let optionSeen = false;
    let optionDump = '';
    const poolItems = pickDialog.locator('.el-select-dropdown__item:visible, li:visible').filter({ hasText: sourceName });
    const probeDeadline = Date.now() + 12_000;
    while (Date.now() < probeDeadline) {
      const searchBox = pickDialog.getByPlaceholder(/请输入数据源名称|请输入关键字|请输入名称/).last();
      if (await searchBox.isVisible().catch(() => false)) {
        await searchBox.fill(sourceName);
        await page.waitForTimeout(400);
      }
      if ((await poolItems.count()) > 0) {
        optionSeen = true;
        break;
      }
      optionDump = await dumpVisibleTexts(pickDialog, '.el-select-dropdown__item:visible, li:visible');
      await page.waitForTimeout(600);
    }

    if (optionSeen) {
      // 关闭探测弹窗，走正式“选择数据源”流程并对新源执行真实 SELECT
      await dismissOpenDropdown(page);
      const cancelButton = pickDialog.getByRole('button', { name: /取\s*消/ }).first();
      if (await cancelButton.isVisible().catch(() => false)) {
        await cancelButton.click();
      } else {
        await clickVisible(pickDialog, /确\s*定/, { timeoutMs: 5_000 }).catch(() => undefined);
      }
      await expect(pickDialog).toBeHidden({ timeout: 10_000 });
      await chooseConfiguredDataSource(page, { type: MYSQL, name: sourceName, schema: dbName });
      await executeSql(page, `SELECT '${sqlMarker}' AS marker FROM DUAL`);
      const resultArea = page.locator('.monaco-editor').last();
      await expect(resultArea).toContainText(sqlMarker, { timeout: 30_000 });
      await report('自助查询选择新源并真实取数', true, `SELECT 回显 marker：${sqlMarker}`);
    } else {
      problems.push(
        `自助查询数据源候选池未包含本轮新增源「${sourceName}」（契约：kind=5 使用授权应使源进入 querySourceInfoWithUse 候选池）。候选池可见项：${optionDump || '（空）'}`,
      );
      await dismissOpenDropdown(page);
      await page.keyboard.press('Escape').catch(() => undefined);
    }

    // ==================== 终判：与契约不符的点合并上抛（真实产品问题证据） ====================
    if (problems.length > 0) {
      throw new Error(`本轮运行发现与确认后的业务契约不符（真实产品问题，不通过即留证）：\n- ${problems.join('\n- ')}`);
    }
    await assertNoConsoleErrors(consoleErrors);
    await report('DS-01-06 全链路验收', true, '负向按钮裁剪 ✓ 创建者新增 ✓ kind=2/kind=5 双授权（资源+用户视角交叉）回显 ✓ 自助查询真实取数 ✓ 清理完成');
  } catch (error) {
    mainError = error;
  } finally {
    // ==================== 清理：数据源 → 角色 → 用户（全部本轮前缀对象） ====================
    if (sourceCreated) {
      try {
        await page.keyboard.press('Escape').catch(() => undefined);
        await clickMenu(page, '数据接入', '数据源管理');
        const filterBox = page.getByPlaceholder(/请输入数据源名称|请输入数据源/).last();
        if (await filterBox.isVisible().catch(() => false)) {
          await filterBox.fill(sourceName);
          await page.waitForTimeout(600);
        }
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          if (!(await sourceCard.isVisible().catch(() => false))) break;
          await clickCardAction(page, sourceName, '删除');
          await confirmDangerDialog(page, 'DELETE');
          await expectSuccess(page, /删除/);
          await page.waitForTimeout(1_000);
        }
        if (await sourceCard.isVisible().catch(() => false)) {
          cleanupErrors.push(`数据源“${sourceName}”删除确认后卡片仍可见`);
        }
      } catch (error) {
        cleanupErrors.push(`删除数据源失败：${String(error).slice(0, 300)}`);
      }
    }
    if (rolesCreated.length > 0 || usersCreated.length > 0) {
      try {
        if (rolesCreated.length > 0) {
          await switchLogin(page, admin, entryFor('#/systemManage/userPermission/roleManage'), '管理员-角色清理');
          for (const roleName of rolesCreated) {
            try {
              await deleteSubjectRow(page, { queryName: '请输入角色名称', uniqueText: roleName, label: '角色' });
            } catch (error) {
              cleanupErrors.push(`删除角色“${roleName}”失败：${String(error).slice(0, 240)}`);
            }
          }
        }
        if (usersCreated.length > 0) {
          if (rolesCreated.length === 0) {
            await switchLogin(page, admin, entryFor('#/systemManage/userPermission/userManage'), '管理员-用户清理');
          } else {
            await openUserManagement(page);
          }
          for (const userName of usersCreated) {
            try {
              await deleteSubjectRow(page, { queryName: '请输入用户名称', uniqueText: userName, label: '用户' });
            } catch (error) {
              cleanupErrors.push(`删除用户“${userName}”失败：${String(error).slice(0, 240)}`);
            }
          }
        }
      } catch (error) {
        cleanupErrors.push(`切回管理员清理角色/用户失败：${String(error).slice(0, 240)}`);
      }
    }
  }
  // 主体失败优先抛出并附带清理未完成说明；主体通过但清理失败也如实上抛
  if (mainError) {
    const note = cleanupErrors.length > 0 ? `（另：清理未完全成功：${cleanupErrors.join('；').slice(0, 600)}）` : '';
    if (mainError instanceof Error) mainError.message += note;
    throw mainError;
  }
  if (cleanupErrors.length > 0) {
    throw new Error(`用例主体通过，但结尾清理未完全成功（如实上报）：${cleanupErrors.join('；')}`);
  }
});
