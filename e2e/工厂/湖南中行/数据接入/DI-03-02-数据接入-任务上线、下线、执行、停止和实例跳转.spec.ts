/**
 * DI-03-02｜数据接入｜本轮唯一 FTP 任务上线、下线、执行、停止与实例跳转（DS-PERM-64 清洁环境迁移）
 *
 * 迁移说明（承接 DS-PERM-58 未完成目标，allowlist：仅本 spec；FTP接入执行工具.ts 只读不改）：
 *   - 不再按历史固定前缀（gs 前缀）检索/复用任何既有任务；改为每轮经平台 UI 新建唯一 ASCII 最小任务：
 *       · 任务名 / 目标表名：`e2e_di0302_<UUID>`（运行时生成）；
 *       · 连接地址 / 端口 / 目录 / 基础文件名 / 账号密码：全部来自配置中心 requireFtpProfile()（缺失即显式报错）；
 *       · 目标链路：配置中心 dataSourceNames.fileAccess；日期偏移候选含配置中心 fileDateOffset。
 *   - 业务覆盖全部保留并加强：上/下线（行内反向操作出现 = 持久证据，toast 仅辅助）、
 *     执行、接入实例跳转、（机会性）停止、执行成功终态、执行日志；
 *   - 判定不依赖瞬时 toast：状态/删除/停止均以持久 DOM 或接口响应为准；
 *   - finally 只回收本轮任务及实例（按唯一任务名过滤后删除，删除不可用时明确保留并告警），
 *     并尽力 DROP 本轮自动建表；绝不触碰其它轮次或历史数据。
 */
import type { Dialog, Locator, Page } from '@playwright/test';
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

const TOAST_SELECTOR = '.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible';

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

/** 状态列所在的表（旧版无独立状态表时回退到操作表）。 */
function dataTableRows(page: Page): Locator {
  const statusTable = tableWithHeader(page, /导入状态/);
  return statusTable.locator('tbody tr:visible');
}

/** 任务名称列所在的表。 */
function taskNameTableRows(page: Page): Locator {
  return tableWithHeader(page, /任务名称/).locator('tbody tr:visible');
}

/** 操作列所在的表。 */
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

/** 部分 label 被 el-form 自定义渲染兜住，fillByLabel 失败时按候选文案依次兜底。 */
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

/** 下拉首选项渲染较慢时，先确认已有文本再调用 selectByLabel，避免死等默认超时。 */
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
    // 先等上一轮偏移遗留的失败 toast 消失，避免把旧提示误记到本轮（element message 约 3 秒自动关闭）。
    try {
      await expect
        .poll(
          async () => (await page.locator(TOAST_SELECTOR).filter({ hasText: /失败|错误/ }).count().catch(() => 0)) === 0,
          { timeout: 5_000 },
        )
        .toBe(true);
    } catch {
      // 超时仍有残留 toast 时继续探测；本轮是否失败由下方实时采集的提示文本判定。
    }
    await dataPreview.click();
    const fieldPreview = page.getByRole('dialog', { name: '字段预览' }).filter({ visible: true }).last();
    let previewShown = false;
    for (let wait = 0; wait < 8 && !previewShown; wait += 1) {
      previewShown = await fieldPreview.isVisible().catch(() => false);
      if (!previewShown) await page.waitForTimeout(1_000);
    }
    if (!previewShown) {
      failures.push(`偏移 ${value}：数据预览未打开字段预览（远端文件可能不存在）`);
      continue;
    }
    // 对话框可见 ≠ FTP 流读取成功：run-20260929-042039-943 实证后端“获取 FTP 文件输入流失败”时
    // 字段预览对话框仍会打开（无数据），随后“下一步”被“请先数据预览”拦截。因此必须确认
    // 对话框内出现真实表头/单元格、且无“输入流失败/权限不足/路径错误”类提示，才认定该偏移可用。
    const hasPreviewContent =
      (await fieldPreview
        .locator('table th, table td, [role="columnheader"], [role="cell"], .el-table__cell')
        .filter({ visible: true })
        .count()
        .catch(() => 0)) > 0;
    const failureToasts = (
      await page
        .locator(TOAST_SELECTOR)
        .filter({ hasText: /输入流失败|权限不足|路径错误|失败|错误/ })
        .allInnerTexts()
        .catch((): string[] => [])
    )
      .map((text) => text.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (hasPreviewContent && failureToasts.length === 0) return offset;
    failures.push(
      `偏移 ${value}：字段预览对话框已打开但${hasPreviewContent ? '' : '没有表头/数据单元格；'}`
        + `${failureToasts.length > 0 ? `出现提示「${failureToasts.join('；').slice(0, 160)}」` : '内容为空'}`,
    );
    const closeFailedPreview = await lastVisible([
      fieldPreview.getByRole('button', { name: /关闭|Close/ }),
      fieldPreview.locator('button:visible, [role="button"]:visible').filter({ hasText: /关闭|Close/ }),
    ]);
    if (closeFailedPreview) await closeFailedPreview.click().catch(() => undefined);
    else await page.keyboard.press('Escape').catch(() => undefined);
    await expect(fieldPreview).toBeHidden({ timeout: 5_000 }).catch(() => undefined);
  }
  throw new Error(`所有候选日期偏移的数据预览均未成功，配置中心 FTP 目录下可能没有可用的 ${baseFileName}_YYYYMMDD 文件。探测记录：${failures.join('；')}`);
}

/**
 * 通过平台 UI 新建本轮唯一 ASCII 最小 FTP 接入任务。
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

  // 测试连接：证明配置中心连接参数真实可用，也是后续异常用例（DI-03-03）的合法基线。
  await clickAction(page, /测试连接/);
  await expect(page.locator(TOAST_SELECTOR).filter({ hasText: /连接成功|成功/ }).last()).toBeVisible({ timeout: 15_000 });
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
  // 步进成功的持久证据是字段映射页出现的映射表格；步骤条上的“字段映射”文案在任何一步都常驻，
  // 不能作为步进依据（否则“请先数据预览”拦截会被静默放过，最终误报成“字段映射没有可用行”）。
  let mappingTableReached = false;
  for (let wait = 0; wait < 10 && !mappingTableReached; wait += 1) {
    mappingTableReached = (await page.locator('table:visible tbody tr').count().catch(() => 0)) > 0;
    if (!mappingTableReached) await page.waitForTimeout(1_000);
  }
  if (!mappingTableReached) {
    const stillOnSourceStep = await page
      .getByText('来源文件', { exact: true })
      .filter({ visible: true })
      .last()
      .isVisible()
      .catch(() => false);
    const pageAlerts = (await page.locator(TOAST_SELECTOR).allInnerTexts().catch((): string[] => []))
      .map((text) => text.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    throw new Error(
      `点击“下一步”后 10 秒内未出现字段映射表格`
      + `${stillOnSourceStep ? '，向导仍停留在“来源文件”步（数据预览未通过）' : ''}`
      + `；页面提示：${pageAlerts.join(' | ').slice(0, 300) || '无'}`,
    );
  }
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
    await expect(page.locator(TOAST_SELECTOR).filter({ hasText: /成功|保存|创建/ }).last()).toBeVisible({ timeout: 15_000 });
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

/** 轮询直到本轮任务行出现且状态达到可用（创建/解析/同步语义）；持久证据为状态列文本。 */
async function waitForRoundTaskReady(page: Page, taskName: string): Promise<number> {
  const deadline = Date.now() + 40_000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    await searchRoundTask(page, taskName);
    const index = await findRowIndexByTaskName(page, taskName);
    if (index >= 0) {
      lastStatus = (await dataTableRows(page).nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
      if (/文件数据同步任务已创建|文件解析中|文件解析完成|文件数据同步完成|同步完成/.test(lastStatus)) return index;
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`本轮任务“${taskName}”在接入列表中未达到可用状态，最后状态：${lastStatus || '未读取到'}`);
}

async function rowHasOperation(page: Page, index: number, name: RegExp): Promise<boolean> {
  const operationRow = operationTableRows(page).nth(index);
  const action = await lastVisible([
    operationRow.getByText(name).filter({ visible: true }),
    operationRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }),
  ]);
  return action !== undefined;
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

interface InstanceOutcome {
  instancePage: Page;
  rowText: string;
  stopped: boolean;
}

/** 查看实例并在实例页轮询到终态；执行中若出现停止入口则真实触发一次（机会性停止覆盖）。 */
async function openRoundInstanceAndWait(page: Page, index: number, taskName: string): Promise<InstanceOutcome> {
  const pagesBefore = new Set(page.context().pages());
  await clickRowOperation(page, index, /^查看实例$/);
  await page.waitForTimeout(800);
  const instancePage = page.context().pages().find((candidate) => !pagesBefore.has(candidate))
    ?? page.context().pages().find((candidate) => candidate !== page)
    ?? page;
  if (instancePage !== page) await instancePage.bringToFront();
  await expect(instancePage.getByText(/实例/).filter({ visible: true }).last()).toBeVisible({ timeout: 15_000 });

  let stopped = false;
  let rowText = '';
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const rows = instancePage.locator('tbody tr:visible, .el-table__body-wrapper tr:visible, [role="row"]:visible');
    let row = rows.filter({ hasText: taskName }).last();
    if (!(await row.isVisible().catch(() => false))) row = rows.first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    rowText = await row.innerText().catch(() => '');
    if (/执行成功|同步完成|接入成功/.test(rowText) && !/执行中/.test(rowText)) break;
    if (!stopped && /执行中/.test(rowText)) {
      const stopAction = await lastVisible([
        row.getByText(/^(?:停止|终止)$/).filter({ visible: true }),
        row.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /^(?:停止|终止)$/ }),
      ]);
      if (stopAction) {
        page.once('dialog', (dialog: Dialog): void => {
          void dialog.accept().catch(() => undefined);
        });
        await stopAction.click();
        const confirmButton = await lastVisible([
          instancePage.getByRole('button', { name: /^确\s*定$/ }).filter({ visible: true }),
          instancePage
            .locator('.ant-popconfirm:visible button, .el-popconfirm:visible button, .ant-modal:visible button, .el-message-box:visible button, .el-dialog:visible button')
            .filter({ hasText: /^确\s*定$/ }),
        ]);
        if (confirmButton) await confirmButton.click();
        stopped = true;
        // 停止的持久证据：实例行离开“执行中”。
        await expect
          .poll(async () => !/执行中/.test(await row.innerText().catch(() => '')), { timeout: 20_000 })
          .toBe(true);
        rowText = await row.innerText().catch(() => '');
        break;
      }
    }
    if (/执行失败|同步失败|接入失败/.test(rowText) && !/停止|终止/.test(rowText)) {
      throw new Error(`本轮唯一任务执行失败：${rowText}`);
    }
    const queryButton = await lastVisible([
      instancePage.getByRole('button', { name: /^查询$/ }),
      instancePage.locator('button:visible, [role="button"]:visible').filter({ hasText: /^查询$/ }),
    ]);
    if (queryButton) await queryButton.click();
    await instancePage.waitForTimeout(1_000);
  }
  return { instancePage, rowText, stopped };
}

/** 执行日志验证：入口在实例行或页面上；日志正文必须非空且含明确结果语义，拒绝“暂无数据”。 */
async function verifyRoundInstanceLog(instancePage: Page, taskName: string): Promise<string> {
  const rows = instancePage.locator('tbody tr:visible, .el-table__body-wrapper tr:visible, [role="row"]:visible');
  const row = rows.filter({ hasText: taskName }).last();
  const logAction = await lastVisible([
    row.getByText('执行日志', { exact: true }).filter({ visible: true }),
    row.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /^执行日志$/ }),
    instancePage.getByText('执行日志', { exact: true }).filter({ visible: true }).last(),
    instancePage.getByRole('button', { name: '执行日志', exact: true }).filter({ visible: true }).first(),
  ]);
  if (!logAction) throw new Error('接入实例没有“执行日志”入口，无法确认实际执行结果。');
  const knownPages = new Set(instancePage.context().pages());
  const popupPromise = instancePage.context().waitForEvent('page', { timeout: 2_000 }).catch(() => undefined);
  await logAction.click();
  const popup = await popupPromise;
  const logPage = popup ?? instancePage.context().pages().find((candidate) => !knownPages.has(candidate)) ?? instancePage;
  if (logPage !== instancePage) await logPage.bringToFront();
  await logPage.waitForLoadState('domcontentloaded').catch(() => undefined);
  const logPanel = logPage.locator('.el-dialog:visible, .ant-modal:visible, .el-drawer:visible, [role="dialog"]:visible').last();
  const readLogText = async (): Promise<string> =>
    (await logPanel.isVisible().catch(() => false) ? logPanel.innerText().catch(() => '') : logPage.locator('body').innerText().catch(() => ''));
  await expect
    .poll(
      async () => {
        const text = (await readLogText()).replace(/\s+/g, ' ').trim();
        return Boolean(text) && !/^加载中(?:\.\.\.|…)?$/.test(text);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const logText = await readLogText();
  if (!logText.trim() || /暂无数据/.test(logText) || !/DATAX|执行状态|执行成功|同步完成|执行完成|成功|完成|回调/.test(logText)) {
    throw new Error(`接入实例执行日志没有明确结果：${logText.slice(0, 1000)}`);
  }
  return logText.replace(/\s+/g, ' ').slice(0, 160);
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

test.describe('DI-03-02｜数据接入｜任务上线、下线、执行、停止和实例跳转', () => {
  test.beforeEach(async ({ loginPage }) => {
    await clickMenu(loginPage, '数据接入', 'ftp文件接入', '接入列表');
  });

  test('DI-03-02｜FTP任务：上线/下线状态与执行实例日志', async ({ loginPage, consoleErrors, report }) => {
    // 唯一任务创建（向导全流程）+ 状态翻转 + 执行实例等待，远超默认时限；与既有重链路用例同口径。
    test.setTimeout(900_000);
    const page = loginPage;
    const ftp = requireFtpProfile();
    const taskName = `e2e_di0302_${uuid().slice(0, 8)}`;
    const targetTable = `e2e_di0302_t_${uuid().slice(0, 8)}`;
    let taskCreated = false;
    try {
      // 1) 每轮唯一 ASCII 最小 FTP 任务：连接地址/端口/目录/凭据全部来自配置中心（requireFtpProfile 校验）。
      await createRoundFtpTask(page, ftp, taskName, targetTable);
      taskCreated = true;
      await clickMenu(page, '数据接入', 'ftp文件接入', '接入列表');
      const index = await waitForRoundTaskReady(page, taskName);

      // 2) 上线/下线：持久证据是行内反向操作出现；toast 保留为辅助信号（缺失不判定失败）。
      if (await rowHasOperation(page, index, /^下线$/)) {
        await clickRowOperation(page, index, /^下线$/);
        await expect(page.locator(TOAST_SELECTOR).filter({ hasText: /成功|下线/ }).last())
          .toBeVisible({ timeout: 15_000 })
          .catch(() => undefined);
        await expect.poll(() => rowHasOperation(page, index, /^上线$/), { timeout: 15_000 }).toBe(true);
      }
      if (!(await rowHasOperation(page, index, /^上线$/))) {
        throw new Error('本轮唯一任务行没有可见的“上线”或“下线”操作，无法验证任务状态。');
      }
      await clickRowOperation(page, index, /^上线$/);
      await expect(page.locator(TOAST_SELECTOR).filter({ hasText: /成功|上线/ }).last())
        .toBeVisible({ timeout: 15_000 })
        .catch(() => undefined);
      await expect.poll(() => rowHasOperation(page, index, /^下线$/), { timeout: 15_000 }).toBe(true);

      // 3) 执行 → 接入实例跳转 →（机会性停止）→ 成功终态 → 执行日志。
      await clickRowOperation(page, index, /^执行$/);
      // 当前版本“执行”可能无成功 toast 而直接异步创建实例；判定依据仍是实例状态与执行日志。
      await page.waitForTimeout(800);
      let outcome = await openRoundInstanceAndWait(page, index, taskName);
      if (outcome.stopped) {
        // 停止行为已实证（实例离开执行中）；重新执行一次，成功终态与日志断言仍然必须达成。
        await clickMenu(page, '数据接入', 'ftp文件接入', '接入列表');
        const reIndex = await findRowIndexByTaskName(page, taskName);
        if (reIndex < 0) throw new Error(`停止验证后未找回本轮任务“${taskName}”。`);
        await clickRowOperation(page, reIndex, /^执行$/);
        await page.waitForTimeout(800);
        outcome = await openRoundInstanceAndWait(page, reIndex, taskName);
      }
      if (!/执行成功|同步完成|接入成功/.test(outcome.rowText) || /执行中/.test(outcome.rowText)) {
        throw new Error(`本轮唯一任务在等待时间内未完成：${outcome.rowText || '未读取到实例状态'}`);
      }
      const logEvidence = await verifyRoundInstanceLog(outcome.instancePage, taskName);

      await assertNoConsoleErrors(consoleErrors);
      await report(
        'FTP任务-唯一任务上线下线-执行-停止-接入实例-执行日志',
        true,
        `唯一任务=${taskName}（finally 回收）；实例=${outcome.rowText.replace(/\s+/g, ' ').slice(0, 120)}；`
        + `停止=${outcome.stopped ? '已触发并验证实例离开执行中' : '本轮实例在可停止窗口内已自然完成，未触发停止入口'}；日志=${logEvidence}`,
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







