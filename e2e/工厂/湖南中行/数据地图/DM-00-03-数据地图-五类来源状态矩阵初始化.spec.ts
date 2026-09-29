/**
 * DM-00-03｜数据地图｜五类来源×四类状态矩阵初始化夹具（DM-01-01 前置）
 *
 * 任务：DS-PERM-52（temp/公司模型任务/20260922-数据源管理权限静态开发）。
 * 目标：为「表管理」页四类状态标签（物理表存在 / 物理表存在&上线 /
 *       物理表存在&下线 / 草稿）按来源准备可被 DM-01-01 消费的测试表，
 *       并把结果增量落盘为状态工件（temp/dm-matrix/fixture-state.json）。
 *
 * 五类来源的业务落点（均复用既有已跑通链路，不在本用例发明新路由）：
 * - 自行建表：数据地图→表管理→新建表→MySQL 下拉→DDL 解析→建表（DM-00-01/DM-02-01）。
 *   建表成功默认落「物理表存在&下线」（DM-02-01 页面实证）；只点「保存」不点
 *   「建表」即得到「草稿」。
 * - 数据集成：数据接入→数据集成→创建任务→单表同步→自动建表（DI-05-01 链路）。
 * - 文件接入：数据接入→文件接入→新建接入→上传 CSV→解析→自动建表
 *   （复用 文件接入来源表工具.createFileAccessSourceTable）。
 * - FTP文件接入：数据接入→ftp文件接入→接入列表→新建接入→协议 ftp
 *   （FTP profile 默认 113:2121 基线，gs_test_YYYYMMDD 日期文件已预置；
 *   流程参照 E2E夹具-110环境FTP接入任务迁移 的成熟步骤）。
 * - 数据采集：当前代码库与页面均无自动化建表入口（全库仅表管理来源筛选出现
 *   该词），按环境基线属元数据/人工接入范畴 → 如实记录前置缺口；人工准备好的
 *   表名经 DM_MATRIX_COLLECT_TABLES 注入后仅在表管理校验存在性，不伪造。
 *
 * 状态编排约定：每个可自动初始化来源建 3 张表——
 *   <runId>_ex 只建表（默认落点）、<runId>_on 建表后上线、
 *   <runId>_off 建表→上线→下线；自行建表额外建 <runId>_df（草稿）。
 * 纯「物理表存在」（未上线下线）标签在四条自动路线下的默认落点实测均为
 * 「物理表存在&下线」，疑似仅数据采集类元数据可达：作为缺口如实记录，不伪装。
 *
 * 运行：headed + 串行（npx playwright test 本文件 --project=chromium --workers=1）。
 * 工件：temp/dm-matrix/fixture-state.json（DM_MATRIX_STATE 可覆盖路径），
 *       每个来源完成即增量写入，失败也保留已完成部分供 DM-01-01 消费。
 * 环境变量：
 * - DM_MATRIX_FTP_DATE_OFFSET：FTP 日期文件偏移（默认 0，基线预置至 2026-10-30）。
 * - DM_MATRIX_COLLECT_TABLES：数据采集来源人工准备好的表名（逗号分隔，可选）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect, uuid, fillByLabel, selectByLabel, assertNoConsoleErrors } from '../utils.js';
import {
  chooseFirstOption,
  clickFormControlByLabel,
  clickVisible,
  fillFormField,
} from '../抽样用例工具.js';
import {
  dataSyncSource,
  openSingleTableSyncCreate,
  selectDataSyncSourceAndAutomaticTarget,
} from '../数据接入/数据集成工具.js';
import { openFtpAccessList } from '../数据接入/FTP接入执行工具.js';
import { createFileAccessSourceTable, FLD_FILE_ACCESS_SOURCE_FIELDS } from './文件接入来源表工具.js';
import { requireFtpProfile, testEnvironment } from '../../../test-environment.js';

/** 表管理「来源」筛选的五类业务来源（与 DM-01-01 的 TABLE_SOURCE_FILTERS 同口径）。 */
const SOURCE_SELF = '自行建表';
const SOURCE_DI = '数据集成';
const SOURCE_FA = '文件接入';
const SOURCE_FTP = 'FTP文件接入';
const SOURCE_COLLECT = '数据采集';

/** 四类状态标签名（与 DM-01-01 的 TABLE_STATUS_FILTERS 同口径）。 */
const STATUS_EXIST = '物理表存在';
const STATUS_ONLINE = '物理表存在&上线';
const STATUS_OFFLINE = '物理表存在&下线';
const STATUS_DRAFT = '草稿';

/** 状态标签匹配（含列表页追加的计数后缀；口径取自 DM-01-01）。 */
const STATUS_MATCHERS: Record<string, RegExp> = {
  [STATUS_EXIST]: /^物理表存在(?:\s*[（(]\s*\d+\s*[）)])?$/,
  [STATUS_ONLINE]: /^物理表存在\s*&\s*上线(?:\s*[（(]\s*\d+\s*[）)])?$/,
  [STATUS_OFFLINE]: /^物理表存在\s*&\s*下线(?:\s*[（(]\s*\d+\s*[）)])?$/,
  [STATUS_DRAFT]: /^草稿(?:\s*[（(]\s*\d+\s*[）)])?$/,
};
/** 实测落点探测顺序：先具体标签，「物理表存在」可能聚合下钻入口放最后。 */
const DETECT_STATUS_ORDER = [STATUS_DRAFT, STATUS_ONLINE, STATUS_OFFLINE, STATUS_EXIST];

/** 配置中心的公共 MySQL 数据源显示名（建表入口下拉使用，环境重置只改配置）。 */
const MYSQL_SOURCE_TEXT = testEnvironment.dataSourceNames.tableManagement.newDataBase;
const MYSQL_SOURCE_PATTERN = new RegExp(MYSQL_SOURCE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

/** 状态工件路径：DM-01-01 按同一路径消费；DM_MATRIX_STATE 可整段覆盖。 */
const DM_MATRIX_STATE_PATH = process.env.DM_MATRIX_STATE?.trim()
  ? path.resolve(process.env.DM_MATRIX_STATE.trim())
  : path.resolve('temp', 'dm-matrix', 'fixture-state.json');

/** FTP 日期文件偏移：默认 0（FTP 基线已预置到 2026-10-30 的 gs_test_YYYYMMDD）。 */
const FTP_DATE_OFFSET = process.env.DM_MATRIX_FTP_DATE_OFFSET?.trim()
  || testEnvironment.fileTransfer.fileDateOffset
  || '0';

/** 数据采集来源人工准备的表名（逗号分隔）；该来源无自动化建表入口，见文件头。 */
const COLLECT_TABLES = process.env.DM_MATRIX_COLLECT_TABLES?.trim()
  ? process.env.DM_MATRIX_COLLECT_TABLES.split(/[,，;；\s]+/).map((name) => name.trim()).filter(Boolean)
  : [];

/** 自行建表表单的固定下拉口径（与 DM-00-01 查询夹具一致）。 */
const SELF_DATA_LEVEL = '应用数据层';
const SELF_DB_LEVEL = 'ADS';
const SELF_OWNER = 'admin';

interface MatrixTableEntry {
  tableName: string;
  /** 建表路线（自行建表DDL / 数据集成单表同步 / 文件接入 / FTP文件接入 / 人工）。 */
  route: string;
  /** 期望命中的状态标签；数据采集人工表可为空（以实测为准）。 */
  expectedStatus?: string;
  /** 校验时实测命中的状态标签；与期望不一致时用于缺口说明。 */
  verifiedStatus?: string;
  evidence: string;
}

interface MatrixSourceState {
  prepared: boolean;
  /** 未准备/部分准备的原因（环境前置、无自动化入口等），如实记录。 */
  reason?: string;
  /** 人工补救入口（环境变量名等）。 */
  manualEnv?: string;
  tables: MatrixTableEntry[];
}

interface MatrixState {
  statePathVersion: 1;
  runId: string;
  createdAt: string;
  /** 明确不能自动覆盖的矩阵缺口说明（不伪装、不阻塞其余来源）。 */
  gaps: string[];
  sources: Record<string, MatrixSourceState>;
}

function emptySourceState(): MatrixSourceState {
  return { prepared: false, tables: [] };
}

function readStateFile(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(DM_MATRIX_STATE_PATH, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 每个来源完成即增量落盘；失败时已完成部分仍可被 DM-01-01 与人工消费。 */
function writeMatrixState(state: MatrixState): void {
  const file = readStateFile();
  file.dmMatrix = state;
  fs.mkdirSync(path.dirname(DM_MATRIX_STATE_PATH), { recursive: true });
  fs.writeFileSync(DM_MATRIX_STATE_PATH, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
}

const rows = (page: Page) => page.locator([
  'tbody > tr:visible',
  '.ant-table-tbody > tr:visible',
  '.el-table__body-wrapper tr:visible',
  '[role="row"]:visible:not(:has([role="columnheader"]))',
].join(', '));

async function openTableManage(page: Page): Promise<void> {
  const baseUrl = page.url().split('#')[0];
  await page.goto(`${baseUrl}#/dataMap/tableManage/tablesManage`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/#\/dataMap\/tableManage(?:\/tablesManage)?/, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: /新建表|新增表/ }).last()).toBeVisible({ timeout: 15_000 });
}

/** 从候选定位器里取最后一个可见项（无可见项返回 undefined）。 */
async function lastVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (await candidates[index].isVisible().catch(() => false)) return candidates[index];
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceMatcher(source: string): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(source)}\\s*$`);
}

/**
 * 点击列表筛选片：状态为 tab/文本，来源为 radio（DM-01-01 的实测口径）。
 * Ant 的原生 radio input 被样式隐藏，因此先按可访问名点 label/控件节点。
 */
async function clickFilterChip(page: Page, text: string, matcher: RegExp): Promise<void> {
  const radio = page.getByRole('radio', { name: matcher }).filter({ visible: true }).last();
  if (await radio.isVisible().catch(() => false)) {
    await radio.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(600);
    return;
  }
  const chip = await lastVisible([
    page.getByRole('tab', { name: matcher }),
    page.locator('[role="tab"]:visible').filter({ hasText: matcher }),
    page.getByText(matcher),
  ]);
  if (!chip) throw new Error(`表管理筛选区未找到「${text}」选项。`);
  await chip.click();
  await page.waitForTimeout(600);
}

/** 在当前筛选（状态+来源）下按表名搜索；返回命中的数据行（未找到返回 undefined）。 */
async function searchRow(page: Page, tableName: string): Promise<Locator | undefined> {
  const search = page.locator('input:visible').first();
  if (await search.isVisible().catch(() => false)) {
    await search.fill(tableName);
    const query = await lastVisible([
      page.getByRole('button', { name: /查\s*询/ }),
      page.locator('button:visible').filter({ hasText: /查\s*询/ }),
    ]);
    if (query) await query.click().catch(() => undefined);
  }
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const row = rows(page).filter({ hasText: tableName }).last();
    if (await row.isVisible().catch(() => false)) return row;
    const empty = page.getByText(/暂无数据|没有数据|空空如也/, { exact: false }).last();
    if (await empty.isVisible().catch(() => false)) return undefined;
    await page.waitForTimeout(250);
  }
  return undefined;
}

/**
 * 当前表管理页面把「表名称」和「操作」渲染在并排表格中，不能从名称行向下找按钮。
 * 以名称行在其表格中的行号，映射到「操作」表格中的同一行（DM-00-01 实测口径）。
 */
async function actionRowForTable(page: Page, tableName: string): Promise<Locator> {
  const nameButton = page.getByRole('button', { name: tableName, exact: true }).last();
  await expect(nameButton).toBeVisible({ timeout: 10_000 });
  const rowIndex = await nameButton.evaluate((button) => {
    const row = button.closest('tr');
    if (!row?.parentElement) return -1;
    return Array.from(row.parentElement.querySelectorAll(':scope > tr')).indexOf(row);
  });
  if (rowIndex < 0) throw new Error(`无法获取表“${tableName}”在名称列表中的行号。`);
  const tables = page.locator('table:visible');
  for (let index = 0; index < await tables.count(); index += 1) {
    const table = tables.nth(index);
    // 虚拟滚动表格的表头和数据区是两张相邻 table；表头没有稳定的
    // columnheader role，因此用表头文本「操作」定位其紧邻的数据表。
    if ((await table.innerText().catch(() => '')).replace(/\s+/g, '') === '操作') {
      const actionRow = table
        .locator('tbody > tr:visible, [role="row"]:visible:not(:has([role="columnheader"]))')
        .nth(rowIndex);
      await expect(actionRow).toBeVisible({ timeout: 10_000 });
      return actionRow;
    }
  }
  throw new Error('表管理页未找到「操作」列，无法执行上/下线。');
}

/** 确认弹窗只接受「确定/确认」，避免把原「上线/下线」按钮再点一遍导致未提交。 */
async function confirmPopup(page: Page): Promise<void> {
  let confirm = page.locator(
    '.ant-popover:visible, .ant-modal:visible, .el-popover:visible, .el-dialog:visible, [role="dialog"]:visible',
  ).getByRole('button', { name: /^确\s*(?:定|认)$/ }).last();
  if (!(await confirm.isVisible().catch(() => false))) {
    confirm = page.getByRole('button', { name: /^确\s*(?:定|认)$/ }).last();
  }
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
}

/** 上线一张表（幂等：操作列出现「下线」即视为已上线）。 */
async function bringOnline(page: Page, tableName: string): Promise<void> {
  if (!(await searchRow(page, tableName))) throw new Error(`表管理未找到表：${tableName}`);
  let actionRow = await actionRowForTable(page, tableName);
  const online = actionRow.getByRole('button', { name: /上\s*线/ }).last();
  if (!(await online.isVisible().catch(() => false))) {
    await expect(actionRow.getByRole('button', { name: /下\s*线/ }).last()).toBeVisible({ timeout: 10_000 });
    return;
  }
  await online.click();
  await page.waitForTimeout(300);
  await confirmPopup(page);
  await expect.poll(async () => {
    await searchRow(page, tableName);
    actionRow = await actionRowForTable(page, tableName);
    return (await actionRow.getByRole('button', { name: /下\s*线/ }).last().isVisible().catch(() => false))
      ? 'online'
      : 'waiting';
  }, { timeout: 20_000 }).toBe('online');
}

/** 先确保上线再下线，保证表经历完整「上线→下线」生命周期而落「物理表存在&下线」。 */
async function bringOffline(page: Page, tableName: string): Promise<void> {
  await bringOnline(page, tableName);
  let actionRow = await actionRowForTable(page, tableName);
  const offline = actionRow.getByRole('button', { name: /下\s*线/ }).last();
  await expect(offline).toBeVisible({ timeout: 10_000 });
  await offline.click();
  await page.waitForTimeout(300);
  await confirmPopup(page);
  await expect.poll(async () => {
    await searchRow(page, tableName);
    actionRow = await actionRowForTable(page, tableName);
    return (await actionRow.getByRole('button', { name: /上\s*线/ }).last().isVisible().catch(() => false))
      ? 'offline'
      : 'waiting';
  }, { timeout: 20_000 }).toBe('offline');
}

/** 在指定「来源×状态」单元格中搜索表名，返回是否命中。 */
async function hitInCell(page: Page, source: string, statusName: string, tableName: string): Promise<boolean> {
  await openTableManage(page);
  await clickFilterChip(page, statusName, STATUS_MATCHERS[statusName]);
  await clickFilterChip(page, source, sourceMatcher(source));
  return Boolean(await searchRow(page, tableName));
}

/** 实测某表当前命中的状态标签（逐个标签搜索），用于把真实落点写入工件。 */
async function detectActualStatus(page: Page, source: string, tableName: string): Promise<string | undefined> {
  for (const statusName of DETECT_STATUS_ORDER) {
    await openTableManage(page);
    await clickFilterChip(page, statusName, STATUS_MATCHERS[statusName]);
    await clickFilterChip(page, source, sourceMatcher(source));
    if (await searchRow(page, tableName)) return statusName;
  }
  return undefined;
}

/**
 * 与 DM-00-01/DM-02-01 已通过用例保持同一入口逻辑：新建表按钮先展开数据库菜单，
 * 再选择配置中心的公共 MySQL 数据源进入真实建表表单。仅点击主按钮会停留在列表页。
 */
async function openCreateTableEntry(page: Page): Promise<void> {
  const newTable = page.getByRole('button', { name: /^新建表/ }).last();
  const source = page.getByRole('menuitem', { name: MYSQL_SOURCE_PATTERN }).last();
  let opened = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await newTable.click({ force: true });
    if (await source.isVisible({ timeout: 2_000 }).catch(() => false)) {
      opened = true;
      break;
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(300);
  }
  if (!opened) throw new Error(`「新建表」下拉未展示配置的公共 MySQL 数据源（${MYSQL_SOURCE_TEXT}）。`);
  await source.click({ force: true });
  // Ant 的原生 radio input 被样式隐藏，等待可见标签而非 hidden input。
  await expect(page.getByText('语句添加', { exact: true }).last()).toBeVisible({ timeout: 15_000 });
}

async function selectFirst(page: Page, label: RegExp): Promise<void> {
  try {
    const control = await clickFormControlByLabel(page, label);
    await chooseFirstOption(page, control, String(label));
  } catch (error) {
    // schema、主题域、安全等级等可能非必填或无可选值；不把可选字段误判为建表失败。
    if (/schema|主题域|主领域|安全等级/i.test(String(label))) return;
    throw error;
  }
}

async function selectRequiredOption(page: Page, label: RegExp, expected: string): Promise<void> {
  const control = await clickFormControlByLabel(page, label);
  await control.click();
  const options = page.locator(
    '.el-select-dropdown__item:visible, .ant-select-item-option:visible, ' +
      '.ant-select-dropdown-menu-item:visible, [role="listbox"] [role="option"]:visible',
  );
  for (let index = await options.count() - 1; index >= 0; index -= 1) {
    const option = options.nth(index);
    const text = (await option.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (await option.isVisible().catch(() => false) && (text === expected || text.includes(expected))) {
      await option.click();
      return;
    }
  }
  await page.keyboard.press('Escape').catch(() => undefined);
  throw new Error(`建表前置缺少“${String(label)}=${expected}”可选项。`);
}

async function selectOwner(page: Page): Promise<void> {
  const control = await clickFormControlByLabel(page, /负责人/);
  await control.click();
  const options = page.locator(
    '.el-select-dropdown__item:visible, .ant-select-item-option:visible, ' +
      '.ant-select-dropdown-menu-item:visible, [role="listbox"] [role="option"]:visible',
  );
  for (let index = await options.count() - 1; index >= 0; index -= 1) {
    const option = options.nth(index);
    if (!(await option.isVisible().catch(() => false))) continue;
    if ((await option.innerText().catch(() => '')).replace(/\s+/g, '').toLowerCase() === SELF_OWNER) {
      await option.click();
      return;
    }
  }
  await chooseFirstOption(page, control, '负责人');
}

/** 语句添加 DDL → 解析 → 补齐字段中文名（DM-00-01 同口径）。 */
async function parseAndFillFields(page: Page, tableName: string): Promise<void> {
  await clickVisible(page, /语句添加/);
  const editor = page.locator('.monaco-editor:visible textarea').last();
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await editor.fill(`CREATE TABLE ${tableName} (id VARCHAR(64), name VARCHAR(128), remark VARCHAR(255))`);
  await clickVisible(page, /解\s*析|校\s*验/);
  await expect.poll(() => rows(page).count(), { timeout: 15_000 }).toBeGreaterThan(0);
  const chineseInputs = page.locator('input[placeholder*="字段中文"]:visible');
  for (let index = 0; index < await chineseInputs.count(); index += 1) {
    await chineseInputs.nth(index).fill(`字段${index + 1}`);
  }
}

/** 建表表单的必填项（描述 blur 才同步到表单模型，DM-00-01 实测）。 */
async function fillBaseForm(page: Page, tableName: string, chineseName: string): Promise<void> {
  await fillFormField(page, /表名称|表名/, tableName);
  await fillFormField(page, /表中文名称|表中文名/, chineseName);
  const description = await clickFormControlByLabel(page, /^描述[:：]?$/);
  await description.fill(`DM-00-03 来源状态矩阵夹具 ${new Date().toISOString()}`);
  await description.blur();
  await selectRequiredOption(page, /数据层级/, SELF_DATA_LEVEL);
  await selectRequiredOption(page, /库.?层级/, SELF_DB_LEVEL);
  for (const label of [/schema/i, /主题域|主领域/]) await selectFirst(page, label);
  await selectOwner(page);
  await selectFirst(page, /安全等级/);
  await selectFirst(page, /数据生命周期/);
  await selectFirst(page, /操作类型/);
  const noConfirm = page.getByRole('radio', { name: '否', exact: true }).last();
  if (await noConfirm.isVisible().catch(() => false)) await noConfirm.check();
}

/** 通过「新建表→DDL→建表」创建一张自行建表；成功后默认落「物理表存在&下线」（DM-02-01 实证）。 */
async function createSelfTable(page: Page, tableName: string, chineseName: string): Promise<void> {
  await openTableManage(page);
  await openCreateTableEntry(page);
  await fillBaseForm(page, tableName, chineseName);
  await parseAndFillFields(page, tableName);
  await page.getByRole('button', { name: /建\s*表/ }).last().click();
  await expect(page).toHaveURL(/#\/dataMap\/tableManage/, { timeout: 20_000 });
}

/** 草稿=同一表单只点「保存」不点「建表」；最终以「草稿」标签搜索校验为准。 */
async function createSelfDraft(page: Page, tableName: string, chineseName: string): Promise<void> {
  await openTableManage(page);
  await openCreateTableEntry(page);
  await fillBaseForm(page, tableName, chineseName);
  const save = await lastVisible([
    page.getByRole('button', { name: /^保\s*存$/ }),
    page.locator('button:visible').filter({ hasText: /^保\s*存$/ }),
  ]);
  if (!save) throw new Error('建表表单未找到「保存」按钮，无法生成草稿夹具。');
  await save.click();
  await page.waitForTimeout(1_000);
}

/** 数据集成：单表同步+自动建表（DI-05-01 已通过链路）；来源表取配置默认值，不写死。 */
async function createDataIntegrationTable(page: Page, targetTable: string, taskName: string): Promise<void> {
  await openSingleTableSyncCreate(page);
  await selectDataSyncSourceAndAutomaticTarget(page, targetTable);
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  // 字段集合由配置的来源表决定；只断言映射行存在，不在夹具里绑定具体列名。
  await expect(page.getByText(/当前共\s*\d+\s*个来源字段/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('tbody tr').filter({ hasText: '已映射' }).first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  const taskNameInput = page.getByLabel('任务名称', { exact: true });
  await expect(taskNameInput).toBeVisible({ timeout: 10_000 });
  await taskNameInput.fill(taskName);
  // 新建页不沿用默认重试值且带 *；不填写时「确定」无任何保存反馈（DI-05-01 实证）。
  const retryCount = page.getByRole('spinbutton').last();
  await expect(retryCount).toBeVisible({ timeout: 10_000 });
  await retryCount.fill('1');
  const nonCore = page.getByRole('radio', { name: '否', exact: true }).last();
  await nonCore.check().catch(async () => await nonCore.click());
  await page.getByRole('button', { name: /^\s*确\s*定\s*$/ }).click();
  await expect.poll(async () =>
    page.url().includes('/dataAccess/dataInteration') ||
    await page.getByText(/成功|已保存|已创建/).last().isVisible().catch(() => false),
  { timeout: 20_000 }).toBe(true);
}

function exactOption(value: string): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(value)}\\s*$`);
}

function optionLocator(page: Page, value: string): Locator {
  return page.locator(
    '.el-select-dropdown:visible li:visible, .ant-select-dropdown:visible [role="option"]:visible, [role="listbox"]:visible [role="option"]:visible',
  ).filter({ hasText: exactOption(value) }).last();
}

async function fillFirstMatchingLabel(page: Page, labels: string[], value: string): Promise<void> {
  for (const label of labels) {
    try {
      await fillByLabel(page, label, value);
      return;
    } catch {
      // 页面可能把地址字段显示为「地址」或「ftp服务器地址」等变体。
    }
  }
  throw new Error(`未找到可填写字段：${labels.join(' / ')}`);
}

async function selectStable(page: Page, label: string, value: string): Promise<void> {
  const currentCombos = (await page.locator('[role="combobox"]:visible').allTextContents())
    .map((text) => text.trim());
  if (currentCombos.some((text) => text === value || text === `请选择${value}` || text === `请选择 ${value}`)) return;
  try {
    await selectByLabel(page, label, value);
    return;
  } catch (error) {
    const visibleOption = optionLocator(page, value);
    if (await visibleOption.isVisible().catch(() => false)) {
      await visibleOption.click();
      return;
    }
    throw error;
  }
}

/** 按“日+偏移”计算 gs_test_YYYYMMDD 文件名后缀。 */
function formatDateOffset(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * 文件名日期规则：分隔符 _ + 标记空 + 维度日 + 偏移（gs_test_YYYYMMDD）。
 * 五个规则下拉在目标端选择前是页面上仅有的 combobox（BL-FLD-00-02 实测顺序）。
 */
async function selectDateRule(page: Page, offset: string): Promise<void> {
  const combos = page.locator('[role="combobox"]:visible');
  if (await combos.count() < 5) {
    throw new Error(`FTP 文件名配置下拉框不足 5 个（当前 ${await combos.count()} 个），无法设置日期规则。`);
  }
  const values = ['_', '空', '空', '日', offset];
  for (let index = 0; index < values.length; index += 1) {
    await combos.nth(index).click();
    const option = optionLocator(page, values[index]);
    await expect(option).toBeVisible({ timeout: 5_000 });
    await option.click();
    await page.waitForTimeout(250);
  }
}

async function clickAction(page: Page, name: RegExp): Promise<Locator> {
  const action = await lastVisible([
    page.getByRole('button', { name }),
    page.getByRole('link', { name }),
    page.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }),
  ]);
  if (!action) throw new Error(`页面没有可见操作“${name}”，当前页面：${page.url()}`);
  await action.click();
  await page.waitForTimeout(500);
  return action;
}

/** 定位目标表名输入框：label「表」向上就近找可编辑输入（110 迁移夹具实测口径）。 */
async function fillTargetTableName(page: Page, value: string): Promise<void> {
  const labels = page.getByText(/^\s*表\s*$/).filter({ visible: true });
  for (let index = await labels.count() - 1; index >= 0; index -= 1) {
    const label = labels.nth(index);
    let scope: Locator = label;
    for (let level = 0; level < 6; level += 1) {
      const field = scope.locator(
        'input:not([type="radio"]):not([type="checkbox"]):not([disabled]):visible, textarea:not([disabled]):visible',
      ).last();
      if (await field.isVisible().catch(() => false) && await field.isEditable().catch(() => false)) {
        await field.fill(value);
        return;
      }
      scope = scope.locator('..');
    }
  }
  throw new Error('FTP 向导第一步未找到「表」输入框，无法写入本轮目标表名。');
}

/** 字段映射目标列统一规范化为 e2e_col_N，避免远端表头中文/特殊字符导致保存失败。 */
async function fillValidTargetMappingFields(page: Page): Promise<void> {
  const mappingRows = page.locator('tbody tr:visible, .el-table__body-wrapper tr:visible, [role="row"]:visible')
    .filter({ hasNotText: /文件名称|导入状态|数据源类型/ });
  const rowCount = await mappingRows.count();
  if (rowCount === 0) throw new Error('字段映射页没有可编辑行。');
  for (let index = 0; index < rowCount; index += 1) {
    const targetEditor = mappingRows.nth(index)
      .locator('input:not([type="checkbox"]):not([type="radio"]):visible').first();
    if (!(await targetEditor.isVisible().catch(() => false))) {
      throw new Error(`字段映射第 ${index + 1} 行没有找到“映射目标字段”输入框。`);
    }
    await targetEditor.fill(`e2e_col_${index}`);
    await targetEditor.press('Enter').catch(() => targetEditor.press('Tab').catch(() => undefined));
    await page.waitForTimeout(150);
  }
}

/** 连点「下一步」直到出现任务名称输入并填写（最多 6 步）。 */
async function clickWizardNextUntilSave(page: Page, taskName: string): Promise<void> {
  for (let step = 0; step < 6; step += 1) {
    const taskField = page.getByLabel(/任务名称|接入任务名称/).filter({ visible: true }).last();
    if (await taskField.isVisible().catch(() => false)) await taskField.fill(taskName);
    const taskPlaceholder = page.getByPlaceholder(/任务名称|接入任务名称/).filter({ visible: true }).last();
    if (await taskPlaceholder.isVisible().catch(() => false)) await taskPlaceholder.fill(taskName);
    const next = await lastVisible([
      page.getByRole('button', { name: /下一步|继续/ }),
      page.locator('button:visible, [role="button"]:visible').filter({ hasText: /下一步|继续/ }),
    ]);
    if (!next) return;
    await next.click();
    await page.waitForTimeout(600);
  }
}

/**
 * FTP文件接入：新建接入（协议 ftp，一律使用 FTP profile 默认 113:2121 基线，
 * 不把 FTP 目录当 SFTP 22 端口用）→ 日期规则 gs_test_YYYYMMDD → 目标端自动建表 →
 * 测试连接 → 预览文件名 + 数据预览 → 字段映射 → 保存。
 * 保存失败时把页面提示与捕获的保存请求一并抛出，便于静态开发交接定位。
 */
async function createFtpAccessTable(
  page: Page,
  profile: ReturnType<typeof requireFtpProfile>,
  baseFileName: string,
  targetTable: string,
  taskName: string,
): Promise<string> {
  await openFtpAccessList(page);
  await clickAction(page, /新建接入|新增接入/);
  await expect(page.getByText('来源文件', { exact: true }).filter({ visible: true }).last())
    .toBeVisible({ timeout: 10_000 });

  // 1) 连接配置：协议固定 ftp；凭据只来自 FTP_USER/FTP_PASS（requireFtpProfile 校验）。
  const ftpRadio = page.locator('input[type="radio"][value="ftp"]:visible').first();
  if (await ftpRadio.count()) {
    await ftpRadio.check({ force: true }).catch(() => undefined);
  } else {
    const labelRadio = page.getByRole('radio', { name: /^ftp$/i }).filter({ visible: true }).last();
    if (await labelRadio.isVisible().catch(() => false)) await labelRadio.click({ force: true });
  }
  await fillFirstMatchingLabel(page, ['地址', 'ftp服务器地址'], profile.host);
  await fillByLabel(page, '端口', String(profile.port));
  await fillFirstMatchingLabel(page, ['用户名', '登录用户名'], profile.username);
  await fillFirstMatchingLabel(page, ['密码', '登录密码'], profile.password);
  await fillFirstMatchingLabel(page, ['文件', '文件路径'], profile.baseDir);
  await fillByLabel(page, '基础文件名', baseFileName);
  await fillByLabel(page, '列分隔符', ',');

  // 2) 文件名日期规则（先于目标端，保证页面前 5 个 combobox 即规则下拉）。
  await selectDateRule(page, FTP_DATE_OFFSET);

  // 3) 目标端：文件接入配置中心的 MySQL 目标 + 自动建表。
  const fileAccess = testEnvironment.dataSourceNames.fileAccess;
  await selectStable(page, '数据源类型', fileAccess.type);
  await selectStable(page, '数据源名称', fileAccess.name);
  await selectStable(page, '数据库名称', fileAccess.database);
  await selectStable(page, 'Schema', fileAccess.schema);
  const autoBuildRadio = page.getByRole('radio', { name: /自动建表/ }).filter({ visible: true }).last();
  if (await autoBuildRadio.isVisible().catch(() => false)) {
    await autoBuildRadio.check({ force: true }).catch(async () => autoBuildRadio.click());
  } else {
    const autoBuildText = page.getByText('自动建表', { exact: true }).filter({ visible: true }).last();
    if (await autoBuildText.isVisible().catch(() => false)) await autoBuildText.click();
  }
  await fillTargetTableName(page, targetTable);

  // 4) 测试连接：后端用表单里的 113:2121 凭据真连一次，失败即环境前置问题。
  await clickAction(page, /测试连接/);
  await expect(page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
    .filter({ hasText: /连接成功|成功/ }).last()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape').catch(() => undefined);

  // 5) 预览文件名 + 数据预览：确认远端 gs_test_YYYYMMDD（按偏移）真实可读。
  const stamp = formatDateOffset(Number(FTP_DATE_OFFSET));
  const previewName = await lastVisible([
    page.getByRole('button', { name: /预览文件名/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /预览文件名/ }),
  ]);
  if (!previewName) throw new Error('FTP 来源文件区域没有找到「预览文件名」按钮。');
  await previewName.click();
  await expect(page.getByText(new RegExp(`${baseFileName}_${stamp}`)).filter({ visible: true }).last())
    .toBeVisible({ timeout: 10_000 });
  const dataPreview = await lastVisible([
    page.getByRole('button', { name: /数据预览/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /数据预览/ }),
  ]);
  if (!dataPreview) throw new Error('新建 FTP 接入页没有找到「数据预览」按钮。');
  await dataPreview.click();
  const fieldPreview = page.getByRole('dialog', { name: '字段预览' }).filter({ visible: true }).last();
  await expect(fieldPreview).toBeVisible({ timeout: 15_000 });
  const closePreview = await lastVisible([
    fieldPreview.getByRole('button', { name: /关闭|Close/ }),
    fieldPreview.locator('button:visible, [role="button"]:visible').filter({ hasText: /关闭|Close/ }),
  ]);
  if (closePreview) await closePreview.click();
  else await page.keyboard.press('Escape');
  await expect(fieldPreview).toBeHidden({ timeout: 5_000 });

  // 6) 下一步 → 字段映射 → 下一步到任务名 → 重试 0 → 保存（带请求证据）。
  await clickAction(page, /下一步/);
  await expect(page.getByText(/目标映射|字段映射/).filter({ visible: true }).last()).toBeVisible({ timeout: 10_000 });
  await fillValidTargetMappingFields(page);
  await clickWizardNextUntilSave(page, taskName);
  const retry = page.getByLabel(/重试次数/).filter({ visible: true }).last();
  if (await retry.isVisible().catch(() => false)) await retry.fill('0');
  else {
    const spin = page.getByRole('spinbutton').last();
    if (await spin.isVisible().catch(() => false)) await spin.fill('0');
  }

  const saveRequests: string[] = [];
  const onSaveRequest = (request: { method(): string; url(): string }): void => {
    if (request.method() !== 'POST' || !/createFtpInsertDataTaskJob|ftp|access/i.test(request.url())) return;
    saveRequests.push(`${request.method()} ${request.url()}`);
  };
  page.on('request', onSaveRequest);
  try {
    await clickAction(page, /保\s*存|确\s*定|提交|创建/);
    await expect(page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible').last()
      .filter({ hasText: /成功|保存|创建/ })).toBeVisible({ timeout: 15_000 });
  } catch (error) {
    const pageHints = (await page.locator('body').innerText().catch(() => ''))
      .split(/\r?\n/).map((line) => line.trim())
      .filter((line) => /失败|错误|异常|不能为空|必填|重复|合法/.test(line)).slice(-12);
    throw new Error(`FTP 接入任务 ${taskName} 保存未成功：${error instanceof Error ? error.message : String(error)}；`
      + `页面提示：${pageHints.join(' | ') || '无'}；请求：${saveRequests.join(' | ') || '未捕获到保存请求'}`);
  } finally {
    page.off('request', onSaveRequest);
  }

  return `任务=${taskName}；协议=ftp；${profile.host}:${profile.port}${profile.baseDir}${baseFileName}_${stamp} → ${fileAccess.database}.${targetTable}`;
}

test.describe('DM-00-03｜数据地图｜五类来源状态矩阵初始化', () => {
  test('DM-00-03｜数据地图｜初始化五类来源的四类状态矩阵并落盘状态工件', async ({ loginPage, consoleErrors, report }) => {
    test.setTimeout(1_500_000);
    const page = loginPage;
    const runId = uuid();
    const state: MatrixState = {
      statePathVersion: 1,
      runId,
      createdAt: new Date().toISOString(),
      gaps: [
        '纯「物理表存在」（未上线下线）标签：四条自动建表路线的默认落点均为「物理表存在&下线」'
        + '（DM-02-01 页面实证），疑似仅数据采集类元数据可达；本夹具不伪造覆盖，以实测为准。',
      ],
      sources: {
        [SOURCE_SELF]: emptySourceState(),
        [SOURCE_DI]: emptySourceState(),
        [SOURCE_FA]: emptySourceState(),
        [SOURCE_FTP]: emptySourceState(),
        [SOURCE_COLLECT]: emptySourceState(),
      },
    };
    const autoRouteFailures: string[] = [];

    /**
     * 每个来源独立 try/catch：完成即落盘，失败记录原因并继续其余来源；
     * 最后统一以「环境前置条件缺失」汇总抛出，避免单来源失败吞掉其余来源的成果。
     */
    async function runSource(source: string, init: () => Promise<void>): Promise<void> {
      try {
        await init();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.sources[source] = { ...state.sources[source], prepared: false, reason: message };
        state.gaps.push(`${source}：${message}`);
        writeMatrixState(state);
        autoRouteFailures.push(`${source}：${message}`);
      }
    }

    // 1) 自行建表：3 张物理表（ex/on/off）+ 1 张草稿（保存不建表）。
    await runSource(SOURCE_SELF, async () => {
      const exist = `e2e_dm3_${runId}_sb_ex`;
      const online = `e2e_dm3_${runId}_sb_on`;
      const offline = `e2e_dm3_${runId}_sb_off`;
      await createSelfTable(page, exist, `DM矩阵自建存在${runId}`);
      await createSelfTable(page, online, `DM矩阵自建上线${runId}`);
      await createSelfTable(page, offline, `DM矩阵自建下线${runId}`);
      await openTableManage(page);
      await clickFilterChip(page, SOURCE_SELF, sourceMatcher(SOURCE_SELF));
      await bringOnline(page, online);
      await bringOffline(page, offline);
      state.sources[SOURCE_SELF] = {
        prepared: true,
        tables: [
          {
            tableName: exist,
            route: '数据地图-表管理-新建表-DDL-建表',
            expectedStatus: STATUS_OFFLINE,
            evidence: `只建表不操作生命周期（DM-02-01 实证默认落点，runId=${runId}）`,
          },
          {
            tableName: online,
            route: '数据地图-表管理-新建表-DDL-建表-上线',
            expectedStatus: STATUS_ONLINE,
            evidence: `建表后已上线（runId=${runId}）`,
          },
          {
            tableName: offline,
            route: '数据地图-表管理-新建表-DDL-建表-上线-下线',
            expectedStatus: STATUS_OFFLINE,
            evidence: `建表后经历上线→下线（runId=${runId}）`,
          },
        ],
      };
      // 草稿单独兜底：保存入口缺失只记缺口，不影响本来源其余状态已准备的事实。
      try {
        const draft = `e2e_dm3_${runId}_sb_df`;
        await createSelfDraft(page, draft, `DM矩阵自建草稿${runId}`);
        state.sources[SOURCE_SELF].tables.push({
          tableName: draft,
          route: '数据地图-表管理-新建表-表单保存（不建表）',
          expectedStatus: STATUS_DRAFT,
          evidence: `只点「保存」未点「建表」（runId=${runId}）`,
        });
      } catch (error) {
        state.gaps.push(`${SOURCE_SELF}/草稿：${error instanceof Error ? error.message : String(error)}`);
      }
      writeMatrixState(state);
    });

    // 2) 数据集成：单表同步自动建表 ×3（ex/on/off）。
    await runSource(SOURCE_DI, async () => {
      const items = [
        { tag: 'ex', table: `e2e_dm3_${runId}_di_ex`, task: `E2E_DM3_${runId.toUpperCase()}_DI_EX`, status: STATUS_OFFLINE, extra: '' },
        { tag: 'on', table: `e2e_dm3_${runId}_di_on`, task: `E2E_DM3_${runId.toUpperCase()}_DI_ON`, status: STATUS_ONLINE, extra: '-上线' },
        { tag: 'off', table: `e2e_dm3_${runId}_di_off`, task: `E2E_DM3_${runId.toUpperCase()}_DI_OFF`, status: STATUS_OFFLINE, extra: '-上线-下线' },
      ];
      const created: MatrixTableEntry[] = [];
      for (const item of items) {
        await createDataIntegrationTable(page, item.table, item.task);
        created.push({
          tableName: item.table,
          route: `数据接入-数据集成-单表同步-自动建表${item.extra}`,
          expectedStatus: item.status,
          evidence: `来源=${dataSyncSource.database}.${dataSyncSource.table}；任务=${item.task}（runId=${runId}）`,
        });
      }
      await openTableManage(page);
      await clickFilterChip(page, SOURCE_DI, sourceMatcher(SOURCE_DI));
      await bringOnline(page, items[1].table);
      await bringOffline(page, items[2].table);
      state.sources[SOURCE_DI] = { prepared: true, tables: created };
      writeMatrixState(state);
    });

    // 3) 文件接入：上传 CSV 自动建表 ×3（ex/on/off），复用字段血缘共享工具。
    await runSource(SOURCE_FA, async () => {
      const filePath = process.env.DM_MATRIX_FILE_SOURCE_PATH?.trim()
        || path.resolve(process.cwd(), 'e2e', '工厂', '湖南中行', '资源', '字段血缘', '文件接入', 'e2e_lineage_file_source.csv');
      fs.accessSync(filePath, fs.constants.R_OK);
      const items = [
        { tag: 'ex', table: `e2e_dm3_${runId}_fa_ex`, status: STATUS_OFFLINE, extra: '' },
        { tag: 'on', table: `e2e_dm3_${runId}_fa_on`, status: STATUS_ONLINE, extra: '-上线' },
        { tag: 'off', table: `e2e_dm3_${runId}_fa_off`, status: STATUS_OFFLINE, extra: '-上线-下线' },
      ];
      const created: MatrixTableEntry[] = [];
      for (const item of items) {
        const detail = await createFileAccessSourceTable(page, {
          filePath,
          fileLabel: 'e2e_lineage_file_source.csv',
          separator: ',',
          tableName: item.table,
          sourceFields: FLD_FILE_ACCESS_SOURCE_FIELDS,
        });
        created.push({
          tableName: item.table,
          route: `数据接入-文件接入-上传CSV-解析-自动建表${item.extra}`,
          expectedStatus: item.status,
          evidence: `${detail}；字段=${FLD_FILE_ACCESS_SOURCE_FIELDS.join('/')}（runId=${runId}）`,
        });
      }
      await openTableManage(page);
      await clickFilterChip(page, SOURCE_FA, sourceMatcher(SOURCE_FA));
      await bringOnline(page, items[1].table);
      await bringOffline(page, items[2].table);
      state.sources[SOURCE_FA] = { prepared: true, tables: created };
      writeMatrixState(state);
    });

    // 4) FTP文件接入：FTP profile（默认 113:2121）+ gs_test_YYYYMMDD 日期文件 ×3。
    await runSource(SOURCE_FTP, async () => {
      const profile = requireFtpProfile();
      const baseFileName = profile.baseFile.replace(/\.[^./]+$/, '');
      const items = [
        { tag: 'ex', table: `e2e_dm3_${runId}_ft_ex`, task: `E2E_DM3_${runId.toUpperCase()}_FT_EX`, status: STATUS_OFFLINE, extra: '' },
        { tag: 'on', table: `e2e_dm3_${runId}_ft_on`, task: `E2E_DM3_${runId.toUpperCase()}_FT_ON`, status: STATUS_ONLINE, extra: '-上线' },
        { tag: 'off', table: `e2e_dm3_${runId}_ft_off`, task: `E2E_DM3_${runId.toUpperCase()}_FT_OFF`, status: STATUS_OFFLINE, extra: '-上线-下线' },
      ];
      const created: MatrixTableEntry[] = [];
      for (const item of items) {
        const detail = await createFtpAccessTable(page, profile, baseFileName, item.table, item.task);
        created.push({
          tableName: item.table,
          route: `数据接入-ftp文件接入-新建接入-ftp协议-自动建表${item.extra}`,
          expectedStatus: item.status,
          evidence: `${detail}；日期偏移=${FTP_DATE_OFFSET}（runId=${runId}）`,
        });
      }
      await openTableManage(page);
      await clickFilterChip(page, SOURCE_FTP, sourceMatcher(SOURCE_FTP));
      await bringOnline(page, items[1].table);
      await bringOffline(page, items[2].table);
      state.sources[SOURCE_FTP] = { prepared: true, tables: created };
      writeMatrixState(state);
    });

    // 5) 数据采集：无自动化建表入口（全库仅表管理来源筛选出现该词）。
    //    人工准备好的表名经 DM_MATRIX_COLLECT_TABLES 注入后仅校验存在性，缺失如实记缺口。
    const collectState = emptySourceState();
    if (COLLECT_TABLES.length === 0) {
      collectState.reason = '「数据采集」来源无自动化建表入口（代码库与页面均无该来源的业务路由），'
        + '需人工经元数据采集接入后，把表名写入 DM_MATRIX_COLLECT_TABLES 环境变量再重跑本夹具校验。';
      collectState.manualEnv = 'DM_MATRIX_COLLECT_TABLES=<逗号分隔的表名>';
      state.gaps.push(`${SOURCE_COLLECT}：${collectState.reason}`);
    } else {
      const tables: MatrixTableEntry[] = [];
      for (const name of COLLECT_TABLES) {
        const actual = await detectActualStatus(page, SOURCE_COLLECT, name);
        tables.push({
          tableName: name,
          route: '人工（元数据采集）',
          expectedStatus: actual,
          verifiedStatus: actual,
          evidence: actual
            ? `实测命中状态标签：${actual}`
            : '表管理「数据采集」来源四个状态标签下均未搜到该表',
        });
      }
      const hitCount = tables.filter((table) => table.verifiedStatus).length;
      collectState.prepared = hitCount > 0;
      collectState.tables = tables;
      if (hitCount === 0) {
        collectState.reason = `DM_MATRIX_COLLECT_TABLES 指定的表在「数据采集」来源下均不可见：${COLLECT_TABLES.join('、')}`;
        state.gaps.push(`${SOURCE_COLLECT}：${collectState.reason}`);
      }
    }
    state.sources[SOURCE_COLLECT] = collectState;
    writeMatrixState(state);

    // 终检：逐表在期望「来源×状态」单元格搜索；未命中的探测真实落点并写入工件。
    const statusMisses: string[] = [];
    for (const [source, sourceState] of Object.entries(state.sources)) {
      for (const entry of sourceState.tables) {
        if (!entry.expectedStatus) continue;
        const hit = await hitInCell(page, source, entry.expectedStatus, entry.tableName);
        if (hit) {
          entry.verifiedStatus = entry.expectedStatus;
          entry.evidence += `；终检命中=${source}/${entry.expectedStatus}`;
        } else {
          entry.verifiedStatus = await detectActualStatus(page, source, entry.tableName);
          const miss = `${source}/${entry.expectedStatus}：表 ${entry.tableName} 未命中（实测=${entry.verifiedStatus ?? '四个状态标签下均不可见'}）`;
          statusMisses.push(miss);
          state.gaps.push(`状态未命中：${miss}`);
        }
      }
      writeMatrixState(state);
    }

    const preparedSummary = Object.entries(state.sources)
      .map(([source, sourceState]) => `${source}=${sourceState.prepared ? '已准备' : '未准备'}`).join('；');
    if (autoRouteFailures.length) {
      throw new Error(
        `环境前置条件缺失：五类来源状态矩阵初始化存在失败路线（${autoRouteFailures.join('；')}）。`
        + `可用部分已写入 ${DM_MATRIX_STATE_PATH}；各来源：${preparedSummary}。`
        + '请修复环境后串行重跑（headed --workers=1）。DM-01-01 可先消费已准备的来源。',
      );
    }

    await assertNoConsoleErrors(consoleErrors);
    await report(
      '数据地图-五类来源×四类状态矩阵初始化',
      true,
      `runId=${runId}；${preparedSummary}；工件=${DM_MATRIX_STATE_PATH}；`
      + `状态未命中=${statusMisses.length}；缺口=${state.gaps.length} 条（详见工件 gaps）`,
    );

  });
});








