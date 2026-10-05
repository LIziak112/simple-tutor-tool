# dsl-kit —— 把材料交给 AI 整理的一站式工具包

> 本文件夹把「内容 DSL 规范 + 校验方式 + 材料整理技能」打包在一处：拷走这一个文件夹，
> 配上你自己的 AI 工具（任意对话 AI、Claude Code、Cursor 等），就能让它把讲义、
> 题目、课本章节整理成可直接导入 simple-tutor-tool 的 Markdown。
>
> **固定位置约定**：规范与校验永远从这里找，不用到处翻。
> 其中 `规范.md`、`完整样例.md`、`提示词模板.md`、`schema/content.json` 由仓库
> `pnpm gen:spec` 自动同步（与 `docs/dsl/` 同源），**请勿手改**；`README.md` 与
> `SKILL.md` 手写维护。

## 文件清单

| 文件 | 说明 | 维护方式 |
| --- | --- | --- |
| [规范.md](规范.md) | 内容 DSL v2 权威规范（指令清单、lint 错误码、兼容规则） | 自动生成 |
| [完整样例.md](完整样例.md) | 三种 kind 的完整可复制样例（给 AI 的 few-shot 首选） | 手写（随仓库） |
| [提示词模板.md](提示词模板.md) | 出题提示词模板，与规范、样例一起发给 AI | 自动生成 |
| [schema/content.json](schema/content.json) | 题目/单元/讲义结构化字段的 JSON Schema | 自动导出 |
| [SKILL.md](SKILL.md) | 「材料整理」技能：让 AI 按固定工作流整理材料并自校验 | 手写 |

## 三种用法

### 用法一：任意 AI 对话（零配置）

把 `规范.md` + `完整样例.md`（出题再加 `提示词模板.md`）作为附件或粘贴内容发给
AI，让它按规范产出 Markdown。产出后用下面「怎么校验」任一方式检查。

### 用法二：支持 Skill 的工具（Claude Code 等，推荐）

把整个 `dsl-kit/` 文件夹复制为你的 skills 目录下的 `material-to-dsl/`
（个人技能在 `~/.claude/skills/material-to-dsl/`，项目技能在项目的
`.claude/skills/material-to-dsl/`）。之后对 AI 说「把这份材料整理成讲义 / 出一套
练习」，它会按 [SKILL.md](SKILL.md) 的工作流读规范、产出、自校验到 0 error。

### 用法三：自部署服务器（在线直连，无需本文件夹）

部署了 simple-tutor-tool 的用户可以不经文件夹直接用服务器能力：

- **MCP**：地址 `<你的服务器>/mcp`（教师 API Token 鉴权）。相关工具：
  `get_dsl_spec`（取规范与样例）、`lint_markdown`（校验）、`upload_image`
  （传图取回 src）、`import_markdown` / `import_zip`（导入）；
- **`/spec` 路由**：`/spec/rules.md`、`/spec/example.md`、`/spec/prompt.md`、
  `/spec/schema.json` 随时取最新规范，链接直接发给 AI 即可。

## 怎么校验产出的 MD（三选一，任选其一）

| 方式 | 适用 | 说明 |
| --- | --- | --- |
| MCP `lint_markdown` | 已部署服务器、AI 工具已接 MCP | 把文档全文发给它，返回逐条 issue（含行列与修复建议）；校验-修正循环首选 |
| `pnpm tutor-lint <文件或目录>` | 本地有本仓库源码 | 彩色输出全部 issue；有 error 退出码 1 |
| 教师端「导入」页 | 所有人（兜底） | 把文件（可连同引用的图片一起）拖进导入页，预览即 lint 门禁，error 会拦下并给出提示 |

## 图片怎么处理

AI 整理时让 `::image` 的 src 直接写图片的**真实文件名**；导入时在导入页把 md 与
图片（或整个文件夹）一起选择，系统会自动上传被引用的图片并改写 src。详见
`规范.md` 的 image 指令与 IMAGE_SRC_NOT_FOUND 错误码说明。

## 更新本文件夹

规范文件随仓库版本演进：升级 simple-tutor-tool 后，从新版仓库重新拷贝整个
`dsl-kit/` 即可（或重新部署服务器后用 `/spec` 取最新版）。
