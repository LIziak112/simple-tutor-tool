import { createHash, randomUUID } from "node:crypto";
import type { AttemptDetailData } from "@tutor/contract";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { type Attempt, assignments, responses, units } from "../db/schema";
import {
  attemptEnabledCapabilities,
  attemptSourceMeta,
  attemptSummaryOf,
  attemptTeacherId,
  getAttemptDetail,
  requireUsableAttempt,
} from "./attempt-service";
import { attemptWorkflowView } from "./practice-workflow-wiring";

// 备份恢复换底层连接。旧库的修订号即使重合，也不会命中恢复前的详情。
const connectionVersions = new WeakMap<Db["$client"], string>();

function draftEtag(db: Db, attempt: Attempt, now: Date): string | null {
  // 遗留题序依赖当前题库，限时详情每次携带服务端时钟，讲练使用独立入口。
  if (
    attempt.status !== "draft" ||
    attempt.frozenAt === null ||
    attempt.legacyUnverified ||
    attempt.sourceType === "lesson" ||
    attempt.timeLimitSec !== null ||
    attempt.deadlineAt !== null
  )
    return null;

  const rows = db
    .select({
      id: responses.id,
      unitId: responses.unitId,
      questionId: responses.questionId,
      answerRevision: responses.answerRevision,
      hints: responses.hintsOpenedJson,
      flag: responses.studentFlag,
      submittedAt: responses.submittedAt,
    })
    .from(responses)
    .where(eq(responses.attemptId, attempt.id))
    .orderBy(sql`rowid`)
    .all();
  if (
    rows.length === 0 ||
    (attempt.sourceType !== "wrong" && rows.some((row) => row.unitId === null))
  )
    return null;

  const teacherId = attemptTeacherId(db, attempt);
  const unitIds = [
    ...new Set(rows.flatMap(({ unitId }) => (unitId === null ? [] : [unitId]))),
  ];
  const unitTitles =
    teacherId !== null && unitIds.length > 0
      ? db
          .select({ id: units.id, title: units.title })
          .from(units)
          .where(
            and(eq(units.teacherId, teacherId), inArray(units.id, unitIds)),
          )
          .orderBy(units.id)
          .all()
      : [];
  const assignment =
    attempt.assignmentId === null
      ? undefined
      : db
          .select({ allowRedo: assignments.allowRedo })
          .from(assignments)
          .where(eq(assignments.id, attempt.assignmentId))
          .get();
  const connection = db.$client;
  let generation = connectionVersions.get(connection);
  if (generation === undefined) {
    generation = randomUUID();
    connectionVersions.set(connection, generation);
  }
  // 题目、材料快照随卷冻结。这里读取可变投影的输入，无需装载题干或答案正文。
  const revision = [
    generation,
    attempt.studentId,
    attempt.frozenAt,
    attemptSummaryOf(attempt),
    attemptSourceMeta(db, attempt),
    attemptEnabledCapabilities(db, attempt),
    attemptWorkflowView(db, attempt, now),
    assignment?.allowRedo,
    unitTitles,
    rows,
  ];
  return `W/"${createHash("sha256").update(JSON.stringify(revision)).digest("base64url")}"`;
}

export function readConditionalAttemptDetail(
  db: Db,
  studentId: string,
  attemptId: string,
  ifNoneMatch: string | undefined,
): { etag: string | null; detail: AttemptDetailData | null } {
  return db.$client.transaction(() => {
    const now = new Date();
    const attempt = requireUsableAttempt(db, studentId, attemptId);
    const etag = draftEtag(db, attempt, now);
    return {
      etag,
      detail:
        etag !== null && ifNoneMatch === etag
          ? null
          : getAttemptDetail(db, studentId, attemptId, now),
    };
  })();
}
