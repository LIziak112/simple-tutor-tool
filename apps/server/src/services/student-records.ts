import type {
  StudentRecordRow,
  StudentRecordsData,
  StudentRecordsQuery,
} from "@tutor/contract";
import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Assignment,
  type Attempt,
  assignmentStudents,
  assignments,
  attempts,
} from "../db/schema";
import { answersReleased } from "./attempt-service";
import { requireVisibleCourseUnit } from "./course-service";
import { pendingMarkCounts } from "./pending-mark";
import { studentTeacherIdOf } from "./student-course-service";
import { sourceOf } from "./teacher-attempt-service";

/**
 * 学生「我的记录」业务层（T3.5，Phase3 清单 D10）——本人全部作答的索引 +
 * 筛选 + 分页。路由只做鉴权与查询校验，本模块承载：
 *
 * - 可见性（D10 口径，复用既有判定，不另写一套）：
 *   - **已交卷记录一律保留**（含已移出课程〔T2A D7〕、作业软删后的历史——
 *     §5.2「删除作业不删除已有作答记录」）；
 *   - **已失权的进行中草稿不列出**：
 *     - course 来源 draft：与续作接口同一道门 requireVisibleCourseUnit
 *       （D7/D22——移出成员/学生归档/课程归档 403、条目隐藏/未发布/资源删除
 *       404 的全部情形都算失权，try/catch 判定，口径永不漂移）；
 *     - assignment 来源 draft：与学生作业列表同一谓词（listStudentAssignments
 *       口径）——在册（assignmentStudents.removedAt IS NULL，D13）且作业未
 *       软删（deletedAt IS NULL）。作业软删同按移出处理：草稿失去正常入口
 *       （直连 /attempts/:id 仍可续作是 T5 归属即权限的既有口径，只是不再
 *       出现在索引里），已交卷历史照常保留。
 * - 筛选可任意组合：sourceType / courseId / assignmentId / status / from / to
 *   （时间范围按「最近活动时间」submittedAt ?? startedAt，与排序同一时间轴，
 *   D6/D10 同口径）；
 * - 排序：最近活动时间倒序（id 倒序兜底稳定）；分页 limit（默认 50，1–200）/
 *   offset，total 为筛选后（且剔除失权草稿后）的总条数；
 * - after_due 未公布（D10/D9）：得分与待批数置 null、answersReleased=false
 *   （前端显示「待公布」）；draft 行恒 answersReleased=true（无结果可公布，
 *   显示「进行中」）。
 *
 * 安全口径（AGENTS 第 3 条）：行数据全部来自 attempts 聚合列与来源名
 * （assignments.title / units.title / courses.title），不触碰 questions 的任何
 * 内容列；泄露测试见 routes/student-records.test.ts（assertNoLeak）。
 */

/** 最近活动时间排序/筛选键（D6/D10 同一口径：submittedAt ?? startedAt） */
const lastActivitySql = sql`coalesce(${attempts.submittedAt}, ${attempts.startedAt})`;

/**
 * assignment 来源 draft 是否仍可从正常入口到达（在册且作业未软删；
 * listStudentAssignments 同谓词）。assignmentId 异常空值按失权处理（防御）。
 */
function assignmentDraftReachable(
  db: Db,
  studentId: string,
  assignmentId: string | null,
): boolean {
  if (assignmentId === null) return false;
  const assignment: Pick<Assignment, "deletedAt"> | undefined = db
    .select({ deletedAt: assignments.deletedAt })
    .from(assignments)
    .where(eq(assignments.id, assignmentId))
    .get();
  if (assignment === undefined || assignment.deletedAt !== null) return false;
  return (
    db
      .select({ studentId: assignmentStudents.studentId })
      .from(assignmentStudents)
      .where(
        and(
          eq(assignmentStudents.assignmentId, assignmentId),
          eq(assignmentStudents.studentId, studentId),
          isNull(assignmentStudents.removedAt),
        ),
      )
      .get() !== undefined
  );
}

/**
 * 失权草稿的 attempt id 集合（见模块头注释的可见性口径）。
 * course 维度按 (courseId, unitId) 缓存 requireVisibleCourseUnit 的判定结果
 * （同组草稿不重复走门）；一个学生的草稿总量有限，全量扫描无压力。
 */
function lostAccessDraftIds(
  db: Db,
  studentId: string,
  now: Date | string,
): Set<string> {
  const drafts = db
    .select()
    .from(attempts)
    .where(and(eq(attempts.studentId, studentId), eq(attempts.status, "draft")))
    .all();
  const excluded = new Set<string>();
  const courseUnitVisible = new Map<string, boolean>();
  for (const draft of drafts) {
    if (draft.sourceType === "course") {
      const key = `${draft.courseId ?? ""}\n${draft.unitId ?? ""}`;
      const cached = courseUnitVisible.get(key);
      if (cached === undefined) {
        let visible = false;
        try {
          requireVisibleCourseUnit(
            db,
            studentId,
            draft.courseId ?? "",
            draft.unitId ?? "",
            now,
          );
          visible = true;
        } catch {
          // 403/404 都算失权（与续作接口同一道门；异常不外抛，仅用于索引过滤）
          visible = false;
        }
        courseUnitVisible.set(key, visible);
        if (!visible) excluded.add(draft.id);
      } else if (!cached) {
        excluded.add(draft.id);
      }
    } else if (!assignmentDraftReachable(db, studentId, draft.assignmentId)) {
      excluded.add(draft.id);
    }
  }
  return excluded;
}

/**
 * 学生记录索引（D10）。now 可注入（after_due 公布 gate 的定时测试；默认当前
 * 时刻——与结果视图一致读时比较，截止后下一次请求自动恢复真实得分）。
 */
export function listStudentRecords(
  db: Db,
  studentId: string,
  query: StudentRecordsQuery,
  now: Date | string = new Date(),
): StudentRecordsData {
  // 失权草稿先算出排除集（行级判定无法进主查询的 where，见函数头注释）
  const excluded = lostAccessDraftIds(db, studentId, now);

  const where = and(
    eq(attempts.studentId, studentId),
    excluded.size > 0 ? notInArray(attempts.id, [...excluded]) : undefined,
    query.sourceType !== undefined
      ? eq(attempts.sourceType, query.sourceType)
      : undefined,
    query.courseId !== undefined
      ? eq(attempts.courseId, query.courseId)
      : undefined,
    query.assignmentId !== undefined
      ? eq(attempts.assignmentId, query.assignmentId)
      : undefined,
    query.status !== undefined ? eq(attempts.status, query.status) : undefined,
    query.from !== undefined
      ? sql`${lastActivitySql} >= ${query.from}`
      : undefined,
    query.to !== undefined ? sql`${lastActivitySql} <= ${query.to}` : undefined,
  );

  const totalRow = db
    .select({ n: sql<number>`count(*)` })
    .from(attempts)
    .where(where)
    .get();
  const rows = db
    .select()
    .from(attempts)
    .where(where)
    .orderBy(desc(lastActivitySql), desc(attempts.id))
    .limit(query.limit)
    .offset(query.offset)
    .all();

  // 来源上下文与公布 gate 的输入（teacherId 域内读单元/题目元信息，T2B.5 D10）
  const teacherId = studentTeacherIdOf(db, studentId);
  const pendingByAttempt = pendingMarkCounts(db, rows);
  const assignmentIds = [
    ...new Set(
      rows
        .filter(
          (row) =>
            row.sourceType === "assignment" &&
            row.assignmentId !== null &&
            row.status !== "draft",
        )
        .map((row) => row.assignmentId as string),
    ),
  ];
  const assignmentById = new Map(
    assignmentIds.length > 0
      ? db
          .select({
            id: assignments.id,
            answerRelease: assignments.answerRelease,
            dueAt: assignments.dueAt,
          })
          .from(assignments)
          .where(inArray(assignments.id, assignmentIds))
          .all()
          .map((row) => [row.id, row] as const)
      : [],
  );

  const records: StudentRecordRow[] = rows.map((attempt: Attempt) => {
    // 公布 gate（T2A.8/D10）：只有 assignment 来源的已交卷记录可能受限；
    // course 恒交卷即公布，draft 无结果可公布（answersReleased=true，显示进行中）
    const assignmentRow =
      attempt.sourceType === "assignment" && attempt.status !== "draft"
        ? assignmentById.get(attempt.assignmentId ?? "")
        : undefined;
    const released =
      assignmentRow === undefined || answersReleased(assignmentRow, now);
    return {
      ...sourceOf(db, attempt, teacherId ?? ""),
      attemptId: attempt.id,
      status: attempt.status,
      // D2 展示口径 scoreFinal ?? scoreAuto；未公布置 null（显示「待公布」）
      score: released ? (attempt.scoreFinal ?? attempt.scoreAuto) : null,
      // D4 共享谓词（draft 恒 0）；未公布置 null（与 D9 结果视图同法）
      pendingCount: released
        ? attempt.status === "draft"
          ? 0
          : (pendingByAttempt.get(attempt.id) ?? 0)
        : null,
      answersReleased: released,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
    };
  });
  return { records, total: totalRow?.n ?? 0 };
}
