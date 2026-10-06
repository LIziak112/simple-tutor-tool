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
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { HintEntryList } from "@/features/attempt/HintPanel";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { NoteOriginalView } from "@/features/notes/NoteOriginalView";
import { studentInkPngUrl } from "@/lib/api";
import { formatCnTime } from "@/lib/time";
import {
  attemptRoundLabel,
  formatReferenceAnswers,
  formatStudentAnswer,
  letterOf,
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "./answer-format";

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
 * 判定图标：true=绿勾、false=红叉（D1 后含未作答客观题；D9 后最终判定
 * finalCorrect 优先——教师批注改判以批注为准）、null=待批（琥珀时钟）。
 */
function VerdictIcon({ verdict }: { verdict: boolean | null }) {
  if (verdict === true) {
    return (
      <CheckCircle2
        aria-label="答对"
        className="size-5 shrink-0 text-emerald-600"
      />
    );
  }
  if (verdict === false) {
    return (
      <XCircle aria-label="答错" className="size-5 shrink-0 text-red-600" />
    );
  }
  return (
    <Clock aria-label="待批改" className="size-5 shrink-0 text-amber-500" />
  );
}

/** 判定文字（与图标一致的辅助文本） */
function verdictLabel(verdict: boolean | null): string {
  if (verdict === true) return "答对";
  if (verdict === false) return "答错";
  return "待批改";
}

/**
 * 老师批改块（D9，显著展示）：有 teacherMark / teacherComment 任一时渲染。
 * teacherMark=null 且只有评语（清除判定保留评语）时标题显示「已评语」。
 */
function TeacherMarkBlock({
  teacherMark,
  teacherComment,
}: {
  teacherMark: "correct" | "wrong" | null;
  teacherComment: string | null;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-sky-200 bg-sky-50/70 p-3 dark:border-sky-500/30 dark:bg-sky-500/10">
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
        <p className="text-sm text-sky-900 dark:text-sky-200">
          {teacherComment}
        </p>
      )}
    </div>
  );
}

/** 选项行（含正确项与学生所选标记；仅 choice/multi） */
function ResultOptions({ question }: { question: AttemptResultQuestion }) {
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
        const isCorrect = correct.includes(index);
        return (
          <li
            key={option}
            className={cn(
              "flex min-h-11 items-start gap-2 rounded-lg border px-3 py-2 text-sm",
              isCorrect
                ? "border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10"
                : isPicked
                  ? "border-red-300 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10"
                  : "border-transparent",
            )}
          >
            <span className="mt-0.5 w-5 shrink-0 font-semibold">
              {letterOf(index)}
            </span>
            <RichMarkdown source={option} className="min-w-0 flex-1 text-sm" />
            {isCorrect && (
              <span className="shrink-0 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                正确项
              </span>
            )}
            {isPicked && !isCorrect && (
              <span className="shrink-0 text-xs font-medium text-red-700 dark:text-red-300">
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
}: {
  solutionMd: string | null;
  /** 开合回调（open=收起→展开、close=展开→收起）；缺省 no-op */
  onToggle?: ((action: "open" | "close") => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (solutionMd === null) {
    return <p className="text-sm text-muted-foreground">这道题没有详解。</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="outline"
        className="min-h-11 w-fit"
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
      {open && (
        <div className="rounded-lg border border-border bg-muted/40 p-4">
          <RichMarkdown source={solutionMd} className="text-sm" />
        </div>
      )}
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
  if (!available) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <PenLine aria-hidden className="size-4" />
        我的手写笔迹
      </p>
      <img
        src={studentInkPngUrl(attemptId, questionId)}
        alt={`第 ${questionId} 题的手写笔迹`}
        loading="lazy"
        className="w-full rounded-lg border border-border bg-white"
        onError={() => setAvailable(false)}
      />
    </div>
  );
}

/** 单题结果卡；released=false（T2A.8 截止后公布且未到截止）时只渲染本人作答内容 */
function ResultQuestionCard({
  index,
  question,
  attemptId,
  released,
  roundLabel,
  onSolutionToggle,
}: {
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
  const isHandwritten =
    question.snapshot.type === "solve" ||
    question.snapshot.type === "apply" ||
    question.snapshot.type === "find-error";
  // D9：最终判定优先（交卷时 = autoCorrect，批注后以 teacherMark 为准）；
  // null = 待批（D3 后可自动判分题交卷即有 finalCorrect，null 即真待批）
  const verdict = question.finalCorrect ?? question.autoCorrect;
  return (
    <article
      className={cn(
        "relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-card p-4 pl-5 text-card-foreground shadow-xs sm:p-5 sm:pl-6",
        "before:absolute before:inset-y-0 before:left-0 before:w-1.5",
        !released
          ? "before:bg-muted"
          : verdict === true
            ? "before:bg-emerald-500"
            : verdict === false
              ? "before:bg-red-500"
              : "before:bg-amber-400",
      )}
      aria-label={`第 ${index + 1} 题`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* T2A.8：未公布时不显示对错判定（finalCorrect/autoCorrect 已置 null） */}
        {released && (
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            <VerdictIcon verdict={verdict} />
            {verdictLabel(verdict)}
          </span>
        )}
        <p className="text-sm font-semibold">第 {index + 1} 题</p>
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
      </div>

      {/* 老师批改块（D9）：有判定或评语时显著展示（未公布时服务端置 null 不渲染） */}
      {released &&
        (question.teacherMark !== null || question.teacherComment !== null) && (
          <TeacherMarkBlock
            teacherMark={question.teacherMark}
            teacherComment={question.teacherComment}
          />
        )}

      {/* 题干快照（服务端已 studentStemMd 投影；displayStemMd 兜底剥内嵌选项列表） */}
      <RichMarkdown
        source={displayStemMd(question.snapshot)}
        className="text-base"
      />
      <ResultOptions question={question} />

      {/* T6R.11：本次草稿原稿查看入口（非手写题——手写题没有草稿层，笔迹
          缩略图另见下方）。学生看自己的草稿不受答案公布 gate 限制，两种
          形态都渲染；面板按证据行定位本次原稿（软删题历史可读） */}
      {!isHandwritten && (
        <NoteOriginalView
          role="student"
          attemptId={attemptId}
          questionId={question.questionId}
          ariaPrefix={`第 ${index + 1} 题`}
          roundLabel={roundLabel}
        />
      )}

      {/* 手写题：我的手写笔迹缩略图（T2.8；无笔迹时隐藏） */}
      {isHandwritten && (
        <InkThumbnail attemptId={attemptId} questionId={question.questionId} />
      )}

      {/* 做题时看过的提示（T2.11 回看；没解锁过则整块隐藏。
          未公布时照常回看——只含学生自己请求过的条目，不构成泄露） */}
      {question.hintsOpened.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Lightbulb aria-hidden className="size-4" />
            做题时看过的提示（{question.hintsOpened.length} 条）
          </p>
          <HintEntryList entries={question.hintsOpened} />
        </div>
      )}

      <div className="flex flex-col gap-1.5 rounded-lg bg-muted/40 px-4 py-3 text-sm sm:flex-row sm:gap-6">
        <p className="flex flex-wrap gap-1.5">
          <span className="shrink-0 text-muted-foreground">你的答案：</span>
          <span
            className={cn(
              "font-medium",
              question.answer === null && "text-muted-foreground",
            )}
          >
            {formatStudentAnswer(question.answer)}
          </span>
        </p>
        {/* 参考答案走 RichMarkdown：[[…]] 标记内禁写 $（防 remark-math 切开
            标记泄露答案），裸 LaTeX 由 formatReferenceAnswers 显示侧自动包 $；
            T2.13 旧写法 $…$ 原样走同一管线，判分归一化剥 $ 不受影响。
            外层 p→div：RichMarkdown 是块级 div，不能嵌在 <p> 内。
            T2A.8：未公布时整块不下发（服务端 answers=null） */}
        {released && (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            <span className="shrink-0 text-muted-foreground">参考答案：</span>
            {question.answers === null ? (
              <span className="font-medium">由老师批改后公布</span>
            ) : (
              <RichMarkdown
                source={formatReferenceAnswers(question.answers)}
                className="min-w-0 font-medium [&_p]:my-0"
              />
            )}
          </div>
        )}
      </div>

      {/* T2A.8：详解只在公布后渲染（未公布时服务端 solutionMd=null） */}
      {released && (
        <SolutionFold
          solutionMd={question.solutionMd}
          onToggle={
            onSolutionToggle === undefined
              ? undefined
              : (action) => onSolutionToggle(question.questionId, index, action)
          }
        />
      )}
    </article>
  );
}

/** 结果视图本体 */
export function AttemptResultView({
  data,
  onBackHome,
  onSolutionToggle,
  wrongPractice,
}: {
  data: AttemptResultData;
  onBackHome: () => void;
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
}) {
  const { attempt, summary } = data;
  // T2A.8：答案是否已公布（on_submit / 课程练习 / 已到截止 = true）
  const released = data.answersReleased;
  // T6R.11：原稿查看面板的轮次标注（重练同题后回看历史，可分辨第几轮）
  const roundLabel = attemptRoundLabel(
    attempt.sourceType,
    attempt.attemptNo,
  );
  // D9：大数字得分 = 最终得分优先，未批完回退自动判分（均 null = 全待批）
  const displayScore = summary.scoreFinal ?? attempt.scoreAuto;
  // T2A.7：逐题结果按单元分组；题号全卷连续（累计 index）。
  // 多单元时渲染节标题（单元标题），单单元不显示节头（与答题视图一致）。
  const flatQuestions = data.units.flatMap((unit) => unit.questions);
  const showUnitHeaders = data.units.length > 1;
  // 2026-10：本卷判错题（finalCorrect === false，按本卷题序）——直达重练的
  // 圈题范围与示数。未公布时服务端已把 finalCorrect 置 null（数出来必为 0），
  // 与 released 显隐判据双保险。
  const wrongQuestionIds = flatQuestions
    .filter((question) => question.finalCorrect === false)
    .map((question) => question.questionId);
  const showWrongPractice =
    released && wrongPractice !== undefined && wrongQuestionIds.length > 0;
  return (
    <div className="flex flex-col gap-5">
      {/* 得分汇总卡（未公布时替换为「已交卷」横幅 + 已答统计，不显示对错与得分） */}
      <section
        aria-labelledby="result-summary"
        className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 shadow-xs"
      >
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 id="result-summary" className="text-base font-semibold">
            {data.title} · {released ? "批改结果" : "已交卷"}
          </h2>
          {/* 来源行（T2A.6，与答题视图同口径）：课程练习带次数（历次回看可分辨
              第几次）；作业标「作业」（挂课程时「作业 · 课程名」，T2A.7）；
              错题重练「错题重练 · 第 n 次」（2026-10） */}
          <p className="text-xs text-muted-foreground">
            {attempt.sourceType === "course"
              ? `课程：${data.courseName ?? ""} · 第 ${attempt.attemptNo} 次`
              : attempt.sourceType === "wrong"
                ? `错题重练 · 第 ${attempt.attemptNo} 次`
                : data.courseName !== null
                  ? `作业 · ${data.courseName}`
                  : "作业"}
          </p>
          {attempt.submittedAt !== null && (
            <p className="text-xs text-muted-foreground">
              交卷时间：{formatCnTime(attempt.submittedAt)}
            </p>
          )}
        </div>
        {released ? (
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <p className="flex items-baseline gap-2">
              <span className="text-4xl font-bold text-primary">
                {/* D9：全部批完显示最终得分，否则回退自动判分（无可判分为「待批」） */}
                {displayScore === null ? "待批" : displayScore}
              </span>
              <span className="text-sm text-muted-foreground">
                {summary.scoreFinal !== null
                  ? "最终得分（含老师批改，满分 100）"
                  : attempt.scoreAuto === null
                    ? "暂无可自动判分的题目"
                    : "自动判分得分（满分 100）"}
              </span>
            </p>
            <p className="flex flex-wrap gap-2 text-sm text-muted-foreground [&>span]:rounded-lg [&>span]:bg-muted/60 [&>span]:px-3 [&>span]:py-1.5">
              <span>
                共 <b className="text-foreground">{summary.total}</b> 题
              </span>
              <span>
                答对 <b className="text-emerald-600">{summary.correct}</b> 题
              </span>
              <span>
                答错 <b className="text-red-600">{summary.wrong}</b> 题
              </span>
              <span>
                待批{" "}
                <b className="text-amber-600">
                  {/* D9：pendingCount 为 D4 权威计数（批注后 autoCorrect 仍空而
                      finalCorrect 已定；公布态下恒非 null，回退仅兜底） */}
                  {summary.pendingCount ?? summary.pending}
                </b>{" "}
                题
              </span>
              {/* D1（T3.2a）：未作答客观题已判错计入「答错」；「未答」独立展示
                  （此前挂在待批下的「含未答」不再准确——未答的待批题只剩手写/
                  无标准答案，其余未答客观题在答错里） */}
              {summary.unanswered > 0 && (
                <span>
                  未答 <b className="text-foreground">{summary.unanswered}</b>{" "}
                  题
                </span>
              )}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-2xl border border-amber-300/60 bg-amber-50 p-4 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
            <p className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-300">
              <Clock aria-hidden className="size-4 shrink-0" />
              已交卷，答案将在截止后公布
              {data.dueAt !== null &&
                `（截止时间：${formatCnTime(data.dueAt)}）`}
            </p>
            <p className="text-amber-800 dark:text-amber-300">
              截止前只显示你的作答内容；截止后将自动公布对错、参考答案与详解
              （已作答 {summary.answered} 题 / 共 {summary.total} 题）。
            </p>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" className="min-h-11" onClick={onBackHome}>
              返回首页
            </Button>
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

      {/* 逐题结果（T2A.7：多单元按节分组，题号全卷连续） */}
      <ol className="flex flex-col gap-4">
        {data.units.map((unit) => (
          <li key={unit.id} className="flex flex-col gap-4">
            {showUnitHeaders && (
              <h3 className="flex items-center gap-2 pt-2 text-sm font-semibold text-foreground before:h-4 before:w-1 before:rounded-full before:bg-primary">
                {unit.title}
              </h3>
            )}
            <ol className="flex flex-col gap-4">
              {unit.questions.map((question) => (
                <li key={question.questionId}>
                  <ResultQuestionCard
                    index={flatQuestions.indexOf(question)}
                    question={question}
                    attemptId={attempt.id}
                    released={released}
                    roundLabel={roundLabel}
                    onSolutionToggle={onSolutionToggle}
                  />
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </div>
  );
}
