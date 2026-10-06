import type {
  HintOpenedEntry,
  QuestionPublic,
  StudentAnswer,
} from "@tutor/contract";
import { displayStemMd } from "@tutor/md-dsl";
import { cn } from "cn";
import { Check, X } from "lucide-react";
import { useRef, useState } from "react";
import { BlankAnswersProvider } from "@/features/markdown/BlankAnswersContext";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { NoteLayer } from "@/features/notes/NoteLayer";
import {
  effectiveNoteLayout,
  useNoteLayoutPreference,
  useObservedCssWidth,
} from "@/features/notes/note-layout";
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
import { HintPanel } from "./HintPanel";

/**
 * 答题页题卡（T2.6）：题号、题型徽章（中文）、难度星、考点 tag、题干
 * （RichMarkdown 渲染；填空题 [[…]] 空位变内联输入框）与各题型作答控件。
 * 手写题（solve/apply/find-error）的作答控件在 HandwrittenControls（T2.8：
 * 展开手写区 + 全屏作答 + 最终答案/MathLive，含笔迹上传状态机）。
 * T2.11：hintCount>0 且提供解锁回调时渲染分步提示面板（HintPanel）。
 * T6R.9：非手写题接入题卡草稿层（NoteLayer）——展开且容器够宽时题干 55%
 * 与草稿 45% 侧栏分栏（方案 §4.3；阈值见 note-layout），窄容器/收起时
 * 草稿在题干下方整宽（below）；布局切换只改外框，不新建笔记不改正文身份。
 * 触控目标全部 ≥44px（ui-conventions）；judge 题干尾部 [[]] 脱敏框剥掉
 * （对错由按钮作答，空框反而误导）。
 */

/** 手写题型：作答 ink 走 HandwrittenControls，不接草稿层 */
const HANDWRITTEN_TYPES = new Set<QuestionPublic["type"]>([
  "solve",
  "apply",
  "find-error",
]);

/** 判断题题干尾部的空标记（studentStemMd 投影把 [[正确]] 脱敏成 [[]]） */
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
      <p className="flex items-center gap-2 text-sm font-semibold">
        <span
          aria-hidden
          className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground"
        >
          {index + 1}
        </span>
        <span>第 {index + 1} 题</span>
      </p>
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
  onInkEdit,
  onInkFullscreen,
  hints,
  onHintUnlocked,
}: {
  /** 题号（0 起，展示 +1） */
  index: number;
  question: QuestionPublic;
  /** 本题当前答案（undefined=未作答） */
  answer: StudentAnswer | undefined;
  /** 作答回调（defer 交给控件语义：文本类防抖、离散类立即） */
  onAnswer: (answer: StudentAnswer, defer?: boolean) => void;
  /** attempt id（手写题笔迹上传与分步提示用；客观题忽略） */
  attemptId?: string;
  /** 交卷 flush 用：手写题上传 controller 注册（透传 HandwrittenControls） */
  registerInkController?: HandwrittenControlsProps["registerController"];
  /** 手写笔画批次回调（T2.10 ink_stroke_batch 埋点，透传 HandwrittenControls） */
  onInkStroke?: HandwrittenControlsProps["onInkStroke"];
  /** 手写编辑操作回调（T4.0b ink_edit_batch 埋点，透传 HandwrittenControls） */
  onInkEdit?: HandwrittenControlsProps["onInkEdit"];
  /** 全屏进出回调（T4.0b ink_fullscreen 埋点，透传 HandwrittenControls） */
  onInkFullscreen?: HandwrittenControlsProps["onInkFullscreen"];
  /** 已解锁提示（T2.11；缺省按未解锁处理） */
  hints?: readonly HintOpenedEntry[];
  /** 提示解锁成功回调（T2.11；与 attemptId 同时提供才渲染提示面板） */
  onHintUnlocked?: (entry: HintOpenedEntry) => void;
}) {
  const plainAnswer = (next: StudentAnswer) => onAnswer(next);

  // T6R.9 草稿层：非手写题 + 作答语境（attemptId）；布局按题卡实测宽度
  // （auto 档宽容器 side / 窄容器 below；显式偏好见 note-layout）
  const articleRef = useRef<HTMLElement | null>(null);
  const cardWidth = useObservedCssWidth(articleRef);
  const layoutPref = useNoteLayoutPreference();
  const layout = effectiveNoteLayout(layoutPref, cardWidth);
  const [noteOpen, setNoteOpen] = useState(false);
  const noteLayer =
    attemptId !== undefined && !HANDWRITTEN_TYPES.has(question.type) ? (
      <NoteLayer
        attemptId={attemptId}
        questionId={question.id}
        open={noteOpen}
        onOpenChange={setNoteOpen}
        ariaPrefix={`第 ${index + 1} 题`}
      />
    ) : null;

  /** 题干 + 作答控件 + 提示面板（侧栏分栏时的左列内容） */
  const questionBody = (
    <>
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
            onInkEdit={onInkEdit}
            onInkFullscreen={onInkFullscreen}
          />
        )}

      {/* 分步提示（T2.11）：hintCount>0 且提供解锁回调（页面持有已解锁状态） */}
      {question.hintCount > 0 &&
        attemptId !== undefined &&
        onHintUnlocked !== undefined && (
          <HintPanel
            attemptId={attemptId}
            questionId={question.id}
            hintCount={question.hintCount}
            hints={hints ?? []}
            onUnlocked={onHintUnlocked}
          />
        )}
    </>
  );

  // 侧栏分栏（方案 §4.3 初值 55/45；gap-6=24px 与 NOTE_LAYOUT_GAP_CSS_PX 同值）：
  // 仅草稿展开且容器够宽时两列；收起/窄容器回到题干下方整宽（below）
  const sideBySide = noteLayer !== null && noteOpen && layout === "side";

  return (
    <article
      ref={articleRef}
      className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-xs sm:p-5"
      aria-label={`第 ${index + 1} 题`}
    >
      <QuestionMeta index={index} question={question} />
      {sideBySide ? (
        <div data-slot="note-side-columns" className="flex items-start gap-6">
          <div className="flex w-[55%] min-w-0 flex-col gap-4">
            {questionBody}
          </div>
          <div className="min-w-0 flex-1">{noteLayer}</div>
        </div>
      ) : (
        <>
          {questionBody}
          {noteLayer}
        </>
      )}
    </article>
  );
}
