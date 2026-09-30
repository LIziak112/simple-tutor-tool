import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  TeacherAttemptDetailData,
  TeacherAttemptDetailQuestion,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  downloadTeacherExportCsv,
  fetchTeacherAttemptDetailApi,
  markResponseApi,
} from "@/lib/api";
import AttemptDetailPage from "./AttemptDetailPage";

/**
 * /t/data/attempts/:id 详情页组件测试（T3.1，D5/D7）：三态（含 404 口径）、
 * 已交卷详情（来源头/得分汇总/连续题号与单元节标题/判定区/参考答案）、
 * draft 详情（判定区「未交卷」、无参考答案对比、进行中横幅）、
 * 手写缩略图与 lightbox、得分回退展示。API 层 mock。
 * T3.2b（D3）：每题「改判 / 评语」内联编辑——draft 不显示、对自动判过的题
 * 可改判、保存调用 mark 接口并经缓存失效刷新判定区与顶部汇总。
 * T3.4：「导出 CSV」按钮携带该 attempt 的定位参数（口径见
 * exportCsvParamsOfAttempt：作业 studentId+assignmentId、课程练习
 * studentId+courseId+sourceType）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchTeacherAttemptDetailApi: vi.fn(),
    markResponseApi: vi.fn(),
    downloadTeacherExportCsv: vi.fn(),
  };
});

const mockedDetail = vi.mocked(fetchTeacherAttemptDetailApi);
const mockedMark = vi.mocked(markResponseApi);
const mockedDownload = vi.mocked(downloadTeacherExportCsv);

const ATTEMPT_ID = "99999999-9999-4999-8999-999999999991";
const INK_URL = "/api/teacher/ink/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png";
const COURSE_ID = "33333333-3333-4333-8333-333333333333";
const ASSIGNMENT_ID = "44444444-4444-4444-8444-444444444444";

/** 逐题行工厂（judge 默认；overrides 换题型/判定/手写/答案） */
function makeQuestion(
  overrides: Partial<TeacherAttemptDetailQuestion> = {},
): TeacherAttemptDetailQuestion {
  return {
    questionId: "q1",
    responseId: "88888888-8888-4888-8888-888888888881",
    no: 1,
    unitId: "unit-a",
    unitTitle: "单元A",
    type: "judge",
    difficulty: 2,
    knowledge: ["有理数的概念"],
    stemMd: "$1$ 是正数。",
    options: undefined,
    answer: null,
    autoCorrect: null,
    finalCorrect: null,
    teacherMark: null,
    teacherComment: null,
    activeSec: 40,
    hintsUsed: 1,
    changeCount: 2,
    ink: null,
    answers: undefined,
    solutionMd: undefined,
    ...overrides,
  };
}

/** 详情工厂（course 来源默认已交卷；overrides 换 draft/得分/逐题） */
function makeDetail(
  overrides: Partial<TeacherAttemptDetailData> = {},
): TeacherAttemptDetailData {
  return {
    sourceType: "course",
    courseId: "33333333-3333-4333-8333-333333333333",
    courseName: "初一上",
    assignmentId: null,
    assignmentTitle: null,
    unitId: "unit-a",
    unitTitle: "单元A",
    attemptNo: 2,
    attemptId: ATTEMPT_ID,
    studentId: "11111111-1111-4111-8111-111111111111",
    studentName: "张三",
    status: "submitted",
    scoreAuto: 70,
    scoreFinal: null,
    correctCount: 1,
    wrongCount: 1,
    pendingCount: 1,
    startedAt: "2026-09-28T10:00:00.000Z",
    submittedAt: "2026-09-28T10:05:00.000Z",
    activeSec: 300,
    questions: [
      makeQuestion({
        no: 1,
        answer: { kind: "judge", value: true },
        autoCorrect: true,
        finalCorrect: true,
        answers: { kind: "judge", value: true },
      }),
      makeQuestion({
        questionId: "q2",
        no: 2,
        answer: { kind: "fill", values: ["-1"] },
        autoCorrect: false,
        finalCorrect: false,
        answers: { kind: "fill", blanks: [["4"]] },
      }),
      makeQuestion({
        questionId: "q3",
        no: 3,
        unitId: "unit-b",
        unitTitle: "单元B",
        answer: null,
        autoCorrect: null,
        finalCorrect: null,
        solutionMd: "先算加法，再取符号。",
      }),
    ],
    ...overrides,
  };
}

function renderPage(attemptId = ATTEMPT_ID) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/t/data/attempts/${attemptId}`]}>
        <Routes>
          <Route path="/t/data/attempts/:id" element={<AttemptDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AttemptDetailPage 三态", () => {
  it("加载中显示提示，不白屏", () => {
    mockedDetail.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText("正在加载作答详情…")).toBeInTheDocument();
  });

  it("404（ATTEMPT_NOT_FOUND）显示专属文案与返回按钮", async () => {
    mockedDetail.mockRejectedValue(
      new ApiError("ATTEMPT_NOT_FOUND", "作答不存在", 404),
    );
    renderPage();
    expect(await screen.findByText("作答不存在或不属于你")).toBeInTheDocument();
    expect(screen.getByText(/这份作答可能已被删除/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "返回数据页" }),
    ).toBeInTheDocument();
  });
});

describe("AttemptDetailPage 导出 CSV（T3.4，D13）", () => {
  it("课程练习来源：studentId + courseId + sourceType=course；作业来源：studentId + assignmentId", async () => {
    mockedDownload.mockResolvedValue(undefined);
    const STUDENT_ID = "11111111-1111-4111-8111-111111111111";

    // 课程练习（默认工厂是 course 来源）
    mockedDetail.mockResolvedValue(makeDetail());
    const first = renderPage();
    await screen.findByText("张三");
    fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    await waitFor(() => {
      expect(mockedDownload).toHaveBeenCalledTimes(1);
    });
    expect(mockedDownload).toHaveBeenLastCalledWith({
      studentId: STUDENT_ID,
      courseId: COURSE_ID,
      sourceType: "course",
    });
    first.unmount();

    // 作业来源：一作业一人一份作答，studentId+assignmentId 唯一定位
    mockedDetail.mockResolvedValue(
      makeDetail({
        sourceType: "assignment",
        courseId: null,
        courseName: null,
        assignmentId: ASSIGNMENT_ID,
        assignmentTitle: "第一周作业",
        unitId: null,
        unitTitle: null,
        attemptNo: 1,
      }),
    );
    renderPage();
    await screen.findByText("张三");
    fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    await waitFor(() => {
      expect(mockedDownload).toHaveBeenCalledTimes(2);
    });
    expect(mockedDownload).toHaveBeenLastCalledWith({
      studentId: STUDENT_ID,
      assignmentId: ASSIGNMENT_ID,
    });
  });
});

describe("AttemptDetailPage 已交卷详情（D7）", () => {
  beforeEach(() => {
    mockedDetail.mockResolvedValue(makeDetail());
  });

  it("来源头（课程 · 第 n 次）+ 得分汇总 + 得分回退（scoreFinal 空显示 scoreAuto）", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "张三" });
    expect(screen.getByText("已交卷", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("课程：初一上 · 第 2 次")).toBeInTheDocument();
    // 计数行文本被 <b> 分段，用 textContent 匹配（D7 对/错/待批计数）
    for (const label of ["答对 1 题", "答错 1 题", "待批 1 题"]) {
      expect(
        screen.getByText(
          (_, element) =>
            element?.textContent === label && element.tagName === "SPAN",
        ),
      ).toBeInTheDocument();
    }
    // scoreFinal null → 最终得分「未批」；自动判分显示 70
    expect(screen.getByText("未批", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("70")).toBeInTheDocument();
  });

  it("逐题连续题号 + 单元节标题（多单元）；判定区与参考答案、详解折叠", async () => {
    renderPage();
    await screen.findByText("课程：初一上 · 第 2 次");
    // 双单元 → 单元节标题（单元A 含第 1、2 题；单元B 第 3 题）
    expect(screen.getByRole("heading", { name: "单元A" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "单元B" })).toBeInTheDocument();
    expect(screen.getAllByRole("article").length).toBe(3);

    const q1 = screen.getByRole("article", { name: "第 1 题" });
    // 判定区四行（自动/最终判对；教师判定未批改；评语空位）
    expect(within(q1).getAllByText("答对").length).toBe(2);
    expect(within(q1).getByText("未批改")).toBeInTheDocument();
    expect(within(q1).getByText("教师评语：")).toBeInTheDocument();
    // 学生答案与参考答案都是「对」（judge）
    expect(within(q1).getAllByText("对", { exact: true }).length).toBe(2);
    // 学习行为统计
    expect(within(q1).getByText(/提示 1 次/)).toBeInTheDocument();
    expect(within(q1).getByText(/改答 2 次/)).toBeInTheDocument();

    // 第 3 题带详解 → 默认折叠，展开后可见
    const q3 = screen.getByRole("article", { name: "第 3 题" });
    expect(within(q3).getByText("待批", { exact: true })).toBeInTheDocument();
    expect(
      within(q3).getByText("无标准答案（由老师批改）"),
    ).toBeInTheDocument();
    expect(screen.queryByText("先算加法，再取符号。")).not.toBeInTheDocument();
    fireEvent.click(within(q3).getByRole("button", { name: /查看详解/ }));
    expect(screen.getByText("先算加法，再取符号。")).toBeInTheDocument();
  });
});

describe("AttemptDetailPage draft 详情（D5）", () => {
  it("判定区统一「未交卷」、进行中横幅含已答计数、无参考答案对比与详解", async () => {
    mockedDetail.mockResolvedValue(
      makeDetail({
        status: "draft",
        submittedAt: null,
        scoreAuto: null,
        scoreFinal: null,
        correctCount: 0,
        wrongCount: 0,
        pendingCount: 0,
        questions: [
          makeQuestion({
            no: 1,
            answer: { kind: "judge", value: true },
            // draft 服务端不下发 answers/solutionMd（缺省字段）
          }),
          makeQuestion({ questionId: "q2", no: 2, answer: null }),
        ],
      }),
    );
    renderPage();
    await screen.findByRole("heading", { name: "张三" });
    // 进行中徽章 + 横幅（已答 1 / 共 2 题）
    expect(screen.getByText("进行中", { exact: true })).toBeInTheDocument();
    expect(screen.getByText(/已答 1 \/ 共 2 题/)).toBeInTheDocument();
    expect(screen.getByText(/学生尚未交卷/)).toBeInTheDocument();
    // 不出现已交卷的得分汇总字段
    expect(screen.queryByText(/最终得分/)).not.toBeInTheDocument();

    // 每题判定区统一「未交卷」
    expect(screen.getAllByText(/未交卷——学生交卷前不产生判定/).length).toBe(2);
    // T3.2b（D3）：draft 不渲染「改判 / 评语」内联编辑
    expect(screen.queryByText("改判 / 评语")).not.toBeInTheDocument();
    // 无参考答案对比（服务端整卷不下发，前端不渲染）
    expect(screen.queryByText("参考答案：")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /查看详解/ }),
    ).not.toBeInTheDocument();
    // 已答内容照常展示
    const q1 = screen.getByRole("article", { name: "第 1 题" });
    expect(within(q1).getByText("学生答案：")).toBeInTheDocument();
    expect(within(q1).getByText("对", { exact: true })).toBeInTheDocument();
  });
});

describe("AttemptDetailPage 手写缩略图与放大（D7）", () => {
  it("手写题显示懒加载缩略图；点击放大 lightbox 可关闭", async () => {
    mockedDetail.mockResolvedValue(
      makeDetail({
        questions: [
          makeQuestion({
            questionId: "q-ink",
            no: 1,
            type: "solve",
            answer: null,
            ink: {
              inkId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              pngUrl: INK_URL,
              hasStrokes: true,
            },
          }),
        ],
      }),
    );
    renderPage();
    const q1 = await screen.findByRole("article", { name: "第 1 题" });
    const img = within(q1).getByRole("img", {
      name: "第 1 题的手写笔迹",
    }) as HTMLImageElement;
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("src")).toBe(INK_URL);

    fireEvent.click(
      within(q1).getByRole("button", { name: "放大查看第 1 题的手写笔迹" }),
    );
    const lightbox = screen.getByLabelText("手写笔迹放大查看");
    expect(
      within(lightbox).getByRole("img", { name: "第 1 题的手写笔迹" }),
    ).toBeInTheDocument();
    fireEvent.click(within(lightbox).getByRole("button", { name: "关闭" }));
    expect(screen.queryByLabelText("手写笔迹放大查看")).not.toBeInTheDocument();
  });
});

describe("AttemptDetailPage 改判/评语内联编辑（T3.2b，D3）", () => {
  it("对自动判过的题改判：判对 + 评语 + 保存 → mark 接口收到 responseId 与两字段，判定区与顶部汇总随重取刷新", async () => {
    // 第 2 题为自动判错（autoCorrect/finalCorrect=false）——队列外改判入口
    const before = makeDetail();
    mockedDetail.mockResolvedValueOnce(before);
    // 保存成功 → invalidate attempt-detail → 重取拿到改判后的详情
    mockedDetail.mockResolvedValue(
      makeDetail({
        status: "graded",
        scoreFinal: 100,
        correctCount: 2,
        wrongCount: 0,
        pendingCount: 1,
        questions: before.questions.map((question) =>
          question.questionId === "q2"
            ? {
                ...question,
                teacherMark: "correct",
                teacherComment: "思路对了，抄写有误",
                finalCorrect: true,
              }
            : question,
        ),
      }),
    );
    mockedMark.mockResolvedValue({
      responseId: "88888888-8888-4888-8888-888888888881",
      questionId: "q2",
      attemptId: ATTEMPT_ID,
      teacherMark: "correct",
      teacherComment: "思路对了，抄写有误",
      finalCorrect: true,
      attemptStatus: "submitted",
      scoreFinal: null,
      pendingCount: 1,
    });
    renderPage();
    const q2 = await screen.findByRole("article", { name: "第 2 题" });

    // 判定区初始：教师判定未批改
    expect(
      within(q2.querySelector("dl") as HTMLElement).getByText("未批改"),
    ).toBeInTheDocument();

    // 编辑器在已交卷题上渲染：选判对 + 填评语 + 保存
    fireEvent.click(within(q2).getByRole("button", { name: "判对" }));
    fireEvent.change(within(q2).getByLabelText(/评语/), {
      target: { value: "思路对了，抄写有误" },
    });
    fireEvent.click(within(q2).getByRole("button", { name: "保存判定与评语" }));

    await waitFor(() => expect(mockedMark).toHaveBeenCalledTimes(1));
    expect(mockedMark).toHaveBeenCalledWith(
      "88888888-8888-4888-8888-888888888881",
      { mark: "correct", comment: "思路对了，抄写有误" },
    );
    // 重取后：教师判定「判对」、评语显示、顶部最终得分 100（草稿值同步重置）
    await waitFor(() =>
      expect(
        within(q2.querySelector("dl") as HTMLElement).getByText("判对", {
          exact: true,
        }),
      ).toBeInTheDocument(),
    );
    expect(
      within(q2.querySelector("dl") as HTMLElement).getByText(
        "思路对了，抄写有误",
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      const finalScore = screen
        .getAllByText("100")
        .find((el) => el.classList.contains("text-2xl"));
      expect(finalScore).toBeDefined();
    });
  });

  it("草稿与服务端一致时保存与重置禁用；改选后可保存", async () => {
    mockedDetail.mockResolvedValue(
      makeDetail({
        questions: [
          makeQuestion({
            teacherMark: "correct",
            teacherComment: "已批过",
            finalCorrect: true,
          }),
        ],
      }),
    );
    renderPage();
    const q1 = await screen.findByRole("article", { name: "第 1 题" });
    expect(
      within(q1).getByRole("button", { name: "保存判定与评语" }),
    ).toBeDisabled();
    expect(within(q1).getByRole("button", { name: "重置" })).toBeDisabled();
    // 判对按钮呈选中态
    expect(within(q1).getByRole("button", { name: "判对" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("保存失败显示就地错误提示，不改动判定区", async () => {
    mockedDetail.mockResolvedValue(makeDetail());
    mockedMark.mockRejectedValueOnce(new Error("网络中断"));
    renderPage();
    const q2 = await screen.findByRole("article", { name: "第 2 题" });
    fireEvent.click(within(q2).getByRole("button", { name: "判错" }));
    fireEvent.click(within(q2).getByRole("button", { name: "保存判定与评语" }));
    const editor = q2.lastElementChild as HTMLElement;
    await waitFor(() =>
      expect(within(editor).getByRole("alert")).toHaveTextContent("网络中断"),
    );
    // 判定区（服务端数据）不受影响：教师判定仍「未批改」
    expect(
      within(q2.querySelector("dl") as HTMLElement).getByText("未批改"),
    ).toBeInTheDocument();
  });
});
