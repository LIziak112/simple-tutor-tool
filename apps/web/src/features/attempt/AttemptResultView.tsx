import { ReviewV2Panel } from "@/features/student-ai/ReviewV2Panel";
import { attemptTimeLabel } from "./attempt-time-label";
import { ResultQuestionCard } from "./ResultQuestionCard";

export { TeacherMarkBlock } from "./ResultQuestionCard";
export { SolutionFold } from "./ResultSolutionFold";

import type { AttemptResultData } from "@tutor/contract";
import { cn } from "cn";
import { RotateCcw, RotateCw, TriangleAlert } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAttemptContext } from "@/features/attempt/attempt-queries";
import { useLearningContextPublisher } from "@/features/learning-context/use-learning-context-publisher";
import {
  QuestionProcessControls,
  useQuestionProcess,
} from "@/features/question-process/session";
import { AiAttemptReviewHint } from "@/features/student-ai/AiAttemptReviewHint";
import { AttemptReviewHost } from "@/features/student-ai/AttemptReviewHost";
import { AttemptReviewTopBarEntry } from "@/features/student-ai/AttemptReviewTopBarEntry";
import { useAttemptReviewOverlay } from "@/features/student-ai/attempt-review-overlay";
import { formatCnTime } from "@/lib/time";
import { AssignmentRedoDialog } from "./AssignmentRedoDialog";
import { ResultTimeLimitLine } from "./AttemptTimer";
import { attemptRoundLabel, attemptSourceLabel } from "./answer-format";
import { isRetrainable } from "./module-result-model";
import { ResultActivityLine } from "./QuestionActivity";
import { ReviewTemplateFrame } from "./ReviewTemplateFrame";

// 轻量呈现件拆至 AttemptResultParts（草稿视图的逐题反馈静态引用它们，不得
// 把本重模块拖进作答页）；此处对外再导出，既有调用方不受影响。
export { ResultOptions, VerdictBadge } from "./AttemptResultParts";

import { PendingAttemptRelease } from "./PendingReleaseBanner";
import { ResultAiActions, useResultAiCompanion } from "./ResultAiActions";
import { ResultQuestionList } from "./ResultQuestionList";
import { ResultWorkspace } from "./ResultWorkspace";
import { reviewCounts } from "./result-review-model";
import { useResultMountWindow } from "./use-result-mount-window";
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
 * T2A.8（D11）：answersReleased=false（截止后公布且未到截止）时汇总卡换成
 * 「已交卷，答案将在截止后公布」横幅，逐题卡只渲染题干、选项、本人答案、笔迹
 * 与已解锁提示；不显示判定、参考答案与详解（服务端本就不下发，前端双保险）。
 * D9（T3.5）：逐题展示最终判定（finalCorrect 优先于 autoCorrect）与老师批改块；
 * 汇总大数字 scoreFinal ?? scoreAuto。QM-12（TT-09c）：待判断与对/错计数统一
 * 走有效判定口径（reviewCounts → verdictBadgeDisplayOf：教师判 > 自评 > 自动，
 * 与逐题徽章同出处）。公布 gate 截止前服务端已把这些字段置 null（双保险）。
 * 2026-10 汇总卡操作区「练习本卷错题（N 题）」：N = finalCorrect === false 题数
 * （待批 null 不计；公布前被 gate 置 null）；未公布或 N=0 隐藏。点击由页面层调
 * POST /wrong-practice 组新重练卷并跳作答（服务端校验题必在错题本聚合内）。
 */

/**
 * 老师批改块（D9，显著展示）：有 teacherMark / teacherComment 任一时渲染。
 * teacherMark=null 且只有评语（清除判定保留评语）时标题显示「已评语」。
 * 2026-10 讲练一体：讲练页题卡结果态复用（导出；仍单一出处）。
 */

/**
 * 详解折叠（默认收起，触控 ≥44px）。结果视图与错题本卡片共用（同一概念
 * 同一份实现；无详解显示提示文案）。
 * T4.0b：可选 onToggle——结果页接入 directive_interact{host:result} 复盘埋点
 * （「错后有没有看解析」，§3 缺口 5）；错题本等其余调用方缺省不报。
 */

/** 手写题的笔迹面板（学生本人 PNG 直出；无笔迹给出说明；挂载即加载） */

/** 单题结果卡；released=false（T2A.8 截止后公布且未到截止）时只渲染本人作答内容 */

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
  data: AttemptResultData & { clockAnchor?: number };
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
    /** 点击按钮（questionIds 按本卷题序；moduleTitle = 模块专项重练时的模块名） */
    onStart: (questionIds: string[], moduleTitle?: string) => void;
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
    onStart: (timing: { timeLimitMinutes?: number }) => void;
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
  const questionProcess = useQuestionProcess({
    attemptId: attempt.id,
    enabled: attempt.sourceType === "course",
    ready: false,
    questions: [],
    answers: null,
    hintsOpened: {},
  });
  // QM-08：只读题面与作答共用 /attempts/:id/context 冻结投影经 groupSegmentsOfUnit
  // 解释组段；失败 / legacy 卷按 undefined → 全部 solo 段，回看零变化
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
  // 2026-10：本卷错题——直达重练的圈题范围与示数（口径单源 isRetrainable，
  // 与模块 7 按模块「专项重练」同一函数）：有效判定为错且已作答 / 教师已判 /
  // 自评有记录，或标过「不会」。未公布时服务端已把判定键整键 null（数出来必为 0）
  const wrongQuestionIds = flatQuestions
    .filter(isRetrainable)
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
  const lazyResults = questionIds.length > 20;
  const resultMounts = useResultMountWindow(attempt.id, lazyResults);
  const reviewLocation = useResultReviewLocation(
    attempt.id,
    questionIds,
    released,
    rootRef,
    resultMounts.beforeJump,
  );
  const indexOfQuestion = useMemo(
    () => new Map(questionIds.map((id, index) => [id, index + 1] as const)),
    [questionIds],
  );
  const learningQuestions = useMemo(
    () =>
      flatQuestions.map((q) => ({
        id: q.questionId,
        questionRevisionId: q.questionRevisionId,
      })),
    [flatQuestions],
  );
  const publisher = useLearningContextPublisher({
    route: attempt.id,
    surface: "result",
    questions: learningQuestions,
    title: data.title,
    attemptStatus: attempt.status,
    observedId: reviewLocation.currentId,
  });
  const attemptReview = useAttemptReviewOverlay();
  const aiCompanion = useResultAiCompanion({
    attemptId: attempt.id,
    title: data.title,
    questions: flatQuestions,
    currentQuestionId: reviewLocation.currentId,
    beforeJump: resultMounts.beforeJump,
  });
  return (
    <ResultWorkspace
      learningLease={publisher.lease}
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
      primaryAction={
        <AttemptReviewTopBarEntry
          attemptId={attempt.id}
          released={released}
          onOpen={attemptReview.open}
        />
      }
      actions={
        <ResultAiActions
          attemptId={attempt.id}
          questions={flatQuestions}
          released={released}
          companion={aiCompanion}
          onOpenAttemptReview={attemptReview.open}
        />
      }
      rootRef={rootRef}
      reviewLocation={reviewLocation}
    >
      {aiCompanion.rail(
        <div className="flex flex-col gap-5">
          <QuestionProcessControls process={questionProcess} />
          {/* 得分汇总卡（未公布时替换为「已交卷」横幅 + 已答统计，不显示对错与得分） */}
          <ReviewTemplateFrame
            key={attempt.id}
            data={data}
            context={contextQuery.data}
            wrongPractice={wrongPractice}
            contextError={
              contextQuery.isError
                ? contextQuery.error instanceof Error
                  ? contextQuery.error.message
                  : "请稍后重试"
                : null
            }
            onRetryContext={() => void contextQuery.refetch()}
            slots={{
              summary: (
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
                    {/* 来源行（T2A.6，与答题视图同口径）：课程练习带次数；作业「作业 · 课程名」；
              错题重练「错题重练 · 第 n 次」；讲练「讲练：讲义标题 · 第 n 次」 */}
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {attemptSourceLabel(data)}
                    </p>
                    {attempt.submittedAt !== null && (
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        交卷时间：{formatCnTime(attempt.submittedAt)}
                      </p>
                    )}
                    <ResultTimeLimitLine attempt={attempt} />
                    {data.time ? (
                      <p className="text-sm text-muted-foreground">
                        {attemptTimeLabel(data.time)}
                      </p>
                    ) : (
                      <ResultActivityLine activity={data.activity} />
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
                          {summary.scoreFinal !== null
                            ? "最终得分"
                            : "自动判分得分"}
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
                            {/* QM-12 有效判定口径的未判断数（含待批与待自评），与徽章
                      同出处；D9 pendingCount 另在「有 X 题待批」提示位消费 */}
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
                    <PendingAttemptRelease data={data} onRefresh={onRefresh} />
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
                          onClick={() =>
                            wrongPractice.onStart(wrongQuestionIds)
                          }
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
                            className={cn(
                              "size-4",
                              redo.loading && "animate-spin",
                            )}
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
                          <TriangleAlert
                            aria-hidden
                            className="size-4 shrink-0"
                          />
                          练习本卷错题组卷失败：{wrongPractice.error}
                          ；题目状态可能有变化，请稍后重试或刷新本页。
                        </p>
                      )}
                    {showRedo && redo.error !== null && (
                      <p
                        role="alert"
                        className="flex items-center gap-1.5 text-sm text-destructive"
                      >
                        <TriangleAlert
                          aria-hidden
                          className="size-4 shrink-0"
                        />
                        再做一次失败：{redo.error}
                        ；请稍后重试或刷新本页。
                      </p>
                    )}
                    {/* 再做一次确认（hall-15313）：显式动作——新卷从空白开始，本卷
              保留可回看（文案与讲练「再做一次」先例同口径） */}
                    {showRedo && redoOpen && (
                      <AssignmentRedoDialog
                        nextAttemptNo={attempt.attemptNo + 1}
                        onClose={() => setRedoOpen(false)}
                        onStart={redo.onStart}
                      />
                    )}
                  </div>
                </section>
              ),
              agent_report: (template) => (
                <>
                  <AiAttemptReviewHint
                    attemptId={attempt.id}
                    released={released}
                    onOpen={attemptReview.open}
                  />
                  <ReviewV2Panel
                    attemptId={attempt.id}
                    released={released}
                    units={data.units}
                    profile={template.agentReport?.profile ?? "objective"}
                  />
                </>
              ),
              questions: (template) => (
                <ResultQuestionList
                  showMaterials={
                    !template.sections.some(
                      (s) => s.kind === "material_reading" && s.visible,
                    )
                  }
                  key={attempt.id}
                  data={data}
                  context={contextQuery.data}
                  indexOfQuestion={indexOfQuestion}
                  controller={resultMounts.controller}
                  lazy={lazyResults}
                  renderQuestion={(question, index) => (
                    <>
                      <ResultQuestionCard
                        aiTrigger={aiCompanion.triggerForQuestion(
                          question.questionId,
                        )}
                        index={index}
                        question={question}
                        attemptId={attempt.id}
                        released={released}
                        roundLabel={roundLabel}
                        activity={
                          data.activity === undefined
                            ? null
                            : data.activity.byQuestion[question.questionId]
                        }
                        onSolutionToggle={onSolutionToggle}
                      />
                      {aiCompanion.inlineForQuestion(question.questionId)}
                    </>
                  )}
                />
              ),
            }}
          />

          <AttemptReviewHost
            showV2Entry={false}
            attemptId={attempt.id}
            released={released}
            attemptLabel={`${data.title} · 第 ${attempt.attemptNo} 次${attempt.submittedAt ? ` · ${formatCnTime(attempt.submittedAt)} 交卷` : ""}`}
            overlay={attemptReview}
            onJumpToQuestion={reviewLocation.jump}
          />

          {/* 模块 1：交卷后「可复盘」提示条（可用门在服务端；只提示，确认后才建任务）。
              与顶栏主按钮同一状态、同一打开目标；面板与报告由 AttemptReviewHost 按地址承载 */}

          {/* 模块 7：按模块（单元）看答对 / 作答 / 跳过 / 不确定但对 / 用时 / 配额 */}

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
        </div>,
      )}
    </ResultWorkspace>
  );
}
