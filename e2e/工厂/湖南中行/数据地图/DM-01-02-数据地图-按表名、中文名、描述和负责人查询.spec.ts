/**
 * 数据地图 — DM-01-02 按表名、中文名、描述和负责人查询（命中与清空回归）
 *
 * 2026-09-17 agent-9 静态恢复版。原文件在 2026-09-17 10:20 前后的编辑器故障中被整体
 * 替换为 skip 占位（事件与核查结论见
 * temp/公司模型任务/20260916-闭环/agent8-recover-fragments/README-毁损与恢复记录.md）。
 * 本文件按文件名标题重建“表名/中文名/描述/负责人四维正向命中 + 清空恢复回归”的真实覆盖，
 * 恢复依据（全部来自当前在册实现与页面实况，不凭空编造）：
 * - 查询夹具：DM-00-01 负责初始化并上线的 e2e_dm_query_fixture_v2（数据地图查询夹具.ts），
 *   表名/中文名/描述/负责人四维元数据在建表时一次性写入；
 * - 表管理筛选区：输入框定位、“查询”提交与 rows/empty 三态等待复用在册孪生
 *   DM-01-02《查询关键字为空、超长、特殊字符和无结果》run-20260917-105532-552 通过轮
 *   实现；本文件补齐该孪生未覆盖的“各筛选字段按夹具元数据正向命中”侧面；
 * - 表查询复合搜索框：提交锚点与翻页命中判定复用在册孪生 DM-01-04《表查询命中与不存在
 *   关键词为空》的 submitCardSearch（datamap_search/search_table 接口锚点 +
 *   findCardOnCurrentOrNextPage 翻页查找）；
 * - 负责人搜索未命中是已确认真实产品缺陷 BUG-D02（问题优化与解决方法.md 第 66/447 条），
 *   沿用孪生用例的显式定性口径：保留真实断言，未命中时抛出带证据的产品缺陷错误，
 *   不以放宽断言换取通过。
 *
 * 本用例只查询，不新增、修改或删除业务数据。
 */
import { test, expect, clickMenu, assertNoConsoleErrors } from '../utils.js';
import { QUERY_FIXTURE } from './数据地图查询夹具.js';
import type { Locator, Page } from '@playwright/test';

const TABLE_SEARCH_PLACEHOLDER = '按表名、中文名、描述、负责人搜索';
const MAIN_CARD_SELECTOR = '.table-query .card:visible';

const manageRows = (page: Page) => page.locator([
  'tbody > tr:visible',
  '.ant-table-tbody > tr:visible',
  '.el-table__body-wrapper tr:visible',
  '[role="row"]:visible:not(:has([role="columnheader"]))',
].join(', '));

const manageEmpty = (page: Page) => page.locator(
  '.ant-empty:visible, .el-empty:visible, [class*="empty"]:visible',
).filter({ hasText: /暂无数据|没有数据|空空如也/ });

async function openTableManage(page: Page): Promise<void> {
  await clickMenu(page, '数据地图', '表管理', '表管理');
  await expect(page.locator('body')).toBeVisible();
}

async function openTableQuery(page: Page): Promise<void> {
  await clickMenu(page, '数据地图', '表查询', '表查询');
  await expect(page.locator('.table-query .search-bar, .table-query .card-list').first())
    .toBeVisible({ timeout: 15_000 });
}

/**
 * 孪生 DM-01-02 通过轮的筛选输入框定位：label 关联 → placeholder → 标签就近表单项。
 * 表管理筛选区是“表名称: + 无 placeholder 的 input”结构，不能退化到整页 input。
 */
async function findTextControl(page: Page, label: RegExp): Promise<Locator | undefined> {
  const associated = page.getByLabel(label);
  for (let index = await associated.count() - 1; index >= 0; index -= 1) {
    const candidate = associated.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const tag = await candidate.evaluate((element) => element.tagName.toLowerCase()).catch(() => '');
    if (tag === 'input' || tag === 'textarea') return candidate;
    const nested = candidate.locator('input:visible, textarea:visible').last();
    if (await nested.isVisible().catch(() => false)) return nested;
  }

  const byPlaceholder = page.getByPlaceholder(label);
  for (let index = await byPlaceholder.count() - 1; index >= 0; index -= 1) {
    const candidate = byPlaceholder.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }

  const labels = page.getByText(label).filter({ visible: true });
  for (let labelIndex = await labels.count() - 1; labelIndex >= 0; labelIndex -= 1) {
    let scope = labels.nth(labelIndex);
    for (let level = 0; level < 4; level += 1) {
      const nested = scope.locator('input:visible, textarea:visible');
      for (let inputIndex = await nested.count() - 1; inputIndex >= 0; inputIndex -= 1) {
        const control = nested.nth(inputIndex);
        if (await control.isVisible().catch(() => false)) return control;
      }
      scope = scope.locator('..');
    }
  }
  return undefined;
}

async function submitManageQuery(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: /查\s*询/ }).last();
  await expect(button).toBeVisible({ timeout: 10_000 });
  await button.click();
  await page.waitForTimeout(350);
}

async function waitManageState(page: Page, expected?: 'rows' | 'empty'): Promise<'rows' | 'empty'> {
  await expect.poll(async () => {
    if (expected !== 'empty' && await manageRows(page).count()) return 'rows';
    if (expected !== 'rows' && await manageEmpty(page).count()) return 'empty';
    const body = await page.locator('body').innerText().catch(() => '');
    if (expected !== 'rows' && /暂无数据|没有数据|空空如也/.test(body)) return 'empty';
    return 'loading';
  }, { timeout: 10_000 }).toMatch(/rows|empty/);
  if (expected === 'empty') return 'empty';
  if (expected === 'rows') return 'rows';
  return (await manageRows(page).count()) ? 'rows' : 'empty';
}

/** 筛选结果必须真实包含夹具表行，证明“按该维度查询确实命中”。 */
async function expectFixtureRowVisible(page: Page, reason: string): Promise<void> {
  await expect(
    manageRows(page).filter({ hasText: QUERY_FIXTURE.tableName }).first(),
    reason,
  ).toBeVisible({ timeout: 10_000 });
}

/** 清空全部筛选并恢复默认列表（孪生 DM-01-02 通过轮口径）。 */
async function clearManageQuery(page: Page, fields: Array<{ name: string; control: Locator }>): Promise<void> {
  for (const field of fields) await field.control.fill('');
  await submitManageQuery(page);
  expect(await waitManageState(page, 'rows')).toBe('rows');
}

/**
 * 表查询复合搜索框提交（孪生 DM-01-04 的接口受理锚点口径）：
 * 以真实搜索接口响应确认本次提交已被受理，再等卡片/空态落定。
 */
async function submitCardSearchAndWait(page: Page, keyword: string): Promise<'cards' | 'empty'> {
  const search = page.getByPlaceholder(TABLE_SEARCH_PLACEHOLDER).last();
  await expect(search).toBeVisible({ timeout: 15_000 });
  await search.fill('');
  if (keyword) await search.pressSequentially(keyword, { delay: 10 });
  const settled = keyword
    ? page.waitForResponse(
      (response) => response.url().includes('datamap_search/search_table'),
      { timeout: 15_000 },
    ).then(() => undefined).catch(() => undefined)
    : Promise.resolve(undefined);
  await search.press('Enter');
  await settled;
  await search.blur();
  await expect.poll(async () => {
    if (await page.locator(MAIN_CARD_SELECTOR).count()) return 'cards';
    const empty = page.locator('.table-query .ant-empty:visible, .table-query .el-empty:visible').first();
    return (await empty.isVisible().catch(() => false)) ? 'empty' : 'loading';
  }, { timeout: 15_000 }).toMatch(/cards|empty/);
  return (await page.locator(MAIN_CARD_SELECTOR).count()) ? 'cards' : 'empty';
}

/**
 * 翻页命中判定（孪生 DM-01-04 findCardOnCurrentOrNextPage 口径）：当前页卡片
 * 元数据不含目标表且“下一页”仍可用时继续翻页查找；夹具表名高熵唯一，通常首页即命中。
 */
async function findCardOnCurrentOrNextPage(page: Page, keyword: string): Promise<boolean> {
  for (let pageNumber = 1; pageNumber <= 5; pageNumber += 1) {
    const cards = page.locator(MAIN_CARD_SELECTOR);
    for (let index = 0; index < await cards.count(); index += 1) {
      const metadata = await cards.nth(index).innerText().catch(() => '');
      if (metadata.includes(keyword)) return true;
    }
    const next = page.locator(
      '.ant-pagination-next:not([disabled]), .el-pagination .btn-next:not([disabled]), [aria-label="next page"]',
    ).last();
    if (!(await next.isVisible().catch(() => false))) return false;
    await next.click();
    await page.waitForTimeout(600);
  }
  return false;
}

test.describe('DM-01-02｜数据地图｜按表名、中文名、描述和负责人查询', () => {
  test.describe.configure({ timeout: 120_000 });

  test('DM-01-02｜数据地图｜按表名、中文名、描述和负责人查询（命中与清空回归）', async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;
    await openTableManage(page);
    await expect.poll(() => manageRows(page).count(), { timeout: 10_000 }).toBeGreaterThan(0);

    // 筛选控件动态发现（孪生 DM-01-02 口径）：页面结构不同时按实际存在的字段验证。
    const dimensions = [
      { name: '表名称', pattern: /表名称|表名(?!.*中文)/, value: QUERY_FIXTURE.tableName },
      { name: '表中文名称', pattern: /表中文名称|表中文名/, value: QUERY_FIXTURE.chineseName },
      { name: '描述', pattern: /^描述$/, value: QUERY_FIXTURE.description },
      { name: '负责人', pattern: /^负责人$/, value: QUERY_FIXTURE.owner },
    ];
    const fields: Array<{ name: string; value: string; control: Locator }> = [];
    for (const dimension of dimensions) {
      const control = await findTextControl(page, dimension.pattern);
      if (control) fields.push({ name: dimension.name, value: dimension.value, control });
    }
    expect(fields.length, '表管理页面至少应存在一个可输入查询条件').toBeGreaterThan(0);

    const verified: string[] = [];
    for (const field of fields) {
      await field.control.fill(field.value);
      await submitManageQuery(page);
      const state = await waitManageState(page);
      if (state !== 'rows') {
        // 已确认真实产品缺陷 BUG-D02（问题优化与解决方法.md 447 条）：表查询全局搜索
        // 输入负责人返回“暂无数据”，同一夹具表按表名/中文名/描述均可命中。
        // 表管理负责人筛选同样未命中时按同族缺陷显式定性，不以放宽断言换取通过。
        if (field.name === '负责人') {
          throw new Error(
            `真实产品BUG（疑似 BUG-D02 同族）：表管理按负责人“${field.value}”筛选未命中夹具表 `
              + `${QUERY_FIXTURE.tableName}（结果=${state}）。BUG-D02 已确认表查询全局搜索负责人不命中；`
              + `此前已实测命中的维度：${verified.join('、') || '无'}。`,
          );
        }
        expect(state, `${field.name} 筛选应命中夹具表 ${QUERY_FIXTURE.tableName}`).toBe('rows');
      }
      await expectFixtureRowVisible(page, `${field.name}=${field.value} 筛选结果必须包含夹具表行`);
      verified.push(field.name);
      // 清空回归：命中后清空全部筛选，恢复默认列表。
      await clearManageQuery(page, fields);
    }

    // 表查询复合搜索框：按夹具表名正向命中（接口受理锚点 + 翻页兜底）。
    // 四维全局搜索与 BUG-D02 定性由在册孪生 DM-01-04 承接，此处不重复覆盖。
    await openTableQuery(page);
    expect(
      await submitCardSearchAndWait(page, QUERY_FIXTURE.tableName),
      '复合搜索框按夹具表名应命中卡片',
    ).toBe('cards');
    expect(
      await findCardOnCurrentOrNextPage(page, QUERY_FIXTURE.tableName),
      `复合搜索结果应包含夹具表 ${QUERY_FIXTURE.tableName}`,
    ).toBeTruthy();

    await assertNoConsoleErrors(consoleErrors);
    await report(
      '数据地图-按表名、中文名、描述和负责人查询',
      true,
      `表管理实测维度：${verified.join('、')}（逐维命中夹具表 ${QUERY_FIXTURE.tableName} 并清空恢复）；`
        + `表查询复合搜索框按表名正向命中（含翻页兜底判定）。`,
    );
  });
});

