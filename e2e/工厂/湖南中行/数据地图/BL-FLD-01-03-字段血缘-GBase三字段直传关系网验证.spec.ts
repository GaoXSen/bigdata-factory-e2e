/**
 * BL-FLD-01-03｜字段血缘｜GBase 直传字段关系网验证。
 *
 * 当前环境的字段级解析能力由 GBase 提供，因此不再以 MySQL/SFTP 的“能打开
 * 字段弹窗”作为字段血缘成功依据。本用例建立一条专属 GBase 三字段直传 SQL，
 * 并将其全部预期字段关系逐条打开、逐条核验、最后汇总。
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../utils.js';
import {
  assertNoUnexpectedLineageConsoleErrors,
  configureExistingLineageStatement,
  openTableLineage,
} from './血缘测试工具.js';

const SOURCE = 'e2e_hn_gbase_src_a_0831';
const TARGET = 'e2e_hn_gbase_bl040102_target_0901';
// GBase 已由表任务调度绑定正确的数据源、库和 Schema。字段解析器对全限定名
// 的兼容性由后端版本决定，因此这里保留最小、无库名前缀的 GBase 直传语法；
// 若仍无法产出表关系，结果可直接归因于解析服务而不是 SQL 拼接。
const SQL = `INSERT INTO ${TARGET} (id, name, remark)\nSELECT id, name, remark FROM ${SOURCE} WHERE id IS NOT NULL;`;

const RELATIONS = [
  { sourceField: 'id', targetField: 'id' },
  { sourceField: 'name', targetField: 'name' },
  { sourceField: 'remark', targetField: 'remark' },
] as const;

type CheckResult = {
  relation: string;
  result: '正确' | '缺失' | '异常';
  detail: string;
};

async function rightMostVisible(candidates: Locator, description: string): Promise<Locator> {
  let winner: Locator | undefined;
  let largestX = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const box = await candidate.boundingBox();
    if (box && box.x > largestX) {
      winner = candidate;
      largestX = box.x;
    }
  }
  if (!winner) throw new Error(`GBase 字段血缘图未找到右侧目标表控件：${description}`);
  return winner;
}

async function closeDialog(page: Page, dialog: Locator): Promise<void> {
  if (!await dialog.isVisible().catch(() => false)) return;
  await page.keyboard.press('Escape').catch(() => undefined);
  await expect(dialog).toBeHidden({ timeout: 3_000 }).catch(async () => {
    const close = dialog.getByRole('button', { name: /关闭|close/i }).last();
    if (await close.isVisible().catch(() => false)) await close.click();
  });
}

/**
 * 验证的是弹窗内部的关系图，而不是标题。标题只表示点到了目标字段；
 * 真正的成功标准是来源表/字段和目标表/字段均出现在同一个字段血缘弹窗里。
 */
async function expectRelationInDialog(
  dialog: Locator,
  sourceField: string,
  targetField: string,
): Promise<void> {
  await expect(dialog).toContainText(`字段血缘：${TARGET}.${targetField}`);
  const graphSvgs = dialog.locator('svg:visible');
  const sourceNode = graphSvgs.filter({ hasText: SOURCE }).last();
  const targetNode = graphSvgs.filter({ hasText: TARGET }).last();
  await expect(sourceNode, `字段弹窗缺少来源表节点：${SOURCE}`).toBeVisible({ timeout: 6_000 });
  await expect(targetNode, `字段弹窗缺少目标表节点：${TARGET}`).toBeVisible({ timeout: 6_000 });
  if (process.env.LINEAGE_CAPTURE_DIALOG === '1') {
    const safeField = targetField.replace(/[^a-zA-Z0-9_-]/g, '_');
    await dialog.screenshot({ path: `test-results/gbase-field-lineage-dialog-${safeField}.png` });
  }

  // 当前前端会把节点表名以省略号截断渲染；完整表名仍存在于图谱外层 SVG，
  // 但字段卡片不能再用完整表名作 DOM 祖先限定。按实际可见结构校验：
  // 两端表名前缀、SQL 自动解析边、以及目标字段在两个节点中各出现一次。
  await expect(dialog, `字段弹窗未展示来源表前缀：${SOURCE}`).toContainText(SOURCE.slice(0, 18));
  await expect(dialog, `字段弹窗未展示目标表前缀：${TARGET}`).toContainText(TARGET.slice(0, 18));
  await expect(dialog.getByText('SQL自动解析', { exact: true }), '字段弹窗缺少 SQL 自动解析关系边')
    .toBeVisible({ timeout: 6_000 });
  if (sourceField === targetField) {
    await expect.poll(
      () => dialog.getByText(targetField, { exact: true }).count(),
      { timeout: 6_000, message: `字段弹窗未在两端节点同时展示同名字段：${targetField}` },
    ).toBeGreaterThanOrEqual(2);
    return;
  }
  await expect(dialog.getByText(sourceField, { exact: true }), `来源节点未展示字段：${sourceField}`)
    .toBeVisible({ timeout: 6_000 });
  await expect(dialog.getByText(targetField, { exact: true }), `目标节点未展示字段：${targetField}`)
    .toBeVisible({ timeout: 6_000 });
}

test('BL-FLD-01-03｜字段血缘｜GBase三字段直传关系逐条验证并汇总', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(180_000);
  // 建链/改任务调度属于前置用例；字段关系验证默认复用已成功上线的任务，
  // 避免每次验证都重写任务并因编辑页回跳波动掩盖真正的字段血缘结果。
  // 只有人工需要重建该专属夹具时才显式开启 LINEAGE_REBUILD_EXISTING=1。
  if (process.env.LINEAGE_REBUILD_EXISTING === '1') {
    await configureExistingLineageStatement(loginPage, {
      fixtureSet: 'gbase',
      targetTable: TARGET,
      sourceTables: [SOURCE],
      scriptType: /G[_\s-]*BASE(?:8A|_DB)?|GBASE8A/i,
      sql: SQL,
      expectedNodes: [SOURCE, TARGET],
    });
    // 业务确认 GBase 血缘解析迅速完成；等待 1 秒后直接验证真实页面关系。
    await loginPage.waitForTimeout(1_000);
  }
  await openTableLineage(loginPage, TARGET);

  // 图谱容器出现不代表关系存在。先确认来源/目标节点真的出现在图谱 SVG 中；
  // 若这里缺失，仍需为每个预期字段关系产出一条明确结论，不能只在第一条断言
  // 处中断，导致报告无法告诉业务“究竟缺了哪些字段血缘”。
  const graphPanel = loginPage.locator('[role="tabpanel"]:visible, .ant-tabs-content:visible, .el-tab-pane:visible')
    .filter({ hasText: /数据血缘|当前表|上游|下游/ }).last();
  const graphSvgs = graphPanel.locator('svg:visible');
  const sourceInGraph = await graphSvgs.filter({ hasText: SOURCE }).last().isVisible().catch(() => false);
  const targetInGraph = await graphSvgs.filter({ hasText: TARGET }).last().isVisible().catch(() => false);
  if (!sourceInGraph || !targetInGraph) {
    const missingNodeText = [
      !sourceInGraph ? `来源表 ${SOURCE}` : '',
      !targetInGraph ? `目标表 ${TARGET}` : '',
    ].filter(Boolean).join('、');
    const checks = RELATIONS.map(({ sourceField, targetField }) => ({
      relation: `${SOURCE}.${sourceField} -> ${TARGET}.${targetField}`,
      result: '缺失' as const,
      detail: `表级图谱未展示${missingNodeText}，未生成关系，无法进入字段详情弹窗。`,
    }));
    const summary = [
      `字段关系总数=${checks.length}；正确=0；缺失=${checks.length}；异常=0`,
      ...checks.map((item) => `${item.result}｜${item.relation}｜${item.detail}`),
    ].join('\n');
    console.log(`[field-lineage] GBase relation summary\n${summary}`);
    await report('字段血缘-GBase三字段直传关系网验证', false, summary);
    throw new Error(`GBase 表级血缘未生成，以下字段关系均无法验证。\n${summary}`);
  }

  const targetExpand = await rightMostVisible(loginPage.getByText('展开', { exact: true }), '展开');
  await targetExpand.click();
  const fieldSearch = await rightMostVisible(loginPage.locator('input[placeholder*="字段"]:visible'), '搜索字段');
  const checks: CheckResult[] = [];

  for (const { sourceField, targetField } of RELATIONS) {
    const relation = `${SOURCE}.${sourceField} -> ${TARGET}.${targetField}`;
    let dialog: Locator | undefined;
    try {
      // 展开节点默认只显示少量字段；每一条均从节点内搜索，不能依赖默认前三条。
      await fieldSearch.fill(targetField);
      await loginPage.waitForTimeout(250);
      await (await rightMostVisible(loginPage.getByText(targetField, { exact: true }), `目标字段 ${targetField}`)).click();
      dialog = loginPage.locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible').last();
      await expect(dialog).toBeVisible({ timeout: 8_000 });
      await expectRelationInDialog(dialog, sourceField, targetField);
      checks.push({ relation, result: '正确', detail: '字段详情同时展示来源表/字段与目标表/字段。' });
    } catch (error) {
      const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
      const result: CheckResult['result'] = /缺少|未显示|not\.toBeVisible|等待.*超时/i.test(detail) ? '缺失' : '异常';
      checks.push({ relation, result, detail });
    } finally {
      if (dialog) await closeDialog(loginPage, dialog);
    }
  }

  if (process.env.LINEAGE_CAPTURE_DIALOG === '1') {
    await loginPage.screenshot({ path: 'test-results/gbase-field-lineage-summary.png', fullPage: true });
  }
  assertNoUnexpectedLineageConsoleErrors(consoleErrors);
  const correct = checks.filter((item) => item.result === '正确');
  const missing = checks.filter((item) => item.result === '缺失');
  const abnormal = checks.filter((item) => item.result === '异常');
  const summary = [
    `字段关系总数=${checks.length}；正确=${correct.length}；缺失=${missing.length}；异常=${abnormal.length}`,
    ...checks.map((item) => `${item.result}｜${item.relation}｜${item.detail}`),
  ].join('\n');
  console.log(`[field-lineage] GBase relation summary\n${summary}`);
  await report('字段血缘-GBase三字段直传关系网验证', missing.length === 0 && abnormal.length === 0, summary);
  if (missing.length || abnormal.length) {
    throw new Error(`GBase 字段血缘逐条验证未全部通过。\n${summary}`);
  }
});
