import { createRoutesFromChildren, matchRoutes } from "react-router";
import { expect, it } from "vitest";
import {
  aiQueueReturnTarget,
  recordsReturnTarget,
} from "@/features/student/record-review-navigation";
import { legacyPersonalLocation } from "./legacy-personal-location";
import { personalRoutes } from "./personal/routes";
import { safeReturnTo } from "./registry";
import { createPortalRoutes } from "./routes";

it("旧管理别名和登录返回共用映射且保留查询hash", () => {
  for (const [old, target] of [
    ["/t/content?folder=f#q2", "/p/manage/library?folder=f#q2"],
    [
      "/t/insights/students/s?range=30d#q2",
      "/p/manage/students/s?range=30d#q2",
    ],
  ] as const) {
    expect(legacyPersonalLocation(old)).toBe(target);
    expect(safeReturnTo(old, "personal")).toBe(target);
    expect(
      matchRoutes(createRoutesFromChildren(personalRoutes), target),
    ).not.toBeNull();
  }
});
it("旧学习深链嵌套来源转译后仍通过原领域白名单", () => {
  const url = new URL(
    legacyPersonalLocation(
      "/s/attempts/a?returnTo=%2Fs%2Frecords%3Foffset%3D20&aiFrom=%2Fs%2Fcourses%2Fc&from=%2Fs%2Fwrong&q=q#q1",
    ),
    "https://local.invalid",
  );
  const routes = createPortalRoutes("personal");
  expect(url.pathname).toBe("/p/learn/attempts/a");
  expect(
    recordsReturnTarget(routes, url.searchParams.get("returnTo")),
  ).toContain("offset=20");
  expect(aiQueueReturnTarget(routes, url.searchParams.get("aiFrom"))).toBe(
    "/p/learn/courses/c",
  );
  expect(url.searchParams.get("from")).toBe("/p/learn/wrong");
  expect(url.searchParams.get("q")).toBe("q");
  expect(url.hash).toBe("#q1");
});
it("外站和编码绕过不能转译为合法学习来源", () => {
  for (const target of [
    "//evil/s/home",
    "https://evil/s/home",
    "/s/../t/library",
    "/s/%2f/evil",
  ] as const) {
    const url = new URL(
      legacyPersonalLocation(
        `/s/attempts/a?${new URLSearchParams({ returnTo: target })}`,
      ),
      "https://local.invalid",
    );
    expect(
      aiQueueReturnTarget(
        createPortalRoutes("personal"),
        url.searchParams.get("returnTo"),
      ),
    ).toBeNull();
  }
});
it("个人连接入口已注册在受保护管理壳", () => {
  expect(
    matchRoutes(createRoutesFromChildren(personalRoutes), "/p/manage/connect"),
  ).not.toBeNull();
});
