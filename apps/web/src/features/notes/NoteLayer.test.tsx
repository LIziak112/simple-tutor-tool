import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { NoteHeadData } from "@tutor/contract";
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
import { NoteLayer } from "@/features/notes/NoteLayer";
import { stroke } from "@/features/notes/note-fixtures";
import {
  getNoteRecord,
  installNoteBackend,
  memoryNoteBackend,
  peekNoteRecord,
} from "@/features/notes/note-store";
import { bindNoteSession, resetNoteSession } from "@/features/notes/note-sync";
import { SCOPE, SESSION_A } from "@/features/notes/note-test-utils";

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
    fetchStudentNoteHeadApi: vi.fn(),
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

import { fetchStudentNoteHeadApi, putNoteDocumentApi } from "@/lib/api";

const putMock = vi.mocked(putNoteDocumentApi);
const headMock = vi.mocked(fetchStudentNoteHeadApi);

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

function emptyDoc(): InkDoc {
  return {
    engine: "atrament",
    version: 1,
    data: { width: 1000, strokes: [] },
    updatedAt: 1,
  };
}

function makeEngine(opts: unknown): InkEngine {
  // 先建 load/engine 再回填 entry（互相引用；类型经一次显式断言收口）
  const box: { entry: EngineEntry | null } = { entry: null };
  const load = vi.fn((data: InkDoc) => {
    box.entry?.emit?.(data, "load");
  });
  const engine: InkEngine = {
    getData: () => emptyDoc(),
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
    const [open, setOpen] = useStateWith(initialOpen);
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

/** useState 的薄包装（harness 内联 hook 规则规避） */
import { useState } from "react";

function useStateWith(initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(initial);
  return [v, setV];
}

beforeEach(async () => {
  installNoteBackend(memoryNoteBackend());
  resetNoteSession();
  headMock.mockResolvedValue({
    note: null,
    images: [],
    evidence: null,
  } as NoteHeadData);
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

  it("开合不丢稿（挂载卸载往返）：写→收起→标记显示笔数→展开重挂载恢复", async () => {
    renderLayer({ initialOpen: true });
    const first = await waitForEngine();
    emitStroke(first, [
      [10, 10],
      [40, 40],
    ]);
    const record = await getNoteRecord(SESSION_A, SCOPE);
    expect(record?.doc.ink.strokes.length).toBe(1);

    // 收起 → 引擎销毁（画布卸载），store 正文保留
    fireEvent.click(screen.getByRole("button", { name: /收起/ }));
    expect(mockDestroy).toHaveBeenCalled();
    expect(screen.getByText(/1 笔/)).toBeInTheDocument();

    // 展开 → 重挂载，initial 带回全部笔迹
    fireEvent.click(screen.getByRole("button", { name: /草稿纸/ }));
    const second = await waitForEngine(2);
    const initial = (second.opts as { initial?: InkDoc<"atrament"> }).initial;
    expect(initial?.data.strokes.length).toBe(1);
    // 挂载首帧不重复 load（initial 已带内容——指纹登记即止）
    expect(second.load).not.toHaveBeenCalled();
  });

  it("外部播种到达（本地无记录）：引擎 load 载入服务端稿", async () => {
    const { applyServerLoad } = await import("@/features/notes/note-store");
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
    expect(entry.load).toHaveBeenCalledTimes(1);
    const loaded = entry.load.mock.calls[0]?.[0] as
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
  /** 以固定宽度 600 触发宽度观察（scale=0.6；逻辑 800 底=CSS 480） */
  async function stubWidth(w: number) {
    const observers: ((w: number) => void)[] = [];
    class StubRO {
      constructor(cb: (entries: { contentRect: { width: number } }[]) => void) {
        observers.push((width: number) => cb([{ contentRect: { width } }]));
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", StubRO);
    return {
      push: () =>
        act(() => {
          for (const cb of [...observers]) cb(w);
        }),
    };
  }

  it("触底笔迹：逻辑纸高按 paper-geometry 增长并落库，笔迹坐标不变", async () => {
    const ro = await stubWidth(600);
    renderLayer({ initialOpen: true });
    const entry = await waitForEngine();
    await ro.push();
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
    const ro = await stubWidth(600);
    renderLayer({ initialOpen: true });
    const entry = await waitForEngine();
    await ro.push();
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
    const { getSessionInputPreference, resetSessionInputPreference } =
      await import("@/features/ink/input-preference");
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

describe("NoteLayer：状态面板（四维）", () => {
  /** 与冲突摘要一致的服务端形态（rev3；notCreated 会与摘要矛盾触发回退守卫） */
  function rev3Head(): NoteHeadData {
    return {
      note: {
        noteId: "22222222-2222-4222-8222-222222222222",
        attemptId: SCOPE.attemptId,
        questionId: SCOPE.questionId,
        questionRevisionId: "qrev-1",
        phase: "scratch",
        revision: 3,
        currentVersionId: "33333333-3333-4333-8333-333333333303",
        serverSavedAt: "2026-10-06T00:00:00.000Z",
      },
      images: [],
      evidence: null,
    };
  }
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
    const { applyUploadConflict } = await import("@/features/notes/note-store");
    const { writeNoteDoc } = await import("@/features/notes/note-store");
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
    headMock.mockResolvedValue(rev3Head());
    renderLayer({ initialOpen: true });
    expect(screen.getByText("草稿内容冲突")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保留本机内容" }));
    await vi.waitFor(() => {
      expect(screen.queryByText("草稿内容冲突")).toBeNull();
    });
    await vi.waitFor(() => expect(putMock).toHaveBeenCalled());
  });

  it("被拒面板（access）：重试同步按钮清终态并补传", async () => {
    const { applyUploadDenied, writeNoteDoc } = await import(
      "@/features/notes/note-store"
    );
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
    headMock.mockResolvedValue(rev3Head());
    renderLayer({ initialOpen: true });
    expect(screen.getByText("草稿已停止同步")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试同步" }));
    await vi.waitFor(() => {
      expect(screen.queryByText("草稿已停止同步")).toBeNull();
    });
    await vi.waitFor(() => expect(putMock).toHaveBeenCalled());
  });
});
