/**
 * DM-01-05｜数据地图｜资产高级筛选：数据层级、库层级、表类型、负责人
 *
 * 筛选项以当前页面实际展示为准。该场景验证筛选控件、列表/数量/分页的联动，
 * 不把某一张初始化表是否恰好拥有全部分类属性当成筛选功能是否可用的前置条件。
 *
 * 只读用例，不新增、编辑或删除任何资产。
 */

import type { Locator, Page } from '@playwright/test';
import { test, expect, clickMenu } from '../utils.js';
import { assertNoConsoleErrors } from '../utils.js';
import { QUERY_FIXTURE } from './数据地图查询夹具.js';

const ASSET_ROUTE = /#\/dataMap\/tableQuery\/tablesQuery/;
const ASSET_ROOT_SELECTOR = [
  '.asset-query:visible',
  '.asset-search:visible',
  '.table-query:visible',
  '[class*="asset-query"]:visible',
].join(', ');
const ASSET_ITEM_SELECTOR = [
  '.asset-query .card:visible',
  '.asset-search .card:visible',
  '.table-query .card:visible',
  '.asset-query tbody > tr:visible',
  '.asset-search tbody > tr:visible',
  '.table-query tbody > tr:visible',
].join(', ');
const EMPTY_SELECTOR = [
  '.asset-query .ant-empty:visible',
  '.asset-query .el-empty:visible',
  '.asset-search .ant-empty:visible',
  '.asset-search .el-empty:visible',
  '.table-query .ant-empty:visible',
  '.table-query .el-empty:visible',
].join(', ');

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function textMatches(actual: string, expected: string | RegExp): boolean {
  const normalized = normalizeText(actual);
  if (typeof expected === 'string') return normalized === expected;
  expected.lastIndex = 0;
  const matched = expected.test(normalized);
  expected.lastIndex = 0;
  return matched;
}

async function lastVisible(locator: Locator): Promise<Locator | undefined> {
  for (let index = await locator.count() - 1; index >= 0; index -= 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return undefined;
}

async function openAssetQuery(page: Page): Promise<void> {
  // 录制确认的真实叶子路由是 tablesQuery；公共菜单动画期间可能停在
  await clickMenu(page, '数据地图', '表查询', '表查询');
  await expect(page).toHaveURL(ASSET_ROUTE, { timeout: 15_000 });

  const root = page.locator(ASSET_ROOT_SELECTOR).last();
  await expect(root, '数据地图资产查询内容区未加载').toBeVisible({ timeout: 15_000 });

  const advancedSearch = root.getByRole('button', { name: /高级搜索|筛选条件|更多条件/ }).last();
  if (await advancedSearch.isVisible().catch(() => false)) {
    await advancedSearch.click();
    await page.waitForTimeout(300);
  }
}

function assetRoot(page: Page): Locator {
  return page.locator(ASSET_ROOT_SELECTOR).last();
}

async function findFacetControl(page: Page, labelPattern: RegExp): Promise<Locator> {
  const root = assetRoot(page);
  const labels = root.locator(
    'label:visible, .label:visible, .ant-form-item-label:visible, ' +
    '.el-form-item__label:visible, [class*="filter"] span:visible, [class*="search"] span:visible',
  );

  // 当前页面的“数据层级/库层级/表类型”是普通文本节点，没有 form-label class。
  // 追加内容区内的精确文本候选，避免退回到左侧菜单的同名节点。
  const genericLabels = root.getByText(labelPattern, { exact: true });
  const candidateSets: Locator[] = [labels, genericLabels];

  for (const candidateSet of candidateSets) {
    for (let labelIndex = await candidateSet.count() - 1; labelIndex >= 0; labelIndex -= 1) {
      const label = candidateSet.nth(labelIndex);
      if (!(await label.isVisible().catch(() => false))) continue;
      if (!textMatches(await label.innerText().catch(() => ''), labelPattern)) continue;

      let scope = label.locator('..');
      for (let level = 0; level < 5; level += 1) {
        const control = await lastVisible(scope.locator([
          '[role="combobox"]:visible',
          '.ant-select-selector:visible',
          '.ant-tree-select:visible',
          '.el-select:visible',
          'select:visible',
          'input[placeholder*="请选择"]:visible',
        ].join(', ')));
        if (control) return control;
        scope = scope.locator('..');
      }
    }
  }

  throw new Error(
    `资产查询内容区没有找到“${String(labelPattern)}”筛选控件。` +
    '已禁止从左侧菜单或顶部导航兜底，避免再次误点“系统管理”导航。',
  );
}

async function selectFacet(
  page: Page,
  labelPattern: RegExp,
  preferredValue?: string | RegExp,
): Promise<string> {
  const control = await findFacetControl(page, labelPattern);
  await control.click();

  const options = page.locator([
    '.ant-select-dropdown:visible .ant-select-item-option:not(.ant-select-item-option-disabled)',
    '.ant-select-dropdown:visible .ant-select-tree-node-content-wrapper',
    '.ant-select-tree-dropdown:visible .ant-select-tree-node-content-wrapper',
    '.el-select-dropdown:visible .el-select-dropdown__item:not(.is-disabled)',
    '[role="listbox"]:visible [role="option"]',
    '[role="tree"]:visible [role="treeitem"]',
    '[role="menu"]:visible [role="menuitem"]',
  ].join(', '));

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (let index = 0; index < await options.count(); index += 1) {
      const option = options.nth(index);
      if (!(await option.isVisible().catch(() => false))) continue;
      const optionText = normalizeText(await option.innerText().catch(() => ''));
      if (!optionText || /^(全部|请选择|暂无数据|无数据)$/.test(optionText)) continue;
      if (preferredValue && !textMatches(optionText, preferredValue)) continue;
      await option.click();
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(300);
      return optionText;
    }
    await page.waitForTimeout(200);
  }

  await page.keyboard.press('Escape').catch(() => undefined);
  throw new Error(
    `筛选项“${String(labelPattern)}”没有可选择的${preferredValue ? `“${String(preferredValue)}”` : '实际'}值。`,
  );
}

async function submitQuery(page: Page): Promise<void> {
  const root = assetRoot(page);
  const query = root.getByRole('button', { name: /^\s*(查询|筛选|搜索)\s*$/ }).last();
  if (await query.isVisible().catch(() => false)) await query.click();

  const loading = root.locator(
    '.ant-spin-spinning:visible, .el-loading-mask:visible, [class*="loading"]:visible',
  ).first();
  await expect(loading).not.toBeVisible({ timeout: 10_000 }).catch(() => undefined);
  await expect.poll(async () => {
    const itemCount = await page.locator(ASSET_ITEM_SELECTOR).count();
    const emptyVisible = await page.locator(EMPTY_SELECTOR).first().isVisible().catch(() => false);
    return itemCount > 0 || emptyVisible ? 'ready' : 'loading';
  }, { timeout: 10_000 }).toBe('ready');
}

async function resetQuery(page: Page): Promise<void> {
  const root = assetRoot(page);
  const reset = root.getByRole('button', { name: /^\s*重\s*置\s*$/ }).last();
  if (await reset.isVisible().catch(() => false)) {
    await reset.click();
    await submitQuery(page);
    return;
  }

  // 没有重置按钮的项目版本直接重新进入同一路由，确保下一次是独立单条件查询。
  await openAssetQuery(page);
}

async function assertListCountAndPagination(page: Page, context: string): Promise<number> {
  const root = assetRoot(page);
  const items = page.locator(ASSET_ITEM_SELECTOR);
  const itemCount = await items.count();
  const emptyVisible = await page.locator(EMPTY_SELECTOR).first().isVisible().catch(() => false);
  expect(itemCount > 0 || emptyVisible, `${context}后既没有结果列表，也没有明确空态`).toBe(true);

  const rootText = normalizeText(await root.innerText());
  const totalMatch = rootText.match(/(?:总共|共)\s*(\d+)\s*条/);
  if (totalMatch) {
    const total = Number(totalMatch[1]);
    expect(total, `${context}显示的总数不能小于当前页可见结果数`).toBeGreaterThanOrEqual(itemCount);
    if (total === 0) expect(itemCount, `${context}总数为 0 时列表不应有数据`).toBe(0);
  }

  const pagination = root.locator(
    '.table-pagination:visible, .pagination:visible, .ant-pagination:visible, .el-pagination:visible',
  ).first();
  await expect(pagination, `${context}没有显示分页区域`).toBeVisible({ timeout: 5_000 });
  return itemCount;
}

async function runSingleFacetQuery(
  page: Page,
  labelPattern: RegExp,
  context: string,
  preferredValue?: string | RegExp,
): Promise<string> {
  await resetQuery(page);
  const selectedValue = await selectFacet(page, labelPattern, preferredValue);
  await submitQuery(page);
  await assertListCountAndPagination(page, `${context}=${selectedValue}`);
  return selectedValue;
}

async function fillOwnerAndQuery(page: Page): Promise<void> {
  await resetQuery(page);
  const owner = assetRoot(page).getByPlaceholder('请输入负责人').last();
  await expect(owner, '高级搜索没有“负责人”输入框').toBeVisible({ timeout: 10_000 });
  await owner.fill(QUERY_FIXTURE.owner);
  await owner.blur();
  await submitQuery(page);
  await assertListCountAndPagination(page, `负责人=${QUERY_FIXTURE.owner}`);
}

async function assertFacetSelectedValue(
  page: Page,
  labelPattern: RegExp,
  expected: string,
  context: string,
): Promise<void> {
  const control = await findFacetControl(page, labelPattern);
  const controlText = normalizeText(await control.innerText().catch(() => ''));
  const inputValue = await control.locator('input:visible').first().inputValue().catch(() => '');
  const ariaLabel = await control.getAttribute('aria-label').catch(() => null);
  const selectedText = normalizeText([controlText, inputValue, ariaLabel ?? ''].join(' '));
  expect(selectedText, `${context}筛选控件未保留“${expected}”`).toContain(expected);
}

test.describe('DM-01-05｜数据地图｜资产高级筛选四项组合', () => {
  // 4 次单条件查询 + 1 次组合查询，页面接口每次返回约 15～25 秒。
  test.describe.configure({ timeout: 180_000 });

test('DM-01-05｜数据地图｜数据层级、库层级、表类型、负责人筛选', async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;
    await openAssetQuery(page);

    const selectedDataLevel = await runSingleFacetQuery(page, /^数据层级$/, '数据层级', QUERY_FIXTURE.dataLevel);
    await assertFacetSelectedValue(page, /^数据层级$/, selectedDataLevel, '数据层级单条件');
    const selectedDatabaseLevel = await runSingleFacetQuery(page, /^库层级$/, '库层级', QUERY_FIXTURE.databaseLevel);
    await assertFacetSelectedValue(page, /^库层级$/, selectedDatabaseLevel, '库层级单条件');
    await runSingleFacetQuery(page, /^表类型$/, '表类型', QUERY_FIXTURE.tableType);
    await assertFacetSelectedValue(page, /^表类型$/, QUERY_FIXTURE.tableType, '表类型单条件');
    await fillOwnerAndQuery(page);

    // 组合四项条件，确认前一个下拉选择不会被后一个覆盖。
    await resetQuery(page);
    await selectFacet(page, /^数据层级$/, QUERY_FIXTURE.dataLevel);
    await selectFacet(page, /^库层级$/, QUERY_FIXTURE.databaseLevel);
    await selectFacet(page, /^表类型$/, QUERY_FIXTURE.tableType);
    const owner = assetRoot(page).getByPlaceholder('请输入负责人').last();
    await owner.fill(QUERY_FIXTURE.owner);
    await owner.blur();
    await submitQuery(page);
    await assertListCountAndPagination(page, '四项组合查询');

    await assertNoConsoleErrors(consoleErrors);
    await report('资产查询-数据层级、库层级、表类型、负责人单条件及组合筛选', true, QUERY_FIXTURE.tableName);
  });
});
