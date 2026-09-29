/**
 * FTP/SFTP 文件导出场景（Excel「测试用例」Sheet，序号 66～73）。
 * 与 FTP/SFTP 接入、预览、导入拆开，便于无关文件在不同 worker 中运行。
 *
 * 2026-09-22 环境基线迁移（静态）：默认远端由 113 时代 SFTP 110:/source/ 切换为
 * FTP 192.168.76.113:2121、目录 /（资源/当前测试环境基线.md）；凭据只从
 * FTP_HOST/FTP_PORT/FTP_USER/FTP_PASS 读取。导出函数签名未变，数据服务目录下
 * DS-02-02/DS-02-04/E2E夹具 等既有引用方无需改动即可编译。
 */

import SftpClient from 'ssh2-sftp-client';
import { Client as FtpClient } from 'basic-ftp';
import type { Locator, Page, Response } from '@playwright/test';
import { test, expect, uuid } from '../utils.js';
import { assertNoConsoleErrors, fillByLabel, selectByLabel, submitAndExpectSuccess } from '../utils.js';

// 2026-09-22 环境基线（资源/当前测试环境基线.md）：文件类用例默认远端为 FTP
// 192.168.76.113:2121、目录 /；凭据只从运行环境变量读取，代码不再内置 test/test
// 账号兜底。FTP_PROTOCOL=sftp 时按 SFTP 22 处理（仅用例明确验证 SFTP 时显式指定）。
const FTP_HOST = process.env.FTP_HOST;
const FTP_PROTOCOL = (process.env.FTP_PROTOCOL || 'ftp').toLowerCase();
const FTP_PORT = process.env.FTP_PORT || (FTP_PROTOCOL === 'sftp' ? '22' : '2121');
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASS;
const EXPORT_SOURCE_TABLE = process.env.EXPORT_SOURCE_TABLE;
const EXPORT_SOURCE_TYPE = process.env.EXPORT_SOURCE_TYPE || 'MYSQL';
// 文件导出页的数据源名称使用“主机:端口/数据库”的展示值；仅传主机 IP
// 会在下拉列表中找不到选项，导致后续字段都未加载。
const EXPORT_SOURCE_NAME = process.env.EXPORT_SOURCE_NAME || '192.168.76.110:13306/e2e_test';
const EXPORT_DATABASE = process.env.EXPORT_DATABASE || 'e2e_test';
const EXPORT_SCHEMA = process.env.EXPORT_SCHEMA || 'e2e_test';
const FTP_FILE_PATH = (process.env.FTP_FILE_PATH || '/').replace(/\/?$/, '/');

/**
 * 兼容真实页面可能使用的 Ant Design、Element 或 ARIA 表格结构，
 * 同时只保留包含数据单元格的可见行，避免依赖固定的 tbody 层级。
 */
export function dataRows(page: import('@playwright/test').Page) {
  return page
    .locator(
      [
        '.ant-table-tbody > tr:visible',
        '.el-table__body-wrapper tbody > tr:visible',
        'table tbody > tr:visible',
        '[role="row"]:visible',
      ].join(', '),
    )
    .filter({ has: page.locator('td, [role="cell"]') });
}

function exactText(text: string): RegExp {
  return new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`);
}

function menuCandidates(page: Page, text: string): Locator[] {
  const matcher = exactText(text);
  return [
    page.locator('.el-menu:visible .el-menu-item').filter({ hasText: matcher }),
    page.locator('.ant-menu:visible .ant-menu-item').filter({ hasText: matcher }),
    page.locator('.el-menu:visible .el-submenu__title').filter({ hasText: matcher }),
    page.locator('.ant-menu:visible .ant-menu-submenu-title').filter({ hasText: matcher }),
    page.getByRole('menuitem', { name: text, exact: true }).filter({ visible: true }),
    page.getByRole('link', { name: text, exact: true }).filter({ visible: true }),
  ];
}

function leafCandidates(page: Page, text: string): Locator[] {
  const matcher = exactText(text);
  return [
    page.locator('.el-menu:visible .el-menu-item').filter({ hasText: matcher }),
    page.locator('.ant-menu:visible .ant-menu-item').filter({ hasText: matcher }),
    page.getByRole('link', { name: text, exact: true }).filter({ visible: true }),
  ];
}

function parentCandidates(page: Page, text: string): Locator[] {
  const matcher = exactText(text);
  return [
    page.locator('.el-menu:visible .el-submenu__title').filter({ hasText: matcher }),
    page.locator('.ant-menu:visible .ant-menu-submenu-title').filter({ hasText: matcher }),
  ];
}

async function firstVisible(candidates: Locator[], timeout = 0): Promise<Locator | undefined> {
  const deadline = Date.now() + timeout;
  do {
    for (const candidate of candidates) {
      const count = await candidate.count();
      // 旧菜单节点可能仍在 DOM 中，倒序优先当前展开的菜单项。
      for (let index = count - 1; index >= 0; index--) {
        const item = candidate.nth(index);
        if (await item.isVisible().catch(() => false)) return item;
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (true);
  return undefined;
}

async function openTopOverflow(page: Page): Promise<void> {
  const overflow = await firstVisible([
    page.getByRole('button', { name: /^(?:更多|···|…|\.\.\.)$/ }),
    page.locator('.el-submenu__title:visible, .ant-menu-submenu-title:visible')
      .filter({ hasText: /^(?:更多|···|…|\.\.\.)$/ }),
    page.getByRole('menuitem', { name: /^(?:更多|···|…|\.\.\.)$/ }).filter({ visible: true }),
    page.locator('[aria-label*="更多"]:visible, [title*="更多"]:visible'),
    page.getByText('更多', { exact: true }).filter({ visible: true }),
    page.getByText(/^(?:···|…|\.\.\.)$/, { exact: true }).filter({ visible: true }),
  ], 3_000);
  if (!overflow) throw new Error(`顶部溢出菜单未找到，当前页面：${page.url()}`);
  await overflow.click();
  await page.waitForTimeout(800);
}

/** 按真实顶部菜单→左侧父级→可见叶子节点导航。 */
export async function clickVisibleMenuPath(page: Page, ...segments: string[]): Promise<void> {
  const routeMap: Record<string, string> = {
    '数据接入>ftp文件接入>接入列表': '#/dataAccess/ftpAccess/accessList',
    '数据地图>表查询>表查询': '#/dataMap/tableQuery/tablesQuery',
    // 父路由 fileExport 在新版有时只渲染空容器，直接访问已确认的叶子路由
    // 能避免“导出列表”侧栏子项异步未出现时的偶发导航失败。
    '数据服务>文件导出>导出列表': '#/dataService/fileExport/fileList',
  };
  const route = routeMap[segments.join('>')];
  if (route) {
    const base = page.url().split('#')[0];
    const expectedPath = route.replace(/^#/, '');
    // 登录后首个 SPA 路由跳转偶发被初始重定向覆盖，仍会停在数据源页。
    // 只有地址栏已落到目标叶子页时才继续填写，最多重试三次。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);
      if (page.url().includes(expectedPath)) return;
    }
    throw new Error(`未能进入菜单路由“${segments.join(' > ')}”，当前页面：${page.url()}`);
  }
  if (!segments.length) throw new Error('菜单路径不能为空');

  let target = await firstVisible(menuCandidates(page, segments[0]), 2_000);
  if (!target) {
    await openTopOverflow(page);
    target = await firstVisible(menuCandidates(page, segments[0]), 5_000);
  }
  if (!target) throw new Error(`菜单项“${segments[0]}”未找到或不可见，当前页面：${page.url()}`);
  await target.click();
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(800);

  for (let index = 1; index < segments.length; index++) {
    const segment = segments[index];
    let child = segment === segments[index + 1]
      ? await firstVisible(parentCandidates(page, segment), 2_000)
      : await firstVisible(leafCandidates(page, segment), 2_000);
    if (!child && segment !== segments[index + 1]) {
      child = await firstVisible(menuCandidates(page, segment), 1_000);
    }
    if (!child) {
      const parent = await firstVisible(parentCandidates(page, segments[index - 1]), 2_000)
        ?? await firstVisible(menuCandidates(page, segments[index - 1]), 2_000);
      if (!parent) {
        throw new Error(`菜单父级“${segments[index - 1]}”未找到或不可见，当前页面：${page.url()}`);
      }
      await parent.click();
      await page.waitForTimeout(800);
      child = segment === segments[index + 1]
        ? await firstVisible(parentCandidates(page, segment), 5_000)
        : await firstVisible(leafCandidates(page, segment), 5_000)
          ?? await firstVisible(menuCandidates(page, segment), 2_000);
    }
    if (!child) throw new Error(`菜单项“${segment}”未找到或不可见，当前页面：${page.url()}`);
    await child.click();
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await page.waitForTimeout(800);
  }
}

export async function clickVisibleText(page: Page, text: string): Promise<void> {
  const candidate = await firstVisible([
    page.locator('button:visible, a:visible, label:visible, [role="button"]:visible, [role="radio"]:visible')
      .filter({ hasText: exactText(text) }),
    page.getByText(text, { exact: true }).filter({ visible: true }),
  ], 10_000);
  if (!candidate) throw new Error(`页面文本“${text}”未找到或不可见，当前页面：${page.url()}`);
  await candidate.click();
}

export async function clickVisibleButton(page: Page, name: RegExp): Promise<void> {
  const candidate = await firstVisible([
    page.getByRole('button', { name }).filter({ visible: true }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: name }),
    // 20260916 回归实证：导出列表“新建导出”由 button 改为无 role 的可点击
    // generic（ARIA 快照：`generic: 新建导出`），按钮级定位全部落空。补文本
    // 兜底，且仍以 role=button 候选优先，避免页面结构调整后导出链路在入口
    // 处中断。
    page.getByText(name).filter({ visible: true }),
  ], 10_000);
  if (!candidate) throw new Error(`可见按钮“${name}”未找到，当前页面：${page.url()}`);
  await candidate.click();
  await page.waitForTimeout(500);
}

export async function expectVisibleSuccess(page: Page): Promise<void> {
  await expect(page.getByText(/成功|正常/).filter({ visible: true }).last())
    .toBeVisible({ timeout: 10_000 });
}

export async function selectAvailableSourceTable(
  page: Page,
  // FS-04-03 迁移：允许调用方传入本轮唯一来源表；缺省时行为与迁移前完全一致
  // （仍取模块级 EXPORT_SOURCE_TABLE 环境变量），既有调用方（FS-04-01/02）不受影响。
  sourceTableOverride?: string,
): Promise<string> {
  const sourceTable = sourceTableOverride?.trim() || EXPORT_SOURCE_TABLE;
  const sourceChain = [
    ['数据源类型', EXPORT_SOURCE_TYPE],
    ['数据源名称', EXPORT_SOURCE_NAME],
    ['数据库名称', EXPORT_DATABASE],
    ['Schema', EXPORT_SCHEMA],
    ['表', sourceTable],
  ] as const;
  for (const [label, value] of sourceChain) {
    if (!value?.trim()) throw new Error(`未配置导出来源字段：${label}`);
    await selectByLabel(page, label, value);
    // 每级选择都会异步加载下一级；给页面一个短暂的稳定窗口，避免下拉选项仍是上一级数据。
    await page.waitForTimeout(350);
  }
  // 测试表字段为 id/name/remark，没有业务表常见的 DATA_DATE；清掉页面
  // 默认的日期占位条件，否则后端可能按不存在的字段校验而拒绝保存。
  await fillByLabel(page, 'Where条件', '');
  return sourceTable!;
}

export async function openNewExport(
  page: import('@playwright/test').Page,
  opts: {
    integrate: boolean;
    compress?: boolean;
    notify?: string;
    baseName?: string;
    where?: string;
    /** 本轮唯一来源表（FS-04-03 迁移）；缺省时沿用 EXPORT_SOURCE_TABLE 环境变量。 */
    sourceTable?: string;
  },
): Promise<{ taskName: string; baseName: string }> {
  // 基线约定凭据只从环境变量读取；缺失时明确报错，不回退内置账号（防伪通过）。
  if (!FTP_HOST?.trim() || !FTP_USER?.trim() || !FTP_PASS?.trim()) {
    throw new Error('缺少 FTP_HOST/FTP_USER/FTP_PASS 环境变量，无法填写导出任务服务器连接信息');
  }
  await clickVisibleMenuPath(page, '数据服务', '文件导出', '导出列表');
  await clickVisibleButton(page, /新建导出/);
  // 点击后由 SPA 异步切到 fileExportCreate；不能只等固定 500ms，否则慢一帧
  // 时仍在列表页就开始找“数据源类型”，形成偶发的假失败。
  await expect.poll(async () =>
    page.url().includes('/dataService/fileExport/fileExportCreate') ||
    await page.getByText('来源表', { exact: true }).isVisible().catch(() => false),
  { timeout: 15_000 }).toBe(true);
  await selectAvailableSourceTable(page, opts.sourceTable);
  if (opts.where !== undefined) await fillByLabel(page, 'Where条件', opts.where);
  const protocol = page.getByText(FTP_PROTOCOL === 'sftp' ? /^sftp$/i : /^ftp$/i, { exact: true }).last();
  if (await protocol.isVisible().catch(() => false)) await protocol.click();
  // 当前页面的“导出类型”实际选项是“全量/SQL”，旧录制中的“整合/不整合”
  // 已不再显示；全量对应本用例的整表文件导出，SQL 保留给 SQL 导出场景。
  await clickVisibleText(page, opts.integrate ? 'SQL' : '全量');
  // 旧版“日期格式/无日期”选项在当前前端已下线（run-20260916-161845-734 创建页
  // 快照实证：表单仅 导出类型 全量/SQL、单文件模式、是否压缩 是/否），不再操作。
  if (opts.compress !== undefined) {
    // 当前页面的压缩项是“是否压缩：是/否”，而非旧版“压缩/不压缩”文本。
    // 单选框和标签在同一表单行的不同嵌套层，按页面唯一的“是/否”控件定位，
    // 不依赖会随组件版本变化的父容器层级。
    const choice = page.getByRole('radio', { name: opts.compress ? '是' : '否', exact: true }).last();
    await expect(choice, '未找到“是否压缩”的可选值').toBeVisible({ timeout: 10_000 });
    await choice.click();
  }
  if (opts.notify !== undefined) {
    // 当前页面字段命名为“通知接口”，旧测试用例中的“通知地址”是历史名称。
    await fillByLabel(page, '通知接口', opts.notify);
  }
  await fillByLabel(page, FTP_PROTOCOL === 'sftp' ? 'sftp服务器地址' : 'ftp服务器地址', FTP_HOST!);
  await fillByLabel(page, '服务器端口', FTP_PORT);
  await fillByLabel(page, '登录用户名', FTP_USER);
  await fillByLabel(page, '登录密码', FTP_PASS);
  const baseName = opts.baseName ?? `e2e_export_${uuid()}`;
  await fillByLabel(page, '基础文件名', baseName);
  await fillByLabel(page, '文件路径', FTP_FILE_PATH);
  // 页面默认值在不同版本可能只显示在控件内但未写入表单模型，
  // 显式补齐文件分隔符和保存时长，避免点击保存后仍停留在表单页。
  await fillByLabel(page, '字段分隔符', ',');
  const permanent = page.getByRole('radio', { name: '永久', exact: true }).last();
  if (await permanent.isVisible().catch(() => false)) await permanent.check();
  const taskName = `exp_${uuid()}`;
  await fillByLabel(page, '任务名称', taskName);
  // 后端创建时会把 coreTask 直接转交调度服务。当前页面默认不选任何值，
  // 请求中将是 null 并可能使调度创建失败；测试任务明确选择“否”。
  const nonCoreTask = page.getByRole('radio', { name: '否', exact: true }).last();
  if (await nonCoreTask.isVisible().catch(() => false)) {
    await nonCoreTask.check().catch(async () => await nonCoreTask.click());
  }
  return { taskName, baseName };
}

/**
 * 文件导出列表将“数据列”和“操作列”渲染为两个同步表格（固定列布局），
 * 因此不能在包含任务名的数据行内直接查“执行”按钮。按数据行在列表中的
 * 位置，映射到操作表同位置的行后再点击。
 */
export async function clickExportTaskAction(page: Page, taskName: string, action: RegExp): Promise<void> {
  const detailRows = page.locator(
    '.ant-table-tbody > tr:visible, .el-table__body-wrapper tbody > tr:visible, table tbody > tr:visible',
  );
  const detailRow = detailRows.filter({ hasText: taskName }).first();
  await expect(detailRow, `导出任务“${taskName}”未出现在列表中`).toBeVisible({ timeout: 15_000 });
  const rowIndex = await detailRow.evaluate((row) => Array.from(row.parentElement?.children ?? []).indexOf(row));
  if (rowIndex < 0) throw new Error(`无法定位导出任务“${taskName}”在列表中的行号`);

  const operationTable = page.locator('table:visible')
    .filter({ has: page.getByRole('columnheader', { name: '操作', exact: true }) })
    .last();
  const operationRows = operationTable.locator('tbody > tr:visible');
  const operationRow = operationRows.nth(rowIndex);
  const button = operationRow.getByRole('button', { name: action }).filter({ visible: true });
  await expect(button, `任务“${taskName}”的操作“${action}”不可用`).toBeVisible({ timeout: 10_000 });
  await button.click();
}
/**
 * ===== 导出任务「编辑→再次执行」闭环共享工具（agent-11 20260917 新增）=====
 * DS-02-02（导出任务编辑后再次执行使用最新配置）与 FS-04-04（条件导出任务
 * 执行及远端目录生成文件）同链路复用。前置事实：
 *   - POST /file/download/ftp/create 自 9/16 起持续返回 111111“任务创建失败-
 *     调度创建失败-请查看日志”（run5/run6/fix2/fix3/fix4 同因实证）；
 *   - “上线/执行/实例”链路健康（基线 run-20260917-105532-552 的 DS-02-05 通过），
 *     20260917 只读探测确认测试机可直连远端 SFTP（/source/ 列表成功）。
 *   - 按任务约定复用已上线的自动化自有导出任务，通过“编辑保存
 *     （/file/download/ftp/update）”绕开 create 接口完成闭环，不重复创建任务。
 */

/**
 * 自动化自有导出任务的匹配优先级；绝不回退编辑业务任务。
 * 2026-09-22 基线：首选 110 迁移期夹具任务 test_gs_0902（与 数据服务/E2E夹具-
 * 110环境导出任务迁移.spec.ts 的候选清单一致，不存在时由该夹具用例经 UI 新建
 * 并写入 fixture-state.json）；历史 113 时代任务名仅保留为末位候选，均不存在时
 * findReusableExportTask 会报出当前列表内容供排查，绝不回退业务任务。
 */
export function reusableExportTaskNames(): string[] {
  return [process.env.DS_02_02_EXPORT_TASK_NAME || 'test_gs_0902', 'test5_sftp', 'test_sftp_split_1', 'test6_sftp']
    .filter((name, index, all) => all.indexOf(name) === index);
}

/** 在导出列表数据列中按优先级查找可复用的自动化自有任务，返回任务名与行文本。 */
export async function findReusableExportTask(page: Page): Promise<{ taskName: string; rowText: string }> {
  // 列表接口有加载延迟（run-20260917-141820-964 曾扫到空列表），先等行出现再扫描。
  const preferredNames = reusableExportTaskNames();
  const deadline = Date.now() + 20_000;
  let visibleNames: string[] = [];
  while (Date.now() < deadline) {
    const rows = dataRows(page);
    visibleNames = [];
    for (let index = 0; index < await rows.count(); index += 1) {
      visibleNames.push(((await rows.nth(index).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim());
    }
    for (const taskName of preferredNames) {
      const index = visibleNames.findIndex((text) => text.includes(taskName));
      if (index >= 0) return { taskName, rowText: visibleNames[index] };
    }
    await page.waitForTimeout(1_500);
  }
  throw new Error(
    `未找到可复用的自动化自有导出任务（优先：${preferredNames.join('、')}）。` +
      `可通过 DS_02_02_EXPORT_TASK_NAME 指定测试任务；当前首页任务：${visibleNames.join(' | ') || '（20s 内列表未渲染出任何行）'}`,
  );
}

/** 读取任务行当前文本（含调度状态/最新导出状态/导出次数），作为执行前基线。 */
export async function getExportTaskRowText(page: Page, taskName: string): Promise<string> {
  const row = dataRows(page).filter({ hasText: taskName }).first();
  await expect(row, `导出任务“${taskName}”未出现在导出列表中`).toBeVisible({ timeout: 15_000 });
  return ((await row.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
}

/** 调度状态判定：先排除“下线”再识别“上线”，避免“未上线”类文案误判为在线。 */
function rowSchedulingState(rowText: string): 'online' | 'offline' | 'unknown' {
  if (/下线/.test(rowText)) return 'offline';
  if (/上线/.test(rowText)) return 'online';
  return 'unknown';
}
/**
 * 将任务切到目标调度状态（true=上线 / false=下线）。已在目标状态时不操作
 * （任务约定：若已下线则不操作）。点击后轮询行文本确认状态真实翻转，
 * 不以 toast 作为判据。
 */
export async function setExportTaskState(page: Page, taskName: string, wantOnline: boolean): Promise<'already' | 'changed'> {
  const rowText = await getExportTaskRowText(page, taskName);
  const state = rowSchedulingState(rowText);
  if ((wantOnline && state === 'online') || (!wantOnline && state === 'offline')) return 'already';
  await clickExportTaskAction(page, taskName, wantOnline ? /上\s*线/ : /下\s*线/);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    const current = await getExportTaskRowText(page, taskName).catch(() => '');
    if (wantOnline ? rowSchedulingState(current) === 'online' : rowSchedulingState(current) === 'offline') return 'changed';
  }
  throw new Error(`导出任务“${taskName}”点击“${wantOnline ? '上线' : '下线'}”后 20s 内调度状态未翻转；行文本：${rowText}`);
}

/** 打开任务编辑页并等待表单就绪（编辑复用创建路由表单，保存走 /file/download/ftp/update）。 */
export async function openExportTaskEdit(page: Page, taskName: string): Promise<void> {
  await clickExportTaskAction(page, taskName, /编\s*辑/);
  await expect.poll(async () =>
    page.url().includes('/dataService/fileExport/') &&
    ((await page.getByText('来源表', { exact: true }).isVisible().catch(() => false)) ||
      (await page.getByRole('button', { name: /保\s*存/ }).isVisible().catch(() => false))),
    { timeout: 15_000 }).toBe(true);
  // 表单数据异步加载：等“基础文件名”出现非空值再返回，避免后续读取/回填与取数竞态
  // （run-20260917-142550-203 用例1 曾出现表单未就绪时保存点击被静默吞掉）。
  await expect.poll(async () =>
    (await readFormValueByLabel(page, '基础文件名').catch(() => undefined))?.trim() || '',
    { timeout: 15_000 }).not.toBe('');
}

/** 读取表单中指定标签输入框/文本域的当前值；找不到可见控件时返回 undefined。 */
export async function readFormValueByLabel(page: Page, label: string): Promise<string | undefined> {
  const pattern = new RegExp(`^\\s*\\*?\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：:]?\\s*$`);
  const byAria = page.getByLabel(pattern);
  for (let index = 0; index < await byAria.count(); index += 1) {
    const control = byAria.nth(index);
    if (await control.isVisible().catch(() => false)) return await control.inputValue().catch(() => undefined);
  }
  const labels = page.getByText(pattern);
  for (let index = 0; index < await labels.count(); index += 1) {
    const labelNode = labels.nth(index);
    if (!(await labelNode.isVisible().catch(() => false))) continue;
    let scope: Locator = labelNode;
    for (let level = 0; level < 10; level += 1) {
      const inputs = scope.locator('input:not([type="checkbox"]):not([type="radio"]), textarea');
      for (let inputIndex = 0; inputIndex < await inputs.count(); inputIndex += 1) {
        const candidate = inputs.nth(inputIndex);
        if (await candidate.isVisible().catch(() => false)) return await candidate.inputValue().catch(() => undefined);
      }
      scope = scope.locator('..');
    }
  }
  return undefined;
}

/** 解析 /file/download/ftp/update 响应：HTTP 200 不等于保存成功，必须业务码 000000。 */
async function readUpdateVerdict(response: Response): Promise<{ httpStatus: number; code: string; message: string }> {
  let payload: { code?: unknown; message?: unknown; object?: unknown } = {};
  try {
    payload = (await response.json()) as { code?: unknown; message?: unknown; object?: unknown };
  } catch {
    // 响应非 JSON 时保留 HTTP 状态断言，并在错误信息中给出状态码。
  }
  const code = String(payload.code ?? '');
  const message = String(payload.message ?? payload.object ?? '');
  if (!response.ok() || !/^(?:0|200|000000)$/.test(code)) {
    throw new Error(
      `文件导出任务编辑保存被后端拒绝：HTTP ${response.status()} POST /file/download/ftp/update => ` +
        `code=${code || '（无业务码）'}，message=${message || '（无消息）'}`,
    );
  }
  return { httpStatus: response.status(), code, message };
}

/** 收集页面可见的表单校验文案（最多 5 条），用于保存无请求时的诊断。 */
async function collectValidationHint(page: Page): Promise<string> {
  const texts: string[] = [];
  for (const node of await page.getByText(/必填|不能为空|请输入|请选择|请正确|格式不正确|请拖拽|请上传/)
    .filter({ visible: true }).all()) {
    const text = ((await node.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (text && !texts.includes(text)) texts.push(text);
    if (texts.length >= 5) break;
  }
  return texts.join(' | ');
}

/**
 * 编辑保存并核对 /file/download/ftp/update 业务响应。HTTP 200 不等于保存成功，
 * 必须确认业务码 000000；被拒绝时原样带出响应码与消息（如 ENV-01“任务更新失败-
 * 调度创建失败”），不把后端调度故障误报为前端无反馈。保存窗口 180 秒：创建链路
 * 实测后端“创建+调度”约 60 秒才响应，编辑同样要经过调度创建。
 * 点击“保存”后 30s 无请求时重试点击（run-20260917-142550-203 用例1 实证按钮
 * 已聚焦但提交被前端静默吞掉的偶发），总窗口内仍无请求才按前端拦截抛错。
 */
export async function saveExportTaskUpdate(page: Page): Promise<{ httpStatus: number; code: string; message: string }> {
  const isUpdateResponse = (response: Response): boolean =>
    response.request().method() === 'POST' && /\/file\/download\/ftp\/update(?:\?|$)/.test(response.url());
  const deadline = Date.now() + 180_000;
  let hint = '';
  let attempt = 0;
  for (;;) {
    attempt += 1;
    await clickVisibleButton(page, /保\s*存/);
    try {
      const response = await page.waitForResponse(isUpdateResponse, { timeout: 30_000 });
      return await readUpdateVerdict(response);
    } catch (error) {
      hint = await collectValidationHint(page);
      if (Date.now() >= deadline - 30_000) {
        throw new Error(
          `点击“保存”后 180s 内未发出 /file/download/ftp/update 请求（已重试 ${attempt} 次，前端校验拦截或按钮不可用）` +
            `${hint.trim() ? `；页面校验文案：${hint.trim()}` : '；页面无可见校验文案'}` +
            `；当前页面：${page.url()}（最后一次等待错误：${error instanceof Error ? error.message : String(error)}）`,
        );
      }
      // 按钮已被聚焦时补一次回车提交，再交由下一轮循环重新点击。
      await page.keyboard.press('Enter').catch(() => undefined);
      await page.waitForTimeout(2_000);
    }
  }
}

/**
 * 历史任务的调度表达式可能已失效；关闭“定时更新”开关后由“执行”按钮手工触发，
 * 不把无效 cron 引入本轮更新请求（DS-02-02 历史实现同款，best-effort 不作为判据）。
 * 优先在“定时更新”表单项内精确找开关，避免误点“任务失败报警通知”等其它开关。
 */
export async function disableScheduledUpdate(page: Page): Promise<void> {
  const scheduleItem = page.locator('.ant-form-item', { hasText: /定时更新/ })
    .filter({ has: page.getByRole('switch') }).first();
  if (await scheduleItem.isVisible().catch(() => false)) {
    const scoped = scheduleItem.getByRole('switch', { checked: true });
    if (await scoped.count()) {
      await scoped.first().click().catch(() => undefined);
      return;
    }
    return;
  }
  const switches = page.getByRole('switch', { checked: true });
  if (await switches.count()) await switches.last().click().catch(() => undefined);
}
/** “本轮执行”证据锚点：执行前的任务行文本快照 + 本轮唯一基础文件名 + 执行开始时间。 */
export interface ExportExecutionAnchor {
  preRowText: string;
  baseName: string;
  executeAtMs: number;
}

export interface ExportExecutionProof {
  rowText: string;
  evidence: string;
  /** 状态列未刷新而回退到实例核验时，这里带回实例核验结果，避免重复跳转。 */
  instance?: { rowText: string; matchedBy: string };
}

/** 行文本变化或导出次数增加都视为“本轮执行已在列表可见”；两者都无法观测时由实例核验兜底。 */
function executionObservedInRow(rowText: string, anchor: ExportExecutionAnchor): boolean {
  if (rowText !== anchor.preRowText) return true;
  const count = rowText.match(/导出次数\D*(\d+)/);
  const preCount = anchor.preRowText.match(/导出次数\D*(\d+)/);
  if (count && preCount) return Number(count[1]) > Number(preCount[1]);
  return false;
}

/**
 * 等待导出列表“最新导出状态”出现本轮成功终态。复用任务的历史状态可能已是
 * “执行成功”，传入 anchor 时要求行文本变化或导出次数增加，避免把历史成功
 * 误判为本轮结果；状态列迟迟不刷新时回退到实例记录核验（基础文件名为本轮
 * uuid，唯一）。出现失败终态立即失败并带出行内容。toast 不作为通过依据。
 */
export async function waitForExportTaskSuccess(
  page: Page,
  taskName: string,
  timeoutMs: number,
  anchor?: ExportExecutionAnchor,
): Promise<ExportExecutionProof> {
  const deadline = Date.now() + timeoutMs;
  let lastRowText = anchor?.preRowText ?? '';
  while (Date.now() < deadline) {
    const row = dataRows(page).filter({ hasText: taskName }).first();
    lastRowText = ((await row.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (/执行成功|导出成功/.test(lastRowText) && (!anchor || executionObservedInRow(lastRowText, anchor))) {
      return {
        rowText: lastRowText,
        evidence: anchor ? '行文本/导出次数较执行前变化且状态为成功终态' : '任务行出现成功终态',
      };
    }
    if (/失败|异常/.test(lastRowText) && (!anchor || executionObservedInRow(lastRowText, anchor))) {
      throw new Error(`导出任务“${taskName}”本轮执行失败，列表行内容：${lastRowText}`);
    }
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForTimeout(3_000);
  }
  if (anchor) {
    const instance = await verifyExportInstanceRecord(page, taskName, anchor.baseName, anchor.executeAtMs, 45_000)
      .catch((error: unknown) => {
        throw new Error(
          `导出任务“${taskName}”在 ${timeoutMs}ms 内未观察到本轮执行成功（最后一次行文本：${lastRowText || '（未读取到任务行）'}）；` +
            `实例核验也未通过：${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return {
      rowText: lastRowText,
      evidence: '列表状态列未刷新，但实例记录已实证本轮执行',
      instance,
    };
  }
  throw new Error(
    `导出任务“${taskName}”在 ${timeoutMs}ms 内未出现“执行成功”状态，` +
      `最后一次列表行内容：${lastRowText || '（未读取到任务行，列表可能未加载或任务不可见）'}`,
  );
}
/**
 * “查看实例”进入导出实例列表核验本轮执行：
 *   1) 实例行包含本轮基础文件名（uuid 唯一，绝不误匹配历史实例）；
 *   2) 或实例行状态成功且时间戳落在本轮执行窗口内（实例页不展示文件名时的替代证据）。
 * 复用任务存在历史实例，仅按任务名匹配等于没有核验，因此这里不接受任务名匹配。
 */
export async function verifyExportInstanceRecord(
  page: Page,
  taskName: string,
  baseName: string,
  executeAtMs: number,
  timeoutMs = 30_000,
): Promise<{ rowText: string; matchedBy: string }> {
  await clickExportTaskAction(page, taskName, /查看实例/);
  await expect(page).toHaveURL(/fileInstance|实例/, { timeout: 15_000 });
  // 实例列表可能分页；支持按任务名检索的页面先过滤，减少新实例不在首页的漏检。
  const applyTaskFilter = async (): Promise<void> => {
    await fillByLabel(page, '任务名称', taskName).catch(() => undefined);
  };
  await applyTaskFilter();
  const deadline = Date.now() + timeoutMs;
  let sampleRowText = '';
  let rounds = 0;
  while (Date.now() < deadline) {
    const rows = dataRows(page);
    for (let index = 0; index < await rows.count(); index += 1) {
      const text = ((await rows.nth(index).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (!sampleRowText) sampleRowText = text;
      if (baseName && text.includes(baseName)) {
        if (/失败|异常/.test(text)) {
          throw new Error(`导出实例出现本轮失败记录（基础文件名 ${baseName}）：${text}`);
        }
        return { rowText: text, matchedBy: '实例行包含本轮基础文件名' };
      }
      const occurred = text.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
      if (/成功/.test(text) && occurred) {
        const occurredAtMs = new Date(`${occurred[1]}T${occurred[2]}`).getTime();
        if (Number.isFinite(occurredAtMs) && occurredAtMs >= executeAtMs - 120_000) {
          return { rowText: text, matchedBy: '实例行状态成功且时间在本轮执行窗口内' };
        }
      }
    }
    rounds += 1;
    if (rounds % 2 === 0) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await applyTaskFilter();
    }
    await page.waitForTimeout(3_000);
  }
  throw new Error(
    `导出实例列表在 ${timeoutMs}ms 内未出现本轮执行实例（基础文件名前缀：${baseName}；` +
      `执行开始：${new Date(executeAtMs).toISOString()}）；实例页示例行：` +
      `${sampleRowText || '（实例列表为空：执行后无实例记录或当前账号无实例查看权限）'}`,
  );
}

/**
 * 测试机直连远端 FTP/SFTP，轮询远端目录出现本轮基础文件名的非空文件。
 * 只读核验（list），不做任何远端写入/清理；文件为 0 字节视为未真正落数据。
 * 2026-09-22 基线：按 FTP_PROTOCOL 自适应客户端——ftp（默认）走 basic-ftp
 * （明文 FTP，基线 192.168.76.113:2121、目录 /），sftp 走 ssh2-sftp-client
 * （22 端口）。目录与端口仍可用 FTP_FILE_PATH/FTP_PORT 覆盖。
 */
export async function findRemoteExportFile(baseName: string, timeoutMs = 60_000, dir?: string): Promise<string> {
  const host = process.env.FTP_HOST;
  const user = process.env.FTP_USER;
  const pass = process.env.FTP_PASS;
  if (!host?.trim() || !user?.trim() || !pass?.trim()) {
    throw new Error('缺少 FTP_HOST/FTP_USER/FTP_PASS 环境变量，无法进行远端文件核验');
  }
  const protocol = (process.env.FTP_PROTOCOL || 'ftp').toLowerCase();
  const targetDir = (dir ?? process.env.FTP_FILE_PATH ?? '/').replace(/\/?$/, '/');
  const port = Number(process.env.FTP_PORT || (protocol === 'sftp' ? '22' : '2121'));
  const deadline = Date.now() + timeoutMs;
  let matchedFile = '';
  let lastObservation = '远端目录尚未出现包含本轮基础文件名的文件';

  const scanOnce = (items: { name: string; size?: number }[]): boolean => {
    const hit = items.find((item) => item.name.includes(baseName));
    if (!hit) return false;
    // 文件存在还不够：0 字节空文件说明导出链路未真正落数据，继续等待写入完成。
    if ((hit.size ?? 0) > 0) {
      matchedFile = `${targetDir}${hit.name}（${hit.size} 字节）`;
      return true;
    }
    lastObservation = `文件已出现但为空文件（${hit.name}，size=${hit.size ?? '未知'}）`;
    return false;
  };

  if (protocol === 'sftp') {
    const sftp = new SftpClient();
    try {
      await sftp.connect({ host, port, username: user, password: pass });
      while (Date.now() < deadline) {
        const items = (await sftp.list(targetDir).catch(() => [])) as { name: string; size?: number }[];
        if (scanOnce(items)) break;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    } finally {
      await sftp.end().catch(() => undefined);
    }
  } else {
    const ftp = new FtpClient();
    try {
      await ftp.access({ host, port, user, password: pass, secure: false });
      while (Date.now() < deadline) {
        const items = await ftp.list(targetDir).catch(async () => {
          // 列表瞬时失败（服务端抖动/连接被回收）时重连一次，下一轮继续。
          await ftp.access({ host, port, user, password: pass, secure: false }).catch(() => undefined);
          return [];
        });
        if (scanOnce(items)) break;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    } finally {
      ftp.close();
    }
  }
  if (!matchedFile) {
    throw new Error(
      `远端目录 ${targetDir} 在 ${timeoutMs}ms 内未出现非空的本轮导出文件（前缀 ${baseName}，协议 ${protocol} ${host}:${port}）：${lastObservation}`,
    );
  }
  return matchedFile;
}
