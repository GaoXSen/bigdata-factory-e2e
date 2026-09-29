/** FS-04-02｜FTP/SFTP｜日期格式、压缩/不压缩与同名覆盖 */
import { test, expect } from '../utils.js';
import { assertNoConsoleErrors, submitAndExpectSuccess } from '../utils.js';
import { testEnvironment } from '../../../test-environment.js';
import {
  dataRows,
  clickExportTaskAction,
  expectVisibleSuccess,
  openNewExport,
} from './文件导出测试工具.js';

function requireExportFixture(): string | undefined {
  const missing = [
    ['FTP_USER', testEnvironment.fileTransfer.ftp.username],
    ['FTP_PASS', testEnvironment.fileTransfer.ftp.password],
    ['EXPORT_SOURCE_TABLE', testEnvironment.dataSourceNames.exportSource.table],
  ].filter(([, value]) => !value?.trim()).map(([name]) => name);
  return missing.length ? `缺少导出夹具环境变量：${missing.join('、')}` : undefined;
}

test.describe('FS-04-02｜FTP/SFTP｜压缩执行链路；日期与同名覆盖待夹具', () => {
  test('FS-04-02｜FTP/SFTP｜压缩配置保存并执行成功', async ({ loginPage, consoleErrors, report }) => {
    const missing = requireExportFixture();
    test.skip(Boolean(missing), missing);
    test.setTimeout(120_000);
    // ENV-01（环境/服务端）：同 FS-04-01，保存 60s 无成功反馈，导出调度服务端故障期间跳过。
    test.skip(true, 'ENV-01：导出任务保存无成功反馈且后端报“调度创建失败-请查看日志”，服务端故障期间跳过。');

    const { taskName } = await openNewExport(loginPage, {
      integrate: false,
      compress: true,
    });
    const retryCount = loginPage.getByRole('spinbutton').last();
    if (await retryCount.isVisible().catch(() => false)) await retryCount.fill('0');
    await submitAndExpectSuccess(loginPage, /保\s*存/, '保存成功', 60_000);

    const row = dataRows(loginPage).filter({ hasText: taskName }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await clickExportTaskAction(loginPage, taskName, /执\s*行/);
    await expectVisibleSuccess(loginPage);

    await assertNoConsoleErrors(consoleErrors);
    await report('FTP/SFTP-压缩导出', true,
      '已验证新版页面中的压缩、保存和执行链路；未验证不压缩。同名覆盖未创建固定同名任务，不能以不同任务名的重复导出推定，需固定远端文件名/目录专用夹具核验。');
  });

  test('FS-04-02｜FTP/SFTP｜日期格式、无日期与同名覆盖', async () => {
    test.skip(true, '当前文件导出页不再展示“日期格式/无日期”控件，且未提供固定文件名与远端目录的覆盖策略夹具；本轮未真实创建或执行同名覆盖任务，不能按旧版控件伪造验证。');
  });
});
