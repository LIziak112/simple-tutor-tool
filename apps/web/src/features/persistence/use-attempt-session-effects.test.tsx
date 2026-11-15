import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import type { AttemptSummary } from "@tutor/contract";
import type { ReactNode } from "react";
import { act } from "react";
import { expect, it } from "vitest";
import { renderHook, waitFor } from "@/test/render-with-portal";
import {
  useAttemptSessionEffects,
  useCachedAttempt,
} from "./use-attempt-session-effects";

const opened: AttemptSummary = {
  id: "88888888-8888-4888-8888-888888888888",
  sourceType: "course",
  courseId: "22222222-2222-4222-8222-222222222222",
  unitId: "u",
  assignmentId: null,
  lectureId: null,
  status: "draft",
  phase: "opened",
  activatedAt: null,
  frozenAt: "2026-11-14T00:00:00.000Z",
  attemptNo: 3,
  startedAt: "2026-11-14T00:00:00.000Z",
  submittedAt: null,
  scoreAuto: null,
};
const active: AttemptSummary = {
  ...opened,
  phase: "active",
  activatedAt: "2026-11-14T00:01:00.000Z",
};
const KEY = ["student", "attempt", opened.id] as const;
const LIST = ["student", "course", opened.courseId, "unit", "u"] as const;

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

it("卷的摘要跟着查询缓存走：这份卷的数据换了才重渲染，别的查询变化不重渲染", async () => {
  const { client, wrapper } = setup();
  let renders = 0;
  const { result } = renderHook(
    () => {
      renders += 1;
      return useCachedAttempt(KEY);
    },
    { wrapper },
  );
  expect(result.current).toBeUndefined();

  act(() => {
    client.setQueryData(KEY, { attempt: opened, title: "练习" });
  });
  await waitFor(() => expect(result.current).toEqual(opened));
  const settled = renders;

  // 别的查询写入、同一份卷重取到内容相同的数据：都不重渲染
  act(() => {
    client.setQueryData(LIST, { seeded: 1 });
    client.setQueryData(KEY, { attempt: { ...opened }, title: "练习" });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(renders).toBe(settled);

  act(() => {
    client.setQueryData(KEY, { attempt: active, title: "练习" });
  });
  await waitFor(() => expect(result.current).toEqual(active));
});

it("副作用不读取数 hook 的返回值：只在事后读 isError 的调用方仍收得到失败", async () => {
  const { client, wrapper } = setup();
  client.setQueryData(KEY, { attempt: opened });
  let fail: ((error: Error) => void) | undefined;
  const { result } = renderHook(
    () => {
      const query = useQuery({
        queryKey: KEY,
        queryFn: () =>
          new Promise<{ attempt: AttemptSummary }>((_resolve, reject) => {
            fail = reject;
          }),
        staleTime: 0,
      });
      useAttemptSessionEffects(KEY);
      return query;
    },
    { wrapper },
  );
  await waitFor(() => expect(fail).toBeDefined());
  await act(async () => {
    fail?.(new Error("已撤销权限"));
  });
  // 渲染时没有读过任何属性：失败必须通知到，不能因为 hook 里读过 data 而漏掉
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.data).toEqual({ attempt: opened });
});

it("拿到未激活的卷后看到它被激活：列表类查询过期（副作用接上了缓存里的卷）", async () => {
  const { client, wrapper } = setup();
  client.setQueryData(LIST, { seeded: 1 });
  client.setQueryData(KEY, { attempt: opened });
  renderHook(() => useAttemptSessionEffects(KEY), { wrapper });
  expect(client.getQueryState(LIST)?.isInvalidated).toBe(false);
  act(() => {
    client.setQueryData(KEY, { attempt: active });
  });
  await waitFor(() =>
    expect(client.getQueryState(LIST)?.isInvalidated).toBe(true),
  );
  expect(client.getQueryState(KEY)?.isInvalidated).toBe(false);
});
