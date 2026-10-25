import type {
  StudentRecordRow,
  StudentRecordsData,
  StudentRecordsQuery,
} from "@tutor/contract";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Assignment,
  assignmentStudents,
  assignments,
  attempts,
} from "../db/schema";
import { answersReleased, assignmentReleaseByIds } from "./attempt-service";
import { requireVisibleCourseUnit } from "./course-service";
import {
  pendingMarkCounts,
  pendingSelfReviewCounts,
  practiceSubmittedCounts,
} from "./pending-mark";
import { practiceProtocolOf } from "./practice-workflow-wiring";
import { recordAnswerProgress } from "./record-answer-progress";
import { attemptResultCounts } from "./result-counts";
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
 *     - wrong / lesson 来源 draft 恒不失权（2026-10）：wrong 无课程/作业
 *       归属；lesson 作答永不失权（已开卷的作答记录恒可回看）——草稿照常
 *       列出、可续作（见 lostAccessDraftIds）。
 * - 筛选可任意组合：sourceType / courseId / assignmentId / status / from / to
 *   （时间范围按「最近活动时间」lastActivityAt / submittedAt / startedAt 的最大值，切换开始排序也不改变筛选含义，
 *   只影响本人记录索引）；
 * - 排序：默认最近有效作答倒序（开始时间、id 倒序兜底稳定），可按开始时间升降序；分页 limit（默认 50，1–200）/
 *   offset，total 为筛选后（且剔除失权草稿后）的总条数；
 * - after_due 未公布（D10/D9）：得分与待批数置 null、answersReleased=false
 *   （前端显示「待公布」）；draft 行恒 answersReleased=true（无结果可公布，
 *   显示「进行中」）。
 *
 * 安全口径（AGENTS 第 3 条）：行数据全部来自 attempts 聚合列与来源名
 * （assignments.title / units.title / courses.title），不触碰 questions 的任何
 * 内容列；泄露测试见 routes/student-records.test.ts（assertNoLeak）。
 */

/** 最近活动时间排序/筛选键（D6/D10 同一口径：lastActivityAt / submittedAt / startedAt 的最大值） */
const lastActivitySql = sql<string>`max(coalesce(${attempts.lastActivityAt}, ${attempts.startedAt}), coalesce(${attempts.submittedAt}, ${attempts.startedAt}))`;

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
 * wrong（2026-10）与 lesson（2026-10 讲练一体）恒不失权——wrong 无课程/作业
 * 归属；lesson 作答永不失权（契约 attemptSourceSchema lesson 注释：讲练页
 * 只经课程可见，但已开卷的作答记录恒可回看）——两者草稿照常列出、可续作。
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
    if (draft.sourceType === "wrong" || draft.sourceType === "lesson") {
      continue; // 错题重练/讲练作答不失权（草稿照常列出、可续作）
    }
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
    // 作废卷（2026-10 讲练随时重开）不入记录
    isNull(attempts.abandonedAt),
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
    .select({ ...getTableColumns(attempts), lastActivityAt: lastActivitySql })
    .from(attempts)
    .where(where)
    .orderBy(
      ...(query.sort === "started_asc"
        ? [asc(attempts.startedAt), asc(attempts.id)]
        : query.sort === "started_desc"
          ? [desc(attempts.startedAt), desc(attempts.id)]
          : [
              desc(lastActivitySql),
              desc(attempts.startedAt),
              desc(attempts.id),
            ]),
    )
    .limit(query.limit)
    .offset(query.offset)
    .all();

  // 来源上下文与公布 gate 的输入（teacherId 域内读单元/题目元信息，T2B.5 D10）
  const teacherId = studentTeacherIdOf(db, studentId);
  const pendingByAttempt = pendingMarkCounts(db, rows);
  // 待自评徽章（两线收敛接线：v2 记录行来源，改走 QM 口径批量谓词）
  const pendingSelfReviewByAttempt = pendingSelfReviewCounts(db, rows);
  const resultCounts = attemptResultCounts(db, rows);
  const answerProgress = recordAnswerProgress(db, rows);
  // M4-D3 进行中进度（§13）：只对 v1 新协议卷批量聚合行级已提交 n/N（一次分组
  // 查询，500 id 一块，与待批数同款模式）；协议判定走 practiceProtocolOf 单一谓词
  const v1Rows = rows.filter((row) => practiceProtocolOf(row) === "v1");
  const progressByAttempt = practiceSubmittedCounts(db, v1Rows);
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
  const assignmentById = assignmentReleaseByIds(db, assignmentIds);

  const records: StudentRecordRow[] = rows.map((attempt) => {
    // 公布 gate（T2A.8/D10）：只有 assignment 来源的已交卷记录可能受限；
    // course 恒交卷即公布，draft 无结果可公布（answersReleased=true，显示进行中）
    const assignmentRow =
      attempt.sourceType === "assignment" && attempt.status !== "draft"
        ? assignmentById.get(attempt.assignmentId ?? "")
        : undefined;
    const released =
      assignmentRow === undefined || answersReleased(assignmentRow, now);
    const progress = progressByAttempt.get(attempt.id);
    return {
      ...sourceOf(db, attempt, teacherId ?? ""),
      attemptId: attempt.id,
      status: attempt.status,
      // D2 展示口径 scoreFinal ?? scoreAuto；未公布置 null（显示「待公布」）
      score: released ? (attempt.scoreFinal ?? attempt.scoreAuto) : null,
      resultCounts: released ? (resultCounts.get(attempt.id) ?? null) : null,
      answerProgress: answerProgress.get(attempt.id) ?? null,
      // D4 共享谓词（2026-10 扩展：行级提交事实——lesson 单题提交与 M2 起
      // v1 新协议逐题提交——都会写行级 submittedAt，进行中卷的已提交行也计数；
      // 无行级提交事实的 legacy draft 不在 Map 中 → 0）；未公布置 null（与
      // D9 结果视图同法）
      pendingCount: released ? (pendingByAttempt.get(attempt.id) ?? 0) : null,
      pendingSelfReviewCount: released
        ? (pendingSelfReviewByAttempt.get(attempt.id) ?? 0)
        : null,
      answersReleased: released,
      lastActivityAt: attempt.lastActivityAt,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
      // M4-D3 进行中进度（§13）：仅 v1 新协议卷携带（draft 行级 n/N；已收尾
      // 卷整卷口径 n=N）；白名单纯公开进度计数，不含对错/得分/答案
      ...(progress !== undefined
        ? {
            practiceSubmittedCount: progress.submitted,
            practiceQuestionCount: progress.total,
          }
        : {}),
    };
  });
  return { records, total: totalRow?.n ?? 0 };
}
