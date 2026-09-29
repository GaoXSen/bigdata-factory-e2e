# Factory E2E 工作说明

## 项目定位

这是湖南中行数据平台的 Playwright 端到端测试工程。项目根目录是本目录；被测前端、数据库和 FTP/SFTP 均由环境变量提供。测试以浏览器页面操作为主，不把接口直调当作业务验收。

## 先看这些入口

1. `README.md`：项目背景、环境变量和通用规则。
2. `package.json`：可用的运行命令。
3. `playwright.config.ts`：项目、报告和结果目录配置。
4. `e2e/工厂/湖南中行/`：当前有效的湖南中行测试代码。
5. `e2e/工厂/湖南中行/环境变量.example`：非敏感配置样例。
6. `未确认事项.md`、`人工协助清单-*.md`：仅在遇到前置条件不足时查阅。

## 目录约定

| 目录 | 用途 |
| --- | --- |
| `e2e/工厂/湖南中行/` | 当前维护的测试、工具与测试资源。 |
| `e2e/归档/` | 历史用例，仅用于追溯，不能作为默认修改目标。 |
| `scripts/` | 运行、报告、数据库和本地 FTP/SFTP 辅助脚本。 |
| `用例库/` | 当前及历史 Excel 用例库；保留，不能批量删除。 |
| `腾讯文档同步/` | 已同步的 Excel、问题清单与说明；按任务需要读取。 |
| `本地FTP-SFTP测试数据/` | 本地传输测试 fixture，必须保留。 |
| `outputs/` | 人工维护的 Excel 输出；`.inspect.ndjson` 是可再生成的检查产物。 |

## 运行

在本目录执行：

```powershell
npm test
npm run test:list
npx playwright test "e2e/工厂/湖南中行/数据地图/<具体用例>.spec.ts" --project=chromium --workers=1
npx tsc -p tsconfig.json --noEmit
```

常用辅助命令：`npm run test:并行回归`、`npm run test:自有数据闭环`、`npm run ftp:本地启动`、`npm run ftp:本地检查`、`npm run report:湖南中行:serve`。

## 环境与报告

- 必需环境通常包括 `BASE_URL`、`TEST_USER`、`TEST_PASS`；数据库、FTP/SFTP 与来源表变量按用例补充。
- HTML 报告在 `playwright-report/`，原始失败附件在 `test-results/`，简要运行记录在 `temp/`。
- 缺少账号、权限、远端目录、系统参数等前置时，写清原因并 `skip`；不要伪造通过，也不要误报为产品缺陷。

## 修改测试时的规则

- 先读取目标用例、共享工具、最近失败摘要和相关页面/后端上下文，再修改。
- 使用 UUID 隔离本轮新建的数据；不要删除既有业务数据或不明来源的 fixture。
- 保留真实断言。使用 `testInfo.status`/实际页面结果报告状态，不写死通过结果。
- 页面结构变更时优先修复稳定定位、路由等待和必要前置；不要顺手改测试覆盖或业务语义。
- SQL、Excel、同步文档和本地 FTP/SFTP fixture 只有在任务明确要求时才修改。
- 问题清单按文件名时间和 `LastWriteTime` 选最新版本；同步腾讯文档前须有明确授权。

## 降低上下文成本

除非任务明确需要，不要扫描：`node_modules/`、`playwright-report/`、`test-results/`、`temp/`、`.npm-cache/`、`.artifact-work/`、`e2e/归档/`。

分析失败时优先读取该用例的失败摘要、`error-context.md` 和具体脚本；不要默认读取完整历史视频、trace、网络日志或整份历史报告。优先做增量检索，不要每轮扫描整个项目。
