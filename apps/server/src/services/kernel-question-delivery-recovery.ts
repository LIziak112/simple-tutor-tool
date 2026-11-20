import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Attempt,
  attempts,
  type InkRow,
  type ResponseRow,
} from "../db/schema.ts";
import { kernelQuestionDeliveries } from "../db/schema-kernel-question-delivery.ts";
import { canonicalJsonOf } from "../lib/canonical-json.ts";
import { attemptResponseRows } from "./attempt-freeze.ts";
import {
  assertFormalInkAnchor,
  needsFormalInkAnchor,
} from "./formal-ink-attachment.ts";
import {
  type KernelRuntime,
  kernelAttemptUnavailable,
  withKernelRuntime,
} from "./kernel-assignment-runtime.ts";
import {
  type MarkIntent,
  projectDeliveryVerdicts,
  type ReviewedQuestion,
} from "./kernel-delivery-verdicts.ts";
import {
  deliveryPolicy,
  type QuestionDeliveryActivity,
  type QuestionDeliveryBinding,
  questionDeliveryBinding,
  readBoundQuestionDelivery,
} from "./kernel-question-delivery-binding.ts";
import {
  projectDeliveryCompletion,
  projectDeliveryRows,
} from "./kernel-question-delivery-projection.ts";
import { deliverySlotId } from "./kernel-question-delivery-publication.ts";
import {
  type DeliveryTicket,
  deliveryTickets,
  ticketFilter,
} from "./kernel-question-delivery-ticket.ts";
import { deliveryAnswerOf } from "./kernel-question-delivery-values.ts";

export const actorOf = (attempt: Attempt) =>
  ({ role: "student", id: attempt.studentId }) as const;
export const keyOf = ({ operationId, stepAttemptId }: DeliveryTicket) =>
  ({ protocolVersion: 1, operationId, stepAttemptId }) as const;

export type DeliveryFacts = {
  attempt: Attempt;
  rows: ResponseRow[];
  reviews?: Map<string, ReviewedQuestion>;
};
type Activate = (ticket: DeliveryTicket) => void;

export function withDelivery<T>(
  db: Db,
  dataDir: string,
  attempt: Attempt,
  run: (
    runtime: KernelRuntime,
    binding: QuestionDeliveryBinding,
    view: QuestionDeliveryActivity,
    activate: Activate,
  ) => T,
  attachmentDir = dataDir,
): T | undefined {
  const binding = questionDeliveryBinding(db, attempt);
  if (!binding) return undefined;
  let current: DeliveryTicket | undefined;
  const permits = (input: {
    studentId: string;
    activityId: string;
    stepAttemptId: string;
    operationId: string;
  }) =>
    input.studentId === attempt.studentId &&
    input.activityId === attempt.id &&
    input.stepAttemptId === binding.stepAttemptId &&
    input.operationId === current?.operationId;
  return withKernelRuntime(
    db,
    dataDir,
    false,
    (runtime) => {
      const view = readBoundQuestionDelivery(db, runtime, attempt, binding);
      return (
        view &&
        run(runtime, binding, view, (ticket) => {
          for (const anchor of ticket.intent.formalInk ?? [])
            assertFormalInkAnchor(db, attachmentDir, attempt.id, anchor);
          current = ticket;
        })
      );
    },
    {
      authorizeConfirmationRecovery: permits,
      evaluateScope: () =>
        current && {
          attemptId: attempt.id,
          studentId: attempt.studentId,
          assignmentId: binding.practiceId,
          ...(binding.lectureId && { lectureId: binding.lectureId }),
          practiceVersion: binding.practiceVersion,
          stepAttemptId: binding.stepAttemptId,
          slotId: current.slotId,
          questionRevisions: new Map(
            current.intent.revisions.map((item) => [
              item.questionId,
              item.questionRevisionId,
            ]),
          ),
        },
      verifyOriginal(input) {
        const expected = current?.intent.questions.find(
          (item) => item.questionId === input.questionId,
        );
        return (
          permits(input) &&
          input.slotId === current?.slotId &&
          current.intent.selectedQuestionIds.includes(input.questionId) &&
          expected?.questionVersion === input.questionVersion &&
          canonicalJsonOf(expected.original) === canonicalJsonOf(input.original)
        );
      },
    },
  );
}

/** 读取权威完成状态，宿主投影中断时仍可在写锁内拦住笔迹更新。 */
export function wholeDeliveryInkLocked(
  db: Db,
  dataDir: string,
  attempt: Attempt,
): boolean {
  return (
    attempt.sourceType === "assignment" &&
    withDelivery(
      db,
      dataDir,
      attempt,
      (_runtime, _binding, view) => view.status === "completed",
    ) === true
  );
}

/** 本人或所属教师已通过入口校验。固定原件必须按实际文件核对。 */
export function assertDeliveredInk(db: Db, dataDir: string, row: InkRow): void {
  for (const ticket of deliveryTickets(db, row.attemptId)) {
    const anchor = ticket.intent.formalInk?.find(
      ({ questionId }) => questionId === row.questionId,
    );
    if (!anchor) continue;
    if (ticket.receiptId === null) {
      const attempt = db
        .select()
        .from(attempts)
        .where(eq(attempts.id, row.attemptId))
        .get();
      if (!attempt || !wholeDeliveryInkLocked(db, dataDir, attempt)) continue;
    }
    assertFormalInkAnchor(db, dataDir, row.attemptId, anchor);
  }
}

function validPlacement(
  ticket: DeliveryTicket,
  policy: ReturnType<typeof deliveryPolicy>,
  rows: ReadonlyMap<string, ResponseRow>,
) {
  const { source, selectedQuestionIds, questions } = ticket.intent;
  if (
    selectedQuestionIds.some((id) => !rows.has(id)) ||
    questions.some(
      (q) => rows.get(q.questionId)?.questionVersion !== q.questionVersion,
    )
  )
    return false;
  if (policy.mode === "whole") {
    const required = new Set(
      [...rows.values()]
        .filter(needsFormalInkAnchor)
        .map(({ questionId }) => questionId),
    );
    const anchors = ticket.intent.formalInk ?? [];
    return (
      anchors.length === required.size &&
      anchors.every(({ questionId }) => required.delete(questionId)) &&
      source === "whole" &&
      ticket.slotId === deliverySlotId &&
      selectedQuestionIds.length === rows.size
    );
  }
  if (source === "finish")
    return ticket.slotId === deliverySlotId && questions.length === rows.size;
  const [question] = selectedQuestionIds;
  return (
    source === "question" &&
    selectedQuestionIds.length === 1 &&
    question !== undefined &&
    questions.length === 1 &&
    questions[0]?.questionId === question &&
    Object.hasOwn(policy.questionSlots, question) &&
    policy.questionSlots[question] === ticket.slotId
  );
}

export function recoverDeliveries(
  db: Db,
  dataDir: string,
  runtime: KernelRuntime,
  attempt: Attempt,
  binding: QuestionDeliveryBinding,
  view: QuestionDeliveryActivity,
  activate: Activate,
  markIntent?: MarkIntent,
): DeliveryFacts {
  const rows = new Map(
    attemptResponseRows(db, attempt.id).map((row) => [row.questionId, row]),
  );
  const tickets = deliveryTickets(db, attempt.id);
  const policy = deliveryPolicy(view);
  const receipts = new Map(
    view.questionDeliveries.map((item) => [item.receipt?.slotId, item.receipt]),
  );
  if (
    receipts.size !== view.questionDeliveries.length ||
    receipts.has(undefined) ||
    tickets.some(
      (ticket) =>
        ticket.stepAttemptId !== binding.stepAttemptId ||
        ticket.practiceVersion !== binding.practiceVersion ||
        !validPlacement(ticket, policy, rows) ||
        (ticket.receiptId !== null &&
          ticket.receiptId !== receipts.get(ticket.slotId)?.id),
    )
  )
    kernelAttemptUnavailable();

  const confirmed = new Set<string>();
  const reviewedTickets: DeliveryTicket[] = [];
  let confirmedAt: string | undefined;
  for (const [slot, receipt] of receipts) {
    const ticket = tickets.find((candidate) => candidate.slotId === slot);
    if (!ticket || !receipt || receipt.stepAttemptId !== binding.stepAttemptId)
      kernelAttemptUnavailable();
    activate(ticket);
    const recovery = runtime.recoverQuestionDelivery(
      actorOf(attempt),
      attempt.id,
      keyOf(ticket),
    );
    if (
      recovery.receipt.id !== receipt.id ||
      recovery.confirmation.source !== ticket.intent.source ||
      recovery.practice.id !== binding.practiceId ||
      recovery.practice.version !== binding.practiceVersion
    )
      kernelAttemptUnavailable();
    const selected = ticket.intent.selectedQuestionIds.map((id) => {
      const row = rows.get(id);
      if (!row || confirmed.has(id)) kernelAttemptUnavailable();
      confirmed.add(id);
      return row;
    });
    for (const row of projectDeliveryRows(
      db,
      attempt,
      ticket,
      recovery,
      selected,
    ))
      rows.set(row.questionId, row);
    if (ticket.receiptId === null)
      db.update(kernelQuestionDeliveries)
        .set({ receiptId: receipt.id })
        .where(ticketFilter(ticket))
        .run();
    if (policy.mode === "perQuestion")
      reviewedTickets.push({ ...ticket, receiptId: receipt.id });
    if (!confirmedAt || receipt.confirmedAt > confirmedAt)
      confirmedAt = receipt.confirmedAt;
  }

  for (const draft of view.questionDeliveryDrafts) {
    const row = rows.get(draft.questionId);
    if (
      !row ||
      draft.questionVersion !== row.questionVersion ||
      confirmed.has(draft.questionId)
    )
      kernelAttemptUnavailable();
    rows.set(row.questionId, {
      ...row,
      answerJson: JSON.stringify(deliveryAnswerOf(row, draft.value)),
      answerRevision: draft.revision,
      changeCount: draft.changeCount,
    });
  }
  const baseline = { attempt, rows: [...rows.values()] };
  const reviewed = reviewedTickets.length
    ? projectDeliveryVerdicts(
        db,
        dataDir,
        baseline,
        binding.practiceId,
        reviewedTickets,
        markIntent,
      )
    : undefined;
  const facts = reviewed ?? baseline;
  if (view.status === "completed") {
    if (!confirmedAt || confirmed.size !== rows.size)
      kernelAttemptUnavailable();
    const verdictsChanged =
      reviewed &&
      [...reviewed.reviews.values()].some(
        ({ verdict }) => verdict.revision > 0,
      );
    return {
      ...facts,
      ...projectDeliveryCompletion(
        db,
        attempt,
        facts.rows,
        confirmedAt,
        verdictsChanged,
      ),
    };
  }
  if (
    attempt.status !== "draft" ||
    facts.rows.some(
      (row) => row.submittedAt !== null && !confirmed.has(row.questionId),
    )
  )
    kernelAttemptUnavailable();
  return facts;
}

export function readQuestionDeliveryFacts(
  db: Db,
  dataDir: string,
  attempt: Attempt,
  attachmentDir = dataDir,
  markIntent?: MarkIntent,
): DeliveryFacts | undefined {
  return db.$client
    .transaction(() => {
      const facts = withDelivery(
        db,
        dataDir,
        attempt,
        (runtime, binding, view, activate) =>
          recoverDeliveries(
            db,
            dataDir,
            runtime,
            attempt,
            binding,
            view,
            activate,
            markIntent,
          ),
        attachmentDir,
      );
      if (
        !facts ||
        attempt.sourceType !== "assignment" ||
        facts.attempt.status === "draft"
      )
        return facts;
      const [ticket, ...others] = deliveryTickets(db, attempt.id);
      if (
        !attempt.assignmentId ||
        !ticket?.receiptId ||
        others.length ||
        ticket.intent.source !== "whole"
      )
        kernelAttemptUnavailable();
      return projectDeliveryVerdicts(
        db,
        dataDir,
        facts,
        attempt.assignmentId,
        [ticket],
        markIntent,
      );
    })
    .immediate();
}
