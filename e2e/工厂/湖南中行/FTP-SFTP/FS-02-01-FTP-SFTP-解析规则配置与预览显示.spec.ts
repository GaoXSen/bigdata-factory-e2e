/** FS-02-01｜FTP/SFTP｜解析规则配置与数据预览显示 */
import { test, expect } from '../utils.js';
import { assertNoConsoleErrors } from '../utils.js';
import {
  createOwnedFtpConnectionFixture,
  deleteOwnedFtpConnectionFixture,
  missingSftpCredentialEnvNames,
} from '../数据接入/FTP接入执行工具.js';

test.describe('FS-02-01｜FTP/SFTP｜owned解析规则与数据预览', () => {
  test('FS-02-01｜FTP/SFTP｜解析规则配置与预览显示', async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;
    const missingSftpEnv = missingSftpCredentialEnvNames();
    test.skip(
      missingSftpEnv.length > 0,
      `缺少 SFTP 凭据环境变量：${missingSftpEnv.join('、')}；无法创建本轮净环境 owned SFTP 夹具。`,
    );
    let taskName: string | undefined;

    try {
      taskName = await createOwnedFtpConnectionFixture(page);
      expect(taskName).toMatch(/^codex_fs01_[a-z0-9_]+$/);

      await assertNoConsoleErrors(consoleErrors);
      await report(
        'FTP/SFTP-解析规则-预览显示',
        true,
        '本轮 owned SFTP 任务创建成功；“数据预览”弹层和内容容器已可见。本用例不声明与服务器文件逐项一致。',
      );
    } finally {
      if (taskName) await deleteOwnedFtpConnectionFixture(page, taskName);
    }
  });
});
