import type { Locator, Page } from '@playwright/test';

/**
 * 数据工厂菜单导航工具。
 *
 * 页面顶部通常只显示 7 个菜单，其余菜单收在“...”溢出菜单中；
 * 左侧菜单还可能存在父级菜单和隐藏的重复 DOM。本工具统一处理：
 * 1. 优先选择可见的 link/menuitem/侧边菜单文本；
 * 2. 目标不可见时自动展开顶部“...”菜单后重试；
 * 3. 每一步点击后等待 SPA 路由和菜单动画完成。
 */
export class MenuNavigator {
  private readonly page: Page;
  private readonly stepTimeout: number;

  constructor(page: Page, stepTimeout = 10_000) {
    this.page = page;
    this.stepTimeout = stepTimeout;
  }

  async clickPath(...segments: string[]): Promise<void> {
    // ftp 文件接入的“接入列表”不是父路由的直接内容：必须先进入
    // ftp文件接入，再点击页面实际展开出的“接入列表”叶子项。直接 goto
    // accessList 在部分版本会回退到“文件接入”列表，导致误选了另一类任务。
    if (segments.join('>') === '数据接入>ftp文件接入>接入列表') {
      const base = this.page.url().split('#')[0];
      // 直接打开 ftpAccess 父 hash 在当前前端会留下空白主体且不渲染子菜单。
      // 必须先回到已稳定的数据源页，再触发真实侧栏 a 链接，才能让 Vue 完整
      // 挂载“接入列表”叶子项。
      await this.page.goto(`${base}#/dataAccess/dataSource`, {
        waitUntil: 'domcontentloaded',
        timeout: this.stepTimeout,
      });
      await this.page.waitForTimeout(600);
      const ftpLink = this.page.locator('a[href="#/dataAccess/ftpAccess"]');
      await ftpLink.click({ timeout: this.stepTimeout });

      let leaf: Locator | undefined;
      for (let attempt = 0; attempt < 20 && !leaf; attempt += 1) {
        leaf = await this.firstVisible([
          this.page.getByRole('link', { name: '接入列表', exact: true }),
          this.page.getByText('接入列表', { exact: true }),
        ]);
        if (!leaf) await this.page.waitForTimeout(300);
      }
      if (!leaf) throw new Error(`通过侧栏链接打开 ftp文件接入后仍未渲染“接入列表”，当前页面：${this.page.url()}`);
      await leaf.click({ timeout: this.stepTimeout });
      await this.page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await this.page.waitForTimeout(800);
      await this.settleDataAccessLeaf('数据接入', 'ftp文件接入');
      return;
    }
    // 这些页面的 hash 路由已由录制和页面快照确认。菜单文字/图标在不同版本
    // 的侧栏中会隐藏或折叠，优先直达最终叶子路由可以避免把已经正确的路由
    // 误判成“菜单不存在”；页面进入后仍由用例校验真实页面内容。
    const knownRoute = this.knownRoute(segments);
    if (knownRoute) {
      const base = this.page.url().split('#')[0];
      const targetUrl = `${base}${knownRoute}`;
      if (!this.page.url().includes(knownRoute)) {
        await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: this.stepTimeout });
      }
      await this.page.waitForTimeout(800);
      // 深链 goto 在当前前端偶发“URL 已变、视图仍是数据源管理”的组件残留
      // （run-20260916-161845-734：DS-02-01/DS-04-01 均因侧栏停留上一模块、
      // 主体仍是数据源管理而失败）。先做就绪判定，残留时 reload 强制重挂载，
      // 与 settleDataAccessLeaf 对同类残留的处置保持一致。
      await this.settleKnownRoute(knownRoute);
      // “文件导出”本身只是侧栏父菜单，直接进入父路由时页面会保持空白；
      // 必须再点击实际渲染的“导出列表”叶子项，才能加载列表页。
      if (segments.join('>') === '数据服务>文件导出>导出列表') {
        // 首次直接进入父路由时，左侧子菜单会晚于 DOMContentLoaded 渲染。
        // 不复用首次取到的 Locator：Vue 重渲染后它会失效，并会表现为“明明有
        // 导出列表但点击超时”。只展开一次父菜单，再持续重新获取可见叶子。
        let parentOpened = false;
        let leafClicked = false;
        let leafLoopReloaded = false;
        for (let attempt = 0; attempt < 16; attempt += 1) {
          const leaf = this.page.locator(
            '.ant-menu-item:visible, .el-menu-item:visible, [role="menuitem"]:visible, a:visible',
          ).filter({ hasText: /^\s*导出列表\s*$/ }).last();
          if (await leaf.isVisible().catch(() => false)) {
            await leaf.click({ timeout: this.stepTimeout });
            leafClicked = true;
            break;
          }

          if (!parentOpened) {
            const parent = this.page.locator(
              '.ant-menu-submenu-title:visible, .el-submenu__title:visible, [role="menuitem"]:visible',
            ).filter({ hasText: /^\s*文件导出\s*$/ }).last();
            if (await parent.isVisible().catch(() => false)) {
              await parent.click({ timeout: this.stepTimeout }).catch(() => undefined);
              parentOpened = true;
            }
          }
          // 半程仍未见父菜单时 reload 兜底一次：侧栏残留上一模块时永远等不到
          // “文件导出”；重挂载后 SPA 按当前 hash 直接渲染数据服务侧栏。
          if (attempt === 7 && !parentOpened && !leafLoopReloaded) {
            leafLoopReloaded = true;
            await this.page.reload({ waitUntil: 'domcontentloaded', timeout: this.stepTimeout }).catch(() => undefined);
            await this.page.waitForTimeout(800);
            continue;
          }
          await this.page.waitForTimeout(500);
        }
        if (!leafClicked) {
          throw new Error(`数据服务“文件导出”已进入父路由，但 8 秒内未渲染“导出列表”叶子菜单：${this.page.url()}`);
        }
        await this.page.waitForTimeout(800);
      }
      return;
    }
    for (let index = 0; index < segments.length; index++) {
      await this.clickSegment(segments[index], segments[index - 1]);
    }
    await this.page.waitForTimeout(300);
  }

  private knownRoute(segments: string[]): string | undefined {
    const key = segments.join('>');
    const routes: Record<string, string> = {
      // 数据接入必须走左栏图标链接。该前端对深层 hash 直接 goto 存在
      // “URL 已变、内容仍是数据源管理”的组件残留，不能在这里短路。
      // 数据地图同样需要真实展开“表查询/表管理”父子菜单；前端切换期间
      // 直接跳深层 hash 会偶发保留上一模块的 DOM。
      '数据服务>API管理': '#/dataService/APIManage/apiManage',
      '数据服务>API管理>API测试': '#/dataService/APIManage/apiTest',
      '数据服务>API管理>API授权管理': '#/dataService/APIManage/apiAuthManage',
      // 父路由 #/dataService/fileExport 不渲染内容；录制快照确认叶子“导出列表”
      // 的真实 href 为 #/dataService/fileExport/fileList。
      '数据服务>文件导出>导出列表': '#/dataService/fileExport/fileList',
      '数据服务>我的API>应用注册管理': '#/dataService/myApi/appRegister',
    };
    return routes[key];
  }

  private candidateLocators(segment: string): Locator[] {
    return [
      this.page
        .locator('.el-menu, .ant-menu, nav, aside, .sidebar, [class*="menu"]')
        .getByText(segment, { exact: true }),
      this.page.getByRole('menuitem', { name: segment, exact: true }),
      this.page.getByRole('link', { name: segment, exact: true }),
      // 顶部“···”展开层在部分版本是普通 div，不带 menu/menuitem 语义。
      // 只接受可见节点，避免回到隐藏模板中的同名文本。
      this.page.getByText(segment, { exact: true }),
    ];
  }

  private parentLocators(segment: string): Locator[] {
    return [
      this.page.locator('.el-submenu__title:visible, .ant-menu-submenu-title:visible').getByText(segment, { exact: true }),
      this.page.getByRole('menuitem', { name: segment, exact: true }),
    ];
  }

  private leafLocators(segment: string): Locator[] {
    return [
      this.page.locator('.el-menu-item:visible, .ant-menu-item:visible').getByText(segment, { exact: true }),
      this.page.locator('a:visible[href]').getByText(segment, { exact: true }),
    ];
  }

  /**
   * 部分云桌面菜单的叶子项只有图标，快照中 link 没有可访问文本；
   * 这时不能再依赖 getByText，优先按父级下的真实 href 进入叶子路由。
   */
  private leafRouteLocators(parentSegment: string | undefined, segment: string): Locator[] {
    // 数据接入左栏的图标链接没有可访问文本；按真实 hash 路由点击，不能仅依赖
    // “文件接入”等文字。否则 URL/DOM 会继续停留在默认的数据源管理页。
    if (parentSegment === '数据接入' && segment === '数据源管理') {
      return [this.page.locator('a[href="#/dataAccess/dataSource"]')];
    }
    if (parentSegment === '数据接入' && segment === '数据集成') {
      return [this.page.locator('a[href="#/dataAccess/dataInteration"]')];
    }
    if (parentSegment === '数据接入' && segment === '文件接入') {
      return [this.page.locator('a[href="#/dataAccess/fileAccess"]')];
    }
    if (parentSegment === '数据接入' && segment === 'ftp文件接入') {
      return [this.page.locator('a[href="#/dataAccess/ftpAccess"]')];
    }
    if (parentSegment === '表管理' && segment === '表管理') {
      return [this.page.locator('a[href="#/dataMap/tableManage/tablesManage"]').locator('xpath=..')];
    }
    if (parentSegment === '表查询' && segment === '表查询') {
      return [this.page.locator('a[href="#/dataMap/tableQuery/tablesQuery"]').locator('xpath=..')];
    }
    return [];
  }

  private async firstVisible(candidates: Locator[]): Promise<Locator | undefined> {
    for (const candidate of candidates) {
      const count = await candidate.count();
      for (let index = count - 1; index >= 0; index--) {
        const item = candidate.nth(index);
        if (await item.isVisible().catch(() => false)) return item;
      }
    }
    return undefined;
  }

  /**
   * 深链直达后的视图就绪判定与恢复。数据服务各叶子页不渲染“添加数据源”；
   * 该按钮可见即说明主体仍是数据源管理残留（run-20260916-161845-734 实证：
   * URL 已是目标路由，侧栏仍停留在上一模块）。给一个短暂渲染窗口，仍残留时
   * reload 强制 SPA 按当前 hash 重新挂载。
   */
  private async settleKnownRoute(route: string, timeoutMs = 4_000): Promise<void> {
    if (!route.includes('/dataService/')) return;
    const residue = this.page.getByRole('button', { name: /添加数据源/ }).last();
    const deadline = Date.now() + timeoutMs;
    while ((await residue.isVisible().catch(() => false)) && Date.now() < deadline) {
      await this.page.waitForTimeout(250);
    }
    if (await residue.isVisible().catch(() => false)) {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: this.stepTimeout }).catch(() => undefined);
      await this.page.waitForTimeout(1_000);
    }
  }

  /**
   * URL/左侧高亮已变化但主体仍是数据源管理，是当前 SPA 的组件残留。
   * 仅在非数据源目标且页面仍明显显示“添加数据源”时刷新当前 hash。
   */
  private async settleDataAccessLeaf(parentSegment: string | undefined, segment: string): Promise<void> {
    if (parentSegment !== '数据接入' || segment === '数据源管理') return;
    const staleSourcePage = this.page.getByRole('button', { name: /添加数据源/ }).last();
    if (!(await staleSourcePage.isVisible().catch(() => false))) return;
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: this.stepTimeout });
    await this.page.waitForTimeout(500);
  }

  private async expandOverflowMenu(): Promise<boolean> {
    const overflowCandidates = [
      this.page.getByRole('button', { name: /^(?:更多|···|…|\.\.\.)$/ }),
      this.page.getByRole('menuitem', { name: '···', exact: true }),
      this.page.getByRole('menuitem', { name: '…', exact: true }),
      this.page.getByRole('menuitem', { name: '...', exact: true }),
      this.page.locator('[aria-label*="更多"]:visible, [title*="更多"]:visible'),
      this.page.getByText('更多', { exact: true }),
      this.page.getByText(/^(?:···|…|\.\.\.)$/, { exact: true }),
    ];
    const overflow = await this.firstVisible(overflowCandidates);
    if (process.env.DEBUG_MENU === '1') {
      console.log(`[菜单导航] 溢出菜单候选=${overflow ? '可见' : '未找到'} url=${this.page.url()}`);
    }
    if (!overflow) return false;
    await overflow.click({ timeout: this.stepTimeout });
    await this.page.waitForTimeout(800);
    return true;
  }

  private async clickSegment(segment: string, parentSegment?: string): Promise<void> {
    let overflowExpanded = false;
    let parentReopened = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      // 父级和叶子级文字相同（例如“表管理→表管理”）时，不能把第二次点击
      // 再次落到父级。先展开父级，再从叶子菜单容器中取可见节点。
      if (parentSegment && segment === parentSegment) {
        const leafRoute = await this.firstVisible(this.leafRouteLocators(parentSegment, segment));
        if (leafRoute) {
          await leafRoute.click({ timeout: this.stepTimeout });
          await this.page.waitForLoadState('domcontentloaded').catch(() => undefined);
          await this.page.waitForTimeout(800);
          return;
        }
        // 表管理→表管理、表查询→表查询中，父项与叶子文本完全相同。
        // 通用文字定位会再次点击父项，导致 URL 停在空白父路由；没有真实
        // href 叶子时只允许重新展开父项，下一轮再按 href 进入子页。
        if (parentSegment === '表管理' || parentSegment === '表查询') {
          const parent = await this.firstVisible(this.parentLocators(parentSegment));
          if (parent) {
            await parent.click({ timeout: this.stepTimeout });
            await this.page.waitForTimeout(700);
            parentReopened = true;
            continue;
          }
        }
        const leaf = await this.firstVisible(this.leafLocators(segment));
        if (process.env.DEBUG_MENU === '1') {
          console.log(`[菜单导航] same-label segment=${segment} attempt=${attempt + 1} leaf=${leaf ? '可见' : '未找到'} url=${this.page.url()}`);
        }
        if (leaf) {
          await leaf.click({ timeout: this.stepTimeout });
          await this.page.waitForLoadState('domcontentloaded').catch(() => undefined);
          await this.page.waitForTimeout(800);
          return;
        }
        const parent = await this.firstVisible(this.parentLocators(parentSegment));
        if (process.env.DEBUG_MENU === '1') {
          console.log(`[菜单导航] same-label parent=${parent ? '可见' : '未找到'} segment=${segment}`);
        }
        if (parent) {
          await parent.click({ timeout: this.stepTimeout });
          // Ant 菜单在父级路由切换后会延迟渲染叶子项；需要给路由和展开动画完整时间。
          await this.page.waitForTimeout(3_000);
          parentReopened = true;
          continue;
        }
      }

      // 有些菜单的父级和叶子级同名（如“表管理→表管理”），但调用路径中的
      // 父级文本本身并不相同。此时通用 candidateLocators 可能先命中父级标题，
      // 只落到 #/dataMap/tableManage 等容器路由；只要当前步骤有父级，优先从
      // 真正的叶子菜单项取，确保进入 #/dataMap/tableManage/tablesManage。
      if (parentSegment) {
        // 文件接入等左栏叶子是无文字图标链接，先点击其可见父 menuitem。
        const routeLeaf = await this.firstVisible(this.leafRouteLocators(parentSegment, segment));
        if (routeLeaf) {
          await routeLeaf.click({ timeout: this.stepTimeout });
          await this.page.waitForLoadState('domcontentloaded').catch(() => undefined);
          await this.page.waitForTimeout(800);
          await this.settleDataAccessLeaf(parentSegment, segment);
          return;
        }
        const leaf = await this.firstVisible(this.leafLocators(segment));
        if (leaf) {
          await leaf.click({ timeout: this.stepTimeout });
          await this.page.waitForLoadState('domcontentloaded').catch(() => undefined);
          await this.page.waitForTimeout(800);
          return;
        }
      }

      const target = await this.firstVisible(this.candidateLocators(segment));
      if (process.env.DEBUG_MENU === '1') {
        console.log(`[菜单导航] segment=${segment} attempt=${attempt + 1} target=${target ? '可见' : '未找到'} url=${this.page.url()}`);
      }
      if (target) {
        await target.click({ timeout: this.stepTimeout });
        if (overflowExpanded) {
          // 数据服务等顶层项位于“...”浮层中；点击后该浮层有时不会自动收起，
          // 再点一次溢出按钮可稳定关闭，避免遮挡左侧父子菜单。
          const overflow = await this.firstVisible([
            this.page.getByRole('button', { name: /^(?:更多|···|…|\.\.\.)$/ }),
            this.page.getByRole('menuitem', { name: '···', exact: true }),
            this.page.getByRole('menuitem', { name: '…', exact: true }),
            this.page.getByRole('menuitem', { name: '...', exact: true }),
            this.page.locator('[aria-label*="更多"]:visible, [title*="更多"]:visible'),
          ]);
          if (overflow) await overflow.click({ timeout: this.stepTimeout }).catch(() => undefined);
        }
        await this.page.waitForLoadState('domcontentloaded').catch(() => undefined);
        await this.page.waitForTimeout(800);
        return;
      }

      // 父级菜单点击后可能只完成路由切换，子菜单仍保持收起；
      // 对“数据服务→文件导出→导出列表”这类路径，先重新点击父项展开。
      if (parentSegment && !parentReopened) {
        const parent = await this.firstVisible(this.candidateLocators(parentSegment));
        if (parent) {
          await parent.click({ timeout: this.stepTimeout });
          await this.page.waitForTimeout(500);
          parentReopened = true;
          continue;
        }
      }

      // 只有顶层目标才尝试打开顶部“...”溢出菜单；
      // 子菜单目标若找不到，应继续处理父级展开，不要误点顶部“...”。
      if (!parentSegment && !overflowExpanded && await this.expandOverflowMenu()) {
        overflowExpanded = true;
        continue;
      }
      await this.page.waitForTimeout(500);
    }

    throw new Error(`菜单项“${segment}”未找到或均不可见，当前页面：${this.page.url()}`);
  }
}
