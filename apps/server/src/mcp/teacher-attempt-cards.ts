import type { TeacherAttemptListQuery } from "@tutor/contract";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { aiAttemptReviewTasks, attempts, responses } from "../db/schema.ts";
import { recordableAttemptWhere } from "../services/attempt-recordability.ts";
import { readTeacherAttemptCards } from "../services/teacher-attempt-service.ts";

// ---------- query_student_attempts 的每卷增量计数 ----------

/** 每卷盘点计数（query_student_attempts 在 listTeacherAttempts 卡片上的增量面） */
interface AttemptExtras {
  /** 单题已提交的行数（draft 卷为部分提交数；已交卷 = 冻结行数） */
  submittedCount: number;
  correctCount: number;
  wrongCount: number;
  /** 自标「不会」的行数 */
  unsureCount: number;
  /** 是否已有整卷 AI 复盘任务（任意状态，创建过即算） */
  hasAiReview: boolean;
}

/** 一批卷的增量计数（两条聚合 SQL，避免逐卷 N+1；无 responses 行的卷补零值） */
function attemptExtrasOf(
  db: Db,
  attemptIds: readonly string[],
): Map<string, AttemptExtras> {
  const map = new Map<string, AttemptExtras>();
  if (attemptIds.length === 0) return map;
  const ids = [...attemptIds];
  const counts = db
    .select({
      attemptId: responses.attemptId,
      submitted: sql<number>`coalesce(sum(case when ${responses.submittedAt} is not null then 1 else 0 end), 0)`,
      correct: sql<number>`coalesce(sum(case when ${responses.finalCorrect} = 1 then 1 else 0 end), 0)`,
      wrong: sql<number>`coalesce(sum(case when ${responses.finalCorrect} = 0 then 1 else 0 end), 0)`,
      unsure: sql<number>`coalesce(sum(case when ${responses.studentFlag} = 'unsure' then 1 else 0 end), 0)`,
    })
    .from(responses)
    .innerJoin(attempts, eq(responses.attemptId, attempts.id))
    .where(and(inArray(responses.attemptId, ids), recordableAttemptWhere()))
    .groupBy(responses.attemptId)
    .all();
  const reviewIds = new Set(
    db
      .select({ attemptId: aiAttemptReviewTasks.attemptId })
      .from(aiAttemptReviewTasks)
      .where(inArray(aiAttemptReviewTasks.attemptId, ids))
      .all()
      .map((row) => row.attemptId),
  );
  for (const row of counts) {
    map.set(row.attemptId, {
      submittedCount: row.submitted ?? 0,
      correctCount: row.correct ?? 0,
      wrongCount: row.wrong ?? 0,
      unsureCount: row.unsure ?? 0,
      hasAiReview: reviewIds.has(row.attemptId),
    });
  }
  for (const id of ids) {
    if (!map.has(id)) {
      map.set(id, {
        submittedCount: 0,
        correctCount: 0,
        wrongCount: 0,
        unsureCount: 0,
        hasAiReview: reviewIds.has(id),
      });
    }
  }
  return map;
}

/** 已授权教师工具消费工作台的同一页与确认计数。 */
export function queryTeacherAttemptCards(
  db: Db,
  teacherId: string,
  query: TeacherAttemptListQuery,
  dataDir: string,
) {
  const {
    data: { attempts: cards, total },
    confirmedCounts,
  } = readTeacherAttemptCards(db, teacherId, query, dataDir);
  const extras = attemptExtrasOf(
    db,
    cards.map((card) => card.attemptId),
  );
  const nextOffset = query.offset + cards.length;
  return {
    total,
    nextCursor: nextOffset < total ? String(nextOffset) : null,
    attempts: cards.map((card) => {
      const extra = extras.get(card.attemptId);
      const confirmed = confirmedCounts.get(card.attemptId);
      return {
        attemptId: card.attemptId,
        studentId: card.studentId,
        studentName: card.studentName,
        sourceType: card.sourceType,
        courseId: card.courseId,
        courseName: card.courseName,
        assignmentId: card.assignmentId,
        assignmentTitle: card.assignmentTitle,
        unitId: card.unitId,
        unitTitle: card.unitTitle,
        attemptNo: card.attemptNo,
        status: card.status,
        startedAt: card.startedAt,
        submittedAt: card.submittedAt,
        activeSec: card.activeSec,
        unitCount: card.unitCount,
        questionCount: card.questionCount,
        scoreAuto: card.scoreAuto,
        scoreFinal: card.scoreFinal,
        submittedCount: confirmed?.totalCount ?? extra?.submittedCount ?? 0,
        correctCount: confirmed?.correctCount ?? extra?.correctCount ?? 0,
        wrongCount:
          confirmed === undefined
            ? (extra?.wrongCount ?? 0)
            : confirmed.totalCount - confirmed.correctCount,
        pendingCount: card.pendingCount,
        unsureCount: extra?.unsureCount ?? 0,
        hasAiReview: extra?.hasAiReview ?? false,
      };
    }),
  };
}
