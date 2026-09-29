/**
 * 来源：录制草稿/新建用户名列表_异常值测试.spec.ts / SM-01-04
 * 系统管理 → 用户权限 → 用户管理：密码异常值与边界校验。
 * 本文件只验证异常值，不提交新增用户；正常新建与邀请流程见 SM-01-03。
 *
 * DS-PERM-62 清洁环境迁移（2026-09-22，静态开发）：
 *   - 手机号不再写死固定值“18654235000”，改为本轮 UUID 派生（与 SM-01-03 同
 *     口径），SM_USER_PHONE 兼容变量可显式覆盖；本用例只做字段校验、不提交；
 *   - 组织选择不再写死历史组织名（“测试管理员/简单用户组/简单用户/
 *     hive流程审批组织”），改用与 SM-01-03 相同的环境自适应选择：
 *     SM_PERMISSION_ORG_NAMES 兼容变量优先，未设置时取下拉首个可见可用选项。
 * 导航使用 权限测试工具.openUserManagement（溢出菜单点击 + hash 路由兜底），
 * 与 SM-00-01 一致；当前前端把“系统管理”折叠进顶栏“···”，通用 clickMenu
 * 会报“菜单项‘系统管理’未找到或均不可见”（1f009f3c 失败实证）。
 */
import { test, expect, assertNoConsoleErrors, uuid } from '../utils.js';
import { clickVisible, visibleDialog } from '../抽样用例工具.js';
import { openUserManagement } from './权限测试工具.js';

test.describe.configure({ timeout: 120_000 });

/**
 * DS-PERM-62 清洁环境迁移：从组织下拉中选择本轮可用组织（与 SM-01-03 同口径）。
 * 优先级：SM_PERMISSION_ORG_NAMES 兼容变量（逗号/分号分隔，依序尝试）→ 下拉首个
 * 可见可用选项。公共工具不在本任务允许编辑范围内，故保留 spec 内实现。
 */
async function chooseOrganizationForNewUser(page: import('@playwright/test').Page): Promise<string> {
  const organizationOptions = page.getByRole('listitem');
  const configured = (process.env.SM_PERMISSION_ORG_NAMES ?? '')
    .split(/[,，;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const name of configured) {
    const option = organizationOptions.filter({ hasText: new RegExp(`^${name}$`) }).last();
    if (await option.isVisible().catch(() => false)) {
      await option.click();
      return `兼容变量命中：${name}`;
    }
  }
  const count = await organizationOptions.count();
  for (let index = 0; index < count; index += 1) {
    const option = organizationOptions.nth(index);
    const optionText = (await option.textContent().catch(() => ''))?.replace(/\s+/g, ' ').trim() ?? '';
    if (!optionText || !(await option.isVisible().catch(() => false))) continue;
    await option.click();
    return `首个可用选项：${optionText}`;
  }
  throw new Error('新建用户的组织下拉未返回可用组织；请确认管理员所属组织已初始化。');
}

async function fillCommonUserFields(page: import('@playwright/test').Page): Promise<import('@playwright/test').Locator> {
  await clickVisible(page, '新增用户');
  const dialog = await visibleDialog(page);
  const suffix = uuid();
  await dialog.getByPlaceholder('请输入用户名称').fill(`e2e_pwd_${suffix}`);
  await page.getByRole('textbox', { name: '请输入用户昵称' }).last().fill(`e2e_pwd_nick_${suffix}`);
  // DS-PERM-62：固定手机号多轮执行会撞历史数据/唯一性约束，改为本轮 UUID 派生
  // （与 SM-01-03 同口径）；SM_USER_PHONE 可显式覆盖。仅校验、不提交创建。
  const phoneDigits = String(parseInt(suffix, 16) % 100000).padStart(5, '0');
  await dialog.getByPlaceholder('请输入手机号码').fill(process.env.SM_USER_PHONE ?? `186542${phoneDigits}`);
  await page.getByRole('textbox', { name: '请输入邮箱' }).last().fill(`e2e_pwd_${suffix}@example.com`);

  await page.getByRole('textbox', { name: '请选择性别' }).last().click();
  await page.getByRole('listitem').filter({ hasText: /^男$/ }).last().click();
  await page.getByRole('textbox', { name: '请选择组织' }).last().click();
  // DS-PERM-62：不再写死历史组织名，改用与 SM-01-03 相同的环境自适应选择
  // （SM_PERMISSION_ORG_NAMES 兼容变量优先，未设置时取下拉首个可见可用选项）。
  await chooseOrganizationForNewUser(page);
  // 组织选择器有独立的确定/取消区，先收回下拉浮层，避免遮挡主表单。
  const organizationPickerFooter = page.locator('div').filter({ hasText: /^确\s*定\s*取\s*消$/ }).last();
  if (await organizationPickerFooter.isVisible().catch(() => false)) {
    await organizationPickerFooter.click();
  }
  await page.mouse.move(20, 20);
  await page.waitForTimeout(300);
  return dialog;
}

async function visiblePasswordError(page: import('@playwright/test').Page): Promise<string> {
  const errors = page.locator(
    '.el-form-item__error:visible, .ant-form-item-explain-error:visible, [role="alert"]:visible',
  );
  const texts = await errors.allTextContents().catch(() => []);
  return texts.join(' ').replace(/\s+/g, ' ').trim();
}

// 只匹配规则性密码错误，避免把“请输入新密码”这类普通字段提示算作校验通过。
const PASSWORD_VALIDATION = /不能为空|长度(?:必须|应|需|不)|(?:密码|字符).*(?:格式|非法|不合法|必须)|格式(?:不正确|错误)|至少\s*\d+\s*(?:位|个|字符)/;

async function waitForPasswordValidation(
  page: import('@playwright/test').Page,
  timeout = 4_000,
): Promise<string> {
  const deadline = Date.now() + timeout;
  let latest = '';
  while (Date.now() < deadline) {
    latest = await visiblePasswordError(page);
    if (PASSWORD_VALIDATION.test(latest)) return latest;
    await page.waitForTimeout(200);
  }
  return latest;
}

test('SM-01-04｜空密码、短密码和简单密码校验', async ({ loginPage, consoleErrors, report }) => {
  const page = loginPage;
  const passwordCases = [
    { name: '空密码', value: '' },
    { name: '少于8位', value: 'Aa1234@' },
    { name: '仅数字', value: '12345678' },
    { name: '仅字母', value: 'abcdefgh' },
    { name: '仅特殊字符', value: '!!!!!!!!' },
    { name: '常见简单密码', value: 'bigdata2025' },
    { name: '非法字符', value: '中文密码123' },
  ];
  const missingValidation: string[] = [];

  await openUserManagement(page);
  const dialog = await fillCommonUserFields(page);
  const passwordInput = page.getByRole('textbox', { name: '请输入用户密码' }).last();

  // 同一个新增用户弹窗内依次替换密码，只观察字段校验，不提交主表单。
  for (const passwordCase of passwordCases) {
    await passwordInput.fill(passwordCase.value);
    await passwordInput.blur();
    const errorText = await waitForPasswordValidation(page);
    if (!PASSWORD_VALIDATION.test(errorText)) {
      missingValidation.push(`${passwordCase.name}=${passwordCase.value || '<空>'}`);
    }
  }

  if (await dialog.isVisible().catch(() => false)) {
    const cancel = page.getByRole('button', { name: /^取\s*消$/ }).last();
    if (await cancel.isVisible().catch(() => false)) await cancel.click();
    else await page.keyboard.press('Escape').catch(() => undefined);
  }

  await assertNoConsoleErrors(consoleErrors);
  if (missingValidation.length) {
    throw new Error(`以下异常密码未显示明确密码校验提示：${missingValidation.join('、')}`);
  }
  await report('SM-01-04 异常密码校验', true, `同一新增用户弹窗内已验证 ${passwordCases.length} 组异常密码，未提交创建。`);
});

