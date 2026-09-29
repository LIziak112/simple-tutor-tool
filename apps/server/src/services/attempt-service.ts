import { randomUUID } from "node:crypto";
import {
  type AttemptAnswerSaveData,
  type AttemptDetailData,
  type AttemptDraftData,
  type AttemptDraftUnit,
  type AttemptResultData,
  type AttemptResultQuestion,
  type AttemptResultUnit,
  type AttemptScoreSummary,
  type AttemptStartData,
  optionSchema,
  type Question,
  type QuestionAnswers,
  type QuestionOption,
  questionAnswersSchema,
  questionSchema,
  type StudentAnswer,
  type StudentPaperData,
  type StudentPaperUnit,
  studentAnswerSchema,
} from "@tutor/contract";
import { grade } from "@tutor/grading";
import { publicStemMd } from "@tutor/md-dsl";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Assignment,
  type Attempt,
  assignmentStudents,
  assignments,
  assignmentUnits,
  attempts,
  type Course,
  courses,
  type Question as QuestionRow,
  questions,
  type ResponseRow,
  responses,
  type Unit,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { computePerQuestionActiveSec, countAnswerChanges } from "./active-time";
import {
  knowledgeNamesByQuestion,
  unitPublicQuestions,
} from "./assignment-service";
import { requireVisibleCourseUnit } from "./course-service";
import { attemptTimeline } from "./event-service";
import {
  draftHintsOpenedView,
  hintsOfJson,
  resultHintsOpenedOf,
} from "./hint-service";

/**
 * AttemptService（T2.6；T2A.6 扩展作答来源 D9/D10）——作答生命周期的业务层
 * （架构文档 §5.2/§5.3/§5.6）。路由只做「鉴权 → 校验 → 调 service → 包装响应」
 * （api-endpoint 技能约定），本模块承载：
 *
 * - startAttempt：创建或取回作业来源的 attempt（幂等：一个作业一人一份进行中，
 *   仅对 assignment 来源生效）；已交卷后再 POST 返回已交的那份（前端据此直接进
 *   结果视图，不另开新卷）；
 * - startCourseAttempt（T2A.6）：课程练习入口——存在未交卷作答则返回它；否则
 *   新建（attemptNo+1，从空白开始）。每次调用都校验 D5 可见性；「(学生, 课程,
 *   单元) 同时最多 1 份未交卷」由事务先查后插保证（D10）；
 * - saveDraftAnswer：draft 阶段 upsert responses（answerJson + changeCount 累加）；
 *   快照不在此写——判分与快照冻结都在交卷时一次性完成；
 * - submitAttempt：服务端权威判分（@tutor/grading，AGENTS 第 4 条）、逐题写
 *   questionSnapshotJson（题目编辑/软删不影响历史回看，验收项）、scoreAuto 汇总、
 *   status=submitted；重复交卷 409 ALREADY_SUBMITTED（验收项）；题目集合按
 *   sourceType 分派（attemptQuestionRows，见该函数注释）；
 * - getAttemptDetail：draft → 草稿视图（公开题目 + 本人草稿 + 已解锁提示回显，
 *   绝无答案/详解/未请求提示）；submitted/graded → 结果视图（快照 + 参考答案 +
 *   详解 + 判分 + 做题时已解锁提示的回看）；
 * - getStudentAttemptPaper（T2A.6）：通用取卷（两种来源共用；课程来源每次校验
 *   可见性与成员资格，D22）。
 *
 * 权限口径（T2A.6 起）：
 * - attempt 归属（studentId 匹配）是详情/草稿/交卷接口的第一道权限依据；
 * - assignment 来源维持现状：被移出名单或作业软删后，已创建的作答仍可继续与
 *   回看（§5.2「删除作业不删除已有作答记录」）；
 * - course 来源 + draft：每次访问都重校验 D5 可见性与成员资格（requireUsableAttempt
 *   → requireVisibleCourseUnit）——移出成员/课程归档 → 403 COURSE_ACCESS_DENIED，
 *   条目隐藏等 → 404 NOT_FOUND（D7：未交卷草稿不再可访问，数据保留不删）；
 * - course 来源 + 已交卷：只读记录，不做课程校验（D7/D10：已交卷课程练习记录
 *   保留，学生本人的记录中仍可查看）。
 *
 * 安全口径（AGENTS 第 3 条）：草稿视图题目一律经 publicQuestionsOfRows 输出过滤
 * （QuestionPublic 形态）；结果视图的 answers/solutionMd/stemMd（原文含答案标记）
 * 只在交卷后下发；提示内容只经 T2.11 按需接口（hint-service.openHint）逐条下发，
 * 两个视图仅回显「已解锁」条目（hintsOpened）。T2A.8（D11）：作业
 * answerRelease='after_due' 且未到截止时，结果视图（含交卷瞬间的 submit 响应）
 * 降级为受限形态——只下发本人答案与已解锁提示，题干公开化、对错/得分不泄露
 * （见 buildResultData）；截止后读时自动恢复。
 */

/** attempt 行 → 摘要（接口形态） */
function attemptSummaryOf(row: Attempt): AttemptStartData {
  return {
    id: row.id,
    sourceType: row.sourceType,
    assignmentId: row.assignmentId,
    courseId: row.courseId,
    // T2A.7：assignment 来源多单元化后 unitId 恒 null（题目集合走
    // assignment_units）；course 来源恒有值。契约允许 null，直接透传。
    unitId: row.unitId,
    attemptNo: row.attemptNo,
    status: row.status,
    startedAt: row.startedAt,
    submittedAt: row.submittedAt,
    scoreAuto: row.scoreAuto,
  };
}

/** 作业行（含已删除——作答记录不随作业软删消失）；不存在 → 404 ASSIGNMENT_NOT_FOUND */
function requireAssignmentRow(db: Db, id: string): Assignment {
  const row = db.select().from(assignments).where(eq(assignments.id, id)).get();
  if (!row) {
    throw new HttpError(404, "ASSIGNMENT_NOT_FOUND", "作业不存在");
  }
  return row;
}

/**
 * 答案是否已公布（T2A.8，D11 的判定纯函数，服务测试单测覆盖）：
 * - on_submit（默认）恒已公布；course 来源不适用本函数（D11 恒交卷即公布）；
 * - after_due：now ≥ dueAt 才公布（**读时比较，无定时任务**——截止后下一次
 *   请求自然恢复完整结果视图）；
 * - after_due 而 dueAt 缺失：按未公布处理（fail closed）。该状态被
 *   assignment-service 的 create/PATCH 组合校验 400 拦截，正常不可达，
 *   防御性口径取不泄露的一侧。
 */
export function answersReleased(
  assignment: Pick<Assignment, "answerRelease" | "dueAt">,
  now: Date | string = new Date(),
): boolean {
  if (assignment.answerRelease !== "after_due") return true;
  if (assignment.dueAt === null) return false;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  return Date.parse(assignment.dueAt) <= nowMs;
}

/**
 * 取本人 attempt：不存在 → 404 ATTEMPT_NOT_FOUND；非本人 → 403 FORBIDDEN（验收项）。
 * attempt 归属是所有 /attempts/:id/* 接口的第一道权限依据，
 * 抽为导出函数保证各接口口径永不漂移。
 */
export function requireOwnAttempt(
  db: Db,
  studentId: string,
  attemptId: string,
): Attempt {
  const row = db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .get();
  if (!row) {
    throw new HttpError(404, "ATTEMPT_NOT_FOUND", "作答记录不存在");
  }
  if (row.studentId !== studentId) {
    throw new HttpError(403, "FORBIDDEN", "只能查看自己的作答");
  }
  return row;
}

/**
 * 取本人 attempt 并按来源做访问权校验（T2A.6，D7/D22）：
 * - course 来源且 draft：每次调用都重校验 D5 可见性与成员资格——移出成员/课程
 *   归档 → 403 COURSE_ACCESS_DENIED；条目隐藏/未到发布/资源删除 → 404 NOT_FOUND
 *   （requireVisibleCourseUnit 统一口径）；
 * - course 来源且已交卷：只读记录，不做课程校验（D7：已交卷课程练习仍可回看）；
 * - assignment 来源：维持现状（归属即权限，被移出名单后已建作答仍可继续）。
 * 草稿保存、交卷、提示、笔迹、事件、详情（draft）全部经本函数进门。
 */
export function requireUsableAttempt(
  db: Db,
  studentId: string,
  attemptId: string,
): Attempt {
  const attempt = requireOwnAttempt(db, studentId, attemptId);
  if (attempt.sourceType === "course" && attempt.status === "draft") {
    requireVisibleCourseUnit(
      db,
      studentId,
      attempt.courseId ?? "",
      attempt.unitId ?? "",
    );
  }
  return attempt;
}

// ---------- 题目集合按来源分派（T2A.6；T2A.7 多单元化） ----------

/**
 * attempt 的有序单元 id 列表（T2A.7）：
 * - course 来源：[attempt.unitId]（单单元，创建时必写；防御性空列表兜底异常行；
 *   课程侧可见性由 requireVisibleCourseUnit 把关）；
 * - assignment 来源：该作业 assignment_units 按 order 升序的列表（作业行经 FK
 *   必存在——含已删作业，作答不随作业软删消失）。
 *   D16：**单元软删不影响作业通道**——引用行保留，题目照常下发/判分；
 *   只有 questions.deletedAt（T1.12 题目级软删）才把题从判分/快照口径排除。
 * 判分/快照/草稿/取卷/题目归属校验全部以本列表为唯一口径。
 */
export function attemptUnitIds(db: Db, attempt: Attempt): string[] {
  if (attempt.sourceType === "course") {
    return attempt.unitId !== null ? [attempt.unitId] : [];
  }
  const assignmentId = attempt.assignmentId;
  if (assignmentId === null) return []; // 防御性兜底：assignment 来源必写 assignmentId
  return db
    .select({ unitId: assignmentUnits.unitId })
    .from(assignmentUnits)
    .where(eq(assignmentUnits.assignmentId, assignmentId))
    .orderBy(asc(assignmentUnits.order), asc(assignmentUnits.unitId))
    .all()
    .map((row) => row.unitId);
}

/**
 * attempt 的判分/快照题目集合（按 sourceType 分派，D9；T2A.7 多单元拼接）：
 * 各单元未删除题按 (order, id) 升序后**按 attemptUnitIds 的单元顺序拼接**——
 * 题号全卷连续（D12），得分按全卷计算。course 来源为单单元的特例。
 */
export function attemptQuestionRows(db: Db, attempt: Attempt): QuestionRow[] {
  const unitIds = attemptUnitIds(db, attempt);
  if (unitIds.length === 0) return [];
  const rows = db
    .select()
    .from(questions)
    .where(and(inArray(questions.unitId, unitIds), isNull(questions.deletedAt)))
    .orderBy(asc(questions.order), asc(questions.id))
    .all();
  // 按单元顺序拼接（组内已按题序排序）
  const byUnit = new Map<string, QuestionRow[]>();
  for (const row of rows) {
    const list = byUnit.get(row.unitId);
    if (list === undefined) byUnit.set(row.unitId, [row]);
    else list.push(row);
  }
  return unitIds.flatMap((unitId) => byUnit.get(unitId) ?? []);
}

/**
 * attempt 的分组公开题目（T2A.7 草稿视图与通用取卷共用）：
 * assignment 按 assignment_units.order 分节（live 题数为 0 的单元不出现，与
 * 试卷口径一致）；course 恒单组（单元标题）。标题取单元当前值（D1 引用语义）。
 */
function attemptPublicUnitGroups(
  db: Db,
  attempt: Attempt,
): (AttemptDraftUnit & StudentPaperUnit)[] {
  const unitIds = attemptUnitIds(db, attempt);
  const groups: (AttemptDraftUnit & StudentPaperUnit)[] = [];
  for (const unitId of unitIds) {
    const unit = db
      .select({ title: units.title })
      .from(units)
      .where(eq(units.id, unitId))
      .get();
    if (unit === undefined) continue; // FK 保证存在，防御性跳过
    const questionsOfUnit = unitPublicQuestions(db, unitId);
    if (questionsOfUnit.length === 0) continue;
    groups.push({ id: unitId, title: unit.title, questions: questionsOfUnit });
  }
  return groups;
}

/** 答题页顶部展示的来源信息（assignment=作业标题+截止；course=单元标题+课程名） */
interface AttemptSourceMeta {
  title: string;
  courseName: string | null;
  dueAt: string | null;
}

function attemptSourceMeta(db: Db, attempt: Attempt): AttemptSourceMeta {
  if (attempt.sourceType === "course") {
    // 课程练习：标题 = 单元当前标题（D1 引用而非复制）；不限截止（D11 交卷即公布）
    const unit: Unit | undefined =
      attempt.unitId !== null
        ? db.select().from(units).where(eq(units.id, attempt.unitId)).get()
        : undefined;
    const course: Course | undefined =
      attempt.courseId !== null
        ? db
            .select()
            .from(courses)
            .where(eq(courses.id, attempt.courseId))
            .get()
        : undefined;
    return {
      title: unit?.title ?? "课程练习",
      courseName: course?.title ?? null,
      dueAt: null,
    };
  }
  const assignment = requireAssignmentRow(db, attempt.assignmentId ?? "");
  // T2A.7：作业挂了课程时返回课程名（来源行「作业 · 课程名」）；无课程为 null
  const course: Course | undefined =
    assignment.courseId !== null
      ? db
          .select()
          .from(courses)
          .where(eq(courses.id, assignment.courseId))
          .get()
      : undefined;
  return {
    title: assignment.title,
    courseName: course?.title ?? null,
    dueAt: assignment.dueAt,
  };
}

/**
 * 校验题目属于 attempt 的题目集合（attemptUnitIds 口径）且未软删，
 * 否则 404 QUESTION_NOT_FOUND（T2.8 ink-service 复用：笔迹上传与草稿答案同一口径）。
 * T2A.7 起多单元作业为**集合包含**判断：任一所属单元的题都可保存草稿/笔迹。
 */
export function requireAttemptQuestion(
  db: Db,
  attempt: Attempt,
  questionId: string,
): void {
  const question = db
    .select({
      id: questions.id,
      unitId: questions.unitId,
      deletedAt: questions.deletedAt,
    })
    .from(questions)
    .where(eq(questions.id, questionId))
    .get();
  if (
    question === undefined ||
    question.deletedAt !== null ||
    !attemptUnitIds(db, attempt).includes(question.unitId)
  ) {
    throw new HttpError(
      404,
      "QUESTION_NOT_FOUND",
      "题目不存在或不属于这次练习",
    );
  }
}

/** 校验学生被指派该作业且作业未删除，否则 403/404（与 T2.4 paper 接口同口径） */
function requireAssignmentVisible(
  db: Db,
  studentId: string,
  assignmentId: string,
): Assignment {
  const row = requireAssignmentRow(db, assignmentId);
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
      ),
    )
    .get();
  if (assigned === undefined) {
    throw new HttpError(403, "FORBIDDEN", "未被指派此作业，无权作答");
  }
  return row;
}

/** questions 行 → 契约 Question（判分输入与快照内容；解析失败的字段按缺省处理） */
function questionOfRow(row: QuestionRow, knowledge: string[]): Question {
  const answers: QuestionAnswers | undefined =
    row.answersJson !== null
      ? (questionAnswersSchema.safeParse(jsonOf(row.answersJson)).data ??
        undefined)
      : undefined;
  const options: QuestionOption[] | undefined =
    row.optionsJson !== null
      ? (optionSchema.array().safeParse(jsonOf(row.optionsJson)).data ??
        undefined)
      : undefined;
  return questionSchema.parse({
    id: row.id,
    type: row.type,
    difficulty: row.difficulty,
    knowledge,
    stemMd: row.stemMd,
    ...(options !== undefined ? { options } : {}),
    ...(answers !== undefined ? { answers } : {}),
    hints: hintsOfJson(row.hintsJson),
    ...(row.solutionMd !== null ? { solutionMd: row.solutionMd } : {}),
    sourceMd: row.sourceMd,
  });
}

/** JSON.parse 的窄化包装：坏数据返回 undefined（列由导入链路写入，正常必为合法 JSON） */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** answerJson → StudentAnswer（坏数据按未作答处理，不让单行脏数据打挂接口） */
function answerOf(answerJson: string | null): StudentAnswer | undefined {
  if (answerJson === null) return undefined;
  const parsed = studentAnswerSchema.safeParse(jsonOf(answerJson));
  return parsed.success ? parsed.data : undefined;
}

// ---------- POST /api/student/assignments/:id/attempt ----------

/**
 * 创建或取回作业来源的 attempt（幂等）：
 * - 作业不存在/已删除 → 404；未被指派 → 403；
 * - 已有进行中（draft）attempt → 直接返回它（一个作业一人一份进行中——
 *   本规则仅对 assignment 来源生效，D10）；
 * - 已交卷/已批 → 返回最近一份（status 告知前端直接进结果视图，不另开新卷；
 *   作业不重做，attemptNo 恒 1）；
 * - 否则插入新 draft attempt（courseId=作业所属课程、unitId=null——多单元
 *   题目集合走 assignment_units；sourceType=assignment）。
 */
export function startAttempt(
  db: Db,
  studentId: string,
  assignmentId: string,
): AttemptStartData {
  const assignment = requireAssignmentVisible(db, studentId, assignmentId);

  const existing = db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.studentId, studentId),
        eq(attempts.assignmentId, assignmentId),
      ),
    )
    .orderBy(desc(attempts.startedAt), desc(attempts.id))
    .all();
  // 进行中的那份优先（一人一份进行中）；没有 draft 则回最近一份已交的
  const draft = existing.find((row) => row.status === "draft");
  if (draft !== undefined) return attemptSummaryOf(draft);
  const latest = existing[0];
  if (latest !== undefined) return attemptSummaryOf(latest);

  const id = randomUUID();
  const startedAt = new Date().toISOString();
  db.insert(attempts)
    .values({
      id,
      studentId,
      sourceType: "assignment",
      assignmentId,
      // T2A.7：courseId 取作业所属课程（可空，D9/D13）；unitId 恒 null——
      // 多单元作业题目集合走 assignment_units（attemptUnitIds），不再落单单元
      courseId: assignment.courseId,
      unitId: null,
      attemptNo: 1,
      status: "draft",
      startedAt,
      submittedAt: null,
      activeSec: null,
      device: null,
      scoreAuto: null,
      scoreFinal: null,
    })
    .run();
  const row = db.select().from(attempts).where(eq(attempts.id, id)).get();
  if (row === undefined) {
    throw new HttpError(500, "INTERNAL", "创建作答失败，请重试");
  }
  return attemptSummaryOf(row);
}

// ---------- POST /api/student/courses/:cid/units/:uid/attempts（T2A.6） ----------

/**
 * 课程练习入口（D10）：
 * - 每次调用都先校验 D5 可见性（requireVisibleCourseUnit：非成员/归档 403、
 *   条目不可见 404，D22）；
 * - 存在未交卷（draft）作答 → 返回它（入口为「继续作答」）；
 * - 否则新建 attempt（attemptNo = 该 (学生, 课程, 单元) 历次最大值 + 1，从 1 起；
 *   新一次从空白开始——不预填上次答案与笔迹，历次记录互不影响）；
 * - 「(学生, 课程, 单元) 同时最多 1 份未交卷」在事务内先查后插保证：
 *   better-sqlite3 同步事务天然串行，并发两次 POST 只产生一份 draft。
 */
export function startCourseAttempt(
  db: Db,
  studentId: string,
  courseId: string,
  unitId: string,
): AttemptStartData {
  requireVisibleCourseUnit(db, studentId, courseId, unitId);

  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(attempts)
      .where(
        and(
          eq(attempts.studentId, studentId),
          eq(attempts.sourceType, "course"),
          eq(attempts.courseId, courseId),
          eq(attempts.unitId, unitId),
        ),
      )
      .all();
    const draft = existing.find((row) => row.status === "draft");
    if (draft !== undefined) return attemptSummaryOf(draft);

    const maxAttemptNo = existing.reduce(
      (max, row) => Math.max(max, row.attemptNo),
      0,
    );
    const id = randomUUID();
    tx.insert(attempts)
      .values({
        id,
        studentId,
        sourceType: "course",
        assignmentId: null,
        courseId,
        unitId,
        attemptNo: maxAttemptNo + 1,
        status: "draft",
        startedAt: new Date().toISOString(),
        submittedAt: null,
        activeSec: null,
        device: null,
        scoreAuto: null,
        scoreFinal: null,
      })
      .run();
    const row = tx.select().from(attempts).where(eq(attempts.id, id)).get();
    if (row === undefined) {
      throw new HttpError(500, "INTERNAL", "创建作答失败，请重试");
    }
    return attemptSummaryOf(row);
  });
}

// ---------- GET /api/student/attempts/:id/paper（T2A.6 通用取卷） ----------

/**
 * 通用取卷（两种来源共用同一响应形态 StudentPaperData）：
 * - course 来源：每次取卷都重校验可见性与成员资格（requireVisibleCourseUnit，
 *   draft 与已交一致——取卷是「看到这份练习题目」的入口，D22）；
 * - assignment 来源：与 GET /api/student/assignments/:id/paper 同口径
 *   （作业存在且未删 + 被指派，403/404 由 requireAssignmentVisible 给出）——
 *   该旧接口保留，内部经本函数复用；
 * - 题目经 attemptPublicUnitGroups 输出过滤（QuestionPublic，无答案/详解/提示）。
 */
export function getStudentAttemptPaper(
  db: Db,
  studentId: string,
  attemptId: string,
): StudentPaperData {
  const attempt = requireOwnAttempt(db, studentId, attemptId);
  if (attempt.sourceType === "course") {
    requireVisibleCourseUnit(
      db,
      studentId,
      attempt.courseId ?? "",
      attempt.unitId ?? "",
    );
  } else {
    requireAssignmentVisible(db, studentId, attempt.assignmentId ?? "");
  }
  // T2A.7：分组结构（assignment 按单元序分节、题号全卷连续；course 单组）
  return { units: attemptPublicUnitGroups(db, attempt) };
}

// ---------- PUT /api/student/attempts/:id/answers/:questionId ----------

/**
 * 保存草稿答案（draft 阶段专用）：
 * - attempt 不存在 → 404；非本人 → 403；已交卷 → 409 ALREADY_SUBMITTED；
 * - 题目必须属于该作业单元且未软删 → 否则 404 QUESTION_NOT_FOUND；
 * - upsert responses（(attemptId, questionId) 唯一键）：写 answerJson，
 *   changeCount 每次 +1（T2.10 起用于改答案次数统计）；
 * - 快照与判分不在此做（都在交卷时按 questions 当前内容一次性写入）。
 * 答案与题型不匹配（如给选择题提交 judge 答案）不在此拦截：交卷时 grade 按
 * kind 不匹配判 null（待批），前端控件只发对应形态（见任务报告「待决问题」）。
 */
export function saveDraftAnswer(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  answer: StudentAnswer,
): AttemptAnswerSaveData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (attempt.status !== "draft") {
    throw new HttpError(
      409,
      "ALREADY_SUBMITTED",
      "这份练习已交卷，不能再修改答案",
    );
  }
  requireAttemptQuestion(db, attempt, questionId);

  const answerJson = JSON.stringify(answer);
  const existing = db
    .select({ id: responses.id, changeCount: responses.changeCount })
    .from(responses)
    .where(
      and(
        eq(responses.attemptId, attemptId),
        eq(responses.questionId, questionId),
      ),
    )
    .get();
  if (existing === undefined) {
    db.insert(responses)
      .values({
        id: randomUUID(),
        attemptId,
        questionId,
        questionVersion: 0,
        questionSnapshotJson: null,
        answerJson,
        autoCorrect: null,
        finalCorrect: null,
        teacherMark: null,
        teacherComment: null,
        activeSec: null,
        hintsUsed: 0,
        changeCount: 1,
        inkId: null,
      })
      .run();
    return { questionId, changeCount: 1 };
  }
  const nextCount = existing.changeCount + 1;
  db.update(responses)
    .set({ answerJson, changeCount: nextCount })
    .where(eq(responses.id, existing.id))
    .run();
  return { questionId, changeCount: nextCount };
}

// ---------- POST /api/student/attempts/:id/submit ----------

/** 交卷时逐题的判分中间结果（先在内存算完再进事务写入） */
interface GradedResponse {
  /** questions 当前行（版本与快照的来源） */
  row: QuestionRow;
  /** 契约 Question（快照内容、判分输入） */
  question: Question;
  /** 学生答案（草稿；未作为 undefined） */
  answer: StudentAnswer | undefined;
  /** 服务端判分结果：true/false/null（null=不能自动判定：未作答/无标准答案/手写未填） */
  autoCorrect: boolean | null;
}

/** scoreAuto 口径：答对数 / 可自动判分数（autoCorrect 非 null），四舍五入百分比；无可判分为 null */
function scoreAutoOf(graded: readonly GradedResponse[]): number | null {
  const autoGradable = graded.filter((g) => g.autoCorrect !== null).length;
  if (autoGradable === 0) return null;
  const correct = graded.filter((g) => g.autoCorrect === true).length;
  return Math.round((correct / autoGradable) * 100);
}

/**
 * 交卷（服务端权威判分）：
 * - attempt 不存在 → 404；非本人 → 403；已交卷 → 409 ALREADY_SUBMITTED（验收项）；
 * - 逐题（单元内未软删的题，按题序）：
 *   - 快照：questions 当前行 → 契约 Question 序列化入 questionSnapshotJson，
 *     questionVersion 记当前版本（此后教师编辑 version+1 不影响本行，验收项）；
 *   - 判分：grade(question, answer)（@tutor/grading，未作答 answer=undefined → null）；
 *   - 未作答也写 responses 行（answerJson=null、autoCorrect=null）——保证
 *     「逐题结果视图」与题目视角统计（T4.1）有完整行覆盖；
 *   - activeSec：T2.10 起按 events 表事件序列计算（computePerQuestionActiveSec，
 *     不信任客户端汇总值，§5.5）；无事件的题保持 NULL；
 *   - changeCount：T2.10 口径 = max(草稿期 PUT 计数, answer_change 事件数)——
 *     事件计数为权威（每次有效修改一条），草稿计数兜底（无前端事件的 attempt，
 *     如脚本直接调 API 交卷）；
 * - 草稿期被软删的题目不进入本次作答（其草稿行清除）；
 * - hintsUsed 与已解锁序号集合（hintsOpenedJson）保留草稿期累计值
 *   （T2.11 语义：交卷后仍可回看自己解锁过的提示）；
 * - attempt.status=submitted、submittedAt、scoreAuto 汇总、activeSec 总用时
 *   （各题之和；无任何事件时保持 NULL）；
 * - 返回结果视图（含答案与详解，AGENTS 第 3 条的「未交卷」限制就此解除；
 *   T2A.8 例外：answerRelease='after_due' 且交卷瞬间未到截止时，响应同样是
 *   受限形态——只下发本人答案，截止后恢复完整）。
 *
 * now 可注入（T2A.8 定时测试；默认当前时刻，submittedAt 亦取该时刻）。
 */
export function submitAttempt(
  db: Db,
  studentId: string,
  attemptId: string,
  now: Date | string = new Date(),
): AttemptResultData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (attempt.status !== "draft") {
    throw new HttpError(409, "ALREADY_SUBMITTED", "这份练习已经交过卷了");
  }

  // 判分输入：attempt 题目集合（按 sourceType 分派，T2A.6）+ 各题考点 + 草稿答案
  const liveRows = attemptQuestionRows(db, attempt);
  const knowledge = knowledgeNamesByQuestion(db);
  const draftRows = db
    .select()
    .from(responses)
    .where(eq(responses.attemptId, attemptId))
    .all();
  const draftByQuestion = new Map(
    draftRows.map((row) => [row.questionId, row]),
  );

  // T2.10：每题有效用时与改答案次数（服务端按事件序列计算，§5.5）
  const timeline = attemptTimeline(db, attemptId);
  const activeSecByQuestion = computePerQuestionActiveSec(timeline);
  const eventChangeCountByQuestion = countAnswerChanges(timeline);

  const graded: GradedResponse[] = liveRows.map((row) => {
    const question = questionOfRow(row, knowledge.get(row.id) ?? []);
    const draftRow = draftByQuestion.get(row.id);
    const answer = answerOf(draftRow?.answerJson ?? null);
    return { row, question, answer, autoCorrect: grade(question, answer) };
  });
  const scoreAuto = scoreAutoOf(graded);

  const nowIso = new Date(now).toISOString();
  const liveIds = new Set(graded.map((g) => g.row.id));
  db.transaction((tx) => {
    for (const g of graded) {
      const answerJson =
        g.answer !== undefined ? JSON.stringify(g.answer) : null;
      const draftRow = draftByQuestion.get(g.row.id);
      tx.insert(responses)
        .values({
          id: randomUUID(),
          attemptId,
          questionId: g.row.id,
          questionVersion: g.row.version,
          questionSnapshotJson: JSON.stringify(g.question),
          answerJson,
          autoCorrect: g.autoCorrect,
          finalCorrect: null,
          teacherMark: null,
          teacherComment: null,
          activeSec: activeSecByQuestion[g.row.id] ?? null,
          hintsUsed: draftRow?.hintsUsed ?? 0,
          changeCount: Math.max(
            draftRow?.changeCount ?? 0,
            eventChangeCountByQuestion[g.row.id] ?? 0,
          ),
          inkId: null,
          hintsOpenedJson: draftRow?.hintsOpenedJson ?? null,
        })
        // 同题已有草稿行 → 交卷语义是整行冻结重写（保留 hintsUsed，其余以本次计算为准）
        .onConflictDoUpdate({
          target: [responses.attemptId, responses.questionId],
          set: {
            questionVersion: g.row.version,
            questionSnapshotJson: JSON.stringify(g.question),
            answerJson,
            autoCorrect: g.autoCorrect,
            activeSec: activeSecByQuestion[g.row.id] ?? null,
            changeCount: Math.max(
              draftRow?.changeCount ?? 0,
              eventChangeCountByQuestion[g.row.id] ?? 0,
            ),
          },
        })
        .run();
    }
    // 草稿期被软删/移出单元的题目：清除其草稿行（不构成本次作答的一部分）
    const staleIds = draftRows
      .map((row) => row.questionId)
      .filter((questionId) => !liveIds.has(questionId));
    if (staleIds.length > 0) {
      tx.delete(responses)
        .where(
          and(
            eq(responses.attemptId, attemptId),
            inArray(responses.questionId, staleIds),
          ),
        )
        .run();
    }
    tx.update(attempts)
      .set({
        status: "submitted",
        submittedAt: nowIso,
        scoreAuto,
        // 总有效用时 = 各题之和；无任何 focus 序列（未计算）保持 NULL
        activeSec:
          Object.keys(activeSecByQuestion).length > 0
            ? Object.values(activeSecByQuestion).reduce(
                (sum, sec) => sum + sec,
                0,
              )
            : null,
      })
      .where(eq(attempts.id, attemptId))
      .run();
  });

  return buildResultData(db, attemptId, now);
}

// ---------- GET /api/student/attempts/:id ----------

/**
 * attempt 详情：按 status 二选一。
 * - draft → 草稿视图：公开题目（QuestionPublic 形态，题干脱敏）+ 本人草稿答案
 *   （drafts 键）+ 已解锁提示（hintsOpened 键）。绝不含答案/详解/未请求提示
 *   （泄露测试用 assertNoLeak 默认集合锁定）；
 * - submitted/graded → 结果视图：逐题快照 + 参考答案 + 详解 + 本人答案 +
 *   autoCorrect + 做题时已解锁提示（回看），得分汇总 + scoreAuto。
 *   T2A.8：assignment 来源 answerRelease='after_due' 且未到截止 → 受限形态
 *   （answersReleased=false，见 buildResultData 注释）。
 * now 可注入（T2A.8 定时测试；默认当前时刻）。
 */
export function getAttemptDetail(
  db: Db,
  studentId: string,
  attemptId: string,
  now: Date | string = new Date(),
): AttemptDetailData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (attempt.status === "draft") {
    return buildDraftData(db, attempt);
  }
  return buildResultData(db, attemptId, now);
}

/**
 * 草稿视图组装（题目经 attemptPublicUnitGroups：按来源分派分组 + QuestionPublic 投影）。
 * course 来源的 draft 在 requireUsableAttempt 已过 D5 门（失去访问权 403）。
 */
function buildDraftData(db: Db, attempt: Attempt): AttemptDraftData {
  const meta = attemptSourceMeta(db, attempt);
  const unitGroups = attemptPublicUnitGroups(db, attempt);
  const draftRows = db
    .select({
      questionId: responses.questionId,
      answerJson: responses.answerJson,
    })
    .from(responses)
    .where(eq(responses.attemptId, attempt.id))
    .all();
  const drafts: Record<string, StudentAnswer> = {};
  for (const row of draftRows) {
    const answer = answerOf(row.answerJson);
    if (answer !== undefined) drafts[row.questionId] = answer;
  }
  return {
    attempt: attemptSummaryOf(attempt),
    title: meta.title,
    courseName: meta.courseName,
    dueAt: meta.dueAt,
    // T2A.7：题目按单元分组（与试卷同口径；空单元不出现）
    units: unitGroups,
    drafts,
    // T2.11：已解锁提示回显（刷新页面后提示面板不丢；只含学生请求过的条目）
    hintsOpened: draftHintsOpenedView(db, attempt),
  };
}

/** 结果视图的单题行（快照投影：除已解锁条目外无 hints 内容，options 转纯文本） */
function resultQuestionOf(row: ResponseRow): AttemptResultQuestion | null {
  const snapshotJson = row.questionSnapshotJson;
  if (snapshotJson === null) return null; // 理论不可达：交卷必写快照（防御性跳过）
  const parsed = questionSchema.safeParse(jsonOf(snapshotJson));
  if (!parsed.success) {
    // 可观测性留痕（不改变按缺失计的既有行为）：快照坏数据此前静默跳过，
    // 服务层拿不到 app 层 pino 实例，用统一前缀 console.warn 便于检索
    console.warn(
      `【数据异常】attempt-service：responses.questionSnapshotJson 解析失败，结果视图该题按缺失计（attemptId=${row.attemptId}，questionId=${row.questionId}）`,
    );
    return null;
  }
  const snapshot = parsed.data;
  return {
    questionId: row.questionId,
    snapshot: {
      id: snapshot.id,
      type: snapshot.type,
      difficulty: snapshot.difficulty,
      knowledge: snapshot.knowledge,
      stemMd: snapshot.stemMd,
      ...(snapshot.options !== undefined
        ? { options: snapshot.options.map((option) => option.text) }
        : {}),
      hintCount: snapshot.hints.length,
    },
    answers: snapshot.answers ?? null,
    solutionMd: snapshot.solutionMd ?? null,
    answer: answerOf(row.answerJson) ?? null,
    autoCorrect: row.autoCorrect,
    // T2.11：只回显做题时已解锁的提示（文本取自快照；未解锁条目绝不在此）
    hintsOpened: resultHintsOpenedOf(row, snapshot.hints),
  };
}

/** 得分汇总（口径与 scoreAutoOf 一致：scoreAuto = correct/autoGradable 百分比） */
function scoreSummaryOf(
  rows: readonly AttemptResultQuestion[],
): AttemptScoreSummary {
  const total = rows.length;
  const answered = rows.filter((r) => r.answer !== null).length;
  const correct = rows.filter((r) => r.autoCorrect === true).length;
  const wrong = rows.filter((r) => r.autoCorrect === false).length;
  const pending = rows.filter((r) => r.autoCorrect === null).length;
  return {
    total,
    answered,
    correct,
    wrong,
    pending,
    unanswered: total - answered,
    autoGradable: correct + wrong,
  };
}

/**
 * 结果视图组装（T2A.7 分组化；T2A.8 公布时机）：responses 行按**单元序 + 题序**
 * 分组排列（assignment 按 assignment_units.order；course 单组；快照内容仍以冻结行
 * 为准，排序只影响展示顺序，题号全卷连续）。无快照的行（异常数据）被跳过并按缺失
 * 计——正常链路不发生。历史/异常兜底：题目单元已不在 attempt 单元集合内的行
 * （交卷后题目被移动单元等）按单元标题追加在末尾，不丢数据。
 * 历次记录的每次结果都使用各自 attempt 的 responses 快照行（D10：重做各次独立）。
 *
 * T2A.8（D11）公布时机：assignment 来源按作业 answerRelease + dueAt 与 now 判定
 * （answersReleased 纯函数）；course 来源恒公布。未公布（受限形态）时逐题
 * answers/solutionMd/autoCorrect 置 null、stemMd 经 publicStemMd 公开化（快照题干
 * 含 [[答案]] 标记，与草稿视图同一防泄露口径）、attempt.scoreAuto 置 null 投影
 * （库里保留）、summary 的对错计数不泄露（correct/wrong/autoGradable=0、
 * pending=answered 口径——每道已答题显示为「待批」）。本人答案与已解锁提示照常。
 * now 可注入（定时测试；默认当前时刻，截止后下一次请求自动恢复完整形态）。
 */
function buildResultData(
  db: Db,
  attemptId: string,
  now: Date | string = new Date(),
): AttemptResultData {
  const attempt = requireAttemptRow(db, attemptId);
  const meta = attemptSourceMeta(db, attempt);
  // T2A.8：assignment 来源按作业判定；course 来源恒公布（D11 课程练习交卷即公布）
  const assignmentRow =
    attempt.sourceType === "assignment"
      ? requireAssignmentRow(db, attempt.assignmentId ?? "")
      : null;
  const released =
    assignmentRow === null || answersReleased(assignmentRow, now);

  /** 受限形态的逐题投影（见函数头注释；已公布时原样返回） */
  const releaseAwareQuestion = (item: AttemptResultQuestion) =>
    released
      ? item
      : {
          ...item,
          snapshot: {
            ...item.snapshot,
            // 快照题干含 [[答案]] 标记：公开化后再下发（与草稿视图同口径）
            stemMd: publicStemMd(item.snapshot.stemMd),
          },
          answers: null,
          solutionMd: null,
          autoCorrect: null,
        };

  const rows = db
    .select({
      response: responses,
      order: questions.order,
      questionId: questions.id,
      unitId: questions.unitId,
    })
    .from(responses)
    .innerJoin(questions, eq(responses.questionId, questions.id))
    .where(eq(responses.attemptId, attemptId))
    .orderBy(asc(questions.order), asc(questions.id))
    .all();
  const resultByQuestion = new Map<string, AttemptResultQuestion>();
  for (const row of rows) {
    const item = resultQuestionOf(row.response);
    if (item !== null) {
      resultByQuestion.set(row.questionId, releaseAwareQuestion(item));
    }
  }
  const resultQuestions = [...resultByQuestion.values()];

  // 分组：先按 attempt 单元顺序，同单元内按题序（rows 已按题序，组内保持）
  const unitIds = attemptUnitIds(db, attempt);
  const unitIndex = new Map(unitIds.map((unitId, i) => [unitId, i]));
  const questionsByUnit = new Map<string, AttemptResultQuestion[]>();
  for (const row of rows) {
    const item = resultByQuestion.get(row.questionId);
    if (item === undefined) continue;
    const list = questionsByUnit.get(row.unitId);
    if (list === undefined) questionsByUnit.set(row.unitId, [item]);
    else list.push(item);
  }
  const orderedUnitIds = [
    ...unitIds,
    ...[...questionsByUnit.keys()].filter((unitId) => !unitIndex.has(unitId)),
  ];
  const unitTitleById = new Map(
    orderedUnitIds.length > 0
      ? db
          .select({ id: units.id, title: units.title })
          .from(units)
          .where(inArray(units.id, orderedUnitIds))
          .all()
          .map((row) => [row.id, row.title] as const)
      : [],
  );
  const unitGroups: AttemptResultUnit[] = [];
  for (const unitId of orderedUnitIds) {
    const questionsOfUnit = questionsByUnit.get(unitId);
    if (questionsOfUnit === undefined || questionsOfUnit.length === 0) continue;
    unitGroups.push({
      id: unitId,
      title: unitTitleById.get(unitId) ?? unitId,
      questions: questionsOfUnit,
    });
  }

  // 得分汇总：未公布时不泄露对错——correct/wrong/autoGradable 置 0，
  // pending 按 answered 口径（每道已答题显示为「待批」，截止后恢复真实计数）
  const fullSummary = scoreSummaryOf(resultQuestions);
  const summary = released
    ? fullSummary
    : {
        total: fullSummary.total,
        answered: fullSummary.answered,
        correct: 0,
        wrong: 0,
        pending: fullSummary.answered,
        unanswered: fullSummary.unanswered,
        autoGradable: 0,
      };

  // scoreAuto 同理：未公布时置 null 投影（库里保留，教师侧统计不受影响）
  const attemptProjection = attemptSummaryOf(attempt);

  return {
    attempt: released
      ? attemptProjection
      : { ...attemptProjection, scoreAuto: null },
    title: meta.title,
    courseName: meta.courseName,
    dueAt: meta.dueAt,
    answersReleased: released,
    summary,
    units: unitGroups,
  };
}

/** 结果视图取 attempt 行（不经学生鉴权——调用方 submitAttempt/getAttemptDetail 已校验归属） */
function requireAttemptRow(db: Db, attemptId: string): Attempt {
  const row = db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .get();
  if (!row) {
    throw new HttpError(404, "ATTEMPT_NOT_FOUND", "作答记录不存在");
  }
  return row;
}
