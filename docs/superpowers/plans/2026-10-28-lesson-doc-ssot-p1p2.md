# 讲练文档 SSOT 补齐（P1 题块回写 + P2 替换入口与预览标红）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐讲练文档「以文档为唯一真相」的三个缺口：题库单题编辑回写讲练页正文题块（P1a）、讲义导出钉住身份（P1b）、重导显式替换入口与缺省题号错位预警（P2）。

**Architecture:** 不新建实体表。讲练页 `lectures.markdown` 已是题块原位真相（开围栏注入最终题目 id）；P1a 在 `updateQuestion` 事务内把新 sourceMd 同步替换回讲义正文对应题块，终结「题库改了、讲义原文旧了、重导冲掉修正」的双重真相。P1b 让 `exportLectureMd` 写出 `title:` frontmatter，导出→改 H1→重导不再断链（frontmatter title 本就是既有身份键，规则零新增）。P2 在 PR #40（origin/v2 `f6bb9fff`，同名重导接管）之上加教师显式指认 `replaceLectureId`（改名重导换页不断链、课程引用保留），并在导入预览对「缺省派生 id 且命中更新」的题亮错位风险（派生 id 按 `单元id-序号` 占位，插题后错位更新，代码注释已承认此隐患）。

**Tech Stack:** TypeScript strict、Zod 契约先行（`packages/contract`）、drizzle-orm + better-sqlite3 同步事务、md-dsl（remark 解析）、vitest、React + shadcn/ui（教师端）。

**Spec:** 本会话《文档 SSOT 可行性分析》结论（P1/P2 范围裁定）；[docs/约定/学生作答与讲练.md](../../约定/学生作答与讲练.md)「位置即 markdown」；[docs/技术架构与实施方案.md](../../技术架构与实施方案.md) §5.1「命名与身份规则」「原文是真相」；PR #40 五层修复（origin/v2，接管/预览择主守卫 backfill）。

## Global Constraints

- **基线 `origin/v2`（`f6bb9fff`）**：本地 v2 检出（`ca985c04`）落后 373 提交。实施前 `git checkout -b feat/lesson-doc-ssot origin/v2`；共租 checkout 先确认无并行会话，必要时用独立 worktree（用户共享协议）。
- 契约先行：先改 `packages/contract` 再改实现；每次契约变更后运行 `pnpm gen:spec`（含 schema 导出）并提交全部产物，CI 要求生成后 `git diff` 为空。
- 类型严格：禁 `any`、`@ts-ignore`；确有必要用 `@ts-expect-error` 并写明原因。
- 删除一律软删（题目/单元/讲义恒不物理删除）；不得触碰 `publicOfSnapshot`、`studentStemMd`、`assertNoLeak` 保护——本计划全部改动在教师域，学生接口零变化。
- UI 文案中文、标识符英文；触控目标 ≥44px；不新增架构外依赖、不用 CDN。
- 每提交可构建、测试通过；分支只合并 `v2`，绝不建 →main 的 PR；推送由用户拍板（代理直推惯例）。
- 测试命令口径：单文件 `pnpm vitest run <路径>`；开发循环 `pnpm test:quick`；提交前 `pnpm typecheck:affected`、`pnpm lint:changed`。

## Review Focus

1. **回写后学生讲练切段一致性**：回写题块后 `splitLessonBlocks` 切出的题目槽 id 集合须与嵌入单元 live 题 id 集合一致（学生端只拿切段+冻结投影，回写不得破坏对位）→ Task 2 测试「回写后切段对位」。
2. **`replaceLectureId` 域校验**：指向不存在或他人讲义 → 404 `REPLACE_LECTURE_NOT_FOUND`（不暴露存在性）→ Task 5。
3. **替换保留课程引用**：替换后 `course_items.refId` 指向的讲义行 id 不变（课程目录/学生可见性不断链）→ Task 5。
4. **回写边界**：替换题块不吞相邻 md 段、CRLF 保持、`::::` 闭合围栏完整、无 id 题块与重复 id 不参与定位 → Task 1 全部用例 + Task 2 缺块 422。
5. **错位预警不误报**：lesson 文档（keep 模式恒注入 id）、显式 id 题更新、全新插入题均不出 `DERIVED_ID_UPDATED_QUESTIONS` → Task 4。

---

### Task 1: md-dsl 题块定位替换纯函数（回写的地基）

**Files:**
- Create: `packages/md-dsl/src/v2/lesson-block.ts`
- Modify: `packages/md-dsl/src/v2/question.ts`（新增 `withQuestionId` / `hasExplicitQuestionId`，逻辑从 `apps/server/src/services/library-service.ts:1311` 的私有 `ensureQuestionId` 上移收敛）
- Modify: `packages/md-dsl/src/index.ts`（导出三个新函数）
- Modify: `apps/server/src/services/library-service.ts:1311`（`ensureQuestionId` 删除本地实现，改 `import { withQuestionId } from "@tutor/md-dsl"` 并以 `const ensureQuestionId = withQuestionId;` 保持调用点不变；`shared-service.ts` 的围栏匹配器本任务不动，记 simplify 候选）
- Test: `packages/md-dsl/src/v2/lesson-block.test.ts`

**Interfaces:**
- Produces（后续任务依赖的精确签名）:
  - `withQuestionId(sourceMd: string, id: string): string` —— 首行 `::::question` 围栏无 `id=` 属性时注入 `id="<id>"`（JSON 字符串转义），已有则原样返回；首行非题容器原样返回（与现 `ensureQuestionId` 语义逐字一致）。
  - `hasExplicitQuestionId(sourceMd: string): boolean` —— 首行围栏含 `id=` 属性判定（正则与 `withQuestionId` 同源：`/^(:{4}question)(\{.*)?$/` + `/(^|\s)id\s*=/`）。
  - `replaceLessonQuestionBlock(markdown: string, questionId: string, newSourceMd: string): { markdown: string; replaced: boolean }` —— 见步骤语义。

- [ ] **Step 1: 写失败测试**

```ts
// packages/md-dsl/src/v2/lesson-block.test.ts
import { describe, expect, it } from "vitest";
import { hasExplicitQuestionId, withQuestionId } from "./question.ts";
import { replaceLessonQuestionBlock } from "./lesson-block.ts";

const LESSON_MD = [
  "# 第 1 讲 有理数", "", "引入段。", "",
  '::::question{id="q-1" type=fill difficulty=2}',
  "计算 [[3]]。", ":::", "::::", "", "收尾段。",
].join("\n");

describe("withQuestionId / hasExplicitQuestionId", () => {
  it("无属性围栏注入 id；有属性追加 id；已有 id 原样；非容器原样", () => {
    expect(withQuestionId("::::question\n题干\n::::", "q-9")).toBe(
      '::::question{id="q-9"}\n题干\n::::');
    expect(withQuestionId("::::question{type=judge}\n题\n::::", "q-9")).toContain('id="q-9"');
    expect(withQuestionId('::::question{id="q-1"}\n题\n::::', "q-9")).toBe(
      '::::question{id="q-1"}\n题\n::::');
    expect(withQuestionId("普通段落", "q-9")).toBe("普通段落");
    expect(hasExplicitQuestionId('::::question{id="q-1"}')).toBe(true);
    expect(hasExplicitQuestionId("::::question{type=judge}")).toBe(false);
  });
});

describe("replaceLessonQuestionBlock", () => {
  const NEW_BLOCK = "::::question{type=fill difficulty=2}\n新题干 [[7]]\n:::\n::::";
  it("命中替换：注入 id、保留相邻段落与 H1", () => {
    const r = replaceLessonQuestionBlock(LESSON_MD, "q-1", NEW_BLOCK);
    expect(r.replaced).toBe(true);
    expect(r.markdown).toContain('::::question{id="q-1"');
    expect(r.markdown).toContain("新题干");
    expect(r.markdown).toContain("引入段。");
    expect(r.markdown).toContain("收尾段。");
    expect(r.markdown).not.toContain("计算 [[3]]");
  });
  it("id 不存在 → replaced:false 且原文逐字返回", () => {
    const r = replaceLessonQuestionBlock(LESSON_MD, "q-404", NEW_BLOCK);
    expect(r).toEqual({ markdown: LESSON_MD, replaced: false });
  });
  it("无 id 题块不按兜底序号匹配（只认显式 id）", () => {
    const noId = LESSON_MD.replace('id="q-1" ', "");
    expect(replaceLessonQuestionBlock(noId, "第1讲-1", NEW_BLOCK).replaced).toBe(false);
  });
  it("同 id 两块 → replaced:false", () => {
    const dup = `${LESSON_MD}\n\n${LESSON_MD}`;
    expect(replaceLessonQuestionBlock(dup, "q-1", NEW_BLOCK).replaced).toBe(false);
  });
  it("CRLF 输入保持 CRLF 输出", () => {
    const r = replaceLessonQuestionBlock(LESSON_MD.replace(/\n/g, "\r\n"), "q-1", NEW_BLOCK);
    expect(r.replaced).toBe(true);
    expect(r.markdown).includes("\r\n").toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/md-dsl/src/v2/lesson-block.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`question.ts` 加两个纯函数（正则从 library-service `ensureQuestionId` 原样搬入）；新建 `lesson-block.ts`：

```ts
// 语义：processor.parse(markdown) 取顶层 question 容器，attributes.id === questionId
// 的容器**恰好一个**才替换；0 个或多个 → { markdown 原样, replaced: false }。
// 替换文本 = withQuestionId(newSourceMd, questionId)（保证开围栏带显式 id）。
// 行拼接：eol = markdown.includes("\r\n") ? "\r\n" : "\n"；按容器 position
// start/end 行号（1 起）切 lines.splice 替换后 rejoin。
```

`index.ts` 导出三者。

- [ ] **Step 4: 跑测试确认通过（含收敛回归）**

Run: `pnpm vitest run packages/md-dsl/src/v2/lesson-block.test.ts && pnpm vitest run apps/server/src/routes/library.test.ts`
Expected: PASS（library 导出用例覆盖 `ensureQuestionId` 行为不变）。

- [ ] **Step 5: 提交**

```bash
git add packages/md-dsl apps/server/src/services/library-service.ts
git commit -m "feat(md-dsl): 题块定位替换与围栏 id 注入收敛单源（lesson-block）"
```

---

### Task 2: updateQuestion 回写讲练题块（P1a 核心）

**Files:**
- Modify: `packages/contract/src/content-api.ts`（`questionUpdateDataSchema` 加 `lessonSynced`；`contentErrorCodeSchema` 加 `LESSON_QUESTION_BLOCK_MISSING`；两处注释写明语义）
- Modify: `apps/server/src/services/content-service.ts`（`updateQuestion`，本地基线行号 1170，origin/v2 略移——按函数名锚定）
- Test: `apps/server/src/services/content-service.test.ts`（沿用文件内既有 `updateQuestion` 测试装配；lesson 夹具用 `commitImport` 导入最小 lesson 文档构造）

**Interfaces:**
- Consumes: Task 1 的 `withQuestionId`、`replaceLessonQuestionBlock`。
- Produces: `QuestionUpdateData` 新增 `lessonSynced: boolean`（契约 `z.boolean().optional()`，服务端恒写；嵌入题回写成功 true，非嵌入 false）。新错误码 `LESSON_QUESTION_BLOCK_MISSING`（422）。

- [ ] **Step 1: 契约先行（含产物）**

`questionUpdateDataSchema` 加 `lessonSynced: z.boolean().optional()`（注释：讲练嵌入题编辑已同步回讲义正文题块；普通题为 false）。`contentErrorCodeSchema` 枚举追加 `"LESSON_QUESTION_BLOCK_MISSING"`（注释：讲练页正文未找到该题题块——存储正文被手工改动等数据异常，编辑被拒，引导整页重导修正）。

Run: `pnpm gen:spec`
Expected: 生成产物变更随本任务一并提交（CI diff-empty 要求）。

- [ ] **Step 2: 写失败测试**

```ts
// content-service.test.ts 追加（fixture：commitImport 一份单题 lesson 文档）
it("嵌入题更新：题库与讲义正文同事务回写", () => {
  const { lectureId } = commitLesson(db, TEACHER, "第 1 讲", ['::::question{type=fill difficulty=2}\n计算 [[3]]。\n:::\n::::']);
  const before = getLectureDetail(db, TEACHER, lectureId);
  const data = updateQuestion(db, TEACHER, "第1讲-1", {
    sourceMd: "::::question{type=fill difficulty=2}\n新题干 [[7]]\n:::\n::::",
  });
  expect(data.lessonSynced).toBe(true);
  const after = getLectureDetail(db, TEACHER, lectureId);
  expect(after.markdown).toContain('id="第1讲-1"');   // 无 id 提交也被注入
  expect(after.markdown).toContain("新题干");
  expect(after.updatedAt).not.toBe(before.updatedAt);
});

it("回写后 splitLessonBlocks 槽 id 与嵌入单元 live 题一致", () => {
  // 上例回写后：splitLessonBlocks(after.markdown) 的 question 槽恰为 [{ questionId: "第1讲-1" }]
});

it("讲义正文缺该题块 → 422 LESSON_QUESTION_BLOCK_MISSING，题目不更新", () => {
  // 先 updateLecture 把题块从正文删掉，再 updateQuestion：
  // 断言抛 HttpError 422 且题目 version 不变（事务回滚）
});

it("普通练习题：lessonSynced:false，无讲义行被触碰", () => {
  // practice 文档题更新：断言 lectures 表无行 updatedAt 变化
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run apps/server/src/services/content-service.test.ts`
Expected: FAIL（`lessonSynced` 不存在 / 回写未发生）。

- [ ] **Step 4: 实现 `updateQuestion` 回写**

要点（签名不变）：
1. 取题行后查嵌入归属：`units.lectureId` join `lectures`，`lectures.kind === 'lesson'` 即嵌入（**含软删讲义**，与 `lesson-embedded.ts` 谓词同口径）；非嵌入 → 现行为 + `lessonSynced: false`。
2. 规范化存储文本：`const storedSourceMd = withQuestionId(next.sourceMd, id)`；`questionFields({ ...next, sourceMd: storedSourceMd }, …)` —— 题库 `sourceMd` 与讲义题块字节一致（注释写明该不变量）。
3. 嵌入时在同一事务内：`replaceLessonQuestionBlock(lectureRow.markdown, id, storedSourceMd)`；`replaced` → `tx.update(lectures).set({ markdown, updatedAt: now })`；否则 `throw new HttpError(422, "LESSON_QUESTION_BLOCK_MISSING", "讲练页正文中未找到该题的题块（数据异常）：请重新导入整页讲练文档修正")`。
4. 返回体加 `lessonSynced`。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run apps/server/src/services/content-service.test.ts`
Expected: PASS。

- [ ] **Step 6: 专题文档同步 + 提交**

[docs/约定/学生作答与讲练.md](../../约定/学生作答与讲练.md)「位置即 markdown」条增补一句：题库单题编辑对嵌入题同事务回写讲义正文题块（`lessonSynced`），题库与正文不再漂移；缺块 422 引导重导。

```bash
git add packages/contract apps/server docs/约定/学生作答与讲练.md
git commit -m "feat(lesson): 单题编辑回写讲练页题块，终结题库与讲义正文双源漂移"
```

---

### Task 3: exportLectureMd 钉住讲义身份（P1b）

**Files:**
- Modify: `apps/server/src/services/library-service.ts`（`exportLectureMd`，基线行号 1498）
- Test: `apps/server/src/routes/library.test.ts`（更新既有 golden：基线 1257「导出讲义：kind: lecture 头 + 原文」）+ 追加往返用例

**Interfaces:**
- Produces: 导出 frontmatter 行序固定 `kind` → `title` → `teachingPack`；`title: <yamlString(row.title)>`。无新 API。

- [ ] **Step 1: 写失败测试**

```ts
it("导出讲义含 title 行；改 H1 后重导命中同一讲义", () => {
  const lectureId = commitLecture(db, TEACHER, "第 1 讲");           // lecture 文档
  const { markdown } = exportLectureMd(db, TEACHER, lectureId);
  expect(markdown.startsWith('---\nkind: lecture\ntitle: "第 1 讲"\n---\n')).toBe(true);
  const renamed = markdown.replace("# 第 1 讲", "# 第 1 讲（修订）");
  const report = commitImport(db, TEACHER, { markdown: renamed, filename: "r.md" });
  expect(report.lectures).toEqual([
    { id: lectureId, title: "第 1 讲", inserted: false, updated: true },  // 同一行，title 列不变
  ]);
});
it("lesson 导出同规则（kind: lesson + title 行 + 含注入 id 的题块原文）", () => { /* 同构断言 */ });
it("有教学包声明时行序 kind → title → teachingPack", () => { /* 断言三行顺序 */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/server/src/routes/library.test.ts`
Expected: FAIL（无 title 行；改 H1 后 lectures 出现 inserted:true 新行）。

- [ ] **Step 3: 实现**

`exportLectureMd` 的 frontmatter 拼装插入 `title: ${yamlString(row.title)}` 行（`yamlString` 文件内已有）。注意：`shared-service`（发布到共享目录）与 `teaching-pack-service` 逐字复用本函数输出，行为自动跟随；跑它们的既有 golden 用例并同步更新断言。

- [ ] **Step 4: 跑受影响面测试确认通过**

Run: `pnpm vitest run apps/server/src/routes/library.test.ts apps/server/src/services/shared-service.test.ts && pnpm vitest run apps/server/src/services/teaching-pack-service.test.ts`
Expected: PASS（golden 按新 frontmatter 更新后）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src
git commit -m "feat(library): 讲义导出写 title 行钉住身份，改 H1 重导不再断链"
```

---

### Task 4: 导入预览缺省题号错位标红（P2b）

**Files:**
- Modify: `packages/contract/src/content-api.ts`（`importUnitQuestionPlanSchema` 加 `updatedDerived`；`importPreviewWarningSchema.code` 枚举加 `DERIVED_ID_UPDATED_QUESTIONS`）
- Modify: `apps/server/src/services/import-actions.ts`（`buildImportPlan` 计数与 warning）
- Modify: `apps/web/src/pages/teacher/ImportPage.tsx`（updateUnit 动作行徽标）
- Test: `apps/server/src/services/import-actions.test.ts`、`apps/web/src/pages/teacher/ImportPage.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `hasExplicitQuestionId`。
- Produces: `importUnitQuestionPlanSchema.updatedDerived: z.number().int().min(0).optional()`（本单元「文件中缺省 id 且命中库中已有 id」的题数）；warning code `DERIVED_ID_UPDATED_QUESTIONS`（message 中文，含单元名与题数、建议：导出一次拿注入 id 的文件再改，或给题容器补显式 id）。

- [ ] **Step 1: 契约先行 + 产物**

按 Interfaces 改两个 schema（注释写明「缺省 id 按位置派生，文件内插题/删题会使后续题错位更新到别的题」）。Run: `pnpm gen:spec`，产物随提交。

- [ ] **Step 2: 写失败测试（import-actions 纯函数）**

```ts
it("缺省 id 命中更新 → updatedDerived 计数 + DERIVED_ID_UPDATED_QUESTIONS 警告", () => {
  // parsed：unit u1 两题均无显式 id（id 派生 u1-1 / u1-2）；snapshot：u1 已有 u1-1、u1-2
  const plan = buildImportPlan({ parsed, folderId: null, snapshot });
  const action = plan.actions.find((a) => a.unitId === "u1");
  expect(action?.questions).toMatchObject({ inserted: 0, updated: 2, updatedDerived: 2 });
  expect(plan.warnings.some((w) => w.code === "DERIVED_ID_UPDATED_QUESTIONS")).toBe(true);
});
it("显式 id 更新 / 全新插入 / lesson 注入 id 不告警", () => {
  // 三种情形 updatedDerived 均为 0 且无该 warning
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run apps/server/src/services/import-actions.test.ts` → FAIL。

- [ ] **Step 4: 实现 `buildImportPlan`**

题目细分循环里：`updated` 判定不变，另计 `!hasExplicitQuestionId(question.sourceMd) && existing.allQuestionIds.has(question.id)` 的数量为 `updatedDerived`（仅 updateUnit 动作携带）；`updatedDerived > 0` 时 push warning（message 模板：「单元「X」有 N 道题使用缺省题号且将更新既有题：文件中插题/删题会使题号错位、学情张冠李戴；建议先导出一次（自动注入题号）再修改，或为题容器补显式 id」）。

- [ ] **Step 5: 前端徽标**

`ImportPage.tsx` 的 updateUnit 动作行：`updatedDerived` 非空且 >0 时渲染警示徽标「N 题缺省题号，可能错位」（复用既有 warning/徽标样式；中文文案；`ImportPage.test.tsx` 加一条渲染断言）。

Run: `pnpm vitest run apps/web/src/pages/teacher/ImportPage.test.tsx` → PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/contract apps/server apps/web
git commit -m "feat(import): 预览标红缺省题号错位更新风险（updatedDerived 警示）"
```

---

### Task 5: 显式替换入口 replaceLectureId——契约与服务端（P2a 核心）

**Files:**
- Modify: `packages/contract/src/content-api.ts`（`importPreviewRequestSchema` 加 `replaceLectureId`；`contentErrorCodeSchema` 加三码）
- Modify: `apps/server/src/services/content-service.ts`（`previewImport` + `commitImport`，origin/v2 版含 #40 接管段——按 `lessonSupersedeLectureIds` 锚定）
- Modify: `apps/server/src/services/import-actions.ts`（`ImportPlanInput` 加 `replaceLectureId`，讲义动作改道）
- Modify: `apps/server/src/mcp/server.ts`（`import_markdown` 基线 527、`import_zip` 基线 884 的 inputSchema 与 guard 透传）
- Test: `apps/server/src/routes/import.test.ts`（#40 接管用例同文件追加）、`apps/server/src/mcp/mcp.test.ts`

**Interfaces:**
- Produces:
  - `replaceLectureId: z.uuid().optional()`（preview 与 commit 同字段）：教师显式指认「本文档替换该讲练页/讲义」。携带时忽略该篇讲义的标题匹配，绑定目标行（id 不变、title 更新为文档标题、markdown/kind 按 导入是权威 覆盖、软删恢复）；目标所在文件夹为准（新嵌入单元落目标文件夹；请求 folderId 只管其余新资源）。
  - 错误码：`REPLACE_LECTURE_NOT_FOUND`（404，域内不存在即 404 不暴露存在性）、`REPLACE_REQUIRES_SINGLE_LECTURE`（422，文档解析讲义数 ≠ 1）、`REPLACE_TITLE_CONFLICT`（422，目标文件夹内已有**另一**讲义与文档新标题同名）。
  - 接管语义复用 #40：目标更新前 `kind='lesson'` 且本次仍 lesson → 目标 id 进 `lessonSupersedeLectureIds`（旧嵌入单元软删、挂载单元缺席题软退、预览亮 `LESSON_EMBEDDED_UNIT_SUPERSEDED` / `_QUESTIONS_SUPERSEDED`）；kind 翻转不触发（无嵌入单元可接管）。

- [ ] **Step 1: 契约先行 + 产物**

`importPreviewRequestSchema` 加字段（注释含语义与三错误码）；错误码入枚举。Run: `pnpm gen:spec`，产物随提交。

- [ ] **Step 2: 写失败测试（事故场景回归优先）**

```ts
it("改名重导 + replaceLectureId 接管同一页（PR#40 事故场景）", () => {
  const first = commitImport(db, TEACHER, lessonDoc("第 2 讲", "lec2", ["lec2-1"]));   // 旧页
  const targetId = first.lectures[0].id;
  // 教师本地文件改名：H1/单元/题号全换（"第 02 讲" / "lec02" / "lec02-1"）
  const report = commitImport(db, TEACHER, { ...lessonDoc("第 02 讲", "lec02", ["lec02-1"]),
    filename: "b.md", replaceLectureId: targetId });
  expect(report.lectures).toEqual([{ id: targetId, title: "第 02 讲", inserted: false, updated: true }]);
  // 讲义总数不变（无重复页）；旧嵌入单元软删、新单元挂载目标页；旧题软删、新题 live
});
it("replaceLectureId 目标不存在/他域 → 404 REPLACE_LECTURE_NOT_FOUND", () => {});
it("多讲义文档 / 无讲义文档 → 422 REPLACE_REQUIRES_SINGLE_LECTURE", () => {});
it("目标文件夹已有同名其他讲义 → 422 REPLACE_TITLE_CONFLICT", () => {});
it("替换后 course_items.refId 引用不动（课程目录不断链）", () => {});
it("kind=lecture 目标被 lesson 文档替换：讲义更新为 lesson，不触发接管", () => {});
it("preview 带 replaceLectureId：动作=updateLecture（新标题/目标文件夹），接管 warning 亮出", () => {});
it("MCP import_markdown：dry-run 与 confirm 均透传 replaceLectureId", () => {}); // mcp.test.ts
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run apps/server/src/routes/import.test.ts` → FAIL。

- [ ] **Step 4: 实现服务端**

`commitImport`：事务开头校验（存在性→单讲义→标题冲突）；讲义循环改道——`replaceLectureId` 命中该篇时：直接 update 目标行（markdown/kind/title/updatedAt/deletedAt:null/teachingPackJson），`lectureIdByTitle` 删目标旧 title 键、set(新 title → 目标 id)，跳过标题匹配；若旧 kind=lesson 且 lectureKind=lesson → `lessonSupersedeLectureIds.push(targetId)`（既有 #40 接管段零改动复用）；新嵌入单元的挂载经 `lectureIdByTitle` 新 title 键自然命中目标。`previewImport`/`buildImportPlan` 同口径：`ImportPlanInput` 加 `replaceLectureId`，讲义动作改 `updateLecture`（title=文档标题、folderName=目标文件夹、restore=目标软删），#40 的嵌入单元 supersede 预览判定从「同名命中」扩为「同名命中或显式目标」。MCP 两工具 inputSchema 加 `replaceLectureId: z.string().uuid().optional().describe("显式替换目标讲练页 id：绑定该页更新（改名重导不断链），旧嵌入单元接管软删")` 并透传。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run apps/server/src/routes/import.test.ts apps/server/src/mcp/mcp.test.ts` → PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/contract apps/server
git commit -m "feat(import): 显式替换入口 replaceLectureId——改名重导绑定既有讲练页，接管复用 #40"
```

---

### Task 6: ImportPage UI 指认（P2a 前端）

**Files:**
- Modify: `apps/web/src/pages/teacher/ImportPage.tsx`（单文件流程预览区）
- Test: `apps/web/src/pages/teacher/ImportPage.test.tsx`

**Interfaces:**
- Consumes: Task 5 契约字段（hc 客户端类型自动携带）；讲练页候选列表用现有 `GET /api/teacher/library/lectures`（[library.ts:149](../../../apps/server/src/routes/library.ts)），前端过滤 `kind === "lesson"`。

- [ ] **Step 1: 写失败测试**

```tsx
it("lesson 文档新建讲练页时提供「替换既有讲练页」指认；选中后 commit 带 replaceLectureId 且有确认提示", async () => {
  // 预览 mock：kind=lesson、actions=[createLecture]；library/lectures mock 两页
  // 1) 渲染出选择器（列出候选：标题/文件夹/更新时间）
  // 2) 选中 + 提交：断言 commit 请求体含 replaceLectureId
  // 3) 提交前出现后果确认文案：「将替换所选讲练页：旧随堂练习进回收站、已交卷与进行中作答不受影响、课程目录引用保留」
});
it("非 lesson 文档或已命中更新（updateLecture）时不显示选择器", () => {});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/web/src/pages/teacher/ImportPage.test.tsx` → FAIL。

- [ ] **Step 3: 实现**

预览结果 `kind==='lesson'` 且动作含 `createLecture` 时渲染折叠选择器（shadcn Select + 触控目标 ≥44px）；选中即带 `replaceLectureId` 重新 preview（预览动作变为 updateLecture 并显示接管 warning）；commit 复用同值；提交前用既有确认对话框形态展示后果文案（上条测试内文案）。批量导入流程不提供指认（本任务范围外，UI 不入口）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/web/src/pages/teacher/ImportPage.test.tsx` → PASS。

- [ ] **Step 5: 文档同步 + 提交**

[docs/页面功能清单.md](../../页面功能清单.md) 导入节补「替换既有讲练页」条目；[docs/约定/学生作答与讲练.md](../../约定/学生作答与讲练.md) 讲练页约定补一行：改名重导走显式替换入口（`replaceLectureId` / UI 指认），批量无意图重导暂不支持（持久映射表/docId 立项另议）。

```bash
git add apps/web docs
git commit -m "feat(import): 导入页讲练页替换指认——改名重导显式绑定目标页"
```

---

### Task 7: 质量闸门与收尾

**Files:**
- Modify: 按 simplify/code-review 结论（预期小量）
- 全分支 diff 审查

- [ ] **Step 1: 选测与静态检查**

Run: `pnpm test:affected && pnpm e2e:affected && pnpm typecheck:affected && pnpm lint:changed`
Expected: 全绿（选测脚本把契约/导入基建变动升级为全量时按其决策执行，不手动绕过）。

- [ ] **Step 2: 质量闸门**

按序执行 `/simplify`、`/code-review`（全分支 diff）；确认问题当场修复。安全审查说明：本批全部教师域接口与数据（回写只进 `lectures.markdown`，替换入口与预览均为教师域），不触学生载荷与答案投影边界，无新增泄露面——在 PR 描述记一行。

- [ ] **Step 3: PR 与合并**

`gh pr create --base v2`（描述列手动验证方法：改名重导替换、嵌入题编辑后学生端讲练页即时生效、导出→改 H1→重导命中同页）；全绿后按用户惯例合并 v2（推送走代理、由用户拍板；绝不 →main）。

- [ ] **Step 4: 人工验证项清单（PR 描述列出）**

① 真机 iPad 讲练页：嵌入题在题库改错别字后，讲练页题面即时更新（非进行中卷）；② 改名整批重导 + UI 指认替换，课程目录引用不丢；③ 导出讲练页→本地改 H1→重导，命中同页且题号稳定；④ 预览徽标在真实缺省题号练习文件上出现且不误报。

---

## Self-Review 记录

- 覆盖检查：P1a=Task 1+2、P1b=Task 3、P2b=Task 4、P2a=Task 5+6、闸门=Task 7；分析结论中「不做」（documents 表、指纹当 ID、批量替换、docId）未立项并在 Task 6 Step 5 记录去向。✔
- 步骤粒度：每步一个可核查动作；测试先行；无 TBD。✔
- 类型一致：`withQuestionId`/`hasExplicitQuestionId`/`replaceLessonQuestionBlock`/`lessonSynced`/`updatedDerived`/`replaceLectureId` 及三错误码在任务间名称一致。✔
- Review Focus 五条均有归属任务测试。✔
- 比例：计划与改动量相当，无实现转写。✔
