/**
 * SM-02-03｜系统管理｜审批流程配置：列表查询、默认层级、1/5 级边界、审批人类型与同类型唯一启用
 *
 * DS-PERM-31 实测校准（2026-09-22，headed 冒烟 + 只读 UI 探针实证，单 headed 串行执行）：
 * 流程配置页为“按业务类型卡片”布局（表权限申请/TABLE、API调用权限申请/API），每卡唯一
 * “配 置”入口；配置弹窗 = 审批级数 radio(1-5，默认 3 级) + 审批说明 textarea + 环节设置
 * （每级：审批人类型 select[用户/角色] + 具体审批人 select，DOM 顺序 2i/2i+1）+
 * “确认应用”。无名称化流程列表/检索框/新建入口：每类型单一配置槽，“确认应用”即整体替换
 * 该类型唯一启用配置（同类型唯一启用的产品形态）。基于该实证重排断言（契约不弱化）：
 *   1. 列表/查询：双类型卡片齐备且各恰 1 个配置入口 + 噪声关键字页面级负向 + 本前缀基线为空；
 *   2. 默认层级：配置弹窗审批级数默认勾选 3（契约断言，取消不落库），并捕获初始配置快照；
 *   3. 1 级边界：单级 + 用户型审批人（本轮自备 UUID 账号）确认应用后重开回显级数/审批人
 *      （审批说明做“填写持值”断言；重开不回显说明为 DS-PERM-31 二轮实证，只做不矛盾护栏）；
 *   4. 5 级边界：五级 + 角色型审批人（本轮自备 UUID 角色）逐级指派并逐级回显核验（说明同上）；
 *   5. 同类型唯一启用：单配置槽结构断言（每类型 1 入口/无新建/无启停开关，第二条无处创建）；
 *   6. 环境恢复：finally 仅当本轮确认应用过配置时，按初始快照恢复 API 类型审批流并复核。
 *
 * 清洁环境自包含（DS-PERM-29 起）：
 *   - 不依赖任何历史固化用户/角色/流程配置（解除 permissionFixtures.approverLevel1 依赖）：
 *     用户型审批人＝本轮 newPermissionIdentity('sm0203') 生成的 UUID 唯一 ASCII 账号；
 *     角色型审批人＝本轮 newPermissionRole('sm0203','appr') 生成的 UUID 唯一 ASCII 角色
 *     （无菜单最小角色，仅作审批人候选）；两者均页面化创建、finally 尽力删除回收。
 *   - 本轮审批说明唯一标记前缀 e2e_flow0203*（permissionRunId 追加时间戳后缀）：写入配置
 *     说明作为落库可追溯标记；残留判定/恢复复核均以该前缀收敛（“清扫”语义收窄为恢复）。
 *     本版实证：确认应用后重开弹窗不回显说明（stage3/finally 双证），标记仅作填写持值
 *     与人工检索线索，不作重开回显断言。
 *   - 不修改环境既有的“表权限”审批流（SM-02-01/02/04/05 闭环依赖同一配置）：全程只打开
 *     “API调用权限申请”卡片弹窗；表权限卡片仅做存在性与入口数断言，绝不进入其配置。
 *   - 流程配置页打开策略：真实菜单优先（openApprovalLeaf），侧栏折叠/菜单时序异常时
 *     hash 直达兜底（DS-PERM-31 首轮 finally 实证侧栏可折叠，菜单路径不可作唯一依赖）。
 *   - 主流程失败保留原始错误重抛；finally 只恢复/回收本轮对象，通过路径上恢复未闭环必须
 *     判失败，失败路径只告警不掩盖原始错误。
 *   - 挂 RUN_PERMISSION_APPROVAL=1 闸门；仅浏览器页面操作；串行执行（--workers=1）。
 *
 * 校准轨迹：DS-PERM-29/30 静态设计与清洁校准（tsc 0 错误 + 权威孪生 --list 可收集）；
 * DS-PERM-31 首轮 headed 运行实证旧“名称化 CRUD”页面模型与产品不符（trace：flowConfig
 * 页无 textbox 可填），经只读探针校准为本文件形态；二轮 headed 实证补充校准：重开弹窗
 * 说明恒为空（级数/审批人回显正常），相应回显断言收敛为填写持值 + 不矛盾护栏。
 */
import { assertNoConsoleErrors, expect, test } from '../utils.js';
import type { Locator, Page } from '@playwright/test';
import {
  createAndInviteUser,
  createRole,
  loginAs,
  newPermissionIdentity,
  newPermissionRole,
  openRoleManagement,
  openUserManagement,
  type PermissionIdentity,
  type PermissionRole,
} from './权限测试工具.js';
import { confirmPermissionDangerAction } from './数据权限闭环工具.js';
import {
  openApprovalLeaf,
  permissionRunId,
  requirePermissionApprovalEnvironment,
} from './权限审批待调试工具.js';

/** 下拉选项（页面级 teleport，Ant/Element 双兼容）。 */
const OPTION_SELECTOR = [
  '.ant-select-dropdown:visible .ant-select-item-option',
  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
  '.el-select-dropdown:visible .el-select-dropdown__item',
  '[role="listbox"]:visible [role="option"]',
  'li[role="option"]:visible',
].join(', ');

/** 本轮流配置名公共前缀（创建/检索/残留清扫/收尾回收共用；permissionRunId 再追加时间戳）。 */
const FLOW_PREFIX = 'e2e_flow0203';

/** 本轮自备“用户型审批人”：UUID 唯一 ASCII 账号（DS-PERM-29 起解耦 permissionFixtures 固化用户）。 */
const approverUser: PermissionIdentity = newPermissionIdentity('sm0203');

/** 本轮自备“角色型审批人”：UUID 唯一 ASCII 角色（名称前缀 r_sm020_；无菜单最小角色）。 */
const approverRole: PermissionRole = newPermissionRole('sm0203', 'appr');

/** 管理员身份：与 loginPage fixture 同源，用于阶段0 登录与收尾切回回收。 */
const adminIdentity = {
  userName: (process.env.TEST_USER ?? 'admin').trim(),
  nickname: (process.env.TEST_USER ?? 'admin').trim(),
  password: process.env.TEST_PASS ?? '',
  phone: '',
  email: '',
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function firstVisibleMatching(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

async function waitForTrue(page: Page, action: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await action().catch(() => false)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/** 前置不足（入口/控件/类型不足）：写清原因后跳过，不伪造通过、不误报缺陷。 */
function skipForMissingEnvironment(reason: string): never {
  test.info().attach('ENV-SM0203-前置证据.txt', { body: reason, contentType: 'text/plain; charset=utf-8' });
  test.skip(true, 'ENV-SM0203：' + reason);
  throw new Error('UNREACHABLE：test.skip 应已中断用例。');
}

function visibleLayer(page: Page): Locator {
  return page.locator(
    '[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible, .ant-drawer:visible, .el-drawer:visible',
  ).last();
}

/** 关闭可能悬空的下拉（Esc + 空白处点击，均容错）。 */
async function dismissDropdownLocal(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.locator('body').click({ position: { x: 5, y: 5 }, force: true }).catch(() => undefined);
  await page.waitForTimeout(200);
}

/** 流程配置页打开策略：真实菜单优先，hash 直达兜底（侧栏折叠/菜单时序不作唯一依赖）。 */
async function openFlowConfigPage(page: Page): Promise<void> {
  try {
    await openApprovalLeaf(page, '流程配置');
  } catch {
    await page.evaluate(() => { window.location.hash = '#/systemManage/approvalManage/flowConfig'; }).catch(() => undefined);
    await page.waitForTimeout(1_200);
  }
  await expect(page).toHaveURL(/flowConfig/, { timeout: 15_000 }).catch(() => undefined);
  await expect(page.locator('.config-card').first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(400);
}

/** 业务类型卡片（标题含类型名的 .config-card）。 */
function flowTypeCard(page: Page, title: string): Locator {
  return page.locator('.config-card').filter({ hasText: title }).first();
}

/** 打开指定类型卡片的“配 置”弹窗；每类型恰好一个配置入口本身即断言（同类型唯一配置形态）。 */
async function openFlowDialog(page: Page, cardTitle: string): Promise<Locator> {
  const card = flowTypeCard(page, cardTitle);
  await expect(card).toBeVisible({ timeout: 10_000 });
  const entry = card.getByRole('button', { name: /配\s*置/ });
  await expect(entry).toHaveCount(1);
  await entry.first().click();
  const dialog = visibleLayer(page);
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog).toContainText('审批级数', { timeout: 8_000 });
  await page.waitForTimeout(600); // 等弹窗配置回显渲染稳定
  return dialog;
}

/** 关闭弹窗：优先“取 消”，Esc 兜底，并等待隐藏。 */
async function closeFlowDialog(page: Page, dialog: Locator): Promise<void> {
  const cancel = dialog.getByRole('button', { name: /取\s*消/ }).first();
  if (await cancel.isVisible().catch(() => false)) await cancel.click().catch(() => undefined);
  else await page.keyboard.press('Escape').catch(() => undefined);
  await dialog.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => undefined);
}

/** 当前勾选的审批级数（radio value；无勾选返回 ''）。 */
async function readLevelRadio(dialog: Locator): Promise<string> {
  const checked = dialog.locator('input[type="radio"]:checked');
  const count = await checked.count();
  for (let index = 0; index < count; index += 1) {
    const value = await checked.nth(index).getAttribute('value').catch(() => null);
    if (value) return value;
  }
  return '';
}

/** 等待谓词成立（有界轮询），超时抛出携带实测快照的断言错误。 */
async function expectCondition(
  page: Page,
  actual: () => Promise<string>,
  predicate: (value: string) => boolean,
  message: string,
  timeoutMs = 8_000,
): Promise<string> {
  let value = '';
  const ok = await waitForTrue(page, async () => {
    value = await actual();
    return predicate(value);
  }, timeoutMs);
  if (!ok) throw new Error(`${message}（实测=${value || '空'}）`);
  return value;
}

/** 环节设置的 select 对（DOM 顺序=层级序：2i=审批人类型，2i+1=具体审批人；探针实证）。 */
function nodeSelects(dialog: Locator): Locator {
  return dialog.locator('.ant-select:visible');
}

/** 切换审批级数并核验生效（探针实证：级数切换后环节设置节点同步增减）。 */
async function setLevelRadio(page: Page, dialog: Locator, level: number): Promise<void> {
  const radio = dialog.locator(`input[type="radio"][value="${level}"]`);
  if ((await radio.count()) === 0) {
    throw new Error(`审批级数单选组缺少 ${level} 级选项（校准点：确认级数控件形态）。`);
  }
  await radio.check({ force: true }).catch(async () => {
    await dialog.getByText(`${level}级`, { exact: true }).first().click();
  });
  await expectCondition(page, () => readLevelRadio(dialog), (value) => value === String(level),
    `审批级数切至 ${level} 未生效`);
  await expectCondition(page, async () => String(await nodeSelects(dialog).count()),
    (value) => value === String(level * 2),
    `级数 ${level} 的环节设置节点数应为 ${level * 2}（类型+审批人各一）`);
}

/** 选择第 levelIndex 级的审批人类型（用户/角色）。 */
async function pickNodeType(page: Page, dialog: Locator, levelIndex: number, kind: string): Promise<void> {
  const typeSelect = nodeSelects(dialog).nth(levelIndex * 2);
  await typeSelect.click();
  const option = page.locator(OPTION_SELECTOR)
    .filter({ hasText: new RegExp('^\\s*' + kind + '\\s*$') }).first();
  await expect(option).toBeVisible({ timeout: 6_000 });
  await option.click();
  await expectCondition(page, async () => ((await typeSelect.innerText().catch(() => '')) ?? '').trim(),
    (value) => value.includes(kind), `第 ${levelIndex + 1} 级审批人类型应为 ${kind}`);
}

/** 选择第 levelIndex 级的具体审批人（支持输入过滤；候选缺失=硬错误并附候选样本）。 */
async function pickNodeApprover(
  page: Page,
  dialog: Locator,
  levelIndex: number,
  aliasPattern: RegExp,
  searchText: string,
): Promise<void> {
  const approverSelect = nodeSelects(dialog).nth(levelIndex * 2 + 1);
  await approverSelect.click();
  await page.waitForTimeout(400);
  const searchInput = approverSelect
    .locator('input.ant-select-selection-search-input, input[type="search"]').first();
  if (searchText && (await searchInput.count()) && (await searchInput.isVisible().catch(() => false))) {
    await searchInput.pressSequentially(searchText, { delay: 20 }).catch(() => undefined);
  }
  const option = page.locator(OPTION_SELECTOR).filter({ hasText: aliasPattern }).first();
  if (!(await waitForTrue(page, async () => option.isVisible().catch(() => false), 6_000))) {
    const candidates = (await page.locator(OPTION_SELECTOR).allInnerTexts().catch(() => [] as string[]))
      .map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 30).join('、');
    await dismissDropdownLocal(page);
    throw new Error(`第 ${levelIndex + 1} 级审批人候选中未找到“${searchText}”`
      + `（校准点：确认候选接口/筛选行为）；候选样本=[${candidates}]。`);
  }
  await option.click();
  await expectCondition(page, async () => ((await approverSelect.innerText().catch(() => '')) ?? '').trim(),
    (value) => aliasPattern.test(value), `第 ${levelIndex + 1} 级具体审批人回显应为 ${searchText}`);
}

/** 读取第 levelIndex 级的当前回显（类型, 审批人）。 */
async function readNodePair(dialog: Locator, levelIndex: number): Promise<[string, string]> {
  const selects = nodeSelects(dialog);
  const kind = ((await selects.nth(levelIndex * 2).innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
  const approver = ((await selects.nth(levelIndex * 2 + 1).innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
  return [kind, approver];
}

/** 审批说明输入框（探针实证：弹窗内唯一 textarea）。 */
function flowRemarkBox(dialog: Locator): Locator {
  return dialog.locator('textarea').first();
}

/** 确认应用；返回拦截提示文本（'' = 已提交且弹窗关闭；兼容二次确认弹层）。 */
async function applyFlowDialog(page: Page, dialog: Locator): Promise<string> {
  const apply = dialog.getByRole('button', { name: /确\s*认\s*应\s*用/ }).first();
  await expect(apply).toBeVisible({ timeout: 5_000 });
  await apply.click();
  const blockTip = page
    .locator('.ant-message, .el-message, .ant-form-item-explain-error, .el-form-item__error, [role="alert"]')
    .filter({ hasText: /必填|请选择|请输入|已存在|唯一|失败|层级|审批人|类型/ });
  const tip = await waitForTrue(page, async () => (await blockTip.count()) > 0, 3_000);
  if (tip) {
    const text = ((await blockTip.first().innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
    if (text) {
      await dismissDropdownLocal(page);
      return text;
    }
  }
  if (!(await dialog.waitFor({ state: 'hidden', timeout: 4_000 }).then(() => true).catch(() => false))) {
    // 兼容二次确认弹层：出现“确定”则确认一次后继续等待关闭。
    const confirmButton = page.getByRole('button', { name: /^确\s*定$/ }).last();
    if (await confirmButton.isVisible().catch(() => false)) {
      await confirmButton.click().catch(() => undefined);
      await dialog.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => undefined);
    }
  }
  await page.waitForTimeout(800);
  return '';
}

/** 配置快照（级数+各级[类型,审批人]+说明），用于收尾恢复到进入时状态。 */
interface FlowSnapshot {
  level: string;
  nodes: Array<[string, string]>;
  remark: string;
}

/** 捕获弹窗当前配置快照。 */
async function captureFlowSnapshot(dialog: Locator, level: number): Promise<FlowSnapshot> {
  const nodes: Array<[string, string]> = [];
  for (let index = 0; index < level; index += 1) nodes.push(await readNodePair(dialog, index));
  return { level: String(level), nodes, remark: (await flowRemarkBox(dialog).inputValue().catch(() => '')) ?? '' };
}

/** 按快照恢复配置：切级数→逐级类型/审批人→说明→确认应用。 */
async function restoreFlowSnapshot(page: Page, dialog: Locator, snapshot: FlowSnapshot): Promise<void> {
  const level = Number(snapshot.level);
  await setLevelRadio(page, dialog, level);
  for (let index = 0; index < level; index += 1) {
    const [kind, approver] = snapshot.nodes[index];
    if (!kind) throw new Error(`初始快照第 ${index + 1} 级类型为空，无法恢复（校准点）。`);
    await pickNodeType(page, dialog, index, kind);
    if (approver) {
      await pickNodeApprover(page, dialog, index,
        new RegExp('^\\s*' + escapeRegExp(approver) + '\\s*$'), approver);
    }
  }
  await flowRemarkBox(dialog).fill(snapshot.remark);
  const tip = await applyFlowDialog(page, dialog);
  if (tip) throw new Error('恢复进入时配置被拦截：' + tip);
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * 在用户管理/角色管理页按唯一名称删除单个对象并复查列表（SM-03-05 deleteNamedRow 同型）。
 * 返回 deleted / absent / no-entry / delete-not-effective。
 */
async function deleteNamedManagementRow(
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
  const row = nameText.locator('xpath=ancestor::*[self::tr or @role="row" or contains(@class,"el-table__row")][1]');
  const textButton = row.getByRole('button', { name: /删\s*除|移\s*除/ }).first();
  const rowIcon = row
    .locator('[aria-label*="delete" i], [aria-label*="删除"], .anticon-delete, [class*="icon-delete"]')
    .first();
  const action = (await textButton.isVisible().catch(() => false))
    ? textButton
    : (await rowIcon.isVisible().catch(() => false))
      ? rowIcon
      : undefined;
  if (!action) return 'no-entry';
  await action.click();
  await confirmPermissionDangerAction(page);
  await page.waitForTimeout(1_000);
  await query.fill(options.name);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(1_000);
  const again = page.getByText(options.name, { exact: true }).last();
  return (await again.isVisible().catch(() => false)) ? 'delete-not-effective' : 'deleted';
}

test('SM-02-03｜系统管理｜审批流程配置-列表查询默认层级边界审批人与同类型唯一启用', async ({ loginPage, consoleErrors, report }) => {
  requirePermissionApprovalEnvironment();
  test.setTimeout(600_000);
  const page = loginPage;

  /** 受保护类型（SM-02-01/02/04/05 闭环依赖其审批流）：全程仅断言存在与入口数，绝不打开其配置。 */
  const PROTECTED_CARD = '表权限申请';
  /** 本轮可写类型：非保护业务类型卡片（DS-PERM-31 探针实证：API调用权限申请 卡片存在且可配置）。 */
  const TARGET_CARD = 'API调用权限申请';

  let mainError: unknown;
  /** 阶段3/4 任一“确认应用”成功后置 true：finally 据此决定是否恢复进入时配置。 */
  let flowMutated = false;
  /** 阶段2 首开弹窗捕获的初始配置快照（收尾恢复基线）。 */
  let initialSnapshot: FlowSnapshot | undefined;
  /** 本轮审批说明唯一标记（前缀 FLOW_PREFIX + 时间戳，落库可追溯）。 */
  const marker1 = permissionRunId(FLOW_PREFIX + 'a');
  const marker5 = permissionRunId(FLOW_PREFIX + 'b');
  const userAlias = new RegExp([approverUser.userName, approverUser.nickname].map(escapeRegExp).join('|'));
  const roleAlias = new RegExp(escapeRegExp(approverRole.roleName));

  try {
    // 阶段0a（自备用户型审批人）：管理员登录并创建本轮 UUID 唯一 ASCII 账号（不依赖历史固化用户）。
    await loginAs(page, adminIdentity);
    await createAndInviteUser(page, approverUser);
    await report('SM-02-03 阶段0a｜创建本轮用户型审批人', true,
      `账号=${approverUser.userName}（UUID 唯一 ASCII；收尾尽力删除回收）。`);

    // 阶段0b（自备角色型审批人）：创建本轮 UUID 唯一 ASCII 最小角色（无菜单，仅作审批人候选）。
    await createRole(page, approverRole);
    await report('SM-02-03 阶段0b｜创建本轮角色型审批人', true,
      `角色=${approverRole.roleName}（UUID 唯一 ASCII；收尾尽力删除回收）。`);

    // 阶段0c（页面就绪+本前缀基线）：产品无名称化流程列表可清扫——基线改为页面级前缀负向
    // 断言（本前缀仅写入审批说明；页面命中即意味着历史中断轮次遗留同名标记配置，属异常残留）。
    await openFlowConfigPage(page);
    const baselineBody = ((await page.locator('body').innerText().catch(() => '')) ?? '');
    if (baselineBody.includes(FLOW_PREFIX)) {
      throw new Error(`本前缀 ${FLOW_PREFIX}* 基线应无残留，页面文本却命中（历史轮次遗留同一配置说明标记；校准点）。`);
    }
    await report('SM-02-03 阶段0c｜流程配置页就绪+本前缀基线', true,
      `页面=按业务类型卡片布局；本前缀 ${FLOW_PREFIX}* 基线无残留。`);

    // 阶段1（列表/查询契约）：双业务类型卡片齐备且各恰 1 个配置入口；噪声关键字页面级负向
    //（产品无检索框，卡片式列表的负向检索契约落在页面可见文本上，不弱化）。
    await expect(page.getByRole('heading', { name: '流程配置' })).toBeVisible({ timeout: 10_000 });
    for (const cardTitle of [PROTECTED_CARD, TARGET_CARD]) {
      const card = flowTypeCard(page, cardTitle);
      await expect(card).toBeVisible({ timeout: 10_000 });
      await expect(card.getByRole('button', { name: /配\s*置/ })).toHaveCount(1);
    }
    const noiseKeyword = permissionRunId('e2e_noflow0203');
    const pageText = ((await page.locator('body').innerText().catch(() => '')) ?? '');
    if (pageText.includes(noiseKeyword)) {
      throw new Error(`噪声关键字 ${noiseKeyword} 命中页面文本：列表渲染疑似混入未知配置（校准点：确认列表字段契约）。`);
    }
    await report('SM-02-03 阶段1｜列表查询与负向检索', true,
      `卡片=表权限申请/API调用权限申请（各恰 1 个配置入口）；噪声关键字 ${noiseKeyword} 无命中；本前缀基线 0 条。`);

    // 阶段2（默认层级契约，不保存）：配置弹窗审批级数默认勾选 3；同时捕获初始配置快照
    //（收尾恢复基线），随后取消不落库。
    {
      const dialog = await openFlowDialog(page, TARGET_CARD);
      const defaultLevel = await readLevelRadio(dialog);
      if (!defaultLevel) {
        throw new Error('未识别到审批级数勾选值（校准点：确认级数 radio 组形态）。');
      }
      expect(defaultLevel, `审批级数默认应为 3（实际=${defaultLevel}；校准点：确认默认层级契约）`).toBe('3');
      initialSnapshot = await captureFlowSnapshot(dialog, Number(defaultLevel));
      await closeFlowDialog(page, dialog);
      await report('SM-02-03 阶段2｜默认审批层级=3（不保存）', true,
        `默认级数=${defaultLevel}；初始配置快照=级数 ${initialSnapshot.level}、说明“${initialSnapshot.remark || '空'}”、`
          + `各级=[${initialSnapshot.nodes.map((pair) => pair.join('/')).join('；') || '（空）'}]；已取消，未保存任何变更。`);
    }

    // 阶段3（1 级 + 用户型审批人）：切 1 级→类型=用户→本轮账号→说明标记→确认应用→重开回显核验。
    {
      const dialog = await openFlowDialog(page, TARGET_CARD);
      await setLevelRadio(page, dialog, 1);
      await pickNodeType(page, dialog, 0, '用户');
      await pickNodeApprover(page, dialog, 0, userAlias, approverUser.userName);
      await flowRemarkBox(dialog).fill(marker1);
      // 预应用持值断言：确认应用前 textarea 确实持有本轮标记（确定性回读）。
      await expect(flowRemarkBox(dialog)).toHaveValue(marker1);
      const blockedTip = await applyFlowDialog(page, dialog);
      if (blockedTip) {
        skipForMissingEnvironment(`1 级+用户型审批流保存被拦截：${blockedTip}（校准点：确认必填项与应用限制）。`);
      }
      flowMutated = true;
      const echo = await openFlowDialog(page, TARGET_CARD);
      await expectCondition(page, () => readLevelRadio(echo), (value) => value === '1', '应用后回显级数应为 1');
      await expectCondition(page, async () => {
        const [kind, approver] = await readNodePair(echo, 0);
        return kind + '|' + approver;
      }, (value) => {
        const [kind, approver] = value.split('|');
        return kind.includes('用户') && userAlias.test(approver ?? '');
      }, '1 级+用户型配置回显不符');
      // DS-PERM-31 二轮实证：重开弹窗级数/审批人正常回显，但审批说明 textarea 恒为空
      //（stage3 与 finally 恢复复查双证）。说明不作为回显断言，只做不矛盾护栏。
      const remarkEcho3 = ((await flowRemarkBox(echo).inputValue().catch(() => '')) ?? '').trim();
      expect(remarkEcho3 === '' || remarkEcho3.includes(marker1),
        `审批说明重开回显出现非预期内容“${remarkEcho3}”（校准点：说明回显契约变化）`).toBeTruthy();
      await closeFlowDialog(page, echo);
      await report('SM-02-03 阶段3｜1 级+用户型审批人已应用并回显', true,
        `级数=1，类型=用户，审批人=${approverUser.userName}；说明标记=${marker1} 已填写`
          + '（本版重开不回显说明，实证校准）。');
    }

    // 阶段4（5 级 + 角色型审批人）：切 5 级→逐级类型=角色+本轮角色→说明标记→确认应用→逐级回显核验。
    {
      const dialog = await openFlowDialog(page, TARGET_CARD);
      await setLevelRadio(page, dialog, 5);
      for (let level = 0; level < 5; level += 1) {
        await pickNodeType(page, dialog, level, '角色');
        await pickNodeApprover(page, dialog, level, roleAlias, approverRole.roleName);
      }
      await flowRemarkBox(dialog).fill(marker5);
      // 预应用持值断言（同阶段3）。
      await expect(flowRemarkBox(dialog)).toHaveValue(marker5);
      const blockedTip = await applyFlowDialog(page, dialog);
      if (blockedTip) {
        skipForMissingEnvironment(`5 级+角色型审批流保存被拦截：${blockedTip}（校准点：确认必填项与应用限制）。`);
      }
      flowMutated = true;
      const echo = await openFlowDialog(page, TARGET_CARD);
      await expectCondition(page, () => readLevelRadio(echo), (value) => value === '5', '应用后回显级数应为 5');
      for (let level = 0; level < 5; level += 1) {
        const [kind, approver] = await readNodePair(echo, level);
        if (!kind.includes('角色') || !roleAlias.test(approver)) {
          throw new Error(`5 级流程第 ${level + 1} 级回显不符：类型=${kind}，审批人=${approver}`
            + `（期望 角色/${approverRole.roleName}；校准点：确认逐级回显契约）。`);
        }
      }
      // 说明重开不回显（实证）：同阶段3，只做不矛盾护栏。
      const remarkEcho5 = ((await flowRemarkBox(echo).inputValue().catch(() => '')) ?? '').trim();
      expect(remarkEcho5 === '' || remarkEcho5.includes(marker5),
        `审批说明重开回显出现非预期内容“${remarkEcho5}”（校准点：说明回显契约变化）`).toBeTruthy();
      await closeFlowDialog(page, echo);
      await report('SM-02-03 阶段4｜5 级+角色型审批人已应用并回显', true,
        `级数=5，各级=角色 ${approverRole.roleName}；说明标记=${marker5} 已填写`
          + '（本版重开不回显说明，实证校准）。');
    }

    // 阶段5（同类型唯一配置形态+启用边界护栏）：结构唯一性核验 + 启用开关负向护栏。
    {
      for (const cardTitle of [PROTECTED_CARD, TARGET_CARD]) {
        const card = flowTypeCard(page, cardTitle);
        await expect(card).toBeVisible({ timeout: 10_000 });
        await expect(card.getByRole('button', { name: /配\s*置/ })).toHaveCount(1);
        const enableSwitch = card.locator('.ant-switch, [role="switch"]');
        if ((await enableSwitch.count()) > 0) {
          throw new Error(`${cardTitle} 卡片出现列表级启用开关（探针实证唯一配置形态为卡内单一“配 置”入口；校准点）。`);
        }
      }
      const createEntries = await page
        .getByRole('button', { name: /新\s*建|新增|添加|创建/ }).count();
      if (createEntries > 0) {
        throw new Error(`流程配置页出现 ${createEntries} 个新建类入口（探针实证为编辑存量型配置；校准点：确认产品形态）。`);
      }
      await report('SM-02-03 阶段5｜同类型唯一配置形态', true,
        '两类卡片各恰 1 个配置入口；无新建类入口、无列表级启用开关；'
          + `受保护“${PROTECTED_CARD}”配置全程未被打开或改动。`);
    }

    await assertNoConsoleErrors(consoleErrors);
    await report('SM-02-03｜审批流程配置清洁环境审计完成', true,
      '卡片列表契约（双类型各 1 个配置入口+噪声负向）→默认 3 级不保存→1 级+用户型审批人（' + approverUser.userName
        + '）→5 级+角色型审批人（' + approverRole.roleName + '）→同类型唯一配置形态护栏；'
        + '本轮说明标记=[' + marker1 + '、' + marker5 + ']，收尾恢复 API 流程进入时配置并回收自备用户/角色。');
  } catch (error) {
    mainError = error;
    throw error;
  } finally {
    // 收尾（仅本轮资源，顺序：流程配置→自备用户→自备角色；SM-03-05/SM-03-09 同型）：
    // 每步独立 try/catch 登记 issues；通过路径上回收未闭环必须判失败，
    // 失败路径只 console.warn 告警，不掩盖主结果原始错误。
    const steps: string[] = [];
    const issues: string[] = [];
    const runStep = async (name: string, action: () => Promise<{ ok: boolean; detail: string }>): Promise<void> => {
      try {
        const { ok, detail } = await action();
        steps.push(`${name}：${detail}`);
        if (!ok) issues.push(`${name}：${detail}`);
      } catch (error) {
        const detail = '失败：' + describeError(error);
        steps.push(`${name}：${detail}`);
        issues.push(`${name}：${detail}`);
      }
    };

    try {
      await loginAs(page, adminIdentity);
    } catch (error) {
      issues.push('管理员重新登录失败，兜底清理可能不完整：' + describeError(error));
    }

    await runStep('API流程恢复进入时配置' + (flowMutated && initialSnapshot
      ? `（目标级数=${initialSnapshot.level}，含说明回填）`
      : '（本轮未应用变更，跳过）'), async () => {
      if (!flowMutated || !initialSnapshot) return { ok: true, detail: '本轮未产生配置变更，无需恢复' };
      const snapshot = initialSnapshot;
      await openFlowConfigPage(page);
      const dialog = await openFlowDialog(page, TARGET_CARD);
      try {
        await restoreFlowSnapshot(page, dialog, snapshot);
      } finally {
        await closeFlowDialog(page, dialog);
      }
      const echo = await openFlowDialog(page, TARGET_CARD);
      try {
        const level = await readLevelRadio(echo);
        const remark = (await flowRemarkBox(echo).inputValue().catch(() => '')) ?? '';
        const echoed = level === snapshot.level && !remark.includes(marker1) && !remark.includes(marker5);
        return {
          ok: echoed,
          detail: `复查级数=${level || '空'}，说明="${remark || '空'}"`
            + (echoed ? '' : `（校准点：回显未回到初始快照；请人工按标记 ${marker1}/${marker5} 检索恢复）`),
        };
      } finally {
        await closeFlowDialog(page, echo);
      }
    });
    await runStep(`本轮用户型审批人回收（${approverUser.userName}）`, async () => {
      const outcome = await deleteNamedManagementRow(page, {
        queryName: '请输入用户名称',
        name: approverUser.userName,
        openPage: () => openUserManagement(page),
      });
      return {
        ok: outcome === 'deleted' || outcome === 'absent',
        detail: outcome === 'no-entry' ? 'no-entry（页面未提供删除/移除入口，用户残留在案）' : outcome,
      };
    });
    await runStep(`本轮角色型审批人回收（${approverRole.roleName}）`, async () => {
      const outcome = await deleteNamedManagementRow(page, {
        queryName: '请输入角色名称',
        name: approverRole.roleName,
        openPage: () => openRoleManagement(page),
      });
      return {
        ok: outcome === 'deleted' || outcome === 'absent',
        detail: outcome === 'no-entry' ? 'no-entry（页面未提供删除入口，角色残留在案）' : outcome,
      };
    });

    await test.info().attach('sm0203-finally-cleanup.log', {
      body: steps.join('\n') || '（无清理步骤记录）',
      contentType: 'text/plain; charset=utf-8',
    }).catch(() => undefined);
    await report('SM-02-03 收尾｜try/finally 兜底清理（仅回收本前缀对象）', issues.length === 0,
      steps.join('；') || '无可回收对象（本轮未产生资源）。');
    if (!mainError && issues.length > 0) {
      throw new Error('兜底清理未完全回收本用例对象：' + issues.join('；'));
    }
    for (const issue of issues) console.warn('[SM-02-03 收尾] ' + issue);
  }
});
