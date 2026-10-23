import type { AttemptResultQuestion, QuestionAnswers } from "@tutor/contract";
import { dispatchComparison } from "@/features/answering";
import { prepareQuestion } from "@/features/answering/prepare-question";
import type { ReferenceMaterial } from "@/features/answering/types";

/**
 * 本人答案 vs 参考答案的两栏对照（结果视图/逐题反馈/讲练页题卡共用）。
 *
 * UA-03 起为呈现登记表的兼容宿主：fill 逐空对齐、额外历史项、缺参考空态与
 * 锁定提示全部收进各 kind 的 Comparison 呈现（answering/views，宿主不再特判
 * fill）；本组件只做两件事——
 * 1. 模型准备：snapshot → PreparedQuestion（公开内容白名单，prepareQuestion）；
 * 2. 授权组装（§6 宿主职责）：released 才提供参考（unavailable=锁定提示），
 *    answers===null 保持「暂无参考答案」空态；错配 kind 的历史参考由
 *    dispatchComparison 调度边界按 §6.1 调整 7 归一（通用参考文本，不崩溃
 *    不改写）。
 */
export function ResultAnswerComparison({
  question,
  released,
}: {
  question: Pick<AttemptResultQuestion, "snapshot" | "answer" | "answers">;
  released: boolean;
}) {
  const model = prepareQuestion(question.snapshot, question.snapshot.id);
  const reference: ReferenceMaterial<QuestionAnswers> = !released
    ? { status: "unavailable" }
    : question.answers === null
      ? { status: "no-reference" }
      : { status: "available", reference: question.answers };
  return dispatchComparison(model, question.answer ?? undefined, reference);
}
