import {
  type GradingPolicy,
  type Question,
  resolveRowGradingSemantics,
  type StudentAnswer,
} from "@tutor/contract";
import { grade } from "./grade.ts";

/**
 * 行级判分入口（QM-10 细项 1，决策记录 §5.6 D11：判分策略按 response 行
 * 冻结，不全局改 grade()）——交卷/单题提交的判分调用点统一经本函数：
 * - 新策略行（gradingPolicy 非 null）：reference_self / manual_only 恒 null
 *   ——新作答（fill 与 solve/apply/find-error、response/matching/ordering）
 *   不走自动对错比较，主观对错由公布后自评或教师处理；auto 走既有客观
 *   校验器（与旧行为一致）；
 * - 旧行（NULL）按题型能力表旧语义解释（resolveRowGradingSemantics 契约
 *   单一出处）：judge/choice/multi 自动判定、fill 恒 null 进待批、
 *   solve/apply/find-error 走 final 等价比较——历史不重算、不重释（禁止
 *   全局改 grade 后意外重释历史）；
 * - 新题型行 NULL 只可能是异常数据（开卷即冻结）：兜底 manual_only → null，
 *   不伪造自动判定。
 *
 * 纯函数：无 IO、无异常出口，与 grade() 同判分纪律（AGENTS 第 4 条）。
 */
export function gradeResponseRow(
  gradingPolicy: GradingPolicy | null,
  question: Question,
  answer?: StudentAnswer,
): boolean | null {
  const semantics = resolveRowGradingSemantics(gradingPolicy, question.type);
  if (semantics.kind === "reference_self" || semantics.kind === "manual_only") {
    return null; // 新策略行不产生 autoCorrect 主观匹配判定
  }
  return grade(question, answer); // auto / 旧行旧语义（grade 内含题型路由）
}
