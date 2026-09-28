import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { StudentLectureDetail } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchStudentLectureApi,
  postLectureEventsApi,
} from "@/lib/api";
import { installEventStore, memoryEventStore } from "@/lib/event-queue";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentLectureViewPage from "./StudentLectureViewPage";

/**
 * 讲义阅读页组件测试（T2.3）：RichMarkdown 全文渲染、自动目录（H2/H3）
 * 条目与正文标题一一配对、目录点击滚动到对应标题、目录可折叠、
 * :::solution 讲解块以折叠件呈现、错误态。API 层 mock。
 * T2.10 追加：折叠/逐步揭晓展开上报 lecture_expand（unmount 时队列 flush 出网）。
 * T2A.5 追加：课程上下文（?courseId= → 请求带参、返回课程目录、标题下课程名）
 * 与「本课配套练习」区块（D8：题数 + 即将开放）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentLectureApi: vi.fn(),
    postLectureEventsApi: vi.fn(async () => ({ accepted: 1 })),
  };
});

const mockedLecture = vi.mocked(fetchStudentLectureApi);
const mockedPostEvents = vi.mocked(postLectureEventsApi);

const LECTURE_ID = "33333333-3333-4333-8333-333333333333";
const COURSE_ID = "12121212-1212-4121-8121-121212121212";

const LECTURE: StudentLectureDetail = {
  id: LECTURE_ID,
  title: "第1讲 有理数",
  updatedAt: "2026-09-20T10:00:00.000Z",
  courseId: COURSE_ID,
  courseName: "初一上",
  companionUnits: [],
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
  installEventStore(memoryEventStore());
  mockedPostEvents.mockClear();
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

  it("讲义不可见（404 NOT_FOUND，D22 不暴露存在性）显示错误态与重试", async () => {
    mockedLecture.mockRejectedValue(
      new ApiError(
        "NOT_FOUND",
        "没有找到该内容（可能尚未发布或已被移除）",
        404,
      ),
    );
    renderPage("not-exist-id");

    expect(await screen.findByText("讲义加载失败")).toBeInTheDocument();
    expect(
      screen.getByText("没有找到该内容（可能尚未发布或已被移除）"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

// ---------- T2A.5：课程上下文与本课配套练习（D8） ----------

describe("StudentLectureViewPage：课程上下文与配套练习（T2A.5）", () => {
  it("带 courseId 进入：请求带参、标题下显示课程名、返回课程目录", async () => {
    mockedLecture.mockResolvedValue(LECTURE);
    renderWithStudentRoutes({
      initialPath: `/s/lectures/${LECTURE_ID}?courseId=${COURSE_ID}`,
      routePath: "/s/lectures/:id",
      element: <StudentLectureViewPage />,
    });

    // 等待数据到达（课程名出现即 header 已渲染；正文 H1 同名，用文本定位）
    await screen.findByText(/课程：初一上/);
    expect(mockedLecture).toHaveBeenCalledWith(LECTURE_ID, COURSE_ID);
    expect(screen.getByRole("link", { name: "返回课程目录" })).toHaveAttribute(
      "href",
      `/s/courses/${COURSE_ID}`,
    );
  });

  it("无配套练习时不渲染「本课配套练习」区块", async () => {
    mockedLecture.mockResolvedValue(LECTURE);
    renderPage();

    await screen.findByText(/课程：初一上/);
    expect(screen.queryByText("本课配套练习")).not.toBeInTheDocument();
  });

  it("有可见配套单元：底部显示「本课配套练习」（标题/题数/即将开放，不可点击）", async () => {
    mockedLecture.mockResolvedValue({
      ...LECTURE,
      companionUnits: [
        { id: "有理数小练", title: "有理数小练", questionCount: 4 },
      ],
    });
    renderPage();

    const heading = await screen.findByRole("heading", {
      name: "本课配套练习",
    });
    expect(screen.getByText("有理数小练")).toBeInTheDocument();
    expect(screen.getByText("4 题")).toBeInTheDocument();
    expect(screen.getAllByText("即将开放").length).toBe(1);
    // 单元项暂不可进入（T2A.6 接入作答）：区块内没有链接
    const section = heading.closest("section");
    expect(section?.querySelector("a")).toBeNull();
  });
});

// ---------- T2.10：lecture_expand 埋点 ----------

/** 含 :::steps 逐步揭晓的讲义 */
const STEPS_LECTURE: StudentLectureDetail = {
  ...LECTURE,
  markdown: [
    "# 第1讲 有理数",
    "",
    "## 一、正数与负数",
    "",
    "::::steps",
    "",
    ":::step",
    "第一步内容。",
    ":::",
    "",
    ':::step{title="变形"}',
    "第二步内容。",
    ":::",
    "",
    "::::",
  ].join("\n"),
};

describe("StudentLectureViewPage：lecture_expand 埋点（T2.10）", () => {
  it("点开详解折叠 → unmount flush 上报 lecture_expand（含讲义 id/指令名/序号）", async () => {
    mockedLecture.mockResolvedValue(LECTURE);
    const { unmount } = renderPage();
    await screen.findByRole("button", { name: /详解/ });

    fireEvent.click(screen.getByRole("button", { name: /详解/ }));
    // 再收起再展开：第二次展开也上报（§5.3「每次展开都上报」）
    fireEvent.click(screen.getByRole("button", { name: /详解/ }));
    fireEvent.click(screen.getByRole("button", { name: /详解/ }));

    unmount();
    await waitFor(() => expect(mockedPostEvents).toHaveBeenCalled());
    const events = mockedPostEvents.mock.calls.flatMap(
      (call) => call[0] as unknown as Array<Record<string, unknown>>,
    );
    const expandEvents = events.filter((e) => e.type === "lecture_expand");
    expect(expandEvents.length).toBe(2);
    expect(expandEvents[0]).toMatchObject({
      lectureId: LECTURE_ID,
      directive: "solution",
    });
    expect(typeof expandEvents[0]?.clientTs).toBe("number");
  });

  it("逐步揭晓「显示下一步」上报 step 指令与步序", async () => {
    mockedLecture.mockResolvedValue(STEPS_LECTURE);
    const { unmount } = renderPage();
    const next = await screen.findByRole("button", { name: /显示下一步/ });
    fireEvent.click(next);

    unmount();
    await waitFor(() => expect(mockedPostEvents).toHaveBeenCalled());
    const events = mockedPostEvents.mock.calls.flatMap(
      (call) => call[0] as unknown as Array<Record<string, unknown>>,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "lecture_expand",
        lectureId: LECTURE_ID,
        directive: "step",
        index: 2,
      }),
    );
  });
});
