import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { StudentAssignment } from "@tutor/contract";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError, fetchStudentAssignmentsApi } from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentAssignmentsPage from "./StudentAssignmentsPage";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchStudentAssignmentsApi: vi.fn(),
}));
const mock = vi.mocked(fetchStudentAssignmentsApi);
const items: StudentAssignment[] = Array.from({ length: 23 }, (_, index) => ({
  id: `assignment-${index}`,
  title: `作业${index}`,
  units: [],
  unitCount: 0,
  questionCount: 1,
  dueAt: null,
  createdAt: new Date(Date.UTC(2026, 9, index + 1)).toISOString(),
  status: index === 22 ? "submitted" : "not_started",
}));
const renderPage = (query = "") =>
  renderWithStudentRoutes({
    initialPath: `/s/assignments${query}`,
    routePath: "/s/assignments",
    element: <StudentAssignmentsPage />,
  });
beforeEach(() => {
  mock.mockReset();
});

it("默认待完成，每页10份，筛选与分页保留在作业入口的返回地址", async () => {
  mock.mockResolvedValue({ assignments: items });
  renderPage();
  expect(await screen.findByText("作业21")).toBeInTheDocument();
  expect(screen.queryByText("作业22")).toBeNull();
  expect(screen.getAllByRole("link", { name: "开始练习" })).toHaveLength(10);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(await screen.findByText("作业11")).toBeInTheDocument();
  const href = screen
    .getAllByRole("link", { name: "开始练习" })[0]
    ?.getAttribute("href");
  expect(
    new URL(href ?? "", "http://localhost").searchParams.get("returnTo"),
  ).toBe("/s/assignments?page=2");
  fireEvent.change(screen.getByRole("combobox", { name: "完成状态" }), {
    target: { value: "done" },
  });
  expect(await screen.findByText("作业22")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
  expect(screen.getByRole("link", { name: "查看结果" })).toHaveAttribute(
    "href",
    "/s/assignments/assignment-22?returnTo=%2Fs%2Fassignments%3Fstatus%3Ddone",
  );
});

it("搜索无结果可清除筛选，已完成视图不会显示旧待办", async () => {
  mock.mockResolvedValue({ assignments: items });
  renderPage("?status=done&q=不存在&page=9");
  expect(await screen.findByText("没有符合筛选条件的作业")).toBeInTheDocument();
  fireEvent.click(
    within(screen.getByLabelText("作业筛选")).getByRole("button", {
      name: "清除筛选",
    }),
  );
  expect(await screen.findByText("作业21")).toBeInTheDocument();
  expect(screen.getByRole("searchbox", { name: "搜索作业标题" })).toHaveValue(
    "",
  );
});

it("自定义日期支持倒置区间提示，越界页码收敛", async () => {
  mock.mockResolvedValue({ assignments: items });
  renderPage("?time=custom&from=2026-10-11&to=2026-10-10&page=9");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "起始日期不能晚于结束日期",
  );
  fireEvent.change(screen.getByLabelText("结束日期"), {
    target: { value: "2026-10-11" },
  });
  expect(await screen.findByText("作业10")).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: "开始练习" })).toHaveLength(1);
});

it.each(["loading", "error", "empty"])(
  "%s 状态保留页头和导航",
  async (state) => {
    if (state === "loading") mock.mockReturnValue(new Promise(() => {}));
    else if (state === "error")
      mock.mockRejectedValue(new ApiError("UNAUTHORIZED", "登录已过期", 401));
    else mock.mockResolvedValue({ assignments: [] });
    renderPage();
    expect(
      screen.getByRole("heading", { name: "我的作业" }),
    ).toBeInTheDocument();
    if (state === "loading")
      expect(screen.getByLabelText("正在加载作业")).toBeInTheDocument();
    else if (state === "error")
      expect(await screen.findByText("作业加载失败")).toBeInTheDocument();
    else expect(await screen.findByText("还没有作业")).toBeInTheDocument();
    await waitFor(() => expect(mock).toHaveBeenCalled());
  },
);
