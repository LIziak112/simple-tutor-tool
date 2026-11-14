import { expect, test } from "@playwright/test";
import type { InkDoc, InkStroke } from "../packages/contract/src/ink";

test("自然笔感的点号在正式 PNG、裁剪草稿与回放中均保留", {
  tag: ["@annotation"],
}, async ({ page }) => {
  await page.goto("/dev/ink-feel");
  const pixels = await page.evaluate(async () => {
    const snapshotUrl = "/src/features/ink/render-ink-snapshot.ts";
    const replayUrl = "/src/features/ink/replay/draw.ts";
    const noteUrl = "/src/features/notes/render-note.ts";
    const { renderInkSnapshot } = (await import(snapshotUrl)) as {
      renderInkSnapshot: (doc: InkDoc) => Promise<Blob>;
    };
    const { renderNotePage } = (await import(noteUrl)) as {
      renderNotePage: (
        doc: import("../packages/contract/src/note").NoteDoc,
        page: {
          pageIndex: number;
          crop: { x: number; y: number; width: number; height: number };
          pixelWidth: number;
          pixelHeight: number;
        },
      ) => Promise<{ blob: Blob }>;
    };
    const { createAtramentReplayCanvas } = (await import(replayUrl)) as {
      createAtramentReplayCanvas: (host: HTMLElement) => {
        drawFrame: (strokes: InkStroke[], counts: number[]) => void;
        destroy: () => void;
      };
    };
    const s: InkStroke = {
      tool: "pen",
      color: "#ff0000",
      weight: 8,
      points: [{ x: 100, y: 150, p: 0.5, t: 0 }],
      rendering: {
        renderer: "freehand",
        smoothing: 0.5,
        thinning: 0.6,
        streamline: 0.15,
        sizeScale: 1.5,
        simulatePressure: false,
      },
    };
    const doc: InkDoc = {
      engine: "atrament",
      version: 1,
      updatedAt: 1,
      data: { width: 1000, strokes: [s] },
    };
    const sample = async (blob: Blob, y: number) => {
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("像素解码失败");
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return Array.from(ctx.getImageData(100, y, 1, 1).data);
    };
    const png = await sample(await renderInkSnapshot(doc), 150);
    const crop = await renderNotePage(
      {
        version: 1,
        ink: doc.data,
        background: "white",
        paperHeightLogical: 320,
      },
      {
        pageIndex: 0,
        crop: { x: 0, y: 120, width: 1000, height: 200 },
        pixelWidth: 1000,
        pixelHeight: 200,
      },
    );
    const cropped = await sample(crop.blob, 30);
    const host = document.createElement("div");
    host.style.cssText = "width:1000px;height:320px;position:relative";
    document.body.append(host);
    const replay = createAtramentReplayCanvas(host);
    replay.drawFrame([s], [1]);
    const canvas = host.querySelector("canvas");
    if (!canvas) throw new Error("回放画布缺失");
    const scale = canvas.width / 1000;
    const played = Array.from(
      canvas.getContext("2d")?.getImageData(100 * scale, 150 * scale, 1, 1)
        .data ?? [],
    );
    replay.destroy();
    host.remove();
    return [png, cropped, played];
  });
  for (const pixel of pixels) {
    expect(pixel[0], JSON.stringify(pixels)).toBeGreaterThan(240);
    expect(pixel[1]).toBeLessThan(20);
    expect(pixel[2]).toBeLessThan(20);
    expect(pixel[3]).toBe(255);
  }
});

test("荧光笔一笔之内颜色均匀：自己叠到自己的地方不加深（PNG 与回放画布）", {
  tag: ["@annotation"],
}, async ({ page }) => {
  await page.goto("/dev/ink-feel");
  const samples = await page.evaluate(async () => {
    const replayUrl = "/src/features/ink/replay/draw.ts";
    const noteUrl = "/src/features/notes/render-note.ts";
    const { renderNotePage } = (await import(noteUrl)) as {
      renderNotePage: (
        doc: import("../packages/contract/src/note").NoteDoc,
        page: {
          pageIndex: number;
          crop: { x: number; y: number; width: number; height: number };
          pixelWidth: number;
          pixelHeight: number;
        },
      ) => Promise<{ blob: Blob }>;
    };
    const { createAtramentReplayCanvas } = (await import(replayUrl)) as {
      createAtramentReplayCanvas: (host: HTMLElement) => {
        drawFrame: (strokes: InkStroke[], counts: number[]) => void;
        destroy: () => void;
      };
    };
    // 一笔画成一个回环：路径去程经过 (500,100)，绕一圈后回程再经过一次
    const s: InkStroke = {
      tool: "highlighter",
      color: "rgba(250, 204, 21, 0.45)",
      weight: 16,
      points: [
        { x: 300, y: 60, p: 0.5, t: 0 },
        { x: 700, y: 140, p: 0.9, t: 16 },
        { x: 700, y: 60, p: 0.2, t: 32 },
        { x: 300, y: 140, p: 0.5, t: 48 },
      ],
    };
    /** 叠了两遍的点、只经过一遍的点、空白处 */
    const spots: Array<[number, number]> = [
      [500, 100],
      [400, 80],
      [100, 100],
    ];
    const rendered = await renderNotePage(
      {
        version: 1,
        ink: { width: 1000, strokes: [s] },
        background: "white",
        paperHeightLogical: 200,
      },
      {
        pageIndex: 0,
        crop: { x: 0, y: 0, width: 1000, height: 200 },
        pixelWidth: 1000,
        pixelHeight: 200,
      },
    );
    const bitmap = await createImageBitmap(rendered.blob);
    const decoded = document.createElement("canvas");
    decoded.width = bitmap.width;
    decoded.height = bitmap.height;
    const decodedCtx = decoded.getContext("2d");
    if (!decodedCtx) throw new Error("像素解码失败");
    decodedCtx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const png = spots.map(([x, y]) =>
      Array.from(decodedCtx.getImageData(x, y, 1, 1).data),
    );

    const host = document.createElement("div");
    host.style.cssText = "width:1000px;height:200px;position:relative";
    document.body.append(host);
    const replay = createAtramentReplayCanvas(host);
    replay.drawFrame([s], [s.points.length]);
    const canvas = host.querySelector("canvas");
    const replayCtx = canvas?.getContext("2d");
    if (!canvas || !replayCtx) throw new Error("回放画布缺失");
    const scale = canvas.width / 1000;
    const played = spots.map(([x, y]) =>
      Array.from(replayCtx.getImageData(x * scale, y * scale, 1, 1).data),
    );
    replay.destroy();
    host.remove();
    return { png, played };
  });
  const near = (actual: number[] | undefined, expected: number[]) => {
    expect(actual, JSON.stringify(samples)).toHaveLength(4);
    expected.forEach((value, i) => {
      expect(
        Math.abs((actual?.[i] ?? Number.NaN) - value),
        JSON.stringify(samples),
      ).toBeLessThanOrEqual(4);
    });
  };
  // 白底 PNG：黄 (250,204,21) 以 0.45 盖一遍 = (253,232,150)；盖两遍会是
  // (251,219,92)，逐段描边时接头和回环交叠处就是那个更深的颜色
  near(samples.png[0], [253, 232, 150, 255]);
  near(samples.png[1], [253, 232, 150, 255]);
  near(samples.png[2], [255, 255, 255, 255]);
  // 透明底的回放画布：颜色原样，不透明度 0.45×255≈115；盖两遍会是 178
  near(samples.played[0], [250, 204, 21, 115]);
  near(samples.played[1], [250, 204, 21, 115]);
  expect(samples.played[2]?.[3]).toBe(0);
});

/** 用户页面不再包含验证面板；浏览器直接检查草稿自产 PNG。 */
test("草稿真实像素回归不依赖开发页", { tag: ["@annotation"] }, async ({
  page,
}) => {
  await page.goto("/dev/ink-feel");
  const verdicts = await page.evaluate(async () => {
    const modulePath = "/src/features/ink/lab/note-render-checks.ts";
    const checks = (await import(modulePath)) as {
      runChecks: () => Promise<
        Array<{ id: string; pass: boolean; detail: string }>
      >;
    };
    return checks.runChecks();
  });
  expect(verdicts).toHaveLength(10);
  expect(verdicts.filter((v) => !v.pass)).toEqual([]);
});
