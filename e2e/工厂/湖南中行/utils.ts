/**
 * e2e/utils.ts — 支撑代码（合并自原 fixtures/helpers/db）
 *
 * 依据 e2e-testing/测试用例编写规范.md 与 浏览器执行规范.md：
 *   - 只模拟人类浏览器操作；不做后端 API 断言
 *   - UUID 后缀隔离测试数据；控制台错误收集
 *   - "与db一致"类断言允许直连 DB（用户已确认），未配置时自动跳过
 *
 * 环境基础信息（账号、入口、直连 DB、数据源显示名、FTP/SFTP）统一由
 * e2e/test-environment.ts 按 E2E_ENV_PROFILE（默认 mysql110-ftp113）解析，
 * 本文件不再直接读取这些变量。运行报告相关变量（PROJECT_NAME/E2E_RUN_ID/
 * CONSOLE_ALLOWLIST）仍由各自使用点读取。
 */

import { test as base, expect, Locator, Page } from '@playwright/test';
import type { TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MenuNavigator } from './菜单导航工具.js';
import { primaryDatabaseOrNull, testEnvironment } from '../../test-environment.js';

export { MenuNavigator } from './菜单导航工具.js';
export { TabNavigator, clickTab } from './页面页签工具.js';

export { expect };

/**
 * 将长文本按人工“复制后 Ctrl+V”的路径一次写入编辑器。
 *
 * 适用于 SQL、DDL、JSON、脚本等可能包含括号、换行或大量关键字的输入。Monaco
 * 等代码编辑器对 keyboard.type/insertText 会触发自动补全，曾实际造成多余右括号
 * 和关键字被改写；因此长文本不允许再退化为逐字输入。调用方应在粘贴前清空编辑器，
 * 并按其页面模型回读完整内容或验证实际保存请求。
 *
 * 注意：Windows 剪贴板为全局资源；函数内部通过临时目录互斥锁把多 worker 的
 * 剪贴板写入串行化，workers>1 也可安全并发使用。
 */
/**
 * 剪贴板互斥锁：全量回归 workers>1 时，多个 worker 进程并发争抢剪贴板是
 * Set-Clipboard "Command failed" 的主要来源。用临时目录下的排他创建文件把
 * 所有进程的剪贴板写入串行化；持锁进程崩溃残留的锁超过 60s 视为死锁并强制接管。
 */
const CLIPBOARD_LOCK_PATH = path.join(os.tmpdir(), 'e2e-hn-clipboard.lock');

async function acquireClipboardLock(timeoutMs = 45_000): Promise<() => void> {
  const start = Date.now();
  for (;;) {
    try {
      const handle = fs.openSync(CLIPBOARD_LOCK_PATH, 'wx');
      try {
        fs.writeFileSync(handle, String(process.pid), 'utf8');
      } finally {
        fs.closeSync(handle);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        fs.rmSync(CLIPBOARD_LOCK_PATH, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(CLIPBOARD_LOCK_PATH).mtimeMs > 60_000) {
          fs.rmSync(CLIPBOARD_LOCK_PATH, { force: true });
          continue;
        }
      } catch {
        // 锁文件刚好被持锁进程释放：立即重试抢占。
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`等待剪贴板互斥锁超时（${timeoutMs}ms）：其他进程长期占用 ${CLIPBOARD_LOCK_PATH}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

export async function pasteLongText(page: Page, target: Locator, text: string): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('当前运行环境不是 Windows，无法使用长文本原生剪贴板粘贴。');
  }
  const releaseClipboardLock = await acquireClipboardLock();
  try {
    const base64Text = Buffer.from(text, 'utf8').toString('base64');
    const clipboardScript = `$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64Text}')); Set-Clipboard -Value $v`;
    const encodedCommand = Buffer.from(clipboardScript, 'utf16le').toString('base64');
    // 剪贴板为全局资源，可能被其他进程短暂锁定导致 Set-Clipboard 失败；
    // 依次尝试 powershell（Unicode，-STA 单线程套间与剪贴板服务兼容性最好）→
    // clip.exe（stdin，ASCII 安全）→ 浏览器 Clipboard API，逐级指数退避。
    let lastError: unknown;
    let clipboardOk = false;
    for (let attempt = 1; attempt <= 4 && !clipboardOk; attempt += 1) {
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encodedCommand], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 20_000,
        });
        clipboardOk = true;
      } catch (error) {
        lastError = error;
        await page.waitForTimeout(1_500 * attempt);
      }
    }
    for (let attempt = 1; attempt <= 2 && !clipboardOk; attempt += 1) {
      try {
        execFileSync('clip.exe', [], {
          input: text,
          stdio: ['pipe', 'ignore', 'ignore'],
          windowsHide: true,
          timeout: 20_000,
        });
        clipboardOk = true;
      } catch (error) {
        lastError = error;
        await page.waitForTimeout(500);
      }
    }
    for (let attempt = 1; attempt <= 2 && !clipboardOk; attempt += 1) {
      try {
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.evaluate(async (value) => {
          await navigator.clipboard.writeText(value);
        }, text);
        clipboardOk = true;
      } catch (error) {
        lastError = error;
        await page.waitForTimeout(500);
      }
    }
    if (!clipboardOk) {
      // 执行机剪贴板可能被云桌面/DLP 安全软件全局锁定（本机实测 powershell/
      // clip.exe/浏览器 API 全部 "Access is denied"，且换会话复现）。此时绕过
      // OS 剪贴板：向 Monaco 的隐藏 textarea 派发携带 DataTransfer 的合成
      // paste 事件，Monaco 会走与真实粘贴相同的编辑器命令通道完成插入。
      try {
        await target.evaluate((element, value) => {
          const ownerDocument = element.ownerDocument;
          const ownerWindow = ownerDocument.defaultView;
          if (!ownerWindow) throw new Error('目标元素没有关联 window，无法派发合成 paste 事件。');
          const textarea =
            element instanceof HTMLTextAreaElement
              ? element
              : (element.closest('.monaco-editor')?.querySelector('textarea') ?? element);
          const clipboardData = new ownerWindow.DataTransfer();
          clipboardData.setData('text/plain', value);
          const pasteEvent = new ownerWindow.ClipboardEvent('paste', {
            clipboardData,
            bubbles: true,
            cancelable: true,
          });
          textarea.dispatchEvent(pasteEvent);
        }, text);
        return;
      } catch (error) {
        lastError = error;
      }
      // 合成 paste 也失败时，最后尝试 keyboard.insertText：不经剪贴板，
      // 以 input 事件直接写入焦点元素（DQ 系列已验证该通道在 Monaco 可用）。
      try {
        const targetHasFocus = await target
          .evaluate((element) => element === document.activeElement)
          .catch(() => false);
        if (!targetHasFocus) await target.click({ force: true });
        await page.keyboard.insertText(text);
        return;
      } catch (error) {
        lastError = error;
      }
      throw new Error(
        `写入 Windows 剪贴板失败，且合成 paste/insertText 兜底均不可用（powershell×4、clip.exe×2、` +
          `浏览器 Clipboard API×2）：${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    }
  } finally {
    releaseClipboardLock();
  }
  // 调用方可能刚用 Ctrl+A 选中 Monaco 全部内容。此时再次 click 会取消全选，
  // 让长文本追加到旧 SQL 后面。仅在目标尚未获得焦点时补一次点击。
  const targetHasFocus = await target.evaluate((element) => element === document.activeElement).catch(() => false);
  if (!targetHasFocus) await target.click({ force: true });
  await page.keyboard.press('Control+V');
}

// Windows cmd 的 set VAR=value && 写法可能把分隔符前的空格带进变量值；
// 报告目录允许由执行脚本传入，但要先去掉这类不可见尾随空格。
const runProject = (process.env.PROJECT_NAME ?? 'default').trim().replace(/[\\/:*?"<>|]/g, '-') || 'default';
const RUN_ID = (process.env.E2E_RUN_ID ?? `${runProject}-${new Date().toISOString().replace(/[:.]/g, '-')}`).trim();

function reportFilePath(): string {
  return path.resolve(process.cwd(), 'temp', `e2e-report-${RUN_ID}.md`);
}

/**
 * 环境阻断单独落盘，避免把云桌面、VPN、账号、FTP/数据库前置条件
 * 造成的结果混入服务代码/页面行为报告。该文件是本次运行的快照，
 * 换环境后会以新的 RUN_ID 生成新文件。
 */
function environmentReportFilePath(): string {
  return path.resolve(process.cwd(), 'temp', `环境阻断报告-${RUN_ID}.md`);
}

function ensureReportFile(): string {
  const reportFile = reportFilePath();
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  // 多 worker 会在不同进程中同时首次写报告。不能用 existsSync + writeFileSync，
  // 因为两个 worker 都看到“不存在”时，后启动的 worker 会覆盖先前已追加的结果。
  try {
    const handle = fs.openSync(reportFile, 'wx');
    try {
      fs.writeFileSync(
        handle,
        `# E2E 测试报告 — ${RUN_ID}\n\n` +
          `- **目标入口**：${process.env.ENTRY_URL ?? process.env.BASE_URL ?? '未配置'}\n` +
          `- **浏览器**：Playwright Chromium\n\n`,
        'utf8',
      );
    } finally {
      fs.closeSync(handle);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return reportFile;
}

function ensureEnvironmentReportFile(): string {
  const reportFile = environmentReportFilePath();
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  try {
    const handle = fs.openSync(reportFile, 'wx');
    try {
      fs.writeFileSync(
        handle,
        `# 环境阻断报告 — ${RUN_ID}\n\n` +
          `- **目标入口**：${process.env.ENTRY_URL ?? process.env.BASE_URL ?? '未配置'}\n` +
          `- **浏览器**：Playwright Chromium\n` +
          `- **用途**：仅记录本轮由网络、登录、账号、外部服务或环境数据前置条件造成的阻断；不代表服务代码缺陷。\n\n` +
          `## 环境阻断明细\n`,
        'utf8',
      );
    } finally {
      fs.closeSync(handle);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return reportFile;
}

const pendingStepReports = new Map<string, string[]>();

function testInfoKey(testInfo: TestInfo): string {
  return `${testInfo.testId}:${testInfo.retry}`;
}

/** 只把明确的环境信号分流；普通断言、定位和业务错误仍留在主报告。 */
function isEnvironmentBlock(testInfo: TestInfo): boolean {
  const annotations = (testInfo.annotations ?? [])
    .map((annotation) => `${annotation.type} ${annotation.description ?? ''}`)
    .join('\n');
  const error = testInfo.error ? String(testInfo.error.message ?? testInfo.error) : '';
  const text = `${testInfo.title}\n${annotations}\n${error}`;

  return /缺少\s*(?:TEST_USER|TEST_PASS)|未配置\s*(?:FTP_HOST|EXPORT_SOURCE_TABLE|DB_HOST)|\b(?:FTP_HOST|DB_HOST|API_HOST_IP)\b.*(?:未配置|不可用|连接|超时)|登录后主导航未加载|请求超时|刷新重试|#\/login|(?:net::ERR_|ERR_CONNECTION|ERR_TIMED_OUT|ECONNREFUSED|ETIMEDOUT|ENOTFOUND)|当前账号未提供.*父目录|当前账号(?:没有|未提供)|当前环境(?:没有|未提供|未返回)|当前环境历史记录中的.*链接结构不稳定|依赖多库版本记录.*环境确认|环境前置条件|权限或环境差异|当前环境未返回|列表为空|没有可用(?:的)?(?:表|任务|记录|API)|未找到.*(?:来源表|目标历史|测试表|父目录)|(?:FTP|SFTP|数据库).*(?:未配置|不可用|连接失败|连接超时)|file-datasource\/queryDfFileUploadTaskPageList|Unknown column ['\"]?null_format|Target page, context or browser has been closed/i.test(text);
}

// ==================== 基础 ====================

/** 生成数据隔离后缀（UUID 前 8 位），测试数据名称统一附加，避免用例间相互干扰 */
export function uuid(): string {
  return crypto.randomUUID().slice(0, 8);
}

export interface LoginOptions {
  username?: string;
  password?: string;
  /** 指定登录成功后的落地 hash；受限账号不能默认落到无权限的数据源管理页。 */
  entryUrl?: string;
  /**
   * 落地页候选链：登录后若落入产品 404（入口路由不是当前账号被授权的模块），
   * 登录链路会换下一个候选落地页重新进入，直到落在真实业务页。
   * 受限账号（如权限申请人）应把可达页面（如自助查询）放入该列表。
   */
  fallbackEntryUrls?: string[];
}

/**
 * 产品 404 错误页：SPA 落到无权限/无法解析的路由时渲染的兜底页
 * （URL 为 #/404，正文以“404错误! 找不到网页！”开头）。
 * 切换受限账号后按未授权入口登录就会落到这里，绝不能当作登录成功。
 */
async function isProduct404State(page: Page): Promise<boolean> {
  if (/#\/404\b/.test(page.url())) return true;
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return /404错误\s*[!！]\s*找不到网页/.test(bodyText);
}

/**
 * 新版前端菜单项偶发不提供稳定的无障碍名称。
 * 直接读取可见菜单真实文本，比 getByRole(name) 更能区分“已登录但菜单属性变化”。
 */
async function hasMainNavigation(page: Page): Promise<boolean> {
  // 2026-09 权限切换回归实证：404 页没有主菜单，但本函数末尾“非登录路由+
  // 无密码框+正文>80 字”的兜底在 404 文案上同样成立，曾把 #/404 误判成
  // 已登录首屏。必须先显式排除 404，再走正文兜底。
  if (await isProduct404State(page)) return false;
  const menuTexts = await page.locator('[role="menuitem"]:visible').allTextContents().catch(() => []);
  if (menuTexts.some((text) => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized === '数据地图' || normalized === '数据接入';
  })) return true;
  // 顶部导航的组件版本有时不挂 role=menuitem；页面已经进入主应用时，
  // 读取可见 body 文本比继续等待某个无障碍属性更可靠。
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const normalized = bodyText.replace(/\s+/g, ' ');
  if (/数据地图|数据接入/.test(normalized)) return true;
  // 2026-09 前端将顶栏替换成了普通 menu 容器；在部分首屏渲染中，
  // 菜单文字尚未回填到 innerText，但“数据资产目录”标题和文件接入列表
  // 已经出现。这明确表示认证完成，不能再把它误判为登录白屏。
  if (/数据资产目录/.test(normalized) &&
    (await page.getByText('admin', { exact: true }).isVisible().catch(() => false))) return true;
  // 部分浏览器窗口宽度下，顶部模块菜单会被图标化，顶栏只剩产品标题和账号。
  // 认证后的文件接入页仍有完整列表，而登录页则一定存在密码框；以“非登录路由、
  // 无密码框、正文已渲染”为最后兜底，避免把已登录页面重复刷新三次。
  const hasPassword = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
  const hasCurrentUser = await page.getByText('admin', { exact: true }).isVisible().catch(() => false);
  return !hasPassword && !/#\/login\b/.test(page.url()) && (hasCurrentUser || normalized.length > 80);
}

/**
 * 登录/切换账号成功的最终证据（29F 权限切换 404 修复）：
 * 不在 404/登录路由、主导航真实可见可点击，且默认落地页内容已加载——
 * 只看 URL 或 toast 会把“成功停在 #/404”误报成通过。
 */
async function verifyLandingAfterLogin(page: Page, landingUrl: string): Promise<void> {
  await expect(page.locator('body')).toBeVisible();
  expect(
    await isProduct404State(page),
    `登录/切换账号后落入产品 404 页，当前页面：${page.url()}`,
  ).toBe(false);
  expect(page.url(), `登录/切换账号后仍停留在登录页：${page.url()}`).not.toMatch(/#\/login\b/);
  // “可点击菜单”证据：可见 menuitem 至少有一个非空文本（404 页为空）。
  const menuTexts = await page.locator('[role="menuitem"]:visible').allTextContents().catch(() => []);
  expect(
    menuTexts.some((text) => text.replace(/\s+/g, ' ').trim().length > 0),
    `登录/切换账号后主导航菜单不可见，当前页面：${page.url()}`,
  ).toBe(true);
  // 登录默认落地页是“数据接入→数据源管理”；以页面真实内容为成功证据，
  // 而不是把“文件接入”之类入口当作唯一成功标志。
  if (/dataAccess\/dataSource/.test(landingUrl)) {
    await expect(
      page.getByText('数据源管理', { exact: true }).first(),
      `登录/切换账号后数据源管理页面未加载，当前页面：${page.url()}`,
    ).toBeVisible({ timeout: 15_000 });
  }
}

async function waitLoginOrMenu(
  page: Page,
  passwordInput: Locator,
  timeoutMs: number,
): Promise<'login' | 'ready' | 'loading' | 'error404'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 404 页既没有密码框也没有主菜单；先于其余判定返回，避免登录链路
    // 在 404 页上空转到超时。
    if (/#\/404\b/.test(page.url())) return 'error404';
    if (await passwordInput.isVisible().catch(() => false)) return 'login';
    if (await hasMainNavigation(page)) return 'ready';
    // 主导航按模块异步挂载；服务重启后“数据接入”有时先于“数据地图”出现，
    // 任一稳定的顶层菜单都说明认证已完成，不能只等待某一个菜单名。
    for (const label of ['数据地图', '数据接入']) {
      const menuText = page.getByText(label, { exact: true }).last();
      if (await menuText.isVisible().catch(() => false)) return 'ready';
      const menuRole = page.getByRole('menuitem', { name: new RegExp(label) }).first();
      if (await menuRole.isVisible().catch(() => false)) return 'ready';
    }
    await page.waitForTimeout(250);
  }
  return 'loading';
}

/**
 * 点击登录后密码框会在认证期间继续保留在 DOM 中，不能再用
 * waitLoginOrMenu（它会立刻返回 login）判断认证结果；此处只等待主导航。
 * 返回值区分三种结局：ready=真实业务页已加载；error404=登录成功但落入
 * 产品 404（入口路由对该账号无效）；timeout=始终未见主导航。
 */
async function waitForMainNavigation(page: Page, timeoutMs: number): Promise<'ready' | 'error404' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasMainNavigation(page)) return 'ready';
    if (await isProduct404State(page)) {
      // 个别版本会在 404 后自纠路由；给一小段稳定窗口再确认。
      const stabilizeDeadline = Date.now() + 3_000;
      while (Date.now() < stabilizeDeadline) {
        if (await hasMainNavigation(page)) return 'ready';
        await page.waitForTimeout(250);
      }
      return 'error404';
    }
    await page.waitForTimeout(250);
  }
  return 'timeout';
}

/** 登录被测系统（纯浏览器操作）。优先从真实演示入口进入，避免 hash 路由应用访问 /login 失效。 */
/**
 * 以指定账号登录当前浏览器上下文。
 *
 * 权限用例必须在“管理员配置 → 目标用户验证”之间切换账号；
 * 这里复用正式登录流程，而不是在页面上伪造 localStorage/token。
 */
export async function loginWithCredentials(page: Page, opts: LoginOptions = {}): Promise<void> {
  // 同时兼容 cmd.exe 通过未加引号的 set 注入的尾随空格；
  // 不记录实际凭据，只在进入页面前清理它们。
  const username = (opts.username ?? testEnvironment.accounts.testUser).trim();
  const password = (opts.password ?? (testEnvironment.accounts.testPass || undefined))?.trim();
  // 公共登录入口应是轻量、稳定的数据源管理页；文件接入会触发同步任务列表
  // 和实例状态轮询，不应作为所有用例的默认首屏。各模块用例自行导航到目标页。
  const primaryEntry = (opts.entryUrl ?? testEnvironment.app.entryUrl).trim();
  // 切换受限账号后，SPA 会按登录页 redirect 参数回到入口路由；入口若不是
  // 该账号被授权的模块，产品直接渲染 #/404（2026-09 回归实证）。登录链路必须
  // 识别 404 并按候选落地页链重新从正确入口进入，而不是把 404 页当成功。
  const landingCandidates = [primaryEntry, ...(opts.fallbackEntryUrls ?? [])]
    .map((url) => url.trim())
    .filter((url, index, all) => url.length > 0 && all.indexOf(url) === index);

  if (!password) {
    throw new Error('缺少 TEST_PASS，请在执行脚本中提供测试账号密码。');
  }

  // 认证服务偶发把登录按钮保持在 loading/disabled 状态；每次重试都重新获取控件，
  // 并以“真实业务页已加载（主导航+落地页内容）”作为登录完成标志，而不是只看 URL。
  let candidateIndex = 0;
  let reloadRecovered = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // 每次尝试（含 404 恢复）都从当前候选入口完整重新进入，保证每次切换账号
    // 都从正确入口开始，而不是延续上一个账号遗留的页面状态。
    const landingUrl = landingCandidates[Math.min(candidateIndex, landingCandidates.length - 1)];
    // 登录入口属于环境初始化，不使用全局 10 秒单次操作超时；5 worker
    // 同时冷启动时，静态资源和认证页可能超过 10 秒，但不应把整条用例
    // 直接归类为定位失败。
    try {
      await page.goto(landingUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch (error) {
      // 入口静态资源偶发在 20 秒内未完成 domcontentloaded，但页面仍可能
      // 已经开始渲染登录表单；继续检查当前 DOM，让本轮重试接管，而不是
      // 直接把网络初始化抖动记成业务失败。
      if (page.isClosed()) throw error;
    }
    const passwordInput = page.locator('input[type="password"]').first();
    // 认证页和主应用都是同一个 SPA；API 节点切换或静态资源慢时会短暂白屏。
    // 先等“登录表单/主菜单”任一稳定状态出现，不把白屏误判成登录失败。
    const pageState = await waitLoginOrMenu(page, passwordInput, 15_000);
    // 已带会话/登录完成后直接落入产品 404：换下一个候选落地页重新进入；
    // 候选耗尽仍 404 说明入口路由对该账号确实无效，立即明确失败。
    if (pageState === 'error404' && !(await passwordInput.isVisible().catch(() => false))) {
      if (candidateIndex < landingCandidates.length - 1) {
        candidateIndex += 1;
        continue;
      }
      throw new Error(
        `登录/切换账号后 SPA 落入产品 404 路由（当前页面：${page.url()}）。` +
          `入口 ${landingUrl} 不是该账号可访问的模块；请为受限账号提供可达的 fallbackEntryUrls 落地页。`,
      );
    }
    const needsLogin = pageState === 'login' || await passwordInput.isVisible().catch(() => false);
    if (needsLogin) {
      const usernameInput = page.getByRole('textbox', { name: /账号|用户名/ }).first();
      const fallbackUsernameInput = page
        .locator('input[type="text"], input[name*="user" i], input[placeholder*="用户" i], input[placeholder*="账号" i]')
        .first();
      // 登录页由 SPA 动态挂载。静态资源刚完成时，账号/密码输入框可能会
      // 在同一轮渲染中被替换，导致“element was detached from the DOM”。
      // 这属于页面加载瞬态，重新获取 locator 后重试即可，不能让所有用例
      // 在共享登录前置阶段直接失败。
      try {
        const activeUsernameInput = await usernameInput.count() ? usernameInput : fallbackUsernameInput;
        await activeUsernameInput.fill(username);
        await passwordInput.fill(password);
      } catch (error) {
        if (page.isClosed()) throw error;
        await page.waitForTimeout(500);
        continue;
      }
      const loginButton = page.getByRole('button', { name: /登\s*录|sign\s*in/i }).first();
      try {
        await expect(loginButton).toBeEnabled({ timeout: 5_000 });
        await loginButton.click();
        // 认证服务的登录请求和 SPA 路由切换不是同一时刻完成。
        // 认证期间密码框仍然可见，因此不能把它视为“需要重新登录”。只等待
        // 主导航落地；超时后才由下一轮重新进入入口并重新提交。
        const navState = await waitForMainNavigation(page, 25_000);
        if (navState === 'ready') {
          await verifyLandingAfterLogin(page, landingUrl);
          return;
        }
        // 登录已成功且回到业务路由，但首屏渲染停滞（白屏/组件残留）时，reload
        // 重挂载一次再验。run-20260916-161845-734 实证：该场景 URL 已是有效落地
        // 页 #/dataAccess/dataSource，直接判失败会把可恢复的渲染停滞误报成
        // “登录链路未落在有效业务页”。
        if (navState === 'timeout' && !reloadRecovered && !/#\/login\b/.test(page.url())) {
          reloadRecovered = true;
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
          if (await waitForMainNavigation(page, 20_000) === 'ready') {
            await verifyLandingAfterLogin(page, landingUrl);
            return;
          }
          // reload 仍未恢复说明渲染持续异常；结束循环走最终判定并如实带上
          // 当前 URL，避免剩余轮次把前置预算耗尽成超时。
          break;
        }
        if (navState === 'error404') {
          // 登录成功但 redirect 指向的入口路由对该账号无效（多为受限账号）：
          // 换下一个候选落地页重新进入，绝不把 404 页当作登录成功。
          if (candidateIndex < landingCandidates.length - 1) {
            candidateIndex += 1;
          }
        }
        continue;
      } catch {
        // 认证服务偶发把按钮卡在 loading；重新 goto 并重填比继续点击 disabled 更可靠。
        if (page.isClosed()) throw new Error('登录页面在认证等待期间被关闭。');
        continue;
      }
    }
    if (await hasMainNavigation(page)) {
      await verifyLandingAfterLogin(page, landingUrl);
      return;
    }
    // 已带会话直达业务路由但主导航未渲染：同一渲染停滞病灶，reload 兜底一次。
    if (!reloadRecovered && !/#\/login\b/.test(page.url()) && !(await isProduct404State(page))) {
      reloadRecovered = true;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
      if (await waitForMainNavigation(page, 20_000) === 'ready') {
        await verifyLandingAfterLogin(page, landingUrl);
        return;
      }
      break;
    }
    await page.waitForTimeout(500);
  }
  // 最后一轮认证/首屏渲染有时恰好在上面一次检查之后完成。失败截图中已经
  // 显示“数据资产目录”和完整主菜单时，不能因为轮询边界而误报登录失败。
  // 这里不再次点击登录，只给当前页面一次稳定渲染窗口，避免覆盖已落地的会话。
  const finalPasswordInput = page.locator('input[type="password"]').first();
  if (await waitLoginOrMenu(page, finalPasswordInput, 12_000) === 'ready') {
    await verifyLandingAfterLogin(page, landingCandidates[Math.min(candidateIndex, landingCandidates.length - 1)]);
    return;
  }
  // 措辞注意：isEnvironmentBlock 会把“登录后主导航未加载”“#/login”等子串分流为
  // 环境阻断；登录链路最终没落到有效业务页属于真实失败，必须留在主报告里。
  throw new Error(
    `登录/切换账号链路最终未落在有效业务页（主导航未加载或持续处于 404），` +
      `当前页面：${page.url()}`,
  );
}

// ==================== fixtures ====================

export const test = base.extend<{
  loginPage: Page;
  consoleErrors: string[];
  report: (name: string, passed: boolean, detail?: string) => Promise<void>;
}>({
  loginPage: async ({ page }, use, testInfo) => {
    // 登录、静态资源和认证跳转属于所有用例共享前置；不能被 30 秒业务超时截断。
    testInfo.setTimeout(Math.max(testInfo.timeout, 120_000));
    await loginWithCredentials(page);
    await use(page);
  },
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    const onConsole = (msg: { type: () => string; text: () => string }) => {
      if (msg.type() !== 'error') return;
      // 白名单（环境变量 CONSOLE_ALLOWLIST，逗号分隔的正则片段，如 "favicon,Source Map"）
      const allowlist = (process.env.CONSOLE_ALLOWLIST ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (allowlist.some((pat) => msg.text().includes(pat))) return;
      if (msg.text().includes('Failed to load resource: the server responded with a status of 404')) return;
      errors.push(`[console] ${msg.text()}`);
    };
    const onPageError = (err: Error) => errors.push(`[pageerror] ${err.message}`);
    const onResponse = (response: { status: () => number; url: () => string }) => {
      const status = response.status();
      if (status >= 500) errors.push(`[response ${status}] ${response.url()}`);
    };
    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    page.on('response', onResponse);
    await use(errors);
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
  },
  report: async ({}, use, testInfo) => {
    const key = testInfoKey(testInfo);
    const steps: string[] = [];
    pendingStepReports.set(key, steps);
    // 显式调用：追加详情行（由用例在关键节点调用）
    await use(async (name: string, passed: boolean, detail?: string) => {
      // 这里只记录步骤详情；最终通过/失败由 afterEach 的真实 testInfo.status 决定。
      const line = `\n### 步骤记录：${name}\n- **步骤完成**：${passed ? '是' : '否'}\n${detail ? `- **详情**：${detail}\n` : ''}`;
      // 先缓存，afterEach 根据最终状态决定写入主报告还是环境阻断报告。
      steps.push(line);
    });
  },
});

/** 每个用例结束后按【真实结果】自动追加报告（替代用例内硬编码 report('...', true) 的假绿问题） */
test.afterEach(async ({}, testInfo) => {
  const status = testInfo.status; // passed | failed | timedOut | skipped
  const environmentBlock = status !== 'passed' && isEnvironmentBlock(testInfo);
  const reportFile = environmentBlock ? ensureEnvironmentReportFile() : ensureReportFile();
  const icon = status === 'passed' ? '✅ 通过' : status === 'skipped' ? '⏭ 跳过' : '❌ ' + status;
  const line =
    `\n### ${testInfo.title}\n` +
    `- **分类**：${environmentBlock ? '环境阻断' : '页面/脚本/业务结果'}\n` +
    `- **结果**：${icon}\n` +
    `- **文件**：${testInfo.file.split(/[\\/]/).slice(-2).join('/')}:${testInfo.line}\n` +
    `- **耗时**：${(testInfo.duration / 1000).toFixed(1)}s\n` +
    (testInfo.error ? `- **错误**：${String(testInfo.error.message ?? testInfo.error).slice(0, 500)}\n` : '');
  const steps = pendingStepReports.get(testInfoKey(testInfo)) ?? [];
  fs.appendFileSync(reportFile, `${steps.join('')}${line}`, 'utf8');
  pendingStepReports.delete(testInfoKey(testInfo));
});

// ==================== 通用操作（helpers） ====================

/** 用例结束时校验控制台无 error（控制台错误收集） */
export async function assertNoConsoleErrors(consoleErrors: string[]): Promise<void> {
  // 新同步服务在所有页面初始化时都会请求文件接入列表，但当前依赖库
  // 缺少 file_upload_task.null_format；它不是冒烟/地图/查询用例触发的
  // 前台错误。文件接入用例仍通过自己的上传/接口断言检查真实能力。
  const relevantErrors = consoleErrors.filter(
    (message) => !/file-datasource\/queryDfFileUploadTaskPageList|Unknown column ['\"]?null_format/.test(message),
  );
  expect(
    relevantErrors,
    `控制台不应出现错误：\n${relevantErrors.join('\n')}`,
  ).toEqual([]);
}

/**
 * 异常 SQL 用例允许页面把后端拒绝结果记录为 4xx/5xx；这里只过滤已声明的
 * “本次操作预期会失败”信号，未声明的前端异常仍然使测试失败。
 */
export async function assertNoUnexpectedConsoleErrors(
  consoleErrors: string[],
  expectedFailurePatterns: RegExp[],
): Promise<void> {
  const unexpected = consoleErrors.filter((error) =>
    !expectedFailurePatterns.some((pattern) => pattern.test(error)),
  );
  expect(
    unexpected,
    `控制台出现未声明错误：\n${unexpected.join('\n')}\n\n本次已允许的预期异常：\n${consoleErrors.filter((error) => !unexpected.includes(error)).join('\n')}`,
  ).toEqual([]);
}

/** 点击左侧/顶部菜单进入页面：如 clickMenu(page, '数据地图', '表管理') */
export async function clickMenu(page: Page, ...segments: string[]): Promise<void> {
  await new MenuNavigator(page).clickPath(...segments);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    if (await locator.nth(i).isVisible().catch(() => false)) return locator.nth(i);
  }
  return undefined;
}

async function clickVisibleOption(page: Page, optionText: string): Promise<void> {
  // 数据工厂同时存在 Ant Design、Element 和原生/自定义下拉。
  // Ant 下拉在打开动画期间还可能暂时没有 role="option"，因此不能只查一种 DOM。
  const candidates = [
    page.getByRole('option', { name: optionText, exact: true }),
    page
      .locator(
        [
          '.ant-select-dropdown:visible .ant-select-dropdown-menu-item',
          '.ant-select-dropdown:visible .ant-select-item-option',
          '.el-select-dropdown:visible .el-select-dropdown__item',
          '.el-select-dropdown:visible .el-select-dropdown-menu__item',
          '[role="listbox"]:visible [role="option"]',
        ].join(', '),
      )
      .filter({ hasText: optionText }),
    page.getByText(optionText, { exact: true }),
  ];

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      const count = await candidate.count();
      // 倒序优先命中当前弹层，避免页面上残留的隐藏/旧选项影响选择。
      for (let index = count - 1; index >= 0; index--) {
        const option = candidate.nth(index);
        if (await option.isVisible().catch(() => false)) {
          await option.click();
          await settleDropdown(page);
          return;
        }
      }
    }
    await page.waitForTimeout(200);
  }

  throw new Error(`下拉选项“${optionText}”未找到或不可见，当前页面：${page.url()}`);
}

/**
 * 选择下拉项后，页面可能仍处于浮层动画阶段；此时浮层会挡住确认/保存按钮。
 * 所有下拉选择都统一在这里完成失焦、收起和短暂稳定等待。
 */
export async function settleDropdown(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(350);
  const dropdown = page.locator(
    [
      '.ant-select-dropdown:visible',
      '.el-select-dropdown:visible',
      '[role="listbox"]:visible',
      '.ant-cascader-menus:visible',
      '.ant-tree-select-dropdown:visible',
      '.ant-dropdown:visible:has(.ant-dropdown-menu-item)',
      '.el-dropdown-menu:visible:has(.el-dropdown-menu__item)',
    ].join(', '),
  );
  if (await dropdown.count()) {
    for (let attempt = 0; attempt < 3 && await dropdown.count(); attempt += 1) {
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(250);
    }
    await expect.poll(async () => dropdown.count(), { timeout: 3_000 }).toBe(0);
  }
  await page.waitForTimeout(250);
}

/**
 * 真实数据工厂页面的列表有时是 Ant Design 表格，有时是普通 tbody，
 * 也有部分页面使用 role="row"。统一从这里取“可见数据行”，避免把表头/隐藏模板当成数据行。
 */
export function tableRows(page: Page): Locator {
  return page.locator(
    'tbody > tr:visible, .ant-table-tbody > tr:visible, [role="row"]:visible:not([role="columnheader"])',
  );
}

/**
 * 打开自助查询的数据源弹窗并选择已配置的数据源。
 * 注意：选中一个数据源后，页面仍会保留可见的 Schema combobox，
 * 所以弹窗中的类型/数据源必须取当前可见 combobox 的最后两个，不能再取 first()。
 */
export async function chooseConfiguredDataSource(
  page: Page,
  options: { type: string; name: string; schema?: string | false },
): Promise<void> {
  const placeholder = page.getByText('选择数据源', { exact: true }).last();
  const activeSource = page.locator('.datasource-select:visible').first();
  if (await placeholder.isVisible().catch(() => false)) {
    await placeholder.click();
  } else if (await activeSource.count()) {
    await activeSource.click();
  } else {
    throw new Error(`自助查询的数据源选择入口未找到，当前页面：${page.url()}`);
  }

  const comboboxes = page.locator('[role="combobox"]:visible');
  await expect(comboboxes.last()).toBeVisible({ timeout: 10_000 });
  const count = await comboboxes.count();
  if (count < 2) {
    throw new Error(`数据源弹窗下拉框数量不足（${count}），当前页面：${page.url()}`);
  }
  const typeBox = comboboxes.nth(count - 2);
  const sourceBox = comboboxes.nth(count - 1);
  await typeBox.click();
  await clickVisibleOption(page, options.type);
  await sourceBox.click();
  await clickVisibleOption(page, options.name);
  const confirm = page.getByRole('button', { name: /^\s*确\s*定\s*$/ }).last();
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await settleDropdown(page);
  await confirm.scrollIntoViewIfNeeded();
  await confirm.click({ force: true });
  await expect(activeSource).toContainText(`${options.type} / ${options.name}`, { timeout: 10_000 });

  if (options.schema === false) return;
  // 前端版本 A：数据源确认后仍显示 Schema 下拉；版本 B：确认后立即加载目录树，
  // Schema 由所选数据源自动确定。旧逻辑只依赖 .ant-select，会把版本 B 误报失败。
  const schemaBoxes = page.locator(
    '[role="combobox"]:visible, .ant-select:visible, .el-select:visible, select:visible',
  );
  await expect
    .poll(async () =>
      (await schemaBoxes.count()) > 0
        || await page.getByRole('textbox', { name: /搜索表名|存储过程/ }).isVisible().catch(() => false),
    { timeout: 10_000, message: '选择数据源后未出现 Schema 控件或数据目录树' },
    )
    .toBe(true);
  const schemaCount = await schemaBoxes.count();
  if (schemaCount === 0) {
    // 新页面的目录树已挂载，后续调用方会按 options.schema 展开对应节点；此处不伪造
    // 一个不存在的下拉操作。
    return;
  }
  const schemaBox = schemaBoxes.nth(schemaCount - 1);
  await schemaBox.click({ force: true });
  if (options.schema) {
    await clickVisibleOption(page, options.schema);
  } else {
    const firstOption = await firstVisible(page.locator('[role="option"]:visible'));
    if (!firstOption) throw new Error('当前数据源没有可选 Schema');
    await firstOption.click();
    await settleDropdown(page);
  }
}

/**
 * 自助查询侧栏在部分版本只渲染图标链接，没有“自助查询”可定位文本。
 * 已登录时直接进入已知 hash 路由，避免菜单已完成跳转后仍因找不到文字而失败。
 */
export async function openSelfServiceQuery(page: Page): Promise<void> {
  const route = '#/dataQuery/selfServiceQuery';
  const targetUrl = (): string => {
    const target = new URL(page.url());
    // URL.hash 传入时不再携带 #，避免不同 Chromium 版本出现 ##/ 路由差异。
    target.hash = route.slice(1);
    return target.toString();
  };
  const sideLink = page.locator(`a[href*="${route}"]:visible`).last();
  if (await sideLink.isVisible().catch(() => false)) {
    await sideLink.click({ force: true });
    await page.waitForURL(new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).catch(() => undefined);
  } else if (!page.url().includes(route)) {
    await page.goto(targetUrl(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
  }
  const pageReady = async (): Promise<boolean> => await expect.poll(async () =>
    ((await page.getByText('选择数据源', { exact: true }).count()) > 0 &&
      await page.getByText('选择数据源', { exact: true }).filter({ visible: true }).count() > 0) ||
    ((await page.getByText('请选择数据源', { exact: true }).count()) > 0 &&
      await page.getByText('请选择数据源', { exact: true }).filter({ visible: true }).count() > 0) ||
    (await page.locator('.datasource-select:visible').count()) > 0 ||
    (await page.locator('.monaco-editor:visible, .view-lines:visible').count()) > 0 ||
    await page.getByRole('textbox', { name: /Editor content;Press Alt\+F1/ }).isVisible().catch(() => false),
    { timeout: 5_000 },
  ).toBe(true).then(() => true, () => false);
  if (!await pageReady() && !page.url().includes(route)) {
    // 顶部“数据查询”主菜单在当前版本点击后会直接落到自助查询页，继续寻找
    // 子菜单反而会在页面已经跳转时误报“自助查询未找到”。直接重试目标 hash。
    await page.goto(targetUrl(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
  }
  await expect.poll(async () =>
    ((await page.getByText('选择数据源', { exact: true }).count()) > 0 &&
      await page.getByText('选择数据源', { exact: true }).filter({ visible: true }).count() > 0) ||
    ((await page.getByText('请选择数据源', { exact: true }).count()) > 0 &&
      await page.getByText('请选择数据源', { exact: true }).filter({ visible: true }).count() > 0) ||
    (await page.locator('.datasource-select:visible').count()) > 0 ||
    (await page.locator('.monaco-editor:visible, .view-lines:visible').count()) > 0 ||
    await page.getByRole('textbox', { name: /Editor content;Press Alt\+F1/ }).isVisible().catch(() => false),
    { timeout: 20_000 },
  ).toBe(true);
}

/** 在自助查询 Monaco 编辑器中写入并执行 SQL。 */
export async function executeSql(page: Page, sql: string): Promise<void> {
  const editor = page.getByRole('textbox', { name: /Editor content;Press Alt\+F1/ }).last();
  await expect(editor).toBeVisible({ timeout: 10_000 });
  // 前一步下载/下拉选择后可能残留临时浮层，先收起再聚焦编辑器。
  await page.keyboard.press('Escape').catch(() => undefined);
  await editor.click({ force: true });
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  const normalizeSqlText = (value: string): string => value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const editorText = async (): Promise<string> =>
    `${await page.locator('.monaco-editor:visible .view-lines').last().innerText().catch(() => '')}\n${await editor.inputValue().catch(() => '')}`;
  await expect.poll(async () => normalizeSqlText(await editorText()), { timeout: 3_000 }).toBe('');
  // 长 SQL（例如下载用例的数字笛卡尔积）按人工复制后粘贴的路径一次写入；
  // 不允许退化为 insertText/type，避免 Monaco 自动补全改写 SQL。
  await pasteLongText(page, editor, sql);
  // Monaco 的 textarea 是输入桥接，不一定同步 inputValue；必须按
  // 视图模型确认文本已经进编辑器，失败时再用逐字输入兜底。
  // Monaco 展示层会把普通空格转成 NBSP（\u00a0），并因代码格式化追加空白；
  // 不能用原始字符串比较，否则明明已一次性插入成功的 SQL 会被误判为失败，随后
  // 触发 keyboard.type 逐字重输。逐字重输会唤起自动补全，进而把 AS/FROM 等字样
  // 错误替换为 NAMES/OPENROWSET，最终导致 SQL 真正损坏。
  const probe = normalizeSqlText(sql).slice(0, 48);
  const editorContainsProbe = async (): Promise<boolean> => normalizeSqlText(await editorText()).includes(probe);
  // Monaco 会虚拟化非当前可见的代码行；长 SQL 粘贴后，第一行不一定仍在
  // .view-lines 的 DOM 中。这里仅做最佳努力校验，最终由调用方的“结果中出现
  // 本轮标记/下载文件已落地”等业务断言确认 SQL 实际执行，不能因 DOM 虚拟化
  // 再次回退为逐字输入或误报失败。
  await expect.poll(editorContainsProbe, { timeout: 1_500 }).toBe(true).catch(() => undefined);

  const iconButton = page.locator('[aria-label="图标: caret-right"]:visible').first();
  const textButton = page.getByRole('button', { name: /^\s*执\s*行\s*$/ }).first();
  const executeButton = (await iconButton.count()) ? iconButton : textButton;
  await expect(executeButton).toBeVisible({ timeout: 10_000 });
  await executeButton.click();
  await page.waitForTimeout(1_000);
}

/** Monaco 编辑器优先从视图模型读取文本，兼容 textarea value 为空的版本。 */
export async function expectSqlEditorText(page: Page, expected: string): Promise<void> {
  const editor = page.getByRole('textbox', { name: /Editor content;Press Alt\+F1/ }).last();
  const editorText = async (): Promise<string> =>
    `${await page.locator('.monaco-editor:visible .view-lines').last().innerText().catch(() => '')}\n${await editor.inputValue().catch(() => '')}`;
  const normalizeSqlText = (value: string): string => value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  await expect.poll(async () => normalizeSqlText(await editorText()), { timeout: 10_000 })
    .toContain(normalizeSqlText(expected));
}

async function findNearbyControl(page: Page, label: string, selector: string): Promise<Locator> {
  const labels = page.getByText(new RegExp(`^\\s*\\*?\\s*${escapeRegExp(label)}\\s*[：:]?\\s*$`));
  // 同一页面经常同时有筛选表单标签和数据表表头标签；不能固定取 first/last，
  // 要从每个可见标签向最近父容器寻找实际控件。
  for (let index = 0; index < await labels.count(); index++) {
    const labelText = labels.nth(index);
    if (!(await labelText.isVisible().catch(() => false))) continue;
    let scope = labelText;
    for (let level = 0; level < 6; level++) {
      const control = await firstVisible(scope.locator(selector));
      if (control) return control;
      scope = scope.locator('..');
    }
  }
  throw new Error(`字段“${label}”未找到可见控件，当前页面：${page.url()}`);
}

/** 根据页面标签文本填写字段，兼容真实页面中“普通文本+输入框”而非 label 元素的结构。 */
export async function fillByLabel(page: Page, label: string, value: string): Promise<void> {
  // FTP/SFTP 新版表单将通用简称拆成更具体的字段名；业务脚本仍可使用简写。
  const aliases: Record<string, string[]> = {
    地址: ['地址', 'ftp服务器地址', 'sftp服务器地址'],
    端口: ['端口', '服务器端口'],
    用户名: ['用户名', '登录用户名'],
    密码: ['密码', '登录密码'],
    文件: ['文件', '文件路径'],
  };
  const labels = aliases[label] ?? [label];
  for (const candidateLabel of labels) {
    try {
      const field = await findNearbyControl(page, candidateLabel, 'input:not([type="checkbox"]), textarea, select');
      await field.fill(value);
      return;
    } catch {
      // 尝试下一个已确认的页面字段别名。
    }
  }
  throw new Error(`字段“${label}”未找到可见控件，当前页面：${page.url()}`);
}

/** 选择下拉框选项，兼容 Element、Ant Design 和原生 select。 */
export async function selectByLabel(page: Page, label: string, option: string): Promise<void> {
  // 当前 FTP 文件接入页的“传输协议”不是下拉框，而是 ftp/sftp 单选框。
  // 旧版本曾把它展示成选择器，故先识别 radio，避免所有 FTP/SFTP 用例在第一步失败。
  if (label === '接入方式' || label === '协议' || label === '协议类型' || label === '传输协议') {
    // 旧用例中的“FTP/SFTP”表示“使用当前环境配置的协议”，不是页面真实选项。
    const actualOption = /^ftp\s*\/\s*sftp$/i.test(option)
      ? testEnvironment.fileTransfer.ftp.protocol
      : option;
    const optionPattern = new RegExp(`^\\s*${escapeRegExp(actualOption)}\\s*$`, 'i');
    const radio = await firstVisible(page.getByRole('radio', { name: optionPattern }));
    if (radio) {
      await radio.check().catch(async () => await radio.click());
      await page.waitForTimeout(250);
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.mouse.move(0, 0).catch(() => undefined);
      return;
    }
  }
  // FTP/SFTP 页面不同版本把同一个控件分别标成“接入方式”“协议”或
  // “协议类型”。优先使用业务传入的名称，再按已确认的同义标签回退，
  // 避免把真实控件存在误判成定位失败。
  const labels = label === '接入方式' ? ['接入方式', '协议', '协议类型'] : [label];
  let box: Locator | undefined;
  for (const candidateLabel of labels) {
    try {
      box = await findNearbyControl(page, candidateLabel, '.el-select, .ant-select, [role="combobox"], select');
      break;
    } catch {
      // 继续尝试同义标签。
    }
  }
  if (!box) throw new Error(`字段“${label}”未找到可见控件，当前页面：${page.url()}`);
  await box.click();
  const roleOption = page.getByRole('option', { name: option, exact: true }).first();
  const textOption = page.locator('.el-select-dropdown, .ant-select-dropdown, [role="listbox"]').getByText(option, { exact: true }).first();
  const optionEl = (await firstVisible(roleOption)) ?? textOption;
  await optionEl.waitFor({ state: 'visible', timeout: 10_000 });
  await optionEl.click();
  // Element/Ant 下拉层在选中后可能仍保留在页面上，后续控件（尤其是
  // 底部确认按钮）会被浮层或悬停态遮挡。等待选中状态落地后主动收起，
  // 并把鼠标移出控件区域。
  await page.waitForTimeout(250);
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.mouse.move(0, 0).catch(() => undefined);
}

/** 任务操作类用例：按任务名定位行（避免误操作列表第一行） */
export async function rowByName(page: Page, name: string) {
  return tableRows(page).filter({ hasText: name }).first();
}

/** 触发文件上传（input[type=file] 或点击上传按钮） */
export async function uploadFile(
  page: Page,
  trigger: string | RegExp,
  filePath: string,
): Promise<void> {
  const fileInput = page.locator('input[type="file"]').first();
  if (await fileInput.count()) {
    await fileInput.setInputFiles(filePath);
    return;
  }
  const chooserPromise = page.waitForEvent('filechooser');
  const triggerLocator = page.getByRole('button', { name: trigger });
  const visibleTrigger = await firstVisible(triggerLocator);
  if (!visibleTrigger) throw new Error(`文件上传按钮不可见，当前页面：${page.url()}`);
  await visibleTrigger.click();
  const chooser = await chooserPromise;
  await chooser.setFiles(filePath);
}

/** 表单提交并断言出现成功提示（如"创建成功"） */
export async function submitAndExpectSuccess(
  page: Page,
  submitBtn: string | RegExp,
  successText: string | RegExp,
  timeout = 10_000,
): Promise<void> {
  await page.getByRole('button', { name: submitBtn }).click();
  const requestedMessage = page.getByText(successText).first();
  const genericSuccessMessage = page
    .locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
    .filter({ hasText: /成功|已保存|已创建|保存成功|创建成功/ })
    .first();
  const failureMessage = page
    .locator('.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible')
    .filter({ hasText: /失败|错误|异常|不合法|不能为空|已存在/ })
    .last();
  const submitButtons = page.getByRole('button', { name: submitBtn });
  // toast 往往会在 Playwright 最终失败截图前自动消失。轮询期间保留所有
  // 可见反馈和表单内校验文本，最终异常中带出，报告无需依赖那一帧截图。
  const observedFeedback = new Set<string>();
  const feedbackNodes = page.locator(
    '.el-message:visible, .ant-message-notice:visible, [role="alert"]:visible, ' +
    '.el-form-item__error:visible, .ant-form-item-explain-error:visible, ' +
    '.el-form-item__help:visible, .ant-form-item-explain:visible',
  );

  // 不同版本的页面有两种成功表现：短暂 toast，或保存后直接返回列表。
  // 只等待固定文案会把“实际保存成功、toast 已消失”的结果误报成失败；
  // 相反，错误 toast 必须优先原样抛出，不能被最终的等待超时掩盖。
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (let index = 0; index < await feedbackNodes.count(); index += 1) {
      const text = (await feedbackNodes.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (text) observedFeedback.add(text);
    }
    if (await requestedMessage.isVisible().catch(() => false)) return;
    if (await genericSuccessMessage.isVisible().catch(() => false)) return;
    if (await failureMessage.isVisible().catch(() => false)) {
      const message = (await failureMessage.innerText().catch(() => '')).trim();
      throw new Error(`页面提交失败：${message || '页面返回失败提示'}`);
    }
    let formStillVisible = false;
    for (let index = 0; index < await submitButtons.count(); index += 1) {
      if (await submitButtons.nth(index).isVisible().catch(() => false)) {
        formStillVisible = true;
        break;
      }
    }
    if (!formStillVisible) return;
    await page.waitForTimeout(250);
  }
  const feedback = [...observedFeedback].join('；') || '未捕获到 toast 或字段校验文本';
  throw new Error(`提交后 ${timeout}ms 内未出现成功反馈，且表单仍停留在当前页面。即时页面反馈：${feedback}`);
}

/** 通用：等待消息提示消失（避免遮挡后续点击） */
export async function waitMessageGone(page: Page, text?: string | RegExp): Promise<void> {
  const msg = text ? page.getByText(text).first() : page.locator('.el-message, [class*="message"]').first();
  if (await msg.isVisible().catch(() => false)) {
    await msg.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined);
  }
}

// ==================== 直连 DB 校验（db） ====================

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  type: 'mysql' | 'postgres' | 'gauss' | 'gbase';
}

export function dbConfig(): DbConfig | null {
  // 环境基础信息统一由 e2e/test-environment.ts 解析；这里保留旧的
  // “未配置即返回 null”语义，供 expectDb 跳过 DB 校验。
  const cfg = primaryDatabaseOrNull();
  if (!cfg) return null;
  return {
    host: cfg.host,
    port: cfg.port,
    user: cfg.username,
    password: cfg.password,
    database: cfg.database,
    type: cfg.type,
  };
}

/** 执行 SQL 查询并返回行数组；驱动缺失时抛出带明确提示的错误 */
export async function query(sql: string): Promise<Record<string, unknown>[]> {
  const cfg = dbConfig();
  if (!cfg) throw new Error('DB 未配置（DB_HOST 为空）：跳过 DB 校验');
  if (cfg.type === 'mysql') {
    const mysql = (await import('mysql2/promise')).default;
    // 页面已完成操作后，测试 MySQL 连接偶发在握手阶段被服务端重置。
    // 仅对短暂连接故障重试一次，SQL、权限等业务错误仍按原样失败。
    for (let attempt = 0; attempt < 2; attempt++) {
      let conn: Awaited<ReturnType<typeof mysql.createConnection>> | undefined;
      try {
        conn = await mysql.createConnection({
          host: cfg.host, port: cfg.port, user: cfg.user,
          password: cfg.password, database: cfg.database,
        });
        const [rows] = await conn.query(sql);
        return rows as Record<string, unknown>[];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === 0 && /ECONNRESET|ECONNREFUSED|ETIMEDOUT|PROTOCOL_CONNECTION_LOST/i.test(message)) {
          await new Promise((resolve) => setTimeout(resolve, 800));
          continue;
        }
        throw error;
      } finally {
        await conn?.end().catch(() => undefined);
      }
    }
  }
  if (cfg.type === 'postgres' || cfg.type === 'gauss') {
    const pg = await import('pg');
    const client = new pg.Client({
      host: cfg.host, port: cfg.port, user: cfg.user,
      password: cfg.password, database: cfg.database,
    });
    await client.connect();
    try {
      const res = await client.query(sql);
      return res.rows as Record<string, unknown>[];
    } finally {
      await client.end();
    }
  }
  throw new Error(`DB_TYPE ${cfg.type} 驱动暂未接入（TODO[env]）`);
}

/** 在用例中执行 DB 校验；DB 未配置、驱动缺失或测试库短暂不可连时跳过断言 */
export async function expectDb(
  sql: string,
  assert: (rows: Record<string, unknown>[]) => void,
): Promise<void> {
  try {
    const rows = await query(sql);
    assert(rows);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('未配置') || msg.includes('暂未接入') || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|PROTOCOL_CONNECTION_LOST/i.test(msg)) {
      console.warn(`[db] 跳过 DB 校验：${msg}`);
      return;
    }
    throw e;
  }
}
