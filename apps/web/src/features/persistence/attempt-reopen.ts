import type {
  AttemptDetailData,
  AttemptDraftData,
  LessonStartData,
} from "@tutor/contract";
import type { ApiServices } from "@/features/runtime/ports/api-services";
import { ApiError } from "@/lib/api-response";
import {
  assertDraftEpoch,
  assertLocalAttemptSnapshot,
  findPreviousLocalAttempt,
  migrateClearedDraft,
  protectOpenedDraft,
  rememberLocalAttempt,
  sessionManifest,
} from "./attempt-local-session";
import {
  localAttemptSource,
  readLocalAttemptSessions,
} from "./attempt-session-catalog";
import { getDraftSessionEpoch } from "./draft-store";

export const isClearedAttempt = (error: unknown) =>
  error instanceof ApiError &&
  error.status === 404 &&
  error.code === "ATTEMPT_NOT_FOUND";
function manifestOf(data: AttemptDraftData | LessonStartData) {
  const questions =
    "units" in data
      ? data.units.flatMap((unit) => unit.questions)
      : data.questions;
  return sessionManifest(data.attempt, questions);
}
/** 新开卷前已有稿由预检保护；已清除旧卷只在权威404后按版本复制。 */
export async function prepareLocalAttempt<
  T extends AttemptDetailData | LessonStartData,
>(clients: ApiServices, data: T): Promise<T> {
  if (!("drafts" in data)) {
    const current = (await readLocalAttemptSessions())[data.attempt.id];
    if (current)
      await rememberLocalAttempt({ ...current, attempt: data.attempt });
    return data;
  }
  const epoch = getDraftSessionEpoch();
  const next = manifestOf(data);
  await protectOpenedDraft(
    data.attempt,
    clients.activateAttemptApi,
    clients.fetchAttemptApi,
  );
  assertDraftEpoch(epoch);
  await assertLocalAttemptSnapshot(next);
  assertDraftEpoch(epoch);
  const previous = await findPreviousLocalAttempt(data.attempt);
  assertDraftEpoch(epoch);
  if (previous && previous.attempt.phase === "opened") {
    let missing = false;
    try {
      await clients.fetchAttemptApi(previous.attempt.id);
    } catch (error) {
      if (isClearedAttempt(error)) missing = true;
      else if (
        !(
          error instanceof ApiError &&
          [401, 403, 404, 409].includes(error.status)
        )
      )
        throw error;
    }
    assertDraftEpoch(epoch);
    if (missing) {
      const context = await clients.fetchAttemptContextApi(data.attempt.id);
      assertDraftEpoch(epoch);
      await migrateClearedDraft(previous, next, context);
    }
  }
  assertDraftEpoch(epoch);
  const remembered = (await readLocalAttemptSessions())[data.attempt.id];
  assertDraftEpoch(epoch);
  if (
    remembered?.materials === undefined ||
    remembered.attempt.frozenAt !== data.attempt.frozenAt
  ) {
    try {
      const context = await clients.fetchAttemptContextApi(data.attempt.id);
      assertDraftEpoch(epoch);
      next.materials = context.materials.map(
        (m) => `${m.id}|${m.sourceVersion}`,
      );
    } catch (error) {
      assertDraftEpoch(epoch);
      // 版本未知时允许阅读，但清除恢复必须保留原稿而不能猜版本。
      if (error instanceof ApiError && [401, 403].includes(error.status))
        throw error;
    }
  }
  await assertLocalAttemptSnapshot(next);
  assertDraftEpoch(epoch);
  await rememberLocalAttempt(next);
  return data;
}
/** 不把权限拒绝、作废或普通404当清除；只重开本机已确认的未激活课程/讲练。 */
export async function reopenMissingAttempt(
  clients: ApiServices,
  attemptId: string,
  error: unknown,
): Promise<AttemptDetailData> {
  if (!isClearedAttempt(error)) throw error;
  const epoch = getDraftSessionEpoch();
  const previous = (await readLocalAttemptSessions())[attemptId];
  assertDraftEpoch(epoch);
  if (previous?.attempt.phase !== "opened") throw error;
  if (previous.migratedTo) return clients.fetchAttemptApi(previous.migratedTo);
  const source = localAttemptSource(previous.attempt);
  let nextId: string;
  if (source?.sourceType === "course")
    nextId = (
      await clients.startCourseAttemptApi(source.courseId, source.unitId)
    ).id;
  else if (source?.sourceType === "lesson")
    nextId = (
      await clients.startLessonAttemptApi(source.lectureId, source.courseId)
    ).attempt.id;
  else throw error;
  assertDraftEpoch(epoch);
  const data = await clients.fetchAttemptApi(nextId);
  assertDraftEpoch(epoch);
  if (!("drafts" in data)) return data;
  const context = await clients.fetchAttemptContextApi(nextId);
  assertDraftEpoch(epoch);
  await migrateClearedDraft(previous, manifestOf(data), context);
  await rememberLocalAttempt(manifestOf(data));
  return data;
}
