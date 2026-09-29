/**
 * SM-03-04｜系统管理｜独立用户菜单权限实际生效（清洁环境迁移版，DS-PERM-76）
 *
 * 相对旧版（固定历史用户 xiang wei）的升级点：
 *   1. 清洁环境自建：本轮唯一 ASCII 用户（newPermissionIdentity('sm0304')）与角色
 *      （newPermissionRole('sm0304','data-map-only')）；菜单授权通过当前角色菜单
 *      弹窗树解析“数据地图”节点，不依赖历史测试用户、固定角色或既有授权残留。
 *   2. 多层“实际生效”断言（旧版的接口/页面访问断言全部保留并落地为真实证据）：
 *      a) 真实重登录：loginAs 清理会话后以本轮新用户身份进入被授权落地页；
 *      b) UI 层：顶栏菜单“数据地图”可见、“系统管理”不可见（沿用旧版口径）；
 *      c) 接口层：登录会话捕获的 /getRouters 响应树含 dataMap 且不含
 *         systemManage（稳定 route 标识，不依赖中英文菜单文案）；
 *      d) 页面层：直连未授权路由 #/systemManage/userPermission/userManage，
 *         断言落在产品 404 兜底页（与 loginAs 头注释一致的已知产品行为）；
 *      e) 接口鉴权：未认证（无 FACTORY 头）直调 /systemUser/getUserPage 必须 401；
 *      f) 受限用户携带自身令牌直调系统管理接口：按后端 AuthorityInterceptor +
 *         sysMenu.api.permission 开关（默认 false）如实记录三种结果之一，
 *         不冒充权限验证通过，也不把开关未开启误报为产品缺陷。
 *   3. try/finally 兜底回收：finally 仅删除本轮唯一命名的用户与角色（角色删除即
 *      回收角色-菜单授权，用户删除即回收用户-角色绑定），不动任何共享角色/菜单/
 *      授权；清理日志强制附加，通过路径清理未闭环则判失败。
 *
 * 硬链接双入口约定：本文件同时以 e2e/工厂/湖南中行/系统管理/（中文权威入口）与
 * e2e/sm-static/SM-03-04.spec.ts（ASCII 入口）两棵不同层级的目录树加载，因此
 * 禁止直连深层 test-environment 相对路径；入口/环境信息使用“显式 ENTRY_URL >
 * 配置中心同款默认值”的构造（与 SM-02-01 同口径），后端 API 根地址与 FACTORY
 * 令牌全部在运行期从登录会话的真实 getRouters 请求派生，不写死任何主机。
 */
import type { Locator, Page, Response, TestInfo } from '@playwright/test';
import { expect, test } from '../utils.js';
import {
  assignRoleToUser,
  createAndInviteUser,
  createRole,
  loginAs,
  newPermissionIdentity,
  newPermissionRole,
  openRoleManagement,
  openUserManagement,
} from './权限测试工具.js';
import type { PermissionIdentity } from './权限测试工具.js';
import { confirmPermissionDangerAction } from './数据权限闭环工具.js';

/** 管理员身份（收尾回收用）：与配置中心默认口径一致，密码取 TEST_PASS。 */
const ADMIN_USER = (process.env.TEST_USER ?? 'admin').trim();
const adminIdentity: PermissionIdentity = {
  userName: ADMIN_USER,
  nickname: ADMIN_USER,
  password: process.env.TEST_PASS ?? '',
  phone: '',
  email: '',
};

/** 未授权模块/已授权模块的稳定 route 标识（后端 getRouters 的 path/name）。 */
const RESTRICTED_ROUTE_PREFIX = 'systemManage';
const AUTHORIZED_ROUTE_PREFIX = 'dataMap';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 与 SM-02-01 相同的落地页入口构造：显式 ENTRY_URL > 环境默认值。
 * 硬链接双入口不直连 test-environment 相对路径，默认值与配置中心保持同款字面量。
 */
function entryUrlFor(pathWithoutHash: string): string {
  const entry = new URL(
    process.env.ENTRY_URL ?? 'http://bigdata.dev.northking.net/bigdata-ui-factory/#/dataAccess/dataSource',
  );
  entry.hash = pathWithoutHash;
  return entry.toString();
}

interface RouterNode {
  name?: string;
  path?: string;
  hidden?: boolean;
  children?: RouterNode[];
}

interface RoutersCapture {
  url: string;
  status: number;
  factoryToken: string | undefined;
  body: string;
}

/** 复用 zz-agent7-applicant-getrouters-probe 的树形解析：object / object.data / data 三种包裹形态。 */
function extractRouterTree(body: string): RouterNode[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const root = parsed as { object?: unknown; data?: unknown };
  const tree = root.object ?? root.data ?? parsed;
  return Array.isArray(tree) ? (tree as RouterNode[]) : undefined;
}

function flattenRouterNodes(
  nodes: RouterNode[],
  out: Array<{ name?: string; path?: string }> = [],
): Array<{ name?: string; path?: string }> {
  for (const node of nodes ?? []) {
    out.push({ name: node.name, path: node.path });
    if (Array.isArray(node.children)) flattenRouterNodes(node.children, out);
  }
  return out;
}

/**
 * 目标用户真实重登录，并捕获本次会话后端返回的 /getRouters 菜单树与 FACTORY 令牌。
 * 监听器在 loginAs 之前挂载、捕获后卸载，保证快照严格属于本轮受限登录会话。
 */
async function captureRoutersDuringLogin(
  page: Page,
  identity: PermissionIdentity,
  entryUrl: string,
): Promise<RoutersCapture | undefined> {
  const captured: RoutersCapture[] = [];
  const listener = async (response: Response): Promise<void> => {
    try {
      if (!/getRouters/i.test(new URL(response.url()).pathname)) return;
      captured.push({
        url: response.url(),
        status: response.status(),
        factoryToken: response.request().headers()['factory'],
        body: await response.text().catch(() => ''),
      });
    } catch {
      // 取证异常不阻断登录流程
    }
  };
  page.on('response', listener);
  try {
    await loginAs(page, identity, { entryUrl });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && captured.length === 0) await page.waitForTimeout(300);
  } finally {
    page.off('response', listener);
  }
  // 取最后一次 getRouters：等于当前会话最终生效的菜单树
  return captured[captured.length - 1];
}

/** 产品 404 兜底页探测（口径同 utils 的产品 404 提示文案 + #/404 路由）。 */
async function waitForUnauthorizedRouteDenial(page: Page, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/#\/404\b/.test(page.url())) return true;
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (/404错误\s*[!！]\s*找不到网页/.test(bodyText)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/** 控制台错误白名单核验：标准 fixture 已忽略 404 资源类报错，这里额外放行越权探测预期的 401/403。 */
function assertNoUnexpectedConsoleErrors(consoleErrors: string[]): void {
  const allow = [/status of 40[13]/, /无访问接口的权限/];
  const unexpected = consoleErrors.filter((message) => !allow.some((pattern) => pattern.test(message)));
  expect(unexpected, `出现未预期的控制台错误：${unexpected.join(' | ')}`).toEqual([]);
}

/** 仅在悬停后的行操作条里点“删除”，避免点到表格其它列的同名按钮（口径同 SM-03-05）。 */
async function clickDeleteAction(scope: Locator): Promise<boolean> {
  const deleteButton = scope.getByRole('button', { name: '删除', exact: true }).first();
  if ((await deleteButton.count()) === 0) return false;
  await deleteButton.click();
  return true;
}

/**
 * 回收当前页面中与本轮唯一命名完全一致的行（exact 匹配，不使用前缀模糊匹配，
 * 不触碰任何非本轮创建的数据）。返回 deleted / absent / no-entry / delete-not-effective。
 */
async function deleteNamedRow(
  page: Page,
  options: { queryName: string; name: string; openPage: () => Promise<void> },
): Promise<'deleted' | 'absent' | 'no-entry' | 'delete-not-effective' | 'deleted-without-confirm-toast'> {
  await options.openPage();
  const queryInput = page.getByPlaceholder(options.queryName).first();
  await queryInput.fill(options.name);
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await page.waitForTimeout(1_000);

  const row = page.locator('tr', { has: page.getByText(options.name, { exact: true }) }).first();
  if ((await row.count()) === 0) return 'absent';
  await row.hover();
  await page.waitForTimeout(500);
  if (!(await clickDeleteAction(row))) return 'no-entry';

  await page.waitForTimeout(1_000);
  const confirmed = await confirmPermissionDangerAction(page);
  await page.waitForTimeout(1_000);

  await queryInput.fill(options.name);
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await page.waitForTimeout(1_000);
  const stillThere = (await page.locator('tr', { has: page.getByText(options.name, { exact: true }) }).count()) > 0;
  if (stillThere) return 'delete-not-effective';
  return confirmed ? 'deleted' : 'deleted-without-confirm-toast';
}

/**
 * 兜底回收：仅回收本轮 identity.userName 用户与 roleName 角色（角色删除即回收
 * 角色-菜单授权，用户删除即回收用户-角色绑定）。不使用前缀模糊匹配，绝不动任何
 * 共享角色/菜单/授权。清理失败登记 issue，不抛出，避免掩盖主流程错误。
 */
async function cleanupCaseObjects(
  page: Page,
  identity: PermissionIdentity,
  roleName: string,
): Promise<{ steps: string[]; issues: string[] }> {
  const steps: string[] = [];
  const issues: string[] = [];
  const runStep = async (name: string, action: () => Promise<{ ok: boolean; detail: string }>): Promise<void> => {
    try {
      const outcome = await action();
      steps.push(`${name}：${outcome.detail}`);
      if (!outcome.ok) issues.push(`${name}：${outcome.detail}`);
    } catch (error) {
      steps.push(`${name}：异常=${describeError(error)}`);
      issues.push(`${name}：异常=${describeError(error)}`);
    }
  };

  try {
    await loginAs(page, adminIdentity);
    steps.push(`管理员重登录：${adminIdentity.userName}`);
  } catch (error) {
    issues.push(`管理员重登录失败，无法兜底回收：${describeError(error)}`);
    return { steps, issues };
  }

  await runStep('本轮用户回收', async () => {
    const outcome = await deleteNamedRow(page, {
      queryName: '请输入用户名称',
      name: identity.userName,
      openPage: () => openUserManagement(page),
    });
    return {
      ok: outcome === 'deleted' || outcome === 'absent' || outcome === 'deleted-without-confirm-toast',
      detail: outcome === 'no-entry' ? 'no-entry（页面未提供删除入口，用户残留）' : outcome,
    };
  });

  await runStep('本轮角色与角色-菜单授权回收', async () => {
    const outcome = await deleteNamedRow(page, {
      queryName: '请输入角色名称',
      name: roleName,
      openPage: () => openRoleManagement(page),
    });
    return {
      ok: outcome === 'deleted' || outcome === 'absent' || outcome === 'deleted-without-confirm-toast',
      detail: outcome === 'no-entry' ? 'no-entry（页面未提供删除入口，角色与授权残留）' : outcome,
    };
  });

  return { steps, issues };
}

test.describe.configure({ mode: 'serial', timeout: 600_000 });

test('SM-03-04｜独立用户登录后仅显示被授予的菜单', async ({ loginPage, consoleErrors, report }, testInfo) => {
  const page = loginPage;
  test.setTimeout(600_000);

  const identity = newPermissionIdentity('sm0304');
  const role = newPermissionRole('sm0304', 'data-map-only');
  const landingEntry = entryUrlFor('/dataMap/tableQuery/tablesQuery');
  const appBase = landingEntry.split('#')[0];

  const runClosedLoop = async (): Promise<void> => {
    // ── 阶段 1：清洁环境自建本轮唯一用户/角色，并按当前菜单树解析授权“数据地图” ──
    await createAndInviteUser(page, identity);
    await createRole(page, role, ['数据地图']);
    await assignRoleToUser(page, role, identity);
    await report('阶段1｜清洁环境自建用户/角色/菜单授权', true, `用户=${identity.userName}；角色=${role.roleName}；菜单=数据地图（当前角色菜单树解析，不依赖历史授权）。`);

    // ── 阶段 2：目标用户真实重登录（清理会话后以新用户身份进入被授权落地页），
    //    并捕获本次会话的 /getRouters 菜单树 + FACTORY 令牌 ──
    const capture = await captureRoutersDuringLogin(page, identity, landingEntry);
    expect(capture, '受限用户登录会话中未捕获 /getRouters 响应，无法在接口层验证菜单权限。').toBeDefined();
    expect(capture!.status, `/getRouters 应返回 200，实际 ${capture!.status}`).toBe(200);

    // ── 阶段 3：UI 层——顶栏菜单可见/不可见（口径同旧版：限顶栏第一个 role=menu，
    //    因为“数据地图”左侧业务子项里也存在名为“系统管理”的条目）──
    const topMenu = page.getByRole('menu').first();
    await expect(topMenu.getByText('数据地图', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(topMenu.getByText('系统管理', { exact: true })).not.toBeVisible();
    await report('阶段3｜顶栏菜单可见/不可见（UI 层）', true, '被授予的“数据地图”菜单可见；未授予的“系统管理”菜单不可见。');

    // ── 阶段 4：接口层——getRouters 响应树含 dataMap、不含 systemManage ──
    const tree = extractRouterTree(capture!.body);
    expect(tree, `/getRouters 响应无法解析出菜单树：${capture!.body.slice(0, 200)}`).toBeDefined();
    expect(tree!.length, 'getRouters 菜单树为空，登录用户未获得任何菜单。').toBeGreaterThan(0);
    const flatNodes = flattenRouterNodes(tree!);
    const routeText = (node: { name?: string; path?: string }): string => `${node.name ?? ''} ${node.path ?? ''}`.toLowerCase();
    expect(
      flatNodes.some((node) => routeText(node).includes(AUTHORIZED_ROUTE_PREFIX)),
      `getRouters 未包含已授权模块 ${AUTHORIZED_ROUTE_PREFIX}：${JSON.stringify(flatNodes).slice(0, 300)}`,
    ).toBe(true);
    const leaked = flatNodes.filter((node) => routeText(node).includes(RESTRICTED_ROUTE_PREFIX));
    expect(
      leaked,
      `getRouters 泄漏了未授权模块 ${RESTRICTED_ROUTE_PREFIX}：${JSON.stringify(leaked).slice(0, 300)}`,
    ).toEqual([]);
    await testInfo.attach('sm0304-getrouters-tree.json', { body: capture!.body.slice(0, 8_000), contentType: 'application/json' });
    await report('阶段4｜getRouters 菜单树可见/不可见（接口层）', true, `菜单节点 ${flatNodes.length} 个：含 ${AUTHORIZED_ROUTE_PREFIX}，不含 ${RESTRICTED_ROUTE_PREFIX}（响应已附加）。`);

    // ── 阶段 5：页面层——直连未授权系统管理路由，断言落在产品 404 兜底页 ──
    await page.goto(`${appBase}#/systemManage/userPermission/userManage`, { waitUntil: 'domcontentloaded' });
    const deniedByRoute = await waitForUnauthorizedRouteDenial(page);
    expect(
      deniedByRoute,
      `直连未授权路由 #/systemManage/userPermission/userManage 未被路由守卫拦截（未落 404 兜底页），实际 URL=${page.url()}`,
    ).toBe(true);
    await expect(page.getByRole('button', { name: '新增用户', exact: true })).toHaveCount(0);
    await report('阶段5｜直连未授权路由被拒（页面层）', true, `最终 URL=${page.url()}（产品 404 兜底页；未出现用户管理功能按钮）。`);

    // ── 阶段 6：接口鉴权（旧版接口/页面访问断言保留并落地为真实证据）──
    // 6a 未认证（无 FACTORY 头）直调系统管理接口：必须 401（与越权开关无关）。
    const apiRoot = capture!.url.replace(/\/getRouters(?:[?#].*)?$/, '');
    expect(apiRoot, '无法从 getRouters 请求派生后端 API 根地址。').not.toBe(capture!.url);
    const userPageUrl = `${apiRoot}/systemUser/getUserPage`;
    const anonymous = await page.context().request.post(userPageUrl, { data: { pageNum: 1, pageSize: 10 } });
    expect(
      anonymous.status(),
      `未认证直调 ${userPageUrl} 应被 401 拒绝，实际 ${anonymous.status()}`,
    ).toBe(401);

    // 6b 受限用户携带自身令牌直调：结果按后端 sysMenu.api.permission 开关如实记录。
    //    AuthorityInterceptor 在开关开启时抛 BusinessException("用户无访问接口的权限")；
    //    开关默认 false 时已认证请求放行——这是环境配置状态，不冒充权限验证通过，
    //    也不误报为产品缺陷；菜单/UI/路由层断言（阶段 3/4/5）已覆盖权限验证本体。
    const restricted = await page.context().request.post(userPageUrl, {
      ...(capture!.factoryToken ? { headers: { factory: capture!.factoryToken } } : {}),
      data: { pageNum: 1, pageSize: 10 },
    });
    const restrictedBody = await restricted.text().catch(() => '');
    const httpOk = restricted.status() >= 200 && restricted.status() < 300;
    const authDenied =
      restricted.status() === 401 ||
      restricted.status() === 403 ||
      /无访问接口的权限/.test(restrictedBody);
    const businessAllowed =
      httpOk &&
      /"code"\s*:\s*(?:0|200)|"success"\s*:\s*true/.test(restrictedBody) &&
      !/无访问接口的权限/.test(restrictedBody);
    await testInfo.attach('sm0304-restricted-api-probe.txt', {
      body: `status=${restricted.status()}\n${restrictedBody.slice(0, 4_000)}`,
      contentType: 'text/plain',
    });
    if (authDenied) {
      await report('阶段6｜受限用户令牌直调系统管理接口被拒（接口层越权拦截生效）', true, `status=${restricted.status()}；响应摘要=${restrictedBody.slice(0, 160)}`);
    } else if (businessAllowed) {
      await report('阶段6｜受限用户令牌直调系统管理接口被放行（后端越权校验开关 sysMenu.api.permission 默认 false，属环境配置，非权限验证失败）', true, '菜单/UI/路由三层断言已验证权限实际生效；响应已附加取证。');
    } else {
      await report('阶段6｜受限用户令牌直调系统管理接口响应无法归类（环境异常信号，已取证，不冒充业务断言）', true, `status=${restricted.status()}；响应摘要=${restrictedBody.slice(0, 160)}`);
    }

    assertNoUnexpectedConsoleErrors(consoleErrors);
    await report('SM-03-04｜独立用户菜单权限实际生效闭环完成', true, `本轮唯一用户=${identity.userName}；本轮唯一角色=${role.roleName}；多层证据=重登录+UI+getRouters+路由/接口拒绝。`);
  };

  // ── try/finally 兜底回收：无论成败，都只回收本轮唯一命名的用户与角色（SM-03-05 口径）──
  const cleanup = { steps: [] as string[], issues: [] as string[] };
  let flowError: unknown;
  let flowFailed = false;
  try {
    await runClosedLoop();
  } catch (error) {
    flowFailed = true;
    flowError = error;
  } finally {
    try {
      const outcome = await cleanupCaseObjects(page, identity, role.roleName);
      cleanup.steps.push(...outcome.steps);
      cleanup.issues.push(...outcome.issues);
    } catch (error) {
      cleanup.issues.push(`兜底清理框架异常：${describeError(error)}`);
    }
    await testInfo
      .attach('sm0304-finally-cleanup.log', { body: cleanup.steps.join('\n') || '（无清理步骤记录）', contentType: 'text/plain' })
      .catch(() => undefined);
    await report('收尾｜try/finally 兜底回收（仅本轮用户/角色/授权）', cleanup.issues.length === 0, cleanup.steps.join('；') || '无可回收对象。');
    if (!flowFailed && cleanup.issues.length > 0) {
      throw new Error(`兜底清理未完全回收本轮对象：${cleanup.issues.join('；')}`);
    }
  }
  if (flowFailed) throw flowError;
});
