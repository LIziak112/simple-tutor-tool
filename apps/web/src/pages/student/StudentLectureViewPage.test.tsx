import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { StudentLectureDetail } from "@tutor/contract";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchStudentLectureApi,
  postLectureEventsApi,
} from "@/lib/api";
import { installEventStore, memoryEventStore } from "@/lib/event-queue";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentLectureViewPage from "./StudentLectureViewPage";

/** 落点地址探针（重定向目标断言用） */
function LocationProbe() {
  const location = useLocation();
  return (
    <p data-testid="location-probe">
      {location.pathname}
      {location.search}
    </p>
  );
}

/**
 * 讲义阅读页组件测试（T2.3）：RichMarkdown 全文渲染、自动目录（H2/H3）
 * 条目与正文标题一一配对、目录点击滚动到对应标题、目录可折叠、
 * :::solution 讲解块以折叠件呈现、错误态。API 层 mock。
 * T2.10 追加：折叠/逐步揭晓展开上报 lecture_expand（unmount 时队列 flush 出网）。
 * T2A.5 追加：课程上下文（?courseId= → 请求带参、返回课程目录、标题下课程名）
 * 与「本课配套练习」区块（D8：T2A.6 起链接进单元落地页）。
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
  kind: "lecture",
  updatedAt: "2026-09-20T10:00:00.000Z",
  courseId: COURSE_ID,
  courseName: "初一上",
  companionUnits: [],
  enabledCapabilities: ["steps", "ink"],
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
let desktop = true;
let reducedMotion = false;

beforeEach(() => {
  scrollIntoViewMock.mockReset();
  Element.prototype.scrollIntoView = scrollIntoViewMock;
  installEventStore(memoryEventStore());
  mockedPostEvents.mockClear();
  desktop = true;
  reducedMotion = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("1024") ? desktop : reducedMotion,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  // 还原原型，避免影响其他测试文件
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  vi.unstubAllGlobals();
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

    // 阅读栏不再重复文档主标题的语义层级。
    const titleHeadings = await screen.findAllByRole("heading", {
      name: "第1讲 有理数",
      level: 1,
    });
    expect(titleHeadings.length).toBe(1);
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

  it("kind=lesson 重定向到讲练页（保留 courseId；2026-10 讲练一体）", async () => {
    mockedLecture.mockResolvedValue({
      ...LECTURE,
      kind: "lesson",
      markdown: null,
      blocks: [
        { type: "md", md: "# 第1讲 有理数\n\n正文。" },
        { type: "question", questionId: "lesson-q1" },
      ],
      companionUnits: [],
    });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter
          initialEntries={[`/s/lectures/${LECTURE_ID}?courseId=${COURSE_ID}`]}
        >
          <Routes>
            <Route
              path="/s/lectures/:id"
              element={<StudentLectureViewPage />}
            />
            <Route path="/s/lectures/:id/lesson" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("location-probe")).toHaveTextContent(
      `/s/lectures/${LECTURE_ID}/lesson?courseId=${COURSE_ID}`,
    );
  });
});

describe("StudentLectureViewPage：阅读导航", () => {
  it("目录跳转后聚焦正文标题并标记当前节", async () => {
    mockedLecture.mockResolvedValue(LECTURE);
    renderPage();
    const item = await screen.findByRole("button", {
      name: "二、有理数的分类",
    });
    fireEvent.click(item);
    expect(
      screen.getByRole("heading", { name: "二、有理数的分类" }),
    ).toHaveFocus();
    expect(item).toHaveAttribute("aria-current", "location");
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
  });

  it("减少动态效果时目录即时滚动", async () => {
    reducedMotion = true;
    mockedLecture.mockResolvedValue(LECTURE);
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "二、有理数的分类" }),
    );
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      behavior: "instant",
      block: "start",
    });
  });

  it("按章节折叠子节，跳转仍对应全文原始下标", async () => {
    mockedLecture.mockResolvedValue({
      ...LECTURE,
      markdown:
        "# 讲义\n\n## 第一章\n\n### 相同子节\n\n## 第二章\n\n### 相同子节\n\n## 总结",
    });
    renderPage();
    await screen.findByRole("button", { name: "第一章" });
    expect(screen.getAllByRole("button", { name: "相同子节" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "展开第二章的子目录" }));
    const secondGroup = screen.getByRole("group", { name: "第二章" });
    fireEvent.click(
      within(secondGroup).getByRole("button", {
        name: "相同子节",
      }),
    );
    expect(scrollIntoViewMock.mock.contexts[0]).toBe(
      document.querySelectorAll(".rich-markdown h2, .rich-markdown h3")[3],
    );
    expect(
      screen.queryByRole("button", { name: "展开总结的子目录" }),
    ).not.toBeInTheDocument();
  });

  it("窄屏默认直接阅读，打开目录后跳转关闭弹层并聚焦正文", async () => {
    desktop = false;
    mockedLecture.mockResolvedValue(LECTURE);
    renderPage();
    await screen.findByRole("heading", { name: "一、正数与负数", level: 2 });
    expect(
      screen.queryByRole("navigation", { name: "讲义目录" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开目录" }));
    const dialog = screen.getByRole("dialog", { name: "讲义目录" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "二、有理数的分类" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("heading", { name: "二、有理数的分类" }),
    ).toHaveFocus();
  });

  it("自动展开只跟随当前章，手动展开的章节保持打开", async () => {
    mockedLecture.mockResolvedValue({
      ...LECTURE,
      markdown:
        "# 讲义\n\n## 第一章\n\n### 第一章子节\n\n## 第二章\n\n### 第二章子节\n\n## 第三章\n\n### 第三章子节",
    });
    renderPage();
    await screen.findByRole("button", { name: "第一章" });
    fireEvent.click(screen.getByRole("button", { name: "第二章" }));
    expect(
      screen.queryByRole("button", { name: "第一章子节" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开第一章的子目录" }));
    fireEvent.click(screen.getByRole("button", { name: "第三章" }));
    expect(
      screen.getByRole("button", { name: "第一章子节" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "第二章子节" }),
    ).not.toBeInTheDocument();
  });

  it("H3 在首个章节前仍独立可达，公式标题跳转保持下标", async () => {
    mockedLecture.mockResolvedValue({
      ...LECTURE,
      markdown: "# 讲义\n\n### 导读\n\n## 绝对值 $|x|$\n\n### 子节",
    });
    renderPage();
    fireEvent.click(await screen.findByText("导读", { selector: "button" }));
    expect(document.querySelector(".rich-markdown h3")).toHaveFocus();
    // jsdom 对 MathML 的计算样式不完整，含公式控件的名称由真实浏览器验收。
    const formulaButton = document
      .querySelector('nav[aria-label="讲义目录"] .katex')
      ?.closest("button");
    if (!formulaButton) throw new Error("目录中缺少公式标题");
    fireEvent.click(formulaButton);
    expect(scrollIntoViewMock.mock.contexts[1]).toBe(
      document.querySelectorAll(".rich-markdown h2, .rich-markdown h3")[1],
    );
  });

  it("窄屏关闭目录恢复入口焦点", async () => {
    desktop = false;
    mockedLecture.mockResolvedValue(LECTURE);
    renderPage();
    const trigger = await screen.findByRole("button", { name: "展开目录" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("没有目录时仍可返回讲义列表", async () => {
    mockedLecture.mockResolvedValue({
      ...LECTURE,
      markdown: "# 无目录讲义\n\n正文。",
    });
    renderPage();
    await screen.findByRole("heading", { name: "无目录讲义" });
    expect(
      screen.queryByRole("button", { name: "展开目录" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "返回讲义列表" }));
    expect(await screen.findByTestId("route-stub")).toHaveTextContent(
      "讲义列表",
    );
  });

  it("章节观察器切换时更新目录状态", async () => {
    let notify: IntersectionObserverCallback | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    mockedLecture.mockResolvedValue(LECTURE);
    renderPage();
    const item = await screen.findByRole("button", {
      name: "二、有理数的分类",
    });
    const target = screen.getByRole("heading", { name: "二、有理数的分类" });
    act(() =>
      notify?.(
        [
          {
            target,
            intersectionRatio: 1,
            isIntersecting: true,
            boundingClientRect: target.getBoundingClientRect(),
            intersectionRect: target.getBoundingClientRect(),
            rootBounds: null,
            time: 0,
          },
        ],
        {} as IntersectionObserver,
      ),
    );
    expect(item).toHaveAttribute("aria-current", "location");
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

  it("有可见配套单元：底部显示「本课配套练习」（标题/题数/去练习链接，T2A.6）", async () => {
    mockedLecture.mockResolvedValue({
      ...LECTURE,
      enabledCapabilities: ["steps", "ink"],
      companionUnits: [
        { id: "有理数小练", title: "有理数小练", questionCount: 4 },
      ],
    });
    renderPage();

    await screen.findByRole("heading", {
      name: "本课配套练习",
    });
    expect(screen.getByText("有理数小练")).toBeInTheDocument();
    expect(screen.getByText("4 题")).toBeInTheDocument();
    expect(screen.getAllByText("去练习").length).toBe(1);
    // T2A.6：配套单元链接进当前课程的单元落地页（带 courseId 上下文）
    expect(
      screen.getByRole("link", { name: "配套练习 有理数小练（4 题）" }),
    ).toHaveAttribute("href", `/s/courses/${COURSE_ID}/units/有理数小练`);
  });
});

// ---------- T2.10 → T4.0b：directive_interact / 位置事件埋点 ----------

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

describe("StudentLectureViewPage：指令交互埋点（T4.0b directive_interact）", () => {
  it("详解折叠开/合双向上报 directive_interact（host=lecture，带版本定位）", async () => {
    mockedLecture.mockResolvedValue(LECTURE);
    const { unmount } = renderPage();
    await screen.findByRole("button", { name: /详解/ });

    fireEvent.click(screen.getByRole("button", { name: /详解/ }));
    // 收起 → close；再展开 → open（每次交互都上报，T4.0b §6 决策 3）
    fireEvent.click(screen.getByRole("button", { name: /详解/ }));
    fireEvent.click(screen.getByRole("button", { name: /详解/ }));

    unmount();
    await waitFor(() => expect(mockedPostEvents).toHaveBeenCalled());
    const events = mockedPostEvents.mock.calls.flatMap(
      (call) => call[0] as unknown as Array<Record<string, unknown>>,
    );
    const interactions = events.filter((e) => e.type === "directive_interact");
    // 新客户端不再产生 lecture_expand（§6 决策 1）
    expect(events.filter((e) => e.type === "lecture_expand")).toHaveLength(0);
    expect(interactions).toEqual([
      // LECTURE 的块指令序：example=1、solution=2（index=文档全局指令序号）
      expect.objectContaining({
        host: "lecture",
        lectureId: LECTURE_ID,
        name: "solution",
        index: 2,
        action: "open",
        lectureUpdatedAt: LECTURE.updatedAt,
      }),
      expect.objectContaining({ name: "solution", action: "close" }),
      expect.objectContaining({ name: "solution", action: "open" }),
    ]);
    expect(typeof interactions[0]?.clientTs).toBe("number");
  });

  it("steps「显示下一步」上报 reveal：index=容器全局序号、step=容器内步序", async () => {
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
        type: "directive_interact",
        host: "lecture",
        lectureId: LECTURE_ID,
        name: "steps",
        index: 1, // 容器自己的文档全局序号（step 指令自身的序号是 2/3，不用）
        step: 2,
        action: "reveal",
        lectureUpdatedAt: LECTURE.updatedAt,
      }),
    );
  });

  it("目录点击上报 lecture_toc_jump（headingIndex 与目录下标同源）并滚动", async () => {
    mockedLecture.mockResolvedValue(LECTURE);
    const { unmount } = renderPage();
    const tocButton = await screen.findByRole("button", {
      name: "二、有理数的分类",
    });
    fireEvent.click(tocButton);

    unmount();
    await waitFor(() => expect(mockedPostEvents).toHaveBeenCalled());
    const events = mockedPostEvents.mock.calls.flatMap(
      (call) => call[0] as unknown as Array<Record<string, unknown>>,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "lecture_toc_jump",
        lectureId: LECTURE_ID,
        headingIndex: 2, // 目录第 3 项（0 起）
        lectureUpdatedAt: LECTURE.updatedAt,
      }),
    );
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });
});
