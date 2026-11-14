import { expect, it } from "vitest";
import { testPortalRoutes } from "@/test/portal-fixture";
import { recordsReturnTarget } from "./record-review-navigation";

it("仅接受我的记录路径并规范化筛选字段", () => {
  expect(
    recordsReturnTarget(
      testPortalRoutes,
      "/s/records?from=broken&courseId=bad&assignmentId=bad",
    ),
  ).toBe("/s/records");
  expect(
    recordsReturnTarget(
      testPortalRoutes,
      "/s/records?status=graded&offset=20&secret=answer",
    ),
  ).toBe("/s/records?status=graded&offset=20");
  expect(
    recordsReturnTarget(testPortalRoutes, "https://evil.test/s/records"),
  ).toBeNull();
  expect(
    recordsReturnTarget(testPortalRoutes, "//evil.test/s/records"),
  ).toBeNull();
  expect(recordsReturnTarget(testPortalRoutes, "/s/home")).toBeNull();
  expect(
    recordsReturnTarget(testPortalRoutes, "/s/records?status=secret&offset=-1"),
  ).toBe("/s/records");
});
