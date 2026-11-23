import { kernelQuestionDeliveryIntentSchema } from "@tutor/contract/kernel-question-delivery";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { kernelQuestionDeliveries } from "../db/schema-kernel-question-delivery.ts";
import { kernelAttemptUnavailable } from "./kernel-assignment-runtime.ts";

export type DeliveryTicket = typeof kernelQuestionDeliveries.$inferSelect;

export function deliveryTickets(db: Db, attemptId: string): DeliveryTicket[] {
  return db
    .select()
    .from(kernelQuestionDeliveries)
    .where(eq(kernelQuestionDeliveries.attemptId, attemptId))
    .all()
    .map((row) => {
      const intent = kernelQuestionDeliveryIntentSchema.safeParse(row.intent);
      if (!intent.success) kernelAttemptUnavailable();
      return { ...row, intent: intent.data };
    });
}

export function ticketFilter(ticket: DeliveryTicket) {
  return and(
    eq(kernelQuestionDeliveries.attemptId, ticket.attemptId),
    eq(kernelQuestionDeliveries.stepAttemptId, ticket.stepAttemptId),
    eq(kernelQuestionDeliveries.slotId, ticket.slotId),
    eq(kernelQuestionDeliveries.operationId, ticket.operationId),
  );
}
