import type { QuestionPublic, StudentAnswer } from "@tutor/contract";
import { dispatchCompletion } from "../answering";
import { prepareQuestion } from "../answering/prepare-question";

export interface QuestionCompletion {
  state: "empty" | "partial" | "filled";
  filledSlots: number;
  expectedSlots: number;
}

/**
 * 填写完整度不判分，也不改变历史 isAnswered 的统计含义。
 * UA-02 起槽位统计经 analyzeSlots 同源（I07：与真实渲染同一节点语义、
 * 缓存按对象身份）；final 的手写资格经 questionBindings 的纸面角色判定
 * （paperRole=answerInk ≡ 旧 HANDWRITTEN_TYPES 集合，一致性测试锁死）。
 */
export function getQuestionCompletion(
  question: QuestionPublic,
  answer: StudentAnswer | undefined,
  formalInkPresence = false,
): QuestionCompletion {
  // UA-03 起为呈现登记表的兼容代理：完整度口径（fill 按有效空位计、final
  // 有笔迹未填为 partial、choice/multi 越界不算已填写、I02 错配按未作答）
  // 收进各 kind 视图的 completion（answering/views）；本入口只准备模型并派发
  return dispatchCompletion(
    prepareQuestion(question, question.id),
    answer,
    formalInkPresence,
  );
}

export function completionLabel(completion: QuestionCompletion): string {
  if (completion.state === "empty") return "未填写";
  if (completion.state === "filled") return "已填写";
  return completion.expectedSlots > 1
    ? `已填 ${completion.filledSlots}/${completion.expectedSlots} 空`
    : "已写过程，未填最终答案";
}
