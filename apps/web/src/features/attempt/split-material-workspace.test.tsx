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
    installDraftBackend(memoryBackend());
    bindPracticePreferenceAccount(null);
    bindPracticePreferenceAccount("student-test");
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
});
