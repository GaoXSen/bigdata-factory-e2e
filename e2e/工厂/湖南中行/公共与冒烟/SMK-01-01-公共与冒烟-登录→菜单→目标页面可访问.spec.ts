/**
 * 数据工厂 — 公共与冒烟：登录→菜单→目标页面可访问
 *
 * 依据 e2e-testing Skill：
 * - 每个检查点独立成 test，单条失败不会阻断后续 test；
 * - 通过浏览器可见操作完成登录、菜单导航和页面断言；
 * - 登录成功后的默认落点是配置中心入口页（testEnvironment.app.entryUrl，当前为
 *   “数据接入→数据源管理”；DS-PERM-54 起 URL 断言由配置派生，不写死落地页），
 *   以当前页面为准验证，不强制先进入文件接入，也不固定等待数秒；
 * - 每次导航只等待真实页面就绪：URL 轮询（toHaveURL/expect.poll）+ 页面主体内容
 *   断言；不用固定睡眠，也不把旧 URL 当作导航成功；
 * - 菜单覆盖可见顶层菜单与顶部“...”溢出隐藏菜单两条入口路径；
 * - 只验证当前环境已能确认的页面事实，不假设业务表数据一定存在；
 * - 报告中的最终结果由 utils.ts 的 afterEach 按 testInfo.status 记录；
 *   若路由跳 #/404 或菜单缺失，失败产物（截图/error-context/trace）即页面证据，
 *   由结果文档区分脚本问题、真实页面问题或环境阻断。
 */

import { test, expect } from '../utils.js';
import { assertNoConsoleErrors, clickMenu } from '../utils.js';
// DS-PERM-54：登录入口/落地页统一读取配置中心（ENTRY_URL 兼容变量可在其上覆盖）。
import { testEnvironment } from '../../../test-environment.js';
import type { Locator, Page } from '@playwright/test';

/**
 * DS-PERM-54 配置中心入口校准：登录后落地页断言不再写死 #/dataAccess/dataSource，
 * 而是从 testEnvironment.app.entryUrl（ENTRY_URL 兼容变量可覆盖）派生 hash 路由正则。
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

/** 登录后默认落点：配置中心入口页（当前为数据接入→数据源管理） */
const LOGIN_LANDING_URL = configuredRouteRegex(testEnvironment.app.entryUrl);

const TABLE_QUERY_URL = /#\/dataMap\/tableQuery\/tablesQuery/;
const EMPTY_STATE = /暂无数据|没有数据/;
/** 表查询页有数据时的卡片锚点（负责人）；与 EMPTY_STATE 组合成“列表或空态”判定 */
const LOADED_OR_EMPTY = new RegExp(`负责人|${EMPTY_STATE.source}`);
/** 用户管理叶子路由（录制与 SM-00-01 前置准备确认） */
const USER_MANAGE_URL = /\/systemManage\/userPermission\/userManage/;
/** 顶层模块入口文本（与 utils.hasMainNavigation 的“数据地图/数据接入”同源并放宽到全部模块） */
const TOP_MODULE = /^(?:数据接入|数据地图|数据查询|数据服务|数据安全|系统管理)\s*$/;

/** 收集当前可见导航中的顶层模块入口文本（仅可见节点，隐藏 DOM 不计入） */
async function visibleTopModules(page: Page): Promise<string[]> {
  const texts: string[] = await page
    .locator(
      '[role="menuitem"]:visible, .ant-menu-item:visible, .ant-menu-submenu-title:visible, ' +
        '.el-menu-item:visible, nav a:visible, [class*="menu"] a:visible',
    )
    .allTextContents()
    .catch((): string[] => []);
  return [
    ...new Set(texts.map((t: string) => t.replace(/\s+/g, '')).filter((t: string) => TOP_MODULE.test(t))),
  ];
}

/** 在“...”溢出触发器候选中取最后一个可见项（与菜单导航工具 firstVisible 同序） */
async function findVisibleOverflowTrigger(page: Page): Promise<Locator | undefined> {
  const candidates: Locator[] = [
    page.getByRole('button', { name: /^(?:更多|···|…|\.\.\.)$/ }),
    page.getByRole('menuitem', { name: '···', exact: true }),
    page.getByRole('menuitem', { name: '…', exact: true }),
    page.getByRole('menuitem', { name: '...', exact: true }),
    page.locator('[aria-label*="更多"]:visible, [title*="更多"]:visible'),
    page.getByText('更多', { exact: true }),
    page.getByText(/^(?:···|…|\.\.\.)$/, { exact: true }),
  ];
  for (const candidate of candidates) {
    const count = await candidate.count();
    for (let index = count - 1; index >= 0; index--) {
      const item = candidate.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return undefined;
}

test.describe('SMK-01-01｜公共与冒烟｜登录→菜单→目标页面可访问', () => {
  test('SMK-01-01｜阶段1：登录默认落点为主导航与数据源管理页', async ({
    loginPage,
    consoleErrors,
    report,
  }) => {
    const page = loginPage;
    // 默认落点 = 配置中心入口页（testEnvironment.app.entryUrl，当前为“数据接入→
    // 数据源管理”）；不强制进入文件接入，也不固定等待。
    await expect(page).toHaveURL(LOGIN_LANDING_URL, { timeout: 20_000 });
    await expect(page.getByText('数据源管理', { exact: true }).last()).toBeVisible({ timeout: 10_000 });
    // 主导航已真实渲染：判定与 utils.hasMainNavigation 同源——可见 menuitem 出现
    // 顶层模块文本，或正文出现模块入口（组件版本偶发不挂 role=menuitem 的兜底）。
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
      '阶段1-数据源管理默认入口与主导航',
      true,
      `登录后默认落点为配置中心入口 ${testEnvironment.app.entryUrl}，主导航已渲染（非 #/404、非登录页）`,
    );
  });


  test('SMK-01-01｜阶段2：可见菜单进入目标页面（数据地图→表查询）', async ({
    loginPage,
    consoleErrors,
    report,
  }) => {
    const page = loginPage;
    await clickMenu(page, '数据地图', '表查询');
    // 真实页面就绪 = 叶子路由 URL + 表查询主体区域（搜索栏/卡片列表）已渲染；
    // URL 停在旧页面或路由跳 #/404 都会在这里失败，不存在“旧 URL 当成功”。
    await expect(page).toHaveURL(TABLE_QUERY_URL, { timeout: 15_000 });
    await expect(page.locator('.table-query .search-bar, .table-query .card-list').first()).toBeVisible({
      timeout: 15_000,
    });
    // 该页主体是卡片列表而非 tbody 表格：有数据展示“负责人”，无数据必须有明确空态。
    await expect(page.getByText(LOADED_OR_EMPTY).first()).toBeVisible({ timeout: 10_000 });
    await assertNoConsoleErrors(consoleErrors);
    await report(
      '阶段2-数据地图表查询',
      true,
      '经可见顶层菜单进入 #/dataMap/tableQuery/tablesQuery，搜索栏/卡片列表已渲染且列表或空态可见',
    );
  });

  test('SMK-01-01｜阶段3：溢出隐藏菜单与系统管理目标页面（用户管理）', async ({
    loginPage,
    consoleErrors,
    report,
  }) => {
    // run-20260928-110910-240 实证：登录前置 + “...”溢出菜单检查 + 三级菜单导航
    // （菜单导航工具每步点击后都有真实 settle 等待）在远程环境会耗尽默认单测时限，
    // “page.waitForTimeout: Test ended”打断 菜单导航工具.ts:322 的导航后等待时，
    // 本阶段 URL/新增用户按钮断言尚未执行（失败截图：用户管理叶子已选中高亮）。
    // 只放宽本阶段时间预算，不改任何断言与导航路径；页面是否真实渲染仍由下方
    // URL 轮询与“新增用户”按钮断言按真实结果验收，空白页不会因加时而误报通过。
    test.setTimeout(120_000);
    const page = loginPage;
    // 顶部“...”溢出菜单是真实页面事实：存在时点击后必须新出现此前不可见的模块
    // 入口（新增可见模块数 > 0），否则视为溢出菜单缺陷；宽屏下全部模块可见而没有
    // “...”时，记录该事实继续走菜单导航（不判失败、不跳过、不伪造）。
    const before = await visibleTopModules(page);
    const overflow = await findVisibleOverflowTrigger(page);
    let overflowChecked = '页面未出现“...”溢出触发器（当前窗口宽度下顶层模块全部可见）';
    if (overflow) {
      await overflow.click({ timeout: 10_000 });
      await expect
        .poll(
          async () => {
            const after = await visibleTopModules(page);
            return after.filter((name) => !before.includes(name)).length;
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThan(0);
      overflowChecked = `“...”溢出层展开并新出现隐藏模块入口（展开前可见模块：${before.join('、') || '无'}）`;
      // 收起溢出层再走常规菜单导航，避免浮层遮挡后续点击。
      await page.keyboard.press('Escape').catch(() => undefined);
    }

    // “系统管理”在部分窗口宽度下被收进顶部“...”：菜单导航工具会在目标不可见时
    // 自动展开溢出菜单，两条入口路径最终都以真实页面内容验收。
    await clickMenu(page, '系统管理', '用户权限', '用户管理');
    await expect.poll(() => page.url(), { timeout: 20_000 }).toMatch(USER_MANAGE_URL);
    await expect(page.getByRole('button', { name: '新增用户' })).toBeVisible({ timeout: 15_000 });
    await assertNoConsoleErrors(consoleErrors);
    await report('阶段3-溢出隐藏菜单与用户管理', true, `${overflowChecked}；经菜单进入 #/systemManage/userPermission/userManage，新增用户按钮可见`);
  });
});


