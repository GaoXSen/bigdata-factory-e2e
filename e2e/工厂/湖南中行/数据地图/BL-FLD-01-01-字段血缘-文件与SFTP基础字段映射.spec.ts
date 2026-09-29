/** BL-FLD-01-01｜字段血缘｜文件接入 + SFTP 单条 SQL 汇总到 MySQL primary 目标表（2026-09-20 110 环境迁移）。 */
import type { Locator } from '@playwright/test';
import { test, expect } from '../utils.js';
import { assertNoUnexpectedLineageConsoleErrors, configureAutoLineage, ensureFieldLineageTargetTable, expectLineage, lineageDataSourceLabel, openTableLineage } from './血缘测试工具.js';

// 2026-09-20（110 环境迁移）：来源/目标全部落在 MySQL 110（e2e_test），表名加 _0920。
const FILE_SOURCE = 'e2e_hn_fld_file_src_0920';
const SFTP_SOURCE = 'e2e_hn_fld_sftp_src_0920';
// 每条待解析 SQL 使用新目标表。解析器当前要求单条生产脚本且末尾不能带分号，
// 所以不复用此前多语句/带分号的 union_target_v1。
const TARGET = 'e2e_hn_fld_file_sftp_join_target_0920';

// 保持业务已人工验证的标准多行格式：无终止分号，也没有额外右括号。
const SQL = `INSERT INTO ${TARGET} (
  file_id,
  sftp_id,
  shared_key,
  file_amount,
  sftp_amount,
  business_date
)
SELECT
  f.file_id,
  s.sftp_id,
  f.shared_key,
  f.file_amount,
  s.sftp_amount,
  f.business_date
FROM ${FILE_SOURCE} f
INNER JOIN ${SFTP_SOURCE} s
  ON f.shared_key = s.shared_key`;

type FieldExpectation = {
  targetField: string;
  sources: Array<{ table: string; field: string }>;
};

// 字段血缘的最小断言单位是“来源字段 -> 目标字段”边；计算字段允许包含两条
// 上游边，常量字段则明确要求不出现来源表节点。无需另外验证长链路。
const FIELD_EXPECTATIONS: FieldExpectation[] = [
  { targetField: 'file_id', sources: [{ table: FILE_SOURCE, field: 'file_id' }] },
  { targetField: 'sftp_id', sources: [{ table: SFTP_SOURCE, field: 'sftp_id' }] },
  { targetField: 'shared_key', sources: [{ table: FILE_SOURCE, field: 'shared_key' }] },
  { targetField: 'file_amount', sources: [{ table: FILE_SOURCE, field: 'file_amount' }] },
  { targetField: 'sftp_amount', sources: [{ table: SFTP_SOURCE, field: 'sftp_amount' }] },
  { targetField: 'business_date', sources: [{ table: FILE_SOURCE, field: 'business_date' }] },
];

type CheckResult = {
  field: string;
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
  if (!winner) throw new Error(`字段血缘图未找到右侧目标表控件：${description}`);
  return winner;
}

async function closeDialog(dialog: Locator): Promise<void> {
  if (!await dialog.isVisible().catch(() => false)) return;
  await dialog.page().keyboard.press('Escape').catch(() => undefined);
  await expect(dialog).toBeHidden({ timeout: 3_000 }).catch(async () => {
    const close = dialog.getByRole('button', { name: /关闭|close/i }).last();
    if (await close.isVisible().catch(() => false)) await close.click();
  });
}

async function assertFieldEdges(dialog: Locator, item: FieldExpectation): Promise<void> {
  await expect(dialog).toContainText(`字段血缘：${TARGET}.${item.targetField}`);
  if (process.env.LINEAGE_CAPTURE_DIALOG === '1') {
    await dialog.screenshot({ path: `test-results/file-sftp-field-lineage-${item.targetField}.png` });
  }

  if (item.sources.length === 0) {
    await expect(dialog.getByText('SQL自动解析', { exact: true })).not.toBeVisible();
    await expect(dialog).not.toContainText(FILE_SOURCE.slice(0, 18));
    await expect(dialog).not.toContainText(SFTP_SOURCE.slice(0, 18));
    return;
  }

  await expect(dialog.getByText('SQL自动解析', { exact: true }), '字段详情缺少 SQL 自动解析关系边')
    .toBeVisible({ timeout: 6_000 });
  for (const source of item.sources) {
    await expect(dialog, `字段详情未展示来源表：${source.table}`).toContainText(source.table.slice(0, 18));
    // 这组六条基础边的来源、目标字段均同名。直接 toBeVisible() 会因弹窗内
    // 同时存在两个同名字段而触发 Playwright strict-mode，之前被错误归类为“缺失”。
    // 两端字段都出现才视为有该字段边；表名前缀和 SQL 自动解析边已在上方确认。
    if (source.field === item.targetField) {
      await expect.poll(
        () => dialog.getByText(source.field, { exact: true }).count(),
        { timeout: 6_000, message: `字段详情未在两端节点同时展示字段：${source.table}.${source.field}` },
      ).toBeGreaterThanOrEqual(2);
    } else {
      await expect(dialog.getByText(source.field, { exact: true }), `字段详情未展示来源字段：${source.table}.${source.field}`)
        .toBeVisible({ timeout: 6_000 });
    }
  }
}

test.describe('BL-FLD-01-01｜字段血缘｜文件与 SFTP 单条 SQL 汇总到 MySQL 110 目标表', () => {
  test('建立任务调度并逐字段验证两来源汇总关系', async ({ loginPage, consoleErrors, report }) => {
    test.setTimeout(240_000);
    const page = loginPage;
    await ensureFieldLineageTargetTable(
      page,
      TARGET,
      'file_id VARCHAR(64), sftp_id VARCHAR(64), shared_key VARCHAR(64), '
        + 'file_amount VARCHAR(32), sftp_amount VARCHAR(32), business_date VARCHAR(32)',
      'mysql',
    );
    await configureAutoLineage(page, {
      targetTable: TARGET,
      sql: SQL,
      expectedNodes: [FILE_SOURCE, SFTP_SOURCE, TARGET],
      expectedRelations: [
        `${FILE_SOURCE}.file_id -> ${TARGET}.file_id`,
        `${SFTP_SOURCE}.sftp_id -> ${TARGET}.sftp_id`,
      ],
      dataSource: 'mysql',
    });
    // 业务已确认当前血缘解析快速完成；固定 1 秒后只读验证，不用固定长等待。
    await page.waitForTimeout(1_000);
    await openTableLineage(page, TARGET);
    try {
      await expectLineage(page, {
        targetTable: TARGET,
        sql: SQL,
        expectedNodes: [FILE_SOURCE, SFTP_SOURCE, TARGET],
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await report('字段血缘-文件与SFTP汇总到MySQL110目标表', false, [
        `目标表=${TARGET}（${lineageDataSourceLabel('mysql')}）`,
        `预期来源表=${FILE_SOURCE}、${SFTP_SOURCE}（文件接入/SFTP 来源表保持原配置）`,
        '任务调度实际提交 SQL：',
        SQL,
        '表级图谱校验结果：',
        detail,
      ].join('\n'));
      throw error;
    }

    await (await rightMostVisible(page.getByText('展开', { exact: true }), '展开')).click();
    const fieldSearch = await rightMostVisible(page.locator('input[placeholder*="字段"]:visible'), '搜索字段');
    const checks: CheckResult[] = [];
    for (const item of FIELD_EXPECTATIONS) {
      let dialog: Locator | undefined;
      try {
        await fieldSearch.fill(item.targetField);
        await page.waitForTimeout(220);
        await (await rightMostVisible(page.getByText(item.targetField, { exact: true }), `目标字段 ${item.targetField}`)).click();
        dialog = page.locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible').last();
        await expect(dialog).toBeVisible({ timeout: 8_000 });
        await assertFieldEdges(dialog, item);
        checks.push({ field: item.targetField, result: '正确', detail: item.sources.length
          ? item.sources.map((source) => `${source.table}.${source.field}`).join('、')
          : '常量字段，无上游字段血缘' });
      } catch (error) {
        const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
        checks.push({
          field: item.targetField,
          result: /未展示|缺少|not\.toBeVisible|等待.*超时/i.test(detail) ? '缺失' : '异常',
          detail,
        });
      } finally {
        if (dialog) await closeDialog(dialog);
      }
    }
    assertNoUnexpectedLineageConsoleErrors(consoleErrors);
    const correct = checks.filter((item) => item.result === '正确');
    const missing = checks.filter((item) => item.result === '缺失');
    const abnormal = checks.filter((item) => item.result === '异常');
    const summary = [
      `字段总数=${checks.length}；正确=${correct.length}；缺失=${missing.length}；异常=${abnormal.length}`,
      ...checks.map((item) => `${item.result}｜${item.field}｜${item.detail}`),
    ].join('\n');
    await report('字段血缘-文件与SFTP汇总到MySQL110目标表', missing.length === 0 && abnormal.length === 0, summary);
    if (missing.length || abnormal.length) {
      throw new Error(`文件接入 + SFTP 汇总字段血缘未全部通过。\n${summary}`);
    }
  });
});
