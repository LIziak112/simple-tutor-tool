import {
  type AnnotationScope,
  type AnnotationSessionRef,
  assertLoadedAnnotationsForPwaUpdate,
  getAnnotationRecord,
  retryAnnotationPersistence,
} from "@/features/annotation/annotation-store";
import {
  catchUpAnnotations,
  currentAnnotationSession,
} from "@/features/annotation/annotation-sync";
import {
  assertLoadedNotesForPwaUpdate,
  getNoteRecord,
  type NoteScope,
  type NoteSessionRef,
  retryNotePersistence,
} from "@/features/notes/note-store";
import { catchUpNotes, currentNoteSession } from "@/features/notes/note-sync";
import { unsyncedAnswerIds } from "./draft-merge";
import {
  assertLoadedDraftsForPwaUpdate,
  draftStore,
  getDraftPersistenceState,
  getDraftSessionEpoch,
  hasLoadedDraftsForPwaUpdate,
} from "./draft-store";

/** 路由切到教师端或显式退出后，已加载的失败稿也不能随更新丢失。 */
export async function prepareRetainedStudentDraftsForPwaUpdate(): Promise<void> {
  const epoch = getDraftSessionEpoch();
  const notes = currentNoteSession();
  const annotations = currentAnnotationSession();
  await assertLoadedNotesForPwaUpdate();
  await assertLoadedAnnotationsForPwaUpdate();
  if (
    epoch !== getDraftSessionEpoch() ||
    notes !== currentNoteSession() ||
    annotations !== currentAnnotationSession()
  )
    throw new Error("保存会话已变化，请重新检查后更新");
  if (!notes && !annotations) {
    if (hasLoadedDraftsForPwaUpdate())
      throw new Error(
        "仍有未确认账号归属的本机作答，请重新进入相应账号处理后更新",
      );
    return;
  }
  if (
    !notes ||
    !annotations ||
    notes.studentId !== annotations.studentId ||
    notes.origin !== annotations.origin
  )
    throw new Error("学生保存会话未就绪或不一致，请重新进入相应账号处理后更新");
  await prepareStudentDraftsForPwaUpdate(notes.studentId);
}

/** 路由卸载后尚在写入的材料，仍由学生会话末轮复核兜底。 */
export async function prepareStudentDraftsForPwaUpdate(
  studentId: string | undefined,
): Promise<void> {
  const epoch = getDraftSessionEpoch();
  const notes = currentNoteSession();
  const annotations = currentAnnotationSession();
  const assertSession = () => {
    if (
      !studentId ||
      notes?.studentId !== studentId ||
      annotations?.studentId !== studentId ||
      notes !== currentNoteSession() ||
      annotations !== currentAnnotationSession() ||
      epoch !== getDraftSessionEpoch()
    )
      throw new Error("学生保存会话尚未就绪或已变化，请重新检查后更新");
  };
  assertSession();
  await assertLoadedDraftsForPwaUpdate();
  assertSession();
  if (!notes || !annotations) return;
  await assertLoadedNotesForPwaUpdate(notes);
  assertSession();
  await assertLoadedAnnotationsForPwaUpdate(annotations);
  assertSession();
}

/** 更新期间输入已由全局门禁冻结；异步保存不能跨账号接受旧回执。 */
export async function prepareDraftForPwaUpdate(
  attemptId: string,
  prepare: () => Promise<void>,
  requireSyncedAnswers = false,
): Promise<void> {
  const epoch = getDraftSessionEpoch();
  const assertSession = () => {
    if (epoch !== getDraftSessionEpoch())
      throw new Error("作答会话已切换，请重新检查后更新");
  };
  await prepare();
  assertSession();
  await draftStore.flush(attemptId);
  assertSession();
  const record = await draftStore.loadDraft(attemptId, { strictRead: true });
  assertSession();
  if (getDraftPersistenceState(attemptId) !== "saved")
    throw new Error("作答或手写本机保存未完成，请保持页面打开并重试");
  if (Object.keys(record?.answerConflicts ?? {}).length > 0)
    throw new Error("答案存在同步冲突，请先选择保留版本再更新");
  if (requireSyncedAnswers && record && unsyncedAnswerIds(record).length > 0)
    throw new Error("答案尚未同步完成，请检查网络后重试更新");
}

export async function prepareNoteForPwaUpdate(
  session: NoteSessionRef | null,
  scope: NoteScope,
  finish: () => Promise<void>,
): Promise<void> {
  const epoch = getDraftSessionEpoch();
  const assertSession = () => {
    if (
      !session ||
      session !== currentNoteSession() ||
      epoch !== getDraftSessionEpoch()
    )
      throw new Error("草稿会话未就绪或已切换，请重新检查后更新");
  };
  assertSession();
  await finish();
  assertSession();
  if (!session) return;
  await retryNotePersistence(session, scope);
  assertSession();
  let record = await getNoteRecord(session, scope, { strictRead: true });
  assertSession();
  if (record?.pending && !record.conflict && !record.denied) {
    await catchUpNotes(scope.attemptId);
    assertSession();
    record = await getNoteRecord(session, scope, { strictRead: true });
  }
  assertSession();
  if (!record) return;
  if (record.local !== "saved")
    throw new Error(record.localError ?? "草稿本机保存未完成，请重试更新");
  if (record.conflict || record.denied)
    throw new Error("草稿有同步冲突或权限问题，请先处理后更新");
  if (record.pending) throw new Error("草稿尚未同步完成，请检查网络后重试更新");
}

export async function prepareAnnotationForPwaUpdate(
  session: AnnotationSessionRef | null,
  scope: AnnotationScope,
  finish: () => Promise<void>,
): Promise<void> {
  const epoch = getDraftSessionEpoch();
  const assertSession = () => {
    if (
      !session ||
      session !== currentAnnotationSession() ||
      epoch !== getDraftSessionEpoch()
    )
      throw new Error("标画会话未就绪或已切换，请重新检查后更新");
  };
  assertSession();
  await finish();
  assertSession();
  if (!session) return;
  await retryAnnotationPersistence(session, scope);
  assertSession();
  let record = await getAnnotationRecord(session, scope, {
    strictRead: true,
  });
  assertSession();
  if (
    record?.pending &&
    !record.conflict &&
    !record.denied &&
    !record.retained
  ) {
    await catchUpAnnotations(scope.attemptId);
    assertSession();
    record = await getAnnotationRecord(session, scope, { strictRead: true });
  }
  assertSession();
  if (!record) return;
  if (record.local !== "saved")
    throw new Error(record.localError ?? "标画本机保存未完成，请重试更新");
  if (record.conflict || record.denied || record.retained)
    throw new Error("标画有同步冲突、权限问题或保留本机稿，请先处理后更新");
  if (record.pending) throw new Error("标画尚未同步完成，请检查网络后重试更新");
}
