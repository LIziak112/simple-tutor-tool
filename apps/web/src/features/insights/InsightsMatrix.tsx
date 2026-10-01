import type {
  AnalyticsAssignmentCell,
  AnalyticsCellStatus,
  AnalyticsMatrix,
  AnalyticsUnitCell,
} from "@tutor/contract";
import { Link } from "react-router";
import { CELL_STATUS_LABELS } from "./insights-format";

/**
 * 完成矩阵（T4.2，D2）：学生 × 布置的作业 + 可见课程单元。
 * - 五状态徽章分色（not-assigned 渲染「—」——未指派不是没完成）；
 * - 课程单元列显示做过次数与首次得分（D2），重做/待批为附加行；
 * - 作业格有 attempt 时整格可点跳作答详情（触控 ≥44px）；
 * - 学生名链接画像页（携带当前筛选 query，返回不丢上下文）；
 * - 矩阵是当下状态一览，**不受时间范围影响**（契约 D5 注释），页面注明；
 * - 横向滚动容纳多列（一对一规模可控），首列粘性跟随。
 */

/** 状态徽章配色（进行中实心蓝显著，同作答列表 STATUS_BADGE_CLASS 族） */
const CELL_BADGE_CLASS: Record<AnalyticsCellStatus, string> = {
  "not-assigned": "text-muted-foreground",
  "not-started": "bg-muted text-muted-foreground",
  "in-progress": "bg-sky-500 font-medium text-white",
  submitted: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  graded: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};

/** 单元格状态徽章（not-assigned 只渲染「—」） */
function CellStatusBadge({ status }: { status: AnalyticsCellStatus }) {
  if (status === "not-assigned") {
    return (
      <span
        title="该学生不在名单 / 不是课程成员"
        className="text-muted-foreground"
      >
        —
      </span>
    );
  }
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs whitespace-nowrap ${CELL_BADGE_CLASS[status]}`}
    >
      {CELL_STATUS_LABELS[status]}
    </span>
  );
}

/** 矩阵 props（query 供学生名链接携带筛选上下文） */
export interface InsightsMatrixProps {
  matrix: AnalyticsMatrix;
  /** 画像链接附加的 URL query（如 ?days=7&courseId=…） */
  studentQuery?: string;
}

/**
 * 完成矩阵表。单元格稠密数组先转 Map（studentId × 列 key），
 * 渲染 O(行 × 列) 查找。
 */
export function InsightsMatrix({
  matrix,
  studentQuery = "",
}: InsightsMatrixProps) {
  const assignmentCells = new Map<string, AnalyticsAssignmentCell>();
  const unitCells = new Map<string, AnalyticsUnitCell>();
  for (const cell of matrix.cells) {
    if (cell.kind === "assignment") {
      assignmentCells.set(`${cell.studentId}:${cell.assignmentId}`, cell);
    } else {
      unitCells.set(`${cell.studentId}:${cell.courseId}:${cell.unitId}`, cell);
    }
  }

  if (
    matrix.students.length === 0 &&
    matrix.assignmentColumns.length === 0 &&
    matrix.unitColumns.length === 0
  ) {
    return (
      <p className="rounded-xl border border-dashed border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
        还没有学生、作业或课程单元可生成矩阵。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            学生完成矩阵：行为学生，列为布置的作业与可见课程单元
          </caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th
                scope="col"
                className="sticky left-0 z-10 bg-card px-3 py-2 font-medium"
              >
                学生
              </th>
              {matrix.assignmentColumns.length > 0 && (
                <th
                  scope="colgroup"
                  colSpan={matrix.assignmentColumns.length}
                  className="px-3 py-2 font-medium"
                >
                  作业
                </th>
              )}
              {matrix.unitColumns.length > 0 && (
                <th
                  scope="colgroup"
                  colSpan={matrix.unitColumns.length}
                  className="px-3 py-2 font-medium"
                >
                  课程单元
                </th>
              )}
            </tr>
            <tr className="border-b border-border text-left">
              <th scope="col" className="sr-only">
                学生姓名
              </th>
              {matrix.assignmentColumns.map((column) => (
                <th
                  key={column.assignmentId}
                  scope="col"
                  className="min-w-28 px-3 py-2 align-bottom"
                >
                  <p className="font-medium whitespace-nowrap">
                    {column.title}
                  </p>
                  <p className="text-xs font-normal text-muted-foreground">
                    {column.courseName ?? "未挂课程"}
                  </p>
                </th>
              ))}
              {matrix.unitColumns.map((column) => (
                <th
                  key={`${column.courseId}:${column.unitId}`}
                  scope="col"
                  className="min-w-32 px-3 py-2 align-bottom"
                >
                  <p className="font-medium whitespace-nowrap">
                    {column.unitTitle}
                  </p>
                  <p className="text-xs font-normal text-muted-foreground">
                    {column.courseName}
                  </p>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.students.map((student) => (
              <tr
                key={student.studentId}
                className="border-b border-border last:border-b-0"
              >
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-normal"
                >
                  <Link
                    to={{
                      pathname: `/t/insights/students/${student.studentId}`,
                      search: studentQuery,
                    }}
                    className="flex min-h-11 items-center font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {student.displayName}
                    {student.archived && (
                      <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                        已归档
                      </span>
                    )}
                  </Link>
                </th>
                {matrix.assignmentColumns.map((column) => {
                  const cell = assignmentCells.get(
                    `${student.studentId}:${column.assignmentId}`,
                  );
                  return (
                    <td key={column.assignmentId} className="px-3 py-1.5">
                      {cell !== undefined && cell.attemptId !== null ? (
                        <Link
                          to={`/t/data/attempts/${cell.attemptId}`}
                          aria-label={`查看 ${student.displayName} 的「${column.title}」作答详情`}
                          className="inline-flex min-h-11 min-w-20 items-center justify-center rounded-lg outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          <CellStatusBadge status={cell.status} />
                        </Link>
                      ) : (
                        <span className="inline-flex min-h-11 min-w-20 items-center justify-center">
                          <CellStatusBadge
                            status={cell?.status ?? "not-assigned"}
                          />
                        </span>
                      )}
                    </td>
                  );
                })}
                {matrix.unitColumns.map((column) => {
                  const cell = unitCells.get(
                    `${student.studentId}:${column.courseId}:${column.unitId}`,
                  );
                  return (
                    <td
                      key={`${column.courseId}:${column.unitId}`}
                      className="px-3 py-1.5 align-middle"
                    >
                      {cell === undefined ? (
                        <span className="inline-flex min-h-11 items-center text-muted-foreground">
                          —
                        </span>
                      ) : (
                        <div className="flex min-h-11 flex-col items-start justify-center gap-0.5 py-1">
                          <CellStatusBadge status={cell.status} />
                          <p className="text-xs text-muted-foreground whitespace-nowrap">
                            做过 {cell.attemptCount} 次 · 首次{" "}
                            {cell.firstScore === null
                              ? "—"
                              : `${cell.firstScore} 分`}
                          </p>
                          {(cell.redoCount > 0 || cell.pendingCount > 0) && (
                            <p className="flex gap-1.5 text-xs whitespace-nowrap">
                              {cell.redoCount > 0 && (
                                <span className="text-violet-700 dark:text-violet-300">
                                  重做 {cell.redoCount}
                                </span>
                              )}
                              {cell.pendingCount > 0 && (
                                <span className="text-amber-700 dark:text-amber-300">
                                  待批 {cell.pendingCount}
                                </span>
                              )}
                            </p>
                          )}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        矩阵是当下状态一览（谁还没做），不受时间范围影响；「—」表示未指派该 作业
        / 未加入该课程。点击已开卷的作业格可查看对应作答详情。
      </p>
    </div>
  );
}
