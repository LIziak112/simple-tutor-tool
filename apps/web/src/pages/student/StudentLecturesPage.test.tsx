import { screen } from "@testing-library/react";
import type { StudentLectureListData } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStudentLecturesApi } from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentLecturesPage from "./StudentLecturesPage";

/**
 * 学生讲义列表页组件测试（T2.3）：列表渲染（标题/主题/更新时间/进入链接）、
 * 空态、错误态。API 层 mock（后端行为由 student-lectures.test.ts 覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentLecturesApi: vi.fn(),
  };
});

const mockedLectures = vi.mocked(fetchStudentLecturesApi);

const LECTURES: StudentLectureListData = {
  lectures: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      title: "第1讲 有理数",
      topic: "有理数",
      updatedAt: "2026-09-20T10:00:00.000Z",
    },
    {
      id: "66666666-6666-4666-8666-666666666666",
      title: "第2讲 数轴",
      topic: null,
      updatedAt: "2026-09-21T10:00:00.000Z",
    },
  ],
};

function renderPage() {
  return renderWithStudentRoutes({
    initialPath: "/s/lectures",
    routePath: "/s/lectures",
    element: <StudentLecturesPage />,
  });
}

beforeEach(() => {
  mockedLectures.mockReset();
});

describe("StudentLecturesPage", () => {
  it("渲染讲义列表：标题、主题与更新时间、进入阅读页链接、返回首页", async () => {
    mockedLectures.mockResolvedValue(LECTURES);
    renderPage();

    const first = await screen.findByRole("link", { name: /第1讲 有理数/ });
    expect(first).toHaveAttribute(
      "href",
      `/s/lectures/${LECTURES.lectures[0]?.id}`,
    );
    expect(screen.getByText("有理数")).toBeInTheDocument();
    // 更新时间相对显示（2026-09-20 距测试运行时间较久，显示「…天前」）
    expect(screen.getAllByText(/更新$/).length).toBe(2);
    expect(
      screen.getByRole("link", { name: /第2讲 数轴/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回首页" })).toHaveAttribute(
      "href",
      "/s/home",
    );
  });

  it("空态：还没有讲义", async () => {
    mockedLectures.mockResolvedValue({ lectures: [] });
    renderPage();

    expect(await screen.findByText("还没有讲义")).toBeInTheDocument();
  });

  it("错误态：加载失败与重试", async () => {
    mockedLectures.mockRejectedValue(new Error("连不上服务器"));
    renderPage();

    expect(await screen.findByText("讲义加载失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
