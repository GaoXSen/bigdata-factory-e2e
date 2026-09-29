/**
 * FS-04-03｜FTP/SFTP｜路径为空、通知地址为空和远端无写权限
 *
 * 本轮唯一来源表前置迁移（2026-09-29 静态改造）：
 *   - 历史前置 `e2e_hn_lineage_source_0920`（EXPORT_SOURCE_TABLE 环境变量默认值，
 *     见 e2e/test-environment.ts 配置中心）在当前 110/e2e_test 库不存在，来源表
 *     下拉 10s 超时导致两条保存校验断言从未执行（见
 *     结果-Codex-agent7-FS0403校验契约静态清理.md 第 3 节）；
 *   - 现改为本 spec 自备本轮唯一英文来源表 `e2e_fs0403_<uuid8>`（短表名、ASCII）：
 *     beforeAll 经 utils.query() 直连 MySQL CREATE TABLE 并写入 1 行种子
 *     （id/name/remark 三列，与共享工具“清空 Where 条件”的既有契约一致）；DB
 *     profile 由 e2e/test-environment.ts 解析（utils.dbConfig() →
 *     primaryDatabaseOrNull，兼容 DB_HOST 或 DB_USER/DB_PASS 环境变量）。平台
 *     表级联来自实时 JDBC 扫描，物理建表即对“表”下拉可见，无需平台目录元数据；
 *   - 清理仅限同名表：afterAll 精确 DROP TABLE IF EXISTS 本轮 UUID 表名；建表后
 *     种子/计数失败先尽力回收半成品再上抛。不删除、不修改任何历史表或他人资产；
 *   - 空路径拦截与空通知地址可保存两条断言原样保留；“远端无写权限”第三项仍保持
 *     隔离前置 skip，不联网、不写 FTP/SFTP；
 *   - 闸门：FTP_HOST/FTP_USER/FTP_PASS 仍是表单填写前置；MySQL profile 未配置时
 *     按前置不足 skip（无法创建本轮来源表）；数据库不可达时建表真实失败，不伪装通过。
 */
import { test, expect, dbConfig, query, uuid } from '../utils.js';
import { assertNoConsoleErrors, fillByLabel, submitAndExpectSuccess } from '../utils.js';
import { openNewExport } from './文件导出测试工具.js';

/** 本轮唯一英文来源表：短前缀 + 8 位 UUID 后缀；创建与回收只允许精确匹配该名称。 */
const sourceTable = `e2e_fs0403_${uuid()}`;

/** 是否已成功 CREATE 本轮表；只有该标记为真时清理才允许执行 DROP。 */
let roundTableCreated = false;

function requireExportFixture(): string | undefined {
  const missing = ['FTP_HOST', 'FTP_USER', 'FTP_PASS'].filter((name) => !process.env[name]?.trim());
  if (missing.length) return `缺少导出夹具环境变量：${missing.join('、')}`;
  // 来源表改为本轮自建：需要可直连的 MySQL profile（e2e/test-environment.ts 解析，
  // DB_HOST 或 DB_USER/DB_PASS 任一方式提供即视为已配置，未提供则按前置不足跳过）。
  const db = dbConfig();
  if (!db) return '未配置 MySQL 直连（DB_HOST 或 DB_USER/DB_PASS 为空）：无法创建本轮唯一来源表';
  if (db.type !== 'mysql') return 'DB profile 非 MySQL：本轮唯一来源表依赖 MySQL 直建，按前置不足跳过';
  return undefined;
}

/**
 * 创建本轮唯一来源表并写入 1 行种子。前置的 DROP IF EXISTS 只命中本轮 UUID 表名
 * （跨轮重名概率可忽略，同进程重试场景也只回收本表），半建状态同样被该路径回收；
 * 建表/种子/计数任何一步失败原样上抛，让用例以真实错误结束、不伪造通过。
 */
async function createRoundSourceTable(): Promise<void> {
  await query(`DROP TABLE IF EXISTS ${sourceTable}`);
  try {
    await query(
      `CREATE TABLE ${sourceTable} (`
        + 'id int NOT NULL,'
        + 'name varchar(128) DEFAULT NULL,'
        + 'remark varchar(255) DEFAULT NULL,'
        + 'PRIMARY KEY (id)'
        + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );
    roundTableCreated = true;
    await query(`INSERT INTO ${sourceTable} (id, name, remark) VALUES (1, 'fs0403', '本轮唯一来源表')`);
    const rows = await query(`SELECT COUNT(*) AS cnt FROM ${sourceTable}`);
    const count = Number(rows[0]?.cnt ?? -1);
    if (count !== 1) throw new Error(`本轮来源表 ${sourceTable} 种子行数异常：期望 1，实际 ${count}`);
  } catch (error) {
    await dropRoundSourceTable().catch(() => undefined); // 建表后失败：先尽力回收半成品再上抛
    throw error;
  }
}

/** 精确回收本轮同名表；未成功建表时为 no-op，绝不扩大到其他表。 */
async function dropRoundSourceTable(): Promise<void> {
  if (!roundTableCreated) return;
  await query(`DROP TABLE IF EXISTS ${sourceTable}`);
  roundTableCreated = false;
}

test.describe('FS-04-03｜FTP/SFTP｜路径为空、通知地址为空和远端无写权限', () => {
  test.beforeAll(async () => {
    // 环境前置缺失时逐测试按同一原因 skip，这里不连 DB、不建表；建表失败则两条
    // 表单校验用例以真实错误结束（不伪造通过）。
    if (requireExportFixture()) return;
    await createRoundSourceTable();
  });

  test.afterAll(async () => {
    if (!roundTableCreated) return;
    try {
      await dropRoundSourceTable();
    } catch (error) {
      throw new Error(
        `本轮唯一来源表 ${sourceTable} 回收失败，需按同名精确人工删除：`
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  test('FS-04-03｜FTP/SFTP｜文件路径为空时保存被页面拦截', async ({ loginPage, consoleErrors, report }) => {
    const missing = requireExportFixture();
    test.skip(Boolean(missing), missing);

    await openNewExport(loginPage, { integrate: false, notify: '', sourceTable });
    await fillByLabel(loginPage, '文件路径', '');
    await loginPage.getByRole('button', { name: /保\s*存/ }).filter({ visible: true }).last().click();
    await expect(loginPage.getByText(/不能为空|必填|请输入|请选择/).filter({ visible: true }).last())
      .toBeVisible({ timeout: 10_000 });

    await assertNoConsoleErrors(consoleErrors);
    await report('FTP/SFTP-空路径校验', true, '文件路径为空时保存被前端校验拦截；通知地址按当前页面规则为空可不填。');
  });

  test('FS-04-03｜FTP/SFTP｜通知地址为空仍可保存', async ({ loginPage, consoleErrors, report }) => {
    const missing = requireExportFixture();
    test.skip(Boolean(missing), missing);
    test.setTimeout(90_000);

    await openNewExport(loginPage, { integrate: false, notify: '', sourceTable });
    const retryCount = loginPage.getByRole('spinbutton').last();
    if (await retryCount.isVisible().catch(() => false)) await retryCount.fill('0');
    await submitAndExpectSuccess(loginPage, /保\s*存/, '保存成功', 60_000);

    await assertNoConsoleErrors(consoleErrors);
    await report('FTP/SFTP-通知地址为空', true, '通知地址为空按当前产品规则允许保存。');
  });

  test('FS-04-03｜FTP/SFTP｜远端无写权限时执行失败', async () => {
    test.skip(
      true,
      'ENV-PREMISE：未提供可安全使用的“可连通但无写权限”专用远端目录；不能用生产或共享目录伪造无权限场景。',
    );
  });
});
