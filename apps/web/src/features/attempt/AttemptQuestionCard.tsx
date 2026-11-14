import type {
  AttemptQuestionPublic,
  HintOpenedEntry,
  QuestionPublic,
  StudentAnswer,
} from "@tutor/contract";
import { displayStemMd } from "@tutor/md-dsl";
import { type ReactNode, useContext, useMemo, useRef, useState } from "react";
import { AnnotationExportDialog } from "@/features/annotation/AnnotationExportDialog";
import { ongoingAnnotationFilename } from "@/features/annotation/annotation-composite";
import { getAnnotationRecord } from "@/features/annotation/annotation-store";
import { currentAnnotationSession } from "@/features/annotation/annotation-sync";
import { exportQuestionAnnotationImage } from "@/features/annotation/export-question-annotation";
import {
  QuestionAnnotationOverlay,
  type QuestionAnnotationOverlayHandle,
} from "@/features/annotation/QuestionAnnotationOverlay";
import { useAnnotationRecord } from "@/features/annotation/use-annotation-record";
import { ResponseAnswerField } from "@/features/answering";
import { prepareQuestion } from "@/features/answering/prepare-question";
import { questionBindings } from "@/features/answering/question-binding";
import {
  getScratchContextLabel,
  renderScratchContext,
} from "@/features/answering/scratch-context";
import type { PreparedOf } from "@/features/answering/types";
import { useEnabledCapabilities } from "@/features/capability/enabled-capabilities";
import {
  exportMaterialsOfQuestion,
  renderMaterialExportPages,
} from "@/features/export/material-export-pages";
import {
  createOngoingQuestionImages,
  loadOngoingPaper,
} from "@/features/export/ongoing-question-export";
import { LearningHostContext } from "@/features/learning-context/learning-context-store";
import { NoteLayer } from "@/features/notes/NoteLayer";
import {
  effectiveNoteLayout,
  NOTE_PAPER_COLUMN_STYLE,
  NOTE_QUESTION_COLUMN_STYLE,
  NOTE_SIDE_ROW_STYLE,
  NOTE_STACK_ROW_STYLE,
  useNoteLayoutPreference,
  useNoteSideUsable,
} from "@/features/notes/note-layout";
import { currentNoteSession } from "@/features/notes/note-sync";
import { useNoteRecord } from "@/features/notes/use-note-record";
import { useAiCompareActive } from "@/features/student-ai/ai-companion-layout";
import { fetchAttemptContextApi } from "@/lib/api";
import { useAttemptEditor } from "./AttemptEditorContext";
import { QuestionMeta } from "./AttemptQuestionMeta";
import { HANDWRITTEN_TYPES } from "./answer-format";
import { getDraftSessionEpoch } from "./draft-store";
import {
  HandwrittenControls,
  type HandwrittenControlsProps,
} from "./HandwrittenControls";
import { HintPanel } from "./HintPanel";
import { QuestionSurface } from "./QuestionSurface";
import { usePaperPosition } from "./use-paper-position";

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

/** 答题页题卡本体 */
export function AttemptQuestionCard({
  index,
  learningSurface = "attempt",
  question,
  answer,
  onAnswer,
  repeatChoiceSelection = false,
  attemptId,
  registerInkController,
  onInkStroke,
  onInkEdit,
  onInkFullscreen,
  hints,
  onHintUnlocked,
  flagged = false,
  onToggleFlag,
  onOpenMaterial,
  openMaterialLabel,
  unsure = false,
  onToggleUnsure,
  formalInkPresence = false,
  onInkPresenceChange,
  assignmentTitle = "练习",
  footer,
  aiTrigger,
  readOnly = false,
  inkSyncWhileReadOnly = false,
  suspendInkUpload = false,
}: {
  /** 题号（0 起，展示 +1） */
  index: number;
  learningSurface?: "attempt" | "lesson" | undefined;
  question: QuestionPublic &
    Partial<Pick<AttemptQuestionPublic, "questionRevisionId">>;
  /** 本题当前答案（undefined=未作答） */
  answer: StudentAnswer | undefined;
  /** 作答回调（defer 交给控件语义：文本类防抖、离散类立即） */
  onAnswer: (answer: StudentAnswer, defer?: boolean) => void;
  repeatChoiceSelection?: boolean;
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
  /** QM-08：组内带共享材料时的「查看材料」入口（滚动到组材料列并恢复已读位置）；
   *  P1-2：solo 题级材料同入口（滚动到题级材料锚），label 由调用方区分语义 */
  onOpenMaterial?: () => void;
  /** 材料入口按钮文案（缺省「查看共享材料」；题级装配传「查看本题材料」） */
  openMaterialLabel?: string;
  /** #6980-4：做题时标了「不会」（服务端保存，进错题本） */
  unsure?: boolean;
  onToggleUnsure?: () => void;
  formalInkPresence?: boolean;
  onInkPresenceChange?: HandwrittenControlsProps["onInkPresenceChange"];
  assignmentTitle?: string;
  /** 作答流程可追加题级提交入口，共享题面与编辑器。 */
  footer?: ReactNode;
  /** 本题 AI 助教入口；由作答会话按题绑定。 */
  aiTrigger?: ReactNode;
  /** 已提交原位只读（M3-D2 §11-2）：同宿主同题干位置，隐藏编辑入口、输入只读 */
  readOnly?: boolean;
  inkSyncWhileReadOnly?: boolean;
  suspendInkUpload?: boolean;
}) {
  // T7.7：教师关闭手写辅助（ink）时草稿纸入口一并隐藏——草稿纸是 ink 辅助
  // 入口（已有草稿数据保留服务端，恢复开关后回来看）。
  const learningLease = useContext(LearningHostContext);
  const questionRevisionId = question.questionRevisionId;
  const { ink: inkEnabled } = useEnabledCapabilities();
  const articleRef = useRef<HTMLElement | null>(null);
  const openPaperWithPosition = usePaperPosition(articleRef);
  const editor = useAttemptEditor(question.id);
  const annotationOverlay = useRef<QuestionAnnotationOverlayHandle>(null);
  const [localNoteOpen, setLocalNoteOpen] = useState(false);
  const noteOpen = editor
    ? editor.paper?.questionId === question.id
    : localNoteOpen;
  const setNoteOpen = (next: boolean | ((previous: boolean) => boolean)) => {
    const open = typeof next === "function" ? next(noteOpen) : next;
    const request = async () => {
      if (editor)
        return editor.requestPaper(
          open
            ? {
                questionId: question.id,
                kind: HANDWRITTEN_TYPES.has(question.type)
                  ? "answerInk"
                  : "scratch",
              }
            : null,
        );
      setLocalNoteOpen(open);
      return true;
    };
    void openPaperWithPosition(request, open);
  };
  const [annotationHidden, setAnnotationHidden] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const layoutPreference = useNoteLayoutPreference();
  const sideUsable = useNoteSideUsable(articleRef, layoutPreference === "auto");
  // AI 侧栏对照激活时「自动」回退上下排布（M4-D2 §12.1）：题干、草稿与
  // AI 对照不成四列并排；显式布局偏好仍由学生自决，不被 AI 布局拉扯。
  const compareActive = useAiCompareActive();
  const hasScratchLayout =
    inkEnabled &&
    attemptId !== undefined &&
    !HANDWRITTEN_TYPES.has(question.type);
  // 只有实际展开草稿才分栏；已有标画由固定逻辑画面整体缩放。
  const layout =
    hasScratchLayout && noteOpen
      ? effectiveNoteLayout(
          layoutPreference === "auto" && compareActive
            ? "below"
            : layoutPreference,
          sideUsable,
        )
      : "below";
  const hasEditor = editor != null;
  // 保存/上传状态不改变题面；稳定引用避免重复解绑标画输入进行版式校验。
  const inlineQuestion = useMemo<AttemptQuestionPublic | null>(
    () =>
      hasEditor &&
      "questionRevisionId" in question &&
      typeof question.questionRevisionId === "string"
        ? { ...question, questionRevisionId: question.questionRevisionId }
        : null,
    [hasEditor, question],
  );
  const drawing =
    editor?.active?.questionId === question.id &&
    editor.active.kind === "annotation";
  const annotationRecord = useAnnotationRecord(attemptId ?? "", question.id);
  const noteRecord = useNoteRecord(attemptId ?? "", question.id);
  const scratchContext = renderScratchContext(question);
  const scratchContextLabel = getScratchContextLabel(question);
  const noteLayer =
    inkEnabled &&
    attemptId !== undefined &&
    !readOnly &&
    !HANDWRITTEN_TYPES.has(question.type) ? (
      <NoteLayer
        attemptId={attemptId}
        questionId={question.id}
        stemMd={displayStemMd(question)}
        options={question.options}
        scratchContext={scratchContext}
        contextLabel={scratchContextLabel}
        open={noteOpen}
        onOpenChange={setNoteOpen}
        {...(onInkFullscreen ? { onFullscreenChange: onInkFullscreen } : {})}
        ariaPrefix={`第 ${index + 1} 题`}
        showTrigger={false}
      />
    ) : null;

  /** 题面、正式作答与辅助内容保持稳定的组件身份。 */
  const questionBody = (
    <>
      {inlineQuestion && attemptId !== undefined ? (
        <QuestionAnnotationOverlay
          ref={annotationOverlay}
          attemptId={attemptId}
          question={inlineQuestion}
          label={`第 ${index + 1} 题`}
          hidden={annotationHidden}
          annotationReadOnly={readOnly}
        >
          <QuestionSurface
            question={question}
            answer={answer}
            onAnswer={onAnswer}
            repeatChoiceSelection={repeatChoiceSelection}
            readOnly={readOnly}
          />
        </QuestionAnnotationOverlay>
      ) : (
        <QuestionSurface
          question={question}
          answer={answer}
          onAnswer={onAnswer}
          repeatChoiceSelection={repeatChoiceSelection}
          readOnly={readOnly}
        />
      )}

      {/* 开放题正文作答（text-below-stem）：挂在圈画覆盖层外部下方（与 final 同范式），
          确保圈画底图几何绝对稳定且不盖住作答框；只读时以禁用态保留学生已提交正文 */}
      {questionBindings[question.type].placement === "text-below-stem" && (
        <ResponseAnswerField
          model={
            prepareQuestion(
              question,
              `${question.id}-answer`,
            ) as PreparedOf<"response">
          }
          answer={answer?.kind === "response" ? answer : undefined}
          update={(next, defer) => onAnswer(next, defer)}
          disabled={readOnly}
        />
      )}

      {HANDWRITTEN_TYPES.has(question.type) &&
        attemptId !== undefined &&
        (!readOnly || inkSyncWhileReadOnly) && (
          <HandwrittenControls
            ariaPrefix={`第 ${index + 1} 题`}
            attemptId={attemptId}
            questionId={question.id}
            stemMd={question.stemMd}
            scratchContext={scratchContext}
            contextLabel={scratchContextLabel}
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
            readOnly={readOnly}
            suspendUpload={suspendInkUpload}
            // QM-09（D14）：单行最终答案输入是 final kind 专属——response 的
            // 手写纸面与正文并存，不挂最终答案行（中央绑定派生，不写字面量）
            showFinalAnswer={
              questionBindings[question.type].answerKind === "final"
            }
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

  return (
    <article
      ref={articleRef}
      data-question-id={question.id}
      data-learning-attempt={attemptId}
      data-learning-view={learningLease?.viewId}
      data-learning-surface={learningSurface}
      data-learning-revision={questionRevisionId}
      tabIndex={-1}
      className="@container/question-card flex w-full min-w-0 scroll-mt-[calc(var(--attempt-header-height,64px)+12px)] flex-col gap-2 rounded-[8px] border border-border bg-card px-4 py-3 text-card-foreground outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:px-5 isolate has-[[data-slot=paper-frame][data-state=open]]:relative has-[[data-slot=paper-frame][data-state=open]]:z-40"
      aria-label={`第 ${index + 1} 题`}
      onPointerDownCapture={(event) => {
        if (
          editor?.getActive()?.kind !== "annotation" ||
          !(event.target instanceof Element) ||
          !event.currentTarget.contains(event.target)
        )
          return;
        if (
          event.target.closest(
            '[data-annotation-trigger], [data-paper-trigger], [data-material-trigger], [data-slot="question-annotation-overlay"], [data-slot="annotation-workspace"], [data-slot="attempt-bottom-bar"], [data-slot="note-layer"], [data-slot="handwritten-controls"]',
          )
        )
          return;
        void editor.request(null);
      }}
    >
      <QuestionMeta
        learningSurface={learningSurface}
        questionRevisionId={questionRevisionId}
        attemptId={attemptId}
        index={index}
        question={question}
        answer={answer}
        flagged={flagged}
        onToggleFlag={onToggleFlag}
        unsure={unsure}
        // 行级锁同步（#6980-4 审查 P1-3）：单题已提交（readOnly）后服务端
        // 拒改标记，菜单项同步隐藏，不给「点了必失败」的入口
        onToggleUnsure={readOnly ? undefined : onToggleUnsure}
        formalInkPresence={formalInkPresence}
        tools={
          attemptId === undefined
            ? null
            : {
                aiTrigger,
                ...(onOpenMaterial !== undefined
                  ? {
                      openMaterial: onOpenMaterial,
                      ...(openMaterialLabel !== undefined
                        ? { openMaterialLabel }
                        : {}),
                    }
                  : {}),
                annotationOpen: drawing,
                ...(inlineQuestion === null
                  ? {
                      annotationUnavailable:
                        "当前题目缺少冻结版本或编辑协调器，无法圈画",
                    }
                  : {}),
                paperOpen: noteOpen,
                paperEnabled: inkEnabled,
                editLocked: readOnly,
                annotationCount: annotationRecord?.doc?.strokes.length ?? 0,
                paperCount: noteRecord?.doc?.ink.strokes.length ?? 0,
                annotationProblem:
                  annotationRecord?.conflict != null ||
                  annotationRecord?.denied != null ||
                  annotationRecord?.local === "failed",
                ...(inlineQuestion
                  ? { exportAnnotation: () => setExportOpen(true) }
                  : {}),
                paperProblem:
                  noteRecord?.conflict != null ||
                  noteRecord?.denied != null ||
                  noteRecord?.local === "failed",
                toggleAnnotation: () => {
                  if (drawing) void editor?.request(null);
                  else {
                    setAnnotationHidden(false);
                    void annotationOverlay.current?.start();
                  }
                },
                cancelAnnotation: () => {
                  void editor?.request(null);
                },
                togglePaper: () => setNoteOpen((value) => !value),
                ...(inlineQuestion
                  ? {
                      annotationHidden,
                      toggleAnnotationVisibility: async () => {
                        if (!editor || (await editor.request(null)))
                          setAnnotationHidden((value) => !value);
                      },
                    }
                  : {}),
              }
        }
      />
      <div
        data-slot="note-body-row"
        data-layout={layout}
        className="flex"
        style={layout === "side" ? NOTE_SIDE_ROW_STYLE : NOTE_STACK_ROW_STYLE}
      >
        <div
          className="flex min-w-0 flex-col gap-4"
          style={layout === "side" ? NOTE_QUESTION_COLUMN_STYLE : undefined}
        >
          {questionBody}
        </div>
        <div
          className="min-w-0"
          hidden={!noteOpen}
          style={layout === "side" ? NOTE_PAPER_COLUMN_STYLE : undefined}
        >
          {noteLayer}
        </div>
      </div>
      {footer && <div className="pt-1">{footer}</div>}
      {inlineQuestion && attemptId && (
        <AnnotationExportDialog
          open={exportOpen}
          onOpenChange={setExportOpen}
          filename={ongoingAnnotationFilename(
            assignmentTitle,
            index + 1,
            "作答材料",
          )}
          title="导出本题"
          previewLabel="本题导出预览"
          createImage={async () => {
            if (editor && !(await editor.request(null)))
              throw new Error("当前稿件未保存，请先重试保存");
            const session = currentAnnotationSession();
            const noteSession = currentNoteSession();
            const draftEpoch = getDraftSessionEpoch();
            const surface =
              articleRef.current?.querySelector<HTMLElement>(
                '[data-slot="question-surface"]',
              ) ?? null;
            if (!session || !noteSession)
              throw new Error("题面尚未就绪，请重试");
            const guard = () => {
              if (
                currentAnnotationSession() !== session ||
                currentNoteSession() !== noteSession ||
                getDraftSessionEpoch() !== draftEpoch
              )
                throw new Error("会话已切换，请重新导出");
            };
            const paper = await loadOngoingPaper(
              noteSession,
              attemptId,
              question.id,
              HANDWRITTEN_TYPES.has(question.type),
            );
            guard();
            const questionImage = await exportQuestionAnnotationImage(
              session,
              { attemptId, questionId: question.id, phase: "scratch" },
              inlineQuestion,
              surface,
            );
            guard();
            const record = await getAnnotationRecord(session, {
              attemptId,
              questionId: question.id,
              phase: "scratch",
            });
            guard();
            const questionPages = await createOngoingQuestionImages(
              questionImage,
              paper,
              `${assignmentTitle} · 第 ${index + 1} 题`,
              guard,
              (record?.doc?.strokes.length ?? 0) > 0,
            );
            guard();
            // QM-16 细项 1：材料页前置（材料来自冻结上下文投影与题目公开
            // 投影的题级引用——组∪题级与服务端闭包同源；与隐藏标画/收起
            // 纸面无关）；读取/渲染失败显式抛错（对话框可重试），不静默
            // 省略材料
            const context = await fetchAttemptContextApi(attemptId);
            guard();
            const materialPages = await renderMaterialExportPages(
              exportMaterialsOfQuestion(
                context,
                question.id,
                question.materialRefs,
              ),
            );
            guard();
            return [
              ...materialPages.map((page) => ({
                blob: page.blob,
                label: page.label,
              })),
              ...questionPages,
            ];
          }}
        />
      )}
    </article>
  );
}
