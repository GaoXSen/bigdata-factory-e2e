/**
 * SMK-02-02｜公共与冒烟｜回归验证
 *
 * 业务语义（与用例名一致）：回归用例通过后标记测试目的，但不提前标通过——
 * 用例内只调用 report() 记录检查目的与页面证据；最终通过/失败由 utils.ts 的
 * afterEach 按 testInfo.status 真实记录，不在用例内写死通过结果。
 *
 * DS-PERM-54 配置中心入口校准（2026-09-22，静态开发）：
 * - 入口 URL 不再写死，统一取 testEnvironment.app.entryUrl（ENTRY_URL 兼容变量可覆盖）；
 * - 登录后就绪态以“可见主导航（数据地图）+ 配置中心入口页（数据源管理）”为证，
 *   不固定文件接入，并明确排除产品 404 / 登录页；
 * - 控制台错误断言与其它冒烟用例同口径。
 */
import { test, expect } from '../utils.js';
import { assertNoConsoleErrors } from '../utils.js';
// DS-PERM-54：入口 URL/落地页统一读取配置中心（ENTRY_URL 兼容变量可在其上覆盖）。
import { testEnvironment } from '../../../test-environment.js';

/** DS-PERM-54：配置中心入口 hash 路由正则（就绪态断言跟随配置，不写死落地页）。 */
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

/** 登录后就绪态落点：配置中心入口页路由（当前为数据接入→数据源管理）。 */
const LOGIN_LANDING_URL = configuredRouteRegex(testEnvironment.app.entryUrl);

test.describe("SMK-02-02｜公共与冒烟｜回归验证", () => {
  test("SMK-02-02｜公共与冒烟｜回归验证", async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;
    const entryUrl = testEnvironment.app.entryUrl.trim();
    // 复用 loginPage fixture 的独立登录会话，再次直达配置中心入口页（回归路径）。
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
    // 就绪态证据：落在配置中心入口路由，且非产品 404、非登录页。
    await expect(page).toHaveURL(LOGIN_LANDING_URL, { timeout: 15_000 });
    expect(page.url(), `回归入口不应落入产品 404：${page.url()}`).not.toMatch(/#\/404\b/);
    expect(page.url(), `回归入口不应停留在登录页：${page.url()}`).not.toMatch(/#\/login\b/);
    await expect(page.locator('body')).toBeVisible();
    // 主导航（数据地图）与入口页主体（数据源管理）同时可见，才是登录后就绪态。
    await expect(page.getByText('数据地图', { exact: true }).last()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('数据源管理', { exact: true }).last()).toBeVisible({ timeout: 10_000 });
    await assertNoConsoleErrors(consoleErrors);
    // 回归标记：只记录检查目的与页面证据，最终结果由 afterEach 按真实状态记录。
    await report(
      '回归验证-登录后就绪态',
      true,
      `登录会话直达配置中心入口 ${entryUrl}：主导航（数据地图）与数据源管理页主体可见，非 404/登录页`,
    );
  })
});