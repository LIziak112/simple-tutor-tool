import { expect, test } from "@playwright/test";
import type { InkDoc } from "../packages/contract/src/ink";
import type { InkProfileConfig } from "../packages/contract/src/ink-profile";

for (const renderer of ["atrament", "freehand"] as const) {
  for (const interrupt of ["pointercancel", "blur"] as const) {
    test(`${renderer} ${interrupt} 保留真实采样、切换配置保留历史`, async ({
      page,
    }) => {
      await page.goto("/dev/ink-feel");
      const result = await page.evaluate(
        async ({ renderer, interrupt }) => {
          const moduleUrl = "/src/features/ink/engine/index.ts";
          const defaultsUrl = "/src/features/ink/ink-profile-store.ts";
          const { create } = (await import(moduleUrl)) as {
            create: (host: HTMLElement) => {
              setProfile?: (config: InkProfileConfig) => void;
              getData: () => InkDoc;
              undo: () => void;
              redo: () => void;
              canRedo: () => boolean;
              exportPng: () => Promise<Blob>;
              destroy: () => void;
            };
          };
          const { getInkProfileSelection } = (await import(defaultsUrl)) as {
            getInkProfileSelection: () => { config: InkProfileConfig };
          };
          const host = document.createElement("div");
          host.style.cssText = "width:300px;height:200px;position:relative";
          document.body.append(host);
          const engine = create(host);
          const config = getInkProfileSelection().config;
          engine.setProfile?.({ ...config, renderer });
          const canvas = host.querySelector(
            "canvas[data-slot=feel-wet],canvas[data-slot=ink-canvas]",
          );
          if (!(canvas instanceof HTMLCanvasElement))
            throw new Error("画布未找到");
          const rect = canvas.getBoundingClientRect();
          const send = (type: string, x: number) =>
            canvas.dispatchEvent(
              new PointerEvent(type, {
                pointerId: 41,
                pointerType: "pen",
                isPrimary: true,
                button: 0,
                buttons: type === "pointerup" ? 0 : 1,
                pressure: 0.5,
                clientX: rect.left + x,
                clientY: rect.top + 60,
              }),
            );
          send("pointerdown", 30);
          send("pointermove", 38);
          send("pointermove", 46);
          if (interrupt === "blur") window.dispatchEvent(new Event("blur"));
          else send("pointercancel", 900);
          send("pointermove", 200);
          send("pointerup", 200);
          const before = engine.getData();
          engine.setProfile?.({
            ...config,
            renderer: renderer === "atrament" ? "freehand" : "atrament",
          });
          const after = engine.getData();
          engine.undo();
          const empty = engine.getData();
          const redo = engine.canRedo();
          engine.redo();
          const restored = engine.getData();
          const png = await engine.exportPng();
          engine.destroy();
          host.remove();
          return { before, after, empty, redo, restored, pngBytes: png.size };
        },
        { renderer, interrupt },
      );
      expect(result.after).toEqual(result.before);
      expect(result.restored.data).toEqual(result.before.data);
      expect(result.redo).toBe(true);
      expect(result.pngBytes).toBeGreaterThan(0);
      if (
        result.before.engine !== "atrament" ||
        result.empty.engine !== "atrament"
      )
        throw new Error("笔迹格式错误");
      expect(result.before.data.strokes).toHaveLength(1);
      expect(result.before.data.strokes[0]?.points).toHaveLength(3);
      expect(result.before.data.strokes[0]?.rendering?.renderer).toBe(renderer);
      expect(result.empty.data.strokes).toHaveLength(0);
    });
  }
}
