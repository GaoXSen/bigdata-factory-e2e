/**
 * DI-00-02｜数据接入｜SFTP 当前环境基线任务初始化
 *
 * 专门创建可供 DI/FS 回归复用的 110 /source/gs_test_ 当日文件任务。
 * 历史 113 任务不得作为 110 环境的连接、预览、执行或异常校验夹具。
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect, fillByLabel, selectByLabel } from '../utils.js';
import { assertNoConsoleErrors } from '../utils.js';
import { openFtpAccessList } from './FTP接入执行工具.js';
import { requireSftpProfile, testEnvironment } from '../../../test-environment.js';

// SFTP 物理连接只来自 e2e/test-environment.ts 的 SFTP profile（与 FTP 严格分离）；
// SFTP_HOST/SFTP_PORT/SFTP_PATH 仍可单项覆盖。凭据不再写死在代码里，进入用例时由
// requireSftpProfile() 校验：缺失时抛出只含变量名的可读错误，不回退任何默认账号密码。
const HOST = testEnvironment.fileTransfer.sftp.host;
const PORT = String(testEnvironment.fileTransfer.sftp.port);
const PATH = testEnvironment.fileTransfer.sftp.baseDir;
// 基础文件名取 SFTP profile 的 baseFile（去扩展名），日期文件形如 gs_test_YYYYMMDD。
const BASE = testEnvironment.fileTransfer.sftp.baseFile.replace(/\.[^./]+$/, '');

function today(): string {
  const value = new Date();
  return `${value.getFullYear()}${String(value.getMonth() + 1).padStart(2, '0')}${String(value.getDate()).padStart(2, '0')}`;
}

async function visibleLast(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    for (let i = await candidate.count() - 1; i >= 0; i -= 1) {
      if (await candidate.nth(i).isVisible().catch(() => false)) return candidate.nth(i);
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
  for (let i = 0; i < 5; i += 1, scope = scope.locator('..')) {
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
  for (let i = await labels.count() - 1; i >= 0; i -= 1) {
    let scope = labels.nth(i);
    for (let depth = 0; depth < 5; depth += 1, scope = scope.locator('..')) {
      const input = scope.locator('input:visible:not([type="radio"]):not([type="checkbox"])').last();
      if (await input.isVisible().catch(() => false)) {
        await input.fill(table);
        return;
      }
    }
  }
  // 当前页面右侧“表”标签与输入框是并列结构，未必有可向上回溯的表单祖先。
  // 自动建表切换成功后，最后一个普通文本框即为目标表名。
  const fallback = page.locator('input:visible:not([type="radio"]):not([type="checkbox"]):not([type="password"])').last();
  if (await fallback.isVisible().catch(() => false)) {
    await fallback.fill(table);
    return;
  }
  throw new Error('未找到自动建表的目标表输入框。');
}

test.describe('DI-00-02｜数据接入｜SFTP 当前环境基线任务初始化', () => {
  test('DI-00-02｜数据接入｜新建 110 /source gs_test 自动建表基线任务', async ({ loginPage, consoleErrors, report }) => {
    test.setTimeout(150_000);
    const page = loginPage;
    // 凭据校验前移：SFTP_USER/SFTP_PASS 缺失时立即给出可读错误，不做任何页面操作。
    const sftp = requireSftpProfile();
    const suffix = `${today()}_${Date.now().toString().slice(-6)}`;
    const taskName = `E2E_SFTP_GS_110_${suffix}`;
    const tableName = `e2e_sftp_gs_110_${suffix}`;
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
    const auto = page.getByRole('radio', { name: '自动建表', exact: true }).last();
    await auto.click();
    await expect(auto).toBeChecked({ timeout: 5_000 });
    await fillAutomaticTable(page, tableName);

    const connection = page.waitForResponse((response) => response.request().method() === 'POST' && /(?:saveFtpServerConfig|ftp.*connect|connect.*ftp)/i.test(response.url()), { timeout: 30_000 });
    await clickButton(page, /测试连接/);
    const response = await connection;
    const body = await response.text().catch(() => '');
    if (response.status() >= 300 || /失败|错误|异常|fail|error/i.test(body)) throw new Error(`SFTP 测试连接失败：${response.status()} ${body.slice(0, 300)}`);

    await clickButton(page, /预览文件名/);
    await expect(page.getByText(new RegExp(`${BASE}_${today()}`)).filter({ visible: true }).last()).toBeVisible({ timeout: 10_000 });
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
    await clickButton(page, /^确\s*定$/);
    await expect.poll(async () => {
      const text = await page.locator('body').innerText();
      return /创建成功|保存成功|同步任务.*创建/.test(text) || !/ftpAccessCreate/.test(page.url());
    }, { timeout: 30_000 }).toBe(true);
    await assertNoConsoleErrors(consoleErrors);
    await report('SFTP当前环境基线初始化', true, `任务=${taskName}；表=${tableName}；来源=${HOST}${PATH}/${BASE}_${today()}；目标=${testEnvironment.dataSourceNames.fileAccess.type} ${testEnvironment.dataSourceNames.fileAccess.name}。`);
  });
});
