import type {
  AnnotationSurfaceLayout,
  AttemptQuestionPublic,
} from "@tutor/contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  fetchAnnotationViewApi: vi.fn(),
}));
vi.mock("./question-base-image", () => ({
  renderQuestionBaseImage: vi.fn(),
  questionSurfaceMatchesLayout: vi.fn(async () => true),
}));

import { ApiError, fetchAnnotationViewApi } from "@/lib/api";
import {
  getAnnotationRecord,
  installAnnotationBackend,
  memoryAnnotationBackend,
  resetAnnotationStoreForTest,
  writeLocalAnnotationBase,
} from "./annotation-store";
import {
  bindAnnotationSession,
  resetAnnotationSession,
} from "./annotation-sync";
import { prepareQuestionAnnotationBase } from "./question-annotation-base";
import { renderQuestionBaseImage } from "./question-base-image";
import {
  cancelQuestionBasePrewarm,
  clearPrewarmedQuestionBases,
  prewarmQuestionBase,
} from "./question-base-prewarm";

const session = { origin: "https://tutor.test", studentId: "student-a" };
const scope = {
  attemptId: "attempt-a",
  questionId: "question-a",
  phase: "scratch" as const,
};
const layout: AnnotationSurfaceLayout = {
  renderVersion: 2,
  questionRevisionId: "11111111-1111-4111-8111-111111111111",
  cssWidth: 300,
  cssHeight: 200,
  pixelRatio: 2,
  styleVersion: 1,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
};
const question: AttemptQuestionPublic = {
  id: scope.questionId,
  questionRevisionId: layout.questionRevisionId,
  type: "judge",
  stemMd: "公开题面",
  difficulty: 1,
  knowledge: [],
  hintCount: 0,
};
const png = new Blob(["png"], { type: "image/png" });
const surface = document.createElement("div");
beforeEach(() => {
  clearPrewarmedQuestionBases();
  resetAnnotationSession();
  resetAnnotationStoreForTest();
  installAnnotationBackend(memoryAnnotationBackend());
  vi.clearAllMocks();
  bindAnnotationSession(session);
  vi.mocked(renderQuestionBaseImage).mockResolvedValue({
    blob: png,
    layout,
    pixelWidth: 600,
    pixelHeight: 400,
  });
  vi.mocked(fetchAnnotationViewApi).mockResolvedValue({
    base: null,
    maxWidthPx: 1440,
    doc: null,
    annotation: null,
  });
});
afterEach(() => {
  clearPrewarmedQuestionBases();
  resetAnnotationSession();
  vi.unstubAllGlobals();
});
it("显式打开先接管预备，云端回填引发候选清理也不重复生成", async () => {
  await prewarmQuestionBase(session, scope, question, surface, () => false);
  vi.mocked(fetchAnnotationViewApi).mockImplementation(async () => {
    cancelQuestionBasePrewarm(session, scope);
    return { base: null, annotation: null, doc: null, maxWidthPx: 1440 };
  });
  await prepareQuestionAnnotationBase(session, scope, question, surface);
  expect(renderQuestionBaseImage).toHaveBeenCalledOnce();
});
it("本机已ready不等待网络或重复栅格化", async () => {
  await writeLocalAnnotationBase(
    session,
    scope,
    { png, layout },
    { version: 1, baseWidth: 600, baseHeight: 400, strokes: [] },
  );
  expect(
    (await prepareQuestionAnnotationBase(session, scope, question, surface))
      .kind,
  ).toBe("surface");
  expect(fetchAnnotationViewApi).not.toHaveBeenCalled();
  expect(renderQuestionBaseImage).not.toHaveBeenCalled();
});
it("另一题写盘挂起不阻塞已保存底图打开或本题底图保存", async () => {
  const backend = memoryAnnotationBackend();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = Promise.withResolvers<void>();
  installAnnotationBackend({
    ...backend,
    set: async (key, value) => {
      if (key.includes("blocked-question")) {
        started.resolve();
        await gate;
      }
      await backend.set(key, value);
    },
  });
  // 当前题已经保存，再让另一题的落盘保持挂起。
  await writeLocalAnnotationBase(
    session,
    scope,
    { png, layout },
    {
      version: 1,
      baseWidth: 600,
      baseHeight: 400,
      strokes: [],
    },
  );
  const blocked = writeLocalAnnotationBase(
    session,
    { ...scope, questionId: "blocked-question" },
    { png, layout },
    {
      version: 1,
      baseWidth: 600,
      baseHeight: 400,
      strokes: [],
    },
  );
  await started.promise;
  try {
    await expect(
      prepareQuestionAnnotationBase(session, scope, question, surface),
    ).resolves.toMatchObject({ kind: "surface" });
    await expect(
      writeLocalAnnotationBase(
        session,
        scope,
        { png, layout },
        {
          version: 1,
          baseWidth: 600,
          baseHeight: 400,
          strokes: [],
        },
      ),
    ).resolves.toBeUndefined();
  } finally {
    release();
    await blocked;
  }
}, 1000);
it("网络失败仍可原子保存本机底图并进入，不伪造服务器ID", async () => {
  vi.mocked(fetchAnnotationViewApi).mockRejectedValue(new Error("网络中断"));
  expect(
    (await prepareQuestionAnnotationBase(session, scope, question, surface))
      .kind,
  ).toBe("surface");
  expect((await getAnnotationRecord(session, scope))?.base).toBeNull();
  expect((await getAnnotationRecord(session, scope))?.localBase?.png).toBe(png);
});
it("题面投影损坏不是普通网络离线，必须拒绝生成", async () => {
  vi.mocked(fetchAnnotationViewApi).mockRejectedValue(
    new ApiError("EXPORT_ASSEMBLY_BROKEN", "题面投影异常", 500),
  );
  await expect(
    prepareQuestionAnnotationBase(session, scope, question, surface),
  ).rejects.toThrow("题面投影异常");
  expect(renderQuestionBaseImage).not.toHaveBeenCalled();
});

it("失败的本机记录不能被缓存快路径冒称ready", async () => {
  const backend = memoryAnnotationBackend();
  installAnnotationBackend({
    ...backend,
    set: async () => {
      throw new Error("本机存储不可用");
    },
  });
  await expect(
    writeLocalAnnotationBase(
      session,
      scope,
      { png, layout },
      { version: 1, baseWidth: 600, baseHeight: 400, strokes: [] },
    ),
  ).rejects.toThrow();
  await expect(
    prepareQuestionAnnotationBase(session, scope, question, surface),
  ).rejects.toThrow("本机存储不可用");
});
it("旧版底图不重新生成，拒绝访问不离线兜底", async () => {
  const base = {
    baseId: "22222222-2222-4222-8222-222222222222",
    state: "ready" as const,
    stale: false,
    pixelWidth: 1440,
    pixelHeight: 900,
  };
  vi.mocked(fetchAnnotationViewApi).mockResolvedValue({
    base,
    maxWidthPx: 1440,
    doc: null,
    annotation: null,
  });
  expect(
    (await prepareQuestionAnnotationBase(session, scope, question, surface))
      .kind,
  ).toBe("legacy");
  expect(renderQuestionBaseImage).not.toHaveBeenCalled();
  vi.mocked(fetchAnnotationViewApi).mockRejectedValue(
    new ApiError("FORBIDDEN", "无权访问", 403),
  );
  await expect(
    prepareQuestionAnnotationBase(
      session,
      { ...scope, questionId: "other" },
      { ...question, id: "other" },
      surface,
    ),
  ).rejects.toThrow("无权访问");
});

// ---------- surface=null（B05 AI 材料采集：材料收起/画布释放） ----------

it("surface=null：本机已保存底图直接复用，不依赖活题面", async () => {
  await writeLocalAnnotationBase(
    session,
    scope,
    { png, layout },
    { version: 1, baseWidth: 600, baseHeight: 400, strokes: [] },
  );
  expect(
    (await prepareQuestionAnnotationBase(session, scope, question, null)).kind,
  ).toBe("surface");
  expect(fetchAnnotationViewApi).not.toHaveBeenCalled();
  expect(renderQuestionBaseImage).not.toHaveBeenCalled();
});

it("surface=null：旧版底图仍返回 legacy，不因缺题面重新渲染", async () => {
  vi.mocked(fetchAnnotationViewApi).mockResolvedValue({
    base: {
      baseId: "22222222-2222-4222-8222-222222222222",
      state: "ready" as const,
      stale: false,
      pixelWidth: 1440,
      pixelHeight: 900,
    },
    maxWidthPx: 1440,
    doc: null,
    annotation: null,
  });
  expect(
    (await prepareQuestionAnnotationBase(session, scope, question, null)).kind,
  ).toBe("legacy");
  expect(renderQuestionBaseImage).not.toHaveBeenCalled();
});

it("surface=null：云端 ready 底图下载落盘后可用，不依赖活题面", async () => {
  vi.mocked(fetchAnnotationViewApi).mockResolvedValue({
    base: {
      baseId: "33333333-3333-4333-8333-333333333333",
      state: "ready" as const,
      stale: false,
      pixelWidth: 600,
      pixelHeight: 400,
      layout,
    },
    maxWidthPx: 1440,
    doc: null,
    annotation: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, blob: async () => png })),
  );
  expect(
    (await prepareQuestionAnnotationBase(session, scope, question, null)).kind,
  ).toBe("surface");
  expect(renderQuestionBaseImage).not.toHaveBeenCalled();
  expect((await getAnnotationRecord(session, scope))?.localBase?.png).toBe(png);
});

it("surface=null：无任何缓存底图需新渲染时明确失败，不当空稿", async () => {
  await expect(
    prepareQuestionAnnotationBase(session, scope, question, null),
  ).rejects.toThrow("题面尚未就绪，请重试");
  expect(renderQuestionBaseImage).not.toHaveBeenCalled();
  // 不能因缺题面留下空底图记录（不当作空稿建稿）
  expect((await getAnnotationRecord(session, scope))?.localBase).toBeNull();
});
