import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AttemptDraftData, PracticeWorkflow } from "@tutor/contract";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigationType,
} from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { fetchAttemptApi } from "@/lib/api";
import StudentAttemptPage from "@/pages/student/StudentAttemptPage";
import {
  installDraftBackend,
  type KVBackend,
} from "./draft-store";
import {
  bindPracticePreferenceAccount,
  savePracticePreference,
} from "./practice-preference-store";

/**
 * PracticeWorkspace 集成（M3-D1，§11 纪律 1/7）：v1 新协议卷在作答页引入
 * 列表/单题两种呈现——同一 keyed 题卡序列仅改变容器呈现，互切不重建题面
 * （DOM 节点同一性）；单题切题用 replace 更新 URL q（验证属本卷，非法忽略
 * 回退首道未提交题）；legacy 卷（无 practiceWorkflow）零变化（无摘要行、无
 * 菜单切换项）。lesson 卷不经过本页作答视图（服务端恒不下发 workflow）。
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
    createCorrectionApi: vi.fn(),
    sealCorrectionApi: vi.fn(),
    fetchStudentNotebookApi: vi.fn(),
    fetchStudentNoteHeadsApi: vi.fn(),
  };
});
const mockedFetch = vi.mocked(fetchAttemptApi);

const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";
const COURSE_ID = "12121212-1212-4121-8121-121212121212";

const workflowOf = (
  overrides: Partial<PracticeWorkflow> = {},
): PracticeWorkflow => ({
  version: 1,
  feedbackMode: "per_question",
  revision: 0,
  canChangeFeedback: true,
  allowedFeedbackModes: ["per_question", "after_attempt"],
  canSubmitQuestion: true,
  restrictionReason: null,
  releaseAt: null,
  ...overrides,
});

/** 三题课程草稿：q1 已提交（反馈可读），q2/q3 未提交；首道未提交 = q2 */
const baseDraft = (): AttemptDraftData => ({
  attempt: {
    id: ATTEMPT_ID,
    sourceType: "course",
    assignmentId: null,
    lectureId: null,
    courseId: COURSE_ID,
    unitId: "有理数小练",
    attemptNo: 1,
    status: "draft",
    startedAt: "2026-10-23T02:00:00.000Z",
    submittedAt: null,
    scoreAuto: null,
  },
  title: "有理数小练",
  courseName: "初一上",
  dueAt: null,
  units: [
    {
      id: "有理数小练",
      title: "有理数小练",
      questions: [
        {
          id: "q1",
          type: "judge",
          difficulty: 1,
          knowledge: ["有理数的概念"],
          stemMd: "$0$ 既不是正数，也不是负数。[[]]",
          hintCount: 0,
          questionRevisionId: "rev-q1",
        },
        {
          id: "q2",
          type: "fill",
          difficulty: 2,
          knowledge: ["有理数加法"],
          stemMd: "计算：$(-3)+7=$ [[]]。",
          hintCount: 0,
          questionRevisionId: "rev-q2",
        },
        {
          id: "q3",
          type: "judge",
          difficulty: 2,
          knowledge: ["有理数减法"],
          stemMd: "$5-8$ 是负数。[[]]",
          hintCount: 0,
          questionRevisionId: "rev-q3",
        },
      ],
    },
  ],
  drafts: {},
  hintsOpened: {},
  legacyUnverified: false,
  answerRelease: "on_submit",
  enabledCapabilities: ["steps", "ink"],
});

const v1Draft = (): AttemptDraftData => ({
  ...baseDraft(),
  practiceWorkflow: workflowOf(),
  questionProgress: [
    {
      questionId: "q1",
      submittedAt: "2026-10-23T02:10:00.000Z",
      feedbackReadable: true,
    },
    { questionId: "q2", submittedAt: null, feedbackReadable: false },
    { questionId: "q3", submittedAt: null, feedbackReadable: false },
  ],
});

/** 路由探针：暴露 MemoryRouter 的位置与导航动作（断言 replace 语义） */
const locationRef = {
  search: "",
  action: "POP" as "POP" | "PUSH" | "REPLACE",
};
function LocationProbe() {
  const location = useLocation();
  locationRef.search = location.search;
  locationRef.action = useNavigationType();
  return null;
}

function renderPage(search = "") {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[`/s/attempts/${ATTEMPT_ID}${search}`]}>
        <Routes>
          <Route
            path="/s/attempts/:attemptId"
            element={
              <>
                <LocationProbe />
                <StudentAttemptPage />
              </>
            }
          />
          <Route path="*" element={<p data-testid="route-stub">未匹配</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openPracticeMenu() {
  // Radix 菜单触发响应 pointerdown（jsdom 需显式指针序列，见 AttemptHeader.test）
  fireEvent.pointerDown(screen.getByRole("button", { name: "练习更多" }), {
    button: 0,
    ctrlKey: false,
  });
  await waitFor(() =>
    expect(
      screen.getByRole("menuitem", { name: "练习信息" }),
    ).toBeInTheDocument(),
  );
}

beforeEach(() => {
  localStorage.clear();
  bindPracticePreferenceAccount(null);
  bindPracticePreferenceAccount("m3d1-test");
  mockedFetch.mockReset();
});

it("v1 卷默认列表呈现：摘要行可见，三题同列渲染", async () => {
  mockedFetch.mockResolvedValue(v1Draft());
  const { container } = renderPage();
  expect(
    await screen.findByText(/做题方式：列表 · 每题提交后查看/),
  ).toBeInTheDocument();
  // 三张题卡都在 DOM（列表呈现）
  expect(container.querySelectorAll("article")).toHaveLength(3);
  expect(locationRef.search).toBe("");
});

it("legacy 卷零变化：无摘要行、更多菜单无做题方式项", async () => {
  mockedFetch.mockResolvedValue(baseDraft());
  renderPage();
  await screen.findByRole("button", { name: "交卷" });
  expect(screen.queryByText(/做题方式：/)).toBeNull();
  expect(screen.queryByRole("button", { name: /调整做题方式/ })).toBeNull();
  fireEvent.pointerDown(screen.getByRole("button", { name: "练习更多" }), {
    button: 0,
    ctrlKey: false,
  });
  await waitFor(() =>
    expect(
      screen.getByRole("menuitem", { name: "练习信息" }),
    ).toBeInTheDocument(),
  );
  expect(
    screen.queryByRole("menuitemradio", { name: /做题方式：/ }),
  ).toBeNull();
});

it("菜单切单题：仅当前题可见、其余隐藏但不卸载；进度行计数正确", async () => {
  mockedFetch.mockResolvedValue(v1Draft());
  const { container } = renderPage();
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  // 切换前抓 q2 输入节点（DOM 同一性断言用）
  const q2InputBefore = screen.getByRole("textbox", { name: "第1空" });
  await openPracticeMenu();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：单题/ }),
  );
  // 摘要切换为单题；进入定位首道未提交 q2（q1 已提交）
  expect(
    await screen.findByText(/做题方式：单题 · 每题提交后查看/),
  ).toBeInTheDocument();
  expect(screen.getByText("第 2 / 3 题 · 已提交 1 题")).toBeInTheDocument();
  // 非当前题隐藏且不可聚焦（display:none 离开可访问树），但 DOM 节点保留
  expect(screen.queryByRole("radio", { name: /正确|对|错|√|×/ })).toBeNull();
  expect(container.querySelectorAll("article")).toHaveLength(3);
  // q2 输入仍是同一 DOM 节点（题卡未重建，§11 纪律 1）
  expect(screen.getByRole("textbox", { name: "第1空" })).toBe(q2InputBefore);
  // URL 以 replace 写入 q（不加历史条目）
  await waitFor(() => expect(locationRef.search).toContain("q=q2"));
  expect(locationRef.action).toBe("REPLACE");
});

it("列表↔单题互切题卡不重建，切回列表恢复全部题可见", async () => {
  mockedFetch.mockResolvedValue(v1Draft());
  renderPage();
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  const q2Input = screen.getByRole("textbox", { name: "第1空" });
  await openPracticeMenu();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：单题/ }),
  );
  await screen.findByText(/做题方式：单题 · 每题提交后查看/);
  expect(screen.getByRole("textbox", { name: "第1空" })).toBe(q2Input);
  await openPracticeMenu();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：列表/ }),
  );
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  expect(screen.getByRole("textbox", { name: "第1空" })).toBe(q2Input);
  // 回列表后各题恢复可见（q3 判断题选项可再访问）
  expect(screen.getAllByRole("radio").length).toBeGreaterThanOrEqual(2);
  // 回列表清除 q
  await waitFor(() => expect(locationRef.search).toBe(""));
});

it("单题模式上一题/下一题切换题目并 replace 更新 q", async () => {
  mockedFetch.mockResolvedValue(v1Draft());
  const { container } = renderPage();
  // D2 起当前题为已提交时主操作位追加「下一题」（同在操作条容器内）；
  // 本用例只考操作条的切题钮（outline 变体）
  const bar = () => {
    const element = container.querySelector<HTMLElement>(
      '[data-slot="practice-action-bar"]',
    );
    if (element === null) throw new Error("操作条未渲染");
    return element;
  };
  const barNext = () => {
    const button = within(bar())
      .getAllByRole("button", { name: "下一题" })
      .find((item) => item.dataset.variant === "outline");
    if (button === undefined) throw new Error("操作条下一题未渲染");
    return button;
  };
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  await openPracticeMenu();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：单题/ }),
  );
  await screen.findByText("第 2 / 3 题 · 已提交 1 题");
  // 首题边界：q2 不是第一题，上一题到 q1
  fireEvent.click(screen.getByRole("button", { name: "上一题" }));
  await waitFor(() =>
    expect(screen.getByText("第 1 / 3 题 · 已提交 1 题")).toBeInTheDocument(),
  );
  await waitFor(() => expect(locationRef.search).toContain("q=q1"));
  expect(screen.getByRole("button", { name: "上一题" })).toBeDisabled();
  fireEvent.click(barNext());
  await waitFor(() =>
    expect(screen.getByText("第 2 / 3 题 · 已提交 1 题")).toBeInTheDocument(),
  );
  fireEvent.click(barNext());
  await waitFor(() =>
    expect(screen.getByText("第 3 / 3 题 · 已提交 1 题")).toBeInTheDocument(),
  );
  expect(barNext()).toBeDisabled();
  await waitFor(() => expect(locationRef.search).toContain("q=q3"));
});

it("偏好默认单题：进入即单题呈现，非法 q 忽略并定位首道未提交题", async () => {
  savePracticePreference({ layout: "single", keyboardShortcuts: true });
  mockedFetch.mockResolvedValue(v1Draft());
  renderPage("?q=not-exist");
  expect(
    await screen.findByText(/做题方式：单题 · 每题提交后查看/),
  ).toBeInTheDocument();
  expect(screen.getByText("第 2 / 3 题 · 已提交 1 题")).toBeInTheDocument();
});

it("偏好默认单题：合法 q 直达该题", async () => {
  savePracticePreference({ layout: "single", keyboardShortcuts: true });
  mockedFetch.mockResolvedValue(v1Draft());
  renderPage("?q=q3");
  expect(
    await screen.findByText("第 3 / 3 题 · 已提交 1 题"),
  ).toBeInTheDocument();
});

it("受限卷（老师要求交卷后公布）在摘要行显示受限文案", async () => {
  mockedFetch.mockResolvedValue({
    ...v1Draft(),
    practiceWorkflow: workflowOf({
      feedbackMode: "after_attempt",
      canChangeFeedback: false,
      allowedFeedbackModes: ["after_attempt"],
      canSubmitQuestion: false,
      restrictionReason: "teacher_after_attempt",
    }),
  });
  renderPage();
  expect(
    await screen.findByText(/做题方式：列表 · 交卷后查看/),
  ).toBeInTheDocument();
  expect(screen.getByText(/老师要求交卷后公布/)).toBeInTheDocument();
});

it("v1 卷导航区四态可见且已提交待公布行无对错泄露", async () => {
  mockedFetch.mockResolvedValue({
    ...v1Draft(),
    questionProgress: [
      {
        questionId: "q1",
        submittedAt: "2026-10-23T02:10:00.000Z",
        feedbackReadable: false,
      },
      { questionId: "q2", submittedAt: null, feedbackReadable: false },
      { questionId: "q3", submittedAt: null, feedbackReadable: false },
    ],
  });
  renderPage();
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  // 统一公布模式：q1 已提交但反馈不可读——导航只报提交事实
  const submitted = screen.getByRole("button", {
    name: "第 1 题，已提交，反馈待公布",
  });
  expect(submitted.textContent).not.toMatch(/对|错|正确|得分/);
  expect(
    screen.getByRole("button", { name: /第 2 题，未填写/ }),
  ).toBeInTheDocument();
});

// ---------- M3-D1.5：硬刷新直达作答页时绑定晚于首渲染的默认布局对齐 ----------

/** 预置账号 x 的持久化默认「单题」，随后回到未绑定（模拟硬刷新时序） */
function presetSingleAccountThenUnbind() {
  bindPracticePreferenceAccount(null);
  bindPracticePreferenceAccount("x");
  savePracticePreference({ layout: "single", keyboardShortcuts: true });
  bindPracticePreferenceAccount(null);
}

it("未绑定先渲染回落列表：账号绑定时按已保存单题对齐一次", async () => {
  presetSingleAccountThenUnbind();
  mockedFetch.mockResolvedValue(v1Draft());
  renderPage();
  // 布局层账号绑定 effect 晚于本组件首渲染：初始只回落列表
  expect(
    await screen.findByText(/做题方式：列表 · 每题提交后查看/),
  ).toBeInTheDocument();
  // 布局层绑定该账号：呈现按已保存默认布局切为单题（一次性对齐）
  act(() => {
    bindPracticePreferenceAccount("x");
  });
  expect(
    await screen.findByText(/做题方式：单题 · 每题提交后查看/),
  ).toBeInTheDocument();
  expect(screen.getByText("第 2 / 3 题 · 已提交 1 题")).toBeInTheDocument();
});

it("显式切换过布局后，账号绑定与跨标签变更不拉扯当前选择", async () => {
  presetSingleAccountThenUnbind();
  mockedFetch.mockResolvedValue(v1Draft());
  renderPage();
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  // 用户显式切到单题再切回列表：本次作答内自决
  await openPracticeMenu();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：单题/ }),
  );
  await screen.findByText(/做题方式：单题 · 每题提交后查看/);
  await openPracticeMenu();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：列表/ }),
  );
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  // 此刻才绑定「默认单题」账号：不得覆盖用户显式选择
  act(() => {
    bindPracticePreferenceAccount("x");
  });
  // 跨标签再改默认偏好同样不拉扯（store 订阅只对齐绑定时刻，不跟随变更）
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: `ownclass:practice-pref:${JSON.stringify([location.origin, "student", "x"])}`,
        newValue:
          '{"version":1,"layout":"single","feedback":"per_question","keyboardShortcuts":true}',
        storageArea: localStorage,
      }),
    );
  });
  expect(
    screen.getByText(/做题方式：列表 · 每题提交后查看/),
  ).toBeInTheDocument();
});

// ---------- M3-D3：单题切题本机落盘保护（§11-5） ----------

/** 可注入本机写失败的后端（只关心 set；读走内存缓存不触发 get） */
function installSwitchGuardBackend(failRef: { current: boolean }): void {
  const backend: KVBackend = {
    get: async () => undefined,
    set: async () => {
      if (failRef.current) throw new Error("配额不足");
    },
    del: async () => {},
  };
  installDraftBackend(backend);
}

it("单题切题保护：本机写失败不切题并提示，重试成功后再切题", async () => {
  const failRef = { current: false };
  installSwitchGuardBackend(failRef);
  // q1 有本机草稿：attempt 记录存在，切题前的本机落盘会真实写后端
  mockedFetch.mockResolvedValue({
    ...v1Draft(),
    drafts: { q1: { kind: "judge", value: true } },
    draftRevisions: { q1: 2 },
  });
  renderPage();
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  await openPracticeMenu();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：单题/ }),
  );
  await screen.findByText("第 2 / 3 题 · 已提交 1 题");
  failRef.current = true;
  fireEvent.click(screen.getByRole("button", { name: "上一题" }));
  // 不切题：仍停留 q2，就地提示与重试入口
  expect(
    await screen.findByText("本机稿未保存，仍停留本题"),
  ).toBeInTheDocument();
  expect(screen.getByText("第 2 / 3 题 · 已提交 1 题")).toBeInTheDocument();
  expect(locationRef.search).toContain("q=q2");
  // 重试成功：继续切到 q1，提示收起
  failRef.current = false;
  fireEvent.click(screen.getByRole("button", { name: "重试保存并切换" }));
  await waitFor(() =>
    expect(
      screen.getByText("第 1 / 3 题 · 已提交 1 题"),
    ).toBeInTheDocument(),
  );
  await waitFor(() => expect(locationRef.search).toContain("q=q1"));
  expect(screen.queryByText("本机稿未保存，仍停留本题")).toBeNull();
});

it("单题切题成功后焦点落题干容器，URL q 同步 replace", async () => {
  mockedFetch.mockResolvedValue(v1Draft());
  renderPage();
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  await openPracticeMenu();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：单题/ }),
  );
  await screen.findByText("第 2 / 3 题 · 已提交 1 题");
  fireEvent.click(screen.getByRole("button", { name: "下一题" }));
  await waitFor(() =>
    expect(screen.getByText("第 3 / 3 题 · 已提交 1 题")).toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("data-question-id")).toBe(
      "q3",
    ),
  );
  await waitFor(() => expect(locationRef.search).toContain("q=q3"));
});
