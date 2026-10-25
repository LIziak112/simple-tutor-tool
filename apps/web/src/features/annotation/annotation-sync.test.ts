import { gunzipSync } from "node:zlib";
import type {
  AnnotationBasePreviewData,
  AnnotationBaseRef,
  AnnotationReceipt,
  AnnotationSurfaceLayout,
} from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AnnotationScope,
  type AnnotationSessionRef,
  applyAnnotationConflict,
  getAnnotationRecord,
  installAnnotationBackend,
  memoryAnnotationBackend,
  peekAnnotationRecord,
  resetAnnotationStoreForTest,
  writeAnnotationDoc,
  writeLocalAnnotationBase,
} from "./annotation-store";

/**
 * 标注同步队列（T6R.20）测试：2s 防抖+10s 最大等待、退避与幂等重试（同
 * mutationId 重放）、409 冲突（有摘要对齐/无摘要重铸）与「以本机为准」、
 * SEALED/ALREADY_SUBMITTED/403 终态、413 内容拒、重进补传、切账号隔离与
 * 中止、交卷 flush 顺序。putAnnotationDocApi 以 vi.fn 替换；可控时钟。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    putAnnotationDocApi: vi.fn(),
    fetchAnnotationViewApi: vi.fn(),
    postAnnotationBaseApi: vi.fn(),
    postAnnotationBaseImageApi: vi.fn(),
  };
});

import {
  ApiError,
  fetchAnnotationViewApi,
  postAnnotationBaseApi,
  postAnnotationBaseImageApi,
  putAnnotationDocApi,
  studentAnnotationBasePngUrl,
} from "@/lib/api";
import {
  ANNOTATION_SYNC_BACKOFF_BASE_MS,
  ANNOTATION_SYNC_BACKOFF_MAX_MS,
  ANNOTATION_SYNC_DEBOUNCE_MS,
  ANNOTATION_SYNC_MAX_WAIT_MS,
  bindAnnotationSession,
  flushAnnotationSync,
  resetAnnotationSession,
  resolveAnnotationConflictKeepCloud,
  resolveAnnotationConflictKeepLocalAndUpload,
  retryAnnotationUpload,
} from "./annotation-sync";

const putMock = vi.mocked(putAnnotationDocApi);
const viewMock = vi.mocked(fetchAnnotationViewApi);
const baseMock = vi.mocked(postAnnotationBaseApi);
const baseImageMock = vi.mocked(postAnnotationBaseImageApi);

const SESSION_A: AnnotationSessionRef = {
  origin: "https://a.example",
  studentId: "s-a",
};
const SESSION_B: AnnotationSessionRef = {
  origin: "https://a.example",
  studentId: "s-b",
};
const SCOPE: AnnotationScope = {
  attemptId: "a-0001",
  questionId: "q-0001",
  phase: "scratch",
};

function docWithStrokes(n: number): Parameters<typeof writeAnnotationDoc>[2] {
  return {
    version: 1,
    baseWidth: 1440,
    baseHeight: 900,
    strokes: Array.from({ length: n }, (_, i) => ({
      tool: "pen" as const,
      color: "#1f2328",
      weight: 5.76,
      points: [{ x: i * 10, y: 20, p: 0.5, t: 0 }],
    })),
  };
}

function receiptOf(revision: number): AnnotationReceipt {
  return {
    annotationId: "00000000-0000-4000-8000-000000000001",
    revision,
    hash: "a".repeat(64),
    savedAt: "2026-10-08T00:00:00Z",
  };
}

/** 解上传 body（gzip 魔数判断，兼容 jsdom 无压缩回退的原始 JSON） */
async function bodyDoc(blob: Blob): Promise<{ strokes: unknown[] }> {
  const buf = Buffer.from(await blob.arrayBuffer());
  const raw = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
  return JSON.parse(raw.toString("utf8")) as { strokes: unknown[] };
}

function callOf(i: number) {
  const call = putMock.mock.calls[i];
  if (call === undefined) throw new Error(`put 第 ${i} 次调用不存在`);
  return {
    meta: call[3],
    signal: call[4] as AbortSignal | undefined,
    blob: call[2],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  installAnnotationBackend(memoryAnnotationBackend());
  resetAnnotationSession();
  putMock.mockReset();
  viewMock.mockReset();
  baseMock.mockReset();
  baseImageMock.mockReset();
  bindAnnotationSession(SESSION_A);
});

afterEach(() => {
  resetAnnotationSession();
});

describe("annotation-sync：调度（防抖与最大等待）", () => {
  it("2s 停笔防抖：到点上传一次（baseRevision=0 起步、scratch 不发 phase 字段）", async () => {
    putMock.mockResolvedValue(receiptOf(1));
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(1));
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_DEBOUNCE_MS - 1);
    expect(putMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(putMock.mock.calls.length).toBe(1);
    expect(callOf(0).meta.baseRevision).toBe(0);
    expect(callOf(0).meta.phase).toBeUndefined(); // scratch 缺省不发
    const record = await getAnnotationRecord(SESSION_A, SCOPE);
    expect(record?.pending).toBeNull();
    expect(record?.baseRevision).toBe(1);
  });

  it("correction scope 上送 phase 字段", async () => {
    putMock.mockResolvedValue(receiptOf(1));
    writeAnnotationDoc(
      SESSION_A,
      { ...SCOPE, phase: "correction" },
      docWithStrokes(1),
    );
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(1);
    expect(callOf(0).meta.phase).toBe("correction");
  });

  it("持续书写仍触发最大等待：防抖恒被重置，10s 强制上传最新稿", async () => {
    putMock.mockResolvedValue(receiptOf(1));
    for (let i = 1; i <= 7; i++) {
      writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(i));
      await vi.advanceTimersByTimeAsync(1500);
    }
    expect(putMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const body = await bodyDoc(callOf(0).blob);
    expect(body.strokes).toHaveLength(7); // 最新稿
  });
});

describe("annotation-sync：退避与幂等重试", () => {
  it("网络失败退避重试：同 mutationId 同正文重放；成功后清 pending", async () => {
    putMock
      .mockRejectedValueOnce(new Error("连不上服务器"))
      .mockResolvedValueOnce(receiptOf(1));
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(1));
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_BACKOFF_BASE_MS);
    expect(putMock.mock.calls.length).toBe(2);
    expect(callOf(0).meta.mutationId).toBe(callOf(1).meta.mutationId); // 幂等键不换
    const record = await getAnnotationRecord(SESSION_A, SCOPE);
    expect(record?.pending).toBeNull();
  });

  it("连续失败指数退避：1s→2s 不提前重放", async () => {
    putMock.mockRejectedValue(new Error("网络故障"));
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(1));
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_BACKOFF_BASE_MS - 1);
    expect(putMock.mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(putMock.mock.calls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_BACKOFF_BASE_MS);
    expect(putMock.mock.calls.length).toBe(2); // 第二次退避是 2s
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_BACKOFF_BASE_MS);
    expect(putMock.mock.calls.length).toBe(3);
  });
});

describe("annotation-sync：终态与冲突", () => {
  it("409 SEALED（交卷后迟到写）：denied(access) 粘住，不再重试", async () => {
    putMock.mockRejectedValue(
      new ApiError("ANNOTATION_SEALED", "标注已封存", 409),
    );
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(1));
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_BACKOFF_MAX_MS);
    expect(putMock.mock.calls.length).toBe(1); // 终态不重试
    expect(peekAnnotationRecord(SESSION_A, SCOPE)?.denied?.kind).toBe("access");
    expect(peekAnnotationRecord(SESSION_A, SCOPE)?.pending).not.toBeNull(); // 本地保留
  });

  it("413 LIMIT_EXCEEDED：denied(content)，新内容（新 pending）复活", async () => {
    putMock.mockRejectedValueOnce(
      new ApiError("ANNOTATION_LIMIT_EXCEEDED", "超预算", 413),
    );
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(1));
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_DEBOUNCE_MS);
    expect(peekAnnotationRecord(SESSION_A, SCOPE)?.denied?.kind).toBe(
      "content",
    );
    putMock.mockResolvedValue(receiptOf(1));
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(2)); // 新内容复活
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(2);
    expect(peekAnnotationRecord(SESSION_A, SCOPE)?.denied).toBeNull();
  });

  it("409 REVISION_CONFLICT（附 _current）：conflict 落地停传；「以本机为准」对齐后重传成功", async () => {
    putMock.mockRejectedValueOnce(
      new ApiError("ANNOTATION_REVISION_CONFLICT", "版本冲突", 409, {
        _current: {
          annotationId: "00000000-0000-4000-8000-000000000001",
          revision: 7,
          hash: "b".repeat(64),
          savedAt: "2026-10-08T03:00:00Z",
        },
      }),
    );
    putMock.mockResolvedValueOnce(receiptOf(8));
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(1));
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(1);
    const record = peekAnnotationRecord(SESSION_A, SCOPE);
    expect(record?.conflict?.current?.revision).toBe(7);
    expect(record?.pending).not.toBeNull();
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_BACKOFF_MAX_MS);
    expect(putMock.mock.calls.length).toBe(1); // 冲突期间不自动重试
    await resolveAnnotationConflictKeepLocalAndUpload(SESSION_A, SCOPE);
    await vi.advanceTimersByTimeAsync(0); // 排干串行队列微任务
    expect(putMock.mock.calls.length).toBe(2);
    expect(callOf(1).meta.baseRevision).toBe(7); // 对齐云端摘要
    expect(callOf(1).meta.mutationId).toBe(callOf(0).meta.mutationId); // 干净 CAS 写同键重放
    expect(peekAnnotationRecord(SESSION_A, SCOPE)?.conflict).toBeNull();
    expect(peekAnnotationRecord(SESSION_A, SCOPE)?.pending).toBeNull();
  });

  it("409 MUTATION_MISMATCH（无摘要）：conflict 落地；「以本机为准」重铸 mutationId 重传", async () => {
    putMock.mockRejectedValueOnce(
      new ApiError("ANNOTATION_MUTATION_MISMATCH", "幂等键已对应不同正文", 409),
    );
    putMock.mockResolvedValueOnce(receiptOf(2));
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(1));
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_DEBOUNCE_MS);
    const record = peekAnnotationRecord(SESSION_A, SCOPE);
    expect(record?.conflict?.current).toBeNull();
    await resolveAnnotationConflictKeepLocalAndUpload(SESSION_A, SCOPE);
    await vi.advanceTimersByTimeAsync(0); // 排干串行队列微任务
    expect(putMock.mock.calls.length).toBe(2);
    expect(callOf(1).meta.mutationId).not.toBe(callOf(0).meta.mutationId); // 重铸
  });

  it("409 ALREADY_READY/STALE：重取视图发现另一设备正文时等待裁决，不自动覆盖", async () => {
    // 服务端已有更新版本（他端写过的正文）——重取视图对齐 baseRevision
    viewMock.mockResolvedValue({
      base: {
        baseId: "11111111-1111-4111-8111-111111111111",
        state: "ready",
        stale: false,
        pixelWidth: 1440,
        pixelHeight: 900,
        downloadUrl:
          "/api/student/attempts/a-0001/annotation-base/b1/image.png",
      },
      maxWidthPx: 1440,
      doc: docWithStrokes(9) as never,
      annotation: {
        annotationId: "00000000-0000-4000-8000-000000000001",
        revision: 3,
        hash: "c".repeat(64),
        savedAt: "2026-10-08T00:00:00Z",
        sealedAt: null,
        strokeCount: 9,
        pointCount: 9,
      },
    });
    putMock
      .mockRejectedValueOnce(
        new ApiError(
          "ANNOTATION_BASE_ALREADY_READY",
          "底图已就绪且永不重生成",
          409,
        ),
      )
      .mockResolvedValueOnce(receiptOf(4));
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(1));
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    // 底图竞争伴随正文分歧：保留本机基线并停止重传。
    await vi.advanceTimersByTimeAsync(0);
    expect(viewMock).toHaveBeenCalledWith("a-0001", "q-0001", "scratch");
    for (let i = 0; i < 10 && putMock.mock.calls.length < 2; i += 1) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(putMock.mock.calls.length).toBe(1);
    const record = await getAnnotationRecord(SESSION_A, SCOPE);
    expect(record?.pending).not.toBeNull();
    expect(record?.conflict?.current?.revision).toBe(3);
  });

  it("denied(access) 手动重试：清终态立即补传；无终态幂等不动作", async () => {
    putMock.mockRejectedValueOnce(
      new ApiError("ALREADY_SUBMITTED", "已交卷", 409),
    );
    putMock.mockResolvedValueOnce(receiptOf(1));
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(1));
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(1);
    await retryAnnotationUpload(SESSION_A, SCOPE);
    await vi.advanceTimersByTimeAsync(0); // 排干串行队列微任务
    expect(putMock.mock.calls.length).toBe(2); // 清除后立即补传
    // 已成功（无终态）再点重试：不动作
    await retryAnnotationUpload(SESSION_A, SCOPE);
    expect(putMock.mock.calls.length).toBe(2);
  });
});

describe("annotation-sync：会话生命周期", () => {
  it("重进补传：bind 扫描本地待传（重装内存后端模拟重载）", async () => {
    putMock.mockResolvedValue(receiptOf(1));
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(1));
    await vi.advanceTimersByTimeAsync(500); // 防抖未到（未上传）
    resetAnnotationSession();
    const backend = memoryAnnotationBackend();
    // 手动把记录写进新后端（模拟已落盘后重载：内存后端不持久）
    const record = peekAnnotationRecord(SESSION_A, SCOPE);
    if (record === null) throw new Error("记录应在");
    await backend.set(
      JSON.stringify([
        "annotation",
        SESSION_A.origin,
        SESSION_A.studentId,
        SCOPE.attemptId,
        SCOPE.questionId,
        SCOPE.phase,
      ]),
      record,
    );
    installAnnotationBackend(backend);
    resetAnnotationStoreForTest();
    bindAnnotationSession(SESSION_A);
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(1); // bind 扫描补传
  });

  it("切账号：旧会话在途请求中止、新会话不读旧键", async () => {
    let rejectPut!: (e: unknown) => void;
    putMock.mockImplementationOnce(
      () =>
        new Promise<AnnotationReceipt>((_, rej) => {
          rejectPut = rej;
        }),
    );
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(1));
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(1);
    bindAnnotationSession(SESSION_B); // 切账号
    const aborted = callOf(0).signal?.aborted;
    expect(aborted).toBe(true);
    rejectPut(
      Object.assign(new Error("The user aborted a request."), {
        name: "AbortError",
      }),
    );
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_BACKOFF_MAX_MS);
    expect(putMock.mock.calls.length).toBe(1); // 旧会话结果不落地不重试
  });
});

describe("annotation-sync：交卷 flush", () => {
  it("flushAnnotationSync 跳过防抖立即上传并等待完成", async () => {
    putMock.mockResolvedValue(receiptOf(1));
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(1));
    await vi.advanceTimersByTimeAsync(100); // 防抖未到
    await flushAnnotationSync("a-0001");
    expect(putMock.mock.calls.length).toBe(1);
    expect(peekAnnotationRecord(SESSION_A, SCOPE)?.pending).toBeNull();
  });
});

// ---------- 批次三（P0-2）：布局冲突死锁出口 ----------

/** 本机布局（600×400 像素域；无兼容证据——续写/上传场景的常见形态） */
const LOCAL_LAYOUT: AnnotationSurfaceLayout = {
  renderVersion: 2,
  questionRevisionId: "44444444-4444-4444-8444-444444444444",
  cssWidth: 300,
  cssHeight: 200,
  pixelRatio: 2,
  styleVersion: 1,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
};
const LOCAL_PNG = new Blob(["local-png"], { type: "image/png" });
const CLOUD_PNG = new Blob(["cloud-png"], { type: "image/png" });
const CLOUD_BASE_ID = "55555555-5555-4555-8555-555555555555";

/** 与本机同核、已补兼容证据的云端布局（重渲染非确定性＝同核不同字节） */
function cloudLayoutSameCore(): AnnotationSurfaceLayout {
  return {
    ...LOCAL_LAYOUT,
    compatibility: {
      version: 1,
      contentSignature: "d".repeat(64),
      blocks: [{ tag: "DIV", x: 0, y: 0, width: 300, height: 200 }],
      fonts: [["sans-serif", "16px", "400", "28px", "normal"]],
      textRects: [],
    },
  };
}

function previewOf(base: AnnotationBaseRef): AnnotationBasePreviewData {
  const layout = base.layout;
  return {
    base,
    baseRenderVersion: 2,
    maxWidthPx: Math.ceil(
      (layout?.cssWidth ?? 300) * (layout?.pixelRatio ?? 2),
    ),
    questionRevisionId: LOCAL_LAYOUT.questionRevisionId,
    questionNo: 1,
    questionMd: "题面",
    mediaSrcs: [],
    graphFigures: [],
    interactionNotes: [],
  };
}

/** 本机底图 + 空稿起步（600×400 坐标域与 LOCAL_LAYOUT 对齐） */
async function createLocalBase(): Promise<void> {
  await writeLocalAnnotationBase(
    SESSION_A,
    SCOPE,
    { png: LOCAL_PNG, layout: LOCAL_LAYOUT },
    { version: 1, baseWidth: 600, baseHeight: 400, strokes: [] },
  );
}

describe("annotation-sync：底图布局冲突死锁出口（批次三 P0-2）", () => {
  it("同核 ready 底图采纳：不再 POST image，重绑云端 baseId 后 PUT 正常", async () => {
    const cloudLayout = cloudLayoutSameCore();
    baseMock.mockResolvedValue(
      previewOf({
        baseId: CLOUD_BASE_ID,
        state: "ready",
        stale: false,
        pixelWidth: 600,
        pixelHeight: 400,
        layout: cloudLayout,
      }),
    );
    putMock.mockResolvedValue(receiptOf(1));
    await createLocalBase();
    await flushAnnotationSync(SCOPE.attemptId);
    expect(baseImageMock).not.toHaveBeenCalled(); // 不再回传 PNG
    expect(putMock).toHaveBeenCalledTimes(1);
    const record = await getAnnotationRecord(SESSION_A, SCOPE);
    expect(record?.base?.state).toBe("ready");
    expect(record?.localBase?.boundBaseId).toBe(CLOUD_BASE_ID);
    expect(record?.localBase?.png).toBe(LOCAL_PNG); // 本机字节保留，绑定换云端
    expect(record?.conflict).toBeNull();
    expect(record?.pending).toBeNull();
  });

  it("不同核 ready 布局维持冲突转换：不 POST image、不 PUT、kind=layout", async () => {
    baseMock.mockResolvedValue(
      previewOf({
        baseId: CLOUD_BASE_ID,
        state: "ready",
        stale: false,
        pixelWidth: 700,
        pixelHeight: 400,
        layout: { ...LOCAL_LAYOUT, cssWidth: 350 },
      }),
    );
    await createLocalBase();
    await flushAnnotationSync(SCOPE.attemptId);
    expect(baseImageMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
    const record = await getAnnotationRecord(SESSION_A, SCOPE);
    expect(record?.conflict?.kind).toBe("layout");
    expect(record?.pending).not.toBeNull();
  });

  it("layout keep-local：置 retained 不重铸、不再自动重传", async () => {
    putMock.mockRejectedValueOnce(
      new ApiError(
        "ANNOTATION_BASE_LAYOUT_CONFLICT",
        "服务器已有另一布局",
        409,
      ),
    );
    putMock.mockResolvedValue(receiptOf(1));
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(1));
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(1);
    const conflicted = peekAnnotationRecord(SESSION_A, SCOPE);
    expect(conflicted?.conflict?.kind).toBe("layout");
    await resolveAnnotationConflictKeepLocalAndUpload(SESSION_A, SCOPE);
    await vi.advanceTimersByTimeAsync(0); // 排干串行队列微任务
    const retained = peekAnnotationRecord(SESSION_A, SCOPE);
    expect(retained?.conflict).toBeNull();
    expect(retained?.retained?.reason).toContain("另一布局");
    expect(retained?.pending?.mutationId).toBe(conflicted?.pending?.mutationId);
    // retained：任何计时器推进都不再自动重传
    await vi.advanceTimersByTimeAsync(
      ANNOTATION_SYNC_MAX_WAIT_MS + ANNOTATION_SYNC_BACKOFF_MAX_MS,
    );
    expect(putMock.mock.calls.length).toBe(1);
  });

  it("retained 态新笔画不排队；「重新尝试同步」清态立即补传一次", async () => {
    putMock.mockRejectedValueOnce(
      new ApiError(
        "ANNOTATION_BASE_LAYOUT_CONFLICT",
        "服务器已有另一布局",
        409,
      ),
    );
    putMock.mockResolvedValueOnce(receiptOf(1));
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(1));
    await vi.advanceTimersByTimeAsync(ANNOTATION_SYNC_DEBOUNCE_MS);
    await resolveAnnotationConflictKeepLocalAndUpload(SESSION_A, SCOPE);
    expect(peekAnnotationRecord(SESSION_A, SCOPE)?.retained).not.toBeNull();
    // retained 态写新笔画：不排队上传
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(2));
    await vi.advanceTimersByTimeAsync(
      ANNOTATION_SYNC_MAX_WAIT_MS + ANNOTATION_SYNC_BACKOFF_MAX_MS,
    );
    expect(putMock.mock.calls.length).toBe(1);
    // 手动重试：清 retained 立即补传（同 mutationId 幂等）
    await retryAnnotationUpload(SESSION_A, SCOPE);
    await vi.advanceTimersByTimeAsync(0);
    expect(putMock.mock.calls.length).toBe(2);
    const record = await getAnnotationRecord(SESSION_A, SCOPE);
    expect(record?.retained).toBeNull();
    expect(record?.pending).toBeNull();
  });

  it("keep-cloud：采用云端正文并下载云端 PNG 重绑本机底图", async () => {
    await createLocalBase();
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(1)); // 本地未同步改动
    await applyAnnotationConflict(
      SESSION_A,
      SCOPE,
      "layout",
      null,
      "服务器已有另一布局",
    );
    const cloudLayout = { ...LOCAL_LAYOUT, cssWidth: 320 };
    viewMock.mockResolvedValue({
      base: {
        baseId: CLOUD_BASE_ID,
        state: "ready",
        stale: false,
        pixelWidth: 640,
        pixelHeight: 400,
        layout: cloudLayout,
      },
      maxWidthPx: 640,
      doc: { version: 1, baseWidth: 640, baseHeight: 400, strokes: [] },
      annotation: {
        annotationId: "00000000-0000-4000-8000-000000000009",
        revision: 4,
        hash: "f".repeat(64),
        savedAt: "2026-10-08T00:00:00Z",
        sealedAt: null,
        strokeCount: 0,
        pointCount: 0,
      },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      blob: async () => CLOUD_PNG,
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await resolveAnnotationConflictKeepCloud(SESSION_A, SCOPE);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchMock).toHaveBeenCalledWith(
      studentAnnotationBasePngUrl(SCOPE.attemptId, CLOUD_BASE_ID),
      expect.anything(),
    );
    const record = await getAnnotationRecord(SESSION_A, SCOPE);
    expect(record?.conflict).toBeNull();
    expect(record?.pending).toBeNull();
    expect(record?.baseRevision).toBe(4);
    expect(record?.doc.strokes).toHaveLength(0); // 云端正文
    expect(record?.localBase?.png).toBe(CLOUD_PNG); // 本机底图替换为云端
    expect(record?.localBase?.layout).toEqual(cloudLayout);
    expect(record?.localBase?.boundBaseId).toBe(CLOUD_BASE_ID);
  });

  it("keep-cloud 底图下载失败：保留冲突态可重试，不半途清态", async () => {
    await createLocalBase();
    writeAnnotationDoc(SESSION_A, SCOPE, docWithStrokes(1));
    await applyAnnotationConflict(
      SESSION_A,
      SCOPE,
      "layout",
      null,
      "服务器已有另一布局",
    );
    viewMock.mockResolvedValue({
      base: {
        baseId: CLOUD_BASE_ID,
        state: "ready",
        stale: false,
        pixelWidth: 640,
        pixelHeight: 400,
        layout: { ...LOCAL_LAYOUT, cssWidth: 320 },
      },
      maxWidthPx: 640,
      doc: { version: 1, baseWidth: 640, baseHeight: 400, strokes: [] },
      annotation: {
        annotationId: "00000000-0000-4000-8000-000000000009",
        revision: 4,
        hash: "f".repeat(64),
        savedAt: "2026-10-08T00:00:00Z",
        sealedAt: null,
        strokeCount: 0,
        pointCount: 0,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("网络中断");
      }),
    );
    try {
      await expect(
        resolveAnnotationConflictKeepCloud(SESSION_A, SCOPE),
      ).rejects.toThrow("云端底图下载失败");
    } finally {
      vi.unstubAllGlobals();
    }
    const record = await getAnnotationRecord(SESSION_A, SCOPE);
    expect(record?.conflict?.kind).toBe("layout");
    expect(record?.pending).not.toBeNull();
    expect(record?.localBase?.png).toBe(LOCAL_PNG); // 本机底图未动
    expect(record?.doc.strokes).toHaveLength(1); // 本地稿未被覆盖
  });
});
