import type {
  AnnotationSurfaceLayout,
  AttemptQuestionPublic,
} from "@tutor/contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getAnnotationRecord,
  installAnnotationBackend,
  memoryAnnotationBackend,
} from "./annotation-store";
import {
  bindAnnotationSession,
  resetAnnotationSession,
} from "./annotation-sync";
import {
  questionSurfaceMatchesLayout,
  renderQuestionBaseImage,
} from "./question-base-image";
import {
  cancelQuestionBasePrewarm,
  clearPrewarmedQuestionBases,
  interruptQuestionBasePrewarm,
  prewarmQuestionBase,
  takePrewarmedQuestionBase,
} from "./question-base-prewarm";

vi.mock("./question-base-image", () => ({
  renderQuestionBaseImage: vi.fn(),
  questionSurfaceMatchesLayout: vi.fn(),
}));
const session = { origin: "https://warm.test", studentId: "student" };
const scope = { attemptId: "a", questionId: "q", phase: "scratch" as const };
const question: AttemptQuestionPublic = {
  id: "q",
  questionRevisionId: "r",
  type: "solve",
  stemMd: "公开题面",
  difficulty: 1,
  knowledge: [],
  hintCount: 0,
};
const layout: AnnotationSurfaceLayout = {
  renderVersion: 2,
  questionRevisionId: "r",
  cssWidth: 300,
  cssHeight: 200,
  pixelRatio: 2,
  styleVersion: 1,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
};
const rendered = {
  blob: new Blob(["png"], { type: "image/png" }),
  layout,
  pixelWidth: 600,
  pixelHeight: 400,
};
const surface = document.createElement("div");
beforeEach(() => {
  clearPrewarmedQuestionBases();
  resetAnnotationSession();
  installAnnotationBackend(memoryAnnotationBackend());
  bindAnnotationSession(session);
  vi.mocked(renderQuestionBaseImage).mockReset().mockResolvedValue(rendered);
  vi.mocked(questionSurfaceMatchesLayout).mockReset().mockResolvedValue(true);
});
it("缓存最多两份且总 PNG 不超过两 MiB", async () => {
  for (const id of ["a", "b", "c"])
    await prewarmQuestionBase(
      session,
      { ...scope, questionId: id },
      { ...question, id },
      surface,
      () => false,
    );
  expect(
    await takePrewarmedQuestionBase(
      session,
      { ...scope, questionId: "a" },
      { ...question, id: "a" },
      surface,
    ),
  ).toBeNull();
  vi.mocked(renderQuestionBaseImage).mockResolvedValue({
    ...rendered,
    blob: new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], {
      type: "image/png",
    }),
  });
  await prewarmQuestionBase(session, scope, question, surface, () => false);
  expect(
    await takePrewarmedQuestionBase(session, scope, question, surface),
  ).toBeNull();
});
it("取消在途预备不保留结果；失败之后可以重新生成", async () => {
  const gate = Promise.withResolvers<typeof rendered>();
  vi.mocked(renderQuestionBaseImage).mockReturnValueOnce(gate.promise);
  const warm = prewarmQuestionBase(
    session,
    scope,
    question,
    surface,
    () => false,
  );
  const failure = expect(warm).rejects.toThrow("预备已取消");
  try {
    await vi.waitFor(() =>
      expect(renderQuestionBaseImage).toHaveBeenCalledOnce(),
    );
    cancelQuestionBasePrewarm(session, scope);
  } finally {
    gate.resolve(rendered);
    await failure;
  }
  expect(
    await takePrewarmedQuestionBase(session, scope, question, surface),
  ).toBeNull();
  await prewarmQuestionBase(session, scope, question, surface, () => false);
  expect(
    await takePrewarmedQuestionBase(session, scope, question, surface),
  ).toBe(rendered);
});
it("交互打断在途预备，但保留已完成候选", async () => {
  await prewarmQuestionBase(session, scope, question, surface, () => false);
  interruptQuestionBasePrewarm(session, scope);
  expect(
    await takePrewarmedQuestionBase(session, scope, question, surface),
  ).toBe(rendered);

  const inflightScope = { ...scope, questionId: "inflight" };
  const inflightQuestion = { ...question, id: "inflight" };
  const gate = Promise.withResolvers<typeof rendered>();
  vi.mocked(renderQuestionBaseImage).mockReturnValueOnce(gate.promise);
  const warm = prewarmQuestionBase(
    session,
    inflightScope,
    inflightQuestion,
    surface,
    () => false,
  );
  const failure = expect(warm).rejects.toThrow("预备已取消");
  try {
    await vi.waitFor(() =>
      expect(renderQuestionBaseImage).toHaveBeenCalledTimes(2),
    );
    interruptQuestionBasePrewarm(session, inflightScope);
  } finally {
    gate.resolve(rendered);
    await failure;
  }
  expect(
    await takePrewarmedQuestionBase(
      session,
      inflightScope,
      inflightQuestion,
      surface,
    ),
  ).toBeNull();
});
afterEach(() => {
  clearPrewarmedQuestionBases();
  resetAnnotationSession();
  vi.restoreAllMocks();
});
it("预备仅保留内存结果，不创建本机稿；显式取用重新核对布局", async () => {
  await prewarmQuestionBase(session, scope, question, surface, () => false);
  expect(await getAnnotationRecord(session, scope)).toBeNull();
  expect(
    await takePrewarmedQuestionBase(session, scope, question, surface),
  ).toBe(rendered);
  expect(questionSurfaceMatchesLayout).toHaveBeenCalledWith(
    question,
    surface,
    layout,
  );
});
it("点击与在途预备复用同一次生成", async () => {
  const gate = Promise.withResolvers<typeof rendered>();
  vi.mocked(renderQuestionBaseImage).mockReturnValue(gate.promise);
  const warm = prewarmQuestionBase(
    session,
    scope,
    question,
    surface,
    () => false,
  );
  let take: ReturnType<typeof takePrewarmedQuestionBase> | undefined;
  try {
    await vi.waitFor(() =>
      expect(renderQuestionBaseImage).toHaveBeenCalledOnce(),
    );
    take = takePrewarmedQuestionBase(session, scope, question, surface);
  } finally {
    gate.resolve(rendered);
    await warm;
  }
  expect(await take).toBe(rendered);
  expect(renderQuestionBaseImage).toHaveBeenCalledOnce();
});
it("布局变化、会话切换或预备失败不采用缓存，显式生成可另行重试", async () => {
  await prewarmQuestionBase(session, scope, question, surface, () => false);
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(false);
  expect(
    await takePrewarmedQuestionBase(session, scope, question, surface),
  ).toBeNull();
  await prewarmQuestionBase(session, scope, question, surface, () => false);
  resetAnnotationSession();
  expect(
    await takePrewarmedQuestionBase(session, scope, question, surface),
  ).toBeNull();
});
it("忙于编辑时不生成，最多一个预备任务；缓存过期不采用", async () => {
  await prewarmQuestionBase(session, scope, question, surface, () => true);
  expect(renderQuestionBaseImage).not.toHaveBeenCalled();
  const gate = Promise.withResolvers<typeof rendered>();
  vi.mocked(renderQuestionBaseImage).mockReturnValue(gate.promise);
  const warm = prewarmQuestionBase(
    session,
    scope,
    question,
    surface,
    () => false,
  );
  try {
    await prewarmQuestionBase(
      session,
      { ...scope, questionId: "other" },
      { ...question, id: "other" },
      surface,
      () => false,
    );
  } finally {
    gate.resolve(rendered);
    await warm;
  }
  expect(renderQuestionBaseImage).toHaveBeenCalledOnce();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
  expect(
    await takePrewarmedQuestionBase(session, scope, question, surface),
  ).toBeNull();
  clock.mockRestore();
});
