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
}
it("所有材料已确认不存在才能恢复完成，不因没有待传内容直接报告已保存", async () => {
  prepare();
  expect(getAttemptRecoveryState("fresh").state).toBe("loading");
  await recoverAttemptMaterials("fresh", ["q1", "q2"]);
  expect(getAttemptRecoveryState("fresh").state).toBe("ready");
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
