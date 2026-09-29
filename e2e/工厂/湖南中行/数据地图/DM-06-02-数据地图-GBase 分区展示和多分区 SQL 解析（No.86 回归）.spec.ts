/**
 * 数据地图 — DM-06-02 GBase 分区展示和多分区 SQL 解析（No.86 回归）
 *
 * 用例来源：用例库 Excel No.86（分区）——新建 GBase 表，使用含两个 RANGE 分区的
 * DDL 经“语句添加 + 解析”提交，随后在表查询明细页核对分区信息展示。
 *
 * 历史失败（run-20260914-110852-805，且本用例此前从未通过）：
 * - 提交完整 CREATE TABLE + PARTITION BY RANGE（两个分区）后点击“解析”，
 *   字段表始终为空，页面切回“可视化添加”，10 秒轮询超时；
 * - 旧实现只断言“解析成功”文本、未覆盖分区展示，失败时缺少接口/提示证据。
 *
 * 页面事实（同页面族已验证用例：DM-03-02 run-20260915-120226-818、DM-02-01、
 * BL-04-00/血缘测试工具）：
 * - “新建表”是 split-button：点击后在数据源下拉中选择目标库；GBase 源显示名取
 *   配置中心 dataSourceNames.gbaseSourceName（兼容环境变量 GBASE_SOURCE_NAME 覆盖）；
 * - “语句添加 + 解析”对列定义 CREATE TABLE 有效，成功信号是字段表异步出现行；
 * - 表单必填：数据层级/库层级/负责人/数据生命周期/操作类型 + “执行前需要确定=否”；
 * - “建 表”提交成功后离开 tableCreate 表单回到 tablesManage 列表；
 * - 新建表默认下线态，须“上线”后才出现在表查询。
 *
 * 策略：仅操作本轮自建 GBase UUID 表（不触碰既有业务表）；多分区解析失败时收集
 * 解析相关接口响应与页面提示后抛出（作为 No.86 回归失败证据），不吞异常、不伪造通过。
 * 本轮自建表按同族用例（DM-03-02）约定留在测试源中，用 UUID 隔离，不做删除。
 *
 * 2026-09-16 定性（接口对照实验，证据：temp/公司模型任务/20260916-闭环/
 * agent8-gbase-sqlprobe-result.json，探针 agent8-gbase-sqlprobe.mjs）：
 * - POST /tableManage/sqlToFields 对无分区 DDL（id VARCHAR(64) / id INTEGER, dt DATE）
 *   返回 000000 并解析出字段；对带 PARTITION BY RANGE/LIST/HASH/DISTRIBUTED 的
 *   任何写法（单分区/双分区/MAXVALUE/RANGE COLUMNS/无空格/分号结尾）一律返回
 *   099999“sql解析异常:TODO/not supported ... token ...”，且与 dataBaseTypeEnum
 *   方言无关（MYSQL/GAUSSDBM 同样失败）——分区子句被后端解析器无条件拒绝，
 *   不存在“换个写法就能通过”的多分区 DDL。
 * - 该接口返回的字段对象自带 isPartition 属性，说明产品数据模型支持分区概念，
 *   缺的是 DDL 解析能力；页面点击“解析”后无任何可见错误提示、字段区 0 行。
 * - 因此本用例失败定性为【真实产品 BUG】（语句添加不支持分区 DDL 解析），
 *   并同步修正 DDL 列类型 INT→INTEGER（接口字段类型白名单不接受 INT，
 *   该白名单限制本身也记入证据，但它不是本用例失败主因）。
 */
import { test, expect, uuid, assertNoConsoleErrors, clickMenu } from '../utils.js';
import {
  chooseFirstOption,
  clickFormControlByLabel,
  clickVisible,
  fillFormField,
} from '../抽样用例工具.js';
import type { Locator, Page, Response, TestInfo } from '@playwright/test';
import { testEnvironment } from '../../../test-environment.js';

const MAIN_CARD_SELECTOR = '.table-query .card:visible';
const TABLE_SEARCH_PLACEHOLDER = '按表名、中文名、描述、负责人搜索';
/**
 * 配置中心解析的 GBase 数据源显示名（dataSourceNames.gbaseSourceName；resolver 内部
 * 即 GBASE_SOURCE_NAME 兼容变量链，环境重置只改配置，不改本用例）。
 */
const GBASE_SOURCE_TEXT = testEnvironment.dataSourceNames.gbaseSourceName;

/** 兼容 Ant/Element/无障碍表格的数据行定位。 */
const fieldRows = (page: Page) => page.locator([
  'tbody > tr:visible',
  '.ant-table-tbody > tr:visible',
  '.el-table__body-wrapper tr:visible',
  '[role="row"]:visible:not(:has([role="columnheader"]))',
].join(', '));

// ---------------------------------------------------------------------------
// 表管理：打开列表 / 新建表（GBase 数据源）
// ---------------------------------------------------------------------------

async function openTableManage(page: Page): Promise<void> {
  // 从默认“数据源管理”直接 goto 数据地图深层 hash 时，当前 SPA 偶发只改地址
  // 或直接保留原组件。使用真实菜单切换才能稳定卸载旧页面并挂载表管理列表。
  try {
    await clickMenu(page, '数据地图', '表管理');
  } catch {
    // 登录后首屏偶发只渲染空的顶栏容器，菜单文字尚未挂载。此时用同一个 hash
    // 不会重建 Vue 实例，必须带一次性 query 参数进行完整文档导航再进入表管理。
    const freshRoute = new URL(page.url().split('#')[0]);
    freshRoute.searchParams.set('e2e_table_manage', String(Date.now()));
    freshRoute.hash = '/dataMap/tableManage/tablesManage';
    await page.goto(freshRoute.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
  }
  // 当前数据地图把“表管理”拆为父路由与同名列表叶子。父路由只显示侧栏，不会
  // 挂载列表/新建表按钮；必须展开父菜单后点击 /tablesManage 叶子。
  const parent = page.locator('a[href="#/dataMap/tableManage"]:visible').last();
  if (await parent.isVisible().catch(() => false)) await parent.click();
  const leaf = page.locator('a[href="#/dataMap/tableManage/tablesManage"]:visible').last();
  await expect(leaf, '表管理菜单没有渲染列表叶子页').toBeVisible({ timeout: 12_000 });
  await leaf.click();
  await expect(page).toHaveURL(/#\/dataMap\/tableManage\/tablesManage(?:\?|$)/, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: /新建表|新增表/ }).last()).toBeVisible({ timeout: 15_000 });
}

/**
 * “新建表”split-button：展开数据源下拉并选择 GBase 源。
 * 优先配置中心 gbaseSourceName（GBASE_SOURCE_NAME 兼容覆盖；与同族 BL-04-00 实测
 * 可用的登记名同源），缺失时退回名称含 gbase 的任意选项；两者都没有则返回当前
 * 可选列表供调用方跳过。
 */
async function openCreateTableWithGBase(
  page: Page,
): Promise<{ ok: true; source: string } | { ok: false; available: string[] }> {
  const saveButton = page.getByRole('button', { name: /保\s*存/ }).last();
  // 部分环境点击后直接进入表单（无数据源下拉），此时视为已进入。
  if (await saveButton.isVisible().catch(() => false)) return { ok: true, source: '（未出现数据源下拉）' };

  const newButton = page.getByRole('button', { name: /新建表|新增表/ }).last();
  await newButton.click({ force: true });
  const options = page.locator(
    '.el-dropdown-menu:visible li:visible, .ant-dropdown-menu:visible li:visible, ' +
      '.ant-dropdown:visible [role="menuitem"]:visible, [role="listbox"]:visible [role="option"]:visible',
  );
  // split-button 文字区点击不展开时，补点按钮最右侧（等价于人工点下拉箭头）。
  if (!(await options.first().isVisible().catch(() => false))) {
    const box = await newButton.boundingBox().catch(() => null);
    if (box) {
      for (const offset of [8, 20]) {
        if (await options.first().isVisible().catch(() => false)) break;
        await page.mouse.click(box.x + box.width - offset, box.y + box.height / 2);
        await page.waitForTimeout(350);
      }
    }
  }
  if (!(await options.first().isVisible().catch(() => false))) {
    const caret = page.locator(
      '.el-dropdown__caret-button:visible, .el-dropdown__icon:visible, button:visible i.el-icon-arrow-down',
    ).last();
    if (await caret.isVisible().catch(() => false)) {
      await caret.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }
  await expect(options.first(), '新建表未展开数据源下拉').toBeVisible({ timeout: 10_000 });

  // 候选匹配只依赖配置中心值（includes 全名语义与迁移前一致），不再读旧写死名。
  const preferred = GBASE_SOURCE_TEXT;
  const available: string[] = [];
  let selected: Locator | undefined;
  let fallback: Locator | undefined;
  for (let index = await options.count() - 1; index >= 0; index -= 1) {
    const option = options.nth(index);
    const text = (await option.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!text || /取消|关闭/.test(text)) continue;
    if (!available.includes(text)) available.push(text);
    if (!selected && text.toLowerCase().includes(preferred.toLowerCase())) selected = option;
    if (!fallback && /gbase/i.test(text)) fallback = option;
  }
  const chosen = selected ?? fallback;
  if (!chosen) return { ok: false, available };
  const source = selected
    ? preferred
    : ((await chosen.innerText().catch(() => '')).replace(/\s+/g, ' ').trim());
  await chosen.click({ force: true });
  await page.waitForTimeout(800);
  // 新版表单在数据库选中后先展示“语句添加”，再加载保存按钮（DM-03-02 页面实况）。
  await expect(page.getByText('语句添加', { exact: true }).last()).toBeVisible({ timeout: 15_000 });
  await expect(saveButton, '选择 GBase 数据源后未进入新建表表单').toBeVisible({ timeout: 15_000 });
  return { ok: true, source };
}

// ---------------------------------------------------------------------------
// 新建表表单：必填项 + 语句添加 + 多分区 DDL 解析 + 提交
// ---------------------------------------------------------------------------

async function chooseFirstFormOption(page: Page, label: RegExp): Promise<void> {
  try {
    const control = await clickFormControlByLabel(page, label);
    await chooseFirstOption(page, control, String(label));
  } catch (error) {
    // schema、主题域和安全等级在当前环境可能是非必填且没有可选数据；
    // 不能把这些可选项误判成建表主流程失败，必填项仍继续抛错。
    if (/schema|主领域|主题域|安全等级/i.test(String(label))) return;
    throw error;
  }
}

async function fillCreateBasics(page: Page, tableName: string, chineseName: string): Promise<void> {
  await fillFormField(page, /表名称|表名/, tableName);
  await fillFormField(page, /表中文名称|表中文名/, chineseName);
  for (const label of [/数据层级/, /库.?层级/, /schema/i, /主领域|主题域/, /负责人/, /安全等级/]) {
    await chooseFirstFormOption(page, label);
  }
  // 数据生命周期/操作类型是提交必填项（0914 轮曾因空值被校验拦截），一次性补齐。
  await chooseFirstFormOption(page, /数据生命周期/);
  await chooseFirstFormOption(page, /操作类型/);
  // 页面把“执行前需要确定”作为必填项；固定选择“否”使创建流程可重复。
  const noConfirm = page.getByRole('radio', { name: '否', exact: true }).last();
  if (await noConfirm.isVisible().catch(() => false)) await noConfirm.check();
}

/** 切到“语句添加”模式并返回“字段信息”区块（血缘测试工具已验证的点击策略）。 */
async function switchToSqlFieldMode(page: Page): Promise<Locator> {
  const fieldSection = page.getByRole('heading', { name: '字段信息', exact: true }).locator('..');
  const radio = fieldSection.getByRole('radio', { name: '语句添加', exact: true });
  await expect(fieldSection).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => radio.count(), { timeout: 10_000 }).toBeGreaterThan(0);

  if (!(await radio.isChecked().catch(() => false))) {
    const targets = [
      radio.locator('..').locator('..'),
      radio.locator('..'),
      fieldSection.getByText('语句添加', { exact: true }),
    ];
    for (const target of targets) {
      if (!(await target.isVisible().catch(() => false))) continue;
      await target.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(250);
      if (await radio.isChecked().catch(() => false)) break;
    }
  }
  if (!(await radio.isChecked().catch(() => false))) {
    await radio.evaluate((element) => (element as HTMLInputElement).click()).catch(() => undefined);
    await page.waitForTimeout(250);
  }
  await expect(radio, '未能切换到“语句添加”输入模式').toBeChecked({ timeout: 5_000 });
  return fieldSection;
}

async function sqlEditor(fieldSection: Locator): Promise<Locator> {
  const editors = fieldSection.locator([
    '.monaco-editor:visible textarea',
    '.CodeMirror:visible textarea',
    'textarea:visible',
    'input:visible',
  ].join(', '));
  await expect.poll(() => editors.count(), { timeout: 10_000 }).toBeGreaterThan(0);
  return editors.last();
}

async function fillSqlEditor(editor: Locator, ddl: string): Promise<void> {
  // Monaco 的 textarea 在部分版本中接收了 fill 但没有把值同步回编辑器模型；
  // 读取回显并在必要时用真实键盘事件补写，避免点击“解析”时提交空 SQL。
  await editor.fill(ddl).catch(async () => {
    await editor.click();
    await editor.press('Control+A');
    await editor.pressSequentially(ddl);
  });
  let currentValue = await editor.inputValue().catch(() => '');
  if (!currentValue.includes('CREATE TABLE')) {
    await editor.click();
    await editor.press('Control+A');
    await editor.pressSequentially(ddl);
    currentValue = await editor.inputValue().catch(() => '');
  }
  if (!currentValue.includes('CREATE TABLE')) {
    throw new Error('新建表 DDL 编辑器未保留输入内容，未继续提交空 SQL。');
  }
}

/** 读取当前可见的 message/notification/alert 文本，作为失败时的页面提示证据。 */
async function visibleMessages(page: Page): Promise<string> {
  const notices = page.locator(
    '.ant-message-notice-content:visible, .ant-notification-notice:visible, .el-message:visible, [role="alert"]:visible',
  );
  const texts: string[] = [];
  for (let index = 0; index < await notices.count(); index += 1) {
    const text = (await notices.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (text) texts.push(text);
  }
  return [...new Set(texts)].join(' | ');
}

/**
 * No.86 核心：多分区（两个 RANGE 分区）DDL 解析。
 * 成功信号 = 字段表异步出现行（页面事实）；随后断言列 id 与分区键 dt 都被解析为
 * 字段行（分区子句不是字段，不要求出现在字段表中）。
 * 失败时收集解析相关接口响应 + 页面提示 + 字段信息区当前内容后抛出，
 * 作为判定“多分区解析是否产品缺陷”的证据。
 */
async function parseMultiPartitionDdl(
  page: Page,
  fieldSection: Locator,
  ddl: string,
  testInfo: TestInfo,
): Promise<string> {
  const responses: string[] = [];
  const onResponse = (response: Response) => {
    const url = response.url();
    if (/analysis|parse|ddl|tablemanage|metadata|partition/i.test(url)) {
      const request = response.request();
      const postData = (request.postData() ?? '').replace(/\s+/g, ' ').slice(0, 400);
      void response.text().then((body) => {
        responses.push(`${request.method()} ${response.status()} ${url} :: 请求体=${postData || '空'} :: 响应=${body.slice(0, 300)}`);
      }).catch(() => undefined);
    }
  };
  page.on('response', onResponse);
  try {
    await clickVisible(fieldSection, /解\s*析|校\s*验/);
    await expect.poll(() => fieldRows(page).count(), { timeout: 20_000 }).toBeGreaterThan(0);
  } catch (error) {
    const messages = await visibleMessages(page);
    const modeText = (await fieldSection.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
    const evidence = responses.join(' || ');
    // 定性规则：请求已带完整多分区 DDL，但后端返回 099999“sql解析异常”且指向
    // RANGE/PARTITION token —— 结合 2026-09-16 接口对照实验（同接口对无分区 DDL
    // 返回 000000，对任何 PARTITION BY 写法、任何方言一律 099999；返回字段自带
    // isPartition 属性），判定为【真实产品 BUG】，而非测试姿势或环境问题。
    const isParserReject = /099999|sql解析异常|token\s+IDENTIFIER|TODO|not supported/i.test(evidence);
    const verdict = isParserReject
      ? '定性【真实产品BUG】：后端 /tableManage/sqlToFields 解析器对“PARTITION BY RANGE”等多分区子句'
        + '返回 099999“sql解析异常”（token RANGE/PARTITION 被解析器拒绝）。2026-09-16 接口对照实验'
        + '（temp/公司模型任务/20260916-闭环/agent8-gbase-sqlprobe-result.json）：同接口对无分区 DDL'
        + '（id VARCHAR(64)、id INTEGER, dt DATE）返回 000000 且正常解析出字段；对 RANGE/LIST/HASH/'
        + 'DISTRIBUTED 的任何写法（单/双分区、MAXVALUE、RANGE COLUMNS、无空格、分号结尾）一律 099999，'
        + '且与 dataBaseTypeEnum 方言无关（MYSQL/GAUSSDBM 同样失败）；接口返回的字段对象自带 '
        + 'isPartition 属性（产品数据模型本身支持分区概念）。即当前不存在任何可通过解析的多分区 DDL '
        + '写法；页面点击“解析”后无可见错误提示、字段区 0 行——属“新建表·语句添加不支持分区 DDL 解析”'
        + '的产品缺陷，非测试姿势或环境问题'
      : '定性：待进一步归因（未见 099999 解析异常特征，请检查接口证据后人工判定）';
    if (isParserReject) {
      testInfo.annotations.push({
        type: 'bug',
        description: '真实产品BUG：/tableManage/sqlToFields 不支持任何 PARTITION BY 子句'
          + '（对照实验：无分区 DDL 000000 成功、分区 DDL 一律 099999，详见 '
          + 'temp/公司模型任务/20260916-闭环/agent8-gbase-sqlprobe-result.json）',
      });
    }
    throw new Error(
      `多分区 DDL“解析”未产生字段行（No.86 回归失败点）。页面提示：${messages || '无可见提示'}；`
      + `字段信息区当前内容：“${modeText}”；解析相关接口：${evidence || '未捕获到解析请求'}；${verdict}。`
      + `提交的 DDL：${ddl}。原始错误：${String(error)}`,
    );
  } finally {
    page.off('response', onResponse);
  }

  const rowTexts: string[] = [];
  const rows = fieldRows(page);
  for (let index = 0; index < await rows.count(); index += 1) {
    rowTexts.push((await rows.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ').trim());
  }
  for (const column of ['id', 'dt']) {
    if (!rowTexts.some((text) => new RegExp(`\\b${column}\\b`).test(text))) {
      throw new Error(`多分区 DDL 解析结果缺少列 ${column}，当前字段行：${rowTexts.join(' ; ')}`);
    }
  }
  const sectionText = (await fieldSection.innerText().catch(() => '')).replace(/\s+/g, ' ');
  const partitionEcho = /p202601|p202602|PARTITION/i.test(sectionText)
    ? '字段信息区回显了分区子句'
    : '字段信息区未回显分区子句（仅解析出列）';
  // DDL 解析已给出真实字段；这里只补齐必填中文名，不重新选择类型。
  const chineseInputs = page.locator('input[placeholder*="字段中文"]:visible');
  for (let index = 0; index < await chineseInputs.count(); index += 1) {
    await chineseInputs.nth(index).fill(`分区表字段${index + 1}`);
  }
  return `${partitionEcho}；解析字段行数=${rowTexts.length}`;
}

/** “建 表”提交：成功信号 = 离开 tableCreate 表单回到 tablesManage（页面事实）。 */
async function submitCreatedTable(page: Page): Promise<void> {
  const responses: string[] = [];
  const onResponse = (response: Response) => {
    const url = response.url();
    if (/table|metadata|catalog/i.test(url)) {
      void response.text().then((body) => {
        responses.push(`${response.request().method()} ${response.status()} ${url} :: ${body.slice(0, 300)}`);
      }).catch(() => undefined);
    }
  };
  page.on('response', onResponse);
  try {
    await page.getByRole('button', { name: /建\s*表/ }).last().click();
    // “建 表”可能触发二次确认框：有则点“确定”，无弹窗视为正常路径继续等待。
    const confirmDialog = page.getByRole('dialog').last();
    if (await confirmDialog.isVisible({ timeout: 3_000 }).catch(() => false)) {
      const confirmButton = confirmDialog.getByRole('button', { name: /^确\s*定$/ }).last();
      if (await confirmButton.isVisible().catch(() => false)) await confirmButton.click();
    }
    await expect(page).toHaveURL(/#\/dataMap\/tableManage\/tablesManage(?:\?|$)/, { timeout: 20_000 });
  } catch (error) {
    const messages = await visibleMessages(page);
    throw new Error(
      `多分区 DDL 建表提交未离开表单（No.86 提交环节）。页面提示：${messages || '无可见提示'}；`
      + `表相关接口：${responses.join(' || ') || '未触发任何表相关接口'}；当前地址：${page.url()}。`
      + `原始错误：${String(error)}`,
    );
  } finally {
    page.off('response', onResponse);
  }
}

// ---------------------------------------------------------------------------
// 表管理：列表检索 / 上线
// ---------------------------------------------------------------------------

async function manageRow(page: Page, tableName: string): Promise<Locator> {
  const filter = page.locator('input:visible:not([type="checkbox"]):not([type="radio"])').first();
  await filter.fill(tableName);
  const query = page.getByRole('button', { name: /查\s*询/ }).last();
  if (await query.isVisible().catch(() => false)) await query.click();
  const row = fieldRows(page).filter({ hasText: tableName }).first();
  await expect(row, `表管理未查询到本轮测试表“${tableName}”`).toBeVisible({ timeout: 15_000 });
  return row;
}

async function manageRowAction(page: Page, row: Locator, name: RegExp): Promise<Locator | undefined> {
  const selectors = 'button:visible, a:visible, .el-link:visible, [role="button"]:visible, [class*="link"]:visible, td:visible';
  for (const scope of [row.locator(selectors), page.locator(selectors)]) {
    for (let index = await scope.count() - 1; index >= 0; index -= 1) {
      const action = scope.nth(index);
      const text = (await action.innerText().catch(() => '')).replace(/\s+/g, ' ');
      if (name.test(text) && (await action.isVisible().catch(() => false))) return action;
    }
  }
  return undefined;
}

/** 新建表默认下线态；以下线操作重新出现作为“当前已上线”的判定。 */
async function bringTableOnline(page: Page, tableName: string): Promise<void> {
  let row = await manageRow(page, tableName);
  const online = await manageRowAction(page, row, /^上\s*线$/);
  if (online) {
    await online.click();
    const dialog = page.getByRole('dialog').last();
    const confirm = (await dialog.isVisible().catch(() => false))
      ? dialog.getByRole('button', { name: /^确\s*定$/ }).last()
      : page.getByRole('button', { name: /^确\s*定$/ }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
  }
  await expect.poll(async () => {
    row = await manageRow(page, tableName);
    return (await manageRowAction(page, row, /^下\s*线$/)) ? 'online' : 'waiting';
  }, { timeout: 20_000 }).toBe('online');
}

// ---------------------------------------------------------------------------
// 表查询：卡片检索 / 详情分区展示（No.86）
// ---------------------------------------------------------------------------

const visibleLocators = (scope: Page | Locator, selector: string) => scope.locator(selector).filter({ visible: true });

async function currentCards(page: Page): Promise<Locator[]> {
  const cards = visibleLocators(page, MAIN_CARD_SELECTOR);
  const matched: Locator[] = [];
  for (let index = 0; index < await cards.count(); index += 1) matched.push(cards.nth(index));
  return matched;
}

/** 提交表查询搜索并等待卡片刷新；返回最终页面形态（cards/empty/loading）。 */
async function submitCardSearch(page: Page, keyword: string): Promise<'cards' | 'empty' | 'loading'> {
  const input = page.getByPlaceholder(TABLE_SEARCH_PLACEHOLDER).first();
  await input.fill(keyword);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  // 若搜索框被重新挂载导致回车未触发刷新，用输入框右侧的搜索按钮兜底。
  const searchButton = visibleLocators(page, '.el-input__suffix, .ant-input-suffix').first();
  if (await searchButton.isVisible().catch(() => false)) {
    await page.keyboard.press('Enter').catch(() => undefined);
  }
  let status: 'cards' | 'empty' | 'loading' = 'loading';
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const cards = await currentCards(page);
    if (cards.length > 0) { status = 'cards'; break; }
    const empty = page.locator('.el-empty:visible, .ant-empty:visible, text=/暂无数据|没有找到|无数据/');
    if (await empty.first().isVisible().catch(() => false)) { status = 'empty'; break; }
    await page.waitForTimeout(500);
  }
  if (status === 'loading') {
    const cards = await currentCards(page);
    status = cards.length > 0 ? 'cards' : 'empty';
  }
  return status;
}

async function openTableQueryLeaf(page: Page): Promise<void> {
  const baseUrl = page.url().split('#')[0];
  const route = `${baseUrl}#/dataMap/tableQuery/tablesQuery`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    if (!/#\/dataMap\/tableQuery(?:\/tablesQuery)?(?:\?|$)/.test(page.url())) continue;
    if (await page.locator('.table-query .search-bar, .table-query .card-list').first()
      .isVisible({ timeout: 5_000 }).catch(() => false)) return;
  }
  throw new Error(`数据地图“表查询”重试 3 次后仍未打开或未渲染，当前页面：${page.url()}`);
}

/** 精确匹配表名（.table-name 文本 === tableName），避免 uuid 前缀互相误命中。 */
async function exactCard(page: Page, tableName: string): Promise<Locator | undefined> {
  for (const card of await currentCards(page)) {
    const name = (await card.locator('.table-name:visible, [class*="table-name"]:visible').first()
      .innerText().catch(() => '')).trim();
    if (name === tableName) return card;
  }
  return undefined;
}

async function requireExactCard(page: Page, tableName: string): Promise<Locator> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await submitCardSearch(page, tableName) === 'cards') {
      const card = await exactCard(page, tableName);
      if (card) return card;
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`上线后等待 30 秒仍未在表查询中找到本轮测试表“${tableName}”。`);
}

async function openCard(page: Page, card: Locator): Promise<void> {
  const name = card.locator('.table-name:visible, [class*="table-name"]:visible').first();
  await expect(name).toBeVisible({ timeout: 10_000 });
  await card.click();
  await page.waitForTimeout(300);
  await expect(page.getByRole('heading', { name: '基础信息' })).toBeVisible({ timeout: 15_000 });
}

/** 收集详情页与“分区”相关的可见文本行（排除生命周期配置的“排除分区”标签）。 */
async function collectPartitionDisplay(page: Page): Promise<{ lines: string[]; namesShown: boolean }> {
  const body = await page.locator('body').innerText().catch(() => '');
  const lines = [...new Set(body.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /分区/i.test(line) && !/排除分区/.test(line)))];
  return { lines, namesShown: /p202601|p202602/i.test(body) };
}

/**
 * No.86“分区展示”：分区信息可能渲染在详情页初始视图或其它页签（字段/DDL/脚本），
 * 逐个点开可见页签后扫描全页可见文本；由调用方对结果做真实断言。
 */
async function ensurePartitionDisplayedInDetail(
  page: Page,
): Promise<{ lines: string[]; namesShown: boolean }> {
  const tryCollect = async (): Promise<{ lines: string[]; namesShown: boolean }> => {
    let result = await collectPartitionDisplay(page);
    if (result.lines.length > 0) return result;
    const tabs = page.getByRole('tab');
    const visited: string[] = [];
    for (let index = 0; index < await tabs.count(); index += 1) {
      const tab = tabs.nth(index);
      const label = (await tab.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (!label || visited.includes(label)) continue;
      visited.push(label);
      if (!(await tab.isVisible().catch(() => false))) continue;
      await tab.click().catch(() => undefined);
      await page.waitForTimeout(600);
      result = await collectPartitionDisplay(page);
      if (result.lines.length > 0) return result;
    }
    return result;
  };
  const deadline = Date.now() + 30_000;
  let result = await tryCollect();
  while (result.lines.length === 0 && Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    result = await tryCollect();
  }
  return result;
}

// ---------------------------------------------------------------------------
// 用例主体
// ---------------------------------------------------------------------------

test.describe('DM-06-02｜数据地图｜回归验证', () => {
  test.describe.configure({ timeout: 420_000 });

  test('DM-06-02｜数据地图｜GBase 分区展示和多分区 SQL 解析（本轮自建表）', async ({ loginPage, consoleErrors, report }, testInfo) => {
    const page = loginPage;
    const tableName = `dm0602_gbp_${uuid()}`;
    const chineseName = `GBase分区表_${uuid()}`;

    // 1. 前置：新建表下拉必须提供 GBase 数据源；缺失按环境前置不足跳过，不伪造通过。
    await openTableManage(page);
    const gbase = await openCreateTableWithGBase(page);
    if (!gbase.ok) {
      await report('DM-06-02 GBase 分区展示和多分区 SQL 解析', false,
        '环境前置缺失：新建表下拉未提供 GBase 数据源（优先 '
        + `${GBASE_SOURCE_TEXT}，也不存在名称含 gbase 的选项）；`
        + `当前可选数据源：${gbase.available.join('、') || '无'}，跳过。`);
      testInfo.skip();
      return;
    }

    // 2. 填写表单必填项（数据生命周期等，页面事实见 DM-03-02）。
    await fillCreateBasics(page, tableName, chineseName);

    // 3. No.86 核心：语句添加 + 多分区（两个 RANGE 分区）DDL 解析。
    // 列类型用 INTEGER（接口字段类型白名单不接受 INT，2026-09-16 探针 T4 实测；
    // 该白名单限制只是次要问题，分区子句被解析器拒绝才是本用例失败主因）。
    const fieldSection = await switchToSqlFieldMode(page);
    const editor = await sqlEditor(fieldSection);
    const ddl = `CREATE TABLE ${tableName} (id INTEGER, dt DATE) `
      + `PARTITION BY RANGE (dt) (PARTITION p202601 VALUES LESS THAN ('2026-02-01'), `
      + `PARTITION p202602 VALUES LESS THAN ('2026-03-01'))`;
    await fillSqlEditor(editor, ddl);
    const parseEvidence = await parseMultiPartitionDdl(page, fieldSection, ddl, testInfo);

    // 4. “建 表”提交，并在表管理列表回显（No.86“多分区 SQL 解析提交后的页面回显”）。
    await submitCreatedTable(page);
    await manageRow(page, tableName);

    // 5. 上线后进入表查询明细页，核对分区信息展示（No.86“分区展示”）。
    await bringTableOnline(page, tableName);
    await openTableQueryLeaf(page);
    const card = await requireExactCard(page, tableName);
    await openCard(page, card);
    const partition = await ensurePartitionDisplayedInDetail(page);
    if (partition.lines.length === 0) {
      throw new Error(
        `表查询详情页未展示任何分区信息（No.86“分区展示”失败点）。表=${tableName}；`
        + `建表 DDL 含两个 RANGE 分区（p202601、p202602），解析环节=${parseEvidence}；`
        + '详情页可见文本中无“分区”相关内容（已逐个点开可见页签复核）。',
      );
    }

    await assertNoConsoleErrors(consoleErrors);
    await report('DM-06-02 GBase 分区展示和多分区 SQL 解析（本轮自建表）', true,
      `表=${tableName}（GBase 源=${gbase.source}）；多分区 DDL=CREATE TABLE ... PARTITION BY RANGE (dt) `
      + `两个分区（p202601、p202602）；解析=${parseEvidence}；建表提交后表管理列表回显并已上线；`
      + `表查询详情分区展示=${partition.lines.slice(0, 5).join(' / ')}；分区名回显=${partition.namesShown ? '是' : '否'}。`);
  });
});
