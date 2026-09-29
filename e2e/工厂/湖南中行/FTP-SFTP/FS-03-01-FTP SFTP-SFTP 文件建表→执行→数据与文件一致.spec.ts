/**
 * FS-03-01｜FTP/SFTP｜自动建表、执行与导入数据一致
 *
 * 本用例不复用历史任务：先按环境 SFTP profile 新建本轮唯一任务和唯一表，
 * 再以页面实例终态、执行日志和数据库全行数据共同作为通过依据。
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect, fillByLabel, selectByLabel, uuid, assertNoConsoleErrors, query } from '../utils.js';
import { openFtpAccessList, executeExistingFtpTaskAndVerifyLog } from '../数据接入/FTP接入执行工具.js';
import { requireSftpProfile, testEnvironment } from '../../../test-environment.js';

const sftpProfile = testEnvironment.fileTransfer.sftp;
const missingSftpProfileEnvNames = [
  ['SFTP_HOST', Boolean(sftpProfile.host)],
  ['SFTP_PORT', sftpProfile.port > 0],
  ['SFTP_PATH', Boolean(sftpProfile.baseDir)],
  ['SFTP_BASE_FILE', Boolean(sftpProfile.baseFile)],
  ['SFTP_USER', Boolean(sftpProfile.username)],
  ['SFTP_PASS', Boolean(sftpProfile.password)],
]
  .filter(([, present]) => !present)
  .map(([name]) => name);

if (missingSftpProfileEnvNames.length > 0) {
  test.skip(
    true,
    `缺少 SFTP profile：${missingSftpProfileEnvNames.join('、')}。请在进程环境中提供后执行。`,
  );
}

const HOST = testEnvironment.fileTransfer.sftp.host;
const PORT = String(testEnvironment.fileTransfer.sftp.port);
const PATH = testEnvironment.fileTransfer.sftp.baseDir;
const BASE = testEnvironment.fileTransfer.sftp.baseFile.replace(/\.[^./]+$/, '');
const EXPECTED_COLUMNS = ['name', 'age', 'phone_number', 'adress_di'];
const EXPECTED_ROWS = [
  ['张三', '25', '13800138001', 'beijin'],
  ['李四', '34', '13900139002', 'shanghai'],
].sort((left, right) => left.join('\u0000').localeCompare(right.join('\u0000')));

function today(): string {
  const value = new Date();
  return `${value.getFullYear()}${String(value.getMonth() + 1).padStart(2, '0')}${String(value.getDate()).padStart(2, '0')}`;
}

async function visibleLast(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    for (let index = await candidate.count() - 1; index >= 0; index -= 1) {
      if (await candidate.nth(index).isVisible().catch(() => false)) return candidate.nth(index);
    }
  }
  return undefined;
}

async function clickButton(page: Page, name: RegExp): Promise<void> {
  const button = await visibleLast([
    page.getByRole('button', { name }).filter({ visible: true }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: name }),
  ]);
  if (!button) throw new Error(`未找到可见按钮：${name}`);
  await button.click();
}

async function fillNearLabel(page: Page, labelText: string, value: string): Promise<void> {
  const label = page.getByText(labelText, { exact: true }).filter({ visible: true }).last();
  await expect(label).toBeVisible({ timeout: 10_000 });
  let scope = label.locator('..');
  for (let depth = 0; depth < 5; depth += 1, scope = scope.locator('..')) {
    const input = scope.locator('input:visible:not([type="radio"]):not([type="checkbox"])').last();
    if (await input.isVisible().catch(() => false)) {
      await input.fill(value);
      return;
    }
  }
  throw new Error(`未找到“${labelText}”对应输入框。`);
}

async function configureDateRule(page: Page): Promise<void> {
  const values = ['_', '空', '空', '日', '0'];
  const combos = page.locator('[role="combobox"]:visible');
  if (await combos.count() < values.length) throw new Error(`日期规则下拉框不足：${await combos.count()}`);
  for (const [index, value] of values.entries()) {
    await combos.nth(index).click();
    const option = page.locator(
      '.el-select-dropdown:visible li:visible, .ant-select-dropdown:visible [role="option"]:visible, [role="listbox"] [role="option"]:visible',
    ).filter({ hasText: new RegExp(`^\\s*${value}\\s*$`) }).last();
    await expect(option, `日期规则第 ${index + 1} 项未提供“${value}”`).toBeVisible({ timeout: 8_000 });
    await option.click();
    await page.keyboard.press('Escape').catch(() => undefined);
  }
}

async function fillAutomaticTable(page: Page, table: string): Promise<void> {
  const labels = page.getByText(/^\s*\*?\s*表\s*[:：]\s*$/).filter({ visible: true });
  for (let index = await labels.count() - 1; index >= 0; index -= 1) {
    let scope = labels.nth(index);
    for (let depth = 0; depth < 5; depth += 1, scope = scope.locator('..')) {
      const input = scope.locator('input:visible:not([type="radio"]):not([type="checkbox"]):not([type="password"])').last();
      if (await input.isVisible().catch(() => false)) {
        await input.fill(table);
        return;
      }
    }
  }
  const fallback = page.locator('input:visible:not([type="radio"]):not([type="checkbox"]):not([type="password"])').last();
  if (await fallback.isVisible().catch(() => false)) {
    await fallback.fill(table);
    return;
  }
  throw new Error('未找到自动建表的目标表输入框。');
}

function normalizeCell(value: unknown): string {
  return String(value ?? '').trim();
}

function redactSensitive(value: string): string {
  return value.replace(/(password|pwd|密码)\s*[:=]\s*[^,\s;]+/gi, '$1=[redacted]');
}

function ftpListRows(page: Page, header: RegExp): Locator {
  return page.locator('table:visible').filter({ hasText: header }).first().locator(
    'tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not(:has([role="columnheader"]))',
  );
}

async function findOwnedSftpTaskIndex(page: Page, taskName: string): Promise<number> {
  const searchInput = page.locator('input:visible:not([type="radio"]):not([type="checkbox"])').first();
  await searchInput.fill(taskName);
  const searchButton = await visibleLast([
    page.getByRole('button', { name: /查\s*询/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /查\s*询/ }),
  ]);
  if (searchButton) await searchButton.click();
  await page.waitForTimeout(800);

  for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
    const rows = ftpListRows(page, /文件名称/);
    for (let index = 0; index < await rows.count(); index += 1) {
      const rowText = await rows.nth(index).innerText().catch(() => '');
      if (rowText.includes(taskName)) return index;
    }
    const next = await visibleLast([
      page.getByRole('button', { name: /下一页/ }),
      page.locator('.ant-pagination-next:visible, .el-pagination .btn-next:visible'),
    ]);
    if (!next || await next.isDisabled().catch(() => true)) break;
    await next.click();
    await page.waitForTimeout(800);
  }
  return -1;
}

/** 仅回收本轮完整唯一任务名对应的记录；行消失是删除完成依据。 */
async function deleteOwnedSftpTaskRecord(page: Page, taskName: string): Promise<void> {
  if (!taskName.startsWith('E2E_FS0301_SFTP_')) throw new Error(`拒绝清理非本轮命名规则的任务：${taskName}`);
  await page.keyboard.press('Escape').catch(() => undefined);
  await openFtpAccessList(page);
  const rowIndex = await findOwnedSftpTaskIndex(page, taskName);
  if (rowIndex < 0) return;

  const operationRow = ftpListRows(page, /操作/).nth(rowIndex);
  const deleteAction = await visibleLast([
    operationRow.getByText(/^删除$/).filter({ visible: true }),
    operationRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /^删除$/ }),
  ]);
  if (!deleteAction) throw new Error(`本轮任务 ${taskName} 没有可见删除入口，无法安全回收任务记录。`);
  const nativeDialog = page.waitForEvent('dialog', { timeout: 2_000 })
    .then((dialog) => dialog.accept())
    .catch(() => undefined);
  await deleteAction.click();
  const confirm = await visibleLast([
    page.getByRole('button', { name: /^(?:确\s*定|确\s*认)$/ }).filter({ visible: true }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /^(?:确\s*定|确\s*认)$/ }),
  ]);
  if (confirm) await confirm.click();
  await nativeDialog;
  await expect(ftpListRows(page, /文件名称/).filter({ hasText: taskName }))
    .toHaveCount(0, { timeout: 15_000 });
}

test.describe('FS-03-01｜FTP/SFTP｜自动建表任务执行与数据一致', () => {
  test('FS-03-01｜FTP/SFTP｜新建唯一 SFTP 任务并核验导入数据一致', async ({ loginPage, consoleErrors, report }) => {
    test.setTimeout(300_000);
    const page = loginPage;
    const sftp = requireSftpProfile();
    const suffix = `${Date.now().toString(36)}_${uuid()}`;
    const taskName = `E2E_FS0301_SFTP_${suffix.toUpperCase()}`;
    const tableName = `e2e_fs0301_sftp_${suffix}`.toLowerCase();
    const expectedFileName = `${BASE}_${today()}`;

    let dataVerified = false;
    let taskCreated = false;
    let taskDeleted = false;
    let taskCleanupError: unknown;
    let tableCleanupError: unknown;
    let tableCleanupSkipped = false;
    let originalError: unknown;
    try {
      await openFtpAccessList(page);
      await clickButton(page, /新建接入|新增接入/);
      await expect(page.getByText('来源文件', { exact: true }).filter({ visible: true }).last()).toBeVisible({ timeout: 15_000 });
      await page.getByRole('radio', { name: /^sftp$/i }).last().check();
      await fillByLabel(page, '地址', HOST);
      await fillByLabel(page, '端口', PORT);
      await fillByLabel(page, '用户名', sftp.username);
      await fillByLabel(page, '密码', sftp.password);
      await fillByLabel(page, '文件', PATH);
      await fillNearLabel(page, '基础文件名', BASE);
      await configureDateRule(page);
      await selectByLabel(page, '数据源类型', testEnvironment.dataSourceNames.fileAccess.type);
      await selectByLabel(page, '数据源名称', testEnvironment.dataSourceNames.fileAccess.name);
      await selectByLabel(page, '数据库名称', testEnvironment.dataSourceNames.fileAccess.database);
      await selectByLabel(page, 'Schema', testEnvironment.dataSourceNames.fileAccess.schema);
      const automaticTable = page.getByRole('radio', { name: '自动建表', exact: true }).last();
      await automaticTable.click();
      await expect(automaticTable).toBeChecked({ timeout: 5_000 });
      await fillAutomaticTable(page, tableName);

      const connectionResponse = page.waitForResponse(
        (response) => response.request().method() === 'POST' && /(?:saveFtpServerConfig|ftp.*connect|connect.*ftp)/i.test(response.url()),
        { timeout: 30_000 },
      );
      await clickButton(page, /测试连接/);
      const connected = await connectionResponse;
      const connectionBody = await connected.text().catch(() => '');
      if (connected.status() >= 300 || /失败|错误|异常|fail|error/i.test(connectionBody)) {
        throw new Error(`SFTP 测试连接失败：${connected.status()} ${redactSensitive(connectionBody).slice(0, 300)}`);
      }

      await clickButton(page, /预览文件名/);
      await expect(page.getByText(expectedFileName).filter({ visible: true }).last()).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press('Escape').catch(() => undefined);
      await clickButton(page, /数据预览/);
      const preview = page.locator('.el-dialog:visible, .ant-modal:visible, [role="dialog"]:visible').last();
      await expect(preview).toBeVisible({ timeout: 15_000 });
      await expect(preview.locator('table:visible, tbody:visible, pre:visible, [class*="content"]:visible').first()).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press('Escape').catch(() => undefined);

      await clickButton(page, /下一步/);
      await expect(page.getByText(/字段映射|目标映射|来源字段/).filter({ visible: true }).last()).toBeVisible({ timeout: 15_000 });
      await clickButton(page, /下一步/);
      await page.getByLabel('任务名称', { exact: true }).filter({ visible: true }).last().fill(taskName);
      const retry = page.getByRole('spinbutton').filter({ visible: true }).last();
      if (await retry.isVisible().catch(() => false)) await retry.fill('0');

      const saveResponse = page.waitForResponse(
        (response) => response.request().method() === 'POST' && /createFtpInsertDataTaskJob/i.test(response.url()),
        { timeout: 30_000 },
      );
      await clickButton(page, /^确\s*定$/);
      const saved = await (await saveResponse).json().catch(() => undefined) as { code?: string; message?: string } | undefined;
      if (saved?.code !== '000000') {
        const reason = saved?.message ? redactSensitive(saved.message).slice(0, 500) : '无响应详情';
        throw new Error(`SFTP 建表任务保存失败（code=${saved?.code ?? '未知'}）：${reason}`);
      }
      await expect.poll(async () => {
        const text = await page.locator('body').innerText().catch(() => '');
        return /创建成功|保存成功|同步任务已创建|接入任务已创建/.test(text) || !/ftpAccessCreate/i.test(page.url());
      }, { timeout: 30_000 }).toBe(true);
      taskCreated = true;

      await executeExistingFtpTaskAndVerifyLog(page, taskName);
      const rows = await query(`SELECT * FROM \`${tableName}\``);
      expect(rows).toHaveLength(EXPECTED_ROWS.length);
      expect(rows.map((row) => Object.keys(row))).toHaveLength(1);
      expect(Object.keys(rows[0]).sort()).toEqual([...EXPECTED_COLUMNS].sort());
      const actualRows = rows.map((row) => EXPECTED_COLUMNS.map((column) => normalizeCell(row[column])))
        .sort((left, right) => left.join('\u0000').localeCompare(right.join('\u0000')));
      expect(actualRows).toEqual(EXPECTED_ROWS);
      await assertNoConsoleErrors(consoleErrors);
      dataVerified = true;
    } catch (error) {
      originalError = error;
    } finally {
      if (taskCreated) {
        try {
          await deleteOwnedSftpTaskRecord(page, taskName);
          taskDeleted = true;
        } catch (error) {
          taskCleanupError = error;
          tableCleanupSkipped = true;
        }
      }
      if (taskDeleted) {
        try {
          await query(`DROP TABLE IF EXISTS \`${tableName}\``);
        } catch (error) {
          tableCleanupError = error;
        }
      }
    }

    if (originalError) throw originalError;
    if (!dataVerified) throw new Error('FS-03-01 页面或数据库校验未完成。');
    if (taskCleanupError) {
      const reason = taskCleanupError instanceof Error ? taskCleanupError.message : String(taskCleanupError);
      throw new Error(`本轮唯一任务 ${taskName} 回收失败，已跳过同名表 DROP 以保留任务引用：${reason}`);
    }
    if (tableCleanupError) {
      const reason = tableCleanupError instanceof Error ? tableCleanupError.message : String(tableCleanupError);
      throw new Error(`本轮唯一任务 ${taskName} 已回收，但同名表 ${tableName} 清理失败：${reason}`);
    }
    await report('FTP/SFTP-自动建表与数据一致', true, `本轮唯一任务=${taskName}；唯一表=${tableName}；实例终态、执行日志和 DB 全行值均已通过。`);
  });
});
