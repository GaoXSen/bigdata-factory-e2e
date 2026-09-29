/**
 * DM-11-01｜数据地图｜业务分类目录新增和批量挂载表
 *
 * 只创建本轮唯一目录；批量操作只选择页面当前已存在的表，不修改表本身。
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect, uuid, clickMenu } from '../utils.js';
import { assertNoConsoleErrors } from '../utils.js';

async function visibleLast(candidates: Locator[]): Promise<Locator | undefined> {
  for (const locator of candidates) {
    for (let index = await locator.count() - 1; index >= 0; index -= 1) {
      const item = locator.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return undefined;
}

async function clickPageAction(page: Page, name: RegExp): Promise<void> {
  const action = await visibleLast([
    page.getByRole('button', { name }),
    page.getByRole('link', { name }),
    page.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }),
    page.locator('[aria-label*="新增" i]:visible, [title*="新增" i]:visible'),
    page.locator('[aria-label*="plus" i]:visible, [title*="plus" i]:visible').locator('..'),
  ]);
  if (!action) throw new Error(`业务分类管理页面未找到操作“${name}”，当前页面：${page.url()}`);
  await action.click();
  await page.waitForTimeout(500);
}

async function visibleDialog(page: Page): Promise<Locator> {
  const dialog = await visibleLast([page.getByRole('dialog'), page.locator('.el-dialog:visible, .ant-modal:visible')]);
  if (!dialog) throw new Error(`业务分类操作弹窗未打开，当前页面：${page.url()}`);
  return dialog;
}

async function clickDialogAction(page: Page, name: RegExp): Promise<void> {
  const dialog = await visibleDialog(page);
  // 当前页面使用 Ant Design Vue：按钮文字被拆进 span 且含显示空格，
  // 语义定位在某些版本不会暴露为 role=button/name。新增、编辑、删除确认
  // 都使用弹窗 footer 的主按钮，优先按真实结构点击。
  const primary = page.locator(
    '.ant-modal:visible .ant-modal-footer .ant-btn-primary:visible, ' +
      '.el-dialog:visible .el-dialog__footer .el-button--primary:visible',
  ).last();
  if (await primary.isVisible().catch(() => false)) {
    await primary.click();
    await page.waitForTimeout(500);
    return;
  }
  const action = await visibleLast([
    page.getByText(name, { exact: false }),
    page.locator(
      '.ant-modal-wrap:visible .ant-modal-footer button:visible, ' +
        '.ant-modal-wrap:visible .ant-modal-footer [role="button"]:visible, ' +
        '.el-dialog:visible .el-dialog__footer button:visible',
    ).filter({ hasText: name }),
    dialog.getByRole('button', { name }),
    dialog.locator(
      'button:visible, a:visible, [role="button"]:visible, ' +
        '.ant-btn:visible, .el-button:visible, [class*="btn"]:visible',
    ).filter({ hasText: name }),
    dialog.getByText(name, { exact: false }),
  ]);
  if (!action) throw new Error(`业务分类弹窗内未找到操作“${name}”。`);
  await action.click();
  await page.waitForTimeout(500);
}

/** 业务分类新增入口是标题右侧纯 plus 图标，不是“新增”文字按钮。 */
async function clickAddDirectory(page: Page): Promise<void> {
  const title = page.getByText('业务分类', { exact: true }).last();
  await expect(title).toBeVisible({ timeout: 10_000 });
  const header = title.locator('..');
  const plus = await visibleLast([
    header.getByText(/图标:\s*plus/i, { exact: false }),
    header.locator('[aria-label*="plus" i]:visible, [title*="plus" i]:visible, [class*="plus" i]:visible'),
  ]);
  if (!plus) throw new Error('业务分类标题右侧未找到新增加号图标。');
  await plus.click();
  await page.waitForTimeout(300);
}

async function fillFirstDialogText(page: Page, value: string): Promise<void> {
  const dialog = await visibleDialog(page);
  const fields = dialog.getByRole('textbox').filter({ visible: true });
  if (!(await fields.count())) throw new Error('业务分类弹窗没有可见文本框。');
  await fields.first().fill(value);
}

async function expectSuccess(page: Page): Promise<void> {
  await expect(page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
    .filter({ hasText: /成功|保存|创建|更新|挂载/ }).last()).toBeVisible({ timeout: 15_000 });
}

async function findDirectoryScope(page: Page, name: string): Promise<Locator> {
  const target = page.getByText(name, { exact: true }).last();
  await expect(target).toBeVisible({ timeout: 10_000 });
  let scope = target;
  for (let level = 0; level < 8; level += 1) {
    if (await scope.locator('button:visible, a:visible, [role="button"]:visible').count()) return scope;
    scope = scope.locator('..');
  }
  return target.locator('..');
}

async function clickScopedAction(scope: Locator, name: RegExp): Promise<void> {
  const action = await visibleLast([
    scope.getByRole('button', { name }),
    scope.getByRole('link', { name }),
    scope.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }),
  ]);
  if (!action) throw new Error(`业务分类“${await scope.innerText().catch(() => '')}”未找到操作“${name}”。`);
  await action.click();
}

async function batchMountExistingTable(page: Page, directoryName: string): Promise<void> {
  // “批量操作”是下拉菜单，第一击只展开“批量挂载/批量移除”选项。
  await clickPageAction(page, /^批量操作$/);
  const mount = await visibleLast([
    page.getByText('批量挂载', { exact: true }),
    page.getByRole('menuitem', { name: '批量挂载', exact: true }),
  ]);
  if (!mount) throw new Error('批量操作菜单未显示“批量挂载”。');
  await mount.click();
  await page.waitForTimeout(300);
  const dialog = await visibleDialog(page);
  const checkboxes = dialog.locator('input[type="checkbox"]:visible, .el-checkbox:visible, .ant-checkbox-wrapper:visible');
  if (!(await checkboxes.count())) throw new Error('批量挂载弹窗没有可选择的数据表，无法验证业务分类挂载。');
  await checkboxes.last().click();

  const combobox = dialog.getByRole('combobox').last();
  if (await combobox.isVisible().catch(() => false)) {
    await combobox.click();
    const option = page.getByRole('option', { name: directoryName, exact: true }).last();
    if (await option.isVisible().catch(() => false)) await option.click();
  }
  await clickDialogAction(page, /挂载|确定|保存/);
  await expectSuccess(page);
}

test('DM-11-01｜数据地图｜业务分类目录新增和批量挂载表', async ({ loginPage, consoleErrors, report }) => {
  const page = loginPage;
  await clickMenu(page, '数据地图', '系统管理', '业务分类管理');
  const directoryName = `E2E业务分类_${uuid()}`;
  await clickAddDirectory(page);
  await fillFirstDialogText(page, directoryName);
  await clickDialogAction(page, /确定|保存|创建|提交/);
  await expectSuccess(page);

  // 录制流程确认：业务分类树本身只支持新增目录；右侧“编辑/移除”针对的是
  // 已挂载的数据表，不能误作为目录编辑、删除能力测试。
  const directory = page.getByText(directoryName, { exact: true });
  await expect(directory).toBeVisible();
  // “批量挂载”会挂到当前左树选中的分类；未选分类时页面仅提示
  // “请选择业务分类”，不会打开挂载弹窗。
  await directory.click();
  await page.waitForTimeout(300);
  await batchMountExistingTable(page, directoryName);
  await assertNoConsoleErrors(consoleErrors);
  await report('业务分类-新增目录并批量挂载已有表', true);
});
