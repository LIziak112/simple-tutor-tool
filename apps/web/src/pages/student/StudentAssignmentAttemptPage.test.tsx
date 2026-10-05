import { fireEvent, screen, waitFor } from "@testing-library/react";
import type {
  AttemptDraftData,
  AttemptResultData,
  AttemptStartData,
  InkDoc,
  StudentAnswer,
} from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  draftStore,
  installDraftBackend,
  memoryBackend,
} from "@/features/attempt/draft-store";
import {
  fetchAttemptApi,
  openAttemptHintApi,
  postAttemptEventsApi,
  putAttemptInkApi,
  saveAttemptAnswerApi,
  startAttemptApi,
  submitAttemptApi,
} from "@/lib/api";
import { installEventStore, memoryEventStore } from "@/lib/event-queue";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentAssignmentAttemptPage from "./StudentAssignmentAttemptPage";

/**
 * 答题页整页流程测试（T2.6，API 层 mock）：
 * - 进入自动 POST attempt → 草稿视图渲染题卡与吸底进度条；
 * - 作答触发草稿保存（判断题立即保存）；
 * - 交卷确认弹层显示未答数量 → 确认后 submit → 详情失效重取 → 切结果视图；
 * - attempt 已交卷时进入直接渲染结果视图（不开新卷）。
 * T2.8 追加：交卷 flush——确认交卷先把每道手写题最新笔迹 PUT 上传（调用顺序
 * 先于 submit）；任一失败阻止交卷并给出可指导提示，恢复后重试成功。
 * 引擎（InkPad）mock 为「模拟书写一笔」按钮，控制笔迹变化时机。
 * T2.9 追加：刷新恢复（本地草稿仓合并）、断网三态、交卷清草稿——
 * 每个用例注入干净内存后端（jsdom 无 indexedDB，不引入 fake-indexeddb）。
 */

// InkPad mock：暴露触发 onDocChange 的按钮 + 填充可 exportPng 的引擎 stub
vi.mock("@/features/ink/InkPad", () => ({
  InkPad: (props: {
    engine?: string;
    onDocChange?: ((doc: InkDoc) => void) | undefined;
    engineRef?: { current: unknown };
  }) => {
    if (props.engineRef && props.engineRef.current === null) {
      props.engineRef.current = {
        getData: () => {
          throw new Error("测试未使用");
        },
        exportPng: () =>
          Promise.resolve(
            new Blob([new Uint8Array([0x89, 0x50])], { type: "image/png" }),
          ),
      };
    }
    return (
      <div data-slot="ink-pad" data-engine={props.engine ?? "atrament"}>
        <button
          type="button"
          data-testid={`ink-emit-${props.engine ?? "atrament"}`}
          onClick={() =>
            props.onDocChange?.({
              engine: "atrament",
              version: 1,
              data: {
                width: 1000,
                strokes: [
                  {
                    tool: "pen",
                    color: "#000",
                    weight: 4,
                    points: [{ x: 1, y: 1, p: 0.5, t: 0 }],
                  },
                ],
              },
              updatedAt: 2,
            })
          }
        >
          模拟书写一笔
        </button>
      </div>
    );
  },
}));

// gzip mock：jsdom 的 Blob 流与 node 全局 CompressionStream 组合不可靠，
// 返回原始字节（服务端对无 gzip 魔数的载荷按原始 JSON 兼容解析）
vi.mock("@/features/ink/gzip", () => ({
  gzipOrRaw: async (text: string) => new TextEncoder().encode(text),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    startAttemptApi: vi.fn(),
    fetchAttemptApi: vi.fn(),
    saveAttemptAnswerApi: vi.fn(),
    submitAttemptApi: vi.fn(),
    // T2.8：笔迹取回（默认无历史笔迹）与上传（成功回执）
    fetchAttemptInkApi: vi.fn(async () => null),
    putAttemptInkApi: vi.fn(async () => ({
      questionId: "q-ink",
      inkId: "77777777-7777-4777-8777-777777777777",
      strokeCount: 1,
      width: 100,
      height: 50,
      updatedAt: "2026-09-27T00:00:00.000Z",
    })),
    // T2.10：学习痕迹事件上报（埋点用例断言调用参数）
    postAttemptEventsApi: vi.fn(async () => ({ accepted: 1 })),
    postLectureEventsApi: vi.fn(async () => ({ accepted: 1 })),
    // T2.11：分步提示解锁（提示用例断言调用参数）
    openAttemptHintApi: vi.fn(),
  };
});

const mockedStart = vi.mocked(startAttemptApi);
const mockedFetch = vi.mocked(fetchAttemptApi);
const mockedSave = vi.mocked(saveAttemptAnswerApi);
const mockedSubmit = vi.mocked(submitAttemptApi);
const mockedPutInk = vi.mocked(putAttemptInkApi);
const mockedPostEvents = vi.mocked(postAttemptEventsApi);
const mockedOpenHint = vi.mocked(openAttemptHintApi);

const ASSIGNMENT_ID = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";

const START_DRAFT: AttemptStartData = {
  id: ATTEMPT_ID,
  sourceType: "assignment",
  assignmentId: ASSIGNMENT_ID,
  courseId: null,
  // T2A.7：assignment 来源多单元化后 unitId 为 null
  unitId: null,
  attemptNo: 1,
  status: "draft",
  startedAt: "2026-09-27T02:00:00.000Z",
  submittedAt: null,
  scoreAuto: null,
};

const DRAFT_DATA: AttemptDraftData = {
  attempt: START_DRAFT,
  title: "周末加练",
  courseName: null,
  dueAt: "2026-10-01T12:00:00.000Z",
  // T2A.7：题目按单元分组下发（单单元一组）
  units: [
    {
      id: "练习四",
      title: "练习四",
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
        {
          id: "练习四-4",
          type: "fill",
          difficulty: 2,
          knowledge: ["有理数加法"],
          stemMd: "计算：$(-3)+7=$ [[]]。",
          hintCount: 1,
          questionRevisionId: "rev-练习四-4",
        },
      ],
    },
  ],
  drafts: {},
  hintsOpened: {},
  legacyUnverified: false,
};

const RESULT_DATA: AttemptResultData = {
  attempt: {
    ...START_DRAFT,
    status: "submitted",
    submittedAt: "2026-09-27T02:30:00.000Z",
    scoreAuto: 100,
  },
  title: "周末加练",
  courseName: null,
  dueAt: "2026-10-01T12:00:00.000Z",
  answersReleased: true,
  summary: {
    total: 2,
    answered: 2,
    correct: 2,
    wrong: 0,
    pending: 0,
    unanswered: 0,
    autoGradable: 2,
    // D9（T3.5）：交卷即 graded → scoreFinal=100、待批 0
    scoreFinal: 100,
    pendingCount: 0,
  },
  units: [
    {
      id: "练习四",
      title: "练习四",
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
          answer: { kind: "judge", value: true },
          autoCorrect: true,
          teacherMark: null,
          teacherComment: null,
          finalCorrect: true,
          hintsOpened: [],
        },
        {
          questionId: "练习四-4",
          snapshot: {
            id: "练习四-4",
            type: "fill",
            difficulty: 2,
            knowledge: ["有理数加法"],
            stemMd: "计算：$(-3)+7=$ [[4]]。",
            hintCount: 1,
          },
          answers: { kind: "fill", blanks: [["4"]] },
          solutionMd: null,
          answer: { kind: "fill", values: ["4"] },
          autoCorrect: true,
          teacherMark: null,
          teacherComment: null,
          finalCorrect: true,
          hintsOpened: [],
        },
      ],
    },
  ],
};

function renderPage() {
  return renderWithStudentRoutes({
    initialPath: `/s/assignments/${ASSIGNMENT_ID}`,
    routePath: "/s/assignments/:id",
    element: <StudentAssignmentAttemptPage />,
  });
}

beforeEach(() => {
  mockedStart.mockReset();
  mockedFetch.mockReset();
  mockedSave.mockReset();
  mockedSubmit.mockReset();
  mockedPutInk.mockReset();
  mockedPostEvents.mockReset();
  mockedPostEvents.mockResolvedValue({ accepted: 1 });
  mockedPutInk.mockResolvedValue({
    questionId: "q-ink",
    inkId: "77777777-7777-4777-8777-777777777777",
    strokeCount: 1,
    width: 100,
    height: 50,
    updatedAt: "2026-09-27T00:00:00.000Z",
  });
  installDraftBackend(memoryBackend());
  installEventStore(memoryEventStore());
});

describe("StudentAssignmentAttemptPage：草稿作答流程", () => {
  it("进入自动创建 attempt 并渲染题卡、进度条与截止时间", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch.mockResolvedValue(DRAFT_DATA);
    renderPage();

    expect(await screen.findByText("周末加练")).toBeInTheDocument();
    expect(mockedStart).toHaveBeenCalledWith(ASSIGNMENT_ID);
    expect(mockedFetch).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(screen.getByText("第 1 题")).toBeInTheDocument();
    expect(screen.getByText("第 2 题")).toBeInTheDocument();
    // 进度条文本含 <b> 强调，用整页文本断言
    expect(document.body.textContent).toContain("已答 0 / 2 题");
    expect(screen.getByText("10月1日 20:00 截止")).toBeInTheDocument();
  });

  it("作答即保存：点判断题「对」立即 PUT 草稿，进度条更新", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch.mockResolvedValue(DRAFT_DATA);
    mockedSave.mockResolvedValue({ questionId: "练习四-1", changeCount: 1 });
    renderPage();

    await screen.findByText("第 1 题");
    fireEvent.click(screen.getByRole("radio", { name: /对/ }));

    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledWith(ATTEMPT_ID, "练习四-1", {
        kind: "judge",
        value: true,
      } satisfies StudentAnswer);
    });
    expect(document.body.textContent).toContain("已答 1 / 2 题");
  });

  it("交卷确认显示未答数量；确认后 submit 并切结果视图", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    // 第一次取详情=草稿，交卷失效后重取=结果
    mockedFetch
      .mockResolvedValueOnce(DRAFT_DATA)
      .mockResolvedValue(RESULT_DATA);
    mockedSave.mockResolvedValue({ questionId: "练习四-1", changeCount: 1 });
    mockedSubmit.mockResolvedValue(RESULT_DATA);
    renderPage();

    await screen.findByText("第 1 题");
    fireEvent.click(screen.getByRole("radio", { name: /对/ }));
    await waitFor(() => expect(mockedSave).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "交卷" }));
    expect(
      await screen.findByText("还有 1 题没有作答，交卷后不能再修改答案。"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认交卷" }));
    await waitFor(() =>
      // T6R.3：交卷回传建卷下发的题目版本集合（questionRevisionId）
      expect(mockedSubmit).toHaveBeenCalledWith(ATTEMPT_ID, [
        { questionId: "练习四-1", questionRevisionId: "rev-练习四-1" },
        { questionId: "练习四-4", questionRevisionId: "rev-练习四-4" },
      ]),
    );
    // 详情已失效重取 → 结果视图
    expect(await screen.findByText(/批改结果/)).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "交卷" })).toBeNull();
  });

  it("attempt 创建失败显示错误态与重试", async () => {
    mockedStart.mockRejectedValue(new Error("未被指派此作业，无权作答"));
    renderPage();

    expect(await screen.findByText("打不开这份作业")).toBeInTheDocument();
    expect(screen.getByText("未被指派此作业，无权作答")).toBeInTheDocument();
    // 重试重新发起
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch.mockResolvedValue(DRAFT_DATA);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("周末加练");
  });
});

describe("StudentAssignmentAttemptPage：已交卷直接结果视图", () => {
  it("startAttempt 返回 submitted 时不开新卷，直接渲染结果", async () => {
    mockedStart.mockResolvedValue(RESULT_DATA.attempt);
    mockedFetch.mockResolvedValue(RESULT_DATA);
    renderPage();

    expect(await screen.findByText(/批改结果/)).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledWith(ATTEMPT_ID);
    // 答题控件不出现
    expect(screen.queryByRole("radio", { name: /对/ })).toBeNull();
  });
});

// ---------- T2.8：交卷 flush（笔迹上传先于 submit） ----------

/** 两道手写题的草稿视图 */
const HANDWRITTEN_DRAFT: AttemptDraftData = {
  attempt: START_DRAFT,
  title: "手写练习",
  courseName: null,
  dueAt: null,
  units: [
    {
      id: "练习四",
      title: "练习四",
      questions: [
        {
          id: "q-ink-1",
          type: "solve",
          difficulty: 3,
          knowledge: ["计算"],
          stemMd: "第一道手写题",
          hintCount: 0,
          questionRevisionId: "rev-q-ink-1",
        },
        {
          id: "q-ink-2",
          type: "apply",
          difficulty: 3,
          knowledge: ["应用"],
          stemMd: "第二道手写题",
          hintCount: 0,
          questionRevisionId: "rev-q-ink-2",
        },
      ],
    },
  ],
  drafts: {},
  hintsOpened: {},
  legacyUnverified: false,
};

/** 展开下一道未展开的手写题并「书写一笔」（展开后按钮变「收起」，故每次取第一个） */
async function writeOnNextHandwritten(): Promise<void> {
  const toggles = screen.getAllByRole("button", { name: /展开手写区/ });
  fireEvent.click(toggles[0] as HTMLElement);
  const emits = await screen.findAllByTestId("ink-emit-atrament");
  fireEvent.click(emits[emits.length - 1] as HTMLElement);
}

/** 点交卷并确认 */
async function clickSubmitAndConfirm(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "交卷" }));
  const confirm = await screen.findByRole("button", { name: "确认交卷" });
  fireEvent.click(confirm);
}

describe("StudentAssignmentAttemptPage：交卷 flush", () => {
  it("两道手写题都写过 → 逐题 PUT 全部完成后才调 submit（调用顺序）", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch
      .mockResolvedValueOnce(HANDWRITTEN_DRAFT)
      .mockResolvedValue(RESULT_DATA);
    mockedSubmit.mockResolvedValue(RESULT_DATA);
    renderPage();

    await screen.findByText("第一道手写题");
    await writeOnNextHandwritten();
    await writeOnNextHandwritten();
    await clickSubmitAndConfirm();

    await waitFor(() => expect(mockedPutInk).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockedSubmit).toHaveBeenCalledTimes(1));
    // 顺序：两次 PUT 的调用序号都早于 submit（任务验收口径）
    const submitOrder = mockedSubmit.mock.invocationCallOrder[0] ?? 0;
    for (const order of mockedPutInk.mock.invocationCallOrder) {
      expect(order).toBeLessThan(submitOrder);
    }
  });

  it("没写过笔迹的手写题不阻塞交卷（flush no-op）", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch
      .mockResolvedValueOnce(HANDWRITTEN_DRAFT)
      .mockResolvedValue(RESULT_DATA);
    mockedSubmit.mockResolvedValue(RESULT_DATA);
    renderPage();

    await screen.findByText("第一道手写题");
    await clickSubmitAndConfirm();

    await waitFor(() => expect(mockedSubmit).toHaveBeenCalledTimes(1));
    expect(mockedPutInk).not.toHaveBeenCalled();
  });

  it("笔迹上传失败：submit 被阻止 + 底栏可指导提示；恢复后重新交卷成功", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch
      .mockResolvedValueOnce(HANDWRITTEN_DRAFT)
      .mockResolvedValue(RESULT_DATA);
    mockedSubmit.mockResolvedValue(RESULT_DATA);
    renderPage();

    await screen.findByText("第一道手写题");
    await writeOnNextHandwritten();
    mockedPutInk.mockRejectedValueOnce(new Error("network down"));
    await clickSubmitAndConfirm();

    await waitFor(() => expect(mockedPutInk).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByText(/有题目的笔迹还没上传成功，交卷被暂时阻止/),
      ).toBeVisible(),
    );
    expect(mockedSubmit).not.toHaveBeenCalled();

    // 网络恢复：重新交卷 → flush 重试成功 → submit 才发生
    await clickSubmitAndConfirm();
    await waitFor(() => expect(mockedSubmit).toHaveBeenCalledTimes(1));
    expect(mockedPutInk).toHaveBeenCalledTimes(2);
  });
});

// ---------- T2.9：草稿防丢（刷新恢复 / 交卷清草稿 / 顶栏三态） ----------

/** 本地预置一笔笔迹（刷新前已写、尚未同步到服务端的场景） */
function localInkDoc(strokes: number): InkDoc {
  return {
    engine: "atrament",
    version: 1,
    data: {
      width: 1000,
      strokes: Array.from({ length: strokes }, () => ({
        tool: "pen" as const,
        color: "#000",
        weight: 4,
        points: [{ x: 1, y: 1, p: 0.5, t: 0 }],
      })),
    },
    updatedAt: 2,
  };
}

describe("StudentAssignmentAttemptPage：草稿防丢", () => {
  it("刷新恢复（答案）：本地较新的答案在进入页面后还原到控件，并自动补传服务端", async () => {
    // 模拟「上次会话写了答案、刷新前最后一次同步没到服务端」：
    // 本地草稿仓有答案，服务端 drafts 为空
    draftStore.saveAnswer(ATTEMPT_ID, "练习四-1", {
      kind: "judge",
      value: true,
    });
    draftStore.saveAnswer(ATTEMPT_ID, "练习四-4", {
      kind: "fill",
      values: ["4"],
    });
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch.mockResolvedValue(DRAFT_DATA);
    mockedSave.mockResolvedValue({ questionId: "练习四-1", changeCount: 1 });
    renderPage();

    // 控件状态还原（判断选中「对」、填空带值）
    const yes = await screen.findByRole("radio", { name: /对/ });
    await waitFor(() => expect(yes).toBeChecked());
    expect(screen.getByDisplayValue("4")).toBeInTheDocument();
    expect(document.body.textContent).toContain("已答 2 / 2 题");
    // 合并后本地较新 → 触发一次增量同步（逐题 PUT）
    await waitFor(() =>
      expect(mockedSave).toHaveBeenCalledWith(ATTEMPT_ID, "练习四-1", {
        kind: "judge",
        value: true,
      } satisfies StudentAnswer),
    );
    expect(mockedSave).toHaveBeenCalledWith(ATTEMPT_ID, "练习四-4", {
      kind: "fill",
      values: ["4"],
    } satisfies StudentAnswer);
  });

  it("刷新恢复（笔迹）：本地有笔迹且服务端为空 → 自动展开并补传（resync 防抖后 PUT）", async () => {
    draftStore.saveInk(ATTEMPT_ID, "q-ink-1", localInkDoc(2));
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch
      .mockResolvedValueOnce(HANDWRITTEN_DRAFT)
      .mockResolvedValue(RESULT_DATA);
    renderPage();

    // 非空本地笔迹 → 自动展开（按钮翻转为「收起手写区」）
    await screen.findByRole("button", { name: /收起手写区/ });
    // resync 进 2 秒防抖后上传（InkPad mock 提供可导 PNG 的引擎）
    await waitFor(() => expect(mockedPutInk).toHaveBeenCalledTimes(1), {
      timeout: 4000,
    });
    expect(mockedPutInk.mock.calls[0]?.[1]).toBe("q-ink-1");
  });

  it("交卷成功后清除本地草稿", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch
      .mockResolvedValueOnce(DRAFT_DATA)
      .mockResolvedValue(RESULT_DATA);
    mockedSave.mockResolvedValue({ questionId: "练习四-1", changeCount: 1 });
    mockedSubmit.mockResolvedValue(RESULT_DATA);
    renderPage();

    await screen.findByText("第 1 题");
    fireEvent.click(screen.getByRole("radio", { name: /对/ }));
    await waitFor(() => expect(mockedSave).toHaveBeenCalled());
    // 本地草稿已存在（作答写入）
    expect(await draftStore.loadDraft(ATTEMPT_ID)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "交卷" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认交卷" }));
    await waitFor(() => expect(mockedSubmit).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/批改结果/)).toBeInTheDocument();
    await waitFor(async () => {
      expect(await draftStore.loadDraft(ATTEMPT_ID)).toBeNull();
    });
  });

  it("顶栏三态：作答后已保存；断网事件转「离线，已存本机」；恢复后自动同步回已保存", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch.mockResolvedValue(DRAFT_DATA);
    mockedSave.mockResolvedValue({ questionId: "练习四-1", changeCount: 1 });
    renderPage();

    await screen.findByText("第 1 题");
    fireEvent.click(screen.getByRole("radio", { name: /对/ }));
    // 保存中 → 已保存（带时间）
    await waitFor(() =>
      expect(screen.getByTestId("draft-status")).toHaveTextContent(/已保存/),
    );

    // 断网：作答继续写本地，顶栏转离线
    fireEvent(window, new Event("offline"));
    expect(await screen.findByText("离线，已存本机")).toBeVisible();
    // 即时 PUT 失败（mock reject）也不会阻塞本地写入
    mockedSave.mockRejectedValue(new Error("network"));
    fireEvent.click(screen.getByRole("radio", { name: /错/ }));
    await waitFor(() =>
      expect(screen.getByTestId("draft-status")).toHaveTextContent(
        "离线，已存本机",
      ),
    );
    const record = await draftStore.loadDraft(ATTEMPT_ID);
    expect(record?.answers["练习四-1"]).toEqual({
      kind: "judge",
      value: false,
    });

    // 网络恢复：online 事件 → 自动补发 → 回到已保存
    mockedSave.mockResolvedValue({ questionId: "练习四-1", changeCount: 2 });
    fireEvent(window, new Event("online"));
    await waitFor(() =>
      expect(screen.getByTestId("draft-status")).toHaveTextContent(/已保存/),
    );
    await waitFor(() =>
      expect(mockedSave).toHaveBeenCalledWith(ATTEMPT_ID, "练习四-1", {
        kind: "judge",
        value: false,
      } satisfies StudentAnswer),
    );
  });
});

// ---------- T2.10：学习痕迹埋点（事件经交卷 finalizeSubmit flush 出网） ----------

/** 汇总所有已上报事件（postAttemptEventsApi 的调用参数展平） */
async function allReportedEvents(): Promise<Array<Record<string, unknown>>> {
  await waitFor(
    () => {
      if (mockedPostEvents.mock.calls.length === 0) {
        throw new Error("事件尚未上报");
      }
    },
    { timeout: 3000 },
  );
  return mockedPostEvents.mock.calls.flatMap((call) =>
    (call[1] as unknown as Array<Record<string, unknown>>).map((e) => e),
  );
}

describe("StudentAssignmentAttemptPage：学习痕迹埋点", () => {
  it("作答两题再交卷：attempt_start/focus 切换/answer_change(from)/blur/submit 全链路", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch
      .mockResolvedValueOnce(DRAFT_DATA)
      .mockResolvedValue(RESULT_DATA);
    mockedSave.mockResolvedValue({ questionId: "练习四-1", changeCount: 1 });
    mockedSubmit.mockResolvedValue(RESULT_DATA);
    renderPage();

    await screen.findByText("第 1 题");
    // 题 1：先选「对」再改「错」（answer_change 的 from 语义）
    fireEvent.click(screen.getByRole("radio", { name: /对/ }));
    await waitFor(() => expect(mockedSave).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("radio", { name: /错/ }));
    await waitFor(() => expect(mockedSave).toHaveBeenCalledTimes(2));
    // 题 2：填空作答（聚焦切到题 2 → blur 题 1 + focus 题 2）
    const blank = screen.getByRole("textbox");
    fireEvent.change(blank, { target: { value: "4" } });
    await waitFor(() => expect(mockedSave).toHaveBeenCalledTimes(3));

    await clickSubmitAndConfirm();
    await waitFor(() => expect(mockedSubmit).toHaveBeenCalledTimes(1));
    // 事件 flush 先于 submit（finalizeSubmit 在 mutate 前 await flush）
    const eventsOrder = mockedPostEvents.mock.invocationCallOrder[0] ?? 0;
    const submitOrder = mockedSubmit.mock.invocationCallOrder[0] ?? 0;
    expect(eventsOrder).toBeLessThan(submitOrder);

    const events = await allReportedEvents();
    const types = events.map((e) => e.type);
    expect(types).toContain("attempt_start");
    expect(types).toContain("question_focus");
    expect(types).toContain("question_blur");
    expect(types).toContain("answer_change");
    expect(types).toContain("submit");
    // focus 归属：题 1 → 题 2（切换顺序）
    const focusQuestionIds = events
      .filter((e) => e.type === "question_focus")
      .map((e) => e.questionId);
    expect(focusQuestionIds).toEqual(["练习四-1", "练习四-4"]);
    const blurQuestionIds = events
      .filter((e) => e.type === "question_blur")
      .map((e) => e.questionId);
    expect(blurQuestionIds).toEqual(["练习四-1", "练习四-4"]);
    // answer_change：题 1 两条（第二条带 from=对）、题 2 一条
    const changes = events.filter((e) => e.type === "answer_change");
    const judgeChanges = changes.filter((e) => e.questionId === "练习四-1");
    expect(judgeChanges.length).toBe(2);
    expect(judgeChanges[0]?.from).toBeUndefined();
    expect(judgeChanges[1]?.from).toEqual({ kind: "judge", value: true });
    expect(judgeChanges[1]?.to).toEqual({ kind: "judge", value: false });
    // submit 是最后一条
    expect(types[types.length - 1]).toBe("submit");
  });

  it("手写题写一笔：ink_stroke_batch 事件带笔画数与题号", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch
      .mockResolvedValueOnce(HANDWRITTEN_DRAFT)
      .mockResolvedValue(RESULT_DATA);
    mockedSubmit.mockResolvedValue(RESULT_DATA);
    renderPage();

    await screen.findByText("第一道手写题");
    await writeOnNextHandwritten();

    await clickSubmitAndConfirm();
    // 交卷 flush 打断 2 秒防抖立即 PUT 笔迹
    await waitFor(() => expect(mockedPutInk).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockedSubmit).toHaveBeenCalledTimes(1));
    const events = await allReportedEvents();
    const inkEvents = events.filter((e) => e.type === "ink_stroke_batch");
    expect(inkEvents.length).toBeGreaterThanOrEqual(1);
    expect(inkEvents[0]?.questionId).toBe("q-ink-1");
    expect(inkEvents[0]?.strokes).toBe(1);
    // 写笔迹也把聚焦切到手写题
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "question_focus",
        questionId: "q-ink-1",
      }),
    );
  });

  it("页面隐藏再恢复：page_hidden / page_visible 注入队列（unmount flush 出网）", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch.mockResolvedValue(DRAFT_DATA);
    const { unmount } = renderPage();
    await screen.findByText("第 1 题");

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    unmount();
    const events = await allReportedEvents();
    const types = events.map((e) => e.type);
    expect(types).toContain("page_hidden");
    expect(types).toContain("page_visible");
    expect(types).toContain("attempt_start");
  });
});

// ---------- T2.11：分步提示（题卡解锁流 + 结果视图回看） ----------

/** 带已解锁提示的草稿视图（练习四-4 共 2 条、解锁过第 0 条；练习四-8 共 2 条未解锁） */
const DRAFT_WITH_HINTS: AttemptDraftData = {
  ...DRAFT_DATA,
  units: [
    {
      id: "练习四",
      title: "练习四",
      questions: [
        // 练习四-1（判断题，无提示）原样保留（slice 避免下标访问的 undefined 窄化）
        ...(DRAFT_DATA.units[0]?.questions ?? []).slice(0, 1),
        // 练习四-4 在 DRAFT_DATA 中 hintCount=1，这里覆盖为 2 以构造「已解锁 1 条、剩余 1 条」状态
        {
          id: "练习四-4",
          type: "fill",
          difficulty: 2,
          knowledge: ["有理数加法"],
          stemMd: "计算：$(-3)+7=$ [[]]。",
          hintCount: 2,
          questionRevisionId: "rev-练习四-4",
        },
        {
          id: "练习四-8",
          type: "find-error",
          difficulty: 2,
          knowledge: ["有理数加法"],
          stemMd: "下面是小明的解答，其中有一处错误：",
          hintCount: 2,
          questionRevisionId: "rev-练习四-8",
        },
      ],
    },
  ],
  hintsOpened: {
    "练习四-4": [
      { index: 0, text: "同号相加，取相同的符号，并把绝对值相加。" },
    ],
  },
};

describe("StudentAssignmentAttemptPage：分步提示", () => {
  it("草稿视图回显已解锁提示；点按钮解锁下一条（index=已解锁数）、剩余数递减", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch.mockResolvedValue(DRAFT_WITH_HINTS);
    renderPage();

    await screen.findByText("第 3 题");
    // 练习四-4 已解锁第 0 条 → 回显 + 剩余 1 条按钮
    expect(screen.getByText("提示 1")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "给我一点提示（剩余 1 条）" }),
    ).toBeInTheDocument();
    // 练习四-8 未解锁过 → 剩余 2 条按钮
    expect(
      screen.getByRole("button", { name: "给我一点提示（剩余 2 条）" }),
    ).toBeInTheDocument();

    // 解锁练习四-4 的第 1 条（index=已解锁数 1）
    mockedOpenHint.mockResolvedValueOnce({
      questionId: "练习四-4",
      index: 1,
      hint: "异号相加，取绝对值较大的加数的符号。",
      hintCount: 2,
      hintsUsed: 2,
      hintsRemaining: 0,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "给我一点提示（剩余 1 条）" }),
    );
    await waitFor(() => {
      expect(mockedOpenHint).toHaveBeenCalledWith(ATTEMPT_ID, "练习四-4", 1);
    });
    // 解锁完该题：按钮消失（整页 role 扫描会触发 jsdom 样式解析崩溃，用文本口径），两条提示都在列表
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("剩余 1 条");
    });
    expect(screen.getByText("提示 2")).toBeInTheDocument();
    // 另一题的按钮不受影响
    expect(document.body.textContent).toContain("给我一点提示（剩余 2 条）");
  });

  it("结果视图回看做题时看过的提示（不做新的解锁请求）", async () => {
    mockedStart.mockResolvedValue(RESULT_DATA.attempt);
    mockedFetch.mockResolvedValue({
      ...RESULT_DATA,
      units: [
        {
          id: "练习四",
          title: "练习四",
          questions: (RESULT_DATA.units[0]?.questions ?? []).map((question) =>
            question.questionId === "练习四-4"
              ? {
                  ...question,
                  hintsOpened: [
                    {
                      index: 0,
                      text: "同号相加，取相同的符号，并把绝对值相加。",
                    },
                  ],
                }
              : question,
          ),
        },
      ],
    });
    renderPage();

    expect(await screen.findByText(/批改结果/)).toBeInTheDocument();
    expect(screen.getByText("做题时看过的提示（1 条）")).toBeInTheDocument();
    expect(screen.getByText("提示 1")).toBeInTheDocument();
    // 结果视图没有解锁按钮（回看语义，不做新解锁）
    expect(screen.queryByRole("button", { name: /给我一点提示/ })).toBeNull();
    expect(mockedOpenHint).not.toHaveBeenCalled();
  });
});

describe("StudentAssignmentAttemptPage：离线交卷保护（T2.12）", () => {
  it("offline 事件后交卷按钮禁用并提示；online 恢复后可交卷", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch.mockResolvedValue(DRAFT_DATA);
    renderPage();

    // 在线：按钮可用、无离线提示
    const submitButton = await screen.findByRole("button", { name: "交卷" });
    expect(submitButton).toBeEnabled();
    expect(
      screen.queryByText(/离线中，已作答内容保存在本机/),
    ).not.toBeInTheDocument();

    // 断网（T2.9 同口径的 window offline 事件）：禁用 + 提示
    fireEvent(window, new Event("offline"));
    expect(submitButton).toBeDisabled();
    expect(
      screen.getByText("离线中，已作答内容保存在本机，恢复网络后可交卷"),
    ).toBeInTheDocument();

    // 恢复网络：提示消失、按钮恢复
    fireEvent(window, new Event("online"));
    expect(submitButton).toBeEnabled();
    expect(
      screen.queryByText(/离线中，已作答内容保存在本机/),
    ).not.toBeInTheDocument();
  });
});
