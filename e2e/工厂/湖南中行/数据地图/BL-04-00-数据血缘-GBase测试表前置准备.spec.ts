import { test } from '../utils.js';
import { ensureGBaseLineageTables } from './血缘测试工具.js';
import { gbaseLineageTables } from './GBase拆分血缘用例.js';

// 首次换环境时需要逐张跨状态查询、创建并上线 8 张 GBase 专用表；
// 后续重跑只复用已有表，通常远低于该上限。
test.describe.configure({ timeout: 600_000 });

test('BL-04-00｜数据血缘｜GBase 专用测试表前置准备', async ({ loginPage, report }) => {
  await ensureGBaseLineageTables(loginPage, [...gbaseLineageTables]);
  await report(
    'GBase 血缘专用表前置准备',
    true,
    `已在现有 GBase 数据源创建并上线：${gbaseLineageTables.join('、')}`,
  );
});
