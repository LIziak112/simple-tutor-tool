import { beforeEach, expect, it, vi } from "vitest";
import {
  type AnnotationSessionRef,
  applyAnnotationConflict,
  getAnnotationRecord,
  installAnnotationBackend,
  memoryAnnotationBackend,
  resetAnnotationStoreForTest,
  resolveAnnotationConflictKeepLocal,
  writeAnnotationDoc,
} from "@/features/annotation/annotation-store";
import {
  applyUploadConflict,
  applyUploadDenied,
  getNoteRecord,
  installNoteBackend,
  memoryNoteBackend,
  type NoteSessionRef,
  resetNoteStoreForTest,
  writeNoteDoc,
} from "@/features/notes/note-store";
import {
  DOC_A,
  SCOPE,
  SESSION_A,
  SESSION_B,
} from "@/features/notes/note-test-utils";
import {
  installDraftBackend,
  memoryBackend,
} from "@/features/persistence/draft-store";
import {
  prepareAnnotationForPwaUpdate,
  prepareNoteForPwaUpdate,
} from "@/features/persistence/pwa-draft-safety";

const syncState = vi.hoisted(() => ({
  notes: null as NoteSessionRef | null,
  annotations: null as AnnotationSessionRef | null,
  catchUpNotes: vi.fn(async () => {}),
  catchUpAnnotations: vi.fn(async () => {}),
}));
vi.mock("@/features/notes/note-sync", () => ({
  currentNoteSession: () => syncState.notes,
  catchUpNotes: syncState.catchUpNotes,
}));
vi.mock("@/features/annotation/annotation-sync", () => ({
  currentAnnotationSession: () => syncState.annotations,
  catchUpAnnotations: syncState.catchUpAnnotations,
}));

beforeEach(() => {
  installDraftBackend(memoryBackend());
  resetNoteStoreForTest();
  installNoteBackend(memoryNoteBackend());
  resetAnnotationStoreForTest();
  installAnnotationBackend(memoryAnnotationBackend());
  syncState.notes = SESSION_A;
  syncState.annotations = SESSION_A;
  vi.clearAllMocks();
});

it.each(["scratch", "correction"] as const)(
  "%s草稿更新会先收笔，仍有待传则拒绝更新并保留正文",
  async (phase) => {
    const scope = { ...SCOPE, phase };
    const finish = vi.fn(async () => {
      writeNoteDoc(SESSION_A, scope, DOC_A);
    });
    await expect(
      prepareNoteForPwaUpdate(SESSION_A, scope, finish),
    ).rejects.toThrow("同步");
    expect(finish).toHaveBeenCalledOnce();
    expect((await getNoteRecord(SESSION_A, scope))?.doc.ink.strokes).toEqual(
      DOC_A.ink.strokes,
    );
  },
);

it("草稿持久化失败时不得因排干队列成功而更新", async () => {
  installNoteBackend({
    ...memoryNoteBackend(),
    set: async () => {
      throw new Error("空间不足");
    },
  });
  await expect(
    prepareNoteForPwaUpdate(SESSION_A, SCOPE, async () => {
      writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    }),
  ).rejects.toThrow("空间不足");
  expect((await getNoteRecord(SESSION_A, SCOPE))?.local).toBe("failed");
});

it("草稿严格读取失败不能被当作无稿", async () => {
  installNoteBackend({
    ...memoryNoteBackend(),
    get: async () => {
      throw new Error("草稿读取失败");
    },
  });
  await expect(
    prepareNoteForPwaUpdate(SESSION_A, SCOPE, async () => {}),
  ).rejects.toThrow("读取失败");
});

it.each(["conflict", "denied"] as const)(
  "草稿%s时更新不得自动裁决或清稿",
  async (kind) => {
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    if (kind === "conflict")
      await applyUploadConflict(SESSION_A, SCOPE, null, "云端冲突");
    else await applyUploadDenied(SESSION_A, SCOPE, "access", "权限变化");
    await expect(
      prepareNoteForPwaUpdate(SESSION_A, SCOPE, async () => {}),
    ).rejects.toThrow("冲突或权限");
    expect((await getNoteRecord(SESSION_A, SCOPE))?.doc.ink.strokes).toEqual(
      DOC_A.ink.strokes,
    );
  },
);

it("草稿收笔等待中切换会话时，不再给新账号补传旧稿或放行更新", async () => {
  await expect(
    prepareNoteForPwaUpdate(SESSION_A, SCOPE, async () => {
      syncState.notes = SESSION_B;
    }),
  ).rejects.toThrow("会话");
  expect(syncState.catchUpNotes).not.toHaveBeenCalled();
});

it("标画保留本机状态必须阻止更新，不能用清pending绕过", async () => {
  const scope = { ...SCOPE, phase: "scratch" as const };
  writeAnnotationDoc(SESSION_A, scope, {
    version: 1,
    baseWidth: 1000,
    baseHeight: 800,
    strokes: [],
  });
  await applyAnnotationConflict(SESSION_A, scope, "layout", null, "布局不同");
  await resolveAnnotationConflictKeepLocal(SESSION_A, scope);
  await expect(
    prepareAnnotationForPwaUpdate(SESSION_A, scope, async () => {}),
  ).rejects.toThrow("保留本机");
  expect(
    (await getAnnotationRecord(SESSION_A, scope))?.retained,
  ).not.toBeNull();
});
