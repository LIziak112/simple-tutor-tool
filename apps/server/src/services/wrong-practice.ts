import { randomUUID } from "node:crypto";
import type { AttemptStartData, WrongPracticeScope } from "@tutor/contract";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { attempts, type ResponseRow, students } from "../db/schema";
import { kernelWrongOpenings } from "../db/schema-kernel-question-delivery.ts";
import { HttpError } from "../lib/http-error";
import { frozenGradingPolicyOf } from "./attempt-context.ts";
import { assertAttemptQuestionLimit } from "./attempt-question-set.ts";
import {
  type AttemptWorkflowStartOptions,
  attemptSummaryOf,
  newDraftAttempt,
  requireOwnAttempt,
  workflowStartColumns,
} from "./attempt-service";
import { createOnce } from "./create-receipt";
import {
  finishKernelWrongOpening,
  insertWrongPracticeWithin,
  reserveKernelWrongOpening,
  withWrongKernelStorage,
} from "./kernel-wrong-practice-opening.ts";
import { studentSelfReviewEnabledOf } from "./practice-feedback-settings-service.ts";
import { snapshotOfRow } from "./snapshot";
import { wrongAttemptContextPlan } from "./wrong-attempt-context.ts";
import { latestJudgedResponsesByQuestion } from "./wrong-question-rounds.ts";

/**
 * 错题重练组卷（2026-10 学生端闭环的最后一块）——POST /api/student/wrong-practice
 * 与学生 MCP create_wrong_practice 共用的业务层。产品口径：**重练范围由前端/AI
 * 圈定**（错题本当前 tab + 分组的题目 id，顺序即组卷题序），服务端只做校验与
 * 组卷：
 *
 * - 校验：每个 questionId ∈ 该生错题本聚合（latestJudgedResponsesByQuestion，
 *   入本条件与 listWrongQuestions 完全一致——任一次已判定作答判错；includeResolved
 *   全量口径，已攻克的题同样可重练）**且最近一次判定作答的快照可用**
 *   （questionSnapshotJson 可解析，snapshotOfRow 同口径）。不满足的题**静默剔除**
 *   （不在聚合内 = 从未错过/公布 gate 挡住的题，不给信息量）；剔完为空 →
 *   400 WRONG_PRACTICE_EMPTY；
 * - 组卷（快照冻结口径）：练的就是**当时做错的那道题**——每题复制最近一次判定
 *   作答 responses 行的 questionSnapshotJson / questionVersion 进新 attempt 的
 *   自有 responses 行（题序 = questionIds 去重后的顺序 = 插入顺序，读路径按
 *   rowid 升序还原，见 db/schema.ts responses 表注释）。教师此后改题库/软删题
 *   不影响已建的卷与判分（判分输入 = 冻结快照，不查 questions 表）。tt-07a
 *   （QM-06）起材料/组依赖同事务冻结（来源卷快照优先——错题时学生所见的
 *   版本），gradingPolicy 按来源快照和教师自评设置冻结；
 * - attempt 行：sourceType='wrong'、assignmentId/courseId/unitId 恒 null（契约
 *   superRefine 锁定；无课程归属 → **永不失权**，草稿与记录一直可见）；
 *   attemptNo 按该生已有卷次与待开卷预留递增；不限制同时存在
 *   多份未交卷的 wrong 卷（每次重练都是独立新卷，互不影响，旧草稿从记录页
 *   续作）；
 * - 作答/判分/批改全复用既有机制（AttemptSession、submit、grading、教师待批
 *   队列）：wrong 来源的填空待批题照常进教师队列，全部判定后 status=graded；
 *   交卷后自动成为错题本新一轮（聚合按 (学生, 题目) 自然纳入）。
 *
 * 返回 { attempt, includedCount }：includedCount = 实际冻结进卷的题数（去重后
 * 剔除无效 id 与依赖缺失的题）——MCP 组卷工具用它算 excludedCount 反馈给 AI；
 * 页面路由只取 attempt。
 *
 * 安全口径（AGENTS 第 3 条）：新卷只携带题目快照（服务端行内数据），响应本体是
 * attempt 摘要（无任何题目内容）；未交卷详情/试卷照旧走 attempt-service 的
 * 公开投影（publicOfSnapshot），泄露测试见 routes/student-wrong-practice.test.ts。
 */
export function startWrongPractice(
  db: Db,
  studentId: string,
  questionIds: readonly string[],
  options: AttemptWorkflowStartOptions = {},
  /** 建卷范围快照（#6980-2）：随卷落 practice_scope_json，展示「练的是什么」 */
  scope?: WrongPracticeScope | undefined,
  operationId?: string,
  dataDir?: string,
  kernelEnabled = false,
): { attempt: AttemptStartData; includedCount: number } {
  const reserve = (store: Db) =>
    reserveWrongPractice(
      store,
      studentId,
      questionIds,
      options,
      scope,
      dataDir,
      kernelEnabled && operationId !== undefined,
    );
  const saved = withWrongKernelStorage(db, dataDir, () =>
    operationId
      ? createOnce(
          db,
          "wrong-practice",
          studentId,
          operationId,
          [questionIds, options, scope],
          z.object({
            id: z.uuid(),
            includedCount: z.number().int().positive(),
            kernelOpening: z.literal(true).optional(),
          }),
          reserve,
        )
      : db.$client.transaction(() => reserve(db)).immediate(),
  );
  const attempt = saved.kernelOpening
    ? finishKernelWrongOpening(db, dataDir, saved.id, studentId)
    : requireOwnAttempt(db, studentId, saved.id);
  return {
    attempt: attemptSummaryOf(attempt),
    includedCount: saved.includedCount,
  };
}

function reserveWrongPractice(
  db: Db,
  studentId: string,
  questionIds: readonly string[],
  options: AttemptWorkflowStartOptions,
  scope: WrongPracticeScope | undefined,
  dataDir: string | undefined,
  kernelEnabled: boolean,
) {
  // 去重保序（契约不拦重复 id；前端从聚合结果取 id 天然无重复，防御性收敛）
  const uniqueIds = [...new Set(questionIds)];

  // 该生错题本聚合内的题 → 最近一次判定作答行（快照来源）
  const latestByQuestion = latestJudgedResponsesByQuestion(db, studentId, {
    questionIds: uniqueIds,
    ...(dataDir === undefined ? {} : { dataDir }),
  });

  /** 逐题校验：在聚合内且快照可用，否则剔除 */
  const pickOf = (questionId: string): ResponseRow | null => {
    const source = latestByQuestion.get(questionId);
    if (source === undefined) return null; // 不在聚合内（从未错过/公布 gate 挡住）
    return snapshotOfRow(source) !== null ? source : null; // 坏快照不可组卷
  };
  const picked = uniqueIds
    .map((questionId) => pickOf(questionId))
    .filter((row): row is ResponseRow => row !== null);

  // tt-07a（QM-06）：错题重练的依赖冻结走本单统一路径（设计方案 §5.3「错题
  // 重练复制来源作答的该子题及必要材料/说明」）——依赖条目**来源卷快照优先**
  // （错题时学生所见的版本），来源未知且无快照的旧卷回退当前版本；依赖在两边都
  // 不可得（教师软删且来源卷未冻结）→ 该题剔除（学生自助重练不整卷失败）
  const teacherId =
    db
      .select({ teacherId: students.teacherId })
      .from(students)
      .where(eq(students.id, studentId))
      .get()?.teacherId ?? null;
  const plan = wrongAttemptContextPlan(db, teacherId, picked);

  const includedCount = plan.usable.length;
  if (includedCount === 0) {
    throw new HttpError(
      400,
      "WRONG_PRACTICE_EMPTY",
      "这些题目不在你的错题本里（或状态有变），请刷新后再试",
    );
  }
  assertAttemptQuestionLimit(plan.usable.length);

  const studentSelfReviewEnabled = studentSelfReviewEnabledOf(db, teacherId);
  // P2（2026-10-28 #38）：selection 范围快照的 questionCount 以服务端实际冻结
  // 题数覆写——契约只校验 questionCount = 去重入参 id 数，服务层静默剔除不在
  // 聚合/快照损坏的题后，客户端的 N 与实际不符，原样落库会把「手选 5 题」和
  // 4 道题一起永久冻结进卷标题（页面勾选状态过期时即可复现）。includedCount
  // ≥ 1（上方空卷已抛 WRONG_PRACTICE_EMPTY），覆写不破契约 min(1)；
  // kind=ai 的 label 是自由文本无计数，不涉及。
  const effectiveScope =
    scope === undefined
      ? undefined
      : scope.kind === "selection" && scope.questionCount !== includedCount
        ? { ...scope, questionCount: includedCount }
        : scope;

  // 取最大卷次；待开卷意图和已可见卷共用同一序号。
  const latestRow = db
    .select({ n: sql<number | null>`max(${attempts.attemptNo})` })
    .from(attempts)
    .where(
      and(eq(attempts.studentId, studentId), eq(attempts.sourceType, "wrong")),
    )
    .get();
  const latestOpening = db
    .select({ n: sql<number | null>`max(${kernelWrongOpenings.attemptNo})` })
    .from(kernelWrongOpenings)
    .where(eq(kernelWrongOpenings.studentId, studentId))
    .get();
  const attempt = newDraftAttempt({
    id: randomUUID(),
    studentId,
    sourceType: "wrong",
    assignmentId: null,
    lectureId: null,
    courseId: null,
    unitId: null,
    attemptNo: Math.max(latestRow?.n ?? 0, latestOpening?.n ?? 0) + 1,
    startedAt: new Date().toISOString(),
    activateOnCreate: scope?.kind === "ai",
    ...workflowStartColumns(db, "wrong", studentId, null, options),
  });
  const draft = {
    scope: effectiveScope,
    context: [...plan.entries],
    responses: plan.usable.flatMap((source) => {
      const snapshot = snapshotOfRow(source);
      if (source.questionSnapshotJson === null || snapshot === null) return [];
      return [
        {
          questionId: source.questionId,
          questionVersion: source.questionVersion,
          questionSnapshotJson: source.questionSnapshotJson,
          gradingPolicy: frozenGradingPolicyOf(
            snapshot,
            studentSelfReviewEnabled,
          ),
        },
      ];
    }),
  };
  if (
    kernelEnabled &&
    dataDir &&
    reserveKernelWrongOpening(db, dataDir, attempt, teacherId, draft)
  )
    return { id: attempt.id, includedCount, kernelOpening: true as const };
  insertWrongPracticeWithin(db, attempt, draft);
  return { id: attempt.id, includedCount };
}
