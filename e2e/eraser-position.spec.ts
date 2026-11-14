import { writeFile } from "node:fs/promises";
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

/**
 * 图形与直线荧光笔在三种书写面上的真实像素：拖动途中只有临时层上的预览、
 * 画布上没有墨；抬笔后落成一笔——直边画到头、拐角处有墨、椭圆首尾接上、
 * 箭翼在箭尖两侧，框里框外是空的；撤销重做（整张重画）画面不变。
 * （与橡皮的用例放在同一个文件：都是在三种书写面上读真实像素。）
 */
for (const renderer of ["atrament", "freehand", "annotation"] as const) {
  test(
    `${renderer} 图形拖动中只出预览，抬笔落成一笔：直边到头、拐角有墨、椭圆闭合`,
    {
      tag: ["@annotation"],
    },
    async ({ page }, testInfo) => {
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
          engine?.setProfile?.({
            ...getInkProfileSelection().config,
            renderer,
          });
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
                pointerId: 47,
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
          const inkCanvas = () => {
            const canvas = host.querySelector<HTMLCanvasElement>(
              "canvas[data-slot=feel-dry],canvas[data-slot=ink-canvas],canvas[data-slot=annotation-canvas]",
            );
            if (!canvas) throw new Error("正文画布缺失");
            return canvas;
          };
          /** 以 (x, y) 为中心、边长 size CSS px 的方块里最浓的不透明度 */
          const inkAt = (x: number, y: number, size = 4) => {
            const canvas = inkCanvas();
            const context = canvas.getContext("2d");
            if (!context) throw new Error("像素读取失败");
            const scale = canvas.width / 500;
            const data = context.getImageData(
              Math.round((x - size / 2) * scale),
              Math.round((y - size / 2) * scale),
              Math.max(1, Math.round(size * scale)),
              Math.max(1, Math.round(size * scale)),
            ).data;
            let alpha = 0;
            for (let i = 3; i < data.length; i += 4)
              alpha = Math.max(alpha, data[i] ?? 0);
            return alpha;
          };
          /** 整张画布上有墨的像素数 */
          const inkTotal = () => {
            const canvas = inkCanvas();
            const data =
              canvas
                .getContext("2d")
                ?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
            let ink = 0;
            for (let i = 3; i < data.length; i += 4)
              if ((data[i] ?? 0) > 0) ink++;
            return ink;
          };
          /**
           * 一条水平线从 fromX 到 toX 的粗细有多匀：逐列（位图像素）量竖着
           * 穿过 y 的墨量（不透明度之和 / 255，约等于这一列的线宽），返回
           * 最细和最粗的一列
           */
          const widthsAlong = (fromX: number, toX: number, y: number) => {
            const canvas = inkCanvas();
            const context = canvas.getContext("2d");
            if (!context) throw new Error("像素读取失败");
            const scale = canvas.width / 500;
            const left = Math.round(fromX * scale);
            const top = Math.round((y - 6) * scale);
            const columns = Math.round((toX - fromX) * scale);
            const rows = Math.round(12 * scale);
            const data = context.getImageData(left, top, columns, rows).data;
            let min = Number.POSITIVE_INFINITY;
            let max = 0;
            for (let column = 0; column < columns; column++) {
              let sum = 0;
              for (let row = 0; row < rows; row++)
                sum += data[(row * columns + column) * 4 + 3] ?? 0;
              min = Math.min(min, sum / 255);
              max = Math.max(max, sum / 255);
            }
            return { min, max };
          };
          const strokes = () => {
            if (surface) return surface.getDoc().strokes;
            const doc = engine?.getData();
            if (doc?.engine !== "atrament") throw new Error("笔迹格式错误");
            return doc.data.strokes;
          };
          const preview = () =>
            host
              .querySelector('svg[data-slot="ink-live-layer"] path')
              ?.getAttribute("d") ?? null;
          /** 用当前工具从 from 拖到 to（中途经过一个不在连线上的点） */
          const drag = (from: [number, number], to: [number, number]) => {
            send("pointerdown", from[0], from[1]);
            send("pointermove", (from[0] + to[0]) / 2 + 7, from[1] + 3);
            send("pointermove", to[0], to[1]);
            const during = {
              strokes: strokes().length,
              preview: preview(),
              ink: inkTotal(),
            };
            send("pointerup", to[0], to[1]);
            return during;
          };
          /** 画布叠在白底上导出（存下来人工看图形画得怎么样） */
          const picture = () => {
            const canvas = inkCanvas();
            const out = document.createElement("canvas");
            out.width = canvas.width;
            out.height = canvas.height;
            const context = out.getContext("2d");
            if (!context) throw new Error("导出失败");
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, out.width, out.height);
            context.drawImage(canvas, 0, 0);
            return out.toDataURL("image/png");
          };

          // 矩形：(60,40) → (220,120)
          controls.setTool({
            type: "shape",
            shape: "rect",
            color: "black",
            size: "medium",
          });
          const rectDrag = drag([60, 40], [220, 120]);
          const rect = {
            strokes: strokes().length,
            preview: preview(),
            points: strokes()[0]?.points.length ?? 0,
            tool: strokes()[0]?.tool,
            edges: [
              inkAt(140, 40),
              inkAt(220, 80),
              inkAt(140, 120),
              inkAt(60, 80),
            ],
            // 四个角：以顶点为中心、2px 见方里就要有墨（角没有被抹圆、切掉）
            corners: [
              inkAt(60, 40, 2),
              inkAt(220, 40, 2),
              inkAt(220, 120, 2),
              inkAt(60, 120, 2),
            ],
            inside: inkAt(140, 80, 40),
            outside: inkAt(140, 20, 10),
            // 上边（离两个角各 20px 以上的一段）各处一样粗
            topWidths: widthsAlong(80, 200, 40),
          };

          // 椭圆：框 (280,40) → (460,120)，圆心 (370,80)，半轴 90 × 40
          controls.setTool({
            type: "shape",
            shape: "ellipse",
            color: "blue",
            size: "medium",
          });
          drag([280, 40], [460, 120]);
          const ellipse = {
            strokes: strokes().length,
            // 起止点在最左端：上下两侧都接上了才算闭合
            around: [
              inkAt(280, 80),
              inkAt(281, 74, 3),
              inkAt(281, 86, 3),
              inkAt(370, 40),
              inkAt(460, 80),
              inkAt(370, 120),
            ],
            inside: inkAt(370, 80, 40),
            // 框的四个角上没有墨（画的是椭圆，不是矩形）
            boxCorners: [inkAt(284, 44, 4), inkAt(456, 116, 4)],
          };

          // 直线：差 3px 就水平，吸附成水平线 y=160，x 从 60 到 220
          controls.setTool({
            type: "shape",
            shape: "line",
            color: "red",
            size: "thick",
          });
          drag([60, 160], [220, 163]);
          const line = {
            strokes: strokes().length,
            ends: [inkAt(60, 160, 2), inkAt(220, 160, 2)],
            middle: inkAt(140, 160, 2),
            // 吸附后原来的落点下方没有墨；线不越过终点太多
            below: inkAt(220, 166, 2),
            beyond: inkAt(232, 160, 4),
            widths: widthsAlong(80, 200, 160),
          };

          // 箭头：(280,160) → (440,160)，箭翼长 12 CSS px、与杆成 28°
          controls.setTool({
            type: "shape",
            shape: "arrow",
            color: "green",
            size: "medium",
          });
          drag([280, 160], [440, 160]);
          const arrow = {
            strokes: strokes().length,
            shaft: [inkAt(280, 160, 2), inkAt(360, 160, 2), inkAt(440, 160, 2)],
            wings: [inkAt(431, 155.5, 3), inkAt(431, 164.5, 3)],
            beyond: inkAt(452, 160, 4),
            // 箭翼只在箭尖附近：杆的中段上下是空的
            clear: [inkAt(360, 152, 4), inkAt(360, 168, 4)],
            shaftWidths: widthsAlong(300, 420, 160),
          };

          // 直线荧光笔：(60,210) → (440,213)，吸附成水平
          controls.setTool({
            type: "highlighter",
            color: "yellow",
            size: "medium",
            straight: true,
          });
          const markerDrag = drag([60, 210], [440, 213]);
          const marker = {
            strokes: strokes().length,
            points: strokes().at(-1)?.points.length ?? 0,
            tool: strokes().at(-1)?.tool,
            // 沿线各处是同一层透明度（0.45 × 255 ≈ 115）
            along: [
              inkAt(64, 210, 1),
              inkAt(150, 210, 1),
              inkAt(250, 210, 1),
              inkAt(350, 210, 1),
              inkAt(436, 210, 1),
            ],
            beyond: inkAt(456, 210, 4),
          };

          const drawn = inkCanvas().toDataURL();
          const image = picture();
          controls.undo();
          const undone = { strokes: strokes().length, marker: inkAt(250, 210) };
          controls.redo();
          const redone = {
            strokes: strokes().length,
            same: inkCanvas().toDataURL() === drawn,
          };
          return {
            rectDrag,
            rect,
            ellipse,
            line,
            arrow,
            markerDrag,
            marker,
            undone,
            redone,
            image,
            // 一个 CSS 像素合多少位图像素
            scale: inkCanvas().width / 500,
          };
        } finally {
          controls.destroy();
          host.remove();
        }
      }, renderer);
      // 存一张图（白底），人工看图形画得怎么样
      const shot = testInfo.outputPath(`shapes-${renderer}.png`);
      await writeFile(
        shot,
        Buffer.from(result.image.split(",")[1] ?? "", "base64"),
      );
      await testInfo.attach(`shapes-${renderer}.png`, {
        path: shot,
        contentType: "image/png",
      });

      // 拖动途中：正文没有这一笔，画布上没有墨，临时层上是五个顶点的折线
      expect(result.rectDrag.strokes).toBe(0);
      expect(result.rectDrag.ink).toBe(0);
      expect(result.rectDrag.preview).toMatch(
        /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+){4}$/,
      );
      // 抬笔：一笔普通的笔，预览收起
      expect(result.rect.strokes).toBe(1);
      expect(result.rect.tool).toBe("pen");
      expect(result.rect.preview).toBeNull();
      expect(result.rect.points).toBeGreaterThan(200);
      for (const [index, alpha] of result.rect.edges.entries())
        expect(alpha, `矩形第 ${index + 1} 条边`).toBeGreaterThan(200);
      for (const [index, alpha] of result.rect.corners.entries())
        expect(alpha, `矩形第 ${index + 1} 个角`).toBeGreaterThan(100);
      expect(result.rect.inside).toBe(0);
      expect(result.rect.outside).toBe(0);
      // 直边各处一样粗：逐列量线宽，最粗和最细差不到 0.1 个位图像素。
      // （图形的点若按「没有压感」画，atrament 的线宽会逐段来回跳，这里
      // 差到 0.17–0.34。）中号线 2 CSS px、粗线 3 CSS px
      const scale = result.scale;
      for (const [name, widths, cssWidth] of [
        ["矩形上边", result.rect.topWidths, 2],
        ["直线", result.line.widths, 3],
        ["箭头的杆", result.arrow.shaftWidths, 2],
      ] as const) {
        expect(widths.max - widths.min, `${name}粗细不匀`).toBeLessThan(0.1);
        expect(Math.abs(widths.max / scale - cssWidth), name).toBeLessThan(0.2);
      }

      expect(result.ellipse.strokes).toBe(2);
      for (const [index, alpha] of result.ellipse.around.entries())
        expect(alpha, `椭圆第 ${index + 1} 处`).toBeGreaterThan(100);
      expect(result.ellipse.inside).toBe(0);
      expect(result.ellipse.boxCorners).toEqual([0, 0]);

      expect(result.line.strokes).toBe(3);
      for (const alpha of [...result.line.ends, result.line.middle])
        expect(alpha).toBeGreaterThan(200);
      expect(result.line.below).toBe(0);
      expect(result.line.beyond).toBe(0);

      expect(result.arrow.strokes).toBe(4);
      for (const alpha of [...result.arrow.shaft, ...result.arrow.wings])
        expect(alpha).toBeGreaterThan(100);
      expect(result.arrow.beyond).toBe(0);
      expect(result.arrow.clear).toEqual([0, 0]);

      // 直线荧光笔：拖动中同样不上画布；落成两个点的一笔，沿线透明度均匀
      expect(result.markerDrag.strokes).toBe(4);
      expect(result.markerDrag.preview).toMatch(
        /^M[\d.]+ [\d.]+L[\d.]+ [\d.]+$/,
      );
      expect(result.marker.strokes).toBe(5);
      expect(result.marker.tool).toBe("highlighter");
      expect(result.marker.points).toBe(2);
      for (const alpha of result.marker.along)
        expect(Math.abs(alpha - 115)).toBeLessThanOrEqual(3);
      expect(result.marker.beyond).toBe(0);

      // 撤销拿掉最后一笔；重做回来（整张重画），画面与落笔时逐像素相同
      expect(result.undone.strokes).toBe(4);
      expect(result.undone.marker).toBe(0);
      expect(result.redone.strokes).toBe(5);
      expect(result.redone.same).toBe(true);
    },
  );
}
