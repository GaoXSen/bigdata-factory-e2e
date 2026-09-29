/**
 * 数据地图 — DM-01-04 查询异常输入与空结果提示（表查询复合搜索框）
 *
 * 2026-09-17 agent-9 静态恢复版。原文件在 2026-09-17 10:20 前后的编辑器故障中被整体
 * 替换为 skip 占位（事件与核查结论见
 * temp/公司模型任务/20260916-闭环/agent8-recover-fragments/README-毁损与恢复记录.md）。
 * 本文件按文件名标题重建“异常输入 + 空结果提示”的真实覆盖，恢复依据：
 * - 提交与三态判定复用在册孪生 DM-01-02《查询关键字为空、超长、特殊字符和无结果》
 *   run-20260917-105532-552 通过轮的 submitTableQuerySearch：非空关键词必须等旧卡片
 *   消失或空态出现才判定；清空后 6 秒内出现的旧空态视为刷新残留；15 秒后旧列表仍
 *   原样残留才定性真实业务缺陷；
 * - 提交受理锚点复用在册孪生 DM-01-04 的 datamap_search/search_table 接口等待；
 * - 探针实证（temp/agent8-探测-表查询搜索.mjs，2026-09-16）：搜索接口对真实不存在的
 *   关键词能正确返回空结果；把“表名/中文名”等中文常用词拼进关键词会被检索分词命中
 *   大量无关表元数据，因此不存在类关键词统一使用双 UUID 高熵字符串；
 * - Excel 用例库 DM-01-02 行（20260914-run110852）异常输入口径：空值、3 空格、
 *   __NOT_FOUND_<UUID>__、256 字符以上超长、包含 <>'"&%_ 的特殊字符；
 *   空值/空白“恢复默认列表或明确空态”，超长/特殊字符“显示明确空结果或合法校验反馈”。
 *
 * 覆盖分工：本文件聚焦表查询页复合搜索框的异常输入与空结果提示；表管理筛选区的同族
 * 异常值覆盖由在册孪生 DM-01-02 承接，四维正向命中由恢复版 DM-01-02 承接，不互换测试目的。
 * 本用例只查询，不新增、修改或删除业务数据。
 */
import { test, expect, uuid, clickMenu, assertNoConsoleErrors } from '../utils.js';
import type { Page } from '@playwright/test';

const TABLE_SEARCH_PLACEHOLDER = '按表名、中文名、描述、负责人搜索';

async function openTableQuery(page: Page): Promise<void> {
  await clickMenu(page, '数据地图', '表查询', '表查询');
  await expect(page.locator('.table-query .search-bar, .table-query .card-list').first())
    .toBeVisible({ timeout: 15_000 });
}

/**
 * 提交表查询复合搜索并等待列表落定；返回最终形态 cards|empty。
 * 空白字符按服务端语义视同清空（去除空白后无关键词），不要求旧列表先消失。
 */
async function submitTableQuerySearch(page: Page, value: string): Promise<'cards' | 'empty'> {
  const search = page.getByPlaceholder(TABLE_SEARCH_PLACEHOLDER).last();
  await search.fill('');
  if (value) await search.pressSequentially(value, { delay: 10 });
  const keyword = value.trim();
  // 以真实搜索接口响应作为“本次提交已被受理”的锚点（孪生 DM-01-04 通过轮做法）；
  // 接口未触发时锚点静默放弃，由下方 UI 三态判定兜底。
  const searchSettled = keyword
    ? page.waitForResponse(
      (response) => response.url().includes('datamap_search/search_table'),
      { timeout: 15_000 },
    ).then(() => undefined).catch(() => undefined)
    : Promise.resolve(undefined);
  await search.press('Enter');
  await searchSettled;
  await search.blur();
  const emptyStates = page.locator(
    '.table-query .ant-empty:visible, .table-query .el-empty:visible, '
      + '.table-query [class*="empty"]:visible, .table-query p:visible',
  ).filter({ hasText: /暂无数据|没有数据|空空如也/ });
  // 记录本次提交时刻：清空提交后的前 6 秒内出现的“暂无数据”大概率是上一次无结果
  // 查询残留的旧空态（列表仍在恢复刷新），不能当作本次清空的最终结果
  // （run-20260916-173034-218 基线失败的根因，孪生 DM-01-02 已修复的口径）。
  const submittedAt = Date.now();
  try {
    await expect.poll(async () => {
      const cards = page.locator('.table-query .card:visible');
      if (!keyword && await cards.count()) return 'cards';
      // 对非空关键词，旧列表必须先消失（或出现空态）才算回车提交完成；
      // 否则会把请求仍在飞行中的旧卡片误判成查询失败。
      if (keyword && !(await cards.count())) return 'empty';
      if (!keyword && Date.now() - submittedAt < 6_000) return 'loading';
      if (await emptyStates.first().isVisible().catch(() => false)) return 'empty';
      return 'loading';
    }, { timeout: 15_000 }).toMatch(/cards|empty/);
  } catch (error) {
    // 只有给足刷新窗口后旧列表仍然原样残留，才定性为真实业务缺陷。
    if (keyword && await page.locator('.table-query .card:visible').count()) {
      throw new Error(
        `真实业务BUG：表查询提交关键词“${value}”15 秒后仍展示与关键词无关的旧列表，未按关键词返回空结果。`,
      );
    }
    throw error;
  }
  return (await page.locator('.table-query .card:visible').count()) ? 'cards' : 'empty';
}

test.describe('DM-01-04｜数据地图｜查询异常输入与空结果提示', () => {
  test.describe.configure({ timeout: 120_000 });

  test('DM-01-04｜数据地图｜查询异常输入与空结果提示（表查询复合搜索框）', async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;
    await openTableQuery(page);
    await expect(page.getByPlaceholder(TABLE_SEARCH_PLACEHOLDER).last()).toBeVisible({ timeout: 15_000 });

    // Excel 用例库 DM-01-02 行（20260914-run110852）的异常输入口径：
    // 空值、3 空格、__NOT_FOUND_<UUID>__、256+ 超长、<>'"&%_ 特殊字符。
    // 空值/空白“恢复默认列表或明确空态”；超长/特殊字符/不存在“显示明确空结果”。
    const cases: Array<{ name: string; value: string; mode: 'restore' | 'empty' }> = [
      { name: '空白字符', value: '   ', mode: 'restore' },
      { name: '不存在关键字', value: `__NOT_FOUND_${uuid()}__`, mode: 'empty' },
      { name: '超长关键字', value: `__NOT_FOUND_${'x'.repeat(256)}__`, mode: 'empty' },
      { name: '特殊字符', value: `__NOT_FOUND_<>'"&%_${uuid()}__`, mode: 'empty' },
      { name: '双UUID高熵不存在', value: `nf_${uuid()}_${uuid()}`, mode: 'empty' },
    ];

    const results: string[] = [];
    for (const item of cases) {
      const state = await submitTableQuerySearch(page, item.value);
      if (item.mode === 'empty') {
        expect(state, `${item.name} 应返回明确空结果`).toBe('empty');
      } else {
        // 空白按服务端语义视同清空：恢复默认列表或给出明确空态均可接受。
        expect(state, `${item.name} 应恢复默认列表或明确空态`).toMatch(/cards|empty/);
      }
      if (item.name === '不存在关键字') {
        // 空结果必须是页面上真实可见的空态文案，不能只有旧列表消失。
        const emptyHint = page.locator(
          '.table-query .ant-empty:visible, .table-query .el-empty:visible, '
            + '.table-query [class*="empty"]:visible, .table-query p:visible',
        ).filter({ hasText: /暂无数据|没有数据|空空如也/ });
        await expect(emptyHint.first(), '空结果应展示明确的空态提示文案').toBeVisible({ timeout: 10_000 });
      }
      results.push(`${item.name}=${state}`);
    }

    // 空值（清空输入）后恢复默认卡片列表（6 秒旧空态宽限见 submitTableQuerySearch）。
    expect(await submitTableQuerySearch(page, ''), '空值清空后应恢复卡片列表').toBe('cards');
    await expect(page.locator('.table-query .card:visible').first(), '清空后默认列表应重新可见')
      .toBeVisible({ timeout: 10_000 });

    await assertNoConsoleErrors(consoleErrors);
    await report(
      '数据地图-表查询-异常输入与空结果提示',
      true,
      `复合搜索框异常输入实测：${results.join('；')}；空值清空恢复=cards；`
        + `空态提示文案已在不存在关键词结果页真实可见。`,
    );
  });
});

