# 12-simplify web 修复（/simplify 质量闸门 · web 域 9 项）

- 分支：`feat/lesson-interleaved`（基线 33b16c1）
- 范围：只做四角清理审查列出的 web 修复项，行为零变化；未触碰 apps/server、packages/*（`pnpm format` 顺带改到的两个仓库既有漂移文件 `apps/web/src/pages/admin/AdminSharedFilesPage.tsx`、`packages/contract/src/attempt.test.ts` 已还原）。
- 提交：be1540f（修复 1）→ ee3934f（修复 3）→ 8ec59d5（修复 2）→ 928d426（修复 4）→ daee1f8（修复 5+8）→ b74a1d9（修复 6+7）→ 17ff9a5（修复 9+10）→ 74e847b（收尾格式化）。

## 验证输出（全量）

- `pnpm vitest run apps/web`：**Test Files 195 passed / Tests 1822 passed**（既有断言零修改；例外见修复 5——夹具对齐）。
- `pnpm typecheck`（e2e + 全 workspace）：**Done / 无错误**。
- `pnpm lint`：本次触及的全部目录 biome check 干净；仓库**存量**失败在 `apps/web/src/features/ink/lab/*.test.ts`（noNonNullAssertion，来自早前提交 344e2d2，非本单改动，未越界处理）。

## 逐项记录

### 1. 判定徽章单源 ✅
- AttemptResultView 吸收零消费死导出 VerdictIcon/verdictLabel，导出组合组件 `VerdictBadge`（图标+文案+配色单一出处）。`pendingLabel` 覆盖待批文案（讲练页传「待老师批改」，消除与「待批改」的漂移）；`toned` 开关控制文字配色——两页徽章现状本就不同（结果视图文字继承前景色、讲练页文字带判定色），零视觉变化只能参数化而不是硬统一。
- LessonQuestionCard 删除自写 verdictBadge/VerdictBadge 改消费；Question.tsx 的 QUESTION_TYPE_LABELS 零外部消费，还原私有（去掉 export）。

### 2. 证据确认状态机单源 ✅
- 新建 `features/attempt/use-submit-evidence-confirm.ts`：phase 判别联合、open 快览（**代际守卫**）、确认流程骨架（注入 `run(ctx) => Outcome`）、**缺稿确认并集累积**、`evidenceProblemViewsOf` 题号映射（两页逐字同构的 noteProblems 拼装）。
- AttemptSession：六步编排保留原文成为注入的 `runSubmit`——abort 检查、ink 并行、错误时 `ctx.clearMissingConfirmed()`（原清空确认集语义）、两段 busy（`ctx.enterSubmitting()`）差异语义全部原样保留；`submit.mutate` 包成 Promise 以返回结果（onSettled 收尾与 hook 的 submitted 分支等价）。openSubmitDialog 保留编辑器守卫并**复位 abort 标志**（原实现细节，勿丢）。
- StudentLessonPage：`runFinish` 只翻译 `session.finish` 结果；讲练收尾链不 clearMissingConfirmed 的差异语义保留（注释写明）。
- 新增 hook 单测 10 例钉住微妙语义。**发现并原样保留一个事实**：两页 error 分支的 `prev.kind === "choice"` 三元在真实流恒为 false（confirm 首句已迁 preparing）——problems 快照实际不保留，hook 逐字保留该三元，测试按真实行为断言。
- 六步编排两份（单题 overlay、evidence 仅未提交题 vs 整卷并行 ink+abort）有实质差异，按方案**不强制合并**；settleDrafts/prepEvidence 是 use-lesson-attempt 文件内单源且错误文案与 AnswerView 内联链不同（「答案尚未保存…」vs「草稿状态获取失败…」），跨文件参数化一个 5 行 helper 属无收益扰动，**不提取**。

### 3. 交卷弹层单源 ✅（选**退路**）
- **未选参数化主路**：逐项比对后，SubmitConfirmDialog 服务讲练页需新增约 9 个文案/行为 props（标题、双态描述、警示头/尾注、按钮词、busy 提示、aria-describedby id、限高 class），参数化后组件成空壳且文案仍两处漂移，代价大于收益。
- 提取两处**逐字复刻**为共享导出（均在 SubmitConfirmDialog.tsx，讲练卡已 import 该模块）：`busyCloseGuard(busy)`（Esc/遮罩/外点三件套，与 closeDisabled 同纪律）与 `DraftProblemAlert`（destructive 描边警示块容器，标题/正文/尾注由调用方给定）。两弹层消费，DOM 与文案逐字一致（含讲练页尾注跨行折叠出的空格）。

### 4. SOURCE 徽章与讲练徽标单源 ✅
- 新建 `components/source-badge.tsx` 导出 `SOURCE_LABELS` / `SOURCE_BADGE_CLASS` / `SourceBadge` / `LessonBadge`。**位置取舍**：审查建议的 features/shared 实为「共享目录」文件域（SharedPreviewSheet 等），不混放；师生两端共用的展示词表放 components/（ErrorRetry 同层先例），且库内已有 teacher 消费 features/attempt 词表（answer-format）的跨域先例。
- 三处平行词表（records-views / attempt-views / PendingMarkQueuePage）删除改消费；RecordSourceBadge 并入 SourceBadge（消费方 wrong-questions-ui 同步改）。emerald 讲练徽标四处逐字复制（AddFromLibrarySheet / StudentCourseDetailPage / StudentLecturesPage / LibraryPage）收敛为 LessonBadge（= SourceBadge lesson 形态，class 串原样搬）。

### 5. 死嗅探删除 ✅
- SharedPreviewSheet 删 isLessonDocument（手写 frontmatter 嗅探），改 `file.kind === "lesson"`（服务端同一规则已算好）。**测试处理**：既有测试是组件行为级（非函数专属），断言零修改；仅夹具 `FILE.kind` 与场景对齐（原先 kind:"lecture" 与 markdown `kind: lesson` 自相矛盾，恰是嗅探实现的产物）——lesson 用例传 kind:"lesson"，mixed 用例保持 lecture 断言不变。

### 6. 题序 Map 化 ✅
- `orderedQuestionsOf` 升级为 `lessonQuestionOrder(data)`：`{ordered（含 index）, byId}` 一次算好，父组件 useMemo 后传 LessonBody（消灭「LessonBody 与父组件各算一遍」）；题槽渲染统一 `order.byId.get`（消灭循环内 `data.questions.find` 的 O(n²) 与两处 `as` 断言）；父组件 1 起题号映射改由 byId 派生。

### 7. memo 修复（热路径）✅
- 模块级 `EMPTY_HINTS` 常量（`hints={… ?? EMPTY_HINTS}`）+ 两视图 `useCallback` 包 onRefresh：LessonQuestionCard 的 memo 不再因每次渲染的新数组/内联箭头恒失效。LessonQuestionCard 其余 props 引用稳定性复核通过（handlers 由 use-lesson-attempt useMemo 稳定、question/answer/released 按题）。修复过程中发现并纠正：useCallback 不得放在「attempt 离开 draft 提前 return」之后（最后一题提交触发视图切换时钩子数变化会崩，测试抓出后已移位）。

### 8. 讲练路由单源 ✅
- 新建 `features/student/lesson-navigation.ts` 导出 `lessonHref(lectureId, courseId?)`（惯例同 record-review-navigation——学生端路由 helper 就近收在 features/student）。四处拼接（讲义列表私有 lessonHref / 课程目录 inline / 阅读页 Navigate / 交卷返回目标）全部收口消费。StudentCourseDetailPage 的 `item.refId` 类型上可空（superRefine 不变式锁但 TS 不知），传参用 `String(item.refId)` 保持与原模板串逐字一致。

### 9. 来源行文案单源 ✅
- 学生端：answer-format 新增 `attemptSourceLabel`（与 attemptRoundLabel 同居——来源文案的既有家）；AttemptSession 私有 sourceLabel 与 AttemptResultView 内联三元两份同文实现合并，消费同一函数。新增 4 断言钉四来源文案。
- 教师端：`sourceLineOf` 移入 attempt-views 导出、AttemptDetailPage 改消费。**说明**：sourceContextOf（列表卡）与 sourceLineOf（详情头）输出本就不同口径（course：`课程名 · 单元 · 第 n 次` vs `课程：课程名 · 第 n 次`），文案零变化约束下不能合成一个函数；收口为两函数同居 attempt-views 单一模块（教师端来源文案一处可查）。

### 10. 桌面断言/滚动单源 ✅（selector 部分收敛 + 共享件全提取）
- `scrollToHeading` 提升为 `use-lecture-section-focus.ts` 的 `scrollToHeadingAt(selector, index)`（滚动/聚焦/reduced-motion 行为两页逐字同构）；matchMedia 三件套收口 `lib/use-desktop-viewport.ts`（`useDesktopViewport()`，与 use-online-status 同层惯例）；两页本地副本全删。
- **selector 取舍（未直接复用 LECTURE_HEADING_SELECTOR）**：两选择器语义**不同**——讲练目录必须限定 `[data-lesson-md]`，因为题干/选项同样经 `.rich-markdown` 管线渲染，题干内 h2/h3 不得进目录（页面注释明确的既有不变量，直接换共享选择器会让目录条目与滚动目标错位）。修法改为：`LESSON_HEADING_SELECTOR` 与 `LECTURE_HEADING_SELECTOR` **同居 use-lecture-section-focus 一个模块**（附注释说明差异原因），单一出处可查、防漂移；滚动函数参数化选择器共用。

## 未做项 / 跳过原因汇总
- 修复 3 主路（SubmitConfirmDialog 全量参数化）——见上，选退路。
- 修复 2 的六步编排合并与 settleDrafts/prepEvidence 提取——方案明示不强制；错误文案语义不同，提取无收益。
- 修复 9 教师端两函数合一——文案不同口径，零变化约束下不可合，改同模块收口。
- 修复 10 讲练页直接复用 LECTURE_HEADING_SELECTOR——会破坏「题干标题不进目录」不变量，改同居一模块 + 参数化滚动函数。
- ink/lab 存量 lint 失败——非本单范围。
