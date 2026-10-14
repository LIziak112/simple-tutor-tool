import type { NoteDoc } from "@tutor/contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { docOf, stroke } from "@/features/notes/note-fixtures";
import {
  createOngoingQuestionImages,
  loadOngoingPaper,
  planOngoingImagePages,
} from "./ongoing-question-export";

const mocks = vi.hoisted(() => ({
  local: vi.fn(),
  heads: vi.fn(),
  document: vi.fn(),
  draft: vi.fn(),
  ink: vi.fn(),
  persistence: vi.fn(),
  renderNote: vi.fn(),
  renderInk: vi.fn(),
  png: vi.fn(),
}));
vi.mock("@/features/notes/render-note", () => ({
  renderNoteImages: mocks.renderNote,
}));
vi.mock("@/features/ink/render-ink-snapshot", () => ({
  renderInkSnapshot: mocks.renderInk,
}));
vi.mock("@/features/ink/engine/canvas-png", () => ({
  canvasToPngBlob: mocks.png,
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
vi.mock("@/features/notes/note-store", () => ({ getNoteRecord: mocks.local }));
vi.mock("@/features/attempt/draft-store", () => ({
  draftStore: { loadDraft: mocks.draft },
  getDraftPersistenceState: mocks.persistence,
}));
vi.mock("@/lib/api", () => ({
  fetchStudentNoteHeadsApi: mocks.heads,
  fetchStudentNoteDocumentApi: mocks.document,
  fetchAttemptInkApi: mocks.ink,
}));
const session = { origin: "https://test", studentId: "student", epoch: 1 };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.local.mockResolvedValue(null);
  mocks.heads.mockResolvedValue([{ note: null }]);
  mocks.draft.mockResolvedValue(null);
  mocks.ink.mockResolvedValue(null);
  mocks.persistence.mockReturnValue("saved");
});

it("没有笔迹返回空，读取失败拒绝导出而不当作无稿", async () => {
  expect(await loadOngoingPaper(session, "a", "q", false)).toBeNull();
  mocks.heads.mockRejectedValueOnce(new Error("加载失败"));
  await expect(loadOngoingPaper(session, "a", "q", false)).rejects.toThrow(
    "加载失败",
  );
});
it("优先固定尚未上传的本机草稿，严格读取且物化默认值", async () => {
  const doc = docOf([
    stroke([
      [20, 30],
      [80, 90],
    ]),
  ]);
  mocks.local.mockResolvedValue({
    doc,
    local: "saved",
    pending: {},
    conflict: null,
    denied: null,
  });
  expect(await loadOngoingPaper(session, "a", "q", false)).toEqual({
    kind: "草稿",
    doc,
  });
  expect(mocks.local).toHaveBeenCalledWith(
    session,
    { attemptId: "a", questionId: "q", phase: "scratch" },
    { strictRead: true },
  );
});
it("本机失败或冲突不得生成看似完整的材料", async () => {
  mocks.local.mockResolvedValue({ local: "failed" });
  await expect(loadOngoingPaper(session, "a", "q", false)).rejects.toThrow(
    "保存",
  );
  mocks.local.mockResolvedValue({ local: "saved", conflict: {} });
  await expect(loadOngoingPaper(session, "a", "q", false)).rejects.toThrow(
    "冲突",
  );
});
it("收起后无本机记录也读取服务端草稿，文档损坏显式失败", async () => {
  const doc: NoteDoc = docOf([stroke([[10, 20]])]);
  mocks.heads.mockResolvedValue([{ note: { currentVersionId: "v" } }]);
  mocks.document.mockResolvedValue(doc);
  expect(await loadOngoingPaper(session, "a", "q", false)).toEqual({
    kind: "草稿",
    doc,
  });
  mocks.document.mockResolvedValue({ broken: true });
  await expect(loadOngoingPaper(session, "a", "q", false)).rejects.toThrow(
    "损坏",
  );
});
it("正式手写优先本机固定稿；无本机稿才取服务端", async () => {
  const doc = {
    engine: "atrament",
    version: 1,
    data: docOf([stroke([[2, 3]])]).ink,
    updatedAt: 0,
  };
  mocks.draft.mockResolvedValue({ inks: { q: doc } });
  expect(await loadOngoingPaper(session, "a", "q", true)).toEqual({
    kind: "手写作答",
    doc,
  });
  expect(mocks.ink).not.toHaveBeenCalled();
});
it("正式手写本机落盘失败时拒绝导出", async () => {
  mocks.persistence.mockReturnValue("failed");
  await expect(loadOngoingPaper(session, "a", "q", true)).rejects.toThrow(
    "保存",
  );
});
it("无草稿只保留题面；长草稿分页且每页携带题面", () => {
  const question = { width: 1000, height: 900 };
  expect(planOngoingImagePages(question, null)).toHaveLength(1);
  const pages = planOngoingImagePages(question, { width: 1000, height: 6000 });
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.every((page) => page.height <= 4096)).toBe(true);
  expect(pages.reduce((sum, page) => sum + page.paperHeight, 0)).toBe(6000);
  expect(pages.every((page) => page.questionHeight === 900)).toBe(true);
});

it("固定草稿切片逐页合成，每页重复题面并释放图片URL；会话改变停止生成", async () => {
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 1000;
      naturalHeight = 800;
      src = "";
      decode = async () => {};
    },
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixed");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
    fillRect: vi.fn(),
    fillText: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  const png = new Blob(["png"]);
  mocks.png.mockResolvedValue(png);
  mocks.renderNote.mockResolvedValue([{ blob: png }, { blob: png }]);
  const doc = docOf([stroke([[10, 20]])]);
  const pages = await createOngoingQuestionImages(
    png,
    { kind: "草稿", doc },
    "第 1 题",
    vi.fn(),
    false,
  );
  expect(pages).toHaveLength(2);
  expect(pages.every((page) => page.label === "题面、草稿")).toBe(true);
  expect(drawImage).toHaveBeenCalledTimes(4);
  expect(revoke).toHaveBeenCalledTimes(3);
  await expect(
    createOngoingQuestionImages(png, { kind: "草稿", doc }, "第 1 题", () => {
      throw new Error("会话已切换");
    }),
  ).rejects.toThrow("会话已切换");
  expect(mocks.renderNote).toHaveBeenCalledTimes(1);
});
