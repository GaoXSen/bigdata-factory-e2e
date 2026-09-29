/**
 * DI-02-03｜数据接入｜MySQL 默认非 copy 模式
 *
 * 不再依赖历史 gs_test_ 环境基线任务：先按当前 FTP profile 创建本轮唯一
 * 英文任务名的文件接入任务（自动建表同用唯一英文表名），保存后按唯一
 * 任务名重新打开编辑页，验证 MySQL 目标 copy 模式“否”默认选中且禁用。
 * Gauss copy 需要独立可用的数据源和表夹具，仍不在本用例覆盖范围内。
 */
import { expect, test } from '../utils.js';
import { assertNoConsoleErrors } from '../utils.js';
import {
  closeExistingFtpTaskEditor,
  createOwnedFtpConnectionFixture,
  deleteOwnedFtpConnectionFixture,
  openOwnedFtpTaskEditor,
} from './FTP接入执行工具.js';
import { requireFtpProfile, testEnvironment } from '../../../test-environment.js';

/** 本轮唯一英文命名前缀；清理函数只允许删除该前缀下精确匹配本轮名称的任务。 */
const OWNED_TASK_PREFIX = 'di0203_';

test.describe('DI-02-03｜数据接入｜MySQL默认非copy模式', () => {
  test('DI-02-03｜数据接入｜MySQL目标默认选择非copy', async ({ loginPage, consoleErrors, report }) => {
    // 前置准入必须在进入页面前完成；缺失时只列变量名，不回显任何变量值。
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
    test.setTimeout(240_000);
    const taskName = await createOwnedFtpConnectionFixture(page, { profile, taskPrefix: OWNED_TASK_PREFIX });
    let cleanupError: unknown;
    try {
      // 保存后按本轮唯一任务名重新打开编辑页，不按前缀或历史任务挑选。
      await openOwnedFtpTaskEditor(page, taskName);
      await expect(page.getByText('copy模式', { exact: true }).filter({ visible: true }).last())
        .toBeVisible({ timeout: 10_000 });
      // Element 组件把 radio 输入框放在 label 深层，不能按“copy模式”父节点直接查 input。
      // 角色语义同时能区分上方“首行为标题”的“否”和本行 copy 模式的禁用“否”。
      const copyNo = page.getByRole('radio', { name: '否', exact: true }).filter({ visible: true }).last();
      await expect(copyNo).toBeChecked({ timeout: 10_000 });
      await expect(copyNo).toBeDisabled();
      await closeExistingFtpTaskEditor(page);
      await assertNoConsoleErrors(consoleErrors);
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
    await report('FTP接入-MySQL非copy默认值', true, `本轮唯一 FTP 任务=${taskName}（自动建表同名截断表名），目标 ${testEnvironment.dataSourceNames.fileAccess.type} ${testEnvironment.dataSourceNames.fileAccess.name}；copy 模式默认且仅使用“否”，最后仅按精确名称清理本轮任务。`);
  });
});
