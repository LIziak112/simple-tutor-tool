import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AttemptQuestionPublic,
  AttemptResultQuestion,
  AttemptScoreSummary,
  LessonStartData,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchStudentNoteHeadsApi,
  restartLessonAttemptApi,
  startLessonAttemptApi,
  submitAttemptApi,
  submitLessonQuestionApi,
} from "@/lib/api";
import StudentLessonPage from "./StudentLessonPage";

/**
 * /s/lectures/:id/lesson 学生讲练页（2026-10 讲练一体）组件测试：
 * 进入即幂等开卷（start）→ blocks 渲染（md 段 + 题卡交替 + 孤儿题分组）、
 * 进度（n/m 已提交）、单题提交（错误码收敛）、完成练习（整卷收尾）、
 * 再做一次、零题纯阅读空态、加载/错误三态。API 层 mock。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    startLessonAttemptApi: vi.fn(),
    restartLessonAttemptApi: vi.fn(),
    submitLessonQuestionApi: vi.fn(),
    submitAttemptApi: vi.fn(),
    fetchStudentNoteHeadsApi: vi.fn(),
  };
});

const mockedStart = vi.mocked(startLessonAttemptApi);
const mockedRestart = vi.mocked(restartLessonAttemptApi);
const mockedSubmitQuestion = vi.mocked(submitLessonQuestionApi);
const mockedSubmitAttempt = vi.mocked(submitAttemptApi);
const mockedNoteHeads = vi.mocked(fetchStudentNoteHeadsApi);

const LECTURE_ID = "44444444-4444-4444-8444-444444444444";
const COURSE_ID = "12121212-1212-4121-8121-121212121212";
const ATTEMPT_ID = "66666666-6666-4666-8666-666666666666";

const Q1: AttemptQuestionPublic = {
  id: "lesson-q1",
  type: "choice",
  difficulty: 2,
  knowledge: ["有理数"],
  stemMd: "下列各数中，正数是（）",
  options: ["$+7$", "$-3.5$", "$0$"],
  hintCount: 0,
  questionRevisionId: "rev-q1",
};
const Q2: AttemptQuestionPublic = {
  id: "lesson-q2",
  type: "judge",
  difficulty: 1,
  knowledge: ["有理数"],
  stemMd: "$0$ 既不是正数，也不是负数。[[]]",
  hintCount: 0,
  questionRevisionId: "rev-q2",
};
/** 孤儿冻结题：不在 blocks（教师重导后 markdown 漂移），页尾分组渲染 */
const Q3: AttemptQuestionPublic = {
  id: "lesson-q3",
  type: "judge",
  difficulty: 1,
  knowledge: ["有理数"],
  stemMd: "负数都小于 $0$。[[]]",
  hintCount: 0,
  questionRevisionId: "rev-q3",
};

const DRAFT_SUMMARY: AttemptScoreSummary = {
  total: 3,
  answered: 0,
  correct: 0,
  wrong: 0,
  pending: 0,
  unanswered: 3,
  autoGradable: 0,
  scoreFinal: null,
  pendingCount: 0,
};

function attemptOf(
  status: "draft" | "submitted" | "graded",
  attemptNo = 1,
): LessonStartData["attempt"] {
  return {
    id: ATTEMPT_ID,
    sourceType: "lesson",
    assignmentId: null,
    lectureId: LECTURE_ID,
    courseId: COURSE_ID,
    unitId: "有理数讲练单元",
    attemptNo,
    status,
    startedAt: "2026-10-12T02:00:00.000Z",
    submittedAt: status === "draft" ? null : "2026-10-12T03:00:00.000Z",
    scoreAuto: status === "draft" ? null : 67,
  };
}

/** 讲练开卷投影夹具（进行中卷） */
function lessonStart(overrides?: {
  released?: Record<string, AttemptResultQuestion>;
  status?: "draft" | "submitted" | "graded";
  questions?: AttemptQuestionPublic[];
  blocks?: LessonStartData["blocks"];
  drafts?: LessonStartData["drafts"];
  summary?: AttemptScoreSummary;
}): LessonStartData {
  return {
    lecture: {
      id: LECTURE_ID,
      title: "第1讲 有理数·讲练",
      topic: "有理数",
      courseId: COURSE_ID,
      courseName: "初一上",
    },
    blocks:
      overrides?.blocks ??
      [
        "# 第1讲 有理数·讲练\n\n## 一、正数与负数\n\n收入 500 元与支出 300 元是相反意义的量。",
        "## 二、练一练\n\n先做一道选择题。",
      ].flatMap((md, index) =>
        index === 0
          ? [
              { type: "md" as const, md },
              { type: "question" as const, questionId: Q1.id },
            ]
          : [
              { type: "md" as const, md },
              { type: "question" as const, questionId: Q2.id },
            ],
      ),
    attempt: attemptOf(overrides?.status ?? "draft"),
    questions: overrides?.questions ?? [Q1, Q2, Q3],
    drafts: overrides?.drafts ?? {},
    hintsOpened: {},
    released: overrides?.released ?? {},
    summary:
      overrides?.summary ??
      (overrides?.status === "draft"
        ? DRAFT_SUMMARY
        : { ...DRAFT_SUMMARY, answered: 3 }),
    enabledCapabilities: ["steps", "ink"],
  };
}

function releasedOf(
  question: AttemptQuestionPublic,
  verdict: { autoCorrect: boolean | null; finalCorrect: boolean | null },
): AttemptResultQuestion {
  return {
    questionId: question.id,
    snapshot: {
      id: question.id,
      type: question.type,
      difficulty: question.difficulty,
      knowledge: question.knowledge,
      stemMd: question.stemMd,
      ...(question.options !== undefined ? { options: question.options } : {}),
      hintCount: question.hintCount,
    },
    answers: question.type === "choice" ? { kind: "choice", index: 0 } : null,
    solutionMd: "解析内容。",
    answer: null,
    autoCorrect: verdict.autoCorrect,
    teacherMark: null,
    teacherComment: null,
    finalCorrect: verdict.finalCorrect,
    hintsOpened: [],
  };
}

const NONE_HEAD = {
  note: null,
  images: [],
  evidence: null,
  corrections: [],
  supplements: [],
};

/** 渲染页（含常用落点桩与地址探针） */
function LocationProbe() {
  const location = useLocation();
  return (
    <p data-testid="location-probe">
      {location.pathname}
      {location.search}
    </p>
  );
}

function renderPage(
  path = `/s/lectures/${LECTURE_ID}/lesson?courseId=${COURSE_ID}`,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/s/lectures/:id/lesson"
            element={<StudentLessonPage />}
          />
          <Route path="/s/lectures/:id" element={<LocationProbe />} />
          <Route path="/s/courses/:id" element={<LocationProbe />} />
          <Route path="/s/lectures" element={<LocationProbe />} />
          <Route path="/s/attempts/:attemptId" element={<LocationProbe />} />
          <Route path="*" element={<p data-testid="route-stub">未匹配</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 取第一个「提交本题」按钮（同页多张未提交题卡按文档序点击第一张） */
function firstSubmitButton(): HTMLElement {
  const [first] = screen.getAllByRole("button", { name: "提交本题" });
  if (first === undefined) throw new Error("没有可提交的题卡");
  return first;
}

beforeEach(() => {
  mockedStart.mockReset();
  mockedRestart.mockReset();
  mockedSubmitQuestion.mockReset();
  mockedSubmitAttempt.mockReset();
  // 批量头按请求题数返回空笔记头（无草稿 → none 声明）
  mockedNoteHeads
    .mockReset()
    .mockImplementation(
      async (_attemptId: string, questionIds: readonly string[]) =>
        questionIds.map(() => NONE_HEAD),
    );
  // jsdom 无 matchMedia/scrollIntoView：目录桌面态与滚动桩（同讲义阅读页测试）
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("1024"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  Element.prototype.scrollIntoView = vi.fn();
});

describe("StudentLessonPage：开卷与 blocks 渲染", () => {
  it("进入即幂等开卷（带 courseId），md 段与题卡交替渲染，进度 0/3", async () => {
    mockedStart.mockResolvedValue(lessonStart());
    renderPage();
    expect(await screen.findByText("第 1 题")).toBeInTheDocument();
    expect(mockedStart).toHaveBeenCalledWith(LECTURE_ID, COURSE_ID);
    // md 段标题（RichMarkdown 渲染的 H2）
    expect(
      screen.getByRole("heading", { name: "一、正数与负数", level: 2 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "二、练一练", level: 2 }),
    ).toBeInTheDocument();
    // 两道题槽题卡
    expect(screen.getByText("第 2 题")).toBeInTheDocument();
    expect(screen.getByText("已提交 0/3 题")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "完成练习" }),
    ).toBeInTheDocument();
  });

  it("md 段拼接目录：桌面侧栏展示全部 H2 标题", async () => {
    mockedStart.mockResolvedValue(lessonStart());
    renderPage();
    expect(
      await screen.findByRole("navigation", { name: "讲练目录" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "一、正数与负数" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "二、练一练" }),
    ).toBeInTheDocument();
  });

  it("孤儿冻结题在页尾「本次练习其余题目」分组渲染", async () => {
    mockedStart.mockResolvedValue(lessonStart());
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "本次练习其余题目" }),
    ).toBeInTheDocument();
    expect(screen.getByText("第 3 题")).toBeInTheDocument();
    // 题干渲染（$0$ 经公式管线，断言前缀文本）
    expect(screen.getByText(/^负数都小于/)).toBeInTheDocument();
  });

  it("加载中骨架与错误态（含重试）", async () => {
    mockedStart.mockRejectedValue(
      new ApiError(
        "NOT_FOUND",
        "没有找到该内容（可能尚未发布或已被移除）",
        404,
      ),
    );
    renderPage();
    expect(await screen.findByText("讲练页打开失败")).toBeInTheDocument();
    expect(
      screen.getByText("没有找到该内容（可能尚未发布或已被移除）"),
    ).toBeInTheDocument();
    mockedStart.mockResolvedValue(lessonStart());
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("第 1 题")).toBeInTheDocument();
    expect(mockedStart).toHaveBeenCalledTimes(2);
  });

  it("零题讲练页：纯阅读提示，不渲染完成练习", async () => {
    mockedStart.mockResolvedValue(
      lessonStart({
        questions: [],
        blocks: [
          { type: "md", md: "# 第1讲 有理数·讲练\n\n## 只有讲义\n\n正文。" },
        ],
      }),
    );
    renderPage();
    expect(await screen.findByText(/暂时没有题目/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "完成练习" }),
    ).not.toBeInTheDocument();
  });
});

describe("StudentLessonPage：单题提交", () => {
  it("确认后提交本题：请求带 questionRevisionId 与 none 证据", async () => {
    mockedStart.mockResolvedValue(lessonStart());
    mockedSubmitQuestion.mockResolvedValue({
      question: releasedOf(Q1, { autoCorrect: true, finalCorrect: true }),
      summary: DRAFT_SUMMARY,
      attempt: attemptOf("draft"),
    });
    renderPage();
    await screen.findByText("第 1 题");
    fireEvent.click(firstSubmitButton());
    fireEvent.click(await screen.findByRole("button", { name: "确认提交" }));
    await waitFor(() =>
      expect(mockedSubmitQuestion).toHaveBeenCalledWith(
        ATTEMPT_ID,
        "lesson-q1",
        {
          questionRevisionId: "rev-q1",
          evidence: { questionId: "lesson-q1", state: "none" },
        },
      ),
    );
  });

  it("提交流（预置响应）：卡片转结果态，进度 1/3", async () => {
    mockedStart.mockResolvedValue(lessonStart());
    mockedSubmitQuestion.mockResolvedValue({
      question: releasedOf(Q1, { autoCorrect: true, finalCorrect: true }),
      summary: DRAFT_SUMMARY,
      attempt: attemptOf("draft"),
    });
    renderPage();
    await screen.findByText("第 1 题");
    fireEvent.click(firstSubmitButton());
    fireEvent.click(await screen.findByRole("button", { name: "确认提交" }));
    expect(await screen.findByText("答对")).toBeInTheDocument();
    expect(screen.getByText("已提交 1/3 题")).toBeInTheDocument();
    // 已提交题卡锁定：不再渲染提交按钮
    const submitButtons = screen.queryAllByRole("button", { name: "提交本题" });
    expect(submitButtons).toHaveLength(2); // 第 2 题 + 孤儿第 3 题
  });

  it("QUESTION_ALREADY_SUBMITTED：不报错，重新拉 start 收敛为结果态", async () => {
    mockedStart.mockResolvedValueOnce(lessonStart());
    mockedSubmitQuestion.mockRejectedValue(
      new ApiError("QUESTION_ALREADY_SUBMITTED", "这道题已提交过", 409),
    );
    // 收敛后的 start：q1 已释放
    mockedStart.mockResolvedValue(
      lessonStart({
        released: {
          "lesson-q1": releasedOf(Q1, {
            autoCorrect: true,
            finalCorrect: true,
          }),
        },
      }),
    );
    renderPage();
    await screen.findByText("第 1 题");
    fireEvent.click(firstSubmitButton());
    fireEvent.click(await screen.findByRole("button", { name: "确认提交" }));
    // 弹层关闭且无错误提示；start 重新拉取后题卡为结果态
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("答对")).toBeInTheDocument();
    await waitFor(() => expect(mockedStart).toHaveBeenCalledTimes(2));
  });

  it("QUESTION_REVISION_STALE：弹层提示刷新", async () => {
    mockedStart.mockResolvedValue(lessonStart());
    mockedSubmitQuestion.mockRejectedValue(
      new ApiError(
        "QUESTION_REVISION_STALE",
        "题目版本已变化，请刷新后重试",
        409,
      ),
    );
    renderPage();
    await screen.findByText("第 1 题");
    fireEvent.click(firstSubmitButton());
    fireEvent.click(await screen.findByRole("button", { name: "确认提交" }));
    expect(await screen.findByText(/请刷新后重试/)).toBeInTheDocument();
  });

  it("最后一题提交触发自动收尾：attempt 转 graded → 页面切完成视图（再做一次/查看结果）", async () => {
    // q1、q2 已释放，只余孤儿 q3
    mockedStart.mockResolvedValue(
      lessonStart({
        released: {
          "lesson-q1": releasedOf(Q1, {
            autoCorrect: true,
            finalCorrect: true,
          }),
          "lesson-q2": releasedOf(Q2, {
            autoCorrect: false,
            finalCorrect: false,
          }),
        },
      }),
    );
    mockedSubmitQuestion.mockResolvedValue({
      question: releasedOf(Q3, { autoCorrect: true, finalCorrect: true }),
      summary: {
        ...DRAFT_SUMMARY,
        answered: 3,
        correct: 2,
        wrong: 1,
        autoGradable: 3,
        unanswered: 0,
      },
      attempt: attemptOf("graded"),
    });
    renderPage();
    // 孤儿题的提交按钮（页尾区唯一未提交题）
    await screen.findByText("本次练习其余题目");
    fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认提交" }));
    // 完成视图：已完成状态 + 再做一次 + 查看结果
    expect(
      await screen.findByRole("button", { name: "再做一次" }),
    ).toBeInTheDocument();
    const resultLink = screen.getByRole("link", { name: "查看结果" });
    expect(resultLink).toHaveAttribute("href", `/s/attempts/${ATTEMPT_ID}`);
    expect(
      screen.queryByRole("button", { name: "完成练习" }),
    ).not.toBeInTheDocument();
  });
});

describe("StudentLessonPage：完成练习（整卷收尾）", () => {
  it("未全部提交时「完成练习」：确认后整卷提交，revisions 全集 + evidence 只按未提交题", async () => {
    // 第一段（Once）：进行中卷（q1 已单题提交）
    mockedStart.mockResolvedValueOnce(
      lessonStart({
        released: {
          "lesson-q1": releasedOf(Q1, {
            autoCorrect: true,
            finalCorrect: true,
          }),
        },
      }),
    );
    mockedSubmitAttempt.mockResolvedValue({} as never);
    // 收尾后的 start：全部已释放 + graded
    mockedStart.mockResolvedValue(
      lessonStart({
        status: "graded",
        released: {
          "lesson-q1": releasedOf(Q1, {
            autoCorrect: true,
            finalCorrect: true,
          }),
          "lesson-q2": releasedOf(Q2, {
            autoCorrect: false,
            finalCorrect: false,
          }),
          "lesson-q3": releasedOf(Q3, {
            autoCorrect: true,
            finalCorrect: true,
          }),
        },
      }),
    );
    renderPage();
    expect(await screen.findByText("已提交 1/3 题")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "完成练习" }));
    expect(
      await screen.findByRole("dialog", { name: "确认交卷吗？" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认交卷" }));
    await waitFor(() => expect(mockedSubmitAttempt).toHaveBeenCalled());
    const firstCall = mockedSubmitAttempt.mock.calls[0];
    if (firstCall === undefined) throw new Error("整卷提交未被调用");
    const [attemptId, revisions, evidence] = firstCall;
    expect(attemptId).toBe(ATTEMPT_ID);
    expect(revisions).toEqual([
      { questionId: "lesson-q1", questionRevisionId: "rev-q1" },
      { questionId: "lesson-q2", questionRevisionId: "rev-q2" },
      { questionId: "lesson-q3", questionRevisionId: "rev-q3" },
    ]);
    expect(evidence).toEqual([
      { questionId: "lesson-q2", state: "none" },
      { questionId: "lesson-q3", state: "none" },
    ]);
    // 收尾后切完成视图
    expect(
      await screen.findByRole("button", { name: "再做一次" }),
    ).toBeInTheDocument();
  });

  it("已完成开卷（刷新已完成讲练页）：完成视图 + 汇总 + 再做一次重开新卷", async () => {
    // 第一段：已完成态
    mockedStart.mockResolvedValueOnce(
      lessonStart({
        status: "graded",
        released: {
          "lesson-q1": releasedOf(Q1, {
            autoCorrect: true,
            finalCorrect: true,
          }),
          "lesson-q2": releasedOf(Q2, {
            autoCorrect: false,
            finalCorrect: false,
          }),
          "lesson-q3": releasedOf(Q3, {
            autoCorrect: null,
            finalCorrect: null,
          }),
        },
        summary: {
          ...DRAFT_SUMMARY,
          answered: 3,
          correct: 1,
          wrong: 1,
          pending: 1,
          autoGradable: 2,
          unanswered: 0,
          pendingCount: 1,
        },
      }),
    );
    mockedRestart.mockResolvedValue(lessonStart());
    mockedStart.mockResolvedValue(lessonStart()); // 重做后 start 返回新 draft
    renderPage();
    expect(
      await screen.findByRole("button", { name: "再做一次" }),
    ).toBeInTheDocument();
    // 汇总行（graded：答对 1 · 答错 1 · 待批 1）
    expect(screen.getByText("答对 1 · 答错 1 · 待批 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "再做一次" }));
    fireEvent.click(await screen.findByRole("button", { name: "开始新一轮" }));
    await waitFor(() => expect(mockedRestart).toHaveBeenCalledWith(LECTURE_ID));
    // 重做成功 → 回到作答视图（进度归零）
    expect(await screen.findByText("已提交 0/3 题")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "完成练习" }),
    ).toBeInTheDocument();
  });

  it("已完成视图的题卡为结果态（不渲染作答控件）", async () => {
    mockedStart.mockResolvedValue(
      lessonStart({
        status: "graded",
        released: {
          "lesson-q1": releasedOf(Q1, {
            autoCorrect: true,
            finalCorrect: true,
          }),
          "lesson-q2": releasedOf(Q2, {
            autoCorrect: false,
            finalCorrect: false,
          }),
          "lesson-q3": releasedOf(Q3, {
            autoCorrect: null,
            finalCorrect: null,
          }),
        },
      }),
    );
    renderPage();
    await screen.findByRole("button", { name: "再做一次" });
    expect(
      screen.queryByRole("button", { name: "提交本题" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("答对").length).toBeGreaterThan(0);
    // 题卡附完整结果页链接（收尾后可进订正/笔记）
    expect(screen.getAllByRole("link", { name: "查看完整结果页" }).length).toBe(
      3,
    );
  });
});

describe("StudentLessonPage：导航", () => {
  it("带 courseId 返回课程目录；无 courseId 返回讲义列表", async () => {
    mockedStart.mockResolvedValue(lessonStart());
    renderPage();
    await screen.findByText("第 1 题");
    expect(screen.getByRole("link", { name: "返回课程目录" })).toHaveAttribute(
      "href",
      `/s/courses/${COURSE_ID}`,
    );
  });

  it("无 courseId：返回讲义列表，start 不带课程上下文", async () => {
    mockedStart.mockResolvedValue(lessonStart());
    renderPage(`/s/lectures/${LECTURE_ID}/lesson`);
    await screen.findByText("第 1 题");
    expect(mockedStart).toHaveBeenCalledWith(LECTURE_ID, undefined);
    expect(screen.getByRole("link", { name: "返回讲义列表" })).toHaveAttribute(
      "href",
      "/s/lectures",
    );
  });
});
