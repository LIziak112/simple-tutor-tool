# AGENTS.md

## 项目
simple-tutor-tool v2：一对一辅导老师的自部署、AI 原生讲练工具。架构权威文档：docs/技术架构与实施方案.md。

## 硬性规则
1. 契约优先：任何数据结构改动先改 packages/contract 的 Zod schema，再改实现；禁止在前后端各自手写同一个类型。
2. TypeScript strict，禁止 any、禁止 @ts-ignore（确有必要用 @ts-expect-error 并写原因）。
3. 学生端 API 永远不返回未交卷题目的答案、详解、提示内容；新增学生端接口必须加泄露测试。
4. 判分只在服务端执行（packages/grading），客户端结果不可信。
5. 不新增技术栈清单以外的依赖；确需新增时在 PR 描述写明理由与替代方案。
6. 不使用 CDN，所有前端资源随构建打包。
7. UI 文案与代码注释使用中文；标识符使用英文。
8. 每个阶段在独立分支完成；小步提交；每个提交保持可构建、测试通过。
9. 修改解析器或判分逻辑必须先补测试用例，再改实现。
10. 数据库结构变更必须通过 drizzle-kit 生成迁移文件，禁止手改线上库。
11. DSL 兼容：已发布指令只增不改；新属性必须可选且有默认值；改名用 aliases；未知指令必须优雅降级。新增指令走"注册表 → 组件 → 样例测试 → pnpm gen:spec"四步，不得绕过注册表。
12. 所有 samples/ 下的历史样例文档是兼容性回归测试，任何改动后都必须仍能解析、渲染一致。

## 常用命令
pnpm dev / pnpm test / pnpm e2e（当前为占位脚本，T2.13 起提供）/ pnpm lint / pnpm typecheck / pnpm format / pnpm build / pnpm db:generate / pnpm schema:export（导出内容契约 JSON Schema，改 contract 后须重跑并提交）/ pnpm tutor-lint <文件或目录>（lint DSL 文档，有 error 退出码 1）/ pnpm reparse [--dry-run]（解析器升级后从 questions.sourceMd / lectures.markdown 重抽取结构化字段，题目 id 不变；--dry-run 只输出不写库；库定位复用 DATA_DIR）/ pnpm gen:spec（从注册表生成 docs/dsl/规范.md、提示词模板.md 并刷新 JSON Schema，同时把规范三件套 + content.json 同步拷贝进仓库根 dsl-kit/ 分发包——规范与对外校验/材料整理技能的固定入口即 dsl-kit/；改注册表/lint 规则/契约后必须重跑并提交，CI 会校验 gen:spec 后 git diff 为空）

## 完成一个任务的定义
代码 + 测试 + 类型检查通过 + 相关文档（docs/dsl 或本文件）已同步更新 + 在 PR 描述中列出如何手动验证。
