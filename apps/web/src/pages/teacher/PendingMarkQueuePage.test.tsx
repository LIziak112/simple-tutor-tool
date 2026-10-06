import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PendingMarkCard, PendingMarkListData } from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchAssignmentsApi,
  fetchPendingMarksApi,
  fetchStudentsApi,
  fetchTeacherCourses,
  markResponseApi,
} from "@/lib/api";
import PendingMarkQueuePage from "./PendingMarkQueuePage";

/**
 * /t/data/pending 待批队列页组件测试（T3.2b，D3/D4）：快捷键行为（J/K 导航、
 * 输入聚焦守卫）、进度计数、乐观离队与失败回滚、撤销恢复（原值再调 mark）、
 * 评语随判定一并提交、空态。API 层 mock（真实接口行为由服务测试与 E2E 覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchPendingMarksApi: vi.fn(),
    markResponseApi: vi.fn(),
    fetchStudentsApi: vi.fn(),
    fetchTeacherCourses: vi.fn(),
    fetchAssignmentsApi: vi.fn(),
  };
});

// T6R.11：原稿查看面板以桩替换（面板行为见 NoteOriginalView.test），此处
// 只断言待批卡接线——非手写待批题（如人工批改的填空）渲染入口
vi.mock("@/features/notes/NoteOriginalView", async () => {
  const { createElement } = await import("react");
  return {
    NoteOriginalView: (props: Record<string, unknown>) =>
      createElement("div", {
        "data-testid": "note-original-stub",
        "data-role": String(props.role),
        "data-attempt": String(props.attemptId),
        "data-question": String(props.questionId),
        "data-round": String(props.roundLabel ?? ""),
      }),
  };
});

const mockedMarks = vi.mocked(fetchPendingMarksApi);
const mockedMark = vi.mocked(markResponseApi);
const mockedStudents = vi.mocked(fetchStudentsApi);
const mockedCourses = vi.mocked(fetchTeacherCourses);
const mockedAssignments = vi.mocked(fetchAssignmentsApi);

const STUDENT_A = "11111111-1111-4111-8111-111111111111";
const STUDENT_B = "22222222-2222-4222-8222-222222222222";

/** 卡片工厂（solve 手写默认；overrides 换学生/题型/ink） */
function makeCard(overrides: Partial<PendingMarkCard> = {}): PendingMarkCard {
  return {
    sourceType: "course",
    courseId: "33333333-3333-4333-8333-333333333333",
    courseName: "初一上",
    assignmentId: null,
    assignmentTitle: null,
    unitId: "unit-有理数",
    unitTitle: "有理数加法",
    attemptNo: 1,
    responseId: "88888888-8888-4888-8888-888888888881",
    attemptId: "99999999-9999-4999-8999-999999999991",
    questionId: "unit-有理数-2",
    studentId: STUDENT_A,
    studentName: "张三",
    type: "solve",
    difficulty: 2,
    knowledge: ["有理数加法"],
    stemMd: "计算：$(-2)+5=$",
    answerText: null,
    answers: { kind: "final", answer: "3" },
    ink: {
      inkId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      pngUrl: "/api/teacher/ink/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png",
      hasStrokes: true,
    },
    activeSec: 40,
    hintsUsed: 1,
    changeCount: 2,
    submittedAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  };
}

function renderPage(initialEntry = "/t/data/pending") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/t/data/pending" element={<PendingMarkQueuePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** mark 接口成功回包工厂（页面只用 mutation 状态，字段填合法值即可） */

beforeEach(() => {
  vi.clearAllMocks();
  mockedStudents.mockResolvedValue({ students: [] });
  mockedCourses.mockResolvedValue({ courses: [] });
  mockedAssignments.mockResolvedValue({ assignments: [] });
  mockedMark.mockResolvedValue({
    responseId: "88888888-8888-4888-8888-888888888881",
    questionId: "unit-有理数-2",
    attemptId: "99999999-9999-4999-8999-999999999991",
    teacherMark: "correct",
    teacherComment: null,
    finalCorrect: true,
    attemptStatus: "graded",
    scoreFinal: 100,
    pendingCount: 0,
  });
});

describe("PendingMarkQueuePage 快捷键与导航", () => {
  it("J/K 在队列内上下移动（第 x / y 张）；评语框聚焦时按 1 不触发批改", async () => {
    mockedMarks.mockResolvedValue({
      marks: [
        makeCard({ studentName: "张三" }),
        makeCard({
          responseId: "88888888-8888-4888-8888-888888888882",
          studentId: STUDENT_B,
          studentName: "李四",
        }),
      ],
    } as PendingMarkListData);
    renderPage();
    expect(
      await screen.findByRole("article", { name: "待批卡片：张三" }),
    ).toBeInTheDocument();
    expect(screen.getByText("第 1 / 2 张")).toBeInTheDocument();

    // J 下一题
    fireEvent.keyDown(window, { key: "j" });
    expect(
      screen.getByRole("article", { name: "待批卡片：李四" }),
    ).toBeInTheDocument();
    expect(screen.getByText("第 2 / 2 张")).toBeInTheDocument();
    // K 上一题
    fireEvent.keyDown(window, { key: "k" });
    expect(
      screen.getByRole("article", { name: "待批卡片：张三" }),
    ).toBeInTheDocument();

    // 评语框聚焦时按 1 只输入字符，不触发批改（输入守卫）
    const comment = screen.getByLabelText(/评语/);
    comment.focus();
    fireEvent.keyDown(comment, { key: "1" });
    expect(mockedMark).not.toHaveBeenCalled();
    expect(
      screen.getByRole("article", { name: "待批卡片：张三" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("mark-progress")).toHaveTextContent("0/2");
  });
});

describe("PendingMarkQueuePage 批改与进度", () => {
  it("键盘 1 标对：卡片乐观离队、进度 0/2→1/2、评语随判定一并提交", async () => {
    mockedMarks.mockResolvedValue({
      marks: [
        makeCard({ studentName: "张三" }),
        makeCard({
          responseId: "88888888-8888-4888-8888-888888888882",
          studentId: STUDENT_B,
          studentName: "李四",
        }),
      ],
    } as PendingMarkListData);
    renderPage();
    await screen.findByRole("article", { name: "待批卡片：张三" });

    fireEvent.change(screen.getByLabelText(/评语/), {
      target: { value: "过程清晰" },
    });
    fireEvent.keyDown(window, { key: "1" });

    await waitFor(() => expect(mockedMark).toHaveBeenCalledTimes(1));
    expect(mockedMark).toHaveBeenCalledWith(
      "88888888-8888-4888-8888-888888888881",
      { mark: "correct", comment: "过程清晰" },
    );
    // 张三离队，当前指向李四；进度 1/2
    await waitFor(() =>
      expect(
        screen.getByRole("article", { name: "待批卡片：李四" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("article", { name: "待批卡片：张三" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("mark-progress")).toHaveTextContent("1/2");
  });

  it("标错按钮（iPad 触控入口）与键盘等效：mark=wrong、卡片离队", async () => {
    mockedMarks.mockResolvedValue({
      marks: [makeCard({ studentName: "张三" })],
    } as PendingMarkListData);
    renderPage();
    await screen.findByRole("article", { name: "待批卡片：张三" });
    fireEvent.click(screen.getByRole("button", { name: /标错（2）/ }));
    await waitFor(() => expect(mockedMark).toHaveBeenCalledTimes(1));
    expect(mockedMark).toHaveBeenCalledWith(
      "88888888-8888-4888-8888-888888888881",
      { mark: "wrong", comment: "" },
    );
    await waitFor(() =>
      expect(screen.getByText("本组待批题已全部批完")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("mark-progress")).toHaveTextContent("1/1");
  });

  it("批改失败回滚：卡片插回原位并显示错误提示，进度不动", async () => {
    mockedMarks.mockResolvedValue({
      marks: [makeCard({ studentName: "张三" })],
    } as PendingMarkListData);
    mockedMark.mockRejectedValueOnce(new Error("网络中断"));
    renderPage();
    await screen.findByRole("article", { name: "待批卡片：张三" });

    fireEvent.keyDown(window, { key: "2" });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("批改未保存"),
    );
    // 回滚：卡片回到队列且进度回到 0/1
    await waitFor(() =>
      expect(
        screen.getByRole("article", { name: "待批卡片：张三" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("mark-progress")).toHaveTextContent("0/1");
  });
});

describe("PendingMarkQueuePage 撤销（U）", () => {
  it("标对后 U：用原值再调一次 mark 恢复，卡片插回队列原位、进度回落", async () => {
    mockedMarks.mockResolvedValue({
      marks: [
        makeCard({ studentName: "张三" }),
        makeCard({
          responseId: "88888888-8888-4888-8888-888888888882",
          studentId: STUDENT_B,
          studentName: "李四",
        }),
      ],
    } as PendingMarkListData);
    renderPage();
    await screen.findByRole("article", { name: "待批卡片：张三" });

    // 标对张三（离队，当前变李四）
    fireEvent.keyDown(window, { key: "1" });
    await waitFor(() =>
      expect(
        screen.getByRole("article", { name: "待批卡片：李四" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("mark-progress")).toHaveTextContent("1/2");

    // U 撤销：原 mark 恒 null、原评语 null → 第二次调用恢复；张三插回队首
    fireEvent.keyDown(window, { key: "u" });
    await waitFor(() => expect(mockedMark).toHaveBeenCalledTimes(2));
    expect(mockedMark).toHaveBeenLastCalledWith(
      "88888888-8888-4888-8888-888888888881",
      { mark: null, comment: null },
    );
    await waitFor(() =>
      expect(
        screen.getByRole("article", { name: "待批卡片：张三" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("mark-progress")).toHaveTextContent("0/2");
    // 撤销快照是单层的：再按 U 不再发请求
    fireEvent.keyDown(window, { key: "u" });
    expect(mockedMark).toHaveBeenCalledTimes(2);
  });
});

describe("PendingMarkQueuePage 三态与空态", () => {
  it("加载中提示，不白屏", () => {
    mockedMarks.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText("正在加载待批队列…")).toBeInTheDocument();
  });

  it("空队列显示「没有待批题」，进度 0/0", async () => {
    mockedMarks.mockResolvedValue({ marks: [] } as PendingMarkListData);
    renderPage();
    expect(await screen.findByText("没有待批题")).toBeInTheDocument();
    expect(screen.getByTestId("mark-progress")).toHaveTextContent("0/0");
  });

  it("加载失败显示错误与重试；重试后恢复", async () => {
    mockedMarks.mockRejectedValueOnce(new Error("连不上服务器"));
    renderPage();
    expect(await screen.findByText("待批队列加载失败")).toBeInTheDocument();
    expect(screen.getByText("连不上服务器")).toBeInTheDocument();

    mockedMarks.mockResolvedValue({ marks: [] } as PendingMarkListData);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("没有待批题")).toBeInTheDocument();
  });
});

// ---------- T6R.11：待批卡草稿原稿查看入口 ----------

describe("待批卡草稿原稿入口（T6R.11）", () => {
  it("非手写待批题（fill 人工批改）渲染教师原稿入口（attempt 定位 + 轮次标注）；手写题不渲染", async () => {
    const fillCard = makeCard({
      responseId: "88888888-8888-4888-8888-888888888882",
      questionId: "unit-有理数-3",
      type: "fill",
      answerText: "1/2",
      answers: null,
      ink: null,
      attemptNo: 2,
    });
    mockedMarks.mockResolvedValue({
      marks: [makeCard(), fillCard],
    } as PendingMarkListData);
    renderPage();
    await screen.findByText("第 1 / 2 张");
    // 只有一张卡在屏（当前卡 solve 手写）→ J 键翻到第 2 张
    fireEvent.keyDown(window, { key: "j" });
    await screen.findByText("第 2 / 2 张");
    const stubs = screen
      .getAllByTestId("note-original-stub")
      .map((el) => el.dataset);
    expect(stubs).toHaveLength(1);
    expect(stubs[0]?.role).toBe("teacher");
    expect(stubs[0]?.attempt).toBe("99999999-9999-4999-8999-999999999991");
    expect(stubs[0]?.question).toBe("unit-有理数-3");
    // course 来源 attemptNo=2
    expect(stubs[0]?.round).toBe("第 2 次课程练习");
  });
});
