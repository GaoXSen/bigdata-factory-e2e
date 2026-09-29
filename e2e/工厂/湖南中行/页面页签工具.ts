import type { Locator, Page } from '@playwright/test';

export type TabTarget = string | RegExp;

/**
 * 统一处理页面内页签：当前可见页签优先；找不到时展开“更多/…”后再查。
 * 适配 Ant Design、Element Plus 和无障碍 role=tab，避免命中响应式布局产生的隐藏副本。
 */
export class TabNavigator {
  private readonly page: Page;
  private readonly timeout: number;

  constructor(page: Page, timeout = 10_000) {
    this.page = page;
    this.timeout = timeout;
  }

  async click(target: TabTarget): Promise<void> {
    let expanded = false;
    const deadline = Date.now() + this.timeout;

    while (Date.now() < deadline) {
      const tab = await this.firstVisible(this.tabLocators(target));
      if (tab) {
        await tab.click({ timeout: Math.max(1_000, deadline - Date.now()) });
        await this.page.waitForTimeout(300);
        return;
      }

      if (!expanded) {
        const overflow = await this.firstVisible(this.overflowLocators());
        if (overflow) {
          await overflow.click({ timeout: Math.max(1_000, deadline - Date.now()) });
          await this.page.waitForTimeout(300);
          expanded = true;
          continue;
        }
      }

      await this.page.waitForTimeout(200);
    }

    throw new Error(`页签“${String(target)}”未找到或不可见，当前页面：${this.page.url()}`);
  }

  private tabLocators(target: TabTarget): Locator[] {
    const roleTab = typeof target === 'string'
      ? this.page.getByRole('tab', { name: target, exact: true })
      : this.page.getByRole('tab', { name: target });

    return [
      roleTab,
      this.page
        .locator('.ant-tabs-tab:visible, .el-tabs__item:visible, [role="tab"]:visible')
        .filter({ hasText: target }),
      // 某些版本的工厂页签没有 role=tab，也没有标准 Ant/Element class，
      // 但仍位于可见 tablist/nav 容器内。仅在标准候选未命中时使用此兜底，
      // 避免把正文中同名文本误当成页签。
      this.page
        .locator(
          '[role="tablist"]:visible button:visible, [role="tablist"]:visible a:visible, ' +
          '[role="tablist"]:visible li:visible, .ant-tabs-nav:visible button:visible, ' +
          '.ant-tabs-nav:visible a:visible, .ant-tabs-nav:visible li:visible, ' +
          '.el-tabs__nav:visible button:visible, .el-tabs__nav:visible a:visible, ' +
          '.el-tabs__nav:visible li:visible',
        )
        .filter({ hasText: target }),
      // “更多”展开后的菜单项通常不是 role=tab，但仍是当前页面的可操作页签入口。
      this.page
        .locator(
          [
            '.ant-tabs-dropdown-menu:visible .ant-tabs-dropdown-menu-item',
            '.ant-dropdown-menu:visible .ant-dropdown-menu-item',
            '.el-dropdown-menu:visible .el-dropdown-menu__item',
            '[role="menu"]:visible [role="menuitem"]',
          ].join(', '),
        )
        .filter({ hasText: target }),
    ];
  }

  private overflowLocators(): Locator[] {
    return [
      this.page.getByRole('button', { name: /^(?:更多|···|…|\.\.\.)$/ }),
      this.page.getByRole('menuitem', { name: /^(?:更多|···|…|\.\.\.)$/ }),
      this.page.locator(
        [
          '.ant-tabs-nav-more:visible',
          '.ant-tabs-nav-operations:visible .ant-tabs-nav-more:visible',
          '.ant-tabs-nav-operations:visible button:visible',
          '.el-tabs__nav-next:visible',
          '.el-tabs__nav-more:visible',
          '[class*="tab"][class*="overflow"]:visible',
          '[class*="tab"][class*="dropdown"]:visible',
          '[aria-label*="更多"]:visible',
          '[title*="更多"]:visible',
        ].join(', '),
      ),
      this.page.getByText(/^(?:更多|···|…|\.\.\.)$/, { exact: true }),
    ];
  }

  private async firstVisible(locators: Locator[]): Promise<Locator | undefined> {
    for (const locator of locators) {
      const count = await locator.count();
      for (let index = count - 1; index >= 0; index--) {
        const item = locator.nth(index);
        if (await item.isVisible().catch(() => false)) return item;
      }
    }
    return undefined;
  }
}

export async function clickTab(page: Page, target: TabTarget, timeout = 10_000): Promise<void> {
  await new TabNavigator(page, timeout).click(target);
}
