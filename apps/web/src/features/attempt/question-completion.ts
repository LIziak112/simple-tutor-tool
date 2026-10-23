import type { QuestionPublic, StudentAnswer } from "@tutor/contract";
import { questionBindings } from "../answering/question-binding";
import {
  expectedSlotCountOf,
  slotsOfQuestion,
} from "../answering/prepare-question";

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
  if (question.type === "fill") {
    const expectedSlots = expectedSlotCountOf(slotsOfQuestion(question));
    const values = answer?.kind === "fill" ? answer.values : [];
    let filledSlots = 0;
    for (let i = 0; i < expectedSlots; i++) {
      if ((values[i] ?? "").trim() !== "") filledSlots++;
    }
    return {
      state:
        filledSlots === 0
          ? "empty"
          : filledSlots === expectedSlots
            ? "filled"
            : "partial",
      filledSlots,
      expectedSlots,
    };
  }
  let filled = false;
  switch (answer?.kind) {
    case "judge":
      filled = question.type === "judge";
      break;
    case "choice":
      filled =
        question.type === "choice" &&
        answer.index >= 0 &&
        answer.index < (question.options?.length ?? 0);
      break;
    case "multi":
      filled =
        question.type === "multi" &&
        answer.indexes.some(
          (index) => index >= 0 && index < (question.options?.length ?? 0),
        );
      break;
    case "final":
      filled =
        questionBindings[question.type].paperRole === "answerInk" &&
        answer.finalAnswer.trim() !== "";
      break;
  }
  return {
    state: filled ? "filled" : formalInkPresence ? "partial" : "empty",
    filledSlots: filled ? 1 : 0,
    expectedSlots: 1,
  };
}

export function completionLabel(completion: QuestionCompletion): string {
  if (completion.state === "empty") return "未填写";
  if (completion.state === "filled") return "已填写";
  return completion.expectedSlots > 1
    ? `已填 ${completion.filledSlots}/${completion.expectedSlots} 空`
    : "已写过程，未填最终答案";
}
