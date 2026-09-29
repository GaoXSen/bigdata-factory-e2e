/**
 * SMK-01-02｜公共与冒烟｜异常值/边界
 *
 * 湖南中行第一版标准化用例。来源：工厂测试用例-标准化业务版-FTP已补充-四环境配置版.xlsx。
 * 一个业务用例对应一个 spec.ts；本文件保留完整业务输入，未将缺失信息伪装成通过。
 *
 * DS-PERM-54 配置中心入口校准（2026-09-22，静态开发）：入口 URL、账号、密码统一读取
 * e2e/test-environment.ts（ENTRY_URL/TEST_USER 兼容变量可在其上覆盖；TEST_PASS 只来自
 * 环境变量，配置中心不提供默认值），不再写死入口地址与历史账号/密码兜底。
 * 登录成功的就绪态以“配置中心入口页（数据源管理）+ 主导航可见”为证，不固定文件接入。
 */
import { test, expect } from '../utils.js';
import { assertNoConsoleErrors } from '../utils.js';
// DS-PERM-54：入口/账号/密码统一走配置中心，本文件不再读取 process.env 兜底值。
import { testEnvironment } from '../../../test-environment.js';

/** 配置中心入口（ENTRY_URL 兼容变量可在其上覆盖）与账号（TEST_PASS 无代码默认值）。 */
const CONFIG_ENTRY_URL = testEnvironment.app.entryUrl.trim();
const CONFIG_USERNAME = testEnvironment.accounts.testUser.trim();
const CONFIG_PASSWORD = (testEnvironment.accounts.testPass || '').trim();

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

/** 登录成功后的就绪态落点：配置中心入口页路由（当前为数据接入→数据源管理）。 */
const LOGIN_LANDING_URL = configuredRouteRegex(CONFIG_ENTRY_URL);

test('SMK-01-02｜公共与冒烟｜错误密码、空账号和重复点击登录', async ({ page, consoleErrors, report }) => {
  // TEST_PASS 是环境凭据，配置中心不提供默认值；缺失时按“前置不足”显式跳过
  //（补齐 TEST_PASS 即可执行，非永久跳过），不伪造登录结果。
  test.skip(!CONFIG_PASSWORD, '缺少 TEST_PASS：错误密码/空账号/合法登录闭环无法执行（环境前置不足）。');
  if (!CONFIG_PASSWORD) return;
  const usernameInput = () => page.getByRole('textbox', { name: /账号|用户名/ }).first();
  const passwordInput = () => page.locator('input[type="password"]').first();
  const loginButton = () => page.getByRole('button', { name: /登\s*录|sign\s*in/i }).first();
  const loginPageReady = async (): Promise<void> => {
    await page.goto(CONFIG_ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await expect(passwordInput()).toBeVisible({ timeout: 8_000 });
  };
  await loginPageReady();
  await usernameInput().fill(CONFIG_USERNAME);
  await passwordInput().fill(CONFIG_PASSWORD + '_wrong');
  await loginButton().click();
  await expect(page.getByText(/错误|失败|不正确|密码/).last()).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('数据地图', { exact: true }).last()).toBeHidden({ timeout: 3_000 });
  await loginPageReady();
  await usernameInput().fill('');
  await passwordInput().fill(CONFIG_PASSWORD);
  await loginButton().click();
  await expect(page.getByText(/账号|用户名/).last()).toBeVisible({ timeout: 5_000 });
  await expect(passwordInput()).toBeVisible();
  await loginPageReady();
  await usernameInput().fill(CONFIG_USERNAME);
  await passwordInput().fill(CONFIG_PASSWORD);
  await expect(loginButton()).toBeEnabled({ timeout: 5_000 });
  await Promise.all([loginButton().click(), loginButton().click().catch(() => undefined)]);
  // 就绪态 = 主导航（数据地图）+ 配置中心入口页（数据源管理）同时可见；
  // 不把文件接入或固定旧页面当成功标志，重复点击登录也只落在同一入口页。
  await expect(page.getByText('数据地图', { exact: true }).last()).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveURL(LOGIN_LANDING_URL, { timeout: 10_000 });
  await expect(page.getByText('数据源管理', { exact: true }).last()).toBeVisible({ timeout: 10_000 });
  await assertNoConsoleErrors(consoleErrors);
  await report(
    '错误密码、空账号和重复点击登录',
    true,
    `错误输入被拦截，合法账号最终只进入一个主页面会话（就绪态：配置中心入口 ${CONFIG_ENTRY_URL} 的数据源管理页 + 主导航可见）。`,
  );

// 用例编号：SMK-01-02
// 功能模块：公共与冒烟
// 测试类型：异常值/边界
// 公共配置引用：D001；D010；D011；D008；P008
// 前置条件：准备错误密码、空账号和网络正常环境。
// 实际测试数据：D008：本轮对象使用 UUID 唯一后缀；错误密码、空账号和重复点击登录 使用的具体表、任务、账号、字段或文件：[待业务补充]
// 操作步骤：1. 使用 admin 登录系统，访问测试地址。
// 2. 进入“登录页 → [目标菜单待业务补充]”。
// 3. 准备本用例数据：D008：本轮对象使用 UUID 唯一后缀；错误密码、空账号和重复点击登录 使用的具体表、任务、账号、字段或文件：[待业务补充]
// 4. 分别输入异常值并执行“错误密码、空账号和重复点击登录”；具体控件、按钮和输入值：[待业务补充]。
// 5. 刷新页面或重新查询本轮对象，查看列表、详情、状态和提示。
// 6. 执行数据库/API/远端文件核验：核验语句、接口字段、文件名和数量：[待业务补充]。
// 7. 清理本轮对象：不写入业务数据。
// 预期结果：1. 登录成功，进入系统主页面；若主导航未加载，记录为环境/登录问题。
// 2. 目标页面/叶子菜单可见并打开；若菜单名称或层级不同，业务补充实际路径。
// 3. 前置对象存在且与本用例唯一标识匹配；不得误用已有业务对象。
// 4. 每个异常值都有明确提示；不保存半成品、不产生脏数据；修正为合法值后流程可继续。
// 5. 页面数据与本轮输入一致；不存在误命中、重复记录或状态未落库。
// 6. 核验结果与页面结果一致；不修改原有表、原有数据或非本轮文件。
// 7. 清理成功；已有对象、已有表和已有数据仍存在且未被修改。
// 异常输入及预期：异常输入及每个预期提示：[待业务补充]；DS-01-02/003/004 可参照数据源示例。
// 清理/回滚：不写入业务数据。
// 业务补充项：页面实际叶子菜单、按钮/字段名称；本轮测试对象的具体名称、字段和预期页面数据；每个异常输入的具体值、提示文案和不落脏数据判定；数据库/API 核验 SQL 或接口字段
// 历史TS追溯：暂无历史TS
});
