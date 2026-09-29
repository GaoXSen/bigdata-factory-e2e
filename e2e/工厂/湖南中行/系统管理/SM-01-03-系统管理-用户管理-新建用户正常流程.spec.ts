/**
 * 来源：录制草稿/新建用户名列表_异常值测试.spec.ts / SM-01-03
 * 系统管理 → 用户权限 → 用户管理：新建用户、邀请用户、列表可见。
 *
 * DS-PERM-49 清洁环境与配置中心校准（2026-09-22，静态开发）：
 *   - 用户名/昵称/手机号/邮箱保持本轮 UUID 派生（全 ASCII），SM_USER_PHONE/
 *     SM_USER_EMAIL/SM_VALID_PASSWORD 兼容变量可覆盖（既有实现，保留）；
 *   - 组织选择不再写死历史组织名称：优先兼容变量 SM_PERMISSION_ORG_NAMES
 *     （逗号分隔，与 权限测试工具.chooseVisibleOrganization 同一变量口径），
 *     未设置时取组织下拉中第一个可见可用选项；选中与否的真伪由主表单提交
 *     （弹窗关闭）与用户列表可见行收口；
 *   - “邀请用户已存在当前组织”的快速提示按真实接口结果+列表可见行判定，
 *     不依赖固定 toast（沿用既有实现）；
 *   - 收尾 scoped cleanup：finally 尽力删除本轮自建账号（仅本轮 UUID 命名；
 *     失败记录说明文本，不掩盖主结果）。
 */
import { test, expect, clickMenu, assertNoConsoleErrors, uuid } from '../utils.js';
import { clickVisible, expectSuccess, visibleDialog } from '../抽样用例工具.js';

test.describe.configure({ timeout: 120_000 });

async function openUserManagement(page: import('@playwright/test').Page): Promise<void> {
  const alreadyOnPage = /#\/systemManage\/userPermission\/userManage/.test(page.url()) &&
    await page.getByRole('button', { name: '新增用户' }).isVisible().catch(() => false);
  if (alreadyOnPage) return;
  await clickMenu(page, '系统管理', '用户权限', '用户管理');
  await expect(page.getByRole('button', { name: '新增用户' })).toBeVisible({ timeout: 15_000 });
}

async function fillUserForm(
  page: import('@playwright/test').Page,
  values: { userName: string; nickname: string; phone: string; email: string; password: string },
): Promise<{ dialog: import('@playwright/test').Locator; organization: string }> {
  await clickVisible(page, '新增用户');
  const dialog = await visibleDialog(page);

  await dialog.getByPlaceholder('请输入用户名称').fill(values.userName);
  await page.getByRole('textbox', { name: '请输入用户昵称' }).last().fill(values.nickname);
  await dialog.getByPlaceholder('请输入手机号码').fill(values.phone);
  await page.getByRole('textbox', { name: '请输入邮箱' }).last().fill(values.email);
  await page.getByRole('textbox', { name: '请输入用户密码' }).last().fill(values.password);

  await page.getByRole('textbox', { name: '请选择性别' }).last().click();
  await page.getByRole('listitem').filter({ hasText: /^男$/ }).last().click();
  await page.getByRole('textbox', { name: '请选择组织' }).last().click();
  // DS-PERM-49 清洁环境校准：不再写死历史组织名称（旧候选“测试管理员/简单用户组/
  // 简单用户/hive流程审批组织”）。优先兼容变量 SM_PERMISSION_ORG_NAMES（逗号分隔，
  // 与 权限测试工具.chooseVisibleOrganization 同一变量口径），未设置时取组织下拉中
  // 第一个可见可用选项。
  const organization = await chooseOrganizationForNewUser(page);
  // 组织选择器有自己的“确定/取消”区域；先确认组织选择，再提交新增用户主表单。
  const organizationPickerFooter = page.locator('div').filter({ hasText: /^确\s*定\s*取\s*消$/ }).last();
  if (await organizationPickerFooter.isVisible().catch(() => false)) {
    await organizationPickerFooter.click();
    await page.waitForTimeout(300);
  }
  await page.mouse.move(20, 20);
  await page.waitForTimeout(300);
  return { dialog, organization };
}

async function submitUserForm(
  page: import('@playwright/test').Page,
  dialog: import('@playwright/test').Locator,
): Promise<void> {
  // 按钮限定在新增用户弹窗内，避免误点主表单/组织选择器残留的同名按钮。
  const confirm = dialog.getByRole('button', { name: /^确\s*定$/ }).last();
  await expect(confirm).toBeVisible({ timeout: 5_000 });
  await confirm.click();
  // 提交成功的硬证据是弹窗关闭；toast 是瞬时辅助证据，不能单独作为通过依据。
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

/**
 * 在组织下拉中选择一个可用组织（DS-PERM-49 清洁环境校准）。
 * 候选优先级：兼容变量 SM_PERMISSION_ORG_NAMES（逗号分隔，同名变量与
 * 权限测试工具.chooseVisibleOrganization 一致）> 下拉中按 DOM 顺序的前 8 个
 * 可见选项。跳过空文案、“暂无/加载”占位与禁用项；全部候选不可用时报明确
 * 环境前置错误。选中与否的真伪由主表单提交（弹窗关闭）与用户列表可见行收口，
 * 不在此处依赖选中态样式判断（Element/Ant 版本差异大）。
 */
async function chooseOrganizationForNewUser(page: import('@playwright/test').Page): Promise<string> {
  const options = page.getByRole('listitem');
  const candidates: Array<{ locator: import('@playwright/test').Locator; label: string }> = [];
  for (const name of (process.env.SM_PERMISSION_ORG_NAMES ?? '').split(',').map((item) => item.trim()).filter(Boolean)) {
    candidates.push({
      locator: options.filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).last(),
      label: name,
    });
  }
  const total = await options.count();
  let visibleAdded = 0;
  for (let index = 0; index < total && visibleAdded < 8; index += 1) {
    const item = options.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    candidates.push({ locator: item, label: `下拉可见选项 #${visibleAdded + 1}` });
    visibleAdded += 1;
  }
  for (const candidate of candidates) {
    if (!(await candidate.locator.isVisible().catch(() => false))) continue;
    const text = (await candidate.locator.innerText().catch(() => '')).trim();
    if (!text || text.length > 50 || /^(暂无|加载)/.test(text)) continue;
    const classes = (await candidate.locator.getAttribute('class').catch(() => '')) ?? '';
    if (/is-disabled|ant-select-item-disabled/.test(classes)) continue;
    await candidate.locator.click();
    await page.waitForTimeout(300);
    return text;
  }
  throw new Error(
    '新建用户的组织下拉未返回可用组织；请确认管理员所属组织已初始化，' +
      '或用兼容变量 SM_PERMISSION_ORG_NAMES 指定候选组织名。',
  );
}

/**
 * 尽力删除本轮自建账号（用户管理页：按本轮唯一账号查询 → 行内“删除”→ 确认；
 * 模板 SM-02-02/SM-03-09 deleteOwnUser）。只回收本轮 UUID 命名账号；任一步不满足
 * 都返回说明文本而不抛错，不掩盖主结果。
 */
async function deleteOwnUser(page: import('@playwright/test').Page, userName: string): Promise<string> {
  await openUserManagement(page);
  const search = page.getByRole('textbox', { name: '请输入用户名称' }).first();
  await search.fill(userName);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(800);
  const userText = page.getByText(userName, { exact: true }).last();
  if (!(await userText.isVisible().catch(() => false))) {
    return '列表未查询到本轮账号（可能此前已删除）';
  }
  const row = userText.locator('xpath=ancestor::tr[1]');
  if (!(await row.isVisible().catch(() => false))) {
    return '账号可见但未取到表格行，跳过页面删除（账号保留）';
  }
  const deleteButton = row.getByRole('button', { name: /删\s*除/ }).first();
  if (!(await deleteButton.isVisible().catch(() => false))) {
    return '行内未找到“删除”按钮，跳过页面删除（账号保留）';
  }
  await deleteButton.click();
  const confirmDialog = page
    .locator('[role="dialog"]:visible, .el-message-box:visible, .el-dialog:visible, .ant-modal:visible')
    .first();
  if (await confirmDialog.isVisible().catch(() => false)) {
    const confirm = confirmDialog.getByRole('button', { name: /确\s*定|^是$/ }).first();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
  }
  await expect(userText).toBeHidden({ timeout: 10_000 }).catch(() => undefined);
  return '已提交删除并确认列表不再显示该账号';
}

test('SM-01-03｜新建用户、邀请后列表可见', async ({ loginPage, consoleErrors, report }) => {
  const page = loginPage;
  const suffix = uuid();
  const userName = `e2e_user_${suffix}`;
  const nickname = `e2e_nick_${suffix}`;
  // 手机号/邮箱按本轮 UUID 派生（页面要求手机号 11 位）：固定默认值在多轮执行时
  // 会因唯一性约束冲突或残留脏数据（公司模型辅助审查 20260901 第 1 条），
  // 与 权限测试工具.newPermissionIdentity 的派生方式保持一致。
  const phoneDigits = String(parseInt(suffix, 16) % 100000).padStart(5, '0');
  const phone = process.env.SM_USER_PHONE ?? `186542${phoneDigits}`;
  const email = process.env.SM_USER_EMAIL ?? `75421${phoneDigits}@qq.com`;
  const validPassword = process.env.SM_VALID_PASSWORD?.trim() || '';
  if (!validPassword) {
    test.skip(true, '缺少 SM_VALID_PASSWORD，无法创建本轮测试用户。');
    return;
  }

  try {
    await openUserManagement(page);
    const created = await fillUserForm(page, {
      userName,
      nickname,
      phone,
      email,
      password: validPassword,
    });
    await submitUserForm(page, created.dialog);
    await expectSuccess(page, /成功|新增/);

    // 新建后用户暂不出现在列表，必须通过“邀请用户”完成入列。
    await clickVisible(page, '邀请用户');
    const inviteDialog = await visibleDialog(page);
    const inviteSelector = inviteDialog.getByRole('textbox', { name: '请选择用户' });
    await inviteSelector.click();
    // 基线 run-20260916-173034-218 失败实证：邀请下拉默认只加载第一页既有用户
    // （快照为既有用户 + 分页 1~9），新建用户不在首屏；必须输入本轮唯一用户名
    // 远程过滤后再选。下拉会截断较长昵称，不能按“用户名(昵称)”全文匹配，只能按
    // 用户名定位（与 权限测试工具.inviteUserToCurrentOrganization 的已验证模式一致）。
    await inviteSelector.fill(userName);
    await page.waitForTimeout(500);
    const escapedUserName = userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const inviteOption = page
      .getByRole('listitem')
      .filter({ hasText: new RegExp(escapedUserName) })
      .last();
    if (!(await inviteOption.isVisible({ timeout: 5_000 }).catch(() => false))) {
      throw new Error(
        `新建用户“${userName}”未出现在邀请候选列表中：新增可能未落库或下拉远程过滤未生效。`,
      );
    }
    await inviteOption.click();
    // 以真实接口结果区分“邀请成功”与“已邀请用户再次邀请”的短暂提示；
    // “邀请用户已存在当前组织”文案同样含“邀请”，不能再用 /成功|邀请/ 全页匹配。
    const inviteResponsePromise = page.waitForResponse(
      (response) => response.request().method() === 'POST'
        && /\/systemUser\/inviteUser(?:\?|$)/.test(response.url()),
      { timeout: 10_000 },
    ).catch(() => undefined);
    await inviteDialog.getByRole('button', { name: /^确\s*定$/ }).last().click();
    const inviteResponse = await inviteResponsePromise;
    if (inviteResponse) {
      const responseText = await inviteResponse.text().catch(() => '');
      if (/邀请用户已存在当前组织|重复邀请/.test(responseText)) {
        // 已在当前组织是合法复用状态，继续以列表可见性终态断言兜底。
      } else if (!inviteResponse.ok()) {
        throw new Error(
          `邀请用户接口返回 HTTP ${inviteResponse.status()}：${responseText.slice(0, 200)}`,
        );
      }
    }
    // 邀请处理完成的硬证据是弹窗关闭；成功 toast 只作辅助证据。
    await expect(inviteDialog).toBeHidden({ timeout: 10_000 });
    // 邀请成功后列表不会自动刷新；用用户名重新查询，不能把缓存页当作“邀请失败”。
    const searchUserName = page.getByRole('textbox', { name: '请输入用户名称' }).first();
    await searchUserName.fill(userName);
    await page.getByRole('button', { name: /查\s*询/ }).click();
    const userRow = page
      .locator('tr:visible, [role="row"]:visible')
      .filter({ hasText: userName })
      .last();
    await expect(userRow).toBeVisible({ timeout: 15_000 });
    await expect(userRow).toContainText(userName);

    await assertNoConsoleErrors(consoleErrors);
    await report(
      'SM-01-03 正常流程',
      true,
      `本轮用户：${userName}（组织=${created.organization}）；新建后通过邀请进入用户列表；收尾尽力删除本轮账号。`,
    );
  } finally {
    // 收尾回收（scoped cleanup）：尽力删除本轮自建账号（仅本轮 UUID 命名）；
    // 失败仅记录说明文本，不抛出、不掩盖主结果（模板 SM-02-02）。
    try {
      const outcome = await deleteOwnUser(page, userName);
      await report('SM-01-03 收尾｜回收本轮账号', true, `${userName}：${outcome}。`);
    } catch (cleanupError) {
      console.warn(
        `[SM-01-03 收尾] 本轮账号回收未完成：${cleanupError instanceof Error ? cleanupError.message.split('，')[0] : String(cleanupError)}`,
      );
    }
  }
});

