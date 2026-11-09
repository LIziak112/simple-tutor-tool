# 贡献指南

欢迎任何形式的贡献——小到改一个错别字、把一句不顺的文案捋顺，大到新功能，都非常欢迎。

先说明一下：这是一个人在业余时间维护的项目，回复可能不算快，但每一个 issue 和 PR 我都会认真看完。如果没及时回复，多半是在忙别的，绝不是不重视。

## 先跑起来

环境要求：Node.js ≥ 24、pnpm 12.6.0（没有 pnpm 的话 `corepack enable` 即可，版本由 package.json 的 `packageManager` 字段锁定）。

```bash
pnpm install          # 安装依赖
pnpm seed:demo        # 可选：灌入演示数据（教师/学生/课程/作答），开箱就能体验全流程
pnpm dev              # 并行启动 server(8787）与 web(5173,/api 自动转发）
```

浏览器打开 `http://localhost:5173`，首次进入教师端设置向导（设置登录名 + 密码，首位教师即管理员）。不灌演示数据也可以，导入 `samples/` 里的样例文档同样能跑通全流程。

## 开发与提交前验证

```bash
# 开发 / 修复检查点
pnpm test:quick
pnpm typecheck:affected
pnpm lint:changed
# 实现收口（已有有效结果不重复）
pnpm test:affected
pnpm e2e:affected
```

`pnpm install` 会顺带启用仓库的 pre-commit 钩子（文件规模闸门：代码文件 1000 行硬线、历史超限文件只降不升，细则见 [文件规模约束](docs/约定/文件规模约束.md)）；没生效就跑 `pnpm hooks:install`。

按阶段选择适用命令，不每轮全部重跑；命中兜底时遵循选测脚本自动升级。PR CI 按实际基点选单测与双浏览器 E2E，基础设施变更兜底全量；说明文档不启动应用 job，本机不手动重复 CI。纯文档检查链接、命令口径和 `git diff --check`，无需应用全量测试。基线、例外、结果复用和失败处理见 [工程验证说明](docs/约定/工程验证说明.md)。

**涉及解析器（packages/md-dsl）或判分逻辑（packages/grading）的改动，必须先补失败测试、再改实现**。代理执行和交接参见 [代理协作与执行](docs/约定/代理协作与执行.md)。

## 几条最重要的红线

完整开发约定见 [AGENTS.md](AGENTS.md)，对人和 AI 一视同仁。下面这几条是最不能破的：

1. **契约优先**：改数据结构先改 `packages/contract` 的 Zod schema，再改实现；禁止前后端各自手写同一个类型。改完契约记得跑 `pnpm schema:export` 并提交导出的 JSON Schema。
2. **防泄题**：学生端 API 永不返回未交卷题目的答案、详解、提示内容；新增学生端接口必须加泄露测试（assertNoLeak）。
3. **判分只在服务端**（`packages/grading`），客户端结果不可信。
4. **DSL 兼容**：已发布指令只增不改；新增指令走"注册表 → 组件 → 样例测试 → `pnpm gen:spec`"四步，不得绕过注册表。`samples/` 下的历史样例是兼容性回归测试，任何改动后必须仍能解析、渲染一致。
5. **数据库结构变更必须通过 drizzle-kit 生成迁移**（`pnpm db:generate`），禁止手改线上库。
6. **UI 文案中文、标识符英文**；不新增技术栈清单以外的依赖（确需新增，请在 PR 描述写明理由与替代方案）；不用 CDN，前端资源随构建打包。
7. **一个文件一个职责**：代码文件超过 400 行先想拆分方案，1000 行是硬线；拆分按「一起变化的放一起」，不按行数凑；历史超限文件只降不升。

## 分支与提交

仓库惯例：每个任务在独立分支完成，小步提交，每个提交保持可构建、测试通过。commit message 简洁说明做了什么即可，风格参考 `git log`。

## 报告问题与想法

- **Bug 与功能建议**：用 issue 模板（`.github/ISSUE_TEMPLATE/`），信息越具体越好。
- **使用疑问、部署问题、想法讨论**：优先去 [Discussions](https://github.com/LIziak112/simple-tutor-tool/discussions)。若 Discussions 尚未开放，直接提 issue 也完全没问题——别让门槛挡住你想说的话。

最后，谢谢你的时间。哪怕只是提了一个问题、把项目转发给一位同行老师，都是对它的帮助。
