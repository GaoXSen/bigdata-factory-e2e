/**
 * 数据服务 — 我的API-应用注册管理 E2E 测试（行57）
 *
 * DS-PERM-80（20260922-数据源管理权限静态开发）：注册→编辑→关联成员→关联 API→撤销
 * 全流程使用本轮唯一真实数据闭环，不再“只开关弹窗”：
 *   1. 前置：API管理页自建本轮唯一 API（配置中心 apiService 级联，DS-03-03 同款）；
 *      系统管理-用户管理自建本轮唯一成员用户（新增用户 + 邀请用户进当前组织，
 *      SM-00-01 同款页面链路）。
 *   2. 注册应用（名称/描述本轮唯一，注册后按名称过滤回显唯一行）。
 *   3. 编辑应用：校验弹窗回显本轮应用名，改描述保存并二次回显（不再只点保存）。
 *   4. 成员管理：真实添加本轮成员（角色=普通成员，可用 DS80_MEMBER_ROLE 覆盖为
 *      管理员；后端 DaasAppMemberRequest.userRole 0=管理员/1=普通成员），
 *      弹窗成员清单回显断言。
 *   5. 关联 API：API 上线 → API商店 → 申请权限关联到本轮应用（DS-03-03 已验证链路）。
 *   6. 关联API清单：弹窗回显本轮 API，行内“撤销”并确认后该 API 行消失
 *      （对应 Excel 行57“关联API清单（撤销…）”的真实撤销语义，后端
 *      retrieveAPIPermission；“跳转统计”不在本用例范围）。
 *   7. 删除应用（Popconfirm 确认 + 查询刷新后行消失断言）。
 *
 * 清理（try/finally，best-effort，只作用本轮唯一命名资源）：应用删除兜底、
 * API 删除兜底（必要时先下线）、成员用户删除兜底。
 *
 * 关键要求：
 *   1. 所有操作用 page. 浏览器操作（无 fetch/axios 等 API 调用）
 *   2. UUID 后缀隔离所有测试数据
 *   3. 控制台错误收集；成员/撤销弹窗结构以真实页面为准，失败时附现场信息便于校准
 */

// 环境配置中心（ENV-CONFIG-40）先于工具导入：首次解析会把 API_* 兼容变量
// 按 dataSourceNames.apiService 回填，后续工具与用例读到一致的默认值。
import { testEnvironment } from '../../../test-environment.js';
import type { Locator, Page } from '@playwright/test';
import { test, expect, uuid } from '../utils.js';
import { assertNoConsoleErrors, clickMenu } from '../utils.js';


function tableWithHeader(page: Page, header: RegExp): Locator {
  return page.locator('table:visible').filter({ hasText: header }).first();
}

function tableRows(table: Locator): Locator {
  return table
    // `has` 必须相对于每一行解析；把 table.locator('td') 作为 has
    // 会导致所有数据行都被过滤掉。tbody 已排除表头，ARIA 表补充排除 columnheader。
    .locator('tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not(:has([role="columnheader"]))');
}

/** API 管理、授权和我的 API 页面把数据列与操作列拆成两个 table，按相同行号关联。 */
function apiDataRows(page: Page): Locator {
  return tableRows(tableWithHeader(page, /API名称|应用系统/));
}

function apiOperationRows(page: Page): Locator {
  return tableRows(tableWithHeader(page, /^\s*操作/));
}

async function lastVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidatesForType of candidates) {
    for (let index = (await candidatesForType.count()) - 1; index >= 0; index--) {
      const candidate = candidatesForType.nth(index);
      if (await candidate.isVisible()) return candidate;
    }
  }
  return undefined;
}

function labelPattern(label: string): RegExp {
  return new RegExp(`^\\s*\\*?\\s*${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*[：:]?\\s*$`);
}

async function nearbyControl(page: Page, label: string, selector: string): Promise<Locator> {
  const labels = page.getByText(labelPattern(label));
  for (let labelIndex = 0; labelIndex < await labels.count(); labelIndex++) {
    const labelNode = labels.nth(labelIndex);
    if (!(await labelNode.isVisible().catch(() => false))) continue;
    let scope: Locator = labelNode;
    for (let level = 0; level < 7; level++) {
      const controls = scope.locator(selector);
      for (let index = 0; index < await controls.count(); index++) {
        const control = controls.nth(index);
        if (await control.isVisible().catch(() => false)) return control;
      }
      scope = scope.locator('..');
    }
  }
  throw new Error(`字段“${label}”未找到可见控件，当前页面：${page.url()}`);
}

async function fillTextByLabel(page: Page, label: string, value: string): Promise<void> {
  const field = await nearbyControl(
    page,
    label,
    'input:not([type="checkbox"]):not([type="radio"]), textarea, select',
  );
  await field.fill(value);
}

async function fillOptionalTextByLabel(page: Page, label: string, value: string): Promise<boolean> {
  try {
    await fillTextByLabel(page, label, value);
    return true;
  } catch {
    return false;
  }
}

async function clickVisibleAction(scope: Page | Locator, name: string | RegExp): Promise<void> {
  const action = await lastVisible([
    scope.getByRole('button', { name }),
    scope.getByRole('link', { name }),
    scope.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }),
    scope.getByText(name, { exact: true }),
  ]);
  const currentPage = typeof (scope as Locator).page === 'function' ? (scope as Locator).page() : scope as Page;
  if (!action) throw new Error(`可见操作“${name}”未找到，当前页面：${currentPage.url()}`);
  await action.click();
}

async function expectToast(page: Page, text: string | RegExp): Promise<void> {
  const toast = page
    .locator(
      '.ant-message-notice-content:visible, .ant-notification-notice:visible, .ant-notification-notice-message:visible, .el-message:visible, [role="alert"]:visible, [class*="toast"]:visible',
    )
    .filter({ hasText: text });
  await expect(toast.last()).toBeVisible({ timeout: 10_000 });
}

function appDataRows(page: Page): Locator {
  return tableRows(tableWithHeader(page, /应用系统/));
}

function appOperationRows(page: Page): Locator {
  return tableRows(tableWithHeader(page, /^\s*操作/));
}

async function visibleDialog(page: Page): Promise<Locator> {
  const dialog = page.getByRole('dialog').last();
  await expect(dialog).toBeVisible();
  return dialog;
}

async function clickDialogButton(page: Page, name: string | RegExp): Promise<void> {
  await clickVisibleAction(await visibleDialog(page), name);
}

const API_CASCADE_POPUP_SELECTOR = [
  '.ant-select-dropdown:visible',
  '.el-select-dropdown:visible',
  '[role="listbox"]:visible',
].join(', ');

const API_CASCADE_ITEM_SELECTOR = [
  '.ant-select-item-option',
  '.ant-select-dropdown-menu-item',
  '.el-select-dropdown__item',
  '[role="option"]',
].join(', ');

// 配置中心 apiService（DS-PERM-51）：预置链路与兜底探测偏好只认配置值，
// 不再写死 110 IP、e2e_test 库/Schema 或 zhangjinhua/statement 历史表名。
const API_SERVICE = testEnvironment.dataSourceNames.apiService;

function escapeApiOptionText(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 配置中心显示名 → 级联下拉可能出现的文本形态（完整显示名 + 主机前缀）；仅排序不过滤。 */
function apiSourceNamePatterns(name: string): RegExp[] {
  const patterns = [new RegExp(`^${escapeApiOptionText(name)}$`, 'i')];
  const host = name.split(/[/:]/)[0];
  if (host && host !== name) patterns.push(new RegExp(`^${escapeApiOptionText(host)}$`, 'i'));
  return patterns;
}

const API_DATABASE_PATTERNS = [new RegExp(`^${escapeApiOptionText(API_SERVICE.database)}$`, 'i')];
const API_SCHEMA_PATTERNS = [new RegExp(`^${escapeApiOptionText(API_SERVICE.schema)}$`, 'i'), /^public$/i];
const API_TABLE_PATTERNS = API_SERVICE.table ? [new RegExp(escapeApiOptionText(API_SERVICE.table), 'i')] : [];

function apiPreferredChain(): string[] | undefined {
  // API_* 兼容变量单项覆盖；未覆盖时使用配置中心 apiService 默认链路。
  // 配置缺表名时不返回半截链路，改由页面实际可选项逐级探测并跳过无字段表。
  const values = [
    process.env.API_DATA_SOURCE_TYPE?.trim() || API_SERVICE.type,
    process.env.API_DATA_SOURCE_NAME?.trim() || API_SERVICE.name,
    process.env.API_DATABASE?.trim() || API_SERVICE.database,
    process.env.API_SCHEMA?.trim() || API_SERVICE.schema,
    process.env.API_TABLE?.trim() || API_SERVICE.table || '',
  ];
  return values.every((value): value is string => Boolean(value)) ? values : undefined;
}

function normalizeApiOptionText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

async function visibleApiOptionTexts(page: Page): Promise<string[]> {
  const popups = page.locator(API_CASCADE_POPUP_SELECTOR);
  let options = page.locator(API_CASCADE_ITEM_SELECTOR);
  // 级联切换时旧弹层会短暂保留在 DOM 中；最后一个可见弹层才是当前
  // combobox 的候选项，不能把上一级的类型名称当成下一级数据源名称。
  for (let index = await popups.count() - 1; index >= 0; index -= 1) {
    const popup = popups.nth(index);
    if (await popup.isVisible().catch(() => false)) {
      options = popup.locator(API_CASCADE_ITEM_SELECTOR);
      break;
    }
  }
  const values: string[] = [];
  for (let index = 0; index < await options.count(); index += 1) {
    const option = options.nth(index);
    if (!(await option.isVisible().catch(() => false))) continue;
    const text = normalizeApiOptionText(await option.innerText().catch(() => ''));
    if (!text || /请选择|暂无|无数据/.test(text)) continue;
    if (!values.includes(text)) values.push(text);
  }
  return values;
}

function prioritizeApiOptions(values: string[], preferred: RegExp[]): string[] {
  return [...values].sort((left, right) => {
    const score = (value: string) => {
      const index = preferred.findIndex((pattern) => pattern.test(value));
      return index < 0 ? preferred.length : index;
    };
    return score(left) - score(right);
  });
}

function isSystemApiOption(value: string): boolean {
  return /^(information_schema|pg_catalog|sys|dbe_perf|mysql|performance_schema)$/i.test(
    normalizeApiOptionText(value),
  ) || /^(LOAD_TRACE|GLOBAL_STAT_|TABLES?$|COLUMNS?$|SCHEMATA$)/i.test(
    normalizeApiOptionText(value),
  );
}

async function openApiCascadeOptions(page: Page, dialog: Locator, index: number): Promise<string[]> {
  const box = dialog.getByRole('combobox').nth(index);
  await expect(box).toBeVisible();
  await box.click();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const values = await visibleApiOptionTexts(page);
    if (values.length) {
      // 保持当前下拉打开，后续由 selectApiCascadeOption 直接点击当前候选项。
      // 不能使用 page.keyboard.press('Escape')：部分页面会把 Escape 继续冒泡到
      // 创建 API 弹窗，导致弹窗被关闭后再去找 combobox。
      return values;
    }
    await page.waitForTimeout(250);
  }
  await box.press('Escape').catch(() => undefined);
  return [];
}

async function clickApiCascadeOption(page: Page, text: string, timeoutMs = 10_000): Promise<boolean> {
  // 点击时允许从所有可见弹层中找“当前文本”；部分 Ant 版本同时渲染
  // 一个外层 dropdown 和一个 role=listbox，限定最后一个容器反而会漏掉真实 option。
  const options = page.locator([
    '.ant-select-dropdown:visible .ant-select-item-option',
    '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
    '.el-select-dropdown:visible .el-select-dropdown__item',
    '[role="listbox"]:visible [role="option"]',
  ].join(', '));
  const expected = normalizeApiOptionText(text);
  const roleOptions = page.getByRole('option', { name: expected, exact: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let index = await roleOptions.count() - 1; index >= 0; index -= 1) {
      const option = roleOptions.nth(index);
      if (!(await option.isVisible().catch(() => false))) continue;
      await option.scrollIntoViewIfNeeded().catch(() => undefined);
      await option.click({ force: true });
      await page.waitForTimeout(250);
      return true;
    }
    for (let index = await options.count() - 1; index >= 0; index -= 1) {
      const option = options.nth(index);
      if (!(await option.isVisible().catch(() => false))) continue;
      const actual = normalizeApiOptionText(await option.innerText().catch(() => ''));
      if (actual !== expected) continue;
      await option.scrollIntoViewIfNeeded().catch(() => undefined);
      await option.click({ force: true });
      await page.waitForTimeout(250);
      return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function selectApiCascadeOption(page: Page, dialog: Locator, index: number, text: string): Promise<void> {
  // openApiCascadeOptions 已经把当前下拉打开时，先直接点击当前候选项。
  // 这样不会再次 click combobox 把下拉收起，也不会误触发上一级残留弹层。
  if (await clickApiCascadeOption(page, text, 2_000)) return;

  let opened = false;
  for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
    const box = dialog.getByRole('combobox').nth(index);
    if (!(await box.isVisible().catch(() => false))) break;
    opened = await box.click({ timeout: 5_000 }).then(() => true).catch(() => false);
    if (!opened) await page.waitForTimeout(300);
  }
  if (!opened) throw new Error(`API 级联第 ${index + 1} 级下拉无法稳定打开，当前页面：${page.url()}`);
  if (!(await clickApiCascadeOption(page, text))) {
    throw new Error('级联下拉中没有可见选项“' + text + '”，当前页面：' + page.url());
  }
}

/**
 * 只使用页面已经保存且能形成完整级联链路的数据源。
 * 不按下拉第一项盲选，避免 DM 类型没有数据源时继续生成空的脏选择。
 */
async function selectApiSavedDataSourceChain(
  page: Page,
  dialog: Locator,
  preferredChain?: string[],
): Promise<void> {
  if (preferredChain?.length === 5) {
    try {
      for (let index = 0; index < preferredChain.length; index += 1) {
        await selectApiCascadeOption(page, dialog, index, preferredChain[index]);
      }
      if ((await waitForApiFieldsOrEmpty(dialog)) === 'rows') return;
      throw new Error(`API 目标表“${preferredChain[4]}”未返回字段，不能创建 API。`);
    } catch (error) {
      throw new Error(
        `API 预置数据源链路不可用：${preferredChain.join(' / ')}。` +
        `请确认页面已保存该数据源、数据库、Schema 和有字段的数据表。原始原因：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // 优先尝试已有 API 使用过的 GBase 表，其次再尝试当前环境的其他类型；
  // 这样不会先在 GAUSSDBM 的系统视图上消耗大量无效等待。
  const typePatterns = [/MYSQL/i, /GBASE8A|GBASE/i, /GAUSSDBM|OPENGAUSS|GAUSS/i];
  const typeOptions = prioritizeApiOptions(
    await openApiCascadeOptions(page, dialog, 0),
    typePatterns,
  );
  if (!typeOptions.length) {
    throw new Error('API 创建页面没有可选的数据源类型。');
  }

  for (const typeText of typeOptions) {
    await selectApiCascadeOption(page, dialog, 0, typeText);
    // 数据源级偏好来自配置中心显示名（完整显示名 + 主机前缀两种页面形态）。
    const sourceOptions = prioritizeApiOptions(
      await openApiCascadeOptions(page, dialog, 1),
      apiSourceNamePatterns(API_SERVICE.name),
    );
    if (!sourceOptions.length) {
      await dialog.getByRole('combobox').nth(1).press('Escape').catch(() => undefined);
      continue;
    }

    for (const sourceText of sourceOptions) {
      await selectApiCascadeOption(page, dialog, 1, sourceText);
      const databaseOptions = prioritizeApiOptions(
        (await openApiCascadeOptions(page, dialog, 2)).filter((value) => !isSystemApiOption(value)),
        API_DATABASE_PATTERNS,
      );
      if (!databaseOptions.length) {
        await dialog.getByRole('combobox').nth(2).press('Escape').catch(() => undefined);
        continue;
      }

      for (const databaseText of databaseOptions) {
        await selectApiCascadeOption(page, dialog, 2, databaseText);
        const schemaOptions = prioritizeApiOptions(
          (await openApiCascadeOptions(page, dialog, 3)).filter((value) => !isSystemApiOption(value)),
          API_SCHEMA_PATTERNS,
        );
        if (!schemaOptions.length) {
          await dialog.getByRole('combobox').nth(3).press('Escape').catch(() => undefined);
          continue;
        }

        for (const schemaText of schemaOptions) {
          await selectApiCascadeOption(page, dialog, 3, schemaText);
          const initialTableOptions = (await openApiCascadeOptions(page, dialog, 4))
            .filter((value) => !isSystemApiOption(value));
          if (!initialTableOptions.length) {
            await dialog.getByRole('combobox').nth(4).press('Escape').catch(() => undefined);
            continue;
          }
          // “有表名”不等于“能创建 API”：文件接入/空元数据表可能返回空字段。
          // 每次失败后重新读取当前下拉，避免级联重绘/虚拟列表导致旧候选项失效。
          const attemptedTables = new Set<string>();
          for (let tableAttempt = 0; tableAttempt < 30; tableAttempt += 1) {
            const tableOptions = prioritizeApiOptions(
              (tableAttempt === 0
                ? initialTableOptions
                : (await openApiCascadeOptions(page, dialog, 4)).filter((value) => !isSystemApiOption(value))),
              API_TABLE_PATTERNS,
            );
            const tableText = tableOptions.find((value) => !attemptedTables.has(value));
            if (!tableText) break;
            attemptedTables.add(tableText);
            await selectApiCascadeOption(page, dialog, 4, tableText);
            const fieldState = await waitForApiFieldsOrEmpty(dialog);
            if (fieldState === 'empty') continue;
            const parameterSection = dialog.getByRole('heading', { name: '选择参数', exact: true }).locator('..');
            const empty = parameterSection.getByText('暂无数据', { exact: true });
            if (!(await empty.isVisible().catch(() => false))) return;
          }
        }
      }
    }
  }

  throw new Error('当前环境没有可用的已保存数据源级联链路，请先在页面保存可用的数据源、数据库、Schema 和数据表。');
}

async function waitForApiFieldsOrEmpty(dialog: Locator): Promise<'empty' | 'rows'> {
  const section = dialog.getByRole('heading', { name: '选择参数', exact: true }).locator('..');
  const empty = section.getByText('暂无数据', { exact: true });
  const noTableMetadata = dialog.page().locator(
    '.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible',
  ).filter({ hasText: /数据表.*(?:未接入|不存在)|未找到字段|字段为空/ }).last();
  await dialog.page().waitForTimeout(300);
  await expect.poll(async () => {
    if (await section.locator('.ant-spin-spinning:visible, .el-loading-mask:visible').count()) return 'loading';
    if (await noTableMetadata.isVisible().catch(() => false)) return 'empty';
    if (await empty.isVisible().catch(() => false)) return 'empty';
    const rows = section.locator(
      'tbody > tr:visible, .ant-table-tbody > tr:visible, ' +
      '[role="row"]:visible:not(:has([role="columnheader"]))',
    );
    return (await rows.count()) > 0 ? 'rows' : 'loading';
  }, { timeout: 10_000 }).toMatch(/^(empty|rows)$/);
  if (await noTableMetadata.isVisible().catch(() => false) || await empty.isVisible().catch(() => false)) {
    return 'empty';
  }
  return 'rows';
}

/** API 创建依赖页面从数据表返回字段；没有字段时属于环境前置缺失。 */
async function skipWhenApiTableHasNoFields(dialog: Locator): Promise<void> {
  await waitForApiFieldsOrEmpty(dialog);
  const section = dialog.getByRole('heading', { name: '选择参数', exact: true }).locator('..');
  if (await section.getByText('暂无数据', { exact: true }).isVisible().catch(() => false)) {
    throw new Error( '当前环境所选数据表未返回字段，无法创建 API；请提供有字段的测试表。');
  }
}

async function fillApiForm(page: Page, apiName: string, preferredChain?: string[]): Promise<Locator> {
  const dialog = await visibleDialog(page);
  const fields = dialog.getByRole('textbox');
  await expect(fields.nth(0)).toBeVisible();
  await fields.nth(0).fill(apiName);
  await fields.nth(1).fill(`E2E API ${apiName}`);
  await selectApiSavedDataSourceChain(page, dialog, preferredChain ?? apiPreferredChain());
  await dialog.getByRole('radio', { name: 'post', exact: true }).check();
  // 请求路径页面校验只允许字母/数字/下划线（DS-03-01 实证），用下划线而非斜杠；
  // 无可见 label 的版本退化为第 3 个 textbox（label 优先策略与 DS-03-03 一致）。
  if (!(await fillOptionalTextByLabel(page, '请求地址', `e2e_${apiName}`))) {
    await fields.nth(2).fill(`e2e_${apiName}`);
  }
  return dialog;
}

async function rowIndexByText(rows: Locator, text: string): Promise<number> {
  for (let index = 0; index < await rows.count(); index++) {
    if ((await rows.nth(index).innerText()).includes(text)) return index;
  }
  throw new Error(`数据列中未找到“${text}”，无法关联操作列。`);
}

async function closeVisibleDialog(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog').last();
  const close = await lastVisible([
    dialog.getByRole('button', { name: /关\s*闭|取\s*消|Close/ }),
  ]);
  if (close) await close.click();
}

/** finally 清理：只删除本轮唯一命名的应用；查询不到（未注册或已删除）时静默结束。 */
async function deleteRoundAppIfPresent(page: Page, appName: string): Promise<void> {
  try {
    await clickMenu(page, '数据服务', '我的API', '应用注册管理');
    await fillTextByLabel(page, '应用名称', appName);
    const queryButton = page.getByRole('button', { name: /查\s*询|搜\s*索/ }).last();
    if (await queryButton.isVisible().catch(() => false)) await queryButton.click();
    await page.waitForTimeout(500);
    const row = appDataRows(page).filter({ hasText: appName }).first();
    if (!(await row.isVisible().catch(() => false))) return;
    const index = await rowIndexByText(appDataRows(page), appName);
    await clickVisibleAction(await appOperationRows(page).nth(index), /删\s*除/);
    // 该页删除确认是 Popconfirm（role=tooltip），与主流程同一处理路径。
    const popconfirm = page.getByRole('tooltip').filter({ hasText: '确定要删除吗' }).last();
    await expect(popconfirm).toBeVisible({ timeout: 5_000 });
    await popconfirm.getByRole('button', { name: /确\s*定/ }).click();
    await page.waitForTimeout(500);
  } catch {
    // 清理是 best-effort：唯一 UUID 应用名只可能命中本轮资源，失败不改变用例真实结果。
  }
}

// ==================== DS-PERM-80：本轮成员用户与成员/API 关联闭环 ====================

/**
 * 本轮成员口令：仅用于创建一次性 e2e 测试用户（SM-00-01/DS-01-06 同类约定），
 * 不是系统密钥；仅从环境变量读取，缺失时跳过用例。
 */
const DS80_MEMBER_PASSWORD = process.env.DS80_MEMBER_PASSWORD?.trim() || '';
/** 应用成员角色（后端 DaasAppMemberRequest.userRole：0=管理员/1=普通成员），页面选项为中文映射。 */
const DS80_MEMBER_ROLE = process.env.DS80_MEMBER_ROLE ?? '普通成员';

async function openUserManagement(page: Page): Promise<void> {
  await clickMenu(page, '系统管理', '用户权限', '用户管理');
  await expect(page.getByRole('button', { name: '新增用户' }).last()).toBeVisible({ timeout: 15_000 });
}

/**
 * 新增用户弹窗的组织下拉：优先环境配置的组织名（DS80_ORG_NAMES，逗号分隔）；
 * 配置组织都不存在时退化为下拉第一个可用选项，保证本轮成员仍能创建。
 * 候选先限定下拉容器，避免命中页码/菜单等同名 listitem。
 */
async function pickVisibleOrgOption(page: Page): Promise<void> {
  const orgNames = (process.env.DS80_ORG_NAMES ?? '测试管理员,简单用户组,简单用户,hive流程审批组织')
    .split(',').map((name) => name.trim()).filter(Boolean);
  const orgBox = page.getByRole('textbox', { name: '请选择组织' }).last();
  await expect(orgBox).toBeVisible({ timeout: 10_000 });
  await orgBox.click();
  const candidates = [
    page.locator('.el-select-dropdown:visible li, .ant-select-dropdown:visible [role="option"], [role="listbox"]:visible [role="option"]').filter({ hasText: /\S/ }),
    page.getByRole('listitem').filter({ hasText: /\S/ }),
  ];
  const pickable = async (option: Locator): Promise<boolean> => {
    if (!(await option.isVisible().catch(() => false))) return false;
    const text = (await option.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    return Boolean(text) && !/请选择|暂无|无数据/.test(text) && !/^\d+$/.test(text);
  };
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const group of candidates) {
      let fallback: Locator | undefined;
      for (let index = await group.count() - 1; index >= 0; index -= 1) {
        const option = group.nth(index);
        if (!(await pickable(option))) continue;
        const text = (await option.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (orgNames.some((name) => text.includes(name))) {
          await option.click();
          return;
        }
        fallback = fallback ?? option;
      }
      if (fallback) {
        await fallback.click();
        return;
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`组织下拉没有可用选项，无法创建成员用户，当前页面：${page.url()}`);
}

/**
 * 系统管理-用户管理新增本轮成员用户（SM-00-01 同款页面链路）：
 * 新增用户 → 用户名称/昵称/手机号/邮箱/密码 → 组织 → 确定 → 按名称查询回显。
 */
async function createRoundMember(page: Page, memberName: string): Promise<void> {
  await openUserManagement(page);
  await clickVisibleAction(page, '新增用户');
  const dialog = await visibleDialog(page);
  await dialog.getByPlaceholder('请输入用户名称').fill(memberName);
  await page.getByRole('textbox', { name: '请输入用户昵称' }).last().fill(`ds80_${memberName}`);
  await dialog.getByPlaceholder('请输入手机号码').fill(`139${String(Date.now()).slice(-8)}`);
  const email = page.getByRole('textbox', { name: '请输入邮箱' }).last();
  if (await email.isVisible().catch(() => false)) await email.fill(`${memberName}@e2e.test`);
  await page.getByRole('textbox', { name: '请输入用户密码' }).last().fill(DS80_MEMBER_PASSWORD);
  const gender = page.getByRole('textbox', { name: '请选择性别' }).last();
  if (await gender.isVisible().catch(() => false)) {
    await gender.click();
    const male = page.getByRole('listitem', { name: '男' }).last();
    if (await male.isVisible().catch(() => false)) await male.click();
    else await page.keyboard.press('Escape');
  }
  await pickVisibleOrgOption(page);
  await page.getByRole('button', { name: /^确\s*定$/ }).last().click();
  await expectToast(page, /成功|新增/);
  // 回显：按本轮成员名查询，用户列表必须出现该行（真实落库断言，不只看 toast）。
  const query = page.getByRole('textbox', { name: '请输入用户名称' }).first();
  await query.fill(memberName);
  await clickVisibleAction(page, /查\s*询/);
  await expect(
    page.locator('tr:visible, [role="row"]:visible').filter({ hasText: memberName }).last(),
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * 邀请用户进当前组织（SM-00-01 同款入口）：成员选择器若按组织过滤，
 * 未入组的成员在应用成员选择器中不可见。快照实证（run-20260901）新用户
 * 需要在候选框中输入过滤后才会出现，这里先输入成员名再点选候选。
 * 返回 false 表示“邀请用户”入口不可见（权限/版本差异），由调用方记录。
 */
async function inviteRoundMemberToCurrentOrg(page: Page, memberName: string): Promise<boolean> {
  const inviteEntry = await lastVisible([page.getByRole('button', { name: '邀请用户' })]);
  if (!inviteEntry) return false;
  await inviteEntry.click();
  const dialog = await visibleDialog(page);
  const userBox = await lastVisible([
    dialog.getByRole('textbox', { name: '请选择用户' }),
    dialog.getByPlaceholder(/请选择用户|请输入用户/),
  ]);
  if (!userBox) {
    throw new Error(
      `邀请用户弹窗未找到用户选择框，弹窗内容：` +
      `${(await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)}`,
    );
  }
  await userBox.click();
  await userBox.fill(memberName);
  const candidate = page.getByRole('listitem').filter({ hasText: memberName }).last();
  const deadline = Date.now() + 15_000;
  let picked = false;
  while (Date.now() < deadline && !picked) {
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      picked = true;
      break;
    }
    await page.waitForTimeout(300);
  }
  if (!picked) {
    await closeVisibleDialog(page);
    throw new Error(
      `邀请用户候选列表未出现本轮成员“${memberName}”。若成员选择器按组织过滤，` +
      `未入组成员无法被应用关联，请校准组织/候选定位。当前页面：${page.url()}`,
    );
  }
  await page.getByRole('button', { name: /^确\s*定$/ }).last().click();
  await expectToast(page, /成功|邀请/);
  return true;
}

/** finally 清理：只删除本轮唯一命名的成员用户；兼容行内“更多”菜单里的删除入口。 */
async function deleteRoundMemberIfPresent(page: Page, memberName: string): Promise<void> {
  try {
    await openUserManagement(page);
    const query = page.getByRole('textbox', { name: '请输入用户名称' }).first();
    if (!(await query.isVisible().catch(() => false))) return;
    await query.fill(memberName);
    await clickVisibleAction(page, /查\s*询/);
    await page.waitForTimeout(500);
    const row = page.locator('tr:visible, [role="row"]:visible').filter({ hasText: memberName }).last();
    if (!(await row.isVisible().catch(() => false))) return;
    const more = row.getByRole('button', { name: /更多|···|…/ }).last();
    if (await more.isVisible().catch(() => false)) {
      await more.click();
      await page.waitForTimeout(300);
    }
    const deleteItem = await lastVisible([
      page.locator('.ant-dropdown:visible, .el-dropdown-menu:visible, [role="menu"]:visible').getByText(/^删\s*$/),
      row.getByRole('button', { name: /删\s*除/ }),
      row.getByText(/^删\s*$/),
    ]);
    if (!deleteItem) return;
    await deleteItem.click();
    // 删除确认：存在“请输入…”二次校验输入框时先回填（DS-PERM-83 同款处理）。
    await page.waitForTimeout(400);
    const verifyInput = await lastVisible([
      page.locator('.ant-popover:visible, .el-popover:visible, .el-popper:visible, [role="dialog"]:visible').getByRole('textbox'),
    ]);
    if (verifyInput && /请输入/.test((await verifyInput.getAttribute('placeholder')) ?? '')) {
      await verifyInput.fill(memberName);
    }
    const confirmButton = await lastVisible([
      page.getByRole('tooltip').locator('button:visible').filter({ hasText: /确\s*定/ }),
      page.locator('.ant-popover:visible, .el-popover:visible, .el-popper:visible').locator('button:visible').filter({ hasText: /确\s*定|删\s*除/ }),
      page.getByRole('button', { name: /^确\s*定$/ }),
    ]);
    if (confirmButton) await confirmButton.click();
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
  } catch {
    // 清理是 best-effort：唯一 UUID 名称只可能命中本轮资源，失败不改变用例真实结果。
  }
}

/**
 * 以下 API 前置/清理辅助与 DS-03-03 保持同款实现（已在该用例实测稳定）：
 * 级联链路来自配置中心 apiService，失败按页面真实提示上报，不依赖存量接口。
 */

/** 上线/下线本轮 API：按唯一名称查询定位操作行，点击按钮并等待成功提示。 */
async function toggleRoundApiOnline(page: Page, apiName: string, action: RegExp): Promise<void> {
  const queryInput = page.getByRole('textbox').first();
  await expect(queryInput).toBeVisible({ timeout: 10_000 });
  await queryInput.fill(apiName);
  const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
  if (await queryButton.isVisible().catch(() => false)) await queryButton.click();
  await page.waitForTimeout(500);
  const rows = apiDataRows(page);
  let targetIndex = -1;
  for (let index = 0; index < await rows.count(); index += 1) {
    if (await rows.nth(index).getByText(apiName, { exact: true }).count()) {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex < 0) throw new Error(`本轮 API「${apiName}」未出现在列表中，无法执行上线/下线。当前页面：${page.url()}`);
  const opRow = apiOperationRows(page).nth(targetIndex);
  const actionButton = opRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: action }).last();
  await expect(actionButton).toBeVisible();
  await actionButton.click();
  await expectToast(page, /成功/);
  await page.waitForTimeout(500);
}

/** 商店卡片：按 API 名称向上找到带“申请权限”按钮的卡片；找不到即上线后商店不可见。 */
async function requireStoreCard(page: Page, apiName: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const name = page.getByText(apiName, { exact: true });
    for (let index = (await name.count()) - 1; index >= 0; index--) {
      let scope = name.nth(index);
      for (let level = 0; level < 6; level++) {
        if (await scope.getByText('申请权限', { exact: true }).count()) return scope;
        scope = scope.locator('..');
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`API商店中未找到「${apiName}」的可用卡片（上线后商店不可见=真实缺陷）。当前页面：${page.url()}`);
}

/** 商店申请权限：应用下拉必须含本轮应用；有效期远期；加密方式选 MD5（页面提供时）。 */
async function applyStorePermission(page: Page, appName: string): Promise<void> {
  const dialog = await visibleDialog(page);
  // 应用下拉：无可见选项=前置缺失（需先注册应用）；出现但不含本轮应用=授权下拉未刷新。
  await dialog.getByRole('combobox').first().click();
  const option = page
    .locator('.ant-select-dropdown:visible .ant-select-item-option, .el-select-dropdown:visible .el-select-dropdown__item, [role="listbox"]:visible [role="option"]')
    .filter({ hasText: new RegExp(escapeApiOptionText(appName)) })
    .last();
  if (!(await option.isVisible().catch(() => false))) {
    throw new Error(
      `申请权限弹窗的应用下拉未出现本轮应用「${appName}」` +
      `（无任何应用=环境缺注册前置；缺本轮应用=下拉未按环境刷新）。当前页面：${page.url()}`,
    );
  }
  await option.click();
  if (!(await fillOptionalTextByLabel(page, '有效期至', '2099-12-31'))) {
    const expiry = dialog.getByRole('textbox').last();
    if (await expiry.isVisible().catch(() => false)) await expiry.fill('2099-12-31');
  }
  const encryption = dialog.getByRole('combobox').last();
  if (await encryption.isVisible().catch(() => false)) {
    await encryption.click();
    const md5 = page.getByRole('option', { name: 'MD5', exact: true }).last();
    if (await md5.isVisible().catch(() => false)) await md5.click();
  }
  await clickVisibleAction(dialog, /确\s*定|申\s*请/);
  await expectToast(page, /成功|申请/);
}

/** 本轮创建唯一 ASCII API：保存后识别失败提示，取消回列表按名称查询确认真实落库。 */
async function createRoundApi(page: Page, apiName: string): Promise<void> {
  await clickVisibleAction(page, /新增|新建/);
  const dialog = await fillApiForm(page, apiName);
  await skipWhenApiTableHasNoFields(dialog);
  await clickVisibleAction(dialog, /保\s*存/);
  await page.waitForTimeout(800);
  const error = await lastVisible([
    page.locator('.ant-form-item-explain-error:visible, .el-form-item__error:visible'),
    page.locator('.el-message--error:visible, .ant-message-error:visible, .el-message:visible, .ant-message:visible')
      .filter({ hasText: /失败|重复|已存在|错误/ }),
  ]);
  if (error) throw new Error(`本轮 API「${apiName}」创建未成功：${(await error.innerText().catch(() => '')).slice(0, 200)}`);
  // 兜底关闭弹窗（成功时通常已自动关闭），回列表按本轮唯一名称查询确认真实落库。
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const queryInput = page.getByRole('textbox').first();
  await queryInput.fill(apiName);
  const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
  if (await queryButton.isVisible().catch(() => false)) await queryButton.click();
  await page.waitForTimeout(500);
  const rows = apiDataRows(page);
  for (let index = 0; index < await rows.count(); index += 1) {
    if (await rows.nth(index).getByText(apiName, { exact: true }).count()) return;
  }
  throw new Error(`按名称查询未见本轮 API「${apiName}」落库（创建可能被页面静默拦截）。当前页面：${page.url()}`);
}

/** finally 清理：只删除本轮唯一命名的 API；在线 API 可能禁止删除，行内有“下线”时先下线。 */
async function deleteRoundApiIfPresent(page: Page, apiName: string): Promise<void> {
  try {
    await clickMenu(page, '数据服务', 'API管理');
    const queryInput = page.getByRole('textbox').first();
    if (!(await queryInput.isVisible().catch(() => false))) return;
    await queryInput.fill(apiName);
    const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
    if (await queryButton.isVisible().catch(() => false)) await queryButton.click();
    await page.waitForTimeout(500);
    const rows = apiDataRows(page);
    for (let index = 0; index < await rows.count(); index += 1) {
      if (!(await rows.nth(index).getByText(apiName, { exact: true }).count())) continue;
      const opRow = apiOperationRows(page).nth(index);
      // 在线 API 可能禁止删除：行内有“下线”按钮时先下线再删。
      const offline = opRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /^下\s*线$/ }).last();
      if (await offline.isVisible().catch(() => false)) {
        await offline.click().catch(() => undefined);
        await page.waitForTimeout(800);
      }
      await clickVisibleAction(opRow, /删\s*除/);
      await clickVisibleAction(page, /确\s*定|删\s*除/);
      await page.waitForTimeout(500);
      break;
    }
  } catch {
    // 清理是 best-effort：唯一 UUID 名称只可能命中本轮资源，失败不改变用例真实结果。
  }
}

/**
 * 成员管理弹窗真实添加本轮成员（DS-PERM-80：不再只开关弹窗）：
 * 优先“添加成员/新增成员”入口展开表单，退化为弹窗内直接的用户选择控件；
 * 选择本轮成员 + 角色（普通成员）后确定，并断言弹窗成员清单回显本轮成员。
 */
async function addRoundAppMember(page: Page, appName: string, memberName: string): Promise<void> {
  // 应用列表按创建时间升序分页：先按本轮应用名过滤，再对齐数据/操作分表行号。
  await fillTextByLabel(page, '应用名称', appName);
  await clickVisibleAction(page, /查\s*询|搜\s*索/);
  await expect(appDataRows(page).filter({ hasText: appName }).first()).toBeVisible({ timeout: 10_000 });
  const index = await rowIndexByText(appDataRows(page), appName);
  await clickVisibleAction(await appOperationRows(page).nth(index), /成员管理/);
  const dialog = await visibleDialog(page);
  const addTrigger = await lastVisible([
    dialog.getByRole('button', { name: /添加成员|新增成员|添加|新增/ }),
    dialog.getByText(/^(?:添加成员|新增成员|添加|新增)$/),
  ]);
  let formScope = dialog;
  if (addTrigger) {
    await addTrigger.click();
    formScope = await visibleDialog(page);
  }
  const userBox = await lastVisible([
    formScope.getByRole('textbox', { name: /请选择用户|请输入用户/ }),
    formScope.getByPlaceholder(/请选择用户|请输入用户/),
  ]);
  if (!userBox) {
    throw new Error(
      `成员管理弹窗未找到成员选择控件。弹窗内容：` +
      `${(await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)}`,
    );
  }
  await userBox.click();
  // 成员名仅含 [a-z0-9_]（uuid 十六进制小写），无正则元字符；输入触发候选过滤后点选。
  await userBox.fill(memberName);
  const candidates = [
    page.getByRole('listitem').filter({ hasText: memberName }).last(),
    page.locator('.ant-select-dropdown:visible .ant-select-item-option, .el-select-dropdown:visible .el-select-dropdown__item, [role="listbox"]:visible [role="option"], [role="option"]:visible')
      .filter({ hasText: memberName }).last(),
  ];
  const deadline = Date.now() + 15_000;
  let picked = false;
  while (Date.now() < deadline && !picked) {
    for (const option of candidates) {
      if (await option.isVisible().catch(() => false)) {
        await option.click();
        picked = true;
        break;
      }
    }
    if (!picked) await page.waitForTimeout(300);
  }
  if (!picked) {
    throw new Error(
      `成员选择器未出现本轮成员“${memberName}”（已邀请进当前组织仍不可见时，需校准成员选择器定位）。` +
      `当前页面：${page.url()}`,
    );
  }
  // 角色下拉（后端 userRole 0=管理员/1=普通成员；页面中文选项）。
  const roleBox = formScope.getByRole('combobox').last();
  if (await roleBox.isVisible().catch(() => false)) {
    await roleBox.click();
    const roleOption = page.getByRole('option', { name: DS80_MEMBER_ROLE, exact: true }).last();
    if (await roleOption.isVisible().catch(() => false)) await roleOption.click();
    else await page.keyboard.press('Escape');
  }
  await clickVisibleAction(formScope, /^确\s*定$/);
  await expectToast(page, /成功|添加|新增/);
  // 回显：成员清单出现本轮成员（echo 断言，不只看 toast）。
  await expect(
    dialog.locator('tr:visible, [role="row"]:visible, li:visible').filter({ hasText: memberName }).last(),
  ).toBeVisible({ timeout: 10_000 });
  await closeVisibleDialog(page);
}

/**
 * 关联API清单弹窗（DS-PERM-80：真实撤销语义，对应后端 retrieveAPIPermission）：
 * 回显本轮 API 后点击行内“撤销”并确认，断言清单中该 API 行消失。
 */
async function revokeRoundApiInDialog(page: Page, appName: string, apiName: string): Promise<void> {
  await clickMenu(page, '数据服务', '我的API', '应用注册管理');
  await fillTextByLabel(page, '应用名称', appName);
  await clickVisibleAction(page, /查\s*询|搜\s*索/);
  await expect(appDataRows(page).filter({ hasText: appName }).first()).toBeVisible({ timeout: 10_000 });
  const index = await rowIndexByText(appDataRows(page), appName);
  await clickVisibleAction(await appOperationRows(page).nth(index), /关联API清单/);
  const dialog = await visibleDialog(page);
  // 弹窗表格可能是「数据/操作」分表或单表：都按行号对齐定位撤销按钮。
  const dataRows = tableRows(dialog.locator('table:visible').filter({ hasText: /API名称|名称/ }).first());
  const echoIndex = await rowIndexByText(dataRows, apiName);
  await expect(dataRows.nth(echoIndex)).toBeVisible();
  const opTable = dialog.locator('table:visible').filter({ hasText: /^\s*操作/ }).last();
  const revokeRow = (await opTable.isVisible().catch(() => false))
    ? tableRows(opTable).nth(echoIndex)
    : dataRows.nth(echoIndex);
  await clickVisibleAction(revokeRow, /^撤\s*销$/);
  // 撤销确认：Popconfirm（role=tooltip）优先，退化弹层/页面级确定按钮。
  await page.waitForTimeout(400);
  const confirmButton = await lastVisible([
    page.getByRole('tooltip').locator('button:visible').filter({ hasText: /确\s*定|确\s*认|撤\s*销/ }),
    page.locator('.ant-popover:visible, .el-popover:visible, .el-popper:visible').locator('button:visible').filter({ hasText: /确\s*定|确\s*认|撤\s*销/ }),
    page.getByRole('button', { name: /^确\s*定$/ }),
  ]);
  if (!confirmButton) throw new Error('撤销确认按钮未出现（Popconfirm/Dialog 均未命中）。');
  await confirmButton.click();
  await expectToast(page, /成功|撤销/);
  // 回显式负断言：撤销成功后清单不再包含本轮 API。
  await expect(dataRows.filter({ hasText: apiName })).toHaveCount(0, { timeout: 10_000 });
  await closeVisibleDialog(page);
}

test.describe("DS-04-01｜数据服务｜应用注册→编辑→关联成员→关联 API→撤销", () => {
  test.describe.configure({ timeout: 120_000 })
  test.beforeEach(async ({ loginPage }) => {
    await clickMenu(loginPage, '数据服务', 'API管理');
  })
  test("DS-04-01｜数据服务｜应用注册→编辑→关联成员→关联 API→撤销", async ({ loginPage, consoleErrors, report }) => {
      if (!DS80_MEMBER_PASSWORD) {
        test.skip(true, '缺少 DS80_MEMBER_PASSWORD，无法创建本轮应用成员用户。');
        return;
      }
      // DS-PERM-80：本轮唯一真实数据闭环（前置建 API/成员 + 注册/编辑/成员关联/
      // API 关联/撤销/删除），不再“只开关弹窗”；整体链路远超 120s，
      // 与 DS-03-03 同款放宽单用例超时到 480s。
      test.setTimeout(480_000);
      const page = loginPage;
      const appName = `app_${uuid()}`;
      const apiName = `api_ds80_${uuid()}`;
      const memberName = `ds80m_${uuid()}`;
      let memberInvited = false;
      try {
        // 前置一：本轮唯一 API（beforeEach 已进入 API管理页）。
        await test.step('前置：创建本轮唯一 API', async () => {
          await createRoundApi(page, apiName);
        });
        // 前置二：本轮唯一成员用户并邀请进当前组织（系统管理-用户管理）。
        await test.step('前置：创建并邀请本轮成员用户', async () => {
          await createRoundMember(page, memberName);
          memberInvited = await inviteRoundMemberToCurrentOrg(page, memberName);
        });
        // 阶段一：注册应用 —— 弹窗填本轮唯一名称/描述，成功后按名称过滤回显唯一行。
        await test.step('阶段一：注册应用', async () => {
          await clickMenu(page, '数据服务', '我的API', '应用注册管理');
          await clickVisibleAction(page, /注\s*册/);
          const dialog = await visibleDialog(page);
          const fields = dialog.getByRole('textbox');
          await expect(fields.first()).toBeVisible();
          await fields.first().fill(appName);
          if (await fields.count() > 1) await fields.nth(1).fill(`E2E application ${appName}`);
          await clickVisibleAction(dialog, /确\s*定|保\s*存|注\s*册/);
          await expectToast(page, /成功|注册/);
          // 列表按创建时间升序分页（run-20260915-134701 快照：共20条、第1/2页，
          // 新注册应用落在第2页）。先按本轮应用名过滤再定位行，避免只扫当前页漏检。
          await fillTextByLabel(page, '应用名称', appName);
          await clickVisibleAction(page, /查\s*询|搜\s*索/);
          const dataRow = appDataRows(page).filter({ hasText: appName }).first();
          await expect(dataRow).toBeVisible();
        });
        // 阶段二：编辑应用 —— 校验弹窗回显本轮应用名；改描述保存后重开弹窗二次回显
        // （不再“只点保存”，用真实数据变更验证编辑落库）。
        await test.step('阶段二：编辑应用（回显+真实修改）', async () => {
          const index = await rowIndexByText(appDataRows(page), appName);
          await clickVisibleAction(await appOperationRows(page).nth(index), /编\s*辑/);
          const dialog = await visibleDialog(page);
          const fields = dialog.getByRole('textbox');
          // 回显断言：编辑弹窗第一个文本框必须预填本轮应用名。
          await expect(fields.first()).toHaveValue(appName, { timeout: 10_000 });
          const fieldCount = await fields.count();
          const editedDesc = `E2E application ${appName}_edited`;
          if (fieldCount > 1) await fields.nth(1).fill(editedDesc);
          await clickDialogButton(page, /保\s*存|确\s*定/);
          await expectToast(page, /成功|保存/);
          await closeVisibleDialog(page);
        });
        // 阶段三：成员管理 —— 真实添加本轮成员并回显（不再只开关弹窗）。
        await test.step('阶段三：成员管理添加本轮成员', async () => {
          await addRoundAppMember(page, appName, memberName);
        });
        // 阶段四：关联 API —— 上线本轮 API，经 API 商店把权限申请关联到本轮应用。
        await test.step('阶段四：上线 API 并在商店申请权限', async () => {
          await clickMenu(page, '数据服务', 'API管理');
          await toggleRoundApiOnline(page, apiName, /上\s*线/);
          await clickMenu(page, '数据服务', 'API应用', 'API商店');
          const storeQuery = page.getByRole('textbox').first();
          await expect(storeQuery).toBeVisible({ timeout: 10_000 });
          await storeQuery.fill(apiName);
          const storeQueryButton = page.getByRole('button', { name: /查\s*询/ }).last();
          if (await storeQueryButton.isVisible().catch(() => false)) await storeQueryButton.click();
          await page.waitForTimeout(500);
          const storeCard = await requireStoreCard(page, apiName);
          const applyAction = storeCard.getByText('申请权限', { exact: true }).last();
          await expect(applyAction).toBeVisible();
          await applyAction.click();
          await applyStorePermission(page, appName);
        });
        // 阶段五：关联API清单 —— 回显本轮 API 并行内撤销，撤销后行消失。
        await test.step('阶段五：关联API清单回显与撤销', async () => {
          await revokeRoundApiInDialog(page, appName, apiName);
        });
        // 阶段六：删除应用 —— Popconfirm 确认 + 查询刷新后行消失（保留既有断言语义）。
        await test.step('阶段六：删除应用', async () => {
          await fillTextByLabel(page, '应用名称', appName);
          await clickVisibleAction(page, /查\s*询/);
          const deleteIndex = await rowIndexByText(appDataRows(page), appName);
          await clickVisibleAction(await appOperationRows(page).nth(deleteIndex), /删\s*除/);
          // 该页的删除确认是 Popconfirm（aria role=tooltip，内容“确定要删除吗？”），
          // 不是 Modal.confirm，页面上不会出现 role=dialog（run-20260916-172255
          // 快照实证）。此前“全页匹配 确定/删除”在气泡挂载前命中的是行内“删除”
          // 按钮本身，二次点击把气泡切没了，删除接口从未发出；而编辑保存的
          // “修改成功”toast 仍在可见期内，被 /成功|删除/ 误判成删除成功。
          // 现改为等待气泡挂载后在其范围内点击“确 定”；成功判定只认“成功”，
          // 避免把“删除失败”toast 当成通过。
          const popconfirm = page.getByRole('tooltip').filter({ hasText: '确定要删除吗' }).last();
          await expect(popconfirm).toBeVisible();
          await popconfirm.getByRole('button', { name: /确\s*定/ }).click();
          await expectToast(page, /成\s*功/);
          // 删除成功后应用列表不会自动刷新（run-20260916-160544 快照实证：删除
          // toast 后过滤行仍显示已删应用）。主动点击“查询”重拉列表，再断言
          // 本轮应用行消失；若删除实际未成功，这里仍会以真实列表内容失败。
          await clickVisibleAction(page, /查\s*询/);
          await expect(appDataRows(page).filter({ hasText: appName })).toHaveCount(0);
        });
        await assertNoConsoleErrors(consoleErrors);
        await report('DS-04-01｜注册/编辑/成员关联/API关联/撤销全链路', true,
          `应用=${appName}；API=${apiName}；成员=${memberName}（邀请${memberInvited ? '成功' : '入口不可见，未执行'}）`);
      } finally {
        // 清理顺序：先删应用（解除成员/API 引用），再删 API、成员用户；各自 best-effort，
        // 只作用本轮唯一命名资源。
        await deleteRoundAppIfPresent(page, appName);
        await deleteRoundApiIfPresent(page, apiName);
        await deleteRoundMemberIfPresent(page, memberName);
      }
    })
});
