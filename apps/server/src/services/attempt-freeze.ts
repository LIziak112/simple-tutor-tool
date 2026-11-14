import { randomUUID } from "node:crypto";
import {
  frozenGradingPolicySchema,
  type GradingPolicy,
  materialRefSchema,
  NEW_QUESTION_TYPES,
  optionSchema,
  type Question,
  type QuestionAnswers,
  type QuestionOption,
  questionAnswersSchema,
  questionSchema,
} from "@tutor/contract";
import { parseDocument, wrapSingleQuestionMd } from "@tutor/md-dsl";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  attempts,
  type Question as QuestionRow,
  type ResponseRow,
  responses,
} from "../db/schema";
import { knowledgeNamesByQuestion } from "./assignment-service";
import { frozenGradingPolicyOf } from "./attempt-context.ts";
import {
  assertAttemptQuestionLimit,
  loadAttemptQuestions,
} from "./attempt-question-set.ts";
import { hintsOfJson } from "./hint-service";
import type { Tx } from "./question-sync";
import { jsonOf } from "./snapshot";

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
   * 补行）。
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
      gradingPolicy: frozenGradingPolicySchema.parse(
        values.gradingPolicy ?? null,
      ),
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
 * 教师的自评设置随题目快照一起冻结。
 */
export function insertFrozenResponses(
  tx: Tx,
  attemptId: string,
  liveRows: readonly QuestionRow[],
  knowledgeByQuestion: ReadonlyMap<string, string[]>,
  studentSelfReviewEnabled: boolean,
): void {
  for (const row of liveRows) {
    const snapshot = questionOfRow(row, knowledgeByQuestion.get(row.id) ?? []);
    insertFrozenResponse(tx, {
      attemptId,
      questionId: row.id,
      questionVersion: row.version,
      questionSnapshotJson: JSON.stringify(snapshot),
      unitId: row.unitId,
      gradingPolicy: frozenGradingPolicyOf(snapshot, studentSelfReviewEnabled),
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
 * 非 wrong 来源的冻结输入：attempt 单元集合内的当前 live 题（单元序 × 题序，
 * attemptQuestionRows 口径，域内取题 D10）+ 各题考点名（快照 knowledge 用，
 * 只查卷内题目的关联，不拉全教师域）。
 * 教师域缺失的异常行按空集合处理（fail closed，空卷冻结）。
 */
function freezeInputsOfAttempt(
  db: Db,
  attempt: Attempt,
  checkNewAttemptLimit = false,
): {
  liveRows: QuestionRow[];
  knowledgeByQuestion: ReadonlyMap<string, string[]>;
  /** 题目所属教师域（tt-07a 依赖闭包计算用；异常行 null → 闭包为空） */
  teacherId: string | null;
} {
  const { teacherId, liveRows } = loadAttemptQuestions(db, attempt);
  if (checkNewAttemptLimit) assertAttemptQuestionLimit(liveRows.length);
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

/** 新开卷在读取考点和冻结上下文之前先核对实际题数。 */
export function freezeInputsOfNewAttempt(db: Db, attempt: Attempt) {
  return freezeInputsOfAttempt(db, attempt, true);
}

/**
 * 懒冻结（T6R.3 迁移分支②，方案 §5.1）：升级前遗留的进行中 attempt
 * （frozenAt IS NULL 且 status='draft'）在首次恢复访问时冻结当前可取得版本
 * ——live 题补齐快照（保留已有答案），软删/缺失题的既有行保留为
 * 「历史题目缺失」（快照空，不回填），标记 legacy_unverified=1（不能宣称是
 * 学生更早看到的内容）。幂等：已冻结或已交卷立即返回。冻结统一发生在
 * requireUsableAttempt 门口（学生侧全部续作接口）与教师 draft 详情；同步单
 * 进程无并发竞态。返回冻结后的最新 attempt 行（分态消费方必须用返回值）。
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

/**
 * questions 行 → 契约 Question（判分输入与快照内容；解析失败的字段按缺省处理）。
 * T6R.20：annotation-service 的 stale 判定以同构路径重建快照算 hash（单源）。
 * QM-09（TT-08b）：无专列结构化字段（word-min/max、matching/ordering 选项池、
 * rubric）沿用「结构化字段以 sourceMd 为单一来源」口径，建卷冻结时从 sourceMd
 * 重抽取（零迁移）；门控用契约 NEW_QUESTION_TYPES 单源集合（I16 守卫口径），
 * 旧七型零开销；解析失败静默缺省（提示性投影缺失不阻断建卷）。
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
  // 模块 3 量表（:::rubric）同走 sourceMd 重抽（零迁移）；源文无该指令的题
  // 不付解析成本（旧七型主观题也可带量表，不限新题型）
  if (
    NEW_QUESTION_TYPES.includes(row.type) ||
    row.sourceMd.includes(":::rubric")
  ) {
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
    if (structure.rubric !== undefined) question.rubric = structure.rubric;
  }
  return question;
}

/**
 * 单题 sourceMd → 无专列结构化字段的重抽通道（word-min/max、matchingOptions/
 * orderingItems、rubric）。包装与解析选项与 reparse-service.planQuestion 同款
 * （保证解析出的题与库中行同 id）；按 id 命中后只取无专列字段。解析失败静默
 * 缺省（只是少作答面投影，不阻断建卷）。
 */
function qmStructureOfSourceMd(row: QuestionRow): {
  wordMin?: number;
  wordMax?: number;
  matchingOptions?: Question["matchingOptions"];
  orderingItems?: Question["orderingItems"];
  rubric?: Question["rubric"];
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
          ...(hit.rubric !== undefined ? { rubric: hit.rubric } : {}),
        };
  } catch {
    // sourceMd 损坏（历史脏行）不阻断建卷：字数建议缺失只是少一条提示
    return {};
  }
}
