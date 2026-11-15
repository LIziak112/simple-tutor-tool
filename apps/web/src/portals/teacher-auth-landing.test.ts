import { QueryClient } from "@tanstack/react-query";
import type { TeacherInfo } from "@tutor/contract";
import { afterEach, expect, it, vi } from "vitest";
import { createAuthOperation } from "@/features/auth/auth-operation";
import { waitFor } from "@/test/render-with-portal";
import { teacherLandingAfterAuth } from "./teacher-auth-landing";

const teacher: TeacherInfo = {
  id: "a",
  loginName: "a",
  accountKind: "class",
  isAdmin: false,
  createdAt: "2026-01-01",
};
afterEach(() => vi.unstubAllGlobals());
it("教师新短lease外部B后拒绝旧正文落点，finally释放且不借B端口", async () => {
  const cache = new QueryClient();
  cache.setQueryData(["teacher", "me"], teacher);
  const operation = createAuthOperation(cache);
  operation.select(["teacher"]);
  let release: (data: Response) => void = () => {};
  let signal: AbortSignal | null | undefined;
  const send = vi.fn<typeof fetch>((_input, init) => {
    signal = init?.signal;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  vi.stubGlobal("fetch", send);
  const pending = teacherLandingAfterAuth("teacher", teacher, cache, operation);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  cache.setQueryData(["teacher", "me"], { ...teacher, id: "b" });
  expect(signal?.aborted).toBe(true);
  release(
    new Response(
      JSON.stringify({ ok: true, data: { students: [{ id: "a-only" }] } }),
    ),
  );
  await expect(pending).resolves.toBe("/t/students");
  expect(send).toHaveBeenCalledTimes(1);
  operation.finish();
  expect(cache.getQueryCache().hasListeners()).toBe(false);
  cache.clear();
});
it("同ID外部成功使本次confirmation失效，拒绝消费旧落点", async () => {
  const cache = new QueryClient();
  cache.setQueryData(["teacher", "me"], teacher);
  const operation = createAuthOperation(cache);
  operation.select(["teacher"]);
  let release: (data: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ),
  );
  const pending = teacherLandingAfterAuth("teacher", teacher, cache, operation);
  cache.setQueryData(["teacher", "me"], teacher);
  release(
    new Response(
      JSON.stringify({ ok: true, data: { students: [{ id: "a-only" }] } }),
    ),
  );
  await expect(pending).resolves.toBe("/t/students");
  operation.finish();
  expect(cache.getQueryCache().hasListeners()).toBe(false);
  cache.clear();
});
it("教师入口personal只指路学习首页且零教师学生请求，peer ABA仍令凭据无效", async () => {
  const cache = new QueryClient();
  const personal = { ...teacher, accountKind: "personal" as const };
  cache.setQueryData(["teacher", "me"], personal);
  cache.setQueryData(["student", "me"], { id: "sa" });
  const operation = createAuthOperation(cache);
  operation.select(["student", "teacher"]);
  const send = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", send);
  const pending = teacherLandingAfterAuth(
    "teacher",
    personal,
    cache,
    operation,
  );
  cache.setQueryData(["student", "me"], { id: "sb" });
  cache.setQueryData(["student", "me"], { id: "sa" });
  await expect(pending).resolves.toBe("/s/home");
  expect(operation.isCurrent()).toBe(false);
  expect(send).not.toHaveBeenCalled();
  operation.finish();
  expect(cache.getQueryCache().hasListeners()).toBe(false);
  cache.clear();
});
it("新意图结束旧确认时，即使me仍A也立即中止旧教师短读", async () => {
  const cache = new QueryClient();
  cache.setQueryData(["teacher", "me"], teacher);
  const operation = createAuthOperation(cache);
  operation.select(["teacher"]);
  let release: (data: Response) => void = () => {};
  let signal: AbortSignal | null | undefined;
  const send = vi.fn<typeof fetch>((_input, init) => {
    signal = init?.signal;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  vi.stubGlobal("fetch", send);
  const pending = teacherLandingAfterAuth("teacher", teacher, cache, operation);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  operation.finish();
  expect(signal?.aborted).toBe(true);
  expect(cache.getQueryData(["teacher", "me"])).toEqual(teacher);
  release(
    new Response(
      JSON.stringify({ ok: true, data: { students: [{ id: "a-only" }] } }),
    ),
  );
  await expect(pending).resolves.toBe("/t/students");
  expect(cache.getQueryCache().hasListeners()).toBe(false);
  cache.clear();
});
