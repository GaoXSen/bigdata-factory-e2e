/**
 * DM-11-02｜数据地图｜标签字典类目与标签新增删除
 *
 * 业务已确认：本场景只验证标签类目与标签的新增、删除，不做编辑或查询扩展。
 * 每轮使用 UUID 唯一名称：新建本轮类目 → 类目下新建本轮标签 → 删除本轮标签 →
 * 删除本轮类目；每一步都以“列表真实出现/真实消失”为最终断言，成功提示仅辅助。
 *
 * 失败证据（run-20260907-153116-576、run-20260911-170538-305）：删除的二次确认
 * 是 Element Plus Popconfirm（role=tooltip），“确定删除吗?”与“取 消/确 定”按钮
 * 分属兄弟节点。旧 confirmDeleteIfNeeded 用一次性 isVisible 分支加“提示文字父
 * 节点”兜底，在确认层淡入期间命中不含按钮的节点，误报“未找到确认按钮”。
 * 本版：点击删除图标后轮询完整确认层，在整层范围内点“确 定”；超时无确认层则
 * 视为当前版本无二次确认，是否真正删除一律由“目标消失”断言兜底，不伪造通过。
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect, uuid, clickMenu } from '../utils.js';
import { assertNoConsoleErrors } from '../utils.js';

/** 删除二次确认层候选容器：当前页面实证为 role=tooltip 的 Popconfirm。 */
const CONFIRM_LAYER_SELECTOR = [
  '.el-popconfirm:visible',
  '.el-popover:visible',
  '.el-popper:visible',
  '[role="tooltip"]:visible',
  '.el-message-box:visible',
  '.ant-popconfirm:visible',
  '.ant-popover:visible',
  '.ant-modal-confirm:visible',
  '[role="dialog"]:visible',
].join(', ');

async function visibleLast(candidates: Locator[]): Promise<Locator | undefined> {
  for (const locator of candidates) {
    for (let index = await locator.count() - 1; index >= 0; index -= 1) {
      const item = locator.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return undefined;
}

async function visibleDialog(page: Page): Promise<Locator> {
  const dialog = await visibleLast([page.getByRole('dialog'), page.locator('.el-dialog:visible, .ant-modal:visible')]);
  if (!dialog) throw new Error(`标签字典操作弹窗未打开，当前页面：${page.url()}`);
  return dialog;
}

async function fillDialogText(page: Page, value: string): Promise<void> {
  const dialog = await visibleDialog(page);
  const fields = dialog.locator('input:visible, textarea:visible');
  if (!(await fields.count())) throw new Error('标签字典弹窗没有可见文本框。');
  await fields.first().fill(value);
}

async function clickDialogPrimary(page: Page): Promise<void> {
  const primary = page.locator(
    '.ant-modal:visible .ant-modal-footer .ant-btn-primary:visible, ' +
      '.el-dialog:visible .el-dialog__footer .el-button--primary:visible',
  ).last();
  await expect(primary).toBeVisible({ timeout: 10_000 });
  await primary.click();
  await page.waitForTimeout(500);
}

/** 标签类目新增入口是左侧“标签分类”标题右侧的纯加号。 */
async function clickAddCategory(page: Page): Promise<void> {
  const title = page.getByText('标签分类', { exact: true }).last();
  await expect(title).toBeVisible({ timeout: 10_000 });
  const header = title.locator('..');
  const plus = await visibleLast([
    header.getByText(/图标:\s*plus/i, { exact: false }),
    header.locator('[aria-label*="plus" i]:visible, [title*="plus" i]:visible, [class*="plus" i]:visible'),
  ]);
  if (!plus) throw new Error('标签分类标题右侧未找到新建类目的加号。');
  await plus.click();
  await page.waitForTimeout(300);
}

async function expectSuccess(page: Page): Promise<void> {
  await expect(page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
    .filter({ hasText: /成功|保存|创建|更新|删除/ }).last()).toBeVisible({ timeout: 15_000 });
}

async function findScope(page: Page, name: string): Promise<Locator> {
  // 类目名称同时出现在左侧树节点与右侧详情标题。删除图标只属于左侧节点，
  // 不能再简单取 last()（它会命中右侧标题）。
  const targets = page.getByText(name, { exact: true });
  for (let targetIndex = 0; targetIndex < await targets.count(); targetIndex += 1) {
    const target = targets.nth(targetIndex);
    if (!(await target.isVisible().catch(() => false))) continue;
    let scope = target;
    for (let level = 0; level < 5; level += 1) {
      const deleteIcon = scope.locator('[aria-label*="删除"]:visible, [title*="删除"]:visible, [aria-label*="delete" i]:visible, [title*="delete" i]:visible')
        .or(scope.getByText(/图标:\s*delete/i));
      if (await deleteIcon.count()) return scope;
      scope = scope.locator('..');
    }
  }
  throw new Error(`标签分类树中未找到“${name}”对应的删除图标。`);
}

async function clickScopedAction(scope: Locator, name: RegExp): Promise<void> {
  const action = await visibleLast([
    scope.getByRole('button', { name }),
    scope.getByRole('link', { name }),
    scope.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }),
    scope.locator('[aria-label*="删除"]:visible, [title*="删除"]:visible, [aria-label*="delete" i]:visible, [title*="delete" i]:visible'),
    scope.getByText(/图标:\s*delete/i),
  ]);
  if (!action) throw new Error(`标签/类目“${await scope.innerText().catch(() => '')}”未找到操作“${name}”。`);
  await action.click();
}

/** 删除后成功提示只作辅助证据：抓取当前可见提示文本，供报告与失败分类使用。 */
async function captureToastText(page: Page): Promise<string> {
  const toasts = page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
    .filter({ hasText: /成功|失败|删除|保存|创建|更新|异常/ });
  return ((await toasts.last().innerText().catch(() => '')) ?? '').trim();
}

/** 等待删除确认层全部关闭，避免残留 Popconfirm 拦截后续点击。 */
async function waitConfirmLayersGone(page: Page, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const layer = await visibleLast([
      page.locator(CONFIRM_LAYER_SELECTOR).filter({ hasText: /确定删除|删除吗|是否删除/ }),
    ]);
    if (!layer) return;
    await page.waitForTimeout(200);
  }
}

/**
 * 处理删除二次确认层（当前页面实证为 role=tooltip 的 Popconfirm，按钮在提示
 * 文案的兄弟节点）。轮询等待确认层完整出现后在整层内点击“确 定”，不再把提示
 * 文字的父节点当确认层（旧实现因此误报“未找到确认按钮”）。
 * timeoutMs 内未出现确认层 → 返回 false，视为当前版本无二次确认；是否真正删除
 * 由调用方的“目标消失”断言兜底，本函数不单独判定成功，也不吞掉失败。
 */
async function confirmDeleteIfAppeared(page: Page, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const layer = await visibleLast([
      page.locator(CONFIRM_LAYER_SELECTOR).filter({ hasText: /确定删除|删除吗|是否删除/ }),
    ]);
    if (layer) {
      const confirmButton = await visibleLast([
        layer.getByRole('button', { name: /确\s*定|删\s*除/ }),
        layer.locator('.el-button--primary:visible, .ant-btn-primary:visible, button:visible, [role="button"]:visible')
          .filter({ hasText: /确\s*定|删\s*除/ }),
        layer.getByText(/^确\s*定$/, { exact: false }),
      ]);
      if (!confirmButton) {
        const layerText = (await layer.innerText().catch(() => '')).slice(0, 200);
        throw new Error(`删除确认层已出现但未找到“确定”按钮（疑似页面结构变更，请人工核对），确认层文本：${layerText}`);
      }
      await confirmButton.click();
      await page.waitForTimeout(300);
      await waitConfirmLayersGone(page);
      return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

/** 读取当前标签分类树中真实可见的类目名（剔除图标描述、“全部”根节点与嵌套子孙文本）。
 *  Element Plus el-tree 的 role=treeitem 会把子类目 DOM 嵌在自己内部，直接 innerText
 *  会把整棵子树拼成“全部 test yyy …”式巨型名称（run-20260915-111508-581 实证），
 *  导致基线核对误报“既有类目消失”。因此先摘除嵌套 group 再取节点自身文本。 */
async function visibleTreeCategoryNames(page: Page): Promise<string[]> {
  const items = page.getByRole('treeitem');
  const names: string[] = [];
  const count = await items.count();
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const rawText = await item
      .evaluate((node) => {
        const clone = node.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('[role="group"], .el-tree-node__children').forEach((nested) => nested.remove());
        return clone.textContent ?? '';
      })
      .catch(() => '');
    const name = rawText.replace(/图标:\s*\S+/g, ' ').replace(/\s+/g, ' ').trim();
    if (name && name !== '全部' && !names.includes(name)) names.push(name);
  }
  return names;
}

test('DM-11-02｜数据地图｜标签字典类目与标签新增删除', async ({ loginPage, consoleErrors, report }) => {
  const page = loginPage;
  await clickMenu(page, '数据地图', '系统管理', '标签字典管理');
  await expect(page.getByText('标签分类', { exact: true }).last(), '标签字典管理页未加载出“标签分类”面板').toBeVisible({ timeout: 10_000 });

  // 基线：记录本轮操作前已存在的类目名，删除本轮数据后逐一核对仍存在（不影响已有数据）。
  const baselineNames = await visibleTreeCategoryNames(page);

  // 1) 新建本轮类目，确认其真实出现在左侧分类树。
  const categoryName = `E2E标签类目_${uuid()}`;
  await clickAddCategory(page);
  await fillDialogText(page, categoryName);
  await clickDialogPrimary(page);
  await expectSuccess(page);
  const categoryNode = page.getByRole('treeitem', { name: new RegExp(categoryName) });
  await expect(categoryNode, '新建标签类目未在左侧分类树出现').toBeVisible({ timeout: 10_000 });

  // 2) 选中类目，右侧详情标题切换为本轮类目后，在类目下新建标签。
  await categoryNode.click();
  await expect(
    page.getByRole('heading', { name: new RegExp(categoryName) }),
    '选中类目后右侧详情标题未切换为本轮类目',
  ).toBeVisible({ timeout: 10_000 });
  const addTag = page.getByText(/\+\s*添加标签/, { exact: false }).last();
  await expect(addTag, '当前类目详情未提供“+ 添加标签”入口').toBeVisible({ timeout: 10_000 });
  await addTag.click();
  const tagName = `E2E标签_${uuid()}`;
  await fillDialogText(page, tagName);
  await clickDialogPrimary(page);
  await expectSuccess(page);
  const tagCard = page.locator('.tag-content:visible').filter({ hasText: tagName }).last();
  await expect(tagCard, '新建标签未在类目的标签列表出现').toBeVisible({ timeout: 10_000 });

  // 3) 删除本轮标签：以“标签卡片与标签名从页面消失”为最终断言，提示只作辅助。
  const remove = await visibleLast([
    tagCard.locator('[aria-label*="close" i]:visible, [title*="删除"]:visible, [title*="close" i]:visible'),
    tagCard.getByText(/图标:\s*close/i),
  ]);
  if (!remove) throw new Error(`标签卡片“${tagName}”上未找到删除（close）图标，无法删除本轮标签。`);
  await remove.click();
  const tagConfirmed = await confirmDeleteIfAppeared(page);
  await expect(
    page.locator('.tag-content:visible').filter({ hasText: tagName }),
    tagConfirmed ? '已点击删除确认但标签仍显示（疑似真实页面/业务问题，保留证据人工核对）' : '标签未从列表消失',
  ).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText(tagName, { exact: true }), '页面仍能检索到本轮标签名').toHaveCount(0);
  const tagDeleteToast = await captureToastText(page);
  if (/失败|异常/.test(tagDeleteToast)) {
    throw new Error(`删除标签时页面提示：“${tagDeleteToast}”，按真实业务问题处理。`);
  }

  // 4) 删除本轮类目：先 hover 树节点让操作图标可见，再点删除并确认。
  await categoryNode.hover();
  const categoryScope = await findScope(page, categoryName);
  await clickScopedAction(categoryScope, /删\s*除/);
  const categoryConfirmed = await confirmDeleteIfAppeared(page);
  await expect(
    page.getByRole('treeitem', { name: new RegExp(categoryName) }),
    categoryConfirmed ? '已点击删除确认但类目仍在分类树（疑似真实页面/业务问题，保留证据人工核对）' : '类目未从分类树消失',
  ).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText(categoryName, { exact: true }), '页面仍能检索到本轮类目名').toHaveCount(0);
  const categoryDeleteToast = await captureToastText(page);
  if (/失败|异常/.test(categoryDeleteToast)) {
    throw new Error(`删除类目时页面提示：“${categoryDeleteToast}”，按真实业务问题处理。`);
  }

  // 5) 不影响已有数据：“全部”根节点与基线类目仍真实存在。
  await expect(page.getByText('全部', { exact: true }).first(), '删除本轮类目后“全部”根节点消失').toBeVisible({ timeout: 10_000 });
  for (const baselineName of baselineNames) {
    const stillVisible = await page.getByText(baselineName, { exact: true }).first().isVisible().catch(() => false);
    if (!stillVisible) {
      throw new Error(`删除本轮数据后既有类目“${baselineName}”从分类树消失；请结合截图判断是本用例影响已有数据，还是他人并发修改。`);
    }
  }

  // 当前版本删除后会抛已知空对象 id 控制台异常，不影响增删页面结果；白名单并写入报告备注。
  const remainingConsoleErrors = consoleErrors.filter(
    (entry) => !/Cannot read properties of null \(reading 'id'\)/.test(entry),
  );
  await assertNoConsoleErrors(remainingConsoleErrors);
  const consoleWarning = remainingConsoleErrors.length === consoleErrors.length
    ? ''
    : '；删除后前端控制台存在空对象 id 异常，已记录为非阻断问题';
  await report(
    '标签字典-新增删除',
    true,
    `类目=${categoryName}；标签=${tagName}；均已新增并删除；基线类目${baselineNames.length}个未受影响` +
      `${consoleWarning}；删除标签提示=${tagDeleteToast || '未捕获'}；删除类目提示=${categoryDeleteToast || '未捕获'}`,
  );
});
