import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AttemptContextData, AttemptDraftData } from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { fetchAttemptApi, fetchAttemptContextApi } from "@/lib/api";
import StudentAttemptPage from "@/pages/student/StudentAttemptPage";
import { installDraftBackend, memoryBackend } from "./draft-store";
import {
  bindPracticePreferenceAccount,
  savePracticePreference,
} from "./practice-preference-store";
import { workflowOf } from "./practice-test-fixtures";

/**
 * QM-08 作答会话接线集成（TT-08a 细项 1/2/3）：/attempts/:id/context 冻结
 * 投影经 groupSegmentsOfUnit 解释成组段——组块材料按组共享渲染一份、组内
 * 题卡挂「查看材料」入口（显示题号 + 内部 id 定位分离）、上下文失败非阻断
 * （题面照常 + 就地重试）。组件级行为（宽窄布局纯 CSS 切换不重挂、AI 对照
 * 回退 stack、阅读位置恢复、memo 默认比较、数学/图片渲染）见
 * QuestionGroupBlock.test 与 MaterialPanel.test。
 *
 * 语料刻意不含 `$…$` 数学：KaTeX 输出的 MathML 命名空间元素会让 jsdom
 * getComputedStyle 抛错，testing-library 的 role/label 查询遍历可访问树
 * 即崩；公式渲染正确性由 markdown/组件级测试覆盖，本文件只测接线。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAnnotationViewApi: vi.fn(async () => ({
      base: null,
      maxWidthPx: 1440,
      doc: null,
      annotation: null,
    })),
    fetchAttemptApi: vi.fn(),
    fetchAttemptContextApi: vi.fn(),
    saveAttemptAnswerApi: vi.fn(async () => ({
      questionId: "",
      revision: "",
      updatedAt: "",
    })),
    fetchStudentNoteHeadsApi: vi.fn(async () => []),
  };
});
const mockedFetch = vi.mocked(fetchAttemptApi);
const mockedContext = vi.mocked(fetchAttemptContextApi);

const ATTEMPT_ID = "77777777-7777-4777-8777-777777777777";

const attemptOf = (): AttemptDraftData["attempt"] => ({
  id: ATTEMPT_ID,
  sourceType: "course",
  assignmentId: null,
  lectureId: null,
  courseId: "12121212-1212-4121-8121-121212121212",
  unitId: "材料小练",
  attemptNo: 1,
  status: "draft",
  startedAt: "2026-10-24T02:00:00.000Z",
  submittedAt: null,
  scoreAuto: null,
});

/** 三题草稿：q1/q2 入组、q3 独立——组段与 solo 段并存的最小语料 */
const draftOf = (): AttemptDraftData => ({
  attempt: attemptOf(),
  title: "材料小练",
  courseName: "初一上",
  dueAt: null,
  units: [
    {
      id: "材料小练",
      title: "材料小练",
      questions: [
        {
          id: "q1",
          type: "judge",
          difficulty: 1,
          knowledge: ["读表"],
          stemMd: "周二温差最大。[[]]",
          hintCount: 0,
          questionRevisionId: "rev-q1",
        },
        {
          id: "q2",
          type: "judge",
          difficulty: 2,
          knowledge: ["读表"],
          stemMd: "周四气温为正。[[]]",
          hintCount: 0,
          questionRevisionId: "rev-q2",
        },
        {
          id: "q3",
          type: "judge",
          difficulty: 1,
          knowledge: ["有理数"],
          stemMd: "0 是整数。[[]]",
          hintCount: 0,
          questionRevisionId: "rev-q3",
        },
      ],
    },
  ],
  drafts: {},
  draftRevisions: {},
  hintsOpened: {},
  legacyUnverified: false,
  answerRelease: "on_submit",
  enabledCapabilities: ["steps", "ink"],
  practiceWorkflow: workflowOf(),
  questionProgress: [
    { questionId: "q1", submittedAt: null, feedbackReadable: false },
    { questionId: "q2", submittedAt: null, feedbackReadable: false },
    { questionId: "q3", submittedAt: null, feedbackReadable: false },
  ],
});

/** 冻结上下文：一组（q1+q2）引用一份材料 */
const contextOf = (): AttemptContextData => ({
  attemptId: ATTEMPT_ID,
  materials: [
    {
      id: "mat-1",
      title: "四天气温表",
      contentMd:
        "| 日期 | 最高 | 最低 |\n| --- | --- | --- |\n| 周一 | 1 | -3 |\n| 周二 | 3 | -1 |",
      anchors: [],
      slots: [],
      mediaPaths: [],
      sourceVersion: 1,
    },
  ],
  groups: [
    {
      id: "grp-1",
      title: "根据材料回答第 1～2 题",
      label: "1～2",
      introMd: "先读表，再判断。",
      materialRefs: [{ material: "mat-1" }],
      questionIds: ["q1", "q2"],
      sourceVersion: 1,
    },
  ],
});

function renderPage() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[`/s/attempts/${ATTEMPT_ID}`]}>
        <Routes>
          <Route
            path="/s/attempts/:attemptId"
            element={<StudentAttemptPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function renderWith(context: AttemptContextData | Error) {
  mockedFetch.mockResolvedValue(draftOf());
  if (context instanceof Error) mockedContext.mockRejectedValue(context);
  else mockedContext.mockResolvedValue(context);
  const view = renderPage();
  // judge 题尾 [[]] 渲染为（　），用子串匹配题干本体
  await view.findByText(/周二温差最大/, {}, { timeout: 3000 });
  return view;
}

beforeEach(() => {
  localStorage.clear();
  installDraftBackend(memoryBackend());
  bindPracticePreferenceAccount(null);
  bindPracticePreferenceAccount("qm08-test");
  mockedFetch.mockReset();
  mockedContext.mockReset();
  // jsdom 无 scrollIntoView（reveal 滚入用）；list 布局全题可见（role 查询
  // 不含隐藏行，单题/窄宽切换由组件级测试覆盖）
  Element.prototype.scrollIntoView = () => {};
  savePracticePreference({
    layout: "list",
    keyboardShortcuts: false,
    feedback: null,
  });
});

it("组段渲染：组头一次、共享材料一份、组内题卡可见材料入口（组外无）", async () => {
  await renderWith(contextOf());
  // 组头（题组标记）+ 公共说明
  const groupBlock = screen.getByLabelText("题组：根据材料回答第 1～2 题");
  expect(within(groupBlock).getByText("先读表，再判断。")).toBeInTheDocument();
  // 共享材料一份：材料标题与表格正文各只出现一次
  expect(screen.getAllByText("四天气温表")).toHaveLength(1);
  expect(screen.getAllByText("周二")).toHaveLength(1);
  // 三题题卡都在（题号全卷连续，q3 为 solo 段）
  expect(screen.getByText("第 1 题")).toBeInTheDocument();
  expect(screen.getByText("第 2 题")).toBeInTheDocument();
  expect(screen.getByText("第 3 题")).toBeInTheDocument();
  // 组内题卡挂「查看材料」入口；组外（q3）不挂
  expect(
    screen.getByRole("button", { name: "第 1 题查看共享材料" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "第 2 题查看共享材料" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /第 3 题查看共享材料/ }),
  ).toBeNull();
});

it("查看材料：reveal 后焦点落材料列（阅读位置恢复由组件测试覆盖）", async () => {
  await renderWith(contextOf());
  fireEvent.click(screen.getByRole("button", { name: "第 1 题查看共享材料" }));
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "本组共享材料",
    ),
  );
});

it("上下文读取失败非阻断：题面照常可答 + 就地重试恢复", async () => {
  await renderWith(new Error("共享材料加载失败"));
  // 题面照常（三题都在，可作答）
  expect(
    screen.getAllByRole("radio", { name: "对" }).length,
  ).toBeGreaterThanOrEqual(3);
  // 就地告警 + 重试入口
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("共享材料加载失败");
  // 重试恢复：本仓 mock 逐次固定，重试前切为成功载荷
  mockedContext.mockResolvedValue(contextOf());
  fireEvent.click(
    within(alert).getByRole("button", { name: "重试加载共享材料" }),
  );
  await waitFor(() => {
    expect(screen.queryByText("共享材料加载失败")).toBeNull();
    expect(screen.getByText("四天气温表")).toBeInTheDocument();
  });
});
