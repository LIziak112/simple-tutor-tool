import { randomUUID } from "node:crypto";
import {
  type AttemptResultData,
  type AttemptSubmitRequest,
  attemptResultDataSchema,
  type Question,
  type StudentAnswer,
} from "@tutor/contract";
import { gradeResponseRow, isUnanswered } from "@tutor/grading";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  attempts,
  ink,
  type ResponseRow,
  responses,
  submissionEvidence,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { requireUsableAttempt } from "./attempt-access.ts";
import { touchAttemptActivity } from "./attempt-activity";
import { buildResultData } from "./attempt-detail.ts";
import {
  attemptFinalOutcomeOf,
  type FinalOutcomeRow,
  scoreAutoOf,
} from "./attempt-final-outcome.ts";
import { attemptResponseRows } from "./attempt-freeze.ts";
import { writeFinalSettlementWithin } from "./attempt-settlement.ts";
import { buildSubmissionEvidence } from "./attempt-submit-evidence.ts";
import { validateSubmitRevisions } from "./attempt-submit-revisions.ts";
import { assertSavedAnswersConfirmed } from "./attempt-timing";
import { recordConfirmedSubmit, submissionActivityOf } from "./event-service";
import { practiceProtocolOf } from "./practice-workflow-wiring";
import { answerOf, snapshotOfRow } from "./snapshot";
import {
  recordedActiveSecTotal,
  submittedTimePatchOf,
} from "./submission-time.ts";

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
 * - T6R.3 版本验证：request 提供时（HTTP 路由恒传，不带请求体按空
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
  request?: AttemptSubmitRequest,
): AttemptResultData {
  return db.transaction(
    () =>
      attemptResultDataSchema.parse(
        finalizeWholeAttempt(db, studentId, attemptId, now, request),
      ),
    { behavior: "immediate" },
  );
}

function finalizeWholeAttempt(
  db: Db,
  studentId: string,
  attemptId: string,
  now: Date | string,
  request: AttemptSubmitRequest | undefined,
): AttemptResultData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (attempt.status !== "draft") {
    throw new HttpError(409, "ALREADY_SUBMITTED", "这份练习已经交过卷了");
  }
  assertSavedAnswersConfirmed(attempt, now, request?.confirmedSavedAnswers);

  // T6R.3：判分输入 = 冻结快照（门口已懒冻结兜底）。三来源统一取行（rowid 序；
  // 判分与顺序无关，展示排序在结果视图经 unitGroupedRows 重建）
  const ownRows = attemptResponseRows(db, attemptId);
  // 逐题提交语义的卷（lesson 独立适配 + M2 新协议普通卷）：已单题提交的行不重判；
  // 判定走 practiceProtocolOf 单一谓词（异常行按历史卷全量判分，与逐题消费点一致）；
  // 历史卷行 submittedAt 恒 null → 全量判分，行为零变化
  const perQuestionAttempt = practiceProtocolOf(attempt) !== "legacy";

  // T2.10：每题有效用时与改答案次数（服务端按事件序列计算，§5.5）
  const { activeSecByQuestion, eventChangeCountByQuestion } =
    submissionActivityOf(db, attemptId);

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
    if (ownRow.submittedAt !== null) {
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
      finalCorrect: entry.autoCorrect,
    });
  }

  // revisions 全集校验不变：比对对象是**全部冻结题**（lesson 含已提交行）
  if (request) validateSubmitRevisions(allFrozen, graded, request.revisions);
  // T6R.10：笔记证据声明验证、判分和写入都在同一事务——
  // 范围 = 参与本次判分的行（逐题语义卷：未提交题）；任一项验证失败零落行，
  // attempt 保持 draft 可恢复
  const evidenceRows = buildSubmissionEvidence(
    db,
    attemptId,
    graded,
    request?.evidence,
  );

  // #6980-3（审查修复 P0-1，2026-10-25）：正式手写笔迹也算「有实际作答」——
  // 只交手写、未填文本的主观题不是「未做」。正式笔迹的真实关联在 ink 表
  // (attemptId, questionId) 唯一键（responses.inkId 是 T2.8 遗留列、恒空，
  // 不作数）；strokeCount>0 才算正式笔迹。一次查出本卷有稿题集，判分写点
  // 与内存镜像统一消费。
  const inkQuestionIds = new Set(
    db
      .select({ questionId: ink.questionId })
      .from(ink)
      .where(and(eq(ink.attemptId, attemptId), gt(ink.strokeCount, 0)))
      .all()
      .map((row) => row.questionId),
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
  if (!touchAttemptActivity(db, attemptId, nowIso))
    throw new HttpError(409, "ALREADY_SUBMITTED", "该练习已提交");

  for (const g of graded) {
    db.update(responses)
      .set({
        answerJson: g.answer !== null ? JSON.stringify(g.answer) : null,
        autoCorrect: g.autoCorrect,
        // D3：交卷同时写 finalCorrect = autoCorrect（teacherMark 必空）
        finalCorrect: g.autoCorrect,
        // #6980-3：是否有实际作答（与判分正交；错题本入本/未做灰显共用）。
        // 正式手写笔迹也算已答（审查修复 P0-1：只交手写未填文本的主观题
        // 不是「未做」）；被动跳过（无答案、无笔迹、未单题提交）才冷处理
        answered:
          !isUnanswered(g.answer) || inkQuestionIds.has(g.response.questionId),
        ...rowSubmittedAtPatch,
        ...submittedTimePatchOf(activeSecByQuestion, g.response.questionId),
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
    db.insert(submissionEvidence)
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
  const totalActiveSec = recordedActiveSecTotal([
    ...keptRows,
    ...graded.map((g) =>
      submittedTimePatchOf(activeSecByQuestion, g.response.questionId),
    ),
  ]);
  recordConfirmedSubmit(db, attempt, nowIso);
  const completed = db
    .update(attempts)
    .set({
      // D2/D3：全部 finalCorrect 非 null → 直接 graded 并写 scoreFinal；
      // 否则 submitted、scoreFinal=null（待批批改后由 T3.2b 重算）
      status: finalStatus,
      submittedAt: nowIso,
      scoreAuto,
      scoreFinal,
      // 总有效用时 = 各题之和；无任何 focus 序列（未计算）保持 NULL
      activeSec: totalActiveSec,
    })
    .where(and(eq(attempts.id, attemptId), eq(attempts.status, "draft")))
    .returning({ id: attempts.id })
    .get();
  if (!completed)
    throw new HttpError(409, "ALREADY_SUBMITTED", "这份练习已经交过卷了");
  writeFinalSettlementWithin(db, attemptId);

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
      answered:
        !isUnanswered(g.answer) || inkQuestionIds.has(g.response.questionId),
      ...rowSubmittedAtPatch,
      ...submittedTimePatchOf(activeSecByQuestion, g.response.questionId),
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
    activeSec: totalActiveSec,
  };
  return buildResultData(
    db,
    attemptAfter,
    now,
    new Map(allFrozen.map((g) => [g.response.questionId, g.question] as const)),
    updatedRows,
  );
}
