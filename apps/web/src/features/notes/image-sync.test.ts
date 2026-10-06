import type { NoteDoc, NoteImageMeta } from "@tutor/contract";
import { noteDocSchema } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 图片任务调度与补图恢复测试（T6R.6）：
 * - 串行：全局同时最多一份编码/上传在途（方案 §7「图片派生队列最多同时
 *   编码一份」），第二个作业必须等第一个完成（成功或失败）才开跑；
 * - 失败不吞、不毒化队列：上传/渲染错误原样上抛并记入队列状态，后续作业
 *   照常执行；重试 = 整链重入（服务端槽位幂等 upsert，安全）；
 * - 脱离 React 生命周期：队列为模块级单例，入队后组件卸载（无人 await）
 *   作业照常完成；
 * - 恢复入口 recoverNoteImages：拉正文 → noteDocSchema 收窄（缺省物化）→
 *   同步；非法正文明确报错不静默。
 * renderNotePage 以 vi.mock 替换（真 canvas 路径在 render-note.test 与 E2E
 * 覆盖）；纯几何计划函数保留真实实现（断言上传槽位与计划一致）。
 */

vi.mock("@/lib/api", () => ({
  postNoteImageApi: vi.fn(),
  fetchStudentNoteDocumentApi: vi.fn(),
  fetchTeacherNoteDocumentApi: vi.fn(),
}));

vi.mock("@/features/notes/render-note.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/notes/render-note.ts")>();
  return {
    ...actual,
    renderNotePage: vi.fn(
      async (_doc: NoteDoc, page: NotePagePlan): Promise<RenderedNotePage> => ({
        ...page,
        blob: new Blob([new Uint8Array([1])]),
      }),
    ),
  };
});

import {
  noteImageQueueStats,
  recoverNoteImages,
  resetNoteImageQueueForTest,
  syncNoteImages,
} from "@/features/notes/image-sync.ts";
import type {
  NotePagePlan,
  RenderedNotePage,
} from "@/features/notes/render-note.ts";
import { renderNotePage } from "@/features/notes/render-note.ts";
import {
  fetchStudentNoteDocumentApi,
  fetchTeacherNoteDocumentApi,
  postNoteImageApi,
} from "@/lib/api";

const VERSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0003";

/** 一笔直线的合法文档（物化默认：高 800 / grid 背景；分析图恰单页） */
function sampleDoc() {
  return noteDocSchema.parse({
    version: 1,
    ink: {
      width: 1000,
      strokes: [
        {
          tool: "pen",
          color: "#1f2328",
          weight: 4,
          points: [
            { x: 100, y: 500, p: 0.5, t: 0 },
            { x: 900, y: 600, p: 0.5, t: 40 },
          ],
        },
      ],
    },
  });
}

function receiptOf(spec: string, pageIndex: number): NoteImageMeta {
  return {
    imageId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb000${spec === "thumbnail" ? 0 : pageIndex + 1}`,
    noteVersionId: VERSION_ID,
    spec: spec as NoteImageMeta["spec"],
    pageIndex,
    crop: { x: 0, y: 0, width: 1000, height: 800 },
    pixelWidth: 480,
    pixelHeight: 384,
    state: "ready",
    hash: "c".repeat(64),
  };
}

const mockedPost = vi.mocked(postNoteImageApi);
const mockedRender = vi.mocked(renderNotePage);
const mockedStudentDoc = vi.mocked(fetchStudentNoteDocumentApi);
const mockedTeacherDoc = vi.mocked(fetchTeacherNoteDocumentApi);

beforeEach(() => {
  resetNoteImageQueueForTest();
  mockedPost.mockReset();
  mockedRender.mockReset().mockImplementation(
    async (_doc: NoteDoc, page: NotePagePlan): Promise<RenderedNotePage> => ({
      ...page,
      blob: new Blob([new Uint8Array([1])]),
    }),
  );
  mockedStudentDoc.mockReset();
  mockedTeacherDoc.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("syncNoteImages：串行与全套槽位", () => {
  it("按计划上传缩略图 + 分析切片，槽位字段与计划一致且顺序正确", async () => {
    // 长稿：笔迹从纸顶延伸到纸底 → 分析裁剪区 [0,3000] → 3 页 + 缩略图 1 页
    const doc = noteDocSchema.parse({
      version: 1,
      ink: {
        width: 1000,
        strokes: [
          {
            tool: "pen",
            color: "#1f2328",
            weight: 4,
            points: [
              { x: 100, y: 60, p: 0.5, t: 0 },
              { x: 500, y: 1500, p: 0.5, t: 40 },
              { x: 900, y: 2950, p: 0.5, t: 80 },
            ],
          },
        ],
      },
      paperHeightLogical: 3000,
    });
    mockedPost.mockImplementation(async (_role, _vid, _png, meta) =>
      receiptOf(meta.spec, meta.pageIndex),
    );
    const metas = await syncNoteImages({
      role: "student",
      versionId: VERSION_ID,
      doc,
    });
    // 1 缩略图 + 3 分析页，顺序：thumbnail 先、analysis 按 pageIndex
    expect(metas.map((m) => [m.spec, m.pageIndex])).toEqual([
      ["thumbnail", 0],
      ["analysis", 0],
      ["analysis", 1],
      ["analysis", 2],
    ]);
    // 上传 meta 与渲染计划对齐（crop/pixel 尺寸来自渲染产物）
    const calls = mockedPost.mock.calls;
    expect(calls.length).toBe(4);
    expect(calls[0]?.[3]?.pixelWidth).toBe(480);
    expect(calls[1]?.[3]?.spec).toBe("analysis");
    expect(calls[1]?.[3]?.pixelWidth).toBe(1000);
    expect(calls[1]?.[3]?.crop.height).toBe(1400);
    expect(calls[2]?.[3]?.crop.y).toBe(1360);
    expect(calls[3]?.[3]?.crop.height).toBe(280);
  });

  it("串行：第一个作业在途时第二个不开跑；完成后按序执行", async () => {
    const doc = sampleDoc();
    const order: string[] = [];
    // 对象包裹绕开 TS 控制流收窄（闭包内赋值对 let 收窄不可见）
    const gate: { release: (() => void) | null } = { release: null };
    mockedPost.mockImplementation(async () => {
      order.push(`upload-${mockedPost.mock.calls.length}`);
      if (mockedPost.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      }
      return receiptOf("thumbnail", 0);
    });
    const first = syncNoteImages({
      role: "student",
      versionId: VERSION_ID,
      doc,
    });
    const second = syncNoteImages({
      role: "teacher",
      versionId: VERSION_ID,
      doc,
    });
    // 等到第一个作业的首个上传真正挂起
    await vi.waitFor(() => expect(gate.release).not.toBeNull());
    // 第二个作业未开始渲染（队列串行：同时最多一份在途）
    expect(mockedRender.mock.calls.length).toBe(1);
    gate.release?.();
    await Promise.all([first, second]);
    // 两个作业各 2 页（缩略图 + 单页分析图）：渲染/上传各 4 次
    expect(mockedRender.mock.calls.length).toBe(4);
    expect(order.length).toBe(4);
    // 第二个作业的上传全部在第一个之后
    expect(order.at(-1)).toBe("upload-4");
  });
});

describe("syncNoteImages：失败不吞错、不毒化、可重试", () => {
  it("上传失败 → 原样上抛并记入队列状态；后续作业不受影响", async () => {
    const doc = sampleDoc();
    const boom = new Error("413 限额");
    mockedPost
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce(receiptOf("thumbnail", 0));
    const failed = syncNoteImages({
      role: "student",
      versionId: VERSION_ID,
      doc,
    });
    // 无人 await 也必须不吞错：显式断言同一 promise 的拒绝
    await expect(failed).rejects.toThrow("413 限额");
    expect(noteImageQueueStats().lastError).toContain("413 限额");
    // 队列未被毒化：下一个作业正常完成（sampleDoc = 缩略图 + 单页分析图）
    await expect(
      syncNoteImages({ role: "student", versionId: VERSION_ID, doc }),
    ).resolves.toHaveLength(2);
  });

  it("渲染失败（toBlob null 等）→ 原样上抛", async () => {
    const doc = sampleDoc();
    mockedRender.mockRejectedValueOnce(
      new Error("PNG 编码失败：toBlob 返回空（画布不可用或内存不足）"),
    );
    await expect(
      syncNoteImages({ role: "student", versionId: VERSION_ID, doc }),
    ).rejects.toThrow(/toBlob 返回空/);
  });

  it("失败后重试整链重入成功（幂等 upsert 语义由服务端保证）", async () => {
    const doc = sampleDoc();
    mockedPost.mockRejectedValueOnce(new Error("网络中断"));
    await expect(
      syncNoteImages({ role: "student", versionId: VERSION_ID, doc }),
    ).rejects.toThrow("网络中断");
    mockedPost.mockResolvedValue(receiptOf("thumbnail", 0));
    await expect(
      syncNoteImages({ role: "student", versionId: VERSION_ID, doc }),
    ).resolves.toHaveLength(2);
    // 重试重新上传了全部槽位（首尝试 1 次 + 重试 2 次）
    expect(mockedPost.mock.calls.length).toBe(3);
  });
});

describe("recoverNoteImages：补图恢复入口", () => {
  it("学生：拉正文 → 收窄物化缺省 → 同步上传", async () => {
    // 服务端正文缺 paperHeightLogical/background（旧形状）：parse 物化默认
    mockedStudentDoc.mockResolvedValue({
      version: 1,
      ink: {
        width: 1000,
        strokes: [
          {
            tool: "pen",
            color: "#1f2328",
            weight: 4,
            points: [{ x: 1, y: 1, p: 0.5, t: 0 }],
          },
        ],
      },
    });
    mockedPost.mockImplementation(async (_role, _vid, _png, meta) =>
      receiptOf(meta.spec, meta.pageIndex),
    );
    const metas = await recoverNoteImages({
      role: "student",
      versionId: VERSION_ID,
    });
    // 单点笔迹：分析裁剪区单页 ⇒ 缩略图 + 1 页分析图
    expect(metas.map((m) => m.spec)).toEqual(["thumbnail", "analysis"]);
    // 拉取用的就是学生端读接口
    expect(mockedStudentDoc).toHaveBeenCalledWith(VERSION_ID);
  });

  it("教师：走教师端读接口", async () => {
    mockedTeacherDoc.mockResolvedValue({
      version: 1,
      ink: { width: 1000, strokes: [] },
    });
    mockedPost.mockImplementation(async (_role, _vid, _png, meta) =>
      receiptOf(meta.spec, meta.pageIndex),
    );
    await recoverNoteImages({ role: "teacher", versionId: VERSION_ID });
    expect(mockedTeacherDoc).toHaveBeenCalledWith(VERSION_ID);
  });

  it("正文非法 → 明确中文报错，不静默", async () => {
    mockedStudentDoc.mockResolvedValue({ version: 2, ink: null });
    await expect(
      recoverNoteImages({ role: "student", versionId: VERSION_ID }),
    ).rejects.toThrow(/无法重建/);
  });
});
