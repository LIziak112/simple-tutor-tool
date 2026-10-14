import { afterEach, expect, it, vi } from "vitest";
import {
  installAnnotationBackend,
  memoryAnnotationBackend,
} from "@/features/annotation/annotation-store";
import * as annotationSync from "@/features/annotation/annotation-sync";
import {
  getNoteRecord,
  installNoteBackend,
  memoryNoteBackend,
} from "@/features/notes/note-store";
import * as noteSync from "@/features/notes/note-sync";
import { DOC_A, headOf } from "@/features/notes/note-test-utils";
import {
  fetchAnnotationViewApi,
  fetchAttemptMaterialRevisionsApi,
  fetchStudentNoteDocumentApi,
  fetchStudentNoteHeadsApi,
} from "@/lib/api";
import {
  attemptMaterialsEditable,
  getAttemptRecoveryState,
  recoverAttemptMaterials,
} from "./attempt-material-recovery";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  fetchAttemptMaterialRevisionsApi: vi.fn(),
  fetchStudentNoteHeadsApi: vi.fn(),
  fetchStudentNoteDocumentApi: vi.fn(),
  fetchAnnotationViewApi: vi.fn(),
}));
const session = { origin: "https://recover.test", studentId: "student" };
it("已核对本机基线的页面遇到断网仍可编辑，首次读取失败不可起空稿", async () => {
  prepare();
  await recoverAttemptMaterials("known-offline", ["q1"]);
  vi.mocked(fetchAttemptMaterialRevisionsApi).mockRejectedValue(
    new Error("断网"),
  );
  await expect(
    recoverAttemptMaterials("known-offline", ["q1"]),
  ).rejects.toThrow("断网");
  expect(
    attemptMaterialsEditable(getAttemptRecoveryState("known-offline")),
  ).toBe(true);
  expect(attemptMaterialsEditable({ state: "failed", message: "断网" })).toBe(
    false,
  );
});
afterEach(() => vi.restoreAllMocks());
function prepare() {
  vi.spyOn(noteSync, "currentNoteSession").mockReturnValue(session);
  vi.spyOn(annotationSync, "currentAnnotationSession").mockReturnValue(session);
  installNoteBackend(memoryNoteBackend());
  installAnnotationBackend(memoryAnnotationBackend());
  vi.mocked(fetchAttemptMaterialRevisionsApi).mockResolvedValue({
    notes: {},
    annotations: {},
    ink: {},
  });
  vi.mocked(fetchAnnotationViewApi).mockResolvedValue({
    base: null,
    annotation: null,
    doc: null,
    maxWidthPx: 1440,
  });
}
it("所有材料已确认不存在才能恢复完成，不因没有待传内容直接报告已保存", async () => {
  prepare();
  expect(getAttemptRecoveryState("fresh").state).toBe("loading");
  await recoverAttemptMaterials("fresh", ["q1", "q2"]);
  expect(getAttemptRecoveryState("fresh").state).toBe("ready");
});
it("逐题本机读取并发有界，全部读取完成才解锁", async () => {
  prepare();
  const gate = Promise.withResolvers<void>();
  let active = 0;
  let peak = 0;
  const started = vi.fn();
  installAnnotationBackend({
    ...memoryAnnotationBackend(),
    get: async () => {
      active++;
      peak = Math.max(peak, active);
      started();
      await gate.promise;
      active--;
      return undefined;
    },
  });
  const task = recoverAttemptMaterials(
    "parallel-local",
    Array.from({ length: 12 }, (_, i) => `q${i}`),
  );
  try {
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(4));
    expect(getAttemptRecoveryState("parallel-local").state).toBe("loading");
  } finally {
    gate.resolve();
    await task;
  }
  expect(peak).toBe(4);
  expect(started).toHaveBeenCalledTimes(12);
  expect(getAttemptRecoveryState("parallel-local").state).toBe("ready");
});
it("本机读取失败明确失败，不以无稿完成恢复", async () => {
  prepare();
  installAnnotationBackend({
    ...memoryAnnotationBackend(),
    get: async () => {
      throw new Error("本机读取失败");
    },
  });
  await expect(recoverAttemptMaterials("bad-read", ["q1"])).rejects.toThrow(
    "读取",
  );
  expect(getAttemptRecoveryState("bad-read").state).toBe("failed");
});
it("云端标画最多四题并发，保留全部恢复完成后的解锁", async () => {
  prepare();
  const ids = Array.from({ length: 9 }, (_, i) => `q${i}`);
  vi.mocked(fetchAttemptMaterialRevisionsApi).mockResolvedValue({
    notes: {},
    annotations: Object.fromEntries(ids.map((id) => [id, 1])),
    ink: {},
  });
  const gate = Promise.withResolvers<void>();
  let active = 0;
  let peak = 0;
  const started = vi.fn();
  vi.mocked(fetchAnnotationViewApi).mockImplementation(async () => {
    active++;
    peak = Math.max(peak, active);
    started();
    await gate.promise;
    active--;
    return { base: null, annotation: null, doc: null, maxWidthPx: 1440 };
  });
  const task = recoverAttemptMaterials("parallel-cloud", ids);
  try {
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(4));
    expect(getAttemptRecoveryState("parallel-cloud").state).toBe("loading");
  } finally {
    gate.resolve();
    await task;
  }
  expect(peak).toBe(4);
  expect(started).toHaveBeenCalledTimes(9);
});
it("失败先等待本批在途读取，期间重试复用任务且不启动下一批", async () => {
  prepare();
  const gate = Promise.withResolvers<void>();
  const started = vi.fn();
  installAnnotationBackend({
    ...memoryAnnotationBackend(),
    get: async () => {
      started();
      if (started.mock.calls.length === 1) throw new Error("读取失败");
      await gate.promise;
      return undefined;
    },
  });
  const ids = Array.from({ length: 8 }, (_, i) => `q${i}`);
  const task = recoverAttemptMaterials("drain-failure", ids);
  const rejected = expect(task).rejects.toThrow("读取失败");
  try {
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(4));
    expect(recoverAttemptMaterials("drain-failure", ids)).toBe(task);
    expect(getAttemptRecoveryState("drain-failure").state).toBe("loading");
  } finally {
    gate.resolve();
    await rejected;
  }
  expect(started).toHaveBeenCalledTimes(4);
  expect(getAttemptRecoveryState("drain-failure").state).toBe("failed");
});
it("云端盘点失败不得初始化空稿或声称全部已保存", async () => {
  prepare();
  vi.mocked(fetchAttemptMaterialRevisionsApi).mockRejectedValue(
    new Error("云端读取失败"),
  );
  await expect(recoverAttemptMaterials("bad-cloud", ["q1"])).rejects.toThrow(
    "云端读取失败",
  );
  expect(getAttemptRecoveryState("bad-cloud").state).toBe("failed");
});
it("云端有草稿必须读取正文，读取失败保留基线并允许重试恢复", async () => {
  prepare();
  vi.mocked(fetchAttemptMaterialRevisionsApi).mockResolvedValue({
    notes: { q1: 1 },
    annotations: {},
    ink: {},
  });
  vi.mocked(fetchStudentNoteHeadsApi).mockResolvedValue([headOf()]);
  vi.mocked(fetchStudentNoteDocumentApi).mockRejectedValue(
    new Error("正文暂时不可读"),
  );
  await expect(recoverAttemptMaterials("body-retry", ["q1"])).rejects.toThrow(
    "正文恢复失败",
  );
  expect(
    await getNoteRecord(session, {
      attemptId: "body-retry",
      questionId: "q1",
      phase: "scratch",
    }),
  ).toBeNull();
  vi.mocked(fetchStudentNoteDocumentApi).mockResolvedValue(DOC_A);
  await recoverAttemptMaterials("body-retry", ["q1"]);
  expect(
    (
      await getNoteRecord(session, {
        attemptId: "body-retry",
        questionId: "q1",
        phase: "scratch",
      })
    )?.doc,
  ).toEqual(DOC_A);
  expect(getAttemptRecoveryState("body-retry").state).toBe("ready");
});
