import type { Locator, Page } from '@playwright/test';
import { assertNoConsoleErrors, clickMenu, expect, test } from '../utils.js';

async function firstVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    const count = await candidate.count();
    for (let index = count - 1; index >= 0; index--) {
      const item = candidate.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return undefined;
}

/** 点击“新建接入”后，确认已经进入真实的两步式文件接入表单。 */
async function openFileAccessForm(page: Page): Promise<void> {
  const formMarker = page.getByText(/上传文件/).filter({ visible: true }).last();
  if (!(await formMarker.isVisible().catch(() => false))) {
    const newButton = await firstVisible([
      page.getByRole('button', { name: /新建接入|新增接入/ }),
      page.locator('button:visible').filter({ hasText: /新建接入|新增接入/ }),
    ]);
    if (!newButton) throw new Error(`文件接入“新建接入”按钮未找到，当前页面：${page.url()}`);
    await newButton.click();
  }
  await expect(page.getByText(/上传文件/).filter({ visible: true }).last()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: /选择文件/ }).filter({ visible: true }).last()).toBeVisible({ timeout: 10_000 });
}

test.describe('DI-01-03｜数据接入｜未上传文件直接下一步的必填校验', () => {
  test.beforeEach(async ({ loginPage }) => {
    await clickMenu(loginPage, '数据接入', '文件接入');
  });

  test('DI-01-03｜数据接入｜未上传文件时阻止进入下一步', async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;
    await openFileAccessForm(page);
    await page.getByRole('button', { name: /下一步|确\s*认/ }).first().click();
    await expect(page.getByText(/必填|不能为空|请选择|请上传|请输入/).filter({ visible: true }).first()).toBeVisible();
    await assertNoConsoleErrors(consoleErrors);
    await report('文件接入-未上传文件-下一步必填校验', true);
  });
});
