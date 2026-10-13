import { expect, test } from "@playwright/test";
import type { InkDoc, InkStroke } from "../packages/contract/src/ink";

test("自然笔感的点号在正式 PNG、裁剪草稿与回放中均保留", async ({ page }) => {
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

/** 用户页面不再包含验证面板；浏览器直接检查草稿自产 PNG。 */
test("草稿真实像素回归不依赖开发页", async ({ page }) => {
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
