import type {
  HintOpenedEntry,
  QuestionPublic,
  StudentAnswer,
} from "@tutor/contract";
import {
  CircleAlert,
  Flag,
  MoreHorizontal,
  NotebookPen,
  Pencil,
} from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AnnotationLayer } from "@/features/annotation/AnnotationLayer";
import { useAnnotationRecord } from "@/features/annotation/use-annotation-record";
import { useEnabledCapabilities } from "@/features/capability/enabled-capabilities";
import { NoteLayer } from "@/features/notes/NoteLayer";
import { NOTE_STACK_ROW_STYLE } from "@/features/notes/note-layout";
import { useNoteRecord } from "@/features/notes/use-note-record";
import {
  HANDWRITTEN_TYPES,
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "./answer-format";
import {
  HandwrittenControls,
  type HandwrittenControlsProps,
} from "./HandwrittenControls";
import { HintPanel } from "./HintPanel";
import { QuestionSurface } from "./QuestionSurface";
import { completionLabel, getQuestionCompletion } from "./question-completion";

/**
 * 答题页题卡（T2.6）：题号、题型徽章（中文）、难度星、考点 tag、题干
 * （RichMarkdown 渲染；填空题 [[…]] 空位变内联输入框）与各题型作答控件。
 * 手写题（solve/apply/find-error）的作答控件在 HandwrittenControls（T2.8：
 * 展开手写区 + 全屏作答 + 最终答案/MathLive，含笔迹上传状态机）。
 * T2.11：hintCount>0 且提供解锁回调时渲染分步提示面板（HintPanel）。
 * 草稿固定在题干下方整宽，展开不改变题面换行和标画坐标。
 * 触控目标全部 ≥44px（ui-conventions）；judge 题干尾部 [[]] 脱敏框剥掉
 * （对错由按钮作答，空框反而误导）。
 */

/** 题头元信息：题号 + 题型徽章 + 难度星 + 考点 tag */
function QuestionMeta({
  index,
  question,
  answer,
  flagged,
  onToggleFlag,
  formalInkPresence,
  tools,
}: {
  index: number;
  question: QuestionPublic;
  answer: StudentAnswer | undefined;
  flagged: boolean;
  onToggleFlag: (() => void) | undefined;
  formalInkPresence: boolean;
  tools: {
    annotationOpen: boolean;
    paperOpen: boolean;
    paperEnabled: boolean;
    annotationCount: number;
    paperCount: number;
    annotationProblem: boolean;
    paperProblem: boolean;
    toggleAnnotation: () => void;
    togglePaper: () => void;
  } | null;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <>
      <div
        data-slot="question-header"
        className="flex min-h-11 items-start justify-between gap-2 sm:items-center"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <span>第 {index + 1} 题</span>
          </p>
          <span
            className={`rounded-md px-2 py-1 text-xs font-medium ${QUESTION_TYPE_BADGE_CLASS[question.type]}`}
          >
            {QUESTION_TYPE_LABELS[question.type]}
          </span>
          <span className="w-full text-xs text-muted-foreground sm:w-auto">
            {completionLabel(
              getQuestionCompletion(question, answer, formalInkPresence),
            )}
          </span>
          {flagged && (
            <Flag
              aria-label="待检查"
              className="size-3.5 fill-primary text-primary"
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {tools && (
            <Button
              type="button"
              variant="ghost"
              className="size-11 p-0"
              title="圈画题干"
              aria-label={`第 ${index + 1} 题圈画题干${tools.annotationCount > 0 ? `（已有 ${tools.annotationCount} 笔）` : ""}${tools.annotationProblem ? "，同步需处理" : ""}`}
              aria-expanded={tools.annotationOpen}
              onClick={tools.toggleAnnotation}
            >
              {tools.annotationProblem ? (
                <CircleAlert aria-hidden className="size-4 text-amber-600" />
              ) : (
                <Pencil
                  aria-hidden
                  className={`size-4 ${tools.annotationOpen || tools.annotationCount > 0 ? "text-primary" : ""}`}
                />
              )}
            </Button>
          )}
          {tools?.paperEnabled && (
            <Button
              type="button"
              variant="ghost"
              className="size-11 p-0"
              title={
                HANDWRITTEN_TYPES.has(question.type) ? "手写作答" : "草稿纸"
              }
              aria-label={`第 ${index + 1} 题${HANDWRITTEN_TYPES.has(question.type) ? "手写作答" : "草稿纸"}${tools.paperCount > 0 || formalInkPresence ? "（已有笔迹）" : ""}${tools.paperProblem ? "，同步需处理" : ""}`}
              aria-expanded={tools.paperOpen}
              onClick={tools.togglePaper}
            >
              {tools.paperProblem ? (
                <CircleAlert aria-hidden className="size-4 text-amber-600" />
              ) : (
                <NotebookPen
                  aria-hidden
                  className={`size-4 ${tools.paperOpen || tools.paperCount > 0 || formalInkPresence ? "text-primary" : ""}`}
                />
              )}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="size-11 p-0"
                title="更多"
                aria-label={`第 ${index + 1} 题更多`}
              >
                <MoreHorizontal aria-hidden className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => setDetailsOpen((value) => !value)}
              >
                {detailsOpen ? "收起题目资料" : "题目资料"}
              </DropdownMenuItem>
              {onToggleFlag && (
                <DropdownMenuItem
                  role="menuitemcheckbox"
                  aria-checked={flagged}
                  onSelect={onToggleFlag}
                >
                  <Flag aria-hidden />
                  待检查
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {detailsOpen && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
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
      )}
    </>
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
  flagged = false,
  onToggleFlag,
  formalInkPresence = false,
  onInkPresenceChange,
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
  flagged?: boolean;
  onToggleFlag?: () => void;
  formalInkPresence?: boolean;
  onInkPresenceChange?: HandwrittenControlsProps["onInkPresenceChange"];
}) {
  // T7.7：教师关闭手写辅助（ink）时草稿纸入口一并隐藏——草稿纸是 ink 辅助
  // 入口（已有草稿数据保留服务端，恢复开关后回来看）。
  const { ink: inkEnabled } = useEnabledCapabilities();
  const articleRef = useRef<HTMLElement | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [annotationOpen, setAnnotationOpen] = useState(false);
  const annotationRecord = useAnnotationRecord(attemptId ?? "", question.id);
  const noteRecord = useNoteRecord(attemptId ?? "", question.id);
  const noteLayer =
    inkEnabled &&
    attemptId !== undefined &&
    !HANDWRITTEN_TYPES.has(question.type) ? (
      <NoteLayer
        attemptId={attemptId}
        questionId={question.id}
        open={noteOpen}
        onOpenChange={setNoteOpen}
        ariaPrefix={`第 ${index + 1} 题`}
        showTrigger={false}
      />
    ) : null;

  /** 题面、正式作答与辅助内容保持稳定的组件身份。 */
  const questionBody = (
    <>
      <QuestionSurface
        question={question}
        answer={answer}
        onAnswer={onAnswer}
      />

      {HANDWRITTEN_TYPES.has(question.type) && attemptId !== undefined && (
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
          onInkPresenceChange={onInkPresenceChange}
          expanded={noteOpen}
          onExpandedChange={setNoteOpen}
          showExpandTrigger={false}
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

      {/* T6R.20 题干标注（圈画题干）：所有题型的附加折叠区——标注模式外
          保留原作答控件（方案 §10）；base ready 才挂画布（层内 gate） */}
      {attemptId !== undefined && (
        <AnnotationLayer
          attemptId={attemptId}
          questionId={question.id}
          ariaPrefix={`第 ${index + 1} 题`}
          open={annotationOpen}
          onOpenChange={setAnnotationOpen}
          showTrigger={false}
        />
      )}
    </>
  );

  return (
    <article
      ref={articleRef}
      data-question-id={question.id}
      tabIndex={-1}
      className="flex scroll-mt-[calc(var(--attempt-header-height,64px)+12px)] flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary sm:p-5"
      aria-label={`第 ${index + 1} 题`}
    >
      <QuestionMeta
        index={index}
        question={question}
        answer={answer}
        flagged={flagged}
        onToggleFlag={onToggleFlag}
        formalInkPresence={formalInkPresence}
        tools={
          attemptId === undefined
            ? null
            : {
                annotationOpen,
                paperOpen: noteOpen,
                paperEnabled: inkEnabled,
                annotationCount: annotationRecord?.doc?.strokes.length ?? 0,
                paperCount: noteRecord?.doc?.ink.strokes.length ?? 0,
                annotationProblem:
                  annotationRecord?.conflict != null ||
                  annotationRecord?.denied != null ||
                  annotationRecord?.local === "failed",
                paperProblem:
                  noteRecord?.conflict != null ||
                  noteRecord?.denied != null ||
                  noteRecord?.local === "failed",
                toggleAnnotation: () => setAnnotationOpen((value) => !value),
                togglePaper: () => setNoteOpen((value) => !value),
              }
        }
      />
      <div
        data-slot="note-body-row"
        data-layout="below"
        className="flex"
        style={NOTE_STACK_ROW_STYLE}
      >
        <div className="flex min-w-0 flex-col gap-4">{questionBody}</div>
        <div className="min-w-0">{noteLayer}</div>
      </div>
    </article>
  );
}
