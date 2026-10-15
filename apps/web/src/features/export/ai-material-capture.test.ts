import type { AttemptQuestionPublic, NoteDoc } from "@tutor/contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { docOf, stroke } from "@/features/notes/note-fixtures";
import {
  AiCaptureError,
  captureAiQuestionMaterials,
  type AiCaptureInput,
} from "./ai-material-capture";

/** 会话标识可变：换账号/切题测试在中途翻转 */
interface NoteSessionShape {
  origin: string;
  studentId: string;
  epoch: number;
}
const state = vi.hoisted(() => {
  const initial: NoteSessionShape = {
    origin: "https://test",
    studentId: "student",
    epoch: 1,
  };
  const holder: {
    noteSession: NoteSessionShape | null;
    annotationSession: { origin: string; studentId: string };
    epoch: number;
  } = {
    noteSession: initial,
    annotationSession: { origin: "https://test", studentId: "student" },
    epoch: 0,
  };
  return holder;
});
const mocks = vi.hoisted(() => ({
  local: vi.fn(),
  heads: vi.fn(),
  documentApi: vi.fn(),
  draft: vi.fn(),
  ink: vi.fn(),
  persistence: vi.fn(),
  conflicts: vi.fn(),
  renderNote: vi.fn(),
  renderInk: vi.fn(),
  png: vi.fn(),
  annotation: vi.fn(),
  exportAnnotation: vi.fn(),
  renderBase: vi.fn(),
  recovery: vi.fn(),
  flush: vi.fn(),
}));
vi.mock("@/features/notes/note-store", () => ({ getNoteRecord: mocks.local }));
vi.mock("@/features/notes/note-sync", () => ({
  currentNoteSession: () => state.noteSession,
}));
vi.mock("@/features/annotation/annotation-store", () => ({
  getAnnotationRecord: mocks.annotation,
}));
vi.mock("@/features/annotation/annotation-sync", () => ({
  currentAnnotationSession: () => state.annotationSession,
}));
vi.mock("@/features/annotation/export-question-annotation", () => ({
  exportQuestionAnnotationImage: mocks.exportAnnotation,
}));
vi.mock("@/features/annotation/question-base-image", () => ({
  renderQuestionBaseImage: mocks.renderBase,
}));
vi.mock("@/features/attempt/attempt-material-recovery", () => ({
  getAttemptRecoveryState: mocks.recovery,
  attemptMaterialsEditable: (s: {
    state: string;
    verified?: boolean;
  }) => s.state === "ready" || (s.state === "failed" && s.verified === true),
}));
vi.mock("@/features/attempt/draft-store", () => ({
  draftStore: { loadDraft: mocks.draft, peekAnswerConflicts: mocks.conflicts },
  getDraftPersistenceState: mocks.persistence,
  getDraftSessionEpoch: () => state.epoch,
}));
vi.mock("@/lib/api", () => ({
  fetchStudentNoteHeadsApi: mocks.heads,
  fetchStudentNoteDocumentApi: mocks.documentApi,
  fetchAttemptInkApi: mocks.ink,
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

const question: AttemptQuestionPublic = {
  id: "q1",
  questionRevisionId: "rev-1",
  type: "judge",
  stemMd: "公开题面",
  difficulty: 1,
  knowledge: [],
  hintCount: 0,
};
const handwritten: AttemptQuestionPublic = {
  ...question,
  id: "q2",
  questionRevisionId: "rev-2",
  type: "solve",
};
const savedNote = (doc: NoteDoc) => ({
  doc,
  local: "saved",
  pending: {},
  conflict: null,
  denied: null,
});
const inkDocOf = (doc: NoteDoc) => ({
  engine: "atrament" as const,
  version: 1 as const,
  data: doc.ink,
  updatedAt: 0,
});
function installImageStub(decode?: () => Promise<void>) {
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 1000;
      naturalHeight = 800;
      src = "";
      decode = decode ?? (async () => {});
    },
  );
}
function installCanvasStub() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
}
const baseInput = (over: Partial<AiCaptureInput> = {}): AiCaptureInput => ({
  attemptId: "a1",
  question,
  isHandwritten: false,
  selection: { annotation: false, draft: true, formalInk: false },
  title: "第 1 题",
  surface: document.createElement("div"),
  flush: mocks.flush,
  ...over,
});
const withDraftDoc = (strokes: number) =>
  savedNote(docOf(Array.from({ length: strokes }, () => stroke([[10, 20]]))));

beforeEach(() => {
  vi.resetAllMocks();
  state.noteSession = { origin: "https://test", studentId: "student", epoch: 1 };
  state.annotationSession = {
    origin: "https://test",
    studentId: "student",
  };
  state.epoch = 0;
  mocks.local.mockResolvedValue(null);
  mocks.heads.mockResolvedValue([{ note: null }]);
  mocks.documentApi.mockResolvedValue(null);
  mocks.draft.mockResolvedValue(null);
  mocks.ink.mockResolvedValue(null);
  mocks.persistence.mockReturnValue("saved");
  mocks.conflicts.mockReturnValue({});
  mocks.recovery.mockReturnValue({ state: "ready" });
  mocks.flush.mockResolvedValue(undefined);
  mocks.renderBase.mockResolvedValue({
    blob: new Blob(["question"]),
    layout: {},
    pixelWidth: 1000,
    pixelHeight: 800,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("会话未就绪立即失败，不收笔不读稿", async () => {
  state.noteSession = null;
  await expect(captureAiQuestionMaterials(baseInput())).rejects.toThrow(
    "作答材料会话尚未就绪",
  );
  expect(mocks.flush).not.toHaveBeenCalled();
  expect(mocks.local).not.toHaveBeenCalled();
});

it("风险1：发送时最后一笔尚未落盘——先收笔落盘再读稿，输出含已收笔正文、无预测段", async () => {
  installImageStub();
  installCanvasStub();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixed");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const png = new Blob(["page"]);
  mocks.png.mockResolvedValue(png);
  mocks.renderNote.mockResolvedValue([{ blob: new Blob(["draft"]) }]);
  // 收笔前若读稿只能拿到一笔；收笔+落盘后本机稿包含最后一笔。
  mocks.local.mockResolvedValue(withDraftDoc(1));
  mocks.flush.mockImplementation(async () => {
    mocks.local.mockResolvedValue(withDraftDoc(2));
  });
  const snapshot = await captureAiQuestionMaterials(baseInput());
  expect(mocks.flush).toHaveBeenCalledExactlyOnceWith("q1");
  const [firstNoteCall] = mocks.renderNote.mock.calls;
  expect(firstNoteCall?.[0].ink.strokes).toHaveLength(2);
  expect(snapshot.pages).toHaveLength(1);
  expect(snapshot.pages[0]).toMatchObject({
    kind: "draft",
    pageIndex: 0,
    byteSize: png.size,
  });
  expect(snapshot).toMatchObject({
    version: 1,
    attemptId: "a1",
    questionId: "q1",
    questionRevisionId: "rev-1",
    phase: "scratch",
  });
});

it("风险2：本机比云端新、材料收起、画布已释放仍取本机固定内容", async () => {
  installImageStub();
  installCanvasStub();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixed");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  mocks.png.mockResolvedValue(new Blob(["page"]));
  // 正式手写：纸面收起/引擎释放后从本机固定稿重绘，云端不被读取
  const localInk = inkDocOf(docOf([stroke([[2, 3]])]));
  mocks.draft.mockResolvedValue({ inks: { q2: localInk } });
  mocks.renderInk.mockResolvedValue(new Blob(["ink"]));
  const inkSnapshot = await captureAiQuestionMaterials(
    baseInput({
      question: handwritten,
      isHandwritten: true,
      selection: { annotation: false, draft: false, formalInk: true },
    }),
  );
  const [firstInkCall] = mocks.renderInk.mock.calls;
  expect(firstInkCall?.[0]).toEqual(localInk);
  expect(mocks.ink).not.toHaveBeenCalled();
  expect(inkSnapshot.pages[0]).toMatchObject({ kind: "formal_ink" });
  // 草稿：本机待传稿保留当前版本，不再查云端
  mocks.renderInk.mockClear();
  mocks.local.mockResolvedValue({
    ...withDraftDoc(1),
    pending: { q1: true },
  });
  mocks.renderNote.mockResolvedValue([{ blob: new Blob(["draft"]) }]);
  const draftSnapshot = await captureAiQuestionMaterials(baseInput());
  expect(mocks.heads).not.toHaveBeenCalled();
  expect(draftSnapshot.pages[0]).toMatchObject({ kind: "draft" });
});

it("风险2/4：圈画收起仍从已保存底图合成（surface=null 传入原导出入口）", async () => {
  installImageStub();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixed");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const annotationBlob = new Blob(["annotation-png"]);
  mocks.annotation.mockResolvedValue({
    doc: { strokes: [stroke([[1, 2]])] },
    local: "saved",
    conflict: null,
    denied: null,
  });
  mocks.exportAnnotation.mockResolvedValue(annotationBlob);
  const snapshot = await captureAiQuestionMaterials(
    baseInput({
      selection: { annotation: true, draft: false, formalInk: false },
      surface: null,
    }),
  );
  expect(mocks.exportAnnotation).toHaveBeenCalledExactlyOnceWith(
    state.annotationSession,
    { attemptId: "a1", questionId: "q1", phase: "scratch" },
    question,
    null,
  );
  expect(snapshot.pages).toHaveLength(1);
  expect(snapshot.pages[0]).toEqual({
    kind: "annotation",
    pageIndex: 0,
    width: 1000,
    height: 800,
    byteSize: annotationBlob.size,
    blob: annotationBlob,
  });
  // 圈画材料不走题面重渲染（配套底图来自已保存合成入口）
  expect(mocks.renderBase).not.toHaveBeenCalled();
  // 纸面路径题面未挂载时给明确可重试错误，不当空稿也不假成功
  mocks.local.mockResolvedValue(withDraftDoc(1));
  await expect(
    captureAiQuestionMaterials(
      baseInput({
        selection: { annotation: false, draft: true, formalInk: false },
        surface: null,
      }),
    ),
  ).rejects.toThrow("题面尚未就绪");
});

it("风险3：本机写入失败不发送不清稿不假装成功", async () => {
  mocks.flush.mockRejectedValue(new Error("本机写入失败"));
  const failure = await captureAiQuestionMaterials(baseInput()).catch(
    (cause: unknown) => cause,
  );
  expect(failure).toBeInstanceOf(AiCaptureError);
  expect((failure as AiCaptureError).stage).toBe("flush");
  expect((failure as AiCaptureError).message).toBe("本机写入失败");
  expect(mocks.renderNote).not.toHaveBeenCalled();
});

it("风险3：材料恢复失败或仍在恢复中都不采集（读取失败不视为无稿）", async () => {
  mocks.recovery.mockReturnValue({
    state: "failed",
    message: "材料恢复失败，请重试",
  });
  await expect(captureAiQuestionMaterials(baseInput())).rejects.toThrow(
    "材料恢复失败，请重试",
  );
  mocks.recovery.mockReturnValue({ state: "loading" });
  await expect(captureAiQuestionMaterials(baseInput())).rejects.toThrow(
    "作答材料尚未恢复完成",
  );
});

it("风险3：草稿/圈画/手写答案存在待裁决冲突时停止并指出缺件类别", async () => {
  mocks.local.mockResolvedValue({
    ...withDraftDoc(1),
    conflict: { reason: "版本分歧" },
  });
  const draftFailure = await captureAiQuestionMaterials(baseInput()).catch(
    (cause: unknown) => cause,
  );
  expect(draftFailure).toBeInstanceOf(AiCaptureError);
  expect((draftFailure as AiCaptureError).stage).toBe("paper");
  expect((draftFailure as AiCaptureError).material).toBe("draft");
  mocks.local.mockResolvedValue(null);
  mocks.annotation.mockResolvedValue({
    doc: { strokes: [stroke([[1, 2]])] },
    local: "saved",
    conflict: { reason: "版本分歧" },
    denied: null,
  });
  const annotationFailure = await captureAiQuestionMaterials(
    baseInput({
      selection: { annotation: true, draft: false, formalInk: false },
    }),
  ).catch((cause: unknown) => cause);
  expect((annotationFailure as AiCaptureError).stage).toBe("conflict");
  expect((annotationFailure as AiCaptureError).material).toBe("annotation");
  mocks.conflicts.mockReturnValue({ q2: { revision: 3 } });
  await expect(
    captureAiQuestionMaterials(
      baseInput({
        question: handwritten,
        isHandwritten: true,
        selection: { annotation: false, draft: false, formalInk: true },
      }),
    ),
  ).rejects.toThrow("待裁决冲突");
});

it("风险5：长稿多页与圈画同选时页序/类别不混；每页携带尺寸与字节", async () => {
  installImageStub();
  installCanvasStub();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixed");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const pageBlobs = [1, 2, 3].map((n) => new Blob([`page-${n}`]));
  mocks.png.mockImplementation(async () => pageBlobs.shift() ?? new Blob(["x"]));
  mocks.local.mockResolvedValue(withDraftDoc(1));
  mocks.renderNote.mockResolvedValue([
    { blob: new Blob(["d1"]) },
    { blob: new Blob(["d2"]) },
    { blob: new Blob(["d3"]) },
  ]);
  mocks.annotation.mockResolvedValue({
    doc: { strokes: [stroke([[1, 2]])] },
    local: "saved",
    conflict: null,
    denied: null,
  });
  const annotationBlob = new Blob(["annotation-png"]);
  mocks.exportAnnotation.mockResolvedValue(annotationBlob);
  const snapshot = await captureAiQuestionMaterials(
    baseInput({
      selection: { annotation: true, draft: true, formalInk: false },
    }),
  );
  expect(snapshot.pages.map((page) => page.kind)).toEqual([
    "annotation",
    "draft",
    "draft",
    "draft",
  ]);
  expect(snapshot.pages.map((page) => page.pageIndex)).toEqual([0, 0, 1, 2]);
  const [annotationPage] = snapshot.pages;
  expect(annotationPage?.byteSize).toBe(annotationBlob.size);
  for (const page of snapshot.pages) {
    expect(page.width).toBeGreaterThan(0);
    expect(page.height).toBeGreaterThan(0);
    expect(page.byteSize).toBe(page.blob.size);
  }
  // 正式手写题走手写重绘入口，类别为 formal_ink
  mocks.renderNote.mockClear();
  mocks.draft.mockResolvedValue({
    inks: { q2: inkDocOf(docOf([stroke([[2, 3]])])) },
  });
  mocks.renderInk.mockResolvedValue(new Blob(["ink"]));
  const inkSnapshot = await captureAiQuestionMaterials(
    baseInput({
      question: handwritten,
      isHandwritten: true,
      selection: { annotation: false, draft: false, formalInk: true },
    }),
  );
  expect(mocks.renderInk).toHaveBeenCalledOnce();
  expect(mocks.renderNote).not.toHaveBeenCalled();
  expect(inkSnapshot.pages.map((page) => page.kind)).toEqual(["formal_ink"]);
});

it("风险6：采集中换账号/切题——迟到图片丢弃，不能进入新题", async () => {
  installImageStub();
  // 圈画合成完成时会话已切换：迟到图片不得返回
  mocks.annotation.mockResolvedValue({
    doc: { strokes: [stroke([[1, 2]])] },
    local: "saved",
    conflict: null,
    denied: null,
  });
  mocks.exportAnnotation.mockImplementation(async () => {
    state.noteSession = { origin: "https://test", studentId: "other", epoch: 2 };
    return new Blob(["late"]);
  });
  const failure = await captureAiQuestionMaterials(
    baseInput({
      selection: { annotation: true, draft: false, formalInk: false },
    }),
  ).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(AiCaptureError);
  expect((failure as AiCaptureError).stage).toBe("identity");
  // 草稿分页渲染途中切题：已绘页面不能拼成快照
  state.noteSession = { origin: "https://test", studentId: "student", epoch: 1 };
  installCanvasStub();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixed");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  mocks.png.mockResolvedValue(new Blob(["page"]));
  mocks.local.mockResolvedValue(withDraftDoc(1));
  mocks.renderNote.mockImplementation(async () => {
    state.annotationSession = {
      origin: "https://test",
      studentId: "other",
    };
    return [{ blob: new Blob(["draft"]) }];
  });
  await expect(captureAiQuestionMaterials(baseInput())).rejects.toThrow(
    "会话已切换",
  );
});

it("风险7：字体/图片读取失败明确报错可重试，不生成空白假成功图", async () => {
  mocks.local.mockResolvedValue(withDraftDoc(1));
  // 题面渲染失败（字体/资源未稳定）：错误原文透出，重试后成功
  mocks.renderBase.mockRejectedValue(
    new Error("题面资源或布局未稳定，请稍后重试"),
  );
  const failure = await captureAiQuestionMaterials(baseInput()).catch(
    (cause: unknown) => cause,
  );
  expect(failure).toBeInstanceOf(AiCaptureError);
  expect((failure as AiCaptureError).message).toBe(
    "题面资源或布局未稳定，请稍后重试",
  );
  installImageStub();
  installCanvasStub();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixed");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  mocks.png.mockResolvedValue(new Blob(["page"]));
  mocks.renderBase.mockResolvedValue({ blob: new Blob(["question"]) });
  mocks.renderNote.mockResolvedValue([{ blob: new Blob(["draft"]) }]);
  const snapshot = await captureAiQuestionMaterials(baseInput());
  expect(snapshot.pages).toHaveLength(1);
  // 圈画 PNG 解码失败：明确失败，不产出零字节页
  mocks.annotation.mockResolvedValue({
    doc: { strokes: [stroke([[1, 2]])] },
    local: "saved",
    conflict: null,
    denied: null,
  });
  mocks.exportAnnotation.mockResolvedValue(new Blob(["broken"]));
  installImageStub(async () => Promise.reject(new Error("decode 失败")));
  await expect(
    captureAiQuestionMaterials(
      baseInput({
        selection: { annotation: true, draft: false, formalInk: false },
      }),
    ),
  ).rejects.toThrow("圈画图片读取失败");
  // 页图合成（PNG 编码）失败同样透出
  installImageStub();
  mocks.png.mockRejectedValue(new Error("PNG 编码失败"));
  await expect(captureAiQuestionMaterials(baseInput())).rejects.toThrow(
    "PNG 编码失败",
  );
});

it("顺序8：同一采集重试复用原快照，不后台重抓最新稿；改选择才重新采集", async () => {
  installImageStub();
  installCanvasStub();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixed");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  mocks.png.mockResolvedValue(new Blob(["page"]));
  mocks.local.mockResolvedValue(withDraftDoc(1));
  mocks.renderNote.mockResolvedValue([{ blob: new Blob(["draft"]) }]);
  const first = await captureAiQuestionMaterials(baseInput());
  // 之后本机又写了新稿：重试若重抓就会拿到两笔
  mocks.local.mockResolvedValue(withDraftDoc(2));
  const retried = await captureAiQuestionMaterials(
    baseInput({ previous: first }),
  );
  expect(retried).toBe(first);
  expect(mocks.flush).toHaveBeenCalledOnce();
  expect(mocks.renderNote).toHaveBeenCalledOnce();
  // 换了材料选择（加圈画）才重新采集
  mocks.annotation.mockResolvedValue(null);
  const refreshed = await captureAiQuestionMaterials(
    baseInput({
      previous: first,
      selection: { annotation: true, draft: true, formalInk: false },
    }),
  );
  expect(refreshed).not.toBe(first);
  expect(mocks.flush).toHaveBeenCalledTimes(2);
});

it("尚无笔迹不算失败：空页快照可仅发文字（需求 §4.1）", async () => {
  const snapshot = await captureAiQuestionMaterials(baseInput());
  expect(snapshot.pages).toEqual([]);
  expect(mocks.renderNote).not.toHaveBeenCalled();
});
