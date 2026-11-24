import {
  type GradingPolicy,
  type Question,
  resolveRowGradingPolicy,
  type StudentAnswer,
} from "@tutor/contract";
import { grade } from "./grade.ts";

/**
 * 行级判分入口（QM-10 细项 1，决策记录 §5.6 D11：判分策略按 response 行
 * 冻结，不全局改 grade()）——交卷/单题提交的判分调用点统一经本函数：
 * - reference_self / manual_only 恒 null——主观对错由公布后自评或教师处理；
 * - auto 走既有客观校验器（grade 内含题型路由）；
 * - 空值或非法值经 resolveRowGradingPolicy 回落默认策略（与同快照新开卷
 *   冻结的策略相同，TASK-f9439bfd），不保留旧语义分支。
 *
 * 纯函数：无 IO、无异常出口，与 grade() 同判分纪律（AGENTS 第 4 条）。
 */
export function gradeResponseRow(
  gradingPolicy: GradingPolicy | null,
  question: Question,
  answer?: StudentAnswer,
): boolean | null {
  const policy = resolveRowGradingPolicy(gradingPolicy, question);
  if (policy !== "auto") return null; // 主观策略不产生 autoCorrect 匹配判定
  return grade(question, answer);
}
