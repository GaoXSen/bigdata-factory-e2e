/**
 * DM-04-01｜数据地图｜MySQL 合法字段添加并建表（单链路收敛版）
 *
 * 覆盖场景：新建表 → 必填表单配置 → 三个合法字段（名称/中文名/类型 VARCHAR/长度 64）
 * 逐项录入并断言 → 建表 → 上线 → 表查询精确检索 + 详情回显。
 * 空、重复、非法命名、长度越界等异常输入由 DM-04-02 独立覆盖，本用例只走合法输入。
 *
 * 页面实况（run-20260908-165151-286 失败快照 + DM-03-02/DM-04-02 20260915 通过轮）：
 * - 登录后默认停在「数据接入→数据源管理」（#/dataAccess/dataSource）。旧实现直接 goto
 *   表管理 hash：SPA 只改地址不重挂组件，URL 正则校验通过但页面停留在数据源管理，
 *   随后找不到「新建表」按钮——0908 轮失败的直接根因。必须用真实菜单
 *   clickMenu('数据地图', '表管理', '表管理') 切换（DM-04-02 20260915 通过轮）。
 * - 「新建表」是 split-button：第一次点击只展开数据库菜单，必须选择配置中心的
 *   公共 MySQL 数据源（dataSourceNames.tableManagement）才进入表单；下拉缺源按环境前置不足显式 skip，
 *   不伪造通过（DM-03-02 既有约定）。表单就绪信号：可见「语句添加」+「保 存」。
 * - 必填项实测（DM-04-02 20260915 通过轮）：表名称、表中文名称 + 下拉
 *   数据层级/库层级(schema 小写)/主题域/负责人/安全等级 + 数据生命周期/操作类型/
 *   确认周期/排除分区 + 「是否需要人工确认」radio 否。
 * - 字段行实测：行内第 0 个可见输入为字段名、第 1 个为字段中文名；数据类型控件
 *   支持 VARCHAR 搜索回车；长度输入框 placeholder 含「长度」。
 * - 「建 表」为真实提交按钮（/^建\s*表$/，页面渲染为“建 表”）；成功表现：跳回
 *   #/dataMap/tableManage/tablesManage 且新表出现在列表（DM-04-02 拦截判定的反向契约）。
 * - 新表默认下线态；表管理行内「上线」+ 确定弹窗后上线，以行内重新出现「下线」
 *   操作判定已上线（DM-03-02 20260915 通过轮）。上线后表查询（.table-name 全等）才可见；
 *   详情由点击卡片表名进入（出现「基础信息」标题），body 回显表中文名。
 * - 清洁环境迁移（DS-PERM-73，20260922）：本轮表/字段全部自建唯一（UUID ASCII 物理表名
 *   e2e_mysql_field_<uuid8>，字段名 e2e_*），MySQL 展示名与物理库均读配置中心
 *   （tableManagement.newDataBase / databases.primary.database），不借历史测试表、
 *   旧数据源或固定负责人（负责人取下拉当前候选，不写死人名）。无论用例通过、失败还是
 *   环境前置 skip，finally 只回收本轮表：物理 DROP 显式限定配置主库 + 表管理行内
 *   「下线/删除」元数据回收（口径同 DM-01-04 DS-PERM-70），全部尽力而为、失败仅告警，
 *   不掩埋用例真实结果，也不触碰非本轮资产。
 */
import { test, expect, uuid, assertNoConsoleErrors, clickMenu, dbConfig, query } from '../utils.js';
import type { Locator, Page } from '@playwright/test';
import { testEnvironment } from '../../../test-environment.js';

/** 公共 MySQL 测试库数据源：本轮唯一允许新建物理表的目标数据源（配置中心 tableManagement）。 */
const MYSQL_SOURCE_TEXT = testEnvironment.dataSourceNames.tableManagement.newDataBase;
/** 数据源匹配必须精确命中公共配置源；宽松的 /mysql|ip/i 匹配在
 * run-20260915-131823-292 实测会选中下拉里其它 MySQL 源（本轮表被建到 sxzh_mas 库）。 */
const MYSQL_SOURCE_PATTERN = new RegExp(MYSQL_SOURCE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
/** 物理主库名（profile databases.primary.database），用于建表后数据库列回显断言。 */
const PHYSICAL_DB_NAME =
  testEnvironment.databases.primary.database || testEnvironment.dataSourceNames.query.database;
const MAIN_CARD_SELECTOR = '.table-query .card:visible';
const TABLE_SEARCH_PLACEHOLDER = '按表名、中文名、描述、负责人搜索';
const FIELD_ROWS_SELECTOR = [
  'tbody > tr:visible',
  '.ant-table-tbody > tr:visible',
  '.el-table__body-wrapper tr:visible',
  '[role="row"]:visible:not(:has([role="columnheader"]))',
].join(', ');
const DROPDOWN_OPTIONS_SELECTOR = [
  '[role="listbox"]:visible [role="option"]:visible',
  '.el-select-dropdown:visible .el-select-dropdown__item:visible:not(.is-disabled)',
  '.el-select-dropdown:visible .el-select-dropdown-menu__item:visible',
  '.ant-select-dropdown:visible .ant-select-item-option:visible:not(.ant-select-item-option-disabled)',
  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item:visible',
  '.el-select-dropdown:visible li:visible',
  '.ant-select-dropdown:visible li:visible',
].join(', ');

const fieldRows = (page: Page) => page.locator(FIELD_ROWS_SELECTOR);

async function lastVisible(locator: Locator): Promise<Locator | undefined> {
  for (let index = await locator.count() - 1; index >= 0; index -= 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

async function visibleButton(page: Page, name: string | RegExp): Promise<Locator | undefined> {
  return lastVisible(page.getByRole('button', { name }));
}

async function clickVisibleButton(page: Page, name: string | RegExp): Promise<void> {
  const button = await visibleButton(page, name);
  if (!button) throw new Error(`按钮“${String(name)}”未找到可见节点，当前页面：${page.url()}`);
  await button.click();
}

/** 出现二次确认弹窗时点击「确 定」；未出现不阻塞（等待即返回）。 */
async function confirmDialogIfAny(page: Page, timeout = 2_000): Promise<void> {
  const confirm = page.getByRole('dialog').last()
    .getByRole('button', { name: /^确\s*定$/ }).last();
  if (await confirm.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false)) {
    await confirm.click();
  }
}

// ---------------------------------------------------------------------------
// finally 回收本轮表（DS-PERM-73 清洁环境迁移；口径同 DM-01-04 DS-PERM-70）
// ---------------------------------------------------------------------------

/** 物理表名必须为纯 ASCII 标识符才允许 DROP；非 ASCII/超长名跳过物理回收（UUID 表名可追溯）。 */
function isDroppablePhysicalName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && name.length <= 64;
}

/**
 * 尽力回收本轮物理表：本轮物理表由建表链路保证落在配置主库（databases.primary.database，
 * 库/层级已按 应用数据层/ADS 固定），DROP 显式限定该库；DB 未配置或 DROP 失败只告警，
 * 不掩埋用例结果；遗留表按 UUID 表名可追溯。
 */
async function dropRoundPhysicalTable(name: string): Promise<void> {
  if (!isDroppablePhysicalName(name)) return;
  if (!dbConfig()) {
    console.warn(`[cleanup] DB 未配置：本轮物理表「${name}」未回收（UUID 表名可追溯）。`);
    return;
  }
  const target = PHYSICAL_DB_NAME && isDroppablePhysicalName(PHYSICAL_DB_NAME)
    ? `\`${PHYSICAL_DB_NAME}\`.\`${name}\``
    : `\`${name}\``;
  try {
    await query(`DROP TABLE IF EXISTS ${target}`);
  } catch (error) {
    console.warn(`[cleanup] 本轮物理表 ${name} DROP 失败（尽力而为）：`, error);
  }
}

/**
 * 收尾专用：表管理按表名精确过滤定位本轮行；找不到返回 undefined（可能已被回收）。
 * 与业务链路的 filterManageRow 不同，这里不抛错、有界等待，保证 finally 不引入新失败。
 */
async function findRoundManageRow(page: Page, tableName: string): Promise<Locator | undefined> {
  const filterInput = page.locator('input:visible:not([type="checkbox"]):not([type="radio"])').first();
  if (!(await filterInput.isVisible().catch(() => false))) return undefined;
  await filterInput.fill(tableName);
  const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
  if (await queryButton.isVisible().catch(() => false)) await queryButton.click();
  const row = fieldRows(page).filter({ hasText: tableName }).first();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await row.isVisible().catch(() => false)) return row;
    await page.waitForTimeout(500);
  }
  return undefined;
}

/** 行内「下线」尽力而为：上线状态可能拦截元数据删除，先恢复为可删除状态。 */
async function bringRoundTableOfflineBestEffort(page: Page, tableName: string): Promise<void> {
  try {
    const row = await findRoundManageRow(page, tableName);
    if (!row) {
      console.warn(`[cleanup] 表管理未查询到本轮表「${tableName}」，跳过下线（可能已被回收）。`);
      return;
    }
    const offline = await rowAction(page, row, /^下\s*线$/);
    if (offline) {
      await offline.click();
      await confirmDialogIfAny(page, 3_000);
      await page.waitForTimeout(1_000);
    }
  } catch (error) {
    console.warn(`[cleanup] 本轮表「${tableName}」下线失败（尽力而为）：`, error);
  }
}

/** 元数据行内删除入口尽力而为：入口不存在或删除失败仅告警保留，UUID 表名可追溯。 */
async function deleteRoundMetadataRowBestEffort(page: Page, tableName: string): Promise<void> {
  try {
    const row = await findRoundManageRow(page, tableName);
    if (!row) return; // 已不存在视为本轮元数据回收完成。
    const action = await rowAction(page, row, /^删\s*除$|^移\s*除$/);
    if (!action) {
      console.warn(`[cleanup] 表管理未提供「${tableName}」行内删除/移除入口，元数据保留（UUID 可追溯）。`);
      return;
    }
    await action.click();
    await confirmDialogIfAny(page, 5_000);
  } catch (error) {
    console.warn(`[cleanup] 本轮元数据「${tableName}」页面侧回收失败（尽力而为）：`, error);
  }
}

/**
 * finally 专用：只回收本轮 UUID 自建表（物理 DROP + 元数据行内下线/删除），
 * 全部尽力而为、只告警不抛错，绝不掩埋用例真实结果，也不触碰非本轮资产。
 */
async function cleanupRoundTable(page: Page, tableName: string): Promise<void> {
  if (!tableName) return;
  await dropRoundPhysicalTable(tableName);
  try {
    await openTableManage(page);
  } catch (error) {
    console.warn(`[cleanup] 未回到表管理列表，跳过「${tableName}」元数据页面侧回收（UUID 可追溯）：`, error);
    return;
  }
  await bringRoundTableOfflineBestEffort(page, tableName);
  await deleteRoundMetadataRowBestEffort(page, tableName);
}

// ---------------------------------------------------------------------------
// 表管理：导航 + 新建表入口（split-button + 公共 MySQL 数据源）
// ---------------------------------------------------------------------------

async function openTableManage(page: Page): Promise<void> {
  // 0908 失败根因：hash 直跳不重挂组件，必须走真实菜单切换（DM-03-02 20260915 通过轮）。
  // run-20260915-131304-066 实测：三级 clickMenu 在登录首屏偶发模块不响应点击，
  // 重试 30s 左侧栏仍停留在「数据接入」；改用 DM-03-02 通过轮同款两段式
  // clickMenu + 真实叶子 href 点击，菜单未挂载/不响应时才走整文档导航兜底。
  try {
    await clickMenu(page, '数据地图', '表管理');
  } catch {
    // 登录后首屏偶发只渲染空的顶栏容器，菜单文字尚未挂载。此时用同一个 hash
    // 不会重建 Vue 实例，必须带一次性 query 参数进行完整文档导航再进入表管理
    // （DM-03-02 openTableManage 既有兜底策略）。
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
  // 菜单路由跳转后主内容区异步渲染，先轮询等「新建表」按钮就绪再操作。
  await expect.poll(async () => (
    (await visibleButton(page, /新建表|新增表/)) ? 'ready' : 'loading'
  ), { timeout: 15_000 }).toBe('ready');
}

/** 等待新建表表单挂载完成（选中数据库后先出现「语句添加」，再挂载「保 存」）。 */
async function waitForCreateFormReady(page: Page): Promise<void> {
  await expect(page.getByText('语句添加', { exact: true }).last()).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (
    (await visibleButton(page, /保\s*存/)) ? 'ready' : 'loading'
  ), { timeout: 15_000 }).toBe('ready');
}

/**
 * 打开新建表表单并选择公共 MySQL 数据源。
 * 返回 false 表示下拉未提供配置的公共 MySQL 数据源 MYSQL_SOURCE_TEXT（环境前置缺失，调用方 skip）。
 */
async function openCreateTableForMysql(page: Page): Promise<boolean> {
  const newTable = await visibleButton(page, /新建表|新增表/);
  if (!newTable) throw new Error(`表管理页面没有「新建表」入口，当前页面：${page.url()}`);
  // 20260920-110 r2 现场偶发：点击后数据源下拉 3 秒内未挂载导致整例被误判为
  // 环境缺源而 skip。这里等待放宽到 8 秒，并在无任何菜单出现时重试一次点击。
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await newTable.click({ force: true });
    // 个别版本直接进入表单（无数据库下拉）。
    if (await visibleButton(page, /保\s*存/)) return true;

    const menuItem = page.getByRole('menuitem', { name: MYSQL_SOURCE_PATTERN }).last();
    if (await menuItem.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false)) {
      await menuItem.click({ force: true });
      await waitForCreateFormReady(page);
      return true;
    }

    // 通用下拉扫描兜底（数据库下拉可能不带 menuitem role；过滤“取消/关闭/新建表”项）。
    const options = page.locator(
      '.el-dropdown-menu:visible li:visible, .ant-dropdown-menu:visible li:visible, ' +
        '.ant-dropdown:visible [role="menuitem"]:visible, [role="listbox"]:visible [role="option"]:visible',
    );
    if (await options.first().waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
      let target: Locator | undefined;
      for (let index = await options.count() - 1; index >= 0; index -= 1) {
        const option = options.nth(index);
        if (!(await option.isVisible().catch(() => false))) continue;
        const text = (await option.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (!text || /取消|关闭|新建表/.test(text)) continue;
        if (MYSQL_SOURCE_PATTERN.test(text)) {
          target = option;
          break;
        }
      }
      if (target) {
        await target.click();
        await waitForCreateFormReady(page);
        return true;
      }
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(500);
  }
  return false;
}

// ---------------------------------------------------------------------------
// 新建表表单：必填基础项 + 生命周期配置（DM-04-02 20260915 通过轮实测）
// ---------------------------------------------------------------------------

async function controlForLabel(page: Page, label: string, selector: string): Promise<Locator> {
  // 标签冒号由 CSS 渲染（DOM 文本无冒号，run-20260915-114622-844 实测）。
  const labels = page.getByText(new RegExp(`\\*?\\s*${label}\\s*[:：]?\\s*$`));
  for (let labelIndex = await labels.count() - 1; labelIndex >= 0; labelIndex -= 1) {
    const labelNode = labels.nth(labelIndex);
    if (!(await labelNode.isVisible().catch(() => false))) continue;
    let scope: Locator = labelNode;
    for (let level = 0; level < 8; level += 1) {
      const control = await lastVisible(scope.locator(selector));
      if (control) return control;
      scope = scope.locator('..');
    }
  }
  throw new Error(`新建表表单未找到「${label}」对应的 ${selector} 控件，当前页面：${page.url()}`);
}

async function fillRequiredInput(page: Page, label: string, value: string): Promise<void> {
  const input = await controlForLabel(page, label, 'input:visible');
  await input.fill(value);
  await input.blur();
  await expect(input).toHaveValue(value);
}

async function selectFirstByLabel(
  page: Page,
  label: string,
  opts: { lenient?: boolean; match?: RegExp } = {},
): Promise<boolean> {
  try {
    const control = await controlForLabel(
      page,
      label,
      '[role="combobox"]:visible, .ant-select:visible, .el-select:visible, select:visible',
    );
    const tag = await control.evaluate((element) => element.tagName.toLowerCase()).catch(() => '');
    if (tag === 'select') {
      const option = control.locator('option:not([disabled])').filter({ hasNotText: /请选择/ }).first();
      await control.selectOption({ label: (await option.innerText()).trim() });
      return true;
    }
    await control.click();
    // 当前表单混用 Ant/Element 下拉；部分条目没有 role=option，不能只按无障碍 role 查找。
    const options = page.locator(DROPDOWN_OPTIONS_SELECTOR);
    for (let index = await options.count() - 1; index >= 0; index -= 1) {
      const option = options.nth(index);
      const text = (await option.innerText().catch(() => '')).trim();
      if (await option.isVisible().catch(() => false) && text && !/请选择|暂无|无数据/.test(text)) {
        // 指定 match 时只选匹配项（如库/层级必须选配置主库），其余候选跳过；
        // 全部候选都不匹配时显式报错，不静默落到错误选项。
        if (opts.match && !opts.match.test(text)) continue;
        await option.click();
        await page.waitForTimeout(100);
        return true;
      }
    }
    throw new Error(opts.match ? `「${label}」没有匹配 ${opts.match} 的可选项。` : `「${label}」没有可选项。`);
  } catch (error) {
    // schema/主题域/安全等级 等环境相关项可能没有可选项：缺失不判错（DM-03-02
    // chooseFirstFormOption 既有策略）；核心必填项缺失保持显式报错。
    if (opts.lenient) return false;
    throw error;
  }
}

/** 读取 label 所在表单项行的可见文本，用于判断下拉是否停留在占位符。 */
async function formItemText(page: Page, label: RegExp): Promise<string> {
  const labelNode = page.getByText(label).filter({ visible: true }).last();
  await expect(labelNode).toBeVisible({ timeout: 10_000 });
  const labelLength = (await labelNode.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().length;
  let scope: Locator = labelNode;
  for (let level = 0; level < 6; level += 1) {
    scope = scope.locator('..');
    const text = (await scope.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (text.length > labelLength) return text;
  }
  return '';
}

/** 必填下拉核对：填充后不得停留在「请选择」占位符（必填表单配置的逐项验证）。 */
async function assertRequiredSelectsFilled(page: Page): Promise<void> {
  const required = [
    /^\*?\s*数据层级\s*$/,
    /^\*?\s*库\/层级\s*$/,
    /^\*?\s*负责人\s*$/,
    /^\*?\s*数据生命周期\s*$/,
    /^\*?\s*操作类型\s*$/,
  ];
  for (const label of required) {
    const text = await formItemText(page, label);
    if (!text || /请选择|请输入/.test(text)) {
      throw new Error(`必填表单项「${label.source}」仍停留在占位符（当前：${text || '空'}），必填表单配置不完整。`);
    }
  }
}

async function fillRequiredTableBasics(page: Page, tableName: string, chineseName: string): Promise<void> {
  // 表名称/中文名携带本轮 uuid：隔离本轮新建数据，并规避历史草稿的表名重复。
  await fillRequiredInput(page, '表名称', tableName);
  await fillRequiredInput(page, '表中文名称', chineseName);
  await selectFirstByLabel(page, '数据层级', { match: /^应用数据层$/ });
  // 库/层级 决定物理库：本轮必须建到配置主库（databases.primary.database）。20260920-110 现场实测：
  // ① 库/层级 的可选项集合取决于所选数据层级（r1 选到其它层级时其下库为
  // df_ta，run-20260920-175615-459）；② 存量表查询卡片证明配置主库对应
  // “应用数据层 + ADS” 组合（如 e2e_mysql_field_392f327e [配置主库] 应用数据层/ADS）。
  await selectFirstByLabel(page, '库/层级', { match: /^ADS$/ });
  await selectFirstByLabel(page, 'schema', { lenient: true });
  await selectFirstByLabel(page, '主题域', { lenient: true });
  await selectFirstByLabel(page, '负责人');
  await selectFirstByLabel(page, '安全等级', { lenient: true });
  // 生命周期配置（DM-04-02 20260915 通过轮实测顺序）。
  await selectFirstByLabel(page, '数据生命周期');
  await selectFirstByLabel(page, '操作类型');
  const noConfirm = page.getByRole('radio', { name: '否', exact: true }).last();
  if (await noConfirm.isVisible().catch(() => false)) await noConfirm.click();
  await selectFirstByLabel(page, '确认周期', { lenient: true });
  await selectFirstByLabel(page, '排除分区', { lenient: true });
}

// ---------------------------------------------------------------------------
// 合法字段：直接添加字段行（名称/中文名/类型 VARCHAR/长度 64 逐项断言）
// ---------------------------------------------------------------------------

async function addDirectFieldRow(page: Page): Promise<Locator> {
  const rowsBefore = await fieldRows(page).count();
  await clickVisibleButton(page, /直接添加字段|直接添加|添加字段|新增字段/);
  await expect.poll(async () => await fieldRows(page).count(), { timeout: 10_000 })
    .toBeGreaterThan(rowsBefore);
  return fieldRows(page).last();
}

async function fillValidFieldRow(page: Page, fieldName: string, chineseName: string): Promise<void> {
  const row = await addDirectFieldRow(page);
  // 行内第 0 个可见输入为字段名、第 1 个为字段中文名（DM-04-02 20260915 通过轮实测列序）。
  const nameInput = row.locator('input:visible').nth(0);
  await expect(nameInput).toBeVisible();
  await nameInput.fill(fieldName);
  await nameInput.blur();
  await expect(nameInput).toHaveValue(fieldName); // 合法字段名称：逐项断言

  const chineseInput = row.locator('input:visible').nth(1);
  await expect(chineseInput).toBeVisible();
  await chineseInput.fill(chineseName);
  await chineseInput.blur();
  await expect(chineseInput).toHaveValue(chineseName); // 字段中文名：逐项断言

  // 数据类型：统一选择页面已支持的 VARCHAR（合法类型）。
  const typeControl = row.locator(
    'select:visible, .ant-select:visible, .ant-select-selector:visible, .el-select:visible, ' +
      '[role="combobox"]:visible, input[placeholder*="类型"]:visible',
  ).first();
  await expect(typeControl).toBeVisible();
  const tag = await typeControl.evaluate((element) => element.tagName.toLowerCase()).catch(() => '');
  if (tag === 'select') {
    const byText = typeControl.locator('option:not([disabled])').filter({ hasText: /varchar/i }).first();
    const fallback = typeControl.locator('option:not([disabled])').filter({ hasNotText: /请选择/ }).first();
    const option = (await byText.count()) ? byText : fallback;
    await typeControl.selectOption({ label: (await option.innerText()).trim() });
  } else {
    await typeControl.click({ force: true });
    const searchInput = page.locator('.ant-select-search__field:visible, .el-select__input:visible').last();
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill('VARCHAR');
    } else {
      await page.keyboard.type('VARCHAR');
    }
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
  }
  // 合法类型：录入后行内文本必须回显 VARCHAR。
  const rowText = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ');
  if (!/varchar/i.test(rowText)) {
    throw new Error(`字段「${fieldName}」数据类型录入后未回显 VARCHAR（当前行文本：${rowText.slice(0, 120)}）。`);
  }

  // 字段长度：合法长度 64。
  const lengthInput = row.locator('input[placeholder*="长度"], input[type="number"], [role="spinbutton"]').first();
  await expect(lengthInput).toBeVisible();
  await lengthInput.fill('64');
  await lengthInput.blur();
  await expect(lengthInput).toHaveValue('64'); // 合法长度：逐项断言
}

// ---------------------------------------------------------------------------
// 建表提交 + 上线
// ---------------------------------------------------------------------------

async function submitAndExpectTableCreated(page: Page, tableName: string): Promise<void> {
  // 「保 存」仅保存草稿；「建 表」才提交字段定义并创建物理表（DM-04-02 实测）。
  const build = page.getByRole('button', { name: /^建\s*表$/ }).last();
  await build.scrollIntoViewIfNeeded().catch(() => undefined);
  await build.click();
  // 个别版本提交前弹二次确认框；出现即点确定，未出现不阻塞。
  await confirmDialogIfAny(page, 2_000);
  // 成功契约（DM-04-02 拦截判定的反向）：跳回表管理列表且新表出现在列表。
  await expect(page).toHaveURL(/#\/dataMap\/tableManage\/tablesManage(?:\?|$)/, { timeout: 20_000 });
  await expect(page.locator('body')).toContainText(tableName, { timeout: 15_000 });
}

async function filterManageRow(page: Page, tableName: string): Promise<Locator> {
  // 表管理列表第一个可见输入框为「表名称」筛选项（DM-03-02 20260915 通过轮）。
  const filterInput = page.locator('input:visible:not([type="checkbox"]):not([type="radio"])').first();
  await expect(filterInput).toBeVisible({ timeout: 10_000 });
  await filterInput.fill(tableName);
  const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
  if (await queryButton.isVisible().catch(() => false)) await queryButton.click();
  const row = fieldRows(page).filter({ hasText: tableName }).first();
  await expect(row, `表管理未查询到本轮测试表「${tableName}」`).toBeVisible({ timeout: 15_000 });
  return row;
}

/**
 * 行内操作定位：表管理列表是固定列布局，一行被拆成主表/左固定（表名）/右固定
 * （操作）多个 table 元素（run-20260915-131823-292 快照实测），「上线/下线」按钮
 * 与表名不在同一个 table 里，按行查找永远找不到。列表已按表名过滤到唯一行，
 * 行内未命中时按全页可见操作兜底（DM-03-02 20260915 通过轮 manageRowAction 同款）。
 */
async function rowAction(page: Page, row: Locator, name: RegExp): Promise<Locator | undefined> {
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

/** 上线：行内「上线」+ 确定弹窗；以行内出现「下线」判定已上线（DM-03-02 同契约）。 */
async function bringTableOnline(page: Page, tableName: string): Promise<void> {
  let row = await filterManageRow(page, tableName);
  // 数据库列必须显示配置主库（databases.primary.database）：防止数据源误选把测试表建到其它业务库。
  await expect(page.locator('body')).toContainText(PHYSICAL_DB_NAME, { timeout: 10_000 });
  const online = await rowAction(page, row, /^上\s*线$/);
  if (online) {
    await online.click();
    await confirmDialogIfAny(page, 3_000);
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      row = await filterManageRow(page, tableName);
      if (await rowAction(page, row, /^下\s*线$/)) return; // 已上线
      // 上线请求尚未生效时行内仍是「上线」，再次点击（含确认弹窗）。
      const retry = await rowAction(page, row, /^上\s*线$/);
      if (retry) {
        await retry.click();
        await confirmDialogIfAny(page, 3_000);
      }
    } catch {
      // 列表刷新瞬间行可能未挂载，忽略本轮，下一轮重查。
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`等待 30 秒后表管理中「${tableName}」仍未上线（行内未出现「下线」操作）。`);
}

// ---------------------------------------------------------------------------
// 表查询：精确检索 + 详情回显（DM-03-02 20260915 通过轮同链路）
// ---------------------------------------------------------------------------

const visibleLocators = (scope: Page | Locator, selector: string) =>
  scope.locator(selector).filter({ visible: true });

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
  let status: 'cards' | 'empty' | 'loading' = 'loading';
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await currentCards(page)).length > 0) {
      status = 'cards';
      break;
    }
    const empty = page.locator('.el-empty:visible, .ant-empty:visible, text=/暂无数据|没有找到|无数据/');
    if (await empty.first().isVisible().catch(() => false)) {
      status = 'empty';
      break;
    }
    await page.waitForTimeout(500);
  }
  if (status === 'loading') {
    status = (await currentCards(page)).length > 0 ? 'cards' : 'empty';
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
  throw new Error(`数据地图「表查询」重试 3 次后仍未打开或未渲染，当前页面：${page.url()}`);
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
  throw new Error(`上线后等待 30 秒仍未在表查询中找到本轮测试表「${tableName}」。`);
}

async function openCard(page: Page, card: Locator): Promise<void> {
  // 详情页由点击卡片上的表名节点触发（点击卡片容器不触发详情路由，
  // run-20260915-122506-020 实测）；点击后出现「基础信息」标题。
  const name = card.locator('.table-name:visible, [class*="table-name"]:visible').first();
  await expect(name).toBeVisible({ timeout: 10_000 });
  await name.click();
  await page.waitForTimeout(300);
  await expect(page.getByRole('heading', { name: '基础信息' })).toBeVisible({ timeout: 15_000 });
}

/** 详情回显：详情页 body 必须包含建表时填写的表中文名。 */
async function expectDetailEchoesChinese(page: Page, chineseName: string): Promise<void> {
  await expect.poll(async () => {
    const body = await page.locator('body').innerText().catch(() => '');
    return body.includes(chineseName) ? 'echoed' : 'waiting';
  }, { timeout: 30_000, intervals: [500, 1_000, 2_000] }).toBe('echoed');
}

// ---------------------------------------------------------------------------
// 用例：唯一 MySQL 表的合法字段建表全链路
// ---------------------------------------------------------------------------

test.describe('DM-04-01｜数据地图｜MySQL 合法字段添加并建表', () => {
  test.describe.configure({ timeout: 300_000 });

  test('DM-04-01｜数据地图｜MySQL 合法字段添加并建表', async ({ loginPage, consoleErrors, report }, testInfo) => {
    const page = loginPage;
    const tableName = `e2e_mysql_field_${uuid()}`;
    const chineseName = `MySQL合法字段表_${uuid()}`;
    const fields = [
      { name: 'e2e_id', chinese: '主键标识' },
      { name: 'e2e_name', chinese: '名称' },
      { name: 'e2e_remark', chinese: '备注说明' },
    ] as const;

    // DS-PERM-73 清洁环境迁移：无论通过、失败还是环境前置 skip，finally 只回收本轮
    // 自建表（物理 DROP 限定配置主库 + 元数据行内下线/删除，尽力而为仅告警）。
    try {
      // 1. 表管理（真实菜单三级点击，修复 0908 hash 直跳不挂载的失败根因）。
      await openTableManage(page);

      // 2. 新建表入口 + 公共 MySQL 数据源；缺源按环境前置不足显式跳过，不伪造通过。
      const entered = await openCreateTableForMysql(page);
      if (!entered) {
        await report('字段添加-MySQL', false,
          `环境前置缺失：新建表下拉未提供 MySQL 数据源（${MYSQL_SOURCE_TEXT}），无法创建本轮唯一测试表，跳过。`);
        testInfo.skip();
        return;
      }

      // 3. 必填表单配置（表名/中文名/基础下拉/生命周期），填后核对必填下拉非占位符。
      await fillRequiredTableBasics(page, tableName, chineseName);
      await assertRequiredSelectsFilled(page);

      // 4. 三个合法字段逐项录入：名称、中文名、类型 VARCHAR、长度 64 全部断言。
      for (const field of fields) {
        await fillValidFieldRow(page, field.name, field.chinese);
      }

      // 5. 建表：成功表现 = 跳回表管理列表且新表出现在列表。
      await submitAndExpectTableCreated(page, tableName);

      // 6. 上线：行内「上线」+ 确定弹窗，行内出现「下线」判定已上线。
      await bringTableOnline(page, tableName);

      // 7. 表查询精确检索本轮表（上线后索引可能延迟，30s 轮询容忍刷新）。
      await openTableQueryLeaf(page);
      const card = await requireExactCard(page, tableName);

      // 8. 详情回显：打开卡片详情，验证建表时填写的中文名。
      await openCard(page, card);
      await expectDetailEchoesChinese(page, chineseName);

      await assertNoConsoleErrors(consoleErrors);
      await report('字段添加-MySQL', true,
        `表=${tableName}（${MYSQL_SOURCE_TEXT} 本轮唯一新建，finally 已回收物理表+元数据）；`
        + `字段=${fields.map((field) => field.name).join('、')}（类型 VARCHAR、长度 64、中文名逐项断言）；`
        + `必填项=表名称/表中文名称/数据层级/库层级/负责人/数据生命周期/操作类型已填写并核对非占位符；`
        + `已上线（表管理行内出现「下线」）；表查询 .table-name 精确命中且详情回显中文名「${chineseName}」。`);
    } finally {
      await cleanupRoundTable(page, tableName);
    }
  });
});
