import {
  and,
  eq,
  inArray,
  isNotNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Attempt,
  assignments,
  attempts,
  type ResponseRow,
  responses,
} from "../db/schema.ts";
import { kernelAssignments } from "../db/schema-kernel-assignments.ts";
import { releaseGateSql } from "./answer-publication-sql.ts";
import { hasKernelAssignmentTables } from "./kernel-assignment-routing.ts";
import { boundWrongAttemptId } from "./kernel-question-delivery-binding.ts";
import {
  readPublishedKernelWrongRounds,
  type WrongRoundScope,
} from "./kernel-student-wrong-rounds.ts";
import { pendingTeacherResponseSql } from "./pending-mark.ts";
import {
  countsAsWrong,
  effectiveVerdictOfRow,
  effectiveVerdictValueSql,
} from "./response-verdict.ts";
import { createQuestionReviewReader } from "./review-access.ts";

/**
 * 已判定作答的轮次行（judgedRoundsByQuestion 的值元素）：该生某题的一次
 * 已交卷且有效判定非 null 的作答（公布 gate 过滤后；QM-12 起 reference_self
 * 行按学生自评计为已判定轮——携带自评/教师/自动全列，有效判定经
 * effectiveVerdictOfRow 单一出处计算，不再各写 finalCorrect 回落）。
 */
interface JudgedRoundRow {
  /** 判定来源（两线收敛：v2 错题闭环来源标注接线 QM 有效判定口径） */
  reviewSource?: import("@tutor/contract").VerdictSource;
  questionId: string;
  attemptId: string;
  responseId: string;
  submittedAt: string | null;
  startedAt: string;
  finalCorrect: boolean | null;
  autoCorrect: boolean | null;
  teacherMark: string | null;
  selfReviewVerdict: "correct" | "wrong" | null;
  selfReviewAt: string | null;
  selfReviewRevision: number;
  /** #6980-3：该轮是否有实际作答（responses.answered，判分写点落库） */
  answered: boolean;
  /** #6980-4：该轮做题时学生是否标了「不会」（responses.student_flag） */
  studentFlag: string | null;
}

/** 轮次行的有效判定（教师判 > 自评 > 自动；教师清除后回落自评，§5.5.4 ✱ 行） */
export function effectiveOfRound(round: JudgedRoundRow) {
  return effectiveVerdictOfRow(round);
}

/**
 * 错题本入本谓词（#6980-3/#6980-4 单一出处）：任一次已判定作答「答了且判错」
 * 或「标了不会」（studentFlag=unsure，无论对错与是否作答）——判错走 QM-12
 * 有效判定（教师判 > 自评 > 自动，effectiveOfRound 单源）；未做且未标不会的
 * 轮（answered=false 且无人工显式判定）不入本，但人工显式判定（teacherMark /
 * 自评 verdict，审查修复 P0-1）不被「未做」掩盖：老师显式批错、学生自评
 * 「错了」的行照常入本计错次。listWrongQuestions 聚合与
 * latestJudgedResponsesByQuestion（重练组卷成员校验 + 快照来源）共用本函数，
 * 防口径漂移。
 */
export function enteredWrongBook(rounds: readonly JudgedRoundRow[]): boolean {
  return rounds.some(
    (round) =>
      countsAsWrong(effectiveOfRound(round), round.answered) ||
      round.studentFlag === "unsure",
  );
}

/**
 * 该生全部已判定作答按题分组的轮次行（组内升序：submittedAt ?? startedAt，
 * 同刻 attemptId 升序兜底稳定——与旧窗口函数 order by 同口径）。
 * 公布 gate（answer-release 的 SQL 化）：after_due 未公布的作业 attempt 整体
 * 不参与（见模块头注释）；course 来源恒参与（D11 交卷即公布）。
 * 两个 id 列必须显式别名（attempt_id / response_id）——裸列名都是 "id"，
 * 子查询结果对象里会互相覆盖，导致后续按 responseId 回读内容失败。
 *
 * 2026-10 抽出为独立函数：listWrongQuestions（聚合条目）与重练组卷
 * （latestJudgedResponsesByQuestion，attempt-service startWrongPractice 调用）
 * 共用同一查询与排序，保证「入本判定」与「重练快照来源」两处口径永不漂移。
 */
interface ReviewableRound extends JudgedRoundRow {
  attempt: Attempt;
  rowSubmittedAt: string | null;
  settlementSeq: number | null;
}

function excludeKernelAssignments(db: Db, kernelTables: boolean) {
  return kernelTables
    ? notExists(
        db
          .select({ id: kernelAssignments.assignmentId })
          .from(kernelAssignments)
          .where(eq(kernelAssignments.assignmentId, attempts.assignmentId)),
      )
    : undefined;
}

export interface WrongRoundFacts {
  kernelTables: boolean;
  roundsByQuestion: Map<string, JudgedRoundRow[]>;
  responsesById: (ids: readonly string[]) => Map<string, ResponseRow>;
}

function readLegacyJudgedRounds(
  db: Db,
  studentId: string,
  nowIso: string,
  kernelTables: boolean,
  questionIds?: readonly string[],
): ReviewableRound[] {
  return (
    db
      .select({
        questionId: responses.questionId,
        attemptId: sql<string>`${attempts.id}`.as("attempt_id"),
        responseId: sql<string>`${responses.id}`.as("response_id"),
        submittedAt: sql<
          string | null
        >`coalesce(${responses.submittedAt}, ${attempts.submittedAt})`.as(
          "submitted_at",
        ),
        startedAt: attempts.startedAt,
        finalCorrect: responses.finalCorrect,
        autoCorrect: responses.autoCorrect,
        teacherMark: responses.teacherMark,
        selfReviewVerdict: responses.selfReviewVerdict,
        selfReviewAt: responses.selfReviewAt,
        selfReviewRevision: responses.selfReviewRevision,
        answered: responses.answered,
        studentFlag: responses.studentFlag,
        // 两线收敛接线（v2 错题闭环）：轮次可见性守卫按 attempt + 行级提交事实
        // 裁决（逐题提交的进行中卷已释放行可入轮次；受限行不可见不装配）
        attempt: attempts,
        rowSubmittedAt: responses.submittedAt,
        settlementSeq: responses.settlementSeq,
      })
      .from(responses)
      .innerJoin(attempts, eq(responses.attemptId, attempts.id))
      // 公布 gate 的作业维度（course/wrong 行 leftJoin 不命中；FK 保证 assignment
      // 来源必命中）
      .leftJoin(assignments, eq(attempts.assignmentId, assignments.id))
      .where(
        and(
          eq(attempts.studentId, studentId),
          excludeKernelAssignments(db, kernelTables),
          kernelTables ? notExists(boundWrongAttemptId(db)) : undefined,
          questionIds === undefined
            ? undefined
            : inArray(responses.questionId, questionIds),
          // 已判定作答谓词（D11，QM-12 有效判定口径）：已交卷 + 有效判定非
          // null（教师判 finalCorrect / 自评 selfReviewVerdict 任一即可；未判断
          // 轮不参与——免得一道待评题把旧的「错」盖成未知）。两线收敛：逐题
          // 语义卷进行中（draft）的已单题提交行同样构成轮次（行级 submittedAt
          // 非空——lesson/v1 逐题提交在公布后即可判定）
          or(ne(attempts.status, "draft"), isNotNull(responses.submittedAt)),
          isNotNull(effectiveVerdictValueSql),
          // 公布 gate（answersReleased 的 SQL 化，见 releaseGateSql 注释）
          releaseGateSql(nowIso),
        ),
      )
      .all()
  );
}

function groupWrongRounds(
  db: Db,
  rows: readonly ReviewableRound[],
  nowIso: string,
): Map<string, JudgedRoundRow[]> {
  const roundsByQuestion = new Map<string, JudgedRoundRow[]>();
  const readable = createQuestionReviewReader(db, nowIso);
  for (const row of rows) {
    if (
      !readable(row.attempt, {
        submittedAt: row.rowSubmittedAt,
        settlementSeq: row.settlementSeq,
      })
    )
      continue;
    // 正式题组包含待批或待自评行，只有有效判定才构成轮次。
    const effective = effectiveOfRound(row);
    if (effective === null) continue;
    const list = roundsByQuestion.get(row.questionId) ?? [];
    list.push({ ...row, reviewSource: effective.source });
    roundsByQuestion.set(row.questionId, list);
  }
  for (const list of roundsByQuestion.values()) {
    list.sort(
      (a, b) =>
        (a.submittedAt ?? a.startedAt).localeCompare(
          b.submittedAt ?? b.startedAt,
        ) || a.attemptId.localeCompare(b.attemptId),
    );
  }
  return roundsByQuestion;
}

/** 本人与公布状态在同一个读视图判定；内核事实只参与本次聚合。 */
export function withWrongQuestionRounds<T>(
  db: Db,
  studentId: string,
  now: Date | string,
  scope: WrongRoundScope,
  read: (facts: WrongRoundFacts) => T,
): T {
  const nowIso = new Date(now).toISOString();
  const kernelTables = hasKernelAssignmentTables(db);
  function collect() {
    const rows = readLegacyJudgedRounds(
      db,
      studentId,
      nowIso,
      kernelTables,
      scope.questionIds,
    );
    const recovered = new Map<string, ResponseRow>();
    const kernel = kernelTables
      ? readPublishedKernelWrongRounds(db, studentId, nowIso, scope)
      : [];

    const selected =
      scope.questionIds === undefined ? undefined : new Set(scope.questionIds);
    for (const { attempt, rows: confirmedRows } of kernel) {
      for (const row of confirmedRows) {
        if (selected !== undefined && !selected.has(row.questionId)) continue;
        recovered.set(row.id, row);
        rows.push({
          ...row,
          attempt,
          responseId: row.id,
          startedAt: attempt.startedAt,
          submittedAt: row.submittedAt ?? attempt.submittedAt,
          rowSubmittedAt: row.submittedAt,
        });
      }
    }
    return read({
      kernelTables,
      roundsByQuestion: groupWrongRounds(db, rows, nowIso),
      responsesById(ids) {
        const fetched = new Map<string, ResponseRow>();
        const legacyIds = [];
        for (const id of ids) {
          const projected = recovered.get(id);
          if (projected === undefined) legacyIds.push(id);
          else fetched.set(id, projected);
        }
        for (let offset = 0; offset < legacyIds.length; offset += 500) {
          for (const row of db
            .select()
            .from(responses)
            .where(inArray(responses.id, legacyIds.slice(offset, offset + 500)))
            .all())
            fetched.set(row.id, row);
        }
        return fetched;
      },
    });
  }
  return !kernelTables || scope.dataDir === undefined
    ? collect()
    : db.$client.transaction(collect).immediate();
}

/**
 * 错题本聚合入本题 → 最近一次判定作答的 responses 行（2026-10 重练组卷的
 * 快照来源）。入本条件与 listWrongQuestions 完全一致（任一次已判定作答判错；
 * includeResolved 全量口径——已攻克的题同样可重练）。返回 Map 以 questionId
 * 为键，attempt-service 的 startWrongPractice 用它做成员校验 + 快照复制。
 * 坏快照（questionSnapshotJson 缺失/不可解析）的题同样返回行——由调用方经
 * snapshotOfRow 判定可用性并剔除（组卷校验的一部分）。
 */
export function latestJudgedResponsesByQuestion(
  db: Db,
  studentId: string,
  scope: WrongRoundScope,
): Map<string, ResponseRow> {
  return withWrongQuestionRounds(
    db,
    studentId,
    new Date(),
    scope,
    ({ roundsByQuestion, responsesById }) => {
      const latest = [];
      for (const rounds of roundsByQuestion.values()) {
        if (!enteredWrongBook(rounds)) continue;
        const last = rounds.at(-1);
        if (last !== undefined) latest.push(last.responseId);
      }
      return new Map(
        [...responsesById(latest).values()].map((row) => [row.questionId, row]),
      );
    },
  );
}

/**
 * 该生各题的待批轮数（卡片 pendingCount 的数据源）：已交卷
 * （status != 'draft'）且 `responses.finalCorrect IS NULL` 的作答次数按
 * questionId 分组计数——D4 共享谓词逐题跨 attempt 版（不叠加 answerJson 非空
 * 条件，只写笔迹未填最终答案的手写题正是最需要批的）。QM-12 起与 D4 同步
 * 两条件：排除 reference_self 行（待自评不进教师批改队列——pending-mark.ts
 * 同口径）与快照缺失的幽灵行（不可批的空卡片不计数）。
 * 与 rounds 用同一公布 gate（releaseGateSql 共用片段）：after_due 未公布的
 * 作业作答不计入——数字会泄露「有一轮在等老师判定」，与题目整体消失的口径
 * 一致，防侧漏；course/wrong 来源恒公布。待批轮与已判定轮按有效判定互斥，
 * 两查询合起来恰为该题全部应计作答。
 */
export function pendingCountByQuestion(
  db: Db,
  studentId: string,
  now: Date | string,
  kernelTables: boolean,
): Map<string, number> {
  const nowIso = new Date(now).toISOString();
  return new Map(
    db
      .select({ questionId: responses.questionId, n: sql<number>`count(*)` })
      .from(responses)
      .innerJoin(attempts, eq(responses.attemptId, attempts.id))
      .leftJoin(assignments, eq(attempts.assignmentId, assignments.id))
      .where(
        and(
          eq(attempts.studentId, studentId),
          excludeKernelAssignments(db, kernelTables),
          ne(attempts.status, "draft"),
          pendingTeacherResponseSql,
          releaseGateSql(nowIso),
        ),
      )
      .groupBy(responses.questionId)
      .all()
      .map((row) => [row.questionId, row.n] as const),
  );
}
