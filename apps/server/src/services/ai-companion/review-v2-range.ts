import { createHmac } from "node:crypto";
import {
  AI_ATTEMPT_REVIEW_CONTEXT_MAX_BYTES,
  AI_ATTEMPT_REVIEW_MAX_QUESTIONS,
  effectiveVerdictOf,
  formatQuestionAnswers,
  lessonQuestionIdsInDisplayOrder,
  optionsPublicStructureOf,
  type ReviewV2Create,
  type ReviewV2Question,
  type ReviewV2Scope,
  type ReviewV2Snapshot,
  reviewV2SnapshotSchema,
  studentReviewFact,
} from "@tutor/contract";
import { mathifyAiReferenceAnswer, splitLessonBlocks } from "@tutor/md-dsl";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { units } from "../../db/schema.ts";
import { canonicalJsonOf } from "../../lib/canonical-json.ts";
import { HttpError } from "../../lib/http-error.ts";
import { listAttemptContextSnapshots } from "../attempt-context-repository.ts";
import { getStudentSettlement } from "../attempt-partial.ts";
import { frozenMaterialsFromRows } from "../attempt-question-materials.ts";
import { resultQuestionOf } from "../attempt-question-projection.ts";
import {
  answerOf,
  frozenRowsInDisplayOrder,
  getStudentAttemptPaper,
  materialSlotOrderOf,
  selfReviewRecordOf,
  structuresOfSnapshot,
} from "../attempt-service.ts";
import { timeProjectionsOf } from "../attempt-time-projection.ts";
import { reviewEvidenceReader } from "../review-evidence.ts";
import { rubricReviewOf } from "../rubric-review-read.ts";
import { snapshotOfRow } from "../snapshot.ts";
import { requireVisibleStudentLecture } from "../student-course-service.ts";
import { sqliteAiPolicyConfigSource } from "./ai-policy-config-source.ts";
import { attemptAnswersReleased } from "./student-ai-batch.ts";
import { missingNoteOf, studentAnswerTextOf } from "./student-ai-context.ts";
import {
  requireStudentAiAttempt,
  resolveAttemptQuestionAiPolicy,
} from "./teaching-policy-service.ts";

export interface ReviewV2Options {
  hmacSecret: string;
  now?: Date;
}
export function reviewV2Version(value: unknown, secret: string): string {
  return createHmac("sha256", secret)
    .update(canonicalJsonOf(value))
    .digest("hex");
}
export function assertReviewV2Bytes(value: unknown) {
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") >
    AI_ATTEMPT_REVIEW_CONTEXT_MAX_BYTES
  )
    throw new HttpError(
      409,
      "AI_REVIEW_CONTEXT_LIMIT",
      "单片内容超过复盘容量，请缩小范围或精简材料",
    );
}
/** 范围与授权是白名单；批次/阶段不得借全卷材料或未交题扩展范围。 */
export function reviewV2Range(
  db: Db,
  studentId: string,
  attemptId: string,
  scope: ReviewV2Scope,
  options: ReviewV2Options,
) {
  const { attempt, teacherId } = requireStudentAiAttempt(
    db,
    studentId,
    attemptId,
  );
  let entries = frozenRowsInDisplayOrder(db, attempt);
  if (attempt.sourceType === "lesson") {
    if (attempt.lectureId === null)
      throw new HttpError(409, "AI_REVIEW_BROKEN", "讲练来源不完整");
    const { lecture } = requireVisibleStudentLecture(
      db,
      studentId,
      attempt.lectureId,
      attempt.courseId ?? undefined,
      options.now,
    );
    const paperIds = getStudentAttemptPaper(
      db,
      studentId,
      attempt.id,
    ).units.flatMap((unit) => unit.questions.map((q) => q.id));
    const ids = lessonQuestionIdsInDisplayOrder(
      splitLessonBlocks(lecture.markdown),
      paperIds,
    );
    const byId = new Map(entries.map((entry) => [entry.row.questionId, entry]));
    entries = ids.map((id) => {
      const entry = byId.get(id);
      if (!entry)
        throw new HttpError(409, "AI_REVIEW_BROKEN", "讲练题目数据不完整");
      return entry;
    });
  }
  const all = entries.map((entry, index) => ({
    ...entry,
    questionNo: index + 1,
  }));
  if (scope.kind === "settlement") {
    if (
      !getStudentSettlement(db, studentId, attemptId, scope.seq).answersReleased
    )
      throw new HttpError(403, "AI_REVIEW_NOT_RELEASED", "本批答案尚未公布");
  } else if (scope.kind === "lesson_stage") {
    if (attempt.sourceType !== "lesson" || scope.throughQuestionNo > all.length)
      throw new HttpError(400, "AI_REVIEW_SCOPE_INVALID", "讲练阶段范围不合法");
  } else if (
    attempt.status === "draft" ||
    !attemptAnswersReleased(db, attempt)
  ) {
    throw new HttpError(
      403,
      "AI_REVIEW_NOT_RELEASED",
      "交卷且答案公布后才能复盘此范围",
    );
  }
  const selected = all.filter((entry) => {
    if (scope.kind === "settlement")
      return entry.row.settlementSeq === scope.seq;
    if (scope.kind === "unit")
      return (entry.unitId ?? entry.row.unitId) === scope.unitId;
    if (scope.kind === "lesson_stage")
      return entry.questionNo <= scope.throughQuestionNo;
    return true;
  });
  if (selected.length === 0)
    throw new HttpError(404, "AI_REVIEW_SCOPE_EMPTY", "所选复盘范围不存在");
  for (const entry of selected) {
    if (attempt.status === "draft" && entry.row.submittedAt === null)
      throw new HttpError(
        403,
        "AI_REVIEW_NOT_SUBMITTED",
        "阶段中仍有未提交题目",
      );
    if (snapshotOfRow(entry.row) === null)
      throw new HttpError(
        409,
        "AI_REVIEW_BROKEN",
        "题目冻结数据不完整，无法复盘",
      );
    const { resolution } = resolveAttemptQuestionAiPolicy(
      db,
      studentId,
      attemptId,
      entry.row.questionId,
      sqliteAiPolicyConfigSource,
    );
    if (!resolution.usable || resolution.mode === undefined)
      throw new HttpError(
        403,
        "AI_POLICY_DISABLED",
        "所选范围的AI复盘当前不可用",
      );
  }
  return { attempt, selected, teacherId };
}

export function buildReviewV2Plan(
  db: Db,
  studentId: string,
  attemptId: string,
  input: Pick<ReviewV2Create, "scope" | "profile" | "purpose">,
  options: ReviewV2Options,
) {
  const scopeInput = {
    scope: input.scope,
    profile: input.profile,
    purpose: input.purpose,
  };
  const { selected, teacherId } = reviewV2Range(
    db,
    studentId,
    attemptId,
    input.scope,
    options,
  );
  const frozenContext = listAttemptContextSnapshots(db, attemptId);
  const slots = materialSlotOrderOf(db, attemptId);
  const times = timeProjectionsOf(db, [attemptId]);
  const evidence = reviewEvidenceReader(db, attemptId, studentId);
  const unitIds = [
    ...new Set(
      selected.flatMap((entry) =>
        entry.unitId === null ? [] : [entry.unitId],
      ),
    ),
  ];
  const unitTitles = new Map(
    unitIds.length === 0
      ? []
      : db
          .select({ id: units.id, title: units.title })
          .from(units)
          .where(
            and(eq(units.teacherId, teacherId), inArray(units.id, unitIds)),
          )
          .all()
          .map((unit) => [unit.id, unit.title] as const),
  );
  const materialByQuestion = new Map<
    string,
    { id: string; title: string; bodyMd: string }[]
  >();
  const questions: ReviewV2Question[] = selected.map(
    ({ row, questionNo, unitId }) => {
      const question = snapshotOfRow(row);
      if (!question)
        throw new HttpError(409, "AI_REVIEW_BROKEN", "题目冻结数据不完整");
      const selfReview = selfReviewRecordOf(row);
      const effective = effectiveVerdictOf(
        row.autoCorrect,
        row.teacherMark === "correct" || row.teacherMark === "wrong"
          ? row.teacherMark
          : null,
        selfReview,
      );
      const gradingState =
        effective === null
          ? "pending"
          : effective.value
            ? "correct"
            : "incorrect";
      const materials = frozenMaterialsFromRows(
        frozenContext,
        row.questionId,
        question,
        { versionBadge: true },
      );
      materialByQuestion.set(
        row.questionId,
        materials.map((material) => ({
          id: `${material.id}@${material.sourceVersion}`,
          title: material.title,
          bodyMd: material.contentMd,
        })),
      );
      const result = resultQuestionOf(row, question, {
        db,
        materialSlots: slots,
        time: times.responseTime.get(row.id),
      });
      const fact = studentReviewFact(
        {
          ...result,
          ...evidence(
            row.questionId,
            (question.materialRefs ?? []).map((ref) => ref.material),
          ),
        },
        {
          id: unitId ?? "",
          title:
            unitId === null
              ? "本次练习"
              : (unitTitles.get(unitId) ?? "练习单元"),
        },
        true,
      );
      return {
        fact,
        questionNo,
        questionId: row.questionId,
        questionRevisionId: row.id,
        questionType: question.type,
        stemMd: question.stemMd,
        options: (question.options ?? []).map((option) => ({
          text: option.text,
        })),
        knowledgePoints: question.knowledge,
        difficulty: question.difficulty,
        studentAnswerText: studentAnswerTextOf(
          optionsPublicStructureOf(
            (question.options ?? []).map((option) => option.text),
          ),
          answerOf(row.answerJson),
          structuresOfSnapshot(question, slots, row.unitId),
        ),
        referenceAnswerMd:
          question.answers === undefined
            ? null
            : formatQuestionAnswers(question.answers, {
                mathify: mathifyAiReferenceAnswer,
              }),
        solutionMd: question.solutionMd ?? null,
        missingNote: missingNoteOf(question.answers, question.solutionMd),
        answerState: row.answered ? "answered" : "unanswered",
        gradingState,
        displayStatus:
          gradingState !== "pending"
            ? gradingState
            : row.answered
              ? "pending"
              : "unanswered",
        hasFormalInk: row.inkId !== null,
        activeSec: fact.activeSec,
        time: times.responseTime.get(row.id),
        notes: row.inkId !== null ? ["笔迹图像未包含，不能推断书写过程"] : [],
        unitId: unitId ?? row.unitId,
        settlementSeq: row.settlementSeq,
        selfReview,
        rubricReview: rubricReviewOf(db, row, question),
      };
    },
  );
  const previewVersion = reviewV2Version(
    { attemptId, ...scopeInput, questions, materials: [...materialByQuestion] },
    options.hmacSecret,
  );
  const capturedAt = (options.now ?? new Date()).toISOString();
  function makeSnapshot(part: ReviewV2Question[]) {
    const materials = new Map<
      string,
      { id: string; title: string; bodyMd: string }
    >();
    for (const question of part)
      for (const material of materialByQuestion.get(question.questionId) ?? [])
        materials.set(material.id, material);
    return reviewV2SnapshotSchema.parse({
      schemaVersion: 2,
      kind: "questions",
      attemptId,
      ...scopeInput,
      snapshotVersion: reviewV2Version(
        {
          previewVersion,
          questionNos: part.map((question) => question.questionNo),
        },
        options.hmacSecret,
      ),
      capturedAt,
      questions: part,
      materials: [...materials.values()],
      notes: ["本次快照仅含所选范围；量表不折算成对错，缺失用时不代表0。"],
    });
  }
  const snapshots: ReviewV2Snapshot[] = [];
  let part: ReviewV2Question[] = [];
  for (const question of questions) {
    const previous = part.at(-1);
    const boundary =
      previous !== undefined &&
      (previous.unitId !== question.unitId ||
        previous.settlementSeq !== question.settlementSeq);
    if (
      part.length > 0 &&
      (boundary || part.length >= AI_ATTEMPT_REVIEW_MAX_QUESTIONS)
    ) {
      snapshots.push(makeSnapshot(part));
      part = [];
    }
    part.push(question);
    try {
      assertReviewV2Bytes(makeSnapshot(part));
    } catch (error) {
      if (part.length === 1) throw error;
      const last = part.pop()!;
      snapshots.push(makeSnapshot(part));
      part = [last];
      assertReviewV2Bytes(makeSnapshot(part));
    }
  }
  if (part.length > 0) snapshots.push(makeSnapshot(part));
  for (const snapshot of snapshots) assertReviewV2Bytes(snapshot);
  return { previewVersion, questionCount: questions.length, snapshots };
}
