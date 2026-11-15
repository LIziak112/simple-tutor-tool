import { QueryClient } from "@tanstack/react-query";
import type { StudentMeData } from "@tutor/contract";
import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@/test/render-with-portal";
import { prefetchAuthenticatedStudent } from "./student-auth-prefetch";

const student: StudentMeData = {
  id: "new-a",
  displayName: "甲",
  loginName: "a",
  accountKind: "class",
  passwordEnabled: false,
  linkEnabled: true,
};
afterEach(() => vi.unstubAllGlobals());
for (const portal of ["student", "personal", "teacher"] as const)
  it(`${portal}新主体预取用独立租约，主体/peer变更后迟到A正文不写B缓存`, async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    cache.setQueryData(["student", "me"], {
      ...student,
      accountKind: portal !== "student" ? "personal" : "class",
    });
    if (portal !== "student")
      cache.setQueryData(["teacher", "me"], { id: "teacher-a" });
    const reads: {
      path: string;
      signal: AbortSignal | null | undefined;
      resolve: (value: Response) => void;
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (input, init) =>
          new Promise<Response>((resolve) => {
            reads.push({ path: String(input), signal: init?.signal, resolve });
          }),
      ),
    );
    prefetchAuthenticatedStudent(
      portal,
      { ...student, accountKind: portal !== "student" ? "personal" : "class" },
      cache,
    );
    const expected =
      portal !== "student"
        ? ["/api/student/courses", "/api/student/lectures"]
        : [
            "/api/student/assignments",
            "/api/student/courses",
            "/api/student/lectures",
          ];
    await waitFor(() => expect(reads).toHaveLength(expected.length));
    expect(reads.map((read) => read.path).sort()).toEqual(expected);
    expect(reads.every((read) => read.signal && !read.signal.aborted)).toBe(
      true,
    );
    if (portal !== "student") {
      cache.setQueryData(["teacher", "me"], { id: "teacher-b" });
      cache.setQueryData(["teacher", "me"], { id: "teacher-a" });
    } else cache.setQueryData(["student", "me"], { ...student, id: "b" });
    cache.setQueryData(["student", "courses"], { courses: [{ id: "b-only" }] });
    expect(reads.every((read) => read.signal?.aborted)).toBe(true);
    for (const read of reads)
      read.resolve(
        new Response(
          JSON.stringify({ ok: true, data: { courses: [{ id: "a-secret" }] } }),
        ),
      );
    await waitFor(() => expect(cache.isFetching()).toBe(0));
    expect(cache.getQueryData(["student", "courses"])).toEqual({
      courses: [{ id: "b-only" }],
    });
    expect(reads).toHaveLength(expected.length);
    await waitFor(() =>
      expect(cache.getQueryCache().hasListeners()).toBe(false),
    );
    cache.clear();
  });
it("新预取完成后释放短租约；不匹配当前身份时零请求", async () => {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const signals: (AbortSignal | null | undefined)[] = [];
  const send = vi.fn<typeof fetch>(async (_input, init) => {
    signals.push(init?.signal);
    return new Response(JSON.stringify({ ok: true, data: {} }));
  });
  vi.stubGlobal("fetch", send);
  prefetchAuthenticatedStudent("student", student, cache);
  expect(send).not.toHaveBeenCalled();
  cache.setQueryData(["student", "me"], student);
  prefetchAuthenticatedStudent("student", student, cache);
  await waitFor(() => expect(signals).toHaveLength(3));
  await waitFor(() =>
    expect(signals.every((signal) => signal?.aborted)).toBe(true),
  );
  await waitFor(() => expect(cache.getQueryCache().hasListeners()).toBe(false));
  cache.clear();
});
