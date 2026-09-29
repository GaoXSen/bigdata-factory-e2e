/**
 * E2E夹具｜110环境迁移｜确保存在可复用的自动化导出任务
 *
 * 背景：DS-02-02 / DS-02-04 / FS-04-04 依赖“复用已有导出任务”。20260922 起
 * 本夹具只认“明确 E2E fixture”（DS-PERM-45），不再依赖任何历史固定任务名：
 *   1) 打开 数据服务>文件导出>导出列表；
 *   2) 按 fixture-state.json 记录的 exportTaskName、DS_02_02_EXPORT_TASK_NAME
 *      依次查找既有任务（均为本夹具链路创建或显式指定的唯一 ASCII 前缀任务）；
 *      不再回退 test_gs_0902、test5_sftp 等历史 113 残留清单；
 *   3) 都没有时，用 openNewExport 新建一个全量导出任务（数据源 110:13306/e2e_test；
 *      远端默认取 testEnvironment 的 FTP profile——FTP 192.168.76.113:2121、
 *      目录 /；仅 FTP_PROTOCOL=sftp 的明确场景才走 sftp profile），
 *      保存成功后把任务名/基础文件名写入 fixture-state.json，供后续用例参数化复用。
 * 注意：新建走真实 UI 表单，凭据只从 FTP_USER/FTP_PASS 读取（缺失显式跳过，
 * 不内置默认账号）；不做接口直调、不直改数据。
 */
import fs from 'node:fs';
import path from 'node:path';
// 先加载环境配置中心：把 EXPORT_SOURCE_* / FTP_HOST 等兼容变量按 profile 默认回填进
// process.env（ENV-CONFIG-40），供本文件与只读工具《文件导出测试工具.ts》读取。
import '../../../test-environment.js';
import { expect, submitAndExpectSuccess, test, uuid } from '../utils.js';
import {
  clickVisibleMenuPath,
  dataRows,
  openNewExport,
} from '../FTP-SFTP/文件导出测试工具.js';

const STATE_PATH = path.resolve('temp/公司模型任务/20260920-110环境迁移闭环/fixture-state.json');

function readState(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeState(patch: Record<string, unknown>): void {
  const merged = { ...readState(), ...patch };
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(merged, null, 2), 'utf-8');
}

test.describe('E2E夹具｜110环境迁移｜可复用导出任务', () => {
  test('E2E夹具｜110环境迁移｜确保可复用的自动化导出任务存在', async ({ loginPage, report }) => {
    test.setTimeout(600_000);
    const page = loginPage;
    await clickVisibleMenuPath(page, '数据服务', '文件导出', '导出列表');
    // 列表可能为空（新环境）；空列表与有数据都允许继续（为空则走新建分支）。
    const firstRow = dataRows(page).first();
    await expect(firstRow.or(page.getByText('暂无数据').first())).toBeVisible({ timeout: 15_000 });

    const state = readState();
    // 只认“明确 E2E fixture”：夹具记录 + 显式环境变量覆盖；
    // test_gs_0902、test5_sftp 等历史 113 残留清单自 DS-PERM-45 起移除。
    const preferred = Array.from(new Set([
      ...(typeof state.exportTaskName === 'string' && state.exportTaskName.trim()
        ? [state.exportTaskName.trim()]
        : []),
      (process.env.DS_02_02_EXPORT_TASK_NAME || '').trim(),
    ].filter(Boolean)));

    const findPreferredInList = async (): Promise<string | undefined> => {
      const rows = dataRows(page);
      const rowCount = await rows.count();
      for (let index = 0; index < rowCount; index += 1) {
        const rowText = (await rows.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ');
        const hit = preferred.find((name) => rowText.includes(name));
        if (hit) return hit;
      }
      return undefined;
    };

    // 1) 本轮/环境变量优先清单（首页可见行）。没有命中就直接走新建分支，
    //    不再轮询任何历史默认任务清单。
    const reused = preferred.length ? await findPreferredInList() : undefined;
    if (reused) {
      if (state.exportTaskName !== reused) {
        writeState({ exportTaskName: reused, exportTaskReused: true, exportTaskConfirmedAt: new Date().toISOString() });
      }
      await report('110夹具-导出任务复用', true, `复用既有导出任务“${reused}”（列表确认存在，配置沿用原任务）。`);
      return;
    }

    // 2) 没有任何可复用任务：通过 UI 新建全量导出任务并保存。
    //    新建依赖真实传输凭据（永不内置默认账号）；缺失时显式跳过。
    const missingCreds = ['FTP_USER', 'FTP_PASS'].filter((name) => !process.env[name]?.trim());
    test.skip(missingCreds.length > 0,
      `缺少传输凭据环境变量：${missingCreds.join('、')}，无法通过 UI 新建导出任务夹具（凭据不设代码默认值）。`);
    const { taskName, baseName } = await openNewExport(page, {
      integrate: false,
      baseName: `e2e_export_${uuid()}`,
    });
    // 重试次数留默认可能触发校验/调度策略，与既有 FS-04 用例一致显式填 0。
    const retryCount = page.getByRole('spinbutton').last();
    if (await retryCount.isVisible().catch(() => false)) await retryCount.fill('0');
    await submitAndExpectSuccess(page, /保\s*存/, '保存成功', 180_000);
    // 保存成功后返回列表，确认新任务真的出现在导出列表。
    await expect(dataRows(page).filter({ hasText: taskName }).first(), '保存后导出列表应出现新任务')
      .toBeVisible({ timeout: 15_000 });
    writeState({
      exportTaskName: taskName,
      exportBaseName: baseName,
      exportCreatedAt: new Date().toISOString(),
    });
    await report('110夹具-导出任务新建', true, `新建导出任务“${taskName}”（基础名 ${baseName}）保存成功，已写入 fixture-state.json 供 DS/FS 用例复用。`);
  });
});
