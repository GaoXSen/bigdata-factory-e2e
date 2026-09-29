/**
 * 数据地图 — DM-03-02 新建表必填项与保存流程（本轮自建表）
 *
 * 2026-09-17 agent-9 静态恢复版。原文件在 2026-09-17 10:20 前后的编辑器故障中被整体
 * 替换为 skip 占位（事件与核查结论见
 * temp/公司模型任务/20260916-闭环/agent8-recover-fragments/README-毁损与恢复记录.md）。
 * 本文件按文件名标题重建“新建表必填项校验 + 保存（建表）流程”的真实覆盖，恢复依据：
 * - 建表/上线整链路复用在册孪生 DM-03-02《编辑表提交链路回归（No.68 69 73 76）》
 *   run-20260917-105532-552 通过轮实现：表管理父/叶子路由进入、“新建表”split-button
 *   下拉精确选择配置中心的公共 MySQL 数据源（dataSourceNames.tableManagement）、必填项与数据生命周期一次
 *   补齐、语句添加 DDL → 解析 → 补字段中文名 → “建 表”提交回 tablesManage、
 *   行内上线（以下线操作重新出现作为已上线判定）；
 * - 必填项为空保存被拦截的断言复用在册 DM-02-02 通过轮实现（不填任何必填项直接
 *   “保 存”出现校验提示），并按腾讯文档辅助审查 20260902-092549 第 136 条意见
 *   优先在表单区域内匹配提示，避免全页静态文字造成假通过；
 * - 描述框 blur 同步与必填下拉选择复用 DM-00-01 通过轮实现。
 *
 * 数据策略：仅创建并操作本轮 UUID 自建表（e2e_dm_newreq_<uuid>，公共配置主库），
 * 不修改任何既有业务表。
 * 其“编辑表提交链路”侧面由在册孪生 DM-03-02《编辑表提交链路回归》承接，不互换测试目的。
 *
 * DS-PERM-67（2026-09-22，数据源管理权限静态开发）增量：
 * - 字段中文名（标签）用本轮唯一 ASCII（lbl_<uuid>_fN），不再使用固定“字段N”；
 * - 取消“自建表永久保留”约定：finally 仅回收本轮表/版本/元数据——物理表尽力 DROP
 *   （dbConfig() 经配置中心）+ 元数据行内删除入口尽力尝试（口径同 DM-02-01/DS-PERM-63），
 *   清理失败只告警、不掩埋用例真实结果；除本轮表/版本/元数据外不回收任何对象。
 *
 * DS-PERM-67 2026-09-29 静态契约复核（对照 bigdata-factory-api 后端）增量：
 * - 建表提交契约：POST /tableManage/createTable（@Valid CreateTableInfoReq，
 *   TableManagerController.createTable），成功码 BaseResult.code="000000"
 *   （RespEnum.SUCCESS）；“建 表”按钮对应 isCreateTable=true，由后端执行物理建表
 *   （CreateTableInfoReq.isCreateTable @NotNull + TableInfoBizImpl.createTable）。
 * - 字段长度契约：validateBatchFields → DefaultDbFieldValidator 要求 VARCHAR 必须携带
 *   1~65535 的长度、且不得带精度；解析接口本会返回 DDL 长度（/tableManage/sqlToFields
 *   → sqlToDBFields），但 run-20260929-002954-565 两份 error-context 快照显示解析后
 *   “数据长度”输入框为空，提交被“必须指定长度”拒绝，页面停留在 tableCreate
 *   （本轮两用例失败的根因）。
 * - 修正：解析后按 DDL 声明长度补填空的“数据长度”（只填空值、不动精度）；负责人不再
 *   取下拉第一项（快照实际选中历史轮遗留用户 e2e_dq0302_2e504513，违反不引入旧用户
 *   约束），改为精确选择本轮登录账号（testEnvironment.accounts.testUser）；
 *   “建 表”点击后等待真实 createTable 响应并校验业务码，回列表 URL 断言保持不变。
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

/** 兼容 Ant/Element/无障碍表格的数据行定位。 */
const fieldRows = (page: Page) => page.locator([
  'tbody > tr:visible',
  '.ant-table-tbody > tr:visible',
  '.el-table__body-wrapper tr:visible',
  '[role="row"]:visible:not(:has([role="columnheader"]))',
].join(', '));

async function openTableManage(page: Page): Promise<void> {
  // 从默认“数据源管理”直接 goto 数据地图深层 hash 时，当前 SPA 偶发只改地址或直接
  // 保留原组件。使用真实菜单切换才能稳定卸载旧页面并挂载表管理列表。
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
  // 当前数据地图把“表管理”拆为父路由与同名列表叶子。父路由只显示侧栏，不会挂载
  // 列表/新建表按钮；必须展开父菜单后点击 /tablesManage 叶子。
  const leaf = page.locator('a[href="#/dataMap/tableManage/tablesManage"]:visible').last();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await leaf.isVisible({ timeout: 2_000 }).catch(() => false)) {
      // 叶子已可见（子菜单此前已展开）时绝不能再点父链接：父菜单点击会把已展开的
      // 子菜单收起，叶子在动画中由可见转为不可见，后续点击全部落空导致超时。
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
  // “新建表”是带下拉箭头的组合按钮。通用文本点击会命中外层容器而不展开数据源
  // 菜单；这里固定点击真实 button，并且只选择配置中心的公共 MySQL 数据源。
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

/**
 * 2026-09-20 110 现场快照修复：基本信息表单是 antd select。共享
 * clickFormControlByLabel 的父链回溯 + visible()（从后往前）可能命中 select
 * 内部“可见但不可点击”的 search input（pointer-events:none），点击 10s 超时
 * （run-20260920-173537-434 现场）。这里优先点击行内真实的
 * select/.ant-select/.el-select 包裹层（文档序第一个，即本行的控件本体），
 * 找不到包裹层时回退共享工具，不改变断言语义。
 */
async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  for (let index = 0; index < await locator.count(); index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

async function chooseFirstFormOption(page: Page, label: RegExp): Promise<void> {
  // 2026-09-20 r2 现场：/安全等级/ 还会命中“字段信息”表格的列头（同名无冒号文字，
  // DOM 更靠后），直接 last() 选错锚点后整页找不到控件。改为逐候选（从后往前）
  // 在 ≤4 层父链内定位真实 select 包裹层：表单行的 label 距其 select 仅 1 层父链，
  // 表格列头 4 层内没有 select，可以精确区分两者。
  const candidates = page.getByText(label).filter({ visible: true });
  for (let index = await candidates.count() - 1; index >= 0; index -= 1) {
    let scope = candidates.nth(index);
    for (let level = 0; level < 4; level += 1) {
      const wrapper = await firstVisible(scope.locator('select:visible, .ant-select:visible, .el-select:visible'));
      if (wrapper) {
        try {
          await chooseFirstOption(page, wrapper, String(label));
          return;
        } catch (error) {
          // schema、主题域和安全等级在当前环境可能是非必填且没有可选数据；
          // 不能把这些可选项误判成建表主流程失败，必填项仍继续抛错。
          if (/schema|主领域|主题域|安全等级/i.test(String(label))) return;
          throw error;
        }
      }
      scope = scope.locator('..');
    }
  }
  // 兜底：共享工具的可见控件查找（保持原语义）。
  const control = await clickFormControlByLabel(page, label);
  await chooseFirstOption(page, control, String(label));
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
  // 新建表默认处于“物理表存在&下线”；必须上线后才会在表查询出现，
  // 这里以行内「下线」操作重新出现作为“当前已上线”的判定。
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
 * 负责人选择（2026-09-29 静态契约复核修正，DS-PERM-67“不引入旧用户”约束）：
 * 旧口径 chooseFirstFormOption(/负责人/) 恒取下拉第一项，run-20260929-002954-565
 * 失败快照显示实际选中历史轮遗留用户 e2e_dq0302_2e504513。后端仅要求 ownerId 与
 * 负责人姓名非空（TableManagerController L103-104）并建立 owner↔table 权限关系
 * （TableInfoBizImpl L146-148）；这里锚定表单行 select 包裹层后输入并精确选择本轮
 * 登录账号（testEnvironment.accounts.testUser，TEST_USER）。未命中即失败，绝不
 * 回退选择旧用户。
 */
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

/**
 * 建表全链路（孪生 DM-03-02 run-20260917-105532-552 通过轮口径）：必填项与数据
 * 生命周期一次性补齐 → 语句添加 DDL → 解析 → 补字段中文名 → “建 表”提交回
 * tablesManage → 行内上线。
 */
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
  // 数据生命周期等必填配置在建表时一次性补齐（0914 轮教训：漏配会在提交时
  // 被校验拦截且无正向提示）。
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

/**
 * 必填项校验断言（DM-02-02 通过轮口径 + 审查 20260902-092549 第 136 条修正）：
 * 必填未填全直接“保 存”应被拦截。校验提示限定在表单项/表单容器内匹配，
 * 不做全页宽松匹配（全页静态提示文字会造成假通过）；同时核对未离开建表
 * 表单、未出现成功反馈。
 */
async function expectRequiredSaveBlocked(page: Page, stage: string): Promise<void> {
  await page.getByRole('button', { name: /保\s*存/ }).last().click();
  const itemHint = page.locator('.ant-form-item:visible, .el-form-item:visible, .form-item:visible')
    .filter({ hasText: /必填|不能为空|请选择|请输入/ }).first();
  let hint: Locator = itemHint;
  if (!(await itemHint.isVisible().catch(() => false))) {
    const form = page.locator('form:visible, .ant-form:visible, .el-form:visible').last();
    if (await form.isVisible().catch(() => false)) {
      hint = form.getByText(/必填|不能为空|请选择|请输入/).first();
    }
  }
  await expect(hint, `${stage}：必填未填全保存应在表单项/表单区域内出现校验提示`)
    .toBeVisible({ timeout: 10_000 });
  await expect(page, `${stage}：被拦截的保存不应离开建表表单`)
    .not.toHaveURL(/#\/dataMap\/tableManage\/tablesManage/);
  const successToast = page.locator(
    '.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible',
  ).filter({ hasText: /成功/ });
  await expect(successToast.first(), `${stage}：被拦截的保存不应出现成功反馈`).not.toBeVisible();
}

test.describe('DM-03-02｜数据地图｜新建表必填项与保存流程', () => {
  test.describe.configure({ timeout: 300_000 });

  test('DM-03-02｜数据地图｜新建表必填项与保存流程（本轮自建表）', async ({ loginPage, consoleErrors, report }, testInfo) => {
    const page = loginPage;
    const tableName = `e2e_dm_newreq_${uuid()}`;
    const chineseName = `新建表必填_${uuid()}`;
    // DS-PERM-67：finally 仅回收本轮表/版本/元数据；物理表在第 4 步才创建，先登记再建。
    const roundTables: string[] = [];
    try {
      // 1. 前置：新建表下拉必须提供配置中心的公共 MySQL 数据源（MYSQL_SOURCE_TEXT）；
      //    缺失按环境前置不足跳过，不伪造通过。
      await openTableManage(page);
      const sourceReady = await openCreateTableEntry(page);
      if (!sourceReady) {
        await report('DM-03-02 新建表必填项与保存流程', false,
          `环境前置缺失：新建表下拉未提供 MySQL 数据源（${MYSQL_SOURCE_TEXT}），无法进入建表表单，跳过。`);
        testInfo.skip();
        return;
      }

      // 2. 必填校验①：全部必填项为空直接“保 存”，应被表单校验拦截。
      await expectRequiredSaveBlocked(page, '全空必填');

      // 3. 必填校验②：仅填表名称再保存（其余必填仍空），同样应被拦截，
      //    区分“逐项必填校验”与“只拦全空表单”的形态。
      await fillFormField(page, /表名称|表名/, tableName);
      await expectRequiredSaveBlocked(page, '仅表名称');

      // 4. 补齐全部必填与数据生命周期 → 语句添加 DDL → 解析 → 补字段中文名 →
      //    “建 表”提交，成功以回到 tablesManage 列表为准（孪生通过轮口径）。
      roundTables.push(tableName);
      await fillAndCreateThisRoundTable(page, tableName, chineseName);

      // 5. 上线终态复核：fillAndCreateThisRoundTable 已完成行内上线（「下线」操作
      //    在位=在线），此处仍在 tablesManage 列表页再读一次行内状态作为最终证据。
      const finalRow = await manageRow(page, tableName);
      expect(await manageRowAction(page, finalRow, /^下\s*线$/), '上线终态：行内应出现「下线」操作').toBeTruthy();

      await assertNoConsoleErrors(consoleErrors);
      await report('DM-03-02 新建表必填项与保存流程（本轮自建表）', true,
        `表=${tableName}；中文名=${chineseName}；必填校验=全空保存被拦截、仅表名称保存被拦截`
          + `（表单项/表单区域内校验提示，非全页匹配）；DDL 解析补字段中文名后“建 表”提交回 tablesManage；`
          + `行内上线完成（下线操作在位）。`);
    } finally {
      // DS-PERM-67：仅回收本轮表/版本/元数据，清理失败只告警、不掩埋用例真实结果。
      await cleanupRoundTables(page, roundTables);
    }
  });
});


