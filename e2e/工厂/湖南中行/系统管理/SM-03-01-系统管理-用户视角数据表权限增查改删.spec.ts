/**
 * 系统管理 E2E 测试 — 用户视角数据表权限增查改删（DS-PERM-25 静态校准）
 *
 * 覆盖场景（用户视角配置页闭环，全部使用本轮自备资源，不触碰既有业务数据）：
 *   0. 自备资源（同 SM-03-06/SM-03-10/SM-03-11 口径）：本轮 UUID 专用表（MySQL 直连
 *      DDL+种子+收尾 DROP）、本轮成员账号（新建+邀请）、本轮角色（含“数据地图/数据查询”
 *      菜单，仅作授权主体；DS-PERM-78 起收尾尽力删除，唯一命名保证删除只命中本轮对象）；
 *   1. 数据权限开关读取原始状态并确保开启，finally 恢复原值（共享配置不留测试态）；
 *      同时保留原 SM-03-01 的入口断言：用户视角 成员/角色 主体页签、新建权限入口、
 *      MYSQL 数据源类型、权限截止时间（永久）、固定/动态 授权方式的存在性；
 *   2. 成员主体闭环：新建“使用”（永久）→ 用户视角+资源视角双回显（恰为“使用”）→
 *      编辑为“管理”（整体覆盖，不残留“使用”）→ 双视角回显恰为“管理” → 删除 →
 *      双视角确认行消失；
 *   3. 角色主体闭环：新建“使用+管理”双类型（自定义近未来截止，与“永久”互补覆盖两种
 *      截止方式）→ 双视角回显同时含“使用、管理” → 编辑收敛为仅“使用”（整体覆盖应清除
 *      “管理”）→ 双视角回显恰为“使用” → 删除 → 双视角确认行消失；
 *   4. 控制台校验：允许 dataPermission/ 接口的过程性 4xx 记录（配置类用例，同 SM-03-10），
 *      其余未声明错误必须为空。
 *
 * 业务依据（同族已实证口径）：
 *   - 数据权限闭环工具.ts：用户视角 成员/角色 主体页签；保存按 permissionList 整体覆盖；
 *     回显 permissionType 由后端拼接为“使用、管理”。
 *   - 编辑弹窗 queryInfo 接口 404 时表单不回填、保存不发请求：openPermissionEditDialog
 *     已把该后端缺陷转化为带证据的即时失败，不误报为定位问题。
 *   - r13（SM-03-06）实证：权限列表存在同名重复行与分页，用户视角回显使用跨页检索，
 *     删除按“同名可见匹配数减少”判定。
 *   - r12 实证：用户视角面板默认停“数据源”页签，表级行在“数据表”页签，查询/清理前
 *     必须显式切换页签。
 *
 * 范围边界：实际访问（自助查询放行/拦截）由 SM-03-06/SM-03-11 承载；资源级联多选与
 * 字段范围由 SM-03-10 承载；本用例只验证用户视角配置页的增查改删与双视角回显。
 *
 * 静态校准说明（2026-09-22 DS-PERM-25：MySQL 110 ECONNRESET，静态校准 + tsc 验证）：
 *   - 旧版仅做配置入口存在性校验（不落库、不选表）；本次升级为自备资源闭环，原入口
 *     断言全部保留在阶段 2 首次打开“新建权限”弹窗时执行（固定/动态 允许“单节点组合
 *     或 分立节点”两种形态，均为真实存在性断言）。
 *   - 角色/成员双主体页签与资源视角的行结构差异未见录制稿：回显断言只依赖“行文本含
 *     专用表名 + 权限类型”，不依赖列名；TODO[env] 环境恢复后 --headed 校准。
 *   - 自定义截止时间使用 +7 天近期未来日期（Ant 旧版 CalendarPicker readonly，工具限定
 *     当前/下一自然月）；TODO[env] --headed 校准日历翻月表现。
 *   - assertNoUnexpectedConsoleErrors / openSelfServiceQuery 在 e2e/utils.ts 未导出（仅
 *     权威目录 工厂/湖南中行/utils.ts 提供）；为保持 sm-static ↔ 工厂 硬链接 twin 双侧
 *     可编译（两侧 '../utils.js' 解析到不同文件），按权威实现本地复刻，不跨中文路径
 *     导入（同 SM-03-11）。
 *
 * 静态校准说明（2026-09-23 DS-PERM-78：清洁环境迁移收紧，仅静态修改 + tsc/--list 验证）：
 *   - 阶段 0c 从“尽力预热不阻断”升级为“等待本轮专用表元数据可见”：自助查询目录表名
 *     搜索框存在时，必须轮询到本轮 UUID 表名命中（等待期内每 30 秒重试一次“刷新数据
 *     库元数据”，覆盖元数据缓存惰性索引），超时显式失败——元数据不可见时阶段 2 级联
 *     必然选不到表，必须前置暴露而不是拖到弹窗内超时；目录控件未渲染的页面形态保持
 *     降级说明，由阶段 2 级联选择兜底硬性验证。
 *   - “同一授权标签”显式化：本轮授权标签 =（本轮主体 × 本轮表）唯一对。用户视角按本轮
 *     表名跨页精确定位（queryUserViewPermissionRowAcrossPages），资源视角按本轮主体名
 *     在已选中本轮表的列表内精确定位（findResourceViewAuthorizationRow）；双视角行的
 *     权限类型逐字段相等断言（恰为一类/恰为双类）即同一授权记录的交叉回显，全程不读、
 *     不依赖任何历史授权记录。
 *   - finally 回收顺序固定为：兜底删本轮授权 → 恢复数据权限开关原值 → DROP 本轮专用表
 *     → 删本轮成员账号 → 删本轮角色（DS-PERM-78 起角色不再“用后保留”；deleteOwnRole
 *     按 SM-00-01 已实证实现本地复刻，删除入口缺失时返回说明文本并计入 issues，不抛
 *     错）。开关恢复失败仍显式抛出，但推迟到表/账号/角色回收全部执行完之后，避免收尾
 *     中途抛错把本轮物理资产遗留成孤儿。
 *
 * 静态校准说明（2026-09-23 DS-PERM-90：scoped cleanup 失败上抛补齐，仅静态修改 + tsc/--list 验证）：
 *   - finally 任一 scoped cleanup（兜底授权回收／开关恢复／专用表 DROP／成员账号／角色）
 *     未完成时不再仅 console.warn 放行：主体成功则聚合上抛（错误信息逐项列出未完成资产），
 *     主体失败则保留原错误（不改错误类型）并把未完成资产逐项附到原错误信息后原样上抛；
 *     各清理步骤互相不中断（错误聚合而非 fail-fast），剩余资产仍会继续回收。
 *   - deleteOwnMemberUser/deleteOwnRole 返回文本改用 DM-09-01（DS-PERM-86）已验证约定：
 *     以“回收未完成：”前缀标记未完成步骤（调用方计入 issues，收尾末尾统一裁决上抛）、
 *     以“无需回收：”标记此前已删除（不算未完成，避免把“已清干净”误报为失败），并增加
 *     删除提交后列表仍回显的复验，保证“已确认不再显示”文案真实成立；删除只按本轮 UUID
 *     唯一命名定位，范围不变。
 */
import type { Locator, Page } from '@playwright/test';
import {
  chooseConfiguredDataSource,
  dbConfig,
  expect,
  query,
  test,
  uuid,
} from '../utils.js';
import {
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
  type PermissionExpiryMode,
  type UserViewSubjectTab,
  deletePermissionFromRow,
  findPermissionRow,
  findResourceViewAuthorizationRow,
  openDataPermissionPage,
  openPermissionEditDialog,
  openUserViewCreateDialog,
  queryUserViewPermissionRowAcrossPages,
  refreshPermissionList,
  requirePermissionTableName,
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

/** 本轮自备成员主体：UUID 唯一命名并现场创建（新建+邀请进入管理员当前组织）。 */
const memberIdentity = newPermissionIdentity('sm0301');

/** 本轮自备角色主体：仅作为授权主体（不分配用户、不登录）；DS-PERM-78 起收尾尽力删除。 */
const roleSubject = newPermissionRole('sm0301', 'subject');

/** 本轮专用测试表：MySQL 直连创建（DDL+种子），收尾 DROP；不依赖 DATA_PERMISSION_TABLE。 */
const permissionResource: MysqlPermissionResource = resolveMysqlPermissionResource({
  tableName: `e2e_sm0301_${uuid()}`,
});
const tableName = requirePermissionTableName(permissionResource);

/** 角色主体新建使用“使用+管理”双类型 + 自定义近未来截止（+7 天，必在当前/下一自然月内）。 */
const roleCustomExpiry: PermissionExpiryMode = (() => {
  const target = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    customTime: `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())} 23:59:59`,
  };
})();

/** 自助查询数据源弹窗展示基础名（如 192.168.76.110），与数据权限页完整展示名不同（同 SM-03-06）。 */
const querySourceName = (process.env.QUERY_SOURCE_NAME?.trim() || permissionResource.sourceName)
  .split(/[:：]/)[0].trim();

/** 管理员身份：与 loginPage fixture 同源，用于收尾切回。 */
const adminIdentity: PermissionIdentity = {
  userName: (process.env.TEST_USER ?? 'admin').trim(),
  nickname: (process.env.TEST_USER ?? 'admin').trim(),
  password: process.env.TEST_PASS ?? '',
  phone: '',
  email: '',
};

/** 主体条目：成员/角色两类（部门主体与策略由 SM-03-11 承载）。 */
interface SubjectTarget {
  key: '成员' | '角色';
  subjectTab: UserViewSubjectTab;
  subjectName: string;
  subjectAlias?: string;
}

const subjectTargets: SubjectTarget[] = [
  {
    key: '成员',
    subjectTab: '成员',
    subjectName: memberIdentity.userName,
    subjectAlias: memberIdentity.nickname,
  },
  {
    key: '角色',
    subjectTab: '角色',
    subjectName: roleSubject.roleName,
  },
];

/** selectUserViewSubject 的定位参数（不含 resource；subjectAlias 仅成员页签需要）。 */
function subjectOptionsOf(subject: SubjectTarget): {
  subjectTab: UserViewSubjectTab;
  subjectName: string;
  subjectAlias?: string;
} {
  return {
    subjectTab: subject.subjectTab,
    subjectName: subject.subjectName,
    ...(subject.subjectAlias ? { subjectAlias: subject.subjectAlias } : {}),
  };
}

/** 数据权限页顶部“数据权限”开关：优先 ARIA switch，兼容旧版 Element 外层实现（复刻自 SM-03-03/11）。 */
function permissionSwitchLocator(page: Page): Locator {
  return page
    .locator('[role="switch"]:visible, .el-switch[role="switch"]:visible, .el-switch:visible')
    .first();
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
 * 断言权限行权限类型恰为 expected（复制自 SM-03-06/10/11 同名实现）：除包含 expected 外，
 * 还断言另一类型不残留，防止“使用、管理”被误判成单一类型；行文本级判断安全
 * （行内主体名/表名均不含“使用/管理”字样）。
 */
async function expectRowExactPermissionType(
  row: Locator,
  expected: DataPermissionTypeFlag,
): Promise<void> {
  const raw = await row.innerText({ timeout: 5_000 }).catch(() => '');
  const normalized = raw.replace(/\s+/g, '');
  const other: DataPermissionTypeFlag = expected === '使用' ? '管理' : '使用';
  expect(normalized, `权限行应包含权限类型“${expected}”，实际行文本：${raw}`).toContain(expected);
  expect(
    normalized,
    `权限行不应残留权限类型“${other}”（新增/编辑应为整体覆盖，实际行文本：${raw}）`,
  ).not.toContain(other);
}

/** 双类型回显断言：行文本应同时包含“使用”与“管理”（后端拼接为“使用、管理”）。 */
async function expectRowDualPermissionTypes(row: Locator): Promise<void> {
  const raw = await row.innerText({ timeout: 5_000 }).catch(() => '');
  const normalized = raw.replace(/\s+/g, '');
  expect(normalized, `权限行应同时包含“使用”与“管理”，实际行文本：${raw}`).toContain('使用');
  expect(normalized, `权限行应同时包含“使用”与“管理”，实际行文本：${raw}`).toContain('管理');
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

/** 自助查询验证前刷新数据库元数据（目录控件未渲染时安全跳过；同 SM-03-06/11）。 */
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

/** 打开“自助查询”菜单（本地复刻权威 utils 实现：sm-static 侧 e2e/utils.ts 未导出，见文件头说明）。 */
async function openSelfServiceQuery(page: Page): Promise<void> {
  await page.getByText(/自助查询/).first().click();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1_500);
}

/**
 * 等待本轮专用表在平台元数据中可见（DS-PERM-78 硬性要求）：在自助查询目录搜索框
 * 输入本轮 UUID 表名并轮询目录树命中；等待期内每 30 秒重试一次“刷新数据库元数据”，
 * 覆盖元数据缓存惰性索引的形态。超过时限仍未命中时显式失败——元数据不可见时阶段 2
 * 级联必然选不到表，必须前置暴露，而不是拖到弹窗内变成无定性超时。
 */
async function waitForRoundTableMetadataVisible(page: Page, timeoutMs = 90_000): Promise<string> {
  const treeSearch = page.getByRole('textbox', { name: /搜索表名|存储过程/ });
  await expect(treeSearch, '自助查询目录未出现表名搜索框，无法验证本轮表元数据可见').toBeVisible({
    timeout: 10_000,
  });
  const deadline = Date.now() + timeoutMs;
  let nextRefreshAt = Date.now();
  for (;;) {
    await treeSearch.fill(tableName);
    await page.waitForTimeout(800);
    if (await page.getByText(tableName, { exact: true }).first().isVisible().catch(() => false)) {
      return `本轮表 ${tableName} 已在自助查询目录可见（平台元数据已索引本轮物理表）。`;
    }
    if (Date.now() >= deadline) break;
    if (Date.now() >= nextRefreshAt) {
      nextRefreshAt = Date.now() + 30_000;
      await refreshDatabaseMetadata(page);
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(
    `本轮专用表 ${tableName} 在自助查询目录等待 ${Math.round(timeoutMs / 1000)} 秒仍不可见`
      + '（已重试“刷新数据库元数据”）：平台元数据未索引本轮物理表，数据权限级联将无法选表，需检查元数据同步。',
  );
}

/** 控制台错误门禁（本地复刻权威 utils 实现；同 SM-03-10/11 配置类用例口径）。 */
function assertNoUnexpectedConsoleErrors(consoleErrors: string[], allowedPatterns: RegExp[]): void {
  const unexpected = consoleErrors.filter(
    (message) => !allowedPatterns.some((pattern) => pattern.test(message)),
  );
  expect(unexpected, '出现未声明的控制台错误（允许清单之外）').toEqual([]);
}

/**
 * 创建本轮专用表（MySQL 直连，同 SM-03-10/11 口径）：DDL + 2 行种子；不使用共享表。
 * 同一轮内重试复用同一表名：先 DROP 再 CREATE，避免 DDL 报“表已存在”。
 */
async function createPermissionFixtureTable(): Promise<number> {
  const columns =
    'sm_id varchar(64) NOT NULL,'
    + 'sm_name varchar(128) DEFAULT NULL,'
    + 'sm_value varchar(128) DEFAULT NULL,'
    + 'PRIMARY KEY (sm_id)';
  await query(`DROP TABLE IF EXISTS ${tableName}`);
  await query(`CREATE TABLE ${tableName} (${columns}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await query(
    `INSERT INTO ${tableName} (sm_id, sm_name, sm_value) VALUES `
      + `('sm-1', 'e2e-sm0301-a', '${tableName}'), `
      + `('sm-2', 'e2e-sm0301-b', 'user-view-crud-closed-loop')`,
  );
  const rows = await query(`SELECT COUNT(*) AS total FROM ${tableName}`);
  const total = Number((rows[0] as { total?: unknown } | undefined)?.total ?? -1);
  expect(total, `专用表 ${tableName} 种子数据应为 2 行，实际：${JSON.stringify(rows)}`).toBe(2);
  return 2;
}

/**
 * 删除本轮成员账号（用户管理页：按本轮唯一账号查询 → 行内“删除”→ 确认）。只回收本轮
 * 自备账号，不抛错、不掩盖主结果。返回文本约定（DS-PERM-90，同 DM-09-01/DS-PERM-86 已
 * 验证口径）：以“回收未完成：”前缀标记未完成步骤（调用方计入 issues，收尾末尾统一裁决
 * 上抛）；以“无需回收：”标记此前已删除（不算未完成）。
 */
async function deleteOwnMemberUser(page: Page): Promise<string> {
  await openUserManagement(page);
  const search = page.getByRole('textbox', { name: '请输入用户名称' }).first();
  await search.fill(memberIdentity.userName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(800);
  const userText = page.getByText(memberIdentity.userName, { exact: true }).last();
  if (!(await userText.isVisible().catch(() => false))) {
    return '无需回收：列表未查询到本轮账号（可能此前已删除）';
  }
  const row = userText.locator('xpath=ancestor::tr[1]');
  if (!(await row.isVisible().catch(() => false))) {
    return '回收未完成：账号可见但未取到表格行（账号保留）';
  }
  const deleteButton = row.getByRole('button', { name: /删\s*除/ }).first();
  if (!(await deleteButton.isVisible().catch(() => false))) {
    return '回收未完成：行内未找到“删除”入口（账号保留）';
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
    return '回收未完成：已提交删除但列表仍回显该账号';
  }
  return '已回收：已提交删除并确认列表不再显示该账号';
}

/**
 * 删除本轮自建角色（角色管理页：按本轮唯一角色名查询 → 行内“删除”→ 确认；
 * DS-PERM-78 要求 finally 回收本轮用户/角色）。实现按 SM-00-01 已实证版本本地复刻
 * （公共工具无导出且本任务禁止改公共工具）；查询按本轮 UUID 唯一角色名过滤，只可能
 * 命中本轮自建角色。返回文本约定（DS-PERM-90，同 DM-09-01/DS-PERM-86 已验证口径）：
 * 以“回收未完成：”前缀标记未完成步骤（删除入口缺失、后端拒绝或结构变化，调用方计入
 * issues 并在收尾末尾统一裁决上抛）；以“无需回收：”标记此前已删除（不算未完成）；
 * 不抛错、不掩盖主结果。
 */
async function deleteOwnRole(page: Page): Promise<string> {
  await openRoleManagement(page);
  const search = page.getByRole('textbox', { name: '请输入角色名称' }).first();
  await search.fill(roleSubject.roleName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(800);
  const roleText = page.getByText(roleSubject.roleName, { exact: true }).last();
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
  if (!row) return '回收未完成：角色可见但未取到表格行（角色保留）';
  const deleteButton = row.getByRole('button', { name: /删\s*除/ }).first();
  if (!(await deleteButton.isVisible().catch(() => false))) {
    return '回收未完成：角色行未提供“删除”入口（角色保留，需人工确认）';
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
 * 防御性清理（仅 本轮主体 × 本轮表/数据源，同 SM-03-11 实证结构）：选主体 → “数据表”
 * 页签逐条删除专用表残留（r12：默认停“数据源”页签会漏删）→ “数据源”页签清理数据源
 * 级残留。全新 UUID 正常为 0 条；仅同 UUID 重试轮次才可能命中。删除按“同名可见匹配
 * 数减少”判定（r13 实证存在同名重复行与分页）。返回删除条数。
 */
async function purgeSubjectStalePermissions(page: Page, subject: SubjectTarget): Promise<number> {
  await selectUserViewSubject(page, subjectOptionsOf(subject));
  let removed = 0;
  await switchResourceViewScopeTab(page, '数据表');
  await refreshPermissionList(page);
  for (let guard = 0; guard < 20; guard += 1) {
    const stale = await findPermissionRow(page, tableName, 5_000);
    if (!stale) break;
    await deletePermissionFromRow(page, stale, { uniqueText: tableName });
    removed += 1;
    await refreshPermissionList(page);
  }
  await switchResourceViewScopeTab(page, '数据源');
  await refreshPermissionList(page);
  for (let guard = 0; guard < 3; guard += 1) {
    const staleSource = await findPermissionRow(page, permissionResource.sourceName, 4_000);
    if (!staleSource) break;
    await deletePermissionFromRow(page, staleSource, { uniqueText: permissionResource.sourceName });
    removed += 1;
    await refreshPermissionList(page);
  }
  return removed;
}

/**
 * 用户视角定位本轮权限行（跨页）：重选主体 → 切“数据表”页签（r12：默认停“数据源”
 * 页签会漏看表级行）→ 复用共享跨页查询断言（未回显时抛错，不视为通过）。
 */
async function findUserViewRow(page: Page, subject: SubjectTarget): Promise<Locator> {
  await selectUserViewSubject(page, subjectOptionsOf(subject));
  await switchResourceViewScopeTab(page, '数据表');
  return queryUserViewPermissionRowAcrossPages(page, {
    ...subjectOptionsOf(subject),
    resource: permissionResource,
  });
}

/** 资源视角（数据表页签）交叉定位：返回授权行；未回显返回 undefined 由调用方判定。 */
async function findResourceViewRow(
  page: Page,
  subject: SubjectTarget,
  timeoutMs = 15_000,
): Promise<Locator | undefined> {
  return findResourceViewAuthorizationRow(page, {
    resource: permissionResource,
    subjectName: subject.subjectName,
    scopeTab: '数据表',
    timeoutMs,
  });
}

/**
 * 删除后的交叉确认：资源视角（数据表页签）不再回显该主体对本轮表的授权行；
 * 仍回显即删除未生效，明确失败。
 */
async function expectSubjectRowGone(page: Page, subject: SubjectTarget): Promise<void> {
  const resourceEchoRow = await findResourceViewRow(page, subject, 6_000);
  if (resourceEchoRow) {
    throw new Error(
      `删除后资源视角（数据表页签）仍回显${subject.key}“${subject.subjectName}”`
        + `对 ${tableName} 的授权，删除可能未生效。`,
    );
  }
}

/**
 * 用户视角新建授权（每次只变更一个主体，变更即验证）：选主体 → 切“数据表”页签 →
 * 新建权限 → 表级联选本轮表 → 权限类型/截止时间 → 提交。withEntryAssertions 时保留
 * 原 SM-03-01 的入口存在性断言（MYSQL 回显、权限截止时间/永久、固定·动态）。
 */
async function grantTablePermission(
  page: Page,
  subject: SubjectTarget,
  options: {
    types: DataPermissionTypeFlag[];
    expiry?: PermissionExpiryMode;
    withEntryAssertions?: boolean;
  },
): Promise<void> {
  await selectUserViewSubject(page, subjectOptionsOf(subject));
  await switchResourceViewScopeTab(page, '数据表');
  const dialog = await openUserViewCreateDialog(page);
  if (options.withEntryAssertions) {
    await expect(
      dialog.getByRole('combobox').first(),
      '新建权限弹窗未出现数据源类型下拉',
    ).toBeVisible();
  }
  await selectPermissionTableScope(page, dialog, permissionResource);
  if (options.withEntryAssertions) {
    // 原 SM-03-01 入口断言保留（校准点：从“仅选数据源类型后”平移到“完整选完表级联后”，
    // 存在性语义不变）：MYSQL 回显 + 权限截止时间/永久 + 固定/动态（组合或分立节点均可）。
    await expect(dialog, '选表后弹窗应回显 MYSQL 数据源类型').toContainText(/MYSQL/);
    await expect(dialog.getByText(/权限截止时间/).first()).toBeVisible();
    await expect(dialog.getByText(/永\s*久/).first()).toBeVisible();
    const combined = dialog.getByText(/固定.*动态|动态.*固定/).first();
    if (await combined.isVisible().catch(() => false)) {
      await expect(combined).toBeVisible();
    } else {
      await expect(dialog.getByText(/固\s*定/).first(), '未找到“固定”授权方式').toBeVisible();
      await expect(dialog.getByText(/动\s*态/).first(), '未找到“动态”授权方式').toBeVisible();
    }
  }
  await setPermissionTypes(page, dialog, options.types);
  if (options.expiry) await setPermissionExpiry(page, dialog, options.expiry);
  await submitPermissionDialog(page, dialog);
}

test.describe.configure({ mode: 'serial', timeout: 720_000 });

test.describe('SM-03-01｜系统管理｜用户视角数据表权限增查改删', () => {
  test('SM-03-01｜系统管理｜用户视角数据表权限增查改删', async ({
    loginPage,
    consoleErrors,
    report,
  }) => {
    requirePermissionApprovalEnvironment();
    // 前置门禁：本轮专用表需要 MySQL 直连（DB_*，即 MySQL 110）；未配置按前置不足跳过。
    const cfg = dbConfig();
    if (!cfg || cfg.type !== 'mysql') {
      test.skip(
        true,
        `前置不足：未配置 MySQL 数据库环境（DB_HOST=${process.env.DB_HOST ?? ''}，`
          + `DB_TYPE=${process.env.DB_TYPE ?? ''}），无法创建本轮唯一专用表。`,
      );
    }
    const page = loginPage;

    let originalChecked: boolean | undefined;
    let started = false;
    let mainError: unknown;
    let mainFailed = false;
    const issues: string[] = [];
    try {
      started = true;
      // 阶段 0a：本轮专用表（MySQL 直连 DDL + 2 行种子）。
      const seededRows = await createPermissionFixtureTable();
      await report(
        'SM-03-01 阶段0a｜创建本轮专用表',
        true,
        `专用表=${tableName}（MySQL 直连创建，种子 ${seededRows} 行；收尾 DROP 回收）。`,
      );

      // 阶段 0b：本轮自备主体：成员（新建+邀请）与角色（仅作授权主体）。
      await createAndInviteUser(page, memberIdentity);
      await createRole(page, roleSubject, ['数据地图', '数据查询']);
      await report(
        'SM-03-01 阶段0b｜创建本轮成员与角色主体',
        true,
        `成员=${memberIdentity.userName}；角色=${roleSubject.roleName}（角色仅作授权主体，不分配用户；`
          + 'DS-PERM-78 起收尾尽力删除本轮角色，唯一命名保证删除只命中本轮对象）。',
      );

      // 阶段 0c：等待本轮专用表元数据可见（管理员；DS-PERM-78 硬性要求，见文件头校准说明）。
      let metadataWarmup: string;
      const catalog = await (async (): Promise<{ ready: boolean; message: string }> => {
        try {
          await openSelfServiceQuery(page);
          await chooseConfiguredDataSource(page, {
            type: permissionResource.sourceTypeName,
            name: querySourceName,
            schema: false,
          });
          await refreshDatabaseMetadata(page);
          return { ready: true, message: '' };
        } catch (catalogError) {
          return {
            ready: false,
            message: `目录控件未渲染或数据源选择未完成，按 SM-03-03 语义降级`
              + `（阶段 2 级联选择仍会硬性验证本轮表可见）：${
                catalogError instanceof Error ? catalogError.message.split('，')[0] : String(catalogError)
              }`,
          };
        }
      })();
      if (catalog.ready) {
        // 目录控件存在时必须等到本轮表元数据可见；超时未可见显式失败（不静默降级）。
        metadataWarmup = await waitForRoundTableMetadataVisible(page);
      } else {
        metadataWarmup = catalog.message;
      }
      await report('SM-03-01 阶段0c｜等待本轮表元数据可见（管理员）', true, metadataWarmup);

      // 阶段 1：进入数据权限页，保留原入口断言（成员/角色主体页签可见），读取并确保开关开启。
      await openDataPermissionPage(page);
      for (const subjectTab of ['成员', '角色'] as const) {
        await expect(page.locator('body'), `用户视角应出现“${subjectTab}”主体页签`).toContainText(
          subjectTab,
        );
      }
      originalChecked = await readPermissionSwitchChecked(page);
      await setPermissionSwitch(page, true);
      await report(
        'SM-03-01 阶段1｜确保数据权限开关开启',
        true,
        `用户视角“成员/角色”主体页签可见；开关原始=${originalChecked ? '开启' : '关闭'}`
          + '（收尾恢复原值），已置开启。',
      );

      // 阶段 1b：防御性残留清理（仅 本轮主体×本轮表；全新 UUID 正常为 0 条，保护同 UUID 重试轮次）。
      let purgedTotal = 0;
      for (const subject of subjectTargets) {
        purgedTotal += await purgeSubjectStalePermissions(page, subject);
      }
      await report(
        'SM-03-01 阶段1b｜防御性残留清理（仅本轮主体×本轮表）',
        true,
        `共清理 ${purgedTotal} 条（0=全新 UUID 正常，>0=同轮重试残留）；两个页签残留一并清理。`,
      );

      // 阶段 2：成员主体 新建“使用”（永久）→ 双视角回显恰为“使用”；原入口断言在此执行。
      const memberSubject = subjectTargets[0];
      await grantTablePermission(page, memberSubject, {
        types: ['使用'],
        expiry: '永久',
        withEntryAssertions: true,
      });
      const memberRow = await findUserViewRow(page, memberSubject);
      await expectRowExactPermissionType(memberRow, '使用');
      const memberEchoRow = await findResourceViewRow(page, memberSubject);
      if (!memberEchoRow) {
        throw new Error(
          `资源视角（数据表页签）未回显成员“${memberSubject.subjectName}”对 ${tableName} 的“使用”授权。`,
        );
      }
      await expectRowExactPermissionType(memberEchoRow, '使用');
      await report(
        'SM-03-01 阶段2｜成员新建“使用”授权双视角回显',
        true,
        `成员“${memberSubject.subjectName}”对 ${tableName} 新建“使用”（永久）授权已在成员页签与`
          + '资源视角（数据表）双回显，且不残留“管理”；原入口断言（成员/角色页签、新建权限、'
          + 'MYSQL 类型、权限截止时间（永久）、固定/动态）全部保留并通过。',
      );

      // 阶段 3：成员 编辑为“管理”（整体覆盖，不残留“使用”）→ 双视角回显恰为“管理”。
      const memberEditRow = await findUserViewRow(page, memberSubject);
      const memberEditDialog = await openPermissionEditDialog(page, memberEditRow);
      await submitPermissionEditDialog(page, memberEditDialog, { permissionTypes: ['管理'] });
      const memberAfterEdit = await findUserViewRow(page, memberSubject);
      await expectRowExactPermissionType(memberAfterEdit, '管理');
      const memberEchoAfterEdit = await findResourceViewRow(page, memberSubject);
      if (!memberEchoAfterEdit) {
        throw new Error(
          `编辑为“管理”后资源视角未回显成员“${memberSubject.subjectName}”对 ${tableName} 的授权。`,
        );
      }
      await expectRowExactPermissionType(memberEchoAfterEdit, '管理');
      await report(
        'SM-03-01 阶段3｜成员编辑为“管理”整体覆盖生效',
        true,
        `成员“${memberSubject.subjectName}”的授权编辑为“管理”后，双视角回显恰为“管理”，“使用”未残留（整体覆盖）。`,
      );

      // 阶段 4：删除成员授权 → 双视角确认行消失。
      const memberDeleteRow = await findUserViewRow(page, memberSubject);
      await deletePermissionFromRow(page, memberDeleteRow, { uniqueText: tableName });
      await expectSubjectRowGone(page, memberSubject);
      await report(
        'SM-03-01 阶段4｜成员授权删除后双视角行消失',
        true,
        `成员“${memberSubject.subjectName}”对 ${tableName} 的授权已删除，用户视角与资源视角均不再回显。`,
      );

      // 阶段 5：角色主体 新建“使用+管理”双类型（自定义近未来截止）→ 双视角回显同时含两类。
      const roleSubjectTarget = subjectTargets[1];
      await grantTablePermission(page, roleSubjectTarget, {
        types: ['使用', '管理'],
        expiry: roleCustomExpiry,
      });
      const roleRow = await findUserViewRow(page, roleSubjectTarget);
      await expectRowDualPermissionTypes(roleRow);
      const roleEchoRow = await findResourceViewRow(page, roleSubjectTarget);
      if (!roleEchoRow) {
        throw new Error(
          `资源视角（数据表页签）未回显角色“${roleSubjectTarget.subjectName}”对 ${tableName} 的双类型授权。`,
        );
      }
      await expectRowDualPermissionTypes(roleEchoRow);
      const roleRowText = await roleRow.innerText({ timeout: 5_000 }).catch(() => '');
      await report(
        'SM-03-01 阶段5｜角色新建“使用+管理”双类型授权双视角回显',
        true,
        `角色“${roleSubjectTarget.subjectName}”对 ${tableName} 新建“使用+管理”双类型授权已在角色页签与`
          + `资源视角双回显（行文本：${roleRowText.replace(/\s+/g, ' ').trim()}）；截止时间为自定义近未来`
          + `（${roleCustomExpiry.customTime}，与成员的“永久”互补覆盖两种截止方式）。`,
      );

      // 阶段 6：角色 编辑收敛为仅“使用”（整体覆盖应清除“管理”）→ 双视角回显恰为“使用”。
      const roleEditRow = await findUserViewRow(page, roleSubjectTarget);
      const roleEditDialog = await openPermissionEditDialog(page, roleEditRow);
      await submitPermissionEditDialog(page, roleEditDialog, { permissionTypes: ['使用'] });
      const roleAfterEdit = await findUserViewRow(page, roleSubjectTarget);
      await expectRowExactPermissionType(roleAfterEdit, '使用');
      const roleEchoAfterEdit = await findResourceViewRow(page, roleSubjectTarget);
      if (!roleEchoAfterEdit) {
        throw new Error(
          `编辑收敛后资源视角未回显角色“${roleSubjectTarget.subjectName}”对 ${tableName} 的授权。`,
        );
      }
      await expectRowExactPermissionType(roleEchoAfterEdit, '使用');
      await report(
        'SM-03-01 阶段6｜角色双类型编辑收敛为“使用”',
        true,
        `角色“${roleSubjectTarget.subjectName}”的授权由“使用+管理”编辑为仅“使用”后，双视角回显恰为“使用”，“管理”未残留。`,
      );

      // 阶段 7：删除角色授权 → 双视角确认行消失。
      const roleDeleteRow = await findUserViewRow(page, roleSubjectTarget);
      await deletePermissionFromRow(page, roleDeleteRow, { uniqueText: tableName });
      await expectSubjectRowGone(page, roleSubjectTarget);
      await report(
        'SM-03-01 阶段7｜角色授权删除后双视角行消失',
        true,
        `角色“${roleSubjectTarget.subjectName}”对 ${tableName} 的授权已删除，用户视角与资源视角均不再回显。`,
      );

      await assertNoUnexpectedConsoleErrors(consoleErrors, [/dataPermission\//]);
      await report(
        'SM-03-01｜用户视角数据表权限增查改删闭环完成',
        true,
        '成员/角色两类主体均完成 新建→双视角回显→编辑（整体覆盖：单→单、双→单）→删除（双视角消失）'
          + '闭环；权限截止时间覆盖 永久 与 自定义近未来 两种方式；原配置入口断言全部保留；'
          + '控制台无未声明错误（允许 dataPermission/ 过程性 4xx）。',
      );
    } catch (error) {
      // DS-PERM-90：先记录主体错误，由 finally 在全部收尾执行完后统一裁决（原错误原样
      // 上抛并附带清理未完成信息），避免收尾中途抛错掩埋主体失败。
      mainError = error;
      mainFailed = true;
    } finally {
      // 收尾 1：管理员登录 → 兜底清理本轮主体残留授权 → 恢复开关原始状态（共享配置，硬性）。
      // DS-PERM-78：开关恢复失败延迟记录，避免收尾中途抛错把本轮物理资产遗留成孤儿；
      // DS-PERM-90：延迟记录的开关恢复失败与其它回收未完成项在收尾末尾统一裁决上抛。
      let restoreFailure: string | undefined;
      if (started) {
        try {
          await loginAs(page, adminIdentity);
          await openDataPermissionPage(page);
          let removedFinally = 0;
          for (const subject of subjectTargets) {
            try {
              removedFinally += await purgeSubjectStalePermissions(page, subject);
            } catch (purgeError) {
              issues.push(
                `主体“${subject.subjectName}”残留授权回收未完成：${
                  purgeError instanceof Error ? purgeError.message.split('，')[0] : String(purgeError)
                }`,
              );
            }
          }
          if (removedFinally > 0) {
            await report(
              'SM-03-01 收尾｜兜底回收本轮授权',
              true,
              `删除残留授权 ${removedFinally} 条（表=${tableName}）。`,
            );
          }
          if (originalChecked !== undefined) {
            await setPermissionSwitch(page, originalChecked);
            await report(
              'SM-03-01 收尾｜恢复数据权限开关原始状态',
              true,
              `已恢复为 ${originalChecked ? '开启' : '关闭'}。`,
            );
          }
        } catch (restoreError) {
          const restoreMessage =
            restoreError instanceof Error ? restoreError.message : String(restoreError);
          if (originalChecked !== undefined) {
            // 共享开关恢复失败必须显式暴露（DS-PERM-90：仅记录，由收尾末尾统一裁决——
            // 主体失败时附到原错误信息、主体成功时聚合上抛；此处不再内联原失败避免重复）。
            restoreFailure = `数据权限开关恢复失败（共享配置被遗留为测试态）：${restoreMessage}`;
          } else {
            issues.push(`收尾登录/清理未完成：${restoreMessage.split('，')[0]}`);
          }
        }
      }
      // 收尾 2：回收本轮专用表（MySQL 直连 DROP；失败记录为 issue，收尾末尾统一裁决，不伪造通过）。
      if (started) {
        try {
          await query(`DROP TABLE IF EXISTS ${tableName}`);
        } catch (dropError) {
          issues.push(
            `专用表回收未完成（${tableName}）：${
              dropError instanceof Error ? dropError.message : String(dropError)
            }`,
          );
        }
      }
      // 收尾 3：尽力删除本轮成员账号（DS-PERM-78 顺序：授权→开关→表→用户/角色）。
      if (started) {
        try {
          const outcome = await deleteOwnMemberUser(page);
          if (outcome.startsWith('回收未完成')) {
            issues.push(`成员账号${outcome}`);
          } else {
            await report(
              'SM-03-01 收尾｜回收本轮成员账号',
              true,
              `${memberIdentity.userName}：${outcome}。`,
            );
          }
        } catch (userError) {
          issues.push(
            `成员账号回收未完成：${
              userError instanceof Error ? userError.message.split('，')[0] : String(userError)
            }`,
          );
        }
      }
      // 收尾 4：尽力删除本轮角色（DS-PERM-78：本轮用户/角色一律回收，不再“用后保留”；
      // deleteOwnRole 按 SM-00-01 已实证实现本地复刻，只命中本轮 UUID 唯一命名角色）。
      if (started) {
        try {
          const outcome = await deleteOwnRole(page);
          if (outcome.startsWith('回收未完成')) {
            issues.push(`本轮角色${outcome}`);
          } else {
            await report(
              'SM-03-01 收尾｜回收本轮角色',
              true,
              `${roleSubject.roleName}：${outcome}。`,
            );
          }
        } catch (roleError) {
          issues.push(
            `角色回收未完成（${roleSubject.roleName}）：${
              roleError instanceof Error ? roleError.message.split('，')[0] : String(roleError)
            }`,
          );
        }
      }
      // DS-PERM-90 统一裁决（口径同 DM-09-01/DM-07-01 已验证 scoped-cleanup 聚合）：
      // 兜底授权/开关/专用表/成员账号/角色任一回收未完成都不得伪造通过。主体失败：原
      // 错误保留（不改错误类型），未完成资产逐项附到原错误信息后原样上抛；主体成功但
      // 回收未完成：聚合上抛（信息逐项标识具体未完成资产）。非 Error 主体错误无法追加
      // message 时留证后仍原样抛出，测试同样不会伪造通过。
      const cleanupNote = [restoreFailure, ...issues]
        .filter((item): item is string => Boolean(item))
        .join('；');
      if (mainFailed) {
        if (cleanupNote) {
          if (mainError instanceof Error) {
            mainError.message = `${mainError.message}｜[SM-03-01] 收尾回收未完成：${cleanupNote}`;
          } else {
            console.warn(`[SM-03-01] 主体错误非 Error，收尾回收未完成留证：${cleanupNote}`);
          }
        }
        throw mainError;
      }
      if (cleanupNote) {
        throw new Error(
          `[SM-03-01] 主体通过，但收尾回收未完成（仅限本轮 UUID 资产，不触碰其它资产）：${cleanupNote}`,
        );
      }
    }
  });
});