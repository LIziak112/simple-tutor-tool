import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Attempt,
  attemptContextFreezes,
  attemptContextSnapshots,
  attempts,
  responses,
} from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { touchAttemptActivity } from "./attempt-activity.ts";
import {
  contextEntriesOf,
  liveAttemptContextClosure,
} from "./attempt-context.ts";
import {
  attemptResponseRows,
  freezeInputsOfNewAttempt,
  insertFrozenResponses,
} from "./attempt-freeze.ts";
import { discardOpenedArtifactsWithin } from "./attempt-opened-artifacts.ts";
import { hasSubstantiveAttemptEvidence } from "./attempt-substantive-evidence.ts";
import {
  freezeAttemptContextSnapshotsWithin,
  listAttemptContextSnapshots,
} from "./material-repository.ts";
import { studentSelfReviewEnabledOf } from "./practice-feedback-settings-service.ts";

/** 仅入口恢复时调用；任何已激活卷和正式写入都不重新冻结。 */
export function refreshOpenedAttempt(db: Db, attempt: Attempt): Attempt {
  return db.transaction(
    (tx) => {
      const fresh = tx
        .select()
        .from(attempts)
        .where(eq(attempts.id, attempt.id))
        .get();
      if (!fresh)
        throw new HttpError(
          404,
          "ATTEMPT_NOT_FOUND",
          "作答记录不存在，请从练习入口重新进入",
        );
      if (
        fresh.status !== "draft" ||
        fresh.activatedAt !== null ||
        fresh.abandonedAt !== null ||
        fresh.frozenAt === null ||
        fresh.legacyUnverified ||
        fresh.sourceType === "wrong"
      )
        return fresh;
      // 历史漏回填或旁路写入的证据优先保留，绝不删除实质作答。
      if (hasSubstantiveAttemptEvidence(db, fresh.id)) {
        touchAttemptActivity(tx, fresh.id, fresh.startedAt);
        return (
          tx.select().from(attempts).where(eq(attempts.id, fresh.id)).get() ??
          fresh
        );
      }
      const { liveRows, teacherId, knowledgeByQuestion } =
        freezeInputsOfNewAttempt(db, fresh);
      const entries =
        teacherId === null
          ? []
          : contextEntriesOf(
              liveAttemptContextClosure(
                db,
                teacherId,
                liveRows.map((row) => row.id),
              ),
            );
      const frozen = attemptResponseRows(db, fresh.id);
      const context = listAttemptContextSnapshots(db, fresh.id);
      const key = (row: {
        kind: string;
        sourceId: string;
        sourceVersion: number;
      }) => `${row.kind}:${row.sourceId}:${row.sourceVersion}`;
      const sameQuestions =
        frozen.length === liveRows.length &&
        frozen.every(
          (row, i) =>
            row.questionId === liveRows[i]?.id &&
            row.questionVersion === liveRows[i]?.version &&
            row.unitId === liveRows[i]?.unitId,
        );
      const sameContext =
        JSON.stringify(context.map(key).sort()) ===
        JSON.stringify(entries.map(key).sort());
      if (sameQuestions && sameContext) return fresh;
      // 删除空快照时没有证据引用；先移除冻结标记再重建，沿用原有归属触发器。
      discardOpenedArtifactsWithin(tx, fresh.id);
      tx.delete(attemptContextFreezes)
        .where(eq(attemptContextFreezes.attemptId, fresh.id))
        .run();
      tx.delete(attemptContextSnapshots)
        .where(eq(attemptContextSnapshots.attemptId, fresh.id))
        .run();
      tx.delete(responses).where(eq(responses.attemptId, fresh.id)).run();
      const frozenAt = new Date(
        Math.max(Date.now(), Date.parse(fresh.frozenAt ?? fresh.startedAt) + 1),
      ).toISOString();
      tx.update(attempts)
        .set({ frozenAt, legacyUnverified: false })
        .where(eq(attempts.id, fresh.id))
        .run();
      insertFrozenResponses(
        tx,
        fresh.id,
        liveRows,
        knowledgeByQuestion,
        studentSelfReviewEnabledOf(db, teacherId),
      );
      freezeAttemptContextSnapshotsWithin(tx, fresh.id, entries, frozenAt);
      return (
        tx.select().from(attempts).where(eq(attempts.id, fresh.id)).get() ??
        fresh
      );
    },
    { behavior: "immediate" },
  );
}
