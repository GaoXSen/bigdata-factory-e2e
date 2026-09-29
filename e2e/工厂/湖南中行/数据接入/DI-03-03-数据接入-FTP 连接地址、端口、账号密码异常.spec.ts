/**
 * DI-03-03｜数据接入｜FTP 连接地址、端口、账号密码异常校验（DS-PERM-64 清洁环境迁移）
 *
 * 迁移说明（承接 DS-PERM-58 未完成目标，allowlist：仅本 spec；FTP接入执行工具.ts 只读不改）：
 *   - 不再复用历史固定前缀（gs 前缀）任务；改为每轮经平台 UI 新建唯一 ASCII 最小任务
 *     （任务名/表名 = e2e_di0303_<UUID>，地址/端口/目录/凭据全部来自配置中心 requireFtpProfile()），
 *     异常注入只发生在本轮任务自己的编辑页；
 *   - 三类异常（非法地址 / 非法端口 / 非法账号密码）都必须出现“阻止或失败”行为：
 *       · 强证据 = 失败接口响应（HTTP>=400 或响应体失败语义）或持久表单校验错误；
 *       · 仅在两者都缺失但出现失败提示时复点一次复现；任何时刻出现“连接成功”即判失败；
 *       · 不把一次瞬时 toast 当唯一断言；
 *   - 全程取消编辑、绝不保存异常配置；持久证据 = 重新打开编辑页回显仍是配置中心原值；
 *   - finally 只回收本轮任务及实例（按唯一任务名过滤删除，不可删除时明确保留并告警），
 *     并尽力 DROP 本轮自动建表；绝不触碰其它轮次或历史数据。
 */
import type { Dialog, Locator, Page, Response } from '@playwright/test';
import {
  assertNoConsoleErrors,
  clickMenu,
  expect,
  fillByLabel,
  query,
  selectByLabel,
  test,
  uuid,
} from '../utils.js';
import { requireFtpProfile, testEnvironment } from '../../../test-environment.js';
import type { FileTransferProfileConfig } from '../../../test-environment.js';
// 只读引用：仅复用其中的“打开接入列表”导航（无任何历史任务依赖）。
import { openFtpAccessList } from './FTP接入执行工具.js';

// ==================== 页面结构工具（固定列拆分表；与 FTP接入执行工具 同构的自持副本） ====================
// DS-PERM-64 allowlist 只允许编辑本 spec，禁止修改公共工具与 FTP 工具，故向导与行定位在本文件自持。

async function lastVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    const visible = candidate.filter({ visible: true });
    if ((await visible.count()) > 0 && (await visible.last().isVisible())) return visible.last();
  }
  return undefined;
}

function tableWithHeader(page: Page, header: RegExp): Locator {
  return page.locator('table:visible').filter({ hasText: header });
}

function dataTableRows(page: Page): Locator {
  return tableWithHeader(page, /导入状态/).locator('tbody tr:visible');
}

function taskNameTableRows(page: Page): Locator {
  return tableWithHeader(page, /任务名称/).locator('tbody tr:visible');
}

function operationTableRows(page: Page): Locator {
  return tableWithHeader(page, /操作/).locator('tbody tr:visible');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactOption(value: string): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(value)}\\s*$`);
}

function optionLocator(page: Page, value: string): Locator {
  return page
    // 空参 `:text` 不是合法选择器（Playwright 1.62 报 `"text" engine expects a single string`），已移除；
    // ant-design 下拉选项本身带 [role="option"]，由第 3 个候选兜住。
    .locator('.el-select-dropdown__item, .el-scrollbar__view li, [role="option"]')
    .filter({ hasText: exactOption(value) })
    .filter({ visible: true })
    .last();
}

async function fillFirstMatchingLabel(page: Page, labels: string[], value: string): Promise<void> {
  for (const label of labels) {
    try {
      await fillByLabel(page, label, value);
      return;
    } catch {
      // 尝试下一个候选 label
    }
  }
  throw new Error(`页面没有找到可填写的输入项：${labels.join(' / ')}`);
}

async function selectStableByLabel(page: Page, label: string, value: string): Promise<void> {
  const combo = page.getByText(label, { exact: true }).filter({ visible: true }).last();
  await expect(combo).toBeVisible({ timeout: 10_000 });
  await selectByLabel(page, label, value);
  await expect(page.getByText(value, { exact: true }).filter({ visible: true }).last()).toBeVisible({ timeout: 10_000 });
}

async function selectAvailableSchema(page: Page): Promise<void> {
  // 按标签定位 Schema 下拉，与上方 数据源类型/数据源名称/数据库名称 同一路径。
  // 旧实现 `[role="combobox"]:visible` nth(3) 命中的是“文件周期”日期单位下拉
  // （本页可见下拉顺序：真实文件名 3 个 → 文件周期 2 个，见 DI-04-01 configureRoundDateRule 注释；
  // 20260929-002954-565 失败快照中展开的 e210 是 日/月/年/月中，Schema 的 e406 仍是“请选择”），
  // 因此 Schema 从未被打开，选项里也不会出现目标值。
  await selectStableByLabel(page, 'Schema', testEnvironment.dataSourceNames.fileAccess.schema);
}

async function fillTargetTableName(page: Page, value: string): Promise<void> {
  const labels = ['表名称', '表名', '目标表'];
  for (const label of labels) {
    try {
      await fillByLabel(page, label, value);
      return;
    } catch {
      // 尝试下一个候选 label
    }
  }
  const input = page.locator('input:visible:not([type="radio"]):not([type="checkbox"])').last();
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(value);
}

async function clickAction(page: Page, name: RegExp): Promise<Locator> {
  const button = await lastVisible([
    page.getByRole('button', { name }),
    page.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }),
  ]);
  if (!button) throw new Error(`未找到可点击操作：${name}，当前页面：${page.url()}`);
  await button.click();
  await page.waitForTimeout(500);
  return button;
}

/** 字段映射：全部归一化为 e2e_col_N，规避平台对重名目标列的合并缺陷（问题优化 #51）。 */
async function fillValidTargetMappingFields(page: Page): Promise<void> {
  const rows = page.locator('table:visible tbody tr');
  const rowCount = await rows.count();
  if (rowCount < 1) throw new Error('字段映射没有可用行。');
  for (let index = 0; index < rowCount; index += 1) {
    const firstInput = rows.nth(index).locator('input:not([type="checkbox"]):not([type="radio"]):visible').first();
    if ((await firstInput.count()) === 0) continue;
    const normalized = `e2e_col_${index}`.slice(0, 60);
    if ((await firstInput.inputValue().catch(() => '')) === normalized) continue;
    await firstInput.fill(normalized);
  }
}

/** 逐步“下一步”直至出现保存动作；期间出现的任务名称输入框按本轮唯一任务名填写。 */
async function clickWizardNextUntilSave(page: Page, taskName: string): Promise<void> {
  for (let step = 0; step < 6; step += 1) {
    const nameInput = page.getByLabel(/任务名称/).filter({ visible: true }).last();
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill(taskName);
    } else {
      const byPlaceholder = page.getByPlaceholder(/请输入任务名称/).filter({ visible: true }).last();
      if (await byPlaceholder.isVisible().catch(() => false)) await byPlaceholder.fill(taskName);
    }
    const next = await lastVisible([
      page.getByRole('button', { name: /下一步|继续/ }),
      page.locator('button:visible, [role="button"]:visible').filter({ hasText: /下一步|继续/ }),
    ]);
    if (!next) return;
    await next.click();
    await page.waitForTimeout(700);
  }
  throw new Error(`向导“下一步”超过 6 步仍未出现保存动作（任务：${taskName}）。`);
}

/** 日期偏移候选：配置中心优先，回退 0/-1/-2，全部为有限整数并去重。 */
function dateRuleCandidates(): number[] {
  const raw = testEnvironment.fileTransfer.fileDateOffset;
  const candidates = [raw ? Number(raw) : undefined, 0, -1, -2];
  return candidates
    .filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= -3650 && value <= 3650)
    .filter((value, index, array) => array.indexOf(value) === index);
}

/**
 * 文件名日期规则探测：在候选偏移中找到“预览文件名 + 数据预览”都能成功的组合。
 * 远端文件存在性与配置中心 fileDateOffset 都在运行时实测，不写死任何日期。
 */
async function probeWorkingDateOffset(page: Page, baseFileName: string): Promise<number> {
  const combos = page.locator('[role="combobox"]:visible');
  if ((await combos.count()) < 5) {
    throw new Error(`FTP 文件名配置下拉框不足 5 个，当前仅 ${await combos.count()} 个。`);
  }
  for (const [index, value] of [
    [0, '_'],
    [1, '空'],
    [2, '空'],
    [3, '日'],
  ] as const) {
    await combos.nth(index).click();
    const option = optionLocator(page, value);
    await expect(option, `日期规则下拉 ${index} 中没有选项“${value}”`).toBeVisible({ timeout: 5_000 });
    await option.click();
    await page.waitForTimeout(250);
  }
  const failures: string[] = [];
  for (const offset of dateRuleCandidates()) {
    const value = String(offset);
    await combos.nth(4).click();
    const option = optionLocator(page, value);
    if (!(await option.isVisible().catch(() => false))) {
      await page.waitForTimeout(600);
      if (!(await option.isVisible().catch(() => false))) {
        await page.keyboard.press('Escape').catch(() => undefined);
        failures.push(`偏移 ${value}：下拉框无该选项`);
        continue;
      }
    }
    await option.click();
    await page.waitForTimeout(250);

    const previewName = await lastVisible([
      page.getByRole('button', { name: /预览文件名/ }),
      page.locator('button:visible, [role="button"]:visible').filter({ hasText: /预览文件名/ }),
    ]);
    if (!previewName) throw new Error('FTP 来源文件区域没有找到“预览文件名”按钮。');
    await previewName.click();
    const date = new Date();
    date.setDate(date.getDate() + offset);
    const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    const nameShown = page.getByText(new RegExp(`${escapeRegExp(baseFileName)}_${stamp}`)).filter({ visible: true }).last();
    let nameVisible = false;
    for (let wait = 0; wait < 5 && !nameVisible; wait += 1) {
      nameVisible = await nameShown.isVisible().catch(() => false);
      if (!nameVisible) await page.waitForTimeout(1_000);
    }
    if (!nameVisible) {
      failures.push(`偏移 ${value}：预览文件名未出现 ${baseFileName}_${stamp}`);
      continue;
    }

    const dataPreview = await lastVisible([
      page.getByRole('button', { name: /数据预览/ }),
      page.locator('button:visible, [role="button"]:visible').filter({ hasText: /数据预览/ }),
    ]);
    if (!dataPreview) throw new Error('新建 FTP 接入页没有找到“数据预览”按钮。');
    await dataPreview.click();
    const fieldPreview = page.getByRole('dialog', { name: '字段预览' }).filter({ visible: true }).last();
    let previewShown = false;
    for (let wait = 0; wait < 8 && !previewShown; wait += 1) {
      previewShown = await fieldPreview.isVisible().catch(() => false);
      if (!previewShown) await page.waitForTimeout(1_000);
    }
    if (previewShown) return offset;
    failures.push(`偏移 ${value}：数据预览未打开字段预览（远端文件可能不存在）`);
  }
  throw new Error(`所有候选日期偏移的数据预览均未成功，配置中心 FTP 目录下可能没有可用的 ${baseFileName}_YYYYMMDD 文件。探测记录：${failures.join('；')}`);
}

/**
 * 通过平台 UI 新建本轮唯一 ASCII 最小 FTP 接入任务（异常注入发生在它自己的编辑页）。
 * 连接地址/端口/目录/基础文件名/账号密码全部来自配置中心 FTP profile（requireFtpProfile 已校验），
 * 目标链路来自配置中心 dataSourceNames.fileAccess；任务名/目标表名为本轮 UUID ASCII。
 */
async function createRoundFtpTask(page: Page, ftp: FileTransferProfileConfig, taskName: string, targetTable: string): Promise<void> {
  await clickMenu(page, '数据接入', 'ftp文件接入', '接入列表');
  await openFtpAccessList(page);

  await clickAction(page, /新建接入|新增接入/);
  await expect(page.getByText('来源文件', { exact: true }).filter({ visible: true }).last()).toBeVisible({ timeout: 10_000 });

  const protocolRadio = page.locator(`input[type="radio"][value="${ftp.protocol}"]:visible`).first();
  await expect(protocolRadio, `新建页未找到 ${ftp.protocol} 协议单选框`).toBeVisible({ timeout: 10_000 });
  await protocolRadio.check();
  await fillFirstMatchingLabel(page, [`${ftp.protocol}服务器地址`, 'ftp服务器地址', 'sftp服务器地址'], ftp.host);
  await fillByLabel(page, '端口', String(ftp.port));
  await fillByLabel(page, '登录用户名', ftp.username);
  await fillByLabel(page, '登录密码', ftp.password);
  await fillByLabel(page, '文件路径', `${ftp.baseDir.replace(/\/+$/, '')}/`);
  await fillByLabel(page, '基础文件名', ftp.baseFile.replace(/\.[^./]+$/, ''));
  await fillByLabel(page, '列分隔符', ',');

  await selectStableByLabel(page, '数据源类型', testEnvironment.dataSourceNames.fileAccess.type);
  await selectStableByLabel(page, '数据源名称', testEnvironment.dataSourceNames.fileAccess.name);
  await selectStableByLabel(page, '数据库名称', testEnvironment.dataSourceNames.fileAccess.database);
  await selectAvailableSchema(page);
  const autoBuild = page.getByText('自动建表', { exact: true }).filter({ visible: true }).last();
  if (await autoBuild.isVisible().catch(() => false)) {
    await autoBuild.click();
    await page.waitForTimeout(500);
  }
  await fillTargetTableName(page, targetTable);

  // 测试连接：证明配置中心连接参数真实可用——这是“异常配置必失败”断言的合法基线。
  await clickAction(page, /测试连接/);
  await expect(
    page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible').filter({ hasText: /连接成功|成功/ }).last(),
  ).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape').catch(() => undefined);

  const baseFileName = ftp.baseFile.replace(/\.[^./]+$/, '');
  await probeWorkingDateOffset(page, baseFileName);
  const fieldPreview = page.getByRole('dialog', { name: '字段预览' }).filter({ visible: true }).last();
  const closePreview = await lastVisible([
    fieldPreview.getByRole('button', { name: /关闭|Close/ }),
    fieldPreview.locator('button:visible, [role="button"]:visible').filter({ hasText: /关闭|Close/ }),
  ]);
  if (closePreview) await closePreview.click();
  else await page.keyboard.press('Escape');
  await expect(fieldPreview).toBeHidden({ timeout: 5_000 });

  await clickAction(page, /下一步/);
  await expect(page.getByText(/目标映射|字段映射/).filter({ visible: true }).last()).toBeVisible({ timeout: 10_000 });
  await fillValidTargetMappingFields(page);
  await clickWizardNextUntilSave(page, taskName);
  const retry = page.getByLabel(/重试次数/).filter({ visible: true }).last();
  if (await retry.isVisible().catch(() => false)) await retry.fill('0');
  else {
    const spin = page.getByRole('spinbutton').last();
    if (await spin.isVisible().catch(() => false)) await spin.fill('0');
  }

  const saveRequests: string[] = [];
  const onSaveRequest = (request: { method(): string; url(): string }): void => {
    if (request.method() !== 'POST' || !/createFtpInsertDataTaskJob|ftp|access/i.test(request.url())) return;
    saveRequests.push(`${request.method()} ${request.url()}`);
  };
  page.on('request', onSaveRequest);
  try {
    await clickAction(page, /保\s*存|确\s*定|提交|创建/);
    await expect(
      page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible').filter({ hasText: /成功|保存|创建/ }).last(),
    ).toBeVisible({ timeout: 15_000 });
  } catch (error) {
    const pageHints = (await page.locator('body').innerText().catch(() => ''))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /失败|错误|异常|不能为空|必填|重复|合法/.test(line))
      .slice(-12);
    throw new Error(
      `本轮 FTP 任务 ${taskName} 保存未成功：${error instanceof Error ? error.message : String(error)}；`
      + `页面提示：${pageHints.join(' | ') || '无'}；请求：${saveRequests.join(' | ') || '未捕获到保存请求'}`,
    );
  } finally {
    page.off('request', onSaveRequest);
  }
}

/** 按唯一任务名过滤接入列表（首个可见输入框 + 查询按钮，与既有工具同构）。 */
async function searchRoundTask(page: Page, taskName: string): Promise<void> {
  const searchInput = page.locator('input:visible:not([type="radio"]):not([type="checkbox"])').first();
  await searchInput.fill(taskName);
  const searchButton = await lastVisible([
    page.getByRole('button', { name: /查\s*询/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /查\s*询/ }),
  ]);
  if (searchButton) await searchButton.click();
  await page.waitForTimeout(800);
}

/** 在接入列表分页中按唯一任务名定位行号（返回 -1 表示未找到）。 */
async function findRowIndexByTaskName(page: Page, taskName: string): Promise<number> {
  const nameRows = taskNameTableRows(page);
  for (let index = 0; index < (await nameRows.count()); index += 1) {
    if ((await nameRows.nth(index).innerText().catch(() => '')).includes(taskName)) return index;
  }
  for (let pageNum = 0; pageNum < 5; pageNum += 1) {
    const nextButton = page.getByText('下一页', { exact: true }).filter({ visible: true }).last();
    if (!(await nextButton.isVisible().catch(() => false))) break;
    await nextButton.click();
    await page.waitForTimeout(600);
    const refreshed = taskNameTableRows(page);
    for (let index = 0; index < (await refreshed.count()); index += 1) {
      if ((await refreshed.nth(index).innerText().catch(() => '')).includes(taskName)) return index;
    }
  }
  return -1;
}

/** 行号对齐点击操作列（找不到时直接报错，绝不点错行）。 */
async function clickRowOperation(page: Page, index: number, name: RegExp): Promise<void> {
  const operationRow = operationTableRows(page).nth(index);
  const action = await lastVisible([
    operationRow.getByText(name).filter({ visible: true }),
    operationRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }),
    page.getByText(name).filter({ visible: true }).nth(index),
    page.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }).nth(index),
  ]);
  if (!action) throw new Error(`接入列表第 ${index + 1} 行没有可见操作“${name}”，当前页面：${page.url()}`);
  await action.click();
}

/** 通过接入列表“编辑”打开本轮唯一任务的编辑页。 */
async function openRoundTaskEditor(page: Page, taskName: string): Promise<Page> {
  await clickMenu(page, '数据接入', 'ftp文件接入', '接入列表');
  await openFtpAccessList(page);
  await searchRoundTask(page, taskName);
  const index = await findRowIndexByTaskName(page, taskName);
  if (index < 0) throw new Error(`接入列表中找不到本轮唯一任务“${taskName}”，无法继续异常注入。`);
  const operationRow = operationTableRows(page).nth(index);
  const editAction = await lastVisible([
    operationRow.getByText(/编\s*辑/).filter({ visible: true }),
    operationRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /编\s*辑/ }),
  ]);
  if (!editAction) throw new Error(`本轮任务“${taskName}”没有可见的“编辑”操作。`);
  const knownPages = new Set(page.context().pages());
  const popupPromise = page.context().waitForEvent('page', { timeout: 5_000 }).catch(() => undefined);
  await editAction.click();
  const popup = await popupPromise;
  const editorPage = popup ?? page.context().pages().find((candidate) => !knownPages.has(candidate)) ?? page;
  if (editorPage !== page) await editorPage.bringToFront();
  await editorPage.waitForLoadState('domcontentloaded').catch(() => undefined);
  await expect(editorPage.getByText('来源文件', { exact: true }).filter({ visible: true }).last()).toBeVisible({ timeout: 20_000 });
  return editorPage;
}

interface ConnectionInputs {
  host: Locator;
  port: Locator;
  username: Locator;
}

/** 编辑页连接三要素（host/port/username）输入框定位（密码输入框在异常用例里单独填）。 */
async function readConnectionInputs(editorPage: Page): Promise<ConnectionInputs> {
  const inputs = editorPage.locator('input:visible:not([type="radio"]):not([type="checkbox"])');
  const count = await inputs.count();
  if (count < 4) throw new Error(`编辑页可输入项不足（期望至少 4 个，实际 ${count} 个），无法定位连接配置。`);
  return { host: inputs.nth(0), port: inputs.nth(1), username: inputs.nth(2) };
}

const FTP_CONNECTION_TIMEOUT_MS = 70_000;
const FTP_CONNECTION_ROUTE = '/file-datasource/saveFtpServerConfig';

type ConnectionWaitSignal =
  | { kind: 'response-rejected'; evidence: string }
  | { kind: 'response-connected'; evidence: string }
  | { kind: 'form-error' }
  | { kind: 'success-message' }
  | { kind: 'failure-message' };

function isFtpConnectionRoute(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).pathname === FTP_CONNECTION_ROUTE;
  } catch {
    return false;
  }
}

function connectionResponseEvidence(response: Response, body: string): string {
  return `HTTP ${response.status()} ${response.url()} ${body.slice(0, 200)}`;
}

function classifyFtpConnectionResponse(status: number, body: string): 'rejected' | 'connected' | 'unrecognized' {
  if (status >= 400) return 'rejected';
  const failed = /"code"\s*:\s*(?!200\b)\d+|"success"\s*:\s*false|"status"\s*:\s*"(?:ERROR|FAIL)|失败|错误|异常/i.test(body);
  if (failed) return 'rejected';
  const connected = /"code"\s*:\s*200(?![0-9])|"success"\s*:\s*true|"status"\s*:\s*"(?:SUCCESS|OK)|成功/i.test(body);
  return connected ? 'connected' : 'unrecognized';
}

async function waitForConnectionUiSignal(
  source: Promise<Locator | undefined>,
  timeout: number,
  kind: ConnectionWaitSignal['kind'],
): Promise<ConnectionWaitSignal> {
  const locator = await source;
  if (!locator) return new Promise<never>(() => {});
  await locator.waitFor({ state: 'visible', timeout });
  return { kind } as ConnectionWaitSignal;
}

/**
 * 异常注入后的“拒绝”断言：
 *  1. 强证据：当前 saveFtpServerConfig 响应失败（HTTP>=400 或响应体失败语义）或表单校验错误；
 *  2. 仅在两者都缺失但出现失败 toast 时：复点一次“测试连接”复现同一失败提示；
 *  3. 任何时刻出现“连接成功”都立即判失败（异常值不可能连上真实服务器）。
 */
async function assertConnectionRejected(editorPage: Page, field: 'host' | 'port' | 'credential', invalid: string): Promise<string> {
  const fieldLabel = field === 'host' ? `连接地址=${invalid}` : field === 'port' ? `端口=${invalid}` : `账号/密码=${invalid}`;
  const responses: string[] = [];
  let resolveResponse!: (signal: ConnectionWaitSignal) => void;
  const createResponseSignal = (): Promise<ConnectionWaitSignal> =>
    new Promise<ConnectionWaitSignal>((resolve) => {
      resolveResponse = resolve;
    });
  let responseSignal = createResponseSignal();
  const onResponse = async (response: Response): Promise<void> => {
    if (!isFtpConnectionRoute(response.url())) return;
    let body = '';
    try {
      body = (await response.text()).slice(0, 200);
    } catch {
      body = '';
    }
    const evidence = connectionResponseEvidence(response, body);
    responses.push(evidence);
    const outcome = classifyFtpConnectionResponse(response.status(), body);
    if (outcome === 'rejected') resolveResponse({ kind: 'response-rejected', evidence });
    if (outcome === 'connected') resolveResponse({ kind: 'response-connected', evidence });
  };
  editorPage.on('response', onResponse);
  try {
    const testButton = await lastVisible([
      editorPage.getByRole('button', { name: /测试连接/ }),
      editorPage.locator('button:visible, [role="button"]:visible').filter({ hasText: /测试连接/ }),
    ]);
    if (!testButton) throw new Error('编辑页没有“测试连接”按钮，无法验证异常配置被拒绝。');

    const formErrorLocator = lastVisible([
      editorPage.locator('.ant-form-item-explain-error:visible, .ant-form-item-explain:visible'),
      editorPage.locator('.el-form-item__error:visible'),
    ]);
    const toastLocator = editorPage.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible');
    const successToast = toastLocator.filter({ hasText: /连接成功|成功/ }).last();
    const failToast = toastLocator.filter({ hasText: /失败|错误|异常|超时|无法|不通/ }).last();

    await testButton.click();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutSignal = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`异常配置（${fieldLabel}）测试连接请求在 ${FTP_CONNECTION_TIMEOUT_MS}ms 内未产生失败响应、表单错误或失败提示。`)),
        FTP_CONNECTION_TIMEOUT_MS,
      );
    });
    try {
      const outcome = await Promise.race([
        responseSignal,
        waitForConnectionUiSignal(formErrorLocator, FTP_CONNECTION_TIMEOUT_MS, 'form-error'),
        waitForConnectionUiSignal(Promise.resolve(successToast), FTP_CONNECTION_TIMEOUT_MS, 'success-message'),
        waitForConnectionUiSignal(Promise.resolve(failToast), FTP_CONNECTION_TIMEOUT_MS, 'failure-message'),
        timeoutSignal,
      ]);

      if (outcome.kind === 'response-rejected') return outcome.evidence.trim();
      if (outcome.kind === 'response-connected') {
        throw new Error(`异常配置（${fieldLabel}）接口返回连接成功，平台未拒绝该异常值。证据：${outcome.evidence}`);
      }
      if (outcome.kind === 'form-error') {
        const formError = await lastVisible([
          editorPage.locator('.ant-form-item-explain-error:visible, .ant-form-item-explain:visible'),
          editorPage.locator('.el-form-item__error:visible'),
        ]);
        const text = (await formError?.innerText().catch(() => ''))?.trim() ?? '';
        if (!text) throw new Error(`异常配置（${fieldLabel}）出现表单错误但未能读取错误内容。`);
        return `持久表单校验错误：${text.slice(0, 120)}`;
      }
      if (outcome.kind === 'success-message') {
        throw new Error(`异常配置（${fieldLabel}）出现“连接成功”，平台未拒绝该异常值。`);
      }

      const firstText = (await failToast.innerText().catch(() => '')).trim();
      await failToast.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
      await expect(testButton, '失败提示复现前“测试连接”按钮不可用').toBeEnabled({ timeout: 10_000 });
      responseSignal = createResponseSignal();
      await testButton.click();
      const retryOutcome = await Promise.race([
        responseSignal,
        waitForConnectionUiSignal(Promise.resolve(failToast), FTP_CONNECTION_TIMEOUT_MS, 'failure-message'),
        timeoutSignal,
      ]);
      if (retryOutcome.kind === 'response-rejected') return retryOutcome.evidence.trim();
      if (retryOutcome.kind === 'response-connected') {
        throw new Error(`异常配置（${fieldLabel}）复点后接口返回连接成功，平台未拒绝该异常值。证据：${retryOutcome.evidence}`);
      }
      const secondText = (await failToast.innerText().catch(() => '')).trim();
      return `失败提示复现两次：${firstText || secondText} / ${secondText || firstText}`;
    } finally {
      clearTimeout(timeoutId);
    }
  } finally {
    editorPage.off('response', onResponse);
  }
}

/** 全程取消编辑：不保存异常配置；若误触保存弹确认，则明确取消。 */
async function closeRoundTaskEditorWithoutSaving(editorPage: Page): Promise<void> {
  const cancelButton = await lastVisible([
    editorPage.getByRole('button', { name: /取\s*消|关\s*闭/ }),
    editorPage.locator('button:visible, [role="button"]:visible').filter({ hasText: /取\s*消|关\s*闭/ }),
  ]);
  if (cancelButton) await cancelButton.click();
  await editorPage.waitForTimeout(800);
  const confirmButton = await lastVisible([
    editorPage.getByRole('button', { name: /取\s*消/ }).filter({ visible: true }),
    editorPage
      .locator('.ant-modal:visible button, .el-message-box:visible button, .ant-popconfirm:visible button, .el-popconfirm:visible button')
      .filter({ hasText: /取\s*消|否/ }),
  ]);
  if (confirmButton) await confirmButton.click().catch(() => undefined);
}

/**
 * finally 只回收本轮任务：先按本轮唯一任务名过滤，再在同一行号的操作列点击“删除”并确认；
 * 页面未提供删除入口时明确记录保留（UUID 命名保证隔离），绝不触碰其它轮次/历史任务。
 */
async function deleteRoundFtpTaskIfExists(page: Page, taskName: string): Promise<'deleted' | 'retained'> {
  await clickMenu(page, '数据接入', 'ftp文件接入', '接入列表');
  await openFtpAccessList(page);
  await searchRoundTask(page, taskName);
  const rowIndex = await findRowIndexByTaskName(page, taskName);
  if (rowIndex < 0) return 'deleted'; // 本轮任务未创建成功或已不存在，无可回收记录

  const operationRow = operationTableRows(page).nth(rowIndex);
  const deleteAction = await lastVisible([
    operationRow.getByText(/删\s*除/).filter({ visible: true }),
    operationRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /删\s*除/ }),
  ]);
  if (!deleteAction) {
    console.warn(`[cleanup] FTP 接入列表未提供“删除”操作，本轮任务保留（UUID 隔离）：${taskName}`);
    return 'retained';
  }
  const acceptDialog = (dialog: Dialog): void => {
    void dialog.accept().catch(() => undefined);
  };
  page.once('dialog', acceptDialog);
  try {
    await deleteAction.click();
    const confirmButton = await lastVisible([
      page.getByRole('button', { name: /^确\s*定$/ }).filter({ visible: true }),
      page
        .locator('.ant-popconfirm:visible button, .el-popconfirm:visible button, .ant-modal:visible button, .el-message-box:visible button')
        .filter({ hasText: /^确\s*定$/ }),
    ]);
    if (confirmButton) await confirmButton.click();
    // 回收结果持久证据：按唯一任务名再查询，行必须消失。
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await page.waitForTimeout(800);
      await searchRoundTask(page, taskName);
      if ((await findRowIndexByTaskName(page, taskName)) < 0) return 'deleted';
    }
    throw new Error(`本轮任务 ${taskName} 点击删除并确认后仍存在于接入列表。`);
  } finally {
    page.off('dialog', acceptDialog);
  }
}

async function dropRoundTableQuietly(tableName: string): Promise<void> {
  try {
    await query(`DROP TABLE IF EXISTS ${tableName}`);
    console.warn(`[cleanup] 已回收本轮自动建表：${tableName}`);
  } catch (error) {
    console.warn(`[cleanup] 本轮表未回收（DB 未配置或直连失败）：${tableName}；原因：${error instanceof Error ? error.message : String(error)}`);
  }
}

test.describe('DI-03-03｜数据接入｜FTP连接地址、端口、账号密码异常', () => {
  test('DI-03-03｜连接地址、端口、账号密码异常配置均被拒绝且原配置保持不变', async ({ loginPage, consoleErrors, report }) => {
    // 每轮唯一任务创建 + 三类异常注入验证，远超默认时限；与既有重链路用例同口径。
    test.setTimeout(900_000);
    const page = loginPage;
    const ftp = requireFtpProfile();
    const taskName = `e2e_di0303_${uuid().slice(0, 8)}`;
    const targetTable = `e2e_di0303_t_${uuid().slice(0, 8)}`;
    let taskCreated = false;
    try {
      // 1) 每轮唯一合法任务：先证明配置中心参数真实可用（测试连接成功 + 预览成功），异常注入只发生在它自己的编辑页。
      await createRoundFtpTask(page, ftp, taskName, targetTable);
      taskCreated = true;
      const editorPage = await openRoundTaskEditor(page, taskName);
      const inputs = await readConnectionInputs(editorPage);

      // 2) 连接地址异常：非法主机名（合法格式、必然解析失败；避免触发平台的前端格式校验）。
      const invalidHost = 'e2e-no-such-host.invalid';
      await inputs.host.fill(invalidHost);
      const hostRejection = await assertConnectionRejected(editorPage, 'host', invalidHost);
      await inputs.host.fill(ftp.host);

      // 3) 端口异常：超范围端口值（合法数字，验证后端拒绝；避免触发平台的前端格式校验）。
      const invalidPort = '70000';
      await inputs.port.fill(invalidPort);
      const portRejection = await assertConnectionRejected(editorPage, 'port', invalidPort);
      await inputs.port.fill(String(ftp.port));

      // 4) 账号密码异常：错误用户名 + 错误密码（认证必然失败）。
      const invalidUser = `e2e_invalid_${uuid().slice(0, 6)}`;
      const invalidPass = `wrong-pass-${uuid().slice(0, 8)}`;
      await inputs.username.fill(invalidUser);
      const passwordInput = editorPage.locator('input[type="password"]:visible').last();
      await expect(passwordInput).toBeVisible({ timeout: 10_000 });
      await passwordInput.fill(invalidPass);
      const credentialRejection = await assertConnectionRejected(editorPage, 'credential', invalidUser);

      // 5) 关闭编辑页（不保存任何异常值）。
      await closeRoundTaskEditorWithoutSaving(editorPage);

      // 6) 持久证据：重新打开编辑页，连接字段回显仍是配置中心原值（异常值未被保存）。
      const reopened = await openRoundTaskEditor(page, taskName);
      const reopenedInputs = await readConnectionInputs(reopened);
      await expect(reopenedInputs.host, '重新打开后连接地址仍是配置中心原值').toHaveValue(ftp.host, { timeout: 10_000 });
      await expect(reopenedInputs.port, '重新打开后端口仍是配置中心原值').toHaveValue(String(ftp.port), { timeout: 10_000 });
      await expect(reopenedInputs.username, '重新打开后用户名仍是配置中心原值').toHaveValue(ftp.username, { timeout: 10_000 });
      await closeRoundTaskEditorWithoutSaving(reopened);

      await assertNoConsoleErrors(consoleErrors);
      await report(
        'FTP任务-连接地址-端口-账号密码异常校验-原配置保持不变',
        true,
        `唯一任务=${taskName}（finally 回收，未保存任何异常值）；`
        + `地址异常拒绝=${hostRejection.slice(0, 80)}；端口异常拒绝=${portRejection.slice(0, 80)}；`
        + `凭据异常拒绝=${credentialRejection.slice(0, 80)}；`
        + `重新打开回显=原值（${ftp.host}:${ftp.port} / ${ftp.username}）`,
      );
    } finally {
      if (taskCreated) {
        try {
          const cleanup = await deleteRoundFtpTaskIfExists(page, taskName);
          console.warn(`[cleanup] 本轮 FTP 任务回收（${taskName}）：${cleanup}`);
        } catch (error) {
          console.warn(`[cleanup] 本轮 FTP 任务回收未完成（${taskName}）：${error instanceof Error ? error.message : String(error)}`);
        }
        await dropRoundTableQuietly(targetTable);
      }
    }
  });
});








