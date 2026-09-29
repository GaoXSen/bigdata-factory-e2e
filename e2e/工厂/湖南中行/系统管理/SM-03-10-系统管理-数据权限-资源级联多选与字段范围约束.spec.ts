/**
 * 系统管理 E2E 测试 — 数据权限：资源级联多选与字段范围约束（DS-PERM-14 清洁环境校准）
 *
 * 覆盖场景（权限与审批测试理解.md §11.1-5/6、§11.5）：
 *   1. 级联空态：固定·勾选模式下已选 数据源类型/数据源、未选 数据库/数据表 时，
 *      “确定”应禁用或提交被校验拦截（不得落库全 NULL 通配授权；动态·全部模式
 *      允许空=全部属产品设计，本用例不在动态模式下做空态提交）；
 *   2. 单表选择：出现“全部字段/部分字段”字段范围控件且默认“全部字段”（字段多选
 *      不出现）；切“部分字段”出现该表字段多选；切回“全部字段”字段多选收起；
 *   3. 保存“部分字段”授权：用户/资源双视角回显 + 编辑弹窗回显已选字段；
 *   4. 字段级实际访问：授予字段可查询；未授予字段应被拦截（若当前版本只在保存层
 *      记录字段范围、查询层不拦截，按产品能力差异记录 annotation，不判失败）；
 *   5. 多表选择（多选上级禁止选择下级）：已选 ≥2 张数据表后，字段范围下级不得再选
 *      “部分字段”（隐藏/禁用/不可交互其一；可点且出现字段多选时，保存必须被拦截，
 *      否则按产品缺陷候选显式失败并尽力回收）。
 *
 * 资源边界与回收（DS-PERM-14，模板 SM-03-06 / DS-PERM-09 先例）：
 *   - 本轮自备主体与专用表：申请人/角色为 UUID 唯一命名（newPermissionIdentity /
 *     newPermissionRole），两张专用表 e2e_sm0310_<uuid> / e2e_sm0310x_<uuid> 以 CREATE
 *     TABLE 直建于 DB_* 配置库（同库，第二张供用例 2 多选约束；不再依赖
 *     DATA_PERMISSION_TABLE / DATA_PERMISSION_TABLE_2 历史固化表与硬编码兜底表名）。
 *   - requirePermissionApprovalEnvironment 门禁：未设 RUN_PERMISSION_APPROVAL=1 跳过；
 *     DB_* 未配置或非 MySQL 时按前置不足跳过（无法创建本轮专用表）。
 *   - finally 只回收本轮资源：兜底删除 本轮主体×两张表 授权 → DROP 两张专用表 → 尽力
 *     删除本轮申请人账号（失败暴露不掩盖主结果）；角色按 SM-00-02 先例保留（唯一命名
 *     不影响回归）。串行模式下用例 1 失败即由其 finally 全套回收（用例 2 会被跳过）；
 *     用例 1 成功则夹具留存给用例 2，由用例 2 的 finally 收尾。不触碰既有业务数据。
 *
 * 静态开发说明（2026-09-22 DS-PERM-14：MySQL 110 ECONNRESET，静态校准 + tsc 验证）：
 *   - 字段范围控件与字段多选形态未见录制稿：按“标签文本 + 行为信号（出现/消失）”
 *     定位，不依赖样式类名；TODO[env] 环境恢复后 --headed 校准。
 *   - 部门主体相关验证见 SM-03-11。
 *
 * 静态完善说明（2026-09-22 DS-PERM-56：清洁环境迁移收尾，仅静态开发）：
 *   - 数据源/数据库/Schema 改由配置中心（e2e/test-environment.ts，ENV-CONFIG-40）
 *     解析：类型/数据源取 dataSourceNames.query；数据库/Schema 以本轮专用表实际
 *     建表连接库（dbConfig().database）兜底，保证授权级联与建表同库；DATA_PERMISSION_*
 *     显式环境变量仍可覆盖。被清空环境不再隐式依赖共享工具内的固定兜底数据源名。
 *   - 修复阶段2 切回“全部字段”的断言方向：原 poll 断言 .toBe(false) 与“字段多选
 *     应收起”语义相反（产品正确收起时反而失败），改为 .toBe(true)。
 *   - 本轮授权标签=专用表名（e2e_sm0310_* / e2e_sm0310x_* + UUID，每轮唯一 ASCII），
 *     作为授权行定位（uniqueText）与 finally 回收的唯一切分依据。
 *
 * 双入口修复说明（2026-09-22 DS-PERM-59：硬链接双入口模块解析回归修复，仅静态开发）：
 *   - 本正文与 e2e/sm-static/SM-03-10.spec.ts 为同一硬链接，必须双目录均可被 Playwright
 *     加载；DS-PERM-56 引入的 '../../../test-environment.js' 直连导入，其相对深度只在
 *     中文权威目录成立，sm-static 侧 --list 报 Cannot find module。
 *   - 改经 '../utils.js'（两侧镜像同构、均可解析）触发 e2e/test-environment.ts（配置
 *     中心）加载：配置中心首次解析会把 QUERY_SOURCE_TYPE / QUERY_SOURCE_NAME /
 *     QUERY_SCHEMA 按 profile 基线回填 process.env（显式变量优先，与
 *     testEnvironment.dataSourceNames.query 同名同源）。本文件改读同名变量，配置中心
 *     语义不变，spec 内不持有展示名兜底值，回填缺失时显式失败、不硬编码、不 skip。
 */
import type { Locator, Page } from '@playwright/test';
import {
  chooseConfiguredDataSource,
  dbConfig,
  executeSql,
  expect,
  query,
  test,
  uuid,
} from '../utils.js';
import {
  assignRoleToUser,
  createAndInviteUser,
  createRole,
  loginAs,
  newPermissionIdentity,
  newPermissionRole,
  openUserManagement,
  type PermissionIdentity,
} from './权限测试工具.js';
import {
  closePermissionDialog,
  type DataPermissionTypeFlag,
  deletePermissionFromRow,
  findPermissionRow,
  findResourceViewAuthorizationRow,
  type MysqlPermissionResource,
  openDataPermissionPage,
  openPermissionEditDialog,
  openUserViewCreateDialog,
  queryUserViewPermissionRow,
  refreshPermissionList,
  requirePermissionTableName,
  resolveMysqlPermissionResource,
  selectPermissionSource,
  selectPermissionSourceType,
  selectPermissionTableScope,
  selectUserViewSubject,
  setPermissionExpiry,
  setPermissionTypes,
  submitPermissionDialog,
  switchResourceViewScopeTab,
} from './数据权限闭环工具.js';
import { requirePermissionApprovalEnvironment } from './权限审批待调试工具.js';

/**
 * 以下两个 helper 在 e2e/utils.ts 未导出（仅权威目录 工厂/湖南中行/utils.ts 提供）。
 * 为保持 sm-static ↔ 工厂 硬链接 twin 双侧可编译（两侧 '../utils.js' 解析到不同
 * 文件），按权威实现本地复刻，不跨中文路径导入（PERM-STATIC-03 静态开发 2026-09-21）。
 */
/** 异常路径用例允许页面把后端拒绝结果记录为 4xx/5xx；只过滤已声明的预期失败信号。 */
async function assertNoUnexpectedConsoleErrors(
  consoleErrors: string[],
  expectedFailurePatterns: RegExp[],
): Promise<void> {
  const unexpected = consoleErrors.filter((error) =>
    !expectedFailurePatterns.some((pattern) => pattern.test(error)),
  );
  expect(
    unexpected,
    `控制台出现未声明错误：\n${unexpected.join('\n')}\n\n本次已允许的预期异常：\n${consoleErrors.filter((error) => !unexpected.includes(error)).join('\n')}`,
  ).toEqual([]);
}

/**
 * 自助查询侧栏在部分版本只渲染图标链接，没有“自助查询”可定位文本。
 * 已登录时直接进入已知 hash 路由，避免菜单已完成跳转后仍因找不到文字而失败。
 */
async function openSelfServiceQuery(page: Page): Promise<void> {
  const route = '#/dataQuery/selfServiceQuery';
  const targetUrl = (): string => {
    const target = new URL(page.url());
    // URL.hash 赋值时不再携带 #，避免不同 Chromium 版本出现 ##/ 路由差异。
    target.hash = route.slice(1);
    return target.toString();
  };
  const sideLink = page.locator(`a[href*="${route}"]:visible`).last();
  if (await sideLink.isVisible().catch(() => false)) {
    await sideLink.click({ force: true });
    await page.waitForURL(new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).catch(() => undefined);
  } else if (!page.url().includes(route)) {
    await page.goto(targetUrl(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
  }
  const pageReady = async (): Promise<boolean> => await expect.poll(async () =>
    ((await page.getByText('选择数据源', { exact: true }).count()) > 0
      && await page.getByText('选择数据源', { exact: true }).filter({ visible: true }).count() > 0)
    || ((await page.getByText('请选择数据源', { exact: true }).count()) > 0
      && await page.getByText('请选择数据源', { exact: true }).filter({ visible: true }).count() > 0)
    || (await page.locator('.datasource-select:visible').count()) > 0
    || (await page.locator('.monaco-editor:visible, .view-lines:visible').count()) > 0
    || await page.getByRole('textbox', { name: /Editor content;Press Alt\+F1/ }).isVisible().catch(() => false),
    { timeout: 5_000 },
  ).toBe(true).then(() => true, () => false);
  if (!await pageReady() && !page.url().includes(route)) {
    // 顶部“数据查询”主菜单点击后可能直接落到自助查询页，直接重试目标 hash。
    await page.goto(targetUrl(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
  }
  await expect.poll(async () =>
    ((await page.getByText('选择数据源', { exact: true }).count()) > 0
      && await page.getByText('选择数据源', { exact: true }).filter({ visible: true }).count() > 0)
    || ((await page.getByText('请选择数据源', { exact: true }).count()) > 0
      && await page.getByText('请选择数据源', { exact: true }).filter({ visible: true }).count() > 0)
    || (await page.locator('.datasource-select:visible').count()) > 0
    || (await page.locator('.monaco-editor:visible, .view-lines:visible').count()) > 0
    || await page.getByRole('textbox', { name: /Editor content;Press Alt\+F1/ }).isVisible().catch(() => false),
    { timeout: 20_000 },
  ).toBe(true);
}

/** 本轮自备主体：申请人/角色均为 UUID 唯一命名，不依赖 SM-00-01 固化夹具（DS-PERM-14）。 */
const applicant = newPermissionIdentity('sm0310');
const applicantRole = newPermissionRole('sm0310', 'applicant');

/**
 * 配置中心同源读取（DS-PERM-59 双入口修复）：本正文同时被 e2e/sm-static 与中文权威目录
 * 加载，不能直接 import '../../../test-environment.js'（该相对深度只在权威目录成立）。
 * '../utils.js' 双侧均可解析，且其内部加载 e2e/test-environment.ts；配置中心首次解析会把
 * QUERY_SOURCE_TYPE / QUERY_SOURCE_NAME / QUERY_SCHEMA 按 profile 基线回填 process.env
 * （显式变量优先，与 testEnvironment.dataSourceNames.query 同名同源）。此处按同名变量
 * 读取，spec 内不持有任何数据源展示名兜底值；回填缺失说明配置中心加载链被破坏，显式
 * 失败，不回退硬编码。
 */
function configuredQuerySource(): { type: string; name: string; database: string; schema: string } {
  const type = process.env.QUERY_SOURCE_TYPE?.trim() ?? '';
  const name = process.env.QUERY_SOURCE_NAME?.trim() ?? '';
  const database = process.env.QUERY_SCHEMA?.trim() ?? '';
  if (!type || !name || !database) {
    throw new Error(
      '配置中心同源变量缺失：QUERY_SOURCE_TYPE / QUERY_SOURCE_NAME / QUERY_SCHEMA 出现空值。' +
        '本用例经 ../utils.js 加载 e2e/test-environment.ts（ENV-CONFIG-40）后，应由配置中心' +
        '首次解析的兼容回填提供上述变量（与 dataSourceNames.query 同名同源）；请检查配置' +
        '中心加载与回填逻辑（DS-PERM-59），不得在用例内硬编码数据源展示名。',
    );
  }
  return { type, name, database, schema: database };
}

const configQuerySource = configuredQuerySource();
/** 本轮专用表的物理落库：dbConfig().database（CREATE 同库）；DB 未配置时退配置中心显示库。 */
const roundDatabase = dbConfig()?.database.trim() || configQuerySource.database;
const permissionResource: MysqlPermissionResource = resolveMysqlPermissionResource({
  tableName: `e2e_sm0310_${uuid()}`,
  sourceTypeName: process.env.DATA_PERMISSION_SOURCE_TYPE?.trim() || configQuerySource.type,
  sourceName: process.env.DATA_PERMISSION_SOURCE_NAME?.trim() || configQuerySource.name,
  databaseName: process.env.DATA_PERMISSION_DATABASE?.trim() || roundDatabase,
  schemaName: process.env.DATA_PERMISSION_SCHEMA?.trim() || roundDatabase,
});
const tableName = requirePermissionTableName(permissionResource);
/** 多表约束验证用的第二张表（同库自建；DS-PERM-14 起不再依赖 DATA_PERMISSION_TABLE_2）。 */
const secondTableName = `e2e_sm0310x_${uuid()}`;
const querySourceName = (process.env.QUERY_SOURCE_NAME?.trim() || permissionResource.sourceName)
  .split(/[:：]/)[0].trim();
const adminIdentity = {
  userName: (process.env.TEST_USER ?? 'admin').trim(),
  nickname: (process.env.TEST_USER ?? 'admin').trim(),
  password: process.env.TEST_PASS ?? '',
  phone: '',
  email: '',
};

const FIELD_SCOPE_ALL = /全\s*部\s*字\s*段/;
const FIELD_SCOPE_PARTIAL = /部\s*分\s*字\s*段/;
/** Ant/Element 双兼容下拉选项选择器（与共享工具 PERMISSION_OPTION_SELECTOR 一致）。 */
const OPTION_SELECTOR = [
  '.ant-select-dropdown:visible .ant-select-item-option',
  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
  '.el-select-dropdown:visible .el-select-dropdown__item',
  '[role="listbox"]:visible [role="option"]',
  'li[role="option"]:visible',
].join(', ');

/** 返回 locator 中第一个可见元素（与共享工具 firstVisible 语义一致，本文件自持）。 */
async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

/** 在 scope 中找文本匹配 pattern 的可见节点；找不到时抛出带页面上下文的明确错误。 */
async function mustText(scope: Locator, pattern: RegExp, label: string): Promise<Locator> {
  const node = await firstVisible(scope.getByText(pattern));
  if (!node) {
    throw new Error(`权限弹窗未找到“${label}”选项/控件（需按实际页面校准控件形态），当前页面：${scope.page().url()}`);
  }
  return node;
}

/** 选项/控件是否禁用（自身或 4 层祖先带 disabled/aria-disabled/is-disabled 语义）。 */
async function isDisabledState(item: Locator): Promise<boolean> {
  return item
    .evaluate((element) => {
      let node: HTMLElement | null = element as HTMLElement;
      for (let level = 0; level < 4 && node; level += 1) {
        if (node.hasAttribute('disabled')) return true;
        if (node.getAttribute('aria-disabled') === 'true') return true;
        if (/(^|\s)(disabled|is-disabled)(\s|$)/.test(node.getAttribute('class') ?? '')) return true;
        node = node.parentElement;
      }
      return false;
    })
    .catch(() => false);
}

/** 当前可见 combobox 数量（用于识别“部分字段”新渲染的字段选择控件）。 */
async function visibleComboboxCount(scope: Locator): Promise<number> {
  const boxes = scope.getByRole('combobox');
  let visible = 0;
  for (let index = 0; index < await boxes.count(); index += 1) {
    if (await boxes.nth(index).isVisible().catch(() => false)) visible += 1;
  }
  return visible;
}

/**
 * 定位“部分字段”切换后新出现的字段选择控件：优先可见 combobox 数量增量（增量控件
 * 的最后一个），否则退回复选组/穿梭框形态；找不到返回 undefined（= 字段多选未出现）。
 * TODO[env]：字段多选实际形态（multi-select / checkbox-group / transfer）待校准。
 */
async function detectFieldSelectionControl(dialog: Locator, baselineCount: number): Promise<Locator | undefined> {
  const boxes = dialog.getByRole('combobox');
  const total = await boxes.count();
  let visibleCount = 0;
  let lastVisible: Locator | undefined;
  for (let index = 0; index < total; index += 1) {
    const box = boxes.nth(index);
    if (await box.isVisible().catch(() => false)) {
      visibleCount += 1;
      lastVisible = box;
    }
  }
  if (visibleCount > baselineCount && lastVisible) return lastVisible;
  return firstVisible(dialog.locator(
    '.el-checkbox-group:visible, [role="group"]:visible, .ant-transfer:visible, .el-transfer:visible',
  ));
}

/** 读取字段选择控件当前已选字段名（多选标签 → 复选组回退）。 */
async function readSelectedFields(control: Locator): Promise<string[]> {
  const names: string[] = [];
  const tags = control.locator(
    '.ant-select-selection-item:visible, .ant-select-selection-item-content:visible, .el-select__tags .el-tag:visible, .el-tag:visible, .ant-tag:visible',
  );
  for (let index = 0; index < await tags.count(); index += 1) {
    const text = (await tags.nth(index).innerText().catch(() => '')).trim();
    if (text && !names.includes(text)) names.push(text);
  }
  if (names.length) return names;
  const boxes = control.locator('input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"]');
  for (let index = 0; index < await boxes.count(); index += 1) {
    const label = boxes.nth(index).locator('xpath=ancestor::label[1]');
    const text = (await (await label.count() ? label : boxes.nth(index)).innerText().catch(() => '')).trim();
    if (text && !names.includes(text)) names.push(text);
  }
  return names;
}

/** 从字段选择控件中勾选 count 个字段（跳过已选项），返回字段名列表（不足返回实际数量）。 */
async function chooseFieldsFromControl(page: Page, control: Locator, count: number): Promise<string[]> {
  const chosen: string[] = [];
  const role = await control.getAttribute('role').catch(() => null);
  const dropdownStyle = role === 'combobox' || (await control.locator('input:visible').count()) > 0;
  if (dropdownStyle) {
    const searchInput = control.locator('input:visible').first();
    for (let round = 0; round < count; round += 1) {
      await control.click().catch(() => undefined);
      await page.waitForTimeout(500);
      const options = page.locator(OPTION_SELECTOR).filter({ hasNotText: /全选|反选|暂无数据|没有数据/ });
      let pickedThisRound = false;
      const total = await options.count();
      for (let index = 0; index < total; index += 1) {
        const option = options.nth(index);
        const text = (await option.innerText().catch(() => '')).trim();
        if (!text || chosen.includes(text)) continue;
        const classes = await option.evaluate((el) => el.getAttribute('class') ?? '').catch(() => '');
        if (/(^|\s)(selected|is-selected)(\s|$)|ant-select-item-option-selected/.test(classes)) {
          chosen.push(text);
          pickedThisRound = true;
          break;
        }
        await option.click();
        chosen.push(text);
        pickedThisRound = true;
        break;
      }
      if (!pickedThisRound) break;
      // 多选下拉不因选择自动关闭；单击控件收起，避免遮挡后续断言。
      await control.click().catch(() => undefined);
      await page.waitForTimeout(250);
      if (await searchInput.count()) {
        await searchInput.fill('').catch(() => undefined);
      }
    }
  } else {
    const boxes = control.locator('input[type="checkbox"], [role="checkbox"]');
    const total = await boxes.count();
    for (let index = 0; index < total && chosen.length < count; index += 1) {
      const box = boxes.nth(index);
      const label = box.locator('xpath=ancestor::label[1]');
      const text = (await (await label.count() ? label : box).innerText().catch(() => '')).trim();
      if (!text) continue;
      if (await box.isChecked().catch(() => false)) {
        if (!chosen.includes(text)) chosen.push(text);
        continue;
      }
      await box.click({ force: true }).catch(() => undefined);
      chosen.push(text);
    }
  }
  return chosen;
}

/** 取消勾选指定字段（先试标签关闭按钮，再试下拉内反选）；返回是否成功。 */
async function deselectField(page: Page, control: Locator, name: string): Promise<boolean> {
  const tag = control.locator('.ant-select-selection-item, .el-tag, .ant-tag').filter({ hasText: name }).first();
  if (await tag.count()) {
    const close = tag.locator('.ant-select-selection-item-remove, .anticon-close, .el-tag__close, .ant-tag-close-icon').first();
    if (await close.count()) {
      await close.click().catch(() => undefined);
      await page.waitForTimeout(300);
      return true;
    }
  }
  await control.click().catch(() => undefined);
  await page.waitForTimeout(400);
  const option = await firstVisible(page.locator(OPTION_SELECTOR).filter({ hasText: name }));
  if (option) {
    await option.click().catch(() => undefined);
    await control.click().catch(() => undefined);
    await page.waitForTimeout(300);
    return true;
  }
  await control.click().catch(() => undefined);
  return false;
}

/** 按标签文本上溯定位“数据表”级联下拉（多表追加选择；共享工具未导出内部定位器）。 */
async function openTableCascadeSelect(dialog: Locator): Promise<Locator> {
  const labelNode = dialog.getByText(/^数据表$/, { exact: true }).first();
  let scope: Locator = labelNode;
  for (let level = 0; level < 5; level += 1) {
    const box = await firstVisible(
      scope.locator('.el-select:visible, .ant-select:visible, [role="combobox"]:visible, select:visible'),
    );
    if (box) return box;
    scope = scope.locator('..');
  }
  throw new Error('权限弹窗未找到“数据表”级联下拉（多表追加选择），需校准级联控件结构。');
}

/** 在当前打开的下拉中点选指定选项；选项可能需搜索过滤（级联表下拉可搜索）。 */
async function pickDropdownOption(page: Page, control: Locator, value: string): Promise<void> {
  const searchInput = control.locator('input:visible').first();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const option = await firstVisible(page.locator(OPTION_SELECTOR).filter({ hasText: value }));
      if (option) {
        await option.click();
        return;
      }
      await page.waitForTimeout(300);
    }
    if (attempt === 0 && await searchInput.count()) {
      await searchInput.fill(value).catch(() => undefined);
      await page.waitForTimeout(800);
    }
  }
  throw new Error(`下拉中未找到选项“${value}”（8 秒内，含搜索重试），需校准多选控件的选项渲染。`);
}

/** “刷新数据库元数据”确认弹窗处理（复制自 SM-03-06 已实证实现）。 */
async function confirmMetadataRefreshDialog(page: Page, timeoutMs = 8_000): Promise<boolean> {
  const dialog = page.getByRole('dialog', { name: /刷新数据库元数据/ });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await dialog.isVisible().catch(() => false)) break;
    await page.waitForTimeout(250);
  }
  if (!(await dialog.isVisible().catch(() => false))) return false;
  await dialog.getByRole('button', { name: /确\s*定/ }).first().click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await page.waitForTimeout(2_500);
  return true;
}

/** 自助查询验证前刷新数据库元数据（目录控件未渲染时安全跳过；同 SM-03-06）。 */
async function refreshDatabaseMetadata(page: Page): Promise<void> {
  const treeSearch = page.getByRole('textbox', { name: /搜索表名|存储过程/ });
  if (!(await treeSearch.isVisible().catch(() => false))) return;
  const reloadIcon = treeSearch.locator(
    'xpath=parent::*[1]/following-sibling::*[contains(@aria-label,"reload")][1]',
  );
  if (!(await reloadIcon.isVisible().catch(() => false))) return;
  await reloadIcon.click({ timeout: 2_000 }).catch(() => undefined);
  await confirmMetadataRefreshDialog(page).catch(() => undefined);
}

/**
 * 查询执行状态：done=结果列头出现 marker；denied=权限拦截文案（表级“没有使用权限”
 * 或字段级权限提示，文案待环境校准）；pending=仍在执行。
 */
async function readQueryOutcome(page: Page, marker: string): Promise<'done' | 'denied' | 'pending'> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/(?:没有|无)[^，。；]{0,8}权限|权限不足/.test(bodyText)) return 'denied';
  const headerCount = await page
    .locator('th:visible, [role="columnheader"]:visible')
    .filter({ hasText: marker })
    .count();
  return headerCount > 0 ? 'done' : 'pending';
}

/** 断言权限行权限类型恰为 expected（复制自 SM-03-06 同名实现）。 */
async function expectRowExactPermissionType(row: Locator, expected: DataPermissionTypeFlag): Promise<void> {
  const raw = await row.innerText({ timeout: 5_000 }).catch(() => '');
  const normalized = raw.replace(/\s+/g, '');
  const other: DataPermissionTypeFlag = expected === '使用' ? '管理' : '使用';
  expect(normalized, `权限行应包含权限类型“${expected}”，实际行文本：${raw}`).toContain(expected);
  expect(
    normalized,
    `权限行不应残留权限类型“${other}”（实际行文本：${raw}）`,
  ).not.toContain(other);
}

/** 清理本轮申请人在“数据表”页签下的残留表权限（页面操作逐条删除），保证从无权限起步。 */
async function purgeStaleTablePermissions(page: Page, tableNames: string[] = [tableName]): Promise<number> {
  await selectUserViewSubject(page, {
    subjectTab: '成员',
    subjectName: applicant.userName,
    subjectAlias: applicant.nickname,
  });
  await switchResourceViewScopeTab(page, '数据表');
  await refreshPermissionList(page);
  let removed = 0;
  for (const name of tableNames) {
    for (let guard = 0; guard < 20; guard += 1) {
      const stale = await findPermissionRow(page, name, 5_000);
      if (!stale) break;
      await deletePermissionFromRow(page, stale, { uniqueText: name });
      removed += 1;
      await refreshPermissionList(page);
    }
  }
  return removed;
}

/**
 * 创建本轮两张唯一专用表并各写入 2 行种子数据（MySQL 直连 DDL，仅本用例资源；模板
 * SM-03-06 createPermissionFixtureTable）。平台数据源/库/表级联来自实时 JDBC 扫描，
 * 建表即对授权下拉与自助查询目录可见；字段范围用例依赖表内 ≥2 个可见字段，故固定
 * sm_id/sm_name/sm_value 三列（授予其一、排除其一）。返回实际种子行数作为夹具证据
 * （建表失败会让用例以真实错误结束，不伪造通过）。
 */
async function createPermissionFixtureTables(): Promise<number> {
  const columns = 'sm_id varchar(64) NOT NULL,'
    + 'sm_name varchar(128) DEFAULT NULL,'
    + 'sm_value varchar(128) DEFAULT NULL,'
    + 'PRIMARY KEY (sm_id)';
  for (const name of [tableName, secondTableName]) {
    await query(
      `CREATE TABLE ${name} (${columns}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    await query(
      `INSERT INTO ${name} (sm_id, sm_name, sm_value) VALUES `
        + `('sm-1', 'e2e-sm0310-a', '${name}'), ('sm-2', 'e2e-sm0310-b', 'field-scope-closed-loop')`,
    );
  }
  for (const name of [tableName, secondTableName]) {
    const rows = await query(`SELECT COUNT(*) AS total FROM ${name}`);
    const total = Number((rows[0] as { total?: unknown } | undefined)?.total ?? -1);
    expect(total, `专用表 ${name} 种子数据应为 2 行，实际：${JSON.stringify(rows)}`).toBe(2);
  }
  return 2;
}

/**
 * 尽力删除本轮申请人账号（用户管理页：按本轮唯一账号查询 → 行内“删除”→ 确认）。
 * 只回收本轮自备账号；任一步不满足都返回说明文本而不抛错，不掩盖主结果。
 */
async function deleteOwnApplicantUser(page: Page, applicant: PermissionIdentity): Promise<string> {
  await openUserManagement(page);
  const search = page.getByRole('textbox', { name: '请输入用户名称' }).first();
  await search.fill(applicant.userName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(800);
  const userText = page.getByText(applicant.userName, { exact: true }).last();
  if (!(await userText.isVisible().catch(() => false))) {
    return '列表未查询到本轮账号（可能此前已删除）';
  }
  const row = userText.locator('xpath=ancestor::tr[1]');
  if (!(await row.isVisible().catch(() => false))) {
    return '账号可见但未取到表格行，跳过页面删除（账号保留）';
  }
  const deleteButton = row.getByRole('button', { name: /删\s*除/ }).first();
  if (!(await deleteButton.isVisible().catch(() => false))) {
    return '行内未找到“删除”按钮，跳过页面删除（账号保留）';
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
  return '已提交删除并确认列表不再显示该账号';
}

/**
 * 收尾回收：仅本轮资源——兜底删除 本轮主体×两张专用表 的授权行 → DROP 两张专用表 →
 * 尽力删除本轮申请人账号（顺序同 SM-03-06 收尾 1/2/3）。每步尽力而为：失败记录为
 * issue 文本返回并在调用方输出，不掩盖主结果。
 */
async function recoverRoundResources(
  page: Page,
  report: (title: string, passed: boolean, details: string) => void | Promise<void>,
): Promise<string[]> {
  const issues: string[] = [];
  try {
    await loginAs(page, adminIdentity);
    await openDataPermissionPage(page);
    const removedFinally = await purgeStaleTablePermissions(page, [tableName, secondTableName]);
    if (removedFinally > 0) {
      await report(
        'SM-03-10 收尾｜兜底回收本轮授权',
        true,
        `删除残留授权 ${removedFinally} 条（表=${tableName}、${secondTableName}）。`,
      );
    }
  } catch (purgeError) {
    issues.push(`授权兜底回收未完成：${purgeError instanceof Error ? purgeError.message.split('，')[0] : String(purgeError)}`);
  }
  try {
    await query(`DROP TABLE IF EXISTS ${tableName}`);
    await query(`DROP TABLE IF EXISTS ${secondTableName}`);
  } catch (dropError) {
    issues.push(`专用表回收未完成（${tableName}、${secondTableName}）：${dropError instanceof Error ? dropError.message : String(dropError)}`);
  }
  try {
    const outcome = await deleteOwnApplicantUser(page, applicant);
    await report('SM-03-10 收尾｜回收本轮申请人账号', true, `${applicant.userName}：${outcome}。`);
  } catch (userError) {
    issues.push(`申请人账号回收未完成：${userError instanceof Error ? userError.message.split('，')[0] : String(userError)}`);
  }
  return issues;
}

test.describe.configure({ mode: 'serial', timeout: 480_000 });

test.describe('SM-03-10｜系统管理｜数据权限-资源级联多选与字段范围约束', () => {
  test('SM-03-10｜单表字段范围：全部/部分切换、字段多选、回显与实际查询', async (
    { loginPage, consoleErrors, report },
    testInfo,
  ) => {
    requirePermissionApprovalEnvironment();

    // 前置门禁：本轮两张专用表需要 MySQL 直连（DB_*，即 MySQL 110）；未配置按前置不足跳过。
    const cfg = dbConfig();
    if (!cfg || cfg.type !== 'mysql') {
      test.skip(
        !cfg || cfg.type !== 'mysql',
        `前置不足：未配置 MySQL 数据库环境（DB_HOST=${process.env.DB_HOST ?? ''}，DB_TYPE=${process.env.DB_TYPE ?? ''}），无法创建本轮唯一专用表。`,
      );
    }

    const page = loginPage;
    const subjectOptions = {
      subjectTab: '成员' as const,
      subjectName: applicant.userName,
      subjectAlias: applicant.nickname,
    };
    const resourceSubjectQuery = { ...subjectOptions, resource: permissionResource };
    const loginAsApplicant = async (): Promise<void> => {
      const entry = new URL(page.url());
      entry.hash = '#/dataQuery/selfServiceQuery';
      const fallbackEntryUrls = ['#/dataAccess/fileAccess', '#/dataMap/tableQuery/tablesQuery', '#/']
        .map((hash) => {
          const url = new URL(entry.toString());
          url.hash = hash;
          return url.toString();
        });
      await loginAs(page, applicant, { entryUrl: entry.toString(), fallbackEntryUrls });
    };

    // 阶段 0a：本轮自备主体与两张专用表（唯一英文前缀，不依赖固化夹具；第二张供用例 2）。
    const seededRows = await createPermissionFixtureTables();
    await report(
      'SM-03-10 阶段0a｜创建本轮申请人身份与两张专用表',
      true,
      `申请人=${applicant.userName}；专用表=${tableName}、${secondTableName}（MySQL 直连创建，各种子 ${seededRows} 行）。`,
    );

    let mainError: unknown;
    try {
      await loginAs(page, adminIdentity);

      // 阶段 0b：创建申请人账号并授予含“数据地图/数据查询”菜单的角色（可进入自助查询）。
      await createAndInviteUser(page, applicant);
      await createRole(page, applicantRole, ['数据地图', '数据查询']);
      await assignRoleToUser(page, applicantRole, applicant);
      await report(
        'SM-03-10 阶段0b｜创建申请人账号并授予查询菜单角色',
        true,
        `角色=${applicantRole.roleName}（菜单：数据地图/数据查询）已分配给 ${applicant.userName}。`,
      );

      // 阶段 0c：元数据缓存预热（同 SM-03-06：授权下拉/自助查询目录能感知本轮新表；
      // 预热失败如实记录，不静默；真正验收仍以阶段 2 字段多选 + 阶段 4 实际查询为准）。
      let metadataWarmup = '目录控件未渲染，按 SM-03-03 语义安全跳过（授权下拉以实时/缓存数据为准）';
      try {
        await openSelfServiceQuery(page);
        await chooseConfiguredDataSource(page, {
          type: permissionResource.sourceTypeName,
          name: querySourceName,
          schema: false,
        });
        await refreshDatabaseMetadata(page);
        metadataWarmup = '自助查询目录已按实时元数据刷新，本轮新表进入平台元数据缓存。';
      } catch (metadataError) {
        metadataWarmup = `预热未完成（不阻断）：${metadataError instanceof Error ? metadataError.message.split('，')[0] : String(metadataError)}`;
      }
      await report('SM-03-10 阶段0c｜刷新数据库元数据（管理员）', true, metadataWarmup);

      // 阶段 0d：清理残留，保证从“无该表权限”起步（全新 UUID 主体正常为 0 条，防御中断轮次）。
      await openDataPermissionPage(page);
      const removedStale = await purgeStaleTablePermissions(page, [tableName, secondTableName]);
      await report(
        'SM-03-10 阶段0d｜残留清理',
        true,
        `主体=${applicant.userName}；表=${tableName}、${secondTableName}；清理残留 ${removedStale} 条。`,
      );

      // 阶段 1：固定·勾选 + 已选数据源、未选 数据库/数据表 → 保存必须被拦截（防通配授权）。
      const emptyDialog = await openUserViewCreateDialog(page);
      await selectPermissionSourceType(page, emptyDialog, permissionResource.sourceTypeName);
      await selectPermissionSource(page, emptyDialog, permissionResource);
      const emptySubmit = emptyDialog.getByRole('button', { name: /确\s*定|保\s*存/ }).last();
      const emptySubmitDisabled = await emptySubmit.isDisabled().catch(() => false);
      if (emptySubmitDisabled) {
        await report(
          'SM-03-10 阶段1｜空级联约束',
          true,
          '固定·勾选模式下未选 数据库/数据表 时“确定”按钮禁用（不得落库全量通配授权）。',
        );
      } else {
        await emptySubmit.click();
        await page.waitForTimeout(1_500);
        if (await emptyDialog.isVisible().catch(() => false)) {
          const hint = await firstVisible(emptyDialog.getByText(/请选择|至少|必选|不能为空/));
          await report(
            'SM-03-10 阶段1｜空级联约束',
            true,
            `未选 数据库/数据表 时提交被校验拦截（弹窗保持打开${hint ? '，提示：' + (await hint.innerText()).trim() : '，未见文案提示'}）。`,
          );
        } else {
          // 提交成功 = 可能落库全 NULL 通配授权（产品约束缺失）。尽力回收后显式失败。
          let cleanupNote = '未能定位到新建的通配授权行，请人工在用户视角核查并删除。';
          try {
            await refreshPermissionList(page);
            const wildcardRow = await findPermissionRow(page, permissionResource.sourceName, 6_000)
              ?? await findPermissionRow(page, tableName, 3_000);
            if (wildcardRow) {
              await deletePermissionFromRow(page, wildcardRow, { uniqueText: permissionResource.sourceName });
              cleanupNote = '已按数据源名定位并删除该授权行。';
            }
          } catch {
            // 保留默认提示。
          }
          throw new Error(
            `约束缺失（产品缺陷候选）：固定·勾选模式下未选 数据库/数据表，“确定”仍提交成功，`
              + `可能已产生全 NULL 通配授权。${cleanupNote} 当前页面：${page.url()}`,
          );
        }
      }
      await closePermissionDialog(page, emptyDialog);

      // 阶段 2：单表 → 字段范围控件与字段多选行为（默认全部字段；部分字段出现多选；切回收起）。
      const dialog = await openUserViewCreateDialog(page);
      await selectPermissionTableScope(page, dialog, permissionResource);
      const baselineCombos = await visibleComboboxCount(dialog);
      const idleControl = await detectFieldSelectionControl(dialog, baselineCombos);
      expect(
        idleControl === undefined || !(await idleControl.isVisible().catch(() => false)),
        '仅选择单表且未切“部分字段”时不应出现字段选择控件（默认应为“全部字段”）',
      ).toBeTruthy();
      await (await mustText(dialog, FIELD_SCOPE_PARTIAL, '部分字段')).click();
      await expect
        .poll(async () => {
          const control = await detectFieldSelectionControl(dialog, baselineCombos);
          return control !== undefined && (await control.isVisible().catch(() => false));
        }, { timeout: 8_000, message: '选择“部分字段”后未出现该表的字段多选控件' })
        .toBe(true);
      const probeControl = await detectFieldSelectionControl(dialog, baselineCombos);
      if (!probeControl) throw new Error('字段选择控件丢失，无法勾选字段。');
      const picked = await chooseFieldsFromControl(page, probeControl, 2);
      if (picked.length < 1) {
        throw new Error(`字段多选中未取到任何字段名（表 ${tableName} 可能无字段或控件形态需校准）。`);
      }
      const probeSelected = await readSelectedFields(probeControl);
      for (const name of picked) {
        expect(probeSelected, `字段多选应回显已勾选字段“${name}”`).toContain(name);
      }
      await (await mustText(dialog, FIELD_SCOPE_ALL, '全部字段')).click();
      await expect
        .poll(async () => {
          const control = await detectFieldSelectionControl(dialog, baselineCombos);
          return control === undefined || !(await control.isVisible().catch(() => false));
        }, { timeout: 8_000, message: '切回“全部字段”后字段多选控件应收起' })
        // DS-PERM-56 修复：回调返回 true=控件已收起；断言必须要求 true（原 .toBe(false)
        // 与“应收起”语义相反，产品正确收起时反而失败）。
        .toBe(true);
      await report(
        'SM-03-10 阶段2｜字段范围切换行为',
        true,
        `单表=${tableName}；“全部字段↔部分字段”往返切换正常；字段多选可见字段示例=${picked.join('、')}。`,
      );

      // 阶段 3：以“部分字段”保存授权（保留第一个字段；若有第二个字段则反选为排除字段）。
      await (await mustText(dialog, FIELD_SCOPE_PARTIAL, '部分字段')).click();
      await expect
        .poll(async () => {
          const control = await detectFieldSelectionControl(dialog, baselineCombos);
          return control !== undefined && (await control.isVisible().catch(() => false));
        }, { timeout: 8_000, message: '重新选择“部分字段”后字段多选未再次出现' })
        .toBe(true);
      const saveControl = await detectFieldSelectionControl(dialog, baselineCombos);
      if (!saveControl) throw new Error('字段选择控件丢失，无法继续保存“部分字段”授权。');
      const excludedCandidate = picked[1];
      if (excludedCandidate) {
        const before = await readSelectedFields(saveControl);
        if (before.includes(excludedCandidate)) {
          const removedField = await deselectField(page, saveControl, excludedCandidate);
          if (!removedField) {
            throw new Error(`无法取消勾选排除字段“${excludedCandidate}”，字段多选交互需校准。`);
          }
        }
      }
      const selectedNow = await readSelectedFields(saveControl);
      let grantedField: string;
      if (selectedNow.length) {
        expect(selectedNow, `保存前字段勾选应包含目标字段（实际=${selectedNow.join('、')}）`).toContain(picked[0]);
        grantedField = picked[0];
      } else {
        const repick = await chooseFieldsFromControl(page, saveControl, 1);
        if (!repick.length) throw new Error('字段多选无法勾选任何字段（往返切换后选择未保留且无法重选），需校准控件。');
        grantedField = repick[0];
      }
      const excludedField = picked[1] && picked[1] !== grantedField ? picked[1] : undefined;
      await setPermissionTypes(page, dialog, ['使用']);
      await setPermissionExpiry(page, dialog, '永久');
      await submitPermissionDialog(page, dialog);
      const createdRow = await queryUserViewPermissionRow(page, resourceSubjectQuery);
      await expect(createdRow).toContainText(tableName);
      await expectRowExactPermissionType(createdRow, '使用');
      const resourceEchoRow = await findResourceViewAuthorizationRow(page, {
        resource: permissionResource,
        subjectName: applicant.userName,
        scopeTab: '数据表',
      });
      if (!resourceEchoRow) {
        throw new Error(`资源视角（数据表页签）未回显用户 ${applicant.userName} 对 ${tableName} 的“使用”授权。`);
      }
      // 编辑弹窗回显：部分字段模式与已选字段名应回填（只读校验后取消关闭，不修改）。
      const editDialog = await openPermissionEditDialog(page, createdRow);
      await expect(editDialog).toContainText(FIELD_SCOPE_PARTIAL);
      await expect(editDialog).toContainText(grantedField);
      await closePermissionDialog(page, editDialog);
      await report(
        'SM-03-10 阶段3｜部分字段授权保存与双视角/编辑回显',
        true,
        `授予字段=${grantedField}${excludedField ? `；排除字段=${excludedField}` : '（表可见字段不足 2 个，未验证排除字段）'}。`,
      );

      // 阶段 4：申请人实际访问——授予字段可查询；排除字段应被拦截（能力差异记 annotation）。
      await loginAsApplicant();
      await openSelfServiceQuery(page);
      await refreshDatabaseMetadata(page);
      await chooseConfiguredDataSource(page, {
        type: permissionResource.sourceTypeName,
        name: querySourceName,
        schema: false,
      });
      const grantMarker = `fldok_${uuid().slice(0, 8)}`;
      await executeSql(page, `SELECT \`${grantedField}\` AS ${grantMarker} FROM ${tableName} LIMIT 1`);
      await expect
        .poll(async () => readQueryOutcome(page, grantMarker), {
          timeout: 30_000,
          message: `授予字段 ${grantedField} 的只读查询未成功返回（字段范围授权未在查询层生效？）`,
        })
        .toBe('done');
      let excludedEvidence = '（表可见字段不足 2 个，未验证排除字段拦截）';
      if (excludedField) {
        const denyMarker = `fldno_${uuid().slice(0, 8)}`;
        await executeSql(page, `SELECT \`${excludedField}\` AS ${denyMarker} FROM ${tableName} LIMIT 1`);
        let finalOutcome: 'done' | 'denied' | 'pending' = 'pending';
        const denyDeadline = Date.now() + 30_000;
        while (Date.now() < denyDeadline) {
          const state = await readQueryOutcome(page, denyMarker);
          if (state !== 'pending') {
            finalOutcome = state;
            break;
          }
          await page.waitForTimeout(500);
        }
        if (finalOutcome === 'denied') {
          excludedEvidence = `排除字段 ${excludedField} 的查询被权限拦截（字段范围在查询层生效）。`;
        } else if (finalOutcome === 'done') {
          excludedEvidence = `产品能力差异：排除字段 ${excludedField} 的查询未被拦截（字段范围仅保存在配置层，查询层未做字段级校验）。`;
          testInfo.annotations.push({ type: 'note', description: excludedEvidence });
        } else {
          excludedEvidence = `排除字段 ${excludedField} 的查询长时间无结果页无拦截文案（疑似执行中或结果区异常），已记录待环境校准。`;
          testInfo.annotations.push({ type: 'warning', description: excludedEvidence });
        }
      }
      await report(
        'SM-03-10 阶段4｜字段级实际访问',
        true,
        `授予字段=${grantedField} 查询成功；${excludedEvidence}`,
      );

      // 阶段 5：删除授权 → 双视角消失 → 申请人复登实际访问被拦截。
      await loginAs(page, adminIdentity, { entryUrl: new URL(page.url()).toString() });
      await openDataPermissionPage(page);
      await selectUserViewSubject(page, subjectOptions);
      const targetRow = await queryUserViewPermissionRow(page, resourceSubjectQuery);
      if (!targetRow) {
        throw new Error(`删除前未找到用户 ${applicant.userName} 对 ${tableName} 的授权行，无法回收。`);
      }
      await deletePermissionFromRow(page, targetRow, { uniqueText: tableName });
      await refreshPermissionList(page);
      const leftover = await findPermissionRow(page, tableName, 5_000);
      if (leftover) {
        throw new Error(`删除后用户视角仍残留 ${tableName} 的授权行，删除未生效。`);
      }
      await loginAsApplicant();
      let blockedEvidence = '';
      try {
        await chooseConfiguredDataSource(page, {
          type: permissionResource.sourceTypeName,
          name: querySourceName,
          schema: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const hiddenByPermission = [
          `下拉选项“${permissionResource.sourceTypeName}”未找到`,
          `下拉选项“${querySourceName}”未找到`,
          '数据源弹窗下拉框数量不足',
          '当前数据源没有可选 Schema',
          '自助查询的数据源选择入口未找到',
        ].some((fragment) => message.includes(fragment));
        if (hiddenByPermission) {
          blockedEvidence = `删除后数据源已因无表级使用权限不可见（${message.split('，')[0]}）`;
        } else {
          throw error;
        }
      }
      if (!blockedEvidence) {
        const goneMarker = `fldgone_${uuid().slice(0, 8)}`;
        await executeSql(page, `SELECT COUNT(*) AS ${goneMarker} FROM ${tableName}`);
        await expect
          .poll(async () => readQueryOutcome(page, goneMarker), {
            timeout: 30_000,
            message: `删除授权后对 ${tableName} 的查询未被拦截——删除未在查询层生效`,
          })
          .toBe('denied');
        blockedEvidence = '删除后数据源仍可见，但查询被表级“没有使用权限”拦截';
      }
      await report('SM-03-10 阶段5｜删除授权并确认实际访问被拦截', true, blockedEvidence);

      // 无权限查询被后端拒绝属于本用例预期失败信号；其余控制台错误仍然失败。
      await assertNoUnexpectedConsoleErrors(consoleErrors, [
        /self\/query\/submitQuery/,
        /没有使用权限/,
        /dataPermission\//,
      ]);
    } catch (error) {
      mainError = error;
      throw error;
    } finally {
      // 串行模式：用例 1 失败 ⇒ 用例 2 被跳过，此时必须在本 finally 完成全套回收；
      // 用例 1 成功则保留夹具（两张专用表 + 本轮账号）供用例 2 使用，由其 finally 收尾。
      if (mainError) {
        const issues = await recoverRoundResources(page, report);
        if (issues.length) {
          console.warn(`[SM-03-10] 用例1 失败且收尾回收未完成（资源为唯一命名，不影响回归）：${issues.join('；')}`);
        }
      }
    }
  });

  test('SM-03-10｜多表选择不得授权部分字段（级联多选约束）', async ({ loginPage, report }) => {
    requirePermissionApprovalEnvironment();

    // 前置门禁与用例 1 同源：本轮两张专用表需要 MySQL 直连；未配置按前置不足跳过
    //（若用例 1 已因同一前置跳过，本用例所需的两张专用表不存在，同样不应伪造结论）。
    const cfg = dbConfig();
    if (!cfg || cfg.type !== 'mysql') {
      test.skip(
        !cfg || cfg.type !== 'mysql',
        `前置不足：未配置 MySQL 数据库环境（DB_HOST=${process.env.DB_HOST ?? ''}，DB_TYPE=${process.env.DB_TYPE ?? ''}），本轮专用表（用例 1 创建）不存在。`,
      );
    }

    const page = loginPage;
    try {
      await openDataPermissionPage(page);
      await purgeStaleTablePermissions(page, [tableName, secondTableName]);
      const dialog = await openUserViewCreateDialog(page);
      await selectPermissionTableScope(page, dialog, permissionResource);
      // 追加第二张表（同库）：定位“数据表”级联多选并点选 secondTableName。
      const tableSelect = await openTableCascadeSelect(dialog);
      await tableSelect.click();
      await pickDropdownOption(page, tableSelect, secondTableName);
      // 多选已生效（上级=数据表 ≥2）：弹窗须回显第二张表名，才构成“多选上级”前提。
      await expect(dialog).toContainText(secondTableName);
      // 多选上级禁止选择下级：字段范围下级不得再选“部分字段”（隐藏/禁用/不可交互其一）。
      const partialOption = await firstVisible(dialog.getByText(FIELD_SCOPE_PARTIAL));
      if (!partialOption) {
        await report(
          'SM-03-10 用例2｜多表禁止部分字段',
          true,
          `已选多表（${tableName}、${secondTableName}）后“部分字段”选项不再渲染（多选上级禁止选择下级：产品以隐藏方式禁止）。`,
        );
        await closePermissionDialog(page, dialog);
        return;
      }
      const partialDisabled = await isDisabledState(partialOption);
      await partialOption.click({ force: !partialDisabled }).catch(() => undefined);
      await page.waitForTimeout(800);
      const baselineCombos2 = await visibleComboboxCount(dialog);
      const fieldControl2 = await detectFieldSelectionControl(dialog, baselineCombos2);
      const fieldControlVisible = fieldControl2 !== undefined
        && (await fieldControl2.isVisible().catch(() => false));
      if (partialDisabled && !fieldControlVisible) {
        await report(
          'SM-03-10 用例2｜多表禁止部分字段',
          true,
          `已选多表后“部分字段”选项呈禁用态，字段多选未出现（多选上级禁止选择下级：产品以禁用方式禁止）。`,
        );
        await closePermissionDialog(page, dialog);
        return;
      }
      // “部分字段”仍可交互且字段多选出现：保存必须被拦截，否则为产品缺陷候选。
      if (!fieldControlVisible) {
        await report(
          'SM-03-10 用例2｜多表禁止部分字段',
          true,
          `已选多表后“部分字段”可点击但字段多选未渲染（无法配置部分字段，等效禁止）。`,
        );
        await closePermissionDialog(page, dialog);
        return;
      }
      const fieldControl = fieldControl2!;
      await chooseFieldsFromControl(page, fieldControl, 1);
      await setPermissionTypes(page, dialog, ['使用']);
      await setPermissionExpiry(page, dialog, '永久');
      await submitPermissionDialog(page, dialog);
      await page.waitForTimeout(1_500);
      if (await dialog.isVisible().catch(() => false)) {
        await report(
          'SM-03-10 用例2｜多表禁止部分字段',
          true,
          `多表+部分字段的保存被校验拦截（弹窗保持打开，未落库）。`,
        );
        await closePermissionDialog(page, dialog);
        return;
      }
      // 提交成功 = 约束缺失。尽力回收后显式失败。
      let cleanupNote2 = '未能定位到新建授权行，请人工核查并删除。';
      try {
        await refreshPermissionList(page);
        for (const name of [tableName, secondTableName]) {
          const stale = await findPermissionRow(page, name, 4_000);
          if (stale) {
            await deletePermissionFromRow(page, stale, { uniqueText: name });
            cleanupNote2 = `已删除残留授权（含 ${name}）。`;
          }
        }
      } catch {
        // 保留默认提示。
      }
      throw new Error(
        `约束缺失（产品缺陷候选）：已选多表（${tableName}、${secondTableName}）仍可保存“部分字段”授权。${cleanupNote2}`,
      );
    } finally {
      // 用例 2 为串行末位：无论成败都完成本轮全套回收（授权兜底 → DROP 两表 → 删除账号）。
      // 异常已由 try 原样向上传播；回收未完成只补充告警，不改变用例判定、不覆盖原错误。
      const issues = await recoverRoundResources(page, report);
      if (issues.length) {
        console.warn(`[SM-03-10] 收尾回收未完成（资源为唯一命名，不影响回归）：${issues.join('；')}`);
      }
    }
  });
});


