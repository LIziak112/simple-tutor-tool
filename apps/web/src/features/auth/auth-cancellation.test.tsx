import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TeacherInfo } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { PortalHost } from "@/portals/PortalHost";
import { act, renderHook, waitFor } from "@/test/render-with-portal";
import { useApplyTeacherAuthed } from "./teacher-auth";

const a: TeacherInfo = {
  id: "teacher-a",
  loginName: "a",
  accountKind: "class",
  isAdmin: false,
  createdAt: "2026-01-01",
};
const b: TeacherInfo = { ...a, id: "teacher-b", loginName: "b" };
it("教师apply clear同act期间外部B不被覆写，取消必须reject", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["teacher", "me"], a);
  let release = () => {};
  const cancel = vi.spyOn(client, "cancelQueries").mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const view = renderHook(() => useApplyTeacherAuthed(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/t/login"]}>
          <PortalHost>{children}</PortalHost>
        </MemoryRouter>
      </QueryClientProvider>
    ),
  });
  let pending: Promise<unknown> = Promise.resolve();
  act(() => {
    pending = view.result.current(a).catch((error) => error);
  });
  await waitFor(() => expect(cancel).toHaveBeenCalled());
  let result: unknown;
  await act(async () => {
    client.setQueryData(["teacher", "me"], b);
    client.setQueryData(["teacher", "private-b"], "B");
    release();
    result = await pending;
  });
  expect(client.getQueryData(["teacher", "me"])).toEqual(b);
  expect(client.getQueryData(["teacher", "private-b"])).toBe("B");
  expect(result).toBeInstanceOf(Error);
  view.unmount();
  client.clear();
});
