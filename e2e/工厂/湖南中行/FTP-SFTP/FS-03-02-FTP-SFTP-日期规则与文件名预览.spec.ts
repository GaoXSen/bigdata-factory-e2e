/**
 * FS-03-02｜FTP/SFTP｜文件日期规则与文件名预览
 *
 * 在“新建接入”页配置日期前分隔符“_”、日期维度“日”、日期偏移“0”，
 * 点击预览并校验文件名。全程不进入下一步或保存，不创建接入任务。
 */
import { test, expect } from '../utils.js';
import { assertNoConsoleErrors } from '../utils.js';
import { openFtpAccessList } from '../数据接入/FTP接入执行工具.js';

test.describe('FS-03-02｜FTP/SFTP｜文件日期规则与文件名预览', () => {
  test.beforeEach(async ({ loginPage }) => {
    await openFtpAccessList(loginPage);
  });

  test('FS-03-02｜FTP/SFTP｜下划线+日+0偏移生成当日文件名', async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;
    const create = page.getByRole('button', { name: /新建接入/ }).filter({ visible: true }).last();
    await expect(create).toBeVisible({ timeout: 15_000 });
    await create.click();
    await expect(page.getByText('来源文件', { exact: true }).filter({ visible: true }).last())
      .toBeVisible({ timeout: 10_000 });

    await fillBaseFileName(page, 'gs_test');
    await selectFileDateRule(page, ['_', '空', '空', '日', '0']);

    const preview = page.getByRole('button', { name: /预览文件名/ }).filter({ visible: true }).last();
    await expect(preview).toBeVisible({ timeout: 10_000 });
    await preview.click();
    const today = new Date();
    const date = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    await expect(page.getByText(new RegExp(`gs_test_${date}`)).filter({ visible: true }).last())
      .toBeVisible({ timeout: 10_000 });

    const cancel = page.getByRole('button', { name: /取\s*消/ }).filter({ visible: true }).last();
    await expect(cancel).toBeVisible({ timeout: 5_000 });
    await cancel.click();
    await assertNoConsoleErrors(consoleErrors);
    await report('FTP/SFTP-文件日期规则-当日文件名预览', true, `规则：_ + 日 + 0；预览：gs_test_${date}`);
  });
});

async function fillBaseFileName(page: import('@playwright/test').Page, value: string): Promise<void> {
  const label = page.getByText('基础文件名', { exact: true }).filter({ visible: true }).last();
  await expect(label).toBeVisible({ timeout: 10_000 });
  for (let depth = 0, scope = label.locator('..'); depth < 3; depth += 1, scope = scope.locator('..')) {
    const input = scope.locator('input:visible').last();
    if (await input.count() && await input.isVisible().catch(() => false)) {
      await input.fill(value);
      return;
    }
  }
  throw new Error('新建 FTP 接入页未找到“基础文件名”输入框。');
}

/** 新建页前五个下拉框固定对应：日期前、日期后、全量/增量、日期维度、日期偏移。 */
async function selectFileDateRule(page: import('@playwright/test').Page, values: string[]): Promise<void> {
  const combos = page.locator('[role="combobox"]:visible');
  if (await combos.count() < 5) throw new Error('新建 FTP 接入页的文件日期配置下拉框不足 5 个。');

  for (const [index, value] of values.entries()) {
    await combos.nth(index).click();
    const option = page.locator(
      '.el-select-dropdown:visible li:visible, .ant-select-dropdown:visible [role="option"]:visible, [role="listbox"]:visible [role="option"]:visible',
    ).filter({ hasText: new RegExp(`^\\s*${escapeRegExp(value)}\\s*$`) }).last();
    await expect(option).toBeVisible({ timeout: 5_000 });
    await option.click();
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
