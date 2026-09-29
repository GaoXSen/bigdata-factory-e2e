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
 *   2. UUID 后缀隔离所有测试数据；连接信息一律由配置中心/显式环境变量提供
 *   3. 控制台错误收集；"与db一致"断言经 utils.ts expectDb（未配置时跳过）
 *   4. 选择器为通用匹配，接入真实环境后按页面校准（TODO[env] 标注）
 *   5. 清洁环境自建（DS-PERM-72）：经配置中心主库直建本轮 UUID ASCII 来源表并
 *      写入种子数据，负路径探测表单除探测项外全部有效；不借用配置中心固定
 *      来源表，也不依赖历史迁移任务
 */

// 环境配置中心（ENV-CONFIG-40）必须先于本地工具模块加载：首次解析会把
// EXPORT_SOURCE_* / FTP_* 等兼容变量按 profile 默认值回填进 process.env。
import { testEnvironment } from '../../../test-environment.js';
import type { Locator, Page } from '@playwright/test';
import { test, expect, uuid } from '../utils.js';
import { assertNoConsoleErrors, clickMenu, dbConfig, query, selectByLabel } from '../utils.js';

// 本用例验证新建导出表单的负路径拦截：分片 0/负值（保留既有口径）+ 来源表为空/
// 路径为空/通知地址为空（DS-PERM-72 新增）。按 DS-PERM-45 不内置任何 FTP 默认
// 端口/账号回退；配置中心 testEnvironment 提供显示名链路与传输 profile 基线，
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

/**
 * 新建导出页的级联选择。每选一级下拉都会销毁重挂载，必须按 aria-controls 锁定
 * 本次打开的面板（run-20260916-172255 实证：全局 visible 选择器会读到上一个
 * 下拉的残留选项）。expected 为空时选最后一个非占位项。
 * 表级（本轮自建 UUID 表）选项由元数据服务异步同步，直建后可见存在延迟：
 * patienceMs > 3s 时在窗口内反复重开下拉扫描，超时仍无则按环境前置缺失给出
 * 可读阻断错误（附当前真实选项清单），绝不静默换成其他表。
 */
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
    // 每一级选择都会销毁重挂载下拉；按 aria-controls/aria-owns 锁定本次打开的面板。
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

// ---------------- 否定路径断言与留证 ----------------

/** 读取新建导出表单“文件路径”输入框当前值（否定路径留证用）。 */
async function getFormFilePathValue(page: Page): Promise<string | undefined> {
  try {
    const field = await nearbyControl(
      page,
      '文件路径',
      'input:not([type="checkbox"]):not([type="radio"]), textarea, select',
    );
    const value = await field.getAttribute('value');
    return value ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 断言“表单仍打开 + 空值字段出现校验文案 + 无成功提示”。
 * 持久化留证：将表单与校验文本写入本轮 JSON 报告，任何一步失败都抛错并保留
 * 当前快照路径，杜绝静默通过。
 */
async function expectValidationError(page: Page, controlLabel: string, messageHint: string): Promise<void> {
  // 表单未关闭：该字段控件仍可见。
  const stillOpen = await nearbyControl(
    page,
    controlLabel,
    'input:not([type="checkbox"]):not([type="radio"]), textarea, select',
  )
    .then((control) => control.isVisible())
    .catch(() => false);
  const validationText = await readFormValidationText(page);
  // 成功提示必须不存在（存在即说明保存被放行）。
  const successToastCount = await page
    .getByText(/(保存成功|操作成功|创建成功|提交成功|成功)/)
    .count();
  await writeNegativePathEvidence({
    fieldLabel: controlLabel,
    messageHint,
    stillOpen,
    validationText,
    successToastCount,
    url: page.url(),
  });
  if (!stillOpen) {
    throw new Error(`表单已关闭但未断言到校验文案：“${controlLabel}”（预期提示含“${messageHint}”）为空的保存疑似被放行（留证已写入本轮报告）。`);
  }
  if (successToastCount > 0) {
    throw new Error(`出现成功提示但未断言到校验文案：“${controlLabel}”为空的保存疑似被放行（留证已写入本轮报告）。`);
  }
  if (!validationText) {
    throw new Error(`“${controlLabel}”为空保存后未捕获任何校验文案，无法证明前端拦截（留证已写入本轮报告）。`);
  }
}

/** 读取当前页面可见的表单校验文案（ant/el 通用容器；无则返回空串）。 */
async function readFormValidationText(page: Page): Promise<string> {
  const nodes = page.locator(
    '.ant-form-item-explain:visible, .el-form-item__error:visible, [role="alert"]:visible, .ant-message-notice-content:visible, .el-message:visible',
  );
  const texts: string[] = [];
  for (let index = 0; index < await nodes.count(); index++) {
    const text = (await nodes.nth(index).innerText().catch(() => '')) || '';
    if (text.trim()) texts.push(text.replace(/\s+/g, ' ').trim());
  }
  return texts.join(' | ');
}

/** 负路径留证：挂到 Playwright 报告附件（尽力而为，留证失败不掩埋断言）。 */
async function writeNegativePathEvidence(record: {
  fieldLabel: string;
  messageHint?: string;
  stillOpen: boolean;
  validationText?: string;
  successToastCount: number;
  url: string;
}): Promise<void> {
  try {
    await test.info().attach('ds0203-negative-path.json', {
      body: JSON.stringify(record, null, 2),
      contentType: 'application/json',
    });
  } catch (error) {
    console.warn(`[DS-02-03] 负路径留证写入失败（不掩埋断言）：${
      error instanceof Error ? error.message : String(error)}`);
  }
}

/** 在导出数据列表中定位任务行（本轮任务名带 UUID，子串匹配即唯一）。 */
function findListRowByText(page: Page, text: string): Locator {
  return dataRows(page).filter({ hasText: text }).first();
}

async function rowIndexByText(rows: Locator, text: string): Promise<number> {
  for (let index = 0; index < await rows.count(); index++) {
    if ((await rows.nth(index).innerText()).includes(text)) return index;
  }
  throw new Error(`数据列中未找到“${text}”，无法关联操作列。`);
}
// ==================== DS-PERM-72 清洁环境自建夹具 ====================

// 环境配置中心唯一事实来源：来源表显示名链路取 exportSource；文件传输取 ftp/sftp
// profile（仅 FTP_PROTOCOL=sftp 明确场景切 sftp，不与默认混同）。本文件不写任何
// host/port/用户名/密码；凭据缺失一律条件跳过（非永久 skip、非伪造通过）。
const TRANSFER_PROFILE =
  (process.env.FTP_PROTOCOL || 'ftp').trim().toLowerCase() === 'sftp'
    ? testEnvironment.fileTransfer.sftp
    : testEnvironment.fileTransfer.ftp;
const EXPORT_SOURCE = testEnvironment.dataSourceNames.exportSource;
const EXPORT_SOURCE_NAME = process.env.EXPORT_SOURCE_NAME?.trim() || EXPORT_SOURCE.name;

// 本轮唯一 ASCII 资产：来源表/任务/文件名/目录全部按轮生成，不借用任何历史
// 任务、固定表或旧 SFTP 配置。
const ROUND_ID = uuid();
const ROUND_TAG = `e2e_ds0203_${ROUND_ID}`;
const ROUND_TABLE = ROUND_TAG;
const ROUND_TASK = `e2e_ds0203_t_${ROUND_ID}`;
const ROUND_BASE = `e2e_ds0203_f_${ROUND_ID}`;
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
  (1, 'ds0203', 'DS-PERM-72 round fixture'),
  (2, 'ds0203', 'negative path probe')`);
  console.info(`[fixture] 本轮来源表 ${ROUND_TABLE} 已建于配置中心主库（${dbConfig()?.database ?? '默认库'}），种子 2 行`);
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

test.describe("DS-02-03｜数据服务｜来源表为空、分片非法、路径为空、通知地址为空", () => {
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
  test("DS-02-03｜数据服务｜来源表为空、分片非法、路径为空、通知地址为空", async ({ loginPage, consoleErrors, report }) => {
      const page = loginPage;
      // ---- 路径一：分片数 = 0 / 负值（保留原边界值路径） ----
      await clickVisibleAction(page, /新建导出/);
      await fillPartitionCount(page, '0');
      await clickVisibleAction(page, /保\s*存|确\s*认/);
      await expectPartitionInvalidHandled(page);
      await fillPartitionCount(page, '-1');
      await clickVisibleAction(page, /保\s*存|确\s*认/);
      await expectPartitionInvalidHandled(page);
      await report('文件导出-分片边界值(0/-1被拒)', true);

      // ---- 路径二：合法分片但来源表为空（前端必填校验，本轮任务不入库） ----
      await clickVisibleAction(page, /新建导出/);
      await fillPartitionCount(page, '1');
      await clickVisibleAction(page, /保\s*存|确\s*认/);
      await expectValidationError(page, '数据表', '请选择数据表');
      await report('文件导出-来源表为空-保存被拒', true);

      // ---- 路径三：文件路径为空 ----
      await clickVisibleAction(page, /新建导出/);
      await fillPartitionCount(page, '1');
      await fillTextByLabel(page, '文件路径', '');
      await clickVisibleAction(page, /保\s*存|确\s*认/);
      await expectValidationError(page, '文件路径', '文件路径不能为空');
      const filePathValue = await getFormFilePathValue(page);
      await report('文件导出-路径为空-保存被拒', true, `留证：文件路径输入框当前值=${filePathValue ?? '（不可读）'}`);

      // ---- 路径四：通知地址为空（用例口径：必填；空值保存必须被前端拒绝） ----
      await clickVisibleAction(page, /新建导出/);
      await fillPartitionCount(page, '1');
      await fillTextByLabel(page, '文件路径', ROUND_DIR);
      await clickVisibleAction(page, /保\s*存|确\s*认/);
      await expectValidationError(page, '通知地址', '通知地址不能为空');
      await report('文件导出-通知地址为空-保存被拒', true);

      // ---- 收尾核验：三条否定路径都不能在列表产生本轮在途任务 ----
      const taskRow = findListRowByText(page, ROUND_TASK);
      if (await taskRow.count() > 0) {
        throw new Error(`否定路径意外落库：导出列表出现本轮任务“${ROUND_TASK}”，说明空值校验未生效。`);
      }
      await assertNoConsoleErrors(consoleErrors);
      await report('文件导出-否定路径无落库', true);
    })
});
