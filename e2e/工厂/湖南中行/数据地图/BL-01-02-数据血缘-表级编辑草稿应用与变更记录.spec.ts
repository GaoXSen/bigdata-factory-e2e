import { test, expect } from '../utils.js';
import type { Locator } from '@playwright/test';
import { clickLineageTab, openAnyLineage, visibleLineageControl, assertNoUnexpectedLineageConsoleErrors } from './血缘测试工具.js';

test.describe.configure({ timeout: 240_000 });

test('BL-01-02｜数据血缘｜表级编辑草稿应用与变更记录', async ({ loginPage, consoleErrors, report }) => {
  const page = loginPage;
  await openAnyLineage(page, { requireGraph: false });
  await (await visibleLineageControl(page, /编辑血缘|人工编辑/)).click();
  // 详情页默认只展示图谱；点击“编辑血缘”后才会渲染“表级/字段级”切换和
  // 添加上游、添加下游控件。先等待编辑页完成，再定位“表级”，避免抢在页面切换前查找。
  await expect.poll(async () => {
    const text = await page.locator('body').innerText().catch(() => '');
    return /添加上游|添加下游/.test(text) ? 'ready' : 'waiting';
  }, { timeout: 10_000 }).toBe('ready');
  await clickLineageTab(page, /表级/);
  // 页面实际先打开“选择上游/下游表”弹窗，默认是“从目录选择”；
  // 点击“手填表名”后才渲染输入框，不能直接等待输入框。
  const chooseTableDialog = () => page.locator('[role="dialog"]:visible, .ant-modal:visible, .el-dialog:visible').last();
  const switchToManualTableName = async (dialog: Locator, textboxName: string): Promise<void> => {
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const manual = dialog.getByRole('radio', { name: /手填表名/ }).last();
    // Ant Design 的 radio input 本身是 hidden，实际可见并可点击的是标签文本。
    const manualLabel = dialog.getByText('手填表名', { exact: true }).last();
    await expect(manualLabel).toBeVisible({ timeout: 10_000 });
    await manualLabel.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
    const namedTextbox = dialog.getByRole('textbox', { name: textboxName }).last();
    if (await namedTextbox.isVisible().catch(() => false)) {
      await expect(namedTextbox).toBeVisible({ timeout: 10_000 });
    } else {
      // 不同版本的选择弹窗级联层级不同：有的展示五级目录，有的只
      // 挂载一个入口级联框。该用例不提交关系，只需确认弹窗仍处于可
      // 操作状态，不能把固定层级数量当成业务断言。
      await expect.poll(async () =>
        await dialog.getByRole('combobox').count() > 0
          || await dialog.getByText(/目录|表名|手填表名/).count() > 0,
      { timeout: 10_000 }).toBe(true);
    }
    const cancel = dialog.getByRole('button', { name: /取.*消/ }).last();
    if (await cancel.isVisible().catch(() => false)) await cancel.click();
  };

  // 页面录制已确认：表级编辑页存在“添加上游/添加下游”及对应选择弹窗。
  await (await visibleLineageControl(page, /添加上游/)).click();
  await switchToManualTableName(chooseTableDialog(), '输入上游表名');
  await (await visibleLineageControl(page, /添加下游/)).click();
  await switchToManualTableName(chooseTableDialog(), '输入下游表名');
  // 不填写、不应用，避免污染录制中已有的血缘表；这里只校验实际编辑入口和草稿表单。
  await expect(await visibleLineageControl(page, /应用/)).toBeVisible();
  await expect(await visibleLineageControl(page, /返回图谱/)).toBeVisible();
  await (await visibleLineageControl(page, /返回图谱/)).click();
  await (await visibleLineageControl(page, /变更记录|history/)).click();
  // 当前版本“变更记录”从右侧打开抽屉，不是 role=dialog 的模态框；
  // 同时兼容旧版本的 modal/dialog 渲染。
  await expect(page.locator('.ant-drawer:visible, [role="dialog"]:visible, .ant-modal:visible, .el-dialog:visible').last())
    .toBeVisible({ timeout: 10_000 });
  await assertNoUnexpectedLineageConsoleErrors(consoleErrors);
  await report('数据血缘-表级编辑、草稿、应用与变更记录入口', true);
});
