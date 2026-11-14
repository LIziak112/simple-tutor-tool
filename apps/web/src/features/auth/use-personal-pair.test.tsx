import type { PersonalSessionData } from "@tutor/contract";
import { expect, it, vi } from "vitest";
import {
  createTestRuntime,
  TestPortalProvider,
  testClientServices,
} from "@/test/portal-fixture";
import { act, renderHook, waitFor } from "@/test/render-with-portal";
import { usePersonalPair } from "./use-personal-pair";

const pair = {
  teacher: { id: "t", accountKind: "personal" },
  student: { id: "s", accountKind: "personal" },
} as PersonalSessionData;
it("同账号的新租约重新核验，旧租约迟到不能认证新门户", async () => {
  let resolveFirst: ((value: PersonalSessionData | null) => void) | undefined;
  const first = {
    ...testClientServices,
    checkPersonalSessionApi: vi.fn(
      () =>
        new Promise<PersonalSessionData | null>((resolve) => {
          resolveFirst = resolve;
        }),
    ),
  };
  const second = {
    ...testClientServices,
    checkPersonalSessionApi: vi.fn(async () => pair),
  };
  let runtime = createTestRuntime({ clients: first });
  const accepted = vi.fn();
  const result = renderHook(() => usePersonalPair("student", "s", accepted), {
    wrapper: ({ children }) => (
      <TestPortalProvider runtime={runtime}>{children}</TestPortalProvider>
    ),
  });
  expect(result.result.current.status).toBe("pending");
  runtime = createTestRuntime({ clients: second });
  result.rerender();
  await waitFor(() => expect(result.result.current.status).toBe("verified"));
  await act(async () => resolveFirst?.(null));
  expect(result.result.current.status).toBe("verified");
  expect(accepted).toHaveBeenCalledTimes(1);
  runtime = createTestRuntime({ clients: first });
  result.rerender();
  expect(result.result.current.status).toBe("pending");
});
it("双会话不配对或返回另一主体时不展示门户", async () => {
  let response: PersonalSessionData | null = null;
  const clients = {
    ...testClientServices,
    checkPersonalSessionApi: vi.fn(async () => response),
  };
  const accepted = vi.fn();
  const runtime = createTestRuntime({ clients });
  const result = renderHook(() => usePersonalPair("student", "s", accepted), {
    wrapper: ({ children }) => (
      <TestPortalProvider runtime={runtime}>{children}</TestPortalProvider>
    ),
  });
  await waitFor(() => expect(result.result.current.status).toBe("login"));
  response = pair;
  await act(async () => result.result.current.retry());
  await waitFor(() => expect(result.result.current.status).toBe("verified"));
  response = { ...pair, student: { ...pair.student, id: "other" } };
  await act(async () => result.result.current.retry());
  await waitFor(() => expect(result.result.current.status).toBe("error"));
  expect(accepted).toHaveBeenCalledTimes(1);
});
