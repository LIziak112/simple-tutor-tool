import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AttemptContextData, AttemptSummary } from "@tutor/contract";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  installAttemptSessionBackend,
  readLocalAttemptSessions,
  saveLocalAttemptSession,
} from "@/features/persistence/attempt-session-catalog";
import {
  bindDraftSession,
  installDraftBackend,
  memoryBackend,
} from "@/features/persistence/draft-store";
import { fetchAttemptContextApi } from "@/lib/api";
import { renderHook, waitFor } from "@/test/render-with-portal";
import { useAttemptContext } from "./attempt-queries";

/**
 * 冻结上下文查询与卷的冻结版本：没动过的卷再次进入时可能按新题目重冻（卷号
 * 不变、冻结时刻前进）。上下文缓存不过期，所以冻结时刻必须进查询键；取到的
 * 材料版本补记进本机会话目录，且只记到同一冻结版本的目录项上。
 */

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  fetchAttemptContextApi: vi.fn(),
}));
const mockedContext = vi.mocked(fetchAttemptContextApi);

const attempt: AttemptSummary = {
  id: "55555555-5555-4555-8555-555555555555",
  sourceType: "course",
  courseId: "22222222-2222-4222-8222-222222222222",
  unitId: "u",
  assignmentId: null,
  lectureId: null,
  status: "draft",
  phase: "opened",
  activatedAt: null,
  frozenAt: "2026-11-14T00:00:00.000Z",
  attemptNo: 1,
  startedAt: "2026-11-14T00:00:00.000Z",
  submittedAt: null,
  scoreAuto: null,
};
const REFROZEN_AT = "2026-11-14T00:00:00.001Z";
const contextOf = (sourceVersion: number): AttemptContextData => ({
  attemptId: attempt.id,
  materials: [
    {
      id: "m",
      title: "材料",
      contentMd: `第 ${sourceVersion} 版正文`,
      anchors: [],
      slots: [],
      mediaPaths: [],
      sourceVersion,
    },
  ],
  groups: [],
});
const recordedMaterials = async () =>
  (await readLocalAttemptSessions())[attempt.id]?.materials;

beforeEach(() => {
  mockedContext.mockReset();
  installDraftBackend(memoryBackend());
  installAttemptSessionBackend(memoryBackend());
  bindDraftSession({ origin: "test", studentId: "A" });
});

function renderContext(frozenAt: string | null | undefined) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    (props: { frozenAt: string | null | undefined }) =>
      useAttemptContext(attempt.id, props.frozenAt),
    { wrapper, initialProps: { frozenAt } },
  );
}

it("同一份卷重冻后换一份上下文，材料版本补记到本机目录的同一冻结版本上", async () => {
  await saveLocalAttemptSession({ attempt, questions: {} });
  mockedContext
    .mockResolvedValueOnce(contextOf(1))
    .mockResolvedValueOnce(contextOf(2));
  const { result, rerender } = renderContext(attempt.frozenAt);
  await waitFor(() =>
    expect(result.current.data?.materials[0]?.sourceVersion).toBe(1),
  );
  await waitFor(async () => expect(await recordedMaterials()).toEqual(["m|1"]));

  // 同一冻结版本再渲染：缓存不过期，不再请求
  rerender({ frozenAt: attempt.frozenAt });
  expect(mockedContext).toHaveBeenCalledTimes(1);

  // 卷重冻：详情加载已把目录跟到新版本、旧材料版本作废；上下文按新键重新取
  await saveLocalAttemptSession({
    attempt: { ...attempt, frozenAt: REFROZEN_AT },
    questions: {},
    materials: undefined,
  });
  rerender({ frozenAt: REFROZEN_AT });
  await waitFor(() =>
    expect(result.current.data?.materials[0]?.sourceVersion).toBe(2),
  );
  expect(mockedContext).toHaveBeenCalledTimes(2);
  await waitFor(async () => expect(await recordedMaterials()).toEqual(["m|2"]));
});

it("目录已被别的标签页跟到重冻后的版本：这一页取到的旧版材料号不盖上去", async () => {
  await saveLocalAttemptSession({
    attempt: { ...attempt, frozenAt: REFROZEN_AT },
    questions: {},
    materials: ["m|2"],
  });
  mockedContext.mockResolvedValue(contextOf(1));
  const { result } = renderContext(attempt.frozenAt);
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  // 补记是不等待的：让排队的目录写入跑完再看
  await saveLocalAttemptSession({
    attempt: { ...attempt, frozenAt: REFROZEN_AT },
    questions: {},
  });
  expect(await recordedMaterials()).toEqual(["m|2"]);
});

it("目录里没有这份卷（结果回看、别人的卷）：只取上下文，不往目录里写", async () => {
  mockedContext.mockResolvedValue(contextOf(1));
  const { result } = renderContext(undefined);
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  await saveLocalAttemptSession({
    attempt: { ...attempt, id: "66666666-6666-4666-8666-666666666666" },
    questions: {},
  });
  expect(await recordedMaterials()).toBeUndefined();
  expect(Object.keys(await readLocalAttemptSessions())).toEqual([
    "66666666-6666-4666-8666-666666666666",
  ]);
});
