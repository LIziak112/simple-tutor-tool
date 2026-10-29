import type {
  AttemptResultData,
  AttemptResultQuestion,
  MaterialRef,
} from "@tutor/contract";
import { displayStemMd } from "@tutor/md-dsl";
import { cn } from "cn";
import {
  CheckCircle2,
  ChevronDown,
  Lightbulb,
  PenLine,
  RotateCcw,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AnnotationView } from "@/features/annotation/AnnotationView";
import {
  groupSegmentsOfUnit,
  questionMaterialsOf,
} from "@/features/attempt/attempt-context-view";
import { useAttemptContext } from "@/features/attempt/attempt-queries";
import { HintEntryList } from "@/features/attempt/HintPanel";
import { QuestionGroupAnchor } from "@/features/attempt/QuestionGroupAnchor";
import { QuestionMaterialsAnchor } from "@/features/attempt/QuestionMaterialsAnchor";
import { ReviewPackPanel } from "@/features/export/review-pack-panel";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { CorrectionSection } from "@/features/notes/CorrectionSection";
import { DraftRecoverySection } from "@/features/notes/DraftRecoverySection";
import { NoteOriginalView } from "@/features/notes/NoteOriginalView";
import { QuestionHistoryLink } from "@/features/notes/QuestionHistoryLink";
import { AiAttemptReviewEntry } from "@/features/student-ai/AiAttemptReviewPanel";
import { AiBatchReviewEntry } from "@/features/student-ai/AiBatchReviewPanel";
import { useAiCompanionDock } from "@/features/student-ai/AiCompanionDock";
import { AiQueueButton } from "@/features/student-ai/AiQueueButton";
import { studentInkPngUrl } from "@/lib/api";
import { formatCnTime } from "@/lib/time";
import { ResultOptions, VerdictBadge } from "./AttemptResultParts";
import {
  attemptRoundLabel,
  attemptSourceLabel,
  HANDWRITTEN_TYPES,
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "./answer-format";

// 轻量呈现件拆至 AttemptResultParts（草稿视图的逐题反馈静态引用它们，不得
// 把本重模块拖进作答页）；此处对外再导出，既有调用方不受影响。
export { ResultOptions, VerdictBadge } from "./AttemptResultParts";

import { PendingReleaseBanner } from "./PendingReleaseBanner";
import { ResultAnswerComparison } from "./ResultAnswerComparison";
import { ResultQuestionTools } from "./ResultQuestionTools";
import { ResultWorkspace } from "./ResultWorkspace";
import { reviewCounts, reviewQuestionState } from "./result-review-model";
import { SelfReviewSection } from "./SelfReviewSection";
import { verdictBadgeDisplayOf } from "./self-review-display";
import { useResultReviewLocation } from "./use-result-review-location";

/**
 * 交卷后的结果视图（T2.6）：顶部得分汇总（scoreAuto/对错待批数/提交时间）+
 * 逐题结果卡（✓/✗/待批图标、题干快照、本人答案 vs 参考答案、详解默认折叠）。
 * T2.8：手写题（solve/apply/find-error）的手写原稿 PNG 在「草稿」组直接
 * 展示——学生本人笔迹经 GET /api/student/attempts/:id/ink/:questionId.png
 * 文件直出（不进 base64/不进库）；无笔迹时显示说明（img onerror 兜底）。
 * 2026-10 订正重构：每题单行操作栏 = 查看详解｜草稿（草稿原稿/手写原稿 +
 * D8 找回）｜订正（直达全屏重做工作台，见 CorrectionSection）｜本题历史｜
 * 更多；题干标注恒由题面原位 AnnotationView 直显，不再提供独立标注组。
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
 * 「最终得分」）。QM-12（TT-09c）：待判断计数与对/错计数统一走有效判定口径
 * （reviewCounts → verdictBadgeDisplayOf：教师判 > 自评 > 自动——自评行按
 * 自评三态计数，与逐题徽章同出处不漂移；原 D9 的 pendingCount（教师待批
 * 权威计数）不再顶「待批」瓦片——自评卷会漏计待自评行）。公布 gate 截止前
 * 服务端已把这些字段置 null 投影，前端照常落入「未批/待公布」分支（双保险）。
 * 2026-10（学生端闭环补完）：汇总卡操作区新增「练习本卷错题（N 题）」次级
 * 按钮——N = 本卷已判定为错的题数（逐题 finalCorrect === false，不含待批
 * finalCorrect=null；公布前已被 gate 置 null，天然不参与计数）。未公布
 * （answersReleased=false）或 N=0（全对/只剩待批）时隐藏。点击由页面层调
 * POST /wrong-practice 组新重练卷并跳作答（onStart 携带按本卷题序的
 * questionIds，服务端校验这些题必在错题本聚合内）。
 */

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

/** 手写题的笔迹面板（学生本人 PNG 直出；无笔迹给出说明；挂载即加载） */
function HandwrittenInkPanel({
  attemptId,
  questionId,
  ariaPrefix,
}: {
  attemptId: string;
  questionId: string;
  ariaPrefix: string;
}) {
  const [available, setAvailable] = useState(true);
  return (
    <div className="flex w-full min-w-0 flex-col gap-2 rounded-lg border border-border bg-card px-3 py-3">
      <p className="text-sm font-medium">手写原稿</p>
      {available ? (
        <img
          src={studentInkPngUrl(attemptId, questionId)}
          alt={`${ariaPrefix}的手写笔迹`}
          loading="lazy"
          className="w-full rounded-lg border border-border bg-white"
          onError={() => setAvailable(false)}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          本次作答没有可查看的手写原稿。
        </p>
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
  // null = 待批（D3 后可自动判分题交卷即有 finalCorrect，null 即真待批）。
  // QM-11：reference_self 行（教师未判）按自评三态显示（待自评/自评正确/
  // 自评错误，verdictBadgeDisplayOf 单一出处）；徽章与左边框共用其 verdict
  const badge = verdictBadgeDisplayOf(question);
  const verdict = released ? badge.verdict : reviewState.verdict;
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
      draft={
        <>
          {isHandwritten ? (
            <HandwrittenInkPanel
              attemptId={attemptId}
              questionId={question.questionId}
              ariaPrefix={`第 ${index + 1} 题`}
            />
          ) : (
            <NoteOriginalView
              compact
              defaultOpen
              viewer="student"
              attemptId={attemptId}
              questionId={question.questionId}
              ariaPrefix={`第 ${index + 1} 题`}
              roundLabel={roundLabel}
            />
          )}
          {/* 题干标注回看 + 合成图导出（底图＋圈，粘贴给 AI/保存）——题面
              原位直显之外的学生侧导出出口（2026-10 复审恢复：入口随组按需
              挂载，compact 关闭态零请求） */}
          <AnnotationView
            compact
            viewer="student"
            attemptId={attemptId}
            questionId={question.questionId}
            questionNo={index + 1}
            ariaPrefix={`第 ${index + 1} 题`}
          />
          {/* D8 找回草稿/补充稿同步状态：草稿材料语义，随草稿组挂载 */}
          <DraftRecoverySection
            attemptId={attemptId}
            questionId={question.questionId}
          />
        </>
      }
      correction={
        <CorrectionSection
          attemptId={attemptId}
          questionId={question.questionId}
          questionNo={index + 1}
          ariaPrefix={`第 ${index + 1} 题`}
          roundLabel={roundLabel}
          question={question}
        />
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
        "relative flex scroll-mt-[calc(var(--attempt-header-height,96px)+16px)] flex-col gap-4 overflow-hidden rounded-lg border border-border bg-card p-4 pl-5 text-card-foreground sm:p-5 sm:pl-6 isolate",
        "before:absolute before:inset-y-0 before:left-0 before:w-1.5",
        !released
          ? reviewState.unanswered
            ? "before:bg-muted"
            : "before:bg-sky-400"
          : verdict === true
            ? "before:bg-emerald-500"
            : verdict === false
              ? question.answered
                ? "before:bg-red-500"
                : "before:bg-muted" // #6980-3：未做灰，不套判错红
              : "before:bg-amber-400",
      )}
      aria-label={`第 ${index + 1} 题`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* T2A.8：未公布时不显示对错判定；显示答案已保存或未作答。
            「标过不会」是学生做题时的事实标注（#6980-4），不受公布 gate 与
            自评分支影响——自评题与待公布卷同样显示（审查修复 P1-5） */}
        {released ? (
          <VerdictBadge
            verdict={badge.verdict}
            notDone={badge.notDone ?? false}
            {...(badge.pendingLabel !== undefined && {
              pendingLabel: badge.pendingLabel,
            })}
            {...(badge.correctLabel !== undefined && {
              correctLabel: badge.correctLabel,
            })}
            {...(badge.wrongLabel !== undefined && {
              wrongLabel: badge.wrongLabel,
            })}
          />
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
        {question.studentFlag === "unsure" && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            标过不会
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

      {/* QM-11：对照后挂自评动作（reference_self 行；教师已判时整块不渲染，
          判定显示走下方批改块——教师优先） */}
      {released && (
        <SelfReviewSection attemptId={attemptId} question={question} />
      )}

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
  redo,
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
   * 作业重做「再做一次」入口（hall-15313）：页面层传入开新卷动作与状态；
   * 缺省不渲染（课程/错题/讲练来源、测试场景）。可见性由本视图按数据判定：
   * attempt.sourceType === "assignment" 且 allowRedo 为 true（旧响应缺省
   * undefined 按 true 处理——存量作业即允许重做）。
   */
  redo?: {
    /** 开新卷请求进行中（按钮 loading 禁用，防重复开卷） */
    loading: boolean;
    /** 开新卷失败的中文提示（null = 无失败；含教师关闭重做后的兜底提示） */
    error: string | null;
    /** 确认「再做一次」（页面层 POST redo:true 并跳新卷） */
    onStart: () => void;
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
  // QM-08 验收行：只读题面与作答共用数据解释——同一 /attempts/:id/context
  // 冻结投影经 groupSegmentsOfUnit 解释组段（不另写一套归属逻辑）。失败/
  // legacy 卷（无上下文条目）按 undefined 处理 → 全部 solo 段，回看零变化
  // （材料缺省不阻断回看；服务端对坏快照已 fail-closed 409）
  const contextQuery = useAttemptContext(attempt.id);
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
  // 2026-10：本卷错题——直达重练的圈题范围与示数。QM-12 起判错按有效判定
  // （教师判 > 自评 > 自动，verdictBadgeDisplayOf 同口径）：自评「错」同样
  // 可重练；#6980-3：未做轮不圈入（人工显式判定的未做行不被掩盖——与
  // 错题本 enteredWrongBook 同口径）；#6980-4：标过「不会」的题（含做对）
  // 也进本卷错题（标不会 = 按做错结算的主人口径）。未公布时服务端已把判定键
  // 整键 null 投影（数出来必为 0），与 released 显隐判据双保险。
  const wrongQuestionIds = flatQuestions
    .filter((question) => {
      const badge = verdictBadgeDisplayOf(question);
      if (question.studentFlag === "unsure") return true;
      if (badge.verdict !== false) return false;
      return (
        question.answered ||
        question.teacherMark !== null ||
        (question.selfReview?.record?.verdict ?? null) !== null
      );
    })
    .map((question) => question.questionId);
  // QM-12：含自评行时注明口径（自评是本人判定；得分只按自动判定与教师
  // 批改计算——不把自评冒充客观独立完成证据）
  const hasSelfReviewRows =
    released &&
    flatQuestions.some(
      (question) => (question.gradingPolicy ?? null) === "reference_self",
    );
  const showWrongPractice =
    released && wrongPractice !== undefined && wrongQuestionIds.length > 0;
  // 作业重做（hall-15313）：再做一次入口——仅作业来源且允许重做（旧响应
  // 缺省按允许处理）；确认弹层防误触（新卷从空白开始、本卷保留可回看）
  const [redoOpen, setRedoOpen] = useState(false);
  const showRedo =
    attempt.sourceType === "assignment" &&
    (attempt.allowRedo ?? true) &&
    redo !== undefined;
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
              // QM-12：喂有效判定（教师判 > 自评 > 自动，verdictBadgeDisplayOf
              // 同口径）——自评「错」进错题组（与服务端批量过滤同口径）；
              // 未公布时服务端已置 null，这里再按 released 收口（双保险，
              // 与上方错题重练同款显隐判据）
              finalCorrect: released
                ? verdictBadgeDisplayOf(question).verdict
                : null,
            }))}
            released={released}
          />
          {/* 整体复盘入口（任务 1ef854c7）：预览确认后创建一个 MCP 整体任务，
              与逐题批量复盘互不混装 */}
          <AiAttemptReviewEntry attemptId={attempt.id} released={released} />
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
            {/* M4-D3 §13.8 反馈节奏摘要：v1 新协议卷按 feedbackMode 呈现；
            legacy/lesson 卷缺省不渲染（数据侧同样缺省）。纯呈现——反馈可见性
            仍由 answersReleased gate 决定，本行不透露任何对错/答案 */}
            {data.practiceWorkflow !== undefined && (
              <p
                data-slot="practice-rhythm"
                className="text-sm leading-relaxed text-muted-foreground"
              >
                {`反馈节奏：${
                  data.practiceWorkflow.feedbackMode === "per_question"
                    ? "作答时逐题反馈，每题提交后即可查看该题反馈"
                    : "交卷后反馈，交卷后统一查看"
                }`}
                {!released && "；参考答案与对错按教师公布时间公布"}
              </p>
            )}
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
                    <dt>待判断</dt>
                    <dd>
                      {/* QM-12：有效判定口径（教师判 > 自评 > 自动）的未判断数
                      （含待教师批改与待自评，逐题徽章区分两态）；与徽章同出处
                      （reviewCounts→verdictBadgeDisplayOf），公布态下与答对/答错
                      三分互补。D9 的 pendingCount（教师待批权威计数）另在
                      「有 X 题待批」提示位消费 */}
                      {counts.pending}
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
                    未答数单独统计，可能与判错或待判断重叠，不能相加。
                  </p>
                )}
                {hasSelfReviewRows && (
                  <p className="text-sm leading-relaxed text-muted-foreground lg:col-span-2">
                    含对照自评的题目按你的自评计入答对/答错；得分只按自动判定
                    与老师批改计算，自评不是客观测评成绩。
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
                {showRedo && (
                  <Button
                    className="min-h-11"
                    disabled={redo.loading}
                    onClick={() => setRedoOpen(true)}
                  >
                    <RotateCw
                      aria-hidden
                      className={cn("size-4", redo.loading && "animate-spin")}
                    />
                    再做一次
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
              {showRedo && redo.error !== null && (
                <p
                  role="alert"
                  className="flex items-center gap-1.5 text-sm text-destructive"
                >
                  <TriangleAlert aria-hidden className="size-4 shrink-0" />
                  再做一次失败：{redo.error}
                  ；请稍后重试或刷新本页。
                </p>
              )}
              {/* 再做一次确认（hall-15313）：显式动作——新卷从空白开始，本卷
              保留可回看（文案与讲练「再做一次」先例同口径） */}
              {showRedo && (
                <Dialog open={redoOpen} onOpenChange={setRedoOpen}>
                  <DialogContent className="w-[calc(100%-24px)] max-w-md">
                    <DialogHeader>
                      <DialogTitle>再做一次吗？</DialogTitle>
                      <DialogDescription className="text-sm leading-6">
                        将开始第 {attempt.attemptNo + 1}
                        次作答，全部题目从空白开始；这一次的作答会保留，可随时在「我的记录」回看。
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <Button
                        variant="outline"
                        className="min-h-11"
                        onClick={() => setRedoOpen(false)}
                      >
                        先不用
                      </Button>
                      <Button
                        className="min-h-11"
                        disabled={redo.loading}
                        onClick={() => {
                          setRedoOpen(false);
                          redo.onStart();
                        }}
                      >
                        开始第 {attempt.attemptNo + 1} 次
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
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

          {/* 逐题结果（T2A.7：多单元按节分组，题号全卷连续）。
              QM-08：题目序经 groupSegmentsOfUnit 解释成组段——组段共享材料
              按组渲染一份（与作答视图同一数据解释单源）。审查 P1 修复：与
              作答视图同构——题组只是题行 ol 里的兄弟锚点，题行永不进组子树，
              context 后到不重挂题卡（回看本无控制器，与作答侧共享一份结构）。
              P1-2：solo 题的题级 ::ref 材料挂题级锚（与作答视图同口径）；
              segments 展平成单层题行数组（嵌套数组 key 带段位前缀会重挂行，
              与作答侧同修复）。 */}
          <ol className="flex flex-col gap-4">
            {data.units.map((unit) => {
              const questionById = new Map(
                unit.questions.map(
                  (question) => [question.questionId, question] as const,
                ),
              );
              // P1-2：题级引用映射（学生题目投影携带）——组段并集 + solo 锚共用
              const questionRefs = new Map<string, readonly MaterialRef[]>([]);
              for (const question of unit.questions) {
                const refs = question.snapshot.materialRefs;
                if (refs !== undefined && refs.length > 0)
                  questionRefs.set(question.questionId, refs);
              }
              const segments = groupSegmentsOfUnit(
                contextQuery.data,
                unit.questions.map((question) => question.questionId),
                questionRefs,
              );
              /** 单题行（组行/独立行共用；组行不挂「查看材料」——回看布局
                  上下排布自然阅读，无需 reveal 跳转） */
              const renderRow = (questionId: string) => {
                const question = questionById.get(questionId);
                if (question === undefined) return null;
                return (
                  <li key={question.questionId} className="min-w-0">
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
                );
              };
              return (
                <li key={unit.id} className="flex flex-col gap-4">
                  {showUnitHeaders && (
                    <h2
                      data-review-unit={unit.id}
                      className="flex items-center gap-2 pt-2 text-sm font-semibold text-foreground before:h-4 before:w-1 before:rounded-full before:bg-primary"
                    >
                      {unit.title}
                    </h2>
                  )}
                  <ol data-layout="stack" className="flex flex-col gap-4">
                    {segments.flatMap((segment) =>
                      segment.kind === "solo"
                        ? segment.questionIds.flatMap((questionId) => {
                            const question = questionById.get(questionId);
                            if (question === undefined) return [];
                            // P1-2：solo 题级材料锚（回看自然阅读，无 reveal
                            // 跳转——与组材料列同理由）
                            const soloMaterials = questionMaterialsOf(
                              contextQuery.data,
                              question.snapshot,
                            );
                            return soloMaterials.length === 0
                              ? [renderRow(questionId)]
                              : [
                                  <QuestionMaterialsAnchor
                                    key={`qmat:${question.questionId}`}
                                    questionId={question.questionId}
                                    materials={soloMaterials}
                                    readingKey={`${attempt.id}|q:${question.questionId}`}
                                    className="min-w-0"
                                    attemptId={attempt.id}
                                  />,
                                  renderRow(questionId),
                                ];
                          })
                        : [
                            <QuestionGroupAnchor
                              key={`group:${segment.group.id}`}
                              group={segment.group}
                              materials={segment.materials}
                              questionCount={segment.questionIds.length}
                              readingKey={`${attempt.id}|${segment.group.id}`}
                              layoutMode="stack"
                              attemptId={attempt.id}
                            />,
                            ...segment.questionIds.map((questionId) =>
                              renderRow(questionId),
                            ),
                          ],
                    )}
                  </ol>
                </li>
              );
            })}
          </ol>
        </div>,
      )}
    </ResultWorkspace>
  );
}
