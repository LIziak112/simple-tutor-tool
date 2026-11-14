import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PersonalSessionData } from "@tutor/contract";
import { Profiler } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { expect, it, vi } from "vitest";
import { PortalHost } from "@/portals/PortalHost";
import PersonalLayout from "@/portals/personal/PersonalLayout";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/test/render-with-portal";

for (const timing of ["before-error", "before-navigation"] as const)
  it(`真实Host ${timing}同ID外部写后旧pair401不跳登录且允许重新核验`, async () => {
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
    const cache = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    cache.setQueryData(["student", "me"], pair.student);
    cache.setQueryData(["teacher", "me"], pair.teacher);
    let release: (value: Response) => void = () => {};
    const send = vi.fn<typeof fetch>((input) => {
      const path = String(input);
      if (!path.includes("/personal/session/check"))
        throw new Error(`unexpected request ${path}`);
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    vi.stubGlobal("fetch", send);
    let updateOnCommit = false;
    const view = render(
      <Profiler
        id="pair-consumer"
        onRender={() => {
          if (updateOnCommit) {
            updateOnCommit = false;
            cache.setQueryData(["teacher", "me"], pair.teacher);
          }
        }}
      >
        <QueryClientProvider client={cache}>
          <MemoryRouter initialEntries={["/p/learn/home"]}>
            <PortalHost>
              <Routes>
                <Route path="/p/learn" element={<PersonalLayout />}>
                  <Route path="home" element={<p>个人学习内容</p>} />
                </Route>
                <Route
                  path="/p/login"
                  element={<p>真实Host旧核验登录跳转</p>}
                />
              </Routes>
            </PortalHost>
          </MemoryRouter>
        </QueryClientProvider>
      </Profiler>,
    );
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await act(async () => {
      if (timing === "before-error")
        cache.setQueryData(["teacher", "me"], pair.teacher);
      else updateOnCommit = true;
      release(
        new Response(
          JSON.stringify({
            ok: false,
            error: "UNAUTHORIZED",
            message: "旧核验401",
          }),
          { status: 401 },
        ),
      );
    });
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(
      screen.queryByText("真实Host旧核验登录跳转"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await act(async () =>
      release(new Response(JSON.stringify({ ok: true, data: pair }))),
    );
    expect(await screen.findByText("个人学习内容")).toBeVisible();
    expect(cache.getQueryData(["teacher", "me"])).toEqual(pair.teacher);
    expect(cache.getQueryData(["student", "me"])).toEqual(pair.student);
    view.unmount();
    cache.clear();
    vi.unstubAllGlobals();
  });
