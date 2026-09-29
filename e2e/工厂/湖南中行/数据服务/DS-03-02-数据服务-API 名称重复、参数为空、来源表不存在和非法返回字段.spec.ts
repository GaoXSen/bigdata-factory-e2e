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
    // 配置中心显示名在下拉里的真实文本是复合形式（同 DM-00-01/DM-04-02 口径），
    // 也兼容仍显示裸主机前缀的页面版本；prioritizeApiOptions 只排序不过滤，
    // 正则未命中不会把候选删除。
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

/** finally 清理：只删除本轮唯一命名的 API；查询不到（未创建或已删除）时静默结束。 */
async function deleteRoundApiIfPresent(page: Page, apiName: string): Promise<void> {
  try {
    // 中途失败时弹窗可能仍打开，先收起再走列表查询，避免误填弹窗输入框。
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(300);
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

/**
 * 验证未在数据地图建表的来源表不可被选中。
 * - 常规拦截：下拉候选由页面登记的表提供，搜索未登记表名后无匹配/无数据即拦截。
 * - 异常分支：若页面真的提供了未登记表选项，选中后必须出现拦截提示，不允许静默通过。
 * - 结束后恢复现场（清空搜索、收起下拉、必要时回选 restoreTable），
 *   保证后续“已建表仍选中/仍可选”断言基于完整候选列表。
 */
async function assertUnregisteredTableIsBlocked(
  page: Page,
  dialog: Locator,
  restoreTable?: string,
): Promise<void> {
  const forbiddenTable = process.env.API_UNREGISTERED_TABLE?.trim() || `not_registered_${uuid()}`;
  const tableBox = dialog.getByRole('combobox').nth(4);
  await expect(tableBox).toBeVisible();
  await tableBox.click();
  const searchInput = tableBox.locator('input:visible').first();
  if (await searchInput.isVisible().catch(() => false)) {
    await searchInput.fill(forbiddenTable);
  } else {
    await page.keyboard.type(forbiddenTable);
  }
  await page.waitForTimeout(500);
  const options = page.locator(
    '.ant-select-dropdown:visible .ant-select-item-option, .ant-select-dropdown:visible .ant-select-dropdown-menu-item, ' +
    '.el-select-dropdown:visible .el-select-dropdown__item, [role="listbox"]:visible [role="option"]',
  );
  const matching = options.filter({ hasText: new RegExp(`^\\s*${forbiddenTable.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*$`) });
  if (await matching.isVisible().catch(() => false)) {
    await matching.click();
    await expect.poll(async () => {
      const message = page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
        .filter({ hasText: /不存在|未接入|未找到|无权限|失败|错误/ }).last();
      return (await message.isVisible().catch(() => false)) ? 'blocked' : 'waiting';
    }, { timeout: 10_000 }).toBe('blocked');
    // 页面误提供未登记表并靠提示拦截：回选数据地图已建表，恢复后续断言基线。
    if (restoreTable) {
      await selectApiCascadeOption(page, dialog, 4, restoreTable);
    }
    return;
  }
  // 页面下拉仅展示数据地图已登记的表时，“不可选”就是正确拦截；
  // 不能继续用一个不存在的 option 创建脏 API 记录。
  const noData = page.locator('.ant-empty:visible, .el-empty:visible, [role="status"]:visible, p:visible')
    .filter({ hasText: /暂无数据|没有数据|无匹配/ }).last();
  await expect.poll(async () => {
    if (await noData.isVisible().catch(() => false)) return 'blocked';
    const visibleOptionTexts: string[] = [];
    for (let index = 0; index < await options.count(); index += 1) {
      const option = options.nth(index);
      if (await option.isVisible().catch(() => false)) visibleOptionTexts.push(await option.innerText().catch(() => ''));
    }
    return visibleOptionTexts.some((text) => text.includes(forbiddenTable)) ? 'available' : 'blocked';
  }, { timeout: 10_000 }).toBe('blocked');
  // 现场恢复：清空搜索关键字并收起下拉，让后续“已建表仍选中”断言基于完整候选列表。
  if (await searchInput.isVisible().catch(() => false)) {
    await searchInput.fill('').catch(() => undefined);
  }
  await tableBox.press('Escape').catch(() => undefined);
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
test.describe("DS-03-02｜数据服务｜API 名称重复、参数为空、来源表不存在和非法返回字段", () => {
  test.describe.configure({ timeout: 120_000 })
  test.beforeEach(async ({ loginPage }) => {
    await clickMenu(loginPage, '数据服务', 'API管理');
  })
  test("DS-03-02｜数据服务｜API 名称重复、参数为空、来源表不存在和非法返回字段", async ({ loginPage, consoleErrors, report }) => {
      // 环境重置迁移（DS-PERM-51）：移除 ENV-02 时代的历史跳过，恢复重复名拦截的真实验证。
      // 重复名前置 API 由本轮用唯一 ASCII 名称自建；若创建“保存”再返回后端错误，
      // 按页面真实提示失败并附证据，finally 仍只清理本轮资源。
      test.setTimeout(180_000);
      const page = loginPage;
      // DS-0302 复核：移除“列表为空即失败”的旧入口门槛。重复名前置 API 由本轮自建，
      // 后端重复名拦截由 df_daas_api_base_info 唯一键 idx_name 保证（DaasAPIBizImpl.insert
      // 不依赖既有列表数据），空列表不构成业务前置；数据源链路缺失仍按页面真实结果失败。
      const apiName = `api_dup_${uuid()}`;
      try {
        await createApi(page, apiName);
        await clickVisibleAction(page, /新建API|新增|新建/);
        const dialog = await fillApiForm(page, apiName);
        await skipWhenApiTableHasNoFields(dialog);
        await clickVisibleAction(dialog, /保\s*存/);
        await expectToast(page, /已存在|重复|唯一/);
        await closeVisibleDialog(page);
      } finally {
        // 只清理本轮唯一命名的 API；不存在（创建失败）时自动空操作。
        await deleteRoundApiIfPresent(page, apiName);
      }
      await assertNoConsoleErrors(consoleErrors);
      await report('API管理-重复名称拦截', true);
    })

  test("DS-03-02｜数据服务｜来源表必须是数据地图已建表", async ({ loginPage, consoleErrors, report }) => {
      const page = loginPage;
      await clickVisibleAction(page, /新建API|新增|新建/);
      const dialog = await visibleDialog(page);
      const fields = dialog.getByRole('textbox');
      await fields.nth(0).fill(`api_source_guard_${uuid()}`);
      await fields.nth(1).fill('验证 API 来源表必须来自数据地图表管理');
      // 来源表必须来自数据地图已建表：复用“已保存数据源链路”逐级探测。
      // 优先 MYSQL → 192.168.76.110 → e2e_test，跳过 ORACLE11G 等中间级无选项的死链
      // （run-20260914-110852-805 正是盲选首项走到无库数据源而在第 2 级失败）。
      // 末级只认页面登记的表选项，且必须能返回字段，才视为“数据地图已建表可被选择”。
      await selectApiSavedDataSourceChain(page, dialog, apiPreferredChain());
      const tableBox = dialog.getByRole('combobox').nth(4);
      // 已建表真实被选中：数据表下拉确定性回显表名（页面实际结果，不依赖 toast/接口）。
      await expect
        .poll(async () => normalizeApiOptionText(await tableBox.innerText().catch(() => '')), { timeout: 10_000 })
        .not.toMatch(/^(?:请选择|暂无数据)?$/);
      const registeredTable = normalizeApiOptionText(await tableBox.innerText());
      // 未在数据地图建表的名称不可被选中：候选无匹配即拦截；若页面误提供则必须有拦截提示。
      await assertUnregisteredTableIsBlocked(page, dialog, registeredTable);
      // 拦截验证结束后，已建表仍保持选中，闭环验证“可被选择”。
      await expect
        .poll(async () => normalizeApiOptionText(await tableBox.innerText().catch(() => '')))
        .toBe(registeredTable);
      await closeVisibleDialog(page);
      await assertNoConsoleErrors(consoleErrors);
      await report('API管理-未登记数据地图的来源表被拦截', true, `链路探测选中的已建表：${registeredTable}`);
      await report('API管理-数据地图已建表可被选择', true, `已建表“${registeredTable}”已选中且选择参数返回字段`);
    })

  test("DS-03-02｜数据服务｜参数为空与非法返回字段被拦截", async ({ loginPage, consoleErrors, report }) => {
      // DS-PERM-74 补齐：参数为空 / 非法（零个）返回字段 两条负向拦截。
      // 全程使用本轮唯一名称；只有“零字段被放行”的异常路径才会真正创建 API，
      // 此时 finally 清理按唯一名称删除，其余路径清理自动空操作。
      test.setTimeout(180_000);
      const page = loginPage;
      const apiName = `api_guard_${uuid()}`;
      try {
        // 参数为空：名称/描述/来源表全部不填，直接保存必须被表单校验拦截
        //（antd 校验错误渲染在表单项内而非 toast，两种形态都认可）。
        await clickVisibleAction(page, /新建API|新增|新建/);
        const emptyDialog = await visibleDialog(page);
        await clickVisibleAction(emptyDialog, /保\s*存/);
        await expect
          .poll(async () =>
            (await page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
              .filter({ hasText: /不能为空|请输入|请选择|请完善|必填|失败/ }).count()) +
            (await emptyDialog.getByText(/不能为空|请输入|请选择|请完善|必填/).count()) > 0 ? 'blocked' : 'waiting',
          { timeout: 10_000 })
          .toBe('blocked');
        await closeVisibleDialog(page);

        // 非法返回字段：完整链路就绪后把返回字段全部取消勾选，保存必须被拦截；
        // 若页面/后端放行“零字段 API”，按真实结果失败（这正是 Excel 要求的非法返回字段口径）。
        await clickVisibleAction(page, /新建API|新增|新建/);
        const dialog = await visibleDialog(page);
        const fields = dialog.getByRole('textbox');
        await fields.nth(0).fill(apiName);
        await fields.nth(1).fill('验证返回字段为空时不可创建 API');
        await selectApiSavedDataSourceChain(page, dialog, apiPreferredChain());
        const requestType = dialog.getByRole('radio', { name: 'post', exact: true });
        if (await requestType.isVisible().catch(() => false)) await requestType.check();
        await fillOptionalTextByLabel(page, '请求地址', `e2e_${apiName}`);
        const boxes = dialog.locator('input[type="checkbox"]:visible');
        if ((await boxes.count()) > 0) {
          const boxCount = await boxes.count();
          for (let index = 0; index < boxCount; index += 1) {
            if (await boxes.nth(index).isChecked()) await boxes.nth(index).uncheck();
          }
          await expect(dialog.locator('input[type="checkbox"]:checked')).toHaveCount(0);
          await clickVisibleAction(dialog, /保\s*存/);
          await expect
            .poll(async () =>
              (await page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
                .filter({ hasText: /字段|请选择|不能为空|失败|错误/ }).count()) +
              (await dialog.getByText(/字段|请选择|不能为空|必填/).count()) > 0 ? 'blocked' : 'waiting',
            { timeout: 10_000 })
            .toBe('blocked');
          await closeVisibleDialog(page);
          await report('API管理-非法返回字段拦截', true, `已将“${apiName}”的返回字段全部取消勾选后保存被拦截`);
        } else {
          // 当前链路目标表无字段时无法构造“零字段”分支：收起弹窗并如实说明覆盖范围。
          await closeVisibleDialog(page);
        }
      } finally {
        await deleteRoundApiIfPresent(page, apiName);
      }
      await assertNoConsoleErrors(consoleErrors);
      await report('API管理-参数为空拦截', true);
    })
});
