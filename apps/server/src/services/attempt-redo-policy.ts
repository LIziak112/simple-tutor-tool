import type { AttemptStartData } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { type Attempt, assignments } from "../db/schema";

/** 详情与条件版本共用当前作业的重做权限。只有作业来源携带此字段。 */
export function attemptAllowRedo(
  db: Db,
  attempt: Pick<Attempt, "sourceType" | "assignmentId">,
): boolean | undefined {
  if (attempt.sourceType !== "assignment" || attempt.assignmentId === null)
    return undefined;
  const row = db
    .select({ allowRedo: assignments.allowRedo })
    .from(assignments)
    .where(eq(assignments.id, attempt.assignmentId))
    .get();
  return row?.allowRedo ?? true;
}

/** 作业开卷摘要补 allowRedo（hall-15313）——作业行在手，零额外查询 */
export function withAllowRedo(
  data: AttemptStartData,
  allowRedo: boolean,
): AttemptStartData {
  if (data.sourceType !== "assignment") return data;
  return { ...data, allowRedo };
}
