import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AttemptSummary, InkDoc } from "@tutor/contract";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortalRuntimeProvider } from "@/features/runtime/portal-runtime";
import { createTestRuntime, testClientServices } from "@/test/portal-fixture";
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
import { useLocalAttemptActivation } from "./use-local-attempt-activation";

const attempt: AttemptSummary = {
  id: "a",
  sourceType: "course",
  courseId: "c",
  unitId: "u",
  assignmentId: null,
  lectureId: null,
  status: "draft",
  phase: "opened",
  activatedAt: null,
  frozenAt: "2026-11-14T00:00:00.000Z",
  attemptNo: 1,
  startedAt: "now",
  submittedAt: null,
  scoreAuto: null,
};
const ink: InkDoc = {
  engine: "atrament",
  version: 1,
  updatedAt: 1,
  data: {
    width: 1000,
    strokes: [
      {
        tool: "pen",
        color: "black",
        weight: 2,
        points: [{ x: 1, y: 1, p: 0.5, t: 1 }],
      },
    ],
  },
};
const activate = vi.fn().mockResolvedValue({
  attemptId: "a",
  activatedAt: attempt.frozenAt,
  phase: "active",
  frozenAt: attempt.frozenAt,
});
function mount() {
  const cache = new QueryClient();
  const runtime = createTestRuntime({
    clients: { ...testClientServices, activateAttemptApi: activate },
  });
  return renderHook(() => useLocalAttemptActivation(attempt), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={cache}>
        <PortalRuntimeProvider runtime={runtime}>
          {children}
        </PortalRuntimeProvider>
      </QueryClientProvider>
    ),
  });
}
beforeEach(async () => {
  activate.mockClear();
  installDraftBackend(memoryBackend());
  installAttemptSessionBackend(memoryBackend());
  bindDraftSession({ origin: "test", studentId: "A" });
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  await saveLocalAttemptSession({ attempt, questions: {}, materials: ["m|1"] });
});
afterEach(() => vi.restoreAllMocks());
describe("材料第一笔激活真实本机路径", () => {
  it("答案和正式手写交给实际PUT激活，不先发独立激活请求", async () => {
    mount();
    await act(async () => {
      draftStore.saveAnswer("a", "q", { kind: "choice", index: 0 });
      draftStore.saveInk("a", "q", ink, attempt.frozenAt);
      await draftStore.flush("a");
      window.dispatchEvent(new Event("focus"));
    });
    expect(activate).not.toHaveBeenCalled();
  });
  it("材料第一笔后离线擦除全部，重连仍按原笔迹凭据激活", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    mount();
    await act(async () => {
      draftStore.saveMaterialInk("a", "m|1", ink, attempt.frozenAt);
      draftStore.saveMaterialInk(
        "a",
        "m|1",
        { ...ink, data: { width: 1000, strokes: [] } },
        attempt.frozenAt,
      );
      await draftStore.flush("a");
    });
    expect(activate).not.toHaveBeenCalled();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
  });
  it("只打开或展开不激活；第一笔落盘后激活一次，空笔迹不激活", async () => {
    mount();
    await act(async () => {
      draftStore.saveMaterialInk("a", "m|1", {
        ...ink,
        data: { width: 1000, strokes: [] },
      });
      await draftStore.flush("a");
    });
    expect(activate).not.toHaveBeenCalled();
    await act(async () => {
      draftStore.saveMaterialInk("a", "m|1", ink, attempt.frozenAt);
      await draftStore.flush("a");
    });
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    expect(activate).toHaveBeenCalledWith("a", {
      expectedFrozenAt: attempt.frozenAt,
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    });
    expect(activate).toHaveBeenCalledTimes(1);
  });
  it("离线第一笔持久保存，页面重载后联网自动补激活", async () => {
    const backend = memoryBackend();
    installDraftBackend(backend);
    bindDraftSession({ origin: "test", studentId: "A" });
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const view = mount();
    await act(async () => {
      draftStore.saveMaterialInk("a", "m|1", ink, attempt.frozenAt);
      await draftStore.flush("a");
    });
    expect(activate).not.toHaveBeenCalled();
    view.unmount();
    installDraftBackend(backend);
    bindDraftSession({ origin: "test", studentId: "A" });
    mount();
    expect(activate).not.toHaveBeenCalled();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    expect((await draftStore.loadDraft("a"))?.materialInks?.["m|1"]).toEqual(
      ink,
    );
  });
  it("账号切换后旧视图的联网回调不能激活新账号", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    mount();
    draftStore.saveMaterialInk("a", "m|1", ink, attempt.frozenAt);
    await draftStore.flush("a");
    bindDraftSession({ origin: "test", studentId: "B" });
    bindDraftSession({ origin: "test", studentId: "A" });
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(activate).not.toHaveBeenCalled();
  });
});
