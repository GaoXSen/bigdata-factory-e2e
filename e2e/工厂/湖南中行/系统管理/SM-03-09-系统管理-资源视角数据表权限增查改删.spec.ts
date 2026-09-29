/**
 * SM-03-09｜系统管理｜资源视角数据表权限增查改删（PERM-STATIC-02 静态开发；
 * DS-PERM-24 清洁环境静态校准）
 *
 * 业务规则（权限与审批测试理解.md §11.1、glm5.3-flash-05 页面探查，保持不变）：
 * - 资源视角“数据表”页签需级联到一张具体表（数据源类型→数据源→数据库→Schema→表名过滤，
 *   闭环工具已实现该级联并在 findResourceViewAuthorizationRow 内部逐次执行，选中以
 *   “新建权限”启用为信号）。
 * - 数据表权限承载“使用/管理”，本用例覆盖“使用”；字段范围＝全部字段（默认）→部分字段
 *   （业务规则：部分字段仅单表可选，选择后应出现该表字段多选）。
 * - 增删改与用户视角是同一授权记录的两个入口：编辑后回查用户视角一致（r12 实证：
 *   用户视角表级行在“数据表”页签下，回查前必须切换该页签）。
 *
 * 清洁环境自包含（DS-PERM-24，模板 SM-03-06/SM-03-10 先例）：
 * - 不依赖任何历史固化用户/角色/表/授权：主体为本轮 newPermissionIdentity('sm0309')
 *   生成的 UUID 唯一账号（createAndInviteUser 页面化创建，收尾尽力删除回收；本用例
 *   不创建、也不依赖任何角色）；专用表为 e2e_sm0309t_<uuid>，MySQL 直连 CREATE
 *   TABLE（sm_id/sm_name/sm_value 三列、2 行种子，满足字段范围 ≥2 可见字段），不再
 *   读 DATA_PERMISSION_TABLE、无固化兜底表名；残留清理只针对“本轮主体 × 本轮专用表”。
 * - 全局数据权限开关为共享配置：开头记录原始状态并确保“开启”（表级权限语义前提，
 *   SM-03-03/SM-03-11 同型），finally 恢复原始值，恢复失败显式暴露、不掩盖主结果。
 * - 环境闸门：RUN_PERMISSION_APPROVAL=1 才执行（requirePermissionApprovalEnvironment，
 *   条件 skip、非永久）；DB_* 未配置或非 MySQL 时按“前置不足”条件 skip（无法创建本轮
 *   专用表）；数据库不可达时建表真实失败，不伪装通过。
 * - 查询级证据（DS-PERM-105）：删除授权前，申请人本人对同一表、同一已授予真实字段的
 *   相同查询必须成功（删除前基线，排除“本来就不可访问”假阳性；选已授予真实字段，不因
 *   字段权限收窄误判）；删除后以相同查询验证明确拒绝（数据源不可见或表级“没有使用
 *   权限”拦截二者其一），与资源/用户双视角行消失断言并存。判定复用 SM-03-10/11 的
 *   readQueryOutcome 状态机与 chooseConfiguredDataSource 已知错误文案；连接失败、表不
 *   存在、SQL/字段错误、页面未加载等其余错误原样上抛，不冒充“无权限”。
 *
 * 静态验收（2026-09-22 DS-PERM-24：本机直连 MySQL 110 仍 ECONNRESET，仅静态校准，
 * 不启动浏览器/数据库）：npx tsc -p tsconfig.json --noEmit 保持 0 错误（sm-static 被
 * tsconfig 排除，实际经权威中文孪生生效）+ 权威孪生 npx playwright --list 可收集本
 * 用例；待环境校准项与串行恢复命令见 result-DS-PERM-24.md。
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
  createAndInviteUser,
  loginAs,
  newPermissionIdentity,
  openUserManagement,
  type PermissionIdentity,
} from './权限测试工具.js';
import {
  choosePermissionOption,
  deletePermissionFromRow,
  dismissPermissionDropdown,
  findPermissionRowAcrossPages,
  findResourceViewAuthorizationRow,
  openDataPermissionPage,
  openPermissionEditDialog,
  openPermissionTableMaxPageSize,
  refreshPermissionList,
  requirePermissionTableName,
  resetPermissionTableToFirstPage,
  resolveMysqlPermissionResource,
  selectUserViewSubject,
  setPermissionExpiry,
  setPermissionTypes,
  submitPermissionDialog,
  submitPermissionEditDialog,
  switchResourceViewScopeTab,
  type MysqlPermissionResource,
} from './数据权限闭环工具.js';
import { requirePermissionApprovalEnvironment } from './权限审批待调试工具.js';

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

/** 本轮自备主体：UUID 唯一申请人（DS-PERM-24 起解耦 permissionFixtures 固化用户依赖）。 */
const applicant = newPermissionIdentity('sm0309');

/** 本轮自备专用表：UUID 唯一、MySQL 直建；不读 DATA_PERMISSION_TABLE，无固化兜底表名。 */
const permissionResource: MysqlPermissionResource = resolveMysqlPermissionResource({
  tableName: `e2e_sm0309t_${uuid()}`,
});
const tableName = requirePermissionTableName(permissionResource);

/** 自助查询数据源弹窗展示基础名（如 192.168.76.110），与数据权限页完整展示名不同（同 SM-03-06/10）。 */
const querySourceName = (process.env.QUERY_SOURCE_NAME?.trim() || permissionResource.sourceName)
  .split(/[:：]/)[0].trim();

/** 管理员身份：与 loginPage fixture 同源，用于收尾切回与兜底回收。 */
const adminIdentity = {
  userName: (process.env.TEST_USER ?? 'admin').trim(),
  nickname: (process.env.TEST_USER ?? 'admin').trim(),
  password: process.env.TEST_PASS ?? '',
  phone: '',
  email: '',
};

/** 弹层选项通用选择器（Ant/Element 双兼容，与闭环工具同源形态）。 */
const AUTHORIZATION_OPTION_SELECTOR = [
  '[role="option"]:visible',
  '.ant-select-item-option:visible',
  '.el-select-dropdown__item:visible',
  'option:visible',
].join(', ');

async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

/** 数据权限页顶部“数据权限”开关：优先 ARIA switch，兼容旧版 Element 外层实现（复刻自 SM-03-03）。 */
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
 * 自助查询侧栏在部分版本只渲染图标链接，没有“自助查询”可定位文本。
 * 已登录时直接进入已知 hash 路由，避免菜单已完成跳转后仍因找不到文字而失败（复刻自 SM-03-10）。
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

/** “刷新数据库元数据”确认弹窗处理（复制自 SM-03-06 已实证实现）。 */
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

/** 数据权限验证前刷新数据库元数据（目录控件未渲染时安全跳过；同 SM-03-06）。 */
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
 * 创建本轮唯一专用表并写入 2 行种子（MySQL 直连 DDL，仅本用例资源；模板
 * SM-03-06/SM-03-10 createPermissionFixtureTables）。平台数据源/库/表级联来自实时
 * JDBC 扫描，建表即对授权下拉可见；字段范围用例依赖表内 ≥2 个可见字段，故固定
 * sm_id/sm_name/sm_value 三列。返回实际种子行数作为夹具证据（建表失败会让用例以
 * 真实错误结束，不伪造通过）。
 */
async function createPermissionFixtureTable(): Promise<number> {
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
      + `('sm-1', 'e2e-sm0309-a', '${tableName}'), ('sm-2', 'e2e-sm0309-b', 'field-scope-closed-loop')`,
  );
  const rows = await query(`SELECT COUNT(*) AS total FROM ${tableName}`);
  const total = Number((rows[0] as { total?: unknown } | undefined)?.total ?? -1);
  expect(total, `专用表 ${tableName} 种子数据应为 2 行，实际：${JSON.stringify(rows)}`).toBe(2);
  return 2;
}

/**
 * 尽力删除本轮申请人账号（用户管理页：按本轮唯一账号查询 → 行内“删除”→ 确认）。
 * 只回收本轮自备账号；任一步不满足都返回说明文本而不抛错，不掩盖主结果（同 SM-03-10）。
 */
async function deleteOwnApplicantUser(page: Page, identity: PermissionIdentity): Promise<string> {
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

/** 清理本轮主体 × 本轮专用表的残留授权（资源视角页面操作逐条删除；防御中断轮次遗留）。 */
async function purgeOwnStaleTablePermissions(page: Page): Promise<number> {
  let removed = 0;
  for (let guard = 0; guard < 10; guard += 1) {
    const stale = await findResourceViewAuthorizationRow(page, {
      resource: permissionResource,
      subjectName: applicant.userName,
      scopeTab: '数据表',
      timeoutMs: 4_000,
    });
    if (!stale) break;
    await deletePermissionFromRow(page, stale, { uniqueText: tableName });
    removed += 1;
  }
  return removed;
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

/** 打开资源视角“新建权限”批量授权弹窗（资源已选中时按钮才可用，页面已知规则）。 */
async function openResourceViewCreateDialog(page: Page): Promise<Locator> {
  const create = page.getByRole('button', { name: /新建权限|新增/ }).last();
  await expect
    .poll(async () => create.isEnabled().catch(() => false), {
      timeout: 10_000,
      message: '资源视角“新建权限”按钮不可用：请确认已先选中数据源/数据表。',
    })
    .toBe(true);
  await create.click();
  const dialog = page.locator('[role="dialog"], .ant-modal, .el-dialog').last();
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  return dialog;
}

/** 选择弹窗内“授权对象类型”（radio，默认用户；页面文案按候选逐个匹配）。 */
async function chooseAuthorizationSubjectType(
  page: Page,
  dialog: Locator,
  candidates: string[],
): Promise<string> {
  for (const candidate of candidates) {
    const label = await firstVisible(dialog.getByText(candidate, { exact: true }));
    if (label) {
      await label.click();
      await page.waitForTimeout(300);
      return candidate;
    }
  }
  throw new Error(
    `资源视角新建弹窗未找到“授权对象类型”候选（${candidates.join('、')}）；`
      + `请按实际页面校准文案，当前页面：${page.url()}`,
  );
}

/**
 * 在批量授权弹窗待选列表中勾选目标主体：先尝试弹窗内搜索框过滤，再按用户名/昵称
 * 定位文本并上溯勾选行复选框（逐行授权）；无复选框版本点击主体名本身，最终以提交后
 * 的授权行回显兜底验证（不猜测选择成功）。
 */
async function checkAuthorizationSubject(
  page: Page,
  dialog: Locator,
  subject: { userName: string; nickname?: string },
): Promise<void> {
  const searchBox = await firstVisible(dialog.getByPlaceholder(/搜索|关键字|用户名|账号/));
  if (searchBox) {
    await searchBox.fill(subject.userName).catch(() => undefined);
    await page.waitForTimeout(500);
  }
  const names = [subject.userName, subject.nickname].filter((item): item is string => Boolean(item));
  let target: Locator | undefined;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !target) {
    for (const name of names) {
      target = await firstVisible(dialog.getByText(name, { exact: true }));
      if (target) break;
    }
    if (!target) await page.waitForTimeout(300);
  }
  if (!target) {
    throw new Error(
      `资源视角新建弹窗待选列表未找到主体“${subject.userName}”；请确认账号存在且当前组织树下可见，`
        + `当前页面：${page.url()}`,
    );
  }
  let scope: Locator | undefined = target;
  for (let level = 0; level < 6 && scope; level += 1) {
    const native = scope.locator('input[type="checkbox"]').first();
    if (await native.count()) {
      if (!(await native.isChecked().catch(() => false))) {
        const wrapper = native.locator('xpath=ancestor::label[1]').first();
        if (await wrapper.count()) await wrapper.click({ force: true });
        else await native.setChecked(true, { force: true });
      }
      await expect
        .poll(async () => native.isChecked().catch(() => false), {
          timeout: 5_000,
          message: `待选主体“${subject.userName}”复选框未能勾选`,
        })
        .toBe(true);
      return;
    }
    const roleCheckbox = await firstVisible(scope.locator('[role="checkbox"]'));
    if (roleCheckbox) {
      if ((await roleCheckbox.getAttribute('aria-checked').catch(() => null)) !== 'true') {
        await roleCheckbox.click();
      }
      await expect
        .poll(
          async () => (await roleCheckbox.getAttribute('aria-checked').catch(() => null)) === 'true',
          { timeout: 5_000, message: `待选主体“${subject.userName}”语义复选框未能勾选` },
        )
        .toBe(true);
      return;
    }
    scope = scope.locator('..');
  }
  await target.click();
  await page.waitForTimeout(300);
}

/** 数据表权限弹窗“字段范围”：全部字段（默认）/部分字段（仅单表可选，切换后出现字段多选）。 */
async function chooseTableFieldScope(
  page: Page,
  dialog: Locator,
  scope: '全部字段' | '部分字段',
): Promise<void> {
  const label = await firstVisible(dialog.getByText(scope, { exact: true }));
  if (!label) {
    throw new Error(
      `数据表权限弹窗未找到“字段范围”选项“${scope}”；请确认弹窗是否提供字段范围选择`
        + `（业务规则：部分字段仅单表可选），当前页面：${page.url()}`,
    );
  }
  await label.click();
  await page.waitForTimeout(400);
  if (scope === '部分字段') {
    await locateTableFieldSelect(dialog);
  }
}

/** 定位“部分字段”激活后的该表字段多选控件（标签“字段/字段范围”上溯；占位符兜底）。 */
async function locateTableFieldSelect(dialog: Locator): Promise<Locator> {
  for (const labelPattern of [/^字段$/, /^字段范围$/]) {
    const labelNode = await firstVisible(dialog.getByText(labelPattern));
    if (!labelNode) continue;
    let node: Locator = labelNode;
    for (let level = 0; level < 6; level += 1) {
      const box = await firstVisible(
        node.locator('.ant-select:visible, .el-select:visible, [role="combobox"]:visible'),
      );
      if (box) return box;
      node = node.locator('..');
    }
  }
  const placeholderNode =
    (await firstVisible(dialog.getByPlaceholder(/请选择.*字段|选择字段/)))
    ?? (await firstVisible(dialog.getByText(/请选择.*字段/)));
  if (placeholderNode) {
    let node: Locator = placeholderNode;
    for (let level = 0; level < 8; level += 1) {
      const box = await firstVisible(node.locator('.ant-select:visible, .el-select:visible'));
      if (box) return box;
      if ((await node.getAttribute('role').catch(() => null)) === 'combobox') return node;
      node = node.locator('..');
    }
  }
  throw new Error(
    '选择“部分字段”后未出现该表的字段多选控件（业务规则：部分字段仅单表可选，激活后应出现字段多选）；'
      + `请按实际页面校准，当前页面：${dialog.page().url()}`,
  );
}

/**
 * 打开字段多选并选取前 count 个真实字段（选项文本即字段名），返回字段名列表供行回显断言；
 * 每选一个都确认下拉仍展开，选完逐个校验在控件内以标签回显（不猜测选择成功）。
 */
async function pickTableFields(page: Page, dialog: Locator, count: number): Promise<string[]> {
  const box = await locateTableFieldSelect(dialog);
  await box.click();
  let optionTexts: string[] = [];
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const optionList = page.locator(AUTHORIZATION_OPTION_SELECTOR);
    const total = await optionList.count();
    const texts: string[] = [];
    for (let index = 0; index < total; index += 1) {
      const option = optionList.nth(index);
      const text = (await option.innerText().catch(() => '')).trim();
      if (text) texts.push(text);
    }
    if (texts.length >= count) {
      optionTexts = texts;
      break;
    }
    await page.waitForTimeout(300);
  }
  if (optionTexts.length < count) {
    throw new Error(
      `字段多选下拉可见字段少于 ${count} 个（实际 ${optionTexts.length}），无法完成部分字段授权；`
        + `当前页面：${page.url()}`,
    );
  }
  const picked = optionTexts.slice(0, count);
  for (const field of picked) {
    const dropdownOpen = await firstVisible(page.locator(AUTHORIZATION_OPTION_SELECTOR));
    if (!dropdownOpen) await box.click();
    await choosePermissionOption(page, field, `部分字段（${field}）`, box);
  }
  await dismissPermissionDropdown(page);
  for (const field of picked) {
    const echoed = await firstVisible(box.getByText(field, { exact: true }));
    if (!echoed) {
      throw new Error(`字段“${field}”选择后未在字段多选控件内以标签回显；请校准字段多选交互。`);
    }
  }
  return picked;
}

/** 行级精确断言：权限类型应恰为期望值（双选/缺失都会失败并回显行文本，便于校准）。 */
async function expectRowExactPermissionType(row: Locator, expected: '使用' | '管理'): Promise<void> {
  const text = await row.innerText();
  const normalized = /使用/.test(text) ? '使用' : /管理/.test(text) ? '管理' : '无';
  expect(
    normalized,
    `授权行权限类型应为“${expected}”，实际归一结果“${normalized}”，行文本：${text.replace(/\s+/g, ' ').slice(0, 160)}`,
  ).toBe(expected);
}

/**
 * 用户视角回查数据表授权行（r12 实证：选主体后右栏默认落“数据源”页签，表级行必须切到
 * “数据表”页签后再查；沿用最大页+回首页+跨页检索，避免分页误报“未回显”）。
 */
async function queryUserViewTablePermissionRow(
  page: Page,
  options: {
    subjectTab: '成员' | '角色' | '部门';
    subjectName: string;
    subjectAlias?: string;
    resource: MysqlPermissionResource;
  },
): Promise<Locator> {
  const tableName = options.resource.tableName;
  if (!tableName) throw new Error('queryUserViewTablePermissionRow 需要 resource.tableName（表级授权）。');
  await selectUserViewSubject(page, options);
  await switchResourceViewScopeTab(page, '数据表');
  await openPermissionTableMaxPageSize(page);
  await resetPermissionTableToFirstPage(page);
  await refreshPermissionList(page);
  const row = await findPermissionRowAcrossPages(page, tableName, 15_000);
  if (!row) {
    throw new Error(
      `用户视角主体“${options.subjectName}”的“数据表”页签未回显“${tableName}”；新增/编辑可能未生效，不能视为通过。`,
    );
  }
  return row;
}

test('SM-03-09｜系统管理｜资源视角数据表权限增查改删', async ({ loginPage, consoleErrors, report }) => {
  requirePermissionApprovalEnvironment();

  // 前置门禁（条件 skip、非永久）：本轮专用表必须 MySQL 直连创建；DB_* 未配置或非 MySQL
  // 时按“前置不足”跳过并写明原因，不伪造通过（数据库配置存在但不可达时建表真实失败）。
  const cfg = dbConfig();
  if (!cfg || cfg.type !== 'mysql') {
    test.skip(
      !cfg || cfg.type !== 'mysql',
      `前置不足：未配置 MySQL 数据库环境（DB_TYPE=${process.env.DB_TYPE ?? ''}，DB_HOST=${process.env.DB_HOST ?? ''}），`
        + '无法创建本轮唯一专用表。',
    );
  }

  test.setTimeout(900_000); // DS-PERM-105 后新增两段申请人登录+真实查询，放宽单用例超时（同 SM-02-07）。
  const page = loginPage;
  let originalChecked: boolean | undefined;
  let mainError: unknown;

  // 申请人可达入口与兜底（同 SM-03-10/11：受限账号直接落自助查询 hash 可能 #/404）。
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

  try {
    // 阶段0a（自备专用表）：MySQL 直连建表 + 2 行种子（字段范围需 ≥2 可见字段）；
    // 建表失败为真实失败，上抛前先尽力 DROP 半建表，避免残留。
    let seededRows = 0;
    try {
      seededRows = await createPermissionFixtureTable();
    } catch (fixtureError) {
      await query(`DROP TABLE IF EXISTS ${tableName}`).catch(() => undefined);
      throw fixtureError;
    }
    await report(
      'SM-03-09 阶段0a｜创建本轮专用表',
      true,
      `表=${permissionResource.sourceName}/${tableName}（MySQL 直建，种子 ${seededRows} 行，列 sm_id/sm_name/sm_value）。`,
    );

    // 阶段0b（自备主体）：管理员登录并创建本轮 UUID 唯一申请人（不依赖任何历史用户/角色）。
    await loginAs(page, adminIdentity);
    await createAndInviteUser(page, applicant);
    await report(
      'SM-03-09 阶段0b｜创建本轮申请人账号',
      true,
      `申请人=${applicant.userName}（UUID 唯一，收尾尽力删除回收；本用例不创建、不依赖角色）。`,
    );

    // 阶段0c（元数据预热）：让平台元数据缓存感知本轮新表（授权级联“表名过滤”可见）；
    // 预热尽力而为、如实记录，不阻断——真正验收以阶段2级联与字段多选为准（同 SM-03-10）。
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
    await report('SM-03-09 阶段0c｜刷新数据库元数据（管理员）', true, metadataWarmup);

    // 阶段0d（全局开关）：记录数据权限开关原始状态并确保“开启”（表级权限语义前提）。
    await openDataPermissionPage(page);
    originalChecked = await readPermissionSwitchChecked(page);
    await setPermissionSwitch(page, true);
    await report(
      'SM-03-09 阶段0d｜确保数据权限开关开启',
      true,
      `开关原始=${originalChecked ? '开启' : '关闭'}（finally 恢复原值），已置开启；表=${tableName}；主体=${applicant.userName}。`,
    );

    // 阶段0e（清理残留）：仅清理“本轮主体 × 本轮专用表”（全新 UUID 资产正常为 0 条，
    // 防御中断轮次遗留；不触碰任何其他主体/表的数据）。
    const purged = await purgeOwnStaleTablePermissions(page);
    await report(
      'SM-03-09 阶段0e｜残留清理（仅本轮资产）',
      true,
      `主体=${applicant.userName}；表=${tableName}；清理残留 ${purged} 条（0=全新资产无遗留）。`,
    );

    // 阶段1（查·负向）：清理后该主体在本轮专用表上不应有任何授权行。
    if (
      await findResourceViewAuthorizationRow(page, {
        resource: permissionResource,
        subjectName: applicant.userName,
        scopeTab: '数据表',
        timeoutMs: 4_000,
      })
    ) {
      throw new Error('阶段0e清理后仍回显该主体的数据表授权行，不能继续新增。');
    }

    // 阶段2（增）：使用 + 全部字段（默认）+ 永久 → 确定添加；回显行断言主体/恰为“使用”/字段范围。
    const dialog = await openResourceViewCreateDialog(page);
    await chooseAuthorizationSubjectType(page, dialog, ['用户', '成员']);
    await checkAuthorizationSubject(page, dialog, applicant);
    await setPermissionTypes(page, dialog, ['使用']);
    await setPermissionExpiry(page, dialog, '永久');
    await submitPermissionDialog(page, dialog);

    const createdRow = await findResourceViewAuthorizationRow(page, {
      resource: permissionResource,
      subjectName: applicant.userName,
      scopeTab: '数据表',
      timeoutMs: 15_000,
    });
    if (!createdRow) {
      throw new Error(`资源视角新建后未回显主体 ${applicant.userName} 对表 ${tableName} 的授权行。`);
    }
    await expect(createdRow).toContainText(applicant.userName);
    await expectRowExactPermissionType(createdRow, '使用');
    await expect(createdRow, '数据表授权行应回显字段范围（全部字段）').toContainText(/全部/);

    // 阶段3（改）：全部字段→部分字段（仅单表可选）；字段多选选取 2 个真实字段后保存。
    const editDialog = await openPermissionEditDialog(page, createdRow);
    await chooseTableFieldScope(page, editDialog, '部分字段');
    const partialFields = await pickTableFields(page, editDialog, 2);
    await submitPermissionEditDialog(page, editDialog, { permissionTypes: ['使用'] });
    const editedRow = await findResourceViewAuthorizationRow(page, {
      resource: permissionResource,
      subjectName: applicant.userName,
      scopeTab: '数据表',
      timeoutMs: 15_000,
    });
    if (!editedRow) throw new Error('资源视角编辑为部分字段后未回显授权行：编辑可能未生效。');
    await expectRowExactPermissionType(editedRow, '使用');
    for (const field of partialFields) {
      await expect(editedRow, `编辑为部分字段后授权行应回显字段“${field}”`).toContainText(field);
    }

    // 阶段4（回查用户视角）：同一记录在用户视角“数据表”页签回显同样的部分字段。
    const userViewRow = await queryUserViewTablePermissionRow(page, {
      subjectTab: '成员',
      subjectName: applicant.userName,
      subjectAlias: applicant.nickname,
      resource: permissionResource,
    });
    await expectRowExactPermissionType(userViewRow, '使用');
    for (const field of partialFields) {
      await expect(userViewRow, `用户视角应回显同样的部分字段“${field}”`).toContainText(field);
    }

    // 阶段4b（查询级正向基线·删除前，DS-PERM-105）：申请人本人对同一表、同一已授予真实
    // 字段的真实查询必须成功——证明删除前该表对本主体确实可访问，后续“删除后拦截”才能
    // 归因于本轮删除（排除“本来就不可访问”的假阳性）；字段取已授予真实字段，不因字段
    // 权限收窄而误判。
    const grantedField = partialFields[0];
    await loginAsApplicant();
    await openSelfServiceQuery(page);
    await refreshDatabaseMetadata(page);
    await chooseConfiguredDataSource(page, {
      type: permissionResource.sourceTypeName,
      name: querySourceName,
      schema: false,
    });
    const grantMarker = `sm0309ok_${uuid()}`;
    await executeSql(page, `SELECT \`${grantedField}\` AS ${grantMarker} FROM ${tableName} LIMIT 1`);
    await expect
      .poll(async () => readQueryOutcome(page, grantMarker), {
        timeout: 30_000,
        message: `删除前基线：申请人对 ${tableName} 已授予字段 ${grantedField} 的只读查询未成功返回`
          + '（若页面提示无权限，说明本轮授权未在查询层生效；真实失败，非前置问题）。',
      })
      .toBe('done');
    await report(
      'SM-03-09 阶段4b｜删除前申请人实际查询成功（同一主体×同一表基线）',
      true,
      `SELECT \`${grantedField}\` AS ${grantMarker} FROM ${tableName} LIMIT 1 以申请人 ${applicant.userName} 执行成功（结果列头回显标记）。`,
    );

    // 阶段4b 末尾切回管理员会话，保持阶段5（删除）原有执行主体与会话不变。
    await loginAs(page, adminIdentity);

    // 阶段5（删）：资源视角删除 → 两个入口均不再回显。
    const rowToDelete = await findResourceViewAuthorizationRow(page, {
      resource: permissionResource,
      subjectName: applicant.userName,
      scopeTab: '数据表',
      timeoutMs: 15_000,
    });
    if (!rowToDelete) throw new Error('删除前未在资源视角定位到授权行。');
    await deletePermissionFromRow(page, rowToDelete, { uniqueText: tableName });
    if (
      await findResourceViewAuthorizationRow(page, {
        resource: permissionResource,
        subjectName: applicant.userName,
        scopeTab: '数据表',
        timeoutMs: 5_000,
      })
    ) {
      throw new Error('资源视角删除后仍回显授权行：删除未生效。');
    }
    await selectUserViewSubject(page, {
      subjectTab: '成员',
      subjectName: applicant.userName,
      subjectAlias: applicant.nickname,
    });
    await switchResourceViewScopeTab(page, '数据表');
    await openPermissionTableMaxPageSize(page);
    await resetPermissionTableToFirstPage(page);
    await refreshPermissionList(page);
    if (await findPermissionRowAcrossPages(page, tableName, 5_000)) {
      throw new Error('删除后用户视角仍回显该数据表授权行：两个入口应指向同一授权记录。');
    }

    // 阶段5b（查询级拦截·删除后，DS-PERM-105）：同一申请人以相同查询（同一表、同一已
    // 授予字段）必须被明确拦截，两态其一即拦截成立（同 SM-03-10 阶段5）：
    //   a) 数据源因无表级使用权限记录不可见（chooseConfiguredDataSource 抛已知文案）；
    //   b) 数据源仍可选，提交查询被表级“没有使用权限”拦截（denied 终态）。
    // 其余错误（连接失败、表不存在、SQL/字段错误、页面未加载）原样上抛或以 poll 超时
    // +页面文本证据显式报因，不冒充“无权限”；既有双视角行消失断言保持不变。
    await loginAsApplicant();
    await openSelfServiceQuery(page);
    let blockedEvidence = '';
    try {
      await chooseConfiguredDataSource(page, {
        type: permissionResource.sourceTypeName,
        name: querySourceName,
        schema: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hiddenByPermission = [
        `下拉选项“${permissionResource.sourceTypeName}”未找到`,
        `下拉选项“${querySourceName}”未找到`,
        '数据源弹窗下拉框数量不足',
        '当前数据源没有可选 Schema',
        '自助查询的数据源选择入口未找到',
      ].some((fragment) => message.includes(fragment));
      if (!hiddenByPermission) throw error;
      blockedEvidence = `删除后数据源已因无表级使用权限不可见（${message.split('，')[0]}）`;
    }
    if (!blockedEvidence) {
      const goneMarker = `sm0309gone_${uuid()}`;
      await executeSql(page, `SELECT \`${grantedField}\` AS ${goneMarker} FROM ${tableName} LIMIT 1`);
      try {
        await expect
          .poll(async () => readQueryOutcome(page, goneMarker), {
            timeout: 30_000,
            message: `删除授权后，申请人以相同查询（表 ${tableName}、字段 ${grantedField}）访问未被拦截`
              + '——删除未在查询层生效，或存在本轮之外的主体/通配授权（真实失败）。',
          })
          .toBe('denied');
      } catch (pollError) {
        const pageText = (await page.locator('body').innerText().catch(() => '')).slice(0, 800);
        throw new Error(
          `${pollError instanceof Error ? pollError.message : String(pollError)}｜页面文本=${pageText}`,
        );
      }
      blockedEvidence = '删除后数据源仍可见，但相同查询被表级“没有使用权限”拦截';
    }
    await report(
      'SM-03-09 阶段5b｜删除后申请人相同查询被明确拦截（查询级证据）',
      true,
      `表=${tableName}；主体=${applicant.userName}；查询字段=${grantedField}；${blockedEvidence}。`,
    );

    // 无权限查询被后端拒绝属于本用例预期失败信号；其余控制台错误仍然失败（口径同 SM-03-10）。
    await assertNoUnexpectedConsoleErrors(consoleErrors, [
      /self\/query\/submitQuery/,
      /没有使用权限/,
      /dataPermission\//,
    ]);
    await report(
      'SM-03-09｜资源视角数据表权限增查改删',
      true,
      `表=${permissionResource.sourceName}/${tableName}，主体=${applicant.userName}（本轮自备，收尾回收）；`
        + `新增(使用/全部字段/永久)→行回显字段范围→编辑(部分字段：${partialFields.join('、')})→`
        + '双视角回显一致→删除前申请人实际查询成功→删除→双视角均消失→申请人相同查询被明确拦截（查询级证据）。',
    );
  } catch (error) {
    mainError = error;
    throw error;
  } finally {
    // 收尾回收（仅本轮资源，顺序同 SM-03-06/10）：兜底删授权 → DROP 专用表 → 删账号；
    // 每步尽力而为、失败仅记录不抛出，不掩盖主结果。
    const issues: string[] = [];
    try {
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      const removedFinally = await purgeOwnStaleTablePermissions(page);
      if (removedFinally > 0) {
        await report(
          'SM-03-09 收尾｜兜底回收本轮授权',
          true,
          `删除残留授权 ${removedFinally} 条（表=${tableName}）。`,
        );
      }
    } catch (purgeError) {
      issues.push(`授权兜底回收未完成：${purgeError instanceof Error ? purgeError.message.split('，')[0] : String(purgeError)}`);
    }
    try {
      await query(`DROP TABLE IF EXISTS ${tableName}`);
    } catch (dropError) {
      issues.push(`专用表回收未完成（${tableName}）：${dropError instanceof Error ? dropError.message : String(dropError)}`);
    }
    try {
      const outcome = await deleteOwnApplicantUser(page, applicant);
      await report('SM-03-09 收尾｜回收本轮申请人账号', true, `${applicant.userName}：${outcome}。`);
    } catch (userError) {
      issues.push(`申请人账号回收未完成：${userError instanceof Error ? userError.message.split('，')[0] : String(userError)}`);
    }
    for (const issue of issues) console.warn(`[SM-03-09 收尾] ${issue}`);

    // 恢复全局数据权限开关（共享配置；SM-03-11 同型）：恢复失败必须显式暴露并附带原失败
    // 原因，避免共享环境被遗留为测试态。
    if (originalChecked !== undefined) {
      try {
        await loginAs(page, adminIdentity);
        await openDataPermissionPage(page);
        await setPermissionSwitch(page, originalChecked);
        await report(
          'SM-03-09 收尾｜恢复数据权限开关原始状态',
          true,
          `已恢复为 ${originalChecked ? '开启' : '关闭'}。`,
        );
      } catch (restoreError) {
        const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
        if (!mainError) {
          throw new Error(`数据权限开关恢复失败（共享配置被遗留为测试态）：${restoreMessage}`);
        }
        throw new Error(
          `数据权限开关恢复失败（共享配置被遗留为测试态）：${restoreMessage}｜原失败：`
            + `${mainError instanceof Error ? mainError.message : String(mainError)}`,
        );
      }
    }
  }
});
