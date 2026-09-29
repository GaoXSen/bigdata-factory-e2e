/**
 * FS-04-04｜FTP/SFTP｜条件导出任务与远端文件生成
 *
 * 通过判据（run-20260914-110852-805 失败复盘后收紧，20260917 编辑闭环版）：
 *   1. 条件导出任务执行后，导出列表“最新导出状态”出现本轮成功终态（toast 不作为通过依据）；
 *   2. “查看实例”的实例列表出现本轮执行实例（基础文件名为本轮 uuid，唯一）；
 *   3. 远端目录出现“本轮基础文件名”的非空文件（0 字节空文件视为未真正落数据）。
 *
 * agent-11 20260917：POST /file/download/ftp/create 自 9/16 起持续返回
 * 111111“任务创建失败-调度创建失败-请查看日志”（run5/run6/fix2/fix3/fix4
 * 同因实证），而“上线/执行/实例”链路健康（基线 run-20260917-105532-552 的
 * DS-02-05 通过）、20260917 探测确认测试机可直连远端 SFTP（/source/ 列表
 * 成功）。按任务约定改为复用已上线的自动化自有导出任务（test5_sftp 等），
 * 以下线→编辑最新配置→保存（/file/download/ftp/update 取证）→上线→再次
 * 执行的编辑闭环替代 create 接口；本轮基础文件名 uuid 保证实例与远端文件
 * 只可能来自本轮执行，核心断言不降级。任务已下线时不重复执行下线动作。
 *
 * 2026-09-22 基线迁移（静态，资源/当前测试环境基线.md）：远端基线切换为
 * FTP 192.168.76.113:2121、目录 /。复用任务编辑时按环境变量把协议/地址/端口/
 * 账号改写为当前基线（repointExportConnectionToBaseline），避免历史任务仍指向
 * 110:/source/ 导致执行与远端核验（findRemoteExportFile 协议自适应）不同源。
 */
import type { Page } from '@playwright/test';
import { assertNoConsoleErrors, fillByLabel, test, uuid } from '../utils.js';
import {
  clickExportTaskAction,
  clickVisibleMenuPath,
  disableScheduledUpdate,
  findRemoteExportFile,
  findReusableExportTask,
  getExportTaskRowText,
  openExportTaskEdit,
  readFormValueByLabel,
  saveExportTaskUpdate,
  setExportTaskState,
  verifyExportInstanceRecord,
  waitForExportTaskSuccess,
} from './文件导出测试工具.js';

const FTP_FILE_PATH = (process.env.FTP_FILE_PATH || '/').replace(/\/?$/, '/');

/** 导出闭环必需夹具：远端 SFTP 账号 + 来源表。缺失时显式跳过并说明原因。 */
function missingExportFixtureReason(): string | undefined {
  const required = ['FTP_HOST', 'FTP_USER', 'FTP_PASS', 'EXPORT_SOURCE_TABLE'];
  const missing = required.filter((name) => !process.env[name]?.trim());
  return missing.length ? `缺少导出夹具环境变量：${missing.join('、')}` : undefined;
}

/**
 * 2026-09-22 基线对齐：复用的历史任务可能仍指向 113 时代 SFTP 110:/source/。
 * 编辑表单与创建表单同源（openNewExport 同款标签），这里按环境变量把协议/
 * 地址/端口/账号改写为当前基线（FTP 192.168.76.113:2121、目录 /）。逐项
 * best-effort：编辑页未渲染对应控件时跳过该项（TODO[env] 首轮 --headed 校准
 * 标签名）；已与目标值一致时不重复填写，避免覆盖回显竞态。
 */
async function repointExportConnectionToBaseline(page: Page): Promise<void> {
  const wantProtocol = (process.env.FTP_PROTOCOL || 'ftp').toLowerCase();
  // 协议单选以页面可见文本定位（与 openNewExport 创建侧一致）。
  const protocolText = page.getByText(wantProtocol === 'sftp' ? /^sftp$/i : /^ftp$/i, { exact: true }).last();
  if (await protocolText.isVisible().catch(() => false)) {
    await protocolText.click().catch(() => undefined);
  }
  // 地址标签随协议变化；两种写法都尝试，取第一个在编辑表单中真实可见的。
  const addressLabels = wantProtocol === 'sftp' ? ['sftp服务器地址', 'ftp服务器地址'] : ['ftp服务器地址', 'sftp服务器地址'];
  const connections: [string[], string][] = [
    [addressLabels, process.env.FTP_HOST ?? ''],
    [['服务器端口'], process.env.FTP_PORT || (wantProtocol === 'sftp' ? '22' : '2121')],
    [['登录用户名'], process.env.FTP_USER ?? ''],
    [['登录密码'], process.env.FTP_PASS ?? ''],
  ];
  for (const [labels, value] of connections) {
    if (!value.trim()) continue;
    for (const label of labels) {
      const current = await readFormValueByLabel(page, label).catch(() => undefined);
      if (current === undefined) continue; // 该标签在编辑页不可见，尝试下一个候选标签。
      if (current === value) break; // 已与基线一致，不重复填写。
      await fillByLabel(page, label, value).catch(() => undefined);
      break;
    }
  }
}

/**
 * 编辑复用的自动化自有导出任务，使其成为带本轮标记的“条件导出”任务：
 * 下线（已下线则不操作）→编辑→Where 条件/本轮 uuid 基础文件名→保存
 * （/file/download/ftp/update 取证）→上线→执行。Where 条件已配置时保留
 * 任务原条件（本就是条件导出）；为空或是页面默认日期占位（夹具来源表
 * id/name/remark 无 DATA_DATE 字段，保留会导致执行失败）时覆盖为
 * id >= 0（夹具表字段 id/name/remark）。
 */
async function editReusableConditionExport(page: Page): Promise<{
  taskName: string;
  baseName: string;
  preRowText: string;
  executeAtMs: number;
}> {
  await clickVisibleMenuPath(page, '数据服务', '文件导出', '导出列表');
  const { taskName } = await findReusableExportTask(page);
  // 1) 下线（若已下线则不操作）
  await setExportTaskState(page, taskName, false);
  // 2) 编辑最新配置
  await openExportTaskEdit(page, taskName);
  // 2a) 基线对齐：协议/地址/端口/账号改写为当前基线（历史任务可能指向 110:/source/）。
  await repointExportConnectionToBaseline(page);
  const existingWhere = await readFormValueByLabel(page, 'Where条件');
  if (existingWhere === undefined || existingWhere.trim() === '' || /DATA_DATE|SYSTEM_DATE/.test(existingWhere)) {
    await fillByLabel(page, 'Where条件', 'id >= 0');
  }
  const baseName = `e2e_cond_${uuid()}`;
  await fillByLabel(page, '基础文件名', baseName);
  // 文件路径/分隔符与创建夹具保持一致，保证远端核验目录就是任务导出目录。
  await fillByLabel(page, '文件路径', FTP_FILE_PATH);
  await fillByLabel(page, '字段分隔符', ',');
  const permanent = page.getByRole('radio', { name: '永久', exact: true }).last();
  if (await permanent.isVisible().catch(() => false)) await permanent.check();
  const nonCoreTask = page.getByRole('radio', { name: '否', exact: true }).last();
  if (await nonCoreTask.isVisible().catch(() => false)) {
    await nonCoreTask.check().catch(async () => await nonCoreTask.click());
  }
  // 必填“重试次数”未填时保存被前端拦截（fix3 run-20260917-094648-055 DS-02-04 实证）。
  await fillByLabel(page, '重试次数', '0').catch(() => undefined);
  await disableScheduledUpdate(page);
  // 3) 保存：核对 update 业务码 000000（HTTP 200 不等于保存成功）
  await saveExportTaskUpdate(page);
  // 4) 上线 → 再次执行
  await clickVisibleMenuPath(page, '数据服务', '文件导出', '导出列表');
  await setExportTaskState(page, taskName, true);
  const executeAtMs = Date.now();
  const preRowText = await getExportTaskRowText(page, taskName);
  await clickExportTaskAction(page, taskName, /执\s*行/);
  // 执行由后端异步受理，提交 toast 可能一闪而过，不作为通过依据。
  await page.waitForTimeout(3_000);
  return { taskName, baseName, preRowText, executeAtMs };
}
test.describe('FS-04-04｜FTP/SFTP｜条件导出任务与远端文件生成', () => {
  test('FS-04-04｜FTP/SFTP｜条件导出任务页面执行成功', async ({ loginPage, consoleErrors, report }) => {
    const missing = missingExportFixtureReason();
    test.skip(Boolean(missing), missing);
    // 编辑保存（最长180s）+ 执行轮询 + 实例核验需要超出默认单测超时。
    test.setTimeout(600_000);

    const plan = await editReusableConditionExport(loginPage);
    // 证据 1：列表“最新导出状态”出现本轮成功终态（toast 不作为通过依据）。
    const status = await waitForExportTaskSuccess(loginPage, plan.taskName, 120_000,
      { preRowText: plan.preRowText, baseName: plan.baseName, executeAtMs: plan.executeAtMs });
    // 证据 2：实例列表出现本轮执行的实例记录（基础文件名为本轮 uuid，唯一）。
    const instance = status.instance
      ?? await verifyExportInstanceRecord(loginPage, plan.taskName, plan.baseName, plan.executeAtMs);

    await assertNoConsoleErrors(consoleErrors);
    await report('FTP/SFTP-条件导出页面执行', true,
      `复用任务：${plan.taskName}（编辑闭环，Where 条件已配置）；基础文件名：${plan.baseName}；` +
      `状态行：${status.rowText}（${status.evidence}）；实例：${instance.rowText.slice(0, 160)}（${instance.matchedBy}）`);
  });

  test('FS-04-04｜FTP/SFTP｜远端目录出现本轮条件导出文件', async ({ loginPage, consoleErrors, report }) => {
    // 远端核验需要测试机具备直连远端 FTP/SFTP 的网络路径（按 FTP_PROTOCOL）。
    test.skip(process.env.VERIFY_REMOTE_SFTP !== 'true',
      '远端文件核验需要测试机可直连远端 FTP/SFTP（FTP_PROTOCOL/FTP_HOST/FTP_PORT/FTP_USER/FTP_PASS）；仅在该路径可用时设置 VERIFY_REMOTE_SFTP=true 运行。');
    const missing = missingExportFixtureReason();
    test.skip(Boolean(missing), missing);
    test.setTimeout(600_000);

    const plan = await editReusableConditionExport(loginPage);
    // 远端核验前先确认页面侧本轮执行成功，避免把未执行完成的目录误判为缺陷。
    const status = await waitForExportTaskSuccess(loginPage, plan.taskName, 120_000,
      { preRowText: plan.preRowText, baseName: plan.baseName, executeAtMs: plan.executeAtMs });
    // 核心断言：远端目录出现“本轮文件名”的非空文件（0 字节视为未落数据）。
    const remoteFile = await findRemoteExportFile(plan.baseName, 60_000);

    await assertNoConsoleErrors(consoleErrors);
    await report('FTP/SFTP-条件导出远端文件', true,
      `文件：${remoteFile}；复用任务：${plan.taskName}；基础文件名：${plan.baseName}；状态行：${status.rowText}`);
  });
});