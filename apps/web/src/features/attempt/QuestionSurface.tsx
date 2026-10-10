import type { QuestionPublic, StudentAnswer } from "@tutor/contract";
import { displayStemMd } from "@tutor/md-dsl";
import { cn } from "cn";
import { Check, X } from "lucide-react";
import { BlankAnswersProvider } from "@/features/markdown/BlankAnswersContext";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { letterOf, withBlankValue } from "./answer-format";

/** 判断题题干尾部的空标记（studentStemMd 投影把 [[正确]] 脱敏成 [[]]） */
function judgeStemOf(stemMd: string): string {
  return stemMd.replace(/\s*\[\[\]\]\s*$/, "（　）");
}

/** 选项按钮的公共外壳（单选/多选共用；触控 ≥44px；has-[:checked] 联动选中态） */
function optionShellClass(selected: boolean): string {
  return cn(
    "flex min-h-12 w-full cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 text-left outline-none transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
    selected
      ? "border-primary bg-primary/5 ring-1 ring-primary"
      : "border-border bg-card hover:border-primary/40 hover:bg-accent/40",
  );
}

/** 单个选项的内容（字母 + Markdown/公式文本） */
function OptionBody({ letter, text }: { letter: string; text: string }) {
  return (
    <>
      <span className="mt-0.5 w-5 shrink-0 text-sm font-semibold">
        {letter}
      </span>
      <RichMarkdown source={text} className="min-w-0 flex-1 text-base" />
    </>
  );
}

/** 判断题：对/错两个大按钮（原生 radio 语义，组内互斥） */
function JudgeControls({
  question,
  answer,
  onAnswer,
}: {
  question: QuestionPublic;
  answer: StudentAnswer | undefined;
  onAnswer: (answer: StudentAnswer) => void;
}) {
  const picked =
    answer?.kind === "judge" && typeof answer.value === "boolean"
      ? answer.value
      : undefined;
  const groupName = `judge-${question.id}`;
  const labelClass = (selected: boolean) =>
    cn(
      "flex min-h-12 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border-2 text-base font-medium outline-none transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
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
          onChange={() => onAnswer({ kind: "judge", value: true })}
          className="sr-only"
        />
        <span className="flex items-center gap-2">
          {picked === true && <Check aria-hidden className="size-5" />}对
        </span>
      </label>
      <label className={labelClass(picked === false)}>
        <input
          type="radio"
          name={groupName}
          aria-label="错"
          checked={picked === false}
          onChange={() => onAnswer({ kind: "judge", value: false })}
          className="sr-only"
        />
        <span className="flex items-center gap-2">
          {picked === false && <X aria-hidden className="size-5" />}错
        </span>
      </label>
    </div>
  );
}

/** 单选题：原生 radio 选项列表（aria-label 按字母播报，公式内容读屏不可靠） */
function ChoiceControls({
  question,
  answer,
  onAnswer,
}: {
  question: QuestionPublic;
  answer: StudentAnswer | undefined;
  onAnswer: (answer: StudentAnswer) => void;
}) {
  const picked = answer?.kind === "choice" ? answer.index : undefined;
  return (
    <div className="flex flex-col gap-2" role="radiogroup" aria-label="选项">
      {(question.options ?? []).map((option, index) => (
        <label key={option} className={optionShellClass(picked === index)}>
          <input
            type="radio"
            name={`choice-${question.id}`}
            aria-label={`选项 ${letterOf(index)}`}
            checked={picked === index}
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
}: {
  question: QuestionPublic;
  answer: StudentAnswer | undefined;
  onAnswer: (answer: StudentAnswer) => void;
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
      className="m-0 flex flex-col gap-2 border-0 p-0"
    >
      {(question.options ?? []).map((option, index) => (
        <label
          key={option}
          className={optionShellClass(pickedIndexes.includes(index))}
        >
          <input
            type="checkbox"
            aria-label={`选项 ${letterOf(index)}`}
            checked={pickedIndexes.includes(index)}
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
export function QuestionSurface({
  question,
  answer: suppliedAnswer,
  onAnswer: suppliedOnAnswer,
  mode = "answer",
}: {
  question: QuestionPublic;
  answer?: StudentAnswer | undefined;
  onAnswer?: ((answer: StudentAnswer, defer?: boolean) => void) | undefined;
  mode?: "answer" | "export";
}) {
  const answer = mode === "export" ? undefined : suppliedAnswer;
  const onAnswer = (next: StudentAnswer, defer?: boolean) => {
    if (mode === "answer") suppliedOnAnswer?.(next, defer);
  };
  const plainAnswer = (next: StudentAnswer) => onAnswer(next);
  return (
    <div
      data-slot="question-surface"
      className="flex min-w-0 flex-col gap-4 text-base leading-7"
    >
      {/* 题干：判断题剥掉尾部空标记；填空题空位内联输入 */}
      {question.type === "judge" ? (
        <RichMarkdown
          source={judgeStemOf(question.stemMd)}
          className="text-base"
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
            disabled: false,
          }}
        >
          <RichMarkdown source={question.stemMd} className="text-base" />
        </BlankAnswersProvider>
      ) : question.type === "choice" || question.type === "multi" ? (
        // 选择题：选项在下方按钮里——服务端 stemMd 已是 studentStemMd 投影形态，
        // displayStemMd 兜底剥内嵌列表（防未来新路径漏走投影，重复且 [x] 会显示成打勾框）
        <RichMarkdown source={displayStemMd(question)} className="text-base" />
      ) : (
        <RichMarkdown source={question.stemMd} className="text-base" />
      )}

      {/* 作答控件 */}
      {question.type === "judge" && (
        <JudgeControls
          question={question}
          answer={answer}
          onAnswer={plainAnswer}
        />
      )}
      {question.type === "choice" && (
        <ChoiceControls
          question={question}
          answer={answer}
          onAnswer={plainAnswer}
        />
      )}
      {question.type === "multi" && (
        <MultiControls
          question={question}
          answer={answer}
          onAnswer={plainAnswer}
        />
      )}
    </div>
  );
}
