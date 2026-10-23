import type { PublicOption } from "@tutor/contract";
import { dispatchBehavior, emptyPublicStructure } from "@tutor/contract";
import { displayStemMd } from "@tutor/md-dsl";
import { cn } from "cn";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { formatReferenceAnswers, letterOf } from "../../attempt/answer-format";
import type { QuestionCompletion } from "../../attempt/question-completion";
import type {
  AnswerKindView,
  PreparedOf,
  ReferenceOfKind,
  StudentAnswerOfKind,
} from "../types";
import { AnswerComparisonShell, referenceColumnOf } from "./comparison";

/**
 * choice/multi 呈现（UA-03 从 QuestionSurface/AttemptResultParts/
 * AttemptDetailQuestionCard/wrong-questions-ui 原代码抽取，DOM/class/文案
 * 逐字不变，I11）。choice 与 multi 共用本文件（两键引用同实现族，与纯行为
 * 层 choice/multi 同款）；输入保持原生 radio/checkbox 语义（不合并为万能
 * selection 类型，§1）。
 */

/** 选项按钮的公共外壳（单选/多选共用；触控 ≥44px；has-[:checked] 联动选中态） */
function optionShellClass(selected: boolean): string {
  return cn(
    "flex min-h-12 w-full cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 text-left outline-none transition-colors has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
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
        <span className="sr-only">选项</span> {letter}
      </span>
      <RichMarkdown
        source={text}
        className="min-w-0 flex-1 text-base leading-[1.75]"
      />
    </>
  );
}

/**
 * 选择题题干的显示源（displayStemMd 同口径）：服务端 stemMd 已是
 * studentStemMd 投影形态（选项列表已剥），此处兜底剥内嵌列表——防未来新
 * 路径漏走投影后重复且 [x] 显示成打勾框。displayStemMd 的 options 存在性
 * 分支在 PreparedQuestion 上不可重建（模型不保留 presence），按
 * options.length>0 重建；差异仅在「options=[] 且题干含任务项列表」的边角
 * （现网无自然路径，见决策记录 TT-03 UA-03）。
 */
function choiceStemSourceOf(model: {
  readonly stemMd: string;
  readonly options: readonly PublicOption[];
}): string {
  return displayStemMd({
    stemMd: model.stemMd,
    options:
      model.options.length > 0 ? model.options.map((o) => o.text) : undefined,
  });
}

/** 单选题：原生标签提供字母及正文，保留公式的可访问语义。 */
function ChoiceControls({
  model,
  answer,
  update,
  disabled = false,
}: {
  model: PreparedOf<"choice">;
  answer: StudentAnswerOfKind<"choice"> | undefined;
  update: (answer: StudentAnswerOfKind<"choice">, defer?: boolean) => void;
  /** 已提交只读（§11-2 原位只读）：隐藏输入同样携带 disabled 语义 */
  disabled?: boolean;
}) {
  const picked = answer === undefined ? undefined : answer.index;
  const groupName = `choice-${model.scopeId}`;
  return (
    <div className="flex flex-col gap-2" role="radiogroup" aria-label="选项">
      {model.options.map((option) => (
        // key 由序号派生（§4.2 旧题规则 opt-N）：重复选项文本不再冲突告警
        <label
          key={option.key}
          className={optionShellClass(picked === option.index)}
        >
          <input
            type="radio"
            name={groupName}
            checked={picked === option.index}
            disabled={disabled}
            onChange={() =>
              update({ kind: "choice", index: option.index }, undefined)
            }
            className="sr-only"
          />
          <OptionBody letter={letterOf(option.index)} text={option.text} />
        </label>
      ))}
    </div>
  );
}

/** 多选题：原生 checkbox 列表（再点一次取消；空选视为未答；勾选顺序不排序 I04） */
function MultiControls({
  model,
  answer,
  update,
  disabled = false,
}: {
  model: PreparedOf<"multi">;
  answer: StudentAnswerOfKind<"multi"> | undefined;
  update: (answer: StudentAnswerOfKind<"multi">, defer?: boolean) => void;
  /** 已提交只读（§11-2 原位只读）：隐藏输入同样携带 disabled 语义 */
  disabled?: boolean;
}) {
  const pickedIndexes = answer === undefined ? [] : answer.indexes;
  const toggle = (index: number) => {
    const next = pickedIndexes.includes(index)
      ? pickedIndexes.filter((i) => i !== index)
      : [...pickedIndexes, index];
    update({ kind: "multi", indexes: next }, undefined);
  };
  return (
    <fieldset
      aria-label="多选题选项"
      className="m-0 flex flex-col gap-2 border-0 p-0"
    >
      {model.options.map((option) => (
        // key 由序号派生（§4.2 旧题规则 opt-N）：重复选项文本不再冲突告警
        <label
          key={option.key}
          className={optionShellClass(pickedIndexes.includes(option.index))}
        >
          <input
            type="checkbox"
            checked={pickedIndexes.includes(option.index)}
            disabled={disabled}
            onChange={() => toggle(option.index)}
            className="sr-only"
          />
          <OptionBody letter={letterOf(option.index)} text={option.text} />
        </label>
      ))}
    </fieldset>
  );
}

// ---------- 选项对照（三处重复实现的合并单一出处，§10.1 UA-03） ----------

/** 选项对照的呈现变体（后台布局仍由宿主管理——§2；文案/配色参数化沿 VerdictBadge 先例） */
export type OptionComparisonVariant =
  /** 学生结果视图/逐题反馈/讲练结果态（原 ResultOptions）：正确项装饰 + 本人选择，未公布中性 */
  | "student"
  /** 教师批改详情（原 DetailOptions）：正确项 + 学生选择，教师主题配色 */
  | "teacher"
  /** 错题本（原 WrongOptions）：仅正确项标记，本人选择不回显（答案是文本行） */
  | "wrong";

/**
 * 选项对照行（choice/multi）：合并原 ResultOptions（学生结果视图）/
 * DetailOptions（教师批改详情）/WrongOptions（错题本）三处重复实现——语义
 * 单源（字母、正确项集合、本人选择集合、公布门控与标签文案），布局变体经
 * variant 参数区分；key 用选项 key（opt-N，重复文本不冲突）。
 */
export function OptionComparisonList({
  options,
  picked,
  correct,
  variant,
  released = true,
}: {
  options: readonly PublicOption[];
  /** 本人选择（teacher 变体展示为「学生选择」；wrong 变体不展示本人选择） */
  picked: readonly number[];
  /** 参考正确项（student 变体仅在 released 时参与装饰，其余恒展示） */
  correct: readonly number[];
  variant: OptionComparisonVariant;
  /** 公布门控（仅 student 变体消费：未公布时正确项不装饰、本人选择中性） */
  released?: boolean;
}) {
  return (
    <ol className="flex flex-col gap-1.5" aria-label="选项">
      {options.map((option) => {
        const isPicked = picked.includes(option.index);
        const isCorrect =
          variant === "student"
            ? released && correct.includes(option.index)
            : correct.includes(option.index);
        return (
          <li
            key={option.key}
            className={cn(
              "flex min-h-11 items-start gap-2 rounded-lg border px-3 py-2 text-sm",
              variant === "student" && "flex-wrap",
              optionRowClass(variant, { isCorrect, isPicked, released }),
            )}
          >
            <span className="mt-0.5 w-5 shrink-0 font-semibold">
              {letterOf(option.index)}
            </span>
            <RichMarkdown
              source={option.text}
              className={cn(
                "min-w-0 flex-1",
                variant === "student" ? "text-base [&_p]:my-0" : "text-sm",
              )}
            />
            {isCorrect && variant !== "teacher" && (
              <span className="shrink-0 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                {variant === "student" && isPicked
                  ? "正确项 · 你的选择"
                  : "正确项"}
              </span>
            )}
            {isCorrect && variant === "teacher" && (
              <span className="shrink-0 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                正确项
              </span>
            )}
            {variant === "student" && isPicked && !isCorrect && (
              <span
                className={cn(
                  "shrink-0 text-xs font-medium",
                  released
                    ? "text-red-700 dark:text-red-300"
                    : "text-foreground",
                )}
              >
                你的选择
              </span>
            )}
            {variant === "teacher" && isPicked && (
              <span className="shrink-0 text-xs font-medium text-sky-700 dark:text-sky-300">
                学生选择
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** 选项行配色（三变体各自的现网配色逐字保持；student 未公布=本人选中中性） */
function optionRowClass(
  variant: OptionComparisonVariant,
  state: { isCorrect: boolean; isPicked: boolean; released: boolean },
): string {
  if (variant === "student") {
    if (state.isCorrect)
      return "border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10";
    if (state.isPicked && state.released)
      return "border-red-300 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10";
    if (state.isPicked) return "border-primary bg-primary/5";
    return "border-transparent";
  }
  if (variant === "teacher") {
    return state.isPicked
      ? "border-sky-300 bg-sky-50 dark:border-sky-500/40 dark:bg-sky-500/10"
      : "border-border";
  }
  // wrong：仅正确项装饰，其余透明
  return state.isCorrect
    ? "border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10"
    : "border-transparent";
}

// ---------- 登记表视图（choice / multi 两键） ----------

function choiceCompletion(
  model: PreparedOf<"choice">,
  answer: StudentAnswerOfKind<"choice"> | undefined,
): QuestionCompletion {
  const filled =
    answer !== undefined &&
    answer.index >= 0 &&
    answer.index < model.options.length;
  return filled
    ? { state: "filled", filledSlots: 1, expectedSlots: 1 }
    : { state: "empty", filledSlots: 0, expectedSlots: 1 };
}

function multiCompletion(
  model: PreparedOf<"multi">,
  answer: StudentAnswerOfKind<"multi"> | undefined,
): QuestionCompletion {
  const filled =
    answer !== undefined &&
    answer.indexes.some((index) => index >= 0 && index < model.options.length);
  return filled
    ? { state: "filled", filledSlots: 1, expectedSlots: 1 }
    : { state: "empty", filledSlots: 0, expectedSlots: 1 };
}

export const choiceView: AnswerKindView<
  StudentAnswerOfKind<"choice">,
  PreparedOf<"choice">,
  ReferenceOfKind<"choice">
> = {
  Input: ({ model, answer, update, disabled = false }) => (
    <>
      <RichMarkdown
        source={choiceStemSourceOf(model)}
        className="text-base leading-[1.75]"
      />
      <ChoiceControls
        model={model}
        answer={answer}
        update={update}
        disabled={disabled}
      />
    </>
  ),
  ReadOnly: ({ answer }) => (
    <p className="break-words font-medium [overflow-wrap:anywhere]">
      {answer === undefined
        ? "未作答"
        : dispatchBehavior(answer, "display", emptyPublicStructure)}
    </p>
  ),
  Reference: ({ reference }) => (
    <RichMarkdown
      source={formatReferenceAnswers(reference)}
      className="min-w-0 font-medium [&_p]:my-0"
    />
  ),
  Comparison: ({ model, answer, reference }) => (
    <AnswerComparisonShell
      ownColumn={choiceView.ReadOnly({ model, answer })}
      referenceColumn={referenceColumnOf(reference, (ref) =>
        choiceView.Reference({ model, reference: ref }),
      )}
    />
  ),
  completion: choiceCompletion,
};

export const multiView: AnswerKindView<
  StudentAnswerOfKind<"multi">,
  PreparedOf<"multi">,
  ReferenceOfKind<"multi">
> = {
  Input: ({ model, answer, update, disabled = false }) => (
    <>
      <RichMarkdown
        source={choiceStemSourceOf(model)}
        className="text-base leading-[1.75]"
      />
      <MultiControls
        model={model}
        answer={answer}
        update={update}
        disabled={disabled}
      />
    </>
  ),
  ReadOnly: ({ answer }) => (
    <p className="break-words font-medium [overflow-wrap:anywhere]">
      {answer === undefined
        ? "未作答"
        : dispatchBehavior(answer, "display", emptyPublicStructure)}
    </p>
  ),
  Reference: ({ reference }) => (
    <RichMarkdown
      source={formatReferenceAnswers(reference)}
      className="min-w-0 font-medium [&_p]:my-0"
    />
  ),
  Comparison: ({ model, answer, reference }) => (
    <AnswerComparisonShell
      ownColumn={multiView.ReadOnly({ model, answer })}
      referenceColumn={referenceColumnOf(reference, (ref) =>
        multiView.Reference({ model, reference: ref }),
      )}
    />
  ),
  completion: multiCompletion,
};
