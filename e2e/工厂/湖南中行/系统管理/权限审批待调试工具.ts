/**
 * 权限/审批新增用例的环境闸门与审批闭环页面工具（SM-02-03~SM-02-07 共用）。
 *
 * 这些用例在 2026-09-21 环境不可用期间完成静态开发，默认不参与普通回归，避免把
 * “服务不可访问”伪装为产品失败。环境恢复并完成 SM-00-02 前置后，以
 * RUN_PERMISSION_APPROVAL=1 显式解锁，再做一次 --headed 页面定位校准。
 *
 * 2026-09-21（PERM-STATIC-05）新增表权限审批闭环工具：申请人提交申请、逐级
 * 同意/拒绝、申请人撤销、终态核验、管理员身份与入口构造。页面定位与失败语义
 * 全部对齐已实测的 SM-02-01（多级审批闭环）：仅浏览器页面操作；前置不足写明
 * 原因并 skip；节点/列表结构变化时抛出带上下文的错误，不静默放行、不写死通过。
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test, clickMenu } from '../utils.js';
import { loginAs } from './权限测试工具.js';
import type { PermissionIdentity } from './权限测试工具.js';
import { dismissPermissionDropdown } from './数据权限闭环工具.js';

export function requirePermissionApprovalEnvironment(): void {
  test.skip(
    process.env.RUN_PERMISSION_APPROVAL !== '1',
    'ENV-PERM-APPROVAL：环境未恢复或尚未完成 SM-00-02；设置 RUN_PERMISSION_APPROVAL=1 后再执行。',
  );
}

export async function openApprovalLeaf(page: Page, leaf: '流程配置' | '我的申请' | '我的审批'): Promise<void> {
  const approval = page.getByText('审批管理', { exact: true }).last();
  await expect(approval).toBeVisible({ timeout: 15_000 });
  await approval.click();
  const target = page.getByText(leaf, { exact: true }).last();
  await expect(target).toBeVisible({ timeout: 8_000 });
  await target.click();
  await expect(page.locator('body')).toContainText(leaf);
}

export async function clickVisibleButton(page: Page, label: RegExp): Promise<void> {
  const button = page.getByRole('button', { name: label }).last();
  await expect(button).toBeVisible({ timeout: 10_000 });
  await button.click();
}

export function permissionRunId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}`.toLowerCase();
}

/** 审批工作台路由（与 SM-02-01 一致）：hash 直达与真实菜单兜底共用。 */
const APPROVAL_ROUTES: Record<string, string> = {
  我的申请: '#/systemManage/approvalManage/myApply',
  我的审批: '#/systemManage/approvalManage/myExamine',
};

/** 与 SM-02-01 相同的落地页入口构造：显式 ENTRY_URL > 环境默认值。 */
export function approvalEntryUrl(pathWithoutHash: string): string {
  const entry = new URL(
    process.env.ENTRY_URL ?? 'http://bigdata.dev.northking.net/bigdata-ui-factory/#/dataAccess/dataSource',
  );
  entry.hash = pathWithoutHash;
  return entry.toString();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 返回 locator 中第一个可见元素（自上而下），与 SM-02-01 firstVisibleMatching 一致。 */
async function firstVisibleMatching(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

/** 有界轮询：action 返回 true 即成功；超时返回 false（不抛错，由调用方定性）。 */
async function waitForTrue(page: Page, action: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await action().catch(() => false)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/** 前置不足：写清原因并落附件后跳过，不伪造通过、不误报缺陷（口径同 SM-02-01）。 */
export function skipForMissingEnvironment(reason: string): never {
  test.info().attach('ENV-PERM-APPROVAL-前置证据.txt', { body: reason, contentType: 'text/plain; charset=utf-8' });
  test.skip(true, 'ENV-PERM-APPROVAL：' + reason);
  throw new Error('UNREACHABLE：test.skip 应已中断用例。');
}

/** 可见数据行（Ant/Element 表格 + 通用 row 角色，排除表头行）。 */
function visibleRows(page: Page): Locator {
  return page.locator(
    'tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not([role="columnheader"])',
  );
}

/** 成功提示（Ant/Element 双兼容 + 通用 alert/toast/message）。 */
function successNotice(page: Page, pattern: string | RegExp) {
  return page.locator(
    '.ant-message-notice-content:visible, .ant-notification-notice-message:visible, .el-message:visible, '
      + '[role="alert"]:visible, [class*="toast"]:visible, [class*="message"]:visible',
  ).filter({ hasText: pattern }).last();
}

/** 可见弹层（Ant/Element 双兼容）：申请权限与审批/撤销确认共用。 */
function visibleLayer(page: Page): Locator {
  return page.locator(
    '[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible, .ant-drawer:visible, .el-drawer:visible',
  ).last();
}

/** 下拉选项渲染在页面级（teleport），Ant/Element 双兼容（口径同 SM-02-01）。 */
const APPROVAL_OPTION_SELECTOR = [
  '.ant-select-dropdown:visible .ant-select-item-option',
  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
  '.el-select-dropdown:visible .el-select-dropdown__item',
  '[role="listbox"]:visible [role="option"]',
  'li[role="option"]:visible',
].join(', ');

/**
 * 系统管理 → 审批管理 → 我的申请/我的审批（真实菜单兜底）。
 * “审批管理”可能是折叠分组：首次点击只展开不出叶子，叶子按 4 秒窗口轮询，
 * 未出现时补点一次分组再查，不把展开时序误判为无权限（SM-02-01 实测口径）。
 */
async function openSystemApprovalLeaf(page: Page, leaf: '我的申请' | '我的审批'): Promise<void> {
  if (!page.url().includes('/systemManage/')) {
    await clickMenu(page, '系统管理');
  }
  const menuScope = page.locator(
    '.el-menu:visible, .el-aside:visible, aside:visible, [class*="sidebar" i]:visible, [class*="menu" i]:visible',
  );
  const approvalGroup = await firstVisibleMatching(menuScope.getByText('审批管理', { exact: true }))
    ?? await firstVisibleMatching(page.getByText('审批管理', { exact: true }));
  if (!approvalGroup) {
    throw new Error('系统管理左侧未找到“审批管理”菜单（角色需在角色管理中勾选「审批管理」菜单）。');
  }
  await approvalGroup.click();
  let approvalLeaf: Locator | undefined;
  const leafDeadline = Date.now() + 4_000;
  while (!(approvalLeaf = await firstVisibleMatching(page.getByText(leaf, { exact: true })))) {
    if (Date.now() > leafDeadline) break;
    if (await approvalGroup.isVisible().catch(() => false)) await approvalGroup.click().catch(() => undefined);
    await page.waitForTimeout(400);
  }
  if (!approvalLeaf) throw new Error('“审批管理”展开后未找到“' + leaf + '”入口。');
  await approvalLeaf.click();
  const route = APPROVAL_ROUTES[leaf];
  await expect(page).toHaveURL(new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

/**
 * 以指定身份进入 我的申请/我的审批 工作台（口径同 SM-02-01 openApprovalPageAs）：
 * 夹具账号冷启动直达审批路由会被路由守卫重定向 404（动态路由在应用初始化完成后
 * 才注册），因此先登录到账号可达的数据地图-表查询，再做应用内 hash 直达；
 * 未呈现审批页签时用真实菜单兜底；两条路径都失败按环境前置不足跳过并固化现场。
 */
export async function openApprovalWorkbenchAs(
  page: Page,
  identity: PermissionIdentity,
  leaf: '我的申请' | '我的审批',
): Promise<void> {
  const fragment = APPROVAL_ROUTES[leaf].replace('#', '');
  await loginAs(page, identity, { entryUrl: approvalEntryUrl('/dataMap/tableQuery/tablesQuery') });
  const ready = async () => /未审批|已审批/.test(await page.locator('body').innerText().catch(() => ''));
  if (!page.url().includes(fragment)) {
    await page.evaluate((hash) => { window.location.hash = hash; }, '#' + fragment).catch(() => undefined);
    await page.waitForTimeout(1_000);
  }
  const directOk = page.url().includes(fragment) && await waitForTrue(page, ready, 8_000);
  if (directOk) return;
  let menuOk = false;
  try {
    await openSystemApprovalLeaf(page, leaf);
    menuOk = await waitForTrue(page, ready, 8_000);
  } catch {
    menuOk = false;
  }
  if (!menuOk) {
    const finalUrl = page.url();
    const bodySnippet = (await page.locator('body').innerText().catch(() => ''))
      .replace(/\s+/g, ' ').trim().slice(0, 300);
    skipForMissingEnvironment(
      '账号 ' + identity.userName + ' 无法进入“' + leaf + '”：hash 直达(' + fragment
        + ')未呈现审批页签，菜单兜底也未成功；最终URL=' + finalUrl
        + '；页面片段=' + bodySnippet
        + '。请确认该角色已在角色管理勾选「系统管理/审批管理」菜单（flash 验证点：审批入口形态）。',
    );
  }
}

/** 工作台页签（未审批/已审批）：窄窗口下可能收进“更多”菜单（口径同 SM-02-01 clickSystemTab）。 */
async function clickWorkbenchTab(page: Page, name: string): Promise<void> {
  const tabSelector = '[role="tab"]:visible, .ant-tabs-tab:visible, .el-tabs__item:visible';
  const findDirect = async (): Promise<Locator | undefined> => {
    const candidates = [
      page.locator(tabSelector).filter({
        hasText: new RegExp('^\\s*' + escapeRegExp(name) + '\\s*$'),
      }),
      page.getByRole('tab', { name, exact: true }),
    ];
    for (const candidate of candidates) {
      const item = await firstVisibleMatching(candidate);
      if (item) return item;
    }
    return undefined;
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const direct = await findDirect();
    if (direct) {
      await direct.click();
      const selected = await direct.getAttribute('aria-selected');
      if (selected !== null) await expect(direct).toHaveAttribute('aria-selected', 'true');
      await page.waitForTimeout(500);
      return;
    }
    const more = await firstVisibleMatching(page.locator(
      '.ant-tabs-nav-operations .ant-tabs-nav-more:visible, .el-tabs__nav-more:visible, '
        + '[role="tablist"]:visible [aria-label*="更多"]:visible, [role="tablist"]:visible [title*="更多"]:visible, '
        + '[role="tablist"]:visible [aria-label="···"]:visible, [role="tablist"]:visible [title="···"]:visible',
    ));
    if (more) {
      await more.click();
      const popup = page.locator(
        '.ant-tabs-dropdown:visible, .ant-dropdown:visible, .el-tabs__dropdown-menu:visible, '
          + '.el-dropdown-menu:visible, [role="menu"]:visible',
      );
      const hidden = await firstVisibleMatching(
        popup.getByRole('menuitem', { name, exact: true }).or(popup.getByText(name, { exact: true })),
      );
      if (hidden) {
        await hidden.click();
        await page.waitForTimeout(500);
        return;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error('工作台页签“' + name + '”未找到（已检查可见页签及“更多”菜单），当前页面：' + page.url());
}

/** 我的申请/我的审批：切页签 → 查询 → 返回包含本轮标记的首个可见行（重查一次抗列表异步竞态）。 */
export async function findApprovalMarkerRow(
  page: Page,
  tab: '未审批' | '已审批',
  marker: string,
): Promise<Locator | undefined> {
  await clickWorkbenchTab(page, tab);
  await page.getByRole('button', { name: /查\s*询/ }).first().click();
  await page.waitForTimeout(400);
  const row = await firstVisibleMatching(visibleRows(page).filter({ hasText: marker }));
  if (row) return row;
  await page.waitForTimeout(1_200);
  await page.getByRole('button', { name: /查\s*询/ }).first().click();
  await page.waitForTimeout(600);
  return firstVisibleMatching(visibleRows(page).filter({ hasText: marker }));
}

/** 数据地图-表查询：搜索目标表并返回其可见卡片（找不到返回 undefined；口径同 SM-02-01）。 */
export async function openTableQueryCard(page: Page, tableName: string): Promise<Locator | undefined> {
  await clickMenu(page, '数据地图');
  const link = page.locator('a[href="#/dataMap/tableQuery/tablesQuery"]:visible').last();
  if (await link.isVisible().catch(() => false)) {
    await link.click();
  } else {
    await clickMenu(page, '数据地图', '表查询');
  }
  const search = page.getByPlaceholder(/按表名|表名|搜索/).first();
  await expect(search).toBeVisible({ timeout: 15_000 });
  await search.click();
  await search.fill('');
  // 逐字输入并回车+失焦：兼容 input/change 与 keyup.enter 两种提交实现。
  await search.pressSequentially(tableName, { delay: 10 });
  await search.press('Enter');
  await search.blur();
  const cardLocator = page.locator(
    '.table-query .card:visible, .table-query .ant-card:visible, .table-query .el-card:visible',
  );
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const card = await firstVisibleMatching(cardLocator.filter({ hasText: tableName }));
    if (card) return card;
    await page.waitForTimeout(500);
  }
  return undefined;
}

/** 弹窗审批节点：固定用户=审批流配置确定（禁用文本框回显）；待指派=“请选择(用户|审批人)”下拉。 */
type ApprovalNode =
  | { kind: '固定用户'; level: number; displayName: string; rowText: string; y: number }
  | { kind: '待指派'; level: number; displayName: string; rowText: string; y: number; box: Locator };

/** 节点序号：第一→1 … 第十→10；解析失败返回大数保证排序兜底。 */
function approvalLevelOf(text: string): number {
  const map: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  const match = text.match(/第([一二三四五六七八九十])审批人/);
  return match ? (map[match[1]] ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
}

/**
 * 解析申请弹窗的审批节点指派区，按页面纵向顺序返回。
 * 禁用输入框只认“第N审批人”行，避免把日期等其它禁用控件误判为审批节点。
 */
async function collectApprovalNodes(layer: Locator): Promise<ApprovalNode[]> {
  const nodes: ApprovalNode[] = [];
  const fixedInputs = layer.locator('input:disabled');
  const fixedTotal = await fixedInputs.count();
  for (let index = 0; index < fixedTotal; index += 1) {
    const input = fixedInputs.nth(index);
    const displayName = ((await input.inputValue().catch(() => '')) ?? '').trim();
    if (!displayName) continue;
    const row = input.locator('xpath=ancestor::*[contains(normalize-space(string(.)), "审批人")][1]');
    if (!(await row.isVisible().catch(() => false))) continue;
    const rowText = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!/第[一二三四五六七八九十]{1,2}审批人/.test(rowText)) continue;
    const y = (await row.boundingBox().catch(() => null))?.y ?? Number.MAX_SAFE_INTEGER;
    nodes.push({ kind: '固定用户', level: approvalLevelOf(rowText), displayName, rowText, y });
  }
  const boxes = layer.locator('.el-select:visible, .ant-select:visible');
  const total = await boxes.count();
  for (let index = 0; index < total; index += 1) {
    const box = boxes.nth(index);
    const input = box.locator('input').first();
    const placeholder = (await input.getAttribute('placeholder').catch(() => '')) ?? '';
    const boxText = (await box.innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (!/请选择(用户|审批人)/.test(placeholder + ' ' + boxText)) continue;
    const y = (await box.boundingBox().catch(() => null))?.y ?? Number.MAX_SAFE_INTEGER;
    nodes.push({ kind: '待指派', level: 0, displayName: '', rowText: boxText, y, box });
  }
  return nodes.sort((a, b) => a.y - b.y);
}

/** 计划审批人（登录用户名/展示昵称）→ 登录用户名：固定节点回显名与账号双向兼容。 */
function approvalAliasesOf(plan: PermissionIdentity[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const identity of plan) {
    map.set(identity.userName, identity.userName);
    if (identity.nickname) map.set(identity.nickname, identity.userName);
  }
  return map;
}

/** 只读探查待指派节点的候选审批人名单：只打开下拉收集文本，不选中、不改动环境。 */
async function peekAssignCandidates(page: Page, box: Locator): Promise<string[]> {
  if (!(await box.isVisible().catch(() => false))) return [];
  await box.click();
  await waitForTrue(page, async () => (await page.locator(APPROVAL_OPTION_SELECTOR).count()) > 0, 4_000);
  const texts = (await page.locator(APPROVAL_OPTION_SELECTOR).allInnerTexts().catch(() => [] as string[]))
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  await dismissPermissionDropdown(page);
  return texts;
}

/** 待指派节点选中计划审批人后，节点应回显该用户名或其昵称（候选展示形态因版本而异）。 */
async function expectNodeShows(
  page: Page,
  node: Extract<ApprovalNode, { kind: '待指派' }>,
  aliases: string[],
): Promise<void> {
  const displayPattern = new RegExp('(' + aliases.map(escapeRegExp).join('|') + ')');
  await expect.poll(async () => {
    const input = node.box.locator('input').first();
    return (await input.inputValue().catch(() => '')) + ' ' + (await node.box.innerText().catch(() => ''));
  }, { timeout: 5_000 }).toMatch(displayPattern);
}

/**
 * 解析并指派申请弹窗的审批节点，返回实际审批序列（登录用户名，按节点顺序）。
 * 用户型固定节点若属计划账号则计入序列，否则闭环无法承接——只读探查角色型节点
 * 候选名单作为精确前置证据，按环境前置不足 skip（不提交、不留悬挂申请）。
 */
async function assignApprovalNodes(page: Page, layer: Locator, plan: PermissionIdentity[]): Promise<string[]> {
  const aliasToUser = approvalAliasesOf(plan);
  const nodes = await collectApprovalNodes(layer);
  const sequence: string[] = [];
  const candidateReport: string[] = [];
  let blockedBy: string | undefined;

  for (const node of nodes) {
    if (node.kind === '固定用户') {
      const mapped = aliasToUser.get(node.displayName);
      if (mapped) sequence.push(mapped);
      else if (blockedBy === undefined) blockedBy = node.displayName + '（' + node.rowText + '）';
      continue;
    }
    if (blockedBy !== undefined) {
      const candidates = await peekAssignCandidates(page, node.box);
      candidateReport.push('候选=[' + candidates.join('、') + ']');
      continue;
    }
    if (sequence.length >= plan.length) continue;
    const identity = plan[sequence.length];
    const aliases = [identity.userName, identity.nickname]
      .filter((item, index, all) => Boolean(item) && all.indexOf(item) === index);
    await node.box.click();
    await waitForTrue(page, async () => (await page.locator(APPROVAL_OPTION_SELECTOR).count()) > 0, 4_000);
    const aliasPattern = new RegExp(aliases.map(escapeRegExp).join('|'));
    // 候选接口返回后选项 DOM 才逐步挂载：6 秒窗口内轮询可见匹配，耗尽仍无才定性失败。
    let option: Locator | undefined;
    const optionDeadline = Date.now() + 6_000;
    while (!(option = await firstVisibleMatching(
      page.locator(APPROVAL_OPTION_SELECTOR).filter({ hasText: aliasPattern }),
    ))) {
      if (Date.now() > optionDeadline) break;
      await page.waitForTimeout(300);
    }
    if (!option) {
      const candidates = (await page.locator(APPROVAL_OPTION_SELECTOR).allInnerTexts().catch(() => [] as string[]))
        .map((item) => item.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      await dismissPermissionDropdown(page);
      throw new Error(
        '审批节点候选列表中未找到计划审批人 ' + identity.userName + '；实测候选=[' + candidates.join('、')
          + ']（flash 验证点：确认该用户是当前节点配置角色的成员，或调整环境审批流配置）。',
      );
    }
    await option.click();
    await expectNodeShows(page, node, aliases);
    sequence.push(identity.userName);
  }

  if (blockedBy !== undefined) {
    skipForMissingEnvironment(
      '审批流最早的节点固定为非计划审批人 ' + blockedBy + '：申请会停在该固定用户的“我的审批”，'
        + '计划账号无法承接该节点，闭环在本环境无法完成。角色型节点候选只读探查：'
        + (candidateReport.join('；') || '无待指派节点')
        + '。需环境将表权限审批流配置为计划账号/其角色成员，或提供固定审批人账号后回归。',
    );
  }
  await dismissPermissionDropdown(page);
  return sequence;
}

/**
 * 申请人发起表权限申请（数据地图-表查询 → 申请权限弹窗）。
 * 申请原因=marker（本轮唯一键）；确保勾选“使用”；按 plan 逐级指派审批人并提交，
 * 返回实际审批序列（登录用户名）。口径与 SM-02-01 submitTableApply 一致。
 */
export async function submitTablePermissionApply(
  page: Page,
  options: { tableName: string; marker: string; approvalPlan: PermissionIdentity[] },
): Promise<string[]> {
  const card = await openTableQueryCard(page, options.tableName);
  if (!card) {
    skipForMissingEnvironment(
      '申请人在数据地图-表查询中搜不到目标表 ' + options.tableName
        + '；请检查 DATA_PERMISSION_TABLE 是否为已上线且元数据完整的测试表。',
    );
  }
  const icon = card.locator(
    '[aria-label="图标: safety-certificate"], [aria-label*="safety-certificate" i], [aria-label*="权限"], [title*="权限"]',
  ).first();
  if (await icon.isVisible().catch(() => false)) {
    await icon.click();
  } else {
    const name = card.locator('.table-name:visible, [class*="table-name"]:visible').first();
    await name.click();
    await page.waitForTimeout(400);
    const applyButton = page.getByRole('button', { name: /申请权限/ }).first();
    if (await applyButton.isVisible().catch(() => false)) {
      await applyButton.click();
    } else {
      skipForMissingEnvironment(
        '目标表 ' + options.tableName + ' 的卡片与详情页均未见“申请权限”入口：可能申请人已持有该表权限'
          + '（请更换 DATA_PERMISSION_TABLE），或页面结构已变化（flash 验证点：卡片操作区实现）。',
      );
    }
  }
  const layer = visibleLayer(page);
  await expect(layer).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/申请表|申请权限/).first()).toBeVisible();
  const labelledBox = layer.getByRole('textbox', { name: /申请原因|申请说明|申请理由|备注/ }).first();
  let reasonBox: Locator | undefined = await labelledBox.isVisible().catch(() => false) ? labelledBox : undefined;
  if (!reasonBox) reasonBox = await firstVisibleMatching(layer.locator('textarea:visible'));
  if (!reasonBox) {
    const layerText = (await layer.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error('申请弹窗未找到“申请原因”输入框（flash 验证点）：弹窗文本=' + layerText);
  }
  await reasonBox.fill(options.marker);
  const useFlag = layer.locator('[type="checkbox"], .el-checkbox, .ant-checkbox').filter({ hasText: /使用/ }).first();
  if (await useFlag.isVisible().catch(() => false)) {
    const inner = useFlag.locator('input[type="checkbox"]').first();
    const checked = await inner.isChecked().catch(() => true);
    if (!checked) await useFlag.click();
  }
  const sequence = await assignApprovalNodes(page, layer, options.approvalPlan);
  if (sequence.length < 2) {
    skipForMissingEnvironment(
      '当前表权限审批流可指派的审批节点不足 2 级（实测 ' + sequence.length
        + ' 级）；多级审批需先在环境为表权限审批流配置两级及以上可选审批节点。',
    );
  }
  const submit = layer.getByRole('button', { name: /提\s*交|确\s*定/ }).last();
  await expect(submit).toBeVisible();
  const blocked = page.getByText(/未指定审批人|请补全/).first();
  try {
    await submit.click({ timeout: 10_000 });
  } catch {
    if (await blocked.isVisible().catch(() => false)) {
      throw new Error('提交被表单校验拦截：' + (await blocked.innerText().catch(() => '')));
    }
    await page.waitForTimeout(3_000);
    if (await layer.isVisible().catch(() => false)) {
      const retrySubmit = layer.getByRole('button', { name: /提\s*交|确\s*定/ }).last();
      if (!(await retrySubmit.isDisabled().catch(() => false))) {
        await retrySubmit.click({ timeout: 10_000 });
      }
    }
  }
  // 关层与拦截提示二选一为完成信号；提示文案未录制（flash 校准点），按通用词兜底。
  await expect.poll(async () => {
    if (await blocked.isVisible().catch(() => false)) return 'blocked';
    return (await layer.isVisible().catch(() => false)) ? 'open' : 'closed';
  }, { timeout: 15_000 }).toBe('closed');
  await expect(successNotice(page, /成功|提交|申请/)).toBeVisible({ timeout: 5_000 }).catch(() => undefined);
  return sequence;
}

/**
 * 指定审批人处理待审批申请（同意/拒绝）：进入“我的审批-未审批”定位 marker 行
 * → 点击对应操作 → 确认弹窗（意见可选）→ 等待成功提示。
 * 找不到待办返回 false（由调用方定性“节点归属与指派不一致”）。
 */
export async function handlePendingApproval(
  page: Page,
  identity: PermissionIdentity,
  marker: string,
  action: '同意' | '拒绝',
): Promise<boolean> {
  await openApprovalWorkbenchAs(page, identity, '我的审批');
  const row = await findApprovalMarkerRow(page, '未审批', marker);
  if (!row) return false;
  const actionPattern = action === '同意' ? /同\s*意/ : /拒\s*绝/;
  const actionButton = row.getByRole('button', { name: actionPattern }).first();
  if (await actionButton.isVisible().catch(() => false)) {
    await actionButton.click();
  } else {
    const actionText = row.getByText(actionPattern).first();
    await expect(actionText).toBeVisible({ timeout: 5_000 });
    await actionText.click();
  }
  const layer = visibleLayer(page);
  const confirmScope = (await layer.isVisible().catch(() => false)) ? layer : page;
  const opinion = confirmScope.locator('textarea:visible').first();
  if (await opinion.isVisible().catch(() => false)) {
    await opinion.fill(action + ' ' + marker);
  }
  const confirmButton = confirmScope.getByRole('button', { name: /^确\s*定$/ }).last();
  if (await confirmButton.isVisible().catch(() => false)) {
    await confirmButton.click();
  }
  await expect(successNotice(page, new RegExp('(?:' + action + '|操作|审批).*成功')))
    .toBeVisible({ timeout: 10_000 });
  return true;
}

/**
 * 申请人撤销待审批申请：进入“我的申请-未审批”定位 marker 行 → 撤销 → 确认
 * （意见可选，有则填“撤销 marker”）→ 等待成功提示。终态由
 * expectApplicationFinalStatus 负责（已审批页签出现“已撤销”）。
 */
export async function revokeApplicationAsApplicant(
  page: Page,
  applicant: PermissionIdentity,
  marker: string,
): Promise<void> {
  await openApprovalWorkbenchAs(page, applicant, '我的申请');
  const row = await findApprovalMarkerRow(page, '未审批', marker);
  if (!row) {
    throw new Error('我的申请-未审批 未找到待撤销申请 ' + marker + '：撤销动作只允许命中本轮唯一申请。');
  }
  const button = row.getByRole('button', { name: /撤\s*销/ }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
  } else {
    const text = row.getByText(/撤\s*销/).first();
    await expect(text).toBeVisible({ timeout: 5_000 });
    await text.click();
  }
  const layer = visibleLayer(page);
  const confirmScope = (await layer.isVisible().catch(() => false)) ? layer : page;
  const opinion = confirmScope.locator('textarea:visible').first();
  if (await opinion.isVisible().catch(() => false)) {
    await opinion.fill('撤销 ' + marker);
  }
  const confirmButton = confirmScope.getByRole('button', { name: /^确\s*定$/ }).last();
  if (await confirmButton.isVisible().catch(() => false)) {
    await confirmButton.click();
  }
  await expect(successNotice(page, /成功/)).toBeVisible({ timeout: 10_000 });
}

/** 我的申请-已审批 中核对申请终态：行必须存在且状态文本匹配（已通过/已撤销/已驳回…）。 */
export async function expectApplicationFinalStatus(
  page: Page,
  applicant: PermissionIdentity,
  marker: string,
  statusPattern: RegExp,
  expectedLabel: string,
): Promise<void> {
  await openApprovalWorkbenchAs(page, applicant, '我的申请');
  const row = await findApprovalMarkerRow(page, '已审批', marker);
  if (!row) {
    throw new Error('我的申请-已审批 未找到本申请 ' + marker + '：流程可能未走完或列表结构变化。');
  }
  const rowText = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ');
  if (!statusPattern.test(rowText)) {
    throw new Error('申请 ' + marker + ' 最终状态应为“' + expectedLabel + '”，实际行文本：' + rowText);
  }
}

/**
 * 数据权限双视角核验与归因前置所需的管理员身份：TEST_USER/TEST_PASS。
 * 昵称留空：管理员的展示名与账号无固定映射，loginAs 的身份断言交由
 * loginWithCredentials 自身的登录就绪校验兜底，真正的核验在数据权限页断言。
 */
export function requireAdminIdentity(): PermissionIdentity {
  const userName = (process.env.TEST_USER ?? '').trim();
  const password = process.env.TEST_PASS ?? '';
  if (!userName || !password) {
    skipForMissingEnvironment('数据权限双视角核验与前置归因需要管理员账号：未设置 TEST_USER/TEST_PASS。');
  }
  return {
    userName,
    nickname: '',
    password,
    phone: '',
    email: '',
  };
}
