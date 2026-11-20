import type {
  AttemptQuestionPublic,
  AttemptResultQuestion,
  HintOpenedEntry,
  LessonBlock,
  LessonStartData,
  StudentAnswer,
} from "@tutor/contract";
import { splitLessonBlocks } from "@tutor/md-dsl";
import type { Db } from "../db/client.ts";
import type { Attempt, ResponseRow } from "../db/schema.ts";
import {
  answerOf,
  attemptEnabledCapabilities,
  attemptResponseRows,
  attemptSummaryOf,
  lessonLiveSummaryOf,
  lessonQuestionSubmitted,
  materialSlotOrderOf,
  publicOfSnapshot,
  resultQuestionOf,
  studentFacingResultOf,
} from "./attempt-service.ts";
import { attemptTimeEstimateOf } from "./attempt-time-estimate.ts";
import { timeProjectionsOf } from "./attempt-time-projection.ts";
import { openedHintEcho } from "./hint-service.ts";
import { snapshotOfRow } from "./snapshot.ts";

/** 讲练页讲义行的结构化投影（requireVisibleStudentLecture 的产物裁剪） */
export interface LessonLectureRef {
  readonly id: string;
  readonly title: string;
  /** 讲义原文（含题块——教师域数据，只供服务端切段，绝不下发） */
  readonly markdown: string;
}

/** 讲练开卷的课程上下文（三分谓词产物裁剪） */
export interface LessonCourseRef {
  readonly id: string;
  readonly title: string;
  readonly teacherId: string;
}

/**
 * 讲练开卷投影组装（start/restart 共用）。blocks 服务端切段；questions 冻结行
 * 公开投影平铺（快照缺失的历史行跳过，不回填）；drafts/hintsOpened 与草稿
 * 视图同口径；released 只含已单题提交的题（当题已释放，stemMd 经
 * studentStemMd 投影）；summary 读侧现算——经 attempt-service 的
 * lessonLiveSummaryOf（与单题提交响应同一实现：已提交行计入对错、未提交计入
 * unanswered，pendingCount 按 D4 finalCorrect 口径只数已提交行）。
 */
export function buildLessonStartData(
  db: Db,
  lecture: LessonLectureRef,
  course: LessonCourseRef,
  topic: string | null,
  attempt: Attempt,
  frozenRows?: readonly ResponseRow[],
): LessonStartData {
  const blocks: LessonBlock[] = splitLessonBlocks(lecture.markdown);

  // QM-13：matching 槽位集合按冻结材料槽位序展开（一次取全卷共用）
  const materialSlots = materialSlotOrderOf(db, attempt.id);
  const times = timeProjectionsOf(db, [attempt.id]);
  const questions: AttemptQuestionPublic[] = [];
  const drafts: Record<string, StudentAnswer> = {};
  const draftRevisions: Record<string, number> = {};
  const hintsOpened: Record<string, HintOpenedEntry[]> = {};
  const released: Record<string, AttemptResultQuestion> = {};
  const rows = frozenRows ?? attemptResponseRows(db, attempt.id);
  const validQuestionIds = new Set<string>();
  for (const row of rows) {
    const snapshot = snapshotOfRow(row);
    if (snapshot === null) continue; // 历史题目缺失/坏快照：跳过（不回填、不判分）
    validQuestionIds.add(row.questionId);
    questions.push(
      publicOfSnapshot(snapshot, row.id, {
        questionVersion: row.questionVersion,
        materialSlots,
        // 审查 P2-1：旧快照兜底重抽的解析语境（行内冻结单元归属）
        unitId: row.unitId,
      }),
    );
    const answer = answerOf(row.answerJson);
    draftRevisions[row.questionId] = row.answerRevision;
    if (answer !== null) drafts[row.questionId] = answer;
    const echo = openedHintEcho(row.hintsOpenedJson, snapshot.hints);
    if (echo.length > 0) hintsOpened[row.questionId] = echo;
    if (!lessonQuestionSubmitted(row)) {
      continue;
    } // 未单题提交：不进 released、不计对错
    // 已单题提交 → 当题释放（读当前行值：进行中卷教师可能已批 teacherMark）；
    // 题干经 studentFacingResultOf 学生端投影（与结果视图/单题提交同一包装处，
    // 含 [[答案]] 标记的原文不下发）
    released[row.questionId] = studentFacingResultOf(
      resultQuestionOf(row, snapshot, {
        materialSlots,
        db,
        time: times.responseTime.get(row.id),
      }),
    );
  }
  return {
    time: times.aggregate(attempt.id),
    timeEstimate: attemptTimeEstimateOf(db, attempt.id),
    lecture: {
      id: lecture.id,
      title: lecture.title,
      // 嵌入单元的 topic（frontmatter topic 落单元行；零题讲练页无单元 → null）
      topic,
      courseId: course.id,
      courseName: course.title,
    },
    blocks,
    attempt: attemptSummaryOf(attempt),
    questions,
    drafts,
    draftRevisions,
    hintsOpened,
    released,
    summary: lessonLiveSummaryOf(
      // 开卷本就装载完整行（题目投影需要快照原文）；喂汇总前映射为存在性
      // 布尔形态（ScoreSummaryRow，不重复搬运快照列语义；QM-12 起补自评
      // 三列——汇总核心的有效判定需要）
      rows.map((row) => ({
        hasSnapshot: validQuestionIds.has(row.questionId),
        answerJson: row.answerJson,
        submittedAt: row.submittedAt,
        autoCorrect: row.autoCorrect,
        finalCorrect: row.finalCorrect,
        gradingPolicy: row.gradingPolicy,
        teacherMark: row.teacherMark,
        selfReviewVerdict: row.selfReviewVerdict,
        selfReviewAt: row.selfReviewAt,
        selfReviewRevision: row.selfReviewRevision,
        answered: row.answered,
      })),
      attempt,
    ),
    enabledCapabilities: attemptEnabledCapabilities(db, attempt),
  };
}
