import type {
  AnnotationDoc,
  AnnotationSurfaceLayout,
  AttemptDraftData,
  AttemptSummary,
} from "@tutor/contract";
import { beforeEach, expect, it, vi } from "vitest";
import {
  getAnnotationRecord,
  installAnnotationBackend,
  memoryAnnotationBackend,
  resetAnnotationStoreForTest,
  writeLocalAnnotationBase,
} from "@/features/annotation/annotation-store";
import {
  getNoteRecord,
  installNoteBackend,
  memoryNoteBackend,
  resetNoteStoreForTest,
  settleNotePersistence,
  writeNoteDoc,
} from "@/features/notes/note-store";
import {
  migrateClearedDraft,
  protectOpenedDraft,
} from "./attempt-local-session";
import { installAttemptSessionBackend } from "./attempt-session-catalog";
import {
  bindDraftSession,
  installDraftBackend,
  memoryBackend,
} from "./draft-store";

const session = { origin: "test", studentId: "A" };
const scope = { attemptId: "old", questionId: "q", phase: "scratch" as const };
const attempt: AttemptSummary = {
  id: "old",
  sourceType: "course",
  courseId: "c",
  unitId: "u",
  assignmentId: null,
  lectureId: null,
  status: "draft",
  phase: "opened",
  activatedAt: null,
  frozenAt: "2026-11-14T00:00:00.000Z",
  attemptNo: 1,
  startedAt: "2026-11-14T00:00:00.000Z",
  submittedAt: null,
  scoreAuto: null,
};
const stroke = {
  tool: "pen" as const,
  color: "black",
  weight: 2,
  points: [{ x: 20, y: 30, p: 0.5, t: 0 }],
};
const layout: AnnotationSurfaceLayout = {
  renderVersion: 2,
  questionRevisionId: "old-row",
  cssWidth: 300,
  cssHeight: 200,
  pixelRatio: 2,
  styleVersion: 1,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
};
const doc: AnnotationDoc = {
  version: 1,
  baseWidth: 600,
  baseHeight: 400,
  strokes: [stroke],
};
const png = new Blob([new Uint8Array([137, 80, 78, 71])], {
  type: "image/png",
});
beforeEach(() => {
  resetNoteStoreForTest();
  resetAnnotationStoreForTest();
  installNoteBackend(memoryNoteBackend());
  installAnnotationBackend(memoryAnnotationBackend());
  installDraftBackend(memoryBackend());
  installAttemptSessionBackend(memoryBackend());
  bindDraftSession(session);
});
it("历史仅有草稿纸和题面圈画也先激活，不依赖draft-store稿或新索引", async () => {
  writeNoteDoc(session, scope, {
    version: 1,
    ink: { width: 1000, strokes: [stroke] },
  });
  await settleNotePersistence();
  const activate = vi.fn().mockResolvedValue({});
  await protectOpenedDraft(
    attempt,
    activate,
    async () =>
      ({
        attempt,
        title: "练习",
        courseName: "课程",
        dueAt: null,
        answerRelease: "on_submit",
        units: [],
        drafts: {},
        hintsOpened: {},
        legacyUnverified: false,
        enabledCapabilities: ["ink", "steps"],
      }) satisfies AttemptDraftData,
  );
  expect(activate).toHaveBeenCalledExactlyOnceWith("old", {
    expectedFrozenAt: attempt.frozenAt,
  });
});
it("清除恢复复制草稿纸与原圈画PNG/坐标，仅重绑新卷提交行，旧原稿仍在", async () => {
  writeNoteDoc(session, scope, {
    version: 1,
    ink: { width: 1000, strokes: [stroke] },
  });
  await writeLocalAnnotationBase(session, scope, { png, layout }, doc);
  const previous = { attempt, questions: { q: 1 }, materials: [] };
  const next = {
    attempt: { ...attempt, id: "new" },
    questions: { q: 1 },
    questionRevisions: { q: "new-row" },
  };
  await migrateClearedDraft(previous, next, {
    attemptId: "new",
    materials: [],
    groups: [],
  });
  const newScope = { ...scope, attemptId: "new" };
  expect((await getNoteRecord(session, newScope))?.doc.ink.strokes).toEqual([
    stroke,
  ]);
  const restored = await getAnnotationRecord(session, newScope);
  expect(restored?.doc).toEqual(doc);
  expect(restored?.localBase?.layout.questionRevisionId).toBe("new-row");
  expect(await restored?.localBase?.png.arrayBuffer()).toEqual(
    await png.arrayBuffer(),
  );
  expect(
    (await getAnnotationRecord(session, scope))?.localBase?.layout
      .questionRevisionId,
  ).toBe("old-row");
});
it("题版本变化时草稿纸和标画都不挂到新题", async () => {
  writeNoteDoc(session, scope, {
    version: 1,
    ink: { width: 1000, strokes: [stroke] },
  });
  await writeLocalAnnotationBase(session, scope, { png, layout }, doc);
  expect(
    await migrateClearedDraft(
      { attempt, questions: { q: 1 }, materials: [] },
      {
        attempt: { ...attempt, id: "new" },
        questions: { q: 2 },
        questionRevisions: { q: "new-row" },
      },
      { attemptId: "new", materials: [], groups: [] },
    ),
  ).toContain("旧本机原稿已保留");
  expect(
    await getNoteRecord(session, { ...scope, attemptId: "new" }),
  ).toBeNull();
  expect(
    await getAnnotationRecord(session, { ...scope, attemptId: "new" }),
  ).toBeNull();
});
