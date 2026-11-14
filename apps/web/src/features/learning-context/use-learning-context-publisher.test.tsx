import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LearningContext } from "@tutor/contract";
import { type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveLearningContext } from "@/lib/learning-source-legacy-api";
import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  waitFor,
} from "@/test/render-with-portal";
import { LearningContextEnvironment } from "./LearningContextEnvironment";
import { learningContextStore } from "./learning-context-store";
import { LearningPrincipalContext } from "./learning-principal";
import { useLearningContextPublisher } from "./use-learning-context-publisher";

vi.mock("@/lib/learning-source-legacy-api", () => ({
  resolveLearningContext: vi.fn(() => new Promise(() => {})),
}));
beforeEach(() => {
  vi.mocked(resolveLearningContext)
    .mockReset()
    .mockImplementation(() => new Promise(() => {}));
  learningContextStore.setVisible(true);
  learningContextStore.reset();
  learningContextStore.bindPrincipal("alice");
});
afterEach(cleanup);
it("旧主体的发布页面即使仍挂载，也不能在新principal epoch重新注册旧来源", () => {
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={query}>
      <LearningPrincipalContext value="alice">
        {children}
      </LearningPrincipalContext>
    </QueryClientProvider>
  );
  const route = crypto.randomUUID();
  const questions = [{ id: "q1", questionRevisionId: crypto.randomUUID() }];
  const hook = renderHook(
    () =>
      useLearningContextPublisher({
        route,
        surface: "attempt",
        questions,
        title: "原账号卷",
        attemptStatus: "draft",
        observedId: "q1",
      }),
    { wrapper },
  );
  expect(learningContextStore.getSnapshot().source.anchor.kind).toBe(
    "question",
  );
  act(() => learningContextStore.bindPrincipal("bob"));
  expect(learningContextStore.getSnapshot().principal).toBe("bob");
  expect(learningContextStore.getSnapshot().source.anchor).toEqual({
    kind: "none",
  });
  hook.unmount();
  query.clear();
});

it("显式题离屏且仅有关闭纸面时，滚动可以跟随新阅读题", () => {
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const route = crypto.randomUUID();
  const card = document.createElement("article");
  card.dataset.questionId = "q2";
  card.dataset.learningAttempt = route;
  card.dataset.learningSurface = "attempt";
  card.innerHTML = '<div data-slot="paper-frame" data-state="closed"></div>';
  card.getBoundingClientRect = () =>
    ({ top: -200, bottom: -100, height: 100 }) as DOMRect;
  document.body.append(card);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={query}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () =>
      useLearningContextPublisher({
        route,
        surface: "attempt",
        title: "卷",
        questions: [{ id: "q1" }, { id: "q2" }],
        observedId: "q1",
      }),
    { wrapper },
  );
  card.dataset.learningView = hook.result.current.lease?.viewId ?? "";
  act(() => hook.result.current.explicit("q2"));
  expect(learningContextStore.getSnapshot().explicit).toBe(true);
  act(() => hook.result.current.observe("q1"));
  expect(learningContextStore.getSnapshot().source.anchor).toMatchObject({
    questionId: "q1",
  });
  hook.unmount();
  card.remove();
  query.clear();
});

it("离屏显式题的输入焦点和打开弹层分别优先，blur/关闭后允许阅读接管", () => {
  const query = new QueryClient();
  const route = crypto.randomUUID();
  const card = document.createElement("article");
  card.dataset.questionId = "q2";
  card.dataset.learningAttempt = route;
  card.dataset.learningSurface = "attempt";
  card.innerHTML =
    '<input/><div data-slot="paper-frame" data-state="open"></div>';
  card.getBoundingClientRect = () =>
    ({ top: -200, bottom: -100, height: 100 }) as DOMRect;
  document.body.append(card);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={query}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () =>
      useLearningContextPublisher({
        route,
        surface: "attempt",
        title: "卷",
        questions: [{ id: "q1" }, { id: "q2" }],
        observedId: "q1",
      }),
    { wrapper },
  );
  card.dataset.learningView = hook.result.current.lease?.viewId ?? "";
  act(() => hook.result.current.explicit("q2"));
  act(() => hook.result.current.observe("q1"));
  expect(learningContextStore.getSnapshot().source.anchor).toMatchObject({
    questionId: "q2",
  });
  card.querySelector("div")?.setAttribute("data-state", "closed");
  act(() => card.querySelector("input")?.focus());
  act(() => hook.result.current.observe("q1"));
  expect(learningContextStore.getSnapshot().source.anchor).toMatchObject({
    questionId: "q2",
  });
  act(() => card.querySelector("input")?.blur());
  act(() => hook.result.current.observe("q1"));
  expect(learningContextStore.getSnapshot().source.anchor).toMatchObject({
    questionId: "q1",
  });
  hook.unmount();
  card.remove();
  query.clear();
});

it("跨路由迟到canonical不覆盖新host同名题，旧DOM交互也无发布权", async () => {
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let finish!: (c: LearningContext) => void;
  vi.mocked(resolveLearningContext).mockReturnValueOnce(
    new Promise((done) => {
      finish = done;
    }),
  );
  const oldRoute = crypto.randomUUID(),
    nextRoute = crypto.randomUUID();
  const oldRevision = crypto.randomUUID(),
    nextRevision = crypto.randomUUID();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={query}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ route, revision }) =>
      useLearningContextPublisher({
        route,
        surface: "attempt",
        title: "卷",
        questions: [{ id: "q1", questionRevisionId: revision }],
        observedId: "q1",
      }),
    { wrapper, initialProps: { route: oldRoute, revision: oldRevision } },
  );
  await waitFor(() => expect(resolveLearningContext).toHaveBeenCalledTimes(1));
  const oldView = learningContextStore.getSnapshot().host?.viewId;
  hook.rerender({ route: nextRoute, revision: nextRevision });
  await act(async () =>
    finish({
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
        attemptId: oldRoute,
        questionRevisionId: oldRevision,
        questionNo: 1,
        questionCount: 1,
        settlementSeq: null,
      },
      view: null,
      deviceId: null,
    }),
  );
  const card = document.createElement("article");
  card.dataset.questionId = "q1";
  card.dataset.learningAttempt = oldRoute;
  card.dataset.learningView = oldView ?? "";
  card.dataset.learningSurface = "attempt";
  document.body.append(card);
  act(() => fireEvent.pointerDown(card));
  const current = learningContextStore.getSnapshot();
  expect(current.host?.route).toBe(nextRoute);
  expect(current.host?.viewId).not.toBe(oldView);
  expect(current.source.reference).toMatchObject({
    attemptId: nextRoute,
    expectedQuestionRevisionId: nextRevision,
  });
  expect(current.source.context).toBeUndefined();
  expect(current.explicit).toBe(false);
  hook.unmount();
  card.remove();
  query.clear();
});

it("StrictMode真实注册清理后仍只有新host，可见性事件停发来源消费资格", () => {
  const query = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StrictMode>
      <QueryClientProvider client={query}>
        <LearningContextEnvironment principal="alice">
          {children}
        </LearningContextEnvironment>
      </QueryClientProvider>
    </StrictMode>
  );
  const route = crypto.randomUUID();
  const hook = renderHook(
    () =>
      useLearningContextPublisher({
        route,
        surface: "result",
        title: "回看",
        questions: [{ id: "q1" }],
        observedId: "q1",
        attemptStatus: "graded",
      }),
    { wrapper },
  );
  expect(learningContextStore.getSnapshot().host?.route).toBe(route);
  expect(learningContextStore.getSnapshot().source.anchor).toMatchObject({
    questionId: "q1",
  });
  act(() => window.dispatchEvent(new Event("pagehide")));
  expect(learningContextStore.getSnapshot().visible).toBe(false);
  act(() => window.dispatchEvent(new Event("pageshow")));
  expect(learningContextStore.getSnapshot().visible).toBe(true);
  hook.unmount();
  expect(learningContextStore.getSnapshot().host).toBeNull();
  expect(learningContextStore.getSnapshot().principal).toBeNull();
  query.clear();
});

it("零尺寸隐藏题卡不具备可见资格", () => {
  const query = new QueryClient(),
    route = crypto.randomUUID();
  const el = document.createElement("article");
  el.dataset.questionId = "q2";
  el.dataset.learningAttempt = route;
  el.dataset.learningSurface = "attempt";
  document.body.append(el);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={query}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () =>
      useLearningContextPublisher({
        route,
        surface: "attempt",
        title: "卷",
        questions: [{ id: "q1" }, { id: "q2" }],
        observedId: "q1",
      }),
    { wrapper },
  );
  el.dataset.learningView = hook.result.current.lease?.viewId ?? "";
  act(() => hook.result.current.explicit("q2"));
  act(() => hook.result.current.observe("q1"));
  expect(learningContextStore.getSnapshot().source.anchor).toMatchObject({
    questionId: "q1",
  });
  hook.unmount();
  el.remove();
  query.clear();
});
it("失去输入焦点时立刻重新核对显式资格，无需等下一次滚动", async () => {
  const query = new QueryClient(),
    route = crypto.randomUUID();
  const el = document.createElement("article");
  el.dataset.questionId = "q2";
  el.dataset.learningAttempt = route;
  el.dataset.learningSurface = "attempt";
  el.innerHTML = "<input/>";
  el.getBoundingClientRect = () =>
    ({ width: 100, height: 100, top: -200, bottom: -100 }) as DOMRect;
  document.body.append(el);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={query}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () =>
      useLearningContextPublisher({
        route,
        surface: "attempt",
        title: "卷",
        questions: [{ id: "q1" }, { id: "q2" }],
        observedId: "q1",
      }),
    { wrapper },
  );
  el.dataset.learningView = hook.result.current.lease?.viewId ?? "";
  const input = el.querySelector("input");
  if (!input) throw new Error("missing input");
  act(() => input.focus());
  expect(learningContextStore.getSnapshot().source.anchor).toMatchObject({
    questionId: "q2",
  });
  await act(async () => input.blur());
  expect(learningContextStore.getSnapshot().source.anchor).toMatchObject({
    questionId: "q1",
  });
  hook.unmount();
  el.remove();
  query.clear();
});

it.each([
  ["完全横向离屏", -200, 20, 100, 100, false],
  ["右侧完全离屏", innerWidth + 20, 20, 100, 100, false],
  ["横向只剩9.9%", -90.1, 20, 100, 100, false],
  ["横向恰好10%", -90, 20, 100, 100, true],
  ["二维合计9.5%", -50, -81, 100, 100, false],
  ["二维合计恰好10%", -50, -80, 100, 100, true],
  ["纵向只剩9.9%", 10, -90.1, 100, 100, false],
  ["纵向恰好10%", 10, -90, 100, 100, true],
  ["零宽", 10, 20, 0, 100, false],
  ["零高", 10, 20, 100, 0, false],
  ["正常可见", 10, 20, 100, 100, true],
] as const)(
  "显式可见资格用二维面积：%s",
  (_name, left, top, width, height, keep) => {
    const query = new QueryClient(),
      route = crypto.randomUUID();
    const el = document.createElement("article");
    el.dataset.questionId = "q2";
    el.dataset.learningAttempt = route;
    el.dataset.learningSurface = "attempt";
    el.getBoundingClientRect = () => new DOMRect(left, top, width, height);
    document.body.append(el);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={query}>{children}</QueryClientProvider>
    );
    const hook = renderHook(
      () =>
        useLearningContextPublisher({
          route,
          surface: "attempt",
          title: "卷",
          questions: [{ id: "q1" }, { id: "q2" }],
          observedId: "q1",
        }),
      { wrapper },
    );
    const lease = hook.result.current.lease;
    if (!lease) throw new Error("missing lease");
    el.dataset.learningView = lease.viewId;
    try {
      act(() => hook.result.current.explicit("q2"));
      act(() => hook.result.current.observe("q1"));
      expect(learningContextStore.getSnapshot().source.anchor).toMatchObject({
        questionId: keep ? "q2" : "q1",
      });
    } finally {
      hook.unmount();
      el.remove();
      query.clear();
    }
  },
);

it.each(["surface", "revision", "lease"] as const)(
  "旧DOM的pointer/focus不改变新仓：%s不匹配",
  (mismatch) => {
    const query = new QueryClient(),
      route = crypto.randomUUID(),
      revision = crypto.randomUUID();
    const old = learningContextStore.registerHost(route, () => null, "draft");
    const el = document.createElement("article");
    el.dataset.questionId = "q1";
    el.dataset.learningAttempt = route;
    el.dataset.learningSurface = mismatch === "surface" ? "result" : "attempt";
    el.dataset.learningRevision =
      mismatch === "revision" ? crypto.randomUUID() : revision;
    el.innerHTML = "<input/>";
    document.body.append(el);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={query}>{children}</QueryClientProvider>
    );
    const hook = renderHook(
      () =>
        useLearningContextPublisher({
          route,
          surface: "attempt",
          title: "卷",
          questions: [{ id: "q1", questionRevisionId: revision }, { id: "q2" }],
          observedId: "q2",
        }),
      { wrapper },
    );
    const lease = hook.result.current.lease;
    if (!lease) throw new Error("missing lease");
    el.dataset.learningView = mismatch === "lease" ? old.viewId : lease.viewId;
    try {
      const before = learningContextStore.getSnapshot();
      act(() => fireEvent.pointerDown(el));
      act(() => el.querySelector("input")?.focus());
      expect(learningContextStore.getSnapshot()).toBe(before);
    } finally {
      hook.unmount();
      el.remove();
      query.clear();
    }
  },
);

it.each(["focus", "editor", "overlay"] as const)(
  "横向离屏时明确%s资格仍保护本人显式题",
  (mode) => {
    const query = new QueryClient(),
      route = crypto.randomUUID();
    const el = document.createElement("article");
    el.dataset.questionId = "q2";
    el.dataset.learningAttempt = route;
    el.dataset.learningSurface = "attempt";
    el.innerHTML = "<input/><details></details>";
    el.getBoundingClientRect = () => new DOMRect(innerWidth + 20, 20, 100, 100);
    document.body.append(el);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={query}>{children}</QueryClientProvider>
    );
    const hook = renderHook(
      () =>
        useLearningContextPublisher({
          route,
          surface: "attempt",
          title: "卷",
          questions: [{ id: "q1" }, { id: "q2" }],
          observedId: "q1",
          isEditing: (id) => mode === "editor" && id === "q2",
        }),
      { wrapper },
    );
    const lease = hook.result.current.lease;
    if (!lease) throw new Error("missing lease");
    el.dataset.learningView = lease.viewId;
    try {
      act(() => hook.result.current.explicit("q2"));
      if (mode === "focus") act(() => el.querySelector("input")?.focus());
      if (mode === "overlay")
        el.querySelector("details")?.setAttribute("open", "");
      act(() => hook.result.current.observe("q1"));
      expect(learningContextStore.getSnapshot().source.anchor).toMatchObject({
        questionId: "q2",
      });
    } finally {
      hook.unmount();
      el.remove();
      query.clear();
    }
  },
);
