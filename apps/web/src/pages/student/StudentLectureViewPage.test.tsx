import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { StudentLectureDetail } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchStudentLectureApi } from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentLectureViewPage from "./StudentLectureViewPage";

/**
 * 讲义阅读页组件测试（T2.3）：RichMarkdown 全文渲染、自动目录（H2/H3）
 * 条目与正文标题一一配对、目录点击滚动到对应标题、目录可折叠、
 * :::solution 讲解块以折叠件呈现、错误态。API 层 mock。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentLectureApi: vi.fn(),
  };
});

const mockedLecture = vi.mocked(fetchStudentLectureApi);

const LECTURE_ID = "33333333-3333-4333-8333-333333333333";

const LECTURE: StudentLectureDetail = {
  id: LECTURE_ID,
  title: "第1讲 有理数",
  updatedAt: "2026-09-20T10:00:00.000Z",
  markdown: [
    "# 第1讲 有理数",
    "",
    "## 一、正数与负数",
    "",
    "收入 $500$ 元与支出 $300$ 元是相反意义的量。",
    "",
    "### 1. 相反意义的量",
    "",
    '::::example{title="例 1"}',
    "指出下列各数中的正数：$+7$，$-3.5$。",
    "",
    ":::solution",
    "正数：$+7$。",
    ":::",
    "::::",
    "",
    "## 二、有理数的分类",
    "",
    "整数与分数统称有理数。",
  ].join("\n"),
};

/** jsdom 没有 scrollIntoView：mock 记录调用目标 */
const scrollIntoViewMock = vi.fn();

beforeEach(() => {
  scrollIntoViewMock.mockReset();
  Element.prototype.scrollIntoView = scrollIntoViewMock;
});

afterEach(() => {
  // 还原原型，避免影响其他测试文件
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

function renderPage(id = LECTURE_ID) {
  return renderWithStudentRoutes({
    initialPath: `/s/lectures/${id}`,
    routePath: "/s/lectures/:id",
    element: <StudentLectureViewPage />,
  });
}

describe("StudentLectureViewPage", () => {
  it("渲染全文：标题、H2/H3 正文标题与 :::solution 讲解折叠块", async () => {
    mockedLecture.mockResolvedValue(LECTURE);
    renderPage();

    // 标题与更新时间（页面 header 的 h1 与正文 markdown 的 H1 各一个，均应渲染）
    const titleHeadings = await screen.findAllByRole("heading", {
      name: "第1讲 有理数",
      level: 1,
    });
    expect(titleHeadings.length).toBe(2);
    expect(screen.getByText(/更新于/)).toBeInTheDocument();
    // 正文 H2/H3 由 RichMarkdown 渲染（level 2/3 的 heading）
    expect(
      screen.getByRole("heading", { name: "一、正数与负数", level: 2 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "1. 相反意义的量", level: 3 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "二、有理数的分类", level: 2 }),
    ).toBeInTheDocument();
    // :::solution 以折叠件呈现（默认收起，展开后讲解内容可见）：
    // 题干含「正数」一词（1 处），点开详解后解答段落再出现（2 处）
    const before = screen.getAllByText(/正数/).length;
    const detailToggle = screen.getByRole("button", { name: /详解/ });
    expect(detailToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(detailToggle);
    expect(detailToggle).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => {
      expect(screen.getAllByText(/正数/).length).toBe(before + 1);
    });
  });

  it("自动目录：条目顺序与正文 H2/H3 一致，点击滚动到对应标题", async () => {
    mockedLecture.mockResolvedValue(LECTURE);
    renderPage();

    // 目录三个条目（H2/H3 顺序）
    const firstItem = await screen.findByRole("button", {
      name: "一、正数与负数",
    });
    expect(
      screen.getByRole("button", { name: "1. 相反意义的量" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "二、有理数的分类" }),
    ).toBeInTheDocument();

    // 点击第 3 项（二、有理数的分类）→ 正文第 3 个 h2/h3 scrollIntoView
    fireEvent.click(screen.getByRole("button", { name: "二、有理数的分类" }));
    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    });
    const target = scrollIntoViewMock.mock.contexts[0] as HTMLElement;
    expect(target.tagName).toBe("H2");
    expect(target.textContent).toBe("二、有理数的分类");

    // 点击第 1 项 → 正文第 1 个标题
    fireEvent.click(firstItem);
    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2);
    });
    const firstTarget = scrollIntoViewMock.mock.contexts[1] as HTMLElement;
    expect(firstTarget.textContent).toBe("一、正数与负数");
  });

  it("目录可折叠：切换后条目隐藏/恢复", async () => {
    mockedLecture.mockResolvedValue(LECTURE);
    renderPage();

    await screen.findByRole("button", { name: "一、正数与负数" });
    fireEvent.click(screen.getByRole("button", { name: "收起目录" }));
    expect(
      screen.queryByRole("button", { name: "一、正数与负数" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开目录" }));
    expect(
      screen.getByRole("button", { name: "一、正数与负数" }),
    ).toBeInTheDocument();
  });

  it("讲义不存在（404）显示错误态与重试", async () => {
    mockedLecture.mockRejectedValue(
      new ApiError("LECTURE_NOT_FOUND", "讲义不存在", 404),
    );
    renderPage("not-exist-id");

    expect(await screen.findByText("讲义加载失败")).toBeInTheDocument();
    expect(screen.getByText("讲义不存在")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
