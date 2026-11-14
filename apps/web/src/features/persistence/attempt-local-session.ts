import type {
  AttemptActivateRequest,
  AttemptContextData,
  AttemptDetailData,
  AttemptQuestionPublic,
  AttemptSummary,
} from "@tutor/contract";
import {
  attachmentsRecoverable,
  attachmentsSnapshotConflict,
  copyLocalAttemptAttachments,
  hasLocalAttachments,
  readLocalAttemptAttachments,
} from "./attempt-local-attachments";
import {
  type LocalAttemptSession,
  readLocalAttemptSessions,
  sameAttemptSource,
  saveLocalAttemptSession,
} from "./attempt-session-catalog";
import {
  inkDigestOf,
  inkStrokeCountOf,
  unsyncedAnswerIds,
} from "./draft-merge";
import {
  type AttemptDraftRecord,
  draftStore,
  getDraftSessionEpoch,
} from "./draft-store";

export function hasSubstantiveDraft(
  record: AttemptDraftRecord | null,
): boolean {
  return (
    record !== null &&
    (Object.keys(record.answers).length > 0 ||
      Object.values(record.inks).some((doc) => inkStrokeCountOf(doc) > 0) ||
      Object.values(record.materialInks ?? {}).some(
        (doc) => inkStrokeCountOf(doc) > 0,
      ) ||
      Object.keys(record.inkSnapshotBindings ?? {}).length > 0 ||
      Object.keys(record.materialSnapshotBindings ?? {}).length > 0)
  );
}
/** 材料笔迹只在本机，没有普通PUT可顺带激活；清空后的真实笔迹凭据也保留待激活。 */
export function hasLocalMaterialWork(
  record: AttemptDraftRecord | null,
): boolean {
  return (
    record !== null &&
    (Object.values(record.materialInks ?? {}).some(
      (doc) => inkStrokeCountOf(doc) > 0,
    ) ||
      Object.keys(record.materialSnapshotBindings ?? {}).length > 0)
  );
}
export function draftSnapshotConflict(
  record: AttemptDraftRecord | null,
  attempt: AttemptSummary,
): boolean {
  if (!record) return false;
  const refrozen =
    attempt.frozenAt != null && attempt.frozenAt !== attempt.startedAt;
  return [
    { docs: record.inks, bindings: record.inkSnapshotBindings },
    {
      docs: record.materialInks ?? {},
      bindings: record.materialSnapshotBindings,
    },
  ].some(({ docs, bindings }) =>
    Object.entries(docs).some(([id, doc]) => {
      const binding = bindings?.[id];
      if (binding?.digest === inkDigestOf(doc))
        return binding.frozenAt !== attempt.frozenAt;
      return refrozen && inkStrokeCountOf(doc) > 0;
    }),
  );
}
/** 目录可能被别的标签页更新；未同步旧正文缺独立题版本时不能借新目录恢复。 */
function unprovenAnswers(
  record: AttemptDraftRecord | null,
  attempt: AttemptSummary,
): boolean {
  return (
    record !== null &&
    attempt.frozenAt != null &&
    attempt.frozenAt !== attempt.startedAt &&
    unsyncedAnswerIds(record).some(
      (id) => !record.answerQuestionRevisions?.[id],
    )
  );
}
export function assertDraftEpoch(epoch: number): void {
  if (epoch !== getDraftSessionEpoch())
    throw new Error("作答会话已切换，请重新打开练习");
}
export class LocalAttemptSnapshotConflictError extends Error {
  constructor(readonly attemptId: string) {
    super(
      "练习内容已更新，旧本机原稿仍保留在此设备，尚未放入新版。请下载原稿并联系老师核对。",
    );
    this.name = "LocalAttemptSnapshotConflictError";
  }
}
/** 预检已验证卷归属，才允许读取旧键；必须先保护原快照再调用start。 */
export async function protectOpenedDraft(
  attempt: AttemptSummary | null,
  activate: (id: string, request: AttemptActivateRequest) => Promise<unknown>,
  readOriginal?: (id: string) => Promise<AttemptDetailData>,
): Promise<void> {
  if (attempt?.status !== "draft") return;
  // 旧缓存缺新列按共享协议属于历史已激活卷，不对它臆造重冻事实。
  if (attempt.frozenAt === undefined && attempt.activatedAt === undefined)
    return;
  const epoch = getDraftSessionEpoch();
  const record = await draftStore.recoverLegacyDraft(attempt.id);
  assertDraftEpoch(epoch);
  const attachments = await readLocalAttemptAttachments(attempt.id);
  assertDraftEpoch(epoch);
  if (hasSubstantiveDraft(record) || hasLocalAttachments(attachments)) {
    const known = (await readLocalAttemptSessions())[attempt.id];
    assertDraftEpoch(epoch);
    if (
      known &&
      (known.quarantined ||
        known.attempt.frozenAt !== attempt.frozenAt ||
        unprovenAnswers(record, attempt) ||
        draftSnapshotConflict(record, attempt) ||
        attachmentsSnapshotConflict(attachments, attempt))
    )
      throw new LocalAttemptSnapshotConflictError(attempt.id);
    if (!known) {
      let original = false;
      if (
        attempt.frozenAt != null &&
        attempt.frozenAt === attempt.startedAt &&
        readOriginal
      ) {
        const detail = await readOriginal(attempt.id);
        assertDraftEpoch(epoch);
        original =
          "legacyUnverified" in detail &&
          !detail.legacyUnverified &&
          detail.attempt.frozenAt === attempt.frozenAt;
      }
      if (!original) {
        await saveLocalAttemptSession({
          attempt,
          questions: {},
          quarantined: true,
        });
        assertDraftEpoch(epoch);
        throw new LocalAttemptSnapshotConflictError(attempt.id);
      }
    }
    if (attempt.phase === "opened")
      await activate(attempt.id, {
        expectedFrozenAt: attempt.frozenAt ?? null,
      });
    assertDraftEpoch(epoch);
  }
}
/** 同id重新冻结后，旧标签页的本机稿也不能自动套进新版。 */
export async function assertLocalAttemptSnapshot(
  next: LocalAttemptSession,
): Promise<void> {
  const epoch = getDraftSessionEpoch();
  const known = (await readLocalAttemptSessions())[next.attempt.id];
  assertDraftEpoch(epoch);
  if (!known) return;
  const record = await draftStore.loadDraft(next.attempt.id, {
    strictRead: true,
  });
  assertDraftEpoch(epoch);
  if (
    Object.entries(record?.answerQuestionRevisions ?? {}).some(
      ([id, revision]) => next.questionRevisions?.[id] !== revision,
    )
  )
    throw new LocalAttemptSnapshotConflictError(next.attempt.id);
  const attachments = await readLocalAttemptAttachments(next.attempt.id);
  assertDraftEpoch(epoch);
  if (
    unprovenAnswers(record, next.attempt) ||
    draftSnapshotConflict(record, next.attempt) ||
    attachmentsSnapshotConflict(attachments, next.attempt)
  )
    throw new LocalAttemptSnapshotConflictError(next.attempt.id);
  if (!known.quarantined && known.attempt.frozenAt === next.attempt.frozenAt)
    return;
  if (hasSubstantiveDraft(record) || hasLocalAttachments(attachments))
    throw new LocalAttemptSnapshotConflictError(next.attempt.id);
  next.quarantined = false;
}
export type VersionedQuestion = Pick<
  AttemptQuestionPublic,
  "id" | "questionVersion" | "questionRevisionId"
>;
export function sessionManifest(
  attempt: AttemptSummary,
  questions: readonly VersionedQuestion[],
): LocalAttemptSession {
  return {
    attempt,
    questions: Object.fromEntries(
      questions.map((q) => [q.id, q.questionVersion ?? null]),
    ),
    questionRevisions: Object.fromEntries(
      questions.map((q) => [q.id, q.questionRevisionId]),
    ),
  };
}
/** 只有题内容版本及有笔迹的材料版本全部一致，才把正文复制到新卷。原稿永不删除。 */
export async function migrateClearedDraft(
  previous: LocalAttemptSession,
  next: LocalAttemptSession,
  context: AttemptContextData,
): Promise<string | null> {
  const epoch = getDraftSessionEpoch();
  const record = await draftStore.loadDraft(previous.attempt.id, {
    strictRead: true,
  });
  assertDraftEpoch(epoch);
  const attachments = await readLocalAttemptAttachments(previous.attempt.id);
  assertDraftEpoch(epoch);
  if (!hasSubstantiveDraft(record) && !hasLocalAttachments(attachments))
    return null;
  const materialKeys = new Set(
    context.materials.map((m) => `${m.id}|${m.sourceVersion}`),
  );
  const questionIds = new Set([
    ...Object.keys(record?.answers ?? {}),
    ...Object.keys(record?.inks ?? {}),
    ...attachments.notes.keys(),
    ...attachments.annotations.keys(),
  ]);
  const matches =
    previous.materials !== undefined &&
    [...previous.materials].sort().join("\n") ===
      [...materialKeys].sort().join("\n") &&
    [...questionIds].every(
      (id) =>
        (previous.questions[id] ?? 0) > 0 &&
        previous.questions[id] === next.questions[id],
    ) &&
    Object.keys(record?.materialInks ?? {}).every((key) =>
      materialKeys.has(key),
    ) &&
    !record?.localConflicts?.length &&
    !Object.keys(record?.answerConflicts ?? {}).length &&
    attachmentsRecoverable(attachments, next.questionRevisions);
  const notice = matches
    ? "已重新打开练习，并恢复版本一致的本机草稿。"
    : "练习内容版本已变化，旧本机原稿已保留，未放入新题。请保留此设备并联系老师核对。";
  if (matches) {
    await saveLocalAttemptSession(next);
    assertDraftEpoch(epoch);
    if (record)
      await draftStore.restoreClearedDraft(
        next.attempt.id,
        record,
        next.attempt.frozenAt,
        next.questionRevisions,
      );
    await copyLocalAttemptAttachments(
      next.attempt.id,
      attachments,
      next.questionRevisions ?? {},
      () => assertDraftEpoch(epoch),
      next.attempt.frozenAt,
    );
  }
  assertDraftEpoch(epoch);
  await saveLocalAttemptSession({ ...previous, migratedTo: next.attempt.id });
  await saveLocalAttemptSession({
    ...next,
    materials: [...materialKeys],
    notice,
    ...(!matches ? { preservedAttemptId: previous.attempt.id } : {}),
  });
  return notice;
}
export async function rememberLocalAttempt(
  next: LocalAttemptSession,
): Promise<void> {
  const current = (await readLocalAttemptSessions())[next.attempt.id];
  await saveLocalAttemptSession({ ...current, ...next });
}
export async function findPreviousLocalAttempt(
  attempt: AttemptSummary,
): Promise<LocalAttemptSession | undefined> {
  return Object.values(await readLocalAttemptSessions())
    .filter(
      (entry) =>
        entry.attempt.id !== attempt.id &&
        entry.attempt.status === "draft" &&
        !entry.migratedTo &&
        sameAttemptSource(entry.attempt, attempt),
    )
    .sort((a, b) => b.attempt.startedAt.localeCompare(a.attempt.startedAt))[0];
}
