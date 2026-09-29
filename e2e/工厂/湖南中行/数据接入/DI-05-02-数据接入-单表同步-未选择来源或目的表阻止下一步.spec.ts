/**
 * DI-05-02｜数据接入｜单表同步-未选择来源或目的表阻止下一步
 *
 * DS-PERM-66 清洁环境迁移说明（静态开发，未启动浏览器回归）：
 *   - 本用例为纯必填校验链路：不选择任何来源/目的数据源即点击“下一步”，
 *     不读取、不依赖任何历史任务、旧表或固定数据源/库/Schema 展示名，
 *     天然满足清洁环境要求（环境清空后可独立执行）；
 *   - 无物理库依赖：不建表、不查询 DB，DB_* 未配置时同样可执行；
 *   - 断言不依赖瞬时 toast：以第一步来源/目的类型必填控件仍在、
 *     字段映射区未出现为持久证据；不产生任何任务、表或同步记录。
 */
import { clickMenu, expect, test } from '../utils.js';
import { openSingleTableSyncCreate } from './数据集成工具.js';

test.describe('DI-05-02｜数据接入｜单表同步必填校验', () => {
  test('DI-05-02｜数据接入｜未选择来源表和目的表时不能进入字段映射', async ({ loginPage, report }) => {
    test.setTimeout(60_000);
    const page = loginPage;
    await openSingleTableSyncCreate(page);

    await page.getByRole('button', { name: '下一步', exact: true }).click();
    // 页面仍停留在第一步，且来源/目的数据源必填控件仍在；不产生任务、表或同步记录。
    await expect(page.locator('#sourceDatabaseTypeId')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#sinkDatabaseTypeId')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/当前共\s*\d+\s*个来源字段/)).toHaveCount(0);
    await report('数据集成-单表同步-未选择来源目的表-阻止下一步', true, '未填写任何来源/目的表配置；页面保持在选择数据源步骤。');
  });
});
