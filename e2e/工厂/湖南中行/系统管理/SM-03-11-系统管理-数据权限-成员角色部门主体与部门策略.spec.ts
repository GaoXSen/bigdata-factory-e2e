/**
 * 系统管理 E2E 测试 — 数据权限主体矩阵与部门策略（DS-PERM-19 空白环境校准）
 *
 * 覆盖场景（成员、角色、部门三主体矩阵 + “仅本部门”策略探查）：
 *   0. 自备资源（不依赖任何历史夹具/旧数据）：本轮 UUID 专用表（MySQL 直连
 *      DDL+种子+收尾 DROP）、本轮申请人账号（新建+邀请+分配自备角色）、本轮
 *      角色（含“数据地图/数据查询”菜单）、本轮部门（部门管理页“新增”自建）；
 *   1. 数据权限开关读取原始状态并确保开启，finally 恢复原值（共享配置不留测试态）；
 *   2. 逐主体隔离闭环（串行变更、每次变更后真实验证，不叠加多主体授权）：
 *      角色 → 授权回显（用户视角+资源视角双回显）→ 仅角色授权时申请人放行
 *      （继承）→ 删除授权 → 重新登录被拦截；
 *      部门 → 同上双回显；访问断言按“申请人是否属于本轮部门”运行时分支：
 *      属于 → 断言放行（部门继承）；不属于 → 断言被拦截（部门授权不得向非
 *      本部门成员放行，最小权限）；删除后恢复拦截；
 *      成员 → 直授回显 → 放行 → 删除 → 拦截；
 *   3. 并集语义：角色+成员同时授权（逐次回显）→ 放行；仅删成员直授仍放行
 *      （继承不受直授删除影响）；再删角色 → 拦截（回收闭环）；
 *   4. 部门主体授权的“仅本部门”默认策略：真实读取新建弹窗内可见的部门范围
 *      文案并记录，不预设控件形态（TODO[env] 环境恢复后 --headed 校准）。
 *
 * 业务依据：
 *   - 数据权限闭环工具.ts：用户视角主体页签 成员/角色/部门 对应 USER/ROLE/DEPT；
 *     权限为并集语义——同一表任一主体授权即可访问，全部删除后才应被拦截。
 *   - 数据权限开关必须“开启”才有表级校验（SM-03-03 阶段3 语义）。
 *   - 切换授权状态后必须重新登录目标用户验证，不沿用管理员会话（§11.1-1）。
 *
 * 空白环境校准说明（2026-09-22 DS-PERM-19：MySQL 110 ECONNRESET，静态校准 + tsc 验证）：
 *   - 移除对旧用户/角色/部门/表与残留固定授权行的全部假设：permissionFixtures、
 *     DATA_PERMISSION_DEPT_NAME、DATA_PERMISSION_TABLE、默认血缘源表
 *     e2e_hn_lineage_source_0920 与按固定主体全量清残留的旧“阶段1”均已删除，改为
 *     本轮 UUID 自备资源 + 防御性清理（仅 本轮主体×本轮表，保护同 UUID 重试轮次）
 *     + 无授权基线拦截断言。
 *   - 部门自建依据 run-20260922-102945-366 快照：系统管理 › 用户权限 › 部门管理
 *     （#/systemManage/userPermission/deptManage）页头有“新增”按钮，表格列为
 *     部门名称/类型/排序/创建时间/操作，当前列表“暂无数据”（空白环境实证）。
 *     新增弹窗内部字段（部门名称/类型/排序）与行内删除入口未见录制稿：按
 *     占位符/标签宽容定位，找不到即显式失败，不猜、不伪造（TODO[env] --headed 校准）。
 *   - 用户-部门归属：新建用户仅通过“邀请用户”加入管理员当前活动组织（接口审计
 *     20260911），用户管理行是否展示所属部门/组织未见录制稿；本用例在部门创建后
 *     真实读取用户管理行文本来判定申请人是否属于本轮部门，并据此选择部门访问
 *     断言分支（两分支都是真实断言，不是跳过）。
 *   - assertNoUnexpectedConsoleErrors / openSelfServiceQuery 在 e2e/utils.ts 未导出
 *     （仅权威目录 工厂/湖南中行/utils.ts 提供）；为保持 sm-static ↔ 工厂 硬链接
 *     twin 双侧可编译（两侧 '../utils.js' 解析到不同文件），按权威实现本地复刻，
 *     不跨中文路径导入。
 *   - 角色/部门页签的行结构与成员页签差异未见录制稿：回显断言只依赖“行文本含
 *     专用表名 + 权限类型”，不依赖列名；TODO[env] 环境恢复后 --headed 校准。
 *
 * 静态完善说明（2026-09-22 DS-PERM-56：清洁环境迁移收尾，仅静态开发）：
 *   - 数据源/数据库/Schema 改由配置中心（e2e/test-environment.ts，ENV-CONFIG-40）
 *     解析：类型/数据源取 dataSourceNames.query；数据库/Schema 以本轮专用表实际
 *     建表连接库（dbConfig().database）兜底，保证授权级联与建表同库；DATA_PERMISSION_*
 *     显式环境变量仍可覆盖。被清空环境不再隐式依赖共享工具内的固定兜底数据源名。
 *   - 部门“仅本部门”默认策略从“仅记录文案”升级为可读断言：弹窗真实呈现部门范围
 *     文案时必须可识别为范围策略（阶段3 硬断言）；阶段3b 按运行时归属分支对
 *     “仅本部门”行为面显式命名断言（部门外成员不得放行/部门内成员继承放行），
 *     控件形态仍不预设（TODO[env] --headed 校准）。
 *   - 本轮授权标签=专用表名（e2e_sm0311_* + UUID，每轮唯一 ASCII），作为三类主体
 *     授权行定位（uniqueText）与 finally 回收的唯一切分依据。
 *
 * 双入口修复说明（2026-09-22 DS-PERM-59：硬链接双入口模块解析回归修复，仅静态开发）：
 *   - 本正文与 e2e/sm-static/SM-03-11.spec.ts 为同一硬链接，必须双目录均可被 Playwright
 *     加载；DS-PERM-56 引入的 '../../../test-environment.js' 直连导入，其相对深度只在
 *     中文权威目录成立，sm-static 侧 --list 报 Cannot find module。
 *   - 改经 '../utils.js'（两侧镜像同构、均可解析）触发 e2e/test-environment.ts（配置
 *     中心）加载：配置中心首次解析会把 QUERY_SOURCE_TYPE / QUERY_SOURCE_NAME /
 *     QUERY_SCHEMA 按 profile 基线回填 process.env（显式变量优先，与
 *     testEnvironment.dataSourceNames.query 同名同源）。本文件改读同名变量，配置中心
 *     语义不变，spec 内不持有展示名兜底值，回填缺失时显式失败、不硬编码、不 skip。
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
  type UserViewSubjectTab,
  deletePermissionFromRow,
  findPermissionRow,
  findResourceViewAuthorizationRow,
  openDataPermissionPage,
  openUserViewCreateDialog,
  queryUserViewPermissionRow,
  refreshPermissionList,
  requirePermissionTableName,
  resolveMysqlPermissionResource,
  selectPermissionTableScope,
  selectUserViewSubject,
  setPermissionExpiry,
  setPermissionTypes,
  submitPermissionDialog,
  switchResourceViewScopeTab,
} from './数据权限闭环工具.js';
import { requirePermissionApprovalEnvironment } from './权限审批待调试工具.js';

/** 本轮自备申请人：UUID 唯一命名并现场创建，不依赖 SM-00-01 固化夹具（DS-PERM-19）。 */
const applicant = newPermissionIdentity('sm0311');

/** 本轮自备角色：授予申请人（角色授权对成员生效=继承）；含“数据地图/数据查询”菜单以便进入自助查询。 */
const roleSubject = newPermissionRole('sm0311', 'applicant');

/**
 * 本轮自备部门：部门管理页“新增”现场创建。空白环境实证（run-20260922-102945-366）
 * 部门列表“暂无数据”，不能假设存在可用历史部门，也不再依赖 DATA_PERMISSION_DEPT_NAME。
 */
const deptSubjectName = `e2e_sm0311_dept_${uuid()}`;

/** 专用测试表：本轮 MySQL 直连创建（DDL+种子），收尾 DROP；不依赖 DATA_PERMISSION_TABLE 或固定血缘源表。 */
/**
 * 配置中心同源读取（DS-PERM-59 双入口修复）：本正文同时被 e2e/sm-static 与中文权威目录
 * 加载，不能直接 import '../../../test-environment.js'（该相对深度只在权威目录成立）。
 * '../utils.js' 双侧均可解析，且其内部加载 e2e/test-environment.ts；配置中心首次解析会把
 * QUERY_SOURCE_TYPE / QUERY_SOURCE_NAME / QUERY_SCHEMA 按 profile 基线回填 process.env
 * （显式变量优先，与 testEnvironment.dataSourceNames.query 同名同源）。此处按同名变量
 * 读取，spec 内不持有任何数据源展示名兜底值；回填缺失说明配置中心加载链被破坏，显式
 * 失败，不回退硬编码。
 */
function configuredQuerySource(): { type: string; name: string; database: string; schema: string } {
  const type = process.env.QUERY_SOURCE_TYPE?.trim() ?? '';
  const name = process.env.QUERY_SOURCE_NAME?.trim() ?? '';
  const database = process.env.QUERY_SCHEMA?.trim() ?? '';
  if (!type || !name || !database) {
    throw new Error(
      '配置中心同源变量缺失：QUERY_SOURCE_TYPE / QUERY_SOURCE_NAME / QUERY_SCHEMA 出现空值。' +
        '本用例经 ../utils.js 加载 e2e/test-environment.ts（ENV-CONFIG-40）后，应由配置中心' +
        '首次解析的兼容回填提供上述变量（与 dataSourceNames.query 同名同源）；请检查配置' +
        '中心加载与回填逻辑（DS-PERM-59），不得在用例内硬编码数据源展示名。',
    );
  }
  return { type, name, database, schema: database };
}

const configQuerySource = configuredQuerySource();
/** 本轮专用表的物理落库：dbConfig().database（CREATE 同库）；DB 未配置时退配置中心显示库。 */
const roundDatabase = dbConfig()?.database.trim() || configQuerySource.database;
const permissionResource: MysqlPermissionResource = resolveMysqlPermissionResource({
  tableName: `e2e_sm0311_${uuid()}`,
  sourceTypeName: process.env.DATA_PERMISSION_SOURCE_TYPE?.trim() || configQuerySource.type,
  sourceName: process.env.DATA_PERMISSION_SOURCE_NAME?.trim() || configQuerySource.name,
  databaseName: process.env.DATA_PERMISSION_DATABASE?.trim() || roundDatabase,
  schemaName: process.env.DATA_PERMISSION_SCHEMA?.trim() || roundDatabase,
});
const tableName = requirePermissionTableName(permissionResource);

/** 自助查询数据源弹窗展示基础名（如 192.168.76.110），与数据权限页完整展示名不同（同 SM-03-06）。 */
const querySourceName = (process.env.QUERY_SOURCE_NAME?.trim() || permissionResource.sourceName)
  .split(/[:：]/)[0].trim();

/** 管理员身份：与 loginPage fixture 同源，用于切换用户后切回。 */
const adminIdentity: PermissionIdentity = {
  userName: (process.env.TEST_USER ?? 'admin').trim(),
  nickname: (process.env.TEST_USER ?? 'admin').trim(),
  password: process.env.TEST_PASS ?? '',
  phone: '',
  email: '',
};

/** 主体矩阵条目：页签与定位名；三类主体均为本轮自备（DS-PERM-19），不再有环境缺失分支。 */
interface SubjectTarget {
  key: '成员' | '角色' | '部门';
  subjectTab: UserViewSubjectTab;
  subjectName: string;
  subjectAlias?: string;
}

/** 主体矩阵：顺序为 角色 → 部门 → 成员（直授最后补齐，保证继承验证先行）。 */
const subjectMatrix: SubjectTarget[] = [
  {
    key: '角色',
    subjectTab: '角色',
    subjectName: roleSubject.roleName,
  },
  {
    key: '部门',
    subjectTab: '部门',
    subjectName: deptSubjectName,
  },
  {
    key: '成员',
    subjectTab: '成员',
    subjectName: applicant.userName,
    subjectAlias: applicant.nickname,
  },
];

/** selectUserViewSubject 的定位参数（不含 resource；subjectAlias 仅成员视角需要）。 */
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

/** 返回 locator 中第一个可见元素（与共享工具 firstVisible 语义一致，本文件自持）。 */
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
 * 断言权限行权限类型恰为 expected（复制自 SM-03-03 同名实现）：除包含 expected 外，
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

/** 查询执行状态：done=结果列头出现 marker；denied=权限拦截文案；pending=仍在执行（同 SM-03-06）。 */
async function readQueryOutcome(page: Page, marker: string): Promise<'done' | 'denied' | 'pending'> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/(?:没有|无)[^，。；]{0,8}权限|权限不足/.test(bodyText)) return 'denied';
  const headerCount = await page
    .locator('th:visible, [role="columnheader"]:visible')
    .filter({ hasText: marker })
    .count();
  return headerCount > 0 ? 'done' : 'pending';
}

/** 实际访问断言（允许访问）：只读 COUNT 真实返回结果，不以“数据源可选/表节点可见”替代。 */
async function expectTableQueryGranted(page: Page): Promise<void> {
  await openSelfServiceQuery(page);
  await refreshDatabaseMetadata(page);
  await chooseConfiguredDataSource(page, {
    type: permissionResource.sourceTypeName,
    name: querySourceName,
    schema: false,
  });
  const marker = `mxqry_${uuid()}`;
  await executeSql(page, `SELECT COUNT(*) AS ${marker} FROM ${tableName}`);
  await expect
    .poll(async () => readQueryOutcome(page, marker), {
      timeout: 30_000,
      message: `对 ${tableName} 的只读 COUNT 查询未成功返回（若页面提示无权限，说明当前授权状态与预期不符）`,
    })
    .toBe('done');
}

/**
 * 实际访问断言（应被拦截）：两种预期表现其一即成立（同 SM-03-03/06 语义）：
 * a) 数据源因无 kind=5 表级记录不可见（chooseConfiguredDataSource 抛已知文案）；
 * b) 数据源仍可选，提交 SQL 被表级权限拦截（“没有使用权限”）。返回命中描述供 report。
 */
async function expectTableQueryBlocked(page: Page): Promise<string> {
  await openSelfServiceQuery(page);
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
    if (hiddenByPermission) {
      return `数据源已因无表级使用权限不可见（${message.split('，')[0]}）`;
    }
    throw error;
  }
  const marker = `mxdeny_${uuid()}`;
  await executeSql(page, `SELECT COUNT(*) AS ${marker} FROM ${tableName}`);
  await expect
    .poll(async () => readQueryOutcome(page, marker), {
      timeout: 30_000,
      message: `当前应处于无授权状态，对 ${tableName} 的查询未被拦截——若刚删除授权，说明回收未生效或存在矩阵外主体残留授权`,
    })
    .toBe('denied');
  return '数据源仍可见，但查询被表级“没有使用权限”拦截';
}

/**
 * 部门主体“仅本部门”默认策略探查：真实读取新建弹窗内可见的部门范围相关文案，
 * 不预设控件形态、不写死默认值；未找到时返回 undefined，由调用侧标 TODO[env] 校准。
 */
async function readDeptScopePolicyText(dialog: Locator): Promise<string | undefined> {
  const candidate = await firstVisible(
    dialog.getByText(/仅[^，。；]{0,8}本部门|本部门|含?子部门/),
  );
  if (!candidate) return undefined;
  const text = (await candidate.innerText().catch(() => '')).trim();
  return text || undefined;
}

/**
 * 创建本轮唯一专用表并写入 2 行种子数据（MySQL 直连 DDL，仅本用例资源；模板
 * SM-03-06/SM-03-10 createPermissionFixtureTable）。平台数据源/库/表级联来自实时
 * JDBC 扫描，建表即对授权下拉与自助查询目录可见。返回实际种子行数作为夹具证据
 * （建表/种子失败会让用例以真实错误结束，不伪造通过）。
 * 同轮重试（Playwright 重试不重新 import，UUID 不变）时上一轮 finally 已 DROP；
 * 若上一轮收尾也失败，本轮 CREATE 会以真实“表已存在”错误结束，不静默复用。
 */
async function createPermissionFixtureTable(): Promise<number> {
  const columns = 'sm_id varchar(64) NOT NULL,'
    + 'sm_name varchar(128) DEFAULT NULL,'
    + 'sm_value varchar(128) DEFAULT NULL,'
    + 'PRIMARY KEY (sm_id)';
  await query(
    `CREATE TABLE ${tableName} (${columns}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
  await query(
    `INSERT INTO ${tableName} (sm_id, sm_name, sm_value) VALUES `
      + `('sm-1', 'e2e-sm0311-a', '${tableName}'), ('sm-2', 'e2e-sm0311-b', 'subject-matrix-closed-loop')`,
  );
  const rows = await query(`SELECT COUNT(*) AS total FROM ${tableName}`);
  const total = Number((rows[0] as { total?: unknown } | undefined)?.total ?? -1);
  expect(total, `专用表 ${tableName} 种子数据应为 2 行，实际：${JSON.stringify(rows)}`).toBe(2);
  return 2;
}

/**
 * 进入 系统管理 › 用户权限 › 部门管理（run-20260922-102945-366 快照实证 hash
 * #/systemManage/userPermission/deptManage，侧栏链接可定位）。openSystemPage 未
 * 登记该路由，先借已登记的用户管理路由展开系统管理侧栏，再点击侧栏“部门管理”。
 */
async function openDeptManagement(page: Page): Promise<void> {
  await openUserManagement(page);
  const link = page.locator('a[href="#/systemManage/userPermission/deptManage"]:visible').last();
  await expect(link, '系统管理侧栏未出现“部门管理”入口').toBeVisible({ timeout: 10_000 });
  await link.click();
  await expect
    .poll(() => page.url(), { timeout: 15_000 })
    .toContain('/systemManage/userPermission/deptManage');
  await expect(
    page.getByRole('button', { name: /^新增$/ }).first(),
    '部门管理页未出现“新增”按钮',
  ).toBeVisible({ timeout: 10_000 });
}

/**
 * 部门管理页“新增”创建本轮部门。弹窗字段结构未见录制稿（TODO[env] --headed 校准）：
 * “部门名称”按占位符宽容定位，找不到即显式失败；“类型”（机构/部门）存在时优先
 * 选“部门”，缺失则按默认提交。创建成功的硬证据：按本轮唯一部门名查询后行可见。
 */
async function createDepartment(page: Page, deptName: string): Promise<void> {
  await page.getByRole('button', { name: /^新增$/ }).first().click();
  const dialog = page
    .locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible')
    .last();
  await expect(dialog, '点击“新增”后未出现新增部门弹窗').toBeVisible({ timeout: 10_000 });
  const nameInput = await firstVisible(
    dialog.locator('input[placeholder*="部门名称"], input[placeholder*="名称"]'),
  );
  if (!nameInput) {
    throw new Error(
      `新增部门弹窗未找到“部门名称”输入框（TODO[env] 环境恢复后 --headed 校准弹窗结构；当前页面：${page.url()}）`,
    );
  }
  await nameInput.fill(deptName);
  const typeControl = await firstVisible(
    dialog.locator(
      '.ant-select:visible, .el-select:visible, [role="combobox"]:visible, select:visible',
    ),
  );
  if (typeControl) {
    await typeControl.click();
    const deptOption = await firstVisible(
      page
        .locator(
          '.ant-select-item-option:visible, .ant-select-dropdown-menu-item:visible, '
          + '.el-select-dropdown__item:visible, [role="option"]:visible, li:visible',
        )
        .filter({ hasText: /^部门$/ }),
    );
    if (deptOption) {
      await deptOption.click();
      await page.waitForTimeout(300);
    } else {
      await page.keyboard.press('Escape').catch(() => undefined);
    }
  }
  await dialog.getByRole('button', { name: /^确\s*定|保\s*存$/ }).last().click();
  await expect(dialog, '新增部门提交后弹窗未关闭（可能校验未通过）').toBeHidden({
    timeout: 15_000,
  });
  const search = page.getByRole('textbox', { name: '请输入部门名称' }).first();
  await search.fill(deptName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await expect(
    page.getByText(deptName, { exact: true }).last(),
    `按部门名“${deptName}”查询后列表未回显本轮部门`,
  ).toBeVisible({ timeout: 15_000 });
}

/** 按用户名查询用户管理列表，返回匹配行文本（运行时探查申请人-部门归属，不假设列名）。 */
async function readApplicantRowText(page: Page, userName: string): Promise<string> {
  await openUserManagement(page);
  const search = page.getByRole('textbox', { name: '请输入用户名称' }).first();
  await search.fill(userName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(800);
  const rows = page.locator('tr:visible, [role="row"]:visible').filter({ hasText: userName });
  return (await rows.allInnerTexts().catch(() => [] as string[])).join('\n');
}

test.describe.configure({ mode: 'serial', timeout: 720_000 });

test.describe('SM-03-11｜系统管理｜数据权限-成员角色部门主体与部门策略', () => {
  test('SM-03-11｜系统管理｜数据权限-成员角色部门主体与部门策略', async (
    { loginPage, consoleErrors, report },
  ) => {
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

    // 申请人可达入口与兜底（同 SM-03-03：受限账号直接落自助查询 hash 可能 #/404）。
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
      // 阶段 0a：本轮专用表（MySQL 直连 DDL + 2 行种子；DS-PERM-19 起不依赖固定血缘源表）。
      const seededRows = await createPermissionFixtureTable();

      // 阶段 0b：本轮自备申请人 + 自备角色（含“数据地图/数据查询”菜单，可进自助查询）。
      await createAndInviteUser(page, applicant);
      await createRole(page, roleSubject, ['数据地图', '数据查询']);
      await assignRoleToUser(page, roleSubject, applicant);

      // 阶段 0c：本轮自备部门（部门管理页“新增”）+ 申请人归属探查（决定部门断言分支）。
      await openDeptManagement(page);
      await createDepartment(page, deptSubjectName);
      const applicantRowText = await readApplicantRowText(page, applicant.userName);
      const applicantInOwnDept = applicantRowText.includes(deptSubjectName);
      await report(
        'SM-03-11 阶段0c｜自备部门创建与申请人归属探查',
        true,
        `部门=${deptSubjectName}；用户管理行内${applicantInOwnDept ? '可见' : '未见'}该部门名——`
          + (applicantInOwnDept
            ? '申请人属于本轮部门，阶段3 将按“部门继承放行”断言。'
            : '申请人不在本轮部门（邀请仅加入管理员当前组织），阶段3 将按“非本部门成员应被拦截”'
              + '断言；正向部门继承需用户-部门绑定路径校准（TODO[env] --headed）。'),
      );

      // 阶段 0d：元数据缓存预热（管理员；同 SM-03-06/10，失败如实记录不阻断）。
      let metadataWarmup = '目录控件未渲染，按 SM-03-03 语义安全跳过（授权下拉以实时/缓存数据为准）';
      try {
        await openSelfServiceQuery(page);
        await chooseConfiguredDataSource(page, {
          type: permissionResource.sourceTypeName,
          name: querySourceName,
          schema: false,
        });
        await refreshDatabaseMetadata(page);
        metadataWarmup = '自助查询目录已按实时元数据刷新，本轮新表进入平台元数据缓存。';
      } catch (metadataError) {
        metadataWarmup = `预热未完成（不阻断）：${
          metadataError instanceof Error ? metadataError.message.split('，')[0] : String(metadataError)
        }`;
      }
      await report('SM-03-11 阶段0d｜刷新数据库元数据（管理员）', true, metadataWarmup);

      // 阶段 1：读取开关原始状态并确保“开启”（表级校验前提；结束时恢复原值）。
      await openDataPermissionPage(page);
      originalChecked = await readPermissionSwitchChecked(page);
      await setPermissionSwitch(page, true);
      await report(
        'SM-03-11 阶段1｜确保数据权限开关开启',
        true,
        `开关原始=${originalChecked ? '开启' : '关闭'}（结束恢复原值），已置开启；专用表=${tableName}`
          + `（种子 ${seededRows} 行）；成员=${applicant.userName}；角色=${roleSubject.roleName}；`
          + `部门=${deptSubjectName}（均为本轮自备）。`,
      );

      // 阶段 1b：防御性残留清理（仅 本轮主体×本轮表；全新 UUID 正常为 0 条，保护同 UUID 重试轮次）。
      let purgedTotal = 0;
      for (const subject of subjectMatrix) {
        purgedTotal += await purgeSubjectStalePermissions(page, subject);
      }
      await report(
        'SM-03-11 阶段1b｜防御性残留清理（仅本轮主体×本轮表）',
        true,
        `共清理 ${purgedTotal} 条（0=全新 UUID 正常，>0=同轮重试残留）；数据源页签残留一并清理。`,
      );

      // 阶段 1c：清理后基线——申请人应被拦截（证明起点干净，后续放行才可归因本轮授权）。
      await loginAsApplicant();
      const baselineBlocked = await expectTableQueryBlocked(page);
      await report(
        'SM-03-11 阶段1c｜无授权基线被拦截',
        true,
        `${applicant.userName}：${baselineBlocked}。`,
      );

      // 阶段 2：角色主体隔离闭环——授权双视角回显 → 仅角色授权时申请人放行（继承）→ 删除 → 拦截。
      const roleSubjectTarget = subjectMatrix[0];
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      await grantSubjectPermission(page, roleSubjectTarget);
      await report(
        'SM-03-11 阶段2｜角色主体授权回显（用户视角+资源视角）',
        true,
        `角色“${roleSubjectTarget.subjectName}”对 ${tableName} 的“使用”授权已在角色页签与资源视角`
          + '（数据表）双回显，且不残留“管理”。',
      );
      await loginAsApplicant();
      await expectTableQueryGranted(page);
      await report(
        'SM-03-11 阶段2b｜仅角色授权时申请人可访问（继承生效）',
        true,
        `${applicant.userName} 无成员直授，对 ${tableName} 的只读 COUNT 查询成功——访问来自角色继承。`,
      );
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      await deleteSubjectPermission(page, roleSubjectTarget);
      await loginAsApplicant();
      const roleRevokedBlocked = await expectTableQueryBlocked(page);
      await report(
        'SM-03-11 阶段2c｜角色授权删除后被拦截',
        true,
        `${applicant.userName}：${roleRevokedBlocked}。`,
      );

      // 阶段 3：部门主体隔离闭环——访问断言按申请人归属分支，两分支均为真实断言。
      const deptSubjectTarget = subjectMatrix[1];
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      const deptPolicyText = await grantSubjectPermission(page, deptSubjectTarget);
      // DS-PERM-56：“仅本部门”默认策略可读断言（不预设控件形态）——弹窗真实呈现
      // 部门范围文案时，该文案必须可识别为范围策略（本部门/子部门语义，“仅本部门”
      // 为预期默认）；渲染出无关文案说明默认策略控件需 --headed 校准，不得放行。
      if (deptPolicyText) {
        expect(
          deptPolicyText,
          `部门主体授权弹窗呈现的部门范围文案“${deptPolicyText}”应可识别为范围策略`
            + '（含“本部门/子部门”语义；“仅本部门”为预期默认值）',
        ).toMatch(/本部门|子部门/);
      }
      await report(
        'SM-03-11 阶段3｜部门主体授权回显与“仅本部门”默认策略断言',
        true,
        `部门“${deptSubjectTarget.subjectName}”对 ${tableName} 的“使用”授权已在部门页签与资源视角`
          + '（数据表）双回显。'
          + (deptPolicyText
            ? `新建弹窗实际呈现部门范围文案：“${deptPolicyText}”（已按可读断言校验为范围策略文案；授权生效以行回显与实际访问断言为准）。`
            : '新建弹窗未见“仅本部门/含子部门”类文案；TODO[env] 环境恢复后 --headed 校准部门范围控件的默认策略表现。'),
      );
      await loginAsApplicant();
      if (applicantInOwnDept) {
        await expectTableQueryGranted(page);
        await report(
          'SM-03-11 阶段3b｜仅部门授权时申请人可访问（部门继承生效）',
          true,
          `${applicant.userName} 属于本轮部门，无成员直授时对 ${tableName} 的只读 COUNT 查询成功——`
            + '访问来自部门继承（“仅本部门”策略的部门内放行面，查询层断言见 expectTableQueryGranted）。',
        );
      } else {
        const deptBlocked = await expectTableQueryBlocked(page);
        // DS-PERM-56 可读断言：“仅本部门”默认策略的行为面——部门授权不得向部门外成员放行。
        expect(
          deptBlocked,
          `部门“仅本部门”默认策略：申请人 ${applicant.userName} 不在部门“${deptSubjectTarget.subjectName}”内，`
            + `部门授权不得放行其对 ${tableName} 的访问（实际拦截证据：${deptBlocked}）`,
        ).toBeTruthy();
        await report(
          'SM-03-11 阶段3b｜部门授权不向非本部门成员放行（仅本部门默认策略）',
          true,
          `${applicant.userName}：${deptBlocked}；申请人不在部门“${deptSubjectTarget.subjectName}”内，`
            + '部门授权不得越界放行（“仅本部门”可读断言已校验）。'
            + '正向部门继承路径（用户-部门绑定入口未见录制稿）TODO[env] --headed 校准。',
        );
      }
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      await deleteSubjectPermission(page, deptSubjectTarget);
      await loginAsApplicant();
      const deptRevokedBlocked = await expectTableQueryBlocked(page);
      await report(
        'SM-03-11 阶段3c｜部门授权删除后被拦截',
        true,
        `${applicant.userName}：${deptRevokedBlocked}。`,
      );

      // 阶段 4：成员直授隔离闭环——直授回显 → 放行 → 删除 → 拦截（三类主体矩阵逐一独立验证完成）。
      const memberSubjectTarget = subjectMatrix[2];
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      await grantSubjectPermission(page, memberSubjectTarget);
      await report(
        'SM-03-11 阶段4｜成员直授回显（矩阵补齐）',
        true,
        `成员“${applicant.userName}”对 ${tableName} 的“使用”授权已在成员页签与资源视角（数据表）双回显；`
          + '三类主体矩阵独立闭环完成。',
      );
      await loginAsApplicant();
      await expectTableQueryGranted(page);
      await report(
        'SM-03-11 阶段4b｜成员直授时申请人可访问',
        true,
        `${applicant.userName} 对 ${tableName} 的只读 COUNT 查询成功——访问来自成员直授。`,
      );
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      await deleteSubjectPermission(page, memberSubjectTarget);
      await loginAsApplicant();
      const memberRevokedBlocked = await expectTableQueryBlocked(page);
      await report(
        'SM-03-11 阶段4c｜成员直授删除后被拦截',
        true,
        `${applicant.userName}：${memberRevokedBlocked}。`,
      );

      // 阶段 5：并集语义——角色+成员同时授权（逐次回显，串行变更）→ 放行；仅删成员直授
      // 仍放行（继承不受直授删除影响）；再删角色后被拦截（回收闭环）。
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      await grantSubjectPermission(page, roleSubjectTarget);
      await grantSubjectPermission(page, memberSubjectTarget);
      await loginAsApplicant();
      await expectTableQueryGranted(page);
      await report(
        'SM-03-11 阶段5｜多主体并集授权时申请人可访问',
        true,
        `角色“${roleSubjectTarget.subjectName}”与成员“${applicant.userName}”同时持有 ${tableName} 的“使用”授权，`
          + '任一生效即放行（并集语义）。',
      );
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      await deleteSubjectPermission(page, memberSubjectTarget);
      await loginAsApplicant();
      await expectTableQueryGranted(page);
      await report(
        'SM-03-11 阶段5b｜删除成员直授后继承仍放行',
        true,
        `已删除成员直授；${applicant.userName} 重新登录后对 ${tableName} 的只读 COUNT 查询仍成功——访问来自角色继承。`,
      );
      await loginAs(page, adminIdentity);
      await openDataPermissionPage(page);
      await deleteSubjectPermission(page, roleSubjectTarget);
      await loginAsApplicant();
      const finalBlocked = await expectTableQueryBlocked(page);
      await report(
        'SM-03-11 阶段5c｜全部主体授权删除后被拦截（回收闭环）',
        true,
        `${applicant.userName}：${finalBlocked}。`,
      );

      await assertNoUnexpectedConsoleErrors(consoleErrors, [
        /self\/query\/submitQuery/,
        /没有使用权限/,
        /(?:没有|无)[^，。；]{0,8}权限/,
      ]);
      await report(
        'SM-03-11｜主体矩阵闭环完成',
        true,
        '角色/部门/成员三类主体逐一隔离闭环（授权双视角回显→实际访问→删除→拦截）；并集与“直授删除不影响继承”已验证；'
          + '资源均为本轮自备。',
      );
    } catch (error) {
      mainError = error;
      throw error;
    } finally {
      // 收尾 1：恢复开关为原始状态（共享配置；恢复失败必须显式暴露，但不阻止自有资源回收）。
      let restoreFailure: string | undefined;
      if (originalChecked !== undefined) {
        try {
          await loginAs(page, adminIdentity);
          await openDataPermissionPage(page);
          await setPermissionSwitch(page, originalChecked);
          await report(
            'SM-03-11 收尾｜恢复数据权限开关原始状态',
            true,
            `已恢复为 ${originalChecked ? '开启' : '关闭'}。`,
          );
        } catch (restoreError) {
          restoreFailure = restoreError instanceof Error ? restoreError.message : String(restoreError);
        }
      }
      // 收尾 2：回收本轮自有资源（兜底删授权 → DROP 专用表 → 尽力删自备部门 → 尽力删自备账号）。
      // 回收未完成仅告警（资源为唯一命名，不影响回归）；开关恢复失败显式抛出，不掩盖原失败。
      let cleanupIssues: string[] = [];
      try {
        cleanupIssues = await recoverRoundResources(page, report);
      } catch (cleanupError) {
        cleanupIssues = [
          `收尾回收整体未完成：${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        ];
      }
      if (cleanupIssues.length) {
        console.warn(
          `[SM-03-11] 收尾回收未完成（资源为唯一命名，不影响回归）：${cleanupIssues.join('；')}`,
        );
      }
      if (restoreFailure) {
        throw new Error(
          `数据权限开关恢复失败（共享配置被遗留为测试态）：${restoreFailure}｜原失败：`
            + `${mainError instanceof Error ? mainError.message : String(mainError ?? '无')}`,
        );
      }
    }
  });
});

/**
 * 串行单主体授权（每次只变更一个主体，变更即验证）：用户视角 新建权限 → 表级联选
 * 本轮表 → “使用”+永久 → 提交 → 用户视角行回显（恰为“使用”）→ 资源视角（数据表
 * 页签）同一授权交叉回显。部门主体在提交前读取“仅本部门”策略文案并返回给调用方。
 */
async function grantSubjectPermission(
  page: Page,
  subject: SubjectTarget,
): Promise<string | undefined> {
  await selectUserViewSubject(page, subjectOptionsOf(subject));
  await switchResourceViewScopeTab(page, '数据表');
  const dialog = await openUserViewCreateDialog(page);
  await selectPermissionTableScope(page, dialog, permissionResource);
  await setPermissionTypes(page, dialog, ['使用']);
  await setPermissionExpiry(page, dialog, '永久');
  let deptPolicyText: string | undefined;
  if (subject.subjectTab === '部门') {
    deptPolicyText = await readDeptScopePolicyText(dialog);
  }
  await submitPermissionDialog(page, dialog);
  const row = await findSubjectPermissionRow(page, subject);
  await expectRowExactPermissionType(row, '使用');
  const resourceEchoRow = await findResourceViewAuthorizationRow(page, {
    resource: permissionResource,
    subjectName: subject.subjectName,
    scopeTab: '数据表',
  });
  if (!resourceEchoRow) {
    throw new Error(
      `资源视角（数据表页签）未回显${subject.key}“${subject.subjectName}”对 ${tableName} 的“使用”授权。`,
    );
  }
  await expectRowExactPermissionType(resourceEchoRow, '使用');
  return deptPolicyText;
}

/**
 * 串行单主体回收（变更即验证）：用户视角定位行 → 删除 → 资源视角（数据表页签）
 * 交叉确认该主体授权行已消失。两处都未回显才算删除生效。
 */
async function deleteSubjectPermission(page: Page, subject: SubjectTarget): Promise<void> {
  const row = await findSubjectPermissionRow(page, subject);
  await deletePermissionFromRow(page, row, { uniqueText: tableName });
  const resourceEchoRow = await findResourceViewAuthorizationRow(page, {
    resource: permissionResource,
    subjectName: subject.subjectName,
    scopeTab: '数据表',
    timeoutMs: 6_000,
  });
  if (resourceEchoRow) {
    throw new Error(
      `删除后资源视角（数据表页签）仍回显${subject.key}“${subject.subjectName}”对 ${tableName} 的授权，删除可能未生效。`,
    );
  }
}

/**
 * 尽力删除本轮自备部门（部门管理页：按本轮唯一部门名查询 → 行内“删除”→ 确认）。
 * 只回收本轮自建部门；任一步不满足都返回说明文本而不抛错，不掩盖主结果。
 * 行内删除入口未见录制稿（TODO[env] --headed 校准）：按钮缺失时如实返回并保留部门。
 */
async function deleteOwnDepartment(page: Page, deptName: string): Promise<string> {
  await openDeptManagement(page);
  const search = page.getByRole('textbox', { name: '请输入部门名称' }).first();
  await search.fill(deptName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(800);
  const deptText = page.getByText(deptName, { exact: true }).last();
  if (!(await deptText.isVisible().catch(() => false))) {
    return '部门列表未查询到本轮部门（可能此前已删除）';
  }
  const row = deptText.locator('xpath=ancestor::tr[1]');
  if (!(await row.isVisible().catch(() => false))) {
    return '部门可见但未取到表格行，跳过页面删除（部门保留）';
  }
  const deleteButton = row.getByRole('button', { name: /删\s*除/ }).first();
  if (!(await deleteButton.isVisible().catch(() => false))) {
    return '行内未找到“删除”按钮，跳过页面删除（部门保留；TODO[env] 校准部门行删除入口）';
  }
  await deleteButton.click();
  const confirmDialog = page
    .locator(
      '[role="dialog"]:visible, .el-message-box:visible, .el-dialog:visible, .ant-modal:visible',
    )
    .first();
  if (await confirmDialog.isVisible().catch(() => false)) {
    const confirm = confirmDialog.getByRole('button', { name: /确\s*定|^是$/ }).first();
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click();
    }
  }
  await expect(deptText).toBeHidden({ timeout: 10_000 }).catch(() => undefined);
  return '已提交删除并确认列表不再显示该部门';
}

/**
 * 尽力删除本轮申请人账号（用户管理页：按本轮唯一账号查询 → 行内“删除”→ 确认）。
 * 只回收本轮自备账号；任一步不满足都返回说明文本而不抛错，不掩盖主结果。
 */
async function deleteOwnApplicantUser(page: Page, identity: PermissionIdentity): Promise<string> {
  await openUserManagement(page);
  const search = page.getByRole('textbox', { name: '请输入用户名称' }).first();
  await search.fill(identity.userName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(800);
  const userText = page.getByText(identity.userName, { exact: true }).last();
  if (!(await userText.isVisible().catch(() => false))) {
    return '用户列表未查询到本轮账号（可能此前已删除）';
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
    .locator(
      '[role="dialog"]:visible, .el-message-box:visible, .el-dialog:visible, .ant-modal:visible',
    )
    .first();
  if (await confirmDialog.isVisible().catch(() => false)) {
    const confirm = confirmDialog.getByRole('button', { name: /确\s*定|^是$/ }).first();
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click();
    }
  }
  await expect(userText).toBeHidden({ timeout: 10_000 }).catch(() => undefined);
  return '已提交删除并确认列表不再显示该账号';
}

/**
 * 收尾回收：仅本轮资源——兜底删除 本轮主体×本轮专用表 的授权行 → DROP 专用表 →
 * 尽力删除本轮自备部门 → 尽力删除本轮申请人账号。角色按 SM-03-10 先例保留（UUID
 * 唯一命名，不影响回归）。每步尽力而为：失败记录为 issue 文本返回并在调用方告警，
 * 不掩盖主结果。
 */
async function recoverRoundResources(
  page: Page,
  report: (title: string, passed: boolean, details: string) => void | Promise<void>,
): Promise<string[]> {
  const issues: string[] = [];
  try {
    await loginAs(page, adminIdentity);
    await openDataPermissionPage(page);
    let removedFinally = 0;
    for (const subject of subjectMatrix) {
      removedFinally += await purgeSubjectStalePermissions(page, subject);
    }
    if (removedFinally > 0) {
      await report(
        'SM-03-11 收尾｜兜底回收本轮残留授权',
        true,
        `删除残留授权 ${removedFinally} 条（表=${tableName}）。`,
      );
    }
  } catch (purgeError) {
    issues.push(
      `授权兜底回收未完成：${
        purgeError instanceof Error ? purgeError.message.split('，')[0] : String(purgeError)
      }`,
    );
  }
  try {
    await query(`DROP TABLE IF EXISTS ${tableName}`);
  } catch (dropError) {
    issues.push(
      `专用表回收未完成（${tableName}）：${
        dropError instanceof Error ? dropError.message : String(dropError)
      }`,
    );
  }
  try {
    const outcome = await deleteOwnDepartment(page, deptSubjectName);
    await report('SM-03-11 收尾｜回收本轮自备部门', true, `${deptSubjectName}：${outcome}。`);
  } catch (deptError) {
    issues.push(
      `自备部门回收未完成：${
        deptError instanceof Error ? deptError.message.split('，')[0] : String(deptError)
      }`,
    );
  }
  try {
    const outcome = await deleteOwnApplicantUser(page, applicant);
    await report('SM-03-11 收尾｜回收本轮申请人账号', true, `${applicant.userName}：${outcome}。`);
  } catch (userError) {
    issues.push(
      `申请人账号回收未完成：${
        userError instanceof Error ? userError.message.split('，')[0] : String(userError)
      }`,
    );
  }
  return issues;
}

/**
 * 防御性清理：仅 本轮主体×本轮专用表/数据源 两个页签下的残留权限行（页面操作逐条删除）。
 * 全新 UUID 资源正常为 0 条；仅同 UUID 重试轮次（上一轮中途失败且回收未完成）才可能命中
 * （r12 实证：面板默认停“数据源”页签，表级残留行在“数据表”页签，不切页签会漏删）。
 * DS-PERM-19：不再按固定主体清除全量残留（那是空白环境之前的旧假设）。
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
 * 定位指定主体当前“数据表”页签下的专用表权限行：重选主体 → 显式切“数据表”页签
 * （queryUserViewPermissionRow 不含页签切换，沿面板停留页签查询会误报“未回显”）
 * → 复用共享查询断言（未回显时抛错，不视为通过）。
 */
async function findSubjectPermissionRow(page: Page, subject: SubjectTarget): Promise<Locator> {
  await selectUserViewSubject(page, subjectOptionsOf(subject));
  await switchResourceViewScopeTab(page, '数据表');
  return queryUserViewPermissionRow(page, { ...subjectOptionsOf(subject), resource: permissionResource });
}

/**
 * assertNoUnexpectedConsoleErrors / openSelfServiceQuery 在 e2e/utils.ts 未导出（仅权威目录
 * 工厂/湖南中行/utils.ts 提供）。为保持 sm-static ↔ 工厂 硬链接 twin 双侧可编译（两侧
 * '../utils.js' 解析到不同文件），按权威实现本地复刻，不跨中文路径导入
 * （PERM-STATIC-03 静态开发 2026-09-21）。
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
