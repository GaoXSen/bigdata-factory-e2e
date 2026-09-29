/**
 * BL-FLD-00-04｜字段血缘｜文件接入 XLS 来源表初始化
 *
 * Excel 97-2003（.xls）由后端按 sheet 解析：无“列分隔符”步骤，资源为单数据
 * sheet（文本单元格，五字段与 CSV 基线一致）。资源由
 * scripts/generate-fld-excel-fixtures.ps1 生成，可重复执行再生。
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

// 短文件名：后端按文件名主体生成 file_table_name 落库，长名主体（30 字符）会触发
// Data too long 截断异常导致上传失败、预览为空（同 BL-FLD-00-03 归因）。
const FILE_PATH = process.env.LINEAGE_XLS_SOURCE_PATH
  ?? path.resolve(process.cwd(), 'e2e', '工厂', '湖南中行', '资源', '字段血缘', '文件接入', 'fld_xls.xls');
const TABLE = 'e2e_hn_fld_xls_src_0920';

test('BL-FLD-00-04｜字段血缘｜上传 XLS 自动建表 e2e_hn_fld_xls_src_0920', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(240_000);
  const page = loginPage;
  await access(FILE_PATH, fsConstants.R_OK);
  const detail = await createFileAccessSourceTable(page, {
    filePath: FILE_PATH,
    fileLabel: 'fld_xls.xls',
    sheetName: 'Sheet1',
    tableName: TABLE,
    sourceFields: FLD_FILE_ACCESS_SOURCE_FIELDS,
  });
  await assertNoConsoleErrors(consoleErrors);
  await report('字段血缘-XLS文件来源表初始化', true, detail);
});
