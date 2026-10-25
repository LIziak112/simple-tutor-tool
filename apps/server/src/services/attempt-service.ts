import { createHash, randomUUID } from "node:crypto";
import {
  ALL_ENABLED_CAPABILITIES,
  type AttemptAnswerSaveData,
  type AttemptAnswerSaveRequest,
  type AttemptDetailData,
  type AttemptDraftData,
  type AttemptDraftUnit,
  type AttemptMaterialRevisions,
  type AttemptQuestionPublic,
  type AttemptResultData,
  type AttemptResultQuestion,
  type AttemptResultUnit,
  type AttemptScoreSummary,
  type AttemptStartData,
  type AttemptSubmitRevision,
  attemptAnswerConflictCurrentSchema,
  attemptQuestionPublicSchema,
  type CapabilitySwitch,
  type EffectiveVerdict,
  effectiveVerdictOf,
  emptyPublicStructure,
  type GradingPolicy,
  type HintOpenedEntry,
  inspectShapeOfAnswer,
  type LessonQuestionSubmitData,
  type LessonQuestionSubmitRequest,
  type MatchingOptionsStudent,
  type MatchingSlot,
  matchingPublicStructureOf,
  materialPublicSchema,
  materialRefSchema,
  NEW_QUESTION_TYPES,
  type NoteSubmissionEvidenceState,
  type OrderingItemStudent,
  optionSchema,
  orderingPublicStructureOf,
  type PracticeFeedbackMode,
  type PracticeQuestionFeedback,
  type PracticeQuestionFeedbackData,
  type PracticeQuestionSubmitData,
  type PracticeQuestionSubmitRequest,
  type PracticeWorkflowStartOptions,
  type PublicStructureByKind,
  type Question,
  type QuestionAnswers,
  type QuestionOption,
  questionAnswersSchema,
  questionSchema,
  type SelfReviewRecord,
  type StudentAnswer,
  type StudentPaperData,
  type StudentPaperUnit,
  type SubmitEvidenceDeclaration,
  studentAnswerSchema,
  type TeacherMark,
} from "@tutor/contract";
import { gradeResponseRow } from "@tutor/grading";
import {
  expandSelectionIds,
  parseDocument,
  studentStemMd,
  wrapSingleQuestionMd,
} from "@tutor/md-dsl";
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
  annotations,
  assignmentStudents,
  assignments,
  assignmentUnits,
  attempts,
  type Course,
  courses,
  ink,
  lectures,
  type NoteRow,
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
import { touchAttemptActivity } from "./attempt-activity";
import {
  contextEntriesOf,
  frozenGradingPolicyOf,
  liveAttemptContextClosure,
} from "./attempt-context.ts";
import { getCapabilityProfile } from "./capability-profile-service";
import { requireVisibleCourseUnit } from "./course-service";
import { attemptTimeline, recordQuestionSubmitEvent } from "./event-service";
import {
  hintsOfJson,
  openedHintEcho,
  resultHintsOpenedOf,
} from "./hint-service";
import { newContentEnabledFromEnv } from "./import-qm.ts";
import {
  freezeAttemptContextSnapshotsWithin,
  listAttemptContextSnapshots,
} from "./material-repository.ts";
import { pendingMarkCount } from "./pending-mark";
import {
  answersReleased,
  attemptAnswersPublished,
  resolvePracticeQuestionFeedbackState,
} from "./practice-workflow-service";
import {
  type AttemptWorkflowView,
  assertDraftCourseVisible,
  attemptWorkflowView,
  practiceProtocolOf,
  requireOwnActiveAttempt,
  resolveNewAttemptWorkflow,
} from "./practice-workflow-wiring";

// answersReleased 原定义在本文件（T2A.8），M2 迁入纯裁决器层（题级反馈
// 四态与 wiring 进度可读性共用）；re-export 保持既有导入路径不变
export { answersReleased } from "./practice-workflow-service";

import type { Tx } from "./question-sync";
import { jsonOf, releaseOfSnapshot, snapshotOfRow } from "./snapshot";

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

/** attempt 行 → 摘要（接口形态）；导出供 wrong-practice.ts / lesson-service.ts 组卷复用（同一投影） */
export function attemptSummaryOf(row: Attempt): AttemptStartData {
  return {
    id: row.id,
    sourceType: row.sourceType,
    assignmentId: row.assignmentId,
    // 2026-10 讲练一体：lesson 开卷写入讲义 id，其余来源恒 null（契约反向锁定）
    lectureId: row.lectureId,
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
  /**
   * 行级判分策略（tt-07a / QM-06，§5.6）：开卷按题目快照写入
   * （frozenGradingPolicyOf 单一出处）；缺省 null = 旧行旧语义（懒冻结
   * 补行、开关关闭部署）。
   */
  readonly gradingPolicy?: GradingPolicy | null;
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
      gradingPolicy: values.gradingPolicy ?? null,
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
 * 2026-10 讲练一体起导出：lesson-service 开卷建卷复用（同款冻结语义）。
 * tt-07a（QM-06）：newContentEnabled 控制行级判分策略写入（§5.8.4——开关
 * 关闭的部署 gradingPolicy=NULL 旧行旧语义；缺省读部署 env）。
 */
export function insertFrozenResponses(
  tx: Tx,
  attemptId: string,
  liveRows: readonly QuestionRow[],
  knowledgeByQuestion: ReadonlyMap<string, string[]>,
  newContentEnabled?: boolean,
): void {
  const freezePolicy =
    newContentEnabled === undefined
      ? newContentEnabledFromEnv()
      : newContentEnabled;
  for (const row of liveRows) {
    const snapshot = questionOfRow(row, knowledgeByQuestion.get(row.id) ?? []);
    insertFrozenResponse(tx, {
      attemptId,
      questionId: row.id,
      questionVersion: row.version,
      questionSnapshotJson: JSON.stringify(snapshot),
      unitId: row.unitId,
      gradingPolicy: frozenGradingPolicyOf(snapshot, freezePolicy),
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
 * 2026-10 讲练一体起导出：lesson-service 开卷建卷复用（嵌入单元 live 题）。
 */
export function freezeInputsOfAttempt(
  db: Db,
  attempt: Attempt,
): {
  liveRows: QuestionRow[];
  knowledgeByQuestion: ReadonlyMap<string, string[]>;
  /** 题目所属教师域（tt-07a 依赖闭包计算用；异常行 null → 闭包为空） */
  teacherId: string | null;
} {
  const teacherId = attemptTeacherId(db, attempt);
  const liveRows = attemptQuestionRows(db, attempt);
  return {
    liveRows,
    teacherId,
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
 * 批量预取作业的公布口径（题目笔记本 2026-10 起，与 student-records 的
 * 作业记录列表同型收敛）：id 去重交调用方负责 → 单条 inArray 只取
 * answerRelease/dueAt → Map。含已软删行（作答记录不随作业软删消失，
 * requireAssignmentRow 同口径）；行异常缺失（Map 无键）的兜底方向由
 * 消费方自定——notebook 按 fail-closed 未公布（防泄露取严），student-
 * records 沿重构前既有语义 fail-open 视为已公布（记录列表不因异常行遮蔽）。
 */
export function assignmentReleaseByIds(
  db: Db,
  ids: readonly string[],
): Map<string, Pick<Assignment, "answerRelease" | "dueAt">> {
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({
        id: assignments.id,
        answerRelease: assignments.answerRelease,
        dueAt: assignments.dueAt,
      })
      .from(assignments)
      .where(inArray(assignments.id, [...ids]))
      .all()
      .map((row) => [row.id, row] as const),
  );
}

/**
 * 题级「已单题提交」领域谓词（2026-10 讲练三消费方收敛；M2 起普通 v1 卷
 * 同写本列，谓词按行值判定、来源无关）：口径按题级行值
 * （responses.submittedAt 非空），不回看 attempt 级状态——正常非 draft 卷
 * （lesson 与 v1）整卷收尾对剩余行写交卷时刻、恒非空，历史旧协议卷恒
 * null；判定方向恒取严（null = 未提交 = 不放行）。消费方：lesson-service
 * released、note-service 笔记本解析 gate、teaching-policy-service
 * 「本题完成」判定。
 */
export function lessonQuestionSubmitted(
  row: Pick<ResponseRow, "submittedAt">,
): boolean {
  return row.submittedAt !== null;
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
  // 作废卷（2026-10 讲练随时重开）：其上一切读写（详情/存草稿/单题提交/提示
  // 解锁——本函数是这些路径共用的取卷入口）都拒绝，前端提示重新进入
  if (attempt.abandonedAt !== null) {
    throw new HttpError(
      409,
      "ATTEMPT_ABANDONED",
      "这份作答已作废（讲练已重新开始），请回到讲练页继续最新一次",
    );
  }
  assertDraftCourseVisible(db, studentId, attempt);
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
 * 一侧不改变正式作答与判分（方案 §4.5）。2026-10 讲练一体起导出：
 * lesson-service 开卷投影同口径复用。
 */
export function attemptEnabledCapabilities(
  db: Db,
  attempt: Attempt,
): CapabilitySwitch[] {
  const teacherId = attemptTeacherId(db, attempt);
  return teacherId === null
    ? [...ALL_ENABLED_CAPABILITIES]
    : getCapabilityProfile(db, teacherId).enabledCapabilities;
}

/**
 * attempt 的有序单元 id 列表（T2A.7）：
 * - course 来源：[attempt.unitId]（单单元，创建时必写；防御性空列表兜底异常行；
 *   课程侧可见性由 requireVisibleCourseUnit 把关）；
 * - lesson 来源（2026-10 讲练一体）：[attempt.unitId]（嵌入单元的快照值，开卷
 *   时写入；零题讲练页为讲义 id 占位——该值下无题目行，冻结结果为空卷）；
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
  if (attempt.sourceType === "course" || attempt.sourceType === "lesson") {
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
 * 2026-10 讲练一体起导出：lesson-service 开卷投影的 questions 平铺复用
 * （同一 fail-closed 投影，防泄露口径单一出处）。
 */
export function publicOfSnapshot(
  question: Question,
  questionRevisionId: string,
  options: {
    /** 冻结材料槽位序（materialId → 有序 slotId）；matching 槽位集合展开用 */
    readonly materialSlots?: ReadonlyMap<string, readonly string[]>;
    /** 冻结行单元归属（responses.unitId；审查 P2-1 旧快照兜底重抽的语境） */
    readonly unitId?: string | null;
  } = {},
): AttemptQuestionPublic {
  // 审查 P2-1：旧格式冻结快照（三结构键全缺）从快照自身 sourceMd 兜底重抽
  const structure = effectiveStructureOfSnapshot(
    question,
    options.unitId ?? null,
  );
  return attemptQuestionPublicSchema.parse({
    id: question.id,
    type: question.type,
    difficulty: question.difficulty,
    knowledge: question.knowledge,
    stemMd: studentStemMd(question),
    ...(question.options !== undefined
      ? { options: question.options.map((option) => option.text) }
      : {}),
    // QM-09：response 字数建议（word-min/max）随公开投影下发——仅提示性
    // 数字，不含任何参考内容（§5.4.1 不硬校验不截断）
    ...(question.wordMin !== undefined ? { wordMin: question.wordMin } : {}),
    ...(question.wordMax !== undefined ? { wordMax: question.wordMax } : {}),
    // QM-13：matching 选项池 / ordering 项与展开槽位集合（slots= 区间按材料
    // 槽位序展开，材料快照缺失不携带键——学生端呈现防御形态）。2026-10-25
    // 审查 P1 收紧：两结构走学生面变体（剥离 distractor，ordering 附
    // sortableCount 计数），教师侧全量不经本投影
    ...(structure.matchingOptions !== undefined
      ? { matchingOptions: matchingOptionsStudentOf(structure.matchingOptions) }
      : {}),
    ...(structure.orderingItems !== undefined
      ? orderingStudentOf(structure.orderingItems)
      : {}),
    ...matchingSlotsProjection(structure, options.materialSlots),
    hintCount: question.hints.length,
    questionRevisionId,
  });
}

/**
 * 快照的作答面结构（含旧快照兜底，2026-10-25 审查 P2-1）：
 * snapshot.matchingOptions / orderingItems / materialRefs **三键全缺**（QM-13
 * 之前冻结的旧快照）且题型属新题型时，从快照自身的 sourceMd 重抽
 * （qmStructureOfSourceMd 同款管线：wrapSingleQuestionMd + parseDocument +
 * 按 id 命中后只取结构字段）。**不引活库**——教师改题库不影响已开卷的卷，
 * 冻结语义不变；重抽只在本次投影内使用，不回写库。导入规范化后新题型 id
 * 恒显式（缺省 id 推导不参与命中）；未命中/解析失败保持缺省（学生端呈现
 * 防御形态）。部分缺键（非全缺）= 真脏数据，同样保持缺省不兜底。
 */
function effectiveStructureOfSnapshot(
  snapshot: Question,
  unitId: string | null,
): Pick<Question, "matchingOptions" | "orderingItems" | "materialRefs"> {
  if (
    !NEW_QUESTION_TYPES.includes(snapshot.type) ||
    snapshot.matchingOptions !== undefined ||
    snapshot.orderingItems !== undefined ||
    snapshot.materialRefs !== undefined
  ) {
    return snapshot;
  }
  try {
    const parsed = parseDocument(
      wrapSingleQuestionMd(unitId ?? "", snapshot.sourceMd),
      { unitId: unitId ?? "", questionStartNumber: 1 },
    );
    const hit = parsed.units
      .flatMap((unit) => unit.questions)
      .find((item) => item.id === snapshot.id);
    if (hit === undefined) return snapshot;
    return {
      ...(hit.matchingOptions !== undefined
        ? { matchingOptions: hit.matchingOptions }
        : {}),
      ...(hit.orderingItems !== undefined
        ? { orderingItems: hit.orderingItems }
        : {}),
      ...(hit.materialRefs !== undefined
        ? { materialRefs: hit.materialRefs }
        : {}),
    };
  } catch {
    // sourceMd 损坏（历史脏行）不阻断投影：结构缺失走防御形态
    return snapshot;
  }
}

/**
 * 学生面 matching 选项池（2026-10-25 审查 P1 收紧）：剥离逐项 distractor 键
 * ——干扰项身份属答案侧信息，不随学生载荷下发（教师侧全量结构由
 * matchingOptionsSchema 承载，保存校验继续用快照全量）。匹配呈现零消费标记。
 */
function matchingOptionsStudentOf(
  pool: NonNullable<Question["matchingOptions"]>,
): MatchingOptionsStudent {
  return {
    allowRepeat: pool.allowRepeat,
    options: pool.options.map((option) => ({
      id: option.id,
      text: option.text,
    })),
  };
}

/**
 * 学生面 ordering 项 + sortableCount（2026-10-25 审查 P1 收紧）：逐项剥离
 * distractor 键（ordering 干扰项由参考序列推导，逐项下发=公布前枚举答案成员）；
 * 学生要自行放置的项数（非干扰且非固定）改以计数下发，板行数与完成度由它
 * 派生（固定项恒非干扰——fixedPosition 声明自参考序列）。
 */
function orderingStudentOf(items: NonNullable<Question["orderingItems"]>): {
  orderingItems: OrderingItemStudent[];
  sortableCount: number;
} {
  return {
    orderingItems: items.map(({ id, text, fixedPosition }) => ({
      id,
      text,
      fixedPosition,
    })),
    sortableCount: items.filter(
      (item) => !item.distractor && item.fixedPosition === null,
    ).length,
  };
}

/**
 * matching 槽位集合投影：题级 ::ref{slots=} 按材料槽位序展开（QM-13 细项 2），
 * 2026-10-25 审查 P2-2 起行附材料槽位序 ordinal（材料文档位置 1 起）——子集
 * 选择（slots=slot-3..slot-5）沿用材料编号 3/4/5，题内「第 N 空」标签与材料
 * 面板编号空位（N）对齐，不用题内重排的 1/2/3。
 * 门控走数据驱动（materialRefs[].slots 存在性）而非题型字面量分支（I16）：
 * lint 第二遍已保证 slots= 只出现在 matching 题（references.ts 收口），其他
 * 题型的 materialRefs 无 slots 键、展开恒为空。
 */
function matchingSlotsProjection(
  question: Pick<Question, "materialRefs">,
  materialSlots: ReadonlyMap<string, readonly string[]> | undefined,
): { matchingSlots?: MatchingSlot[] } {
  if (question.materialRefs === undefined || materialSlots === undefined) {
    return {};
  }
  const rows: MatchingSlot[] = [];
  for (const ref of question.materialRefs) {
    if (ref.slots === undefined) continue;
    const order = materialSlots.get(ref.material);
    if (order === undefined) continue;
    for (const id of expandSelectionIds(ref.slots, order)) {
      if (rows.some((row) => row.id === id)) continue;
      // 展开产物必属材料槽位序（lint SLOT_UNBOUND 收口）；显式单点的未知 id
      // 属防御形态，无材料位置可言，回落题内行序保证 ordinal 恒正
      const at = order.indexOf(id);
      rows.push({ id, ordinal: at >= 0 ? at + 1 : rows.length + 1 });
    }
  }
  return rows.length > 0 ? { matchingSlots: rows } : {};
}

/**
 * 冻结材料槽位序（QM-13）：attemptId → materialId → 有序 slotId 列表。
 * 读 attempt_context_snapshots 冻结快照，同 id 多版本取最高 sourceVersion
 * （行序已按 sourceVersion 升序，后写覆盖即最新；与 attempt-context-view
 * latestById 同口径）；坏快照/坏 JSON 跳过该条不抛错（投影侧防御口径：
 * matchingSlots 缺失只是少作答面，不让单条脏快照打挂整卷取卷——与
 * /context 端点的显式 409 口径不同，后者是学生显式读上下文的独立防线）。
 */
export function materialSlotOrderOf(
  db: Db,
  attemptId: string,
): Map<string, readonly string[]> {
  const order = new Map<string, readonly string[]>();
  for (const row of listAttemptContextSnapshots(db, attemptId)) {
    if (row.kind !== "material") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.snapshotJson) as unknown;
    } catch {
      continue;
    }
    const material = materialPublicSchema.safeParse(parsed);
    if (!material.success || material.data.slots.length === 0) continue;
    order.set(
      material.data.id,
      material.data.slots.map((slot) => slot.id),
    );
  }
  return order;
}

/**
 * 快照 → 完整公开结构集（QM-13 保存校验用；QM-16 起导出/序列化共用出口）：
 * matching 选项池 + 展开槽位集合、ordering 项；旧快照（三键全缺）先经
 * effectiveStructureOfSnapshot 兜底重抽（审查 P2-1）。结构仍缺失（选项池/
 * 排序项/材料槽位快照不可用或重抽未命中）按 emptyPublicStructure 防御形态
 * （inspectShape 对空结构无从校验即放行，只影响该维度校验，不影响其余防线）。
 * QM-16：matchingSlots 行附材料槽位序 ordinal 映射进结构（slotOrdinals），
 * 文本化「第 N 空」与材料面板（N）编号同口径——待批队列/CSV/单题包/AI
 * 受控出口的配对答案序列化共用本函数，不另写结构装配。
 */
export function structuresOfSnapshot(
  snapshot: Question,
  materialSlots: ReadonlyMap<string, readonly string[]>,
  unitId: string | null,
): PublicStructureByKind {
  const structure = effectiveStructureOfSnapshot(snapshot, unitId);
  const matchingSlots =
    structure.matchingOptions !== undefined
      ? (matchingSlotsProjection(structure, materialSlots).matchingSlots ?? [])
      : [];
  const matching =
    structure.matchingOptions !== undefined
      ? matchingPublicStructureOf(
          structure.matchingOptions,
          // 结构校验只认槽位 id 集合（P2-2 的 ordinal 是呈现用材料序，校验零消费）
          matchingSlots.map((row) => row.id),
          // QM-16：ordinal 映射（slotOrdinals）——结构校验零消费，序列化消费
          Object.fromEntries(matchingSlots.map((row) => [row.id, row.ordinal])),
        )
      : emptyPublicStructure.matching;
  const ordering =
    structure.orderingItems !== undefined
      ? orderingPublicStructureOf(structure.orderingItems)
      : emptyPublicStructure.ordering;
  return { ...emptyPublicStructure, matching, ordering };
}

/**
 * QM-13 细项4：新题型答案的保存结构校验（saveDraftAnswer 内调用）。
 * 只检查合法结构——契约 inspectShapeOfAnswer 单源调度（未知槽位/未知选项/
 * 重复占用/干扰项入序/固定项错位/未知项/重复项），非法结构整体拒绝
 * （400 VALIDATION_ERROR）；部分作答（部分配对/部分序列/空清除态）合法。
 * **永不比对参考答案**（对错恒 null，gradeNewKindAlwaysNull 口径不动）。
 * 旧七型零变化：门控走 NEW_QUESTION_TYPES 单源集合（I16 集合成员口径，
 * 不写字面量分支）。
 */
function assertNewKindAnswerShape(
  db: Db,
  attemptId: string,
  questionId: string,
  answer: StudentAnswer,
): void {
  const row = db
    .select({
      attemptId: responses.attemptId,
      questionId: responses.questionId,
      unitId: responses.unitId,
      questionSnapshotJson: responses.questionSnapshotJson,
    })
    .from(responses)
    .where(
      and(
        eq(responses.attemptId, attemptId),
        eq(responses.questionId, questionId),
      ),
    )
    .get();
  // 成员校验先行（requireAttemptQuestion 已挡不存在行）；防御性兜底不静默
  if (row === undefined) throw questionNotFound();
  const snapshot = snapshotOfRow(row);
  if (snapshot === null || !NEW_QUESTION_TYPES.includes(snapshot.type)) return;
  const structures = structuresOfSnapshot(
    snapshot,
    materialSlotOrderOf(db, attemptId),
    row.unitId,
  );
  const issues = inspectShapeOfAnswer(answer, structures);
  if (issues.length > 0) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      `答案结构不合法：${issues.map((issue) => issue.message).join("；")}`,
    );
  }
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
  // QM-13：matching 槽位集合按冻结材料槽位序展开（一次取全卷共用）
  const materialSlots = materialSlotOrderOf(db, attempt.id);
  return groupedSnapshotRows(db, attempt, (row, snapshot) =>
    publicOfSnapshot(snapshot, row.id, {
      materialSlots,
      // 审查 P2-1：旧快照兜底重抽的解析语境（行内冻结单元归属）
      unitId: row.unitId,
    }),
  ).map((group) => ({
    id: group.id,
    title: group.title,
    questions: group.items,
  }));
}

/** 答题页顶部展示的来源信息（assignment=作业标题+截止+公布时机；course=单元标题+课程名） */
interface AttemptSourceMeta {
  title: string;
  courseName: string | null;
  dueAt: string | null;
  /**
   * 公布时机（2026-10-21 交卷前置预期）：assignment = 作业行原值；course/wrong
   * 恒 'on_submit'（D11 交卷即公布）；lesson attempt 级不适用（当题释放恒题级
   * 粒度）同样投影 'on_submit'。草稿视图据此下发，交卷弹窗展示「截止后统一
   * 公布」预期；结果视图权威 gate 仍是 answersReleased（读时判定）。
   */
  answerRelease: Assignment["answerRelease"];
}

/**
 * lesson 来源的上下文单源（2026-10 讲练一体收敛；本模块 attemptSourceMeta
 * 学生侧与 teacher-attempt-service.sourceOf 教师侧两投影共用，不再各自查行）：
 * - 标题链（以教师侧既有三级链为准，更完备）：讲义标题（D1 引用语义，随行
 *   当前值）→ 嵌入单元标题（teacherId 域内，讲义行异常缺失时兜底）→
 *   attempt.unitId →「讲练练习」（人文文案兜底，不露异常）；
 * - 课程名随 courseId 行（打开时来自哪门课；可空 → null）。
 */
export function lessonSourceContextOf(
  db: Db,
  attempt: Attempt,
  teacherId: string | null,
): { title: string; courseName: string | null } {
  const lecture =
    attempt.lectureId !== null
      ? db
          .select({ title: lectures.title })
          .from(lectures)
          .where(eq(lectures.id, attempt.lectureId))
          .get()
      : undefined;
  const course =
    attempt.courseId !== null
      ? db
          .select({ title: courses.title })
          .from(courses)
          .where(eq(courses.id, attempt.courseId))
          .get()
      : undefined;
  const unit =
    lecture === undefined && attempt.unitId !== null && teacherId !== null
      ? db
          .select({ title: units.title })
          .from(units)
          .where(
            and(eq(units.teacherId, teacherId), eq(units.id, attempt.unitId)),
          )
          .get()
      : undefined;
  return {
    // 讲义标题 → 嵌入单元标题 → attempt.unitId →「讲练练习」
    title: lecture?.title ?? unit?.title ?? attempt.unitId ?? "讲练练习",
    courseName: course?.title ?? null,
  };
}

function attemptSourceMeta(db: Db, attempt: Attempt): AttemptSourceMeta {
  if (attempt.sourceType === "wrong") {
    // 错题重练（2026-10）：标题固定「错题重练」，无课程/截止
    //（「错题重练 · 第 n 次」的来源行由前端从 attemptNo 拼）
    return {
      title: WRONG_PRACTICE_TITLE,
      courseName: null,
      dueAt: null,
      answerRelease: "on_submit",
    };
  }
  if (attempt.sourceType === "lesson") {
    // 讲练页（2026-10）：标题 = 讲练页讲义当前标题（D1 引用语义），不限截止
    //（lesson 当题释放恒题级粒度，不适用 answerRelease，见 attemptSourceSchema）；
    // courseId 可空（打开时来自哪门课），课程名随行。上下文与教师侧 sourceOf
    // 同一实现（lessonSourceContextOf，标题兜底链以教师侧三级链为准）
    const { title, courseName } = lessonSourceContextOf(
      db,
      attempt,
      attemptTeacherId(db, attempt),
    );
    return { title, courseName, dueAt: null, answerRelease: "on_submit" };
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
      answerRelease: "on_submit",
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
    answerRelease: assignment.answerRelease,
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
    throw questionNotFound();
  }
  return hit;
}

/**
 * 单题提交后的**行级锁定守卫**（2026-10 讲练一体；M2 起普通 v1 卷已提交行
 * 同守卫）：该题已单题提交（responses.submittedAt 非空）→ 409
 * QUESTION_ALREADY_SUBMITTED——判定已按提交时的答案落定，答案与笔迹此后
 * 不可再改（saveDraftAnswer / saveInk 调用，都在 requireAttemptQuestion
 * 之后）。历史旧协议行的 submittedAt 恒 null，既有来源行为零变化。
 */
export function assertRowNotSubmitted(
  db: Db,
  attemptId: string,
  questionId: string,
  action = "修改答案",
): void {
  const row = db
    .select({ submittedAt: responses.submittedAt })
    .from(responses)
    .where(
      and(
        eq(responses.attemptId, attemptId),
        eq(responses.questionId, questionId),
      ),
    )
    .get();
  if (row !== undefined && row.submittedAt !== null) {
    throw new HttpError(
      409,
      "QUESTION_ALREADY_SUBMITTED",
      `这道题已经提交过了，不能再${action}`,
    );
  }
}

/** 严格口径的 WHERE 单源（单题/批量两兄弟共用；C8）——三条件：
 * attempt 归属 + 题目成员 + 快照非空（语义见 requireAttemptQuestion 注释） */
export function buildAttemptQuestionWhere(
  attemptId: string,
  questionId: string,
): SQL {
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
      throw questionNotFound();
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
    throw questionNotFound();
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
 * QM-09（TT-08b）：新题型的无专列结构化字段（今日 word-min/max，后续
 * matching/ordering 选项池等）沿用 reparse 的「结构化字段以 sourceMd 为单一
 * 来源」口径，建卷冻结时从 sourceMd 重抽取（wrapSingleQuestionMd +
 * parseDocument 同款机制，零迁移）；门控用契约 NEW_QUESTION_TYPES 单源集合
 * （不写题型字面量判别——I16 守卫口径），仅新题型行付出解析成本、旧七型
 * 零开销；解析失败静默缺省（建议只是提示性投影，缺失不阻断建卷）。
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
  const question = questionSchema.parse({
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
  // 题级 ::ref 抽取副本（tt-05b 列；cloze 槽位绑定/matching 槽位集合声明）
  if (row.materialRefsJson !== null) {
    const refs = materialRefSchema
      .array()
      .safeParse(jsonOf(row.materialRefsJson));
    if (refs.success && refs.data.length > 0) {
      question.materialRefs = refs.data;
    }
  }
  if (NEW_QUESTION_TYPES.includes(row.type)) {
    const structure = qmStructureOfSourceMd(row);
    if (structure.wordMin !== undefined) question.wordMin = structure.wordMin;
    if (structure.wordMax !== undefined) question.wordMax = structure.wordMax;
    // matching 选项池 / ordering 项（QM-13）：无专列结构化字段循 word-min/max
    // 同款「sourceMd 为单一来源」重抽口径（§19.2-4，零迁移不另建第二套）
    if (structure.matchingOptions !== undefined) {
      question.matchingOptions = structure.matchingOptions;
    }
    if (structure.orderingItems !== undefined) {
      question.orderingItems = structure.orderingItems;
    }
  }
  return question;
}

/**
 * 单题 sourceMd → 无专列结构化字段的重抽通道（word-min/word-max +
 * matchingOptions/orderingItems，QM-13 扩展）。包装与解析选项与
 * reparse-service.planQuestion 完全同款（unitId/起始序号覆盖缺省 id 推导，
 * 保证解析出的题与库中行同 id）；包装内恰一题，按 id 命中后只取无专列字段，
 * 其余字段一概不采（快照仍按既有列组卷）。解析失败静默缺省（建议/结构缺失
 * 只是少作答面投影，不阻断建卷——结构缺失时学生端呈现防御形态）。
 */
function qmStructureOfSourceMd(row: QuestionRow): {
  wordMin?: number;
  wordMax?: number;
  matchingOptions?: Question["matchingOptions"];
  orderingItems?: Question["orderingItems"];
} {
  try {
    const parsed = parseDocument(
      wrapSingleQuestionMd(row.unitId, row.sourceMd),
      { unitId: row.unitId, questionStartNumber: row.order + 1 },
    );
    const hit = parsed.units
      .flatMap((unit) => unit.questions)
      .find((item) => item.id === row.id);
    return hit === undefined
      ? {}
      : {
          ...(hit.wordMin !== undefined ? { wordMin: hit.wordMin } : {}),
          ...(hit.wordMax !== undefined ? { wordMax: hit.wordMax } : {}),
          ...(hit.matchingOptions !== undefined
            ? { matchingOptions: hit.matchingOptions }
            : {}),
          ...(hit.orderingItems !== undefined
            ? { orderingItems: hit.orderingItems }
            : {}),
        };
  } catch {
    // sourceMd 损坏（历史脏行）不阻断建卷：字数建议缺失只是少一条提示
    return {};
  }
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

/** 建卷请求的可选工作流选项（M1b；契约 attemptStartOptionsRequestSchema 解析产物） */
export type AttemptWorkflowStartOptions = PracticeWorkflowStartOptions;

/** options → attempts 工作流三列（旧协议返回空对象，由 newDraftAttempt 缺省兜底；wrong-practice 复用） */
export function workflowStartColumns(
  db: Db,
  sourceType: "assignment" | "course" | "wrong",
  studentId: string,
  assignmentId: string | null,
  options: AttemptWorkflowStartOptions,
  /** 该卷的单元 id（M5-D2 文档推荐档：course 传单元、assignment 恒不传——
   * 多单元按 assignment_units 聚合；wrong 不传，恒无推荐） */
  unitId?: string | null,
): {
  practiceWorkflowVersion?: 1;
  feedbackMode?: PracticeFeedbackMode;
  workflowRevision?: number;
} {
  if (options.workflowVersion !== 1) return {};
  const resolved = resolveNewAttemptWorkflow(db, {
    sourceType,
    studentId,
    assignmentId,
    unitId: unitId ?? null,
    studentChoice: options.feedbackMode ?? null,
  });
  return {
    practiceWorkflowVersion: resolved.practiceWorkflowVersion,
    feedbackMode: resolved.feedbackMode,
    workflowRevision: resolved.workflowRevision,
  };
}

/**
 * 新建 draft attempt 的行字面量（四来源建卷共用；T6R.3 建卷即冻结——
 * frozenAt=startedAt、legacyUnverified=false，快照行随建卷事务预插）。
 * wrong 组卷复用时三归属键传 null、attemptNo 按已有 wrong 卷数 +1；
 * lesson 开卷（2026-10）传 lectureId（所属讲练页，契约归属不变式）。
 */
export function newDraftAttempt(config: {
  id: string;
  studentId: string;
  sourceType: "assignment" | "course" | "wrong" | "lesson";
  assignmentId: string | null;
  courseId: string | null;
  unitId: string | null;
  /** 所属讲练页（lectures.id）；仅 lesson 来源传值，其余恒 null（2026-10） */
  lectureId?: string | null;
  attemptNo: number;
  startedAt: string;
  /**
   * 新协议工作流选项（M1b）：仅 course/assignment/wrong 建卷在显式
   * workflowVersion=1 请求时由服务端按教师规则裁决后传入；缺省 = 旧协议
   * （version/mode 为 NULL，revision 0），lesson 恒缺省（独立适配路径）。
   */
  practiceWorkflowVersion?: 1 | null;
  feedbackMode?: "per_question" | "after_attempt" | null;
  workflowRevision?: number;
}): Attempt {
  return {
    id: config.id,
    studentId: config.studentId,
    sourceType: config.sourceType,
    assignmentId: config.assignmentId,
    courseId: config.courseId,
    unitId: config.unitId,
    // 讲练一体（2026-10）：lesson 开卷写入讲义 id；assignment/course/wrong 恒 null
    lectureId: config.lectureId ?? null,
    attemptNo: config.attemptNo,
    status: "draft",
    startedAt: config.startedAt,
    lastActivityAt: null,
    submittedAt: null,
    activeSec: null,
    device: null,
    scoreAuto: null,
    scoreFinal: null,
    frozenAt: config.startedAt,
    legacyUnverified: false,
    // 作废时刻（2026-10 讲练随时重开）：建卷恒 null，讲练重开时才由
    // restartLessonAttempt 写入
    abandonedAt: null,
    // M1b 工作流列：缺省旧协议（NULL/NULL/0），新协议卷由建卷路径显式传入
    practiceWorkflowVersion: config.practiceWorkflowVersion ?? null,
    feedbackMode: config.feedbackMode ?? null,
    workflowRevision: config.workflowRevision ?? 0,
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
  options: AttemptWorkflowStartOptions = {},
  /** tt-07a：判分策略写入开关（缺省读部署 env，§5.8.4）；测试显式注入 */
  newContentEnabled?: boolean,
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
    // M1b：仅显式 workflowVersion=1 走新协议（服务端按作业授权裁决）；
    // 省略维持旧协议（version/mode NULL），已有 draft 走上文 create-or-return
    ...workflowStartColumns(db, "assignment", studentId, assignmentId, options),
  });
  // T6R.3：建卷冻结——题目集合/题序/完整快照/单元归属逐题预插 responses 行
  //（assignment 单元序 × 题序）；教师改题库只影响之后新建的卷。
  // 冻结输入的读在建卷事务前完成（better-sqlite3 同步单进程，同线程无竞态）
  const { liveRows, teacherId, knowledgeByQuestion } = freezeInputsOfAttempt(
    db,
    attempt,
  );
  // tt-07a（QM-06）：材料/组依赖闭包同事务冻结（缺依赖先于事务 fail closed）
  const entries =
    teacherId === null
      ? []
      : contextEntriesOf(
          liveAttemptContextClosure(
            db,
            teacherId,
            liveRows.map((row) => row.id),
          ),
        );
  db.transaction((tx) => {
    tx.insert(attempts).values(attempt).run();
    insertFrozenResponses(
      tx,
      attempt.id,
      liveRows,
      knowledgeByQuestion,
      newContentEnabled,
    );
    freezeAttemptContextSnapshotsWithin(
      tx,
      attempt.id,
      entries,
      attempt.startedAt,
    );
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
  options: AttemptWorkflowStartOptions = {},
  /** tt-07a：判分策略写入开关（缺省读部署 env，§5.8.4）；测试显式注入 */
  newContentEnabled?: boolean,
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
      // M1b：显式 workflowVersion=1 按教师策略裁决写新协议列；省略旧协议。
      // M5-D2：传该卷 unitId——学生未设置偏好时课程单元的文档推荐参与裁决
      ...workflowStartColumns(db, "course", studentId, null, options, unitId),
    });
    // T6R.3：建卷冻结——课程单元当前 live 题逐题预插快照行。冻结输入的读走
    // 外层 db（better-sqlite3 同连接同步执行，事务内读取与写入口径一致），
    // 写走 tx 与 attempt 行同事务落库
    const { liveRows, teacherId, knowledgeByQuestion } = freezeInputsOfAttempt(
      db,
      attempt,
    );
    // tt-07a（QM-06）：材料/组依赖闭包同事务冻结（读在外层 db，同款口径）
    const entries =
      teacherId === null
        ? []
        : contextEntriesOf(
            liveAttemptContextClosure(
              db,
              teacherId,
              liveRows.map((row) => row.id),
            ),
          );
    tx.insert(attempts).values(attempt).run();
    insertFrozenResponses(
      tx,
      attempt.id,
      liveRows,
      knowledgeByQuestion,
      newContentEnabled,
    );
    freezeAttemptContextSnapshotsWithin(
      tx,
      attempt.id,
      entries,
      attempt.startedAt,
    );
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
/** 本人材料版本盘点；只读且不包含题目参考答案或笔迹正文。 */
export function getAttemptMaterialRevisions(
  db: Db,
  studentId: string,
  attemptId: string,
): AttemptMaterialRevisions {
  requireUsableAttempt(db, studentId, attemptId);
  return {
    notes: Object.fromEntries(
      db
        .select({ id: notes.questionId, revision: notes.currentRevision })
        .from(notes)
        .where(and(eq(notes.attemptId, attemptId), eq(notes.phase, "scratch")))
        .all()
        .map((row) => [row.id, row.revision]),
    ),
    annotations: Object.fromEntries(
      db
        .select({ id: annotations.questionId, revision: annotations.revision })
        .from(annotations)
        .where(
          and(
            eq(annotations.attemptId, attemptId),
            eq(annotations.phase, "scratch"),
          ),
        )
        .all()
        .map((row) => [row.id, row.revision]),
    ),
    ink: Object.fromEntries(
      db
        .select({ id: ink.questionId, revision: ink.revision })
        .from(ink)
        .where(eq(ink.attemptId, attemptId))
        .all()
        .map((row) => [row.id, row.revision]),
    ),
  };
}

export function saveDraftAnswer(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  answer: StudentAnswer,
  options: Pick<AttemptAnswerSaveRequest, "baseRevision" | "mutationId"> = {},
): AttemptAnswerSaveData {
  return db.transaction((tx) => {
    const attempt = requireUsableAttempt(db, studentId, attemptId);
    if (attempt.status !== "draft") {
      throw new HttpError(
        409,
        "ALREADY_SUBMITTED",
        "这份练习已交卷，不能再修改答案",
      );
    }
    requireAttemptQuestion(db, attempt, questionId);
    // lesson 单题提交后的行级锁定（2026-10）：已提交题的答案不可再改
    //（判定已按提交时的答案落定；非 lesson 行 submittedAt 恒 null，零变化）
    assertRowNotSubmitted(db, attemptId, questionId);
    // QM-13 细项4：新题型保存只校验合法结构（部分作答=草稿合法），
    // 永不比对参考答案；旧七型行为零变化
    assertNewKindAnswerShape(db, attemptId, questionId, answer);

    // T6R.3：requireAttemptQuestion 已保证该题冻结行存在（快照非空）——无插入
    // 分支（旧行缺失分支在建卷冻结后不可达，已删）；upsert 收敛为原行更新
    const existing = tx
      .select({
        id: responses.id,
        changeCount: responses.changeCount,
        answerJson: responses.answerJson,
        answerRevision: responses.answerRevision,
        answerMutationId: responses.answerMutationId,
      })
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
    const encoded = JSON.stringify(answer);
    const conflict = () =>
      new HttpError(
        409,
        "ANSWER_REVISION_CONFLICT",
        "本题答案在另一设备已更新，请选择保留当前设备版本或采用云端版本",
        {
          _current: attemptAnswerConflictCurrentSchema.parse({
            revision: existing.answerRevision,
            draft: answerOf(existing.answerJson),
          }),
        },
      );
    if (
      options.baseRevision === undefined &&
      existing.answerMutationId !== null
    )
      throw conflict();
    if (
      options.mutationId !== undefined &&
      existing.answerMutationId === options.mutationId
    ) {
      if (encoded !== existing.answerJson) throw conflict();
      return {
        questionId,
        changeCount: existing.changeCount,
        revision: existing.answerRevision,
      };
    }
    // 内容相同即收敛，不要求用户裁决，也不重复计数；接管后阻止旧客户端盲写。
    if (options.baseRevision !== undefined && encoded === existing.answerJson) {
      tx.update(responses)
        .set({ answerMutationId: options.mutationId })
        .where(eq(responses.id, existing.id))
        .run();
      return {
        questionId,
        changeCount: existing.changeCount,
        revision: existing.answerRevision,
      };
    }
    if (
      options.baseRevision !== undefined &&
      options.baseRevision !== existing.answerRevision
    )
      throw conflict();
    const nextCount = existing.changeCount + 1;
    const nextRevision = existing.answerRevision + 1;
    tx.update(responses)
      .set({
        answerJson: encoded,
        changeCount: nextCount,
        answerRevision: nextRevision,
        ...(options.mutationId === undefined
          ? {}
          : { answerMutationId: options.mutationId }),
      })
      .where(eq(responses.id, existing.id))
      .run();
    if (encoded !== existing.answerJson)
      touchAttemptActivity(tx, attemptId, new Date().toISOString());
    return { questionId, changeCount: nextCount, revision: nextRevision };
  });
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

/**
 * scoreAuto 口径：答对数 / 可自动判分数（autoCorrect 非 null），四舍五入百分比；
 * 无可判分为 null。入参结构化（只需 autoCorrect）：交卷链路传判分中间结果，
 * lesson 单题提交自动收尾传事务内重读的冻结行（同口径复用，不复制公式）。
 */
function scoreAutoOf(
  graded: readonly { autoCorrect: boolean | null }[],
): number | null {
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
 * 旧客户端（缺 evidence 字段）：检测到**参与本次判分题目的**草稿存在 ⇒ 409
 * 要求刷新（不能把已有草稿记 none）；确无草稿按兼容规则交卷——**不落证据行**
 * （= 未采集，与 state='none'〔明确空稿〕区分）。graded 范围 = 本次交卷要
 * 判分的行（lesson 与新协议普通卷整卷收尾只含未提交题——已单题提交题的
 * 证据已在该题提交事务冻结，其草稿不再阻塞收尾；历史协议为全部冻结题）。
 *
 * 新客户端：声明集合必须与 graded 范围精确一致（缺项/多项/未知/重复
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
    // 旧客户端：范围内有草稿 ⇒ 拒绝并要求刷新；无草稿 ⇒ 兼容交卷（未采集=无行）
    const scope = new Set(graded.map((g) => g.response.questionId));
    if (
      noteRows.some((n) => n.currentRevision > 0 && scope.has(n.questionId))
    ) {
      throw evidenceMismatch("这份练习有尚未固定的草稿，请刷新页面后重新交卷");
    }
    return [];
  }

  // 新客户端：集合精确比对（口径同 validateSubmitRevisions，错误码经工厂差异化）
  assertExactQuestionSet(graded, declarations, () =>
    evidenceMismatch("笔记证据声明与试卷题目不一致，请刷新页面后重新交卷"),
  );

  return declarations.map((decl) =>
    evidenceRowOfDeclaration(noteByQuestion.get(decl.questionId), decl),
  );
}

/**
 * 单条证据声明的验证核心（整卷 buildSubmissionEvidence 与 lesson 单题
 * buildSingleQuestionEvidence 共用，语义见上方注释块）：
 * 返回要写的证据行；任何不符抛 409 NOTE_EVIDENCE_MISMATCH。
 */
function evidenceRowOfDeclaration(
  note: NoteRow | undefined,
  decl: SubmitEvidenceDeclaration,
): {
  questionId: string;
  state: NoteSubmissionEvidenceState;
  versionId: string | null;
} {
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
}

/**
 * lesson 单题提交的证据验证（T6R.10 语义单题化，2026-10 讲练一体）：
 * - 声明缺省 = 旧客户端——该题存在草稿（scratch 行 head revision>0）⇒ 409
 *   拒绝、确无草稿不落行（未采集，与整卷兼容规则同口径）；
 * - 声明携带时 evidence.questionId 必须与路径 questionId 一致（否则 409
 *   NOTE_EVIDENCE_MISMATCH——契约注释「须与路径一致，服务端校验」）；
 * - 逐声明验证复用 evidenceRowOfDeclaration（与整卷同一实现，不复制语义）。
 * 验证纯读、先于事务；返回 null = 本次提交不落证据行。
 */
function buildSingleQuestionEvidence(
  db: Db,
  attemptId: string,
  questionId: string,
  decl: SubmitEvidenceDeclaration | undefined,
): {
  questionId: string;
  state: NoteSubmissionEvidenceState;
  versionId: string | null;
} | null {
  const note = db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.attemptId, attemptId),
        eq(notes.questionId, questionId),
        eq(notes.phase, "scratch"),
      ),
    )
    .get();
  if (decl === undefined) {
    if (note !== undefined && note.currentRevision > 0) {
      throw evidenceMismatch("这道题有尚未固定的草稿，请刷新页面后重新提交");
    }
    return null;
  }
  if (decl.questionId !== questionId) {
    throw evidenceMismatch(
      "笔记证据声明与提交的题目不一致，请刷新页面后重新提交",
    );
  }
  return evidenceRowOfDeclaration(note, decl);
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
 * 收尾判定的行级输入（attemptFinalOutcomeOf 消费；finalCorrect 为该口径下
 * 的写入后事实值——交卷链路 = autoCorrect，批改链路 = teacherMark ?? autoCorrect）
 */
export interface FinalOutcomeRow {
  readonly gradingPolicy: GradingPolicy | null;
  readonly submittedAt: string | null;
  /** 教师批改标记（teacher_pending 判定只消费 null 与否，形态由列类型把关） */
  readonly teacherMark: string | null;
  readonly finalCorrect: boolean | null;
}

/**
 * QM-10 细项7（§5.5.5 graded 触发放宽，新行口径单一出处——交卷/自动收尾/
 * 教师批改重算三链路共用）：
 * - **旧行旧口径（历史不重释）**：任一行 gradingPolicy=NULL（升级前开的卷、
 *   开关关闭部署）→ 整卷按 finalScoreOf（D2/D3：全部 finalCorrect 非 null 才
 *   graded）。正常数据新旧不混卷（行策略在开卷时整卷冻结），混卷防御性取
 *   旧口径——与「禁止重释历史」同一保守侧；
 * - **新行口径**：graded ⟺ 全部行已提交 且 无「教师待处理」行
 *   （manual_only 且 teacherMark=null——判定来源枯竭，唯一出口是教师；
 *   reference_self 行自评与否不阻塞，「完成作答不以自评为前提」）；
 * - opts.finalized（整卷已收尾）时全部行按已提交语义参与 allSubmitted——与
 *   四态 gate（practiceQuestionFeedbackStateOf）同口径：整卷交卷/收尾即全部
 *   判分行已交，legacy 协议行不写行级 submittedAt（逐题列，协议分野保持）；
 *   scoreFinal 公式沿用 D3（round(finalCorrect=true ÷ 全部题数 × 100)，
 *   reference_self 行 finalCorrect 恒 null——计分母不计分子，教师权威线）；
 * - 空卷防御性保持 submitted/null（finalScoreOf 同款）。
 */
export function attemptFinalOutcomeOf(
  rows: readonly FinalOutcomeRow[],
  opts: { finalized?: boolean } = {},
): {
  status: "submitted" | "graded";
  scoreFinal: number | null;
} {
  if (rows.length === 0) return finalScoreOf([]);
  if (rows.some((row) => row.gradingPolicy === null)) {
    return finalScoreOf(rows.map((row) => row.finalCorrect));
  }
  // P1 修复（审查 TT-09a）：整卷收尾即全部判分行已提交——与四态 gate
  // （practiceQuestionFeedbackStateOf 的 `row.submittedAt !== null || finalized`）
  // 同一口径。legacy 协议行不写行级 submittedAt（responses.submittedAt 是逐题
  // 提交列，协议分野保持），不归一则 legacy+开关开启卷整卷交卷恒 submitted/
  // scoreFinal=null，教师批改重算同病。finalized 由调用方声明收尾事实：
  // 交卷链路交卷即收尾、自动收尾正在收尾、markResponse 只对已收尾卷重算
  const allSubmitted =
    opts.finalized === true || rows.every((row) => row.submittedAt !== null);
  const teacherPending = rows.some(
    (row) => row.gradingPolicy === "manual_only" && row.teacherMark === null,
  );
  if (!allSubmitted || teacherPending) {
    return { status: "submitted", scoreFinal: null };
  }
  const correct = rows.filter((row) => row.finalCorrect === true).length;
  return {
    status: "graded",
    scoreFinal: Math.round((correct / rows.length) * 100),
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
 * - **逐题语义卷的整卷收尾（2026-10 讲练一体决策 5 + M2 新协议普通卷）**：
 *   已单题提交的行（responses.submittedAt 非空——lesson 单题提交与 M2 新协议
 *   逐题提交会写该列）**不重判、不覆盖材料、保 finalCorrect/teacherMark/
 *   submittedAt**（当题判定与证据已在该题提交事务落定，教师课中批改的
 *   teacherMark 也保留，M2 §10.1 末行）；仅对未提交行执行上述既有判分
 *   （未答按 D1 判 false），并把这些行的 submittedAt 写为交卷时刻。历史卷
 *   （无工作流版本）行的 submittedAt 恒 null → 走全量判分，行为零变化；
 * - **finalCorrect = autoCorrect（D3 持久化口径，T3.2a）**：交卷时 teacherMark
 *   必空，逐题同时写 finalCorrect——待批题 ≡ finalCorrect IS NULL（D4 共享谓词）；
 *   lesson 已提交行按行内当前 finalCorrect 参与整卷状态/得分计算；
 * - 写入方式：**原行更新**（行在建卷/懒冻结时已存在；行 id 不变 = 对外下发的
 *   questionRevisionId 稳定）；questionVersion/questionSnapshotJson 保持冻结值；
 *   hintsUsed/hintsOpenedJson/inkId/teacherMark/teacherComment 不在交卷时改写；
 * - activeSec：T2.10 起按 events 表事件序列计算（computePerQuestionActiveSec，
 *   不信任客户端汇总值，§5.5）；无事件的题保持 NULL；
 * - changeCount：T2.10 口径 = max(草稿期 PUT 计数, answer_change 事件数)——
 *   事件计数为权威（每次有效修改一条），草稿计数兜底（无前端事件的 attempt，
 *   如脚本直接调 API 交卷）；
 * - T6R.3 版本验证：clientRevisions 提供时（HTTP 路由恒传，不带请求体按空
 *   集合）与**全部冻结题**（含 lesson 已单题提交的行——旧标签页的整卷提交
 *   仍须回传完整版本集合）精确比对，不符 409 QUESTION_REVISION_STALE；
 *   服务层内部调用（seed 等）可省略参数跳过验证；
 * - T6R.10 笔记证据：验证范围 = 参与本次判分的行（逐题语义卷：未提交题——已提交
 *   题证据已单题冻结不重做）；写入与判分同事务；
 * - attempt.status/scoreAuto/scoreFinal 按 D2/D3：全部 finalCorrect 非 null →
 *   直接 graded 并写 scoreFinal（=scoreAuto，此时分母相同）；否则 submitted、
 *   scoreFinal=null（待批批改后由 T3.2b 重算）；submittedAt、activeSec 总用时
 *   （各题之和；无任何事件时保持 NULL）；
 * - 返回结果视图（含答案与详解，AGENTS 第 3 条的「未交卷」限制就此解除；
 *   T2A.8 例外：answerRelease='after_due' 且交卷瞬间未到截止时，响应同样是
 *   受限形态——只下发本人答案，截止后恢复完整）。lesson 来源恒 on_submit
 *   题级释放，结果视图完整形态（当题粒度已在讲练开卷投影承载）。
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
  // 逐题提交语义的卷（2026-10 lesson 独立适配 + M2 新协议普通卷）：已单题提交
  // 的行不重判（见函数头注释）；判定走 practiceProtocolOf 单一谓词（异常行
  // version=1 而 feedbackMode 缺失时也按历史卷全量判分，与四个逐题消费点
  // 口径一致）；历史卷行的 submittedAt 恒 null → 全量判分，行为零变化
  const perQuestionAttempt = practiceProtocolOf(attempt) !== "legacy";

  // T2.10：每题有效用时与改答案次数（服务端按事件序列计算，§5.5）
  const timeline = attemptTimeline(db, attemptId);
  const activeSecByQuestion = computePerQuestionActiveSec(timeline);
  const eventChangeCountByQuestion = countAnswerChanges(timeline);

  const nowIso = new Date(now).toISOString();
  // allFrozen：全部冻结题（revisions 全集校验与整卷得分汇总的输入）；
  // graded：本次要判分写入的行（逐题语义卷剔除已单题提交者）
  const allFrozen: GradedResponse[] = [];
  const graded: GradedResponse[] = [];
  const keptRows: ResponseRow[] = [];
  // QM-10 细项7：收尾判定的行级输入（§5.5.5——kept 行按行内事实、本次判分
  // 行 finalCorrect=autoCorrect 且逐题语义卷提交时刻=交卷时刻）
  const outcomeRows: FinalOutcomeRow[] = [];
  for (const ownRow of ownRows) {
    const snapshot = snapshotOfRow(ownRow);
    if (snapshot === null) continue; // 历史题目缺失/坏快照按缺失计（不回填、不判分）
    // answerOf 收敛为 null 语义后按 undefined 归一（判分/序列化的未作答口径）
    const answer = answerOf(ownRow.answerJson) ?? undefined;
    if (perQuestionAttempt && ownRow.submittedAt !== null) {
      // 已单题提交：保行内判定（教师课中可能已批 teacherMark → finalCorrect），
      // 不重判不重写；快照与答案随行透传给结果视图与汇总
      keptRows.push(ownRow);
      allFrozen.push({
        response: ownRow,
        question: snapshot,
        answer,
        autoCorrect: ownRow.autoCorrect,
      });
      outcomeRows.push({
        gradingPolicy: ownRow.gradingPolicy,
        submittedAt: ownRow.submittedAt,
        teacherMark: ownRow.teacherMark,
        finalCorrect: ownRow.finalCorrect,
      });
      continue;
    }
    const entry: GradedResponse = {
      response: ownRow,
      question: snapshot,
      answer,
      // QM-10 细项1：行级判分走 gradeResponseRow（§5.6 D11——新策略行不自动
      // 匹配，旧行按题型旧语义；判分输入仍是冻结快照，服务端权威判分不变）
      autoCorrect: gradeResponseRow(ownRow.gradingPolicy, snapshot, answer),
    };
    allFrozen.push(entry);
    graded.push(entry);
    outcomeRows.push({
      gradingPolicy: ownRow.gradingPolicy,
      // 逐题语义卷的本次判分行提交时刻 = 交卷时刻（rowSubmittedAtPatch 同款
      // 内存镜像口径；历史卷行保持 null——旧行旧口径不消费该键）
      submittedAt: perQuestionAttempt ? nowIso : null,
      teacherMark: ownRow.teacherMark,
      finalCorrect: entry.autoCorrect,
    });
  }

  // revisions 全集校验不变：比对对象是**全部冻结题**（lesson 含已提交行）
  if (clientRevisions !== undefined) {
    validateSubmitRevisions(allFrozen, clientRevisions);
  }
  // T6R.10：笔记证据声明验证（纯读、先于事务；写入与判分同事务）——
  // 范围 = 参与本次判分的行（逐题语义卷：未提交题）；任一项验证失败零落行，
  // attempt 保持 draft 可恢复
  const evidenceRows = buildSubmissionEvidence(
    db,
    attemptId,
    graded,
    evidenceDeclarations,
  );

  const scoreAuto = scoreAutoOf(allFrozen);
  // D3：本次判分行 finalCorrect = autoCorrect（teacherMark 必空）；lesson 已
  // 提交行按行内当前 finalCorrect（教师批改优先）。QM-10 细项7：status/
  // scoreFinal 走 attemptFinalOutcomeOf（§5.5.5 新行口径放宽 / 旧行旧口径
  // 单一出处——与自动收尾、教师批改重算同源，不复制公式）；整卷交卷即收尾
  //（finalized 对齐四态 gate——legacy 协议行不写行级 submittedAt，审查 P1）
  const { status: finalStatus, scoreFinal } = attemptFinalOutcomeOf(
    outcomeRows,
    { finalized: true },
  );
  // 逐题语义卷收尾把「本次交卷的行」提交时刻记为交卷时刻（responses.submittedAt
  // 列注释口径）；历史卷行不写该列（保持 null，行为零变化）。事务内 update 与
  // 下方内存镜像展开同一对象，两处口径永不漂移
  const rowSubmittedAtPatch = perQuestionAttempt ? { submittedAt: nowIso } : {};
  db.transaction((tx) => {
    for (const g of graded) {
      tx.update(responses)
        .set({
          answerJson: g.answer !== null ? JSON.stringify(g.answer) : null,
          autoCorrect: g.autoCorrect,
          // D3：交卷同时写 finalCorrect = autoCorrect（teacherMark 必空）
          finalCorrect: g.autoCorrect,
          ...rowSubmittedAtPatch,
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
    touchAttemptActivity(tx, attemptId, nowIso);
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
  // 视图免二次查询/parse，且拿到的是判分后的新值——预载原始行会带旧判定）。
  // lesson 已提交行原样随行（判定/提交时刻保留，不构造镜像）
  const updatedRows = [
    ...keptRows,
    ...graded.map((g) => ({
      ...g.response,
      answerJson: g.answer !== undefined ? JSON.stringify(g.answer) : null,
      autoCorrect: g.autoCorrect,
      finalCorrect: g.autoCorrect,
      ...rowSubmittedAtPatch,
      activeSec: activeSecByQuestion[g.response.questionId] ?? null,
      changeCount: Math.max(
        g.response.changeCount,
        eventChangeCountByQuestion[g.response.questionId] ?? 0,
      ),
    })),
  ];
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
    new Map(allFrozen.map((g) => [g.response.questionId, g.question] as const)),
    updatedRows,
  );
}

// ---------- POST /api/student/attempts/:id/questions/:questionId/submit（2026-10） ----------

/**
 * attempt 级得分汇总的读侧现算（QM-10 / TT-09a：自评响应的 summary 消费；
 * 结果视图的完整汇总仍走 buildResultData 的公布感知投影——本函数只服务
 * 「已过公布 gate」的回执场景，不做受限形态投影）：
 * - QM-12（TT-09c）起 correct/wrong/pending 为**有效判定口径**（教师判 >
 *   自评 > 自动——自评对/错计入，未自评 reference_self 行计 pending），
 *   与结果视图 scoreSummaryOf、讲练 lessonLiveSummaryOf 同一核心；
 * - scoreFinal 读 attempt 行（自评不推动 graded/scoreFinal——教师权威线）；
 * - pendingCount 是 D4 教师待批计数（排除 reference_self 行；快照缺失的历史
 *   行跳过——与判分/视图口径一致）。
 */
export function attemptScoreSummaryOf(
  db: Db,
  attempt: Pick<Attempt, "id" | "status"> & { scoreFinal: number | null },
): AttemptScoreSummary {
  // P3-1（TT-09a 审查遗留，本单定夺=对齐）：与 lessonLiveSummaryOf 共用同一
  // 计数核心（scoreSummaryCoreOf）。非 draft 卷按已收尾口径整卷计数（行为与
  // 旧实现一致）；draft 卷（lesson / v1 逐题进行中）只计已单题提交的行——
  // 修复前该函数整卷计数，与讲练开卷投影/单题提交响应的 lessonLive 口径
  // 漂移（草稿答案也计入 answered、未提交行计入 pending）。
  const rows = db
    .select({
      hasSnapshot:
        sql<boolean>`${responses.questionSnapshotJson} IS NOT NULL`.mapWith(
          Boolean,
        ),
      answerJson: responses.answerJson,
      submittedAt: responses.submittedAt,
      autoCorrect: responses.autoCorrect,
      finalCorrect: responses.finalCorrect,
      gradingPolicy: responses.gradingPolicy,
      teacherMark: responses.teacherMark,
      selfReviewVerdict: responses.selfReviewVerdict,
      selfReviewAt: responses.selfReviewAt,
      selfReviewRevision: responses.selfReviewRevision,
    })
    .from(responses)
    .where(eq(responses.attemptId, attempt.id))
    .all();
  return {
    ...scoreSummaryCoreOf(rows, {
      finalized: attempt.status !== "draft",
    }),
    scoreFinal: attempt.scoreFinal,
  };
}

/**
 * 得分汇总的统一计数核心（QM-12 / TT-09c，P3-1 对齐的落点）：correct/wrong/
 * pending 为**有效判定口径**（教师判 > 自评 > 自动，effectiveVerdictOfRow
 * 单一出处）；pendingCount 恒 D4 教师待批（finalCorrect IS NULL 且非
 * reference_self 行——与 pending-mark.ts 谓词同口径，快照空行已由 hasSnapshot
 * 排除）。attemptScoreSummaryOf（自评回执）与 lessonLiveSummaryOf（讲练开卷
 * 投影/单题提交响应）共用本核心，两函数只差行集来源：
 * - finalized=false（进行中卷）：仅**已提交行**（responses.submittedAt 非空）
 *   计入对错与 answered，未提交行只进 total/unanswered——「提交瞬间看到部分
 *   汇总、刷新 start 又变」两者永不漂移；
 * - finalized=true（已收尾卷）：整卷口径（legacy 协议行不写行级 submittedAt，
 *   与 attemptFinalOutcomeOf 的 finalized 归一同口径）。
 * 快照缺失的历史行跳过（与判分/视图口径一致）。
 */

/** 汇总核心的判定输入行（M2 起快照列降为存在性布尔——汇总判定只需要
 *  「快照非空」与判定计数，不再搬运每题数 KB 的快照原文；单题提交事务带出
 *  的行集即此形态，开卷链路用完整行按此映射） */
export interface ScoreSummaryRow {
  hasSnapshot: boolean;
  answerJson: string | null;
  submittedAt: string | null;
  autoCorrect: boolean | null;
  finalCorrect: boolean | null;
  /** QM-10：pendingCount 排除 reference_self 行（教师必批谓词同口径） */
  gradingPolicy: GradingPolicy | null;
  teacherMark: string | null;
  /** QM-12：有效判定需要自评记录（teacherMark 与 autoCorrect 均空时回落） */
  selfReviewVerdict: "correct" | "wrong" | null;
  selfReviewAt: string | null;
  selfReviewRevision: number;
}

export function scoreSummaryCoreOf(
  rows: readonly ScoreSummaryRow[],
  opts: { finalized: boolean },
): Omit<AttemptScoreSummary, "scoreFinal"> {
  let total = 0;
  let answered = 0;
  let correct = 0;
  let wrong = 0;
  let pending = 0;
  let pendingCount = 0;
  for (const row of rows) {
    if (!row.hasSnapshot) continue;
    total += 1;
    if (row.submittedAt === null && !opts.finalized) continue;
    if (answerOf(row.answerJson) !== null) answered += 1;
    const effective = effectiveVerdictOfRow(row);
    if (effective === null) pending += 1;
    else if (effective.value) correct += 1;
    else wrong += 1;
    // D4 教师待批：finalCorrect IS NULL 且非 reference_self 行（pending-mark.ts
    // 谓词同口径；null 策略旧行不受影响）
    if (row.finalCorrect === null && row.gradingPolicy !== "reference_self") {
      pendingCount += 1;
    }
  }
  return {
    total,
    answered,
    correct,
    wrong,
    pending,
    unanswered: total - answered,
    autoGradable: correct + wrong,
    pendingCount,
  };
}

/**
 * lesson 卷的读侧现算汇总（2026-10 讲练一体；lesson-service 开卷投影与
 * submitLessonQuestion 响应共用同一口径，单一出处；QM-12 起计数核心与
 * attemptScoreSummaryOf 统一为 scoreSummaryCoreOf——P3-1 口径并存的兜底
 * 定夺即「对齐到同一核心」）。进行中卷恒 finalized=false（调用方只在
 * draft 卷消费本函数；已收尾卷的结果视图走 buildResultData）。
 */
export function lessonLiveSummaryOf(
  rows: readonly ScoreSummaryRow[],
  attempt: Pick<Attempt, "scoreFinal">,
): AttemptScoreSummary {
  return {
    ...scoreSummaryCoreOf(rows, { finalized: false }),
    scoreFinal: attempt.scoreFinal,
  };
}

/** 该题已单题提交的统一拒绝（2026-10；与整卷重复交卷 ALREADY_SUBMITTED 分码） */
function questionAlreadySubmitted(): HttpError {
  return new HttpError(
    409,
    "QUESTION_ALREADY_SUBMITTED",
    "这道题已经提交过了，不能重复提交",
  );
}

/** 该题不在本卷冻结集合（或快照损坏）的统一 404（M2 起提交/反馈多端点共用） */
export function questionNotFound(): HttpError {
  return new HttpError(404, "QUESTION_NOT_FOUND", "题目不存在或不属于这次练习");
}

/**
 * 单题提交链路共用的整卷自动收尾（2026-10 lesson 与 M2 新协议逐题提交同一
 * 实现，从 submitLessonQuestion 收尾块抽取——计划 §10.2 第 6 步「最后一题
 * 调用共同收尾函数，避免重复公式与双写统计」）：事务内重读全部冻结行（瘦列
 * 投影，不含每题数 KB 的快照原文），全部已提交才收尾——scoreAuto/scoreFinal/
 * status 与整卷交卷同口径复用 scoreAutoOf / finalScoreOf；收尾 UPDATE 带
 * WHERE status='draft' 真实 CAS，逐题与整卷并发收尾只成功一次（后到者 no-op，
 * 行集照常返回）。返回瘦行集供 lesson 现算 summary / 题级进度消费，并带回
 * 收尾后的 attempt 新行（no-op 时 null——调用方回落事务内已读行，同步单
 * 连接下两者等价，省一次收尾后重读）。
 */
function autoFinishPerQuestionAttempt(
  tx: Tx,
  attemptId: string,
  nowIso: string,
): { rows: ScoreSummaryRow[]; attempt: Attempt | null } {
  const rowsAfter = tx
    .select({
      // 快照原文不搬运（每题数 KB，收尾判定只需要存在性）
      // mapWith(Boolean)：better-sqlite3 对该表达式返回 0/1 整数，归一为真
      // 布尔——严格比较（仓库布尔列惯例）与真值判断都安全
      hasSnapshot:
        sql<boolean>`${responses.questionSnapshotJson} IS NOT NULL`.mapWith(
          Boolean,
        ),
      answerJson: responses.answerJson,
      submittedAt: responses.submittedAt,
      autoCorrect: responses.autoCorrect,
      finalCorrect: responses.finalCorrect,
      // QM-10 细项7：收尾判定与 lesson 汇总的 pendingCount 需要（§5.5.5）
      gradingPolicy: responses.gradingPolicy,
      teacherMark: responses.teacherMark,
      // QM-12：汇总核心的有效判定需要自评记录（reference_self 行回落）
      selfReviewVerdict: responses.selfReviewVerdict,
      selfReviewAt: responses.selfReviewAt,
      selfReviewRevision: responses.selfReviewRevision,
    })
    .from(responses)
    .where(eq(responses.attemptId, attemptId))
    .all();
  const gradable = rowsAfter.filter((r) => r.hasSnapshot);
  if (gradable.every((r) => r.submittedAt !== null)) {
    // 正在收尾 → finalized（与上方 gate 同刻事实，口径见 attemptFinalOutcomeOf）
    const { status, scoreFinal } = attemptFinalOutcomeOf(gradable, {
      finalized: true,
    });
    const attempt = tx
      .update(attempts)
      .set({
        status,
        submittedAt: nowIso,
        scoreAuto: scoreAutoOf(gradable),
        scoreFinal,
      })
      .where(and(eq(attempts.id, attemptId), eq(attempts.status, "draft")))
      .returning()
      .get();
    return { rows: rowsAfter, attempt: attempt ?? null };
  }
  return { rows: rowsAfter, attempt: null };
}

/**
 * 单题提交（2026-10 讲练一体，方案「作答服务」节 + 决策 3——既有交卷管线的
 * 单题化）：lesson 来源 draft 卷的逐题即时反馈，单事务完成
 * 「CAS 校验 → 判分 → 冻结证据 → （最后一题）自动收尾」。
 *
 * - 归属与状态：requireUsableAttempt（404/403；lesson 永不失权——无课程分态
 *   重校验）；非 lesson 来源 → 404 NOT_FOUND（单题提交是讲练专属入口，其余
 *   来源仍走整卷交卷）；已离开 draft → 409 ALREADY_SUBMITTED；
 * - 题目与版本：该题冻结行（严格口径：快照非空，缺失 → 404
 *   QUESTION_NOT_FOUND）；questionRevisionId 与行 id 精确比对（错版 409
 *   QUESTION_REVISION_STALE，与整卷同口径）；行内 submittedAt 已非空 →
 *   409 QUESTION_ALREADY_SUBMITTED（幂等拒绝，前端据此锁定题卡）；
 * - 判分：草稿答案已在行内（无 = 未作答提交，按 D1 客观题判 false）；
 *   grade(snapshot, answer)（@tutor/grading 复用，不复制判分逻辑）写
 *   autoCorrect 与 finalCorrect（不可自动判 → 两者留 null 进教师待批——
 *   D4 谓词按「卷非 draft 或行已提交」收录，见 pending-mark.ts）；行内
 *   teacherMark 必空（draft 卷不可批注），finalCorrect = autoCorrect；
 * - submittedAt = now（该行的提交时刻）；hints/ink/answerJson/changeCount
 *   等其余列不动；
 * - 笔记证据（T6R.10 单题化）：req.evidence 经 buildSingleQuestionEvidence
 *   验证（frozen CAS / none / missing / 缺省旧客户端），通过则同事务写
 *   submission_evidence（(attempt, question) 唯一——每题至多一条，整卷收尾
 *   不再为已提交题补写）；
 * - **自动收尾（最后一题，方案决策 5）**：事务内重读全部冻结行（快照非空），
 *   若全部 submittedAt 非空 → attempt 置 submitted/graded（finalScoreOf，
 *   有待批 = submitted、全判完 = graded）并写 scoreAuto（scoreAutoOf）/
 *   scoreFinal——与整卷交卷同口径复用计算函数；并发双收尾（整卷与本接口
 *   同刻）由「事务内复核 attempt 仍 draft + 行仍 null」保证后到者 409 幂等
 *   （better-sqlite3 同步事务天然串行）；
 * - 成功后直记 question_submit 事件（payload 仅 questionId；拒绝路径不记）；
 * - 响应（lessonQuestionSubmitData）：**只含该题**的 result 投影（提交即释放
 *   参考答案/详解/判定——stemMd 经 studentStemMd 学生端投影）+ 现算 summary
 *   （lessonLiveSummaryOf）+ attempt 摘要（自动收尾后为新状态）；其他未提交
 *   题的答案/详解/提示内容绝不出现（泄露矩阵见 routes/student-lesson.test.ts）。
 *
 * now 可注入（测试；默认当前时刻，行 submittedAt 亦取该时刻）。
 */
export function submitLessonQuestion(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  req: LessonQuestionSubmitRequest,
  now: Date | string = new Date(),
): LessonQuestionSubmitData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (attempt.sourceType !== "lesson") {
    // M2 协议分流（2026-10-22 计划 §5.3/§10.1）：新协议普通卷收到旧协议形态
    // → 拒绝并提示刷新，不退回整卷无版本写入；历史卷维持 404（讲练专属入口，
    // 不暴露差异）
    if (practiceProtocolOf(attempt) === "v1") {
      throw new HttpError(
        409,
        "WORKFLOW_PROTOCOL_MISMATCH",
        "这份练习需要新版做题流程，请刷新页面后重试",
      );
    }
    throw new HttpError(404, "NOT_FOUND", "这份练习不是讲练练习，不能逐题提交");
  }
  if (attempt.status !== "draft") {
    throw new HttpError(
      409,
      "ALREADY_SUBMITTED",
      "这份练习已经完成，不能再提交",
    );
  }

  // 冻结行（严格口径：快照非空）——行 id 即对外下发的 questionRevisionId
  const row = db
    .select()
    .from(responses)
    .where(buildAttemptQuestionWhere(attemptId, questionId))
    .get();
  if (row === undefined) {
    throw questionNotFound();
  }
  if (row.id !== req.questionRevisionId) {
    throw revisionStale();
  }
  if (row.submittedAt !== null) {
    throw questionAlreadySubmitted();
  }
  const snapshot = snapshotOfRow(row);
  if (snapshot === null) {
    // 理论不可达（严格口径已保证快照非空）；防御性兜底不静默
    throw questionNotFound();
  }
  // 草稿答案已在行内（无 = 未作答提交，grade 按 D1 客观题判 false）。
  // QM-10 细项1：行级判分走 gradeResponseRow——lesson 新冻结行同样不自动匹配
  const answer = answerOf(row.answerJson) ?? undefined;
  const autoCorrect = gradeResponseRow(row.gradingPolicy, snapshot, answer);

  // 笔记证据（单题化）：验证纯读、先于事务；写入与判分同事务
  const evidenceRow = buildSingleQuestionEvidence(
    db,
    attemptId,
    questionId,
    req.evidence,
  );

  const nowIso = new Date(now).toISOString();
  // 单事务先复核后写：better-sqlite3 同步单进程，复核防御与写入原子同界。
  // 闭包带出收尾判定的瘦行集（不含快照原文列）——事务后 summary 直接消费，
  // 热路径不再整卷全列回读（每题数 KB 的 questionSnapshotJson）
  const summaryRows = db.transaction((tx) => {
    const freshAttempt = tx
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    const freshRow = tx
      .select()
      .from(responses)
      .where(eq(responses.id, row.id))
      .get();
    if (
      freshAttempt === undefined ||
      freshAttempt.sourceType !== "lesson" ||
      freshAttempt.status !== "draft"
    ) {
      // 并发双收尾的后到者：整卷收尾（或另一路收尾）已离开 draft
      throw new HttpError(
        409,
        "ALREADY_SUBMITTED",
        "这份练习已经完成，不能再提交",
      );
    }
    if (freshRow === undefined || freshRow.submittedAt !== null) {
      throw questionAlreadySubmitted();
    }
    tx.update(responses)
      .set({
        autoCorrect,
        // D3：提交时 teacherMark 必空（draft 卷不可批注）→ finalCorrect = autoCorrect
        finalCorrect: autoCorrect,
        submittedAt: nowIso,
      })
      .where(eq(responses.id, row.id))
      .run();
    if (evidenceRow !== null) {
      tx.insert(submissionEvidence)
        .values({
          id: randomUUID(),
          attemptId,
          questionId: evidenceRow.questionId,
          state: evidenceRow.state,
          versionId: evidenceRow.versionId,
          recordedAt: nowIso,
        })
        .run();
    }
    // 自动收尾：全部冻结行都已提交 → 最后一题，共同收尾函数（lesson 与 M2
    // 新协议逐题提交同一实现；返回瘦行集出事务即 lessonLiveSummaryOf 的输入，
    // 与开卷链路同一口径，不复制谓词）
    touchAttemptActivity(tx, attemptId, nowIso);
    return autoFinishPerQuestionAttempt(tx, attemptId, nowIso).rows;
  });

  // 成功后直记 question_submit 事件（payload 仅 questionId，拒绝路径不记）
  recordQuestionSubmitEvent(db, studentId, attemptId, questionId);

  // 响应组装：该题 result 投影（stemMd 经学生端投影）+ 现算 summary + 最新
  // attempt 摘要（自动收尾后为新状态）。提交行按主键取一行（快照复用事务前
  // 已 parse 的同一份）；summary 消费事务带出的瘦行集
  const freshAttempt = db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .get();
  const freshRow = db
    .select()
    .from(responses)
    .where(eq(responses.id, row.id))
    .get();
  if (freshAttempt === undefined || freshRow === undefined) {
    // 理论不可达（事务刚写完）；防御性兜底不让接口 500 无信息
    throw new HttpError(500, "INTERNAL", "提交失败，请刷新页面后重试");
  }
  return {
    question: studentFacingResultOf(
      resultQuestionOf(freshRow, snapshot, {
        materialSlots: materialSlotOrderOf(db, attemptId),
      }),
    ),
    summary: lessonLiveSummaryOf(summaryRows, freshAttempt),
    attempt: attemptSummaryOf(freshAttempt),
  };
}

// ---------- POST /api/student/attempts/:id/questions/:questionId/submit（M2 新协议普通逐题，2026-10-22 计划 §5.3/§10.1–§10.4） ----------

/**
 * 逐题提交请求摘要（M2 §10.3 幂等配对）：对影响判分与证据固定的请求字段做
 * 确定性拼接后 sha256——同 mutationId 重试必须携带同一摘要；任何字段变化都是
 * 不同请求（409，不能复用幂等键覆盖提交）。submissionMutationId 本身是配对
 * 键不进摘要；workflowVersion 恒 1（协议门禁，不是请求身份）。
 */
function practiceRequestDigestOf(
  attemptId: string,
  questionId: string,
  req: PracticeQuestionSubmitRequest,
): string {
  const evidence = `${req.evidence.state}\u0001${req.evidence.versionId ?? ""}\u0001${req.evidence.revision ?? ""}\u0001${req.evidence.questionId}`;
  return createHash("sha256")
    .update(
      [
        "practice-submit-v1",
        attemptId,
        questionId,
        String(req.workflowRevision),
        req.questionRevisionId,
        String(req.expectedAnswerRevision),
        evidence,
      ].join("\u0000"),
    )
    .digest("hex");
}

/**
 * M2 新协议逐题提交（submitAttemptQuestion 的普通练习实现；lesson 走上方
 * submitLessonQuestion 独立适配）。单事务完成 §10.2 必要顺序：
 * 归属（404/403 不暴露差异——按 studentId 复核）→ 作废 409 → 课程失权
 * （requireVisibleCourseUnit 分态 403/404，与取卷同口径）→ 协议形态（lesson /
 * 历史卷 409，不退回无版本写入 §5.3）→ **幂等与已提交裁决**（§10.3：同
 * mutationId 同摘要重试返回同一提交事实、不重判不重复事件；同 id 异摘要 409
 * WORKFLOW_MUTATION_CONFLICT；异 mutationId 含整卷已收尾 → 409
 * QUESTION_ALREADY_SUBMITTED）→ 当前 resolver 裁决（教师收紧立即生效，§5.4
 * ——canSubmitQuestion=false 拒绝进一步逐题提交 409 WORKFLOW_RESTRICTED，
 * 但幂等重放先于它：收紧后重试按当前规则投影）→ workflowRevision CAS（陈旧
 * 409，工作流改动与首题提交竞态）→ questionRevisionId 版本（409，与整卷/
 * lesson 同口径）→ **expectedAnswerRevision 与事务内实际读取的学生答案版本
 * 比对**（§10.2 末段：不是题目版本；不一致 409 ANSWER_REVISION_CONFLICT 附
 * _current，复用既有答案冲突协议）→ 证据声明核对（frozen/none/missing——
 * buildSingleQuestionEvidence 与 lesson 同一实现，questionId 一致性、有稿
 * none 拒绝；本机读取失败在客户端阻断，服务端只核对声明与既有证据事实的一致
 * 性）→ 判分（**事务内**读冻结快照与答案，grade 复用判分包——M0 风险 1 的
 * 「事务前读答案」窗口就此关闭）→ 行级真实 CAS 写入（WHERE submittedAt IS
 * NULL，已提交行不可覆盖）→ 最后一题调用共同收尾函数
 * （autoFinishPerQuestionAttempt，与 lesson 同源；并发下整卷只收尾一次）。
 *
 * 响应（practiceQuestionSubmitData 四键白名单，§6.1——不夹带邻题对错与整卷
 * 汇总）：feedback 共用授权投影 + questionProgress 白名单 + 最新 attempt 摘要
 * + 工作流裁决投影，全部在事务后按**读取时刻**的当前规则组装（教师在该题
 * 事务提交后、响应投影前收紧的竞态下按当前 gate 返回受限态，不重放缓存旧
 * 正文，§10.3）。成功路径记 question_submit 事件（重放不重复记）。
 */
export function submitPracticeQuestion(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  req: PracticeQuestionSubmitRequest,
  now: Date | string = new Date(),
): PracticeQuestionSubmitData {
  const nowIso = new Date(now).toISOString();
  const digest = practiceRequestDigestOf(attemptId, questionId, req);
  const outcome = db.transaction((tx) => {
    // 归属（不存在/跨学生统一 404）+ 作废 409：写路径共用前导（与 PATCH
    // workflow 同一实现）
    const attempt = requireOwnActiveAttempt(tx, studentId, attemptId);
    // 课程失权分态校验（403/404），与取卷同口径（同步连接，事务内读一致）
    assertDraftCourseVisible(db, studentId, attempt);
    // 新协议路径仅普通来源的新协议卷：lesson 独立适配（旧协议形态）→ 协议
    // 不匹配；历史卷（无工作流版本）不可升级 → legacy（§5.3）
    const protocol = practiceProtocolOf(attempt);
    if (protocol === "lesson") {
      throw new HttpError(
        409,
        "WORKFLOW_PROTOCOL_MISMATCH",
        "这份作答是讲练练习，请刷新页面后按讲练流程提交",
      );
    }
    if (protocol === "legacy") {
      throw new HttpError(
        409,
        "WORKFLOW_LEGACY",
        "历史作答不支持逐题提交，请整卷交卷",
      );
    }

    const row = tx
      .select()
      .from(responses)
      .where(buildAttemptQuestionWhere(attemptId, questionId))
      .get();
    if (row === undefined) {
      throw questionNotFound();
    }

    // 幂等与已提交裁决（§10.3）——先于一切可变拒绝：结果未知的重试按当前规则
    // 投影返回同一提交事实；异 mutationId（含整卷已收尾）→ 可诊断已提交
    if (row.submittedAt !== null) {
      if (row.practiceMutationId === req.submissionMutationId) {
        if (row.practiceRequestDigest !== digest) {
          throw new HttpError(
            409,
            "WORKFLOW_MUTATION_CONFLICT",
            "同一提交标识的请求内容不一致，请刷新页面后重试",
          );
        }
        return { replayed: true as const, row, attempt };
      }
      throw questionAlreadySubmitted();
    }
    if (attempt.status !== "draft") {
      throw new HttpError(
        409,
        "ALREADY_SUBMITTED",
        "这份练习已经完成，不能再提交",
      );
    }

    // 当前 resolver 裁决：教师收紧立即生效（§5.4），收紧后拒绝进一步逐题提交
    //（学生按「继续完成剩余题目并交卷」收敛；已提交行与成绩保留）
    const view = attemptWorkflowView(db, attempt, now);
    if (view === null) {
      // M1 加固语义（v2 d7c84b89）：读侧视图缺失＝授权事实异常（如作业授权
      // 行悬挂按「缺失=旧协议」降级）——按旧协议 409 拒绝，不把异常数据打成 500
      throw new HttpError(
        409,
        "WORKFLOW_LEGACY",
        "这份作答的工作流数据异常，按旧协议处理",
      );
    }
    if (!view.practiceWorkflow.canSubmitQuestion) {
      throw new HttpError(
        409,
        "WORKFLOW_RESTRICTED",
        "当前规则不允许逐题提交，请继续完成剩余题目并交卷",
      );
    }

    // 工作流 CAS：节奏修改与首题提交的竞态拒绝陈旧请求（§10.3 末条；任一
    // 提交后节奏冻结，比对恒命中）
    if (attempt.workflowRevision !== req.workflowRevision) {
      throw new HttpError(
        409,
        "WORKFLOW_REVISION_STALE",
        "做题设置已在其他设备修改，请刷新后重试",
      );
    }
    // 题目版本（与整卷/lesson 同口径）
    if (row.id !== req.questionRevisionId) {
      throw revisionStale();
    }
    // 学生答案版本（§10.2 末段：不是题目版本——他端又存了一版答案即拒绝，
    // 复用既有答案冲突协议与 _current 形态）
    if (row.answerRevision !== req.expectedAnswerRevision) {
      throw new HttpError(
        409,
        "ANSWER_REVISION_CONFLICT",
        "本题答案已在其他设备更新，请刷新后查看最新答案再提交",
        {
          _current: attemptAnswerConflictCurrentSchema.parse({
            revision: row.answerRevision,
            draft: answerOf(row.answerJson),
          }),
        },
      );
    }

    // 判分输入在事务内读取（M0 风险 1 窗口关闭）：冻结快照 + 行内草稿答案
    const snapshot = snapshotOfRow(row);
    if (snapshot === null) {
      throw questionNotFound();
    }
    const answer = answerOf(row.answerJson) ?? undefined;
    // QM-10 细项1：行级判分走 gradeResponseRow（新策略行不自动匹配）
    const autoCorrect = gradeResponseRow(row.gradingPolicy, snapshot, answer);

    // 证据声明核对（frozen/none/missing，与 lesson 单题提交同一实现）
    const evidenceRow = buildSingleQuestionEvidence(
      db,
      attemptId,
      questionId,
      req.evidence,
    );

    // 行级真实 CAS：已提交行不可覆盖（UPDATE 带 WHERE submittedAt IS NULL）
    const written = tx
      .update(responses)
      .set({
        autoCorrect,
        // 提交时 teacherMark 必空（draft 卷不可批注）→ finalCorrect = autoCorrect
        finalCorrect: autoCorrect,
        submittedAt: nowIso,
        practiceMutationId: req.submissionMutationId,
        practiceRequestDigest: digest,
      })
      .where(and(eq(responses.id, row.id), isNull(responses.submittedAt)))
      .returning()
      .get();
    if (written === undefined) {
      // 事务内复核已拦截同进程并发；防御多进程竞态的后到者按已提交语义收敛
      throw questionAlreadySubmitted();
    }
    if (evidenceRow !== null) {
      tx.insert(submissionEvidence)
        .values({
          id: randomUUID(),
          attemptId,
          questionId: evidenceRow.questionId,
          state: evidenceRow.state,
          versionId: evidenceRow.versionId,
          recordedAt: nowIso,
        })
        .run();
    }
    // 最后一题：共同收尾函数（与 lesson 同一实现；并发下整卷只收尾一次）。
    // 收尾 RETURNING 带回顾卷新行；no-op（他方已收尾）时回落事务内已读行
    //（同步单连接下与事务后重读恒等）
    touchAttemptActivity(tx, attemptId, nowIso);
    const finished = autoFinishPerQuestionAttempt(tx, attemptId, nowIso);
    // 有效提交在事务内记事件（重放分支不会到这——§10.3 不重复写；与提交
    // 原子落库，省一次独立 autocommit 的 fsync，不留「提交已持久、事件丢失」
    // 崩溃窗口。lesson 路径的事件仍在事务外属既有模式）
    recordQuestionSubmitEvent(tx, studentId, attemptId, questionId);
    return {
      replayed: false as const,
      row: written,
      attempt: finished.attempt ?? attempt,
      snapshot,
    };
  });

  // 响应组装：读取时刻投影（§10.3 不重放旧正文）。行与 attempt 直接用事务
  // 产物（同步单连接：事务后重读与事务内已读恒等，省两次整行 SELECT——
  // 含每题数 KB 快照原文的行）；快照只解析一次——非重放路径复用事务内判分
  // 已解析对象（UPDATE 不触快照列，字节恒等），重放路径才惰性解析（仅
  // released 反馈需要整份快照的解析校验）
  const view = attemptWorkflowView(db, outcome.attempt, now);
  if (view === null) {
    // 与事务内 gate 同款降级（异常数据不打 500；提交事实已在库）。注：并发
    // 破坏授权事实触发本 409 时，同 mutationId 重试（重放分支）同样在本段
    // 被拒——该 mutation 的回执需异常数据修复后才能取回；届时整卷读取面已
    // 同步降级 legacy（全库一致口径，非本端点孤例）
    throw new HttpError(
      409,
      "WORKFLOW_LEGACY",
      "这份作答的工作流数据异常，按旧协议处理",
    );
  }
  return {
    feedback: practiceQuestionFeedbackOf(
      db,
      outcome.attempt,
      outcome.row,
      () =>
        "snapshot" in outcome ? outcome.snapshot : snapshotOfRow(outcome.row),
      now,
      view,
    ),
    questionProgress: view.questionProgress,
    attempt: attemptSummaryOf(outcome.attempt),
    practiceWorkflow: view.practiceWorkflow,
  };
}

// ---------- GET /api/student/attempts/:id/questions/:questionId/feedback（M2 题级反馈，2026-10-22 计划 §10.1/§10.4） ----------

/** released 态进行中卷的教师域字段置 null 投影（M2 派单：attempt 未交卷期间
 * teacherMark/teacherComment/finalCorrect 恒 null——公布 gate 截止前/收尾前
 * 不下发教师域判定；库值保留，收尾公布后随行） */
function nullTeacherFieldsOf(
  item: AttemptResultQuestion,
): AttemptResultQuestion {
  return {
    ...item,
    teacherMark: null,
    teacherComment: null,
    finalCorrect: null,
  };
}

/**
 * 单题授权反馈的共用投影（M2 单一实现——提交回执的 feedback 字段与 feedback
 * GET 的 data.feedback 都是它，防两套投影漂移）：按**读取时刻**的当前规则
 * 裁决四态（裁决本体在 practice-workflow-service 的
 * resolvePracticeQuestionFeedbackState——与 wiring 的题级进度
 * feedbackReadable 同一纯函数，防两套公式漂移），不缓存旧投影正文原样重放
 * （§10.3——教师收紧后重试同样受限）：
 * - not_submitted：行未提交（无任何题目秘密，提交事实以 questionProgress
 *   的 submittedAt 为准）；
 * - pending_attempt：本题已提交但公布条件未满足——进行中卷的 after_attempt
 *   节奏（学生自选/教师限定）或已收尾卷的 after_due 截止前（公布 gate 与结果
 *   视图 answersReleased 同口径，读时比较，截止后下一次请求自动恢复）；
 * - restricted：当前教师规则不允许逐题反馈（收紧后已提交题重取同样受限，
 *   §5.4——已下发内容不宣称撤回，后续读取按当前 gate；原因复用 M1 枚举；
 *   读侧工作流投影缺失的异常数据降级为 legacy_attempt fail closed）；
 * - released：已提交且当前授权——question 为整卷结果单题同构
 *   （attemptResultQuestion；stemMd 一律经 studentStemMd 学生端投影，与
 *   lesson 单题提交同一出口）。
 * 快照按需解析（snapshotOf 惰性求值）：只有 released 态需要题目内容，
 * 其余三态不付整份快照的解析校验成本（题级反馈读取是可轮询路径）。
 * view 是调用方已算好的读侧工作流投影（提交回执复用省一次重复投影），
 * 缺省（GET 路径）在进行中卷分支内现算。
 */
export function practiceQuestionFeedbackOf(
  db: Db,
  attempt: Attempt,
  row: ResponseRow,
  snapshotOf: () => Question | null,
  now: Date | string = new Date(),
  view?: AttemptWorkflowView | null,
): PracticeQuestionFeedback {
  const state = practiceQuestionFeedbackStateOf(db, attempt, row, now, view);
  if (state.status !== "released") {
    return state;
  }
  const snapshot = snapshotOf();
  if (snapshot === null) {
    // 已提交行的快照损坏：不静默降级成无秘密态（与未提交读区分）
    throw questionNotFound();
  }
  const question = studentFacingResultOf(
    resultQuestionOf(row, snapshot, {
      materialSlots: materialSlotOrderOf(db, attempt.id),
    }),
  );
  return {
    status: "released",
    // 进行中卷教师域字段恒 null（收尾公布后随行）；已收尾卷按结果视图原样
    question:
      attempt.status === "draft" ? nullTeacherFieldsOf(question) : question,
  };
}

/**
 * 单题反馈四态的门控组装单一出处（M2 收敛点提炼：题级反馈投影
 * practiceQuestionFeedbackOf 与学生自评 gate——self-review-service——共用，
 * release 查询与公式不复制）。普通来源交 resolvePracticeQuestionFeedbackState
 * 纯裁决（同款输入组装）；lesson 独立适配：恒 on_submit 题级释放（提交即
 * 公布，submitLessonQuestion 同源语义），只有未提交/已释放两态——无
 * pending_release/restricted 中间态，不适用普通四态裁决器的进行中分支。
 */
export function practiceQuestionFeedbackStateOf(
  db: Db,
  attempt: Attempt,
  row: Pick<ResponseRow, "submittedAt">,
  now: Date | string = new Date(),
  view?: AttemptWorkflowView | null,
): ReturnType<typeof resolvePracticeQuestionFeedbackState> {
  const finalized = attempt.status !== "draft";
  // 已收尾卷的行按已提交语义进四态（旧行无行级 submittedAt——整卷交卷即
  // 全部判分行已交；行级判别只服务进行中卷。v1/lesson 已收尾行本就带
  // submittedAt，行为不变；QM-10 自评 gate 对历史卷由本口径放行到策略检查）
  const submitted = row.submittedAt !== null || finalized;
  if (attempt.sourceType === "lesson") {
    return submitted ? { status: "released" } : { status: "not_submitted" };
  }
  // 已收尾作业卷的公布事实：assignmentReleaseByIds 含软删（作答记录不随作业
  // 软删消失）；行悬挂（异常数据）Map 无键 → null → 单一公式 fail closed 未
  // 公布，不把读取裸抛成 404（与草稿态 restricted(legacy_attempt)、回执态
  // 409 WORKFLOW_LEGACY 同一降级家族）
  const release =
    finalized && attempt.sourceType === "assignment"
      ? (assignmentReleaseByIds(db, [attempt.assignmentId ?? ""]).get(
          attempt.assignmentId ?? "",
        ) ?? null)
      : null;
  return resolvePracticeQuestionFeedbackState({
    submitted,
    attemptSubmitted: finalized,
    published: attemptAnswersPublished(
      { attemptSubmitted: finalized, sourceType: attempt.sourceType, release },
      now,
    ),
    workflow: finalized
      ? null
      : ((view ?? attemptWorkflowView(db, attempt, now))?.practiceWorkflow ??
        null),
  });
}

/**
 * M2 题级反馈读取（GET /attempts/:id/questions/:questionId/feedback）：
 * 归属/作废/课程失权（requireUsableAttempt，与取卷同口径）+ 协议形态（lesson
 * 当题释放走 lesson/start 投影、历史卷走整卷结果视图——都不在本端点复制第二
 * 份，409 WORKFLOW_LEGACY）+ 题目属冻结集合（404）。四态按读取时刻裁决
 * （practiceQuestionFeedbackOf），未授权形态零题目秘密。
 */
export function getPracticeQuestionFeedback(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  now: Date | string = new Date(),
): PracticeQuestionFeedbackData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (practiceProtocolOf(attempt) !== "v1") {
    throw new HttpError(
      409,
      "WORKFLOW_LEGACY",
      "这份作答不支持题级反馈读取（旧协议或讲练作答）",
    );
  }
  const row = db
    .select()
    .from(responses)
    .where(buildAttemptQuestionWhere(attemptId, questionId))
    .get();
  if (row === undefined) {
    throw questionNotFound();
  }
  // 快照惰性解析（仅 released 态反馈需要题目内容，未授权态不付解析成本；
  // 已提交行快照损坏时由投影层按 404 拒绝，不静默降级）
  return {
    feedback: practiceQuestionFeedbackOf(
      db,
      attempt,
      row,
      () => snapshotOfRow(row),
      now,
    ),
  };
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
  const draftRevisions: Record<string, number> = {};
  const hintsOpened: Record<string, HintOpenedEntry[]> = {};
  // 单一数据源：行只查一次、快照只 parse 一次——公开投影/草稿答案/提示回显
  // 在同一批行上派生（groupedSnapshotRows 统一「跳过缺失+组 id 回退+空组过滤」）
  // QM-13：matching 槽位集合按冻结材料槽位序展开（一次取全卷共用）
  const materialSlots = materialSlotOrderOf(db, attempt.id);
  const units = groupedSnapshotRows(db, attempt, (row, snapshot) => {
    const answer = answerOf(row.answerJson);
    draftRevisions[row.questionId] = row.answerRevision;
    if (answer !== null) drafts[row.questionId] = answer;
    // T2.11：已解锁提示回显（纯函数——文本取自同一份冻结快照，不再二次查库）
    const echo = openedHintEcho(row.hintsOpenedJson, snapshot.hints);
    if (echo.length > 0) hintsOpened[row.questionId] = echo;
    return publicOfSnapshot(snapshot, row.id, {
      materialSlots,
      // 审查 P2-1：旧快照兜底重抽的解析语境（行内冻结单元归属）
      unitId: row.unitId,
    });
  }).map((group) => ({
    id: group.id,
    title: group.title,
    questions: group.items,
  }));
  // M1b：新协议卷附带工作流裁决投影与题级进度白名单（缺失 = 整卷旧协议；
  // 服务端按当前教师/作业规则重算，不改写已选模式；无答案秘密）
  const workflowView = attemptWorkflowView(db, attempt);
  return {
    attempt: attemptSummaryOf(attempt),
    title: meta.title,
    courseName: meta.courseName,
    dueAt: meta.dueAt,
    answerRelease: meta.answerRelease,
    units,
    drafts,
    draftRevisions,
    hintsOpened,
    // T6R.3：懒冻结的升级遗留卷标记（前端提示「内容为恢复后的版本」）
    legacyUnverified: attempt.legacyUnverified,
    enabledCapabilities,
    ...(workflowView ?? {}),
  };
}

/**
 * 结果视图的单题行（快照投影：除已解锁条目外无 hints 内容，options 转纯文本；
 * D9〔T3.5〕新增 teacherMark / teacherComment / finalCorrect 透传 responses 行）。
 * 快照由调用方传入（buildResultData 预加载或现场 parse，单一解析出口 snapshotOfRow）。
 * **stemMd 是作答时原文（含 [[答案]] 标记）**——学生端消费方一律先经
 * studentFacingResultOf 整题投影（唯一包装处，不得再各自手写）。2026-10
 * 讲练一体起导出供 lesson-service 复用。
 */
/**
 * teacherMark 列值的枚举收窄（列无 $type，按 D9 值域收窄给投影用）。原定义在
 * self-review-service（TT-09a），QM-12 移驻本文件：有效判定单一出处需要同一
 * 收窄，教师详情/汇总/错题/学情各消费面不再各写一份。
 */
export function teacherMarkOf(value: string | null): TeacherMark | null {
  return value === "correct" || value === "wrong" ? value : null;
}

/**
 * 行上自评记录的读取投影（QM-10 定义于 self-review-service，TT-09b 移驻本
 * 文件：结果单题投影与自评服务共用同一读取口径，且避免 attempt-service ←→
 * self-review-service 值循环）。verdict 列只存实际判断——undecided 已清除
 * 为 null；revision 的单独下发见 resultQuestionOf。
 * P3-2（TT-09a 审查遗留，本单落地）：脏行防御——verdict 非空而 at 缺失
 * （异常/历史写入）时契约 at min(1) 不成立，按「无记录」降级并 warn 留痕
 * （服务层拿不到 app 层 pino 实例，用固定前缀便于检索），不伪造空时间戳。
 */
export function selfReviewRecordOf(
  row: Pick<
    ResponseRow,
    "selfReviewVerdict" | "selfReviewAt" | "selfReviewRevision"
  >,
): SelfReviewRecord | null {
  if (row.selfReviewVerdict === null) return null;
  if (row.selfReviewAt === null) {
    console.warn(
      `【数据异常】responses 自评脏行（verdict 非空而 at 缺失），按无记录降级（revision=${row.selfReviewRevision}）`,
    );
    return null;
  }
  return {
    verdict: row.selfReviewVerdict,
    at: row.selfReviewAt,
    revision: row.selfReviewRevision,
  };
}

/**
 * 行级有效判定单一出处（QM-12 细项1：教师判 > 自评 > 自动，与契约
 * effectiveVerdictOf 同序）。服务端各消费面（教师详情计数、错题集合、学情
 * 统计、CSV/材料整理包、AI 复盘过滤）一律经本函数，不再各写
 * `finalCorrect ?? autoCorrect` 之类的快捷回落——该口径对自评行恒漏判
 * （reference_self 行 finalCorrect 恒 null）。
 */
export function effectiveVerdictOfRow(
  row: Pick<
    ResponseRow,
    | "autoCorrect"
    | "teacherMark"
    | "selfReviewVerdict"
    | "selfReviewAt"
    | "selfReviewRevision"
  >,
): EffectiveVerdict | null {
  return effectiveVerdictOf(
    row.autoCorrect,
    teacherMarkOf(row.teacherMark),
    selfReviewRecordOf(row),
  );
}

export function resultQuestionOf(
  row: ResponseRow,
  snapshot: Question,
  options: {
    /** 冻结材料槽位序（QM-13：matching 槽位集合展开用；缺省不携带键） */
    readonly materialSlots?: ReadonlyMap<string, readonly string[]>;
  } = {},
): AttemptResultQuestion {
  // 审查 P2-1：旧格式冻结快照（三结构键全缺）从快照自身 sourceMd 兜底重抽
  // （行内冻结单元归属作解析语境；不引活库）
  const structure = effectiveStructureOfSnapshot(snapshot, row.unitId);
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
      // QM-13：matching/ordering 作答面结构随结果快照下发（对照呈现需要）；
      // 2026-10-25 审查 P1 收紧：学生面变体（剥离 distractor，ordering 附
      // sortableCount 计数）——对照呈现不需要逐项干扰标记
      ...(structure.matchingOptions !== undefined
        ? {
            matchingOptions: matchingOptionsStudentOf(
              structure.matchingOptions,
            ),
          }
        : {}),
      ...matchingSlotsProjection(structure, options.materialSlots),
      ...(structure.orderingItems !== undefined
        ? orderingStudentOf(structure.orderingItems)
        : {}),
      hintCount: snapshot.hints.length,
    },
    ...releaseOfSnapshot(snapshot),
    answer: answerOf(row.answerJson),
    autoCorrect: row.autoCorrect,
    // D9：教师批注与最终判定（D3 持久化口径；公布 gate 在 releaseAwareQuestion 投影）
    teacherMark:
      row.teacherMark === "correct" || row.teacherMark === "wrong"
        ? row.teacherMark
        : null,
    teacherComment: row.teacherComment,
    finalCorrect: row.finalCorrect,
    // QM-11（TT-09b）：行级自评状态与判分策略（公布 gate 在
    // releaseAwareQuestion 投影为 null——未公布形态无自评入口；record=null
    // 表示未评或已撤回，revision 是 CAS 基线、undecided 清除亦递增）
    selfReview: {
      record: selfReviewRecordOf(row),
      revision: row.selfReviewRevision,
    },
    gradingPolicy: row.gradingPolicy,
    // T2.11：只回显做题时已解锁的提示（文本取自快照；未解锁条目绝不在此）
    hintsOpened: resultHintsOpenedOf(row, snapshot.hints),
  };
}

/**
 * 结果条目的学生端整题投影（防泄露不变式的唯一包装处，2026-10 讲练一体收敛
 * 三份手写副本）：在 resultQuestionOf 条目之上把 snapshot.stemMd 经
 * studentStemMd 投影（[[答案]] → 空框、剥题干内嵌选项列表——AGENTS 第 3 条，
 * 学生端题干唯一入口）。三个消费方：buildResultData 的 releaseAwareQuestion
 * （已公布也投影）、submitLessonQuestion 响应（提交即释放）、lesson-service
 * 的 released 条目（当题释放）。
 */
export function studentFacingResultOf(
  item: AttemptResultQuestion,
): AttemptResultQuestion {
  return {
    ...item,
    snapshot: { ...item.snapshot, stemMd: studentStemMd(item.snapshot) },
  };
}

/** 得分汇总的判定计数部分（QM-12 起有效判定口径：教师判 > 自评 > 自动——
 *  与逐题徽章 verdictBadgeDisplayOf 同一显示口径，汇总与徽章不再漂移；
 *  未公布的受限形态由 buildResultData 覆写不泄露对错）。D9 的 scoreFinal/
 *  pendingCount 不在此算——前者取 attempt 行、后者走 pendingMarkCount
 *  （D4 共享谓词），由 buildResultData 组装进完整 AttemptScoreSummary */
function scoreSummaryOf(
  rows: readonly AttemptResultQuestion[],
): Omit<AttemptScoreSummary, "scoreFinal" | "pendingCount"> {
  const total = rows.length;
  const answered = rows.filter((r) => r.answer !== null).length;
  let correct = 0;
  let wrong = 0;
  let pending = 0;
  for (const item of rows) {
    // 有效判定（公布 gate 已过：selfReview/teacherMark/autoCorrect 均为真实值；
    // 未公布形态的覆写在 buildResultData）
    const effective = effectiveVerdictOf(
      item.autoCorrect,
      item.teacherMark,
      item.selfReview?.record ?? null,
    );
    if (effective === null) pending += 1;
    else if (effective.value) correct += 1;
    else wrong += 1;
  }
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
  // M4-D3 §13.8：工作流裁决投影（lesson / legacy 卷 null = 零查询早退）
  const workflowView = attemptWorkflowView(db, attempt, now);
  // T2A.8：assignment 来源按作业判定；course 来源恒公布（D11 课程练习交卷即公布）
  const assignmentRow =
    attempt.sourceType === "assignment"
      ? requireAssignmentRow(db, attempt.assignmentId ?? "")
      : null;
  const released =
    assignmentRow === null || answersReleased(assignmentRow, now);

  /** 受限形态的逐题投影（见函数头注释）。
   * stemMd 一律经 studentFacingResultOf 学生端投影（已公布也不例外）：[[答案]]
   * 渲染为空框、选择题选项列表由前端 options 行渲染——保证学生载荷在任何形态下
   * 都不含 [x] 正确项标记与非空 [[…]] 标记（AGENTS 第 3 条，studentStemMd
   * 唯一入口）。D9 字段 teacherMark / teacherComment / finalCorrect 与
   * autoCorrect 同法置 null——教师已批也不在截止前泄露对错与评语。
   * QM-11：selfReview / gradingPolicy 同法置 null——未公布形态无自评入口，
   * 行策略与自评状态不下发（与 §5.5.3 pending_release「不显示答案、无自评
   * 入口」同一读侧口径） */
  const releaseAwareQuestion = (item: AttemptResultQuestion) => {
    const projected = studentFacingResultOf(item);
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
          selfReview: null,
          gradingPolicy: null,
        };
  };

  // 逐题条目与分组同批组装（groupedSnapshotRows 统一「跳过缺失+组 id 回退+
  // 空组过滤」；快照优先取预加载，未覆盖行现场 parse）
  // QM-13：matching 槽位集合按冻结材料槽位序展开（一次取全卷共用）
  const materialSlots = materialSlotOrderOf(db, attempt.id);
  const resultQuestions: AttemptResultQuestion[] = [];
  const unitGroups: AttemptResultUnit[] = groupedSnapshotRows(
    db,
    attempt,
    (row, snapshot) => {
      const item = releaseAwareQuestion(
        resultQuestionOf(row, snapshot, { materialSlots }),
      );
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
    // M4-D3 §13.8 节奏摘要：v1 新协议卷携带裁决投影（feedbackMode 驱动结果页
    // 「反馈节奏」摘要行），读时按当前规则裁决——与草稿视图同一 resolver/同一
    // schema 单源；lesson / legacy 卷为 null（缺省 = 前端不渲染该行，零查询
    // 早退）。只携带授权结论本身，答案/对错仍走 answersReleased gate，不放宽
    // 任何普通学生接口投影
    ...(workflowView !== null
      ? { practiceWorkflow: workflowView.practiceWorkflow }
      : {}),
  };
}
