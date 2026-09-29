/**
 * BL-FLD-00-03｜字段血缘｜文件接入 TXT 来源表初始化
 *
 * 文件接入在 CSV（BL-FLD-00-01）之外支持 txt：资源为竖线分隔纯文本，
 * 向导需要显式填写“列分隔符”。本用例仅创建来源表，不修改已有接入任务。
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

// 短文件名：后端按文件名主体生成 file_table_name 落库（df_file_upload_task.file_table_name），
// 长名主体（e2e_lineage_file_source_txt_v1，29 字符）触发 Data too long 截断异常，预览接口返回空。
const FILE_PATH = process.env.LINEAGE_TXT_SOURCE_PATH
  ?? path.resolve(process.cwd(), 'e2e', '工厂', '湖南中行', '资源', '字段血缘', '文件接入', 'fld_txt.txt');
const TABLE = 'e2e_hn_fld_txt_src_0920';

test('BL-FLD-00-03｜字段血缘｜上传 TXT（竖线分隔）自动建表 e2e_hn_fld_txt_src_0920', async ({ loginPage, consoleErrors, report }) => {
  test.setTimeout(240_000);
  const page = loginPage;
  await access(FILE_PATH, fsConstants.R_OK);
  const detail = await createFileAccessSourceTable(page, {
    filePath: FILE_PATH,
    fileLabel: 'fld_txt.txt',
    separator: '|',
    tableName: TABLE,
    sourceFields: FLD_FILE_ACCESS_SOURCE_FIELDS,
  });
  await assertNoConsoleErrors(consoleErrors);
  await report('字段血缘-TXT文件来源表初始化', true, detail);
});
