import { expect, it, vi } from "vitest";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@/test/render-with-portal";

const { scope, backend } = vi.hoisted(() => ({
  scope: {
    origin: "https://test.invalid",
    studentId: "student",
    generation: 1,
  },
  backend: {
    get: vi.fn(),
    set: vi.fn(async () => {}),
    del: vi.fn(async () => {}),
    getAll: vi.fn(async () => []),
  },
}));
vi.mock("@/lib/kv-backend", async (original) => ({
  ...(await original<typeof import("@/lib/kv-backend")>()),
  idbKVBackend: () => backend,
}));
vi.mock("@/features/notes/use-note-head", async (original) => ({
  ...(await original<typeof import("@/features/notes/use-note-head")>()),
  useNoteSessionRef: () => scope,
}));
vi.mock("@/features/notes/note-sync", async (original) => ({
  ...(await original<typeof import("@/features/notes/note-sync")>()),
  currentNoteSession: () => scope,
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  questionProcessStatusApi: async () => ({
    state: "active",
    canCapture: true,
    recordingId: "863de11a-f212-46e1-b876-d3a29e07df55",
    expiresAt: "2099-01-01T00:00:00Z",
  }),
}));

import {
  QuestionProcessControls,
  QuestionProcessSyncNotice,
  useQuestionProcess,
} from "./session";

it("已开启录制但提示缓存读失败时显式告警，恢复读取后再创建录制器", async () => {
  backend.get
    .mockRejectedValueOnce(new Error("IDB read failed"))
    .mockResolvedValue(undefined);
  const view = renderHook(() =>
    useQuestionProcess({
      attemptId: "attempt",
      enabled: true,
      ready: true,
      questions: [],
      answers: {},
      hintsOpened: {},
    }),
  );
  await waitFor(() => expect(view.result.current.status?.state).toBe("active"));
  expect(view.result.current.cacheFailed).toBe(true);
  expect(view.result.current.recorder).toBeNull();
  const ui = render(
    <>
      <QuestionProcessControls process={view.result.current} />
      <QuestionProcessSyncNotice process={view.result.current} />
    </>,
  );
  expect(screen.queryByText("过程已同步")).not.toBeInTheDocument();
  expect(screen.getByText("过程记录的本机状态未能保存。")).toBeVisible();
  expect(
    screen.getAllByText("当前操作未被记录（录制器尚未就绪）"),
  ).toHaveLength(2);
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  await waitFor(() => expect(view.result.current.recorder).not.toBeNull());
  expect(view.result.current.cacheFailed).toBe(false);
  ui.unmount();
  view.unmount();
});
