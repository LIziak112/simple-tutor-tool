/** 首笔前材料就绪等待上限（同题面 STEP_TIMEOUT_MS 口径） */
const MATERIAL_READY_TIMEOUT_MS = 15_000;

/**
 * 材料表面就绪等待（题面 awaitQuestionSurfaceReady 的材料版，不栅格化）：
 * 字体就绪 + 图片解码/收尾 + 连续 3 帧宽高测量不变，任一阶段超时返回 false。
 * 材料圈画在第一笔之前用它确认排版已经稳定（MaterialAnnotationOverlay）。
 */
export async function awaitMaterialSurfaceReady(
  surface: HTMLElement,
  isCancelled: () => boolean,
): Promise<boolean> {
  const deadline = performance.now() + MATERIAL_READY_TIMEOUT_MS;
  const frames = async () => {
    let previous = "";
    let unchanged = 0;
    while (performance.now() < deadline) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      if (isCancelled()) return false;
      const rect = surface.getBoundingClientRect();
      const signature = `${rect.width}x${rect.height}`;
      if (signature === previous) {
        unchanged += 1;
        if (unchanged >= 3) return true;
      } else {
        unchanged = 0;
        previous = signature;
      }
    }
    return false;
  };
  const body = async () => {
    if (document.fonts) await document.fonts.ready;
    if (isCancelled()) return false;
    const images = [...surface.querySelectorAll("img")];
    await Promise.all(
      images.map(
        (image) =>
          new Promise<void>((resolve) => {
            if (image.complete) {
              if (typeof image.decode === "function") {
                image.decode().then(
                  () => resolve(),
                  () => resolve(),
                );
              } else {
                resolve();
              }
              return;
            }
            image.addEventListener("load", () => resolve(), { once: true });
            image.addEventListener("error", () => resolve(), { once: true });
          }),
      ),
    );
    if (isCancelled()) return false;
    return frames();
  };
  const timeout = new Promise<false>((resolve) => {
    setTimeout(() => resolve(false), MATERIAL_READY_TIMEOUT_MS);
  });
  return Promise.race([body(), timeout]);
}
