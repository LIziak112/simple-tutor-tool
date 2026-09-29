import { randomUUID } from "node:crypto";
import type {
  AssignmentCheckData,
  AssignmentCheckRequest,
  AssignmentCreateRequest,
  AssignmentDetailData,
  AssignmentStatus,
  AssignmentUpdateRequest,
  QuestionPublic,
  StudentAssignment,
  StudentPaperData,
  TeacherAssignment,
  TeacherAssignmentUnit,
} from "@tutor/contract";
import { defaultAssignmentTitle, questionPublicSchema } from "@tutor/contract";
import { publicStemMd } from "@tutor/md-dsl";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Assignment,
  type Attempt,
  assignmentStudents,
  assignments,
  assignmentUnits,
  attempts,
  courseStudents,
  courses,
  knowledgePoints,
  type Question as QuestionRow,
  questionKnowledge,
  questions,
  students,
  units,
} from "../db/schema";
import { getSingleTeacherId } from "../db/teacher-scope";
import { HttpError } from "../lib/http-error";

/**
 * AssignmentService（T2.2；T2A.7 大改——多单元 + 按课程布置 + 名单增删 + 内容锁定；
 * T2A.8 追加 answerRelease 公布时机：create/PATCH 与 dueAt 的组合校验防死锁态，
 * 列表/详情/创建/更新响应带出该字段）。
 * 路由只做「鉴权 → 校验 → 调 service → 包装响应」（api-endpoint 技能约定），本模块承载：
 *
 * - 创建（D12/D13）：unitIds 全部存在、不可重复、按数组顺序写 assignment_units
 *   （order=0..n-1）；courseId 可选（不存在 404）；studentIds 去重逐个校验存在；
 *   title 缺省 = 首个单元标题（1 个）或「首个单元标题 等 n 个单元」（≥2，快照语义）；
 * - 更新（D13/D14）：title/dueAt 恒可改；unitIds 整组替换但**已有任一 attempt 即锁定**
 *   （409 ASSIGNMENT_CONTENT_LOCKED）；名单增量增删（addStudentIds upsert 行、
 *   removeStudentIds 置 removedAt——移出已开始学生须 confirmStarted，否则
 *   409 CONFIRM_REQUIRED 并附 _students 名单）；add/remove 交集 400；
 * - checkAssignment（D15）：学生×单元在课程练习中的**已交卷**次数提示（仅提示不阻止）；
 * - 教师列表：courseId 筛选（UUID / "none"）+ includeDeleted；聚合单元列表
 *   （含软删标记、live 题数）、总题数、containsDeletedUnit、locked（∃ attempt）、
 *   名单四态统计与课程名；
 * - 详情：列表口径 + roster（在册，按 addedAt 后姓名排序）+ startedCount + courseNewMembers；
 * - 学生列表：仅本人**在册**（removedAt IS NULL）且未删除的作业，多单元聚合；
 * - 学生试卷（T2.4；T2A.7 分组化）：按 assignment_units.order 逐单元公开题目分组，
 *   live 题数为 0 的单元跳过（题目全被软删/清空；单元软删本身不影响出卷，D16）。
 *
 * 安全口径（AGENTS.md 第 3 条）：学生端条目只有 id/标题/单元元信息/题数/截止/状态，
 * 不触碰 questions 表的内容列（题数只做 COUNT，见 liveQuestionCounts）；题目本体仅经
 * getStudentAssignmentPaper 以 QuestionPublic 形态下发（无答案/详解/提示内容）。
 */

/** 单个学生在一道作业下的作答摘要（列表/详情四态统计由查询填充） */
export interface AssignmentAttemptSummary {
  /** attempts.status：draft=进行中、submitted=已交、graded=已批 */
  status: "draft" | "submitted" | "graded";
}

/**
 * 计算学生在某作业下的完成状态（§5.8 完成矩阵）。
 * 纯函数：输入作业 + 该学生相关的作答记录，按优先级 graded > submitted > draft > 无记录。
 */
export function computeAssignmentStatus(
  _assignment: Pick<Assignment, "id" | "dueAt">,
  attemptsOfStudent: readonly AssignmentAttemptSummary[],
): AssignmentStatus {
  // 优先级：已批 > 已交 > 进行中 > 未开始（先交后批时以批改结果为准）
  if (attemptsOfStudent.some((attempt) => attempt.status === "graded")) {
    return "graded";
  }
  if (attemptsOfStudent.some((attempt) => attempt.status === "submitted")) {
    return "submitted";
  }
  if (attemptsOfStudent.some((attempt) => attempt.status === "draft")) {
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

/**
 * 校验单元 id 列表：全部存在（否则 404 UNIT_NOT_FOUND）且不可重复
 * （否则 400 DUPLICATE_UNIT，D12）。返回按输入顺序的 (id, title) 列表。
 */
function requireUnitsUniqueExist(
  db: Db,
  unitIds: readonly string[],
): { id: string; title: string }[] {
  const seen = new Set<string>();
  for (const unitId of unitIds) {
    if (seen.has(unitId)) {
      throw new HttpError(
        400,
        "DUPLICATE_UNIT",
        "同一作业中练习单元不可重复，请调整后重试",
      );
    }
    seen.add(unitId);
  }
  const rows = db
    .select({ id: units.id, title: units.title })
    .from(units)
    .where(inArray(units.id, [...seen]))
    .all();
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const ordered: { id: string; title: string }[] = [];
  for (const unitId of unitIds) {
    const row = byId.get(unitId);
    if (row === undefined) {
      throw new HttpError(
        404,
        "UNIT_NOT_FOUND",
        "所选练习单元不存在，请刷新内容后重试",
      );
    }
    ordered.push(row);
  }
  return ordered;
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

/**
 * 作业 → 有序列单元行（assignment_units.order 升序，join units 取当前标题与
 * 软删标记；D16：软删单元行保留）。一次查询取全部作业，供列表/详情共用。
 */
function unitRowsByAssignment(
  db: Db,
  assignmentIds?: readonly string[],
): Map<string, { unitId: string; title: string; deleted: boolean }[]> {
  const map = new Map<
    string,
    { unitId: string; title: string; deleted: boolean }[]
  >();
  const rows =
    assignmentIds !== undefined && assignmentIds.length === 0
      ? []
      : db
          .select({
            assignmentId: assignmentUnits.assignmentId,
            unitId: assignmentUnits.unitId,
            title: units.title,
            unitDeletedAt: units.deletedAt,
            order: assignmentUnits.order,
          })
          .from(assignmentUnits)
          .innerJoin(units, eq(assignmentUnits.unitId, units.id))
          .where(
            assignmentIds !== undefined
              ? inArray(assignmentUnits.assignmentId, [...assignmentIds])
              : undefined,
          )
          .orderBy(asc(assignmentUnits.order), asc(assignmentUnits.unitId))
          .all();
  for (const row of rows) {
    const list = map.get(row.assignmentId);
    const entry = {
      unitId: row.unitId,
      title: row.title,
      deleted: row.unitDeletedAt !== null,
    };
    if (list === undefined) map.set(row.assignmentId, [entry]);
    else list.push(entry);
  }
  return map;
}

/** 在册名单行（removedAt IS NULL；join students 取姓名），按 addedAt 后姓名排序 */
function rosterRowsByAssignment(
  db: Db,
  assignmentIds?: readonly string[],
): Map<string, { studentId: string; displayName: string; addedAt: string }[]> {
  const map = new Map<
    string,
    { studentId: string; displayName: string; addedAt: string }[]
  >();
  const rows =
    assignmentIds !== undefined && assignmentIds.length === 0
      ? []
      : db
          .select({
            assignmentId: assignmentStudents.assignmentId,
            studentId: students.id,
            displayName: students.displayName,
            addedAt: assignmentStudents.addedAt,
          })
          .from(assignmentStudents)
          .innerJoin(students, eq(assignmentStudents.studentId, students.id))
          .where(
            and(
              isNull(assignmentStudents.removedAt),
              assignmentIds !== undefined
                ? inArray(assignmentStudents.assignmentId, [...assignmentIds])
                : undefined,
            ),
          )
          .orderBy(asc(assignmentStudents.addedAt), asc(students.displayName))
          .all();
  for (const row of rows) {
    const list = map.get(row.assignmentId);
    const entry = {
      studentId: row.studentId,
      displayName: row.displayName,
      addedAt: row.addedAt ?? "",
    };
    if (list === undefined) map.set(row.assignmentId, [entry]);
    else list.push(entry);
  }
  return map;
}

/**
 * 各作业下的 attempt 归组（assignmentId → (studentId → status 列表)）。
 * course 来源 assignmentId 为 null 天然不进组；用于 locked 判定与四态统计。
 */
function attemptGroupsByAssignment(
  db: Db,
): Map<string, Map<string, AssignmentAttemptSummary[]>> {
  const map = new Map<string, Map<string, AssignmentAttemptSummary[]>>();
  for (const row of db
    .select({
      assignmentId: attempts.assignmentId,
      studentId: attempts.studentId,
      status: attempts.status,
    })
    .from(attempts)
    .where(isNotNull(attempts.assignmentId))
    .all()) {
    const assignmentId = row.assignmentId;
    if (assignmentId === null) continue;
    const byStudent = map.get(assignmentId) ?? new Map();
    const list = byStudent.get(row.studentId) ?? [];
    list.push({ status: row.status });
    byStudent.set(row.studentId, list);
    map.set(assignmentId, byStudent);
  }
  return map;
}

/** 该作业是否存在任一 attempt（D14 内容锁定判定；含已移出学生的历史 attempt） */
function hasAttempt(db: Db, assignmentId: string): boolean {
  return (
    db
      .select({ id: attempts.id })
      .from(attempts)
      .where(eq(attempts.assignmentId, assignmentId))
      .get() !== undefined
  );
}

/** 学生 id → 姓名（CONFIRM_REQUIRED 附带名单、check 提示行共用） */
function studentNamesById(db: Db): Map<string, string> {
  return new Map(
    db
      .select({ id: students.id, displayName: students.displayName })
      .from(students)
      .all()
      .map((row) => [row.id, row.displayName] as const),
  );
}

/** 作业行 → 教师端列表行（聚合数据由调用方预取传入；courseName 取当前值） */
function toTeacherAssignment(
  row: Assignment,
  unitLists: Map<string, { unitId: string; title: string; deleted: boolean }[]>,
  liveCounts: Map<string, number>,
  rosters: Map<
    string,
    { studentId: string; displayName: string; addedAt: string }[]
  >,
  attemptGroups: Map<string, Map<string, AssignmentAttemptSummary[]>>,
  courseNames: Map<string, string>,
): TeacherAssignment {
  const unitList = unitLists.get(row.id) ?? [];
  const unitsOf: TeacherAssignmentUnit[] = unitList.map((unit) => ({
    unitId: unit.unitId,
    title: unit.title,
    questionCount: liveCounts.get(unit.unitId) ?? 0,
    deleted: unit.deleted,
  }));
  const roster = rosters.get(row.id) ?? [];
  const attemptsByStudent = attemptGroups.get(row.id) ?? new Map();
  const stats = { notStarted: 0, inProgress: 0, submitted: 0, graded: 0 };
  for (const entry of roster) {
    const status = computeAssignmentStatus(
      { id: row.id, dueAt: row.dueAt },
      attemptsByStudent.get(entry.studentId) ?? [],
    );
    if (status === "not_started") stats.notStarted += 1;
    else if (status === "in_progress") stats.inProgress += 1;
    else if (status === "submitted") stats.submitted += 1;
    else stats.graded += 1;
  }
  return {
    id: row.id,
    courseId: row.courseId,
    courseName:
      row.courseId !== null ? (courseNames.get(row.courseId) ?? null) : null,
    title: row.title,
    dueAt: row.dueAt,
    answerRelease: row.answerRelease,
    units: unitsOf,
    totalQuestionCount: unitsOf.reduce(
      (sum, unit) => sum + unit.questionCount,
      0,
    ),
    containsDeletedUnit: unitsOf.some((unit) => unit.deleted),
    locked: attemptsByStudent.size > 0,
    studentCount: roster.length,
    rosterStats: stats,
    deleted: row.deletedAt !== null,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
  };
}

/** 组装单条作业的教师列表行（详情在其上 extend） */
function teacherAssignmentOf(db: Db, id: string): TeacherAssignment {
  const row = requireAssignmentRow(db, id);
  return toTeacherAssignment(
    row,
    unitRowsByAssignment(db, [id]),
    liveQuestionCounts(db),
    rosterRowsByAssignment(db, [id]),
    attemptGroupsByAssignment(db),
    new Map(
      db
        .select({ id: courses.id, title: courses.title })
        .from(courses)
        .all()
        .map((r) => [r.id, r.title] as const),
    ),
  );
}

// ---------- 教师：布置作业 CRUD ----------

/**
 * POST /api/teacher/assignments（T2A.7 多单元 + 课程）。
 * - unitIds 重复 → 400 DUPLICATE_UNIT；任一不存在 → 404 UNIT_NOT_FOUND；
 * - courseId 提供且不存在 → 404 COURSE_NOT_FOUND；
 * - studentIds 去重后逐个校验存在（空数组已被契约 min(1) 拦截）；
 * - title 缺省 = defaultAssignmentTitle（快照语义：之后单元改名不联动）；
 * - answerRelease（T2A.8，D11）：公布时机，默认 on_submit；选 after_due 而
 *   dueAt 缺失 → 400 VALIDATION_ERROR（防死锁态：永不公布）；
 * - 事务写 assignments（unitId=null——旧列 @deprecated，新代码不写）+
 *   assignment_units（order=0..n-1）+ 名单行（addedAt=now，removedAt=null）。
 */
export function createAssignment(
  db: Db,
  request: AssignmentCreateRequest,
): TeacherAssignment {
  const unitList = requireUnitsUniqueExist(db, request.unitIds);
  if (request.courseId !== null && request.courseId !== undefined) {
    const course = db
      .select({ id: courses.id })
      .from(courses)
      .where(eq(courses.id, request.courseId))
      .get();
    if (course === undefined) {
      throw new HttpError(404, "COURSE_NOT_FOUND", "指定的课程不存在");
    }
  }
  const studentIds = [...new Set(request.studentIds)];
  requireStudentsExist(db, studentIds);
  // T2A.8（D11）：「截止后公布」必须设置截止时间（防死锁态：永不公布）
  if (request.answerRelease === "after_due" && request.dueAt === undefined) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "答案公布时机为「截止后公布」时，必须同时设置截止时间",
    );
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const teacherId = getSingleTeacherId(db);
  db.transaction((tx) => {
    tx.insert(assignments)
      .values({
        id,
        teacherId,
        unitId: null,
        courseId: request.courseId ?? null,
        title:
          request.title ?? defaultAssignmentTitle(unitList.map((u) => u.title)),
        dueAt: request.dueAt ?? null,
        answerRelease: request.answerRelease ?? "on_submit",
        deletedAt: null,
        createdAt: now,
      })
      .run();
    unitList.forEach((unit, index) => {
      tx.insert(assignmentUnits)
        .values({ assignmentId: id, unitId: unit.id, order: index })
        .run();
    });
    for (const studentId of studentIds) {
      tx.insert(assignmentStudents)
        .values({ assignmentId: id, studentId, addedAt: now, removedAt: null })
        .run();
    }
  });
  return teacherAssignmentOf(db, id);
}

/**
 * PATCH /api/teacher/assignments/:id（T2A.7 增量语义）。全部字段可选（缺省 = 不改）：
 * - title：改标题；dueAt：改截止，显式 null = 取消截止；
 * - unitIds：**先判锁定**（任一 attempt → 409 ASSIGNMENT_CONTENT_LOCKED，D14），
 *   再同 create 校验并整组替换 assignment_units；
 * - addStudentIds：校验存在；命中名单行（含曾移出的）→ removedAt=null、addedAt=now，
 *   否则插入新行；
 * - removeStudentIds：校验存在且当前在册；其中已开始作答（有该作业 attempt）者
 *   未带 confirmStarted → 409 CONFIRM_REQUIRED（错误壳附 _students 姓名，供确认弹层）；
 * - addStudentIds 与 removeStudentIds 交集 → 400 VALIDATION_ERROR；
 * - answerRelease（T2A.8）：改公布时机；与 dueAt 的组合校验见函数内注释。
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

  const addIds =
    request.addStudentIds !== undefined && request.addStudentIds.length > 0
      ? [...new Set(request.addStudentIds)]
      : undefined;
  const removeIds =
    request.removeStudentIds !== undefined &&
    request.removeStudentIds.length > 0
      ? [...new Set(request.removeStudentIds)]
      : undefined;

  // 同一学生不允许同时新增与移出（语义矛盾）
  if (addIds !== undefined && removeIds !== undefined) {
    const removeSet = new Set(removeIds);
    if (addIds.some((studentId) => removeSet.has(studentId))) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        "同一学生不能同时出现在新增与移出名单中",
      );
    }
  }

  // T2A.8（D11）：公布时机与截止时间的组合校验（按「改后状态」判断，防死锁态：
  // after_due 却无截止 → 永不公布）。覆盖三种情况：无截止直接改 after_due、
  // after_due 下把 dueAt 显式置 null、after_due 下去掉截止（配合发布语义二选一时
  // 由前端先改回 on_submit，服务端只认组合结果）。
  const nextAnswerRelease = request.answerRelease ?? row.answerRelease;
  const nextDueAt = request.dueAt !== undefined ? request.dueAt : row.dueAt;
  if (nextAnswerRelease === "after_due" && nextDueAt === null) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "答案公布时机为「截止后公布」时必须保留截止时间（如需取消截止，先把公布时机改回「交卷即公布」）",
    );
  }

  // 单元替换：先判内容锁定（D14），再校验并替换
  let unitList: { id: string; title: string }[] | undefined;
  if (request.unitIds !== undefined) {
    if (hasAttempt(db, id)) {
      throw new HttpError(
        409,
        "ASSIGNMENT_CONTENT_LOCKED",
        "已有学生开始作答，这份作业的单元内容已锁定，不能再修改",
      );
    }
    unitList = requireUnitsUniqueExist(db, request.unitIds);
  }

  // 新增：校验学生存在
  if (addIds !== undefined) {
    requireStudentsExist(db, addIds);
  }

  // 移出：校验学生存在且在册；已开始者须 confirmStarted
  if (removeIds !== undefined) {
    requireStudentsExist(db, removeIds);
    const roster = new Set(
      (rosterRowsByAssignment(db, [id]).get(id) ?? []).map(
        (entry) => entry.studentId,
      ),
    );
    const notOnRoster = removeIds.filter((studentId) => !roster.has(studentId));
    if (notOnRoster.length > 0) {
      const names = studentNamesById(db);
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        `以下学生不在该作业名单中：${notOnRoster
          .map((studentId) => names.get(studentId) ?? studentId)
          .join("、")}`,
      );
    }
    if (request.confirmStarted !== true) {
      // removeIds 在上文守卫保证非空（空数组时为 undefined），inArray 安全；
      // 一条查询取「已开始集合」（该作业存在 attempt 的学生），避免逐学生 N+1
      const startedSet = new Set(
        db
          .select({ studentId: attempts.studentId })
          .from(attempts)
          .where(
            and(
              eq(attempts.assignmentId, id),
              inArray(attempts.studentId, [...removeIds]),
            ),
          )
          .all()
          .map((row) => row.studentId),
      );
      const started = removeIds.filter((studentId) =>
        startedSet.has(studentId),
      );
      if (started.length > 0) {
        const names = studentNamesById(db);
        throw new HttpError(
          409,
          "CONFIRM_REQUIRED",
          "以下学生已开始作答，移出后其作业从待办消失（已交卷结果仍保留在记录中），请确认",
          {
            _students: started.map((studentId) => ({
              studentId,
              displayName: names.get(studentId) ?? studentId,
            })),
          },
        );
      }
    }
  }

  const now = new Date().toISOString();
  db.transaction((tx) => {
    const patch: Partial<typeof assignments.$inferInsert> = {};
    if (request.title !== undefined) patch.title = request.title;
    if (request.dueAt !== undefined) patch.dueAt = request.dueAt;
    if (request.answerRelease !== undefined) {
      patch.answerRelease = request.answerRelease;
    }
    if (Object.keys(patch).length > 0) {
      tx.update(assignments).set(patch).where(eq(assignments.id, id)).run();
    }
    if (unitList !== undefined) {
      tx.delete(assignmentUnits)
        .where(eq(assignmentUnits.assignmentId, id))
        .run();
      unitList.forEach((unit, index) => {
        tx.insert(assignmentUnits)
          .values({ assignmentId: id, unitId: unit.id, order: index })
          .run();
      });
    }
    if (addIds !== undefined) {
      for (const studentId of addIds) {
        // 命中复合主键（含曾移出的行）→ 复用行并置回在册；否则插入
        tx.insert(assignmentStudents)
          .values({
            assignmentId: id,
            studentId,
            addedAt: now,
            removedAt: null,
          })
          .onConflictDoUpdate({
            target: [
              assignmentStudents.assignmentId,
              assignmentStudents.studentId,
            ],
            set: { addedAt: now, removedAt: null },
          })
          .run();
      }
    }
    if (removeIds !== undefined) {
      tx.update(assignmentStudents)
        .set({ removedAt: now })
        .where(
          and(
            eq(assignmentStudents.assignmentId, id),
            inArray(assignmentStudents.studentId, removeIds),
          ),
        )
        .run();
    }
  });
  return teacherAssignmentOf(db, id);
}

/**
 * DELETE /api/teacher/assignments/:id：软删（deletedAt 置当前时间）。
 * 在册学生端立即不可见；教师列表默认不显示（includeDeleted=true 可见）。
 * 关联的 assignment_students / assignment_units 行保留（软删不物理删除任何数据，
 * 作答记录经 assignmentId 继续关联历史）。重复删除幂等成功。
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
 * POST /api/teacher/assignments/check（D15 布置前「已做过」检查）：
 * 对每个 studentId × unitId 统计 sourceType='course' 且 status∈{submitted,graded}
 * 的 attempts，按 (学生, attempt.courseId, 单元) 聚合计数，带出姓名/课程名/单元标题。
 * 未做过或仅有草稿的学生×单元不产生行；作业作答（sourceType='assignment'）不计入。
 */
export function checkAssignment(
  db: Db,
  request: AssignmentCheckRequest,
): AssignmentCheckData {
  requireStudentsExist(db, request.studentIds);
  requireUnitsUniqueExist(db, request.unitIds);

  const unitTitles = new Map(
    db
      .select({ id: units.id, title: units.title })
      .from(units)
      .where(inArray(units.id, request.unitIds))
      .all()
      .map((row) => [row.id, row.title] as const),
  );
  const studentNames = studentNamesById(db);
  const courseNames = new Map(
    db
      .select({ id: courses.id, title: courses.title })
      .from(courses)
      .all()
      .map((row) => [row.id, row.title] as const),
  );

  // (studentId, courseId|null, unitId) → 已交卷次数（D15：按 学生×课程×单元 聚合一行）
  const counts = new Map<
    string,
    {
      studentId: string;
      courseId: string | null;
      unitId: string;
      submittedCount: number;
    }
  >();
  const rows = db
    .select({
      studentId: attempts.studentId,
      courseId: attempts.courseId,
      unitId: attempts.unitId,
    })
    .from(attempts)
    .where(
      and(
        eq(attempts.sourceType, "course"),
        inArray(attempts.status, ["submitted", "graded"]),
        inArray(attempts.studentId, request.studentIds),
        inArray(attempts.unitId, request.unitIds),
      ),
    )
    .all();
  for (const r of rows) {
    if (r.unitId === null) continue; // course 来源必写 unitId，防御性跳过异常行
    const key = `${r.studentId}|${r.courseId ?? ""}|${r.unitId}`;
    const existing = counts.get(key);
    if (existing === undefined) {
      counts.set(key, {
        studentId: r.studentId,
        courseId: r.courseId,
        unitId: r.unitId,
        submittedCount: 1,
      });
    } else {
      existing.submittedCount += 1;
    }
  }

  const hints = [...counts.values()]
    .map((entry) => ({
      studentId: entry.studentId,
      studentName: studentNames.get(entry.studentId) ?? entry.studentId,
      courseId: entry.courseId,
      courseName:
        entry.courseId !== null
          ? (courseNames.get(entry.courseId) ?? null)
          : null,
      unitId: entry.unitId,
      unitTitle: unitTitles.get(entry.unitId) ?? entry.unitId,
      submittedCount: entry.submittedCount,
    }))
    // 展示口径稳定：按学生姓名 → 单元标题排序
    .sort((a, b) =>
      a.studentName === b.studentName
        ? a.unitTitle.localeCompare(b.unitTitle, "zh-Hans-CN")
        : a.studentName.localeCompare(b.studentName, "zh-Hans-CN"),
    );
  return { hints };
}

/**
 * GET /api/teacher/assignments（T2A.7 扩展 courseId 筛选）：按创建时间倒序。
 * - includeDeleted=false（默认）只列未删除；
 * - courseId=UUID 只看该课程的作业；courseId="none" 只看无课程作业（courseId IS NULL）。
 */
export function listTeacherAssignments(
  db: Db,
  options: { includeDeleted: boolean; courseId?: string },
): { assignments: TeacherAssignment[] } {
  const conditions = [];
  if (!options.includeDeleted) conditions.push(isNull(assignments.deletedAt));
  if (options.courseId === "none")
    conditions.push(isNull(assignments.courseId));
  else if (options.courseId !== undefined)
    conditions.push(eq(assignments.courseId, options.courseId));

  const rows = db
    .select()
    .from(assignments)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(assignments.createdAt))
    .all();
  if (rows.length === 0) return { assignments: [] };

  const ids = rows.map((row) => row.id);
  return {
    assignments: rows.map((row) =>
      toTeacherAssignment(
        row,
        unitRowsByAssignment(db, ids),
        liveQuestionCounts(db),
        rosterRowsByAssignment(db, ids),
        attemptGroupsByAssignment(db),
        new Map(
          db
            .select({ id: courses.id, title: courses.title })
            .from(courses)
            .all()
            .map((r) => [r.id, r.title] as const),
        ),
      ),
    ),
  };
}

/**
 * GET /api/teacher/assignments/:id（T2A.7 详情）：列表行口径 + roster（在册，
 * 按加入时间后姓名排序）+ startedCount（已开始人数，D14 锁定原因）+
 * courseNewMembers（当前课程成员 − 在册名单，D13「补充课程新成员」数据源；
 * 无课程时空数组）。已删除作业可读（教师 includeDeleted 视图配套）。
 */
export function getAssignmentDetail(db: Db, id: string): AssignmentDetailData {
  const base = teacherAssignmentOf(db, id);
  const roster = rosterRowsByAssignment(db, [id]).get(id) ?? [];
  const attemptGroups = attemptGroupsByAssignment(db).get(id) ?? new Map();

  const courseNewMembers: { studentId: string; displayName: string }[] = [];
  if (base.courseId !== null) {
    const rosterIds = new Set(roster.map((entry) => entry.studentId));
    for (const row of db
      .select({
        studentId: courseStudents.studentId,
        displayName: students.displayName,
      })
      .from(courseStudents)
      .innerJoin(students, eq(courseStudents.studentId, students.id))
      .where(eq(courseStudents.courseId, base.courseId))
      .orderBy(asc(students.displayName))
      .all()) {
      if (!rosterIds.has(row.studentId)) {
        courseNewMembers.push({
          studentId: row.studentId,
          displayName: row.displayName,
        });
      }
    }
  }

  return {
    ...base,
    roster: roster.map((entry) => ({
      studentId: entry.studentId,
      displayName: entry.displayName,
      status: computeAssignmentStatus(
        { id, dueAt: base.dueAt },
        attemptGroups.get(entry.studentId) ?? [],
      ),
      addedAt: entry.addedAt,
    })),
    startedCount: roster.filter((entry) => attemptGroups.has(entry.studentId))
      .length,
    courseNewMembers,
  };
}

// ---------- 学生端：我的作业 ----------

/**
 * GET /api/student/assignments：仅本人**在册**（assignment_students 命中且
 * removedAt IS NULL，D13——被移出即从待办消失）且未删除的作业。
 * 多单元聚合（units 按布置顺序、标题取当前值；questionCount=各单元 live 题数
 * 之和）；按布置时间倒序；状态经 computeAssignmentStatus 推导四态。
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
    })
    .from(assignments)
    .innerJoin(
      assignmentStudents,
      eq(assignmentStudents.assignmentId, assignments.id),
    )
    .where(
      and(
        eq(assignmentStudents.studentId, studentId),
        isNull(assignmentStudents.removedAt),
        isNull(assignments.deletedAt),
      ),
    )
    .orderBy(desc(assignments.createdAt))
    .all();
  if (rows.length === 0) return { assignments: [] };

  // 该学生的全部作业 attempt 摘要按 assignmentId 归组（course 来源不关联作业）
  const attemptsByAssignment = new Map<string, Pick<Attempt, "status">[]>();
  for (const attempt of db
    .select({ assignmentId: attempts.assignmentId, status: attempts.status })
    .from(attempts)
    .where(eq(attempts.studentId, studentId))
    .all()) {
    if (attempt.assignmentId === null) continue;
    const list = attemptsByAssignment.get(attempt.assignmentId);
    if (list === undefined) {
      attemptsByAssignment.set(attempt.assignmentId, [
        { status: attempt.status },
      ]);
    } else {
      list.push({ status: attempt.status });
    }
  }

  const unitLists = unitRowsByAssignment(
    db,
    rows.map((row) => row.id),
  );
  const counts = liveQuestionCounts(db);
  return {
    assignments: rows.map((row) => {
      const unitList = unitLists.get(row.id) ?? [];
      return {
        id: row.id,
        title: row.title,
        units: unitList.map((unit) => ({ id: unit.unitId, title: unit.title })),
        unitCount: unitList.length,
        // 各单元 live 题数之和（软删单元照常计入，D16：作业通道不受单元软删影响）
        questionCount: unitList.reduce(
          (sum, unit) => sum + (counts.get(unit.unitId) ?? 0),
          0,
        ),
        dueAt: row.dueAt,
        createdAt: row.createdAt,
        status: computeAssignmentStatus(
          { id: row.id, dueAt: row.dueAt },
          attemptsByAssignment.get(row.id) ?? [],
        ),
      };
    }),
  };
}

// ---------- 学生端：试卷（T2.4；T2A.7 分组化） ----------

/**
 * 解析 JSON 列文本为 unknown：列由导入链路写入，正常必为合法 JSON；
 * 坏数据（SyntaxError）按缺省处理，不打挂学生端接口。
 */
function parseJsonColumn(jsonText: string): unknown {
  try {
    return JSON.parse(jsonText) as unknown;
  } catch {
    return null;
  }
}

/** 解析 hintsJson（string[]）为提示数量；只取长度，内容（教师侧）不随本函数外流 */
function hintCountOf(hintsJson: string): number {
  const parsed = parseJsonColumn(hintsJson);
  return Array.isArray(parsed) ? parsed.length : 0;
}

/** 解析 optionsJson（QuestionOption[]）为公开选项文本数组——丢弃 correct 正确项标记 */
function optionTexts(optionsJson: string): string[] {
  const parsed = parseJsonColumn(optionsJson);
  if (!Array.isArray(parsed)) return [];
  const texts: string[] = [];
  for (const item of parsed) {
    if (
      typeof item === "object" &&
      item !== null &&
      "text" in item &&
      typeof item.text === "string"
    ) {
      texts.push(item.text);
    }
  }
  return texts;
}

/** 题目 id → 考点名列表（同名归一后按考点名排序，与教师端内容树同口径） */
export function knowledgeNamesByQuestion(db: Db): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const rows = db
    .select({
      questionId: questionKnowledge.questionId,
      name: knowledgePoints.name,
    })
    .from(questionKnowledge)
    .innerJoin(
      knowledgePoints,
      eq(questionKnowledge.knowledgePointId, knowledgePoints.id),
    )
    .orderBy(asc(knowledgePoints.name))
    .all();
  for (const row of rows) {
    const list = map.get(row.questionId);
    if (list === undefined) map.set(row.questionId, [row.name]);
    else list.push(row.name);
  }
  return map;
}

/**
 * 题目行集合 → 公开题目投影（T2A.6 起与 unitPublicQuestions 共用的底层）：
 * - 从 questions 整行构造候选对象后经 questionPublicSchema.parse 输出过滤（strip
 *   未知键）：answersJson / solutionMd / hintsJson / sourceMd 等教师侧列一律被剥离，
 *   将来加列也不会经由本投影外泄（fail closed）；
 * - stemMd 先经 publicStemMd 公开化：填空/判断标记 [[答案]] 替换为空标记 [[]]，
 *   数学/代码环境内的 [[…]] 记号原样保留；
 * - options 仅 choice/multi 携带，映射为纯文本数组（无 correct 标记）；
 * - hints 只暴露数量 hintCount（内容由 T2.11 分步提示接口按需下发）。
 */
export function publicQuestionsOfRows(
  db: Db,
  liveQuestions: readonly QuestionRow[],
): QuestionPublic[] {
  const knowledge = knowledgeNamesByQuestion(db);

  return liveQuestions.map((question) =>
    questionPublicSchema.parse({
      ...question,
      stemMd: publicStemMd(question.stemMd),
      knowledge: knowledge.get(question.id) ?? [],
      hintCount: hintCountOf(question.hintsJson),
      ...(question.optionsJson !== null
        ? { options: optionTexts(question.optionsJson) }
        : {}),
    }),
  );
}

/**
 * 单元公开题目（T2.4 试卷与草稿视图的单元入口投影）：
 * 该单元未软删的题目按 order 升序（同 order 按 id 兜底稳定），经
 * publicQuestionsOfRows 输出过滤（见上方注释）。
 */
export function unitPublicQuestions(db: Db, unitId: string): QuestionPublic[] {
  const liveQuestions = db
    .select()
    .from(questions)
    .where(and(eq(questions.unitId, unitId), isNull(questions.deletedAt)))
    .orderBy(asc(questions.order), asc(questions.id))
    .all();
  return publicQuestionsOfRows(db, liveQuestions);
}

/**
 * GET /api/student/assignments/:id/paper（T2A.7 分组试卷）：
 * 按 assignment_units.order 逐单元 unitPublicQuestions 分组；**live 题数为 0
 * 的单元不出现**（题目全被软删/清空）；全部跳过时 units 为空数组（前端按空卷
 * 兜底提示）。D16：单元软删不影响出卷——引用行保留，题目照常下发。
 * 权限（T2.4 验收项）：作业不存在 → 404；已删除 → 404（与学生列表过滤口径一致）；
 * 未被指派（assignment_students 未命中**或在册判定含 removedAt IS NULL**）→
 * 403 FORBIDDEN（D13：被移出的学生立即不可见）。
 */
export function getStudentAssignmentPaper(
  db: Db,
  studentId: string,
  assignmentId: string,
): StudentPaperData {
  const row = db
    .select()
    .from(assignments)
    .where(eq(assignments.id, assignmentId))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "ASSIGNMENT_NOT_FOUND", "作业不存在");
  }
  if (row.deletedAt !== null) {
    throw new HttpError(
      404,
      "ASSIGNMENT_NOT_FOUND",
      "作业不存在（可能已被删除）",
    );
  }
  const assigned = db
    .select({ studentId: assignmentStudents.studentId })
    .from(assignmentStudents)
    .where(
      and(
        eq(assignmentStudents.assignmentId, assignmentId),
        eq(assignmentStudents.studentId, studentId),
        isNull(assignmentStudents.removedAt),
      ),
    )
    .get();
  if (assigned === undefined) {
    throw new HttpError(403, "FORBIDDEN", "未被指派此作业，无权查看");
  }

  const unitRows = db
    .select({ unitId: assignmentUnits.unitId, title: units.title })
    .from(assignmentUnits)
    .innerJoin(units, eq(assignmentUnits.unitId, units.id))
    .where(eq(assignmentUnits.assignmentId, assignmentId))
    .orderBy(asc(assignmentUnits.order), asc(assignmentUnits.unitId))
    .all();
  // D16：单元软删不影响作业通道——引用行保留、题目照常下发（单元标题取当前值，
  // 软删单元行在回收站保留故仍可读）；live 题数为 0 的单元（题目被清空/全软删）
  // 跳过；全部跳过 → units 空数组（前端空卷兜底）
  const unitsOf = unitRows
    .map((unit) => ({
      id: unit.unitId,
      title: unit.title,
      questions: unitPublicQuestions(db, unit.unitId),
    }))
    .filter((unit) => unit.questions.length > 0);
  return { units: unitsOf };
}
