import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { attempts } from "../db/schema.ts";
import {
  type kernelCourseOpenings,
  type kernelLessonOpenings,
  kernelQuestionDeliveries,
} from "../db/schema-kernel-question-delivery.ts";
import { ZipReadError } from "../lib/zip-read.ts";
import { withKernelRuntime } from "./kernel-assignment-runtime.ts";
import { replayKernelCourseOpening } from "./kernel-course-opening.ts";
import { replayKernelLessonOpening } from "./kernel-lesson-opening.ts";
import { readQuestionDeliveryFacts } from "./kernel-question-delivery.ts";

type Opening =
  | typeof kernelLessonOpenings.$inferSelect
  | typeof kernelCourseOpenings.$inferSelect;

export function verifyBackupQuestionDeliveries(
  db: Db,
  directory: string,
  openings: readonly Opening[],
  attachmentDir: string,
) {
  try {
    const verified = new Set<string>();
    for (const opening of openings) {
      if (opening.attemptId === null) {
        withKernelRuntime(db, directory, false, (runtime) =>
          "lectureId" in opening
            ? replayKernelLessonOpening(runtime, opening)
            : replayKernelCourseOpening(runtime, opening),
        );
        continue;
      }
      const attempt = db
        .select()
        .from(attempts)
        .where(eq(attempts.id, opening.attemptId))
        .get();
      if (
        !attempt ||
        attempt.sourceType !== ("lectureId" in opening ? "lesson" : "course") ||
        !readQuestionDeliveryFacts(db, directory, attempt, attachmentDir)
      )
        throw new Error("题组开卷绑定缺失");
      verified.add(attempt.id);
    }
    const tickets = db
      .selectDistinct({ attemptId: kernelQuestionDeliveries.attemptId })
      .from(kernelQuestionDeliveries)
      .all();
    for (const ticket of tickets) {
      if (verified.has(ticket.attemptId)) continue;
      const attempt = db
        .select()
        .from(attempts)
        .where(eq(attempts.id, ticket.attemptId))
        .get();
      if (
        !attempt ||
        !readQuestionDeliveryFacts(db, directory, attempt, attachmentDir)
      )
        throw new Error("交付票据缺少匹配绑定");
    }
  } catch {
    throw new ZipReadError("备份中的内核交付与宿主开卷绑定不一致");
  }
}
