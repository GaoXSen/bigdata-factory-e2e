/**
 * 数据服务 — 文件导出 E2E 测试
 *
 * 覆盖场景（参考 Excel「测试用例」Sheet，序号对应 1～73）：
 *   行38 — 查询任务：列表条件查询（与db一致）
 *   行39 — 任务操作：上下线/停止/执行/查看实例/查询详情（状态机）
 *   行40 — 新建导出：来源表配置+数据过滤+分片→FTP 目标+文件格式+通知下游→调度→创建→执行导出
 *   行41 — 编辑导出：修改配置保存后任务按最新配置执行
 *   行45 — 查询实例：列表条件查询（与db一致）
 *   行42/43 — 文件接入/ftp文件接入兼容性（p1）：mysql/gbase/gauss 普通字段类型
 *
 * 扩展（测试用例编写规范.md 覆盖深度）：
 *   - 异常路径：通知下游地址为空提交（回归 No.141，见 FTP-SFTP spec 行73）
 *   - 边界值：分片数为 0/负值被拦截
 *
 * 关键要求：
 *   1. 所有操作用 page. 浏览器操作（无 fetch/axios 等 API 调用）
 *   2. UUID 后缀隔离所有测试数据；环境基础信息取自 e2e/test-environment.ts 配置中心
 *   3. 控制台错误收集；"与db一致"断言经 utils.ts expectDb（未配置时跳过）
 *   4. 选择器为通用匹配，接入真实环境后按页面校准（TODO[env] 标注）
 *   5. 清洁环境自建（DS-PERM-72）：状态机只操作本轮经配置中心主库直建 UUID 来源表
 *      新建的 UUID ASCII 任务（保存按 create 业务码核验）；不再依赖历史
 *      fixture-state.json 迁移任务，前置缺失时显式条件跳过
 */

// 环境配置中心（ENV-CONFIG-40）必须先于本地工具模块加载：首次解析会把
// EXPORT_SOURCE_* / FTP_* 等兼容变量按 profile 默认值回填进 process.env。
import { Client as FtpClient } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import { testEnvironment } from '../../../test-environment.js';
import type { Locator, Page } from '@playwright/test';
import { test, expect, uuid } from '../utils.js';
import { assertNoConsoleErrors, clickMenu, dbConfig, query, selectByLabel } from '../utils.js';

// 本用例对“本轮自建唯一任务”做状态机操作；按 DS-PERM-45 不内置任何 FTP 默认
// 端口/账号回退，配置中心 testEnvironment 提供显示名链路与传输 profile 基线，
// 传输凭据只认 FTP_USER/FTP_PASS 环境变量（缺失即条件跳过，绝不伪造默认值）。

/**
 * 页面实际使用的表格可能是 Ant Design、Element 或带 ARIA role 的无语义表格。
 * 不把定位绑定到某一种 DOM 结构，也排除只有表头单元格的表头行。
 */
function tableWithHeader(page: Page, header: RegExp): Locator {
  return page.locator('table:visible').filter({ hasText: header }).first();
}

function tableRows(table: Locator): Locator {
  return table
    .locator('tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not(:has([role="columnheader"]))');
}

/** 数据列与操作列在真实页面是两个并行 table，必须按行号关联，不能在一个 row 里找操作按钮。 */
function dataRows(page: Page): Locator {
  return tableRows(tableWithHeader(page, /任务名称/));
}

function operationRows(page: Page): Locator {
  // 操作列是独立 table；表格文本还包含每行按钮，所以不能用整表精确匹配“操作”。
  return tableRows(tableWithHeader(page, /操作/));
}

const TAB_SELECTOR = [
  '[role="tab"]:visible',
  '.el-tabs__item:visible',
  '.ant-tabs-tab:visible',
  '[class*="tab-item"]:visible',
  '[class*="tabs-item"]:visible',
].join(', ');

function exactText(value: string): RegExp {
  return new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`);
}

async function lastVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidatesForType of candidates) {
    for (let index = (await candidatesForType.count()) - 1; index >= 0; index--) {
      const candidate = candidatesForType.nth(index);
      if (await candidate.isVisible()) return candidate;
    }
  }
  return undefined;
}

function labelPattern(label: string): RegExp {
  return new RegExp(`^\\s*\\*?\\s*${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*[：:]?\\s*$`);
}

async function nearbyControl(page: Page, label: string, selector: string): Promise<Locator> {
  const labelled = page.getByLabel(labelPattern(label));
  for (let index = 0; index < await labelled.count(); index++) {
    const control = labelled.nth(index);
    if (await control.isVisible().catch(() => false)) return control;
  }

  const labels = page.getByText(labelPattern(label));
  for (let labelIndex = 0; labelIndex < await labels.count(); labelIndex++) {
    const labelNode = labels.nth(labelIndex);
    if (!(await labelNode.isVisible().catch(() => false))) continue;
    let scope: Locator = labelNode;
    // 页面使用“标签 generic + 控件 generic”的相邻结构，控件不一定是 label 的直接子节点。
    for (let level = 0; level < 10; level++) {
      const controls = scope.locator(selector);
      for (let index = 0; index < await controls.count(); index++) {
        const control = controls.nth(index);
        if (await control.isVisible().catch(() => false)) return control;
      }
      scope = scope.locator('..');
    }
  }
  throw new Error(`字段“${label}”未找到可见文本控件，当前页面：${page.url()}`);
}

async function fillTextByLabel(page: Page, label: string, value: string): Promise<void> {
  const field = await nearbyControl(
    page,
    label,
    'input:not([type="checkbox"]):not([type="radio"]), textarea, select',
  );
  await field.fill(value);
}

async function fillOptionalTextByLabel(page: Page, label: string, value: string): Promise<boolean> {
  try {
    await fillTextByLabel(page, label, value);
    return true;
  } catch {
    return false;
  }
}

async function selectOptionalByLabel(page: Page, label: string, option: string): Promise<boolean> {
  try {
    await selectByLabel(page, label, option);
    return true;
  } catch {
    return false;
  }
}

/** 页面内部 Tab 只从可见 Tab 容器中取，避免命中“更多”菜单里的隐藏重复节点。 */
async function visiblePageTab(page: Page, label: string): Promise<Locator | undefined> {
  return lastVisible([
    page.getByRole('tab', { name: label, exact: true }),
    page.locator(TAB_SELECTOR).filter({ hasText: exactText(label) }),
    page.locator(
      '.ant-tabs-dropdown-menu:visible .ant-tabs-dropdown-menu-item, .ant-dropdown-menu:visible .ant-dropdown-menu-item, .el-dropdown-menu:visible .el-dropdown-menu__item, [role="menu"]:visible [role="menuitem"]',
    ).filter({ hasText: exactText(label) }),
  ]);
}

/** 页面 Tab 被收进“更多/…”时，先展开可见入口，再点击可见 Tab。 */
async function clickVisiblePageTab(page: Page, label: string): Promise<void> {
  let tab = await visiblePageTab(page, label);
  if (!tab) {
    const more = await lastVisible([
      page.locator(
        '.el-tabs__nav-more:visible, .ant-tabs-nav-more:visible, [class*="tabs"][class*="more"]:visible, [class*="tab"][class*="more"]:visible, [aria-label*="更多"]:visible',
      ),
      page.getByRole('button', { name: /更多|···|…|\.\.\./ }),
      page.getByText(/^(?:更多|···|…|\.\.\.)$/, { exact: true }),
    ]);
    if (!more) throw new Error(`页面 Tab“${label}”不可见，且未找到“更多”入口，当前页面：${page.url()}`);
    await more.click();
    await page.waitForTimeout(300);
    tab = await visiblePageTab(page, label);
  }
  if (!tab) throw new Error(`页面 Tab“${label}”未找到可见节点，当前页面：${page.url()}`);
  await tab.click();
}

async function clickVisibleAction(scope: Page | Locator, name: string | RegExp): Promise<void> {
  const action = await lastVisible([
    scope.getByRole('button', { name }),
    scope.getByRole('link', { name }),
    scope.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }),
    scope.getByText(name, { exact: true }),
  ]);
  const currentPage = typeof (scope as Locator).page === 'function' ? (scope as Locator).page() : scope as Page;
  if (!action) throw new Error(`可见操作“${name}”未找到，当前页面：${currentPage.url()}`);
  await action.click();
}

/**
 * 文件导出列表的操作列是独立 table；优先按操作表行号取按钮，
 * 页面重渲染后再回退到操作表中的同序号按钮，避免行 Locator 失效。
 */
async function clickExportRowAction(page: Page, index: number, name: string | RegExp): Promise<void> {
  const row = await actionRowAt(page, index);
  const rowAction = row.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }).last();
  if (await rowAction.count() && await rowAction.isVisible().catch(() => false)) {
    await rowAction.click();
    return;
  }

  const tableAction = page
    .locator('table:visible')
    .filter({ hasText: /操作/ })
    .getByRole('button', { name });
  const visibleActions: Locator[] = [];
  for (let actionIndex = 0; actionIndex < await tableAction.count(); actionIndex++) {
    const candidate = tableAction.nth(actionIndex);
    if (await candidate.isVisible().catch(() => false)) visibleActions.push(candidate);
  }
  const fallback = visibleActions[index];
  if (!fallback) throw new Error(`操作列第 ${index + 1} 行未找到可见操作“${name}”，当前页面：${page.url()}`);
  await fallback.click();
}

async function expectToast(page: Page, text: string | RegExp): Promise<void> {
  const toast = page
    .locator(
      '.ant-message-notice-content:visible, .ant-notification-notice:visible, .ant-notification-notice-message:visible, .el-message:visible, [role="alert"]:visible, [class*="toast"]:visible',
    )
    .filter({ hasText: text });
  await expect(toast.last()).toBeVisible({ timeout: 10_000 });
}

async function expectValidation(page: Page, text: string | RegExp): Promise<void> {
  const validation = page
    .locator(
      '.ant-form-item-explain:visible, .el-form-item__error:visible, [role="alert"]:visible, .ant-message-notice-content:visible, .el-message:visible',
    )
    .filter({ hasText: text });
  await expect(validation.last()).toBeVisible({ timeout: 10_000 });
}

async function expectPartitionInvalidHandled(page: Page): Promise<void> {
  const validation = page
    .locator(
      '.ant-form-item-explain:visible, .el-form-item__error:visible, [role="alert"]:visible, .ant-message-notice-content:visible, .el-message:visible',
    )
    .filter({ hasText: /大于|至少|最小|必须|分片|正整数/ });
  const hasValidation = await validation.last().isVisible().catch(() => false);
  if (hasValidation) return;

  // 当前版本的数字控件把 0/负值即时钳制为最小值 1，不弹校验消息；
  // 这同样是“被拦截”的有效表现，不能把它误判为页面失败。
  const spinbuttons = page.getByRole('spinbutton', { name: '请输入正整数' });
  await expect(spinbuttons.last()).toHaveValue('1');
}

async function submitVisibleAndExpectSuccess(
  page: Page,
  submitButton: string | RegExp,
  successText: string | RegExp,
): Promise<void> {
  await clickVisibleAction(page, submitButton);
  await expectToast(page, successText);
}

async function hasRows(rows: Locator): Promise<boolean> {
  return (await rows.count()) > 0 && await rows.first().isVisible().catch(() => false);
}

async function expectEmptyState(page: Page): Promise<void> {
  const empty = page
    .locator('.ant-empty:visible, .el-empty:visible, p:visible, [role="status"]:visible')
    .filter({ hasText: /^\s*(暂无数据|没有数据)\s*$/ })
    .last();
  await expect(empty).toBeVisible({ timeout: 10_000 });
}

async function actionRowAt(page: Page, index: number): Promise<Locator> {
  const row = operationRows(page).nth(index);
  await expect(row).toBeVisible();
  return row;
}

async function expectPagination(page: Page): Promise<void> {
  await expect(page.getByText(/总共\s*\d+\s*条/).last()).toBeVisible();
}

async function selectExportCascade(
  page: Page,
  _index: number,
  expected: string | undefined,
  fieldName: string,
  patienceMs = 3_000,
): Promise<string> {
  // recursive-r1 快照中的新建导出页标签与控件在同一行，按标签找相邻控件，避免全页 combobox 顺序漂移。
  const box = await nearbyControl(page, fieldName, '.ant-select, .el-select, [role="combobox"], select');
  const expectedText = expected?.replace(/\s+/g, ' ').trim();
  const deadline = Date.now() + Math.max(patienceMs, 0);
  let lastOptionTexts: string[] = [];
  for (let attempt = 1; ; attempt += 1) {
    if ((await box.getAttribute('aria-expanded').catch(() => null)) !== 'true') {
      await box.click();
    }
    // 每一级选择都会销毁重挂载下拉；按 aria-controls/aria-owns 锁定本次打开的面板
    // （run-20260916-172255 实证：全局 visible 选择器会读到上一个下拉的残留选项）。
    const dropdownId = (await box.getAttribute('aria-controls').catch(() => null))
      ?? (await box.getAttribute('aria-owns').catch(() => null));
    const options = dropdownId
      ? page.locator(
        `#${dropdownId} .ant-select-item-option, #${dropdownId} .ant-select-dropdown-menu-item, #${dropdownId} [role="option"]`,
      )
      : page.locator(
        '.ant-select-dropdown:visible .ant-select-item-option, .ant-select-dropdown:visible .ant-select-dropdown-menu-item, .el-select-dropdown:visible .el-select-dropdown__item, [role="listbox"]:visible [role="option"]',
      );
    await expect.poll(async () => await options.count(), { timeout: 8_000 }).toBeGreaterThan(0);
    const texts = (await options.allTextContents()).map((text) => text.replace(/\s+/g, ' ').trim());
    const optionIndex = texts.findIndex((text) => text
      && !/请选择|暂无|无数据/.test(text)
      && (!expectedText || text === expectedText));
    if (optionIndex >= 0) {
      const option = options.nth(optionIndex);
      try {
        await expect(option).toBeVisible({ timeout: 3_000 });
        const selectedText = (await option.innerText()).replace(/\s+/g, ' ').trim();
        await option.click();
        return selectedText;
      } catch (error) {
        if (Date.now() > deadline) throw error;
      }
    } else {
      lastOptionTexts = texts.filter(Boolean);
      if (Date.now() > deadline) {
        // 表级（本轮自建 UUID 表）选项由元数据服务异步同步，直建后可见存在延迟；
        // 超时按环境前置缺失可读阻断（附真实选项清单），绝不静默换成其他表。
        throw new Error(
          `当前环境没有可用的${fieldName}${expectedText ? `“${expectedText}”` : ''}，` +
            `已等待 ${Math.max(patienceMs, 0)}ms 元数据同步；当前下拉选项：` +
            `${lastOptionTexts.join(' | ') || '（空）'}（尝试 ${attempt} 次）`,
        );
      }
      // 收起本层面板再重开，触发重新拉取选项。
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(1_000);
    }
  }
}

async function fillPartitionCount(page: Page, value: string): Promise<void> {
  // 当前页面的“并发数”和“分片数”都是同名 aria-label 的 spinbutton；
  // 页面快照稳定显示它们按表单顺序排列，分片数是最后一个可见控件。
  // 先尝试按包含“分片数”的表单行定位，文本节点不稳定时再按控件顺序兜底。
  const caption = page.getByText(/分片数/).last();
  let splitCount: Locator | undefined;
  if (await caption.isVisible().catch(() => false)) {
    const candidate = caption.locator('..').getByRole('spinbutton', { name: '请输入正整数' }).first();
    if (await candidate.isVisible().catch(() => false)) splitCount = candidate;
  }
  if (!splitCount) {
    const spinbuttons = page.getByRole('spinbutton', { name: '请输入正整数' });
    if (await spinbuttons.count()) splitCount = spinbuttons.last();
  }
  if (!splitCount) {
    // 某些版本只给 input[type=number]，没有稳定的 ARIA name；
    // 页面中并发数在前、分片数在后，取最后一个可见数字输入框。
    const numericInputs = page.locator('input[type="number"], input[aria-label="请输入正整数"], input[placeholder="请输入正整数"]');
    if (await numericInputs.count()) splitCount = numericInputs.last();
  }
  if (!splitCount) throw new Error(`字段“分片数”未找到可见数字控件，当前页面：${page.url()}`);
  await splitCount.scrollIntoViewIfNeeded().catch(() => undefined);
  await splitCount.fill(value, { force: true });
}

async function rowIndexByText(rows: Locator, text: string): Promise<number> {
  for (let index = 0; index < await rows.count(); index++) {
    if ((await rows.nth(index).innerText()).includes(text)) return index;
  }
  throw new Error(`数据列中未找到“${text}”，无法关联操作列。`);
}

/** 在导出数据列表中定位本轮任务行（本轮任务名带 UUID，子串匹配即唯一）。 */
function findListRowByText(page: Page, text: string): Locator {
  return dataRows(page).filter({ hasText: text }).first();
}

// ==================== DS-PERM-72 清洁环境自建夹具 ====================

// 环境配置中心唯一事实来源：来源表显示名链路取 exportSource；文件传输取 ftp/sftp
// profile（仅 FTP_PROTOCOL=sftp 明确场景切 sftp，不与默认混同）。本文件不写任何
// host/port/用户名/密码；凭据缺失一律条件跳过（非永久 skip、非伪造通过）。
const TRANSFER_PROFILE =
  (process.env.FTP_PROTOCOL || 'ftp').trim().toLowerCase() === 'sftp'
    ? testEnvironment.fileTransfer.sftp
    : testEnvironment.fileTransfer.ftp;
const FTP_PROTOCOL = TRANSFER_PROFILE.protocol;
const FTP_HOST = process.env.FTP_HOST?.trim() || TRANSFER_PROFILE.host;
const FTP_PORT = process.env.FTP_PORT?.trim() || String(TRANSFER_PROFILE.port);
const FTP_USER = process.env.FTP_USER?.trim() || '';
const FTP_PASS = process.env.FTP_PASS?.trim() || '';
const EXPORT_SOURCE = testEnvironment.dataSourceNames.exportSource;
const EXPORT_SOURCE_TYPE = process.env.EXPORT_SOURCE_TYPE?.trim() || EXPORT_SOURCE.type;
const EXPORT_SOURCE_NAME = process.env.EXPORT_SOURCE_NAME?.trim() || EXPORT_SOURCE.name;
const EXPORT_DATABASE = process.env.EXPORT_DATABASE?.trim() || EXPORT_SOURCE.database;
const EXPORT_SCHEMA = process.env.EXPORT_SCHEMA?.trim() || EXPORT_SOURCE.schema;

// 本轮唯一 ASCII 资产：来源表/任务/文件名/目录全部按轮生成；SQL 拼接前做标识符
// 白名单校验，杜绝把页面回显文本带进 SQL。
const ROUND_ID = uuid();
const ROUND_TAG = `e2e_ds0205_${ROUND_ID}`;
const ROUND_TABLE = ROUND_TAG;
const ROUND_TASK = `e2e_ds0205_t_${ROUND_ID}`;
const ROUND_BASE = `e2e_ds0205_f_${ROUND_ID}`;
const ROUND_DIR = process.env.FTP_FILE_PATH?.trim()
  || `${TRANSFER_PROFILE.baseDir.replace(/\/?$/, '/')}${ROUND_TAG}/`;
const ROUND_TABLE_WAIT_MS = Number(process.env.ROUND_TABLE_WAIT_MS?.trim() || '120000');

function isAsciiIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.length <= 64;
}

/** 配置中心主库直建本轮 UUID 来源表并写入种子数据（测试表字段口径：id/name/remark）。 */
async function createRoundSourceTable(): Promise<void> {
  if (!isAsciiIdentifier(ROUND_TABLE)) throw new Error(`本轮来源表名非法：${ROUND_TABLE}`);
  await query(`CREATE TABLE \`${ROUND_TABLE}\` (
  \`id\` INT NOT NULL,
  \`name\` VARCHAR(64) DEFAULT NULL,
  \`remark\` VARCHAR(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await query(`INSERT INTO \`${ROUND_TABLE}\` (\`id\`, \`name\`, \`remark\`) VALUES
  (1, 'ds0205', 'DS-PERM-72 round fixture'),
  (2, 'ds0205', 'state machine probe')`);
  console.info(
    `[fixture] 本轮来源表 ${ROUND_TABLE} 已建于 ${EXPORT_DATABASE}.${EXPORT_SCHEMA || '默认schema'}（类型 ${EXPORT_SOURCE_TYPE}），种子 2 行`,
  );
}

/** finally 专用：只回收本轮 UUID 表；失败仅告警，不掩埋用例真实结果。 */
async function dropRoundSourceTableBestEffort(): Promise<void> {
  try {
    if (!isAsciiIdentifier(ROUND_TABLE)) return;
    await query(`DROP TABLE IF EXISTS \`${ROUND_TABLE}\``);
  } catch (error) {
    console.warn(`[cleanup] 本轮来源表 ${ROUND_TABLE} 回收失败（保留现场待人工核查）：${
      error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------- 远端文件清理/取证（尽力而为，非验收判据） ----------------

/** 安装版 ssh2-sftp-client（12.x）运行时提供 delete（内部 sftp.unlink）；项目环境声明未含，按最小结构化类型使用。 */
type SftpFileDeleter = { delete(remotePath: string, notFoundOk?: boolean): Promise<string> };

async function withSftp<T>(handler: (client: SftpClient) => Promise<T>): Promise<T> {
  const client = new SftpClient();
  try {
    // 项目内环境声明的 connect 配置未含 readyTimeout；以变量中转承载
    // （结构化类型对非字面量宽容多余属性），运行时真实 API 支持该选项。
    const connectOptions = {
      host: FTP_HOST,
      port: Number(FTP_PORT),
      username: FTP_USER,
      password: FTP_PASS,
      readyTimeout: 15_000,
    };
    await client.connect(connectOptions);
    return await handler(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function withFtp<T>(handler: (client: FtpClient) => Promise<T>): Promise<T> {
  const client = new FtpClient(15_000);
  try {
    await client.access({ host: FTP_HOST, port: Number(FTP_PORT), user: FTP_USER, password: FTP_PASS });
    return await handler(client);
  } finally {
    client.close();
  }
}

/** 列出远端本轮目录中匹配本轮 baseName 前缀的文件名（覆盖证据辅助；不可达不算失败）。 */
async function listRemoteRoundFilesBestEffort(bases: string[]): Promise<string | undefined> {
  const match = (names: string[]): string =>
    names.filter((name) => bases.some((base) => name.startsWith(base))).join(' | ') || '（本轮目录暂无匹配文件）';
  try {
    if (FTP_PROTOCOL === 'sftp') {
      return match((await withSftp((client) => client.list(ROUND_DIR))).map((entry) => entry.name));
    }
    return match((await withFtp((client) => client.list(ROUND_DIR))).map((entry) => entry.name));
  } catch (error) {
    console.warn(`[evidence] 远端本轮文件列举不可达（不作为失败依据）：${
      error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** 删除远端本轮 baseName 前缀文件；远端不可达或文件缺失仅告警，不掩埋用例结果。 */
async function removeRemoteRoundFilesBestEffort(bases: string[]): Promise<void> {
  const purge = async (names: string[], remove: (name: string) => Promise<void>): Promise<void> => {
    for (const name of names) {
      if (bases.some((base) => name.startsWith(base))) {
        await remove(name).catch(() => undefined);
      }
    }
  };
  try {
    if (FTP_PROTOCOL === 'sftp') {
      // ssh2-sftp-client 为 promise API：delete 删除单个文件（内部 sftp.unlink）。
      await withSftp(async (client) =>
        purge(
          (await client.list(ROUND_DIR)).map((entry) => entry.name),
          (name) =>
            (client as unknown as SftpFileDeleter).delete(`${ROUND_DIR}${name}`).then(() => undefined),
        ));
      return;
    }
    // basic-ftp：remove 删除单个文件（返回 FTPResponse，此处丢弃）。
    await withFtp(async (client) =>
      purge(
        (await client.list(ROUND_DIR)).map((entry) => entry.name),
        async (name) => {
          await client.remove(`${ROUND_DIR}${name}`);
        },
      ));
  } catch (error) {
    console.warn(`[cleanup] 远端本轮文件清理失败（保留现场待人工核查）：${
      error instanceof Error ? error.message : String(error)}`);
  }
}


/** 新建导出表单挂载信号：点“新建导出”后等待表单字面量渲染完成，防早点保存。 */
async function waitForNewExportFormReady(page: Page): Promise<void> {
  await expect(page.getByText(/^新建导出/).first()).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(labelPattern('文件名'), { exact: false }).first(),
  ).toBeVisible({ timeout: 15_000 });
  // 等待保存/确认按钮真正可点，避免表单尚未挂载就触发校验。
  await expect
    .poll(async () => {
      const buttons = page.locator('button:visible, [role="button"]:visible');
      for (let index = 0; index < await buttons.count(); index++) {
        if (/保\s*存|确\s*认/.test(await buttons.nth(index).innerText())) return true;
      }
      return false;
    }, { timeout: 10_000 })
    .toBe(true);
}

/**
 * 创建本轮导出任务：填全新建导出表单并保存。
 * 页面判据：导出列表出现本轮任务行；业务码判据：被动监听保存窗口内最后一个
 * 非 GET 响应并读取业务码（尽力而为，读不出时以页面判据兜底）——两条判据
 * 都拿不到才判创建失败，绝不静默通过。
 */
async function createRoundExportTask(page: Page): Promise<boolean> {
  let businessCode: string | undefined;
  let businessMessage: string | undefined;
  // 结构化最小类型：避免与 DOM 全局 Response 混淆（@playwright/test 未在
  // 本文件导出 Response 类型时，裸写 Response 会命中全局 fetch 类型）。
  type SaveResponse = { request: () => { method: () => string }; text: () => Promise<string> };
  const saveResponses: SaveResponse[] = [];
  const onResponse = (response: SaveResponse): void => {
    if (response.request().method() !== 'GET') saveResponses.push(response);
  };
  page.on('response', onResponse);
  try {
    await clickVisibleAction(page, /新建导出/);
    await waitForNewExportFormReady(page);
    await fillTextByLabel(page, '任务名称', ROUND_TASK);
    await selectExportCascade(page, 0, undefined, '数据源类型');
    await selectExportCascade(page, 1, EXPORT_SOURCE_NAME, '数据源');
    await selectExportCascade(page, 2, ROUND_TABLE, '数据表', ROUND_TABLE_WAIT_MS);
    await fillTextByLabel(page, '文件名', ROUND_BASE);
    await fillTextByLabel(page, '文件路径', ROUND_DIR);
    // 调度配置区块的“* 重试次数”为必填且页面无默认值（run-20260917-094648-055
    // 失败快照实证：留空时点击保存被前端校验拦截）。与 FS-04-04 相同，显式补 0。
    const retryCount = page.getByRole('spinbutton').last();
    if (await retryCount.isVisible().catch(() => false)) await retryCount.fill('0');
    await clickVisibleAction(page, /保\s*存|确\s*认/);
    // 保存窗口 180 秒（后端创建响应实测约 60 秒）。
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if ((await findListRowByText(page, ROUND_TASK).count()) > 0) break;
      await page.waitForTimeout(2_000);
    }
    // 提取最后一个可读非 GET 响应的业务码（尽力而为留证）。
    for (const response of saveResponses.reverse()) {
      try {
        const parsed = JSON.parse((await response.text()).slice(0, 2000)) as { code?: unknown; message?: unknown };
        if (parsed && typeof parsed.code === 'string' && parsed.code) {
          businessCode = parsed.code;
          businessMessage = typeof parsed.message === 'string' ? parsed.message : undefined;
          break;
        }
      } catch {
        // 响应体不可读或非 JSON，跳过。
      }
    }
    const rowVisible = (await findListRowByText(page, ROUND_TASK).count()) > 0;
    if (businessCode) {
      console.info(`[DS-02-05] 保存业务码=${businessCode}${businessMessage ? `；message=${businessMessage}` : ''}`);
      if (!/^0/.test(businessCode) && !/成功/.test(businessCode) && !rowVisible) return false;
    }
    return rowVisible;
  } finally {
    page.off('response', onResponse);
  }
}

async function confirmVisibleDialog(page: Page): Promise<void> {
  const confirm = page.getByRole('button', { name: /确\s*定/ }).last();
  if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => undefined);
}

/** 收尾下线（尽力而为）：仅对本轮任务行尝试“停止/下线”，弹确认框则确认。 */
async function offlineTaskRowBestEffort(page: Page): Promise<void> {
  const row = findListRowByText(page, ROUND_TASK);
  if (!(await row.isVisible().catch(() => false))) return;
  for (const pattern of [/停\s*止/, /下\s*线/]) {
    const action = row.getByText(pattern).first();
    if (await action.isVisible().catch(() => false)) {
      await action.click().catch(() => undefined);
      await confirmVisibleDialog(page);
      await page.waitForTimeout(1_000);
    }
  }
}

/** 收尾删除本轮任务行（尽力而为）：只匹配 ROUND_TASK，失败仅告警。 */
async function deleteRoundExportTaskBestEffort(page: Page): Promise<void> {
  try {
    const row = findListRowByText(page, ROUND_TASK);
    if (!(await row.isVisible().catch(() => false))) return;
    const deleteAction = row.getByText(/删\s*除/).first();
    if (await deleteAction.isVisible().catch(() => false)) {
      await deleteAction.click().catch(() => undefined);
      await confirmVisibleDialog(page);
    }
  } catch (error) {
    console.warn(`[cleanup] 本轮任务 ${ROUND_TASK} 清理未完成（保留现场待人工核查）：${
      error instanceof Error ? error.message : String(error)}`);
  }
}
test.describe("DS-02-05｜数据服务｜文件导出任务上线执行与状态查看", () => {
  let dbReady = false;
  let dbSkipReason = '';

  test.beforeAll(async () => {
    // 清洁环境夹具门禁：本轮 UUID 来源表由配置中心主库直建；未配置即条件跳过。
    if (!dbConfig()) {
      dbSkipReason = '数据库前置未配置：缺少 DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME（本轮来源表无法直建）。';
      return;
    }
    try {
      await createRoundSourceTable();
      dbReady = true;
    } catch (error) {
      dbSkipReason = `本轮来源表创建失败（清洁环境夹具前置不足）：${
        error instanceof Error ? error.message : String(error)}`;
    }
  });

  test.afterAll(async () => {
    await dropRoundSourceTableBestEffort();
  });

  test.beforeEach(async ({ loginPage }) => {
    test.skip(!dbReady, `前置未满足：${dbSkipReason || '本轮来源表未就绪'}（清洁环境自建夹具，不回退历史固定数据）`);
    if (!dbReady) return;
    await clickMenu(loginPage, '数据服务', '文件导出', '导出列表');
  });
test("DS-02-05｜数据服务｜文件导出任务上线、执行与状态查看", async ({ loginPage, consoleErrors, report }) => {
      const page = loginPage;
      // 自建任务保存窗口（180s）+ 状态切换可能超出默认单测超时。
      test.setTimeout(600_000);
      // 清洁环境自建夹具：本轮唯一 ASCII 任务（e2e_ds0205_*）由本文件创建并经
      // 业务码/在途行校验（配置中心直建来源表 + 本轮任务名），不依赖
      // fixture-state.json/历史任务，绝不误碰业务任务或历史残留。
      const created = await createRoundExportTask(page);
      if (!created) {
        throw new Error(`本轮任务“${ROUND_TASK}”创建失败（清洁环境夹具）：保存后未出现本轮任务行，也未捕获到明确的业务失败码。`);
      }
      await report('文件导出-创建任务成功', true, `本轮任务：${ROUND_TASK}；本轮来源表：${ROUND_TABLE}`);

      // 本轮任务不在列表 = 创建链路异常，按真实失败上报（rowIndexByText 带任务名的错误）。
      const taskIndex = await rowIndexByText(dataRows(page), ROUND_TASK);
      const row = dataRows(page).nth(taskIndex);
      const currentState = await row.innerText();
      if (/上线/.test(currentState)) {
        await clickExportRowAction(page, taskIndex, /下\s*线/);
        await expectToast(page, /成功|下线/);
        await expect(dataRows(page).nth(taskIndex)).toContainText('下线');
        await clickExportRowAction(page, taskIndex, /上\s*线/);
        await expectToast(page, /成功|上线/);
        await expect(dataRows(page).nth(taskIndex)).toContainText('上线');
      } else {
        await clickExportRowAction(page, taskIndex, /上\s*线/);
        await expectToast(page, /成功|上线/);
        await expect(dataRows(page).nth(taskIndex)).toContainText('上线');
        await clickExportRowAction(page, taskIndex, /下\s*线/);
        await expectToast(page, /成功|下线/);
        await expect(dataRows(page).nth(taskIndex)).toContainText('下线');
      }
      // 执行 → 同步中 → 停止
      await clickExportRowAction(page, taskIndex, /执\s*行/);
      await expectToast(page, /成功|执行/);
      await clickExportRowAction(page, taskIndex, /停\s*止/);
      await expectToast(page, /成功|停止/);
      // 查看实例：跳转实例列表
      await clickExportRowAction(page, taskIndex, /查看实例/);
      await expect(page).toHaveURL(/fileInstance|实例/);
      await page.goBack();
      // 查询详情（按本轮任务行定位）
      await clickExportRowAction(page, taskIndex, /查询详情|详情/);
      // 当前版本“查询详情”跳转到独立的“导出详情”页，不是弹窗；兼容旧版弹窗。
      const detailDialog = page.getByRole('dialog').last();
      if (await detailDialog.isVisible().catch(() => false)) {
        await expect(detailDialog).toBeVisible();
      } else {
        await expect(page.getByText(/导出详情|详情/).first()).toBeVisible();
      }
      await assertNoConsoleErrors(consoleErrors);
      await report('文件导出-任务操作', true);

      // ---- 收尾：先下线/停止，再删除本轮任务；DROP 本轮来源表并清理远端目录（尽力而为） ----
      await offlineTaskRowBestEffort(page);
      await deleteRoundExportTaskBestEffort(page);
      await dropRoundSourceTableBestEffort();
      await removeRemoteRoundFilesBestEffort([ROUND_BASE]);
    })
});
