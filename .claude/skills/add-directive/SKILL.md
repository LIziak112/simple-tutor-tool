---
name: add-directive
description: 在 simple-tutor-tool 中新增 DSL 指令（Markdown 容器/块/行内指令，如 :::tip、::graph、:mark）的标准四步流程与兼容规则。凡要给讲义/练习加新的展示或互动能力、改 directives.ts 注册表、写指令 React 组件时使用。核心约束：已发布指令只增不改、改名用别名、未知指令必须优雅降级；Phase 7 起注册表支持可选能力标注（capability 三面）。
---

# 新增 DSL 指令

适用于 T1.2、T1.8，以及以后所有"给内容加新功能"的需求。新功能 = 在注册表登记一个新指令名，**永远不发明新符号**，解析器底层不动。

## 三种固定语法（只有这三种，不要新增写法）

| 写法 | 形式 | 场景 |
| --- | --- | --- |
| 容器指令 | `:::名称{属性}` … `:::` | 包住一段内容；嵌套时外层 `::::` |
| 块指令 | `::名称[文字]{属性}` | 独立一行组件，如 `::graph{fn="x^2"}` |
| 行内指令 | `:名称[文字]{属性}` | 句中标记，如 `:mark[重点]{color=red}` |

属性统一 `{#id .样式类 键=值 键="带空格的值"}`。

## 标准四步（不得绕过注册表）

1. **注册**：`packages/contract/src/directives.ts` 加一条 `defineDirective({ name, kind, since, allowedIn, attrs, description, example })`。attrs 全部可选、带默认值；description 和 example 必须认真写——它们会被 `pnpm gen:spec` 自动生成进给 AI 的规范文档。**能力标注（Phase 7 起，可选 `capability` 字段）**：三面为 `interaction`（交互，面内词表键 `inputType`）/ `evidence`（证据格式）/ `validation`（判分形态），填写**实际已实现**的能力——交互类指令（如 `blank` 的 interaction 为 fill 输入）填实际能力，纯展示类指令（如 `tip`、`columns`）省略整个 `capability` 字段；不得把 partial 或计划中的行为写成已有能力（词表与既有标注定档见 `packages/contract/src/capability.ts` 与 `docs/组件渲染核心精进方案.md` §4.3）。注册期有唯一性冲突校验（如 ink-strokes 证据必须配 ink 输入）。
2. **组件**：`apps/web/src/features/markdown/directives/` 写对应 React 组件，按注册名映射（组件只读注册表 schema 解析后的类型化 attrs，不自写属性解析）。
3. **样例 + 测试**：`samples/` 加一个用到该指令的样例，补一个渲染测试。`samples/` 下所有历史样例是兼容性回归测试（自动发现，新增文件无需手改清单），改动后必须仍能解析、渲染一致。
4. **生成规范**：跑 `pnpm gen:spec`，确认 `docs/dsl/规范.md`、提示词模板、JSON Schema、能力清单 capabilities.json 里出现该指令。CI 会检查 gen:spec 后 git diff 为空。

**涉及新作答形态的指令不止四步**（新的输入/证据方式）：还需适配学生端题卡会话上下文（`DirectiveSessionContext`，fill/telemetry 子命名空间）与服务端判分桥接（题型能力表 validatorId + `packages/grading` 校验器注册表）；纯展示类指令无需这些适配。

## 兼容规则（AGENTS.md 第 11 条，违反即 bug）

1. **只增不改**：已发布指令的名字和含义永不改变；属性只能新增，且必须可选、带默认值。
2. **改名用别名**：确需改名时登记 `aliases: ['旧名']`，旧写法继续有效，linter 只提示建议改用新名。
3. **未知指令优雅降级**：渲染时显示其内部文字 + 灰色边框，页面不报错不崩溃；linter 给 warning（不是 error），并提示近似名（"你是不是想用 `:::tip`？"）。
4. **版本声明**：frontmatter `dsl: 2`（缺省即 2，当前唯一支持的版本；v1 旧格式已于 2026-10-05 停止支持）。

设计原因：老师已导入的内容存的是原始 Markdown，前端升级后旧文档里"沉睡"的指令会自动以新样式呈现，无需重新导入；如果改了旧指令的含义，老内容会悄悄变样，这是最恶劣的破坏。
