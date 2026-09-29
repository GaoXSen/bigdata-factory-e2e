/**
 * 字段血缘语法用例工具 — 虚拟来源表 + 目标表（默认 GBase，可切换 MySQL 110）的 SQL 语法字段血缘统一流程。
 *
 * 面向 BL-FLD-02-xx 系列：仿照表级血缘 BL-02 系列的 SQL 语法矩阵，把每一种
 * 语法（简单插入/聚合/CASE/JOIN/CTE/标量子查询/自引用/CTAS）拆成独立 spec。
 * 共同约定：
 * - 来源表全部是“虚拟表”：只在 SQL 文本中出现，不在任何数据源建物理元数据，
 *   验证解析器能否仅凭 SQL 文本生成“虚拟来源表 -> 目标表”的表级和字段级血缘；
 * - 目标表统一在 GBase 建物理表并上线，字段与 SQL 目标列一一对应；
 * - 每条 SQL 使用独立目标表（血缘作业记录只首次创建，复用会互相污染）；
 * - 字段级核验沿用 BL-FLD-01-01/01-03 的模式：展开右侧目标表节点、节点内
 *   搜索字段、打开字段详情弹窗，要求“来源表前缀 + 来源字段 + SQL自动解析边”
 *   同时出现；表级图谱缺失时把全部字段关系标记为“缺失”并汇总，不在第一条
 *   断言处中断，让报告能说明“究竟缺了什么”。
 * - 同名直传边（如 v_id -> v_id）的字段名会同时渲染在弹窗两端节点上，直接
 *   toBeVisible() 会触发 Playwright strict-mode 违例并被误报为“缺失”；这里
 *   与 BL-FLD-01-01 已验证基线一致，改用“两端均出现（计数 >= 2）”断言。
 * - COUNT(*) 等上游语义没有页面证据的列标记 upstreamUnknown：弹窗打开与
 *   标题仍严格校验，但“SQL自动解析”边的有无只采集证据并强制截图（结果记
 *   为“待确认”），不预设“常量”也不预设“有边”，交下一阶段视觉模型裁定。
 */
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import {
  assertNoUnexpectedLineageConsoleErrors,
  configureAutoLineage,
  ensureFieldLineageTargetTable,
  expectLineage,
  lineageDataSourceLabel,
  openTableLineage,
} from './血缘测试工具.js';
import type { LineageDataSource } from './血缘测试工具.js';

export type VirtualFieldSource = {
  table: string;
  field: string;
};

export type VirtualFieldRelation = {
  /** SQL 目标列名，同时是目标表 DDL 字段名。 */
  targetField: string;
  /**
   * 该目标列的上游来源字段。空数组且未声明 upstreamUnknown 时表示已人工
   * 确认的常量列：断言弹窗中不出现“SQL自动解析”边。
   */
  sources: VirtualFieldSource[];
  /**
   * 上游语义未经页面证据确认的列（当前仅 COUNT(*) 一类）：
   * 弹窗打开与标题正确仍严格校验，但“SQL自动解析”边是否出现只记录证据
   * （强制截图 + 明细），结果记为“待确认”，不计入通过/失败。
   */
  upstreamUnknown?: boolean;
};

export type VirtualFieldLineageCaseOptions = {
  /** 用例编号，如 BL-FLD-02-01，用于报告与失败信息归因。 */
  caseNo: string;
  /** 报告标题中文名，如“虚拟来源简单插入多字段直传”。 */
  reportTitle: string;
  /** 目标表名（数据源由 dataSource 决定，默认 GBase）。 */
  targetTable: string;
  /** 目标表 DDL 列定义（不含外层括号），与 SQL 目标列一一对应。 */
  ddlColumns: string;
  /** 待解析的单条生产脚本；沿用现有约定：不带终止分号。 */
  sql: string;
  /** 表级图谱必须出现的节点（虚拟来源表 + 目标表；自引用仅目标表）。 */
  expectedNodes: string[];
  /** 只作为解析器输入的虚拟表名单（CTE 临时名也必须列入，避免被建成物理表）。 */
  virtualSourceTables: string[];
  /** 逐条核验的字段级期望关系。 */
  relations: VirtualFieldRelation[];
  /**
   * 目标表所在数据源：'gbase'（默认，BL-FLD-02 虚拟来源系列沿用；显示名与
   * 目标库走 GBase 专属配置，不依赖 MySQL 默认）或 'mysql'（primary profile，
   * 2026-09-20 110 环境迁移后的文件/SFTP 来源用例；显示名由配置中心推导，
   * 见 LINEAGE_DATA_SOURCE/TABLE_NEW_DATABASE 兼容覆盖，DS-PERM-47）。
   */
  dataSource?: LineageDataSource;
};

export type FieldRelationCheck = {
  relation: string;
  /** “待确认”仅用于上游语义未知的列（如 COUNT(*)）：证据已采集，待视觉复核。 */
  result: '正确' | '缺失' | '异常' | '待确认';
  detail: string;
};

/**
 * 图谱中同一文字/输入框会同时出现在左右两侧节点，按横坐标取右侧（目标表侧）。
 * 与 BL-FLD-01-01/01-02/01-03 中的同名实现保持一致。
 */
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

async function closeDialog(page: Page, dialog: Locator): Promise<void> {
  if (!await dialog.isVisible().catch(() => false)) return;
  await page.keyboard.press('Escape').catch(() => undefined);
  await expect(dialog).toBeHidden({ timeout: 3_000 }).catch(async () => {
    const close = dialog.getByRole('button', { name: /关闭|close/i }).last();
    if (await close.isVisible().catch(() => false)) await close.click();
  });
}

/** 逐个统计可见匹配数；多处同名文案时避免 toBeVisible 的 strict-mode 违例。 */
async function countVisible(candidates: Locator): Promise<number> {
  let visible = 0;
  for (let index = 0; index < await candidates.count(); index += 1) {
    if (await candidates.nth(index).isVisible().catch(() => false)) visible += 1;
  }
  return visible;
}

function describeRelation(targetTable: string, relation: VirtualFieldRelation): string {
  const upstream = relation.sources.length
    ? relation.sources.map((source) => `${source.table}.${source.field}`).join('、')
    : relation.upstreamUnknown ? '上游未知' : '常量';
  return `${upstream} -> ${targetTable}.${relation.targetField}`;
}

function classifyFailure(detail: string): '缺失' | '异常' {
  return /未展示|缺少|未显示|not\.toBeVisible|等待.*超时|Timeout/i.test(detail) ? '缺失' : '异常';
}

/**
 * 校验单个字段的血缘详情弹窗。成功标准不是标题，而是弹窗内同时出现：
 * 目标字段标题、每个来源表名前缀（节点省略号截断，用前 18 位）、来源字段、
 * “SQL自动解析”关系边。已确认常量列（无来源且未声明 upstreamUnknown）要求
 * 这些边均不出现；upstreamUnknown 列（COUNT(*)）只采集边的有无作为证据。
 * 来源字段与目标字段同名时，弹窗两端各渲染一次该字段名，用计数断言避开
 * strict-mode 违例（与 BL-FLD-01-01 基线一致）。
 */
async function verifyOneFieldRelation(
  page: Page,
  targetTable: string,
  relation: VirtualFieldRelation,
  fieldSearch: Locator,
): Promise<FieldRelationCheck> {
  const relationText = describeRelation(targetTable, relation);
  let dialog: Locator | undefined;
  try {
    // 展开节点默认只显示前三个字段；每条关系都必须通过节点内搜索定位。
    await fieldSearch.fill(relation.targetField);
    await page.waitForTimeout(220);
    await (await rightMostVisible(
      page.getByText(relation.targetField, { exact: true }),
      `目标字段 ${relation.targetField}`,
    )).click();
    const detailDialog = page.locator('[role="dialog"]:visible, .el-dialog:visible, .ant-modal:visible').last();
    dialog = detailDialog;
    await expect(detailDialog).toBeVisible({ timeout: 8_000 });
    await expect(detailDialog).toContainText(`字段血缘：${targetTable}.${relation.targetField}`);
    if (process.env.LINEAGE_CAPTURE_DIALOG === '1') {
      await dialog.screenshot({ path: `test-results/vsql-field-lineage-${targetTable}-${relation.targetField}.png` });
    }

    if (relation.sources.length === 0 && relation.upstreamUnknown) {
      // COUNT(*) 等聚合通配列的产品血缘语义没有页面证据：不预设“常量”，
      // 也不预设“有边”。弹窗与标题已在上方严格校验；边是否存在仅采样记录，
      // 并强制保存截图，交给下一阶段视觉模型裁定，不据此判定通过/失败。
      let edgeVisible = false;
      try {
        await expect
          .poll(() => countVisible(detailDialog.getByText('SQL自动解析', { exact: true })), { timeout: 3_000 })
          .toBeGreaterThan(0);
        edgeVisible = true;
      } catch {
        edgeVisible = false;
      }
      await dialog
        .screenshot({ path: `test-results/vsql-field-lineage-${targetTable}-${relation.targetField}-evidence.png` })
        .catch(() => undefined);
      return {
        relation: relationText,
        result: '待确认',
        detail: edgeVisible
          ? '弹窗出现“SQL自动解析”边（证据截图已保存，待视觉确认 COUNT(*) 上游语义）'
          : '弹窗未出现“SQL自动解析”边（证据截图已保存，待视觉确认 COUNT(*) 上游语义）',
      };
    }

    if (relation.sources.length === 0) {
      // 已人工确认的常量列：要求弹窗内不存在可见的“SQL自动解析”边。
      // 用可见计数而不是 not.toBeVisible()，避免多处同名文案触发 strict-mode。
      await expect
        .poll(() => countVisible(detailDialog.getByText('SQL自动解析', { exact: true })), { timeout: 3_000 })
        .toBe(0);
      return { relation: relationText, result: '正确', detail: '常量字段，无上游字段血缘边' };
    }

    // 详情弹窗内的关系边由前端二次请求异步渲染；低峰 1s 内可见，全量回归
    // 高峰可到 8s 以上，给足 10s 避免把渲染慢误报成解析缺失。
    await expect
      .poll(() => countVisible(detailDialog.getByText('SQL自动解析', { exact: true })), {
        timeout: 10_000,
        message: '字段详情缺少 SQL 自动解析关系边',
      })
      .toBeGreaterThan(0);
    for (const source of relation.sources) {
      await expect(dialog, `字段详情未展示来源表前缀：${source.table}`)
        .toContainText(source.table.slice(0, 18));
      if (source.field === relation.targetField) {
        // 同名直传边（v_id -> v_id 等）：弹窗两端节点会同时渲染该字段名，
        // 直接 toBeVisible() 会触发 strict-mode 违例并被误报为“缺失”。
        // 与 BL-FLD-01-01 已验证基线一致：两端都出现（计数 >= 2）才视为有边。
        await expect
          .poll(() => detailDialog.getByText(source.field, { exact: true }).count(), {
            timeout: 10_000,
            message: `字段详情未在两端节点同时展示同名字段：${source.table}.${source.field}`,
          })
          .toBeGreaterThanOrEqual(2);
      } else {
        await expect
          .poll(() => countVisible(detailDialog.getByText(source.field, { exact: true })), {
            timeout: 10_000,
            message: `字段详情未展示来源字段：${source.table}.${source.field}`,
          })
          .toBeGreaterThan(0);
      }
    }
    return {
      relation: relationText,
      result: '正确',
      detail: relation.sources.map((source) => `${source.table}.${source.field}`).join('、'),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return { relation: relationText, result: classifyFailure(detail), detail };
  } finally {
    if (dialog) await closeDialog(page, dialog);
  }
}

async function verifyFieldRelations(
  page: Page,
  targetTable: string,
  relations: VirtualFieldRelation[],
): Promise<FieldRelationCheck[]> {
  let fieldSearch: Locator;
  try {
    const expand = await rightMostVisible(page.getByText('展开', { exact: true }), '展开');
    await expand.click();
    fieldSearch = await rightMostVisible(page.locator('input[placeholder*="字段"]:visible'), '搜索字段');
  } catch (error) {
    // 图谱表级节点已通过，但目标表节点无法展开时属于页面交互异常，不能归为“字段缺失”。
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return relations.map((relation) => ({
      relation: describeRelation(targetTable, relation),
      result: '异常' as const,
      detail,
    }));
  }

  const checks: FieldRelationCheck[] = [];
  for (const relation of relations) {
    const first = await verifyOneFieldRelation(page, targetTable, relation, fieldSearch);
    if (first.result === '正确' || first.result === '待确认') {
      checks.push(first);
      continue;
    }
    // 字段详情弹窗偶发不渲染上游区块（相邻两轮同一用例可一败一过，属详情
    // 接口/渲染偶发空返回）：关闭弹窗后完整重验一次，两次都失败才落最终
    // 结论，避免把偶发空弹窗误报成字段级解析能力缺失。
    const second = await verifyOneFieldRelation(page, targetTable, relation, fieldSearch);
    checks.push(second.result === '正确' ? second : first);
  }
  return checks;
}

function buildSummary(caseNo: string, checks: FieldRelationCheck[]): string {
  const correct = checks.filter((item) => item.result === '正确').length;
  const missing = checks.filter((item) => item.result === '缺失').length;
  const abnormal = checks.filter((item) => item.result === '异常').length;
  const pending = checks.filter((item) => item.result === '待确认').length;
  return [
    `${caseNo} 字段关系总数=${checks.length}；正确=${correct}；缺失=${missing}；异常=${abnormal}；待视觉确认=${pending}`,
    ...checks.map((item) => `${item.result}｜${item.relation}｜${item.detail}`),
  ].join('\n');
}

/**
 * 虚拟来源 SQL 语法字段血缘的统一执行入口：
 * 1. 建目标表（已存在则复用）并上线；
 * 2. 目标表任务调度写入 SQL（虚拟来源表不建物理表），保存并上线；
 * 3. 打开数据血缘图谱，校验表级节点；失败时降级为“全部字段缺失”汇总；
 * 4. 展开目标表节点逐字段核验弹窗关系，输出三态汇总报告。
 */
export async function runVirtualSourceFieldLineageCase(
  page: Page,
  consoleErrors: string[],
  report: (name: string, passed: boolean, detail?: string) => Promise<void>,
  options: VirtualFieldLineageCaseOptions,
): Promise<void> {
  const { caseNo, reportTitle, targetTable, ddlColumns, sql, expectedNodes, virtualSourceTables, relations } = options;
  const dataSource: LineageDataSource = options.dataSource ?? 'gbase';

  await ensureFieldLineageTargetTable(page, targetTable, ddlColumns, dataSource);
  await configureAutoLineage(page, {
    targetTable,
    sql,
    expectedNodes,
    virtualSourceTables,
    dataSource,
  });

  // 解析结果由后端异步回写，通常 1 秒内可见；不用固定长等待掩盖解析失败。
  await page.waitForTimeout(1_000);
  await openTableLineage(page, targetTable);

  let tableLevelError: string | undefined;
  try {
    await expectLineage(page, { targetTable, sql, expectedNodes });
  } catch (error) {
    // 表级图谱缺失（如当前版本虚拟来源节点未生成）不能在第一条字段断言处中断；
    // 统一降级为全部字段“缺失”，报告可以明确归因到表级解析能力。
    tableLevelError = error instanceof Error ? error.message.split('\n')[0] : String(error);
  }

  let checks: FieldRelationCheck[];
  if (tableLevelError) {
    checks = relations.map((relation) => ({
      relation: describeRelation(targetTable, relation),
      result: '缺失' as const,
      detail: `表级图谱未展示全部节点：${tableLevelError}`,
    }));
  } else {
    checks = await verifyFieldRelations(page, targetTable, relations);
  }

  if (process.env.LINEAGE_CAPTURE_DIALOG === '1') {
    await page.screenshot({ path: `test-results/vsql-field-lineage-${targetTable}-summary.png`, fullPage: true });
  }
  assertNoUnexpectedLineageConsoleErrors(consoleErrors);

  const summary = buildSummary(caseNo, checks);
  console.log(`[field-lineage] ${caseNo} summary\n${summary}`);
  // “待确认”是上游语义未知（COUNT(*)）的证据采集结果，不是通过也不是失败；
  // 只有“缺失/异常”才判定用例失败，待确认项在报告中单列交视觉复核。
  const pending = checks.filter((item) => item.result === '待确认');
  const failed = checks.some((item) => item.result === '缺失' || item.result === '异常');
  await report(`字段血缘-${reportTitle}`, !failed, [
    `目标表=${targetTable}（${lineageDataSourceLabel(dataSource)}）`,
    `虚拟来源表=${virtualSourceTables.join('、') || '无'}`,
    '任务调度实际提交 SQL：',
    sql,
    ...(pending.length
      ? [
          `待视觉确认字段=${pending.length}（上游语义未经页面证据确认，本轮仅采集弹窗证据与截图，未判定通过/失败）`,
          ...pending.map((item) => `${item.relation}｜${item.detail}`),
        ]
      : []),
    summary,
  ].join('\n'));
  if (failed) {
    throw new Error(`${caseNo} 字段血缘未全部通过。\n${summary}`);
  }
}

