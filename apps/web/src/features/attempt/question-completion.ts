import type { QuestionPublic, StudentAnswer } from "@tutor/contract";
import { processor } from "@tutor/md-dsl";
import type { MdNode } from "@/features/markdown/remark/mdast-interop";
import { remarkBlank } from "@/features/markdown/remark/remark-blank";
import { remarkDirectiveHost } from "@/features/markdown/remark/remark-directive-host";
import { HANDWRITTEN_TYPES } from "./answer-format";

export interface QuestionCompletion {
  state: "empty" | "partial" | "filled";
  filledSlots: number;
  expectedSlots: number;
}

const slotsByQuestion = new WeakMap<QuestionPublic, number>();

/** 按实际题面渲染管线识别空位，答案变化不重复解析题干。 */
function countSlots(question: QuestionPublic): number {
  const cached = slotsByQuestion.get(question);
  if (cached !== undefined) return cached;
  // 渲染器使用最小AST结构；remark扩展节点的data类型通过此边界适配。
  const tree = processor.parse(question.stemMd) as unknown as MdNode;
  remarkBlank()(tree);
  remarkDirectiveHost()(tree);
  let count = 0;
  function visit(node: MdNode): void {
    if (
      node.name === "blank" &&
      typeof node.data?.hProperties?.index === "number"
    ) {
      count = Math.max(count, node.data.hProperties.index);
    }
    node.children?.forEach(visit);
  }
  visit(tree);
  slotsByQuestion.set(question, count);
  return count;
}

/** 填写完整度不判分，也不改变历史 isAnswered 的统计含义。 */
export function getQuestionCompletion(
  question: QuestionPublic,
  answer: StudentAnswer | undefined,
  formalInkPresence = false,
): QuestionCompletion {
  if (question.type === "fill") {
    const expectedSlots = countSlots(question);
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
        HANDWRITTEN_TYPES.has(question.type) &&
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
