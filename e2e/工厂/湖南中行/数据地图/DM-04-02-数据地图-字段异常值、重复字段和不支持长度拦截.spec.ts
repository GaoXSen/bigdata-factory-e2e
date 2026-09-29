/**
 * DM-04-02｜数据地图｜新建表字段异常值、重复字段和不支持长度拦截。
 *
 * 拦截判定契约（任务-30 重写，综合 20260908 六轮失败证据、20260915 两轮实测与
 * DM-04-01/18F 通过链路）：
 * - 「保 存」仅保存草稿；「建 表」才提交字段定义并创建物理表（DM-04-01 实测）。
 * - 异常输入被阻止的合法结局只有两种：
 *   1) 表单拦截：点击「建 表」后页面停留在新建表表单（URL 仍为 tableCreate）；
 *   2) 建表接口拒绝：页面跳回表管理列表（建表成功的路由表现，DM-04-01 契约），
 *      但按本轮表名精确过滤后列表中不存在该表（接口校验/DDL 执行失败）。
 * - 两种结局都以「表管理列表按本轮表名精确过滤无该表」作为最终硬校验
 *   （本轮表未被创建的实际结果）；绝不以瞬时 toast 作为唯一证据，
 *   可见错误反馈文本只作为附加证据记录。
 * - 若列表中出现本轮表 → 异常输入未被拦截且物理表已创建 → 用例失败并把现场
 *   作为真实 BUG 证据抛出（页面/接口缺失前置校验），不得吞掉。
 * - 20260915 第 2 轮失败教训：点击「建 表」后按钮可能瞬时不可见（提交重渲染），
 *   不能用「建 表按钮 count===0」判定离开表单；本轮改为 URL 路由判定 + 观察窗。
 * - 20260915 33F 第 1 轮（run-20260915-151752-732）两条新教训：①「新建表」下拉点击
 *   MySQL 源后表单偶发不挂载（页面停留在表管理列表，「语句添加/保 存」均不出现）→
 *   openCreateTableForMysql 对同一动作整体重试两次；②类型搜索直接回车只会选中当前
 *   高亮项，NVARCHAR 含 VARCHAR 子串时被抢先回显 → 优先点击「文本恰为关键字」的
 *   选项，Enter 仅作回退。
 * - 20260915 33F 第 2 轮（run-20260915-152933-171）教训：下拉偶发未展开时，
 *   「找不到 MySQL 选项」会被误判成环境缺失而 skip——skip 必须以「下拉已展开
 *   且确认不含该源」为前提；下拉未展开一律按交互抖动重试。
 * - 20260915 第 1 轮失败教训：三级 clickMenu 停在父路由找不到「新建表」→ 采用
 *   DM-04-01/18F 通过轮的两段式菜单 + 叶子 href 点击导航；数据库下拉精确匹配
 *   配置中心的公共 MySQL 数据源（宽松匹配曾把表建到 sxzh_mas 库）。
 * - 数据源缺失、类型下拉缺少「不支持长度」类型时按环境前置不足显式 skip，
 *   写清原因，不伪造通过。
 * - 清洁环境迁移（DS-PERM-73，20260922）：每条异常用例均自建本轮唯一表（UUID ASCII
 *   物理表名 e2e_dm0402_<场景>_<uuid8>，字段名 e2e_*），MySQL 展示名与物理库读配置中心
 *   （tableManagement.newDataBase / databases.primary.database；数据层级/库层级对齐
 *   配置主库的 应用数据层/ADS 组合），不借历史测试表、旧数据源或固定负责人（负责人取
 *   下拉当前候选，不写死人名）。无论结果如何，finally 只回收本轮表：物理 DROP 显式
 *   限定配置主库 + 表管理行内「下线/删除」元数据回收（口径同 DM-01-04 DS-PERM-70），
 *   全部尽力而为、失败仅告警，不掩埋用例真实结果，也不触碰非本轮资产。异常输入的
 *   正向拦截断言保持「保存被阻断」硬校验（URL 路由 + 表管理列表精确过滤无本轮表），
 *   不绑定短 toast。
 */
import { test, expect, uuid, assertNoConsoleErrors, clickMenu, dbConfig, query } from '../utils.js';
import type { Locator, Page } from '@playwright/test';
import { testEnvironment } from '../../../test-environment.js';

/** 公共 MySQL 测试库数据源：异常建表尝试的唯一目标数据源（配置中心 tableManagement，DM-04-01/18F 通过轮同源）。 */
const MYSQL_SOURCE_TEXT = testEnvironment.dataSourceNames.tableManagement.newDataBase;
/** 数据源匹配必须精确命中公共配置源；宽松的 /mysql|ip/i 匹配在
 *  run-20260915-131823-292 实测会误选其它 MySQL 源（表被建到 sxzh_mas 库）。 */
const MYSQL_SOURCE_PATTERN = new RegExp(MYSQL_SOURCE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
/** 物理主库名（profile databases.primary.database）：库/层级对齐该库，finally 物理
 *  回收 DROP 也显式限定该库（DS-PERM-73 清洁环境迁移，DM-04-01 同口径）。 */
const PHYSICAL_DB_NAME =
  testEnvironment.databases.primary.database || testEnvironment.dataSourceNames.query.database;
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
/** 页面可见异常反馈的候选节点：仅作附加证据采集，不作为唯一判定依据。 */
const FEEDBACK_SELECTOR = [
  '.ant-form-item-explain:visible',
  '.el-form-item__error:visible',
  '.ant-message-notice:visible',
  '.ant-notification-notice:visible',
  '.el-message:visible',
  '.el-message-box:visible',
  '[role="alert"]:visible',
].join(', ');
/** DDL 中不允许长度参数的类型（DATETIME/TIMESTAMP/TIME 的 fsp 仅 0-6，DATE/YEAR
 *  完全无长度）：为它们填写长度 64 必然构成「类型不支持长度」的异常输入。 */
const NO_LENGTH_TYPES = ['DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'YEAR'];

type ReportFn = (name: string, passed: boolean, detail?: string) => Promise<void>;

interface LengthInputResult {
  /** 该行是否提供可见的长度输入框。 */
  available: boolean;
  /** fill + blur 之后输入框中的实际值（页面可能在失焦后清空/纠正非法值）。 */
  value: string;
}

interface BlockedEvidence {
  way: string;
  feedback: string;
  listCheck: string;
}

/** 短 uuid：控制表名/中文名长度，同时保证本轮唯一。 */
const shortUuid = (): string => uuid().replace(/-/g, '').slice(0, 8);

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
// ---------------------------------------------------------------------------
// 表管理导航 + 新建表入口（DM-04-01/18F 通过轮同款，修复 20260915 第 1 轮失败）
// ---------------------------------------------------------------------------

async function openTableManage(page: Page): Promise<void> {
  // hash 直跳不重挂组件（0908 根因）；三级 clickMenu 又偶发停在父路由
  // （run-20260915 上午轮实测：URL 到 /dataMap/tableManage 但列表未挂载）。
  // 采用 DM-03-02/DM-04-01 通过轮的两段式 clickMenu + 真实叶子 href 点击。
  try {
    await clickMenu(page, '数据地图', '表管理');
  } catch {
    // 登录后首屏偶发只渲染空顶栏；同一 hash 不会重建 Vue 实例，带一次性
    // query 参数做整文档导航兜底（DM-03-02 openTableManage 既有策略）。
    const freshRoute = new URL(page.url().split('#')[0]);
    freshRoute.searchParams.set('e2e_table_manage', String(Date.now()));
    freshRoute.hash = '/dataMap/tableManage/tablesManage';
    await page.goto(freshRoute.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
  }
  // 当前数据地图把“表管理”拆为父路由与同名列表叶子。父路由只显示侧栏，不会
  // 挂载列表/新建表按钮；必须展开父菜单后点击 /tablesManage 叶子。
  const leaf = page.locator('a[href="#/dataMap/tableManage/tablesManage"]:visible').last();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await leaf.isVisible().catch(() => false)) {
      // 叶子已可见（子菜单此前已展开）时绝不能再点父链接：与 DM-03-02 基线
      // 失败同型——run-20260917-105955-755 实测父菜单点击命中 ant-menu-submenu-title
      // 把已展开的子菜单收起，叶子在动画中转为不可见导致超时。此时直接点叶子，
      // 失败再按展开流程重试。
      if (await leaf.click({ timeout: 5_000 }).then(() => true).catch(() => false)) break;
      await page.waitForTimeout(800);
      continue;
    }
    const parent = page.locator('a[href="#/dataMap/tableManage"]:visible').last();
    if (await parent.isVisible().catch(() => false)) {
      await parent.click();
      await expect(leaf, '表管理菜单没有渲染列表叶子页').toBeVisible({ timeout: 12_000 });
    }
    if (await leaf.click({ timeout: 5_000 }).then(() => true).catch(() => false)) break;
    await page.waitForTimeout(800);
  }
  await expect(page).toHaveURL(/#\/dataMap\/tableManage\/tablesManage(?:\?|$)/, { timeout: 15_000 });
  // 菜单跳转后主内容区异步渲染，先轮询「新建表」按钮就绪再操作。
  await expect.poll(async () => (
    (await visibleButton(page, /新建表|新增表/)) ? 'ready' : 'loading'
  ), { timeout: 15_000 }).toBe('ready');
}

/** 等待新建表表单挂载完成：选中数据源后先出现「语句添加」，随后挂载「保 存」。
 *  33F 起改为双信号轮询（任一出现即就绪），避免单依赖「语句添加」文本在偶发
 *  渲染差异下整体卡死。表管理列表筛选区也有「表名称」文本，不能作为就绪信号。 */
async function waitForCreateFormReady(page: Page): Promise<void> {
  await expect.poll(async () => {
    const stmtAdd = await page.getByText('语句添加', { exact: true }).last().isVisible().catch(() => false);
    const saveBtn = Boolean(await visibleButton(page, /保\s*存/));
    return (stmtAdd || saveBtn) ? 'ready' : 'loading';
  }, { timeout: 15_000 }).toBe('ready');
}

/**
 * 在已展开的「新建表」数据源下拉中选择公共 MySQL 源并等待表单挂载。
 * 返回 'missing'（下拉已展开且确认不含该源，环境前置缺失）/ 'ready'（表单已挂载）/
 * 'stuck'（下拉未展开或点到数据源后表单未挂载，由调用方重试）。
 * 33F 第 2 轮（run-20260915-152933）教训：下拉偶发未展开时，旧的“3s 找不到选项”
 * 会被误判成环境缺失而 skip——因此 skip 必须以“下拉已展开”为前提。
 */
async function selectMysqlSourceFromOpenMenu(page: Page): Promise<'missing' | 'ready' | 'stuck'> {
  const menuItem = page.getByRole('menuitem', { name: MYSQL_SOURCE_PATTERN }).last();
  let dropdownAppeared = await menuItem.waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true).catch(() => false);
  if (!dropdownAppeared) {
    // 通用下拉容器兜底（数据库下拉可能不带 menuitem role）。
    const options = page.locator(
      '.el-dropdown-menu:visible li:visible, .ant-dropdown-menu:visible li:visible, ' +
        '.ant-dropdown:visible [role="menuitem"]:visible, [role="listbox"]:visible [role="option"]:visible',
    );
    dropdownAppeared = await options.first().waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true).catch(() => false);
  }
  // 下拉根本没展开：属交互抖动，交由调用方重试；绝不能当成环境缺失 skip。
  if (!dropdownAppeared) return 'stuck';

  if (await menuItem.isVisible().catch(() => false)) {
    await menuItem.click({ force: true });
  } else {
    // 下拉已展开但无 menuitem role：逐项扫描，仅当确实不含公共 MySQL 源才算环境缺失。
    const options = page.locator(
      '.el-dropdown-menu:visible li:visible, .ant-dropdown-menu:visible li:visible, ' +
        '.ant-dropdown:visible [role="menuitem"]:visible, [role="listbox"]:visible [role="option"]:visible',
    );
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
    if (!target) return 'missing';
    await target.click();
  }
  try {
    await waitForCreateFormReady(page);
    return 'ready';
  } catch {
    return 'stuck';
  }
}

/**
 * 打开新建表表单并选择公共 MySQL 数据源。
 * 返回 false 表示下拉未提供配置的公共 MySQL 数据源 MYSQL_SOURCE_TEXT（环境前置缺失，调用方 skip）。
 * 33F 第 1 轮（run-20260915-151752）实测：点击 MySQL 源后表单偶发不挂载（停留在表管理
 * 列表），因此同一动作最多重试两次；两次后表单仍未挂载属真实交互失败，显式报错而非 skip。
 */
async function openCreateTableForMysql(page: Page): Promise<boolean> {
  const newTable = await visibleButton(page, /新建表|新增表/);
  if (!newTable) throw new Error(`表管理页面没有「新建表」入口，当前页面：${page.url()}`);
  await newTable.click({ force: true });
  // 个别版本直接进入表单（无数据库下拉）。
  if (await visibleButton(page, /保\s*存/)) return true;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const outcome = await selectMysqlSourceFromOpenMenu(page);
    if (outcome === 'missing') return false;
    if (outcome === 'ready') return true;
    // stuck：关闭残留浮层后重新点开「新建表」再选一次数据源。
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(500);
    const retryEntry = await visibleButton(page, /新建表|新增表/);
    if (!retryEntry) throw new Error(`重试时「新建表」入口不可见，当前页面：${page.url()}`);
    await retryEntry.click({ force: true });
  }
  throw new Error(`已重试仍无法进入新建表表单：两次点击 MySQL 数据源（${MYSQL_SOURCE_TEXT}）后 `
    + `「语句添加/保 存」均未出现，当前页面：${page.url()}`);
}
// ---------------------------------------------------------------------------
// 新建表表单：必填基础项 + 生命周期配置（DM-04-01/18F 通过轮实测）
// ---------------------------------------------------------------------------

async function controlForLabel(page: Page, label: string, selector: string): Promise<Locator> {
  // 标签冒号由 CSS 渲染（DOM 文本无冒号，run-20260915-114622-844 实测）。
  const labels = page.getByText(new RegExp(`\\*?\\s*${label}\\s*[:：]?\\s*$`));
  for (let labelIndex = await labels.count() - 1; labelIndex >= 0; labelIndex -= 1) {
    const labelNode = labels.nth(labelIndex);
    if (!(await labelNode.isVisible().catch(() => false))) continue;
    let scope = labelNode;
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

async function selectFirstByLabel(page: Page, label: string, opts: { lenient?: boolean; match?: RegExp } = {}): Promise<boolean> {
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
    // run-20260916-173034-218 基线：长下拉列表遍历期间表单可能重渲染/下拉收起，
    // option.click() 用默认 10s 超时会挂住整条用例。改为有界点击 + 整体重开重试。
    // 当前表单混用 Ant/Element 下拉；部分条目没有 role=option，不能只按无障碍 role 查找。
    const options = page.locator(DROPDOWN_OPTIONS_SELECTOR);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await control.click();
      if (!(await expect(options.first()).toBeVisible({ timeout: 5_000 }).then(() => true).catch(() => false))) {
        await page.keyboard.press('Escape').catch(() => undefined);
        continue;
      }
      let clicked = false;
      let blocked = false;
      for (let index = await options.count() - 1; index >= 0; index -= 1) {
        const option = options.nth(index);
        const text = (await option.innerText().catch(() => '')).trim();
        if (await option.isVisible().catch(() => false) && text && !/请选择|暂无|无数据/.test(text)) {
          // 指定 match 时只选匹配项（如库/层级必须选配置主库对应层），其余候选跳过；
          // 全部候选都不匹配时显式报错，不静默落到错误选项（DM-04-01 同口径）。
          if (opts.match && !opts.match.test(text)) continue;
          clicked = await option.click({ timeout: 3_000 }).then(() => true).catch(() => false);
          if (!clicked) blocked = true;
          break;
        }
      }
      if (clicked) {
        await page.waitForTimeout(100);
        return true;
      }
      if (!blocked) {
        throw new Error(opts.match ? `「${label}」没有匹配 ${opts.match} 的可选项。` : `「${label}」没有可选项。`);
      }
      // 下拉在遍历/点击期间被重渲染收起：先收起残留层再整体重试。
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(300 * attempt);
    }
    throw new Error(`「${label}」下拉连续 3 次在选项点击时被重渲染/收起，选择未完成。`);
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

/** 必填下拉核对：填充后不得停留在「请选择」占位符（异常用例的合法基底必须先成立）。 */
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
      throw new Error(`必填表单项「${label.source}」仍停留在占位符（当前：${text || '空'}），无法构造“唯一异常”的测试表单。`);
    }
  }
}

async function fillRequiredTableBasics(page: Page, tableName: string, chineseName: string): Promise<void> {
  // 表名称/中文名携带本轮 uuid：隔离本轮数据，并规避历史草稿的表名重复
  // 把「表名重复」误报成字段异常拦截。
  await fillRequiredInput(page, '表名称', tableName);
  await fillRequiredInput(page, '表中文名称', chineseName);
  // 库/层级 决定物理库：异常用例的表单也必须对齐配置主库（databases.primary.database）。
  // 20260920-110 现场实测（DM-04-01 同源）：配置主库对应「应用数据层 + ADS」组合；
  // 选错层级会把万一被放行创建的本轮表建到其它业务库，导致 finally 物理 DROP 找不到目标。
  await selectFirstByLabel(page, '数据层级', { match: /^应用数据层$/ });
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
// 字段行操作：直接添加字段行（名称/中文名/类型/长度逐项控制与断言）
// ---------------------------------------------------------------------------

async function addDirectFieldRow(page: Page): Promise<Locator> {
  const rowsBefore = await fieldRows(page).count();
  await clickVisibleButton(page, /直接添加字段|直接添加|添加字段|新增字段/);
  await expect.poll(async () => await fieldRows(page).count(), { timeout: 10_000 })
    .toBeGreaterThan(rowsBefore);
  return fieldRows(page).last();
}

/** 行内第 index 个可见输入（0=字段名，1=字段中文名，DM-04-02 20260915 通过轮实测列序）。 */
async function fillFieldInput(row: Locator, index: number, value: string): Promise<void> {
  const input = row.locator('input:visible').nth(index);
  await expect(input).toBeVisible();
  await input.fill(value);
  await input.blur();
  await expect(input).toHaveValue(value);
}

/** 按关键字选择字段类型（原生 select 按文本、组件下拉按搜索回车）。 */
async function chooseFieldType(page: Page, row: Locator, keyword: string): Promise<void> {
  // 清理上一次失败尝试可能残留的下拉浮层，避免遮挡后续输入。
  await page.keyboard.press('Escape').catch(() => undefined);
  const control = row.locator(
    'select:visible, .ant-select:visible, .ant-select-selector:visible, .el-select:visible, ' +
      '[role="combobox"]:visible, input[placeholder*="类型"]:visible',
  ).first();
  await expect(control).toBeVisible();
  const tag = await control.evaluate((element) => element.tagName.toLowerCase()).catch(() => '');
  if (tag === 'select') {
    const byText = control.locator('option:not([disabled])').filter({ hasText: new RegExp(keyword, 'i') }).first();
    const fallback = control.locator('option:not([disabled])').filter({ hasNotText: /请选择/ }).first();
    const option = (await byText.count()) ? byText : fallback;
    await control.selectOption({ label: (await option.innerText()).trim() });
    return;
  }
  await control.click({ force: true });
  const searchInput = page.locator('.ant-select-search__field:visible, .el-select__input:visible').last();
  if (await searchInput.isVisible().catch(() => false)) {
    await searchInput.fill(keyword);
    // Enter 只选中当前高亮项：NVARCHAR 含 VARCHAR 子串，高亮可能先落在 NVARCHAR
    // （run-20260915-151752 负长度用例实测回显 NVARCHAR）。因此优先等待并直接点击
    // 「文本恰为关键字」的选项，3s 内没有精确项才回退 Enter。
    const exact = page.locator(DROPDOWN_OPTIONS_SELECTOR)
      .filter({ hasText: new RegExp(`^\\s*${keyword}\\s*$`, 'i') }).first();
    const clicked = await exact.click({ timeout: 3_000 }).then(() => true).catch(() => false);
    if (!clicked) {
      await searchInput.click().catch(() => undefined);
      await page.keyboard.press('Enter');
    }
  } else {
    await page.keyboard.type(keyword);
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(300);
}

/** 行内回显判定：类型词必须以非字母边界出现（避免 DATETIME 误匹配 TIME/TIMESTAMP）。 */
async function rowEchoesType(row: Locator, type: string): Promise<boolean> {
  const text = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ');
  return new RegExp(`(^|[^A-Za-z])${type}([^A-Za-z]|$)`, 'i').test(text);
}

/** 选择类型并硬断言行内回显：异常用例的合法基底必须先成立（最多重选 3 次，
 *  覆盖组件下拉偶发高亮项抢先命中的场景，run-20260915-151752 负长度实测）。 */
async function expectFieldType(page: Page, row: Locator, keyword: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await chooseFieldType(page, row, keyword);
    if (await rowEchoesType(row, keyword)) return;
  }
  const rowText = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ');
  throw new Error(`字段类型未能录入为 ${keyword}（已重选 3 次，当前行文本：${rowText.slice(0, 120)}），无法隔离被测异常。`);
}

/**
 * 选择一个「不允许长度参数」的类型（DATE 优先）。全部候选都不可选时返回 undefined，
 * 由调用方按环境前置不足显式 skip（页面类型清单不含无长度类型时该异常无法构造）。
 */
async function chooseNoLengthType(page: Page, row: Locator): Promise<string | undefined> {
  for (const candidate of NO_LENGTH_TYPES) {
    await chooseFieldType(page, row, candidate);
    for (const type of NO_LENGTH_TYPES) {
      if (await rowEchoesType(row, type)) return type;
    }
  }
  return undefined;
}

/**
 * 填写字段长度并读回实际值：部分实现会在失焦后清空/纠正非法值（如负数、
 * 无长度类型的长度），这本身属于页面输入层拦截，需要与「接受输入」区分。
 */
async function setFieldLength(page: Page, row: Locator, value: string): Promise<LengthInputResult> {
  const length = row.locator('input[placeholder*="长度"], input[type="number"], [role="spinbutton"]').first();
  if (!(await length.isVisible().catch(() => false))) return { available: false, value: '' };
  await length.fill(value);
  await length.blur();
  await page.waitForTimeout(300);
  return { available: true, value: (await length.inputValue().catch(() => '')).trim() };
}
// ---------------------------------------------------------------------------
// 拦截判定：观察窗 + 两种合法结局 + 「本轮表未被创建」硬复核 + 真实 BUG 证据
// ---------------------------------------------------------------------------

/** 采集页面当前可见的异常反馈文本（仅附加证据，不作唯一判定依据）。 */
async function visibleFeedbackText(page: Page): Promise<string> {
  const feedback = page.locator(FEEDBACK_SELECTOR);
  if ((await feedback.count()) === 0) return '';
  const text = await feedback.first().innerText()
    .then((value) => value.replace(/\s+/g, ' ').trim())
    .catch(() => '');
  return text.slice(0, 200);
}

/**
 * 出现可见弹窗且其中带「确 定」时点击并返回弹窗文本；无弹窗返回空串。
 * 建表二次确认/错误弹窗可能晚于点击出现：观察窗内见到即处理，让校验或
 * 建表接口真正执行完（不能停留在未确认状态造成假“拦截”）。
 */
async function clickDialogConfirmIfVisible(page: Page): Promise<string> {
  const dialog = page.locator(
    '.el-message-box:visible, [role="dialog"]:visible, .ant-modal:visible, .ant-modal-confirm:visible',
  ).last();
  if (!(await dialog.isVisible().catch(() => false))) return '';
  const confirm = dialog.getByRole('button', { name: /^确\s*定$/ }).last();
  if (!(await confirm.isVisible().catch(() => false))) return '';
  const text = (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  await confirm.click().catch(() => undefined);
  await page.waitForTimeout(300);
  return text;
}

/** 关闭可能残留的可见弹窗（确 定/取 消/关 闭），避免遮挡后续菜单导航。 */
async function dismissDialogsIfAny(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const buttons = page.getByRole('button', { name: /^确\s*定$|^取\s*消$|^关\s*闭$/ })
      .filter({ visible: true });
    if ((await buttons.count()) === 0) return;
    await buttons.last().click().catch(() => undefined);
    await page.waitForTimeout(300);
  }
}

/** 表管理列表按表名精确过滤，轮询确认本轮表是否被创建（命中=物理表已存在）。 */
async function manageListHasTable(page: Page, tableName: string): Promise<boolean> {
  await openTableManage(page);
  // 表管理列表第一个可见输入框为「表名称」筛选项（DM-03-02/DM-04-01 通过轮）。
  const filterInput = page.locator('input:visible:not([type="checkbox"]):not([type="radio"])').first();
  await expect(filterInput).toBeVisible({ timeout: 10_000 });
  await filterInput.fill(tableName);
  const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
  if (await queryButton.isVisible().catch(() => false)) await queryButton.click();
  const row = fieldRows(page).filter({ hasText: tableName }).first();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await row.isVisible().catch(() => false)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * 点击「建 表」并判定异常输入被阻止：
 * - 结局一（表单拦截）：观察窗内 URL 仍为新建表表单（tableCreate），表单保持打开；
 * - 结局二（建表接口拒绝）：跳回表管理列表，但本轮表未出现在列表（接口校验/DDL 失败）。
 * 两种结局都追加「表管理按本轮表名精确过滤无该表」的硬复核（本轮表未被创建）。
 * 若列表命中本轮表 → 异常输入被放行且物理表已创建 → 抛出真实 BUG 证据并失败。
 *
 * 注意：不用「建 表按钮瞬时不可见」判定离开表单（20260915 第 2 轮误报根因——
 * 提交重渲染瞬间按钮不可见被误判为“创建未被拦截”）；离开表单只认 URL 路由。
 */
async function expectBuildBlocked(
  page: Page,
  scenario: string,
  tableName: string,
  report: ReportFn,
): Promise<BlockedEvidence> {
  const build = page.getByRole('button', { name: /^建\s*表$/ }).last();
  await build.scrollIntoViewIfNeeded().catch(() => undefined);
  await build.click();

  let feedback = '';
  const inTableList = () => /#\/dataMap\/tableManage\/tablesManage(?:\?|$)/.test(page.url());
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !inTableList()) {
    if (!feedback) feedback = await visibleFeedbackText(page);
    const dialogText = await clickDialogConfirmIfVisible(page);
    if (dialogText && !feedback) feedback = dialogText;
    await page.waitForTimeout(300);
  }
  const leftForm = inTableList();

  if (!leftForm) {
    // 结局一：仍停留在新建表表单。复核前先清掉可能残留的错误弹窗。
    await dismissDialogsIfAny(page);
  }
  const created = await manageListHasTable(page, tableName);
  if (created) {
    const detail = `${scenario}：异常输入未被拦截（真实 BUG 证据）——「建 表」放行了非法字段定义，`
      + `本轮表 ${tableName}（${MYSQL_SOURCE_TEXT}）已出现在表管理列表（按表名精确过滤命中）。`
      + `页面反馈=${feedback || '无'}；判定时 URL=${page.url()}。请按真实业务 BUG 归类处理。`;
    await report(scenario, false, detail);
    throw new Error(detail);
  }
  return {
    way: leftForm
      ? '表单拦截（点击「建 表」后表单仍打开，URL 未离开 tableCreate）'
      : '建表接口拒绝（页面跳回表管理列表，但本轮表未创建）',
    feedback,
    listCheck: `表管理按「${tableName}」精确过滤后无该表（本轮表未被创建）`,
  };
}

// ---------------------------------------------------------------------------
// finally 回收本轮表（DS-PERM-73 清洁环境迁移；口径同 DM-01-04 DS-PERM-70）
// ---------------------------------------------------------------------------

/** 物理表名必须为纯 ASCII 标识符才允许 DROP；非 ASCII/超长名跳过物理回收（UUID 表名可追溯）。 */
function isDroppablePhysicalName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && name.length <= 64;
}

/**
 * 尽力回收本轮物理表：本轮表单的库/层级已对齐配置主库（databases.primary.database），
 * DROP 显式限定该库；异常用例的正常结局是本轮表未被创建，DROP IF EXISTS 为空操作；
 * 仅当「异常输入被放行」（真实 BUG 现场）时才会实际回收物理表。DB 未配置或 DROP
 * 失败只告警，不掩埋用例结果；遗留表按 UUID 表名可追溯。
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
 * 收尾专用：表管理按表名精确过滤定位本轮行；找不到返回 undefined（本轮表未被创建，
 * 即异常拦截生效的正常结局）。不抛错、有界等待，保证 finally 不引入新失败。
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

/** 行内操作定位（口径同 DM-04-01 rowAction）：固定列布局下行内未命中时按全页可见操作兜底。 */
async function roundRowAction(page: Page, row: Locator, name: RegExp): Promise<Locator | undefined> {
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

/** 行内「下线」尽力而为：上线状态可能拦截元数据删除，先恢复为可删除状态。 */
async function bringRoundTableOfflineBestEffort(page: Page, tableName: string): Promise<void> {
  try {
    const row = await findRoundManageRow(page, tableName);
    if (!row) return; // 本轮表不存在（拦截生效）即无需下线。
    const offline = await roundRowAction(page, row, /^下\s*线$/);
    if (offline) {
      await offline.click();
      await clickDialogConfirmIfVisible(page);
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
    const action = await roundRowAction(page, row, /^删\s*除$|^移\s*除$/);
    if (!action) {
      console.warn(`[cleanup] 表管理未提供「${tableName}」行内删除/移除入口，元数据保留（UUID 可追溯）。`);
      return;
    }
    await action.click();
    await clickDialogConfirmIfVisible(page);
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
// 用例：每条只保留一个被测异常，其余输入全部合法（异常隔离）
// ---------------------------------------------------------------------------

test.describe('DM-04-02｜数据地图｜字段异常值、重复字段和不支持长度拦截', () => {
  test.describe.configure({ timeout: 180_000 });

  test('字段名为空时建表被拦截（空必填）', async ({ loginPage, consoleErrors, report }, testInfo) => {
    const page = loginPage;
    const step = '字段异常-字段名为空';
    const tableName = `e2e_dm0402_empty_${shortUuid()}`;
    // DS-PERM-73 清洁环境迁移：无论结果如何，finally 只回收本轮自建表（物理 DROP
    // 限定配置主库 + 元数据行内下线/删除，尽力而为仅告警）。
    try {
      await openTableManage(page);
      if (!(await openCreateTableForMysql(page))) {
        await report(step, false, `环境前置缺失：新建表下拉未提供 MySQL 数据源（${MYSQL_SOURCE_TEXT}），无法执行字段异常拦截验证，跳过。`);
        testInfo.skip();
        return;
      }
      await fillRequiredTableBasics(page, tableName, `字段异常空名表_${shortUuid()}`);
      await assertRequiredSelectsFilled(page);

      // 只保留「字段名」为空：中文名/类型 VARCHAR/长度 64 均合法，拦截必须由空必填触发。
      const row = await addDirectFieldRow(page);
      await expect(row.locator('input:visible').nth(0), '新增字段行的字段名应为空').toHaveValue('');
      await fillFieldInput(row, 1, `空字段名_${shortUuid()}`);
      await expectFieldType(page, row, 'VARCHAR');
      const length = await setFieldLength(page, row, '64');
      if (!length.available || length.value !== '64') {
        throw new Error(`合法长度 64 未被长度输入框接受（available=${length.available}，实际值=${length.value || '空'}），无法隔离“字段名为空”这一被测异常。`);
      }

      const evidence = await expectBuildBlocked(page, step, tableName, report);
      await assertNoConsoleErrors(consoleErrors);
      await report(step, true, `拦截方式=${evidence.way}；${evidence.listCheck}；`
        + `页面反馈=${evidence.feedback || '无可见提示（静默拦截，20260908 同款表现）'}；本轮表=${tableName}（${MYSQL_SOURCE_TEXT}）。`);
    } finally {
      await cleanupRoundTable(page, tableName);
    }
  });

  test('字段名重复时建表被拦截', async ({ loginPage, consoleErrors, report }, testInfo) => {
    const page = loginPage;
    const step = '字段异常-重复字段名';
    const tableName = `e2e_dm0402_dup_${shortUuid()}`;
    // DS-PERM-73 清洁环境迁移：无论结果如何，finally 只回收本轮自建表。
    try {
      await openTableManage(page);
      if (!(await openCreateTableForMysql(page))) {
        await report(step, false, `环境前置缺失：新建表下拉未提供 MySQL 数据源（${MYSQL_SOURCE_TEXT}），无法执行字段异常拦截验证，跳过。`);
        testInfo.skip();
        return;
      }
      await fillRequiredTableBasics(page, tableName, `字段异常重名表_${shortUuid()}`);
      await assertRequiredSelectsFilled(page);

      // 两行使用完全相同的字段名（带本轮 uuid），其余输入全部合法；
      // 判定只要求「创建被阻止」，不绑定“重复”相关的短命提示文字。
      const duplicateName = `e2e_dupfld_${shortUuid()}`;
      for (const sequence of ['一', '二']) {
        const row = await addDirectFieldRow(page);
        await fillFieldInput(row, 0, duplicateName);
        await fillFieldInput(row, 1, `重复字段${sequence}_${shortUuid()}`);
        await expectFieldType(page, row, 'VARCHAR');
        const length = await setFieldLength(page, row, '64');
        if (!length.available || length.value !== '64') {
          throw new Error(`第 ${sequence} 行合法长度 64 未被长度输入框接受（实际值=${length.value || '空'}），无法隔离“字段名重复”这一被测异常。`);
        }
      }

      const evidence = await expectBuildBlocked(page, step, tableName, report);
      await assertNoConsoleErrors(consoleErrors);
      await report(step, true, `拦截方式=${evidence.way}；${evidence.listCheck}；重复字段名=${duplicateName}；`
        + `页面反馈=${evidence.feedback || '无可见提示（静默拦截）'}；本轮表=${tableName}（${MYSQL_SOURCE_TEXT}）。`);
    } finally {
      await cleanupRoundTable(page, tableName);
    }
  });

  test('字段名非法时建表被拦截', async ({ loginPage, consoleErrors, report }, testInfo) => {
    const page = loginPage;
    const step = '字段异常-非法字段名';
    const tableName = `e2e_dm0402_bad_${shortUuid()}`;
    // DS-PERM-73 清洁环境迁移：无论结果如何，finally 只回收本轮自建表。
    try {
      await openTableManage(page);
      if (!(await openCreateTableForMysql(page))) {
        await report(step, false, `环境前置缺失：新建表下拉未提供 MySQL 数据源（${MYSQL_SOURCE_TEXT}），无法执行字段异常拦截验证，跳过。`);
        testInfo.skip();
        return;
      }
      await fillRequiredTableBasics(page, tableName, `字段异常非法名表_${shortUuid()}`);
      await assertRequiredSelectsFilled(page);

      // 名称含连字符/感叹号/中文：MySQL 非引号标识符必然非法，实际建表会失败。
      // 若后端给标识符加反引号导致建表放行，expectBuildBlocked 会以“真实 BUG 证据”
      // 失败并落盘现场（页面/接口缺失前置校验），不吞掉。
      const illegalName = `e2e_badfld_${shortUuid()}-!非`;
      const row = await addDirectFieldRow(page);
      await fillFieldInput(row, 0, illegalName);
      await fillFieldInput(row, 1, `非法字段名_${shortUuid()}`);
      await expectFieldType(page, row, 'VARCHAR');
      const length = await setFieldLength(page, row, '64');
      if (!length.available || length.value !== '64') {
        throw new Error(`合法长度 64 未被长度输入框接受（实际值=${length.value || '空'}），无法隔离“字段名非法”这一被测异常。`);
      }

      const evidence = await expectBuildBlocked(page, step, tableName, report);
      await assertNoConsoleErrors(consoleErrors);
      await report(step, true, `拦截方式=${evidence.way}；${evidence.listCheck}；非法字段名=${illegalName}；`
        + `页面反馈=${evidence.feedback || '无可见提示（静默拦截）'}；本轮表=${tableName}（${MYSQL_SOURCE_TEXT}）。`);
    } finally {
      await cleanupRoundTable(page, tableName);
    }
  });

  test('类型不支持长度时建表被拦截', async ({ loginPage, consoleErrors, report }, testInfo) => {
    const page = loginPage;
    const step = '字段异常-类型不支持长度';
    const tableName = `e2e_dm0402_typelen_${shortUuid()}`;
    // DS-PERM-73 清洁环境迁移：无论结果如何，finally 只回收本轮自建表。
    try {
      await openTableManage(page);
      if (!(await openCreateTableForMysql(page))) {
        await report(step, false, `环境前置缺失：新建表下拉未提供 MySQL 数据源（${MYSQL_SOURCE_TEXT}），无法执行字段异常拦截验证，跳过。`);
        testInfo.skip();
        return;
      }
      await fillRequiredTableBasics(page, tableName, `类型长度异常表_${shortUuid()}`);
      await assertRequiredSelectsFilled(page);

      const row = await addDirectFieldRow(page);
      await fillFieldInput(row, 0, `e2e_typelen_${shortUuid()}`);
      await fillFieldInput(row, 1, `无长度类型字段_${shortUuid()}`);
      const chosen = await chooseNoLengthType(page, row);
      if (!chosen) {
        await report(step, false, `环境前置缺失：字段类型下拉在 ${NO_LENGTH_TYPES.join('/')} 中无可选项，无法构造“类型不支持长度”的异常输入，跳过。`);
        testInfo.skip();
        return;
      }

      // 页面输入层拦截（合法结局）：无长度类型不提供长度输入框，或长度 64 被清空/纠正。
      const length = await setFieldLength(page, row, '64');
      if (!length.available) {
        await assertNoConsoleErrors(consoleErrors);
        await report(step, true, `输入层拦截：类型 ${chosen} 不提供长度输入框，无法输入“不支持长度”；`
          + `表单保持打开，本轮表 ${tableName} 未提交（${MYSQL_SOURCE_TEXT}）。`);
        return;
      }
      if (length.value !== '64') {
        await assertNoConsoleErrors(consoleErrors);
        await report(step, true, `输入层拦截：为类型 ${chosen} 输入长度 64 后被页面拒绝（实际值=${length.value || '空'}）；`
          + `表单保持打开，本轮表 ${tableName} 未提交（${MYSQL_SOURCE_TEXT}）。`);
        return;
      }

      // chosen(64) 的非法组合已在页面上形成 → 「建 表」必须被页面或建表接口阻止。
      const evidence = await expectBuildBlocked(page, step, tableName, report);
      await assertNoConsoleErrors(consoleErrors);
      await report(step, true, `拦截方式=${evidence.way}；${evidence.listCheck}；非法组合=${chosen}(64)；`
        + `页面反馈=${evidence.feedback || '无可见提示（静默拦截）'}；本轮表=${tableName}（${MYSQL_SOURCE_TEXT}）。`);
    } finally {
      await cleanupRoundTable(page, tableName);
    }
  });

  test('字段长度为负数时建表被拦截', async ({ loginPage, consoleErrors, report }, testInfo) => {
    const page = loginPage;
    const step = '字段异常-负长度';
    const tableName = `e2e_dm0402_neglen_${shortUuid()}`;
    // DS-PERM-73 清洁环境迁移：无论结果如何，finally 只回收本轮自建表。
    try {
      await openTableManage(page);
      if (!(await openCreateTableForMysql(page))) {
        await report(step, false, `环境前置缺失：新建表下拉未提供 MySQL 数据源（${MYSQL_SOURCE_TEXT}），无法执行字段异常拦截验证，跳过。`);
        testInfo.skip();
        return;
      }
      await fillRequiredTableBasics(page, tableName, `字段异常负长度表_${shortUuid()}`);
      await assertRequiredSelectsFilled(page);

      const row = await addDirectFieldRow(page);
      await fillFieldInput(row, 0, `e2e_neglen_${shortUuid()}`);
      await fillFieldInput(row, 1, `负长度字段_${shortUuid()}`);
      await expectFieldType(page, row, 'VARCHAR');
      // VARCHAR 等字符类型的长度必须是正整数，-1 属于非法长度输入。
      const length = await setFieldLength(page, row, '-1');
      if (!length.available) {
        throw new Error('VARCHAR 字段行未找到长度输入框（页面结构变化，需先修复定位）。');
      }
      if (length.value !== '-1') {
        // 输入层拦截：负数在输入框层面即被拒绝（清空/纠正），非法值无法进入表单。
        await assertNoConsoleErrors(consoleErrors);
        await report(step, true, `输入层拦截：长度 -1 未被长度输入框接受（实际值=${length.value || '空'}），`
          + `非法长度无法进入表单；表单保持打开，本轮表 ${tableName} 未提交（${MYSQL_SOURCE_TEXT}）。`);
        return;
      }

      const evidence = await expectBuildBlocked(page, step, tableName, report);
      await assertNoConsoleErrors(consoleErrors);
      await report(step, true, `拦截方式=${evidence.way}；${evidence.listCheck}；非法输入=VARCHAR(-1)；`
        + `页面反馈=${evidence.feedback || '无可见提示（静默拦截）'}；本轮表=${tableName}（${MYSQL_SOURCE_TEXT}）。`);
    } finally {
      await cleanupRoundTable(page, tableName);
    }
  });
});




