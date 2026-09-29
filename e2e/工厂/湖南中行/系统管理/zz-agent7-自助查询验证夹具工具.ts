/**
 * zz-agent7-自助查询验证夹具工具｜Agent-7 本任务专属临时夹具（验证完成后删除）。
 *
 * 全部实现取自 SM-03-06 当前已实证版本（run-20260920-182133-299 / -182931-631 /
 * -183226-719 三轮校准后的目录树展开、元数据刷新与只读查询结果判定），
 * 供本任务的临时 setup / 复核 spec 复用；不属于共享工具，不得被正式用例引用。
 */
import { expect, type Locator, type Page } from '@playwright/test';

/** 自助查询数据源弹窗展示基础名（主机段），与数据权限页完整展示名不同（SM-03-06 §85）。 */
export const QUERY_SOURCE_BASE = (process.env.QUERY_SOURCE_NAME?.trim()
  || process.env.DATA_PERMISSION_SOURCE_NAME?.trim()
  || '192.168.76.110:13306/e2e_test').split(/[:：]/)[0].trim();

export const QUERY_SOURCE_TYPE = process.env.DATA_PERMISSION_SOURCE_TYPE?.trim() || 'MYSQL';

/** 与 SM-03-04/SM-02-01 相同的落地页入口构造：显式 ENTRY_URL > 环境默认值。 */
export function entryUrlFor(pathWithoutHash: string): string {
  const entry = new URL(
    process.env.ENTRY_URL ?? 'http://bigdata.dev.northking.net/bigdata-ui-factory/#/dataAccess/dataSource',
  );
  entry.hash = pathWithoutHash;
  return entry.toString();
}

/**
 * 在自助查询左侧目录（数据库/Schema/表 流程）中查找目标表节点。
 * 排除数据源/Schema combobox 与 Monaco 编辑器内的同名文本；轮询窗口内未出现返回 undefined。
 */
async function pollCatalogTableText(
  page: Page,
  tableName: string,
  exact: boolean,
  timeoutMs: number,
): Promise<Locator | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const nodes = page.getByText(tableName, { exact });
    const count = await nodes.count();
    // 从最后一个匹配向前找：getByText 非精确模式会同时命中祖先容器，
    // DOM 序靠后的通常是内层真实节点。
    for (let index = count - 1; index >= 0; index -= 1) {
      const node = nodes.nth(index);
      if (!(await node.isVisible().catch(() => false))) continue;
      const insideControl = node.locator(
        'xpath=ancestor-or-self::*[@role="combobox" or contains(@class, "monaco-editor") or self::input]',
      );
      if ((await insideControl.count()) === 0) return node;
    }
    await page.waitForTimeout(400);
  }
  return undefined;
}

export async function findCatalogTableNode(page: Page, tableName: string): Promise<Locator | undefined> {
  return (await pollCatalogTableText(page, tableName, true, 10_000))
    ?? (await pollCatalogTableText(page, tableName, false, 6_000));
}

/** 快速版：仅精确匹配短轮询，用于展开尝试之间的早退检查，避免测试超时。 */
function tableNodeQuickCheck(page: Page, tableName: string): Promise<Locator | undefined> {
  return pollCatalogTableText(page, tableName, true, 2_500);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 目录“刷新数据库元数据”确认弹窗处理（任务27F 页面事实3）：必须点击“确定”，
 * 并等待弹窗关闭和树刷新；不确认会以模态层阻塞目录后续全部交互。
 * 弹窗未出现时为 no-op，返回 false。
 */
export async function confirmMetadataRefreshDialog(page: Page, timeoutMs = 8_000): Promise<boolean> {
  const dialog = page.getByRole('dialog', { name: /刷新数据库元数据/ });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await dialog.isVisible().catch(() => false)) break;
    await page.waitForTimeout(250);
  }
  if (!(await dialog.isVisible().catch(() => false))) return false;
  await dialog.getByRole('button', { name: /确\s*定/ }).first().click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  // 弹窗关闭后目录树异步重建：留出树刷新稳定窗口。
  await page.waitForTimeout(2_500);
  return true;
}

/** 自助查询验证前刷新数据库元数据：目录控件未渲染时安全跳过，不作为失败。 */
export async function refreshDatabaseMetadata(page: Page): Promise<void> {
  const treeSearch = page.getByRole('textbox', { name: /搜索表名|存储过程/ });
  if (!(await treeSearch.isVisible().catch(() => false))) return;
  const reloadIcon = treeSearch.locator(
    'xpath=parent::*[1]/following-sibling::*[contains(@aria-label,"reload")][1]',
  );
  if (!(await reloadIcon.isVisible().catch(() => false))) return;
  await reloadIcon.click({ timeout: 3_000 }).catch(() => undefined);
  await confirmMetadataRefreshDialog(page);
}

/** 目录树为虚拟滚动渲染：滚轮滚动树区域，让视口外的表行进入 DOM 后再查找。 */
export async function scrollCatalogTreeForTable(page: Page, tableName: string): Promise<Locator | undefined> {
  const firstRow = page.locator('.virtual-tree-node').first();
  const box = await firstRow.boundingBox().catch(() => null);
  if (!box) return undefined;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < 12; step += 1) {
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(300);
    const hit = await pollCatalogTableText(page, tableName, true, 600).catch(() => undefined);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * 尽力展开目录树中的库/Schema 节点，直到目标表出现（传入 tableName 时逐尝试早退）。
 * 兼容标准 treeitem 角色与当前版本的 antd 虚拟树普通节点行；点击标题不展开，
 * caret 箭头是展开触发方式，逐项尝试；个别候选点击会导航走，URL 变化立即导航回。
 */
export async function tryExpandCatalogSchema(page: Page, schemaName: string, tableName?: string): Promise<void> {
  const tableVisible = async (): Promise<boolean> =>
    Boolean(tableName && (await tableNodeQuickCheck(page, tableName).catch(() => undefined)));
  const urlBefore = page.url();
  const ensureSamePage = async (): Promise<void> => {
    if (page.url() !== urlBefore) {
      await page.goto(urlBefore, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.waitForTimeout(1_500);
    }
  };
  // 兼容 1：标准 treeitem 角色。
  const candidates = page.getByRole('treeitem', { name: new RegExp(escapeRegExp(schemaName)) });
  const count = await candidates.count().catch(() => 0);
  for (let index = count - 1; index >= 0; index -= 1) {
    const node = candidates.nth(index);
    if (!(await node.isVisible().catch(() => false))) continue;
    const expanded = await node.getAttribute('aria-expanded').catch(() => null);
    const className = await node.getAttribute('class').catch(() => null);
    if (expanded === 'true' || className?.includes('switcher-open')) continue;
    const switcher = node.locator('.ant-tree-switcher, [role="button"]').first();
    if (await switcher.count()) await switcher.click({ timeout: 2_000 }).catch(() => undefined);
    else await node.click({ timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    await ensureSamePage();
    if (await tableVisible()) return;
  }
  // 兼容 2：普通节点行（无 treeitem 角色）。行容器限定 2~4 个子元素
  // （[caret, 图标, 标题] 典型行），防止爬升到左侧导航图标栏把页面带走。
  const titleNodes = page.getByText(schemaName, { exact: true });
  const titleCount = await titleNodes.count().catch(() => 0);
  for (let index = 0; index < titleCount; index += 1) {
    const node = titleNodes.nth(index);
    if (!(await node.isVisible().catch(() => false))) continue;
    const insideControl = node.locator(
      'xpath=ancestor-or-self::*[@role="combobox" or contains(@class, "monaco-editor") or self::input]',
    );
    if ((await insideControl.count()) > 0) continue;
    const row = node.locator('xpath=ancestor::*[count(*) >= 2][count(*) <= 4][1]');
    const alreadyOpen = await row.locator('.ant-tree-switcher_open').count().catch(() => 0);
    if (alreadyOpen > 0) continue;
    const caretCandidates: Locator[] = [
      row.locator('[aria-label*="caret"]').first(),
      row.locator('.ant-tree-switcher').first(),
      row.locator('[class*="caret"]').first(),
    ];
    for (const caret of caretCandidates) {
      if (!(await caret.count().catch(() => 0))) continue;
      await caret.click({ timeout: 2_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
      await ensureSamePage();
      if (await tableVisible()) return;
      break; // 只点第一个命中的箭头候选，避免二次点击把节点重新折叠
    }
    // 标题双击（部分实现用双击展开；单击无效时兜底）。
    await node.dblclick({ timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(1_200);
    await ensureSamePage();
    if (await tableVisible()) return;
  }
}

/** 自助查询执行结果状态：done=结果列头已出现；denied=页面出现表级权限拦截文案；pending=仍在执行。 */
export async function readQueryOutcome(page: Page, marker: string): Promise<'done' | 'denied' | 'pending'> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  // 后端已确认文案：【表名】数据表没有使用权限，请确认（glm5.3-01 §3 生效点 B）。
  if (/没有使用权限/.test(bodyText)) return 'denied';
  // marker 是本轮唯一的列别名，只出现在结果表列头；Monaco 编辑器中的 SQL 文本不是表格单元格。
  const headerCount = await page
    .locator('th:visible, [role="columnheader"]:visible')
    .filter({ hasText: marker })
    .count();
  return headerCount > 0 ? 'done' : 'pending';
}


