/** BL-FLD-01-02｜字段血缘｜直接验证已解析的 SFTP 来源表字段详情。 */
import type { Page } from '@playwright/test';
import { expect, test } from '../utils.js';
import {
  assertNoUnexpectedLineageConsoleErrors,
  escapeRegExp,
  lineageSftpBaseFileName,
  openTableLineage,
} from './血缘测试工具.js';

const SFTP_SOURCE = 'e2e_hn_fld_sftp_src_0920';
// 2026-09-17（闭环复测）：上游文件节点名带动态日期（历史脚本中的“${current_date}”
// 是字面占位符，不能用作精确匹配）；改为按基础文件名前缀正则定位节点，
// 关系描述里用固定前缀代称，不放宽弹窗内字段级断言。
// DS-PERM-47：基础文件名与 BL-FLD-00-02 的 SFTP 接入任务同源
// （LINEAGE_SFTP_BASE_FILE 单项覆盖，默认 SFTP profile baseFile 去扩展名）；
// 这里只读名称、不发起 SFTP 连接，可在模块加载期解析，不影响 --list。
const LINEAGE_SFTP_BASE_FILE = lineageSftpBaseFileName();
const FILE_NODE_PATTERN = new RegExp(escapeRegExp(LINEAGE_SFTP_BASE_FILE));
const FILE_NODE_LABEL = `${LINEAGE_SFTP_BASE_FILE}_<动态日期>`;
const FIELD_RELATIONS = [
  { sourceField: 'sftp_id', targetField: 'sftp_id' },
  { sourceField: 'shared_key', targetField: 'shared_key' },
  { sourceField: 'region_code', targetField: 'region_code' },
  { sourceField: 'sftp_amount', targetField: 'sftp_amount' },
  { sourceField: 'business_date', targetField: 'business_date' },
] as const;

type FieldCheck = {
  relation: string;
  result: '正确' | '缺失' | '异常';
  detail: string;
};

/** 图谱中同一文字/输入框会同时出现在左右表节点，按横坐标取右侧当前表节点。 */
async function rightMostVisible<T extends ReturnType<Page['locator']>>(
  candidates: T,
  description: string,
): Promise<T> {
  let winner: ReturnType<Page['getByText']> | undefined;
  let largestX = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const box = await candidate.boundingBox();
    if (box && box.x > largestX) {
      winner = candidate;
      largestX = box.x;
    }
  }
  if (!winner) throw new Error(`字段血缘图未找到右侧当前表控件：${description}`);
  return winner as T;
}

async function rightMostText(page: Page, text: string | RegExp) {
  return await rightMostVisible(page.getByText(text, { exact: text instanceof RegExp ? undefined : true }), `文字“${String(text)}”`);
}

async function closeDialog(page: Page, dialog: ReturnType<Page['locator']>): Promise<void> {
  if (!await dialog.isVisible().catch(() => false)) return;
  await page.keyboard.press('Escape').catch(() => undefined);
  await expect(dialog).toBeHidden({ timeout: 3_000 }).catch(async () => {
    const close = dialog.getByRole('button', { name: /关闭|close/i }).last();
    if (await close.isVisible().catch(() => false)) await close.click();
  });
}

/**
 * 不能仅断言“字段血缘”弹窗标题：标题只表示点到了当前字段。
 * 必须在弹窗内部同时找到上游文件节点、当前表节点、两端字段和“文件接入”边，
 * 才能证明这条字段关系真实被前端渲染。
 */
async function expectFieldRelationDialog(
  dialog: ReturnType<Page['locator']>,
  sourceField: string,
  targetField: string,
): Promise<void> {
  const title = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
  expect(title).toContain(`字段血缘：${SFTP_SOURCE}.${targetField}`);

  const graphSvgs = dialog.locator('svg:visible');
  const sourceNode = graphSvgs.filter({ hasText: FILE_NODE_PATTERN }).last();
  const targetNode = graphSvgs.filter({ hasText: SFTP_SOURCE }).last();
  await expect(sourceNode, `字段弹窗未展示上游文件节点：${FILE_NODE_LABEL}`).toBeVisible({ timeout: 5_000 });
  await expect(targetNode, `字段弹窗未展示当前表节点：${SFTP_SOURCE}`).toBeVisible({ timeout: 5_000 });
  await expect(sourceNode.getByText(sourceField, { exact: true }), `上游节点未展示字段：${sourceField}`)
    .toBeVisible({ timeout: 5_000 });
  await expect(targetNode.getByText(targetField, { exact: true }), `当前表节点未展示字段：${targetField}`)
    .toBeVisible({ timeout: 5_000 });
  await expect(dialog.getByText('文件接入', { exact: true }).last(), '字段弹窗缺少“文件接入”关系边')
    .toBeVisible({ timeout: 5_000 });
}

test('BL-FLD-01-02｜字段血缘｜SFTP来源表全部字段关系逐条验证', async ({ loginPage, consoleErrors, report }) => {
  // 表查询详情偶发需重新打开才能返回元数据，给予导航重试窗口；字段弹窗本身仍使用短断言。
  test.setTimeout(150_000);
  // BUG-F03（产品缺陷，2026-09-17 闭环复核）：SFTP 文件来源字段详情弹窗曾不渲染
  // 上游文件节点与字段（连续两轮全量失败）；同链路 BL-FLD-01-00D 的字段弹窗断言
  // 已在基线 run-20260916-173034 通过，跳过疑似陈旧，移除后实测并按真实断言记录。
  await openTableLineage(loginPage, SFTP_SOURCE);

  // 已由页面现状确认：SFTP 接入文件节点 → 当前 SFTP 表，边名称为“文件接入”。
  await expect(await rightMostText(loginPage, FILE_NODE_PATTERN)).toBeVisible({ timeout: 12_000 });
  await expect(loginPage.getByText('文件接入', { exact: true }).last()).toBeVisible({ timeout: 12_000 });
  await expect(await rightMostText(loginPage, SFTP_SOURCE)).toBeVisible({ timeout: 12_000 });

  // 当前表在图谱右侧。不能按 DOM 顺序取“展开”，否则会误点左侧文件节点。
  const expand = await rightMostText(loginPage, '展开');
  await expand.click();
  // 每个已展开表节点默认只展示前三个字段。字段验证必须使用节点内“搜索字段”
  // 定位，不能因字段超过默认展示数量而误判字段血缘不存在。
  const fieldSearch = await rightMostVisible(
    loginPage.locator('input[placeholder*="字段"]:visible'),
    '搜索字段输入框',
  );
  const checks: FieldCheck[] = [];
  for (const { sourceField, targetField } of FIELD_RELATIONS) {
    const relation = `${FILE_NODE_LABEL}.${sourceField} -> ${SFTP_SOURCE}.${targetField}`;
    let dialog: ReturnType<Page['locator']> | undefined;
    try {
      await fieldSearch.fill(targetField);
      await loginPage.waitForTimeout(250);
      // 同理，选择右侧 SFTP 当前表展开后的字段，而不是左侧文件节点字段。
      await (await rightMostText(loginPage, targetField)).click();
      dialog = loginPage.locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible').last();
      await expect(dialog).toBeVisible({ timeout: 8_000 });
      await expectFieldRelationDialog(dialog, sourceField, targetField);
      checks.push({ relation, result: '正确', detail: '字段弹窗同时展示上下游表、字段和文件接入关系边。' });
    } catch (error) {
      const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
      const result: FieldCheck['result'] = /未展示|缺少|not.toBeVisible|等待.*超时/i.test(detail) ? '缺失' : '异常';
      checks.push({ relation, result, detail });
    } finally {
      if (dialog) await closeDialog(loginPage, dialog);
    }
  }

  if (process.env.LINEAGE_CAPTURE_DIALOG === '1') {
    await loginPage.screenshot({ path: 'test-results/sftp-field-lineage-summary.png', fullPage: true });
  }
  assertNoUnexpectedLineageConsoleErrors(consoleErrors);
  const correct = checks.filter((item) => item.result === '正确');
  const missing = checks.filter((item) => item.result === '缺失');
  const abnormal = checks.filter((item) => item.result === '异常');
  const summary = [
    `字段关系总数=${checks.length}；正确=${correct.length}；缺失=${missing.length}；异常=${abnormal.length}`,
    ...checks.map((item) => `${item.result}｜${item.relation}${item.detail ? `｜${item.detail}` : ''}`),
  ].join('\n');
  console.log(`[field-lineage] SFTP relation summary\n${summary}`);
  await report('字段血缘-SFTP来源表字段关系网验证', missing.length === 0 && abnormal.length === 0, summary);
  if (missing.length || abnormal.length) {
    throw new Error(`SFTP 字段血缘逐条验证未全部通过。\n${summary}`);
  }
});
