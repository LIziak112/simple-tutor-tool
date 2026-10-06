import { expect, test } from "@playwright/test";

/**
 * T6R.7 输入生命周期 E2E（复审⑦）：/dev/ink 的 atrament 画布在真实浏览器
 * canvas 里跑合成指针序列——pointercancel / blur 打断在途笔时**按已收到的
 * 真实采样提交**（点数=已收数、无伪造终点、不粘笔）。jsdom 接线测试
 * （atrament-adapter.test.ts）覆盖同一语义；本用例是真实浏览器事件路径
 * （含 capture、合成事件的默认行为）的自动化闸门。观感项 🧑 留 iPad 真机。
 *
 * 断言口径：读 InkSection 数据面板的「笔画：N」「总点数：N」span（首个
 * atrament 区块）；派发用 page.evaluate 在 canvas 上 dispatchEvent 合成
 * PointerEvent（与 /dev/ink 实验室注入器同一手法）。
 */

/** 在首个 atrament 画布上派发一笔「down + n move + 指定打断事件」的序列 */
async function dispatchInterruptedStroke(
  page: import("@playwright/test").Page,
  interrupt: "pointercancel" | "blur",
  moves: number,
): Promise<void> {
  await page.evaluate(
    ({ interrupt: kind, moves: n }) => {
      const canvas = document.querySelector('canvas[data-slot="ink-canvas"]');
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error("atrament 画布未找到");
      }
      const rect = canvas.getBoundingClientRect();
      const baseX = rect.left + rect.width * 0.3;
      const baseY = rect.top + rect.height * 0.3;
      const evInit = (
        type: string,
        x: number,
        y: number,
      ): PointerEventInit => ({
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 41,
        pointerType: "pen",
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        pressure: 0.5,
        clientX: x,
        clientY: y,
      });
      canvas.dispatchEvent(
        new PointerEvent("pointerdown", evInit("pointerdown", baseX, baseY)),
      );
      for (let i = 1; i <= n; i++) {
        canvas.dispatchEvent(
          new PointerEvent(
            "pointermove",
            evInit("pointermove", baseX + i * 8, baseY),
          ),
        );
      }
      if (kind === "pointercancel") {
        // 自带远端坐标——不得进入笔画（不补造终点）
        canvas.dispatchEvent(
          new PointerEvent(
            "pointercancel",
            evInit("pointercancel", rect.right + 500, rect.bottom + 500),
          ),
        );
      } else {
        window.dispatchEvent(new Event("blur"));
      }
      // 打断后同一手势的后续事件：全部忽略（不粘笔）
      canvas.dispatchEvent(
        new PointerEvent(
          "pointermove",
          evInit("pointermove", baseX + 200, baseY),
        ),
      );
      canvas.dispatchEvent(
        new PointerEvent("pointerup", evInit("pointerup", baseX + 200, baseY)),
      );
    },
    { interrupt, moves },
  );
}

/** 数据面板当前「笔画 / 总点数」（首个 atrament 区块） */
async function readStats(page: import("@playwright/test").Page): Promise<{
  strokes: number;
  points: number;
}> {
  const strokesText = await page
    .locator("span", { hasText: /^笔画：/ })
    .first()
    .textContent();
  const pointsText = await page
    .locator("span", { hasText: /^总点数：/ })
    .first()
    .textContent();
  return {
    strokes: Number(strokesText?.replace("笔画：", "")),
    points: Number(pointsText?.replace("总点数：", "")),
  };
}

test.describe("手写输入生命周期（真实浏览器）", () => {
  for (const interrupt of ["pointercancel", "blur"] as const) {
    test(`合成 ${interrupt} 打断在途笔：按已收采样提交、不粘笔`, async ({
      page,
    }) => {
      await page.goto("/dev/ink");
      const canvas = page.locator("canvas[data-slot=ink-canvas]").first();
      await expect(canvas).toBeVisible();

      // down + 2 move = 已收 3 点（含落笔点）；打断后提交的笔画点数恒为 3
      await dispatchInterruptedStroke(page, interrupt, 2);
      await expect
        .poll(() => readStats(page), { timeout: 5_000 })
        .toEqual({ strokes: 1, points: 3 });
    });
  }
});
