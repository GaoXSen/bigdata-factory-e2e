/**
 * SM-03-08｜系统管理｜资源视角数据源权限增查改删（DS-PERM-93 清洁环境迁移版）
 *
 * 覆盖场景（Excel「测试用例」数据权限 · 资源视角 · 数据源权限；CRUD/双视角回显/
 * 权限类型与期限断言完整平移，不删减）：
 *   1. 资源视角先选 数据源类型→数据源，右侧授权列表按 主体类型（类型下拉，
 *      placeholder 全部类型）+ 主体关键字（搜索授权对象）查询；列头：主体类型/
 *      主体/权限类型/字段范围/权限截止时间/操作；
 *   2. 新增（批量授权弹窗）：授权对象类型=用户 → 勾选待选主体 → 数据源仅“管理”
 *      → 永久 → 确定添加；
 *   3. 列表回显：主体命中 / 权限类型恰为“管理” / 永久（落地值 2099-01-01）；
 *   4. 关键字语义：无关 UUID 关键字不命中，真实主体名重新命中；
 *   5. 编辑：永久 → 自定义未来时间（+7 天），权限类型显式保持“管理”；
 *   6. 用户视角回查：同一授权记录回显相同截止时间（两个入口一份数据）；
 *   7. 删除后：资源视角与用户视角均不再回显。
 *
 * DS-PERM-93 清洁环境迁移（替换历史固化资产依赖；结构对齐 SM-03-07 已验证闭环）：
 *   1. 不再依赖历史共享数据源（原 resolveMysqlPermissionResource 兜底固定显示名
 *      192.168.76.110:13306/e2e_test）：管理员经 UI 创建本轮唯一 MySQL 数据源
 *      （名称 e2esm0308ds_<uuid 派生>），JDBC 连接参数取配置中心 DB_*
 *      （utils.dbConfig，由 e2e/test-environment.ts 解析），DATA_PERMISSION_*
 *      仅作显式覆盖；DB_* 未配置或非 MySQL 按前置不足 skip（非永久 skip）。
 *   2. 本轮资产 UUID ASCII 唯一命名：成员（newPermissionIdentity + createAndInviteUser）、
 *      角色（newPermissionRole，数据地图/数据查询菜单，分配给成员）、唯一数据源与授权
 *      ——不依赖任何历史数据源/用户/角色/授权或固定凭据。
 *   3. finally 收尾按 DS-PERM-93 裁决口径（聚合自 SM-03-07/DS-PERM-87 已验证实现）：
 *      仅回收本轮资产（授权 → 数据源 → 成员 → 角色），逐项登记、单步失败不阻断
 *      其余回收；主流程失败保留原始错误并附加清理留证后重抛，主流程通过但清理
 *      未完成时用例判失败（不伪造通过、不误报产品缺陷）。数据源/成员/角色
 *      “页面未提供删除入口”属产品能力缺口，登记为收尾未完成并参与裁决。
 *   4. 控制台错误门禁保持运行期允许清单（getCreatedDataSource / dataPermission/
 *      4xx 过程信号 + 无权限提示，与 SM-03-07 同口径），其余控制台错误仍然失败。
 *
 * 业务规则（权限与审批测试理解.md §11.1、glm5.3-flash-05 页面探查 §2.4/§2.5）：
 * - 资源视角与用户视角是同一授权记录的两个入口；数据源权限（kind=2）仅承载“管理”，
 *   不涉及字段范围/表级明细，本用例不把数据源权限写成字段权限。
 *
 * 分工：SM-03-05 是数据源管理权限双视角 + 实际访问边界闭环；SM-03-07 是用户视角
 * CRUD 主链路；本用例是资源视角 CRUD 主链路（主体类型 + 关键字查询语义）。
 *
 * 关键要求：
 *   1. 全部为浏览器页面操作（无 fetch/axios 等接口直调）；
 *   2. 保存成功不以 toast 判定，一律以列表回显断言；
 *   3. 不使用永久 skip，不吞异常；页面结构与预期不符时保留明确失败。
 */
import type { Locator, Page } from '@playwright/test';
import { dbConfig, expect, test, uuid } from '../utils.js';
import {
  assignRoleToUser,
  createAndInviteUser,
  createRole,
  loginAs,
  newPermissionIdentity,
  newPermissionRole,
  openRoleManagement,
  openUserManagement,
} from './权限测试工具.js';
import {
  type MysqlPermissionResource,
  confirmPermissionDangerAction,
  deletePermissionFromRow,
  dismissPermissionDropdown,
  findPermissionRowAcrossPages,
  findResourceViewAuthorizationRow,
  openDataPermissionPage,
  openPermissionEditDialog,
  queryUserViewPermissionRowAcrossPages,
  refreshPermissionList,
  selectUserViewSubject,
  setPermissionExpiry,
  setPermissionTypes,
  submitPermissionDialog,
  submitPermissionEditDialog,
  switchResourceViewScopeTab,
} from './数据权限闭环工具.js';
import { requirePermissionApprovalEnvironment } from './权限审批待调试工具.js';
import { clickVisible, expectSuccess, visible, visibleDialog } from '../抽样用例工具.js';

/* ------------------------------------------------------------------ 常量 */

const ADMIN_USER = process.env.TEST_USER ?? 'admin';
// 连接信息（DS-PERM-93）：以配置中心 DB_*（utils.dbConfig，e2e/test-environment.ts 解析）
// 为准，DATA_PERMISSION_* 仅作显式覆盖，不硬编码环境 IP/口令。未配置时用例内按
// 前置不足 skip（见用例本体门禁），非永久 skip。
const ROUND_DB = dbConfig();
const MYSQL_HOST = process.env.DATA_PERMISSION_HOST?.trim() || ROUND_DB?.host || '';
const MYSQL_PORT = String(process.env.DATA_PERMISSION_PORT?.trim() || ROUND_DB?.port || '');
const MYSQL_DB = process.env.DATA_PERMISSION_DATABASE?.trim() || ROUND_DB?.database || '';
const MYSQL_USER = process.env.DATA_PERMISSION_DB_USER?.trim() || ROUND_DB?.user || '';
const MYSQL_PASS = process.env.DATA_PERMISSION_DB_PASS?.trim() || ROUND_DB?.password || '';
const JDBC_URL =
  `jdbc:mysql://${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DB}`
  + '?allowMultiQueries=true&characterEncoding=utf-8';
/** MySQL 驱动类（新建第二步“驱动类”必填项；与后端 dataSourceProperties 存量值一致）。 */
const MYSQL_DRIVER = process.env.DATA_PERMISSION_DRIVER?.trim() || 'com.mysql.cj.jdbc.Driver';

/** 本轮唯一英文前缀数据源名（uuid 派生 ASCII；授权/回收/删除都只认这个名字）。 */
const SOURCE_PREFIX = 'e2esm0308ds';
const SOURCE_NAME = `${SOURCE_PREFIX}_${uuid().replace(/-/g, '').slice(0, 10)}`;

/**
 * 本轮唯一 MySQL 数据源（kind=2 数据源权限，不涉及表级明细/字段范围）。
 * databaseName/schemaName 取配置中心解析结果，不再指向历史固定显示名；携带
 * tableName 属配置串台，本用例的资源字面量从不设置它。
 */
const permissionResource: MysqlPermissionResource = {
  sourceTypeName: 'MYSQL',
  sourceName: SOURCE_NAME,
  databaseName: MYSQL_DB,
  schemaName: MYSQL_DB,
};

/** 管理员登录身份（执行脚本注入 TEST_USER/TEST_PASS；收尾回收时切回管理员）。 */
const adminIdentity = {
  userName: ADMIN_USER,
  nickname: ADMIN_USER,
  password: process.env.TEST_PASS ?? '',
  phone: '',
  email: '',
};

/** 弹层选项通用选择器（Ant/Element 双兼容，与闭环工具同源形态）。 */
const AUTHORIZATION_OPTION_SELECTOR = [
  '[role="option"]:visible',
  '.ant-select-item-option:visible',
  '.el-select-dropdown__item:visible',
  'option:visible',
].join(', ');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

/** 返回 locator 中最后一个可见元素（DOM 序最深，子串匹配时用于选中叶节点）。 */
async function lastVisible(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

/** 打开资源视角“新建权限”批量授权弹窗（资源已选中时按钮才可用，页面已知规则）。 */
async function openResourceViewCreateDialog(page: Page): Promise<Locator> {
  const create = page.getByRole('button', { name: /新建权限|新增/ }).last();
  await expect
    .poll(async () => create.isEnabled().catch(() => false), {
      timeout: 10_000,
      message: '资源视角“新建权限”按钮不可用：请确认已先选中数据源/数据表。',
    })
    .toBe(true);
  await create.click();
  const dialog = page.locator('[role="dialog"], .ant-modal, .el-dialog').last();
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  return dialog;
}

/** 选择弹窗内“授权对象类型”（radio，默认用户；页面文案按候选逐个匹配）。 */
async function chooseAuthorizationSubjectType(
  page: Page,
  dialog: Locator,
  candidates: string[],
): Promise<string> {
  // 弹窗“授权对象类型”实际是下拉框（默认“用户”，error-context 已核）：已显示
  // 目标类型时直接沿用默认，不点开下拉引入浮层遮挡；默认值不在候选时才退回
  // 按文本逐个点击切换。
  for (const candidate of candidates) {
    const selected = await firstVisible(
      dialog
        .locator('[role="combobox"], .ant-select-selection-item, .el-select__selected-item')
        .filter({ hasText: candidate }),
    );
    if (selected) return candidate;
  }
  for (const candidate of candidates) {
    const label = await firstVisible(dialog.getByText(candidate, { exact: true }));
    if (label) {
      await label.click();
      await page.waitForTimeout(300);
      return candidate;
    }
  }
  throw new Error(
    `资源视角新建弹窗未找到“授权对象类型”候选（${candidates.join('、')}）；`
      + `请按实际页面校准文案，当前页面：${page.url()}`,
  );
}

/**
 * 在批量授权弹窗待选列表中勾选目标主体：先尝试弹窗内搜索框过滤，再按用户名/昵称
 * 定位文本并上溯勾选行复选框（逐行授权）；无复选框版本点击主体名本身，最终以提交后
 * 的授权行回显兜底验证（不猜测选择成功）。
 */
async function checkAuthorizationSubject(
  page: Page,
  dialog: Locator,
  subject: { userName: string; nickname?: string },
): Promise<void> {
  const searchBox = await firstVisible(dialog.getByPlaceholder(/搜索|关键字|用户名|账号/));
  if (searchBox) {
    await searchBox.fill(subject.userName).catch(() => undefined);
    await page.waitForTimeout(500);
  }
  const names = [subject.userName, subject.nickname].filter((item): item is string => Boolean(item));
  let target: Locator | undefined;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !target) {
    for (const name of names) {
      // 先试整段精确匹配；页面实际把“userName(nickname)”渲染成一行组合文本
      // （error-context 已核，精确匹配命中不了），退回子串匹配并取 DOM 序最后
      // 的可见节点（最内层叶节点），保证上溯复选框从主体行自身开始。
      target = await firstVisible(dialog.getByText(name, { exact: true }));
      if (target) break;
      target = await lastVisible(dialog.getByText(name));
      if (target) break;
    }
    if (!target) await page.waitForTimeout(300);
  }
  if (!target) {
    throw new Error(
      `资源视角新建弹窗待选列表未找到主体“${subject.userName}”；请确认账号存在且当前组织树下可见，`
        + `当前页面：${page.url()}`,
    );
  }
  let scope: Locator | undefined = target;
  for (let level = 0; level < 6 && scope; level += 1) {
    const native = scope.locator('input[type="checkbox"]').first();
    if (await native.count()) {
      if (!(await native.isChecked().catch(() => false))) {
        const wrapper = native.locator('xpath=ancestor::label[1]').first();
        if (await wrapper.count()) await wrapper.click({ force: true });
        else await native.setChecked(true, { force: true });
      }
      await expect
        .poll(async () => native.isChecked().catch(() => false), {
          timeout: 5_000,
          message: `待选主体“${subject.userName}”复选框未能勾选`,
        })
        .toBe(true);
      return;
    }
    const roleCheckbox = await firstVisible(scope.locator('[role="checkbox"]'));
    if (roleCheckbox) {
      if ((await roleCheckbox.getAttribute('aria-checked').catch(() => null)) !== 'true') {
        await roleCheckbox.click();
      }
      await expect
        .poll(
          async () => (await roleCheckbox.getAttribute('aria-checked').catch(() => null)) === 'true',
          { timeout: 5_000, message: `待选主体“${subject.userName}”语义复选框未能勾选` },
        )
        .toBe(true);
      return;
    }
    scope = scope.locator('..');
  }
  await target.click();
  await page.waitForTimeout(300);
}

/**
 * 右侧授权列表按“主体类型 + 主体关键字”查询：类型下拉（placeholder 全部类型，Ant/Element
 * 占位形态双兼容）→ 选项文本按候选匹配并回显实际选项；关键字填入“搜索授权对象”并回车触发查询。
 */
async function filterResourceViewAuthorizations(
  page: Page,
  options: { subjectTypeCandidates?: string[]; keyword?: string },
): Promise<void> {
  if (options.subjectTypeCandidates?.length) {
    let anchor = await firstVisible(page.getByPlaceholder('全部类型'));
    if (!anchor) anchor = await firstVisible(page.getByText('全部类型', { exact: true }));
    if (!anchor) {
      throw new Error(`资源视角授权列表未找到“类型”筛选（placeholder 全部类型），当前页面：${page.url()}`);
    }
    let typeBox: Locator | undefined;
    let node: Locator = anchor;
    for (let level = 0; level < 6 && !typeBox; level += 1) {
      typeBox = await firstVisible(node.locator('.ant-select:visible, .el-select:visible, [role="combobox"]:visible'));
      if (!typeBox) node = node.locator('..');
    }
    if (!typeBox) {
      throw new Error(`资源视角“类型”筛选未定位到下拉控件，当前页面：${page.url()}`);
    }
    await typeBox.click();
    const wanted = new RegExp(options.subjectTypeCandidates.map(escapeRegExp).join('|'));
    let matched: Locator | undefined;
    const seen: string[] = [];
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline && !matched) {
      const optionList = page.locator(AUTHORIZATION_OPTION_SELECTOR);
      const count = await optionList.count();
      for (let index = 0; index < count; index += 1) {
        const option = optionList.nth(index);
        const text = (await option.innerText().catch(() => '')).trim();
        if (!text || seen.includes(text)) continue;
        seen.push(text);
        if (wanted.test(text)) {
          matched = option;
          break;
        }
      }
      if (!matched) await page.waitForTimeout(250);
    }
    if (!matched) {
      throw new Error(
        `资源视角“类型”下拉没有候选 ${options.subjectTypeCandidates.join('、')}（实际选项：${seen.join('、') || '无'}）；`
          + '请按实际页面校准主体类型文案。',
      );
    }
    await matched.click();
    await dismissPermissionDropdown(page);
    await page.waitForTimeout(400);
  }
  if (options.keyword !== undefined) {
    const search =
      (await firstVisible(page.getByPlaceholder('搜索授权对象')))
      ?? (await firstVisible(page.getByRole('textbox', { name: /搜索授权对象/ })));
    if (!search) {
      throw new Error(`资源视角授权列表未找到“搜索授权对象”输入框，当前页面：${page.url()}`);
    }
    await search.fill(options.keyword);
    await search.press('Enter').catch(() => undefined);
    await refreshPermissionList(page);
    await page.waitForTimeout(600);
  }
}

/** 生成“当前或次月”范围内的自定义到期时间（闭环工具日历只允许这两档月份）。 */
function futureExpiryTime(daysAhead: number): string {
  const target = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())} 23:59:59`;
}

/** 行级精确断言：权限类型应恰为期望值（双选/缺失都会失败并回显行文本，便于校准）。 */
async function expectRowExactPermissionType(row: Locator, expected: '使用' | '管理'): Promise<void> {
  const text = await row.innerText();
  const normalized = /使用/.test(text) ? '使用' : /管理/.test(text) ? '管理' : '无';
  expect(
    normalized,
    `授权行权限类型应为“${expected}”，实际归一结果“${normalized}”，行文本：${text.replace(/\s+/g, ' ').slice(0, 160)}`,
  ).toBe(expected);
}

/* --------------------------------------------- 本轮资产管理 helper（DS-PERM-93） */

/** 下拉选项通用可见选择器（Ant/Element 双兼容，与共享工具同款）。 */
const OPTION_SELECTOR = [
  '.ant-select-dropdown:visible .ant-select-item-option',
  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
  '.el-select-dropdown:visible .el-select-dropdown__item',
  '[role="listbox"]:visible [role="option"]',
].join(', ');

/** 通用表单文本填写：label → placeholder → 表单节点 三路兜底；返回是否命中。 */
async function fillField(scope: Locator, labels: string[], value: string): Promise<boolean> {
  for (const label of labels) {
    const candidates = [
      scope.getByLabel(label, { exact: false }),
      scope.getByPlaceholder(new RegExp(label)),
      scope
        .locator('.ant-form-item:visible, .el-form-item:visible')
        .filter({ hasText: label })
        .locator('input:visible, textarea:visible'),
    ];
    for (const candidate of candidates) {
      const field = candidate.first();
      if (await field.isVisible().catch(() => false)) {
        await field.fill(value);
        return true;
      }
    }
  }
  return false;
}

/** 通用下拉选择：按 label 定位表单项内 select，点开后按精确文本选选项。 */
async function pickSelectOption(
  scope: Locator,
  labels: string[],
  optionText: string,
): Promise<boolean> {
  for (const label of labels) {
    const item = scope
      .locator('.ant-form-item:visible, .el-form-item:visible')
      .filter({ hasText: label })
      .first();
    if (!(await item.isVisible().catch(() => false))) continue;
    const select = item
      .locator('.ant-select:visible, .el-select:visible, [role="combobox"]:visible')
      .first();
    if (!(await select.isVisible().catch(() => false))) continue;
    await select.click();
    const optionLoc = scope
      .page()
      .locator(OPTION_SELECTOR)
      .filter({ hasText: new RegExp(`^\\s*${optionText}\\s*$`) })
      .first();
    await optionLoc.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
    if (await optionLoc.isVisible().catch(() => false)) {
      await optionLoc.click();
      return true;
    }
    await scope.page().keyboard.press('Escape');
  }
  return false;
}

/** 打开 数据接入 → 数据源管理 页面。 */
async function openDataSourceManagement(page: Page): Promise<void> {
  await clickVisible(page, '数据接入');
  await clickVisible(page, '数据源管理');
  await page.waitForTimeout(1_200);
}

/** 管理员新建 MYSQL 数据源（表单字段多形态兜底；失败留明确错误）。 */
async function createRoundMysqlDataSource(page: Page, name: string): Promise<void> {
  await openDataSourceManagement(page);
  const newButton = (await visible(page.getByRole('button', { name: /新(建|增|添)|添加数据源/ })))
    ?? (await visible(page.getByText(/^(新(建|增|添)|添加数据源)$/, { exact: true })));
  if (!newButton) throw new Error('数据源管理页未找到“新建/新增”入口（可能受按钮权限控制）。');
  await newButton.click();
  const typeDialog = await visibleDialog(page);
  const mysqlCard = await visible(typeDialog.getByText(/MYSQL|MySQL/i).first());
  if (mysqlCard) {
    await mysqlCard.click();
  } else if (!await pickSelectOption(typeDialog, ['数据源类型', '类型', '数据库类型'], 'MYSQL')) {
    throw new Error('数据源新建弹窗未找到 MYSQL 类型选择入口（卡片与下拉均未命中）。');
  }
  // 新建为两步向导：第一步仅选类型，点“下一步”后才是名称/连接信息表单。
  const nextButton = await visible(typeDialog.getByRole('button', { name: /下一步/ }));
  if (nextButton) await nextButton.click();
  const dialog = await visibleDialog(page);
  if (!await fillField(dialog, ['数据源名称', '名称', '源名称'], name)) {
    throw new Error('数据源新建弹窗未找到“数据源名称”输入框。');
  }
  // 第二步表单：数据源名称/数据源描述/驱动类(必填)/链接地址(必填)/用户名(必填)/
  // 密码(必填) + Druid连接池参数(可选表格)；无 主机/端口/数据库名 字段，连接信息由
  // JDBC URL 承载（SM-03-07 trace 实证同型页面）。
  if (!await fillField(dialog, ['驱动类'], MYSQL_DRIVER)) {
    throw new Error('数据源新建弹窗未找到“驱动类”必填输入框。');
  }
  // 链接地址 = JDBC URL（产品标签为“链接地址”；主机/端口形态仅作旧页面兜底）。
  if (!await fillField(dialog, ['链接地址', 'URL', '连接地址', 'JDBC'], JDBC_URL)) {
    const hostOk = await fillField(dialog, ['主机', 'IP', '服务器'], MYSQL_HOST);
    await fillField(dialog, ['端口'], MYSQL_PORT);
    if (!hostOk) throw new Error('数据源新建弹窗既无 链接地址 也无 主机/IP 输入框，无法完成连接信息。');
  }
  if (!await fillField(dialog, ['用户名', '用户', '账号'], MYSQL_USER)) {
    throw new Error('数据源新建弹窗未找到“用户名”输入框。');
  }
  if (!await fillField(dialog, ['密码'], MYSQL_PASS)) {
    throw new Error('数据源新建弹窗未找到“密码”输入框。');
  }
  await fillField(dialog, ['备注', '描述'], `SM-03-08 DS-PERM-93 ${SOURCE_PREFIX}`);
  // 先测试连接（结果 toast 不作为通过依据，连接失败也允许继续提交，以最终“列表
  // 回显”为创建成功判据），再确 定 提交。
  const testConnection = await visible(dialog.getByRole('button', { name: /测\s*试\s*连\s*接/ }));
  if (testConnection) {
    await testConnection.click();
    await page.waitForTimeout(4_000);
  }
  await dialog.getByRole('button', { name: /确\s*定|保\s*存|完\s*成/ }).last().click();
  await expectSuccess(page, /成功|新增|保存/);
  await expect(
    page.getByText(name, { exact: true }).first(),
    `新建数据源 ${name} 后未在数据源管理列表回显。`,
  ).toBeVisible({ timeout: 20_000 });
}

/**
 * 数据源“删除”二次确认弹窗：新版为高危操作弹窗，需在
 * input[placeholder="请输入DELETE"] 键入 DELETE 后点击“确 认”按钮
 * （SM-03-07 trace 实证；旧版“确 定”按钮已不存在）。
 */
async function confirmRemoveDataSource(page: Page): Promise<void> {
  const modal = page
    .locator('.ant-modal:visible, .el-dialog:visible, [role="dialog"]:visible')
    .last();
  await modal.waitFor({ state: 'visible', timeout: 8_000 });
  const typed = modal.locator('input[placeholder="请输入DELETE"]:visible').first();
  if (await typed.isVisible().catch(() => false)) {
    await typed.fill('DELETE');
  }
  await modal.getByRole('button', { name: /确\s*认|删\s*除/ }).last().click();
}

/**
 * 删除本轮唯一数据源（卡片级定位，严禁页面级删除图标兜底 —— 严禁误点共享源）。
 * 返回 deleted（已删除且复查卡片不再回显）/ absent（本来不存在）/ no-entry
 * （页面未提供删除入口，属产品能力缺口）/ delete-not-effective（点了删除但卡片仍在）。
 */
async function deleteRoundDataSource(
  page: Page,
  sourceName: string,
): Promise<'deleted' | 'absent' | 'no-entry' | 'delete-not-effective'> {
  await openDataSourceManagement(page);
  const card = page
    .locator('.data-source:visible')
    .filter({ hasText: sourceName })
    .first();
  if (!(await card.isVisible().catch(() => false))) return 'absent';
  const del = card
    .locator('[aria-label="图标: delete"], [aria-label*="delete" i], .anticon-delete, [class*="icon-delete"]')
    .first();
  if (!(await del.isVisible().catch(() => false))) return 'no-entry';
  await del.click();
  await confirmRemoveDataSource(page);
  await expectSuccess(page, /成功|删除/);
  await page.waitForTimeout(800);
  // 删除后按同名复查：卡片不再回显才算删除生效（与“列表回显为唯一证据”一致）。
  const again = page
    .locator('.data-source:visible')
    .filter({ hasText: sourceName })
    .first();
  return (await again.isVisible().catch(() => false)) ? 'delete-not-effective' : 'deleted';
}

/** 错误信息压缩为单行短文本（仅供清理步骤登记，不在清理路径抛出）。 */
function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * 触发“删除/移除”：行内文本按钮 → 行内图标（均严格限定在匹配行内）。
 * 不做页面级图标兜底：匹配行无删除入口时返回 false，由调用方按
 * “页面未提供删除入口”登记（不冒充业务断言失败），绝不点其他行的图标。
 */
async function clickDeleteAction(scope: Locator): Promise<boolean> {
  const textButton = scope.getByRole('button', { name: /删\s*除|移\s*除/ }).first();
  if (await textButton.isVisible().catch(() => false)) {
    await textButton.click();
    return true;
  }
  const rowIcon = scope
    .locator('[aria-label*="delete" i], [aria-label*="删除"], .anticon-delete, [class*="icon-delete"]')
    .first();
  if (await rowIcon.isVisible().catch(() => false)) {
    await rowIcon.click();
    return true;
  }
  return false;
}

/**
 * 在用户管理/角色管理页按唯一名称删除单个对象并复查列表。
 * 返回 deleted（已删除且复查不再回显）/ absent（本来不存在）/ no-entry（页面未
 * 提供删除入口，属产品能力缺口）/ delete-not-effective（点了删除但行仍在）。
 */
async function deleteNamedRow(
  page: Page,
  options: { queryName: string; name: string; openPage: () => Promise<void> },
): Promise<'deleted' | 'absent' | 'no-entry' | 'delete-not-effective'> {
  await options.openPage();
  const query = page.getByRole('textbox', { name: options.queryName }).first();
  await query.fill(options.name);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  const nameText = page.getByText(options.name, { exact: true }).last();
  await nameText.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
  if (!(await nameText.isVisible().catch(() => false))) return 'absent';
  const row = nameText.locator(
    'xpath=ancestor::*[self::tr or @role="row" or contains(@class,"el-table__row")][1]',
  );
  if (!(await clickDeleteAction(row))) return 'no-entry';
  await confirmPermissionDangerAction(page);
  await page.waitForTimeout(1_000);
  // 删除后按同名复查：列表不再回显才算删除生效（与“列表回显为唯一证据”一致）。
  await query.fill(options.name);
  await page.getByRole('button', { name: /查\s*询|搜\s*索/ }).first().click();
  await page.waitForTimeout(1_000);
  const again = page.getByText(options.name, { exact: true }).last();
  return (await again.isVisible().catch(() => false)) ? 'delete-not-effective' : 'deleted';
}

/**
 * 资源视角回收本轮主体在本轮数据源上的全部授权行（打开目标源 → 逐行删除）。
 * 全新本轮组合正常 0 条，防御同键重试轮次。DS-PERM-93：返回 leftover——删除预算
 * 耗尽后仍回显 = 本步回收未完成，由调用方如实登记进 issues（不扩大删除范围，
 * 也不静默放行）。
 */
async function revokeRoundPermissions(
  page: Page,
  resource: MysqlPermissionResource,
  subjectName: string,
): Promise<{ removed: number; leftover: boolean }> {
  await openDataPermissionPage(page);
  let removed = 0;
  for (let guard = 0; guard < 5; guard += 1) {
    const stale = await findResourceViewAuthorizationRow(page, {
      resource,
      subjectName,
      scopeTab: '数据源',
      timeoutMs: 4_000,
    });
    if (!stale) break;
    await deletePermissionFromRow(page, stale, { uniqueText: subjectName });
    removed += 1;
  }
  const leftover = !!(await findResourceViewAuthorizationRow(page, {
    resource,
    subjectName,
    scopeTab: '数据源',
    timeoutMs: 3_000,
  }));
  return { removed, leftover };
}

/**
 * try/finally 兜底清理入口：只回收本轮 uuid 资产（授权行 e2esm0308ds_* × 本轮成员、
 * 本轮唯一数据源、本轮成员账号、本轮角色）。每步独立 try/catch：单步失败登记后
 * 继续下一步。DS-PERM-93 裁决口径：issues 非空 = 收尾未完成——通过路径必须判失败；
 * 主体失败路径在错误信息上附加 issues 证据后原样重抛（见用例 finally）。数据源/
 * 成员/角色“无删除入口”属产品能力缺口，登记为收尾未完成并参与裁决（不冒充业务
 * 断言失败，也不静默放行）。
 */
async function cleanupCaseObjects(
  page: Page,
  scope: { userName: string; roleName: string; resource: MysqlPermissionResource },
): Promise<{ steps: string[]; issues: string[] }> {
  const steps: string[] = [];
  const issues: string[] = [];
  const runStep = async (
    name: string,
    action: () => Promise<{ ok: boolean; detail: string }>,
  ): Promise<void> => {
    try {
      const { ok, detail } = await action();
      steps.push(`${name}：${detail}`);
      if (!ok) issues.push(`${name}：${detail}`);
    } catch (error) {
      const detail = `失败：${describeError(error)}`;
      steps.push(`${name}：${detail}`);
      issues.push(`${name}：${detail}`);
    }
  };

  try {
    await loginAs(page, adminIdentity);
  } catch (error) {
    issues.push(`管理员重新登录失败，兜底清理中止：${describeError(error)}`);
    return { steps, issues };
  }

  await runStep('本轮授权回收（仅 本轮成员 × 本轮数据源，资源视角）', async () => {
    const { removed, leftover } = await revokeRoundPermissions(page, scope.resource, scope.userName);
    return {
      ok: !leftover,
      detail: leftover
        ? `removed=${removed}；预算耗尽后仍回显本轮数据源授权行（回收未完成）`
        : `removed=${removed}；已无本轮数据源授权行`,
    };
  });
  await runStep('本轮数据源删除（仅本轮唯一命名 e2esm0308ds_*，卡片级定位）', async () => {
    const outcome = await deleteRoundDataSource(page, SOURCE_NAME);
    return {
      ok: outcome === 'deleted' || outcome === 'absent',
      detail: outcome === 'no-entry'
        ? 'no-entry（页面未提供删除入口，数据源残留在案）'
        : outcome === 'delete-not-effective'
          ? 'delete-not-effective（已提交删除但卡片仍回显）'
          : outcome,
    };
  });
  await runStep('本轮成员删除', async () => {
    const outcome = await deleteNamedRow(page, {
      queryName: '请输入用户名称',
      name: scope.userName,
      openPage: () => openUserManagement(page),
    });
    return {
      ok: outcome === 'deleted' || outcome === 'absent',
      detail: outcome === 'no-entry'
        ? 'no-entry（页面未提供删除/移除入口，成员残留在案）'
        : outcome,
    };
  });
  await runStep('本轮角色删除', async () => {
    const outcome = await deleteNamedRow(page, {
      queryName: '请输入角色名称',
      name: scope.roleName,
      openPage: () => openRoleManagement(page),
    });
    return {
      ok: outcome === 'deleted' || outcome === 'absent',
      detail: outcome === 'no-entry'
        ? 'no-entry（页面未提供删除入口，角色残留在案）'
        : outcome,
    };
  });
  return { steps, issues };
}

test.describe.configure({ mode: 'serial', timeout: 600_000 });
test('SM-03-08｜系统管理｜资源视角数据源权限增查改删', async ({ loginPage, consoleErrors, report }) => {
  requirePermissionApprovalEnvironment();
  // 门禁（DS-PERM-93）：本轮唯一数据源要求 DB_* 指向可直连 MySQL；未配置按前置
  // 不足 skip（写明原因，不伪造通过、不误报产品缺陷，非永久 skip）。
  if (!ROUND_DB || ROUND_DB.type !== 'mysql' || !MYSQL_USER || !MYSQL_PASS) {
    test.skip(
      !ROUND_DB || ROUND_DB.type !== 'mysql' || !MYSQL_USER || !MYSQL_PASS,
      `前置不足：未配置可直连 MySQL（DB_HOST=${process.env.DB_HOST ?? ''}，DB_TYPE=${process.env.DB_TYPE ?? ''}），`
        + '无法创建本轮唯一数据源（DS-PERM-93）。',
    );
    return;
  }
  const page = loginPage;

  // 本轮唯一主体/角色（uuid ASCII 唯一命名，只由本轮创建、收尾回收）。
  const applicant = newPermissionIdentity('sm0308a');
  const applicantRole = newPermissionRole('sm0308', 'subject');
  // 资源视角 CRUD 全程只针对本轮唯一数据源（阶段1-7 原断言保持不动）。
  const resource = permissionResource;

  // 业务闭环主流程集中在一个闭包里：任何一处失败都会先进入下方 finally 执行兜底
  // 清理，再以原始错误结束用例（保留真实失败原因不被掩盖，DS-PERM-93）。
  let mainError: unknown;
  let mainFailed = false;
  try {
    // 阶段 0a：本轮唯一主体 —— 新建成员（创建+邀请，与 SM-00-02 同型工具）→
    // 新建角色（数据地图/数据查询菜单）→ 角色分配给成员。不依赖任何历史固化用户/角色；
    // 运行级主体对本轮数据源默认无授权。
    await createAndInviteUser(page, applicant);
    await createRole(page, applicantRole, ['数据地图', '数据查询']);
    await assignRoleToUser(page, applicantRole, applicant);
    await report(
      'SM-03-08 阶段0a｜创建本轮唯一主体与角色',
      true,
      `成员=${applicant.userName}；角色=${applicantRole.roleName}（菜单=数据地图/数据查询，已分配给成员）。`,
    );

    // 阶段 0b（DS-PERM-93）：管理员创建本轮唯一 MySQL 数据源（JDBC 指向配置中心
    // DB_* 解析的库）；后续授权/回收仅针对该源，不再依赖历史共享数据源与固定连接信息。
    await createRoundMysqlDataSource(page, SOURCE_NAME);
    await report(
      'SM-03-08 阶段0b｜创建本轮唯一数据源',
      true,
      `数据源=${SOURCE_NAME}（JDBC 指向配置中心 DB_* 解析的库）；后续授权/回收仅针对该源。`,
    );

    // 阶段 0c（清理）：仅清理“本轮主体 × 本轮数据源”的数据源授权残留（全新本轮
    // 组合正常 0 条，防同键重试），保证本轮从无授权起步；删除预算耗尽仍回显 =
    // 起步不洁，直接失败（资源视角逐行删除并复查，不静默放行）。
    const purgedStale = await revokeRoundPermissions(page, permissionResource, applicant.userName);
    if (purgedStale.leftover) {
      throw new Error(
        `阶段0清理后资源视角仍回显本轮数据源授权行（removed=${purgedStale.removed}），不能继续新增。`,
      );
    }
    await report(
      'SM-03-08 阶段0c｜残留权限清理',
      true,
      `主体=${applicant.userName}；数据源=${SOURCE_NAME}；本轮清理残留记录 ${purgedStale.removed} 条`
        + '（0=全新本轮组合首次执行；仅限本轮uuid资产）。',
    );

    // 阶段1（查·负向）：按 主体类型=用户 + 关键字=主体名 查询，清理后不应回显授权行。
    await filterResourceViewAuthorizations(page, {
      subjectTypeCandidates: ['用户', '成员'],
      keyword: applicant.userName,
    });
    if (
      await findResourceViewAuthorizationRow(page, {
        resource,
        subjectName: applicant.userName,
        scopeTab: '数据源',
        timeoutMs: 4_000,
      })
    ) {
      throw new Error('阶段0清理后资源视角仍回显该主体的数据源授权行，不能继续新增。');
    }

    // 阶段2（增）：批量授权弹窗＝授权对象类型(用户)→勾选待选主体→数据源仅“管理”→永久→确定添加。
    const dialog = await openResourceViewCreateDialog(page);
    await chooseAuthorizationSubjectType(page, dialog, ['用户', '成员']);
    await checkAuthorizationSubject(page, dialog, applicant);
    await setPermissionTypes(page, dialog, ['管理']);
    await setPermissionExpiry(page, dialog, '永久');
    await submitPermissionDialog(page, dialog);
    await report(
      'SM-03-08 阶段2｜资源视角新增数据源“管理”权限（永久）',
      true,
      `主体=${applicant.userName}；资源=${SOURCE_NAME}；批量授权弹窗已提交，成败仅以下方列表回显断言为依据。`,
    );

    // 阶段3（查·正向）：同一查询条件下回显授权行——主体 / 恰为“管理” / 永久(2099 落地)。
    const createdRow = await findResourceViewAuthorizationRow(page, {
      resource,
      subjectName: applicant.userName,
      scopeTab: '数据源',
      timeoutMs: 15_000,
    });
    if (!createdRow) {
      throw new Error(`资源视角新建后未回显主体 ${applicant.userName} 对 ${resource.sourceName} 的授权行。`);
    }
    await expect(createdRow).toContainText(applicant.userName);
    await expectRowExactPermissionType(createdRow, '管理');
    await expect(createdRow).toContainText(/永久|2099/);

    // 阶段4（查·关键字语义）：无关 UUID 关键字不应命中；真实主体名应重新命中。
    const noiseKeyword = `nohit_${uuid().slice(0, 8)}`;
    await filterResourceViewAuthorizations(page, { keyword: noiseKeyword });
    if (
      await findResourceViewAuthorizationRow(page, {
        resource,
        subjectName: applicant.userName,
        scopeTab: '数据源',
        timeoutMs: 4_000,
      })
    ) {
      throw new Error(`按无关关键字“${noiseKeyword}”仍命中授权行：主体关键字查询未生效。`);
    }
    await filterResourceViewAuthorizations(page, { keyword: applicant.userName });
    const refilteredRow = await findResourceViewAuthorizationRow(page, {
      resource,
      subjectName: applicant.userName,
      scopeTab: '数据源',
      timeoutMs: 12_000,
    });
    if (!refilteredRow) throw new Error('按真实主体关键字重新查询后未命中授权行：主体关键字查询未生效。');
    await report(
      'SM-03-08 阶段3/4｜新增回显与关键字语义',
      true,
      '授权行已回显：主体命中、权限类型恰为“管理”、期限=永久；无关 UUID 关键字不命中，真实主体关键字重新命中。',
    );

    // 阶段5（改）：编辑改为自定义到期时间（7 天后）；权限类型显式保持“管理”（编辑为整体覆盖）。
    const editedExpiry = futureExpiryTime(7);
    const editDialog = await openPermissionEditDialog(page, refilteredRow);
    await submitPermissionEditDialog(page, editDialog, {
      permissionTypes: ['管理'],
      expiry: { customTime: editedExpiry },
    });
    const editedRow = await findResourceViewAuthorizationRow(page, {
      resource,
      subjectName: applicant.userName,
      scopeTab: '数据源',
      timeoutMs: 15_000,
    });
    if (!editedRow) throw new Error('资源视角编辑后未回显授权行：编辑可能未生效。');
    await expect(editedRow).toContainText(editedExpiry.slice(0, 10));
    await expectRowExactPermissionType(editedRow, '管理');

    // 阶段6（回查用户视角）：同一授权记录在用户视角应回显同样的到期时间（两个入口一份数据）。
    const userViewRow = await queryUserViewPermissionRowAcrossPages(page, {
      subjectTab: '成员',
      subjectName: applicant.userName,
      subjectAlias: applicant.nickname,
      resource,
    });
    await expect(userViewRow).toContainText(editedExpiry.slice(0, 10));
    await report(
      'SM-03-08 阶段5/6｜编辑与用户视角回查',
      true,
      `编辑为自定义到期 ${editedExpiry.slice(0, 10)} 后列表回显一致；用户视角（成员）回查同一授权记录期限一致。`,
    );

    // 阶段7（删）：资源视角删除后，两个入口都不应再回显该授权记录。
    const rowToDelete = await findResourceViewAuthorizationRow(page, {
      resource,
      subjectName: applicant.userName,
      scopeTab: '数据源',
      timeoutMs: 15_000,
    });
    if (!rowToDelete) throw new Error('删除前未在资源视角定位到授权行。');
    await deletePermissionFromRow(page, rowToDelete, { uniqueText: applicant.userName });
    if (
      await findResourceViewAuthorizationRow(page, {
        resource,
        subjectName: applicant.userName,
        scopeTab: '数据源',
        timeoutMs: 5_000,
      })
    ) {
      throw new Error('资源视角删除后仍回显授权行：删除未生效。');
    }
    await selectUserViewSubject(page, {
      subjectTab: '成员',
      subjectName: applicant.userName,
      subjectAlias: applicant.nickname,
    });
    await switchResourceViewScopeTab(page, '数据源');
    await refreshPermissionList(page);
    if (await findPermissionRowAcrossPages(page, resource.sourceName, 5_000)) {
      throw new Error('删除后用户视角仍回显该数据源授权行：资源视角与用户视角应指向同一授权记录。');
    }

    // 控制台错误门禁（DS-PERM-93）：数据源管理/数据权限列表会触发 getCreatedDataSource、
    // dataPermission 系列 4xx 过程信号（SM-03-07 已验证同型过滤），无权限提示亦属预期；
    // 允许清单之外的其余控制台错误仍然失败。
    assertNoUnexpectedConsoleErrors(consoleErrors, [
      /getCreatedDataSource|dataPermission\//,
      /没有(使用|管理)?权限/,
    ]);

    await report(
      'SM-03-08｜资源视角数据源权限增查改删完成',
      true,
      `资源=${resource.sourceTypeName} ${resource.sourceName}，主体=${applicant.userName}；阶段0清理残留 ${purgedStale.removed} 条；`
        + `已完成 主体类型+关键字 负向/正向查询，新增(管理/永久)→关键字语义→编辑(自定义 ${editedExpiry.slice(0, 10)})→`
        + '用户视角回查一致→删除→双视角均消失。',
    );
  } catch (error) {
    mainError = error;
    mainFailed = true;
  } finally {
    // 收尾（DS-PERM-93）：仅回收本轮 uuid 资产（授权 → 数据源 → 成员 → 角色），
    // 逐项登记、单步失败不阻断其余回收；聚合裁决见下。清理失败必须使用例失败。
    let steps: string[] = [];
    let issues: string[] = [];
    try {
      ({ steps, issues } = await cleanupCaseObjects(page, {
        userName: applicant.userName,
        roleName: applicantRole.roleName,
        resource: permissionResource,
      }));
    } catch (cleanupError) {
      issues.push(`收尾-清理器异常：${describeError(cleanupError)}`);
    }
    const cleanupNote = issues.join('；');
    if (steps.length > 0) {
      await report(
        'SM-03-08 收尾｜本轮资产回收',
        issues.length === 0,
        issues.length === 0
          ? steps.join('；')
          : `回收未完成留证：${cleanupNote}（已完成步骤：${steps.join('；')}）`,
      ).catch(() => undefined);
    }
    if (mainFailed) {
      if (cleanupNote && mainError instanceof Error) {
        mainError.message = `${mainError.message}｜[SM-03-08] 收尾回收未完成：${cleanupNote}`;
      } else if (cleanupNote) {
        console.warn(`[SM-03-08] 主流程错误非 Error 实例，收尾回收未完成留证：${cleanupNote}`);
      }
      throw mainError;
    }
    if (cleanupNote) {
      throw new Error(
        `[SM-03-08] 主流程通过，但收尾回收未完成（仅限本轮 uuid 资产，不触碰共享/历史资产）：${cleanupNote}`,
      );
    }
  }
});

/** 控制台错误门禁（本地复刻权威 utils 实现；与 SM-03-05/06/07 同口径）。 */
function assertNoUnexpectedConsoleErrors(consoleErrors: string[], allowedPatterns: RegExp[]): void {
  const unexpected = consoleErrors.filter(
    (message) => !allowedPatterns.some((pattern) => pattern.test(message)),
  );
  expect(unexpected, '出现未声明的控制台错误（允许清单之外）').toEqual([]);
}
