import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStudentsApi } from "@/lib/api";
import { resolveTeacherLanding, teacherLandingPath } from "./teacher-landing";

/**
 * 教师登录后默认落点（T-PR4 Web-4，个人学习者零设置）：恰好 1 名未归档学生 →
 * 该生学生主页；多名 / 暂无 → 学生列表；学生列表接口失败 → 回落学生列表
 * （不阻塞登录）。
 */

vi.mock("@/lib/api", () => ({
  fetchStudentsApi: vi.fn(),
}));

const mockedStudents = vi.mocked(fetchStudentsApi);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("teacherLandingPath（纯函数）", () => {
  it("恰好 1 名学生 → 直接落到该生学生主页", () => {
    expect(teacherLandingPath([{ id: "s1" }])).toBe("/t/students/s1");
  });

  it("3 名学生 → 学生列表", () => {
    expect(teacherLandingPath([{ id: "s1" }, { id: "s2" }, { id: "s3" }])).toBe(
      "/t/students",
    );
  });

  it("0 名学生 → 学生列表（空态有新增学生指引）", () => {
    expect(teacherLandingPath([])).toBe("/t/students");
  });
});

describe("resolveTeacherLanding（登录时的落点解析）", () => {
  it("已归档学生不计入：1 未归档 + 1 已归档 → 未归档那名的主页", async () => {
    mockedStudents.mockResolvedValue({
      students: [
        {
          id: "archived-1",
          displayName: "已归档",
          loginName: "a1",
          linkEnabled: true,
          passwordEnabled: true,
          hasPassword: false,
          linkToken: "t1",
          note: null,
          archived: true,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
        {
          id: "active-1",
          displayName: "在读",
          loginName: "a2",
          linkEnabled: true,
          passwordEnabled: true,
          hasPassword: false,
          linkToken: "t2",
          note: null,
          archived: false,
          createdAt: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
    await expect(resolveTeacherLanding()).resolves.toBe("/t/students/active-1");
  });

  it("学生列表取失败 → 回落学生列表，不阻塞登录", async () => {
    mockedStudents.mockRejectedValue(new Error("network down"));
    await expect(resolveTeacherLanding()).resolves.toBe("/t/students");
  });
});
