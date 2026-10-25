import { expect, type Page } from "@playwright/test";

/** 对照正常 DOM 的公式截图，避免「PNG 存在但公式为空」也通过测试。 */
export async function expectFormulaInBase(page: Page) {
  const formula = page.locator('[data-slot="question-surface"] .katex').first();
  // PNG 固定为两倍像素；让 DOM 截图也至少两倍采样，避免细分数线因低采样丢失。
  const parent = formula.locator("..");
  const previousStyle = await parent.getAttribute("style");
  await parent.evaluate((element) => {
    const target = element as HTMLElement;
    target.style.transform = `scale(${Math.max(1, 2 / window.devicePixelRatio)})`;
    target.style.transformOrigin = "top left";
  });
  let reference: Buffer;
  try {
    reference = await formula.screenshot();
  } finally {
    await parent.evaluate((element, style) => {
      if (style === null) element.removeAttribute("style");
      else element.setAttribute("style", style);
    }, previousStyle);
  }
  const comparison = await page.evaluate(async (referenceBase64) => {
    const surface = document.querySelector('[data-slot="question-surface"]');
    const math = surface?.querySelector(".katex");
    const image = document.querySelector<HTMLImageElement>(
      'img[alt="题面底图"]',
    );
    if (!surface || !math || !image) throw new Error("公式底图未就绪");
    await image.decode();
    const referenceImage = new Image();
    referenceImage.src = `data:image/png;base64,${referenceBase64}`;
    await referenceImage.decode();
    const rect = surface.getBoundingClientRect();
    const box = math.getBoundingClientRect();
    const ratio = image.naturalWidth / rect.width;
    const count = (source: HTMLImageElement, crop: readonly number[]) => {
      // 浏览器截图向外取整，细公式会多出一行或一列留白；先按实际墨迹裁齐。
      const sample = document.createElement("canvas");
      sample.width = Math.ceil(crop[2] ?? 1);
      sample.height = Math.ceil(crop[3] ?? 1);
      const sampleContext = sample.getContext("2d");
      if (!sampleContext) throw new Error("画布不可用");
      sampleContext.drawImage(
        source,
        crop[0] ?? 0,
        crop[1] ?? 0,
        crop[2] ?? 1,
        crop[3] ?? 1,
        0,
        0,
        sample.width,
        sample.height,
      );
      const pixels = sampleContext.getImageData(
        0,
        0,
        sample.width,
        sample.height,
      ).data;
      let left = sample.width;
      let top = sample.height;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < sample.height; y++) {
        for (let x = 0; x < sample.width; x++) {
          const index = (y * sample.width + x) * 4;
          if ((pixels[index + 3] ?? 0) > 0 && (pixels[index] ?? 255) < 200) {
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
          }
        }
      }
      if (right < left || bottom < top) return [0, 0, 0];
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 32;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("画布不可用");
      context.drawImage(
        sample,
        left,
        top,
        right - left + 1,
        bottom - top + 1,
        0,
        0,
        96,
        32,
      );
      const data = context.getImageData(0, 0, 96, 32).data;
      const buckets = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4) {
        // 按透明度与墨色积分，避免低倍率截图中的抗锯齿灰像素被硬阈值丢弃。
        const darkness =
          ((255 - (data[i] ?? 255)) / 255) * ((data[i + 3] ?? 0) / 255);
        const bucket = Math.floor(((i / 4) % 96) / 32);
        buckets[bucket] = (buckets[bucket] ?? 0) + darkness;
      }
      return buckets;
    };
    return {
      expected: count(referenceImage, [
        0,
        0,
        referenceImage.naturalWidth,
        referenceImage.naturalHeight,
      ]),
      actual: count(image, [
        (box.left - rect.left) * ratio,
        (box.top - rect.top) * ratio,
        box.width * ratio,
        box.height * ratio,
      ]),
    };
  }, reference.toString("base64"));
  for (let i = 0; i < comparison.expected.length; i++) {
    const expected = comparison.expected[i] ?? 0;
    expect(expected).toBeGreaterThan(10);
    expect(comparison.actual[i] ?? 0).toBeGreaterThan(expected * 0.65);
    expect(comparison.actual[i] ?? 0).toBeLessThan(expected * 1.35);
  }
}
