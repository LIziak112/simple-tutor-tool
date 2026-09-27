import type { QuestionPublic, StudentAnswer } from "@tutor/contract";
import { cn } from "cn";
import { Check, X } from "lucide-react";
import { BlankAnswersProvider } from "@/features/markdown/BlankAnswersContext";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import {
  letterOf,
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
  withBlankValue,
} from "./answer-format";
import {
  HandwrittenControls,
  type HandwrittenControlsProps,
} from "./HandwrittenControls";

/**
 * 答题页题卡（T2.6）：题号、题型徽章（中文）、难度星、考点 tag、题干
 * （RichMarkdown 渲染；填空题 [[…]] 空位变内联输入框）与各题型作答控件。
 * 手写题（solve/apply/find-error）的作答控件在 HandwrittenControls（T2.8：
 * 展开手写区 + 全屏作答 + 最终答案/MathLive，含笔迹上传状态机）。
 * 触控目标全部 ≥44px（ui-conventions）；judge 题干尾部 [[]] 脱敏框剥掉
 * （对错由按钮作答，空框反而误导）。
 */

/** 判断题题干尾部的空标记（publicStemMd 把 [[正确]] 脱敏成 [[]]） */
function judgeStemOf(stemMd: string): string {
  return stemMd.replace(/\s*\[\[\]\]\s*$/, "（　）");
}

/** 题头元信息：题号 + 题型徽章 + 难度星 + 考点 tag */
function QuestionMeta({
  index,
  question,
}: {
  index: number;
  question: QuestionPublic;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p className="text-sm font-semibold">第 {index + 1} 题</p>
      <span
        className={`rounded-full px-2.5 py-1 text-xs font-medium ${QUESTION_TYPE_BADGE_CLASS[question.type]}`}
      >
        {QUESTION_TYPE_LABELS[question.type]}
      </span>
      <span
        role="img"
        className="text-xs text-amber-500"
        aria-label={`难度 ${question.difficulty} 星（满分 5 星）`}
      >
        {"★".repeat(question.difficulty)}
        <span className="text-muted-foreground/60">
          {"★".repeat(5 - question.difficulty)}
        </span>
      </span>
      {question.knowledge.map((name) => (
        <span
          key={name}
          className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
        >
          {name}
        </span>
      ))}
    </div>
  );
}

/** 选项按钮的公共外壳（单选/多选共用；触控 ≥44px；has-[:checked] 联动选中态） */
function optionShellClass(selected: boolean): string {
  return cn(
    "flex min-h-14 w-full cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 text-left outline-none transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
    selected
      ? "border-primary bg-primary/5"
      : "border-border bg-card hover:bg-muted/60",
  );
}

/** 单个选项的内容（字母 + Markdown/公式文本） */
function OptionBody({ letter, text }: { letter: string; text: string }) {
  return (
    <>
      <span className="mt-0.5 w-5 shrink-0 text-sm font-semibold">
        {letter}
      </span>
      <RichMarkdown source={text} className="min-w-0 flex-1 text-sm" />
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
      "flex min-h-14 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border-2 text-base font-medium outline-none transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
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

/** 答题页题卡本体 */
export function AttemptQuestionCard({
  index,
  question,
  answer,
  onAnswer,
  attemptId,
  registerInkController,
  onInkStroke,
}: {
  /** 题号（0 起，展示 +1） */
  index: number;
  question: QuestionPublic;
  /** 本题当前答案（undefined=未作答） */
  answer: StudentAnswer | undefined;
  /** 作答回调（defer 交给控件语义：文本类防抖、离散类立即） */
  onAnswer: (answer: StudentAnswer, defer?: boolean) => void;
  /** attempt id（手写题笔迹上传用；客观题忽略） */
  attemptId?: string;
  /** 交卷 flush 用：手写题上传 controller 注册（透传 HandwrittenControls） */
  registerInkController?: HandwrittenControlsProps["registerController"];
  /** 手写笔画批次回调（T2.10 ink_stroke_batch 埋点，透传 HandwrittenControls） */
  onInkStroke?: HandwrittenControlsProps["onInkStroke"];
}) {
  const plainAnswer = (next: StudentAnswer) => onAnswer(next);

  return (
    <article
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 text-card-foreground sm:p-5"
      aria-label={`第 ${index + 1} 题`}
    >
      <QuestionMeta index={index} question={question} />

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
      {(question.type === "solve" ||
        question.type === "apply" ||
        question.type === "find-error") &&
        attemptId !== undefined && (
          <HandwrittenControls
            attemptId={attemptId}
            questionId={question.id}
            stemMd={question.stemMd}
            answer={answer}
            onAnswer={onAnswer}
            registerController={registerInkController}
            onInkStroke={onInkStroke}
          />
        )}
    </article>
  );
}
