import { expect, it } from "vitest";
import { testPortalRoutes } from "@/test/portal-fixture";
import { aiSettingsReturnSource } from "./ai-settings-return";

const attemptId = "11111111-1111-4111-8111-111111111111";
it("未激活作业从AI设置回到已确认本次作答，保留题与作业列表上下文", () => {
  const target = aiSettingsReturnSource(
    testPortalRoutes,
    {
      pathname: "/s/assignments/a",
      search: "?q=q1&returnTo=%2Fs%2Fassignments%3Fstatus%3Dtodo&token=secret",
    },
    attemptId,
    "q1",
    null,
  );
  const url = new URL(target, location.origin);
  expect(url.pathname).toBe(`/s/attempts/${attemptId}`);
  expect(url.searchParams.get("q")).toBe("q1");
  expect(url.searchParams.get("aiCompose")).toBe("q1");
  expect(url.searchParams.get("returnTo")).toContain("/s/assignments");
  expect(url.searchParams.has("token")).toBe(false);
});
it("讲练保持原run路由与有效课程上下文，回信参数保持", () => {
  const courseId = "22222222-2222-4222-8222-222222222222";
  const target = aiSettingsReturnSource(
    testPortalRoutes,
    {
      pathname: "/s/lectures/l/lesson/run",
      search: `?courseId=${courseId}&q=q2`,
    },
    attemptId,
    "q2",
    "task",
  );
  const url = new URL(target, location.origin);
  expect(url.pathname).toBe("/s/lectures/l/lesson/run");
  expect(url.searchParams.get("courseId")).toBe(courseId);
  expect(url.searchParams.get("aiTask")).toBe("task");
});
it("任意from不能带离当前门户，也不能保留非法课程上下文", () => {
  expect(
    aiSettingsReturnSource(
      testPortalRoutes,
      { pathname: "/t/users", search: "?returnTo=https://evil.test" },
      attemptId,
      "q",
      null,
    ),
  ).toBe(`/s/attempts/${attemptId}`);
});
