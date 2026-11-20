import { randomUUID } from "node:crypto";
import {
  type TeacherAttemptCard,
  type TeacherAttemptInkInfo,
  type TeacherAttemptListData,
  type TeacherAttemptListQuery,
  type TeacherAttemptSource,
  type TeacherResponseEdit,
  type WrongScope,
  wrongPracticeScopeSchema,
  wrongScopeLabelOf,
} from "@tutor/contract";
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  assignments,
  attempts,
  courses,
  type InkRow,
  ink,
  questions,
  responseEditAudits,
  responses,
  students,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { recordableAttemptWhere } from "./attempt-recordability.ts";
import {
  assertFrozenAnswerShape,
  attemptQuestionRows,
  attemptUnitIds,
  buildAttemptQuestionWhere,
  lessonSourceContextOf,
} from "./attempt-service";
import { timeProjectionsOf } from "./attempt-time-projection";
import {
  pendingMarkCounts,
  pendingMarkCountsByStudent,
  practiceSubmittedCounts,
} from "./pending-mark";
import { attemptResultCounts } from "./result-counts";
import { snapshotOfRow } from "./snapshot";
import {
  assertTeacherDraftSnapshot,
  hasTeacherDraftSnapshotEvidence,
  responseEvidenceExists,
} from "./teacher-response-snapshot.ts";
import { readTeacherAttemptPage } from "./teacher-workbench-selection.ts";

/**
 * TeacherAttemptService（T3.1，Phase3 清单 D5–D8）——教师端作答数据页业务层：
 * - listTeacherAttempts：attempt → student → teacherId 归属过滤（乙教师查不到
 *   甲学生的作答）+ 筛选组合 + 按最近活动时间（submittedAt ?? startedAt）倒序
 *   + 分页 limit/offset 与 total；来源上下文名经 join 组装（assignments.title /
 *   units.title / courses.title / attemptNo）；
 * - 单卷详情由 teacher-attempt-detail.ts 组装。
 *
 * 权限口径（T2B 域隔离红线）：attempt 归属链 attempt → student → teacherId，
 * 非本人学生的作答按不存在处理（404 ATTEMPT_NOT_FOUND，不暴露存在性）。
 * 题目/单元读取按该 teacherId 域内进行（attemptTeacherId 同源推导）。
 */

/**
 * 判定展示口径（QM-12 统一有效判定投影）：教师判 > 自评 > 自动——
 * effectiveVerdictOfRow 单一出处（原 `finalCorrect ?? autoCorrect` 快捷回落
 * 对自评行恒漏判：reference_self 行 finalCorrect 恒 null；该函数已删，
 * 详情计数与逐题显示一律走有效判定）。汇总计数（详情头对/错/待批/待自评）
 * 统一用它；待批数（pendingCount）单独走 D4 共享谓词（与列表卡片/矩阵同
 * 口径，不含待自评行）。
 */

// answerOf/jsonOf 已收敛唯一实现：attempt-service.answerOf（null 语义）与
// snapshot.jsonOf——本文件经顶部 import 使用，不再留平行副本

/** 手写信息投影（D7：ink 行存在才返回；pngUrl 指向教师端 PNG 直出接口）；
 * T3.2b 起导出——待批队列卡片拼装复用（mark-response.ts） */
export function inkInfoOf(
  row: InkRow | undefined,
): TeacherAttemptInkInfo | null {
  if (row === undefined) return null;
  return {
    inkId: row.id,
    pngUrl: `/api/teacher/ink/${row.id}.png`,
    hasStrokes: row.strokeCount > 0,
  };
}

/**
 * 来源上下文（列表卡片与详情头共用）：assignment=作业标题（+可选课程名）；
 * course=单元标题 + 课程名 + attemptNo（「单元标题 · 第 n 次」）；wrong=错题
 * 重练（2026-10：courseId/assignmentId/unitId 全 null，展示「错题重练 ·
 * 第 n 次」，由前端/CSV 拼串）；lesson=讲练页（2026-10 讲练一体：unitId 为
 * 嵌入单元快照值，**unitTitle 承载讲义标题**——记录/教师列表的展示标题
 * 口径「标题=讲义标题」，契约形态字段已可表达（teacherAttemptSourceSchema
 * 注释），讲义行异常缺失时兜底嵌入单元标题/attempt.unitId）。
 * 单元/课程按 teacherId 域内读；assignment 行经 FK 必存在（含已软删作业——
 * 作答记录不随作业删除消失，标题为布置时快照），异常缺失时兜底占位文案。
 * T3.2b 起导出——待批队列卡片拼装复用（mark-response.ts）。
 */

/**
 * 错题重练范围展示形态（#6980-2，sourceOf 与师生两端标题单源共用）：
 * label 取建卷存的 scope 快照（历史卷无存档为 null）；questionCount=卷内
 * 冻结 responses 行数；originUnits=冻结 responses→questions→units 反查的
 * 归属单元分布（题/单元已删除自然缺项；按次数倒序、同数次数字典序稳定）。
 */
export function wrongScopeOf(db: Db, attempt: Attempt): WrongScope {
  const rows = db
    .select({ id: responses.id })
    .from(responses)
    .where(eq(responses.attemptId, attempt.id))
    .all();
  const unitRows = db
    .select({ title: units.title })
    .from(responses)
    .innerJoin(questions, eq(responses.questionId, questions.id))
    .innerJoin(units, eq(questions.unitId, units.id))
    .where(eq(responses.attemptId, attempt.id))
    .all();
  const unitCounts = new Map<string, number>();
  for (const row of unitRows) {
    unitCounts.set(row.title, (unitCounts.get(row.title) ?? 0) + 1);
  }
  const originUnits = [...unitCounts.entries()]
    .map(([title, count]) => ({ title, count }))
    .sort(
      (a, b) =>
        b.count - a.count || a.title.localeCompare(b.title, "zh-Hans-CN"),
    );
  let label: string | null = null;
  if (attempt.practiceScopeJson !== null) {
    try {
      const parsed = wrongPracticeScopeSchema.safeParse(
        JSON.parse(attempt.practiceScopeJson),
      );
      label = parsed.success ? wrongScopeLabelOf(parsed.data) : null;
    } catch {
      label = null;
    }
  }
  return { label, questionCount: rows.length, originUnits };
}

export function sourceOf(
  db: Db,
  attempt: Attempt,
  teacherId: string,
): TeacherAttemptSource {
  if (attempt.sourceType === "wrong") {
    return {
      sourceType: "wrong",
      courseId: null,
      courseName: null,
      assignmentId: null,
      assignmentTitle: null,
      unitId: null,
      unitTitle: null,
      attemptNo: attempt.attemptNo,
      wrongScope: wrongScopeOf(db, attempt),
    };
  }
  if (attempt.sourceType === "lesson") {
    // 讲练页（2026-10）：courseId 可空（打开时来自哪门课），不挂作业；
    // unitId = 嵌入单元快照值（分组键），unitTitle = 讲义标题（展示口径）。
    // 上下文与学生侧 attemptSourceMeta 同一实现（lessonSourceContextOf：
    // 讲义标题 → 嵌入单元标题 → attempt.unitId 的人文兜底链）
    const { title, courseName } = lessonSourceContextOf(db, attempt, teacherId);
    return {
      sourceType: "lesson",
      courseId: attempt.courseId,
      courseName,
      assignmentId: null,
      assignmentTitle: null,
      unitId: attempt.unitId,
      unitTitle: title,
      attemptNo: attempt.attemptNo,
    };
  }
  if (attempt.sourceType === "course") {
    const course =
      attempt.courseId !== null
        ? db
            .select({ title: courses.title })
            .from(courses)
            .where(eq(courses.id, attempt.courseId))
            .get()
        : undefined;
    const unit =
      attempt.unitId !== null
        ? db
            .select({ title: units.title })
            .from(units)
            .where(
              and(eq(units.teacherId, teacherId), eq(units.id, attempt.unitId)),
            )
            .get()
        : undefined;
    return {
      sourceType: "course",
      courseId: attempt.courseId,
      courseName: course?.title ?? null,
      assignmentId: null,
      assignmentTitle: null,
      unitId: attempt.unitId,
      // 单元软删不删行（D16），标题仍可读；异常缺失兜底用单元 id
      unitTitle: unit?.title ?? attempt.unitId ?? "",
      attemptNo: attempt.attemptNo,
    };
  }
  const assignment =
    attempt.assignmentId !== null
      ? db
          .select({ title: assignments.title, courseId: assignments.courseId })
          .from(assignments)
          .where(eq(assignments.id, attempt.assignmentId))
          .get()
      : undefined;
  // attempt.courseId 在创建时即取作业所属课程（T2A.7）；兜底再读作业行
  const courseId = attempt.courseId ?? assignment?.courseId ?? null;
  const course =
    courseId !== null
      ? db
          .select({ title: courses.title })
          .from(courses)
          .where(eq(courses.id, courseId))
          .get()
      : undefined;
  return {
    sourceType: "assignment",
    courseId,
    courseName: course?.title ?? null,
    assignmentId: attempt.assignmentId,
    assignmentTitle: assignment?.title ?? "（作业已不存在）",
    unitId: null,
    unitTitle: null,
    attemptNo: attempt.attemptNo,
  };
}

/** attempt 的笔迹行索引：questionId → ink 行（(attemptId, questionId) 唯一）；
 * T3.2b 起导出——待批队列卡片拼装复用（mark-response.ts） */
export function inkByQuestionOf(
  db: Db,
  attemptId: string,
): Map<string, InkRow> {
  return new Map(
    db
      .select()
      .from(ink)
      .where(eq(ink.attemptId, attemptId))
      .all()
      .map((row) => [row.questionId, row] as const),
  );
}

/** 单元 id → 标题（teacherId 域内；软删单元行保留，标题仍可读，D16）。
 * T3.4 起导出——CSV 导出行组装复用（export-csv.ts） */
export function unitTitleByIdOf(
  db: Db,
  teacherId: string,
  unitIds: readonly string[],
): Map<string, string> {
  if (unitIds.length === 0) return new Map();
  return new Map(
    db
      .select({ id: units.id, title: units.title })
      .from(units)
      .where(
        and(eq(units.teacherId, teacherId), inArray(units.id, [...unitIds])),
      )
      .all()
      .map((row) => [row.id, row.title] as const),
  );
}

// ---------- GET /api/teacher/attempts ----------

/**
 * 教师端作答列表（D6 三视图与来源筛选共用）：
 * - 归属：attempt → student → teacherId（域内过滤，乙教师查不到甲数据）；
 * - 筛选可任意组合：studentId / courseId / assignmentId / unitId（DSL id，只命中
 *   course 来源——assignment 来源不落单单元）/ sourceType / status / from / to
 *   （时间范围按最近活动时间 submittedAt ?? startedAt，与排序同一时间轴）；
 * - 排序：最近活动时间倒序（并按 id 倒序兜底稳定）；
 * - 分页：limit（默认 50，≤200）/ offset；total 为筛选后总条数；
 * - 卡片：来源上下文、单元数 / 题数（draft=当前 live 题数，已交卷=responses
 *   冻结行数）、得分双字段（scoreAuto / scoreFinal 透传，展示口径由前端取
 *   scoreFinal ?? scoreAuto，D2）、待批数（pending-mark 共享谓词，D4）。
 */
export function listTeacherAttempts(
  db: Db,
  teacherId: string,
  query: TeacherAttemptListQuery,
  dataDir?: string,
): TeacherAttemptListData {
  return readTeacherAttemptCards(db, teacherId, query, dataDir).data;
}

export function readTeacherAttemptCards(
  db: Db,
  teacherId: string,
  query: TeacherAttemptListQuery,
  dataDir: string | undefined,
) {
  const { rows, total, confirmed } = readTeacherAttemptPage(
    db,
    teacherId,
    query,
    dataDir,
  );
  const legacyAttempts = rows
    .map(({ attempt }) => attempt)
    .filter(({ id }) => !confirmed.has(id));
  const resultCounts = attemptResultCounts(db, legacyAttempts);
  const pendingCounts = pendingMarkCounts(db, legacyAttempts);
  // T-PR4：行级已提交数（学生主页作答记录区「已提交 n / 共 m」用；与 v1 逐题
  // 进度同一实现 practiceSubmittedCounts——draft 按行级事实、已收尾收敛整卷）
  const submittedCounts = practiceSubmittedCounts(
    db,
    rows.map((row) => row.attempt),
  );
  const cardTimes = timeProjectionsOf(
    db,
    rows.map(({ attempt }) => attempt.id),
  );
  const cards: TeacherAttemptCard[] = rows.map(({ attempt, studentName }) => ({
    attemptId: attempt.id,
    studentId: attempt.studentId,
    studentName,
    ...sourceOf(db, attempt, teacherId),
    unitCount: attemptUnitIds(db, attempt).length,
    // 题数（T6R.3）：wrong（建卷即有自有行）、已交卷、已冻结的 draft 均以
    // responses 冻结行数为准（**快照非空**——幽灵行不计数，与视图/待批谓词
    // 同口径）；升级遗留的未冻结 draft 过渡期用当前 live 题数（学生首次恢复
    // 访问即冻结，随之切换到行数口径）
    questionCount:
      attempt.sourceType === "wrong" ||
      attempt.status !== "draft" ||
      attempt.frozenAt !== null
        ? (db
            .select({ n: sql<number>`count(*)` })
            .from(responses)
            .where(
              and(
                eq(responses.attemptId, attempt.id),
                isNotNull(responses.questionSnapshotJson),
              ),
            )
            .get()?.n ?? 0)
        : attemptQuestionRows(db, attempt).length,
    status: attempt.status,
    resultCounts:
      confirmed.get(attempt.id)?.resultCounts ??
      resultCounts.get(attempt.id) ??
      null,
    scoreAuto: attempt.scoreAuto,
    scoreFinal: attempt.scoreFinal,
    // D4 共享待批谓词（finalCorrect IS NULL；draft 恒 0）——与详情/矩阵/单元卡片同口径
    pendingCount: pendingCounts.get(attempt.id) ?? 0,
    submittedCount: submittedCounts.get(attempt.id)?.submitted ?? 0,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    time: cardTimes.aggregate(attempt.id),
    activeSec: attempt.activeSec,
  }));
  return {
    data: { attempts: cards, total },
    confirmedCounts: new Map(
      [...confirmed].map(([id, facts]) => [id, facts.resultCounts]),
    ),
  };
}

/**
 * 教师侧「可盘点作答行」共享谓词（教师迭代 T-PR2 抽出；T-PR3 已提交行放行与
 * 学生主页聚合端点同用）：排作废卷（abandonedAt 非空）；进行中（draft）卷只纳入
 * 单题已提交的行（responses.submittedAt 非空——讲练一体 2026-10 起的单题提交
 * 时刻），整卷未交的 draft 行判定列不可信、不对外盘点；快照缺失的「历史题目
 * 缺失」幽灵行（T6R.3）一并排除，与 D4 待批谓词同口径。使用方必须同时 join
 * attempts 与 responses 两表。
 */
export function teacherVisibleResponsesWhere(includeUnsubmitted = false) {
  return [
    recordableAttemptWhere(),
    isNotNull(responses.questionSnapshotJson),
    ...(includeUnsubmitted
      ? []
      : [or(ne(attempts.status, "draft"), isNotNull(responses.submittedAt))]),
  ];
}

// ---------- GET /api/teacher/attempts/:id ----------

/**
 * attempt → 学生归属链查行（**不抛**；null = 不存在或域外，不区分——不暴露
 * 存在性）。T6R.5 复审②从 requireTeacherAttempt 拆出：note-service 教师端
 * 版本/图片授权需要同一归属判定但错误码不同（NOTE_NOT_FOUND），共用本原语
 * + 各自错误码的薄抛层，保证域判定口径永不漂移。
 */
export function findTeacherAttempt(
  db: Db,
  teacherId: string,
  attemptId: string,
): { attempt: Attempt; studentName: string } | null {
  const row = db
    .select({
      attempt: attempts,
      studentName: students.displayName,
      ownerTeacherId: students.teacherId,
    })
    .from(attempts)
    .innerJoin(students, eq(attempts.studentId, students.id))
    .where(eq(attempts.id, attemptId))
    .get();
  if (row === undefined || row.ownerTeacherId !== teacherId) {
    return null;
  }
  return { attempt: row.attempt, studentName: row.studentName };
}

/**
 * attempt 行（经学生归属链）：不存在或非本人学生的作答 → 404（不暴露存在性）。
 * 判定原语在 findTeacherAttempt；本函数是 ATTEMPT_NOT_FOUND 口径的薄抛层
 * （note-service 以 NOTE_NOT_FOUND 口径复用同一原语）。
 */
export function requireTeacherAttempt(
  db: Db,
  teacherId: string,
  attemptId: string,
): { attempt: Attempt; studentName: string } {
  const row = findTeacherAttempt(db, teacherId, attemptId);
  if (row === null) {
    throw new HttpError(404, "ATTEMPT_NOT_FOUND", "作答记录不存在");
  }
  return row;
}

export function editTeacherDraftResponse(
  db: Db,
  teacherId: string,
  edit: TeacherResponseEdit,
) {
  const { attemptId, questionId, expectedAnswerRevision, reason } = edit;
  return db.transaction((tx) => {
    const { attempt } = requireTeacherAttempt(db, teacherId, attemptId);
    if (attempt.status !== "draft" || attempt.abandonedAt !== null) {
      throw new HttpError(
        409,
        "ATTEMPT_NOT_IN_PROGRESS",
        "只能修改未作废的进行中练习",
      );
    }
    const row = tx
      .select()
      .from(responses)
      .where(buildAttemptQuestionWhere(attemptId, questionId))
      .get();
    const original = row === undefined ? null : snapshotOfRow(row);
    if (row === undefined || original === null) {
      throw new HttpError(404, "QUESTION_NOT_FOUND", "找不到该练习的冻结题目");
    }
    if (row.submittedAt !== null) {
      throw new HttpError(
        409,
        "QUESTION_ALREADY_SUBMITTED",
        "本题已提交，不能修改",
      );
    }
    if (row.answerRevision !== expectedAnswerRevision) {
      throw new HttpError(
        409,
        "ANSWER_REVISION_CONFLICT",
        "本题已更新，请重新查询",
      );
    }

    if ("snapshot" in edit) {
      assertTeacherDraftSnapshot(row, original, edit.snapshot);
      if (hasTeacherDraftSnapshotEvidence(tx, row))
        throw responseEvidenceExists();
    } else {
      assertFrozenAnswerShape(db, row, original, edit.answer);
    }

    const auditId = randomUUID();
    const isSnapshot = "snapshot" in edit;
    const answerRevision = row.answerRevision + 1;
    const written = tx
      .update(responses)
      .set({
        ...(isSnapshot
          ? { questionSnapshotJson: JSON.stringify(edit.snapshot) }
          : { answerJson: JSON.stringify(edit.answer) }),
        answerRevision,
        answerMutationId: auditId,
      })
      .where(
        and(
          eq(responses.id, row.id),
          isNull(responses.submittedAt),
          eq(responses.answerRevision, expectedAnswerRevision),
        ),
      )
      .run();
    if (written.changes !== 1) {
      throw new HttpError(
        409,
        "ANSWER_REVISION_CONFLICT",
        "本题已更新，请重新查询",
      );
    }
    tx.insert(responseEditAudits)
      .values({
        id: auditId,
        responseId: row.id,
        teacherId,
        kind: isSnapshot ? "snapshot" : "answer",
        previousJson: isSnapshot ? row.questionSnapshotJson : row.answerJson,
        reason,
        answerRevision,
        createdAt: new Date().toISOString(),
      })
      .run();
    return { success: true, attemptId, questionId, answerRevision };
  });
}

// 快照解析统一走 services/snapshot.ts 的 snapshotOfRow（T6R.3 全服务端唯一
// 实现，含坏数据 warn 留痕）——本文件与 mark-response/wrong-practice 均经其
// 读取，不再各自 safeParse。

// ---------- T-PR4 Web-4：学生列表「活动三列」聚合 ----------

/** 学生活动三列（Web-4 学生列表）：最近作答时间 / 待批数 / 进行中讲练数 */
export interface StudentActivitySummary {
  /** 非作废 attempts 的最近活动时间（submittedAt ?? startedAt）；无作答为 null */
  lastActivityAt: string | null;
  /** D4 共享待批谓词计数（pendingMarkCountsByStudent，跨该生全部非作废卷） */
  pendingCount: number;
  /** draft 且非作废的 lesson（讲练）卷数 */
  inProgressLessonCount: number;
}

/**
 * 一批学生的活动三列聚合（listStudents 的数据源）：两条 attempt 级分组 SQL +
 * 待批谓词一条（D4 单一口径 pendingMarkCountsByStudent），无逐学生 N+1；
 * 无活动的学生补零值 / null。
 */
export function studentActivitySummaries(
  db: Db,
  studentIds: readonly string[],
): Map<string, StudentActivitySummary> {
  const map = new Map<string, StudentActivitySummary>();
  for (const id of studentIds) {
    map.set(id, {
      lastActivityAt: null,
      pendingCount: 0,
      inProgressLessonCount: 0,
    });
  }
  const ids = [...studentIds];
  if (ids.length === 0) return map;
  // 最近作答时间：max(coalesce(submittedAt, startedAt))，与作答列表排序同一时间轴
  for (const row of db
    .select({
      studentId: attempts.studentId,
      last: sql<string>`max(coalesce(${attempts.submittedAt}, ${attempts.startedAt}))`,
    })
    .from(attempts)
    .where(and(inArray(attempts.studentId, ids), recordableAttemptWhere()))
    .groupBy(attempts.studentId)
    .all()) {
    const entry = map.get(row.studentId);
    if (entry !== undefined) entry.lastActivityAt = row.last;
  }
  // 进行中讲练数：draft 且非作废的 lesson 卷
  for (const row of db
    .select({ studentId: attempts.studentId, n: sql<number>`count(*)` })
    .from(attempts)
    .where(
      and(
        inArray(attempts.studentId, ids),
        recordableAttemptWhere(),
        eq(attempts.status, "draft"),
        eq(attempts.sourceType, "lesson"),
      ),
    )
    .groupBy(attempts.studentId)
    .all()) {
    const entry = map.get(row.studentId);
    if (entry !== undefined) entry.inProgressLessonCount = row.n;
  }
  // 待批数：D4 共享谓词（pending-mark 单一口径）
  for (const [studentId, n] of pendingMarkCountsByStudent(db, ids)) {
    const entry = map.get(studentId);
    if (entry !== undefined) entry.pendingCount = n;
  }
  return map;
}
