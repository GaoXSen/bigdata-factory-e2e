/**
 * 数据工厂 — 公共与冒烟：一个用例失败后后续用例仍可执行（失败隔离回归）
 *
 * 依据 e2e-testing Skill：
 * - 每个检查点独立成 test；任何一条失败都不会阻断后续 test——
 *   后续 test 经 loginPage fixture 获得全新的浏览器上下文并重新独立登录；
 * - 目的不是制造假失败，而是验证：无论哪条先失败，新的浏览器/fixture
 *   仍能独立完成“登录 → 菜单导航 → 目标页面主体”全链路；
 * - 当前登录默认落点是配置中心入口页（testEnvironment.app.entryUrl，当前为
 *   “数据接入→数据源管理”；DS-PERM-54 起 URL 断言由配置派生，不写死落地页）：
 *   每条都先以 toHaveURL 确认从默认页出发，不假设登录后已在文件接入，也不固定等待数秒；
 * - 每次导航只等待真实页面就绪：URL 断言（toHaveURL）+ 页面主体内容断言，
 *   不把旧 URL 当作导航成功；
 * - 只验证当前环境已能确认的页面事实，不假设业务数据一定存在；
 * - 报告中的最终结果由 utils.ts 的 afterEach 按 testInfo.status 记录。
 */

import { test, expect } from '../utils.js';
import { assertNoConsoleErrors, clickMenu } from '../utils.js';
// DS-PERM-54：登录入口/落地页与目标路由统一读取配置中心（ENTRY_URL 兼容变量可覆盖）。
import { testEnvironment } from '../../../test-environment.js';

/**
 * DS-PERM-54 配置中心入口校准：登录默认落点与文件接入目标路由均从配置中心派生
 * （testEnvironment.app.entryUrl / app.fileAccessEntryUrl），不再写死
 * #/dataAccess/dataSource 或 #/dataAccess/fileAccess。
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 配置中心入口 URL 的 hash 路由匹配正则；anchorEnd 时以 $ 结尾锚点排除子路由。 */
function configuredRouteRegex(entryUrl: string, anchorEnd = false): RegExp {
  const hashIndex = entryUrl.indexOf('#');
  const route = (hashIndex >= 0 ? entryUrl.slice(hashIndex + 1) : '').replace(/\/+$/, '');
  if (!route) return /#/;
  return new RegExp(`#${escapeRegExp(route)}${anchorEnd ? '\\/?$' : ''}`);
}

/** 登录默认落点：配置中心入口页（当前为数据接入→数据源管理） */
const LOGIN_LANDING_URL = configuredRouteRegex(testEnvironment.app.entryUrl);
/** 文件接入目标页路由（菜单可达性目标页；$ 锚点排除 fileAccessCreate 等子路由） */
const FILE_ACCESS_URL = configuredRouteRegex(testEnvironment.app.fileAccessEntryUrl, true);
const TABLE_QUERY_URL = /#\/dataMap\/tableQuery\/tablesQuery/;
const EMPTY_STATE = /暂无数据|没有数据/;
/** 表查询页有数据时的卡片锚点（负责人）；与 EMPTY_STATE 组合成“列表或空态”判定 */
const LOADED_OR_EMPTY = new RegExp(`负责人|${EMPTY_STATE.source}`);

test.describe("SMK-02-01｜公共与冒烟｜一个用例失败后后续用例仍可执行", () => {
  test("SMK-02-01｜阶段1：独立登录进入默认落点（数据源管理+主导航）", async ({
    loginPage,
    consoleErrors,
    report,
  }) => {
    const page = loginPage;
    // 本条 test 的全新浏览器上下文独立完成登录；默认落点为配置中心入口页
    //（数据源管理），非 #/404、非登录页。
    await expect(page).toHaveURL(LOGIN_LANDING_URL, { timeout: 20_000 });
    await expect(page.getByText('数据源管理', { exact: true }).last()).toBeVisible({ timeout: 10_000 });
    // 主导航已真实渲染：判定与 utils.hasMainNavigation 同源——可见 menuitem
    // 出现顶层模块文本，或正文出现模块入口（组件版本偶发不挂 role=menuitem 的兜底）。
    await expect
      .poll(
        async () => {
          const menuTexts = await page
            .locator('[role="menuitem"]:visible')
            .allTextContents()
            .catch(() => [] as string[]);
          if (menuTexts.some((text) => /^(?:数据地图|数据接入)\s*$/.test(text.replace(/\s+/g, ' ').trim()))) {
            return 'menuitem';
          }
          const bodyText = await page.locator('body').innerText().catch(() => '');
          return /数据地图|数据接入/.test(bodyText.replace(/\s+/g, ' ')) ? 'body' : 'none';
        },
        { timeout: 15_000 },
      )
      .not.toBe('none');
    await assertNoConsoleErrors(consoleErrors);
    await report(
      '阶段1-独立登录进入默认落点',
      true,
      `独立 fixture 登录后默认落点为配置中心入口 ${testEnvironment.app.entryUrl}，主导航已渲染（非 #/404、非登录页）`,
    );
  });

  test("SMK-02-01｜阶段2：默认页经菜单进入文件接入目标页", async ({
    loginPage,
    consoleErrors,
    report,
  }) => {
    const page = loginPage;
    // 先确认起点仍是登录默认页（配置中心入口）：证明是从默认页导航过去，
    // 不是假设已在文件接入。
    await expect(page).toHaveURL(LOGIN_LANDING_URL, { timeout: 20_000 });
    await clickMenu(page, '数据接入', '文件接入');
    // 真实页面就绪 = 文件接入路由 URL + 页面主体已渲染；URL 停在旧页面
    // 或路由跳 #/404 都会在这里失败，不存在“旧 URL 当成功”。
    await expect(page).toHaveURL(FILE_ACCESS_URL, { timeout: 15_000 });
    // 页面主体事实：新建接入入口 + 列表表格或空态（列表为空时 ant 空态组件可见）。
    await expect(
      page.getByRole('button', { name: /新建接入|新增接入/ }).filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page
        .locator('table:visible, .ant-table:visible, .ant-empty:visible, .el-table__empty-text:visible')
        .first(),
    ).toBeVisible({ timeout: 15_000 });
    await assertNoConsoleErrors(consoleErrors);
    await report(
      '阶段2-默认页菜单进入文件接入',
      true,
      `从默认落点经可见菜单进入配置中心文件接入入口 ${testEnvironment.app.fileAccessEntryUrl}，新建接入入口与列表表格或空态已渲染`,
    );
  });

  test("SMK-02-01｜阶段3：新浏览器fixture再次从默认页进入指定目标页（表查询）", async ({
    loginPage,
    consoleErrors,
    report,
  }) => {
    const page = loginPage;
    // 又一条全新浏览器上下文：即使前面任一阶段失败，本条仍独立登录并从
    // 默认落点出发进入另一指定目标页——这正是“失败后后续用例仍可执行”。
    await expect(page).toHaveURL(LOGIN_LANDING_URL, { timeout: 20_000 });
    await clickMenu(page, '数据地图', '表查询');
    await expect(page).toHaveURL(TABLE_QUERY_URL, { timeout: 15_000 });
    // 表查询主体区域（搜索栏/卡片列表）已渲染；URL 停留旧页面或组件残留
    // （主体仍是数据源管理 DOM）都会在这里失败。
    await expect(page.locator('.table-query .search-bar, .table-query .card-list').first()).toBeVisible({
      timeout: 15_000,
    });
    // 该页主体是卡片列表而非 tbody 表格：有数据展示“负责人”，无数据必须有明确空态。
    await expect(page.getByText(LOADED_OR_EMPTY).first()).toBeVisible({ timeout: 10_000 });
    await assertNoConsoleErrors(consoleErrors);
    await report(
      '阶段3-新fixture独立进入表查询',
      true,
      '新浏览器/fixture 独立登录后从默认落点经菜单进入 #/dataMap/tableQuery/tablesQuery，主体区域与列表或空态可见',
    );
  });
});

