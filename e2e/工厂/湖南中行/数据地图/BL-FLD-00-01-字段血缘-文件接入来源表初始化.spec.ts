/**
 * BL-FLD-00-01｜字段血缘｜文件接入来源表初始化
 *
 * 首轮仅创建字段血缘专用的文件接入来源表。该表后续会作为目标表任务调度 SQL
 * 的一个上游来源；不会修改已有文件接入任务或业务表。
 *
 * 2026-09-17（闭环复测）：基线 run-20260916-173034 中本用例的内联流程在尚未选择
 * 数据源/建表方式时就点击“数据预览”，15 秒内字段预览未打开（失败快照中数据源
 * 类型/名称/库/Schema 均停留在“请选择”）。同目录 BL-FLD-00-03/04/05 复用共享工具
 * createFileAccessSourceTable（先填数据源与建表方式、再预览、关闭预览后复验表单）
 * 在同一基线全部通过；本用例改为复用同一工具，仅保留 CSV 与逗号分隔符差异，
 * 五个来源字段断言与目标表名不变。
 */
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { test } from '../utils.js';
import { assertNoConsoleErrors } from '../utils.js';
import {
  createFileAccessSourceTable,
  FLD_FILE_ACCESS_SOURCE_FIELDS,
} from './文件接入来源表工具.js';

// 2026-09-20（110 环境迁移）：原 113 MySQL 失效后来源表曾落在 GBase；现任务调度
// 统一在 MySQL 110（e2e_test）执行，来源表改建在同库，表名加 _0920 与旧批次隔离。
const FILE_SOURCE_TABLE = 'e2e_hn_fld_file_src_0920';
const FILE_SOURCE_PATH = process.env.LINEAGE_FILE_SOURCE_PATH
  ?? path.resolve(process.cwd(), 'e2e', '工厂', '湖南中行', '资源', '字段血缘', '文件接入', 'e2e_lineage_file_source.csv');

test.describe('BL-FLD-00-01｜字段血缘｜文件接入来源表初始化', () => {
  test('上传 CSV 文件并自动建表 e2e_hn_fld_file_src_0920', async ({ loginPage, consoleErrors, report }) => {
    test.setTimeout(240_000);
    const page = loginPage;
    await access(FILE_SOURCE_PATH, fsConstants.R_OK);
    const detail = await createFileAccessSourceTable(page, {
      filePath: FILE_SOURCE_PATH,
      fileLabel: 'e2e_lineage_file_source.csv',
      separator: ',',
      tableName: FILE_SOURCE_TABLE,
      sourceFields: FLD_FILE_ACCESS_SOURCE_FIELDS,
    });
    await assertNoConsoleErrors(consoleErrors);
    await report('字段血缘-文件来源表初始化', true, detail);
  });
});