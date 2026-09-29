import type { Locator, Page } from '@playwright/test';
import { expect, clickMenu, fillByLabel, selectByLabel, uuid } from '../utils.js';
import { type FileTransferProfileConfig, requireSftpProfile, testEnvironment } from '../../../test-environment.js';

/** 进入 FTP 文件接入的真实“接入列表”叶子路由；父路由只渲染空容器。 */
export async function openFtpAccessList(page: Page): Promise<void> {
  const baseUrl = page.url().split('#')[0];
  const route = `${baseUrl}#/dataAccess/ftpAccess/accessList`;
  const ready = page.locator('input:visible, table:visible, [role="grid"]:visible').first();
  // 该 SPA 偶尔仅更新 URL 而保留上一个空壳组件；重新加载叶子路由可恢复。
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    // 首次进入时应用可能把 hash 恢复到默认“数据源管理”页。此时必须让循环
    // 继续尝试，不能用会立即抛出的 URL 断言让重试形同虚设。
    await page.waitForTimeout(800);
    if (!/#\/dataAccess\/ftpAccess\/accessList(?:\?|$)/.test(page.url())) {
      continue;
    }
    if (await ready.isVisible({ timeout: 5_000 }).catch(() => false)) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`FTP 接入列表重试 3 次后仍未打开或未渲染，当前页面：${page.url()}`);
}

async function lastVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    for (let index = await candidate.count() - 1; index >= 0; index -= 1) {
      const item = candidate.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return undefined;
}

function tableWithHeader(page: Page, header: RegExp): Locator {
  return page.locator('table:visible').filter({ hasText: header }).first();
}

function dataTableRows(page: Page): Locator {
  return tableWithHeader(page, /导入状态/)
    .locator('tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not(:has([role="columnheader"]))');
}

function fileNameTableRows(page: Page): Locator {
  return tableWithHeader(page, /文件名称/)
    .locator('tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not(:has([role="columnheader"]))');
}

function operationTableRows(page: Page): Locator {
  return tableWithHeader(page, /操作/)
    .locator('tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not(:has([role="columnheader"]))');
}

/**
 * 在固定列拆分的接入列表中查找可复用的 gs_test_ 完整配置任务。
 *
 * “文件解析完成”表示远端文件和解析规则已可被编辑页读取、预览、测试连接；
 * 它不等于一次同步实例已经成功。因此允许它支撑连接/预览/日期规则用例，
 * 但执行后结果仍必须由 executeExistingFtpTaskAndVerifyLog 严格验证。
 * 返回的是主表/操作表共同使用的行号，不依赖首行、末行或固定页码。
 */
export async function findExistingGsSyncTask(page: Page, taskName = 'gs_test_'): Promise<{ index: number }> {
  const searchInput = page.locator('input:visible:not([type="radio"]):not([type="checkbox"])').first();
  await searchInput.fill(taskName);
  const searchButton = await lastVisible([
    page.getByRole('button', { name: /查\s*询/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /查\s*询/ }),
  ]);
  if (searchButton) await searchButton.click();
  await page.waitForTimeout(800);

  for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
    const dataRows = dataTableRows(page);
    const fileRows = fileNameTableRows(page);
    const rowCount = Math.min(await dataRows.count(), await fileRows.count());
    for (let index = 0; index < rowCount; index += 1) {
      const fileText = await fileRows.nth(index).innerText().catch(() => '');
      const statusText = await dataRows.nth(index).innerText().catch(() => '');
      if (
        fileText.includes(taskName)
        && /文件数据同步任务已创建|文件数据同步完成|文件解析完成/.test(statusText)
      ) {
        return { index };
      }
    }

    const next = await lastVisible([
      page.getByRole('button', { name: /下一页/ }),
      page.locator('.ant-pagination-next:visible, .el-pagination .btn-next:visible'),
    ]);
    if (!next || await next.isDisabled().catch(() => true)) break;
    await next.click();
    await page.waitForTimeout(800);
  }
  throw new Error(`未找到已完整配置的任务 ${taskName}；请先由新建流程保存一次文件解析配置。`);
}

/**
 * 打开当前 110 环境的 gs_test_ SFTP 夹具。
 *
 * 接入列表会保留历史环境的任务；只按文件名前缀选择会把 113 的旧任务当成
 * 当前任务，随后把“连接失败”错误归因给页面。这里逐项进入编辑页核对实际
 * 回显地址和目录，只有 110 /source 的任务才可作为可复用测试夹具。
 */
export async function openExistingCurrentEnvironmentFtpTaskEditor(page: Page): Promise<void> {
  // SFTP 夹具地址/目录统一来自 e2e/test-environment.ts 的 SFTP profile
  // （SFTP_HOST/SFTP_PATH 可覆盖；FTP 与 SFTP 已分离，不再回退 FTP_HOST）。
  const host = testEnvironment.fileTransfer.sftp.host;
  const expectedPath = testEnvironment.fileTransfer.sftp.baseDir.replace(/\/$/, '');
  const inspected: string[] = [];
  const searchInput = page.locator('input:visible:not([type="radio"]):not([type="checkbox"])').first();
  await searchInput.fill('gs_test_');
  const searchButton = await lastVisible([
    page.getByRole('button', { name: /查\s*询/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /查\s*询/ }),
  ]);
  if (searchButton) await searchButton.click();
  await page.waitForTimeout(800);

  for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
    const dataRows = dataTableRows(page);
    const fileRows = fileNameTableRows(page);
    const rowCount = Math.min(await dataRows.count(), await fileRows.count());
    for (let index = 0; index < rowCount; index += 1) {
      const fileText = await fileRows.nth(index).innerText().catch(() => '');
      const statusText = await dataRows.nth(index).innerText().catch(() => '');
      if (!/gs_test_/.test(fileText) || !/文件数据同步任务已创建|文件数据同步完成|文件解析完成/.test(statusText)) continue;

      await clickIndexedOperation(page, /编辑/, index);
      await expect(page.getByText('来源文件', { exact: true }).filter({ visible: true }).last())
        .toBeVisible({ timeout: 15_000 });
      const values = await page.locator('input:visible:not([type="radio"]):not([type="checkbox"]):not([type="password"])')
        .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
      const matchedHost = values.some((value) => value.trim() === host);
      const matchedPath = values.some((value) => value.trim().replace(/\/$/, '') === expectedPath);
      inspected.push(`第${index + 1}行:${values.slice(0, 6).join('|')}`);
      if (matchedHost && matchedPath) return;

      await closeExistingFtpTaskEditor(page);
      await expect(page.locator('table:visible, [role="grid"]:visible, .el-table:visible').first())
        .toBeVisible({ timeout: 10_000 });
    }
    const next = await lastVisible([
      page.getByRole('button', { name: /下一页/ }),
      page.locator('.ant-pagination-next:visible, .el-pagination .btn-next:visible'),
    ]);
    if (!next || await next.isDisabled().catch(() => true)) break;
    await next.click();
    await page.waitForTimeout(800);
  }
  throw new Error(
    `未找到当前环境 SFTP 测试夹具（地址=${host}，目录=${expectedPath}）。` +
    `请先执行 DI-00-02 创建基线；已检查：${inspected.join('；') || '无 gs_test_ 候选任务'}`,
  );
}

async function clickIndexedOperation(page: Page, name: RegExp, index: number): Promise<void> {
  const operationRow = operationTableRows(page).nth(index);
  const action = await lastVisible([
    operationRow.getByText(name).filter({ visible: true }),
    operationRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }),
    page.getByText(name).filter({ visible: true }).nth(index),
    page.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }).nth(index),
  ]);
  if (!action) throw new Error(`接入列表第 ${index + 1} 行没有可见操作“${name}”。`);
  await action.click();
}

/** 打开已有 gs_test_ 任务编辑页，仅用于读取回显；调用方应随后点击取消。 */
export async function openExistingFtpTaskEditor(page: Page): Promise<void> {
  await openExistingCurrentEnvironmentFtpTaskEditor(page);
}

/**
 * 打开实际按“_ + 日 + 0”配置、且预览为当天文件名的 gs_test_ 任务。
 *
 * 接入列表里允许残留历史任务；仅凭 gs_test_ 前缀会误选到例如“日 -2”
 * 的旧配置。日期规则用例必须以预览结果选夹具，不能把旧任务的 -2
 * 偏移误判成页面问题，也不能为了通过测试而放宽当天文件名断言。
 */
export async function openExistingCurrentDayFtpTaskEditor(page: Page): Promise<void> {
  const today = new Date();
  const date = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const expectedFileName = `gs_test_${date}`;
  const inspectedPreviews: string[] = [];
  const searchInput = page.locator('input:visible:not([type="radio"]):not([type="checkbox"])').first();
  await searchInput.fill('gs_test_');
  const searchButton = await lastVisible([
    page.getByRole('button', { name: /查\s*询/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /查\s*询/ }),
  ]);
  if (searchButton) await searchButton.click();
  await page.waitForTimeout(800);

  for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
    const dataRows = dataTableRows(page);
    const fileRows = fileNameTableRows(page);
    const rowCount = Math.min(await dataRows.count(), await fileRows.count());
    for (let index = 0; index < rowCount; index += 1) {
      const fileText = await fileRows.nth(index).innerText().catch(() => '');
      const statusText = await dataRows.nth(index).innerText().catch(() => '');
      // 接入列表显示的是文件名模板。仅 `${CURRENT_DATE}`（或等价中文文案）
      // 才可能满足“日 + 0 偏移”的当前日期规则；跳过 LAST_2_DAYS 等历史
      // 规则，既避免误判，也避免逐条等待预览而耗尽整个用例的时间。
      if (
        !/gs_test_/.test(fileText)
        || !/(?:CURRENT_DATE|当前日期|当日|今日)/i.test(fileText)
        || !/文件数据同步任务已创建|文件数据同步完成|文件解析完成/.test(statusText)
      ) continue;

      await clickIndexedOperation(page, /编辑/, index);
      await expect(page.getByText('来源文件', { exact: true }).filter({ visible: true }).last())
        .toBeVisible({ timeout: 15_000 });
      const preview = await lastVisible([
        page.getByRole('button', { name: /预览文件名/ }).filter({ visible: true }),
        page.locator('button:visible, [role="button"]:visible').filter({ hasText: /预览文件名/ }),
      ]);
      if (!preview) throw new Error('已有 gs_test_ 任务编辑页没有“预览文件名”按钮。');
      await preview.click();
      // 页面预览在不同版本会显示主文件名、完整文件名（含 .csv）或带说明的
      // 文本。业务断言是“日期规则实际生成当天主文件名”，不应把展示扩展名
      // 当成日期规则失败；因此检查可见预览文本包含完整的当天主文件名。
      const expectedPreview = new RegExp(`${expectedFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.csv)?`);
      const matchesToday = await page.getByText(expectedPreview).filter({ visible: true }).last()
        .isVisible({ timeout: 3_000 }).catch(() => false);
      const previewDialog = page.locator('.el-dialog:visible, .ant-modal:visible, [role="dialog"]:visible').last();
      const previewText = (await previewDialog.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (previewText) inspectedPreviews.push(previewText.slice(0, 200));
      await page.keyboard.press('Escape').catch(() => undefined);
      if (matchesToday) return;

      await closeExistingFtpTaskEditor(page);
      await expect(page.locator('table:visible, [role="grid"]:visible, .el-table:visible').first())
        .toBeVisible({ timeout: 10_000 });
    }

    const next = await lastVisible([
      page.getByRole('button', { name: /下一页/ }),
      page.locator('.ant-pagination-next:visible, .el-pagination .btn-next:visible'),
    ]);
    if (!next || await next.isDisabled().catch(() => true)) break;
    await next.click();
    await page.waitForTimeout(800);
  }

  throw new Error(
    `未找到预览为“${expectedFileName}”的 gs_test_ 日期规则任务；` +
    `已检查的预览：${inspectedPreviews.join('；') || '未读取到预览文本'}。`,
  );
}

/**
 * 用已验证的 gs_test_ 任务校验服务端连接。
 *
 * 新建页在点击“测试连接”前会校验基础文件名、目标数据源、数据库、Schema、建表方式等
 * 全部必填项；只填写地址/端口/账号/密码会被前端拦截，既没有请求也不会出现连接结果。
 * 因而连通性用例统一从已完整配置的任务编辑页发起测试连接。
 */
export async function verifyExistingFtpTaskConnection(page: Page): Promise<void> {
  await openExistingFtpTaskEditor(page);
  const testConnection = await lastVisible([
    page.getByRole('button', { name: /测试连接/ }).filter({ visible: true }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /测试连接/ }),
  ]);
  if (!testConnection) throw new Error('已有 gs_test_ 任务编辑页没有“测试连接”按钮。');
  await testConnection.click();
  await expect(
    page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
      .filter({ hasText: /连接成功|测试成功|成功/ }).last(),
  ).toBeVisible({ timeout: 15_000 });
}

async function connectionInputs(page: Page): Promise<Locator> {
  const inputs = page.locator('input:visible:not([type="radio"]):not([type="checkbox"])');
  await expect(inputs.first(), '已有 FTP 任务编辑页未渲染连接配置输入框').toBeVisible({ timeout: 10_000 });
  return inputs;
}

async function inputWithCurrentValue(page: Page, value: string): Promise<Locator | undefined> {
  const inputs = await connectionInputs(page);
  for (let index = 0; index < await inputs.count(); index += 1) {
    const input = inputs.nth(index);
    if ((await input.inputValue().catch(() => '')) === value) return input;
  }
  return undefined;
}

async function assertConnectionRejected(page: Page): Promise<void> {
  const connectionResponse = page.waitForResponse(
    async (response) => {
      if (response.request().method() !== 'POST') return false;
      if (!/\/file-datasource\/saveFtpServerConfig(?:\?|$)/i.test(response.url())) return false;
      const body = await response.text().catch(() => '');
      return response.status() >= 400 || /失败|错误|认证|拒绝|invalid|fail/i.test(body);
    },
    { timeout: 15_000 },
  ).catch(() => undefined);
  const testConnection = await lastVisible([
    page.getByRole('button', { name: /测试连接/ }).filter({ visible: true }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /测试连接/ }),
  ]);
  if (!testConnection) throw new Error('已有 gs_test_ 任务编辑页没有“测试连接”按钮。');
  await testConnection.click();

  const errorMessage = page.locator(
    '.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible, .el-form-item__error:visible, .ant-form-item-explain-error:visible',
  ).filter({ hasText: /连接失败|失败|认证|拒绝|错误|无效|异常|必填|不能为空|端口|目录|路径/ }).last();
  const outcome = await Promise.race([
    errorMessage.waitFor({ state: 'visible', timeout: 15_000 }).then(() => 'message' as const).catch(() => undefined),
    connectionResponse.then((response) => response ? 'response' as const : undefined),
  ]);
  if (!outcome) {
    throw new Error('异常配置点击“测试连接”后未收到失败接口响应，也未显示校验或失败提示。');
  }
}

async function assertEmptyAddressBlockedOnNextStep(page: Page): Promise<void> {
  const next = await lastVisible([
    page.getByRole('button', { name: /下\s*一\s*步/ }).filter({ visible: true }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /下\s*一\s*步/ }),
  ]);
  if (!next) throw new Error('已有 gs_test_ 任务编辑页没有“下一步”按钮。');
  await next.click();
  const validation = page.locator(
    '.el-form-item__error:visible, .ant-form-item-explain-error:visible, .el-message:visible, [role="alert"]:visible',
  ).filter({ hasText: /地址|服务器|必填|不能为空|请输入/ }).last();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (/来源字段搜索|目标字段搜索/.test(bodyText)) {
      throw new Error('真实业务BUG：sftp服务器地址为空时仍可进入“字段映射”第 2 步，未阻止提交。');
    }
    if (await validation.isVisible().catch(() => false)) return;
    await page.waitForTimeout(250);
  }
  throw new Error('清空服务器地址后，点击“下一步”未显示必填校验提示。');
}

/**
 * 将当前完整任务的账号改成确定无效值后测试连接；调用方随后必须取消编辑，
 * 确保不会把异常凭据保存到可复用的 gs_test_ 任务中。
 */
export async function verifyExistingFtpTaskRejectsInvalidCredentials(page: Page): Promise<void> {
  await openExistingFtpTaskEditor(page);
  const inputs = await connectionInputs(page);
  if (await inputs.count() < 4) throw new Error('已有 gs_test_ 任务编辑页的连接输入框不足，无法注入异常账号。');
  await inputs.nth(2).fill(`invalid_e2e_${Date.now()}`);
  await inputs.nth(3).fill('invalid-e2e-password');

  await assertConnectionRejected(page);
}

/** 清空完整任务的地址，仅验证前端/服务端拒绝，不保存编辑结果。 */
export async function verifyExistingFtpTaskRejectsEmptyAddress(page: Page): Promise<void> {
  await openExistingFtpTaskEditor(page);
  const inputs = await connectionInputs(page);
  if (await inputs.count() < 1) throw new Error('已有 gs_test_ 任务编辑页没有地址输入框。');
  await inputs.nth(0).fill('');
  await assertEmptyAddressBlockedOnNextStep(page);
}

/** 使用超过 TCP 端口范围的值，验证页面或服务端拒绝非法端口。 */
export async function verifyExistingFtpTaskRejectsInvalidPort(page: Page): Promise<void> {
  await openExistingFtpTaskEditor(page);
  const inputs = await connectionInputs(page);
  if (await inputs.count() < 2) throw new Error('已有 gs_test_ 任务编辑页没有端口输入框。');
  await inputs.nth(1).fill('70000');
  await assertConnectionRejected(page);
}

/** 使用唯一不存在的远端目录，验证服务端目录校验，不保存编辑结果。 */
export async function verifyExistingFtpTaskRejectsMissingDirectory(page: Page): Promise<void> {
  await openExistingFtpTaskEditor(page);
  const directory = await inputWithCurrentValue(page, '/gs/')
    ?? await inputWithCurrentValue(page, '/source');
  if (!directory) throw new Error('已有 gs_test_ 任务编辑页未找到文件路径输入框（已检查 /gs/ 与 /source）。');
  await directory.fill(`/e2e_missing_directory_${Date.now()}`);
  await assertConnectionRejected(page);
}

/** 在不保存原任务的前提下打开字段预览，确认当天 gs_test 文件可被真实读取。 */
export async function previewExistingFtpTaskData(page: Page): Promise<void> {
  const preview = await lastVisible([
    page.getByRole('button', { name: /数据预览/ }).filter({ visible: true }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /数据预览/ }),
  ]);
  if (!preview) throw new Error('已有 gs_test_ 任务编辑页没有“数据预览”按钮。');
  await preview.click();
  const dialog = page.locator('.el-dialog:visible, .ant-modal:visible, [role="dialog"]:visible').last();
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.locator('table:visible, tbody:visible, pre:visible, [class*="content"]:visible').first())
    .toBeVisible({ timeout: 15_000 });
}

/**
 * 读取当前 gs_test_ 任务实际回填的目标表，不再猜测 e2e_ftp_table_ 历史前缀。
 * 返回前仅使用符合常规数据库标识符规则的值，并排除 e2e_test 数据库/Schema 名。
 */
export async function readExistingFtpTargetTable(page: Page): Promise<string> {
  // “表”并非下拉框，编辑态通常是禁用的 input。先按 placeholder / 标签定位，
  // 不可从所有下拉框的最后一个值倒推——最后一个下拉值经常只是 MYSQL 类型。
  const tableInputs = page.getByPlaceholder(/请输入表名/).filter({ visible: true });
  for (let index = await tableInputs.count() - 1; index >= 0; index -= 1) {
    const value = (await tableInputs.nth(index).inputValue().catch(() => '')).trim();
    if (/^[A-Za-z_][A-Za-z0-9_$-]*$/.test(value) && !/^(?:e2e_test|gs_test)$/i.test(value)) return value;
  }

  const labels = page.getByText(/^\s*表\s*$/).filter({ visible: true });
  for (let index = await labels.count() - 1; index >= 0; index -= 1) {
    let scope = labels.nth(index);
    for (let level = 0; level < 6; level += 1) {
      const input = scope.locator('input:visible:not([type="radio"]):not([type="checkbox"])').last();
      const value = (await input.inputValue().catch(() => '')).trim();
      if (/^[A-Za-z_][A-Za-z0-9_$-]*$/.test(value) && !/^(?:e2e_test|gs_test)$/i.test(value)) return value;
      scope = scope.locator('..');
    }
  }

  const textInputs = page.locator(
    'input:visible:not([type="radio"]):not([type="checkbox"]):not([type="password"])',
  );
  const values: string[] = [];
  for (let index = 0; index < await textInputs.count(); index += 1) {
    values.push((await textInputs.nth(index).inputValue().catch(() => '')).trim());
  }
  const comboValues = (await page.locator('[role="combobox"]:visible').allTextContents())
    .map((value) => value.replace(/^\s*请选择\s*/, '').replace(/\s+/g, ' ').trim());
  const candidates = [...values, ...comboValues];
  const target = [...candidates].reverse().find((value) =>
    /^[A-Za-z_][A-Za-z0-9_$-]*$/.test(value)
    && !/^(?:e2e_test|gs_test|source|utf-?8|mysql|gaussdbm|gbase8a|hive|opengauss)$/i.test(value)
    && !/^\d+$/.test(value),
  );
  if (target) return target;
  throw new Error(`编辑页未读取到目标表名；可见文本输入值：${values.join('、')}；下拉回显：${comboValues.join('、')}`);
}

/** 编辑页测试/预览结束后关闭浮层并取消，避免残留下拉层或弹窗遮挡下一条用例。 */
export async function closeExistingFtpTaskEditor(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => undefined);
  const cancel = await lastVisible([
    page.getByRole('button', { name: /取\s*消|关闭/ }).filter({ visible: true }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /取\s*消|关闭/ }),
  ]);
  if (cancel) await cancel.click();
}

/**
 * 同步任务执行前只处理当前目标行的状态：若已下线则先上线，已上线不重复操作。
 * 这是接入列表的实际业务前置，不再把“任务下线导致点击执行无反馈”误判成执行接口失败。
 */
async function ensureExistingFtpTaskOnline(page: Page, index: number): Promise<void> {
  const operationRow = operationTableRows(page).nth(index);
  const online = await lastVisible([
    operationRow.getByText(/^上线$/).filter({ visible: true }),
    operationRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /^上线$/ }),
  ]);
  if (!online) return;

  await online.click();
  await expect.poll(async () => {
    const refreshed = operationTableRows(page).nth(index);
    return await refreshed.getByText(/^下线$/).filter({ visible: true }).isVisible().catch(() => false);
  }, { timeout: 12_000 }).toBe(true);
}

/**
 * 执行已有 gs_test_ 任务，并以接入实例完成状态和真实执行日志作为通过依据。
 * 该函数不新建、不编辑任务，适合重复回归执行。
 */
export async function executeExistingFtpTaskAndVerifyLog(page: Page, taskName = 'gs_test_'): Promise<void> {
  await clickMenu(page, '数据接入', 'ftp文件接入', '接入列表');
  await expect(page.locator('table:visible, [role="grid"]:visible, .el-table:visible').first())
    .toBeVisible({ timeout: 15_000 });
  const { index } = await findExistingGsSyncTask(page, taskName);
  await ensureExistingFtpTaskOnline(page, index);

  await clickIndexedOperation(page, /^执行$/, index);
  // 当前版本的“执行”可能无成功 toast 而直接异步创建实例；不能把没有 toast
  // 当作失败。真正的通过依据仍是后续实例状态和执行日志。
  await page.waitForTimeout(800);

  await clickIndexedOperation(page, /^查看实例$/, index);
  await page.waitForTimeout(800);
  const instancePage = page.context().pages().find((candidate) => candidate !== page) ?? page;
  if (instancePage !== page) await instancePage.bringToFront();
  await expect(instancePage.getByText(/实例/).filter({ visible: true }).last()).toBeVisible({ timeout: 15_000 });

  const instanceRows = instancePage.locator('tbody tr:visible, .el-table__body-wrapper tr:visible, [role="row"]:visible');
  const instanceRow = instanceRows.first();
  await expect(instanceRow).toBeVisible({ timeout: 15_000 });
  let statusText = '';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    statusText = await instanceRow.innerText().catch(() => '');
    if (/执行成功|同步完成|接入成功/.test(statusText) && !/执行中/.test(statusText)) break;
    if (/执行失败|同步失败|接入失败|异常/.test(statusText)) {
      throw new Error(`本轮同步任务 ${taskName} 执行失败：${statusText}`);
    }
    const query = await lastVisible([
      instancePage.getByRole('button', { name: /^查询$/ }),
      instancePage.locator('button:visible, [role="button"]:visible').filter({ hasText: /^查询$/ }),
    ]);
    if (query) await query.click();
    await instancePage.waitForTimeout(1_000);
  }
  if (!/执行成功|同步完成|接入成功/.test(statusText) || /执行中/.test(statusText)) {
    throw new Error(`本轮同步任务 ${taskName} 在等待时间内未完成：${statusText || '未读取到实例状态'}`);
  }

  // 实例页也采用固定列拆分：状态在主表，执行日志在操作表；按同一行号取操作。
  const instanceOperationTable = instancePage.locator('table:visible').filter({ hasText: /操作/ }).first();
  const instanceOperationRow = instanceOperationTable.locator(
    'tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not(:has([role="columnheader"]))',
  ).first();
  const logAction = await lastVisible([
    instanceOperationRow.getByText('执行日志', { exact: true }).filter({ visible: true }),
    instanceOperationRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /^执行日志$/ }),
    instanceRow.getByText('执行日志', { exact: true }).filter({ visible: true }),
    // 固定列表可能将主表和操作列渲染为两个 sibling table；此时 row 祖先关系
    // 不可见，页面级按钮是可靠的最后兜底。
    instancePage.getByRole('button', { name: '执行日志', exact: true }).filter({ visible: true }).first(),
    instancePage.getByText('执行日志', { exact: true }).filter({ visible: true }).last(),
  ]);
  if (!logAction) throw new Error('接入实例没有“执行日志”入口，无法确认实际执行结果。');
  const knownPages = new Set(instancePage.context().pages());
  const openedLogPage = instancePage.context().waitForEvent('page', { timeout: 2_000 }).catch(() => undefined);
  await logAction.click();
  const popup = await openedLogPage;
  const logPage = popup ?? instancePage.context().pages().find((candidate) => !knownPages.has(candidate)) ?? instancePage;
  if (logPage !== instancePage) await logPage.bringToFront();
  if (logPage !== instancePage) {
    await logPage.waitForLoadState('domcontentloaded').catch(() => undefined);
  }
  const logPanel = logPage.locator(
    '.el-dialog:visible, .ant-modal:visible, .el-drawer:visible, [role="dialog"]:visible',
  ).last();
  const readLogText = async (): Promise<string> => await (await logPanel.isVisible().catch(() => false)
    ? logPanel.innerText().catch(() => '')
    : logPage.locator('body').innerText().catch(() => ''));
  // 日志抽屉先渲染“加载中...”，等待真实内容完成加载后再判定，避免把正常的
  // 异步日志请求误报为执行失败。
  await expect.poll(async () => {
    const text = (await readLogText()).replace(/\s+/g, ' ').trim();
    return Boolean(text) && !/^加载中(?:\.\.\.|…)?$/.test(text);
  }, { timeout: 15_000 }).toBe(true);
  const logText = await readLogText();
  if (!logText.trim() || /暂无数据/.test(logText) || !/DATAX|执行状态|执行成功|同步完成|执行完成|成功|完成|回调/.test(logText)) {
    throw new Error(`接入实例执行日志没有明确结果：${logText.slice(0, 1000)}`);
  }
}

export async function findExistingFtpTaskOperation(page: Page, name: RegExp): Promise<{ index: number }> {
  const result = await findExistingGsSyncTask(page);
  const operationRow = operationTableRows(page).nth(result.index);
  const action = await lastVisible([
    operationRow.getByText(name).filter({ visible: true }),
    operationRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }),
    page.getByText(name).filter({ visible: true }).nth(result.index),
  ]);
  if (!action) throw new Error(`接入列表第 ${result.index + 1} 行没有操作“${name}”。`);
  return result;
}

/** 点击已有任务对应行的操作；找不到时返回 false，供状态机用例按当前状态分支。 */
export async function tryClickExistingFtpTaskOperation(page: Page, name: RegExp): Promise<boolean> {
  const result = await findExistingGsSyncTask(page);
  const operationRow = operationTableRows(page).nth(result.index);
  const action = await lastVisible([
    operationRow.getByText(name).filter({ visible: true }),
    operationRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }),
    page.getByText(name).filter({ visible: true }).nth(result.index),
    page.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }).nth(result.index),
  ]);
  if (!action) return false;
  await action.click();
  return true;
}

async function clickOwnedButton(page: Page, name: RegExp): Promise<void> {
  const button = await lastVisible([
    page.getByRole('button', { name }).filter({ visible: true }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: name }),
  ]);
  if (!button) throw new Error(`未找到可见按钮：${name}`);
  await button.click();
}

function todayStamp(): string {
  const value = new Date();
  return `${value.getFullYear()}${String(value.getMonth() + 1).padStart(2, '0')}${String(value.getDate()).padStart(2, '0')}`;
}

async function chooseOwnedOption(page: Page, value: string): Promise<void> {
  const pattern = new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  const option = page.locator(
    '.el-select-dropdown:visible li:visible, .ant-select-dropdown:visible [role="option"]:visible, [role="listbox"]:visible [role="option"]:visible',
  ).filter({ hasText: pattern }).last();
  await expect(option, `下拉框未提供选项：${value}`).toBeVisible({ timeout: 8_000 });
  await option.click();
  await page.keyboard.press('Escape').catch(() => undefined);
}

async function configureOwnedDateRule(page: Page): Promise<void> {
  const values = ['_', '空', '空', '日', '0'];
  const combos = page.locator('[role="combobox"]:visible');
  if (await combos.count() < values.length) {
    throw new Error(`FTP 文件名日期规则下拉框不足：${await combos.count()}`);
  }
  for (const [index, value] of values.entries()) {
    await combos.nth(index).click();
    await chooseOwnedOption(page, value);
  }
}

async function fillOwnedTableName(page: Page, tableName: string): Promise<void> {
  const labels = page.getByText(/^\s*\*?\s*表\s*[:：]?\s*$/).filter({ visible: true });
  for (let index = await labels.count() - 1; index >= 0; index -= 1) {
    let scope = labels.nth(index);
    for (let depth = 0; depth < 6; depth += 1, scope = scope.locator('..')) {
      const input = scope.locator('input:visible:not([type="radio"]):not([type="checkbox"]):not([disabled])').last();
      if (await input.isVisible().catch(() => false) && await input.isEditable().catch(() => false)) {
        await input.fill(tableName);
        return;
      }
    }
  }
  const fallback = page.locator('input:visible:not([type="radio"]):not([type="checkbox"]):not([type="password"]):not([disabled])').last();
  if (await fallback.isVisible().catch(() => false) && await fallback.isEditable().catch(() => false)) {
    await fallback.fill(tableName);
    return;
  }
  throw new Error('FTP 新建页未找到自动建表目标表输入框。');
}

async function fillOwnedMappingTargets(page: Page): Promise<void> {
  const rows = page.locator('tbody tr:visible, .el-table__body-wrapper tr:visible, [role="row"]:visible')
    .filter({ hasNotText: /文件名称|导入状态|数据源类型/ });
  const rowCount = await rows.count();
  if (!rowCount) throw new Error('字段映射页没有可编辑行。');
  for (let index = 0; index < rowCount; index += 1) {
    const input = rows.nth(index).locator('input:not([type="checkbox"]):not([type="radio"]):visible').first();
    await expect(input, `字段映射第 ${index + 1} 行没有目标字段输入框`).toBeVisible({ timeout: 5_000 });
    await input.fill(`codex_fs01_col_${index}`);
    await input.press('Enter').catch(() => input.press('Tab').catch(() => undefined));
  }
}

async function fillOwnedTaskName(page: Page, taskName: string): Promise<void> {
  const labeled = page.getByLabel(/任务名称|接入任务名称/).filter({ visible: true }).last();
  if (await labeled.isVisible().catch(() => false)) {
    await labeled.fill(taskName);
    return;
  }
  const placeholder = page.getByPlaceholder(/任务名称|接入任务名称/).filter({ visible: true }).last();
  if (await placeholder.isVisible().catch(() => false)) {
    await placeholder.fill(taskName);
    return;
  }
  throw new Error('FTP 保存页未找到任务名称输入框。');
}

/**
 * 仅对本测试创建的夹具任务定位行号；找不到返回 -1。
 *
 * 网络实证（run-20260929-002954-565）：文件名称查询框绑定请求字段 originalFilename，
 * 向导任务名称既不渲染也不可过滤，按任务名查询恒返回 0 行；但接入列表“导入数据表”
 * 列渲染自动建表的唯一表名，与夹具任务名同串。因此先保留原有按名查询的旧行为，
 * 未命中时清空过滤条件，改为按行文本包含唯一串定位（兼容拆分双表行号对齐）。
 */
async function findOwnedRowIndex(page: Page, taskName: string): Promise<number> {
  const scanOwnedRows = async (): Promise<number> => {
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      // 固定列拆分：唯一串可能渲染在“导入状态”或“文件名称”任一拆分表，
      // 按相同行号拼接两侧行文本后匹配（与 DI-04-02 的双表行号对齐口径一致）。
      const statusRows = dataTableRows(page);
      const fileRows = fileNameTableRows(page);
      const rowCount = Math.min(await statusRows.count(), await fileRows.count());
      for (let index = 0; index < rowCount; index += 1) {
        const text = `${await statusRows.nth(index).innerText().catch(() => '')} ${await fileRows.nth(index).innerText().catch(() => '')}`;
        if (text.includes(taskName)) return index;
      }
      const next = await lastVisible([
        page.getByRole('button', { name: /下一页/ }),
        page.locator('.ant-pagination-next:visible, .el-pagination .btn-next:visible'),
      ]);
      if (!next || await next.isDisabled().catch(() => true)) break;
      await next.click();
      await page.waitForTimeout(800);
    }
    return -1;
  };

  const searchInput = page.locator('input:visible:not([type="radio"]):not([type="checkbox"])').first();
  await searchInput.fill(taskName);
  await clickOwnedButton(page, /查\s*询/);
  await page.waitForTimeout(800);
  const searched = await scanOwnedRows();
  if (searched >= 0) return searched;

  // 查询未命中（owned 任务必然未命中）→ 清空过滤后按行内唯一表名扫描兜底。
  await searchInput.fill('');
  await clickOwnedButton(page, /查\s*询/);
  await page.waitForTimeout(800);
  return scanOwnedRows();
}

/** 本轮夹具精确清理选项；缺省仍按 codex_fs01_ 前缀校验，历史调用行为不变。 */
export interface OwnedFtpFixtureCleanupOptions {
  /** 创建该夹具时使用的唯一英文任务名前缀。 */
  taskPrefix?: string;
}

export async function deleteOwnedFtpConnectionFixture(page: Page, taskName: string, options: OwnedFtpFixtureCleanupOptions = {}): Promise<void> {
  const taskPrefix = options.taskPrefix ?? 'codex_fs01_';
  if (!taskName.startsWith(taskPrefix)) throw new Error(`拒绝清理非本轮命名规则的任务：${taskName}`);
  await page.keyboard.press('Escape').catch(() => undefined);
  await openFtpAccessList(page);
  const index = await findOwnedRowIndex(page, taskName);
  if (index < 0) return;

  const operationRow = operationTableRows(page).nth(index);
  // 执行过真实任务后处于上线态时平台可能拒绝直接删除，先下线再删除；
  // 离线任务行内没有“下线”按钮，此处不触发，既有调用方行为不变。
  const offlineAction = await lastVisible([
    operationRow.getByText('下线', { exact: true }).filter({ visible: true }),
    operationRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /^下线$/ }),
  ]);
  if (offlineAction) {
    await offlineAction.click();
    await expect.poll(
      async () => operationTableRows(page).nth(index)
        .getByText('上线', { exact: true }).filter({ visible: true }).isVisible().catch(() => false),
      { timeout: 12_000 },
    ).toBe(true);
  }
  const action = await lastVisible([
    operationRow.getByText(/^删除$/).filter({ visible: true }),
    operationRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /^删除$/ }),
  ]);
  if (!action) throw new Error(`本轮任务 ${taskName} 没有可见删除入口，无法完成精确清理。`);
  const nativeDialog = page.waitForEvent('dialog', { timeout: 2_000 })
    .then((dialog) => dialog.accept())
    .catch(() => undefined);
  await action.click();
  const confirm = await lastVisible([
    page.getByRole('button', { name: /^(?:确\s*定|确\s*认)$/ }).filter({ visible: true }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /^(?:确\s*定|确\s*认)$/ }),
  ]);
  if (confirm) await confirm.click();
  await nativeDialog;
  await expect(fileNameTableRows(page).filter({ hasText: taskName }))
    .toHaveCount(0, { timeout: 15_000 });
}

/** 按本轮唯一任务名重新打开接入任务编辑页；保存后的回显断言复用同一入口。 */
export async function openOwnedFtpTaskEditor(page: Page, taskName: string): Promise<void> {
  await openFtpAccessList(page);
  const index = await findOwnedRowIndex(page, taskName);
  if (index < 0) throw new Error(`未找到本轮已保存任务：${taskName}`);
  await clickIndexedOperation(page, /编辑/, index);
  await expect(page.getByText('来源文件', { exact: true }).filter({ visible: true }).last())
    .toBeVisible({ timeout: 15_000 });
}

/** 本轮自有夹具创建选项；缺省仍为当前 SFTP profile 与 codex_fs01_ 前缀，既有 FS/DI 用例默认走 SFTP 的行为不变。 */
export interface OwnedFtpFixtureOptions {
  /** 传输 profile；缺省 requireSftpProfile()。 */
  profile?: FileTransferProfileConfig;
  /** 唯一英文任务名/自动建表表名前缀；缺省 codex_fs01_。 */
  taskPrefix?: string;
}

export async function createOwnedFtpConnectionFixture(page: Page, options: OwnedFtpFixtureOptions = {}): Promise<string> {
  const profile = options.profile ?? requireSftpProfile();
  const taskPrefix = options.taskPrefix ?? 'codex_fs01_';
  const runId = `${Date.now().toString(36)}_${uuid()}`;
  const taskName = `${taskPrefix}${runId}`;
  const tableName = `${taskPrefix}${runId}`.slice(0, 63);
  const basePath = `${profile.baseDir.replace(/\/+$/, '')}/`;
  const baseFileName = profile.baseFile.replace(/\.[^./]+$/, '');

  await openFtpAccessList(page);
  const existingIndex = await findOwnedRowIndex(page, taskName);
  if (existingIndex >= 0) await deleteOwnedFtpConnectionFixture(page, taskName, { taskPrefix });

  await clickOwnedButton(page, /新建接入|新增接入/);
  await expect(page.getByText('来源文件', { exact: true }).filter({ visible: true }).last())
    .toBeVisible({ timeout: 15_000 });
  const protocol = page.locator(`input[type="radio"][value="${profile.protocol}"]:visible`).first();
  await protocol.check();
  await fillByLabel(page, '地址', profile.host);
  await fillByLabel(page, '端口', String(profile.port));
  await fillByLabel(page, '用户名', profile.username);
  await fillByLabel(page, '密码', profile.password);
  await fillByLabel(page, '文件', basePath);
  await fillByLabel(page, '基础文件名', baseFileName);
  await fillByLabel(page, '列分隔符', ',');
  await configureOwnedDateRule(page);
  await selectByLabel(page, '数据源类型', testEnvironment.dataSourceNames.fileAccess.type);
  await selectByLabel(page, '数据源名称', testEnvironment.dataSourceNames.fileAccess.name);
  await selectByLabel(page, '数据库名称', testEnvironment.dataSourceNames.fileAccess.database);
  await selectByLabel(page, 'Schema', testEnvironment.dataSourceNames.fileAccess.schema);
  const autoBuild = page.getByRole('radio', { name: '自动建表', exact: true }).last();
  await autoBuild.click();
  await expect(autoBuild).toBeChecked({ timeout: 5_000 });
  await fillOwnedTableName(page, tableName);

  const connectionResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
    && /\/file-datasource\/saveFtpServerConfig(?:\?|$)/i.test(response.url()),
  { timeout: 30_000 });
  await clickOwnedButton(page, /测试连接/);
  const response = await connectionResponse;
  const body = await response.text().catch(() => '');
  if (response.status() >= 300 || /失败|错误|异常|fail|error/i.test(body)) {
    throw new Error(`当前 ${profile.protocol.toUpperCase()} profile 测试连接被拒绝：HTTP ${response.status()}`);
  }
  await expect(page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
    .filter({ hasText: /连接成功|测试成功|成功/ }).last()).toBeVisible({ timeout: 15_000 });

  await clickOwnedButton(page, /预览文件名/);
  await expect(page.getByText(new RegExp(`${baseFileName}_${todayStamp()}`)).filter({ visible: true }).last())
    .toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape').catch(() => undefined);
  await clickOwnedButton(page, /数据预览/);
  const preview = page.locator('.el-dialog:visible, .ant-modal:visible, [role="dialog"]:visible').last();
  await expect(preview.locator('table:visible, tbody:visible, pre:visible, [class*="content"]:visible').first())
    .toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape').catch(() => undefined);
  await clickOwnedButton(page, /下一步/);
  await expect(page.getByText(/字段映射|目标映射|来源字段/).filter({ visible: true }).last())
    .toBeVisible({ timeout: 15_000 });
  await fillOwnedMappingTargets(page);
  await clickOwnedButton(page, /下一步/);
  await fillOwnedTaskName(page, taskName);
  const retry = page.getByRole('spinbutton').filter({ visible: true }).last();
  if (await retry.isVisible().catch(() => false)) await retry.fill('0');
  await clickOwnedButton(page, /^确\s*定$/);
  await expect.poll(async () => {
    const text = await page.locator('body').innerText();
    return /创建成功|保存成功|同步任务.*创建/.test(text) || !/ftpAccessCreate/.test(page.url());
  }, { timeout: 30_000 }).toBe(true);
  return taskName;
}

export async function verifyOwnedFtpTaskConnection(page: Page, taskName: string): Promise<void> {
  await openOwnedFtpTaskEditor(page, taskName);
  const testConnection = await lastVisible([
    page.getByRole('button', { name: /测试连接/ }).filter({ visible: true }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /测试连接/ }),
  ]);
  if (!testConnection) throw new Error('本轮任务编辑页没有“测试连接”按钮。');
  await testConnection.click();
  await expect(
    page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
      .filter({ hasText: /连接成功|测试成功|成功/ }).last(),
  ).toBeVisible({ timeout: 15_000 });
}

/** 缺失即无法创建净环境 SFTP 夹具的环境变量名（只报变量名，不回显任何值）。 */
export function missingSftpCredentialEnvNames(): string[] {
  const sftp = testEnvironment.fileTransfer.sftp;
  return [
    sftp.username ? undefined : 'SFTP_USER',
    sftp.password ? undefined : 'SFTP_PASS',
  ].filter((name): name is string => !!name);
}

/**
 * 重新打开本轮夹具并断言连接配置仍是创建时的原始值；
 * 负向分支用它证明“取消/失败”没有把坏配置保存回夹具。
 */
export async function verifyOwnedFixtureKeptOriginalConfig(page: Page, taskName: string): Promise<void> {
  const expectedHost = requireSftpProfile().host;
  await openOwnedFtpTaskEditor(page, taskName);
  const inputs = await connectionInputs(page);
  if (await inputs.count() < 1) throw new Error('本轮任务编辑页没有地址输入框。');
  await expect(inputs.nth(0)).toHaveValue(expectedHost, { timeout: 10_000 });
}

export async function verifyOwnedFtpTaskRejectsEmptyAddress(page: Page, taskName: string): Promise<void> {
  await openOwnedFtpTaskEditor(page, taskName);
  const inputs = await connectionInputs(page);
  if (await inputs.count() < 1) throw new Error('本轮任务编辑页没有地址输入框。');
  await inputs.nth(0).fill('');
  await assertEmptyAddressBlockedOnNextStep(page);
}

export async function verifyOwnedFtpTaskRejectsInvalidPort(page: Page, taskName: string): Promise<void> {
  await openOwnedFtpTaskEditor(page, taskName);
  const inputs = await connectionInputs(page);
  if (await inputs.count() < 2) throw new Error('本轮任务编辑页没有端口输入框。');
  await inputs.nth(1).fill('70000');
  await assertConnectionRejected(page);
}

export async function verifyOwnedFtpTaskRejectsInvalidCredentials(page: Page, taskName: string): Promise<void> {
  await openOwnedFtpTaskEditor(page, taskName);
  const inputs = await connectionInputs(page);
  if (await inputs.count() < 4) throw new Error('本轮任务编辑页的连接输入框不足。');
  await inputs.nth(2).fill(`invalid_codex_${Date.now()}`);
  await inputs.nth(3).fill(`invalid-codex-password-${Date.now()}`);
  await assertConnectionRejected(page);
}

export async function verifyOwnedFtpTaskRejectsMissingDirectory(page: Page, taskName: string): Promise<void> {
  const expectedPath = `${requireSftpProfile().baseDir.replace(/\/+$/, '')}/`;
  await openOwnedFtpTaskEditor(page, taskName);
  const directory = await inputWithCurrentValue(page, expectedPath);
  if (!directory) throw new Error('本轮任务编辑页未找到当前环境文件路径输入框。');
  await directory.fill(`/codex_fs01_missing_${Date.now()}`);
  await assertConnectionRejected(page);
}

// ==================== 本轮唯一任务重复执行验证（DI-02-02 迁移新增） ====================

/** 重复执行验证选项；全部可选，缺省等价单次执行。 */
export interface OwnedFtpTaskRepeatOptions {
  /** 对同一任务真实执行的次数（含首次）；最小 1，缺省 1。 */
  executions?: number;
  /** 每轮等待“绑定该任务的成功实例数达标”的超时毫秒数；缺省 90_000。 */
  instanceTimeoutMs?: number;
  /**
   * 列表/实例行内的唯一锚点文本；缺省用任务名本身。createOwnedFtpConnectionFixture
   * 生成的任务名与自动建表表名同串（长度远小于 63 字符截断阈值），接入列表
   * “导入数据表”列与接入实例行都渲染该唯一串；而向导任务名称既不渲染也不可被
   * 文件名称查询框过滤（run-20260929-002954-565：按任务名查询返回 0 行）。
   */
  uniqueAnchor?: string;
}

/**
 * 对本轮唯一任务真实执行多次，并逐轮验证：
 *   1. 绑定该任务唯一锚点的成功接入实例累计数比上一轮严格递增（证明本轮执行确实新建实例）；
 *   2. 本轮新增成功实例的执行日志有明确完成结果（无法按行文本区分新增时，退化为
 *      核对该任务当前全部成功实例的日志，不会更弱）。
 * 实例与日志都通过“行文本包含唯一锚点”绑定，不取任意首行、不按宽泛前缀复用旧记录；
 * 任务此前零实例时的“实例页仅 1 行”兜底与 DI-04-02 既有口径一致。
 * 只读取与执行本轮任务，不新建、不删除任务；既有单次执行 helper 及其调用方不受影响。
 */
export async function executeOwnedFtpTaskRepeatedlyAndVerifyLogs(
  page: Page,
  taskName: string,
  options: OwnedFtpTaskRepeatOptions = {},
): Promise<number> {
  const executions = Math.max(1, Math.floor(options.executions ?? 1));
  const instanceTimeoutMs = options.instanceTimeoutMs ?? 90_000;
  const anchor = options.uniqueAnchor ?? taskName;

  let previousSuccessCount = 0;
  const knownRowTexts = new Set<string>();
  for (let round = 1; round <= executions; round += 1) {
    await openFtpAccessList(page);
    const index = await findOwnedRowIndex(page, taskName);
    if (index < 0) throw new Error(`未找到本轮已保存任务：${taskName}（唯一锚点：${anchor}）`);
    await ensureExistingFtpTaskOnline(page, index);

    await clickIndexedOperation(page, /^执行$/, index);
    // 若平台弹出二次确认则确认之；没有弹窗时此步为空操作。
    const confirmAction = await lastVisible([
      page.locator('.el-dialog:visible, .ant-modal:visible, .el-drawer:visible, [role="dialog"]:visible')
        .getByRole('button', { name: /确\s*定|确\s*认/ }).filter({ visible: true }).last(),
    ]);
    if (confirmAction) await confirmAction.click().catch(() => undefined);
    // 当前版本的“执行”可能无成功 toast 而直接异步创建实例；真实结果以下方实例为准。
    await page.waitForTimeout(800);

    const pagesBefore = new Set(page.context().pages());
    await clickIndexedOperation(page, /^查看实例$/, index);
    await page.waitForTimeout(800);
    const instancePage = page.context().pages().find((candidate) => !pagesBefore.has(candidate))
      ?? page.context().pages().find((candidate) => candidate !== page)
      ?? page;
    if (instancePage !== page) await instancePage.bringToFront();
    await expect(instancePage.getByText(/实例/).filter({ visible: true }).last())
      .toBeVisible({ timeout: 15_000 });
    const finishText = /执行成功|同步完成|接入成功|执行完成/;
    const failText = /执行失败|同步失败|接入失败/;
    const required = previousSuccessCount + 1;
    const boundSuccessTexts: string[] = [];
    const deadline = Date.now() + instanceTimeoutMs;
    let lastBoundText = '';
    while (Date.now() < deadline) {
      boundSuccessTexts.length = 0;
      const rows = instancePage.locator('tbody tr:visible, .el-table__body-wrapper tr:visible, [role="row"]:visible');
      const total = await rows.count();
      const boundTexts: string[] = [];
      for (let rowIndex = 0; rowIndex < total; rowIndex += 1) {
        const text = (await rows.nth(rowIndex).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (!text.includes(anchor)) continue;
        boundTexts.push(text);
        if (finishText.test(text) && !/执行中/.test(text)) boundSuccessTexts.push(text);
        else if (failText.test(text)) throw new Error(`本轮唯一任务（${anchor}）第 ${round} 次执行失败：${text}`);
      }
      // 兜底（与 DI-04-02 同口径）：实例页自本轮唯一任务行打开、该任务此前零实例，
      // 单行不可能属于其他任务；仍不是“任意首行”。
      if (boundTexts.length === 0 && previousSuccessCount === 0 && total === 1) {
        const text = (await rows.first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        boundTexts.push(text);
        if (finishText.test(text) && !/执行中/.test(text)) boundSuccessTexts.push(text);
        else if (failText.test(text)) throw new Error(`本轮唯一任务（${anchor}）第 ${round} 次执行失败：${text}`);
      }
      if (boundTexts.length > 0) lastBoundText = boundTexts[boundTexts.length - 1];
      if (boundSuccessTexts.length >= required) break;

      const refresh = await lastVisible([
        instancePage.getByRole('button', { name: /^查\s*询$/ }),
        instancePage.getByRole('button', { name: /^刷\s*新$/ }),
        instancePage.locator('button:visible, [role="button"]:visible').filter({ hasText: /^查\s*询$|^刷\s*新$/ }),
      ]);
      if (refresh) await refresh.click().catch(() => undefined);
      await instancePage.waitForTimeout(1_000);
    }
    if (boundSuccessTexts.length < required) {
      throw new Error(
        `本轮唯一任务（${anchor}）第 ${round} 次执行后，绑定该任务的成功实例累计 `
        + `${boundSuccessTexts.length} 个，未达到要求的 ${required} 个；最后观测实例行：${lastBoundText || '未读取到实例行'}`,
      );
    }

    // 只核对“本轮新增”的成功实例日志；行文本完全一致而无法区分时退化为全部核对。
    const newTexts = boundSuccessTexts.filter((text) => !knownRowTexts.has(text));
    const targets = newTexts.length > 0 ? newTexts : boundSuccessTexts;
    for (const rowText of targets) {
      await verifyBoundInstanceLogText(instancePage, anchor, rowText);
    }
    for (const text of boundSuccessTexts) knownRowTexts.add(text);
    previousSuccessCount = boundSuccessTexts.length;

    // 关闭本轮实例页（独立页签时），避免下一轮把旧实例页当成新打开的实例页。
    if (instancePage !== page) await instancePage.close().catch(() => undefined);
    await page.bringToFront().catch(() => undefined);
  }
  return previousSuccessCount;
}

/**
 * 打开“行文本与绑定成功实例一致”的执行日志并断言明确完成结果。
 * 固定列拆分时按同一行号取操作表行；页面级“执行日志”按钮仅作最后兜底。
 * 日志弹层打不开（只能读到实例页正文）时明确失败，不用实例状态冒充日志内容。
 */
async function verifyBoundInstanceLogText(instancePage: Page, anchor: string, rowText: string): Promise<string> {
  const rows = instancePage.locator('tbody tr:visible, .el-table__body-wrapper tr:visible, [role="row"]:visible');
  let boundIndex = -1;
  const total = await rows.count();
  for (let index = 0; index < total; index += 1) {
    const text = (await rows.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (text === rowText) {
      boundIndex = index;
      break;
    }
  }
  if (boundIndex < 0) throw new Error(`本轮唯一任务（${anchor}）的绑定成功实例行已不可见，无法核对执行日志：${rowText}`);
  const boundRow = rows.nth(boundIndex);
  const operationRow = instancePage.locator('table:visible').filter({ hasText: /操作/ }).first()
    .locator('tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not(:has([role="columnheader"]))')
    .nth(boundIndex);
  const logAction = await lastVisible([
    operationRow.getByText('执行日志', { exact: true }).filter({ visible: true }),
    operationRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /^执行日志$/ }),
    boundRow.getByText('执行日志', { exact: true }).filter({ visible: true }),
    boundRow.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /^执行日志$/ }),
    instancePage.getByRole('button', { name: '执行日志', exact: true }).filter({ visible: true }).first(),
    instancePage.getByText('执行日志', { exact: true }).filter({ visible: true }).last(),
  ]);
  if (!logAction) throw new Error(`本轮唯一任务（${anchor}）的成功实例没有可用“执行日志”入口。`);

  const knownPages = new Set(instancePage.context().pages());
  const popupPromise = instancePage.context().waitForEvent('page', { timeout: 2_000 }).catch(() => undefined);
  await logAction.click();
  const popup = await popupPromise;
  const logPage = popup ?? instancePage.context().pages().find((candidate) => !knownPages.has(candidate)) ?? instancePage;
  if (logPage !== instancePage) await logPage.bringToFront();
  await logPage.waitForLoadState('domcontentloaded').catch(() => undefined);

  const readLog = async (): Promise<{ text: string; panelVisible: boolean }> => {
    const panel = logPage.locator('.el-dialog:visible, .ant-modal:visible, .el-drawer:visible, [role="dialog"]:visible').last();
    const panelVisible = await panel.isVisible().catch(() => false);
    const text = panelVisible ? await panel.innerText().catch(() => '') : await logPage.locator('body').innerText().catch(() => '');
    return { text: text.replace(/\s+/g, ' ').trim(), panelVisible };
  };
  // 日志弹层先渲染“加载中...”；等真实内容出现后再判定，避免把异步加载误报为失败。
  await expect.poll(async () => {
    const { text } = await readLog();
    return Boolean(text) && !/^加载中(?:\.\.|…)?$/.test(text);
  }, { timeout: 15_000 }).toBe(true);
  const { text: logText, panelVisible } = await readLog();

  // 日志就在实例页正文本身时，正文里本来就有“执行成功/完成”等状态词，不能当作日志证据。
  if (!panelVisible && logPage === instancePage) {
    throw new Error(`本轮唯一任务（${anchor}）的执行日志弹层未打开，无法可靠读取日志正文。`);
  }
  if (!logText || /暂无数据/.test(logText) || !/DATAX|执行状态|执行成功|同步完成|执行完成|成功|完成|回调/.test(logText)) {
    throw new Error(`本轮唯一任务（${anchor}）执行日志没有明确结果：${logText.slice(0, 1000)}`);
  }

  // 关闭日志弹层/独立页，避免影响下一份日志的打开与读取。
  if (logPage !== instancePage) await logPage.close().catch(() => undefined);
  else {
    await instancePage.keyboard.press('Escape').catch(() => undefined);
    const closeButton = await lastVisible([
      instancePage.locator('.el-dialog:visible .el-dialog__headerbtn:visible, .ant-modal:visible .ant-modal-close:visible, .el-drawer:visible .el-drawer__close-btn:visible'),
      instancePage.locator('.el-dialog:visible, .ant-modal:visible, .el-drawer:visible, [role="dialog"]:visible')
        .getByRole('button', { name: /关\s*闭|取\s*消/ }).filter({ visible: true }).last(),
    ]);
    if (closeButton) await closeButton.click().catch(() => undefined);
    await instancePage.waitForTimeout(500);
  }
  return logText.slice(0, 160);
}
