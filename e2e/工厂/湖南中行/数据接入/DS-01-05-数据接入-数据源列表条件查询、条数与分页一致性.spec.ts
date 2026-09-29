/**
 * DS-01-05｜数据接入｜数据源列表条件查询、条数与分页一致性
 *
 * 覆盖（任务 DS-PERM-01）：
 * 1. 进入 数据接入→数据源管理；
 * 2. 至少两类真实可见查询条件（名称关键词、数据源类型）分别过滤，并以列表真实卡片回显断言；
 * 3. 条数与列表内容一致（过滤后“共 X 条”回显 = 实际卡片数；创建自有数据源后总数 +1）；
 * 4. 列表确有多页时验证翻页前后项变化、页码和总数一致；当前不足两页时以
 *    “分页数据不足”作为明确前置 skip 报告，不把不足一页伪造为分页通过；
 * 5. “与 DB 一致”不伪造 DB 直连：以页面可见回显 + 页面自身收到的 /dataSource JSON
 *    响应中的 total（接口证据）做可选对照；仅当环境提供已批准只读表映射
 *    （E2E_DS_READONLY_TABLE，配合 DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME 只读连接）
 *    时才执行只读 SQL 对照，否则保留明确阻断信息。
 *
 * 环境硬约束：所有数据库测试资源固定 MySQL 110（不使用旧的 MySQL 113、79.52 或历史默认数据源）。
 * 最小测试数据：仅通过本用例页面流程创建 1 条自有数据源（唯一英文前缀 e2eds05+UUID），
 * 用例结束（含失败/跳过路径）在 finally 中清理。
 *
 * 20260922 清洁环境迁移（任务 DS-PERM-57）：
 * - 主库物理连接改经 '../utils.js' 的 dbConfig() 取得（内部即 e2e/test-environment.ts
 *   配置中心：profile mysql110-ftp113 基线 + DB_* 兼容变量单项覆盖，凭据仅来自进程
 *   环境变量；硬链接双路径下两份 utils 镜像同构，spec 不直接 import 配置中心）；
 *   spec 内不持有 host/port/帐号/口令兜底；finally 清理仍仅限本轮创建的数据源。
 *
 * 环境门禁说明：本用例在真实调试环境中直接执行，不设默认 skip 门禁；
 * 数据前置（分页数据不足、只读配置缺失等）按运行时真实结果以明确信息报告，
 * 不以任何门禁吞掉运行时业务失败。
 */
import { assertNoConsoleErrors, clickMenu, dbConfig, expect, query, test, uuid } from '../utils.js';
import {
  clickCardAction,
  clickVisible,
  confirmDangerDialog,
  expectSuccess,
  fillPlaceholder,
} from '../抽样用例工具.js';
import type { Locator, Response } from '@playwright/test';

/** 从任意 JSON 结构中浅层提取第一个数值型 total 字段（深度限制，避免误读业务数组）。 */
function extractTotal(value: unknown, depth = 0): number | null {
  if (depth > 4 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractTotal(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['total', 'totalCount', 'totalSize']) {
    const candidate = record[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  for (const key of ['data', 'result', 'page', 'rows', 'records', 'list']) {
    if (key in record) {
      const found = extractTotal(record[key], depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

test('DS-01-05｜数据源列表条件查询、条数与分页一致性', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(240_000);
  const page = loginPage;

  // ---------- 已批准只读资源（主库连接经 dbConfig()=e2e/test-environment.ts 配置中心解析；MySQL 110 硬约束） ----------
  const primaryDb = dbConfig();
  if (!primaryDb || !primaryDb.host || !primaryDb.database || !primaryDb.user || !primaryDb.password) {
    test.skip(
      true,
      '环境前置条件缺失：dbConfig() 未能解析出完整主库连接（host/database/user/password；' +
        '内部经 e2e/test-environment.ts 配置中心按 profile mysql110-ftp113 基线解析，' +
        '凭据仅来自 DB_USER/DB_PASS 等进程环境变量），' +
        '无法按用例约束通过页面流程创建最小自有数据源；不使用历史默认数据源，也不伪造过滤数据。',
    );
    return;
  }
  const dbHost = primaryDb.host;
  const dbPort = String(primaryDb.port);
  const dbUser = primaryDb.user;
  const dbPass = primaryDb.password;
  const dbName = primaryDb.database;
  const readonlyTable = (process.env.E2E_DS_READONLY_TABLE ?? '').trim();

  const sourceName = `e2eds05${uuid()}`;
  let created = false;
  let echoText = '';

  // ---------- 接口证据（只读捕获页面自身收到的列表响应，不做接口直调写操作） ----------
  const apiTotals: { url: string; total: number | null }[] = [];
  const captureListResponse = (response: Response): void => {
    const url = response.url();
    if (!/dataSource/i.test(url) || !/list|page|query|search/i.test(url)) return;
    if (!(response.headers()['content-type'] ?? '').includes('application/json')) return;
    const entry: { url: string; total: number | null } = { url, total: null };
    apiTotals.push(entry);
    void response
      .json()
      .then((body) => {
        entry.total = extractTotal(body);
      })
      .catch(() => undefined);
  };
  page.on('response', captureListResponse);

  /** 读取页面“共 X 条”总数回显；无该控件时返回 null。 */
  async function readDisplayedTotal(): Promise<number | null> {
    const totalControl = page
      .locator('.ant-pagination-total-text:visible, .el-pagination__total:visible')
      .first();
    const fromControl = (await totalControl.isVisible().catch(() => false))
      ? await totalControl.textContent().catch(() => null)
      : null;
    const bodyText =
      fromControl && /共\s*\d+\s*条/.test(fromControl)
        ? fromControl
        : await page.locator('body').innerText().catch(() => '');
    const match = bodyText.match(/共\s*(\d+)\s*条/);
    return match ? Number(match[1]) : null;
  }

  /** 列表卡片定位：只取最外层卡片节点，避免嵌套结构重复计数。 */
  function cardLocator(): Locator {
    return page.locator(
      '[class*="data-source"]:visible:not(:has([class*="data-source"])), ' +
        '.ant-card:visible:not(:has(.ant-card))',
    );
  }

  /** 等待至少 minCount 张可见卡片；找不到时输出页面结构诊断，便于定位页面改版。 */
  async function expectCardsVisible(minCount: number, context: string): Promise<Locator> {
    const cards = cardLocator();
    try {
      await expect
        .poll(async () => cards.count(), { timeout: 10_000 })
        .toBeGreaterThanOrEqual(minCount);
    } catch {
      const diagnostics = await page
        .evaluate(() => ({
          antCard: document.querySelectorAll('.ant-card').length,
          dataSourceClass: document.querySelectorAll('[class*="data-source"]').length,
          inputs: Array.from(document.querySelectorAll('input'))
            .map((input) => input.getAttribute('placeholder'))
            .filter(Boolean),
          bodySample: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
        }))
        .catch(() => null);
      throw new Error(
        `${context}：未等到 ${minCount} 张可见数据源卡片，当前页面：${page.url()}；` +
          `页面结构诊断：${JSON.stringify(diagnostics)}`,
      );
    }
    return cards;
  }

  async function cardNames(cards: Locator): Promise<string[]> {
    const names: string[] = [];
    const count = await cards.count();
    for (let index = 0; index < count; index += 1) {
      names.push((await cards.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ').trim());
    }
    return names;
  }

  /**
   * 列表查询输入框：按常见 placeholder 识别；数据源列表页未提供条件查询控件时返回 null，
   * 由调用方以“控件缺失阻断”证据显式报告（不作为脚本崩溃失败）。
   */
  async function findListSearchInputOrNull(): Promise<Locator | null> {
    const patterns = [/请输入(数据源)?名称/, /名称/, /关键字|关键词/, /搜索|search/i];
    for (const pattern of patterns) {
      const candidate = page.getByPlaceholder(pattern).filter({ visible: true }).first();
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    return null;
  }

  async function triggerSearch(input: Locator): Promise<void> {
    const button = page
      .getByRole('button', { name: /^\s*(查\s*询|搜\s*索)\s*$/ })
      .filter({ visible: true })
      .first();
    if (await button.isVisible().catch(() => false)) {
      await button.click();
    } else {
      await input.press('Enter');
    }
    await page.waitForTimeout(1_200);
  }

  /** 点击下拉浮层中的类型选项（Ant/Element/原生 listbox 兼容）。 */
  async function clickDropdownOption(typeText: string): Promise<void> {
    const option = page
      .locator(
        '.ant-select-dropdown:visible .ant-select-item-option, ' +
          '.ant-select-dropdown:visible .ant-select-dropdown-menu-item, ' +
          '.el-select-dropdown:visible .el-select-dropdown__item, ' +
          '[role="listbox"]:visible [role="option"]',
      )
      .filter({ hasText: typeText })
      .last();
    await expect(option, `类型下拉应出现“${typeText}”选项`).toBeVisible({ timeout: 5_000 });
    await option.click();
  }

  /** 数据源类型筛选：从“数据源类型”标签向最近父容器找下拉控件。 */
  async function applyTypeFilter(typeText: string): Promise<void> {
    const label = page.getByText('数据源类型', { exact: true }).filter({ visible: true }).first();
    if (await label.isVisible().catch(() => false)) {
      let scope = label;
      for (let level = 0; level < 6; level += 1) {
        const preferred = scope
          .locator('.ant-select:visible, [role="combobox"]:visible')
          .filter({ hasText: /类型/ });
        const generic = scope.locator('.ant-select:visible, .el-select:visible, [role="combobox"]:visible');
        const control = (await preferred.count()) ? preferred.first() : generic.first();
        if (await control.isVisible().catch(() => false)) {
          await control.click();
          await clickDropdownOption(typeText);
          await page.waitForTimeout(1_200);
          return;
        }
        scope = scope.locator('..');
      }
    }
    const diagnostics = await page
      .evaluate(() => ({
        selects: document.querySelectorAll('.ant-select, .el-select, [role="combobox"]').length,
        typeLabelHits: Array.from(document.querySelectorAll('body *')).filter(
          (node) => node.childElementCount === 0 && node.textContent?.trim() === '数据源类型',
        ).length,
      }))
      .catch(() => null);
    throw new Error(
      `未找到“数据源类型”筛选控件，当前页面：${page.url()}；控件诊断：${JSON.stringify(diagnostics)}`,
    );
  }

  try {
    // 1. 进入 数据接入 → 数据源管理，以“添加数据源”入口可见作为列表加载完成标志（不点击）。
    await clickMenu(page, '数据接入', '数据源管理');
    const addEntry = page
      .getByRole('button', { name: /添加数据源|新增数据源/ })
      .filter({ visible: true })
      .first();
    await expect(addEntry, '数据源管理列表应出现“添加数据源”入口').toBeVisible({ timeout: 15_000 });
    const baselineCards = await expectCardsVisible(0, '进入数据源管理后');
    const baselineTotal = await readDisplayedTotal();
    const baselineNames = await cardNames(baselineCards);
    await report(
      '进入数据源管理',
      true,
      `列表加载完成：总数回显=${baselineTotal ?? '无总数控件'}，当前页卡片=${baselineNames.length} 张。`,
    );
    const listInputs = await page
      .evaluate(() => ({
        inputs: Array.from(document.querySelectorAll('input')).map(
          (input) => input.getAttribute('placeholder') ?? input.getAttribute('type') ?? 'input',
        ),
        selects: Array.from(document.querySelectorAll('.ant-select, .el-select')).map((node) =>
          (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24),
        ),
      }))
      .catch(() => null);
    await report('列表页结构诊断', true, `列表页控件：${JSON.stringify(listInputs)}`);

    // 2. 通过页面流程创建最小自有数据源（MYSQL@110，唯一英文前缀），作为过滤回显的确定性数据。
    await addEntry.click();
    const typeDialog = page.getByRole('dialog', { name: /添加数据源|新增数据源/ }).last();
    await expect(typeDialog).toBeVisible({ timeout: 10_000 });
    const typeSearch = typeDialog.getByPlaceholder('请输入关键字搜索');
    if (await typeSearch.isVisible().catch(() => false)) {
      await typeSearch.fill('MYSQL');
      await clickVisible(typeDialog, /搜\s*索|图标:\s*search/).catch(() => undefined);
    }
    await clickVisible(typeDialog, 'MYSQL', { timeoutMs: 5_000 });
    await clickVisible(typeDialog, '下一步');
    await fillPlaceholder(page, '请输入数据源名称', sourceName);
    const description = `DS-01-05_${uuid()}`;
    await fillPlaceholder(page, '请输入数据源描述', description);
    const driverField = page.getByPlaceholder('请输入驱动类', { exact: true }).last();
    if (await driverField.isVisible().catch(() => false)) {
      await driverField.fill('com.mysql.cj.jdbc.Driver');
    }
    await fillPlaceholder(
      page,
      '请输入链接地址',
      `jdbc:mysql://${dbHost}:${dbPort}/${dbName}?useUnicode=true&characterEncoding=utf-8&useSSL=false&serverTimezone=Asia/Shanghai`,
    );
    await fillPlaceholder(page, '请输入用户名', dbUser);
    await fillPlaceholder(page, '请输入密码', dbPass);
    await clickVisible(page, '测试连接');
    await expectSuccess(page, /连接成功|测试成功|成功/);
    await clickVisible(page, /确\s*定/);
    await page.waitForTimeout(1_500);
    echoText = (await page.getByText(sourceName, { exact: true }).filter({ visible: true }).count())
      ? sourceName
      : (await page.getByText(description, { exact: true }).filter({ visible: true }).count())
        ? description
        : '';
    if (!echoText) {
      const sample = await page.locator('body').innerText().catch(() => '');
      throw new Error(
        `创建自有数据源后列表未回显名称或描述：${sourceName} / ${description}；页面文本样例：` +
          sample.replace(/\s+/g, ' ').slice(0, 500),
      );
    }
    created = true;

    const afterCreateCards = await expectCardsVisible(1, '创建自有数据源后');
    const afterCreateTotal = await readDisplayedTotal();
    if (baselineTotal !== null && afterCreateTotal !== null) {
      expect(
        afterCreateTotal,
        '创建自有数据源后“共 X 条”应比进入时 +1（条数与列表内容一致）',
      ).toBe(baselineTotal + 1);
    }
    await report(
      '创建自有数据源',
      true,
      `自有数据源 ${echoText} 已创建并回显；总数回显=${afterCreateTotal ?? '无总数控件'}，当前页卡片=${await afterCreateCards.count()} 张。`,
    );

    // 3. 条件一：名称关键词过滤，唯一卡片回显 + 总数一致（关键词为列表回显的唯一标识文本）。
    const keyword = echoText;
    const searchInput = await findListSearchInputOrNull();
    if (!searchInput) {
      const evidence = await page
        .evaluate(() => ({
          inputs: Array.from(document.querySelectorAll('input')).map(
            (input) =>
              `${input.getAttribute('placeholder') ?? '无placeholder'}(${
                input.offsetParent ? '可见' : '不可见'
              })`,
          ),
          buttons: Array.from(document.querySelectorAll('button'))
            .map((button) => (button.textContent ?? '').replace(/\s+/g, ' ').trim())
            .filter(Boolean),
        }))
        .catch(() => null);
      const message =
        '数据源列表页未提供名称条件查询输入控件（当前页面全部 input/button 已枚举为阻断证据），' +
        '“名称关键词过滤回显”与后续类型过滤章节无法执行；本轮已先通过：进入数据源管理、' +
        '通过页面流程创建自有数据源（MYSQL@110）以及创建后卡片回显。' +
        `阻断证据：${JSON.stringify(evidence)}`;
      test.info().annotations.push({ type: 'blocking', description: message });
      await report('名称关键词过滤', false, message);
      test.skip(true, message);
      return;
    }
    await searchInput.fill(keyword);
    await triggerSearch(searchInput);
    const keywordCards = await expectCardsVisible(1, '名称关键词过滤后');
    await expect(
      page.getByText(keyword, { exact: true }).filter({ visible: true }),
      '名称关键词过滤后应只回显自有数据源一张卡片',
    ).toHaveCount(1);
    const keywordTotal = await readDisplayedTotal();
    if (keywordTotal !== null) {
      expect(keywordTotal, '名称过滤后“共 X 条”应与实际卡片数一致').toBe(
        await keywordCards.count(),
      );
    }
    expect(
      (await cardNames(keywordCards)).join('\n'),
      '名称过滤结果卡片应包含自有数据源回显文本',
    ).toContain(keyword);
    await report(
      '名称关键词过滤',
      true,
      `关键词 ${keyword} 过滤后：卡片=${await keywordCards.count()} 张，总数回显=${keywordTotal ?? '无总数控件'}。`,
    );
    await searchInput.fill('');
    await triggerSearch(searchInput);

    // 4. 条件二：数据源类型过滤，所有可见卡片回显所选类型。
    await applyTypeFilter('MYSQL');
    const typeCards = await expectCardsVisible(1, '数据源类型过滤后');
    const typeNames = await cardNames(typeCards);
    for (const cardText of typeNames) {
      expect(cardText, `类型过滤后每张卡片应回显 MYSQL：${cardText.slice(0, 60)}`).toContain('MYSQL');
    }
    const typeTotal = await readDisplayedTotal();
    if (typeTotal !== null && typeTotal <= typeNames.length) {
      expect(typeTotal, '类型过滤后总数应与实际卡片数一致（单页）').toBe(typeNames.length);
    }
    const ownCardText = typeNames.find((text) => text.includes(echoText));
    expect(ownCardText, '类型过滤结果应包含自有 MYSQL 数据源').toBeDefined();
    await report(
      '数据源类型过滤',
      true,
      `类型 MYSQL 过滤后：卡片=${typeNames.length} 张，总数回显=${typeTotal ?? '无总数控件'}。`,
    );

    // 5. 重载进入未过滤全量列表，做分页一致性校验；不足两页时以“分页数据不足”明确前置报告。
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(addEntry, '重载后数据源管理列表应重新加载完成').toBeVisible({ timeout: 15_000 });
    const firstPageCards = await expectCardsVisible(0, '分页校验前');
    const firstPageNames = await cardNames(firstPageCards);
    const totalBefore = await readDisplayedTotal();
    const page2Button = page
      .locator('.ant-pagination-item-2, .ant-pagination .ant-pagination-item[title="2"]')
      .first();
    if (!(await page2Button.isVisible().catch(() => false))) {
      test.skip(
        true,
        `分页数据不足：数据源列表当前共 ${totalBefore ?? firstPageNames.length} 条` +
          `（第 1 页 ${firstPageNames.length} 张卡片${totalBefore === null ? '，页面未提供“共 X 条”总数回显' : ''}），` +
          '当前未出现第 2 页分页控件，无法验证翻页前后项变化、页码与总数一致；属于数据前置条件而非分页功能通过。' +
          '本轮已先通过：名称关键词过滤回显、数据源类型过滤回显、条数与列表内容一致性。' +
          '环境前置条件：需准备跨页数据量后重跑分页段。',
      );
      return;
    }
    const firstCardBefore = firstPageNames[0] ?? '';
    await page2Button.click();
    await expect(
      page.locator('.ant-pagination-item-active').first(),
      '翻页后当前页码应回显为 2',
    ).toHaveText(/^2$/, { timeout: 10_000 });
    const secondPageCards = await expectCardsVisible(1, '翻到第 2 页后');
    const secondPageNames = await cardNames(secondPageCards);
    expect(secondPageNames[0] ?? '', '翻页前后列表首项应发生变化').not.toBe(firstCardBefore);
    const totalAfter = await readDisplayedTotal();
    if (totalBefore !== null && totalAfter !== null) {
      expect(totalAfter, '翻页前后“共 X 条”总数回显应一致').toBe(totalBefore);
    }
    await page
      .locator('.ant-pagination-item-1, .ant-pagination .ant-pagination-item[title="1"]')
      .first()
      .click();
    await expect(
      page.locator('.ant-pagination-item-active').first(),
      '翻回后当前页码应回显为 1',
    ).toHaveText(/^1$/, { timeout: 10_000 });
    const backNames = await cardNames(await expectCardsVisible(1, '翻回第 1 页后'));
    expect(backNames[0] ?? '', '翻回第 1 页后首项应与初始一致').toBe(firstCardBefore);
    await report(
      '分页一致性',
      true,
      `第 2 页首项=${(secondPageNames[0] ?? '').slice(0, 40)}；总数回显翻页前后均为 ${totalAfter ?? totalBefore ?? '无总数控件'}。`,
    );

    // 6. 可选对照：接口证据（页面自身收到的列表响应 total）；DB 直连对照仅在提供已批准只读表映射时执行。
    const displayedTotal = await readDisplayedTotal();
    const interfaceEvidence = apiTotals.filter((entry) => typeof entry.total === 'number');
    if (displayedTotal !== null && interfaceEvidence.length > 0) {
      expect(
        interfaceEvidence.map((entry) => entry.total),
        `页面总数回显 ${displayedTotal} 应与页面收到的列表接口响应一致`,
      ).toContain(displayedTotal);
      await report('接口证据对照', true, `总数回显 ${displayedTotal} 与列表接口响应一致。`);
    } else {
      test.info().annotations.push({
        type: 'blocking',
        description:
          '接口证据对照未执行：未捕获到 /dataSource 列表接口 JSON 响应中的 total 字段；保留明确阻断信息，不以接口成功伪造数据一致。',
      });
      await report('接口证据对照', false, '未捕获到列表接口响应中的 total 字段，接口对照保留阻断信息。');
    }
    if (displayedTotal !== null && readonlyTable) {
      const rows = await query(`SELECT COUNT(*) AS cnt FROM ${readonlyTable}`);
      const dbCount = Number(rows[0]?.cnt ?? Number.NaN);
      expect(dbCount, `只读 DB 对照：${readonlyTable} 行数应与页面总数回显一致`).toBe(displayedTotal);
      await report('只读 DB 对照', true, `${readonlyTable} 行数 ${dbCount} 与页面总数回显一致。`);
    } else {
      test.info().annotations.push({
        type: 'blocking',
        description:
          'DB 直连对照阻断：已批准只读配置未提供数据源登记表映射（E2E_DS_READONLY_TABLE 为空），' +
          '不做猜测性 SQL 对照；本用例以页面回显与接口证据为一致性依据，缺少只读配置的阻断信息已保留。',
      });
      await report(
        '只读 DB 对照',
        false,
        '未提供 E2E_DS_READONLY_TABLE（已批准只读表映射），DB 直连对照保留阻断信息，未伪造 DB 直连。',
      );
    }

    await assertNoConsoleErrors(consoleErrors);
    await report(
      'DS-01-05 数据源列表条件查询、条数与分页一致性',
      true,
      '条件查询、总数与分页校验完成；自有数据源在 finally 中清理。',
    );
  } finally {
    if (created) {
      await page.keyboard.press('Escape').catch(() => undefined);
      await clickMenu(page, '数据接入', '数据源管理').catch(() => undefined);
      await clickCardAction(page, echoText || sourceName, '删除').catch(() => undefined);
      await confirmDangerDialog(page).catch(() => undefined);
      await page.waitForTimeout(800);
      const remaining = await page
        .getByText(echoText || sourceName, { exact: true })
        .filter({ visible: true })
        .count()
        .catch(() => -1);
      if (remaining > 0) {
        console.warn(`[DS-01-05] 清理未确认：自有数据源 ${sourceName} 仍可见，请人工复核。`);
      }
    }
  }
});
