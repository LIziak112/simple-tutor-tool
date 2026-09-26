import { randomUUID } from "node:crypto";
import type {
  AssignmentCreateRequest,
  AssignmentStatus,
  AssignmentStudent,
  AssignmentUpdateRequest,
  StudentAssignment,
  TeacherAssignment,
} from "@tutor/contract";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Assignment,
  assignmentStudents,
  assignments,
  questions,
  students,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";

/**
 * AssignmentService（T2.2）——作业与指派的业务层。
 * 路由只做「鉴权 → 校验 → 调 service → 包装响应」（api-endpoint 技能约定），本模块承载：
 * - 创建：unitId 必须存在、studentIds 逐个校验存在（去重）、title 缺省用单元标题；
 * - 更新：title / dueAt（显式 null 取消截止）/ studentIds（全量替换名单）；
 * - 删除：软删（deletedAt），不物理删除——已有作答经 assignmentId 关联历史，
 *   「作答保留、作业标记删除」（T2.6 建 attempts 表后回归验证）；
 * - 教师列表：默认不显示已删，includeDeleted=true 含删；每条带单元标题、题数、学生名单；
 * - 学生列表：仅本人被指派且未删除的作业，只含单元公开元信息（无答案/详解/提示）。
 *
 * 安全口径（AGENTS.md 第 3 条）：学生端条目只有 id/标题/单元元信息/题数/截止/状态，
 * 不触碰 questions 表的内容列（题数只做 COUNT，见 liveQuestionCounts）。
 */

/** 单个学生在一道作业下的作答摘要（T2.6 接入 attempts 表后由查询填充） */
export interface AssignmentAttemptSummary {
  /** attempts.status：draft=进行中、submitted=已交、graded=已批 */
  status: "draft" | "submitted" | "graded";
}

/**
 * 计算学生在某作业下的完成状态（§5.8 完成矩阵）。
 * 纯函数：输入作业 + 该学生相关的作答记录，按优先级 graded > submitted > draft > 无记录。
 * T2.2 阶段 attempts 表尚未创建，调用方恒传空数组（全部 not_started）；
 * T2.6 接入后由查询层取该学生该作业的全部 attempt 传入，本函数无需改动。
 */
export function computeAssignmentStatus(
  _assignment: Pick<Assignment, "id" | "dueAt">,
  attempts: readonly AssignmentAttemptSummary[],
): AssignmentStatus {
  // 优先级：已批 > 已交 > 进行中 > 未开始（先交后批时以批改结果为准）
  if (attempts.some((attempt) => attempt.status === "graded")) {
    return "graded";
  }
  if (attempts.some((attempt) => attempt.status === "submitted")) {
    return "submitted";
  }
  if (attempts.some((attempt) => attempt.status === "draft")) {
    return "in_progress";
  }
  return "not_started";
}

/** 按 id 取作业行，不存在 → 404 ASSIGNMENT_NOT_FOUND */
function requireAssignmentRow(db: Db, id: string): Assignment {
  const row = db.select().from(assignments).where(eq(assignments.id, id)).get();
  if (!row) {
    throw new HttpError(404, "ASSIGNMENT_NOT_FOUND", "作业不存在");
  }
  return row;
}

/** 校验学生 id 全部存在，任一不存在 → 404 STUDENT_NOT_FOUND */
function requireStudentsExist(db: Db, studentIds: readonly string[]): void {
  const found = new Set(
    db
      .select({ id: students.id })
      .from(students)
      .where(inArray(students.id, [...studentIds]))
      .all()
      .map((row) => row.id),
  );
  const missing = studentIds.find((id) => !found.has(id));
  if (missing !== undefined) {
    throw new HttpError(
      404,
      "STUDENT_NOT_FOUND",
      "指派名单中包含不存在的学生，请刷新学生列表后重试",
    );
  }
}

/** 每个单元的有效题目数（软删题目不计；只 COUNT，不读内容列，学生端同样安全） */
function liveQuestionCounts(db: Db): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of db
    .select({ unitId: questions.unitId })
    .from(questions)
    .where(isNull(questions.deletedAt))
    .all()) {
    counts.set(row.unitId, (counts.get(row.unitId) ?? 0) + 1);
  }
  return counts;
}

/** 每道作业的指派学生摘要（按姓名排序，展示口径稳定；库表无顺序列） */
function studentsByAssignment(db: Db): Map<string, AssignmentStudent[]> {
  const map = new Map<string, AssignmentStudent[]>();
  for (const row of db
    .select({
      assignmentId: assignmentStudents.assignmentId,
      id: students.id,
      displayName: students.displayName,
    })
    .from(assignmentStudents)
    .innerJoin(students, eq(assignmentStudents.studentId, students.id))
    .orderBy(asc(students.displayName))
    .all()) {
    const list = map.get(row.assignmentId);
    if (list === undefined) {
      map.set(row.assignmentId, [{ id: row.id, displayName: row.displayName }]);
    } else {
      list.push({ id: row.id, displayName: row.displayName });
    }
  }
  return map;
}

/** 作业行 + 单元标题 + 题数 + 名单 → 教师端摘要 */
function toTeacherAssignment(
  row: Assignment,
  unitTitle: string,
  questionCount: number,
  studentList: AssignmentStudent[],
): TeacherAssignment {
  return {
    id: row.id,
    unitId: row.unitId,
    unitTitle,
    title: row.title,
    dueAt: row.dueAt,
    questionCount,
    students: studentList,
    deleted: row.deletedAt != null,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
  };
}

/** 组装单条作业的教师摘要（单元标题取当前值，缺单元时兜底空串由调用方保证不发生） */
function teacherAssignmentOf(db: Db, id: string): TeacherAssignment {
  const row = requireAssignmentRow(db, id);
  const unit = db
    .select({ title: units.title })
    .from(units)
    .where(eq(units.id, row.unitId))
    .get();
  return toTeacherAssignment(
    row,
    unit?.title ?? row.title,
    liveQuestionCounts(db).get(row.unitId) ?? 0,
    studentsByAssignment(db).get(row.id) ?? [],
  );
}

// ---------- 教师：布置作业 CRUD ----------

/**
 * POST /api/teacher/assignments。
 * - unitId 不存在 → 404 UNIT_NOT_FOUND；
 * - studentIds 去重后逐个校验存在（空数组已被契约 min(1) 拦截）；
 * - title 缺省用单元标题（快照语义：之后单元改名不联动已布置作业的标题）；
 * - dueAt 原样存 UTC ISO（契约已校验格式）。
 */
export function createAssignment(
  db: Db,
  request: AssignmentCreateRequest,
): TeacherAssignment {
  const unit = db
    .select({ id: units.id, title: units.title })
    .from(units)
    .where(eq(units.id, request.unitId))
    .get();
  if (!unit) {
    throw new HttpError(404, "UNIT_NOT_FOUND", "指定的练习单元不存在");
  }
  const studentIds = [...new Set(request.studentIds)];
  requireStudentsExist(db, studentIds);

  const id = randomUUID();
  db.transaction((tx) => {
    tx.insert(assignments)
      .values({
        id,
        unitId: unit.id,
        title: request.title ?? unit.title,
        dueAt: request.dueAt ?? null,
        deletedAt: null,
        createdAt: new Date().toISOString(),
      })
      .run();
    for (const studentId of studentIds) {
      tx.insert(assignmentStudents)
        .values({ assignmentId: id, studentId })
        .run();
    }
  });
  return teacherAssignmentOf(db, id);
}

/**
 * PATCH /api/teacher/assignments/:id。全部字段可选（缺省 = 不改）：
 * - title：改标题；dueAt：改截止，显式 null = 取消截止；
 * - studentIds：全量替换名单（先删后插；替换后名单外学生端立即不可见）。
 * 已删除的作业视为不存在（404，与软删题目的编辑口径一致）。
 */
export function updateAssignment(
  db: Db,
  id: string,
  request: AssignmentUpdateRequest,
): TeacherAssignment {
  const row = requireAssignmentRow(db, id);
  if (row.deletedAt !== null) {
    throw new HttpError(
      404,
      "ASSIGNMENT_NOT_FOUND",
      "作业不存在（可能已被删除）",
    );
  }

  const studentIds =
    request.studentIds !== undefined
      ? [...new Set(request.studentIds)]
      : undefined;
  if (studentIds !== undefined) {
    requireStudentsExist(db, studentIds);
  }

  db.transaction((tx) => {
    const patch: Partial<typeof assignments.$inferInsert> = {};
    if (request.title !== undefined) patch.title = request.title;
    if (request.dueAt !== undefined) patch.dueAt = request.dueAt;
    if (Object.keys(patch).length > 0) {
      tx.update(assignments).set(patch).where(eq(assignments.id, id)).run();
    }
    if (studentIds !== undefined) {
      tx.delete(assignmentStudents)
        .where(eq(assignmentStudents.assignmentId, id))
        .run();
      for (const studentId of studentIds) {
        tx.insert(assignmentStudents)
          .values({ assignmentId: id, studentId })
          .run();
      }
    }
  });
  return teacherAssignmentOf(db, id);
}

/**
 * DELETE /api/teacher/assignments/:id：软删（deletedAt 置当前时间）。
 * 已指派学生端立即不可见；教师列表默认不显示（includeDeleted=true 可见）。
 * 关联的 assignment_students 行保留（软删不物理删除任何数据，
 * T2.6 起作答记录经 assignmentId 继续关联，验收项「作答保留」在该任务回归）。
 * 重复删除幂等成功。
 */
export function deleteAssignment(db: Db, id: string): void {
  const row = db
    .select({ id: assignments.id, deletedAt: assignments.deletedAt })
    .from(assignments)
    .where(eq(assignments.id, id))
    .get();
  if (!row) {
    throw new HttpError(404, "ASSIGNMENT_NOT_FOUND", "作业不存在");
  }
  if (row.deletedAt !== null) return; // 幂等：重复删除同样成功
  db.update(assignments)
    .set({ deletedAt: new Date().toISOString() })
    .where(eq(assignments.id, id))
    .run();
}

/**
 * GET /api/teacher/assignments：按创建时间倒序。
 * 默认只列未删除；includeDeleted=true 时含已删（deleted=true + deletedAt）。
 */
export function listTeacherAssignments(
  db: Db,
  includeDeleted: boolean,
): { assignments: TeacherAssignment[] } {
  const rows = db
    .select()
    .from(assignments)
    .where(includeDeleted ? undefined : isNull(assignments.deletedAt))
    .orderBy(desc(assignments.createdAt))
    .all();
  if (rows.length === 0) return { assignments: [] };

  const unitTitles = new Map(
    db
      .select({ id: units.id, title: units.title })
      .from(units)
      .all()
      .map((row) => [row.id, row.title] as const),
  );
  const counts = liveQuestionCounts(db);
  const nameLists = studentsByAssignment(db);

  return {
    assignments: rows.map((row) =>
      toTeacherAssignment(
        row,
        unitTitles.get(row.unitId) ?? row.title,
        counts.get(row.unitId) ?? 0,
        nameLists.get(row.id) ?? [],
      ),
    ),
  };
}

// ---------- 学生端：我的作业 ----------

/**
 * GET /api/student/assignments：仅本人被指派（assignment_students 命中）且未删除的作业。
 * 每条只含单元公开元信息 + 完成状态；按布置时间倒序。
 * 状态经 computeAssignmentStatus 计算——T2.2 阶段作答表（attempts）尚未创建，
 * 恒为 not_started；T2.6 接入后在此处查询该学生的 attempts 传入纯函数即可。
 */
export function listStudentAssignments(
  db: Db,
  studentId: string,
): { assignments: StudentAssignment[] } {
  const rows = db
    .select({
      id: assignments.id,
      title: assignments.title,
      dueAt: assignments.dueAt,
      createdAt: assignments.createdAt,
      unitId: units.id,
      unitTitle: units.title,
      topic: units.topic,
    })
    .from(assignments)
    .innerJoin(
      assignmentStudents,
      eq(assignmentStudents.assignmentId, assignments.id),
    )
    .innerJoin(units, eq(assignments.unitId, units.id))
    .where(
      and(
        eq(assignmentStudents.studentId, studentId),
        isNull(assignments.deletedAt),
      ),
    )
    .orderBy(desc(assignments.createdAt))
    .all();
  if (rows.length === 0) return { assignments: [] };

  const counts = liveQuestionCounts(db);
  return {
    assignments: rows.map((row) => ({
      id: row.id,
      title: row.title,
      unitId: row.unitId,
      unitTitle: row.unitTitle,
      topic: row.topic,
      questionCount: counts.get(row.unitId) ?? 0,
      dueAt: row.dueAt,
      createdAt: row.createdAt,
      status: computeAssignmentStatus(
        { id: row.id, dueAt: row.dueAt },
        // T2.6 起：查询该学生该作业的 attempts 摘要传入（见函数注释）
        [],
      ),
    })),
  };
}
