import type { AttemptResultData, AttemptResultQuestion } from "@tutor/contract";
import { displayStemMd } from "@tutor/md-dsl";
import { cn } from "cn";
import {
  CheckCircle2,
  ChevronDown,
  Clock,
  Lightbulb,
  PenLine,
  RotateCcw,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AnnotationLayer } from "@/features/annotation/AnnotationLayer";
import { AnnotationView } from "@/features/annotation/AnnotationView";
import { HintEntryList } from "@/features/attempt/HintPanel";
import { ReviewPackPanel } from "@/features/export/review-pack-panel";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { CorrectionSection } from "@/features/notes/CorrectionSection";
import { NoteOriginalView } from "@/features/notes/NoteOriginalView";
import { QuestionHistoryLink } from "@/features/notes/QuestionHistoryLink";
import { AiBatchReviewEntry } from "@/features/student-ai/AiBatchReviewPanel";
import { useAiCompanionDock } from "@/features/student-ai/AiCompanionDock";
import { AiQueueButton } from "@/features/student-ai/AiQueueButton";
import { studentInkPngUrl } from "@/lib/api";
import { formatCnTime } from "@/lib/time";
import {
  attemptRoundLabel,
  attemptSourceLabel,
  HANDWRITTEN_TYPES,
  letterOf,
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "./answer-format";
import { PendingReleaseBanner } from "./PendingReleaseBanner";
import { ResultAnswerComparison } from "./ResultAnswerComparison";
import { ResultQuestionTools } from "./ResultQuestionTools";
import { ResultWorkspace } from "./ResultWorkspace";
import { reviewCounts, reviewQuestionState } from "./result-review-model";
import { useResultReviewLocation } from "./use-result-review-location";

/**
 * 交卷后的结果视图（T2.6）：顶部得分汇总（scoreAuto/对错待批数/提交时间）+
 * 逐题结果卡（✓/✗/待批图标、题干快照、本人答案 vs 参考答案、详解默认折叠）。
 * T2.8：手写题（solve/apply/find-error）追加「我的手写笔迹」缩略图——学生本人
 * 笔迹 PNG 经 GET /api/student/attempts/:id/ink/:questionId.png 文件直出
 * （不进 base64/不进库）；无笔迹时该区块整体隐藏（img onerror 兜底）。
 * T2.11：做题时解锁过的提示在此回看（hintsOpened，只含学生自己请求过的条目；
 * 未解锁提示内容服务端从不下发）。详解只在交卷后由服务端下发
 * （AGENTS 第 3 条对「未交卷题目」的限制已解除）。
 * T2A.8（D11）：answersReleased=false（作业「截止后公布」且未到截止）时——
 * 汇总卡替换为「已交卷，答案将在截止后公布」横幅（含截止时间与已答统计），
 * 逐题卡只渲染题干（公开化版）、选项、本人答案、笔迹与已解锁提示；
 * 不显示对错判定、参考答案与详解（服务端本就不下发，前端双保险不渲染）。
 * D9（T3.5）：逐题展示最终判定（finalCorrect 优先于 autoCorrect——教师批注
 * 后以批注为准）与老师批改块（teacherMark/teacherComment 显著展示，未批且
 * 已交维持既有待批态）；汇总区大数字改 scoreFinal ?? scoreAuto（全部批完显示
 * 「最终得分」），待批计数改用 pendingCount（D4 权威口径——批注后 autoCorrect
 * 仍空而 finalCorrect 已定，summary.pending 会虚高）。公布 gate 截止前服务端
 * 已把这些字段置 null 投影，前端照常落入「未批/待公布」分支（双保险）。
 * 2026-10（学生端闭环补完）：汇总卡操作区新增「练习本卷错题（N 题）」次级
 * 按钮——N = 本卷已判定为错的题数（逐题 finalCorrect === false，不含待批
 * finalCorrect=null；公布前已被 gate 置 null，天然不参与计数）。未公布
 * （answersReleased=false）或 N=0（全对/只剩待批）时隐藏。点击由页面层调
 * POST /wrong-practice 组新重练卷并跳作答（onStart 携带按本卷题序的
 * questionIds，服务端校验这些题必在错题本聚合内）。
 */

/**
 * 判定徽章组合（图标 + 文案 + 配色单一出处）：true=绿勾「答对」、false=
 * 红叉「答错」（D1 后含未作答客观题；D9 后最终判定 finalCorrect 优先——
 * 教师批注改判以批注为准）、null=琥珀时钟待批（文案可经 pendingLabel 覆盖，
 * 讲练页题卡用「待老师批改」）。toned=true 时文字套判定配色（讲练页题卡
 * 形态）；默认继承前景色（结果视图既有形态）。
 * 2026-10 讲练一体：讲练页题卡结果态复用（导出；仍单一出处）。
 */
export function VerdictBadge({
  verdict,
  pendingLabel = "待批改",
  toned = false,
  correctLabel = "答对",
  wrongLabel = "答错",
}: {
  verdict: boolean | null;
  /** 待批（null）文案覆盖——讲练页用「待老师批改」 */
  pendingLabel?: string;
  /** 文字是否套判定配色（讲练页题卡带色；结果视图沿用默认前景色） */
  toned?: boolean;
  /** 判对（true）文案覆盖——逐题反馈用「回答正确」（M3-D2；缺省不变） */
  correctLabel?: string;
  /** 判错（false）文案覆盖——逐题反馈用「回答有误」（M3-D2；缺省不变） */
  wrongLabel?: string;
}) {
  const label =
    verdict === true
      ? correctLabel
      : verdict === false
        ? wrongLabel
        : pendingLabel;
  const icon =
    verdict === true ? (
      <CheckCircle2
        aria-label={correctLabel}
        className="size-5 shrink-0 text-emerald-600"
      />
    ) : verdict === false ? (
      <XCircle aria-label={wrongLabel} className="size-5 shrink-0 text-red-600" />
    ) : (
      <Clock
        aria-label={pendingLabel}
        className="size-5 shrink-0 text-amber-500"
      />
    );
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-sm font-semibold",
        toned && verdict === true && "text-emerald-700 dark:text-emerald-300",
        toned && verdict === false && "text-red-600 dark:text-red-400",
        toned && verdict === null && "text-amber-700 dark:text-amber-300",
      )}
    >
      {icon}
      {label}
    </span>
  );
}

/**
 * 老师批改块（D9，显著展示）：有 teacherMark / teacherComment 任一时渲染。
 * teacherMark=null 且只有评语（清除判定保留评语）时标题显示「已评语」。
 * 2026-10 讲练一体：讲练页题卡结果态复用（导出；仍单一出处）。
 */
export function TeacherMarkBlock({
  teacherMark,
  teacherComment,
}: {
  teacherMark: "correct" | "wrong" | null;
  teacherComment: string | null;
}) {
  return (
    <div className="flex flex-col gap-1 border-l-2 border-sky-500 pl-3">
      <p className="flex items-center gap-1.5 text-sm font-medium text-sky-800 dark:text-sky-300">
        <PenLine aria-hidden className="size-4 shrink-0" />
        老师批改：
        {teacherMark === "correct"
          ? "判对"
          : teacherMark === "wrong"
            ? "判错"
            : "已评语"}
      </p>
      {teacherComment !== null && (
        <p className="break-words text-sm text-foreground [overflow-wrap:anywhere]">
          {teacherComment}
        </p>
      )}
    </div>
  );
}

/** 选项行（含正确项与学生所选标记；仅 choice/multi）。2026-10 讲练页题卡
 *  结果态复用（导出；仍单一出处）。 */
export function ResultOptions({
  question,
  released,
}: {
  question: AttemptResultQuestion;
  released: boolean;
}) {
  const options = question.snapshot.options;
  if (options === undefined) return null;
  const picked =
    question.answer?.kind === "choice"
      ? [question.answer.index]
      : question.answer?.kind === "multi"
        ? question.answer.indexes
        : [];
  const correct =
    question.answers?.kind === "choice"
      ? [question.answers.index]
      : question.answers?.kind === "multi"
        ? question.answers.indexes
        : [];
  return (
    <ol className="flex flex-col gap-1.5" aria-label="选项">
      {options.map((option, index) => {
        const isPicked = picked.includes(index);
        const isCorrect = released && correct.includes(index);
        return (
          <li
            key={option}
            className={cn(
              "flex min-h-11 flex-wrap items-start gap-2 rounded-lg border px-3 py-2 text-sm",
              isCorrect
                ? "border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10"
                : isPicked && released
                  ? "border-red-300 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10"
                  : isPicked
                    ? "border-primary bg-primary/5"
                    : "border-transparent",
            )}
          >
            <span className="mt-0.5 w-5 shrink-0 font-semibold">
              {letterOf(index)}
            </span>
            <RichMarkdown
              source={option}
              className="min-w-0 flex-1 text-base [&_p]:my-0"
            />
            {isCorrect && (
              <span className="shrink-0 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                {isPicked ? "正确项 · 你的选择" : "正确项"}
              </span>
            )}
            {isPicked && !isCorrect && (
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
          </li>
        );
      })}
    </ol>
  );
}

/**
 * 详解折叠（默认收起，触控 ≥44px）。结果视图与错题本卡片共用（同一概念
 * 同一份实现；无详解显示提示文案）。
 * T4.0b：可选 onToggle——结果页接入 directive_interact{host:result} 复盘埋点
 * （「错后有没有看解析」，§3 缺口 5）；错题本等其余调用方缺省不报。
 */
export function SolutionFold({
  solutionMd,
  onToggle,
  renderLayout,
  enabled = true,
}: {
  solutionMd: string | null;
  onToggle?: ((action: "open" | "close") => void) | undefined;
  /** 结果页将入口放入统一操作行，其余调用方沿用折叠布局。 */
  renderLayout?: (trigger: ReactNode, content: ReactNode) => ReactNode;
  /** 公布前隐藏详解，保持统一布局内的材料控制器挂载。 */
  enabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!enabled) return renderLayout?.(null, null) ?? null;
  if (solutionMd === null) {
    const absent = (
      <p className="text-sm text-muted-foreground">这道题没有详解。</p>
    );
    return renderLayout ? renderLayout(absent, null) : absent;
  }
  const trigger = (
    <Button
      variant="outline"
      className="min-h-11 w-fit shrink-0 whitespace-nowrap"
      aria-expanded={open}
      onClick={() => {
        const next = !open;
        onToggle?.(next ? "open" : "close");
        setOpen(next);
      }}
    >
      查看详解
      <ChevronDown
        aria-hidden
        className={cn("size-4 transition-transform", open && "rotate-180")}
      />
    </Button>
  );
  const content = open ? (
    <div className="border-s-2 border-border ps-3">
      <RichMarkdown source={solutionMd} className="text-sm" />
    </div>
  ) : null;
  return renderLayout ? (
    renderLayout(trigger, content)
  ) : (
    <div className="flex flex-col gap-2">
      {trigger}
      {content}
    </div>
  );
}

/** 手写题的笔迹缩略图（学生本人 PNG 直出；无笔迹整块隐藏） */
function InkThumbnail({
  attemptId,
  questionId,
}: {
  attemptId: string;
  questionId: string;
}) {
  const [available, setAvailable] = useState(true);
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`flex min-w-0 flex-col gap-1.5 ${open ? "w-full" : "w-fit"}`}
    >
      <Button
        variant="outline"
        className="min-h-11 w-fit"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <PenLine aria-hidden className="size-4" />
        查看手写原稿
        <ChevronDown
          aria-hidden
          className={cn("size-4 transition-transform", open && "rotate-180")}
        />
      </Button>
      {open && (
        <p className="text-sm text-muted-foreground">
          {available ? "我的手写笔迹" : "本次作答没有可查看的手写原稿。"}
        </p>
      )}
      {open && available && (
        <img
          src={studentInkPngUrl(attemptId, questionId)}
          alt={`第 ${questionId} 题的手写笔迹`}
          loading="lazy"
          className="w-full rounded-lg border border-border bg-white"
          onError={() => setAvailable(false)}
        />
      )}
    </div>
  );
}

/** 单题结果卡；released=false（T2A.8 截止后公布且未到截止）时只渲染本人作答内容 */
function ResultQuestionCard({
  aiTrigger,
  index,
  question,
  attemptId,
  released,
  roundLabel,
  onSolutionToggle,
}: {
  aiTrigger?: ReactNode;
  index: number;
  question: AttemptResultQuestion;
  attemptId: string;
  released: boolean;
  /** 轮次标注（T6R.11 原稿查看面板显示所属轮次） */
  roundLabel: string;
  /**
   * 详解折叠开合回调（T4.0b host=result 复盘埋点；缺省不报）。
   * @param action open=收起→展开、close=展开→收起
   */
  onSolutionToggle?:
    | ((questionId: string, index: number, action: "open" | "close") => void)
    | undefined;
}) {
  // 手写题型判定走共享 HANDWRITTEN_TYPES（与答题卡/教师卡单一事实来源）
  const isHandwritten = HANDWRITTEN_TYPES.has(question.snapshot.type);
  // 复算一次共享：verdict（公布后对错）与 unanswered（未公布态徽标/边框）同源
  const reviewState = reviewQuestionState(question, released);
  // D9：最终判定优先（交卷时 = autoCorrect，批注后以 teacherMark 为准）；
  // null = 待批（D3 后可自动判分题交卷即有 finalCorrect，null 即真待批）
  const verdict = reviewState.verdict;
  const renderTools = (
    explanationTrigger?: ReactNode,
    explanationContent?: ReactNode,
  ) => (
    <ResultQuestionTools
      questionNo={index + 1}
      explanationTrigger={explanationTrigger}
      explanationContent={explanationContent}
      history={
        <QuestionHistoryLink
          questionId={question.questionId}
          ariaPrefix={`第 ${index + 1} 题`}
        />
      }
      original={
        <>
          {!isHandwritten && (
            <NoteOriginalView
              compact
              viewer="student"
              attemptId={attemptId}
              questionId={question.questionId}
              ariaPrefix={`第 ${index + 1} 题`}
              roundLabel={roundLabel}
            />
          )}
          {isHandwritten && (
            <InkThumbnail
              attemptId={attemptId}
              questionId={question.questionId}
            />
          )}
          <AnnotationView
            compact
            viewer="student"
            attemptId={attemptId}
            questionId={question.questionId}
            questionNo={index + 1}
            ariaPrefix={`第 ${index + 1} 题`}
          />
        </>
      }
      correction={
        <>
          <AnnotationLayer
            attemptId={attemptId}
            questionId={question.questionId}
            phase="correction"
            ariaPrefix={`第 ${index + 1} 题`}
            triggerLabel="添加订正标画"
          />
          <CorrectionSection
            hideHistory
            compact
            attemptId={attemptId}
            questionId={question.questionId}
            ariaPrefix={`第 ${index + 1} 题`}
          />
        </>
      }
      more={
        <ReviewPackPanel
          compact
          viewer="student"
          attemptId={attemptId}
          questionId={question.questionId}
          questionNo={index + 1}
        />
      }
    />
  );
  return (
    <article
      data-review-question={question.questionId}
      className={cn(
        "relative flex scroll-mt-[calc(var(--attempt-header-height,96px)+16px)] flex-col gap-4 overflow-hidden rounded-lg border border-border bg-card p-4 pl-5 text-card-foreground sm:p-5 sm:pl-6",
        "before:absolute before:inset-y-0 before:left-0 before:w-1.5",
        !released
          ? reviewState.unanswered
            ? "before:bg-muted"
            : "before:bg-sky-400"
          : verdict === true
            ? "before:bg-emerald-500"
            : verdict === false
              ? "before:bg-red-500"
              : "before:bg-amber-400",
      )}
      aria-label={`第 ${index + 1} 题`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* T2A.8：未公布时不显示对错判定；显示答案已保存或未作答 */}
        {released ? (
          <VerdictBadge verdict={verdict} />
        ) : reviewState.unanswered ? (
          <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            未作答
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-sm font-semibold text-sky-700 dark:text-sky-300">
            <CheckCircle2
              aria-hidden
              className="size-4 shrink-0 text-sky-500"
            />
            答案已保存 · 待公布
          </span>
        )}
        <h3
          data-review-heading
          tabIndex={-1}
          className="text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          第 {index + 1} 题
        </h3>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${QUESTION_TYPE_BADGE_CLASS[question.snapshot.type]}`}
        >
          {QUESTION_TYPE_LABELS[question.snapshot.type]}
        </span>
        <span
          role="img"
          className="text-xs text-amber-500"
          aria-label={`难度 ${question.snapshot.difficulty} 星`}
        >
          {"★".repeat(question.snapshot.difficulty)}
          <span className="text-muted-foreground/60">
            {"★".repeat(5 - question.snapshot.difficulty)}
          </span>
        </span>
        {question.snapshot.knowledge.map((name) => (
          <span
            key={name}
            className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
          >
            {name}
          </span>
        ))}
        <div className="ml-auto">{aiTrigger}</div>
      </div>

      {/* 题干快照（服务端已 studentStemMd 投影；displayStemMd 兜底剥内嵌选项列表） */}
      <AnnotationView
        viewer="student"
        attemptId={attemptId}
        questionId={question.questionId}
        questionNo={index + 1}
        ariaPrefix={`第 ${index + 1} 题`}
      >
        <RichMarkdown
          source={displayStemMd(question.snapshot)}
          className="text-base"
        />
        <ResultOptions question={question} released={released} />
      </AnnotationView>

      <ResultAnswerComparison question={question} released={released} />

      {released &&
        (question.teacherMark !== null || question.teacherComment !== null) && (
          <TeacherMarkBlock
            teacherMark={question.teacherMark}
            teacherComment={question.teacherComment}
          />
        )}

      {/* 只回看本人已解锁的提示，公布前不增加任何答案材料。 */}
      {question.hintsOpened.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Lightbulb aria-hidden className="size-4" />
            做题时看过的提示（{question.hintsOpened.length} 条）
          </p>
          <HintEntryList entries={question.hintsOpened} />
        </div>
      )}

      <SolutionFold
        enabled={released}
        solutionMd={question.solutionMd}
        onToggle={
          onSolutionToggle === undefined
            ? undefined
            : (action) => onSolutionToggle(question.questionId, index, action)
        }
        renderLayout={renderTools}
      />
    </article>
  );
}

/** 结果视图本体 */
export function AttemptResultView({
  data,
  onBackHome,
  backLabel,
  onSolutionToggle,
  annotationSealWarning = false,
  wrongPractice,
  onRefresh,
}: {
  data: AttemptResultData;
  onBackHome: () => void;
  backLabel?: string | undefined;
  /**
   * 详解折叠开合回调（T4.0b host=result 复盘埋点）：页面层入队
   * directive_interact{host:result, attemptId, questionId, name:solution,
   * index=该题全卷 0 起序号, action}；缺省不报（测试等场景）。
   */
  onSolutionToggle?:
    | ((questionId: string, index: number, action: "open" | "close") => void)
    | undefined;
  /**
   * 「练习本卷错题」直达重练入口（2026-10）：页面层传入组卷动作与状态；
   * 缺省不渲染该按钮（测试等场景）。可见性由本视图按数据判定：
   * answersReleased 且 finalCorrect=false 的题数 > 0。
   */
  wrongPractice?: {
    /** 组卷请求进行中（按钮 loading 禁用，防重复建卷） */
    loading: boolean;
    /** 组卷失败的中文提示（null = 无失败）；非 null 时按钮下方渲染告警 */
    error: string | null;
    /** 点击按钮（questionIds = 本卷判错题按本卷题序） */
    onStart: (questionIds: string[]) => void;
  };
  /**
   * T6R.20 审查修复 2：交卷后的标注封存（seal）失败警示——非阻断
   * （交卷已成事实），服务端读路径懒补封兜底最终一致。
   */
  annotationSealWarning?: boolean;
  /** 到期自动刷新回调（由 PendingReleaseBanner 在截止到达时触发） */
  onRefresh?: (() => void) | undefined;
}) {
  const { attempt, summary } = data;
  // T2A.8：答案是否已公布（on_submit / 课程练习 / 已到截止 = true）
  const released = data.answersReleased;
  // T6R.11：原稿查看面板的轮次标注（重练同题后回看历史，可分辨第几轮）
  const roundLabel = attemptRoundLabel(attempt.sourceType, attempt.attemptNo);
  // D9：大数字得分 = 最终得分优先，未批完回退自动判分（均 null = 全待批）
  const displayScore = summary.scoreFinal ?? attempt.scoreAuto;
  // T2A.7：逐题结果按单元分组；题号全卷连续（累计 index）。
  // 多单元时渲染节标题（单元标题），单单元不显示节头（与答题视图一致）。
  const flatQuestions = useMemo(
    () => data.units.flatMap((unit) => unit.questions),
    [data.units],
  );
  const counts = reviewCounts(flatQuestions, released);
  const showUnitHeaders = data.units.length > 1;
  // 2026-10：本卷判错题（finalCorrect === false，按本卷题序）——直达重练的
  // 圈题范围与示数。未公布时服务端已把 finalCorrect 置 null（数出来必为 0），
  // 与 released 显隐判据双保险。
  const wrongQuestionIds = flatQuestions
    .filter((question) => question.finalCorrect === false)
    .map((question) => question.questionId);
  const showWrongPractice =
    released && wrongPractice !== undefined && wrongQuestionIds.length > 0;
  // SAI-22 结果页 AI 复盘：完成后按 §7.5 入口变「AI 复盘」，绑定回看当前题；
  // 复盘态不采集材料（结果页无作答会话——纯文字求助，题面与答案解析由
  // 服务端快照携带）。rail 包住回看列表，原稿/订正控制器不因面板卸载。
  const rootRef = useRef<HTMLDivElement>(null);
  const questionIds = useMemo(
    () => flatQuestions.map((question) => question.questionId),
    [flatQuestions],
  );
  const reviewLocation = useResultReviewLocation(
    attempt.id,
    questionIds,
    released,
    rootRef,
  );
  const indexOfQuestion = useMemo(
    () => new Map(questionIds.map((id, i) => [id, i + 1] as const)),
    [questionIds],
  );
  const aiCompanion = useAiCompanionDock({
    attemptId: attempt.id,
    questions: questionIds.map((id) => ({ id })),
    isHandwritten: (questionId) => {
      const question = flatQuestions.find(
        (item) => item.questionId === questionId,
      );
      return question !== undefined
        ? HANDWRITTEN_TYPES.has(question.snapshot.type)
        : false;
    },
    surfaceOf: () => null,
    flush: () => Promise.resolve(),
    titleOf: (questionId) =>
      `第 ${indexOfQuestion.get(questionId) ?? "？"} 题 · ${data.title}`,
    labelOf: (questionId) =>
      indexOfQuestion.has(questionId)
        ? `第 ${indexOfQuestion.get(questionId)} 题`
        : null,
    currentQuestionId: reviewLocation.currentId,
    editor: null,
    materials: { annotation: false, paper: false },
    triggerLabel: "AI 复盘",
  });
  return (
    <ResultWorkspace
      title={data.title}
      attemptId={attempt.id}
      questions={flatQuestions}
      status={attempt.status}
      released={released}
      onBack={onBackHome}
      backLabel={
        backLabel ??
        (attempt.sourceType === "course"
          ? "返回单元练习"
          : attempt.sourceType === "wrong"
            ? "返回错题本"
            : attempt.sourceType === "lesson"
              ? "返回讲练页"
              : "返回首页")
      }
      actions={
        <>
          {/* SAI-31 批量复盘入口：勾选只进面板，创建走一次确认（B16） */}
          <AiBatchReviewEntry
            attemptId={attempt.id}
            questions={flatQuestions.map((question) => ({
              questionId: question.questionId,
              label: indexOfQuestion.has(question.questionId)
                ? `第 ${indexOfQuestion.get(question.questionId)} 题`
                : question.questionId,
              // 未公布时服务端已置 null，这里再按 released 收口（双保险，
              // 与上方错题重练同款显隐判据）
              finalCorrect: released ? question.finalCorrect : null,
            }))}
            released={released}
          />
          <AiQueueButton
            currentAttemptId={aiCompanion.send.attemptId}
            onOpenTask={aiCompanion.openTask}
            onOpenQuestion={aiCompanion.openQuestion}
          />
        </>
      }
      rootRef={rootRef}
      reviewLocation={reviewLocation}
    >
      {aiCompanion.rail(
        <div className="flex flex-col gap-5">
          {/* 得分汇总卡（未公布时替换为「已交卷」横幅 + 已答统计，不显示对错与得分） */}
          <section
            aria-labelledby="result-summary"
            className="flex flex-col gap-4 border-b border-border py-5"
          >
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <h2
                id="result-summary"
                className="text-lg leading-snug font-semibold"
              >
                {released ? "批改结果" : "已交卷"}
              </h2>
              {/* 来源行（T2A.6，与答题视图同口径）：课程练习带次数（历次回看可分辨
              第几次）；作业标「作业」（挂课程时「作业 · 课程名」，T2A.7）；
              错题重练「错题重练 · 第 n 次」（2026-10）；讲练「讲练：讲义标题 ·
              第 n 次」（title 为讲义标题，2026-10 讲练一体） */}
              <p className="text-sm leading-relaxed text-muted-foreground">
                {attemptSourceLabel(data)}
              </p>
              {attempt.submittedAt !== null && (
                <p className="text-sm leading-relaxed text-muted-foreground">
                  交卷时间：{formatCnTime(attempt.submittedAt)}
                </p>
              )}
            </div>
            {released ? (
              <div className="grid min-w-0 gap-4 lg:grid-cols-[140px_minmax(0,1fr)] lg:items-start">
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">
                    {summary.scoreFinal !== null ? "最终得分" : "自动判分得分"}
                  </p>
                  <p className="flex items-baseline gap-2 tabular-nums">
                    <span className="text-4xl leading-tight font-semibold text-primary">
                      {/* D9：全部批完显示最终得分，否则回退自动判分（无可判分为「待批」） */}
                      {displayScore === null ? "待批" : displayScore}
                    </span>
                    {displayScore !== null && (
                      <span className="text-base text-muted-foreground">
                        / 100
                      </span>
                    )}
                  </p>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {summary.scoreFinal !== null
                      ? "含老师批改，满分 100"
                      : attempt.scoreAuto === null
                        ? "暂无可自动判分的题目"
                        : "满分 100"}
                  </p>
                </div>
                <dl
                  aria-label="题目数量统计"
                  className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-5 [&>div]:flex [&>div]:min-w-0 [&>div]:flex-col [&>div]:gap-1.5 [&>div]:rounded-lg [&>div]:border [&>div]:px-3 [&>div]:py-3 [&_dt]:text-sm [&_dt]:font-medium [&_dd]:text-2xl [&_dd]:leading-tight [&_dd]:font-semibold [&_dd]:tabular-nums [&_dd>span]:ml-1 [&_dd>span]:text-xs [&_dd>span]:font-normal"
                >
                  <div className="border-border bg-muted/50">
                    <dt>总题数</dt>
                    <dd>
                      {summary.total}
                      <span>题</span>
                    </dd>
                  </div>
                  <div className="border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300">
                    <dt>答对</dt>
                    <dd>
                      {counts.correct}
                      <span>题</span>
                    </dd>
                  </div>
                  <div className="border-red-200 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
                    <dt>答错</dt>
                    <dd>
                      {counts.wrong}
                      <span>题</span>
                    </dd>
                  </div>
                  <div className="border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                    <dt>待批</dt>
                    <dd>
                      {/* D9：pendingCount 为 D4 权威计数（批注后 autoCorrect 仍空而
                      finalCorrect 已定；公布态下恒非 null，回退仅兜底） */}
                      {summary.pendingCount ?? summary.pending}
                      <span>题</span>
                    </dd>
                  </div>
                  {/* D1（T3.2a）：未作答客观题已判错计入「答错」；「未答」独立展示
                  （此前挂在待批下的「含未答」不再准确——未答的待批题只剩手写/
                  无标准答案，其余未答客观题在答错里） */}
                  <div className="border-border bg-background">
                    <dt>未答</dt>
                    <dd>
                      {summary.unanswered}
                      <span>题</span>
                    </dd>
                  </div>
                </dl>
                {summary.unanswered > 0 && (
                  <p className="text-sm leading-relaxed text-muted-foreground lg:col-span-2">
                    未答数单独统计，可能与判错或待批重叠，不能相加。
                  </p>
                )}
              </div>
            ) : (
              <PendingReleaseBanner
                dueAt={data.dueAt}
                submittedAt={attempt.submittedAt}
                summary={summary}
                onRefresh={onRefresh}
              />
            )}
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {/* 练习本卷错题（2026-10 直达重练）：N=本卷判错题数；点击组新
                重练卷并跳作答（提交中 loading 禁用防重复建卷） */}
                {showWrongPractice && wrongPractice !== undefined && (
                  <Button
                    variant="secondary"
                    className="min-h-11"
                    disabled={wrongPractice.loading}
                    onClick={() => wrongPractice.onStart(wrongQuestionIds)}
                  >
                    <RotateCcw
                      aria-hidden
                      className={cn(
                        "size-4",
                        wrongPractice.loading && "animate-spin",
                      )}
                    />
                    {wrongPractice.loading
                      ? "正在组卷…"
                      : `练习本卷错题（${wrongQuestionIds.length} 题）`}
                  </Button>
                )}
              </div>
              {/* 组卷失败（网络/题目状态变化含 400 WRONG_PRACTICE_EMPTY 极端
              情况）：中文告警，可重试（再点按钮）或刷新本页 */}
              {showWrongPractice &&
                wrongPractice !== undefined &&
                wrongPractice.error !== null && (
                  <p
                    role="alert"
                    className="flex items-center gap-1.5 text-sm text-destructive"
                  >
                    <TriangleAlert aria-hidden className="size-4 shrink-0" />
                    练习本卷错题组卷失败：{wrongPractice.error}
                    ；题目状态可能有变化，请稍后重试或刷新本页。
                  </p>
                )}
            </div>
          </section>

          {/* T6R.20 审查修复 2：交卷后标注封存失败的非阻断警示（懒补封兜底） */}
          {annotationSealWarning && (
            <p
              role="status"
              className="flex items-center gap-1.5 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
            >
              <TriangleAlert aria-hidden className="size-4 shrink-0" />
              题干标注封存待重试（不影响本次交卷；稍后回看标注时系统会自动补封）
            </p>
          )}

          {/* 逐题结果（T2A.7：多单元按节分组，题号全卷连续） */}
          <ol className="flex flex-col gap-4">
            {data.units.map((unit) => (
              <li key={unit.id} className="flex flex-col gap-4">
                {showUnitHeaders && (
                  <h2
                    data-review-unit={unit.id}
                    className="flex items-center gap-2 pt-2 text-sm font-semibold text-foreground before:h-4 before:w-1 before:rounded-full before:bg-primary"
                  >
                    {unit.title}
                  </h2>
                )}
                <ol className="flex flex-col gap-4">
                  {unit.questions.map((question) => (
                    <li key={question.questionId}>
                      <ResultQuestionCard
                        aiTrigger={aiCompanion.triggerForQuestion(
                          question.questionId,
                        )}
                        index={flatQuestions.indexOf(question)}
                        question={question}
                        attemptId={attempt.id}
                        released={released}
                        roundLabel={roundLabel}
                        onSolutionToggle={onSolutionToggle}
                      />
                      {aiCompanion.inlineForQuestion(question.questionId)}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        </div>,
      )}
    </ResultWorkspace>
  );
}
