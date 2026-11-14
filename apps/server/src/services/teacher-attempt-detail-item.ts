import type {
  Question,
  TeacherAttemptDetailQuestion,
  TeacherAttemptInkInfo,
} from "@tutor/contract";
import { studentStemMd } from "@tutor/md-dsl";
import type { Db } from "../db/client.ts";
import type { ResponseRow } from "../db/schema.ts";
import { publicOfSnapshot, selfReviewRecordOf } from "./attempt-service.ts";
import type { reviewEvidenceReader } from "./review-evidence.ts";
import { rubricReviewOf } from "./rubric-review-read.ts";
import { answerOf, releaseOfSnapshot } from "./snapshot.ts";

/**
 * 详情单题条目组装（wrong 与非 wrong 分支共用——原两份 40 行孪生收敛）：
 * - draft（未放行行，Web-3 起按行判定）：题干经 studentStemMd 学生端投影
 *   （详情不下发参考答案）、判定字段 null（判定列显示「未交卷」）、不提供
 *   批注定位 responseId；已逐题提交的放行行走已交卷分支；
 * - submitted/graded：快照题干原文 + 参考答案/详解，responseId=冻结行 id
 *   （详情页内联批改 POST /responses/:id/mark 定位用）；
 * - unitId/unitTitle 由调用方给（wrong=题目当前单元〔错题「来自哪个练习」的
 *   展示口径〕，非 wrong=冻结分组；title 传组标题占位，下方统一回填覆盖）。
 */
export function detailItemOf(
  row: ResponseRow,
  snapshot: Question,
  opts: {
    db: Db;
    evidence: ReturnType<ReturnType<typeof reviewEvidenceReader>>;
    isDraft: boolean;
    unitId: string;
    unitTitle: string;
    ink: TeacherAttemptInkInfo | null;
    materialSlots: ReadonlyMap<string, readonly string[]>;
  },
): Omit<TeacherAttemptDetailQuestion, "no"> {
  const isDraft = opts.isDraft;
  return {
    questionId: row.questionId,
    ...opts.evidence,
    settlementSeq: row.settlementSeq,
    rubricReview: isDraft ? null : rubricReviewOf(opts.db, row, snapshot),
    responseId: isDraft ? null : row.id,
    publicQuestion: publicOfSnapshot(snapshot, row.id, {
      questionVersion: row.questionVersion,
      materialSlots: opts.materialSlots,
      unitId: row.unitId,
    }),
    unitId: opts.unitId,
    unitTitle: opts.unitTitle,
    type: snapshot.type,
    difficulty: snapshot.difficulty,
    knowledge: snapshot.knowledge,
    stemMd: isDraft ? studentStemMd(snapshot) : snapshot.stemMd,
    ...(snapshot.options !== undefined
      ? { options: snapshot.options.map((option) => option.text) }
      : {}),
    answer: answerOf(row.answerJson),
    autoCorrect: isDraft ? null : row.autoCorrect,
    finalCorrect: isDraft ? null : row.finalCorrect,
    // #6980-3：是否有实际作答（draft 行恒默认 false，判定区仅已交卷消费）
    answered: row.answered,
    // #6980-4：做题时学生自标「不会」（draft 亦下发，教师可提前看到）
    studentFlag: row.studentFlag === "unsure" ? "unsure" : null,
    teacherMark: isDraft
      ? null
      : row.teacherMark === "correct" || row.teacherMark === "wrong"
        ? row.teacherMark
        : null,
    teacherComment: isDraft ? null : row.teacherComment,
    // QM-12：自评记录与行策略（教师优先——teacherMark 非空时展示以教师判定
    // 为准；draft 未交卷无自评，缺省不发）
    ...(isDraft
      ? {}
      : {
          selfReview: selfReviewRecordOf(row),
          gradingPolicy: row.gradingPolicy,
        }),
    activeSec: row.activeSec,
    hintsUsed: row.hintsUsed,
    changeCount: row.changeCount,
    ink: opts.ink,
    ...(isDraft ? {} : releaseOfSnapshot(snapshot)),
  };
}
