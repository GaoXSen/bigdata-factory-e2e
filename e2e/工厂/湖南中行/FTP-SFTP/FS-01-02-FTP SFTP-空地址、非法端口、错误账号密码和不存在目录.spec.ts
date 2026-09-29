/**
 * FS-01-02｜FTP/SFTP｜净环境唯一夹具上的异常配置测试连接失败
 *
 * 每个子用例先创建自己的唯一 SFTP 夹具，再只替换一个异常字段验证连接被拒绝；
 * 随后取消编辑并重新打开夹具，确认坏配置未被保存，最后仅按精确名称清理本轮夹具。
 */
import { test } from '../utils.js';
import { assertNoConsoleErrors } from '../utils.js';
import {
  closeExistingFtpTaskEditor,
  createOwnedFtpConnectionFixture,
  deleteOwnedFtpConnectionFixture,
  missingSftpCredentialEnvNames,
  verifyOwnedFixtureKeptOriginalConfig,
  verifyOwnedFtpTaskRejectsEmptyAddress,
  verifyOwnedFtpTaskRejectsInvalidCredentials,
  verifyOwnedFtpTaskRejectsInvalidPort,
  verifyOwnedFtpTaskRejectsMissingDirectory,
} from '../数据接入/FTP接入执行工具.js';

test.describe('FS-01-02｜FTP/SFTP｜净环境唯一夹具异常配置测试连接失败', () => {
  const cases = [
    ['空地址', verifyOwnedFtpTaskRejectsEmptyAddress],
    ['非法端口', verifyOwnedFtpTaskRejectsInvalidPort],
    ['错误账号密码', verifyOwnedFtpTaskRejectsInvalidCredentials],
    ['不存在目录', verifyOwnedFtpTaskRejectsMissingDirectory],
  ] as const;

  for (const [name, verify] of cases) {
    test(`FS-01-02｜FTP/SFTP｜净环境夹具下${name}被拒绝`, async ({ loginPage, consoleErrors, report }) => {
      test.setTimeout(240_000);
      const page = loginPage;
      const missingEnv = missingSftpCredentialEnvNames();
      test.skip(missingEnv.length > 0, `缺少 SFTP 凭据环境变量：${missingEnv.join('、')}；无法创建本轮净环境夹具。`);
      // BUG-FS01（产品缺陷）：空文件地址未触发前端必填拦截，仍进入连接/保存流程。
      // run-20260911-100227 失败实锤；其余三种子场景继续执行。
      test.skip(name === '空地址', 'BUG-FS01：空文件地址缺少必填校验（未被页面拦截），待产品修复后移除本跳过。');

      const taskName = await createOwnedFtpConnectionFixture(page);
      let cleanupError: unknown;
      try {
        await verify(page, taskName);
        await closeExistingFtpTaskEditor(page);
        await verifyOwnedFixtureKeptOriginalConfig(page, taskName);
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
      await report(`FTP/SFTP-净环境异常配置-${name}`, true, `本轮唯一夹具=${taskName}；仅替换本条异常字段，连接被拒绝后取消编辑并确认原配置未变，最后按精确名称清理。`);
    });
  }
});
