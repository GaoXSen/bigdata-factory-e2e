/**
 * 来源：2026-09-19 湖南中行 E2E 自动化生成 / DM-02-03
 * 数据地图新建表必填项与字段类型校验。
 *
 * 2026-09-22（DS-PERM-63 清洁环境迁移）：
 * - 移除对旧“gauss”数据源的硬依赖（openCreateTable(page,'gauss')、selectTargetDataSource
 *   (page,'gauss')）：改用配置中心的公共 MySQL 数据源（/mysql/i 类型匹配，具体实例由环境
 *   配置决定）；下拉未提供 MySQL 数据源＝环境前置缺失，上报证据后条件跳过。
 * - 负责人不再取下拉首项（旧数据假设）：口径同 DM-00-03，优先缺省管理员（admin，与配置
 *   中心登录账号 TEST_USER 缺省一致），否则首个可选项；下拉为空＝环境前置缺失，条件跳过。
 * - 超长/唯一性探针名统一 UUID 化，保证清洁环境可重复执行；长度校验提示优先在消息/
 *   表单区域内匹配（腾讯文档辅助审查 20260902-092549 第 136 条意见），原全页匹配保留为
 *   回退；特殊字符链路保留“拦截或接受都有明确反馈”的两分支契约，并如实上报实际分支。
 * - 登记本轮表名并在 finally 仅清理本轮表（物理表尽力 DROP + 元数据行内入口尽力删除），
 *   清理失败只告警、不掩埋用例真实结果。
 * - 硬链接双入口兼容：仅从 ../utils.js 与 ../抽样用例工具.js 取工具与配置（query/dbConfig()
 *   等），不直接相对引用 e2e/test-environment.ts（孪生路径相对深度不同会断链）。
 */
import { test, expect, uuid, clickMenu, assertNoConsoleErrors, query, dbConfig } from '../utils.js';
import { chooseFirstOption, clickFormControlByLabel, clickVisible, fillFormField } from '../抽样用例工具.js';
import type { Locator, Page, TestInfo } from '@playwright/test';

const fieldRows = (page: Page) => page.locator([
  'tbody > tr:visible',
  '.ant-table-tbody > tr:visible',
  '.el-table__body-wrapper tr:visible',
  '[role="row"]:visible:not(:has([role="columnheader"]))',
].join(', '));

async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  for (let index = 0; index < await locator.count(); index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

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


async function chooseFirstFormOption(page: Page, label: RegExp): Promise<void> {
  // 2026-09-20：clickFormControlByLabel 对新下拉会命中不可点击的搜索 input 导致超时，
  // 因此改用“从 label 向上逐层父链找真实 select 包裹层”（≤4 层）后点击展开并选首项。
  const candidates = page.getByText(label).filter({ visible: true });
  for (let index = await candidates.count() - 1; index >= 0; index -= 1) {
    let scope = candidates.nth(index);
    for (let level = 0; level < 4; level += 1) {
      const wrapper = await firstVisible(scope.locator('select:visible, .ant-select:visible, .el-select:visible'));
      if (wrapper) {
        await wrapper.click();
        const option = page.locator(
          '.el-select-dropdown:visible .el-select-dropdown__item, .ant-select-dropdown:visible .ant-select-item, ' +
            '[role="listbox"]:visible [role="option"], .el-dropdown-menu:visible li',
        ).filter({ visible: true }).first();
        await option.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
        if (!(await option.isVisible().catch(() => false))) {
          await page.keyboard.press('Escape').catch(() => undefined);
          break;
        }
        await option.click();
        return;
      }
      scope = scope.locator('..');
    }
  }
  try {
    const control = await clickFormControlByLabel(page, label);
    await chooseFirstOption(page, control, String(label));
  } catch (error) {
    // schema、主领域和安全等级在当前环境可能非必填且没有可选数据；不能把这些
    // 可选项误判成建表主流程失败，必填项仍继续抛错。
    if (/schema|主领域|主题域|安全等级/i.test(String(label))) return;
    throw error;
  }
}

/**
 * 负责人解析（口径同 DM-00-03 selectOwner）：下拉中优先缺省管理员（admin，与配置中心
 * 登录账号 TEST_USER 缺省一致），否则首个可选项；返回 'owner-empty' 表示下拉无可选项，
 * 属环境前置缺失，由用例上报证据后条件跳过，不假设任何旧负责人数据。
 */
async function pickOwnerFormOption(page: Page): Promise<'selected' | 'owner-empty'> {
  const pickFromOpenedDropdown = async (): Promise<'selected' | 'owner-empty'> => {
    const options = page.locator(
      '.el-select-dropdown:visible .el-select-dropdown__item, .ant-select-dropdown:visible .ant-select-item, ' +
        '[role="listbox"]:visible [role="option"], .el-dropdown-menu:visible li',
    ).filter({ visible: true });
    const first = options.first();
    if (!(await first.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false))) {
      await page.keyboard.press('Escape').catch(() => undefined);
      return 'owner-empty';
    }
    const preferred = options.filter({ hasText: /admin/i }).first();
    if (await preferred.isVisible().catch(() => false)) {
      await preferred.click();
      return 'selected';
    }
    await first.click();
    return 'selected';
  };
  // 逐候选（从后往前）在 ≤4 层父链内定位真实 select 包裹层，避免“字段信息”列头同名
  // 文字把锚点选错（口径同 DM-03-02）。
  const candidates = page.getByText(/负责人/).filter({ visible: true });
  for (let index = await candidates.count() - 1; index >= 0; index -= 1) {
    let scope = candidates.nth(index);
    for (let level = 0; level < 4; level += 1) {
      const wrapper = await firstVisible(scope.locator('select:visible, .ant-select:visible, .el-select:visible'));
      if (wrapper) {
        await wrapper.click();
        return await pickFromOpenedDropdown();
      }
      scope = scope.locator('..');
    }
  }
  // 兜底：共享工具的可见控件查找（保持原语义）。
  const control = await clickFormControlByLabel(page, /负责人/);
  await control.click();
  return await pickFromOpenedDropdown();
}


async function fillManageField(page: Page, labels: string[], value: string): Promise<void> {
  await fillFormField(page, new RegExp(labels.join('|'), 'i'), value);
}

async function fillDirectFieldRows(page: Page): Promise<void> {
  const rows = fieldRows(page);
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const inputs = row.locator('input:visible');
    if (await inputs.count() > 1) await inputs.nth(1).fill(`字段${index + 1}`);
    // 数据类型带 * 是必填项。测试准备表统一使用页面支持且跨环境兼容性最好的
    // VARCHAR，避免“看起来有字段、实际保存时类型为空”或超长类型被后端拒绝。
    const typeControl = row.locator(
      'select:visible, .el-select:visible, .ant-select:visible, .ant-select-selector:visible, ' +
        '[role="combobox"]:visible, input[placeholder*="类型"]:visible',
    ).first();
    if (!(await typeControl.count())) throw new Error(`字段第 ${index + 1} 行未找到数据类型必填控件。`);
    const tagName = await typeControl.evaluate((element) => element.tagName.toLowerCase()).catch(() => '');
    if (tagName === 'select') {
      const options = typeControl.locator('option');
      let selected = false;
      for (let optionIndex = 0; optionIndex < await options.count(); optionIndex += 1) {
        const option = options.nth(optionIndex);
        const text = (await option.innerText().catch(() => '')).trim();
        if (/varchar|char/i.test(text)) {
          await typeControl.selectOption({ label: text });
          selected = true;
          break;
        }
      }
      if (!selected) throw new Error(`字段第 ${index + 1} 行没有 VARCHAR/CHAR 类型选项。`);
    } else {
      await typeControl.click({ force: true });
      const searchInput = page.locator('.ant-select-search__field:visible, input[placeholder*="搜索"]:visible').last();
      if (await searchInput.isVisible().catch(() => false)) await searchInput.fill('VARCHAR');
      else await page.keyboard.type('VARCHAR');
      const option = page.locator(
        '.el-select-dropdown__item:visible, .ant-select-item-option:visible, ' +
          '.ant-select-dropdown-menu-item:visible, [role="listbox"] [role="option"]:visible',
      ).filter({ hasText: /VARCHAR|CHAR(?:ACTER)?/i }).last();
      if (await option.isVisible().catch(() => false)) await option.click({ force: true });
      else await page.keyboard.press('Enter');
    }
    const lengthInput = row.locator('input[placeholder*="长度"], input[type="number"], [role="spinbutton"]').first();
    if (await lengthInput.isVisible().catch(() => false)) await lengthInput.fill('64');
  }
}

/** 补一条合法直接添加字段（唯一 ASCII 字段名 + VARCHAR/长度64），确保第二次保存校验的是表名本身而非“字段为空”。 */
async function addOneValidDirectField(page: Page, fieldName: string): Promise<void> {
  await clickVisible(page, /直接添加字段|直接添加|添加字段|新增字段/);
  await fieldRows(page).last().locator('input').first().fill(fieldName);
  await fillDirectFieldRows(page);
}

/** 一次性补齐与表名无关的必填项，避免保存校验命中的是其它必填缺失而不是表名规则。 */
async function fillRequiredTableBasics(page: Page, chineseName: string): Promise<'ok' | 'owner-empty'> {
  await fillFormField(page, /表中文名称|表中文名/, chineseName);
  for (const label of [/数据层级/, /库.?层级/]) {
    await chooseFirstFormOption(page, label);
  }
  const ownerState = await pickOwnerFormOption(page);
  for (const label of [/schema/i, /主领域|主题域/, /安全等级/]) {
    await chooseFirstFormOption(page, label); // 可选项缺失在 helper 内按原口径放行
  }
  // 数据生命周期等必填配置一次性补齐（0914 轮教训：漏配会在提交时被校验拦截且无正向提示）。
  await chooseFirstFormOption(page, /数据生命周期/);
  await chooseFirstFormOption(page, /操作类型/);
  const noConfirm = page.getByRole('radio', { name: '否', exact: true }).last();
  if (await noConfirm.isVisible().catch(() => false)) await noConfirm.check();
  return ownerState === 'owner-empty' ? 'owner-empty' : 'ok';
}


/**
 * 超长表名保存反馈（保留原断言语义：出现长度类校验反馈）。优先在消息/表单区域内匹配
 * （避免列表“长度”列头等静态文字造成假通过——腾讯文档辅助审查 20260902-092549
 * 第 136 条意见口径）；区域内未命中时回退原全页匹配并显式告警，供 headed 校准确认。
 */
async function expectLengthValidationFeedback(page: Page): Promise<void> {
  const lengthPattern = /长度|不能超过|过长|超出/;
  const scoped = page.locator(
    '.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible, ' +
      '.ant-form-item:visible, .el-form-item:visible, .form-item:visible',
  ).filter({ hasText: lengthPattern }).first();
  const appeared = await scoped.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
  if (!appeared) {
    console.warn('[calibration] 超长表名校验提示未在消息/表单区域命中，回退全页匹配（headed 轮应校准定位）。');
    await expect(page.getByText(lengthPattern).first(), '超长表名保存应出现长度校验提示').toBeVisible({ timeout: 10_000 });
  }
  await expect(page, '超长表名保存不应离开建表表单').not.toHaveURL(/#\/dataMap\/tableManage\/tablesManage/);
  const successToast = page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
    .filter({ hasText: /成功/ });
  await expect(successToast.first(), '超长表名保存不应出现成功反馈').not.toBeVisible();
}

/**
 * 特殊字符表名的两分支契约（保留原用例“拦截或接受都有明确反馈”的语义）：仅当出现表名
 * 相关校验反馈时判 rejected，其余情况如实上报实际分支/超时，由真实结果决定用例成败，
 * 不写死通过。
 */
async function expectSpecialCharOutcome(page: Page): Promise<'rejected' | 'accepted' | 'timeout'> {
  const nameValidation = page
    .locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
    .filter({ hasText: /不合法|格式|只允许|非法|校验/ })
    .first();
  const saveButton = page.getByRole('button', { name: /保\s*存/ });
  let outcome: 'rejected' | 'accepted' | 'timeout' = 'timeout';
  await expect.poll(async () => {
    if (await nameValidation.isVisible().catch(() => false)) {
      outcome = 'rejected';
      return 'rejected';
    }
    let saveVisible = false;
    for (let index = 0; index < await saveButton.count(); index += 1) {
      if (await saveButton.nth(index).isVisible().catch(() => false)) {
        saveVisible = true;
        break;
      }
    }
    if (!saveVisible) {
      outcome = 'accepted';
      return 'accepted';
    }
    return 'waiting';
  }, { timeout: 10_000 }).toMatch(/^(rejected|accepted)$/);
  return outcome;
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


test.describe('DM-02-03｜数据地图｜新建表必填项与字段类型校验', () => {
  test.describe.configure({ timeout: 300_000 });

  test('DM-02-03｜数据地图新建表必填项与字段类型校验', async ({ loginPage, consoleErrors, report }, testInfo) => {
    const page = loginPage;
    const roundTables: string[] = [];
    try {
      await openTableManage(page);
      if (!(await openCreateTableEntry(page))) {
        await report('新建表-边界值校验', false, '环境前置缺失：新建表下拉未提供 MySQL 数据源，无法进入建表表单，跳过。');
        testInfo.skip();
        return;
      }
      // 唯一 ASCII 超长探针名（>64 字符，MySQL 标识符上限），本轮 UUID 保证可重复执行不撞历史。
      const longName = `t_${'a'.repeat(190)}_${uuid()}`;
      // 特殊字符探针名按用例语义保留非 ASCII（中文/空格/连字符），UUID 保证唯一。
      const specialName = `表名 空-格&符${uuid()}`;
      roundTables.push(longName, specialName);
      const chineseName = `边界表名_${uuid()}`;
      // 先补齐与表名无关的必填项，避免保存校验的是数据层级/负责人等缺失项而不是表名规则。
      const ownerState = await fillRequiredTableBasics(page, chineseName);
      if (ownerState === 'owner-empty') {
        await report('新建表-边界值校验', false, '环境前置缺失：负责人下拉无可选项（清洁环境应至少包含缺省管理员），跳过。');
        testInfo.skip();
        return;
      }
      await fillManageField(page, ['表名称', '表名'], longName);
      await page.getByRole('button', { name: /保\s*存/ }).last().click();
      // 超长名：应被校验拦截或提示长度超限。
      await expectLengthValidationFeedback(page);
      // 补一条合法字段，确保第二次保存校验的是表名，而不是“字段信息不能为空”。
      await addOneValidDirectField(page, 'id');
      // 特殊字符（中文/连字符/空格）：按实际产品行为可能拦截也可能允许保存；两种结果都必须有明确反馈。
      await fillManageField(page, ['表名称', '表名'], specialName);
      await page.getByRole('button', { name: /保\s*存/ }).last().click();
      const outcome = await expectSpecialCharOutcome(page);
      await assertNoConsoleErrors(consoleErrors);
      await report(
        '新建表-边界值校验',
        true,
        `超长探针=${longName}（保存被拦截且有长度校验提示）；特殊字符探针=${specialName} 产品行为=${outcome}`
          + `；若被接受，本轮表已在 finally 尽力回收。`,
      );
    } finally {
      await cleanupRoundTables(page, roundTables);
    }
  });
});
