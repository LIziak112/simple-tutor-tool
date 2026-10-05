import { randomUUID } from "node:crypto";
import {
  type AttemptAnswerSaveData,
  type AttemptDetailData,
  type AttemptDraftData,
  type AttemptDraftUnit,
  type AttemptQuestionPublic,
  type AttemptResultData,
  type AttemptResultQuestion,
  type AttemptResultUnit,
  type AttemptScoreSummary,
  type AttemptStartData,
  type AttemptSubmitRevision,
  attemptQuestionPublicSchema,
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
import { studentStemMd } from "@tutor/md-dsl";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
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
  students,
  type Unit,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { computePerQuestionActiveSec, countAnswerChanges } from "./active-time";
import { knowledgeNamesByQuestion } from "./assignment-service";
import { requireVisibleCourseUnit } from "./course-service";
import { attemptTimeline } from "./event-service";
import {
  draftHintsOpenedView,
  hintsOfJson,
  resultHintsOpenedOf,
} from "./hint-service";
import { pendingMarkCount } from "./pending-mark";
import type { Tx } from "./question-sync";

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
 * - wrong 来源（2026-10 错题重练）：组卷在 wrong-practice.ts 的 startWrongPractice
 *   （校验 + 快照冻结），本模块只承接读路径——attemptUnitIds 恒 []（题目集合
 *   在 attempt 自己的 responses 行，按建卷插入序 rowid 读取，见各 wrong 分支）、
 *   requireUsableAttempt 不做课程校验（无课程归属，attempt 永不失权）；
 * - saveDraftAnswer：draft 阶段 upsert responses（answerJson + changeCount 累加）；
 *   快照不在此写——判分与快照冻结都在交卷时一次性完成；
 * - submitAttempt：服务端权威判分（@tutor/grading，AGENTS 第 4 条）、逐题写
 *   questionSnapshotJson（题目编辑/软删不影响历史回看，验收项）、scoreAuto 汇总、
 *   status=submitted；重复交卷 409 ALREADY_SUBMITTED（验收项）；题目集合按
 *   sourceType 分派（attemptQuestionRows，见该函数注释）；
 * - getAttemptDetail：draft → 草稿视图（公开题目 + 本人草稿 + 已解锁提示回显，
 *   绝无答案/详解/未请求提示）；submitted/graded → 结果视图（快照 + 参考答案 +
 *   详解 + 判分 + 做题时已解锁提示的回看）；
 * - getStudentAttemptPaper（T2A.6）：通用取卷（两种来源共用；assignment 来源
 *   归属即权限，course 来源每次校验可见性与成员资格，D22）。
 *
 * 权限口径（T5 统一：学生侧 attempt 相关接口分两类）：
 * - **入口类**（从列表/目录进入，需要当前可见性）：GET /api/student/assignments
 *   （列表）、GET /api/student/assignments/:id/paper（旧取卷）、POST
 *   /api/student/assignments/:id/attempt（开卷，requireAssignmentVisible）——
 *   被移出名单 → 403（在册判定含 removedAt IS NULL，D13 立即不可见）；
 *   作业软删 → 404；
 * - **续作类**（已持有 attemptId 的 /api/student/attempts/:id/* 全部接口：详情/
 *   存答/交卷/提示/笔迹/事件/通用取卷）：归属即权限（requireOwnAttempt），
 *   assignment 来源不再叠加可见性校验——与「删除作业不删除已有作答记录」
 *   （§5.2）、「被移出后已建作答仍可继续」一致；
 * - course 来源 + draft 的重校验是既有特例（D7/D22，requireUsableAttempt →
 *   requireVisibleCourseUnit）：移出成员/课程归档 → 403 COURSE_ACCESS_DENIED，
 *   条目隐藏等 → 404 NOT_FOUND（未交卷草稿不再可访问，数据保留不删）；
 *   course 来源 + 已交卷不校验课程（D7/D10：已交卷课程练习记录保留，
 *   学生本人的记录中仍可查看）。
 *
 * 安全口径（AGENTS 第 3 条）：草稿视图题目一律经 publicQuestionsOfRows 输出过滤
 * （QuestionPublic 形态）；结果视图的 answers/solutionMd/stemMd（原文含答案标记）
 * 只在交卷后下发；提示内容只经 T2.11 按需接口（hint-service.openHint）逐条下发，
 * 两个视图仅回显「已解锁」条目（hintsOpened）。T2A.8（D11）：作业
 * answerRelease='after_due' 且未到截止时，结果视图（含交卷瞬间的 submit 响应）
 * 降级为受限形态——只下发本人答案与已解锁提示，题干公开化、对错/得分不泄露
 * （见 buildResultData）；截止后读时自动恢复。
 */

/** attempt 行 → 摘要（接口形态）；导出供 wrong-practice.ts 组卷复用（同一投影） */
export function attemptSummaryOf(row: Attempt): AttemptStartData {
  return {
    id: row.id,
    sourceType: row.sourceType,
    assignmentId: row.assignmentId,
    courseId: row.courseId,
    // T2A.7：assignment 来源多单元化后 unitId 恒 null（题目集合走
    // assignment_units）；course 来源恒有值；wrong 来源恒 null（2026-10）。
    // 摘要层归一化而非直接透传：
    // D23-6 回填「原值保留」可能让旧库 assignment 行带历史非空 unitId，
    // 此处收敛到契约 superRefine 锁定的不变式（assignment 来源 unitId 恒
    // null），不改库（题目集合本就只走 assignment_units，历史值无消费方）。
    unitId: row.sourceType === "assignment" ? null : row.unitId,
    attemptNo: row.attemptNo,
    status: row.status,
    startedAt: row.startedAt,
    submittedAt: row.submittedAt,
    scoreAuto: row.scoreAuto,
  };
}

/**
 * wrong 来源 attempt 的自有 responses 行（按建卷插入序 rowid 升序 = 组卷
 * questionIds 顺序，见 schema.ts responses 表注释）。wrong 卷的题目集合、
 * 快照与题序全部以这些行为唯一口径（不经 units/questions）。
 */
function wrongAttemptResponseRows(db: Db, attemptId: string): ResponseRow[] {
  return db
    .select()
    .from(responses)
    .where(eq(responses.attemptId, attemptId))
    .orderBy(sql`rowid`)
    .all();
}

// ---------- T6R.3 建卷冻结（三来源统一，方案 §5.1） ----------

/** attempt 的自有 responses 行（全部、未排序；含快照缺失的历史行） */
function attemptResponseRows(db: Db, attemptId: string): ResponseRow[] {
  return db
    .select()
    .from(responses)
    .where(eq(responses.attemptId, attemptId))
    .all();
}

/**
 * 冻结行写入（建卷与懒冻结共用，事务内调用）：live 题行 → 完整契约 Question
 * 序列化进 questionSnapshotJson，questionVersion 记冻结时版本。已有行只在
 * 快照为空时补写（保留学生已有答案/提示解锁/计数，绝不覆盖非空快照——升级
 * 遗留的损坏快照按缺失计，不拿当前题库回填伪造，方案 §5.1）。
 */
function freezeResponseRows(
  tx: Tx,
  attemptId: string,
  liveRows: readonly QuestionRow[],
  knowledgeByQuestion: ReadonlyMap<string, string[]>,
): void {
  for (const row of liveRows) {
    const snapshotJson = JSON.stringify(
      questionOfRow(row, knowledgeByQuestion.get(row.id) ?? []),
    );
    const existing = tx
      .select({
        id: responses.id,
        snapshot: responses.questionSnapshotJson,
      })
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, attemptId),
          eq(responses.questionId, row.id),
        ),
      )
      .get();
    if (existing === undefined) {
      tx.insert(responses)
        .values({
          id: randomUUID(),
          attemptId,
          questionId: row.id,
          questionVersion: row.version,
          questionSnapshotJson: snapshotJson,
          answerJson: null,
          autoCorrect: null,
          finalCorrect: null,
          teacherMark: null,
          teacherComment: null,
          activeSec: null,
          hintsUsed: 0,
          changeCount: 0,
          inkId: null,
          hintsOpenedJson: null,
        })
        .run();
    } else if (existing.snapshot === null) {
      tx.update(responses)
        .set({
          questionVersion: row.version,
          questionSnapshotJson: snapshotJson,
        })
        .where(eq(responses.id, existing.id))
        .run();
    }
  }
}

/**
 * 非 wrong 来源的冻结输入（**读路径，事务外调用**——better-sqlite3 同步单进程，
 * 同线程内先读后写无竞态）：attempt 单元集合内的当前 live 题（单元序 × 题序，
 * attemptQuestionRows 口径，域内取题 D10）+ 各题考点名（快照 knowledge 用）。
 * 教师域缺失的异常行按空集合处理（fail closed，空卷冻结）。
 */
function freezeInputsOfAttempt(
  db: Db,
  attempt: Attempt,
): {
  liveRows: QuestionRow[];
  knowledgeByQuestion: ReadonlyMap<string, string[]>;
} {
  const teacherId = attemptTeacherId(db, attempt);
  return {
    liveRows: attemptQuestionRows(db, attempt),
    knowledgeByQuestion:
      teacherId === null
        ? new Map<string, string[]>()
        : knowledgeNamesByQuestion(db, teacherId),
  };
}

/**
 * 懒冻结（T6R.3 迁移分支②，方案 §5.1）：升级前遗留的进行中 attempt
 * （frozenAt IS NULL 且 status='draft'）在首次恢复访问时冻结当前可取得版本
 * ——live 题补齐快照（保留已有答案），软删/缺失题的既有行保留为
 * 「历史题目缺失」（快照空，不回填），标记 legacy_unverified=1（不能宣称是
 * 学生更早看到的内容）。幂等：已冻结或已交卷立即返回。所有按 attemptId
 * 展开题目集合的读/写路径（详情/取卷/存答/提示/笔迹/交卷/教师 draft 详情）
 * 进门先调本函数；better-sqlite3 同步单进程，无并发竞态。
 * 返回冻结后的最新 attempt 行（懒冻结刚发生时内存里的旧对象不含新标记，
 * 需要 legacyUnverified 的调用方必须用返回值）。
 */
export function ensureAttemptFrozen(db: Db, attempt: Attempt): Attempt {
  if (attempt.frozenAt !== null || attempt.status !== "draft") return attempt;
  // 读在事务外（同连接同线程，与事务内一致）；事务内只做幂等复核与写入
  const { liveRows, knowledgeByQuestion } = freezeInputsOfAttempt(db, attempt);
  return (
    db.transaction((tx) => {
      const fresh = tx
        .select()
        .from(attempts)
        .where(eq(attempts.id, attempt.id))
        .get();
      if (
        fresh === undefined ||
        fresh.frozenAt !== null ||
        fresh.status !== "draft"
      ) {
        return fresh ?? attempt;
      }
      freezeResponseRows(tx, attempt.id, liveRows, knowledgeByQuestion);
      tx.update(attempts)
        .set({ frozenAt: new Date().toISOString(), legacyUnverified: true })
        .where(eq(attempts.id, attempt.id))
        .run();
      return (
        tx.select().from(attempts).where(eq(attempts.id, attempt.id)).get() ??
        fresh
      );
    }) ?? attempt
  );
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
 * attempt → student.teacherId 推导教师域（T2B.5，D10）：学生侧无会话教师，
 * 取卷/判分/提示/结果视图等一切按 unitId/questionId 查 units/questions 的地方
 * 在复合主键 (teacherId, id) 后不再唯一，必须带域（否则两位教师持同 id 单元/
 * 题目时会串到别人的内容——既是泄露也是判分错误）。attempt 归属学生一生只归
 * 一位教师（D14），故域取 students.teacherId。
 * D9 异常行防御：无教师域的学生行（回填后不应存在）返回 null，调用方按
 * 空结果/缺省处理（fail closed，与 T2B.4 listStudentAssignments 同口径）。
 * 导出供 hint-service 复用（提示内容同样按域取题）。
 */
export function attemptTeacherId(db: Db, attempt: Attempt): string | null {
  const row = db
    .select({ teacherId: students.teacherId })
    .from(students)
    .where(eq(students.id, attempt.studentId))
    .get();
  return row?.teacherId ?? null;
}

/**
 * attempt 的有序单元 id 列表（T2A.7）：
 * - course 来源：[attempt.unitId]（单单元，创建时必写；防御性空列表兜底异常行；
 *   课程侧可见性由 requireVisibleCourseUnit 把关）；
 * - assignment 来源：该作业 assignment_units 按 order 升序的列表（作业行经 FK
 *   必存在——含已删作业，作答不随作业软删消失）。
 *   D16：**单元软删不影响作业通道**——引用行保留，题目照常下发/判分；
 *   只有 questions.deletedAt（T1.12 题目级软删）才把题从判分/快照口径排除。
 * - wrong 来源（2026-10）：恒 []——错题重练卷不落单元，题目集合/快照/题序
 *   全在 attempt 自己的 responses 行（wrongAttemptResponseRows）。
 * 判分/快照/草稿/取卷/题目归属校验全部以本列表为唯一口径（wrong 来源除外，
 * 各消费方按 wrong 分支走自有行）。
 */
export function attemptUnitIds(db: Db, attempt: Attempt): string[] {
  if (attempt.sourceType === "wrong") {
    return [];
  }
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
 * T2B.5：按 attempt → student.teacherId 域内取题（D10——同 id 题目分属不同
 * 教师，判分输入不可串域；无教师域的异常行按空集合处理）。
 */
export function attemptQuestionRows(db: Db, attempt: Attempt): QuestionRow[] {
  const unitIds = attemptUnitIds(db, attempt);
  if (unitIds.length === 0) return [];
  const teacherId = attemptTeacherId(db, attempt);
  if (teacherId === null) return [];
  const rows = db
    .select()
    .from(questions)
    .where(
      and(
        eq(questions.teacherId, teacherId),
        inArray(questions.unitId, unitIds),
        isNull(questions.deletedAt),
      ),
    )
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
 * 错题重练卷的统一标题（2026-10）：答题页/结果页 h1、草稿视图与结果视图的
 * 单组标题、来源 meta 均用它；「错题重练 · 第 n 次」的次数串由前端拼。
 */
export const WRONG_PRACTICE_TITLE = "错题重练";

/**
 * 冻结快照（契约 Question）→ attempt 视图公开题目（T6R.3）：stemMd 经
 * studentStemMd 学生端唯一投影（options 另行下发时剥除题干内嵌选项任务列表 +
 * [[答案]] → [[]] 脱敏）、options 转纯文本、hints 只留数量，
 * answers/solutionMd/sourceMd 一律剥离——与 publicQuestionsOfRows 同一防泄露
 * 口径（fail closed，经 attemptQuestionPublicSchema.parse strip 未知键）。
 * questionRevisionId = 该题冻结 responses 行 id（不透明版本引用，交卷回传）。
 */
function publicOfSnapshot(
  question: Question,
  questionRevisionId: string,
): AttemptQuestionPublic {
  return attemptQuestionPublicSchema.parse({
    id: question.id,
    type: question.type,
    difficulty: question.difficulty,
    knowledge: question.knowledge,
    stemMd: studentStemMd(question),
    ...(question.options !== undefined
      ? { options: question.options.map((option) => option.text) }
      : {}),
    hintCount: question.hints.length,
    questionRevisionId,
  });
}

/**
 * 冻结行的展示序与单元归属（T6R.3）：非 wrong 来源经域内 questions join 提供
 * 单元归属与组内展示序（快照内容仍是唯一真相，join 只影响分节与顺序——与
 * 结果视图/导出同一口径；题目移出单元等异常行按单元序追加在末尾，不丢数据）；
 * wrong 来源按建卷插入序（rowid）。unitId=null 表示 join 未命中 questions 行
 * （防御性：正常链路不可达——题目不硬删），消费方按兜底分组处理。
 */
export function frozenRowsInDisplayOrder(
  db: Db,
  attempt: Attempt,
): { row: ResponseRow; unitId: string | null }[] {
  if (attempt.sourceType === "wrong") {
    return wrongAttemptResponseRows(db, attempt.id).map((row) => ({
      row,
      unitId: null as string | null,
    }));
  }
  const ownRows = attemptResponseRows(db, attempt.id);
  const teacherId = attemptTeacherId(db, attempt);
  if (teacherId === null) {
    return ownRows.map((row) => ({ row, unitId: null as string | null }));
  }
  const metaByQuestion =
    ownRows.length === 0
      ? new Map<string, { unitId: string; order: number }>()
      : new Map(
          db
            .select({
              id: questions.id,
              unitId: questions.unitId,
              order: questions.order,
            })
            .from(questions)
            .where(
              and(
                eq(questions.teacherId, teacherId),
                inArray(
                  questions.id,
                  ownRows.map((row) => row.questionId),
                ),
              ),
            )
            .all()
            .map(
              (row) =>
                [row.id, { unitId: row.unitId, order: row.order }] as const,
            ),
        );
  const unitIds = attemptUnitIds(db, attempt);
  const unitIndex = new Map(unitIds.map((unitId, i) => [unitId, i] as const));
  const fallbackRank = unitIds.length; // 不在 attempt 单元集合内的行追加末尾
  return ownRows
    .map((row) => {
      const meta = metaByQuestion.get(row.questionId);
      return {
        row,
        unitId: meta?.unitId ?? null,
        unitRank:
          meta !== undefined && unitIndex.has(meta.unitId)
            ? (unitIndex.get(meta.unitId) as number)
            : fallbackRank,
        order: meta?.order ?? Number.MAX_SAFE_INTEGER,
      };
    })
    .sort(
      (a, b) =>
        a.unitRank - b.unitRank ||
        a.order - b.order ||
        (a.row.questionId < b.row.questionId
          ? -1
          : a.row.questionId > b.row.questionId
            ? 1
            : 0),
    )
    .map(({ row, unitId }) => ({ row, unitId }));
}

/**
 * attempt 的分组公开题目（T2A.7 草稿视图与通用取卷共用；T6R.3 起三来源统一
 * 读**建卷冻结快照**，教师改题库不影响已建的卷）：
 * - 题目一律取 attempt 自有 responses 行的 questionSnapshotJson（先过
 *   ensureAttemptFrozen 兜底升级遗留草稿），经 publicOfSnapshot 输出过滤并
 *   附每题 questionRevisionId（= 行 id，交卷回传验证用）；快照缺失的历史行
 *   按「历史题目缺失」计，跳过不显示、不回填；
 * - assignment 按 attempt 单元序分节（join 当前 questions 提供归属与组内序，
 *   见 frozenRowsInDisplayOrder）；course 恒单组；wrong 恒单组「错题重练」
 *   （rowid = 建卷题序）。标题取单元当前值（D1 引用语义）。
 */
function attemptPublicUnitGroups(
  db: Db,
  attempt: Attempt,
): (AttemptDraftUnit & StudentPaperUnit)[] {
  ensureAttemptFrozen(db, attempt);
  const entries = frozenRowsInDisplayOrder(db, attempt);
  if (attempt.sourceType === "wrong") {
    const questions: AttemptDraftUnit["questions"] = [];
    for (const { row } of entries) {
      const snapshot = snapshotOfRow(row);
      if (snapshot === null) continue; // 坏快照按缺失计（建卷即冻结，理论不可达）
      questions.push(publicOfSnapshot(snapshot, row.id));
    }
    // 组 id 用 attemptId（卷无单元语义，仅作分组键/React key，不指涉资源）
    return [{ id: attempt.id, title: WRONG_PRACTICE_TITLE, questions }];
  }
  const teacherId = attemptTeacherId(db, attempt);
  const unitIdsNeeded = [
    ...new Set(
      entries
        .map((entry) => entry.unitId)
        .filter((unitId): unitId is string => unitId !== null),
    ),
  ];
  const titleByUnit = new Map(
    teacherId !== null && unitIdsNeeded.length > 0
      ? db
          .select({ id: units.id, title: units.title })
          .from(units)
          .where(
            and(
              eq(units.teacherId, teacherId),
              inArray(units.id, unitIdsNeeded),
            ),
          )
          .all()
          .map((row) => [row.id, row.title] as const)
      : [],
  );
  const groups: (AttemptDraftUnit & StudentPaperUnit)[] = [];
  let current: AttemptDraftUnit | null = null;
  for (const { row, unitId } of entries) {
    const snapshot = snapshotOfRow(row);
    if (snapshot === null) continue; // 历史题目缺失/坏快照按缺失计
    // join 未命中的行归入末尾兜底组（组 id 用 attemptId，不指涉资源；正常不可达）
    const groupKey = unitId ?? attempt.id;
    if (current === null || current.id !== groupKey) {
      current = {
        id: groupKey,
        title: titleByUnit.get(groupKey) ?? groupKey,
        questions: [],
      };
      groups.push(current);
    }
    current.questions.push(publicOfSnapshot(snapshot, row.id));
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
  if (attempt.sourceType === "wrong") {
    // 错题重练（2026-10）：标题固定「错题重练」，无课程/截止
    //（「错题重练 · 第 n 次」的来源行由前端从 attemptNo 拼）
    return { title: WRONG_PRACTICE_TITLE, courseName: null, dueAt: null };
  }
  if (attempt.sourceType === "course") {
    // 课程练习：标题 = 单元当前标题（D1 引用而非复制）；不限截止（D11 交卷即公布）。
    // T2B.5：单元标题按 attempt → student.teacherId 域内读（D10）
    const teacherId = attemptTeacherId(db, attempt);
    const unit: Unit | undefined =
      attempt.unitId !== null && teacherId !== null
        ? db
            .select()
            .from(units)
            .where(
              and(eq(units.teacherId, teacherId), eq(units.id, attempt.unitId)),
            )
            .get()
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
 * 校验题目属于该 attempt 的**冻结集合**（T6R.3 三来源统一：题目集合 = attempt
 * 自有 responses 行，建卷/懒冻结后必有快照），否则 404 QUESTION_NOT_FOUND
 * （T2.8 ink-service 复用：笔迹上传与草稿答案同一口径）。
 * - 权限语义不变：本函数只管题目集合成员资格；课程/作业访问权守卫在
 *   requireUsableAttempt（「冻结内容不冻结权限」——软删/改题不再把题从
 *   进行中的卷里移走，但课程撤权等照样拦截）；
 * - 升级遗留草稿进门先懒冻结（ensureAttemptFrozen 幂等）；
 * - 要求快照非空：快照缺失的历史行（软删/缺失题）不算可用题——旧标签页
 *   对这类题的陈旧写入按 404 拒绝，不落到永不展示/判分的行上。
 */
export function requireAttemptQuestion(
  db: Db,
  attempt: Attempt,
  questionId: string,
): void {
  ensureAttemptFrozen(db, attempt);
  const hit = db
    .select({ id: responses.id })
    .from(responses)
    .where(
      and(
        eq(responses.attemptId, attempt.id),
        eq(responses.questionId, questionId),
        isNotNull(responses.questionSnapshotJson),
      ),
    )
    .get();
  if (hit === undefined) {
    throw new HttpError(
      404,
      "QUESTION_NOT_FOUND",
      "题目不存在或不属于这次练习",
    );
  }
}

/**
 * 入口类可见性校验（POST /assignments/:id/attempt 开卷用）：作业不存在/已
 * 软删 → 404；未被指派**或在册判定含 removedAt IS NULL**（被移出名单的学生
 * 立即不可见，D13）→ 403。与 T2.4 旧取卷接口（assignment-service 的
 * getStudentAssignmentPaper）同口径。
 */
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
        isNull(assignmentStudents.removedAt),
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

/**
 * responses 行 → 冻结快照（契约 Question）；无快照/坏数据为 null。
 * wrong 来源建卷即写入快照（2026-10），该来源下 null 属理论不可达的异常行。
 */
function snapshotOfRow(row: ResponseRow): Question | null {
  if (row.questionSnapshotJson === null) return null;
  const parsed = questionSchema.safeParse(jsonOf(row.questionSnapshotJson));
  return parsed.success ? parsed.data : null;
}

// ---------- POST /api/student/assignments/:id/attempt ----------

/**
 * 创建或取回作业来源的 attempt（幂等；入口类接口，先过 requireAssignmentVisible）：
 * - 作业不存在/已删除 → 404；未被指派（含被移出名单，D13 立即不可见）→ 403；
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
  const attempt: Attempt = {
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
    // T6R.3：建卷即冻结（frozenAt=startedAt、legacyUnverified=false）
    frozenAt: startedAt,
    legacyUnverified: false,
  };
  // T6R.3：建卷冻结——题目集合/题序/完整快照逐题预插 responses 行（assignment
  // 单元序 × 题序）；教师改题库只影响之后新建的卷。读在事务外（同连接同线程）
  const { liveRows, knowledgeByQuestion } = freezeInputsOfAttempt(db, attempt);
  db.transaction((tx) => {
    tx.insert(attempts).values(attempt).run();
    freezeResponseRows(tx, attempt.id, liveRows, knowledgeByQuestion);
  });
  return attemptSummaryOf(attempt);
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
    const startedAt = new Date().toISOString();
    const attempt: Attempt = {
      id,
      studentId,
      sourceType: "course",
      assignmentId: null,
      courseId,
      unitId,
      attemptNo: maxAttemptNo + 1,
      status: "draft",
      startedAt,
      submittedAt: null,
      activeSec: null,
      device: null,
      scoreAuto: null,
      scoreFinal: null,
      // T6R.3：建卷即冻结（frozenAt=startedAt、legacyUnverified=false）
      frozenAt: startedAt,
      legacyUnverified: false,
    };
    // T6R.3：建卷冻结——课程单元当前 live 题逐题预插快照行（读在事务外）
    const { liveRows, knowledgeByQuestion } = freezeInputsOfAttempt(
      db,
      attempt,
    );
    tx.insert(attempts).values(attempt).run();
    freezeResponseRows(tx, attempt.id, liveRows, knowledgeByQuestion);
    return attemptSummaryOf(attempt);
  });
}

// ---------- GET /api/student/attempts/:id/paper（T2A.6 通用取卷） ----------

/**
 * 通用取卷（两种来源共用同一响应形态 StudentPaperData）：
 * - assignment 来源：**归属即权限**（requireOwnAttempt 已做归属校验），不再
 *   叠加 requireAssignmentVisible——被移出名单或作业软删后，已建作答仍可继续
 *   （§5.2「删除作业不删除已有作答记录」），取卷与详情/存答/交卷同一口径；
 * - course 来源：每次取卷都重校验可见性与成员资格（requireVisibleCourseUnit，
 *   draft 与已交一致——D7/D22 特例：取卷是「看到这份练习题目」的入口，
 *   移出成员 → 403 COURSE_ACCESS_DENIED、条目隐藏等 → 404 NOT_FOUND）；
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
  /** 冻结的 responses 行（判分输入与写入目标；行 id 即 questionRevisionId） */
  response: ResponseRow;
  /** 契约 Question（冻结快照、判分输入） */
  question: Question;
  /** 学生答案（草稿；未作为 undefined） */
  answer: StudentAnswer | undefined;
  /**
   * 服务端判分结果：true/false/null。null=不能自动判定（D1 后仅三种：手写题
   * 未能自动判（含未作答/只写笔迹）、题目无标准答案、判断题写法无法归一化）。
   */
  autoCorrect: boolean | null;
}

/** scoreAuto 口径：答对数 / 可自动判分数（autoCorrect 非 null），四舍五入百分比；无可判分为 null */
function scoreAutoOf(graded: readonly GradedResponse[]): number | null {
  const autoGradable = graded.filter((g) => g.autoCorrect !== null).length;
  if (autoGradable === 0) return null;
  const correct = graded.filter((g) => g.autoCorrect === true).length;
  return Math.round((correct / autoGradable) * 100);
}

/** 陈旧题目版本提交的统一拒绝（T6R.3，409；前端据此提示刷新页面后重交） */
function revisionStale(): HttpError {
  return new HttpError(
    409,
    "QUESTION_REVISION_STALE",
    "题目版本已变化，请刷新页面后重新交卷",
  );
}

/**
 * 交卷回传版本验证（T6R.3）：与参与判分的冻结集合精确比对——条数不符
 * （缺项/多项）、questionRevisionId 错版、重复项都视为陈旧页面提交，
 * 409 QUESTION_REVISION_STALE 可诊断拒绝（不静默配上新快照，方案 §5.1）。
 */
function validateSubmitRevisions(
  graded: readonly GradedResponse[],
  clientRevisions: readonly AttemptSubmitRevision[],
): void {
  if (clientRevisions.length !== graded.length) throw revisionStale();
  const expectedByQuestion = new Map(
    graded.map((g) => [g.response.questionId, g.response.id] as const),
  );
  const seen = new Set<string>();
  for (const entry of clientRevisions) {
    if (seen.has(entry.questionId)) throw revisionStale();
    seen.add(entry.questionId);
    if (expectedByQuestion.get(entry.questionId) !== entry.questionRevisionId) {
      throw revisionStale();
    }
  }
}

/**
 * D2/D3 口径的 attempt 级最终得分与状态（T3.2a）：
 * - status=graded 当且仅当全部 finalCorrect 均非 null（此时必写 scoreFinal）；
 * - scoreFinal = round（finalCorrect 为 true 的题数 ÷ 全部题数 × 100）；
 *   任一待批（null）则 status=submitted、scoreFinal=null（批改完成后由 T3.2b 重算）；
 * - 空卷（无题）防御性保持 submitted / null。
 * 交卷链路调用时 finalCorrect=autoCorrect（teacherMark 必空）；backfill 与批改
 * 链路以 teacherMark ?? autoCorrect 为输入复用同一口径。
 */
export function finalScoreOf(finalCorrects: readonly (boolean | null)[]): {
  status: "submitted" | "graded";
  scoreFinal: number | null;
} {
  if (finalCorrects.length === 0 || finalCorrects.some((v) => v === null)) {
    return { status: "submitted", scoreFinal: null };
  }
  const correct = finalCorrects.filter((v) => v === true).length;
  return {
    status: "graded",
    scoreFinal: Math.round((correct / finalCorrects.length) * 100),
  };
}

/**
 * 交卷（服务端权威判分；T6R.3 起三来源统一读冻结快照）：
 * - attempt 不存在 → 404；非本人 → 403；已交卷 → 409 ALREADY_SUBMITTED（验收项）；
 * - 判分输入 = 该 attempt 自有 responses 行的 questionSnapshotJson（建卷/懒冻结
 *   写入；ensureAttemptFrozen 兜底升级遗留草稿）。快照缺失的历史行（软删/缺失/
 *   损坏）按「历史题目缺失」计：跳过判分、答案行保留，不拿当前题库回填伪造；
 * - grade(question, answer)（@tutor/grading，判分逻辑本身不变）；D1 后未作答
 *   客观题（含多选空选）判 false，未作答手写题 → null 进待批；
 * - **finalCorrect = autoCorrect（D3 持久化口径，T3.2a）**：交卷时 teacherMark
 *   必空，逐题同时写 finalCorrect——待批题 ≡ finalCorrect IS NULL（D4 共享谓词）；
 * - 写入方式：**原行更新**（行在建卷/懒冻结时已存在；行 id 不变 = 对外下发的
 *   questionRevisionId 稳定）；questionVersion/questionSnapshotJson 保持冻结值；
 *   hintsUsed/hintsOpenedJson/inkId/teacherMark/teacherComment 不在交卷时改写；
 * - activeSec：T2.10 起按 events 表事件序列计算（computePerQuestionActiveSec，
 *   不信任客户端汇总值，§5.5）；无事件的题保持 NULL；
 * - changeCount：T2.10 口径 = max(草稿期 PUT 计数, answer_change 事件数)——
 *   事件计数为权威（每次有效修改一条），草稿计数兜底（无前端事件的 attempt，
 *   如脚本直接调 API 交卷）；
 * - T6R.3 版本验证：clientRevisions 提供时（HTTP 路由恒传，不带请求体按空
 *   集合）与冻结集合精确比对，不符 409 QUESTION_REVISION_STALE；服务层内部
 *   调用（seed 等）可省略参数跳过验证；
 * - attempt.status/scoreAuto/scoreFinal 按 D2/D3：全部 finalCorrect 非 null →
 *   直接 graded 并写 scoreFinal（=scoreAuto，此时分母相同）；否则 submitted、
 *   scoreFinal=null（待批批改后由 T3.2b 重算）；submittedAt、activeSec 总用时
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
  clientRevisions?: readonly AttemptSubmitRevision[],
): AttemptResultData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (attempt.status !== "draft") {
    throw new HttpError(409, "ALREADY_SUBMITTED", "这份练习已经交过卷了");
  }

  // T6R.3：懒冻结兜底升级遗留草稿（幂等）；wrong 按建卷题序（rowid），其余
  // 来源的展示排序在结果视图经 join 重排（此处判分顺序无关）
  ensureAttemptFrozen(db, attempt);
  const ownRows =
    attempt.sourceType === "wrong"
      ? wrongAttemptResponseRows(db, attemptId)
      : attemptResponseRows(db, attemptId);

  // T2.10：每题有效用时与改答案次数（服务端按事件序列计算，§5.5）
  const timeline = attemptTimeline(db, attemptId);
  const activeSecByQuestion = computePerQuestionActiveSec(timeline);
  const eventChangeCountByQuestion = countAnswerChanges(timeline);

  const graded: GradedResponse[] = [];
  for (const ownRow of ownRows) {
    const snapshot = snapshotOfRow(ownRow);
    if (snapshot === null) continue; // 历史题目缺失/坏快照按缺失计（不回填、不判分）
    const answer = answerOf(ownRow.answerJson);
    graded.push({
      response: ownRow,
      question: snapshot,
      answer,
      autoCorrect: grade(snapshot, answer),
    });
  }

  if (clientRevisions !== undefined) {
    validateSubmitRevisions(graded, clientRevisions);
  }

  const scoreAuto = scoreAutoOf(graded);
  // D3：交卷时 teacherMark 必空 → finalCorrect = autoCorrect；D2 据此定 status/scoreFinal
  const finalCorrects = graded.map((g) => g.autoCorrect);
  const { status: finalStatus, scoreFinal } = finalScoreOf(finalCorrects);

  const nowIso = new Date(now).toISOString();
  db.transaction((tx) => {
    for (const g of graded) {
      tx.update(responses)
        .set({
          answerJson: g.answer !== undefined ? JSON.stringify(g.answer) : null,
          autoCorrect: g.autoCorrect,
          // D3：交卷同时写 finalCorrect = autoCorrect（teacherMark 必空）
          finalCorrect: g.autoCorrect,
          activeSec: activeSecByQuestion[g.response.questionId] ?? null,
          changeCount: Math.max(
            g.response.changeCount,
            eventChangeCountByQuestion[g.response.questionId] ?? 0,
          ),
        })
        .where(eq(responses.id, g.response.id))
        .run();
    }
    tx.update(attempts)
      .set({
        // D2/D3：全部 finalCorrect 非 null → 直接 graded 并写 scoreFinal；
        // 否则 submitted、scoreFinal=null（待批批改后由 T3.2b 重算）
        status: finalStatus,
        submittedAt: nowIso,
        scoreAuto,
        scoreFinal,
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
 * 草稿视图组装（题目经 attemptPublicUnitGroups：冻结快照 + QuestionPublic
 * 投影 + questionRevisionId）。course 来源的 draft 在 requireUsableAttempt
 * 已过 D5 门（失去访问权 403）。
 */
function buildDraftData(db: Db, attempt: Attempt): AttemptDraftData {
  // T6R.3：懒冻结兜底升级遗留草稿（幂等；用返回值取 legacyUnverified 新标记）
  const frozen = ensureAttemptFrozen(db, attempt);
  const meta = attemptSourceMeta(db, frozen);
  const unitGroups = attemptPublicUnitGroups(db, frozen);
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
    attempt: attemptSummaryOf(frozen),
    title: meta.title,
    courseName: meta.courseName,
    dueAt: meta.dueAt,
    // T2A.7：题目按单元分组（与试卷同口径；空单元不出现）
    units: unitGroups,
    drafts,
    // T2.11：已解锁提示回显（刷新页面后提示面板不丢；只含学生请求过的条目）
    hintsOpened: draftHintsOpenedView(db, frozen),
    // T6R.3：懒冻结的升级遗留卷标记（前端提示「内容为恢复后的版本」）
    legacyUnverified: frozen.legacyUnverified,
  };
}

/** 结果视图的单题行（快照投影：除已解锁条目外无 hints 内容，options 转纯文本；
 * D9〔T3.5〕新增 teacherMark / teacherComment / finalCorrect 透传 responses 行） */
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
    // D9：教师批注与最终判定（D3 持久化口径；公布 gate 在 releaseAwareQuestion 投影）
    teacherMark:
      row.teacherMark === "correct" || row.teacherMark === "wrong"
        ? row.teacherMark
        : null,
    teacherComment: row.teacherComment,
    finalCorrect: row.finalCorrect,
    // T2.11：只回显做题时已解锁的提示（文本取自快照；未解锁条目绝不在此）
    hintsOpened: resultHintsOpenedOf(row, snapshot.hints),
  };
}

/** 得分汇总的自动判分计数部分（口径与 scoreAutoOf 一致：scoreAuto =
 * correct/autoGradable 百分比）。D9 的 scoreFinal/pendingCount 不在此算——
 * 前者取 attempt 行、后者走 pendingMarkCount（D4 共享谓词），由 buildResultData
 * 组装进完整 AttemptScoreSummary */
function scoreSummaryOf(
  rows: readonly AttemptResultQuestion[],
): Omit<AttemptScoreSummary, "scoreFinal" | "pendingCount"> {
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
 * answers/solutionMd/autoCorrect 置 null、stemMd 经 studentStemMd 投影（快照题干
 * 含 [[答案]] 标记与 [x] 正确项，与草稿视图同一防泄露口径）、attempt.scoreAuto
 * 置 null 投影（库里保留）、summary 的对错计数不泄露（correct/wrong/autoGradable=0、
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
  // T2B.5：结果视图的题目排序 join 与单元标题按 attempt → student.teacherId
  // 域内读（D10——responses.questionId 在复合主键后不再唯一指向一行 questions；
  // 快照内容仍取冻结行，join 只提供排序与分组元信息）
  const teacherId = attemptTeacherId(db, attempt);
  // T2A.8：assignment 来源按作业判定；course 来源恒公布（D11 课程练习交卷即公布）
  const assignmentRow =
    attempt.sourceType === "assignment"
      ? requireAssignmentRow(db, attempt.assignmentId ?? "")
      : null;
  const released =
    assignmentRow === null || answersReleased(assignmentRow, now);

  /** 受限形态的逐题投影（见函数头注释）。
   * stemMd 一律经 studentStemMd 学生端投影（已公布也不例外）：[[答案]] 渲染为
   * 空框、选择题选项列表由前端 options 行渲染——保证学生载荷在任何形态下都不含
   * [x] 正确项标记与非空 [[…]] 标记（AGENTS 第 3 条，studentStemMd 唯一入口）。
   * D9 字段 teacherMark / teacherComment / finalCorrect 与 autoCorrect 同法置
   * null——教师已批也不在截止前泄露对错与评语 */
  const releaseAwareQuestion = (item: AttemptResultQuestion) => {
    const projected: AttemptResultQuestion = {
      ...item,
      snapshot: { ...item.snapshot, stemMd: studentStemMd(item.snapshot) },
    };
    return released
      ? projected
      : {
          ...projected,
          answers: null,
          solutionMd: null,
          autoCorrect: null,
          teacherMark: null,
          teacherComment: null,
          finalCorrect: null,
        };
  };

  const rows =
    attempt.sourceType === "wrong"
      ? // wrong（2026-10）：自有冻结行按建卷插入序（rowid）取，不 join 当前
        // questions（快照内容即权威；教师改题库/软删不影响结果视图题序与分组）
        db
          .select({ response: responses })
          .from(responses)
          .where(eq(responses.attemptId, attemptId))
          .orderBy(sql`rowid`)
          .all()
          .map((row) => ({
            response: row.response,
            order: 0,
            questionId: row.response.questionId,
            unitId: "",
          }))
      : teacherId === null
        ? []
        : db
            .select({
              response: responses,
              order: questions.order,
              questionId: questions.id,
              unitId: questions.unitId,
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
  const resultByQuestion = new Map<string, AttemptResultQuestion>();
  for (const row of rows) {
    const item = resultQuestionOf(row.response);
    if (item !== null) {
      resultByQuestion.set(row.questionId, releaseAwareQuestion(item));
    }
  }
  const resultQuestions = [...resultByQuestion.values()];

  const unitGroups: AttemptResultUnit[] = [];
  if (attempt.sourceType === "wrong") {
    // wrong（2026-10）：恒单组「错题重练」；rows 已按建卷插入序（rowid）排列，
    // resultQuestions 逐行收集保持该序（不按当前题库单元重排）
    if (resultQuestions.length > 0) {
      unitGroups.push({
        id: attempt.id,
        title: WRONG_PRACTICE_TITLE,
        questions: resultQuestions,
      });
    }
  } else {
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
      teacherId !== null && orderedUnitIds.length > 0
        ? db
            .select({ id: units.id, title: units.title })
            .from(units)
            .where(
              and(
                eq(units.teacherId, teacherId),
                inArray(units.id, orderedUnitIds),
              ),
            )
            .all()
            .map((row) => [row.id, row.title] as const)
        : [],
    );
    for (const unitId of orderedUnitIds) {
      const questionsOfUnit = questionsByUnit.get(unitId);
      if (questionsOfUnit === undefined || questionsOfUnit.length === 0)
        continue;
      unitGroups.push({
        id: unitId,
        title: unitTitleById.get(unitId) ?? unitId,
        questions: questionsOfUnit,
      });
    }
  }

  // 得分汇总：未公布时不泄露对错——correct/wrong/autoGradable 置 0，
  // pending 按 answered 口径（每道已答题显示为「待批」，截止后恢复真实计数）；
  // D9 新增字段 scoreFinal / pendingCount 同法置 null 投影（待批数不 null 会
  // 泄露整卷批改进度，与「待公布」口径冲突）。已公布时 scoreFinal 取 attempt 行、
  // pendingCount 走 pendingMarkCount（D4 共享谓词，与教师端列表/详情同一实现）
  const fullSummary = scoreSummaryOf(resultQuestions);
  const summary = released
    ? {
        ...fullSummary,
        scoreFinal: attempt.scoreFinal,
        pendingCount: pendingMarkCount(db, attempt),
      }
    : {
        total: fullSummary.total,
        answered: fullSummary.answered,
        correct: 0,
        wrong: 0,
        pending: fullSummary.answered,
        unanswered: fullSummary.unanswered,
        autoGradable: 0,
        scoreFinal: null,
        pendingCount: null,
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
