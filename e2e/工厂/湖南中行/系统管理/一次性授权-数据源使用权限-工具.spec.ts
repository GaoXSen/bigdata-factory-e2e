/**
 * 一次性运维工具用例（非产品验收）：给测试用户开通 110 MySQL 数据源的“使用”权限。
 *
 * 背景（110 环境迁移闭环，20260920）：
 *   - 110 数据源已在数据接入页重建（192.168.76.110:13306/e2e_test 与 192.168.76.110
 *     两个 MySQL 源），但仅有“管理”标记、无“使用”授权记录；后端
 *     DataSourceBizImpl/DataPermissionBizImpl 实证：数据权限校验开启时，用户对源无
 *     kind=5“使用”记录则 isUse=0，源被从 新建表/自助查询 等业务下拉整体剔除——
 *     这是 BL/DQ 全簇用例当前唯一阻断。
 *   - 数据源卡片上并无“使用”操作按钮（scripts/启用数据源使用.mjs 的早期假设不成立），
 *     唯一入口是 系统管理 → 用户权限 → 数据权限 页创建授权记录。本用例复用
 *     数据权限闭环工具 的页面流程，在 用户视角（资源范围切到“数据表”后弹窗才渲染
 *     级联表单）为 TEST_USER 创建“推进 数据库→Schema、表级留空（范围通配到源）、
 *     使用+管理、永久”授权。
 *
 * 生效证明（真实断言，非 toast）：
 *   1. 提交后回到用户视角列表，按数据源展示名定位授权行且权限类型含“使用”；
 *   2. 进入 自助查询，数据源弹窗中真实选中该源（基础名形态）并被页面回显。
 *
 * 幂等性：已存在同名源且权限类型含“使用”的授权行时跳过创建；仅有“管理”的
 * 历史行不视为已授权（不构成 isUse=1），仍会新增“使用”授权。可重复执行；
 * 仅新增授权记录，不删除既有业务数据，不触碰共享 fixture。
 *
 * 用法：
 *   npx playwright test "e2e/工厂/湖南中行/系统管理/一次性授权-数据源使用权限-工具.spec.ts" --project=chromium --workers=1 --headed
 * 环境变量：
 *   TEST_USER / TEST_PASS：登录账号即被授权主体（默认 admin）。
 *   GRANT_SOURCE_NAMES：逗号分隔的数据源展示名，默认两个 110 MySQL 源。
 *   DATA_PERMISSION_SOURCE_TYPE / DATA_PERMISSION_DATABASE / DATA_PERMISSION_SCHEMA。
 */
import { openDataPermissionPage, openUserViewCreateDialog, refreshPermissionList, selectPermissionSource, selectPermissionSourceType, selectUserViewSubject, setPermissionExpiry, setPermissionTypes, submitPermissionDialog, switchResourceViewScopeTab } from './数据权限闭环工具.js';
import { chooseConfiguredDataSource, expect, openSelfServiceQuery, test } from '../utils.js';
import type { Locator, Page } from '@playwright/test';

const grantUser = (process.env.TEST_USER ?? 'admin').trim();
const sourceType = process.env.DATA_PERMISSION_SOURCE_TYPE?.trim() || 'MYSQL';
const databaseName = process.env.DATA_PERMISSION_DATABASE?.trim() || 'e2e_test';
const schemaName = process.env.DATA_PERMISSION_SCHEMA?.trim() || 'e2e_test';
const grantSources = (process.env.GRANT_SOURCE_NAMES?.trim()
  || '192.168.76.110:13306/e2e_test,192.168.76.110')
  .split(',').map((value) => value.trim()).filter(Boolean);

function rowPlainText(row: Locator): Promise<string> {
  return row.innerText().catch(() => '').then((text) => text.replace(/\s+/g, ''));
}

/** 弹窗内按标签文本上溯定位下拉框（与 数据权限闭环工具.locatePermissionSelectByLabel 同策略）。 */
async function locateSelectByLabel(dialog: Locator, labels: RegExp[], placeholder: RegExp): Promise<Locator> {
  for (const label of labels) {
    const candidates = dialog.getByText(label);
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const node = candidates.nth(index);
      if (!(await node.isVisible().catch(() => false))) continue;
      let cursor = node;
      for (let level = 0; level < 6; level += 1) {
        const box = cursor.locator('.ant-select:visible, .el-select:visible, [role="combobox"]:visible, select:visible').first();
        if (await box.isVisible().catch(() => false)) return box;
        cursor = cursor.locator('..');
      }
    }
  }
  const input = dialog.locator(`input[placeholder*="${placeholder.source.replace(/\\\\/g, '')}"]:visible`).first();
  if (await input.isVisible().catch(() => false)) return input;
  throw new Error(`弹窗内未找到标签为 ${labels.map((l) => l.source).join('/')} 的下拉框`);
}

async function chooseDropdownOption(page: Page, value: string): Promise<void> {
  const option = page.locator([
    '.ant-select-dropdown:visible .ant-select-item-option',
    '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
    '.el-select-dropdown:visible .el-select-dropdown__item',
    '[role="listbox"]:visible [role="option"]',
  ].join(', ')).filter({ hasText: value }).last();
  await option.waitFor({ state: 'visible', timeout: 10_000 });
  await option.click();
  await page.waitForTimeout(600);
}

/**
 * 仅推进 数据库 → Schema 两级级联（数据表级刻意留空）。
 * SM-03-06 实证：提交时表级明细未选会落库为全 NULL 通配授权（tableId 空），
 * 正是后端 isUse 判定的源级 kind=5 记录形态；因此本工具绝不选择具体表。
 */
async function selectPermissionCascadeToSchema(
  page: Page,
  dialog: Locator,
  databaseName: string,
  schemaName: string,
): Promise<void> {
  const levels = [
    { labels: [/^数据库/, /^库名/], placeholder: /数据库|库/, value: databaseName, name: '数据库' },
    { labels: [/^Schema$/i, /^模式$/], placeholder: /[Ss]chema|模式/, value: schemaName, name: 'Schema' },
  ];
  for (const level of levels) {
    let box: Locator | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !box) {
      try {
        box = await locateSelectByLabel(dialog, level.labels, level.placeholder);
      } catch {
        // 选择上级资源后，下一级控件异步插入；不能在同一渲染 tick 判定不存在。
        await page.waitForTimeout(400);
      }
    }
    if (!box) throw new Error(`权限弹窗未出现“${level.name}”下拉框`);
    await box.click();
    await chooseDropdownOption(page, level.value);
    const echoed = await box.getByText(level.value, { exact: true }).count();
    if (!echoed) throw new Error(`“${level.name}”选择“${level.value}”后控件未回填`);
  }
}

/**
 * 在用户视角权限列表中定位“资源列恰为 sourceName”的授权行。
 * 短名 192.168.76.110 是完整展示名 192.168.76.110:13306/e2e_test 的前缀，
 * getByText 前缀命中会撞到长名源所在行——凡行文本含 13306 的行都判为长名源行，
 * 仅在为长名源查找或行内确无 13306 段时才视为命中。
 * mustContains 非空时还要求行文本包含该片段：admin 对两个 110 源已存在
 * 仅“管理”（kind=2、截止 2098-12-31）的历史授权行，它们不构成 isUse=1 的
 * “使用”授权，不能据此跳过创建。
 */
async function findSourceGrantRow(
  page: Page,
  sourceName: string,
  timeoutMs: number,
  mustContains = '使用',
): Promise<Locator | undefined> {
  const isFullName = /[:/]/.test(sourceName);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = page.getByText(sourceName);
    const count = await matches.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const node = matches.nth(index);
      if (!(await node.isVisible().catch(() => false))) continue;
      const row = node.locator('xpath=ancestor::tr[1]');
      if (!(await row.isVisible().catch(() => false))) continue;
      const text = await rowPlainText(row);
      if (!isFullName && text.includes('13306')) continue;
      if (mustContains && !text.includes(mustContains)) continue;
      return row;
    }
    await page.waitForTimeout(300);
  }
  return undefined;
}

test.describe('一次性授权：数据源使用权限', () => {
  test('给测试用户开通 110 数据源“使用”权限并以自助查询真实可选为证明', async ({ loginPage }) => {
    test.setTimeout(900_000);
    // 与 SM-03-06 一致：自动登录由 loginPage fixture 承担（page 本身不登录）。
    const page = loginPage;

    // headed 模式两次实测登录落地后整页白屏（渲染停滞）；与 utils 登录链路的
    // reload 恢复同理：正文为空时主动 reload 再继续，绝不跳过。同时采集
    // console/pageerror/HTTP>=400，白屏根因必须留痕。
    const consoleIssues: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleIssues.push(message.text().slice(0, 240));
    });
    page.on('pageerror', (error) => consoleIssues.push(`PAGEERROR=${String(error).slice(0, 240)}`));
    page.on('response', (response) => {
      if (response.status() >= 400) consoleIssues.push(`HTTP${response.status()} ${response.url().split('?')[0]}`);
    });
    const bodyChars = async (): Promise<number> =>
      (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, '').length;
    console.log(`ENTRY-URL=${page.url()} bodyChars=${await bodyChars()}`);
    for (let attempt = 1; attempt <= 3 && (await bodyChars()) < 10; attempt += 1) {
      console.log(`WHITE-PAGE-DETECTED reload#${attempt}`);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.waitForTimeout(3_000);
    }
    console.log(`AFTER-RECOVERY URL=${page.url()} bodyChars=${await bodyChars()} issues=${JSON.stringify(consoleIssues.slice(0, 8))}`);

    await openDataPermissionPage(page);

    for (const sourceName of grantSources) {
      // 幂等探测：该主体对该源已有授权行则跳过创建。
      await selectUserViewSubject(page, { subjectTab: '成员', subjectName: grantUser });
      await refreshPermissionList(page);
      const existingRow = await findSourceGrantRow(page, sourceName, 4_000);
      if (existingRow) {
        const existingText = await rowPlainText(existingRow);
        console.log(`GRANT-EXISTS=${sourceName} row=${existingText.slice(0, 120)}`);
        continue;
      }
      // 存在仅“管理”的历史授权行时不跳过：它不携带 isUse=1 的“使用”，须另行授权。
      const manageOnlyRow = await findSourceGrantRow(page, sourceName, 3_000, '');
      if (manageOnlyRow) {
        const manageOnlyText = await rowPlainText(manageOnlyRow);
        console.log(`GRANT-MANAGE-ONLY=${sourceName} row=${manageOnlyText.slice(0, 120)} -> 需新增使用授权`);
      }
      console.log(`GRANT-CREATING=${sourceName}`);

      // 用户视角右侧“资源范围”默认停在“数据源”，该形态弹窗只有管理勾选、无级联
      // （run-0006 失败快照实证）。切到“数据表”范围后，弹窗才渲染
      // 数据库 → Schema → 数据表 三级选择器与“使用/管理”勾选（SM-03-06 惯例）。
      await switchResourceViewScopeTab(page, '数据表');
      const dialog = await openUserViewCreateDialog(page);
      await selectPermissionSourceType(page, dialog, sourceType);
      await selectPermissionSource(page, dialog, {
        sourceTypeName: sourceType,
        sourceName,
        databaseName,
        schemaName,
      });
      // 推进 数据库 → Schema 级联，数据表级刻意留空（源级通配授权，见 helper 注释）。
      await selectPermissionCascadeToSchema(page, dialog, databaseName, schemaName);
      await setPermissionTypes(page, dialog, ['使用', '管理']).catch(async (error) => {
        // 失败时必须留下弹窗现场：权限类型控件的真实渲染状态是定位依据。
        const dialogText = await dialog.innerText().catch(() => '(弹窗文本获取失败)');
        console.log(`DIALOG-ON-FAILURE=${JSON.stringify(dialogText.slice(0, 800))}`);
        throw error;
      });
      await setPermissionExpiry(page, dialog, '永久');
      await submitPermissionDialog(page, dialog);

      // 提交后落在“数据表”范围列表：转储文本留证，便于核对范围通配记录的展示形态。
      const listAfterCreate = await page.locator('body').innerText().catch(() => '');
      console.log(`LIST-AFTER-CREATE=${JSON.stringify(listAfterCreate.slice(0, 500))}`);
      // 切回“数据源”范围，按 源名+使用 定位新增授权行（范围通配记录按源维度回显）。
      await switchResourceViewScopeTab(page, '数据源');
      // 回显验证：列表必须出现该源的授权行且权限类型含“使用”。
      const grantedRow = await findSourceGrantRow(page, sourceName, 15_000);
      expect(grantedRow, `提交成功后用户视角未回显 ${grantUser} 对 ${sourceName} 的授权行`).toBeTruthy();
      const grantedText = grantedRow ? await rowPlainText(grantedRow) : '';
      expect(grantedText, `授权行权限类型未包含“使用”：${grantedText}`).toContain('使用');
      console.log(`GRANT-CREATED=${sourceName} row=${grantedText.slice(0, 120)}`);
    }

    // 业务生效证明：自助查询的数据源弹窗中该源真实可选（选项为基础名形态）。
    console.log(`PRE-SELFQUERY issues=${JSON.stringify(consoleIssues.slice(0, 12))}`);
    const baseNames = [...new Set(grantSources.map((name) => name.split(/[:：]/)[0].trim()))].filter(Boolean);
    await openSelfServiceQuery(page);
    for (const baseName of baseNames) {
      await chooseConfiguredDataSource(page, { type: sourceType, name: baseName, schema: databaseName });
      console.log(`SELFQUERY-SOURCE-SELECTED=${baseName}`);
    }
  });
});
