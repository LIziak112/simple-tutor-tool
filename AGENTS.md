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
12. 所有 samples/ 下的历史样例文档是兼容性回归测试，任何改动后都必须仍能解析、渲染一致。（2026-10-05 决策 10 例外：samples/v1 随 v1 兼容层移除而删除，规则对现存样例继续成立，见 docs/技术架构与实施方案.md §10。）

## 标准任务流水线（所有开发任务与 bugfix 通用）
出计划 → TDD 实现 → 质量闸门 → 验证 → 合并；顺序不可颠倒，任何一环缺失视为任务未完成。Txx 任务按 task-workflow 技能执行（它是本流水线的实例化）：

1. **出计划**：多步任务先写实施计划（文件清单、实现步骤、测试点），等用户确认再动手；复杂计划可配合 `/writing-plans` 技能成稿。
2. **TDD 实现**：先写失败测试，再写实现（解析器/判分为硬性规则 9，其余任务默认同样执行，纯样式/文案改动可豁免但须说明）。改 bug 先按 `/systematic-debugging` 定位根因，禁止只修症状的创可贴式补丁。
3. **质量闸门**：合并前在本分支内对完整 diff 依次跑 `/simplify`（复用/简化/抽象层级清理）与 `/code-review`（正确性审查），确认的发现当场修复，不修的逐条给理由；触及学生端载荷或答案数据的改动加跑 `/security-review`（与 assertNoLeak 单测互补）。编排者派单模式下由编排者在验收时统一执行。
4. **验证**：按「完成一个任务的定义」跑真实命令并贴输出（`/verification-before-completion` 纪律），禁止空口宣称通过。
5. **合并**：分支全绿后先合并 `v2`，再发 `main`。

## 常用命令
pnpm dev / pnpm test / pnpm e2e（真实Playwright：Chromium/WebKit，隔离临时数据库与8899/5199端口；可追加spec路径或--workers=2，不复用用户5173作业）/ pnpm lint / pnpm typecheck / pnpm format / pnpm build / pnpm db:generate / pnpm schema:export（导出内容契约 JSON Schema，改 contract 后须重跑并提交）/ pnpm tutor-lint <文件或目录>（lint DSL 文档，有 error 退出码 1）/ pnpm reparse [--dry-run]（解析器升级后从 questions.sourceMd / lectures.markdown 重抽取结构化字段，题目 id 不变；--dry-run 只输出不写库；库定位复用 DATA_DIR）/ pnpm gen:spec（从注册表生成 docs/dsl/规范.md、提示词模板.md 并刷新 JSON Schema，同时把规范三件套 + content.json 同步进仓库根 dsl-kit/ 分发包、并用 esbuild 把 tutor-lint 打包成 dsl-kit/tutor-lint.mjs 单文件零依赖校验脚本——规范与对外校验/材料整理技能的固定入口即 dsl-kit/；esbuild 系技术栈内既有依赖的扩展使用，server 构建同款；改注册表/lint 规则/契约/linter 或 CLI 后必须重跑并提交，CI 会校验 gen:spec 后 git diff 为空）

## 完成一个任务的定义
代码 + 测试 + 类型检查通过 + 相关文档（docs/dsl 或本文件）已同步更新 + 在 PR 描述中列出如何手动验证。

## 结果回看 UI 约定
- 每题收起状态使用单行操作栏：查看详解、本次原稿、订正、本题历史、更多；窄屏横向滚动，展开材料使用题卡完整内容宽度。
- 原稿与订正控制器持续挂载；切换操作分组或从待公布变为公布时，不丢编辑状态。
- 本题历史必须保留来源结果页、回看范围与当前题目，并在加载、错误、空记录状态提供返回入口；只接受学生作答结果路径（`/s/attempts/:id`、`/s/assignments/:id`），直接访问时回退我的记录。

## 学生作业列表 UI 约定
- 首页只显示最新两份待完成作业，并显示待办总数；已交卷和已批改作业在独立「我的作业」页面查看。
- 完整作业列表默认展示全部时间的待完成作业，每页 10 份；状态、布置日期、标题搜索和页码保存在 URL。日期按北京时间自然日计算。
- 从列表进入作业或结果后，返回时保留筛选和分页；只接受 `/s/assignments` 列表来源，未知字段与外站地址必须过滤。

## 讲练页约定（kind: lesson，2026-10）
- 防泄露根基：讲练讲义的 markdown 原文（题块含 `- [x]`/`[[答案]]`/`:::solution`/`:::hint`）对学生端**恒不下发**——学生只拿服务端 `splitLessonBlocks` 切段（md 段 + 题目槽）+ 冻结题公开投影；lesson 语境嵌套题块是 error（`QUESTION_NESTED_IN_LESSON`），不得降级。
- 位置即 markdown：题目在讲义中的位置不建锚点表——题块原位保留、开围栏注入最终题目 id（注入也写进该题 sourceMd，往返稳定）；改题块内容必须走重导/reparse，不得在讲义编辑里改后放任双源漂移（编辑抽屉对题块只渲染只读占位卡）。
- 开卷幂等：`lesson/start` 是 create-or-return，**绝不因已完成而开新卷**（刷新已完成页不消耗 attemptNo）；「再做一次」只能走显式 `restart`。
- 单题提交语义：当题释放对错/参考答案/详解（恒题级粒度，attempt 级 answerRelease 不适用）；已提交行**行级锁定**（禁改答案与笔迹）；最后一题提交在事务内自动收尾；整卷收尾对已提交行不重判。
- 学生端进入讲练页的题卡三态（作答/已提交/待批）与进度、孤儿题页尾分组、记录「讲练」徽章口径见 docs/页面功能清单.md §3.9。
