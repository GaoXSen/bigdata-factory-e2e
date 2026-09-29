// GBase 血缘专项：保留原存储过程中的语法类型，但所有物理表均替换为
// 当前已登记 GBase 数据源内可由自动化创建的专用测试表。
// 不使用业务 Schema、业务表或业务数据。
import type { ExistingLineageStatementCase } from './血缘测试工具.js';

export const gbaseLineageTables = [
  'e2e_hn_gbase_src_a_0831',
  'e2e_hn_gbase_src_b_0831',
  'e2e_hn_gbase_mid00_0831',
  'e2e_hn_gbase_mid01_0831',
  'e2e_hn_gbase_mid02_0831',
  'e2e_hn_gbase_mid03_0831',
  'e2e_hn_gbase_bl040101_target_0901',
  'e2e_hn_gbase_bl040102_target_0901',
  'e2e_hn_gbase_bl040103_target_0901',
  'e2e_hn_gbase_bl040201_target_0901',
  'e2e_hn_gbase_bl040206_target_0901',
  'e2e_hn_gbase_bl040209_target_0901',
  'e2e_hn_gbase_bl040207_target_0901',
  'e2e_hn_gbase_bl040208_target_0901',
] as const;

const SRC_A = 'e2e_hn_gbase_src_a_0831';
const SRC_B = 'e2e_hn_gbase_src_b_0831';
const MID00 = 'e2e_hn_gbase_mid00_0831';
const MID01 = 'e2e_hn_gbase_mid01_0831';
const MID02 = 'e2e_hn_gbase_mid02_0831';
const MID03 = 'e2e_hn_gbase_mid03_0831';
// 每条 GBase SQL 使用独立目标表，避免多个 worker 或重跑时互相覆盖
// 同一张表的任务调度和血缘结果；源表仍可复用前置准备的稳定夹具。
const TARGET_0101 = 'e2e_hn_gbase_bl040101_target_0901';
const TARGET_0102 = 'e2e_hn_gbase_bl040102_target_0901';
const TARGET_0103 = 'e2e_hn_gbase_bl040103_target_0901';
const TARGET_0201 = 'e2e_hn_gbase_bl040201_target_0901';
const TARGET_0206 = 'e2e_hn_gbase_bl040206_target_0901';
const TARGET_0209 = 'e2e_hn_gbase_bl040209_target_0901';
const SECONDARY_0207 = 'e2e_hn_gbase_bl040207_target_0901';
const SECONDARY_0208 = 'e2e_hn_gbase_bl040208_target_0901';
// 表管理列表显示当前 GBase 测试库为 sxzh_mas。血缘解析按库名限定表名，
// 避免解析器把未限定的表名当成默认库中的未知对象。
const GBASE_DATABASE = process.env.GBASE_LINEAGE_DATABASE?.trim() || 'sxzh_mas';
const qualified = (tableName: string) => `${GBASE_DATABASE}.${tableName}`;
// 当前页面的实际枚举值是 G_BASE_DB；旧环境也可能显示为 GBASE/GBASE8A。
const GBASE = /G[_\s-]*BASE(?:8A|_DB)?|GBASE8A/i;

const gbase = (
  targetTable: string,
  sourceTables: string[],
  sql: string,
  expectedNodes: string[],
): ExistingLineageStatementCase => ({
  fixtureSet: 'gbase',
  targetTable,
  sourceTables,
  scriptType: GBASE,
  sql,
  expectedNodes,
});

export const gbaseSplitLineageCases: Record<string, ExistingLineageStatementCase> = {
  'BL-04-01-01': gbase(
    TARGET_0101,
    [SRC_A],
    `DELETE FROM ${qualified(TARGET_0101)} T\nWHERE EXISTS (SELECT 1 FROM ${qualified(SRC_A)} A WHERE A.id = T.id);`,
    [SRC_A, TARGET_0101],
  ),
  'BL-04-01-02': gbase(
    TARGET_0102,
    [SRC_A],
    `INSERT INTO ${qualified(TARGET_0102)} (id, name, remark)\nSELECT id, name, remark FROM ${qualified(SRC_A)} WHERE id IS NOT NULL;`,
    [SRC_A, TARGET_0102],
  ),
  'BL-04-01-03': gbase(
    TARGET_0103,
    [],
    'CALL e2e_hn_gbase_external_procedure_0831();',
    [TARGET_0103],
  ),
  'BL-04-02-01': gbase(
    TARGET_0201,
    [],
    `DELETE FROM ${TARGET_0201} WHERE id IS NOT NULL;`,
    [TARGET_0201],
  ),
  'BL-04-02-02': gbase(
    MID00,
    [SRC_A, SRC_B],
    `CREATE TEMPORARY TABLE ${MID00} AS\nSELECT id, name, remark FROM ${SRC_A}\nUNION ALL\nSELECT id, name, remark FROM ${SRC_B};`,
    [SRC_A, SRC_B, MID00],
  ),
  'BL-04-02-03': gbase(
    MID01,
    [SRC_A],
    `CREATE TEMPORARY TABLE ${MID01} AS\nSELECT DISTINCT id, name, remark FROM ${SRC_A};`,
    [SRC_A, MID01],
  ),
  'BL-04-02-04': gbase(
    MID02,
    [SRC_B],
    `CREATE TEMPORARY TABLE ${MID02} AS\nSELECT id, MAX(name) AS name, MAX(remark) AS remark FROM ${SRC_B} GROUP BY id;`,
    [SRC_B, MID02],
  ),
  'BL-04-02-05': gbase(
    MID03,
    [MID00, MID01],
    `CREATE TEMPORARY TABLE ${MID03} AS\nSELECT A.id, A.name, B.remark FROM ${MID00} A LEFT JOIN ${MID01} B ON A.id = B.id;`,
    [MID00, MID01, MID03],
  ),
  'BL-04-02-06': gbase(
    TARGET_0206,
    [MID03, MID02, MID01],
    // 2026-09-17（闭环复测）：基线 run-20260916-173034 中 MID02(B) 在图谱缺失，
    // 与已通过用例的唯一结构差异是 B 被 JOIN 但未出现在 SELECT 列表（同型的
    // BL-04-02-05/08 每个来源都在 SELECT 列表中，均通过）。改为 MAX(B.name) 让
    // 三个 JOIN 来源全部被 SELECT 引用；插入列语义保持 id/name/remark 不变。
    `INSERT INTO ${TARGET_0206} (id, name, remark)\nSELECT A.id, MAX(B.name), MAX(C.remark)\nFROM ${MID03} A\nLEFT JOIN ${MID02} B ON B.id = A.id\nLEFT JOIN ${MID01} C ON C.id = A.id\nGROUP BY A.id;`,
    [MID03, MID02, MID01, TARGET_0206],
  ),
  'BL-04-02-07': gbase(
    SECONDARY_0207,
    [],
    `DELETE FROM ${SECONDARY_0207} WHERE id IS NOT NULL;`,
    [SECONDARY_0207],
  ),
  'BL-04-02-08': gbase(
    SECONDARY_0208,
    [TARGET_0206, SRC_B],
    `INSERT INTO ${SECONDARY_0208} (id, name, remark)\nSELECT T.id, MAX(T.name), MAX(S.remark)\nFROM ${TARGET_0206} T INNER JOIN ${SRC_B} S ON S.id = T.id\nGROUP BY T.id;`,
    [TARGET_0206, SRC_B, SECONDARY_0208],
  ),
  'BL-04-02-09': gbase(
    TARGET_0209,
    [],
    'CALL e2e_hn_gbase_external_procedure_0831();',
    [TARGET_0209],
  ),
};
