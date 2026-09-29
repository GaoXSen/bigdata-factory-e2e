/**
 * zz-agent7 flowConfig 专用夹具工具（任务专属临时文件，闭环完成后清理）。
 *
 * 封装「系统管理→审批管理→流程配置」页操作，供改造/还原/开关还原三个 spec 复用：
 *  1. locateTableConfigButton：最小祖先卡片法定位「表权限申请 TABLE」行的 [配置]
 *     按钮。按钮祖先文本上溯可达包含多个卡片的大容器（v1 事故根因），因此首次命中
 *     包含目标关键词、且排除其他卡片名的祖先即锁定，并对按钮文本做白名单。
 *  2. readSwitchStateOf：用 getAttribute 读 aria-checked/class 判定开关状态。
 *     v2 的还原分支把字符串传给 evaluate，未被作为函数调用、恒返回 undefined，
 *     导致误判「已是关闭态」而跳过还原——本工具不再使用任何字符串 evaluate。
 *  3. setNodeApproval / readNodeEditor / saveFlowConfigDialog：在配置弹层内点击
 *     节点卡、读取或改写下方编辑区的「类型/值」两个下拉并保存。
 * 本工具绝不点击「自助查询下载」行的审批流开关（只允许读状态做防御核验）。
 */
import { expect, type Locator, type Page } from '@playwright/test';

export const FLOW_CONFIG_ROUTE = '/systemManage/approvalManage/flowConfig';

/** 与 SM-02-01 相同的落地入口构造：显式 ENTRY_URL > 环境默认值。 */
export function flowConfigEntryUrl(pathWithoutHash: string = FLOW_CONFIG_ROUTE): string {
  const entry = new URL(
    process.env.ENTRY_URL ?? 'http://bigdata.dev.northking.net/bigdata-ui-factory/#/dataAccess/dataSource',
  );
  entry.hash = pathWithoutHash;
  return entry.toString();
}

/**
 * 下拉选项渲染在页面级（teleport）。本系统流程配置弹层的下拉是自定义组件
 * （aria 角色为 combobox/option），选项容器类名未知，故按「role + 常见框架类名」
 * 多路兼容；clickExactOption 只在规范化文本完全相等时点击，误命中风险可控。
 */
export const FLOW_OPTION_SELECTOR = [
  '.ant-select-dropdown:visible .ant-select-item-option',
  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
  '.el-select-dropdown:visible .el-select-dropdown__item',
  '[role="listbox"]:visible [role="option"]',
  'li[role="option"]:visible',
  '[role="option"]:visible',
  '[class*="select-option"]:visible',
  '.arco-select-option:visible',
  '.n-base-select-option:visible',
  '[class*="option"][class*="item"]:visible',
].join(', ');

/** 弹层内下拉触发器：本系统自定义组件显式带 role="combobox"，兼容 ant/el。 */
const COMBO_PARTS = ['.ant-select', '.el-select', '[role="combobox"]'];
const COMBO_ANY = COMBO_PARTS.join(', ');
const COMBO_VISIBLE = COMBO_PARTS.map((part) => part + ':visible').join(', ');

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** 读开关状态：aria-checked 优先；class 含 checked=开，有基类无 checked=关。 */
export async function readSwitchStateOf(sw: Locator): Promise<'on' | 'off' | 'unknown'> {
  const ac = await sw.getAttribute('aria-checked').catch(() => null);
  if (ac === 'true') return 'on';
  if (ac === 'false') return 'off';
  const cls = (await sw.getAttribute('class').catch(() => null)) ?? '';
  if (typeof cls === 'string') {
    // ant-switch-checked / is-checked 等开态类名都包含 checked 子串。
    if (cls.includes('checked')) return 'on';
    // 关态只剩基类名（如 el-switch / ant-switch）：非空且无 checked 标记即关。
    if (cls.trim().length > 0) return 'off';
  }
  return 'unknown';
}

/** 「自助查询下载」行 [配置] 按钮是否禁用（开关关→配置禁用，作为关态二次证据）。 */
export async function selfQueryRowConfigDisabled(page: Page): Promise<boolean | undefined> {
  const buttons = await page.locator('button').all();
  for (const button of buttons) {
    const hit = await button
      .evaluate((el) => {
        const b = el as HTMLButtonElement;
        let node: HTMLElement | null = b;
        let best: HTMLElement | null = null;
        for (let depth = 0; depth < 10 && node; depth += 1) {
          const text = node.innerText ?? '';
          if (!best && text.includes('自助查询下载') && !text.includes('表权限申请')) best = node;
          node = node.parentElement;
        }
        if (!best) return null;
        return { disabled: b.disabled, text: (b.innerText || '').replace(/\s+/g, '') };
      })
      .catch(() => null);
    if (hit && hit.text.includes('配')) return hit.disabled;
  }
  return undefined;
}

/** 页面上「自助查询下载」行的审批流开关（最小祖先卡片匹配；本页应只有一个开关）。 */
export async function findSelfQuerySwitch(page: Page): Promise<Locator | undefined> {
  const switches = page.locator('button[role="switch"], .ant-switch, .el-switch, [role="switch"]');
  const total = await switches.count();
  for (let index = 0; index < total; index += 1) {
    const sw = switches.nth(index);
    const card = await sw
      .evaluate((el) => {
        let node: HTMLElement | null = el as HTMLElement;
        let best: HTMLElement | null = null;
        for (let depth = 0; depth < 10 && node; depth += 1) {
          const text = node.innerText ?? '';
          // 最小祖先：包含场景名、排除目标卡片名；首次命中即锁定，防止命中列表容器。
          if (!best && text.includes('自助查询下载') && !text.includes('表权限申请')) {
            best = node;
          }
          node = node.parentElement;
        }
        return best ? best.innerText.replace(/\s+/g, ' ').slice(0, 80) : '';
      })
      .catch(() => '');
    if (card) return sw;
  }
  return undefined;
}

/** 定位「表权限申请 TABLE」卡片行的 [配置] 按钮（最小祖先卡片法）。 */
export async function locateTableConfigButton(page: Page): Promise<Locator> {
  const buttons = await page.locator('button').all();
  for (const button of buttons) {
    const info = await button
      .evaluate((el) => {
        const b = el as HTMLButtonElement;
        let node: HTMLElement | null = b;
        let best: HTMLElement | null = null;
        for (let depth = 0; depth < 8 && node; depth += 1) {
          const text = node.innerText ?? '';
          if (!best && text.includes('表权限申请') && text.includes('TABLE') && !text.includes('自助查询下载')) {
            best = node;
          }
          node = node.parentElement;
        }
        if (!best) return null;
        return { disabled: b.disabled, text: (b.innerText || '').replace(/\s+/g, '') };
      })
      .catch(() => null);
    if (info && !info.disabled && info.text.includes('配')) return button;
  }
  throw new Error('未以最小祖先法命中「表权限申请 TABLE」的 [配置] 按钮（页面结构可能变化）。');
}

/** 打开配置弹层（等待可见），返回弹层 Locator。 */
export async function openTableConfigDialog(page: Page): Promise<Locator> {
  const button = await locateTableConfigButton(page);
  await button.click();
  const dialog = page
    .locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible, .el-drawer:visible')
    .last();
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(800);
  return dialog;
}

/** 弹层快照文本（按钮+输入控件值+文本），作为改前/改后证据。 */
export async function dialogSnapshot(page: Page, dialog: Locator): Promise<string> {
  const text = await dialog.innerText().catch(() => '');
  const buttons = await dialog.getByRole('button').allInnerTexts().catch(() => [] as string[]);
  const inputs = await dialog
    .evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll('input, textarea').forEach((el) => {
        const e = el as HTMLInputElement;
        const v = e.type === 'checkbox' || e.type === 'radio' ? 'checked=' + e.checked : 'value=' + e.value;
        out.push(e.type + '|' + (e.placeholder || '') + '|' + v);
      });
      return out.slice(0, 60);
    })
    .catch(() => [] as string[]);
  return [
    'buttons=' + buttons.map((item) => normalize(item)).filter(Boolean).join('|'),
    'inputs=' + inputs.join(' ; '),
    '---- 弹层文本 ----',
    text.slice(0, 6000),
  ].join('\n');
}

/**
 * 作用域内可见下拉（本系统自定义组件显式带 role="combobox"；兼容 ant/el）。
 * 实测（run-20260920-210123）：每个下拉会命中 2 个嵌套元素（外层容器+内层同角色），
 * aria 快照将嵌套同角色合并显示，故此处去重：只保留「最近匹配祖先是自己」的最外层。
 */
async function visibleCombos(scope: Locator): Promise<Locator[]> {
  const combos = scope.locator(COMBO_VISIBLE);
  const total = await combos.count();
  const found: Locator[] = [];
  for (let index = 0; index < total; index += 1) {
    const item = combos.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const nested = await item
      .evaluate((el) => {
        const p = el.parentElement;
        return p ? p.closest('.ant-select, .el-select, [role="combobox"]') !== null : false;
      })
      .catch(() => true); // 判定失败时保守视为嵌套（宁缺勿滥，避免重复计数）。
    if (!nested) found.push(item);
  }
  return found;
}

/** 读取作用域内各下拉的规范化文本（图标为 svg 不参与 innerText）。 */
async function comboTexts(combos: Locator[]): Promise<string[]> {
  const texts: string[] = [];
  for (const item of combos) texts.push(normalize(await item.innerText().catch(() => '')));
  return texts;
}

/**
 * 定位指定节点的编辑器块：含节点名标题、且恰好有 2 个下拉的最小祖先容器。
 * aria 快照证实：每个节点块的编辑器常驻渲染（标题行+类型徽标+2 个 combobox），
 * 无需点击节点卡；节点卡文本同名元素不含下拉，自然被 2 个下拉的约束排除。
 */
export async function locateEditorBlock(dialog: Locator, nodeLabel: string): Promise<Locator> {
  const titles = dialog.getByText(nodeLabel, { exact: true });
  const total = await titles.count();
  for (let index = 0; index < total; index += 1) {
    const title = titles.nth(index);
    if (!(await title.isVisible().catch(() => false))) continue;
    for (let depth = 1; depth <= 6; depth += 1) {
      const anc = title.locator('xpath=ancestor::*[' + depth + ']');
      // 用去重后的可见下拉计数（外层 combobox 内嵌同角色元素会重复命中）。
      if ((await visibleCombos(anc)).length === 2) return anc;
    }
  }
  const all = await visibleCombos(dialog);
  throw new Error(
    '未定位到「' + nodeLabel + '」编辑器块（标题命中=' + total + '；弹层内去重后可见下拉=' + all.length + '）。',
  );
}

async function waitOptions(page: Page, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await page.locator(FLOW_OPTION_SELECTOR).count()) > 0) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

/** 在页面级下拉中点击规范化文本恰好等于 target 的选项；返回已见候选（含命中）。 */
async function clickExactOption(page: Page, target: string): Promise<string[]> {
  const options = page.locator(FLOW_OPTION_SELECTOR);
  const total = await options.count();
  const seen: string[] = [];
  for (let index = 0; index < total; index += 1) {
    const item = options.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const label = normalize((await item.innerText().catch(() => '')) || '');
    if (!label) continue;
    seen.push(label);
    if (label === target) {
      await item.click();
      return seen;
    }
  }
  return seen;
}

/** 打开 trigger 下拉并选中 target；候选过多时尝试用输入框过滤后再选。 */
async function pickOption(page: Page, trigger: Locator, target: string, label: string): Promise<void> {
  await trigger.click();
  if (!(await waitOptions(page))) throw new Error(label + '未弹出选项列表。');
  let seen = await clickExactOption(page, target);
  if (!seen.includes(target)) {
    // 兜底：可搜索下拉按目标文本过滤后再找一次（不可搜索的下拉该步骤无副作用）。
    const input = trigger.locator('input').first();
    if ((await input.isVisible().catch(() => false)) && (await input.isEnabled().catch(() => false))) {
      await input.fill(target).catch(() => undefined);
      await page.waitForTimeout(1_000);
      if (await waitOptions(page, 3_000)) seen = await clickExactOption(page, target);
    }
  }
  if (!seen.includes(target)) {
    throw new Error(label + '候选中没有「' + target + '」；实测候选=[' + seen.join('、') + ']。');
  }
}

/**
 * 读取指定审批节点编辑器块当前的「类型/值」文本。
 * 编辑器块常驻渲染（快照证实），直接按块定位读取，不点击节点卡。
 */
export async function readNodeEditor(
  page: Page,
  dialog: Locator,
  nodeLabel: string,
): Promise<{ type: string; value: string }> {
  const block = await locateEditorBlock(dialog, nodeLabel);
  const combos = await visibleCombos(block);
  if (combos.length < 2) {
    throw new Error('「' + nodeLabel + '」编辑器块下拉数量=' + combos.length + '（预期 2）。');
  }
  const texts = await comboTexts(combos);
  const typeIndex = texts.findIndex((text) => /用户|角色|主管/.test(text));
  if (typeIndex < 0) throw new Error('「' + nodeLabel + '」未识别出类型下拉；实测=' + texts.join('|'));
  return { type: texts[typeIndex], value: texts[typeIndex === 0 ? 1 : 0] };
}

/**
 * 把指定审批节点改为 targetType/targetValue 并回显校验。
 * 返回改前值（beforeType/beforeValue），作为还原依据的一部分。
 */
export async function setNodeApproval(
  page: Page,
  dialog: Locator,
  nodeLabel: string,
  targetType: string,
  targetValue: string,
): Promise<{ beforeType: string; beforeValue: string }> {
  const before = await readNodeEditor(page, dialog, nodeLabel);
  const block = await locateEditorBlock(dialog, nodeLabel);

  const selects = await visibleCombos(block);
  if (selects.length < 2) throw new Error('编辑区下拉数量=' + selects.length + '（预期 2：类型+值）。');
  const texts = await comboTexts(selects);
  const typeIndex = texts.findIndex((text) => /用户|角色|主管/.test(text));
  if (typeIndex < 0) throw new Error('编辑区未识别出类型下拉；实测下拉文本=' + texts.join('|'));

  await pickOption(page, selects[typeIndex], targetType, '类型下拉');
  await page.waitForTimeout(600);

  // 类型切换可能重建值下拉：按块重新定位，值下拉=当前不显示 targetType 文本的可见下拉。
  const block2 = await locateEditorBlock(dialog, nodeLabel);
  const selects2 = await visibleCombos(block2);
  if (selects2.length < 2) throw new Error('类型切换后编辑区下拉数量异常：' + selects2.length);
  const texts2 = await comboTexts(selects2);
  let valueIndex = -1;
  for (let index = 0; index < selects2.length; index += 1) {
    if (!texts2[index].includes(targetType)) {
      valueIndex = index;
      break;
    }
  }
  if (valueIndex < 0) valueIndex = 1;
  await pickOption(page, selects2[valueIndex], targetValue, '值下拉');

  // 回显校验：块级重读（改用最新 DOM，避免旧 locator/慢回显误判；110 环境实测回显可 >5s）。
  await expect
    .poll(async () => {
      const fresh = await locateEditorBlock(dialog, nodeLabel).catch(() => null);
      if (!fresh) return '';
      return normalize(await fresh.innerText().catch(() => ''));
    }, { timeout: 15_000, message: '值下拉未回显「' + targetValue + '」' })
    .toContain(targetValue);

  return { beforeType: before.type, beforeValue: before.value };
}

/** 保存配置弹层：点击 保存/确定/确认应用，必要时确认 message-box，最终弹层必须关闭。 */
export async function saveFlowConfigDialog(page: Page, dialog: Locator): Promise<void> {
  const save = dialog.getByRole('button').filter({ hasText: /保存|确\s*定|确认\s*应\s*用/ }).last();
  if (!(await save.isVisible().catch(() => false))) {
    throw new Error('配置弹层内未找到 保存/确定/确认应用 按钮。');
  }
  await save.click();
  await page.waitForTimeout(1_200);
  // 兜底：可能出现二次确认框（只认独立确认框，不碰配置弹层自身按钮）。
  const box = page.locator('.el-message-box:visible, .ant-modal-confirm:visible');
  if (await box.isVisible().catch(() => false)) {
    const confirm = box.getByRole('button', { name: /确\s*定|确\s*认|OK/i }).last();
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click();
      await page.waitForTimeout(1_200);
    }
  }
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await page.waitForTimeout(500);
}