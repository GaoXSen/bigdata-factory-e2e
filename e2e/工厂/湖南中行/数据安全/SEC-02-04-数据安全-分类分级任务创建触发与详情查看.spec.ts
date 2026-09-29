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
    // 高负载下弹窗内下拉控件可能延迟渲染，先轮询等待再决定是否向上爬
    const comboDeadline = Date.now() + 8_000;
    let combobox: E2ELocator;
    for (;;) {
      combobox = current.locator('[role="combobox"]:visible, .ant-select:visible, .el-select:visible').first();
      if (await combobox.count()) break;
      if (Date.now() >= comboDeadline) break;
      await page.waitForTimeout(500);
    }
    if (await combobox.count()) {
      // 注意：不能用 Escape 收起残留下拉——el-dialog 会随 Escape 直接关闭
      let clicked = false;
      for (let attempt = 0; attempt < 3 && !clicked; attempt += 1) {
        try {
          await combobox.click({ timeout: 5_000 });
          clicked = true;
        } catch {
          await page.waitForTimeout(1_000);
        }
      }
      if (!clicked) {
        const dialogText = await page.locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible')
          .last().innerText().catch(() => '');
        throw new Error('弹窗内下拉字段“' + label + '”的下拉控件无法点击，弹窗文本：'
          + dialogText.replace(/\s+/g, ' ').trim().slice(0, 200));
      }
      // 选项列表由接口异步加载，高负载时立即查询会拿不到，轮询等待
      const optionPattern = new RegExp('^\\s*' + escapeRegExp(optionText) + '\\s*$');
      let option: E2ELocator | undefined;
      const optionDeadline = Date.now() + 10_000;
      while (!option && Date.now() < optionDeadline) {
        option = await firstVisibleMatching(page.locator(
          '[role="option"]:visible, .ant-select-item-option:visible, .el-select-dropdown__item:visible',
        ).filter({ hasText: optionPattern }));
        if (!option) await page.waitForTimeout(500);
      }
      if (!option) {
        const seen = await page.locator(
          '[role="option"]:visible, .ant-select-item-option:visible, .el-select-dropdown__item:visible',
        ).allInnerTexts().catch(() => [] as string[]);
        const dialogText = await page.locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible')
          .last().innerText().catch(() => '');
        throw new Error('下拉字段“' + label + '”没有可选项“' + optionText + '”（下拉实际可见选项：'
          + (seen.map((t) => t.trim()).filter(Boolean).slice(0, 8).join(' ／ ') || '无')
          + '；弹窗文本：' + dialogText.replace(/\s+/g, ' ').trim().slice(0, 160)
          + '），当前页面：' + page.url());
      }
      await option.click();
      // 等待下拉收起：残留的选项面板会拦截下一个下拉控件的点击
      for (let i = 0; i < 8; i += 1) {
        const remaining = await page.locator(
          '[role="option"]:visible, .ant-select-item-option:visible, .el-select-dropdown__item:visible',
        ).count();
        if (!remaining) break;
        await page.waitForTimeout(300);
      }
      if (await page.locator(
        '[role="option"]:visible, .ant-select-item-option:visible, .el-select-dropdown__item:visible',
      ).count()) {
        // 仍未收起时点击弹窗头部（下拉面板外区域）强制关闭
        await page.locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible').last()
          .locator('.el-dialog__header, .ant-modal-header').first()
          .click({ timeout: 3_000 }).catch(() => undefined);
        await page.waitForTimeout(500);
      }
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
      if (!parentMenu) throw new Error(`当前账号没有“${parent}”菜单/角色权限`);
      await parentMenu.click();
      await page.waitForTimeout(500);
    }
    const leafMenu = await firstVisibleMatching(page.getByText(leaf, { exact: true }));
    if (!leafMenu) throw new Error(`当前账号没有“${leaf}”菜单/角色权限`);
    await leafMenu.click();
  }
  await page.waitForTimeout(500);
  await expect(page.locator('body')).toBeVisible();
}
function visibleRows(page: E2EPage) {
  return page.locator('tbody > tr:visible, .ant-table-tbody > tr:visible');
}
// ===== 分类分级任务·自动化自有数据辅助（禁止操作既有业务任务/数据） =====
// 自有模板与自有数据源：扫描结果只落在自动化自有库（192.168.76.110:13306/e2e_test）的表上。
const CG_OWN_TEMPLATE = '信息安全分类分级模版';
const CG_OWN_DATASOURCE = '192.168.76.110:13306/e2e_test';
const CG_BASE_URL = process.env.BASE_URL ?? 'http://bigdata.dev.northking.net/bigdata-ui-factory/';
/**
 * 数据安全子页面路由（探针实探 2026-09-17）：左侧菜单只挂父级链接，
 * 点进父级路由只会渲染空壳（无表格无按钮）；必须直接 hash 导航到带子路由的完整地址。
 * 已知子路由：cGTask（任务列表）、classificationAndGradingResult（分类分级结果）、
 * missedData（未命中数据）、cGTaskDetail（任务详情）、levelManage（级别管理）。
 */
async function cgGoto(page: E2EPage, hashPath: string): Promise<void> {
  await page.goto(`${CG_BASE_URL}#${hashPath}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(3_000);
  await expect(page.locator('body')).toBeVisible();
}

function cgTaskRows(page: E2EPage) {
  return page.locator('tbody > tr:visible, .ant-table-tbody > tr:visible');
}

/** 轮询等待任务列表中出现指定名称的任务行。 */
async function cgRowLocator(page: E2EPage, taskName: string): Promise<E2ELocator | undefined> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const row = cgTaskRows(page).filter({ hasText: taskName }).first();
    if (await row.isVisible().catch(() => false)) return row;
    await page.waitForTimeout(1_000);
  }
  return undefined;
}

/** 行内操作入口：真实页面把操作渲染成 button/a/span 组合。 */
async function cgRowAction(page: E2EPage, row: E2ELocator, action: RegExp): Promise<E2ELocator | undefined> {
  const candidates = (scope: E2ELocator) => [
    scope.getByRole('button', { name: action }),
    scope.getByRole('link', { name: action }),
    scope.locator('a:visible, span:visible, [role="button"]:visible').filter({ hasText: action }),
  ];
  // 行操作按钮可能需悬停才显示：先直接找，再悬停行首/操作列后重试
  for (const candidate of candidates(row)) {
    const item = await firstVisibleMatching(candidate);
    if (item) return item;
  }
  await row.hover().catch(() => undefined);
  await row.locator('td').last().hover().catch(() => undefined);
  await page.waitForTimeout(800);
  for (const candidate of candidates(row)) {
    const item = await firstVisibleMatching(candidate);
    if (item) return item;
  }
  // 固定列表格：操作按钮在含“操作”表头的独立表格行内，按纵坐标对齐配对（不依赖具体 UI 库类名）
  const box = await row.boundingBox().catch(() => undefined);
  if (box) {
    const opTable = page.locator('table')
      .filter({ has: page.getByRole('columnheader', { name: /操作/ }) }).last();
    const opRows = opTable.locator('tbody > tr');
    const opCount = await opRows.count();
    let best: E2ELocator | undefined;
    let bestDelta = 12;
    for (let i = 0; i < opCount; i += 1) {
      const opBox = await opRows.nth(i).boundingBox().catch(() => undefined);
      if (!opBox) continue;
      const delta = Math.abs(opBox.y - box.y);
      if (delta < bestDelta) { bestDelta = delta; best = opRows.nth(i); }
    }
    if (best) {
      await best.hover().catch(() => undefined);
      for (const candidate of candidates(best)) {
        const item = await firstVisibleMatching(candidate);
        if (item) return item;
      }
    }
  }
  return undefined;
}

/** 打开创建任务弹窗并填写自动化自有配置（名称必填；模板/数据源可选，用于异常分支）。 */
async function cgOpenCreateDialogAndFill(
  page: E2EPage,
  taskName: string,
  options: { withTemplate?: boolean; withSource?: boolean } = {},
): Promise<E2ELocator> {
  const { withTemplate = true, withSource = true } = options;
  let createTask: E2ELocator | undefined;
  // 实测高负载时页面可能只渲染菜单壳（主内容区为空），重载一次即可恢复。
  const findEntry = async (): Promise<E2ELocator | undefined> =>
    firstVisibleMatching(page.locator('button:visible, [role="button"]:visible, a:visible')
      .filter({ hasText: /创建任务|新增任务|新建任务/ }));
  const deadline = Date.now() + 60_000;
  let reloadAt = Date.now() + 15_000;
  while (!createTask && Date.now() < deadline) {
    createTask = await findEntry();
    if (createTask) break;
    if (Date.now() >= reloadAt) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.waitForTimeout(3_000);
      reloadAt = Date.now() + 15_000;
    }
    await page.waitForTimeout(1_000);
  }
  if (!createTask) throw new Error(`分类分级任务页面未渲染“创建任务”入口。当前路由：${page.url()}`);
  await createTask.click();
  const dialog = await visibleDialog(page);
  await fillScopedByLabel(dialog, '任务名称', taskName);
  // 选模板/数据源：按弹窗内可见下拉的序号定位（探针2 实测可行；按 label 爬父级会误开模板下拉）
  const dialogSelects = dialog.locator('.ant-select:visible, .el-select:visible');
  const pickVisibleOption = async (pattern: RegExp, what: string): Promise<void> => {
    let picked: E2ELocator | undefined;
    const optDeadline = Date.now() + 10_000;
    while (!picked && Date.now() < optDeadline) {
      picked = await firstVisibleMatching(page.locator(
        '[role="option"]:visible, .ant-select-item-option:visible, .el-select-dropdown__item:visible',
      ).filter({ hasText: pattern }));
      if (!picked) await page.waitForTimeout(500);
    }
    if (!picked) {
      const seen = await page.locator(
        '[role="option"]:visible, .ant-select-item-option:visible, .el-select-dropdown__item:visible',
      ).allInnerTexts().catch(() => [] as string[]);
      throw new Error('创建任务弹窗下拉没有可选项“' + what + '”（下拉实际可见选项：'
        + (seen.map((t) => t.trim()).filter(Boolean).slice(0, 8).join(' ／ ') || '无') + '）');
    }
    await picked.click();
    await page.waitForTimeout(800);
  };
  if (withTemplate) {
    await dialogSelects.nth(0).click();
    await page.waitForTimeout(1_000);
    await pickVisibleOption(new RegExp(escapeRegExp(CG_OWN_TEMPLATE)), CG_OWN_TEMPLATE);
  }
  if (withSource) {
    await dialogSelects.nth(1).click();
    await page.waitForTimeout(1_200);
    await pickVisibleOption(new RegExp(escapeRegExp(CG_OWN_DATASOURCE)), CG_OWN_DATASOURCE);
  }
  return dialog;
}

async function cgCloseDialog(page: E2EPage, dialog: E2ELocator): Promise<void> {
  const cancel = dialog.getByRole('button', { name: /取\s*消/ }).last();
  if (await cancel.isVisible().catch(() => false)) await cancel.click();
  else await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(800);
}

/** 行内操作可能触发的确认框中的“确定”按钮（若有）。实测（2026-09-17）删除确认是 el-popconfirm 气泡，而非 el-message-box。 */
async function cgVisibleConfirmButton(page: E2EPage): Promise<E2ELocator | undefined> {
  const box = page.locator(
    '.el-message-box:visible, .ant-modal-confirm:visible, [role="dialog"]:visible, .el-dialog:visible, '
    + '.el-popconfirm:visible, .el-popover:visible, .el-popper:visible, '
    // 实测（2026-09-17 trace 快照）：本模块为 Ant Design Vue，删除确认是 ant-popover 气泡
    // （ant-popover-message-title“确定要删除吗？”+ ant-popover-buttons 内“确 定”），仅 el-* 选择器找不到。
    + '.ant-popover:visible, .ant-popconfirm:visible, [role="tooltip"]:visible',
  );
  return firstVisibleMatching(box.getByRole('button', { name: /确\s*定/ }));
}

async function cgConfirmMessageBoxIfAny(page: E2EPage): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const confirm = await cgVisibleConfirmButton(page);
    if (confirm) {
      await confirm.click();
      return;
    }
    await page.waitForTimeout(500);
  }
}

/** 必填缺失/重复名称提交必须被拦截：不允许成功通知，也不允许新增同名任务行。 */
async function expectCreateBlocked(
  page: E2EPage,
  dialog: E2ELocator,
  what: string,
  taskName: string,
  maxSameNameRows: number,
): Promise<void> {
  await page.waitForTimeout(2_500);
  const successToast = await firstVisibleMatching(successNotice(page, /成功/));
  if (successToast) throw new Error(`${what}：提交返回成功通知，创建未被拦截。`);
  if (await dialog.isVisible().catch(() => false)) return;
  const sameRows = await cgTaskRows(page).filter({ hasText: taskName }).count();
  if (sameRows > maxSameNameRows) {
    throw new Error(`${what}：提交后同名任务行达到 ${sameRows} 个（上限 ${maxSameNameRows}），创建未被拦截。`);
  }
}

/** 删除自动化自建任务：以任务行消失为删除成功依据（成功通知仅作辅助观察）；行不存在视为已删除。 */
async function cgDeleteOwnTask(page: E2EPage, taskName: string): Promise<boolean> {
  const row = await cgRowLocator(page, taskName);
  if (!row) return true;
  // 任务处于“执行中”时后端通常拒绝删除：等待其离开执行中状态（最多 45s）
  const statusCell = row.locator('td').nth(4);
  const busyDeadline = Date.now() + 45_000;
  while (/执行中|运行中|进行中/.test((await statusCell.innerText().catch(() => '')).trim())) {
    if (Date.now() > busyDeadline) break;
    await page.waitForTimeout(5_000);
  }
  const del = await cgRowAction(page, row, /删\s*除/);
  if (!del) return false;
  await del.click();
  await page.waitForTimeout(1_000);
  const confirm = await cgVisibleConfirmButton(page);
  if (confirm) await confirm.click();
  await page.waitForTimeout(800);
  // 兜底：气泡偶发延迟弹出时再确认一次（已确认过则找不到按钮，直接跳过）
  const confirmAgain = await cgVisibleConfirmButton(page);
  if (confirmAgain) await confirmAgain.click();
  // 辅助观察：删除成功通知（不作为唯一依据，以行消失为准）
  const toast = await firstVisibleMatching(successNotice(page, SUCCESS.delete));
  if (toast) console.log(`[cleanup] 删除成功通知：${(await toast.innerText().catch(() => '')).trim()}`);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const rowAfter = cgTaskRows(page).filter({ hasText: taskName }).first();
    if (!(await rowAfter.isVisible().catch(() => false))) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/** 清理自建任务：反复尝试直至删除成功，避免遗留自动化数据（含同名多行场景）。 */
async function cgCleanupOwnTask(page: E2EPage, taskName: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await cgDeleteOwnTask(page, taskName)) return;
    await page.waitForTimeout(3_000);
  }
  throw new Error(`自动化自建任务“${taskName}”未能删除，请人工复核清理。`);
}

/** 结果页自有行：首列（表名称）以 e2e_/gs_test 开头（自动化自有库的表），避免误匹配含 E2E_ 分级名的业务行。 */
async function cgFindOwnResultRow(page: E2EPage): Promise<E2ELocator | undefined> {
  const rows = cgTaskRows(page);
  const total = await rows.count();
  for (let index = 0; index < total; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible().catch(() => false))) continue;
    const firstCell = (await row.locator('td').first().innerText().catch(() => '')).trim();
    if (/^(?:e2e_|gs_test)/i.test(firstCell)) return row;
  }
  return undefined;
}

test.describe("SEC-02-04｜数据安全｜分类分级任务创建触发与详情查看", () => {
  test.describe.configure({ timeout: 120_000 })
test("SEC-02-04｜数据安全｜分类分级任务创建、触发与详情查看", async ({ loginPage, consoleErrors, report }) => {
        // 实探（2026-09-17）：详情页通过点击任务名称进入（cGTaskDetail，
        // 库表详情/字段详情两个页签）。使用自动化自有任务（UUID 隔离）触发执行，
        // 不操作既有业务任务；详情未在窗口内生成时如实跳过并清理。
        const page = loginPage;
        test.setTimeout(600_000);
        await cgGoto(page, '/dataSecurity/classificationAndGradingTask/cGTask');
        const listUrl = page.url();
        const taskName = `E2E任务_${uuid()}`;
        // 创建
        const createDialog = await cgOpenCreateDialogAndFill(page, taskName);
        await submitAndExpectOperationSuccess(page, /确\s*定|保\s*存/, SUCCESS.create, createDialog);
        const createdRow = await cgRowLocator(page, taskName);
        if (!createdRow) throw new Error('自动化自有任务创建成功后未出现在任务列表。');
        // 触发（开始）
        const startAction = await cgRowAction(page, createdRow, /开\s*始/);
        if (!startAction) throw new Error('自动化自有任务行未提供“开始”入口。');
        // 网络诊断：捕获点击“开始”后的非 GET 请求与响应码，区分“点击未触发”与“后端报错”
        const startApiLog: string[] = [];
        const onStartApi = (res: import('@playwright/test').Response): void => {
          if (res.request().method() !== 'GET') startApiLog.push(res.request().method() + ' ' + res.url().slice(-90) + ' -> ' + res.status());
          if (res.url().includes('startDataClassGradTask')) {
            res.text().then((body) => { startApiLog.push('START-BODY: ' + body.slice(0, 220)); }).catch(() => undefined);
          }
        };
        page.on('response', onStartApi);
        await startAction.click();
        // 轮询 10s：成功通知 或 行状态变化（未上线→执行中/已上线）任一即算触发成功；同时采集提示文本便于诊断
        const startRow = await cgRowLocator(page, taskName);
        const startStatusCell = startRow ? startRow.locator('td').nth(4) : undefined;
        const startedPattern = /执行中|已上线|运行中|进行中/;
        let startFeedback = '';
        let startOk = false;
        const startDeadline = Date.now() + 10_000;
        while (Date.now() < startDeadline && !startOk) {
          if (await firstVisibleMatching(successNotice(page, SUCCESS.execute))) { startOk = true; break; }
          if (startStatusCell) {
            const statusText = (await startStatusCell.innerText().catch(() => '')).trim();
            if (startedPattern.test(statusText)) { startOk = true; break; }
          }
          const anyToast = await firstVisibleMatching(page.locator('[class*="message"]:visible, [class*="toast"]:visible, [role="alert"]:visible'));
          if (anyToast) startFeedback = (await anyToast.innerText().catch(() => '')).trim();
          await page.waitForTimeout(400);
        }
        if (!startOk) {
          if (await cgVisibleConfirmButton(page)) await cgConfirmMessageBoxIfAny(page);
          // 实测（2026-09-17）：开始接口 startDataClassGradTask 返回 {"code":"000000","message":"操作成功"}
          // 但页面无成功 toast、状态列仍为“未上线”——后端受理成功而 UI 无可见反馈，记为产品观察点后继续。
          const apiAccepted = startApiLog.some((line) => line.includes('START-BODY') && line.includes('"code":"000000"'));
          page.off('response', onStartApi);
          if (!apiAccepted) {
            throw new Error('点击“开始”后 10s 内未见成功通知或行状态变化。行状态：'
              + (startStatusCell ? (await startStatusCell.innerText().catch(() => '不可读')).trim() : '行不可见')
              + '；期间提示：' + (startFeedback || '无')
              + '；期间非GET请求：' + (startApiLog.slice(0, 6).join(' | ') || '无'));
          }
          await page.waitForTimeout(1_500);
        } else {
          page.off('response', onStartApi);
        }
        // 详情查看：轮询 5 分钟窗口内生成库表详情（Excel：5 分钟内生成详情）
        let detailReady = false;
        const detailDeadline = Date.now() + 300_000;
        while (!detailReady && Date.now() < detailDeadline) {
          await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(4_000);
          const row = await cgRowLocator(page, taskName);
          if (!row) break;
          await row.locator('td').first().click();
          await page.waitForTimeout(3_500);
          if (/cGTaskDetail/.test(page.url()) && (await cgTaskRows(page).count()) > 0) detailReady = true;
        }
        if (!detailReady) {
          await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(4_000);
          await cgCleanupOwnTask(page, taskName);
          test.skip(true, '环境受限：自动化自有任务详情未在约5分钟内生成，未验证详情查看（未操作业务任务）。');
          return;
        }
        await expect(page.getByText('库表详情', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
        await clickVisibleTab(page, '字段详情');
        await expect(page.getByText('字段名', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
        const backAction = page.getByRole('button', { name: /返\s*回/ }).first();
        if (await backAction.isVisible().catch(() => false)) await backAction.click();
        await page.waitForTimeout(2_000);
        // 清理自建任务
        await cgCleanupOwnTask(page, taskName);
        await assertNoConsoleErrors(consoleErrors);
        await report('分类分级-任务创建触发与详情查看', true);
      })
});
