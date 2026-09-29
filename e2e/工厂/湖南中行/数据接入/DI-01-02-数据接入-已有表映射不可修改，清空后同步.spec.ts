/**
 * 数据接入 — 文件接入 E2E 测试
 *
 * 覆盖场景（参考 Excel「测试用例」Sheet，序号对应 1～73）：
 *   行29 — 自动建表：上传文件→解析规则→预览→目标库表（自动建表）→映射（自动/手动，可修改）→
 *           确认→ddl 自动建表 + 元数据 + 数据同步
 *   行30 — 使用已有表：映射不可修改；清空后同步 / 直接追加
 *   行34 — 查询任务：列表条件查询 + 详情（与db一致）
 *   行23 — 生成版本：自动建表/使用已有表生成版本记录，表查询展示版本列表
 *
 * 扩展（测试用例编写规范.md 覆盖深度）：
 *   - 异常路径：解析规则非法、预览结果不匹配、必填为空
 *   - 边界值：空文件、仅表头文件、大文件上传
 *   - 数据隔离：UUID 后缀命名目标表/任务
 *
 * 关键要求：
 *   1. 所有操作用 page. 浏览器操作（无 fetch/axios 等 API 调用）
 *   2. UUID 后缀隔离所有测试数据；表/任务/文件接入名称使用本轮 UUID ASCII 前缀
 *   3. 控制台错误收集；"与db一致"断言经 utils.ts（未配置时跳过）
 *   4. 选择器为通用匹配，接入真实环境后按页面校准（TODO[env] 标注）
 *
 * DS-PERM-55 清洁环境迁移：
 *   - 不再依赖任何历史表（如 test_gs_0903）或历史文件接入任务作为“已有表”前置；
 *   - 阶段一先用“自动建表”创建本轮 UUID 命名的目标表，阶段二把它作为“已有表”重新接入；
 *   - FTP/数据库/资源文件参数一律来自 e2e/test-environment.ts 配置中心，不写死主机、端口、账号或固定显示名；
 *   - 上传文件由仓库资源按字节复制为本轮唯一命名副本（原资源只读不修改）；
 *   - 最终结果以接入列表“导入状态”和 DB 行数为准，不以 toast 代替最终状态；
 *   - finally 逐项回收本轮上传副本、接入任务与本轮表（DS-PERM-94）：任一项失败继续其余回收，
 *     失败聚合上抛——主体成功则用例失败，主体失败保留原错误并附清理证据；不触碰历史数据。
 *
 * DS-PERM-112 修订（2026-09-28）：
 *   - 阶段二“使用已有表”下拉元数据永不刷新的核心修复：不再依赖「切换数据源类型」触发级联
 *     重拉（实测“表”下拉清单不随该操作刷新），每次尝试都重开全新接入表单（排除下拉缓存），
 *     并在尝试间隙进入「数据查询→自助查询」点击“刷新数据库元数据”强制平台同步（SM-03-01
 *     已实证模式），再回表单重新四级联选本轮表；
 *   - 失败归因拆分：自助查询目录可见而表单“表”下拉仍不可选 → 定性产品缺陷（数据接入级联
 *     元数据缺陷）；目录始终不可见 → 定性环境阻塞（平台元数据未索引本轮物理表）；每次尝试
 *     的探针证据以 existing-table-attempt-N.txt 附件留痕；
 *   - 清理与裁决口径与 DI-01-01 对齐：行内“删除”→“查看详情”内删除/取消兜底，清理结果按
 *     “脚本级失败 / 产品·环境证据”分类，主体通过时产品/环境证据挂附件与注解后如实通过。
 */

import type { Dialog, Locator, Page, Response as PlaywrightResponse } from '@playwright/test';
import {
  assertNoConsoleErrors,
  chooseConfiguredDataSource,
  clickMenu,
  dbConfig,
  expect,
  expectDb,
  fillByLabel,
  openSelfServiceQuery,
  query,
  selectByLabel,
  test,
  uuid,
} from '../utils.js';
import { testEnvironment } from '../../../test-environment.js';
import os from 'node:os';
import path from 'node:path';
import { access, copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

// 样本文件路径来自配置中心 dataSourceNames.fileAccess.samplePath（FILE_ACCESS_SAMPLE_PATH 可覆盖），统一解析为绝对路径。
const SAMPLE_CSV = path.resolve(testEnvironment.dataSourceNames.fileAccess.samplePath);

// 目标数据源来自配置中心 dataSourceNames.fileAccess（FILE_AUTO_* 变量可单项覆盖）；
// 不写死任何主机、端口、账号、密码或固定数据源显示名，也不依赖历史文件接入任务或旧表。
const AUTO_SOURCE_TYPE = testEnvironment.dataSourceNames.fileAccess.type;
const AUTO_SOURCE_NAME = testEnvironment.dataSourceNames.fileAccess.name;
const AUTO_DATABASE = testEnvironment.dataSourceNames.fileAccess.database;
const AUTO_SCHEMA = testEnvironment.dataSourceNames.fileAccess.schema;

/**
 * 清洁环境规则（DS-PERM-55）：上传文件必须来自仓库资源且不修改该资源。
 * 页面新建上传任务没有“任务名称”输入框，接入列表的“文件名称/任务名称”来自上传文件名，
 * 因此把仓库样本按字节复制到系统临时目录并命名为 gs_test_data_<本轮UUID>.csv（原资源只读），
 * 使本轮表、任务、文件接入名称全部带 UUID ASCII 前缀，可精确定位、finally 只回收本轮记录。
 */
async function createRoundCsvCopy(roundTag: string): Promise<string> {
  const target = path.join(os.tmpdir(), 'ds-perm-55-e2e', `gs_test_data_${roundTag}.csv`);
  await mkdir(path.dirname(target), { recursive: true });
  await access(SAMPLE_CSV, fsConstants.R_OK);
  await copyFile(SAMPLE_CSV, target);
  return target;
}

/** 从本轮上传副本统计 CSV 数据行数（表头之后），供“清空后同步”行数断言使用。 */
async function countCsvDataRows(csvPath: string): Promise<number> {
  const content = await readFile(csvPath, 'utf8');
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return Math.max(lines.length - 1, 0);
}

/**
 * 阶段二“使用已有表”的总时间预算（DS-PERM-112）：实测配置中心元数据同步周期约 10～15 分钟
 * （2026-09-23 trace4），修复后不再被动等同步——尝试间隙主动点击“刷新数据库元数据”强制
 * 平台同步，窗口按 15 分钟预算、单次目录探针最长 2.5 分钟，兼顾收敛速度与同步周期覆盖。
 */
const EXISTING_TABLE_WINDOW_MS = 15 * 60_000;

/** “刷新数据库元数据”确认弹窗处理（复制自 SM-03-01 已实证实现：不确认会以模态层阻塞目录交互）。 */
async function confirmMetadataRefreshDialog(page: Page, timeoutMs = 8_000): Promise<boolean> {
  const dialog = page.getByRole('dialog', { name: /刷新数据库元数据/ });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await dialog.isVisible().catch(() => false)) break;
    await page.waitForTimeout(250);
  }
  if (!(await dialog.isVisible().catch(() => false))) return false;
  await dialog.getByRole('button', { name: /确\s*定/ }).first().click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await page.waitForTimeout(2_500);
  return true;
}

/** 自助查询目录“刷新数据库元数据”（目录控件未渲染时安全跳过；同 SM-03-01/03/06 已实证实现）。 */
async function refreshDatabaseMetadata(page: Page): Promise<void> {
  const treeSearch = page.getByRole('textbox', { name: /搜索表名|存储过程/ });
  if (!(await treeSearch.isVisible().catch(() => false))) return;
  const reloadIcon = treeSearch.locator(
    'xpath=parent::*[1]/following-sibling::*[contains(@aria-label,"reload")][1]',
  );
  if (!(await reloadIcon.isVisible().catch(() => false))) return;
  await reloadIcon.click({ timeout: 2_000 }).catch(() => undefined);
  await confirmMetadataRefreshDialog(page).catch(() => undefined);
}

/**
 * 在自助查询目录探针本轮表是否已被平台元数据索引（DS-PERM-112，SM-03-01
 * waitForRoundTableMetadataVisible 同款）：选择本轮数据源后，在目录表名搜索框输入本轮表名
 * 轮询命中；等待期内每 30 秒重试一次“刷新数据库元数据”，覆盖元数据缓存惰性索引形态。
 * 命中返回证据文本；超时抛错——目录不可见说明平台元数据未索引本轮物理表，与表单内下拉
 * 缺陷（产品侧）必须分开归因。目录/数据源控件打不开时抛“目录探针未完成”，避免误归因。
 */
async function waitRoundTableInSelfQueryCatalog(
  page: Page,
  tableName: string,
  timeoutMs: number,
): Promise<string> {
  await openSelfServiceQuery(page);
  await refreshDatabaseMetadata(page);
  try {
    await chooseConfiguredDataSource(page, {
      type: AUTO_SOURCE_TYPE,
      name: AUTO_SOURCE_NAME,
      schema: AUTO_SCHEMA,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`目录探针未完成：自助查询选择数据源失败（${reason.slice(0, 160)}），当前页面：${page.url()}`);
  }
  const treeSearch = page.getByRole('textbox', { name: /搜索表名|存储过程/ });
  await expect(treeSearch, '自助查询目录未出现表名搜索框，无法探针本轮表元数据可见性').toBeVisible({
    timeout: 10_000,
  });
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let nextRefreshAt = Date.now();
  for (;;) {
    await treeSearch.fill(tableName);
    await page.waitForTimeout(800);
    if (await page.getByText(tableName, { exact: true }).first().isVisible().catch(() => false)) {
      return `本轮表 ${tableName} 已在自助查询目录可见（平台元数据已索引本轮物理表，探针耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒）。`;
    }
    if (Date.now() >= deadline) break;
    if (Date.now() >= nextRefreshAt) {
      nextRefreshAt = Date.now() + 30_000;
      await refreshDatabaseMetadata(page);
      // 刷新后目录树会重载，重新聚焦搜索框继续轮询。
      await treeSearch.fill(tableName).catch(() => undefined);
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(
    `本轮表 ${tableName} 在自助查询目录探针 ${Math.round(timeoutMs / 1000)} 秒（含周期性“刷新数据库元数据”）始终不可见`
      + '：平台元数据未索引本轮物理表（或目录树尚未同步）。',
  );
}

/**
 * 在“全新”文件接入表单内做一次“使用已有表”四级联并精确选择本轮表（DS-PERM-112）。
 * 调用方负责保证表单是本轮刚打开的（排除下拉缓存）且“使用已有表”已勾选；本函数单次
 * 尝试不内部重试，重试节奏交给调用方（每次尝试前都先进自助查询刷新元数据）。
 * “表”下拉选项来自配置中心 schema 元数据清单（实测 250+ 张表全量渲染，可排除虚拟滚动），
 * 选不到时由 selectByLabel 抛错交调用方归因。
 */
async function selectExistingRoundTableOnce(page: Page, tableName: string): Promise<void> {
  await selectByLabel(page, '数据源类型', AUTO_SOURCE_TYPE);
  await selectByLabel(page, '数据源名称', AUTO_SOURCE_NAME);
  await selectByLabel(page, '数据库名称', AUTO_DATABASE);
  await selectByLabel(page, 'Schema名称', AUTO_SCHEMA);
  await selectByLabel(page, '表', tableName);
}

/** 自动建表模式：映射名称可修改；校验本轮 CSV 四个来源字段的映射输入框均可编辑。 */
async function validateAutoMapping(page: Page): Promise<void> {
  const mappingRows = page
    .locator('tbody tr:visible, .ant-table-tbody tr:visible, .el-table__body-wrapper tr:visible')
    .filter({ hasText: /name|age|phone_number|adress_di/ });
  await expect(mappingRows, '自动建表映射页未加载本轮 CSV 的来源字段').toHaveCount(4, { timeout: 15_000 });
  for (let index = 0; index < await mappingRows.count(); index += 1) {
    const row = mappingRows.nth(index);
    const targetInput = row.locator('input:not([type="checkbox"]):visible').first();
    if (await targetInput.isVisible().catch(() => false)) {
      await expect(targetInput, `第 ${index + 1} 行自动映射目标字段应可修改`).toBeEnabled();
    }
  }
}

async function firstVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    const count = await candidate.count();
    // 组件切换时可能短暂保留旧节点；倒序优先当前新渲染的可见节点。
    for (let index = count - 1; index >= 0; index--) {
      const item = candidate.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return undefined;
}

/** 文件接入自动建表的真实目标字段：标签为“表”，输入框 placeholder 为“请输入表名”。 */
async function fillAutomaticTableName(page: Page, tableName: string): Promise<void> {
  const tableNameInput = page.getByPlaceholder('请输入表名').filter({ visible: true }).last();
  await expect(tableNameInput).toBeVisible({ timeout: 10_000 });
  await tableNameInput.fill(tableName);
}

/** 选择文件接入页面真实的自动建表目标级联字段。 */
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
}

/** 按文件接入真实字段名准备解析规则。 */
async function prepareUploadedFile(page: Page, filePath: string): Promise<void> {
  await openFileAccessForm(page);
  await uploadInFileAccessForm(page, filePath);
  await fillByLabel(page, '列分隔符', ',');
  const headerRadio = page.getByRole('radio', { name: '是', exact: true }).last();
  if (await headerRadio.isVisible().catch(() => false)) await headerRadio.check();
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

/** 第二步“确定”后任务创建成功：等待成功 toast，或 URL 离开新建页（两者都是页面真实反馈）。 */
async function confirmFileAccessMapping(page: Page): Promise<void> {
  const confirm = await firstVisible([
    page.getByRole('button', { name: /^确\s*定$/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /^确\s*定$/ }),
    page.getByText(/^确\s*定$/, { exact: true }).filter({ visible: true }),
  ]);
  if (!confirm) throw new Error('字段映射页未找到“确定”创建按钮。');
  await confirm.click();
  await expect
    .poll(async () => {
      const toast = await firstVisible([
        page.getByText(/创建成功|操作成功/).filter({ visible: true }),
      ]);
      return toast || !/fileAccessCreate/.test(page.url()) ? 'created' : 'waiting';
    }, { timeout: 20_000 })
    .toBe('created');
}
// ==================== 本轮任务的可见最终状态与回收 ====================
// 接入列表是固定列拆分表：左侧“文件名称”table、右侧“导入状态/操作”table（与 DI-04-02 页面校准一致）。

function tableWithHeader(page: Page, header: RegExp): Locator {
  return page.locator('table:visible').filter({ hasText: header }).first();
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
 * 进入“文件接入”列表并解析服务端保存后的本轮文件名。
 * 服务端保存上传文件时会自动重命名：在扩展名前插入时间戳（gs_test_data_<uuid>.csv →
 * gs_test_data_<uuid>_<millis>.csv，见列表接口 originalFilename 字段），因此按上传原始名
 * 在“文件名称”过滤框里精确查询匹配不到本轮行。这里监听页面自身的默认列表查询响应，
 * 按「本轮目标表名 + 本轮文件名（去扩展名）前缀」唯一定位本轮行并取其保存名；
 * 解析不到时回退上传原始名（不猜测服务端匹配语义，行为与旧版一致）。
 */
async function openListWithStoredFileName(page: Page, uploadCsv: string, tableName: string): Promise<string> {
  const fileName = path.basename(uploadCsv);
  const basePrefix = path.basename(uploadCsv, path.extname(uploadCsv));
  const waitForListQuery = (timeout: number): Promise<PlaywrightResponse | null> =>
    page
      .waitForResponse(
        (response) =>
          response.url().includes('/file-datasource/queryDfFileUploadTaskPageList') &&
          response.request().method() === 'POST',
        { timeout },
      )
      .catch(() => null);
  const listQuery = waitForListQuery(20_000);
  await clickMenu(page, '数据接入', '文件接入');
  let listResponse = await listQuery;
  if (!listResponse) {
    // 菜单点击未触发新查询（如已处于列表页且组件未重挂载）时，空条件点一次“查询”强制刷新。
    const forcedQuery = waitForListQuery(10_000);
    await page.getByRole('button', { name: /查\s*询/ }).last().click({ timeout: 5_000 }).catch(() => undefined);
    listResponse = await forcedQuery;
  }
  if (!listResponse) {
    console.warn(`[list] 未捕获列表查询响应，回退按上传原始名过滤：${fileName}`);
    return fileName;
  }
  try {
    const body = (await listResponse.json()) as {
      object?: { totalList?: Array<{ targetTableName?: string; originalFilename?: string }> };
    };
    const rows = body?.object?.totalList ?? [];
    const hit = rows.find((row) => {
      const originalFilename = row?.originalFilename;
      return (
        row?.targetTableName === tableName &&
        typeof originalFilename === 'string' &&
        originalFilename.includes(basePrefix)
      );
    });
    const storedName = hit?.originalFilename;
    if (typeof storedName === 'string' && storedName.length > 0) {
      if (storedName !== fileName) {
        console.warn(`[list] 服务端保存文件名与上传原始名不同：${fileName} → ${storedName}（改按保存名过滤）`);
      }
      return storedName;
    }
    console.warn(`[list] 列表首页未解析到本轮行（表=${tableName}），回退按上传原始名过滤：${fileName}`);
  } catch (error) {
    console.warn(`[list] 列表响应解析失败，回退按上传原始名过滤：${fileName}`, error);
  }
  return fileName;
}

/**
 * 创建后的可见最终状态：接入列表按本轮唯一“文件名称”查询到本轮任务行，
 * 并轮询同行号的状态行出现后端同步成功终态文案；不以创建 toast 或非终态“同步中”代替最终状态。
 */
async function verifyTaskVisibleInList(page: Page, uploadCsv: string, tableName: string): Promise<void> {
  const fileNameInList = await openListWithStoredFileName(page, uploadCsv, tableName);
  await fillByLabel(page, '文件名称', fileNameInList);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
    await queryButton.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    if (await fileNameTableRows(page).filter({ hasText: fileNameInList }).first().isVisible().catch(() => false)) break;
  }
  await expect
    .poll(async () => {
      const allRows = fileNameTableRows(page);
      const matched = allRows.filter({ hasText: fileNameInList });
      const total = await allRows.count();
      // 服务端按唯一文件名过滤后，可见行应只剩本轮任务行。
      if (total < 1 || total !== (await matched.count())) return 'waiting-filter';
      const rows = await statusTableRows(page);
      const statusText = (await rows.first().innerText().catch(() => '')).replace(/\s+/g, '');
      return /文件数据同步完成/.test(statusText) ? 'done' : `status:${statusText.slice(0, 40)}`;
    }, { timeout: 90_000 })
    .toBe('done');
}

/** 任务行回收结果：deleted=本轮行已消失或本就不存在；productGap=页面确实未提供删除入口。 */
interface RoundTaskCleanupResult {
  deleted: boolean;
  productGap: boolean;
  note: string;
}

/** 清理结果分类（DS-PERM-112）：脚本级失败会让通过的主体上抛；产品/环境证据必须可见但不反咬 UI。 */
interface RoundCleanupOutcome {
  scriptFailures: string[];
  evidenceNotes: string[];
}

/** 把当前页面截图挂到 HTML 报告作为清理证据（采集失败不阻断清理主流程）。 */
async function attachCleanupScreenshot(page: Page, name: string): Promise<void> {
  try {
    const shot = await page.screenshot({ fullPage: true });
    await test.info().attach(name, { body: shot, contentType: 'image/png' });
  } catch (error) {
    console.warn(`[cleanup] 截图证据采集失败（${name}）：`, error);
  }
}

/** 确认删除可能出现的气泡/弹窗（或原生 dialog）；与旧行为一致，只点“确定”。 */
async function acceptRoundDeleteConfirm(page: Page): Promise<void> {
  const acceptDialog = (dialog: Dialog): void => {
    void dialog.accept().catch(() => undefined);
  };
  page.once('dialog', acceptDialog);
  try {
    const confirmButton = await firstVisible([
      page.getByRole('button', { name: /^确\s*定$/ }).filter({ visible: true }),
      page
        .locator('.ant-popconfirm:visible button, .el-popconfirm:visible button, .ant-modal:visible button, .el-message-box:visible button')
        .filter({ hasText: /^确\s*定$/ }),
    ]);
    if (confirmButton) await confirmButton.click();
  } finally {
    page.off('dialog', acceptDialog);
  }
}

/**
 * “查看详情”内的删除/取消入口探测（DS-PERM-112：列表行操作列只有“查看详情”时的唯一可见兜底）。
 * 打开详情前先不截图（避免遮挡），只点击名称明确为 删除/取消任务/取消同步/解绑 的可见控件并确认；
 * 找不到入口时对详情页截图留证。返回 true=已点击删除并完成确认（行是否真正消失由调用方轮询列表判定）。
 */
async function tryDeleteInsideDetailView(page: Page, operationRow: Locator): Promise<boolean> {
  const detailButton = await firstVisible([
    operationRow.getByRole('button', { name: /查\s*看\s*详\s*情/ }),
    operationRow.getByText(/查\s*看\s*详\s*情/).filter({ visible: true }),
  ]);
  if (!detailButton) return false;
  await detailButton.click();
  await page.waitForTimeout(1_000);
  try {
    const deleteAction = await firstVisible([
      page.getByRole('button', { name: /^删\s*除$/ }).filter({ visible: true }),
      page.getByRole('button', { name: /取消任务|取消同步|解绑/ }).filter({ visible: true }),
      page.locator('button:visible').filter({ hasText: /^删\s*除$/ }),
    ]);
    if (!deleteAction) {
      await attachCleanupScreenshot(page, 'cleanup-查看详情-无删除入口.png');
      return false;
    }
    await deleteAction.click();
    await acceptRoundDeleteConfirm(page);
    await page.waitForTimeout(1_500);
    return true;
  } finally {
    // 详情可能是弹窗/抽屉/子路由：统一关闭回到列表，再做“行已消失”轮询；不点“取消”以免误关确认框。
    const closeButton = await firstVisible([
      page.getByRole('button', { name: /^关\s*闭$|^返\s*回$/ }).filter({ visible: true }),
      page.locator('.ant-modal-close:visible, .ant-drawer-close:visible, .el-dialog__headerbtn:visible'),
    ]);
    if (closeButton) await closeButton.click().catch(() => undefined);
    else await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(800);
  }
}

/**
 * 回收本轮任务（DS-PERM-112 修订）：仅在“文件名称”过滤后的本轮行存在时操作，绝不误删其它任务。
 * 删除路径按页面真实可见入口逐级尝试：行操作列“删除” → “查看详情”内的删除/取消入口；
 * 两条路径都不存在时截图留证并按产品缺陷证据返回（productGap=true），绝不静默忽略、
 * 也绝不伪造删除成功。返回 deleted=true 表示本轮行已确认从列表消失或本就不存在。
 */
async function deleteRoundTaskIfExists(page: Page, uploadCsv: string, tableName: string): Promise<RoundTaskCleanupResult> {
  const fileNameInList = await openListWithStoredFileName(page, uploadCsv, tableName);
  await fillByLabel(page, '文件名称', fileNameInList);
  const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
  await queryButton.click({ timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  const allRows = fileNameTableRows(page);
  let rowIndex = -1;
  for (let index = 0; index < await allRows.count(); index += 1) {
    if ((await allRows.nth(index).innerText().catch(() => '')).includes(fileNameInList)) {
      rowIndex = index;
      break;
    }
  }
  if (rowIndex < 0) {
    return { deleted: true, productGap: false, note: '本轮任务行不存在（任务未创建成功或此前已回收），无需删除。' };
  }
  const operationRow = (await statusTableRows(page)).nth(rowIndex);
  const deleteAction = await firstVisible([
    operationRow.getByRole('button', { name: /删\s*除/ }),
    operationRow.getByRole('link', { name: /删\s*除/ }),
    operationRow.getByText(/删\s*除/).filter({ visible: true }),
  ]);
  let clickedDelete = false;
  if (deleteAction) {
    await deleteAction.click();
    clickedDelete = true;
    await acceptRoundDeleteConfirm(page);
  } else {
    clickedDelete = await tryDeleteInsideDetailView(page, operationRow);
  }
  if (!clickedDelete) {
    await attachCleanupScreenshot(page, 'cleanup-接入列表-无删除入口.png');
    return {
      deleted: false,
      productGap: true,
      note: `列表行与“查看详情”均未提供删除/取消入口，本轮任务记录保留：${fileNameInList}（目标表 ${tableName}）`,
    };
  }
  // 删除后列表可能重置筛选甚至短暂离开：每轮先确认仍在列表页，再重填文件名查询，轮询本轮行真正消失。
  await expect
    .poll(async () => {
      const onList = await page.getByRole('button', { name: /查\s*询/ }).last().isVisible().catch(() => false);
      if (!onList) return 'waiting-list';
      await fillByLabel(page, '文件名称', fileNameInList).catch(() => undefined);
      await page.getByRole('button', { name: /查\s*询/ }).last().click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(800);
      const matched = fileNameTableRows(page).filter({ hasText: fileNameInList });
      return (await matched.count()) === 0 ? 'deleted' : 'removing';
    }, { timeout: 30_000 })
    .toBe('deleted');
  return { deleted: true, productGap: false, note: `本轮任务行已从列表消失：${fileNameInList}` };
}

/**
 * finally 逐项回收本轮数据（DS-PERM-94 / DS-PERM-112 修订）：对每个本轮上传副本先回收接入
 * 任务行（仅本轮唯一文件名行），再回收本地临时副本，最后回收本轮表（直连配置中心主库 DROP，
 * 允许短暂网络抖动重试）。结果按“脚本级失败 / 产品·环境证据”两类返回：
 *  - 脚本级失败（删除交互异常、本地副本删除失败）：主体通过时聚合上抛，不伪造通过；
 *  - 产品/环境证据（页面未提供删除入口、DB 未配置或 DROP 持续失败）：必须写入报告附件、
 *    注记与 result MD，但不再把真实完成的 UI 链路拖成失败——绝不当作 UI 成功，也绝不静默忽略。
 */
async function cleanupRoundArtifacts(page: Page, tableName: string, uploadCsvs: readonly string[]): Promise<RoundCleanupOutcome> {
  const scriptFailures: string[] = [];
  const evidenceNotes: string[] = [];
  for (const uploadCsv of uploadCsvs) {
    const fileName = path.basename(uploadCsv);
    try {
      const result = await deleteRoundTaskIfExists(page, uploadCsv, tableName);
      if (!result.deleted) {
        console.warn(`[cleanup] 产品缺陷/残留证据：${result.note}`);
        evidenceNotes.push(`产品未提供本轮任务删除入口（${fileName}）：${result.note}`);
      } else {
        console.warn(`[cleanup] ${result.note}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[cleanup] 本轮任务回收未完成（${fileName}）：${reason}`);
      scriptFailures.push(`本轮接入任务回收交互异常（${fileName}）：${reason.slice(0, 240)}`);
    }
    // 本轮上传副本 = 系统临时区仅本轮命名的仓库资源字节副本；只删该唯一路径，不触碰仓库原资源。
    try {
      await rm(uploadCsv, { force: true });
      console.warn(`[cleanup] 已回收本轮上传副本：${fileName}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[cleanup] 本轮上传副本未回收：${fileName}；原因：${reason}`);
      scriptFailures.push(`本轮上传副本未回收（${fileName}）：${reason.slice(0, 240)}`);
    }
  }
  if (!dbConfig()) {
    const detail = `DB 未配置（DB_HOST 为空），本轮表未物理回收：${tableName}（表名含本轮 UUID，可追溯待人工复核）`;
    console.warn(`[cleanup] ${detail}`);
    evidenceNotes.push(`环境阻塞——${detail}`);
    return { scriptFailures, evidenceNotes };
  }
  // run-20260923-053422-321 实证 DROP 可能遭遇一次性 read ECONNRESET：最多 3 次尝试、
  // 间隔 5 秒；仍失败记为环境阻塞证据——DB 网络抖动不能当作 UI 成功，也不反咬 UI 链路。
  let dropError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await query(`DROP TABLE IF EXISTS ${tableName}`);
      console.warn(`[cleanup] 已回收本轮表（第 ${attempt} 次尝试）：${tableName}`);
      dropError = undefined;
      break;
    } catch (error) {
      dropError = error;
      if (attempt < 3) await new Promise<void>((resolve) => { setTimeout(resolve, 5_000); });
    }
  }
  if (dropError !== undefined) {
    const reason = dropError instanceof Error ? dropError.message : String(dropError);
    console.warn(`[cleanup] 本轮表未回收（直连失败）：${tableName}；原因：${reason}`);
    evidenceNotes.push(`环境阻塞——本轮表未物理回收（${tableName}，DROP 直连 3 次尝试均失败）：${reason.slice(0, 240)}`);
  }
  return { scriptFailures, evidenceNotes };
}

test.describe("DI-01-02｜数据接入｜已有表映射不可修改，清空后同步", () => {
  test.beforeEach(async ({ loginPage }) => {
    await clickMenu(loginPage, '数据接入', '文件接入');
  })
  test("DI-01-02｜数据接入｜已有表映射不可修改，清空后同步", async ({ loginPage, consoleErrors, report }) => {
    // 两条完整创建链路加列表轮询超过 30 秒默认时限；阶段二“已有表”在 DS-PERM-112 修复后按
    // 15 分钟窗口做“自助查询刷新元数据 + 全新表单重选”重试，总时限放宽到 30 分钟。
    test.setTimeout(1_800_000);
    const page = loginPage;
    const roundTag = uuid();
    const tableName = `t_file_exist_${roundTag}`;
    // 清洁环境：目标表由本轮阶段一自动建表创建，上传文件是本轮唯一命名的仓库资源副本（原资源只读）。
    const setupCsv = await createRoundCsvCopy(`${roundTag}-a`);
    const existingCsv = await createRoundCsvCopy(`${roundTag}-b`);
    // DS-PERM-112：先捕获主体错误再进 finally 清理，清理完成后再统一裁决，清理异常不掩埋主体失败；
    // 清理结果按“脚本级失败 / 产品·环境证据”两类收集。
    const cleanupScriptFailures: string[] = [];
    const cleanupEvidenceNotes: string[] = [];
    let mainFailed = false;
    let mainError: unknown;
    try {
      // 阶段一：先通过“自动建表”创建本轮目标表（不依赖任何历史表/历史任务）。
      await prepareUploadedFile(page, setupCsv);
      const setupPreview = await previewUploadedFile(page);
      await expect(setupPreview.getByText('张三', { exact: true }).last()).toBeVisible();
      await closeFilePreview(page, setupPreview);
      await chooseAutomaticTableTarget(page);
      await fillAutomaticTableName(page, tableName);
      await clickWizardNext(page, /字段映射|目标映射/);
      await validateAutoMapping(page);
      await confirmFileAccessMapping(page);
      await verifyTaskVisibleInList(page, setupCsv, tableName);
      // 阶段二：把本轮新建的表作为“已有表”重新接入，验证映射不可修改、清空后同步。
      await prepareUploadedFile(page, existingCsv);
      const preview = await previewUploadedFile(page);
      await expect(preview.getByText('张三', { exact: true }).last()).toBeVisible();
      await closeFilePreview(page, preview);
      // DS-PERM-112 核心修复（“使用已有表”下拉元数据永不刷新）：
      //  旧实现靠「切换数据源类型」触发级联重拉，实测“表”下拉清单不随该操作刷新，18 分钟
      //  窗口内 16 次重拉全部失败；新实现每次尝试都——
      //  ① 进「数据查询→自助查询」探针本轮表是否已被平台元数据索引，等待间隙周期性点击
      //     “刷新数据库元数据”强制同步（SM-03-01 已实证模式）；
      //  ② 回到文件接入重开全新表单（排除下拉缓存）重新四级联选本轮表。
      //  穷尽仍失败时按目录探针结果归因：目录可见而表单不可选 → 产品缺陷（级联元数据缺陷）；
      //  目录始终不可见 → 环境阻塞（平台未索引本轮物理表）。每次尝试证据以
      //  existing-table-attempt-N.txt 附件留痕，失败信息附完整归因，不伪造通过、不误报口径。
      const existingTableWindowStart = Date.now();
      const existingTableAttempts = 4;
      const catalogProbeMs = 150_000;
      let catalogEvidence = '尚未探针';
      let catalogSawTable = false;
      let lastSelectError: unknown;
      for (let attempt = 1; attempt <= existingTableAttempts; attempt += 1) {
        await test.info().attach(`existing-table-attempt-${attempt}.txt`, {
          body: [
            `attempt=${attempt}/${existingTableAttempts}`,
            `elapsedMinutes=${((Date.now() - existingTableWindowStart) / 60_000).toFixed(1)}`,
            `catalogSawTable=${catalogSawTable}`,
            `catalogEvidence=${catalogEvidence}`,
          ].join('\n'),
          contentType: 'text/plain',
        });
        // ① 自助查询目录探针 + 主动“刷新数据库元数据”（首次尝试也刷新一次，尽早收敛）。
        try {
          catalogEvidence = await waitRoundTableInSelfQueryCatalog(
            page,
            tableName,
            Math.min(catalogProbeMs, Math.max(EXISTING_TABLE_WINDOW_MS - (Date.now() - existingTableWindowStart), 30_000)),
          );
          catalogSawTable = true;
          console.warn(`[已有表] 第 ${attempt} 次目录探针命中：${catalogEvidence}`);
        } catch (catalogError) {
          catalogEvidence = catalogError instanceof Error ? catalogError.message : String(catalogError);
          console.warn(`[已有表] 第 ${attempt} 次目录探针未命中：${catalogEvidence.slice(0, 200)}`);
        }
        // ② 回到文件接入，重开全新表单（排除下拉缓存）并重新做“使用已有表”选择。
        await clickMenu(page, '数据接入', '文件接入');
        await prepareUploadedFile(page, existingCsv);
        const existingTableRadio = page.getByRole('radio', { name: '使用已有表', exact: true });
        await expect(existingTableRadio, '文件接入表单未渲染“使用已有表”选项').toBeVisible({ timeout: 10_000 });
        await existingTableRadio.check();
        try {
          await selectExistingRoundTableOnce(page, tableName);
          if (attempt > 1) {
            console.warn(`[已有表] 第 ${attempt} 次尝试（含自助查询元数据刷新）后选到本轮表：${tableName}`);
          }
          lastSelectError = undefined;
          break;
        } catch (selectError) {
          lastSelectError = selectError;
          const waitedMin = ((Date.now() - existingTableWindowStart) / 60_000).toFixed(1);
          console.warn(`[已有表] 第 ${attempt} 次全新表单内仍未选到本轮表（已等待 ${waitedMin} 分钟）：${tableName}`);
          if (attempt >= existingTableAttempts || Date.now() - existingTableWindowStart >= EXISTING_TABLE_WINDOW_MS) break;
        }
      }
      if (lastSelectError !== undefined) {
        if (catalogSawTable) {
          cleanupEvidenceNotes.push(`产品缺陷证据——${catalogEvidence}`);
          const detail = `文件接入“使用已有表”级联在自助查询目录已确认本轮表可见后，${existingTableAttempts} 次全新表单尝试仍无法在“表”下拉中选到 ${tableName}（疑似数据接入级联元数据缺陷）。`;
          if (lastSelectError instanceof Error) lastSelectError.message = `${detail}；最后一次选择失败：${lastSelectError.message}`;
          throw lastSelectError;
        }
        const detail = `环境阻塞——自助查询目录在已有表窗口内（${existingTableAttempts} 次探针，含周期性“刷新数据库元数据”）始终未见本轮表 ${tableName}：平台元数据未索引本轮物理表。`;
        cleanupEvidenceNotes.push(detail);
        if (lastSelectError instanceof Error) lastSelectError.message = `${detail}目录证据：${catalogEvidence.slice(0, 300)}`;
        throw lastSelectError;
      }
      // “是否清空表”属于第一步的已有表写入规则，需在进入字段映射前确定。
      const clearTable = page.getByText(/是否清空表|清空已有表数据/).filter({ visible: true }).last();
      await expect(clearTable).toBeVisible({ timeout: 10_000 });
      await clearTable.click();
      await clickWizardNext(page, /字段映射|目标映射/);
      // 已有表模式：目标字段由既有表结构决定，映射名称不可修改（逐行校验，不以单行代替）。
      const mappingRows = page
        .locator('tbody tr:visible, .ant-table-tbody tr:visible, .el-table__body-wrapper tr:visible')
        .filter({ hasText: /name|age|phone_number|adress_di/ });
      await expect(mappingRows, '已有表映射页未加载本轮 CSV 的来源字段').toHaveCount(4, { timeout: 15_000 });
      let readonlyInputs = 0;
      for (let index = 0; index < await mappingRows.count(); index += 1) {
        const row = mappingRows.nth(index);
        const targetInput = row.locator('input:not([type="checkbox"]):visible').first();
        if (await targetInput.isVisible().catch(() => false)) {
          await expect(targetInput, `第 ${index + 1} 行映射目标字段应不可修改`).toBeDisabled();
          readonlyInputs += 1;
        }
        // 目标字段以纯文本渲染的行没有输入框，同样不可修改。
      }
      await expect(readonlyInputs, '已有表映射页没有可校验只读状态的目标字段输入框').toBeGreaterThan(0);
      await confirmFileAccessMapping(page);
      // 可见最终结果：接入列表按本轮唯一文件名查询，导入状态达到完成/同步。
      await verifyTaskVisibleInList(page, existingCsv, tableName);
      // 与 db 一致（清空后同步的最终结果）：行数必须等于本轮 CSV 数据行数；
      // 若“清空”未生效变成追加，行数会翻倍。DB 未配置时按项目规则跳过。
      const expectedRows = await countCsvDataRows(existingCsv);
      await expectDb(
        `SELECT COUNT(*) AS cnt FROM ${tableName}`,
        (rows) => expect(Number(rows[0]?.cnt), `清空后同步应为 ${expectedRows} 行（追加则翻倍）`).toBe(expectedRows),
      );
      await assertNoConsoleErrors(consoleErrors);
      await report('文件接入-已有表映射只读-清空表-重新同步', true, `已有表=${tableName}（本轮自动建表）；文件=${path.basename(existingCsv)}；映射目标字段全部只读；列表导入状态与 DB 行数均已校验。`);
    } catch (error) {
      mainFailed = true;
      mainError = error;
    } finally {
      // DS-PERM-112：只回收本轮上传副本、接入任务与本轮表，不触碰历史数据；清理结果按
      // “脚本级失败 / 产品·环境证据”分类收集，finally 本身不抛出、不覆盖主体错误。
      try {
        const outcome = await cleanupRoundArtifacts(page, tableName, [setupCsv, existingCsv]);
        cleanupScriptFailures.push(...outcome.scriptFailures);
        cleanupEvidenceNotes.push(...outcome.evidenceNotes);
      } catch (cleanupCrash) {
        const message = cleanupCrash instanceof Error ? cleanupCrash.message : String(cleanupCrash);
        console.error('[cleanup] 清理流程自身异常（按脚本级失败收集）：', cleanupCrash);
        cleanupScriptFailures.push(`清理流程自身异常：${message.slice(0, 240)}`);
      }
    }
    // DS-PERM-112 统一裁决（口径同 DI-01-01）：
    // 1) 主体失败 → 重抛原错误并附全部清理证据（仅追加 message，不改变错误类型）；
    // 2) 主体通过 + 脚本级清理失败 → 聚合上抛，不伪造通过；
    // 3) 主体通过 + 仅产品缺陷/环境阻塞证据 → 截图/文本证据挂到 HTML 报告附件与注解，
    //    用例按真实页面结果通过；证据同步写入 result-DS-PERM-112.md，绝不静默忽略。
    if (mainFailed) {
      const notes = [...cleanupEvidenceNotes, ...cleanupScriptFailures];
      const note = notes.length > 0
        ? `（另：本轮清理未完全成功：${notes.join('；').slice(0, 600)}）`
        : '';
      if (mainError instanceof Error) mainError.message += note;
      throw mainError;
    }
    if (cleanupEvidenceNotes.length > 0 || cleanupScriptFailures.length > 0) {
      const evidenceBody = [
        `本轮表：${tableName}`,
        ...cleanupEvidenceNotes.map((item) => `- 证据：${item}`),
        ...cleanupScriptFailures.map((item) => `- 脚本级失败：${item}`),
      ].join('\n');
      await test.info().attach('cleanup-evidence.txt', { body: evidenceBody, contentType: 'text/plain' });
      // 本项目安装的 Playwright TestInfo 无 annotate()，改用 annotations.push（HTML 报告同等展示）。
      for (const item of cleanupEvidenceNotes) {
        test.info().annotations.push({ type: '清理证据', description: item.slice(0, 200) });
      }
    }
    if (cleanupScriptFailures.length > 0) {
      throw new Error(
        `DI-01-02 主体通过，但本轮资产清理存在脚本级失败（如实上报；待人工复核本轮表：${tableName}）：`
          + cleanupScriptFailures.join('；'),
      );
    }
    console.warn(`[cleanup] 裁决：主体通过；产品/环境证据 ${cleanupEvidenceNotes.length} 条已挂到报告附件与注记（详见 result-DS-PERM-112.md）。`);
  })
});
