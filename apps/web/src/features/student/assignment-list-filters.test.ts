import type { StudentAssignment } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  assignmentDateError,
  assignmentListPage,
  assignmentListQuery,
  assignmentsReturnTarget,
  filterAssignmentList,
  parseAssignmentListUrl,
} from "./assignment-list-filters";

const state = (query = "") =>
  parseAssignmentListUrl(new URLSearchParams(query));
function assignment(
  id: string,
  createdAt: string,
  status: StudentAssignment["status"] = "not_started",
): StudentAssignment {
  return {
    id,
    title: `作业${id}`,
    units: [],
    unitCount: 0,
    questionCount: 1,
    createdAt,
    dueAt: null,
    status,
  };
}

describe("作业列表筛选", () => {
  it("默认全时间待办，完成状态共用四态口径，最新在前且不改源数组", () => {
    const items = [
      assignment("old", "2026-01-01T00:00:00Z"),
      assignment("done", "2026-10-10T00:00:00Z", "submitted"),
      assignment("new", "2026-10-11T00:00:00Z", "in_progress"),
    ];
    expect(filterAssignmentList(items, state()).map((item) => item.id)).toEqual(
      ["new", "old"],
    );
    expect(
      filterAssignmentList(items, state("status=done")).map((item) => item.id),
    ).toEqual(["done"]);
    expect(items[0]?.id).toBe("old");
  });
  it("最近七天以北京时间当天及前六天为范围，包含边界", () => {
    const now = new Date("2026-10-11T01:00:00Z");
    const items = [
      assignment("before", "2026-10-04T15:59:59Z"),
      assignment("first", "2026-10-04T16:00:00Z"),
      assignment("last", "2026-10-11T15:59:59Z"),
      assignment("future", "2026-10-11T16:00:00Z"),
    ];
    expect(
      filterAssignmentList(items, state("time=week"), now).map(
        (item) => item.id,
      ),
    ).toEqual(["last", "first"]);
  });
  it("最近30天跨月与自定义单日边界一致，单边日期也能筛选", () => {
    const items = [
      assignment("before", "2026-09-11T15:59:59Z"),
      assignment("first", "2026-09-11T16:00:00Z"),
      assignment("same", "2026-10-10T16:00:00Z"),
    ];
    expect(
      filterAssignmentList(
        items,
        state("time=month"),
        new Date("2026-10-11T00:00:00Z"),
      ),
    ).toHaveLength(2);
    expect(
      filterAssignmentList(
        items,
        state("time=custom&from=2026-10-11&to=2026-10-11"),
      ).map((item) => item.id),
    ).toEqual(["same"]);
    expect(
      filterAssignmentList(items, state("time=custom&to=2026-09-11")).map(
        (item) => item.id,
      ),
    ).toEqual(["before"]);
  });
  it.each([
    "time=custom&from=2026-02-30",
    "time=custom&from=oops",
    "time=custom&from=2026-10-11&to=2026-10-10",
  ])("无效日期 %s 明确报错，不展示误导结果", (query) => {
    expect(assignmentDateError(state(query))).not.toBeNull();
    expect(
      filterAssignmentList(
        [assignment("1", "2026-10-11T00:00:00Z")],
        state(query),
      ),
    ).toHaveLength(0);
  });
  it("标题搜索支持大小写和两端空白，与状态联合筛选", () => {
    const items = [
      assignment("CPU", "2026-10-11T00:00:00Z", "graded"),
      assignment("cpu", "2026-10-10T00:00:00Z"),
    ];
    expect(
      filterAssignmentList(items, state("status=done&q=%20cpu%20")).map(
        (item) => item.id,
      ),
    ).toEqual(["CPU"]);
  });
  it("筛选URL往返保留条件，丢弃未知字段并规范非法页码", () => {
    const parsed = state(
      "status=all&time=custom&from=2026-10-01&to=2026-10-11&q=作业&page=2&secret=x",
    );
    expect(state(assignmentListQuery(parsed).toString())).toEqual(parsed);
    expect(assignmentListQuery(parsed).has("secret")).toBe(false);
    expect(state("page=-1&status=bad&time=bad")).toMatchObject({
      page: 1,
      status: "todo",
      time: "all",
    });
    expect(state("page=Infinity").page).toBe(1);
  });
  it("每页10项，越界收敛到最后页；零项也有稳定页码", () => {
    const items = Array.from({ length: 23 }, (_, index) =>
      assignment(String(index), "2026-10-11T00:00:00Z"),
    );
    expect(assignmentListPage(items, 2)).toMatchObject({
      page: 2,
      pages: 3,
      total: 23,
    });
    expect(assignmentListPage(items, 2).items).toHaveLength(10);
    expect(assignmentListPage(items, 999).items).toHaveLength(3);
    expect(assignmentListPage([], 8)).toMatchObject({
      page: 1,
      pages: 1,
      total: 0,
    });
  });
  it.each([
    "https://evil.example/s/assignments",
    "//evil.example/s/assignments",
    "/s/assignments/123",
    "/s/assignments/x/..",
    "/s/assignments\\evil",
    "/s/assignments/../home",
    "/t/assignments",
  ])("拒绝不可信返回路径 %s", (raw) => {
    expect(assignmentsReturnTarget(raw)).toBeNull();
  });
  it("返回列表只保留允许筛选字段", () => {
    expect(
      assignmentsReturnTarget("/s/assignments?status=done&page=2&secret=x"),
    ).toBe("/s/assignments?status=done&page=2");
  });
});

it("极端无效月份也应提示而非抛出异常", () => {
  const state = parseAssignmentListUrl(
    new URLSearchParams("time=custom&from=2026-99-99"),
  );
  expect(assignmentDateError(state)).toBe("请输入有效的布置日期。");
});
