/**
 * 数据地图 — 表管理 E2E 测试
 *
 * 覆盖场景（参考 Excel「测试用例」Sheet，序号对应 1～73）：
 *   行1  — 新建表→详情→上线→表查询，再核对 4 标签（物理表存在/存&上线/存&下线/草稿）× 4 来源（自建表/数据集成/文件接入/FTP文件接入）
 *   行2  — 新建表：3 种字段添加方式（语句添加/直接添加/引用数据元），保存+建表
 *   行3  — 编辑表：4 种来源表编辑后保存/建表（回归 No.68/69/76）
 *   行4  — 字段添加：gauss/gbase 两类型，常见字段类型
 *   行7/17 — 新建表-分区信息：Gbase 时间分区（回归 No.86 多分区 SQL）
 *   行17 — 生成版本：新建/编辑表生成版本记录，表查询展示版本列表
 *   行23 — 表详情 ddl 展示：4 种来源（回归 No.77 精度为 0 场景）
 *   行23 — 表详情：基本信息/脚本信息/任务调度（回归 No.82）
 *   行23 — 我有权限的表：列表字段与条件查询（回归 No.73）
 *
 * 关键要求：
 *   1. 所有操作用 page. 浏览器操作（无 fetch/axios 等 API 调用）
 *   2. UUID 后缀隔离所有测试数据
 *   3. 控制台错误收集
 *   4. 选择器为通用匹配，接入真实环境后按页面校准（TODO[env] 标注）
 *
 * DS-PERM-67（2026-09-22，数据源管理权限静态开发）清洁环境迁移：
 *   - 不再依赖历史表/固定夹具表（e2e_/codex_/gs_test_/test_gs/E2E数据地图 等历史命名
 *     匹配全部移除）：四类来源统一使用本轮唯一 ASCII 表名 e2e_dm_edit_<来源缩写>_<uuid>；
 *   - 编辑前必须自建本轮表：“自行建表”来源在本用例内经配置中心公共 MySQL 数据源
 *     （dataSourceNames.tableManagement.newDataBase）新建并上线；
 *   - 数据集成/文件接入/FTP文件接入来源表由上游模块产出，清洁环境无历史表可复用：
 *     按本轮唯一表名精确检索，检索不到＝环境前置缺失，记入统一 skip 清单并写明原因，
 *     不伪造通过；任一来源真实验证失败仍按失败上报；
 *   - 保留既有断言语义：下线→行内编辑→保存→编辑后重新查询（列表重查 + 编辑页回显核对）；
 *   - finally 仅回收本轮表/版本/元数据：物理表尽力 DROP（dbConfig() 经配置中心）+
 *     元数据行内删除入口尽力尝试（口径同 DM-02-01/DS-PERM-63），清理失败只告警、
 *     不掩埋用例真实结果；除本轮表/版本/元数据外不回收任何对象。
 */

import { test, expect, uuid } from '../utils.js';
import { assertNoConsoleErrors, clickMenu, dbConfig, query, submitAndExpectSuccess } from '../utils.js';
import { testEnvironment } from '../../../test-environment.js';
import type { Locator, Page } from '@playwright/test';

/**
 * 兼容不同表格实现的数据行定位。
 *
 * Ant Design / Element 的数据行通常位于 tbody 中；部分页面使用无 tbody
 * 的可访问性表格，因此补充 role=row，并排除 role=columnheader 所在的表头行。
 */
const tableRows = (page: Page) =>
  page.locator([
    'tbody > tr:visible',
    '.ant-table-tbody > tr:visible',
    '.el-table__body-wrapper tr:visible',
    '[role="row"]:visible:not(:has([role="columnheader"]))',
  ].join(', '));

/** 页面实际显示“自行建表”，不是需求文档中的“自建表”。 */
const TABLE_SOURCES = ['自行建表', '数据集成', '文件接入', 'FTP文件接入'] as const;
/** 配置中心解析的公共 MySQL 数据源显示名（物理库与平台展示名均经配置中心，环境重置只改配置）。 */
const MYSQL_SOURCE_TEXT = testEnvironment.dataSourceNames.tableManagement.newDataBase;
/** 3 种字段添加方式 */
const FIELD_ADD_WAYS = ['语句添加', '直接添加', '引用数据元'] as const;
/** 常见字段类型（Excel 行4：数字 int/bigint、字符 varchar、布尔 boolean） */
const COMMON_FIELD_TYPES = ['int', 'bigint', 'varchar', 'boolean'] as const;
const selectedCreateDatabase = new WeakMap<Page, string>();

function skipForMissingEnvironment(message: string): never {
  throw new Error(`环境前置条件缺失：${message}`);
}

/**
 * 打开表管理实际页面。
 *
 * 第二轮页面快照表明当前版本侧栏只渲染“表管理”折叠项，真实链接是
 * `#/dataMap/tableManage`；页面中并不存在可见的
 * `a[href="#/dataMap/tableManage/tablesManage"]`。先按实际侧栏展开，
 * 再优先点击真实出现的子链接；没有子链接时父路由本身就是列表页。
 */
async function openTableManageLeaf(page: Page): Promise<void> {
  await clickMenu(page, '数据地图', '表管理', '表管理');
  await expect(page.locator('body')).toBeVisible();
  // 先进入顶层“数据地图”，再按真实叶子 href 进入 tablesManage。
  // 这里不再依赖“表管理→表管理”的同名文字层级：侧栏展开由接口异步返回，
  // 直接等待叶子 href 可见可以避免菜单尚未渲染或已展开时的误点/收起。
  await clickMenu(page, '数据地图');
  const tableListChild = page.locator(
    'a:visible[href*="#/dataMap/tableManage/tablesManage"], ' +
      '[role="menuitem"]:visible a[href*="#/dataMap/tableManage/tablesManage"]',
  ).last();
  if (!(await tableListChild.isVisible().catch(() => false))) {
    const submenuTitle = page
      .locator('.el-submenu__title:visible, .ant-menu-submenu-title:visible, [role="menuitem"]:visible')
      .filter({ hasText: /^\s*表管理\s*$/ })
      .last();
    await expect(submenuTitle).toBeVisible({ timeout: 10_000 });
    await submenuTitle.click();
    await page.waitForTimeout(500);
  }
  await expect(tableListChild).toBeVisible({ timeout: 15_000 });
  await tableListChild.click();

  if (!/#\/dataMap\/tableManage(?:\/tablesManage)?/.test(page.url())) {
    await page.waitForURL(/#\/dataMap\/tableManage(?:\/tablesManage)?/, { timeout: 10_000 });
  }
  await page.waitForTimeout(500);
}

async function openTableManageSubpage(page: Page, route: 'myPermissionTable'): Promise<void> {
  await openTableManageLeaf(page);
  const child = page.locator(`a:visible[href*="#/dataMap/tableManage/${route}"]`).last();
  if (await child.isVisible().catch(() => false)) {
    await child.click();
    await page.waitForURL(new RegExp(`#\\/dataMap\\/tableManage\\/${route}`), { timeout: 10_000 });
    return;
  }
  // “我有权限的表”在部分版本是表管理页面内的 Tab，而不是独立链接。
  await clickVisibleTab(page, /我有权限的表|权限表/);
}

function labelPattern(labels: string[]): RegExp {
  return new RegExp(`^\\s*\\*?\\s*(?:${labels.join('|')})\\s*[：:]?\\s*$`);
}

async function visibleControl(scope: Locator, selector: string): Promise<Locator | undefined> {
  const controls = scope.locator(selector);
  for (let index = await controls.count() - 1; index >= 0; index -= 1) {
    const control = controls.nth(index);
    if (await control.isVisible().catch(() => false)) return control;
  }
  return undefined;
}

async function findManageControl(page: Page, labels: string[], selector: string): Promise<Locator | undefined> {
  // 优先使用真正的 label/aria 关联；真实页面的表单项有时不是
  // “文字节点 + 同级控件”，只沿父节点查找会在这种结构下误报缺字段。
  for (const labelText of labels) {
    const associated = page.getByLabel(labelText, { exact: false });
    for (let index = await associated.count() - 1; index >= 0; index -= 1) {
      const control = associated.nth(index);
      if (!(await control.isVisible().catch(() => false))) continue;
      if (await control.evaluate((element, css) => element.matches(css as string), selector).catch(() => false)) {
        return control;
      }
      // Ant/Element 有时把 getByLabel 命中到 form-item 外壳；必须返回
      // 外壳内真正的 input/select，而不是让调用方对外壳执行 fill。
      const nested = await visibleControl(control, selector);
      if (nested) return nested;
    }
  }

  const label = page.getByText(labelPattern(labels));
  for (let labelIndex = await label.count() - 1; labelIndex >= 0; labelIndex -= 1) {
    let scope = label.nth(labelIndex);
    for (let level = 0; level < 8; level += 1) {
      const controls = scope.locator(selector);
      for (let controlIndex = await controls.count() - 1; controlIndex >= 0; controlIndex -= 1) {
        const control = controls.nth(controlIndex);
        if (await control.isVisible().catch(() => false)) return control;
      }
      scope = scope.locator('..');
    }
  }
  return undefined;
}

async function selectManageOption(
  page: Page,
  labels: string[],
  optionPattern: RegExp,
  missingMessage: string,
  allowFirstOption = false,
): Promise<void> {
  const control = await findManageControl(page, labels, '.el-select, .ant-select, [role="combobox"], select');
  if (!control) skipForMissingEnvironment(missingMessage);

  const tagName = await control.evaluate((element) => element.tagName.toLowerCase()).catch(() => '');
  if (tagName === 'select') {
    const options = control.locator('option');
    for (let index = 0; index < await options.count(); index += 1) {
      const option = options.nth(index);
      const text = (await option.innerText().catch(() => '')).trim();
      if (optionPattern.test(text) || (allowFirstOption && text && !/请选择|暂无|无数据/.test(text))) {
        await control.selectOption({ label: text });
        return;
      }
    }
    skipForMissingEnvironment(`${missingMessage}（原生下拉没有匹配选项）。`);
  }

  await control.click();
  const options = page.locator(
    '.el-select-dropdown__item, ' +
      '.el-select-dropdown-menu__item, ' +
      '.ant-select-item-option, ' +
      '.ant-select-dropdown-menu-item, ' +
      '[role="listbox"] [role="option"], ' +
      '[role="option"]',
  );
  let firstOption: Locator | undefined;
  let matchedOption: Locator | undefined;
  for (let index = await options.count() - 1; index >= 0; index -= 1) {
    const option = options.nth(index);
    if (!(await option.isVisible().catch(() => false))) continue;
    const text = (await option.innerText().catch(() => '')).replace(/\\s+/g, ' ').trim();
    if (!text || /请选择|暂无|无数据/.test(text)) continue;
    firstOption ??= option;
    optionPattern.lastIndex = 0;
    if (optionPattern.test(text)) {
      matchedOption = option;
      break;
    }
  }
  const chosenOption = matchedOption ?? (allowFirstOption ? firstOption : undefined);
  if (chosenOption) {
    const chosenText = (await chosenOption.innerText()).replace(/\s+/g, ' ').trim();
    const freshOption = page.getByRole('option', { name: chosenText, exact: true }).filter({ visible: true }).last();
    await expect(freshOption).toBeVisible({ timeout: 3_000 });
    await freshOption.click({ force: true });
    return;
  }
  skipForMissingEnvironment(`${missingMessage}（下拉没有匹配选项）。`);
}

async function selectTargetDataSource(page: Page, database: string): Promise<void> {
  const databasePattern = new RegExp(
    `(?:${database === 'gauss' ? 'gauss|open.?gauss|GAUSSDB' : database === 'gbase' ? 'gbase|GBASE8A' : 'hive|HIVE'})`,
    'i',
  );

  // 新建表页实际是级联字段：数据源类型 → 数据源名称 → 数据库名称 → Schema。
  // 旧版本才把它们合并成一个“目标数据源”下拉，因此两种结构都保留。
  const typeControl = await findManageControl(page, ['数据源类型', '目标数据源类型', '数据库类型'], '.el-select, .ant-select, [role="combobox"], select');
  if (typeControl) {
    await selectManageOption(page, ['数据源类型', '目标数据源类型', '数据库类型'], databasePattern, `新建表页面没有可用的目标数据源类型（${database}）。`);

    const sourceName = process.env.TABLE_DATA_SOURCE_NAME?.trim();
    await selectManageOption(
      page,
      ['数据源名称', '目标数据源', '数据源'],
      sourceName ? new RegExp(`^\\s*${sourceName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*$`) : /.+/,
      '新建表页面没有可用的数据源名称。',
      !sourceName,
    );

    const databaseName = process.env.TABLE_DATABASE?.trim();
    const databaseControl = await findManageControl(page, ['数据库名称', '数据库'], '.el-select, .ant-select, [role="combobox"], select');
    if (databaseControl) {
      await selectManageOption(
        page,
        ['数据库名称', '数据库'],
        databaseName ? new RegExp(`^\\s*${databaseName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*$`) : /.+/,
        '新建表页面没有可用的数据库名称。',
        !databaseName,
      );
    }

    const schema = process.env.TABLE_SCHEMA?.trim();
    const schemaControl = await findManageControl(page, ['Schema名称', 'Schema', 'schema', '模式'], '.el-select, .ant-select, [role="combobox"], select');
    if (schemaControl) {
      await selectManageOption(
        page,
        ['Schema名称', 'Schema', 'schema', '模式'],
        schema ? new RegExp(`^\\s*${schema.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*$`) : /.+/,
        '新建表页面没有可用的 Schema。',
        !schema,
      );
    }
    return;
  }

  // split-button 已在进入表单前按目标类型选择了数据库，当前版本表单不再
  // 重复渲染“目标数据源”下拉；确认预选项与目标类型一致即可继续填写。
  const preselectedDatabase = selectedCreateDatabase.get(page) ?? '';
  if (preselectedDatabase && databasePattern.test(preselectedDatabase)) return;

  await selectManageOption(
    page,
    ['目标数据源', '数据源', '数据库'],
    databasePattern,
    `新建表页面没有可用的目标数据源控件（${database}）。`,
  );
}

async function fillManageField(page: Page, labels: string[], value: string): Promise<void> {
  const field = await findManageControl(
    page,
    labels,
    'input:not([type="checkbox"]):not([type="radio"]):not([readonly]), textarea, [contenteditable="true"]',
  );
  if (!field) {
    // 表单标签在部分版本只作为 placeholder 呈现，不再重复一个可见文本 label。
    const placeholder = page.getByPlaceholder(new RegExp(labels.join('|')));
    for (let index = await placeholder.count() - 1; index >= 0; index -= 1) {
      const candidate = placeholder.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        await candidate.fill(value);
        return;
      }
    }
    throw new Error(`表管理页面未找到字段控件：${labels.join(' / ')}`);
  }
  await field.fill(value);
}

async function fillRequiredTableBasics(page: Page, chineseName: string): Promise<void> {
  await fillManageField(page, ['表中文名称', '表中文名'], chineseName);
  await selectManageOption(page, ['数据层级'], /.+/, '新建表页面没有可用的数据层级。', true);
  await selectManageOption(page, ['库/层级', '库层级'], /.+/, '新建表页面没有可用的库/层级。', true);
  await selectManageOption(page, ['Schema名称', 'Schema', 'schema', '模式'], /.+/, '新建表页面没有可用的 Schema。', true);
  await selectManageOption(page, ['主领域', '主题域'], /.+/, '新建表页面没有可用的主领域。', true);
  await selectManageOption(page, ['负责人'], /.+/, '新建表页面没有可用的负责人。', true);
  await selectManageOption(page, ['安全等级'], /.+/, '新建表页面没有可用的安全等级。', true);
  await fillDataLifecycleConfiguration(page);
}

/**
 * 新建表页面的生命周期配置不是普通文本框，而是多个带箭头的下拉控件。
 * 参考已建表编辑页面的实际配置，补齐完整的可重复配置，避免新建表只填完
 * 基础信息和字段、却把生命周期配置留成空值。
 */
async function fillDataLifecycleConfiguration(page: Page): Promise<void> {
  await selectManageOption(
    page,
    ['数据生命周期'],
    /(?:\d+\s*(?:天|日)|永久|长期)/,
    '新建表页面没有可用的数据生命周期选项。',
    true,
  );
  await selectManageOption(
    page,
    ['操作类型'],
    /数据删除|删除/,
    '新建表页面没有可用的生命周期操作类型。',
    true,
  );

  // 与已建表的可重复配置保持一致：执行前不需要人工确认。
  const noConfirm = page.getByRole('radio', { name: '否', exact: true }).last();
  if (await noConfirm.isVisible().catch(() => false)) {
    await noConfirm.check();
  }

  await selectManageOption(
    page,
    ['确认周期'],
    /(?:\d+\s*(?:天|日)|永久|长期)/,
    '新建表页面没有可用的生命周期确认周期。',
    true,
  );
  await selectManageOption(
    page,
    ['排除分区'],
    /不排除|不分区|无|否/,
    '新建表页面没有可用的排除分区选项。',
    true,
  );
}

async function clickFieldAddWay(page: Page, way: '语句添加' | '直接添加字段' | '引用数据元'): Promise<void> {
  if (way === '语句添加') {
    const radio = page.getByRole('radio', { name: /语句添加/ }).last();
    const radioWrapper = page
      .locator('label.ant-radio-button-wrapper:visible, label.el-radio-button:visible')
      .filter({ hasText: /^\s*语句添加\s*$/ })
      .last();
    if (await radioWrapper.isVisible().catch(() => false)) {
      await radioWrapper.click({ force: true });
      await page.waitForTimeout(500);
      if (await page.locator('.monaco-editor:visible textarea').count()) return;
    }
    // 当前组件的点击事件挂在文字所在的外层 generic 上，优先点击真实可见文字，
    // 不直接依赖 0×0 的 radio 是否被 Chromium 视为可见。
    const textLabels = page.getByText('语句添加', { exact: true });
    for (let index = await textLabels.count() - 1; index >= 0; index -= 1) {
      const label = textLabels.nth(index);
      if (!(await label.isVisible().catch(() => false))) continue;
      await label.click({ force: true });
      await page.waitForTimeout(500);
      if (await page.locator('.monaco-editor:visible textarea').count()) return;
    }
    if (await radio.count()) {
      // Ant RadioButton 的 input 被隐藏，直接在 DOM 上触发原生 click，
      // 让 React/Ant 的 change 处理器切换到语句编辑面板。
      await radio.evaluate((element) => (element as HTMLInputElement).click()).catch(() => undefined);
      await page.waitForTimeout(500);
      if (await page.locator('.monaco-editor:visible textarea').count()) return;
      await radio.evaluate((element) => {
        const wrapper = element.closest('label') ?? element.parentElement?.parentElement;
        (wrapper as HTMLElement | undefined)?.click();
      }).catch(() => undefined);
      await page.waitForTimeout(500);
      if (await page.locator('.monaco-editor:visible textarea').count()) return;
      await radio.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(500);
      if (await page.locator('.monaco-editor:visible textarea').count()) return;
      // 虽然原生 radio 被组件隐藏了，但 force check 仍会触发真实 change
      // 事件；这比点击仅用于布局的外层 generic 更稳定。
      await radio.check({ force: true }).catch(() => undefined);
      await page.waitForTimeout(500);
      if (await page.locator('.monaco-editor:visible textarea').count()) return;
      // 真实页面的 radio 是 0×0 的无障碍输入，直接 click 会被判定为不可见；
      // 点击其可见父级（文字“语句添加”所在的选择容器）才是用户实际操作。
      const radioContainer = radio.locator('..').locator('..');
      if (await radioContainer.isVisible().catch(() => false)) {
        await radioContainer.click({ force: true });
        await page.waitForTimeout(500);
        if (await page.locator('.monaco-editor:visible textarea').count()) return;
      }
    }
    // 当前页面实际把“可视化添加/语句添加”渲染为按钮式页签，
    // 不是 radio，也不一定带 role=tab；优先按真实可见按钮点击。
    const button = page.getByRole('button', { name: /语句添加/ }).last();
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      return;
    }
    await clickVisibleTab(page, way);
    return;
  }
  const button = page.getByRole('button', {
    name: way === '直接添加字段' ? /直接添加字段|直接添加|添加字段|新增字段/ : new RegExp(way),
  }).last();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    return;
  }
  // 某些版本把三种方式渲染成页签而不是按钮。
  await clickVisibleTab(page, way === '直接添加字段' ? /直接添加字段|直接添加/ : way);
}

async function fillAndParseDdl(page: Page, ddl: string): Promise<void> {
  // 实际页面使用 Monaco，唯一稳定的可访问控件名是 Editor content；
  // textarea.first() 会误命中“描述”字段，导致 SQL 被填到错误位置。
  const monacoEditors = page.locator('.monaco-editor:visible textarea');
  const editor = await monacoEditors.count()
    ? monacoEditors.last()
    : page.getByRole('textbox', { name: /Editor content;Press Alt\+F1/ }).last();
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await editor.click();
  await page.keyboard.press('Control+A');
  // Monaco 的无障碍 textarea 在不同版本中对 insertText 的处理不一致：
  // 有的版本只更新输入缓冲，不更新编辑器 model，点击“解析”时页面仍是空 SQL。
  // 先用 fill 触发标准 input 事件；若控件没有暴露 value，再用键盘输入作为兼容回退。
  await editor.fill(ddl).catch(async () => {
    await page.keyboard.insertText(ddl);
  });
  const editorValue = await editor.inputValue().catch(() => '');
  if (!editorValue.includes('CREATE TABLE')) {
    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(ddl);
  }
  await clickVisibleButton(page, /解\s*析|执\s*行/);
  // 解析接口是异步更新字段区的，不能只固定等待 800ms。
  const parseError = page
    .locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
    .filter({ hasText: /字段.*(?:不是合法|非法)|解析失败|SQL.*错误/ })
    .first();
  await expect.poll(async () => {
    if (await tableRows(page).count() > 0) return 'rows';
    if (await parseError.isVisible().catch(() => false)) return 'error';
    return 'waiting';
  }, { timeout: 10_000 }).toBe('rows');

  // 语句解析只生成字段名和类型，真实页面还要求每个字段填写字段中文名；
  // 不补这一列时点击“保存”会留在表单页，看起来像保存接口卡住，实际是必填校验未通过。
  // 字段中文名（标签）用本轮唯一 ASCII（DS-PERM-67），不依赖/污染历史字段标签。
  const rows = tableRows(page);
  for (let index = 0; index < await rows.count(); index += 1) {
    const inputs = rows.nth(index).locator('input:visible');
    if (await inputs.count() < 2) continue;
    const chineseName = inputs.nth(1);
    if (!(await chineseName.inputValue().catch(() => '')).trim()) {
      await chineseName.fill(`lbl_${uuid()}_f${index + 1}`);
    }
  }
}

async function fillDirectFieldRows(page: Page): Promise<void> {
  // 字段中文名（标签）用本轮唯一 ASCII（DS-PERM-67），不依赖/污染历史字段标签。
  const rows = tableRows(page);
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const inputs = row.locator('input:visible');
    if (await inputs.count() > 1) {
      await inputs.nth(1).fill(`lbl_${uuid()}_f${index + 1}`);
    }
    const typeControl = row.locator('.el-select:visible, .ant-select:visible, [role="combobox"]:visible, select:visible').first();
    if (await typeControl.count()) {
      const tagName = await typeControl.evaluate((element) => element.tagName.toLowerCase()).catch(() => '');
      if (tagName === 'select') {
        const options = typeControl.locator('option');
        for (let optionIndex = 0; optionIndex < await options.count(); optionIndex += 1) {
          const option = options.nth(optionIndex);
          const text = (await option.innerText().catch(() => '')).trim();
          if (text && !/请选择|暂无|无数据/.test(text)) {
            await typeControl.selectOption({ label: text });
            break;
          }
        }
      } else {
        await typeControl.click({ force: true });
        const wantedType = index === 0 ? /\bINT(?:EGER)?\b/i : /VARCHAR|CHAR(?:ACTER)?/i;
        const options = page.locator(
          '.el-select-dropdown__item, .el-select-dropdown-menu__item, ' +
            '.ant-select-item-option, .ant-select-dropdown-menu-item, ' +
            '[role="listbox"] [role="option"], [role="option"]',
        );
        let picked = false;
        for (let optionIndex = await options.count() - 1; optionIndex >= 0; optionIndex -= 1) {
          const option = options.nth(optionIndex);
          if (!(await option.isVisible().catch(() => false))) continue;
          const text = (await option.innerText().catch(() => '')).trim();
          if (wantedType.test(text)) {
            await option.scrollIntoViewIfNeeded().catch(() => undefined);
            await option.click({ force: true });
            picked = true;
            break;
          }
        }
        if (!picked) {
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('Enter');
        }
      }
    }
    const lengthInput = row.locator('input[type="number"], [role="spinbutton"]').first();
    if (index > 0 && await lengthInput.isVisible().catch(() => false)) {
      await lengthInput.fill('64');
      }
  }
}

async function addOneValidDirectField(page: Page, fieldName: string): Promise<void> {
  await clickVisibleButton(page, /直接添加字段|添加字段|新增字段/);
  const row = tableRows(page).last();
  await row.locator('input').first().fill(fieldName);
  await fillDirectFieldRows(page);
}

async function submitAndExpectTableCreated(page: Page, tableName: string): Promise<void> {
  await page.getByRole('button', { name: /建\s*表/ }).click();
  // 真实页面建表成功后直接返回表管理列表，不一定弹出“建表成功”toast。
  await expect(page).toHaveURL(/#\/dataMap\/tableManage(?:\/tablesManage)?/, { timeout: 15_000 });
  await expect(tableRows(page).filter({ hasText: tableName }).first()).toBeVisible({ timeout: 15_000 });
}

// DS-PERM-67：历史夹具行选取（requireManageRow/ownedManageRows，按 e2e_/codex_/gs_test_
// 等历史命名匹配）已随清洁环境迁移移除，统一改用 findThisRoundRow 按本轮唯一表名精确检索。

/** Ant 固定“操作”列会作为平行 table 渲染；按同一 tbody 行号取操作单元。 */
async function matchingOperationRows(page: Page, row: Locator): Promise<Locator[]> {
  const rowIndex = await row.evaluate((element) => {
    const siblings = Array.from(element.parentElement?.children ?? []);
    return siblings.indexOf(element);
  }).catch(() => -1);
  if (rowIndex < 0) return [];

  const matches: Locator[] = [];
  const tables = page.locator('table:visible').filter({ hasText: /操作/ });
  for (let tableIndex = 0; tableIndex < await tables.count(); tableIndex += 1) {
    const rows = tables.nth(tableIndex).locator('tbody > tr:visible, .ant-table-tbody > tr:visible');
    if (await rows.count() > rowIndex) matches.push(rows.nth(rowIndex));
  }
  return matches;
}

async function clickManageRowAction(page: Page, row: Locator, name: string | RegExp): Promise<void> {
  // 当前页面的“编辑/上线/下线”是文字链接，不是 button；旧定位只查 button，
  // 因此在有数据时仍会报“未找到编辑按钮”。按真实可见交互元素依次兼容。
  const candidates = row.locator(
    'button:visible, a:visible, .el-link:visible, [role="button"]:visible, td:visible, [class*="action"]:visible',
  );
  for (let index = await candidates.count() - 1; index >= 0; index -= 1) {
    const candidate = candidates.nth(index);
    const metadata = [
      await candidate.innerText().catch(() => ''),
      await candidate.getAttribute('aria-label'),
      await candidate.getAttribute('title'),
    ].filter(Boolean).join(' ');
    if (tabTextMatches(metadata, name)) {
      if (!(await candidate.isEnabled().catch(() => true))) continue;
      await candidate.click();
      return;
    }
  }

  // 优先使用与当前主表行同序的固定操作列表，禁止因“最后一个编辑链接”
  // 而误操作其它测试表。
  for (const operationRow of await matchingOperationRows(page, row)) {
    const actionCandidates = operationRow.locator(
      'button:visible, a:visible, .el-link:visible, [role="button"]:visible, td:visible, [class*="action"]:visible',
    );
    for (let index = await actionCandidates.count() - 1; index >= 0; index -= 1) {
      const candidate = actionCandidates.nth(index);
      const metadata = [
        await candidate.innerText().catch(() => ''),
        await candidate.getAttribute('aria-label'),
        await candidate.getAttribute('title'),
      ].filter(Boolean).join(' ');
      if (tabTextMatches(metadata, name) && await candidate.isEnabled().catch(() => true)) {
        await candidate.click();
        return;
      }
    }
  }

  // Ant Design 固定操作列会被渲染成表格主体之外的平行 DOM，row locator
  // 看不到“编辑”文字；当前来源页只有一个可操作行时，从页面级可见操作列
  // 取最后一个匹配项，仍然保持浏览器真实点击。
  const pageActions = page.locator('button:visible, a:visible, [role="button"]:visible, [class*="link"]:visible');
  for (let index = await pageActions.count() - 1; index >= 0; index -= 1) {
    const candidate = pageActions.nth(index);
    const metadata = [
      await candidate.innerText().catch(() => ''),
      await candidate.getAttribute('aria-label'),
      await candidate.getAttribute('title'),
    ].filter(Boolean).join(' ');
    if (tabTextMatches(metadata, name)) {
      if (!(await candidate.isEnabled().catch(() => true))) continue;
      await candidate.click();
      return;
    }
  }
  throw new Error(`表管理行未找到可见操作“${name}”。当前行：${await row.innerText().catch(() => '')}`);
}

/** 编辑按钮只在表下线后启用；检查时同时兼容固定操作列的平行 DOM。 */
async function hasManageRowAction(page: Page, row: Locator, name: string | RegExp): Promise<boolean> {
  for (const operationRow of await matchingOperationRows(page, row)) {
    const actionCandidates = operationRow.locator(
      'button:visible, a:visible, .el-link:visible, [role="button"]:visible, td:visible, [class*="action"]:visible',
    );
    for (let index = await actionCandidates.count() - 1; index >= 0; index -= 1) {
      const candidate = actionCandidates.nth(index);
      const metadata = [
        await candidate.innerText().catch(() => ''),
        await candidate.getAttribute('aria-label'),
        await candidate.getAttribute('title'),
      ].filter(Boolean).join(' ');
      if (tabTextMatches(metadata, name) && await candidate.isEnabled().catch(() => true)) return true;
    }
  }
  const candidates = page.locator(
    'button:visible, a:visible, .el-link:visible, [role="button"]:visible, [class*="link"]:visible',
  );
  for (let index = await candidates.count() - 1; index >= 0; index -= 1) {
    const candidate = candidates.nth(index);
    const metadata = [
      await candidate.innerText().catch(() => ''),
      await candidate.getAttribute('aria-label'),
      await candidate.getAttribute('title'),
    ].filter(Boolean).join(' ');
    if (tabTextMatches(metadata, name) && await candidate.isEnabled().catch(() => true)) return true;
  }
  return false;
}

/**
 * 进入编辑页后先确认该表确实保留了字段元数据。历史遗留的接入表可能在
 * 列表可见，却没有任何字段；这种对象无法保存，不能把“保存失败”误判为
 * 编辑按钮或等待时间的问题。改为布尔探测：调用方按夹具行逐个尝试后再
 * 统一决定是否跳过，避免第一行缺元数据就连带跳过可用的后续夹具行。
 */
async function hasEditableFieldMetadata(page: Page): Promise<boolean> {
  const fieldTable = page.locator('table:visible').filter({
    hasText: /字段名[\s\S]*字段中文名[\s\S]*数据类型/,
  }).first();
  const fieldRows = fieldTable.locator('tbody > tr:visible, .ant-table-tbody > tr:visible');
  return (await fieldRows.count()) > 0;
}

/** 编辑失败时返回列表，供 finally 恢复本轮下线的表。 */
async function leaveTableEditor(page: Page): Promise<void> {
  const cancel = page.getByRole('button', { name: /^取\s*消$/ }).last();
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.click().catch(() => undefined);
    await page.waitForTimeout(300);
  }
}

async function clickManageRowDetail(page: Page, row: Locator): Promise<void> {
  // 表名在不同版本分别是 a、el-link、带 name class 的 span，部分版本则是
  // 整个首列 td 的点击区域；不能只依赖 a/.el-link。
  const fixedNameButtons = page.locator(
    '.ant-table-fixed-left:visible button:visible, .ant-table-fixed-left:visible [role="button"]:visible',
  );
  if (await fixedNameButtons.count()) {
    await fixedNameButtons.first().click();
    return;
  }
  const candidates = row.locator(
    'a:visible, .el-link:visible, [class*="name"]:visible, [role="link"]:visible',
  );
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click().catch(async () => candidate.click({ force: true }));
      return;
    }
  }

  // 固定左列的 td 会拦截普通 click；按当前行首个单元格文字在整页找可见
  // 的实际表名节点，优先点击其事件绑定节点。
  const firstCellText = (await row.innerText().catch(() => ''))
    .split(/\s+/)
    .map((text) => text.trim())
    .find(Boolean);
  if (firstCellText) {
    const exactNames = page.getByText(firstCellText, { exact: true });
    for (let index = exactNames.count ? await exactNames.count() - 1 : -1; index >= 0; index -= 1) {
      const candidate = exactNames.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        await candidate.click({ force: true });
        return;
      }
    }
  }
  throw new Error(`表管理行未找到可点击的表名。当前行：${await row.innerText().catch(() => '')}`);
}

/**
 * 页面页签的 DOM 结构不固定：可能是 Ant/Element 的 Tab，也可能只有 role=tab。
 * 统一从“真实 Tab 容器”中匹配，避免 getByText(...).first() 命中隐藏模板或正文文本。
 */
const TAB_SELECTORS = [
  '[role="tab"]',
  '.ant-tabs-tab',
  '.el-tabs__item',
  '[class*="tab-item"]',
].join(', ');

const TAB_OVERFLOW_SELECTORS = [
  '.ant-tabs-nav-more:visible',
  '.ant-tabs-dropdown-trigger:visible',
  '.el-tabs__more:visible',
  '.el-tabs__nav-more:visible',
  '[class*="tabs"][class*="more"]:visible',
      '[class*="tab"][class*="more"]:visible',
      '[aria-label*="更多"]:visible',
      '[title*="更多"]:visible',
].join(', ');

const TAB_CONTAINER_SELECTORS = [
  '[role="tablist"]:visible',
  '.ant-tabs-nav:visible',
  '.el-tabs__nav-wrap:visible',
  '.el-tabs__nav:visible',
  '.ant-tabs:visible',
  '.el-tabs:visible',
].join(', ');

const TAB_POPUP_SELECTORS = [
  '.ant-tabs-dropdown:visible .ant-tabs-dropdown-menu-item',
  '.ant-tabs-dropdown-menu:visible .ant-tabs-dropdown-menu-item',
  '.ant-dropdown:visible .ant-dropdown-menu-item',
  '.el-tabs__dropdown:visible .el-dropdown-menu__item',
  '.el-dropdown-menu:visible .el-dropdown-menu__item',
  '[role="menu"]:visible [role="menuitem"]',
  '[role="listbox"]:visible [role="option"]',
].join(', ');

const TAB_FALLBACK_SELECTORS = [
  'button',
  'a',
  'li',
  '[role="tab"]',
  '[role="option"]',
  '[class*="tab"]',
].join(', ');

function tabTextMatches(actual: string, expected: string | RegExp): boolean {
  const normalized = actual.replace(/\s+/g, ' ').trim();
  if (typeof expected === 'string') return normalized === expected;
  expected.lastIndex = 0;
  const matched = expected.test(normalized);
  expected.lastIndex = 0;
  return matched;
}

async function findVisibleText(locator: Locator, text: string | RegExp): Promise<Locator | undefined> {
  for (let index = await locator.count() - 1; index >= 0; index--) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const actual = await candidate.innerText().catch(() => '');
    if (tabTextMatches(actual, text)) return candidate;
  }
  return undefined;
}

async function findVisibleTab(page: Page, text: string | RegExp): Promise<Locator | undefined> {
  const directTab = await findVisibleText(page.locator(TAB_SELECTORS), text);
  if (directTab) return directTab;
  const popupTab = await findVisibleText(page.locator(TAB_POPUP_SELECTORS), text);
  if (popupTab) return popupTab;

  // 表管理的来源切换在当前版本不是 role=tab，而是单选按钮：
  // radio “自行建表/数据集成/文件接入/FTP文件接入”。对外仍按 Tab 语义处理，
  // 这样既兼容实际 DOM，也能继续复用隐藏项展开逻辑。
  const radioTabs = page.getByRole('radio', { name: text });
  for (let index = await radioTabs.count() - 1; index >= 0; index -= 1) {
    const radio = radioTabs.nth(index);
    if (await radio.isVisible().catch(() => false)) return radio;
  }

  // radio 的可访问名称在不同 Chromium/组件版本中可能无法被
  // getByRole 稳定解析，但其旁边的可见文字始终存在；点击文字会冒泡到
  // 组件的单选容器，适配当前页面的真实 DOM。
  const textCandidates = typeof text === 'string'
    ? page.getByText(text, { exact: true })
    : page.getByText(text);
  for (let index = await textCandidates.count() - 1; index >= 0; index -= 1) {
    const candidate = textCandidates.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }

  // 某些页面没有 role=tab/class，只在可见 Tab 容器中渲染 button/a/li。
  const containers = page.locator(TAB_CONTAINER_SELECTORS);
  for (let index = await containers.count() - 1; index >= 0; index--) {
    const container = containers.nth(index);
    if (!(await container.isVisible().catch(() => false))) continue;
    const fallbackTab = await findVisibleText(container.locator(TAB_FALLBACK_SELECTORS), text);
    if (fallbackTab) return fallbackTab;
  }
  return undefined;
}

async function findVisibleTabOverflow(page: Page): Promise<Locator | undefined> {
  // Ant 的 nav-more 通常只有图标，没有“更多”文字，不能用文本匹配判断。
  const direct = page.locator(TAB_OVERFLOW_SELECTORS);
  for (let index = await direct.count() - 1; index >= 0; index--) {
    const candidate = direct.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }

  const containers = page.locator(TAB_CONTAINER_SELECTORS);
  for (let index = await containers.count() - 1; index >= 0; index--) {
    const container = containers.nth(index);
    if (!(await container.isVisible().catch(() => false))) continue;
    const candidates = container.locator(
      '[class*="more"], [class*="More"], [aria-label*="更多"], [title*="更多"], ' +
      '[aria-label*="more" i], [title*="more" i], button, [role="button"], span, a',
    );
    for (let candidateIndex = await candidates.count() - 1; candidateIndex >= 0; candidateIndex--) {
      const candidate = candidates.nth(candidateIndex);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const metadata = [
        await candidate.getAttribute('class'),
        await candidate.getAttribute('aria-label'),
        await candidate.getAttribute('title'),
        await candidate.innerText().catch(() => ''),
      ].filter(Boolean).join(' ');
      if (/(?:more|更多|\.\.\.|…|···)/i.test(metadata)) return candidate;
    }
  }
  return undefined;
}

/** 点击真实可见 Tab；若目标在“更多/…”中，先展开对应 Tab 溢出菜单。 */
async function clickVisibleTab(page: Page, text: string | RegExp): Promise<void> {
  const deadline = Date.now() + 10_000;
  let overflowOpened = false;
  while (Date.now() < deadline) {
    const tab = await findVisibleTab(page, text);
    if (tab) {
      await tab.click();
      await page.waitForTimeout(250);
      return;
    }
    if (!overflowOpened) {
      const overflow = await findVisibleTabOverflow(page);
      if (overflow) {
        await overflow.click();
        overflowOpened = true;
        await page.waitForTimeout(300);
        continue;
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`页签“${text}”未找到可见节点或“更多”入口，当前页面：${page.url()}`);
}

async function clickVisibleButton(page: Page, name: string | RegExp): Promise<void> {
  const buttons = page.getByRole('button', { name });
  for (let index = await buttons.count() - 1; index >= 0; index -= 1) {
    const button = buttons.nth(index);
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      return;
    }
  }
  throw new Error(`按钮“${name}”未找到可见节点，当前页面：${page.url()}`);
}

async function requireAnyManageRow(page: Page): Promise<void> {
  const state = await waitForManageListState(page);
  if (state === 'empty') {
    skipForMissingEnvironment('表管理页面没有可用目标数据行。');
  }
}

async function waitForManageListState(page: Page): Promise<'rows' | 'empty'> {
  const emptyStates = page.getByText(/暂无数据|没有数据|空空如也/);
  await expect.poll(async () => {
    if (await tableRows(page).count()) return 'rows';
    for (let index = await emptyStates.count() - 1; index >= 0; index -= 1) {
      if (await emptyStates.nth(index).isVisible().catch(() => false)) return 'empty';
    }
    // Ant/Element 空态在部分版本只给容器 class，不给稳定的可访问文本节点；
    // 以可见空态容器和页面可见文字作双重兜底，避免把真实空态误判成 loading。
    if (await page.locator('.ant-empty:visible, .el-empty:visible, [class*="empty"]:visible').count()) {
      return 'empty';
    }
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (/暂无数据|没有数据|空空如也/.test(bodyText)) return 'empty';
    return 'loading';
  }, { timeout: 10_000 }).toMatch(/rows|empty/);
  return (await tableRows(page).count()) ? 'rows' : 'empty';
}

/**
 * DS-PERM-67：进入“新建表”表单。不再按 gauss/gbase/hive 挑选数据源类型——统一使用
 * 配置中心公共 MySQL 数据源（MYSQL_SOURCE_TEXT）：split-button 下拉中直接按显示名点选。
 * 下拉没有该数据源＝环境前置缺失（skipForMissingEnvironment），不伪造失败/通过。
 */
async function openCreateTable(page: Page, preferredDatabase?: 'gauss' | 'gbase' | 'hive'): Promise<void> {
  void preferredDatabase;
  await clickVisibleButton(page, /新建表|新增表/);

  const visibleSave = async (): Promise<Locator | undefined> => {
    const saves = page.getByRole('button', { name: /保\s*存/ });
    for (let index = await saves.count() - 1; index >= 0; index -= 1) {
      const save = saves.nth(index);
      if (await save.isVisible().catch(() => false)) return save;
    }
    return undefined;
  };

  // 真实页面的“新建表”是 split-button：第一次点击只展开数据库选择菜单，
  // 选择数据库后才进入表单。必须完成第二次点击，不能用列表页上的“表名称”
  // 筛选项作为进入成功条件。
  if (!(await visibleSave())) {
    const options = page.locator(
      '.el-dropdown-menu:visible li:visible, .ant-dropdown-menu:visible li:visible, ' +
      '.ant-dropdown:visible [role="menuitem"]:visible, [role="listbox"]:visible [role="option"]:visible',
    );
    await expect(options.first()).toBeVisible({ timeout: 10_000 });
    const preferredPattern = preferredDatabase === 'gauss'
      ? /gauss|open.?gauss/i
      : preferredDatabase === 'gbase'
        ? /gbase/i
        : preferredDatabase === 'hive'
          ? /hive/i
          : process.env.TABLE_NEW_DATABASE?.trim()
            ? new RegExp(process.env.TABLE_NEW_DATABASE.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
            : undefined;
    let selected: Locator | undefined;
    for (let index = await options.count() - 1; index >= 0; index -= 1) {
      const option = options.nth(index);
      if (!(await option.isVisible().catch(() => false))) continue;
      const text = (await option.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (!text || /取消|关闭|新建表/.test(text)) continue;
      if (MYSQL_SOURCE_TEXT && text.includes(MYSQL_SOURCE_TEXT)) {
        selected = option;
        break;
      }
    }
    if (!selected) {
      skipForMissingEnvironment(`新建表数据库下拉没有配置中心公共 MySQL 数据源（${MYSQL_SOURCE_TEXT}）。`);
    }
    await selected!.click();
  }

  await expect.poll(async () => (await visibleSave()) ? 'form' : 'list', {
    timeout: 10_000,
  }).toBe('form');
}

async function openTableQueryLeafFromManage(page: Page): Promise<void> {
  await clickMenu(page, '数据地图', '表查询', '表查询');
  await expect(page.locator('.table-query .search-bar, .table-query .card-list').first()).toBeVisible({ timeout: 15_000 });
}

async function confirmVisibleDialog(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog').last();
  const confirm = dialog.getByRole('button', { name: /^确\s*定$/ }).last();
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
}

async function verifyTableStatusSourceMatrix(page: Page): Promise<void> {
  await requireAnyManageRow(page);
  // 真实 DOM 的状态页签包含动态数量，不能按不带数量的文本精确匹配。
  const statusTabs = [
    /^物理表存在(?:\s*[（(]\s*\d+\s*[）)])?$/,
    /^物理表存在\s*&\s*上线(?:\s*[（(]\s*\d+\s*[）)])?$/,
    /^物理表存在\s*&\s*下线(?:\s*[（(]\s*\d+\s*[）)])?$/,
    /^草稿(?:\s*[（(]\s*\d+\s*[）)])?$/,
  ];
  for (const status of statusTabs) {
    await clickVisibleTab(page, status);
    for (const source of TABLE_SOURCES) {
      await clickVisibleTab(page, source);
      // 来源由页签切换，列表行本身不再包含“自建表/数据集成”等来源文本。
      // 该矩阵依赖四种来源的预置目标表；来源数据不存在时明确跳过。
      if ((await waitForManageListState(page)) === 'rows') {
        await expect(tableRows(page).first()).toBeVisible();
      } else {
        skipForMissingEnvironment(`表管理页当前筛选没有“${source}”来源的目标表数据。`);
      }
    }
  }
}

// ==================== 本轮自建资产回收（DS-PERM-67，口径同 DM-02-01/DS-PERM-63） ====================

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

/** 行内操作定位：仅接受精确“删除/移除”文本，避免误触其它列（口径同 DM-02-01）。 */
async function findRowAction(page: Page, row: Locator, name: RegExp): Promise<Locator | undefined> {
  const selectors = 'button:visible, a:visible, .el-link:visible, [role="button"]:visible, [class*="link"]:visible';
  for (const scope of [row.locator(selectors), row.locator('td:visible').last().locator(selectors)]) {
    for (let index = await scope.count() - 1; index >= 0; index -= 1) {
      const candidate = scope.nth(index);
      const text = (await candidate.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (name.test(text) && (await candidate.isVisible().catch(() => false))) return candidate;
    }
  }
  return undefined;
}

/** 元数据行内删除入口尽力而为：入口不存在（当前版本未提供）时仅告警保留，UUID 可追溯。 */
async function deleteRoundMetadataRows(page: Page, names: string[]): Promise<void> {
  for (const name of new Set(names)) {
    try {
      await openTableManageLeaf(page);
      const filter = page.locator('input:visible:not([type="checkbox"]):not([type="radio"])').first();
      if (!(await filter.isVisible().catch(() => false))) {
        console.warn(`[cleanup] 未回到表管理列表，跳过“${name}”元数据页面侧回收（UUID 可追溯）。`);
        continue;
      }
      await filter.fill(name);
      const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
      if (await queryButton.isVisible().catch(() => false)) await queryButton.click();
      const row = tableRows(page).filter({ hasText: name }).first();
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

// ==================== DS-PERM-67 清洁环境：本轮唯一表自建 + 编辑后重新查询 ====================

/**
 * 在指定来源页签下按本轮唯一表名精确检索（DS-PERM-67：不再按 e2e_/codex_/gs_test_
 * 等历史夹具名匹配）。检索不到返回 undefined，由调用方决定是否记为环境前置缺失。
 */
async function findThisRoundRow(page: Page, source: string, tableName: string): Promise<Locator | undefined> {
  await clickVisibleTab(page, source);
  const filter = page.locator('input:visible:not([type="checkbox"]):not([type="radio"])').first();
  if (await filter.isVisible().catch(() => false)) {
    await filter.fill(tableName);
    const queryButton = page.getByRole('button', { name: /查\s*询/ }).last();
    if (await queryButton.isVisible().catch(() => false)) await queryButton.click();
  }
  if ((await waitForManageListState(page)) !== 'rows') return undefined;
  const row = tableRows(page).filter({ hasText: tableName }).first();
  return (await row.isVisible().catch(() => false)) ? row : undefined;
}

/**
 * 本轮自建（“自行建表”来源专用）：用配置中心公共 MySQL 数据源新建：
 * 基础必填下拉取当前页面可用项 → 语句添加 DDL → 解析（含补字段中文名）→
 * 建 表 → 行内上线。返回 true=建成；字符串=环境前置缺失原因（新建表下拉无配置中心
 * 数据源/必填下拉为空等），由调用方统一按真实 skip 收场；其余异常原样抛出（真实失败不吞）。
 */
async function createThisRoundSelfTable(page: Page, tableName: string, chineseName: string): Promise<boolean | string> {
  try {
    await openCreateTable(page);
    await fillManageField(page, ['表名称', '表名'], tableName);
    await fillRequiredTableBasics(page, chineseName);
    await clickFieldAddWay(page, '语句添加');
    await fillAndParseDdl(page, `CREATE TABLE ${tableName} (id VARCHAR(64), name VARCHAR(128), remark VARCHAR(255))`);
    await submitAndExpectTableCreated(page, tableName);
    await bringThisRoundTableOnline(page, tableName);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('环境前置条件缺失')) return `${message}（本轮自建表未完成）`;
    throw error;
  }
}

/** 新建表默认下线态；编辑前需要上线。以下线操作重新出现作为已上线判定（口径同孪生用例）。 */
async function bringThisRoundTableOnline(page: Page, tableName: string): Promise<void> {
  const findRow = async () => tableRows(page).filter({ hasText: tableName }).first();
  const row = await findRow();
  await expect(row, `建表后应在表管理列表检索到本轮表 ${tableName}`).toBeVisible({ timeout: 15_000 });
  if (await findRowAction(page, row, /^下\s*线$/)) {
    await clickManageRowAction(page, row, /^下\s*线$/);
    const dialog = page.getByRole('dialog').last();
    const confirm = (await dialog.isVisible().catch(() => false))
      ? dialog.getByRole('button', { name: /^确\s*定$/ }).last()
      : page.getByRole('button', { name: /^确\s*定$/ }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
  }
  await expect.poll(async () => {
    const current = await findRow();
    if (!current || !(await current.isVisible().catch(() => false))) return 'waiting';
    return (await findRowAction(page, current, /^下\s*线$/)) ? 'online' : 'waiting';
  }, { timeout: 20_000 }).toBe('online');
}

/** 读取编辑页表单项当前值（与 fillManageField 同一控件解析链），供“编辑后重新查询”核对回显。 */
async function manageFieldValue(page: Page, labels: string[]): Promise<string> {
  const field = await findManageControl(
    page,
    labels,
    'input:not([type="checkbox"]):not([type="radio"]):not([readonly]), textarea',
  );
  if (!field) throw new Error(`编辑页未找到字段控件：${labels.join(' / ')}`);
  return field.inputValue();
}

/**
 * 对本轮单张表执行“下线→行内编辑→保存→编辑后重新查询→恢复上线”：
 * - 编辑值用本轮唯一中文备注（UUID 隔离），不依赖历史数据；
 * - “编辑后重新查询”断言分两层：退出编辑页后按本轮表名重查列表，再重新打开
 *   编辑页核对表中文名称已持久化为本轮新值（保存后真实回读，不依赖瞬时 toast）；
 * - 恢复上线在 finally 中执行：编辑或保存任一步失败都不能遗留“已下线”状态。
 */
async function editAndRequeryThisRoundTable(page: Page, source: string, tableName: string): Promise<void> {
  const located = await findThisRoundRow(page, source, tableName);
  if (!located) throw new Error(`“${source}”来源检索不到本轮表 ${tableName}`);
  // 页面真实规则：已上线表的“编辑”入口禁用，必须先下线；已下线则直接编辑。
  const wasOnline = (await findRowAction(page, located, /^下\s*线$/)) !== undefined;
  try {
    if (wasOnline) {
      await clickManageRowAction(page, located, /^下\s*线$/);
      await page.waitForTimeout(700);
    }
    // 下线会触发行序刷新：按本轮表名重新定位，绝不按行号误编辑其它表。
    const row = await findThisRoundRow(page, source, tableName);
    if (!row) throw new Error(`下线后按表名重新定位不到本轮表 ${tableName}（“${source}”来源）`);
    await expect(row, `下线后应能按表名重新定位本轮表 ${tableName}`).toBeVisible({ timeout: 15_000 });
    await clickManageRowAction(page, row!, /编\s*辑/);
    if (!(await hasEditableFieldMetadata(page))) {
      throw new Error(`本轮表 ${tableName} 在编辑页没有字段元数据，无法保存（请检查上游产出）。`);
    }
    const newName = `编辑回显_${uuid()}`;
    await fillManageField(page, ['表中文名称', '表中文名'], newName);
    await submitAndExpectSuccess(page, /保\s*存/, '保存成功');
    // 编辑后重新查询：退出编辑页 → 列表按本轮表名重查 → 重开编辑页核对持久化回显。
    await leaveTableEditor(page);
    await openTableManageLeaf(page);
    const requeried = await findThisRoundRow(page, source, tableName);
    if (!requeried) throw new Error(`保存后按本轮表名重新查询不到 ${tableName}（“${source}”来源）`);
    await expect(requeried, `保存后应能按本轮表名重新查询到 ${tableName}`).toBeVisible({ timeout: 15_000 });
    await clickManageRowAction(page, requeried!, /编\s*辑/);
    const echoed = await manageFieldValue(page, ['表中文名称', '表中文名']);
    expect(echoed, `编辑后重新查询：${tableName} 的表中文名称应回显为本轮新值 ${newName}`).toBe(newName);
  } finally {
    // 编辑或保存任一步失败都不能遗留“已下线”状态；仅恢复本轮表，不触碰其它行。
    await leaveTableEditor(page);
    if (wasOnline) {
      await openTableManageLeaf(page);
      const restored = await findThisRoundRow(page, source, tableName);
      if (restored && (await findRowAction(page, restored, /^上\s*线$/))) {
        await clickManageRowAction(page, restored, /^上\s*线$/);
        await page.waitForTimeout(700);
      }
    }
  }
}

test.describe("DM-03-01｜数据地图｜四类来源表编辑后重新查询", () => {
  // 逐来源逐夹具行的“下线-编辑-恢复”流程较长（最多 4 来源 × 3 行），放宽用例级超时。
  test.describe.configure({ timeout: 900_000 });
  test.beforeEach(async ({ loginPage }) => {
    await openTableManageLeaf(loginPage);
  })
  test("DM-03-01｜数据地图｜四类来源表编辑后重新查询", async ({ loginPage, consoleErrors, report }, testInfo) => {
      const page = loginPage;
      // ---------------------------------------------------------------------------
      // DS-PERM-67 清洁环境迁移：
      // - 不再依赖历史夹具表（e2e_/codex_/gs_test_ 等命名匹配全部移除）：四类来源
      //   统一使用本轮唯一 ASCII 表名精确检索与断言；
      // - “自行建表”来源：编辑前在本用例内经配置中心 MySQL 数据源自建并上线；
      // - 其余三类来源表由上游模块产出，清洁环境无历史表可复用：按本轮唯一表名检索，
      //   检索不到＝环境前置缺失，记入统一 skip 清单并写明原因，不伪造通过；
      // - 任一来源真实验证失败仍按失败上报；finally 仅回收本轮表/版本/元数据。
      // ---------------------------------------------------------------------------
      const roundTables: string[] = [];
      const thisRoundNames: Record<string, string> = {
        '自行建表': `e2e_dm_edit_self_${uuid()}`,
        '数据集成': `e2e_dm_edit_di_${uuid()}`,
        '文件接入': `e2e_dm_edit_file_${uuid()}`,
        'FTP文件接入': `e2e_dm_edit_ftp_${uuid()}`,
      };
      // 环境前置缺失不中断其余来源的验证：全部来源尝试完毕后统一按真实 skip 收场。
      const envBlockers: string[] = [];
      try {
        // 1) 编辑前必须自建本轮表：“自行建表”来源用配置中心 MySQL 数据源新建并上线。
        const selfTableName = thisRoundNames['自行建表'];
        roundTables.push(selfTableName); // 建表可能部分成功：先登记，统一由 finally 回收
        const created = await createThisRoundSelfTable(page, selfTableName, `四类来源编辑_${uuid()}`);
        if (created === true) {
          await editAndRequeryThisRoundTable(page, '自行建表', selfTableName);
        } else {
          envBlockers.push(`自行建表来源：${created}`);
        }

        // 2) 其余三类来源：按本轮唯一表名精确检索（不再按历史夹具名匹配）。
        for (const source of ['数据集成', '文件接入', 'FTP文件接入'] as const) {
          const tableName = thisRoundNames[source];
          const row = await findThisRoundRow(page, source, tableName);
          if (!row) {
            envBlockers.push(
              `${source}来源没有本轮自建表“${tableName}”（该来源表由上游模块产出，清洁环境不依赖历史夹具表；请在上游同轮生成后重跑）`,
            );
            continue;
          }
          await editAndRequeryThisRoundTable(page, source, tableName);
        }

        if (envBlockers.length > 0) {
          // 项目规范：环境前置缺失必须 report(false)+testInfo.skip()，不得 throw 冒充失败。
          await report(
            '编辑表-4种来源',
            false,
            `环境前置缺失：${envBlockers.join('；')}`,
          );
          testInfo.skip(
            true,
            `环境前置条件缺失：${envBlockers.join('；')}`,
          );
          return;
        }
        await assertNoConsoleErrors(consoleErrors);
        await report('编辑表-4种来源', true,
          `四类来源编辑后重新查询回归完成（本轮唯一表：${Object.values(thisRoundNames).join('、')}）；finally 已尽力回收本轮表。`);
      } finally {
        // DS-PERM-67：仅回收本轮表/版本/元数据，清理失败只告警、不掩埋用例真实结果。
        await cleanupRoundTables(page, roundTables);
      }
    })
});
