# 移除 v1 DSL 兼容层 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 v1 旧格式（`#### 题 N`、`【题型】`、`<!-- ANSWER -->`）的全部兼容代码、样例与文档承诺，内容管线只支持 v2 DSL。

**Architecture:** v1 兼容层集中在 `packages/md-dsl`（v1 解析器、v1ToV2 转换、detectVersion），生产唯一消费点是 `content-service.ts` 的 `analyzeImport`（导入时 detect→转换→统一 v2 lint），MCP `lint_markdown` 复用同一函数；前端两个预览页直接 import `v1ToV2` 做渲染转换。删除顺序按"前端先脱敏 → 契约+服务端+包内删除一次翻转 → 样例与生成物 → 文档"推进，每个提交保持可构建、测试全绿。

**Tech Stack:** TypeScript strict / pnpm workspace / Vitest / Biome / Zod（contract）/ gen:spec 生成管线。

**Spec:** 本计划自身即规格（依据 2026-10-05 盘点结论：本地 tutor.db 12 导入与服务器 61 导入/461 题全部 v2、v1 导入路径从未被用过、服务器与本地均无 v1 原稿；用户已确认删除）。决策记录落 `docs/技术架构与实施方案.md` §10。

## Global Constraints

- 契约优先（AGENTS 硬规则 1）：Task 2 内先改 `packages/contract` Zod schema，再改实现。
- TS strict，禁 any / @ts-ignore；UI 文案与注释中文。
- 两类 `version` 不可混淆：**preview 响应的 DSL version（本次删除）** vs **题目/讲义内容修订号（DB 列 `version`、`ContentEditSheet` 的"已保存为 vN"、reorder-logic 等——全部不动）**。
- 每个提交可构建、测试通过（AGENTS 硬规则 8）；分支 `refactor/remove-v1-compat`，基于 `v2`。
- 工作区已有用户未提交的 docs 改动（开发任务清单.md、进度表.md、Phase6 方案等）——**本计划不改这两个历史清单文件**，删除决策统一记录在架构文档 §10；提交时精确 `git add` 本计划触到的文件。
- `pnpm gen:spec` 之后 `git diff` 必须为空（CI 校验）：gen.ts 改动与再生成产物必须同提交。
- 完成定义：`pnpm test / lint / typecheck / build / e2e` 全绿 + gen:spec diff 空 + 文档同步 + PR 描述列手动验证步骤。

## Review Focus

1. **v1 老文档导入被拒且不脏库**：v1 特征文本 preview 应报 `MISSING_FRONTMATTER` error、commit 422 `LINT_ERROR`——Task 2 新增测试锚定（删除前红、删除后绿）。
2. **存量数据与 reparse 不受影响**：`questions.source_md` 本就是 v2 片段——Task 5 全量测试中 `reparse-service.test.ts` 必须保持绿。
3. **MCP 响应形状变化不破坏消费方**：`lint_markdown` 响应去 `version`、工具描述去 v1 说法——Task 2 更新 `mcp.test.ts`；Task 3 审查 gen:spec 再生的提示词模板 diff；Task 5 跑 `pnpm e2e`（含 mcp-smoke）。
4. **CI gen:spec diff 空校验**——Task 3 生成物同提交，Task 5 复验 `git diff --exit-code`。
5. **前端无 v1 死代码/死文案残留**——Task 1 删除后以 `grep -rn "v1ToV2\|旧版 v1\|version === 1" apps/web/src` 清零复验（Task 5）。

---

### Task 1: 前端脱敏——预览页/错误面板不再消费 version 与 v1ToV2

**Files:**
- Modify: `apps/web/src/pages/teacher/SingleImportPreview.tsx`（:3 import v1ToV2；:152 renderSource 三元；:227 转换提示；:246 传 ErrorPanel 的 version；:344-361 DSL v1/v2 徽标）
- Modify: `apps/web/src/pages/teacher/BatchImportPreview.tsx`（:209、:503、:607-608、:625 同类改动）
- Modify: `apps/web/src/features/content/ErrorPanel.tsx`（:18-23 props 的 version 与注释；:43、:120-123 v1 行号提示 UI）
- Modify: `apps/web/src/features/content/error-prompt.ts`（:17-22 ImportFileError.version 与注释；:121-124 v1 分支）
- Modify: `apps/web/src/pages/teacher/ImportPage.tsx`（:548 文案「v2 DSL 与旧版 v1 格式」→「v2 DSL」）
- Test: `apps/web/src/features/content/error-prompt.test.ts`（删 :130-140 v1 行号说明用例；:55 等夹具删 version 字段）
- Test: `apps/web/src/features/content/ErrorPanel.test.tsx`（:111、:134 夹具删 version）
- Test: `apps/web/src/pages/teacher/ImportPage.test.tsx` 等（grep `version` 于 preview mock，仅删 previewData 的 DSL version）

**Interfaces:**
- Consumes: 现有 contract（本次不动，version 字段仍在响应中，前端只是不再读）。
- Produces: `ImportFileError` 无 `version` 字段；`ErrorPanelProps` 无 `version`；预览页渲染一律直接用原文 `markdown`。

- [x] **Step 1: 改测试先红**——error-prompt.test.ts 删 v1 用例与夹具 version 字段、ErrorPanel.test.tsx 夹具删 version，运行 `pnpm test -- error-prompt ErrorPanel` 应编译失败（props 仍要求 version），证明接线未断。（实际红线在 typecheck：vitest 不做类型检查，7 处 TS2741/TS2375 证实）
- [x] **Step 2: 实现**——按 Files 所列删除四处消费点；DSL 版本徽标整块删除（v1/v2 区分已不存在，不再保留固定"DSL v2"徽标）；renderSource 直接等于原文。
- [x] **Step 3: 夹具清理**——grep `apps/web/src` 中 preview mock 的 `version:`，仅删 DSL version（题目修订 version 不动，见 Global Constraints）。（追加发现并处理：ContentEditSheet.tsx 两处写死 version={2} 的 ErrorPanel 调用、ImportPage.test/SharedPage.test 的「预览已到达」哨兵从 DSL v2 徽标改为动作清单标题）
- [x] **Step 4: 验证**——`pnpm test && pnpm typecheck` 绿。（web 794/794 + typecheck OK + lint OK）
- [x] **Step 5: Commit**——`git add` 上述文件，`fix(web): 导入预览移除 v1 转换渲染与版本徽标——前端不再消费 DSL version 字段`。（5e4a5b8，10 文件 +30/−112）

### Task 2: 核心翻转——契约删 version、服务端删转换路径、md-dsl 删 v1（TDD）

**Files:**
- Modify: `packages/contract/src/content-api.ts`（:158-168 importPreviewDataSchema 删 `version` 字段，注释同步）
- Modify: `apps/server/src/services/content-service.ts`（:33-38 import 清理；:71-72、:105-106、:117-147 头注释与 analyzeImport 删 detect/v1ToV2 与 `ImportAnalysis.version`；:214-221、:436-448 preview 组装去 version）
- Modify: `apps/server/src/mcp/server.ts`（:200 工具描述去「v1 旧格式自动兼容转换」「版本识别」；:206-209 响应去 version；import_markdown 若透传 preview version 一并删——grep `version`）
- Delete: `packages/md-dsl/src/v1/`（parse.ts 704 行、toV2.ts 204 行及两个测试文件）、`packages/md-dsl/src/detect.ts`、`detect.test.ts`
- Modify: `packages/md-dsl/src/index.ts`（删 :5-6、:12-13、:16-27 的 detect/v1 导出与头注释 T1.6 句）
- Test: `apps/server/src/services/content-service.test.ts`（新增 v1 拒绝测试；删 :154、:282、:476-540+ 的 v1 用例）
- Test: `apps/server/src/mcp/mcp.test.ts`（:380 `cleanData.version` 断言删；:656 用例名去 v1 说法）

**Interfaces:**
- Produces: `analyzeImport(markdown: string, fallbackUnitId?: string): { issues: LintIssue[]; parsed: ParsedDocument }`（无 version）；`importPreviewDataSchema` 无 `version`；`@tutor/md-dsl` 公开面不再有 `parseV1*/v1ToV2*/detectVersion*/V1_*`。

- [x] **Step 1: 写失败测试**——content-service.test.ts 新增：

```ts
it("v1 特征文档不再自动转换：直接按 v2 lint，报 MISSING_FRONTMATTER error", () => {
  const v1Md = "#### 题 1（★）\n【题型】判断\n判断：1+1=2。\n\n<!-- ANSWER: 正确 -->\n";
  const { issues } = analyzeImport(v1Md);
  expect(issues.some((i) => i.code === "MISSING_FRONTMATTER" && i.level === "error")).toBe(true);
});
```

运行 `pnpm test -- content-service`：预期 FAIL（当前 v1 被转换、0 error）。
- [x] **Step 2: 契约先行**——importPreviewDataSchema 删 version 字段（此时 server 仍返回 version 会类型报错，属预期中间态，本任务内收敛）。
- [x] **Step 3: 服务端**——analyzeImport 删 detect/v1ToV2 分支与 version；preview/preview-batch 组装去 version；删文件头 v1 相关注释段；同文件测试删旧 v1 用例（"v1 示例练习：version 1"、"v1 原文经 toV2 落库"、"再导入同一 v1 文件"、v1ToV2 unit fallback、"v1 文档可导入"验收用例）。
- [x] **Step 4: MCP**——lint_markdown/import_markdown 描述与响应去 version 与 v1 说法；mcp.test.ts 断言与用例名同步。
- [x] **Step 5: md-dsl 删除**——删 `src/v1/` 整目录与 `detect.ts`/`detect.test.ts`；index.ts 清理导出与头注释。
- [x] **Step 6: 验证**——`pnpm test && pnpm typecheck`：新增测试转绿、无残留编译错误。（追加发现并处理：zip-import-service.ts 的 dry-run 条目 version 字段、content-service.test 两处 data.version 断言、routes/content.test.ts 与 routes/import.test.ts 的 v1 集成用例改写为拒绝口径——全量 208 文件 2386 测试绿）
- [x] **Step 7: Commit**——`refactor!: 移除 v1 DSL 兼容层——md-dsl 删 v1 解析/转换/版本检测，导入与 MCP 只走 v2（breaking：preview/lint_markdown 响应不再含 version 字段）`。（920542b，19 文件 +69/−2361）

### Task 3: 样例删除与规范、生成物同步

**Files:**
- Delete: `samples/v1/`（整目录，唯一文件 示例练习.md）
- Modify: `packages/md-dsl/src/spec/gen.ts`（:225 dsl 字段行「DSL 版本号，缺省 2；旧版本文档永远按旧规则解析」→「DSL 版本号，缺省 2；当前仅支持 v2」，并 grep gen.ts 全文其余 v1 提法一并清理）
- 生成物（`pnpm gen:spec` 再生，同提交）：`docs/dsl/规范.md`、`docs/dsl/提示词模板.md`、`docs/dsl/schema/content.json`、`dsl-kit/` 三件套 + `content.json`、`dsl-kit/tutor-lint.mjs`（v1 代码删除后重新打包）

**Interfaces:**
- Consumes: Task 2 后的 md-dsl（bundle-standalone 打包新代码）。
- Produces: samples/ 只剩 `lint/` 与 `v2/`（AGENTS 硬规则 12 对现存样例继续成立）。

- [x] **Step 1: 删 samples/v1/ 与改 gen.ts**。
- [x] **Step 2: 再生成**——`pnpm gen:spec`；检查 diff：规范.md dsl 行、提示词模板中 v1 提法（如有）、tutor-lint.mjs 体积下降，无其他意外变化。（实际 diff：规范两处 dsl 行 + tutor-lint.mjs 重打包；schema 与提示词模板无变化——契约 API schema 不在导出范围）
- [x] **Step 3: 验证**——`pnpm test`（cli/fixtures.test 只扫 lint/ 与 v2/，应不受影响）+ `pnpm gen:spec && git diff --exit-code` 为空。（md-dsl 251/251；提交后复跑 gen:spec 幂等）
- [x] **Step 4: Commit**——`chore: 删 samples/v1 样例，规范 dsl 字段说明改为仅支持 v2，重跑 gen:spec 同步 dsl-kit`。（a63cb5c）

### Task 4: 文档同步与决策记录

**Files:**
- Modify: `docs/技术架构与实施方案.md`（:13 总体路线；:177、:182 目录注释；:358 §5.1「v1 兼容」段删除；:669 §6；:699、:810、:816 的「v1/v2 均可」表述；§10 追加第 10 条决策）
- Modify: `docs/部署.md`（:272-275 上线切换：改为仅支持 v2 DSL；旧 v1 系统已于 2026-10-05 下线清退，其内容最终备份为服务器 `/root/backup-quiz-FINAL-20261005-221838.tar.gz`（含 content.json：解析态 JSON，141 题/12 讲义/3 份提交），如需找回按一次性转换或 AI 重排为 v2 .md 再导入）
- Modify: `docs/内容模型与导入规范化方案.md`（:88「v1 文档照旧走 v1ToV2 自动转换」句删除/改写）
- 不改：`docs/开发任务清单.md`、`docs/进度表.md`（历史记录且工作区有用户未提交改动；作废事实由 §10 决策承载）

**Interfaces:**
- Produces: §10 第 10 条决策文案（要点）：2026-10-05 移除 v1 兼容层，修订 D14「v1/v2 均可」为仅 v2；依据=本地与线上（61 次导入/461 题）零 v1 存量、v1 导入路径从未使用、服务器与本地均无 v1 原稿；旧系统 quiz-system（8787）已于同日下线清退，内容最终备份 `/root/backup-quiz-FINAL-20261005-221838.tar.gz`，如需保留按转换/AI 重排迁入；v1 特征文档再导入将因 MISSING_FRONTMATTER 被拒。

- [x] **Step 1: 架构文档七处 + §10 新决策**（先确认 §10 现有条数，编号顺延）。（决策 10 已追加，修订决策 3/9）
- [x] **Step 2: 部署.md 与内容模型方案**。（部署.md 已改；内容模型方案已被并行会话移入 docs/archive/，按"历史记录不改"原则跳过，作废事实由 §10 决策 10 承载；追加：双语 README samples/ 目录注释同步）
- [x] **Step 3: Commit**——`docs: v1 兼容层移除的文档同步——架构 §5.1/§10 决策 10、部署上线切换、双语 README 样例目录`。（4dc4dd4）

### Task 5: 质量闸门、终验与合并

- [x] **Step 1: `/simplify`** 对本分支完整 diff，确认发现当场修复或逐条给理由。（065d81d：4 角度 13 项修复，3 项跳过有理由——Zip 干跑形状嵌套、ErrorPanel 每渲染重建、跨文件夹具共享不合项目惯例）
- [x] **Step 2: `/code-review`** 正确性审查，同上处理。（10 路查找 + sweep：1 项实质正确性缺口——v1 正文+合法 frontmatter 静默空导入，以新通用 lint 规则 PRACTICE_NO_QUESTIONS 堵住（60934b3）；sweep 补漏编辑抽屉重复提示（5cedf63）；12 修复 / 2 保留 / 1 无需改）
- [x] **Step 3: 终验（贴输出）**——`pnpm test && pnpm lint && pnpm typecheck && pnpm build && pnpm e2e`；`pnpm gen:spec && git diff --exit-code`；`grep -rn "v1ToV2\|parseV1\|detectVersion" apps packages --include="*.ts" --exclude-dir=node_modules` 为空、`grep -rn "旧版 v1" apps/web/src` 为空。（test 2392/2392 ×2 轮、e2e 50/50、typecheck/lint/build 绿、gen:spec 幂等复验通过；grep 残留清零；首跑 e2e 6 失败为与 10 审查代理并发导致的资源争用抖动，独跑复验 50/50）
- [ ] **Step 4: 合并**——分支全绿后并入 `v2`，推送（VPN 代理见记忆），再发 `main`；PR 描述列手动验证步骤（导入一份 v2 样例正常、粘一段 `#### 题 1` 文本预览报 MISSING_FRONTMATTER、MCP lint_markdown 调用一次）。
