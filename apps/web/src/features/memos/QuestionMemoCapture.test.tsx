import type { LearningContext } from "@tutor/contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  LearningHostContext,
  learningContextStore,
} from "@/features/learning-context/learning-context-store";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/test/render-with-portal";
import { enqueueMemo } from "./memo-outbox";
import {
  QuestionMemoAction,
  QuestionMemoCaptureProvider,
} from "./QuestionMemoCapture";

vi.mock("./memo-outbox", () => ({
  enqueueMemo: vi.fn(async () => "queued"),
  useMemoOutbox: () => [],
}));
const attemptId = crypto.randomUUID();
const revisions = { q1: crypto.randomUUID(), q2: crypto.randomUUID() };
beforeEach(() => {
  vi.mocked(enqueueMemo).mockClear();
  learningContextStore.bindPrincipal("alice");
  learningContextStore.reset();
  learningContextStore.registerHost(
    attemptId,
    (id) => ({
      anchor: { kind: "question", attemptId, questionId: id, label: id },
      reference: {
        kind: "question",
        attemptId,
        questionId: id,
        surface: "attempt",
        expectedQuestionRevisionId: revisions[id as keyof typeof revisions],
      },
    }),
    "draft",
  );
});
afterEach(() => {
  cleanup();
  learningContextStore.reset();
});
function mount() {
  return render(
    <LearningHostContext value={learningContextStore.getSnapshot().host}>
      <QuestionMemoCaptureProvider>
        <QuestionMemoAction
          attemptId={attemptId}
          questionId="q1"
          surface="attempt"
          questionRevisionId={revisions.q1}
          standalone
        />
        <QuestionMemoAction
          attemptId={attemptId}
          questionId="q2"
          surface="attempt"
          questionRevisionId={revisions.q2}
          standalone
        />
      </QuestionMemoCaptureProvider>
    </LearningHostContext>,
  );
}
it("从第二张题卡打开立即聚焦输入，滚动/全局焦点改变仍保存原qid与revision", async () => {
  mount();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(
    screen.getAllByRole("button", { name: "记随笔" })[1] as HTMLElement,
  );
  const textarea = screen.getByLabelText("随笔内容");
  expect(textarea).toHaveFocus();
  const h = learningContextStore.getSnapshot().host;
  if (!h) throw new Error("missing host");
  const next = h.sourceOf("q1");
  if (!next) throw new Error("missing q1");
  act(() => learningContextStore.explicit(h, next));
  fireEvent.change(textarea, { target: { value: "第二题草稿" } });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "保存" })),
  );
  expect(enqueueMemo).toHaveBeenCalledWith(
    expect.objectContaining({
      anchor: expect.objectContaining({ questionId: "q2" }),
      reference: expect.objectContaining({
        questionId: "q2",
        expectedQuestionRevisionId: revisions.q2,
      }),
      sourcePrincipal: "alice",
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("Escape关闭唯一composer并把键盘焦点归还题卡触发器", async () => {
  mount();
  const trigger = screen.getAllByRole("button", {
    name: "记随笔",
  })[1] as HTMLElement;
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  await act(async () =>
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  // Radix FocusScope 在卸载回调中异步归还焦点，等待真实生命周期完成。
  await waitFor(() => expect(trigger).toHaveFocus());
});
it("主体变化立即关闭旧来源记录端，旧close不发布新人的来源", () => {
  mount();
  fireEvent.click(
    screen.getAllByRole("button", { name: "记随笔" })[1] as HTMLElement,
  );
  fireEvent.change(screen.getByLabelText("随笔内容"), {
    target: { value: "Alice未提交" },
  });
  act(() => learningContextStore.bindPrincipal("bob"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(learningContextStore.getSnapshot().source.anchor).toEqual({
    kind: "none",
  });
  expect(enqueueMemo).not.toHaveBeenCalled();
});

it("旧记录迟到入队回执不能关闭后来打开的新记录或解除它的焦点保护", async () => {
  let complete!: (id: string) => void;
  vi.mocked(enqueueMemo).mockReturnValueOnce(
    new Promise((done) => {
      complete = done;
    }),
  );
  mount();
  fireEvent.click(
    screen.getAllByRole("button", { name: "记随笔" })[0] as HTMLElement,
  );
  fireEvent.change(screen.getByLabelText("随笔内容"), {
    target: { value: "第一条正在入队" },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "保存" })),
  );
  await act(async () =>
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }),
  );
  fireEvent.click(
    screen.getAllByRole("button", { name: "记随笔" })[1] as HTMLElement,
  );
  fireEvent.change(screen.getByLabelText("随笔内容"), {
    target: { value: "第二条尚未保存" },
  });
  await act(async () => complete("old-queued"));
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(screen.getByLabelText("随笔内容")).toHaveValue("第二条尚未保存");
  const host = learningContextStore.getSnapshot().host;
  if (!host) throw new Error("missing host");
  const observed = host.sourceOf("q1");
  if (!observed) throw new Error("missing q1");
  act(() => learningContextStore.observe(host, observed, false));
  expect(learningContextStore.getSnapshot().source.anchor).toMatchObject({
    questionId: "q2",
  });
});

it.each(["result-new-revision", "same-values-new-lease"] as const)(
  "旧题卡动作不能借同路由的新host：%s",
  (variant) => {
    mount();
    act(() => {
      const next = learningContextStore.registerHost(
        attemptId,
        (id) => ({
          anchor: { kind: "question", attemptId, questionId: id, label: id },
          reference: {
            kind: "question",
            attemptId,
            questionId: id,
            surface: variant === "result-new-revision" ? "result" : "attempt",
            expectedQuestionRevisionId:
              variant === "result-new-revision"
                ? crypto.randomUUID()
                : revisions[id as keyof typeof revisions],
          },
        }),
        "graded",
      );
      const source = next.sourceOf("q2");
      if (!source) throw new Error("missing q2");
      learningContextStore.explicit(next, source);
    });
    const before = learningContextStore.getSnapshot();
    fireEvent.click(
      screen.getAllByRole("button", { name: "记随笔" })[0] as HTMLElement,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(learningContextStore.getSnapshot()).toBe(before);
    expect(enqueueMemo).not.toHaveBeenCalled();
  },
);

it.each(["wrong-surface", "wrong-known-revision"] as const)(
  "题卡已知身份不匹配时动作没有副作用：%s",
  (variant) => {
    const current = learningContextStore.getSnapshot().host;
    if (!current) throw new Error("missing host");
    const q2 = current.sourceOf("q2");
    if (!q2) throw new Error("missing q2");
    act(() => learningContextStore.explicit(current, q2));
    render(
      <LearningHostContext value={current}>
        <QuestionMemoCaptureProvider>
          <QuestionMemoAction
            attemptId={attemptId}
            questionId="q1"
            surface={variant === "wrong-surface" ? "result" : "attempt"}
            questionRevisionId={
              variant === "wrong-known-revision"
                ? crypto.randomUUID()
                : revisions.q1
            }
            standalone
          />
        </QuestionMemoCaptureProvider>
      </LearningHostContext>,
    );
    const before = learningContextStore.getSnapshot();
    fireEvent.click(screen.getByRole("button", { name: "记随笔" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(learningContextStore.getSnapshot()).toBe(before);
  },
);

it("旧卡/旧canonical不替换新宿主canonical与已打开草稿，新卡可选非当前题", async () => {
  const old = mount();
  const oldHost = learningContextStore.getSnapshot().host;
  const oldReference = oldHost?.sourceOf("q1")?.reference;
  if (!oldHost || !oldReference) throw new Error("missing old source");
  const oldTrigger = old.getAllByRole("button", { name: "记随笔" })[0];
  if (!(oldTrigger instanceof HTMLElement))
    throw new Error("missing old trigger");
  const newRevision = crypto.randomUUID();
  let next!: NonNullable<
    ReturnType<typeof learningContextStore.getSnapshot>["host"]
  >;
  act(() => {
    next = learningContextStore.registerHost(
      attemptId,
      (id) => ({
        anchor: { kind: "question", attemptId, questionId: id, label: id },
        reference: {
          kind: "question",
          attemptId,
          questionId: id,
          surface: "result",
          expectedQuestionRevisionId: newRevision,
        },
      }),
      "graded",
    );
    const q2 = next.sourceOf("q2");
    if (!q2) throw new Error("missing q2");
    learningContextStore.explicit(next, q2);
  });
  render(
    <LearningHostContext value={next}>
      <QuestionMemoCaptureProvider>
        <QuestionMemoAction
          attemptId={attemptId}
          questionId="q1"
          surface="result"
          questionRevisionId={newRevision}
          standalone
        />
      </QuestionMemoCaptureProvider>
    </LearningHostContext>,
  );
  fireEvent.click(
    screen.getAllByRole("button", { name: "记随笔" })[2] as HTMLElement,
  );
  fireEvent.change(screen.getByLabelText("随笔内容"), {
    target: { value: "新宿主未保存草稿" },
  });
  const reference = learningContextStore.getSnapshot().source.reference;
  if (!reference) throw new Error("missing new source");
  const canonical: LearningContext = {
    schemaVersion: 1,
    content: {
      courseId: null,
      unitId: null,
      lectureId: null,
      sectionId: null,
      questionId: "q1",
      titles: { course: null, unit: null, lecture: null },
    },
    session: {
      attemptId,
      questionRevisionId: newRevision,
      questionNo: 1,
      questionCount: 2,
      settlementSeq: 1,
    },
    view: null,
    deviceId: null,
  };
  act(() => learningContextStore.resolve(next, reference, canonical));
  const before = learningContextStore.getSnapshot();
  expect(before.source.context?.session?.questionRevisionId).toBe(newRevision);
  const session = canonical.session;
  if (!session) throw new Error("missing canonical session");
  act(() =>
    learningContextStore.resolve(oldHost, oldReference, {
      ...canonical,
      session: { ...session, questionRevisionId: revisions.q1 },
    }),
  );
  fireEvent.click(oldTrigger);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByLabelText("随笔内容")).toHaveValue("新宿主未保存草稿");
  expect(learningContextStore.getSnapshot()).toBe(before);
  expect(before.source.reference).toMatchObject({
    surface: "result",
    questionId: "q1",
    expectedQuestionRevisionId: newRevision,
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "保存" })),
  );
  const saved = vi.mocked(enqueueMemo).mock.calls.at(-1)?.[0];
  expect(saved?.reference).toEqual(reference);
  // 记录端在打开时冻结；后来实时仓补齐canonical不重绑这条草稿。
  expect(saved?.context).toBeUndefined();
});
it("旧卷没有冻结版本事实时仍可按真实旧引用本地入队", async () => {
  const lease = learningContextStore.registerHost(
    attemptId,
    (id) => ({
      anchor: { kind: "question", attemptId, questionId: id, label: id },
      reference: {
        kind: "question",
        attemptId,
        questionId: id,
        surface: "attempt",
      },
    }),
    "draft",
  );
  render(
    <LearningHostContext value={lease}>
      <QuestionMemoCaptureProvider>
        <QuestionMemoAction
          attemptId={attemptId}
          questionId="q1"
          surface="attempt"
          standalone
        />
      </QuestionMemoCaptureProvider>
    </LearningHostContext>,
  );
  fireEvent.click(screen.getByRole("button", { name: "记随笔" }));
  fireEvent.change(screen.getByLabelText("随笔内容"), {
    target: { value: "离线旧卷草稿" },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "保存" })),
  );
  const payload = vi.mocked(enqueueMemo).mock.calls[0]?.[0];
  expect(payload?.anchor).toMatchObject({ kind: "question", questionId: "q1" });
  expect(payload?.reference).toEqual({
    kind: "question",
    attemptId,
    questionId: "q1",
    surface: "attempt",
  });
  expect(payload?.context).toBeUndefined();
});
