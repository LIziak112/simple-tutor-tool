import type { TeacherAttemptDetailData } from "@tutor/contract";
import { ArrowLeft, Clock3 } from "lucide-react";
import { useLocation, useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { isAnswered } from "@/features/attempt/answer-format";
import {
  AttemptDetailQuestionCard,
  formatActiveSec,
} from "@/features/teacher-attempts/AttemptDetailQuestionCard";
import { AttemptStatusBadge } from "@/features/teacher-attempts/attempt-views";
import { ExportCsvButton } from "@/features/teacher-attempts/ExportCsvButton";
import { useTeacherAttemptDetail } from "@/features/teacher-attempts/teacher-attempt-queries";
import { ApiError } from "@/lib/api";
import { formatCnTime } from "@/lib/time";

/**
 * /t/data/attempts/:id 作答详情页（T3.1，D5/D7）：
 * - 来源头（「作业 · 课程名」或「课程：xx · 第 n 次」）+ 学生名 + 状态徽章 +
 *   时间信息；顶部得分汇总（对/错/待批计数、scoreAuto、scoreFinal、activeSec）；
 * - 逐题列表：连续题号 + 单元节标题、题型/难度/考点、题干快照（RichMarkdown）、
 *   学生答案、判定区（教师字段本阶段多为 null，正常显示空位）、学习行为统计、
 *   手写缩略图懒加载 + 点击放大（回放 T3.3 接入）；
 * - draft（D5）：判定区统一「未交卷」、无参考答案对比、不做自动刷新
 *   （刷新页面才更新）；
 * - T3.2b（D3）：已交卷逐题判定区下有「改判 / 评语」内联编辑（含自动判过的
 *   题），保存后本题判定区与顶部得分汇总经缓存失效重取即时刷新；
 * - 数据全部来自服务端（快照 + responses），前端不拼判分；三态齐全；
 *   返回保留数据页筛选（筛选在 URL query，navigate(-1) 原样回到列表）。
 */

/** 来源头描述（与卡片/学生端结果视图同口径） */
function sourceLineOf(data: TeacherAttemptDetailData): string {
  if (data.sourceType === "course") {
    return `课程：${data.courseName ?? ""} · 第 ${data.attemptNo} 次`;
  }
  if (data.sourceType === "wrong") {
    return `错题重练 · 第 ${data.attemptNo} 次`;
  }
  return data.courseName !== null
    ? `作业 · ${data.courseName}`
    : `作业 · ${data.assignmentTitle ?? ""}`;
}

/** 返回数据页：站内到达时回退一步（保留筛选 URL）；直接打开（刷新/书签）则去 /t/data */
function BackToDataButton() {
  const navigate = useNavigate();
  const location = useLocation();
  const canGoBack = location.key !== "default";
  return (
    <Button
      variant="outline"
      className="min-h-11"
      onClick={() => (canGoBack ? navigate(-1) : void navigate("/t/data"))}
    >
      <ArrowLeft aria-hidden />
      返回数据页
    </Button>
  );
}

/**
 * 本 attempt 的 CSV 导出参数（T3.4，D13 六参数约束下取「能唯一定位」的组合）：
 * - assignment 来源：studentId + assignmentId——一个作业一人恰一份作答
 *   （开卷幂等），两参数即唯一确定本 attempt；
 * - course 来源：接口无 attemptId 参数，取 studentId + courseId + sourceType
 *   = 该学生在该课程的**全部练习历次**（CSV「作业或单元」列含「第 n 次」，
 *   教师可按次定位本 attempt；这是 D13 参数集下最贴近的口径）；
 * - wrong 来源（2026-10）：无课程/作业可定位，取 studentId + sourceType=wrong
 *   = 该生的全部错题重练卷（同按「第 n 次」列定位）。
 */
function exportCsvParamsOfAttempt(data: TeacherAttemptDetailData): {
  studentId: string;
  assignmentId?: string | undefined;
  courseId?: string | undefined;
  sourceType?: "course" | "assignment" | "wrong" | undefined;
} {
  if (data.sourceType === "assignment") {
    return {
      studentId: data.studentId,
      assignmentId: data.assignmentId ?? undefined,
    };
  }
  if (data.sourceType === "wrong") {
    return {
      studentId: data.studentId,
      sourceType: "wrong",
    };
  }
  return {
    studentId: data.studentId,
    courseId: data.courseId ?? undefined,
    sourceType: "course",
  };
}

/** 得分汇总卡（draft 替换为「进行中」说明横幅，D5） */
function DetailSummary({
  data,
  answeredCount,
}: {
  data: TeacherAttemptDetailData;
  answeredCount: number;
}) {
  if (data.status === "draft") {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-sky-300/60 bg-sky-50 p-4 text-sm dark:border-sky-500/30 dark:bg-sky-500/10">
        <p className="flex items-center gap-2 font-medium text-sky-800 dark:text-sky-300">
          <Clock3 aria-hidden className="size-4 shrink-0" />
          进行中：学生尚未交卷
        </p>
        <p className="text-sky-800 dark:text-sky-300">
          以下展示当前已答内容与笔迹（已答 {answeredCount} / 共{" "}
          {data.questions.length} 题）；交卷前不产生判定，页面不自动更新，
          刷新后可看到最新草稿。
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
      <p className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
        <span>
          答对 <b className="text-emerald-600">{data.correctCount}</b> 题
        </span>
        <span>
          答错 <b className="text-red-600">{data.wrongCount}</b> 题
        </span>
        <span>
          待批 <b className="text-amber-600">{data.pendingCount}</b> 题
        </span>
      </p>
      <p className="flex items-baseline gap-1.5 text-sm text-muted-foreground">
        自动判分：
        <b className="text-lg font-semibold text-foreground">
          {data.scoreAuto === null ? "—" : data.scoreAuto}
        </b>
      </p>
      <p className="flex items-baseline gap-1.5 text-sm text-muted-foreground">
        最终得分：
        <b className="text-2xl font-bold text-primary">
          {data.scoreFinal === null ? "未批" : data.scoreFinal}
        </b>
      </p>
    </div>
  );
}

/** 详情主体（查询成功后的渲染） */
function DetailBody({ data }: { data: TeacherAttemptDetailData }) {
  const isDraft = data.status === "draft";
  const answeredCount = data.questions.filter(
    (question) => question.answer !== null && isAnswered(question.answer),
  ).length;

  // 单元节标题：题目按单元连续编排，遇 unitTitle 变化即起新节；单单元不显示节头
  // （与学生端结果视图一致）。
  const unitCount = new Set(data.questions.map((q) => q.unitId)).size;

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <BackToDataButton />

      {/* 头部：学生 + 状态 + 来源 + 时间 */}
      <header className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">{data.studentName}</h1>
            <AttemptStatusBadge status={data.status} />
          </div>
          {/* T3.4：导出本 attempt 的 CSV（参数口径见 exportCsvParamsOfAttempt） */}
          <ExportCsvButton params={exportCsvParamsOfAttempt(data)} />
        </div>
        <p className="text-sm text-muted-foreground">{sourceLineOf(data)}</p>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>共 {data.questions.length} 题</span>
          <span>开始：{formatCnTime(data.startedAt)}</span>
          {data.submittedAt !== null && (
            <span>交卷：{formatCnTime(data.submittedAt)}</span>
          )}
          <span>用时 {formatActiveSec(data.activeSec)}</span>
        </p>
        <DetailSummary data={data} answeredCount={answeredCount} />
      </header>

      {/* 逐题列表（连续题号 + 单元节标题） */}
      <ol className="flex flex-col gap-4" aria-label="逐题作答详情">
        {data.questions.map((question, index) => {
          const previous = data.questions[index - 1];
          const showUnitHeader =
            unitCount > 1 &&
            (previous === undefined || previous.unitId !== question.unitId);
          return (
            <li key={question.questionId} className="flex flex-col gap-3">
              {showUnitHeader && (
                <h2 className="border-b border-border pb-1.5 text-sm font-semibold text-muted-foreground">
                  {question.unitTitle}
                </h2>
              )}
              <AttemptDetailQuestionCard
                question={question}
                isDraft={isDraft}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function AttemptDetailPage() {
  const { id } = useParams();
  const detailQuery = useTeacherAttemptDetail(id);

  if (detailQuery.isPending) {
    return (
      <section
        aria-live="polite"
        className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6 md:py-8"
      >
        <p className="text-sm text-muted-foreground">正在加载作答详情…</p>
      </section>
    );
  }

  if (detailQuery.isError) {
    const err = detailQuery.error;
    const notFound =
      err instanceof ApiError && err.code === "ATTEMPT_NOT_FOUND";
    return (
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
        <BackToDataButton />
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
        >
          <p className="text-sm font-medium text-destructive">
            {notFound ? "作答不存在或不属于你" : "作答详情加载失败"}
          </p>
          <p className="text-sm text-muted-foreground">
            {notFound
              ? "这份作答可能已被删除，或属于其他老师的学生。"
              : err instanceof Error
                ? err.message
                : "网络异常，请稍后重试"}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => void detailQuery.refetch()}
            >
              重试
            </Button>
          </div>
        </div>
      </section>
    );
  }

  return <DetailBody data={detailQuery.data} />;
}

// 供 App.tsx 路由级懒加载
export default AttemptDetailPage;
