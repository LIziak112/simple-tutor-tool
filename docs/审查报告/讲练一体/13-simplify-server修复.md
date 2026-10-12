# 13-simplify server 修复（/simplify 质量闸门 · server 域 7 项）

- 分支：`feat/lesson-interleaved`（基线 8721779，即 12-simplify web 修复报告提交）
- 范围：只做四角清理审查列出的 server 修复项，行为零变化；未触碰 apps/web、packages/md-dsl、packages/contract（契约与解析器在下一单）；判分与收尾语义零变化。
- 提交：ce5f01e（修复 1+2）→ 35bfbdf（修复 3+4）→ cb5a0dc（修复 5）→ d154183（修复 6+7）。

## 验证输出（全量）

- `pnpm vitest run apps/server`：**Test Files 86 passed (86) / Tests 1378 passed (1378)**——与修复前基线完全一致，既有断言零修改。
- `pnpm typecheck`（全 workspace：contract/grading/md-dsl/server/web）：**全部 Done、无错误**。
- `npx biome check apps/server/src/services/`：干净（修复 6+7 的一处 import 换行已按 formatter 落盘）。

## 逐项记录

### 1. 单题提交全量回读（热路径）✅
- submitLessonQuestion 事务闭包带出收尾判定的瘦行集（`return rowsAfter`；select 补 `answerJson` 列供 summary 的 answered 计数），事务后 `lessonLiveSummaryOf` 直接消费——不再 `attemptResponseRows` 整卷全列回读（每题数 KB questionSnapshotJson）。
- 提交结果行改为按主键 `eq(responses.id, row.id)` 取一行（快照复用事务前已 parse 的同一份）；防御性 500 兜底与 attempt 行回读保持原样。
- `lessonLiveSummaryOf` 入参从 `readonly ResponseRow[]` 收窄为 5 列结构裁剪（私有 `LessonSummaryRow` = Pick<questionSnapshotJson/answerJson/submittedAt/autoCorrect/finalCorrect>）——开卷链路（lesson-service 传完整行）结构兼容，零调用方改动。
- **取舍**：三选一里选「事务闭包带出 + 主键取行」；备选「summary 查询瘦列 + WHERE questionSnapshotJson IS NOT NULL」会把 D4 式谓词复制一份（且 summary 跳缺失行的口径与收尾判定的 gradable 过滤是同一逻辑，分开设查询反而漂移），弃。

### 2. studentStemMd 投影包装三份 ✅
- attempt-service 新增导出 `studentFacingResultOf(item)`（resultQuestionOf 旁）：`{ ...item, snapshot: { ...item.snapshot, stemMd: studentStemMd(item.snapshot) } }`——防泄露不变式的唯一包装处。
- 三处收敛：buildResultData 的 releaseAwareQuestion、submitLessonQuestion 响应（`studentFacingResultOf(resultQuestionOf(...))`）、lesson-service 的 released 条目（后者删去 studentStemMd 直接依赖，import 指向 helper）。
- resultQuestionOf 头注释改为指向 studentFacingResultOf（「学生端消费方一律先经 studentFacingResultOf 整题投影（唯一包装处）」）。三处原先传给 studentStemMd 的实参形态不同（完整 Question vs 投影后 snapshot），但 StudentStemInput 只读 stemMd + options 存在性，投影前后语义恒等。

### 3. pendingWhere 两函数平行 ✅
- pending-mark.ts 新增私有 `pendingMarkConditions(draft)`（返回 `(SQL | undefined)[]`：finalCorrect IS NULL + questionSnapshotJson 非空 + draft 批次叠加 submittedAt 非空），`pendingMarkCount`（单卷 eq）/`pendingMarkCounts`（批量 inArray）各自拼归属条件后展开同一构造器；两份行内注释口径合并进构造器注释，生成的 SQL 形状零变化。

### 4. submittedAt patch 两处展开 ✅
- submitAttempt 事务前算一次 `lessonSubmittedAtPatch = isLesson ? { submittedAt: nowIso } : {}`；事务内 update set 与结果视图内存镜像展开同一引用，口径注释随之单源化。

### 5. 导出端 sourceType 标签单源 ✅
- export-csv.ts 新增导出 `SOURCE_TYPE_TEXT: Record<AttemptSource, string>`（course=课程练习 / wrong=错题重练 / lesson=讲练 / assignment=作业）；CSV「来源类型」列与 export-service 材料整理包汇总行的来源列两份嵌套三元链改查表消费。**位置**：export-service 本就 import 自 export-csv（beijingDateTimeOf 等），常量放 export-csv 零新增依赖方向。文案零变化（Record 覆盖全部四个枚举值）。

### 6. lesson 来源上下文单源 ✅
- attempt-service 新增导出 `lessonSourceContextOf(db, attempt, teacherId)`：讲义标题 → 嵌入单元标题（teacherId 域内、讲义行异常缺失时才查）→ attempt.unitId →「讲练练习」的标题链 + 课程名（courseId 可空 → null）。学生侧 attemptSourceMeta lesson 分支（teacherId 取 attemptTeacherId 推导）与教师侧 teacher-attempt-service.sourceOf lesson 分支（调用方既有 teacherId）两份实现收敛；teacher-attempt-service 由此删去 lectures 表依赖与整段手写查询。
- **兜底口径**：按审查取教师侧三级链为准（更完备）。学生侧正常链路（讲义行存在）文案不变；唯一差异在讲义行异常缺失的病态场景——原学生侧直接落「讲练练习」，现随三级链先尝试嵌入单元标题/attempt.unitId（与教师侧口径一致，讲练页讲义行正常链路不可缺失，属防御分支统一）。学生侧原先读整行 course 只取 title，收敛后改 select 瘦列，值恒等。

### 7. 404 文案第三份 ✅（按指示收敛 lesson-service 一处）
- student-course-service 的私有 `notFound` 加导出（注释注明 lesson-service 复用），lesson-service 删私有 `lessonNotFound` 改 `throw notFound()`——「没有找到该内容（可能尚未发布或已被移除）」两份副本合一。
- **注明**：course-service.ts 的 `courseItemNotFound`（私有函数，非字面内联）是同文案第三处，按任务指示本次不强改——它在教师域模块，跨域 import student-course-service 的学生侧 404 语义不妥，留待后续如需再单源化。

## 未做项 / 边界说明汇总
- 修复 7 的 course-service 第三处——任务明示不强改，报告注明（见上）。
- 修复 6 学生侧兜底链在病态场景（讲义行缺失）随教师侧三级链统一——审查既定口径（「兜底口径取 teacher-attempt-service 的三级链为准」），正常链路学生侧文案零变化。
- 修复 1 备选形态（summary 瘦列查询 + WHERE 快照非空）——会复制谓词，弃（见逐项 1）。
