import type { Locator, Page } from '@playwright/test';
import { clickMenu, expect, settleDropdown } from '../utils.js';
import { testEnvironment } from '../../../test-environment.js';

// 数据集成来源/目标显示名统一由 e2e/test-environment.ts 解析；
// DATA_SYNC_SOURCE_* / DATA_SYNC_TARGET_* 仍可逐项覆盖 profile 默认值。
const dataSyncNames = testEnvironment.dataSourceNames;

export const dataSyncSource = {
  type: dataSyncNames.dataSyncSource.type,
  name: dataSyncNames.dataSyncSource.name,
  database: dataSyncNames.dataSyncSource.database,
  schema: dataSyncNames.dataSyncSource.schema,
  table: dataSyncNames.dataSyncSource.table ?? '',
};

export const dataSyncTarget = {
  type: dataSyncNames.dataSyncTarget.type,
  name: dataSyncNames.dataSyncTarget.name,
  database: dataSyncNames.dataSyncTarget.database,
  schema: dataSyncNames.dataSyncTarget.schema,
};

async function visibleLocator(locator: Locator): Promise<Locator | undefined> {
  for (let index = await locator.count() - 1; index >= 0; index -= 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return undefined;
}

export async function selectDataSyncOption(page: Page, controlId: string, option: string): Promise<void> {
  const control = page.locator(`#${controlId}`);
  await expect(control).toBeVisible({ timeout: 10_000 });
  await control.click({ force: true });
  // 级联的库/Schema 选项来自异步请求，刚打开下拉层时可能暂未渲染；必须等待，
  // 不能因第一帧为空把可选项误判成“未返回”。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const optionLocator = await visibleLocator(page.getByRole('option', { name: option, exact: true }));
    if (optionLocator) {
      await optionLocator.click();
      await settleDropdown(page);
      return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`数据集成控件 ${controlId} 未返回选项“${option}”`);
}

export async function selectDataSyncSourceAndAutomaticTarget(page: Page, tableName: string): Promise<void> {
  await selectDataSyncOption(page, 'sourceDatabaseTypeId', dataSyncSource.type);
  await selectDataSyncOption(page, 'sourceSourceId', dataSyncSource.name);
  await selectDataSyncOption(page, 'sourceDatabaseId', dataSyncSource.database);
  await selectDataSyncOption(page, 'sourceSchemaId', dataSyncSource.schema);
  await selectDataSyncOption(page, 'sourceTableId', dataSyncSource.table);

  await selectDataSyncOption(page, 'sinkDatabaseTypeId', dataSyncTarget.type);
  await selectDataSyncOption(page, 'sinkSourceId', dataSyncTarget.name);
  await selectDataSyncOption(page, 'sinkDatabaseId', dataSyncTarget.database);
  await selectDataSyncOption(page, 'sinkSchemaId', dataSyncTarget.schema);

  const autoBuild = page.getByRole('radio', { name: '自动建表', exact: true });
  await expect(autoBuild).toBeVisible({ timeout: 10_000 });
  await autoBuild.check().catch(async () => await autoBuild.click());
  // 页面标签的 for=sinkTableId 未实际落在输入框 DOM 上；当前版本以此占位定位。
  const targetTable = page.getByPlaceholder('请输入自建表', { exact: true });
  await expect(targetTable).toBeVisible({ timeout: 10_000 });
  await targetTable.fill(tableName);
}

export async function openSingleTableSyncCreate(page: Page): Promise<void> {
  await clickMenu(page, '数据接入', '数据集成');
  const singleTable = page.getByText('单表同步', { exact: true });
  // 服务刚登录时，左栏 hash 偶尔已切换而主体仍残留在“数据源管理”。
  // 不要直接点击一个尚未渲染的“创建任务”；先反复确认真实左栏链接和入口。
  for (let attempt = 0; attempt < 4 && !(await singleTable.isVisible().catch(() => false)); attempt += 1) {
    const createTask = await visibleLocator(page.getByRole('button', { name: /创建任务/ }));
    if (createTask) {
      await createTask.click();
      await page.waitForTimeout(300);
      continue;
    }

    const integrationLink = await visibleLocator(page.locator('a[href="#/dataAccess/dataInteration"]'));
    if (integrationLink) {
      await integrationLink.click();
      await page.waitForTimeout(800);
      continue;
    }
    await page.waitForTimeout(500);
  }
  await expect(singleTable).toBeVisible({ timeout: 10_000 });
  await singleTable.click();
  await expect(page.getByText('新建单表同步', { exact: true })).toBeVisible({ timeout: 10_000 });
}

export async function findDataSyncTaskOperationRow(page: Page, taskName: string): Promise<Locator> {
  const taskRows = page.locator('table').first().locator('tbody tr');
  const total = await taskRows.count();
  for (let index = 0; index < total; index += 1) {
    if ((await taskRows.nth(index).innerText()).includes(taskName)) {
      return page.locator('table').nth(1).locator('tbody tr').nth(index);
    }
  }
  throw new Error(`数据集成列表未找到本轮任务：${taskName}`);
}
/**
 * ==================== 批量同步（batchSyncCreate）专用 ====================
 * 20260916 探查实证（temp/公司模型任务/20260916-闭环/cline-runs/probe-batchsync2.log）：
 * 批量同步创建页与单表同步不同，表单控件没有 id（#sourceDatabaseTypeId 等不存在），
 * 9 个 .ant-form-item 只能按 label 文本 + 出现次序区分：
 * 数据源类型(0/1)、数据源名称(0/1)、数据库名称(0/1)、Schema(0/1)、表名称(0)，0=数据来源、1=数据去向。
 */
export async function pickBatchSyncLabeledSelect(
  page: Page,
  label: string,
  occurrence: number,
  option: string,
): Promise<void> {
  const formItem = page
    .locator('.ant-form-item')
    .filter({ has: page.locator('.ant-form-item-label', { hasText: label }) })
    .nth(occurrence);
  const select = formItem.locator('.ant-select');
  await expect(select).toBeVisible({ timeout: 10_000 });
  await select.click({ force: true });
  // 库/Schema/表选项来自异步请求，刚打开下拉层时可能未渲染；等待真实选项而不是立即判失败。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const optionLocator = await visibleLocator(page.getByRole('option', { name: option, exact: true }));
    if (optionLocator) {
      await optionLocator.click();
      await settleDropdown(page);
      return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `批量同步表单“${label}”（第 ${occurrence + 1} 处）未返回选项“${option}”，当前页面：${page.url()}`,
  );
}

/** 进入“数据集成 → 创建任务 → 批量同步”创建页（导航自愈逻辑与单表同步一致）。 */
/**
 * 批量同步“表名称”专用：下拉展开后不预加载选项，选择器内置搜索输入框（multiple/showSearch），
 * 必须键入表名触发过滤/异步加载后才会出现真实选项。
 * 20260917 页面实证（test-results/湖南中行/run-20260917-120322-289 error-context.md）：
 * 表名称 combobox[expanded] 内为 list>listitem>textbox[active]，仅轮询 role=option 5s 全空。
 * round2（run-20260917-120927-321）：键入后选项实际已渲染（失败截图含面板与表名），
 * 但 antd 在 option 内追加 check 图标，可访问名为“表名 图标: check”，
 * exact 全名匹配永不命中 → 先精确匹配，失败再按包含匹配（filter hasText）。
 */
export async function pickBatchSyncTableBySearch(
  page: Page,
  label: string,
  occurrence: number,
  table: string,
): Promise<void> {
  const formItem = page
    .locator('.ant-form-item')
    .filter({ has: page.locator('.ant-form-item-label', { hasText: label }) })
    .nth(occurrence);
  const select = formItem.locator('.ant-select');
  await expect(select).toBeVisible({ timeout: 10_000 });
  await select.click({ force: true });
  // 展开后搜索输入框自动聚焦（实证 textbox[active]）；fill 不产生逐键事件，
  // 用 keyboard.type 模拟真实键入触发 onSearch。
  await page.keyboard.type(table, { delay: 40 });
  // 选项可访问名含图标文案（“表名 图标: check”），exact 会漏配；先精确后包含。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const exactOption = await visibleLocator(page.getByRole('option', { name: table, exact: true }));
    const optionLocator =
      exactOption ??
      (await visibleLocator(page.getByRole('option', { name: table }).filter({ hasText: table })));
    if (optionLocator) {
      await optionLocator.click();
      // multiple 模式选中后下拉保持展开（settleDropdown 只移开鼠标不收起），Esc 收起避免遮挡后续控件。
      await page.keyboard.press('Escape');
      await page.waitForTimeout(350);
      return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `批量同步表单“${label}”（第 ${occurrence + 1} 处）键入“${table}”后未返回匹配选项，当前页面：${page.url()}`,
  );
}

export async function openBatchSyncCreate(page: Page): Promise<void> {
  await clickMenu(page, '数据接入', '数据集成');
  // 服务刚登录时，左栏 hash 偶尔已切换而主体仍残留在“数据源管理”；
  // 先反复确认真实入口，再展开“创建任务”点击“批量同步”。
  const batchSyncEntry = page.getByText('批量同步', { exact: true });
  for (let attempt = 0; attempt < 4 && !(await batchSyncEntry.isVisible().catch(() => false)); attempt += 1) {
    const createTask = await visibleLocator(page.getByRole('button', { name: /创建任务/ }));
    if (createTask) {
      await createTask.click();
      await page.waitForTimeout(300);
      continue;
    }
    const integrationLink = await visibleLocator(page.locator('a[href="#/dataAccess/dataInteration"]'));
    if (integrationLink) {
      await integrationLink.click();
      await page.waitForTimeout(800);
      continue;
    }
    await page.waitForTimeout(500);
  }
  if (!(await batchSyncEntry.isVisible().catch(() => false))) {
    const createTask = await visibleLocator(page.getByRole('button', { name: /创建任务/ }));
    if (createTask) {
      await createTask.click();
      await page.waitForTimeout(600);
    }
  }
  await expect(batchSyncEntry.last()).toBeVisible({ timeout: 10_000 });
  await batchSyncEntry.last().click();
  await expect(page.getByText('新建批量同步', { exact: true })).toBeVisible({ timeout: 10_000 });
}
