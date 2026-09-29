/**
 * FS-01-01｜FTP/SFTP｜净环境唯一夹具填写连接配置并测试连接
 *
 * 不复用任何 gs_test_ 历史任务：先按环境 SFTP profile 创建本轮唯一夹具，
 * 再打开该夹具的编辑页测试连接，最后只按精确名称清理本轮新建的夹具。
 */
import { test } from '../utils.js';
import { assertNoConsoleErrors } from '../utils.js';
import {
  closeExistingFtpTaskEditor,
  createOwnedFtpConnectionFixture,
  deleteOwnedFtpConnectionFixture,
  missingSftpCredentialEnvNames,
  verifyOwnedFtpTaskConnection,
} from '../数据接入/FTP接入执行工具.js';

test.describe('FS-01-01｜FTP/SFTP｜净环境唯一夹具测试连接成功', () => {
  test('FS-01-01｜FTP/SFTP｜本轮唯一 SFTP 夹具填写连接配置并测试连接成功', async ({ loginPage, consoleErrors, report }) => {
    test.setTimeout(240_000);
    const page = loginPage;
    const missingEnv = missingSftpCredentialEnvNames();
    test.skip(missingEnv.length > 0, `缺少 SFTP 凭据环境变量：${missingEnv.join('、')}；无法创建本轮净环境夹具。`);

    const taskName = await createOwnedFtpConnectionFixture(page);
    let cleanupError: unknown;
    try {
      await verifyOwnedFtpTaskConnection(page, taskName);
      await closeExistingFtpTaskEditor(page);
      await assertNoConsoleErrors(consoleErrors);
    } finally {
      try {
        await deleteOwnedFtpConnectionFixture(page, taskName);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) {
      throw new Error(`本轮唯一夹具 ${taskName} 精确清理失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    await report('FTP/SFTP-净环境连接测试', true, `本轮唯一夹具=${taskName}；创建页与已保存编辑页均测试连接成功，结束后仅按精确名称清理本轮夹具。`);
  });
});
