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
