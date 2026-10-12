# 14-simplify 解析器与契约修复（/simplify 质量闸门 · 跨 md-dsl/contract/server 3 项）

- 分支：`feat/lesson-interleaved`（基线 4a32b33，即 13-simplify server 修复的 import 排序收尾提交）
- 范围：闸门四角清理审查列出的最后 3 项（死载荷删除 / 兜底 id 单源 / 切分选项判别联合）；除第 1 项明确删除的死字段外行为零变化；未触碰 web/server 域已完成的闸门修复，samples 与既有样例零改动。
- 提交：9731d6c（修复 1）→ 74a08f3（修复 2）→ b370d7b（修复 3）→ fd8709d（gen:spec 产物同步）。

## 验证输出（全量）

- `pnpm vitest run packages/md-dsl packages/contract apps/server apps/web`（四包全量）：**Test Files 341 passed (341) / Tests 4105 passed (4105)**。
- `pnpm typecheck`（全 workspace：contract/grading/md-dsl/server/web）：**全部 Done、无错误**。
- `pnpm schema:export`：重跑后 git status 产物零变化——`studentLectureDetailSchema` 不在导出集（content.json 只收 content.ts 六个内容契约 + learning-pack/review-pack 三件），**零漂移符合预期**。
- `pnpm gen:spec` 二跑：第一跑重打包 `dsl-kit/tutor-lint.mjs`（81 行增删，见提交 fd8709d——tutor-lint 单文件 bundle 内联解析器代码，修复 2+3 的解析器重构须随源码再生成并提交，CI 校验 gen:spec 后 diff 为空）；提交后第二跑 git status **干净**，规范三件套与 content.json 零变化。

## 逐项记录

### 1. 删除学生讲义详情死载荷 blocks ✅（契约变更，本分支未发布）

- **核实**：GET /api/student/lectures/:id 的 lesson 分支计算 `splitLessonBlocks(row.markdown)` 随 `blocks` 下发，但唯一消费方 `StudentLectureViewPage` 对 kind=lesson 拿到即 `<Navigate>` 重定向讲练页（不读 blocks）；讲练页的 blocks 来自 `lesson/start`（lesson-service）。`grep \.blocks\b` 全仓核实 detail 接口的 blocks 零消费（web 端 blocks 引用全部指向 LessonStartData / lesson/start）。
- **契约**（content-api.ts `studentLectureDetailSchema`）：删 `blocks` 字段（连带删 `lessonBlockSchema` import）与「kind=lesson 必带 blocks」「kind=lecture 不得携带 blocks」两条 superRefine 不变式；**保留** markdown 恒 null（lesson）/恒非空（lecture）、companionUnits 恒空（lesson）等防泄露不变式——一条不动。
- **服务端**（student-course-service.ts）：lesson 分支删切段调用与 `@tutor/md-dsl` 依赖导入（该文件不再依赖 md-dsl）；注释改为「讲练内容只经 lesson/start 开卷接口下发」。
- **测试同步**：content-api.test.ts 三处（lesson 详情/交叉不变式/lecture 形态不变）删 blocks 载荷与断言；student-lesson.test.ts 详情用例删 blocks 切段断言、**新增 `"blocks" in body.data === false` 钉死删除**；StudentLectureViewPage.test.tsx 重定向用例的 mock 删 blocks（否则契约类型 excess property 报错）。
- **历史文档**：docs/审查报告/ 既有报告是历史记录不改；架构文档无 blocks 表述（grep 零命中）。

### 2. 切段兜底 id 单源 defaultQuestionIdOf ✅

- question.ts 导出 `defaultQuestionIdOf(unitId, ordinal)`（`单元id-序号`，注释写明解析器与切段两侧共用 + 占号语义）；`extractQuestion` 缺省 id 改调它。
- split-lesson.ts 无 id 题块兜底改调同一函数（warning 文案与 `questionId` 同用一次计算的 `fallbackId`——原先两处内联同一模板串）；文件头注释与 options 注释指向单一出处。
- 行为零变化：模板串逐字符相同；split-lesson.test.ts 兜底用例与「parse → 讲义 markdown → 切段对位」闭环用例全绿钉死两侧同号。

### 3. splitLectures options 判别联合 ✅

- `LectureSplitOptions` 改判别联合：共有字段（children/lines/contentStartLine/issues）收进 `LectureSplitOptionsCommon`；`Strip`（`mode:"strip"` + `questionRanges`）| `Keep`（`mode:"keep"` + **必传** questionNodes/questions）。原「keep 模式必传」靠注释约束的可选字段改为类型强制；`LectureSplitMode` 类型随之无引用删除。
- **questionRanges 在 keep 分支的去向**：现实现里 keep 模式仍用它做 H1 前正文检测的排除区间（`firstContentLine`），原接口注释本就写明「keep 模式按 questionNodes 派生」——故 keep 分支改为内部 `questionNodes.map(lineRange)` 派生（与原调用方传值逐值相等），调用方不再传死参数且**行为零变化**（lesson 文档题块在首个 H1 前时不误报 CONTENT_BEFORE_FIRST_HEADING，parse.test.ts 该用例全绿）。
- `injectQuestionFenceIds` 入参收窄为 Keep 变体，内部两处 `?? []` / `!== undefined` 防御分支随类型强制删除。
- parse.ts 三个调用点：lecture/mixed 显式 `mode:"strip"`，lesson 不再传 `questionRanges`。

## 未做项 / 边界说明汇总

- 修复 1 中 contract 的 `lessonBlockSchema` 本体未删——`lesson/start` 响应契约（lesson-api.ts）仍是其消费方，只删 detail 侧引用。
- gen:spec 产物同步单列一个提交（fd8709d）而非并入修复 2/3：tutor-lint.mjs 是构建产物，单列便于回溯「哪次源码改动触发了重打包」；任务预期「本单不触 gen 产物」实测不成立（解析器源码内联进 bundle），已按仓库规则补交。
