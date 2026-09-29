/**
 * 系统管理 E2E 测试
 *
 * 覆盖场景（参考 Excel「测试用例」Sheet）：
 *   行19 — 部门管理：机构部门树；新增/编辑/删除机构、部门；
 *          编码唯一；名称同层级唯一；机构下可有机构/部门；部门下仅有部门
 *
 * DS-PERM-62 清洁环境迁移（2026-09-22，静态开发）：
 *   - 原“断言列表有可见行”冒烟壳按标题语义补齐真实主链路：
 *     新增机构→查询→行内新增子部门→查询→编辑改名→查询→删除（先子后父）→查询，
 *     断言全部来自页面实际表现，不写死通过结果；
 *   - 部门实体当前产品模型（后端 SystemDeptController/SystemDeptBizImpl 实证）
 *     仅 dept_name/parent_id/order_num，无“编码”字段；同层唯一性由
 *     “部门名重复，请重新输入”承载（重复/层级拦截断言见 SM-01-02）；
 *   - 所有可变名称均为本轮 UUID 派生 ASCII 标识（节点前缀互不为子串，避免
 *     行过滤误匹配）；父子参照节点为本轮自建，不依赖历史部门/固定用户/角色；
 *     finally 仅回收本轮创建的节点（scoped cleanup，失败只记录不掩盖主结果）；
 *   - 登录走公共配置 loginPage 夹具（TEST_USER/TEST_PASS 由 runner 注入），
 *     spec 内无任何凭据；
 *   - 环境校准点（headed 首跑核对）：工具栏“新增”默认层级=根；弹窗内“部门名称”
 *     输入框按 placeholder 识别（与页面搜索框同名，必须限定弹窗范围）。
 *
 * 关键要求：
 *   1. 所有操作用 page. 浏览器操作（无 fetch/axios 等 API 调用）
 *   2. UUID 后缀隔离所有测试数据
 *   3. 控制台错误收集
 */

import type { Locator } from '@playwright/test';
import { test, expect, uuid, clickMenu, assertNoConsoleErrors } from '../utils.js';

type E2EPage = Parameters<typeof clickMenu>[0];

async function firstVisibleMatching(locator: import('@playwright/test').Locator): Promise<import('@playwright/test').Locator | undefined> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

/**
 * 系统管理的 Tab 在窄窗口下会被收进 Ant/Element 的“更多”菜单。
 * 本 spec 内自带点击器，避免把隐藏 Tab 当成不存在，也不修改共享工具。
 */
async function clickSystemTab(page: E2EPage, name: string): Promise<void> {
  const tabSelector = '[role="tab"]:visible, .ant-tabs-tab:visible, .el-tabs__item:visible';
  const findDirect = async (): Promise<import('@playwright/test').Locator | undefined> => {
    const candidates = [
      page.locator(tabSelector).filter({ hasText: new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}\\s*$`) }),
      page.getByRole('tab', { name, exact: true }),
    ];
    for (const candidate of candidates) {
      const item = await firstVisibleMatching(candidate);
      if (item) return item;
    }
    return undefined;
  };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const direct = await findDirect();
    if (direct) {
      await direct.click();
      const selected = await direct.getAttribute('aria-selected');
      if (selected !== null) await expect(direct).toHaveAttribute('aria-selected', 'true');
      await page.waitForTimeout(500);
      return;
    }

    const more = await firstVisibleMatching(page.locator(
      '.ant-tabs-nav-operations .ant-tabs-nav-more:visible, .el-tabs__nav-more:visible, [role="tablist"]:visible [aria-label*="更多"]:visible, [role="tablist"]:visible [title*="更多"]:visible, [role="tablist"]:visible [aria-label="···"]:visible, [role="tablist"]:visible [title="···"]:visible',
    ));
    if (more) {
      await more.click();
      const popup = page.locator(
        '.ant-tabs-dropdown:visible, .ant-dropdown:visible, .el-tabs__dropdown-menu:visible, .el-dropdown-menu:visible, [role="menu"]:visible',
      );
      const hidden = await firstVisibleMatching(
        popup.getByRole('menuitem', { name, exact: true }).or(popup.getByText(name, { exact: true })),
      );
      if (hidden) {
        await hidden.click();
        await page.waitForTimeout(500);
        return;
      }
    }
    await page.waitForTimeout(250);
  }

  const emptyState = page.getByText(/暂无数据|暂无记录|没有数据|没有记录/).first();
  if (await emptyState.isVisible().catch(() => false)) {
    throw new Error( `当前环境没有可切换的“${name}”数据权限 Tab 内容`);
    return;
  }
  throw new Error(`系统管理 Tab“${name}”未找到（已检查可见 Tab 及“更多”菜单），当前页面：${page.url()}`);
}

async function expectVisibleText(page: E2EPage, pattern: string | RegExp, label = String(pattern)): Promise<void> {
  if (label === '成功' || (pattern instanceof RegExp && pattern.source === '成功')) {
    await expect(successNotice(page, /(?:新增|添加|创建|修改|编辑|更新|删除|保存|同意|拒绝|操作).*成功/)).toBeVisible({ timeout: 10_000 });
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

async function submitAndExpectSuccess(
  page: E2EPage,
  submitButton: string | RegExp,
  _legacySuccessText: string | RegExp,
): Promise<void> {
  const submit = page.getByRole('button', { name: submitButton }).last();
  await expect(submit).toBeVisible();
  await submit.click();
  await expect(successNotice(page, /(?:新增|添加|创建|修改|编辑|更新|删除|保存|同意|拒绝|操作).*成功/)).toBeVisible({ timeout: 10_000 });
}

async function clickVisibleText(page: E2EPage, pattern: string | RegExp, label = String(pattern)): Promise<void> {
  const item = await firstVisibleMatching(page.getByText(pattern));
  if (!item) throw new Error(`未找到可点击的可见文本“${label}”，当前页面：${page.url()}`);
  await item.click();
}

async function selectFirstOptionByLabel(page: E2EPage, label: string): Promise<void> {
  const labelNode = page.getByText(new RegExp(`^\\s*${label}\\s*[：:]?\\s*$`)).first();
  let scope = labelNode;
  for (let level = 0; level < 5; level += 1) {
    const box = await firstVisibleMatching(scope.locator('.el-select:visible, .ant-select:visible, [role="combobox"]:visible, select:visible'));
    if (box) {
      await box.click();
      const option = await firstVisibleMatching(page.locator(
        '[role="option"]:visible, .ant-select-item-option:visible, .el-select-dropdown__item:visible, option:visible',
      ));
      if (!option) {
        throw new Error( `当前环境没有“${label}”可用选项/资源数据`);
        return;
      }
      await option.click();
      return;
    }
    scope = scope.locator('..');
  }
  throw new Error(`字段“${label}”未找到可见下拉框，当前页面：${page.url()}`);
}

async function openSystemLeaf(page: E2EPage, leaf: string): Promise<void> {
  const routes: Record<string, string> = {
    我的申请: '#/systemManage/approvalManage/myApply',
    我的审批: '#/systemManage/approvalManage/myExamine',
    用户权限: '#/systemManage/userPermission/dataPermission',
  };
  if (!page.url().includes('/systemManage/')) {
    // “系统管理”在窄顶栏被收进“···”；可见顶栏中找不到文字不等于没有权限。
    await clickMenu(page, '系统管理');
  }

  if (leaf === '部门管理') {
    // “部门管理”位于折叠的“用户权限”下，不是系统管理首页的直接叶子。
    // 先展开父菜单再点真实叶子，不能根据首次快照把折叠项误判为无权限。
    await page.keyboard.press('Escape').catch(() => undefined);
    await clickMenu(page, '用户权限', leaf);
    await expect(page.locator('body')).toBeVisible();
    return;
  }

  const route = routes[leaf];
  if (route) {
    const link = page.locator(`a[href="${route}"]:visible`).first();
    if (!(await link.count())) {
      throw new Error( `当前账号没有“${leaf}”菜单/角色权限`);
      return;
    }
    await link.click();
    await expect(page).toHaveURL(new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await expect(page.locator('body')).toBeVisible();
    return;
  }

  const menuItem = await firstVisibleMatching(page.getByText(leaf, { exact: true }));
  if (!menuItem) {
    throw new Error( `当前账号没有“${leaf}”菜单/角色权限`);
    return;
  }
  const before = page.url();
  await clickMenu(page, '系统管理', leaf);
  await expect.poll(() => page.url(), { timeout: 10_000 }).not.toBe(before);
  await expect(page.locator('body')).toBeVisible();
}

function visibleRows(page: E2EPage) {
  return page.locator('tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not([role="columnheader"])');
}
/* ==================== DS-PERM-62 部门管理专用辅助（spec 内私有，不改公共工具） ==================== */

/** 部门管理页弹窗（新增/编辑共用；兼容 Element/Ant 两种实现）。 */
function pageDialog(page: E2EPage): Locator {
  return page.locator('[role="dialog"]:visible, .ant-modal:visible, .el-dialog:visible').last();
}

/** 列表内名称包含 name 的行（本轮节点前缀互不为子串，避免 hasText 误匹配）。 */
function rowsWithName(page: E2EPage, name: string): Locator {
  return visibleRows(page).filter({ hasText: name });
}

function rowByName(page: E2EPage, name: string): Locator {
  return rowsWithName(page, name).first();
}

/** 填查询框并点“查询”（placeholder=请输入部门名称，2026-09-22 报告快照实证）。 */
async function searchDeptByName(page: E2EPage, name: string): Promise<void> {
  const search = page.getByPlaceholder('请输入部门名称').first();
  await expect(search).toBeVisible({ timeout: 10_000 });
  await search.fill(name);
  await page.getByRole('button', { name: /查\s*询/ }).first().click();
  await page.waitForTimeout(600);
}

/** 弹窗内“部门名称”输入框（与页面搜索框同名占位，必须限定弹窗范围）。 */
async function deptNameInputIn(dialog: Locator): Promise<Locator> {
  const item = await firstVisibleMatching(
    dialog.getByPlaceholder('请输入部门名称')
      .or(dialog.getByPlaceholder(/请输入.*(名称|部门)/)),
  );
  if (!item) {
    throw new Error('新增/编辑部门弹窗内未找到“部门名称”输入框；页面结构变更需人工校准（headed 首跑核对点）。');
  }
  return item;
}

/** 提交弹窗：硬证据=弹窗关闭（不依赖瞬时 toast 文案，与 SM-01-03 同口径）。 */
async function submitDialog(dialog: Locator): Promise<void> {
  const confirm = dialog.getByRole('button', { name: /^确\s*定$/ }).last();
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await confirm.click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

/** 尽力关闭弹窗（取消/Escape），失败不抛错——用于拦截场景的现场还原。 */
async function closeDialogBestEffort(page: E2EPage, dialog: Locator): Promise<void> {
  const cancel = dialog.getByRole('button', { name: /取\s*消/ }).last();
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.click().catch(() => undefined);
  } else {
    await page.keyboard.press('Escape').catch(() => undefined);
  }
  await expect(dialog).toBeHidden({ timeout: 5_000 }).catch(() => undefined);
}

/**
 * 新增节点（DS-PERM-62：父子参照节点必须为本轮自建）。
 * opts.underRowName 给定时走该行行内“新增”（父=该行节点）；否则走工具栏“新增”（根层）。
 */
async function createDept(page: E2EPage, name: string, opts: { underRowName?: string } = {}): Promise<void> {
  if (opts.underRowName) {
    const parentRow = rowByName(page, opts.underRowName);
    await expect(parentRow, `本轮参照节点“${opts.underRowName}”应在列表中`).toBeVisible({ timeout: 10_000 });
    const addBtn = parentRow.getByRole('button', { name: /新\s*增/ }).first();
    await expect(addBtn, '行内应有“新增”按钮').toBeVisible({ timeout: 10_000 });
    await addBtn.click();
  } else {
    // 工具栏“新增”（DOM 先于表格行内按钮，.first() 取工具栏入口）。
    const toolbarAdd = page.getByRole('button', { name: /^\s*新\s*增\s*$/ }).first();
    await expect(toolbarAdd, '工具栏应有“新增”按钮').toBeVisible({ timeout: 10_000 });
    await toolbarAdd.click();
  }
  const dialog = pageDialog(page);
  await expect(dialog, '点击新增后应弹出对话框').toBeVisible({ timeout: 10_000 });
  await (await deptNameInputIn(dialog)).fill(name);
  await submitDialog(dialog);
  await searchDeptByName(page, name);
  await expect(rowByName(page, name), `新增后应能查询到“${name}”`).toBeVisible({ timeout: 10_000 });
}

/** 编辑：把 oldName 节点改名为 newName（fill 先清空后输入）。 */
async function renameDept(page: E2EPage, oldName: string, newName: string): Promise<void> {
  const row = rowByName(page, oldName);
  await expect(row, `待编辑节点“${oldName}”应在列表中`).toBeVisible({ timeout: 10_000 });
  const editBtn = row.getByRole('button', { name: /编\s*辑|修\s*改/ }).first();
  await expect(editBtn, '行内应有“编辑”按钮').toBeVisible({ timeout: 10_000 });
  await editBtn.click();
  const dialog = pageDialog(page);
  await expect(dialog, '点击编辑后应弹出对话框').toBeVisible({ timeout: 10_000 });
  await (await deptNameInputIn(dialog)).fill(newName);
  await submitDialog(dialog);
}

/**
 * 删除本轮节点：查询→行内“删除”→确认→查询无回显。
 * opts.require=true（主链路）时必须真实删除；否则（finally 收尾）尽力而为并返回说明。
 */
async function deleteOwnDept(page: E2EPage, name: string, opts: { require?: boolean } = {}): Promise<string> {
  await searchDeptByName(page, name);
  const row = rowByName(page, name);
  if (!(await row.isVisible().catch(() => false))) {
    return '列表未查询到该节点（可能此前已删除）';
  }
  const delBtn = row.getByRole('button', { name: /删\s*除/ }).first();
  if (!(await delBtn.isVisible().catch(() => false))) {
    if (opts.require) throw new Error(`节点“${name}”行内未找到“删除”按钮`);
    return '行内未找到“删除”按钮，跳过（节点保留）';
  }
  await delBtn.click();
  const confirmDialog = page.locator('[role="dialog"]:visible, .el-message-box:visible, .ant-modal:visible, .el-dialog:visible').last();
  if (await confirmDialog.isVisible().catch(() => false)) {
    const confirm = confirmDialog.getByRole('button', { name: /确\s*定|^是$/ }).last();
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click().catch(() => undefined);
    }
  }
  // 主动再查询一次，不依赖删除后的自动刷新时机。
  await searchDeptByName(page, name);
  await expect(rowsWithName(page, name), `删除后“${name}”查询应无回显`).toHaveCount(0, { timeout: 10_000 });
  return '已删除且查询无回显';
}

test.describe("SM-01-01｜系统管理｜机构部门树与新增→查询→编辑→删除", () => {
  test.beforeEach(async ({ loginPage }) => {
      await openSystemLeaf(loginPage, '部门管理');
    })
  test("SM-01-01｜系统管理｜机构部门树与新增→查询→编辑→删除", async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;

    const suffix = uuid();
    // 本轮唯一节点（UUID 后缀隔离；前缀互不为子串，避免行过滤误匹配）。
    const orgName = `e2esm0101_org_${suffix}`;      // 根机构（父子参照节点，本轮自建）
    const deptName = `e2esm0101_dpt_${suffix}`;     // 子部门
    const deptRenamed = `e2esm0101_upd_${suffix}`;  // 编辑后的新名（与旧名无公共前缀）
    const ownNames = [orgName, deptName, deptRenamed];

    try {
      // 1 新增机构：环境无历史部门时列表为“暂无数据”，根机构经工具栏“新增”自建。
      await createDept(page, orgName);
      await report('SM-01-01 新增机构', true, `本轮机构=${orgName}（UUID 唯一 ASCII，工具栏新增）。`);

      // 2 查询机构：按名称过滤回显。
      await searchDeptByName(page, orgName);
      await expect(rowByName(page, orgName), '按名称查询应回显本轮机构').toBeVisible({ timeout: 10_000 });
      await report('SM-01-01 查询机构', true, '按名称查询回显本轮机构。');

      // 3 新增子部门：行内“新增”，父节点=本轮机构（父子参照均自建）。
      await createDept(page, deptName, { underRowName: orgName });
      await report('SM-01-01 新增子部门', true, `本轮子部门=${deptName}（父=${orgName}）。`);

      // 4 编辑子部门：改名后新名回显、旧名消失。
      await renameDept(page, deptName, deptRenamed);
      await searchDeptByName(page, deptRenamed);
      await expect(rowByName(page, deptRenamed), '编辑后应能按新名查询到').toBeVisible({ timeout: 10_000 });
      await searchDeptByName(page, deptName);
      await expect(rowsWithName(page, deptName), '编辑后旧名不应再回显').toHaveCount(0, { timeout: 10_000 });
      await report('SM-01-01 编辑部门', true, `${deptName} → ${deptRenamed}，新名回显且旧名消失。`);

      // 5 删除：先子后父；删除后查询无回显。
      await deleteOwnDept(page, deptRenamed, { require: true });
      await deleteOwnDept(page, orgName, { require: true });
      await report('SM-01-01 删除机构/部门', true, '子部门与根机构均已删除且查询无回显。');

      await assertNoConsoleErrors(consoleErrors);
    } finally {
      // 收尾（scoped cleanup）：仅回收本轮 UUID 命名节点；失败只记录，不掩盖主结果。
      for (const name of ownNames) {
        try {
          const outcome = await deleteOwnDept(page, name);
          if (outcome) await report('SM-01-01 收尾｜回收本轮节点', true, `${name}：${outcome}`);
        } catch (cleanupError) {
          console.warn(`[SM-01-01 收尾] 本轮节点“${name}”回收未完成：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
      }
    }
  });
});
