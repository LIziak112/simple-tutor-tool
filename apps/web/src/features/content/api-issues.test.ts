import { describe, expect, it } from "vitest";
import { parseApiIssues } from "./api-issues";

/** ApiError.extra._issues 解析测试（T1.12）：契约内条目保留、坏条目丢弃、缺省空数组 */
describe("parseApiIssues", () => {
  it("解析合法 _issues 列表", () => {
    const issues = [
      {
        level: "error",
        line: 3,
        column: 1,
        code: "UNKNOWN_QUESTION_TYPE",
        message: "未知题型：essay",
      },
    ];
    expect(parseApiIssues({ _issues: issues })).toEqual(issues);
  });

  it("坏条目丢弃、非数组/缺省返回空数组", () => {
    expect(
      parseApiIssues({
        _issues: [
          { level: "error", line: 1, column: 1, code: "X", message: "ok" },
          { level: "error", line: 1 }, // 缺字段
          "not-an-object",
        ],
      }),
    ).toHaveLength(1);
    expect(parseApiIssues({})).toEqual([]);
    expect(parseApiIssues(undefined)).toEqual([]);
  });
});
