/**
 * 系统管理 E2E 测试 — 资源视角和数据源 Tab 权限管理（DS-PERM-26 静态校准）
 *
 * 覆盖场景（原 SM-03-02 口径 + DS-PERM-26 清洁环境升级，全部使用本轮自备资源）：
 *   0. 自备资源：本轮 UUID 唯一 MySQL 数据源（数据接入→数据源管理 页面真实创建：类型
 *      搜索 MYSQL→下一步→驱动/JDBC/账号→测试连接→保存，DS-01-06/07 已验证流程；收尾页面
 *      真实删除）、本轮成员账号（新建+邀请）、本轮角色（含「数据地图/数据查询」菜单，仅作
 *      授权主体；DS-PERM-78 起收尾尽力删除，唯一命名保证删除只命中本轮对象）；
 *   1. 数据权限开关读取原始状态并确保开启，finally 恢复原值（共享配置不留测试态）；同时保留
 *      原 SM-03-02 的全部入口/结构断言：双视角入口并存、未选资源前「新建权限」禁用、策略条
 *      回显已选数据源、查询条（全部类型/搜索授权对象）、数据源页签列头（主体类型/主体/权限
 *      类型/权限截止时间）、新建弹窗结构（授权对象类型/逐行授权复选框/仅「管理」/确定添加）、
 *      数据表页签未级联到表前禁用+过滤当前表列表+字段范围列、数据服务 API 页签可切换；
 *   2. 成员主体闭环：新建「管理」（永久）→ 资源视角+用户视角（数据源页签）双回显恰为「管理」
 *      → 主体类型+关键字 负向/正向查询 → 编辑为自定义近未来截止（权限类型显式保持「管理」，
 *      整体覆盖语义）→ 双视角回显新截止日期 → 删除 → 双视角确认行消失；
 *   3. 角色主体闭环：新建「管理」（自定义近未来截止，与成员的“永久”互补覆盖两种截止方式）→
 *      双视角回显 → 编辑为「永久」→ 双视角回显 → 删除 → 双视角行消失；
 *   4. 控制台校验：允许 dataPermission/ 接口的过程性 4xx 记录（配置类用例，同 SM-03-01/03-10），
 *      其余未声明错误必须为空。
 *
 * 业务依据（同族已实证口径）：
 *   - 权限模型（用例库 Excel 行44）：数据源仅「管理」；数据表“使用”“管理”（表级由 SM-03-01
 *     用户视角/SM-03-08 资源视角承载，本用例边界为数据源维度）。
 *   - SM-03-08（资源视角数据源 CRUD）已实跑验证：批量授权弹窗（授权对象类型→勾选主体→管理→
 *     截止→确定添加）、关键字查询语义、用户视角回查一致、删除后双视角消失；本用例把同一闭环
 *     迁到“本轮自建数据源”，并补齐角色主体与永久↔自定义截止互改（SM-03-08 只覆盖成员+永久→
 *     自定义单向）。
 *   - 用户视角面板默认停在“数据源”页签，且列表存在同名重复行与分页，回显用跨页检索、删除按
 *     “行不再回显”判定（r12/r13 即 SM-03-06/11 实证）。
 *   - 数据源创建/删除页面流程按 DS-01-06/07 已验证步骤复刻（卡片图标删除 + DELETE 二次确认）。
 *
 * 范围边界：资源视角数据表页签的字段范围/级联授权由 SM-03-10 承载（本用例仅保留“未选表前
 * 禁用+过滤输入+字段范围列”结构断言）；实际访问（自助查询放行/拦截）由 SM-03-06/11 承载；
 * 数据源管理页自身 CRUD 细节由 DS-01-06/07 承载。
 *
 * 静态校准说明（2026-09-22 DS-PERM-26：MySQL 110 握手不可用，静态校准 + tsc 验证）：
 *   - 旧版仅做配置入口/结构存在性校验，且对共享固定数据源不提交授权（防不可回收）；本次升级
 *     为“本轮自建数据源”上的双主体增查改删闭环，原结构断言全部保留（弹窗断言在成员新建弹窗
 *     内执行后真实提交）。
 *   - 资源视角新建弹窗对“角色”主体的待选列表结构未见录制稿：checkAuthorizationSubject 按角色
 *     名检索+勾选，提交后以授权行回显兜底验证（不猜测成功）；TODO[env] 环境恢复后 --headed
 *     校准。
 *   - clickVisible/fillPlaceholder/expectSuccess/卡片删除/DELETE 确认 在 e2e/抽样用例工具.ts
 *     （sm-static 侧 '../抽样用例工具.js' 可解析，权威孪生侧解析到 工厂/湖南中行/ 下的另一份
 *     实现）；为保持 sm-static ↔ 工厂 硬链接 twin 双侧可编译一致，按权威实现本地复刻，不跨
 *     中文路径导入（同 SM-03-01/03-11 先例）。assertNoUnexpectedConsoleErrors 同理本地复刻
 *     （e2e/utils.ts 未导出）。
 *
 * 静态校准说明（2026-09-23 DS-PERM-78：清洁环境迁移收紧，仅静态修改 + tsc/--list 验证）：
 *   - 阶段 4 首次进入资源视角升级为“等待本轮数据源在权限模块可见”：页面真实新建的数据源
 *     可能晚于权限模块的数据源列表索引，未命中时重开数据权限页并重试（最多 5 轮）；重试
 *     耗尽仍未可见则显式失败——对不可见资源配置权限违背清洁环境口径，不能继续。结构性
 *     失败（页签/控件缺失等）不重试，原样抛出。
 *   - “同一授权标签”显式化：本轮授权标签 =（本轮主体 × 本轮数据源）唯一对。资源视角按
 *     本轮主体名在本轮数据源的授权列表内精确定位（findResourceViewAuthorizationRow），
 *     用户视角按本轮数据源名跨页精确定位（findPermissionRowAcrossPages）；双视角行的权限
 *     类型（恰为「管理」）与截止时间逐字段相等断言即同一授权记录的交叉回显，全程不读、
 *     不依赖任何历史授权记录。
 *   - finally 回收顺序固定为：兜底删本轮授权 → 恢复数据权限开关原值 → 页面删除本轮数据源
 *     → 删本轮成员账号 → 删本轮角色（DS-PERM-78 起角色不再“用后保留”；deleteOwnRole 按
 *     SM-00-01 已实证实现本地复刻，删除入口缺失时返回说明文本并计入 issues，不抛错）。
 *     开关恢复失败仍显式抛出，但推迟到数据源/账号/角色回收全部执行完之后，避免收尾中途
 *     抛错把本轮物理资产遗留成孤儿。
 *
 * 静态校准说明（2026-09-23 DS-PERM-90：scoped cleanup 失败上抛补齐，仅静态修改 + tsc/--list 验证）：
 *   - finally 任一 scoped cleanup（兜底授权回收／开关恢复／本轮数据源删除／成员账号／角色）
 *     未完成时不再仅 console.warn 放行：主体成功则聚合上抛（错误信息逐项列出未完成资产），
 *     主体失败则保留原错误（不改错误类型）并把未完成资产逐项附到原错误信息后原样上抛；
 *     各清理步骤互相不中断（错误聚合而非 fail-fast），剩余资产仍会继续回收。
 *   - deleteOwnMemberUser/deleteOwnRole 返回文本改用 DM-09-01（DS-PERM-86）已验证约定：
 *     以“回收未完成：”前缀标记未完成步骤（调用方计入 issues，收尾末尾统一裁决上抛）、
 *     以“无需回收：”标记此前已删除（不算未完成，避免把“已清干净”误报为失败），并增加
 *     删除提交后列表仍回显的复验；本轮数据源创建未确认时按本轮 UUID 源名留证供人工复核
 *     （不做删除尝试、不扩大清理范围）。删除只按本轮 UUID 唯一命名定位，范围不变。
 */
import type { Locator, Page } from '@playwright/test';
import {
  clickMenu,
  expect,
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
  dismissPermissionDropdown,
  findPermissionRowAcrossPages,
  findResourceViewAuthorizationRow,
  openDataPermissionPage,
  openPermissionEditDialog,
  openResourceViewTarget,
  queryUserViewPermissionRowAcrossPages,
  refreshPermissionList,
  selectUserViewSubject,
  setPermissionExpiry,
  setPermissionTypes,
  submitPermissionDialog,
  submitPermissionEditDialog,
  switchPermissionView,
  switchResourceViewScopeTab,
} from './数据权限闭环工具.js';
import { requirePermissionApprovalEnvironment } from './权限审批待调试工具.js';

/** 本轮自备数据源：页面真实创建的 UUID 唯一 MySQL 数据源（ASCII 前缀 e2e_sm0302_），收尾页面真实删除。 */
const marker = uuid();
const sourceName = `e2e_sm0302_${marker}`;
const sourceDescription = `sm0302_desc_${marker}`;
const dbHost = process.env.DB_HOST?.trim() || '192.168.76.110';
const dbPort = process.env.DB_PORT?.trim() || '13306';
const dbName = process.env.DB_NAME?.trim() || 'e2e_test';
const mysqlDriver = process.env.MYSQL_DRIVER?.trim() || 'com.mysql.cj.jdbc.Driver';
const jdbcUrl = `jdbc:mysql://${dbHost}:${dbPort}/${dbName}?useSSL=false&characterEncoding=UTF-8`;

/** 资源视角“数据源”页签的操作对象：仅数据源维度（无 tableName），库/Schema 记录用 JDBC 同名库。 */
const permissionResource: MysqlPermissionResource = {
  sourceTypeName: 'MYSQL',
  sourceName,
  databaseName: dbName,
  schemaName: dbName,
};

/** 本轮自备成员主体：UUID 唯一命名并现场创建（新建+邀请进入管理员当前组织），收尾尽力回收。 */
const memberIdentity = newPermissionIdentity('sm0302');

/** 本轮自备角色主体：仅作为授权主体（不分配用户、不登录）；DS-PERM-78 起收尾尽力删除。 */
const roleSubject = newPermissionRole('sm0302', 'subject');

/** 管理员身份：与 loginPage fixture 同源，用于收尾切回。 */
const adminIdentity: PermissionIdentity = {
  userName: (process.env.TEST_USER ?? 'admin').trim(),
  nickname: (process.env.TEST_USER ?? 'admin').trim(),
  password: process.env.TEST_PASS ?? '',
  phone: '',
  email: '',
};

/** 主体条目：成员/角色两类（部门主体由 SM-03-11 承载）。 */
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

/** selectUserViewSubject 的定位参数（subjectAlias 仅成员页签需要）。 */
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

/** 自定义近未来截止：+7 天 23:59:59（必在闭环工具日历允许的当前/下一自然月内）。 */
const memberEditedExpiryTime = futureExpiryTime(7);
const roleCreatedExpiryTime = futureExpiryTime(7);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 返回 locator 中第一个可见元素（自上而下）。 */
async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

/** 返回 locator 中最后一个可见元素（DOM 序最深；子串匹配时用于选中叶节点）。 */
async function lastVisible(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

/**
 * 数据源管理页等处的通用点击（本地复刻权威 抽样用例工具 实现：twin 双侧该工具导入路径不同，
 * 见文件头说明）。按 button→link→menuitem→可见按钮文本→纯文本 顺序取第一个可见候选。
 */
async function clickVisible(
  scope: Page | Locator,
  name: string | RegExp,
  { timeoutMs = 0 }: { timeoutMs?: number } = {},
): Promise<void> {
  const page = 'url' in scope ? scope : scope.page();
  const candidates = [
    scope.getByRole('button', { name }),
    scope.getByRole('link', { name }),
    scope.getByRole('menuitem', { name }),
    scope.locator('button:visible, [role="button"]:visible').filter({ hasText: name }),
    scope.getByText(name, { exact: typeof name === 'string' }),
  ];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const candidate of candidates) {
      const item = await firstVisible(candidate);
      if (item) {
        await item.click();
        return;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`未找到可点击的“${String(name)}”，当前页面：${page.url()}`);
    }
    await page.waitForTimeout(250);
  }
}

/** 成功通知断言（本地复刻权威实现，Ant/Element 双 UI 兼容）。 */
async function expectSuccessNotice(page: Page, pattern: RegExp): Promise<void> {
  const notice = page.locator(
    '.ant-message-notice-content:visible, .ant-notification-notice:visible, .el-message:visible, [role="alert"]:visible',
  ).filter({ hasText: pattern }).last();
  await expect(notice).toBeVisible({ timeout: 15_000 });
}

/** 等待并返回最后一个可见弹窗。 */
async function visibleDialog(page: Page): Promise<Locator> {
  const dialog = page.getByRole('dialog').last();
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  return dialog;
}

/** 按占位符填入输入框（取最后一个可见实例，避开隐藏模板行）。 */
async function fillPlaceholder(page: Page, placeholder: string, value: string): Promise<void> {
  const field = page.getByPlaceholder(placeholder, { exact: true }).last();
  await expect(field).toBeVisible({ timeout: 10_000 });
  await field.fill(value);
}

/** 数据源管理卡片图标操作选择器（本地复刻权威实现：删除数据源用纯图标按钮，无文本可依）。 */
const CARD_ICON_ACTIONS = {
  编辑: '[aria-label="图标: edit"], [aria-label*="edit" i], [aria-label*="编辑"], .anticon-edit, [class*="icon-edit"]',
  删除: '[aria-label="图标: delete"], [aria-label*="delete" i], [aria-label*="删除"], .anticon-delete, [class*="icon-delete"]',
} as const;

/**
 * 定位包含唯一目标图标的最小卡片容器：从数据源名称文本上溯，仅接受“该祖先范围内恰好一个
 * 目标图标”的最小容器，防止上溯到整个列表后误点其他卡片的图标。
 */
async function findActionCard(
  page: Page,
  text: string,
  action: keyof typeof CARD_ICON_ACTIONS,
): Promise<Locator> {
  const target = page.getByText(text, { exact: true }).filter({ visible: true }).last();
  await expect(target).toBeVisible({ timeout: 15_000 });

  let scope = target;
  for (let level = 0; level < 8; level += 1) {
    const actions = scope.locator(CARD_ICON_ACTIONS[action]);
    if ((await actions.count()) === 1 && (await actions.first().isVisible().catch(() => false))) {
      return scope;
    }
    scope = scope.locator('..');
  }
  throw new Error(`未找到包含唯一“${action}”图标的“${text}”卡片，当前页面：${page.url()}`);
}

/** 点击数据源卡片上的图标操作（编辑/删除）。 */
async function clickCardAction(
  page: Page,
  text: string,
  action: keyof typeof CARD_ICON_ACTIONS,
): Promise<void> {
  const card = await findActionCard(page, text, action);
  await card.locator(CARD_ICON_ACTIONS[action]).click();
}

/** 删除数据源的危险二次确认：输入 DELETE 后点击“确认”（DS-01-07 已验证流程）。 */
async function confirmDangerDialog(page: Page, keyword = 'DELETE'): Promise<void> {
  const dialog = await visibleDialog(page);
  const input = dialog.getByPlaceholder(/请输入/).last();
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(keyword);
  await clickVisible(dialog, /确\s*认|确\s*定/, { timeoutMs: 5_000 });
}
/** 数据权限页顶部“数据权限”开关：优先 ARIA switch，兼容旧版 Element 外层实现（复刻自 SM-03-01/03/11）。 */
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

/** 控制台错误门禁（本地复刻权威 utils 实现；配置类用例口径，同 SM-03-01/03-10）。 */
function assertNoUnexpectedConsoleErrors(consoleErrors: string[], allowedPatterns: RegExp[]): void {
  const unexpected = consoleErrors.filter(
    (message) => !allowedPatterns.some((pattern) => pattern.test(message)),
  );
  expect(unexpected, '出现未声明的控制台错误（允许清单之外）').toEqual([]);
}

/** 收集当前页面可见表格列头文本（用“｜”拼接），供列头存在性断言与报告取证。 */
async function visibleColumnHeaderTexts(page: Page): Promise<string> {
  const headers = page.locator('[role="columnheader"]');
  const count = await headers.count();
  const texts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const header = headers.nth(index);
    if (await header.isVisible().catch(() => false)) {
      texts.push((await header.innerText().catch(() => '')).trim());
    }
  }
  return texts.join('｜');
}

/**
 * 占位文本断言：Ant/Element 的 select 占位可能不是 input.placeholder（占位 span），双路径
 * 兼容；两路都未命中时给出可校准的明确失败。
 */
async function assertPlaceholderShown(page: Page, text: string, label: string): Promise<void> {
  const byAttr = await firstVisible(page.getByPlaceholder(text));
  if (byAttr) {
    await expect(byAttr).toBeVisible();
    return;
  }
  const bySpan = await firstVisible(page.getByText(text, { exact: true }));
  if (bySpan) {
    await expect(bySpan).toBeVisible();
    return;
  }
  throw new Error(`未找到${label}（占位文本「${text}」），当前页面：${page.url()}`);
}
/** 弹层选项通用选择器（Ant/Element 双兼容；本地复刻自 SM-03-08 已实证实现）。 */
const AUTHORIZATION_OPTION_SELECTOR = [
  '[role="option"]:visible',
  '.ant-select-item-option:visible',
  '.el-select-dropdown__item:visible',
  'option:visible',
].join(', ');

/** 打开资源视角“新建权限”批量授权弹窗（资源已选中时按钮才可用，页面已知规则）。 */
async function openResourceViewCreateDialog(page: Page): Promise<Locator> {
  const create = page.getByRole('button', { name: /新建权限|新增/ }).last();
  await expect
    .poll(async () => create.isEnabled().catch(() => false), {
      timeout: 10_000,
      message: '资源视角“新建权限”按钮不可用：请确认已先选中数据源。',
    })
    .toBe(true);
  await create.click();
  const dialog = page.locator('[role="dialog"], .ant-modal, .el-dialog').last();
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  return dialog;
}

/**
 * 选择弹窗内“授权对象类型”（默认用户）：弹窗内该控件实际是下拉框（默认“用户”，
 * SM-03-08 error-context 已核）——已显示目标类型时直接沿用默认，不点开下拉引入浮层遮挡；
 * 默认值不在候选时才退回按文本切换。
 */
async function chooseAuthorizationSubjectType(
  page: Page,
  dialog: Locator,
  candidates: string[],
): Promise<string> {
  for (const candidate of candidates) {
    const selected = await firstVisible(
      dialog
        .locator('[role="combobox"], .ant-select-selection-item, .el-select__selected-item')
        .filter({ hasText: candidate }),
    );
    if (selected) return candidate;
  }
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
 * 在批量授权弹窗待选列表中勾选目标主体：先用弹窗内搜索框过滤（列表可能分页且默认
 * 不含新成员），再按“账号或昵称”定位文本并上溯到行内复选框；勾选状态以 checked/
 * class 双读兜底确认。SM-03-08 已实证；角色主体无录制稿，按同结构兜底（回显兜底验证）。
 */
async function checkAuthorizationSubject(
  page: Page,
  dialog: Locator,
  subject: { userName: string; nickname?: string },
): Promise<void> {
  const keyword = subject.nickname ?? subject.userName;
  const search = dialog.getByPlaceholder(/搜索|请输入/).first();
  if (await search.isVisible().catch(() => false)) {
    await search.fill(keyword);
    await page.waitForTimeout(600);
  }
  const cell = await lastVisible(
    dialog
      .locator('tr, li, [class*="item"]')
      .filter({ hasText: subject.userName })
      .filter({ has: dialog.getByText(subject.userName, { exact: true }) }),
  );
  if (!cell) {
    throw new Error(
      `批量授权弹窗待选列表未找到主体“${subject.userName}”（过滤关键字：${keyword}）；`
        + '可能未进入组织/角色未创建成功，需按实际页面校准。',
    );
  }
  const checkbox = cell.getByRole('checkbox').first();
  await checkbox.click();
  const isChecked = await checkbox.isChecked().catch(() => false);
  if (!isChecked) {
    await expect(cell.locator('[class*="checked"], [class*="selected"]')
      .first(), `主体“${subject.userName}”勾选后应有选中态`).toBeVisible({ timeout: 5_000 });
  }
}

/**
 * 右侧授权列表按“主体类型 + 主体关键字”查询（SM-03-08 已实证结构完整移植）：
 * 每次先重置已选下拉（点 × 或选“全部”），避免上次过滤残留导致回显误判。
 */
async function filterResourceViewAuthorizations(
  page: Page,
  options: { subjectTypeCandidates?: string[]; keyword?: string },
): Promise<void> {
  const typeWidget = page
    .locator('.ant-select, .el-select, [role="combobox"]')
    .filter({ has: page.getByText('全部类型') })
    .first();
  if (options.subjectTypeCandidates?.length) {
    // 先清除已选（× / clear 图标），保证候选选择从“全部”开始。
    const clearIcon = typeWidget.locator('.ant-select-clear, .el-select__clear, [class*="clear"]');
    if (await clearIcon.first().isVisible().catch(() => false)) {
      await clearIcon.first().click();
      await page.waitForTimeout(300);
    }
    await typeWidget.first().click();
    await page.waitForTimeout(300);
    let matched = false;
    for (const candidate of options.subjectTypeCandidates) {
      const option = await firstVisible(
        page.locator(AUTHORIZATION_OPTION_SELECTOR).filter({ hasText: candidate }),
      );
      if (option) {
        await option.click();
        matched = true;
        break;
      }
    }
    if (!matched) {
      await dismissPermissionDropdown(page);
      throw new Error(
        `主体类型下拉未找到候选（${options.subjectTypeCandidates.join('、')}），需按实际页面校准文案。`,
      );
    }
    await page.waitForTimeout(500);
  }
  if (options.keyword !== undefined) {
    const keywordInput = page.getByPlaceholder('搜索授权对象').first();
    await expect(keywordInput).toBeVisible({ timeout: 10_000 });
    await keywordInput.fill(options.keyword);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
  }
}

/** 生成“当前或次月”范围内的自定义到期时间（闭环工具日历只允许这两档月份）。 */
function futureExpiryTime(daysAhead: number): string {
  const target = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())} 23:59:59`;
}

/** 行级精确断言：权限类型应恰为期望值（数据源维度仅“管理”；双选/缺失都会失败并回显行文本）。 */
async function expectRowExactPermissionType(
  row: Locator,
  expected: DataPermissionTypeFlag,
): Promise<void> {
  const text = await row.innerText();
  const normalized = /使用/.test(text) ? '使用' : /管理/.test(text) ? '管理' : '无';
  expect(
    normalized,
    `授权行权限类型应为“${expected}”，实际归一结果“${normalized}”，行文本：${text.replace(/\s+/g, ' ').slice(0, 160)}`,
  ).toBe(expected);
}
/**
 * 页面真实创建本轮 MySQL 数据源（DS-01-06/07 已验证流程）：数据接入→数据源管理 →
 * 添加数据源 → 类型弹窗搜索 MYSQL → 下一步 → 驱动/JDBC/账号/密码 → 测试连接成功 →
 * 保存 → 卡片列表回显本轮源名。需要真实数据库账号（DB_USER/DB_PASS），缺失按前置不足 skip。
 */
async function createOwnDataSource(page: Page, dbUser: string, dbPass: string): Promise<void> {
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
  await expectSuccessNotice(page, /连接成功|测试成功|成功/);
  await clickVisible(page, /确\s*定/);
  await expect(page.getByText(sourceName, { exact: true }).last()).toBeVisible({ timeout: 15_000 });
}

/**
 * 页面真实删除本轮数据源（DS-01-07 已验证流程）：卡片“删除”图标 → 输入 DELETE 的
 * 危险二次确认 → 列表不再回显。返回结果说明（供收尾报告/issue 记录，不抛错）。
 */
async function deleteOwnDataSource(page: Page): Promise<string> {
  await clickMenu(page, '数据接入', '数据源管理');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = await page
      .getByText(sourceName, { exact: true })
      .first()
      .isVisible()
      .catch(() => false);
    if (!remaining) break;
    await clickCardAction(page, sourceName, '删除').catch(() => undefined);
    await confirmDangerDialog(page).catch(() => undefined);
    await page.waitForTimeout(1_500);
  }
  const leftover = await page
    .getByText(sourceName, { exact: true })
    .first()
    .isVisible()
    .catch(() => false);
  return leftover
    ? `数据源 ${sourceName} 仍残留在数据源管理列表（需人工确认）`
    : `数据源 ${sourceName} 已删除`;
}
/**
 * 删除本轮成员账号（用户管理页：按本轮唯一账号查询 → 行内“删除”→ 确认；复刻自
 * SM-03-01/03-10 已实证实现）。只回收本轮自备账号，不抛错、不掩盖主结果。返回文本约定
 * （DS-PERM-90，同 DM-09-01/DS-PERM-86 已验证口径）：以“回收未完成：”前缀标记未完成
 * 步骤（调用方计入 issues，收尾末尾统一裁决上抛）；以“无需回收：”标记此前已删除
 * （不算未完成）。
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

/** 资源视角（数据源页签）定位本轮主体的授权行；未回显时明确失败，不视为通过。 */
async function requireResourceViewRow(
  page: Page,
  subject: SubjectTarget,
  timeoutMs = 15_000,
): Promise<Locator> {
  const row = await findResourceViewAuthorizationRow(page, {
    resource: permissionResource,
    subjectName: subject.subjectName,
    scopeTab: '数据源',
    timeoutMs,
  });
  if (!row) {
    throw new Error(
      `资源视角（数据源页签）未回显${subject.key}“${subject.subjectName}”对 ${sourceName} 的授权行；`
        + '新增/编辑可能未生效，不能视为通过。',
    );
  }
  return row;
}

/** 资源视角（数据源页签）不再回显该主体对本轮数据源的授权行；仍回显即明确失败。 */
async function expectResourceViewRowAbsent(
  page: Page,
  subject: SubjectTarget,
  timeoutMs = 5_000,
): Promise<void> {
  const row = await findResourceViewAuthorizationRow(page, {
    resource: permissionResource,
    subjectName: subject.subjectName,
    scopeTab: '数据源',
    timeoutMs,
  });
  if (row) {
    throw new Error(
      `资源视角（数据源页签）仍回显${subject.key}“${subject.subjectName}”对 ${sourceName} 的授权行，删除可能未生效。`,
    );
  }
}

/**
 * 删除后的交叉确认：用户视角（主体页签 → 右侧“数据源”页签）不再回显本轮数据源授权行；
 * 仍回显即资源视角删除未同步到同一授权记录，明确失败。
 */
async function expectUserViewRowGone(page: Page, subject: SubjectTarget): Promise<void> {
  await selectUserViewSubject(page, subjectOptionsOf(subject));
  await switchResourceViewScopeTab(page, '数据源');
  await refreshPermissionList(page);
  if (await findPermissionRowAcrossPages(page, sourceName, 5_000)) {
    throw new Error(
      `删除后用户视角（${subject.key}·数据源页签）仍回显 ${sourceName} 授权行：资源视角与用户视角应指向同一授权记录。`,
    );
  }
}

/**
 * 打开资源视角并选中本轮数据源（DS-PERM-78：先等待本轮数据源在权限模块可见）。
 * 页面真实新建的数据源可能晚于权限模块的数据源列表索引：未命中时重开数据权限页
 * 并重试（最多 5 轮）；重试耗尽仍未可见则显式失败——对不可见资源配置权限违背
 * 清洁环境口径，不能继续。结构性失败（页签/控件缺失等，错误不含“未找到/未出现
 * 包含”）不重试，原样抛出。
 */
async function openRoundSourceWithMetadataWait(page: Page): Promise<void> {
  const attempts = 5;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await openResourceViewTarget(page, permissionResource, '数据源');
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/未找到|未出现包含/.test(message)) throw error;
      if (attempt < attempts) {
        await openDataPermissionPage(page);
        await page.waitForTimeout(3_000);
      }
    }
  }
  throw new Error(
    `本轮数据源 ${sourceName} 在资源视角等待 ${attempts} 轮后仍未可见`
      + '（权限模块数据源列表未索引本轮新建数据源）：'
      + `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * 资源视角新建数据源授权（每次只变更一个主体，变更即验证）：打开批量授权弹窗 →
 * 授权对象类型（成员=用户，角色=角色）→ 勾选主体 → 数据源仅“管理” → 截止时间 →
 * 确定添加。withEntryAssertions 时保留原 SM-03-02 的弹窗结构断言（授权对象类型/
 * 逐行授权复选框/仅管理/确定添加）后真实提交。
 */
async function grantDatasourcePermission(
  page: Page,
  subject: SubjectTarget,
  options: { expiry: PermissionExpiryMode; withEntryAssertions?: boolean; observations?: string[] },
): Promise<void> {
  const dialog = await openResourceViewCreateDialog(page);
  if (options.withEntryAssertions) {
    await expect(
      dialog.getByText(/授权对象类型/),
      '资源视角新建弹窗应有「授权对象类型」单选',
    ).toBeVisible();
    const userOption = await firstVisible(dialog.getByText('用户', { exact: true }));
    options.observations?.push(
      `新建弹窗授权对象类型=${userOption ? '含「用户」选项' : '未见「用户」选项（待校准）'}`,
    );
    await expect(
      dialog.getByRole('checkbox').first(),
      '资源视角新建弹窗待选列表应提供逐行授权复选框',
    ).toBeVisible();
    await expect(
      dialog.getByText('管理', { exact: true }),
      '数据源权限弹窗应提供「管理」权限类型（数据源仅「管理」）',
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: /确定添加/ }),
      '资源视角新建弹窗应以「确定添加」提交',
    ).toBeVisible();
  }
  await chooseAuthorizationSubjectType(page, dialog, subject.key === '成员' ? ['用户', '成员'] : ['角色']);
  await checkAuthorizationSubject(
    page,
    dialog,
    subject.key === '成员'
      ? { userName: subject.subjectName, nickname: subject.subjectAlias }
      : { userName: subject.subjectName },
  );
  await setPermissionTypes(page, dialog, ['管理']);
  await setPermissionExpiry(page, dialog, options.expiry);
  await submitPermissionDialog(page, dialog);
}
test.describe.configure({ mode: 'serial', timeout: 720_000 });

test.describe('SM-03-02｜系统管理｜资源视角和数据源 Tab 权限管理', () => {
  test('SM-03-02｜系统管理｜资源视角和数据源 Tab 权限管理', async ({ loginPage, consoleErrors, report }) => {
    // DS-PERM-26（2026-09-22 静态校准）：环境不可用期间按 RUN_PERMISSION_APPROVAL=1 闸门执行；
    // 自建数据源另需真实数据库账号，缺失按前置不足 skip（不伪造通过）。
    requirePermissionApprovalEnvironment();
    const dbUser = process.env.DB_USER?.trim();
    const dbPass = process.env.DB_PASS?.trim();
    if (!dbUser || !dbPass) {
      const missing = [
        !dbUser && 'DB_USER（e2e_test 数据库用户）',
        !dbPass && 'DB_PASS（e2e_test 数据库密码）',
      ].filter((item): item is string => Boolean(item));
      test.skip(
        true,
        `环境前置缺失：页面新建 MySQL 数据源需要真实连接账号（缺 ${missing.join('、')}）。补齐后本用例自动转入真实执行。`,
      );
      return;
    }

    const page = loginPage;
    const memberTarget = subjectTargets[0];
    const roleTarget = subjectTargets[1];
    const observations: string[] = [];
    const issues: string[] = [];
    let originalChecked: boolean | undefined;
    let ownSourceCreated = false;
    let started = false;
    let mainError: unknown;
    let mainFailed = false;
    let purged = 0;

    try {
      started = true;

      // ===== 阶段0a：本轮自备数据源（页面真实创建；不再引用共享固定源/历史源）=====
      await createOwnDataSource(page, dbUser, dbPass);
      ownSourceCreated = true;
      console.log(`SM-03-02 OWN-SOURCE-CREATED ${sourceName}`);

      // ===== 阶段0b：本轮自备主体（成员=新建+邀请；角色=含数据地图/数据查询菜单，DS-PERM-78 起收尾尽力删除）=====
      await createAndInviteUser(page, memberIdentity);
      await createRole(page, roleSubject, ['数据地图', '数据查询']);
      console.log(`SM-03-02 SUBJECTS-CREATED member=${memberIdentity.userName} role=${roleSubject.roleName}`);

      // ===== 阶段1：入口断言（原断言1：双视角入口并存）+ 开关原始读取并强制开启 =====
      await openDataPermissionPage(page);
      await expect(page.getByText('用户视角', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('资源视角', { exact: true }).first()).toBeVisible();
      originalChecked = await readPermissionSwitchChecked(page);
      await setPermissionSwitch(page, true);
      if (originalChecked === false) {
        await report(
          'SM-03-02 阶段1｜数据权限开关临时开启',
          true,
          '原始状态=关闭，已在用例内强制开启，收尾恢复原值。',
        );
      }

      // ===== 阶段2：资源视角·数据源页签（原断言2：未选资源前「新建权限」禁用）=====
      await switchPermissionView(page, '资源视角');
      await switchResourceViewScopeTab(page, '数据源');
      const createButton = page.getByRole('button', { name: /新建权限|新增/ }).last();
      await expect(createButton).toBeVisible();
      expect(
        await createButton.isDisabled().catch(() => false),
        '资源视角未选中资源前「新建权限」应禁用（若当前版本始终可点，请按实际页面校准）',
      ).toBe(true);

      // ===== 阶段3：查询条结构（原断言4：全部类型 + 搜索授权对象）=====
      await assertPlaceholderShown(page, '全部类型', '主体类型筛选下拉');
      await assertPlaceholderShown(page, '搜索授权对象', '主体关键字搜索框');

      // ===== 阶段4：等待本轮数据源元数据可见并选中（DS-PERM-78：重开重试，重试耗尽显式失败）
      // 断言策略条回显 + 列头（原断言3/5）=====
      await openRoundSourceWithMetadataWait(page);
      await expect(
        page.getByText(new RegExp(`数据源[：:]\\s*${escapeRegExp(sourceName)}`)).first(),
        `选中资源后应回显“数据源：${sourceName}”`,
      ).toBeVisible();
      const sourceColumns = await visibleColumnHeaderTexts(page);
      for (const column of ['主体类型', '主体', '权限类型', '权限截止时间']) {
        expect(
          sourceColumns,
          `资源视角「数据源」页签列表应包含列「${column}」，实际列头：${sourceColumns}`,
        ).toContain(column);
      }
      observations.push(`数据源页签列头=${sourceColumns}`);

      // ===== 阶段5：防御性清理（仅 本轮主体×本轮数据源；防同 UUID 重跑残留）=====
      for (const subject of subjectTargets) {
        for (let guard = 0; guard < 3; guard += 1) {
          const stale = await findResourceViewAuthorizationRow(page, {
            resource: permissionResource,
            subjectName: subject.subjectName,
            scopeTab: '数据源',
            timeoutMs: 4_000,
          });
          if (!stale) break;
          await deletePermissionFromRow(page, stale, { uniqueText: subject.subjectName });
          purged += 1;
        }
      }

      // ===== 阶段6（查·负向）：无关 UUID 关键字不应命中任何本轮主体授权行 =====
      const noiseKeyword = `nohit_${uuid()}`;
      await filterResourceViewAuthorizations(page, { keyword: noiseKeyword });
      for (const subject of subjectTargets) {
        await expectResourceViewRowAbsent(page, subject, 4_000);
      }

      // ===== 阶段7（成员·增，含原断言6 弹窗结构）：新建 管理+永久 → 双视角回显恰为「管理」=====
      await grantDatasourcePermission(page, memberTarget, {
        expiry: '永久',
        withEntryAssertions: true,
        observations,
      });
      const memberRow = await requireResourceViewRow(page, memberTarget);
      await expect(memberRow).toContainText(memberIdentity.userName);
      await expectRowExactPermissionType(memberRow, '管理');
      await expect(memberRow).toContainText(/永久|2099/);
      const memberUserViewRow = await queryUserViewPermissionRowAcrossPages(page, {
        ...subjectOptionsOf(memberTarget),
        resource: permissionResource,
      });
      await expectRowExactPermissionType(memberUserViewRow, '管理');

      // ===== 阶段8（成员·查·正向）：主体类型=用户 + 关键字=主体名 应命中授权行 =====
      await filterResourceViewAuthorizations(page, {
        subjectTypeCandidates: ['用户', '成员'],
        keyword: memberIdentity.userName,
      });
      const memberFilteredRow = await requireResourceViewRow(page, memberTarget, 12_000);
      await expect(memberFilteredRow).toContainText(memberIdentity.userName);

      // ===== 阶段9（成员·改）：编辑为自定义近未来截止（权限类型显式保持“管理”，整体覆盖）=====
      const memberEditDialog = await openPermissionEditDialog(page, memberFilteredRow);
      await submitPermissionEditDialog(page, memberEditDialog, {
        permissionTypes: ['管理'],
        expiry: { customTime: memberEditedExpiryTime },
      });
      const memberEditedRow = await requireResourceViewRow(page, memberTarget);
      await expectRowExactPermissionType(memberEditedRow, '管理');
      await expect(memberEditedRow).toContainText(memberEditedExpiryTime.slice(0, 10));
      const memberEditedUserRow = await queryUserViewPermissionRowAcrossPages(page, {
        ...subjectOptionsOf(memberTarget),
        resource: permissionResource,
      });
      await expect(memberEditedUserRow).toContainText(memberEditedExpiryTime.slice(0, 10));

      // ===== 阶段10（成员·删）：删除 → 双视角行消失 =====
      await deletePermissionFromRow(page, memberEditedRow, { uniqueText: memberIdentity.userName });
      await expectResourceViewRowAbsent(page, memberTarget, 6_000);
      await expectUserViewRowGone(page, memberTarget);
      await report(
        'SM-03-02 阶段10｜成员授权删除后双视角行消失',
        true,
        `成员“${memberIdentity.userName}”对 ${sourceName} 的授权已删除，资源视角与用户视角均不再回显。`,
      );

      // ===== 阶段11（角色·增）：新建 管理+自定义近未来截止（与成员“永久”互补覆盖两种截止方式）=====
      await grantDatasourcePermission(page, roleTarget, { expiry: { customTime: roleCreatedExpiryTime } });
      const roleRow = await requireResourceViewRow(page, roleTarget);
      await expect(roleRow).toContainText(roleSubject.roleName);
      await expectRowExactPermissionType(roleRow, '管理');
      await expect(roleRow).toContainText(roleCreatedExpiryTime.slice(0, 10));
      const roleUserViewRow = await queryUserViewPermissionRowAcrossPages(page, {
        ...subjectOptionsOf(roleTarget),
        resource: permissionResource,
      });
      await expect(roleUserViewRow).toContainText(roleCreatedExpiryTime.slice(0, 10));

      // ===== 阶段12（角色·改）：编辑为「永久」→ 双视角回显 永久且恰为「管理」=====
      const roleEditDialog = await openPermissionEditDialog(page, roleRow);
      await submitPermissionEditDialog(page, roleEditDialog, {
        permissionTypes: ['管理'],
        expiry: '永久',
      });
      const roleEditedRow = await requireResourceViewRow(page, roleTarget);
      await expectRowExactPermissionType(roleEditedRow, '管理');
      await expect(roleEditedRow).toContainText(/永久|2099/);
      const roleEditedUserRow = await queryUserViewPermissionRowAcrossPages(page, {
        ...subjectOptionsOf(roleTarget),
        resource: permissionResource,
      });
      await expect(roleEditedUserRow).toContainText(/永久|2099/);

      // ===== 阶段13（角色·删）：删除 → 双视角行消失 =====
      await deletePermissionFromRow(page, roleEditedRow, { uniqueText: roleSubject.roleName });
      await expectResourceViewRowAbsent(page, roleTarget, 6_000);
      await expectUserViewRowGone(page, roleTarget);
      await report(
        'SM-03-02 阶段13｜角色授权删除后双视角行消失',
        true,
        `角色“${roleSubject.roleName}”对 ${sourceName} 的授权已删除，资源视角与用户视角均不再回显。`,
      );

      // ===== 阶段14：资源范围页签遍历（原断言7）：数据表页签未级联到具体表前「新建权限」仍禁用、
      // 必须含「字段范围」列且提供表名过滤；数据服务 API 页签可切换。=====
      await switchPermissionView(page, '资源视角');
      for (const scopeTab of ['数据表', '数据服务 API'] as const) {
        await switchResourceViewScopeTab(page, scopeTab);
        await expect(page.locator('body')).toContainText(scopeTab);
        if (scopeTab === '数据表') {
          const createOnTableTab = page.getByRole('button', { name: /新建权限|新增/ }).last();
          expect(
            await createOnTableTab.isDisabled().catch(() => false),
            '资源视角「数据表」页签未级联选中具体表前「新建权限」应禁用（级联必须落到一张表）',
          ).toBe(true);
          await assertPlaceholderShown(page, '过滤当前表列表', '数据表页签的表名过滤输入');
          const tableColumns = await visibleColumnHeaderTexts(page);
          expect(
            tableColumns,
            `资源视角「数据表」页签列表应包含列「字段范围」（业务规则：数据表还显示字段范围），实际列头：${tableColumns}`,
          ).toContain('字段范围');
          observations.push(`数据表页签列头=${tableColumns}`);
        }
      }

      // ===== 阶段15：控制台门禁 + 总结报告 =====
      await assertNoUnexpectedConsoleErrors(consoleErrors, [/dataPermission\//]);
      await report(
        'SM-03-02｜资源视角和数据源 Tab 权限管理闭环完成',
        true,
        `数据源=${sourceName}（本轮页面新建，收尾删除）；主体=成员 ${memberIdentity.userName}（收尾尽力回收）`
          + `/ 角色 ${roleSubject.roleName}（收尾尽力回收）；防重跑清理 ${purged} 条；已验证：双视角入口并存、未选资源前`
          + `「新建权限」禁用、MYSQL 筛选与资源选择后策略条回显、主体类型+关键字查询条、${observations.join('；')}、`
          + '新建弹窗结构（授权对象类型/逐行授权复选框/仅管理/确定添加，已真实提交）、成员与角色双主体闭环'
          + '（新增→双视角回显恰为“管理”→编辑 永久↔自定义近未来 互改→删除双视角消失）、数据表页签未选表前禁用'
          + '且含字段范围列、数据服务 API 页签可切换；控制台无未声明错误（允许 dataPermission/ 过程性 4xx）。',
      );
    } catch (error) {
      // DS-PERM-90：先记录主体错误，由 finally 在全部收尾执行完后统一裁决（原错误原样
      // 上抛并附带清理未完成信息），避免收尾中途抛错掩埋主体失败。
      mainError = error;
      mainFailed = true;
    } finally {
      // 收尾1：管理员登录 → 兜底清理本轮主体残留授权 → 恢复开关原始状态（共享配置，硬性）。
      // DS-PERM-78：开关恢复失败延迟记录，避免收尾中途抛错把本轮物理资产遗留成孤儿；
      // DS-PERM-90：延迟记录的开关恢复失败与其它回收未完成项在收尾末尾统一裁决上抛。
      let restoreFailure: string | undefined;
      if (started && ownSourceCreated) {
        try {
          await loginAs(page, adminIdentity);
          await openDataPermissionPage(page);
          let removedFinally = 0;
          for (const subject of subjectTargets) {
            try {
              for (let guard = 0; guard < 3; guard += 1) {
                const stale = await findResourceViewAuthorizationRow(page, {
                  resource: permissionResource,
                  subjectName: subject.subjectName,
                  scopeTab: '数据源',
                  timeoutMs: 4_000,
                });
                if (!stale) break;
                await deletePermissionFromRow(page, stale, { uniqueText: subject.subjectName });
                removedFinally += 1;
              }
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
              'SM-03-02 收尾｜兜底回收本轮授权',
              true,
              `删除残留授权 ${removedFinally} 条（数据源=${sourceName}）。`,
            );
          }
          if (originalChecked !== undefined) {
            await setPermissionSwitch(page, originalChecked);
            await report(
              'SM-03-02 收尾｜恢复数据权限开关原始状态',
              true,
              `已恢复为 ${originalChecked ? '开启' : '关闭'}。`,
            );
          }
        } catch (restoreError) {
          const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
          if (originalChecked !== undefined) {
            // 共享开关恢复失败必须显式暴露（DS-PERM-90：仅记录，由收尾末尾统一裁决——
            // 主体失败时附到原错误信息、主体成功时聚合上抛；此处不再内联原失败避免重复）。
            restoreFailure = `数据权限开关恢复失败（共享配置被遗留为测试态）：${restoreMessage}`;
          } else {
            issues.push(`收尾登录/清理未完成：${restoreMessage.split('，')[0]}`);
          }
        }
      }
      // 收尾2：回收本轮自建数据源（页面真实删除；残留/失败记录为 issue，收尾末尾统一裁决，
      // 不伪造通过）。
      if (started && ownSourceCreated) {
        try {
          await loginAs(page, adminIdentity);
          const outcome = await deleteOwnDataSource(page);
          if (outcome.includes('残留')) {
            issues.push(`数据源回收未完成：${outcome}`);
          } else {
            await report('SM-03-02 收尾｜回收本轮数据源', true, outcome);
          }
        } catch (sourceError) {
          issues.push(
            `数据源回收未完成（${sourceName}）：${
              sourceError instanceof Error ? sourceError.message.split('，')[0] : String(sourceError)
            }`,
          );
        }
      }
      // 收尾3：尽力删除本轮成员账号（DS-PERM-78 顺序：授权→开关→数据源→用户/角色）。
      if (started) {
        try {
          const outcome = await deleteOwnMemberUser(page);
          if (outcome.startsWith('回收未完成')) {
            issues.push(`成员账号${outcome}`);
          } else {
            await report(
              'SM-03-02 收尾｜回收本轮成员账号',
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
      // 收尾4：尽力删除本轮角色（DS-PERM-78：本轮用户/角色一律回收，不再“用后保留”；
      // deleteOwnRole 按 SM-00-01 已实证实现本地复刻，只命中本轮 UUID 唯一命名角色）。
      if (started) {
        try {
          const outcome = await deleteOwnRole(page);
          if (outcome.startsWith('回收未完成')) {
            issues.push(`本轮角色${outcome}`);
          } else {
            await report(
              'SM-03-02 收尾｜回收本轮角色',
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
      // DS-PERM-90：本轮数据源创建未确认（可能已部分建出）时不做删除尝试、不扩大清理
      // 范围，但按本轮 UUID 源名留证供人工复核，避免孤儿源无据可查。
      if (started && !ownSourceCreated) {
        issues.push(`本轮数据源创建未确认，收尾未做删除尝试（若已创建需人工复核）：${sourceName}`);
      }
      // DS-PERM-90 统一裁决（口径同 DM-09-01/DM-07-01 已验证 scoped-cleanup 聚合）：
      // 兜底授权/开关/本轮数据源/成员账号/角色任一回收未完成都不得伪造通过。主体失败：
      // 原错误保留（不改错误类型），未完成资产逐项附到原错误信息后原样上抛；主体成功但
      // 回收未完成：聚合上抛（信息逐项标识具体未完成资产）。非 Error 主体错误无法追加
      // message 时留证后仍原样抛出，测试同样不会伪造通过。
      const cleanupNote = [restoreFailure, ...issues]
        .filter((item): item is string => Boolean(item))
        .join('；');
      if (mainFailed) {
        if (cleanupNote) {
          if (mainError instanceof Error) {
            mainError.message = `${mainError.message}｜[SM-03-02] 收尾回收未完成：${cleanupNote}`;
          } else {
            console.warn(`[SM-03-02] 主体错误非 Error，收尾回收未完成留证：${cleanupNote}`);
          }
        }
        throw mainError;
      }
      if (cleanupNote) {
        throw new Error(
          `[SM-03-02] 主体通过，但收尾回收未完成（仅限本轮 UUID 资产，不触碰其它资产）：${cleanupNote}`,
        );
      }
    }
  });
});
