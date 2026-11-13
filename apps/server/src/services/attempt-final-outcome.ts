import type { GradingPolicy } from "@tutor/contract";
import { and, isNull, ne, or, sql } from "drizzle-orm";
import { responses } from "../db/schema.ts";

/**
 * D2/D3 口径的 attempt 级最终得分与状态（T3.2a）：
 * - status=graded 当且仅当全部 finalCorrect 均非 null（此时必写 scoreFinal）；
 * - scoreFinal = round（finalCorrect 为 true 的题数 ÷ 全部题数 × 100）；
 *   任一待批（null）则 status=submitted、scoreFinal=null（批改完成后由 T3.2b 重算）；
 * - 空卷（无题）防御性保持 submitted / null。
 * 交卷链路调用时 finalCorrect=autoCorrect（teacherMark 必空）；backfill 与批改
 * 链路以 teacherMark ?? autoCorrect 为输入复用同一口径。
 */
export function finalScoreOf(finalCorrects: readonly (boolean | null)[]): {
  status: "submitted" | "graded";
  scoreFinal: number | null;
} {
  return attemptFinalOutcomeOf(
    finalCorrects.map((finalCorrect) => ({
      gradingPolicy: null,
      submittedAt: null,
      finalCorrect,
    })),
    { finalized: true },
  );
}

/** 已通过冻结快照校验的判分行。 */
export interface FinalOutcomeRow {
  readonly gradingPolicy: GradingPolicy | null;
  readonly submittedAt: string | null;
  readonly finalCorrect: boolean | null;
}

export function needsTeacherMark(
  row: Pick<FinalOutcomeRow, "gradingPolicy" | "finalCorrect">,
): boolean {
  return row.gradingPolicy !== "reference_self" && row.finalCorrect === null;
}

export const needsTeacherMarkSql = and(
  isNull(responses.finalCorrect),
  or(
    isNull(responses.gradingPolicy),
    ne(responses.gradingPolicy, "reference_self"),
  ),
);

export const hasUsableQuestionSnapshotSql = sql<number>`ownclass_question_snapshot_valid(${responses.questionSnapshotJson})`;

/** 按每行冻结策略判断教师待批。全部题已交且无教师待批时写入教师权威分数。 */
export function attemptFinalOutcomeOf(
  rows: readonly FinalOutcomeRow[],
  opts: { finalized?: boolean } = {},
): {
  status: "submitted" | "graded";
  scoreFinal: number | null;
} {
  // P1 修复（审查 TT-09a）：整卷收尾即全部判分行已提交——与四态 gate
  // （practiceQuestionFeedbackStateOf 的 `row.submittedAt !== null || finalized`）
  // 同一口径。legacy 协议行不写行级 submittedAt（responses.submittedAt 是逐题
  // 提交列，协议分野保持），不归一则 legacy+开关开启卷整卷交卷恒 submitted/
  // scoreFinal=null，教师批改重算同病。finalized 由调用方声明收尾事实：
  // 交卷链路交卷即收尾、自动收尾正在收尾、markResponse 只对已收尾卷重算
  const allSubmitted =
    opts.finalized === true || rows.every((row) => row.submittedAt !== null);
  if (rows.length === 0 || !allSubmitted || rows.some(needsTeacherMark)) {
    return { status: "submitted", scoreFinal: null };
  }
  const correct = rows.filter((row) => row.finalCorrect === true).length;
  return {
    status: "graded",
    scoreFinal: Math.round((correct / rows.length) * 100),
  };
}

export function scoreAutoOf(
  rows: readonly { autoCorrect: boolean | null }[],
): number | null {
  const autoGradable = rows.filter((row) => row.autoCorrect !== null).length;
  if (autoGradable === 0) return null;
  const correct = rows.filter((row) => row.autoCorrect === true).length;
  return Math.round((correct / autoGradable) * 100);
}
