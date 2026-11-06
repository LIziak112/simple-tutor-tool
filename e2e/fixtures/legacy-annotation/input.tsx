import { dispatchInput as unchangedInput } from "@/features/answering";
import {
  type PreparedQuestion,
  prepareQuestion,
} from "@/features/answering/prepare-question";
import type {
  AttemptQuestionPublic,
  StudentAnswer,
} from "../../../packages/contract/src/index";
import { captureFrozenFillControls, fillView } from "./fill";
import { matchingView } from "./matching";
import { orderingView } from "./ordering";

/** 历史 Input 独立于现行 legacy profile；其余未改题型复用正常输入。 */
export function dispatchInput(
  model: PreparedQuestion,
  answer: StudentAnswer | undefined,
  update: (answer: StudentAnswer, defer?: boolean) => void,
  disabled: boolean,
) {
  switch (model.kind) {
    case "matching":
      return (
        <matchingView.Input
          model={model}
          answer={answer?.kind === "matching" ? answer : undefined}
          update={update}
          disabled={disabled}
        />
      );
    case "ordering":
      return (
        <orderingView.Input
          model={model}
          answer={answer?.kind === "ordering" ? answer : undefined}
          update={update}
          disabled={disabled}
        />
      );
    case "fill":
      return (
        <fillView.Input
          model={model}
          answer={answer?.kind === "fill" ? answer : undefined}
          update={update}
          disabled={disabled}
        />
      );
    default:
      return unchangedInput(model, answer, update, disabled);
  }
}

export function captureFrozenControls(
  question: AttemptQuestionPublic,
  exported: HTMLElement,
) {
  const model = prepareQuestion(question, "legacy-fixture");
  return model.kind === "fill"
    ? captureFrozenFillControls(model, exported)
    : null;
}
