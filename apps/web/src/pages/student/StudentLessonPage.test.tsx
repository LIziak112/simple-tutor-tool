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
  submitLessonQuestionApi,
} from "@/lib/api";
import StudentLessonPage from "./StudentLessonPage";

/**
 * /s/lectures/:id/lesson/run 学生讲练作答页（2026-10 讲练一体；10-13 教师
 * 演示口径拆双页后本页挂 /lesson/run，入口在落地页 /lesson）组件测试：
 * 进入即幂等开卷（start）→ blocks 渲染（md 段 + 题卡交替 + 孤儿题分组）、
 * 显示答案（一键直达；错误码收敛；最后一题自动收尾）、再做一次、零题纯阅读
 * 空态、加载/错误三态。教师演示口径：无「完成练习」与进度计数。API 层 mock。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    startLessonAttemptApi: vi.fn(),
    restartLessonAttemptApi: vi.fn(),
    submitLessonQuestionApi: vi.fn(),
    fetchStudentNoteHeadsApi: vi.fn(),
  };
});

const mockedStart = vi.mocked(startLessonAttemptApi);
const mockedRestart = vi.mocked(restartLessonAttemptApi);
const mockedSubmitQuestion = vi.mocked(submitLessonQuestionApi);
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
    answered: false,
    studentFlag: null,
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
  path = `/s/lectures/${LECTURE_ID}/lesson/run?courseId=${COURSE_ID}`,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/s/lectures/:id/lesson/run"
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

/** 取第一个「显示答案」按钮（同页多张未提交题卡按文档序点击第一张） */
function firstSubmitButton(): HTMLElement {
  const [first] = screen.getAllByRole("button", { name: "显示答案" });
  if (first === undefined) throw new Error("没有可显示答案的题卡");
  return first;
}

beforeEach(() => {
  mockedStart.mockReset();
  mockedRestart.mockReset();
  mockedSubmitQuestion.mockReset();
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
  it("进入即幂等开卷（带 courseId），md 段与题卡交替渲染；无进度与完成练习（教师演示口径）", async () => {
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
    // 讲练是讲解材料：头部不渲染进度计数与「完成练习」
    expect(screen.queryByText(/已提交 \d+\/\d+ 题/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "完成练习" }),
    ).not.toBeInTheDocument();
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

  it("零题讲练页：纯阅读提示，不渲染作答控件", async () => {
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
      screen.queryByRole("button", { name: "显示答案" }),
    ).not.toBeInTheDocument();
  });
});

describe("StudentLessonPage：显示答案（单题）", () => {
  it("点击显示答案：一键直达，请求带 questionRevisionId 与 none 证据", async () => {
    mockedStart.mockResolvedValue(lessonStart());
    mockedSubmitQuestion.mockResolvedValue({
      question: releasedOf(Q1, { autoCorrect: true, finalCorrect: true }),
      summary: DRAFT_SUMMARY,
      attempt: attemptOf("draft"),
    });
    renderPage();
    await screen.findByText("第 1 题");
    fireEvent.click(firstSubmitButton());
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

  it("显示答案（预置响应）：卡片转结果态", async () => {
    mockedStart.mockResolvedValue(lessonStart());
    mockedSubmitQuestion.mockResolvedValue({
      question: releasedOf(Q1, { autoCorrect: true, finalCorrect: true }),
      summary: DRAFT_SUMMARY,
      attempt: attemptOf("draft"),
    });
    renderPage();
    await screen.findByText("第 1 题");
    fireEvent.click(firstSubmitButton());
    expect(await screen.findByText("答对")).toBeInTheDocument();
    // 已显示答案的题卡锁定：不再渲染显示答案按钮
    const submitButtons = screen.queryAllByRole("button", { name: "显示答案" });
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
    // 无错误弹层；start 重新拉取后题卡为结果态
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
    expect(await screen.findByText(/请刷新后重试/)).toBeInTheDocument();
  });

  it("最后一题显示答案触发自动收尾：attempt 转 graded → 页面切完成视图（再做一次/查看结果）", async () => {
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
    // 孤儿题的显示答案按钮（页尾区唯一未提交题）
    await screen.findByText("本次练习其余题目");
    fireEvent.click(screen.getByRole("button", { name: "显示答案" }));
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

describe("StudentLessonPage：已完成卷视图", () => {
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
    // 重做成功 → 回到作答视图（三张题卡全部回到作答态）
    expect(
      await screen.findAllByRole("button", { name: "显示答案" }),
    ).toHaveLength(3);
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
      screen.queryByRole("button", { name: "显示答案" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("答对").length).toBeGreaterThan(0);
    // 教师演示简化形态：题卡不带完整结果页链接（结果入口在页面头部「查看结果」）
    expect(
      screen.queryByRole("link", { name: "查看完整结果页" }),
    ).not.toBeInTheDocument();
  });
});

describe("StudentLessonPage：导航", () => {
  it("返回键统一指向讲练落地页（courseId 随行）", async () => {
    mockedStart.mockResolvedValue(lessonStart());
    renderPage();
    await screen.findByText("第 1 题");
    expect(screen.getByRole("link", { name: "返回讲练" })).toHaveAttribute(
      "href",
      `/s/lectures/${LECTURE_ID}/lesson?courseId=${COURSE_ID}`,
    );
  });

  it("无 courseId：落地页地址不带 query，start 不带课程上下文", async () => {
    mockedStart.mockResolvedValue(lessonStart());
    renderPage(`/s/lectures/${LECTURE_ID}/lesson/run`);
    await screen.findByText("第 1 题");
    expect(mockedStart).toHaveBeenCalledWith(LECTURE_ID, undefined);
    expect(screen.getByRole("link", { name: "返回讲练" })).toHaveAttribute(
      "href",
      `/s/lectures/${LECTURE_ID}/lesson`,
    );
  });
});
