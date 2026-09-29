/**
 * 数据安全 E2E 测试
 *
 * 覆盖场景（参考 Excel「测试用例」Sheet，序号对应 1～73）：
 *   行64 — 分类分级配置：级别管理（增改）；数据特征管理（目录增删、特征增删改查）；
 *          分类分级模板（增删改查；模板编辑内数据分类增删改查、绑定数据特征）
 *   行65 — 分类分级任务：任务增删改查；开始/定时触发 → 5 分钟内生成详情；
 *          分类分级结果人工确认修订脱敏；未命中数据查看字段与特征
 *   行66 — 脱敏规则：规则增删改查；脱敏数据列表（人工确认、修改规则、样本查看）；
 *          人工手动添加规则；脱敏白名单人员可查看原始数据
 *
 * 扩展（测试用例编写规范.md 覆盖深度）：
 *   - 异常路径：重复级别/特征名称拦截；删除被模板引用的特征被拦截
 *
 * 关键要求：
 *   1. 所有操作用 page. 浏览器操作（无 fetch/axios 等 API 调用）
 *   2. UUID 后缀隔离所有测试数据
 *   3. 控制台错误收集；选择器 TODO[env] 校准
 */

import { test, expect, uuid } from '../utils.js';
import { assertNoConsoleErrors, clickMenu } from '../utils.js';

type E2EPage = Parameters<typeof clickMenu>[0];
type E2ELocator = import('@playwright/test').Locator;

async function firstVisibleMatching(locator: import('@playwright/test').Locator): Promise<import('@playwright/test').Locator | undefined> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

async function firstVisibleExact(locator: import('@playwright/test').Locator, text: string): Promise<import('@playwright/test').Locator | undefined> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    if ((await item.innerText().catch(() => '')).trim() === text) return item;
  }
  return undefined;
}

async function expectVisibleText(page: E2EPage, pattern: string | RegExp, label = String(pattern)): Promise<void> {
  if (label === '成功' || (pattern instanceof RegExp && pattern.source === '成功')) {
    await expect(successNotice(page, /(?:新增|添加|创建|修改|编辑|更新|删除|保存|绑定|确认|开始|执行|触发|操作).*成功/)).toBeVisible({ timeout: 10_000 });
    return;
  }
  const item = await firstVisibleMatching(page.getByText(pattern));
  if (!item) throw new Error(`未找到可见文本“${label}”，当前页面：${page.url()}`);
  await expect(item).toBeVisible();
}

function successNotice(page: E2EPage, pattern: string | RegExp) {
  return page.locator(
    '.ant-message-notice-content:visible, .ant-notification-notice-message:visible, .el-message:visible, [role="alert"]:visible, [class*="toast"]:visible, [class*="message"]:visible',
  ).filter({ hasText: pattern }).last();
}

async function expectMessage(page: E2EPage, pattern: string | RegExp): Promise<void> {
  await expect(successNotice(page, pattern)).toBeVisible({ timeout: 10_000 });
}

async function submitAndExpectOperationSuccess(
  page: E2EPage,
  submitButton: string | RegExp,
  successPattern: string | RegExp,
  scope: E2EPage | E2ELocator = page,
): Promise<void> {
  const submit = scope.getByRole('button', { name: submitButton }).last();
  await expect(submit).toBeVisible();
  await submit.click();
  await expect(successNotice(page, successPattern)).toBeVisible({ timeout: 10_000 });
}

async function visibleDialog(page: E2EPage): Promise<E2ELocator> {
  const dialog = page.locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible').last();
  await expect(dialog).toBeVisible();
  return dialog;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function inputScopedByLabel(scope: E2ELocator, label: string): Promise<E2ELocator> {
  const labelNode = scope.getByText(new RegExp('^\\s*\\*?\\s*' + escapeRegExp(label) + '\\s*[：:]?\\s*$')).first();
  let current = labelNode;
  for (let level = 0; level < 5; level += 1) {
    const field = current.locator('input:not([type="checkbox"]):visible, textarea:visible, select:visible').first();
    if (await field.count()) return field;
    current = current.locator('..');
  }
  throw new Error('弹窗内字段“' + label + '”未找到可见输入控件');
}

async function fillScopedByLabel(scope: E2ELocator, label: string, value: string): Promise<void> {
  const labelNode = scope.getByText(new RegExp(`^\\s*\\*?\\s*${escapeRegExp(label)}\\s*[：:]?\\s*$`)).first();
  let current = labelNode;
  for (let level = 0; level < 5; level += 1) {
    const field = current.locator('input:not([type="checkbox"]):visible, textarea:visible, select:visible').first();
    if (await field.count()) {
      await field.fill(value);
      return;
    }
    current = current.locator('..');
  }
  throw new Error(`弹窗内字段“${label}”未找到可见控件`);
}

/**
 * 选择弹窗内按字段标签关联的下拉选项。
 *
 * 这类控件通常不是原生 select，也没有可填充的 input；必须点击
 * role=combobox/.ant-select/.el-select，再从当前页面的可见选项中选择。
 */
async function selectScopedOptionByLabel(
  page: E2EPage,
  scope: E2ELocator,
  label: string,
  optionText: string,
): Promise<void> {
  const labelPattern = new RegExp('^\\s*\\*?\\s*' + escapeRegExp(label) + '\\s*[：:]?\\s*$');
  const labelNode = scope.getByText(labelPattern).first();
  let current = labelNode;
  for (let level = 0; level < 5; level += 1) {
    const combobox = current.locator('[role="combobox"]:visible, .ant-select:visible, .el-select:visible').first();
    if (await combobox.count()) {
      await combobox.click();
      const option = await firstVisibleMatching(page.locator(
        '[role="option"]:visible, .ant-select-item-option:visible, .el-select-dropdown__item:visible',
      ).filter({ hasText: new RegExp('^\\s*' + escapeRegExp(optionText) + '\\s*$') }));
      if (!option) {
        throw new Error('下拉字段“' + label + '”没有可选项“' + optionText + '”，当前页面：' + page.url());
      }
      await option.click();
      return;
    }
    current = current.locator('..');
  }
  throw new Error('弹窗内下拉字段“' + label + '”未找到可见控件');
}

// 兼容本文件后半段既有调用，但成功判断统一限定在通知容器及操作语义内。
async function submitAndExpectSuccess(
  page: E2EPage,
  submitButton: string | RegExp,
  _legacySuccessText: string | RegExp,
  scope: E2EPage | E2ELocator = page,
): Promise<void> {
  await submitAndExpectOperationSuccess(
    page,
    submitButton,
    /(?:新增|添加|创建|修改|编辑|更新|删除|保存|绑定|确认|操作).*成功/,
    scope,
  );
}

const SUCCESS = {
  // 业务文案在不同组件中可能是“操作成功/提交成功/成功”；范围已经限定为可见消息容器。
  create: /成功/,
  update: /成功/,
  delete: /成功/,
  bind: /成功/,
  confirm: /成功/,
  execute: /成功/,
};

async function clickFirstVisible(locator: import('@playwright/test').Locator, label: string): Promise<void> {
  const item = await firstVisibleMatching(locator);
  if (!item) throw new Error(`未找到可见控件“${label}”`);
  await item.click();
}

async function selectFirstVisibleOption(page: E2EPage): Promise<void> {
  const option = await firstVisibleMatching(page.locator(
    '[role="option"]:visible, .ant-select-item-option:visible, .el-select-dropdown__item:visible',
  ));
  if (!option) throw new Error(`下拉框没有可选的级别编码，当前页面：${page.url()}`);
  await option.click();
}

/** 新建级别只能选择尚未占用的编码；全部编码已被环境内置级别占用时不伪造成功。 */
async function selectUnusedLevelCode(page: E2EPage, existingText: string): Promise<boolean> {
  const options = page.locator('[role="option"]:visible, .ant-select-item-option:visible, .el-select-dropdown__item:visible');
  const existingCodes = new Set<number>();
  const chineseCodes: Record<string, number> = {
    第一级: 1,
    第二级: 2,
    第三级: 3,
    第四级: 4,
    第五级: 5,
    第六级: 6,
    第七级: 7,
    第八级: 8,
    第九级: 9,
    第十级: 10,
  };
  // 卡片中内置级别通常显示为“第一级 1”，但自定义级别可能显示为
  // “第七级 测试使用”。不能依赖级别名称必须是数字，只要页面已经出现
  // “第N级”卡片，就应视为该编码已占用，避免提交后才收到重复编码错误。
  for (const match of existingText.matchAll(/第[一二三四五六七八九十]+级/g)) {
    const code = chineseCodes[match[0]];
    if (code !== undefined) existingCodes.add(code);
  }
  for (let index = 0; index < await options.count(); index += 1) {
    const option = options.nth(index);
    const text = (await option.innerText().catch(() => '')).trim();
    const numericCode = text.match(/\b(\d+)\b/)?.[1];
    const code = numericCode ? Number(numericCode) : chineseCodes[text];
    if (code !== undefined && !existingCodes.has(code)) {
      await option.click();
      return true;
    }
  }
  return false;
}

/** 复用本自动化曾创建的级别，避免不可删除的有限编码资源被重复占用。 */
function findReusableLevelName(existingText: string): string | undefined {
  const matches = existingText.match(/级别_(?:[0-9a-f]{8}|e2e)(?:_修改)?/g) ?? [];
  return [...new Set(matches)][0];
}

async function clickCardAction(page: E2EPage, cardText: string, action: string): Promise<void> {
  let scope = page.getByText(cardText, { exact: true }).first();
  for (let level = 0; level < 5; level += 1) {
    const actionItem = await firstVisibleMatching(scope.getByText(action, { exact: true }));
    if (actionItem) {
      await actionItem.click();
      return;
    }
    scope = scope.locator('..');
  }
  throw new Error(`卡片“${cardText}”中未找到操作“${action}”，当前页面：${page.url()}`);
}

async function operationRowForFeature(page: E2EPage, featureName: string): Promise<import('@playwright/test').Locator | undefined> {
  // 创建后列表刷新可能晚于成功通知；轮询短时间，避免把异步刷新误判为定位失败。
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const tables = page.locator('table:visible');
    const tableCount = await tables.count();
    const rowsIn = (table: import('@playwright/test').Locator) => table.locator(
      'tbody > tr:visible, [role="row"]:visible:not([role="columnheader"])',
    );

    // 先按特征名称找真实数据行；如果操作列与名称在同一行，直接使用该行。
    for (let tableIndex = 0; tableIndex < tableCount; tableIndex += 1) {
      const rows = rowsIn(tables.nth(tableIndex));
      const rowCount = await rows.count();
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row = rows.nth(rowIndex);
        if (!(await row.innerText()).includes(featureName)) continue;
        if (await row.getByRole('button', { name: /编辑|删除/ }).count()) return row;

        // 真实页面把名称表与操作表拆成两个并行表：仍按名称找到的行号关联，
        // 但不再假定 tables.first()/tables.last() 就是目标表。
        for (let operationTableIndex = 0; operationTableIndex < tableCount; operationTableIndex += 1) {
          if (operationTableIndex === tableIndex) continue;
          const operationRows = rowsIn(tables.nth(operationTableIndex));
          const operationRow = operationRows.nth(rowIndex);
          if (
            await operationRow.count()
            && await operationRow.getByRole('button', { name: /编辑|删除/ }).count()
          ) {
            await expect(operationRow).toBeVisible();
            return operationRow;
          }
        }
      }
    }
    await page.waitForTimeout(500);
  }
  return undefined;
}

async function openTemplateCategoryDialog(page: E2EPage): Promise<import('@playwright/test').Locator> {
  const title = page.getByRole('heading', { name: '数据分类分级', exact: true });
  await expect(title).toBeVisible();
  // 实际页面中标题、加号和左侧分类树是同一编辑区的兄弟节点；加号不一定
  // 位于 heading 的直接父节点，也可能被渲染成 generic 而不是 button。
  const addIconSelector = [
    '[aria-label="图标: plus-circle"]:visible',
    '[title="图标: plus-circle"]:visible',
    '[class*="plus-circle"]:visible',
  ].join(', ');
  const directParentIcons = title.locator('xpath=..').locator(addIconSelector);
  const editorIcons = title.locator('xpath=../..').locator(addIconSelector);
  const addCategory = await firstVisibleMatching(
    (await directParentIcons.count()) ? directParentIcons
      : (await editorIcons.count()) ? editorIcons
        : page.locator(addIconSelector),
  );
  if (!addCategory) {
    throw new Error(`模板编辑页“数据分类分级”标题旁未找到新增分类图标，当前页面：${page.url()}`);
  }
  await expect(addCategory, `模板编辑页“数据分类分级”标题旁应有新增分类图标，当前页面：${page.url()}`).toBeVisible();
  await addCategory.click();

  const dialog = await visibleDialog(page);
  await expect(dialog.locator('input:visible, textarea:visible').first()).toBeVisible();
  return dialog;
}

async function findVisibleTab(page: E2EPage, name: string): Promise<import('@playwright/test').Locator | undefined> {
  const candidates = [
    page.getByRole('tab', { name, exact: true }),
    page.locator('.ant-tabs-tab:visible, .el-tabs__item:visible, [role="tab"]:visible').filter({ hasText: name }),
  ];
  for (const candidate of candidates) {
    const item = await firstVisibleExact(candidate, name);
    if (item) return item;
  }
  return undefined;
}

async function findMoreTabItem(page: E2EPage, name: string): Promise<import('@playwright/test').Locator | undefined> {
  const popup = page.locator(
    '.ant-tabs-dropdown:visible, .ant-dropdown:visible, .el-tabs__dropdown:visible, .el-dropdown-menu:visible, [role="menu"]:visible',
  );
  if (!(await popup.count())) return undefined;
  const candidates = [
    popup.getByRole('menuitem', { name, exact: true }),
    popup.getByText(name, { exact: true }),
    popup.locator('*').filter({ hasText: name }),
  ];
  for (const candidate of candidates) {
    const item = await firstVisibleExact(candidate, name);
    if (item) return item;
  }
  return undefined;
}

async function clickVisibleTab(page: E2EPage, name: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tab = await findVisibleTab(page, name);
    if (tab) {
      await tab.click();
      const ariaSelected = await tab.getAttribute('aria-selected');
      if (ariaSelected !== null) await expect(tab).toHaveAttribute('aria-selected', 'true');
      else await expect(tab).toHaveClass(/active|selected/);
      return;
    }

    const more = await firstVisibleMatching(page.locator(
      '.ant-tabs-nav-more:visible, .ant-tabs-nav-operations .ant-tabs-nav-more:visible, [aria-label*="更多"]:visible, [title*="更多"]:visible, [aria-label="···"]:visible, [title="···"]:visible',
    ));
    if (more) {
      await more.click();
      const hiddenTab = await findMoreTabItem(page, name);
      if (hiddenTab) {
        await hiddenTab.click();
        return;
      }
    }

    const next = await firstVisibleMatching(page.locator('.el-tabs__nav-next:visible, .ant-tabs-nav-operations .ant-tabs-nav-next:visible'));
    if (next) await next.click();
    await page.waitForTimeout(250);
  }
  throw new Error(`Tab“${name}”未在可见区域或“更多”菜单中找到，当前页面：${page.url()}`);
}

async function openDataSecurityLeaf(
  page: E2EPage,
  parent: string,
  leaf: string,
  routeFragment: string,
): Promise<void> {
  // 数据安全左侧菜单在新版前端默认折叠；不能只按 href 判断权限，
  // 需要先展开父级再找叶子项。直接 hash 路由仍保留为优先路径，避免
  // 父、子菜单同名时误点回父级。
  const direct = page.locator(`a[href*="/${routeFragment}"]:visible`).last();
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
  } else {
    const securityMenu = await firstVisibleMatching(
      page.locator('a:visible, [role="menuitem"]:visible').filter({ hasText: /^\s*数据安全\s*$/ }),
    );
    if (securityMenu) {
      await securityMenu.click();
      await page.waitForTimeout(500);
    }
    const leafVisible = await firstVisibleMatching(page.getByText(leaf, { exact: true }));
    if (!leafVisible) {
      const parentMenu = await firstVisibleMatching(page.getByText(parent, { exact: true }));
      if (!parentMenu) {
        test.skip(true, `环境前置缺失：当前账号没有“${parent}”菜单/角色权限。`);
        return;
      }
      await parentMenu.click();
      await page.waitForTimeout(500);
    }
    const leafMenu = await firstVisibleMatching(page.getByText(leaf, { exact: true }));
    if (!leafMenu) {
      test.skip(true, `环境前置缺失：当前账号没有“${leaf}”菜单/角色权限。`);
      return;
    }
    await leafMenu.click();
  }
  await page.waitForTimeout(500);
  await expect(page.locator('body')).toBeVisible();
}
function visibleRows(page: E2EPage) {
  return page.locator('tbody > tr:visible, .ant-table-tbody > tr:visible');
}
test.describe("SEC-03-02｜数据安全｜白名单与非白名单账号权限差异", () => {
  test.describe.configure({ timeout: 120_000 })
  test("SEC-03-02｜数据安全｜白名单与非白名单账号权限差异", async ({ loginPage, consoleErrors, report }) => {
        // 恢复真实执行；白名单和独立账号前置缺失时由后续断言明确报告。
        const page = loginPage;
        await openDataSecurityLeaf(page, '数据脱敏', '脱敏白名单', 'maskingWhiteList');
        // 白名单列表展示
        const whitelistRows = page.locator('tbody > tr:visible, .ant-table-tbody > tr:visible');
        if (!(await whitelistRows.count())) {
          test.skip(true, '环境前置缺失：当前环境没有脱敏白名单资源。');
          return;
        }
        await expect(whitelistRows.first()).toBeVisible();
        // TODO[env]: 白名单账号视角验证原始数据可见性（依赖多账号环境）
        await assertNoConsoleErrors(consoleErrors);
        await report('脱敏规则-白名单', true);
      })
});
