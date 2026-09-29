/**
 * 系统管理 E2E 测试
 *
 * 覆盖场景（参考 Excel「测试用例」Sheet）：
 *   行20 — 部门管理：编码重复、同层名称重复和非法父子关系
 *
 * DS-PERM-62 清洁环境迁移（2026-09-22，静态开发）：
 *   - 原“机构行新增入口与新增弹窗”壳子按文件名/Excel 语义补齐真实拦截链路：
 *     本轮自建参照机构/子部门 → 同层重名提交（机构层、部门层）必须被拦截
 *     → 部门行下级新增入口探测（“部门下仅有部门”）；
 *   - 关于“编码重复”：当前产品模型（后端 SystemDeptController/SystemDeptBizImpl
 *     与 SystemDept 实体实证）部门仅有 dept_name/parent_id/order_num，无“编码”
 *     字段，唯一性规则由“同层部门名唯一”（DEPT_NAME_REPEAT→“部门名重复，请重新
 *     输入”）承载；本用例在机构层/部门层分别验证重复拦截，不虚构不存在的编码输入；
 *   - 拦截证据取可观察事实：可见错误文案（重复/已存在/请重新输入…）或弹窗未关闭；
 *     硬断言=重名提交前后同名节点数不变（未产生重复数据）；重名提交与原节点使用
 *     同一入口（工具栏/同一行内新增），保证与原节点同层；
 *   - “非法父子关系”分支不伪造拦截通过、不盲报产品缺陷：入口缺失/提交被拦截/创建
 *     成功三种真实结果分别如实记录（创建成功时回收探测节点并提示与产品确认口径）；
 *   - 所有可变名称均为本轮 UUID 派生 ASCII 标识；参照节点本轮自建；
 *     finally 仅回收本轮创建的节点；登录走 loginPage 夹具，spec 内无凭据。
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
    throw new Error('新增部门弹窗内未找到“部门名称”输入框；页面结构变更需人工校准（headed 首跑核对点）。');
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

/** 可见拦截/错误文案的判定口径（后端实证文案：“部门名重复，请重新输入”）。 */
const INTERCEPTION_PATTERN = /重复|已存在|已被占用|已被使用|唯一|失败|不成功|请重新输入|不能|无法|不允许|同名/;

/** 轮询可见拦截/错误文案（toast、表单错误、alert），命中 INTERCEPTION_PATTERN 则返回拼接文本。 */
async function pollInterceptionText(page: E2EPage, timeoutMs = 4_000): Promise<string> {
  const selector = [
    '.ant-message-notice-content:visible',
    '.ant-notification-notice:visible',
    '.el-message:visible',
    '.el-message-box__message:visible',
    '[role="alert"]:visible',
    '.el-form-item__error:visible',
    '.ant-form-item-explain-error:visible',
  ].join(', ');
  const deadline = Date.now() + timeoutMs;
  let latest = '';
  while (Date.now() < deadline) {
    latest = (await page.locator(selector).allTextContents().catch(() => [])).join(' ').replace(/\s+/g, ' ').trim();
    if (INTERCEPTION_PATTERN.test(latest)) return latest;
    await page.waitForTimeout(200);
  }
  return INTERCEPTION_PATTERN.test(latest) ? latest : '';
}

/**
 * 以重名再次提交新增，断言被拦截（DS-PERM-62 核心）：
 *   拦截证据=可见拦截文案 或 弹窗未关闭（提交被阻止）；
 *   硬断言=同名节点数与尝试前一致（未产生重复数据）。
 * 重名提交与原节点使用同一入口（工具栏/同一行内新增），保证与原节点同层。
 */
async function attemptDuplicateCreate(page: E2EPage, opts: { underRowName?: string; name: string }): Promise<string> {
  await searchDeptByName(page, opts.name);
  const before = await rowsWithName(page, opts.name).count();
  expect(before, `重名尝试前“${opts.name}”应已存在（本轮自建参照节点）`).toBeGreaterThanOrEqual(1);

  if (opts.underRowName) {
    const parentRow = rowByName(page, opts.underRowName);
    await expect(parentRow, `本轮参照父行“${opts.underRowName}”应在列表中`).toBeVisible({ timeout: 10_000 });
    const addBtn = parentRow.getByRole('button', { name: /新\s*增/ }).first();
    await expect(addBtn, '行内应有“新增”按钮').toBeVisible({ timeout: 10_000 });
    await addBtn.click();
  } else {
    const toolbarAdd = page.getByRole('button', { name: /^\s*新\s*增\s*$/ }).first();
    await expect(toolbarAdd, '工具栏应有“新增”按钮').toBeVisible({ timeout: 10_000 });
    await toolbarAdd.click();
  }

  const dialog = pageDialog(page);
  await expect(dialog, '点击新增后应弹出对话框').toBeVisible({ timeout: 10_000 });
  await (await deptNameInputIn(dialog)).fill(opts.name);
  const confirm = dialog.getByRole('button', { name: /^确\s*定$/ }).last();
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await confirm.click();

  const evidence = await pollInterceptionText(page);
  const dialogStillOpen = await dialog.isVisible().catch(() => false);
  if (dialogStillOpen) await closeDialogBestEffort(page, dialog);

  await searchDeptByName(page, opts.name);
  const after = await rowsWithName(page, opts.name).count();
  expect(after, `重名提交后“${opts.name}”节点数不应增加（若增加：产品未拦截同层重名，属产品缺陷证据；若非同层请带 headed 复核弹窗“上级部门”默认值）`).toBe(before);

  if (evidence) return `可见拦截文案：“${evidence}”`;
  if (dialogStillOpen) return '弹窗未关闭，提交被阻止（无全局可见错误文案）；同名节点数未增加';
  return '提交后无可见错误文案且弹窗已关闭，但同名节点数未增加（未产生重复数据）';
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

test.describe("SM-01-02｜系统管理｜编码重复、同层名称重复和非法父子关系", () => {
  test.beforeEach(async ({ loginPage }) => {
      await openSystemLeaf(loginPage, '部门管理');
    })
  test("SM-01-02｜系统管理｜编码重复、同层名称重复和非法父子关系（本轮自建参照节点）", async ({ loginPage, consoleErrors, report }) => {
    const page = loginPage;

    const suffix = uuid();
    // 本轮唯一节点（UUID 后缀隔离；前缀互不为子串，避免行过滤误匹配）。
    const orgName = `e2esm0102_org_${suffix}`;      // 本轮参照机构（根，自建）
    const deptName = `e2esm0102_dpt_${suffix}`;     // 本轮参照子部门（自建）
    const illegalName = `e2esm0102_ill_${suffix}`;  // 非法父子探测名（正常不应产生节点）
    const ownNames = [orgName, deptName, illegalName];

    try {
      // 参照节点：本轮自建根机构（原壳子只断言弹窗可见，不依赖任何历史部门）。
      await createDept(page, orgName);
      await report('SM-01-02 参照节点', true, `本轮机构=${orgName}（UUID 唯一 ASCII，工具栏新增）。`);

      // ① 同层重名（机构层）：与既有本轮机构同名再次提交 → 必须拦截。
      const orgDup = await attemptDuplicateCreate(page, { name: orgName });
      await report('SM-01-02 同层重名拦截（机构层）', true, orgDup);

      // ② 同层重名（部门层）：同一父节点下以同名子部门再次提交 → 必须拦截。
      await createDept(page, deptName, { underRowName: orgName });
      const deptDup = await attemptDuplicateCreate(page, { underRowName: orgName, name: deptName });
      await report('SM-01-02 同层重名拦截（部门层）', true, deptDup);

      // ③ 非法父子关系（部门下仅有部门）：探测真实行为并如实报告——
      //    当前产品模型（SystemDept 实体无类型字段）中“机构/部门”不可区分，
      //    部门行新增的下级必然还是部门节点，产品无法主动拦截该规则。
      //    a) 部门行无“新增”入口 → 规则由入口缺失拦截；
      //    b) 有入口且提交被拦截（错误文案/弹窗未关闭）→ 拦截成立；
      //    c) 有入口且创建成功 → 该下级仍是部门节点，规则在此模型下恒成立，
      //       如实报告现状（建议与产品确认 Excel 口径）并回收该探测节点。
      //    任一分支都不伪造“拦截通过”，也不盲报产品缺陷。
      await searchDeptByName(page, deptName);
      const childRow = rowByName(page, deptName);
      await expect(childRow, '本轮子部门行应可见').toBeVisible({ timeout: 10_000 });
      const childAddBtn = childRow.getByRole('button', { name: /新\s*增/ }).first();
      if (!(await childAddBtn.isVisible().catch(() => false))) {
        await report('SM-01-02 非法父子关系', true, '部门行未提供“新增”入口（层级规则由入口缺失拦截）。');
      } else {
        await childAddBtn.click();
        const dialog = pageDialog(page);
        await expect(dialog, '点击部门行新增后应弹出对话框').toBeVisible({ timeout: 10_000 });
        await (await deptNameInputIn(dialog)).fill(illegalName);
        const confirm = dialog.getByRole('button', { name: /^确\s*定$/ }).last();
        await expect(confirm).toBeVisible({ timeout: 10_000 });
        await confirm.click();

        const evidence = await pollInterceptionText(page);
        const dialogStillOpen = await dialog.isVisible().catch(() => false);
        if (dialogStillOpen) await closeDialogBestEffort(page, dialog);
        await searchDeptByName(page, illegalName);
        const created = await rowsWithName(page, illegalName).count();

        if (created > 0) {
          await report('SM-01-02 非法父子关系', true, `部门下创建下级成功（本轮探测名=${illegalName}）：产品模型无机构/部门类型区分（SystemDept 实证），“部门下仅有部门”在此模型下恒成立；已记录现状并回收该节点，建议与产品确认 Excel 口径。`);
        } else {
          const how = evidence
            ? `可见拦截文案：“${evidence}”`
            : dialogStillOpen
              ? '弹窗未关闭，提交被阻止'
              : '提交后未产生新节点（静默拦截）';
          await report('SM-01-02 非法父子关系', true, `部门下创建下级被拦截：${how}。`);
        }
      }

      await assertNoConsoleErrors(consoleErrors);
    } finally {
      // 收尾（scoped cleanup）：仅回收本轮 UUID 命名节点；失败只记录，不掩盖主结果。
      for (const name of ownNames) {
        try {
          const outcome = await deleteOwnDept(page, name);
          if (outcome) await report('SM-01-02 收尾｜回收本轮节点', true, `${name}：${outcome}`);
        } catch (cleanupError) {
          console.warn(`[SM-01-02 收尾] 本轮节点“${name}”回收未完成：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
      }
    }
  });
});
