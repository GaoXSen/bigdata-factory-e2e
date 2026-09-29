import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SINGLE_WAIT_TIMEOUT = 10_000;
const chromiumArgs = [
  ...(process.env.API_HOST_IP
    ? [`--host-resolver-rules=MAP api.bigdata.dev.northking.net ${process.env.API_HOST_IP}`]
    : []),
  // headless 模式没有真实窗口可最大化；并行分块编排器通过 CHROMIUM_WINDOW_SIZE
  // 注入窗口尺寸，避免 headless 落到 800×600 裁切页面底部控件。不设置时行为不变。
  ...(process.env.CHROMIUM_WINDOW_SIZE
    ? [`--window-size=${process.env.CHROMIUM_WINDOW_SIZE}`]
    : []),
  // headed 模式使用真实最大化窗口；配合 viewport:null，避免固定 1280×720
  // 让页面底部控件、下拉选项落到视口外。
  '--start-maximized',
];

function safePathSegment(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|]/g, '-') || 'default';
}

const PROJECT_NAME = process.env.PROJECT_NAME?.trim()
  ? safePathSegment(process.env.PROJECT_NAME)
  : '';

function localRunStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_` +
    `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

/** 裸跑 playwright test 时按项目和精确到秒的时间隔离报告；同一秒重复启动自动补序号。 */
function defaultRunFolder(): string {
  const stamp = `run-${localRunStamp()}`;
  let folder = stamp;
  let sequence = 1;
  const reportRoot = PROJECT_NAME ? path.join('playwright-report', PROJECT_NAME) : 'playwright-report';
  const resultsRoot = PROJECT_NAME ? path.join('test-results', PROJECT_NAME) : 'test-results';
  while (
    fs.existsSync(path.resolve(reportRoot, folder)) ||
    fs.existsSync(path.resolve(resultsRoot, folder))
  ) {
    folder = `${stamp}-${String(sequence).padStart(2, '0')}`;
    sequence += 1;
  }
  return folder;
}

const DEFAULT_RUN_FOLDER = defaultRunFolder();
const DEFAULT_REPORT_ROOT = PROJECT_NAME ? path.join('playwright-report', PROJECT_NAME) : 'playwright-report';
const DEFAULT_RESULTS_ROOT = PROJECT_NAME ? path.join('test-results', PROJECT_NAME) : 'test-results';
const HTML_REPORT_DIR = process.env.HTML_REPORT_DIR ?? path.join(DEFAULT_REPORT_ROOT, DEFAULT_RUN_FOLDER);
const TEST_RESULTS_DIR = process.env.TEST_RESULTS_DIR ?? path.join(DEFAULT_RESULTS_ROOT, DEFAULT_RUN_FOLDER);

// 两阶段血缘后移模式（入口：scripts/执行湖南中行测试.cmd）：
// 血缘用例文件（BL-* 数据血缘 / BL-FLD-* 字段血缘 / DM-07-* 血缘图谱）单条耗时较长，
// 通过环境变量开关把它们拆成独立的最后阶段，让其余用例先执行、先出结果。
// - E2E_LINEAGE_LAST=1：主批次忽略血缘用例文件（先跑非血缘）；
// - E2E_LINEAGE_ONLY=1：只收集血缘用例文件（最后单独跑）；
// 两个开关都未设置时收集行为与历史版本完全一致，其他入口脚本不受影响。
const LINEAGE_FILE_GLOBS = ['**/BL-*.spec.ts', '**/DM-07-*.spec.ts'];
const LINEAGE_LAST = process.env.E2E_LINEAGE_LAST === '1';
const LINEAGE_ONLY = process.env.E2E_LINEAGE_ONLY === '1';

export default defineConfig({
  testDir: './e2e',
  // 正式执行只扫描项目目录；历史用例和录制草稿保留在 e2e 下供追溯，
  // 但不能混入正式报告，避免同一功能被重复执行。
  testIgnore: ['**/归档/**', '**/录制草稿/**'],
// 普通测试用例总时限；单次操作/导航/断言另由 10 秒限制。
  timeout: 30_000,
  expect: {
    timeout: SINGLE_WAIT_TIMEOUT,
  },
  fullyParallel: false,
  // 按 TS 文件并行、文件内保持顺序；写入型链路可由专用脚本显式传 --workers=1。
  workers: Number(process.env.WORKERS ?? (process.env.RUN_MUTATION_TESTS === '1' ? 1 : 5)),
  // 不因某条用例失败而提前停止；后续独立用例继续执行并统一汇总结果。
  maxFailures: 0,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    // 多线程/多命令执行时由每个线程提供独立目录，避免 HTML 报告互相覆盖或锁住。
    ['html', { outputFolder: HTML_REPORT_DIR, open: 'never' }],
  ],
  // 同时运行多个 TS 时隔离截图、视频和 trace，避免同名用例互相覆盖。
  outputDir: TEST_RESULTS_DIR,
  use: {
    baseURL: process.env.BASE_URL,
    // 不覆盖 headed Chromium 的实际窗口尺寸，避免页面在固定视口中被裁切。
    viewport: null,
    actionTimeout: SINGLE_WAIT_TIMEOUT,
    navigationTimeout: SINGLE_WAIT_TIMEOUT,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // 所有实际执行的用例均保留录屏，便于回看成功路径、失败现场和页面实际行为。
    // 视频写入每次运行独立的 test-results 时间戳目录，不覆盖历史结果。
    video: 'on',
  },
  projects: [
    {
      name: 'chromium',
      // 血缘两阶段模式开关（见上方 LINEAGE_FILE_GLOBS 注释）；未启用时不注入字段，行为不变。
      // 注意：project 级 testIgnore/testMatch 会覆盖顶层配置而非合并，
      // 因此启用任一开关时都显式保留顶层“归档/录制草稿”排除规则。
      ...(LINEAGE_ONLY ? { testMatch: LINEAGE_FILE_GLOBS } : {}),
      ...((LINEAGE_LAST || LINEAGE_ONLY)
        ? { testIgnore: ['**/归档/**', '**/录制草稿/**', ...(LINEAGE_LAST ? LINEAGE_FILE_GLOBS : [])] }
        : {}),
      use: {
        ...devices['Desktop Chrome'],
        browserName: 'chromium',
        launchOptions: { args: chromiumArgs },
      },
    },
  ],
});
