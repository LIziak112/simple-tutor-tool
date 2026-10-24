import {
  type EffectiveVerdict,
  effectiveVerdictOf,
  type SelfReviewData,
  type SelfReviewRequest,
  selfReviewConflictCurrentSchema,
  selfReviewDataSchema,
  type TeacherMark,
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
} from "./attempt-service";
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
 * 4. 行策略 reference_self（§5.8.2——auto 客观行无自评入口、manual_only 无
 *    参考不可自评、旧行 NULL 历史不开放；→ 403 SELF_REVIEW_NOT_ALLOWED）；
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
 * 响应：本题自评记录 + 有效判定投影（effectiveVerdictOf 三层回落）+ 卷汇总
 * （attemptScoreSummaryOf 现算；公布 gate 已过——见 practiceQuestionFeedbackStateOf
 * 组装前提，无受限形态投影需求）。
 */

/** teacherMark 列值的枚举收窄（列无 $type，按 D9 值域收窄给投影用） */
function teacherMarkOf(value: string | null): TeacherMark | null {
  return value === "correct" || value === "wrong" ? value : null;
}

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
): SelfReviewData {
  // 1. 归属/作废/课程失权（与取卷同口径——不暴露存在性差异）
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  // 2. 行属本 attempt（冻结集合外的题目 404）
  const row = db
    .select()
    .from(responses)
    .where(buildAttemptQuestionWhere(attemptId, questionId))
    .get();
  if (row === undefined) {
    throw questionNotFound();
  }
  // 3. 已提交 + 公布 gate（四态单一出处；非 released 统一 403 不泄露答案状态）
  const state = practiceQuestionFeedbackStateOf(db, attempt, row, now);
  if (state.status !== "released") {
    throw new HttpError(
      403,
      "SELF_REVIEW_NOT_RELEASED",
      "参考答案尚未公布，暂不能自评",
    );
  }
  // 4. 行策略：仅 reference_self 行有自评入口
  if (row.gradingPolicy !== "reference_self") {
    throw new HttpError(
      403,
      "SELF_REVIEW_NOT_ALLOWED",
      "这道题不支持自评（客观题自动判定或无参考答案由老师批改）",
    );
  }
  // 5. 参考材料可用（冻结快照可解析且有参考答案——防御异常数据）
  const snapshot = snapshotOfRow(row);
  if (snapshot === null || snapshot.answers === undefined) {
    throw new HttpError(
      403,
      "SELF_REVIEW_NOT_ALLOWED",
      "这道题的参考答案不可用，不能自评",
    );
  }
  // 6-8. 幂等/CAS/教师竞争在事务内裁决（快照单连接下读-写窗口最小，仍按
  // 事实复核——与 M2 逐题提交同款纪律）
  const nowIso = new Date(now).toISOString();
  const written = db.transaction((tx) => {
    const fresh = tx
      .select()
      .from(responses)
      .where(eq(responses.id, row.id))
      .get();
    if (fresh === undefined) {
      throw questionNotFound();
    }
    // 教师竞争：批注先落 → 迟到自评拒绝（先于幂等/CAS——教师优先不可被
    // 自评重放绕过）
    if (fresh.teacherMark !== null) {
      throw new HttpError(
        409,
        "SELF_REVIEW_TEACHER_MARKED",
        "老师已判定这道题，无需自评",
      );
    }
    // 幂等重放：同 mutationId 的网络重试返回首次回执（不重复写、revision
    // 不递增）；同键异请求是客户端错误——按 CAS 冲突拒绝并附当前事实
    if (fresh.selfReviewMutationId === req.mutationId) {
      if (replayConsistentWith(fresh, req)) return fresh;
      throw selfReviewRevisionConflict(fresh);
    }
    // CAS：baseRevision 与当前 revision 比对（先于写入）
    if (fresh.selfReviewRevision !== req.baseRevision) {
      throw selfReviewRevisionConflict(fresh);
    }
    const updated = tx
      .update(responses)
      .set({
        // undecided = 清除自评记录（幂等写），不是一次写入——记录三列清空、
        // revision 与幂等键照常推进（§5.5.1）
        selfReviewVerdict: req.verdict === "undecided" ? null : req.verdict,
        selfReviewAt: req.verdict === "undecided" ? null : nowIso,
        selfReviewRevision: fresh.selfReviewRevision + 1,
        selfReviewMutationId: req.mutationId,
      })
      .where(
        and(
          eq(responses.id, fresh.id),
          eq(responses.selfReviewRevision, req.baseRevision),
          isNull(responses.teacherMark),
        ),
      )
      .returning()
      .get();
    if (updated === undefined) {
      // 并发窗口（同步单连接理论不可达）：按事务内复核后的事实分码重拒
      const reread = tx
        .select()
        .from(responses)
        .where(eq(responses.id, row.id))
        .get();
      if (reread === undefined) throw questionNotFound();
      if (reread.teacherMark !== null) {
        throw new HttpError(
          409,
          "SELF_REVIEW_TEACHER_MARKED",
          "老师已判定这道题，无需自评",
        );
      }
      throw selfReviewRevisionConflict(reread);
    }
    return updated;
  });

  // 响应：本题自评记录 + 有效判定投影 + 卷汇总（自评不写 teacherMark/
  // finalCorrect/graded——attempt 行无需重读，汇总的 scoreFinal 读行值）
  const effective: EffectiveVerdict | null = effectiveVerdictOf(
    written.autoCorrect,
    teacherMarkOf(written.teacherMark),
    selfReviewRecordOf(written),
  );
  return selfReviewDataSchema.parse({
    selfReview: selfReviewRecordOf(written),
    effective,
    summary: attemptScoreSummaryOf(db, attempt),
  });
}
