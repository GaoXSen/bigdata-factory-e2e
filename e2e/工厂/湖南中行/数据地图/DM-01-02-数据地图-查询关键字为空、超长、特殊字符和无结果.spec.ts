/**
 * 来源：工厂测试用例标准化业务版 / DM-01-02
 * 类型：异常值/边界
 *
 * 规则：同一页面内连续验证多个查询值；不为每个异常值重复登录或重复打开页面。
 * 本用例只查询，不新增、修改或删除业务数据。
 */
import { test, expect, uuid, clickMenu, assertNoConsoleErrors } from '../utils.js';
import { clickVisible } from '../抽样用例工具.js';
import type { Locator, Page } from '@playwright/test';

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
  await expect(page.locator('.table-query .search-bar, .table-query .card-list').first()).toBeVisible({ timeout: 15_000 });
}

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

  // 当前表管理筛选区为“表名称: + 无 placeholder 的 input”结构，文本标签并未
  // 通过 for/id 关联输入框。仅从标签附近的表单项向上查找，不能退化到整页 input，
  // 否则会误命中隐藏编辑表单或其它筛选条件。
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

async function clearManageQuery(page: Page, fields: Array<{ name: string; control: Locator }>): Promise<void> {
  for (const field of fields) await field.control.fill('');
  await submitManageQuery(page);
  expect(await waitManageState(page, 'rows')).toBe('rows');
}

async function submitTableQuerySearch(page: Page, value: string): Promise<'cards' | 'empty'> {
  const search = page.getByPlaceholder('按表名、中文名、描述、负责人搜索').last();
  await search.fill('');
  if (value) await search.pressSequentially(value, { delay: 10 });
  await search.press('Enter');
  await search.blur();
  const emptyStates = page.locator(
    '.table-query .ant-empty:visible, .table-query .el-empty:visible, ' +
      '.table-query [class*="empty"]:visible, .table-query p:visible',
  ).filter({ hasText: /暂无数据|没有数据|空空如也/ });
  // 记录本次提交时刻：清空提交后的前 6 秒内出现的“暂无数据”大概率是上一次
  // 无结果查询残留的旧空态（列表仍在恢复刷新），不能当作本次清空的最终结果。
  // run-20260916-173034-218 基线失败（清空后应恢复卡片列表，Received "empty"）
  // 正是旧空态被 poll 提前误判所致。
  const submittedAt = Date.now();
  try {
    await expect.poll(async () => {
      const cards = page.locator('.table-query .card:visible');
      if (!value && await cards.count()) return 'cards';
      // 对非空关键词，旧列表必须先消失（或出现空态）才算回车提交完成；
      // 否则会把 press('Enter') 后请求仍在飞行中的旧卡片误判成查询失败。
      if (value && !(await cards.count())) return 'empty';
      // 清空场景：提交后 6 秒内出现的空态视为刷新中的旧空态，继续等待恢复。
      if (!value && Date.now() - submittedAt < 6_000) return 'loading';
      if (await emptyStates.first().isVisible().catch(() => false)) return 'empty';
      return 'loading';
    }, { timeout: 15_000 }).toMatch(/cards|empty/);
  } catch (error) {
    // 只有给足刷新窗口后旧列表仍然原样残留，才定性为真实业务缺陷。
    if (value && await page.locator('.table-query .card:visible').count()) {
      throw new Error(
        `真实业务BUG：表查询提交关键词“${value}”15 秒后仍展示与关键词无关的旧列表，未按关键词返回空结果。`,
      );
    }
    throw error;
  }
  return (await page.locator('.table-query .card:visible').count()) ? 'cards' : 'empty';
}

test('DM-01-02｜数据地图｜查询关键字为空、超长、特殊字符和无结果', async ({ loginPage, consoleErrors, report }) => {
  // 历史 skip（BUG-D01）已解除：原实现把“回车后旧卡片尚未刷新完”误判为
  // 产品缺陷（stale）。submitTableQuerySearch 现在与 DM-01-04 同语义——
  // 非空关键词必须等旧列表消失或出现空态后才判定，超时仍残留旧列表才报
  // 真实业务缺陷，不再对飞行中的查询请求提前定性。
  const page = loginPage;
  await openTableManage(page);
  await expect.poll(() => manageRows(page).count(), { timeout: 10_000 }).toBeGreaterThan(0);

  const definitions = [
    { name: '表名称', pattern: /表名称|表名(?!.*中文)/ },
    { name: '表中文名称', pattern: /表中文名称|表中文名/ },
    { name: '描述', pattern: /^描述$/ },
    { name: '负责人', pattern: /^负责人$/ },
  ];
  const fields: Array<{ name: string; control: Locator }> = [];
  for (const definition of definitions) {
    const control = await findTextControl(page, definition.pattern);
    if (control) fields.push({ name: definition.name, control });
  }
  expect(fields.length, '表管理页面至少应存在一个可输入查询条件').toBeGreaterThan(0);

  const cases = [
    { name: '空值', value: '' },
    { name: '不存在关键字', value: `__NOT_FOUND_${uuid()}__` },
    { name: '超长关键字', value: `__NOT_FOUND_${'x'.repeat(256)}__` },
    { name: '特殊字符', value: `__NOT_FOUND_<>'\"&%_${uuid()}__` },
    { name: '空白字符', value: '   ' },
  ];

  for (const field of fields) {
    for (const item of cases) {
      await field.control.fill(item.value);
      await submitManageQuery(page);
      const state = item.name === '空值' || item.name === '空白字符'
        ? await waitManageState(page)
        : await waitManageState(page, 'empty');
      if (item.name === '空值' || item.name === '空白字符') {
        expect(state, `${field.name}-${item.name} 应恢复列表或明确空态`).toMatch(/rows|empty/);
      } else {
        expect(state, `${field.name}-${item.name} 应返回明确空结果`).toBe('empty');
      }
    }
    await clearManageQuery(page, fields);
  }

  if (fields.length >= 2) {
    const combo = fields.slice(0, Math.min(fields.length, 3));
    for (const [index, field] of combo.entries()) {
      await field.control.fill(`__COMBO_NOT_FOUND_${index}_${uuid()}__`);
    }
    await submitManageQuery(page);
    expect(await waitManageState(page, 'empty'), '多条件组合无匹配时应显示空结果').toBe('empty');
    await clearManageQuery(page, fields);
  }

  // 表查询页的复合搜索框再验证不存在关键词、清空恢复两个环节。
  // 探针实证（temp/agent8-探测-表查询搜索.mjs，2026-09-16）：搜索接口对真实不存在
  // 的关键词能正确返回空结果；但把“表名/中文名”等中文词拼进关键词会被检索分词
  // 命中大量无关表的元数据（原 BUG-D01 的根因是测试关键词构造，不是产品缺陷）。
  // 因此语义标签只用于断言报告，搜索词使用双 UUID 高熵字符串，保证真实不存在。
  await openTableQuery(page);
  await expect(page.getByPlaceholder('按表名、中文名、描述、负责人搜索').last()).toBeVisible({ timeout: 15_000 });
  for (const semantic of ['表名', '中文名', '描述', '负责人']) {
    expect(
      await submitTableQuerySearch(page, `nf_${uuid()}_${uuid()}`),
      `表查询-${semantic}不存在关键字应返回空结果`,
    ).toBe('empty');
  }
  expect(await submitTableQuerySearch(page, ''), '清空表查询条件后应恢复卡片列表').toBe('cards');

  await assertNoConsoleErrors(consoleErrors);
  await report(
    '数据地图-查询条件-各字段异常值与组合查询',
    true,
    `表管理实际发现并验证：${fields.map((field) => field.name).join('、')}；另验证表查询复合搜索框。`,
  );
});
