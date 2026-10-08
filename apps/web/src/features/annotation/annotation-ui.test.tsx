import type { AnnotationBaseRef, AnnotationDoc, AnnotationViewData } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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

import { AnnotationLayer } from "./AnnotationLayer";
import { AnnotationView } from "./AnnotationView";
import {
  ApiError,
  fetchAnnotationViewApi,
  postAnnotationBaseApi,
  postAnnotationBaseImageApi,
  saveBlobAs,
} from "@/lib/api";
import { renderAnnotationBaseImage } from "./base-image";
import { exportAnnotationComposite } from "./annotation-composite";
import {
  installAnnotationBackend,
  memoryAnnotationBackend,
  resetAnnotationStoreForTest,
} from "./annotation-store";
import { bindAnnotationSession, resetAnnotationSession } from "./annotation-sync";

const viewMock = vi.mocked(fetchAnnotationViewApi);
const baseMock = vi.mocked(postAnnotationBaseApi);
const baseImageMock = vi.mocked(postAnnotationBaseImageApi);
const renderMock = vi.mocked(renderAnnotationBaseImage);
const compositeMock = vi.mocked(exportAnnotationComposite);

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
  vi.mocked(saveBlobAs).mockReset();
});

afterEach(() => {
  resetAnnotationSession();
  getContextSpy.mockRestore();
});

import { afterEach } from "vitest";

describe("AnnotationLayer：两阶段底图流", () => {
  it("视图已有 ready 底图 → 直接挂工作区（底图 img 在场），不再生成", async () => {
    viewMock.mockResolvedValue(
      emptyView({ ...READY_BASE, downloadUrl: "/api/student/attempts/a1/annotation-base/b1/image.png" }),
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
    render(<AnnotationLayer attemptId="a1" questionId="q1" ariaPrefix="第 1 题" />);
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

describe("AnnotationView：回看状态", () => {
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

  it("stale=true → 「旧版本题干的标注」横幅", async () => {
    viewMock.mockResolvedValue(sealedView({ doc: DOC, stale: true }));
    render(
      <AnnotationView viewer="student" attemptId="a1" questionId="q1" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /题干标注/ }));
    await waitFor(() =>
      expect(screen.getByText(/旧版本题干的标注/)).toBeInTheDocument(),
    );
  });

  it("sealed → 「已随交卷固定」说明（只读语义）", async () => {
    viewMock.mockResolvedValue(sealedView({ doc: DOC }));
    render(
      <AnnotationView viewer="student" attemptId="a1" questionId="q1" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /题干标注/ }));
    await waitFor(() =>
      expect(screen.getByText(/已随交卷固定/)).toBeInTheDocument(),
    );
  });

  it("空态（无 doc 无 base）→「未使用题干标注」", async () => {
    viewMock.mockResolvedValue(sealedView({ base: null }));
    render(
      <AnnotationView viewer="student" attemptId="a1" questionId="q1" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /题干标注/ }));
    await waitFor(() =>
      expect(screen.getByText(/未使用题干标注/)).toBeInTheDocument(),
    );
  });

  it("底图缺失（有笔无底图）→「底图缺失」态且不渲染导出按钮", async () => {
    viewMock.mockResolvedValue(
      sealedView({ doc: DOC, base: { ...READY_BASE, state: "pending", pixelWidth: null, pixelHeight: null } }),
    );
    render(
      <AnnotationView viewer="student" attemptId="a1" questionId="q1" />,
    );
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
    render(
      <AnnotationView viewer="student" attemptId="a1" questionId="q1" />,
    );
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
