import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { StudentMeData } from "@tutor/contract";
import { StrictMode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentDraftSession } from "@/features/attempt/draft-store";
import StudentLinkLoginPage from "./StudentLinkLoginPage";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (cause: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const student = (id: string, displayName = id): StudentMeData => ({
  id,
  displayName,
  loginName: id,
  linkEnabled: true,
  passwordEnabled: false,
  accountKind: "class",
});
const A = student("11111111-1111-4111-8111-111111111111", "学生甲");
const B = student("22222222-2222-4222-8222-222222222222", "学生乙");
const shell = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data }), {
    headers: { "content-type": "application/json" },
  });
type LinkCall = {
  token: string;
  signal: AbortSignal | null | undefined;
  reply: ReturnType<typeof deferred<Response>>;
};
let links: LinkCall[];
let paths: string[];
function mount(
  token = "link-a",
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  const router = createMemoryRouter(
    [
      { path: "/s/:token", element: <StudentLinkLoginPage /> },
      { path: "/s/home", element: <p>学生首页</p> },
      { path: "/away", element: <p>已离开入口</p> },
    ],
    { initialEntries: [`/s/${token}`] },
  );
  const view = render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
  return { ...view, client, router };
}
async function ready(token: string) {
  await waitFor(() =>
    expect(links.some((call) => call.token === token)).toBe(true),
  );
}
async function answer(token: string, me: StudentMeData) {
  await act(async () => {
    for (const call of links.filter((item) => item.token === token))
      call.reply.resolve(shell(me));
  });
}
async function home() {
  expect(await screen.findByText("学生首页")).toBeVisible();
}

beforeEach(() => {
  links = [];
  paths = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        "http://localhost",
      );
      paths.push(url.pathname);
      if (url.pathname.startsWith("/api/public/s/")) {
        const reply = deferred<Response>();
        links.push({
          token: decodeURIComponent(url.pathname.split("/").at(-1) ?? ""),
          signal: init?.signal,
          reply,
        });
        // 故意允许取消后仍完成，验证入口门不能只依赖传输层配合。
        return reply.promise;
      }
      if (url.pathname.endsWith("/logout")) return shell(null);
      return shell({ assignments: [], courses: [], lectures: [] });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("专属链接真实页面入口生命周期（StrictMode，真实RPC/fetch边界）", () => {
  it("同入口同token只发一个HTTP，第二setup接收延迟结果并只应用一次身份/预取", async () => {
    const { client } = mount();
    const applied = vi.spyOn(client, "setQueryData");
    await ready("link-a");
    expect(links).toHaveLength(1);
    expect(links[0]?.signal?.aborted).toBe(false);
    expect(screen.getByText("正在通过专属链接登录…")).toBeVisible();
    await answer("link-a", A);
    await home();
    expect(client.getQueryData(["student", "me"])).toEqual(A);
    expect(
      applied.mock.calls.filter(
        ([key]) => JSON.stringify(key) === '["student","me"]',
      ),
    ).toHaveLength(1);
    for (const path of ["assignments", "courses", "lectures"])
      expect(
        paths.filter((item) => item === `/api/student/${path}`),
      ).toHaveLength(1);
    expect(currentDraftSession()?.studentId).toBe(A.id);
  });
  it("首次网络失败后人工retry确实发新请求，不复用失败结果", async () => {
    mount();
    await ready("link-a");
    await act(async () => {
      for (const call of links)
        call.reply.reject(new Error("fixture network failure"));
    });
    const retry = await screen.findByRole("button", { name: "重试" });
    const before = links.length;
    fireEvent.click(retry);
    await waitFor(() => expect(links).toHaveLength(before + 1));
    await answer("link-a", A);
    await home();
  });
  it("tokenA到B自动新兑换并abort A，晚A不得覆盖B身份、草稿或预取", async () => {
    const { client, router } = mount();
    await ready("link-a");
    await act(async () => {
      await router.navigate("/s/link-b");
    });
    await ready("link-b");
    expect(
      links
        .filter((call) => call.token === "link-a")
        .every((call) => call.signal?.aborted),
    ).toBe(true);
    await answer("link-b", B);
    await home();
    client.setQueryData(["student", "private-b"], { preserved: true });
    await answer("link-a", A);
    expect(client.getQueryData(["student", "me"])).toEqual(B);
    expect(client.getQueryData(["student", "private-b"])).toEqual({
      preserved: true,
    });
    expect(currentDraftSession()?.studentId).toBe(B.id);
    for (const path of ["assignments", "courses", "lectures"])
      expect(
        paths.filter((item) => item === `/api/student/${path}`),
      ).toHaveLength(1);
  });
  it("A已在cancelQueries内等待时，B完成后晚A不得remove新B缓存或再绑定A", async () => {
    const { client, router } = mount();
    await ready("link-a");
    const cancelled = deferred<void>();
    const cancel = vi
      .spyOn(client, "cancelQueries")
      .mockImplementationOnce(() => cancelled.promise);
    await answer("link-a", A);
    await waitFor(() => expect(cancel).toHaveBeenCalled());
    await act(async () => {
      await router.navigate("/s/link-b");
    });
    await ready("link-b");
    await answer("link-b", B);
    await home();
    client.setQueryData(["student", "fresh-b"], { preserved: true });
    await act(async () => cancelled.resolve());
    expect(client.getQueryData(["student", "fresh-b"])).toEqual({
      preserved: true,
    });
    expect(client.getQueryData(["student", "me"])).toEqual(B);
    expect(currentDraftSession()?.studentId).toBe(B.id);
  });
  it("真正卸载使在途请求失效，迟到结果不能向已离开入口写登录态", async () => {
    const view = mount();
    await ready("link-a");
    view.unmount();
    await answer("link-a", A);
    expect(links.every((call) => call.signal?.aborted)).toBe(true);
    expect(view.client.getQueryData(["student", "me"])).toBeUndefined();
  });
  it("真正卸载后同链接是新入口、新HTTP，旧完成不能替换新结果", async () => {
    const first = mount();
    await ready("link-a");
    first.unmount();
    const prior = [...links];
    const second = mount("link-a", first.client);
    await waitFor(() => expect(links.length).toBeGreaterThan(prior.length));
    const fresh = links.filter((call) => !prior.includes(call));
    expect(fresh).toHaveLength(1);
    await act(async () => {
      for (const call of fresh) call.reply.resolve(shell(B));
    });
    await home();
    await act(async () => {
      for (const call of prior) call.reply.resolve(shell(A));
    });
    expect(second.client.getQueryData(["student", "me"])).toEqual(B);
  });
  it("成功离开并清身份后同链接重新进入，不复用历史已完成会话", async () => {
    const first = mount();
    await ready("link-a");
    await answer("link-a", A);
    await home();
    first.unmount();
    first.client.clear();
    const before = links.length;
    const second = mount("link-a", first.client);
    await waitFor(() => expect(links).toHaveLength(before + 1));
    await act(async () => links.at(-1)?.reply.resolve(shell(B)));
    await home();
    expect(second.client.getQueryData(["student", "me"])).toEqual(B);
  });
});
