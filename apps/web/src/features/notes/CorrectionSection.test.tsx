import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type {
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
  applyUploadConflict,
  applyUploadDenied,
  getNoteRecord,
  installNoteBackend,
  memoryNoteBackend,
  writeNoteDoc,
} from "@/features/notes/note-store";
import { bindNoteSession, resetNoteSession } from "@/features/notes/note-sync";
import { DOC_A } from "@/features/notes/note-test-utils";

/**
 * CorrectionSection / CorrectionPanel（T6R.15 C）组件测试：结果页订正区——
 * 展开/折叠零请求口径、添加订正两选项与禁用态、创建（清残留+播种）、
 * 已封存列表（封存时间/反思分栏/NoteVersionView 接线）、seal 流程
 * （追平→CAS baseRevision→反思与超限提示→revision=0 拒）、SEALED 自动
 * 重开（组件层）、D8 找回草稿为补充稿（确认文案与本地复制）。
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

vi.mock("@/features/notes/NoteVersionView", () => ({
  // 桩：把接线 props 落 data-*（面板行为见 NoteVersionView.test）
  NoteVersionView: (props: Record<string, unknown>) =>
    createElement("div", {
      "data-testid": "note-version-stub",
      "data-version": String(props.versionId ?? ""),
      "data-title": String(props.title ?? ""),
      "data-savedat": String(props.savedAt ?? ""),
    }),
}));

vi.mock("@/features/ink/engine/index.ts", () => ({
  create: (_container: HTMLElement, opts: unknown) => makeEngine(opts),
}));

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
const SCRATCH_SCOPE = {
  ...{ attemptId: "att-1", questionId: "p1-q1" },
  phase: "scratch" as const,
};
const SUPPLEMENT_SCOPE = {
  ...{ attemptId: "att-1", questionId: "p1-q1" },
  phase: "supplement" as const,
};
const SESSION_A = { origin: "https://tutor.example", studentId: "student-a" };

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

function evidenceFixture(
  state: "none" | "frozen" | "missing" | "legacy_unverified",
): NoteSubmissionEvidenceMeta {
  return {
    attemptId: "att-1",
    questionId: "p1-q1",
    state,
    versionId:
      state === "frozen" ? "33333333-3333-4333-8333-3333333333aa" : null,
    recordedAt: "2026-10-07T00:30:00.000Z",
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

/** 未封存订正行（继续编辑入口的目标） */
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
          ariaPrefix="第 1 题"
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 展开订正区并等头就绪（加载态消失 = queryFn 已 settle） */
async function expandAndWait(head: NoteHeadData) {
  evidenceMock.mockResolvedValue(head);
  renderSection();
  expect(evidenceMock).not.toHaveBeenCalled(); // 折叠零请求
  fireEvent.click(screen.getByRole("button", { name: "第 1 题订正" }));
  await vi.waitFor(() => {
    expect(evidenceMock).toHaveBeenCalledWith("student", "att-1", "p1-q1");
  });
  await vi.waitFor(() => {
    if (screen.queryByLabelText("正在读取订正信息") !== null) {
      throw new Error("头仍在加载（超时重试中）");
    }
  });
}

/** correction phase 的 put 调用（过滤 scratch 噪音） */
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
  bindNoteSession(SESSION_A);
});

afterEach(() => {
  cleanup();
  resetNoteSession();
});

describe("CorrectionSection：折叠/展开与三态", () => {
  it("折叠零请求；展开拉证据头（学生角色，本 attempt 本题定位）", async () => {
    await expandAndWait(headFixture());
  });

  it("头加载失败 → 错误面板 + 重试（不吞错）", async () => {
    // ApiError（终态类）不重试——普通网络错误按生产语义退避重试，等不及断言
    evidenceMock.mockRejectedValue(
      new ApiError("NOTE_NOT_FOUND", "找不到这道题的笔记信息", 404),
    );
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "第 1 题订正" }));
    expect(await screen.findByText(/订正信息读取失败/)).toBeInTheDocument();
    expect(screen.getByText(/找不到这道题的笔记信息/)).toBeInTheDocument();
    evidenceMock.mockResolvedValue(headFixture());
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await vi.waitFor(() => {
      expect(
        screen.getByRole("button", { name: "添加订正" }),
      ).toBeInTheDocument();
    });
  });

  it("「本题历史」链接携 questionId 跳笔记本", async () => {
    await expandAndWait(headFixture());
    expect(
      screen.getByRole("link", { name: "第 1 题本题历史" }),
    ).toHaveAttribute("href", "/s/notebook/p1-q1");
  });
});

describe("CorrectionSection：添加订正（两选项与禁用态）", () => {
  it("无订正：显示「添加订正」与空态说明", async () => {
    await expandAndWait(headFixture());
    expect(
      screen.getByRole("button", { name: "添加订正" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/还没有保存过的订正/)).toBeInTheDocument();
  });

  it("Dialog 二选一：默认空白可用；证据非 frozen 时「复制原稿」禁用并说明", async () => {
    await expandAndWait(headFixture({ evidence: evidenceFixture("missing") }));
    fireEvent.click(screen.getByRole("button", { name: "添加订正" }));
    expect(screen.getByRole("button", { name: "空白订正" })).toBeEnabled();
    const copy = screen.getByRole("button", { name: "复制原稿开始订正" });
    expect(copy).toBeDisabled();
    expect(screen.getByText(/本次交卷没有可复制的原稿/)).toBeInTheDocument();
  });

  it("证据 frozen 时「复制原稿」可选并触发 copyFromOriginal=true", async () => {
    await expandAndWait(headFixture({ evidence: evidenceFixture("frozen") }));
    fireEvent.click(screen.getByRole("button", { name: "添加订正" }));
    createMock.mockResolvedValue(
      headFixture({ corrections: [openRow({ revision: 1 })] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "复制原稿开始订正" }));
    await vi.waitFor(() => {
      expect(createMock).toHaveBeenCalledWith("att-1", "p1-q1", {
        copyFromOriginal: true,
      });
    });
  });

  it("空白创建：create(false) → 清旧残留（pending/denied 不灌新行）→ 面板打开", async () => {
    // 旧封存行残留：pending + denied（clearCorrectionRecord 的目标场景）
    writeNoteDoc(SESSION_A, CORRECTION_SCOPE, DOC_A);
    await applyUploadDenied(SESSION_A, CORRECTION_SCOPE, "access", "终态残留");

    await expandAndWait(headFixture());
    fireEvent.click(screen.getByRole("button", { name: "添加订正" }));
    const newRow = openRow({
      noteId: "88888888-8888-4888-8888-888888888877",
      revision: 0,
      currentVersionId: null,
      serverSavedAt: null,
    });
    createMock.mockResolvedValue(headFixture({ corrections: [newRow] }));
    fireEvent.click(screen.getByRole("button", { name: "空白订正" }));
    await vi.waitFor(() => {
      expect(createMock).toHaveBeenCalledWith("att-1", "p1-q1", {
        copyFromOriginal: false,
      });
    });
    // 面板打开（引擎挂载 = 编辑器就绪）
    await waitForEngine();
    const record = await getNoteRecord(SESSION_A, CORRECTION_SCOPE);
    expect(record?.denied).toBeNull(); // 残留终态已清
    expect(record?.pending).toBeNull(); // 旧 pending 已清（不灌新行）
    expect(record?.noteId).toBe(newRow.noteId); // 新行对齐
    expect(record?.doc.ink.strokes).toEqual([]); // 空白起步
  });

  it("创建失败（409 OPEN_EXISTS）：Dialog 内中文告警", async () => {
    await expandAndWait(headFixture());
    fireEvent.click(screen.getByRole("button", { name: "添加订正" }));
    createMock.mockRejectedValue(
      new ApiError(
        "NOTE_CORRECTION_OPEN_EXISTS",
        "已有未保存完的订正，请继续编辑",
        409,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "空白订正" }));
    expect(await screen.findByText(/已有未保存完的订正/)).toBeInTheDocument();
  });
});

describe("CorrectionSection：已封存订正列表与继续编辑", () => {
  it("封存时间 + 反思分栏（两标签；无则不显示）+ NoteVersionView 接线（笔数在查看面板）", async () => {
    await expandAndWait(
      headFixture({
        corrections: [
          sealedRow(1, { stuckAt: "第二问不会代入", errorCause: null }),
          sealedRow(2, { stuckAt: null, errorCause: "抄错符号" }),
        ],
      }),
    );
    expect(screen.getAllByText(/封存于 2026年10月7日/)).toHaveLength(2);
    expect(screen.getAllByText("我卡在哪里：")).toHaveLength(1);
    expect(screen.getByText("第二问不会代入")).toBeInTheDocument();
    expect(screen.getAllByText("我的错因：")).toHaveLength(1);
    expect(screen.getByText("抄错符号")).toBeInTheDocument();
    const stubs = [
      ...document.querySelectorAll('[data-testid="note-version-stub"]'),
    ];
    expect(stubs).toHaveLength(2);
    expect(stubs[0]?.getAttribute("data-version")).toBe(
      "33333333-3333-4333-8333-333333333311",
    );
    expect(stubs[0]?.getAttribute("data-savedat")).toBe(
      "2026-10-07T02:00:00.000Z",
    );
  });

  it("未封存行：显示「编辑中」与「继续编辑订正」；点开播种服务端稿进引擎", async () => {
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
    await expandAndWait(
      headFixture({ corrections: [sealedRow(1), openRow()] }),
    );
    expect(screen.getByText("编辑中")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑订正" }));
    const entry = await waitForEngine();
    // 引擎最终载入服务端稿（1 笔——播种链路 seedOpenCorrection）
    await vi.waitFor(() => {
      const last = entry.load.mock.calls.at(-1)?.[0] as
        | InkDoc<"atrament">
        | undefined;
      expect(last?.data.strokes.length).toBe(1);
    });
  });

  it("收起订正区（open=false）→ 编辑器一并收起，不再挂载（闸门修复 F2）", async () => {
    docMock.mockResolvedValue({
      version: 1,
      ink: { width: 1000, strokes: [] },
    });
    await expandAndWait(headFixture({ corrections: [openRow()] }));
    fireEvent.click(screen.getByRole("button", { name: "继续编辑订正" }));
    await waitForEngine();
    expect(screen.queryByRole("toolbar")).not.toBeNull(); // 编辑器在文档中
    // 收起订正区 → 编辑器（InkPad 引擎 + 工具条）随区块一起卸载
    fireEvent.click(screen.getByRole("button", { name: "第 1 题订正" }));
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(document.querySelector('[data-slot="correction-panel"]')).toBeNull();
    // 重新展开：未封存的编辑会话随之恢复（编辑器重新挂载）
    fireEvent.click(screen.getByRole("button", { name: "第 1 题订正" }));
    await vi.waitFor(() => {
      expect(screen.queryByRole("toolbar")).not.toBeNull();
    });
  });
});

describe("CorrectionPanel：保存订正（seal 检查点）", () => {
  /** 打开面板（head 带未封存行 rev1 + 播种 1 笔服务端稿） */
  async function openPanelWithSeededRow() {
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
    await expandAndWait(headFixture({ corrections: [openRow()] }));
    fireEvent.click(screen.getByRole("button", { name: "继续编辑订正" }));
    await waitForEngine();
  }

  it("确认提示与反思输入；超限按 500 字截断（契约常量单源）", async () => {
    await openPanelWithSeededRow();
    fireEvent.click(screen.getByRole("button", { name: "保存订正" }));
    expect(
      screen.getAllByText(/保存后这份订正定格，再修改会新开一份/).length,
    ).toBeGreaterThanOrEqual(1);
    const stuck = screen.getByLabelText("我卡在哪里");
    fireEvent.change(stuck, { target: { value: "卡".repeat(600) } });
    expect(stuck).toHaveValue("卡".repeat(500));
    expect(screen.getAllByText("最多 500 字")).toHaveLength(2);
  });

  it("无新书写：追平后按 baseRevision=1 封存并携带反思；成功后面板收起、列表刷新", async () => {
    await openPanelWithSeededRow();
    const sealedBack = headFixture({
      corrections: [sealedRow(1, { stuckAt: "第二问不会代入" })],
    });
    sealMock.mockResolvedValue(sealedBack);
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
    // 成功：编辑器收起、封存列表出现（含反思）
    await vi.waitFor(() => {
      expect(screen.getByText("第二问不会代入")).toBeInTheDocument();
    });
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("新书写在途：追平（correction phase 上送）后按回执 revision 封存", async () => {
    await openPanelWithSeededRow();
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
    // 追平上送带 phase=correction、CAS 基线为播种后的 1
    const put = correctionPuts()[0];
    expect(put?.[3]).toMatchObject({ phase: "correction", baseRevision: 1 });
  });

  it("未书写（revision=0 空白行）：拒并提示先书写，不调 seal", async () => {
    await expandAndWait(
      headFixture({
        corrections: [
          openRow({ revision: 0, currentVersionId: null, serverSavedAt: null }),
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "继续编辑订正" }));
    await waitForEngine();
    fireEvent.click(screen.getByRole("button", { name: "保存订正" }));
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    expect(
      await screen.findByText(/还没有订正内容，请先书写再保存/),
    ).toBeInTheDocument();
    expect(sealMock).not.toHaveBeenCalled();
  });

  it("封存失败（409 冲突）：Dialog 内中文告警，可重试", async () => {
    await openPanelWithSeededRow();
    sealMock.mockRejectedValue(
      new ApiError("NOTE_REVISION_CONFLICT", "内容已在其他设备保存", 409),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存订正" }));
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    expect(await screen.findByText(/内容已在其他设备保存/)).toBeInTheDocument();
    // 可重试：再次确认走 seal
    sealMock.mockResolvedValue(headFixture({ corrections: [sealedRow(1)] }));
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    await vi.waitFor(() => {
      expect(sealMock).toHaveBeenCalledTimes(2);
    });
  });

  it("SEALED 自动重开（组件层）：追平撞封存 → 重置 baseRevision=0 重试成功 → 封存按新行 revision", async () => {
    await openPanelWithSeededRow();
    const entry = entries[0];
    if (entry === undefined) throw new Error("引擎缺失（测试前置失败）");
    emitStroke(entry, [
      [10, 10],
      [40, 40],
    ]);
    // 第一次 put 撞已封存（他端封存窗口）；重试后新行首传成功 rev1
    putMock
      .mockRejectedValueOnce(
        new ApiError("NOTE_CORRECTION_SEALED", "该订正已保存定格", 409),
      )
      .mockResolvedValueOnce({ ...RECEIPT_2, revision: 1 });
    sealMock.mockResolvedValue(headFixture({ corrections: [sealedRow(1)] }));
    fireEvent.click(screen.getByRole("button", { name: "保存订正" }));
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    await vi.waitFor(() => {
      expect(sealMock).toHaveBeenCalledWith("att-1", "p1-q1", {
        baseRevision: 1,
      });
    });
    const puts = correctionPuts();
    expect(puts).toHaveLength(2);
    expect(puts[1]?.[3]).toMatchObject({
      phase: "correction",
      baseRevision: 0,
    });
  });
});

describe("CorrectionSection：补充稿同步状态（闸门修复 F3）", () => {
  /** 补充稿上传成功回执（noteId 对齐 SUPPLEMENT_SCOPE 的新行） */
  const SUPPLEMENT_RECEIPT = {
    noteId: "99999999-9999-4999-8999-999999999901",
    revision: 1,
    versionId: "33333333-3333-4333-8333-3333333333s1",
    hash: `${"b".repeat(63)}1`,
    savedAt: "2026-10-07T04:00:00.000Z",
  };

  /** 本地已有未同步补充稿（找回后的形态：pending 待传） */
  async function supplementWithPending(): Promise<void> {
    writeNoteDoc(SESSION_A, SUPPLEMENT_SCOPE, DOC_A);
  }

  it("无本地 supplement 记录 → 不渲染「补充稿同步状态」区块", async () => {
    await expandAndWait(headFixture());
    expect(screen.queryByText("补充稿同步状态")).toBeNull();
  });

  it("已全同步（无异常）→ 区块不制造噪音", async () => {
    await supplementWithPending();
    const record = await getNoteRecord(SESSION_A, SUPPLEMENT_SCOPE);
    if (record === null) throw new Error("测试前置失败");
    record.pending = null;
    record.baseRevision = 1;
    record.noteId = SUPPLEMENT_RECEIPT.noteId;
    await expandAndWait(headFixture());
    expect(screen.queryByText("补充稿同步状态")).toBeNull();
  });

  it("conflict 终态（双端都找回）：显示状态块与两裁决按钮；保留本机 → 恢复上传（phase=supplement）", async () => {
    await supplementWithPending();
    await applyUploadConflict(
      SESSION_A,
      SUPPLEMENT_SCOPE,
      {
        noteId: SUPPLEMENT_RECEIPT.noteId,
        revision: 2,
        versionId: "33333333-3333-4333-8333-3333333333s2",
        hash: null,
        serverSavedAt: null,
      },
      "服务端已有这份题的补充稿",
    );
    putMock.mockResolvedValue(SUPPLEMENT_RECEIPT);
    await expandAndWait(headFixture());
    expect(screen.getByText("补充稿同步状态")).toBeInTheDocument();
    expect(screen.getByText("补充稿内容冲突")).toBeInTheDocument();
    expect(screen.getByText(/服务端已有这份题的补充稿/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保留本机内容" }));
    await vi.waitFor(() => {
      expect(screen.queryByText("补充稿内容冲突")).toBeNull();
    });
    await vi.waitFor(() => {
      const put = putMock.mock.calls.find((c) => {
        const meta = c[3] as { phase?: string } | undefined;
        return meta?.phase === "supplement";
      });
      expect(put).toBeDefined();
    });
  });

  it("denied(access) 终态：重试同步入口清终态并补传", async () => {
    await supplementWithPending();
    await applyUploadDenied(
      SESSION_A,
      SUPPLEMENT_SCOPE,
      "access",
      "已无权限访问该练习",
    );
    putMock.mockResolvedValue(SUPPLEMENT_RECEIPT);
    await expandAndWait(headFixture());
    expect(screen.getByText("补充稿已停止同步")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试同步" }));
    await vi.waitFor(() => {
      expect(screen.queryByText("补充稿已停止同步")).toBeNull();
    });
    await vi.waitFor(() => {
      const put = putMock.mock.calls.find((c) => {
        const meta = c[3] as { phase?: string } | undefined;
        return meta?.phase === "supplement";
      });
      expect(put).toBeDefined();
    });
  });
});

describe("CorrectionSection：找回草稿为补充稿（D8）", () => {
  it("evidence∈{missing,none,legacy_unverified} 且 scratch 有未同步内容 → 破坏性次级按钮 + 确认文案 + 本地复制（scratch 保留）", async () => {
    writeNoteDoc(SESSION_A, SCRATCH_SCOPE, DOC_A); // 未同步内容（pending）
    await expandAndWait(headFixture({ evidence: evidenceFixture("missing") }));
    fireEvent.click(screen.getByRole("button", { name: "找回草稿为补充稿" }));
    expect(
      screen.getByText(/找回的内容只能作为补充材料，不能变成交卷时的原稿/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认找回" }));
    await vi.waitFor(() => {
      expect(screen.getByText(/已加入补充稿同步队列/)).toBeInTheDocument();
    });
    const supplement = await getNoteRecord(SESSION_A, SUPPLEMENT_SCOPE);
    expect(supplement?.doc.ink.strokes.length).toBe(DOC_A.ink.strokes.length);
    expect(supplement?.pending).not.toBeNull();
    const scratch = await getNoteRecord(SESSION_A, SCRATCH_SCOPE);
    expect(scratch?.pending).not.toBeNull(); // scratch 本地记录保留不动
  });

  it("evidence frozen 或 scratch 已全同步 → 不显示找回入口", async () => {
    writeNoteDoc(SESSION_A, SCRATCH_SCOPE, DOC_A);
    const record = await getNoteRecord(SESSION_A, SCRATCH_SCOPE);
    if (record === null) throw new Error("测试前置失败");
    record.pending = null; // 已全同步
    record.baseRevision = 1;
    record.noteId = "22222222-2222-4222-8222-222222222222";
    await expandAndWait(headFixture({ evidence: evidenceFixture("frozen") }));
    expect(
      screen.queryByRole("button", { name: "找回草稿为补充稿" }),
    ).toBeNull(); // frozen：原稿已固定，无找回语义
    record.pending = { mutationId: "m-1", doc: DOC_A }; // 恢复未同步内容
    // 重新展开（同一挂载收起再展开，头缓存命中不重拉；本地 scratch 重判）
    fireEvent.click(screen.getByRole("button", { name: "第 1 题订正" })); // 收起
    fireEvent.click(screen.getByRole("button", { name: "第 1 题订正" })); // 再展开
    await vi.waitFor(() => {
      expect(
        screen.getByRole("button", { name: "添加订正" }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "找回草稿为补充稿" }),
    ).toBeNull(); // frozen 仍不显示（证据状态是入口的第一道门）
  });
});
