/** FS-02-02｜FTP/SFTP｜空文件上传被拒与仅表头文件字段预览 */
import type { Locator, Page } from '@playwright/test';
import { test, expect, uuid, clickMenu } from '../utils.js';
import { assertNoConsoleErrors, fillByLabel } from '../utils.js';
import { copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const EMPTY_CSV_SOURCE = path.join(ASSET_DIR, 'empty.csv');
const HEADER_ONLY_CSV_SOURCE = path.join(ASSET_DIR, 'header-only.csv');

async function firstVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    const count = await candidate.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const item = candidate.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return undefined;
}

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

async function prepareUploadedFile(page: Page, filePath: string): Promise<void> {
  await openFileAccessForm(page);
  await uploadInFileAccessForm(page, filePath);
  await fillByLabel(page, '列分隔符', ',');
  const headerRadio = page.getByRole('radio', { name: '是', exact: true }).last();
  if (await headerRadio.isVisible().catch(() => false)) await headerRadio.check();
}

async function previewUploadedFile(page: Page): Promise<void> {
  await closePreviewFeedback(page);
  await page.getByRole('button', { name: /数据预览|预\s*览/ }).click();
}

async function expectFileAccessFeedback(page: Page, pattern: RegExp, description: string): Promise<void> {
  const candidates = [
    page.getByText(pattern).filter({ visible: true }),
    page.locator(
      '.ant-message-notice:visible, .el-message:visible, [role="alert"]:visible, ' +
        '.ant-form-item-explain-error:visible, .ant-alert:visible, .el-alert:visible, ' +
        '.ant-empty:visible, .el-table__empty-text:visible',
    ).filter({ hasText: pattern }),
  ];
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await firstVisible(candidates)) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`${description}未出现，当前页面：${page.url()}`);
}

async function closePreviewFeedback(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dialog = page
      .locator('[role="dialog"]:visible, .ant-modal-wrap:visible, .ant-modal:visible, .el-dialog:visible')
      .last();
    if (!(await dialog.isVisible().catch(() => false))) return;

    const closeButton = dialog.getByRole('button', { name: /关闭|取\s*消|Close|确\s*定|OK/i }).last();
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click().catch(() => undefined);
    } else {
      const iconClose = dialog
        .locator('.ant-modal-close:visible, .el-dialog__headerbtn:visible, button[class*="close"]:visible')
        .last();
      if (await iconClose.isVisible().catch(() => false)) {
        await iconClose.click().catch(() => undefined);
      } else {
        await page.keyboard.press('Escape').catch(() => undefined);
      }
    }

    await expect(dialog).toBeHidden({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
  }
}

test.describe('FS-02-02｜FTP/SFTP｜空文件与仅表头预览', () => {
  test.beforeEach(async ({ loginPage }) => {
    await clickMenu(loginPage, '数据接入', '文件接入');
  });

  test('FS-02-02｜FTP/SFTP｜空文件与仅表头预览', async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;
    const temporaryFilePaths: string[] = [];
    const cleanupErrors: unknown[] = [];

    // 短文件名（唯一性保留）：后端按 "<原始文件名>_csv_<13位毫秒>" 生成 file_table_name
    // 落库 df_file_upload_task（实测容量 42~46 字符：42 字符记录成功，47/62 字符
    // 触发 Data too long）。原 codex_fs02_<scenario>_<ts36>_<uuid8>.csv 基名 37/44 字符，
    // 落库后 55/62 字符超列长，仅表头上传被后端拒绝（code=111111）。
    // 缩短为 c2<场景><ts36><uuid8>.csv（23 字符，落库 41 字符），时间戳+UUID 仍保证唯一。
    async function createTemporaryCopy(sourcePath: string, scenario: string): Promise<string> {
      const runId = `${Date.now().toString(36)}${uuid()}`;
      const temporaryPath = path.join(tmpdir(), `c2${scenario}${runId}.csv`);
      await copyFile(sourcePath, temporaryPath);
      temporaryFilePaths.push(temporaryPath);
      return temporaryPath;
    }

    try {
      const emptyUploadResponsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST'
          && /\/file-datasource\/upload(?:\?|$)/i.test(response.url()),
        { timeout: 30_000 },
      );
      await prepareUploadedFile(
        page,
        await createTemporaryCopy(EMPTY_CSV_SOURCE, 'e'),
      );
      const emptyUploadResponse = await emptyUploadResponsePromise;
      const emptyUploadPayload = await emptyUploadResponse
        .json()
        .catch(() => undefined) as { code?: string; message?: string } | undefined;
      expect(emptyUploadResponse.ok()).toBe(true);
      expect(emptyUploadPayload?.code).toBe('111111');
      expect(emptyUploadPayload?.message).toContain('文件中没有数据');

      // 后端契约（CsvFileProcessorBizImpl 表头分支、UploadFileTaskDetailBizImpl#updateFileTableConfig）：
      // “首行为标题=是”时仅表头文件仍解析出表头字段（id/name/age/is_active）并返回字段分析列表；
      // “文件中没有数据”仅在上传路径（saveFileTableConfig）抛出，预览路径不抛，
      // 因此字段预览弹层不应是空态。断言对齐契约：弹层可见且表头字段可见。
      const headerOnlyUploadResponsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST'
          && /\/file-datasource\/upload(?:\?|$)/i.test(response.url()),
        { timeout: 30_000 },
      );
      await uploadInFileAccessForm(
        page,
        await createTemporaryCopy(HEADER_ONLY_CSV_SOURCE, 'h'),
      );
      const headerOnlyUploadResponse = await headerOnlyUploadResponsePromise;
      const headerOnlyUploadPayload = await headerOnlyUploadResponse
        .json()
        .catch(() => undefined) as { code?: string; message?: string } | undefined;
      expect(headerOnlyUploadResponse.ok()).toBe(true);
      expect(
        headerOnlyUploadPayload?.code,
        '仅表头 CSV 上传契约：表头行应解析为非空字段列表，上传不应被拒绝',
      ).not.toBe('111111');

      await previewUploadedFile(page);
      const previewDialog = page
        .locator('[role="dialog"]:visible, .ant-modal-wrap:visible, .ant-modal:visible, .el-dialog:visible')
        .last();
      await expect(previewDialog).toBeVisible({ timeout: 15_000 });
      await expectFileAccessFeedback(
        page,
        /is_active/i,
        '仅表头文件字段预览内容（表头字段 id/name/age/is_active）',
      );

      await assertNoConsoleErrors(consoleErrors);
      await report(
        '文件接入-空文件与仅表头预览',
        true,
        '本轮唯一临时空 CSV 副本被当前上传契约拒绝（code=111111、文件中没有数据）；仅表头 CSV 按后端解析契约形成表头字段并在字段预览弹层展示；错误编码和分隔符错误未在本用例执行。',
      );
    } finally {
      for (const filePath of temporaryFilePaths) {
        await rm(filePath, { force: true }).catch((error: unknown) => cleanupErrors.push(error));
      }
    }

    if (cleanupErrors.length) {
      throw new Error(`本轮唯一临时文件回收失败：${cleanupErrors[0] instanceof Error ? cleanupErrors[0].message : String(cleanupErrors[0])}`);
    }
  });
});
