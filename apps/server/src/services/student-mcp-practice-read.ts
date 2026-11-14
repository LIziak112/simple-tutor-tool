import {
  attemptPhaseOf,
  type StudentMcpPracticeQuestionData,
  type StudentMcpPracticeQuestionReadInput,
  type StudentMcpPracticeReadInput,
  studentMcpPracticeDataSchema,
  studentMcpPracticeQuestionDataSchema,
} from "@tutor/contract";
import { isUnanswered } from "@tutor/grading";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { ink, responses } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { revokedMcpTokenError } from "../mcp/student-auth.ts";
import { collectStudentPracticeImages } from "../mcp/student-practice-images.ts";
import { sqliteAiPolicyConfigSource } from "./ai-companion/ai-policy-config-source.ts";
import {
  requireStudentAiAttempt,
  resolveAttemptQuestionAiPolicy,
} from "./ai-companion/teaching-policy-service.ts";
import { studentAttemptContext } from "./attempt-context.ts";
import { frozenMaterialsForQuestion } from "./attempt-question-materials.ts";
import { attemptSourceMeta } from "./attempt-rows.ts";
import { contextFromMemoAnchor } from "./learning-context-projection.ts";
import { extractMediaImageSrcs } from "./media-service.ts";
import { assertMemoMetadataBudget } from "./memo-budget.ts";
import { attemptWorkflowView } from "./practice-workflow-wiring.ts";
import { answerOf, snapshotOfRow } from "./snapshot.ts";
import {
  assertStudentMcpPracticeMetadata,
  assertStudentMcpQuestionMetadata,
} from "./student-mcp-practice-metadata.ts";
import {
  assertStudentMcpFrozenMembers,
  studentMcpPublicQuestions,
  studentMcpQuestionMarkdowns,
  studentMcpQuestionsInDisplayOrder,
} from "./student-mcp-practice-paper.ts";
import { studentMcpSubmissionParameters } from "./student-mcp-submission-parameters.ts";

function requireAiQuestion(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
) {
  const policy = resolveAttemptQuestionAiPolicy(
    db,
    studentId,
    attemptId,
    questionId,
    sqliteAiPolicyConfigSource,
    { frozenOnly: true },
  );
  if (!policy.resolution.usable)
    throw new HttpError(
      403,
      "AI_POLICY_DISABLED",
      "当前教学模式下本题暂不能由AI读取",
    );
  return policy;
}

function missing(): never {
  throw new HttpError(404, "QUESTION_NOT_FOUND", "题目不存在或不可见");
}

function questionRow(db: Db, attemptId: string, questionId: string) {
  const row = db
    .select()
    .from(responses)
    .where(
      and(
        eq(responses.attemptId, attemptId),
        eq(responses.questionId, questionId),
      ),
    )
    .get();
  if (!row) return missing();
  return row;
}

/** 全目录在一个短同步读事务中逐题重验当前AI门；不返回任意一题的判定。 */
export function getStudentMcpPractice(
  db: Db,
  studentId: string,
  input: StudentMcpPracticeReadInput,
  now = new Date(),
) {
  return db.transaction(() => {
    const { attempt } = requireStudentAiAttempt(
      db,
      studentId,
      input.practiceId,
    );
    const publicQuestions = studentMcpPublicQuestions(
      db,
      studentId,
      attempt.id,
    );
    if (publicQuestions.length === 0) return missing();
    for (const question of publicQuestions)
      requireAiQuestion(db, studentId, attempt.id, question.id);
    const questions = studentMcpQuestionsInDisplayOrder(
      db,
      studentId,
      attempt,
      publicQuestions,
      now,
    );
    const rows = db
      .select({
        questionId: responses.questionId,
        submittedAt: responses.submittedAt,
        answerJson: responses.answerJson,
        settlementSeq: responses.settlementSeq,
      })
      .from(responses)
      .where(eq(responses.attemptId, attempt.id))
      .all();
    const byId = new Map(rows.map((row) => [row.questionId, row]));
    const inkIds = new Set(
      db
        .select({ questionId: ink.questionId })
        .from(ink)
        .where(and(eq(ink.attemptId, attempt.id), gt(ink.strokeCount, 0)))
        .all()
        .map((row) => row.questionId),
    );
    const data = studentMcpPracticeDataSchema.parse({
      schemaVersion: 1,
      practiceId: attempt.id,
      title: attemptSourceMeta(db, attempt).title,
      status: attempt.status,
      activatedAt: attempt.activatedAt,
      frozenAt: attempt.frozenAt,
      phase: attemptPhaseOf(attempt),
      sourceType: attempt.sourceType,
      practiceWorkflow:
        attemptWorkflowView(db, attempt, now)?.practiceWorkflow ?? null,
      questions: questions.map((question, index) => {
        const row = byId.get(question.id);
        if (!row) return missing();
        return {
          questionNo: index + 1,
          questionId: question.id,
          questionRevisionId: question.questionRevisionId,
          type: question.type,
          stemExcerpt: [...question.stemMd.replace(/\s+/g, " ").trim()]
            .slice(0, 200)
            .join(""),
          state:
            row.submittedAt !== null || attempt.status !== "draft"
              ? "submitted"
              : inkIds.has(question.id) ||
                  !isUnanswered(answerOf(row.answerJson))
                ? "answered"
                : "unanswered",
          settlementSeq: row.settlementSeq,
        };
      }),
    });
    assertStudentMcpPracticeMetadata(data);
    return data;
  });
}

type PreparedQuestion = Omit<
  StudentMcpPracticeQuestionData,
  "imagesIncluded" | "images"
>;

function prepareQuestion(
  db: Db,
  studentId: string,
  input: StudentMcpPracticeQuestionReadInput,
  now: Date,
): PreparedQuestion {
  const { attempt } = requireStudentAiAttempt(db, studentId, input.practiceId);
  const publicQuestions = studentMcpPublicQuestions(db, studentId, attempt.id);
  const byId =
    input.questionId === undefined
      ? undefined
      : publicQuestions.find((question) => question.id === input.questionId);
  if (input.questionId !== undefined && !byId) return missing();
  const numbered =
    input.questionNo === undefined
      ? undefined
      : studentMcpQuestionsInDisplayOrder(
          db,
          studentId,
          attempt,
          publicQuestions,
          now,
        )[input.questionNo - 1];
  const question = byId ?? numbered;
  if (!question) return missing();
  if (
    input.questionNo !== undefined &&
    (!numbered || numbered.id !== question.id)
  )
    throw new HttpError(
      409,
      "QUESTION_LOCATOR_MISMATCH",
      "题目id与显示题序不一致，请重新读取目录",
    );
  requireAiQuestion(db, studentId, attempt.id, question.id);
  const row = questionRow(db, attempt.id, question.id);
  if (row.id !== question.questionRevisionId)
    throw new HttpError(
      409,
      "QUESTION_REVISION_STALE",
      "题目版本已变化，请重新读取",
    );
  const context = contextFromMemoAnchor(
    db,
    studentId,
    {
      kind: "question",
      attemptId: attempt.id,
      questionId: question.id,
      label: "作答",
    },
    now,
    false,
    {
      surface:
        attempt.sourceType === "lesson"
          ? "lesson"
          : attempt.status === "draft"
            ? "attempt"
            : "result",
    },
  );
  if (context?.session == null) return missing();
  assertMemoMetadataBudget({ context });
  // 严格入口先检坏快照，再复用既有单题材料闭包；不扫描完整题快照提图。
  studentAttemptContext(db, attempt.id);
  const snapshot = snapshotOfRow(row);
  if (snapshot === null) return missing();
  const materials = frozenMaterialsForQuestion(
    db,
    attempt.id,
    question.id,
    snapshot,
  );
  return {
    schemaVersion: 1,
    practiceId: attempt.id,
    activatedAt: attempt.activatedAt,
    frozenAt: attempt.frozenAt,
    phase: attemptPhaseOf(attempt),
    questionNo: context.session.questionNo,
    questionCount: context.session.questionCount,
    question,
    materials,
    currentAnswer: answerOf(row.answerJson),
    context,
    practiceWorkflow:
      attemptWorkflowView(db, attempt, now)?.practiceWorkflow ?? null,
    submittedAt: row.submittedAt,
    submission: studentMcpSubmissionParameters(
      db,
      studentId,
      attempt,
      row,
      row.answerRevision,
      now,
    ),
  };
}

/** 版本/答案/head在短同步事务准备，图像文件I/O在事务结束后异步执行。 */
export async function getStudentMcpPracticeQuestion(
  db: Db,
  dataDir: string,
  studentId: string,
  input: StudentMcpPracticeQuestionReadInput,
  isAuthorized: () => boolean,
  now = new Date(),
) {
  const prepared = db.transaction(() =>
    prepareQuestion(db, studentId, input, now),
  );
  const markdowns = [
    ...studentMcpQuestionMarkdowns(prepared.question),
    ...prepared.materials.map((material) => material.contentMd),
  ];
  const imagesIncluded = input.includeImages !== false;
  const budget = {
    ...prepared,
    imagesIncluded,
    images: imagesIncluded
      ? extractMediaImageSrcs(markdowns).map((src) => ({ src }))
      : [],
  };
  assertStudentMcpQuestionMetadata(budget);
  const images = await collectStudentPracticeImages(
    dataDir,
    markdowns,
    imagesIncluded,
    (metadata) =>
      assertStudentMcpQuestionMetadata({ ...budget, images: metadata }),
  );
  // 文件读取期间可能撤权；回到同步门再决定是否交付已准备的内容。
  db.transaction(() => {
    if (!isAuthorized()) throw revokedMcpTokenError();
    const { attempt } = requireAiQuestion(
      db,
      studentId,
      prepared.practiceId,
      prepared.question.id,
    );
    assertStudentMcpFrozenMembers(db, attempt.id);
    const current = contextFromMemoAnchor(
      db,
      studentId,
      {
        kind: "question",
        attemptId: attempt.id,
        questionId: prepared.question.id,
        label: "作答",
      },
      new Date(),
      false,
      {
        surface:
          attempt.sourceType === "lesson"
            ? "lesson"
            : attempt.status === "draft"
              ? "attempt"
              : "result",
      },
    );
    if (current === null) return missing();
    assertMemoMetadataBudget({ context: current });
    if (JSON.stringify(current) !== JSON.stringify(prepared.context))
      throw new HttpError(
        409,
        "LEARNING_CONTEXT_STALE",
        "读取期间来源已变化，请重新读取本题",
      );
  });
  const data = studentMcpPracticeQuestionDataSchema.parse({
    ...prepared,
    imagesIncluded: images.imagesIncluded,
    images: images.images,
  });
  assertStudentMcpQuestionMetadata(data);
  return {
    data,
    content: images.content,
  };
}
