import type { QuestionPublic, StudentAnswer } from "@tutor/contract";
import { memo, useId } from "react";
import { dispatchInput } from "@/features/answering";
import { prepareQuestion } from "@/features/answering/prepare-question";
import { QuestionSurfaceFrame } from "./QuestionSurfaceFrame";

/**
 * 正常作答与底图共用题面；导出保持布局但清除个人填答与选中态。
 *
 * UA-03 起内部委托呈现登记表（dispatchInput，方案 §10）：原题型输入分支
 * （judge 按钮 / choice·multi 选项 / fill 内联空位 / final 题干）收进各 kind
 * 视图（answering/views），本壳只保留稳定 DOM 外框与 §5 模式转换——
 * mode=export 总是 public-base（优先于 readOnly）；readOnly 为 readonly；
 * 其余 edit。public-base 从数据流剔除本人答案（即使误传）；readonly/
 * public-base 的更新换成稳定无副作用回调（inert/disabled 不是唯一防线）。
 * radio name 经 scopeId（题面实例标识 = `${question.id}-${useId()}`）保持
 * 迁移前的实例隔离形态（live 与导出并存不互串）。
 */

/** 稳定无副作用回调：预览缺 onAnswer 与锁定态的兼容形态（§5；权限控制在数据流） */
const STABLE_NOOP_UPDATE: (answer: StudentAnswer, _defer?: boolean) => void =
  () => {};

export const QuestionSurface = memo(function QuestionSurface({
  question,
  answer: suppliedAnswer,
  onAnswer: suppliedOnAnswer,
  mode = "answer",
  readOnly = false,
}: {
  question: QuestionPublic;
  answer?: StudentAnswer | undefined;
  onAnswer?: ((answer: StudentAnswer, defer?: boolean) => void) | undefined;
  mode?: "answer" | "export";
  /** 已提交原位只读（§11-2）：同宿主同位置呈现，输入改为只读而非换卡 */
  readOnly?: boolean;
}) {
  const surfaceId = useId();
  const prepared = prepareQuestion(question, `${question.id}-${surfaceId}`);
  const isPublicBase = mode === "export";
  const answer = isPublicBase ? undefined : suppliedAnswer;
  const update =
    isPublicBase || readOnly
      ? STABLE_NOOP_UPDATE
      : (suppliedOnAnswer ?? STABLE_NOOP_UPDATE);
  return (
    <QuestionSurfaceFrame>
      <div
        data-slot="question-surface"
        data-lr-node="root"
        inert={isPublicBase}
        className="mx-auto flex w-full min-w-0 flex-col gap-3 text-base leading-[1.75]"
      >
        {dispatchInput(prepared, answer, update, readOnly)}
      </div>
    </QuestionSurfaceFrame>
  );
});
