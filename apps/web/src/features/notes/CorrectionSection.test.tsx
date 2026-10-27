import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type {
  AttemptResultQuestion,
  NoteHeadData,
  NoteRecordMeta,
  NoteSubmissionEvidenceMeta,
} from "@tutor/contract";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import type {
  InkChangeReason,
  InkDoc,
  InkEngine,
  InkInputMode,
  InkToolConfig,
} from "@/features/ink/engine/index.ts";
import { stroke } from "@/features/notes/note-fixtures";
import {
  applyUploadDenied,
  getNoteRecord,
  installNoteBackend,
  memoryNoteBackend,
  writeNoteDoc,
} from "@/features/notes/note-store";
import { bindNoteSession, resetNoteSession } from "@/features/notes/note-sync";
import { DOC_A } from "@/features/notes/note-test-utils";

/**
 * CorrectionSection / CorrectionWorkspace（2026-10 订正重构）组件测试：
 * 「订正」直达按钮（点击 → 懒取头 →（无未封存行则自动建空白行）→ 全屏
 * 工作台）、自动命名（第 N 次订正 + 轮次徽章）、工作台题面中性呈现
 * （无对错/答案标记）、保存检查点（追平→CAS→反思→圈画随同一并封存、
 * 部分成功留窗提示）、revision=0 拒、409 告警与 OPEN_EXISTS 续接。
 * 引擎 mock 抄 NoteLayer.test（jsdom 无 canvas）；API 出网全 mock。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentNoteDocumentApi: vi.fn(),
    putNoteDocumentApi: vi.fn(),
    createCorrectionApi: vi.fn(),
    sealCorrectionApi: vi.fn(),
  };
});

vi.mock("@/lib/note-endpoints", () => ({
  fetchNoteEvidenceApi: vi.fn(),
  fetchNoteDocumentApi: vi.fn(),
}));

vi.mock("@/features/annotation/AnnotationLayer", () => ({
  // 桩：把接线 props 落 data-*（层行为见 annotation-ui.test）
  AnnotationLayer: (props: Record<string, unknown>) =>
    createElement("div", {
      "data-testid": "annotation-layer-stub",
      "data-phase": String(props.phase ?? "scratch"),
      "data-trigger": String(props.triggerLabel ?? ""),
    }),
}));

vi.mock("@/features/annotation/seal-correction-annotation", () => ({
  sealCorrectionAnnotation: vi.fn(async () => 0),
}));

vi.mock("@/features/ink/engine/index.ts", () => ({
  create: (_container: HTMLElement, opts: unknown) => makeEngine(opts),
}));

import { sealCorrectionAnnotation } from "@/features/annotation/seal-correction-annotation";
import {
  ApiError,
  createCorrectionApi,
  fetchStudentNoteDocumentApi,
  putNoteDocumentApi,
  sealCorrectionApi,
} from "@/lib/api";
import { fetchNoteEvidenceApi } from "@/lib/note-endpoints";
import { CorrectionSection } from "./CorrectionSection";

const evidenceMock = vi.mocked(fetchNoteEvidenceApi);
const docMock = vi.mocked(fetchStudentNoteDocumentApi);
const putMock = vi.mocked(putNoteDocumentApi);
const createMock = vi.mocked(createCorrectionApi);
const sealMock = vi.mocked(sealCorrectionApi);
const annotationSealMock = vi.mocked(sealCorrectionAnnotation);

// ---------- 引擎 mock（抄 NoteLayer.test：登记实例供派发/断言） ----------

interface EngineEntry {
  opts: unknown;
  emit: ((doc: InkDoc, reason: InkChangeReason) => void) | null;
  engine: InkEngine;
  load: Mock<(data: InkDoc) => void>;
}

const entries: EngineEntry[] = [];
const mockUndo = vi.fn();
const mockRedo = vi.fn();
const mockClear = vi.fn();
const mockDestroy = vi.fn();
const mockSetTool = vi.fn();
const mockSetInputMode = vi.fn();

function makeEngine(opts: unknown): InkEngine {
  const box: { entry: EngineEntry | null } = { entry: null };
  const load = vi.fn((data: InkDoc) => {
    box.entry?.emit?.(data, "load");
  });
  const engine: InkEngine = {
    getData: () => ({
      engine: "atrament",
      version: 1,
      data: { width: 1000, strokes: [] },
      updatedAt: 0,
    }),
    load: load as unknown as InkEngine["load"],
    exportPng: () => Promise.reject(new Error("测试未使用")),
    undo: mockUndo,
    redo: mockRedo,
    clear: mockClear,
    setTool: (tool: InkToolConfig) => mockSetTool(tool),
    setInputMode: (mode: InkInputMode) => mockSetInputMode(mode),
    on: (event: string, cb: (doc: InkDoc, reason: InkChangeReason) => void) => {
      if (event === "change") {
        if (box.entry !== null) box.entry.emit = cb;
      }
      return () => {
        if (box.entry?.emit === cb) box.entry.emit = null;
      };
    },
    canUndo: () => false,
    canRedo: () => false,
    destroy: mockDestroy,
  };
  const entry: EngineEntry = { opts, emit: null, engine, load };
  box.entry = entry;
  entries.push(entry);
  return engine;
}

/** 派发一笔 stroke（逻辑坐标笔画直接进引擎 change） */
function emitStroke(entry: EngineEntry, points: Array<[number, number]>) {
  act(() => {
    entry.emit?.(
      {
        engine: "atrament",
        version: 1,
        data: { width: 1000, strokes: [stroke(points)] },
        updatedAt: 1,
      },
      "stroke",
    );
  });
}

/** 等待第 count 个引擎挂载 */
async function waitForEngine(count = 1): Promise<EngineEntry> {
  await vi.waitFor(() => {
    if (entries.length < count) throw new Error("引擎未挂载（超时重试中）");
  });
  const e = entries[count - 1];
  if (e === undefined) throw new Error("引擎未挂载");
  return e;
}

// ---------- 夹具 ----------

const CORRECTION_SCOPE = {
  ...{ attemptId: "att-1", questionId: "p1-q1" },
  phase: "correction" as const,
};
const SESSION_A = { origin: "https://tutor.example", studentId: "student-a" };

/** 结果页题目快照（公开投影；答案字段按已公布形态给全——工作台必须不读） */
function questionFixture(): AttemptResultQuestion {
  return {
    questionId: "p1-q1",
    snapshot: {
      id: "p1-q1",
      type: "choice",
      difficulty: 2,
      knowledge: ["一元一次方程"],
      stemMd: "解方程：$2x + 6 = 14$，求 $x$。",
      options: ["x = 2", "x = 4", "x = 6", "x = 8"],
      hintCount: 1,
    },
    answers: { kind: "choice", index: 1 },
    solutionMd: "移项后 $2x = 8$，故 $x = 4$。",
    answer: { kind: "choice", index: 0 },
    autoCorrect: false,
    teacherMark: null,
    teacherComment: null,
    finalCorrect: false,
    answered: true,
    selfReview: null,
    studentFlag: null,
    hintsOpened: [],
  } as unknown as AttemptResultQuestion;
}

function headFixture(
  overrides: {
    evidence?: NoteSubmissionEvidenceMeta | null;
    corrections?: NoteRecordMeta[];
  } = {},
): NoteHeadData {
  return {
    note: null,
    images: [],
    evidence: overrides.evidence ?? null,
    corrections: overrides.corrections ?? [],
    supplements: [],
  };
}

/** 已封存订正行（反思可覆盖） */
function sealedRow(n: number, overrides: Partial<NoteRecordMeta> = {}) {
  return {
    noteId: `88888888-8888-4888-8888-8888888888${String(n).padStart(2, "0")}`,
    attemptId: "att-1",
    questionId: "p1-q1",
    questionRevisionId: "qrev-1",
    phase: "correction" as const,
    revision: 2,
    currentVersionId: `33333333-3333-4333-8333-3333333333${n}1`,
    serverSavedAt: "2026-10-07T01:00:00.000Z",
    sealedAt: "2026-10-07T02:00:00.000Z",
    stuckAt: null as string | null,
    errorCause: null as string | null,
    ...overrides,
  };
}

/** 未封存订正行（继续编辑的目标） */
function openRow(overrides: Partial<NoteRecordMeta> = {}): NoteRecordMeta {
  return {
    noteId: "88888888-8888-4888-8888-888888888899",
    attemptId: "att-1",
    questionId: "p1-q1",
    questionRevisionId: "qrev-1",
    phase: "correction",
    revision: 1,
    currentVersionId: "33333333-3333-4333-8333-333333333399",
    serverSavedAt: "2026-10-07T01:00:00.000Z",
    sealedAt: null,
    stuckAt: null,
    errorCause: null,
    ...overrides,
  };
}

const RECEIPT_2 = {
  noteId: "88888888-8888-4888-8888-888888888899",
  revision: 2,
  versionId: "33333333-3333-4333-8333-333333333399",
  hash: `${"a".repeat(63)}2`,
  savedAt: "2026-10-07T03:00:00.000Z",
};

// ---------- harness ----------

function renderSection(
  props: Partial<Parameters<typeof CorrectionSection>[0]> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CorrectionSection
          attemptId="att-1"
          questionId="p1-q1"
          questionNo={1}
          ariaPrefix="第 1 题"
          question={questionFixture()}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 点击「订正」直达按钮并等待工作台打开（引擎挂载 = 草稿纸就绪） */
async function clickStartAndOpenWorkspace(
  head: NoteHeadData,
  createResult?: NoteHeadData,
) {
  evidenceMock.mockResolvedValue(head);
  if (createResult !== undefined) createMock.mockResolvedValue(createResult);
  renderSection();
  expect(evidenceMock).not.toHaveBeenCalled(); // 折叠零请求
  fireEvent.click(screen.getByRole("button", { name: /^第 1 题订正/ }));
  await waitForEngine();
}

/** correction phase 的 put 调用（过滤其他 phase 噪音） */
function correctionPuts() {
  return putMock.mock.calls.filter((c) => {
    const meta = c[3] as { phase?: string } | undefined;
    return meta?.phase === "correction";
  });
}

beforeEach(() => {
  installNoteBackend(memoryNoteBackend());
  resetNoteSession();
  entries.length = 0;
  evidenceMock.mockReset();
  docMock.mockReset();
  putMock.mockReset();
  createMock.mockReset();
  sealMock.mockReset();
  annotationSealMock.mockReset();
  annotationSealMock.mockResolvedValue(0);
  bindNoteSession(SESSION_A);
});

afterEach(() => {
  cleanup();
  resetNoteSession();
});

describe("CorrectionSection：直达入口（自动建行与继续）", () => {
  it("折叠零请求；点击订正 → 懒取头 → 无未封存行 → 自动建空白行（不复制原稿）→ 工作台打开", async () => {
    // 旧封存行残留：denied（clearCorrectionRecord 的目标场景）
    writeNoteDoc(SESSION_A, CORRECTION_SCOPE, DOC_A);
    await applyUploadDenied(SESSION_A, CORRECTION_SCOPE, "access", "终态残留");

    const newRow = openRow({
      noteId: "88888888-8888-4888-8888-888888888877",
      revision: 0,
      currentVersionId: null,
      serverSavedAt: null,
    });
    await clickStartAndOpenWorkspace(
      headFixture(),
      headFixture({ corrections: [newRow] }),
    );
    await vi.waitFor(() => {
      expect(createMock).toHaveBeenCalledWith("att-1", "p1-q1", {
        copyFromOriginal: false,
      });
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument(); // 全屏工作台
    // 新行对齐 + 残留终态已清（不灌新行）
    const record = await getNoteRecord(SESSION_A, CORRECTION_SCOPE);
    expect(record?.denied).toBeNull();
    expect(record?.pending).toBeNull();
    expect(record?.noteId).toBe(newRow.noteId);
  });

  it("已有未封存行：按钮文案「继续订正」；点击不创建，直接开工作台并播种服务端稿", async () => {
    docMock.mockResolvedValue({
      version: 1,
      ink: {
        width: 1000,
        strokes: [
          stroke([
            [7, 7],
            [8, 8],
          ]),
        ],
      },
    });
    await clickStartAndOpenWorkspace(
      headFixture({ corrections: [sealedRow(1), openRow()] }),
    );
    expect(createMock).not.toHaveBeenCalled();
    const entry = await waitForEngine();
    await vi.waitFor(() => {
      const last = entry.load.mock.calls.at(-1)?.[0] as
        | InkDoc<"atrament">
        | undefined;
      expect(last?.data.strokes.length).toBe(1);
    });
    // 关闭工作台后按钮为「继续订正」形态（Radix 弹层期间外部 inert 不可查）
    fireEvent.click(screen.getByRole("button", { name: "关闭弹层" }));
    await vi.waitFor(() => {
      expect(
        screen.getByRole("button", { name: "第 1 题继续订正（已订正 1 次）" }),
      ).toBeInTheDocument();
    });
  });

  it("自动命名：轮次徽章 = roundLabel · 第 N 次订正（N = 已封存数 + 进行中这份）", async () => {
    evidenceMock.mockResolvedValue(
      headFixture({
        corrections: [sealedRow(1), sealedRow(2), openRow()],
      }),
    );
    renderSection({ roundLabel: "第 2 次课程练习" });
    fireEvent.click(screen.getByRole("button", { name: /^第 1 题订正/ }));
    await waitForEngine();
    expect(
      screen.getByText("第 2 次课程练习 · 第 3 次订正"),
    ).toBeInTheDocument();
  });

  it("已封存 N 份（无未封存行）：按钮显示计数（可见文本 · N 与 aria 次数）", async () => {
    // 头在点击时拉取：两份已封存 → 自动建新行（第 3 次）；关闭工作台后计数保持
    evidenceMock.mockResolvedValue(
      headFixture({ corrections: [sealedRow(1), sealedRow(2)] }),
    );
    createMock.mockResolvedValue(
      headFixture({ corrections: [sealedRow(1), sealedRow(2), openRow()] }),
    );
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: /^第 1 题订正/ }));
    await waitForEngine();
    // 关闭工作台（Radix 弹层期间外部 inert，关闭后再断言）
    fireEvent.click(screen.getByRole("button", { name: "关闭弹层" }));
    await vi.waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "第 1 题继续订正（已订正 2 次）",
        }),
      ).toBeInTheDocument();
    });
  });

  it("头读取失败 → 按钮旁中文告警（不吞错），可再点重试", async () => {
    evidenceMock.mockRejectedValue(
      new ApiError("NOTE_NOT_FOUND", "找不到这道题的笔记信息", 404),
    );
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: /^第 1 题订正/ }));
    expect(await screen.findByText(/订正信息读取失败/)).toBeInTheDocument();
    expect(screen.getByText(/找不到这道题的笔记信息/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull(); // 工作台未打开
  });

  it("创建撞 409 OPEN_EXISTS（他端已建行）：重拉头继续既有行，不报错", async () => {
    const openHead = headFixture({ corrections: [openRow()] });
    evidenceMock.mockResolvedValue(headFixture());
    createMock.mockRejectedValue(
      new ApiError(
        "NOTE_CORRECTION_OPEN_EXISTS",
        "已有未保存完的订正，请继续编辑",
        409,
      ),
    );
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: /^第 1 题订正/ }));
    // 首取无行 → create 撞 409 → 重拉头（这次有行）→ 继续打开工作台
    evidenceMock.mockResolvedValue(openHead);
    await waitForEngine();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText(/已有未保存完的订正/)).toBeNull();
  });
});

describe("CorrectionWorkspace：题面与圈画/草稿（复用草稿功能）", () => {
  it("题面中性呈现：题干与选项渲染，无对错/答案标记（重做先不被答案干扰）", async () => {
    await clickStartAndOpenWorkspace(headFixture({ corrections: [openRow()] }));
    expect(screen.getByText(/解方程/)).toBeInTheDocument();
    expect(screen.getByText("x = 4")).toBeInTheDocument(); // 选项内容（正确项无标记）
    expect(screen.queryByText("正确项")).toBeNull();
    expect(screen.queryByText("你的选择")).toBeNull();
    expect(screen.queryByText(/参考答案/)).toBeNull();
    expect(screen.queryByText(/详解/)).toBeNull();
    expect(screen.queryByText("答错")).toBeNull();
  });

  it("圈画层以订正期挂载（phase=correction、入口文案「圈画题干」）", async () => {
    await clickStartAndOpenWorkspace(headFixture({ corrections: [openRow()] }));
    const stub = document.querySelector(
      '[data-testid="annotation-layer-stub"]',
    );
    expect(stub?.getAttribute("data-phase")).toBe("correction");
    expect(stub?.getAttribute("data-trigger")).toBe("圈画题干");
  });
});

describe("CorrectionWorkspace：保存订正（一层检查点）", () => {
  /** 打开工作台（head 带未封存行 rev1 + 播种 1 笔服务端稿） */
  async function openWorkspaceWithSeededRow() {
    docMock.mockResolvedValue({
      version: 1,
      ink: {
        width: 1000,
        strokes: [
          stroke([
            [7, 7],
            [8, 8],
          ]),
        ],
      },
    });
    await clickStartAndOpenWorkspace(headFixture({ corrections: [openRow()] }));
    await waitForEngine();
  }

  it("反思输入随确认弹层；超限按 500 字截断（契约常量单源）", async () => {
    await openWorkspaceWithSeededRow();
    fireEvent.click(screen.getByRole("button", { name: "保存订正" }));
    const stuck = screen.getByLabelText("我卡在哪里");
    fireEvent.change(stuck, { target: { value: "卡".repeat(600) } });
    expect(stuck).toHaveValue("卡".repeat(500));
    expect(screen.getAllByText("最多 500 字")).toHaveLength(2);
    expect(screen.getAllByText(/保存后定格为/).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("无新书写：追平后按 baseRevision=1 封存并携带反思；成功后工作台关闭、按钮计数 +1", async () => {
    await openWorkspaceWithSeededRow();
    sealMock.mockResolvedValue(
      headFixture({
        corrections: [sealedRow(1, { stuckAt: "第二问不会代入" })],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存订正" }));
    fireEvent.change(screen.getByLabelText("我卡在哪里"), {
      target: { value: "第二问不会代入" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    await vi.waitFor(() => {
      expect(sealMock).toHaveBeenCalledWith("att-1", "p1-q1", {
        baseRevision: 1,
        stuckAt: "第二问不会代入",
      });
    });
    // 圈画随同一并封存（一层检查点）
    await vi.waitFor(() => {
      expect(annotationSealMock).toHaveBeenCalledWith({
        attemptId: "att-1",
        questionId: "p1-q1",
      });
    });
    // 成功：工作台关闭、按钮进入计数形态
    await vi.waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(
      screen.getByRole("button", { name: "第 1 题订正（已订正 1 次）" }),
    ).toBeInTheDocument();
  });

  it("新书写在途：追平（correction phase 上送）后按回执 revision 封存", async () => {
    await openWorkspaceWithSeededRow();
    const entry = entries[0];
    if (entry === undefined) throw new Error("引擎缺失（测试前置失败）");
    emitStroke(entry, [
      [10, 10],
      [40, 40],
    ]);
    putMock.mockResolvedValue(RECEIPT_2);
    sealMock.mockResolvedValue(headFixture({ corrections: [sealedRow(1)] }));
    fireEvent.click(screen.getByRole("button", { name: "保存订正" }));
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    await vi.waitFor(() => {
      expect(sealMock).toHaveBeenCalledWith("att-1", "p1-q1", {
        baseRevision: 2,
      });
    });
    const put = correctionPuts()[0];
    expect(put?.[3]).toMatchObject({ phase: "correction", baseRevision: 1 });
  });

  it("未书写（revision=0 空白行）：拒并提示先在草稿纸上书写，不调 seal", async () => {
    await clickStartAndOpenWorkspace(
      headFixture({
        corrections: [
          openRow({ revision: 0, currentVersionId: null, serverSavedAt: null }),
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存订正" }));
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    expect(
      await screen.findByText(/还没有订正内容，请先在草稿纸上书写再保存/),
    ).toBeInTheDocument();
    expect(sealMock).not.toHaveBeenCalled();
  });

  it("封存失败（409 冲突）：弹层内中文告警，可重试", async () => {
    await openWorkspaceWithSeededRow();
    sealMock.mockRejectedValue(
      new ApiError("NOTE_REVISION_CONFLICT", "内容已在其他设备保存", 409),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存订正" }));
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    expect(await screen.findByText(/内容已在其他设备保存/)).toBeInTheDocument();
    sealMock.mockResolvedValue(headFixture({ corrections: [sealedRow(1)] }));
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    await vi.waitFor(() => {
      expect(sealMock).toHaveBeenCalledTimes(2);
    });
  });

  it("圈画封存失败：部分成功留窗提示（订正已保存、圈画未定格），「知道了」关闭", async () => {
    await openWorkspaceWithSeededRow();
    annotationSealMock.mockRejectedValue(
      new Error("订正圈画的最新修改还没同步完成，请稍候再试。"),
    );
    sealMock.mockResolvedValue(headFixture({ corrections: [sealedRow(1)] }));
    fireEvent.click(screen.getByRole("button", { name: "保存订正" }));
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    expect(await screen.findByText(/订正已保存为/)).toBeInTheDocument();
    expect(screen.getByText(/暂未一并定格/)).toBeInTheDocument();
    // 弹层不再提供「确认保存」重跑（订正行已封存，重跑必 404）
    expect(screen.queryByRole("button", { name: "确认保存" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await vi.waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(
      screen.getByRole("button", { name: "第 1 题订正（已订正 1 次）" }),
    ).toBeInTheDocument();
  });
});
