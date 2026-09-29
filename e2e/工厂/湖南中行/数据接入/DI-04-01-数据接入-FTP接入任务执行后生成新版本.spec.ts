/**
 * DI-04-01｜数据接入｜FTP 接入任务执行后查看目标表版本
 *
 * DS-PERM-68 清洁环境迁移（静态开发，未启动浏览器/FTP/DB/调度/业务回归）：
 *   - 不再复用任何历史 gs_test_ 任务或固定文件接入记录：本轮先经配置中心自建唯一
 *     FTP/SFTP 接入任务再执行。协议、地址、端口、目录、基础文件名一律来自
 *     e2e/test-environment.ts 的 FTP profile（FTP_HOST/FTP_PORT/FTP_FILE_PATH/
 *     FTP_BASE_FILE/FTP_USER/FTP_PASS 可单项覆盖，凭据只来自进程环境变量，
 *     与当前 FTP 环境基线同源；ftp文件接入列表同时承载 ftp/sftp 两类任务）；
 *   - 任务名 E2E_DI0401_<uuid>、目标表 e2e_di0401_<uuid> 均为本轮唯一 ASCII 命名；
 *   - 状态轮询只绑定本轮唯一任务：实例行优先按任务名文本命中；实例页不渲染任务名时，
 *     仅允许“自本轮任务行打开 + 恰好 1 行”的兜底，绝不取任意首行；
 *   - 版本断言保持：执行成功后进入数据地图，按本轮唯一目标表名精确查询 →
 *     表详情 → 版本 Tab → 版本列表可见；
 *   - finally 只回收本轮资产：接入任务（先下线再删除，列表无删除入口则告警保留，
 *     UUID 隔离）、本轮目标表（DROP IF EXISTS；DB 未配置时记录原因跳过，
 *     不影响用例结果）。
 */
import type { Dialog, Locator, Page } from '@playwright/test';
import {
  assertNoConsoleErrors,
  clickMenu,
  expect,
  fillByLabel,
  query,
  selectByLabel,
  tableRows,
  test,
  uuid,
} from '../utils.js';
import { openFtpAccessList } from './FTP接入执行工具.js';
import { requireFtpProfile, testEnvironment } from '../../../test-environment.js';

// ==================== 通用小工具 ====================

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
async function fillAutomaticTableName(page: Page, value: string): Promise<void> {
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
  throw new Error('FTP 新建向导未找到自动建表“表”输入框，无法填写本轮唯一目标表名。');
}

/** 目标列统一改成本轮唯一 ASCII 命名，规避中文列名在后端链路的历史失败模式（DI-04-02 实证）。 */
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

/** 走完向导剩余步骤：途中回填任务名称/重试次数，最后点确定；保存成功的持久证据 = 成功文案或已离开创建路由。 */
async function finishWizardAndSave(page: Page, taskName: string): Promise<void> {
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
  const saveResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && /createFtpInsertDataTaskJob/i.test(response.url()),
    { timeout: 30_000 },
  );
  await confirm.click();
  const saved = await (await saveResponse).json().catch(() => undefined) as { code?: string; message?: string } | undefined;
  if (saved?.code !== '000000') {
    const reason = saved?.message?.replace(/(password|pwd|密码)\s*[:=]\s*[^,\s;]+/gi, '[redacted]').slice(0, 500) ?? '无响应详情';
    throw new Error(`FTP 建表任务保存失败（code=${saved?.code ?? '未知'}）：${reason}`);
  }
  await expect.poll(async () => {
    const text = await page.locator('body').innerText().catch(() => '');
    return /创建成功|保存成功|同步任务已创建|接入任务已创建/.test(text) || !/ftpAccessCreate/i.test(page.url()) ? 'saved' : 'waiting';
  }, { timeout: 30_000 }).toBe('saved');
}


// ============ 本轮唯一 FTP 接入任务：创建 → 找行 → 执行 → 版本 → 回收 ============
// 接入列表是固定列拆分表：左侧“文件名称”table、右侧“导入状态/操作”table；
// 主表/操作表行号一一对应，绑定本轮任务时用同一行号对齐，不依赖首行/末行/固定页码。

function tableWithHeader(page: Page, header: RegExp): Locator {
  return page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: header }) }).first();
}

function dataTableRows(page: Page): Locator {
  return tableWithHeader(page, /导入状态/).locator('tbody > tr:visible, .ant-table-tbody > tr:visible');
}

function fileNameTableRows(page: Page): Locator {
  return tableWithHeader(page, /文件名称/).locator('tbody > tr:visible, .ant-table-tbody > tr:visible');
}

function operationTableRows(page: Page): Locator {
  return tableWithHeader(page, /操作/).locator('tbody > tr:visible, .ant-table-tbody > tr:visible');
}

/** 后端保存的日期占位符与页面展示存在大小写差异；文本空白也不参与精确匹配。 */
function normalizeFileName(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

/** 同一个日期文件名受后端唯一键约束。重建前只删除当前 FTP profile 对应的同名测试记录。 */
async function removeExistingFileTasks(page: Page): Promise<number> {
  const baseFile = requireFtpProfile().baseFile;
  const dot = baseFile.lastIndexOf('.');
  const stem = dot >= 0 ? baseFile.slice(0, dot) : baseFile;
  const extension = dot >= 0 ? baseFile.slice(dot) : '';
  const expectedFileName = `${stem}_\${CURRENT_DATE}${extension}`;
  const normalizedExpectedName = normalizeFileName(expectedFileName);
  let removed = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await openFtpAccessList(page);
    const rows = dataTableRows(page);
    const names = fileNameTableRows(page);
    const count = Math.min(await rows.count(), await names.count());
    let match = -1;
    for (let index = 0; index < count; index += 1) {
      const name = (await names.nth(index).innerText()).trim();
      if (normalizeFileName(name) === normalizedExpectedName) {
        match = index;
        break;
      }
    }
    if (match < 0) return removed;
    const targetTable = (await rows.nth(match).locator('td').nth(4).innerText().catch(() => '')).trim();
    const operation = operationTableRows(page).nth(match);
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
      const current = dataTableRows(page);
      const currentNames = fileNameTableRows(page);
      const currentCount = Math.min(await current.count(), await currentNames.count());
      for (let index = 0; index < currentCount; index += 1) {
        const name = (await currentNames.nth(index).innerText().catch(() => '')).trim();
        if (normalizeFileName(name) === normalizedExpectedName) return 'present';
      }
      return 'absent';
    }, { timeout: 20_000 }).toBe('absent');
    removed += 1;
    console.warn(`[preflight] 已删除同名 FTP 测试任务：${expectedFileName}；目标表=${targetTable || '未生成'}`);
  }
  throw new Error(`同名 FTP 测试任务达到 10 条清理上限，已删除 ${removed} 条；停止建表以免继续产生重复数据。`);
}

/** 在接入列表绑定本轮唯一任务行：按行内任务名文本命中，查询框/翻页兜底；返回主表/操作表共享行号。 */
async function findRoundFtpTaskRowIndex(page: Page, taskName: string, tableName: string): Promise<number> {
  await openFtpAccessList(page);
  const locate = async (): Promise<number> => {
    const rows = dataTableRows(page);
    const fileRows = fileNameTableRows(page);
    const count = Math.min(await rows.count(), await fileRows.count());
    for (let index = 0; index < count; index += 1) {
      const text = `${await rows.nth(index).innerText().catch(() => '')} ${await fileRows.nth(index).innerText().catch(() => '')}`;
      if (text.includes(tableName) || text.includes(taskName)) return index;
    }
    return -1;
  };
  let index = await locate();
  const searchInput = page.locator('input:visible:not([type="radio"]):not([type="checkbox"])').first();
  const searchButton = await lastVisible([
    page.getByRole('button', { name: /^查\s*询$/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /^查\s*询$/ }),
  ]);
  if (index < 0 && (await searchInput.isVisible().catch(() => false))) {
    // 查询框若支持任务名过滤则按唯一名过滤一次；未命中则清空恢复全量列表继续扫描。
    await searchInput.fill(taskName);
    if (searchButton) await searchButton.click();
    await page.waitForTimeout(800);
    index = await locate();
    if (index < 0) {
      await searchInput.fill('');
      if (searchButton) await searchButton.click();
      await page.waitForTimeout(800);
    }
  }
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
  if (index < 0) throw new Error(`接入列表未找到本轮唯一任务“${taskName}”（目标表 ${tableName}；已尝试行内文本、查询过滤与翻页扫描）。`);
  return index;
}

async function clickRoundOperation(page: Page, index: number, name: RegExp): Promise<void> {
  const row = operationTableRows(page).nth(index);
  const action = await lastVisible([
    row.getByText(name).filter({ visible: true }),
    row.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }),
    page.getByText(name).filter({ visible: true }).nth(index),
  ]);
  if (!action) throw new Error(`本轮任务行第 ${index + 1} 行没有可见操作“${String(name)}”。`);
  await action.click();
  await page.waitForTimeout(500);
}

/** 新建任务默认离线：上线态则跳过；离线态点“上线”并等待“下线”出现（DI-04-02 同款轮询）。 */
async function ensureRoundTaskOnline(page: Page, index: number): Promise<void> {
  if (await operationTableRows(page).nth(index).getByRole('button', { name: '下线', exact: true }).isVisible().catch(() => false)) return;
  if (await operationTableRows(page).nth(index).getByRole('button', { name: '上线', exact: true }).isVisible().catch(() => false)) {
    await clickRoundOperation(page, index, /^上线$/);
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (await operationTableRows(page).nth(index).getByRole('button', { name: '下线', exact: true }).isVisible().catch(() => false)) return;
      await page.waitForTimeout(500);
    }
    throw new Error(`本轮任务上线后 12 秒内未出现“下线”操作（第 ${index + 1} 行）。`);
  }
}


/** 经配置中心自建本轮唯一 FTP 接入任务（自动建表目标 = 唯一表名）。 */
async function createRoundFtpAccessTask(page: Page, taskName: string, tableName: string): Promise<void> {
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
  await fillAutomaticTableName(page, tableName);

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
  await finishWizardAndSave(page, taskName);
}


/**
 * 实例状态轮询：只绑定本轮唯一任务。
 *   1) 优先命中“行文本包含任务名”的实例行（唯一任务名是绑定依据）；
 *   2) 实例页不渲染任务名时，仅当“该页自本轮任务行打开 + 全部实例恰好 1 行”才允许兜底读取；
 *      本轮任务此前没有任何实例，单行不可能属于其他任务。
 *   3) 当前实例页渲染 dumpStartTime/dumpEndTime 和 dumpStatus；以两个完整时间戳且非执行中作为终态，
 *      不假定状态标签必然出现。
 */
async function pollRoundInstanceRow(instancePage: Page, taskName: string, timeoutMs: number): Promise<{ row: Locator; index: number }> {
  const rows = instancePage.locator('tbody tr:visible, .el-table__body-wrapper tr:visible, [role="row"]:visible');
  const timestampText = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g;
  const failText = /执行失败|同步失败|接入失败|异常/;
  const evaluate = (statusText: string, row: Locator, index: number): { row: Locator; index: number } | undefined => {
    const timestamps = statusText.match(timestampText) ?? [];
    if (timestamps.length >= 2 && !/执行中/.test(statusText)) return { row, index };
    if (failText.test(statusText)) throw new Error(`本轮任务 ${taskName} 执行失败：${statusText}`);
    return undefined;
  };
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const total = await rows.count();
    let bound: { row: Locator; index: number } | undefined;
    for (let index = 0; index < total; index += 1) {
      const text = (await rows.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ');
      if (text.includes(taskName)) {
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
      const done = evaluate(lastStatus, bound.row, bound.index);
      if (done) return done;
    }
    const refresh = await lastVisible([
      instancePage.getByRole('button', { name: /^查\s*询$/ }),
      instancePage.getByRole('button', { name: /^刷\s*新$/ }),
      instancePage.locator('button:visible, [role="button"]:visible').filter({ hasText: /^查\s*询$|^刷\s*新$/ }),
    ]);
    if (refresh) await refresh.click().catch(() => undefined);
    await instancePage.waitForTimeout(1_000);
  }
  throw new Error(`本轮任务 ${taskName} 在等待时间内未出现执行成功终态；最后一次状态：${lastStatus || '未读取到实例状态'}`);
}

/** 执行本轮唯一任务：上线 → 执行 → 查看实例（同轮行号打开）→ 绑定唯一任务轮询 → 执行日志出现明确完成内容。 */
async function executeRoundTaskAndVerifyLog(page: Page, taskName: string, tableName: string): Promise<void> {
  const index = await findRoundFtpTaskRowIndex(page, taskName, tableName);
  await ensureRoundTaskOnline(page, index);
  await clickRoundOperation(page, index, /^执行$/);
  // 执行可能无 toast 直接异步创建实例：真实结果以下方实例状态和执行日志为准。
  await page.waitForTimeout(800);
  await clickRoundOperation(page, index, /^查看实例$/);
  await page.waitForTimeout(800);
  const instancePage = page.context().pages().find((candidate) => candidate !== page) ?? page;
  if (instancePage !== page) await instancePage.bringToFront();
  const bound = await pollRoundInstanceRow(instancePage, taskName, 90_000);

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
  if (!logAction) throw new Error(`本轮任务 ${taskName} 的实例行没有可用“执行日志”入口。`);
  await logAction.click();
  await page.waitForTimeout(800);
  const logPanel = await lastVisible([
    instancePage.locator('.el-dialog:visible, .ant-modal:visible, [role="dialog"]:visible, .drawer:visible').last(),
    instancePage.locator('pre:visible').last(),
    instancePage.locator('body'),
  ]);
  if (!logPanel) throw new Error(`本轮任务 ${taskName} 未找到执行日志内容容器。`);
  const logText = await logPanel.innerText().catch(() => '');
  expect(logText.length, '执行日志内容不应为空').toBeGreaterThan(0);
  expect(
    logText,
    `本轮任务 ${taskName} 的执行日志应包含完成/成功内容，实际：${logText.slice(0, 200)}`,
  ).toMatch(/DATAX|datax|执行状态|执行成功|同步完成|执行完成|成功|完成|回调/);
}


async function clickVisibleTab(page: Page, name: RegExp): Promise<void> {
  const tab = await lastVisible([
    page.getByRole('tab', { name }),
    page.locator('[role="tab"]:visible, .el-tabs__item:visible, .ant-tabs-tab:visible').filter({ hasText: name }),
    page.getByText(name, { exact: true }).filter({ visible: true }),
  ]);
  if (!tab) throw new Error(`表详情页没有可见 Tab“${String(name)}”。`);
  await tab.click();
  await page.waitForTimeout(500);
}

/** 版本断言：数据地图按本轮唯一目标表名精确查询 → 表详情 → 版本 Tab → 版本列表可见。 */
async function verifyRoundTargetTableVersion(page: Page, tableName: string): Promise<void> {
  await clickMenu(page, '数据地图', '表查询', '表查询');
  const search = page.getByPlaceholder(/请输入表名称|请输入表名|表名称/).filter({ visible: true }).first();
  await expect(search, '表查询页应有表名查询框').toBeVisible({ timeout: 15_000 });
  await search.fill(tableName);
  await clickButton(page, /查\s*询|搜\s*索/);
  await page.waitForTimeout(500);
  const card = page.locator('text=' + tableName).filter({ visible: true }).first();
  await expect(card, `表查询应命中本轮唯一表 ${tableName}`).toBeVisible({ timeout: 20_000 });
  await card.click();
  await expect(page.getByText(/表详情|基本信息|字段信息|版本/).filter({ visible: true }).last()).toBeVisible({ timeout: 15_000 });
  await clickVisibleTab(page, /^版本$/);
  await expect(tableRows(page).first(), `表 ${tableName} 的版本列表应至少有一条版本记录`).toBeVisible({ timeout: 15_000 });
}

/** 只回收本轮资产：任务先下线再删除（无删除入口则告警保留，UUID 隔离）；目标表 DROP IF EXISTS。 */
async function cleanupRoundAssets(page: Page, taskName: string, tableName: string): Promise<void> {
  try {
    const index = await findRoundFtpTaskRowIndex(page, taskName, tableName);
    const row = operationTableRows(page).nth(index);
    if (await row.getByRole('button', { name: '下线', exact: true }).isVisible().catch(() => false)) {
      await clickRoundOperation(page, index, /^下线$/);
      const confirm = await lastVisible([
        page.getByRole('button', { name: /确\s*认|确\s*定/ }).last(),
        page.locator('.el-popconfirm__action button:visible, .el-message-box__btns button:visible').last(),
      ]);
      if (confirm) await confirm.click().catch(() => undefined);
      await page.waitForTimeout(800);
    }
    const acceptDialog = (dialog: Dialog): void => {
      void dialog.accept().catch(() => undefined);
    };
    page.once('dialog', acceptDialog);
    try {
      const deleteAction = await lastVisible([
        operationTableRows(page).nth(index).getByRole('button', { name: '删除', exact: true }),
        operationTableRows(page).nth(index).getByText('删除', { exact: true }),
      ]);
      if (deleteAction) {
        await deleteAction.click();
        const confirmDelete = page.getByRole('tooltip').getByRole('button', { name: /确\s*定/ }).last();
        await expect(confirmDelete, '回收本轮接入任务需要确认删除').toBeVisible({ timeout: 5_000 });
        await confirmDelete.click();
        await expect.poll(async () => {
          await openFtpAccessList(page);
          return (await dataTableRows(page).allInnerTexts()).some((text) => text.includes(tableName));
        }, { timeout: 15_000 }).toBe(false);
        console.warn(`[cleanup] 已删除本轮接入任务：${taskName}`);
      } else {
        console.warn(`[cleanup] 接入列表未提供“删除”操作，本轮任务保留（UUID 隔离）：${taskName}`);
      }
    } finally {
      page.off('dialog', acceptDialog);
    }
  } catch (error) {
    console.warn(`[cleanup] 本轮接入任务回收未完成（${taskName}）：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await query(`DROP TABLE IF EXISTS \`${testEnvironment.dataSourceNames.fileAccess.database}\`.\`${tableName}\``);
    console.warn(`[cleanup] 已回收本轮目标表：${testEnvironment.dataSourceNames.fileAccess.database}.${tableName}`);
  } catch (error) {
    console.warn(`[cleanup] 本轮目标表未回收（DB 未配置或直连失败）：${tableName}；原因：${error instanceof Error ? error.message : String(error)}`);
  }
}

test('DI-04-01｜数据接入｜本轮自建FTP任务执行后目标表版本可查看', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(600_000);
  const page = loginPage;
  const suffix = uuid();
  const taskName = `E2E_DI0401_${suffix}`;
  const tableName = `e2e_di0401_${suffix}`;
  // 凭据前置前移：FTP_USER/FTP_PASS 缺失时立即给出只含变量名的可读错误，不进入页面操作。
  requireFtpProfile();
  let preflightRemoved = 0;
  try {
    preflightRemoved = await removeExistingFileTasks(page);
    // 步骤 1：经配置中心自建本轮唯一 FTP/SFTP 接入任务（连接→文件名→目标→映射→任务名→保存）。
    await createRoundFtpAccessTask(page, taskName, tableName);
    // 步骤 2：上线并执行，绑定本轮唯一任务轮询实例终态，执行日志出现明确完成内容。
    await executeRoundTaskAndVerifyLog(page, taskName, tableName);
    // 步骤 3：数据地图按本轮唯一目标表精确查询，版本 Tab 下版本列表可见。
    await verifyRoundTargetTableVersion(page, tableName);
    await assertNoConsoleErrors(consoleErrors);
    await report(
      'FTP接入-本轮自建任务执行-目标表版本',
      true,
      `任务=${taskName}；目标表=${tableName}；重建前已删除同名测试任务 ${preflightRemoved} 条；连接/文件参数均来自配置中心 FTP profile；执行日志与版本列表均已校验。`,
    );
  } finally {
    await cleanupRoundAssets(page, taskName, tableName);
  }
});

