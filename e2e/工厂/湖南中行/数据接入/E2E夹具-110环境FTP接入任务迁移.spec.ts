/**
 * E2E夹具｜110环境迁移｜新建自动化专属 SFTP 接入任务并执行成功
 *
 * 背景：192.168.76.113 下线后，接入列表残留的旧 gs_test_ 任务回显
 * `192.168.76.113:/gs/`，测试连接必然失败（run-20260921-003849-642 实证）。
 * 本夹具通过平台 UI 新建一个连接字段为 `192.168.76.110:22 /source/` 的
 * 自动化专属任务（协议 sftp，基础文件名 gs_test，日期规则 日+偏移），
 * 并以"测试连接成功 → 数据预览成功 → 保存成功 → 执行 → 实例日志成功"
 * 全链路作为 110 夹具就绪的依据。
 *
 * 产物：temp/公司模型任务/20260920-110环境迁移闭环/fixture-state.json
 *   - sftpTaskName：本轮任务名，供 FTP_ACCESS_TASK_NAME 精确复用；
 *   - sftpDateOffset：数据预览验证过真实存在远端文件的日期偏移。
 * 重复运行时若任务已存在且可用，则直接报告并复用（幂等，不重复新建）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect, uuid, clickMenu, fillByLabel, selectByLabel } from '../utils.js';
import { assertNoConsoleErrors } from '../utils.js';
import { requireSftpProfile, testEnvironment } from '../../../test-environment.js';

const STATE_PATH = path.resolve('temp/公司模型任务/20260920-110环境迁移闭环/fixture-state.json');
// 本夹具协议固定为 sftp：物理连接只使用 SFTP profile（与 FTP 严格分离，不再读取 FTP_* 变量）。
// host/port/path/baseFile 来自 e2e/test-environment.ts（SFTP_HOST/SFTP_PORT/SFTP_PATH/SFTP_BASE_FILE
// 可单项覆盖）；凭据只从 SFTP_USER/SFTP_PASS 读取，进入用例时由 requireSftpProfile() 校验，
// 缺失即抛出可读错误，不写死任何账号密码。
const SFTP_HOST = testEnvironment.fileTransfer.sftp.host;
const SFTP_PORT = String(testEnvironment.fileTransfer.sftp.port);
const SFTP_FILE_PATH = `${testEnvironment.fileTransfer.sftp.baseDir.replace(/\/*$/, '')}/`;
const BASE_FILE_NAME = testEnvironment.fileTransfer.sftp.baseFile.replace(/\.[^./]+$/, '');
// 远端 /source/ 的 gs_test_YYYYMMDD 快照日期未知：按“新→旧”探测，
// -19/-20/-21 对应历史夹具文件 gs_test_20260902（迁移日约为 0919-0921）。
const OFFSET_CANDIDATES = [0, -1, -2, -3, -4, -5, -6, -7, -19, -8, -9, -10, -11, -12, -13, -14, -15, -16, -17, -18, -20, -21, -22, -23, -24, -25];

function readState(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeState(patch: Record<string, unknown>): void {
  const merged = { ...readState(), ...patch };
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(merged, null, 2), 'utf-8');
}

async function lastVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    for (let index = await candidate.count() - 1; index >= 0; index -= 1) {
      const item = candidate.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return undefined;
}

function tableWithHeader(page: Page, header: RegExp): Locator {
  return page.locator('table:visible').filter({ hasText: header }).first();
}

function dataTableRows(page: Page): Locator {
  return tableWithHeader(page, /导入状态/)
    .locator('tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not(:has([role="columnheader"]))');
}

function operationTableRows(page: Page): Locator {
  return tableWithHeader(page, /操作/)
    .locator('tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not(:has([role="columnheader"]))');
}

function exactOption(value: string): RegExp {
  return new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
}

function optionLocator(page: Page, value: string): Locator {
  return page.locator(
    '.el-select-dropdown:visible li:visible, .ant-select-dropdown:visible [role="option"]:visible, [role="listbox"]:visible [role="option"]:visible',
  ).filter({ hasText: exactOption(value) }).last();
}

async function fillFirstMatchingLabel(page: Page, labels: string[], value: string): Promise<void> {
  for (const label of labels) {
    try {
      await fillByLabel(page, label, value);
      return;
    } catch {
      // 页面可能把地址字段显示为“ftp服务器地址”或“sftp服务器地址”。
    }
  }
  throw new Error(`未找到可填写字段：${labels.join(' / ')}`);
}

async function selectStableByLabel(page: Page, label: string, value: string): Promise<void> {
  const currentCombos = (await page.locator('[role="combobox"]:visible').allTextContents()).map((text) => text.trim());
  if (currentCombos.some((text) => text === value || text === `请选择${value}` || text === `请选择 ${value}`)) return;
  try {
    await selectByLabel(page, label, value);
    return;
  } catch (error) {
    const visibleOption = optionLocator(page, value);
    if (await visibleOption.isVisible().catch(() => false)) {
      await visibleOption.click();
      return;
    }
    throw error;
  }
}

async function selectAvailableSchema(page: Page): Promise<void> {
  let schemaCombo: Locator | undefined;
  const targetTitle = page.getByText('目的表', { exact: true }).filter({ visible: true }).last();
  if (await targetTitle.isVisible().catch(() => false)) {
    const targetCombos = targetTitle.locator('..').locator('[role="combobox"]:visible');
    const candidate = targetCombos.nth(3);
    if (await candidate.isVisible().catch(() => false)) schemaCombo = candidate;
  }
  const labels = page.getByText('* Schema:', { exact: true });
  for (let labelIndex = 0; !schemaCombo && labelIndex < await labels.count(); labelIndex += 1) {
    const label = labels.nth(labelIndex);
    if (!(await label.isVisible().catch(() => false))) continue;
    const candidate = label.locator('..').locator('[role="combobox"]:visible').first();
    if (await candidate.isVisible().catch(() => false)) schemaCombo = candidate;
  }
  if (!schemaCombo) throw new Error('FTP 新建向导没有找到 Schema 下拉框。');
  const current = (await schemaCombo.innerText().catch(() => '')).trim();
  if (current && !/^请选择/.test(current)) return;
  await schemaCombo.click();
  const option = await lastVisible([
    page.getByRole('option', { name: testEnvironment.dataSourceNames.fileAccess.schema, exact: true }),
    optionLocator(page, testEnvironment.dataSourceNames.fileAccess.schema),
  ]);
  if (option && (await option.getAttribute('aria-disabled')) !== 'true') {
    await option.click();
    await page.waitForTimeout(300);
    return;
  }
  await page.keyboard.press('Escape').catch(() => undefined);
  throw new Error(`FTP 新建向导的 Schema 下拉框没有可用的 ${testEnvironment.dataSourceNames.fileAccess.schema} 选项。`);
}

async function fillTargetTableName(page: Page, value: string): Promise<void> {
  const labels = page.getByText(/^\s*表\s*$/).filter({ visible: true });
  for (let index = await labels.count() - 1; index >= 0; index -= 1) {
    const label = labels.nth(index);
    let scope = label;
    for (let level = 0; level < 6; level += 1) {
      const field = scope.locator('input:not([type="radio"]):not([type="checkbox"]):not([disabled]):visible, textarea:not([disabled]):visible').last();
      if (await field.isVisible().catch(() => false) && await field.isEditable().catch(() => false)) {
        await field.fill(value);
        return;
      }
      scope = scope.locator('..');
    }
  }
  throw new Error('编辑向导第一步未找到“表”输入框，无法写入本轮目标表名。');
}

async function clickAction(page: Page, name: RegExp): Promise<Locator> {
  const action = await lastVisible([
    page.getByRole('button', { name }),
    page.getByRole('link', { name }),
    page.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }),
  ]);
  if (!action) throw new Error(`页面没有可见操作“${name}”，当前页面：${page.url()}`);
  await action.click();
  await page.waitForTimeout(500);
  return action;
}

async function fillValidTargetMappingFields(page: Page): Promise<void> {
  const rows = page.locator('tbody tr:visible, .el-table__body-wrapper tr:visible, [role="row"]:visible')
    .filter({ hasNotText: /文件名称|导入状态|数据源类型/ });
  const rowCount = await rows.count();
  if (rowCount === 0) throw new Error('字段映射页没有可编辑行。');
  for (let index = 0; index < rowCount; index += 1) {
    const targetName = `e2e_col_${index}`;
    const targetEditor = rows.nth(index).locator('input:not([type="checkbox"]):not([type="radio"]):visible').first();
    if (!(await targetEditor.isVisible().catch(() => false))) {
      throw new Error(`字段映射第 ${index + 1} 行没有找到“映射目标字段”输入框。`);
    }
    await targetEditor.fill(targetName);
    await targetEditor.press('Enter').catch(() => targetEditor.press('Tab').catch(() => undefined));
    await page.waitForTimeout(150);
  }
  const targetNames: string[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const targetEditor = rows.nth(index).locator('input:not([type="checkbox"]):not([type="radio"]):visible').first();
    targetNames.push((await targetEditor.inputValue()).trim());
  }
  const normalized = targetNames.map((name) => name.toLowerCase());
  if (new Set(normalized).size !== targetNames.length || targetNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error(`字段映射目标列名未规范化：${targetNames.join('、')}`);
  }
}

async function clickWizardNextUntilSave(page: Page, taskName: string): Promise<void> {
  for (let step = 0; step < 6; step += 1) {
    const taskField = page.getByLabel(/任务名称|接入任务名称/).filter({ visible: true }).last();
    if (await taskField.isVisible().catch(() => false)) await taskField.fill(taskName);
    const taskPlaceholder = page.getByPlaceholder(/任务名称|接入任务名称/).filter({ visible: true }).last();
    if (await taskPlaceholder.isVisible().catch(() => false)) await taskPlaceholder.fill(taskName);
    const next = await lastVisible([
      page.getByRole('button', { name: /下一步|继续/ }),
      page.locator('button:visible, [role="button"]:visible').filter({ hasText: /下一步|继续/ }),
    ]);
    if (!next) return;
    await next.click();
    await page.waitForTimeout(600);
  }
}

/**
 * 依次设置文件名日期规则（分隔符/标记/维度固定，偏移量逐个候选探测），
 * 并以“数据预览”对话框真实读到远端文件作为偏移入选依据。
 */
async function probeWorkingDateOffset(page: Page, baseFileName: string): Promise<number> {
  const combos = page.locator('[role="combobox"]:visible');
  if (await combos.count() < 5) {
    throw new Error(`FTP 文件名配置下拉框不足 5 个，当前仅 ${await combos.count()} 个。`);
  }
  for (const [index, value] of [[0, '_'], [1, '空'], [2, '空'], [3, '日']] as const) {
    await combos.nth(index).click();
    const option = optionLocator(page, value);
    await expect(option).toBeVisible({ timeout: 5_000 });
    await option.click();
    await page.waitForTimeout(250);
  }
  const failures: string[] = [];
  for (const offset of OFFSET_CANDIDATES) {
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
    const nameShown = page.getByText(new RegExp(`${baseFileName}_${stamp}`)).filter({ visible: true }).last();
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
  throw new Error(`所有候选日期偏移的数据预览均未成功，远端 ${SFTP_FILE_PATH} 下可能没有可用的 ${baseFileName}_YYYYMMDD 文件。探测记录：${failures.join('；')}`);
}

/** 在接入列表按任务名定位行号（任务名称列在横向滚动的非固定表中）。 */
export async function findRowIndexByTaskName(page: Page, taskName: string): Promise<number> {
  for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
    const nameRows = tableWithHeader(page, /任务名称/)
      .locator('tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not(:has([role="columnheader"]))');
    for (let index = 0; index < await nameRows.count(); index += 1) {
      const nameText = await nameRows.nth(index).innerText().catch(() => '');
      if (nameText.includes(taskName)) return index;
    }
    const next = await lastVisible([
      page.getByRole('button', { name: /下一页/ }),
      page.locator('.ant-pagination-next:visible, .el-pagination .btn-next:visible'),
    ]);
    if (!next || await next.isDisabled().catch(() => true)) break;
    await next.click();
    await page.waitForTimeout(800);
  }
  return -1;
}

test.describe('E2E夹具｜110环境迁移｜SFTP 接入任务', () => {
  test('E2E夹具｜110环境迁移｜新建 SFTP 接入任务并执行到实例日志成功', async ({ loginPage, consoleErrors, report }) => {
    test.setTimeout(900_000);
    // 凭据只来自 SFTP_USER/SFTP_PASS，缺失时立即给出可读错误（不写死任何账号密码）。
    const sftp = requireSftpProfile();

    await clickMenu(loginPage, '数据接入', 'ftp文件接入', '接入列表');
    await expect(loginPage.locator('table:visible, [role="grid"]:visible, .el-table:visible').first()).toBeVisible({ timeout: 15_000 });

    // 幂等：上一轮已建好且可用的任务直接复用，不重复新建。
    const state = readState();
    const existingTaskName = typeof state.sftpTaskName === 'string' ? state.sftpTaskName : '';
    if (existingTaskName) {
      const reusedIndex = await findRowIndexByTaskName(loginPage, existingTaskName);
      if (reusedIndex >= 0) {
        const statusText = await dataTableRows(loginPage).nth(reusedIndex).innerText().catch(() => '');
        await report('110夹具-SFTP接入任务复用', true,
          `任务 ${existingTaskName} 已存在（状态行：${statusText.replace(/\s+/g, ' ').slice(0, 120)}；偏移：${String(state.sftpDateOffset ?? '?')}），无需重建。`);
        return;
      }
    }

    const taskName = `e2e_gs110_${uuid().slice(0, 8)}`;
    const targetTable = `e2e_ftp110_${uuid().slice(0, 8)}`;
    await clickAction(loginPage, /新建接入|新增接入/);
    await expect(loginPage.getByText('来源文件', { exact: true }).filter({ visible: true }).last())
      .toBeVisible({ timeout: 10_000 });

    // 1) 连接配置：实际字段必须是 110 /source/，禁止任何 113 残留。
    const protocol = loginPage.locator('input[type="radio"][value="sftp"]:visible').first();
    await protocol.check();
    await fillFirstMatchingLabel(loginPage, ['ftp服务器地址', 'sftp服务器地址'], SFTP_HOST);
    await fillByLabel(loginPage, '端口', SFTP_PORT);
    await fillByLabel(loginPage, '登录用户名', sftp.username);
    await fillByLabel(loginPage, '登录密码', sftp.password);
    await fillByLabel(loginPage, '文件路径', SFTP_FILE_PATH);
    await fillByLabel(loginPage, '基础文件名', BASE_FILE_NAME);
    await fillByLabel(loginPage, '列分隔符', ',');

    // 2) 目标链路：MySQL 110/e2e_test + 自动建表。
    await selectStableByLabel(loginPage, '数据源类型', testEnvironment.dataSourceNames.fileAccess.type);
    await selectStableByLabel(loginPage, '数据源名称', testEnvironment.dataSourceNames.fileAccess.name);
    await selectStableByLabel(loginPage, '数据库名称', testEnvironment.dataSourceNames.fileAccess.database);
    await selectAvailableSchema(loginPage);
    const autoBuild = loginPage.getByText('自动建表', { exact: true }).filter({ visible: true }).last();
    if (await autoBuild.isVisible().catch(() => false)) {
      await autoBuild.click();
      await loginPage.waitForTimeout(500);
    }
    await fillTargetTableName(loginPage, targetTable);

    // 3) 测试连接：后端用表单里的 110:22 凭据真实连接，成功即后端→110 网络证据。
    await clickAction(loginPage, /测试连接/);
    await expect(loginPage.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
      .filter({ hasText: /连接成功|成功/ }).last()).toBeVisible({ timeout: 15_000 });
    await loginPage.keyboard.press('Escape').catch(() => undefined);

    // 4) 文件名规则 + 数据预览探测真实存在的远端文件。
    const offset = await probeWorkingDateOffset(loginPage, BASE_FILE_NAME);
    const fieldPreview = loginPage.getByRole('dialog', { name: '字段预览' }).filter({ visible: true }).last();
    const closePreview = await lastVisible([
      fieldPreview.getByRole('button', { name: /关闭|Close/ }),
      fieldPreview.locator('button:visible, [role="button"]:visible').filter({ hasText: /关闭|Close/ }),
    ]);
    if (closePreview) await closePreview.click();
    else await loginPage.keyboard.press('Escape');
    await expect(fieldPreview).toBeHidden({ timeout: 5_000 });

    // 5) 下一步 → 字段映射 → 任务名/重试次数 → 保存。
    await clickAction(loginPage, /下一步/);
    await expect(loginPage.getByText(/目标映射|字段映射/).filter({ visible: true }).last()).toBeVisible({ timeout: 10_000 });
    await fillValidTargetMappingFields(loginPage);
    await clickWizardNextUntilSave(loginPage, taskName);
    const retry = loginPage.getByLabel(/重试次数/).filter({ visible: true }).last();
    if (await retry.isVisible().catch(() => false)) await retry.fill('0');
    else {
      const spin = loginPage.getByRole('spinbutton').last();
      if (await spin.isVisible().catch(() => false)) await spin.fill('0');
    }

    const saveRequests: string[] = [];
    const onSaveRequest = (request: { method(): string; url(): string }): void => {
      if (request.method() !== 'POST' || !/createFtpInsertDataTaskJob|ftp|access/i.test(request.url())) return;
      saveRequests.push(`${request.method()} ${request.url()}`);
    };
    loginPage.on('request', onSaveRequest);
    try {
      await clickAction(loginPage, /保\s*存|确\s*定|提交|创建/);
      await expect(loginPage.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible').last()
        .filter({ hasText: /成功|保存|创建/ })).toBeVisible({ timeout: 15_000 });
    } catch (error) {
      const pageHints = (await loginPage.locator('body').innerText().catch(() => ''))
        .split(/\r?\n/).map((line) => line.trim())
        .filter((line) => /失败|错误|异常|不能为空|必填|重复|合法/.test(line)).slice(-12);
      throw new Error(`FTP 接入任务 ${taskName} 保存未成功：${error instanceof Error ? error.message : String(error)}；页面提示：${pageHints.join(' | ') || '无'}；请求：${saveRequests.join(' | ') || '未捕获到保存请求'}`);
    } finally {
      loginPage.off('request', onSaveRequest);
    }

    // 6) 列表执行 → 查看实例 → 执行日志确认真实同步成功。
    await clickMenu(loginPage, '数据接入', 'ftp文件接入', '接入列表');
    let createdIndex = await findRowIndexByTaskName(loginPage, taskName);
    let taskRow = loginPage.getByRole('row').filter({ hasText: taskName }).last();
    if (createdIndex < 0) {
      const statusRows = dataTableRows(loginPage);
      for (let index = 0; index < await statusRows.count(); index += 1) {
        if (/文件数据同步任务已创建/.test(await statusRows.nth(index).innerText().catch(() => ''))) {
          createdIndex = index;
          break;
        }
      }
    }
    if (createdIndex >= 0) taskRow = operationTableRows(loginPage).nth(createdIndex);
    await expect(taskRow).toBeVisible({ timeout: 15_000 });
    const execute = await lastVisible([
      taskRow.getByRole('button', { name: /执行/ }),
      taskRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /执行/ }),
      loginPage.getByText('执行', { exact: true }).filter({ visible: true }).nth(Math.max(createdIndex, 0)),
    ]);
    if (!execute) throw new Error(`本轮新建任务“${taskName}”没有可见执行按钮。`);
    await execute.click();
    await expect(loginPage.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
      .filter({ hasText: /成功|执行|提交/ }).last()).toBeVisible({ timeout: 15_000 });

    const instance = await lastVisible([
      taskRow.getByRole('button', { name: /查看实例/ }),
      taskRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /查看实例/ }),
      loginPage.getByText('查看实例', { exact: true }).filter({ visible: true }).nth(Math.max(createdIndex, 0)),
    ]);
    if (!instance) throw new Error(`本轮新建任务“${taskName}”没有“查看实例”入口。`);
    await instance.click();
    await loginPage.waitForTimeout(800);
    const instancePage = loginPage.context().pages().find((candidate) => candidate !== loginPage) ?? loginPage;
    if (instancePage !== loginPage) await instancePage.bringToFront();
    await expect(instancePage.getByText(/实例/).filter({ visible: true }).last()).toBeVisible({ timeout: 15_000 });

    const instanceRows = instancePage.locator('tbody tr:visible, .el-table__body-wrapper tr:visible, [role="row"]:visible');
    const instanceRow = instanceRows.filter({ hasText: taskName }).last();
    const fallbackRow = instanceRows.first();
    const targetInstanceRow = (await instanceRow.isVisible().catch(() => false)) ? instanceRow : fallbackRow;
    await expect(targetInstanceRow).toBeVisible({ timeout: 15_000 });

    let finalInstanceText = '';
    for (let attempt = 0; attempt < 45; attempt += 1) {
      finalInstanceText = await targetInstanceRow.innerText().catch(() => '');
      if (/执行成功|同步完成|接入成功/.test(finalInstanceText) && !/执行中/.test(finalInstanceText)) break;
      if (/执行失败|同步失败|接入失败|异常/.test(finalInstanceText)) {
        throw new Error(`本轮 110 SFTP 接入实例执行失败（偏移 ${offset}）：${finalInstanceText}`);
      }
      const query = await lastVisible([
        instancePage.getByRole('button', { name: /^查询$/ }),
        instancePage.locator('button:visible, [role="button"]:visible').filter({ hasText: /^查询$/ }),
      ]);
      if (query) await query.click();
      await instancePage.waitForTimeout(1_000);
    }
    if (!/执行成功|同步完成|接入成功/.test(finalInstanceText) || /执行中/.test(finalInstanceText)) {
      throw new Error(`本轮 110 SFTP 接入实例在等待时间内未完成：${finalInstanceText || '未读取到实例状态'}`);
    }

    const logAction = await lastVisible([
      targetInstanceRow.getByText('执行日志', { exact: true }).filter({ visible: true }),
      instancePage.getByText('执行日志', { exact: true }).filter({ visible: true }).last(),
    ]);
    let logEvidence = '（页面未提供执行日志入口，以实例成功状态为准）';
    if (logAction) {
      await logAction.click();
      await instancePage.waitForTimeout(800);
      const logPage = instancePage.context().pages().find((candidate) => candidate !== instancePage) ?? instancePage;
      if (logPage !== instancePage) await logPage.bringToFront();
      const logPanel = logPage.locator('.el-dialog:visible, .ant-modal:visible, .el-drawer:visible, [role="dialog"]:visible').last();
      const logText = await (await logPanel.isVisible().catch(() => false)
        ? logPanel.innerText().catch(() => '')
        : logPage.locator('body').innerText().catch(() => ''));
      if (logText.trim()) logEvidence = logText.replace(/\s+/g, ' ').slice(0, 220);
      if (!logText.trim() || /暂无数据/.test(logText)) {
        throw new Error(`接入实例执行日志没有内容：${logText.slice(0, 400)}`);
      }
    }

    writeState({ sftpTaskName: taskName, sftpTargetTable: targetTable, sftpDateOffset: offset, sftpCreatedAt: new Date().toISOString() });
    await report('110夹具-SFTP接入任务新建', true,
      `任务：${taskName}；目标表：${targetTable}；连接：sftp://${SFTP_HOST}:${SFTP_PORT}${SFTP_FILE_PATH}；基础文件名：${BASE_FILE_NAME}；日期偏移：${offset}（数据预览实证）；实例：${finalInstanceText.replace(/\s+/g, ' ').slice(0, 120)}；日志：${logEvidence}`);
    await assertNoConsoleErrors(consoleErrors);
  });
});







