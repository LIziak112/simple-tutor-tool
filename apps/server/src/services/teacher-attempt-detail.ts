import type {
  TeacherAttemptDetailData,
  TeacherAttemptDetailQuestion,
} from "@tutor/contract";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Attempt,
  questions,
  type ResponseRow,
  responses,
} from "../db/schema.ts";
import { hasUsableQuestionSnapshotSql } from "./attempt-final-outcome.ts";
import {
  attemptResponseRows,
  effectiveVerdictOfRow,
  ensureAttemptFrozen,
  materialSlotOrderOf,
  unitGroupedRows,
} from "./attempt-service.ts";
import { attemptTimeOf, timeProjectionsOf } from "./attempt-time-projection.ts";
import { readKernelAttemptFacts } from "./kernel-assignment-facts.ts";
import { isKernelAttempt } from "./kernel-assignment-routing.ts";
import { kernelAttemptUnavailable } from "./kernel-assignment-runtime.ts";
import { pendingMarkCount, pendingSelfReviewCounts } from "./pending-mark.ts";
import { countsAsWrong } from "./response-verdict.ts";
import { attemptResultCounts } from "./result-counts.ts";
import { reviewEvidenceReader } from "./review-evidence.ts";
import { snapshotOfRow } from "./snapshot.ts";
import { detailItemOf } from "./teacher-attempt-detail-item.ts";
import {
  inkByQuestionOf,
  inkInfoOf,
  requireTeacherAttempt,
  sourceOf,
  unitTitleByIdOf,
} from "./teacher-attempt-service.ts";

/**
 * Web-3 / T-PR3 行级放行谓词（teacherVisibleResponsesWhere 的行级读法，同一口径）：
 * draft 卷内学生已逐题提交（submitted_at 非空）的行按已交卷投影（判定 + 参考
 * 答案 + 笔迹）；未提交行维持 D5 draft 口径；作废卷（abandonedAt 非空）整卷
 * 不放行。非 draft 卷恒放行（判定下发本就不受 D5 约束）。
 */
function rowVisibleInDraftOf(attempt: Attempt) {
  const draftOpen = attempt.status === "draft" && attempt.abandonedAt === null;
  return (submittedAt: string | null): boolean =>
    attempt.status !== "draft" || (draftOpen && submittedAt !== null);
}

/**
 * 教师端作答详情（D7 全字段；draft 亦可用，D5；T6R.3 起三来源统一读冻结行）：
 * - draft：题目取该 attempt 的冻结快照行（与学生草稿视图同源——懒冻结兜底
 *   升级遗留草稿；教师改题库不影响学生当前这卷，教师看到的即学生看到的），
 *   题干经 studentStemMd 学生端投影（详情不下发参考答案，题干标记里的答案与
 *   [x] 正确项同样不外露）；未提交行判定字段 null（判定列显示「未交卷」；
 *   Web-3/T-PR3 行级放行：已逐题提交的行按已交卷投影，见 rowVisibleInDraftOf）；
 *   未放行行 answers / solutionMd 字段缺省不发；快照缺失的历史行按「历史题目
 *   缺失」跳过；
 * - submitted / graded：逐题取 responses 冻结行（快照题干原文含 [[答案]] 标记、
 *   参考答案与详解照常下发——教师端不受泄露约束，改判与待批卡片都要用）；
 *   分组与排序经 unitGroupedRows 从冻结行自身重建（与学生结果视图同一实现；
 *   升级前已交卷的遗留行沿用域内 join 口径，questions 行缺失的响应行进末尾
 *   兜底组不丢弃——修正旧 inner join 直接丢行的行为）；
 * - 手写信息：ink 表 (attemptId, questionId) 关联（draft 也可能有笔迹无行）；
 * - 全卷连续题号：attempt 单元顺序 × 题目顺序，1 起；
 * - 计数：有效判定口径（教师判 > 自评 > 自动）；draft 全 0。
 */
export function getTeacherAttemptDetail(
  db: Db,
  teacherId: string,
  attemptId: string,
  dataDir?: string,
): TeacherAttemptDetailData {
  const owned = requireTeacherAttempt(db, teacherId, attemptId);
  if (!isKernelAttempt(db, owned.attempt))
    return detailOf(
      db,
      teacherId,
      owned.studentName,
      ensureAttemptFrozen(db, owned.attempt),
    );
  if (dataDir === undefined) kernelAttemptUnavailable();

  return db.$client
    .transaction(() => {
      const { attempt, studentName } = requireTeacherAttempt(
        db,
        teacherId,
        attemptId,
      );
      const facts = readKernelAttemptFacts(db, dataDir, attempt);
      return detailOf(db, teacherId, studentName, facts.attempt, facts.rows);
    })
    .immediate();
}

function detailOf(
  db: Db,
  teacherId: string,
  studentName: string,
  attempt: Attempt,
  kernelRows?: readonly ResponseRow[],
): TeacherAttemptDetailData {
  const attemptId = attempt.id;
  // Web-3 / T-PR3：draft 卷内已逐题提交（submitted_at 非空）的行放行判定、
  // 参考答案与笔迹；未提交行维持 D5 draft 口径；作废卷整卷不放行
  const draftRowVisible = rowVisibleInDraftOf(attempt);
  const source = sourceOf(db, attempt, teacherId);
  const inkByQuestion = inkByQuestionOf(db, attemptId);
  const materialSlots = materialSlotOrderOf(db, attemptId);
  const evidenceOf = reviewEvidenceReader(db, attemptId);

  // 逐题条目（先按单元归属排序，再统一编号）；行同步收集（判定计数用——
  // 有效判定的输入是行事实，不经过投影条目反推）
  const items: Omit<TeacherAttemptDetailQuestion, "no">[] = [];
  if (attempt.sourceType === "wrong") {
    // wrong（2026-10）：题目集合 = attempt 自有 responses 行（建卷时冻结的错题
    // 快照，按插入序 = 组卷题序）；draft 与已交卷同源（不查当前题库出题——
    // 教师改题不影响已建的卷）。draft 题干公开化、无判定与参考答案（与
    // assignment/course 的 draft 口径一致）；已交卷快照原文 + 参考答案/详解。
    // 单元列取题目当前归属单元（域内读，软删行仍在——错题「来自哪个练习」的
    // 展示口径，与错题本 originUnit 同源）；题目行缺失回退 questionId 占位。
    const ownRows = attemptResponseRows(db, attemptId);
    const unitByQuestion = new Map(
      ownRows.length > 0
        ? db
            .select({ id: questions.id, unitId: questions.unitId })
            .from(questions)
            .where(
              and(
                eq(questions.teacherId, teacherId),
                inArray(
                  questions.id,
                  ownRows.map((row) => row.questionId),
                ),
              ),
            )
            .all()
            .map((row) => [row.id, row.unitId] as const)
        : [],
    );
    for (const row of ownRows) {
      const snapshot = snapshotOfRow(row);
      if (snapshot === null) continue; // 坏快照按缺失计（建卷即冻结，理论不可达）
      const originUnitId = unitByQuestion.get(row.questionId) ?? row.questionId;
      items.push(
        detailItemOf(row, snapshot, {
          db,
          evidence: evidenceOf(
            row.questionId,
            (snapshot.materialRefs ?? []).map((r) => r.material),
          ),
          isDraft: !draftRowVisible(row.submittedAt),
          unitId: originUnitId,
          unitTitle: originUnitId, // 占位，下方统一回填（题目行缺失回退 questionId）
          ink: inkInfoOf(inkByQuestion.get(row.questionId)),
          materialSlots,
        }),
      );
    }
  } else {
    // 非 wrong（T6R.3）：draft 与 submitted/graded 统一消费 unitGroupedRows——
    // 分组与顺序从冻结行自身重建（unitId 首现序分组 + rowid 组内序）；升级前
    // 已交卷的遗留行沿用域内 join 口径。旧已交卷实现 inner join 会把 questions
    // 行缺失的响应行直接丢弃——统一为末尾兜底组展示（修正，不丢数据）。
    // draft 与学生草稿视图同源：题干经 studentStemMd 学生端投影（详情不下发
    // 参考答案，题干标记里的答案与 [x] 正确项同样不外露）、未提交行判定字段
    // null（判定列显示「未交卷」）；已逐题提交的行按已交卷投影（Web-3）。
    // 已交卷快照原文 + 参考答案/详解。快照缺失的
    // 历史行按「历史题目缺失」跳过；draft 进门先懒冻结（教师路径不经
    // requireUsableAttempt）。
    for (const group of unitGroupedRows(db, attempt, kernelRows)) {
      for (const row of group.rows) {
        const snapshot = snapshotOfRow(row);
        if (kernelRows !== undefined && snapshot?.id !== row.questionId)
          kernelAttemptUnavailable();
        if (snapshot === null) continue; // 历史题目缺失跳过
        items.push(
          detailItemOf(row, snapshot, {
            db,
            evidence: evidenceOf(
              row.questionId,
              (snapshot.materialRefs ?? []).map((r) => r.material),
            ),
            isDraft: !draftRowVisible(row.submittedAt),
            // 兜底组（unitId=null，正常不可达）：unitId 用 questionId 稳定占位，
            // 标题占位用组标题「未分组题目」（人文文案，不露 id）
            unitId: group.unitId ?? row.questionId,
            unitTitle: group.unitId ?? group.title,
            ink: inkInfoOf(inkByQuestion.get(row.questionId)),
            materialSlots,
          }),
        );
      }
    }
  }

  // 单元标题统一回填（域内读，含软删单元；draft 与已交卷同口径）
  const unitTitles = unitTitleByIdOf(
    db,
    teacherId,
    items.map((item) => item.unitId),
  );
  const times = timeProjectionsOf(db, [attempt.id]);
  const questionsOut: TeacherAttemptDetailQuestion[] = items.map(
    (item, index) => ({
      ...item,
      time: times.responseTime.get(
        times.members.find((r) => r.questionId === item.questionId)?.id ?? "",
      ),
      // 域内查到单元标题则覆盖占位；查不到（兜底组）保留占位文案（「未分组
      // 题目」/wrong 的 questionId 占位），不再回退裸 id
      unitTitle: unitTitles.get(item.unitId) ?? item.unitTitle,
      no: index + 1,
    }),
  );

  // 已放行且存在冻结快照的行才计入判定。内核作答只用已恢复的正式结果行。
  const judgedRows =
    attempt.abandonedAt !== null
      ? []
      : (
          kernelRows?.filter((row) => draftRowVisible(row.submittedAt)) ??
          db
            .select({
              autoCorrect: responses.autoCorrect,
              answered: responses.answered,
              teacherMark: responses.teacherMark,
              gradingPolicy: responses.gradingPolicy,
              selfReviewVerdict: responses.selfReviewVerdict,
              selfReviewAt: responses.selfReviewAt,
              selfReviewRevision: responses.selfReviewRevision,
            })
            .from(responses)
            .where(
              and(
                eq(responses.attemptId, attempt.id),
                hasUsableQuestionSnapshotSql,
                attempt.status === "draft"
                  ? isNotNull(responses.submittedAt)
                  : undefined,
              ),
            )
            .all()
        ).map((row) => ({
          verdict: effectiveVerdictOfRow(row),
          answered: row.answered,
        }));
  const correctCount = judgedRows.filter(
    (row) => row.verdict?.value === true,
  ).length;
  // v2 #6980-3 口径：判错且（有实际作答或人工显式判定：教师批 / 自评标记
  // 任一非空，或学生自评已出 verdict）才计错次
  const wrongCount = judgedRows.filter((row) =>
    countsAsWrong(row.verdict, row.answered),
  ).length;
  // 未做判错单列（与 wrongCount 互斥）：详情灰显「未做」
  const notDoneCount =
    judgedRows.filter((row) => row.verdict?.value === false).length -
    wrongCount;
  const resultCounts =
    kernelRows === undefined
      ? (attemptResultCounts(db, [attempt]).get(attempt.id) ?? null)
      : attempt.status === "draft" || attempt.abandonedAt !== null
        ? null
        : {
            correctCount,
            totalCount: judgedRows.length,
            pendingCount: 0,
            pendingSelfReviewCount: 0,
          };
  return {
    attemptId: attempt.id,
    studentId: attempt.studentId,
    studentName,
    ...source,
    resultCounts,
    status: attempt.status,
    scoreAuto: attempt.scoreAuto,
    scoreFinal: attempt.scoreFinal,
    correctCount,
    wrongCount,
    // 判错行中无实际作答且无人工显式判定的子集（#6980-3，灰显「未做」）
    notDoneCount,
    // D4 共享谓词（finalCorrect IS NULL 且非 reference_self 行；与列表卡片/
    // 待批队列/学情矩阵同一实现——不再用 effectiveCorrect=null 计数，避免把
    // 待自评行算进教师待批）
    pendingCount: kernelRows === undefined ? pendingMarkCount(db, attempt) : 0,
    selfReviewPendingCount:
      kernelRows === undefined
        ? (pendingSelfReviewCounts(db, [attempt]).get(attempt.id) ?? 0)
        : 0,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    time: attemptTimeOf(db, attempt.id),
    activeSec: attempt.activeSec,
    questions: questionsOut,
  };
}
