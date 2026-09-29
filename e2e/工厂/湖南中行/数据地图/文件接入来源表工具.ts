/**
 * 文件接入来源表工具 — txt/xls/xlsx 等格式统一走“上传→解析→预览→自动建表”向导。
 *
 * 面向 BL-FLD-00-03/00-04/00-05 系列：与 BL-FLD-00-01（CSV 基线）同一向导，
 * 差异仅在资源文件与解析参数：
 * - txt：页面“列分隔符”输入框需要显式填写（本目录资源用竖线 |）；
 * - xls/xlsx：Excel 由后端按 sheet 解析，分隔符输入框不适用（控件隐藏时跳过）；
 *   xlsx 资源带双 sheet，若页面出现 sheet 选择控件则选择数据 sheet（Sheet1），
 *   控件不存在时依赖页面默认取第一个 sheet。
 * 2026-09-20（110 环境迁移）：原 192.168.76.113:3306 MySQL 失效后，来源表曾建在
 * GBase（HN_E2E_GBASE_192.168.79.69/sxzh_mas）；现 192.168.76.110:13306/e2e_test
 * 已恢复可用，全部来源表改建在 MySQL，供后续字段血缘调度 SQL
 * （BL-FLD-01-04/01-05/01-06）引用。
 */
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { clickMenu, fillByLabel, selectByLabel } from '../utils.js';
// 环境配置中心（ENV-CONFIG-40）：数据源四项来自 dataSourceNames.fileAccess，
// 本文件不再写死任何数据源显示名/库/Schema（DS-PERM-47）。
import { testEnvironment } from '../../../test-environment.js';

/** 文件接入来源表的五个标准字段（与 e2e_lineage_file_source.csv 基线一致）。 */
export const FLD_FILE_ACCESS_SOURCE_FIELDS = [
  'file_id',
  'shared_key',
  'file_name',
  'file_amount',
  'business_date',
] as const;

export type FileAccessSourceOptions = {
  /** 本地资源文件绝对路径。 */
  filePath: string;
  /** 报告与失败信息中的文件展示名。 */
  fileLabel: string;
  /** txt/csv 的列分隔符；xls/xlsx 传 undefined，跳过“列分隔符”输入框。 */
  separator?: string;
  /** Excel 数据 sheet 名；出现 sheet 选择控件时尝试选择，失败不阻断。 */
  sheetName?: string;
  /** MySQL（110 e2e_test）自动建表目标表名。 */
  tableName: string;
  /** 字段预览与字段映射必须出现的来源字段。 */
  sourceFields: readonly string[];
};

async function lastVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    for (let index = await candidate.count() - 1; index >= 0; index -= 1) {
      const item = candidate.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return undefined;
}

async function openNewFileAccess(page: Page): Promise<void> {
  await clickMenu(page, '数据接入', '文件接入');
  const marker = page.getByText(/上传文件/).filter({ visible: true }).last();
  if (!await marker.isVisible().catch(() => false)) {
    const create = await lastVisible([
      page.getByRole('button', { name: /新建接入|新增接入/ }),
      page.locator('button:visible, [role="button"]:visible').filter({ hasText: /新建接入|新增接入/ }),
    ]);
    if (!create) throw new Error(`文件接入页未找到“新建接入”，当前页面：${page.url()}`);
    await create.click();
  }
  await expect(marker).toBeVisible({ timeout: 15_000 });
}

async function uploadSourceFile(page: Page, filePath: string): Promise<void> {
  const fileInput = page.locator('input[type="file"]').last();
  if (await fileInput.count()) {
    await fileInput.setInputFiles(filePath);
  } else {
    const choose = await lastVisible([
      page.getByRole('button', { name: /选择文件/ }),
      page.locator('button:visible, [role="button"]:visible').filter({ hasText: /选择文件/ }),
    ]);
    if (!choose) throw new Error('文件接入新建页未找到“选择文件”按钮。');
    const fileChooser = page.waitForEvent('filechooser');
    await choose.click();
    await (await fileChooser).setFiles(filePath);
  }
  const failure = page.getByText(/上传失败|Internal Server Error/).filter({ visible: true }).last();
  if (await failure.isVisible({ timeout: 2_000 }).catch(() => false)) {
    throw new Error(`文件上传失败：${await failure.innerText()}`);
  }
}

async function clickToFieldMapping(page: Page): Promise<void> {
  const next = await lastVisible([
    page.getByRole('button', { name: /下一步/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /下一步/ }),
  ]);
  if (!next) throw new Error('文件接入向导未找到“下一步”按钮。');
  await next.click();
  // 步骤条常驻“字段映射”文案，不能作为翻页成功依据；以第一步专属的“下一步”
  // 按钮消失为准。必填校验失败会留在第一步，此时补点一次。
  await next.waitFor({ state: 'hidden', timeout: 15_000 }).catch(async () => {
    await next.click();
    await next.waitFor({ state: 'hidden', timeout: 15_000 });
  });
  // 字段映射页出现“确定”按钮，作为翻页完成的正向信号。
  await expect(
    page.getByRole('button', { name: /^确\s*定$/ }).filter({ visible: true }).first(),
  ).toBeVisible({ timeout: 15_000 });
}

/** 读取指定表单标签对应的下拉框当前显示值（Element el-select 的 input value，未选为空）。 */
async function formSelectText(page: Page, labelText: string): Promise<string> {
  const label = page
    .getByText(new RegExp(`^\\s*\\*?\\s*${labelText}\\s*[：:]?\\s*$`))
    .filter({ visible: true })
    .first();
  if (!(await label.isVisible().catch(() => false))) return '';
  let scope = label;
  for (let level = 0; level < 6; level++) {
    const select = scope.locator('.el-select:visible, .ant-select:visible').first();
    if (await select.isVisible().catch(() => false)) {
      const input = select.locator('input').first();
      const byValue = await input.inputValue().catch(() => '');
      return byValue.trim() || (await select.innerText().catch(() => '')).trim();
    }
    scope = scope.locator('..');
  }
  return '';
}

// DS-PERM-47：数据源四项来自配置中心 dataSourceNames.fileAccess
// （FILE_AUTO_SOURCE_TYPE/NAME/DATABASE/SCHEMA 可单项覆盖；物理库对应
// primary profile，默认 192.168.76.110:13306/e2e_test）。
// 历史注记（2026-09-20，110 环境迁移）：字段血缘文件来源表自 GBase
// （HN_E2E_GBASE_192.168.79.69/sxzh_mas）迁回 MySQL。数据源下拉登记的
// 全名带库后缀（host:port/库），而 selectByLabel 按选项文本 exact 匹配，
// 必须使用全名；host:port 短名匹配不到选项，会误报“数据源选择未生效”。
const FILE_ACCESS_DATASOURCE = {
  type: testEnvironment.dataSourceNames.fileAccess.type,
  name: testEnvironment.dataSourceNames.fileAccess.name,
  database: testEnvironment.dataSourceNames.fileAccess.database,
  schema: testEnvironment.dataSourceNames.fileAccess.schema,
};

/** 选择数据源四项并验证落地；Element 下拉重渲染或表单异步重置（xlsx 慢解析时
 * 观察到选择被整体清空）会让点击静默失效，未生效自动重选直到全部确认。 */
async function ensureDataSourceSelected(page: Page, attempts = 4): Promise<void> {
  const { type, name, database, schema } = FILE_ACCESS_DATASOURCE;
  const expected: Array<[string, string]> = [
    ['数据源类型', type],
    ['数据源名称', name],
    ['数据库名称', database],
    ['Schema名称', schema],
  ];
  let lastValues = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (const [label, option] of expected) {
      await selectByLabel(page, label, option);
    }
    const values: string[] = [];
    for (const [label] of expected) values.push(await formSelectText(page, label));
    lastValues = values.join(' | ');
    if (expected.every(([, option], index) => values[index].includes(option))) return;
    if (attempt < attempts) await page.waitForTimeout(1_500);
  }
  throw new Error(
    `数据源选择未生效（当前：${lastValues}，期望：${type} | ${name} | ${database} | ${schema}）。页面可能在选择后发生异步重置。`,
  );
}

/** 勾选“自动建表”并填写目标表名，轮询验证两项都生效（同数据源选择的重置防护）。 */
async function ensureAutoCreateTable(page: Page, tableName: string, attempts = 4): Promise<void> {
  const automatic = page.getByRole('radio', { name: '自动建表', exact: true });
  const tableNameInput = page.getByPlaceholder('请输入表名').filter({ visible: true }).last();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (!(await automatic.isChecked().catch(() => false))) {
      await automatic.check().catch(() => undefined);
    }
    if (
      (await tableNameInput.isVisible().catch(() => false))
      && (await tableNameInput.inputValue().catch(() => '')) !== tableName
    ) {
      await tableNameInput.fill(tableName);
    }
    const checked = await automatic.isChecked().catch(() => false);
    const value = (await tableNameInput.isVisible().catch(() => false))
      ? await tableNameInput.inputValue().catch(() => '')
      : '';
    if (checked && value === tableName) return;
    if (attempt < attempts) await page.waitForTimeout(1_500);
  }
  throw new Error(
    `自动建表/表名未生效：radio=${await automatic.isChecked().catch(() => false)}，`
    + `表名=“${await tableNameInput.inputValue().catch(() => '')}”，期望“${tableName}”。`,
  );
}

/**
 * Excel 工作簿可能出现 sheet 选择控件；label 文案未在 CSV 基线用例中出现，
 * 按“Sheet/工作表”等常见文案探测并选中数据 sheet。探测失败不阻断：
 * 资源的数据固定放在第一个 sheet，页面默认解析第一个 sheet 时同样正确。
 */
async function trySelectDataSheet(page: Page, sheetName: string): Promise<void> {
  for (const label of ['Sheet', 'Sheet名称', '工作表', 'sheet名称']) {
    const labelText = page.getByText(label, { exact: true }).filter({ visible: true }).last();
    if (!await labelText.isVisible().catch(() => false)) continue;
    try {
      await selectByLabel(page, label, sheetName);
      return;
    } catch {
      // label 命中但控件形态不同（非下拉），交给页面默认行为。
    }
  }
}

/**
 * 统一执行“上传→解析→字段预览→数据源选择→自动建表→字段映射→确定”完整向导，
 * 在 MySQL primary profile（物理库默认 192.168.76.110:13306/e2e_test，见
 * dataSourceNames.fileAccess）创建来源表。返回成功描述，
 * 供用例直接写报告。
 */
export async function createFileAccessSourceTable(
  page: Page,
  options: FileAccessSourceOptions,
): Promise<string> {
  const { filePath, fileLabel, separator, sheetName, tableName, sourceFields } = options;
  await openNewFileAccess(page);
  await uploadSourceFile(page, filePath);

  if (separator) {
    // 列分隔符 label 与 input 无程序化关联（accessible name 是 placeholder“请输入”），
    // 且页面表单无标准 form-item 容器类，getByLabel/容器定位都会失败。
    // 复用本项目已验证的 fillByLabel：按标签文本就近向上查找真实输入框。
    await fillByLabel(page, '列分隔符', separator);
    // fill 后焦点停留在分隔符输入框，Tab 触发 blur/change，覆盖仅监听 change 的解析逻辑。
    await page.keyboard.press('Tab');
  }
  if (sheetName) await trySelectDataSheet(page, sheetName);
  const header = page.getByRole('radio', { name: '是', exact: true }).last();
  if (await header.isVisible().catch(() => false)) await header.check();

  // 数据源与建表参数先于预览填写：xlsx 等慢解析格式可能在预览关闭后触发前端
  // 表单异步重置；选择后必须验证落地并自动重试（预览关闭后还会再校验一次）。
  await ensureDataSourceSelected(page);
  await ensureAutoCreateTable(page, tableName);

  const preview = await lastVisible([
    page.getByRole('button', { name: /数据预览|预\s*览/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /数据预览|预\s*览/ }),
  ]);
  if (!preview) throw new Error('文件接入新建页未找到“数据预览”按钮。');
  await preview.click();
  // 与 BL-FLD-00-01 相同：预览容器标题为“字段预览”，遮罩不一定带 dialog role。
  const previewCandidates = [
    page.getByRole('dialog', { name: /字段预览/ }),
    page.locator('.ant-modal-wrap:visible, .ant-modal:visible, .el-dialog:visible').filter({ hasText: /字段预览/ }),
  ];
  let previewDialog: Locator | undefined;
  const previewDeadline = Date.now() + 15_000;
  while (Date.now() < previewDeadline) {
    previewDialog = await lastVisible(previewCandidates);
    if (previewDialog) break;
    await page.waitForTimeout(250);
  }
  if (!previewDialog) {
    throw new Error(`上传 ${fileLabel} 后 15 秒内未打开字段预览：后端可能不支持该格式或分隔符解析失败。`);
  }
  for (const field of sourceFields) {
    await expect(previewDialog.getByText(field, { exact: true }).last(), `预览缺少字段 ${field}`).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(previewDialog).toBeHidden({ timeout: 5_000 }).catch(() => undefined);

  // 预览/弹窗关闭可能触发前端表单重置（xlsx 慢解析时更明显），翻页前最终校验。
  await ensureDataSourceSelected(page);
  await ensureAutoCreateTable(page, tableName);

  await clickToFieldMapping(page);
  // 标题“字段映射”先切换、表格行后异步渲染；不能只读取一次 body 文本。
  await expect.poll(async () => {
    const text = await page.locator('body').innerText();
    return sourceFields.every((field) => text.includes(field));
  }, { timeout: 15_000, message: `字段映射表格未完整加载 ${fileLabel} 的来源字段` }).toBe(true);

  const confirm = await lastVisible([
    page.getByRole('button', { name: /^确\s*定$/ }),
    page.locator('button:visible, [role="button"]:visible').filter({ hasText: /^确\s*定$/ }),
  ]);
  if (!confirm) throw new Error('字段映射页未找到“确定”按钮。');
  await confirm.click();
  await expect.poll(async () => {
    const toast = await page.locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
      .filter({ hasText: /成功|创建|保存|同步/ }).count();
    return toast > 0 || !/fileAccessCreate/.test(page.url());
  }, { timeout: 30_000 }).toBe(true);

  return `文件=${fileLabel}${separator ? `；分隔符=${separator}` : ''}；目标表=${tableName}；`
    + `数据源=MYSQL ${FILE_ACCESS_DATASOURCE.name}；方式=自动建表。`;
}
