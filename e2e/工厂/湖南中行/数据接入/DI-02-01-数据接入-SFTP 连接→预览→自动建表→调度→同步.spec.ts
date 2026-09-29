/**
 * DI-02-01｜数据接入｜本轮唯一 SFTP 夹具已验证自动建表配置
 *
 * 不复用任何 gs_test_ 历史任务：先按环境 SFTP profile 创建本轮唯一夹具，
 * 再验证该夹具可连通、可按当日文件预览，并且目标侧选择自动建表。
 */
import { test, clickMenu } from '../utils.js';
import { assertNoConsoleErrors } from '../utils.js';
import {
  closeExistingFtpTaskEditor,
  createOwnedFtpConnectionFixture,
  deleteOwnedFtpConnectionFixture,
  missingSftpCredentialEnvNames,
  verifyOwnedFtpTaskConnection,
} from './FTP接入执行工具.js';
import { testEnvironment } from '../../../test-environment.js';

test.describe('DI-02-01｜数据接入｜SFTP已验证自动建表配置', () => {
  test.beforeEach(async ({ loginPage }) => {
    await clickMenu(loginPage, '数据接入', 'ftp文件接入', '接入列表');
  });

  test('DI-02-01｜数据接入｜本轮唯一SFTP夹具连接、预览与自动建表配置', async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;
    test.setTimeout(240_000);
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
    await report('FTP接入-唯一夹具已验证自动建表配置', true, `本轮唯一夹具=${taskName}；创建页已断言测试连接成功、当日文件名与数据预览可见、自动建表已选中且数据源目标为 ${testEnvironment.dataSourceNames.fileAccess.type} ${testEnvironment.dataSourceNames.fileAccess.name}，保存后编辑页再次断言连接成功，最后仅按精确名称清理本轮夹具。`);
  });
});
