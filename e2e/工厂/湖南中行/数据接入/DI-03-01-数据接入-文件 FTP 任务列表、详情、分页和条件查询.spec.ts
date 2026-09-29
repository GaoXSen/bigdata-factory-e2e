/**
 * DI-03-01｜数据接入｜文件接入列表按文件名查询、详情、分页与空态（DS-PERM-64 清洁环境迁移）
 *
 * 迁移说明（承接 DS-PERM-58 未完成目标，allowlist：仅本 spec）：
 *   - 移除固定历史样本文件名兜底与对历史成功记录的一切依赖；
 *   - 样本文件名、日期与资源来源只能从配置中心 / 运行时唯一资产派生：
 *       · 资源内容：配置中心 dataSourceNames.fileAccess.samplePath 指向的仓库样本（只读字节复制）；
 *       · 文件名：`e2e_di0301_<运行时日期>_<本轮UUID>.csv`（运行时生成，纯 ASCII）；
 *       · 日期：运行时系统日期（YYYYMMDD），不读取任何历史日期或历史记录；
 *   - 后端入库名契约：`/upload` 把上传文件改名为 `<原名>_<毫秒时间戳>.<后缀>` 再入库
 *     （FileUploadController.uploadFile → DfFileUploadTask.originalFilename），列表“文件名称”
 *     过滤是对入库名的 LIKE 包含匹配（DfFileUploadTaskServiceImpl），因此列表查询、行匹配
 *     与回收一律使用不含扩展名的唯一查询键 `e2e_di0301_<运行时日期>_<本轮UUID>`；
 *   - 成功记录由本轮真实创建（上传→解析→预览→自动建表→映射→保存），
 *     列表 / 详情 / 分页 / 条件查询 / 空态全部针对本轮唯一记录断言；
 *   - finally 只回收本轮记录与本轮自动建表，绝不触碰历史业务数据；
 *     页面不提供删除入口时明确记录保留（UUID 命名保证隔离），不伪造通过。
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
import { testEnvironment } from '../../../test-environment.js';
import { constants as fsConstants } from 'node:fs';
import { access, copyFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 样本资源来源：只允许来自配置中心（仓库内只读样本），运行时唯一化后再上传。
const SAMPLE_CSV = testEnvironment.dataSourceNames.fileAccess.samplePath;
// 文件接入自动建表的真实页面文案：表名输入框 placeholder 为“请输入表名”，Schema 标签为“Schema名称”。
const AUTO_TABLE_NAME_PLACEHOLDER = '请输入表名';
const AUTO_SCHEMA_LABEL = 'Schema名称';

async function firstVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    const visible = candidate.filter({ visible: true });
    if ((await visible.count()) > 0 && (await visible.first().isVisible())) return visible.first();
  }
  return undefined;
}

/** 本轮样本：以本轮唯一文件名对配置中心样本做字节级复制（内容零改动，来源可追溯）。 */
async function createRoundCsvCopy(roundFileName: string): Promise<string> {
  const target = path.join(os.tmpdir(), 'ds-perm-64-e2e', roundFileName);
  await mkdir(path.dirname(target), { recursive: true });
  await access(SAMPLE_CSV, fsConstants.R_OK);
  await copyFile(SAMPLE_CSV, target);
  return target;
}

async function skipIfFileUploadUnavailable(page: Page): Promise<boolean> {
  const upload = await firstVisible([
    page.locator('input[type="file"]:visible').first(),
    page.getByText(/上传|导入|拖拽|点击|选择/).filter({ visible: true }).last(),
  ]);
  return upload === undefined;
}

async function fillAutomaticTableName(page: Page, value: string): Promise<void> {
  const byPlaceholder = page.getByPlaceholder(AUTO_TABLE_NAME_PLACEHOLDER, { exact: true }).last();
  if (await byPlaceholder.isVisible().catch(() => false)) {
    await byPlaceholder.fill(value);
    return;
  }
  const inputs = page.locator('input:visible:not([type="radio"]):not([type="checkbox"])');
  if ((await inputs.count()) < 1) throw new Error('自动建表表单没有可用输入框。');
  await inputs.last().fill(value);
}

async function chooseAutomaticTableTarget(page: Page): Promise<void> {
  const autoTarget = testEnvironment.dataSourceNames.fileAccess;
  await selectByLabel(page, '数据源类型', autoTarget.type);
  await selectByLabel(page, '数据源名称', autoTarget.name);
  await selectByLabel(page, '数据库名称', autoTarget.database);
  await selectByLabel(page, AUTO_SCHEMA_LABEL, autoTarget.schema);
  const autoBuild = page.getByText('自动建表', { exact: true }).filter({ visible: true }).last();
  if (await autoBuild.isVisible().catch(() => false)) {
    await autoBuild.click();
    await page.waitForTimeout(500);
  }
}

async function openFileAccessForm(page: Page): Promise<void> {
  await clickMenu(page, '数据接入', '文件接入');
  const createButton = page.getByRole('button', { name: /新建|新增|创建/ }).last();
  await expect(createButton).toBeVisible();
  await createButton.click();
  await expect(page.getByText(/文件接入|来源文件/).filter({ visible: true }).last()).toBeVisible({ timeout: 10_000 });
}

async function uploadInFileAccessForm(page: Page, csvPath: string): Promise<void> {
  const input = page.locator('input[type="file"]').first();
  await expect(input).toBeAttached({ timeout: 10_000 });
  await input.setInputFiles(csvPath);
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

async function clickWizardNextToFileMapping(page: Page): Promise<void> {
  const next = await firstVisible([
    page.getByRole('button', { name: /下一步|继续/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /下一步|继续/ }),
  ]);
  if (!next) throw new Error(`文件接入表单未找到“下一步”按钮，当前页面：${page.url()}`);
  await next.click();
  await expect(page.getByText(/字段映射|目标映射/).filter({ visible: true }).last()).toBeVisible({ timeout: 10_000 });
}

/** 字段映射校验：本轮不与样本字段名耦合，统一归一化为 e2e_col_N（含唯一性自检）。 */
async function fillValidTargetMappingFields(page: Page): Promise<void> {
  const rows = page.locator('table:visible tbody tr');
  const rowCount = await rows.count();
  if (rowCount < 1) throw new Error('字段映射没有可用行。');
  const used = new Set<string>();
  for (let index = 0; index < rowCount; index += 1) {
    const firstInput = rows.nth(index).locator('input:not([type="checkbox"]):not([type="radio"]):visible').first();
    if ((await firstInput.count()) === 0) continue;
    const current = (await firstInput.inputValue().catch(() => '')).trim();
    const normalized = `e2e_col_${index}`.slice(0, 60);
    if (current === normalized) continue;
    if (current !== '' && used.has(current)) throw new Error(`字段映射目标列重名：${current}`);
    await firstInput.fill(normalized);
    used.add(normalized);
  }
}

async function confirmFileAccessMapping(page: Page): Promise<void> {
  const confirm = await firstVisible([
    page.getByRole('button', { name: /^(确\s*定|保\s*存|完\s*成|创\s*建)$/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /^(确\s*定|保\s*存|完\s*成|创\s*建)$/ }),
  ]);
  if (!confirm) throw new Error(`字段映射页没有“确定/保存”按钮，当前页面：${page.url()}`);
  await confirm.click();
  await expect
    .poll(
      async () => {
        const toastVisible = await page
          .locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
          .filter({ hasText: /成功|创建|保存|同步/ })
          .first()
          .isVisible()
          .catch(() => false);
        return toastVisible || !/fileAccessCreate/.test(page.url()) ? 'confirmed' : 'waiting';
      },
      { timeout: 20_000 },
    )
    .toBe('confirmed');
}

function tableWithHeader(page: Page, header: RegExp): Locator {
  return page.locator('table:visible').filter({ hasText: header });
}

/** 固定列拆分表：文件名称列所在的表。 */
function fileNameTableRows(page: Page): Locator {
  return tableWithHeader(page, /文件名称/).locator('tbody tr:visible');
}

/** 状态/操作列所在的表（导入状态表优先，兼容操作列表头）。 */
async function statusTableRows(page: Page): Promise<Locator> {
  const statusTable = tableWithHeader(page, /导入状态/);
  if ((await statusTable.count()) > 0) return statusTable.locator('tbody tr:visible');
  return tableWithHeader(page, /操作/).locator('tbody tr:visible');
}

async function clickFileAccessQuery(page: Page): Promise<void> {
  const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
  await queryButton.click({ timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
}

async function returnToFileAccessList(page: Page): Promise<void> {
  const returnButton = await firstVisible([
    page.getByRole('button', { name: /返\s*回/ }),
    page.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /返\s*回/ }),
  ]);
  if (returnButton) {
    await returnButton.click();
    await page.waitForTimeout(500);
  }
  const breadcrumb = page.getByText('文件接入', { exact: true });
  if ((await breadcrumb.count()) > 1) {
    await breadcrumb.nth(0).click({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
  }
  await expect(tableRows(page).first()).toBeVisible({ timeout: 10_000 });
}

/** 本轮记录达成“可用状态”的持久证据：按唯一查询键（不含扩展名）过滤后，只认后端同步成功终态。 */
async function verifyRoundRecordInList(page: Page, fileNameQueryKey: string): Promise<void> {
  const fileName = fileNameQueryKey; // 入库名=查询键+_<毫秒时间戳>+扩展名，hasText 子串匹配兼容两者
  await clickMenu(page, '数据接入', '文件接入');
  await fillByLabel(page, '文件名称', fileName);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await clickFileAccessQuery(page);
    if (await fileNameTableRows(page).filter({ hasText: fileName }).first().isVisible().catch(() => false)) break;
  }
  await expect
    .poll(
      async () => {
        const allRows = fileNameTableRows(page);
        const matched = allRows.filter({ hasText: fileName });
        if ((await allRows.count()) < 1 || (await allRows.count()) !== (await matched.count())) return 'waiting-filter';
        const rows = await statusTableRows(page);
        const statusText = (await rows.first().innerText().catch(() => '')).replace(/\s+/g, '');
        return statusText.includes('文件数据同步完成') ? 'done' : `status:${statusText.slice(0, 40)}`;
      },
      { timeout: 90_000 },
    )
    .toBe('done');
}

/** finally 只回收本轮唯一查询键对应的记录（入库名=查询键+时间戳后缀）；无删除入口时明确保留并告警（UUID 隔离）。 */
async function deleteRoundRecordIfExists(page: Page, fileNameQueryKey: string): Promise<void> {
  // 回收必须按查询键过滤：按完整原名查询会因入库名追加时间戳后缀而 miss，导致本轮记录无法回收。
  const fileName = fileNameQueryKey;
  await clickMenu(page, '数据接入', '文件接入');
  await fillByLabel(page, '文件名称', fileName);
  await clickFileAccessQuery(page);
  const allRows = fileNameTableRows(page);
  let rowIndex = -1;
  for (let index = 0; index < (await allRows.count()); index += 1) {
    if ((await allRows.nth(index).innerText().catch(() => '')).includes(fileName)) {
      rowIndex = index;
      break;
    }
  }
  if (rowIndex < 0) return; // 本轮记录未创建成功，无可回收项
  const operationRow = (await statusTableRows(page)).nth(rowIndex);
  const deleteAction = await firstVisible([
    operationRow.getByRole('button', { name: /删\s*除/ }),
    operationRow.getByRole('link', { name: /删\s*除/ }),
    operationRow.getByText(/删\s*除/).filter({ visible: true }),
  ]);
  if (!deleteAction) {
    console.warn(`[cleanup] 接入列表未提供“删除”操作，本轮记录保留（UUID 隔离）：${fileName}`);
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
      .poll(async () => ((await allRows.count()) === 0 ? 'deleted' : 'removing'), { timeout: 15_000 })
      .toBe('deleted');
  } finally {
    page.off('dialog', acceptDialog);
  }
}

async function dropRoundTableQuietly(tableName: string): Promise<void> {
  try {
    await query(`DROP TABLE IF EXISTS ${tableName}`);
    console.warn(`[cleanup] 已回收本轮自动建表：${tableName}`);
  } catch (error) {
    console.warn(`[cleanup] 本轮表未回收（DB 未配置或直连失败）：${tableName}；原因：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function cleanupRoundArtifacts(page: Page, tableName: string, fileName: string): Promise<void> {
  try {
    await deleteRoundRecordIfExists(page, fileName);
  } catch (error) {
    console.warn(`[cleanup] 本轮记录回收未完成（${fileName}）：${error instanceof Error ? error.message : String(error)}`);
  }
  await dropRoundTableQuietly(tableName);
}

test.describe('DI-03-01｜数据接入｜文件接入列表按文件名查询与详情', () => {
  test.beforeEach(async ({ loginPage }) => {
    await clickMenu(loginPage, '数据接入', '文件接入');
  });

  test('DI-03-01｜数据接入｜成功文件精确查询、空态查询与详情', async ({ loginPage, consoleErrors, report }) => {
    // 本轮样本创建（上传→解析→预览→自动建表→映射→保存）+ 列表/详情/分页/空态全链路，远超默认时限。
    test.setTimeout(900_000);
    const page = loginPage;
    const roundTag = uuid().slice(0, 8);
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    // 样本文件名/日期/资源来源：仅由配置中心样本路径 + 运行时日期 + 运行时 UUID 派生（纯 ASCII）。
    const roundFileName = `e2e_di0301_${stamp}_${roundTag}.csv`;
    // 后端入库名会追加 _<毫秒时间戳> 后缀；列表 LIKE 过滤必须用不含扩展名的唯一查询键才能命中且仍唯一。
    const roundFileQueryKey = `e2e_di0301_${stamp}_${roundTag}`;
    const tableName = `e2e_di0301_t_${roundTag}`;
    const uploadCsv = await createRoundCsvCopy(roundFileName);
    try {
      // 1) 本轮自建成功记录（不再依赖任何历史成功记录）。
      await openFileAccessForm(page);
      if (await skipIfFileUploadUnavailable(page)) {
        throw new Error('文件接入表单未提供上传入口，无法创建本轮唯一成功样本。');
      }
      await uploadInFileAccessForm(page, uploadCsv);
      await fillByLabel(page, '列分隔符', ',');
      const headerRadio = page.getByRole('radio', { name: '是', exact: true }).last();
      if (await headerRadio.isVisible().catch(() => false)) await headerRadio.check();
      const preview = await previewUploadedFile(page);
      await expect(preview.locator('table:visible, tbody:visible, pre:visible, [class*="content"]:visible').first()).toBeVisible({ timeout: 10_000 });
      await closeFilePreview(page, preview);
      await chooseAutomaticTableTarget(page);
      await fillAutomaticTableName(page, tableName);
      await clickWizardNextToFileMapping(page);
      await fillValidTargetMappingFields(page);
      await confirmFileAccessMapping(page);
      await verifyRoundRecordInList(page, roundFileQueryKey);

      // 2) 列表展示与分页（恢复全量列表后断言）。
      await fillByLabel(page, '文件名称', '');
      await clickFileAccessQuery(page);
      await expect(tableRows(page).first()).toBeVisible();
      await expect(page.locator('.el-pagination:visible, [class*="pagination"]:visible').first()).toBeVisible();

      // 3) 成功样本精确查询：唯一查询键（不含扩展名）应恰好命中本轮记录（入库名=查询键+时间戳后缀）。
      await fillByLabel(page, '文件名称', roundFileQueryKey);
      await clickFileAccessQuery(page);
      const matchedRows = fileNameTableRows(page).filter({ hasText: roundFileQueryKey });
      await expect(matchedRows.first(), `文件接入列表未找到本轮成功样本（查询键 ${roundFileQueryKey}）`).toBeVisible({ timeout: 10_000 });
      await expect(matchedRows).toHaveCount(1);
      await expect(matchedRows.first()).toContainText('文件数据同步完成');
      const detailButton = page.getByRole('button', { name: /查看详情|详情|查看/ }).filter({ visible: true }).first();
      await expect(detailButton, '本轮记录行没有可用“查看详情”入口').toBeVisible({ timeout: 10_000 });
      await detailButton.click();
      await expect(page.getByText(/任务|接入/).first()).toBeVisible();
      await returnToFileAccessList(page);

      // 4) 条件查询空态 + 清空恢复。
      await fillByLabel(page, '文件名称', `不存在_${uuid()}`);
      await clickFileAccessQuery(page);
      await expect(page.getByText(/暂无数据|没有数据/).first()).toBeVisible();
      await fillByLabel(page, '文件名称', '');
      await clickFileAccessQuery(page);
      await assertNoConsoleErrors(consoleErrors);
      await report(
        '文件接入-成功样本查询-详情-空态查询',
        true,
        `样本=${roundFileName}（查询键=${roundFileQueryKey}；配置中心 samplePath 字节复制 + 运行时日期/UUID）；表=${tableName}；列表/详情/分页/空态均针对本轮唯一记录验证。`,
      );
    } finally {
      await cleanupRoundArtifacts(page, tableName, roundFileQueryKey);
    }
  });
});




