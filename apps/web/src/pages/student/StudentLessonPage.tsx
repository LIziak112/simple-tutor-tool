import type {
  AttemptQuestionPublic,
  HintOpenedEntry,
  LessonStartData,
} from "@tutor/contract";
import {
  ArrowLeft,
  CheckCircle2,
  ListTree,
  LoaderCircle,
  RotateCw,
  Sparkles,
} from "lucide-react";
import {
  Fragment,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { questionBindings } from "@/features/answering/question-binding";
import {
  AttemptEditorNotice,
  AttemptEditorProvider,
  useAttemptEditor,
} from "@/features/attempt/AttemptEditorContext";
import {
  type GroupContextSegment,
  groupSegmentsOfUnit,
} from "@/features/attempt/attempt-context-view";
import { useAttemptContext } from "@/features/attempt/attempt-queries";
import { retryAttemptLocalPersistence } from "@/features/attempt/use-attempt-save-status";
import { DraftSyncProvider } from "@/features/attempt/use-draft-sync";
import {
  EnabledCapabilitiesProvider,
  toEnabledCapabilities,
} from "@/features/capability/enabled-capabilities";
import { LessonGroupBlock } from "@/features/lesson/LessonGroupBlock";
import { LessonQuestionCard } from "@/features/lesson/LessonQuestionCard";
import {
  useLessonStart,
  useRestartLesson,
} from "@/features/lesson/lesson-queries";
import {
  type LessonQuestionHandlers,
  useLessonAttempt,
} from "@/features/lesson/use-lesson-attempt";
import { LectureOutline } from "@/features/markdown/LectureOutline";
import { extractOutline } from "@/features/markdown/outline";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import {
  LESSON_HEADING_SELECTOR,
  scrollToHeadingAt,
} from "@/features/markdown/use-lecture-section-focus";
import { lessonHref } from "@/features/student/lesson-navigation";
import {
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";
import { useStudentWorkspace } from "@/features/student/student-workspace-layout";
import { useAiCompanionDock } from "@/features/student-ai/AiCompanionDock";
import { AiQueueButton } from "@/features/student-ai/AiQueueButton";
import { useDesktopViewport } from "@/lib/use-desktop-viewport";

/**
 * /s/lectures/:id/lesson/run 学生讲练作答页（2026-10 讲练一体；10-13 教师
 * 演示口径拆双页后本页承接 /lesson/run，入口/返回键统一指向落地页 /lesson）：
 * - 进入即幂等开卷（POST lesson/start——进行中取回同一份 draft、已完成取回
 *   最新那份，刷新安全不消耗 attemptNo）；?courseId= 课程上下文（返回键）；
 * - blocks 渲染：md 段 RichMarkdown 与题卡按讲义顺序交替（切段经
 *   data-lesson-md 限定目录标题采集范围——题干内的标题不进目录）；question
 *   槽按 questionId 绑定冻结题；孤儿冻结题（教师重导后不在当前 markdown）
 *   在页尾「本次练习其余题目」分组渲染（不丢失，方案决策 2）；
 * - QM-14 组段呈现：冻结上下文（/attempts/:id/context）经 groupSegmentsOfUnit
 *   单源解释成组段，组头+共享材料（LessonGroupBlock）在首个成员题卡之前
 *   渲染一次；context 失败/为空非阻断（材料列缺失不阻塞作答）；
 * - 目录：全部 md 段拼接 extractOutline（桌面 sticky 侧栏 / 窄屏弹层，
 *   LectureOutline 复用）；
 * - 顶部：标题 + 课程/讲练次数 + 草稿保存状态（教师演示口径：无「完成练习」
 *   与进度计数——讲练是老师讲解材料，收尾只在最后一题「显示答案」事务内
 *   自动发生）；已完成时「再做一次」（restart）与「查看结果」（/s/attempts/:id）；
 * - 三态齐全：加载骨架 / 错误（重试）/ 零题讲练页纯阅读提示。
 */

const LessonMarkdown = memo(RichMarkdown);
/** 空提示集（模块级稳定引用：题卡 memo 比较不因 `?? []` 每次新数组失效） */
const EMPTY_HINTS: readonly HintOpenedEntry[] = [];

export default function StudentLessonPage() {
  useStudentWorkspace();
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const courseId = searchParams.get("courseId") ?? undefined;
  const lessonQuery = useLessonStart(id.length > 0 ? id : undefined, courseId);

  if (lessonQuery.isPending) {
    return <StudentListSkeleton label="正在打开讲练页" />;
  }
  if (lessonQuery.isError || lessonQuery.data === undefined) {
    return (
      <section aria-label="讲练页打开失败" className="flex flex-col gap-4">
        <HeaderBar
          title="讲练页"
          backTo={lessonHref(id, courseId)}
          backLabel="返回讲练"
          actions={null}
          context={<span>讲练</span>}
        />
        <StudentErrorPanel
          title="讲练页打开失败"
          message={
            lessonQuery.error instanceof Error
              ? lessonQuery.error.message
              : "网络异常，请稍后重试"
          }
          onRetry={() => void lessonQuery.refetch()}
        />
      </section>
    );
  }
  const data = lessonQuery.data;
  return data.attempt.status !== "draft" ? (
    <LessonCompletedView data={data} courseId={courseId} lectureId={id} />
  ) : (
    <LessonAnswerView
      key={data.attempt.id}
      data={data}
      courseId={courseId}
      lectureId={id}
      refetch={lessonQuery.refetch}
    />
  );
}

/** 顶部工具栏：返回 + 标题 + 操作区 + 上下文行（sticky） */
function HeaderBar({
  title,
  backTo,
  backLabel,
  actions,
  context,
}: {
  title: string;
  /** 返回目标（落地页 /s/lectures/:id/lesson） */
  backTo: string;
  backLabel: string;
  actions: ReactNode;
  context: ReactNode;
}) {
  return (
    <nav
      aria-label="讲练页工具栏"
      className="sticky top-0 z-20 -mx-3 flex min-h-16 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-background px-3 py-2 sm:-mx-6 sm:px-6"
    >
      <Link
        to={backTo}
        aria-label={backLabel}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ArrowLeft aria-hidden className="size-5" />
      </Link>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm leading-relaxed font-semibold break-words sm:text-base">
          <Sparkles aria-hidden className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 break-words">{title}</span>
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {context}
        </div>
      </div>
      {actions !== null && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </nav>
  );
}

/** 题槽：题目 + 全卷题号（0 起，孤儿排后）+ 是否孤儿冻结题 */
interface LessonQuestionSlot {
  question: AttemptQuestionPublic;
  index: number;
  orphan: boolean;
}

/**
 * 题目在 blocks 中按出现顺序排列（孤儿冻结题排在其后）+ 伴生 byId 索引：
 * 父组件算一次传入 LessonBody，题槽渲染统一 map.get（免循环内 find 的
 * O(n²) 与 as 断言）。
 */
function lessonQuestionOrder(data: LessonStartData): {
  ordered: LessonQuestionSlot[];
  byId: Map<string, LessonQuestionSlot>;
} {
  const byId = new Map(data.questions.map((q) => [q.id, q] as const));
  const seen = new Set<string>();
  const ordered: LessonQuestionSlot[] = [];
  const slotById = new Map<string, LessonQuestionSlot>();
  const place = (question: AttemptQuestionPublic, orphan: boolean): void => {
    const slot: LessonQuestionSlot = {
      question,
      index: ordered.length,
      orphan,
    };
    seen.add(question.id);
    slotById.set(question.id, slot);
    ordered.push(slot);
  };
  for (const block of data.blocks) {
    if (block.type !== "question") continue;
    const question = byId.get(block.questionId);
    if (question !== undefined && !seen.has(question.id)) {
      place(question, false);
    }
  }
  for (const question of data.questions) {
    if (!seen.has(question.id)) place(question, true);
  }
  return { ordered, byId: slotById };
}

/**
 * QM-14 组段呈现：冻结上下文（/attempts/:id/context）经 groupSegmentsOfUnit
 * （数据解释单源，与作答/结果视图同一实现）解释成组段——组头+共享材料在
 * **首个成员**题卡之前渲染一次（LessonGroupBlock 只承担讲练单列排版）。
 * context 未到位/为空（legacy 卷或旧部署）→ 空映射，渲染零变化；失败非阻断
 * （题面渲染不依赖本载荷，页面层就地提示 + 重试）。
 */
function useLessonGroupAnchors(
  attemptId: string,
  order: ReturnType<typeof lessonQuestionOrder>,
): {
  anchors: ReadonlyMap<string, GroupContextSegment>;
  contextError: string | null;
  contextRetry: () => void;
  contextFetching: boolean;
} {
  const contextQuery = useAttemptContext(attemptId);
  const anchors = useMemo(() => {
    if (contextQuery.data === undefined) return EMPTY_ANCHORS;
    const map = new Map<string, GroupContextSegment>();
    for (const segment of groupSegmentsOfUnit(
      contextQuery.data,
      order.ordered.map((slot) => slot.question.id),
    )) {
      if (segment.kind !== "group") continue;
      const first = segment.questionIds[0];
      if (first !== undefined) map.set(first, segment);
    }
    return map;
  }, [contextQuery.data, order]);
  return {
    anchors,
    contextError:
      contextQuery.error instanceof Error
        ? contextQuery.error.message
        : contextQuery.isError
          ? "共享材料加载失败，不影响作答题目。"
          : null,
    contextRetry: () => void contextQuery.refetch(),
    contextFetching: contextQuery.isFetching,
  };
}

/** 空锚点映射（模块级稳定引用：无 context 时 useMemo 返回同一实例） */
const EMPTY_ANCHORS: ReadonlyMap<string, GroupContextSegment> = new Map();

/**
 * 正文：目录（md 段拼接）+ blocks 交替渲染 + 孤儿题分组。
 * renderCard 由两个视图注入（作答卡带 handlers / 完成卡只读）；order 由
 * 父组件 useMemo 算好传入（两视图与题槽渲染同一份）。
 */
function LessonBody({
  data,
  order,
  renderCard,
  anchors,
  contextError,
  contextRetry,
  contextFetching,
}: {
  data: LessonStartData;
  order: {
    ordered: LessonQuestionSlot[];
    byId: Map<string, LessonQuestionSlot>;
  };
  renderCard: (
    question: AttemptQuestionPublic,
    index: number,
    orphan: boolean,
  ) => ReactNode;
  /** QM-14：questionId → 首成员组段（组头+材料锚点）；缺省空映射零变化 */
  anchors?: ReadonlyMap<string, GroupContextSegment>;
  /** 冻结上下文加载失败（非阻断：材料列缺失不阻塞作答） */
  contextError?: string | null;
  contextRetry?: () => void;
  contextFetching?: boolean;
}) {
  const isDesktop = useDesktopViewport();
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [mobileOutlineOpen, setMobileOutlineOpen] = useState(false);
  const outlineTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileOutlineScrollRef = useRef<HTMLDivElement>(null);
  const desktopOutlineScrollRef = useRef<HTMLDivElement>(null);
  const pendingHeadingRef = useRef<number | null>(null);

  // 目录：全部 md 段拼接抽取（H2/H3；data-lesson-md 限定采集与滚动范围）
  const outline = useMemo(
    () =>
      extractOutline(
        data.blocks
          .filter((block) => block.type === "md")
          .map((block) => (block.type === "md" ? block.md : ""))
          .join("\n\n"),
      ),
    [data.blocks],
  );
  const orphans = order.ordered.filter((slot) => slot.orphan);
  const outlineKey = useMemo(
    () => data.blocks.map((b) => (b.type === "md" ? b.md : "q")).join("¦"),
    [data.blocks],
  );
  /** blocks 渲染键：md 段按内容（同名去重）、题槽按 questionId（不用数组下标） */
  const blockKeys = useMemo(() => {
    const seen = new Map<string, number>();
    return data.blocks.map((block) => {
      if (block.type === "question") return `q-${block.questionId}`;
      const base = `md-${block.md.slice(0, 80)}`;
      const occurrence = (seen.get(base) ?? 0) + 1;
      seen.set(base, occurrence);
      return occurrence === 1 ? base : `${base}-${occurrence}`;
    });
  }, [data.blocks]);

  useEffect(() => {
    if (isDesktop) setMobileOutlineOpen(false);
  }, [isDesktop]);

  const navigateOutline = (headingIndex: number) => {
    if (!isDesktop) {
      pendingHeadingRef.current = headingIndex;
      setMobileOutlineOpen(false);
      return;
    }
    scrollToHeadingAt(LESSON_HEADING_SELECTOR, headingIndex);
  };

  const outlineNode = (scrollRef: RefObject<HTMLDivElement | null>) => (
    <LectureOutline
      key={outlineKey}
      items={outline}
      currentIndex={null}
      scrollContainerRef={scrollRef}
      onNavigate={navigateOutline}
    />
  );

  return (
    <div className="flex min-w-0 flex-col gap-5 lg:flex-row lg:items-start">
      {isDesktop && outlineOpen && outline.length > 0 && (
        <nav
          aria-label="讲练目录"
          className="sticky top-20 w-64 shrink-0 rounded-xl border border-border bg-card p-3"
        >
          <p className="mb-3 px-3 text-xs font-semibold text-muted-foreground">
            讲练目录
          </p>
          <div
            ref={desktopOutlineScrollRef}
            className="max-h-[calc(100dvh-12rem)] overflow-y-auto overscroll-contain pr-1"
          >
            {outlineNode(desktopOutlineScrollRef)}
          </div>
        </nav>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-4">
        {/* 冻结上下文加载失败（QM-14）：非阻断提示 + 重试（题面不依赖本载荷） */}
        {contextError !== null && contextError !== undefined && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-4"
          >
            <p className="min-w-0 text-sm">{contextError}</p>
            {contextRetry !== undefined && (
              <Button
                variant="outline"
                className="min-h-11"
                disabled={contextFetching ?? false}
                onClick={contextRetry}
              >
                重试加载共享材料
              </Button>
            )}
          </div>
        )}
        {/* blocks：md 段与题卡按讲义顺序交替 */}
        {data.blocks.map((block, blockIndex) => {
          if (block.type === "md") {
            return (
              <section
                key={blockKeys[blockIndex]}
                data-lesson-md
                aria-label="讲义段落"
                className="rounded-2xl border border-border bg-card px-4 py-5 shadow-xs sm:px-6 lg:px-8"
              >
                <LessonMarkdown source={block.md} className="lecture-body" />
              </section>
            );
          }
          const slot = order.byId.get(block.questionId);
          const anchor =
            slot === undefined ? undefined : anchors?.get(slot.question.id);
          return slot !== undefined ? (
            <Fragment key={`slot-${block.questionId}`}>
              {/* QM-14：首个组员题卡之前的组头+共享材料（单列流式呈现） */}
              {anchor !== undefined && (
                <LessonGroupBlock
                  group={anchor.group}
                  materials={anchor.materials}
                />
              )}
              {renderCard(slot.question, slot.index, slot.orphan)}
            </Fragment>
          ) : (
            // 题槽未冻结（重导新增的题）：本次练习按开卷内容进行，占位说明
            <p
              key={`slot-${block.questionId}`}
              className="rounded-2xl border border-dashed border-border bg-card/60 px-4 py-3 text-xs text-muted-foreground"
            >
              老师在讲练页里新增了题目；本次练习仍按开卷时的内容进行，完成后「再做一次」可以练到新题。
            </p>
          );
        })}

        {/* 孤儿冻结题（不在当前 markdown）：页尾分组，不丢失（方案决策 2） */}
        {orphans.length > 0 && (
          <section
            aria-labelledby="lesson-orphans"
            className="flex flex-col gap-3 rounded-2xl border border-dashed border-border bg-card/60 p-4"
          >
            <h2
              id="lesson-orphans"
              className="flex items-center gap-2 text-sm font-semibold text-foreground before:h-4 before:w-1 before:rounded-full before:bg-primary"
            >
              本次练习其余题目
            </h2>
            <p className="text-xs text-muted-foreground">
              老师更新了这份讲练页，这些题不在当前讲义里，但仍在你的本次练习中——照常作答即可。
            </p>
            <div className="flex flex-col gap-4">
              {orphans.map(({ question, index }) => {
                const anchor = anchors?.get(question.id);
                return (
                  <Fragment key={`orphan-${question.id}`}>
                    {/* QM-14：全孤儿组的组头+材料也随孤儿分组渲染（不丢共享材料） */}
                    {anchor !== undefined && (
                      <LessonGroupBlock
                        group={anchor.group}
                        materials={anchor.materials}
                      />
                    )}
                    {renderCard(question, index, true)}
                  </Fragment>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {/* 目录入口（窄屏按钮 + 弹层；桌面收起后的展开按钮） */}
      {outline.length > 0 && (
        <>
          <Button
            type="button"
            ref={outlineTriggerRef}
            variant="outline"
            className="min-h-11 w-fit lg:hidden"
            aria-expanded={mobileOutlineOpen}
            onClick={() => setMobileOutlineOpen(true)}
          >
            <ListTree aria-hidden className="size-4" />
            展开目录
          </Button>
          {isDesktop && !outlineOpen && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-fit"
              onClick={() => setOutlineOpen(true)}
            >
              <ListTree aria-hidden className="size-4" />
              展开目录
            </Button>
          )}
          <Dialog
            open={!isDesktop && mobileOutlineOpen}
            onOpenChange={setMobileOutlineOpen}
          >
            <DialogContent
              className="w-[calc(100%-2rem)] max-w-md overflow-hidden p-4"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                const index = pendingHeadingRef.current;
                pendingHeadingRef.current = null;
                if (index !== null)
                  scrollToHeadingAt(LESSON_HEADING_SELECTOR, index);
                else outlineTriggerRef.current?.focus({ preventScroll: true });
              }}
            >
              <DialogHeader className="pr-11">
                <DialogTitle className="leading-normal">讲练目录</DialogTitle>
                <DialogDescription>选择章节，跳转到正文</DialogDescription>
              </DialogHeader>
              <div
                ref={mobileOutlineScrollRef}
                className="min-h-0 overflow-y-auto overscroll-contain"
              >
                {outlineNode(mobileOutlineScrollRef)}
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}

/** 进行中卷（draft）：作答视图（伴学装配需要编辑器上下文，内容拆 Inner） */
function LessonAnswerView({
  data,
  courseId,
  lectureId,
  refetch,
}: {
  data: LessonStartData;
  courseId: string | undefined;
  lectureId: string;
  refetch: () => Promise<unknown>;
}) {
  const session = useLessonAttempt(data, { refetch });

  // 最后一题单题提交的事务内自动收尾：会话覆盖层先切完成视图（refetch 落地
  // 后由页面级分支接管并卸载作答会话），避免「提交完成但页面仍作答态」的窗口
  if (session.attempt.status !== "draft") {
    return (
      <LessonCompletedView
        data={{
          ...data,
          attempt: session.attempt,
          released: { ...session.released },
          ...(session.summary !== null ? { summary: session.summary } : {}),
        }}
        courseId={courseId}
        lectureId={lectureId}
      />
    );
  }
  return (
    <AttemptEditorProvider>
      <DraftSyncProvider value={session.draftSyncContext}>
        <LessonAnswerInner
          data={data}
          courseId={courseId}
          lectureId={lectureId}
          session={session}
        />
      </DraftSyncProvider>
    </AttemptEditorProvider>
  );
}

/**
 * 作答视图内容（编辑器/草稿上下文内）：SAI-22 讲练 AI 伴学装配——
 * 身份（attempt + 题集）与阶段（当前作答题/编辑器/材料面）传共享 dock。
 * 当前作答题：初始为首个未提交题，作答交互跟随最近题（「显示答案」的
 * 提交动作不移动它——当题提交后原地即复盘，题级完成裁决在服务端 status）。
 * 材料面收窄：讲练题卡无圈画层 → 只呈纸面（草稿/正式手写）。
 */
function LessonAnswerInner({
  data,
  courseId,
  lectureId,
  session,
}: {
  data: LessonStartData;
  courseId: string | undefined;
  lectureId: string;
  session: ReturnType<typeof useLessonAttempt>;
}) {
  const attemptId = session.attemptId;
  const capabilities = useMemo(
    () => toEnabledCapabilities(data.enabledCapabilities),
    [data.enabledCapabilities],
  );
  const [retryingSave, setRetryingSave] = useState(false);
  const order = useMemo(() => lessonQuestionOrder(data), [data]);
  // QM-14：组段呈现（作答态与完成回看同一组锚点；context 失败非阻断）
  const { anchors, contextError, contextRetry, contextFetching } =
    useLessonGroupAnchors(attemptId, order);
  const questionIds = useMemo(
    () => data.questions.map((question) => question.id),
    [data.questions],
  );
  const total = data.questions.length;

  // ---- SAI-22 讲练 AI 伴学 ----
  const editor = useAttemptEditor(null);
  const cardElements = useRef(new Map<string, HTMLElement>());
  const onCardElement = useCallback(
    (questionId: string, el: HTMLElement | null) => {
      if (el === null) cardElements.current.delete(questionId);
      else cardElements.current.set(questionId, el);
    },
    [],
  );
  const [currentQuestionId, setCurrentQuestionId] = useState<string | null>(
    () =>
      order.ordered.find(
        (slot) => session.released[slot.question.id] === undefined,
      )?.question.id ?? null,
  );
  /** 作答交互跟随最近题（包装 handlers.onAnswer；引用随 session.handlers 稳定） */
  const handlers = useMemo<LessonQuestionHandlers>(
    () => ({
      ...session.handlers,
      onAnswer: (questionId, answer, defer) => {
        setCurrentQuestionId((previous) =>
          previous === questionId ? previous : questionId,
        );
        session.handlers.onAnswer(questionId, answer, defer);
      },
    }),
    [session.handlers],
  );
  const indexById = useMemo(
    () =>
      new Map(
        order.ordered.map((slot, i) => [slot.question.id, i + 1] as const),
      ),
    [order],
  );
  const aiCompanion = useAiCompanionDock({
    attemptId,
    questions: data.questions,
    isHandwritten: (questionId) => {
      const question = data.questions.find((item) => item.id === questionId);
      // UA-03：纸面角色经题型绑定（paperRole=answerInk ≡ 旧七型手写资格，I09）
      return (
        question !== undefined &&
        questionBindings[question.type].paperRole === "answerInk"
      );
    },
    surfaceOf: (questionId) =>
      cardElements.current
        .get(questionId)
        ?.querySelector<HTMLElement>('[data-slot="question-surface"]') ?? null,
    flush: (questionId) =>
      editor !== null ? editor.flush(questionId) : Promise.resolve(),
    titleOf: (questionId) =>
      `第 ${indexById.get(questionId) ?? "？"} 题 · ${data.lecture.title}`,
    labelOf: (questionId) =>
      indexById.has(questionId) ? `第 ${indexById.get(questionId)} 题` : null,
    currentQuestionId,
    editor,
    materials: { annotation: false, paper: true },
  });

  const renderCard = (
    question: AttemptQuestionPublic,
    index: number,
    _orphan: boolean,
  ) => (
    <div key={question.id} className="min-w-0">
      <LessonQuestionCard
        index={index}
        question={question}
        attemptId={attemptId}
        answer={session.answers?.[question.id]}
        hints={session.hintsOpened[question.id] ?? EMPTY_HINTS}
        released={session.released[question.id]}
        handlers={handlers}
        onCardElement={onCardElement}
        aiTrigger={aiCompanion.triggerForQuestion(question.id)}
      />
      {aiCompanion.inlineForQuestion(question.id)}
    </div>
  );

  return (
    <EnabledCapabilitiesProvider value={capabilities}>
      <article aria-label="讲练作答" className="flex flex-col gap-4 pb-8">
        <HeaderBar
          title={data.lecture.title}
          backTo={lessonHref(lectureId, courseId)}
          backLabel="返回讲练"
          context={
            <>
              <span>
                {data.lecture.courseName !== null
                  ? `课程：${data.lecture.courseName} · `
                  : ""}
                讲练 · 第 {data.attempt.attemptNo} 次
              </span>
              <span aria-live="polite">{session.saveStatus}</span>
            </>
          }
          actions={
            <AiQueueButton
              currentAttemptId={aiCompanion.send.attemptId}
              onOpenTask={aiCompanion.openTask}
              onOpenQuestion={aiCompanion.openQuestion}
            />
          }
        />

        <AttemptEditorNotice />
        {/* 零题讲练页：纯阅读提示（开卷合法但不构成练习） */}
        {total === 0 && (
          <p className="rounded-2xl border border-dashed border-border bg-card px-4 py-3 text-sm text-muted-foreground">
            这份讲练页暂时没有题目，可以先阅读讲义内容。
          </p>
        )}

        {/* 本机保存失败时的手动重试（其余失败态由同步循环自动重试） */}
        {session.saveStatus.startsWith("本机保存失败") && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-destructive">
            本机草稿保存失败
            <Button
              variant="outline"
              className="min-h-11"
              disabled={retryingSave}
              onClick={async () => {
                setRetryingSave(true);
                try {
                  await retryAttemptLocalPersistence(attemptId, questionIds);
                  await session.draftSyncContext.syncNow();
                } catch {
                  // 重试失败保持提示（下一次点击再试）
                } finally {
                  setRetryingSave(false);
                }
              }}
            >
              <RotateCw aria-hidden className="size-4" />
              重试保存
            </Button>
          </p>
        )}

        {aiCompanion.rail(
          <LessonBody
            data={data}
            order={order}
            renderCard={renderCard}
            anchors={anchors}
            contextError={contextError}
            contextRetry={contextRetry}
            contextFetching={contextFetching}
          />,
        )}
      </article>
    </EnabledCapabilitiesProvider>
  );
}

/** 已完成卷（submitted/graded）：完成视图（只读结果卡 + 再做一次） */
function LessonCompletedView({
  data,
  courseId,
  lectureId,
}: {
  data: LessonStartData;
  courseId: string | undefined;
  lectureId: string;
}) {
  const restart = useRestartLesson(lectureId);
  const [restartOpen, setRestartOpen] = useState(false);
  const summary = data.summary;
  const attemptId = data.attempt.id;
  const order = useMemo(() => lessonQuestionOrder(data), [data]);
  // QM-14：完成回看同样呈现组段（材料随冻结上下文可见，回看不依赖当前讲义）
  const { anchors, contextError, contextRetry, contextFetching } =
    useLessonGroupAnchors(attemptId, order);
  const capabilities = useMemo(
    () => toEnabledCapabilities(data.enabledCapabilities),
    [data.enabledCapabilities],
  );
  const aiCompanion = useAiCompanionDock({
    attemptId,
    questions: data.questions,
    currentQuestionId: data.questions[0]?.id ?? null,
    isHandwritten: () => false,
    surfaceOf: () => null,
    flush: async () => {},
    editor: null,
    titleOf: (id) => `${data.lecture.title} · ${id}`,
    labelOf: (id) => {
      const index = data.questions.findIndex((question) => question.id === id);
      return index < 0 ? null : `第 ${index + 1} 题`;
    },
    materials: { annotation: false, paper: false },
    triggerLabel: "AI 复盘",
  });
  const restartErrorText = restart.isError
    ? restart.error instanceof Error
      ? restart.error.message
      : "网络异常，请稍后重试"
    : null;

  const renderCard = (
    question: AttemptQuestionPublic,
    index: number,
    _orphan: boolean,
  ) => (
    <div key={question.id} className="min-w-0">
      <LessonQuestionCard
        index={index}
        question={question}
        attemptId={attemptId}
        answer={data.drafts[question.id]}
        hints={EMPTY_HINTS}
        released={data.released[question.id]}
        handlers={undefined}
        aiTrigger={aiCompanion.triggerForQuestion(question.id)}
      />
      {aiCompanion.inlineForQuestion(question.id)}
    </div>
  );

  return (
    <EnabledCapabilitiesProvider value={capabilities}>
      <article aria-label="讲练回看" className="flex flex-col gap-4 pb-8">
        <HeaderBar
          title={data.lecture.title}
          backTo={lessonHref(lectureId, courseId)}
          backLabel="返回讲练"
          context={
            <>
              <span>
                {data.lecture.courseName !== null
                  ? `课程：${data.lecture.courseName} · `
                  : ""}
                讲练 · 第 {data.attempt.attemptNo} 次
              </span>
              <span className="flex items-center gap-1">
                <CheckCircle2
                  aria-hidden
                  className="size-3.5 text-emerald-600"
                />
                已完成
              </span>
              {summary !== null && (
                <span>
                  {/* QM-12：有效判定口径——待判断含待教师批改与待自评 */}
                  答对 {summary.correct} · 答错 {summary.wrong} · 待判断{" "}
                  {summary.pending}
                </span>
              )}
            </>
          }
          actions={
            <>
              <AiQueueButton
                currentAttemptId={aiCompanion.send.attemptId}
                onOpenTask={aiCompanion.openTask}
                onOpenQuestion={aiCompanion.openQuestion}
              />
              <Button asChild variant="outline" className="min-h-11">
                <Link to={`/s/attempts/${attemptId}`}>查看结果</Link>
              </Button>
              <Button
                className="min-h-11"
                disabled={restart.isPending}
                onClick={() => setRestartOpen(true)}
              >
                {restart.isPending ? (
                  <LoaderCircle aria-hidden className="size-4 animate-spin" />
                ) : (
                  <RotateCw aria-hidden className="size-4" />
                )}
                再做一次
              </Button>
            </>
          }
        />

        {aiCompanion.rail(
          <LessonBody
            data={data}
            order={order}
            renderCard={renderCard}
            anchors={anchors}
            contextError={contextError}
            contextRetry={contextRetry}
            contextFetching={contextFetching}
          />,
        )}

        {/* 再做一次确认：显式动作（新卷从空白开始，之前作答保留可回看） */}
        <Dialog open={restartOpen} onOpenChange={setRestartOpen}>
          <DialogContent className="w-[calc(100%-24px)] max-w-md">
            <DialogHeader>
              <DialogTitle>再做一次吗？</DialogTitle>
              <DialogDescription className="text-sm leading-6">
                将开始第 {data.attempt.attemptNo + 1}{" "}
                次练习，全部题目从空白开始作答；这一次的作答会保留，可随时在「我的记录」回看。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => setRestartOpen(false)}
              >
                先不了
              </Button>
              <Button
                className="min-h-11"
                disabled={restart.isPending}
                onClick={() =>
                  void restart.mutateAsync(undefined, {
                    onSuccess: () => setRestartOpen(false),
                  })
                }
              >
                {restart.isPending ? "正在开卷新一轮…" : "开始新一轮"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {restartErrorText !== null && (
          <p role="alert" className="text-sm text-destructive">
            再做一次失败：{restartErrorText}
          </p>
        )}
      </article>
    </EnabledCapabilitiesProvider>
  );
}
