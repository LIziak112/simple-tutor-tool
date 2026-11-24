import {
  type EffectiveVerdict,
  effectiveVerdictOf,
  type SelfReviewData,
  type SelfReviewRequest,
  selfReviewConflictCurrentSchema,
  selfReviewDataSchema,
} from "@tutor/contract";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { type ResponseRow, responses } from "../db/schema";
import { HttpError } from "../lib/http-error";
import {
  attemptScoreSummaryOf,
  buildAttemptQuestionWhere,
  practiceQuestionFeedbackStateOf,
  questionNotFound,
  requireUsableAttempt,
  selfReviewRecordOf,
  teacherMarkOf,
} from "./attempt-service";
import { buildKernelAssignmentResult } from "./kernel-assignment-confirmed-detail.ts";
import { isKernelAttempt } from "./kernel-assignment-routing.ts";
import { kernelAttemptUnavailable } from "./kernel-assignment-runtime.ts";
import { readQuestionDeliveryFacts } from "./kernel-question-delivery-recovery.ts";
import {
  KernelSelfAssessmentConflict,
  writeKernelSelfAssessment,
} from "./kernel-self-assessment.ts";
import { snapshotOfRow } from "./snapshot";

/**
 * 学生自评服务（QM-10 细项4/5/6，TT-09a；契约层 packages/contract self-review.ts
 * ——校验链/错误码/纯推导函数 TT-05a 已定稿，本文件是服务端落地）：
 * POST /api/student/attempts/:id/questions/:questionId/self-review
 *
 * 校验链（§5.5.1，依次裁决）：
 * 1. 登录本人（路由 auth + requireUsableAttempt——404/403/409 与取卷同口径）；
 * 2. 行属本 attempt（题目不在冻结集合 → 404 QUESTION_NOT_FOUND）；
 * 3. 已提交 + 公布 gate（practiceQuestionFeedbackStateOf 四态单一出处复用，
 *    lesson 恒当题释放；非 released → 403 SELF_REVIEW_NOT_RELEASED，不泄露
 *    答案状态细节）；
 * 4. 行策略 reference_self（auto、manual_only 和历史 NULL 行均返回
 *    403 SELF_REVIEW_NOT_ALLOWED）；
 * 5. 参考材料可用（冻结快照可解析且有参考答案——policy 冻结时点有参考，
 *    此处防御异常数据；不可用 → 403 SELF_REVIEW_NOT_ALLOWED）；
 * 6. 教师未判（teacherMark 非空 → 409 SELF_REVIEW_TEACHER_MARKED——教师
 *    优先，迟到自评不能覆盖教师判断）；
 * 7. mutationId 幂等（同键重试返回首次回执，不重复写）+ baseRevision CAS
 *    （不符 → 409 SELF_REVIEW_REVISION_CONFLICT 附 _current）；
 * 8. 事务写入：correct/wrong 写记录、undecided 清除记录（幂等写、revision
 *    递增）；**自评不写 teacherMark、不写 finalCorrect、不推动 graded/
 *    scoreFinal**（D7 三源分立——自评是本人声明，不能伪装成教师或自动判定）。
 *
 * 响应：本题自评记录、有效判定和卷汇总。内核普通整卷复用结果页的权威投影。
 *
 * G47：内核练法声明了自评（建卷时 reference_self 题 + 教师自评计分设置）的
 * 整卷，第 8 步先经内核 selfAssess 落来源 self 的自评，再写宿主投影；汇总按
 * 练法声明的计分口径（separate 时自评单列 summary.selfAssessed）。
 */

// teacherMarkOf 已移驻 attempt-service（QM-12 有效判定单一出处共用收窄），
// 经顶部 import 使用

/** CAS 冲突的统一 409（附 _current：最新自评与 revision——只含本人自评事实） */
function selfReviewRevisionConflict(row: ResponseRow): HttpError {
  return new HttpError(
    409,
    "SELF_REVIEW_REVISION_CONFLICT",
    "这道题的自评已在其他设备更新，请刷新后查看最新自评再试",
    {
      _current: selfReviewConflictCurrentSchema.parse({
        selfReview: selfReviewRecordOf(row),
        revision: row.selfReviewRevision,
      }),
    },
  );
}

/** 同 mutationId 重放与已落状态是否同一次写入（revision = base+1 且 verdict 一致） */
function replayConsistentWith(
  row: ResponseRow,
  req: SelfReviewRequest,
): boolean {
  if (row.selfReviewRevision !== req.baseRevision + 1) return false;
  if (req.verdict === "undecided") return row.selfReviewVerdict === null;
  return row.selfReviewVerdict === req.verdict;
}

export function submitSelfReview(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  req: SelfReviewRequest,
  now: Date | string = new Date(),
  dataDir?: string,
): SelfReviewData {
  return db.transaction(
    (tx) => {
      const attempt = requireUsableAttempt(db, studentId, attemptId);
      const row = tx
        .select()
        .from(responses)
        .where(buildAttemptQuestionWhere(attemptId, questionId))
        .get();
      if (row === undefined) throw questionNotFound();
      if (
        practiceQuestionFeedbackStateOf(db, attempt, row, now).status !==
        "released"
      ) {
        throw new HttpError(
          403,
          "SELF_REVIEW_NOT_RELEASED",
          "参考答案尚未公布，暂不能自评",
        );
      }
      if (row.gradingPolicy !== "reference_self") {
        throw new HttpError(403, "SELF_REVIEW_NOT_ALLOWED", "这道题不支持自评");
      }
      const snapshot = snapshotOfRow(row);
      if (snapshot === null || snapshot.answers === undefined) {
        throw new HttpError(
          403,
          "SELF_REVIEW_NOT_ALLOWED",
          "这道题的参考答案不可用，不能自评",
        );
      }
      // 权威交付不可读时不落自评。恢复和回执组装都在同一个写事务内。
      const isKernelWholeAssignment =
        attempt.sourceType === "assignment" && isKernelAttempt(db, attempt);
      const delivery =
        isKernelWholeAssignment && dataDir !== undefined
          ? readQuestionDeliveryFacts(db, dataDir, attempt)
          : undefined;
      const confirmed = delivery?.rows.find(
        (projected) => projected.id === row.id,
      );
      if (isKernelWholeAssignment && !confirmed) kernelAttemptUnavailable();
      if ((confirmed ?? row).teacherMark !== null) {
        throw new HttpError(
          409,
          "SELF_REVIEW_TEACHER_MARKED",
          "老师已判定这道题，无需自评",
        );
      }
      const replay = row.selfReviewMutationId === req.mutationId;
      if (
        replay
          ? !replayConsistentWith(row, req)
          : row.selfReviewRevision !== req.baseRevision
      ) {
        throw selfReviewRevisionConflict(row);
      }

      const changes = replay
        ? null
        : {
            selfReviewVerdict: req.verdict === "undecided" ? null : req.verdict,
            selfReviewAt:
              req.verdict === "undecided" ? null : new Date(now).toISOString(),
            selfReviewRevision: row.selfReviewRevision + 1,
            selfReviewMutationId: req.mutationId,
          };
      if (changes && delivery && dataDir !== undefined) {
        try {
          writeKernelSelfAssessment(db, dataDir, delivery, row, {
            operation: `self-review:${req.mutationId}`,
            verdict: changes.selfReviewVerdict,
          });
        } catch (error) {
          if (error instanceof KernelSelfAssessmentConflict)
            throw selfReviewRevisionConflict(row);
          throw error;
        }
      }
      const written = changes
        ? tx
            .update(responses)
            .set(changes)
            .where(
              and(
                eq(responses.id, row.id),
                eq(responses.selfReviewRevision, req.baseRevision),
                isNull(responses.teacherMark),
              ),
            )
            .returning()
            .get()
        : row;
      if (!written) throw selfReviewRevisionConflict(row);

      const selfReview = selfReviewRecordOf(written);
      const effective: EffectiveVerdict | null = effectiveVerdictOf(
        (confirmed ?? written).autoCorrect,
        teacherMarkOf((confirmed ?? written).teacherMark),
        selfReview,
      );
      return selfReviewDataSchema.parse({
        selfReview,
        effective,
        summary: delivery
          ? buildKernelAssignmentResult(
              db,
              {
                ...delivery,
                rows: changes
                  ? delivery.rows.map((projected) =>
                      projected.id === written.id
                        ? { ...projected, ...changes }
                        : projected,
                    )
                  : delivery.rows,
              },
              new Date(now),
            ).summary
          : attemptScoreSummaryOf(db, attempt),
      });
    },
    { behavior: "immediate" },
  );
}
