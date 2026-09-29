/**
 * 数据地图 — DM-03-02 编辑表提交链路回归（No.68/69/73/76 当前收敛范围）
 *
 * 页面实况（run-20260914-110852-805 失败快照 + 相邻通过用例 DM-02-01/DM-08-01 实测）：
 * - 表查询卡片“编辑”图标进入的编辑页有“基本信息/任务调度”两个页签，底部按钮为
 *   “取 消 / 保 存 / 建 表”，“表名称”输入框只读（disabled）。
 * - 编辑页“保 存”只更新元数据草稿，页面不出现含“成功/完成/更新”的可观察反馈
 *   （0914 轮失败的直接原因）；真正的提交链路由“建 表”触发
 *   POST /tableManage/updateTable（DM-08-01 在同一页面族已验证）。
 * - 编辑提交有状态前置：上线态表提交 updateTable 会被业务码 099999
 *   “表已上线不予许修改！！！”拒绝（run-20260915-115448-802 实测），因此
 *   编辑前先在表管理下线本轮表，提交后再重新上线。
 * - 目标表下线期间可能不出现在表查询，编辑入口使用表管理行内「编辑」。
 * - 本用例只编辑本轮自建表（UUID 表名，公共配置 MySQL 数据源），
 *   不再按来源遍历编辑环境中的任意表，不修改任何既有业务表。
 *
 * DS-PERM-67（2026-09-22，数据源管理权限静态开发）增量：
 * - 表名前缀由历史 codex_edit_ 改为任务约定的 e2e_dm_edit_<uuid>（仍 ASCII 且 UUID 隔离）；
 * - finally 仅回收本轮表/版本/元数据：物理表尽力 DROP（dbConfig() 经配置中心）+ 元数据
 *   行内删除入口尽力尝试（口径同 DM-02-01/DS-PERM-63），清理失败只告警、不掩埋用例
 *   真实结果；除本轮表/版本/元数据外不回收任何对象。
 *
 * DS-PERM-67 2026-09-29 静态契约复核（对照 bigdata-factory-api 后端）增量：
 * - 本文件建表链路契约：POST /tableManage/createTable（@Valid CreateTableInfoReq，
 *   TableManagerController.createTable），成功码 BaseResult.code="000000"
 *   （RespEnum.SUCCESS）；“建 表”按钮对应 isCreateTable=true，由后端执行物理建表
 *   （CreateTableInfoReq.isCreateTable @NotNull + TableInfoBizImpl.createTable）。
 *   编辑提交契约不变：POST /tableManage/updateTable（TableManagerController L153-201），
 *   上线态提交被业务码 099999 拒绝（RespEnum.ERROR），既有下线前置与断言保持。
 * - 字段长度契约：validateBatchFields → DefaultDbFieldValidator 要求 VARCHAR 必须携带
 *   1~65535 的长度、且不得带精度；解析接口本会返回 DDL 长度（/tableManage/sqlToFields
 *   → sqlToDBFields），但 run-20260929-002954-565 两份 error-context 快照显示解析后
 *   “数据长度”输入框为空，提交被“必须指定长度”拒绝，页面停留在 tableCreate
 *   （本轮两用例失败的根因）。
 * - 修正：解析后按 DDL 声明长度补填空的“数据长度”（只填空值、不动精度）；负责人不再
 *   取下拉第一项（快照实际选中历史轮遗留用户 e2e_dq0302_2e504513，违反不引入旧用户
 *   约束），改为精确选择本轮登录账号（testEnvironment.accounts.testUser）；本文件
 *   建表点击与编辑提交同样等待真实 createTable 响应并校验业务码，回列表 URL 断言不变。
 */
import { test, expect, uuid, assertNoConsoleErrors, clickMenu, dbConfig, query } from '../utils.js';
import {
  chooseFirstOption,
  clickFormControlByLabel,
  clickVisible,
  fillFormField,
} from '../抽样用例工具.js';
import type { Locator, Page } from '@playwright/test';
import { testEnvironment } from '../../../test-environment.js';

/** 配置中心解析的公共 MySQL 数据源显示名（dataSourceNames.tableManagement，环境重置只改配置）。 */
const MYSQL_SOURCE_TEXT = testEnvironment.dataSourceNames.tableManagement.newDataBase;
/** 显示名转义后的数据源匹配正则（口径同 DM-01-03/DM-09-01 已迁移用例）。 */
const MYSQL_SOURCE_PATTERN = new RegExp(MYSQL_SOURCE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

const MAIN_CARD_SELECTOR = '.table-query .card:visible';
const TABLE_SEARCH_PLACEHOLDER = '按表名、中文名、描述、负责人搜索';

/** 兼容 Ant/Element/无障碍表格的数据行定位。 */
const fieldRows = (page: Page) => page.locator([
  'tbody > tr:visible',
  '.ant-table-tbody > tr:visible',
  '.el-table__body-wrapper tr:visible',
  '[role="row"]:visible:not(:has([role="columnheader"]))',
].join(', '));

// ---------------------------------------------------------------------------
// 表管理：本轮自建表（创建 + 上线）
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
  const leaf = page.locator('a[href="#/dataMap/tableManage/tablesManage"]:visible').last();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await leaf.isVisible().catch(() => false)) {
      // 叶子已可见（子菜单此前已展开）时绝不能再点父链接：run-20260916-173034-218
      // 基线里父菜单点击把已展开的子菜单收起，叶子在动画中由可见转为不可见，
      // 后续点击全部落空导致超时。此时直接点叶子，失败再按展开流程重试。
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
  await expect(page.getByRole('button', { name: /新建表|新增表/ }).last()).toBeVisible({ timeout: 15_000 });
}

async function openCreateTableEntry(page: Page): Promise<boolean> {
  // “新建表”是带下拉箭头的组合按钮。通用文本点击会命中外层容器而不展开
  // 数据源菜单；这里固定点击真实 button，并且只选择配置中心的公共 MySQL 数据源。
  const newTable = page.getByRole('button', { name: /^新建表/ }).last();
  const source = page.getByRole('menuitem', { name: MYSQL_SOURCE_PATTERN }).last();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await newTable.click({ force: true });
    if (await source.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await source.click({ force: true });
      // 新版表单在数据库选中后先展示“语句添加”，再加载保存按钮。
      await expect(page.getByText('语句添加', { exact: true }).last()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: /保\s*存/ }).last()).toBeVisible({ timeout: 15_000 });
      return true;
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(300);
  }
  return false;
}

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

/**
 * 负责人选择（2026-09-29 静态契约复核修正，DS-PERM-67“不引入旧用户”约束）：
 * 旧口径 chooseFirstFormOption(/负责人/) 恒取下拉第一项，run-20260929-002954-565
 * 失败快照显示实际选中历史轮遗留用户 e2e_dq0302_2e504513。后端仅要求 ownerId 与
 * 负责人姓名非空（TableManagerController L103-104）并建立 owner↔table 权限关系
 * （TableInfoBizImpl L146-148）；这里锚定表单行 select 包裹层后输入并精确选择本轮
 * 登录账号（testEnvironment.accounts.testUser，TEST_USER）。未命中即失败，绝不
 * 回退选择旧用户。
 */
async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  for (let index = 0; index < await locator.count(); index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

async function chooseOwnerFromForm(page: Page): Promise<string> {
  const owner = String(testEnvironment.accounts.testUser).trim();
  const candidates = page.getByText(/负责人/).filter({ visible: true });
  for (let index = await candidates.count() - 1; index >= 0; index -= 1) {
    let scope = candidates.nth(index);
    for (let level = 0; level < 4; level += 1) {
      const wrapper = await firstVisible(scope.locator('select:visible, .ant-select:visible, .el-select:visible'));
      if (wrapper) {
        await wrapper.click();
        // 可搜索下拉输入过滤；不可搜索时输入无害，仍按全量选项精确匹配账号。
        const search = wrapper.locator('input:visible').last();
        if (await search.isVisible().catch(() => false)) {
          await search.fill(owner).catch(() => undefined);
          await page.waitForTimeout(400);
        }
        const options = page.locator(
          '.ant-select-dropdown:visible .ant-select-item-option, ' +
            '.ant-select-dropdown:visible .ant-select-dropdown-menu-item, ' +
            '.el-select-dropdown:visible .el-select-dropdown__item, ' +
            '[role="listbox"]:visible [role="option"]',
        );
        for (let optionIndex = await options.count() - 1; optionIndex >= 0; optionIndex -= 1) {
          const option = options.nth(optionIndex);
          const text = (await option.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
          if (text === owner && (await option.isVisible().catch(() => false))) {
            await option.click();
            await page.waitForTimeout(150);
            await page.keyboard.press('Escape').catch(() => undefined);
            await page.mouse.move(0, 0).catch(() => undefined);
            return owner;
          }
        }
        await page.keyboard.press('Escape').catch(() => undefined);
        throw new Error(`负责人下拉中未找到本轮登录账号“${owner}”（不回退历史轮旧用户），当前页面：${page.url()}`);
      }
      scope = scope.locator('..');
    }
  }
  throw new Error(`未找到“负责人”表单控件，当前页面：${page.url()}`);
}

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

async function bringTableOnline(page: Page, tableName: string): Promise<void> {
  // 新建表默认处于“物理表存在&下线”；编辑提交后也会回到下线态。
  // 必须上线后才会在表查询出现，这里以下线操作重新出现作为“当前已上线”的判定。
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

/**
 * 表管理行内「下线」（页面实况 run-20260915-115448-802）：编辑提交接口
 * POST /tableManage/updateTable 对上线态表返回业务码 099999
 * “表已上线不予许修改！！！”，编辑前必须先在表管理把本轮表下线。
 * 以行内「上线」操作重新出现作为“当前已下线”的判定，确认弹窗存在则点“确定”。
 */
async function bringTableOffline(page: Page, tableName: string): Promise<void> {
  let row = await manageRow(page, tableName);
  const offline = await manageRowAction(page, row, /^下\s*线$/);
  if (offline) {
    await offline.click();
    const dialog = page.getByRole('dialog').last();
    const confirm = (await dialog.isVisible().catch(() => false))
      ? dialog.getByRole('button', { name: /^确\s*定$/ }).last()
      : page.getByRole('button', { name: /^确\s*定$/ }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
  }
  await expect.poll(async () => {
    row = await manageRow(page, tableName);
    return (await manageRowAction(page, row, /^上\s*线$/)) ? 'offline' : 'waiting';
  }, { timeout: 20_000 }).toBe('offline');
}

/**
 * 表管理行内「编辑」进入编辑页。目标表下线期间可能不出现在表查询
 * （项目知识库已验证），因此编辑入口固定使用表管理行内操作；
 * 行内文本未命中时回退到行内 edit 图标（aria-label/class 含 edit）。
 */
async function openEditFromManageRow(page: Page, tableName: string): Promise<void> {
  const row = await manageRow(page, tableName);
  const editAction = (await manageRowAction(page, row, /^编\s*辑$/))
    ?? row.locator('[aria-label*="edit" i], [class*="edit" i]').filter({ visible: true }).last();
  if (!(await editAction.isVisible().catch(() => false))) {
    throw new Error(`表管理行内未找到「编辑」操作：${tableName}`);
  }
  await editAction.click();
  await expect(page.getByRole('tab', { name: /基本信息/ })).toBeVisible({ timeout: 15_000 });
}

async function fillAndCreateThisRoundTable(
  page: Page,
  tableName: string,
  chineseName: string,
): Promise<void> {
  await fillFormField(page, /表名称|表名/, tableName);
  await fillFormField(page, /表中文名称|表中文名/, chineseName);
  for (const label of [/数据层级/, /库.?层级/, /schema/i, /主领域|主题域/, /安全等级/]) {
    await chooseFirstFormOption(page, label);
  }
  // 负责人改走精确选择本轮登录账号（DS-PERM-67：不引入历史轮旧用户），见 chooseOwnerFromForm。
  await chooseOwnerFromForm(page);
  // 数据生命周期等必填配置在建表时一次性补齐，编辑页阶段核对回显，
  // 避免出现 0914 轮“目标表生命周期为空、提交被校验拦截且无正向提示”的形态。
  await chooseFirstFormOption(page, /数据生命周期/);
  await chooseFirstFormOption(page, /操作类型/);
  const noConfirm = page.getByRole('radio', { name: '否', exact: true }).last();
  if (await noConfirm.isVisible().catch(() => false)) await noConfirm.check();

  await clickVisible(page, /语句添加/);
  const editor = page.locator('.monaco-editor:visible textarea').last();
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await editor.fill(`CREATE TABLE ${tableName} (id VARCHAR(64), name VARCHAR(128), remark VARCHAR(255))`);
  await page.getByRole('button', { name: /解\s*析|校\s*验/ }).last().click();
  // 解析接口异步更新字段表；用字段行出现作为成功信号。
  await expect.poll(() => fieldRows(page).count(), { timeout: 15_000 }).toBeGreaterThan(0);
  // DDL 解析已经给出真实字段类型；这里只补齐必填中文名，不重新选择类型。
  // 字段中文名（标签）用本轮唯一 ASCII（DS-PERM-67），不依赖/污染历史字段标签。
  const chineseInputs = page.locator('input[placeholder*="字段中文"]:visible');
  for (let index = 0; index < await chineseInputs.count(); index += 1) {
    await chineseInputs.nth(index).fill(`lbl_${uuid()}_f${index + 1}`);
  }

  // 2026-09-29 契约复核修正：后端 DefaultDbFieldValidator L62-66 要求 VARCHAR 必须携带
  // 1~65535 的“数据长度”，带精度同样被拒（L75-77）。解析接口本身会返回 DDL 长度
  // （/tableManage/sqlToFields → sqlToDBFields），但 run-20260929-002954-565 两份
  // error-context 快照显示解析后长度输入框为空，提交被“必须指定长度”拒绝且页面停留
  // 建表页。这里按本轮 DDL 声明的长度（64/128/255，与字段行文档序一致）补填空的
  // “数据长度”；只填空值，不动精度——页面后续恢复回显时本段自然空转。
  const declaredLengths = [64, 128, 255];
  const lengthInputs = page.locator('input[placeholder*="长度"]:visible');
  for (let index = 0; index < await lengthInputs.count(); index += 1) {
    const input = lengthInputs.nth(index);
    if ((await input.inputValue().catch(() => '')) !== '') continue;
    await input.fill(String(declaredLengths[index] ?? 64));
    // antd InputNumber 失焦后才落值。
    await input.press('Tab').catch(() => undefined);
  }

  // 后端契约：POST /tableManage/createTable，成功码 BaseResult.code="000000"
  // （RespEnum.SUCCESS）。点击后等待真实提交响应：业务码非成功时带响应体明确报错，
  // 避免 15s URL 超时掩盖后端拒绝原因（0929 轮两份失败快照的排查盲区）。
  const created = page.waitForResponse(
    (response) => response.request().method() === 'POST' && /\/tableManage\/createTable/.test(response.url()),
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: /建\s*表/ }).last().click();
  // 与编辑链路 updateTable 相同模式：出现确认弹窗则点“确定”。
  const confirmDialog = page.getByRole('dialog').last();
  if (await confirmDialog.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const confirmButton = confirmDialog.getByRole('button', { name: /^确\s*定$/ }).last();
    if (await confirmButton.isVisible().catch(() => false)) await confirmButton.click();
  }
  const response = await created;
  if (response.status() !== 200) {
    throw new Error(`建表接口 /tableManage/createTable 返回 HTTP ${response.status()}，建表未成功。`);
  }
  const payload = (await response.json().catch(() => null)) as { code?: unknown } | null;
  if (payload && 'code' in payload) {
    const codeText = String(payload.code ?? '').trim();
    const numeric = Number(payload.code);
    const accepted = codeText === '000000' || codeText === '0' || (Number.isFinite(numeric) && numeric === 200);
    if (!accepted) {
      throw new Error(`建表接口业务返回非成功：${JSON.stringify(payload)}`);
    }
  }
  // 建表成功后应回到表管理列表页（真实回跳作为业务成功证据，保持既有断言不变）。
  await expect(page).toHaveURL(/#\/dataMap\/tableManage\/tablesManage(?:\?|$)/, { timeout: 15_000 });
  await bringTableOnline(page, tableName);
}

// ==================== 本轮自建资产回收（DS-PERM-67，口径同 DM-02-01/DS-PERM-63） ====================

/** 表管理列表行定位（DS-PERM-67 清理自包含，不依赖各用例既有 helper 命名）。 */
const roundListRows = (page: Page) =>
  page.locator([
    'tbody > tr:visible',
    '.ant-table-tbody > tr:visible',
    '.el-table__body-wrapper tr:visible',
    '[role="row"]:visible:not(:has([role="columnheader"]))',
  ].join(', '));

/** 仅合法 MySQL 标识符（≤64 字符）才可能是本轮真实物理表；非法探针名直接跳过物理回收。 */
function isDroppablePhysicalName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && name.length <= 64;
}

/** 尽力回收本轮物理表（dbConfig() 缺失或 DROP 失败只告警，不掩埋用例结果）。 */
async function dropRoundPhysicalTables(names: string[]): Promise<void> {
  const droppable = [...new Set(names)].filter(isDroppablePhysicalName);
  if (!droppable.length) return;
  if (!dbConfig()) {
    console.warn(`[cleanup] DB 未配置：本轮物理表未回收（${droppable.join(', ')}），元数据按 UUID 可追溯。`);
    return;
  }
  for (const name of droppable) {
    try {
      await query(`DROP TABLE IF EXISTS \`${name}\``);
    } catch (error) {
      console.warn(`[cleanup] 本轮物理表 ${name} DROP 失败（尽力而为）：`, error);
    }
  }
}

/** 行内操作定位：仅接受精确“删除/移除”文本，避免误触其它列（口径同 DM-02-01）。 */
async function findRowAction(page: Page, row: Locator, name: RegExp): Promise<Locator | undefined> {
  const selectors = 'button:visible, a:visible, .el-link:visible, [role="button"]:visible, [class*="link"]:visible';
  for (const scope of [row.locator(selectors), row.locator('td:visible').last().locator(selectors)]) {
    for (let index = await scope.count() - 1; index >= 0; index -= 1) {
      const candidate = scope.nth(index);
      const text = (await candidate.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (name.test(text) && (await candidate.isVisible().catch(() => false))) return candidate;
    }
  }
  return undefined;
}

/** 元数据行内删除入口尽力而为：入口不存在（当前版本未提供）时仅告警保留，UUID 可追溯。 */
async function deleteRoundMetadataRows(page: Page, names: string[]): Promise<void> {
  for (const name of new Set(names)) {
    try {
      await openTableManage(page);
      const filter = page.locator('input:visible:not([type="checkbox"]):not([type="radio"])').first();
      if (!(await filter.isVisible().catch(() => false))) {
        console.warn(`[cleanup] 未回到表管理列表，跳过“${name}”元数据页面侧回收（UUID 可追溯）。`);
        continue;
      }
      await filter.fill(name);
      const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
      if (await queryButton.isVisible().catch(() => false)) await queryButton.click();
      const row = roundListRows(page).filter({ hasText: name }).first();
      if (!(await row.isVisible({ timeout: 3_000 }).catch(() => false))) continue;
      const action = await findRowAction(page, row, /^删\s*除$|^移\s*除$/);
      if (!action) {
        console.warn(`[cleanup] 表管理未提供“${name}”行内删除/移除入口，元数据保留（UUID 可追溯）。`);
        continue;
      }
      await action.click();
      const dialog = page.getByRole('dialog').last();
      const confirm = (await dialog.isVisible().catch(() => false))
        ? dialog.getByRole('button', { name: /^确\s*定$/ }).last()
        : page.getByRole('button', { name: /^确\s*定$/ }).last();
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
    } catch (error) {
      console.warn(`[cleanup] 本轮元数据“${name}”页面侧回收失败（尽力而为）：`, error);
    }
  }
}

/** finally 专用：仅清理本轮 UUID 自建表（物理表 + 元数据行内入口），全部尽力而为、只告警不抛错。 */
async function cleanupRoundTables(page: Page, names: string[]): Promise<void> {
  if (!names.length) return;
  await dropRoundPhysicalTables(names);
  await deleteRoundMetadataRows(page, names);
}

// ---------------------------------------------------------------------------
// 表查询：卡片检索 / 编辑入口 / 详情
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
  const cardsBefore = await currentCards(page).then((found) => found.length);
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
    if (cards.length > 0 && cards.length !== cardsBefore) { status = 'cards'; break; }
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
  // 详情页由点击卡片上的“表名”节点触发（DM-05-01 searchAndOpenTable 与
  // 血缘测试工具 searchAndOpenTable 同页面族已验证：cardName 点击后出现
  // “基础信息”标题；点击卡片容器不触发详情路由，run-20260915-122506-020 实测）。
  // 详情页是 /tableQuery/tableDetail 路由，无路由级返回按钮，一律走 hash 直跳回列表。
  const name = card.locator('.table-name:visible, [class*="table-name"]:visible').first();
  await expect(name).toBeVisible({ timeout: 10_000 });
  await name.click();
  await page.waitForTimeout(300);
  await expect(page.getByRole('heading', { name: '基础信息' })).toBeVisible({ timeout: 15_000 });
}

/** 读取表单项（label 所在控件行）的可见文本，用于判断下拉是否停留在占位符。 */
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

/**
 * 编辑页回显核对（No.69/73/76）：
 * - 页签“基本信息/任务调度”，表名称只读且等于本轮表名；
 * - 页面标 * 的必填项（数据层级、库/层级、负责人）回显不得停留在空值/“请选择”
 *   （页面实况 run-20260915-114622-844：标签冒号由 CSS 渲染，DOM 文本无冒号，
 *   正则不能带 [：:]）；
 * - 「数据生命周期配置」区块必须存在；数据生命周期/操作类型在编辑页当前产品
 *   不回显且未标 *，由 ensureLifecycleConfigured 在提交前补齐后核对；
 * - 字段信息：字段名/中文名回显，字段类型 VARCHAR、字段长度 64 与建表 DDL 一致。
 */
async function expectEditFormEchoesConfig(page: Page, tableName: string): Promise<void> {
  await expect(page.getByRole('tab', { name: /基本信息/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('tab', { name: /任务调度/ })).toBeVisible();

  const nameInput = page.getByPlaceholder('请输入表名称', { exact: true }).last();
  await expect(nameInput).toBeDisabled();
  await expect(nameInput).toHaveValue(tableName);

  const chineseInput = page.getByPlaceholder('请输入表中文名称', { exact: true }).last();
  await expect(chineseInput).not.toHaveValue('');

  const requiredLabels: Array<[RegExp, string]> = [
    [/数据层级/, '数据层级'],
    [/库\s*[/／]\s*层级/, '库/层级'],
    [/负责人/, '负责人'],
  ];
  for (const [pattern, label] of requiredLabels) {
    const text = await formItemText(page, pattern);
    if (!text || /请选择/.test(text)) {
      throw new Error(`编辑页必填项“${label}”未回显有效值（当前表单项文本：“${text}”）。`);
    }
  }

  await expect(page.getByRole('heading', { name: '数据生命周期配置' }))
    .toBeVisible({ timeout: 10_000 });

  const firstField = fieldRows(page).first();
  await expect(firstField).toBeVisible({ timeout: 10_000 });
  await expect(firstField.getByPlaceholder('请输入字段名', { exact: true })).toHaveValue('id');
  await expect(firstField.getByPlaceholder('请输入字段中文名', { exact: true })).not.toHaveValue('');
  const rowText = (await firstField.innerText().catch(() => '')).replace(/\s+/g, ' ');
  if (!/varchar/i.test(rowText)) {
    throw new Error(`编辑页字段 id 的数据类型未回显 VARCHAR，字段行内容：${rowText}`);
  }
  await expect(firstField.getByPlaceholder('请输入长度', { exact: true })).toHaveValue('64');
}

/**
 * 「数据生命周期配置」提交前补齐（编辑页实况 run-20260915-114622-844）：
 * 该区块在编辑页不回显建表时的选择（数据生命周期/操作类型 combobox 为空，
 * 页面也未标 *），0914 轮遗留表曾因空生命周期被提交校验拦截。这里在页面
 * 上补选一次，并在选择后核对 combobox 不再停留在“请选择”，不吞异常。
 */
async function ensureLifecycleConfigured(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: '数据生命周期配置' })).toBeVisible({ timeout: 10_000 });
  const lifecycleLabels: Array<[RegExp, string]> = [
    [/数据生命周期/, '数据生命周期'],
    [/操作类型/, '操作类型'],
  ];
  for (const [pattern, label] of lifecycleLabels) {
    const before = await formItemText(page, pattern);
    if (!before || /请选择/.test(before)) {
      await chooseFirstFormOption(page, pattern);
    }
    const after = await formItemText(page, pattern);
    if (!after || /请选择/.test(after)) {
      throw new Error(`编辑页“${label}”补选后仍未生效（表单项文本：“${after}”）。`);
    }
  }
}

/**
 * 编辑并提交（No.68）：修改表中文名称与表级描述后，经“建 表”提交。
 * 页面事实：编辑页“保 存”只更新元数据草稿且无可观察反馈，真正提交链路是
 * “建 表”触发 POST /tableManage/updateTable；判定为 HTTP 200 且业务码成功
 * （当前环境成功码为 "000000"/message 成功，见 run-20260915-120226-818）。
 */
async function editAndSubmit(page: Page, chineseAfter: string, descMarker: string): Promise<void> {
  // 编辑页不回显数据生命周期/操作类型，提交前补齐，避免提交被校验拦截。
  await ensureLifecycleConfigured(page);

  const chineseInput = page.getByPlaceholder('请输入表中文名称', { exact: true }).last();
  await chineseInput.fill(chineseAfter);
  await expect(chineseInput).toHaveValue(chineseAfter);

  // 表级描述：优先 textarea#businessRemark（DM-08-01 同页面族）；缺失时退回
  // accessible name 以“描述”开头的文本框（^ 锚定避免误中字段行的“请输入描述”）。
  let description = page.locator('textarea#businessRemark:visible').last();
  if (!(await description.isVisible().catch(() => false))) {
    description = page.getByRole('textbox', { name: /^描\s*述/ }).last();
  }
  await expect(description, '编辑页未找到表级描述输入框').toBeVisible({ timeout: 10_000 });
  await description.fill(descMarker);
  await expect(description).toHaveValue(descMarker);

  const submitted = page.waitForResponse(
    (response) => response.request().method() === 'POST' && /\/tableManage\/updateTable/.test(response.url()),
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: /^建\s*表$/ }).last().click();
  // 任务要求“处理确认弹窗（如有）”：若“建 表”触发二次确认框则点“确定”；
  // 无弹窗时视为正常路径，继续等待提交接口响应。
  const confirmDialog = page.getByRole('dialog').last();
  if (await confirmDialog.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const confirmButton = confirmDialog.getByRole('button', { name: /^确\s*定$/ }).last();
    if (await confirmButton.isVisible().catch(() => false)) await confirmButton.click();
  }
  const response = await submitted;
  if (response.status() !== 200) {
    throw new Error(`编辑提交接口 /tableManage/updateTable 返回 HTTP ${response.status()}。`);
  }
  const body = await response.json().catch(() => null);
  if (body && typeof body === 'object' && 'code' in body) {
    const rawCode = (body as { code?: unknown }).code;
    const codeText = String(rawCode ?? '').trim();
    const numeric = Number(rawCode);
    // 页面实况（run-20260915-120226-818）：当前环境 updateTable 提交成功返回
    // {"code":"000000","message":"成功","data":null}；数字 200/0 亦视为成功，
    // 其余业务码（如 099999 表已上线不予修改）仍按失败抛出。
    const success = codeText === '000000' || codeText === '0'
      || (Number.isFinite(numeric) && numeric === 200);
    if (!success) {
      throw new Error(`编辑提交接口业务返回非成功：${JSON.stringify(body)}`);
    }
  }
}

/**
 * 提交后回表查询详情，验证编辑后的表中文名称已回显（闭环硬证据）。
 * 编辑后的描述在详情页作为观察项：既有 DM-01-04（源码 540 行）已注明
 * “详情页‘描述’当前可能存在回显缺失，属于详情展示的独立问题”，因此描述
 * 回显不作为本用例失败条件，但如实返回观测结果供最终报告记录。
 */
async function verifyEchoInTableQuery(
  page: Page,
  tableName: string,
  chineseAfter: string,
  descMarker: string,
): Promise<{ descEchoed: boolean }> {
  await openTableQueryLeaf(page);
  const card = await requireExactCard(page, tableName);
  await openCard(page, card);
  await expect.poll(async () => {
    const body = await page.locator('body').innerText().catch(() => '');
    return body.includes(chineseAfter) ? 'echoed' : 'waiting';
  }, { timeout: 30_000, intervals: [500, 1_000, 2_000] }).toBe('echoed');
  const descDeadline = Date.now() + 8_000;
  while (Date.now() < descDeadline) {
    const body = await page.locator('body').innerText().catch(() => '');
    if (body.includes(descMarker)) return { descEchoed: true };
    await page.waitForTimeout(1_000);
  }
  return { descEchoed: false };
}

test.describe('DM-03-02｜数据地图｜编辑表提交链路回归（No.68 69 73 76）', () => {
  test.describe.configure({ timeout: 420_000 });

  test('DM-03-02｜数据地图｜编辑表提交链路回归（本轮自建表）', async ({ loginPage, consoleErrors, report }, testInfo) => {
    const page = loginPage;
    // DS-PERM-67：表名前缀用任务约定的 e2e_dm_edit_<uuid>（ASCII 且 UUID 隔离），不再用历史 codex_ 前缀。
    const tableName = `e2e_dm_edit_${uuid()}`;
    const chineseBefore = `编辑链路表_${uuid()}`;
    const chineseAfter = `编辑回显_${uuid()}`;
    const descMarker = `desc_${uuid()}`;
    // DS-PERM-67：finally 仅回收本轮表/版本/元数据；建表可能部分成功，先登记再创建。
    const roundTables: string[] = [];
    try {
      // 1. 前置：新建表下拉必须提供配置中心的公共 MySQL 数据源（MYSQL_SOURCE_TEXT），
      //    缺失按环境前置不足跳过，不伪造通过。
      await openTableManage(page);
      const sourceReady = await openCreateTableEntry(page);
      if (!sourceReady) {
        await report('DM-03-02 编辑表提交链路', false,
          `环境前置缺失：新建表下拉未提供 MySQL 数据源（${MYSQL_SOURCE_TEXT}），无法创建本轮测试表，跳过。`);
        testInfo.skip();
        return;
      }

      // 2. 建本轮表（含数据生命周期等必填配置）并上线，使表查询可检索。
      roundTables.push(tableName);
      await fillAndCreateThisRoundTable(page, tableName, chineseBefore);

      // 3. 表查询精确检索本轮表（在线态可见性证据；上线由第 2 步完成）。
      await openTableQueryLeaf(page);
      await requireExactCard(page, tableName);

      // 4. 产品规则（run-20260915-115448-802：上线态提交被业务码 099999
      //    “表已上线不予许修改！！！”拒绝）：编辑提交前必须先下线。
      //    回表管理把本轮表下线，再从表管理行内「编辑」进入编辑页；
      //    下线期间目标表可能不出现在表查询，不从卡片进入。
      await openTableManage(page);
      await bringTableOffline(page, tableName);
      await openEditFromManageRow(page, tableName);

      // 5. 核对编辑页回显：必填项、字段类型/长度、数据生命周期配置区块。
      await expectEditFormEchoesConfig(page, tableName);

      // 6. 修改表中文名称与描述后经“建 表”提交，断言 POST /tableManage/updateTable。
      await editAndSubmit(page, chineseAfter, descMarker);

      // 7. 提交后表处于下线态，表管理重新上线本轮表。
      await openTableManage(page);
      await bringTableOnline(page, tableName);

      // 8. 回表查询详情验证编辑值回显（中文名硬断言；描述为观察项，见函数注释）。
      const echo = await verifyEchoInTableQuery(page, tableName, chineseAfter, descMarker);

      await assertNoConsoleErrors(consoleErrors);
      await report('DM-03-02 编辑表提交链路（本轮自建表）', true,
        `表=${tableName}；编辑前中文名=${chineseBefore}；编辑后中文名=${chineseAfter}；`
        + `描述标记=${descMarker}；提交接口 POST /tableManage/updateTable HTTP 200 业务码成功（000000）；`
        + `表已重新上线且表查询详情回显编辑后中文名；`
        + `详情页描述回显观测=${echo.descEchoed ? '已回显' : '未回显（DM-01-04 已注明的详情展示独立问题，不作为本用例失败条件）'}。`);
    } finally {
      // DS-PERM-67：仅回收本轮表/版本/元数据，清理失败只告警、不掩埋用例真实结果。
      await cleanupRoundTables(page, roundTables);
    }
  });
});





