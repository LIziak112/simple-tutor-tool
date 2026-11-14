import { expect, it } from "vitest";
import { testPortalRoutes } from "@/test/portal-fixture";
import { aiDisplayReturnTo } from "./ai-display-return";

it("只返回支持助教的学生页，过滤未知字段和外站来源", () => {
  expect(
    new URL(
      aiDisplayReturnTo(
        testPortalRoutes,
        "/s/assignments/a?aiCompose=随堂练习-1",
      ) ?? "",
      location.origin,
    ).searchParams.get("aiCompose"),
  ).toBe("随堂练习-1");
  expect(
    aiDisplayReturnTo(
      testPortalRoutes,
      "/s/assignments/a?aiTask=t&aiQuestion=q&token=secret",
    ),
  ).toBe("/s/assignments/a?aiTask=t&aiQuestion=q");
  for (const value of [
    "https://evil.test/s/attempts/a",
    "//evil.test",
    "/s/../t/home",
    "/s/\\evil.test",
    "/s/settings",
    "/s/logout",
  ])
    expect(aiDisplayReturnTo(testPortalRoutes, value)).toBeNull();
});
