import { expect, test } from "@playwright/test";
import type { ToolAwareSurface } from "../apps/web/src/features/ink/engine/surface";
import type { AnnotationDoc } from "../packages/contract/src/annotation";
import type { InkDoc } from "../packages/contract/src/ink";
import type { InkProfileConfig } from "../packages/contract/src/ink-profile";

type PaperControls = Pick<
  ToolAwareSurface,
  "setTool" | "undo" | "redo" | "destroy"
>;

for (const renderer of ["atrament", "freehand", "annotation"] as const) {
  test(`${renderer} 擦右侧后左侧真实像素保留，正文与撤销重做一致`, {
    tag: ["@annotation"],
  }, async ({ page }) => {
    await page.goto("/dev/ink-feel");
    const result = await page.evaluate(async (renderer) => {
      const engineUrl = "/src/features/ink/engine/index.ts";
      const annotationUrl = "/src/features/annotation/annotation-surface.ts";
      const defaultsUrl = "/src/features/ink/ink-profile-store.ts";
      const { create } = (await import(engineUrl)) as {
        create: (host: HTMLElement) => PaperControls & {
          getData(): InkDoc;
          setProfile(config: InkProfileConfig): void;
        };
      };
      const { createAnnotationSurface } = (await import(annotationUrl)) as {
        createAnnotationSurface: (options: {
          baseWidth: number;
          baseHeight: number;
        }) => PaperControls & {
          mount(host: HTMLElement): void;
          getDoc(): AnnotationDoc;
        };
      };
      const { getInkProfileSelection } = (await import(defaultsUrl)) as {
        getInkProfileSelection: () => { config: InkProfileConfig };
      };
      const host = document.createElement("div");
      host.style.cssText =
        "width:500px;height:250px;position:fixed;top:0;left:0;z-index:9999";
      document.body.append(host);
      const surface =
        renderer === "annotation"
          ? createAnnotationSurface({ baseWidth: 1000, baseHeight: 500 })
          : null;
      surface?.mount(host);
      const engine = surface ? null : create(host);
      if (renderer !== "annotation")
        engine?.setProfile?.({ ...getInkProfileSelection().config, renderer });
      const controls: PaperControls | null = surface ?? engine;
      if (!controls) throw new Error("纸面未创建");
      try {
        const target = host.querySelector<HTMLCanvasElement>(
          "canvas[data-slot=feel-wet],canvas[data-slot=ink-canvas],canvas[data-slot=annotation-canvas]",
        );
        if (!target) throw new Error("输入画布缺失");
        const send = (type: string, x: number, y = 80) => {
          const rect = target.getBoundingClientRect();
          target.dispatchEvent(
            new PointerEvent(type, {
              pointerId: 41,
              pointerType: "pen",
              isPrimary: true,
              button: 0,
              buttons: type === "pointerup" ? 0 : 1,
              pressure: 0.5,
              clientX: rect.left + x,
              clientY: rect.top + y,
            }),
          );
        };
        const draw = (start: number) => {
          send("pointerdown", start);
          for (let x = start + 5; x <= start + 80; x += 5)
            send("pointermove", x);
          send("pointerup", start + 80);
        };
        const pixels = () => {
          const canvas = host.querySelector<HTMLCanvasElement>(
            "canvas[data-slot=feel-dry],canvas[data-slot=ink-canvas],canvas[data-slot=annotation-canvas]",
          );
          if (!canvas) throw new Error("正文画布缺失");
          const context = canvas.getContext("2d");
          if (!context) throw new Error("像素读取失败");
          const scale = canvas.width / 500;
          const count = (x: number) => {
            const data = context.getImageData(
              Math.round(x * scale),
              Math.round(40 * scale),
              Math.round(140 * scale),
              Math.round(80 * scale),
            ).data;
            let ink = 0;
            for (let i = 3; i < data.length; i += 4)
              if ((data[i] ?? 0) > 0) ink++;
            return ink;
          };
          return [count(10), count(340)];
        };
        const count = () => {
          if (surface) return surface.getDoc().strokes.length;
          const doc = engine?.getData();
          if (doc?.engine !== "atrament") throw new Error("笔迹格式错误");
          return doc.data.strokes.length;
        };
        draw(360);
        draw(40);
        controls.setTool({ type: "eraser" });
        send("pointerdown", 400);
        send("pointerup", 400);
        const erased = { pixels: pixels(), count: count() };
        controls.undo();
        const undone = { pixels: pixels(), count: count() };
        controls.redo();
        const redone = { pixels: pixels(), count: count() };
        return { erased, undone, redone };
      } finally {
        controls.destroy();
        host.remove();
      }
    }, renderer);
    expect(result.erased.count).toBe(1);
    expect(result.erased.pixels[0]).toBeGreaterThan(0);
    expect(result.erased.pixels[1]).toBe(0);
    expect(result.undone.count).toBe(2);
    expect(result.undone.pixels[0]).toBeGreaterThan(0);
    expect(result.undone.pixels[1]).toBeGreaterThan(0);
    expect(result.redone.count).toBe(1);
    expect(result.redone.pixels[0]).toBeGreaterThan(0);
    expect(result.redone.pixels[1]).toBe(0);
  });
}

/**
 * 局部橡皮在三种书写面上的真实像素：拖动途中只重画改动的那一块，这里核对它
 * 和抬笔后整张重画出来的画面是同一幅（没有擦不干净的残墨，也没有把旁边的
 * 笔画擦缺一块；只允许边缘抗锯齿量级的差别），并核对正文、撤销与重做。
 */
for (const renderer of ["atrament", "freehand", "annotation"] as const) {
  test(`${renderer} 局部橡皮只擦掉碰到的一段，拖动途中的画面与整张重画一致`, {
    tag: ["@annotation"],
  }, async ({ page }) => {
    await page.goto("/dev/ink-feel");
    const result = await page.evaluate(async (renderer) => {
      const engineUrl = "/src/features/ink/engine/index.ts";
      const annotationUrl = "/src/features/annotation/annotation-surface.ts";
      const defaultsUrl = "/src/features/ink/ink-profile-store.ts";
      const { create } = (await import(engineUrl)) as {
        create: (host: HTMLElement) => PaperControls & {
          getData(): InkDoc;
          setProfile(config: InkProfileConfig): void;
        };
      };
      const { createAnnotationSurface } = (await import(annotationUrl)) as {
        createAnnotationSurface: (options: {
          baseWidth: number;
          baseHeight: number;
        }) => PaperControls & {
          mount(host: HTMLElement): void;
          getDoc(): AnnotationDoc;
        };
      };
      const { getInkProfileSelection } = (await import(defaultsUrl)) as {
        getInkProfileSelection: () => { config: InkProfileConfig };
      };
      const host = document.createElement("div");
      host.style.cssText =
        "width:500px;height:250px;position:fixed;top:0;left:0;z-index:9999";
      document.body.append(host);
      const surface =
        renderer === "annotation"
          ? createAnnotationSurface({ baseWidth: 1000, baseHeight: 500 })
          : null;
      surface?.mount(host);
      const engine = surface ? null : create(host);
      if (renderer !== "annotation")
        engine?.setProfile?.({ ...getInkProfileSelection().config, renderer });
      const controls: PaperControls | null = surface ?? engine;
      if (!controls) throw new Error("纸面未创建");
      try {
        const target = host.querySelector<HTMLCanvasElement>(
          "canvas[data-slot=feel-wet],canvas[data-slot=ink-canvas],canvas[data-slot=annotation-canvas]",
        );
        if (!target) throw new Error("输入画布缺失");
        const send = (type: string, x: number, y: number) => {
          const rect = target.getBoundingClientRect();
          target.dispatchEvent(
            new PointerEvent(type, {
              pointerId: 43,
              pointerType: "pen",
              isPrimary: true,
              button: 0,
              buttons: type === "pointerup" ? 0 : 1,
              pressure: 0.5,
              clientX: rect.left + x,
              clientY: rect.top + y,
            }),
          );
        };
        /** 从 from 到 to 匀速写一笔（每 5px 一个采样） */
        const write = (from: [number, number], to: [number, number]) => {
          const steps = Math.ceil(
            Math.hypot(to[0] - from[0], to[1] - from[1]) / 5,
          );
          send("pointerdown", from[0], from[1]);
          for (let i = 1; i <= steps; i++) {
            send(
              "pointermove",
              from[0] + ((to[0] - from[0]) * i) / steps,
              from[1] + ((to[1] - from[1]) * i) / steps,
            );
          }
          send("pointerup", to[0], to[1]);
        };
        const inkCanvas = () => {
          const canvas = host.querySelector<HTMLCanvasElement>(
            "canvas[data-slot=feel-dry],canvas[data-slot=ink-canvas],canvas[data-slot=annotation-canvas]",
          );
          if (!canvas) throw new Error("正文画布缺失");
          return canvas;
        };
        /** 以 (x, y) 为中心、边长 6 CSS px 的方块里有墨的像素数 */
        const inkAt = (x: number, y: number) => {
          const canvas = inkCanvas();
          const context = canvas.getContext("2d");
          if (!context) throw new Error("像素读取失败");
          const scale = canvas.width / 500;
          const data = context.getImageData(
            Math.round((x - 3) * scale),
            Math.round((y - 3) * scale),
            Math.round(6 * scale),
            Math.round(6 * scale),
          ).data;
          let ink = 0;
          for (let i = 3; i < data.length; i += 4)
            if ((data[i] ?? 0) > 0) ink++;
          return ink;
        };
        const pixels = () => {
          const canvas = inkCanvas();
          const context = canvas.getContext("2d");
          if (!context) throw new Error("像素读取失败");
          return context.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        /** 两幅画面逐像素比，差得最多的那个通道差多少（颜色先乘上透明度再比） */
        const worstDelta = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
          let worst = 0;
          for (let i = 0; i < a.length; i += 4) {
            const alphaA = a[i + 3] ?? 0;
            const alphaB = b[i + 3] ?? 0;
            worst = Math.max(worst, Math.abs(alphaA - alphaB));
            for (let channel = 0; channel < 3; channel++) {
              const colorA = ((a[i + channel] ?? 0) * alphaA) / 255;
              const colorB = ((b[i + channel] ?? 0) * alphaB) / 255;
              worst = Math.max(worst, Math.abs(colorA - colorB));
            }
          }
          return Math.round(worst);
        };
        const read = () => ({
          picture: inkCanvas().toDataURL(),
          strokes: surface
            ? surface.getDoc().strokes.length
            : (() => {
                const doc = engine?.getData();
                if (doc?.engine !== "atrament") throw new Error("笔迹格式错误");
                return doc.data.strokes.length;
              })(),
          // 橡皮划过的地方、横线的左右两头、红线的上下两头
          hole: inkAt(250, 80),
          lineLeft: inkAt(100, 80),
          lineRight: inkAt(400, 80),
          crossTop: inkAt(201, 45),
          crossBottom: inkAt(299, 115),
        });
        const ring = () => {
          const node = host.querySelector<SVGElement>(
            "circle[data-slot=ink-eraser-ring]",
          );
          return node !== null && node.style.display !== "none";
        };

        // 一条长横线、一条斜穿过它的红色粗线、一道压着横线的荧光笔
        controls.setTool({ type: "pen", color: "black", size: "medium" });
        write([40, 80], [460, 80]);
        controls.setTool({ type: "pen", color: "red", size: "thick" });
        write([180, 30], [320, 130]);
        controls.setTool({
          type: "highlighter",
          color: "green",
          size: "thick",
        });
        write([60, 84], [440, 84]);
        // 撤销再重做：整张按矢量重画一遍，之后的画面都是同一种画法
        controls.undo();
        controls.redo();
        const drawn = read();

        controls.setTool({ type: "eraser", mode: "partial", size: "large" });
        // 橡皮从横线上方划下来，穿过三笔交叠的地方，再往右拖一小段
        send("pointerdown", 250, 50);
        for (const [x, y] of [
          [250, 60],
          [250, 70],
          [250, 80],
          [250, 90],
          [260, 95],
          [275, 95],
        ] as const)
          send("pointermove", x, y);
        const dragging = { ...read(), ring: ring() };
        const draggingPixels = pixels();
        send("pointerup", 275, 95);
        const erased = { ...read(), ring: ring() };
        const dragVsRedraw = worstDelta(draggingPixels, pixels());
        controls.undo();
        const undone = read();
        controls.redo();
        const redone = read();
        return { drawn, dragging, erased, undone, redone, dragVsRedraw };
      } finally {
        controls.destroy();
        host.remove();
      }
    }, renderer);

    expect(result.drawn.strokes).toBe(3);
    expect(result.drawn.hole).toBeGreaterThan(0);

    // 拖动途中：正文还没改，画面已经是擦过的样子，橡皮圈跟着
    expect(result.dragging.strokes).toBe(3);
    expect(result.dragging.ring).toBe(true);
    expect(result.dragging.hole).toBe(0);
    for (const kept of [
      "lineLeft",
      "lineRight",
      "crossTop",
      "crossBottom",
    ] as const)
      expect(result.dragging[kept], kept).toBeGreaterThan(0);

    // 抬笔：三笔各被切成两段，画面整张重画一遍。拖动途中只重画改动的那一块，
    // 两者最多差在跨过重画边界的笔画边缘的抗锯齿上（浏览器对带裁剪的路径取样
    // 不同，Chromium 实测 ≤ 43）；多留或少画一笔会差出一整层墨（荧光笔 115、
    // 笔 255），远超这个量级
    expect(result.erased.strokes).toBe(6);
    expect(result.erased.ring).toBe(false);
    expect(result.erased.hole).toBe(0);
    expect(result.dragVsRedraw).toBeLessThanOrEqual(64);

    // 撤销回到擦之前，重做回到擦之后：都是整张重画，逐像素还原
    expect(result.undone.strokes).toBe(3);
    expect(result.undone.picture === result.drawn.picture).toBe(true);
    expect(result.redone.strokes).toBe(6);
    expect(result.redone.picture === result.erased.picture).toBe(true);
  });
}
