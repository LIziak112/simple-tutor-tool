import { expect, it } from "vitest";
import {
  parseStudentRecordsUrl,
  studentRecordsApiParams,
  studentRecordsUrlQuery,
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

it("来源筛选支持 lesson（讲练，2026-10 讲练一体）：URL 解析与请求参数透传", () => {
  const state = parseStudentRecordsUrl(
    new URLSearchParams("sourceType=lesson"),
  );
  expect(state.sourceType).toBe("lesson");
  expect(studentRecordsApiParams(state, 50)).toMatchObject({
    sourceType: "lesson",
  });
  // 未知来源仍回退全部
  expect(
    parseStudentRecordsUrl(new URLSearchParams("sourceType=unknown"))
      .sourceType,
  ).toBe("all");
});

it("排序在 URL、请求和返回来源中保留，非法值回默认", () => {
  for (const sort of ["activity_desc", "started_desc", "started_asc"]) {
    const state = parseStudentRecordsUrl(
      new URLSearchParams(`sort=${sort}&status=draft`),
    );
    expect(state.sort).toBe(sort);
    expect(studentRecordsApiParams(state, 50)).toMatchObject({ sort });
    expect(parseStudentRecordsUrl(studentRecordsUrlQuery(state)).sort).toBe(
      sort,
    );
  }
  expect(parseStudentRecordsUrl(new URLSearchParams("sort=broken")).sort).toBe(
    "activity_desc",
  );
});
