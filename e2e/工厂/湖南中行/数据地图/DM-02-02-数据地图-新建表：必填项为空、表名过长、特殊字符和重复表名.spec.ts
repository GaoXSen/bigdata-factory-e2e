/**
 * 来源：工厂测试用例-标准化业务版-湖南中行-数据地图闭环固化版.xlsx / DM-02-02
 * 数据地图新建表：必填项为空、表名过长、特殊字符和重复表名。
 *
 * 2026-09-22（DS-PERM-63 清洁环境迁移）：
 * - 建表入口与数据源选择对齐 DM-03-02 通过轮口径：真实“新建表”按钮 + 下拉中配置中心的
 *   公共 MySQL 数据源（按 /mysql/i 类型匹配，具体实例由环境配置决定）；下拉未提供 MySQL
 *   数据源属环境前置缺失，上报证据后条件跳过，不再静默选第一个库。
 * - 登录与管理员身份复用公共配置（loginPage fixture），spec 内不含账号、IP、端口、密码或
 *   数据源名称硬编码；删除断言为“必填未填全保存被拦截”的拦截断言本身，一条未删。
 * - 拦截断言按腾讯文档辅助审查 20260902-092549 第 136 条意见（口径同 DM-03-02）升级：
 *   优先在表单项/表单区域内匹配校验提示，避免全页静态文字假通过；原全页匹配保留为最后
 *   回退，并新增“不离开建表表单、不出现成功反馈”两项加强校验。
 * - 本用例正常链路不创建表；为防产品行为异常导致建表，登记本轮表名并在 finally 仅清理
 *   本轮表（物理表尽力 DROP + 元数据行内删除入口尽力尝试），清理失败只告警、不掩埋结果。
 * - 硬链接双入口兼容：仅从 ../utils.js 取工具与配置（query/dbConfig() 等），不直接相对引用
 *   e2e/test-environment.ts（孪生路径相对深度不同会断链）。
 * - 业务歧义记录：标题中“表名过长、特殊字符”由 DM-02-03 承接、“重复表名”当前文件无对应
 *   断言，见 result-DS-PERM-63.md；本文件实际覆盖＝必填项为空保存拦截。
 */
import { test, expect, uuid, clickMenu, assertNoConsoleErrors, query, dbConfig } from '../utils.js';
import type { Locator, Page, TestInfo } from '@playwright/test';

async function openTableManage(page: Page): Promise<void> {
  // 从默认“数据源管理”直接 goto 数据地图深层 hash 时，当前 SPA 偶发只改地址
  // 或直接保留原组件。使用真实菜单切换才能稳定卸载旧页面并挂载表管理列表。
  try {
    await clickMenu(page, '数据地图', '表管理');
  } catch {
    // 登录后首屏偶发只渲染空的顶栏容器，菜单文字尚未挂载。此时用同一个 hash
    // 不会重建 Vue 实例，必须带一次性 query 参数进行完整文档导航再进入表管理。
    const freshRoute = new URL(page.url().split('#')[0]);
    freshRoute.searchParams.set('e2e_table_manage', String(Date.now()));
    freshRoute.hash = '/dataMap/tableManage/tablesManage';
    await page.goto(freshRoute.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
  }
  // 当前数据地图把“表管理”拆为父路由与同名列表叶子。父路由只显示侧栏，不会
  // 挂载列表/新建表按钮；必须展开父菜单后点击 /tablesManage 叶子。
  const parent = page.locator('a[href="#/dataMap/tableManage"]:visible').last();
  if (await parent.isVisible().catch(() => false)) await parent.click();
  const leaf = page.locator('a[href="#/dataMap/tableManage/tablesManage"]:visible').last();
  await expect(leaf, '表管理菜单没有渲染列表叶子页').toBeVisible({ timeout: 12_000 });
  await leaf.click();
  await expect(page).toHaveURL(/#\/dataMap\/tableManage\/tablesManage(?:\?|$)/, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: /新建表|新增表/ }).last()).toBeVisible({ timeout: 15_000 });
}

async function openCreateTableEntry(page: Page): Promise<boolean> {
  // “新建表”是带下拉箭头的组合按钮。通用文本点击会命中外层容器而不展开
  // 数据源菜单；这里固定点击真实 button，并且只选择配置中心的公共 MySQL 数据源
  // （按 /mysql/i 类型匹配，具体数据源实例由环境配置决定，spec 不持有数据源名称）。
  const newTable = page.getByRole('button', { name: /^新建表/ }).last();
  const source = page.getByRole('menuitem', { name: /mysql/i }).last();
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
  if (!opened) return false;
  await source.click({ force: true });
  // 新版表单在数据库选中后先展示“语句添加”，再加载保存按钮。
  await expect(page.getByText('语句添加', { exact: true }).last()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /保\s*存/ }).last()).toBeVisible({ timeout: 15_000 });
  return true;
}

const fieldRows = (page: Page) => page.locator([
  'tbody > tr:visible',
  '.ant-table-tbody > tr:visible',
  '.el-table__body-wrapper tr:visible',
  '[role="row"]:visible:not(:has([role="columnheader"]))',
].join(', '));

/**
 * 必填未填全保存必须被拦截（保留原断言语义）。校验提示优先在表单项/表单区域内匹配
 * （腾讯文档辅助审查 20260902-092549 第 136 条意见，口径同 DM-03-02）；
 * 区域内未命中时回退原全页匹配并显式告警，供 headed 校准确认。
 */
async function expectRequiredSaveBlocked(page: Page, stage: string): Promise<void> {
  await page.getByRole('button', { name: /保\s*存/ }).last().click();
  const itemHint = page.locator('.ant-form-item:visible, .el-form-item:visible, .form-item:visible')
    .filter({ hasText: /必填|不能为空|请选择|请输入/ }).first();
  let hint: Locator = itemHint;
  if (!(await itemHint.isVisible().catch(() => false))) {
    const form = page.locator('form:visible, .ant-form:visible, .el-form:visible').last();
    if (await form.isVisible().catch(() => false)) hint = form.getByText(/必填|不能为空|请选择|请输入/).first();
  }
  let scoped = false;
  try {
    await expect(hint, `${stage}：必填未填全保存应在表单项/表单区域内出现校验提示`)
      .toBeVisible({ timeout: 10_000 });
    scoped = true;
  } catch {
    // 回退：保留原 DM-02-02 全页匹配口径作为兜底证据，不删除原断言语义。
    hint = page.getByText(/必填|不能为空|请选择|请输入/).first();
    await expect(hint, `${stage}：必填未填全保存应出现校验提示（全页回退匹配）`)
      .toBeVisible({ timeout: 10_000 });
    console.warn(`[calibration] ${stage}：校验提示走了全页回退匹配，headed 轮应确认表单区域定位。`);
  }
  await expect(page, `${stage}：被拦截的保存不应离开建表表单`)
    .not.toHaveURL(/#\/dataMap\/tableManage\/tablesManage/);
  const successToast = page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
    .filter({ hasText: /成功/ });
  await expect(successToast.first(), `${stage}：被拦截的保存不应出现成功反馈`).not.toBeVisible();
}


// ==================== 本轮自建资产清理（DS-PERM-63） ====================

/** 仅合法 MySQL 标识符（≤64 字符）才可能是本轮真实物理表；非法探针名直接跳过物理回收。 */
function isDroppablePhysicalName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && name.length <= 64;
}

/** 尽力回收本轮物理表（dbConfig() 缺失或 DROP 失败只告警，不掩埋用例结果）。 */
async function dropRoundPhysicalTables(names: string[]): Promise<void> {
  const droppable = [...new Set(names)].filter(isDroppablePhysicalName);
  if (!droppable.length) return;
  if (!dbConfig()) {
    console.warn(`[cleanup] DB 未配置：本轮物理表未回收（${droppable.join(', ')}），元数据按 UUID 可追溯。`);
    return;
  }
  for (const name of droppable) {
    try {
      await query(`DROP TABLE IF EXISTS \`${name}\``);
    } catch (error) {
      console.warn(`[cleanup] 本轮物理表 ${name} DROP 失败（尽力而为）：`, error);
    }
  }
}

/** 行内操作定位（口径同 DM-03-02 manageRowAction）：仅接受精确“删除/移除”文本，避免误触其它列。 */
async function findRowAction(page: Page, row: Locator, name: RegExp): Promise<Locator | undefined> {
  const selectors = 'button:visible, a:visible, .el-link:visible, [role="button"]:visible, [class*="link"]:visible';
  for (const scope of [row.locator(selectors), row.locator('td:visible').last().locator(selectors)]) {
    for (let index = await scope.count() - 1; index >= 0; index -= 1) {
      const candidate = scope.nth(index);
      const text = (await candidate.innerText().catch(() => '')).replace(/\s+/g, '');
      if (name.test(text) && (await candidate.isVisible().catch(() => false))) return candidate;
    }
  }
  return undefined;
}

/** 元数据行内删除入口尽力而为：入口不存在（当前版本未提供）时仅告警保留，UUID 可追溯。 */
async function deleteRoundMetadataRows(page: Page, names: string[]): Promise<void> {
  for (const name of new Set(names)) {
    try {
      let filter = page.locator('input:visible:not([type="checkbox"]):not([type="radio"])').first();
      if (!(await filter.isVisible().catch(() => false))) {
        // 用例结束页可能仍停在表单页：尝试一次菜单导航回列表（失败则放弃页面侧回收）。
        await clickMenu(page, '数据地图', '表管理').catch(() => undefined);
        const leaf = page.locator('a[href="#/dataMap/tableManage/tablesManage"]:visible').last();
        if (await leaf.isVisible().catch(() => false)) await leaf.click().catch(() => undefined);
        await page.waitForTimeout(500);
        filter = page.locator('input:visible:not([type="checkbox"]):not([type="radio"])').first();
        if (!(await filter.isVisible().catch(() => false))) {
          console.warn(`[cleanup] 未回到表管理列表，跳过“${name}”元数据页面侧回收（UUID 可追溯）。`);
          continue;
        }
      }
      await filter.fill(name);
      const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
      if (await queryButton.isVisible().catch(() => false)) await queryButton.click();
      const row = fieldRows(page).filter({ hasText: name }).first();
      if (!(await row.isVisible({ timeout: 3_000 }).catch(() => false))) continue;
      const action = await findRowAction(page, row, /^删\s*除$|^移\s*除$/);
      if (!action) {
        console.warn(`[cleanup] 表管理未提供“${name}”行内删除/移除入口，元数据保留（UUID 可追溯）。`);
        continue;
      }
      await action.click();
      const dialog = page.getByRole('dialog').last();
      const confirm = (await dialog.isVisible().catch(() => false))
        ? dialog.getByRole('button', { name: /^确\s*定$/ }).last()
        : page.getByRole('button', { name: /^确\s*定$/ }).last();
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
    } catch (error) {
      console.warn(`[cleanup] 本轮元数据“${name}”页面侧回收失败（尽力而为）：`, error);
    }
  }
}

/** finally 专用：仅清理本轮 UUID 自建表（物理表 + 元数据行内入口），全部尽力而为、只告警不抛错。 */
async function cleanupRoundTables(page: Page, names: string[]): Promise<void> {
  if (!names.length) return;
  await dropRoundPhysicalTables(names);
  await deleteRoundMetadataRows(page, names);
}

test.describe('DM-02-02｜数据地图｜新建表：必填项为空、表名过长、特殊字符和重复表名', () => {
  test.describe.configure({ timeout: 300_000 });

  // 原 beforeEach(openTableManageLeaf) 改为用例内真实菜单导航（DM-03-02 口径），
  // 便于与 try/finally 清理保持同一生命周期。
  test('DM-02-02｜数据地图新建表：必填项为空保存被拦截', async ({ loginPage, consoleErrors, report }, testInfo) => {
    const page = loginPage;
    const roundTables: string[] = [];
    try {
      await openTableManage(page);
      if (!(await openCreateTableEntry(page))) {
        await report('新建表-必填校验', false, '环境前置缺失：新建表下拉未提供 MySQL 数据源，无法进入建表表单，跳过。');
        testInfo.skip();
        return;
      }
      // 不填任何必填项直接保存：应出现校验提示且不离开建表表单。
      // 本用例正常不建表；登记探针表名仅为防产品行为异常导致落表后可回收。
      const tableName = `e2e_dm0202_${uuid()}`;
      roundTables.push(tableName);
      await expectRequiredSaveBlocked(page, '必填项为空');
      await assertNoConsoleErrors(consoleErrors);
      await report('新建表-必填校验', true, `必填项为空保存被拦截（校验提示可见，未离开表单、无成功反馈）；本轮探针表名（未保存）：${tableName}`);
    } finally {
      await cleanupRoundTables(page, roundTables);
    }
  });
});
