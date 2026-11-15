import type { QuestionPublic, StudentAnswer } from "@tutor/contract";
import {
  CircleAlert,
  CircleHelp,
  CircleX,
  Eye,
  EyeOff,
  FileText,
  Flag,
  FlagOff,
  ImageDown,
  Info,
  MoreHorizontal,
  NotebookPen,
  Pencil,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HANDWRITTEN_TYPES,
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "@/features/answering/answer-format";
import {
  completionLabel,
  getQuestionCompletion,
} from "@/features/answering/question-completion";
import { QuestionMemoAction } from "@/features/memos/QuestionMemoCapture";
/** 题头元信息：题号 + 题型徽章 + 难度星 + 考点 tag */
export function QuestionMeta({
  learningSurface,
  questionRevisionId,
  attemptId,
  index,
  question,
  answer,
  flagged,
  onToggleFlag,
  unsure,
  onToggleUnsure,
  formalInkPresence,
  tools,
}: {
  attemptId?: string | undefined;
  index: number;
  learningSurface: "attempt" | "lesson";
  questionRevisionId?: string | undefined;
  question: QuestionPublic;
  answer: StudentAnswer | undefined;
  flagged: boolean;
  onToggleFlag: (() => void) | undefined;
  /** #6980-4：做题时标了「不会」（服务端保存，进错题本） */
  unsure: boolean;
  onToggleUnsure: (() => void) | undefined;
  formalInkPresence: boolean;
  tools: {
    aiTrigger?: ReactNode;
    /** QM-08：组内共享材料的「查看材料」入口（组段装配注入；组外题为空）。
     *  P1-2：solo 题的题级 ::ref 材料同入口挂载（组装配传「共享」、题级
     *  装配传「本题」，openMaterialLabel 区分语义） */
    openMaterial?: () => void;
    /** 材料入口按钮文案（缺省「查看共享材料」；题级装配传「查看本题材料」） */
    openMaterialLabel?: string;
    annotationOpen: boolean;
    annotationUnavailable?: string;
    paperOpen: boolean;
    paperEnabled: boolean;
    /** 已提交只读：圈画与草稿/手写编辑入口一并隐藏（更多菜单保留） */
    editLocked?: boolean;
    annotationCount: number;
    paperCount: number;
    annotationProblem: boolean;
    paperProblem: boolean;
    toggleAnnotation: () => void;
    cancelAnnotation: () => void;
    togglePaper: () => void;
    annotationHidden?: boolean;
    toggleAnnotationVisibility?: () => void;
    exportAnnotation?: () => void;
  } | null;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <div
      data-slot="question-header"
      className="flex min-h-11 flex-wrap items-start justify-between gap-2 sm:items-center"
    >
      {/* 窄列防坍塌（2026-10-27）：题号/徽标/状态禁逐字换行（CJK 逐字竖排
          缺陷），状态可截断；行内换行交给 flex-wrap 按整项换行 */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <p className="flex items-center gap-2 text-sm font-semibold whitespace-nowrap">
          <span>第 {index + 1} 题</span>
        </p>
        <span
          className={`whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium ${QUESTION_TYPE_BADGE_CLASS[question.type]}`}
        >
          {QUESTION_TYPE_LABELS[question.type]}
        </span>
        <span className="whitespace-nowrap text-xs text-muted-foreground">
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
        {/* #6980-4（审查 P2-7）：题卡头部琥珀问号——手机端/单题模式收起答题
        卡时，点完菜单也能看到「标过不会」的即时反馈 */}
        {unsure && (
          <CircleHelp
            aria-label="标过不会"
            className="size-3.5 text-amber-600 dark:text-amber-400"
          />
        )}
        {detailsOpen && (
          <div className="contents">
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
                className="max-w-full break-words rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
              >
                {name}
              </span>
            ))}
          </div>
        )}
      </div>
      {/* 极窄列（分栏 65% 拖拽在 1024 视口）下 5×44px 触控钮去间距才能放下：
          间距随题卡容器宽折叠恢复，触控目标恒 ≥44px */}
      <div className="flex shrink-0 items-center gap-0 @min-[26rem]/question-card:gap-1">
        {tools && !tools.editLocked && (
          <Button
            type="button"
            variant="ghost"
            className="h-11 min-w-11 gap-1.5 px-2"
            title={tools.annotationUnavailable ?? "圈画题干"}
            disabled={tools.annotationUnavailable !== undefined}
            aria-label={`第 ${index + 1} 题圈画题干${tools.annotationOpen ? "（标画中）" : ""}${tools.annotationCount > 0 ? `（已有 ${tools.annotationCount} 笔）` : ""}${tools.annotationProblem ? "，同步需处理" : ""}`}
            aria-expanded={tools.annotationOpen}
            data-annotation-trigger
            onClick={tools.toggleAnnotation}
            onDoubleClick={tools.cancelAnnotation}
          >
            {tools.annotationProblem ? (
              <CircleAlert aria-hidden className="size-4 text-amber-600" />
            ) : (
              <Pencil
                aria-hidden
                className={`size-4 ${tools.annotationOpen || tools.annotationCount > 0 ? "text-primary" : ""}`}
              />
            )}
            <span className="hidden @min-[27rem]/question-card:inline">
              圈画
            </span>
            {tools.annotationCount > 0 && (
              <span aria-hidden className="size-1.5 rounded-full bg-current" />
            )}
          </Button>
        )}
        {tools?.openMaterial && (
          <Button
            type="button"
            variant="ghost"
            className="h-11 min-w-11 gap-1.5 px-2"
            title={tools.openMaterialLabel ?? "查看共享材料"}
            aria-label={`第 ${index + 1} 题${tools.openMaterialLabel ?? "查看共享材料"}`}
            data-material-trigger
            onClick={tools.openMaterial}
          >
            <FileText aria-hidden className="size-4" />
            <span className="hidden @min-[27rem]/question-card:inline">
              材料
            </span>
          </Button>
        )}
        {tools?.paperEnabled && !tools.editLocked && (
          <Button
            type="button"
            variant="ghost"
            className="h-11 min-w-11 gap-1.5 px-2"
            title={HANDWRITTEN_TYPES.has(question.type) ? "手写作答" : "草稿纸"}
            aria-label={`第 ${index + 1} 题${HANDWRITTEN_TYPES.has(question.type) ? "手写作答" : "草稿纸"}${tools.paperCount > 0 || formalInkPresence ? "（已有笔迹）" : ""}${tools.paperProblem ? "，同步需处理" : ""}`}
            aria-expanded={tools.paperOpen}
            data-paper-trigger
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
            <span className="hidden @min-[27rem]/question-card:inline">
              {HANDWRITTEN_TYPES.has(question.type) ? "手写" : "草稿"}
            </span>
            {(tools.paperCount > 0 || formalInkPresence) && (
              <span aria-hidden className="size-1.5 rounded-full bg-current" />
            )}
          </Button>
        )}
        {tools?.aiTrigger}
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
          <DropdownMenuContent
            align="end"
            className="min-w-48 max-w-[calc(100vw-24px)] motion-reduce:animate-none"
          >
            <QuestionMemoAction
              surface={learningSurface}
              questionRevisionId={questionRevisionId}
              attemptId={attemptId}
              questionId={question.id}
            />
            {tools?.exportAnnotation && (
              <DropdownMenuItem onSelect={tools.exportAnnotation}>
                <ImageDown aria-hidden />
                导出本题
              </DropdownMenuItem>
            )}
            {tools?.exportAnnotation && <DropdownMenuSeparator />}
            {tools?.toggleAnnotationVisibility && tools.annotationCount > 0 && (
              <DropdownMenuItem onSelect={tools.toggleAnnotationVisibility}>
                {tools.annotationHidden ? (
                  <Eye aria-hidden />
                ) : (
                  <EyeOff aria-hidden />
                )}
                {tools.annotationHidden ? "显示标画" : "隐藏标画"}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => setDetailsOpen((value) => !value)}
            >
              <Info aria-hidden />
              {detailsOpen ? "隐藏题目资料" : "显示题目资料"}
            </DropdownMenuItem>
            {onToggleFlag && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onToggleFlag}>
                  {flagged ? <FlagOff aria-hidden /> : <Flag aria-hidden />}
                  {flagged ? "取消待检查" : "标记待检查"}
                </DropdownMenuItem>
              </>
            )}
            {onToggleUnsure && (
              <DropdownMenuItem onSelect={onToggleUnsure}>
                {unsure ? <CircleX aria-hidden /> : <CircleHelp aria-hidden />}
                {unsure ? "取消不会标记" : "标记不会（进错题本）"}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
