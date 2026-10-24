import type {
  AnswerKind,
  QuestionAnswers,
  ReferenceOf,
  StudentAnswer,
} from "@tutor/contract";
import type { ReactNode } from "react";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { formatReferenceAnswers } from "../attempt/answer-format";
import type { QuestionCompletion } from "../attempt/question-completion";
import type { PreparedQuestion } from "./prepare-question";
import type { AnswerKindViewTable, ReferenceMaterial } from "./types";
import { assertNeverView } from "./types";
import { choiceView, multiView } from "./views/choice";
import { AnswerComparisonShell } from "./views/comparison";
import { fillView } from "./views/fill";
import { finalView } from "./views/final";
import { judgeView } from "./views/judge";
import { matchingView } from "./views/matching";
import { orderingView } from "./views/ordering";
import { responseView } from "./views/response";

/**
 * 呈现登记表与唯一调度边界（方案 §4.4/§10，UA-03 落地）：
 * - answerKindViews：五 kind 穷尽登记（satisfies 强制，I01 编译期证据）；
 * - dispatchInput / dispatchReadOnly / dispatchComparison / dispatchCompletion：
 *   同文件四个显式 switch + assertNever 收尾（§4.4「唯一调度边界」= 本文件，
 *   与 contract 侧 dispatchBehavior/dispatchIsAnswered 同款纪律；动态从联合
 *   取函数会产生参数交集问题，故按 kind 显式 switch 后调用窄化实现）。
 *   调度边界以外，业务代码不得新增按 answer.kind/题型字面量的分支（I16）。
 */

/** 生产呈现登记表：八 kind 全配（漏 kind/三联合不交集即编译失败）——
 * matching/ordering 随 QM-13（TT-10a）接入，登记后 ResultAnswerComparison 的
 * 通用文本占位自动消失（§21.2-3 登记表成员判别口径） */
export const answerKindViews = {
  judge: judgeView,
  choice: choiceView,
  multi: multiView,
  fill: fillView,
  final: finalView,
  response: responseView,
  matching: matchingView,
  ordering: orderingView,
} satisfies AnswerKindViewTable<
  StudentAnswer,
  PreparedQuestion,
  QuestionAnswers
>;

/**
 * 参考材料按 kind 窄化（类型层）。调用前提：错配参考已在 dispatchComparison
 * 顶部归一，本函数运行时值原样透传；断言仅表达「available 的 reference 与
 * 模型 kind 匹配」这一由前提保证的事实（TS 无法跨泛型关联证明，单处单断言）。
 */
function materialOf<K extends AnswerKind>(
  material: ReferenceMaterial<QuestionAnswers>,
): ReferenceMaterial<ReferenceOf<K>> {
  return material.status === "available"
    ? { status: "available", reference: material.reference as ReferenceOf<K> }
    : material;
}

/** 题面输入区呈现（题干 + 题内输入；edit/readonly 同一稳定组件类型，§5） */
export function dispatchInput(
  model: PreparedQuestion,
  answer: StudentAnswer | undefined,
  update: (answer: StudentAnswer, defer?: boolean) => void,
  disabled: boolean,
): ReactNode {
  switch (model.kind) {
    case "judge":
      return (
        <answerKindViews.judge.Input
          model={model}
          answer={answer?.kind === "judge" ? answer : undefined}
          update={update}
          disabled={disabled}
        />
      );
    case "choice":
      return (
        <answerKindViews.choice.Input
          model={model}
          answer={answer?.kind === "choice" ? answer : undefined}
          update={update}
          disabled={disabled}
        />
      );
    case "multi":
      return (
        <answerKindViews.multi.Input
          model={model}
          answer={answer?.kind === "multi" ? answer : undefined}
          update={update}
          disabled={disabled}
        />
      );
    case "fill":
      return (
        <answerKindViews.fill.Input
          model={model}
          answer={answer?.kind === "fill" ? answer : undefined}
          update={update}
          disabled={disabled}
        />
      );
    case "final":
      // final 的题内输入区只有题干：最终答案输入由纸面控件区
      // （HandwrittenControls 经 views/final FinalAnswerField）托管
      // finalView.Input，题面不重复渲染第二份（§10 final 不重复）
      return (
        <RichMarkdown
          source={model.stemMd}
          className="text-base leading-[1.75]"
        />
      );
    case "response":
      return (
        <answerKindViews.response.Input
          model={model}
          answer={answer?.kind === "response" ? answer : undefined}
          update={update}
          disabled={disabled}
        />
      );
    case "matching":
      return (
        <answerKindViews.matching.Input
          model={model}
          answer={answer?.kind === "matching" ? answer : undefined}
          update={update}
          disabled={disabled}
        />
      );
    case "ordering":
      return (
        <answerKindViews.ordering.Input
          model={model}
          answer={answer?.kind === "ordering" ? answer : undefined}
          update={update}
          disabled={disabled}
        />
      );
    default:
      return assertNeverView(model);
  }
}

/** 独立结果材料呈现（本人答案列；不含参考答案，I02） */
export function dispatchReadOnly(
  model: PreparedQuestion,
  answer: StudentAnswer | undefined,
): ReactNode {
  switch (model.kind) {
    case "judge":
      return (
        <answerKindViews.judge.ReadOnly
          model={model}
          answer={answer?.kind === "judge" ? answer : undefined}
        />
      );
    case "choice":
      return (
        <answerKindViews.choice.ReadOnly
          model={model}
          answer={answer?.kind === "choice" ? answer : undefined}
        />
      );
    case "multi":
      return (
        <answerKindViews.multi.ReadOnly
          model={model}
          answer={answer?.kind === "multi" ? answer : undefined}
        />
      );
    case "fill":
      return (
        <answerKindViews.fill.ReadOnly
          model={model}
          answer={answer?.kind === "fill" ? answer : undefined}
        />
      );
    case "final":
      return (
        <answerKindViews.final.ReadOnly
          model={model}
          answer={answer?.kind === "final" ? answer : undefined}
        />
      );
    case "response":
      return (
        <answerKindViews.response.ReadOnly
          model={model}
          answer={answer?.kind === "response" ? answer : undefined}
        />
      );
    case "matching":
      return (
        <answerKindViews.matching.ReadOnly
          model={model}
          answer={answer?.kind === "matching" ? answer : undefined}
        />
      );
    case "ordering":
      return (
        <answerKindViews.ordering.ReadOnly
          model={model}
          answer={answer?.kind === "ordering" ? answer : undefined}
        />
      );
    default:
      return assertNeverView(model);
  }
}

/** 本人/参考对照呈现（公布三态由 ReferenceMaterial 携带，§6） */
export function dispatchComparison(
  model: PreparedQuestion,
  answer: StudentAnswer | undefined,
  reference: ReferenceMaterial<QuestionAnswers>,
): ReactNode {
  // 错配参考（冻结快照的历史数据，§6.1 调整 7）：按现网策略走 formatQuestionAnswers
  // 通用文本（不崩溃不改写），归一在唯一调度边界完成——宿主与各视图不再各自
  // 处理错配分支
  if (
    reference.status === "available" &&
    reference.reference.kind !== model.kind
  ) {
    return (
      <AnswerComparisonShell
        ownColumn={dispatchReadOnly(model, answer)}
        referenceColumn={
          <RichMarkdown
            source={formatReferenceAnswers(reference.reference)}
            className="min-w-0 font-medium [&_p]:my-0"
          />
        }
      />
    );
  }
  switch (model.kind) {
    case "judge":
      return (
        <answerKindViews.judge.Comparison
          model={model}
          answer={answer?.kind === "judge" ? answer : undefined}
          reference={materialOf<"judge">(reference)}
        />
      );
    case "choice":
      return (
        <answerKindViews.choice.Comparison
          model={model}
          answer={answer?.kind === "choice" ? answer : undefined}
          reference={materialOf<"choice">(reference)}
        />
      );
    case "multi":
      return (
        <answerKindViews.multi.Comparison
          model={model}
          answer={answer?.kind === "multi" ? answer : undefined}
          reference={materialOf<"multi">(reference)}
        />
      );
    case "fill":
      return (
        <answerKindViews.fill.Comparison
          model={model}
          answer={answer?.kind === "fill" ? answer : undefined}
          reference={materialOf<"fill">(reference)}
        />
      );
    case "final":
      return (
        <answerKindViews.final.Comparison
          model={model}
          answer={answer?.kind === "final" ? answer : undefined}
          reference={materialOf<"final">(reference)}
        />
      );
    case "response":
      return (
        <answerKindViews.response.Comparison
          model={model}
          answer={answer?.kind === "response" ? answer : undefined}
          reference={materialOf<"response">(reference)}
        />
      );
    case "matching":
      return (
        <answerKindViews.matching.Comparison
          model={model}
          answer={answer?.kind === "matching" ? answer : undefined}
          reference={materialOf<"matching">(reference)}
        />
      );
    case "ordering":
      return (
        <answerKindViews.ordering.Comparison
          model={model}
          answer={answer?.kind === "ordering" ? answer : undefined}
          reference={materialOf<"ordering">(reference)}
        />
      );
    default:
      return assertNeverView(model);
  }
}

/** 完整度派发（口径与迁移前 getQuestionCompletion 逐字一致，I06） */
export function dispatchCompletion(
  model: PreparedQuestion,
  answer: StudentAnswer | undefined,
  formalInk: boolean,
): QuestionCompletion {
  switch (model.kind) {
    case "judge":
      return answerKindViews.judge.completion(
        model,
        answer?.kind === "judge" ? answer : undefined,
        formalInk,
      );
    case "choice":
      return answerKindViews.choice.completion(
        model,
        answer?.kind === "choice" ? answer : undefined,
        formalInk,
      );
    case "multi":
      return answerKindViews.multi.completion(
        model,
        answer?.kind === "multi" ? answer : undefined,
        formalInk,
      );
    case "fill":
      return answerKindViews.fill.completion(
        model,
        answer?.kind === "fill" ? answer : undefined,
        formalInk,
      );
    case "final":
      return answerKindViews.final.completion(
        model,
        answer?.kind === "final" ? answer : undefined,
        formalInk,
      );
    case "response":
      return answerKindViews.response.completion(
        model,
        answer?.kind === "response" ? answer : undefined,
        formalInk,
      );
    case "matching":
      return answerKindViews.matching.completion(
        model,
        answer?.kind === "matching" ? answer : undefined,
        formalInk,
      );
    case "ordering":
      return answerKindViews.ordering.completion(
        model,
        answer?.kind === "ordering" ? answer : undefined,
        formalInk,
      );
    default:
      return assertNeverView(model);
  }
}
