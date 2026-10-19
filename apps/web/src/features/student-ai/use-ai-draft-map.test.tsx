import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it } from "vitest";
import { useAiDraftMap } from "./use-ai-draft-map";

it("切到设置再回来恢复内存草稿，换卷和清账号缓存后隔离", async () => {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const first = renderHook(
    () => useAiDraftMap<string>("question", "attempt-a"),
    { wrapper },
  );
  act(() =>
    first.result.current[1]((previous) =>
      new Map(previous).set("q1", "我卡在第二步"),
    ),
  );
  await waitFor(() =>
    expect(first.result.current[0].get("q1")).toBe("我卡在第二步"),
  );
  first.unmount();
  const reopened = renderHook(
    () => useAiDraftMap<string>("question", "attempt-a"),
    { wrapper },
  );
  expect(reopened.result.current[0].get("q1")).toBe("我卡在第二步");
  const other = renderHook(
    () => useAiDraftMap<string>("question", "attempt-b"),
    { wrapper },
  );
  expect(other.result.current[0].size).toBe(0);
  reopened.unmount();
  other.unmount();
  client.removeQueries({ queryKey: ["student"] });
  const nextAccount = renderHook(
    () => useAiDraftMap<string>("question", "attempt-a"),
    { wrapper },
  );
  expect(nextAccount.result.current[0].size).toBe(0);
});
