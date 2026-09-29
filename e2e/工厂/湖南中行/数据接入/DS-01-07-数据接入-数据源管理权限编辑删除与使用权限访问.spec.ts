/**
 * DS-01-07｜数据接入｜数据源管理权限编辑删除与使用权限访问
 *
 * 覆盖（任务 DS-PERM-03 / DS-PERM-83，单用例串行闭环）：
 * 1. admin（创建者）经页面新增 1 条 MySQL 110 自有数据源（e2e_ds07+UUID），并按
 *    DS-01-06（run-2026-09-22 实证）的产品规则点击卡片“使用”确认，使源进入下游可选池；
 * 2. admin 在 数据权限页（用户视角）完成两类授权（均为已验证路径）：
 *    - 用户 A（本用例新建，角色仅“数据接入”菜单）：数据源范围弹窗授“管理”
 *      （该弹窗仅渲染“管理”勾选，SM-03-07 同型）；
 *    - 用户 B（DS-PERM-83：不再依赖 SM-00-01 固化申请人 e2e_perm_req_v2，改为本用例
 *      新建 UUID 用户 + UUID 角色“数据地图/数据查询”）：数据表范围弹窗推进 数据库→
 *      Schema 且数据表留空=源级通配，授“使用”（SM-03-05 同型；通配记录按源维度回显，
 *      “使用”即后端 isUse 判定来源）；
 *    - 授权行回显断言：A 行含“管理”、B 行含“使用”（重选主体 + 主动刷新后定位）。
 * 3. 使用权限正向：B 登录自助查询，数据源弹窗真实选中该源并执行 SELECT 回显 UUID 标记；
 * 4. 使用权限负向：用户 C（本用例新建，角色仅“数据查询”菜单）登录自助查询，在数据源
 *    下拉中按全名过滤检索，断言无该源（无 isUse 记录的源不进下游可选池——SM-03-05/
 *    一次性授权 实证语义；用搜索过滤规避虚拟渲染导致的漏采）；
 * 5. 管理权限正向：A 登录 数据接入→数据源管理，对该源真实“编辑”（描述修改→测试连接→
 *    保存成功）；admin 收尾真实删除该源（管理删除 + 自有 fixture 清理）。
 *
 * 断言边界：
 * - A 仅授予“管理”，其在自助查询中的可见性不作为断言（历史 kind=2 语义与当前模型对
 *   该组合的页面表现存在两种实证记录，不属本用例裁决范围）；
 * - B/C/A 的页面可达性由角色菜单真实授权保障，不经直连 URL 伪造访问；
 * - 控制台错误断言仅在 admin 阶段执行；loginAs 切换会重建 SPA 实例，切换期网络噪声
 *   不作为产品错误上报，仅在结果详情转述计数。
 *
 * 允许清单（对齐 di-static 既有约定，见 DS-01-06 头注）：仅导入 ../utils.js 与
 * ../抽样用例工具.js；数据权限交互、用户/角色前置与登录切换 helper 按湖南中行
 * 系统管理/数据权限闭环工具.ts、权限测试工具.ts 与 DS-01-06 已验证实现本地复制，
 * 不新增跨目录导入。
 *
 * 环境门禁：DB_USER/DB_PASS（MySQL 110 e2e_test 连接账号）与 TEST_PASS（admin 多账号
 * 切换登录）缺失时 test.skip 并列出精确缺失清单；全部主体均由本用例经页面流程新建
 * （ensurePermissionUser/ensurePermissionRole/assignRoleToUser），不依赖、不修改任何
 * 固定夹具账号，不删除既有数据。
 * 测试数据：仅本用例页面流程创建 1 条数据源 + 3 个 UUID 用户 + 3 个 UUID 角色；
 * 结束（含失败路径）在 finally 中清理：先删数据源，再按 DS-01-06 已验证的
 * deleteSubjectRow 模式先删本轮 3 个角色、后删 3 个用户；清理未完全成功时如实上抛，
 * 不伪造通过、不遗留固定账号依赖。
 */
import { test, expect, uuid, clickMenu, assertNoConsoleErrors, chooseConfiguredDataSource, executeSql } from '../utils.js';
import { clickVisible, clickCardAction, confirmDangerDialog, expectSuccess, fillPlaceholder, visibleDialog } from '../抽样用例工具.js';
import type { Locator, Page } from '@playwright/test';

interface PermissionIdentity {
  userName: string;
  nickname: string;
  password: string;
  phone: string;
  email: string;
}

interface PermissionRole {
  roleName: string;
  roleKey: string;
}

/** 授权弹窗使用的资源描述（数据源类型/展示名/库/Schema；源级通配不含表）。 */
interface GrantResource {
  sourceTypeName: string;
  sourceName: string;
  databaseName: string;
  schemaName: string;
}

/**
 * DS-PERM-83：申请人 B 不再复用 SM-00-01 固化账号（e2e_perm_req_v2）。与本用例 A/C
 * 一样，B 的身份由 newLocalIdentity 本轮生成、“数据地图/数据查询”菜单角色由本轮
 * UUID 新建（见测试体内 applicantUser/applicantRole），并在 finally 中一并清理。
 */

/** 生成本轮唯一权限测试身份（权限测试工具.newPermissionIdentity 同款规则）。 */
function newLocalIdentity(caseKey: string): PermissionIdentity {
  const suffix = uuid();
  const digits = String(parseInt(suffix, 16) % 100000).padStart(5, '0');
  return {
    userName: `e2e_${caseKey}_${suffix}`,
    nickname: `e2e_auth_${caseKey}_${suffix}`,
    password: process.env.SM_PERMISSION_PASSWORD?.trim() || '',
    phone: process.env.SM_USER_PHONE ?? `186542${digits}`,
    email: process.env.SM_USER_EMAIL ?? `75421${digits}@qq.com`,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

/** Ant/Element 双兼容的可见下拉选项选择器（数据权限闭环工具同款）。 */
const PERMISSION_OPTION_SELECTOR = [
  '.ant-select-dropdown:visible .ant-select-item-option',
  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
  '.el-select-dropdown:visible .el-select-dropdown__item',
  '[role="listbox"]:visible [role="option"]',
  'li[role="option"]:visible',
].join(', ');

/** 关闭下拉/日期浮层：严禁 Escape（Ant Modal 会整窗取消），点弹窗头部中性区域。 */
async function dismissPermissionDropdown(page: Page): Promise<void> {
  const openOverlay = page.locator([
    '.ant-select-dropdown:visible',
    '.el-select-dropdown:visible',
    '.el-dropdown-menu:visible',
    '.ant-picker-dropdown:visible',
    '.el-picker-panel:visible',
  ].join(', ')).first();
  if (!(await openOverlay.isVisible().catch(() => false))) return;
  const neutral = page.locator(
    '.ant-modal-header:visible, .el-dialog__header:visible, .ant-drawer-header:visible, .el-drawer__header:visible',
  ).first();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!(await openOverlay.isVisible().catch(() => false))) break;
    if (await neutral.isVisible().catch(() => false)) {
      await neutral.click({ timeout: 2_000 }).catch(() => undefined);
    } else {
      await page.mouse.move(0, 0).catch(() => undefined);
    }
    await page.waitForTimeout(250);
  }
}

/** 在当前打开的下拉浮层中选择目标选项：优先精确相等，退回包含匹配；必要时向搜索框注入关键字。 */
async function choosePermissionOption(page: Page, expected: string, labelForError: string, searchInto?: Locator): Promise<void> {
  const optionLocator = page.locator(PERMISSION_OPTION_SELECTOR);
  const exactOption = optionLocator.filter({ hasText: new RegExp(`^\\s*${escapeRegExp(expected)}\\s*$`) }).first();
  const fuzzyOption = optionLocator.filter({ hasText: expected }).first();
  const deadline = Date.now() + 5_000;
  let option: Locator | undefined;
  while (Date.now() < deadline && !option) {
    option = await firstVisible(exactOption) ?? await firstVisible(fuzzyOption);
    if (!option) {
      if (searchInto) {
        const searchInput = searchInto.locator('input:visible').last();
        if (await searchInput.count()) {
          await searchInput.fill(expected).catch(() => undefined);
          await page.waitForTimeout(600);
        }
      }
      await page.waitForTimeout(300);
    }
  }
  if (!option) {
    const sampled = await optionLocator.allInnerTexts().catch(() => [] as string[]);
    throw new Error(`未在下拉浮层中找到“${labelForError}=${expected}”，浮层选项采样：${JSON.stringify(sampled.slice(0, 20))}（页面：${page.url()}）`);
  }
  await option.click();
  await page.waitForTimeout(300);
}

/** 在授权弹窗内按表单标签定位 select 下拉（作用域=弹窗，避免误中弹窗标题）。 */
async function locatePermissionSelectByLabel(
  dialog: Locator,
  labelPattern: RegExp,
  placeholderPattern: RegExp,
  labelName: string,
): Promise<Locator> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const label = await firstVisible(
      dialog.locator('form .ant-form-item, .el-form-item').filter({ hasText: labelPattern }),
    );
    if (label) {
      const combobox = label.locator('[role="combobox"]:visible, .ant-select-selector:visible, .el-select:visible').first();
      if (await combobox.count()) return combobox;
    }
    const placeholderHit = await firstVisible(dialog.locator(`input[placeholder*="${labelName}"]`));
    if (placeholderHit) return placeholderHit;
    await dialog.page().waitForTimeout(300);
  }
  void placeholderPattern;
  throw new Error(`授权弹窗未找到${labelName}选择控件（label 正则 ${labelPattern}），当前页面：${dialog.page().url()}`);
}

/** 选择授权对象的数据源类型（如 MYSQL）。 */
async function selectPermissionSourceType(page: Page, dialog: Locator, sourceTypeName: string): Promise<void> {
  const typeSelect = await locatePermissionSelectByLabel(dialog, /数据源类型|源类型/, /数据源类型|源类型/, '数据源类型');
  await typeSelect.click();
  await choosePermissionOption(page, sourceTypeName, '数据源类型', typeSelect);
  await dismissPermissionDropdown(page);
}

/** 选择授权对象的具体数据源；断言选项真实出现（不存在时 fail-fast，绝不静默授权到别的源）。 */
async function selectPermissionSource(page: Page, dialog: Locator, resource: GrantResource): Promise<void> {
  const sourceSelect = await locatePermissionSelectByLabel(dialog, /数据源名称|数据源/, /数据源名称|选择数据源/, '数据源名称');
  await sourceSelect.click();
  await choosePermissionOption(page, resource.sourceName, '数据源名称', sourceSelect);
  await dismissPermissionDropdown(page);
  const echoFragment = resource.sourceName.split(/[:：/]/)[0];
  await expect.poll(async () => (await sourceSelect.innerText().catch(() => '')).replace(/\s+/g, ''), {
    timeout: 5_000,
    message: `数据源名称选择“${resource.sourceName}”后未回填（弹窗内未见该名称）`,
  }).toContain(echoFragment);
}


/** 勾选/取消弹窗内“使用/管理”权限类型；目标控件未渲染时抛错（不静默跳过，由调用方按范围决定集合）。 */
async function setPermissionTypeState(page: Page, dialog: Locator, flag: string, wanted: boolean): Promise<void> {
  const dialogText = (await dialog.innerText().catch(() => '')).replace(/\s+/g, '');
  if (!dialogText.includes(flag)) {
    throw new Error(`权限弹窗未渲染“${flag}”勾选项，无法${wanted ? '勾选' : '取消'}（页面：${page.url()}）`);
  }
  const checkbox = await firstVisible(dialog.locator('.ant-checkbox-wrapper, .el-checkbox, label').filter({ hasText: flag }));
  if (!checkbox) throw new Error(`权限弹窗中“${flag}”勾选项不可见（页面：${page.url()}）`);
  const checked = (await checkbox.getAttribute('class'))?.includes('checked') ?? false;
  if (wanted !== checked) await checkbox.click();
  await page.waitForTimeout(200);
}

async function setPermissionTypes(page: Page, dialog: Locator, wanted: string[]): Promise<void> {
  for (const flag of ['使用', '管理']) {
    await setPermissionTypeState(page, dialog, flag, wanted.includes(flag));
  }
}

/** 选择“永久”有效期；required=false 时控件缺失仅记录并按表单默认值提交。 */
async function setPermissionExpiry(page: Page, dialog: Locator, options: { required?: boolean } = {}): Promise<void> {
  const option = await firstVisible(dialog.getByText(/永\s*久/));
  if (!option) {
    if (options.required) {
      throw new Error(`权限弹窗未找到“永久”截止时间选项，当前页面：${page.url()}`);
    }
    console.log(`GRANT-EXPIRY-CONTROL-ABSENT（弹窗未渲染“永久”选项，按表单默认提交） url=${page.url()}`);
    return;
  }
  await option.click();
  await page.waitForTimeout(300);
}

/** 提交授权弹窗并断言成功提示 + 弹窗关闭。 */
async function submitPermissionDialog(page: Page, dialog: Locator): Promise<void> {
  await clickVisible(dialog, /确\s*定|保\s*存/);
  await expectSuccess(page, /成功|已保存|提交成功/);
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

async function refreshPermissionList(page: Page): Promise<void> {
  const refresh = await firstVisible(page.getByRole('button', { name: /刷新|查\s*询|搜\s*索/ }));
  if (!refresh) throw new Error(`数据权限列表未找到“刷新/查询/搜索”控件（页面：${page.url()}）`);
  await refresh.click();
  await page.waitForTimeout(1_500);
}

/** 取包含目标文本的行容器（祖先行级节点）。 */
function rowContainerOf(page: Page, uniqueText: string): Locator {
  const direct = page.locator(`text=${uniqueText}`).first();
  return direct.locator('xpath=ancestor-or-self::*['
    + 'contains(@class,"row") or contains(@class,"item") or contains(@class,"card") or self::tr or self::li'
    + '][1]');
}

/** 在数据权限列表中定位包含目标文本的行（轮询等待回显）。 */
async function findPermissionRow(page: Page, uniqueText: string, timeoutMs = 10_000): Promise<Locator | undefined> {
  const row = rowContainerOf(page, uniqueText);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await row.isVisible().catch(() => false)) return row;
    await page.waitForTimeout(500);
  }
  return undefined;
}

/** 推进 数据库→Schema 两级级联；数据表级刻意留空（表留空 = 源级通配授权，SM-03-05 同型）。 */
async function selectPermissionCascadeToSchema(
  page: Page,
  dialog: Locator,
  databaseName: string,
  schemaName: string,
): Promise<void> {
  const levels = [
    { labels: /^数据\s*库|^库名/, placeholder: /数据\s*库|库名/, value: databaseName, name: '数据库' },
    { labels: /^[Ss]chema$|^模式/, placeholder: /[Ss]chema|模式/, value: schemaName, name: 'Schema' },
  ];
  for (const level of levels) {
    let box: Locator | undefined;
    const deadline = Date.now() + 8_000;
    let lastError: unknown;
    while (Date.now() < deadline && !box) {
      try {
        box = await locatePermissionSelectByLabel(dialog, level.labels, level.placeholder, level.name);
      } catch (error) {
        lastError = error;
        await page.waitForTimeout(300);
      }
    }
    if (!box) throw lastError;
    const levelBox = box;
    await levelBox.click();
    await choosePermissionOption(page, level.value, `${level.name}（${level.value}）`, levelBox);
    await dismissPermissionDropdown(page);
    await expect.poll(async () => (await levelBox.innerText().catch(() => '')).includes(level.value), {
      timeout: 5_000,
      message: `${level.name}选择“${level.value}”后未回填（下拉控件内未见该值的完整文本节点）`,
    }).toBe(true);
  }
}


/** 点击数据权限页左侧树/页签节点（左侧是 Tree 控件，非 Tab）。 */
async function clickPermissionTabNode(page: Page, text: string): Promise<Locator> {
  const candidates = [
    page.locator('.ant-tree-title').filter({ hasText: text }),
    page.locator('.ant-tabs-tab').filter({ hasText: text }),
    page.getByRole('tab', { name: text }),
    page.locator('.el-tree-node__content, .el-tabs__item, [role="treeitem"]').filter({ hasText: text }),
  ];
  const deadline = Date.now() + 8_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      const node = await firstVisible(candidate);
      if (node) {
        try {
          await node.click({ timeout: 2_000 });
          await page.waitForTimeout(600);
          return node;
        } catch (error) {
          lastError = error;
        }
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`数据权限页未找到可点击的“${text}”节点（页面：${page.url()}）${lastError ? `；最后错误：${String(lastError)}` : ''}`);
}

async function switchPermissionView(page: Page, viewName: '用户视角' | '资源视角'): Promise<void> {
  const node = await clickPermissionTabNode(page, viewName);
  const state = (await node.getAttribute('aria-selected')) ?? '';
  if (state !== 'true') {
    const active = await firstVisible(
      page.locator('.ant-tree-node-selected, .is-active, .ant-tabs-tab-active').filter({ hasText: viewName }),
    );
    if (!active) await node.click();
  }
  await page.waitForTimeout(800);
}

async function switchUserViewSubjectTab(page: Page, tabName: string): Promise<void> {
  await clickPermissionTabNode(page, tabName);
}

async function switchResourceViewScopeTab(page: Page, scopeName: '数据源' | '数据表'): Promise<void> {
  await clickPermissionTabNode(page, scopeName);
}

async function waitAnyVisibleText(page: Page, patterns: string[], timeoutMs = 8_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const pattern of patterns) {
      const hit = await firstVisible(page.getByText(pattern));
      if (hit) return pattern;
    }
    await page.waitForTimeout(300);
  }
  return undefined;
}

async function findSubjectSearchBox(page: Page): Promise<Locator | undefined> {
  const candidates = [
    page.locator('input[placeholder*="用户名"], input[placeholder*="账号"], input[placeholder*="请输入"]').first(),
    page.locator('.ant-select-selection-search-input:visible').first(),
  ];
  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return undefined;
}

async function verifyUserViewSubjectSelected(page: Page, patterns: string[], timeoutMs = 8_000): Promise<boolean> {
  const found = await waitAnyVisibleText(page, patterns, timeoutMs);
  return Boolean(found);
}

/** 在用户视角左侧选择授权主体（搜索→选中→校验选中态）。 */
async function selectUserViewSubject(
  page: Page,
  subject: { subjectTab: string; subjectName: string; subjectAlias?: string },
): Promise<void> {
  await switchUserViewSubjectTab(page, subject.subjectTab);
  const searchBox = await findSubjectSearchBox(page);
  if (!searchBox) throw new Error(`用户视角左侧未找到主体搜索框（页面：${page.url()}）`);
  try {
    await searchBox.fill(subject.subjectName, { timeout: 3_000 });
    await page.waitForTimeout(800);
  } catch {
    const refreshed = await findSubjectSearchBox(page);
    if (refreshed) {
      await refreshed.fill(subject.subjectName).catch(() => undefined);
      await page.waitForTimeout(800);
    }
  }
  await dismissPermissionDropdown(page);
  const aliasPatterns = subject.subjectAlias ? [subject.subjectName, subject.subjectAlias] : [subject.subjectName];
  if (!(await verifyUserViewSubjectSelected(page, aliasPatterns, 10_000))) {
    const candidate = await firstVisible(
      page.locator('.ant-tree-title, li, [role="treeitem"]').filter({ hasText: subject.subjectName }),
    );
    if (!candidate) {
      throw new Error(`用户视角左侧未能定位主体“${subject.subjectName}”（搜索后无结果或未渲染）。`
        + '该主体应为本用例前置步骤经页面创建并邀请进当前组织的用户（DS-PERM-83：无固定夹具账号）。');
    }
    await candidate.click();
    await page.waitForTimeout(500);
  }
}

/** 打开用户视角“授权”弹窗（页面标题为 一次性授权）。 */
async function openUserViewCreateDialog(page: Page): Promise<Locator> {
  const openers = [/授\s*权/, /新\s*增/, /一次性授权/];
  for (const pattern of openers) {
    const control = await firstVisible(page.getByRole('button', { name: pattern }));
    if (!control) continue;
    await control.click().catch(() => undefined);
    const dialog = await visibleDialog(page);
    try {
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(dialog).toContainText(/一次性授权/, { timeout: 5_000 });
      return dialog;
    } catch {
      // 尝试下一个候选按钮。
    }
  }
  throw new Error(`用户视角未找到可打开“一次性授权”弹窗的按钮（尝试：${openers.map((item) => String(item)).join('/')}） url=${page.url()}`);
}

/** hash 直达前端路由（DS-01-06 已验证）；若已在目标路由，先 about:blank 再进，规避 SPA 组件残留。 */
async function gotoAppHashRoute(page: Page, hash: string): Promise<void> {
  let target: string;
  try {
    const parsed = new URL(page.url());
    parsed.hash = hash;
    target = parsed.toString();
  } catch {
    const base = (process.env.BASE_URL ?? process.env.ENTRY_URL ?? 'http://localhost').trim().replace(/\/+$/, '');
    target = `${base.split('#')[0]}/${hash}`;
  }
  if (page.url().includes(hash)) {
    await page.goto('about:blank').catch(() => undefined);
    await page.waitForTimeout(300);
  }
  await page.goto(target);
  await page.waitForTimeout(800);
}

async function openDataPermissionPage(page: Page): Promise<void> {
  await gotoAppHashRoute(page, '#/system/dataPermission');
  await expect.poll(() => page.url(), { timeout: 20_000 }).toContain('dataPermission');
  await expect
    .poll(async () => (await page.locator('body').innerText().catch(() => '')).includes('数据权限'), { timeout: 20_000 })
    .toBe(true);
}

async function openSelfServiceQueryPage(page: Page): Promise<void> {
  await gotoAppHashRoute(page, '#/dataQuery/selfService');
  await expect.poll(() => page.url(), { timeout: 20_000 }).toContain('/dataQuery/selfService');
  await expect
    .poll(
      async () =>
        (await page.getByText('选择数据源', { exact: true }).count()) > 0 ||
        (await page.locator('.datasource-select:visible').count()) > 0,
      { timeout: 20_000 },
    )
    .toBe(true);
}



/** 系统管理左侧栏就绪信号（与湖南中行权限测试工具同型：以真实侧栏文本为准）。 */
async function systemSidebarReady(page: Page): Promise<boolean> {
  const approval = page.getByText('审批管理', { exact: true }).last();
  const permissions = page.getByText('用户权限', { exact: true }).last();
  return (await approval.isVisible().catch(() => false)) || (await permissions.isVisible().catch(() => false));
}

/** 进入系统管理指定子页：真实菜单优先（顶栏“···”溢出入口），hash 直达兜底。 */
async function openSystemPage(page: Page, route: string): Promise<void> {
  if (!(await systemSidebarReady(page))) {
    const overflow = (await firstVisible(page.getByRole('menuitem', { name: /^(?:···|…|\.\.\.|更多)$/ })))
      ?? (await firstVisible(page.getByText(/^(?:···|…|\.\.\.|更多)$/, { exact: true })));
    if (overflow) {
      await overflow.click().catch(() => undefined);
      await page.waitForTimeout(800);
      const system = await firstVisible(page.getByText('系统管理', { exact: true }));
      if (system) {
        await system.click().catch(() => undefined);
        await page.waitForTimeout(800);
      }
    }
    if (!(await systemSidebarReady(page))) {
      await gotoAppHashRoute(page, route).catch(() => undefined);
      await page.waitForTimeout(500);
    }
    await expect.poll(() => systemSidebarReady(page), { timeout: 15_000 }).toBe(true);
  }

  const leafByRoute: Record<string, string> = {
    '#/systemManage/userPermission/userManage': '用户管理',
    '#/systemManage/userPermission/roleManage': '角色管理',
  };
  const leafName = leafByRoute[route];
  if (!leafName) throw new Error(`未登记的系统管理路由：${route}`);

  const permissionGroup = page.getByText('用户权限', { exact: true }).last();
  if (await permissionGroup.isVisible().catch(() => false)) {
    await permissionGroup.click();
    await page.waitForTimeout(250);
  }
  const leaf = page.getByText(leafName, { exact: true }).last();
  await expect(leaf, `系统管理左侧未出现“${leafName}”`).toBeVisible({ timeout: 10_000 });
  await leaf.click();
  await expect.poll(() => page.url(), { timeout: 15_000 }).toContain(route.slice(1));
}

async function openUserManagementPage(page: Page): Promise<void> {
  await openSystemPage(page, '#/systemManage/userPermission/userManage');
  await expect(page.getByRole('button', { name: '新增用户' })).toBeVisible({ timeout: 30_000 });
}

async function openRoleManagementPage(page: Page): Promise<void> {
  await openSystemPage(page, '#/systemManage/userPermission/roleManage');
  await expect(page.getByRole('button', { name: /新建/ })).toBeVisible({ timeout: 30_000 });
}

/**
 * 将一个全局用户加入当前登录组织（与权限测试工具同型）。
 * 返回 not-found 表示该账号尚未创建；already-in-current-org 表示接口拒绝了重复
 * 邀请，但列表已验证该用户本来就在当前组织，可安全复用。
 */
async function inviteUserToCurrentOrganization(
  page: Page,
  identity: PermissionIdentity,
): Promise<'invited' | 'already-in-current-org' | 'not-found'> {
  await clickVisible(page, '邀请用户');
  const invite = await visibleDialog(page);
  const inviteSelector = invite.getByRole('textbox', { name: '请选择用户' });
  await inviteSelector.click();
  // 邀请下拉默认只加载前几条用户；必须输入唯一账号进行远程筛选。
  await inviteSelector.fill(identity.userName);
  await page.waitForTimeout(500);
  // 邀请下拉会截断较长昵称，不能把“用户名(昵称)”当可见文本断言；按用户名定位。
  const option = page.getByRole('listitem')
    .filter({ hasText: new RegExp(identity.userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    .last();
  if (!(await option.isVisible({ timeout: 3_000 }).catch(() => false))) {
    await invite.getByRole('button', { name: /取\s*消|Close/ }).first().click().catch(() => undefined);
    return 'not-found';
  }
  await option.click();
  // 提示文案可能瞬间消失，先监听真实接口结果区分成功与重复邀请。
  const inviteResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && /\/systemUser\/inviteUser(?:\?|$)/.test(response.url()),
    { timeout: 10_000 },
  ).catch(() => undefined);
  await invite.getByRole('button', { name: /^确\s*定$/ }).click();
  const response = await inviteResponse;
  if (response) {
    const responseText = await response.text().catch(() => '');
    if (/邀请用户已存在当前组织|重复邀请/.test(responseText)) {
      await invite.getByRole('button', { name: /取\s*消|Close/ }).first().click().catch(() => undefined);
      return 'already-in-current-org';
    }
    if (response.ok() && /(?:"code"\s*:\s*(?:0|200)|"success"\s*:\s*true|成功)/.test(responseText)) {
      await expect(invite).toBeHidden({ timeout: 10_000 });
      return 'invited';
    }
  }
  // 不能用“邀请”作为成功关键词：后端“邀请用户已存在当前组织”是业务拒绝，同样含“邀请”。
  const success = page.locator(
    '.el-message--success:visible, .ant-message-success:visible, [role="alert"][data-type="success"]:visible',
  ).filter({ hasText: /成功/ }).last();
  if (await success.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await expect(invite).toBeHidden({ timeout: 10_000 });
    return 'invited';
  }
  // 失败提示可能很快消失：关闭弹窗后以用户列表为准。
  if (await invite.isVisible().catch(() => false)) {
    await invite.getByRole('button', { name: /取\s*消|Close/ }).first().click().catch(() => undefined);
  }
  return (await findUserRow(page, identity.userName)) ? 'already-in-current-org' : 'not-found';
}

/** 在用户列表按账号过滤并定位行（可见文本轮询，兼容 Element/div-table 两种渲染）。 */
async function findUserRow(page: Page, userName: string): Promise<Locator | undefined> {
  const query = page.getByRole('textbox', { name: '请输入用户名称' }).first();
  await query.fill(userName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  const userTexts = page.getByText(userName, { exact: true });
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    for (let index = await userTexts.count() - 1; index >= 0; index -= 1) {
      const text = userTexts.nth(index);
      if (await text.isVisible().catch(() => false)) return text;
    }
    await page.waitForTimeout(250);
  }
  return undefined;
}

/** 新增用户并邀请进入当前组织（两段业务：新增不选组织，由邀请写入当前组织）。 */
async function createAndInviteUser(page: Page, identity: PermissionIdentity): Promise<void> {
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
  await page.mouse.move(0, 0);
  await dialog.getByRole('button', { name: /^确\s*定$/ }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expectSuccess(page, /成功|新增/);

  const invitation = await inviteUserToCurrentOrganization(page, identity);
  if (invitation === 'not-found') {
    throw new Error(`新建用户“${identity.userName}”未出现在邀请候选列表中，不能确认其已加入当前组织。`);
  }
  const row = await findUserRow(page, identity.userName);
  if (!row) throw new Error(`用户“${identity.userName}”邀请后未出现在当前组织用户列表中。`);
}

/** 幂等确保用户存在（先查列表，再试邀请，最后才创建；绝不删除既有对象）。 */
async function ensurePermissionUser(page: Page, identity: PermissionIdentity): Promise<void> {
  await openUserManagementPage(page);
  if (await findUserRow(page, identity.userName)) return;
  if ((await inviteUserToCurrentOrganization(page, identity)) !== 'not-found') return;
  await createAndInviteUser(page, identity);
}


/** 勾选角色菜单树中的目标菜单（原生 checkbox 可能被 tree-node 拦截，优先点 el-checkbox label）。 */
async function selectRoleMenu(page: Page, dialog: Locator, menuName: string): Promise<void> {
  const text = dialog.getByText(menuName, { exact: true }).last();
  // 菜单树数据由弹窗打开后的异步请求渲染（trace 实证：弹窗打开后 ~70-90ms 内树可能尚未挂载，
  // run3 在 +72ms 的一次性 isVisible 即抛错）。这里等待节点真正渲染，而不是一次性探测。
  const rendered = await text
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!rendered) {
    throw new Error(`角色菜单树未找到可选菜单“${menuName}”（等待 8s 仍未渲染）；不能静默创建无菜单角色。`);
  }
  let scope = text;
  for (let level = 0; level < 6; level += 1) {
    // Element Tree 的实际可点击对象是 tree-node__content；直接对祖先范围内的原生
    // input 做 check 不会更新 Vue 状态，因此优先点击它的 label。
    const native = scope.locator('input[type="checkbox"]').first();
    if (await native.count()) {
      if (!(await native.isChecked().catch(() => false))) {
        const label = native.locator('xpath=ancestor::label[contains(@class,"el-checkbox")][1]').first();
        if (await label.count()) await label.click({ force: true });
        else await native.check({ force: true });
        await expect(native).toBeChecked({ timeout: 5_000 });
      }
      return;
    }
    scope = scope.locator('..');
  }
  await text.click();
}

/** 新建角色并断言成功（保存后按角色名主动查询，规避早于 insert 返回的列表请求）。 */
async function createRole(page: Page, role: PermissionRole, menuNames: string[]): Promise<void> {
  await clickVisible(page, '新建');
  const dialog = await visibleDialog(page);
  await dialog.getByPlaceholder('请输入角色名称').fill(role.roleName);
  const key = dialog.getByPlaceholder('请输入权限字符');
  if (await key.isVisible().catch(() => false)) await key.fill(role.roleKey);
  for (const menuName of menuNames) await selectRoleMenu(page, dialog, menuName);
  await dialog.getByRole('button', { name: /^确\s*定$/ }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expectSuccess(page, /成功|新增|保存/);
  if (!(await findRoleRow(page, role.roleName))) {
    throw new Error(`角色“${role.roleName}”保存成功后未能从角色列表查询到。`);
  }
}

/** 在角色列表按名称过滤并定位行（先定位角色文字再向上取行，兼容 Element/div-table）。 */
async function findRoleRow(page: Page, roleName: string): Promise<Locator | undefined> {
  const query = page.getByRole('textbox', { name: '请输入角色名称' }).first();
  const search = page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first();
  const pollRoleText = async (timeoutMs: number): Promise<Locator | undefined> => {
    const roleTexts = page.getByText(roleName, { exact: true });
    let roleText: Locator | undefined;
    const deadline = Date.now() + timeoutMs;
    while (!roleText && Date.now() < deadline) {
      const count = await roleTexts.count();
      for (let index = count - 1; index >= 0; index -= 1) {
        if (await roleTexts.nth(index).isVisible().catch(() => false)) {
          roleText = roleTexts.nth(index);
          break;
        }
      }
      if (!roleText) await page.waitForTimeout(200);
    }
    return roleText;
  };
  await query.fill(roleName);
  await search.click();
  let roleText = await pollRoleText(8_000);
  // 连续处理多个角色时查询点击可能落在列表刷新竞态窗口内；仅重试一次重新查询。
  if (!roleText) {
    await query.fill(roleName);
    await search.click();
    roleText = await pollRoleText(10_000);
  }
  if (!roleText) return undefined;
  const candidates = [
    roleText.locator('xpath=ancestor::tr[1]'),
    roleText.locator('xpath=ancestor::*[contains(@class,"el-table__row") or @role="row"][1]'),
    roleText.locator('xpath=parent::*'),
  ];
  for (const row of candidates) {
    if (await row.isVisible().catch(() => false)) return row;
  }
  return undefined;
}

/** 幂等确保角色存在（先查列表，缺失才新建并勾选菜单）。 */
async function ensurePermissionRole(page: Page, role: PermissionRole, menuNames: string[]): Promise<void> {
  await openRoleManagementPage(page);
  if (await findRoleRow(page, role.roleName)) return;
  await createRole(page, role, menuNames);
}

/** 角色分配用户（幂等：已在授权用户表中则直接返回；走“添加用户”真实两步流程）。 */
async function assignRoleToUser(page: Page, role: PermissionRole, identity: PermissionIdentity): Promise<void> {
  await openRoleManagementPage(page);
  const row = await findRoleRow(page, role.roleName);
  if (!row) throw new Error(`角色“${role.roleName}”创建/查询后未出现在角色列表中。`);
  await clickVisible(row, '分配用户');
  // 已授权用户不会再出现在“添加用户”候选列表；先检查授权用户表避免复用误判。
  // 授权用户页存在 Element Table / div-table 两种渲染，以真实可见的用户名文本为证据。
  const existingUsers = page.getByText(identity.userName, { exact: true });
  const existingDeadline = Date.now() + 6_000;
  while (Date.now() < existingDeadline) {
    for (let index = await existingUsers.count() - 1; index >= 0; index -= 1) {
      if (await existingUsers.nth(index).isVisible().catch(() => false)) return;
    }
    await page.waitForTimeout(200);
  }
  const addUser = await firstVisible(page.getByRole('button', { name: /添加用户/ }));
  if (!addUser) throw new Error('角色授权用户页没有找到“添加用户”按钮。');
  // 子页刚加载时可能吞掉第一次 click，仅在窗口未出现时重试一次。
  await addUser.click();
  let dialog = await firstVisible(page.locator('[role="dialog"], .el-dialog, .ant-modal'));
  if (!dialog) {
    await page.waitForTimeout(400);
    await addUser.click({ force: true });
    dialog = await firstVisible(page.locator('[role="dialog"], .el-dialog, .ant-modal'));
  }
  if (!dialog) {
    throw new Error('点击“添加用户”后未出现选择用户窗口；请确认当前前端是否仍以弹窗方式分配角色用户。');
  }
  // 选择窗口默认只显示第一页；必须先在弹窗内按用户名查询再勾选。
  const query = dialog.getByRole('textbox', { name: '请输入用户名称' }).first();
  if (await query.isVisible().catch(() => false)) {
    await query.fill(identity.userName);
    await clickVisible(dialog, /查\s*询|搜\s*索/, { timeoutMs: 5_000 });
  }
  const user = dialog.getByText(identity.userName, { exact: true }).last();
  await expect(user).toBeVisible({ timeout: 10_000 });
  const checkbox = await firstVisible(
    user
      .locator('xpath=ancestor::*[self::tr or @role="row" or contains(@class,"tree-node")][1]')
      .locator('input[type="checkbox"], .el-checkbox, .ant-checkbox'),
  );
  if (checkbox) await checkbox.click();
  else await user.click();
  await dialog.getByRole('button', { name: /^确\s*定$/ }).last().click();
  await expectSuccess(page, /成功|保存|授权/);
}

/** 切换登录指定账号（clearCookies + 清 storage + 表单登录 + 页面身份校验；不依赖任何菜单存在）。 */
async function loginAsUser(page: Page, account: { userName: string; nickname?: string; password: string }): Promise<void> {
  await page.context().clearCookies();
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  }).catch(() => undefined);
  await page.goto('about:blank');
  const entryUrl = (process.env.ENTRY_URL ?? 'http://bigdata.dev.northking.net/bigdata-ui-factory/#/dataAccess/fileAccess').trim();
  const passwordInput = page.locator('input[type="password"]').first();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch (error) {
      if (page.isClosed()) throw error;
    }
    if (await passwordInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const usernameInput = page.getByRole('textbox', { name: /账号|用户名/ }).first();
      const fallbackUsernameInput = page.locator(
        'input[type="text"], input[name*="user" i], input[placeholder*="用户" i], input[placeholder*="账号" i]',
      ).first();
      await (await usernameInput.count() ? usernameInput : fallbackUsernameInput).fill(account.userName);
      await passwordInput.fill(account.password);
      const loginButton = page.getByRole('button', { name: /登\s*录|sign\s*in/i }).first();
      await expect(loginButton).toBeEnabled({ timeout: 5_000 });
      await loginButton.click();
      await page.waitForTimeout(5_000);
    }
    const formGone = !(await passwordInput.isVisible({ timeout: 3_000 }).catch(() => false));
    if (formGone) break;
  }
  await expect.poll(async () => {
    const text = await page.locator('body').innerText().catch(() => '');
    return text.includes(account.userName) || (account.nickname ? text.includes(account.nickname) : false);
  }, { timeout: 20_000, message: `登录后页面未呈现目标用户“${account.userName}”（页面：${page.url()}）` }).toBe(true);
  await page.waitForTimeout(1_000);
}


/** 收集作用域内可见文本，用于失败/差异证据（DS-01-06 同款，限长避免刷屏）。 */
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

/** 行内删除确认弹窗：有“请输入”校验输入框时走 confirmDangerDialog，否则直接确认（DS-01-06 同款）。 */
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

/** 在用户/角色管理页按唯一文本检索并删除该行（DS-01-06 已验证清理模式；DS-PERM-83 起用于清理本轮新建主体）。 */
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

/** 未授权负向断言：自助查询数据源下拉按全名过滤检索，断言无该源（搜索过滤规避虚拟渲染漏采）。 */
async function expectSourceAbsentFromSelfQuery(page: Page, sourceName: string): Promise<void> {
  const placeholder = page.getByText('选择数据源', { exact: true }).last();
  const activeSource = page.locator('.datasource-select:visible').first();
  if (await placeholder.isVisible().catch(() => false)) await placeholder.click();
  else if (await activeSource.count()) await activeSource.click();
  else throw new Error(`自助查询的数据源选择入口未找到，当前页面：${page.url()}`);
  const comboboxes = page.locator('[role="combobox"]:visible');
  await expect(comboboxes.last()).toBeVisible({ timeout: 10_000 });
  const count = await comboboxes.count();
  if (count < 2) throw new Error(`数据源弹窗下拉框数量不足（${count}），当前页面：${page.url()}`);
  const typeBox = comboboxes.nth(count - 2);
  const sourceBox = comboboxes.nth(count - 1);
  await typeBox.click();
  await choosePermissionOption(page, 'MYSQL', '数据源类型（MYSQL）', typeBox);
  await dismissPermissionDropdown(page);
  await sourceBox.click();
  await page.waitForTimeout(400);
  // 数据源下拉可搜索：输入全名等价于“精确检索该源”，也是虚拟滚动下唯一可靠的全量判定方式。
  const searchInput = sourceBox.locator('input:visible').last();
  if (await searchInput.count()) {
    await searchInput.fill(sourceName).catch(() => undefined);
    await page.waitForTimeout(800);
  }
  const optionLocator = page.locator(PERMISSION_OPTION_SELECTOR);
  const deadline = Date.now() + 8_000;
  let texts: string[] = [];
  let violated = false;
  while (Date.now() < deadline) {
    texts = await optionLocator.allInnerTexts().catch(() => [] as string[]);
    violated = texts.some((text) => text.includes(sourceName));
    if (violated) break;
    await page.waitForTimeout(400);
  }
  await dismissPermissionDropdown(page);
  expect(
    violated,
    `未授权用户的数据源下拉出现了“${sourceName}”（选项采样：${JSON.stringify(texts.slice(0, 10))}）`,
  ).toBe(false);
  console.log(`SELFQUERY-SOURCE-ABSENT=${sourceName}（未授权用户下拉检索无该源，选项采样 ${texts.length} 条）`);
}

test('DS-01-07｜数据接入｜数据源管理权限编辑删除与使用权限访问', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(900_000);
  const dbUser = process.env.DB_USER?.trim();
  const dbPass = process.env.DB_PASS?.trim();
  if (!dbUser || !dbPass) {
    const missing = [
      !dbUser && 'DB_USER（e2e_test 数据库用户）',
      !dbPass && 'DB_PASS（e2e_test 数据库密码）',
    ].filter((item): item is string => Boolean(item));
    test.skip(true, `环境前置缺失：新增 MySQL 数据源需要真实连接账号（缺 ${missing.join('、')}）。补齐后本用例自动转入真实执行。`);
    return;
  }
  if (!process.env.TEST_PASS?.trim()) {
    test.skip(true, '环境前置缺失：TEST_PASS（admin 收尾删除与角色/用户清理需要多账号切换登录，与配置中心 accounts 同源）。补齐后本用例自动转入真实执行。');
    return;
  }
  if (!process.env.SM_PERMISSION_PASSWORD?.trim()) {
    test.skip(true, '环境前置缺失：SM_PERMISSION_PASSWORD（本轮新建用户口令）。');
    return;
  }

  const page = loginPage;
  const adminAccount = { userName: process.env.TEST_USER?.trim() || 'admin', password: process.env.TEST_PASS?.trim() ?? '' };
  const marker = uuid();
  const sourceName = `e2e_ds07_${marker}`;
  const sourceDescription = `DS-01-07_${marker}`;
  const sqlMarker = `ds07_${uuid()}`;
  const dbHost = process.env.DB_HOST?.trim() || '192.168.76.110';
  const dbPort = process.env.DB_PORT?.trim() || '13306';
  const dbName = process.env.DB_NAME?.trim() || 'e2e_test';
  const mysqlDriver = process.env.MYSQL_DRIVER?.trim() || 'com.mysql.cj.jdbc.Driver';
  const jdbcUrl = `jdbc:mysql://${dbHost}:${dbPort}/${dbName}?useSSL=false&characterEncoding=UTF-8`;
  const resource: GrantResource = { sourceTypeName: 'MYSQL', sourceName, databaseName: dbName, schemaName: dbName };

  // DS-PERM-83：三个主体（A 管理 / B 使用 / C 未授权）全部本轮新建，UUID 隔离。
  const applicantUser = newLocalIdentity('ds07ap');
  const manageUser = newLocalIdentity('ds07ma');
  const ungrantedUser = newLocalIdentity('ds07no');
  const applicantRole: PermissionRole = { roleName: `r_ds07ap_${marker}`, roleKey: `r_ds07ap_${marker}` };
  const manageRole: PermissionRole = { roleName: `r_ds07ma_${marker}`, roleKey: `r_ds07ma_${marker}` };
  const ungrantedRole: PermissionRole = { roleName: `r_ds07no_${marker}`, roleKey: `r_ds07no_${marker}` };

  // 清理台账（DS-01-06 已验证模式）：finally 中先删数据源，再删角色、后删用户。
  const rolesCreated: string[] = [];
  const usersCreated: string[] = [];
  const cleanupErrors: string[] = [];
  let mainError: unknown;
  let created = false;
  try {
    // ===== 1. admin 创建自有数据源（DS-01-06 已验证流程） =====
    await clickMenu(page, '数据接入', '数据源管理');
    await clickVisible(page, /添加数据源|新增数据源/, { timeoutMs: 15_000 });
    const typeDialog = page.getByRole('dialog', { name: '添加数据源' }).last();
    await expect(typeDialog).toBeVisible({ timeout: 10_000 });
    // 类型卡片首屏不暴露类型文本，必须用弹窗内置搜索过滤（DS-01-02/03/06 已验证）。
    await typeDialog.getByPlaceholder('请输入关键字搜索').fill('MYSQL');
    await clickVisible(typeDialog, /搜\s*索|图标:\s*search/);
    await page.waitForTimeout(800);
    await clickVisible(typeDialog, /^MYSQL/i, { timeoutMs: 5_000 });
    await clickVisible(typeDialog, '下一步');
    // 表单字段与顺序按 DS-01-06 已验证流程（MySQL 表单只有 驱动类/链接地址，无主机IP/端口/数据库名）。
    await fillPlaceholder(page, '请输入数据源名称', sourceName);
    await fillPlaceholder(page, '请输入数据源描述', sourceDescription);
    await fillPlaceholder(page, '请输入驱动类', mysqlDriver);
    await fillPlaceholder(page, '请输入链接地址', jdbcUrl);
    await fillPlaceholder(page, '请输入用户名', dbUser);
    await fillPlaceholder(page, '请输入密码', dbPass);
    await clickVisible(page, '测试连接');
    await expectSuccess(page, /连接成功|测试成功|成功/);
    await clickVisible(page, /确\s*定/);
    await expect(page.getByText(sourceName, { exact: true }).last()).toBeVisible({ timeout: 15_000 });
    created = true;

    // ===== 2. 卡片初始权限标签（DS-01-06 四轮 headed 实证的产品模型） =====
    // 卡片“使用/管理”是 span.ant-tag 状态徽章，不是可点击操作；新建数据源初始只渲染
    // “管理”，无手动“启用使用”入口。此处断言真实初始状态：含“管理”徽章、不含“使用”。
    await clickMenu(page, '数据接入', '数据源管理');
    let cardTagDump = '';
    let cardSeen = false;
    for (let round = 0; round < 3 && !cardSeen; round += 1) {
      await page.waitForTimeout(1_500);
      const sourceCard = page.locator('.data-source:visible').filter({ hasText: sourceName }).first();
      if (!(await sourceCard.isVisible().catch(() => false))) continue;
      cardSeen = true;
      cardTagDump = (await sourceCard.locator('span.ant-tag:visible').allInnerTexts().catch(() => []))
        .map((text) => text.replace(/\s+/g, ''))
        .filter(Boolean)
        .join('|');
    }
    if (!cardSeen) {
      const allCards = await page.locator('.data-source:visible').allInnerTexts().catch(() => [] as string[]);
      throw new Error(`数据源管理列表未渲染新建数据源“${sourceName}”的卡片。当前列表卡片：`
        + `${JSON.stringify(allCards.map((text) => text.replace(/\s+/g, ' ').trim())).slice(0, 900)}；当前页面：${page.url()}`);
    }
    const freshCard = page.locator('.data-source:visible').filter({ hasText: sourceName }).first();
    const manageTag = freshCard.locator('span.ant-tag').filter({ hasText: /^\s*管理\s*$/ }).first();
    if (!(await manageTag.isVisible().catch(() => false))) {
      throw new Error(`新建数据源“${sourceName}”卡片未渲染“管理”标签（实际标签：${cardTagDump || '无'}）；`
        + `当前页面：${page.url()}`);
    }
    const useTagCount = await freshCard.locator('span.ant-tag').filter({ hasText: /^\s*使用\s*$/ }).count();
    if (useTagCount > 0) {
      throw new Error(`新建数据源“${sourceName}”卡片出现“使用”标签（实际标签：${cardTagDump}），与`
        + `“使用=真实使用后的激活标记”模型矛盾，请人工复核产品行为；当前页面：${page.url()}`);
    }
    await page.waitForTimeout(1_000);

    // admin 阶段一（建源 + 初始徽章校验）控制台必须干净。
    await assertNoConsoleErrors(consoleErrors);





    // ===== 3. 前置主体：B/A/C 三个 UUID 用户 + 三个 UUID 角色（DS-PERM-83：无固定申请人） =====
    // 每个准备步骤都真实打开对应管理页：round-2 实证 openPage:false 会在
    // 用户管理页上执行角色查询/新建，导致找不到“新建”按钮。
    await ensurePermissionUser(page, applicantUser);
    usersCreated.push(applicantUser.userName);
    await ensurePermissionUser(page, manageUser);
    usersCreated.push(manageUser.userName);
    await ensurePermissionUser(page, ungrantedUser);
    usersCreated.push(ungrantedUser.userName);
    await ensurePermissionRole(page, applicantRole, ['数据地图', '数据查询']);
    rolesCreated.push(applicantRole.roleName);
    await ensurePermissionRole(page, manageRole, ['数据接入']);
    rolesCreated.push(manageRole.roleName);
    await ensurePermissionRole(page, ungrantedRole, ['数据查询']);
    rolesCreated.push(ungrantedRole.roleName);
    await assignRoleToUser(page, applicantRole, applicantUser);
    await assignRoleToUser(page, manageRole, manageUser);
    await assignRoleToUser(page, ungrantedRole, ungrantedUser);

    // ===== 4. admin 在数据权限页（用户视角）完成两类授权 =====
    await openDataPermissionPage(page);
    await switchPermissionView(page, '用户视角');

    // 4.1 A：数据源范围“管理”（该弹窗仅渲染“管理”勾选，SM-03-07 同型）。
    await selectUserViewSubject(page, { subjectTab: '成员', subjectName: manageUser.userName, subjectAlias: manageUser.nickname });
    const manageDialog = await openUserViewCreateDialog(page);
    await selectPermissionSourceType(page, manageDialog, 'MYSQL');
    await selectPermissionSource(page, manageDialog, resource);
    await setPermissionTypes(page, manageDialog, ['管理']);
    await setPermissionExpiry(page, manageDialog);
    await submitPermissionDialog(page, manageDialog);
    await selectUserViewSubject(page, { subjectTab: '成员', subjectName: manageUser.userName, subjectAlias: manageUser.nickname });
    await refreshPermissionList(page);
    const manageRow = await findPermissionRow(page, sourceName, 15_000);
    expect(manageRow, `A（${manageUser.userName}）的“管理”授权未在用户视角列表回显（源：${sourceName}）`).toBeTruthy();
    await expect(manageRow!).toContainText('管理', { timeout: 5_000 });

    // 4.2 B（本轮新建申请人，DS-PERM-83）：数据表范围、库/Schema 推进且表留空 = 源级通配“使用”（SM-03-05 同型）。
    await selectUserViewSubject(page, {
      subjectTab: '成员',
      subjectName: applicantUser.userName,
      subjectAlias: applicantUser.nickname,
    });
    await switchResourceViewScopeTab(page, '数据表');
    const useDialog = await openUserViewCreateDialog(page);
    await selectPermissionSourceType(page, useDialog, 'MYSQL');
    await selectPermissionSource(page, useDialog, resource);
    await selectPermissionCascadeToSchema(page, useDialog, dbName, dbName);
    await setPermissionTypes(page, useDialog, ['使用']);
    await setPermissionExpiry(page, useDialog, { required: true });
    await submitPermissionDialog(page, useDialog);
    // 通配记录按源维度回显：切回数据源范围核验。
    await switchResourceViewScopeTab(page, '数据源');
    await selectUserViewSubject(page, {
      subjectTab: '成员',
      subjectName: applicantUser.userName,
      subjectAlias: applicantUser.nickname,
    });
    await refreshPermissionList(page);
    const useRow = await findPermissionRow(page, sourceName, 15_000);
    expect(useRow, `B（${applicantUser.userName}）的“使用”授权未在用户视角列表回显（源：${sourceName}）`).toBeTruthy();
    await expect(useRow!).toContainText('使用', { timeout: 5_000 });

    // admin 阶段二（授权 + 回显）控制台必须干净。
    await assertNoConsoleErrors(consoleErrors);

    // ===== 5. B 正向：自助查询真实选用该源并执行 =====
    await loginAsUser(page, applicantUser);
    await openSelfServiceQueryPage(page);
    await chooseConfiguredDataSource(page, { type: 'MYSQL', name: sourceName, schema: dbName });
    await executeSql(page, `SELECT '${sqlMarker}' AS e2e_marker`);
    await expect(page.getByText(sqlMarker).first()).toBeVisible({ timeout: 30_000 });
    console.log(`USE-GRANTED-OK ${sourceName}`);

    // ===== 6. C 负向：数据源下拉按全名检索无该源 =====
    await loginAsUser(page, ungrantedUser);
    await openSelfServiceQueryPage(page);
    await expectSourceAbsentFromSelfQuery(page, sourceName);

    // ===== 7. A 管理闭环：真实编辑并保存 =====
    await loginAsUser(page, manageUser);
    await clickMenu(page, '数据接入', '数据源管理');
    await expect(page.getByText(sourceName, { exact: true }).last()).toBeVisible({ timeout: 20_000 });
    await clickCardAction(page, sourceName, '编辑');
    await fillPlaceholder(page, '请输入数据源描述', `${sourceDescription}_managedByA`);
    await clickVisible(page, '测试连接');
    await expectSuccess(page, /连接成功|测试成功|成功/);
    await clickVisible(page, /保存|确\s*定/);
    await expectSuccess(page, /保存成功|修改成功|更新成功|成功/);
    await expect(page.getByText(sourceName, { exact: true }).last()).toBeVisible({ timeout: 15_000 });
    console.log(`MANAGE-GRANTED-OK ${sourceName}`);

    // ===== 8. 清理：admin 删除自有数据源 =====
    await loginAsUser(page, adminAccount);
    await clickMenu(page, '数据接入', '数据源管理');
    let leftover = true;
    for (let attempt = 0; attempt < 2 && leftover; attempt += 1) {
      leftover = await page.getByText(sourceName, { exact: true }).first().isVisible().catch(() => false);
      if (!leftover) break;
      await clickCardAction(page, sourceName, '删除').catch(() => undefined);
      await confirmDangerDialog(page, 'DELETE').catch(() => undefined);
      await page.waitForTimeout(1_500);
      leftover = await page.getByText(sourceName, { exact: true }).first().isVisible().catch(() => false);
    }
    created = false;
    if (leftover) console.log(`CLEANUP-LEFTOVER=${sourceName}`);
    const cleanupNote = leftover
      ? `清理未完成：数据源 ${sourceName} 仍残留在数据源管理列表（见结果文件说明）`
      : `清理完成：数据源 ${sourceName} 已删除`;
    await report('DS-01-07 数据源管理权限编辑删除与使用权限访问', true,
      `数据源 ${sourceName}：admin 页面创建并开启卡片“使用”；A（${manageUser.userName}）授“管理”（数据源范围，回显含“管理”）；`
      + `B（${applicantUser.userName}）授“使用”（数据表范围表留空=源级通配，回显含“使用”）；`
      + `B 自助查询真实执行 SELECT 回显 ${sqlMarker}；C（${ungrantedUser.userName}）数据源下拉按全名检索无该源；`
      + `A 真实编辑保存成功。${cleanupNote}。`
      + (consoleErrors.length ? `注意：用户切换阶段累计控制台错误 ${consoleErrors.length} 条（非断言项）。` : ''));
  } catch (error) {
    // DS-01-06 已验证架构：主体失败先记录，finally 完成清理后再如实抛出（不掩盖、不吞错）。
    mainError = error;
  } finally {
    // ===== 清理顺序与 DS-01-06 一致：数据源 → 角色 → 用户（仅本轮 UUID 对象） =====
    if (created) {
      try {
        await page.keyboard.press('Escape').catch(() => undefined);
        await loginAsUser(page, adminAccount);
        await clickMenu(page, '数据接入', '数据源管理');
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const remaining = await page.getByText(sourceName, { exact: true }).first().isVisible().catch(() => false);
          if (!remaining) break;
          await clickCardAction(page, sourceName, '删除').catch(() => undefined);
          await confirmDangerDialog(page, 'DELETE').catch(() => undefined);
          await page.waitForTimeout(1_000);
        }
      } catch (error) {
        cleanupErrors.push(`删除数据源失败：${String(error).slice(0, 300)}`);
      }
    }
    if (rolesCreated.length > 0 || usersCreated.length > 0) {
      try {
        if (rolesCreated.length > 0) {
          await loginAsUser(page, adminAccount);
          await openRoleManagementPage(page);
          for (const roleName of rolesCreated) {
            try {
              await deleteSubjectRow(page, { queryName: '请输入角色名称', uniqueText: roleName, label: '角色' });
            } catch (error) {
              cleanupErrors.push(`删除角色“${roleName}”失败：${String(error).slice(0, 240)}`);
            }
          }
        }
        if (usersCreated.length > 0) {
          await openUserManagementPage(page);
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
  // 主体失败优先抛出并附带清理未完成说明；主体通过但清理失败也如实上抛，不伪造通过。
  if (mainError) {
    const note = cleanupErrors.length > 0 ? `（另：清理未完全成功：${cleanupErrors.join('；').slice(0, 600)}）` : '';
    if (mainError instanceof Error) mainError.message += note;
    throw mainError;
  }
  if (cleanupErrors.length > 0) {
    throw new Error(`用例主体通过，但结尾清理未完全成功（如实上报）：${cleanupErrors.join('；')}`);
  }
});


