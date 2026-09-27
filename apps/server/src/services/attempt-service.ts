import { randomUUID } from "node:crypto";
import {
  type AttemptAnswerSaveData,
  type AttemptDetailData,
  type AttemptResultData,
  type AttemptResultQuestion,
  type AttemptScoreSummary,
  type AttemptStartData,
  optionSchema,
  type Question,
  type QuestionAnswers,
  type QuestionOption,
  type QuestionPublic,
  questionAnswersSchema,
  questionSchema,
  type StudentAnswer,
  studentAnswerSchema,
} from "@tutor/contract";
import { grade } from "@tutor/grading";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Assignment,
  type Attempt,
  assignmentStudents,
  assignments,
  attempts,
  type Question as QuestionRow,
  questions,
  type ResponseRow,
  responses,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { computePerQuestionActiveSec, countAnswerChanges } from "./active-time";
import {
  knowledgeNamesByQuestion,
  unitPublicQuestions,
} from "./assignment-service";
import { attemptTimeline } from "./event-service";
import {
  draftHintsOpenedView,
  hintsOfJson,
  resultHintsOpenedOf,
} from "./hint-service";

/**
 * AttemptService（T2.6）——作答生命周期的业务层（架构文档 §5.2/§5.3/§5.6）。
 * 路由只做「鉴权 → 校验 → 调 service → 包装响应」（api-endpoint 技能约定），本模块承载：
 *
 * - startAttempt：创建或取回进行中的 attempt（幂等：一个作业一人一份进行中）；
 *   已交卷后再 POST 返回已交的那份（前端据此直接进结果视图，不另开新卷）；
 * - saveDraftAnswer：draft 阶段 upsert responses（answerJson + changeCount 累加）；
 *   快照不在此写——判分与快照冻结都在交卷时一次性完成；
 * - submitAttempt：服务端权威判分（@tutor/grading，AGENTS 第 4 条）、逐题写
 *   questionSnapshotJson（题目编辑/软删不影响历史回看，验收项）、scoreAuto 汇总、
 *   status=submitted；重复交卷 409 ALREADY_SUBMITTED（验收项）；
 * - getAttemptDetail：draft → 草稿视图（公开题目 + 本人草稿 + 已解锁提示回显，
 *   绝无答案/详解/未请求提示）；submitted/graded → 结果视图（快照 + 参考答案 +
 *   详解 + 判分 + 做题时已解锁提示的回看）。
 *
 * 权限口径：attempt 归属（studentId 匹配）是详情/草稿/交卷接口的唯一权限依据
 * （被指派校验只在创建时做一次）——学生被移出名单或作业被软删后，已创建的作答
 * 仍可继续与回看（§5.2「删除作业不删除已有作答记录」）。
 *
 * 安全口径（AGENTS 第 3 条）：草稿视图题目一律经 unitPublicQuestions 输出过滤
 * （QuestionPublic 形态）；结果视图的 answers/solutionMd/stemMd（原文含答案标记）
 * 只在交卷后下发；提示内容只经 T2.11 按需接口（hint-service.openHint）逐条下发，
 * 两个视图仅回显「已解锁」条目（hintsOpened）。
 */

/** attempt 行 → 摘要（接口形态） */
function attemptSummaryOf(row: Attempt): AttemptStartData {
  return {
    id: row.id,
    assignmentId: row.assignmentId,
    unitId: row.unitId,
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
 * 取本人 attempt：不存在 → 404 ATTEMPT_NOT_FOUND；非本人 → 403 FORBIDDEN（验收项）。
 * attempt 归属是详情/草稿/交卷/笔迹（T2.8 ink-service 复用）接口的唯一权限依据，
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
 * 校验题目属于 attempt 的单元且未软删，否则 404 QUESTION_NOT_FOUND
 * （T2.8 ink-service 复用：笔迹上传与草稿答案同一口径）。
 */
export function requireUnitQuestion(
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
    question.unitId !== attempt.unitId
  ) {
    throw new HttpError(
      404,
      "QUESTION_NOT_FOUND",
      "题目不存在或不属于这份作业",
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
 * 创建或取回 attempt（幂等）：
 * - 作业不存在/已删除 → 404；未被指派 → 403；
 * - 已有进行中（draft）attempt → 直接返回它（一个作业一人一份进行中）；
 * - 已交卷/已批 → 返回最近一份（status 告知前端直接进结果视图，不另开新卷）；
 * - 否则插入新 draft attempt（unitId 取作业的单元）。
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
      assignmentId,
      unitId: assignment.unitId,
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
  const attempt = requireOwnAttempt(db, studentId, attemptId);
  if (attempt.status !== "draft") {
    throw new HttpError(
      409,
      "ALREADY_SUBMITTED",
      "这份作业已交卷，不能再修改答案",
    );
  }
  requireUnitQuestion(db, attempt, questionId);

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
 * - 返回结果视图（含答案与详解，AGENTS 第 3 条的「未交卷」限制就此解除）。
 */
export function submitAttempt(
  db: Db,
  studentId: string,
  attemptId: string,
): AttemptResultData {
  const attempt = requireOwnAttempt(db, studentId, attemptId);
  if (attempt.status !== "draft") {
    throw new HttpError(409, "ALREADY_SUBMITTED", "这份作业已经交过卷了");
  }

  // 判分输入：单元内未软删的题（题序）+ 各题考点 + 草稿答案
  const liveRows = db
    .select()
    .from(questions)
    .where(
      and(eq(questions.unitId, attempt.unitId), isNull(questions.deletedAt)),
    )
    .orderBy(asc(questions.order), asc(questions.id))
    .all();
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

  const now = new Date().toISOString();
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
        submittedAt: now,
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

  return buildResultData(db, attemptId);
}

// ---------- GET /api/student/attempts/:id ----------

/**
 * attempt 详情：按 status 二选一。
 * - draft → 草稿视图：公开题目（QuestionPublic 形态，题干脱敏）+ 本人草稿答案
 *   （drafts 键）+ 已解锁提示（hintsOpened 键）。绝不含答案/详解/未请求提示
 *   （泄露测试用 assertNoLeak 默认集合锁定）；
 * - submitted/graded → 结果视图：逐题快照 + 参考答案 + 详解 + 本人答案 +
 *   autoCorrect + 做题时已解锁提示（回看），得分汇总 + scoreAuto。
 */
export function getAttemptDetail(
  db: Db,
  studentId: string,
  attemptId: string,
): AttemptDetailData {
  const attempt = requireOwnAttempt(db, studentId, attemptId);
  if (attempt.status === "draft") {
    return buildDraftData(db, attempt);
  }
  return buildResultData(db, attemptId);
}

/** 草稿视图组装（题目与 T2.4 试卷同一投影：unitPublicQuestions） */
function buildDraftData(db: Db, attempt: Attempt): AttemptDetailData {
  const assignment = requireAssignmentRow(db, attempt.assignmentId);
  const publicQuestions: QuestionPublic[] = unitPublicQuestions(
    db,
    attempt.unitId,
  );
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
    title: assignment.title,
    dueAt: assignment.dueAt,
    questions: publicQuestions,
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
  if (!parsed.success) return null;
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
 * 结果视图组装：responses 行按 questions 当前题序排列（快照内容仍以冻结行为准；
 * 排序只影响展示顺序）。无快照的行（异常数据）被跳过并按缺失计——正常链路不发生。
 */
function buildResultData(db: Db, attemptId: string): AttemptResultData {
  const attempt = requireAttemptRow(db, attemptId);
  const assignment = requireAssignmentRow(db, attempt.assignmentId);
  const rows = db
    .select({
      response: responses,
      order: questions.order,
      questionId: questions.id,
    })
    .from(responses)
    .innerJoin(questions, eq(responses.questionId, questions.id))
    .where(eq(responses.attemptId, attemptId))
    .orderBy(asc(questions.order), asc(questions.id))
    .all();
  const resultQuestions = rows
    .map((row) => resultQuestionOf(row.response))
    .filter((item): item is AttemptResultQuestion => item !== null);

  return {
    attempt: attemptSummaryOf(attempt),
    title: assignment.title,
    dueAt: assignment.dueAt,
    summary: scoreSummaryOf(resultQuestions),
    questions: resultQuestions,
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
