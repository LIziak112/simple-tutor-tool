import {
  type EffectiveVerdict,
  effectiveVerdictOf,
  type SelfReviewRecord,
  type TeacherMark,
} from "@tutor/contract";
import { and, inArray, sql } from "drizzle-orm";
import { type ResponseRow, responses } from "../db/schema.ts";

/**
 * teacherMark 列值的枚举收窄（列无 $type，按 D9 值域收窄给投影用）。原定义在
 * self-review-service（TT-09a），QM-12 移驻本文件：有效判定单一出处需要同一
 * 收窄，教师详情/汇总/错题/学情各消费面不再各写一份。
 */
export function teacherMarkOf(value: string | null): TeacherMark | null {
  return value === "correct" || value === "wrong" ? value : null;
}

/**
 * 行上自评记录的读取投影（QM-10 定义于 self-review-service，TT-09b 移驻本
 * 文件：结果单题投影与自评服务共用同一读取口径，且避免 attempt-service ←→
 * self-review-service 值循环）。verdict 列只存实际判断——undecided 已清除
 * 为 null；revision 的单独下发见 resultQuestionOf。
 * P3-2（TT-09a 审查遗留，本单落地）：脏行防御——verdict 非空而 at 缺失
 * （异常/历史写入）时契约 at min(1) 不成立，按「无记录」降级并 warn 留痕
 * （服务层拿不到 app 层 pino 实例，用固定前缀便于检索），不伪造空时间戳。
 */
export function selfReviewRecordOf(
  row: Pick<
    ResponseRow,
    "selfReviewVerdict" | "selfReviewAt" | "selfReviewRevision"
  >,
): SelfReviewRecord | null {
  if (row.selfReviewVerdict === null) return null;
  if (
    (row.selfReviewVerdict !== "correct" &&
      row.selfReviewVerdict !== "wrong") ||
    row.selfReviewAt === null ||
    row.selfReviewAt.length === 0
  ) {
    console.warn(
      `【数据异常】responses 自评判定或时间无效，按无记录降级（revision=${row.selfReviewRevision}）`,
    );
    return null;
  }
  return {
    verdict: row.selfReviewVerdict,
    at: row.selfReviewAt,
    revision: row.selfReviewRevision,
  };
}

/**
 * 行级有效判定单一出处（QM-12 细项1：教师判 > 自评 > 自动，与契约
 * effectiveVerdictOf 同序）。服务端各消费面（教师详情计数、错题集合、学情
 * 统计、CSV/材料整理包、AI 复盘过滤）一律经本函数，不再各写
 * `finalCorrect ?? autoCorrect` 之类的快捷回落——该口径对自评行恒漏判
 * （reference_self 行 finalCorrect 恒 null）。
 */
export function effectiveVerdictOfRow(
  row: Pick<
    ResponseRow,
    | "autoCorrect"
    | "teacherMark"
    | "selfReviewVerdict"
    | "selfReviewAt"
    | "selfReviewRevision"
  >,
): EffectiveVerdict | null {
  return effectiveVerdictOf(
    row.autoCorrect,
    teacherMarkOf(row.teacherMark),
    selfReviewRecordOf(row),
  );
}

/** 与 selfReviewRecordOf 的当前自评语义一致，供分页前筛选。 */
export const currentSelfReviewWhere = and(
  inArray(responses.selfReviewVerdict, ["correct", "wrong"]),
  sql`length(${responses.selfReviewAt}) > 0`,
);

/** SQLite 投影与 effectiveVerdictOf 的教师、自评、自动优先级一致。 */
export const effectiveVerdictSourceSql = sql<EffectiveVerdict["source"] | null>`
  case
    when ${responses.teacherMark} in ('correct', 'wrong') then 'teacher'
    when ${currentSelfReviewWhere} then 'self'
    when ${responses.autoCorrect} is not null then 'auto'
    else null
  end
`;

export const effectiveVerdictValueSql = sql<number | null>`
  case ${effectiveVerdictSourceSql}
    when 'teacher' then ${responses.teacherMark} = 'correct'
    when 'self' then ${responses.selfReviewVerdict} = 'correct'
    when 'auto' then ${responses.autoCorrect}
    else null
  end
`;

/** 未答且只被自动判错的行按未做计。 */
export function countsAsWrong(
  verdict: EffectiveVerdict | null,
  answered: boolean,
): boolean {
  return verdict?.value === false && (answered || verdict.source !== "auto");
}
