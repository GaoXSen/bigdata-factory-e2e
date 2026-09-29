/**
 * DI-02-02｜数据接入｜已建自动表任务重复同步
 *
 * 不再依赖已不存在的 gs_test_YYYYMMDD 历史任务：先按当前 FTP profile 创建本轮唯一
 * 任务（自动建表使用同一唯一英文表名），随后对同一任务真实执行两次；每轮都要求
 * 绑定该任务的成功接入实例累计数严格递增，并核对新增成功实例的执行日志。
 * maxRetry 是调度最大重试次数，不是“文件名末位 0 清空、非 0 追加”的增量模式；
 * 本用例不恢复该旧规则。
 */
import { test } from '../utils.js';
import { assertNoConsoleErrors } from '../utils.js';
import {
  createOwnedFtpConnectionFixture,
  deleteOwnedFtpConnectionFixture,
  executeOwnedFtpTaskRepeatedlyAndVerifyLogs,
} from './FTP接入执行工具.js';
import { requireFtpProfile, testEnvironment } from '../../../test-environment.js';

/** 本轮唯一英文命名前缀；创建/清理函数只允许精确匹配该前缀下本轮名称的任务。 */
const OWNED_TASK_PREFIX = 'di0202_';

test.describe('DI-02-02｜数据接入｜已建自动表任务重复同步', () => {
  test('DI-02-02｜数据接入｜本轮唯一FTP任务可重复执行并产生成功实例日志', async ({ loginPage, consoleErrors, report }) => {
    // 前置准入必须在进入页面前完成；缺失时只列变量名，不回显任何变量值，也不回退 SFTP 凭据。
    const ftp = testEnvironment.fileTransfer.ftp;
    const missingFtpEnv = [
      ftp.host ? undefined : 'FTP_HOST',
      ftp.port > 0 ? undefined : 'FTP_PORT',
      ftp.username ? undefined : 'FTP_USER',
      ftp.password ? undefined : 'FTP_PASS',
    ].filter((name): name is string => !!name);
    test.skip(missingFtpEnv.length > 0, `缺少 FTP 传输 profile 环境变量：${missingFtpEnv.join('、')}；无法创建本轮唯一夹具。`);
    const profile = requireFtpProfile();

    const page = loginPage;
    // 两次真实执行加每轮实例等待与日志核对，时限与重链路用例同口径。
    test.setTimeout(480_000);
    const taskName = await createOwnedFtpConnectionFixture(page, { profile, taskPrefix: OWNED_TASK_PREFIX });
    let cleanupError: unknown;
    try {
      // 对本轮唯一任务真实执行两次；实例与执行日志都按唯一锚点绑定，不取任意首行。
      const successInstances = await executeOwnedFtpTaskRepeatedlyAndVerifyLogs(page, taskName, {
        executions: 2,
        instanceTimeoutMs: 90_000,
      });
      await assertNoConsoleErrors(consoleErrors);
      await report(
        'FTP接入-重复同步',
        true,
        `本轮唯一 FTP 任务=${taskName}（自动建表同名截断表名）真实执行 2 次，绑定该任务的成功接入实例累计 ${successInstances} 个，`
        + '每轮新增成功实例的执行日志均有明确完成结果；最后仅按精确名称清理本轮任务。',
      );
    } finally {
      try {
        await deleteOwnedFtpConnectionFixture(page, taskName, { taskPrefix: OWNED_TASK_PREFIX });
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) {
      throw new Error(`本轮唯一夹具 ${taskName} 精确清理失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
  });
});
