/**
 * DI-04-02｜数据接入｜文件接入与 FTP 接入任务的编辑保存与执行
 *
 * 覆盖场景（Excel「测试用例」34/35/47）：文件接入记录的状态与详情查看；
 * FTP 接入任务“编辑保存（更新原任务）”→ 执行 → 接入实例 → 执行日志。
 *
 * 复制契约更正（agent9 静态复核：后端源码 + run-20260929-002954-565 网络证据）：
 *   - 保存端点 /file-datasource/createFtpInsertDataTaskJob 对新建（isAddFtpTask=true）与
 *     更新（=false，validateUpdateFtpTaskRequest 校验后走同一分支）都返回请求携带的原
 *     uploadTaskId，调度层 updateDataImportByFTPJob 按 id 更新原 xxl-job；系统中不存在
 *     复制出第二个任务的接口或分支，copyMode 只是 DTO 标记字段（1是 2否）；
 *   - 接入列表“文件名称”过滤绑定请求字段 originalFilename（FTP 文件名规则）；列表任务名
 *     取调度 Job 名 fi_<库>.<表>_<uuid> 且每次保存随机再生成；向导里填写的“任务名称”
 *     （请求字段 name）后端 DTO 无对应字段、不持久化、列表不渲染、不可过滤。因此本轮
 *     任务的唯一可证明绑定 = 唯一目标表名（列表“导入数据表”列 = targetTableName）与
 *     保存响应返回的 uploadTaskId，不再按任务名称查找或断言任何“复制的任务 B”。
 *
 * DS-PERM-68 清洁环境迁移（静态开发，未启动浏览器/FTP/DB/调度/业务回归）：
 *   - 测试 1 不再依赖历史已上传文件 gs_test_data_<固定ID>.csv 与固定表 e2e_test_tables：
 *     本轮把仓库资源 gs_test_data.csv 按字节复制为 gs_test_data_<uuid>.csv（原资源只读），
 *     经“新建接入”真实上传→解析→预览→自动建表（唯一表 t_file_di0402_<uuid>）→创建；
 *   - 测试 2 不再搜索/快照任何历史 gs_test_ 任务：本轮先经配置中心 SFTP profile
 *     （FTP_HOST/FTP_PORT/FTP_FILE_PATH/FTP_BASE_FILE/FTP_USER/FTP_PASS 可覆盖，
 *     凭据只来自进程环境变量，与 DI-00-02 当前环境基线同源）自建唯一任务
 *     （唯一目标表 e2e_ftp_a_<uuid>，保存响应返回本轮 uploadTaskId），再打开该任务行
 *     的编辑向导保存更新，并断言保存返回同一 uploadTaskId（“编辑保存=更新原任务”
 *     的当前契约；若返回不同 ID 说明契约变化，必须如实失败），随后上线并执行；
 *   - 状态/实例轮询只绑定本轮唯一目标表名（行内文本命中优先；页面不渲染名称时
 *     仅允许“本轮任务行打开 + 恰好 1 行”的兜底），绝不取任意首行；
 *   - finally 只回收本轮资产：任务先下线再删除（无删除入口则告警保留，UUID 隔离）、
 *     本轮表 DROP IF EXISTS（DB 未配置时记录原因跳过，不影响用例结果）。
 */

import type { Dialog, Locator, Page } from '@playwright/test';
import {
  assertNoConsoleErrors,
  clickMenu,
  expect,
  fillByLabel,
  query,
  selectByLabel,
  test,
  uuid,
} from '../utils.js';
import { openFtpAccessList } from './FTP接入执行工具.js';
import { requireFtpProfile, testEnvironment } from '../../../test-environment.js';
import os from 'node:os';
import path from 'node:path';
import { access, copyFile, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

// 样本文件路径来自配置中心 dataSourceNames.fileAccess.samplePath（FILE_ACCESS_SAMPLE_PATH 可覆盖），
// 上传副本只改文件名、不改字节；自动建表目标数据源同样全部来自配置中心（FILE_AUTO_* 可覆盖）。
const SAMPLE_CSV = path.resolve(testEnvironment.dataSourceNames.fileAccess.samplePath);
const AUTO_SOURCE_TYPE = testEnvironment.dataSourceNames.fileAccess.type;
const AUTO_SOURCE_NAME = testEnvironment.dataSourceNames.fileAccess.name;
const AUTO_DATABASE = testEnvironment.dataSourceNames.fileAccess.database;
const AUTO_SCHEMA = testEnvironment.dataSourceNames.fileAccess.schema;

async function firstVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    const count = await candidate.count();
    // 组件切换时可能短暂保留旧节点；倒序优先当前新渲染的可见节点。
    for (let index = count - 1; index >= 0; index -= 1) {
      const item = candidate.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return undefined;
}

/**
 * 清洁环境规则（DS-PERM-68）：上传文件必须来自仓库资源且不修改该资源。
 * 页面新建上传任务没有“任务名称”输入框，接入列表的“文件名称/任务名称”来自上传文件名，
 * 因此把仓库样本按字节复制到系统临时目录并命名为 gs_test_data_<本轮UUID>.csv（原资源只读），
 * 使本轮表、任务、文件接入名称全部带 UUID ASCII 前缀，可精确定位、finally 只回收本轮记录。
 */
async function createRoundCsvCopy(roundTag: string): Promise<string> {
  const target = path.join(os.tmpdir(), 'ds-perm-68-e2e', `gs_test_data_${roundTag}.csv`);
  await mkdir(path.dirname(target), { recursive: true });
  await access(SAMPLE_CSV, fsConstants.R_OK);
  await copyFile(SAMPLE_CSV, target);
  return target;
}

/**
 * 文件上传接口返回 500 时，后续“预览/映射/建表”都没有真实输入，不能把环境故障记成定位失败。
 * 该判断只识别页面已经展示的服务端错误，不吞掉普通表单或断言错误。
 */
async function skipIfFileUploadUnavailable(page: Page): Promise<void> {
  const uploadFailure = page
    .getByText(/Internal Server Error|上传失败\s*[,，]?\s*请重新上传/)
    .filter({ visible: true })
    .first();
  try {
    await uploadFailure.waitFor({ state: 'visible', timeout: 2_000 });
  } catch {
    return;
  }
  throw new Error('环境前置条件缺失：文件接入上传接口返回 Internal Server Error/上传失败，请先恢复文件上传服务。');
}

/** DROP IF EXISTS 回收本轮表；DB 未配置/驱动缺失时记录原因跳过，不影响用例结果。 */
async function dropTableIfExists(database: string, table: string): Promise<void> {
  try {
    await query(`DROP TABLE IF EXISTS \`${database}\`.\`${table}\``);
    console.warn(`[cleanup] 已回收本轮表：${database}.${table}`);
  } catch (error) {
    console.warn(`[cleanup] 本轮表未回收（DB 未配置或直连失败）：${database}.${table}；原因：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 文件接入自动建表的真实目标字段：标签为“表”，输入框 placeholder 为“请输入表名”（DI-01-01 实证）。 */
async function fillAutomaticTableName(page: Page, tableName: string): Promise<void> {
  const tableNameInput = page.getByPlaceholder('请输入表名').filter({ visible: true }).last();
  await expect(tableNameInput).toBeVisible({ timeout: 10_000 });
  await tableNameInput.fill(tableName);
}

/** 选择文件接入页面真实的自动建表目标级联字段（全部来自配置中心）。 */
async function chooseAutomaticTableTarget(page: Page): Promise<void> {
  await selectByLabel(page, '数据源类型', AUTO_SOURCE_TYPE);
  await selectByLabel(page, '数据源名称', AUTO_SOURCE_NAME);
  await selectByLabel(page, '数据库名称', AUTO_DATABASE);
  await selectByLabel(page, 'Schema名称', AUTO_SCHEMA);
  const automaticRadio = page.getByRole('radio', { name: '自动建表', exact: true });
  await expect(automaticRadio).toBeVisible({ timeout: 10_000 });
  await automaticRadio.check();
}

/** 点击“新建接入”后，确认已经进入真实的两步式文件接入表单。 */
async function openFileAccessForm(page: Page): Promise<void> {
  const formMarker = page.getByText(/上传文件/).filter({ visible: true }).last();
  if (!(await formMarker.isVisible().catch(() => false))) {
    const newButton = await firstVisible([
      page.getByRole('button', { name: /新建接入|新增接入/ }),
      page.locator('button:visible').filter({ hasText: /新建接入|新增接入/ }),
    ]);
    if (!newButton) throw new Error(`文件接入“新建接入”按钮未找到，当前页面：${page.url()}`);
    await newButton.click();
  }
  await expect(page.getByText(/上传文件/).filter({ visible: true }).last()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: /选择文件/ }).filter({ visible: true }).last()).toBeVisible({ timeout: 10_000 });
}

/** 文件接入页同时存在外层 ant-upload 和内层按钮，不能使用宽泛的 role=button 正则。 */
async function uploadInFileAccessForm(page: Page, filePath: string): Promise<void> {
  const fileInputs = page.locator('input[type="file"]');
  if (await fileInputs.count()) {
    await fileInputs.last().setInputFiles(filePath);
    await skipIfFileUploadUnavailable(page);
    return;
  }
  const trigger = await firstVisible([
    page.getByRole('button', { name: /图标:\s*upload\s*选择文件/ }),
    page.getByRole('button', { name: /^选择文件$/ }),
    page.locator('.ant-upload:visible'),
  ]);
  if (!trigger) throw new Error(`文件接入表单中的“选择文件”按钮未找到，当前页面：${page.url()}`);
  const chooserPromise = page.waitForEvent('filechooser');
  await trigger.click();
  await (await chooserPromise).setFiles(filePath);
  await skipIfFileUploadUnavailable(page);
}

async function previewUploadedFile(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /数据预览|预\s*览/ }).click();
  const candidates = [
    page.getByRole('dialog', { name: /字段预览/ }),
    page.locator('.ant-modal-wrap:visible, .ant-modal:visible, .el-dialog:visible').filter({ hasText: /字段预览/ }),
  ];
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const preview = await firstVisible(candidates);
    if (preview) return preview;
    await page.waitForTimeout(250);
  }
  throw new Error('点击“数据预览”后 15 秒内未打开字段预览弹窗。');
}

async function closeFilePreview(page: Page, preview: Locator): Promise<void> {
  const close = await firstVisible([
    preview.getByRole('button', { name: /关闭|Close/ }),
    preview.locator('button:visible, [role="button"]:visible, [aria-label*="close" i]:visible, [title*="close" i]:visible'),
    page.locator('.ant-modal-close:visible, .el-dialog__headerbtn:visible'),
  ]);
  if (close) await close.click();
  else await page.keyboard.press('Escape');
  await expect(preview).toBeHidden({ timeout: 5_000 });
}

async function clickWizardNext(page: Page, expectedMarker: RegExp): Promise<void> {
  const next = await firstVisible([
    page.getByRole('button', { name: /下一步/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /下一步/ }),
  ]);
  if (!next) throw new Error('文件接入向导未找到“下一步”按钮。');
  await next.click();
  await expect(page.getByText(expectedMarker).filter({ visible: true }).last()).toBeVisible({ timeout: 15_000 });
}

/** 字段映射页必须真实展示本轮 CSV 的 4 个来源字段（name/age/phone_number/adress_di）且目标字段合法。 */
async function validateRoundFileMapping(page: Page): Promise<void> {
  const mappingRows = page
    .locator('tbody tr:visible, .ant-table-tbody tr:visible, .el-table__body-wrapper tr:visible')
    .filter({ hasText: /name|age|phone_number|adress_di/ });
  await expect(mappingRows, '字段映射页未展示上传 CSV 的来源字段').toHaveCount(4, { timeout: 10_000 });

  const targets: string[] = [];
  for (let index = 0; index < (await mappingRows.count()); index += 1) {
    const row = mappingRows.nth(index);
    const source = (await row.innerText()).split(/\s+/).filter(Boolean)[0] ?? `第${index + 1}行`;
    // 行首 checkbox 也是 input，目标字段是本行第一个非 checkbox 的可编辑输入框。
    const targetInput = row.locator('input:not([type="checkbox"]):visible').first();
    const target = (await targetInput.inputValue()).trim();
    expect(target, `来源字段“${source}”未自动映射目标字段`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    targets.push(target);
  }
  expect(new Set(targets).size, '自动建表的目标字段名不能重复').toBe(targets.length);
}

async function confirmFileAccessMapping(page: Page): Promise<void> {
  const confirm = await firstVisible([
    page.getByRole('button', { name: /^确\s*定$/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /^确\s*定$/ }),
    page.getByText(/^确\s*定$/, { exact: true }).filter({ visible: true }),
  ]);
  if (!confirm) throw new Error('字段映射页未找到“确定”创建按钮。');
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST' && /createOrUpdateDataFromFileTask/i.test(response.url()),
    { timeout: 30_000 },
  );
  await confirm.click();
  const result = await (await responsePromise).json().catch(() => undefined) as { code?: string; message?: string } | undefined;
  if (result?.code !== '000000') throw new Error(`文件接入保存失败（code=${result?.code ?? '未知'}）：${result?.message ?? '无响应详情'}`);
  await expect.poll(async () => {
    const success = await firstVisible([
      page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
        .filter({ hasText: /成功|创建|保存|同步/ }),
      page.getByText(/创建成功|保存成功|同步任务已创建/).filter({ visible: true }),
    ]);
    return success || !/fileAccessCreate/i.test(page.url()) ? 'created' : 'waiting';
  }, { timeout: 20_000 }).toBe('created');
}


// ==================== 本轮文件接入记录：列表状态与详情（固定列拆分表，行号对齐） ====================

function tableWithHeader(page: Page, header: RegExp): Locator {
  return page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: header }) }).first();
}

function uploadedNamePrefix(uploadCsv: string): string {
  return `${path.parse(uploadCsv).name}_`;
}

function matchesUploadedName(name: string, uploadCsv: string): boolean {
  return name.trim().startsWith(uploadedNamePrefix(uploadCsv)) && name.trim().toLowerCase().endsWith('.csv');
}

function fileNameTableRows(page: Page): Locator {
  return tableWithHeader(page, /文件名称/)
      .locator('tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not(:has([role="columnheader"]))');
}

async function statusTableRows(page: Page): Promise<Locator> {
  const statusTable = tableWithHeader(page, /导入状态/);
  if ((await statusTable.count()) > 0) {
    return statusTable
        .locator('tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not(:has([role="columnheader"]))');
  }
  return tableWithHeader(page, /操作/)
      .locator('tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not(:has([role="columnheader"]))');
}

/**
 * 创建后的可见最终状态：接入列表按本轮唯一“文件名称”查询到本轮任务行，
 * 并轮询同行号的状态行出现完成/成功/同步文案；不以创建 toast 代替最终状态。
 */
async function verifyTaskVisibleInList(page: Page, uploadCsv: string): Promise<void> {
  const fileNamePrefix = uploadedNamePrefix(uploadCsv);
  await clickMenu(page, '数据接入', '文件接入');
  await fillByLabel(page, '文件名称', fileNamePrefix);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
    await queryButton.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    if (await fileNameTableRows(page).filter({ hasText: fileNamePrefix }).first().isVisible().catch(() => false)) break;
  }
  await expect
    .poll(async () => {
      const allRows = fileNameTableRows(page);
      const total = await allRows.count();
      if (total !== 1 || !matchesUploadedName(await allRows.first().locator('td').first().innerText().catch(() => ''), uploadCsv)) return 'waiting-filter';
      const rows = await statusTableRows(page);
      const statusText = (await rows.first().innerText().catch(() => '')).replace(/\s+/g, '');
      return /完成|成功|同步/.test(statusText) ? 'done' : `status:${statusText.slice(0, 40)}`;
    }, { timeout: 90_000 })
    .toBe('done');
}

/** 打开本轮记录的“查看详情”：入口行号绑定唯一文件名所在行，不取任意首行。 */
async function openRoundFileDetail(page: Page, fileName: string): Promise<void> {
  const allRows = fileNameTableRows(page);
  let rowIndex = -1;
  for (let index = 0; index < (await allRows.count()); index += 1) {
    if (matchesUploadedName(await allRows.nth(index).locator('td').first().innerText().catch(() => ''), fileName)) {
      rowIndex = index;
      break;
    }
  }
  if (rowIndex < 0) throw new Error(`文件接入列表未找到本轮唯一文件“${fileName}”，无法打开详情。`);
  const detail = page.getByText('查看详情', { exact: true }).filter({ visible: true }).nth(rowIndex);
  await expect(detail, `第 ${rowIndex + 1} 行应有“查看详情”入口`).toBeVisible({ timeout: 10_000 });
  await detail.click();
  await page.waitForTimeout(600);
  await expect(
    page.getByText(/文件名称|文件详情|解析结果|数据源/).filter({ visible: true }).last(),
    '详情视图应展示文件接入记录信息',
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * 回收本轮任务：仅在“文件名称”过滤后的本轮行存在，且同一行号的状态/操作列出现“删除”时点击，
 * 并确认可能出现的气泡/弹窗确认框；页面未提供删除操作时记录说明，绝不误删其它任务。
 */
async function deleteRoundTaskIfExists(page: Page, fileName: string): Promise<void> {
  try {
    await clickMenu(page, '数据接入', '文件接入');
    await fillByLabel(page, '文件名称', uploadedNamePrefix(fileName));
    const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
    await queryButton.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    const allRows = fileNameTableRows(page);
    let rowIndex = -1;
    for (let index = 0; index < (await allRows.count()); index += 1) {
      if (matchesUploadedName(await allRows.nth(index).locator('td').first().innerText().catch(() => ''), fileName)) {
        rowIndex = index;
        break;
      }
    }
    if (rowIndex < 0) return; // 本轮任务未创建成功，无可回收记录
    const operationRow = (await statusTableRows(page)).nth(rowIndex);
    const deleteAction = await firstVisible([
      operationRow.getByRole('button', { name: /删\s*除/ }),
      operationRow.getByRole('link', { name: /删\s*除/ }),
      operationRow.getByText(/删\s*除/).filter({ visible: true }),
    ]);
    if (!deleteAction) {
      console.warn(`[cleanup] 接入列表未提供“删除”操作，本轮任务记录保留：${fileName}`);
      return;
    }
    const acceptDialog = (dialog: Dialog): void => {
      void dialog.accept().catch(() => undefined);
    };
    page.once('dialog', acceptDialog);
    try {
      await deleteAction.click();
      const confirmButton = await firstVisible([
        page.getByRole('button', { name: /^确\s*定$/ }).filter({ visible: true }),
        page
          .locator('.ant-popconfirm:visible button, .el-popconfirm:visible button, .ant-modal:visible button, .el-message-box:visible button')
          .filter({ hasText: /^确\s*定$/ }),
      ]);
      if (confirmButton) await confirmButton.click();
      await expect
        .poll(async () => ((await fileNameTableRows(page).count()) === 0 ? 'deleted' : 'removing'), { timeout: 15_000 })
        .toBe('deleted');
      console.warn(`[cleanup] 已删除本轮文件接入任务：${fileName}`);
    } finally {
      page.off('dialog', acceptDialog);
    }
  } catch (error) {
    console.warn(`[cleanup] 本轮文件接入任务回收未完成（${fileName}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

test('DI-04-02｜文件接入：本轮上传样本解析完成后可查看状态与详情', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(600_000);
  const page = loginPage;
  const roundTag = uuid();
  const tableName = `t_file_di0402_${roundTag}`;
  const uploadCsv = await createRoundCsvCopy(roundTag);
  const fileName = path.basename(uploadCsv);
  try {
    await clickMenu(page, '数据接入', '文件接入');
    await openFileAccessForm(page);
    await uploadInFileAccessForm(page, uploadCsv);
    await fillByLabel(page, '列分隔符', ',');
    const headerRadio = page.getByRole('radio', { name: '是', exact: true }).last();
    if (await headerRadio.isVisible().catch(() => false)) await headerRadio.check();

    // 数据预览：本轮上传样本的解析结果必须真实可见（字段 name + 样例值 张三）。
    const preview = await previewUploadedFile(page);
    const previewText = await preview.innerText().catch(() => '');
    expect(previewText, '字段预览应包含来源字段 name').toContain('name');
    expect(previewText, '字段预览应包含样本数据 张三').toContain('张三');
    await closeFilePreview(page, preview);

    await chooseAutomaticTableTarget(page);
    await fillAutomaticTableName(page, tableName);
    await clickWizardNext(page, /字段映射|目标映射|来源字段/);
    await validateRoundFileMapping(page);
    await confirmFileAccessMapping(page);

    // 本用例业务点：成功样本的“导入状态”与“查看详情”（状态轮询绑定本轮唯一文件名）。
    await verifyTaskVisibleInList(page, uploadCsv);
    await openRoundFileDetail(page, fileName);

    await assertNoConsoleErrors(consoleErrors);
    await report('文件接入-本轮上传样本状态与详情查看', true, `文件=${fileName}；目标表=${tableName}；导入状态与详情视图均已校验。`);
  } finally {
    await deleteRoundTaskIfExists(page, fileName);
    await dropTableIfExists(AUTO_DATABASE, tableName);
  }
});


// ==================== 本轮 FTP/SFTP 接入任务：创建 → 编辑保存（更新原任务）→ 执行 → 实例日志 → 回收 ====================
// 接入列表是固定列拆分表：左侧“文件名称”table、右侧“导入状态/操作”table；
// 主表/操作表行号一一对应，绑定本轮任务时用同一行号对齐，不依赖首行/末行/固定页码。

function todayString(): string {
  const value = new Date();
  return `${value.getFullYear()}${String(value.getMonth() + 1).padStart(2, '0')}${String(value.getDate()).padStart(2, '0')}`;
}

async function lastVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    for (let index = (await candidate.count()) - 1; index >= 0; index -= 1) {
      const item = candidate.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return undefined;
}

async function clickButton(page: Page, name: RegExp): Promise<void> {
  const button = await lastVisible([
    page.getByRole('button', { name }),
    page.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }),
  ]);
  if (!button) throw new Error(`页面没有可见操作“${String(name)}”，当前页面：${page.url()}`);
  await button.click();
  await page.waitForTimeout(500);
}

async function fillFirstMatchingLabel(page: Page, labels: string[], value: string): Promise<void> {
  for (const label of labels) {
    try {
      await fillByLabel(page, label, value);
      return;
    } catch {
      // 不同版本对同一字段的 label 文案不同（如“用户名/登录用户名”），逐个尝试。
    }
  }
  throw new Error(`未找到可填写字段：${labels.join(' / ')}`);
}

/** “基础文件名”等未关联 for 的 label，从 label 向上爬 DOM 找可见输入框（DI-00-02 同款）。 */
async function fillNearLabel(page: Page, labelText: string, value: string): Promise<void> {
  const label = page.getByText(labelText, { exact: true }).filter({ visible: true }).last();
  await expect(label, `未找到“${labelText}”标签`).toBeVisible({ timeout: 10_000 });
  let scope = label.locator('..');
  for (let level = 0; level < 5; level += 1, scope = scope.locator('..')) {
    const input = scope.locator('input:visible:not([type="radio"]):not([type="checkbox"])').last();
    if (await input.isVisible().catch(() => false)) {
      await input.fill(value);
      return;
    }
  }
  throw new Error(`未找到“${labelText}”对应输入框。`);
}

function exactOption(label: string): RegExp {
  return new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
}

async function selectStableByLabel(page: Page, labelText: string, value: string): Promise<void> {
  // 若下拉当前值已是目标值（编辑/回显场景），不要重复点击展开。
  const current = page.locator(`.el-select:has(.el-input__inner[placeholder*="${labelText}"]), .ant-select:visible`).first();
  if ((await current.innerText().catch(() => '')).trim() === value) return;
  try {
    await selectByLabel(page, labelText, value);
    return;
  } catch {
    // 降级：点开下拉后按可见选项文本精确匹配。
  }
  const opened = page.locator('.el-select-dropdown:visible, .ant-select-dropdown:visible').last();
  const option = await lastVisible([
    opened.locator('li:visible, .ant-select-item-option:visible').filter({ hasText: exactOption(value) }),
    page.locator('li:visible, .ant-select-item-option:visible').filter({ hasText: exactOption(value) }),
  ]);
  if (!option) throw new Error(`下拉“${labelText}”没有选项“${value}”。`);
  await option.click();
}

/** 页面中日期格式是固定文本；真实文件名有 3 个下拉，文件周期有 2 个下拉。 */
async function configureRoundDateRule(page: Page): Promise<void> {
  await expect(page.getByText(/真实文件名/).filter({ visible: true }).last()).toBeVisible();
  await expect(page.getByText('${yyyyMMdd}', { exact: true }).filter({ visible: true }).last()).toBeVisible();
  await expect(page.getByText(/文件周期/).filter({ visible: true }).last()).toBeVisible();
  const values = ['_', '空', '空', '日', testEnvironment.fileTransfer.fileDateOffset ?? '0'];
  const combos = page.locator('.el-select:visible, .ant-select:visible');
  await expect.poll(async () => await combos.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(5);
  for (let index = 0; index < values.length; index += 1) {
    await combos.nth(index).click();
    const opened = page.locator('.el-select-dropdown:visible, .ant-select-dropdown:visible').last();
    const option = opened
      .locator('li:visible, .ant-select-item-option:visible')
      .filter({ hasText: exactOption(values[index]) })
      .last();
    await option.click();
    await page.waitForTimeout(150);
  }
}


/** 自动建表目标表名：label“表”+ 请输入表名输入框（DI-00-02 / DI-01-01 实证两种定位）。 */
async function fillFtpAutomaticTableName(page: Page, value: string): Promise<void> {
  const placeholderInput = page.getByPlaceholder(/请输入表名/).filter({ visible: true }).last();
  if (await placeholderInput.isVisible().catch(() => false)) {
    await placeholderInput.fill(value);
    return;
  }
  const labels = page.getByText(/^\s*\*?\s*表\s*[:：]?\s*$/).filter({ visible: true });
  for (let index = (await labels.count()) - 1; index >= 0; index -= 1) {
    let scope = labels.nth(index);
    for (let depth = 0; depth < 6; depth += 1, scope = scope.locator('..')) {
      const field = scope.locator('input:not([type="radio"]):not([type="checkbox"]):not([disabled]):visible').last();
      if ((await field.isVisible().catch(() => false)) && (await field.isEditable().catch(() => false))) {
        await field.fill(value);
        return;
      }
    }
  }
  throw new Error('FTP 向导未找到自动建表“表”输入框，无法填写本轮唯一目标表名。');
}

/** 目标列统一改成本轮唯一 ASCII 命名，规避中文列名在后端链路的历史失败模式（原 DI-04-02 实证）。 */
async function normalizeRoundMappingColumns(page: Page): Promise<void> {
  const rows = page.locator('tbody tr:visible, .ant-table-tbody tr:visible, .el-table__body-wrapper tr:visible');
  const count = await rows.count();
  if (count === 0) throw new Error('字段映射页没有可见映射行，无法规范化目标列名。');
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const source = (await row.innerText().catch(() => '')).split(/\s+/).filter(Boolean)[0] ?? `第${index + 1}行`;
    if (!/^[\w#@$]+$/.test(source)) continue;
    const target = row.locator('input:visible:not([type="checkbox"]):not([type="radio"]):not([disabled])').first();
    if (await target.isVisible().catch(() => false)) {
      await target.fill(`e2e_col_${String(index).padStart(2, '0')}`);
    }
  }
}

/**
 * 走完向导剩余步骤：途中回填任务名称/重试次数，最后点确定。
 * 新建与编辑保存都唯一命中 POST /createFtpInsertDataTaskJob（FileUploadController 单端点，
 * isAddFtpTask 区分新建/更新）；断言 code=000000 并把响应 object（uploadTaskId）返回给
 * 调用方——当前契约下该值恒等于请求携带的原任务 ID，是“编辑保存=更新原任务、不产生
 * 第二个任务”的可证明证据。
 */
async function finishWizardAndSave(page: Page, taskName: string, operation: 'create' | 'update' = 'create'): Promise<string | undefined> {
  for (let step = 0; step < 8; step += 1) {
    const taskField = await lastVisible([
      page.getByLabel(/任务名称|接入任务名称/).filter({ visible: true }),
      page.getByPlaceholder(/任务名称|接入任务名称/).filter({ visible: true }),
    ]);
    if (taskField) await taskField.fill(taskName);
    const retry = page.getByRole('spinbutton').filter({ visible: true }).last();
    if (await retry.isVisible().catch(() => false)) await retry.fill('0');
    const next = await lastVisible([
      page.getByRole('button', { name: /下一步/ }),
      page.locator('button:visible, [role="button"]:visible').filter({ hasText: /下一步/ }),
    ]);
    if (!next) break;
    await next.click();
    await page.waitForTimeout(600);
  }
  const confirm = await lastVisible([
    page.getByRole('button', { name: /^\s*确\s*定\s*$/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /^\s*确\s*定\s*$/ }),
  ]);
  if (!confirm) throw new Error('接入向导最后一步没有“确定”按钮，任务未保存。');
  // 新建与编辑保存都唯一命中该端点：等待并校验响应，同时取回 uploadTaskId（object）。
  const saveResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && /createFtpInsertDataTaskJob/i.test(response.url()),
    { timeout: 30_000 },
  );
  await confirm.click();
  const saved = await (await saveResponse).json().catch(() => undefined) as
    { code?: string; message?: string; object?: unknown } | undefined;
  if (saved?.code !== '000000') {
    const reason = saved?.message?.replace(/(password|pwd|密码)\s*[:=]\s*[^,\s;]+/gi, '[redacted]').slice(0, 500) ?? '无响应详情';
    throw new Error(`FTP 接入任务${operation === 'create' ? '创建' : '编辑'}保存失败（code=${saved?.code ?? '未知'}）：${reason}`);
  }
  await expect.poll(async () => {
    const text = await page.locator('body').innerText().catch(() => '');
    return /创建成功|保存成功|同步任务已创建|接入任务已创建/.test(text) || !/ftpAccessCreate/i.test(page.url()) ? 'saved' : 'waiting';
  }, { timeout: 30_000 }).toBe('saved');
  return typeof saved.object === 'string' ? saved.object : undefined;
}


function ftpTableRows(page: Page, header: RegExp): Locator {
  return page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: header }) }).first()
      .locator('tbody > tr:visible, .ant-table-tbody > tr:visible');
}

/** 后端保存的日期占位符与页面展示存在大小写差异；文本空白也不参与精确匹配。 */
function normalizeFileName(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

/** 同一个日期文件名受后端唯一键约束；创建 A 前只删除当前 FTP profile 的同名测试记录。 */
async function removeExistingDateRuleFtpTasks(page: Page): Promise<number> {
  const baseFile = requireFtpProfile().baseFile;
  const dot = baseFile.lastIndexOf('.');
  const stem = dot >= 0 ? baseFile.slice(0, dot) : baseFile;
  const extension = dot >= 0 ? baseFile.slice(dot) : '';
  const expectedFileName = `${stem}_\${CURRENT_DATE}${extension}`;
  const normalizedExpectedName = normalizeFileName(expectedFileName);
  const locate = async (): Promise<number> => {
    const rows = ftpTableRows(page, /导入状态/);
    const names = ftpTableRows(page, /文件名称/);
    const count = Math.min(await rows.count(), await names.count());
    for (let index = 0; index < count; index += 1) {
      const name = (await names.nth(index).innerText().catch(() => '')).trim();
      if (normalizeFileName(name) === normalizedExpectedName) return index;
    }
    return -1;
  };
  let removed = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await openFtpAccessList(page);
    let match = await locate();
    const searchInput = page.locator('input:visible:not([type="radio"]):not([type="checkbox"])').first();
    const searchButton = await lastVisible([
      page.getByRole('button', { name: /^查\s*询$/ }),
      page.locator('button:visible, [role="button"]:visible').filter({ hasText: /^查\s*询$/ }),
    ]);
    if (match < 0 && (await searchInput.isVisible().catch(() => false))) {
      await searchInput.fill(expectedFileName);
      if (searchButton) await searchButton.click();
      await page.waitForTimeout(800);
      match = await locate();
      await searchInput.fill('');
      if (searchButton) await searchButton.click();
      await page.waitForTimeout(800);
    }
    if (match < 0) return removed;
    const rows = ftpTableRows(page, /导入状态/);
    const targetTable = (await rows.nth(match).locator('td').nth(4).innerText().catch(() => '')).trim();
    const operation = ftpTableRows(page, /操作/).nth(match);
    const offline = operation.getByRole('button', { name: '下线', exact: true });
    if (await offline.isVisible().catch(() => false)) {
      await offline.click();
      const confirm = page.getByRole('tooltip').getByRole('button', { name: /确\s*定/ }).last();
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
      await expect(operation.getByRole('button', { name: '上线', exact: true })).toBeVisible({ timeout: 15_000 });
    }
    const deleteButton = operation.getByRole('button', { name: '删除', exact: true });
    await expect(deleteButton, `同名测试任务 ${expectedFileName} (${targetTable}) 应可删除`).toBeVisible();
    page.once('dialog', (dialog) => { void dialog.accept(); });
    await deleteButton.click();
    const confirm = page.getByRole('tooltip').getByRole('button', { name: /确\s*定/ }).last();
    await expect(confirm, '删除同名 FTP 任务应出现确认按钮').toBeVisible();
    await confirm.click();
    await expect.poll(async () => {
      await openFtpAccessList(page);
      return (await locate()) < 0 ? 'absent' : 'present';
    }, { timeout: 20_000 }).toBe('absent');
    removed += 1;
    console.warn(`[preflight] 已删除同名 FTP 测试任务：${expectedFileName}；目标表=${targetTable || '未生成'}`);
  }
  throw new Error(`同名 FTP 测试任务达到 10 条清理上限，已删除 ${removed} 条；停止创建以免继续产生重复数据。`);
}

/**
 * 在接入列表绑定本轮唯一任务行：当前列表“文件名称”查询框绑定请求字段 originalFilename
 * （FTP 文件名规则，网络证据 run-20260929-002954-565：按任务名查询返回 0 行），向导任务
 * 名称既不渲染也不可过滤，因此绑定依据 = 行内唯一目标表名（“导入数据表”列 =
 * targetTableName，本轮 UUID 命名全局唯一）；主表/操作表共享行号，翻页扫描兜底。
 */
async function findRoundFtpTaskRowIndex(page: Page, targetTableName: string): Promise<number> {
  await openFtpAccessList(page);
  const locate = async (): Promise<number> => {
    const rows = ftpTableRows(page, /导入状态/);
    const fileRows = ftpTableRows(page, /文件名称/);
    const count = Math.min(await rows.count(), await fileRows.count());
    for (let index = 0; index < count; index += 1) {
      const text = `${await rows.nth(index).innerText().catch(() => '')} ${await fileRows.nth(index).innerText().catch(() => '')}`;
      if (text.includes(targetTableName)) return index;
    }
    return -1;
  };
  let index = await locate();
  for (let pageIndex = 0; index < 0 && pageIndex < 5; pageIndex += 1) {
    const next = await lastVisible([
      page.getByRole('button', { name: /下一页/ }),
      page.locator('button:visible, [role="button"]:visible, li:visible').filter({ hasText: /下一页/ }),
    ]);
    if (!next || (await next.isDisabled().catch(() => true))) break;
    await next.click();
    await page.waitForTimeout(800);
    index = await locate();
  }
  if (index < 0) throw new Error(`接入列表未找到本轮唯一目标表“${targetTableName}”对应的任务行（已尝试行内文本与翻页扫描）。`);
  return index;
}

async function clickRoundOperation(page: Page, index: number, name: RegExp): Promise<void> {
  const row = ftpTableRows(page, /操作/).nth(index);
  const action = await lastVisible([
    row.getByText(name).filter({ visible: true }),
    row.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }),
    page.getByText(name).filter({ visible: true }).nth(index),
  ]);
  if (!action) throw new Error(`本轮任务行第 ${index + 1} 行没有可见操作“${String(name)}”。`);
  await action.click();
  await page.waitForTimeout(500);
}

/** 新建任务默认离线：上线态则跳过；离线态点“上线”并等待“下线”出现。 */
async function ensureRoundTaskOnline(page: Page, index: number): Promise<void> {
  const row = ftpTableRows(page, /操作/).nth(index);
  if (await row.getByRole('button', { name: '下线', exact: true }).isVisible().catch(() => false)) return;
  if (await row.getByRole('button', { name: '上线', exact: true }).isVisible().catch(() => false)) {
    await clickRoundOperation(page, index, /^上线$/);
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (await ftpTableRows(page, /操作/).nth(index).getByRole('button', { name: '下线', exact: true }).isVisible().catch(() => false)) return;
      await page.waitForTimeout(500);
    }
    throw new Error(`本轮任务上线后 12 秒内未出现“下线”操作（第 ${index + 1} 行）。`);
  }
}


/** 经配置中心自建本轮唯一 FTP 接入任务（自动建表目标 = 唯一表名）；返回保存响应中的 uploadTaskId（本轮任务唯一 ID）。 */
async function createRoundFtpAccessTask(page: Page, taskName: string, tableName: string): Promise<string | undefined> {
  const ftp = requireFtpProfile();
  const baseFile = ftp.baseFile;
  const previewFileStem = baseFile.replace(/\.[^./]+$/, '');
  await openFtpAccessList(page);
  const create = await lastVisible([
    page.getByRole('button', { name: /新建接入|新增接入/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /新建接入|新增接入/ }),
  ]);
  if (!create) throw new Error(`ftp文件接入列表没有“新建接入/新增接入”按钮：${page.url()}`);
  await create.click();
  await expect(page.getByText('来源文件', { exact: true }).filter({ visible: true }).last()).toBeVisible({ timeout: 15_000 });

  // 协议和路径都取当前 FTP profile；不再把 SFTP 的旧地址、端口和目录写入 FTP 向导。
  const ftpRadio = page.getByRole('radio', { name: /^ftp$/i }).last();
  await ftpRadio.check();
  await expect(ftpRadio).toBeChecked({ timeout: 5_000 });
  await fillFirstMatchingLabel(page, ['地址', 'ftp地址', 'sftp地址', 'ftp服务器地址', 'sftp服务器地址'], ftp.host);
  await fillFirstMatchingLabel(page, ['端口'], String(ftp.port));
  await fillFirstMatchingLabel(page, ['用户名', '登录用户名'], ftp.username);
  await fillFirstMatchingLabel(page, ['密码', '登录密码'], ftp.password);
  await fillFirstMatchingLabel(page, ['文件', '文件路径'], ftp.baseDir);
  await fillNearLabel(page, '基础文件名', baseFile);
  await configureRoundDateRule(page);

  await selectStableByLabel(page, '数据源类型', testEnvironment.dataSourceNames.fileAccess.type);
  await selectStableByLabel(page, '数据源名称', testEnvironment.dataSourceNames.fileAccess.name);
  await selectStableByLabel(page, '数据库名称', testEnvironment.dataSourceNames.fileAccess.database);
  await selectStableByLabel(page, 'Schema', testEnvironment.dataSourceNames.fileAccess.schema);
  const auto = page.getByRole('radio', { name: '自动建表', exact: true }).last();
  await auto.click();
  await expect(auto).toBeChecked({ timeout: 5_000 });
  await fillFtpAutomaticTableName(page, tableName);

  // 测试连接：接口等待 + 响应体断言（DI-00-02 同款，不依赖瞬时 toast）。
  const connection = page
    .waitForResponse(
      (response) => response.request().method() === 'POST' && /(?:saveFtpServerConfig|ftp.*connect|connect.*ftp|testConnect)/i.test(response.url()),
      { timeout: 30_000 },
    )
    .catch(() => undefined);
  await clickButton(page, /测试连接/);
  const response = await connection;
  if (response) {
    const body = await response.text().catch(() => '');
    if (response.status() >= 300 || /失败|错误|异常|fail|error/i.test(body)) {
      throw new Error(`本轮 FTP 测试连接失败：HTTP ${response.status()} ${body.slice(0, 300)}`);
    }
  }
  await clickButton(page, /预览文件名/);
  await expect(
    page.getByText(new RegExp(`${previewFileStem}.*${todayString()}`)).filter({ visible: true }).last(),
    '预览文件名应包含基础文件主名与当天日期',
  ).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape').catch(() => undefined);
  await clickButton(page, /数据预览/);
  const preview = page.locator('.el-dialog:visible, .ant-modal:visible, [role="dialog"]:visible').last();
  await expect(preview, '点击“数据预览”后应打开字段预览弹窗').toBeVisible({ timeout: 15_000 });
  await expect.poll(
    async () => (await preview.innerText().catch(() => '')).replace(/\s/g, '').length > 0 ? 'ready' : 'waiting',
    { timeout: 15_000 },
  ).toBe('ready');
  await page.keyboard.press('Escape').catch(() => undefined);

  await clickButton(page, /下一步/);
  await expect(page.getByText(/字段映射|目标映射|来源字段/).filter({ visible: true }).last()).toBeVisible({ timeout: 15_000 });
  await normalizeRoundMappingColumns(page);
  return await finishWizardAndSave(page, taskName);
}


/**
 * 实例状态轮询：只绑定本轮唯一任务（依据 = 行文本包含本轮唯一目标表名；
 * 调度 Job 名 fi_<库>.<表>_<uuid> 内嵌目标表名，实例行同样可命中）。
 *   1) 优先命中“行文本包含唯一目标表名”的实例行；
 *   2) 实例页不渲染名称时，仅当“该页自本轮任务行打开 + 全部实例恰好 1 行”才允许兜底读取；
 *      本轮任务此前没有任何实例，单行不可能属于其他任务。
 */
async function pollRoundInstanceRow(instancePage: Page, targetTableName: string, timeoutMs: number): Promise<{ row: Locator; index: number }> {
  const rows = instancePage.locator('tbody tr:visible, .el-table__body-wrapper tr:visible, [role="row"]:visible');
  const finishText = /执行成功|同步完成|接入成功|执行完成/;
  const failText = /执行失败|同步失败|接入失败|异常/;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const total = await rows.count();
    let bound: { row: Locator; index: number } | undefined;
    for (let index = 0; index < total; index += 1) {
      const text = (await rows.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ');
      if (text.includes(targetTableName)) {
        bound = { row: rows.nth(index), index };
        lastStatus = text;
        break;
      }
    }
    if (!bound && total === 1) {
      // 兜底：实例页自本轮唯一任务行打开且任务此前零实例；单行即本轮实例，仍非“任意首行”。
      const text = (await rows.first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      lastStatus = text;
      bound = { row: rows.first(), index: 0 };
    }
    if (bound) {
      if (finishText.test(lastStatus) && !/执行中/.test(lastStatus)) return bound;
      if (failText.test(lastStatus)) throw new Error(`本轮任务（目标表 ${targetTableName}）执行失败：${lastStatus}`);
    }
    const refresh = await lastVisible([
      instancePage.getByRole('button', { name: /^查\s*询$/ }),
      instancePage.getByRole('button', { name: /^刷\s*新$/ }),
      instancePage.locator('button:visible, [role="button"]:visible').filter({ hasText: /^查\s*询$|^刷\s*新$/ }),
    ]);
    if (refresh) await refresh.click().catch(() => undefined);
    await instancePage.waitForTimeout(1_000);
  }
  throw new Error(`本轮任务（目标表 ${targetTableName}）在等待时间内未出现执行成功终态；最后一次状态：${lastStatus || '未读取到实例状态'}`);
}

/** 执行本轮唯一任务：上线 → 执行 → 查看实例（同轮行号打开）→ 绑定唯一目标表名轮询 → 执行日志出现明确完成内容。 */
async function executeRoundTaskAndVerifyLog(page: Page, targetTableName: string): Promise<void> {
  const index = await findRoundFtpTaskRowIndex(page, targetTableName);
  await ensureRoundTaskOnline(page, index);
  await clickRoundOperation(page, index, /^执行$/);
  // 执行可能无 toast 直接异步创建实例：真实结果以下方实例状态和执行日志为准。
  await page.waitForTimeout(800);
  await clickRoundOperation(page, index, /^查看实例$/);
  await page.waitForTimeout(800);
  const instancePage = page.context().pages().find((candidate) => candidate !== page) ?? page;
  if (instancePage !== page) await instancePage.bringToFront();
  const bound = await pollRoundInstanceRow(instancePage, targetTableName, 90_000);

  // 执行日志（固定列拆分：主表行 + 操作表行按同一行号对齐；页面级按钮兜底）。
  const instanceOperationTable = instancePage.locator('table:visible').filter({ hasText: /操作/ }).first();
  const instanceOperationRow = instanceOperationTable.locator('tbody > tr:visible, .ant-table-tbody > tr:visible').nth(bound.index);
  const logAction = await lastVisible([
    instanceOperationRow.getByText('执行日志', { exact: true }).filter({ visible: true }),
    instanceOperationRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /^执行日志$/ }),
    bound.row.getByText('执行日志', { exact: true }).filter({ visible: true }),
    instancePage.getByRole('button', { name: '执行日志', exact: true }).filter({ visible: true }).first(),
    instancePage.getByText('执行日志', { exact: true }).filter({ visible: true }).last(),
  ]);
  if (!logAction) throw new Error(`本轮任务（目标表 ${targetTableName}）的实例行没有可用“执行日志”入口。`);
  await logAction.click();
  await page.waitForTimeout(800);
  const logPanel = await lastVisible([
    instancePage.locator('.el-dialog:visible, .ant-modal:visible, [role="dialog"]:visible, .drawer:visible').last(),
    instancePage.locator('pre:visible').last(),
    instancePage.locator('body'),
  ]);
  if (!logPanel) throw new Error(`本轮任务（目标表 ${targetTableName}）未找到执行日志内容容器。`);
  const logText = await logPanel.innerText().catch(() => '');
  expect(logText.length, '执行日志内容不应为空').toBeGreaterThan(0);
  expect(
    logText,
    `本轮任务（目标表 ${targetTableName}）的执行日志应包含完成/成功内容，实际：${logText.slice(0, 200)}`,
  ).toMatch(/DATAX|datax|执行状态|执行成功|同步完成|执行完成|成功|完成|回调/);
}


/**
 * 编辑保存（更新原任务）：打开本轮任务行的编辑向导并保存，断言保存接口返回的
 * uploadTaskId 与创建时一致。当前契约（FileUploadController#createFtpInsertDataTaskJob
 * 的 !isAddFtpTask 分支 + updateDataImportByFTPJob）下编辑保存只更新原任务与原调度 Job，
 * 系统不存在复制出第二个任务的接口；若返回了不同 ID，说明契约变化，必须如实失败。
 */
async function editRoundTaskInPlaceAndSave(
  page: Page,
  targetTableName: string,
  taskName: string,
  createdTaskId: string,
): Promise<void> {
  const index = await findRoundFtpTaskRowIndex(page, targetTableName);
  await clickRoundOperation(page, index, /编辑/);
  await expect(page.getByText('来源文件', { exact: true }).filter({ visible: true }).last()).toBeVisible({ timeout: 10_000 });
  // 编辑向导重新校验连通性：原任务保存的连接参数过期会阻断后续步骤，失败要在这里可读地暴露。
  const testConnection = await lastVisible([
    page.getByRole('button', { name: /测试连接/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /测试连接/ }),
  ]);
  if (testConnection) {
    await testConnection.click();
    await expect(
      page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible').filter({ hasText: /成功|连接/ }).last(),
      '编辑向导“测试连接”应成功',
    ).toBeVisible({ timeout: 15_000 });
  }
  const updatedTaskId = await finishWizardAndSave(page, taskName, 'update');
  expect(updatedTaskId, '编辑保存响应未返回 uploadTaskId（object 缺失或类型异常）。').toBeTruthy();
  expect(
    updatedTaskId,
    `编辑保存应更新原任务并返回同一 uploadTaskId=${createdTaskId}，实际返回：${String(updatedTaskId)}`,
  ).toBe(createdTaskId);
}

/** 只回收本轮任务：先下线再删除（无删除入口则告警保留，UUID 隔离）。 */
async function cleanupRoundFtpTask(page: Page, targetTableName: string): Promise<void> {
  try {
    const index = await findRoundFtpTaskRowIndex(page, targetTableName);
    const row = ftpTableRows(page, /操作/).nth(index);
    if (await row.getByRole('button', { name: '下线', exact: true }).isVisible().catch(() => false)) {
      await clickRoundOperation(page, index, /^下线$/);
      const confirmOffline = await lastVisible([
        page.getByRole('button', { name: /确\s*认|确\s*定/ }).last(),
        page.locator('.el-popconfirm__action button:visible, .el-message-box__btns button:visible').last(),
      ]);
      if (confirmOffline) await confirmOffline.click().catch(() => undefined);
      await page.waitForTimeout(800);
    }
    const acceptDialog = (dialog: Dialog): void => {
      void dialog.accept().catch(() => undefined);
    };
    page.once('dialog', acceptDialog);
    try {
      const deleteAction = await lastVisible([
        ftpTableRows(page, /操作/).nth(index).getByRole('button', { name: '删除', exact: true }),
        ftpTableRows(page, /操作/).nth(index).getByText('删除', { exact: true }),
      ]);
      if (deleteAction) {
        await deleteAction.click();
        const confirmDelete = await lastVisible([
          page.getByRole('button', { name: /确\s*认|确\s*定/ }).last(),
          page.locator('.el-popconfirm__action button:visible, .el-message-box__btns button:visible').last(),
        ]);
        if (confirmDelete) await confirmDelete.click().catch(() => undefined);
        await page.waitForTimeout(800);
        console.warn(`[cleanup] 已请求删除本轮接入任务：${targetTableName}`);
      } else {
        console.warn(`[cleanup] 接入列表未提供“删除”操作，本轮任务保留（UUID 隔离）：${targetTableName}`);
      }
    } finally {
      page.off('dialog', acceptDialog);
    }
  } catch (error) {
    console.warn(`[cleanup] 本轮接入任务回收未完成（目标表 ${targetTableName}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

test('DI-04-02｜FTP文件接入：本轮任务编辑保存并执行后实例与日志可见', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(900_000);
  const page = loginPage;
  const suffix = uuid();
  // 向导“任务名称”仅随请求发送、后端不持久化（列表不可见/不可过滤）；本轮唯一绑定依据
  // 是目标表名（列表“导入数据表”列）与保存响应返回的 uploadTaskId。
  const roundTaskName = `E2E_DI0402_${suffix}`;
  const targetTableName = `e2e_ftp_a_${suffix}`;
  // 凭据前置前移：FTP_USER/FTP_PASS 缺失时立即给出只含变量名的可读错误，不进入页面操作。
  requireFtpProfile();
  try {
    // 步骤 1：同名日期文件已存在时先经页面删除，再经配置中心自建本轮唯一 FTP 接入任务。
    await removeExistingDateRuleFtpTasks(page);
    const createdTaskId = await createRoundFtpAccessTask(page, roundTaskName, targetTableName);
    if (!createdTaskId) throw new Error('创建保存响应未返回本轮任务 uploadTaskId（object 缺失）。');
    // 步骤 2：打开该任务行的编辑向导保存更新；断言返回同一 uploadTaskId——
    // 当前契约下编辑保存=更新原任务（不产生第二个任务），契约变化必须如实失败。
    await editRoundTaskInPlaceAndSave(page, targetTableName, roundTaskName, createdTaskId);
    // 步骤 3：上线并执行本轮唯一任务；实例状态轮询只绑定本轮目标表名，执行日志出现明确完成内容。
    await executeRoundTaskAndVerifyLog(page, targetTableName);

    await assertNoConsoleErrors(consoleErrors);
    await report(
      'FTP接入-本轮任务编辑保存并执行',
      true,
      `本轮任务 uploadTaskId=${createdTaskId}；目标表=${targetTableName}；编辑保存返回同一 uploadTaskId（更新原任务契约），实例状态与执行日志均已校验。`,
    );
  } finally {
    await cleanupRoundFtpTask(page, targetTableName);
    await dropTableIfExists(testEnvironment.dataSourceNames.fileAccess.database, targetTableName);
  }
});

