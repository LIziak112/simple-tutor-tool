import { createRoutesFromChildren, matchRoutes } from "react-router";
import { expect, it } from "vitest";
import {
  aiQueueReturnTarget,
  recordsReturnTarget,
} from "@/features/student/record-review-navigation";
import { aiDisplayReturnTo } from "@/features/student-ai/ai-display-return";
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
it("真实AI返回消费者接受转译后的多层from", () => {
  const raw =
    "/s/attempts/a?" +
    new URLSearchParams({ returnTo: "/s/records?offset=20", aiCompose: "q" });
  const mapped = new URL(
    legacyPersonalLocation(
      "/s/settings/ai?" + new URLSearchParams({ from: raw }),
    ),
    location.origin,
  );
  expect(aiDisplayReturnTo(createPortalRoutes("student"), raw)).not.toBeNull();
  expect(
    aiDisplayReturnTo(
      createPortalRoutes("personal"),
      mapped.searchParams.get("from"),
    ),
  ).not.toBeNull();
  const parent = new URL(
    mapped.searchParams.get("from") ?? "",
    location.origin,
  );
  expect(parent.searchParams.get("returnTo")).toBe(
    "/p/learn/records?offset=20",
  );
});
it("真实笔记本结果白名单接受多层returnTo并保留题与hash", () => {
  const raw =
    "/s/attempts/a?" +
    new URLSearchParams({
      returnTo: "/s/records?offset=20",
      reviewQuestion: "q",
    }) +
    "#q2";
  const mapped = new URL(
    legacyPersonalLocation(
      "/s/notebook/q?" + new URLSearchParams({ returnTo: raw }),
    ),
    location.origin,
  );
  const pattern = "(?:attempts|assignments)\\/[a-zA-Z0-9_-]+(?:[?#].*)?$";
  expect(
    createPortalRoutes("student").learningPattern(pattern, "").test(raw),
  ).toBe(true);
  const target = mapped.searchParams.get("returnTo");
  expect(
    createPortalRoutes("personal")
      .learningPattern(pattern, "")
      .test(target ?? ""),
  ).toBe(true);
  const parent = new URL(target ?? "", location.origin);
  expect(parent.searchParams.get("returnTo")).toBe(
    "/p/learn/records?offset=20",
  );
  expect(parent.searchParams.get("reviewQuestion")).toBe("q");
  expect(parent.hash).toBe("#q2");
});
it("旧根映到home且完整保留查询hash", () => {
  expect(legacyPersonalLocation("/s?tab=recent#q1")).toBe(
    "/p/learn/home?tab=recent#q1",
  );
  expect(legacyPersonalLocation("/s/?tab=recent#q1")).toBe(
    "/p/learn/home?tab=recent#q1",
  );
});
it("多层来源逐层拒绝外站、穿越及路径编码斜杠", () => {
  for (const bad of [
    "//evil/s/home",
    "https://evil/s/home",
    "/s/courses/../home",
    "/s/courses/%2fescape",
    "/s/courses/%5cescape",
  ]) {
    const parent = "/s/attempts/a?" + new URLSearchParams({ returnTo: bad });
    const mapped = new URL(
      legacyPersonalLocation(
        "/s/settings/ai?" + new URLSearchParams({ from: parent }),
      ),
      location.origin,
    );
    const middle = new URL(
      mapped.searchParams.get("from") ?? "",
      location.origin,
    );
    expect(middle.pathname).toBe("/p/learn/attempts/a");
    expect(middle.searchParams.get("returnTo")).toBe(bad);
  }
});
