import { expect, it } from "vitest";
import {
  parseStudentRecordsUrl,
  studentRecordsApiParams,
} from "./records-filters";

it("直接打开非法记录筛选不会因日期转换崩溃或发送非法ID", () => {
  const state = parseStudentRecordsUrl(
    new URLSearchParams(
      "from=broken&to=broken&courseId=bad&assignmentId=bad&offset=9007199254740999",
    ),
  );
  expect(state).toMatchObject({
    from: "",
    to: "",
    courseId: null,
    assignmentId: null,
    offset: 0,
  });
  expect(() => studentRecordsApiParams(state, 50)).not.toThrow();
});
