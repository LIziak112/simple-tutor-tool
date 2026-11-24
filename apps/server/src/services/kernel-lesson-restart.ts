import { and, eq } from "drizzle-orm";
import { LearningError, type PublicationInput } from "learning-kernel";
import type { Db } from "../db/client.ts";
import { kernelLessonOpenings } from "../db/schema-kernel-question-delivery.ts";
import { HttpError } from "../lib/http-error.ts";
import type { KernelRuntime } from "./kernel-assignment-runtime.ts";
import { kernelAttemptUnavailable } from "./kernel-assignment-runtime.ts";

type Opening = typeof kernelLessonOpenings.$inferSelect;
type Actor = { role: "student"; id: string };

/**
 * 讲练每一轮都声明学生随时重开（G46）：重开由内核 restart 开新一轮并放弃
 * 进行中的上一轮，新一轮是同一练法的下一版本（按当前 live 题重新冻结）。
 */
export function withStudentRestart<P extends PublicationInput>(
  publication: P,
): P {
  const { practice } = publication;
  if (!("policy" in practice)) return publication;
  const { student } = practice.policy;
  return {
    ...publication,
    practice: {
      ...practice,
      policy: {
        ...practice.policy,
        student: { ...student, restart: "anytime" },
      },
    },
  };
}

function declaresRestart({ practice }: PublicationInput) {
  return "policy" in practice && practice.policy.student.restart === "anytime";
}

/** 上一轮已声明重开时，新一轮沿用其练法、版本加一；旧开卷（未声明）照旧另起练法。 */
export function lessonRestartChain(
  db: Pick<Db, "select">,
  priorAttemptId: string,
) {
  const prior = db
    .select()
    .from(kernelLessonOpenings)
    .where(eq(kernelLessonOpenings.attemptId, priorAttemptId))
    .get();
  if (!prior || !declaresRestart(prior.publication)) return undefined;
  return {
    practiceId: prior.practiceId,
    practiceVersion: prior.practiceVersion + 1,
  };
}

/** 版本 >1 的开卷是重开：来源是同一练法上一版本那一轮的内核活动。 */
export function lessonRestartSource(
  db: Pick<Db, "select">,
  opening: Opening,
): string | undefined {
  if (opening.practiceVersion === 1) return undefined;
  const source = db
    .select({ attemptId: kernelLessonOpenings.attemptId })
    .from(kernelLessonOpenings)
    .where(
      and(
        eq(kernelLessonOpenings.practiceId, opening.practiceId),
        eq(kernelLessonOpenings.practiceVersion, opening.practiceVersion - 1),
      ),
    )
    .get();
  if (!source?.attemptId) kernelAttemptUnavailable();
  return source.attemptId;
}

export function restartKernelLesson(
  runtime: KernelRuntime,
  actor: Actor,
  sourceActivityId: string,
  opening: Opening,
) {
  try {
    return runtime.restart(actor, sourceActivityId, {
      protocolVersion: 1,
      operationId: opening.operationId,
      practiceVersion: opening.practiceVersion,
    });
  } catch (error) {
    if (error instanceof LearningError && error.code === "RESTART_STALE")
      throw new HttpError(
        409,
        "LESSON_RESTART_STALE",
        "讲练已在其他页面重新开始，请刷新后确认",
      );
    throw error;
  }
}
