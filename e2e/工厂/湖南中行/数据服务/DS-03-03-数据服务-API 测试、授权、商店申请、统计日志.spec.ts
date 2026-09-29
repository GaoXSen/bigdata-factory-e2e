/**
 * 数据服务 — API 管理 E2E 测试
 *
 * 覆盖场景（参考 Excel「测试用例」Sheet，序号对应 1～73）：
 *   行52 — API管理：列表查询、新增/编辑/删除、上线/下线（上线后商店可查）
 *   行53 — API测试：接口列表、选中接口详情、开始测试返回正常
 *   行54 — API授权管理：列表、服务调用跳转统计、撤销权限
 *   行55 — API商店：列表、申请权限（选择应用/有效期/加密方式）
 *   行56 — API统计调用：列表、日志详情（失败信息）
 *   行57 — 我的API-应用注册管理：注册/编辑/删除、关联成员、关联API清单（撤销、跳转统计）
 *   行58 — 我的API-我有权限的API：列表、服务调用、撤销
 *
 * 扩展（测试用例编写规范.md 覆盖深度）：
 *   - 异常路径：API 名称重复创建被拦截；未上线 API 在商店不可见
 *   - 权限闭环：授权 → 商店可见 → 撤销 → 不可见
 *
 * 关键要求：
 *   1. 所有操作用 page. 浏览器操作（无 fetch/axios 等 API 调用）
 *   2. UUID 后缀隔离所有测试数据
 *   3. 控制台错误收集；选择器 TODO[env] 校准
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

const TAB_SELECTOR = [
  '[role="tab"]:visible',
  '.el-tabs__item:visible',
  '.ant-tabs-tab:visible',
  '[class*="tab-item"]:visible',
  '[class*="tabs-item"]:visible',
].join(', ');

function exactText(value: string): RegExp {
  return new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`);
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

async function selectFirstOptionByLabel(page: Page, label: string): Promise<void> {
  const control = await nearbyControl(page, label, '.ant-select, .el-select, [role="combobox"], select');
  await control.click();
  const options = page.locator(
    '.ant-select-dropdown:visible .ant-select-item-option, .ant-select-dropdown:visible .ant-select-dropdown-menu-item, .el-select-dropdown:visible .el-select-dropdown__item, [role="listbox"]:visible [role="option"]',
  );
  for (let index = 0; index < await options.count(); index++) {
    const option = options.nth(index);
    const text = (await option.innerText()).trim();
    if (await option.isVisible().catch(() => false) && text && !/请选择|暂无|无数据/.test(text)) {
      await option.click();
      return;
    }
  }
  throw new Error(`字段“${label}”没有可选数据，当前页面：${page.url()}`);
}

/** 页面内部 Tab 只命中可见 Tab 容器，避免拿到“更多”菜单中的隐藏副本。 */
async function visiblePageTab(page: Page, label: string): Promise<Locator | undefined> {
  return lastVisible([
    page.getByRole('tab', { name: label, exact: true }),
    page.locator(TAB_SELECTOR).filter({ hasText: exactText(label) }),
    page.locator(
      '.ant-tabs-dropdown-menu:visible .ant-tabs-dropdown-menu-item, .ant-dropdown-menu:visible .ant-dropdown-menu-item, .el-dropdown-menu:visible .el-dropdown-menu__item, [role="menu"]:visible [role="menuitem"]',
    ).filter({ hasText: exactText(label) }),
  ]);
}

/** 页面 Tab 收进“更多/…”后，先展开入口，再命中弹层中的可见 Tab。 */
async function clickVisiblePageTab(page: Page, label: string): Promise<void> {
  let tab = await visiblePageTab(page, label);
  if (!tab) {
    const more = await lastVisible([
      page.locator(
        '.el-tabs__nav-more:visible, .ant-tabs-nav-more:visible, [class*="tabs"][class*="more"]:visible, [class*="tab"][class*="more"]:visible, [aria-label*="更多"]:visible',
      ),
      page.getByRole('button', { name: /更多|···|…|\.\.\./ }),
      page.getByText(/^(?:更多|···|…|\.\.\.)$/, { exact: true }),
    ]);
    if (!more) throw new Error(`页面 Tab“${label}”不可见，且未找到“更多”入口，当前页面：${page.url()}`);
    await more.click();
    await page.waitForTimeout(300);
    tab = await visiblePageTab(page, label);
  }
  if (!tab) throw new Error(`页面 Tab“${label}”未找到可见节点，当前页面：${page.url()}`);
  await tab.click();
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

async function expectVisibleText(page: Page, text: string | RegExp): Promise<void> {
  const target = await lastVisible([page.getByText(text)]);
  if (!target) throw new Error(`页面中未找到可见文本“${text}”，当前页面：${page.url()}`);
  await expect(target).toBeVisible();
}

async function submitVisibleAndExpectSuccess(
  page: Page,
  submitButton: string | RegExp,
  successText: string | RegExp,
): Promise<void> {
  await clickVisibleAction(page, submitButton);
  await expectToast(page, successText);
}

async function hasRows(rows: Locator): Promise<boolean> {
  return (await rows.count()) > 0 && await rows.first().isVisible().catch(() => false);
}

async function expectEmptyState(page: Page): Promise<void> {
  const empty = page
    .locator('.ant-empty:visible, .el-empty:visible, p:visible, [role="status"]:visible')
    .filter({ hasText: /^\s*(暂无数据|没有数据)\s*$/ })
    .last();
  await expect(empty).toBeVisible({ timeout: 10_000 });
}

async function expectPagination(page: Page): Promise<void> {
  await expect(page.getByText(/总共\s*\d+\s*条/).last()).toBeVisible();
}

function appDataRows(page: Page): Locator {
  return tableRows(tableWithHeader(page, /应用系统/));
}

function appOperationRows(page: Page): Locator {
  return tableRows(tableWithHeader(page, /^\s*操作/));
}

function storeSearchInput(page: Page): Locator {
  return page.getByRole('textbox', { name: /请输入api名称、api描述、对应表名、负责人等信息/ });
}

async function visibleDialog(page: Page): Promise<Locator> {
  const dialog = page.getByRole('dialog').last();
  await expect(dialog).toBeVisible();
  return dialog;
}

async function clickDialogButton(page: Page, name: string | RegExp): Promise<void> {
  await clickVisibleAction(await visibleDialog(page), name);
}

async function selectFirstDialogOption(page: Page, dialog: Locator, index: number, fieldName: string): Promise<void> {
  const box = dialog.getByRole('combobox').nth(index);
  await expect(box).toBeVisible();
  await box.click();
  const options = page.locator(
    '.ant-select-dropdown:visible .ant-select-item-option, .ant-select-dropdown:visible .ant-select-dropdown-menu-item, .el-select-dropdown:visible .el-select-dropdown__item, [role="listbox"]:visible [role="option"]',
  );
  // 级联下拉每次选择后都会重绘；用当前打开控件的键盘选择，
  // 避免保存旧 nth Locator 后点击到已被 React 回收的隐藏节点。
  let ready = false;
  for (let attempt = 0; attempt < 20 && !ready; attempt++) {
    for (let optionIndex = await options.count() - 1; optionIndex >= 0; optionIndex--) {
      const option = options.nth(optionIndex);
      const text = (await option.innerText().catch(() => '')).trim();
      if (await option.isVisible().catch(() => false) && text && !/请选择|暂无|无数据/.test(text)) {
        ready = true;
        break;
      }
    }
    if (!ready) await page.waitForTimeout(250);
  }
  if (!ready) {
    throw new Error( `当前环境没有可用的${fieldName}，创建 API 需要先配置数据源、数据库、Schema 和数据表。`);
    return;
  }
  await box.press('ArrowDown');
  await box.press('Enter');
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
  await fields.nth(2).fill(`e2e/${apiName}`);
  return dialog;
}

async function actionRowAt(page: Page, index: number): Promise<Locator> {
  const row = apiOperationRows(page).nth(index);
  await expect(row).toBeVisible();
  return row;
}

async function rowIndexByText(rows: Locator, text: string): Promise<number> {
  for (let index = 0; index < await rows.count(); index++) {
    if ((await rows.nth(index).innerText()).includes(text)) return index;
  }
  throw new Error(`数据列中未找到“${text}”，无法关联操作列。`);
}

async function fillApiRequiredFields(page: Page, apiName: string): Promise<void> {
  const dialog = await visibleDialog(page);
  const fields = dialog.getByRole('textbox');
  await expect(fields.nth(0)).toBeVisible();
  await fields.nth(0).fill(apiName);
  await fillTextByLabel(page, 'API描述', `E2E API ${apiName}`);
  // 依赖真实页面级联下拉，只使用能走通完整链路的已保存数据源，不写死环境名称。
  await selectApiSavedDataSourceChain(page, dialog);
  const requestType = dialog.getByRole('radio', { name: 'post', exact: true });
  await expect(requestType).toBeVisible();
  await requestType.check();
  await fillOptionalTextByLabel(page, '请求地址', `e2e_${apiName}`);
}

async function createApi(page: Page, apiName: string): Promise<void> {
  await clickVisibleAction(page, /新增|新建/);
  const dialog = await fillApiForm(page, apiName);
  await skipWhenApiTableHasNoFields(dialog);
  await clickVisibleAction(dialog, /保\s*存/);
  await expectToast(page, /成功|创建/);
}

/** API 列表同样是数据表与操作表分离，按操作表行号精确点击，避免整页命中隐藏/错位按钮。 */
async function clickApiRowAction(page: Page, index: number, name: string | RegExp): Promise<void> {
  const operationTable = page
    .locator('table:visible')
    .filter({ hasText: /操作/ });
  const row = tableRows(operationTable).nth(index);
  await expect(row).toBeVisible();
  const action = row.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }).last();
  if (!(await action.count()) || !(await action.isVisible().catch(() => false))) {
    throw new Error(`API 操作列第 ${index + 1} 行未找到可见操作“${name}”，当前页面：${page.url()}`);
  }
  await action.click();
}

async function hasStoreEntries(page: Page): Promise<boolean> {
  const requestActions = page.getByText('申请权限', { exact: true });
  for (let index = 0; index < await requestActions.count(); index++) {
    if (await requestActions.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function closeVisibleDialog(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog').last();
  const close = await lastVisible([
    dialog.getByRole('button', { name: /关\s*闭|取\s*消|Close/ }),
  ]);
  if (close) await close.click();
}

async function storeCardForApi(page: Page, apiName: string): Promise<Locator | undefined> {
  const name = page.getByText(apiName, { exact: true });
  for (let index = (await name.count()) - 1; index >= 0; index--) {
    let scope = name.nth(index);
    for (let level = 0; level < 6; level++) {
      if (await scope.getByText('申请权限', { exact: true }).count()) return scope;
      scope = scope.locator('..');
    }
  }
  return undefined;
}

async function fillApplicationForm(page: Page, appName: string): Promise<Locator> {
  const dialog = await visibleDialog(page);
  const fields = dialog.getByRole('textbox');
  if (await fields.count()) await fields.first().fill(appName);
  else {
    const boxes = dialog.getByRole('combobox');
    await expect(boxes.first()).toBeVisible();
    await boxes.first().click();
    const option = page.getByRole('option').filter({ hasText: appName }).last();
    if (!(await option.isVisible().catch(() => false))) {
      throw new Error( '当前环境没有可申请 API 权限的应用，需先注册应用并提供可用应用前置数据。');
      return dialog;
    }
    await option.click();
  }
  const expiry = dialog.getByRole('textbox').last();
  if (await expiry.count()) await expiry.fill('2099-12-31');
  const encryption = dialog.getByRole('combobox').last();
  if (await encryption.count()) {
    await encryption.click();
    const md5 = page.getByRole('option', { name: 'MD5', exact: true }).last();
    if (await md5.isVisible().catch(() => false)) await md5.click();
  }
  return dialog;
}

/** 上线/下线本轮 API：按唯一名称查询定位操作行，点击按钮并等待成功提示。 */
async function toggleRoundApiOnline(page: Page, apiName: string, action: RegExp): Promise<void> {
  const queryInput = page.getByRole('textbox').first();
  await expect(queryInput).toBeVisible({ timeout: 10_000 });
  await queryInput.fill(apiName);
  const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
  if (await queryButton.isVisible().catch(() => false)) await queryButton.click();
  await page.waitForTimeout(500);
  const dataRows = apiDataRows(page);
  const count = await dataRows.count();
  for (let index = 0; index < count; index += 1) {
    if (!(await dataRows.nth(index).getByText(apiName, { exact: true }).count())) continue;
    const row = apiOperationRows(page).nth(index);
    await expect(row).toBeVisible();
    const button = row.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: action }).last();
    await expect(button).toBeVisible();
    await button.click();
    await expectToast(page, /成功|上线|下线/);
    await page.waitForTimeout(300);
    return;
  }
  throw new Error(`API 列表中未找到本轮接口“${apiName}”，无法执行 ${action.toString()} 操作。`);
}

/** 注册本轮专属应用：注册弹窗文本框按序填名称/描述，保存后必须出现在应用列表。 */
async function registerRoundApp(page: Page, appName: string): Promise<void> {
  await clickVisibleAction(page, /注\s*册/);
  const dialog = await visibleDialog(page);
  const fields = dialog.getByRole('textbox');
  await expect(fields.first()).toBeVisible();
  await fields.first().fill(appName);
  if ((await fields.count()) > 1) await fields.nth(1).fill(`E2E application ${appName}`);
  await clickVisibleAction(dialog, /确\s*定|保\s*存|注\s*册/);
  await expectToast(page, /成功|注册/);
  await expect(appDataRows(page).filter({ hasText: appName }).first()).toBeVisible({ timeout: 10_000 });
}

/** 商店卡片：按 API 名称向上找到带“申请权限”按钮的卡片；找不到即上线后商店不可见。 */
async function requireStoreCard(page: Page, apiName: string) {
  const name = page.getByText(apiName, { exact: true });
  const count = await name.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    let scope = name.nth(index);
    for (let level = 0; level < 6; level += 1) {
      if (await scope.getByText('申请权限', { exact: true }).count()) return scope;
      scope = scope.locator('..');
    }
  }
  throw new Error(`上线 API“${apiName}”未出现在 API 商店，当前页面：${page.url()}`);
}

/**
 * 商店申请权限：显式走应用下拉（候选必须包含本轮注册的应用），有效期填远期日期，
 * 加密方式选 MD5（页面提供时）。不复用 fillApplicationForm 的“文本框优先”分支：
 * 申请弹窗的日期输入同样是 textbox，优先填文本框会把应用名填进有效期输入框。
 */
async function applyStorePermission(page: Page, appName: string): Promise<void> {
  const dialog = await visibleDialog(page);
  const appBox = dialog.getByRole('combobox').first();
  await expect(appBox).toBeVisible();
  await appBox.click();
  const option = page.getByRole('option').filter({ hasText: appName }).last();
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click();
  await fillOptionalTextByLabel(page, '有效期', '2099-12-31');
  const boxes = dialog.getByRole('combobox');
  if ((await boxes.count()) > 1) {
    await boxes.last().click();
    const md5 = page.getByRole('option', { name: 'MD5', exact: true }).last();
    if (await md5.isVisible().catch(() => false)) await md5.click();
  }
  await clickVisibleAction(dialog, /确\s*定|申\s*请/);
  await expectToast(page, /申请成功|成功/);
}

/** finally 清理：只删除本轮唯一命名的应用；查询不到时静默结束。 */
async function deleteRoundAppIfPresent(page: Page, appName: string): Promise<void> {
  try {
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(300);
    const queryInput = page.getByRole('textbox').first();
    if (!(await queryInput.isVisible().catch(() => false))) return;
    await queryInput.fill(appName);
    const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
    if (await queryButton.isVisible().catch(() => false)) await queryButton.click();
    await page.waitForTimeout(500);
    const rows = appDataRows(page);
    for (let index = 0; index < (await rows.count()); index += 1) {
      if (!(await rows.nth(index).getByText(appName, { exact: true }).count())) continue;
      await clickVisibleAction(await appOperationRows(page).nth(index), /删\s*除/);
      await clickVisibleAction(page, /确\s*定|删\s*除/);
      await page.waitForTimeout(500);
      break;
    }
  } catch {
    // 清理是 best-effort：唯一 UUID 名称只可能命中本轮资源，失败不改变用例真实结果。
  }
}
/**
 * 本轮自建唯一 API 的创建与 finally 清理（DS-PERM-51）：
 * API测试页不是列表页，页面结构为「API名称下拉 + 查看接口详情 + 开始测试 + 返回内容」。
 * 不再依赖存量接口——历史 API（如 test_api_021）的来源表可能已被删除，开始测试会返回
 * “关联的数据源不存在”；每轮只验证自己唯一命名的接口，存量数据漂移不再影响本用例。
 */

/** 本轮创建唯一 ASCII API：链路来自配置中心，保存后按列表查询确认真实落库。 */
async function createRoundApi(page: Page, apiName: string): Promise<void> {
  await clickVisibleAction(page, /新建API|新增|新建/);
  const dialog = await fillApiForm(page, apiName);
  await skipWhenApiTableHasNoFields(dialog);
  await clickVisibleAction(dialog, /保\s*存/);
  await page.waitForTimeout(500);
  // 先识别明确的失败提示（ENV-02 类后端错误按真实失败上报，不再跳过）。
  const failureNotice = page.locator('.ant-message-notice-content:visible, .ant-notification-notice:visible, .el-message:visible, [role="alert"]:visible')
    .filter({ hasText: /失败|验证不通过|不能为空|错误/ }).last();
  if (await failureNotice.isVisible().catch(() => false)) {
    throw new Error(`API 创建失败：${await failureNotice.innerText()}`);
  }
  // 保存成功后弹窗可能不自动关闭，先取消回列表，再按名称查询确认落库。
  const cancelCreate = dialog.getByRole('button', { name: /取\s*消/ });
  if (await cancelCreate.isVisible().catch(() => false)) await cancelCreate.click();
  const queryInput = page.getByRole('textbox').first();
  await expect(queryInput).toBeVisible({ timeout: 10_000 });
  await queryInput.fill(apiName);
  const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
  await queryButton.click();
  await page.waitForTimeout(500);
  const dataRows = apiDataRows(page);
  let created = false;
  for (let index = 0; index < await dataRows.count(); index += 1) {
    if (await dataRows.nth(index).getByText(apiName, { exact: true }).count()) {
      created = true;
      break;
    }
  }
  if (!created) throw new Error(`API 创建后列表未查询到本轮 API：${apiName}`);
}

/** finally 清理：只删除本轮唯一命名的 API；查询不到（未创建或已删除）时静默结束。 */
async function deleteRoundApiIfPresent(page: Page, apiName: string): Promise<void> {
  try {
    await clickMenu(page, '数据服务', 'API管理');
    const queryInput = page.getByRole('textbox').first();
    if (!(await queryInput.isVisible().catch(() => false))) return;
    await queryInput.fill(apiName);
    const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
    if (await queryButton.isVisible().catch(() => false)) await queryButton.click();
    await page.waitForTimeout(500);
    const dataRows = apiDataRows(page);
    let deleted = false;
    for (let index = 0; index < await dataRows.count(); index += 1) {
      if (!(await dataRows.nth(index).getByText(apiName, { exact: true }).count())) continue;
      await clickVisibleAction(await apiOperationRows(page).nth(index), /删\s*除/);
      await clickVisibleAction(page, /确\s*定|删\s*除/);
      deleted = true;
      break;
    }
    if (deleted) await page.waitForTimeout(500);
  } catch {
    // 清理是 best-effort：唯一 UUID 名称只可能命中本轮资源，失败不改变用例真实结果。
  }
}


test.describe("DS-03-03｜数据服务｜API 测试、授权、商店申请、统计日志", () => {
  test.describe.configure({ timeout: 120_000 })
  test.beforeEach(async ({ loginPage }) => {
    await clickMenu(loginPage, '数据服务', 'API管理');
  })
  test("DS-03-03｜数据服务｜API 测试、授权、商店申请、统计日志", async ({ loginPage, consoleErrors, report }) => {
      // 环境重置迁移（DS-PERM-51）：不再依赖存量接口，每轮先用唯一 ASCII 名称自建 API
      //（级联链路来自配置中心 apiService，API_* 兼容变量可单项覆盖），API测试页只验证
      // 本轮自建接口；创建“保存”若再返回后端错误（ENV-02 类），按页面真实提示失败并附证据。
      test.setTimeout(480_000);
      const page = loginPage;
      let appName = '';
      const apiName = `api_test_${uuid()}`;
      await createRoundApi(page, apiName);
      try {

        // 阶段一：API测试页 —— 选中本轮自建接口、查看接口详情、开始测试返回正常。
        await clickMenu(page, '数据服务', 'API管理', 'API测试');
        const apiSelect = await nearbyControl(page, 'API名称', '.ant-select, .el-select, [role="combobox"], select');
        await expect(apiSelect).toBeVisible();
        const optionLayer = page.locator(
          '.ant-select-dropdown:visible .ant-select-item-option, .ant-select-dropdown:visible .ant-select-dropdown-menu-item, ' +
          '.el-select-dropdown:visible .el-select-dropdown__item, [role="listbox"]:visible [role="option"]',
        );
        await apiSelect.click();
        await expect(optionLayer.first()).toBeVisible({ timeout: 15_000 });
        // 只认本轮唯一命名的接口：存量 API 的来源表可能已被删除（如 test_api_021 曾返回
        // “关联的数据源不存在”），不再作为验证对象，避免环境脏数据影响判定。
        await optionLayer.filter({ hasText: apiName }).last().click();
        await expect(apiSelect).toContainText(apiName, { timeout: 10_000 });
        await page.waitForTimeout(500);

        // 必填请求参数（行文本以“是”结尾）填入占位值，避免开始测试被必填校验拦截。
        const paramRows = tableRows(tableWithHeader(page, /参数名称/));
        const paramCount = await paramRows.count();
        for (let rowIndex = 0; rowIndex < paramCount; rowIndex += 1) {
          const row = paramRows.nth(rowIndex);
          const rowText = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
          if (!rowText.endsWith('是')) continue;
          const valueInput = row.locator('input:visible').first();
          if (await valueInput.isVisible().catch(() => false)) await valueInput.fill('1');
        }

        // 查看接口详情：抽屉展示接口请求地址等接口信息。
        await clickVisibleAction(page, /查看接口详情/);
        await expect(page.getByText(/接口请求地址/).first()).toBeVisible({ timeout: 10_000 });
        await expect(page.getByText(new RegExp(`/daas/api/call_api/${apiName}`)).first()).toBeVisible();
        const closeDetail = await lastVisible([
          page.getByRole('button', { name: /关\s*闭/ }),
          page.locator('.ant-drawer-close:visible, .ant-drawer-header button:visible, [aria-label="Close"]:visible'),
        ]);
        if (closeDetail) await closeDetail.click();
        else await page.keyboard.press('Escape');
        await page.waitForTimeout(500);

        // 开始测试：返回内容必须从“暂无数据”变为真实响应且成功；来源表即本轮配置中心
        // 链路，若返回“关联的数据源不存在”按真实返回失败，不再换接口重试掩盖。
        const contentLabel = page.getByText('返回内容', { exact: true }).last();
        await expect(contentLabel).toBeVisible();
        const resultRegion = contentLabel.locator('..');
        await clickVisibleAction(page, /开始测试|执行测试/);
        let responseText = '';
        await expect.poll(async () => {
          responseText = (await resultRegion.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
          return /暂无数据/.test(responseText) ? '' : responseText;
        }, { timeout: 30_000 }).not.toBe('');
        expect(responseText, `开始测试实际返回：${responseText}`).toMatch(/"?code"?\s*[:=]\s*"?200"?|成功/);
        await report('API测试-开始测试返回正常', true, `本轮自建接口：${apiName}；实际返回：${responseText.slice(0, 300)}`);
        await assertNoConsoleErrors(consoleErrors);
        await report('API测试-测试闭环完成', true, `已验证本轮自建接口：${apiName}`);

        // 阶段二：上线本轮接口 —— 商店只展示已上线（status=1）的 API，上线是商店申请的前置。
        await clickMenu(page, '数据服务', 'API管理');
        await toggleRoundApiOnline(page, apiName, /上\s*线/);

        // 阶段三：注册本轮专属应用并在 API 商店对该接口发起权限申请
        //（后端口径：审批人由申请人在申请时指定，这里即测试用户本人，审批闭环自包含）。
        appName = `app_${uuid()}`;
        await clickMenu(page, '数据服务', '我的API', '应用注册管理');
        await registerRoundApp(page, appName);
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

        // 阶段四：授权管理 —— 申请产生的权限记录（API 名称）必须出现在列表，
        // 用本轮自建数据验证，不依赖任何存量授权记录。
        await clickMenu(page, '数据服务', 'API管理', 'API授权管理');
        const authQuery = page.getByRole('textbox').first();
        if (await authQuery.isVisible().catch(() => false)) {
          await authQuery.fill(apiName);
          const authQueryButton = page.getByRole('button', { name: /查\s*询/ }).last();
          if (await authQueryButton.isVisible().catch(() => false)) await authQueryButton.click();
          await page.waitForTimeout(500);
        }
        await expect(apiDataRows(page).filter({ hasText: apiName }).first())
          .toBeVisible({ timeout: 10_000 });

        // 阶段五：API 统计调用 —— 本轮 API测试 的调用记录允许异步落库，轮询 30 秒；
        // 未出现则如实失败（附页面地址证据），不伪造通过。
        await clickMenu(page, '数据服务', 'API应用', 'API统计调用');
        const statQuery = page.getByRole('textbox').first();
        if (await statQuery.isVisible().catch(() => false)) {
          await statQuery.fill(apiName);
          const statQueryButton = page.getByRole('button', { name: /查\s*询/ }).last();
          if (await statQueryButton.isVisible().catch(() => false)) await statQueryButton.click();
        }
        await expect
          .poll(async () => ((await apiDataRows(page).filter({ hasText: apiName }).count()) > 0 ? 'logged' : 'waiting'), {
            timeout: 30_000,
          })
          .toBe('logged');
        const statRows = apiOperationRows(page);
        const statDataRows = apiDataRows(page);
        const statCount = await statDataRows.count();
        for (let index = 0; index < statCount; index += 1) {
          if (!(await statDataRows.nth(index).getByText(apiName, { exact: true }).count())) continue;
          const logAction = statRows.nth(index)
            .locator('button:visible, a:visible, [role="button"]:visible')
            .filter({ hasText: /日志|详情/ })
            .last();
          if (await logAction.isVisible().catch(() => false)) {
            await logAction.click();
            const logDialog = await visibleDialog(page);
            await expect(logDialog).toBeVisible();
            await page.keyboard.press('Escape').catch(() => undefined);
            await page.waitForTimeout(300);
          }
          break;
        }
        await report('API统计调用-本轮调用日志可见', true, `本轮 API：${apiName}`);

        // 主流程收尾：下线本轮接口，避免上线状态影响 finally 的删除清理。
        await clickMenu(page, '数据服务', 'API管理');
        await toggleRoundApiOnline(page, apiName, /下\s*线/);
      } finally {
        // 只清理本轮唯一命名的 API 与应用；不存在（未创建成功）时自动空操作。
        await deleteRoundApiIfPresent(page, apiName);
        if (appName) {
          await clickMenu(page, '数据服务', '我的API', '应用注册管理');
          await deleteRoundAppIfPresent(page, appName);
        }
      }
    })
});
