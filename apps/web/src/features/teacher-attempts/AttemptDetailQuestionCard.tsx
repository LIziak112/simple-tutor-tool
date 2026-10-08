import type { TeacherAttemptDetailQuestion } from "@tutor/contract";
import { displayStemMd } from "@tutor/md-dsl";
import { cn } from "cn";
import { ChevronDown, Clock3, Lightbulb, PenLine } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  formatReferenceAnswers,
  formatStudentAnswer,
  HANDWRITTEN_TYPES,
  letterOf,
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "@/features/attempt/answer-format";
import { ReviewPackPanel } from "@/features/export/review-pack-panel";
import { AnnotationView } from "@/features/annotation/AnnotationView";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { NoteOriginalView } from "@/features/notes/NoteOriginalView";
import { AttemptQuestionMarkEditor } from "./AttemptQuestionMarkEditor";
import { InkLightbox, type InkViewTab, InkViewTabs } from "./InkLightbox";
import { InkReplayPane } from "./InkReplayPane";

/**
 * 作答详情的单题卡片（T3.1，D7）：连续题号 + 题型/难度/考点、题干（RichMarkdown）、
 * 选项（标记学生所选与正确项）、学生答案（人类可读）、参考答案与详解
 * （**仅已交卷**——draft 详情服务端整卷不下发，前端自然不渲染，D5）、判定区
 * （自动/最终/教师判定 + 评语；draft 显示「未交卷」）、activeSec/hintsUsed/
 * changeCount、手写缩略图（懒加载 + 点击放大）。
 * T3.2b（D3）：已交卷且带 responseId 的题在判定区下渲染「改判 / 评语」内联编辑
 * （对自动判过的题亦可改判）。
 */

/** 有效用时（秒）→ 展示文本（"2 分 30 秒"；null → "—"） */
export function formatActiveSec(sec: number | null): string {
  if (sec === null) return "—";
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  if (minutes === 0) return `${seconds} 秒`;
  return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
}

/** 判定单元格文本与配色（true 绿 / false 红 / null 灰「—」） */
function verdictOf(value: boolean | null): { text: string; className: string } {
  if (value === true) return { text: "答对", className: "text-emerald-600" };
  if (value === false) return { text: "答错", className: "text-red-600" };
  return { text: "—", className: "text-muted-foreground" };
}

/** 选项列表（choice/multi）：标记正确项（仅已交卷下发 answers）与学生所选 */
function DetailOptions({
  question,
}: {
  question: TeacherAttemptDetailQuestion;
}) {
  const options = question.options;
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
              isPicked
                ? "border-sky-300 bg-sky-50 dark:border-sky-500/40 dark:bg-sky-500/10"
                : "border-border",
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
            {isPicked && (
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

/**
 * 手写笔迹区（懒加载快照 + 点击放大；T3.3 起提供「快照 / 回放」切换）：
 * 回放态三态交给 InkReplayPane（加载 / 重演 / PNG 降级）；放大层从当前视图打开。
 * hasStrokes=false 时提示无笔画（实测跟进：回放态同时不发矢量请求，见 InkReplayPane）。
 */
function InkThumbnail({
  question,
}: {
  question: TeacherAttemptDetailQuestion;
}) {
  const ink = question.ink;
  const [zoomed, setZoomed] = useState(false);
  const [available, setAvailable] = useState(true);
  const [tab, setTab] = useState<InkViewTab>("snapshot");
  if (ink === null || !available) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        <PenLine aria-hidden className="size-4 shrink-0" />
        手写笔迹
        {!ink.hasStrokes && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
            有笔迹记录但无笔画
          </span>
        )}
        <span className="ml-auto">
          <InkViewTabs value={tab} onChange={setTab} />
        </span>
      </div>
      {tab === "snapshot" ? (
        <button
          type="button"
          className="min-h-11 w-full rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-label={`放大查看第 ${question.no} 题的手写笔迹`}
          onClick={() => setZoomed(true)}
        >
          <img
            src={ink.pngUrl}
            alt={`第 ${question.no} 题的手写笔迹`}
            loading="lazy"
            className="w-full rounded-lg border border-border bg-white"
            onError={() => setAvailable(false)}
          />
        </button>
      ) : (
        <InkReplayPane
          inkId={ink.inkId}
          pngUrl={ink.pngUrl}
          alt={`第 ${question.no} 题的手写笔迹`}
          hasStrokes={ink.hasStrokes}
        />
      )}
      {zoomed && (
        <InkLightbox
          pngUrl={ink.pngUrl}
          alt={`第 ${question.no} 题的手写笔迹`}
          inkId={ink.inkId}
          hasStrokes={ink.hasStrokes}
          initialTab={tab}
          onClose={() => setZoomed(false)}
        />
      )}
    </div>
  );
}

/** 详解折叠（默认收起；仅已交卷渲染） */
function SolutionFold({ solutionMd }: { solutionMd: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="outline"
        className="min-h-11 w-fit"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
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

/** 判定区：draft 一律「未交卷」（D5）；已交卷展示四行判定/评语 */
function VerdictSection({
  question,
  isDraft,
}: {
  question: TeacherAttemptDetailQuestion;
  isDraft: boolean;
}) {
  if (isDraft) {
    return (
      <p className="inline-flex w-fit items-center gap-1.5 rounded-lg bg-sky-500/10 px-3 py-2 text-sm text-sky-700 dark:text-sky-300">
        <Clock3 aria-hidden className="size-4" />
        未交卷——学生交卷前不产生判定
      </p>
    );
  }
  const auto = verdictOf(question.autoCorrect);
  const final = verdictOf(question.finalCorrect);
  const teacher =
    question.teacherMark === null ? null : question.teacherMark === "correct";
  const byTeacher = verdictOf(teacher);
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-lg bg-muted/40 px-4 py-3 text-sm sm:grid-cols-2">
      <div className="flex gap-2">
        <dt className="shrink-0 text-muted-foreground">自动判定：</dt>
        <dd className={cn("font-medium", auto.className)}>{auto.text}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="shrink-0 text-muted-foreground">最终判定：</dt>
        <dd className={cn("font-medium", final.className)}>
          {question.finalCorrect === null ? "待批" : final.text}
        </dd>
      </div>
      <div className="flex gap-2">
        <dt className="shrink-0 text-muted-foreground">教师判定：</dt>
        <dd className={cn("font-medium", byTeacher.className)}>
          {question.teacherMark === null
            ? "未批改"
            : question.teacherMark === "correct"
              ? "判对"
              : "判错"}
        </dd>
      </div>
      <div className="flex min-w-0 gap-2">
        <dt className="shrink-0 text-muted-foreground">教师评语：</dt>
        <dd className="min-w-0">
          {question.teacherComment === null || question.teacherComment === ""
            ? "—"
            : question.teacherComment}
        </dd>
      </div>
    </dl>
  );
}

/** 单题卡片本体 */
export function AttemptDetailQuestionCard({
  question,
  isDraft,
  attemptId,
  roundLabel,
}: {
  question: TeacherAttemptDetailQuestion;
  /** draft（进行中）：判定区统一「未交卷」，不渲染参考答案与详解（D5） */
  isDraft: boolean;
  /** 所属 attempt（T6R.11 原稿查看按 (attemptId, questionId) 定位证据行） */
  attemptId: string;
  /** 轮次标注（T6R.11 原稿查看面板显示所属轮次） */
  roundLabel: string;
}) {
  return (
    <article
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 text-card-foreground sm:p-5"
      aria-label={`第 ${question.no} 题`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="text-sm font-semibold">第 {question.no} 题</p>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${QUESTION_TYPE_BADGE_CLASS[question.type]}`}
        >
          {QUESTION_TYPE_LABELS[question.type]}
        </span>
        <span
          role="img"
          className="text-xs text-amber-500"
          aria-label={`难度 ${question.difficulty} 星`}
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

      {/* 题干：已交卷=快照原文、draft=投影形态（[[答案]] 渲染为空框）；
          选择题选项另由 DetailOptions 渲染——displayStemMd 剥掉题干内嵌的
          选项任务列表，避免选项显示两遍（[x] 还会渲染成打勾框） */}
      <RichMarkdown source={displayStemMd(question)} className="text-base" />
      <DetailOptions question={question} />

      {/* 手写笔迹（懒加载 + 点击放大） */}
      <InkThumbnail question={question} />

      {/* 草稿原稿查看入口（T6R.11）：已交卷的非手写题——draft 交卷前证据行
          定义性不存在（原稿=交卷事务固定的 SubmissionEvidence），不是文案
          问题而是入口语义不成立；手写题没有草稿层（笔迹区另见上方）。
          教师域链授权在服务端 evidence 读端点把门 */}
      {!isDraft && !HANDWRITTEN_TYPES.has(question.type) && (
        <NoteOriginalView
          viewer="teacher"
          attemptId={attemptId}
          questionId={question.questionId}
          ariaPrefix={`第 ${question.no} 题`}
          roundLabel={roundLabel}
        />
      )}

      {/* T6R.20：学生题干标注回看（教师域；draft 期标注未封存也可看本人
          作答过程——教师查看学生证据的路由模式） */}
      <AnnotationView
        viewer="teacher"
        attemptId={attemptId}
        questionId={question.questionId}
        questionNo={question.no}
        ariaPrefix={`第 ${question.no} 题`}
      />

      {/* 学生答案 + 参考答案（draft 无参考答案对比，D5） */}
      <div className="flex flex-col gap-1.5 rounded-lg bg-muted/40 px-4 py-3 text-sm sm:flex-row sm:gap-6">
        <p className="flex flex-wrap gap-1.5">
          <span className="shrink-0 text-muted-foreground">学生答案：</span>
          <span
            className={cn(
              "font-medium",
              question.answer === null && "text-muted-foreground",
            )}
          >
            {formatStudentAnswer(question.answer)}
          </span>
        </p>
        {!isDraft && (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            <span className="shrink-0 text-muted-foreground">参考答案：</span>
            {question.answers === null || question.answers === undefined ? (
              <span className="font-medium">无标准答案（由老师批改）</span>
            ) : (
              <RichMarkdown
                source={formatReferenceAnswers(question.answers)}
                className="min-w-0 font-medium [&_p]:my-0"
              />
            )}
          </div>
        )}
      </div>

      {/* 学习行为统计（activeSec/hintsUsed/changeCount） */}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>用时 {formatActiveSec(question.activeSec)}</span>
        <span className="flex items-center gap-1">
          <Lightbulb aria-hidden className="size-3.5" />
          提示 {question.hintsUsed} 次
        </span>
        <span>改答 {question.changeCount} 次</span>
      </p>

      <VerdictSection question={question} isDraft={isDraft} />

      {/* 改判 / 评语（T3.2b，D3）：仅已交卷且带批注定位 id 的题渲染 */}
      {!isDraft && question.responseId !== null && (
        <AttemptQuestionMarkEditor question={question} />
      )}

      {/* 详解（仅已交卷下发；draft 缺省不渲染） */}
      {question.solutionMd !== undefined &&
        question.solutionMd !== null &&
        !isDraft && <SolutionFold solutionMd={question.solutionMd} />}

      {/* T6R.13：单题完整导出入口（教师域文档——携带参考答案/判定/评语与
          真实 id；draft 也可导出当前作答，证据按 not_collected 呈现） */}
      <ReviewPackPanel
        viewer="teacher"
        attemptId={attemptId}
        questionId={question.questionId}
        questionNo={question.no}
      />
    </article>
  );
}
