import {
  type AnnotationPhase,
  annotationResetVersionSchema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  annotationBases,
  annotations,
  appSettings,
  attempts,
  responses,
} from "../db/schema";
import { HttpError } from "../lib/http-error";

const keyOf = (attemptId: string, phase: AnnotationPhase) =>
  `annotation-reset:${phase}:${attemptId}`;

export function annotationResetVersionOf(
  db: Pick<Db, "select">,
  attemptId: string,
  phase: AnnotationPhase,
): number {
  const row = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, keyOf(attemptId, phase)))
    .get();
  return row ? annotationResetVersionSchema.parse(Number(row.value)) : 0;
}

export function requireAnnotationResetVersion(
  db: Db,
  attemptId: string,
  phase: AnnotationPhase,
  version = 0,
) {
  if (version !== annotationResetVersionOf(db, attemptId, phase))
    throw new HttpError(
      409,
      "ANNOTATION_RESET_REQUIRED",
      "标画已重置，请重新读取后再圈画",
    );
}

/** 仅供停服、完整备份后的维护 CLI 调用；不删除原文件，保留备份引用。 */
export function resetDraftAttemptAnnotations(
  db: Db,
  attemptId: string,
  expected: { expectedBases: number; expectedStrokes: number },
) {
  return db.transaction((tx) => {
    const attempt = tx
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    if (attempt?.status !== "draft")
      throw new Error("仅允许重置未交卷作答的标画");
    const rows = tx
      .select()
      .from(responses)
      .where(eq(responses.attemptId, attemptId))
      .all();
    if (rows.some((row) => row.submittedAt !== null))
      throw new Error("含已提交题目，禁止重置");
    const bodies = tx
      .select()
      .from(annotations)
      .where(
        and(
          eq(annotations.attemptId, attemptId),
          eq(annotations.phase, "scratch"),
        ),
      )
      .all();
    if (bodies.some((row) => row.sealedAt !== null))
      throw new Error("含封存标画，禁止重置");
    const bases = tx
      .select()
      .from(annotationBases)
      .where(
        and(
          eq(annotationBases.attemptId, attemptId),
          eq(annotationBases.phase, "scratch"),
        ),
      )
      .all();
    const strokeCount = bodies.reduce((sum, row) => sum + row.strokeCount, 0);
    if (
      bases.length !== expected.expectedBases ||
      strokeCount !== expected.expectedStrokes
    )
      throw new Error(
        `标画范围已变化：${bases.length} 份底图、${strokeCount} 笔；请重新盘点`,
      );
    const resetVersion = Math.max(
      Date.now(),
      annotationResetVersionOf(tx, attemptId, "scratch") + 1,
    );
    tx.delete(annotations)
      .where(
        and(
          eq(annotations.attemptId, attemptId),
          eq(annotations.phase, "scratch"),
        ),
      )
      .run();
    tx.delete(annotationBases)
      .where(
        and(
          eq(annotationBases.attemptId, attemptId),
          eq(annotationBases.phase, "scratch"),
        ),
      )
      .run();
    tx.insert(appSettings)
      .values({ key: keyOf(attemptId, "scratch"), value: String(resetVersion) })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: String(resetVersion) },
      })
      .run();
    return { baseCount: bases.length, strokeCount, resetVersion };
  });
}
