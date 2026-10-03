---
name: code-review
description: 代码审查（code review / PR review）。审查代码变更、找 bug、检查逻辑正确性、接口契约、安全隐患时使用。四阶段流程（上下文 → 高层 → 逐行 → 结论），严重性分级输出。附 React 19 / TypeScript / 安全 / 横切模式详细指南，按需加载。反馈使用中文。
---

# 代码审查

> 本 skill 裁剪自 [awesome-skills/code-review-skill](https://github.com/awesome-skills/code-review-skill)（MIT，见 LICENSE），仅保留与本仓库技术栈相关的分册：TypeScript、React 19、安全、性能、横切模式、通用缺陷清单。其余 20+ 语言分册已剔除，如需可从上游补回。

## 何时使用

- 提交 / PR 前对变更做结构化自审
- 排查"这段代码有没有隐藏 bug"
- 审查接口契约、类型安全、错误处理
- 安全审查（XSS、注入、越权）

## 审查流程（四阶段）

### 阶段 1：上下文收集

1. 读 PR / 任务描述与关联 issue
2. 看 diff 规模（>400 行建议拆分审查）
3. 确认 `pnpm test / lint / typecheck` 已通过（未通过先修）
4. 理解业务需求与相关架构决策

### 阶段 2：高层审查

1. **设计**：方案是否匹配问题？耦合/内聚、反模式
2. **性能**：算法复杂度、N+1、内存（详见 [性能指南](reference/performance-review-guide.md)）
3. **文件组织**：新文件位置是否合理
4. **测试策略**：边界情况是否有覆盖

### 阶段 3：逐行审查

每个文件检查：

- **逻辑正确性**：边界、差一错误、null/undefined、竞态
- **安全**：输入校验、注入、XSS、敏感数据
- **性能**：N+1、多余循环、内存泄漏
- **可维护性**：命名、单一职责、注释
- **复用**：新代码前先找现有工具函数（反模式详见[通用质量指南](reference/code-quality-universal.md)）

### 阶段 4：结论

1. 汇总关键问题 2. 指出亮点 3. 明确结论：✅ 通过 / 💬 建议 / 🔄 需修改

## 严重性分级

- 🔴 `[blocking]` 合并前必须修
- 🟡 `[important]` 应当修，有异议可讨论
- 🟢 `[nit]` 可选，不阻塞
- 💡 `[建议]` 备选方案 / 📚 `[学习]` 教育性说明 / 🎉 `[praise]` 值得肯定

## 本仓库专项 blocking 检查（🔴，通用流程查不出来，必须单独过）

1. **答案泄露**：学生端接口 / 组件是否可能返回未交卷题目的答案、详解、提示（新学生端接口必有 assertNoLeak 测试）
2. **契约同步**：数据结构改动是否先改 `packages/contract` 的 Zod schema，前后端是否都在用契约类型而非手写
3. **判分位置**：判分逻辑是否只在服务端（packages/grading），客户端无判分代码
4. **迁移**：表结构变更是否走 `pnpm db:generate` 生成迁移，有无手改迁移文件
5. **DSL 兼容**：指令注册表改动是否只增不改、新属性是否可选有默认值、`pnpm gen:spec` 后 git diff 是否干净
6. **samples 回归**：解析器相关改动后 `samples/` 全部样例仍解析渲染一致
7. **禁项**：无 any / @ts-ignore、无 CDN 资源、无技术栈清单外依赖

## 语言 / 专项指南（按需加载，不要一次全读）

| 主题 | 文件 | 要点 |
|------|------|------|
| **TypeScript** | [TS 指南](reference/typescript.md) | 类型安全、async/await、不可变性、TS 5.x |
| **React 19** | [React 指南](reference/react.md) | Hooks、useEffect、React 19 Actions、TanStack Query v5 |
| **通用缺陷** | [缺陷清单](reference/common-bugs-checklist.md) | 各语言高频 bug 模式 |
| **通用质量** | [质量指南](reference/code-quality-universal.md) | 参数膨胀、抽象泄漏、嵌套条件、stringly-typed、TOCTOU |
| **安全** | [安全指南](reference/security-review-guide.md) | SQLi、XSS、CSRF、SSRF、IDOR、命令注入 |
| **性能** | [性能指南](reference/performance-review-guide.md) | Web Vitals、N+1、复杂度、内存泄漏、缓存 |
| **错误处理** | [错误处理](reference/cross-cutting/error-handling-principles.md) | fail fast、错误层级、反模式 |
| **并发** | [并发模式](reference/cross-cutting/async-concurrency-patterns.md) | async/await 陷阱、结构化并发 |
| **SQL 注入** | [注入防护](reference/cross-cutting/sql-injection-prevention.md) | 参数化查询、ORM 安全（Drizzle 适用） |
| **XSS** | [XSS 防护](reference/cross-cutting/xss-prevention.md) | 输出编码、CSP（Markdown 渲染面适用） |
| **N+1** | [N+1 查询](reference/cross-cutting/n-plus-one-queries.md) | 批量取数、DataLoader |
| **沟通最佳实践** | [最佳实践](reference/code-review-best-practices.md) | 反馈语气、评审心态 |
| **PR 模板** | [PR 模板](assets/pr-review-template.md) / [快速清单](assets/review-checklist.md) | 输出格式 |

## 交给快速模型做初审

- 单批小范围粗审：用 [prompts/flash-first-pass.md](prompts/flash-first-pass.md)（自包含，直接粘贴代码即可）。
- 大范围并行审查：用 [prompts/orchestrator.md](prompts/orchestrator.md)——编排者（Flash Max）只负责拆单、派单、验收（证据逐字比对防幻觉）、汇总去重，不亲自审查；审查由多个 Flash Max 子 Agent 并发执行，并发数受 MAX_CONCURRENT 约束。在 ZCode 中即由主会话按该提示词用 Agent 工具并行 spawn flash 子代理。

粗审结果由主模型复核后再定性。
