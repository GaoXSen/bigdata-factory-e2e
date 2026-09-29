# bigdata-factory-e2e

湖南中行数据工厂的 Playwright E2E 用例仓库。当前收录 `e2e/工厂/湖南中行/` 的正式用例、其直接依赖的辅助代码和测试夹具，以及 `e2e-testing/` Skill。仓库不代表所有用例已通过；结果以每次实际运行的 Playwright 报告为准。

## 本地运行

1. 安装 Node.js，执行 `npm ci` 和 `npx playwright install chromium`。
2. 参照 [环境变量样例](.env.example) 在本机注入测试账号、数据库和 FTP/SFTP 凭据；不要提交真实值。环境默认项和覆盖方式见 [环境配置中心](e2e/test-environment.ts)。
3. 先运行 `npm run test:list -- e2e/工厂/湖南中行` 检查收集结果，再按需运行 `npx playwright test e2e/工厂/湖南中行 --project=chromium --workers=1 --headed`。共享数据源及权限状态必须串行执行。

执行环境、账号和数据初始化条件见 [环境检查清单](环境检查清单.md) 与 [部署与执行清单](部署与执行清单.md)。报告写入 `playwright-report/` 和 `test-results/`，均不上传。

## 推送边界

根目录 `.gitignore` 采用白名单：只允许正式用例、必要夹具、配置、Skill 和 Markdown 文档进入候选范围。首次克隆后执行 `git config core.hooksPath .githooks`，启用推送前的路径、文件大小和常见密钥格式检查。`scripts/` 下的本机启动脚本、真实凭据、Excel 需求表、历史/草稿用例、临时任务文档、截图和运行报告都留在本机。新增文件即使是源码，也先审查必要性和敏感信息，再调整白名单；提交前检查 `git diff --cached --name-only`。不要使用 `git add -f` 绕过限制。
