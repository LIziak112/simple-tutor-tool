import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { NotebookRound, StudentNotebookData } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchStudentNotebookApi } from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentQuestionNotebookPage from "./StudentQuestionNotebookPage";

/**
 * /s/notebook/:questionId 题目笔记本页（T6R.15 E）组件测试：三态齐全
 * （加载/空/错误）、轮次导航（上一轮/下一轮 + 轮次列表）、每轮徽标/来源/
 * 提交时间/题目版本徽标、原稿区接线（NoteOriginalView 桩）、订正列表
 * （反思分栏 + NoteVersionView 桩 + 未封存「编辑中」）、补充稿列表
 * （徽标 + 说明文案）、轮次头部链接回结果页。
 * 原稿/版本查看面板以桩替换（行为各自见 NoteOriginalView.test /
 * NoteVersionView.test）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentNotebookApi: vi.fn(),
  };
});

vi.mock("@/features/notes/NoteOriginalView", async () => {
  const { NoteOriginalTestStub } = await import(
    "@/features/notes/note-original-test-stub"
  );
  return { NoteOriginalView: NoteOriginalTestStub };
});

vi.mock("@/features/notes/NoteVersionView", () => ({
  NoteVersionView: (props: Record<string, unknown>) => (
    <div
      data-testid="note-version-stub"
      data-version={String(props.versionId ?? "")}
      data-title={String(props.title ?? "")}
      data-openlabel={String(props.openLabel ?? "")}
    />
  ),
}));

const notebookMock = vi.mocked(fetchStudentNotebookApi);

const QUESTION_ID = "p1-q8";

function round(
  overrides: Partial<NotebookRound> & Pick<NotebookRound, "roundOrdinal">,
): NotebookRound {
  return {
    attemptId: `att-round-${overrides.roundOrdinal}`,
    sourceType: "assignment",
    sourceLabel: `第 ${overrides.roundOrdinal} 轮来源`,
    submittedAt: "2026-10-06T02:30:00.000Z",
    questionVersion: null,
    question: null,
    release: null,
    evidence: null,
    corrections: [],
    supplements: [],
    context: null,
    ...overrides,
  };
}

/** 已冻结题面（attemptQuestionPublic 形态；stemMd 为脱敏后题干） */
const QUESTION_VIEW: NonNullable<NotebookRound["question"]> = {
  id: QUESTION_ID,
  type: "choice",
  difficulty: 3,
  knowledge: ["一元一次方程"],
  stemMd: "下列哪个选项正确？",
  options: ["选项甲", "选项乙", "选项丙"],
  hintCount: 2,
  questionRevisionId: "qrev-view-1",
};

/** 已公布解析（notebookRoundRelease 形态） */
const RELEASE_VIEW: NonNullable<NotebookRound["release"]> = {
  answers: { kind: "choice", index: 2 },
  solutionMd: "先移项，再合并同类项。",
};

function notebookOf(rounds: NotebookRound[]): StudentNotebookData {
  return { questionId: QUESTION_ID, rounds };
}

function renderPage(returnTo?: string) {
  return renderWithStudentRoutes({
    initialPath: `/s/notebook/${QUESTION_ID}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`,
    routePath: "/s/notebook/:questionId",
    element: <StudentQuestionNotebookPage />,
  });
}

beforeEach(() => {
  notebookMock.mockReset();
});

describe("StudentQuestionNotebookPage：三态", () => {
  it("从作业入口查看已交卷结果，也能返回原作业结果", async () => {
    notebookMock.mockResolvedValue(notebookOf([]));
    const source =
      "/s/assignments/assignment-1?reviewScope=all&reviewQuestion=p1-q8";
    renderPage(source);
    expect(
      await screen.findByRole("link", { name: "返回作答结果" }),
    ).toHaveAttribute("href", source);
  });
  it.each(["loading", "error", "empty"])(
    "%s 状态也能返回原结果与题目",
    async (state) => {
      if (state === "loading")
        notebookMock.mockReturnValue(new Promise(() => {}));
      else if (state === "error")
        notebookMock.mockRejectedValue(
          new ApiError("UNAUTHORIZED", "登录已过期", 401),
        );
      else notebookMock.mockResolvedValue(notebookOf([]));
      const target =
        "/s/attempts/att-1?returnTo=%2Fs%2Frecords&reviewScope=wrong&reviewQuestion=p1-q8";
      renderPage(target);
      expect(
        await screen.findByRole("link", { name: "返回作答结果" }),
      ).toHaveAttribute("href", target);
    },
  );

  it.each([
    undefined,
    "https://evil.example/",
    "//evil.example/",
    "/t/attempts/att-1",
    "/s/attempts/../home",
  ])("不可信来源 %s 回退我的记录", async (target) => {
    notebookMock.mockResolvedValue(notebookOf([]));
    renderPage(target);
    expect(
      await screen.findByRole("link", { name: "返回我的记录" }),
    ).toHaveAttribute("href", "/s/records");
  });
  it("加载中显示骨架（不白屏）", async () => {
    notebookMock.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(
      await screen.findByLabelText("正在加载题目笔记本"),
    ).toBeInTheDocument();
  });

  it("错误态：中文错误 + 重试", async () => {
    // ApiError（终态类）不重试——普通网络错误按生产语义退避，等不及断言
    notebookMock.mockRejectedValue(
      new ApiError("UNAUTHORIZED", "登录已过期，请重新登录", 401),
    );
    renderPage();
    expect(await screen.findByText("笔记本加载失败")).toBeInTheDocument();
    expect(screen.getByText(/登录已过期/)).toBeInTheDocument();
    notebookMock.mockResolvedValue(notebookOf([round({ roundOrdinal: 1 })]));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => {
      expect(screen.getAllByText("第 1 次").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("空态：无已交卷轮次的解释与下一步动作", async () => {
    notebookMock.mockResolvedValue(notebookOf([]));
    renderPage();
    expect(await screen.findByText("这道题还没有历史记录")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回首页" })).toHaveAttribute(
      "href",
      "/s/home",
    );
  });
});

describe("StudentQuestionNotebookPage：轮次导航与每轮内容", () => {
  const TWO_ROUNDS: NotebookRound[] = [
    round({ roundOrdinal: 1, sourceLabel: "周末加练", questionVersion: 2 }),
    round({
      roundOrdinal: 2,
      sourceType: "wrong",
      sourceLabel: "错题重练 · 第 3 次",
      questionVersion: null,
      submittedAt: "2026-10-07T05:00:00.000Z",
      corrections: [
        {
          noteId: "88888888-8888-4888-8888-888888888801",
          attemptId: "att-round-2",
          questionId: QUESTION_ID,
          questionRevisionId: "qrev-1",
          phase: "correction",
          revision: 2,
          currentVersionId: "33333333-3333-4333-8333-333333333321",
          serverSavedAt: "2026-10-07T05:30:00.000Z",
          sealedAt: "2026-10-07T06:00:00.000Z",
          stuckAt: "第二问不会代入",
          errorCause: null,
        },
        {
          noteId: "88888888-8888-4888-8888-888888888802",
          attemptId: "att-round-2",
          questionId: QUESTION_ID,
          questionRevisionId: "qrev-1",
          phase: "correction",
          revision: 1,
          currentVersionId: "33333333-3333-4333-8333-333333333322",
          serverSavedAt: "2026-10-07T07:00:00.000Z",
          sealedAt: null,
          stuckAt: null,
          errorCause: null,
        },
      ],
      supplements: [
        {
          noteId: "99999999-9999-4999-8999-999999999901",
          attemptId: "att-round-2",
          questionId: QUESTION_ID,
          questionRevisionId: "qrev-1",
          phase: "supplement",
          revision: 1,
          currentVersionId: "33333333-3333-4333-8333-333333333331",
          serverSavedAt: "2026-10-07T08:00:00.000Z",
        },
      ],
    }),
  ];

  it("默认显示最新一轮：徽标/来源/提交时间/题目版本徽标（null 不显示）/原稿区接线/查看这一轮链接", async () => {
    notebookMock.mockResolvedValue(notebookOf(TWO_ROUNDS));
    renderPage();
    // 默认第 2 轮（最新）
    expect(
      (await screen.findAllByText("第 2 次")).length,
    ).toBeGreaterThanOrEqual(2); // 轮次徽标 + 导航按钮
    expect(screen.getByText("错题重练 · 第 3 次")).toBeInTheDocument();
    expect(screen.getByText(/交卷时间：2026年10月7日/)).toBeInTheDocument();
    // 题目版本徽标：null 不显示（第 2 轮 questionVersion=null）
    expect(screen.queryByText("题目 v3")).toBeNull();
    // 原稿区：NoteOriginalView 桩带该轮 attemptId 与轮次标注
    const original = document.querySelector(
      '[data-testid="note-original-stub"]',
    ) as HTMLElement | null;
    expect(original?.dataset.attempt).toBe("att-round-2");
    expect(original?.dataset.round).toBe("第 2 次");
    expect(screen.getByRole("link", { name: "查看这一轮" })).toHaveAttribute(
      "href",
      "/s/attempts/att-round-2",
    );
  });

  it("上一轮导航到第 1 轮：题目版本徽标 v2 显示、原稿区切换 attemptId", async () => {
    notebookMock.mockResolvedValue(notebookOf(TWO_ROUNDS));
    renderPage();
    await screen.findAllByText("第 2 次");
    fireEvent.click(screen.getByRole("button", { name: "上一轮" }));
    await waitFor(() => {
      expect(screen.getByText("题目 v2")).toBeInTheDocument();
    });
    expect(screen.getByText("周末加练")).toBeInTheDocument();
    const original = document.querySelector(
      '[data-testid="note-original-stub"]',
    ) as HTMLElement | null;
    expect(original?.dataset.attempt).toBe("att-round-1");
  });

  it("轮次边界：第一轮「上一轮」禁用、最后一轮「下一轮」禁用；轮次列表可跳转", async () => {
    notebookMock.mockResolvedValue(notebookOf(TWO_ROUNDS));
    renderPage();
    await screen.findAllByText("第 2 次");
    expect(screen.getByRole("button", { name: "下一轮" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "上一轮" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "上一轮" })).toBeDisabled();
    });
    // 轮次列表：点「第 2 次」徽标直接跳回
    fireEvent.click(screen.getByRole("button", { name: "第 2 次" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "上一轮" })).toBeEnabled();
    });
  });

  it("订正列表：已封存行反思分栏 + 查看入口；未封存行「编辑中」", async () => {
    notebookMock.mockResolvedValue(notebookOf(TWO_ROUNDS));
    renderPage();
    await screen.findAllByText("第 2 次");
    expect(screen.getByText("第二问不会代入")).toBeInTheDocument();
    expect(screen.getAllByText("我卡在哪里：")).toHaveLength(1);
    expect(screen.getByText("编辑中")).toBeInTheDocument();
    // 已封存订正 + 未封存订正（revision≥1 可查看）；补充稿另列（见下用例）
    const stubs = [
      ...document.querySelectorAll(
        '[data-testid="note-version-stub"][data-openlabel="查看订正"]',
      ),
    ];
    expect(stubs).toHaveLength(2);
    expect(stubs[0]?.getAttribute("data-version")).toBe(
      "33333333-3333-4333-8333-333333333321",
    );
  });

  it("补充稿列表：说明文案 + 徽标 + 查看入口（标题「补充稿」）", async () => {
    notebookMock.mockResolvedValue(notebookOf(TWO_ROUNDS));
    renderPage();
    await screen.findAllByText("第 2 次");
    expect(
      screen.getByText(/交卷后找回的材料，不能证明交卷前已固定/),
    ).toBeInTheDocument();
    expect(screen.getAllByText("补充稿").length).toBeGreaterThanOrEqual(1);
    const stub = document.querySelector(
      '[data-testid="note-version-stub"][data-title="补充稿"]',
    );
    expect(stub?.getAttribute("data-version")).toBe(
      "33333333-3333-4333-8333-333333333331",
    );
  });

  it("空分区：无订正/无补充稿的轮次显示解释文案（不误导为加载失败）", async () => {
    notebookMock.mockResolvedValue(
      notebookOf([round({ roundOrdinal: 1, sourceLabel: "周末加练" })]),
    );
    renderPage();
    await screen.findAllByText("第 1 次");
    expect(screen.getByText("这一轮没有订正。")).toBeInTheDocument();
    expect(screen.getByText("这一轮没有补充稿。")).toBeInTheDocument();
  });

  it("防御性空时间（闸门修复 F11）：serverSavedAt null 的合法契约行不渲染垃圾串", async () => {
    // revision=0 + serverSavedAt null 是契约合法形态（superRefine 锁定的
    // 空白行）；服务端正常流程不会送出，纯防御——此前 formatCnTime("") 会
    // 渲染「保存于 Invalid Date」
    notebookMock.mockResolvedValue(
      notebookOf([
        round({
          roundOrdinal: 1,
          supplements: [
            {
              noteId: "99999999-9999-4999-8999-999999999902",
              attemptId: "att-round-1",
              questionId: QUESTION_ID,
              questionRevisionId: "qrev-1",
              phase: "supplement",
              revision: 0,
              currentVersionId: null,
              serverSavedAt: null,
            },
          ],
        }),
      ]),
    );
    renderPage();
    await screen.findAllByText("第 1 次");
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });
});

describe("StudentQuestionNotebookPage：题面与解析区", () => {
  it("题面渲染：脱敏题干 + A/B/C 选项列表；未公布时解析区显示占位", async () => {
    notebookMock.mockResolvedValue(
      notebookOf([
        round({ roundOrdinal: 1, question: QUESTION_VIEW, release: null }),
      ]),
    );
    renderPage();
    expect(await screen.findByText("下列哪个选项正确？")).toBeInTheDocument();
    expect(screen.getByText("选项甲")).toBeInTheDocument();
    expect(screen.getByText("选项丙")).toBeInTheDocument();
    expect(screen.getByText("A.")).toBeInTheDocument();
    expect(screen.getByText("C.")).toBeInTheDocument();
    // 未公布占位：不渲染任何答案内容
    expect(screen.getByText(/答案还未公布/)).toBeInTheDocument();
    expect(screen.queryByText("正确答案：")).toBeNull();
    expect(screen.queryByText(/先移项/)).toBeNull();
  });

  it("解析公布：正确答案行 + 查看详解折叠展开；占位消失", async () => {
    notebookMock.mockResolvedValue(
      notebookOf([
        round({
          roundOrdinal: 1,
          question: QUESTION_VIEW,
          release: RELEASE_VIEW,
        }),
      ]),
    );
    renderPage();
    expect(await screen.findByText("正确答案：")).toBeInTheDocument();
    // choice index 2 → 字母 C（formatReferenceAnswers 契约口径）
    expect(screen.getByText("C")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看详解" }));
    expect(await screen.findByText(/先移项/)).toBeInTheDocument();
    expect(screen.queryByText(/答案还未公布/)).toBeNull();
  });

  it("快照缺失：占位引导到结果页，不渲染题面与解析区", async () => {
    notebookMock.mockResolvedValue(notebookOf([round({ roundOrdinal: 1 })]));
    renderPage();
    expect(await screen.findByText(/历史题目快照缺失/)).toBeInTheDocument();
    expect(screen.queryByText("正确答案：")).toBeNull();
    expect(screen.queryByText("下列哪个选项正确？")).toBeNull();
    // 快照缺失轮的解析永远无从下发：解析区整区不渲染（不是「还未公布」，
    // 那会误导学生以为等截止就能看到）
    expect(screen.queryByText(/答案还未公布/)).toBeNull();
    expect(screen.queryByText("参考答案与解析")).toBeNull();
  });

  it("主观题解析：无标准答案文案 + 详解照常可折叠", async () => {
    notebookMock.mockResolvedValue(
      notebookOf([
        round({
          roundOrdinal: 1,
          question: QUESTION_VIEW,
          release: { answers: null, solutionMd: "先移项，再合并同类项。" },
        }),
      ]),
    );
    renderPage();
    expect(await screen.findByText(/本题无标准参考答案/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看详解" }));
    expect(await screen.findByText(/先移项/)).toBeInTheDocument();
  });

  it("有答案但题库无详解：SolutionFold 空态文案", async () => {
    notebookMock.mockResolvedValue(
      notebookOf([
        round({
          roundOrdinal: 1,
          question: QUESTION_VIEW,
          release: { answers: { kind: "choice", index: 2 }, solutionMd: null },
        }),
      ]),
    );
    renderPage();
    expect(await screen.findByText("正确答案：")).toBeInTheDocument();
    // solutionMd=null 时 SolutionFold 直接渲染空态（无折叠按钮）
    expect(await screen.findByText("这道题没有详解。")).toBeInTheDocument();
  });

  it("来源材料/题组（QM-15）：context 渲染组头说明与材料正文；null 轮整区不渲染", async () => {
    notebookMock.mockResolvedValue(
      notebookOf([
        round({
          roundOrdinal: 1,
          question: QUESTION_VIEW,
          context: {
            materials: [
              {
                id: "mat-1",
                title: "给定资料",
                contentMd: "冻结版材料正文。",
                anchors: [],
                slots: [],
                mediaPaths: [],
                sourceVersion: 2,
              },
            ],
            groups: [
              {
                id: "grp-1",
                title: "资料分析组",
                introMd: "根据以下资料回答。",
                materialRefs: [{ material: "mat-1" }],
                questionIds: [QUESTION_ID],
                sourceVersion: 1,
              },
            ],
          },
        }),
        round({ roundOrdinal: 2 }),
      ]),
    );
    renderPage();
    // 默认最新一轮（第 2 轮）context=null：整区不渲染（轮徽标 + 导航按钮
    // 各出现一次「第 2 次」，取第一个即可）
    expect(await screen.findAllByText("第 2 次")).not.toHaveLength(0);
    expect(screen.queryByText("来源材料与题组")).toBeNull();
    // 切回第 1 轮：组头说明 + 冻结材料正文 + 冻结口径说明
    fireEvent.click(screen.getByRole("button", { name: "第 1 次" }));
    expect(
      await screen.findByText("来源材料与题组", { selector: "p" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("资料分析组")).toBeInTheDocument();
    expect(await screen.findByText("根据以下资料回答。")).toBeInTheDocument();
    expect(await screen.findByText("冻结版材料正文。")).toBeInTheDocument();
    expect(screen.getByText(/开卷时冻结/)).toBeInTheDocument();
  });

  it("同材料多版本并存（QM-15 细项 4）：两版正文都渲染并逐版标注历史版本", async () => {
    notebookMock.mockResolvedValue(
      notebookOf([
        round({
          roundOrdinal: 1,
          context: {
            materials: [
              {
                id: "mat-1",
                contentMd: "v1 正文。",
                anchors: [],
                slots: [],
                mediaPaths: [],
                sourceVersion: 1,
              },
              {
                id: "mat-1",
                contentMd: "v2 正文。",
                anchors: [],
                slots: [],
                mediaPaths: [],
                sourceVersion: 2,
              },
            ],
            groups: [],
          },
        }),
      ]),
    );
    renderPage();
    expect(await screen.findByText("v1 正文。")).toBeInTheDocument();
    expect(await screen.findByText("v2 正文。")).toBeInTheDocument();
    expect(screen.getByText("历史版本 1")).toBeInTheDocument();
    expect(screen.getByText("历史版本 2")).toBeInTheDocument();
  });

  it("context=null 轮：来源材料/题组整区不渲染（与空态区分，不误导）", async () => {
    notebookMock.mockResolvedValue(notebookOf([round({ roundOrdinal: 1 })]));
    renderPage();
    expect(await screen.findByText(/交卷时间/)).toBeInTheDocument();
    expect(screen.queryByText("来源材料与题组")).toBeNull();
  });
});
