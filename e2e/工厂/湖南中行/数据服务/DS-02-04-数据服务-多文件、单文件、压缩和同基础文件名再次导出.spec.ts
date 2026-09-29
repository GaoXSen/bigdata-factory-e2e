/**
 * FTP/SFTP 文件导出场景（Excel「测试用例」Sheet，序号 66～73）。
 * 与 FTP/SFTP 接入、预览、导入拆开，便于无关文件在不同 worker 中运行。
 *
 * run-20260915-134701-316 复盘：旧实现内置一份与 FS-04-04 拆分前相同的表单
 * 辅助，文案与当前页面已不一致，属于过期重复实现。表单控件口径与
 * 《FTP-SFTP/文件导出测试工具.ts》的表单辅助工具保持一致；执行结果以列表
 * “最新导出状态”成功终态为准。
 *
 * DS-PERM-72（20260922 数据源管理权限静态开发）清洁环境自建：
 *   - 来源表不再使用配置中心固定表（EXPORT_SOURCE_TABLE），而是经配置中心
 *     主库直建本轮 UUID ASCII 表并写入种子数据；表级联在窗口内等待元数据
 *     同步，超时按环境前置缺失可读阻断，绝不静默换表；
 *   - 任务名/基础文件名/文件路径全部本轮 UUID ASCII 生成，不借用任何历史
 *     迁移任务或旧 SFTP 配置；
 *   - 多文件=分片数 2、单文件=分片数 1（页面可验证的真实锚点）；当前前端
 *     创建页已无“日期格式”控件（run-20260916-161845-734 快照实证），不伪造
 *     该操作；
 *   - 同基础文件名再次导出：创建新任务并复用本轮 baseName，只验证第二次
 *     导出成功；不同任务模式/目录规则下不断言远端同路径覆盖；
 *   - finally 只回收本轮资产：尽力删除本轮任务行、DROP 本轮表、清理远端
 *     本轮 baseName 文件；回收失败仅告警，不掩埋用例真实结果。
 */
import { Client as FtpClient } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import type { Locator, Page, Response, TestInfo } from '@playwright/test';
// 配置中心先于工具模块加载（ENV-CONFIG-40）：EXPORT_SOURCE_* / FTP_* 兼容变量
// 按 profile 默认回填，本用例的来源显示名链路与传输基线都取自配置中心。
import { testEnvironment } from '../../../test-environment.js';
import { test, expect, uuid } from '../utils.js';
import { assertNoConsoleErrors, clickMenu, dbConfig, query, selectByLabel } from '../utils.js';
import { clickExportTaskAction, dataRows } from '../FTP-SFTP/文件导出测试工具.js';

// ==================== DS-PERM-72 清洁环境自建夹具 ====================

// 环境配置中心唯一事实来源：来源表显示名链路取 exportSource；文件传输取 ftp/sftp
// profile（仅 FTP_PROTOCOL=sftp 明确场景切 sftp，不与默认混同）。本文件不写任何
// host/port/用户名/密码；凭据缺失一律条件跳过（非永久 skip、非伪造通过）。
const TRANSFER_PROFILE =
  (process.env.FTP_PROTOCOL || 'ftp').trim().toLowerCase() === 'sftp'
    ? testEnvironment.fileTransfer.sftp
    : testEnvironment.fileTransfer.ftp;
const FTP_PROTOCOL = TRANSFER_PROFILE.protocol;
const FTP_HOST = process.env.FTP_HOST?.trim() || TRANSFER_PROFILE.host;
const FTP_PORT = process.env.FTP_PORT?.trim() || String(TRANSFER_PROFILE.port);
const FTP_USER = process.env.FTP_USER?.trim() || '';
const FTP_PASS = process.env.FTP_PASS?.trim() || '';
const EXPORT_SOURCE = testEnvironment.dataSourceNames.exportSource;
const EXPORT_SOURCE_TYPE = process.env.EXPORT_SOURCE_TYPE?.trim() || EXPORT_SOURCE.type;
const EXPORT_SOURCE_NAME = process.env.EXPORT_SOURCE_NAME?.trim() || EXPORT_SOURCE.name;
const EXPORT_DATABASE = process.env.EXPORT_DATABASE?.trim() || EXPORT_SOURCE.database;
const EXPORT_SCHEMA = process.env.EXPORT_SCHEMA?.trim() || EXPORT_SOURCE.schema;

// 本轮唯一 ASCII 资产：来源表/任务/文件名/目录全部按轮生成；SQL 拼接前做标识符
// 白名单校验，杜绝把页面回显文本带进 SQL。
const ROUND_ID = uuid();
const ROUND_TAG = `e2e_ds0204_${ROUND_ID}`;
const ROUND_TABLE = ROUND_TAG;
const ROUND_TASK_A = `e2e_ds0204_t_${ROUND_ID}_a`;
const ROUND_TASK_B = `e2e_ds0204_t_${ROUND_ID}_b`;
const ROUND_BASE = `e2e_ds0204_f_${ROUND_ID}`;
const ROUND_DIR = process.env.FTP_FILE_PATH?.trim()
  || `${TRANSFER_PROFILE.baseDir.replace(/\/?$/, '/')}${ROUND_TAG}/`;
const ROUND_TABLE_WAIT_MS = Number(process.env.ROUND_TABLE_WAIT_MS?.trim() || '120000');

function isAsciiIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.length <= 64;
}

/** 配置中心主库直建本轮 UUID 来源表并写入种子数据（测试表字段口径：id/name/remark）。 */
async function createRoundSourceTable(): Promise<void> {
  if (!isAsciiIdentifier(ROUND_TABLE)) throw new Error(`本轮来源表名非法：${ROUND_TABLE}`);
  await query(`CREATE TABLE \`${ROUND_TABLE}\` (
  \`id\` INT NOT NULL,
  \`name\` VARCHAR(64) DEFAULT NULL,
  \`remark\` VARCHAR(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await query(`INSERT INTO \`${ROUND_TABLE}\` (\`id\`, \`name\`, \`remark\`) VALUES
  (1, 'ds0204', 'DS-PERM-72 round fixture'),
  (2, 'ds0204', 'export strategy probe')`);
  console.info(
    `[fixture] 本轮来源表 ${ROUND_TABLE} 已建于 ${EXPORT_DATABASE}.${EXPORT_SCHEMA || '默认schema'}（类型 ${EXPORT_SOURCE_TYPE}），种子 2 行`,
  );
}

/** finally 专用：只回收本轮 UUID 表；失败仅告警，不掩埋用例真实结果。 */
async function dropRoundSourceTableBestEffort(): Promise<void> {
  try {
    if (!isAsciiIdentifier(ROUND_TABLE)) return;
    await query(`DROP TABLE IF EXISTS \`${ROUND_TABLE}\``);
  } catch (error) {
    console.warn(`[cleanup] 本轮来源表 ${ROUND_TABLE} 回收失败（保留现场待人工核查）：${
      error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------- 远端文件清理/取证（尽力而为，非验收判据） ----------------

/** 安装版 ssh2-sftp-client（12.x）运行时提供 delete（内部 sftp.unlink）；项目环境声明未含，按最小结构化类型使用。 */
type SftpFileDeleter = { delete(remotePath: string, notFoundOk?: boolean): Promise<string> };

async function withSftp<T>(handler: (client: SftpClient) => Promise<T>): Promise<T> {
  const client = new SftpClient();
  try {
    // 项目内环境声明的 connect 配置未含 readyTimeout；以变量中转承载
    // （结构化类型对非字面量宽容多余属性），运行时真实 API 支持该选项。
    const connectOptions = {
      host: FTP_HOST,
      port: Number(FTP_PORT),
      username: FTP_USER,
      password: FTP_PASS,
      readyTimeout: 15_000,
    };
    await client.connect(connectOptions);
    return await handler(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function withFtp<T>(handler: (client: FtpClient) => Promise<T>): Promise<T> {
  const client = new FtpClient(15_000);
  try {
    await client.access({ host: FTP_HOST, port: Number(FTP_PORT), user: FTP_USER, password: FTP_PASS });
    return await handler(client);
  } finally {
    client.close();
  }
}

/** 列出远端本轮目录中匹配本轮 baseName 前缀的文件名（再次导出留证辅助；不可达不算失败）。 */
async function listRemoteRoundFilesBestEffort(bases: string[]): Promise<string | undefined> {
  const match = (names: string[]): string =>
    names.filter((name) => bases.some((base) => name.startsWith(base))).join(' | ') || '（本轮目录暂无匹配文件）';
  try {
    if (FTP_PROTOCOL === 'sftp') {
      return match((await withSftp((client) => client.list(ROUND_DIR))).map((entry) => entry.name));
    }
    return match((await withFtp((client) => client.list(ROUND_DIR))).map((entry) => entry.name));
  } catch (error) {
    console.warn(`[evidence] 远端本轮文件列举不可达（不作为失败依据）：${
      error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** 删除远端本轮 baseName 前缀文件；远端不可达或文件缺失仅告警，不掩埋用例结果。 */
async function removeRemoteRoundFilesBestEffort(bases: string[]): Promise<void> {
  const purge = async (names: string[], remove: (name: string) => Promise<void>): Promise<void> => {
    for (const name of names) {
      if (bases.some((base) => name.startsWith(base))) {
        await remove(name).catch(() => undefined);
      }
    }
  };
  try {
    if (FTP_PROTOCOL === 'sftp') {
      // ssh2-sftp-client 为 promise API：delete 删除单个文件（内部 sftp.unlink）。
      await withSftp(async (client) =>
        purge(
          (await client.list(ROUND_DIR)).map((entry) => entry.name),
          (name) =>
            (client as unknown as SftpFileDeleter).delete(`${ROUND_DIR}${name}`).then(() => undefined),
        ));
      return;
    }
    // basic-ftp：remove 删除单个文件（返回 FTPResponse，此处丢弃）。
    await withFtp(async (client) =>
      purge(
        (await client.list(ROUND_DIR)).map((entry) => entry.name),
        async (name) => {
          await client.remove(`${ROUND_DIR}${name}`);
        },
      ));
  } catch (error) {
    console.warn(`[cleanup] 远端本轮文件清理失败（保留现场待人工核查）：${
      error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------- 通用表单辅助（与《FTP-SFTP/文件导出测试工具.ts》口径一致） ----------------

function labelPattern(label: string): RegExp {
  return new RegExp(`^\\s*\\*?\\s*${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*[：:]?\\s*$`);
}

async function nearbyControl(page: Page, label: string, selector: string): Promise<Locator> {
  const labelled = page.getByLabel(labelPattern(label));
  for (let index = 0; index < await labelled.count(); index++) {
    const control = labelled.nth(index);
    if (await control.isVisible().catch(() => false)) return control;
  }

  const labels = page.getByText(labelPattern(label));
  for (let labelIndex = 0; labelIndex < await labels.count(); labelIndex++) {
    const labelNode = labels.nth(labelIndex);
    if (!(await labelNode.isVisible().catch(() => false))) continue;
    let scope: Locator = labelNode;
    // 页面使用“标签 generic + 控件 generic”的相邻结构，控件不一定是 label 的直接子节点。
    for (let level = 0; level < 10; level++) {
      const controls = scope.locator(selector);
      for (let index = 0; index < await controls.count(); index++) {
        const control = controls.nth(index);
        if (await control.isVisible().catch(() => false)) return control;
      }
      scope = scope.locator('..');
    }
  }
  throw new Error(`字段“${label}”未找到可见文本控件，当前页面：${page.url()}`);
}

async function fillTextByLabel(page: Page, label: string, value: string): Promise<void> {
  const field = await nearbyControl(
    page,
    label,
    'input:not([type="checkbox"]):not([type="radio"]), textarea, select',
  );
  await field.fill(value);
}

async function fillOptionalTextByLabel(page: Page, label: string, value: string): Promise<boolean> {
  try {
    await fillTextByLabel(page, label, value);
    return true;
  } catch {
    return false;
  }
}

async function clickVisibleAction(scope: Page | Locator, name: string | RegExp): Promise<void> {
  const candidates: Locator[] = [
    scope.getByRole('button', { name }),
    scope.getByRole('link', { name }),
    scope.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }),
    scope.getByText(name, { exact: true }),
  ];
  for (const candidateGroup of candidates) {
    for (let index = (await candidateGroup.count()) - 1; index >= 0; index--) {
      const candidate = candidateGroup.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        await candidate.click();
        return;
      }
    }
  }
  const currentPage = typeof (scope as Locator).page === 'function' ? (scope as Locator).page() : scope as Page;
  throw new Error(`可见操作“${name}”未找到，当前页面：${currentPage.url()}`);
}

/**
 * 新建导出页的级联选择。每选一级下拉都会销毁重挂载，必须按 aria-controls 锁定
 * 本次打开的面板（run-20260916-172255 实证：全局 visible 选择器会读到上一个
 * 下拉的残留选项）。expected 为空时选最后一个非占位项。
 * 表级（本轮自建 UUID 表）选项由元数据服务异步同步，直建后可见存在延迟：
 * patienceMs 超过默认窗口时在窗口内反复重开下拉扫描，超时仍无则按环境前置
 * 缺失给出可读阻断错误（附当前真实选项清单），绝不静默换成其他表。
 */
async function selectExportCascade(
  page: Page,
  _index: number,
  expected: string | undefined,
  fieldName: string,
  patienceMs = 3_000,
): Promise<string> {
  const box = await nearbyControl(page, fieldName, '.ant-select, .el-select, [role="combobox"], select');
  const expectedText = expected?.replace(/\s+/g, ' ').trim();
  const deadline = Date.now() + Math.max(patienceMs, 0);
  let lastOptionTexts: string[] = [];
  for (let attempt = 1; ; attempt += 1) {
    if ((await box.getAttribute('aria-expanded').catch(() => null)) !== 'true') {
      await box.click();
    }
    const dropdownId = (await box.getAttribute('aria-controls').catch(() => null))
      ?? (await box.getAttribute('aria-owns').catch(() => null));
    const options = dropdownId
      ? page.locator(
        `#${dropdownId} .ant-select-item-option, #${dropdownId} .ant-select-dropdown-menu-item, #${dropdownId} [role="option"]`,
      )
      : page.locator(
        '.ant-select-dropdown:visible .ant-select-item-option, .ant-select-dropdown:visible .ant-select-dropdown-menu-item, .el-select-dropdown:visible .el-select-dropdown__item, [role="listbox"]:visible [role="option"]',
      );
    await expect.poll(async () => await options.count(), { timeout: 8_000 }).toBeGreaterThan(0);
    const texts = (await options.allTextContents()).map((text) => text.replace(/\s+/g, ' ').trim());
    const optionIndex = texts.findIndex((text) => text
      && !/请选择|暂无|无数据/.test(text)
      && (!expectedText || text === expectedText));
    if (optionIndex >= 0) {
      const option = options.nth(optionIndex);
      try {
        await expect(option).toBeVisible({ timeout: 3_000 });
        const selectedText = (await option.innerText()).replace(/\s+/g, ' ').trim();
        await option.click();
        return selectedText;
      } catch (error) {
        if (Date.now() > deadline) throw error;
      }
    } else {
      lastOptionTexts = texts.filter(Boolean);
      if (Date.now() > deadline) {
        throw new Error(
          `当前环境没有可用的${fieldName}${expectedText ? `“${expectedText}”` : ''}，` +
            `已等待 ${Math.max(patienceMs, 0)}ms 元数据同步；当前下拉选项：` +
            `${lastOptionTexts.join(' | ') || '（空）'}（尝试 ${attempt} 次）`,
        );
      }
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(1_000);
    }
  }
}

/** 新建导出表单挂载信号：点“新建导出”后等待表单字面量渲染完成，防早点保存。 */
async function waitForNewExportFormReady(page: Page): Promise<void> {
  await expect(page.getByText(/^新建导出/).first()).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(labelPattern('文件名'), { exact: false }).first(),
  ).toBeVisible({ timeout: 15_000 });
  // 等待保存/确认按钮真正可点，避免表单尚未挂载就触发校验。
  await expect
    .poll(async () => {
      const buttons = page.locator('button:visible, [role="button"]:visible');
      for (let index = 0; index < await buttons.count(); index++) {
        if (/保\s*存|确\s*认/.test(await buttons.nth(index).innerText())) return true;
      }
      return false;
    }, { timeout: 10_000 })
    .toBe(true);
}

/**
 * 确认元数据同步链路已收敛：数据库直建的本轮 UUID 表在“数据源/数据表”级联中可见。
 * 轮询上限 ROUND_TABLE_WAIT_MS（默认 120s）；始终不可见按环境前置缺失条件跳过，
 * 绝不静默换成其他表或伪造通过。
 */
async function ensureRoundSourceTableOptionReady(page: Page): Promise<boolean> {
  const deadline = Date.now() + ROUND_TABLE_WAIT_MS;
  const box = await nearbyControl(page, '数据表', '.ant-select, .el-select, [role="combobox"], select');
  while (Date.now() < deadline) {
    if ((await box.getAttribute('aria-expanded').catch(() => null)) !== 'true') {
      await box.click().catch(() => undefined);
    }
    const dropdownId = (await box.getAttribute('aria-controls').catch(() => null))
      ?? (await box.getAttribute('aria-owns').catch(() => null));
    const options = dropdownId
      ? page.locator(
        `#${dropdownId} .ant-select-item-option, #${dropdownId} .ant-select-dropdown-menu-item, #${dropdownId} [role="option"]`,
      )
      : page.locator(
        '.ant-select-dropdown:visible .ant-select-item-option, .ant-select-dropdown:visible .ant-select-dropdown-menu-item, [role="listbox"]:visible [role="option"]',
      );
    const count = await options.count();
    for (let index = 0; index < count; index++) {
      if ((await options.nth(index).innerText().catch(() => '')).includes(ROUND_TABLE)) {
        await page.keyboard.press('Escape').catch(() => undefined);
        return true;
      }
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(3_000);
  }
  return false;
}

// ---------------- 本轮导出配置（策略语义完全由前端表单驱动） ----------------
const FILE_OPTIONS = {
  多文件: { fileCount: '3', compress: '是' },
  单文件: { fileCount: '1', compress: '否' },
} as const;

interface RoundExportTask {
  name: string;
  fileOption: keyof typeof FILE_OPTIONS;
  partition: string;
}

/** 创建一条本轮任务：填全新建导出表单并保存，成功判据 = 列表出现“文件生成中”在途行。 */
async function createRoundExportTask(
  page: Page,
  testInfo: TestInfo,
  task: RoundExportTask,
  report: (step: string, pass: boolean) => Promise<void>,
): Promise<boolean> {
  const option = FILE_OPTIONS[task.fileOption];
  await clickVisibleAction(page, /新建导出/);
  await waitForNewExportFormReady(page);
  await fillTextByLabel(page, '任务名称', task.name);
  await selectExportCascade(page, 0, undefined, '数据源类型');
  await selectExportCascade(page, 1, EXPORT_SOURCE_NAME, '数据源');
  await selectExportCascade(page, 2, ROUND_TABLE, '数据表', ROUND_TABLE_WAIT_MS);
  await fillTextByLabel(page, '文件名', ROUND_BASE);
  await fillTextByLabel(page, '文件数', option.fileCount);
  await fillTextByLabel(page, '分片数', task.partition);
  await selectByLabel(page, '是否压缩', option.compress);
  await fillTextByLabel(page, '文件路径', ROUND_DIR);
  await fillOptionalTextByLabel(page, '通知地址', '');
  // 调度配置区块的“* 重试次数”为必填且页面无默认值（run-20260917-094648-055
  // 失败快照实证：留空时点击保存被前端校验拦截，保存窗口内不会发出任何非 GET
  // 请求，曾被误报成“未出现成功反馈”）。与 FS-04-04 相同，显式补 0。
  const retryCount = page.getByRole('spinbutton').last();
  if (await retryCount.isVisible().catch(() => false)) await retryCount.fill('0');
  await clickVisibleAction(page, /保\s*存|确\s*认/);
  const created = await expectExportTaskCreated(page, task.name, testInfo);
  await report(`新建导出-${task.fileOption}-${created ? '成功' : '失败'}`, created);
  return created;
}

/**
 * 导出列表“最新导出状态”列是执行结果的页面事实来源（列结构同 FS-04-04：
 * 任务名称/目的文件名/导出次数/保存时长/调度状态/最新导出状态）。
 * 状态列不会自动刷新，每轮读取后 reload 重新拉取；任务名带本轮 uuid，
 * 不会误匹配历史任务行。
 */
async function waitForExportTaskSuccess(page: Page, taskName: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastRowText = '';
  while (Date.now() < deadline) {
    const row = dataRows(page).filter({ hasText: taskName }).first();
    lastRowText = ((await row.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (/执行成功|导出成功/.test(lastRowText)) return lastRowText;
    if (/失败|异常/.test(lastRowText)) {
      throw new Error(`导出任务“${taskName}”本轮执行失败，列表行内容：${lastRowText}`);
    }
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForTimeout(3_000);
  }
  throw new Error(
    `导出任务“${taskName}”在 ${timeoutMs}ms 内未出现“执行成功”状态，` +
      `最后一次列表行内容：${lastRowText || '（未读取到任务行，列表可能未加载或任务不可见）'}`,
  );
}

/**
 * 保存完成的页面判据：本轮任务名出现在导出列表且处于在途/已生成状态，
 * 并把本轮任务行快照挂到报告。列表不可见或状态异常一律抛错，不静默通过。
 */
async function expectExportTaskCreated(page: Page, taskName: string, testInfo: TestInfo): Promise<boolean> {
  const row = dataRows(page).filter({ hasText: taskName }).first();
  try {
    await expect(row).toBeVisible({ timeout: 60_000 });
  } catch (error) {
    await testInfo.attach('ds0204-create-row-missing.txt', {
      body: `本轮任务“${taskName}”保存后 60s 未出现在导出列表；当前页面：${page.url()}`,
      contentType: 'text/plain',
    });
    throw error;
  }
  const rowText = ((await row.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  if (!/文件生成中|生成中|已生成|待执行|执行中|执行成功|导出成功/.test(rowText)) {
    throw new Error(`本轮任务行已出现但状态异常：${rowText}`);
  }
  return true;
}

/** 收尾删除本轮任务行（尽力而为）：先“停止/下线”再“删除”，仅匹配本轮任务名。 */
async function deleteExportTaskRowBestEffort(page: Page, taskName: string): Promise<void> {
  try {
    const row = dataRows(page).filter({ hasText: taskName }).first();
    if (!(await row.isVisible().catch(() => false))) return;
    for (const pattern of [/停\s*止/, /下\s*线/]) {
      const action = row.getByText(pattern).first();
      if (await action.isVisible().catch(() => false)) {
        await action.click().catch(() => undefined);
        const confirm = page.getByRole('button', { name: /确\s*定/ }).last();
        if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => undefined);
        await page.waitForTimeout(1_000);
      }
    }
    const deleteAction = row.getByText(/删\s*除/).first();
    if (await deleteAction.isVisible().catch(() => false)) {
      await deleteAction.click().catch(() => undefined);
      const confirm = page.getByRole('button', { name: /确\s*定/ }).last();
      if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => undefined);
    }
  } catch (error) {
    console.warn(`[cleanup] 本轮任务 ${taskName} 清理未完成（保留现场待人工核查）：${
      error instanceof Error ? error.message : String(error)}`);
  }
}

test.describe('DS-02-04｜数据服务｜多文件、单文件、压缩和同基础文件名再次导出', () => {
  let dbReady = false;
  let dbSkipReason = '';

  test.beforeAll(async () => {
    // 清洁环境夹具门禁：本轮 UUID 来源表由配置中心主库直建；未配置即条件跳过。
    if (!dbConfig()) {
      dbSkipReason = '数据库前置未配置：缺少 DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME（本轮来源表无法直建）。';
      return;
    }
    try {
      await createRoundSourceTable();
      dbReady = true;
    } catch (error) {
      dbSkipReason = `本轮来源表创建失败（清洁环境夹具前置不足）：${
        error instanceof Error ? error.message : String(error)}`;
    }
  });

  test.afterAll(async () => {
    await dropRoundSourceTableBestEffort();
    await removeRemoteRoundFilesBestEffort([ROUND_BASE]);
  });

  test.beforeEach(async ({ loginPage }) => {
    test.skip(!dbReady, `前置未满足：${dbSkipReason || '本轮来源表未就绪'}（清洁环境自建夹具，不回退历史固定数据）`);
    if (!dbReady) return;
    await clickMenu(loginPage, '数据服务', '文件导出', '导出列表');
  });

  test('DS-02-04｜数据服务｜多文件、单文件、压缩和同基础文件名再次导出', async ({ loginPage, consoleErrors, report }) => {
    // 两次任务各含 表单填写+保存（最长 180s，后端创建响应实测约 60 秒）+ 执行状态
    // 轮询（最长 180s），加同基础文件名新任务再导共三轮，需要超出默认单测超时。
    test.setTimeout(600_000);
    const page = loginPage;
    const testInfo = test.info();

    // 原计划覆盖“日期格式 + 压缩”组合维度（序号 72/73）；当前前端创建页已下线
    // “日期格式”控件（run-20260916-161845-734 快照实证：仅 导出类型 全量/SQL、
    // 单文件模式、是否压缩），不得伪造该操作。本轮维度：
    //   任务A 多文件+压缩=是（分片2）→ 成功终态；
    //   任务B 单文件+压缩=否（分片1）→ 成功终态；
    //   任务C 复用同 baseName 的新任务再次导出 → 仅留证第二次导出成功。
    const tasks: RoundExportTask[] = [
      { name: ROUND_TASK_A, fileOption: '多文件', partition: '2' },
      { name: ROUND_TASK_B, fileOption: '单文件', partition: '1' },
    ];
    for (const task of tasks) {
      const created = await createRoundExportTask(page, testInfo, task, report);
      if (!created) throw new Error(`本轮任务创建失败：${task.name}`);
      // 执行由后端异步受理，提交 toast 一闪而过不作为通过依据；
      // 唯一判据是列表“最新导出状态”出现成功终态（同 FS-04-04 判据）。
      await clickExportTaskAction(page, task.name, /执\s*行/);
      const statusText = await waitForExportTaskSuccess(page, task.name, 180_000);
      await report(`导出执行-${task.fileOption}-成功`, true, `任务 ${task.name} 状态：${statusText}`);
    }

    // 同基础文件名再次导出：新建独立任务并复用本轮 baseName；只断言第二次
    // 导出成功，远端文件名列举仅作留证，不可达不判失败。
    const rerun: RoundExportTask = { name: `${ROUND_TASK_A}_rerun`, fileOption: '单文件', partition: '1' };
    const rerunCreated = await createRoundExportTask(page, testInfo, rerun, report);
    if (!rerunCreated) throw new Error(`同基础文件名再次导出任务创建失败：${rerun.name}`);
    await clickExportTaskAction(page, rerun.name, /执\s*行/);
    await waitForExportTaskSuccess(page, rerun.name, 180_000);
    const remoteEvidence = await listRemoteRoundFilesBestEffort([ROUND_BASE]);
    if (remoteEvidence) {
      await testInfo.attach('ds0204-remote-files.txt', { body: remoteEvidence, contentType: 'text/plain' });
    }
    await report(
      '再次导出-同基础文件名新任务-成功',
      true,
      `同名 baseName=${ROUND_BASE} 第二次导出成功${
        remoteEvidence ? `；远端本轮文件：${remoteEvidence}` : '；远端列举不可达（留证缺失不判失败）'}`,
    );

    // 收尾：删除本轮任务行（尽力而为），不掩埋用例结果。
    for (const task of [...tasks, rerun]) {
      await deleteExportTaskRowBestEffort(page, task.name);
    }
    await assertNoConsoleErrors(consoleErrors);
  });
});
