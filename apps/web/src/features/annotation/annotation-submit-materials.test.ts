import { beforeEach, expect, it, vi } from "vitest";
import {
  applyAnnotationReceipt,
  installAnnotationBackend,
  memoryAnnotationBackend,
  peekAnnotationRecord,
  settleAnnotationPersistence,
  writeAnnotationDoc,
} from "./annotation-store";
import { snapshotAnnotationProblems } from "./annotation-submit-materials";

const session = vi.hoisted(() => ({
  origin: "http://tutor",
  studentId: "student-a",
}));
vi.mock("./annotation-sync", () => ({
  currentAnnotationSession: () => session,
}));
const scope = {
  attemptId: "attempt-a",
  questionId: "q1",
  phase: "scratch" as const,
};
beforeEach(() => installAnnotationBackend(memoryAnnotationBackend()));
it("实际仓中非空待传稿提示，空新底图无噪音，已传原稿清空仍须提示", async () => {
  const empty = {
    version: 1 as const,
    baseWidth: 600,
    baseHeight: 400,
    strokes: [],
  };
  writeAnnotationDoc(session, scope, empty);
  await settleAnnotationPersistence();
  expect(
    await snapshotAnnotationProblems(scope.attemptId, [scope.questionId]),
  ).toEqual([]);
  writeAnnotationDoc(session, scope, {
    ...empty,
    strokes: [
      {
        tool: "pen",
        color: "#dc2626",
        weight: 2,
        points: [{ x: 10, y: 10, p: 0.5, t: 0 }],
      },
    ],
  });
  await settleAnnotationPersistence();
  expect(
    await snapshotAnnotationProblems(scope.attemptId, [scope.questionId]),
  ).toEqual([
    { questionId: "q1", reason: "标画尚未上传完整", domain: "annotation" },
  ]);
  expect(
    await snapshotAnnotationProblems(scope.attemptId, ["other-question"]),
  ).toEqual([]);
  const pending = peekAnnotationRecord(session, scope)?.pending;
  if (!pending) throw new Error("缺少待传稿");
  await applyAnnotationReceipt(session, scope, pending.mutationId, {
    annotationId: "annotation-a",
    revision: 1,
    hash: "a".repeat(64),
    savedAt: "2026-10-11T00:00:00Z",
  });
  writeAnnotationDoc(session, scope, empty);
  await settleAnnotationPersistence();
  expect(
    await snapshotAnnotationProblems(scope.attemptId, [scope.questionId]),
  ).toHaveLength(1);
});
