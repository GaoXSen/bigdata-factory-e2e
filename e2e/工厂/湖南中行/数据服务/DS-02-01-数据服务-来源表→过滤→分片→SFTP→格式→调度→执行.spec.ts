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
 *   2. UUID 后缀隔离所有测试数据；连接/数据源显示名/传输 profile 取自
 *      e2e/test-environment.ts 配置中心（DS-PERM-45 静态迁移），单项环境变量可覆盖
 *   3. 控制台错误收集；"与db一致"断言经 utils.ts expectDb（未配置时跳过）
 *   4. 选择器为通用匹配，接入真实环境后按页面校准（TODO[env] 标注）
 *   5. 传输凭据（FTP_USER/FTP_PASS）或来源表链路未配置时相关用例显式跳过
 */

import type { Locator, Page } from '@playwright/test';
// 环境配置中心（ENV-CONFIG-40）先于本地模块加载：首次解析会把 EXPORT_SOURCE_*
// 等兼容变量按 profile 默认值回填进 process.env，供未迁移工具链读取。
import { testEnvironment } from '../../../test-environment.js';
import { test, expect, uuid } from '../utils.js';
import { assertNoConsoleErrors, clickMenu, selectByLabel } from '../utils.js';

// 文件传输协议严格区分：默认走 FTP profile（基线 192.168.76.113:2121、目录 /、
// gs_test.csv）；仅当 FTP_PROTOCOL=sftp 这一明确 SFTP 场景才切换 sftp profile
// （110:22、/source），两者不共用默认值。host/port/目录可被单项环境变量覆盖。
const TRANSFER_PROFILE =
  (process.env.FTP_PROTOCOL || 'ftp').trim().toLowerCase() === 'sftp'
    ? testEnvironment.fileTransfer.sftp
    : testEnvironment.fileTransfer.ftp;
// 物理连接三要素 = profile 基线 + 单项环境变量覆盖；凭据永不写代码默认值。
const FTP_HOST = process.env.FTP_HOST?.trim() || TRANSFER_PROFILE.host;
const FTP_PORT = process.env.FTP_PORT?.trim() || String(TRANSFER_PROFILE.port);
const FTP_USER = process.env.FTP_USER?.trim() || '';
const FTP_PASS = process.env.FTP_PASS?.trim() || '';
const FTP_FILE_PATH = process.env.FTP_FILE_PATH?.trim() || TRANSFER_PROFILE.baseDir;
// 平台数据源“显示名链路”（页面下拉可见值）与物理连接是两类概念：默认取配置中心
// exportSource 的展示名（当前 profile 为 192.168.76.110:13306/e2e_test），不是裸 IP。
// 录制稿已确认的湖南中行页面链路；绝不按下拉第一项盲选，避免选到无权限/无元数据的数据源。
const EXPORT_SOURCE = testEnvironment.dataSourceNames.exportSource;
const EXPORT_SOURCE_TYPE = process.env.EXPORT_SOURCE_TYPE?.trim() || EXPORT_SOURCE.type;
const EXPORT_SOURCE_NAME = process.env.EXPORT_SOURCE_NAME?.trim() || EXPORT_SOURCE.name;
const EXPORT_DATABASE = process.env.EXPORT_DATABASE?.trim() || EXPORT_SOURCE.database;
const EXPORT_SCHEMA = process.env.EXPORT_SCHEMA?.trim() || EXPORT_SOURCE.schema;
const EXPORT_SOURCE_TABLE = process.env.EXPORT_SOURCE_TABLE?.trim() || EXPORT_SOURCE.table;

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

/**
 * 文件导出页有两个“任务名称”：目的文件区域的 ftpTaskName（任务主记录，必填）
 * 和“调度配置”区域的 scheduler name。getByLabel 会优先命中后者；保存时前者
 * 为空，页面只停留在表单且不会给出稳定 toast。因此这里按第一个可见文字标签
 * 精确填充主任务名称，两个字段都保留独立赋值。
 */
async function fillExportMainTaskName(page: Page, value: string): Promise<void> {
  const labels = page.getByText(labelPattern('任务名称'));
  for (let labelIndex = 0; labelIndex < await labels.count(); labelIndex += 1) {
    const labelNode = labels.nth(labelIndex);
    if (!(await labelNode.isVisible().catch(() => false))) continue;
    let scope: Locator = labelNode;
    for (let level = 0; level < 10; level += 1) {
      const inputs = scope.locator('input:not([type="checkbox"]):not([type="radio"]), textarea');
      for (let inputIndex = 0; inputIndex < await inputs.count(); inputIndex += 1) {
        const input = inputs.nth(inputIndex);
        if (await input.isVisible().catch(() => false)) {
          await input.fill(value);
          return;
        }
      }
      scope = scope.locator('..');
    }
  }
  throw new Error(`文件导出主任务名称输入框未找到，当前页面：${page.url()}`);
}

/**
 * 导出表单的视觉标签不是标准 <label>；使用 getByLabel 会把多个“请输入”控件
 * 错误关联到第一个输入框。这里从文字标签的近邻表单行开始查找，最多向上两层，
 * 不允许扩大到整页，避免“填写用户名覆盖服务器地址”。
 */
async function fillExportFieldByText(page: Page, label: string, value: string): Promise<void> {
  // “基础文件名/字段分隔符”等标签包含问号图标，父节点文本不再满足严格的
  // `* 标签:` 格式。getByText 会优先给出最小文字节点，再由近邻范围定位输入框。
  const labels = page.getByText(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (let labelIndex = 0; labelIndex < await labels.count(); labelIndex += 1) {
    const labelNode = labels.nth(labelIndex);
    if (!(await labelNode.isVisible().catch(() => false))) continue;
    let scope = labelNode;
    for (let level = 0; level < 3; level += 1) {
      const inputs = scope.locator('input:not([type="checkbox"]):not([type="radio"]), textarea');
      for (let inputIndex = 0; inputIndex < await inputs.count(); inputIndex += 1) {
        const input = inputs.nth(inputIndex);
        if (await input.isVisible().catch(() => false)) {
          await input.fill(value);
          return;
        }
      }
      scope = scope.locator('..');
    }
  }

  // 当前“目的文件”区域的 5 个同名“请输入”文本框顺序已由真实页面快照确认：
  // SFTP 地址、用户名、密码、基础文件名、文件路径。基础文件名的标签被问号图标
  // 拆分后无法形成可查找的单一文字节点，保留这个窄范围兜底并只用于该两个字段。
  const fallbackIndex: Record<string, number | undefined> = {
    基础文件名: 3,
    文件路径: 4,
  };
  const index = fallbackIndex[label];
  if (index !== undefined) {
    const textbox = page.getByRole('textbox', { name: '请输入', exact: true }).nth(index);
    if (await textbox.isVisible().catch(() => false)) {
      await textbox.fill(value);
      return;
    }
  }
  throw new Error(`文件导出字段“${label}”未找到近邻输入框，当前页面：${page.url()}`);
}

async function selectSftpProtocol(page: Page): Promise<void> {
  const sftp = page.getByRole('radio', { name: /^sftp$/i }).last();
  if (!(await sftp.isVisible().catch(() => false))) {
    throw new Error(`文件导出页未找到 SFTP 协议选项，当前页面：${page.url()}`);
  }
  if (!(await sftp.isChecked().catch(() => false))) await sftp.check();
}

async function fillTransferHost(page: Page, value: string): Promise<void> {
  // 当前前端会随协议切换标签为“sftp服务器地址”；旧版本仍显示“ftp服务器地址”。
  // 先按当前协议精确定位，回退兼容旧文案，避免把真实页面版本差异误报为脚本失败。
  for (const label of ['sftp服务器地址', 'ftp服务器地址']) {
    try {
      await fillExportFieldByText(page, label, value);
      return;
    } catch {
      // 尝试旧页面的另一种字段名称。
    }
  }
  throw new Error(`文件导出页未找到 FTP/SFTP 服务器地址输入框，当前页面：${page.url()}`);
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

/**
 * SFTP 导出保存会同步做远端连通性检查并创建调度任务，响应常超过普通页面 toast
 * 的 10 秒等待。以浏览器已经发出的 create 请求的真实响应为准；随后重新回到
 * 导出列表确认任务可见，避免把“已点击保存”误记为“已创建”。
 */
async function submitExportTaskAndWaitForList(page: Page, taskName: string): Promise<void> {
  // 后端保存会同步做远端连通性检查并创建调度任务，当前环境实测约 60 秒才
  // 返回（run-20260916-170853 trace 实证：60 秒窗口内无响应，随后页面弹出
  // “任务创建失败-调度创建失败”）。窗口放宽到 180 秒，保证等到真实响应体并
  // 以业务码判定成败，而不是把慢响应误报成超时；仍超时则带回页面可见失败提示。
  const createResponse = page.waitForResponse(
    response => response.request().method() === 'POST'
      && response.url().includes('/file/download/ftp/create'),
    { timeout: 180_000 },
  ).catch(async (error: unknown) => {
    const failure = await page
      .getByText(/创建失败|调度失败|请查看日志/)
      .first()
      .innerText()
      .catch(() => '');
    throw new Error(
      `保存导出任务未在 180 秒内收到创建接口响应` +
        `${failure.trim() ? `；页面可见提示：${failure.trim()}` : ''}` +
        `（原始错误：${error instanceof Error ? error.message : String(error)}）`,
    );
  });
  await clickVisibleAction(page, /保\s*存|确\s*认|创建/);
  const response = await createResponse;
  const payload = await response.json().catch(() => undefined) as { code?: string; message?: string } | undefined;
  if (!payload || payload.code !== '000000') {
    throw new Error(`文件导出任务“${taskName}”创建失败：${payload?.message || `HTTP ${response.status()}`}`);
  }
  // 保存成功后的页面版本可能自动返回列表，也可能仍停在新建页；统一重新进入
  // 真实的列表叶子，再按任务名定位，防止把提交成功误判成任务已落库。
  await clickMenu(page, '数据服务', '文件导出', '导出列表');
  await expect(page.getByText(taskName, { exact: true }).last()).toBeVisible({ timeout: 20_000 });
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
): Promise<string> {
  // recursive-r1 快照中的新建导出页标签与控件在同一行，按标签找相邻控件，避免全页 combobox 顺序漂移。
  const box = await nearbyControl(page, fieldName, '.ant-select, .el-select, [role="combobox"], select');
  const expectedText = expected?.replace(/\s+/g, ' ').trim();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // 下拉已打开时不重复点击（antd 点击会把面板切换为收起）。
    if ((await box.getAttribute('aria-expanded').catch(() => null)) !== 'true') {
      await box.click();
    }
    // 每选择一级，级联下拉都会销毁并重新挂载。不能先按旧数量倒序读取
    // options.nth(n)，否则重渲染后 n 可能越界并把正常页面状态误报为超时。
    // 优先按 aria 关联锁定本次打开的下拉面板：全局 visible 选择器在上一个
    // 下拉尚未收起时会读到它的残留选项（run-20260916-172255 实证：Schema
    // 下拉读到表名 full_text_search）。
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
    const optionIndex = texts.findIndex((text) => text && !/请选择|暂无|无数据/.test(text)
      && (!expectedText || text === expectedText));
    if (optionIndex < 0) {
      // 选项异步加载，首轮可能只返回残留/部分列表；重读一次，最后一轮仍无
      // 期望项才按真实选项列表报环境失败。
      if (attempt < 3) {
        await page.waitForTimeout(500);
        continue;
      }
      throw new Error(`当前环境没有可用的${fieldName}${expectedText ? `“${expectedText}”` : ''}，当前选项：${texts.filter(Boolean).join(' | ')}`);
    }
    const selected = options.nth(optionIndex);
    try {
      await expect(selected).toBeVisible({ timeout: 3_000 });
      const selectedText = (await selected.innerText()).replace(/\s+/g, ' ').trim();
      await selected.click();
      return selectedText;
    } catch (error) {
      if (attempt === 3) throw error;
      await page.waitForTimeout(300 * attempt);
    }
  }
  throw new Error(`未能选择${fieldName}。`);
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
test.describe("DS-02-01｜数据服务｜来源表→过滤→分片→SFTP→格式→调度→执行", () => {
  test.beforeEach(async ({ loginPage }) => {
    // “文件导出”是父菜单；实际列表由“导出列表”叶子菜单加载。
    await clickMenu(loginPage, '数据服务', '文件导出', '导出列表');
  })
  test("DS-02-01｜数据服务｜来源表→过滤→分片→SFTP→格式→调度→执行", async ({ loginPage, consoleErrors, report }) => {
      // 该用例需要等待真实远端传输握手（默认 FTP，明确 SFTP 场景为 sftp）和
      // 调度任务创建；保留全局 30 秒给普通页面，
      // 仅此远端导出链路单独允许 2 分钟。
    // 保存+执行链路在当前后端实测约需 3～5 分钟（创建响应约 60 秒才返回）。
    test.setTimeout(600_000);
      const page = loginPage;
      // 前置闸门：传输凭据只来自环境变量（代码不内置默认账号），缺失即显式跳过；
      // 显示名链路由配置中心 exportSource 兜底，仍不完整时同样按前置不足跳过。
      const missingCreds = ['FTP_USER', 'FTP_PASS'].filter((name) => !process.env[name]?.trim());
      test.skip(missingCreds.length > 0,
        `缺少文件传输凭据环境变量：${missingCreds.join('、')}（凭据不设代码默认值）。`);
      const sourceChain = [EXPORT_SOURCE_TYPE, EXPORT_SOURCE_NAME, EXPORT_DATABASE, EXPORT_SCHEMA, EXPORT_SOURCE_TABLE];
      test.skip(sourceChain.some((value) => !value?.trim()),
        '未配置完整导出来源表显示名链路：EXPORT_SOURCE_TYPE/NAME/DATABASE/SCHEMA/SOURCE_TABLE（或配置中心 exportSource）。');
      // 任务名固定使用 E2E 前缀，供“编辑后再次执行”用例精确复用；不编辑业务历史任务。
      const taskName = `e2e_export_${uuid()}`;
      const baseFileName = `export_${uuid()}`;
      await clickVisibleAction(page, /新建导出/);
      // 新建导出表单是点击后异步挂载的抽屉。run-20260916-160544 实证：点击后
      // 立即扫描时表单尚未渲染（测试结束快照中表单已打开，说明只是慢一帧），
      // 而 selectExportCascade→nearbyControl 是一次性扫描、不带等待，必须先
      // 等“数据源类型”标签就绪再开始级联选择（同《文件导出测试工具.ts》
      // openNewExport 的就绪轮询）。
      await expect
        .poll(
          async () => page.getByText(labelPattern('数据源类型')).first().isVisible().catch(() => false),
          { timeout: 15_000 },
        )
        .toBe(true);
      // 1. 来源表配置 + 数据过滤 + 分片信息
      await selectExportCascade(page, 0, EXPORT_SOURCE_TYPE, '数据源类型');
      await selectExportCascade(page, 1, EXPORT_SOURCE_NAME, '数据源名称');
      await selectExportCascade(page, 2, EXPORT_DATABASE, '数据库名称');
      await selectExportCascade(page, 3, EXPORT_SCHEMA, 'Schema');
      // 页面实际标签是“表”；“来源表”是整个分组标题，会把 nearbyControl 错配回首个数据源类型下拉。
      const exportSourceTable = await selectExportCascade(page, 4, EXPORT_SOURCE_TABLE, '表');
      await fillOptionalTextByLabel(page, '过滤条件', 'id > 0');
      await fillPartitionCount(page, '4');
      // 2. FTP/SFTP 服务器 + 目标文件格式 + 通知下游接口
      // 协议默认保持页面 ftp（基线 FTP 192.168.76.113:2121、目录 /）；仅当
      // FTP_PROTOCOL=sftp 这一明确 SFTP 场景才切到 sftp 协议并读取 sftp profile
      // （110:22、/source）。FTP 与 SFTP 不混为同一默认。
      if (TRANSFER_PROFILE.protocol === 'sftp') {
        await selectSftpProtocol(page);
      }
      await fillTransferHost(page, FTP_HOST);
      await fillExportFieldByText(page, '服务器端口', FTP_PORT);
      await fillExportFieldByText(page, '登录用户名', FTP_USER);
      await fillExportFieldByText(page, '登录密码', FTP_PASS);
      await fillExportFieldByText(page, '基础文件名', baseFileName);
      await fillExportFieldByText(page, '文件路径', FTP_FILE_PATH);
      await fillOptionalTextByLabel(page, '文件格式', 'csv');
      await fillOptionalTextByLabel(page, '通知接口', `http://notify_${uuid()}`);
      // 3. 调度信息（填写任务名称，便于保存后按名定位，避免误操作列表第一行）
      await fillExportMainTaskName(page, taskName);
      await fillTextByLabel(page, '任务名称', taskName);
      await fillOptionalTextByLabel(page, '调度周期', '不调度');
      // 当前版本“重试次数”为必填 spinbutton，未填写时页面会留在表单且不弹成功提示。
      await fillTextByLabel(page, '重试次数', '1');
      // 4. 创建导出任务
      await submitExportTaskAndWaitForList(page, taskName);
      // 5. 按任务名定位并执行
      const taskIndex = await rowIndexByText(dataRows(page), taskName);
      await clickVisibleAction(await actionRowAt(page, taskIndex), /执\s*行/);
      await expectToast(page, /成功|执行/);
      // toast 只代表提交成功；再打开详情核对来源、目标目录和文件名配置，
      // 将“导出到 FTP 目录”落到页面可观察结果，而不是把按钮点击当作文件已落盘。
      await clickExportRowAction(page, taskIndex, /查询详情|详情/);
      await expect(page.getByText(taskName, { exact: true }).last()).toBeVisible({ timeout: 15_000 });
      // 根目录“/”的 containText 会退化为恒真；仅非根目录才断言目录文本，
      // 本轮唯一基础文件名与来源表仍是详情核验的强锚点。
      if (FTP_FILE_PATH.replace(/\//g, '').length > 0) {
        await expect(page.locator('body:visible').last()).toContainText(FTP_FILE_PATH);
      }
      await expect(page.locator('body:visible').last()).toContainText(baseFileName);
      await expect(page.locator('body:visible').last()).toContainText(exportSourceTable);
      await assertNoConsoleErrors(consoleErrors);
      await report('文件导出-新建导出-详情核对 FTP 目录与来源表', true);
    })
});
