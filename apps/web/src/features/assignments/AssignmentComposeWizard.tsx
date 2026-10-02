import { arrayMove } from "@dnd-kit/sortable";
import type {
  AssignmentCheckHint,
  CourseDetailItem,
  LibraryUnitSummary,
  QuestionType,
} from "@tutor/contract";
import { defaultAssignmentTitle } from "@tutor/contract";
import {
  ArrowDown,
  ArrowUp,
  Dumbbell,
  Library,
  Loader2,
  Plus,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { QUESTION_TYPE_LABELS } from "@/features/content/question-meta";
import {
  DragHandle,
  SortableItem,
  SortableZone,
} from "@/features/content/sortable";
import { courseItemStatusLabel } from "@/features/courses/CourseCatalogTab";
import {
  useCourseDetail,
  useTeacherCourses,
} from "@/features/courses/course-queries";
import {
  useLibraryFolders,
  useLibraryUnits,
} from "@/features/library/library-queries";
import { useStudents } from "@/features/students/student-queries";
import { ApiError } from "@/lib/api";
import { formatDueTime, localInputToUtcIso } from "@/lib/time";
import { useCheckAssignment, useCreateAssignment } from "./assignment-queries";
import { DiscardConfirmDialog } from "./DiscardConfirmDialog";

/**
 * 布置作业三步向导（T2A.7，D12/D13/D15；§4 教师端通用使用约定）：
 * - 第①步 对象：可选「所属课程」（含「不按课程」）。选了课程 → 名单自动带出该课程
 *   全部成员且默认全勾选（可逐个取消）；未选课程 → 从学生列表直接多选；
 * - 第②步 内容：「本课程练习 / 资源库」双页签多选。本课程练习按目录顺序、含隐藏
 *   条目并标注可见状态（跳过已删除与无题目条目）；资源库支持文件夹筛选与搜索
 *   （前端即时过滤，§4-3）。右侧已选列表按选择顺序排列，可拖拽排序并有上移/下移
 *   兜底（§4-9），同一单元不可重复选（选择器中标记「已选」）；
 * - 第③步 确认：作业组合方式（2026-10 产品决策：默认不合并——「每个单元一份
 *   作业（推荐）」默认选中，学生端分别看到 N 份作业各自作答与交卷；可切
 *   「合并为一份作业」回到旧行为。separate 模式下标题留空 = 每份用各自单元
 *   标题、填写 = 每份「标题·单元名」）+ 标题（merged 占位符 =
 *   defaultAssignmentTitle 缺省组合）+ 截止时间（北京时间，附「x 天后」相对
 *   提示，§4-8）+ 答案公布时机（T2A.8：交卷即公布（默认）/ 截止后公布——后者
 *   须先填截止，否则即时提示并阻止提交）+ D15「已做过」提示（仅提示不阻止）；
 * - 关闭守卫：有任何已选内容 / 已填字段时关闭需二次确认（§4-5）。
 * 三态齐全（加载 / 空态指引 / 错误重试），交互目标 ≥44px，文案中文。
 */

/** 向导内一个可布置单元的展示数据（题数 + 题型分布，两个来源共用） */
interface WizardUnit {
  unitId: string;
  title: string;
  questionCount: number;
  /** 题型 → 题数（本课程练习条目经资源库同 id 单元补齐，D1 引用而非复制） */
  typeDistribution: Record<string, number>;
}

/** 题型分布文本（如「判断×1 单选×2」）；未知题型回退原键 */
function distributionText(distribution: Record<string, number>): string {
  return Object.entries(distribution)
    .map(
      ([type, count]) =>
        `${QUESTION_TYPE_LABELS[type as QuestionType] ?? type}×${count}`,
    )
    .join(" ");
}

/** D15 提示行文本：「张三：已在〈课程〉中做过〈单元〉n 次（已看过答案）」 */
function checkHintLine(hint: AssignmentCheckHint): string {
  return `${hint.studentName}：已在〈${hint.courseName ?? "课程"}〉中做过〈${hint.unitTitle}〉${hint.submittedCount} 次（已看过答案）`;
}

/** 截止时间的「x 天后」相对提示（§4-8，与课程页定时发布同一口径） */
function dueRelativeHint(localValue: string): string | null {
  if (localValue.length === 0) return null;
  const utc = localInputToUtcIso(localValue);
  const days = Math.ceil(
    (Date.parse(utc) - Date.now()) / (24 * 60 * 60 * 1000),
  );
  if (Number.isNaN(days)) return null;
  if (days < 0) return `该时间已过（北京时间 ${formatDueTime(utc)}）`;
  if (days === 0) return "今天截止（北京时间）";
  return `${days} 天后截止（北京时间 ${formatDueTime(utc)}）`;
}

const STEP_LABELS = ["① 对象", "② 内容", "③ 确认"] as const;

export function AssignmentComposeWizard({
  initialCourseId,
  onClose,
}: {
  /** 课程页「布置作业」入口带入的课程 id（进入第①步即选中该课程） */
  initialCourseId: string | null;
  onClose: () => void;
}) {
  const coursesQuery = useTeacherCourses(false);
  const studentsQuery = useStudents(false);
  const foldersQuery = useLibraryFolders();
  const libraryUnitsQuery = useLibraryUnits({});
  const createMutation = useCreateAssignment();
  const checkMutation = useCheckAssignment();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [courseId, setCourseId] = useState(initialCourseId ?? "");
  const [studentIds, setStudentIds] = useState<ReadonlySet<string>>(new Set());
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [dueLocal, setDueLocal] = useState("");
  /**
   * 组合方式（2026-10 产品决策：默认不合并）：separate = 每个单元一份作业
   * （推荐，学生端分别作答与交卷）；merged = 合并为一份试卷（旧行为）。
   * 提交 payload 始终携带本字段；服务端缺省按 merged 解析（向后兼容）。
   */
  const [unitGrouping, setUnitGrouping] = useState<"separate" | "merged">(
    "separate",
  );
  /** 答案公布时机（T2A.8，D11）：默认交卷即公布；截止后公布须先填截止时间 */
  const [answerRelease, setAnswerRelease] = useState<"on_submit" | "after_due">(
    "on_submit",
  );
  const [tab, setTab] = useState<"course" | "library">("course");
  const [folderId, setFolderId] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // 选中课程后加载其目录与成员（第①步名单带出 + 第②步本课程练习共用）
  const detailQuery = useCourseDetail(courseId);

  /** 课程成员自动带出（D13）：选中课程且详情到达时，名单默认全勾选该课程全部
   *  成员，可逐个取消；切到「不按课程」保留现选择，再次选课重新带出。 */
  const syncedCourseRef = useRef<string | null>(null);
  useEffect(() => {
    if (courseId === "") {
      syncedCourseRef.current = null;
      return;
    }
    const members = detailQuery.data?.members;
    if (members !== undefined && syncedCourseRef.current !== courseId) {
      setStudentIds(new Set(members.map((member) => member.studentId)));
      syncedCourseRef.current = courseId;
    }
  }, [courseId, detailQuery.data]);

  const libraryUnits = useMemo(
    () => libraryUnitsQuery.data?.units ?? [],
    [libraryUnitsQuery.data?.units],
  );
  const libraryUnitById = useMemo(
    () => new Map(libraryUnits.map((unit) => [unit.id, unit])),
    [libraryUnits],
  );
  /** 本课程目录中的单元条目：按目录顺序，含隐藏条目（D12；跳过已删除与无题目） */
  const courseUnitItems = useMemo(
    () =>
      (detailQuery.data?.items ?? []).filter(
        (item) =>
          item.kind === "unit" &&
          item.status !== "deleted" &&
          item.status !== "no-questions",
      ),
    [detailQuery.data?.items],
  );

  /** 单元展示数据合并表（资源库为主，本课程条目覆盖标题/题数并补齐题型分布） */
  const unitById = useMemo(() => {
    const map = new Map<string, WizardUnit>();
    for (const unit of libraryUnits) {
      map.set(unit.id, {
        unitId: unit.id,
        title: unit.title,
        questionCount: unit.questionCount,
        typeDistribution: unit.typeDistribution,
      });
    }
    for (const item of courseUnitItems) {
      if (item.refId === null) continue;
      map.set(item.refId, {
        unitId: item.refId,
        title: item.title,
        questionCount: item.questionCount ?? 0,
        typeDistribution:
          libraryUnitById.get(item.refId)?.typeDistribution ?? {},
      });
    }
    return map;
  }, [libraryUnits, courseUnitItems, libraryUnitById]);

  const selectedUnits = selectedUnitIds
    .map((id) => unitById.get(id))
    .filter((unit): unit is WizardUnit => unit !== undefined);
  const totalQuestions = selectedUnits.reduce(
    (sum, unit) => sum + unit.questionCount,
    0,
  );
  /** 已选单元的题型分布汇总（按题型首次出现顺序） */
  const mergedTypeEntries = useMemo(() => {
    const acc = new Map<string, number>();
    for (const unit of selectedUnits) {
      for (const [type, count] of Object.entries(unit.typeDistribution)) {
        acc.set(type, (acc.get(type) ?? 0) + count);
      }
    }
    return [...acc.entries()];
  }, [selectedUnits]);

  const courseName =
    coursesQuery.data?.courses.find((course) => course.id === courseId)?.name ??
    null;

  /** 未选课程时「本课程练习」页签不可用，实际展示资源库页签 */
  const activeTab = tab === "course" && courseId === "" ? "library" : tab;

  const dirty =
    studentIds.size > 0 ||
    selectedUnitIds.length > 0 ||
    title.trim().length > 0 ||
    dueLocal.length > 0 ||
    answerRelease !== "on_submit" ||
    unitGrouping !== "separate";

  /** 关闭守卫（§4-5）：有已选内容 / 已填字段先确认；提交中不允许关闭 */
  function requestClose(): void {
    if (createMutation.isPending) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  function toggleStudent(id: string, checked: boolean): void {
    setStudentIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  /** 勾选 = 追加到已选末尾（选择顺序即作答顺序）；取消勾选 = 从已选中移除 */
  function toggleUnit(unitId: string, checked: boolean): void {
    setSelectedUnitIds((prev) =>
      checked ? [...prev, unitId] : prev.filter((id) => id !== unitId),
    );
  }

  /** 上移/下移兜底（§4-9；与拖拽共用同一顺序状态） */
  function moveUnit(index: number, offset: -1 | 1): void {
    setSelectedUnitIds((prev) => arrayMove(prev, index, index + offset));
  }

  /** 进入第③步时发起 D15「已做过」检查（unitIds × studentIds） */
  function goToStep3(): void {
    checkMutation.reset();
    checkMutation.mutate({
      unitIds: selectedUnitIds,
      studentIds: [...studentIds],
    });
    setStep(3);
  }

  function handleSubmit(event: React.FormEvent): void {
    event.preventDefault();
    // T2A.8：选了「截止后公布」而没有截止时间时前端即时拦截（服务端同口径 400）
    if (answerRelease === "after_due" && dueLocal.length === 0) return;
    createMutation.mutate(
      {
        unitIds: selectedUnitIds,
        studentIds: [...studentIds],
        ...(courseId.length > 0 ? { courseId } : {}),
        ...(title.trim().length > 0 ? { title: title.trim() } : {}),
        ...(dueLocal.length > 0 ? { dueAt: localInputToUtcIso(dueLocal) } : {}),
        answerRelease,
        unitGrouping,
      },
      { onSuccess: onClose },
    );
  }

  const mutationError =
    createMutation.isError && createMutation.error instanceof ApiError
      ? createMutation.error.message
      : createMutation.isError
        ? "操作失败，请稍后重试"
        : null;

  const loadingBase = coursesQuery.isPending || studentsQuery.isPending;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : requestClose())}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>布置作业</DialogTitle>
          <DialogDescription>
            三步完成：选择对象 → 选择练习单元 → 确认布置。
          </DialogDescription>
          <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
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
        </DialogHeader>

        {step === 1 && (
          <StepRecipients
            coursesQuery={coursesQuery}
            studentsQuery={studentsQuery}
            detailQuery={detailQuery}
            courseId={courseId}
            studentIds={studentIds}
            loadingBase={loadingBase}
            onCourseChange={setCourseId}
            onToggleStudent={toggleStudent}
          />
        )}

        {step === 2 && (
          <StepContent
            courseId={courseId}
            courseUnitItems={courseUnitItems}
            detailPending={detailQuery.isPending}
            detailError={
              detailQuery.isError
                ? detailQuery.error instanceof Error
                  ? detailQuery.error.message
                  : "课程目录加载失败，请稍后重试"
                : null
            }
            detailRefetch={() => void detailQuery.refetch()}
            libraryUnits={libraryUnits}
            libraryPending={libraryUnitsQuery.isPending}
            libraryError={
              libraryUnitsQuery.isError
                ? libraryUnitsQuery.error instanceof Error
                  ? libraryUnitsQuery.error.message
                  : "加载失败"
                : null
            }
            folders={foldersQuery.data?.folders ?? []}
            selectedUnitIds={selectedUnitIds}
            selectedUnits={selectedUnits}
            totalQuestions={totalQuestions}
            mergedTypeEntries={mergedTypeEntries}
            activeTab={activeTab}
            folderId={folderId}
            search={search}
            onTabChange={setTab}
            onFolderChange={setFolderId}
            onSearchChange={setSearch}
            onToggleUnit={toggleUnit}
            onMoveUnit={moveUnit}
            onReorderUnits={setSelectedUnitIds}
          />
        )}

        {step === 3 && (
          <StepConfirm
            courseName={courseName}
            studentCount={studentIds.size}
            selectedUnits={selectedUnits}
            totalQuestions={totalQuestions}
            title={title}
            dueLocal={dueLocal}
            unitGrouping={unitGrouping}
            answerRelease={answerRelease}
            checkPending={checkMutation.isPending}
            checkError={
              checkMutation.isError
                ? checkMutation.error instanceof Error
                  ? checkMutation.error.message
                  : "网络异常"
                : null
            }
            checkHints={checkMutation.data?.hints ?? []}
            mutationError={mutationError}
            pending={createMutation.isPending}
            onTitleChange={setTitle}
            onDueChange={setDueLocal}
            onUnitGroupingChange={setUnitGrouping}
            onAnswerReleaseChange={setAnswerRelease}
            onSubmit={handleSubmit}
          />
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={requestClose}
            disabled={createMutation.isPending}
          >
            取消
          </Button>
          {step > 1 && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setStep(step === 3 ? 2 : 1)}
              disabled={createMutation.isPending}
            >
              上一步
            </Button>
          )}
          {step === 1 && (
            <Button
              type="button"
              className="min-h-11 px-4"
              disabled={loadingBase || studentIds.size === 0}
              onClick={() => setStep(2)}
            >
              下一步
            </Button>
          )}
          {step === 2 && (
            <Button
              type="button"
              className="min-h-11 px-4"
              disabled={selectedUnitIds.length === 0}
              onClick={goToStep3}
            >
              下一步
            </Button>
          )}
        </DialogFooter>

        {confirmDiscard && (
          <DiscardConfirmDialog
            description="关闭后本次已选择的名单、单元与填写内容都会丢失。"
            onCancel={() => setConfirmDiscard(false)}
            onDiscard={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------- 第①步：对象 ----------

/** 学生勾选行（课程成员带出与学生多选共用） */
function StudentCheckRow({
  id,
  name,
  meta,
  checked,
  onToggle,
}: {
  id: string;
  name: string;
  meta: string | null;
  checked: boolean;
  onToggle: (id: string, checked: boolean) => void;
}) {
  return (
    <li key={id}>
      <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm outline-none select-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
        <input
          type="checkbox"
          className="size-5 accent-primary"
          checked={checked}
          onChange={(e) => onToggle(id, e.target.checked)}
        />
        <span>{name}</span>
        {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
      </label>
    </li>
  );
}

function StepRecipients({
  coursesQuery,
  studentsQuery,
  detailQuery,
  courseId,
  studentIds,
  loadingBase,
  onCourseChange,
  onToggleStudent,
}: {
  coursesQuery: ReturnType<typeof useTeacherCourses>;
  studentsQuery: ReturnType<typeof useStudents>;
  detailQuery: ReturnType<typeof useCourseDetail>;
  courseId: string;
  studentIds: ReadonlySet<string>;
  loadingBase: boolean;
  onCourseChange: (courseId: string) => void;
  onToggleStudent: (id: string, checked: boolean) => void;
}) {
  return (
    <section aria-label="第①步 选择对象" className="flex flex-col gap-4">
      {loadingBase ? (
        <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          正在加载课程与学生…
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="wizard-course" className="text-sm">
              所属课程（可选；选择后名单默认带出该课程全部成员）
            </label>
            <select
              id="wizard-course"
              value={courseId}
              onChange={(e) => onCourseChange(e.target.value)}
              className="flex h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            >
              <option value="">不按课程（从学生名单中选择）</option>
              {coursesQuery.data?.courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.name}（{course.memberCount} 名成员）
                </option>
              ))}
            </select>
          </div>

          {courseId === "" ? (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm">指派学生（多选，至少一名）</legend>
              {(studentsQuery.data?.students.length ?? 0) === 0 && (
                <p className="text-sm text-muted-foreground">
                  还没有学生：请先到「学生」页添加。
                </p>
              )}
              <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-1">
                {studentsQuery.data?.students.map((student) => (
                  <StudentCheckRow
                    key={student.id}
                    id={student.id}
                    name={student.displayName}
                    meta={student.loginName}
                    checked={studentIds.has(student.id)}
                    onToggle={onToggleStudent}
                  />
                ))}
              </ul>
            </fieldset>
          ) : detailQuery.isPending ? (
            <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              正在加载课程成员…
            </p>
          ) : detailQuery.isError ? (
            <div role="alert" className="flex flex-col items-start gap-2">
              <p className="text-sm text-destructive">
                {detailQuery.error instanceof Error
                  ? detailQuery.error.message
                  : "课程成员加载失败，请稍后重试"}
              </p>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => void detailQuery.refetch()}
              >
                重试
              </Button>
            </div>
          ) : (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm">
                课程成员（已默认全选，可逐个取消）
              </legend>
              {detailQuery.data.members.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  该课程还没有成员：可到课程页添加成员，或返回选择「不按课程」。
                </p>
              )}
              <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-1">
                {detailQuery.data.members.map((member) => (
                  <StudentCheckRow
                    key={member.studentId}
                    id={member.studentId}
                    name={member.displayName}
                    meta={member.archived ? "已归档" : null}
                    checked={studentIds.has(member.studentId)}
                    onToggle={onToggleStudent}
                  />
                ))}
              </ul>
            </fieldset>
          )}

          <p aria-live="polite" className="text-sm text-muted-foreground">
            已选 {studentIds.size} 人
            {studentIds.size === 0 && "（下一步需要至少一名学生）"}
          </p>
        </>
      )}
    </section>
  );
}

// ---------- 第②步：内容 ----------

function StepContent({
  courseId,
  courseUnitItems,
  detailPending,
  detailError,
  detailRefetch,
  libraryUnits,
  libraryPending,
  libraryError,
  folders,
  selectedUnitIds,
  selectedUnits,
  totalQuestions,
  mergedTypeEntries,
  activeTab,
  folderId,
  search,
  onTabChange,
  onFolderChange,
  onSearchChange,
  onToggleUnit,
  onMoveUnit,
  onReorderUnits,
}: {
  courseId: string;
  courseUnitItems: CourseDetailItem[];
  detailPending: boolean;
  detailError: string | null;
  detailRefetch: () => void;
  libraryUnits: LibraryUnitSummary[];
  libraryPending: boolean;
  libraryError: string | null;
  folders: { id: string; name: string }[];
  selectedUnitIds: string[];
  selectedUnits: WizardUnit[];
  totalQuestions: number;
  mergedTypeEntries: [string, number][];
  activeTab: "course" | "library";
  folderId: string;
  search: string;
  onTabChange: (tab: "course" | "library") => void;
  onFolderChange: (folderId: string) => void;
  onSearchChange: (search: string) => void;
  onToggleUnit: (unitId: string, checked: boolean) => void;
  onMoveUnit: (index: number, offset: -1 | 1) => void;
  onReorderUnits: (orderedIds: string[]) => void;
}) {
  const q = search.trim().toLowerCase();
  const filteredLibraryUnits = libraryUnits
    .filter(
      (unit) =>
        folderId === "all" ||
        (folderId === "none"
          ? unit.folderId === null
          : unit.folderId === folderId),
    )
    .filter(
      (unit) =>
        q.length === 0 ||
        unit.title.toLowerCase().includes(q) ||
        unit.id.toLowerCase().includes(q) ||
        (unit.topic?.toLowerCase().includes(q) ?? false) ||
        unit.knowledge.some((point) => point.toLowerCase().includes(q)),
    );

  return (
    <section
      aria-label="第②步 选择内容"
      className="grid items-start gap-3 lg:grid-cols-2"
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div
          role="tablist"
          aria-label="内容来源"
          className="flex flex-wrap gap-2"
        >
          <Button
            role="tab"
            aria-selected={activeTab === "course"}
            variant={activeTab === "course" ? "secondary" : "outline"}
            className="min-h-11"
            disabled={courseId === ""}
            onClick={() => onTabChange("course")}
          >
            <Dumbbell aria-hidden />
            本课程练习
          </Button>
          <Button
            role="tab"
            aria-selected={activeTab === "library"}
            variant={activeTab === "library" ? "secondary" : "outline"}
            className="min-h-11"
            onClick={() => onTabChange("library")}
          >
            <Library aria-hidden />
            资源库
          </Button>
          {courseId === "" && (
            <span className="self-center text-xs text-muted-foreground">
              「本课程练习」先在第①步选择课程后可用
            </span>
          )}
        </div>

        {activeTab === "course" ? (
          detailPending ? (
            <p className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              正在加载课程目录…
            </p>
          ) : detailError !== null ? (
            <div role="alert" className="flex flex-col items-start gap-2">
              <p className="text-sm text-destructive">{detailError}</p>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={detailRefetch}
              >
                重试
              </Button>
            </div>
          ) : courseUnitItems.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
              该课程目录还没有可布置的练习单元（已删除与无题目的条目不列出）。
            </p>
          ) : (
            <ul
              aria-label="本课程练习单元列表"
              className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-1"
            >
              {courseUnitItems.map((item) => {
                const unitId = item.refId ?? item.title;
                const selected = selectedUnitIds.includes(unitId);
                return (
                  <li key={unitId}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm outline-none select-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
                      <input
                        type="checkbox"
                        className="size-5 accent-primary"
                        checked={selected}
                        onChange={(e) => onToggleUnit(unitId, e.target.checked)}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {item.title}
                      </span>
                      <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {courseItemStatusLabel(item)}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {item.questionCount ?? 0} 题
                      </span>
                      {selected && (
                        <span className="shrink-0 rounded-md bg-primary/10 px-2 py-0.5 text-xs text-primary">
                          已选
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          )
        ) : libraryPending ? (
          <p className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            正在加载资源库…
          </p>
        ) : libraryError !== null ? (
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="text-sm text-destructive">{libraryError}</p>
            <p className="text-xs text-muted-foreground">
              资源库加载失败不影响从「本课程练习」选择。
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="sr-only" htmlFor="wizard-folder">
                文件夹筛选
              </label>
              <select
                id="wizard-folder"
                className="min-h-11 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                value={folderId}
                onChange={(e) => onFolderChange(e.target.value)}
              >
                <option value="all">全部文件夹</option>
                <option value="none">未归类</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
              <div className="relative flex-1">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <label className="sr-only" htmlFor="wizard-search">
                  搜索单元
                </label>
                <Input
                  id="wizard-search"
                  className="min-h-11 pl-9"
                  value={search}
                  onChange={(e) => onSearchChange(e.target.value)}
                  placeholder="搜索单元标题 / id / 主题 / 考点"
                />
              </div>
            </div>
            {filteredLibraryUnits.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
                资源库没有符合筛选的单元。可先到「导入」添加练习。
              </p>
            ) : (
              <ul
                aria-label="资源库单元列表"
                className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-1"
              >
                {filteredLibraryUnits.map((unit) => {
                  const selected = selectedUnitIds.includes(unit.id);
                  const empty = unit.questionCount === 0;
                  const distribution = distributionText(unit.typeDistribution);
                  return (
                    <li key={unit.id}>
                      <label
                        className={`flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm ${
                          empty
                            ? "cursor-not-allowed text-muted-foreground"
                            : "cursor-pointer outline-none select-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="size-5 accent-primary"
                          disabled={empty}
                          checked={selected}
                          onChange={(e) =>
                            onToggleUnit(unit.id, e.target.checked)
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {unit.title}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {unit.questionCount} 题
                          {distribution.length > 0 && ` · ${distribution}`}
                        </span>
                        {empty && (
                          <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            无题目
                          </span>
                        )}
                        {selected && (
                          <span className="shrink-0 rounded-md bg-primary/10 px-2 py-0.5 text-xs text-primary">
                            已选
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>

      <aside
        aria-label="已选单元"
        className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-muted/30 p-3"
      >
        <p className="text-sm font-medium">已选列表（按作答顺序）</p>
        {selectedUnits.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-card px-3 py-8 text-center text-sm text-muted-foreground">
            在左侧勾选练习单元；勾选顺序即作答顺序。
          </p>
        ) : (
          <SortableZone
            ids={selectedUnitIds}
            ariaLabel="已选单元列表，可拖拽排序"
            onReorder={onReorderUnits}
          >
            <ul className="flex flex-col gap-1">
              {selectedUnits.map((unit, index) => (
                <SortableItem key={unit.unitId} id={unit.unitId}>
                  {({ rowProps, handleListeners }) => (
                    <li
                      {...rowProps}
                      className="flex items-center gap-1 rounded-lg border border-border bg-card p-1.5"
                    >
                      <DragHandle
                        label={`拖拽调整 ${unit.title} 的顺序`}
                        listeners={handleListeners}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {unit.title}
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {unit.questionCount} 题
                        </span>
                      </span>
                      <Button
                        variant="ghost"
                        className="size-11 shrink-0"
                        aria-label={`上移 ${unit.title}`}
                        disabled={index === 0}
                        onClick={() => onMoveUnit(index, -1)}
                      >
                        <ArrowUp aria-hidden className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        className="size-11 shrink-0"
                        aria-label={`下移 ${unit.title}`}
                        disabled={index === selectedUnits.length - 1}
                        onClick={() => onMoveUnit(index, 1)}
                      >
                        <ArrowDown aria-hidden className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        className="size-11 shrink-0 text-destructive hover:text-destructive"
                        aria-label={`移除 ${unit.title}`}
                        onClick={() => onToggleUnit(unit.unitId, false)}
                      >
                        <X aria-hidden className="size-4" />
                      </Button>
                    </li>
                  )}
                </SortableItem>
              ))}
            </ul>
          </SortableZone>
        )}
        <p aria-live="polite" className="text-sm">
          已选 {selectedUnits.length} 个单元 · 共 {totalQuestions} 题
        </p>
        {mergedTypeEntries.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {distributionText(Object.fromEntries(mergedTypeEntries))}
          </p>
        )}
      </aside>
    </section>
  );
}

// ---------- 第③步：确认 ----------

function StepConfirm({
  courseName,
  studentCount,
  selectedUnits,
  totalQuestions,
  title,
  dueLocal,
  unitGrouping,
  answerRelease,
  checkPending,
  checkError,
  checkHints,
  mutationError,
  pending,
  onTitleChange,
  onDueChange,
  onUnitGroupingChange,
  onAnswerReleaseChange,
  onSubmit,
}: {
  courseName: string | null;
  studentCount: number;
  selectedUnits: WizardUnit[];
  totalQuestions: number;
  title: string;
  dueLocal: string;
  unitGrouping: "separate" | "merged";
  answerRelease: "on_submit" | "after_due";
  checkPending: boolean;
  checkError: string | null;
  checkHints: AssignmentCheckHint[];
  mutationError: string | null;
  pending: boolean;
  onTitleChange: (title: string) => void;
  onDueChange: (dueLocal: string) => void;
  onUnitGroupingChange: (grouping: "separate" | "merged") => void;
  onAnswerReleaseChange: (release: "on_submit" | "after_due") => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const dueHint = dueRelativeHint(dueLocal);
  const defaultTitle = defaultAssignmentTitle(
    selectedUnits.map((unit) => unit.title),
  );
  /** T2A.8：「截止后公布」必须先有截止时间——即时提示并阻止提交 */
  const releaseBlocked = answerRelease === "after_due" && dueLocal.length === 0;
  /** 单选行的样式（选中态与添加名单弹层同一视觉语言；公布时机/组合方式共用） */
  const optionClass = (selected: boolean): string =>
    `flex min-h-11 flex-1 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm outline-none select-none transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50 ${
      selected
        ? "border-primary/50 bg-primary/5"
        : "border-border hover:bg-muted/50"
    }`;

  return (
    <section aria-label="第③步 确认布置" className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
        <p className="text-sm">
          对象：
          {courseName !== null
            ? `课程「${courseName}」成员（已选 ${studentCount} 人）`
            : `不按课程（已选 ${studentCount} 人）`}
        </p>
        <p className="text-sm font-medium">
          作业内容（按作答顺序，共 {totalQuestions} 题）
        </p>
        <ol className="flex flex-col gap-1">
          {selectedUnits.map((unit, index) => (
            <li key={unit.unitId} className="text-sm text-muted-foreground">
              {index + 1}. {unit.title}（{unit.questionCount} 题）
            </li>
          ))}
        </ol>
      </div>

      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        {/* 组合方式（2026-10 产品决策：默认不合并）——每个单元一份（推荐，默认）/
            合并为一份；视觉语言与「答案公布时机」radio 组一致 */}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm">作业组合方式</legend>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className={optionClass(unitGrouping === "separate")}>
              <input
                type="radio"
                name="wizard-unit-grouping"
                className="mt-0.5 size-5 shrink-0 accent-[var(--color-primary)]"
                checked={unitGrouping === "separate"}
                onChange={() => onUnitGroupingChange("separate")}
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">每个单元一份作业（推荐）</span>
                <span className="text-xs text-muted-foreground">
                  学生端分别看到 {selectedUnits.length} 份作业，各自作答与交卷
                </span>
              </span>
            </label>
            <label className={optionClass(unitGrouping === "merged")}>
              <input
                type="radio"
                name="wizard-unit-grouping"
                className="mt-0.5 size-5 shrink-0 accent-[var(--color-primary)]"
                checked={unitGrouping === "merged"}
                onChange={() => onUnitGroupingChange("merged")}
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">合并为一份作业</span>
                <span className="text-xs text-muted-foreground">
                  所有单元合成一份试卷，一次作答一次交卷
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        <div className="flex flex-col gap-1.5">
          {unitGrouping === "separate" ? (
            <>
              <label htmlFor="wizard-title" className="text-sm">
                作业标题（留空时每份使用各自单元的标题）
              </label>
              <Input
                id="wizard-title"
                value={title}
                onChange={(e) => onTitleChange(e.target.value)}
                placeholder="填写后每份标题为「标题·单元名」，留空则用各单元自己的标题"
                maxLength={100}
              />
            </>
          ) : (
            <>
              <label htmlFor="wizard-title" className="text-sm">
                作业标题（留空使用默认标题）
              </label>
              <Input
                id="wizard-title"
                value={title}
                onChange={(e) => onTitleChange(e.target.value)}
                placeholder={`默认：${defaultTitle}`}
                maxLength={100}
              />
            </>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="wizard-due" className="text-sm">
            截止时间（可选，北京时间）
          </label>
          <Input
            id="wizard-due"
            type="datetime-local"
            value={dueLocal}
            onChange={(e) => onDueChange(e.target.value)}
          />
          {dueHint && (
            <p aria-live="polite" className="text-xs text-muted-foreground">
              {dueHint}
            </p>
          )}
        </div>

        {/* T2A.8（D11）答案公布时机：交卷即公布（默认）/ 截止后公布 */}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm">答案公布时机</legend>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className={optionClass(answerRelease === "on_submit")}>
              <input
                type="radio"
                name="wizard-answer-release"
                className="mt-0.5 size-5 shrink-0 accent-[var(--color-primary)]"
                checked={answerRelease === "on_submit"}
                onChange={() => onAnswerReleaseChange("on_submit")}
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">交卷即公布（默认）</span>
                <span className="text-xs text-muted-foreground">
                  学生交卷后立刻看到对错、参考答案与详解
                </span>
              </span>
            </label>
            <label className={optionClass(answerRelease === "after_due")}>
              <input
                type="radio"
                name="wizard-answer-release"
                className="mt-0.5 size-5 shrink-0 accent-[var(--color-primary)]"
                checked={answerRelease === "after_due"}
                onChange={() => onAnswerReleaseChange("after_due")}
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">截止后公布</span>
                <span className="text-xs text-muted-foreground">
                  截止时间前学生只见本人答案，截止后统一公布
                </span>
              </span>
            </label>
          </div>
          {releaseBlocked && (
            <p role="alert" className="text-xs text-destructive">
              选择「截止后公布」时必须先填写截止时间。
            </p>
          )}
        </fieldset>

        {/* D15 已做过提示（仅提示不阻止） */}
        {checkPending && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            正在检查名单学生在课程练习中的已做过记录…
          </p>
        )}
        {checkError !== null && (
          <p className="text-sm text-muted-foreground">
            已做过检查失败（{checkError}），不影响布置。
          </p>
        )}
        {checkHints.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-xl border border-amber-300/60 bg-amber-50 p-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
            <p className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-300">
              <TriangleAlert aria-hidden className="size-4 shrink-0" />
              以下学生已在课程练习中做过所选单元（已看过答案）。仅提示，不影响布置：
            </p>
            <ul className="flex flex-col gap-1 text-amber-800 dark:text-amber-300">
              {checkHints.map((hint) => (
                <li
                  key={`${hint.studentId}:${hint.courseId ?? "-"}:${hint.unitId}`}
                >
                  {checkHintLine(hint)}
                </li>
              ))}
            </ul>
          </div>
        )}

        {mutationError && (
          <p role="alert" className="text-sm text-destructive">
            {mutationError}
          </p>
        )}

        <Button
          type="submit"
          className="min-h-11 px-4"
          disabled={pending || releaseBlocked}
        >
          {pending ? (
            <>
              <Loader2 aria-hidden className="animate-spin" />
              正在布置…
            </>
          ) : unitGrouping === "separate" ? (
            <>
              <Plus aria-hidden />
              布置作业（{selectedUnits.length} 份 · 共 {totalQuestions} 题）
            </>
          ) : (
            <>
              <Plus aria-hidden />
              布置作业（{selectedUnits.length} 个单元 · {totalQuestions} 题）
            </>
          )}
        </Button>
      </form>
    </section>
  );
}
