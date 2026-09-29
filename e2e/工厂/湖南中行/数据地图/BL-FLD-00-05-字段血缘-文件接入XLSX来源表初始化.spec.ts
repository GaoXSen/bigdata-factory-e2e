/**
 * BL-FLD-00-05｜字段血缘｜文件接入 XLSX 来源表初始化
 *
 * xlsx 资源带双 sheet（Sheet1=五字段数据、Sheet2=remark 干扰），验证向导取
 * 第一个/选定的数据 sheet：若解析串到干扰 sheet，字段预览断言会失败并给出
 * 明确归因。资源由 scripts/generate-fld-excel-fixtures.ps1 生成。
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
const FILE_PATH = process.env.LINEAGE_XLSX_SOURCE_PATH
  ?? path.resolve(process.cwd(), 'e2e', '工厂', '湖南中行', '资源', '字段血缘', '文件接入', 'fld_xlsx.xlsx');
const TABLE = 'e2e_hn_fld_xlsx_src_0920';

test('BL-FLD-00-05｜字段血缘｜上传 XLSX（双 sheet）自动建表 e2e_hn_fld_xlsx_src_0920', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(240_000);
  const page = loginPage;
  await access(FILE_PATH, fsConstants.R_OK);
  const detail = await createFileAccessSourceTable(page, {
    filePath: FILE_PATH,
    fileLabel: 'fld_xlsx.xlsx',
    sheetName: 'Sheet1',
    tableName: TABLE,
    sourceFields: FLD_FILE_ACCESS_SOURCE_FIELDS,
  });
  await assertNoConsoleErrors(consoleErrors);
  await report('字段血缘-XLSX文件来源表初始化', true, detail);
});
