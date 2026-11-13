import { and, eq, gt, inArray, isNull, type SQL } from "drizzle-orm";
import { aiShareTickets, aiTasks } from "../../db/schema.ts";
import type { QueueTx } from "./student-ai-shared.ts";

function revokeActiveTickets(tx: QueueTx, scope: SQL, now: string): number {
  return tx
    .update(aiShareTickets)
    .set({ revokedAt: now })
    .where(
      and(
        scope,
        isNull(aiShareTickets.revokedAt),
        gt(aiShareTickets.expiresAt, now),
      ),
    )
    .run().changes;
}

export function revokeTaskShareTickets(
  tx: QueueTx,
  taskId: string,
  now: string,
): number {
  return revokeActiveTickets(tx, eq(aiShareTickets.taskId, taskId), now);
}

/** 删除链接连接时，同事务撤销这位学生仍有效的链接票据。 */
export function revokeStudentShareTickets(
  tx: QueueTx,
  studentId: string,
  now: string,
): void {
  const studentTasks = tx
    .select({ id: aiTasks.id })
    .from(aiTasks)
    .where(eq(aiTasks.studentId, studentId));
  revokeActiveTickets(tx, inArray(aiShareTickets.taskId, studentTasks), now);
}
