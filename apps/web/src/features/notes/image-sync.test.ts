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
 * 逐页遍历骨架 forEachRenderedNotePage 以 vi.mock 替换：用**真实**计划
 * 函数产页计划（槽位/裁剪几何断言仍验真实现），visit 注入假渲染产物
 * （真 canvas 渲染路径在 render-note.test 与 E2E 覆盖；本文件测队列、
 * 上传编排与恢复链路）。
 */

vi.mock("@/lib/api", () => ({
  postNoteImageApi: vi.fn(),
  // T6R.11 起 recoverNoteImages 经角色分派器 fetchNoteDocumentApi 读正文
  fetchNoteDocumentApi: vi.fn(),
}));

vi.mock("@/features/notes/render-note.ts", async (importOriginal) => {
  // forEachRenderedNotePage 的假实现只在 beforeEach 单份注入（复审⑩：
  // 工厂内重复实现是死代码——mockReset 后必然被 beforeEach 覆盖）
  const actual =
    await importOriginal<typeof import("@/features/notes/render-note.ts")>();
  return {
    ...actual,
    forEachRenderedNotePage: vi.fn(),
  };
});

import {
  noteImageQueueStats,
  recoverNoteImages,
  resetNoteImageQueueForTest,
  syncNoteImages,
} from "@/features/notes/image-sync.ts";
import type { RenderedNotePage } from "@/features/notes/render-note.ts";
import { forEachRenderedNotePage } from "@/features/notes/render-note.ts";
import { fetchNoteDocumentApi, postNoteImageApi } from "@/lib/api";
import { SerialTaskQueue } from "@/lib/serial-task-queue.ts";

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
const mockedForEach = vi.mocked(forEachRenderedNotePage);
const mockedDoc = vi.mocked(fetchNoteDocumentApi);

beforeEach(() => {
  resetNoteImageQueueForTest();
  mockedPost.mockReset();
  mockedForEach
    .mockReset()
    .mockImplementation(
      async (
        doc: NoteDoc,
        spec: "thumbnail" | "analysis",
        visit: (page: RenderedNotePage) => Promise<void>,
      ): Promise<void> => {
        const actual = await vi.importActual<
          typeof import("@/features/notes/render-note.ts")
        >("@/features/notes/render-note.ts");
        const pages =
          spec === "thumbnail"
            ? [actual.planThumbnailPage(doc)]
            : actual.planAnalysisPages(doc);
        for (const page of pages) {
          await visit({ ...page, blob: new Blob([new Uint8Array([1])]) });
        }
      },
    );
  mockedDoc.mockReset();
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
    // 第二个作业未开始渲染（队列串行：同时最多一份在途）——第一个作业
    // 的缩略图 forEach 在途（挂在其首个上传上），分析图 forEach 未开跑
    expect(mockedForEach.mock.calls.length).toBe(1);
    gate.release?.();
    await Promise.all([first, second]);
    // 两个作业各 2 次逐页遍历（缩略图 + 单页分析图）：上传 4 次
    expect(mockedForEach.mock.calls.length).toBe(4);
    expect(order.length).toBe(4);
    // 第二个作业的上传全部在第一个之后
    expect(order.at(-1)).toBe("upload-4");
  });
});

describe("SerialTaskQueue：同步抛错不泄漏 active（复审①）", () => {
  it("task() 同步 throw → 拒绝、active 归零、lastError 记录、队列不毒化", async () => {
    const queue = new SerialTaskQueue();
    const boom = new Error("同步炸");
    const task = (): Promise<never> => {
      throw boom;
    };
    await expect(queue.run(task)).rejects.toThrow("同步炸");
    const stats = queue.stats();
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);
    expect(stats.lastError).toContain("同步炸");
    // 不毒化：下一个任务照常执行
    await expect(queue.run(async () => "ok" as const)).resolves.toBe("ok");
    expect(queue.stats().active).toBe(0);
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
    mockedForEach.mockRejectedValueOnce(
      new Error("PNG 编码失败：toBlob 返回空（画布不可用或内存不足）"),
    );
    await expect(
      syncNoteImages({ role: "student", versionId: VERSION_ID, doc }),
    ).rejects.toThrow(/toBlob 返回空/);
  });

  it("真骨架多页中止：分析第 2 页上传失败 → 第 3 页不再渲染/上传；重试补齐（复审⑫）", async () => {
    const actual = await vi.importActual<
      typeof import("@/features/notes/render-note.ts")
    >("@/features/notes/render-note.ts");
    // 真遍历骨架 + 假渲染（jsdom 无 canvas；被测=计划顺序/中止/共享缓存语义）
    let renderedCount = 0;
    mockedForEach.mockImplementation(async (doc, spec, visit, opts) =>
      actual.forEachRenderedNotePage(doc, spec, visit, {
        ...(opts?.boxes ? { boxes: opts.boxes } : {}),
        renderPage: async (_doc2, page) => {
          renderedCount += 1;
          return { ...page, blob: new Blob([new Uint8Array([1])]) };
        },
      }),
    );
    // 长稿：分析图 3 页 + 缩略图 = 4 槽位
    const tall = noteDocSchema.parse({
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
    // 上传：缩略图 ✓ → 分析 p0 ✓ → 分析 p1 ✗（第 3 个上传调用失败）
    mockedPost
      .mockResolvedValueOnce(receiptOf("thumbnail", 0))
      .mockResolvedValueOnce(receiptOf("analysis", 0))
      .mockRejectedValueOnce(new Error("p1 上传失败"));
    await expect(
      syncNoteImages({ role: "student", versionId: VERSION_ID, doc: tall }),
    ).rejects.toThrow("p1 上传失败");
    // 中止：分析 p2 不再渲染/上传（渲染 3 次 = 缩略图 + p0 + p1；上传 3 次）
    expect(renderedCount).toBe(3);
    expect(mockedPost.mock.calls.length).toBe(3);
    // 已传槽位保留、重试整链重入补齐全部 4 槽位（幂等 upsert）
    mockedPost.mockImplementation(async (_role, _vid, _png, meta) =>
      receiptOf(meta.spec, meta.pageIndex),
    );
    const metas = await syncNoteImages({
      role: "student",
      versionId: VERSION_ID,
      doc: tall,
    });
    expect(metas.map((m) => [m.spec, m.pageIndex])).toEqual([
      ["thumbnail", 0],
      ["analysis", 0],
      ["analysis", 1],
      ["analysis", 2],
    ]);
    expect(renderedCount).toBe(7); // 3 + 重试 4
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
    mockedDoc.mockResolvedValue({
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
    expect(mockedDoc).toHaveBeenCalledWith("student", VERSION_ID);
  });

  it("教师：走教师端读接口", async () => {
    mockedDoc.mockResolvedValue({
      version: 1,
      ink: { width: 1000, strokes: [] },
    });
    mockedPost.mockImplementation(async (_role, _vid, _png, meta) =>
      receiptOf(meta.spec, meta.pageIndex),
    );
    await recoverNoteImages({ role: "teacher", versionId: VERSION_ID });
    expect(mockedDoc).toHaveBeenCalledWith("teacher", VERSION_ID);
  });

  it("正文非法 → 明确中文报错，不静默", async () => {
    mockedDoc.mockResolvedValue({ version: 2, ink: null });
    await expect(
      recoverNoteImages({ role: "student", versionId: VERSION_ID }),
    ).rejects.toThrow(/无法重建/);
  });
});
