/**
 * SM-04-01｜权限配置入口、用户/资源视角切换与权限列表基础可用性（清洁环境迁移版）。
 *
 * 迁移说明（2026-09-23 DS-PERM-79，静态开发，未运行真实用例）：
 * - 目标：清洁环境（无历史用户、角色、数据源、数据表与授权记录）下验证
 *     1) 权限配置入口（系统管理 → 用户权限 → 数据权限）可达；
 *     2) 用户视角/资源视角可真实切换，且两视角的主体/资源页签各自可用、
 *        切换后另一视角退出选中态（页面差异证据）；
 *     3) 权限列表基础可用（查询/搜索/刷新控件存在并可执行只读刷新）。
 *   全程不依赖、不断言任何具体业务行数据：列表为空也必须满足以上结构可用性。
 * - 相对旧版的收紧：旧版多选一正则（资源视角|数据源|数据表 等）命中任一词即
 *   通过，无法证明具体入口存在，也未断言切换后的页面差异（公司模型辅助审查
 *   20260902 第 4 条）。现改为逐节点精确存在断言 + 真实切换动作 +
 *   aria-selected 选中态差异断言。
 * - 清洁环境规则：本用例是纯入口/结构可用性验证，不需要创建任何实体
 *   （用户/角色/数据源/表/授权均不需要），因此没有本轮资产，也没有 finally
 *   清理；不读取、不修改数据权限开关等共享配置，仅做导航、页签切换与只读刷新。
 * - 管理员身份由公共配置供给：经公共 loginPage fixture 完成登录（BASE_URL 与
 *   配套账号口令均来自公共配置），本文件不读取、不写死任何凭据。
 * - 硬链接双入口约束：本文件同时以硬链接形态存在于权威中文目录与
 *   e2e/sm-static/SM-04-01.spec.ts；两棵目录树中 '../utils.js' 解析到不同文件，
 *   因此只导入两侧 utils 均导出的符号（test/expect/assertNoConsoleErrors）与
 *   两侧同名硬链接的 './数据权限闭环工具.js'，禁止深层相对配置导入
 *   （同 SM-02-07/SM-03-01 既有口径）。
 * - 保留断言清单：入口可达、用户视角与资源视角节点、成员/角色主体页签、
 *   数据源/数据表资源页签、新建权限入口、列表查询控件、控制台无错误。
 *   “数据服务 API”资源页签未纳入硬断言：其渲染依赖独立体系，条件未实证，
 *   留待有环境的用例包补充，避免清洁环境下误报。
 */
import type { Locator, Page } from '@playwright/test';
import { assertNoConsoleErrors, expect, test } from '../utils.js';
import {
  openDataPermissionPage,
  refreshPermissionList,
  switchPermissionView,
  switchResourceViewScopeTab,
  switchUserViewSubjectTab,
} from './数据权限闭环工具.js';

/**
 * 按 数据权限闭环工具.clickDataPermissionTabNode 的既有定位顺序查找视角/页签节点
 * （该函数未导出，此处按同顺序本地复刻，保证与共享工具命中同一节点；
 * 先语义页签、后精确文本，均取第一个可见项）。
 */
async function findPermissionNode(page: Page, name: string): Promise<Locator> {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const candidates = [
    page
      .locator('[role="tab"]:visible, .ant-tabs-tab:visible, .el-tabs__item:visible')
      .filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) }),
    page.getByRole('tab', { name, exact: true }),
    page.getByText(name, { exact: true }),
  ];
  for (const candidate of candidates) {
    const count = await candidate.count();
    for (let index = 0; index < count; index += 1) {
      const item = candidate.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  throw new Error(`数据权限页面未找到“${name}”视角/页签节点（已按共享工具同序候选查找），当前页面：${page.url()}`);
}

/** 读取节点的 aria-selected 选中值：属性不存在时返回 null（视为未选中）。 */
async function selectedStateOf(node: Locator): Promise<string | null> {
  return node.getAttribute('aria-selected').catch(() => null);
}

/** 统计当前页面可见的列表查询控件（查询/搜索/刷新）数量，作为列表可用性证据。 */
async function visibleListControlCount(page: Page): Promise<number> {
  const controls = page.getByRole('button', { name: /查\s*询|搜\s*索|刷\s*新/ });
  const count = await controls.count();
  let visibleCount = 0;
  for (let index = 0; index < count; index += 1) {
    if (await controls.nth(index).isVisible().catch(() => false)) visibleCount += 1;
  }
  return visibleCount;
}

/**
 * 定位“新建权限”入口按钮。清洁环境未选主体/资源时该按钮允许处于禁用态
 * （页面正常规则，不强制点击），调用方只断言入口存在且可见。
 */
async function requireCreatePermissionButton(page: Page, where: string): Promise<Locator> {
  const buttons = page.getByRole('button', { name: /新建权限/ });
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const item = buttons.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  throw new Error(`${where}未找到“新建权限”入口按钮；权限配置入口不完整，当前页面：${page.url()}`);
}

test('SM-04-01｜清洁环境下权限配置入口、用户/资源视角切换与权限列表基础可用', async ({
  loginPage,
  consoleErrors,
  report,
}) => {
  const page = loginPage;

  // 1. 入口：系统管理 → 用户权限 → 数据权限（真实菜单导航 + URL + 页面内容就绪）。
  await openDataPermissionPage(page);
  await report('权限配置入口', true, `已进入数据权限页：${page.url()}`);

  // 2. 双视角入口节点逐一精确存在（替代旧版多选一正则断言）。
  const userViewNode = await findPermissionNode(page, '用户视角');
  await expect(userViewNode, '用户视角入口节点应可见').toBeVisible();
  const resourceViewNode = await findPermissionNode(page, '资源视角');
  await expect(resourceViewNode, '资源视角入口节点应可见').toBeVisible();

  // 3. 用户视角：主体页签（成员/角色）逐一真实点击切换；记录列表查询控件数量。
  await switchPermissionView(page, '用户视角');
  await switchUserViewSubjectTab(page, '成员');
  await switchUserViewSubjectTab(page, '角色');
  const userViewListControls = await visibleListControlCount(page);
  await refreshPermissionList(page);
  const createButton = await requireCreatePermissionButton(page, '用户视角');
  await expect(createButton, '用户视角“新建权限”入口应可见').toBeVisible();
  const createEnabledInUserView = await createButton.isEnabled().catch(() => false);

  // 4. 切到资源视角：用户视角节点退出选中态（切换后的页面差异证据）。
  await switchPermissionView(page, '资源视角');
  const userViewSelectedInResource = await selectedStateOf(userViewNode);
  expect(
    userViewSelectedInResource,
    '切到资源视角后，用户视角节点应退出选中态（aria-selected 不为 true）',
  ).not.toBe('true');

  // 5. 资源视角：资源范围页签（数据源/数据表）逐一真实点击切换，并回落数据源页签。
  await switchResourceViewScopeTab(page, '数据源');
  await switchResourceViewScopeTab(page, '数据表');
  await switchResourceViewScopeTab(page, '数据源');
  const resourceViewListControls = await visibleListControlCount(page);
  await refreshPermissionList(page);
  const resourceCreateButton = await requireCreatePermissionButton(page, '资源视角');
  await expect(resourceCreateButton, '资源视角“新建权限”入口应可见').toBeVisible();
  const createEnabledInResourceView = await resourceCreateButton.isEnabled().catch(() => false);

  // 6. 权限列表基础可用性：两视角合计至少一个可见查询控件（清洁环境 0 行也必须可用）。
  expect(
    userViewListControls + resourceViewListControls,
    `权限列表查询控件（查询/搜索/刷新）应至少 1 个可见：用户视角 ${userViewListControls} 个、`
      + `资源视角 ${resourceViewListControls} 个`,
  ).toBeGreaterThan(0);

  // 7. 切回用户视角：功能切换闭环 + 资源视角节点退出选中态。
  await switchPermissionView(page, '用户视角');
  const resourceViewSelectedInUser = await selectedStateOf(resourceViewNode);
  expect(
    resourceViewSelectedInUser,
    '切回用户视角后，资源视角节点应退出选中态（aria-selected 不为 true）',
  ).not.toBe('true');
  await expect(userViewNode, '回到用户视角后该入口仍应可见').toBeVisible();
  await expect(resourceViewNode, '资源视角入口在用户视角下仍应可见（视角切换器常驻）').toBeVisible();

  await assertNoConsoleErrors(consoleErrors);
  await report(
    '权限配置入口',
    true,
    '清洁环境验证完成：入口可达；用户/资源视角可来回切换且选中态互斥；'
      + `成员/角色与数据源/数据表页签可点击；两视角查询控件合计可见 `
      + `${userViewListControls + resourceViewListControls} 个；`
      + `新建权限入口在用户视角${createEnabledInUserView ? '可用' : '未选中主体时禁用（页面正常规则）'}、`
      + `在资源视角${createEnabledInResourceView ? '可用' : '未选中资源时禁用（页面正常规则）'}；`
      + '全程未依赖任何历史用户/角色/数据源/表/授权记录。',
  );
});

/*
 * 用例编号：SM-04-01
 * 功能模块：系统管理
 * 测试类型：权限/状态
 * 原始审计日志需求保留在 Excel 的业务补充项中，待业务提供入口和字段后另拆审计日志用例。
 */