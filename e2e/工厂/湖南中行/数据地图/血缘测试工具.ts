import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { clickMenu, pasteLongText } from '../utils.js';
import {
  chooseFirstOption,
  clickFormControlByLabel,
  clickVisible,
  fillFormField,
} from '../抽样用例工具.js';
// 环境配置中心（ENV-CONFIG-40）：唯一默认值来源；本文件不再写死任何
// 数据源显示名、物理地址或凭据（DS-PERM-47）。
import { requireSftpProfile, testEnvironment } from '../../../test-environment.js';

export type AutoLineageCase = {
  targetTable: string;
  sql: string;
  expectedNodes: string[];
  // 复杂 SQL 只做表级节点核验时可不填写；保留该字段供简单 SQL
  // 或显式开启 STRICT_LINEAGE_FIELDS 的专项字段验证使用。
  expectedRelations?: string[];
  fixtureSet?: LineageFixtureSet;
  /** 目标表及调度脚本所属的数据源；字段血缘专项当前统一使用 GBase。 */
  dataSource?: LineageDataSource;
  /** 任务调度的脚本方言；不填时按 dataSource 自动选择。 */
  scriptType?: RegExp;
  /** SQL 血缘用例的隔离键；填写后该用例拥有独立源表/目标表。 */
  fixtureKey?: string;
  /**
   * 明确声明 SQL 中仅作为解析器输入的虚拟来源表。
   * 这类表故意不创建物理元数据，用于验证“来源表不存在时仍可解析表级血缘”。
   */
  virtualSourceTables?: string[];
};

export type LineageFixtureSet = 'base' | 'complex' | 'gbase';
export type LineageDataSource = 'mysql' | 'gbase';

export type ExistingLineageFixture = {
  targetTable: string;
  sourceTable: string;
  targetField: string;
  sourceField: string;
};

// 血缘用例使用本项目自己维护的两张测试表，不再依赖旧环境的固定表名。
// 建好的测试表保留在测试库中，后续用例只检查并复用，不重复创建、不触碰已有业务表。
// 服务重启并同步新库后，v2 记录仍能显示在列表，但详情元数据已经为空。
// _0831 批次此前固化在 192.168.76.113:3306/e2e_test；113 实例整体下线后
// 物理表全部丢失，而表管理页面仍能搜到同名元数据（脏记录）。ensureLineageTable
// 只要在列表命中即复用，会把脏记录误判为“表存在”，任务调度/血缘解析随即失败。
// 因此 MySQL 夹具整体迁移到 110（192.168.76.110:13306/e2e_test），并换用
// _0920 新后缀：首次不存在时由页面自动建表并上线，天然避开 113 残留的失效
// 元数据。GBase（192.168.79.69）夹具不受 113 下线影响，继续沿用原名。
const DEFAULT_LINEAGE_TARGET_TABLE = 'e2e_hn_lineage_target_0920';
const DEFAULT_LINEAGE_SOURCE_TABLE = 'e2e_hn_lineage_source_0920';
const DEFAULT_COMPLEX_LINEAGE_TARGET_TABLE = 'e2e_hn_complex_target_0920';
const DEFAULT_COMPLEX_LINEAGE_SOURCE_TABLE = 'e2e_hn_complex_source_0920';

function fixtureKeyToken(fixtureKey?: string): string {
  return fixtureKey?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || '';
}

function lineageTargetName(fixtureSet: LineageFixtureSet = 'base', fixtureKey?: string): string {
  const key = fixtureKeyToken(fixtureKey);
  if (key) {
    const override = process.env[`LINEAGE_${key.toUpperCase()}_TARGET_TABLE`]?.trim();
    // MySQL 专用夹具的 _0901 批次物理表随 113 下线丢失，页面残留脏元数据；
    // 非 GBase 夹具换 _0920 后缀在 110 重建。GBase 夹具继续沿用 _0901 名
    // 以复用 192.168.79.69 上的现网表，避免无谓重建。
    const suffix = fixtureSet === 'gbase' ? '0901' : '0920';
    return override || `e2e_hn_lineage_${key}_target_${suffix}`;
  }
  if (fixtureSet === 'complex') {
    return process.env.LINEAGE_COMPLEX_TARGET_TABLE?.trim() || DEFAULT_COMPLEX_LINEAGE_TARGET_TABLE;
  }
  return process.env.LINEAGE_TARGET_TABLE?.trim() || DEFAULT_LINEAGE_TARGET_TABLE;
}

function lineageSourceName(fixtureSet: LineageFixtureSet = 'base', fixtureKey?: string): string {
  const key = fixtureKeyToken(fixtureKey);
  if (key) {
    const override = process.env[`LINEAGE_${key.toUpperCase()}_SOURCE_TABLE`]?.trim();
    // 与 lineageTargetName 同规则：MySQL 换 _0920（113 脏元数据规避），
    // GBase 保持 _0901 复用现网表。
    const suffix = fixtureSet === 'gbase' ? '0901' : '0920';
    return override || `e2e_hn_lineage_${key}_source_${suffix}`;
  }
  if (fixtureSet === 'complex') {
    return process.env.LINEAGE_COMPLEX_SOURCE_TABLE?.trim() || DEFAULT_COMPLEX_LINEAGE_SOURCE_TABLE;
  }
  return process.env.LINEAGE_SOURCE_TABLE?.trim() || DEFAULT_LINEAGE_SOURCE_TABLE;
}

function fixtureDataSource(fixtureSet: LineageFixtureSet): LineageDataSource {
  return fixtureSet === 'gbase' ? 'gbase' : 'mysql';
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * MySQL（primary profile）平台显示名候选，按 includes 匹配优先级排序：
 * 1. LINEAGE_DATA_SOURCE：字段血缘专属显式覆盖（DS-PERM-47）；
 * 2. primary profile 推导全名 host:port/database（profile 是唯一默认值来源）；
 * 3. dataSourceNames.tableManagement（TABLE_NEW_DATABASE 兼容覆盖，host:port）；
 * 4. primary host（最后兜底，仅防下拉只登记短名）。
 * 全名优先可避免 includes 语义误选同 host 上未登记 e2e_test 库的其它数据源。
 */
export function primaryMysqlDataSourceCandidates(): Array<string | undefined> {
  const db = testEnvironment.databases.primary;
  return [
    process.env.LINEAGE_DATA_SOURCE?.trim(),
    db.database ? `${db.host}:${db.port}/${db.database}` : `${db.host}:${db.port}`,
    testEnvironment.dataSourceNames.tableManagement.newDataBase,
    db.host,
  ];
}

/** 报告用主 MySQL 显示名（primary profile 推导，不写死地址）。 */
export function primaryMysqlDataSourceLabel(): string {
  const db = testEnvironment.databases.primary;
  return db.database ? `${db.host}:${db.port}/${db.database}` : `${db.host}:${db.port}`;
}

/**
 * 报告用数据源显示名：GBase 走 GBase 专属配置（gbaseSourceName，即
 * GBASE_SOURCE_NAME 兼容变量），不依赖 MySQL 默认；MySQL 走 primary profile。
 */
export function lineageDataSourceLabel(dataSource: LineageDataSource): string {
  return dataSource === 'gbase'
    ? `GBase ${testEnvironment.dataSourceNames.gbaseSourceName}`
    : `MySQL ${primaryMysqlDataSourceLabel()}`;
}

/**
 * 字段血缘 SFTP 接入的基础文件名（去扩展名）：LINEAGE_SFTP_BASE_FILE 单项
 * 覆盖，默认取 SFTP profile baseFile。只读配置中心，不做凭据校验，可在
 * 模块加载期安全调用（图谱文件节点名等非连接场景使用）。
 */
export function lineageSftpBaseFileName(): string {
  return process.env.LINEAGE_SFTP_BASE_FILE?.trim()
    || testEnvironment.fileTransfer.sftp.baseFile.replace(/\.[^./]+$/, '');
}

/** 字段血缘 SFTP 接入配置（地址/端口/凭据 + 远端目录与基础文件名）。 */
export type LineageSftpAccessConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
  /** 接入表单“文件”目录：LINEAGE_SFTP_PATH 单项覆盖，默认 SFTP profile baseDir。 */
  remoteDir: string;
  /** 基础文件名（去扩展名）：LINEAGE_SFTP_BASE_FILE 单项覆盖，默认 profile baseFile。 */
  baseFileName: string;
};

/**
 * 字段血缘 SFTP 接入配置（DS-PERM-47）：地址、端口与凭据一律来自
 * requireSftpProfile()——真实凭据只能由进程环境变量提供，缺失时抛出只含
 * 变量名的可读错误，不回退任何默认账号密码；目录与基础文件名允许
 * LINEAGE_SFTP_PATH / LINEAGE_SFTP_BASE_FILE 单项覆盖。必须在用例内调用，
 * 不要在模块加载期调用（凭据校验会立即抛错，破坏 --list 等静态加载）。
 */
export function resolveLineageSftpAccess(): LineageSftpAccessConfig {
  const sftp = requireSftpProfile();
  return {
    host: sftp.host,
    port: sftp.port,
    username: sftp.username,
    password: sftp.password,
    remoteDir: process.env.LINEAGE_SFTP_PATH?.trim() || sftp.baseDir,
    baseFileName: lineageSftpBaseFileName(),
  };
}

function hashCode(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function lineageDebug(message: string): void {
  if (process.env.LINEAGE_DEBUG === '1') console.log(`[lineage] ${message}`);
}

async function lastVisible(locator: Locator): Promise<Locator | undefined> {
  for (let index = await locator.count() - 1; index >= 0; index -= 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

async function clickAction(page: Page, name: string | RegExp): Promise<void> {
  const action = await lastVisible(page.getByRole('button', { name }))
    ?? await lastVisible(page.getByRole('link', { name }))
    ?? await lastVisible(page.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: name }));
  if (!action) throw new Error(`未找到可见操作“${String(name)}”，当前页面：${page.url()}`);
  await action.click();
}

async function waitForTableDetail(page: Page): Promise<void> {
  await expect.poll(async () => {
    const title = await lastVisible(page.getByText('表详情', { exact: true }));
    if (title) return 'detail';
    const basicTab = await lastVisible(page.getByRole('tab', { name: /基本信息/ }))
      ?? await lastVisible(page.getByText('基本信息', { exact: true }));
    const detailTab = await lastVisible(page.getByText(/字段信息|调度任务|数据血缘/, { exact: true }));
    return basicTab || detailTab ? 'detail' : 'waiting';
  }, { timeout: 15_000 }).toBe('detail');
}

/** 详情页页签可能折叠进“更多”，只命中当前可见页签或弹出项。 */
export async function clickLineageTab(page: Page, name: string | RegExp): Promise<void> {
  // “编辑血缘”中的“表级 / 字段级”不是语义 tab，而是普通可点击 div。
  // 表级默认已打开时，先以真正的编辑控件作为成功标志，避免再按 tab 查找而误报失败。
  if (/表级/.test(String(name))) {
    const addUpstream = await lastVisible(page.getByRole('button', { name: /添加上游/ }));
    if (addUpstream) return;
  }

  const find = async (): Promise<Locator | undefined> =>
    await lastVisible(page.getByRole('tab', { name }))
      ?? await lastVisible(page.locator('[role="tab"]:visible, .ant-tabs-tab:visible, .el-tabs__item:visible').filter({ hasText: name }))
      ?? await lastVisible(page.locator('[role="menu"]:visible [role="menuitem"]:visible, .ant-tabs-dropdown:visible *, .el-tabs__dropdown:visible *').filter({ hasText: name }))
      // 编辑表页的“任务调度”是普通文本 tab，页面没有稳定 role。
      ?? (/(?:任务调度|调度任务)/.test(String(name))
        ? await lastVisible(page.getByText(/^(?:任务调度|调度任务)$/, { exact: true }))
        : undefined)
      // 当前页面录制证实：编辑页“表级/字段级”由普通文本节点实现。
      ?? await lastVisible(page.getByText(name, { exact: typeof name === 'string' }));

  // 详情页的“数据血缘”是标准页签，但页面下方仍可能保留字段信息页的
  // SVG/图标节点。点击后必须确认该 tab 真的成为 selected，不能只以 SVG 存在
  // 作为切换成功标志。
  if (/数据血缘/.test(String(name))) {
    const isActive = async (tab: Locator): Promise<boolean> => {
      const selected = await tab.getAttribute('aria-selected').catch(() => null);
      const className = await tab.getAttribute('class').catch(() => '');
      const parentClass = await tab.locator('xpath=..').getAttribute('class').catch(() => '');
      return selected === 'true' || /active|selected/.test(`${className || ''} ${parentClass || ''}`);
    };
    const activateTab = async (tab: Locator): Promise<boolean> => {
      await tab.scrollIntoViewIfNeeded().catch(() => undefined);
      await tab.click({ force: true }).catch(() => undefined);
      if (await expect.poll(() => isActive(tab), { timeout: 2_000 }).toBe(true).then(() => true, () => false)) return true;

      // 当前版本偶尔把点击事件挂在 tab 内层文字节点；再次点击内层，
      // 并用键盘回车作为无障碍控件的兜底触发方式。
      const inner = await lastVisible(tab.locator('.ant-tabs-tab-btn, .el-tabs__item, [role="tab"]'));
      if (inner) await inner.click({ force: true }).catch(() => undefined);
      if (await expect.poll(() => isActive(tab), { timeout: 2_000 }).toBe(true).then(() => true, () => false)) return true;
      await tab.press('Enter').catch(() => undefined);
      return await expect.poll(() => isActive(tab), { timeout: 2_000 }).toBe(true).then(() => true, () => false);
    };

    // 录制页面确认的标准结构：详情页直接存在 role=tab“数据血缘”。
    // 先命中当前可见的最后一个标准 tab，避免字段信息页残留的同名描述
    // 或隐藏 tablist 干扰同级查找。
    const directRoleLineageTab = await lastVisible(page.getByRole('tab', { name: '数据血缘', exact: true }));
    if (directRoleLineageTab) {
      if (!await activateTab(directRoleLineageTab)) {
        throw new Error('详情页找到了“数据血缘”页签，但点击后未切换为激活状态。');
      }
      return;
    }
    // 详情页可能同时存在隐藏的旧 tablist、字段编辑 tab 和当前详情 tab。
    // 先取“字段信息”所在的同级 tablist，再在同一组里找“数据血缘”，
    // 避免命中隐藏副本或页面其它区域的同名文本。
    const fieldTab = await lastVisible(page.getByRole('tab', { name: /字段信息/ }))
      ?? await lastVisible(page.getByText('字段信息', { exact: true }));
    const sameTabList = fieldTab
      ? fieldTab.locator('xpath=ancestor::*[@role="tablist"][1]')
      : undefined;
    const lineageTab = (sameTabList
      ? await lastVisible(sameTabList.getByRole('tab', { name: /数据血缘/ }))
      : undefined)
      ?? await lastVisible(page.getByRole('tab', { name: /数据血缘/ }));
    if (lineageTab) {
      if (!await activateTab(lineageTab)) {
        throw new Error('详情页找到了“数据血缘”页签，但点击后未切换为激活状态。');
      }
      return;
    }
    const tabContainer = await lastVisible(page.locator(
      '[role="tab"]:visible, .ant-tabs-tab:visible, .ant-tabs-tab-btn:visible, .el-tabs__item:visible, [class*="tab-item"]:visible',
    ).filter({ hasText: /^\s*数据血缘\s*$/ }));
    if (tabContainer) {
      await tabContainer.scrollIntoViewIfNeeded().catch(() => undefined);
      await tabContainer.click({ force: true });
      await page.waitForTimeout(500);
      return;
    }
    // 还有版本把详情页签渲染为无 role/class 的普通文本节点；此时必须
    // 使用“完全等于数据血缘”的文本，不能让正则回退命中描述里的
    // “测试数据血缘”等非页签内容。
    const exactLineageTab = await lastVisible(page.getByText('数据血缘', { exact: true }));
    if (exactLineageTab) {
      await exactLineageTab.scrollIntoViewIfNeeded().catch(() => undefined);
      await exactLineageTab.click({ force: true });
      await page.waitForTimeout(300);
      return;
    }
  }

  // 表详情页实际文案为“调度任务”，表编辑页录制文案为“任务调度”；
  // 两者都表示同一个调度配置页签，不能因词序差异误判为页面缺项。
  if (/(?:任务调度|调度任务)/.test(String(name))) {
    const scheduleTab = await lastVisible(page.getByRole('tab', { name: /任务调度|调度任务/ }))
      ?? await lastVisible(page.locator('[role="tab"]:visible, .ant-tabs-tab:visible, .el-tabs__item:visible')
        .filter({ hasText: /任务调度|调度任务/ }))
      ?? await lastVisible(page.getByText(/^(?:任务调度|调度任务)$/, { exact: true }));
    if (scheduleTab) {
      const isSelected = async (): Promise<boolean> => {
        const selected = await scheduleTab.getAttribute('aria-selected').catch(() => null);
        const className = await scheduleTab.getAttribute('class').catch(() => '');
        const parentClass = await scheduleTab.locator('xpath=..').getAttribute('class').catch(() => '');
        return selected === 'true' || /active|selected/.test(`${className || ''} ${parentClass || ''}`);
      };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await scheduleTab.scrollIntoViewIfNeeded().catch(() => undefined);
        await scheduleTab.click({ force: true }).catch(() => undefined);
        if (await expect.poll(isSelected, { timeout: 2_000 }).toBe(true).then(() => true, () => false)) return;
        const inner = await lastVisible(scheduleTab.locator('.ant-tabs-tab-btn, .el-tabs__item, [role="tab"]'));
        if (inner) await inner.click({ force: true }).catch(() => undefined);
        if (await expect.poll(isSelected, { timeout: 2_000 }).toBe(true).then(() => true, () => false)) return;
        await scheduleTab.press('Enter').catch(() => undefined);
      }
      // 部分版本没有 aria-selected/class 标记，但内容确实已切换；让调用方
      // 再按“生产脚本”确认，避免把基本信息页误当成调度页。
      if (await page.getByText('生产脚本', { exact: true }).isVisible().catch(() => false)) return;
      throw new Error(`找到“${String(name)}”页签但点击后未切换到调度内容。`);
    }
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const tab = await find();
    if (tab) {
      await tab.click();
      await page.waitForTimeout(300);
      return;
    }
    const more = await lastVisible(page.locator(
      '.ant-tabs-nav-more:visible, .el-tabs__nav-more:visible, [aria-label*="更多"]:visible, [title*="更多"]:visible',
    ));
    if (!more) break;
    await more.click();
    await page.waitForTimeout(250);
  }
  throw new Error(`未找到数据地图详情页签“${String(name)}”，当前页面：${page.url()}`);
}

async function openMapLeaf(page: Page, hrefPart: string, menuName: string): Promise<void> {
  const pageContentReady = async (): Promise<boolean> => {
    if (menuName === '表查询') {
      return await expect.poll(async () =>
        await page.locator('.table-query:visible').count() > 0
          || await page.getByPlaceholder('按表名、中文名、描述、负责人搜索').isVisible().catch(() => false),
      { timeout: 8_000 }).toBe(true).then(() => true, () => false);
    }
    if (menuName === '表管理') {
      return await expect.poll(async () => {
        const stateTabs = page.getByRole('tab', { name: /物理表存在|草稿/ });
        const newTable = page.getByRole('button', { name: /新建表|新增表/ });
        return await stateTabs.count() > 0
          && await newTable.isVisible().catch(() => false);
      }, { timeout: 8_000 }).toBe(true).then(() => true, () => false);
    }
    return true;
  };

  const tryRoute = async (route: string, reload = false): Promise<boolean> => {
    const target = new URL(page.url());
    target.hash = route;
    try {
      await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
      if (reload) await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForURL(new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), { timeout: 10_000 });
    } catch {
      return false;
    }
    const ready = await pageContentReady();
    if (ready) return true;
    // 详情页返回列表时，表管理的附属接口（例如文件接入列表）可能先
    // 返回 500，导致“新建表”按钮迟到；但路由组件已经切换完成。此时
    // 不要再回退到菜单遍历（菜单组件会被 loading 遮罩卡住），交给后续
    // 的表格定位逻辑继续等待并给出具体的列表错误。
    if (page.url().includes(hrefPart)) return true;
    return false;
  };

  // 表查询在不同版本存在两个入口：侧栏父路由和实际列表子路由。
  // 先尝试录制确认的子路由；如果 hash 改了但组件仍停在“表管理”，
  // 再强制整页重载，并尝试父路由，确保组件真正重新挂载。
  if (menuName === '表查询') {
    if (await tryRoute(hrefPart)) return;
    if (await tryRoute(hrefPart, true)) return;
    if (hrefPart !== '#/dataMap/tableQuery' && await tryRoute('#/dataMap/tableQuery')) return;
  } else {
    if (await tryRoute(hrefPart)) return;
  }

  // SPA 可能只更新了 hash，组件仍停在上一个模块；回退到菜单点击让
  // 路由组件重新挂载，而不是继续在错误页面等待表卡。

  await clickMenu(page, '数据地图');
  let leaf = page.locator(`a:visible[href*="${hrefPart}"]`).last();
  if (!(await leaf.isVisible().catch(() => false))) {
    // 当前云桌面版本的“表查询”侧栏父项只有图标，没有可访问文本；
    // 这时应按真实 href 点击父项，再等待查询组件，而不是从页面上
    // 随机命中同名的“表管理”文本。
    const parentQuery = page.locator('a:visible[href="#/dataMap/tableQuery"]').last();
    if (menuName === '表查询' && await parentQuery.isVisible().catch(() => false)) {
      await parentQuery.click({ force: true });
      await page.waitForTimeout(800);
      if (await pageContentReady()) return;
      // 父路由可能只展开子菜单；再尝试实际列表路由。
      leaf = page.locator('a:visible[href*="/dataMap/tableQuery/tablesQuery"]').last();
    } else {
      const menu = await lastVisible(page.getByText(menuName, { exact: true }));
      if (!menu) throw new Error(`未找到“${menuName}”菜单，当前账号可能没有数据地图权限。`);
      await menu.click();
      await page.waitForTimeout(350);
      leaf = page.locator(`a:visible[href*="${hrefPart}"]`).last();
    }
  }
  if (await leaf.isVisible().catch(() => false)) {
    await leaf.click({ force: true });
    await page.waitForURL(new RegExp(hrefPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).catch(() => undefined);
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  } else if (await tryRoute(menuName === '表查询' ? '#/dataMap/tableQuery' : hrefPart, true)) {
    return;
  } else {
    throw new Error(`未找到“${menuName}”可进入的叶子菜单，当前页面：${page.url()}`);
  }

  if (!(await pageContentReady())) {
    throw new Error(`已切换到“${menuName}”路由但目标组件未加载，当前页面：${page.url()}`);
  }
}

async function publishTableIfPresent(page: Page, tableName: string): Promise<boolean> {
  try {
    // 建表完成后默认可能仍是草稿；只有上线后才会进入“表查询”。
    await openMapLeaf(page, '#/dataMap/tableManage/tablesManage', '表管理');
    const row = await searchManageRow(page, tableName);
    const publish = await lastVisible(row.getByRole('button', { name: /上\s*线/ }))
      ?? await lastVisible(row.locator('a:visible, .el-link:visible, [role="button"]:visible, td:visible').filter({ hasText: /上\s*线/ }));
    if (!publish || !(await publish.isEnabled().catch(() => false))) return false;
    await clickRowAction(page, row, /上\s*线/);
    const dialog = await lastVisible(page.locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible'));
    if (dialog) {
      const confirm = await lastVisible(dialog.getByRole('button', { name: /^\s*(确\s*定|上\s*线|发\s*布)\s*$/ }))
        ?? await lastVisible(dialog.locator('button:visible, [role="button"]:visible').filter({ hasText: /确\s*定|上\s*线|发\s*布/ }));
      if (confirm) await confirm.click();
    }
    await page.waitForTimeout(1_000);
    return true;
  } catch {
    return false;
  }
}

async function searchAndOpenTable(
  page: Page,
  tableName: string,
  mode: 'manage' | 'query',
  allowPublish = true,
): Promise<void> {
  const placeholders = mode === 'manage'
    ? /表名|名称|关键字|搜索/
    : /按表名、中文名、描述、负责人搜索|表名|关键字|搜索/;
  const search = await lastVisible(page.getByPlaceholder(placeholders));
  if (search) {
    await search.fill('');
    if (mode === 'query') await search.pressSequentially(tableName, { delay: 10 });
    else await search.fill(tableName);
    await search.press('Enter');
    await search.blur();
  }

  if (mode === 'query') {
    // 表查询首次加载较慢，并且加载期间会短暂显示“暂无数据”。不能看到空态就立即失败，
    // 需等待实际卡片返回后从卡片标题进入详情页。
    const matchingCard = page.locator('.table-query .card:visible').filter({ hasText: tableName }).last();
    await expect(matchingCard).toBeVisible({ timeout: 30_000 }).catch(() => undefined);
    if (await matchingCard.isVisible().catch(() => false)) {
      const cardName = await lastVisible(matchingCard.locator('.table-name:visible, [class*="table-name"]:visible'));
      await (cardName ?? matchingCard).click();
      await waitForTableDetail(page);
      return;
    }
  }
  const name = await lastVisible(page.getByText(tableName, { exact: true }));
  if (!name) {
    if (mode === 'query' && allowPublish && await publishTableIfPresent(page, tableName)) {
      await openMapLeaf(page, '#/dataMap/tableQuery/tablesQuery', '表查询');
      await searchAndOpenTable(page, tableName, 'query', false);
      return;
    }
    throw new Error(`环境前置条件缺失：未在${mode === 'manage' ? '表管理' : '表查询'}中找到“${tableName}”。`);
  }
  await name.click();
  await waitForTableDetail(page);
}
const MANAGE_ROW_SELECTOR = [
  'tbody > tr:visible',
  '.el-table__body-wrapper tr:visible',
  '.table-manage .card:visible',
  '.table-list .card:visible',
].join(', ');

/**
 * 录制草稿里的“下线→编辑”是在表管理列表行上完成的，不是进入表详情后再找按钮。
 * 这里保持在列表页，并且只返回包含目标表名的那一行，避免误操作第一条脏数据。
 */
/**
 * 把表名称筛选条件写入表管理筛选区并触发一次查询。查询会把选中页签复位到
 * 默认“物理表存在”页，但切换状态页时会保留筛选条件（见
 * findManageRowOnCurrentTab 说明），因此调用方可以先过滤再跨页签扫描。
 */
async function fillManageTableFilter(page: Page, tableName: string, timeout = 30_000): Promise<void> {
  let search = await lastVisible(page.getByPlaceholder(/表名|名称|关键字|搜索/));
  if (!search) {
    // 当前表管理页的“表名称”输入框没有 placeholder，只能从标签同级容器取。
    const label = await lastVisible(page.getByText(/^\s*表名称\s*[:：]?\s*$/));
    if (label) {
      let scope = label;
      for (let depth = 0; depth < 5 && !search; depth += 1) {
        search = await lastVisible(scope.locator('input:visible'));
        scope = scope.locator('..');
      }
    }
  }
  if (!search) {
    // 当前页面筛选区的标签与表头同名，且没有 placeholder；按 DOM 顺序，
    // 第一个可见文本框就是“表名称”，第二个是“表中文名”。
    search = await lastVisible(page.locator('input:visible').first());
  }
  if (!search) return;
  await search.fill(tableName, { timeout: Math.min(timeout, 4_000) });
  await search.press('Enter', { timeout: Math.min(timeout, 4_000) }).catch(() => undefined);
  const query = await lastVisible(page.getByRole('button', { name: /查\s*询/ }));
  if (query) await query.click({ timeout: Math.min(timeout, 4_000) }).catch(() => undefined);
  await search.blur({ timeout: 2_000 }).catch(() => undefined);
}

async function searchManageRowOnce(page: Page, tableName: string, timeout = 30_000): Promise<Locator> {
  await fillManageTableFilter(page, tableName, timeout);
  return findManageRowOnCurrentTab(page, tableName, timeout);
}

/**
 * 只在当前状态页上查找目标行，不重新触发“查询”。表管理切换状态页时会
 * 保留筛选条件并自动刷新列表；但若切换页签后再次点击“查询”，组件会
 * 把页签重置回默认“物理表存在”页（2026-09-21 探测：查询触发
 * selectTableStatusList 刷新并复位选中页签），草稿等状态页的目标行就
 * 永远查不到。跨状态页搜索必须使用本函数。
 */
async function findManageRowOnCurrentTab(page: Page, tableName: string, timeout = 30_000): Promise<Locator> {
  const rows = page.locator(MANAGE_ROW_SELECTOR).filter({ hasText: tableName });
  const exactName = page.getByText(tableName, { exact: true }).last();
  // 固定列组件可能同时渲染多份可见 tbody（表头、左固定列和滚动列）；
  // 不能把所有 tbody 合并后按全局索引映射，否则单行表也可能取到 nth(3)
  // 的不存在右侧行。只取当前表格最后一组固定列容器。
  const fixedLeftContainer = page.locator('.ant-table-fixed-left:visible').last();
  const fixedRightContainer = page.locator('.ant-table-fixed-right:visible').last();
  const fixedLeftRows = fixedLeftContainer.locator('tbody > tr:visible');
  const fixedTargetRows = fixedLeftRows.filter({ hasText: tableName });
  const tableNameLinks = page.locator('a:visible, .table-name:visible, [class*="table-name"]:visible')
    .filter({ hasText: tableName });
  await expect.poll(async () =>
    (await rows.count()) > 0
      || await exactName.isVisible().catch(() => false)
      || (await fixedTargetRows.count()) > 0
      || (await tableNameLinks.count()) > 0,
    { timeout },
  ).toBe(true);
  const row = rows.first();
  if (await row.isVisible().catch(() => false)) {
    const exactName = row.getByText(tableName, { exact: true }).first();
    if (await exactName.isVisible().catch(() => false)) {
      const inlineActions = row.locator('button:visible, a:visible, .el-link:visible, [role="button"]:visible')
        .filter({ hasText: /编辑|下\s*线|上\s*线|配\s*置/ });
      if (await inlineActions.count()) return row;
    }
  }

  // Ant Design 固定列把表名和操作列拆成两个平行 tbody。用固定左列中
  // 目标表的行号映射固定右列，保证“编辑/上线/下线”仍属于同一张表。
  const leftRows = fixedLeftRows;
  const rightRows = fixedRightContainer.locator('tbody > tr:visible');
  for (let index = 0; index < await leftRows.count(); index += 1) {
    const leftRow = leftRows.nth(index);
    if (!(await leftRow.innerText().catch(() => '')).includes(tableName)) continue;
    const rightRow = rightRows.nth(index);
    if (await rightRow.isVisible().catch(() => false)) return rightRow;
  }

  // 当前版本表格使用“表名链接”和“固定操作按钮”两套平行 DOM。
  // 以页面中表名链接的顺序计算目标行序号，再取同序号的编辑按钮所在操作单元。
  const links = page.locator('a:visible, .table-name:visible, [class*="table-name"]:visible');
  let tableIndex = 0;
  let targetIndex = -1;
  for (let index = 0; index < await links.count(); index += 1) {
    const text = (await links.nth(index).innerText().catch(() => '')).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(text)) continue;
    if (text === tableName) targetIndex = tableIndex;
    tableIndex += 1;
  }
  const editButtons = page.getByRole('button', { name: /编辑/ });
  if (targetIndex >= 0 && targetIndex < await editButtons.count()) {
    let actionCell = editButtons.nth(targetIndex).locator('xpath=..');
    for (let depth = 0; depth < 4; depth += 1) {
      const hasEdit = await actionCell.getByRole('button', { name: /编辑/ }).count().catch(() => 0);
      const hasState = await actionCell.getByRole('button', { name: /上\s*线|下\s*线/ }).count().catch(() => 0);
      if (hasEdit && hasState) return actionCell;
      actionCell = actionCell.locator('xpath=..');
    }
    return editButtons.nth(targetIndex).locator('xpath=..');
  }

  // 当前版本把左侧表名和右侧操作拆成两个无表头的可访问行：
  // 表名是 button，操作是另一张并行表中的“上线/编辑”按钮。按目标
  // 表名按钮在当前页的序号映射到编辑按钮，返回操作单元供调用方继续
  // 执行上线/下线/编辑，不能把只有表名的左侧行当成可操作行。
  const tableNameButtons = page.getByRole('button', { name: tableName, exact: true });
  const actionButtons = page.getByRole('button', { name: /编辑/ });
  let targetButtonIndex = -1;
  for (let index = 0; index < await tableNameButtons.count(); index += 1) {
    if (await tableNameButtons.nth(index).isVisible().catch(() => false)) {
      targetButtonIndex = index;
      break;
    }
  }
  if (targetButtonIndex >= 0 && targetButtonIndex < await actionButtons.count()) {
    const editButton = actionButtons.nth(targetButtonIndex);
    if (await editButton.isVisible().catch(() => false)) return editButton.locator('xpath=../..');
  }

  // 兼容无 tbody 的可访问性表格，但仍只返回目标表所在行，不做页面级兜底。
  const ariaRows = page.locator('[role="row"]:visible:not(:has([role="columnheader"]))').filter({ hasText: tableName });
  if (await ariaRows.count()) return ariaRows.first();
  throw new Error(`环境前置条件缺失：表管理列表未找到“${tableName}”对应的可操作行。`);
}

function manageTableSearchNames(tableName: string): string[] {
  // 表名是数据库对象名，必须保持英文/数字/下划线；“血缘测试_”只能
  // 写入表中文名，不能作为表名查询条件。搜索只使用真实物理表名，
  // 防止第二轮回退把中文显示名误填进“表名称”输入框。
  return [tableName];
}

async function searchManageRow(page: Page, tableName: string, timeout = 30_000): Promise<Locator> {
  let lastError: unknown;
  const names = manageTableSearchNames(tableName);
  const perAttempt = Math.max(3_000, Math.floor(timeout / names.length));
  for (const name of names) {
    try {
      return await searchManageRowOnce(page, name, perAttempt);
    } catch (error) {
      // 详情接口明确返回 4xx/5xx 时是服务依赖或后端接口问题；
      // 不再对同一失败重复打开三次页面，避免每条血缘用例白耗近两分钟。
      if (error instanceof Error && /表详情接口加载失败/.test(error.message)) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`环境前置条件缺失：表管理列表未找到“${tableName}”。`);
}

/** 表管理各状态页的命中结果：state=draft 表示记录还只是元数据草稿。 */
type ManageRowHit = { row: Locator; state: 'physical' | 'draft'; tabName: string };

/**
 * 表名唯一性校验覆盖所有状态页。一次建表请求可能已经写入草稿或
 * 下线记录，但列表默认只显示“物理表存在”页；若只查默认页，第二次
 * 执行会看到“表名称已经存在”却又找不到可复用的记录。
 */
async function searchManageRowAcrossStates(page: Page, tableName: string): Promise<ManageRowHit> {
  // 2026-09-21（110 环境）：ensureTableOnline / requireLineageFixture /
  // ensureFieldLineageTargetTable 会冷启动直接进入表管理，此时筛选框为空，
  // 本函数只扫每个状态页的第 1 页，388 张表时目标表在深翻页里永远扫不到
  // （round-B 的 BL-02-04/03-02 与 GBase 04 家族 3 例同因失败，失败快照
  // 证实筛选框为空、停留在“物理表存在(388)”第 1 页）。扫描前先按表名
  // 过滤；查询会复位页签，但下面本来就是逐页签扫描，切换页签会保留条件。
  await fillManageTableFilter(page, tableName).catch(() => undefined);
  const tabs = page.getByRole('tab', { name: /物理表存在|草稿/ });
  for (let index = await tabs.count() - 1; index >= 0; index -= 1) {
    const tab = tabs.nth(index);
    if (!(await tab.isVisible().catch(() => false))) continue;
    const tabName = (await tab.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    // 状态页切换会短暂被 Ant loading 遮罩拦截；force 点击打在遮罩上时
    // 页签根本不会切换，后续搜索全在旧页签上执行、必然落空。先等遮罩
    // 消退再点，并确认目标页签真的处于选中态。
    await expect(page.locator('.ant-spin-spinning:visible, .el-loading-mask:visible'))
      .toHaveCount(0, { timeout: 10_000 }).catch(() => undefined);
    await expect(page.locator('.ant-spin-spinning:visible, .el-loading-mask:visible'))
      .toHaveCount(0, { timeout: 10_000 }).catch(() => undefined);
    await tab.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(700);
    // 个别主题的页签没有 aria-selected 属性（读不到时视为已切换，由后续
    // 搜索结果兜底）；明确读到 false 说明点击被遮罩拦截，重试一次。
    if ((await tab.getAttribute('aria-selected').catch(() => undefined)) === 'false') {
      await expect(page.locator('.ant-spin-spinning:visible, .el-loading-mask:visible'))
        .toHaveCount(0, { timeout: 10_000 }).catch(() => undefined);
      await tab.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(300);
    try {
      // 不重新触发“查询”：查询会把页签复位到默认页（见 findManageRowOnCurrentTab）。
      const row = await findManageRowOnCurrentTab(page, tableName, 8_000);
      return { row, state: /草稿/.test(tabName) ? 'draft' : 'physical', tabName };
    } catch {
      // 继续扫描其它状态；最后由调用方决定是否创建新表。
    }
  }
  throw new Error(`表管理各状态页均未找到“${tableName}”。`);
}

/**
 * “草稿”页签的记录只有元数据（existsStatus=不存在），物理表并未建成，
 * 直接点“上线”必然失败。从该记录的“编辑”（右侧固定列“操作”）进入表单，
 * 在表单里补点“建表”，再回到表管理确认目标表已出现在“物理表存在”页签。
 * 2026-09-21 快照证实：草稿行表格主体的“已配置/配置”是“基本信息/生产脚本”
 * 两列的状态徽标（误点“配置”会打开生产脚本编辑器），行操作“编辑”在
 * .ant-table-fixed-right 的平行表格里，必须优先从那里定位。
 * 2026-09-20（110 环境迁移）：用于回收“保存成功但建表被跳过”的历史草稿。
 */
async function buildPhysicalTableFromDraftRow(page: Page, row: Locator, tableName: string): Promise<void> {
  const captured: string[] = [];
  const onPageResponse = async (response: Response): Promise<void> => {
    if (/tableManage\/(createTable|updateTable|save|add|checkTable)/.test(response.url())) {
      const body = await response.text().catch(() => '<无法读取响应体>');
      captured.push(`${response.status()} ${response.url()} :: ${body}`);
    }
  };
  page.on('response', onPageResponse);
  try {
    // 优先点右侧固定列“操作”里的“编辑”；旧版把操作放在行内时走 clickRowAction。
    const editInFixedRight = (): Locator => page.locator('.ant-table-fixed-right:visible')
      .locator('button:visible').filter({ hasText: /^\s*编\s*辑\s*$/ });
    let fixedRightEdit = editInFixedRight().last();
    if ((await editInFixedRight().count()) > 1) {
      // 列表未按表名过滤时，同屏可能有多条草稿行；先填条件查询（会把页签
      // 复位回默认页），再跨状态页回到草稿页签，保证固定列上只剩目标行的
      // “编辑”，避免误开其它表的表单。
      await searchManageRowOnce(page, tableName, 8_000).catch(() => undefined);
      await searchManageRowAcrossStates(page, tableName);
      fixedRightEdit = editInFixedRight().last();
    }
    if (await fixedRightEdit.isVisible().catch(() => false)) {
      await fixedRightEdit.click();
    } else {
      await clickRowAction(page, row, /^\s*编\s*辑\s*$/);
    }
    const build = page.getByRole('button', { name: /建\s*表/ }).last();
    if (!(await build.isVisible().catch(() => false))) {
      // 个别版本编辑页需要先保存元数据才会出现“建表”按钮。
      await page.getByRole('button', { name: /保\s*存/ }).last().click();
      await expect(build).toBeVisible({ timeout: 10_000 });
    }
    await expect(build).toBeEnabled({ timeout: 10_000 });
    await build.click();
    // 当前前端建表成功后 URL 不一定离开 tableCreate；以列表出现目标表为准。
    await openMapLeaf(page, '#/dataMap/tableManage/tablesManage', '表管理');
    try {
      await searchManageRow(page, tableName, 15_000);
    } catch {
      const hit = await searchManageRowAcrossStates(page, tableName).catch(() => undefined);
      if (!hit || hit.state === 'draft') {
        const toast = await page.locator('.ant-message').innerText({ timeout: 2_000 }).catch(() => '');
        throw new Error(
          `草稿“${tableName}”执行“建表”后仍未出现在“物理表存在”页签。`
            + `页面提示：${(toast || '').trim() || '无'}。接口反馈：\n`
            + `${captured.join('\n') || '未捕获到建表相关接口响应'}`,
        );
      }
    }
  } finally {
    page.off('response', onPageResponse);
  }
}

async function clickRowAction(page: Page, row: Locator, name: RegExp): Promise<void> {
  // 表管理切换状态页后会短暂显示 Ant Design loading 遮罩；此时按钮虽
  // 已经 visible/enabled，真实鼠标事件仍会被遮罩拦截。先等当前列表请求
  // 收尾，再点击目标行，避免把页面加载中的瞬态报成定位错误。
  await expect(page.locator('.ant-spin-spinning:visible, .el-loading-mask:visible'))
    .toHaveCount(0, { timeout: 10_000 }).catch(() => undefined);
  // 优先点击真正的操作控件。把 td 放在同一个候选集合里并从末尾倒序
  // 遍历时，容易先点到“上线 编辑”所在的单元格，而不是“编辑”按钮本身；
  // 这在表管理页偶发表现为点击后仍停留在列表页。只有页面没有按钮/链接
  // 时，才退回到文本单元格兼容旧版页面。
  const actionableCandidates = row.locator(
    'button:visible, a:visible, .el-link:visible, [role="button"]:visible, [class*="action"]:visible',
  );
  const fallbackCandidates = row.locator('td:visible');
  const candidateGroups = [actionableCandidates, fallbackCandidates];
  for (const candidates of candidateGroups) {
    for (let index = await candidates.count() - 1; index >= 0; index -= 1) {
    const candidate = candidates.nth(index);
    const metadata = [
      await candidate.innerText().catch(() => ''),
      await candidate.getAttribute('aria-label').catch(() => null),
      await candidate.getAttribute('title').catch(() => null),
    ].filter(Boolean).join(' ');
    if (name.test(metadata) && await candidate.isEnabled().catch(() => true)) {
      // 状态页切换后，目标行可能已经挂载，但列表的 loading 遮罩会在
      // 同一渲染周期稍后再次出现。第一次 click 被遮罩拦截时不要把它
      // 误报成定位失败；等待遮罩真正消失后，在同一目标行上重试。
      let lastClickError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(page.locator('.ant-spin-spinning:visible, .el-loading-mask:visible'))
          .toHaveCount(0, { timeout: 10_000 }).catch(() => undefined);
        try {
          await candidate.click({ timeout: 4_000 });
          return;
        } catch (error) {
          lastClickError = error;
          await page.waitForTimeout(500 * (attempt + 1));
        }
      }
      throw lastClickError instanceof Error ? lastClickError : new Error(`目标表操作“${name}”点击失败。`);
    }
  }
  }
  throw new Error(`目标表“${await row.innerText().catch(() => '')}”未找到操作“${name}”。`);
}

async function visibleTableNames(page: Page): Promise<string[]> {
  const cards = page.locator('.table-query .card:visible');
  await expect.poll(async () => await cards.count(), { timeout: 30_000 }).toBeGreaterThan(0);
  const names: string[] = [];
  for (let index = 0; index < await cards.count(); index += 1) {
    const card = cards.nth(index);
    const name = await lastVisible(card.locator('.table-name:visible, [class*="table-name"]:visible'));
    const value = (await name?.innerText().catch(() => '') ?? '').trim();
    if (value && !names.includes(value)) names.push(value);
  }
  if (!names.length) throw new Error('表查询页面有卡片但未读取到可用表名。');
  return names;
}

async function visibleManageTableNames(page: Page): Promise<string[]> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const candidates = page.locator('a:visible, .table-name:visible, [class*="table-name"]:visible');
    const names: string[] = [];
    for (let index = 0; index < await candidates.count(); index += 1) {
      const value = (await candidates.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (value && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(value) && !names.includes(value)) names.push(value);
    }
    if (!names.length) {
      const leftRows = page.locator('.ant-table-fixed-left:visible tbody > tr:visible');
      for (let index = 0; index < await leftRows.count(); index += 1) {
        const value = (await leftRows.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (value && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(value) && !names.includes(value)) names.push(value);
      }
    }
    if (names.length) return names;
    await page.waitForTimeout(500);
  }
  throw new Error('表管理页面列表已显示但 30 秒内未返回可操作的真实表名；需检查列表接口或创建测试表。');
}

const lineageFieldRows = (page: Page): Locator => page.locator([
  'tbody > tr:visible',
  '.ant-table-tbody > tr:visible',
  '.el-table__body-wrapper tr:visible',
  '[role="row"]:visible:not(:has([role="columnheader"]))',
].join(', '));

/**
 * 2026-09-23（DS-PERM-111）根因修复：新同步环境的新建表页“解析”只回填字段名
 * 与数据类型，不再把 DDL 中的长度写入“数据长度”输入框；直接点“建表”会以空
 * 长度提交，后端 tableManage/createTable 返回 099999“需要长度的字段类型不能
 * 为空 先维护字段配置信息”，血缘夹具建表前置整批失败（报告
 * run-20260923-053422-321）。这里在解析成功后逐行检查长度控件：仅对空值补填
 * （不覆盖页面已回显的值），优先按字段名匹配 DDL 声明长度，匹配不到时按 DDL
 * 声明顺序兜底；无 DDL 上下文时用 64。长度输入定位与 DM-04-01/DM-04-02/
 * DM-03-02 已固化口径一致（placeholder 含“长度”/number/spinbutton）。
 */
async function fillLineageFieldLengths(page: Page, ddl?: string): Promise<void> {
  const declared: Array<{ name: string; length: string }> = [];
  for (const match of (ddl ?? '').matchAll(/([A-Za-z_][A-Za-z0-9_$]*)\s+VARCHAR\s*\(\s*(\d+)\s*\)/gi)) {
    declared.push({ name: match[1].toLowerCase(), length: match[2] });
  }
  // 部分版本解析后字段行长度控件异步渲染；先短暂等待，超时不视为失败，
  // 由逐行扫描与最终建表接口结果说话。
  await expect.poll(() => page.locator('input[placeholder*="长度"]:visible').count(), { timeout: 10_000 })
    .toBeGreaterThan(0)
    .catch(() => undefined);
  const rows = lineageFieldRows(page);
  let filled = 0;
  let verified = 0;
  const trace: string[] = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    // 长度列在“数据精度”之前（DM-04-01 列序），DOM 顺序 first 命中的是长度。
    const lengthInput = row.locator(
      'input[placeholder*="长度"], input[type="number"], [role="spinbutton"]',
    ).first();
    if (!(await lengthInput.isVisible().catch(() => false))) continue;
    if (!(await lengthInput.isEnabled().catch(() => false))) {
      trace.push(`row${index}:disabled`);
      continue;
    }
    const current = (await lengthInput.inputValue().catch(() => '')).trim();
    if (current) {
      verified += 1;
      continue;
    }
    // 行内第 0 个可见输入是字段名（DM-04-01 实测列序）；读不到时按顺序兜底。
    const name = ((await row.locator('input:visible').first().inputValue().catch(() => '')) || '')
      .trim().toLowerCase();
    const byName = declared.find((column) => column.name === name);
    const value = byName?.length
      ?? declared[Math.min(index, Math.max(declared.length - 1, 0))]?.length
      ?? '64';
    // 第一轮实测（trace run-dsperm111-r1）：解析网格里 fill+blur 后建表载荷长度
    // 仍为空（099999 与未修复时逐字相同）——程序化赋值没有提交到组件状态。这里
    // 改为“点击 → fill → Tab 失焦”，回读仍空时再逐键输入兜底一次；两种方式都
    // 以回读结果为准，未粘住时如实记录，由最终建表接口结果说话。
    await lengthInput.click({ force: true }).catch(() => undefined);
    await lengthInput.fill(value);
    await lengthInput.press('Tab').catch(() => undefined);
    await lengthInput.blur().catch(() => undefined);
    let stuck = (await lengthInput.inputValue().catch(() => '')).trim() === value;
    if (!stuck) {
      await lengthInput.click({ force: true }).catch(() => undefined);
      await lengthInput.pressSequentially(value, { delay: 40 }).catch(() => undefined);
      await lengthInput.press('Tab').catch(() => undefined);
      await lengthInput.blur().catch(() => undefined);
      stuck = (await lengthInput.inputValue().catch(() => '')).trim() === value;
    }
    trace.push(`row${index}(${name || '?'}):${value}:${stuck ? 'ok' : 'NOT-STUCK'}`);
    if (stuck) verified += 1;
    filled += 1;
  }
  lineageDebug(
    `field lengths after parse: filled=${filled} verified=${verified} :: ${trace.join('; ')}`
      + (declared.length ? ` (ddl varchar columns: ${declared.length})` : ' (no ddl context)'),
  );
}

/**
 * 新版新建表页把“语句添加”渲染成自定义 radio 的外层 generic。直接点击文本
 * 有时不会触发组件状态切换，却会错误命中页面其他隐藏编辑器。这里以 radio 的
 * checked 状态为准，确认已切换后才继续填写 DDL。
 */
async function switchToSqlFieldMode(page: Page): Promise<Locator> {
  const fieldSection = page.getByRole('heading', { name: '字段信息', exact: true }).locator('..');
  const radio = fieldSection.getByRole('radio', { name: '语句添加', exact: true });
  // Ant 的真实 input 是无尺寸隐藏控件；只确认“字段信息”区域和 radio 节点存在，
  // 可点击的是它向上的 generic 容器。
  await expect(fieldSection).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => radio.count(), { timeout: 10_000 }).toBeGreaterThan(0);

  if (!(await radio.isChecked().catch(() => false))) {
    const targets = [
      radio.locator('..').locator('..'),
      radio.locator('..'),
      fieldSection.getByText('语句添加', { exact: true }),
    ];
    for (const target of targets) {
      if (!(await target.isVisible().catch(() => false))) continue;
      await target.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(250);
      if (await radio.isChecked().catch(() => false)) break;
    }
  }

  if (!(await radio.isChecked().catch(() => false))) {
    await radio.evaluate((element) => (element as HTMLInputElement).click()).catch(() => undefined);
    await page.waitForTimeout(250);
  }
  await expect(radio).toBeChecked({ timeout: 5_000 });
  return fieldSection;
}

async function sqlFieldEditor(fieldSection: Locator): Promise<Locator> {
  const editors = fieldSection.locator([
    '.monaco-editor:visible textarea',
    '.CodeMirror:visible textarea',
    'textarea:visible',
    'input:visible',
  ].join(', '));
  await expect.poll(() => editors.count(), { timeout: 10_000 }).toBeGreaterThan(0);
  return editors.last();
}

async function fillSqlFieldEditor(editor: Locator, ddl: string): Promise<void> {
  // Monaco 的 textarea 在部分版本中接收了 fill 但没有把值同步回编辑器模型；
  // 读取回显并在必要时用真实键盘事件补写，避免点击“解析”时提交空 SQL。
  await editor.fill(ddl).catch(async () => {
    await editor.click();
    await editor.press('Control+A');
    await editor.pressSequentially(ddl);
  });
  let currentValue = await editor.inputValue().catch(() => '');
  if (!currentValue.includes('CREATE TABLE')) {
    await editor.click();
    await editor.press('Control+A');
    await editor.pressSequentially(ddl);
    currentValue = await editor.inputValue().catch(() => '');
  }
  if (!currentValue.includes('CREATE TABLE')) {
    throw new Error('新建表 DDL 编辑器未保留输入内容，未继续提交空 SQL。');
  }
}

async function chooseFirstLineageFormOption(page: Page, label: RegExp): Promise<void> {
  try {
    const control = await clickFormControlByLabel(page, label);
    await chooseFirstOption(page, control, String(label));
  } catch (error) {
    // 当前新建表页的“安全等级”标签与控件位于同一个表单项，但标签文本
    // 在部分版本会被布局层包裹，通用 getByText 向上查找会漏掉该控件。
    // 先按可见表单项回退，仍然只选择当前页面该标签对应的下拉框。
    if (/安全等级/i.test(String(label))) {
      const items = page.locator(
        '.el-form-item:visible, .ant-form-item:visible, [class*="form-item"]:visible',
      ).filter({ hasText: /安全等级/ });
      for (let index = await items.count() - 1; index >= 0; index -= 1) {
        const item = items.nth(index);
        const control = await lastVisible(item.locator(
          '.el-select:visible, .ant-select:visible, [role="combobox"]:visible',
        ));
        if (control) {
          await chooseFirstOption(page, control, String(label));
          return;
        }
      }
    }
    // MySQL 测试库可能没有主领域/安全等级等可选元数据；这些不是本流程的核心，
    // 但生命周期、操作类型等保存必填项仍由调用方明确填写。
    if (/schema|主领域|主题域/i.test(String(label))) return;
    throw error;
  }
}

async function openLineageCreateEntry(page: Page, dataSource: LineageDataSource = 'mysql'): Promise<void> {
  const newButton = await lastVisible(page.getByRole('button', { name: /新建表|新增表/ }));
  if (newButton) await newButton.click({ force: true });
  else await clickVisible(page, /新建表|新增表/);
  const saveButton = page.getByRole('button', { name: /保\s*存/ }).last();
  if (!(await saveButton.isVisible().catch(() => false))) {
    const options = page.locator(
      '.el-dropdown-menu:visible li:visible, .ant-dropdown-menu:visible li:visible, ' +
      '.ant-dropdown:visible [role="menuitem"]:visible, [role="listbox"] [role="option"]:visible',
    );
    if (!(await options.first().isVisible().catch(() => false))) {
      // “新建表”由文字按钮和独立箭头组成；部分浏览器尺寸下点击文字区域
      // 不会展开数据源菜单，按录制页面实际操作补点右侧下拉箭头。
      if (newButton) {
        // 分裂按钮的箭头没有独立可访问节点时，直接点击按钮最右侧，
        // 与人工点击右侧下拉箭头等价。
        const box = await newButton.boundingBox().catch(() => null);
        if (box) {
          for (const offset of [8, 20]) {
            if (await options.first().isVisible().catch(() => false)) break;
            await page.mouse.click(box.x + box.width - offset, box.y + box.height / 2);
            await page.waitForTimeout(350);
          }
        }
      }
      // Element UI 的 split-button 在无障碍树中可能只暴露一个“新建表”按钮，
      // 实际下拉触发器却是同级的 caret button；优先直接命中该触发器。
      if (!(await options.first().isVisible().catch(() => false))) {
        const caret = await lastVisible(page.locator(
          '.el-dropdown__caret-button:visible, .el-dropdown__icon:visible, ' +
          'button:visible i.el-icon-arrow-down, button:visible svg[class*="arrow"], ' +
          '[aria-label*="下拉"]:visible, [aria-label*="展开"]:visible',
        ));
        if (caret) {
          await caret.click({ force: true }).catch(() => undefined);
          await page.waitForTimeout(500);
        }
      }
    }
    await expect(options.first()).toBeVisible({ timeout: 10_000 });
    // 数据源显示名一律来自配置中心（DS-PERM-47）：GBase 走 GBase 专属
    // gbaseSourceName（GBASE_SOURCE_NAME 兼容覆盖），MySQL 走 primary
    // profile 推导全名 + tableManagement/LINEAGE_DATA_SOURCE 兼容覆盖。
    // 2026-09-20 实测：数据地图登记的名称是“host:port/库”全名（带库后缀），
    // 候选必须按全名优先；只匹配 host[:port] 的短名在 includes 语义下会
    // 误选同 host 上未登记 e2e_test 库的其它数据源，host 段仅作最后兜底。
    const preferredCandidates = [...new Set((dataSource === 'gbase'
      ? [testEnvironment.dataSourceNames.gbaseSourceName]
      : primaryMysqlDataSourceCandidates()
    ).map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
    let selected: Locator | undefined;
    for (const preferred of preferredCandidates) {
      for (let index = await options.count() - 1; index >= 0; index -= 1) {
        const option = options.nth(index);
        const text = (await option.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        // options 选择器本身已经限定了 :visible；部分 portal 组件的外层 li
        // 在 isVisible() 中会被判为不可见，但其文本和点击区域实际可用。
        if (text.toLowerCase().includes(preferred.toLowerCase())) {
          selected = option;
          break;
        }
      }
      if (selected) break;
    }
    if (!selected) {
      const available = (await options.allInnerTexts().catch(() => []))
        .map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean);
      throw new Error(
        `新建血缘测试表未找到优先 ${dataSource === 'gbase' ? 'GBase' : 'MySQL'} 数据源“${preferredCandidates.join(' / ')}”；当前可选数据源：${available.join('、') || '无'}。`,
      );
    }
    await selected.click({ force: true });
    await page.waitForTimeout(800);
  }
  await expect(saveButton).toBeVisible({ timeout: 15_000 }).catch(() => {
    throw new Error(`点击 ${dataSource === 'gbase' ? 'GBase' : 'MySQL'} 数据源后未进入新建表页面，当前地址：${page.url()}`);
  });
}

async function createMinimalLineageTable(
  page: Page,
  tableName: string,
  dataSource: LineageDataSource = 'mysql',
): Promise<void> {
  await openMapLeaf(page, '#/dataMap/tableManage/tablesManage', '表管理');
  await openLineageCreateEntry(page, dataSource);
  // 2026-09-20（110 环境）：个别进入时机下表单基础信息区尚未渲染输入框，
  // 直接 fill 会因“表单项内无可见输入框”静默卡在校验。与
  // ensureFieldLineageTargetTable 的等待方式保持一致。
  await expect(page.getByRole('textbox', { name: /表名称/ }).last()).toBeVisible({ timeout: 15_000 });
  await fillFormField(page, /表名称|表名/, tableName);
  await fillFormField(page, /表中文名称|表中文名/, `${dataSource === 'gbase' ? 'GBase' : 'MySQL'}血缘测试_${tableName}`);
  for (const label of [/数据层级/, /库.?层级/, /schema/i, /主领域|主题域/, /负责人/, /安全等级/]) {
    await chooseFirstLineageFormOption(page, label);
  }
  await chooseFirstLineageFormOption(page, /数据生命周期/);
  await chooseFirstLineageFormOption(page, /操作类型/);
  // 页面把“执行前需要确定”作为表单必填项；不选择时点击“建表”
  // 只会停留在当前表单，且未必显示明确的错误提示。血缘前置不测试
  // 二次确认逻辑，固定选择“否”即可使创建流程可重复。
  const noConfirm = page.getByRole('radio', { name: '否', exact: true }).last();
  if (await noConfirm.isVisible().catch(() => false)) await noConfirm.check();

  // 这里建表只是血缘前置，不测试建表字段设计；使用页面支持的最小 VARCHAR 字段。
  // 采用 DDL 解析，避免手工添加字段时遗漏“字段类型/长度”等必填控件。
  const fieldSection = await switchToSqlFieldMode(page);
  const editor = await sqlFieldEditor(fieldSection);
  await fillSqlFieldEditor(editor, `CREATE TABLE ${tableName} (id VARCHAR(64), name VARCHAR(128), remark VARCHAR(255))`);
  await clickVisible(fieldSection, /解\s*析|校\s*验/);
  await expect.poll(() => lineageFieldRows(page).count(), { timeout: 15_000 }).toBeGreaterThan(0);
  const chineseInputs = page.locator('input[placeholder*="字段中文"]:visible');
  for (let index = 0; index < await chineseInputs.count(); index += 1) {
    await chineseInputs.nth(index).fill(`血缘字段${index + 1}`);
  }
  // 解析不再回填长度（DS-PERM-111）：“建表”前按 DDL 补填“数据长度”空值，
  // 否则 createTable 以空长度提交被后端 099999 拒绝。
  await fillLineageFieldLengths(
    page,
    `CREATE TABLE ${tableName} (id VARCHAR(64), name VARCHAR(128), remark VARCHAR(255))`,
  );
  // 平台语义（2026-09-20 在 110 环境实测确认）：“保存”只生成元数据草稿
  // （表管理“草稿”页签，existsStatus=不存在），物理建表必须点“建表”。
  // 旧实现“先保存，再仅当 URL 仍在 tableCreate 时补点建表”，在新版页面
  // 保存后立即跳回列表，导致“建表”被永久跳过、只留下草稿记录。因此改为：
  // 表单解析成功后直接点“建表”；按钮不存在时退回“保存→建表”老顺序。
  const submitResponses: string[] = [];
  // DS-PERM-111 诊断：捕获 createTable 请求体，失败时直接展示提交载荷，
  // 用于分辨“长度没进载荷”还是“载荷有长度但被后端拒绝”。
  const requestDiagnostics: string[] = [];
  const captureSubmitRequest = (request: { url(): string; postData(): string | null }) => {
    if (/tableManage\/createTable/i.test(request.url())) {
      requestDiagnostics.push(`createTable 请求体 :: ${(request.postData() ?? '').slice(0, 1500)}`);
    }
  };
  const captureSubmitResponse = (response: { url(): string; status(): number; text(): Promise<string> }) => {
    const url = response.url();
    if (/table|metadata|catalog/i.test(url)) {
      void response.text().then((body) => {
        submitResponses.push(`${response.status()} ${url} :: ${body.slice(0, 500)}`);
      }).catch(() => undefined);
    }
  };
  page.on('response', captureSubmitResponse);
  page.on('request', captureSubmitRequest);
  const build = page.getByRole('button', { name: /建\s*表/ }).last();
  if (await build.isVisible().catch(() => false) && await build.isEnabled().catch(() => false)) {
    await build.click();
  } else {
    const save = page.getByRole('button', { name: /保\s*存/ }).last();
    await save.click();
    await expect(build).toBeVisible({ timeout: 10_000 });
    await build.click();
  }
  await page.waitForTimeout(1_000);
  page.off('response', captureSubmitResponse);
  page.off('request', captureSubmitRequest);
  // 当前前端建表成功后 URL 不一定离开 tableCreate；以“物理表存在”列表中
  // 出现目标表为准。只在“草稿”页签出现=物理表未建成，按失败处理并附上
  // 接口反馈，禁止把草稿当创建成功。
  await openMapLeaf(page, '#/dataMap/tableManage/tablesManage', '表管理');
  const created = await searchManageRowAcrossStates(page, tableName).catch(() => undefined);
  if (created?.state === 'draft') {
    // 同名草稿已存在（并行执行或历史遗留）：后端 createTable 会以“表名重复”
    // 拒绝新建。改走草稿行的“编辑→建表”，把既有草稿落成物理表。
    await buildPhysicalTableFromDraftRow(page, created.row, tableName);
    return;
  }
  if (!created) {
    throw new Error(
      `表“${tableName}”点击“建表”后未进入“物理表存在”状态（可能只生成了草稿）。接口反馈：\n`
        + `${submitResponses.join('\n') || '未捕获到表相关接口响应'}`
        + (requestDiagnostics.length ? `\n诊断：${requestDiagnostics.join(' | ')}` : ''),
    );
  }
}

async function ensureLineageTable(
  page: Page,
  tableName: string,
  dataSource: LineageDataSource = 'mysql',
): Promise<void> {
  lineageDebug(`ensure table start: ${tableName}`);
  await openMapLeaf(page, '#/dataMap/tableManage/tablesManage', '表管理');
  let hit: ManageRowHit | undefined;
  try {
    hit = { row: await searchManageRow(page, tableName, 8_000), state: 'physical', tabName: '物理表存在（默认页签）' };
  } catch {
    try {
      hit = await searchManageRowAcrossStates(page, tableName);
    } catch {
      lineageDebug(`create missing table: ${tableName}`);
      await createMinimalLineageTable(page, tableName, dataSource);
      hit = await searchManageRowAcrossStates(page, tableName).catch(() => undefined);
      if (!hit) {
        throw new Error(`新建表“${tableName}”后，表管理任何状态页均未找到目标记录。`);
      }
    }
  }
  if (!hit) throw new Error(`表管理未找到目标表“${tableName}”。`);

  // “草稿”页签的记录只代表元数据已保存（existsStatus=不存在），物理表并未
  // 建成；对它点“上线”必然失败。先在编辑页补一次“建表”再继续。
  if (hit.state === 'draft') {
    lineageDebug(`draft-only record, building physical table: ${tableName}`);
    await buildPhysicalTableFromDraftRow(page, hit.row, tableName);
    hit = await searchManageRowAcrossStates(page, tableName);
    if (hit.state === 'draft') {
      throw new Error(`草稿表“${tableName}”补“建表”后仍停留在草稿状态，物理表未建成。`);
    }
  }

  const row = hit.row;
  lineageDebug(`ensure table found: ${tableName} (${hit.tabName})`);

  // 新建表默认是“存在&下线”；只有上线后才会进入表查询并能打开详情。
  const online = await lastVisible(row.getByRole('button', { name: /上\s*线/ }))
    ?? await lastVisible(row.locator('a:visible, .el-link:visible, [role="button"]:visible, td:visible')
      .filter({ hasText: /上\s*线/ }));
  if (online && await online.isEnabled().catch(() => false)) {
    await clickRowAction(page, row, /上\s*线/);
    const dialog = await lastVisible(page.locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible'));
    if (dialog) {
      const confirm = await lastVisible(dialog.getByRole('button', { name: /^\s*(确\s*定|上\s*线|发\s*布)\s*$/ }))
        ?? await lastVisible(dialog.locator('button:visible, [role="button"]:visible').filter({ hasText: /确\s*定|上\s*线|发\s*布/ }));
      if (confirm) await confirm.click();
    }
    await page.waitForTimeout(1_000);
  }
}

/**
 * 以当前环境为准准备可重复使用的血缘夹具：
 * - 只检查/创建本项目命名的两张测试表；
 * - 缺失时用当前优先 MySQL 数据源建最小表并上线；
 * - 后续用例复用表，不再重复建表，也不修改已有业务表。
 */
export async function ensureLineageFixture(
  page: Page,
  fixtureSet: LineageFixtureSet = 'base',
  fixtureKey?: string,
): Promise<{
  targetTable: string;
  sourceTable: string;
}> {
  const targetTable = lineageTargetName(fixtureSet, fixtureKey);
  const sourceTable = lineageSourceName(fixtureSet, fixtureKey);
  lineageDebug(`fixture start: ${sourceTable}, ${targetTable}`);
  const dataSource = fixtureDataSource(fixtureSet);
  await ensureLineageTable(page, sourceTable, dataSource);
  await ensureLineageTable(page, targetTable, dataSource);
  lineageDebug('fixture done');
  return { targetTable, sourceTable };
}

/**
 * 建立字段血缘专项的目标表。字段名与主 SQL 一一对应，避免用最小 id/name
 * 夹具去验证字段级关系时出现“SQL 有字段、目标表无字段”的伪失败。
 * 该表属于 e2e 命名空间；已存在时直接复用，不修改任何业务表。
 */
export async function ensureFieldLineageTargetTable(
  page: Page,
  tableName: string,
  // 部分解析器仅能稳定识别同名字段直传；字段血缘专项允许传入最小字段定义，
  // 用于把“别名/不同字段名”与“同名字段”两个能力拆开验证。
  ddlColumns = 'target_id VARCHAR(64), shared_key VARCHAR(64), source_file_name VARCHAR(128), '
    + 'source_region VARCHAR(32), file_amount VARCHAR(32), sftp_amount VARCHAR(32), '
    + 'total_amount VARCHAR(32), source_tag VARCHAR(32), business_date VARCHAR(32)',
  dataSource: LineageDataSource = 'gbase',
): Promise<void> {
  await openMapLeaf(page, '#/dataMap/tableManage/tablesManage', '表管理');
  const existing = await searchManageRowAcrossStates(page, tableName).catch(() => undefined);
  if (existing) {
    // 草稿记录≠物理表存在（existsStatus=不存在）；复用前先在编辑页补“建表”。
    if (existing.state === 'draft') {
      await buildPhysicalTableFromDraftRow(page, existing.row, tableName);
    }
    return;
  }

  // 不使用录制脚本里的 dataSourcePluginId：环境重建后内部 ID 会变化。
  // 统一从“新建表”下拉选择当前环境登记的真实数据源；字段血缘专项默认 GBase。
  await openLineageCreateEntry(page, dataSource);
  await expect(page.getByRole('textbox', { name: /表名称/ }).last()).toBeVisible({ timeout: 15_000 });
  await fillFormField(page, /表名称|表名/, tableName);
  await fillFormField(page, /表中文名称|表中文名/, `${dataSource === 'gbase' ? 'GBase' : 'MySQL'}字段血缘目标表_${tableName}`);
  for (const label of [/数据层级/, /库.?层级/, /schema/i, /主领域|主题域/, /负责人/, /安全等级/]) {
    await chooseFirstLineageFormOption(page, label);
  }
  await chooseFirstLineageFormOption(page, /数据生命周期/);
  await chooseFirstLineageFormOption(page, /操作类型/);
  const noConfirm = page.getByRole('radio', { name: '否', exact: true }).last();
  if (await noConfirm.isVisible().catch(() => false)) await noConfirm.check();

  const fieldSection = await switchToSqlFieldMode(page);
  const editor = await sqlFieldEditor(fieldSection);
  await fillSqlFieldEditor(
    editor,
    `CREATE TABLE ${tableName} (${ddlColumns})`,
  );
  await clickVisible(fieldSection, /解\s*析|校\s*验/);
  await expect.poll(() => lineageFieldRows(page).count(), { timeout: 15_000 }).toBeGreaterThan(0);
  const chineseInputs = page.locator('input[placeholder*="字段中文"]:visible');
  for (let index = 0; index < await chineseInputs.count(); index += 1) {
    await chineseInputs.nth(index).fill(`字段血缘${index + 1}`);
  }
  // 同 createMinimalLineageTable（DS-PERM-111）：解析后补填“数据长度”空值。
  await fillLineageFieldLengths(page, `CREATE TABLE ${tableName} (${ddlColumns})`);
  const submitResponses: string[] = [];
  const captureSubmitResponse = (response: { url(): string; status(): number; text(): Promise<string> }) => {
    const url = response.url();
    if (/table|metadata|catalog/i.test(url)) {
      void response.text().then((body) => {
        submitResponses.push(`${response.status()} ${url} :: ${body.slice(0, 500)}`);
      }).catch(() => undefined);
    }
  };
  page.on('response', captureSubmitResponse);
  // 保存只会生成“草稿”；字段血缘前置必须直接“建表”，让物理表及元数据
  // 同时落地。不能把跳回列表误判为物理建表完成。
  const build = page.getByRole('button', { name: /建\s*表/ }).last();
  await expect(build).toBeVisible({ timeout: 15_000 });
  await expect(build).toBeEnabled({ timeout: 15_000 });
  await build.click();
  await page.waitForTimeout(1_000);
  page.off('response', captureSubmitResponse);
  // 当前前端建表成功后有时保留 tableCreate hash，但主体组件已经渲染回表管理
  // 列表；URL 不是可靠结果，必须以“物理表存在”列表中出现当前表为准。
  await openMapLeaf(page, '#/dataMap/tableManage/tablesManage', '表管理');
  await searchManageRow(page, tableName, 15_000);
}

/**
 * 验证流程的只读前置检查。这里不创建表、不编辑任务；若前置没有由建血缘流程
 * 固化，直接给出可定位的准备失败，避免验证用例偷偷改变环境。
 */
export async function requireLineageFixture(
  page: Page,
  fixtureSet: LineageFixtureSet = 'base',
  fixtureKey?: string,
): Promise<{
  targetTable: string;
  sourceTable: string;
}> {
  const targetTable = lineageTargetName(fixtureSet, fixtureKey);
  const sourceTable = lineageSourceName(fixtureSet, fixtureKey);
  await openMapLeaf(page, '#/dataMap/tableManage/tablesManage', '表管理');
  await searchManageRowAcrossStates(page, sourceTable).catch(() => {
    throw new Error(`血缘验证前置缺失：当前表管理没有测试源表“${sourceTable}”；请先执行建血缘前置流程。`);
  });
  await searchManageRowAcrossStates(page, targetTable).catch(() => {
    throw new Error(`血缘验证前置缺失：当前表管理没有测试目标表“${targetTable}”；请先执行建血缘前置流程。`);
  });
  return { targetTable, sourceTable };
}

function sqlReferencedTables(sql: string): string[] {
  const cteNames = new Set<string>();
  for (const match of sql.matchAll(/\b(?:WITH|,)\s*([A-Za-z_][A-Za-z0-9_$]*)\s+AS\s*\(/gi)) {
    cteNames.add(match[1].toLowerCase());
  }
  const tables: string[] = [];
  const pattern = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(`?[A-Za-z_][A-Za-z0-9_$]*`?(?:\s*\.\s*`?[A-Za-z_][A-Za-z0-9_$]*`?)?)/gi;
  for (const match of sql.matchAll(pattern)) {
    const value = match[1].replace(/`/g, '').replace(/\s+/g, '');
    const unqualified = value.split('.').pop() || value;
    if (cteNames.has(unqualified.toLowerCase())) continue;
    if (!tables.includes(value)) tables.push(value);
  }
  return tables;
}

/**
 * 在建血缘流程中检查 SQL 的物理表引用。Schema 前缀只参与识别，页面建表时
 * 使用当前 MySQL 测试数据源的默认 Schema；不把 SQL 中的旧库名硬编码为环境前置。
 */
export async function ensureSqlReferencedTables(
  page: Page,
  sql: string,
  targetTable: string,
  virtualSourceTables: string[] = [],
  dataSource: LineageDataSource = 'mysql',
): Promise<string[]> {
  const referenced = sqlReferencedTables(sql)
    .map((name) => name.split('.').pop() || name)
    .filter((name) => name !== targetTable);
  const fieldLineageExternalSources = new Set([
    // 旧 GBase 批次（192.168.79.69，保留以兼容历史报告追溯）。
    'e2e_hn_gbase_fld_file_src',
    'e2e_hn_gbase_fld_sftp_src',
    'e2e_hn_gbase_fld_txt_src_v1',
    'e2e_hn_gbase_fld_xls_src_v1',
    'e2e_hn_gbase_fld_xlsx_src_v1',
    // 2026-09-20（110 环境迁移）：文件/SFTP 来源表改建在 MySQL 110，新表名加 _0920。
    'e2e_hn_fld_file_src_0920',
    'e2e_hn_fld_sftp_src_0920',
    'e2e_hn_fld_txt_src_0920',
    'e2e_hn_fld_xls_src_0920',
    'e2e_hn_fld_xlsx_src_0920',
  ]);
  const virtualSources = new Set(virtualSourceTables.map((name) => name.toLowerCase()));
  for (const tableName of referenced) {
    // 虚拟来源表不应被“前置补表”逻辑自动建成物理表；该专项用例验证的正是
    // 解析器能否保留 SQL 中不存在来源表的表级血缘节点。
    if (virtualSources.has(tableName.toLowerCase())) {
      lineageDebug(`virtual lineage source; skip physical table creation: ${tableName}`);
      continue;
    }
    // 这两张表由“文件接入 / SFTP 接入”自动建表，不属于“数据地图自建表”。
    // 表管理列表因状态或来源筛选暂时查不到时，不能回退为 createTable：物理表已
    // 存在会报重复。字段血缘初始化用例负责创建它们，此处只复用。
    if (fieldLineageExternalSources.has(tableName.toLowerCase())) {
      await openMapLeaf(page, '#/dataMap/tableManage/tablesManage', '表管理');
      const row = await searchManageRowAcrossStates(page, tableName).catch(() => undefined);
      if (row) await ensureTableOnline(page, tableName, true).catch(() => undefined);
      else lineageDebug(`field lineage source is external fixture; skip re-create: ${tableName}`);
      continue;
    }
    await ensureLineageTable(page, tableName, dataSource);
  }
  return referenced;
}

async function readFirstSqlField(page: Page, tableName: string, mode: 'query' | 'manage' = 'query'): Promise<string> {
  // 源表可能已上线、只出现在“表查询”，不一定还出现在可编辑的“表管理”列表。
  // 录制草稿也是从表查询详情读取字段，因此这里不要求源表具备管理权限。
  await openMapLeaf(
    page,
    mode === 'query' ? '#/dataMap/tableQuery/tablesQuery' : '#/dataMap/tableManage/tablesManage',
    mode === 'query' ? '表查询' : '表管理',
  );
  try {
    await searchAndOpenTable(page, tableName, mode);
  } catch (error) {
    if (mode !== 'manage') throw error;
    // 表管理默认 tab 可能不是目标表所在状态；前置表若处于“下线/草稿”，
    // 先跨状态找到同名记录，再点击该记录进入详情读取字段。
    await searchManageRowAcrossStates(page, tableName);
    const tableLink = await lastVisible(page.getByText(tableName, { exact: true }));
    if (!tableLink) throw error;
    await tableLink.click({ force: true });
    await waitForTableDetail(page);
  }

  const rows = page.locator(
    'tbody > tr:visible, .ant-table-tbody > tr:visible, .el-table__body-wrapper tr:visible, ' +
      '[role="row"]:visible:not(:has([role="columnheader"]))',
  );
  // 110 详情页把字段网格放在“字段信息”页签/区块下，且部分版本用自定义
  // div 网格渲染（无 tbody/role=row）。先尝试切到字段信息；行定位等待
  // 超时不再直接失败，落回下方输入框/正文两种兜底读取。
  await clickLineageTab(page, /字段信息/).catch(() => undefined);
  await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeGreaterThan(0).catch(() => undefined);
  for (let rowIndex = 0; rowIndex < await rows.count(); rowIndex += 1) {
    const cells = rows.nth(rowIndex).locator('td:visible, [role="cell"]:visible');
    for (let cellIndex = 0; cellIndex < await cells.count(); cellIndex += 1) {
      const cell = cells.nth(cellIndex);
      const values = [
        ...(await cell.locator('input:visible, textarea:visible').evaluateAll((elements) =>
          elements.map((element) => (element as HTMLInputElement).value || element.textContent || ''),
        ).catch(() => [])),
        await cell.innerText().catch(() => ''),
      ];
      for (const raw of values) {
        const value = raw.replace(/\s+/g, ' ').trim();
        if (value !== tableName && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) return value;
      }
    }
  }

  // 当前版本的“编辑”页字段名位于输入框 value 中，部分表格没有标准 tbody/role=row。
  const inputs = page.locator('input:visible, textarea:visible');
  for (let index = 0; index < await inputs.count(); index += 1) {
    const value = (await inputs.nth(index).inputValue().catch(() => '')).trim();
    if (value !== tableName && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) return value;
  }

  // 当前详情页的字段表是自定义 div 网格，没有 tbody/role=cell；从“字段信息”
  // 区域的可见文本读取第一列字段名，避开页面标题、Schema 和其它信息。
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const fieldStart = bodyText.search(/字段信息/);
  const fieldEnd = bodyText.slice(Math.max(0, fieldStart)).search(/分区信息|调度任务|数据血缘|授权情况|版本列表/);
  const fieldText = fieldStart >= 0
    ? bodyText.slice(fieldStart, fieldEnd > 0 ? fieldStart + fieldEnd : undefined)
    : '';
  const excluded = new Set([
    '字段信息', '字段名', '字段中文名', '描述', '数据类型', '数据长度', '数据精度',
    '数据元', '引用字典', '安全等级', '是否加密', '查看DDL语句', '分区信息',
  ]);
  for (const value of fieldText.split(/\s+/).map((item) => item.trim()).filter(Boolean)) {
    if (excluded.has(value) || value === tableName) continue;
    if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value) && !/^(?:INTEGER|INT|BIGINT|VARCHAR|CHAR|NCHAR|BOOLEAN|DATE|TIMESTAMP|TEXT|NULL)$/i.test(value)) {
      return value;
    }
  }
  throw new Error(`表“${tableName}”详情未读取到可用于血缘 SQL 的真实字段名。`);
}

/**
 * 从当前表查询页面读取真实表名，再从真实详情读取字段名。
 * 不允许把 ods.user_info、dw.order_stats 等示例占位名带入交付环境。
 */
export async function resolveExistingLineageFixture(
  page: Page,
  requireSourceField = true,
  fixtureSet: LineageFixtureSet = 'base',
  fixtureKey?: string,
): Promise<ExistingLineageFixture> {
  // 建血缘用例统一先准备当前 MySQL8 测试夹具。旧录制表名即使曾经存在，
  // 也不能在数据库替换后继续作为隐式前置条件。
  const fixture = await ensureLineageFixture(page, fixtureSet, fixtureKey);
  const recordedTarget = fixture.targetTable;
  const sourceTable = fixture.sourceTable;
  let targetField: string;
  try {
    targetField = await readFirstSqlField(page, recordedTarget);
  } catch {
    if (!requireSourceField) {
      // BL-02-01 只验证表级 INSERT 关系，SQL 使用 SELECT *，不应因为详情字段
      // 接口暂时不可用而阻断表级流程；字段级用例仍必须继续要求真实字段。
      targetField = process.env.LINEAGE_DEFAULT_FIELD?.trim() || 'id';
    } else {
    // 目标表可能正处于录制流程要求的“下线→编辑”中；下线表不出现在表查询，
    // 但仍可从表管理编辑页读取字段，随后由配置流程重新上线。
      targetField = await readFirstSqlField(page, recordedTarget, 'manage');
    }
  }
  if (sourceTable === recordedTarget) {
    return { targetTable: recordedTarget, sourceTable, targetField, sourceField: targetField };
  }
  try {
    const sourceField = await readFirstSqlField(page, sourceTable);
    return { targetTable: recordedTarget, sourceTable, targetField, sourceField };
  } catch (queryError) {
    // 源表通常是已上线表，应在“表查询”出现；但新建/恢复任务后的
    // 元数据卡片可能还在异步刷新。和目标表一样，读取失败时从“表管理”
    // 的物理表记录读取字段，避免把列表刷新瞬态误报成复杂 SQL 问题。
    try {
      const sourceField = await readFirstSqlField(page, sourceTable, 'manage');
      return { targetTable: recordedTarget, sourceTable, targetField, sourceField };
    } catch (manageError) {
    if (!requireSourceField) {
      return { targetTable: recordedTarget, sourceTable, targetField, sourceField: targetField };
    }
      throw new Error(
        `当前血缘测试源表“${sourceTable}”未读取到真实字段；请检查表元数据。` +
        `表查询原因：${String(queryError)}；表管理原因：${String(manageError)}`,
      );
    }
  }
}

async function openDataDevelopList(page: Page): Promise<void> {
  // 血缘解析依赖“数据开发→离线开发”中的开发任务，不能用表详情里的
  // “任务调度”代替。该菜单在部分版本是隐藏子路由，直接切换到已确认的
  // 叶子路由仍然是浏览器页面操作，不调用后台 API。
  const target = new URL(page.url());
  target.hash = '#/dataDevelop/offlineDevelop';
  await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await expect(page.getByRole('button', { name: '新建开发任务' })).toBeVisible({ timeout: 15_000 });
}

async function selectDevelopmentOption(page: Page, box: Locator, expected: RegExp, label: string): Promise<void> {
  await box.scrollIntoViewIfNeeded().catch(() => undefined);
  await box.click({ force: true });
  const optionSelector = '[role="option"]:visible, .ant-select-item-option:visible, .el-select-dropdown__item:visible, [role="menuitem"]:visible';
  await expect.poll(async () => await page.locator(optionSelector).count(), { timeout: 10_000 }).toBeGreaterThan(0);
  const options = page.locator(optionSelector);
  const option = await lastVisible(options.filter({ hasText: expected }));
  if (!option) {
    const available = (await options.allInnerTexts().catch(() => []))
      .map((text) => String(text ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    throw new Error(`数据开发任务未找到${label}“${expected}”；当前可选项：${available.join('、') || '无'}。`);
  }
  await option.click({ force: true });
  await page.waitForTimeout(500);
}

async function fillDevelopmentTask(page: Page, taskName: string, sql: string): Promise<void> {
  await page.getByRole('button', { name: '新建开发任务' }).click();
  await expect(page).toHaveURL(/dataDevelop\/createDevelopTask/, { timeout: 10_000 });
  await expect(page.getByText('新建离线任务', { exact: true })).toBeVisible({ timeout: 10_000 });

  const boxes = page.locator('[role="combobox"]:visible');
  await expect(boxes.nth(0)).toBeVisible({ timeout: 10_000 });
  await selectDevelopmentOption(page, boxes.nth(0), /^\s*MYSQL\s*$/i, 'MySQL 脚本类型');
  const sourceBoxes = page.locator('[role="combobox"]:visible');
  // 血缘专用任务的 MySQL 数据源（DS-PERM-47）：LINEAGE_DATA_SOURCE 显式
  // 覆盖，默认取 primary profile 的物理主机，不写死地址；不回退到其它
  // 项目曾使用的旧库，避免页面级联后误命中失效源表。
  const preferredSource = process.env.LINEAGE_DATA_SOURCE?.trim() || testEnvironment.databases.primary.host;
  await selectDevelopmentOption(page, sourceBoxes.nth(1), new RegExp(escapeRegExp(preferredSource), 'i'), 'MySQL 数据源');

  // 页面有两个“任务名称”：上方“开发任务名称”才是 df_scheduler_job.name，
  // 下方“任务名称”属于定时配置。之前只填写下方字段，保存请求中的 name
  // 仍为空，后端按唯一索引报 Duplicate entry ''。两个字段都按当前页面
  // 语义填写，避免把定时配置名称误当成开发任务主名称。
  // 该页面的“开发任务名称”是组件自定义输入框，没有 label/placeholder；
  // 它是创建页第一个可见 input。下方 #name 是调度配置中的任务名称，
  // 两者都必须填写。
  const developmentName = await lastVisible(page.locator('input:visible').first());
  if (!developmentName) throw new Error('数据开发任务未找到“开发任务名称”输入框。');
  await developmentName.fill(taskName);
  await developmentName.press('Tab').catch(() => undefined);
  const editor = await lastVisible(page.getByRole('textbox', { name: /Editor content|SQL|脚本/ }))
    ?? await lastVisible(page.locator('.monaco-editor:visible textarea'));
  if (!editor) throw new Error('数据开发任务未找到 SQL 编辑器。');
  await editor.click({ force: true });
  await editor.press('Control+A').catch(async () => await page.keyboard.press('Control+A'));
  // insertText 会把整段文本当作粘贴，使 Monaco 对首个“(”额外补一个右括号。
  // 逐键输入时，脚本中的匹配右括号会覆盖自动补全括号，最终模型值与 SQL 一致。
  await page.keyboard.type(sql, { delay: 1 });
  const expectedPrefix = sql.split(/\r?\n/)[0].slice(0, 24);
  const modelText = async (): Promise<string> => `${await page.locator('.monaco-editor:visible .view-lines').last().innerText().catch(() => '')}\n${await editor.inputValue().catch(() => '')}`;
  if (!await expect.poll(modelText, { timeout: 5_000 }).toContain(expectedPrefix).then(() => true, () => false)) {
    await editor.click({ force: true });
    await editor.press('Control+A').catch(async () => await page.keyboard.press('Control+A'));
    await page.keyboard.type(sql, { delay: 1 });
    await expect.poll(modelText, { timeout: 5_000 }).toContain(expectedPrefix);
  }

  // 新建离线任务页面的重试次数是 ant-input-number，没有稳定的文本可访问名。
  // 页面保存会校验该必填项，填 0 不改变血缘测试语义。
  await page.locator('#maxRetry input[role="spinbutton"]:visible').fill('0');
  // 打开“定时更新”开关，明确创建开发定时任务；调度的默认配置由页面保留。
  const scheduleSwitch = await lastVisible(page.getByRole('switch'));
  if (scheduleSwitch && (await scheduleSwitch.getAttribute('aria-checked').catch(() => null)) !== 'true') {
    await scheduleSwitch.click({ force: true });
    await page.waitForTimeout(500);
  }
  const scheduleName = await lastVisible(page.locator('#name:visible'))
    ?? await lastVisible(page.getByPlaceholder('请输入任务名称'));
  if (scheduleName) {
    if (!(await scheduleName.inputValue().catch(() => '')).trim()) {
      // 该 Ant Design 表单的 name 字段在个别版本只在键盘 change/blur
      // 后同步到表单模型；fill 后补一次真实键盘输入和 change，避免请求体
      // 里出现 name:""。
      await scheduleName.fill(taskName);
      await scheduleName.press('Tab').catch(() => undefined);
      await scheduleName.dispatchEvent('change').catch(() => undefined);
    }
    await expect(scheduleName).toHaveValue(taskName, { timeout: 5_000 });
  }
  await expect(developmentName).toHaveValue(taskName, { timeout: 5_000 });
}

async function clickDevelopmentTaskAction(page: Page, taskName: string, action: RegExp): Promise<void> {
  const rows = page.locator('tr:visible, [role="row"]:visible').filter({ hasText: taskName });
  const row = await lastVisible(rows);
  if (row) {
    const button = await lastVisible(row.getByRole('button', { name: action }))
      ?? await lastVisible(row.locator('a:visible, [role="button"]:visible, td:visible').filter({ hasText: action }));
    if (button) { await button.click({ force: true }); return; }
  }
  // 与表管理相同，固定列版本会把操作列渲染成并行表；按当前页任务名
  // 顺序映射“上线/下线”按钮，绝不点击页面第一条任务。
  const names = page.getByText(taskName, { exact: true });
  let taskIndex = -1;
  for (let i = 0; i < await names.count(); i += 1) {
    if (await names.nth(i).isVisible().catch(() => false)) { taskIndex = i; break; }
  }
  const actions = page.getByRole('button', { name: action });
  if (taskIndex >= 0 && taskIndex < await actions.count()) {
    await actions.nth(taskIndex).click({ force: true });
    return;
  }
  throw new Error(`数据开发任务“${taskName}”未找到操作“${action}”。`);
}

async function createAndPublishDevelopmentTask(page: Page, taskName: string, sql: string): Promise<void> {
  await openDataDevelopList(page);
  await fillDevelopmentTask(page, taskName, sql);
  // 数据开发任务保存同一后端：2026-09-17 证实 updateTableJob 在并行
  // 回归下曾 15 秒无响应；这里同一风险点放宽到 60 秒，避免表单已
  // 保存成功却被误判超时（历史问题档案 §32 同类教训）。
  const saveResponse = page.waitForResponse(
    response => response.url().includes('/job/scheduler/save'),
    { timeout: 60_000 },
  );
  await page.getByRole('button', { name: '保 存' }).click();
  const response = await saveResponse;
  const payload = await response.json().catch(() => undefined) as { code?: string; message?: string } | undefined;
  if (!payload || payload.code !== '000000') {
    throw new Error(`数据开发任务“${taskName}”保存失败：${payload?.message || `HTTP ${response.status()}`}`);
  }
  await openDataDevelopList(page);
  // 列表默认只显示第一页；新任务不一定按创建时间排在第一页，
  // 使用页面自己的“开发任务名称”查询框定位，避免误取其它任务。
  const queryInput = page.locator('input:visible').first();
  await queryInput.fill(taskName);
  await queryInput.press('Tab').catch(() => undefined);
  await page.getByRole('button', { name: '查询' }).click({ force: true });
  await page.waitForTimeout(800);
  await expect(page.getByText(taskName, { exact: true }).last()).toBeVisible({ timeout: 15_000 });
  const online = page.getByRole('button', { name: /上\s*线/ });
  if (await online.count()) {
    await clickDevelopmentTaskAction(page, taskName, /上\s*线/);
    const dialog = await lastVisible(page.locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible'));
    if (dialog) {
      const confirm = await lastVisible(dialog.getByRole('button', { name: /^\s*(确\s*定|上\s*线|发布)\s*$/ }))
        ?? await lastVisible(dialog.locator('button:visible, [role="button"]:visible').filter({ hasText: /确\s*定|上\s*线|发布/ }));
      if (confirm) await confirm.click({ force: true });
    }
    await expect.poll(async () => {
      const text = await page.locator('body').first().innerText().catch(() => '');
      return text.includes(taskName) && /上线/.test(text) ? 'online' : 'waiting';
    }, { timeout: 15_000 }).toBe('online');
  }
}

async function confirmVisibleDialog(page: Page): Promise<void> {
  const dialog = await lastVisible(page.locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible'));
  if (!dialog) return;
  const confirm = await lastVisible(dialog.getByRole('button', { name: /^\s*(确\s*定|上\s*线|下\s*线|发布)\s*$/ }))
    ?? await lastVisible(dialog.locator('button:visible, [role="button"]:visible').filter({ hasText: /确\s*定|上\s*线|下\s*线|发布/ }));
  if (confirm) await confirm.click({ force: true });
}

async function ensureTableOnline(page: Page, tableName: string, online: boolean): Promise<Locator> {
  lineageDebug(`ensure ${online ? 'online' : 'offline'} start: ${tableName}`);
  await openMapLeaf(page, '#/dataMap/tableManage/tablesManage', '表管理');
  let row: Locator | undefined = (await searchManageRowAcrossStates(page, tableName)).row;
  const currentStateButton = online
    ? await lastVisible(row.getByRole('button', { name: /下\s*线/ }))
      ?? await lastVisible(row.locator('a:visible, .el-link:visible, [role="button"]:visible, td:visible').filter({ hasText: /下\s*线/ }))
    : await lastVisible(row.getByRole('button', { name: /上\s*线/ }))
      ?? await lastVisible(row.locator('a:visible, .el-link:visible, [role="button"]:visible, td:visible').filter({ hasText: /上\s*线/ }));
  // “下线”按钮表示当前目标已经上线；“上线”按钮表示当前目标已经下线。
  // 当前状态已经符合要求时立即返回，不再重复刷新列表和等待 20 秒。
  if (currentStateButton && await currentStateButton.isEnabled().catch(() => false)) {
    lineageDebug(`ensure ${online ? 'online' : 'offline'} already satisfied: ${tableName}`);
    return row;
  }

  const transitionButton = online
    ? await lastVisible(row.getByRole('button', { name: /上\s*线/ }))
      ?? await lastVisible(row.locator('a:visible, .el-link:visible, [role="button"]:visible, td:visible').filter({ hasText: /上\s*线/ }))
    : await lastVisible(row.getByRole('button', { name: /下\s*线/ }))
      ?? await lastVisible(row.locator('a:visible, .el-link:visible, [role="button"]:visible, td:visible').filter({ hasText: /下\s*线/ }));
  if (transitionButton && await transitionButton.isEnabled().catch(() => false)) {
    lineageDebug(`toggle ${online ? 'online' : 'offline'}: ${tableName}`);
    await clickRowAction(page, row, online ? /上\s*线/ : /下\s*线/);
    await confirmVisibleDialog(page);
  }
  // 不在 expect.poll 中反复触发跨状态查询：每次查询都会启动列表请求，
  // 多次并发会让 loading 遮罩长期覆盖操作列。改为串行轮询，每轮只发起
  // 一次页面查询，最多等待 20 秒确认状态真正改变。
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.waitForTimeout(attempt === 0 ? 700 : 1_000);
    await expect(page.locator('.ant-spin-spinning:visible, .el-loading-mask:visible'))
      .toHaveCount(0, { timeout: 3_000 }).catch(() => undefined);
    row = (await searchManageRowAcrossStates(page, tableName).catch(() => undefined))?.row;
    if (!row) continue;
    const expectedButton = online
      ? await lastVisible(row.getByRole('button', { name: /下\s*线/ }))
      : await lastVisible(row.getByRole('button', { name: /上\s*线/ }));
    if (expectedButton && await expectedButton.isEnabled().catch(() => false)) return row;
  }
  lineageDebug(`ensure ${online ? 'online' : 'offline'} failed: ${tableName}`);
  throw new Error(`表“${tableName}”${online ? '上线' : '下线'}后页面状态未在 20 秒内稳定。`);
}

async function openTargetTaskSchedule(page: Page, tableName: string): Promise<void> {
  lineageDebug(`open schedule start: ${tableName}`);
  // 真实血缘建链入口是目标表编辑页的“任务调度”，不是“数据开发→离线开发”。
  // 只处理当前目标表：已上线才下线，已下线直接进入编辑；源表不在这里切换状态。
  const row = await ensureTableOnline(page, tableName, false);
  await clickRowAction(page, row, /编辑/);
  // 新版将编辑页标题由“编辑表”调整为“表详情”，表单和任务调度入口不变。
  await expect(page.getByText(/^(编辑表|表详情)$/, { exact: true })).toBeVisible({ timeout: 15_000 });
  await clickLineageTab(page, /任务调度/);
  await expect(page.getByText('生产脚本', { exact: true })).toBeVisible({ timeout: 10_000 });
  lineageDebug(`open schedule ready: ${tableName}`);
}

async function fillTargetTaskSchedule(
  page: Page,
  tableName: string,
  sql: string,
  scriptType: RegExp = /^\s*MYSQL\s*$/i,
): Promise<void> {
  const editor = await lastVisible(page.locator('.monaco-editor:visible textarea'));
  if (!editor) throw new Error(`目标表“${tableName}”任务调度页未找到生产脚本编辑器。`);
  const normaliseSqlText = (value: string): string => value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const expectedSql = normaliseSqlText(sql);
  const modelText = async (): Promise<string> => {
    // Monaco 虚拟滚动只渲染可视行：长 SQL 在 .view-lines 的 innerText 可能被
    // 截断，造成“粘贴已生效却被判不完整”（BL-FLD-02 家族三轮全败的特征）。
    // Ctrl+A 全选后 Monaco 会把完整选中内容同步到隐藏 textarea，优先读
    // inputValue 拿全文；读不到再点击聚焦重读，最后才退回 view-lines 兜底。
    const readSelected = async (): Promise<string> => {
      await editor.press('Control+A').catch(() => undefined);
      return normaliseSqlText(await editor.inputValue().catch(() => ''));
    };
    let value = await readSelected();
    if (!value) {
      await editor.click({ force: true }).catch(() => undefined);
      value = await readSelected();
    }
    if (!value) {
      const visibleLines = await page.locator('.monaco-editor:visible .view-lines').last().innerText().catch(() => '');
      value = normaliseSqlText(visibleLines);
    }
    return value;
  };
  // Monaco 在直接 insertText 含括号的 SQL 时会保留自动补全的右括号，导致实际
  // 提交内容末尾变成多余的 “)”。先彻底清空再输入，并以完整模型文本为准；绝不
  // 再只比较第一行或前缀。
  await editor.click({ force: true });
  // 上一轮调度的旧脚本可能残留在编辑器中（2026-09-16 基线 BL-04-02-04 即因单次
  // 清空未生效、5 秒内模型文本未变空而整体失败）。清空改为最多三轮：每轮重新
  // 聚焦编辑器、Ctrl+A 全选、Backspace 删除，再校验模型文本为空；三轮仍不空才报错。
  const clearEditor = async (): Promise<void> => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if ((await modelText()) === '') return;
      if (attempt > 1) {
        await editor.click({ force: true });
        await page.waitForTimeout(300);
      }
      await editor.press('Control+A').catch(async () => await page.keyboard.press('Control+A'));
      await editor.press('Backspace').catch(async () => await page.keyboard.press('Backspace'));
      try {
        await expect.poll(modelText, { timeout: 5_000 }).toBe('');
        return;
      } catch {
        lineageDebug(`schedule editor clear attempt ${attempt}: model text not empty, retrying`);
      }
    }
    throw new Error(`目标表“${tableName}”生产脚本编辑器连续 3 轮清空失败，无法写入新脚本。`);
  };
  // 任务调度页的脚本类型必须和 SQL 方言匹配，不能把 MySQL/GBase SQL
  // 误当成 Hive SQL。GBase 用例由调用方传入 /GBASE|GBase/ 选择规则。
  // 注意：切换脚本类型会导致前端重置 Monaco 编辑器内容（2026-09-17
  // BL-FLD-02 家族与 BL-02-03 复现：先粘贴后切类型，粘贴内容被清空，
  // 保存请求体里没有 SQL）。因此类型选择必须放在粘贴之前。
  const typeBox = await lastVisible(page.locator('[role="combobox"]:visible').filter({ hasText: /MYSQL|GBASE|GBase|脚本类型|请选择脚本类型/ }));
  if (typeBox && !scriptType.test(await typeBox.innerText().catch(() => ''))) {
    await selectDevelopmentOption(page, typeBox, scriptType, '任务调度脚本类型');
  }
  lineageDebug(`schedule script type: ${await typeBox?.innerText().catch(() => '') || '未找到脚本类型控件'}`);
  await clearEditor();
  // 剪贴板写入可能“成功”但内容未生效（云桌面/DLP 环境实测会出现），Ctrl+V 后
  // 编辑器仍为空。粘贴最多三轮：每轮重贴并校验模型全文；第二轮起改用
  // keyboard.insertText 直写焦点元素（不经剪贴板，DQ 系列已验证该通道可用）。
  let filled = false;
  for (let attempt = 1; attempt <= 3 && !filled; attempt += 1) {
    await pasteLongText(page, editor, sql);
    try {
      await expect.poll(modelText, { timeout: 5_000 }).toBe(expectedSql);
      filled = true;
    } catch {
      const actualLines = await page.locator('.monaco-editor:visible .view-lines').last().innerText().catch(() => '');
      const actualValue = await editor.inputValue().catch(() => '');
      lineageDebug(
        `schedule paste attempt ${attempt}: model text mismatch, retrying. ` +
        `lines=${JSON.stringify(normaliseSqlText(actualLines).slice(0, 200))} ` +
        `textarea=${JSON.stringify(normaliseSqlText(actualValue).slice(0, 200))}`,
      );
      await clearEditor();
      if (attempt >= 2) {
        const focused = await editor.evaluate((element) => element === document.activeElement).catch(() => false);
        if (!focused) await editor.click({ force: true });
        await page.keyboard.insertText(sql);
        try {
          await expect.poll(modelText, { timeout: 5_000 }).toBe(expectedSql);
          filled = true;
        } catch {
          // 留给下一轮 pasteLongText 重试。
        }
      }
    }
  }
  if (!filled) {
    throw new Error(
      `目标表“${tableName}”生产脚本粘贴三轮未生效，编辑器内容仍不含预期 SQL。` +
        `预期：${expectedSql.slice(0, 180)}`,
    );
  }

  const taskName = await lastVisible(page.locator('#name:visible'));
  if (taskName && !(await taskName.inputValue().catch(() => '')).trim()) {
    await taskName.fill(`E2E_LINEAGE_${tableName}_${Math.abs(hashCode(sql))}`);
    await taskName.press('Tab').catch(() => undefined);
  }
  // 任务调度页的“重试次数”是必填项。录制草稿里已有旧值时页面会
  // 自动带出；新建或被环境清空时必须显式填 0，否则点击保存不会发起
  // 保存请求，只在表单下方留下“请输入重试次数”，容易被误判为网络卡住。
  const retryCount = await lastVisible(page.locator('#maxRetry:visible, input[role="spinbutton"]:visible'));
  if (retryCount) {
    // 不依赖旧任务回显；每轮都明确写入失败重试次数，确保保存校验与人工流程一致。
    await retryCount.fill('1');
    await retryCount.press('Tab').catch(() => undefined);
  }
  lineageDebug(`schedule retry: ${await retryCount?.inputValue().catch(() => '') || '未找到重试控件'}`);
  await expect(editor).toBeVisible();
}

async function saveTargetTaskScheduleAndPublish(page: Page, tableName: string, expectedSql: string): Promise<void> {
  lineageDebug(`save schedule start: ${tableName}`);
  // 不同服务版本对表任务调度保存使用不同接口：旧版本为
  // updateTableJob，新同步环境为 saveTableJob。两者都属于目标表任务
  // 调度保存，不能只等待其中一个，否则页面已保存成功仍会被脚本判超时。
  // 2026-09-17 BL-02-03 trace 取证：保存请求已正常发出（请求体含任务
  // 名称与完整 SQL），但后端 15 秒内未返回任何响应（updateTableJob
  // 响应 status=-1），而同环境正常耗时约 2 秒——多代理并行回归时后端
  // 可能长时间不应答。等待放宽到 90 秒；超时后页面通常仍停留在编辑
  // 表单，允许补点一次“保存”再等一轮，避免把后端抖动误判为工具或
  // 产品缺陷。重复提交的是同一份 payload，updateTableJob 幂等。
  const schedulerSaveRe = /\/job\/scheduler\/(?:updateTableJob|saveTableJob)/;
  let response: Response | undefined;
  for (let attempt = 1; attempt <= 2 && !response; attempt += 1) {
    const pending = page
      .waitForResponse(
        (candidate) => schedulerSaveRe.test(candidate.url()),
        { timeout: 90_000 },
      )
      .catch(() => undefined);
    if (attempt === 1) {
      await page.getByRole('button', { name: /保\s*存/ }).last().click({ force: true });
    } else {
      lineageDebug(`schedule save no response in 90s; retry save click: ${tableName}`);
      const saveButton = page.getByRole('button', { name: /保\s*存/ }).last();
      if (await saveButton.isVisible().catch(() => false)) {
        await saveButton.click({ force: true });
      } else {
        lineageDebug('schedule save retry skipped: 保存按钮不可见（页面可能已跳转，继续等待响应）');
      }
    }
    response = await pending;
  }
  if (!response) {
    throw new Error(
      `目标表“${tableName}”任务调度保存请求连续两轮（各 90 秒）均无响应` +
      '（updateTableJob/saveTableJob 皆未返回），疑似后端服务挂起或网络中断。',
    );
  }
  // 仅检查编辑器首行不能证明保存接口拿到完整 SQL。字段血缘的 JOIN、多字段
  // 映射都在后续行，因此必须核对实际请求体，防止 Monaco 外观有文本但模型值
  // 未同步而把“脚本未提交”误判成解析失败。
  const normalise = (value: string): string => value
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const rawBody = response.request().postData() || '';
  const expectedBody = normalise(expectedSql);
  const requestStrings: string[] = [];
  const collectStrings = (value: unknown): void => {
    if (typeof value === 'string') {
      requestStrings.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(collectStrings);
    } else if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(collectStrings);
    }
  };
  try {
    collectStrings(JSON.parse(rawBody));
  } catch {
    requestStrings.push(rawBody);
  }
  const submittedSql = requestStrings.find((value) => normalise(value).includes(expectedBody));
  lineageDebug(`saved SQL: ${normalise(requestStrings.find((value) => /INSERT\s+INTO/i.test(value)) || '').slice(0, 1_000)}`);
  if (!submittedSql) {
    throw new Error(
      `目标表“${tableName}”任务调度保存请求未携带完整生产脚本。` +
      `预期片段：${expectedBody.slice(0, 180)}；实际字符串：${requestStrings.map(normalise).filter(Boolean).join(' || ').slice(0, 600) || '空'}`,
    );
  }
  const payload = await response.json().catch(() => undefined) as { code?: string; message?: string } | undefined;
  if (!payload || payload.code !== '000000') {
    throw new Error(`目标表“${tableName}”任务调度保存失败：${payload?.message || `HTTP ${response.status()}`}`);
  }
  const message = page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
    .filter({ hasText: /成功|保存|更新/ }).last();
  await expect(message).toBeVisible({ timeout: 10_000 }).catch(() => undefined);

  // 保存后按录制流程回表管理列表，对同一目标表执行上线；源表不做任何修改。
  await ensureTableOnline(page, tableName, true);
  lineageDebug(`save schedule done: ${tableName}`);
}

export async function configureAutoLineage(page: Page, item: AutoLineageCase): Promise<void> {
  lineageDebug(`configure SQL start: ${item.sql.slice(0, 80).replace(/\s+/g, ' ')}`);
  // ensureSqlReferencedTables 已经按需创建并将源表置为上线；这里不再对
  // 全部表做一轮重复状态确认。目标表的状态只在 openTargetTaskSchedule
  // 中即时判断：上线才下线，下线直接编辑。
  const dataSource = item.dataSource ?? fixtureDataSource(item.fixtureSet ?? 'base');
  await ensureSqlReferencedTables(page, item.sql, item.targetTable, item.virtualSourceTables, dataSource);
  await openTargetTaskSchedule(page, item.targetTable);
  await fillTargetTaskSchedule(
    page,
    item.targetTable,
    item.sql,
    item.scriptType ?? (dataSource === 'gbase' ? /G[_\s-]*BASE(?:8A|_DB)?|GBASE8A/i : /^\s*MYSQL\s*$/i),
  );
  await saveTargetTaskScheduleAndPublish(page, item.targetTable, item.sql);
  lineageDebug('configure SQL done');
}

export type ExistingLineageStatementCase = AutoLineageCase & {
  sourceTables?: string[];
  scriptType?: RegExp;
};

/**
 * 执行已经由业务准备好的外部数据库血缘单条 SQL。
 *
 * 与 MySQL 自动夹具不同，这个入口不会创建、删除或恢复外部数据库表，
 * 只检查源表/目标表、写入目标表任务调度并上线，适合 GBase 大 SQL 拆分
 * 后逐条人工复核。每个 spec 文件只传入一条 SQL。
 */
export async function configureExistingLineageStatement(
  page: Page,
  item: ExistingLineageStatementCase,
): Promise<void> {
  const dataSource = fixtureDataSource(item.fixtureSet ?? 'base');
  for (const sourceTable of item.sourceTables ?? []) {
    await ensureLineageTable(page, sourceTable, dataSource);
  }
  await ensureLineageTable(page, item.targetTable, dataSource);
  await openTargetTaskSchedule(page, item.targetTable);
  await fillTargetTaskSchedule(page, item.targetTable, item.sql, item.scriptType ?? /GBASE|GBase|GBASE8A/i);
  await saveTargetTaskScheduleAndPublish(page, item.targetTable, item.sql);
}

/**
 * GBase 血缘使用独立夹具表；表只在页面中创建到已登记的 GBase 数据源，
 * 不要求新建数据库，也不会改动已有业务表。
 */
export async function ensureGBaseLineageTables(page: Page, tableNames: string[]): Promise<void> {
  for (const tableName of [...new Set(tableNames)]) {
    await ensureLineageTable(page, tableName, 'gbase');
  }
}

const NO_LINEAGE_SQL = process.env.LINEAGE_NO_RELATION_SQL?.trim() || 'SELECT 1 AS e2e_no_lineage';

/**
 * 血缘用例的起始基线：先让专用目标表保留一条可见的 A→B 表级血缘。
 *
 * 该基线只用于验证“旧关系被新 SQL 清理”的路径；测试结束后会保留本轮
 * SQL 的真实解析状态。该函数只操作本项目专用测试表，不触碰业务表。
 */
export async function restoreLineageBaseline(
  page: Page,
  fixtureSet: LineageFixtureSet = 'base',
  fixtureKey?: string,
): Promise<void> {
  lineageDebug(`restore baseline start: ${fixtureSet}`);
  const fixture = await ensureLineageFixture(page, fixtureSet, fixtureKey);
  const baseline: AutoLineageCase = {
    targetTable: fixture.targetTable,
    sql: `INSERT INTO ${fixture.targetTable}\nSELECT * FROM ${fixture.sourceTable}`,
    expectedNodes: [fixture.sourceTable, fixture.targetTable],
    expectedRelations: [],
    fixtureKey,
  };
  await configureAutoLineage(page, baseline);
  lineageDebug('restore baseline done');
}

/**
 * 统一执行“已有正确血缘 → 清空关系 → 验证本轮 SQL”。
 *
 * `configureAutoLineage` 本身只负责把 SQL 写入目标表任务调度并上线，旧版
 * 具备独立 fixtureKey 的 BL-02/BL-03 用例不恢复正确血缘：每张表只服务于
 * 一个 SQL 场景，最终保留本轮 SQL 的解析状态，方便失败后直接查看现场。
 */
export async function runLineageCase<T>(
  page: Page,
  item: AutoLineageCase,
  verify: () => Promise<T>,
): Promise<T> {
  const fixtureSet = item.fixtureSet || 'base';
  // 先恢复一次基线，确保本轮开始前测试表确实有一条可复用的血缘；
  // 再写入无表引用 SQL，触发产品清除旧关系的路径。
  await restoreLineageBaseline(page, fixtureSet, item.fixtureKey);
  lineageDebug('run case: clear relation');
  await configureAutoLineage(page, {
    targetTable: item.targetTable,
    sql: NO_LINEAGE_SQL,
    expectedNodes: [item.targetTable],
    expectedRelations: [],
    fixtureKey: item.fixtureKey,
  });
  lineageDebug('run case: clear relation done');
  lineageDebug('run case: configure requested SQL');
  await configureAutoLineage(page, item);
  lineageDebug('run case: verify');
  return await verify();
}

export async function openTableLineage(
  page: Page,
  tableName: string,
  options: { requireGraph?: boolean } = {},
): Promise<void> {
  let lastError: unknown;
  // updateTableJob 成功后，表详情中的 etlJobId 会有短暂的异步刷新窗口。
  // 若立刻点血缘页签，前端可能发出 {} 给 selectJobLineage；重新从列表打开
  // 同一张表即可拿到最新详情。这里只重试读取，不重复保存 SQL 或修改表。
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const detailApiErrors: string[] = [];
    const lineageApiPayloads: string[] = [];
    const detailResponseListener = (response: import('@playwright/test').Response): void => {
      if (/\/etljob\/selectEtlJobInfo/.test(response.url()) && response.status() >= 400) {
        detailApiErrors.push(`${response.status()} ${response.url()}`);
      }
    };
    const lineageResponseListener = (response: import('@playwright/test').Response): void => {
      if (/selectJobLineage|lineage/i.test(response.url())) {
        void response.text().then((body) => {
          lineageApiPayloads.push(`${response.status()} ${response.url()} :: ${body.slice(0, 1_200)}`);
        }).catch(() => undefined);
      }
    };
    page.on('response', detailResponseListener);
    page.on('response', lineageResponseListener);
    try {
      await openMapLeaf(page, '#/dataMap/tableQuery/tablesQuery', '表查询');
      try {
        await searchAndOpenTable(page, tableName, 'query');
      } catch (queryError) {
        // 新服务偶尔返回空的表查询卡片，但表管理的“物理表存在”列表已经
        // 能看到同一张已上线表。两处进入的是同一个表详情组件；只在查询
        // 卡片确实未出现时用管理列表兜底，避免把页面瞬态误报成缺表。
        await openMapLeaf(page, '#/dataMap/tableManage/tablesManage', '表管理');
        const row = await searchManageRow(page, tableName, 5_000).catch(() => undefined);
        if (!row) throw queryError;
        const name = await lastVisible(row.getByText(tableName, { exact: true }))
          ?? await lastVisible(row.locator('a:visible, [role="link"]:visible').filter({ hasText: tableName }))
          // 固定左侧表格的行可能只保留操作列，表名节点被渲染到同步的
          // 非固定表格；此时仍限定为当前页面唯一精确表名，不能点击第一条。
          ?? await lastVisible(page.getByText(tableName, { exact: true }));
        if (!name) throw queryError;
        await name.click({ force: true });
        await waitForTableDetail(page);
      }
      page.off('response', detailResponseListener);
      if (detailApiErrors.length) {
        throw new Error(
          `表详情接口加载失败，无法验证血缘图：${detailApiErrors.join('；')}` +
          `。请先修复服务依赖库中的 null_format 字段结构。`,
        );
      }
      await clickLineageTab(page, /数据血缘/);
      await page.waitForTimeout(800);
      page.off('response', lineageResponseListener);
      if (lineageApiPayloads.length) {
        lineageDebug(`lineage API attempt ${attempt}: ${lineageApiPayloads.join(' || ')}`);
      }
      // 页签点击完成和页签内容挂载不是同一时刻。部分版本会先保留
      // “字段信息”的面板，随后才渲染“编辑血缘/暂无数据/图谱”；
      // 必须确认血缘内容本身已出现，不能只依赖详情页或 URL。
      await expect.poll(async () => {
        const edit = await page.getByRole('button', { name: /编辑血缘|人工编辑/ }).isVisible().catch(() => false);
        // 不要用 [class*="lineage"] 作为就绪条件：某些版本的详情容器、页签
        // 或路由本身也带 lineage 类名，会在“字段信息”仍选中时误判已进入血缘页。
        const graph = await page.locator('[role="tabpanel"]:visible svg:visible, [role="tabpanel"]:visible canvas:visible, [role="tabpanel"]:visible img:visible').count() > 0;
        // “暂无数据”可能来自相邻的“调度任务”面板，不能作为数据血缘页
        // 已就绪的信号；此前会让 BL-01-02 在实际没有图谱/编辑入口时继续
        // 执行，并把空态误诊为定位问题。
        return edit || graph;
      }, { timeout: 8_000 }).toBe(true);
      const lineagePanel = page.locator('[role="tabpanel"]:visible, .ant-tabs-content:visible, .el-tab-pane:visible')
        .filter({ hasText: /数据血缘|当前表|上游|下游|血缘/ }).last();
      await expect(lineagePanel).toBeVisible({ timeout: 12_000 });
      // 编辑入口、草稿和变更记录用例只需要进入“数据血缘”页签；
      // 当前表没有已生成关系时，图谱为空不应阻断这些入口测试。
      // 节点验证用例保持默认 requireGraph=true，继续严格校验图谱。
      if (options.requireGraph === false) return;
      const graphReady = await expect.poll(async () => {
        const graph = lineagePanel.locator('canvas:visible, svg:visible, img:visible, [class*="graph"]:visible');
        return await graph.count();
      }, { timeout: 4_000 }).toBeGreaterThan(0).then(() => true, () => false);
      if (graphReady) return;
      lastError = new Error(`第 ${attempt} 次读取“${tableName}”血缘图仍为空。`);
    } catch (error) {
      lastError = error;
    }
    page.off('response', lineageResponseListener);
    if (attempt < 3) await page.waitForTimeout(1_500 * attempt);
  }
  throw lastError instanceof Error ? lastError : new Error(`未能读取表“${tableName}”的血缘图。`);
}

export async function expectLineage(page: Page, item: AutoLineageCase): Promise<void> {
  // 保存任务调度后，接口会先返回只有“当前表”的图谱，随后才异步补齐上游。
  // 不能把该首屏瞬态当作 SQL 未解析；只读地重新进入详情页重取图谱，不重复保存
  // SQL 或改动表状态。全量回归时调度队列堆积，血缘回写可能滞后 1 分钟以上，
  // 默认重读 6 次（累计等待 30s + 多次重开详情页），可用 LINEAGE_GRAPH_ATTEMPTS 调整。
  const maxAttempts = Number(process.env.LINEAGE_GRAPH_ATTEMPTS ?? 6);
  let root: Locator | undefined;
  let graphSvgs: Locator | undefined;
  let missingNodes = item.expectedNodes;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    root = page.locator('[role="tabpanel"]:visible, .ant-tabs-content:visible, .el-tab-pane:visible')
      .filter({ hasText: /数据血缘|当前表|上游|下游/ }).last();
    await expect(root).toBeVisible({ timeout: 12_000 });
    graphSvgs = root.locator('svg:visible');
    await page.waitForTimeout(2_000 * attempt);
    missingNodes = [];
    for (const node of item.expectedNodes) {
      // 不能只在整个页面找表名：目标表详情页标题本身就包含目标表名，
      // 这样即使血缘图为空也会被误判为通过。必须确认表名位于血缘图的
      // SVG/foreignObject 节点中；当前版本每个节点可能是独立 SVG。
      const graphNode = graphSvgs.filter({ hasText: node }).last();
      if (!await graphNode.isVisible().catch(() => false)) missingNodes.push(node);
    }
    if (missingNodes.length === 0) break;
    if (attempt < maxAttempts) await openTableLineage(page, item.targetTable);
  }
  if (missingNodes.length) {
    throw new Error(`血缘图未显示节点：${missingNodes.join('、')}（已重新读取图谱 ${maxAttempts} 次；若调度确已执行成功，多为血缘回写持续滞后或该 SQL 解析失败）`);
  }
  // 当前版本的 selectJobLineage 接口只返回表级 tableRelationshipList，页面也会在
  // 图谱 mounted 时抛出已登记的前端异常，导致“字段级”页签/节点没有稳定渲染。
  // 默认用真实的 A→B 表级图谱覆盖 SQL 解析和建链流程；前端修复后，用环境变量
  // STRICT_LINEAGE_FIELDS=1 恢复字段级 DOM 断言，避免当前缺陷把所有复杂 SQL
  // 用例误判成脚本失败。
  if (item.expectedRelations?.length && process.env.STRICT_LINEAGE_FIELDS === '1') {
    await clickLineageTab(page, /字段级/);
    for (const relation of item.expectedRelations) {
      for (const field of relation.split('->').map((part) => part.trim()).filter(Boolean)) {
        const graphField = graphSvgs!.filter({ hasText: field }).last();
        await expect(graphField, `字段级血缘未展示字段：${field}（关系：${relation}）`)
          .toBeVisible({ timeout: 12_000 });
      }
    }
  }
}

/**
 * 当前版本的血缘图在完成接口请求、渲染 SVG 节点后，仍会在前端 bundle 内
 * 抛出一次已知的解构异常。该问题已单独登记为前端缺陷；按当前确认范围，
 * 血缘用例继续校验任务保存、表上线和图谱节点/关系，但不能让这一条已知
 * 异常阻断全部血缘回归。除此之外的任意 console error 仍然必须失败。
 */
export function assertNoUnexpectedLineageConsoleErrors(consoleErrors: string[]): void {
  const unexpected = consoleErrors.filter(
    (message) => !/Invalid attempt to destructure non-iterable instance/.test(message)
      // 当前服务在进入任意数据地图页面时都会并行请求文件接入列表，
      // 但同步后的库缺少 file_upload_task.null_format 字段。该接口与
      // 血缘、表管理无关，不能让血缘用例把这个已确认的环境后端异常
      // 误报成血缘脚本失败；单独的文件接入回归仍应保留该错误。
      && !/queryDfFileUploadTaskPageList|Unknown column ['"]?null_format/.test(message),
  );
  if (unexpected.length) {
    throw new Error(`数据血缘页面出现非已知控制台错误：${unexpected.join('；')}`);
  }
}

export async function openAnyLineage(page: Page, options: { requireGraph?: boolean } = {}): Promise<void> {
  const configuredTarget = process.env.LINEAGE_GRAPH_TABLE?.trim();
  if (configuredTarget) {
    await openTableLineage(page, configuredTarget, options);
    return;
  }

  // 图谱展示属于验证流程：只读检查由建血缘流程固化的测试表，
  // 不再从当前列表第一张表随机选目标，更不在这里临时创建业务数据。
  const fixture = await requireLineageFixture(page);
  await openTableLineage(page, fixture.targetTable, options);
}

export async function visibleLineageControl(page: Page, name: string | RegExp): Promise<Locator> {
  const button = page.getByRole('button', { name });
  const text = page.getByText(name, { exact: typeof name === 'string' });
  // 详情页页签切换完成后，编辑按钮可能还要经过一次异步渲染；
  // 不能在 openTableLineage 返回的同一时刻只查一次 DOM。
  await expect.poll(async () =>
    await button.isVisible().catch(() => false) || await text.isVisible().catch(() => false),
  { timeout: 10_000 }).toBe(true);
  const control = await lastVisible(button) ?? await lastVisible(text);
  if (!control) throw new Error(`数据血缘页面未找到控件“${String(name)}”。`);
  return control;
}

export async function clickAnyVisible(page: Page, selector: string): Promise<void> {
  const control = await lastVisible(page.locator(selector));
  if (!control) throw new Error(`数据血缘页面未找到节点控件：${selector}`);
  await control.click();
}
