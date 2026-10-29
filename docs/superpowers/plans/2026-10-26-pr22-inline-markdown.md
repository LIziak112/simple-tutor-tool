# PR #22 错题本单行渲染集成

用户已授权：参考 PR #22 实现，定位错误、修复并合入当前 v2。

## 范围与步骤

1. 保留 PR #22 的 InlineMarkdown 单行宿主方案，复用现有解析和清洗管线；核对与 PR #6 的差异及学生公开投影，不重复引入另一套解析器。
2. 先将当前 v2 合入 PR 分支，保留 PR #16 设置改动及 PR #21 题面修复。
3. 在 Chromium 复现 wrong-book 用例失败，核对页面可访问树；修复 e2e/wrong-book.spec.ts 的公式名称断言，并补 KaTeX 与 MathML 仍存在的检查。
4. 同步 PR 描述及专题约定，依次完成完整 diff 的简化、正确性和学生展示安全检查。

## 根因与验证

- 原 CI：Chromium/WebKit 均在同一断言失败，其余 253 项通过。
- 本机原用例复现失败：按钮实际可访问名含「判断 −1 是负数。 填空处 错 2 · 对 1」，旧断言却匹配 ASCII「-1 是负数」。PR #6 的辅助摘要使用 ASCII；PR #22 删除摘要后，公式由 KaTeX/MathML 提供语义，减号是 U+2212。
- 修正真实可访问名断言，继续验证分区归属、刷新、课程筛选与网络泄露守卫，不用跳过用例或延长超时规避问题。
- 本机只运行定向单测、类型检查、变更文件 Biome 与相关浏览器回归；全量单测、双浏览器 E2E 和构建由最新 PR CI 把关，全部通过后合入 v2。

## 本机结果与审查

- 原 Chromium 用例在旧断言处失败；修正后 `pnpm e2e e2e/wrong-book.spec.ts --workers=1` 双浏览器 4/4 通过（1.0m），覆盖三轮作答、分组、攻克切换、刷新、课程筛选与既有网络泄露守卫。
- InlineMarkdown 与错题本页面定向 Vitest：2 文件 31/31 通过（13.84s）。
- `pnpm --filter web typecheck`、`pnpm exec tsc -p e2e/tsconfig.json`、7 个变更源文件 Biome 与 `git diff --check origin/v2` 均通过。
- 简化审查：复用原解析/清洗与填空展示宿主，负数行定位器复用，不重复维护纯文本摘要；既有 RichMarkdown compact 仍由笔记层消费，保留其行为。
- 正确性审查：公式保留 MathML，表格和媒体占位，单行 DOM 不嵌套交互控件；空框断开作答上下文，展开卡继续沿用 RichMarkdown。此次失败由测试依赖旧辅助摘要字符造成，无需改坏公式输出。
- 安全审查：学生题干继续经 displayStemMd 投影，复用现有 sanitize；无服务端、契约、答案授权或接口变更，原有泄露守卫保持启用。专题约定与页面功能说明同步。
- task-workflow、systematic-debugging、simplify、code-review、security-review、verification-before-completion 工作流技能当前未提供，以上执行等效定位、审查及真实验证，未声称运行这些技能。
