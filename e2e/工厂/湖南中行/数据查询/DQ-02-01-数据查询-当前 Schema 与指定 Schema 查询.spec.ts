/**
 * 数据查询 — 自助查询 E2E 测试（DQ-02-01）
 *
 * 覆盖场景（参考 Excel「测试用例」Sheet 行48）：
 *   - 不选 Schema：SQL 应在连接默认库（当前 Schema）上下文执行；
 *   - 指定 Schema：选择 Schema 后，SQL 应切换到该 Schema 上下文执行。
 *   （行46/47 数据源展开由 DQ-01 系列覆盖，行49 历史会话/脚本由 DQ-03 系列，
 *    行50 下载由 DQ-04 系列，行51 查询管理由 DQ-05 系列覆盖，本文件不再保留
 *    对应的死代码。）
 *
 * 结果断言规则（页面实际行为优先）：
 *   1. 每轮 SQL 使用 uuid 唯一 marker 作列别名，旧结果、其他面板不可能命中；
 *   2. 用 SELECT DATABASE() AS <marker> 把“SQL 在哪个 Schema 执行”变成查询
 *      结果值：本轮结果表中必须同时出现 marker 列头和期望 Schema 值；
 *   3. 不把 toast、固定等待或历史残留当作成功；SQL 错误提示在轮询中实时捕获。
 *
 * SQL 写入：优先公共 pasteLongText（人工粘贴路径）；仅当执行机剪贴板链全部
 * 失败（run-20260914-110852-805：powershell/clip.exe 均失败，且页面为 http
 * 非安全上下文，navigator.clipboard === undefined）时，本用例内降级
 * page.keyboard.insertText（CDP 一次性插入，不经系统剪贴板、不逐字触发
 * Monaco 自动补全），两条路径写入后都必须完整回读校验整条 SQL。
 *
 * 环境变量：QUERY_SOURCE_TYPE / QUERY_SOURCE_NAME 沿用公共配置；
 * QUERY_ALT_SCHEMA 指定“指定 Schema”场景的库（默认 e2e_test_tables，须与
 * 连接默认库不同，否则证明不了级联切换真实生效）。该默认库在当前 MySQL 110
 * 实例不存在（run-20260922-173713-892，下拉仅 e2e_test/bigdata_data_factory/
 * information_schema/performance_schema/mysql/sys/e2e_commit_check）时，按
 * 下拉真实候选回退到第一个非系统、非连接默认库，并在步骤报告中注明回退；
 * 一个可用候选都没有才按环境前置缺失报错，不伪造、不静默。当前数据源固定为
 * MySQL 语义（DATABASE()）；更换 QUERY_SOURCE_TYPE 时需同步调整上下文函数。
 */

import type { Locator, Page } from '@playwright/test';
import { test, expect, uuid } from '../utils.js';
import {
  assertNoConsoleErrors,
  chooseConfiguredDataSource,
  openSelfServiceQuery,
  pasteLongText,
  settleDropdown,
} from '../utils.js';

const CONFIGURED_SOURCE = {
  type: process.env.QUERY_SOURCE_TYPE?.trim() || 'MYSQL',
  name: process.env.QUERY_SOURCE_NAME?.trim() || '192.168.76.110:13306/e2e_test',
};

/** 指定 Schema 场景使用的库；必须与连接默认库不同，否则无法证明级联切换生效。 */
const ALT_SCHEMA = process.env.QUERY_ALT_SCHEMA?.trim() || 'e2e_test_tables';

/** 系统库不能作为“指定 Schema”目标：切到系统库证明不了业务 Schema 级联切换。 */
const SYSTEM_SCHEMAS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactText(text: string): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`);
}

async function firstVisible(candidates: Locator[], timeout = 0): Promise<Locator | undefined> {
  const deadline = Date.now() + timeout;
  do {
    for (const candidate of candidates) {
      const count = await candidate.count();
      // 结果面板、弹窗和抽屉经常保留同名隐藏节点，倒序优先当前可见实例。
      for (let index = count - 1; index >= 0; index -= 1) {
        const item = candidate.nth(index);
        if (await item.isVisible().catch(() => false)) return item;
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (true);
  return undefined;
}

/**
 * 数据源级联定位失败时，只对已确认的“下拉项不存在”分支标记环境前置缺失；
 * 其它错误继续抛出，避免把真实定位或服务问题伪装成环境阻断。
 */
async function chooseConfiguredDataSourceOrSkip(
  page: Page,
  options: { schema?: string | false },
): Promise<boolean> {
  try {
    await chooseConfiguredDataSource(page, { ...CONFIGURED_SOURCE, schema: options.schema });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingType = message.includes(`下拉选项“${CONFIGURED_SOURCE.type}”未找到`);
    const missingSource = message.includes(`下拉选项“${CONFIGURED_SOURCE.name}”未找到`);
    const missingSchema =
      message.includes('当前数据源没有可选 Schema') ||
      (typeof options.schema === 'string' && message.includes(`下拉选项“${options.schema}”未找到`));
    if (missingType || missingSource || missingSchema) {
      const missing = missingType
        ? `数据源类型 ${CONFIGURED_SOURCE.type}`
        : missingSource
          ? `数据源 ${CONFIGURED_SOURCE.name}`
          : `Schema ${options.schema || '默认 Schema'}`;
      throw new Error(`环境前置条件缺失：未提供 ${missing}，无法完成真实连接/Schema 选择。`);
    }
    throw error;
  }
}

function sqlEditor(page: Page): Locator {
  return page.getByRole('textbox', { name: /Editor content;Press Alt\+F1/ }).last();
}

/** Monaco 展示层会把空格转成 NBSP 并可能折行/追加空白；统一规范化后再比较。 */
function normalizeSqlText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Monaco 的 textarea 是输入桥接，不一定同步 inputValue；视图模型和输入值一起读。 */
async function readEditorText(page: Page): Promise<string> {
  const viewText = await page
    .locator('.monaco-editor:visible .view-lines')
    .last()
    .innerText()
    .catch(() => '');
  const inputValue = await sqlEditor(page).inputValue().catch(() => '');
  return `${viewText}\n${inputValue}`;
}

/**
 * 将本轮 SQL 写入 Monaco 编辑器并完整回读校验（与 DQ-01-02 同路径）。
 *
 * 写入回退链：clipboard（公共 pasteLongText 人工粘贴通道，首选）→
 * keyboard（page.keyboard.insertText，CDP 一次性插入，不经系统剪贴板、不逐字
 * 触发 Monaco 自动补全）→ typed（editor.pressSequentially 逐字键入，靠回读
 * 校验兜底自动补全改写）。
 * run-20260914-110852-805 的真实失败是执行机系统剪贴板不可用（powershell
 * Set-Clipboard、clip.exe 均失败），且被测页面运行在 http 非安全上下文
 * （navigator.clipboard 为 undefined）；run-20260920-093617-273/103941-510
 * 实测新形态：OS 剪贴板“写入成功”但 Ctrl+V 后 Monaco 回读为空（云桌面/DLP
 * 允许写剪贴板、拦截粘贴读取），旧版“仅当 pasteLongText 抛错才降级”覆盖
 * 不了该场景，因此改为按“回读结果”降级。每次尝试前清空编辑器并轮询确认
 * 为空，防止多次尝试内容叠加造成 includes 误判；无论哪条路径，写入后都
 * 必须完整回读并包含整条 SQL，防止自动补全或粘贴截断改写语句后被静默执行。
 * 三层全部失败才抛错，错误信息带各层的实际回读内容。
 */
async function writeSqlToEditor(page: Page, sql: string): Promise<'clipboard' | 'keyboard' | 'typed'> {
  const editor = sqlEditor(page);
  await expect(editor).toBeVisible({ timeout: 10_000 });
  // 前一步下拉选择可能残留浮层，先收起再聚焦编辑器。
  await page.keyboard.press('Escape').catch(() => undefined);

  /** 每次写入尝试前清空编辑器并轮询确认为空，避免多次尝试内容叠加。 */
  async function clearEditor(): Promise<void> {
    await editor.click({ force: true });
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await expect
      .poll(async () => normalizeSqlText(await readEditorText(page)), { timeout: 3_000 })
      .toBe('');
  }

  const attempts: Array<{ mode: 'clipboard' | 'keyboard' | 'typed'; write: () => Promise<void> }> = [
    {
      mode: 'clipboard',
      write: async () => {
        await pasteLongText(page, editor, sql);
      },
    },
    {
      mode: 'keyboard',
      write: async () => {
        await page.keyboard.insertText(sql);
      },
    },
    {
      mode: 'typed',
      write: async () => {
        await editor.pressSequentially(sql, { delay: 5 });
      },
    },
  ];

  const expected = normalizeSqlText(sql);
  const failures: string[] = [];
  for (const attempt of attempts) {
    await clearEditor();
    try {
      await attempt.write();
    } catch (error) {
      failures.push(`【${attempt.mode}】写入抛错：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    let actual = '';
    try {
      // 给 Monaco 渲染/粘贴事件传播一点时间，回读通过即本层成功。
      await expect
        .poll(async () => {
          actual = normalizeSqlText(await readEditorText(page));
          return actual.includes(expected);
        }, { timeout: 3_000 })
        .toBe(true);
      return attempt.mode;
    } catch {
      failures.push(`【${attempt.mode}】回读不一致：期望包含“${expected}”，实际为“${actual.slice(0, 300)}”`);
    }
  }
  throw new Error(`SQL 写入编辑器失败（已依次尝试 clipboard→keyboard→typed）：${failures.join('；')}。`);
}

/** 点击自助查询的执行按钮（与公共 executeSql 相同定位：三角图标优先）。 */
async function runSql(page: Page): Promise<void> {
  const iconButton = page.locator('[aria-label="图标: caret-right"]:visible').first();
  const textButton = page.getByRole('button', { name: /^\s*执\s*行\s*$/ }).first();
  const executeButton = (await iconButton.count()) ? iconButton : textButton;
  await expect(executeButton).toBeVisible({ timeout: 10_000 });
  await executeButton.click();
}

/**
 * 等待本轮 SQL 的结果表，并断言“SQL 在期望 Schema 上下文执行”。
 *
 * marker 是本轮唯一的列别名，只有本轮结果表会包含它（uuid 后缀不会与旧
 * 结果、其他面板撞名）；期望 Schema 值必须出现在同一张结果表的数据区，
 * 证明 SELECT DATABASE() 的真实返回值与期望上下文一致。
 *
 * 结果表布局事实（run-20260915-103645-983 trace queryCount 证据）：结果区为
 * “固定表头”布局——列头所在 table 的直接父级只装表头（其内查不到任何数据
 * 文本），表体 table 在另一层包裹里，共同容器比直接父级更高；按“单个
 * table（或其直接父级）内同时找列头和值”断言会永远落空（查询秒级出结果，
 * 仍轮询超时）。因此定位顺序改为：先找本轮 marker 列头（role 命名精确
 * 匹配优先；getByText 兜底时注意 Monaco 编辑器里 SQL 别名 token 也满足
 * 精确文本、且不在任何 table 内，靠“取其 table 祖先”自然过滤），再从列头
 * 所在 table 向上取“同时存在文本恰为期望 Schema 的后代元素”的最近祖先，
 * 作为“这一张结果表”的判定范围——该 XPath 直接表达“列头与值同属本轮
 * 结果表”的语义，不依赖包裹层层数；marker 列头与期望 Schema 值必须同时
 * 落在该范围内才算本轮真实结果。SQL 错误提示几秒即逝，轮询中同步捕获；
 * 超时如实报错，不以 toast 或固定等待当作成功。
 */
async function waitForContextResult(
  page: Page,
  marker: string,
  expectedSchema: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 本轮 marker 列头：role 命名精确匹配优先，可见精确文本兜底。
    const markerHeader = await firstVisible([
      page.getByRole('columnheader', { name: exactText(marker) }),
      page.getByText(marker, { exact: true }).filter({ visible: true }),
    ]);
    if (markerHeader) {
      // 判定范围：列头所在 table 的“含期望值后代的最近祖先”（表头/表体
      // 包裹层的最小公共容器）；退路依次为直接父级、列头所在 table 本身。
      const headerTable = markerHeader.locator('xpath=ancestor::table[1]');
      const resultScope = await firstVisible([
        headerTable.locator(
          `xpath=ancestor::*[descendant::*[normalize-space(.)='${expectedSchema}']][1]`,
        ),
        headerTable.locator('xpath=..'),
        headerTable,
      ]);
      const valueCell = resultScope
        ? await firstVisible([resultScope.getByText(exactText(expectedSchema))])
        : undefined;
      if (resultScope && valueCell) return;
    }

    // 错误 toast 必须命中 SQL 语义文案才算 SQL 失败：run-20260922-172709-896 中
    // 运行历史面板自身的接口报错 toast“查询运行历史异常！”曾被全量
    // .ant-message-error 匹配误判为 SQL 失败；SQL 失败文案均含 SQL/执行失败/
    // 查询失败/syntax 等语义词，不命中则继续轮询，超时如实报错。
    const sqlErrorText =
      /SQL|syntax|执行失败|执行异常|查询失败|数据库连接|连接失败|Streaming result set|still active/i;
    const sqlError = await firstVisible(
      [
        page
          .locator('.ant-message-error:visible, .el-message--error:visible, .ant-notification-notice-error:visible')
          .filter({ hasText: sqlErrorText }),
        page
          .getByText(/SQL解析失败|SQL执行失败|syntax error|查询失败|服务异常|Streaming result set|still active/i)
          .filter({ visible: true }),
      ],
      100,
    );
    if (sqlError) {
      const message = (await sqlError.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      throw new Error(`执行 SQL 后页面报错：${message || '未知 SQL 错误'}`);
    }
    await page.waitForTimeout(300);
  }
  throw new Error(
    `本轮查询结果（marker=${marker}，期望上下文=${expectedSchema}）在 ${timeoutMs / 1000} 秒内未返回。`,
  );
}

/**
 * MySQL 查询结果以流式结果集保留在连接上；不关闭当前“结果 N”页签就执行
 * 下一条 SQL，后端会返回 “Streaming result set is still active”。
 */
async function closeCurrentQueryResult(page: Page): Promise<void> {
  const resultTabs = page.getByRole('tab').filter({ hasText: /^\s*结果\s*\d+/ });
  let selectedTab: Locator | undefined;
  for (let index = await resultTabs.count() - 1; index >= 0; index -= 1) {
    const candidate = resultTabs.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    if ((await candidate.getAttribute('aria-selected')) === 'true') {
      selectedTab = candidate;
      break;
    }
  }
  selectedTab ??= await firstVisible([resultTabs.last()], 2_000);
  if (!selectedTab) throw new Error('当前“结果 N”页签未找到，无法释放流式结果集后再执行下一条 SQL。');

  const close = selectedTab
    .locator('[aria-label="图标: close"], [aria-label="icon: close"], .anticon-close')
    .first();
  await expect(close).toBeVisible({ timeout: 5_000 });
  await close.click({ force: true });
  await page.waitForTimeout(500);
}

/** Schema 下拉：数据源选定后出现在编辑器工具栏，未选择时占位文本“选择Schema”。 */
async function schemaCombobox(page: Page): Promise<Locator> {
  const box = await firstVisible(
    [
      page.locator('[role="combobox"]:visible').filter({ hasText: /选择\s*Schema/i }),
      page.getByText(/选择\s*Schema/).filter({ visible: true }),
    ],
    10_000,
  );
  if (!box) throw new Error(`Schema 选择下拉框未找到，当前页面：${page.url()}`);
  return box;
}

/** 在 Schema 下拉中选择指定库，并断言选中值真实回显到控件。 */
async function selectSchemaInCombobox(page: Page, schema: string): Promise<void> {
  const box = await schemaCombobox(page);
  await box.click({ force: true });
  const option = await firstVisible(
    [
      page.getByRole('option', { name: exactText(schema) }),
      page.locator('[role="listbox"]:visible [role="option"]').filter({ hasText: exactText(schema) }),
      page
        .locator(
          [
            '.ant-select-dropdown:visible .ant-select-item-option',
            '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
            '.el-select-dropdown:visible .el-select-dropdown__item',
            '.el-select-dropdown:visible .el-select-dropdown-menu__item',
          ].join(', '),
        )
        .filter({ hasText: exactText(schema) }),
      page.getByText(schema, { exact: true }).filter({ visible: true }),
    ],
    10_000,
  );
  if (!option) {
    await page.keyboard.press('Escape').catch(() => undefined);
    throw new Error(`环境前置条件缺失：Schema 下拉中没有选项“${schema}”，无法完成指定 Schema 查询。`);
  }
  await option.click();
  await settleDropdown(page);

  // 选中后占位符消失，按结构重新定位控件再校验回显，不依赖点击前的旧句柄。
  await expect.poll(async () => {
    const current = await firstVisible(
      [page.locator('[role="combobox"]:visible').last(), page.locator('.ant-select:visible').last()],
      1_000,
    );
    return current ? (await current.innerText().catch(() => '')).replace(/\s+/g, ' ').trim() : '';
  }, { timeout: 5_000 }).toContain(schema);
}

/**
 * 读取“已展开”的 Schema 下拉中全部可见选项文本（调用前先点击展开）。
 * run-20260922-173713-892：MySQL 110 实例没有 e2e_test_tables 库，“指定 Schema”
 * 需要按下拉真实候选判断环境前置并回退；与 selectSchemaInCombobox 使用同一批
 * 定位族，避免两套定位对同一下拉产生不同认知。
 */
async function readOpenSchemaOptions(page: Page, timeoutMs = 5_000): Promise<string[]> {
  const groups = [
    page.locator('.ant-select-dropdown:visible .ant-select-item-option'),
    page.locator('.ant-select-dropdown:visible .ant-select-dropdown-menu-item'),
    page.locator('[role="listbox"]:visible [role="option"]'),
    page.locator('.el-select-dropdown:visible .el-select-dropdown__item'),
  ];
  const deadline = Date.now() + timeoutMs;
  do {
    for (const group of groups) {
      const count = await group.count();
      const texts: string[] = [];
      for (let index = 0; index < count; index += 1) {
        texts.push((await group.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ').trim());
      }
      if (texts.some(Boolean)) return texts.filter(Boolean);
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(200);
  } while (true);
  return [];
}

/**
 * 读取底部数据源栏的连接展示文本（形如 `MYSQL / 192.168.76.110:13306/e2e_test`），
 * 提取连接默认库，作为“不选 Schema 时 SQL 应落到的当前 Schema”期望值。
 * 文本里没有库名（或只剩 host:port）时说明连接未带默认库，当前 Schema 场景
 * 无从断言，按环境前置缺失处理。
 */
async function readConnectionDefaultSchema(page: Page): Promise<string> {
  const sourcePattern = new RegExp(
    `${escapeRegExp(CONFIGURED_SOURCE.type)}\\s*/\\s*${escapeRegExp(CONFIGURED_SOURCE.name)}`,
    'i',
  );
  const label = await firstVisible(
    [
      page.locator('.datasource-select:visible').filter({ hasText: sourcePattern }),
      page.getByText(sourcePattern).filter({ visible: true }),
    ],
    10_000,
  );
  if (!label) throw new Error(`底部数据源连接信息未找到，当前页面：${page.url()}`);
  const text = (await label.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const match = text.match(/\/\s*([^/\s]+)\s*$/);
  if (!match || match[1].includes(':')) {
    throw new Error(
      `环境前置条件缺失：数据源连接未展示默认库（连接文本“${text}”），无法断言不选 Schema 查询的当前上下文。`,
    );
  }
  return match[1];
}

test.describe("DQ-02-01｜数据查询｜当前 Schema 与指定 Schema 查询", () => {
  test.beforeEach(async ({ loginPage }) => {
    await openSelfServiceQuery(loginPage);
  });

  test("DQ-02-01｜数据查询｜当前 Schema 与指定 Schema 查询", async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;
    // 两轮“级联定位 → 写入 SQL → 执行 → 结果上下文断言”完整流程；
    // 登录 fixture 已保底 120s，这里覆盖数据源加载与两次查询的整体预算。
    test.setTimeout(180_000);

    // —— 数据源级联定位：数据源类型 → 数据源；本步骤保持不选 Schema ——
    if (!(await chooseConfiguredDataSourceOrSkip(page, { schema: false }))) return;
    await settleDropdown(page);

    // —— 场景 1：不选 Schema，SQL 应在连接默认库（当前 Schema）上下文执行 ——
    const box = await schemaCombobox(page);
    const boxText = (await box.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!/选择\s*Schema/.test(boxText)) {
      throw new Error(`Schema 下拉已存在选中值“${boxText}”，“不选 Schema 的当前库查询”前置不成立。`);
    }
    const defaultSchema = await readConnectionDefaultSchema(page);

    const currentMarker = `e2e_cur_${uuid()}`;
    const writeMode1 = await writeSqlToEditor(page, `SELECT DATABASE() AS ${currentMarker}`);
    await runSql(page);
    await waitForContextResult(page, currentMarker, defaultSchema);
    await report(
      '自助查询-不选Schema查询当前连接库',
      true,
      `连接默认库=${defaultSchema}；marker=${currentMarker}；SQL 写入方式=${writeMode1}`,
    );

    // —— 场景 2：指定 Schema，SQL 应切换到该 Schema 上下文执行 ——
    // 先展开下拉读取真实候选：配置库在该实例不存在时（run-20260922-173713-892：
    // MySQL 110 无 e2e_test_tables）回退到第一个非系统、非连接默认库，并在
    // 步骤报告中注明回退；一个可用候选都没有才按环境前置缺失报错。
    const schemaBox = await schemaCombobox(page);
    await schemaBox.click({ force: true });
    const availableSchemas = await readOpenSchemaOptions(page);
    await page.keyboard.press('Escape').catch(() => undefined);
    let targetSchema = ALT_SCHEMA;
    let schemaFallbackNote = '';
    if (!availableSchemas.includes(ALT_SCHEMA)) {
      const fallback = availableSchemas.find(
        (item) => item !== defaultSchema && !SYSTEM_SCHEMAS.has(item.toLowerCase()),
      );
      if (!fallback) {
        throw new Error(
          `环境前置条件缺失：Schema 下拉候选（${availableSchemas.join('、') || '空'}）中既无“${ALT_SCHEMA}”，也没有其他非系统库可回退，无法完成指定 Schema 查询。`,
        );
      }
      targetSchema = fallback;
      schemaFallbackNote = `（配置的 ${ALT_SCHEMA} 不在该实例，已回退）`;
    }
    if (targetSchema === defaultSchema) {
      throw new Error(
        `环境前置条件缺失：指定 Schema（${targetSchema}）与连接默认库相同，无法证明 Schema 级联切换真实生效；请通过 QUERY_ALT_SCHEMA 提供不同的库。`,
      );
    }
    // 先释放上一条 SQL 的流式结果集，否则第二条 SQL 会被后端以
    // “Streaming result set is still active” 拒绝。
    await closeCurrentQueryResult(page);
    await selectSchemaInCombobox(page, targetSchema);

    const schemaMarker = `e2e_schema_${uuid()}`;
    const writeMode2 = await writeSqlToEditor(page, `SELECT DATABASE() AS ${schemaMarker}`);
    await runSql(page);
    await waitForContextResult(page, schemaMarker, targetSchema);
    await report(
      '自助查询-指定Schema查询',
      true,
      `指定 Schema=${targetSchema}${schemaFallbackNote}；marker=${schemaMarker}；SQL 写入方式=${writeMode2}`,
    );

    await assertNoConsoleErrors(consoleErrors);
  });
});
