/**
 * DM-01-04 的专用前置：创建并上线一张具备四维检索数据的“自行建表”。
 * 只创建本轮唯一对象；测试环境允许保留，换环境时可重新执行本用例准备夹具。
 */
import { test, expect, assertNoConsoleErrors } from '../utils.js';
import {
  chooseFirstOption,
  clickFormControlByLabel,
  clickVisible,
  fillFormField,
} from '../抽样用例工具.js';
import type { Page } from '@playwright/test';
import { testEnvironment } from '../../../test-environment.js';
import { QUERY_FIXTURE } from './数据地图查询夹具.js';

/** 配置中心解析的公共 MySQL 数据源显示名（dataSourceNames.tableManagement，环境重置只改配置）。 */
const MYSQL_SOURCE_TEXT = testEnvironment.dataSourceNames.tableManagement.newDataBase;
/** 显示名转义后的数据源匹配正则（口径同 DM-01-03/DM-09-01 已迁移用例）。 */
const MYSQL_SOURCE_PATTERN = new RegExp(MYSQL_SOURCE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

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

/**
 * 与 DM-02-01 已通过用例保持同一入口逻辑：新建表按钮先展开数据库菜单，
 * 再选择配置中心的公共 MySQL 数据源进入真实建表表单。仅点击主按钮会停留在列表页。
 */
async function openCreateTableEntry(page: Page): Promise<void> {
  // 新版下拉偶发在刚加载时未展开；显式等待菜单项，失败后收起并重试，
  // 不把一次点击后的短暂空状态当成“没有 MySQL 数据源”。
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
  if (!opened) throw new Error(`“新建表”下拉未展示配置的公共 MySQL 数据源（${MYSQL_SOURCE_TEXT}）。`);
  await source.click({ force: true });
  // Ant 的原生 radio input 被样式隐藏，等待可见标签而非 hidden input。
  await expect(page.getByText('语句添加', { exact: true }).last()).toBeVisible({ timeout: 15_000 });
}

async function selectFirst(page: Page, label: RegExp): Promise<void> {
  try {
    const control = await clickFormControlByLabel(page, label);
    await chooseFirstOption(page, control, String(label));
  } catch (error) {
    // 当前页面的 schema、主题域、安全等级可能非必填或无可选值；不把这些
    // 可选字段误判为建表主流程失败，其余必填字段继续抛出真实错误。
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
      await page.keyboard.press('Escape').catch(() => undefined);
      return;
    }
  }
  await page.keyboard.press('Escape').catch(() => undefined);
  throw new Error(`建表前置缺少“${String(label)}=${expected}”可选项，无法初始化查询夹具。`);
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
    if ((await option.innerText().catch(() => '')).replace(/\s+/g, '').toLowerCase() === QUERY_FIXTURE.owner) {
      await option.click();
      return;
    }
  }
  await chooseFirstOption(page, control, '负责人');
}

async function parseAndFillFields(page: Page): Promise<void> {
  await clickVisible(page, /语句添加/);
  const editor = page.locator('.monaco-editor:visible textarea').last();
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await editor.fill(`CREATE TABLE ${QUERY_FIXTURE.tableName} (id VARCHAR(64), name VARCHAR(128), remark VARCHAR(255))`);
  await clickVisible(page, /解\s*析|校\s*验/);
  await expect.poll(() => rows(page).count(), { timeout: 15_000 }).toBeGreaterThan(0);
  const chineseInputs = page.locator('input[placeholder*="字段中文"]:visible');
  for (let index = 0; index < await chineseInputs.count(); index += 1) {
    await chineseInputs.nth(index).fill(`字段${index + 1}`);
  }
}

async function findFixtureRow(page: Page): Promise<ReturnType<typeof rows> | undefined> {
  const search = page.locator('input:visible').first();
  if (await search.isVisible().catch(() => false)) {
    await search.fill(QUERY_FIXTURE.tableName);
    await clickVisible(page, /查\s*询/);
  }
  // 表管理检索是 table_name LIKE 模糊匹配（TableManagerController#queryTableList →
  // DfMetadataTableServiceImpl#queryPageTableList 的 wrapper.like），搜基础名可能命中
  // 历史遗留的同前缀表（如 run-20260929-002954-565 中的 e2e_dm_query_fixture_v2_b59d1e）。
  // 夹具存在性必须按“整行文本精确等于表名”判断；否则会把后缀表误认成夹具，
  // 导致 fixtureActionRow 精确名定位失败，甚至对未知遗留表执行上线操作。
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const candidates = rows(page);
    for (let index = await candidates.count() - 1; index >= 0; index -= 1) {
      const row = candidates.nth(index);
      const text = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (text === QUERY_FIXTURE.tableName && (await row.isVisible().catch(() => false))) return row;
    }
    const empty = page.getByText(/暂无数据|没有数据|空空如也/, { exact: false }).last();
    if (await empty.isVisible().catch(() => false)) return undefined;
    await page.waitForTimeout(250);
  }
  return undefined;
}

/**
 * 当前表管理页面把“表名称”和“操作”渲染在并排表格中，不能从名称行向下找按钮。
 * 以名称行在其表格中的行号，映射到“操作”表格中的同一行。
 */
async function fixtureActionRow(page: Page): Promise<ReturnType<typeof rows>> {
  const nameButton = page.getByRole('button', { name: QUERY_FIXTURE.tableName, exact: true }).last();
  await expect(nameButton).toBeVisible({ timeout: 10_000 });
  const rowIndex = await nameButton.evaluate((button) => {
    const row = button.closest('tr');
    if (!row?.parentElement) return -1;
    return Array.from(row.parentElement.querySelectorAll(':scope > tr')).indexOf(row);
  });
  if (rowIndex < 0) throw new Error(`无法获取夹具表“${QUERY_FIXTURE.tableName}”在名称列表中的行号。`);

  const tables = page.locator('table:visible');
  for (let index = 0; index < await tables.count(); index += 1) {
    const table = tables.nth(index);
    // 虚拟滚动表格的表头和数据区是两张相邻 table；表头没有稳定的
    // columnheader role，因此用表头文本“操作”定位其紧邻的数据表。
    if ((await table.innerText().catch(() => '')).replace(/\s+/g, '') === '操作') {
      const dataTable = tables.nth(index + 1);
      const actionRow = dataTable.locator('tbody > tr:visible, [role="row"]:visible:not(:has([role="columnheader"]))').nth(rowIndex);
      await expect(actionRow).toBeVisible({ timeout: 10_000 });
      return actionRow;
    }
  }
  throw new Error('表管理页未找到“操作”列，无法确认夹具表是否上线。');
}

async function ensureFixtureOnline(page: Page): Promise<void> {
  if (!(await findFixtureRow(page))) throw new Error(`表管理未找到夹具表：${QUERY_FIXTURE.tableName}`);
  let actionRow = await fixtureActionRow(page);
  const online = actionRow.getByRole('button', { name: /上\s*线/ }).last();
  if (!(await online.isVisible().catch(() => false))) {
    await expect(actionRow.getByRole('button', { name: /下\s*线/ }).last()).toBeVisible({ timeout: 10_000 });
    return;
  }

  await online.click();
  await page.waitForTimeout(200);
  // 不把原操作按钮“上线”纳入候选；否则 popup 还在时 last() 可能再次点击原按钮，
  // 实际确认从未提交。确认按钮只接受“确定/确认”。
  let confirm = page.locator(
    '.ant-popover:visible, .ant-modal:visible, .el-popover:visible, .el-dialog:visible, [role="dialog"]:visible',
  ).getByRole('button', { name: /^确\s*(?:定|认)$/ }).last();
  if (!(await confirm.isVisible().catch(() => false))) {
    confirm = page.getByRole('button', { name: /^确\s*(?:定|认)$/ }).last();
  }
  if (await confirm.isVisible().catch(() => false)) await confirm.click();

  await expect.poll(async () => {
    await findFixtureRow(page);
    actionRow = await fixtureActionRow(page);
    return (await actionRow.getByRole('button', { name: /下\s*线/ }).last().isVisible().catch(() => false))
      ? 'online'
      : 'waiting';
  }, { timeout: 15_000 }).toBe('online');
}

async function createFixtureIfMissing(page: Page): Promise<void> {
  const existing = await findFixtureRow(page);
  if (existing) {
    await ensureFixtureOnline(page);
    return;
  }

  await openCreateTableEntry(page);
  await fillFormField(page, /表名称|表名/, QUERY_FIXTURE.tableName);
  await fillFormField(page, /表中文名称|表中文名/, QUERY_FIXTURE.chineseName);
  // 描述框由前端 blur 时才同步到表单模型；仅 fill 会出现“页面看似填写、详情回显为空”。
  const description = await clickFormControlByLabel(page, /^描述[:：]?$/);
  await description.fill(QUERY_FIXTURE.description);
  await description.blur();
  await selectRequiredOption(page, /数据层级/, QUERY_FIXTURE.dataLevel);
  await selectRequiredOption(page, /库.?层级/, QUERY_FIXTURE.databaseLevel);
  for (const label of [/schema/i, /主题域|主领域/]) await selectFirst(page, label);
  await selectOwner(page);
  await selectFirst(page, /安全等级/);
  await selectFirst(page, /数据生命周期/);
  await selectFirst(page, /操作类型/);
  const noConfirm = page.getByRole('radio', { name: '否', exact: true }).last();
  if (await noConfirm.isVisible().catch(() => false)) await noConfirm.check();

  await parseAndFillFields(page);
  await page.getByRole('button', { name: /建\s*表/ }).last().click();
  await expect(page).toHaveURL(/#\/dataMap\/tableManage/, { timeout: 20_000 });
  await ensureFixtureOnline(page);
}

test('DM-00-01｜数据地图｜表查询四维检索初始化', async ({ loginPage, consoleErrors, report }) => {
  const page = loginPage;
  await openTableManage(page);
  await createFixtureIfMissing(page);

  await assertNoConsoleErrors(consoleErrors);
  await report(
    '数据地图表查询四维检索初始化',
    true,
    `表名=${QUERY_FIXTURE.tableName}；中文名=${QUERY_FIXTURE.chineseName}；描述=${QUERY_FIXTURE.description}；负责人=${QUERY_FIXTURE.owner}`,
  );
});
