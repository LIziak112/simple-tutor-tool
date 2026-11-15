import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PersonalSessionData } from "@tutor/contract";
import { MemoryRouter, useLocation } from "react-router";
import { expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-response";
import {
  createTestRuntime,
  TestPortalProvider,
  testClientServices,
} from "@/test/portal-fixture";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/test/render-with-portal";
import { PersonalViewButton } from "./PersonalViewButton";

const pair: PersonalSessionData = {
  student: {
    id: "s",
    displayName: "甲",
    loginName: "s",
    accountKind: "personal",
    linkEnabled: false,
    passwordEnabled: true,
  },
  teacher: {
    id: "t",
    loginName: "t",
    accountKind: "personal",
    isAdmin: false,
    createdAt: "2026-01-01",
  },
};
function Location() {
  return <output aria-label="地址">{useLocation().pathname}</output>;
}
for (const timing of ["same-id", "restore", "stale-unauthorized"] as const)
  it(`切视角${timing}不认领外部身份或旧核验结果`, async () => {
    const cache = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    cache.setQueryData(["student", "me"], pair.student);
    cache.setQueryData(
      ["teacher", "me"],
      timing === "restore" ? { ...pair.teacher, id: "old" } : pair.teacher,
    );
    let resolve: (value: PersonalSessionData | null) => void = () => {},
      reject: (error: Error) => void = () => {};
    const clients = {
      ...testClientServices,
      checkPersonalSessionApi: vi.fn(
        () =>
          new Promise<PersonalSessionData | null>((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      ),
      fetchStudentCoursesApi: vi.fn(async () => ({ courses: [] })),
      fetchStudentLecturesApi: vi.fn(async () => ({
        lectures: [],
        courses: [],
      })),
    };
    let changed = false;
    const stop = cache.getQueryCache().subscribe((event) => {
      if (
        timing === "restore" &&
        event.type === "updated" &&
        event.action.type === "success" &&
        event.query.queryKey[0] === "teacher" &&
        (event.query.state.data as { id: string })?.id === "t" &&
        !changed
      ) {
        changed = true;
        queueMicrotask(() =>
          cache.setQueryData(["teacher", "me"], pair.teacher),
        );
      }
    });
    const view = render(
      <QueryClientProvider client={cache}>
        <TestPortalProvider runtime={createTestRuntime({ clients })}>
          <MemoryRouter initialEntries={["/current"]}>
            <PersonalViewButton from="student" to="/destination">
              切视角
            </PersonalViewButton>
            <Location />
          </MemoryRouter>
        </TestPortalProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "切视角" }));
    await waitFor(() =>
      expect(clients.checkPersonalSessionApi).toHaveBeenCalled(),
    );
    await act(async () => {
      if (timing !== "restore")
        cache.setQueryData(
          ["teacher", "me"],
          timing === "same-id"
            ? pair.teacher
            : { ...pair.teacher, id: "external-b" },
        );
      if (timing === "stale-unauthorized")
        reject(new ApiError("UNAUTHORIZED", "已退出", 401));
      else resolve(pair);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "账号状态已变化",
    );
    expect(screen.getByLabelText("地址")).toHaveTextContent("/current");
    stop();
    view.unmount();
    cache.clear();
  });
