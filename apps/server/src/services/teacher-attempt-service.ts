import type {
  Question,
  StudentAnswer,
  TeacherAttemptCard,
  TeacherAttemptDetailData,
  TeacherAttemptDetailQuestion,
  TeacherAttemptInkInfo,
  TeacherAttemptListData,
  TeacherAttemptListQuery,
  TeacherAttemptSource,
} from "@tutor/contract";
import {
  optionSchema,
  questionSchema,
  studentAnswerSchema,
} from "@tutor/contract";
import { publicStemMd } from "@tutor/md-dsl";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  assignments,
  attempts,
  courses,
  type InkRow,
  ink,
  questions,
  type ResponseRow,
  responses,
  students,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { knowledgeNamesByQuestion } from "./assignment-service";
import { attemptQuestionRows, attemptUnitIds } from "./attempt-service";
import { pendingMarkCount } from "./pending-mark.ts";

/**
 * TeacherAttemptService（T3.1，Phase3 清单 D5–D8）——教师端作答数据页业务层：
 * - listTeacherAttempts：attempt → student → teacherId 归属过滤（乙教师查不到
 *   甲学生的作答）+ 筛选组合 + 按最近活动时间（submittedAt ?? startedAt）倒序
 *   + 分页 limit/offset 与 total；来源上下文名经 join 组装（assignments.title /
 *   units.title / courses.title / attemptNo）；
 * - getTeacherAttemptDetail：D7 全字段逐题视图。draft 亦可用（D5）——题目列表
 *   取当前库该 attempt 单元的 live 题目（与学生草稿视图同源，未答题也有行），
 *   整卷不下发参考答案/详解；已交卷取 responses.questionSnapshotJson（含答案
 *   与详解）；手写信息一律按 ink 表 (attemptId, questionId) 关联（D7：不读
 *   responses.inkId——该列从未写入，draft 也可能有笔迹）；全卷连续题号按
 *   attempt 单元顺序 × 题目顺序编排。
 *
 * 权限口径（T2B 域隔离红线）：attempt 归属链 attempt → student → teacherId，
 * 非本人学生的作答按不存在处理（404 ATTEMPT_NOT_FOUND，不暴露存在性）。
 * 题目/单元读取按该 teacherId 域内进行（attemptTeacherId 同源推导）。
 */

/**
 * 判定展示口径（D2/D3 前置约定）：`finalCorrect ?? autoCorrect`——教师批改
 * （T3.2 落地）优先，否则回落自动判定。汇总计数（详情头对/错/待批）统一用它；
 * 本阶段 finalCorrect 恒 null，等价于 autoCorrect。
 */
export function effectiveCorrect(
  finalCorrect: boolean | null,
  autoCorrect: boolean | null,
): boolean | null {
  return finalCorrect ?? autoCorrect;
}

/** 最近活动时间排序键（D6/D10 同一口径：submittedAt ?? startedAt） */
const lastActivitySql = sql`coalesce(${attempts.submittedAt}, ${attempts.startedAt})`;

/** JSON.parse 的窄化包装：坏数据返回 undefined（列由写入链路保证为合法 JSON） */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** answerJson → StudentAnswer（坏数据按未作答 null 处理，不让单行脏数据打挂接口）；
 * T3.2b 起导出——待批队列卡片拼装复用（mark-response.ts） */
export function answerOf(answerJson: string | null): StudentAnswer | null {
  if (answerJson === null) return null;
  const parsed = studentAnswerSchema.safeParse(jsonOf(answerJson));
  return parsed.success ? parsed.data : null;
}

/** optionsJson → 选项纯文本数组（教师端详情展示选项原文；解析失败不带该字段） */
function optionTexts(optionsJson: string | null): string[] | undefined {
  if (optionsJson === null) return undefined;
  const parsed = optionSchema.array().safeParse(jsonOf(optionsJson));
  return parsed.success ? parsed.data.map((option) => option.text) : undefined;
}

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
 * course=单元标题 + 课程名 + attemptNo（「单元标题 · 第 n 次」）。
 * 单元/课程按 teacherId 域内读；assignment 行经 FK 必存在（含已软删作业——
 * 作答记录不随作业删除消失，标题为布置时快照），异常缺失时兜底占位文案。
 * T3.2b 起导出——待批队列卡片拼装复用（mark-response.ts）。
 */
export function sourceOf(
  db: Db,
  attempt: Attempt,
  teacherId: string,
): TeacherAttemptSource {
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

/** 单元 id → 标题（teacherId 域内；软删单元行保留，标题仍可读，D16） */
function unitTitleByIdOf(
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
): TeacherAttemptListData {
  const filters = [
    query.studentId !== undefined
      ? eq(attempts.studentId, query.studentId)
      : undefined,
    query.courseId !== undefined
      ? eq(attempts.courseId, query.courseId)
      : undefined,
    query.assignmentId !== undefined
      ? eq(attempts.assignmentId, query.assignmentId)
      : undefined,
    query.unitId !== undefined ? eq(attempts.unitId, query.unitId) : undefined,
    query.sourceType !== undefined
      ? eq(attempts.sourceType, query.sourceType)
      : undefined,
    query.status !== undefined ? eq(attempts.status, query.status) : undefined,
    query.from !== undefined
      ? sql`${lastActivitySql} >= ${query.from}`
      : undefined,
    query.to !== undefined ? sql`${lastActivitySql} <= ${query.to}` : undefined,
  ].filter((item): item is NonNullable<typeof item> => item !== undefined);

  const where = and(eq(students.teacherId, teacherId), ...filters);
  const totalRow = db
    .select({ n: sql<number>`count(*)` })
    .from(attempts)
    .innerJoin(students, eq(attempts.studentId, students.id))
    .where(where)
    .get();
  const rows = db
    .select({ attempt: attempts, studentName: students.displayName })
    .from(attempts)
    .innerJoin(students, eq(attempts.studentId, students.id))
    .where(where)
    .orderBy(desc(lastActivitySql), desc(attempts.id))
    .limit(query.limit)
    .offset(query.offset)
    .all();

  const cards: TeacherAttemptCard[] = rows.map(({ attempt, studentName }) => ({
    attemptId: attempt.id,
    studentId: attempt.studentId,
    studentName,
    ...sourceOf(db, attempt, teacherId),
    unitCount: attemptUnitIds(db, attempt).length,
    questionCount:
      attempt.status === "draft"
        ? attemptQuestionRows(db, attempt).length
        : (db
            .select({ n: sql<number>`count(*)` })
            .from(responses)
            .where(eq(responses.attemptId, attempt.id))
            .get()?.n ?? 0),
    status: attempt.status,
    scoreAuto: attempt.scoreAuto,
    scoreFinal: attempt.scoreFinal,
    // D4 共享待批谓词（finalCorrect IS NULL；draft 恒 0）——与详情/矩阵/单元卡片同口径
    pendingCount: pendingMarkCount(db, attempt),
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    activeSec: attempt.activeSec,
  }));
  return { attempts: cards, total: totalRow?.n ?? 0 };
}

// ---------- GET /api/teacher/attempts/:id ----------

/** attempt 行（经学生归属链）：不存在或非本人学生的作答 → 404（不暴露存在性） */
function requireTeacherAttempt(
  db: Db,
  teacherId: string,
  attemptId: string,
): { attempt: Attempt; studentName: string } {
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
    throw new HttpError(404, "ATTEMPT_NOT_FOUND", "作答记录不存在");
  }
  return { attempt: row.attempt, studentName: row.studentName };
}

/**
 * 已交卷逐题的题目快照（responses.questionSnapshotJson → 契约 Question；
 * 坏数据按缺失计并留痕——正常链路交卷必写快照，与 attempt-service 同口径）。
 * T3.2b 起导出——待批队列卡片拼装复用（mark-response.ts）。
 */
export function snapshotOf(row: ResponseRow): Question | null {
  if (row.questionSnapshotJson === null) return null;
  const parsed = questionSchema.safeParse(jsonOf(row.questionSnapshotJson));
  if (!parsed.success) {
    console.warn(
      `【数据异常】teacher-attempt-service：responses.questionSnapshotJson 解析失败，详情该题按缺失计（attemptId=${row.attemptId}，questionId=${row.questionId}）`,
    );
    return null;
  }
  return parsed.data;
}

/**
 * 教师端作答详情（D7 全字段；draft 亦可用，D5）：
 * - draft：题目取当前库该 attempt 单元的 live 题目（attemptQuestionRows，与学生
 *   草稿视图同源——未答题也有行），题干经 publicStemMd 公开化（详情不下发参考
 *   答案，题干标记里的答案同样不外露）；判定字段整卷 null（判定列显示「未交卷」）；
 *   answers / solutionMd 字段缺省不发；
 * - submitted / graded：逐题取 responses 冻结行（快照题干原文含 [[答案]] 标记、
 *   参考答案与详解照常下发——教师端不受泄露约束，改判与待批卡片都要用）；
 *   排序 join 当前 questions（teacherId 域内）提供单元归属与题序，快照内容仍以
 *   冻结行为准（与 attempt-service 结果视图同口径；题目移出单元等异常行按单元
 *   标题追加在末尾，不丢数据）；
 * - 手写信息：ink 表 (attemptId, questionId) 关联（draft 也可能有笔迹无行）；
 * - 全卷连续题号：attempt 单元顺序 × 题目顺序，1 起；
 * - 计数：effectiveCorrect（finalCorrect ?? autoCorrect）口径；draft 全 0。
 */
export function getTeacherAttemptDetail(
  db: Db,
  teacherId: string,
  attemptId: string,
): TeacherAttemptDetailData {
  const { attempt, studentName } = requireTeacherAttempt(
    db,
    teacherId,
    attemptId,
  );
  const source = sourceOf(db, attempt, teacherId);
  const inkByQuestion = inkByQuestionOf(db, attemptId);
  const unitIds = attemptUnitIds(db, attempt);

  // 逐题条目（先按单元归属排序，再统一编号）
  const items: Omit<TeacherAttemptDetailQuestion, "no">[] = [];
  if (attempt.status === "draft") {
    // draft：当前库 live 题目 + 草稿答案（attemptQuestionRows 已按单元序 × 题序拼接）
    const questionRows = attemptQuestionRows(db, attempt);
    const knowledge = knowledgeNamesByQuestion(db, teacherId);
    const draftRows = db
      .select({
        questionId: responses.questionId,
        answerJson: responses.answerJson,
        hintsUsed: responses.hintsUsed,
        changeCount: responses.changeCount,
        activeSec: responses.activeSec,
      })
      .from(responses)
      .where(eq(responses.attemptId, attemptId))
      .all();
    const draftByQuestion = new Map(
      draftRows.map((row) => [row.questionId, row] as const),
    );
    for (const row of questionRows) {
      const draft = draftByQuestion.get(row.id);
      const options = optionTexts(row.optionsJson);
      items.push({
        questionId: row.id,
        unitId: row.unitId,
        unitTitle: row.unitId, // 占位，下方经 unitTitles 统一回填
        type: row.type,
        difficulty: row.difficulty,
        knowledge: knowledge.get(row.id) ?? [],
        stemMd: publicStemMd(row.stemMd),
        ...(options !== undefined ? { options } : {}),
        answer: answerOf(draft?.answerJson ?? null),
        autoCorrect: null,
        finalCorrect: null,
        teacherMark: null,
        teacherComment: null,
        activeSec: draft?.activeSec ?? null,
        hintsUsed: draft?.hintsUsed ?? 0,
        changeCount: draft?.changeCount ?? 0,
        ink: inkInfoOf(inkByQuestion.get(row.id)),
      });
    }
  } else {
    // 已交卷：responses 冻结行（快照内容）+ 当前 questions 提供单元归属与排序
    const rows = db
      .select({
        response: responses,
        order: questions.order,
        questionUnitId: questions.unitId,
        questionId: questions.id,
      })
      .from(responses)
      .innerJoin(
        questions,
        and(
          eq(responses.questionId, questions.id),
          eq(questions.teacherId, teacherId),
        ),
      )
      .where(eq(responses.attemptId, attemptId))
      .orderBy(asc(questions.order), asc(questions.id))
      .all();
    const unitIndex = new Map(unitIds.map((unitId, i) => [unitId, i]));
    // 按 attempt 单元顺序分组（组内保持题序）；题目单元已不在集合内的异常行追加在末尾
    const groups = new Map<
      string,
      { response: ResponseRow; order: number }[]
    >();
    for (const row of rows) {
      const list = groups.get(row.questionUnitId);
      if (list === undefined) groups.set(row.questionUnitId, [row]);
      else list.push(row);
    }
    const orderedUnitIds = [
      ...unitIds,
      ...[...groups.keys()].filter((unitId) => !unitIndex.has(unitId)),
    ];
    for (const unitId of orderedUnitIds) {
      const group = groups.get(unitId);
      if (group === undefined) continue;
      for (const { response } of group) {
        const snapshot = snapshotOf(response);
        if (snapshot === null) continue; // 坏快照按缺失计（见 snapshotOf 注释）
        items.push({
          questionId: response.questionId,
          unitId,
          unitTitle: unitId, // 占位，下方经 unitTitles 统一回填
          type: snapshot.type,
          difficulty: snapshot.difficulty,
          knowledge: snapshot.knowledge,
          stemMd: snapshot.stemMd,
          ...(snapshot.options !== undefined
            ? { options: snapshot.options.map((option) => option.text) }
            : {}),
          answer: answerOf(response.answerJson),
          autoCorrect: response.autoCorrect,
          finalCorrect: response.finalCorrect,
          teacherMark:
            response.teacherMark === "correct" ||
            response.teacherMark === "wrong"
              ? response.teacherMark
              : null,
          teacherComment: response.teacherComment,
          activeSec: response.activeSec,
          hintsUsed: response.hintsUsed,
          changeCount: response.changeCount,
          ink: inkInfoOf(inkByQuestion.get(response.questionId)),
          answers: snapshot.answers ?? null,
          solutionMd: snapshot.solutionMd ?? null,
        });
      }
    }
  }

  // 单元标题统一回填（域内读，含软删单元；draft 与已交卷同口径）
  const unitTitles = unitTitleByIdOf(
    db,
    teacherId,
    items.map((item) => item.unitId),
  );
  const questionsOut: TeacherAttemptDetailQuestion[] = items.map(
    (item, index) => ({
      ...item,
      unitTitle: unitTitles.get(item.unitId) ?? item.unitId,
      no: index + 1,
    }),
  );

  // 判定计数（effectiveCorrect 口径）；draft 未交卷无判定，对/错/待批全 0（D5）
  const judged =
    attempt.status === "draft"
      ? []
      : questionsOut.map((item) =>
          effectiveCorrect(item.finalCorrect, item.autoCorrect),
        );
  return {
    attemptId: attempt.id,
    studentId: attempt.studentId,
    studentName,
    ...source,
    status: attempt.status,
    scoreAuto: attempt.scoreAuto,
    scoreFinal: attempt.scoreFinal,
    correctCount: judged.filter((value) => value === true).length,
    wrongCount: judged.filter((value) => value === false).length,
    pendingCount: judged.filter((value) => value === null).length,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    activeSec: attempt.activeSec,
    questions: questionsOut,
  };
}
