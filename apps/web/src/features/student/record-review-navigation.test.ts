import { expect, it } from "vitest";
import { recordsReturnTarget } from "./record-review-navigation";

it("仅接受我的记录路径并规范化筛选字段", () => {
  expect(
    recordsReturnTarget("/s/records?from=broken&courseId=bad&assignmentId=bad"),
  ).toBe("/s/records");
  expect(
    recordsReturnTarget("/s/records?status=graded&offset=20&secret=answer"),
  ).toBe("/s/records?status=graded&offset=20");
  expect(recordsReturnTarget("https://evil.test/s/records")).toBeNull();
  expect(recordsReturnTarget("//evil.test/s/records")).toBeNull();
  expect(recordsReturnTarget("/s/home")).toBeNull();
  expect(recordsReturnTarget("/s/records?status=secret&offset=-1")).toBe(
    "/s/records",
  );
});
