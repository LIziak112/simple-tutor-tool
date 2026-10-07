import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { NoteHeadData } from "@tutor/contract";
import { useState } from "react";
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
import {
  getSessionInputPreference,
  resetSessionInputPreference,
} from "@/features/ink/input-preference";
import {
  NOTE_ENGINE_KEEPALIVE_MS,
  NoteLayer,
} from "@/features/notes/NoteLayer";
import { docOf, stroke } from "@/features/notes/note-fixtures";
import type { NoteStoreBackend } from "@/features/notes/note-store";
import {
  applyServerLoad,
  applyUploadConflict,
  applyUploadDenied,
  getNoteRecord,
  installNoteBackend,
  memoryNoteBackend,
  peekNoteRecord,
  writeNoteDoc,
} from "@/features/notes/note-store";
import { bindNoteSession, resetNoteSession } from "@/features/notes/note-sync";
import {
  emptyAtramentDoc,
  headOf,
  makeResizeObserverStub,
  noteHeadsMockResponse,
  SCOPE,
  SESSION_A,
} from "@/features/notes/note-test-utils";

/**
 * NoteLayer（T6R.9）组件测试：开合不丢稿（挂载卸载往返）、多题不共用
 * 正文、触底自动加高走逻辑口径（只扩外框不改笔迹、防棘轮、load 不写回）、
 * 外部播种/冲突裁决/被拒重试/清空确认、工具条可点击。引擎模块 mock
 * （jsdom 无 canvas，口径同 InkPad.test）；head 接口出网 mock。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentNoteHeadsApi: vi.fn(),
    fetchStudentNoteDocumentApi: vi.fn(),
    putNoteDocumentApi: vi.fn(),
  };
});

vi.mock("@/features/notes/image-sync", () => ({
  recoverNoteImages: vi.fn(async () => []),
}));

vi.mock("@/features/ink/engine/index.ts", () => ({
  create: (_container: HTMLElement, opts: unknown) => makeEngine(opts),
}));

import {
  fetchStudentNoteDocumentApi,
  fetchStudentNoteHeadsApi,
  putNoteDocumentApi,
} from "@/lib/api";
import { resetNoteHeadBatchForTest } from "@/lib/note-head-batch";

const putMock = vi.mocked(putNoteDocumentApi);
const headsMock = vi.mocked(fetchStudentNoteHeadsApi);
const docMock = vi.mocked(fetchStudentNoteDocumentApi);

// 批量头 mock 用共享工厂 noteHeadsMockResponse（W5 收敛四份手写变体）：
// 按请求 id 逐条回显、覆盖表定制、缺省空态（见各 mockImplementation 调用点）

// ---------- 引擎 mock（每实例登记，供测试派发 change / 断言调用） ----------

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
let mockCanUndo = false;

function makeEngine(opts: unknown): InkEngine {
  // 先建 load/engine 再回填 entry（互相引用；类型经一次显式断言收口）
  const box: { entry: EngineEntry | null } = { entry: null };
  const load = vi.fn((data: InkDoc) => {
    box.entry?.emit?.(data, "load");
  });
  const engine: InkEngine = {
    getData: () => emptyAtramentDoc(),
    // 真引擎 load 后发 change(reason="load")——外部同步 effect 依赖此语义
    load: load as unknown as InkEngine["load"],
    exportPng: () => Promise.reject(new Error("测试未使用")),
    undo: mockUndo,
    redo: mockRedo,
    clear: mockClear,
    setTool: (tool: InkToolConfig) => mockSetTool(tool),
    setInputMode: (mode: InkInputMode) => mockSetInputMode(mode),
    on: (event: string, cb: (doc: InkDoc, reason: InkChangeReason) => void) => {
      if (event === "change") entry.emit = cb;
      return () => {
        if (entry.emit === cb) entry.emit = null;
      };
    },
    canUndo: () => mockCanUndo,
    canRedo: () => false,
    destroy: mockDestroy,
  };
  const entry: EngineEntry = { opts, emit: null, engine, load };
  box.entry = entry;
  entries.push(entry);
  return engine;
}

/** 派发一笔 stroke（逻辑坐标笔画数组直接进引擎 change） */
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

/** 等待第 count 个引擎挂载（localLoaded 异步 settle 后 InkPad 才挂载） */
async function waitForEngine(count = 1): Promise<EngineEntry> {
  await vi.waitFor(() => {
    if (entries.length < count) throw new Error("引擎未挂载（超时重试中）");
  });
  const e = entries[count - 1];
  if (e === undefined) throw new Error("引擎未挂载");
  return e;
}

// ---------- 组件 harness ----------

function renderLayer(
  props: Partial<Parameters<typeof NoteLayer>[0]> & {
    attemptId?: string;
    questionId?: string;
    initialOpen?: boolean;
  } = {},
) {
  const {
    attemptId = SCOPE.attemptId,
    questionId = SCOPE.questionId,
    initialOpen = false,
    ...rest
  } = props;
  const onOpenChange = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(initialOpen);
    return (
      <NoteLayer
        attemptId={attemptId}
        questionId={questionId}
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next);
          setOpen(next);
        }}
        {...rest}
      />
    );
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return { ...utils, onOpenChange };
}

beforeEach(async () => {
  resetNoteHeadBatchForTest();
  installNoteBackend(memoryNoteBackend());
  resetNoteSession();
  headsMock.mockImplementation(noteHeadsMockResponse());
  putMock.mockReset().mockResolvedValue({
    noteId: "22222222-2222-4222-8222-222222222222",
    revision: 1,
    versionId: "33333333-3333-4333-8333-333333333301",
    hash: `${"a".repeat(63)}1`,
    savedAt: "2026-10-06T00:00:00.000Z",
  });
  entries.length = 0;
  mockCanUndo = false;
  vi.clearAllMocks();
  bindNoteSession(SESSION_A);
});

afterEach(() => {
  cleanup();
  resetNoteSession();
  vi.unstubAllGlobals();
});

describe("NoteLayer：收起/展开形态", () => {
  it("收起只显示标记按钮（画布不挂载）；点开挂载画布与精简工具条", async () => {
    const { onOpenChange } = renderLayer();
    expect(screen.getByRole("button", { name: /草稿纸/ })).toBeInTheDocument();
    expect(entries.length).toBe(0); // 画布未挂载

    fireEvent.click(screen.getByRole("button", { name: /草稿纸/ }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    // Harness 已回写 open → 工具条出现
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    for (const name of ["笔", "橡皮", "撤销", "手指书写", "更多"]) {
      expect(
        screen.getByRole("button", { name: new RegExp(name) }),
      ).toBeInTheDocument();
    }
    await waitForEngine(); // 引擎挂载（localLoaded settle 后）
  });

  it("开合不丢稿：写→收起（保活不卸载）→标记笔数→展开零重建（复审⑦）", async () => {
    renderLayer({ initialOpen: true });
    const first = await waitForEngine();
    emitStroke(first, [
      [10, 10],
      [40, 40],
    ]);
    const record = await getNoteRecord(SESSION_A, SCOPE);
    expect(record?.doc.ink.strokes.length).toBe(1);

    // 收起 → 纸面隐藏保留（保活期内不销毁），store 正文保留
    fireEvent.click(screen.getByRole("button", { name: /收起/ }));
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(screen.getByText(/1 笔/)).toBeInTheDocument();

    // 展开 → 零重建（同一引擎实例，不重放 initial）
    fireEvent.click(screen.getByRole("button", { name: /草稿纸/ }));
    await vi.waitFor(() =>
      expect(screen.getByRole("toolbar")).toBeInTheDocument(),
    );
    expect(entries.length).toBe(1);
  });

  it("保活超时才卸载；重开重建且 initial 带回笔迹（自写自载令牌守卫复审②）", async () => {
    vi.useFakeTimers();
    try {
      renderLayer({ initialOpen: true });
      const first = await waitForEngine();
      emitStroke(first, [
        [10, 10],
        [40, 40],
      ]);
      fireEvent.click(screen.getByRole("button", { name: /收起/ }));
      expect(mockDestroy).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(NOTE_ENGINE_KEEPALIVE_MS);
      });
      expect(mockDestroy).toHaveBeenCalledTimes(1); // 超时卸载释放画布

      // 重开：重建引擎，initial 带回全部笔迹；引擎换实例分支无条件 load
      // （复审①⑥——新引擎 initial 可能陈旧，幂等重载保证引擎=store）
      fireEvent.click(screen.getByRole("button", { name: /草稿纸/ }));
      const second = await waitForEngine(2);
      const initial = (second.opts as { initial?: InkDoc<"atrament"> }).initial;
      expect(initial?.data.strokes.length).toBe(1);
      expect(second.load).toHaveBeenCalledTimes(1);
      const reloaded = second.load.mock.calls[0]?.[0] as
        | InkDoc<"atrament">
        | undefined;
      expect(reloaded?.data.strokes.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("外部播种到达（本地无记录）：引擎 load 载入服务端稿", async () => {
    renderLayer({ initialOpen: true });
    const entry = await waitForEngine();
    // 引擎先以默认空稿挂载；服务端稿到达（head 播种路径）
    await act(async () => {
      await applyServerLoad(
        SESSION_A,
        SCOPE,
        {
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
        },
        null,
      );
    });
    // 挂载登记 load（空稿，复审①）+ 播种到达 load = 2 次；末次为服务端稿
    expect(entry.load).toHaveBeenCalledTimes(2);
    const loaded = entry.load.mock.calls[1]?.[0] as
      | InkDoc<"atrament">
      | undefined;
    expect(loaded?.data.strokes.length ?? 0).toBe(1);
  });
});

describe("NoteLayer：多题隔离", () => {
  it("多题不共用正文：题 A 的笔迹不出现在题 B（键含 questionId）", async () => {
    const utilsA = renderLayer({ questionId: "q-a", initialOpen: true });
    const entryA = await waitForEngine();
    emitStroke(entryA, [
      [1, 1],
      [2, 2],
    ]);
    expect(
      (await getNoteRecord(SESSION_A, { ...SCOPE, questionId: "q-a" }))?.doc.ink
        .strokes.length,
    ).toBe(1);
    expect(
      peekNoteRecord(SESSION_A, { ...SCOPE, questionId: "q-b" }),
    ).toBeNull();
    utilsA.unmount();
  });
});

describe("NoteLayer：纸高（逻辑口径，注记②定案）", () => {
  /** 以固定宽度 600 触发宽度观察（共享桩；scale=0.6；逻辑 800 底=CSS 480） */
  function stubWidth() {
    const stub = makeResizeObserverStub();
    vi.stubGlobal("ResizeObserver", stub.cls);
    return { push: () => act(() => stub.push(600)) };
  }

  it("触底笔迹：逻辑纸高按 paper-geometry 增长并落库，笔迹坐标不变", async () => {
    const ro = stubWidth();
    renderLayer({ initialOpen: true });
    const entry = await waitForEngine();
    ro.push();
    // 逻辑 y=780 距底（800）20 逻辑 ≈ CSS 12px < 72px 触发；步长 240/0.6=400
    emitStroke(entry, [
      [100, 700],
      [100, 780],
    ]);
    const record = await getNoteRecord(SESSION_A, SCOPE);
    expect(record?.doc.paperHeightLogical).toBe(1200);
    // 笔迹逻辑坐标原样（只扩外框，不改已落笔内容）
    const pts = record?.doc.ink.strokes[0]?.points ?? [];
    expect(pts[pts.length - 1]?.y).toBe(780);
  });

  it("远离底部的笔迹不增高（防棘轮：load/普通笔不反复写高度）", async () => {
    const ro = stubWidth();
    renderLayer({ initialOpen: true });
    const entry = await waitForEngine();
    ro.push();
    emitStroke(entry, [
      [10, 10],
      [10, 100],
    ]);
    const record = await getNoteRecord(SESSION_A, SCOPE);
    expect(record?.doc.paperHeightLogical).toBe(800); // 默认高不变
  });

  it("load 事件不写回（load 不触发 dirty/新版本）", async () => {
    renderLayer({ initialOpen: true });
    const entry = await waitForEngine();
    await act(async () => {
      entry.load({
        engine: "atrament",
        version: 1,
        data: {
          width: 1000,
          strokes: [
            stroke([
              [1, 1],
              [2, 2],
            ]),
          ],
        },
        updatedAt: 5,
      });
    });
    // load 经外部同步 effect 发起（store 已是该内容）——不得产生新的写入版本
    const record = await getNoteRecord(SESSION_A, SCOPE);
    expect(record?.pending).toBeNull();
    expect(record?.editedAt).toBe(0);
  });
});

describe("NoteLayer：工具条与操作", () => {
  it("工具可点击：橡皮下发引擎、撤销在可撤销时点击转发", async () => {
    renderLayer({ initialOpen: true });
    await waitForEngine();
    fireEvent.click(screen.getByRole("button", { name: "橡皮" }));
    expect(mockSetTool).toHaveBeenLastCalledWith({ type: "eraser" });
    fireEvent.click(screen.getByRole("button", { name: "笔" }));
    expect(mockSetTool).toHaveBeenLastCalledWith({
      type: "pen",
      color: "black",
      size: "medium",
    });
    const undo = screen.getByRole("button", { name: "撤销" });
    expect(undo).toBeDisabled();
    mockCanUndo = true;
    const entry = await waitForEngine();
    emitStroke(entry, [
      [1, 1],
      [2, 2],
    ]);
    expect(undo).toBeEnabled();
    fireEvent.click(undo);
    expect(mockUndo).toHaveBeenCalledTimes(1);
  });

  it("清空需二次确认；确认后引擎 clear（空稿作为新版本走 store）", async () => {
    renderLayer({ initialOpen: true });
    const entry = await waitForEngine();
    emitStroke(entry, [
      [1, 1],
      [2, 2],
    ]);
    const more = screen.getByRole("button", { name: /更多/ });
    // jsdom 无 PointerEvent：走键盘开单（ArrowDown 打开并把焦点移入菜单）
    fireEvent.keyDown(more, { key: "ArrowDown" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /清空草稿纸/ }),
    );
    expect(mockClear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^清空$/ }));
    expect(mockClear).toHaveBeenCalledTimes(1);
  });

  it("手指书写按钮切换会话偏好（store 与 InkPad 两侧共用）", async () => {
    renderLayer({ initialOpen: true });
    await waitForEngine();
    const toggle = screen.getByRole("button", { name: /手指书写/ });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(getSessionInputPreference()).toBe("finger");
    expect(mockSetInputMode).toHaveBeenCalledWith("finger");
    resetSessionInputPreference();
  });
});

/** 与冲突摘要一致的服务端形态（rev3；notCreated 会与摘要矛盾触发回退守卫） */
function rev3Head(): NoteHeadData {
  const base = headOf().note;
  if (base === null) throw new Error("headOf 夹具缺 note（测试前置失败）");
  return headOf({
    note: {
      ...base,
      revision: 3,
      currentVersionId: "33333333-3333-4333-8333-333333333303",
    },
  });
}

describe("NoteLayer：状态面板（四维）", () => {
  it("书写后可见等待同步；同步成功不再显示", async () => {
    renderLayer({ initialOpen: true });
    const entry = await waitForEngine();
    emitStroke(entry, [
      [1, 1],
      [2, 2],
    ]);
    expect(screen.getByText(/等待同步/)).toBeInTheDocument();
  });

  it("冲突面板：保留本机 → 裁决 + 立即补传", async () => {
    writeNoteDoc(SESSION_A, SCOPE, {
      version: 1,
      ink: {
        width: 1000,
        strokes: [
          stroke([
            [1, 1],
            [2, 2],
          ]),
        ],
      },
    });
    await applyUploadConflict(
      SESSION_A,
      SCOPE,
      {
        noteId: "22222222-2222-4222-8222-222222222222",
        revision: 3,
        versionId: "33333333-3333-4333-8333-333333333303",
        hash: null,
        serverSavedAt: null,
      },
      "服务端已有新版本",
    );
    headsMock.mockImplementation(
      noteHeadsMockResponse({ [SCOPE.questionId]: rev3Head() }),
    );
    renderLayer({ initialOpen: true });
    expect(screen.getByText("草稿内容冲突")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保留本机内容" }));
    await vi.waitFor(() => {
      expect(screen.queryByText("草稿内容冲突")).toBeNull();
    });
    await vi.waitFor(() => expect(putMock).toHaveBeenCalled());
  });

  it("被拒面板（access）：重试同步按钮清终态并补传", async () => {
    writeNoteDoc(SESSION_A, SCOPE, {
      version: 1,
      ink: {
        width: 1000,
        strokes: [
          stroke([
            [1, 1],
            [2, 2],
          ]),
        ],
      },
    });
    await applyUploadDenied(SESSION_A, SCOPE, "access", "已无权限访问该练习");
    headsMock.mockImplementation(
      noteHeadsMockResponse({ [SCOPE.questionId]: rev3Head() }),
    );
    renderLayer({ initialOpen: true });
    expect(screen.getByText("草稿已停止同步")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试同步" }));
    await vi.waitFor(() => {
      expect(screen.queryByText("草稿已停止同步")).toBeNull();
    });
    await vi.waitFor(() => expect(putMock).toHaveBeenCalled());
  });
});

describe("NoteLayer：登记/换引擎窗口与窄窗（T6R.9 复审①⑥⑧）", () => {
  it("播种换背景（line）：引擎按新背景重建并无条件载入服务端稿（登记吞稿窗口已关）", async () => {
    renderLayer({ initialOpen: true });
    await waitForEngine();
    await act(async () => {
      await applyServerLoad(
        SESSION_A,
        SCOPE,
        {
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
          background: "line",
        },
        null,
      );
    });
    // 背景变化触发引擎重建（InkPad 重建键）；新引擎 initial 陈旧——
    // 换实例分支无条件 load 当前稿
    await vi.waitFor(() => {
      if (entries.length < 2) throw new Error("引擎未重建");
    });
    const rebuilt = entries[1];
    if (rebuilt === undefined) throw new Error("重建引擎缺失");
    expect((rebuilt.opts as { background?: string }).background).toBe("line");
    await vi.waitFor(() => {
      expect(rebuilt.load).toHaveBeenCalledTimes(1);
    });
    const loaded = rebuilt.load.mock.calls[0]?.[0] as
      | InkDoc<"atrament">
      | undefined;
    expect(loaded?.data.strokes.length).toBe(1);
  });

  it("手动收起后播种到达不自动重展开（复审⑧）", async () => {
    renderLayer({ initialOpen: true });
    await waitForEngine();
    fireEvent.click(screen.getByRole("button", { name: /收起/ }));
    await act(async () => {
      await applyServerLoad(
        SESSION_A,
        SCOPE,
        {
          version: 1,
          ink: {
            width: 1000,
            strokes: [
              stroke([
                [1, 1],
                [2, 2],
              ]),
            ],
          },
        },
        null,
      );
    });
    // 仍是收起态（标记按钮在场、无工具条），笔数回显
    expect(
      screen.getByRole("button", { name: /草稿纸（已有 1 笔）/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});

describe("NoteLayer：状态面板栈与文案格（T6R.9 复审④⑨）", () => {
  it("本机落盘失败与冲突并存：两面板都可见且裁决按钮可点（不再互相遮蔽）", async () => {
    writeNoteDoc(SESSION_A, SCOPE, {
      version: 1,
      ink: {
        width: 1000,
        strokes: [
          stroke([
            [1, 1],
            [2, 2],
          ]),
        ],
      },
    });
    // 制造落盘失败：后端 set 恒拒（记录已在内存，新写入走故障后端）
    const inner = memoryNoteBackend();
    const failSet: NoteStoreBackend = {
      get: inner.get,
      getAll: inner.getAll,
      set: () => Promise.reject(new Error("QuotaExceededError")),
    };
    installNoteBackend(failSet);
    writeNoteDoc(SESSION_A, SCOPE, {
      version: 1,
      ink: {
        width: 1000,
        strokes: [
          stroke([
            [3, 3],
            [4, 4],
          ]),
        ],
      },
    });
    await applyUploadConflict(
      SESSION_A,
      SCOPE,
      {
        noteId: "22222222-2222-4222-8222-222222222222",
        revision: 3,
        versionId: "33333333-3333-4333-8333-333333333303",
        hash: null,
        serverSavedAt: null,
      },
      "服务端已有新版本",
    );
    headsMock.mockImplementation(
      noteHeadsMockResponse({ [SCOPE.questionId]: rev3Head() }),
    );
    renderLayer({ initialOpen: true });
    await vi.waitFor(() => {
      expect(screen.getByText("草稿内容冲突")).toBeInTheDocument();
    });
    expect(screen.getByText(/本机保存失败/)).toBeInTheDocument(); // 并存可见
    fireEvent.click(screen.getByRole("button", { name: "保留本机内容" }));
    await vi.waitFor(() => {
      expect(screen.queryByText("草稿内容冲突")).toBeNull();
    });
  });

  it("keepCloud 成功链：面板消失 + 引擎载入云端稿", async () => {
    writeNoteDoc(SESSION_A, SCOPE, {
      version: 1,
      ink: {
        width: 1000,
        strokes: [
          stroke([
            [1, 1],
            [2, 2],
          ]),
        ],
      },
    });
    await applyUploadConflict(
      SESSION_A,
      SCOPE,
      {
        noteId: "22222222-2222-4222-8222-222222222222",
        revision: 1,
        versionId: "33333333-3333-4333-8333-333333333301",
        hash: null,
        serverSavedAt: null,
      },
      "服务端已有新版本",
    );
    const cloud = docOf([
      stroke([
        [5, 5],
        [6, 6],
      ]),
      stroke([
        [7, 7],
        [8, 8],
      ]),
    ]);
    docMock.mockResolvedValue(cloud);
    headsMock.mockImplementation(
      noteHeadsMockResponse({ [SCOPE.questionId]: rev3Head() }),
    );
    renderLayer({ initialOpen: true });
    const entry = await waitForEngine();
    fireEvent.click(screen.getByRole("button", { name: "保留服务端内容" }));
    await vi.waitFor(() => {
      expect(screen.queryByText("草稿内容冲突")).toBeNull();
    });
    await vi.waitFor(() => {
      const calls = entry.load.mock.calls;
      const last = calls[calls.length - 1]?.[0] as
        | InkDoc<"atrament">
        | undefined;
      expect(last?.data.strokes.length).toBe(2);
    });
  });

  it("keepCloud 失败：错误文案可见（面板保留可重试）", async () => {
    writeNoteDoc(SESSION_A, SCOPE, {
      version: 1,
      ink: {
        width: 1000,
        strokes: [
          stroke([
            [1, 1],
            [2, 2],
          ]),
        ],
      },
    });
    await applyUploadConflict(
      SESSION_A,
      SCOPE,
      {
        noteId: "22222222-2222-4222-8222-222222222222",
        revision: 1,
        versionId: "33333333-3333-4333-8333-333333333301",
        hash: null,
        serverSavedAt: null,
      },
      "服务端已有新版本",
    );
    docMock.mockRejectedValue(
      new Error("云端草稿正文损坏或版本不兼容：形状错误"),
    );
    headsMock.mockImplementation(
      noteHeadsMockResponse({ [SCOPE.questionId]: rev3Head() }),
    );
    renderLayer({ initialOpen: true });
    fireEvent.click(screen.getByRole("button", { name: "保留服务端内容" }));
    await vi.waitFor(() => {
      expect(screen.getByText(/云端草稿正文损坏/)).toBeInTheDocument();
    });
    expect(screen.getByText("草稿内容冲突")).toBeInTheDocument(); // 面板保留
  });

  it("denied(content) 新内容复活：继续书写后自动重传", async () => {
    vi.useFakeTimers();
    try {
      writeNoteDoc(SESSION_A, SCOPE, {
        version: 1,
        ink: {
          width: 1000,
          strokes: [
            stroke([
              [1, 1],
              [2, 2],
            ]),
          ],
        },
      });
      await applyUploadDenied(SESSION_A, SCOPE, "content", "草稿超出大小预算");
      renderLayer({ initialOpen: true });
      expect(screen.getByText("草稿内容被拒")).toBeInTheDocument();
      const entry = await waitForEngine();
      putMock.mockClear();
      emitStroke(entry, [
        [10, 10],
        [20, 20],
      ]);
      await vi.waitFor(() => {
        expect(screen.queryByText("草稿内容被拒")).toBeNull();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100); // 2s 停笔防抖到期即补传
      });
      await vi.waitFor(() => expect(putMock).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
    }
  });

  it("saving 文案：落盘挂起时显示本机保存中…", async () => {
    const inner = memoryNoteBackend();
    installNoteBackend({
      get: inner.get,
      getAll: inner.getAll,
      set: () => new Promise(() => undefined), // 挂起式：事务不完成
    });
    renderLayer({ initialOpen: true });
    const entry = await waitForEngine();
    emitStroke(entry, [
      [1, 1],
      [2, 2],
    ]);
    expect(screen.getByText(/本机保存中…/)).toBeInTheDocument();
  });

  it("uploading 文案：上传在途显示同步中…（假时钟）", async () => {
    vi.useFakeTimers();
    try {
      let releasePut: (() => void) | null = null;
      putMock.mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            releasePut = () =>
              resolve({
                noteId: "22222222-2222-4222-8222-222222222222",
                revision: 1,
                versionId: "33333333-3333-4333-8333-333333333301",
                hash: "a".repeat(64),
                savedAt: "2026-10-06T00:00:00.000Z",
              });
          }),
      );
      renderLayer({ initialOpen: true });
      const entry = await waitForEngine();
      emitStroke(entry, [
        [1, 1],
        [2, 2],
      ]);
      expect(screen.getByText(/等待同步/)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      expect(screen.getByText(/同步中…/)).toBeInTheDocument();
      // 闭包内赋值不参与收窄：显式拓宽后调用
      (releasePut as (() => void) | null)?.();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await vi.waitFor(() => {
        expect(screen.queryByText(/同步中…/)).toBeNull();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("空稿（0 笔）synced 不显示图片提示；有笔后显示（复审⑨定案）", async () => {
    vi.useFakeTimers();
    try {
      headsMock.mockImplementation(
        noteHeadsMockResponse({ [SCOPE.questionId]: headOf() }),
      );
      docMock.mockResolvedValue(docOf([]));
      renderLayer({ initialOpen: true });
      await vi.waitFor(() => {
        expect(screen.queryByText(/图片待生成/)).toBeNull(); // 空稿不提示
      });
      const entry = await waitForEngine();
      emitStroke(entry, [
        [1, 1],
        [2, 2],
      ]);
      expect(screen.queryByText(/图片待生成/)).toBeNull(); // dirty 期不显示
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100); // 防抖到期上传→回执→synced
      });
      await vi.waitFor(() => {
        expect(screen.getByText(/图片待生成/)).toBeInTheDocument(); // 回执后如实显示
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
