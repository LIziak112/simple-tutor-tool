import type {
  AnnotationDoc,
  AnnotationSurfaceLayout,
  AttemptSummary,
} from "@tutor/contract";
import { beforeEach, expect, it, vi } from "vitest";
import {
  getAnnotationRecord,
  installAnnotationBackend,
  memoryAnnotationBackend,
  settleAnnotationPersistence,
  writeAnnotationDoc,
  writeLocalAnnotationBase,
} from "@/features/annotation/annotation-store";
import {
  getNoteRecord,
  installNoteBackend,
  memoryNoteBackend,
  settleNotePersistence,
  writeNoteDoc,
} from "@/features/notes/note-store";
import { createHttpRuntime } from "@/portals/clients/http-runtime";
import { createClientServices } from "@/portals/clients/services";
import { createSubjectScope } from "@/portals/subject-scope";
import {
  installAttemptSessionBackend,
  saveLocalAttemptSession,
} from "./attempt-session-catalog";
import {
  bindDraftSession,
  draftStore,
  installDraftBackend,
  memoryBackend,
} from "./draft-store";
import { saveDraftAnswer } from "./save-draft-answer";

const oldToken = "2026-11-14T00:00:00.000Z";
const newToken = "2026-11-14T00:00:00.001Z";
const attempt: AttemptSummary = {
  id: "a",
  sourceType: "course",
  courseId: "c",
  unitId: "u",
  assignmentId: null,
  lectureId: null,
  status: "draft",
  phase: "active",
  activatedAt: newToken,
  frozenAt: newToken,
  attemptNo: 1,
  startedAt: oldToken,
  submittedAt: null,
  scoreAuto: null,
};
const owner = { origin: "test", studentId: "A" };
const scope = { attemptId: "a", questionId: "q", phase: "scratch" as const };
const stroke = {
  tool: "pen" as const,
  color: "black",
  weight: 2,
  points: [{ x: 20, y: 30, p: 0.5, t: 0 }],
};
beforeEach(async () => {
  installDraftBackend(memoryBackend());
  installAttemptSessionBackend(memoryBackend());
  bindDraftSession(owner);
  await saveLocalAttemptSession({
    attempt,
    questions: { q: 1 },
    materials: [],
  });
});
it("草稿纸pending原子保留创建时冻结凭据，重载和修复不借用目录新token", async () => {
  const backend = memoryNoteBackend();
  installNoteBackend(backend);
  const doc = {
    version: 1 as const,
    ink: { width: 1000 as const, strokes: [stroke] },
  };
  writeNoteDoc(owner, scope, doc, oldToken);
  await settleNotePersistence();
  installNoteBackend(backend);
  expect((await getNoteRecord(owner, scope))?.pending?.expectedFrozenAt).toBe(
    oldToken,
  );
  writeNoteDoc(owner, scope, { ...doc, paperHeightLogical: 1000 });
  await settleNotePersistence();
  expect((await getNoteRecord(owner, scope))?.pending?.expectedFrozenAt).toBe(
    oldToken,
  );
});
it("题面标画pending随原PNG/正文恢复，目录更新不改原来的凭据", async () => {
  const backend = memoryAnnotationBackend();
  installAnnotationBackend(backend);
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
  await writeLocalAnnotationBase(
    owner,
    scope,
    {
      png: new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
      layout,
    },
    { ...doc, strokes: [] },
  );
  writeAnnotationDoc(owner, scope, doc, undefined, oldToken);
  await settleAnnotationPersistence();
  installAnnotationBackend(backend);
  const record = await getAnnotationRecord(owner, scope);
  expect(record?.pending?.expectedFrozenAt).toBe(oldToken);
  expect(record?.doc).toEqual(doc);
  expect(record?.localBase?.layout.questionRevisionId).toBe("old-row");
});
it("正式手写的凭据和正文指纹绑定，换正文不能沿用旧证明", async () => {
  const doc = {
    engine: "atrament" as const,
    version: 1 as const,
    updatedAt: 1,
    data: { width: 1000 as const, strokes: [stroke] },
  };
  draftStore.saveInk("a", "q", doc, oldToken);
  await draftStore.flush("a");
  expect(draftStore.inkSnapshotToken("a", "q", doc)).toBe(oldToken);
  expect(
    draftStore.inkSnapshotToken("a", "q", { ...doc, updatedAt: 2 }),
  ).toBeUndefined();
});
it("历史答案缺渲染凭据时不借后来目录的新题版本", async () => {
  const answer = { kind: "judge" as const, value: true };
  draftStore.saveAnswer("a", "q", answer);
  await saveLocalAttemptSession({
    attempt,
    questions: { q: 1 },
    questionRevisions: { q: "new-row" },
  });
  const send = vi.fn<typeof fetch>(async (_input, init) => {
    expect(JSON.parse(String(init?.body))).not.toHaveProperty(
      "questionRevisionId",
    );
    return new Response(
      JSON.stringify({ ok: true, data: { savedAt: newToken, revision: 1 } }),
    );
  });
  const clients = createClientServices(
    createHttpRuntime(createSubjectScope({ type: "student", id: "A" }, send)),
  );
  await saveDraftAnswer(clients, "a", "q", answer);
  expect(send).toHaveBeenCalledTimes(1);
});
for (const kind of ["ink", "note", "annotation"] as const) {
  for (const proof of [oldToken, null, undefined]) {
    it(`${kind}真实PUT保留${String(proof)}，不会借目录里的新token`, async () => {
      const send = vi.fn<typeof fetch>(async (_input, init) => {
        const body = init?.body;
        expect(body).toBeInstanceOf(FormData);
        const form = body as FormData;
        if (kind === "ink") {
          const meta = JSON.parse(String(form.get("meta"))) as {
            expectedFrozenAt?: string | null;
          };
          expect(meta.expectedFrozenAt).toBe(proof);
          expect(Object.hasOwn(meta, "expectedFrozenAt")).toBe(
            proof !== undefined,
          );
        } else
          expect(form.get("expectedFrozenAt")).toBe(
            proof === undefined ? null : proof === null ? "null" : proof,
          );
        return new Response(JSON.stringify({ ok: true, data: {} }));
      });
      const clients = createClientServices(
        createHttpRuntime(
          createSubjectScope({ type: "student", id: "A" }, send),
        ),
      );
      const meta = {
        baseRevision: 0,
        mutationId: "mutation",
        ...(proof !== undefined ? { expectedFrozenAt: proof } : {}),
      };
      if (kind === "ink")
        await clients.putAttemptInkApi("a", "q", new Blob(), new Blob(), meta);
      else if (kind === "note")
        await clients.putNoteDocumentApi("a", "q", new Blob(), meta);
      else await clients.putAnnotationDocApi("a", "q", new Blob(), meta);
      expect(send).toHaveBeenCalledTimes(1);
    });
  }
}
