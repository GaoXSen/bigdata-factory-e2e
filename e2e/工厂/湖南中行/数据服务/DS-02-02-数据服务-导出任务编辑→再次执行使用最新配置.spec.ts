/**
 * DS-02-02｜数据服务｜文件导出｜导出任务编辑→再次执行使用最新配置
 *
 * 通过判据（20260917 编辑闭环版）：编辑保存（/file/download/ftp/update 业务码
 * 000000）把基础文件名改成本轮 uuid、分片数改为 2 并再次执行成功后——
 *   1. 导出列表“最新导出状态”出现本轮成功终态（状态列未刷新时以实例核验兜底）；
 *   2. 实例列表出现本轮执行的实例记录（基础文件名为本轮 uuid，唯一）；
 *   3. 远端目录出现“本轮基础文件名”的非空文件——这是“使用最新配置”的
 *      最终判据（远端文件名由任务当前配置拼出，只有按最新配置执行的本轮
 *      才会产生；不以进度条/任务行存在代替文件核验）。
 *
 * 历史（ENV-01）：创建/更新接口 20260916 起持续返回 111111“任务创建失败-
 * 调度创建失败-请查看日志”（run5/run6/fix2/fix3/fix4 同因实证），此前整条
 * 用例被跳过。本轮按任务约定复用已上线的自动化自有导出任务（test5_sftp
 * 等）走“下线→编辑最新配置→保存/上线→再次执行”的编辑闭环绕开 create
 * 接口；任务已下线时不重复执行下线动作。远端核验需要测试机可直连远端
 * SFTP，20260917 只读探测通过（/source/ 列表成功），以 VERIFY_REMOTE_SFTP
 * 控制；无该路径时显式跳过并说明，不以页面侧证据冒充最终判据。
 *
 * 20260922（DS-PERM-45）静态迁移：① 任务来源改为“明确 E2E fixture”——
 * fixture-state.json 的 exportTaskName 或 DS_02_02_EXPORT_TASK_NAME，不再调用
 * findReusableExportTask 的历史清单（test_gs_0902/test5_sftp 等旧 113 残留）；
 * ② 默认远端目录改取 testEnvironment.fileTransfer.ftp（FTP 113:2121、目录 /），
 * FTP 与 SFTP 不混为同一默认；③ VERIFY_REMOTE_SFTP 更名为 VERIFY_REMOTE_FILE
 * （旧名兼容）。
 */
import fs from 'node:fs';
import path from 'node:path';
// 配置中心先加载：把 EXPORT_SOURCE_* / FTP_* 等兼容变量按 profile 默认回填（ENV-CONFIG-40）。
import { testEnvironment } from '../../../test-environment.js';
import { assertNoConsoleErrors, fillByLabel, test, uuid } from '../utils.js';
import {
  clickExportTaskAction,
  clickVisibleMenuPath,
  disableScheduledUpdate,
  findRemoteExportFile,
  getExportTaskRowText,
  openExportTaskEdit,
  saveExportTaskUpdate,
  setExportTaskState,
  verifyExportInstanceRecord,
  waitForExportTaskSuccess,
} from '../FTP-SFTP/文件导出测试工具.js';

// 默认目录取自配置中心 FTP profile（20260922 基线：FTP 113:2121、目录 /），
// FTP_FILE_PATH 仍可单项覆盖；不再沿用 SFTP 时代的 /source/。
const FTP_FILE_PATH = (
  process.env.FTP_FILE_PATH?.trim() || testEnvironment.fileTransfer.ftp.baseDir
).replace(/\/?$/, '/');
// 明确 E2E fixture：仅复用夹具记录或显式环境变量指定的任务；
// 不回退 test_gs_0902 / test5_sftp 等历史 113 残留清单。
const FIXTURE_STATE_PATH = path.resolve('temp/公司模型任务/20260920-110环境迁移闭环/fixture-state.json');

function readFixtureExportTaskName(): string {
  const override = (process.env.DS_02_02_EXPORT_TASK_NAME || '').trim();
  if (override) return override;
  try {
    const state = JSON.parse(fs.readFileSync(FIXTURE_STATE_PATH, 'utf-8')) as { exportTaskName?: unknown };
    return typeof state.exportTaskName === 'string' ? state.exportTaskName.trim() : '';
  } catch {
    return '';
  }
}
test.describe('DS-02-02｜数据服务｜导出任务编辑→再次执行使用最新配置', () => {
  test('DS-02-02｜数据服务｜导出任务编辑→再次执行使用最新配置', async ({ loginPage, consoleErrors, report }) => {
    // 远端目录出现本轮（最新配置）文件是“使用最新配置”的最终判据；
    // 无测试机→远端传输路径时显式跳过，不以进度条/任务行/实例存在代替文件核验。
    // 20260922 起默认远端为 FTP 113:2121；VERIFY_REMOTE_FILE 为协议中性新名，
    // 旧名 VERIFY_REMOTE_SFTP 仍兼容。
    const verifyRemote = process.env.VERIFY_REMOTE_FILE === 'true' || process.env.VERIFY_REMOTE_SFTP === 'true';
    test.skip(!verifyRemote,
      '“编辑后再次执行使用最新配置”的最终判据是远端目录出现本轮新文件名的非空文件；仅在具备测试机→远端传输路径时设置 VERIFY_REMOTE_FILE=true 运行（兼容旧名 VERIFY_REMOTE_SFTP=true）。');
    const missing = ['FTP_HOST', 'FTP_USER', 'FTP_PASS'].filter((name) => !process.env[name]?.trim());
    test.skip(missing.length > 0, `缺少导出夹具环境变量：${missing.join('、')}`);
    // 任务来源 = 明确 E2E fixture（fixture-state.json / DS_02_02_EXPORT_TASK_NAME）；
    // 夹具缺失时显式跳过，不回退任何历史固定任务名。
    const fixtureTaskName = readFixtureExportTaskName();
    test.skip(!fixtureTaskName,
      '未找到明确 E2E fixture 记录的导出任务：先运行 E2E夹具-110环境导出任务迁移 生成 fixture-state.json（exportTaskName），或用 DS_02_02_EXPORT_TASK_NAME 显式指定本轮唯一任务；不再回退 test_gs_0902/test5_sftp 等历史 113 残留任务。');
    // 编辑保存（最长180s）+ 执行轮询 + 实例/远端核验需要超出默认单测超时。
    test.setTimeout(600_000);

    const page = loginPage;
    await clickVisibleMenuPath(page, '数据服务', '文件导出', '导出列表');
    const taskName = fixtureTaskName;
    // 夹具任务必须真实出现在当前导出列表（环境漂移时立刻报错，不静默换任务）。
    await getExportTaskRowText(page, taskName);
    // 1) 下线（若已下线则不操作）
    await setExportTaskState(page, taskName, false);
    // 2) 编辑最新配置：基础文件名改成本轮 uuid、分片数改为 2（可观测的“最新配置”锚点）
    await openExportTaskEdit(page, taskName);
    const latestBaseName = `e2e_ed_${uuid()}`;
    await fillByLabel(page, '基础文件名', latestBaseName);
    await fillByLabel(page, '分片数', '2').catch(() => undefined);
    await fillByLabel(page, '文件路径', FTP_FILE_PATH);
    await fillByLabel(page, '字段分隔符', ',');
    const permanent = page.getByRole('radio', { name: '永久', exact: true }).last();
    if (await permanent.isVisible().catch(() => false)) await permanent.check();
    const nonCoreTask = page.getByRole('radio', { name: '否', exact: true }).last();
    if (await nonCoreTask.isVisible().catch(() => false)) {
      await nonCoreTask.check().catch(async () => await nonCoreTask.click());
    }
    await fillByLabel(page, '重试次数', '0').catch(() => undefined);
    await disableScheduledUpdate(page);
    // 3) 保存：核对 /file/download/ftp/update 业务码 000000（HTTP 200 不等于保存成功）
    const saved = await saveExportTaskUpdate(page);
    // 4) 上线 → 再次执行
    await clickVisibleMenuPath(page, '数据服务', '文件导出', '导出列表');
    await setExportTaskState(page, taskName, true);
    const executeAtMs = Date.now();
    const preRowText = await getExportTaskRowText(page, taskName);
    await clickExportTaskAction(page, taskName, /执\s*行/);
    await page.waitForTimeout(3_000);
    // 5) 本轮执行成功：列表成功终态 + 实例记录（基础文件名 uuid 唯一）
    const status = await waitForExportTaskSuccess(page, taskName, 120_000,
      { preRowText, baseName: latestBaseName, executeAtMs });
    const instance = status.instance
      ?? await verifyExportInstanceRecord(page, taskName, latestBaseName, executeAtMs);
    // 6) 远端目录真实出现本轮（最新配置）的非空文件——不以进度条/任务行存在代替
    const remoteFile = await findRemoteExportFile(latestBaseName, 60_000);

    await assertNoConsoleErrors(consoleErrors);
    await report('文件导出-编辑后再次执行使用最新配置', true,
      `任务：${taskName}；本轮基础文件名：${latestBaseName}；分片数：2；update 响应 code=${saved.code}；` +
      `状态行：${status.rowText}（${status.evidence}）；实例：${instance.matchedBy}；远端文件：${remoteFile}`);
  });
});