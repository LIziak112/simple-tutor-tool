import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { AttemptDraftData, AttemptResultData } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createCorrectionApi,
  fetchAttemptApi,
  fetchStudentNotebookApi,
  sealCorrectionApi,
  startWrongPracticeApi,
} from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentAttemptPage from "./StudentAttemptPage";

/**
 * /s/attempts/:attemptId 通用答题页组件测试（T2A.6）：按 attemptId 直接加载
 * 详情（两种来源共用）；课程来源显示「课程：xx · 第 n 次」与返回单元落地页；
 * 403/404 → 终态面板「已无权限访问该练习」（D7，不做无限重试）。
 * 2026-10：结果视图「练习本卷错题」直达重练接线（组卷 → 跳新卷作答）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAttemptApi: vi.fn(),
    startWrongPracticeApi: vi.fn(),
    // T6R.15 泄露断言（F）：答题/草稿渲染不得发起订正与笔记本请求——
    // 重练页不自动展示历史答案；一并 mock 批量头避免 jsdom 真出网噪音
    createCorrectionApi: vi.fn(),
    sealCorrectionApi: vi.fn(),
    fetchStudentNotebookApi: vi.fn(),
    fetchStudentNoteHeadsApi: vi.fn(),
  };
});

const mockedFetch = vi.mocked(fetchAttemptApi);
const mockedPractice = vi.mocked(startWrongPracticeApi);
const mockedCreateCorrection = vi.mocked(createCorrectionApi);
const mockedSealCorrection = vi.mocked(sealCorrectionApi);
const mockedNotebook = vi.mocked(fetchStudentNotebookApi);

const COURSE_ID = "12121212-1212-4121-8121-121212121212";
const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";

/** 课程练习草稿视图（第 2 次） */
const COURSE_DRAFT: AttemptDraftData = {
  attempt: {
    id: ATTEMPT_ID,
    sourceType: "course",
    assignmentId: null,
    courseId: COURSE_ID,
    unitId: "有理数小练",
    attemptNo: 2,
    status: "draft",
    startedAt: "2026-09-27T02:00:00.000Z",
    submittedAt: null,
    scoreAuto: null,
  },
  title: "有理数小练",
  courseName: "初一上",
  dueAt: null,
  // T2A.7：草稿视图题目按单元分组（course 来源单组）
  units: [
    {
      id: "有理数小练",
      title: "有理数小练",
      questions: [
        {
          id: "练习四-1",
          type: "judge",
          difficulty: 1,
          knowledge: ["有理数的概念"],
          stemMd: "$0$ 既不是正数，也不是负数。[[]]",
          hintCount: 0,
          questionRevisionId: "rev-练习四-1",
        },
      ],
    },
  ],
  drafts: {},
  hintsOpened: {},
  legacyUnverified: false,
};

function renderPage() {
  return renderWithStudentRoutes({
    initialPath: `/s/attempts/${ATTEMPT_ID}`,
    routePath: "/s/attempts/:attemptId",
    element: <StudentAttemptPage />,
  });
}

beforeEach(() => {
  mockedFetch.mockReset();
  mockedPractice.mockReset();
});

// ---------- T6R.15（F）：答题/草稿渲染零订正与笔记本请求（泄露断言） ----------

describe("草稿渲染不发起订正/笔记本请求（T6R.15 F）", () => {
  it("draft 渲染 settle 后零 corrections/notebook 请求与查询（重练不自动展示历史答案）", async () => {
    mockedFetch.mockResolvedValue(COURSE_DRAFT);
    const { client } = renderPage();
    expect(
      await screen.findByRole("button", { name: "交卷" }),
    ).toBeInTheDocument();
    // 等异步余波（草稿层挂载/批量头守卫）settle 后再断言
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "交卷" })).toBeInTheDocument();
    });
    expect(mockedCreateCorrection).not.toHaveBeenCalled();
    expect(mockedSealCorrection).not.toHaveBeenCalled();
    expect(mockedNotebook).not.toHaveBeenCalled();
    // 查询缓存里也不存在 notebook/correction 域的条目
    const keys = client
      .getQueryCache()
      .getAll()
      .map((q) => JSON.stringify(q.queryKey));
    expect(
      keys.filter((k) => k.includes("notebook") || k.includes("correction")),
    ).toEqual([]);
  });
});

describe("StudentAttemptPage（/s/attempts/:attemptId，T2A.6）", () => {
  it("课程来源草稿：渲染答题会话与来源行「课程：xx · 第 n 次」+ 返回单元落地页", async () => {
    mockedFetch.mockResolvedValue(COURSE_DRAFT);
    renderPage();
    // 来源行 + 答题视图（交卷入口出现即会话已渲染）
    expect(
      await screen.findByText("课程：初一上 · 第 2 次"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回单元练习" })).toHaveAttribute(
      "href",
      `/s/courses/${COURSE_ID}/units/${encodeURIComponent("有理数小练")}`,
    );
    expect(screen.getByRole("button", { name: "交卷" })).toBeInTheDocument();
  });

  it("T6R.3 legacyUnverified 横幅（true）：懒冻结的升级遗留卷显示恢复版本提示", async () => {
    mockedFetch.mockResolvedValue({ ...COURSE_DRAFT, legacyUnverified: true });
    renderPage();
    expect(await screen.findByText(/系统升级后恢复的版本/)).toBeInTheDocument();
  });

  it("T6R.3 legacyUnverified 横幅（false）：正常卷不显示恢复版本提示", async () => {
    mockedFetch.mockResolvedValue(COURSE_DRAFT);
    renderPage();
    await screen.findByText("课程：初一上 · 第 2 次");
    expect(screen.queryByText(/系统升级后恢复的版本/)).toBeNull();
  });

  it("已交卷的课程作答：直接结果视图（只读回看）", async () => {
    mockedFetch.mockResolvedValue({
      ...COURSE_DRAFT,
      attempt: {
        ...COURSE_DRAFT.attempt,
        status: "submitted",
        submittedAt: "2026-09-27T02:30:00.000Z",
        scoreAuto: 100,
      },
      // T2A.8：课程练习恒交卷即公布（D11）——结果视图必带 answersReleased
      answersReleased: true,
      summary: {
        total: 1,
        answered: 1,
        correct: 1,
        wrong: 0,
        pending: 0,
        unanswered: 0,
        autoGradable: 1,
        // D9（T3.5）：交卷即 graded → scoreFinal=100、待批 0
        scoreFinal: 100,
        pendingCount: 0,
      },
      units: [],
    });
    renderPage();
    expect(await screen.findByText(/得分/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "交卷" }),
    ).not.toBeInTheDocument();
  });

  it("403（移出成员，D7）：终态面板「已无权限访问该练习」，不提供重试", async () => {
    mockedFetch.mockRejectedValue(
      new ApiError("COURSE_ACCESS_DENIED", "无法访问该课程", 403),
    );
    renderPage();
    expect(await screen.findByText("已无权限访问该练习")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回首页" })).toHaveAttribute(
      "href",
      "/s/home",
    );
    expect(
      screen.queryByRole("button", { name: "重试" }),
    ).not.toBeInTheDocument();
  });

  it("404 同样终态；网络错误仍走通用重试面板", async () => {
    mockedFetch.mockRejectedValue(new ApiError("NOT_FOUND", "x", 404));
    renderPage();
    expect(await screen.findByText("已无权限访问该练习")).toBeInTheDocument();
  });

  it("网络错误：通用错误面板 + 重试", async () => {
    mockedFetch.mockRejectedValue(new Error("连不上服务器"));
    renderPage();
    expect(await screen.findByText("练习加载失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

describe("结果页「练习本卷错题」直达重练（2026-10）", () => {
  const NEW_ATTEMPT_ID = "99999999-9999-4999-8999-999999999999";

  /** 已交卷课程卷：单题判断，答错（finalCorrect=false），公布态 */
  const RESULT_WITH_WRONG: AttemptResultData = {
    attempt: {
      id: ATTEMPT_ID,
      sourceType: "course",
      assignmentId: null,
      courseId: COURSE_ID,
      unitId: "有理数小练",
      attemptNo: 1,
      status: "submitted",
      startedAt: "2026-09-27T02:00:00.000Z",
      submittedAt: "2026-09-27T02:30:00.000Z",
      scoreAuto: 0,
    },
    title: "有理数小练",
    courseName: "初一上",
    dueAt: null,
    answersReleased: true,
    summary: {
      total: 1,
      answered: 1,
      correct: 0,
      wrong: 1,
      pending: 0,
      unanswered: 0,
      autoGradable: 1,
      scoreFinal: 0,
      pendingCount: 0,
    },
    units: [
      {
        id: "有理数小练",
        title: "有理数小练",
        questions: [
          {
            questionId: "练习四-1",
            snapshot: {
              id: "练习四-1",
              type: "judge",
              difficulty: 1,
              knowledge: ["有理数的概念"],
              stemMd: "$0$ 既不是正数，也不是负数。[[正确]]",
              hintCount: 0,
            },
            answers: { kind: "judge", value: true },
            solutionMd: null,
            answer: { kind: "judge", value: false },
            autoCorrect: false,
            teacherMark: null,
            teacherComment: null,
            finalCorrect: false,
            hintsOpened: [],
          },
        ],
      },
    ],
  };

  it("点击「练习本卷错题（1 题）」：按本卷题序调组卷接口，成功后跳新卷作答页", async () => {
    // 首次进入旧卷结果页；组卷成功后跳新 id → 再次 fetch（返回新卷结果）
    mockedFetch.mockResolvedValueOnce(RESULT_WITH_WRONG);
    mockedFetch.mockResolvedValue({
      ...RESULT_WITH_WRONG,
      attempt: { ...RESULT_WITH_WRONG.attempt, id: NEW_ATTEMPT_ID },
    });
    mockedPractice.mockResolvedValue({
      ...RESULT_WITH_WRONG.attempt,
      id: NEW_ATTEMPT_ID,
      sourceType: "wrong",
    });
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "练习本卷错题（1 题）" }),
    );
    await waitFor(() =>
      expect(mockedPractice).toHaveBeenCalledWith(["练习四-1"]),
    );
    // 跳转 /s/attempts/:新id（同路由重挂载）→ 按新 attemptId 重新拉详情
    await waitFor(() =>
      expect(mockedFetch).toHaveBeenCalledWith(NEW_ATTEMPT_ID),
    );
  });

  it("组卷失败（400 WRONG_PRACTICE_EMPTY 等）：留结果页显示中文告警，可再试", async () => {
    mockedFetch.mockResolvedValue(RESULT_WITH_WRONG);
    mockedPractice.mockRejectedValue(
      new ApiError("WRONG_PRACTICE_EMPTY", "没有可重练的错题，请刷新本页", 400),
    );
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "练习本卷错题（1 题）" }),
    );
    await waitFor(() =>
      expect(mockedPractice).toHaveBeenCalledWith(["练习四-1"]),
    );
    // role=alert 按 ARIA 不能从内容取名（name 查询恒空），断言用文本内容
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "练习本卷错题组卷失败：没有可重练的错题，请刷新本页",
    );
    // 按钮仍在（非 loading 态），可重试
    expect(
      screen.getByRole("button", { name: "练习本卷错题（1 题）" }),
    ).toBeEnabled();
  });
});
