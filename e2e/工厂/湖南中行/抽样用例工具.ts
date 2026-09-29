import { expect, Locator, Page } from '@playwright/test';

export async function visible(locator: Locator): Promise<Locator | undefined> {
  for (let index = await locator.count() - 1; index >= 0; index -= 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

type ClickVisibleOptions = {
  /** 仅在页面异步切换时按需等待，默认保持立即失败，避免全局放大错误等待。 */
  timeoutMs?: number;
};

const CARD_ICON_ACTIONS = {
  编辑: '[aria-label="图标: edit"], [aria-label*="edit" i], [aria-label*="编辑"], .anticon-edit, [class*="icon-edit"]',
  删除: '[aria-label="图标: delete"], [aria-label*="delete" i], [aria-label*="删除"], .anticon-delete, [class*="icon-delete"]',
  复制: '[aria-label="图标: copy"], [aria-label*="copy" i], .anticon-copy',
} as const;

export async function clickVisible(
  scope: Page | Locator,
  name: string | RegExp,
  { timeoutMs = 0 }: ClickVisibleOptions = {},
): Promise<void> {
  const candidates = [
    scope.getByRole('button', { name }),
    scope.getByRole('link', { name }),
    scope.getByRole('menuitem', { name }),
    // 部分图标按钮的 accessible name 会把“保 存”等文字拆成带空格的
    // generic 节点，getByRole 可能匹配不到；此处仍限定当前 scope 和可见按钮。
    scope.locator('button:visible, [role="button"]:visible').filter({ hasText: name }),
    scope.getByText(name, { exact: typeof name === 'string' }),
  ];
  const page = 'url' in scope ? scope : scope.page();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const candidate of candidates) {
      const item = await visible(candidate);
      if (item) {
        await item.click();
        return;
      }
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`未找到可见操作：${String(name)}，当前页面：${page.url()}`);
}

export async function expectSuccess(page: Page, pattern: RegExp): Promise<void> {
  const notice = page.locator(
    '.ant-message-notice-content:visible, .ant-notification-notice:visible, .el-message:visible, [role="alert"]:visible',
  ).filter({ hasText: pattern }).last();
  await expect(notice).toBeVisible({ timeout: 15_000 });
}

export async function visibleDialog(page: Page): Promise<Locator> {
  const dialog = page.getByRole('dialog').last();
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  return dialog;
}

export async function fillPlaceholder(page: Page, placeholder: string, value: string): Promise<void> {
  const field = page.getByPlaceholder(placeholder, { exact: true }).last();
  await expect(field).toBeVisible({ timeout: 10_000 });
  await field.fill(value);
}

export async function chooseFirstOption(page: Page, box: Locator, label: string): Promise<string> {
  await expect(box).toBeVisible({ timeout: 10_000 });
  await box.click();
  const options = page.locator(
    '.ant-select-dropdown:visible .ant-select-item-option, ' +
      '.ant-select-dropdown:visible .ant-select-dropdown-menu-item, ' +
      '.el-select-dropdown:visible .el-select-dropdown__item, ' +
      '[role="listbox"]:visible [role="option"]',
  );
  for (let index = await options.count() - 1; index >= 0; index -= 1) {
    const option = options.nth(index);
      const text = (await option.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (await option.isVisible().catch(() => false) && text && !/请选择|暂无|无数据/.test(text)) {
      await option.click();
      // Element/Ant 下拉层有时在选中后仍停留在页面上，继续操作会被遮挡层拦截。
      // 先等待选中状态落地，再收起浮层并把鼠标移出控件区域。
      await page.waitForTimeout(150);
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.mouse.move(0, 0).catch(() => undefined);
      return text;
    }
  }
  throw new Error(`下拉“${label}”没有可选项，当前页面：${page.url()}`);
}

export async function chooseFirstDialogOption(page: Page, dialog: Locator, index: number, label: string): Promise<string> {
  return chooseFirstOption(page, dialog.getByRole('combobox').nth(index), label);
}

export async function findTextContainer(page: Page, text: string, requiredText: RegExp): Promise<Locator> {
  const target = page.getByText(text, { exact: true }).filter({ visible: true }).last();
  await expect(target).toBeVisible({ timeout: 15_000 });
  let scope = target;
  for (let level = 0; level < 8; level += 1) {
    if (await scope.getByText(requiredText).filter({ visible: true }).count()) return scope;
    scope = scope.locator('..');
  }
  return target.locator('..');
}

/**
 * 数据源卡片的编辑、删除、复制是纯图标按钮，不能按中文按钮文本在整页查找。
 * 仅接受“该祖先范围内恰好一个目标图标”的最小容器，防止上溯到整个列表后误点其他卡片。
 */
export async function findActionCard(
  page: Page,
  text: string,
  action: keyof typeof CARD_ICON_ACTIONS,
): Promise<Locator> {
  const target = page.getByText(text, { exact: true }).filter({ visible: true }).last();
  await expect(target).toBeVisible({ timeout: 15_000 });

  let scope = target;
  for (let level = 0; level < 8; level += 1) {
    const actions = scope.locator(CARD_ICON_ACTIONS[action]);
    if ((await actions.count()) === 1 && (await actions.first().isVisible().catch(() => false))) {
      return scope;
    }
    scope = scope.locator('..');
  }
  throw new Error(`未找到包含唯一“${action}”图标的“${text}”卡片，当前页面：${page.url()}`);
}

export async function clickCardAction(
  page: Page,
  text: string,
  action: keyof typeof CARD_ICON_ACTIONS,
): Promise<void> {
  const card = await findActionCard(page, text, action);
  await card.locator(CARD_ICON_ACTIONS[action]).click();
}

/** 删除数据源的危险二次确认：输入 DELETE 后点击“确认”。 */
export async function confirmDangerDialog(page: Page, keyword = 'DELETE'): Promise<void> {
  const dialog = await visibleDialog(page);
  const input = dialog.getByPlaceholder(/请输入/).last();
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(keyword);
  await clickVisible(dialog, /确\s*认|确\s*定/, { timeoutMs: 5_000 });
}

export async function clickFormControlByLabel(page: Page, label: RegExp): Promise<Locator> {
  const direct = page.getByLabel(label).last();
  if (await direct.isVisible().catch(() => false)) return direct;
  const text = page.getByText(label).filter({ visible: true }).last();
  let scope = text;
  for (let level = 0; level < 8; level += 1) {
    const control = await visible(scope.locator('input:not([type="hidden"]), textarea, .el-select, .ant-select, [role="combobox"]'));
    if (control) return control;
    scope = scope.locator('..');
  }
  throw new Error(`未找到表单控件：${String(label)}，当前页面：${page.url()}`);
}

export async function fillFormField(page: Page, label: RegExp, value: string): Promise<void> {
  const control = await clickFormControlByLabel(page, label);
  const tag = await control.evaluate((element) => element.tagName.toLowerCase()).catch(() => '');
  if (tag === 'input' || tag === 'textarea') {
    await control.fill(value);
    return;
  }
  throw new Error(`表单字段“${String(label)}”不是可填写控件，当前页面：${page.url()}`);
}
