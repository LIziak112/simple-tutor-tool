import {
  LEARNING_PACK_CUSTOM_PROMPT_MAX,
  LEARNING_PACK_DAYS_DEFAULT,
  LEARNING_PACK_GOAL_LABELS,
  LEARNING_PACK_MAX_LECTURES,
  type LearningPackExportRequest,
  type LearningPackGoal,
  type LearningPackModules,
  type LearningPackPreviewData,
} from "@tutor/contract";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileArchive,
  Loader2,
  Search,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTeacherAssignments } from "@/features/assignments/assignment-queries";
import { DiscardConfirmDialog } from "@/features/assignments/DiscardConfirmDialog";
import { useTeacherCourses } from "@/features/courses/course-queries";
import { useLibraryLectures } from "@/features/library/library-queries";
import type { OutlineItem } from "@/features/markdown/outline";
import { useStudents } from "@/features/students/student-queries";
import { downloadLearningPackApi } from "@/lib/api";
import { useLearningPackPreview, useLectureOutline } from "./export-queries";

/**
 * 「导出给 AI」五步向导（T4.4，D14–D18；契约 learning-pack.ts 是请求的
 * 单一事实来源）：
 * - ① 范围：学生多选（勾选顺序 = 化名编号顺序，D16）+ 课程 / 作业叠加筛选
 *   （可选，交叉）+ 时间范围（7/30/90/全部，默认 30 与学情页 D5 一致）；
 * - ② 内容模块：分组卡片——讲义（资源库候选集，逐篇展开 H2/H3 目录勾选
 *   小节，空勾选 = 仅大纲）、题目三层（不含 / 仅题干 / +参考答案 / +解析，
 *   单选升级式）、逐题作答、作答汇总、手写 PNG（默认关）、学习痕迹；
 *   历次口径为固定说明（D15，非开关）；
 * - ③ 任务目标：四模板卡片（文案与 docs/dsl/学情分析提示词.md 同源）+
 *   自定义附加段（customPrompt，追加在 prompt.md「教师附加要求」）；
 * - ④ 隐私：化名默认开；「包含真实姓名」开关需二次确认（确认即
 *   privacy.anonymize=false，D16）；
 * - ⑤ 预览：preview 接口文件清单 + 预估大小；overLimit → 禁用下载并给
 *   精简方向（减学生 / 减 ink / 缩时间，D18）；「生成并下载」POST zip 流
 *   经 fetch blob 触发浏览器下载（文件名取 Content-Disposition）。
 * 步骤可回退且保留状态；改前步后再进⑤自动重新预览；未完成离开需确认
 * （页内退出二次确认 + beforeunload 兜底；react-router 声明式路由下侧边栏
 * 直达导航无法拦截，见任务报告——刷新/关闭已由 beforeunload 覆盖）。
 * 下载成功后视为完成，退出不再确认。三态齐全，触控目标 ≥44px。
 */

const STEP_LABELS = ["① 范围", "② 内容", "③ 目标", "④ 隐私", "⑤ 预览"] as const;

/** 时间范围快捷项（与学情页 AnalyticsFilterBar 同组，默认 30 天） */
const DAYS_OPTIONS = [
  { value: 7, label: "最近 7 天" },
  { value: 30, label: "最近 30 天" },
  { value: 90, label: "最近 90 天" },
  { value: "all", label: "全部" },
] as const;

type DaysValue = (typeof DAYS_OPTIONS)[number]["value"];

/** 四模板卡片（标题用契约 LEARNING_PACK_GOAL_LABELS 单一来源；描述与
 * docs/dsl/学情分析提示词.md 的模板要点一致） */
const GOAL_OPTIONS: ReadonlyArray<{
  value: LearningPackGoal;
  description: string;
}> = [
  {
    value: "diagnose-weakness",
    description:
      "按考点归纳错误模式，区分「不会」与「失误」，输出按薄弱程度排序的诊断报告与改进点",
  },
  {
    value: "lesson-prep",
    description:
      "针对错误最集中的知识点给出下节课讲解路线（分环节含时长）与课堂检查问题",
  },
  {
    value: "variant-practice",
    description:
      "基于错题生成变式练习，输出内容 DSL v2 文档，可直接回到「导入」流程使用",
  },
  {
    value: "period-summary",
    description:
      "面向家长的阶段性学习总结（教师审阅后转发），用数据说话并给家庭配合建议",
  },
];

/** 题目三层选项（不含 / 递进三层；文案对齐 prompt 模板的数据说明） */
const QUESTION_LEVEL_OPTIONS = [
  { value: "none", label: "不包含题目" },
  { value: "stem", label: "仅题干（题干中的答案标记会隐去）" },
  { value: "answer", label: "题干 + 参考答案" },
  { value: "solution", label: "题干 + 参考答案 + 解析" },
] as const;

/** 字节数人性化（预览清单 / 合计 / 上限共用） */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function ExportWizard({
  initialStudentId,
}: {
  /** 画像页入口带入的学生 id（第①步预勾选该生，D14 入口口径） */
  initialStudentId: string | null;
}) {
  const navigate = useNavigate();
  const studentsQuery = useStudents(true);
  const coursesQuery = useTeacherCourses(false);
  const assignmentsQuery = useTeacherAssignments(undefined, true);
  const lecturesQuery = useLibraryLectures({});
  const previewMutation = useLearningPackPreview();

  // ---------- 向导状态（各步独立 useState；回退不重置） ----------
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const initialStudentIds = useMemo(
    () => (initialStudentId !== null ? [initialStudentId] : []),
    [initialStudentId],
  );
  /** 学生勾选顺序数组（顺序即化名编号顺序，D16） */
  const [studentIds, setStudentIds] = useState<string[]>(initialStudentIds);
  const [courseId, setCourseId] = useState("");
  const [assignmentId, setAssignmentId] = useState("");
  const [days, setDays] = useState<DaysValue>(LEARNING_PACK_DAYS_DEFAULT);
  /** 讲义勾选：lectureId → 勾选全文的小节 headingIndex 集合（空 = 仅大纲） */
  const [lecturePicks, setLecturePicks] = useState<
    ReadonlyMap<string, Set<number>>
  >(new Map());
  const [questionLevel, setQuestionLevel] = useState<
    "stem" | "answer" | "solution" | null
  >(null);
  const [responses, setResponses] = useState(false);
  const [summaries, setSummaries] = useState(false);
  const [ink, setInk] = useState(false);
  const [traces, setTraces] = useState(false);
  const [goal, setGoal] = useState<LearningPackGoal>("diagnose-weakness");
  const [customPrompt, setCustomPrompt] = useState("");
  /** 化名开关（D16 默认开；关闭 =「包含真实姓名」，需二次确认） */
  const [anonymize, setAnonymize] = useState(true);

  // ---------- 下载态（⑤；防重复点击） ----------
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadedFile, setDownloadedFile] = useState<string | null>(null);

  // ---------- 离开守卫 ----------
  const [confirmExit, setConfirmExit] = useState(false);
  /** 下载成功后向导视为完成：退出不再确认 */
  const completed = downloadedFile !== null;

  const dirty =
    !arraysEqual(studentIds, initialStudentIds) ||
    courseId !== "" ||
    assignmentId !== "" ||
    days !== LEARNING_PACK_DAYS_DEFAULT ||
    lecturePicks.size > 0 ||
    questionLevel !== null ||
    responses ||
    summaries ||
    ink ||
    traces ||
    goal !== "diagnose-weakness" ||
    customPrompt.trim().length > 0 ||
    !anonymize;

  // 刷新 / 关闭标签页 / 外部跳转：dirty 且未完成时浏览器原生确认
  useEffect(() => {
    if (!dirty || completed) return;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Chrome 需要 returnValue 非空才弹确认
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, completed]);

  /** 页内退出（返回学情总览）：dirty 先确认（§4-5 不丢工作） */
  function requestExit(): void {
    if (downloading) return;
    if (dirty && !completed) {
      setConfirmExit(true);
      return;
    }
    navigate("/t/insights");
  }

  // ---------- 请求组装（与契约 learning-pack.ts 一一对应） ----------
  function buildRequest(): LearningPackExportRequest {
    const modules: LearningPackModules = {
      lectures: [...lecturePicks.entries()].map(([lectureId, sections]) => ({
        lectureId,
        sectionIndexes: [...sections].sort((a, b) => a - b),
      })),
      ...(questionLevel !== null ? { questions: questionLevel } : {}),
      responses,
      summaries,
      ink,
      traces,
      // v2 专属模块（T6R.12）：向导暂为 v1 入口（v2 批量 UI 属 T6R.16）
      evidence: false,
    };
    return {
      scope: {
        ...(studentIds.length > 0 ? { studentIds } : {}),
        ...(courseId !== "" ? { courseId } : {}),
        ...(assignmentId !== "" ? { assignmentId } : {}),
        days,
      },
      modules,
      goal,
      privacy: { anonymize },
      ...(customPrompt.trim().length > 0
        ? { customPrompt: customPrompt.trim() }
        : {}),
    };
  }

  /** 至少一个内容模块（与契约 superRefine 同式：ink 只是附件开关不算） */
  const hasContentModule =
    lecturePicks.size > 0 ||
    questionLevel !== null ||
    responses ||
    summaries ||
    traces;

  const nextDisabled =
    step === 1
      ? studentIds.length === 0
      : step === 2
        ? !hasContentModule
        : false;

  /** 进入第⑤步：重新发起预览（改前步后再进自动刷新，D14⑤） */
  function goToPreview(): void {
    previewMutation.reset();
    previewMutation.mutate(buildRequest());
    setStep(5);
  }

  function handleNext(): void {
    if (step === 4) {
      goToPreview();
      return;
    }
    setStep((step + 1) as 2 | 3 | 4);
  }

  async function handleDownload(): Promise<void> {
    if (downloading || previewMutation.data?.overLimit === true) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const filename = await downloadLearningPackApi(buildRequest());
      setDownloadedFile(filename);
    } catch (err) {
      setDownloadError(
        err instanceof Error ? err.message : "下载失败，请稍后重试",
      );
    } finally {
      setDownloading(false);
    }
  }

  // ---------- 学生勾选 ----------
  function toggleStudent(id: string, checked: boolean): void {
    setStudentIds((prev) =>
      checked ? [...prev, id] : prev.filter((v) => v !== id),
    );
  }

  // ---------- 讲义勾选 ----------
  function toggleLecture(lectureId: string, picked: boolean): void {
    setLecturePicks((prev) => {
      const next = new Map(prev);
      if (picked) {
        if (next.size >= LEARNING_PACK_MAX_LECTURES && !next.has(lectureId)) {
          return prev; // 单包篇数上限（防御；正常操作远达不到）
        }
        next.set(lectureId, new Set());
      } else {
        next.delete(lectureId);
      }
      return next;
    });
  }

  function toggleSection(
    lectureId: string,
    index: number,
    checked: boolean,
  ): void {
    setLecturePicks((prev) => {
      const next = new Map(prev);
      const sections = new Set(next.get(lectureId) ?? []);
      if (checked) {
        sections.add(index);
      } else {
        sections.delete(index);
      }
      next.set(lectureId, sections); // 勾小节自动纳入该讲义
      return next;
    });
  }

  function setAllSections(
    lectureId: string,
    outline: readonly OutlineItem[],
    checked: boolean,
  ): void {
    setLecturePicks((prev) => {
      const next = new Map(prev);
      next.set(
        lectureId,
        checked ? new Set(outline.map((_, i) => i)) : new Set(),
      );
      return next;
    });
  }

  const courseName =
    coursesQuery.data?.courses.find((c) => c.id === courseId)?.name ?? null;
  const assignmentTitle =
    assignmentsQuery.data?.assignments.find((a) => a.id === assignmentId)
      ?.title ?? null;

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">导出给 AI</h1>
        <p className="text-sm text-muted-foreground">
          按五个步骤勾选范围与内容，生成一份可直接交给 AI 的学情数据包
          （zip：数据 + 提示词 + 说明文件）。
        </p>
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-sm">
          {STEP_LABELS.map((label, index) => (
            <li
              key={label}
              aria-current={step === index + 1 ? "step" : undefined}
              className={
                step === index + 1
                  ? "font-semibold text-primary"
                  : "text-muted-foreground"
              }
            >
              {label}
              {index < STEP_LABELS.length - 1 && (
                <span aria-hidden className="ml-2 text-muted-foreground">
                  →
                </span>
              )}
            </li>
          ))}
        </ol>
      </header>

      {step === 1 && (
        <StepScope
          studentsQuery={studentsQuery}
          coursesQuery={coursesQuery}
          assignmentsQuery={assignmentsQuery}
          studentIds={studentIds}
          courseId={courseId}
          assignmentId={assignmentId}
          days={days}
          onToggleStudent={toggleStudent}
          onCourseChange={setCourseId}
          onAssignmentChange={setAssignmentId}
          onDaysChange={setDays}
        />
      )}

      {step === 2 && (
        <StepModules
          lecturesQuery={lecturesQuery}
          lecturePicks={lecturePicks}
          questionLevel={questionLevel}
          responses={responses}
          summaries={summaries}
          ink={ink}
          traces={traces}
          onToggleLecture={toggleLecture}
          onToggleSection={toggleSection}
          onSetAllSections={setAllSections}
          onQuestionLevelChange={setQuestionLevel}
          onResponsesChange={setResponses}
          onSummariesChange={setSummaries}
          onInkChange={setInk}
          onTracesChange={setTraces}
        />
      )}

      {step === 3 && (
        <StepGoal
          goal={goal}
          customPrompt={customPrompt}
          onGoalChange={setGoal}
          onCustomPromptChange={setCustomPrompt}
        />
      )}

      {step === 4 && (
        <StepPrivacy anonymize={anonymize} onAnonymizeChange={setAnonymize} />
      )}

      {step === 5 && (
        <StepPreview
          previewMutation={previewMutation}
          studentCount={studentIds.length}
          courseName={courseName}
          assignmentTitle={assignmentTitle}
          moduleSummary={moduleSummaryText({
            lectures: lecturePicks.size,
            questionLevel,
            responses,
            summaries,
            ink,
            traces,
          })}
          downloading={downloading}
          downloadedFile={downloadedFile}
          downloadError={downloadError}
          onRetryPreview={() => {
            previewMutation.reset();
            previewMutation.mutate(buildRequest());
          }}
          onDownload={() => void handleDownload()}
          onFinish={() => navigate("/t/insights")}
        />
      )}

      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={requestExit}
          disabled={downloading}
        >
          取消
        </Button>
        {step > 1 && (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => setStep((step - 1) as 1 | 2 | 3 | 4)}
            disabled={downloading}
          >
            上一步
          </Button>
        )}
        {step < 5 && (
          <Button
            type="button"
            className="min-h-11 px-4"
            disabled={nextDisabled}
            onClick={handleNext}
          >
            下一步
          </Button>
        )}
      </footer>

      {confirmExit && (
        <DiscardConfirmDialog
          description="离开后本次向导的范围、模块勾选与填写内容都会丢失。"
          onCancel={() => setConfirmExit(false)}
          onDiscard={() => navigate("/t/insights")}
        />
      )}
    </section>
  );
}

/** ⑤步顶部回显：本次导出内容概要（一眼核对再下载） */
function moduleSummaryText(modules: {
  lectures: number;
  questionLevel: "stem" | "answer" | "solution" | null;
  responses: boolean;
  summaries: boolean;
  ink: boolean;
  traces: boolean;
}): string {
  const parts: string[] = [];
  if (modules.lectures > 0) parts.push(`讲义 ${modules.lectures} 篇`);
  if (modules.questionLevel !== null) {
    parts.push(
      modules.questionLevel === "stem"
        ? "题目（仅题干）"
        : modules.questionLevel === "answer"
          ? "题目（含参考答案）"
          : "题目（含解析）",
    );
  }
  if (modules.responses) parts.push("逐题作答与评语");
  if (modules.summaries) parts.push("作答汇总");
  if (modules.traces) parts.push("学习痕迹");
  if (modules.ink) parts.push("手写 PNG");
  return parts.length > 0 ? parts.join(" · ") : "（未勾选任何内容模块）";
}

// ---------- 第①步：范围 ----------

function StepScope({
  studentsQuery,
  coursesQuery,
  assignmentsQuery,
  studentIds,
  courseId,
  assignmentId,
  days,
  onToggleStudent,
  onCourseChange,
  onAssignmentChange,
  onDaysChange,
}: {
  studentsQuery: ReturnType<typeof useStudents>;
  coursesQuery: ReturnType<typeof useTeacherCourses>;
  assignmentsQuery: ReturnType<typeof useTeacherAssignments>;
  studentIds: readonly string[];
  courseId: string;
  assignmentId: string;
  days: DaysValue;
  onToggleStudent: (id: string, checked: boolean) => void;
  onCourseChange: (courseId: string) => void;
  onAssignmentChange: (assignmentId: string) => void;
  onDaysChange: (days: DaysValue) => void;
}) {
  const [studentSearch, setStudentSearch] = useState("");
  const q = studentSearch.trim().toLowerCase();
  const students = studentsQuery.data?.students ?? [];
  const filtered =
    q.length === 0
      ? students
      : students.filter(
          (s) =>
            s.displayName.toLowerCase().includes(q) ||
            s.loginName.toLowerCase().includes(q),
        );

  return (
    <section aria-label="第①步 选择范围" className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm">
          学生（多选，至少一名；勾选顺序即导出包里的化名编号顺序）
        </legend>
        {studentsQuery.isPending ? (
          <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            正在加载学生名单…
          </p>
        ) : studentsQuery.isError ? (
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="text-sm text-destructive">
              {studentsQuery.error instanceof Error
                ? studentsQuery.error.message
                : "学生名单加载失败，请稍后重试"}
            </p>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => void studentsQuery.refetch()}
            >
              重试
            </Button>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <label className="sr-only" htmlFor="export-student-search">
                搜索学生
              </label>
              <Input
                id="export-student-search"
                className="min-h-11 pl-9"
                value={studentSearch}
                onChange={(e) => setStudentSearch(e.target.value)}
                placeholder="搜索姓名 / 登录名"
              />
            </div>
            {students.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                还没有学生：请先到「学生」页添加。
              </p>
            ) : (
              <ul
                aria-label="学生名单"
                className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-1"
              >
                {filtered.map((student) => {
                  const order = studentIds.indexOf(student.id);
                  return (
                    <li key={student.id}>
                      <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm outline-none select-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
                        <input
                          type="checkbox"
                          className="size-5 accent-primary"
                          checked={order >= 0}
                          onChange={(e) =>
                            onToggleStudent(student.id, e.target.checked)
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {student.displayName}
                        </span>
                        {student.archived && (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            已归档
                          </span>
                        )}
                        {order >= 0 && (
                          <span className="shrink-0 rounded-md bg-primary/10 px-2 py-0.5 text-xs text-primary">
                            第 {order + 1} 个
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
                {filtered.length === 0 && (
                  <li className="px-3 py-4 text-center text-sm text-muted-foreground">
                    没有符合搜索的学生。
                  </li>
                )}
              </ul>
            )}
            <p aria-live="polite" className="text-sm text-muted-foreground">
              已选 {studentIds.length} 人
              {studentIds.length > 0 && `（导出时依次编为学生A、学生B…）`}
              {studentIds.length === 0 && "（下一步需要至少一名学生）"}
            </p>
          </>
        )}
      </fieldset>

      <div className="flex flex-col gap-3 rounded-xl border border-border p-3 sm:flex-row sm:items-start">
        <div className="flex-1">
          <label htmlFor="export-course" className="text-sm">
            按课程筛选（可选）
          </label>
          <select
            id="export-course"
            value={courseId}
            onChange={(e) => onCourseChange(e.target.value)}
            className="mt-1.5 flex h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          >
            <option value="">不限课程</option>
            {coursesQuery.data?.courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.name}（{course.memberCount} 名成员）
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label htmlFor="export-assignment" className="text-sm">
            按作业筛选（可选，含已删除作业的历史作答）
          </label>
          <select
            id="export-assignment"
            value={assignmentId}
            onChange={(e) => onAssignmentChange(e.target.value)}
            className="mt-1.5 flex h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          >
            <option value="">不限作业</option>
            {assignmentsQuery.data?.assignments.map((assignment) => (
              <option key={assignment.id} value={assignment.id}>
                {assignment.title}
                {assignment.deleted ? "（已删除）" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        课程 / 作业与学生多选是叠加的交叉筛选：勾选后只导出范围内的作答与
        痕迹数据；讲义与题目内容取当前资源库快照，不受筛选影响。
      </p>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm">
          时间范围（按提交时间，默认最近 30 天）
        </legend>
        <div className="flex flex-wrap gap-2">
          {DAYS_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm outline-none select-none transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50 ${
                days === option.value
                  ? "border-primary/50 bg-primary/5"
                  : "border-border hover:bg-muted/50"
              }`}
            >
              <input
                type="radio"
                name="export-days"
                className="size-4 accent-[var(--color-primary)]"
                checked={days === option.value}
                onChange={() => onDaysChange(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  );
}

// ---------- 第②步：内容模块 ----------

function StepModules({
  lecturesQuery,
  lecturePicks,
  questionLevel,
  responses,
  summaries,
  ink,
  traces,
  onToggleLecture,
  onToggleSection,
  onSetAllSections,
  onQuestionLevelChange,
  onResponsesChange,
  onSummariesChange,
  onInkChange,
  onTracesChange,
}: {
  lecturesQuery: ReturnType<typeof useLibraryLectures>;
  lecturePicks: ReadonlyMap<string, Set<number>>;
  questionLevel: "stem" | "answer" | "solution" | null;
  responses: boolean;
  summaries: boolean;
  ink: boolean;
  traces: boolean;
  onToggleLecture: (lectureId: string, picked: boolean) => void;
  onToggleSection: (lectureId: string, index: number, checked: boolean) => void;
  onSetAllSections: (
    lectureId: string,
    outline: readonly OutlineItem[],
    checked: boolean,
  ) => void;
  onQuestionLevelChange: (level: "stem" | "answer" | "solution" | null) => void;
  onResponsesChange: (checked: boolean) => void;
  onSummariesChange: (checked: boolean) => void;
  onInkChange: (checked: boolean) => void;
  onTracesChange: (checked: boolean) => void;
}) {
  const lectures = lecturesQuery.data?.lectures ?? [];
  const atLectureLimit = lecturePicks.size >= LEARNING_PACK_MAX_LECTURES;

  /** 单选升级式 radio 行样式（题目三层与目标卡片共用视觉语言） */
  const radioRowClass = (selected: boolean): string =>
    `flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm outline-none select-none transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50 ${
      selected
        ? "border-primary/50 bg-primary/5"
        : "border-border hover:bg-muted/50"
    }`;

  return (
    <section aria-label="第②步 选择内容模块" className="flex flex-col gap-5">
      {/* 分组一：教学内容 */}
      <fieldset className="flex flex-col gap-3 rounded-xl border border-border p-3">
        <legend className="px-1 text-sm font-medium">教学内容</legend>

        <div className="flex flex-col gap-1.5">
          <p className="text-sm">
            讲义（候选集为资源库全部讲义；勾选 = 纳入导出，小节不勾 = 仅大纲）
          </p>
          {lecturesQuery.isPending ? (
            <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              正在加载讲义列表…
            </p>
          ) : lecturesQuery.isError ? (
            <div role="alert" className="flex flex-col items-start gap-2">
              <p className="text-sm text-destructive">
                {lecturesQuery.error instanceof Error
                  ? lecturesQuery.error.message
                  : "讲义列表加载失败，请稍后重试"}
              </p>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => void lecturesQuery.refetch()}
              >
                重试
              </Button>
            </div>
          ) : lectures.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
              资源库还没有讲义，可不勾选本项。
            </p>
          ) : (
            <ul
              aria-label="讲义候选列表"
              className="flex max-h-80 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-1"
            >
              {lectures.map((lecture) => (
                <LectureRow
                  key={lecture.id}
                  lectureId={lecture.id}
                  title={lecture.title}
                  picked={lecturePicks.has(lecture.id)}
                  sections={lecturePicks.get(lecture.id) ?? EMPTY_SET}
                  pickDisabled={atLectureLimit && !lecturePicks.has(lecture.id)}
                  onToggleLecture={onToggleLecture}
                  onToggleSection={onToggleSection}
                  onSetAllSections={onSetAllSections}
                />
              ))}
            </ul>
          )}
        </div>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm">题目（三层递进，单选）</legend>
          <div className="flex flex-col gap-2 sm:grid sm:grid-cols-2">
            {QUESTION_LEVEL_OPTIONS.map((option) => {
              const value = option.value === "none" ? null : option.value;
              return (
                <label
                  key={option.value}
                  className={radioRowClass(questionLevel === value)}
                >
                  <input
                    type="radio"
                    name="export-question-level"
                    className="size-4 shrink-0 accent-[var(--color-primary)]"
                    checked={questionLevel === value}
                    onChange={() => onQuestionLevelChange(value)}
                  />
                  <span className="min-w-0">{option.label}</span>
                </label>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            题目取范围内作答的交卷时快照；层级越高包含越多（answer 含题干与
            参考答案，solution 再加详解）。
          </p>
        </fieldset>
      </fieldset>

      {/* 分组二：学生作答 */}
      <fieldset className="flex flex-col gap-1.5 rounded-xl border border-border p-3">
        <legend className="px-1 text-sm font-medium">学生作答</legend>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm outline-none select-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
          <input
            type="checkbox"
            className="size-5 accent-primary"
            checked={responses}
            onChange={(e) => onResponsesChange(e.target.checked)}
          />
          <span className="flex flex-col">
            <span>逐题答案与对错判定、教师评语</span>
            <span className="text-xs text-muted-foreground">
              每题的学生答案、判定结果与你的批注评语（原文）
            </span>
          </span>
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm outline-none select-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
          <input
            type="checkbox"
            className="size-5 accent-primary"
            checked={summaries}
            onChange={(e) => onSummariesChange(e.target.checked)}
          />
          <span className="flex flex-col">
            <span>作答汇总（得分、状态、历次）</span>
            <span className="text-xs text-muted-foreground">
              每次作答的得分与对错计数一览，可看历次进步
            </span>
          </span>
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm outline-none select-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
          <input
            type="checkbox"
            className="size-5 accent-primary"
            checked={ink}
            onChange={(e) => onInkChange(e.target.checked)}
          />
          <span className="flex flex-col">
            <span>手写过程 PNG（默认不勾选）</span>
            <span className="text-xs text-muted-foreground">
              手写题的过程图片，供多模态模型分析书写与步骤
            </span>
          </span>
        </label>
        {ink && (
          <p
            role="note"
            className="flex items-start gap-1.5 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
          >
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            手写图片体积大，会显著增大数据包（上限 50 MB）；建议只导出少数
            学生时勾选，超限可在第⑤步预览看到提示。
          </p>
        )}
      </fieldset>

      {/* 分组三：学习痕迹 */}
      <fieldset className="flex flex-col gap-1.5 rounded-xl border border-border p-3">
        <legend className="px-1 text-sm font-medium">学习痕迹</legend>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm outline-none select-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
          <input
            type="checkbox"
            className="size-5 accent-primary"
            checked={traces}
            onChange={(e) => onTracesChange(e.target.checked)}
          />
          <span className="flex flex-col">
            <span>每题派生指标与讲义阅读地图</span>
            <span className="text-xs text-muted-foreground">
              有效用时、提示数、改答次数、离线作答占比等过程指标 + 讲义阅读
              地图（均为聚合派生结果，不含原始事件记录）
            </span>
          </span>
        </label>
      </fieldset>

      {/* 历次口径：D15 固定行为，说明性展示（非开关） */}
      <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
        <FileArchive aria-hidden className="mt-0.5 size-4 shrink-0" />
        <p>
          历次口径（固定）：数据包收录所选范围内<b>全部历次已交卷作答</b>
          （带第几次作答与「首次」标记，可看重做进步）；未交卷的草稿不收录。
        </p>
      </div>

      <p aria-live="polite" className="text-sm text-muted-foreground">
        {hasContentModuleOf({
          lectures: lecturePicks.size,
          questionLevel,
          responses,
          summaries,
          traces,
        })
          ? "已勾选内容模块。"
          : "下一步需要至少勾选一个内容模块（讲义 / 题目 / 逐题作答 / 作答汇总 / 学习痕迹；手写 PNG 只是附件开关）。"}
      </p>
    </section>
  );
}

const EMPTY_SET: ReadonlySet<number> = new Set();

/** 与契约 superRefine 同式（ink 不算内容模块） */
function hasContentModuleOf(modules: {
  lectures: number;
  questionLevel: "stem" | "answer" | "solution" | null;
  responses: boolean;
  summaries: boolean;
  traces: boolean;
}): boolean {
  return (
    modules.lectures > 0 ||
    modules.questionLevel !== null ||
    modules.responses ||
    modules.summaries ||
    modules.traces
  );
}

/** 单篇讲义行：勾选纳入 + 展开小节树（展开时按需加载大纲） */
function LectureRow({
  lectureId,
  title,
  picked,
  sections,
  pickDisabled,
  onToggleLecture,
  onToggleSection,
  onSetAllSections,
}: {
  lectureId: string;
  title: string;
  picked: boolean;
  sections: ReadonlySet<number>;
  pickDisabled: boolean;
  onToggleLecture: (lectureId: string, picked: boolean) => void;
  onToggleSection: (lectureId: string, index: number, checked: boolean) => void;
  onSetAllSections: (
    lectureId: string,
    outline: readonly OutlineItem[],
    checked: boolean,
  ) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const outlineQuery = useLectureOutline(expanded ? lectureId : null);
  const outline = outlineQuery.data ?? [];
  const allChecked = outline.length > 0 && sections.size >= outline.length;

  return (
    <li className="rounded-md">
      <div className="flex min-h-11 items-center gap-2 pr-2">
        <label
          className={`flex min-h-11 flex-1 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm outline-none select-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 ${
            pickDisabled ? "cursor-not-allowed opacity-50" : ""
          }`}
        >
          <input
            type="checkbox"
            className="size-5 shrink-0 accent-primary"
            checked={picked}
            disabled={pickDisabled}
            onChange={(e) => onToggleLecture(lectureId, e.target.checked)}
          />
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {picked && (
            <span className="shrink-0 rounded-md bg-primary/10 px-2 py-0.5 text-xs text-primary">
              {sections.size > 0 ? `已选 ${sections.size} 节全文` : "仅大纲"}
            </span>
          )}
        </label>
        <Button
          type="button"
          variant="ghost"
          className="size-11 shrink-0"
          aria-expanded={expanded}
          aria-label={`${expanded ? "收起" : "展开"} ${title} 的小节目录`}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <ChevronDown aria-hidden className="size-4" />
          ) : (
            <ChevronRight aria-hidden className="size-4" />
          )}
        </Button>
      </div>

      {expanded && (
        <div className="ml-6 flex flex-col gap-1 rounded-lg border border-border bg-muted/30 p-2">
          {outlineQuery.isPending ? (
            <p className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              正在加载目录…
            </p>
          ) : outlineQuery.isError ? (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 px-2 py-2"
            >
              <p className="text-sm text-destructive">
                {outlineQuery.error instanceof Error
                  ? outlineQuery.error.message
                  : "目录加载失败，请稍后重试"}
              </p>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => void outlineQuery.refetch()}
              >
                重试
              </Button>
            </div>
          ) : outline.length === 0 ? (
            <p className="px-2 py-2 text-sm text-muted-foreground">
              这篇讲义没有 H2/H3 小节，导出时只有标题与大纲。
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between px-2">
                <p className="text-xs text-muted-foreground">
                  勾选需要全文的小节（不勾 = 仅大纲；勾选自动纳入本篇讲义）
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 px-2 text-xs"
                  onClick={() =>
                    onSetAllSections(lectureId, outline, !allChecked)
                  }
                >
                  {allChecked ? "清空小节" : "全选小节"}
                </Button>
              </div>
              <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
                {outline.map((item, index) => (
                  <li key={item.id}>
                    <label
                      className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 ${
                        item.depth === 3 ? "pl-7" : "pl-2"
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-primary"
                        checked={sections.has(index)}
                        onChange={(e) =>
                          onToggleSection(lectureId, index, e.target.checked)
                        }
                      />
                      <span className="shrink-0 text-xs text-muted-foreground">
                        H{item.depth}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {item.text}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </li>
  );
}

// ---------- 第③步：任务目标 ----------

function StepGoal({
  goal,
  customPrompt,
  onGoalChange,
  onCustomPromptChange,
}: {
  goal: LearningPackGoal;
  customPrompt: string;
  onGoalChange: (goal: LearningPackGoal) => void;
  onCustomPromptChange: (prompt: string) => void;
}) {
  return (
    <section aria-label="第③步 选择任务目标" className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm">
          任务目标（决定数据包内 prompt.md 的分析模板）
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {GOAL_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm outline-none select-none transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50 ${
                goal === option.value
                  ? "border-primary/50 bg-primary/5"
                  : "border-border hover:bg-muted/50"
              }`}
            >
              <input
                type="radio"
                name="export-goal"
                className="mt-0.5 size-4 shrink-0 accent-[var(--color-primary)]"
                checked={goal === option.value}
                onChange={() => onGoalChange(option.value)}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">
                  {LEARNING_PACK_GOAL_LABELS[option.value]}
                </span>
                <span className="text-xs text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          模板会按第②步勾选的模块自动拼装（如未勾手写过程，提示词中不会提
          笔迹）；全文见「学情分析提示词」文档。
        </p>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="export-custom-prompt" className="text-sm">
          教师附加要求（可选，追加在 prompt.md 的「教师附加要求」段）
        </label>
        <textarea
          id="export-custom-prompt"
          className="min-h-24 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          value={customPrompt}
          onChange={(e) => onCustomPromptChange(e.target.value)}
          maxLength={LEARNING_PACK_CUSTOM_PROMPT_MAX}
          placeholder="例如：侧重有理数运算的薄弱点；输出按知识点分组；额外给一份家长版简述。"
        />
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {customPrompt.length} / {LEARNING_PACK_CUSTOM_PROMPT_MAX} 字
        </p>
      </div>
    </section>
  );
}

// ---------- 第④步：隐私 ----------

function StepPrivacy({
  anonymize,
  onAnonymizeChange,
}: {
  anonymize: boolean;
  onAnonymizeChange: (anonymize: boolean) => void;
}) {
  /** 「包含真实姓名」待确认（D16：确认后才真正关闭化名） */
  const [confirmRealName, setConfirmRealName] = useState(false);

  function handleRealNameToggle(checked: boolean): void {
    if (checked) {
      setConfirmRealName(true); // 打开真实姓名 → 二次确认
      return;
    }
    onAnonymizeChange(true); // 关闭真实姓名 → 回到化名
  }

  return (
    <section aria-label="第④步 隐私选项" className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
        <p className="text-sm font-medium">化名导出（默认开启）</p>
        <p className="text-sm text-muted-foreground">
          学生在数据包中以「学生A、学生B…」称呼（按第①步勾选顺序编号），
          化名与真实姓名的对照只写进 zip 里的 映射.txt，仅保存在老师本地、
          不交给 AI。
        </p>
      </div>

      <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-border px-3 py-2.5 text-sm outline-none select-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
        <input
          type="checkbox"
          className="mt-0.5 size-5 shrink-0 accent-primary"
          checked={!anonymize}
          onChange={(e) => handleRealNameToggle(e.target.checked)}
        />
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">包含真实姓名</span>
          <span className="text-xs text-muted-foreground">
            关闭化名：pack.json、summary.md 与手写文件名将包含学生真实姓名
          </span>
        </span>
      </label>

      <p className="flex items-start gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        无论是否化名，你的批注评语一律按原文收录（可能包含学生姓名），数据包
        内已注明这一口径；请确认将要上传数据包的 AI 服务可被信任。
      </p>

      {confirmRealName && (
        <Dialog
          open
          onOpenChange={(open) =>
            open ? undefined : setConfirmRealName(false)
          }
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <TriangleAlert aria-hidden className="size-4" />
                确认在数据包中包含真实姓名？
              </DialogTitle>
              <DialogDescription>
                开启后，导出的 pack.json、summary.md 与手写图片文件名都会包含
                学生的真实姓名，并随整个 zip 交给 AI 服务。此操作无法在导出后
                撤回，建议仅在学生本人或家长知情同意时使用。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 px-5"
                onClick={() => setConfirmRealName(false)}
              >
                仍使用化名
              </Button>
              <Button
                type="button"
                variant="destructive"
                className="min-h-11 px-5"
                onClick={() => {
                  setConfirmRealName(false);
                  onAnonymizeChange(false);
                }}
              >
                确认包含真实姓名
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

// ---------- 第⑤步：预览与下载 ----------

function StepPreview({
  previewMutation,
  studentCount,
  courseName,
  assignmentTitle,
  moduleSummary,
  downloading,
  downloadedFile,
  downloadError,
  onRetryPreview,
  onDownload,
  onFinish,
}: {
  previewMutation: ReturnType<typeof useLearningPackPreview>;
  studentCount: number;
  courseName: string | null;
  assignmentTitle: string | null;
  moduleSummary: string;
  downloading: boolean;
  downloadedFile: string | null;
  downloadError: string | null;
  onRetryPreview: () => void;
  onDownload: () => void;
  onFinish: () => void;
}) {
  const data: LearningPackPreviewData | undefined = previewMutation.data;
  const overLimit = data?.overLimit === true;

  return (
    <section aria-label="第⑤步 预览与下载" className="flex flex-col gap-4">
      {/* 本次导出概要回显 */}
      <div className="flex flex-col gap-1 rounded-xl border border-border p-3 text-sm">
        <p>
          范围：{studentCount} 名学生
          {courseName !== null && ` · 课程「${courseName}」`}
          {assignmentTitle !== null && ` · 作业「${assignmentTitle}」`}
        </p>
        <p className="text-muted-foreground">内容：{moduleSummary}</p>
      </div>

      {previewMutation.isPending && (
        <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          正在生成文件清单…
        </p>
      )}

      {previewMutation.isError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-4"
        >
          <p className="text-sm font-medium text-destructive">预览加载失败</p>
          <p className="text-sm text-muted-foreground">
            {previewMutation.error instanceof Error
              ? previewMutation.error.message
              : "网络异常，请稍后重试"}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={onRetryPreview}
          >
            重新预览
          </Button>
        </div>
      )}

      {data !== undefined && (
        <>
          <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-medium">包内文件清单</h2>
              <p className="text-sm">
                合计 <b>{formatBytes(data.totalEstimatedBytes)}</b>
                <span className="text-muted-foreground">
                  {" "}
                  / 上限 {formatBytes(data.limitBytes)}
                </span>
              </p>
            </div>
            <ul
              aria-label="文件清单"
              className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-lg border border-border p-2 font-mono text-xs"
            >
              {data.files.map((file) => (
                <li
                  key={file.path}
                  className="flex items-baseline justify-between gap-3 px-1 py-1"
                >
                  <span className="min-w-0 break-all">{file.path}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {formatBytes(file.estimatedBytes)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {overLimit ? (
            <div
              role="alert"
              className="flex flex-col gap-1.5 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm"
            >
              <p className="flex items-center gap-1.5 font-medium text-destructive">
                <TriangleAlert aria-hidden className="size-4 shrink-0" />
                超过 50 MB 上限，无法下载。建议精简：
              </p>
              <ul className="flex list-disc flex-col gap-0.5 pl-8 text-muted-foreground">
                <li>减少学生人数或分多次导出；</li>
                <li>取消勾选「手写过程 PNG」（体积大头）；</li>
                <li>缩短时间范围（如 90 天 → 30 天）。</li>
              </ul>
              {data.hint !== null && (
                <p className="text-xs text-muted-foreground">
                  服务端提示：{data.hint}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              清单与实际包内容一致（大小为预估值）；prompt.md 已按你的勾选与
              任务目标拼装完毕。
            </p>
          )}

          {downloadError !== null && (
            <p role="alert" className="text-sm text-destructive">
              {downloadError}
            </p>
          )}

          {downloadedFile !== null ? (
            <div className="flex flex-col items-start gap-2 rounded-xl border border-border bg-muted/30 p-4 text-sm">
              <p className="font-medium">已生成并开始下载：{downloadedFile}</p>
              <p className="text-muted-foreground">
                把整个 zip 交给 AI 即可——把包内 prompt.md 一并粘贴或上传，
                分析任务与数据说明都在里面。
              </p>
              <Button variant="outline" className="min-h-11" onClick={onFinish}>
                返回学情总览
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              className="min-h-11 px-4"
              disabled={overLimit || downloading}
              onClick={onDownload}
            >
              {downloading ? (
                <>
                  <Loader2 aria-hidden className="animate-spin" />
                  正在生成数据包…
                </>
              ) : (
                <>
                  <Download aria-hidden />
                  生成并下载
                </>
              )}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
