/**
 * 系统管理 → 用户权限 → 数据权限 页面级公共工具（数据权限闭环专用）。
 *
 * 抽取来源与依据：
 *   - 旧用例 `SM-03-01/SM-03-02`：页面无标准 tab 语义，“用户视角/资源视角、
 *     成员/角色/部门、数据源/数据表/数据服务 API”均为普通可点击文本节点；
 *     资源视角未选中资源时“新建权限”禁用；资源筛选框为“过滤当前数据源列表”。
 *   - `权限测试工具.ts`：`openSystemPage` 的系统管理 hash 直达 + 侧栏展开逻辑。
 *   - 业务模型复核 `glm5.3-01-业务模型结果.md`：数据源权限只承载“管理”（kind=2）；
 *     数据表权限“使用/管理”独立（kind=5）；未选明细会落库为全量授权（全 NULL
 *     通配），因此工具一律按“固定 · 勾选”选择具体资源，防止误写全量授权。
 *   - 录制稿（DS-02-01 尾段）：新建权限弹窗含 数据源类型/数据源（固定·勾选/
 *     动态·全部开关）/管理/权限截止时间（永久/自定义）。
 *   - 29F 分页实证（run-20260915-144834-286 等四轮同型失败，SM-03-05 记录）：
 *     固化主体的权限列表可被历史授权累积到“总共50条”（每页 10 条、共 5 页），
 *     单页检索会把“行不在第 1 页”误报为“未回显”；因此提供
 *     openPermissionTableMaxPageSize / resetPermissionTableToFirstPage /
 *     findPermissionRowAcrossPages / queryUserViewPermissionRowAcrossPages
 *     跨页工具（自 SM-03-05 的用例内实现回流共享层）。
 *
 * 环境变量（均可用代码内显式参数覆盖）：
 *   - DATA_PERMISSION_SOURCE_TYPE：数据源类型，默认 MYSQL。
 *   - DATA_PERMISSION_SOURCE_NAME / EXPORT_SOURCE_NAME：数据源展示名，
 *     默认 192.168.76.110:13306/e2e_test。
 *   - DATA_PERMISSION_DATABASE / DATA_PERMISSION_SCHEMA：数据库与 Schema，
 *     默认 e2e_test。
 *   - DATA_PERMISSION_TABLE：数据表权限闭环专用表（无稳定默认值；缺失时
 *     显式报错，绝不随机挑选共享表）。
 *
 * 约束：全部为浏览器页面操作（无 fetch/axios）；本文件只提供页面级 helper，
 * 不写测试断言本体、不硬编码通过；控件形态与录制/模型不一致时抛出带上下文
 * 的明确错误，由调用用例决定失败原因归类。
 */
import { expect, Locator, Page, type Response } from '@playwright/test';
import { openSystemPage } from './权限测试工具.js';
import { expectSuccess, visible, visibleDialog } from '../抽样用例工具.js';

/** 数据权限页的两个视角页签（页面为普通文本节点，非语义 tab）。 */
export type PermissionViewName = '用户视角' | '资源视角';

/** 用户视角下的主体页签：成员/角色/部门（对应后端 subjectType USER/ROLE/DEPT）。 */
export type UserViewSubjectTab = '成员' | '角色' | '部门';

/** 资源视角下的资源范围页签；“数据服务 API”独立于 df_data_permission 体系。 */
export type ResourceViewScopeTab = '数据源' | '数据表' | '数据服务 API';

/** 数据权限类型（页面文案与后端 permissionList 的中文字符串一致）。 */
export type DataPermissionTypeFlag = '使用' | '管理';

/** 权限截止时间：永久，或自定义时间点（yyyy-MM-dd HH:mm:ss）。 */
export type PermissionExpiryMode = '永久' | { customTime: string };

/** MySQL 110 测试资源夹具：闭环用例统一从这里取值，避免各 spec 自造脏数据。 */
export interface MysqlPermissionResource {
  /** 数据源类型（第一级下拉），默认 MYSQL。 */
  sourceTypeName: string;
  /** 数据源展示名，例如 192.168.76.110:13306/e2e_test。 */
  sourceName: string;
  /** 数据库名，例如 e2e_test。 */
  databaseName: string;
  /** Schema 名，例如 e2e_test。 */
  schemaName: string;
  /** 数据表权限闭环专用表；数据源权限（kind=2）无需填写。 */
  tableName?: string;
}

/** Ant/Element 双兼容的可见下拉选项选择器。 */
const PERMISSION_OPTION_SELECTOR = [
  '.ant-select-dropdown:visible .ant-select-item-option',
  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
  '.el-select-dropdown:visible .el-select-dropdown__item',
  '[role="listbox"]:visible [role="option"]',
  'li[role="option"]:visible',
].join(', ');

/** 行内图标操作兜底选择器（编辑/删除在部分版本是纯图标按钮）。 */
const ROW_ACTION_ICON_SELECTORS = {
  编辑: '[aria-label*="edit" i]:visible, [aria-label*="编辑"]:visible, .anticon-edit:visible, [class*="icon-edit"]:visible',
  删除: '[aria-label*="delete" i]:visible, [aria-label*="删除"]:visible, .anticon-delete:visible, [class*="icon-delete"]:visible',
} as const;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 返回 locator 中第一个可见元素（自上而下），与旧用例 firstVisibleMatching 语义一致。 */
async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

/** 解析 MySQL 110 测试资源：显式参数 > 环境变量 > 湖南中行公共默认值。 */
export function resolveMysqlPermissionResource(
  overrides: Partial<MysqlPermissionResource> = {},
): MysqlPermissionResource {
  const sourceTypeName = overrides.sourceTypeName
    ?? process.env.DATA_PERMISSION_SOURCE_TYPE
    ?? 'MYSQL';
  const sourceName = overrides.sourceName
    ?? process.env.DATA_PERMISSION_SOURCE_NAME
    ?? process.env.EXPORT_SOURCE_NAME
    ?? '192.168.76.110:13306/e2e_test';
  const databaseName = overrides.databaseName
    ?? process.env.DATA_PERMISSION_DATABASE
    ?? 'e2e_test';
  const schemaName = overrides.schemaName
    ?? process.env.DATA_PERMISSION_SCHEMA
    ?? databaseName;
  const tableName = overrides.tableName ?? process.env.DATA_PERMISSION_TABLE;
  return tableName
    ? { sourceTypeName, sourceName, databaseName, schemaName, tableName }
    : { sourceTypeName, sourceName, databaseName, schemaName };
}

/** 数据表权限闭环必须有专用表；缺失时显式失败，不猜测、不随机选表。 */
export function requirePermissionTableName(resource: MysqlPermissionResource): string {
  if (!resource.tableName) {
    throw new Error(
      '数据表权限闭环需要专用测试表：请设置环境变量 DATA_PERMISSION_TABLE 或显式传入 resource.tableName；'
        + '工具不会随机选择共享表或历史业务表。',
    );
  }
  return resource.tableName;
}

/**
 * 关闭下拉/日期浮层：Element/Ant 下拉在选中后可能仍停留在页面并遮挡确认按钮。
 * 与 权限测试工具.chooseVisibleOrganization 的逐层收起策略一致。
 */
export async function dismissPermissionDropdown(page: Page): Promise<void> {
  // 关闭方式严禁使用 Escape：110 环境的申请/权限弹窗均为 Ant Modal，实测
  // （run-20260920-222301 与 run-20260920-224318 两次 trace 网络+动作时间线）
  // Escape 不论下拉处于展开还是“逻辑已关、DOM 尚在”的过渡态，都会冒泡到
  // Modal 把整张弹窗当“取消”关掉——表现为提交按钮 detach 重试超时、提交
  // 请求从未发出、下游审批人“我的审批”为空。改为点击弹窗头部中性区域：
  // 对下拉=外部点击（antd/element 均据此收起下拉），对弹窗=无副作用
  // （头部既非遮罩也非关闭按钮）。
  const openOverlay = page
    .locator(
      [
        '.ant-select-dropdown:visible',
        '.el-select-dropdown:visible',
        '.el-dropdown-menu:visible',
        '.ant-picker-dropdown:visible',
        '.el-picker-panel:visible',
      ].join(', '),
    )
    .first();
  if (!(await openOverlay.isVisible().catch(() => false))) return;
  const neutral = page
    .locator(
      '.ant-modal-header:visible, .el-dialog__header:visible, .ant-drawer-header:visible, .el-drawer__header:visible',
    )
    .first();
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

/**
 * 在当前打开的下拉浮层中选择目标选项：
 *   1. 优先选择文本恰好等于 expected 的可见选项——run-20260915-095931-950
 *      快照实证：数据库候选同时存在 e2e_test 与 e2e_test_tables，旧的
 *      “contains 首个可见命中”会误选 e2e_test_tables，导致后续级联整体
 *      错库（“数据表”下拉列出的是 e2e_test_tables 的表，
 *      e2e_hn_lineage_source_0920 永不出现）；
 *   2. 无精确相等时退回旧的包含匹配，保留其他版本兼容；
 *   3. searchInto 传入已展开的下拉控件时（“数据表”下拉是可搜索 select，
 *      同轮快照 e458 展开后内嵌 active 搜索输入 e463），选项未出现先把
 *      expected 输入搜索框过滤——全量选项超过虚拟渲染窗口时不过滤就
 *      看不到目标行。
 */
export async function choosePermissionOption(
  page: Page,
  expected: string,
  labelForError: string,
  searchInto?: Locator,
): Promise<void> {
  const matcher = new RegExp(escapeRegExp(expected));
  const expectedText = expected.replace(/\s+/g, '');
  const deadline = Date.now() + 8_000;
  let searchTried = false;
  while (Date.now() < deadline) {
    const candidates = page.locator(PERMISSION_OPTION_SELECTOR).filter({ hasText: matcher });
    const count = await candidates.count();
    let exact: Locator | undefined;
    let partial: Locator | undefined;
    for (let index = 0; index < count; index += 1) {
      const item = candidates.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      const text = (await item.innerText().catch(() => '')).replace(/\s+/g, '');
      if (text === expectedText) {
        exact = item;
        break;
      }
      if (!partial) partial = item;
    }
    const chosen = exact ?? partial;
    if (chosen) {
      try {
        await chosen.click({ timeout: 4_000 });
      } catch {
        // Ant Select 单选在点击命中的瞬间就会关闭下拉，选项节点随关闭动画
        // 离屏，默认稳定性检查会一直报 not stable / not visible 直至超时
        //（run-20260920-182931-631：选项 aria-selected 已为 true 但 click
        // 重试全程不可见——点击其实已生效）。此时选项已带选中态即视为成功；
        // 未带选中态则补一次 force 点击，仍失败交由调用方的回显断言暴露。
        const cls = (await chosen.getAttribute('class').catch(() => '')) || '';
        const selected = (await chosen.getAttribute('aria-selected').catch(() => null)) === 'true'
          || cls.includes('-selected');
        if (!selected) await chosen.click({ force: true, timeout: 2_000 }).catch(() => undefined);
      }
      await page.waitForTimeout(250);
      return;
    }
    if (searchInto && !searchTried) {
      searchTried = true;
      const searchInput = searchInto.locator('input:visible').last();
      if (await searchInput.count()) {
        await searchInput.fill(expected).catch(() => undefined);
        await page.waitForTimeout(400);
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `下拉“${labelForError}”未出现包含“${expected}”的可见选项`
      + `${searchInto ? '（已尝试在下拉搜索框输入关键字过滤）' : ''}，当前页面：${page.url()}`,
  );
}

/**
 * 点击数据权限页的页签节点。页面无标准 tab 语义（理解文档 §2.2），先按语义
 * tab 兼容查找，再退回精确文本节点；均不可见时轮询后明确失败。
 */
async function clickDataPermissionTabNode(page: Page, name: string): Promise<Locator> {
  const escaped = escapeRegExp(name);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidates = [
      page
        .locator('[role="tab"]:visible, .ant-tabs-tab:visible, .el-tabs__item:visible')
        .filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) }),
      page.getByRole('tab', { name, exact: true }),
      page.getByText(name, { exact: true }),
    ];
    for (const candidate of candidates) {
      const node = await firstVisible(candidate);
      if (node) {
        await node.click();
        return node;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`数据权限页面未找到可点击的“${name}”页签（已检查可见页签文本与“更多”外候选），当前页面：${page.url()}`);
}

/** 进入 系统管理 → 用户权限 → 数据权限 页面（复用 openSystemPage 的侧栏展开逻辑）。 */
export async function openDataPermissionPage(page: Page): Promise<void> {
  await openSystemPage(page, '#/systemManage/userPermission/dataPermission');
  await expect.poll(() => page.url(), { timeout: 20_000 }).toContain('/systemManage/userPermission/dataPermission');
  await expect
    .poll(
      async () =>
        (await firstVisible(page.getByRole('button', { name: /新建权限/ }))) !== undefined
        || (await firstVisible(page.getByText('用户视角', { exact: true }))) !== undefined
        || (await firstVisible(page.getByText('资源视角', { exact: true }))) !== undefined,
      { timeout: 30_000, message: '数据权限页面未出现“新建权限/用户视角/资源视角”任一内容' },
    )
    .toBe(true);
}

/** 切换 用户视角 / 资源视角。 */
export async function switchPermissionView(page: Page, view: PermissionViewName): Promise<void> {
  const node = await clickDataPermissionTabNode(page, view);
  const selected = await node.getAttribute('aria-selected').catch(() => null);
  if (selected !== null) await expect(node).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('body')).toContainText(view);
  await page.waitForTimeout(500);
}

/** 切换用户视角下的主体页签：成员 / 角色 / 部门。 */
export async function switchUserViewSubjectTab(page: Page, tab: UserViewSubjectTab): Promise<void> {
  const node = await clickDataPermissionTabNode(page, tab);
  const selected = await node.getAttribute('aria-selected').catch(() => null);
  if (selected !== null) await expect(node).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('body')).toContainText(tab);
  await page.waitForTimeout(400);
}

/** 切换资源视角下的资源范围页签：数据源 / 数据表 / 数据服务 API。 */
export async function switchResourceViewScopeTab(page: Page, tab: ResourceViewScopeTab): Promise<void> {
  const node = await clickDataPermissionTabNode(page, tab);
  const selected = await node.getAttribute('aria-selected').catch(() => null);
  if (selected !== null) await expect(node).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('body')).toContainText(tab);
  await page.waitForTimeout(400);
}

/** 在 timeoutMs 内等待任一文本可见，返回其 Locator（主体名/昵称双候选）。 */
async function waitAnyVisibleText(page: Page, texts: string[], timeoutMs: number): Promise<Locator | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const text of texts) {
      const nodes = page.getByText(text);
      const count = await nodes.count();
      for (let index = count - 1; index >= 0; index -= 1) {
        const node = nodes.nth(index);
        if (await node.isVisible().catch(() => false)) return node;
      }
    }
    await page.waitForTimeout(250);
  }
  return undefined;
}

/** 按占位符/aria-label 查找主体面板搜索框（成员列表分页或远程搜索时使用）。 */
async function findSubjectSearchBox(page: Page): Promise<Locator | undefined> {
  const boxes = page.locator('input:visible');
  const count = await boxes.count();
  for (let index = 0; index < count; index += 1) {
    const box = boxes.nth(index);
    const placeholder = await box.getAttribute('placeholder').catch(() => null);
    const ariaLabel = await box.getAttribute('aria-label').catch(() => null);
    if (/用户名|成员|角色名|部门名|主体|搜索|名称/.test(`${placeholder ?? ''}${ariaLabel ?? ''}`)) {
      return box;
    }
  }
  return undefined;
}

/**
 * 选中主体后的信号校验：与资源视角一致的页面规则——未选中主体/资源时
 * “新建权限”禁用（SM-03-02 已确认资源视角规则；用户视角若版本不同会在
 * 此处明确失败并提示校准，不做静默放行）。
 */
async function verifyUserViewSubjectSelected(page: Page, subjectName: string): Promise<void> {
  const create = page.getByRole('button', { name: /新建权限/ }).last();
  await expect
    .poll(async () => create.isEnabled().catch(() => false), {
      timeout: 10_000,
      message: `选中主体“${subjectName}”后“新建权限”仍未启用（若当前版本未选中主体也允许新建，请按实际页面校准本断言）`,
    })
    .toBe(true);
}

/**
 * 用户视角选择主体（成员/角色/部门）。优先直接点击列表中的主体名（本轮唯一
 * 值），找不到时尝试主体搜索框缩小范围后重试；均失败时明确报错，不猜主体。
 */
export async function selectUserViewSubject(
  page: Page,
  options: { subjectTab: UserViewSubjectTab; subjectName: string; subjectAlias?: string },
): Promise<void> {
  await switchPermissionView(page, '用户视角');
  await switchUserViewSubjectTab(page, options.subjectTab);
  const names = [options.subjectName, options.subjectAlias].filter((item): item is string => Boolean(item));

  const direct = await waitAnyVisibleText(page, names, 6_000);
  if (direct) {
    await direct.click();
    await verifyUserViewSubjectSelected(page, options.subjectName);
    return;
  }

  const searchBox = await findSubjectSearchBox(page);
  if (searchBox) {
    await searchBox.fill(options.subjectName);
    await page.waitForTimeout(600);
    const filtered = await waitAnyVisibleText(page, names, 8_000);
    if (filtered) {
      await filtered.click();
      await verifyUserViewSubjectSelected(page, options.subjectName);
      return;
    }
  }
  throw new Error(
    `用户视角“${options.subjectTab}”列表未找到主体“${options.subjectName}”；`
      + `请确认账号/角色已创建并加入当前组织，当前页面：${page.url()}`,
  );
}

/** 打开用户视角“新建权限”弹窗，返回弹窗 Locator。 */
export async function openUserViewCreateDialog(page: Page): Promise<Locator> {
  const create = page.getByRole('button', { name: /新建权限/ }).last();
  await expect
    .poll(async () => create.isEnabled().catch(() => false), {
      timeout: 10_000,
      message: '用户视角“新建权限”按钮不可用：请确认已先选中主体（成员/角色）。',
    })
    .toBe(true);
  await create.click();
  const dialog = await visibleDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * 在 scope（弹窗或页面主体）内按“标签文本 → 上溯找下拉框”定位选择控件，
 * 兜底按占位符定位（录制稿中数据源下拉占位符为“请选择数据源”）。
 * 仅定位并返回控件，不负责展开；找不到时抛出明确错误。
 * maxUpwalkLevels 限制标签上溯层数：run-20260914-161254-834 快照确认弹窗
 * 级联为“标签文本节点 + 控件容器”的兄弟结构（e451→e452/e456），上溯 1~2
 * 层内必命中下拉；资源视角页签文本（如“数据表”）与级联标签同名，但页签
 * 节点上溯 2 层内不含下拉，限深可避免误取页签祖先容器里的其他下拉框。
 */
async function locatePermissionSelectByLabel(
  scope: Locator,
  labelCandidates: RegExp[],
  placeholderPattern: RegExp,
  labelForError: string,
  maxUpwalkLevels = 6,
): Promise<Locator> {
  for (const label of labelCandidates) {
    const labelNode = await firstVisible(scope.getByText(label));
    if (labelNode) {
      let node: Locator = labelNode;
      for (let level = 0; level < maxUpwalkLevels; level += 1) {
        const box = await firstVisible(
          node.locator('.ant-select:visible, .el-select:visible, [role="combobox"]:visible, select:visible'),
        );
        if (box) return box;
        node = node.locator('..');
      }
    }
  }
  const input = await firstVisible(scope.getByPlaceholder(placeholderPattern));
  if (input) {
    let node: Locator = input;
    for (let level = 0; level < 8; level += 1) {
      if ((await node.getAttribute('role').catch(() => null)) === 'combobox') return node;
      const box = await firstVisible(node.locator('.ant-select:visible, .el-select:visible'));
      if (box) return box;
      node = node.locator('..');
    }
  }
  throw new Error(
    `未找到“${labelForError}”下拉控件（已尝试标签 ${labelCandidates.map((item) => item.source).join('、')}`
      + ` 与占位符 ${placeholderPattern.source}），当前页面：${scope.page().url()}`,
  );
}

/** 选择数据源类型（弹窗内第一个 combobox，选项文案含 MYSQL；SM-03-01/02 已确认）。 */
export async function selectPermissionSourceType(
  page: Page,
  dialog: Locator,
  sourceTypeName = 'MYSQL',
): Promise<void> {
  const box = await firstVisible(dialog.getByRole('combobox'));
  if (!box) throw new Error(`权限弹窗未找到“数据源类型”下拉框，当前页面：${page.url()}`);
  await box.click();
  await choosePermissionOption(page, sourceTypeName, `数据源类型（${sourceTypeName}）`);
  await dismissPermissionDropdown(page);
  // 当前前端只将类型值保存在 select 内部，弹窗正文不会回显“MYSQL”。
  // 后续数据源级联能加载并选中才是此处真实的生效证明。
  await page.waitForTimeout(250);
}

/**
 * 以“固定 · 勾选”模式选择具体数据源（如 192.168.76.110:13306/e2e_test）。
 * 页面用“固定 · 勾选 / 动态 · 全部”开关区分是否落库具体资源明细（glm5.3-01
 * §1.3：动态=范围留空=全量通配授权），闭环用例必须固定勾选，防止误写全量授权。
 */
export async function selectPermissionSource(
  page: Page,
  dialog: Locator,
  resource: MysqlPermissionResource,
): Promise<void> {
  const fixedHint = await firstVisible(dialog.getByText(/固\s*定/));
  if (fixedHint) {
    await fixedHint.click();
    await page.waitForTimeout(300);
  }
  let box: Locator | undefined;
  try {
    box = await locatePermissionSelectByLabel(dialog, [/^数据源$/], /请选择数据源/, '数据源');
  } catch {
    // “固定”文案点击未生效（开关形态）时切换一次作用域开关再定位；
    // 仍找不到则说明页面结构与模型/录制不符，交由下方二次定位抛出明确错误。
    const scopeSwitch = await firstVisible(dialog.getByRole('switch'));
    if (!scopeSwitch) {
      throw new Error(`权限弹窗未找到“数据源”选择控件（固定/动态开关亦不存在），当前页面：${page.url()}`);
    }
    await scopeSwitch.click();
    await page.waitForTimeout(300);
    box = await locatePermissionSelectByLabel(dialog, [/^数据源$/], /请选择数据源/, '数据源');
  }
  await box.click();
  await choosePermissionOption(page, resource.sourceName, `数据源（${resource.sourceName}）`);
  await dismissPermissionDropdown(page);
  const echoFragment = resource.sourceName.split(/[:：/]/)[0];
  await expect
    .poll(async () => dialog.innerText().catch(() => ''), {
      timeout: 5_000,
      message: `数据源选择“${resource.sourceName}”后未回填`,
    })
    .toContain(echoFragment);
}

/** 数据库 → Schema → 表 三级级联的字段候选（与数据服务五级链路的后三级一致）。 */
function tableCascadeLevels(resource: MysqlPermissionResource): Array<{
  labels: RegExp[];
  placeholder: RegExp;
  value: string;
  name: string;
}> {
  const tableName = requirePermissionTableName(resource);
  return [
    { labels: [/^数据库/, /^库名/], placeholder: /数据库|库/, value: resource.databaseName, name: '数据库' },
    { labels: [/^Schema$/i, /^模式$/], placeholder: /[Ss]chema|模式/, value: resource.schemaName, name: 'Schema' },
    // run-20260914-161254-834 快照确认：弹窗第三级标签为“数据表”、占位文本
    // “请选择数据表”（span 文本而非 input placeholder，占位符兜底不会命中，
    // 必须命中标签路径）。旧候选 /^表名?$/ 与页面不符，是 SM-03-06 阶段2 的
    // 直接失败原因；保留旧候选作为其他版本兜底。
    { labels: [/^数据表$/, /^表名?$/], placeholder: /请选择数据表|数据表|表名?/, value: tableName, name: '数据表' },
  ];
}

/**
 * 数据表权限的来源级联选择：数据源类型 → 数据源（固定勾选）→ 数据库 →
 * Schema → 专用表。表级联控件未见录制稿确认，按通用标签/占位符定位，
 * 找不到时显式失败，交由页面探查（子任务05）校准。
 */
export async function selectPermissionTableScope(
  page: Page,
  dialog: Locator,
  resource: MysqlPermissionResource,
): Promise<void> {
  await selectPermissionSourceType(page, dialog, resource.sourceTypeName);
  await selectPermissionSource(page, dialog, resource);
  for (const level of tableCascadeLevels(resource)) {
    // 选择上级资源后，当前版本异步插入下一级（数据库/Schema/表）控件；
    // 不能在同一个渲染 tick 内就判定“控件不存在”。
    let box: Locator | undefined;
    const deadline = Date.now() + 8_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        box = await locatePermissionSelectByLabel(dialog, level.labels, level.placeholder, level.name);
        break;
      } catch (error) {
        lastError = error;
        await page.waitForTimeout(300);
      }
    }
    if (!box) throw lastError;
    const levelBox = box;
    await levelBox.click();
    // “数据表”下拉是可搜索 select（run-20260915-095931-950 快照 e458/e463）：
    // 全量选项超过虚拟渲染窗口时必须输入关键字过滤才可见；数据库/Schema
    // 列表短，通常精确命中即返回，不会走到输入搜索这一步。
    await choosePermissionOption(page, level.value, `${level.name}（${level.value}）`, levelBox);
    await dismissPermissionDropdown(page);
    // 回填断言必须按“控件内完整文本节点相等”核对：数据库候选里 e2e_test 与
    // e2e_test_tables 并存，弹窗整页 innerText 的 contains 判定会被
    // e2e_test_tables 子串满足而放过选错库（同轮快照 e404 选中值实证）。
    await expect
      .poll(async () => (await levelBox.getByText(level.value, { exact: true }).count()) > 0, {
        timeout: 5_000,
        message: `${level.name}选择“${level.value}”后未回填（下拉控件内未见该值的完整文本节点）`,
      })
      .toBe(true);
  }
}

/**
 * 将某一权限类型（使用/管理）勾选为指定状态。兼容三种控件形态：
 * 原生 checkbox（Element/Ant 均把 change 绑定在 label 上）、语义
 * checkbox/switch（读 aria-checked 或 checked class）。均未识别时点击
 * 文本本身；真实生效与否由保存后的列表回显断言兜底，不在本函数伪造成功。
 */
export async function setPermissionTypeState(
  page: Page,
  dialog: Locator,
  type: DataPermissionTypeFlag,
  checked: boolean,
): Promise<void> {
  const label = await firstVisible(dialog.getByText(type, { exact: true }));
  if (!label) {
    throw new Error(
      `权限弹窗未找到权限类型“${type}”的控件；当前页面可能不提供该权限类型，不能伪造成已配置。当前页面：${page.url()}`,
    );
  }
  let scope: Locator = label;
  for (let level = 0; level < 6; level += 1) {
    const native = scope.locator('input[type="checkbox"]').first();
    if (await native.count()) {
      if ((await native.isChecked().catch(() => false)) !== checked) {
        const wrapper = native.locator('xpath=ancestor::label[1]').first();
        if (await wrapper.count()) await wrapper.click({ force: true });
        else await native.setChecked(checked, { force: true });
      }
      await expect
        .poll(async () => native.isChecked().catch(() => false), {
          timeout: 5_000,
          message: `权限类型“${type}”未能${checked ? '勾选' : '取消勾选'}`,
        })
        .toBe(checked);
      return;
    }
    const semantic = scope.locator('[role="checkbox"], [role="switch"]').first();
    if (await semantic.count()) {
      const readState = async () => {
        if ((await semantic.getAttribute('aria-checked').catch(() => null)) === 'true') return true;
        const className = await semantic.getAttribute('class').catch(() => null);
        return className !== null && className.includes('checked');
      };
      if ((await readState()) !== checked) await semantic.click();
      await expect
        .poll(readState, {
          timeout: 5_000,
          message: `权限类型“${type}”未能${checked ? '勾选' : '取消勾选'}（语义控件）`,
        })
        .toBe(checked);
      return;
    }
    scope = scope.locator('..');
  }
  await label.click();
  await page.waitForTimeout(300);
}

/**
 * 设定权限类型组合：要求的类型必须存在并勾选；未要求的类型若控件存在则取消
 * 勾选（后端以 permissionList 整体覆盖保存，漏取消会残留授权）。未渲染的
 * 类型控件跳过（数据源权限弹窗只渲染“管理”，属页面已知形态）。
 */
export async function setPermissionTypes(
  page: Page,
  dialog: Locator,
  types: DataPermissionTypeFlag[],
): Promise<void> {
  const flags: DataPermissionTypeFlag[] = ['使用', '管理'];
  for (const flag of flags) {
    const wanted = types.includes(flag);
    const label = await firstVisible(dialog.getByText(flag, { exact: true }));
    if (!label) {
      if (wanted) {
        throw new Error(`权限弹窗未找到权限类型“${flag}”的控件，不能伪造成已勾选；当前页面：${page.url()}`);
      }
      continue;
    }
    await setPermissionTypeState(page, dialog, flag, wanted);
  }
}

/** 设定权限截止时间：永久，或自定义时间点（yyyy-MM-dd HH:mm:ss）。 */
export async function setPermissionExpiry(
  page: Page,
  dialog: Locator,
  mode: PermissionExpiryMode,
): Promise<void> {
  if (mode === '永久') {
    const option = await firstVisible(dialog.getByText(/永\s*久/));
    if (!option) throw new Error(`权限弹窗未找到“永久”截止时间选项，当前页面：${page.url()}`);
    await option.click();
    await page.waitForTimeout(300);
    return;
  }
  const custom = await firstVisible(dialog.getByText(/自\s*定\s*义/));
  if (!custom) throw new Error(`权限弹窗未找到“自定义”截止时间选项，当前页面：${page.url()}`);
  await custom.click();
  await page.waitForTimeout(300);
  const input = await firstVisible(dialog.locator(
    'input[placeholder*="时间"]:visible, input[placeholder*="日期"]:visible, '
      + '.ant-calendar-picker-input:visible, .ant-picker input:visible, .el-date-editor input:visible',
  ));
  if (!input) {
    throw new Error(`选择“自定义”截止时间后未找到时间输入框（期望格式 yyyy-MM-dd HH:mm:ss），当前页面：${page.url()}`);
  }

  // 当前页面是 Ant Design 旧版 CalendarPicker，输入框 readonly，不能 fill/type。
  // 本套件仅需验证“永久 → 自定义”编辑闭环，测试日期固定为近期未来日期，最多跨
  // 一个自然月；若调用者传入远期日期，明确失败而非低效地逐月翻到目标年份。
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(mode.customTime);
  if (!match) {
    throw new Error(`自定义截止时间格式无效：${mode.customTime}（期望 yyyy-MM-dd HH:mm:ss）`);
  }
  const targetYear = Number(match[1]);
  const targetMonth = Number(match[2]);
  const targetDay = Number(match[3]);
  const today = new Date();
  const monthOffset = (targetYear - today.getFullYear()) * 12 + (targetMonth - (today.getMonth() + 1));
  if (monthOffset < 0 || monthOffset > 1) {
    throw new Error(
      `自定义截止时间 ${mode.customTime} 不在当前或下一个自然月；`
        + '权限闭环请使用近期未来日期，避免日历逐月翻页。',
    );
  }
  await input.click({ force: true });
  const calendar = page.locator('.ant-calendar-picker-container:visible, .ant-calendar-dropdown:visible').last();
  await expect(calendar).toBeVisible({ timeout: 5_000 });
  if (monthOffset === 1) {
    const nextMonth = calendar.locator('.ant-calendar-next-month-btn:visible').first();
    await expect(nextMonth).toBeVisible({ timeout: 3_000 });
    await nextMonth.click();
  }
  const dateCells = calendar.locator('.ant-calendar-date:visible');
  let targetCell: Locator | undefined;
  for (let index = 0; index < await dateCells.count(); index += 1) {
    const cell = dateCells.nth(index);
    if ((await cell.innerText().catch(() => '')).trim() !== String(targetDay)) continue;
    const classes = await cell.evaluate((element) => element.parentElement?.className ?? '').catch(() => '');
    if (/last-month|next-month|disabled/i.test(classes)) continue;
    targetCell = cell;
    break;
  }
  if (!targetCell) {
    throw new Error(`自定义截止时间日历未找到可选日期 ${targetYear}-${targetMonth}-${targetDay}`);
  }
  await targetCell.click();
  // 日期型 picker 选中日期会关闭浮层；若版本保留浮层，仅点击浮层内确认，绝不误点权限弹窗确认。
  const calendarConfirm = calendar.locator('.ant-calendar-ok-btn:visible').first();
  if (await calendarConfirm.isVisible().catch(() => false)) await calendarConfirm.click();
  await expect
    .poll(async () => input.inputValue().catch(() => ''), {
      timeout: 5_000,
      message: `自定义截止时间“${mode.customTime}”未回填`,
    })
    .toContain(mode.customTime.slice(0, 10));
}

/**
 * 提交权限弹窗（新建/编辑共用）：点击 确定/保存 → 等弹窗关闭 → 等待成功
 * 通知。弹窗未关闭或无成功通知都会失败，不以猜测判定成功。
 */
export async function submitPermissionDialog(page: Page, dialog: Locator): Promise<void> {
  const confirm = await firstVisible(dialog.getByRole('button', { name: /确\s*定|保\s*存/ }));
  if (!confirm) throw new Error(`权限弹窗未找到“确定/保存”按钮，当前页面：${page.url()}`);
  await confirm.click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expectSuccess(page, /成功/);
  await page.waitForTimeout(500);
}

/** 取消关闭权限弹窗（负向分支使用，如“取消不应产生授权”）。 */
export async function closePermissionDialog(page: Page, dialog: Locator): Promise<void> {
  const cancel = await firstVisible(dialog.getByRole('button', { name: /取\s*消|关\s*闭|Close/ }));
  if (!cancel) throw new Error(`权限弹窗未找到“取消/关闭”按钮，当前页面：${page.url()}`);
  await cancel.click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

/**
 * 主动触发一次权限列表查询/刷新：保存接口返回后列表自动刷新可能早于数据
 * 可见（权限测试工具 createRole 同类问题）。按钮缺失或点击被拦截不视为
 * 失败——列表回显断言由行定位函数承担。
 */
export async function refreshPermissionList(page: Page): Promise<void> {
  const button = await firstVisible(page.getByRole('button', { name: /查\s*询|搜\s*索|刷\s*新/ }));
  if (button) {
    await button.click().catch(() => undefined);
    await page.waitForTimeout(600);
  }
}

/** 由文本节点上溯到所属行容器（tr / el-table__row / ant-table-row / 父节点）。 */
async function rowContainerOf(text: Locator): Promise<Locator | undefined> {
  const candidates = [
    text.locator('xpath=ancestor::tr[1]'),
    text.locator(
      'xpath=ancestor::*[contains(@class,"el-table__row") or contains(@class,"ant-table-row") or @role="row"][1]',
    ),
    text.locator('xpath=parent::*'),
  ];
  for (const row of candidates) {
    if (await row.isVisible().catch(() => false)) return row;
  }
  return undefined;
}

/**
 * 在当前页面按唯一文本定位权限行并返回行容器；超时未找到返回 undefined
 * （调用用例自行区分“应存在而断言失败”与“应消失而通过”）。
 */
export async function findPermissionRow(
  page: Page,
  uniqueText: string,
  timeoutMs = 12_000,
): Promise<Locator | undefined> {
  const deadline = Date.now() + timeoutMs;
  const text = page.getByText(uniqueText);
  while (Date.now() < deadline) {
    const count = await text.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = text.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        const row = await rowContainerOf(candidate);
        if (row) return row;
      }
    }
    await page.waitForTimeout(250);
  }
  return undefined;
}

/**
 * 保存后查询回显（用户视角）：重新选中主体 → 主动刷新列表 → 按资源唯一文本
 * （专用表名或数据源名）定位权限行；未回显时明确失败，不视为通过。
 */
export async function queryUserViewPermissionRow(
  page: Page,
  options: {
    subjectTab: UserViewSubjectTab;
    subjectName: string;
    subjectAlias?: string;
    resource: MysqlPermissionResource;
    timeoutMs?: number;
  },
): Promise<Locator> {
  await selectUserViewSubject(page, options);
  await refreshPermissionList(page);
  const uniqueText = options.resource.tableName ?? options.resource.sourceName;
  const row = await findPermissionRow(page, uniqueText, options.timeoutMs ?? 15_000);
  if (!row) {
    throw new Error(
      `用户视角主体“${options.subjectName}”的权限列表未回显“${uniqueText}”；`
        + '新增/编辑可能未生效，不能视为通过。',
    );
  }
  return row;
}

/**
 * 权限表“N 条/页”档位下拉的档位文本（Element el-pagination sizes 控件）。
 */
const PERMISSION_PAGE_SIZE_LABEL = /^\s*(\d+)\s*条\s*\/\s*页\s*$/;

/** 权限表分页按钮（上一页/下一页；a11y 快照实证为 listitem 结构）。 */
function permissionPagerButton(page: Page, name: RegExp): Locator {
  return page.getByRole('listitem', { name }).first();
}

/** 分页按钮是否可点击（disabled/is-disabled/aria-disabled 视为禁用）。 */
async function isPagerButtonEnabled(button: Locator): Promise<boolean> {
  if (!(await button.isVisible().catch(() => false))) return false;
  return button
    .evaluate((el) => {
      const host = (el.querySelector('button') as HTMLElement | null) ?? el;
      return !(host.classList.contains('is-disabled')
        || host.classList.contains('disabled')
        || host.hasAttribute('disabled')
        || host.getAttribute('aria-disabled') === 'true');
    })
    .catch(() => false);
}

/**
 * 把权限表每页条数切到下拉里最大档位（无分页控件或无更大档位时 no-op）。
 *
 * 与 findPermissionRowAcrossPages 配合，把多页列表的翻页成本降到 1～2 次，
 * 保证“未回显”不再被分页误报（依据见文件头 29F 分页实证条目）。
 *
 * 说明：结尾的 Escape 仅用于收起 sizes 下拉；此处处于列表页、没有打开中的
 * 权限弹窗，不会触发“弹窗内 Escape 误关整张弹窗”的已知风险（该禁令针对
 * 弹窗内下拉，dismissPermissionDropdown 在弹窗内继续生效）。
 */
export async function openPermissionTableMaxPageSize(page: Page): Promise<void> {
  const sizes = page.locator('.el-pagination .el-pagination__sizes:visible').first();
  if (!(await sizes.isVisible().catch(() => false))) return;
  await sizes.locator('input').first().click().catch(() => undefined);
  await page.waitForTimeout(400);
  const options = page
    .locator('.el-select-dropdown__item:visible')
    .filter({ hasText: PERMISSION_PAGE_SIZE_LABEL });
  const texts = await options.allInnerTexts().catch(() => [] as string[]);
  let bestIndex = -1;
  let bestSize = 10;
  for (const [index, text] of texts.entries()) {
    const match = PERMISSION_PAGE_SIZE_LABEL.exec(text);
    if (match && Number(match[1]) > bestSize) {
      bestSize = Number(match[1]);
      bestIndex = index;
    }
  }
  if (bestIndex >= 0) {
    await options.nth(bestIndex).click().catch(() => undefined);
    await page.waitForTimeout(800);
  }
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(200);
}

/** 权限表回到第 1 页（连续点“上一页”直到禁用；无分页控件时 no-op）。 */
export async function resetPermissionTableToFirstPage(page: Page): Promise<void> {
  for (let guard = 0; guard < 12; guard += 1) {
    const prev = permissionPagerButton(page, /上一页/);
    if (!(await isPagerButtonEnabled(prev))) return;
    await prev.click().catch(() => undefined);
    await page.waitForTimeout(500);
  }
}

/** 跨页查找权限行：先查当前页，找不到则点“下一页”继续，直到末页或超时。 */
export async function findPermissionRowAcrossPages(
  page: Page,
  uniqueText: string,
  timeoutMs = 15_000,
): Promise<Locator | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await findPermissionRow(page, uniqueText, 2_500);
    if (row) return row;
    if (Date.now() >= deadline) return undefined;
    const next = permissionPagerButton(page, /下一页/);
    if (!(await isPagerButtonEnabled(next))) return undefined;
    await next.click().catch(() => undefined);
    await page.waitForTimeout(600);
  }
}

/**
 * queryUserViewPermissionRow 的跨页版：重选主体 → 切最大每页条数 → 归位第 1 页
 * → 主动刷新 → 逐页检索。断言语义与单页版一致——仍要求权限行真实回显，只是
 * 搜索范围覆盖全部数据页（对齐 SM-03-05 分页适配的已验证行为）。
 */
export async function queryUserViewPermissionRowAcrossPages(
  page: Page,
  options: {
    subjectTab: UserViewSubjectTab;
    subjectName: string;
    subjectAlias?: string;
    resource: MysqlPermissionResource;
    timeoutMs?: number;
  },
): Promise<Locator> {
  await selectUserViewSubject(page, options);
  await openPermissionTableMaxPageSize(page);
  await resetPermissionTableToFirstPage(page);
  await refreshPermissionList(page);
  const uniqueText = options.resource.tableName ?? options.resource.sourceName;
  const row = await findPermissionRowAcrossPages(page, uniqueText, options.timeoutMs ?? 15_000);
  if (!row) {
    throw new Error(
      `用户视角主体“${options.subjectName}”的权限列表未回显“${uniqueText}”`
        + '（已切最大每页条数并逐页检索）；新增/编辑可能未生效，不能视为通过。',
    );
  }
  return row;
}

/** 回显断言：permissionType 由后端拼接为“使用、管理”，逐项包含断言可区分单类/双类。 */
export async function expectPermissionRowEcho(
  row: Locator,
  options: { permissionTypes: DataPermissionTypeFlag[] },
): Promise<void> {
  for (const type of options.permissionTypes) {
    await expect(row).toContainText(type, { timeout: 5_000 });
  }
}

/**
 * 资源视角打开目标资源：
 *   - 数据源页签：选择数据源类型（页面第一个 combobox，选项 MYSQL）→ 用
 *     “过滤当前数据源列表”缩小范围 → 点击数据源节点（SM-03-02 已确认）。
 *   - 数据表页签：库/Schema/表级联控件未见录制确认，按通用标签/占位符定位，
 *     找不到时显式失败，交由页面探查（子任务05）校准。
 * 选中成功以“新建权限”按钮启用为信号（未选中资源时禁用是页面已知规则）。
 */
export async function openResourceViewTarget(
  page: Page,
  resource: MysqlPermissionResource,
  scopeTab?: ResourceViewScopeTab,
): Promise<void> {
  const scope = scopeTab ?? (resource.tableName ? '数据表' : '数据源');
  await switchPermissionView(page, '资源视角');
  await switchResourceViewScopeTab(page, scope);

  const typeBox = await firstVisible(page.getByRole('combobox'));
  if (!typeBox) throw new Error(`资源视角未找到数据源类型下拉框，当前页面：${page.url()}`);
  await typeBox.click();
  await choosePermissionOption(page, resource.sourceTypeName, `资源视角数据源类型（${resource.sourceTypeName}）`);
  await dismissPermissionDropdown(page);

  if (scope === '数据源') {
    const filter = page.getByRole('textbox', { name: '过滤当前数据源列表' });
    if (await filter.isVisible().catch(() => false)) {
      await filter.fill(resource.sourceName);
      await page.waitForTimeout(600);
    }
    const exact = await firstVisible(page.getByText(resource.sourceName, { exact: true }));
    const target = exact
      ?? await firstVisible(
        page.locator('span:visible, div:visible').filter({
          hasText: new RegExp(`^${escapeRegExp(resource.sourceName)}`),
        }),
      );
    if (!target) {
      throw new Error(
        `资源视角未找到 MySQL 测试数据源“${resource.sourceName}”，不能对未知资源配置权限；当前页面：${page.url()}`,
      );
    }
    await target.click();
    await page.waitForTimeout(500);
  } else if (scope === '数据表') {
    // run-20260915-101140-669 快照实证：资源视角“数据表”页签有独立级联，
    // “数据源”未选时数据库下拉为“暂无数据”、表列表“已加载 0 / 共 0”——
    // 必须先在资源视角选中数据源，后续级联与表列表才会加载。
    const tableName = requirePermissionTableName(resource);
    const sourceLabel = page.getByText(/^数据源$/);
    const sourceLabelCount = await sourceLabel.count();
    let sourceBox: Locator | undefined;
    for (let index = 0; index < sourceLabelCount; index += 1) {
      const labelNode = sourceLabel.nth(index);
      if (!(await labelNode.isVisible().catch(() => false))) continue;
      // 快照结构：级联标签（e151）与控件（e153）同父行（e150）；页签“数据源”
      // 所在行（e83）不含任何下拉，据此区分两者。
      const row = labelNode.locator('..');
      const box = await firstVisible(
        row.locator('.ant-select:visible, .el-select:visible, [role="combobox"]:visible, select:visible'),
      );
      if (box) {
        sourceBox = box;
        break;
      }
    }
    if (!sourceBox) {
      throw new Error(`资源视角“数据表”页签未找到“数据源”下拉控件，当前页面：${page.url()}`);
    }
    await sourceBox.click();
    await choosePermissionOption(page, resource.sourceName, `资源视角数据源（${resource.sourceName}）`, sourceBox);
    await dismissPermissionDropdown(page);
    await expect
      .poll(async () => (await sourceBox.getByText(resource.sourceName, { exact: true }).count()) > 0, {
        timeout: 8_000,
        message: `资源视角数据源选择“${resource.sourceName}”后未回填（下拉控件内未见该值的完整文本节点）`,
      })
      .toBe(true);

    // 数据库/Schema 仍是下拉级联（快照 e161/e163、e177/e179），沿用弹窗同源
    // 的精确匹配 + 可搜索过滤；“表”不是下拉（快照 115-117 行为“表名过滤”
    // 输入、126-127 行提示“请在左侧选择数据表”），不能沿用三级下拉逻辑。
    const cascadeLevels = tableCascadeLevels(resource).filter((level) => level.name !== '数据表');
    for (const level of cascadeLevels) {
      // 资源视角页签“数据表/数据源”与级联标签同名且在 DOM 中更靠前；限制
      // 标签上溯 2 层避免误取页签祖先容器里的其他下拉框。
      const box = await locatePermissionSelectByLabel(page.locator('body'), level.labels, level.placeholder, `资源视角${level.name}`, 2);
      await box.click();
      await choosePermissionOption(page, level.value, `资源视角${level.name}（${level.value}）`, box);
      await dismissPermissionDropdown(page);
      await expect
        .poll(async () => (await box.getByText(level.value, { exact: true }).count()) > 0, {
          timeout: 5_000,
          message: `资源视角${level.name}选择“${level.value}”后未回填（下拉控件内未见该值的完整文本节点）`,
        })
        .toBe(true);
    }

    // 表：向“表名过滤”输入（快照 e189，可访问名“过滤当前表列表”）填入表名
    // 过滤左侧列表，再点选目标表行；“新建权限”按钮启用（函数尾部轮询）即
    // 资源真正选中。
    const tableFilter = page.getByRole('textbox', { name: /过滤当前表列表|表名过滤/ });
    await expect
      .poll(async () => tableFilter.isVisible().catch(() => false), {
        timeout: 8_000,
        message: '资源视角“数据表”页签未出现“表名过滤”输入框',
      })
      .toBe(true);
    await tableFilter.fill(tableName);
    await page.waitForTimeout(800);
    let tableRow: Locator | undefined;
    const rowDeadline = Date.now() + 8_000;
    while (Date.now() < rowDeadline && !tableRow) {
      tableRow = await firstVisible(page.getByText(tableName, { exact: true }));
      if (!tableRow) await page.waitForTimeout(300);
    }
    if (!tableRow) {
      throw new Error(
        `资源视角表列表未出现目标表“${tableName}”（已输入表名过滤），不能对未知表配置权限；当前页面：${page.url()}`,
      );
    }
    await tableRow.click();
    await page.waitForTimeout(500);
  }

  if (scope !== '数据服务 API') {
    const create = page.getByRole('button', { name: /新建权限|新增/ }).last();
    await expect
      .poll(async () => create.isEnabled().catch(() => false), {
        timeout: 10_000,
        message: '资源视角选中目标资源后“新建权限”仍未启用，资源可能未被真正选中',
      })
      .toBe(true);
  }
}

/**
 * 资源视角定位授权主体行：打开目标资源后按主体名（页面显示“用户名(昵称)”，
 * 子串匹配即可命中）查找授权行；找不到返回 undefined，由调用用例断言
 * “应存在/应消失”两种语义，工具不替用例下结论。
 */
export async function findResourceViewAuthorizationRow(
  page: Page,
  options: {
    resource: MysqlPermissionResource;
    subjectName: string;
    scopeTab?: ResourceViewScopeTab;
    timeoutMs?: number;
  },
): Promise<Locator | undefined> {
  await openResourceViewTarget(page, options.resource, options.scopeTab);
  return findPermissionRow(page, options.subjectName, options.timeoutMs ?? 10_000);
}

/**
 * 分表结构下的“同一可见行”对齐查找：当前前端把权限数据列与“操作”列渲染
 * 在相邻的两张 table 中（LOCAL-AI-20260915-004 页面事实），同一逻辑行在两
 * 张表中按相同视觉高度对齐。取数据行 y 轴中心，在所有可见行中查找包含目
 * 标操作且 y 中心最接近（容差内）的行内按钮；找不到返回 undefined 交由调
 * 用方兜底。
 */
async function findActionInAlignedRow(
  page: Page,
  row: Locator,
  action: '编辑' | '删除',
): Promise<Locator | undefined> {
  const rowBox = await row.boundingBox().catch(() => null);
  if (!rowBox) return undefined;
  const rowCenterY = rowBox.y + rowBox.height / 2;
  const tolerance = Math.max(12, rowBox.height * 0.75);
  const rows = page.locator('tr:visible, [role="row"]:visible');
  const count = await rows.count();
  let best: Locator | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < count; index += 1) {
    const candidateRow = rows.nth(index);
    const box = await candidateRow.boundingBox().catch(() => null);
    if (!box) continue;
    const distance = Math.abs(box.y + box.height / 2 - rowCenterY);
    if (distance > tolerance || distance >= bestDistance) continue;
    const actionElement = await firstVisible(
      candidateRow.getByRole('button', { name: new RegExp(`^\\s*${action}\\s*$`) })
        .or(candidateRow.getByRole('link', { name: new RegExp(action) }))
        .or(candidateRow.getByText(action, { exact: true }))
        .or(candidateRow.locator(ROW_ACTION_ICON_SELECTORS[action])),
    );
    if (actionElement) {
      best = actionElement;
      bestDistance = distance;
    }
  }
  return best;
}

/** 点击权限行内的“编辑/删除”操作：先按文本按钮/链接，再退回纯图标兜底。 */
async function clickRowAction(page: Page, row: Locator, action: '编辑' | '删除'): Promise<void> {
  const candidates = [
    row.getByRole('button', { name: new RegExp(`^\\s*${action}\\s*$`) }),
    row.getByRole('link', { name: new RegExp(action) }),
    row.locator('button:visible, [role="button"]:visible, a:visible').filter({ hasText: new RegExp(action) }),
    row.getByText(action, { exact: true }),
    row.locator(ROW_ACTION_ICON_SELECTORS[action]),
  ];
  for (const candidate of candidates) {
    const item = await firstVisible(candidate);
    if (item) {
      await item.click();
      return;
    }
  }
  // 当前前端把“权限数据”与“操作”拆成两张并排 table：资源文字所在 row 与
  // “编辑/删除”不再是同一个 DOM 行（LOCAL-AI-20260915-004 页面事实）。
  // 优先按同一视觉行（y 轴中心对齐）定位操作按钮，列表存在多行时不会误点
  // 其他资源的“编辑/删除”；对齐失败（如行无 boundingBox）时回退到下方的
  // “最后一张可见 table”旧行为（本闭环每次已先按唯一资源筛至单条）。
  const aligned = await findActionInAlignedRow(page, row, action);
  if (aligned) {
    await aligned.click();
    return;
  }
  const splitTableAction = page.locator('table:visible').last().getByText(action, { exact: true });
  const splitAction = await firstVisible(splitTableAction);
  if (splitAction) {
    await splitAction.click();
    return;
  }
  throw new Error(`权限行内未找到“${action}”操作入口（文本/图标/分表对齐均未命中），当前页面：${page.url()}`);
}

/**
 * 从权限行打开编辑弹窗，返回弹窗 Locator（可见性已断言）。
 *
 * run-20260915-123019-032 页面事实：前端打开编辑弹窗时会调用
 * GET /bigdata-factory-api/dataPermission/queryInfo?id=<权限记录id> 回填表单；
 * 当前后端对该路由返回 HTTP 404（Spring 默认错误体 path=/dataPermission/
 * queryInfo，非业务码信封），表单不回填（下拉全为占位符、权限类型为默认态），
 * 随后点击“保存”不发出任何请求，弹窗永不关闭——用例只能得到“15 秒弹窗未
 * 关闭”的无定性超时。这里在点击“编辑”前挂网络响应监听，把该后端缺陷转化
 * 为即时、带证据的明确失败；接口正常返回（2xx）时零行为差异，不改测试语义。
 */
export async function openPermissionEditDialog(page: Page, row: Locator): Promise<Locator> {
  const failedDetailCalls: string[] = [];
  const onResponse = (response: Response): void => {
    if (!/dataPermission\/queryInfo/i.test(response.url())) return;
    if (response.status() < 400) return;
    failedDetailCalls.push(`HTTP ${response.status()} ${response.url()}`);
  };
  page.on('response', onResponse);
  try {
    await clickRowAction(page, row, '编辑');
    const dialog = await visibleDialog(page);
    await expect(dialog).toBeVisible();
    // 详情接口通常在弹窗渲染后数百毫秒内落定；等待一小段，避免把“响应尚未
    // 到达”误判为“接口正常”（正常环境本轮等待即全部开销）。
    if (!failedDetailCalls.length) await page.waitForTimeout(1_500);
    if (failedDetailCalls.length) {
      const toast = await firstVisible(page.getByText(/详情失败|加载失败|请求失败/));
      throw new Error(
        `编辑权限弹窗打开后表单未回填：权限详情接口调用失败（${failedDetailCalls.join('；')}）`
        + `${toast ? '，页面同时出现“详情加载失败”类提示' : ''}。该状态下点击“保存”不会发出任何请求、弹窗不会关闭，`
        + `属后端接口缺失/异常缺陷而非定位问题（同页新增/删除/列表接口均正常）；当前页面：${page.url()}`,
      );
    }
    return dialog;
  } finally {
    page.off('response', onResponse);
  }
}

/**
 * 提交编辑：按需调整权限类型（后端整体覆盖 permissionList，未勾选即清除）
 * 与截止时间，再走统一的弹窗提交（弹窗关闭 + 成功通知）。
 */
export async function submitPermissionEditDialog(
  page: Page,
  dialog: Locator,
  changes: { permissionTypes?: DataPermissionTypeFlag[]; expiry?: PermissionExpiryMode } = {},
): Promise<void> {
  if (changes.permissionTypes) await setPermissionTypes(page, dialog, changes.permissionTypes);
  if (changes.expiry) await setPermissionExpiry(page, dialog, changes.expiry);
  await submitPermissionDialog(page, dialog);
}

/**
 * 处理删除类二次确认层（Ant Modal.confirm / Popconfirm / el MessageBox）。
 * 5 秒内未出现确认层则视为当前版本无二次确认（直接删除），返回 false；
 * 是否真正删除由调用方的行消失断言兜底，本函数不单独判定成功。
 */
export async function confirmPermissionDangerAction(page: Page): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const layer = await visible(page.locator(
      '.ant-modal-confirm:visible, .ant-popconfirm:visible, .ant-popover:visible, '
        + '.el-message-box:visible, [role="dialog"]:visible',
    ));
    if (layer) {
      const confirm = await firstVisible(
        layer.locator('button, [role="button"]').filter({ hasText: /确\s*定|确\s*认|删\s*除/ }),
      );
      if (confirm) {
        await confirm.click();
        return true;
      }
    }
    await page.waitForTimeout(250);
  }
  return false;
}

/** 统计同名文本的可见匹配数：同名多行场景下“行已消失”判定的计数基数。 */
async function visibleTextCount(page: Page, text: string): Promise<number> {
  const locator = page.getByText(text);
  const total = await locator.count();
  let visible = 0;
  for (let index = 0; index < total; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) visible += 1;
  }
  return visible;
}

/**
 * 删除权限行并验证回显消失：点击“删除”→ 处理二次确认（若有）→ 轮询断言
 * 该行从列表消失。行仍存在即删除未生效，明确失败。
 * r13（SM-03-06）实证：“数据表”页签存在同名重复授权行（同一专用表被历史
 * 轮次残留授权约 10 条），逐条删除时其余同名行仍在，旧的“全页零匹配”判定
 * 永远不成立（删除请求已 200、总数 11→10，轮询仍超时）。改为“同名可见匹配
 * 数较删除前减少”（唯一行场景等价于归零），并保留被删行容器自身不可见的
 * 前置条件——点击未生效（误点/弹层拦截）时依旧明确失败。
 */
export async function deletePermissionFromRow(
  page: Page,
  row: Locator,
  options: { uniqueText?: string } = {},
): Promise<void> {
  const beforeCount = options.uniqueText
    ? await visibleTextCount(page, options.uniqueText)
    : 0;
  await clickRowAction(page, row, '删除');
  await confirmPermissionDangerAction(page);
  await dismissPermissionDropdown(page);
  const rowGone = async () => {
    if (await row.isVisible().catch(() => false)) return false;
    if (!options.uniqueText) return true;
    return (await visibleTextCount(page, options.uniqueText)) < beforeCount;
  };
  await expect
    .poll(rowGone, { timeout: 20_000, message: '删除确认后权限行仍出现在列表中，删除可能未生效' })
    .toBe(true);
}






