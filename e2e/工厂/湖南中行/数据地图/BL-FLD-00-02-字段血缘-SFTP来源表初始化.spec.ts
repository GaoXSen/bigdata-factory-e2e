/**
 * BL-FLD-00-02｜字段血缘｜SFTP 来源表初始化
 *
 * 新建字段血缘专属的 SFTP 接入任务和目标表（不修改已有 gs_test_ 任务或业务表）。
 * DS-PERM-47：SFTP 地址/端口/凭据一律来自 e2e/test-environment.ts 的 SFTP
 * profile（requireSftpProfile 校验，缺失时抛只含变量名的可读错误，代码不携带
 * 任何默认账号密码）；远端目录与基础文件名允许 LINEAGE_SFTP_PATH /
 * LINEAGE_SFTP_BASE_FILE 单项覆盖，默认取 profile 的 baseDir/baseFile。
 * 已知环境阻塞（保留为可诊断前置，不伪造通过）：字段血缘远端日期文件
 * （历史取值 /gs/e2e_lineage_sftp_YYYYMMDD）当前不可读，数据预览会以携带
 * 接口证据的错误结束；恢复历史取值可设 LINEAGE_SFTP_PATH=/gs/ 与
 * LINEAGE_SFTP_BASE_FILE=e2e_lineage_sftp。
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect, fillByLabel, selectByLabel } from '../utils.js';
import { assertNoConsoleErrors } from '../utils.js';
import { openFtpAccessList } from '../数据接入/FTP接入执行工具.js';
import { resolveLineageSftpAccess } from './血缘测试工具.js';
import { testEnvironment } from '../../../test-environment.js';

// 2026-09-20（110 环境迁移）：SFTP 自动建表随文件来源表一起迁到 MySQL 110，
// 供 MySQL（e2e_test）任务调度读取；表名加 _0920 与旧 GBase 批次隔离。
const SOURCE_TABLE = 'e2e_hn_fld_sftp_src_0920';
const TASK_NAME = 'E2E_FLD_LINEAGE_SFTP';
// 目标端数据源四项（类型/显示名/库/Schema）来自配置中心 dataSourceNames.fileAccess，
// 可用 FILE_AUTO_SOURCE_TYPE/NAME/DATABASE/SCHEMA 单项覆盖；显示名默认为
// “host:port/库”全名，selectByLabel 按选项文本精确匹配必须用全名。
const TARGET_SOURCE = testEnvironment.dataSourceNames.fileAccess;

async function lastVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    for (let index = await candidate.count() - 1; index >= 0; index -= 1) {
      if (await candidate.nth(index).isVisible().catch(() => false)) return candidate.nth(index);
    }
  }
  return undefined;
}

async function clickVisible(page: Page, name: RegExp): Promise<void> {
  const button = await lastVisible([
    page.getByRole('button', { name }).filter({ visible: true }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: name }),
  ]);
  if (!button) throw new Error(`未找到可见按钮：${name}`);
  await button.click();
}

async function fillBaseFileName(page: Page, value: string): Promise<void> {
  const label = page.getByText('基础文件名', { exact: true }).filter({ visible: true }).last();
  await expect(label).toBeVisible({ timeout: 10_000 });
  for (let depth = 0, scope = label.locator('..'); depth < 4; depth += 1, scope = scope.locator('..')) {
    const input = scope.locator('input:visible').last();
    if (await input.isVisible().catch(() => false)) {
      await input.fill(value);
      return;
    }
  }
  throw new Error('未找到“基础文件名”输入框。');
}

async function fillAutomaticTableName(page: Page, value: string): Promise<void> {
  // 新版自动建表新增“拆表方案”后，表名输入框不再带“请输入表名”占位符。
  // 必须从“表”标签的近邻输入框定位，不能依赖所有输入框的固定序号。
  const labels = page.getByText(/^\s*\*?\s*表\s*[:：]\s*$/).filter({ visible: true });
  for (let index = await labels.count() - 1; index >= 0; index -= 1) {
    let scope = labels.nth(index);
    for (let depth = 0; depth < 5; depth += 1, scope = scope.locator('..')) {
      const input = scope.locator('input:visible:not([type="radio"]):not([type="checkbox"])').last();
      if (await input.isVisible().catch(() => false)) {
        await input.fill(value);
        return;
      }
    }
  }
  // 截至当前版本，右侧“表”是该页面最后一个可编辑文本框；仅作为标签结构
  // 变化时的回退，避免固定依赖 placeholder。
  const fallback = page.locator('input:visible:not([type="radio"]):not([type="checkbox"]):not([type="password"])').last();
  if (await fallback.isVisible().catch(() => false)) {
    await fallback.fill(value);
    return;
  }
  throw new Error('自动建表已选中，但未找到“表”对应的可编辑输入框。');
}

/** 来源文件区域的五项规则：日期前、日期后、文件后缀、日期粒度、日期偏移。 */
async function selectCurrentDayFileRule(page: Page): Promise<void> {
  const values = ['_', '空', '空', '日', '0'];
  const boxes = page.locator('[role="combobox"]:visible');
  if (await boxes.count() < values.length) {
    throw new Error(`来源文件日期规则下拉框不足 ${values.length} 个，实际 ${await boxes.count()} 个。`);
  }
  for (const [index, value] of values.entries()) {
    await boxes.nth(index).click();
    const option = page.locator(
      '.el-select-dropdown:visible li:visible, .ant-select-dropdown:visible [role="option"]:visible, [role="listbox"] [role="option"]:visible',
    ).filter({ hasText: new RegExp(`^\\s*${value}\\s*$`) }).last();
    await expect(option, `日期规则第 ${index + 1} 项未提供选项“${value}”`).toBeVisible({ timeout: 8_000 });
    await option.click();
    await page.keyboard.press('Escape').catch(() => undefined);
  }
}

function todayFileName(baseFileName: string): string {
  const today = new Date();
  const date = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  return `${baseFileName}_${date}`;
}

async function testSftpConnection(page: Page): Promise<void> {
  // 新版页面的“测试连接”成功结果不稳定地显示 toast；真实可信的依据是
  // saveFtpServerConfig / connect 接口的成功响应。监听必须先于点击注册。
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST'
      && /(?:saveFtpServerConfig|ftp.*connect|connect.*ftp)/i.test(response.url()),
    { timeout: 30_000 },
  );
  await clickVisible(page, /测试连接/);
  const response = await responsePromise;
  const body = await response.text().catch(() => '');
  if (response.status() < 200 || response.status() >= 300 || /(?:失败|错误|异常|fail|error)/i.test(body)) {
    throw new Error(`SFTP 测试连接失败：HTTP ${response.status()}；${body.slice(0, 500)}`);
  }
}

test.describe('BL-FLD-00-02｜字段血缘｜SFTP 来源表初始化', () => {
  test(`新建 SFTP 接入任务并自动建表 ${SOURCE_TABLE}`, async ({ loginPage, consoleErrors, report }) => {
    test.setTimeout(120_000);
    const page = loginPage;
    // SFTP 凭据校验前移（DS-PERM-47）：SFTP_USER/SFTP_PASS 缺失时立即抛出
    // 只含变量名的可读错误，不做任何页面操作（与 DI-00-02 前置语义一致）。
    const sftp = resolveLineageSftpAccess();
    const expectedFile = todayFileName(sftp.baseFileName);
    await openFtpAccessList(page);

    await clickVisible(page, /新建接入|新增接入/);
    await expect(page.getByText('来源文件', { exact: true }).filter({ visible: true }).last()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('radio', { name: /^sftp$/i }).last().check();
    await fillByLabel(page, '地址', sftp.host);
    await fillByLabel(page, '端口', String(sftp.port));
    await fillByLabel(page, '用户名', sftp.username);
    await fillByLabel(page, '密码', sftp.password);
    await fillByLabel(page, '文件', sftp.remoteDir);
    await fillBaseFileName(page, sftp.baseFileName);
    await selectCurrentDayFileRule(page);

    // 新版前端会先校验目的端必填项；目标数据源、库、Schema、建表方式未填时
    // “测试连接”不会发送任何请求，不能误判为 SFTP 不通。
    // DS-PERM-47：目标端四项来自配置中心 dataSourceNames.fileAccess（显示名
    // 默认为“host:port/库”全名，selectByLabel 精确匹配必须用全名）。
    await selectByLabel(page, '数据源类型', TARGET_SOURCE.type);
    await selectByLabel(page, '数据源名称', TARGET_SOURCE.name);
    await selectByLabel(page, '数据库名称', TARGET_SOURCE.database);
    await selectByLabel(page, 'Schema', TARGET_SOURCE.schema);
    const automatic = page.getByRole('radio', { name: '自动建表', exact: true }).last();
    await automatic.click();
    await expect(automatic).toBeChecked({ timeout: 5_000 });
    await fillAutomaticTableName(page, SOURCE_TABLE);

    await testSftpConnection(page);
    await clickVisible(page, /预览文件名/);
    // 当前前端将“真实文件名”和紧邻的“压缩类型”拼成同一个文本节点，不能用
    // exact 匹配；业务断言只要求生成的当天文件名出现。
    await expect(page.getByText(new RegExp(expectedFile)).filter({ visible: true }).last()).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape').catch(() => undefined);

    // 数据预览在 110 环境曾出现“弹窗只有标题、无任何内容”的情况（0920 基线与
    // 0921 复跑一致）。原因无法从 DOM 判断，必须携带预览接口的响应证据：
    // - 点击前注册响应监听，记录预览窗口内全部接口的状态与片段；
    // - 先做内容等待（对齐 FTP接入执行工具 的做法），超时后重试一次点击；
    // - 仍失败则抛出含接口证据的错误，区分“环境/数据问题”与“用例问题”。
    const previewResponses: string[] = [];
    const recordPreviewResponse = async (response: import('@playwright/test').Response): Promise<void> => {
      const url = response.url();
      if (!/\/(ftp|dataAccess|preview|file)/i.test(url)) return;
      const text = await response.text().catch(() => '');
      previewResponses.push(`${response.status()} ${response.request().method()} ${url} :: ${text.slice(0, 300)}`);
    };
    const onPreviewResponse = (response: import('@playwright/test').Response): void => {
      void recordPreviewResponse(response);
    };
    page.on('response', onPreviewResponse);
    try {
      await clickVisible(page, /数据预览/);
      const preview = page.locator('.el-dialog:visible, .ant-modal:visible, [role="dialog"]:visible').last();
      await expect(preview).toBeVisible({ timeout: 15_000 });
      const previewBody = preview.locator('table:visible, tbody:visible, pre:visible, [class*="content"]:visible').first();
      try {
        await expect(previewBody).toBeVisible({ timeout: 15_000 });
      } catch {
        // 首次点击可能因后端读文件慢或瞬时失败而空白：关闭后重试一次。
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.waitForTimeout(1_000);
        await clickVisible(page, /数据预览/);
        await expect(previewBody).toBeVisible({ timeout: 20_000 });
      }
      for (const field of ['sftp_id', 'shared_key', 'region_code', 'sftp_amount', 'business_date']) {
        await expect(preview.getByText(field, { exact: true }).last(), `SFTP 数据预览缺少字段 ${field}`).toBeVisible();
      }
    } catch (error) {
      const dialogText = await page.locator('.el-dialog:visible, .ant-modal:visible, [role="dialog"]:visible').last()
        .innerText({ timeout: 2_000 }).catch(() => '（无法读取弹窗）');
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n`
        + `数据预览弹窗文本：${dialogText.replace(/\s+/g, ' ').slice(0, 300)}\n`
        + `预览窗口内接口响应（URL 含 ftp/dataAccess/preview/file）：\n`
        + `${previewResponses.slice(-20).join('\n') || '未捕获到任何接口响应'}`,
      );
    } finally {
      page.off('response', onPreviewResponse);
    }
    await page.keyboard.press('Escape').catch(() => undefined);


    await clickVisible(page, /下一步/);
    await expect(page.getByText(/字段映射|目标映射|来源字段/).filter({ visible: true }).last()).toBeVisible({ timeout: 15_000 });
    for (const field of ['sftp_id', 'shared_key', 'region_code', 'sftp_amount', 'business_date']) {
      await expect(page.getByText(field, { exact: true }).filter({ visible: true }).last(), `字段映射缺少 ${field}`).toBeVisible();
    }

    await clickVisible(page, /下一步/);
    const taskName = page.getByLabel('任务名称', { exact: true }).filter({ visible: true }).last();
    await expect(taskName).toBeVisible({ timeout: 15_000 });
    await taskName.fill(TASK_NAME);
    const retry = page.getByRole('spinbutton').filter({ visible: true }).last();
    if (await retry.isVisible().catch(() => false)) await retry.fill('0');
    await clickVisible(page, /^确\s*定$/);
    await expect.poll(async () => {
      const text = await page.locator('body').innerText();
      return /创建成功|保存成功|同步任务.*创建/.test(text) || !/ftpAccessCreate/.test(page.url());
    }, { timeout: 30_000 }).toBe(true);

    await assertNoConsoleErrors(consoleErrors);
    await report('字段血缘-SFTP来源表初始化', true,
      `文件=${expectedFile}（无后缀）；任务=${TASK_NAME}；目标表=${SOURCE_TABLE}；`
      + `数据源=${TARGET_SOURCE.type} ${TARGET_SOURCE.name}；方式=自动建表。`);
  });
});
