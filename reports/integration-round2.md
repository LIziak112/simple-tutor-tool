# 二轮同步冲突解决与语义收敛报告（v2 answered/student_flag × QM 体系）

日期：2026-10-26　分支：codex/qm（worktree stt-qm-main）　合并对象：origin/v2 @0eedd61d（21 提交）

## 一、冲突文件数与解法分布（25 个）

| 解法 | 文件 | 说明 |
| --- | --- | --- |
| 迁移正主（裁定 3） | migrations/_journal.json、meta/0044_snapshot.json、0044_true_groot.sql（rm） | `git checkout origin/v2 -- migrations` + rm 我方 0044，QM 五表重生 0046 |
| 字段并集（契约） | attempt.ts、student-records-api.ts、teacher-attempt-api.ts | answered/studentFlag 入结果单题与教师详情；selfReview 恒取 QM 形态（record+revision+gradingPolicy），弃 v2 selfReviewStateSchema；wrong/pending/autoGradable 注释与口径取 QM 有效判定，notDoneCount 新增（wrongCount 子集） |
| 语义融合（服务） | attempt-service、lesson-service、mark-response、student-records、teacher-attempt-service、wrong-questions | 详见下节 |
| 取 ours（v2 旧自评线废弃） | student-practice-question-submit.test.ts（整块删）、SelfReviewControl.test.tsx（git rm）、mark-response 冲突段 | §22.1 已裁定废弃；mark-response 取登记表路径，empty→null 后置收编（见下） |
| 取 ours + 并集 props | AttemptQuestionCard、AttemptSession（大段结构冲突取 ours segments，unsure props 接入 renderRow） | theirs 侧引用已删字段（question.canSubmitQuestion/referenceAvailable）不带走 |
| UI 融合 | AttemptResultView、QuestionFeedback、LessonQuestionCard、AttemptDetailQuestionCard、AttemptDetailPage、result-review-model、records-views.test、api.ts | verdictBadgeDisplayOf 扩 notDone 维度（三面单源）；错题圈题 = 有效判定错 ∧（答了∨显式判定）∨ 标不会 |
| 占位再生 | dsl-kit/tutor-lint.mjs | gen:spec 后 content.json/docs 零 diff（注册表未变），.mjs 系本机 esbuild 环境漂移、checkout 恢复零提交 |
| 并集 | .gitignore | .vitest/ + /core |

## 二、迁移 0046 校验

`pnpm db:generate` 重生 **0046_clumsy_doctor_strange**：5 CREATE TABLE（materials、question_groups、question_group_members、material_refs、attempt_context_snapshots）+ 6 ALTER（questions.material_refs_json、responses.grading_policy + self_review_* 四列）；**零 DROP、零 answered/student_flag 变更**（v2 0044/0045 为正主）。二次 db:generate 幂等（No schema changes）。migrate-qm.test.ts 边界 PRE_QM_TABLES_TAG=0039 不变、注释 0044→0046；backfill 排除清单 theirs 侧已自带（t6980_3_answered_backfill）。

## 三、语义融合要点

1. **两维度正交**：answered=「答了」（responses.answered 列，判分写点落库，含正式笔迹/单题提交口径）；判定恒走 effectiveVerdictOfRow（教师判>自评>自动）。scoreSummaryCoreOf/scoreSummaryOf 的 answered 计数改读 row.answered，correct/wrong/pending 不变；web reviewCounts 恢复「未答行同时进判定桶」（瓦片=服务端 summary=徽章不漂移）。
2. **错题本 enteredWrongBook 单一出处**：有效判错 ∧（answered ∨ teacherMark ∨ 自评 verdict）∨ studentFlag=unsure；攻克/resolved/notDone 同口径（做对∧答了∧未标不会）；wrongCount 只计「答了且判错」轮（显式判定不掩盖）。latestJudgedResponsesByQuestion 复用同谓词。
3. **result-counts QM 化**：判对 SQL 化有效判定（verdict/at 成对判脏行），pendingCount 复用 notSelfReviewPendingRow、待自评与 pendingSelfReviewCounts 同语义，**弃 review_eligible 列读取**（§22 review_* 不读写）。教师详情 correctCount/wrongCount=有效判定（含未做），notDoneCount 单列灰显子集。
4. **isUnanswered 委托 dispatchIsAnswered**（I16 单源，新题型自动覆盖；judge 旧空串写法算未做收编进登记表 isAnswered）；serializeStudentAnswer 的 empty→null（#6980-3）收编进契约 answer-kinds 登记表（teacher-queue/ai-context 空结构 null，差分基准与原型锁同步）。
5. **防泄露**：studentFlags 仅 draft 本人事实（无答案内容）；answered/studentFlag 不受公布 gate 影响但不含对错；结果单题判定键仍走 releaseAwareQuestion null 投影；student-flags.test.ts 泄露测试绿。

## 四、合并后提交（merge 之后小步修）

- a8cd10fe merge（25 冲突收口）
- 0046 迁移重生 + migrate-qm 注释（`db(qm)`）
- ad9c25a1 result-counts QM 化 + answer-kinds 空→null 收编
- test 口径对齐批（服务端 wrong/wrongCount 按 QM；reviewCounts 两维度正交；QM 种子补 answered:true）
- isUnanswered 委托登记表 + display null 兜底 + biome 收口

## 五、终验

- 单测：node 工程 3806/3806、web 工程 2815/2815（全量）；migrate-qm+backfill+client 定向 44/44
- typecheck 五包全绿；lint:changed 全绿（biome 全量 1360 文件零告警）
- db:generate 幂等 ✓；gen:spec content.json/docs 零 diff ✓
- e2e:affected（chromium）：134 passed / 2 failed→**隔离复跑均绿**（annotation-native-surface:13 4.6s、student-workspace 130 题 51.3s——满载并发时序抖动，非合并回归）
- 挂例判定：两例均「隔离复跑通过」，判定为负载 flake

## 六、遗留

- webkit/双浏览器全量 e2e 与 PR CI 全量归 PR #13 闸门（本机不跑）
- gen:spec 的 tutor-lint.mjs 环境漂移维持「checkout 恢复零提交」惯例（CI 侧 esbuild 自证）
