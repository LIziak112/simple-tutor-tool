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
  type CapabilitySwitch,
  type HintOpenedEntry,
  type NoteSubmissionEvidenceState,
  optionSchema,
  type Question,
  type QuestionAnswers,
  type QuestionOption,
  questionAnswersSchema,
  questionSchema,
  type StudentAnswer,
  type StudentPaperData,
  type StudentPaperUnit,
  type SubmitEvidenceDeclaration,
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
  type SQL,
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
  notes,
  type Question as QuestionRow,
  questions,
  type ResponseRow,
  responses,
  students,
  submissionEvidence,
  type Unit,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { computePerQuestionActiveSec, countAnswerChanges } from "./active-time";
import { knowledgeNamesByQuestion } from "./assignment-service";
import { getCapabilityProfile } from "./capability-profile-service";
import { requireVisibleCourseUnit } from "./course-service";
import { attemptTimeline } from "./event-service";
import {
  hintsOfJson,
  openedHintEcho,
  resultHintsOpenedOf,
} from "./hint-service";
import { pendingMarkCount } from "./pending-mark";
import type { Tx } from "./question-sync";
import { jsonOf, snapshotOfRow } from "./snapshot";

/**
 * AttemptService（T2.6；T2A.6 扩展作答来源 D9/D10；T6R.3 全来源建卷冻结）
 * ——作答生命周期的业务层（架构文档 §5.2/§5.3/§5.6）。路由只做
 * 「鉴权 → 校验 → 调 service → 包装响应」（api-endpoint 技能约定），本模块承载：
 *
 * **T6R.3 冻结口径（方案 §5.1，三来源统一）**：新 attempt 建立时逐题预插
 * responses 冻结行（完整 Question 快照 + questionVersion，行 id 即对外下发的
 * questionRevisionId）；此后取卷、草稿读题、提示、判分、结果、导出一律读冻结
 * 快照，题库修改只影响之后新建的卷。升级前进行中的 attempt 首次恢复访问时由
 * ensureAttemptFrozen 懒冻结（标记 legacy_unverified）；升级前已交卷的行沿用
 * 交卷快照。**冻结内容不冻结权限**：作业到期/课程撤权/学生停用仍按既有守卫。
 *
 * - startAttempt：创建或取回作业来源的 attempt（幂等：一个作业一人一份进行中，
 *   仅对 assignment 来源生效）；已交卷后再 POST 返回已交的那份（前端据此直接进
 *   结果视图，不另开新卷）；新建时建卷冻结（assignment 单元序 × 题序）；
 * - startCourseAttempt（T2A.6）：课程练习入口——存在未交卷作答则返回它；否则
 *   新建（attemptNo+1，从空白开始，建卷冻结）。每次调用都校验 D5 可见性；
 *   「(学生, 课程, 单元) 同时最多 1 份未交卷」由事务先查后插保证（D10）；
 * - wrong 来源（2026-10 错题重练）：组卷在 wrong-practice.ts 的 startWrongPractice
 *   （校验 + 快照冻结），本模块承接读路径——attemptUnitIds 恒 []（题目集合在
 *   attempt 自己的 responses 行，按建卷插入序 rowid 读取）、requireUsableAttempt
 *   不做课程校验（无课程归属，attempt 永不失权）；
 * - saveDraftAnswer：draft 阶段 upsert responses（answerJson + changeCount 累加）；
 *   快照在建卷时已冻结，不在此写；
 * - submitAttempt：服务端权威判分（@tutor/grading，AGENTS 第 4 条）——判分输入
 *   = 冻结快照（不查当前题库）；逐题原行更新判分结果（行 id 不变）、scoreAuto
 *   汇总、status=submitted；重复交卷 409 ALREADY_SUBMITTED；交卷回传版本集合
 *   验证不符 → 409 QUESTION_REVISION_STALE（旧标签页可诊断提示刷新）；
 * - getAttemptDetail：draft → 草稿视图（冻结快照的公开投影 + questionRevisionId
 *   + 本人草稿 + 已解锁提示回显 + legacyUnverified 标记，绝无答案/详解/未请求
 *   提示）；submitted/graded → 结果视图（快照 + 参考答案 + 详解 + 判分 +
 *   做题时已解锁提示的回看）；
 * - getStudentAttemptPaper（T2A.6）：通用取卷（三种来源共用，读冻结快照；
 *   assignment 来源归属即权限，course 来源每次校验可见性与成员资格，D22）。
 *
 * 权限口径（T5 统一：学生侧 attempt 相关接口分两类）：
 * - **入口类**（从列表/目录进入，需要当前可见性）：GET /api/student/assignments
 *   （列表）、GET /api/student/assignments/:id/paper（开卷前预览，读当前题库）、
 *   POST /api/student/assignments/:id/attempt（开卷，requireAssignmentVisible，
 *   开卷即冻结）——被移出名单 → 403（在册判定含 removedAt IS NULL，D13 立即
 *   不可见）；作业软删 → 404；
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
 * 安全口径（AGENTS 第 3 条）：草稿视图题目一律经 publicOfSnapshot 输出过滤
 * （QuestionPublic 形态 + questionRevisionId，fail closed）；结果视图的
 * answers/solutionMd/stemMd（原文含答案标记）只在交卷后下发；提示内容只经
 * T2.11 按需接口（hint-service.openHint，冻结快照口径）逐条下发，两个视图仅
 * 回显「已解锁」条目（hintsOpened）。T2A.8（D11）：作业
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

// ---------- T6R.3 建卷冻结（三来源统一，方案 §5.1） ----------

/**
 * attempt 的自有 responses 行（按建卷插入序 rowid 升序；含快照缺失的历史行）。
 * rowid 序即建卷组卷序（建卷事务内顺序插入、行不被删除）；wrong 卷的题目
 * 集合、快照与题序全部以这些行为唯一口径（不经 units/questions）。
 */
export function attemptResponseRows(db: Db, attemptId: string): ResponseRow[] {
  return db
    .select()
    .from(responses)
    .where(eq(responses.attemptId, attemptId))
    .orderBy(sql`rowid`)
    .all();
}

/** 冻结行插入的最小入参（建卷与 wrong 组卷共用一处的 15 列字面量） */
export interface FrozenResponseInsert {
  readonly attemptId: string;
  readonly questionId: string;
  readonly questionVersion: number;
  readonly questionSnapshotJson: string;
  /** 冻结时刻的单元归属（wrong 组卷为 null） */
  readonly unitId: string | null;
}

/**
 * 插入一行冻结 response（建卷/懒冻结缺行补插/wrong 组卷共用的唯一字面量处，
 * 事务内调用）。学生数据列全部为空白初值——答案/提示解锁/计数由学生后续
 * 作答写入；返回行 id（对外即该题的 questionRevisionId，T6R.4 起
 * note-service 等消费方直接取用，不必再回查）。
 */
export function insertFrozenResponse(
  tx: Tx,
  values: FrozenResponseInsert,
): string {
  const id = randomUUID();
  tx.insert(responses)
    .values({
      id,
      attemptId: values.attemptId,
      questionId: values.questionId,
      questionVersion: values.questionVersion,
      questionSnapshotJson: values.questionSnapshotJson,
      unitId: values.unitId,
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
  return id;
}

/**
 * 建卷冻结写入（纯插入，事务内调用）：live 题行 → 完整契约 Question 序列化 +
 * 冻结时版本与单元归属，逐行插入。建卷时 attempt 行刚插入、responses 必无行，
 * 无需查重（与懒冻结的补写入口 backfillFrozenResponses 相区分）。
 */
function insertFrozenResponses(
  tx: Tx,
  attemptId: string,
  liveRows: readonly QuestionRow[],
  knowledgeByQuestion: ReadonlyMap<string, string[]>,
): void {
  for (const row of liveRows) {
    insertFrozenResponse(tx, {
      attemptId,
      questionId: row.id,
      questionVersion: row.version,
      questionSnapshotJson: JSON.stringify(
        questionOfRow(row, knowledgeByQuestion.get(row.id) ?? []),
      ),
      unitId: row.unitId,
    });
  }
}

/**
 * 懒冻结补写（T6R.3 迁移分支②，事务内调用）：一次查全 attempt 行建索引，
 * live 题缺行则插入、有空快照行则补齐（连带冻结单元归属 unitId）——保留学生
 * 已有答案/提示解锁/计数，**绝不覆盖非空快照**（升级遗留的损坏快照按缺失计，
 * 不拿当前题库回填伪造，方案 §5.1）；软删/缺失题的既有行不动（历史题目缺失）。
 */
function backfillFrozenResponses(
  tx: Tx,
  attemptId: string,
  liveRows: readonly QuestionRow[],
  knowledgeByQuestion: ReadonlyMap<string, string[]>,
): void {
  const existingByQuestion = new Map(
    tx
      .select({
        id: responses.id,
        questionId: responses.questionId,
        snapshot: responses.questionSnapshotJson,
      })
      .from(responses)
      .where(eq(responses.attemptId, attemptId))
      .all()
      .map((row) => [row.questionId, row] as const),
  );
  for (const row of liveRows) {
    const snapshotJson = JSON.stringify(
      questionOfRow(row, knowledgeByQuestion.get(row.id) ?? []),
    );
    const existing = existingByQuestion.get(row.id);
    if (existing === undefined) {
      insertFrozenResponse(tx, {
        attemptId,
        questionId: row.id,
        questionVersion: row.version,
        questionSnapshotJson: snapshotJson,
        unitId: row.unitId,
      });
    } else if (existing.snapshot === null) {
      tx.update(responses)
        .set({
          questionVersion: row.version,
          questionSnapshotJson: snapshotJson,
          unitId: row.unitId,
        })
        .where(eq(responses.id, existing.id))
        .run();
    }
  }
}

/**
 * 非 wrong 来源的冻结输入（**读路径，事务外调用**——better-sqlite3 同步单进程，
 * 同线程内先读后写无竞态）：attempt 单元集合内的当前 live 题（单元序 × 题序，
 * attemptQuestionRows 口径，域内取题 D10）+ 各题考点名（快照 knowledge 用，
 * 只查卷内题目的关联，不拉全教师域）。
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
  const liveRows = attemptQuestionRows(db, attempt);
  return {
    liveRows,
    knowledgeByQuestion:
      teacherId === null
        ? new Map<string, string[]>()
        : knowledgeNamesByQuestion(
            db,
            teacherId,
            liveRows.map((row) => row.id),
          ),
  };
}

/**
 * 懒冻结（T6R.3 迁移分支②，方案 §5.1）：升级前遗留的进行中 attempt
 * （frozenAt IS NULL 且 status='draft'）在首次恢复访问时冻结当前可取得版本
 * ——live 题补齐快照（保留已有答案），软删/缺失题的既有行保留为
 * 「历史题目缺失」（快照空，不回填），标记 legacy_unverified=1（不能宣称是
 * 学生更早看到的内容）。幂等：已冻结或已交卷立即返回。冻结统一发生在
 * requireUsableAttempt 门口（学生侧全部续作接口）与教师 draft 详情；
 * better-sqlite3 同步单进程，无并发竞态。
 * 返回冻结后的最新 attempt 行（懒冻结刚发生时内存里的旧对象不含新标记，
 * 分态消费方〔如 hint-service 的冻结分态〕必须用返回值）。
 */
export function ensureAttemptFrozen(db: Db, attempt: Attempt): Attempt {
  if (attempt.frozenAt !== null || attempt.status !== "draft") return attempt;
  // wrong（2026-10 起建卷即带完整快照行）：升级遗留的进行中卷**只补冻结标记**
  // ——frozenAt 回填 startedAt、legacyUnverified=false（快照即组卷时冻结的
  // 学生所见内容，可信，不标 legacy），不重读题库、不补写行
  if (attempt.sourceType === "wrong") {
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
        tx.update(attempts)
          .set({ frozenAt: fresh.startedAt, legacyUnverified: false })
          .where(eq(attempts.id, attempt.id))
          .run();
        return (
          tx.select().from(attempts).where(eq(attempts.id, attempt.id)).get() ??
          fresh
        );
      }) ?? attempt
    );
  }
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
      backfillFrozenResponses(tx, attempt.id, liveRows, knowledgeByQuestion);
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
 * 草稿保存、交卷、提示、笔迹、事件、详情、通用取卷全部经本函数进门。
 *
 * **T6R.3 冻结统一门口**：末尾经 ensureAttemptFrozen 懒冻结升级遗留草稿并
 * 返回**最新行**——分态消费方（hint-service 的「冻结卷不回退当前题库」等）
 * 必须用返回值；旧内存对象的 frozenAt=null 会误走遗留分支（/simplify 层级角
 * 修复的真 bug）。已冻结/已交卷时幂等直返。
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
  return ensureAttemptFrozen(db, attempt);
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
 * T7.7：attempt → 所属教师的有效辅助能力启用集（草稿/结果视图同口径下发）。
 * 无教师域的异常学生行兜底全启用——与题目域的 fail closed（空结果）不同：
 * 开关只影响 steps 揭晓与手写入口的渲染，不是安全边界，兜底到「多给辅助」
 * 一侧不改变正式作答与判分（方案 §4.5）。
 */
function attemptEnabledCapabilities(
  db: Db,
  attempt: Attempt,
): CapabilitySwitch[] {
  const teacherId = attemptTeacherId(db, attempt);
  return teacherId === null
    ? ["steps", "ink"]
    : getCapabilityProfile(db, teacherId).enabledCapabilities;
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

/** unitId 为 null 的兜底组标题（结构元信息缺失/卷无单元语义时的展示文案） */
export const UNGROUPED_TITLE = "未分组题目";

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

/** 冻结行条目：行 + 冻结单元归属（null = 无归属信息，消费方归兜底组） */
export interface FrozenRowEntry {
  readonly row: ResponseRow;
  readonly unitId: string | null;
}

/**
 * 冻结行的分组与展示序（T6R.3，方案 §5.1「题目集合、顺序与完整快照」全部冻结）：
 * - wrong 来源：建卷插入序（rowid）单组（卷无单元语义，unitId 恒 null）；
 * - **建卷即冻结的卷**（legacyUnverified=false 且行带冻结 unitId，建卷时
 *   写入）：**结构与顺序完全从冻结行自身重建**——组序 = unitId 在 rowid 序中
 *   的首现序（建卷组卷的单元序）、组内序 = rowid（建卷题序）。教师此后重排
 *   题目/移动单元不影响已建卷的结构（单元标题才查 units 表，仅展示文案）；
 * - **懒冻结的存量卷（legacyUnverified=true）与升级前已交卷的遗留行**：沿用
 *   域内 questions join 提供归属与排序的既有口径（存量卷的 rowid 序≠组卷序，
 *   按当前题库序展示与升级前一致；不在 attempt 单元集合内的行追加在末尾，
 *   不丢数据）；
 * - 混合行集（理论不可达——懒冻结补写快照时一并填 unitId，仅损坏快照的遗留
 *   行保持 null）：冻结行按首现序在前，null 行按 rowid 追加末尾。
 */
export function frozenRowsInDisplayOrder(
  db: Db,
  attempt: Attempt,
  /** 预载行（交卷链路免二次装载；缺省自查） */
  preloadedRows?: readonly ResponseRow[],
): FrozenRowEntry[] {
  if (attempt.sourceType === "wrong") {
    return (preloadedRows ?? attemptResponseRows(db, attempt.id)).map(
      (row) => ({
        row,
        unitId: null as string | null,
      }),
    );
  }
  const ownRows = preloadedRows ?? attemptResponseRows(db, attempt.id);
  const useFrozenOrder =
    !attempt.legacyUnverified && ownRows.some((row) => row.unitId !== null);
  if (useFrozenOrder) {
    // 冻结路径（建卷即冻结的卷）：rowid 序即建卷序，组序由消费方按 unitId
    // 首现序收集
    return ownRows.map((row) => ({ row, unitId: row.unitId }));
  }
  // 遗留路径（懒冻结的存量卷 legacyUnverified=true / 升级前已交卷）：域内
  // join 提供归属与排序——存量卷 rowid 序 ≠ 组卷序（升级前草稿行先于懒冻结
  // 补插行），按当前题库序展示与升级前一致；懒冻结补写的 unitId 仅作数据
  // 完备，不用于排序
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

/** unitGroupedRows 的一组：冻结单元归属 + 当前标题（展示文案）+ 组内行（有序） */
export interface UnitGroupedRows {
  readonly unitId: string | null;
  readonly title: string;
  readonly rows: ResponseRow[];
}

/**
 * 冻结行的单元分组（分组与顺序的**统一实现**，四类消费方共用：草稿/取卷的
 * 公开投影、学生结果视图、教师作答详情、导出——都在 frozenRowsInDisplayOrder
 * 之上）：按 unitId 收集（Map 保首现序 = 建卷单元序），组内保持行序；unitId
 * 为 null 的行归**末尾兜底组**（组 id 用 attemptId，不指涉资源；wrong 卷行全
 * 部落此组、标题「错题重练」，其余来源标题「未分组题目」——防御性分组）。
 * 标题查 units 表当前值（D1 引用语义，仅展示文案——结构冻结、文案不冻结）。
 */
export function unitGroupedRows(
  db: Db,
  attempt: Attempt,
  /** 预载行（交卷链路免二次装载；缺省自查） */
  preloadedRows?: readonly ResponseRow[],
): UnitGroupedRows[] {
  const entries = frozenRowsInDisplayOrder(db, attempt, preloadedRows);
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
  const rowsByUnit = new Map<string, ResponseRow[]>();
  const fallbackRows: ResponseRow[] = [];
  for (const { row, unitId } of entries) {
    if (unitId === null) {
      fallbackRows.push(row);
      continue;
    }
    const list = rowsByUnit.get(unitId);
    if (list === undefined) rowsByUnit.set(unitId, [row]);
    else list.push(row);
  }
  const groups: UnitGroupedRows[] = [...rowsByUnit.entries()].map(
    ([unitId, rows]) => ({
      unitId,
      title: titleByUnit.get(unitId) ?? unitId,
      rows,
    }),
  );
  if (fallbackRows.length > 0) {
    // 兜底组标题参数化：wrong 卷行全落此组（标题「错题重练」）；其余来源为
    // 正常链路不可达的防御性分组（标题「未分组题目」——人文文案，不露 id）
    groups.push({
      unitId: null,
      title:
        attempt.sourceType === "wrong" ? WRONG_PRACTICE_TITLE : UNGROUPED_TITLE,
      rows: fallbackRows,
    });
  }
  return groups;
}

/** groupedSnapshotRows 的输出组：组 id（unitId ?? attemptId）+ 标题 + 投影条目 */
export interface GroupedSnapshotRows<T> {
  readonly id: string;
  readonly title: string;
  readonly items: T[];
}

/**
 * 分组行的快照投影（四消费方共用的三连习语收敛：**跳过快照缺失行 + 组 id
 * 回退 attemptId + 空组过滤**——草稿/取卷公开投影、草稿答案/提示回显收集、
 * 学生结果视图、教师详情都在 unitGroupedRows 之上走这一层）：
 * - snapshotOf 可注入（交卷链路传判分已 parse 的快照，缺省 snapshotOfRow）；
 * - project 收 (row, snapshot, group)——消费方借 group.unitId/title 做占位。
 */
export function groupedSnapshotRows<T>(
  db: Db,
  attempt: Attempt,
  project: (row: ResponseRow, snapshot: Question, group: UnitGroupedRows) => T,
  opts?: {
    preloadedRows?: readonly ResponseRow[];
    snapshotOf?: (row: ResponseRow) => Question | null;
  },
): GroupedSnapshotRows<T>[] {
  const snapshotOf = opts?.snapshotOf ?? snapshotOfRow;
  return unitGroupedRows(db, attempt, opts?.preloadedRows)
    .map((group) => {
      const items = group.rows.flatMap((row) => {
        const snapshot = snapshotOf(row);
        return snapshot === null ? [] : [project(row, snapshot, group)];
      });
      return { id: group.unitId ?? attempt.id, title: group.title, items };
    })
    .filter((group) => group.items.length > 0);
}

/**
 * attempt 的分组公开题目（T2A.7 草稿视图与通用取卷共用；T6R.3 起三来源统一
 * 读**建卷冻结快照**，教师改题库不影响已建的卷）：题目一律取自有 responses
 * 行的 questionSnapshotJson（调用方已过 requireUsableAttempt/教师侧懒冻结），
 * 经 publicOfSnapshot 输出过滤并附每题 questionRevisionId（= 行 id，交卷回传
 * 验证用）；快照缺失的历史行按「历史题目缺失」计，跳过不显示、不回填；
 * 分组与顺序见 unitGroupedRows（冻结行自身重建）。
 */
function attemptPublicUnitGroups(
  db: Db,
  attempt: Attempt,
): (AttemptDraftUnit & StudentPaperUnit)[] {
  return groupedSnapshotRows(db, attempt, (row, snapshot) =>
    publicOfSnapshot(snapshot, row.id),
  ).map((group) => ({
    id: group.id,
    title: group.title,
    questions: group.items,
  }));
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
 * - 权限语义不变：本函数只管题目集合成员资格；课程/作业访问权守卫与懒冻结
 *   都在 requireUsableAttempt 门口（调用方先过它再进这里，「冻结内容不冻结
 *   权限」——软删/改题不再把题从进行中的卷里移走，但课程撤权等照样拦截）；
 * - 要求快照非空：快照缺失的历史行（软删/缺失题）不算可用题——旧标签页
 *   对这类题的陈旧写入按 404 拒绝，不落到永不展示/判分的行上。
 */
export function requireAttemptQuestion(
  db: Db,
  attempt: Attempt,
  questionId: string,
): { id: string } {
  const hit = db
    .select({ id: responses.id })
    .from(responses)
    .where(buildAttemptQuestionWhere(attempt.id, questionId))
    .get();
  if (hit === undefined) {
    throw new HttpError(
      404,
      "QUESTION_NOT_FOUND",
      "题目不存在或不属于这次练习",
    );
  }
  return hit;
}

/** 严格口径的 WHERE 单源（单题/批量两兄弟共用；C8）——三条件：
 * attempt 归属 + 题目成员 + 快照非空（语义见 requireAttemptQuestion 注释） */
function buildAttemptQuestionWhere(attemptId: string, questionId: string): SQL {
  return and(
    eq(responses.attemptId, attemptId),
    eq(responses.questionId, questionId),
    isNotNull(responses.questionSnapshotJson),
  ) as SQL;
}

/**
 * 严格口径的**批量**兄弟（C8，唯一消费方 note-service.getStudentNoteHeads）：
 * 一次 inArray 判定全部题目（替代 N 次点查），任一题目不在冻结集合 → 按
 * 请求序取首个缺失者抛**同码同文案** 404（可观察行为与逐题门口完全一致）。
 * questionIds 由调用方去重保序。
 */
export function requireAttemptQuestions(
  db: Db,
  attempt: Attempt,
  questionIds: readonly string[],
): void {
  const hitIds = new Set(
    db
      .select({ id: responses.questionId })
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, attempt.id),
          inArray(responses.questionId, [...questionIds]),
          isNotNull(responses.questionSnapshotJson),
        ),
      )
      .all()
      .map((row) => row.id),
  );
  for (const questionId of questionIds) {
    if (!hitIds.has(questionId)) {
      throw new HttpError(
        404,
        "QUESTION_NOT_FOUND",
        "题目不存在或不属于这次练习",
      );
    }
  }
}

/**
 * 题目成员资格的**宽松**口径（T6R.5 复审④上移至此，与上方严格口径同处可
 * 对照）：只要求该 attempt 的 responses 行存在——不查 questions 当前存活
 * （软删题历史证据可读），也不要求快照非空（升级前遗留卷的响应行仍可定位，
 * 历史读取方返回空投影而非 404；证据/笔记行本就只可能由新代码写入，遗留卷
 * 恒为空态）。消费方：note-service 的 evidence 读（学生 ② / 教师 ⑥）与
 * T6R.15 的 correction/supplement 写通道（订正/补充是历史材料，软删题照常
 * 可写——门口返回行 id 兼作 notes.questionRevisionId）；scratch 写通道
 * （笔记上传/工作稿头）仍走严格 requireAttemptQuestion。
 */
export function requireAttemptQuestionRow(
  db: Db,
  attemptId: string,
  questionId: string,
): { id: string } {
  const hit = db
    .select({ id: responses.id })
    .from(responses)
    .where(
      and(
        eq(responses.attemptId, attemptId),
        eq(responses.questionId, questionId),
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
  return hit;
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

/**
 * questions 行 → 契约 Question（判分输入与快照内容；解析失败的字段按缺省处理）。
 * T6R.20 审查修复 4 起导出：annotation-service 的 stale 判定以同构路径对题库
 * 当前行重建快照算 hash（与建卷冻结同一实现单源，不另写副本）。
 */
export function questionOfRow(row: QuestionRow, knowledge: string[]): Question {
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

/**
 * answerJson → StudentAnswer（坏数据按未作答 null 处理，不让单行脏数据打挂
 * 接口）。**全服务端唯一实现**（T6R.3 /code-review 合并——原 attempt-service
 * 的 undefined 语义与 teacher-attempt-service 的 null 语义收敛为 null，
 * 消费方按 null 判空）；供教师侧/导出/错题本/分析复用。
 */
export function answerOf(answerJson: string | null): StudentAnswer | null {
  if (answerJson === null) return null;
  const parsed = studentAnswerSchema.safeParse(jsonOf(answerJson));
  return parsed.success ? parsed.data : null;
}

// 快照解析统一走 services/snapshot.ts 的 snapshotOfRow（全服务端唯一实现，
// 含坏数据 warn 留痕）——本文件经顶部 import 使用，不再留平行 safeParse。

/**
 * 新建 draft attempt 的行字面量（三来源建卷共用；T6R.3 建卷即冻结——
 * frozenAt=startedAt、legacyUnverified=false，快照行随建卷事务预插）。
 * wrong 组卷复用时三归属键传 null、attemptNo 按已有 wrong 卷数 +1。
 */
export function newDraftAttempt(config: {
  id: string;
  studentId: string;
  sourceType: "assignment" | "course" | "wrong";
  assignmentId: string | null;
  courseId: string | null;
  unitId: string | null;
  attemptNo: number;
  startedAt: string;
}): Attempt {
  return {
    id: config.id,
    studentId: config.studentId,
    sourceType: config.sourceType,
    assignmentId: config.assignmentId,
    courseId: config.courseId,
    unitId: config.unitId,
    attemptNo: config.attemptNo,
    status: "draft",
    startedAt: config.startedAt,
    submittedAt: null,
    activeSec: null,
    device: null,
    scoreAuto: null,
    scoreFinal: null,
    frozenAt: config.startedAt,
    legacyUnverified: false,
  };
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

  const attempt = newDraftAttempt({
    id: randomUUID(),
    studentId,
    sourceType: "assignment",
    assignmentId,
    // T2A.7：courseId 取作业所属课程（可空，D9/D13）；unitId 恒 null——
    // 多单元作业题目集合走 assignment_units（attemptUnitIds），不再落单单元
    courseId: assignment.courseId,
    unitId: null,
    attemptNo: 1,
    startedAt: new Date().toISOString(),
  });
  // T6R.3：建卷冻结——题目集合/题序/完整快照/单元归属逐题预插 responses 行
  //（assignment 单元序 × 题序）；教师改题库只影响之后新建的卷。
  // 冻结输入的读在建卷事务前完成（better-sqlite3 同步单进程，同线程无竞态）
  const { liveRows, knowledgeByQuestion } = freezeInputsOfAttempt(db, attempt);
  db.transaction((tx) => {
    tx.insert(attempts).values(attempt).run();
    insertFrozenResponses(tx, attempt.id, liveRows, knowledgeByQuestion);
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
    const attempt = newDraftAttempt({
      id: randomUUID(),
      studentId,
      sourceType: "course",
      assignmentId: null,
      courseId,
      unitId,
      attemptNo: maxAttemptNo + 1,
      startedAt: new Date().toISOString(),
    });
    // T6R.3：建卷冻结——课程单元当前 live 题逐题预插快照行。冻结输入的读走
    // 外层 db（better-sqlite3 同连接同步执行，事务内读取与写入口径一致），
    // 写走 tx 与 attempt 行同事务落库
    const { liveRows, knowledgeByQuestion } = freezeInputsOfAttempt(
      db,
      attempt,
    );
    tx.insert(attempts).values(attempt).run();
    insertFrozenResponses(tx, attempt.id, liveRows, knowledgeByQuestion);
    return attemptSummaryOf(attempt);
  });
}

// ---------- GET /api/student/attempts/:id/paper（T2A.6 通用取卷） ----------

/**
 * 通用取卷（三来源共用同一响应形态 StudentPaperData）：
 * - assignment 来源：**归属即权限**，不再叠加 requireAssignmentVisible——被移出
 *   名单或作业软删后，已建作答仍可继续（§5.2「删除作业不删除已有作答记录」），
 *   取卷与详情/存答/交卷同一口径；
 * - course 来源：requireUsableAttempt 按状态分态（D7/D22）——draft 每次重校验
 *   可见性与成员资格（移出成员 → 403 COURSE_ACCESS_DENIED、条目隐藏等 →
 *   404 NOT_FOUND）；已交卷只读回看，不叠加课程校验（与 GET /attempts/:id
 *   详情同口径——T6R.3 收敛为统一进门函数后消除两接口的口径差）；
 * - 题目经 attemptPublicUnitGroups 输出过滤（冻结快照公开投影 +
 *   questionRevisionId，无答案/详解/提示）。
 */
export function getStudentAttemptPaper(
  db: Db,
  studentId: string,
  attemptId: string,
): StudentPaperData {
  // T6R.3：requireUsableAttempt 统一进门（归属/课程分态校验 + 懒冻结兜底）；
  // legacyUnverified 与草稿视图对齐（已交卷回看恒 false）
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  return {
    units: attemptPublicUnitGroups(db, attempt),
    legacyUnverified:
      attempt.status === "draft" ? attempt.legacyUnverified : false,
  };
}

// ---------- PUT /api/student/attempts/:id/answers/:questionId ----------

/**
 * 保存草稿答案（draft 阶段专用）：
 * - attempt 不存在 → 404；非本人 → 403；已交卷 → 409 ALREADY_SUBMITTED；
 * - 题目必须属于该作业单元且未软删 → 否则 404 QUESTION_NOT_FOUND；
 * - upsert responses（(attemptId, questionId) 唯一键）：写 answerJson，
 *   changeCount 每次 +1（T2.10 起用于改答案次数统计）；
 * - 快照在建卷时已冻结，判分在交卷时按冻结快照执行（T6R.3）。
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

  // T6R.3：requireAttemptQuestion 已保证该题冻结行存在（快照非空）——无插入
  // 分支（旧行缺失分支在建卷冻结后不可达，已删）；upsert 收敛为原行更新
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
    // 理论不可达（上一行成员校验刚通过）；防御性兜底不让脏状态静默
    throw new HttpError(500, "INTERNAL", "保存失败，请刷新页面后重试");
  }
  const nextCount = existing.changeCount + 1;
  db.update(responses)
    .set({ answerJson: JSON.stringify(answer), changeCount: nextCount })
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
 * 交卷回传集合与冻结题目集合的精确比对（T6R.3/T6R.10 共用）：条数不符
 * （缺项/多项）、重复项、集合外题目都视为陈旧页面提交。长度相等 + 无
 * 重复 + 全部 ∈ 冻结集合 ⇒ 恰好一致（同一 attempt 的 responses 题目 id
 * 天然无重复）。错误经工厂差异化（revisions → QUESTION_REVISION_STALE；
 * evidence → NOTE_EVIDENCE_MISMATCH）。
 */
function assertExactQuestionSet<T extends { questionId: string }>(
  graded: readonly GradedResponse[],
  items: readonly T[],
  reject: () => HttpError,
): void {
  if (items.length !== graded.length) throw reject();
  const expected = new Set(graded.map((g) => g.response.questionId));
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.questionId)) throw reject();
    seen.add(item.questionId);
    if (!expected.has(item.questionId)) throw reject();
  }
}

/**
 * 交卷回传版本验证（T6R.3）：与参与判分的冻结集合精确比对——集合形状经
 * assertExactQuestionSet，再逐题比对 questionRevisionId（错版即陈旧），
 * 409 QUESTION_REVISION_STALE 可诊断拒绝（不静默配上新快照，方案 §5.1）。
 */
function validateSubmitRevisions(
  graded: readonly GradedResponse[],
  clientRevisions: readonly AttemptSubmitRevision[],
): void {
  assertExactQuestionSet(graded, clientRevisions, revisionStale);
  const expectedByQuestion = new Map(
    graded.map((g) => [g.response.questionId, g.response.id] as const),
  );
  for (const entry of clientRevisions) {
    if (expectedByQuestion.get(entry.questionId) !== entry.questionRevisionId) {
      throw revisionStale();
    }
  }
}

/**
 * 交卷要写的逐题证据行（T6R.10，方案 §6.4）——验证纯读、先于事务，
 * 写入与判分同事务（见 submitAttempt）。
 *
 * 声明语义（契约 submitEvidenceDeclarationSchema）：
 * - frozen：versionId/revision 与服务端实际 head **精确比对**（归属已由
 *   attemptId+questionId 圈定——notes 行只能经本人 attempt 的写通道产生）；
 *   其他标签页/设备改出新 head ⇒ 409 拒绝这次冻结，不静默固定旧版；
 * - none：实际存在草稿（scratch 行 head revision>0）时矛盾 ⇒ 409——
 *   用户未确认不能静默 missing/none；
 * - missing：用户已明确选择「提交答案，草稿未保存完整」（确认动作在
 *   客户端交卷流程承担），服务端如实记录、不叠加上传状态校验。
 *
 * 旧客户端（缺 evidence 字段）：检测到草稿存在 ⇒ 409 要求刷新（不能把
 * 已有草稿记 none）；确无草稿按兼容规则交卷——**不落证据行**（= 未采集，
 * 与 state='none'〔明确空稿〕区分，schema 注释同口径）。
 *
 * 新客户端：声明集合必须与冻结题目集合精确一致（缺项/多项/未知/重复
 * 同 409，口径同 validateSubmitRevisions）。
 */
function buildSubmissionEvidence(
  db: Db,
  attemptId: string,
  graded: readonly GradedResponse[],
  declarations: readonly SubmitEvidenceDeclaration[] | undefined,
): Array<{
  questionId: string;
  state: NoteSubmissionEvidenceState;
  versionId: string | null;
}> {
  const noteRows = db
    .select()
    .from(notes)
    .where(and(eq(notes.attemptId, attemptId), eq(notes.phase, "scratch")))
    .all();
  const noteByQuestion = new Map(
    noteRows.map((n) => [n.questionId, n] as const),
  );

  if (declarations === undefined) {
    // 旧客户端：有草稿 ⇒ 拒绝并要求刷新；无草稿 ⇒ 兼容交卷（未采集=无行）
    if (noteRows.some((n) => n.currentRevision > 0)) {
      throw evidenceMismatch("这份练习有尚未固定的草稿，请刷新页面后重新交卷");
    }
    return [];
  }

  // 新客户端：集合精确比对（口径同 validateSubmitRevisions，错误码经工厂差异化）
  assertExactQuestionSet(graded, declarations, () =>
    evidenceMismatch("笔记证据声明与试卷题目不一致，请刷新页面后重新交卷"),
  );

  return declarations.map((decl) => {
    const note = noteByQuestion.get(decl.questionId);
    if (decl.state === "frozen") {
      if (
        note === undefined ||
        note.currentVersionId !== decl.versionId ||
        note.currentRevision !== decl.revision
      ) {
        throw evidenceMismatch(
          "草稿状态已变化（可能其他设备刚保存了新版本），请重新交卷",
        );
      }
      return {
        questionId: decl.questionId,
        state: "frozen" as const,
        versionId: decl.versionId,
      };
    }
    if (decl.state === "none") {
      if (note !== undefined && note.currentRevision > 0) {
        throw evidenceMismatch(
          "该题存在未固定的草稿，请返回处理后再交卷（或刷新页面查看最新草稿）",
        );
      }
      return {
        questionId: decl.questionId,
        state: "none" as const,
        versionId: null,
      };
    }
    // missing（复审接受项）：到达此分支时服务端可能已有该题矢量（客户端
    // 分类窗口的竞态——声明组装后、提交落地前他处上传成功）。按用户明示
    // 选择如实记录 missing，**不自动升格 frozen**：本地可能还有更新的未传
    // 内容，升格会把陈旧 head 伪装成原稿；已落地内容经 T6R.15 supplement
    // 找回，不冒称原稿
    return {
      questionId: decl.questionId,
      state: "missing" as const,
      versionId: null,
    };
  });
}

/** 证据声明验证失败的统一拒绝（T6R.10，409；前端据此刷新/重走交卷流程） */
function evidenceMismatch(message: string): HttpError {
  return new HttpError(409, "NOTE_EVIDENCE_MISMATCH", message);
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
  evidenceDeclarations?: readonly SubmitEvidenceDeclaration[],
): AttemptResultData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (attempt.status !== "draft") {
    throw new HttpError(409, "ALREADY_SUBMITTED", "这份练习已经交过卷了");
  }

  // T6R.3：判分输入 = 冻结快照（requireUsableAttempt 门口已懒冻结兜底）。
  // 三来源统一取行（rowid 序；判分/写入与顺序无关，展示排序在结果视图
  // 经 unitGroupedRows 重建）
  const ownRows = attemptResponseRows(db, attemptId);

  // T2.10：每题有效用时与改答案次数（服务端按事件序列计算，§5.5）
  const timeline = attemptTimeline(db, attemptId);
  const activeSecByQuestion = computePerQuestionActiveSec(timeline);
  const eventChangeCountByQuestion = countAnswerChanges(timeline);

  const graded: GradedResponse[] = [];
  for (const ownRow of ownRows) {
    const snapshot = snapshotOfRow(ownRow);
    if (snapshot === null) continue; // 历史题目缺失/坏快照按缺失计（不回填、不判分）
    // answerOf 收敛为 null 语义后按 undefined 归一（判分/序列化的未作答口径）
    const answer = answerOf(ownRow.answerJson) ?? undefined;
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
  // T6R.10：笔记证据声明验证（纯读、先于事务；写入与判分同事务）——
  // 任一项验证失败零落行，attempt 保持 draft 可恢复
  const evidenceRows = buildSubmissionEvidence(
    db,
    attemptId,
    graded,
    evidenceDeclarations,
  );

  const scoreAuto = scoreAutoOf(graded);
  // D3：交卷时 teacherMark 必空 → finalCorrect = autoCorrect；D2 据此定 status/scoreFinal
  const finalCorrects = graded.map((g) => g.autoCorrect);
  const { status: finalStatus, scoreFinal } = finalScoreOf(finalCorrects);

  const nowIso = new Date(now).toISOString();
  db.transaction((tx) => {
    for (const g of graded) {
      tx.update(responses)
        .set({
          answerJson: g.answer !== null ? JSON.stringify(g.answer) : null,
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
    // T6R.10：同一事务写 submission_evidence（方案 §6.4 第 3 步）——
    // 原稿引用与成绩/状态同生共死，任一失败整体回滚；写入后不能换原稿
    for (const row of evidenceRows) {
      tx.insert(submissionEvidence)
        .values({
          id: randomUUID(),
          attemptId,
          questionId: row.questionId,
          state: row.state,
          versionId: row.versionId,
          recordedAt: nowIso,
        })
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

  // 预加载：判分循环已 parse 的快照 + 内存镜像事务写入后的行/attempt（结果
  // 视图免二次查询/parse，且拿到的是判分后的新值——预载原始行会带旧判定）
  const updatedRows = graded.map((g) => ({
    ...g.response,
    answerJson: g.answer !== undefined ? JSON.stringify(g.answer) : null,
    autoCorrect: g.autoCorrect,
    finalCorrect: g.autoCorrect,
    activeSec: activeSecByQuestion[g.response.questionId] ?? null,
    changeCount: Math.max(
      g.response.changeCount,
      eventChangeCountByQuestion[g.response.questionId] ?? 0,
    ),
  }));
  const attemptAfter: Attempt = {
    ...attempt,
    status: finalStatus,
    submittedAt: nowIso,
    scoreAuto,
    scoreFinal,
    activeSec:
      Object.keys(activeSecByQuestion).length > 0
        ? Object.values(activeSecByQuestion).reduce((sum, sec) => sum + sec, 0)
        : null,
  };
  return buildResultData(
    db,
    attemptAfter,
    now,
    new Map(graded.map((g) => [g.response.questionId, g.question] as const)),
    updatedRows,
  );
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
  return buildResultData(db, attempt, now);
}

/**
 * 草稿视图组装（T6R.3 单一数据源：unitGroupedRows 的冻结行只查一次、快照只
 * parse 一次，公开投影/草稿答案/提示回显都从同一批行派生）。attempt 已在
 * requireUsableAttempt 门口过课程分态校验与懒冻结。
 */
function buildDraftData(db: Db, attempt: Attempt): AttemptDraftData {
  const meta = attemptSourceMeta(db, attempt);
  // T7.7：attempt → 所属教师的有效启用集（steps/ink 渲染开关随卷下发）
  const enabledCapabilities = attemptEnabledCapabilities(db, attempt);
  const drafts: Record<string, StudentAnswer> = {};
  const hintsOpened: Record<string, HintOpenedEntry[]> = {};
  // 单一数据源：行只查一次、快照只 parse 一次——公开投影/草稿答案/提示回显
  // 在同一批行上派生（groupedSnapshotRows 统一「跳过缺失+组 id 回退+空组过滤」）
  const units = groupedSnapshotRows(db, attempt, (row, snapshot) => {
    const answer = answerOf(row.answerJson);
    if (answer !== null) drafts[row.questionId] = answer;
    // T2.11：已解锁提示回显（纯函数——文本取自同一份冻结快照，不再二次查库）
    const echo = openedHintEcho(row.hintsOpenedJson, snapshot.hints);
    if (echo.length > 0) hintsOpened[row.questionId] = echo;
    return publicOfSnapshot(snapshot, row.id);
  }).map((group) => ({
    id: group.id,
    title: group.title,
    questions: group.items,
  }));
  return {
    attempt: attemptSummaryOf(attempt),
    title: meta.title,
    courseName: meta.courseName,
    dueAt: meta.dueAt,
    units,
    drafts,
    hintsOpened,
    // T6R.3：懒冻结的升级遗留卷标记（前端提示「内容为恢复后的版本」）
    legacyUnverified: attempt.legacyUnverified,
    enabledCapabilities,
  };
}

/**
 * 结果视图的单题行（快照投影：除已解锁条目外无 hints 内容，options 转纯文本；
 * D9〔T3.5〕新增 teacherMark / teacherComment / finalCorrect 透传 responses 行）。
 * 快照由调用方传入（buildResultData 预加载或现场 parse，单一解析出口 snapshotOfRow）。
 */
function resultQuestionOf(
  row: ResponseRow,
  snapshot: Question,
): AttemptResultQuestion {
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
    answer: answerOf(row.answerJson),
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
 * 结果视图组装（T2A.7 分组化；T2A.8 公布时机；T6R.3 分组/顺序统一走
 * unitGroupedRows——冻结行自身重建〔unitId 首现序分组 + rowid 组内序〕，
 * 升级前已交卷的遗留行沿用域内 join 口径；旧实现 inner join 会把 questions
 * 行缺失的响应行直接丢弃，统一为末尾兜底组展示〔修正，不丢数据〕）。
 * 历次记录的每次结果都使用各自 attempt 的 responses 快照行（D10：重做各次独立）。
 * 无快照的行（异常数据）跳过按缺失计——正常链路不发生。
 *
 * parsedByQuestion / preloadedRows（T6R.3 预加载）：交卷链路传入判分循环已
 * parse 的快照与已装载的行——同批行免二次查询/二次解析；未覆盖的行现场
 * parse（单一出口 snapshotOfRow）。attempt 行由调用方传入（requireOwnAttempt
 * 的无鉴权复读 requireAttemptRow 已删——双实现合并）。
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
  attempt: Attempt,
  now: Date | string = new Date(),
  parsedByQuestion?: ReadonlyMap<string, Question>,
  preloadedRows?: readonly ResponseRow[],
): AttemptResultData {
  const meta = attemptSourceMeta(db, attempt);
  // T7.7：结果视图同口径携带有效启用集（详解内 steps 渲染遵循开关）
  const enabledCapabilities = attemptEnabledCapabilities(db, attempt);
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

  // 逐题条目与分组同批组装（groupedSnapshotRows 统一「跳过缺失+组 id 回退+
  // 空组过滤」；快照优先取预加载，未覆盖行现场 parse）
  const resultQuestions: AttemptResultQuestion[] = [];
  const unitGroups: AttemptResultUnit[] = groupedSnapshotRows(
    db,
    attempt,
    (row, snapshot) => {
      const item = releaseAwareQuestion(resultQuestionOf(row, snapshot));
      resultQuestions.push(item);
      return item;
    },
    parsedByQuestion === undefined && preloadedRows === undefined
      ? undefined
      : {
          // 快照优先取预加载（判分已 parse），未覆盖行现场 parse
          snapshotOf: (row) =>
            parsedByQuestion?.get(row.questionId) ?? snapshotOfRow(row),
          ...(preloadedRows !== undefined ? { preloadedRows } : {}),
        },
  ).map((group) => ({
    id: group.id,
    title: group.title,
    questions: group.items,
  }));

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
    enabledCapabilities,
  };
}
