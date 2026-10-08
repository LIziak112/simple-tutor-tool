import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AnnotationBaseRef,
  AnnotationDoc,
  AnnotationViewData,
} from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T6R.20 标注 UI 层测试（合成图本体见 annotation-composite.test.ts）：
 * - AnnotationLayer：两阶段底图流（ready 直接挂工作区；too-tall 显式禁用
 *   「草稿照用」文案、不挂画布；瞬时失败可重试）；
 * - AnnotationView：stale「旧版本题干的标注」、sealed 固定说明、空态、
 *   底图缺失拒绝导出、导出成功/失败文案。
 */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
function fakePngBlob(bytes = 128): Blob {
  const arr = new Uint8Array(bytes);
  arr.set(PNG_MAGIC, 0);
  for (let i = 8; i < bytes; i += 1) arr[i] = (i * 31) & 0xff;
  return new Blob([arr], { type: "image/png" });
}

const READY_BASE: AnnotationBaseRef = {
  baseId: "11111111-1111-4111-8111-111111111111",
  state: "ready",
  stale: false,
  pixelWidth: 1440,
  pixelHeight: 900,
  downloadUrl: "/api/student/attempts/a1/annotation-base/b1/image.png",
};

const DOC: AnnotationDoc = {
  version: 1,
  baseWidth: 1440,
  baseHeight: 900,
  strokes: [
    {
      tool: "pen",
      color: "#dc2626",
      weight: 5.76,
      points: [
        { x: 100, y: 100, p: 0.5, t: 0 },
        { x: 200, y: 140, p: 0.5, t: 40 },
      ],
    },
  ],
};

// ---------- AnnotationLayer / AnnotationView（API mock） ----------

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAnnotationViewApi: vi.fn(),
    postAnnotationBaseApi: vi.fn(),
    postAnnotationBaseImageApi: vi.fn(),
    fetchTeacherAnnotationViewApi: vi.fn(),
    saveBlobAs: vi.fn(),
    putAnnotationDocApi: vi.fn(),
    sealAttemptAnnotationsApi: vi.fn(async () => ({
      phase: "correction" as const,
      sealedCount: 1,
    })),
  };
});

vi.mock("./base-image", async (importActual) => ({
  ...(await importActual<typeof import("./base-image")>()),
  renderAnnotationBaseImage: vi.fn(),
}));

vi.mock("./annotation-composite", async (importActual) => ({
  ...(await importActual<typeof import("./annotation-composite")>()),
  exportAnnotationComposite: vi.fn(),
}));

// 审查修复 1（P0 回放比例）：替换 atrament 程序化实例为坐标记录桩——
// 断言静态笔迹层传给 atrament 的 CSS 坐标已按「显示宽/位图宽」换算。
// 形状与 atrament 程序化接口兼容（color/weight 可写、draw 返回已处理坐标），
// AnnotationWorkspace 的挂载路径同样可用。vi.hoisted：mock 工厂先于模块
// 顶层求值，类定义须随之提升。
const { FakeAtrament } = vi.hoisted(() => {
  class FakeAtrament {
    color = "";
    weight = 0;
    readonly begins: Array<[number, number]> = [];
    readonly draws: Array<[number, number]> = [];
    beginStroke(x: number, y: number): void {
      this.begins.push([x, y]);
    }
    draw(x: number, y: number): { x: number; y: number } {
      this.draws.push([x, y]);
      return { x, y };
    }
    endStroke(_x: number, _y: number): void {}
    destroy(): void {}
  }
  return { FakeAtrament };
});

vi.mock("@/features/ink/engine/atrament-adapter.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/ink/engine/atrament-adapter.ts")
  >()),
  createProgrammaticAtrament: vi.fn(() => new FakeAtrament()),
}));

import {
  ApiError,
  fetchAnnotationViewApi,
  postAnnotationBaseApi,
  postAnnotationBaseImageApi,
  putAnnotationDocApi,
  saveBlobAs,
  sealAttemptAnnotationsApi,
} from "@/lib/api";
import { AnnotationLayer } from "./AnnotationLayer";
import { AnnotationView } from "./AnnotationView";
import { exportAnnotationComposite } from "./annotation-composite";
import { createProgrammaticAtrament } from "@/features/ink/engine/atrament-adapter.ts";
import {
  installAnnotationBackend,
  memoryAnnotationBackend,
  resetAnnotationStoreForTest,
  settleAnnotationPersistence,
  writeAnnotationDoc,
} from "./annotation-store";
import {
  bindAnnotationSession,
  resetAnnotationSession,
} from "./annotation-sync";
import { renderAnnotationBaseImage } from "./base-image";

const viewMock = vi.mocked(fetchAnnotationViewApi);
const baseMock = vi.mocked(postAnnotationBaseApi);
const baseImageMock = vi.mocked(postAnnotationBaseImageApi);
const renderMock = vi.mocked(renderAnnotationBaseImage);
const compositeMock = vi.mocked(exportAnnotationComposite);
const putDocMock = vi.mocked(putAnnotationDocApi);
const sealMock = vi.mocked(sealAttemptAnnotationsApi);

const SESSION = { origin: "https://t.example", studentId: "s-1" };

function emptyView(base: AnnotationBaseRef | null): AnnotationViewData {
  return { base, maxWidthPx: 1440, doc: null, annotation: null };
}

/** canvas 2d 上下文桩（工作区挂载 annotation-surface 需要；no-op 绘制） */
class StubContext {
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 1;
  lineCap = "";
  lineJoin = "";
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  beginPath(): void {}
  moveTo(): void {}
  quadraticCurveTo(): void {}
  closePath(): void {}
  stroke(): void {}
  fillRect(): void {}
  clearRect(): void {}
  save(): void {}
  restore(): void {}
  setTransform(): void {}
}

let getContextSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(
      () => new StubContext() as unknown as CanvasRenderingContext2D,
    );
  installAnnotationBackend(memoryAnnotationBackend());
  resetAnnotationStoreForTest();
  resetAnnotationSession();
  bindAnnotationSession(SESSION);
  viewMock.mockReset();
  baseMock.mockReset();
  baseImageMock.mockReset();
  renderMock.mockReset();
  compositeMock.mockReset();
  putDocMock.mockReset();
  sealMock.mockReset();
  sealMock.mockResolvedValue({ phase: "correction", sealedCount: 1 });
  vi.mocked(saveBlobAs).mockReset();
  vi.mocked(createProgrammaticAtrament).mockClear();
});

afterEach(() => {
  resetAnnotationSession();
  getContextSpy.mockRestore();
});

import { afterEach } from "vitest";

describe("AnnotationLayer：两阶段底图流", () => {
  it("视图已有 ready 底图 → 直接挂工作区（底图 img 在场），不再生成", async () => {
    viewMock.mockResolvedValue(
      emptyView({
        ...READY_BASE,
        downloadUrl: "/api/student/attempts/a1/annotation-base/b1/image.png",
      }),
    );
    render(
      <AnnotationLayer attemptId="a1" questionId="q1" ariaPrefix="第 1 题" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /圈画题干/ }));
    await waitFor(() =>
      expect(screen.getByAltText("第 1 题题干标注底图")).toBeInTheDocument(),
    );
    expect(baseMock).not.toHaveBeenCalled();
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("无底图 → POST base → 栅格化 → 回传 → 挂工作区（两阶段完整流）", async () => {
    viewMock.mockResolvedValue(emptyView(null));
    baseMock.mockResolvedValue({
      base: {
        baseId: "11111111-1111-4111-8111-111111111111",
        state: "pending",
        stale: false,
        pixelWidth: null,
        pixelHeight: null,
      },
      baseRenderVersion: 1,
      maxWidthPx: 1440,
      questionRevisionId: "22222222-2222-4222-8222-222222222222",
      questionNo: 1,
      questionMd: "题面",
      mediaSrcs: [],
      graphFigures: [],
      interactionNotes: [],
    });
    renderMock.mockResolvedValue({
      ok: true,
      blob: fakePngBlob(),
      pixelWidth: 1440,
      pixelHeight: 900,
    });
    baseImageMock.mockResolvedValue({
      baseId: "11111111-1111-4111-8111-111111111111",
      state: "ready",
      imageHash: "a".repeat(64),
      pixelWidth: 1440,
      pixelHeight: 900,
      updatedAt: "2026-10-08T00:00:00Z",
    });
    render(
      <AnnotationLayer attemptId="a1" questionId="q1" ariaPrefix="第 1 题" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /圈画题干/ }));
    await waitFor(() =>
      expect(screen.getByAltText("第 1 题题干标注底图")).toBeInTheDocument(),
    );
    expect(baseImageMock).toHaveBeenCalledTimes(1);
    // 回传身份：questionRevisionId + baseRenderVersion（服务端比对要素）
    expect(baseImageMock.mock.calls[0]?.[2]).toBeInstanceOf(Blob);
    expect(baseImageMock.mock.calls[0]?.[3].questionRevisionId).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(baseImageMock.mock.calls[0]?.[3].baseRenderVersion).toBe(1);
  });

  it("超高题（too-tall）→ 显式禁用：「禁用标注＋草稿照用」文案，不挂画布", async () => {
    viewMock.mockResolvedValue(emptyView(null));
    baseMock.mockResolvedValue({
      base: {
        baseId: "11111111-1111-4111-8111-111111111111",
        state: "pending",
        stale: false,
        pixelWidth: null,
        pixelHeight: null,
      },
      baseRenderVersion: 1,
      maxWidthPx: 1440,
      questionRevisionId: "22222222-2222-4222-8222-222222222222",
      questionNo: 1,
      questionMd: "题面",
      mediaSrcs: [],
      graphFigures: [],
      interactionNotes: [],
    });
    renderMock.mockResolvedValue({
      ok: false,
      error: {
        kind: "too-tall",
        message:
          "该题题干过长，无法生成标注底图——本题已禁用题干标注，草稿纸不受影响，可照常使用",
      },
    });
    render(<AnnotationLayer attemptId="a1" questionId="q1" />);
    fireEvent.click(screen.getByRole("button", { name: /圈画题干/ }));
    await waitFor(() =>
      expect(screen.getByText(/已禁用题干标注/)).toBeInTheDocument(),
    );
    expect(screen.queryByAltText("本题题干标注底图")).not.toBeInTheDocument();
    expect(baseImageMock).not.toHaveBeenCalled();
  });

  it("装配哨兵（EXPORT_ASSEMBLY_BROKEN 500）→ 禁用文案（草稿照用）", async () => {
    viewMock.mockRejectedValue(
      new ApiError(
        "EXPORT_ASSEMBLY_BROKEN",
        "题面装配失败：题干含答案标记",
        500,
      ),
    );
    render(<AnnotationLayer attemptId="a1" questionId="q1" />);
    fireEvent.click(screen.getByRole("button", { name: /圈画题干/ }));
    await waitFor(() =>
      expect(screen.getByText(/已禁用题干标注/)).toBeInTheDocument(),
    );
  });

  it("瞬时栅格化失败 → 错误 + 重试按钮（重跑两阶段流）", async () => {
    viewMock.mockResolvedValue(emptyView(null));
    baseMock.mockResolvedValue({
      base: {
        baseId: "11111111-1111-4111-8111-111111111111",
        state: "pending",
        stale: false,
        pixelWidth: null,
        pixelHeight: null,
      },
      baseRenderVersion: 1,
      maxWidthPx: 1440,
      questionRevisionId: "22222222-2222-4222-8222-222222222222",
      questionNo: 1,
      questionMd: "题面",
      mediaSrcs: [],
      graphFigures: [],
      interactionNotes: [],
    });
    renderMock
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "font", message: "本地字体嵌入失败" },
      })
      .mockResolvedValueOnce({
        ok: true,
        blob: fakePngBlob(),
        pixelWidth: 1440,
        pixelHeight: 900,
      });
    baseImageMock.mockResolvedValue({
      baseId: "11111111-1111-4111-8111-111111111111",
      state: "ready",
      imageHash: "a".repeat(64),
      pixelWidth: 1440,
      pixelHeight: 900,
      updatedAt: "2026-10-08T00:00:00Z",
    });
    render(<AnnotationLayer attemptId="a1" questionId="q1" />);
    fireEvent.click(screen.getByRole("button", { name: /圈画题干/ }));
    await waitFor(() =>
      expect(screen.getByText(/底图生成失败/)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(screen.getByAltText("本题题干标注底图")).toBeInTheDocument(),
    );
  });
});

/** 回看视图夹具（AnnotationView 与静态画布两组 describe 共用） */
function sealedView(
  o: {
    base?: AnnotationBaseRef | null;
    doc?: AnnotationDoc | null;
    stale?: boolean;
  } = {},
): AnnotationViewData {
  const doc = o.doc === undefined ? null : o.doc;
  const rawBase = o.base === undefined ? READY_BASE : o.base;
  const base =
    rawBase === null ? null : o.stale ? { ...rawBase, stale: true } : rawBase;
  return {
    base,
    maxWidthPx: 1440,
    doc,
    annotation:
      doc === null
        ? null
        : {
            annotationId: "33333333-3333-4333-8333-333333333333",
            revision: 2,
            hash: "b".repeat(64),
            savedAt: "2026-10-08T00:00:00Z",
            sealedAt: "2026-10-08T01:00:00Z",
            strokeCount: doc.strokes.length,
            pointCount: 4,
          },
  };
}

describe("AnnotationView：回看状态", () => {
  it("stale=true → 「旧版本题干的标注」横幅", async () => {
    viewMock.mockResolvedValue(sealedView({ doc: DOC, stale: true }));
    render(<AnnotationView viewer="student" attemptId="a1" questionId="q1" />);
    fireEvent.click(screen.getByRole("button", { name: /题干标注/ }));
    await waitFor(() =>
      expect(screen.getByText(/旧版本题干的标注/)).toBeInTheDocument(),
    );
  });

  it("sealed → 「已随交卷固定」说明（只读语义）", async () => {
    viewMock.mockResolvedValue(sealedView({ doc: DOC }));
    render(<AnnotationView viewer="student" attemptId="a1" questionId="q1" />);
    fireEvent.click(screen.getByRole("button", { name: /题干标注/ }));
    await waitFor(() =>
      expect(screen.getByText(/已随交卷固定/)).toBeInTheDocument(),
    );
  });

  it("空态（无 doc 无 base）→「未使用题干标注」", async () => {
    viewMock.mockResolvedValue(sealedView({ base: null }));
    render(<AnnotationView viewer="student" attemptId="a1" questionId="q1" />);
    fireEvent.click(screen.getByRole("button", { name: /题干标注/ }));
    await waitFor(() =>
      expect(screen.getByText(/未使用题干标注/)).toBeInTheDocument(),
    );
  });

  it("底图缺失（有笔无底图）→「底图缺失」态且不渲染导出按钮", async () => {
    viewMock.mockResolvedValue(
      sealedView({
        doc: DOC,
        base: {
          ...READY_BASE,
          state: "pending",
          pixelWidth: null,
          pixelHeight: null,
        },
      }),
    );
    render(<AnnotationView viewer="student" attemptId="a1" questionId="q1" />);
    fireEvent.click(screen.getByRole("button", { name: /题干标注/ }));
    await waitFor(() =>
      expect(screen.getByText(/底图缺失/)).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /导出合成图/ }),
    ).not.toBeInTheDocument();
  });

  it("正常态：底图+静态笔迹层在场；导出成功显示已导出（saveBlobAs 单次）", async () => {
    viewMock.mockResolvedValue(sealedView({ doc: DOC }));
    compositeMock.mockResolvedValue({ ok: true, blob: fakePngBlob() });
    render(
      <AnnotationView
        viewer="student"
        attemptId="a1"
        questionId="q1"
        questionNo={3}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /题干标注/ }));
    await waitFor(() =>
      expect(screen.getByAltText("本题题干标注底图")).toBeInTheDocument(),
    );
    expect(
      document.querySelector('canvas[data-slot="annotation-static-canvas"]'),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /导出合成图/ }));
    await waitFor(() =>
      expect(screen.getByText(/已导出合成图/)).toBeInTheDocument(),
    );
    expect(vi.mocked(saveBlobAs)).toHaveBeenCalledWith(
      expect.any(Blob),
      "annotation-q3-scratch.png",
    );
  });

  it("导出失败（底图缺失分类）→ 错误文案、零下载", async () => {
    viewMock.mockResolvedValue(sealedView({ doc: DOC }));
    compositeMock.mockResolvedValue({
      ok: false,
      error: { kind: "base-missing", message: "底图加载失败——文件可能已缺失" },
    });
    render(<AnnotationView viewer="student" attemptId="a1" questionId="q1" />);
    fireEvent.click(screen.getByRole("button", { name: /题干标注/ }));
    await waitFor(() =>
      expect(screen.getByAltText("本题题干标注底图")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /导出合成图/ }));
    await waitFor(() =>
      expect(screen.getByText(/底图加载失败/)).toBeInTheDocument(),
    );
    expect(vi.mocked(saveBlobAs)).not.toHaveBeenCalled();
  });
});

describe("AnnotationStaticCanvas：回放坐标比例（审查修复 P0-1）", () => {
  /** 720 CSS 显示宽 / 1440 位图宽 → cssPerBase=0.5（≠1 才能暴露比例缺陷） */
  const rectSpy = (): ReturnType<typeof vi.spyOn> =>
    vi
      .spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 720,
        bottom: 450,
        width: 720,
        height: 450,
        toJSON: () => ({}),
      } as DOMRect);

  const atramentMock = vi.mocked(createProgrammaticAtrament);

  function lastAtrament(): InstanceType<typeof FakeAtrament> {
    const result = atramentMock.mock.results.at(-1);
    if (result === undefined || result.type !== "return") {
      throw new Error("尚未创建 atrament 实例");
    }
    // mock.results 按 mock 后的真实签名定型为 Atrament——此处经 unknown 落回
    // 记录桩形态（vi.mock 工厂里替换的实现）
    return result.value as unknown as InstanceType<typeof FakeAtrament>;
  }

  it("底图 img 未加载（布局未就绪）不重放——无 NaN 坐标", async () => {
    const spy = rectSpy();
    viewMock.mockResolvedValue(sealedView({ doc: DOC }));
    render(<AnnotationView viewer="student" attemptId="a1" questionId="q1" />);
    fireEvent.click(screen.getByRole("button", { name: /题干标注/ }));
    await waitFor(() =>
      expect(screen.getByAltText("本题题干标注底图")).toBeInTheDocument(),
    );
    // img 未触发 load：布局未就绪门控——静态画布连 atrament 都不创建
    // （杜绝 offsetHeight=0 产 Infinity/NaN 坐标的重放）
    expect(atramentMock.mock.results.length).toBe(0);
    spy.mockRestore();
  });

  it("CSS 显示宽 ≠ 位图宽时按 rect.width/baseWidth 换算（atrament 收到 CSS 坐标）", async () => {
    const spy = rectSpy();
    viewMock.mockResolvedValue(sealedView({ doc: DOC }));
    render(<AnnotationView viewer="student" attemptId="a1" questionId="q1" />);
    fireEvent.click(screen.getByRole("button", { name: /题干标注/ }));
    const img = await screen.findByAltText("本题题干标注底图");
    fireEvent.load(img);
    await waitFor(() => {
      expect(lastAtrament().begins.length).toBeGreaterThan(0);
    });
    const atrament = lastAtrament();
    // DOC 笔迹（底图像素域）：(100,100) → (200,140)；cssPerBase=720/1440=0.5
    expect(atrament.begins[0]?.[0]).toBeCloseTo(50);
    expect(atrament.begins[0]?.[1]).toBeCloseTo(50);
    expect(atrament.draws.some(([x, y]) => Math.abs(x - 100) < 0.01 && Math.abs(y - 70) < 0.01)).toBe(
      true,
    );
    // 线宽同比例（5.76 × 0.5 = 2.88）
    expect(atrament.weight).toBeCloseTo(2.88);
    spy.mockRestore();
  });

  it("导出状态刷新不触发重放（依赖收窄——同一 doc 只重放一次）", async () => {
    const spy = rectSpy();
    viewMock.mockResolvedValue(sealedView({ doc: DOC }));
    compositeMock.mockResolvedValue({ ok: true, blob: fakePngBlob() });
    render(
      <AnnotationView
        viewer="student"
        attemptId="a1"
        questionId="q1"
        questionNo={3}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /题干标注/ }));
    const img = await screen.findByAltText("本题题干标注底图");
    fireEvent.load(img);
    await waitFor(() => {
      expect(lastAtrament().begins.length).toBeGreaterThan(0);
    });
    const replayCount = atramentMock.mock.results.length;
    // 触发一次导出状态刷新（exporting → 结果文案两次重渲染）
    fireEvent.click(screen.getByRole("button", { name: /导出合成图/ }));
    await waitFor(() =>
      expect(screen.getByText(/已导出合成图/)).toBeInTheDocument(),
    );
    expect(atramentMock.mock.results.length).toBe(replayCount);
    spy.mockRestore();
  });
});

// ---------- 审查修复 3①：订正标注保存检查点（seal correction） ----------

describe("AnnotationLayer：保存订正标注检查点（审查修复 3①）", () => {
  /** ready 底图且未封存的视图（correction 编辑形态的 ensureBase ①产物） */
  function openCorrectionView(): void {
    viewMock.mockResolvedValue({
      base: READY_BASE,
      maxWidthPx: 1440,
      doc: null,
      annotation: null,
    });
  }

  it("correction 编辑形态提供「保存订正标注」；scratch 形态不提供", async () => {
    openCorrectionView();
    const { unmount } = render(
      <AnnotationLayer attemptId="a1" questionId="q1" phase="correction" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /圈画题干/ }));
    expect(
      await screen.findByRole("button", { name: "保存订正标注" }),
    ).toBeInTheDocument();
    unmount();

    openCorrectionView();
    render(<AnnotationLayer attemptId="a1" questionId="q1" />);
    fireEvent.click(screen.getByRole("button", { name: /圈画题干/ }));
    await waitFor(() =>
      expect(screen.getByAltText("本题题干标注底图")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "保存订正标注" }),
    ).not.toBeInTheDocument();
  });

  it("确认保存：追平后 seal(attemptId,'correction') → 固定态「已随订正保存固定」", async () => {
    // 第一次拉取（ensureBase ①）：ready 底图未封存；后续（保存后的固定态
    // AnnotationView）：sealed correction 视图
    viewMock
      .mockResolvedValueOnce({
        base: READY_BASE,
        maxWidthPx: 1440,
        doc: null,
        annotation: null,
      })
      .mockResolvedValue(sealedView({ doc: DOC }));
    // 本地已有一笔待传订正标注（seal 前追平：PUT 回执落地 → 无 pending）
    putDocMock.mockResolvedValue({
      annotationId: "00000000-0000-4000-8000-000000000001",
      revision: 1,
      hash: "a".repeat(64),
      savedAt: "2026-10-08T00:00:00Z",
    });
    writeAnnotationDoc(
      SESSION,
      { attemptId: "a1", questionId: "q1", phase: "correction" },
      DOC,
    );
    await settleAnnotationPersistence();
    render(
      <AnnotationLayer attemptId="a1" questionId="q1" phase="correction" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /圈画题干/ }));
    await waitFor(() =>
      expect(screen.getByAltText("本题题干标注底图")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存订正标注" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认保存" }));
    await waitFor(() =>
      expect(sealMock).toHaveBeenCalledWith("a1", "correction"),
    );
    // 追平先于 seal（catchUp → PUT 回执落地后才封存）
    expect(putDocMock).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText(/已随订正保存固定/)).toBeInTheDocument(),
    );
    // 固定态：不挂编辑工作区
    expect(document.querySelector('[data-slot="annotation-workspace"]')).toBeNull();
  });

  it("无内容确认保存 → 检查点拒绝（还没有订正标注内容）", async () => {
    openCorrectionView();
    render(
      <AnnotationLayer attemptId="a1" questionId="q1" phase="correction" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /圈画题干/ }));
    await waitFor(() =>
      expect(screen.getByAltText("本题题干标注底图")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存订正标注" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认保存" }));
    await waitFor(() =>
      expect(screen.getByText(/还没有订正标注内容/)).toBeInTheDocument(),
    );
    expect(sealMock).not.toHaveBeenCalled();
  });

  it("视图已封存（sealedAt 非空）→ 展开即固定态，不挂编辑器（重开页面恢复）", async () => {
    viewMock.mockResolvedValue(sealedView({ doc: DOC }));
    render(
      <AnnotationLayer attemptId="a1" questionId="q1" phase="correction" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /圈画题干/ }));
    await waitFor(() =>
      expect(screen.getByText(/已随订正保存固定/)).toBeInTheDocument(),
    );
    expect(document.querySelector('[data-slot="annotation-workspace"]')).toBeNull();
    expect(baseMock).not.toHaveBeenCalled();
  });
});
