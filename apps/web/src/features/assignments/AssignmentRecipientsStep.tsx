import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  useCourseDetail,
  useTeacherCourses,
} from "@/features/courses/course-queries";
import type { useStudents } from "@/features/students/student-queries";

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

export function AssignmentRecipientsStep({
  coursesQuery,
  studentsQuery,
  detailQuery,
  courseId,
  studentIds,
  loadingBase,
  refreshingRoster,
  rosterNotice,
  onCourseChange,
  onToggleStudent,
}: {
  coursesQuery: ReturnType<typeof useTeacherCourses>;
  studentsQuery: ReturnType<typeof useStudents>;
  detailQuery: ReturnType<typeof useCourseDetail>;
  courseId: string;
  studentIds: ReadonlySet<string>;
  loadingBase: boolean;
  refreshingRoster: boolean;
  rosterNotice: string | null;
  onCourseChange: (courseId: string) => void;
  onToggleStudent: (id: string, checked: boolean) => void;
}) {
  return (
    <section aria-label="第①步 选择对象" className="flex flex-col gap-4">
      {rosterNotice && (
        <p role="alert" className="text-sm text-destructive">
          {rosterNotice}
        </p>
      )}
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
                  {course.name}（
                  {course.id === courseId
                    ? (detailQuery.data?.members.length ?? course.memberCount)
                    : course.memberCount}{" "}
                  名成员）
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
          ) : detailQuery.isPending || refreshingRoster ? (
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
