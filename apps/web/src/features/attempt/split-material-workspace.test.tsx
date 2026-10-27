import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AttemptContextData,
  AttemptDraftData,
  InkDoc,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAttemptApi, fetchAttemptContextApi } from "@/lib/api";
import StudentAttemptPage from "@/pages/student/StudentAttemptPage";
import { draftStore, installDraftBackend, memoryBackend } from "./draft-store";
import {
  _resetGroupMaterialLayoutStoreForTest,
  bindGroupMaterialLayoutAccount,
} from "./group-material-layout-store";
import {
  bindPracticePreferenceAccount,
  savePracticePreference,
} from "./practice-preference-store";
import { workflowOf } from "./practice-test-fixtures";

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

const ATTEMPT_ID = "88888888-8888-4888-8888-888888888888";

/** 布局偏好的账号隔离存储键（与 group-material-layout-store 同式） */
function layoutStorageKey(): string {
  return `ownclass:group-material-layout:${JSON.stringify([location.origin, "student", "student-test"])}`;
}

const attemptOf = (): AttemptDraftData["attempt"] => ({
  id: ATTEMPT_ID,
  sourceType: "course",
  assignmentId: null,
  lectureId: null,
  courseId: "12121212-1212-4121-8121-121212121212",
  unitId: "阅读理解小练",
  attemptNo: 1,
  status: "draft",
  startedAt: "2026-10-24T02:00:00.000Z",
  submittedAt: null,
  scoreAuto: null,
});

const draftOf = (): AttemptDraftData => ({
  attempt: attemptOf(),
  title: "阅读理解练习",
  courseName: "初二上",
  dueAt: null,
  units: [
    {
      id: "阅读理解小练",
      title: "阅读理解小练",
      questions: [
        {
          id: "q1",
          type: "judge",
          difficulty: 1,
          knowledge: ["阅读分析"],
          stemMd: "材料中提到了气候变化的影响。[[]]",
          hintCount: 0,
          questionRevisionId: "rev-q1",
        },
        {
          id: "q2",
          type: "judge",
          difficulty: 2,
          knowledge: ["阅读分析"],
          stemMd: "作者对未来发展持悲观态度。[[]]",
          hintCount: 0,
          questionRevisionId: "rev-q2",
        },
        {
          id: "q3",
          type: "judge",
          difficulty: 1,
          knowledge: ["独立分析"],
          stemMd: "这是一道独立的材料题。[[]]",
          hintCount: 0,
          questionRevisionId: "rev-q3",
          materialRefs: [{ material: "mat-solo" }],
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

const contextOf = (): AttemptContextData => ({
  attemptId: ATTEMPT_ID,
  materials: [
    {
      id: "mat-group",
      title: "阅读材料一",
      contentMd: "全球气候变暖正在加速北极冰川消融，影响生物多样性。",
      anchors: [],
      slots: [],
      mediaPaths: [],
      sourceVersion: 1,
    },
    {
      id: "mat-solo",
      title: "独立材料",
      contentMd: "这是单题关联的独立资料内容。",
      anchors: [],
      slots: [],
      mediaPaths: [],
      sourceVersion: 1,
    },
  ],
  groups: [
    {
      id: "grp-1",
      title: "阅读理解第 1～2 题",
      label: "1～2",
      introMd: "阅读下方材料回答第 1 至 2 题。",
      materialRefs: [{ material: "mat-group" }],
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

describe("分栏材料工作区与协同标画集成", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetGroupMaterialLayoutStoreForTest();
    installDraftBackend(memoryBackend());
    bindPracticePreferenceAccount(null);
    bindPracticePreferenceAccount("student-test");
    bindGroupMaterialLayoutAccount("student-test");
    Element.prototype.scrollIntoView = () => {};
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      save: vi.fn(),
      restore: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      setTransform: vi.fn(),
    });
    savePracticePreference({
      layout: "single",
      keyboardShortcuts: false,
      feedback: null,
    });
  });

  it("单题模式下题组材料激活分栏布局：渲染中缝拖拽 Handle 并支持 35%~65% 调整", async () => {
    mockedFetch.mockResolvedValue(draftOf());
    mockedContext.mockResolvedValue(contextOf());

    renderPage();
    await waitFor(() => {
      expect(screen.getByText("阅读理解第 1～2 题")).toBeInTheDocument();
    });

    // 题组材料区存在且可见
    const groupMaterials = screen.getByLabelText("本组共享材料");
    expect(groupMaterials).toBeInTheDocument();
    expect(screen.getByText(/全球气候变暖正在加速/)).toBeInTheDocument();

    // 中缝 Handle 存在并具有 separator 角色
    const handle = screen.getByRole("separator", {
      name: "调整材料与题目分栏比例",
    });
    expect(handle).toBeInTheDocument();
    expect(handle.getAttribute("aria-valuenow")).toBe("50");
    expect(handle.getAttribute("aria-valuemin")).toBe("35");
    expect(handle.getAttribute("aria-valuemax")).toBe("65");

    // 键盘调整比例
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle.getAttribute("aria-valuenow")).toBe("49");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("50");

    // Home 键跳到最小值 35%
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle.getAttribute("aria-valuenow")).toBe("35");

    // End 键跳到最大值 65%
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle.getAttribute("aria-valuenow")).toBe("65");
  });

  it("单题模式下题级 ::ref 材料也激活分栏布局与拖拽 Handle", async () => {
    mockedFetch.mockResolvedValue(draftOf());
    mockedContext.mockResolvedValue(contextOf());

    renderPage();
    await waitFor(() => {
      expect(screen.getByText("阅读理解练习")).toBeInTheDocument();
    });

    // 切换到第 3 题（solo 材料题）
    const q3Button = screen.getByRole("button", { name: /第 3 题/ });
    fireEvent.click(q3Button);

    await waitFor(() => {
      expect(screen.getByLabelText("本题材料")).toBeInTheDocument();
    });
    expect(
      screen.getByText("这是单题关联的独立资料内容。"),
    ).toBeInTheDocument();

    // 中缝 Handle 同样激活
    const handle = screen.getByRole("separator", {
      name: "调整材料与题目分栏比例",
    });
    expect(handle).toBeInTheDocument();
    expect(handle.getAttribute("aria-valuenow")).toBe("50");
  });

  it("材料圈画笔迹合并存储到 AttemptDraftRecord，并在切题后持久保持", async () => {
    mockedFetch.mockResolvedValue(draftOf());
    mockedContext.mockResolvedValue(contextOf());

    renderPage();
    await waitFor(() => {
      expect(screen.getByText("阅读理解第 1～2 题")).toBeInTheDocument();
    });

    // 初始草稿中无材料笔迹
    const initialDraft = await draftStore.loadDraft(ATTEMPT_ID);
    expect(initialDraft?.materialInks?.["mat-group"]).toBeUndefined();

    // 模拟在材料区域保存笔迹（合并存储机制）
    const sampleDoc: InkDoc = {
      engine: "atrament",
      version: 1,
      updatedAt: 1700000000000,
      data: {
        width: 1000,
        strokes: [
          {
            tool: "pen",
            color: "#f59e0b",
            weight: 4,
            points: [
              { x: 10, y: 10, p: 0.5, t: 0 },
              { x: 20, y: 20, p: 0.5, t: 10 },
            ],
          },
        ],
      },
    };

    await draftStore.saveMaterialInk(ATTEMPT_ID, "mat-group", sampleDoc);

    // 验证合并存储：draftStore peek 与 loadDraft 均包含 materialInks
    const updatedDraft = await draftStore.loadDraft(ATTEMPT_ID);
    expect(updatedDraft?.materialInks?.["mat-group"]).toEqual(sampleDoc);

    const peeked = draftStore.peekMaterialInks(ATTEMPT_ID);
    expect(peeked?.["mat-group"]).toEqual(sampleDoc);

    // 切到第 2 题再切回，笔迹仍然保留在合并草稿仓中
    const q2Buttons = screen.getAllByRole("button", { name: /第 2 题/ });
    if (q2Buttons[0]) fireEvent.click(q2Buttons[0]);

    const q1Buttons = screen.getAllByRole("button", { name: /第 1 题/ });
    if (q1Buttons[0]) fireEvent.click(q1Buttons[0]);

    const reloadedInk = await draftStore.getMaterialInk(
      ATTEMPT_ID,
      "mat-group",
    );
    expect(reloadedInk).toEqual(sampleDoc);
  });

  it("整卷列表模式下题组支持在'左右分栏'与'列表形式'之间切换并持久化", async () => {
    savePracticePreference({
      layout: "list",
      keyboardShortcuts: false,
      feedback: null,
    });
    mockedFetch.mockResolvedValue(draftOf());
    mockedContext.mockResolvedValue(contextOf());

    const { container } = renderPage();
    await waitFor(() => {
      expect(screen.getByText("阅读理解第 1～2 题")).toBeInTheDocument();
    });

    // 默认分栏模式：ol data-layout 为 compare，题组与 q3 独立材料均有中缝拖拽 Handle（共 2 个）；
    // 排版切换入口同时挂在题组锚与题级材料锚上（各一组单选）
    const splitButtons = screen.getAllByRole("radio", { name: /左右分栏/ });
    const stackButtons = screen.getAllByRole("radio", { name: /列表形式/ });
    expect(splitButtons).toHaveLength(2);
    expect(stackButtons).toHaveLength(2);
    const splitButton = splitButtons[0] as HTMLElement;
    const stackButton = stackButtons[0] as HTMLElement;
    expect(splitButton).toBeInTheDocument();
    expect(stackButton).toBeInTheDocument();
    expect(splitButton).toHaveAttribute("aria-checked", "true");
    expect(stackButton).toHaveAttribute("aria-checked", "false");

    expect(
      screen.getAllByRole("separator", {
        name: "调整材料与题目分栏比例",
      }),
    ).toHaveLength(2);

    const ol = container.querySelector("ol[data-layout]");
    expect(ol).toHaveAttribute("data-layout", "compare");

    // 点击切换为“列表形式”
    fireEvent.click(stackButton);

    expect(splitButton).toHaveAttribute("aria-checked", "false");
    expect(stackButton).toHaveAttribute("aria-checked", "true");
    expect(ol).toHaveAttribute("data-layout", "stack");
    expect(localStorage.getItem(layoutStorageKey())).toBe("stack");

    // 列表形式下，中缝拖拽 Handle 不渲染（全卷切换为上下流式排布）
    expect(
      screen.queryAllByRole("separator", {
        name: "调整材料与题目分栏比例",
      }),
    ).toHaveLength(0);

    // 点击切换回“左右分栏”
    fireEvent.click(splitButton);

    expect(splitButton).toHaveAttribute("aria-checked", "true");
    expect(stackButton).toHaveAttribute("aria-checked", "false");
    expect(ol).toHaveAttribute("data-layout", "compare");
    expect(localStorage.getItem(layoutStorageKey())).toBe("split");
    expect(
      screen.getAllByRole("separator", {
        name: "调整材料与题目分栏比例",
      }),
    ).toHaveLength(2);
  });

  it("单题模式下题组材料在 stack 模式下同样转为上下流式排布", async () => {
    savePracticePreference({
      layout: "single",
      keyboardShortcuts: false,
      feedback: null,
    });
    mockedFetch.mockResolvedValue(draftOf());
    mockedContext.mockResolvedValue(contextOf());

    const { container } = renderPage();
    await waitFor(() => {
      expect(screen.getByText("阅读理解第 1～2 题")).toBeInTheDocument();
    });

    const stackButton = screen.getByRole("radio", { name: /列表形式/ });
    fireEvent.click(stackButton);

    const ol = container.querySelector("ol[data-layout]");
    expect(ol).toHaveAttribute("data-layout", "stack");
    expect(
      screen.queryAllByRole("separator", {
        name: "调整材料与题目分栏比例",
      }),
    ).toHaveLength(0);
  });

  it("整卷列表模式下题组材料与独立题材料不泄漏 sticky 定位，且各材料与无材料题保持绝对几何隔离", async () => {
    savePracticePreference({
      layout: "list",
      keyboardShortcuts: false,
      feedback: null,
    });
    const draft = draftOf();
    draft.units[0]?.questions.push({
      id: "q4",
      type: "judge",
      difficulty: 1,
      knowledge: ["自测"],
      stemMd: "无材料普通题题面[[]]",
      hintCount: 0,
      questionRevisionId: "rev-q4",
    });
    mockedFetch.mockResolvedValue(draft);
    mockedContext.mockResolvedValue(contextOf());

    const { container } = renderPage();
    await waitFor(() => {
      expect(screen.getByText("阅读理解第 1～2 题")).toBeInTheDocument();
    });

    // 1. 题组共享材料：在列表分栏模式下拥有网格跨行与 isolate，但绝不泄漏 sticky 定位导致穿透
    const groupMaterials = container.querySelector(
      '[data-slot="group-materials"]',
    );
    expect(groupMaterials).toBeInTheDocument();
    expect(groupMaterials?.className).toContain("isolate");
    expect(groupMaterials?.className).toContain("lg:col-start-1");
    expect(groupMaterials?.className).toContain(
      "lg:[grid-row:span_var(--qg-row-span)]",
    );
    expect(groupMaterials?.className).not.toContain("lg:sticky");
    expect(groupMaterials?.className).not.toContain("xl:sticky");

    // 2. 独立题材料：拥有独立单行约束 [grid-row:span_1] 与 isolate，同样不泄漏 sticky
    const soloMaterials = container.querySelector(
      '[data-slot="question-materials"]',
    );
    expect(soloMaterials).toBeInTheDocument();
    expect(soloMaterials?.className).toContain("isolate");
    expect(soloMaterials?.className).toContain("lg:col-start-1");
    expect(soloMaterials?.className).toContain("lg:[grid-row:span_1]");
    expect(soloMaterials?.className).not.toContain("lg:sticky");
    expect(soloMaterials?.className).not.toContain("xl:sticky");

    // 3. 中缝 Handle 容器：在列表模式下同样不使用 sticky
    const handleContainers = container.querySelectorAll(
      '[data-slot="group-split-handle-container"], [data-slot="question-split-handle-container"]',
    );
    expect(handleContainers).toHaveLength(2);
    for (const handle of handleContainers) {
      expect(handle.className).not.toContain("lg:sticky");
      expect(handle.className).not.toContain("xl:sticky");
    }

    // 4. 无材料普通题：整行跨列 (lg:col-span-full)，各卡片均有 isolate 隔离层叠上下文
    const q4Card = container.querySelector('article[data-question-id="q4"]');
    expect(q4Card).toBeInTheDocument();
    expect(q4Card?.className).toContain("isolate");
    const q4Row = q4Card?.closest("li");
    expect(q4Row?.className).toContain("lg:col-span-full");
  });

  it("单题模式下题组材料与中缝 Handle 保持视口级粘性与独立滚动区", async () => {
    savePracticePreference({
      layout: "single",
      keyboardShortcuts: false,
      feedback: null,
    });
    mockedFetch.mockResolvedValue(draftOf());
    mockedContext.mockResolvedValue(contextOf());

    const { container } = renderPage();
    await waitFor(() => {
      expect(screen.getByText("阅读理解第 1～2 题")).toBeInTheDocument();
    });

    const groupMaterials = container.querySelector(
      '[data-slot="group-materials"]',
    );
    expect(groupMaterials).toBeInTheDocument();
    expect(groupMaterials?.className).toContain("lg:sticky");
    expect(groupMaterials?.className).toContain("xl:sticky");
    expect(groupMaterials?.className).toContain("lg:overflow-y-auto");

    const groupHandle = container.querySelector(
      '[data-slot="group-split-handle-container"]',
    );
    expect(groupHandle).toBeInTheDocument();
    expect(groupHandle?.className).toContain("lg:sticky");
  });

  it("无题组但包含独立材料题的单元，列表模式下依然正常激活分栏网格与中缝 Handle", async () => {
    savePracticePreference({
      layout: "list",
      keyboardShortcuts: false,
      feedback: null,
    });
    const draft = draftOf();
    // 移除题组内的题目，仅保留独立材料题 q3 与无材料题 q4
    const unit0 = draft.units[0];
    if (unit0) {
      unit0.questions = [
        {
          id: "q3",
          type: "judge",
          difficulty: 1,
          knowledge: ["独立分析"],
          stemMd: "这是一道独立的材料题。[[]]",
          hintCount: 0,
          questionRevisionId: "rev-q3",
          materialRefs: [{ material: "mat-solo" }],
        },
        {
          id: "q4",
          type: "judge",
          difficulty: 1,
          knowledge: ["自测"],
          stemMd: "无材料普通题题面[[]]",
          hintCount: 0,
          questionRevisionId: "rev-q4",
        },
      ];
    }
    mockedFetch.mockResolvedValue(draft);
    // contextOf 中组不匹配任何本卷题目，因此仅存在 solo 段
    mockedContext.mockResolvedValue(contextOf());

    const { container } = renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("本题材料")).toBeInTheDocument();
    });

    // 单元存在独立材料题时，列表分栏模式下依然正常开启 grid
    const ol = container.querySelector("ol.lg\\:grid");
    expect(ol).toBeInTheDocument();
    // 回归：百分比轨道 + 中缝轨道总宽恰为 100%，列隙必须归零（gap-x-0），
    // 否则 gap-4 的两个 16px 列隙使网格溢出容器 32px
    expect(ol?.className).toContain("lg:gap-x-0");

    // 纯 solo 材料单元同样提供排版切换入口（不依赖题组锚）
    expect(
      screen.getByRole("radiogroup", { name: "题组材料排版方式" }),
    ).toBeInTheDocument();

    // 独立题材料与中缝 Handle 正常渲染
    const soloMaterials = container.querySelector(
      '[data-slot="question-materials"]',
    );
    expect(soloMaterials).toBeInTheDocument();
    expect(soloMaterials?.className).toContain("lg:col-start-1");
    expect(soloMaterials?.className).toContain("lg:[grid-row:span_1]");
    expect(soloMaterials?.className).not.toContain("lg:sticky");

    const soloHandle = container.querySelector(
      '[data-slot="question-split-handle-container"]',
    );
    expect(soloHandle).toBeInTheDocument();
    expect(soloHandle?.className).toContain("lg:col-start-2");
    expect(soloHandle?.className).toContain("lg:[grid-row:span_1]");
    expect(soloHandle?.className).not.toContain("lg:sticky");

    // 无材料普通题整行跨列 (lg:col-span-full)
    const q4Card = container.querySelector('article[data-question-id="q4"]');
    expect(q4Card).toBeInTheDocument();
    expect(q4Card?.closest("li")?.className).toContain("lg:col-span-full");
  });

  it("连续多题组与独立材料并存时，各材料按各自网格行严格隔离且绝不泄漏 sticky", async () => {
    savePracticePreference({
      layout: "list",
      keyboardShortcuts: false,
      feedback: null,
    });
    const draft = draftOf();
    // 增加第 2 个题组题目 q5, q6
    draft.units[0]?.questions.push(
      {
        id: "q5",
        type: "judge",
        difficulty: 1,
        knowledge: ["组2"],
        stemMd: "题组2子题1[[]]",
        hintCount: 0,
        questionRevisionId: "rev-q5",
      },
      {
        id: "q6",
        type: "judge",
        difficulty: 1,
        knowledge: ["组2"],
        stemMd: "题组2子题2[[]]",
        hintCount: 0,
        questionRevisionId: "rev-q6",
      },
    );
    const ctx = contextOf();
    ctx.materials.push({
      id: "mat-group-2",
      title: "阅读材料二",
      contentMd: "第二份长材料正文。",
      anchors: [],
      slots: [],
      mediaPaths: [],
      sourceVersion: 1,
    });
    ctx.groups.push({
      id: "grp-2",
      title: "题组 2：材料二第 5～6 题",
      label: "5～6",
      introMd: "阅读材料二回答问题。",
      materialRefs: [{ material: "mat-group-2" }],
      questionIds: ["q5", "q6"],
      sourceVersion: 1,
    });

    mockedFetch.mockResolvedValue(draft);
    mockedContext.mockResolvedValue(ctx);

    const { container } = renderPage();
    await waitFor(() => {
      expect(screen.getByText("阅读理解第 1～2 题")).toBeInTheDocument();
      expect(screen.getByText("题组 2：材料二第 5～6 题")).toBeInTheDocument();
    });

    // 两个题组材料均有网格跨行，且绝不泄漏 sticky
    const groupMaterials = container.querySelectorAll(
      '[data-slot="group-materials"]',
    );
    expect(groupMaterials).toHaveLength(2);
    for (const mat of groupMaterials) {
      expect(mat.className).toContain("isolate");
      expect(mat.className).toContain("lg:col-start-1");
      expect(mat.className).toContain("lg:[grid-row:span_var(--qg-row-span)]");
      expect(mat.className).not.toContain("lg:sticky");
    }

    // 独立题材料保持单行绑定
    const soloMaterials = container.querySelector(
      '[data-slot="question-materials"]',
    );
    expect(soloMaterials?.className).toContain("lg:[grid-row:span_1]");
    expect(soloMaterials?.className).not.toContain("lg:sticky");

    // 所有中缝 Handle 绝不泄漏 sticky
    const handles = container.querySelectorAll(
      '[data-slot="group-split-handle-container"], [data-slot="question-split-handle-container"]',
    );
    expect(handles).toHaveLength(3);
    for (const h of handles) {
      expect(h.className).not.toContain("lg:sticky");
    }
  });
});
