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

/** 单个选项的内容（字母 + Markdown/公式文本） */
function OptionBody({ letter, text }: { letter: string; text: string }) {
  // 独立的「0.」「1.」是选项正文，不能被 Markdown 解释成空的有序列表。
  const source = text.replace(/^(\s*\d+)\.(\s*)$/, "$1\\.$2");
  return (
    <>
      <span className="w-5 shrink-0 text-center text-sm leading-7 font-semibold">
        <span className="sr-only">选项</span> {letter}
      </span>
      <RichMarkdown
        source={source}
        className="question-markdown min-w-0 flex-1 text-base leading-[1.75]"
      />
    </>
  );
}

/** 判断题：对/错两个大按钮（原生 radio 语义，组内互斥） */
function JudgeControls({
  question,
  answer,
  onAnswer,
  disabled = false,
}: {
  question: QuestionPublic;
  answer: StudentAnswer | undefined;
  onAnswer: (answer: StudentAnswer) => void;
  /** 已提交只读（§11-2 原位只读）：隐藏输入同样携带 disabled 语义 */
  disabled?: boolean;
}) {
  const picked =
    answer?.kind === "judge" && typeof answer.value === "boolean"
      ? answer.value
      : undefined;
  const groupName = `judge-${question.id}-${useId()}`;
  const labelClass = (selected: boolean) =>
    cn(
      "flex min-h-12 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border-2 text-base font-medium outline-none transition-colors has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
      selected
        ? "border-primary bg-primary/10 text-primary"
        : "border-border bg-card hover:bg-muted/60",
    );
  return (
    <div className="flex gap-3" role="radiogroup" aria-label="判断对错">
      <label className={labelClass(picked === true)}>
        <input
          type="radio"
          name={groupName}
          aria-label="对"
          checked={picked === true}
          disabled={disabled}
          onChange={() => onAnswer({ kind: "judge", value: true })}
          className="sr-only"
        />
        <span className="flex items-center gap-2">
          <Check
            aria-hidden
            className={`size-5 ${picked === true ? "" : "invisible"}`}
          />
          对
        </span>
      </label>
      <label className={labelClass(picked === false)}>
        <input
          type="radio"
          name={groupName}
          aria-label="错"
          checked={picked === false}
          disabled={disabled}
          onChange={() => onAnswer({ kind: "judge", value: false })}
          className="sr-only"
        />
        <span className="flex items-center gap-2">
          <X
            aria-hidden
            className={`size-5 ${picked === false ? "" : "invisible"}`}
          />
          错
        </span>
      </label>
    </div>
  );
}

/** 单选题：原生标签提供字母及正文，保留公式的可访问语义。 */
function ChoiceControls({
  question,
  answer,
  onAnswer,
  disabled = false,
}: {
  question: QuestionPublic;
  answer: StudentAnswer | undefined;
  onAnswer: (answer: StudentAnswer) => void;
  /** 已提交只读（§11-2 原位只读）：隐藏输入同样携带 disabled 语义 */
  disabled?: boolean;
}) {
  const picked = answer?.kind === "choice" ? answer.index : undefined;
  const groupName = `choice-${question.id}-${useId()}`;
  return (
    <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="选项">
      {(question.options ?? []).map((option, index) => (
        <label
          key={option}
          className={optionShellClass(picked === index)}
          data-lr-node={`options/option/${index}`}
        >
          <input
            type="radio"
            name={groupName}
            checked={picked === index}
            disabled={disabled}
            onChange={() => onAnswer({ kind: "choice", index })}
            className="sr-only"
          />
          <OptionBody letter={letterOf(index)} text={option} />
        </label>
      ))}
    </div>
  );
}

/** 多选题：原生 checkbox 列表（再点一次取消；空选视为未答） */
function MultiControls({
  question,
  answer,
  onAnswer,
  disabled = false,
}: {
  question: QuestionPublic;
  answer: StudentAnswer | undefined;
  onAnswer: (answer: StudentAnswer) => void;
  /** 已提交只读（§11-2 原位只读）：隐藏输入同样携带 disabled 语义 */
  disabled?: boolean;
}) {
  const pickedIndexes =
    answer?.kind === "multi" ? answer.indexes : ([] as readonly number[]);
  const toggle = (index: number) => {
    const next = pickedIndexes.includes(index)
      ? pickedIndexes.filter((i) => i !== index)
      : [...pickedIndexes, index];
    onAnswer({ kind: "multi", indexes: next });
  };
  return (
    <fieldset
      aria-label="多选题选项"
      className="m-0 flex flex-col gap-1.5 border-0 p-0"
    >
      {(question.options ?? []).map((option, index) => (
        <label
          key={option}
          className={optionShellClass(pickedIndexes.includes(index))}
          data-lr-node={`options/option/${index}`}
        >
          <input
            type="checkbox"
            checked={pickedIndexes.includes(index)}
            disabled={disabled}
            onChange={() => toggle(index)}
            className="sr-only"
          />
          <OptionBody letter={letterOf(index)} text={option} />
        </label>
      ))}
    </fieldset>
  );
}

/** 正常作答与底图共用题面；导出保持布局但清除个人填答与选中态。 */
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
        inert={mode === "export"}
        className="mx-auto flex w-full min-w-0 flex-col gap-3 text-base leading-[1.75]"
      >
        {/* 题干：判断题剥掉尾部空标记；填空题空位内联输入 */}
        {question.type === "judge" ? (
          <RichMarkdown
            source={judgeStemOf(question.stemMd)}
            className="question-markdown text-base leading-[1.75]"
            lrNodes
          />
        ) : question.type === "fill" ? (
          <BlankAnswersProvider
            state={{
              values: answer?.kind === "fill" ? answer.values : [],
              onChange: (blankIndex, value) =>
                onAnswer(
                  {
                    kind: "fill",
                    values: withBlankValue(
                      answer?.kind === "fill" ? answer.values : [],
                      blankIndex,
                      value,
                    ),
                  },
                  true,
                ),
              disabled: readOnly,
            }}
          >
            <RichMarkdown
              source={question.stemMd}
              className="question-markdown text-base leading-[1.75]"
              lrNodes
            />
          </BlankAnswersProvider>
        ) : question.type === "choice" || question.type === "multi" ? (
          // 选择题：选项在下方按钮里——服务端 stemMd 已是 studentStemMd 投影形态，
          // displayStemMd 兜底剥内嵌列表（防未来新路径漏走投影，重复且 [x] 会显示成打勾框）
          <RichMarkdown
            source={displayStemMd(question)}
            className="question-markdown text-base leading-[1.75]"
            lrNodes
          />
        ) : null}
        )}

        {/* 作答控件 */}
        {question.type === "judge" && (
          <JudgeControls
            question={question}
            answer={answer}
            onAnswer={update}
            disabled={readOnly}
          />
        )}
        {question.type === "choice" && (
          <ChoiceControls
            question={question}
            answer={answer}
            onAnswer={update}
            disabled={readOnly}
          />
        )}
        {question.type === "multi" && (
          <MultiControls
            question={question}
            answer={answer}
            onAnswer={update}
            disabled={readOnly}
          />
        )}
        {/* 新题型（matching/ordering 等 QM 类型）整卡走作答登记表 dispatchInput
            单源（题干带槽位渲染与各型控件）；judge/fill/choice/multi 已由上方
            原位控件承担（LR 节点锚定），不重复登记 */}
        {question.type !== "judge" &&
          question.type !== "fill" &&
          question.type !== "choice" &&
          question.type !== "multi" &&
          dispatchInput(prepared, answer, update, readOnly)}
      </div>
    </QuestionSurfaceFrame>
  );
});
